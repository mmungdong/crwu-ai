import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { shellInvoke } from '../platform/shell.ts'
import { runShell } from '../shell/run.ts'
import type { WorldFacts } from '../platform/world.ts'

/**
 * DSH 自带 Python 的**实例级**解析器。
 *
 * 为什么不能再依赖系统 `python3`（用户口径）：技能脚本（`audit_delivery.py`、
 * `kb_tool.py` 等）需要 `openpyxl` 这类包，而员工机器上的 `/usr/bin/python3` 既没有它们、
 * 版本也不受控。DSH 0.1.7 起自带一个 workspace runtime，并把它暴露成工具
 * `load_workspace_dependencies`（返回 `python` / `pythonPackages` / `pythonDistributions`）——
 * 那才是审核脚本的运行时。
 *
 * 三条纪律：
 * 1. **只调一次**：`load_workspace_dependencies` 要求 DSH 解析运行时，结果在一次插件生命周期里
 *    不会变，所以成功结果缓存；失败**不缓存**，下一次显式刷新可以重试（`refresh: true`）；
 * 2. **不硬编码路径**：不写 `/Applications/DeepSeek Harness.app`、不写 `~/.dsh/dsh-runtimes`、
 *    不读 `process.argv` —— 路径只能来自那个工具的真实返回；
 * 3. **不改 PATH**：返回的是绝对路径，由调用方在命令里直接使用（仍然经 `ctx.shell` 执行）。
 */

/** 审核脚本真正需要的包；缺任何一个都算运行时不可用。 */
export const REQUIRED_PYTHON_PACKAGES = ['openpyxl'] as const

/** 顺带记录版本的常见包（缺失不算故障，只用于环境页展示）。 */
export const TRACKED_PYTHON_PACKAGES = [
  'openpyxl', 'python-docx', 'python-pptx', 'Pillow', 'lxml', 'numpy', 'pandas', 'XlsxWriter',
] as const

/** 运行时状态：`ok` 可用；`capability-gap` 拿不到运行时工具；`missing-package` 缺必需包；`failed` 其它失败。 */
export type PythonRuntimeState = 'ok' | 'capability-gap' | 'missing-package' | 'failed'

export interface PythonRuntimeView {
  ok: boolean
  /**
   * **没问到答案**（工具不可用 / 调用抛错 / 超时 / 工具报错）——不等于运行时缺失。
   *
   * 环境自检没有会话 agent，而 `load_workspace_dependencies` 需要 agent 作用域；
   * 这一支由环境模型渲染成非阻塞项，真正的拦阻留在 `audit-start`（那条带审核根 agent）。
   */
  unresolved: boolean
  /**
   * **受限沙箱起不了进程**（不是"运行时缺失"）。
   *
   * 判据是「版本探测像进程启动失败」**且**「控制探测（纯 PowerShell）同样失败」——
   * 2026-09-30 真机就是这么闭合的：`0xC0000142` 下连 pwsh 自己都起不来。
   * 调用方（`audit-start` 的门禁）据此选句子：两者处置完全不同，不许混。
   */
  blockedBySandbox: boolean
  state: PythonRuntimeState
  /** 绝对路径；拿不到时为空串。**不回显**给模型的任何提示词都用它。 */
  path: string
  versionText: string
  /** 包名 → 版本（来自工具返回的 `pythonDistributions`）。 */
  distributions: Record<string, string>
  missingPackages: string[]
  error: string
  /** 来源说明（环境页要明确写「DSH 自带」，不能让人以为是系统 Python）。 */
  source: string
}

export interface PythonRuntimeResolver {
  /**
   * 解析（或读缓存）DSH Python。
   *
   * `agent` 用于把这次工具调用放进调用者的 scope（审核启动传审核根 Agent，
   * 环境自检没有 Agent 时省略），从而走完整 policy pipeline。
   */
  check(options?: { refresh?: boolean; agent?: unknown }): Promise<PythonRuntimeView>
  /** 已缓存的值（测试与诊断用）。 */
  cached(): PythonRuntimeView | null
}

export const PYTHON_RUNTIME_SOURCE = 'DSH 自带运行时（load_workspace_dependencies）'

/** `STATUS_DLL_INIT_FAILED`（0xC0000142）：受限令牌下进程初始化失败的固定指纹。 */
export const DLL_INIT_FAILED = 3221225794

/**
 * 这次失败像不像「进程在能跑起来之前就死了」。
 *
 * ⚠️ 判据不能只看 `denied` / `runnerFailed`：DSH 把 `0xC0000142` 当成一次**普通的非零退出**，
 * 那两个布尔都还是 false。同一个数在无符号视图里是 3221225794、在 int32 里是 -1073741502，两个都认。
 */
export function looksLikeProcessStartFailure(probe: {
  exitCode?: number | null
  sandbox?: { denied?: boolean; runnerFailed?: boolean }
}): boolean {
  if (probe.sandbox?.denied === true || probe.sandbox?.runnerFailed === true) return true
  return probe.exitCode === DLL_INIT_FAILED || probe.exitCode === -1073741502
}

/**
 * 「受限沙箱里进程起不来」时给操作员的结论（**纯函数**，逐条有测试）。
 *
 * 为什么值得为它跑一次控制探测：这两种现场的处置**完全不同**，而它们的表现原来一模一样
 * （都只是"没有版本输出"）：
 *
 * - **控制探测也失败** → 本机的受限沙箱**连 pwsh 自己都起不来**：DSH 的沙箱后端
 *   （ACL restricted-token runner）的问题。这不是「DSH Python 不可用」—— 换运行时、
 *   重装包、改 Python 路径都没用；
 * - **控制探测成功** → pwsh 自己能跑，只有它拉起的 native 子进程在初始化阶段退出：
 *   那层临时文件捕获兼容层在本机还不够（子进程仍在继承不该继承的句柄）。
 */
export function pythonStartFailureReason(
  facts: { exitCode: number | null; requested: string; resolved: string; ran: string; denied: boolean; runnerFailed: boolean },
  control: { ok: boolean; exitCode: number | null; ran: string } | null,
): string {
  const code = facts.exitCode === null ? 'null' : String(facts.exitCode)
  const mode = `请求 ${facts.requested || '执行器默认'} · 实际 ${facts.ran || facts.resolved || '未知'}`
  const controlText = control === null
    ? '控制探测没有跑'
    : (control.ok
      ? `控制探测（纯 PowerShell 命令）**成功**（实际 ${control.ran || '未知'}）`
      : `控制探测（纯 PowerShell 命令）**同样失败**（exitCode ${control.exitCode === null ? 'null' : String(control.exitCode)}）`)
  const verdict = control !== null && control.ok
    ? 'pwsh 自己能跑，只有它拉起的 native 子进程在初始化阶段退出：那层临时文件捕获兼容层在本机还不够，'
      + '（新的构建已把 stdin 也断开，若仍复现就是沙箱 runner 层面的问题）。'
    : '连 pwsh 自己都起不来：这是本机沙箱后端（ACL restricted-token runner）的问题，'
      + '**不是「DSH Python 不可用」**，换运行时 / 重装包都没有用。'
  return `进程在能跑起来之前就退出了（exitCode ${code} = 0xC0000142 STATUS_DLL_INIT_FAILED · ${mode}）。`
    + `${controlText}：${verdict}`
    + '处置：这是**部署侧**的问题（DSH 版本 / 沙箱 runner / ACL 授权），不是插件能绕的 —— '
    + '插件把审核根钉死在 `workspace-write` + `approval: never`（无人值守审核没有审批通道），'
    + '并且在 auto / 完全权限的父会话下**拒绝**发起审核，所以"切完全权限"不是可用退路。'
    + '把上面这行结构化事实交给部署方核对受限沙箱后端即可（DSH 本该报沙箱不可用，而不是把它当普通非零退出）。'
}

interface ToolOutcome {
  isError: boolean
  value?: unknown
  error?: { code?: string; name?: string; message?: string }
}

interface ToolsRuntimeLike {
  execute(input: { callId: unknown; name: string; arguments: unknown; agent?: unknown; signal: AbortSignal }): Promise<ToolOutcome>
}

const RESOLVE_TIMEOUT_MS = 60_000

/** 版本号提取：`python` 的版本字符串形态在各平台一致（`3.12.4`）。 */
export function pythonVersionOf(raw: unknown): string {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text(raw))
  return match === null ? '' : match[1] ?? ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 版本表归一：只保留「包名 → 版本字符串」；嵌套对象/数组/空值一律丢掉（不要 `[object Object]`）。 */
export function distributionsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, version] of Object.entries(asRecord(raw))) {
    if (typeof version !== 'string' && typeof version !== 'number') continue
    const value = text(version)
    if (name !== '' && value !== '') out[name] = value
  }
  return out
}

export function createPythonRuntimeResolver(deps: { ctx: Context; world: WorldFacts }): PythonRuntimeResolver {
  let cache: PythonRuntimeView | null = null

  const failed = (state: PythonRuntimeState, error: string, unresolved = false): PythonRuntimeView => ({
    ok: false, state, unresolved, blockedBySandbox: false,
    path: '', versionText: '', distributions: {}, missingPackages: [], error,
    source: PYTHON_RUNTIME_SOURCE,
  })

  return {
    cached: () => cache,
    async check(options = {}) {
      if (options.refresh !== true && cache !== null) return cache
      const ctx = deps.ctx
      const registry = ctx.get('tools') as ToolsRuntimeLike | undefined
      if (registry === undefined || typeof registry.execute !== 'function') {
        return failed('capability-gap', 'Host tools 服务不可用，无法解析 DSH 自带 Python', true)
      }

      // ① 问 DSH：运行时在哪、装了什么。超时与抛错都要如实区分。
      const controller = new AbortController()
      const timer = ctx.get('timer') as { timeout?: (ms: number) => Promise<void> } | undefined
      const pending = registry.execute({
        callId: `crwu-python-${Date.now().toString(36)}`,
        name: 'load_workspace_dependencies',
        arguments: {},
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        signal: controller.signal,
      }).then(
        (result) => ({ kind: 'settled' as const, result }),
        (error: unknown) => ({ kind: 'threw' as const, error }),
      )
      const raced = timer === undefined || typeof timer.timeout !== 'function'
        ? await pending
        : await Promise.race([pending, timer.timeout(RESOLVE_TIMEOUT_MS).then(() => ({ kind: 'timeout' as const }))])
      if (raced.kind === 'timeout') {
        controller.abort(new Error('解析 DSH Python 超时'))
        return failed('capability-gap', `解析 DSH 自带 Python 超时（${Math.round(RESOLVE_TIMEOUT_MS / 1000)} 秒内没有返回）`, true)
      }
      if (raced.kind === 'threw') {
        return failed('capability-gap', `调用 load_workspace_dependencies 失败：${raced.error instanceof Error ? raced.error.message : String(raced.error)}`, true)
      }
      if (raced.result.isError === true) {
        const info = raced.result.error ?? {}
        // 这一支就是员工实测命中的那种：工具需要 agent 作用域，而自检没有 —— **没问到**，不是缺失。
        return failed('capability-gap', `load_workspace_dependencies 报错（${text(info.code) || text(info.name) || 'unknown'}）：${text(info.message)}`, true)
      }
      const value = asRecord(raced.result.value)
      const python = text(value.python).trim()
      if (python === '') {
        return failed('capability-gap', 'load_workspace_dependencies 没有返回 python 路径：本机的 DSH 自带运行时不可用')
      }

      // ② 路径必须真的是可执行文件：工具返回的字符串本身不是证据。
      const platform = await deps.world.platform()
      const fs = fileSystem(ctx)
      if (fs === undefined) return failed('failed', 'Host 文件服务不可用')
      try {
        const info = await fs.stat(await resolveTarget(ctx, python))
        // 「不存在」与「存在但不是文件」的处置不同：前者通常是运行时没装/路径过期，
        // 后者是拿到了目录或符号链接指向的东西 —— 都报 failed，但话要说准。
        if (info === undefined) return failed('failed', `DSH Python 路径不存在：${python}`)
        if (info.type !== 'file') return failed('failed', `DSH Python 路径不是普通文件：${python}`)
      } catch (error) {
        return failed('failed', `无法访问 DSH Python 路径：${python}（${error instanceof Error ? error.message : String(error)}）`)
      }

      // ③ 跑一次版本探测：既拿到版本，也证明它真的能执行（只读命令，走默认沙箱）。
      const probe = await runShell(ctx, shellInvoke(python, ['-c', 'import sys;print(sys.version.split()[0])'], platform), {
        workdir: await deps.world.workdir(),
        timeoutMs: 30_000,
      })
      const versionText = pythonVersionOf(`${text(probe.stdout)}\n${text(probe.stderr)}`)
      if (!probe.ok || versionText === '') {
        // 失败时把**结构化事实**一起带上：退出码、请求与实际跑在哪个沙箱模式、是否被沙箱拒绝、
        // 执行器本身是否没能起来。只报一句"无法执行"会让 Windows 受限沙箱里的
        // `0xC0000142`（native 子进程继承管道，见 `windowsCaptureCommand`）看起来像"Python 没装"，
        // 而这两件事的处置完全不同（换运行时 vs 换采集方式）。归因只许用 DSH 给的字段，不猜文本。
        const facts = probe.sandbox
        const mode = `${facts.requested || '执行器默认'} → ${facts.ran || facts.resolved || '未知'}`
        const detail = `DSH Python 无法执行：${text(probe.stderr) || text(probe.error) || '没有版本输出'}`
          + `（exitCode ${probe.exitCode === null ? 'null' : String(probe.exitCode)} · 沙箱 ${mode}`
          + `${facts.denied ? ' · 沙箱拒绝' : ''}${facts.runnerFailed ? ' · 执行器未启动' : ''}）`
        // 「进程在跑起来之前就死了」时再问一句"那 pwsh 自己呢"：只有控制探测能把
        // "沙箱后端坏了" 与 "native 子进程的句柄有毛病" 分开（见 `pythonStartFailureReason`）。
        if (!looksLikeProcessStartFailure(probe)) return failed('failed', detail)
        const control = await runShell(ctx, "Write-Output 'crwu-python-probe'", {
          workdir: await deps.world.workdir(),
          timeoutMs: 20_000,
        })
        ctx.logger?.warn?.('crwu-workbench: DSH Python 探测在受限沙箱里起不来 %o', {
          exitCode: probe.exitCode, mode, denied: facts.denied, runnerFailed: facts.runnerFailed,
          controlOk: control.ok, controlExitCode: control.exitCode, controlRan: text(control.sandbox?.ran),
        })
        const reason = pythonStartFailureReason(
          { ...facts, exitCode: probe.exitCode },
          { ok: control.ok, exitCode: control.exitCode, ran: text(control.sandbox?.ran) },
        )
        // 控制探测**也**以同一个启动失败指纹挂掉 ⇒ 沙箱后端起不了任何进程（部署侧问题），
        // 与"运行时缺失 / 缺包"是两件事，必须分开带出去。
        const blockedBySandbox = !control.ok && looksLikeProcessStartFailure(control)
        return { ...failed('failed', `${detail}\n${reason}`), blockedBySandbox }
      }

      const distributions = distributionsOf(value.pythonDistributions)
      const missingPackages = REQUIRED_PYTHON_PACKAGES.filter((name) => text(distributions[name]) === '')
      const view: PythonRuntimeView = {
        ok: missingPackages.length === 0,
        unresolved: false,
        blockedBySandbox: false,
        state: missingPackages.length === 0 ? 'ok' : 'missing-package',
        path: python,
        versionText,
        distributions,
        missingPackages: [...missingPackages],
        error: missingPackages.length === 0
          ? ''
          : `DSH 自带 Python 缺少审核脚本必需的包：${missingPackages.join('、')}（本插件不自动 pip 安装，请让部署方补进 DSH 运行时）`,
        source: PYTHON_RUNTIME_SOURCE,
      }
      // 只缓存成功结果：失败可能来自一次瞬时故障，下一次显式刷新要能重试。
      if (view.ok) cache = view
      return view
    },
  }
}
