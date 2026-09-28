/**
 * 实例级更新 Store：Client 侧唯一的更新状态事实源。
 *
 * 为什么要一个 store 而不是让组件各自请求：侧栏徽标与更新面板是**两个消费者**，
 * 各拉一次就会出现「徽标说有一更新、面板说已是最新」这种自相矛盾（协议 15 那次环境页
 * 就是同一个坑）。所以：
 * - 每个 Client 插件实例**一份**（`createUpdateStore`，没有模块级单例）；
 * - 初始化只有一条链（两个消费者共享同一个 Promise）；
 * - 每个动作各自单飞（检查 / 安装 / 取消 / 状态刷新），重复点击不会多打上游；
 * - Host 的 JSON 只在 `parseUpdateResponse()` 收窄之后才进快照（见 `api.ts`）。
 *
 * 这里**不碰 UI**：没有 React、没有 localStorage、没有 Node 模块；时间只用于轮询间隔，
 * 由注入的 scheduler 决定，单测不做真实等待。
 */
import { parseUpdateResponse, type UpdateApi } from './api.ts'
import type { UpdateCheckState, UpdateInstallState } from '../../../shared/update/types.ts'

/** 客户端侧失败的来源：后台（自动初始化 / 轮询）还是用户手动操作。 */
export type UpdateErrorOrigin = 'background' | 'manual'

/**
 * 客户端侧失败的**稳定 code**。
 *
 * 刻意不含 Host 的错误文本：不可信字符串一律不进 UI 状态（`rejected` 只说明"Host 拒绝了这次
 * 调用"，具体文案由界面按本地 code 说）。
 */
export type UpdateFailureCode =
  | 'transport'
  | 'malformed-envelope'
  | 'malformed-check'
  | 'malformed-install'
  | 'rejected'

export interface UpdateStoreError {
  origin: UpdateErrorOrigin
  code: UpdateFailureCode
}

/** 当前正在进行的动作（互斥的单一状态，不给组件拼布尔组合的机会）。 */
export type UpdateBusy = 'idle' | 'checking' | 'installing' | 'cancelling'

export interface UpdateSnapshot {
  /** 初始化是否完成（两个消费者只跑一条链）。 */
  initialized: boolean
  /** 最近一次**有效**的检查结论；`null` = 还没有过（不认识的响应不会覆盖它）。 */
  check: UpdateCheckState | null
  /** 最近一次**有效**的安装结论。 */
  install: UpdateInstallState | null
  /** 最近一次检查是谁触发的（决定"手动检查失败"要不要露出来）。 */
  checkOrigin: UpdateErrorOrigin | null
  busy: UpdateBusy
  /** 最近一次客户端侧失败；成功的手动操作会清掉手动的那条。 */
  error: UpdateStoreError | null
}

/** 可注入的调度器：单测用它决定"什么时候到点"，不做真实等待。 */
export interface UpdateScheduler {
  schedule: (callback: () => void, delayMs: number) => () => void
}

export interface UpdateStoreDeps {
  api: UpdateApi
  scheduler?: UpdateScheduler
  /** 安装期间的状态轮询间隔（毫秒）。 */
  pollIntervalMs?: number
}

export interface UpdateStore {
  get(): UpdateSnapshot
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void
  /** 启动时调用：先 `update-status`；若状态还没定论就接续一次后台检查。幂等。 */
  initialize(): Promise<UpdateSnapshot>
  /** 用户手动「检查更新」（Host 侧 force）。 */
  check(): Promise<UpdateSnapshot>
  /** 安装 Host 已授权的候选（不传任何参数）。 */
  install(): Promise<UpdateSnapshot>
  /** 取消当前安装（可在安装请求尚未结束时调用）。 */
  cancel(): Promise<UpdateSnapshot>
  /** 主动刷新一次状态（后台来源，不触发检查）。 */
  refreshStatus(): Promise<UpdateSnapshot>
  dispose(): void
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const TERMINAL_INSTALL_STATUSES: readonly string[] = ['awaiting-restart', 'updated', 'cancelled', 'failed']

function defaultScheduler(): UpdateScheduler {
  return {
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs)
      return () => {
        clearTimeout(timer)
      }
    },
  }
}

/** 值比较：收窄时重建的对象键序稳定，所以序列化比较可靠（用于"没变就不通知"）。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function isTerminalInstall(state: UpdateInstallState): boolean {
  return TERMINAL_INSTALL_STATUSES.includes(state.status)
}

export function createUpdateStore(deps: UpdateStoreDeps): UpdateStore {
  const scheduler = deps.scheduler ?? defaultScheduler()
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>()

  let snapshot: UpdateSnapshot = {
    initialized: false,
    check: null,
    install: null,
    checkOrigin: null,
    busy: 'idle',
    error: null,
  }
  let disposed = false
  let initializing: Promise<UpdateSnapshot> | null = null
  let checkInflight: Promise<UpdateSnapshot> | null = null
  let installInflight: Promise<UpdateSnapshot> | null = null
  let cancelInflight: Promise<UpdateSnapshot> | null = null
  let statusInflight: Promise<UpdateSnapshot> | null = null
  let pollCancel: (() => void) | null = null
  /** 安装请求落定或看到终态之后，状态轮询不得再把 `installing` 塞回来（防倒退）。 */
  let acceptInstalling = true

  function get(): UpdateSnapshot {
    return snapshot
  }

  function subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function update(patch: Partial<UpdateSnapshot>): UpdateSnapshot {
    if (disposed) return snapshot
    let changed = false
    for (const key of Object.keys(patch) as Array<keyof UpdateSnapshot>) {
      if (!sameValue(snapshot[key], patch[key])) {
        changed = true
        break
      }
    }
    if (!changed) return snapshot
    // 先提交状态、再通知：订阅者抛错也不能让 Store 停在一个自相矛盾的状态上。
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        // 订阅者（UI）自己的渲染错误由它自己负责；这里忽略是为了不让一个组件把状态机带崩。
        void error
      }
    }
    return snapshot
  }

  /**
   * 是否接受这份安装状态。
   *
   * @param next - 收窄后的安装状态。
   * @returns 接受为 true。
   */
  function acceptsInstall(next: UpdateInstallState): boolean {
    if (next.status !== 'installing') return true
    // 晚到的旧响应：安装已经落定之后不许倒退回"正在安装"。
    if (!acceptInstalling) return false
    const current = snapshot.install
    if (current !== null && current.status === 'installing' && next.startedAt < current.startedAt) return false
    return true
  }

  function applyEnvelope(raw: unknown, origin: UpdateErrorOrigin, options: { setCheckOrigin: boolean }): void {
    const parsed = parseUpdateResponse(raw)
    if (parsed.kind === 'rejected') {
      update({ error: { origin, code: 'rejected' } })
      return
    }
    if (parsed.kind === 'malformed') {
      update({ error: { origin, code: 'malformed-envelope' } })
      return
    }

    const patch: Partial<UpdateSnapshot> = {}
    if (parsed.check !== null) {
      patch.check = parsed.check
      // 只有"真正发起了检查"的那条路径才改来源；状态刷新不得把手动错误降级成后台错误。
      if (options.setCheckOrigin || snapshot.checkOrigin === null) patch.checkOrigin = origin
    }
    if (parsed.install !== null && acceptsInstall(parsed.install)) {
      if (isTerminalInstall(parsed.install)) acceptInstalling = false
      patch.install = parsed.install
    }

    const failure: UpdateFailureCode | null = parsed.invalid.includes('check')
      ? 'malformed-check'
      : parsed.invalid.includes('install')
        ? 'malformed-install'
        : null
    if (failure !== null) {
      patch.error = { origin, code: failure }
    } else if (origin === 'manual' && (snapshot.error === null || snapshot.error.origin === 'manual')) {
      // 手动操作成功就清掉旧的手动错误（后台错误留给它自己的重试去清）。
      patch.error = null
    }
    update(patch)
  }

  /** 一次状态刷新：同一时刻最多一个在飞（轮询与手动刷新共用这条闸门）。 */
  async function statusOnce(origin: UpdateErrorOrigin): Promise<UpdateSnapshot> {
    if (statusInflight !== null) return statusInflight
    const run = (async (): Promise<UpdateSnapshot> => {
      try {
        applyEnvelope(await deps.api.updateStatus(), origin, { setCheckOrigin: snapshot.checkOrigin === null })
      } catch (error) {
        // 传输失败只记 code；保留最后一次有效状态（不清空候选、不清空等待重启）。
        void error
        update({ error: { origin, code: 'transport' } })
      }
      return snapshot
    })()
    statusInflight = run
    try {
      return await run
    } finally {
      statusInflight = null
    }
  }

  /** 一次检查：手动与后台共用单飞闸门（两个消费者同时点也只发一次）。 */
  function startCheck(origin: UpdateErrorOrigin): Promise<UpdateSnapshot> {
    if (checkInflight !== null) return checkInflight
    const run = (async (): Promise<UpdateSnapshot> => {
      update({ busy: 'checking' })
      try {
        applyEnvelope(await deps.api.updateCheck(), origin, { setCheckOrigin: true })
      } catch (error) {
        void error
        update({ error: { origin, code: 'transport' } })
      } finally {
        checkInflight = null
        if (snapshot.busy === 'checking') update({ busy: 'idle' })
      }
      return snapshot
    })()
    checkInflight = run
    return run
  }

  function pollingWanted(): boolean {
    return !disposed && (snapshot.busy === 'installing' || snapshot.busy === 'cancelling')
  }

  function stopPolling(): void {
    const cancel = pollCancel
    pollCancel = null
    if (cancel !== null) cancel()
  }

  function startPolling(): void {
    if (!pollingWanted() || pollCancel !== null) return
    pollCancel = scheduler.schedule(() => {
      pollCancel = null
      void pollTick()
    }, pollIntervalMs)
  }

  async function pollTick(): Promise<void> {
    if (!pollingWanted()) return
    await statusOnce('background')
    // 上一轮回来之后再排下一轮：同一时刻最多一个 status 请求。
    startPolling()
  }

  function stopPollingWhenSettled(): void {
    if (!pollingWanted()) stopPolling()
  }

  return {
    get,
    subscribe,

    initialize(): Promise<UpdateSnapshot> {
      // 两个消费者并发调用共享同一条链；完成后不再重复请求。
      if (snapshot.initialized) return Promise.resolve(snapshot)
      if (initializing !== null) return initializing
      const run = (async (): Promise<UpdateSnapshot> => {
        try {
          await statusOnce('background')
          const check = snapshot.check
          const settled = check !== null && check.status !== 'idle' && check.status !== 'checking'
          // 状态还没定论就接续一次后台检查：Host 那边是单飞，会与它自己的启动检查合流。
          if (!settled && !disposed) await startCheck('background')
        } catch (error) {
          // 内部两条路径各自收敛了；这里兜底，绝不让初始化 Promise 抛出。
          void error
        } finally {
          initializing = null
          update({ initialized: true })
        }
        return snapshot
      })()
      initializing = run
      return run
    },

    check(): Promise<UpdateSnapshot> {
      return startCheck('manual')
    },

    install(): Promise<UpdateSnapshot> {
      if (installInflight !== null) return installInflight
      const run = (async (): Promise<UpdateSnapshot> => {
        acceptInstalling = true
        update({ busy: 'installing' })
        startPolling()
        try {
          // 永远不发参数：安装目标由 Host 自己授权。
          applyEnvelope(await deps.api.updateInstall(), 'manual', { setCheckOrigin: false })
        } catch (error) {
          void error
          update({ error: { origin: 'manual', code: 'transport' } })
        } finally {
          installInflight = null
          if (snapshot.busy === 'installing') update({ busy: cancelInflight === null ? 'idle' : 'cancelling' })
          stopPollingWhenSettled()
        }
        return snapshot
      })()
      installInflight = run
      return run
    },

    cancel(): Promise<UpdateSnapshot> {
      if (cancelInflight !== null) return cancelInflight
      const run = (async (): Promise<UpdateSnapshot> => {
        // 取消不被安装单飞锁挡住：它走自己的闸门，安装请求还在飞也能立刻发出去。
        update({ busy: 'cancelling' })
        startPolling()
        try {
          applyEnvelope(await deps.api.updateCancel(), 'manual', { setCheckOrigin: false })
        } catch (error) {
          void error
          update({ error: { origin: 'manual', code: 'transport' } })
        } finally {
          cancelInflight = null
          if (snapshot.busy === 'cancelling') update({ busy: installInflight === null ? 'idle' : 'installing' })
          stopPollingWhenSettled()
        }
        return snapshot
      })()
      cancelInflight = run
      return run
    },

    refreshStatus(): Promise<UpdateSnapshot> {
      return statusOnce('background')
    },

    dispose(): void {
      disposed = true
      stopPolling()
      listeners.clear()
    },
  }
}
