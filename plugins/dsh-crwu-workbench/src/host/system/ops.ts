import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, isFile, resolveTarget } from '../fs/paths.ts'
import { runCrwu, describeFailure } from '../crwu/run.ts'
import { parseSessionOutput, type H3yunSession } from '../h3yun/session.ts'
import { readOssCred, type OssCredView } from '../oss/cred.ts'
import { shellInvoke, clipboardCommand, openExternalCommand } from '../platform/shell.ts'
import { describeLoginAdvice, loginFailureAdvice } from './login-failure.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { ShellBackgroundHandle } from '../shell/run.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import { runDws } from '../dws/run.ts'
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

/** 输出可能很长（扫码登录会打印提示），只回尾部给界面。 */
function tails(run: { stdout?: unknown; stderr?: unknown }): { stdoutTail: string; stderrTail: string } {
  return { stdoutTail: text(run.stdout).slice(-600), stderrTail: text(run.stderr).slice(-600) }
}


/** 钉钉登录。`--device` 走设备码流程（无浏览器时用）。 */
export async function dwsLogin(deps: SystemDeps, args: Record<string, unknown>, home: string): Promise<LoginResult> {
  // 用**包内绝对路径**：只按名字调用在 Finder 启动的桌面端会 `bash: dws: command not found`，
  // 表现就是「点了钉钉登录没有任何反应」（客户端此前又把返回值丢掉了，所以连错误都看不到）。
  const argv = [await resolveBundledCommand(deps.ctx, deps.platform, 'dws'), 'auth', 'login']
  if (args.device === true) argv.push('--device')
  const workdir = await deps.workdir()
  // 目录与临时目录都用 CLI 自己的默认：插件不再替它决定位置（自指定目录那条通道已整体下掉，见 §16）。
  const run = await deps.access.runShell(
    { operation: 'dws.auth.login', source: 'panel', workdir },
    shellInvoke(argv[0] ?? '', argv.slice(1), deps.platform),
    // 扫码要等人，5 分钟。
    { timeoutMs: 300_000, summary: 'dws auth login' },
  )
  // 钉钉这条路以前**不做归因**（`runDws` 才做），于是沙箱挡住 `.dws` 锁时员工看到的是
  // dws 的原话（像它自己的 bug）。设备码那条同样要抢同一个锁，所以归因对两条都成立。
  const advice = loginFailureAdvice('dws', {
    error: run.error, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode,
    timedOut: run.timedOut, sandbox: run.sandbox,
  })
  // 成功时 `error` 必须是空串（旧形状）：`describeFailure` 对成功会回「命令退出码 0」，
  // 那会让界面把一次成功显示成失败。
  const raw = text(run.stderr).trim() || text(run.error).trim()
  const error = run.ok
    ? ''
    : (advice.blocked ? describeLoginAdvice('dws', advice, raw) : describeFailure(run))
  return {
    ok: run.ok,
    error,
    timedOut: run.timedOut,
    sandboxBlocked: advice.blocked,
    advice: advice.blocked ? advice.action : '',
    ...tails(run),
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

/**
 * 绑定氚云网页会话（`crwu h3yun session bind --token-stdin`）。
 *
 * 这是「内置浏览器扫码」那条链路唯一的凭据出口：客户端在内嵌浏览器的页面里读到
 * `h3_token`，只在本进程内存里过一手，**立刻经标准输入**交给 CLI。因此：
 *
 * 1. **令牌不进 argv**（同机 `ps` / 任务管理器看不到），也不落盘、不回显、不进日志；
 * 2. **空令牌零调用**：一个进程都不起 —— 否则等于让 CLI 去报「令牌无效」，
 *    把「界面上什么都没填」指成「凭据有问题」；
 * 3. **不回 stdout/stderr 尾巴**：登录失败归因走 `describeFailure`（CLI 自己的话，≤400 字），
 *    少一个把原始输出交给界面的通道，就少一个泄漏面。CLI 侧「绝不回显令牌」由
 *    `internal/transport/cli` 的单测钉住（成功与失败两条路径都断言过）。
 */
export interface BindResult {
  ok: boolean
  error: string
  session: H3yunSession | null
}

export async function bindH3yunSession(deps: SystemDeps, args: Record<string, unknown>): Promise<BindResult> {
  const token = text(args.token)
  if (token.trim() === '') return { ok: false, error: '没有收到会话令牌', session: null }
  // 换行只可能来自拼接错误；CLI 会把它当成令牌的一部分，报出来的错会指向错误的方向。
  if (/[\r\n]/.test(token)) return { ok: false, error: '会话令牌不合法：含换行', session: null }

  const run = await runCrwu(deps.ctx, ['crwu', 'h3yun', 'session', 'bind', '--token-stdin'], {
    workdir: await deps.workdir(),
    timeoutMs: 30_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
    stdinText: token,
  })
  return {
    ok: run.ok,
    error: run.ok ? '' : describeFailure(run),
    session: run.ok ? parseSessionOutput(run.stdout) : null,
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

// ── 钉钉登录：异步两阶段（协议 21）────────────────────────────────────────────

/**
 * 钉钉登录为什么必须是两阶段。
 *
 * `dws auth login` 默认走 OAuth loopback：它先在 127.0.0.1 上监听，然后**打印授权 URL**
 * 等浏览器回调。这条命令要等人，5 分钟才结束 —— 而旧实现是**同步等它结束**再把 stdout
 * 尾巴交给界面：URL 到界面时，用户早已不在等它了（CLI 那边也早就超时）。
 *
 * 所以改成：`start` 起一条**后台**命令并立刻返回第一份快照，`status` 轮询后续快照。
 * 界面拿到 URL / 设备码就能打开或复制，CLI 的 loopback 继续等回调。
 */
export interface DwsLoginSnapshot {
  phase: 'running' | 'ok' | 'failed' | 'timeout'
  ok: boolean
  /** 这次是不是设备码流程（`--device`）。 */
  device: boolean
  /** 从输出里解析出的授权 URL；空串 = 还没打印出来。 */
  url: string
  /** 设备码流程里的 user code；空串 = 没有或还没打印。 */
  userCode: string
  /** 最近的输出尾巴（末尾 600 字）——它是**给人看的**，界面据此显示原文。 */
  tail: string
  error: string
  timedOut: boolean
  sandboxBlocked: boolean
  advice: string
}

/**
 * 从 `dws` 的输出里解析授权 URL 与设备码（**尽力而为**，不是契约）。
 *
 * `dws` 只保证人类可读输出（上游二进制），所以这里只做两件低风险的事：
 * - URL：第一个 `http(s)://…` 片段（去掉尾部的标点）；
 * - user code：优先独立的连字符大写码（`ABCD-EFGH`），否则取 "authorization code" 之后
 *   第一段像码的 token。
 *
 * 解析不出来**不影响**流程：`tail` 会把原文交给界面（与旧行为一致），
 * 结构化字段只是让界面能给出「打开 / 复制」两个动作。
 */
export function parseDwsAuthorization(output: string): { url: string; userCode: string } {
  const urlMatch = /https?:\/\/[^\s"'<>）)，。]+/u.exec(output)
  const url = urlMatch === null ? '' : urlMatch[0].replace(/[.,;:]+$/u, '')
  const hyphenated = /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/u.exec(output)
  if (hyphenated !== null) return { url, userCode: hyphenated[1] }
  const afterLabel = /(?:authorization code|user code|授权码|用户码)[^\S\n]*[:：]?[^\S\n]*\n?[^\S\n]*([A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{4,})*)/iu.exec(output)
  return { url, userCode: afterLabel === null ? '' : afterLabel[1] }
}

/** 输出尾巴长度：足够覆盖 CLI 的提示语与设备码，又不至于把整段日志塞进响应。 */
const DWS_LOGIN_TAIL = 600
/** 轮询间隔与总上限：登录要等人，但不能无限跑。 */
const DWS_LOGIN_POLL_MS = 500
const DWS_LOGIN_LIMIT_MS = 5 * 60_000

interface DwsLoginSession {
  /** 这条会话自己的后台句柄（**不许**挂在模块级变量上：第二次登录会把第一次的串掉）。 */
  handle: ShellBackgroundHandle | undefined
  snapshot: DwsLoginSnapshot
  output: string
  /** 读取后台输出、判结束的定时器。 */
  poll: ReturnType<typeof setInterval> | undefined
  /** 总时限。 */
  deadline: ReturnType<typeof setTimeout> | undefined
  killedByDeadline: boolean
}

export interface DwsLoginRegistry {
  /** 起一次登录；已有正在跑的那次就直接回它的快照（不重复起进程）。 */
  start(deps: SystemDeps, args: Record<string, unknown>, home: string): Promise<DwsLoginSnapshot>
  /** 最近一次登录（含已结束的）；从没起过返回 null。 */
  status(): DwsLoginSnapshot | null
  /** 插件卸载：杀掉仍在跑的进程、清定时器。 */
  dispose(): Promise<void>
}

/**
 * 登录会话注册表。
 *
 * **必须由 `apply()` 创建并按实例持有**（不是模块级单例）：它持有后台进程与定时器，
 * 卸载后残留就是"看不见的进程还占着 `~/.dws` 的锁"。
 */
export interface DwsLoginRegistryOptions {
  /** 轮询间隔；测试注入小值把等待变成确定事件。 */
  pollMs?: number
  /** 总时限；测试可以调小来验「超时就杀掉」。 */
  limitMs?: number
}

export function createDwsLoginRegistry(options: DwsLoginRegistryOptions = {}): DwsLoginRegistry {
  const pollMs = options.pollMs ?? DWS_LOGIN_POLL_MS
  const limitMs = options.limitMs ?? DWS_LOGIN_LIMIT_MS
  let current: DwsLoginSession | null = null

  const clearTimers = (session: DwsLoginSession): void => {
    if (session.poll !== undefined) clearInterval(session.poll)
    if (session.deadline !== undefined) clearTimeout(session.deadline)
    session.poll = undefined
    session.deadline = undefined
  }

  const settle = async (session: DwsLoginSession, deps: SystemDeps): Promise<void> => {
    // **先清定时器再判状态**：`settle` 可能被 `done` 与轮询同时触发，
    // 早退时不清定时器会把轮询 interval 永远留在事件循环里（2026-09-29 由缺陷注入暴露：
    // 一次"已经结束"的快照让进程再也退不出来）。清理必须幂等、且不依赖 phase。
    clearTimers(session)
    if (session.snapshot.phase !== 'running') return
    // 收尾前把剩下的输出读干净（增量是消耗式的，这里最后一次读很关键）。
    if (session.handle !== undefined) {
      const rest = session.handle.read()
      if (rest.delta !== '') session.output += rest.delta
    }
    const exitCode = session.handle === undefined ? null : session.handle.exitCode()
    const advice = loginFailureAdvice('dws', {
      error: '', stdout: session.output, stderr: '', exitCode,
      timedOut: session.killedByDeadline, sandbox: undefined,
    })
    session.snapshot.tail = session.output.slice(-DWS_LOGIN_TAIL)
    session.snapshot.timedOut = session.killedByDeadline
    session.snapshot.sandboxBlocked = advice.blocked
    session.snapshot.advice = advice.blocked ? advice.action : ''
    if (session.killedByDeadline) {
      session.snapshot.phase = 'timeout'
      session.snapshot.ok = false
      session.snapshot.error = '等待授权超时'
      return
    }
    if (exitCode === 0) {
      session.snapshot.phase = 'ok'
      session.snapshot.ok = true
      session.snapshot.error = ''
      return
    }
    session.snapshot.phase = 'failed'
    session.snapshot.ok = false
    session.snapshot.error = advice.blocked
      ? describeLoginAdvice('dws', advice, session.output.slice(-DWS_LOGIN_TAIL))
      : (session.output.trim().slice(-DWS_LOGIN_TAIL) || `dws auth login 退出码 ${String(exitCode ?? 'unknown')}`)
  }

  const snapshotOf = (): DwsLoginSnapshot | null =>
    (current === null ? null : { ...current.snapshot })

  return {
    async start(deps, args, home) {
      if (current !== null && current.snapshot.phase === 'running') return { ...current.snapshot }

      const device = args.device === true
      const argv = [await resolveBundledCommand(deps.ctx, deps.platform, 'dws'), 'auth', 'login']
      if (device) argv.push('--device')
      const command = shellInvoke(argv[0] ?? '', argv.slice(1), deps.platform)
      const workdir = await deps.workdir()
      const base: DwsLoginSnapshot = {
        phase: 'running', ok: false, device, url: '', userCode: '', tail: '',
        error: '', timedOut: false, sandboxBlocked: false, advice: '',
      }
      const session: DwsLoginSession = {
        handle: undefined, snapshot: base, output: '', poll: undefined, deadline: undefined,
        killedByDeadline: false,
      }
      /** 起一次登录进程。**只起一次** —— 登录是有副作用的交互，不能靠重试来兜。 */
      const spawn = async (): Promise<string> => {
        const started = await deps.access.startShell(
          { operation: 'dws.auth.login', source: 'panel', workdir },
          command,
          { summary: 'dws auth login' },
        )
        if (!started.ok) return started.error
        session.handle = started.handle
        session.poll = setInterval(() => {
          if (session.handle === undefined) return
          const read = session.handle.read()
          if (read.delta !== '') {
            session.output += read.delta
            const parsed = parseDwsAuthorization(session.output)
            if (parsed.url !== '') session.snapshot.url = parsed.url
            if (parsed.userCode !== '') session.snapshot.userCode = parsed.userCode
          }
          if (session.handle.status() !== 'running') void settle(session, deps)
        }, pollMs)
        session.deadline = setTimeout(() => {
          session.killedByDeadline = true
          session.handle?.kill()
        }, limitMs)
        void started.handle.done.then(() => { void settle(session, deps) })
        return ''
      }
      current = session
      const spawnError = await spawn()
      if (spawnError !== '') {
        session.snapshot = { ...session.snapshot, phase: 'failed', error: spawnError }
        return { ...session.snapshot }
      }
      return { ...session.snapshot }
    },
    status: snapshotOf,
    async dispose() {
      if (current !== null) clearTimers(current)
      if (current?.snapshot.phase === 'running') current.handle?.kill()
      if (current !== null) current.handle = undefined
    },
  }
}
