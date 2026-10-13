import type { Context } from '@deepseek-ai/cordis'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { ShellBackgroundHandle } from '../shell/run.ts'
import type { DwsDeviceLoginView } from '../../shared/types.ts'
import { text } from '../../shared/utils/value.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import { openExternalCommand, shellInvoke } from '../platform/shell.ts'
import { describeLoginAdvice, loginFailureAdvice } from './login-failure.ts'

/**
 * 钉钉**设备流**登录（`dws auth login --device`，协议 32）。
 *
 * ## 为什么解析是"尽力而为"，而不是契约
 *
 * `dws` 只保证**人类可读输出**（上游二进制，没有结构化契约）。所以：解析出 URL 与授权码能
 * 让界面给出「打开授权页面 / 复制授权码」两个动作；解析不出来**不影响流程** ——
 * `tail` 始终把原文交给员工，他照着念也能走完。
 *
 * ## 为什么 URL 要过白名单
 *
 * 解析出来的链接会被交给系统浏览器打开。没有白名单，这段文字就成了"让宿主打开任意 URL"
 * 的入口（那段文字来自一个**外部进程**的输出）。判据必须是 **https + 钉钉域后缀匹配**：
 * `includes('dingtalk.com')` 会放过 `https://dingtalk.com.evil.tld/`。
 */

export interface DwsDeviceAuthorization {
  /**
   * **首选**链接：dws 打印的「授权链接（已填入授权码）」那一版。
   *
   * 为什么必须挑这一版：打开后员工**只要点确认**（码已经在链接里）。dws 会在它后面再打印一条
   * 「手动输入授权码的链接」—— 按"取最后一个 URL"的直觉恰好会选错，让员工把码抄一遍。
   */
  url: string
  /** 需要手动输入授权码的那条链接；与 `url` 相同或缺失时回空串（没有额外价值）。 */
  urlManual: string
  userCode: string
}

/** 回给界面的输出尾巴长度：够覆盖 CLI 的提示语与授权码，又不至于把整段日志塞进响应。 */
export const DEVICE_LOGIN_TAIL = 600
/** Host 侧读取后台增量的间隔。 */
export const DEVICE_LOGIN_POLL_MS = 500
/** Host 侧总时限：dws 自己也是 5 分钟，谁先到谁说话。 */
export const DEVICE_LOGIN_LIMIT_MS = 300_000

/** 允许被打开的授权页域名（含子域）。`.io` 是 dws 的国际版入口，本次不传 `--intl` 但白名单不因此变窄。 */
const DEVICE_URL_SUFFIXES = ['dingtalk.com', 'dingtalk.io']

/**
 * 这个 URL 能不能交给系统浏览器打开。
 *
 * 按**域名后缀**匹配（`host === d || host.endsWith('.' + d)`），不是子串包含 ——
 * 后者会被 `dingtalk.com.evil.tld` 骗过。
 */
export function deviceUrlAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return DEVICE_URL_SUFFIXES.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** dws 打印 URL 时会紧跟标点（中英文都有），这些都要剪掉，否则打开的链接是错的。 */
const TRAILING_PUNCTUATION = /[.,;:，。]+$/u
/** 独立的连字符大写码（`ABCD-EFGH`）。 */
const HYPHENATED_CODE = /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/gu
/** 标签写法：`授权码：xxxx` / `user code: xxxx`（码本身可能没有连字符）。 */
const LABELED_CODE = /(?:authorization code|user code|授权码|用户码)[^\S\n]*[:：]?[^\S\n]*([A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{4,})*)/giu
/** 行内第一个 http(s) 片段（可能一行里有多条，故用 `g`）。 */
const RAW_URL = /https?:\/\/[^\s"'<>）)，。]+/gu
/** 「已填入授权码」那一版链接的标签（上游 `dfPrintDeviceAuthorization` 原话）。 */
const COMPLETE_LABEL = /已填入授权码/u
/** 「要手动输入授权码」那一版链接的标签。 */
const MANUAL_LABEL = /手动输入授权码|输入授权码/u

type UrlKind = 'complete' | 'manual' | 'plain'

/** 这一行属于哪一种链接 —— 标签可能与 URL 同行，也可能在上一行。 */
function urlKindOf(line: string): UrlKind | '' {
  if (COMPLETE_LABEL.test(line)) return 'complete'
  if (MANUAL_LABEL.test(line)) return 'manual'
  return ''
}

/** 取**最后**一次匹配：授权码过期时 dws 会重发，旧码此刻已经无效。 */
function lastMatch(pattern: RegExp, source: string): string {
  let found = ''
  let match: RegExpExecArray | null
  // 每次都从 new RegExp 拿一份干净状态：带 `g` 的正则对象有 lastIndex，跨调用会串。
  const scan = new RegExp(pattern.source, pattern.flags)
  while ((match = scan.exec(source)) !== null) {
    if (match[0] === '') { scan.lastIndex += 1; continue }
    found = match[1] ?? match[0]
  }
  return found
}

/**
 * 从 `dws` 的输出里解析授权链接与设备码。
 *
 * 按**标签**分类，而不是按位置猜：
 * - 「授权链接（已填入授权码）」→ `url`（首选，打开即可确认）；
 * - 「手动输入授权码的链接」→ `urlManual`（退路）；
 * - 其余（例如 loopback 的「如果浏览器未自动打开，请手动访问」）→ plain，用于兜底。
 *
 * 解析不出来**不抛错**：`tail` 永远把原文交给员工。链接与授权码互相独立 —— 链接不在白名单里就当
 * 没解析出来，但码该给还是要给。
 */
export function parseDwsDeviceAuthorization(output: string): DwsDeviceAuthorization {
  const source = text(output)
  let complete = '', manual = '', plain = ''
  let inherited: UrlKind | '' = ''
  for (const line of source.split(/\r?\n/u)) {
    const urls = [...line.matchAll(new RegExp(RAW_URL.source, RAW_URL.flags))]
      .map((match) => text(match[0]).replace(TRAILING_PUNCTUATION, ''))
      .filter((candidate) => deviceUrlAllowed(candidate))
    const label = urlKindOf(line)
    if (urls.length === 0) {
      // 标签行本身没有 URL：它描述的是**下一行**那个链接。
      if (label !== '') inherited = label
      continue
    }
    const kind: UrlKind = label !== '' ? label : (inherited === '' ? 'plain' : inherited)
    for (const url of urls) {
      if (kind === 'complete') complete = url
      else if (kind === 'manual') manual = url
      else plain = url
    }
    inherited = ''
  }

  const url = complete !== '' ? complete : (manual !== '' ? manual : plain)
  const urlManual = manual !== '' && manual !== url ? manual : ''
  const hyphenated = lastMatch(HYPHENATED_CODE, source)
  const userCode = hyphenated !== '' ? hyphenated : lastMatch(LABELED_CODE, source)
  return { url, urlManual, userCode }
}

// ── loopback 登录的句柄持有者（协议 32）──────────────────────────────────────

/**
 * 正在跑的 **loopback** 登录（`dws auth login`）句柄的持有者。
 *
 * ## 为什么需要它（2026-10-13 用户实测）
 *
 * loopback 那条路最长要等人授权 5 分钟，而两条登录**抢同一把 `~/.dws` 锁** —— 所以那 5 分钟里
 * 设备流那颗按钮必须是灰的。结果是：员工点了「登录钉钉」之后**没有任何出路**，
 * 只能干等（真机现场还有等 5 分钟才失败的情况）。
 *
 * 有了这个持有者，Host 就能在员工想改用设备流时**真的把那条命令杀掉**，立刻让出锁；
 * 插件卸载时也顺手收尾 —— 之前现场留下的三个 `dws auth login` 进程正是没人收尾。
 */
export interface LoginHandleHolder {
  /** 登记本次会话的句柄（并复位"被取消过"标记）。 */
  set(handle: ShellBackgroundHandle): void
  /** 本次会话结束，注销句柄。 */
  clear(): void
  /** 杀掉正在跑的那一个；回 `true` = 真的杀了一个。 */
  cancel(): boolean
  /** 这一次会话有没有被取消过（`set()` 时复位）。 */
  readonly cancelled: boolean
  /** 插件卸载：注销并收尾。 */
  dispose(): void
}

export function createLoginHandleHolder(): LoginHandleHolder {
  let handle: ShellBackgroundHandle | undefined
  let cancelled = false
  const cancel = (): boolean => {
    // 没有在跑的会话就**不**动标记：`cancelled` 说的是"这一次会话被取消了"，
    // 而不是"有人按过取消"。置真了会让下一次会话一上来就被当成取消（`set()` 虽然会复位，
    // 但"按了取消"与"取消了一个会话"是两件事，别混）。
    if (handle === undefined) return false
    cancelled = true
    return handle.kill()
  }
  return {
    set(next) { handle = next; cancelled = false },
    clear() { handle = undefined },
    cancel,
    get cancelled() { return cancelled },
    dispose() {
      cancel()
      handle = undefined
    },
  }
}

// ── 会话注册表（协议 32）──────────────────────────────────────────────────────

/**
 * ## 为什么必须由 `apply()` 按插件实例持有
 *
 * 它握着一条后台进程与一个轮询定时器。卸载后残留就是「看不见的进程还占着 `~/.dws` 的登录态锁」，
 * 员工下一次登录会莫名其妙失败 —— 而模块级单例还会跨插件实例串味。
 *
 * ## 为什么只有一个定时器
 *
 * 到点判定放在轮询里比对 `now() >= deadline`，不再额外 `setTimeout`：少一个定时器就少一处
 * "忘了清"的机会，也让测试的假定时器只需拦一个入口。定时器一律走 `globalThis.setInterval`
 * / `globalThis.clearInterval`（不要从 `node:timers` 直接 import），否则替身拦不住。
 */

/** 起一次设备流登录要的东西（与 `SystemDeps` 形状兼容，但不依赖它以免循环 import）。 */
export interface DeviceLoginDeps {
  ctx: Context
  access: LocalAccessBroker
  platform: string
  workdir: () => Promise<string>
}

export interface DwsDeviceLoginRegistry {
  /** 起一次登录；已有正在跑的那次就直接回它的快照（**不**起第二个进程）。 */
  start(deps: DeviceLoginDeps): Promise<DwsDeviceLoginView>
  /** 最近一次登录（含已结束的）；从没起过返回 `null`。 */
  status(): DwsDeviceLoginView | null
  /** 取消正在跑的那次；已经落定就原样返回（幂等）。 */
  cancel(): DwsDeviceLoginView
  /** 现在有没有正在跑的会话 —— `dws-login` 靠它拦住"两个登录抢同一把锁"。 */
  running(): boolean
  /** 插件卸载：杀掉仍在跑的进程并清定时器。 */
  dispose(): Promise<void>
}

export interface DwsDeviceLoginOptions {
  pollMs?: number
  limitMs?: number
  now?: () => number
}

interface Session {
  /** 起这次会话的依赖：轮询定时器里要拿它去开授权页，所以必须随会话存下来。 */
  deps: DeviceLoginDeps
  /** 打开授权页那条前台命令的工作目录（提权执行必须有工作区）。 */
  workdir: string
  /** 后台句柄；`start` 失败时保持 `undefined`。 */
  handle: ShellBackgroundHandle | undefined
  snapshot: DwsDeviceLoginView
  /** 累积输出：解析"最后一次"必须看全量，不能只看尾巴。 */
  output: string
  timer: ReturnType<typeof setInterval> | undefined
  deadline: number
  killedByDeadline: boolean
  /** 员工主动取消（或插件卸载）—— 终态与"自己失败"必须分开。 */
  cancelled: boolean
  /** 已经为哪个 URL 尝试过打开（同一个链接只开一次，链接换了才再开）。 */
  attemptedUrl: string
}

/** 一份"没有会话可谈"的空快照：失败与取消的兜底形状。 */
export function emptyDeviceLoginView(
  phase: DwsDeviceLoginView['phase'],
  error: string,
): DwsDeviceLoginView {
  return {
    phase, url: '', urlManual: '', userCode: '', tail: '', error, advice: '',
    sandboxBlocked: false, deadlineAt: '', opened: false, openError: '',
  }
}

export function createDwsDeviceLoginRegistry(options: DwsDeviceLoginOptions = {}): DwsDeviceLoginRegistry {
  const pollMs = options.pollMs ?? DEVICE_LOGIN_POLL_MS
  const limitMs = options.limitMs ?? DEVICE_LOGIN_LIMIT_MS
  const now = options.now ?? Date.now
  let current: Session | null = null

  const clearTimer = (session: Session): void => {
    if (session.timer !== undefined) globalThis.clearInterval(session.timer)
    session.timer = undefined
  }

  const snapshotOf = (): DwsDeviceLoginView | null =>
    (current === null ? null : { ...current.snapshot })

  /**
   * 落终态。
   *
   * ⚠️ **先清定时器再判状态**：`settle` 会被轮询与 `cancel` 同时触发，早退时若不清定时器，
   * 轮询 interval 会永远留在事件循环里（2026-09-29 由缺陷注入暴露：整条测试进程退不出来）。
   * 清理必须幂等、且不依赖 phase；`phase !== 'running'` 直接返回正是**取消幂等**的实现方式
   * （已经 `ok` 的会话再取消不会被覆写成失败）。
   */
  const settle = (session: Session): void => {
    clearTimer(session)
    if (session.snapshot.phase !== 'running') return
    if (session.handle !== undefined) {
      const rest = session.handle.read()
      if (rest.delta !== '') session.output += rest.delta
    }
    const tail = session.output.slice(-DEVICE_LOGIN_TAIL)
    session.snapshot.tail = tail
    if (session.cancelled) {
      session.snapshot.phase = 'cancelled'
      session.snapshot.error = ''
      return
    }
    const exitCode = session.handle === undefined ? null : session.handle.exitCode()
    if (session.killedByDeadline) {
      session.snapshot.phase = 'timeout'
      session.snapshot.error = '等待授权超时（5 分钟）'
      return
    }
    if (exitCode === 0) {
      session.snapshot.phase = 'ok'
      session.snapshot.error = ''
      return
    }
    // 归因口径与 `dwsLogin` 完全一致：**结构化事实优先**，文本判据只是兜底。
    // 真机上 dws 可能在还没打印任何东西时就被沙箱挡住（输出为空）—— 那时只有执行器给的
    // `{ mode, denied, runnerFailed }` 能说明问题。后台句柄的形状与前台不同，这里映射一次。
    const info = session.handle?.sandbox()
    const sandbox = info === undefined
      ? undefined
      : {
          requested: '', resolved: '', ran: text(info.mode),
          denied: info.denied === true, runnerFailed: info.runnerFailed === true,
        }
    const advice = loginFailureAdvice('dws', {
      error: '', stdout: session.output, stderr: '', exitCode, timedOut: false, sandbox,
    })
    session.snapshot.sandboxBlocked = advice.blocked
    session.snapshot.advice = advice.blocked ? advice.action : ''
    session.snapshot.phase = 'failed'
    session.snapshot.error = advice.blocked
      ? describeLoginAdvice('dws', advice, tail)
      : (tail.trim() === '' ? `dws auth login 退出码 ${String(exitCode ?? 'unknown')}` : tail.trim())
  }

  /**
   * 打开授权页（**每个链接只开一次**）。
   *
   * 为什么由插件开：dws 自己那次失败是静默的（loopback 用 nil logger、device 只记 Debug），
   * 员工看到的就是"点了没反应"。插件走的是与「查看报告」同一条已验证路径
   * （`system.browser.open`），并且把结果如实记进快照 —— 失败时客户端还能再补开一次。
   */
  const openAuthorizationPage = (session: Session): void => {
    const url = session.snapshot.url
    if (url === '' || session.attemptedUrl === url) return
    session.attemptedUrl = url
    void session.deps.access.runShell(
      { operation: 'system.browser.open', source: 'panel', workdir: session.workdir },
      // 新实例：别人挂着的无头浏览器会把 URL 吞掉（且 `open` 仍退出 0）。
      openExternalCommand(url, session.deps.platform, { newInstance: true }),
      { timeoutMs: 30_000, summary: 'system.browser.open' },
    ).then((run) => {
      session.snapshot.opened = run.ok
      session.snapshot.openError = run.ok
        ? ''
        : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 200)
    }).catch((error: unknown) => {
      session.snapshot.opened = false
      session.snapshot.openError = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    })
  }

  const poll = (session: Session): void => {
    if (session.handle === undefined) return
    const read = session.handle.read()
    if (read.delta !== '') {
      session.output += read.delta
      // **每次都覆盖**：重发之后旧码已经无效，留着它等于让员工念一个必然失败的码。
      const parsed = parseDwsDeviceAuthorization(session.output)
      if (parsed.url !== '') session.snapshot.url = parsed.url
      if (parsed.urlManual !== '') session.snapshot.urlManual = parsed.urlManual
      if (parsed.userCode !== '') session.snapshot.userCode = parsed.userCode
    }
    // 拿到链接就开一次；dws 那边已经被要求不要自己开（`--no-browser`），所以不会开出两个窗口。
    openAuthorizationPage(session)
    if (session.snapshot.phase === 'running' && now() >= session.deadline) {
      session.killedByDeadline = true
      session.handle.kill()
    }
    if (session.handle.status() !== 'running') settle(session)
  }

  return {
    async start(deps) {
      // 两个 dws 会抢同一把 `~/.dws` 锁，第二个必以 `Access is denied` 失败 ——
      // 而那个报错会被归因读成"权限不足"。所以重复点击只回当前快照。
      if (current !== null && current.snapshot.phase === 'running') return { ...current.snapshot }

      const command = await resolveBundledCommand(deps.ctx, deps.platform, 'dws')
      const workdir = await deps.workdir()
      const started = now()
      const session: Session = {
        deps,
        handle: undefined,
        snapshot: {
          phase: 'running', url: '', urlManual: '', userCode: '', tail: '', error: '', advice: '',
          sandboxBlocked: false, deadlineAt: new Date(started + limitMs).toISOString(),
          opened: false, openError: '',
        },
        workdir,
        output: '',
        timer: undefined,
        deadline: started + limitMs,
        killedByDeadline: false,
        cancelled: false,
        attemptedUrl: '',
      }
      current = session

      const spawn = await deps.access.startShell(
        { operation: 'dws.auth.login', source: 'panel', workdir },
        // `--no-browser`：浏览器由插件打开（dws 自己那次失败是静默的，见 openAuthorizationPage）。
        shellInvoke(command, ['auth', 'login', '--device', '--no-browser'], deps.platform),
        { summary: 'dws auth login --device' },
      )
      if (!spawn.ok) {
        const advice = loginFailureAdvice('dws', { error: spawn.error, sandbox: spawn.sandbox })
        session.snapshot.phase = 'failed'
        session.snapshot.sandboxBlocked = advice.blocked
        session.snapshot.advice = advice.blocked ? advice.action : ''
        session.snapshot.error = advice.blocked
          ? describeLoginAdvice('dws', advice, spawn.error)
          : spawn.error
        return { ...session.snapshot }
      }
      session.handle = spawn.handle
      session.timer = globalThis.setInterval(() => { poll(session) }, pollMs)
      return { ...session.snapshot }
    },

    status: snapshotOf,

    cancel() {
      const session = current
      if (session === null) return emptyDeviceLoginView('cancelled', '')
      session.cancelled = true
      session.handle?.kill()
      settle(session)
      return { ...session.snapshot }
    },

    running() {
      return current !== null && current.snapshot.phase === 'running'
    },

    async dispose() {
      const session = current
      if (session === null) return
      session.cancelled = true
      session.handle?.kill()
      settle(session)
      current = null
    },
  }
}
