import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, isFile, resolveTarget } from '../fs/paths.ts'
import { runCrwu, describeFailure } from '../crwu/run.ts'
import { parseSessionOutput, type H3yunSession } from '../h3yun/session.ts'
import { readOssCred, type OssCredView } from '../oss/cred.ts'
import { shellInvoke, clipboardCommand, openExternalCommand } from '../platform/shell.ts'
import { describeLoginAdvice, loginFailureAdvice } from './login-failure.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import { runDws } from '../dws/run.ts'
import { parseDwsDeviceAuthorization, type LoginHandleHolder } from './device-login.ts'
import { defaultCaseRoot } from '../audit/state.ts'
import type { WorkbenchState } from '../state/types.ts'


/**
 * 第 5 层的零碎操作：剪贴板、打开文件、登录、会话查询、凭据查看。
 *
 * 两个安全/正确性要点：
 * 1. **`openPath` 必须做目录包含检查**：只允许打开案例根目录内的文件。
 *    没有这一条，面板就成了「让宿主机用默认程序打开任意路径」的入口。
 * 2. **提权命令必须有工作目录**：`pbcopy` / `open` / `dws auth login` 都要读钥匙串或
 *    系统服务，得在沙箱外跑；而 DSH 拒绝「无工作区的提权执行」，所以每个都显式传 workdir。
 */

export interface SystemDeps {
  ctx: Context
  state: WorkbenchState
  platform: string
  workdir: () => Promise<string>
  /** Broker（协议 18）：剪贴板 / 打开文件 / 登录都是跨边界的本机动作。 */
  access: LocalAccessBroker
  /**
   * loopback 登录的句柄持有者（协议 32）。
   *
   * 有它，员工才能在"登录钉钉迟迟不回来"时**真的把那条命令杀掉**、改用设备流登录；
   * 插件卸载时也靠它收尾（现场留下过三个占着 `~/.dws` 锁的 `dws auth login` 进程）。
   */
  loginHandles?: LoginHandleHolder
}

export interface SimpleResult {
  ok: boolean
  error: string
}

// ── clipboard ───────────────────────────────────────────────────────────────

/**
 * 把文本写进系统剪贴板。
 *
 * 内容通过 **stdin** 传给命令，不作为参数 —— 拼进命令行会被 shell 解释，
 * 提示词里的引号、反引号、`$` 全都会出问题。
 */
export async function clipboard(deps: SystemDeps, args: Record<string, unknown>): Promise<SimpleResult> {
  const content = text(args.text)
  if (content === '') return { ok: false, error: '没有内容' }
  const run = await deps.access.runShell(
    { operation: 'system.clipboard.write', source: 'panel', workdir: await deps.workdir() },
    clipboardCommand(deps.platform),
    { timeoutMs: 20_000, stdinText: content, summary: 'system.clipboard.write' },
  )
  return { ok: run.ok, error: run.ok ? '' : (text(run.stderr) || text(run.error) || '剪贴板命令不可用').slice(0, 200) }
}

// ── open-path ───────────────────────────────────────────────────────────────

export interface OpenPathResult extends SimpleResult {
  path: string
  platform: string
}

/** 用系统默认程序打开案例目录内的文件。 */
export async function openPath(deps: SystemDeps, args: Record<string, unknown>): Promise<OpenPathResult> {
  const path = text(args.path)
  const failed = (error: string): OpenPathResult => ({ ok: false, error, path, platform: deps.platform })
  if (path === '') return failed('缺少路径')

  const fs = fileSystem(deps.ctx)
  if (fs === undefined) return failed('Host 文件服务不可用')

  const root = await defaultCaseRoot(deps.ctx, deps.state, deps.workdir)
  // **案例根未知 = 没有信任域 = 拒绝**，而且必须排在 `resolve` / `stat` **之前**。
  //
  // 旧形态是 `if (root !== '') { …包含检查… }`：案例根拿不到时整段检查被跳过。
  // 那时唯一挡住它的是 Broker 的"提权操作必须有工作目录"（而 `defaultCaseRoot` 的兜底
  // 恰好就是那个 workdir）—— 也就是说边界成立靠的是**两处巧合相等**，不是本函数自己的判据。
  // 一旦以后有人把这条操作改成非提权、或给它一个静态 workdir，那个洞会**静默**打开。
  // 所以这里显式 fail closed，判据落在最前面。
  if (root === '') return failed('还没有选定工作空间：拒绝打开范围未确定的文件')
  try {
    const target = await resolveTarget(deps.ctx, path)
    {
      const rootTarget = await resolveTarget(deps.ctx, root)
      // 没有这一条，面板就是「用默认程序打开任意路径」的入口。
      if (fs.contains(rootTarget, target) !== true) return failed('只允许打开案例根目录内的文件')
    }
    if (!await isFile(deps.ctx, path)) return failed(`目标不是文件：${path}`)
  } catch (error) {
    return failed(`路径解析失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const run = await deps.access.runShell(
    { operation: 'system.case-file.open', source: 'panel', workdir: await deps.workdir() },
    openExternalCommand(path, deps.platform),
    { timeoutMs: 30_000, summary: 'system.case-file.open' },
  )
  return {
    ok: run.ok,
    path,
    platform: deps.platform,
    error: run.ok ? '' : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 300),
  }
}

// ── 登录 ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  ok: boolean
  error: string
  timedOut: boolean
  stdoutTail: string
  stderrTail: string
  /**
   * 这次失败属于「本机访问被挡在工作区之外」（登录**必须**写工作区之外的路径：
   * 临时浏览器 profile / `<HOME>/.dws` 的登录态 / 操作系统凭据存储）。
   *
   * 界面据此把它说成"沙箱挡住了"并给出可执行的下一步，而不是把
   * `mkdir …: Access is denied` 这种原文丢给员工。
   */
  sandboxBlocked: boolean
  /** 员工可执行的下一步；空串 = 没有归因、照原样显示 `error`。 */
  advice: string
}

/**
 * 钉钉登录的结果：在 {@link LoginResult} 之上多两条**只有它需要**的事实。
 *
 * 「授权页由插件打开」是 dws 那条路独有的 —— 氚云走 `crwu`，浏览器由 CLI 自己拉起，
 * 插件插不上手，所以那一条（{@link ReloginResult}）不该被迫回一个恒为 `false` 的 `opened`。
 */
export interface DwsLoginResult extends LoginResult {
  /** 这次登录被员工主动取消（改用设备流登录）——界面据此说"已取消"而不是"失败"。 */
  cancelled: boolean
  /**
   * 这次登录要打开的授权页链接；空串 = 命令还没打印出链接就失败了。
   *
   * 为什么要回传：`open` 退出 0 **不**等于页面真的出现了（见 `openExternalCommand` 的注释），
   * 所以面板要在"没能打开"时把链接摆出来让人自己点/复制 —— 而不是让员工对着一个空窗口猜。
   */
  url: string
  /**
   * 授权页**已经由插件打开**了。
   *
   * 为什么要插件自己开：`dws` 自己那次 `open` 失败是**静默的**（上游 loopback 那条路用的是
   * nil logger，device 那条只记 Debug），员工看到的就是"点了没反应"。插件走
   * `system.browser.open`（与「查看报告」同一条已验证路径）并把结果如实报出来。
   */
  opened: boolean
  /** 打开授权页失败的原因；空串 = 没失败过 / 还没到打开那一步。 */
  openError: string
}

/** 输出可能很长（扫码登录会打印提示），只回尾部给界面。 */
function tails(run: { stdout?: unknown; stderr?: unknown }): { stdoutTail: string; stderrTail: string } {
  return { stdoutTail: text(run.stdout).slice(-600), stderrTail: text(run.stderr).slice(-600) }
}


/** 轮询 dws 输出的间隔 / 总时限；测试注入小值把等待变成确定事件。 */
export const DWS_LOGIN_POLL_MS = 300
export const DWS_LOGIN_LIMIT_MS = 300_000

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

export interface DwsLoginOptions {
  pollMs?: number
  limitMs?: number
}

/**
 * 钉钉登录（`dws auth login`，OAuth loopback）。
 *
 * ## 为什么要**后台**跑，而不是一次前台 `runShell`
 *
 * 授权页必须由**插件**打开，而链接只出现在命令的输出里 —— 前台跑要等命令结束（最长 5 分钟）
 * 才拿得到输出，那时链接早没用了。所以：起后台进程 → 轮询输出 → 一看到链接就打开它 →
 * 继续等命令结束（人在浏览器里完成授权需要时间）。
 *
 * 对外仍然是一次「点一下、等结果」的调用：返回值与从前同一形状，只多了 `opened` / `openError`。
 *
 * ⚠️ `--no-browser`：dws 自己那次打开失败是静默的（nil logger），所以这里明确让它别开，
 * 免得出现"两个窗口"或"看似什么都没发生"。
 */
export async function dwsLogin(
  deps: SystemDeps,
  _args: Record<string, unknown>,
  home: string,
  options: DwsLoginOptions = {},
): Promise<DwsLoginResult> {
  const pollMs = options.pollMs ?? DWS_LOGIN_POLL_MS
  const limitMs = options.limitMs ?? DWS_LOGIN_LIMIT_MS
  // 用**包内绝对路径**：只按名字调用在 Finder 启动的桌面端会 `bash: dws: command not found`，
  // 表现就是「点了钉钉登录没有任何反应」。
  const argv = [await resolveBundledCommand(deps.ctx, deps.platform, 'dws'), 'auth', 'login', '--no-browser']
  const workdir = await deps.workdir()
  const started = await deps.access.startShell(
    { operation: 'dws.auth.login', source: 'panel', workdir },
    shellInvoke(argv[0] ?? '', argv.slice(1), deps.platform),
    { timeoutMs: limitMs, summary: 'dws auth login' },
  )
  if (!started.ok) {
    const advice = loginFailureAdvice('dws', { error: started.error, sandbox: started.sandbox })
    return {
      ok: false,
      error: advice.blocked ? describeLoginAdvice('dws', advice, started.error) : started.error,
      timedOut: false, stdoutTail: '', stderrTail: '',
      sandboxBlocked: advice.blocked, advice: advice.blocked ? advice.action : '',
      opened: false, openError: '', url: '', cancelled: false,
    }
  }

  const handle = started.handle
  const holder = deps.loginHandles
  holder?.set(handle)
  const deadline = Date.now() + limitMs
  let output = ''
  let timedOut = false
  let cancelled = false
  let opened = false
  let openError = ''
  let attemptedUrl = ''
  let authorizationUrl = ''
  try {
  for (;;) {
    // `readOutput()` 是**合并流**（stderr 带标记一起给），所以报错也在这份输出里 ——
    // 归因看得到它，不需要第二个读法。
    const read = handle.read()
    if (read.delta !== '') output += read.delta
    const parsed = parseDwsDeviceAuthorization(output)
    if (parsed.url !== '' && attemptedUrl !== parsed.url) {
      attemptedUrl = parsed.url
      authorizationUrl = parsed.url
      const run = await deps.access.runShell(
        { operation: 'system.browser.open', source: 'panel', workdir },
        // 登录授权页用新实例：别人挂着的无头浏览器会把 URL 吞掉（且 `open` 仍退出 0）。
        openExternalCommand(parsed.url, deps.platform, { newInstance: true }),
        { timeoutMs: 30_000, summary: 'system.browser.open' },
      )
      opened = run.ok
      openError = run.ok ? '' : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 200)
    }
    if (handle.status() !== 'running') break
    // 员工改用设备流登录：句柄持有者已经把命令杀了，这里立刻收尾让出 `~/.dws` 锁。
    if (holder?.cancelled === true) {
      cancelled = true
      break
    }
    if (Date.now() >= deadline) {
      timedOut = true
      handle.kill()
      break
    }
    await delay(pollMs)
  }
  } finally {
    holder?.clear()
  }
  const rest = handle.read()
  if (rest.delta !== '') output += rest.delta

  // 沙箱事实按 `loginFailureAdvice` 认的形状给（后台句柄只回 `{ mode, denied, runnerFailed }`）。
  const info = handle.sandbox()
  const sandbox = info === undefined
    ? undefined
    : {
        requested: '', resolved: '', ran: text(info.mode),
        denied: info.denied === true, runnerFailed: info.runnerFailed === true,
      }
  const exitCode = handle.exitCode()
  const advice = loginFailureAdvice('dws', { error: '', stdout: output, stderr: '', exitCode, timedOut, sandbox })
  // 成功时 `error` 必须是空串（旧形状）：`describeFailure` 对成功会回「命令退出码 0」，
  // 那会让界面把一次成功显示成失败。
  const raw = text(output).trim()
  const ok = !timedOut && !cancelled && exitCode === 0
  const error = ok
    ? ''
    : (cancelled
        ? '已取消这次登录'
        : (advice.blocked
            ? describeLoginAdvice('dws', advice, raw)
            : (raw !== '' ? raw.slice(-600) : `dws auth login 退出码 ${String(exitCode ?? 'unknown')}`)))
  return {
    ok,
    error,
    timedOut,
    sandboxBlocked: advice.blocked && !cancelled,
    advice: advice.blocked && !cancelled ? advice.action : '',
    opened,
    openError,
    url: authorizationUrl,
    cancelled,
    ...tails({ stdout: output, stderr: '' }),
  }
}

export interface ReloginResult extends LoginResult {
  session: H3yunSession | null
}

/** 氚云重新登录（`crwu h3yun session login` 在提权白名单里）。 */
export async function relogin(deps: SystemDeps, home: string): Promise<ReloginResult> {
  const run = await runCrwu(deps.ctx, ['crwu', 'h3yun', 'session', 'login'], {
    workdir: await deps.workdir(),
    timeoutMs: 300_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
    // 扫码要起的临时浏览器 profile 落在插件自己的 scratch 目录里，
    // 不再依赖系统 TEMP（Windows 实测两者都会被这台机器拒绝）。
  })
  // `runCrwu` 只会对**结构化事实**说出的沙箱问题补文案（事实干净就不猜文本）；
  // 扫码这条还多一种形态：宿主按完全访问跑、操作系统的沙箱/ACL 仍然拒绝临时 profile 目录
  // （2026-09-29 实测）。登录的判据更强（目标就是登录必须写的那个目录），所以这里补上。
  const advice = loginFailureAdvice('h3yun', {
    error: run.error, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode,
    timedOut: run.timedOut, sandbox: run.sandbox,
  })
  // `runCrwu` 已经把**结构化**沙箱问题补进 `run.error` 了；这一次补的是事实干净、
  // 但操作系统层面仍然拒绝临时 profile 目录的那一形态，所以证据只取命令自己的原话
  // （stderr），避免同一句归因说两遍。
  const error = run.ok
    ? ''
    : (advice.blocked ? describeLoginAdvice('h3yun', advice, text(run.stderr)) : run.error)
  return {
    ok: run.ok,
    error,
    timedOut: run.timedOut,
    sandboxBlocked: advice.blocked,
    advice: advice.blocked ? advice.action : '',
    session: parseSessionOutput(run.stdout),
    ...tails(run),
  }
}

// ── session ─────────────────────────────────────────────────────────────────

export interface SessionResult {
  ok: boolean
  error: string
  session: H3yunSession | null
}

/** 查氚云会话状态（不登录）。 */
export async function sessionStatus(deps: SystemDeps): Promise<SessionResult> {
  const run = await runCrwu(deps.ctx, ['crwu', 'h3yun', 'session', 'status'], {
    workdir: await deps.workdir(),
    timeoutMs: 20_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
  })
  return {
    ok: run.ok,
    error: run.ok ? '' : describeFailure(run),
    session: parseSessionOutput(run.stdout),
  }
}

// ── oss-cred ────────────────────────────────────────────────────────────────

export interface OssCredResult {
  ok: boolean
  cred: OssCredView
}

/** 查看当前 AK 配置（**脱敏视图**，只回 endpoint 与打码后的 key）。 */
export async function ossCred(deps: SystemDeps, home: string): Promise<OssCredResult> {
  return { ok: true, cred: await readOssCred(deps.ctx, home, { access: deps.access, source: 'panel', workdir: home }) }
}
