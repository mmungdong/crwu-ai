/**
 * 氚云「内置浏览器登录」的客户端核心：DSH 桌面 lease 浏览器 + 读 cookie + 交令牌。
 *
 * ## 为什么要走 DSH 桌面壳的内部桥
 *
 * 氚云网页会话 `h3_token` 只能从**页面自己的 `document.cookie`** 里读出来（E1 实测：
 * 写入点与读取点都在氚云前端，见 `docs/development-notes.md` §14）。DSH 的公开浏览器入口
 * （`ctx.sidebarRight.openTab('browser')`）只把页面**显示给人看**，不给插件任何读页面 /
 * 执行 JS 的接口；能读页面的唯一形态是插件在桌面端**自己 attach 一个 lease guest**：
 *
 *   `globalThis.dshDesktop.browser.acquire(key)` → `{ lease, partition }`
 *   → 自建 `<webview partition="…" src="about:blank#<lease>">`
 *   → 等 `dom-ready`（主进程此时才把 guest 认到这个 lease 上）
 *   → `loadURL(登录页)` → 轮询 `executeJavaScript('document.cookie')`
 *
 * 这是一条**桌面壳内部契约**（0.2.0-rc.2 实测），不是公开插件 API：拿不到桥时必须整体降级
 * （`bridgeOf` 返回 `undefined`），界面改用系统浏览器 + 显式绑定，绝不能假设它存在。
 *
 * ## 这个模块的边界
 *
 * 只管「拿令牌」：DOM 元素与时钟**由调用方注入**，所以整条驱动逻辑可以在 node 里用替身测。
 * 令牌不落任何地方 —— 拿到就交给 `onToken`，由调用方立刻送 Host（`h3yunSessionBind`）。
 */

/** 桌面 preload 暴露的 browser 桥（只声明我们用到的三个方法）。 */
export interface DesktopBrowserBridge {
  acquire(workspace: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, listener: (url: string) => void): () => void
}

/**
 * 登录专用分区键。
 *
 * 故意**不**复用工作空间的 `cwd:<path>`：登录用的访客是拿来扫码的，没有理由与工作区浏览
 * 共享 Cookie 分区；固定键也让我们不必依赖 `workspaces` 服务（插件因此不需要新增 peer 依赖）。
 * 分区本身是进程内内存态（DSH 侧 `dsh-sidebar-browser-<uuid>`，非 persist），重启即失。
 */
export const LOGIN_PARTITION_KEY = 'crwu-workbench:login'

/** 氚云钉钉扫码登录入口（直接落地到登录页，避免先过首页）。 */
export const H3YUN_LOGIN_URL = 'https://www.h3yun.com/entry/login/dingtalk'

/** 轮询间隔与总超时：与 CLI 侧 `scanlogin` 的 5 分钟保持一致。 */
export const LOGIN_POLL_MS = 2_000
export const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * 从 `carrier` 里取出可用的 browser 桥；形状不对就是 `undefined`。
 *
 * 判据是**形状**而不是 `protocolVersion`：`protocolVersion` 只说明 preload 是新的，
 * 而桥可能因为部署形态（Web profile 的 `dshDesktop` 只有 `{protocolVersion: 1}`）而不存在。
 * 少一个方法就整体降级 —— 半个桥只会在用到时才炸，而那时用户已经点了按钮。
 */
export function bridgeOf(carrier: unknown): DesktopBrowserBridge | undefined {
  if (carrier === null || typeof carrier !== 'object') return undefined
  const candidate = (carrier as { browser?: unknown }).browser
  if (candidate === null || typeof candidate !== 'object') return undefined
  const bridge = candidate as Partial<DesktopBrowserBridge>
  if (typeof bridge.acquire !== 'function') return undefined
  if (typeof bridge.release !== 'function') return undefined
  if (typeof bridge.onOpenRequested !== 'function') return undefined
  return bridge as DesktopBrowserBridge
}

/**
 * 从 `document.cookie` 的字面量里取出 `h3_token`；没有就回空串。
 *
 * 只做取值，不做校验：cookie 值可能被 URL 编码，也可能带引号，交给 `isSessionJwt` 判断形状。
 */
export function parseH3yunToken(cookieHeader: string): string {
  const match = /(?:^|;\s*)h3_token=([^;]*)/.exec(cookieHeader)
  if (match === null) return ''
  return match[1].trim()
}

/**
 * 粗判「这像不像一个可用的会话 JWT」。
 *
 * **不是**权威校验（权威在 CLI：它解码 claims、核对 `enginecode`/`userid`/`exp` 并落库）。
 * 这里只用于「页面还没登录完就先把半截字符串送出去」这种情况：三段式、payload 能解出 JSON、
 * 且带未过期的 `exp`。宁可多等一轮轮询，也不要送一个明显不是令牌的值去换一句
 * 「令牌无效」——那会把失败原因指错方向。
 */
export function isSessionJwt(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 3) return false
  if (parts[0] === '' || parts[1] === '' || parts[2] === '') return false
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1])) as { exp?: unknown; enginecode?: unknown; userid?: unknown }
    if (typeof claims !== 'object' || claims === null) return false
    if (typeof claims.exp !== 'number') return false
    if (claims.exp * 1000 <= Date.now()) return false
    return typeof claims.enginecode === 'string' && typeof claims.userid === 'string'
  } catch (error) {
    void error
    return false
  }
}

/** base64url → 文本（JWT payload）。Node 与浏览器都有 `atob`；失败时抛给调用方去 catch。 */
function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const atobFn = (globalThis as { atob?: (input: string) => string }).atob
  if (typeof atobFn !== 'function') throw new Error('atob is unavailable')
  return atobFn(padded)
}

/**
 * 导航 URL 上有没有钉钉回调的 `code`。返回**只含主机与路径**的位置串（值不进日志/状态）。
 *
 * 这是备通道的入口：主通道读不到 `h3_token` 时，Host 可以拿这个 code 直接调
 * `/v1/login/dingtalk/scan` 换令牌。注意 code 是一次性的，页面可能已经先消费掉它。
 */
export function authCodeLocationOf(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('code')) return ''
    return `${parsed.host}${parsed.pathname}`
  } catch (error) {
    void error
    return ''
  }
}

/** 驱动过程中对外播报的状态（界面据此说话；**不含令牌**）。 */
export type LoginGuestState = 'preparing' | 'waiting' | 'token' | 'code' | 'timeout' | 'error'

/** 注入的 DOM 元素（`<webview>`）—— 只声明我们用到的部分，便于用替身测。 */
export interface GuestView {
  setAttribute(name: string, value: string): void
  addEventListener(name: string, listener: (event: { url?: string }) => void): void
  loadURL(url: string): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  remove(): void
}

/** 注入的时钟（默认是真实定时器；测试用假时钟把等待变成确定事件）。 */
export interface LoginClock {
  /** 周期性执行；返回停止函数。 */
  every(ms: number, run: () => void): () => void
  /** 延迟执行；返回取消函数。 */
  after(ms: number, run: () => void): () => void
}

export const realLoginClock: LoginClock = {
  every: (ms, run) => {
    const handle = setInterval(run, ms)
    return () => { clearInterval(handle) }
  },
  after: (ms, run) => {
    const handle = setTimeout(run, ms)
    return () => { clearTimeout(handle) }
  },
}

export interface LoginGuestOptions {
  bridge: DesktopBrowserBridge
  /** 建一个 `<webview>`（注入以便测试；真实实现就是 `document.createElement('webview')`）。 */
  createView: () => GuestView
  /** 挂到页面上（注入；真实实现把它 append 到卡片容器）。 */
  mount: (view: GuestView) => void
  onState: (state: LoginGuestState) => void
  /** 读到合法令牌时调一次，之后驱动自动收尾。调用方负责立刻交给 Host。 */
  onToken: (token: string) => void
  /** 备通道：导航里出现 `?code=` 时调（位置串不含 code 值）。 */
  onAuthCode?: (location: string) => void
  pollMs?: number
  timeoutMs?: number
  clock?: LoginClock
  /** 读页面 cookie 的脚本（注入以便测试；默认读 `document.cookie`）。 */
  readCookie?: (view: GuestView) => Promise<string>
}

export interface LoginGuestHandle {
  /** 收尾：停轮询、摘掉元素、释放 lease。可重复调用。 */
  stop: () => Promise<void>
}

/** 页面里读 cookie 的表达式：只回字面量，取值与判形状都在插件侧做。 */
const READ_COOKIE_EXPRESSION = 'document.cookie'

/**
 * 启动一次「扫码 → 读令牌」的访客。
 *
 * 顺序是**硬要求**（顺序错了会静默失败，见 §14.1）：先 acquire → 用批准的分区与
 * `about:blank#<lease>` 建元素并挂上 → 等 `dom-ready` → 才导航。主进程在 `dom-ready`
 * 时才把 guest 认到这个 lease 上，提前导航会被判成"不属于任何 lease"而关掉。
 */
export function startH3yunLoginGuest(options: LoginGuestOptions): LoginGuestHandle {
  const clock = options.clock ?? realLoginClock
  const pollMs = options.pollMs ?? LOGIN_POLL_MS
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const readCookie = options.readCookie
    ?? ((view: GuestView) => view.executeJavaScript(READ_COOKIE_EXPRESSION, true).then((value) => String(value ?? '')))

  let stopped = false
  let settled = false
  const timers: Array<() => void> = []
  const cleanups: Array<() => void> = []
  let view: GuestView | undefined
  let lease = ''

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const cancel of timers) cancel()
    timers.length = 0
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
    view?.remove()
    view = undefined
    if (lease !== '') await options.bridge.release(lease).catch(() => undefined)
    lease = ''
  }

  const finish = (state: LoginGuestState): void => {
    if (settled) return
    settled = true
    options.onState(state)
    void stop()
  }

  void (async () => {
    options.onState('preparing')
    let reservation: { lease: string; partition: string }
    try {
      reservation = await options.bridge.acquire(LOGIN_PARTITION_KEY)
    } catch (error) {
      void error
      options.onState('error')
      return
    }
    if (stopped) {
      await options.bridge.release(reservation.lease).catch(() => undefined)
      return
    }
    lease = reservation.lease

    const element = options.createView()
    view = element
    // 主进程只认这两个属性：批准的分区 + `about:blank#<lease>`。
    element.setAttribute('partition', reservation.partition)
    element.setAttribute('allowpopups', '')
    element.setAttribute('src', `about:blank#${reservation.lease}`)
    options.mount(element)

    const openListener = options.bridge.onOpenRequested(reservation.lease, (url) => {
      // 页面自己要开新窗口（钉钉授权可能这么干）：留在同一个访客里，不让它丢。
      try { element.loadURL(url) } catch (error) { void error }
    })
    cleanups.push(openListener)

    const noteNavigation = (url: unknown): void => {
      if (typeof url !== 'string') return
      const location = authCodeLocationOf(url)
      if (location !== '') options.onAuthCode?.(location)
    }
    element.addEventListener('did-navigate', (event) => noteNavigation(event?.url))
    element.addEventListener('will-navigate', (event) => noteNavigation(event?.url))
    element.addEventListener('did-redirect-navigation', (event) => noteNavigation(event?.url))

    const ready = await new Promise<boolean>((resolve) => {
      let done = false
      const settle = (value: boolean): void => { if (!done) { done = true; resolve(value) } }
      element.addEventListener('dom-ready', () => settle(true))
      timers.push(clock.after(15_000, () => settle(false)))
    })
    if (stopped) return
    if (!ready) {
      finish('error')
      return
    }

    try {
      element.loadURL(H3YUN_LOGIN_URL)
    } catch (error) {
      void error
      finish('error')
      return
    }
    options.onState('waiting')

    timers.push(clock.after(timeoutMs, () => finish('timeout')))
    timers.push(clock.every(pollMs, () => {
      if (settled) return
      void readCookie(element).then((cookieHeader) => {
        if (settled) return
        const token = parseH3yunToken(cookieHeader)
        if (token === '' || !isSessionJwt(token)) return
        settled = true
        options.onState('token')
        options.onToken(token)
        void stop()
      }).catch((error) => { void error })
    }))
  })()

  return { stop }
}
