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
 * ## 2026-09-28 审查修正：三条硬约束
 *
 * 1. **操作状态互不覆盖**：`checking` / `installing` / `cancelling` 是三个独立布尔，不再是
 *    "一个 busy 枚举"。安装请求在飞时点「检查更新」，`check()` 只动 `checking`，安装活动与
 *    取消入口不会被冲掉；`installing` 只由那次安装请求自己清。界面上的"正在安装" = 本地在飞
 *    **或** Host 事实说 `installing` —— 后者正是刷新页面后的恢复路径。
 * 2. **轮询由 Host 事实驱动**：`shouldPoll()` 只看 `install.status` 与"本次事务是否在飞"，
 *    与检查无关；Host 一落定（awaiting-restart / updated / cancelled / failed）就停。
 * 3. **过期响应按世代作废**：每次 `install()` 开一个新世代，每个响应带着"发出时捕获的世代"
 *    回来；旧世代的响应、以及本世代落定之后的观察类响应，一律不许再改安装状态 ——
 *    覆盖全部 `install.status` 取值，而不只是 `installing`。
 *
 * 这里**不碰 UI**：没有 React、没有 localStorage、没有 Node 模块；时间只用于轮询间隔，
 * 由注入的 scheduler 决定，单测不做真实等待。
 */
import { parseUpdateResponse, type UpdateApi } from './api.ts'
import type { UpdateCheckState, UpdateInstallState } from '../../../shared/update/types.ts'

/** 客户端侧失败的来源：后台（自动初始化 / 轮询）还是用户手动操作。 */
export type UpdateErrorOrigin = 'background' | 'manual'

/**
 * 失败的**动作归属**。
 *
 * 只有 `origin` 不够：检查失败与安装失败都是 manual，界面却说两句不同的话；状态轮询失败
 * （poll）与用户点开的刷新（status）语义也不同。所以错误必须带上动作。
 */
export type UpdateAction = 'check' | 'install' | 'cancel' | 'status' | 'poll'

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
  action: UpdateAction
  origin: UpdateErrorOrigin
  code: UpdateFailureCode
}

export interface UpdateSnapshot {
  /** 初始化是否完成（两个消费者只跑一条链）。 */
  initialized: boolean
  /** 最近一次**有效**的检查结论；`null` = 还没有过（不认识的响应不会覆盖它）。 */
  check: UpdateCheckState | null
  /** 最近一次**有效**的安装结论。 */
  install: UpdateInstallState | null
  /** 最近一次检查是谁触发的（决定"手动检查失败"要不要露出来）。 */
  checkOrigin: UpdateErrorOrigin | null
  /** 检查请求在飞。**与安装活动互不覆盖**。 */
  checking: boolean
  /** 安装请求在飞（本地事实；Host 事实还要看 `install.status`）。 */
  installing: boolean
  /** 取消请求在飞。 */
  cancelling: boolean
  /** 最近一次客户端侧失败；成功的**同一个动作**会清掉它自己的旧错误。 */
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
    checking: false,
    installing: false,
    cancelling: false,
    error: null,
  }
  let disposed = false
  let initializing: Promise<UpdateSnapshot> | null = null
  let checkInflight: Promise<UpdateSnapshot> | null = null
  let installInflight: Promise<UpdateSnapshot> | null = null
  let cancelInflight: Promise<UpdateSnapshot> | null = null
  let statusInflight: Promise<boolean> | null = null
  let pollCancel: (() => void) | null = null

  // ── 世代（安装事务）────────────────────────────────────────────────────────
  /** 安装事务世代：每次 `install()` 开一个新世代。 */
  let epoch = 1
  /** 已经写入过安装状态的最高世代。 */
  let writtenEpoch = 0
  /** 已经落定（终态）的世代；-1 = 当前世代还没落定。 */
  let settledEpoch = -1
  /** 检查 / 取消请求的序号：旧请求的 finally 不许清掉新请求的活动状态。 */
  let checkSeq = 0
  let cancelSeq = 0

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

  /** 一次安装状态写入的来路。 */
  interface InstallWrite {
    /** 这个响应发出时捕获的事务世代。 */
    epoch: number
    /** install / cancel 的响应是本次事务的权威结论；status / poll 只是观察。 */
    authoritative: boolean
    /**
     * 这份安装快照只是**顺带**带回来的（检查响应里那一份），不是我们特意去观察的。
     *
     * 检查请求完全可能在安装开始之前发出，它的 `install` 字段就是过期的；若允许它写，
     * 界面会在"正在安装"和"没有更新"之间来回跳，而且会清掉安装活动与取消入口。
     */
    incidental: boolean
  }

  /**
   * 这份安装状态是否还有资格写进快照（过期响应保护）。
   *
   * @param next - 收窄后的安装状态。
   * @param write - 这份状态来自哪个世代、是不是本次事务的权威结论。
   * @returns 可以写入为 true。
   */
  function acceptsInstall(next: UpdateInstallState, write: InstallWrite): boolean {
    // 1) 旧世代的响应：idle / installing / 任何终态都不许写。
    if (write.epoch < writtenEpoch) return false
    if (write.epoch === writtenEpoch) {
      // 2) 本世代已经落定：只有本次事务自己的 install / cancel 响应还有发言权，
      //    晚到的状态轮询（观察类）一律不许再改安装状态。
      if (settledEpoch === writtenEpoch && !write.authoritative) return false
      // 3) 落定之后不许退回非终态。
      if (settledEpoch === writtenEpoch && !isTerminalInstall(next)) return false
    }
    // 4) 检查响应里顺带带回的那份快照：安装正进行时不得用非终态覆盖它
    //    （否则"检查一下"就会把界面从"正在安装"打回"没有更新"）。
    const installActive = snapshot.installing || snapshot.cancelling || hostInstalling()
    if (write.incidental && installActive && !isTerminalInstall(next)) return false
    return true
  }

  function applyInstall(next: UpdateInstallState, write: InstallWrite): void {
    if (!acceptsInstall(next, write)) return
    if (write.epoch > writtenEpoch) {
      writtenEpoch = write.epoch
      settledEpoch = -1
    }
    if (isTerminalInstall(next)) settledEpoch = writtenEpoch
    update({ install: next })
    syncPolling()
  }

  interface EnvelopeOptions {
    action: UpdateAction
    origin: UpdateErrorOrigin
    /** 这次请求发出时捕获的安装事务世代。 */
    epoch: number
    /** install / cancel 的响应是本次事务的权威结论。 */
    authoritative?: boolean
    /** 检查响应顺带带回的安装快照（见 `InstallWrite.incidental`）。 */
    incidentalInstall?: boolean
    /** 只有**真正发起检查**的路径才改 `checkOrigin`（状态刷新不得把 manual 降级成 background）。 */
    setCheckOrigin?: boolean
  }

  function applyEnvelope(raw: unknown, options: EnvelopeOptions): void {
    const parsed = parseUpdateResponse(raw)
    const { action, origin } = options
    if (parsed.kind === 'rejected') {
      update({ error: { action, origin, code: 'rejected' } })
      return
    }
    if (parsed.kind === 'malformed') {
      update({ error: { action, origin, code: 'malformed-envelope' } })
      return
    }

    if (parsed.check !== null) {
      const patch: Partial<UpdateSnapshot> = { check: parsed.check }
      if (options.setCheckOrigin === true || snapshot.checkOrigin === null) patch.checkOrigin = origin
      update(patch)
    }
    if (parsed.install !== null) {
      applyInstall(parsed.install, {
        epoch: options.epoch,
        authoritative: options.authoritative === true,
        incidental: options.incidentalInstall === true,
      })
    }

    const failure: UpdateFailureCode | null = parsed.invalid.includes('check')
      ? 'malformed-check'
      : parsed.invalid.includes('install')
        ? 'malformed-install'
        : null
    if (failure !== null) {
      update({ error: { action, origin, code: failure } })
    } else if (
      origin === 'manual' &&
      snapshot.error !== null &&
      snapshot.error.origin === 'manual' &&
      snapshot.error.action === action
    ) {
      // 手动操作成功就清掉它**自己**的旧错误；别的动作的错误（例如安装失败）留着继续显示。
      update({ error: null })
    }
  }

  /** 一次状态取数；返回是否真的拿到了 Host 事实（安装 / 取消失败后要用它决定怎么说话）。 */
  async function fetchStatus(action: 'status' | 'poll'): Promise<boolean> {
    if (statusInflight !== null) return statusInflight
    const at = epoch
    const run = (async (): Promise<boolean> => {
      try {
        applyEnvelope(await deps.api.updateStatus(), {
          action,
          origin: 'background',
          epoch: at,
          setCheckOrigin: snapshot.checkOrigin === null,
        })
        return true
      } catch (error) {
        // 传输失败只记 code；保留最后一次有效状态（不清空候选、不清空等待重启）。
        void error
        update({ error: { action, origin: 'background', code: 'transport' } })
        return false
      }
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
    const at = epoch
    const seq = (checkSeq += 1)
    const run = (async (): Promise<UpdateSnapshot> => {
      update({ checking: true })
      try {
        applyEnvelope(await deps.api.updateCheck(), {
          action: 'check',
          origin,
          epoch: at,
          setCheckOrigin: true,
          incidentalInstall: true,
        })
      } catch (error) {
        void error
        update({ error: { action: 'check', origin, code: 'transport' } })
      } finally {
        // 只有最新那次检查才能清掉 checking：旧请求的 finally 不准动新状态。
        if (seq === checkSeq) update({ checking: false })
        checkInflight = null
        syncPolling()
      }
      return snapshot
    })()
    checkInflight = run
    return run
  }

  // ── 轮询：由 Host 事实驱动，不看 check ──────────────────────────────────────
  function hostInstalling(): boolean {
    return snapshot.install !== null && snapshot.install.status === 'installing'
  }

  function hostTerminal(): boolean {
    return snapshot.install !== null && isTerminalInstall(snapshot.install)
  }

  /**
   * 轮询该不该开着。
   *
   * - Host 已落定（awaiting-restart / updated / cancelled / failed）→ 关：没有更多可观察的进展；
   * - 本地有安装 / 取消请求在飞 → 开：Host 可能还没把 `installing` 报出来，而阶段变化只能靠轮询看；
   * - 否则只看 Host 是否在装 —— 刷新页面后恢复安装状态走的就是这条；
   * - Host 说 idle 而本地也没有在飞的事务 → 关。
   *
   * `check()` 完全不参与这个判断，所以它清不掉轮询。
   */
  function shouldPoll(): boolean {
    if (disposed) return false
    if (hostTerminal()) return false
    if (snapshot.installing || snapshot.cancelling) return true
    return hostInstalling()
  }

  function stopPolling(): void {
    const cancel = pollCancel
    pollCancel = null
    if (cancel !== null) cancel()
  }

  function startPolling(): void {
    if (disposed || pollCancel !== null) return
    pollCancel = scheduler.schedule(() => {
      pollCancel = null
      void pollTick()
    }, pollIntervalMs)
  }

  function syncPolling(): void {
    if (shouldPoll()) startPolling()
    else stopPolling()
  }

  async function pollTick(): Promise<void> {
    if (!shouldPoll()) {
      stopPolling()
      return
    }
    await fetchStatus('poll')
    // 上一轮回来之后再排下一轮：同一时刻最多一个 status 请求。
    syncPolling()
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
          // Host 事实优先：装到一半刷新页面时，`install.status === 'installing'` 就是在这里恢复的
          // （applyInstall → syncPolling → 重新开始轮询）。
          await fetchStatus('status')
          syncPolling()
          const check = snapshot.check
          const settled = check !== null && check.status !== 'idle' && check.status !== 'checking'
          // 状态还没定论就接续一次后台检查：Host 那边是单飞，会与它自己的启动检查合流。
          if (!settled && !disposed) await startCheck('background')
        } catch (error) {
          // 内部两条路径各自收敛了；这里兜底，绝不让初始化 Promise 抛出。
          void error
        } finally {
          initializing = null
          syncPolling()
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
      // 新事务：从此之前的观察响应都算旧世代（见 acceptsInstall）。
      epoch += 1
      const at = epoch
      const run = (async (): Promise<UpdateSnapshot> => {
        update({ installing: true })
        syncPolling()
        try {
          // 永远不发参数：安装目标由 Host 自己授权。
          applyEnvelope(await deps.api.updateInstall(), {
            action: 'install',
            origin: 'manual',
            epoch: at,
            authoritative: true,
          })
        } catch (error) {
          void error
          // 传输失败 ≠ Host 没开始安装：立刻取一次事实，绝不凭空把安装判定成 idle 或成功。
          const known = await fetchStatus('status')
          const state = snapshot.install
          const explained =
            known && state !== null && (state.status === 'installing' || isTerminalInstall(state))
          if (!explained) update({ error: { action: 'install', origin: 'manual', code: 'transport' } })
        } finally {
          installInflight = null
          update({ installing: false })
          syncPolling()
        }
        return snapshot
      })()
      installInflight = run
      return run
    },

    cancel(): Promise<UpdateSnapshot> {
      if (cancelInflight !== null) return cancelInflight
      // 取消是**当前事务**的动作，不新开世代：它和这次安装共享同一份"谁先落定"的规则。
      const at = epoch
      const seq = (cancelSeq += 1)
      const run = (async (): Promise<UpdateSnapshot> => {
        update({ cancelling: true })
        syncPolling()
        try {
          applyEnvelope(await deps.api.updateCancel(), {
            action: 'cancel',
            origin: 'manual',
            epoch: at,
            authoritative: true,
          })
        } catch (error) {
          void error
          // 取不到事实就如实说"取消没成功"；取到事实就以 Host 状态为准（可能还在装、也可能已落定）。
          const known = await fetchStatus('status')
          if (!known) update({ error: { action: 'cancel', origin: 'manual', code: 'transport' } })
        } finally {
          if (seq === cancelSeq) update({ cancelling: false })
          cancelInflight = null
          syncPolling()
        }
        return snapshot
      })()
      cancelInflight = run
      return run
    },

    refreshStatus(): Promise<UpdateSnapshot> {
      return fetchStatus('status').then(() => snapshot)
    },

    dispose(): void {
      disposed = true
      stopPolling()
      listeners.clear()
    },
  }
}
