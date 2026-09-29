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
    ok: false, state, unresolved, path: '', versionText: '', distributions: {}, missingPackages: [], error,
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
        return failed('failed', `DSH Python 无法执行：${text(probe.stderr) || text(probe.error) || '没有版本输出'}`)
      }

      const distributions = distributionsOf(value.pythonDistributions)
      const missingPackages = REQUIRED_PYTHON_PACKAGES.filter((name) => text(distributions[name]) === '')
      const view: PythonRuntimeView = {
        ok: missingPackages.length === 0,
        unresolved: false,
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
