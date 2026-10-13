import type { DwsDeviceLoginView } from '../../../shared/types.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 设备流登录的**客户端逻辑**（协议 32）。
 *
 * ## 为什么逻辑不在 `.tsx` 里
 *
 * 本仓的 React 替身（`tests/helpers/tsx-loader.mjs` 的 `fakeReact`）只实现渲染：`useEffect`
 * 只被塞进数组、从不执行，`useState` 的 setter 也不触发重渲染。轮询放进组件，这段逻辑就
 * **一点覆盖都没有**。所以这里是一个框架无关的 store + 纯视图派生，`.tsx` 只负责画。
 *
 * ## store 的职责
 *
 * 起会话、按固定间隔问快照、终态时**只通知一次**（让面板刷新环境自检）、取消、卸载时停轮询。
 * 定时器一律走 `globalThis.setInterval` / `clearInterval`，测试才能用假定时器驱动。
 */

/** 客户端问"会话结束了没有"的间隔。与 Host 侧读 dws 增量的 500ms 不是一回事。 */
export const DEVICE_LOGIN_CLIENT_POLL_MS = 1000

export interface DeviceLoginApi {
  dwsLoginDeviceStart(): Promise<DwsDeviceLoginView>
  dwsLoginDeviceStatus(): Promise<DwsDeviceLoginView | null>
  dwsLoginDeviceCancel(): Promise<DwsDeviceLoginView>
}

export interface DeviceLoginStoreOptions {
  api: DeviceLoginApi
  /**
   * 会话落终态时通知一次（面板据此刷新环境自检）。
   *
   * 一次会话最多通知一次 —— 终态会被轮询与迟到响应同时看到，通知两次就是白刷两次环境。
   * `resume()` 发现的是一个**已经结束**的会话时同样会通知：store 无从知道上一次实例刷过没有，
   * 而"授权了但面板还说没通过"比"多刷一次"糟得多（刷新本身是幂等的重新检查）。
   */
  onSettled?: (view: DwsDeviceLoginView) => void
  pollMs?: number
}

export interface DeviceLoginStore {
  get(): DwsDeviceLoginView | null
  subscribe(listener: () => void): () => void
  /** 面板挂载时问一次：切走再切回来要能看到正在跑的那次。 */
  resume(): Promise<void>
  start(): Promise<void>
  cancel(): Promise<void>
  dispose(): void
}

export function createDeviceLoginStore(options: DeviceLoginStoreOptions): DeviceLoginStore {
  const pollMs = options.pollMs ?? DEVICE_LOGIN_CLIENT_POLL_MS
  let current: DwsDeviceLoginView | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  /** 本次会话是否已经通知过终态。 */
  let settled = false
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const publish = (view: DwsDeviceLoginView | null): void => {
    current = view
    notify()
  }
  const stopPolling = (): void => {
    if (timer !== undefined) globalThis.clearInterval(timer)
    timer = undefined
  }
  /** 落终态：停轮询、发布、并且**只**通知一次。 */
  const finish = (view: DwsDeviceLoginView): void => {
    stopPolling()
    publish(view)
    if (settled) return
    settled = true
    options.onSettled?.(view)
  }

  /** 一次请求失败（旧宿主 404 / 传输错误）要变成一条**看得见的结论**，不能只是 unhandled rejection。 */
  const failureView = (cause: unknown): DwsDeviceLoginView => ({
    ...emptyClientView(),
    phase: 'failed',
    error: cause instanceof Error ? cause.message : String(cause),
  })

  /** 客户端侧的空快照（Host 的 `emptyDeviceLoginView` 在 Host 半，不跨边界 import）。 */
  const emptyClientView = (): DwsDeviceLoginView => ({
    phase: 'running', url: '', urlManual: '', userCode: '', tail: '', error: '', advice: '',
    sandboxBlocked: false, deadlineAt: '', opened: false, openError: '',
  })

  const poll = (): void => {
    if (disposed) return
    void (async () => {
      let view: DwsDeviceLoginView | null
      try {
        view = await options.api.dwsLoginDeviceStatus()
      } catch (cause) {
        if (disposed) return
        finish(failureView(cause))
        return
      }
      if (disposed) return
      // 宿主那边会话没了（重启 / 插件卸载）：当作没有登录在进行，**不**通知终态 —— 没有会话可结算。
      if (view === null) {
        stopPolling()
        publish(null)
        return
      }
      if (view.phase === 'running') {
        publish(view)
        return
      }
      finish(view)
    })().catch(() => undefined)
  }

  const beginPolling = (): void => {
    stopPolling()
    timer = globalThis.setInterval(poll, pollMs)
  }

  return {
    get: () => current,

    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async resume() {
      if (disposed) return
      let view: DwsDeviceLoginView | null
      try {
        view = await options.api.dwsLoginDeviceStatus()
      } catch (cause) {
        if (disposed) return
        finish(failureView(cause))
        return
      }
      if (disposed) return
      if (view === null) {
        publish(null)
        return
      }
      if (view.phase === 'running') {
        settled = false
        publish(view)
        beginPolling()
        return
      }
      finish(view)
    },

    async start() {
      if (disposed) return
      settled = false
      let view: DwsDeviceLoginView
      try {
        view = await options.api.dwsLoginDeviceStart()
      } catch (cause) {
        if (disposed) return
        finish(failureView(cause))
        return
      }
      if (disposed) return
      if (view.phase === 'running') {
        publish(view)
        beginPolling()
        return
      }
      // 起进程就失败（例如 `.dws` 锁被占）：立刻让面板看到结论，不要转圈等到超时。
      finish(view)
    },

    async cancel() {
      if (disposed) return
      stopPolling()
      let view: DwsDeviceLoginView
      try {
        view = await options.api.dwsLoginDeviceCancel()
      } catch (cause) {
        if (disposed) return
        // 取消请求本身失败也不能把卡片永远卡在"等待中"。
        publish(failureView(cause))
        return
      }
      if (disposed) return
      // 员工主动取消：环境没变，**不**触发 onSettled；标记已结算，免得取消后又被轮询通知一次。
      settled = true
      publish(view)
    },

    dispose() {
      disposed = true
      stopPolling()
      listeners.clear()
    },
  }
}

/** 卡片要看的东西：**事实**，不含文案（文案在 `.tsx` 里按 `zhCN` 取）。 */
export interface DeviceLoginCardView {
  /** `cancelled` 归一成 `idle`：一次主动取消不该被显示成"失败"。 */
  phase: 'idle' | 'running' | 'ok' | 'failed' | 'timeout'
  code: string
  link: string
  /** 「手动输入授权码」的那条链接；与 `link` 相同或缺失时是空串（不必说两遍）。 */
  linkManual: string
  /** Host 打开授权页失败了（面板据此说一句，免得员工以为"点了没反应"）。 */
  openFailed: boolean
  /**
   * 有一颗**别的**登录（loopback）正在跑，所以那颗按钮要变成「改用设备流登录」。
   *
   * 为什么不能只是禁用：loopback 最长等 5 分钟，两条路又抢同一把 `.dws` 锁 —— 禁用了就等于
   * 让员工点了「登录钉钉」之后没有任何出路（2026-10-13 用户实测）。
   */
  canSwitch: boolean
  /** 剩余时间（`4:37`）；非等待中是空串。 */
  remaining: string
  /** 失败详情：人话 + 下一步动作 + dws 原文，按这个顺序拼。 */
  detail: string
  canStart: boolean
  canCancel: boolean
  canRetry: boolean
  canOpen: boolean
}

export function deviceLoginCardView(
  view: DwsDeviceLoginView | null,
  options: { now: number; busy: boolean },
): DeviceLoginCardView {
  const phase = view === null || view.phase === 'cancelled' ? 'idle' : view.phase
  const running = phase === 'running'
  const link = view?.url ?? ''
  const failed = phase === 'failed' || phase === 'timeout'
  const openFailed = running && view !== null && !view.opened && view.openError !== ''
  return {
    phase,
    code: view?.userCode ?? '',
    link,
    linkManual: view !== null && view.urlManual !== '' && view.urlManual !== link ? view.urlManual : '',
    openFailed,
    // 直接起（canStart）与"先取消再起"（canSwitch）互斥：正在跑的时候只能走后者。
    canSwitch: phase === 'idle' && options.busy,
    remaining: running && view !== null ? formatRemaining(view.deadlineAt, options.now) : '',
    detail: failed && view !== null
      ? [view.error, view.advice, view.tail].filter((part) => part !== '').join('\n')
      : (openFailed && view !== null ? view.openError : ''),
    // 等待中不许再起一条（两个 dws 会抢同一把 `.dws` 锁）；`busy`（loopback 在跑）时也不能**直接**起，
    // 那条路要给员工留的是「改用设备流登录」（见 `canSwitch`）。
    canStart: !running && !options.busy,
    canCancel: running,
    canRetry: failed,
    canOpen: link !== '',
  }
}

/**
 * 登录命令回来之后，要不要把授权链接摆给员工手动打开。
 *
 * 为什么要这一条：Host 侧用的是系统 `open`，而它**退出 0 不等于页面真的出现了** ——
 * 现场就是别人的无头浏览器实例把 URL 吞掉、地址栏一片空白，命令却"成功"了。
 * 所以只要没能确认打开、并且手里有链接，就把链接给出来（`loginMessage` 是等宽可复制的文本）。
 */
export function loginManualOpenLines(result: { opened?: boolean; url?: string }): string[] {
  const url = result.url ?? ''
  if (result.opened !== false || url === '') return []
  return [zhCN.envLoginOpenFailedHint, url]
}

/** `mm:ss` 倒计时；过期回 `0:00`，拿不到截止时间回空串。 */
export function formatRemaining(deadlineAt: string, now: number): string {
  const deadline = Date.parse(deadlineAt)
  if (!Number.isFinite(deadline)) return ''
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}
