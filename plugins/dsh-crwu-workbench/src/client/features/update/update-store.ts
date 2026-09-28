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
 * ## 2026-09-28 第一轮审查修正
 *
 * 1. **操作状态互不覆盖**：`checking` / `installing` / `cancelling` 三个独立布尔。
 * 2. **轮询由 Host 事实驱动**：`shouldPoll()` 只看 `install.status` 与"本次事务是否在飞"。
 * 3. **过期响应按世代作废**：`install()` 开新世代，响应带着发出时的世代回来。
 *
 * ## 2026-09-28 第二轮审查修正（本节的四条是这一轮的重点）
 *
 * A. **新事务一开，旧世代立刻失效**：比较基准是"当前事务世代"（`activeEpoch`），不是
 *    "已经写入过的最高世代"。旧代码用后者，于是"旧 status 挂住 → 点安装 → 旧 status 返回
 *    failed"会把 failed 写进新事务，还会顺手停掉新事务的轮询。
 * B. **`fetchStatus` 的返回值 = 是否取得当前事务可用的合法 install 事实**，不是"Promise 没
 *    throw"：malformed / rejected / install 字段非法 / 不属于当前世代 都不算事实。
 * C. **status 单飞按世代保存**：旧世代 already-inflight 的 status 不能拿来当当前事实 ——
 *    先等它落定（结果丢弃），再明确发一次当前世代的 status。
 * D. **不确定结果统一处理**：`update-install` / `update-cancel` 即使没有 throw，只要信封
 *    不认识 / 被拒 / install 字段非法 / 不被当前世代接受，都要补一次 status 取事实，
 *    再决定是"确实在推进"还是"这次动作没生效/取不到事实"。
 *
 * ## 2026-09-28 第三轮审查修正
 *
 * E. **快照里的安装状态带出"它属于哪个事务"**（`installCurrent`）：上一事务的 failed / cancelled
 *    不能挡住新事务的轮询（`shouldPoll()` 只看当前事务是否落定、当前事务是否在装），
 *    也不能在重试期间继续当作"当前 Host 事实"显示安装失败。
 * F. **事务内再加一层 revision**：光靠世代分不出同一事务里"谁更新" —— 两者世代相同。
 *    每次写入安装状态都递增 `installRevision`，每个请求把**发出时**的 revision 带回来；
 *    返回时若 `installRevision` 已经更大，就说明期间有更新的状态被接受，这份观察作废
 *    （终态之前发出的旧观察、以及更新的 update-install 之后回来的旧 poll，都走这一条）。
 *
 * ## 2026-09-28 第四轮审查修正
 *
 * G. **revision 保护所有观察响应，不只终态之后**：`write.revision < installRevision` 的
 *    非权威响应一律拒绝 —— 否则"update-install 先写 installing、较早发出的 poll 后返回 idle"
 *    会把状态打回 idle 并把轮询停掉。终态之后只额外多一条"只允许确认完全相同的终态"。
 *    当前 revision 的观察照常推进（connecting → downloading → installing 不受影响）。
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
  /** 请求本身失败：网络 / HTTP 非 2xx。 */
  | 'transport'
  /** 响应不是认识的信封（不是对象、ok 不是布尔、拒绝信封缺 error 文本）。 */
  | 'malformed-envelope'
  /** 响应里的 check 状态不认识（保留旧值）。 */
  | 'malformed-check'
  /** 响应里的 install 状态不认识 / 缺失。 */
  | 'malformed-install'
  /** Host 的边界拒绝信封（ok: false）。 */
  | 'rejected'
  /** 响应合法，但属于更早的安装事务，不能代表现在。 */
  | 'stale'
  /** 拿到了事实，但事实说这次动作没有生效（例如安装之后 Host 仍是 idle）。 */
  | 'no-effect'

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
  /** 最近一次**有效**的安装结论（可能是**上一事务**留下的历史状态，见 `installCurrent`）。 */
  install: UpdateInstallState | null
  /**
   * 这份 `install` 是不是**当前事务**的结论。
   *
   * `false` = 它属于上一事务（例如上一次安装的 failed / cancelled 还留在快照里），
   * 界面不得把它当成"现在正在发生的事"（但 `awaiting-restart` 例外，见 View Model）。
   */
  installCurrent: boolean
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

/**
 * `applyEnvelope()` 的结构化结果。
 *
 * 为什么不是 `void`：调用方必须能区分"响应回来了"和"拿到了可用的事实"。安装 / 取消正好
 * 依赖这个区分决定要不要补一次 `update-status`。
 */
interface UpdateEnvelopeOutcome {
  /** 信封被认识（ok:true，或 ok:false + 字符串 error）。 */
  envelopeValid: boolean
  /** Host 的边界拒绝信封（ok: false）。 */
  rejected: boolean
  /** check 字段通过运行时收窄。 */
  checkValid: boolean
  /** install 字段通过运行时收窄。 */
  installValid: boolean
  /** install 状态被**当前事务**接受（世代 + 落定规则）。 */
  installAccepted: boolean
  /** 这一份响应可以当作"当前事务可用的 Host 安装事实"。 */
  isCurrentFact: boolean
}

/** 一次状态取数的结果。 */
interface StatusResult {
  /** 是否取得了当前事务可用的合法 install 事实。 */
  fact: boolean
  /** 没取到时为什么（`stale` = 合法但不属于当前事务；`fact` 为 true 时是 null）。 */
  code: UpdateFailureCode | null
}

export function createUpdateStore(deps: UpdateStoreDeps): UpdateStore {
  const scheduler = deps.scheduler ?? defaultScheduler()
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>()

  let snapshot: UpdateSnapshot = {
    initialized: false,
    check: null,
    install: null,
    installCurrent: false,
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
  /** 状态取数与它所属的世代一起保存：旧世代的在飞请求不能拿来当当前事实。 */
  let statusInflight: { epoch: number; promise: Promise<StatusResult> } | null = null
  let pollCancel: (() => void) | null = null

  // ── 安装事务世代 + 事务内 revision ─────────────────────────────────────────
  /**
   * **当前**安装事务世代。`install()` 一开新事务就 +1 —— 那一刻起，所有带着更早世代回来的
   * 响应立刻失效（不是"等新事务写入第一条状态之后"）。
   */
  let activeEpoch = 1
  /** `snapshot.install` 属于哪个世代（0 = 还没有过）。不等于 `activeEpoch` 就是"历史状态"。 */
  let installEpoch = 0
  /** 哪个世代已经落定（写过终态）；值等于 `activeEpoch` 表示"当前事务已经是终态"。 */
  let settledEpoch = -1
  /**
   * 安装状态的**写入序号**：每接受一次安装状态 +1（事务内也递增）。
   *
   * 请求发出时捕获它，返回时再比一次：`write.revision < installRevision` 就是"这份观察发出之后
   * 已经有更新的状态被接受了" —— 过期观察，任何结论（含任意终态）都不许覆盖当前状态。
   */
  let installRevision = 0
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

  /** 记一条客户端侧失败。 */
  function recordError(next: UpdateStoreError): void {
    const current = snapshot.error
    // 后台失败（初始化 / 轮询 / 刷新）不得顶掉用户手动操作留下的错误：
    // 用户刚点了安装或取消，那句结论必须留在界面上（他自己会再点一次）。
    if (next.origin === 'background' && current !== null && current.origin === 'manual') return
    update({ error: next })
  }

  /** 清掉某个手动动作留下的错误（事实证明这次动作确实生效了）。 */
  function clearManualError(action: UpdateAction): void {
    const current = snapshot.error
    if (current !== null && current.origin === 'manual' && current.action === action) update({ error: null })
  }

  /** 一次安装状态写入的来路。 */
  interface InstallWrite {
    /** 这个响应发出时捕获的事务世代。 */
    epoch: number
    /**
     * 这个请求**发出时**的安装状态写入序号。
     *
     * 与 `epoch` 配合区分同世代内的新旧：`revision < installRevision` = 这份观察发出之后已经有
     * 更新的状态被接受 → 过期观察，必须拒绝；`revision === installRevision` = 最新的观察，
     * 可以推进状态（落定时只允许确认完全相同的终态）。
     */
    revision: number
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
   * 判定顺序：
   * 1. `write.epoch !== activeEpoch` → 拒（跨事务的旧响应全部失效）；
   * 2. 非权威且 `write.revision < installRevision` → 拒（**过期观察**：期间已有更新的状态被接受）；
   * 3. 当前事务已落定 → 非权威的只允许确认完全相同的终态，且任何响应都不许退回非终态；
   * 4. 检查响应顺带带回的快照，安装进行时不得用非终态覆盖。
   *
   * @param next - 收窄后的安装状态。
   * @param write - 这份状态来自哪个世代、哪个 revision、是不是本次事务的权威结论。
   * @returns 可以写入为 true。
   */
  function acceptsInstall(next: UpdateInstallState, write: InstallWrite): boolean {
    // 1) 不是**当前**事务的响应：立刻失效。idle / installing / 任何终态都不许写 ——
    //    这是第二轮审查修掉的洞：新事务刚开、还没写入任何状态时，旧响应也不能钻进来。
    if (write.epoch !== activeEpoch) return false
    // 2) **过期观察**（对全部非权威响应生效，不只终态之后）：这份响应发出之后，已经有更新的
    //    安装状态被接受 —— 它带回来的任何结论（idle / installing / 旧阶段 / failed / cancelled /
    //    awaiting-restart / updated）都不许覆盖当前状态，也不许影响轮询。
    if (!write.authoritative && write.revision < installRevision) return false
    if (settledEpoch === activeEpoch) {
      // 3) 当前事务已经落定：终态之后新发出的观察只允许**确认完全相同的终态**
      //    （Host 再次确认 awaiting-restart 时算当前事实，但不许改写终态，也不许换成别的终态）。
      if (!write.authoritative && !sameValue(next, snapshot.install)) return false
      // 4) 落定之后不许退回非终态（权威响应同样受这条约束）。
      if (!isTerminalInstall(next)) return false
    }
    // 4) 检查响应里顺带带回的那份快照：安装正进行时不得用非终态覆盖它
    //    （否则"检查一下"就会把界面从"正在安装"打回"没有更新"）。
    const installActive = snapshot.installing || snapshot.cancelling || currentTransactionInstalling()
    if (write.incidental && installActive && !isTerminalInstall(next)) return false
    return true
  }

  /** 写入安装状态；返回是否真的被接受。 */
  function applyInstall(next: UpdateInstallState, write: InstallWrite): boolean {
    if (!acceptsInstall(next, write)) return false
    installRevision += 1
    installEpoch = activeEpoch
    if (isTerminalInstall(next)) settledEpoch = activeEpoch
    update({ install: next, installCurrent: currentInstallIsVisible() })
    syncPolling()
    return true
  }

  interface EnvelopeOptions {
    action: UpdateAction
    origin: UpdateErrorOrigin
    /** 这次请求发出时捕获的安装事务世代。 */
    epoch: number
    /** 这次请求发出时的安装状态写入序号（见 `InstallWrite.revision`）。 */
    revision: number
    /** install / cancel 的响应是本次事务的权威结论。 */
    authoritative?: boolean
    /** 检查响应顺带带回的安装快照（见 `InstallWrite.incidental`）。 */
    incidentalInstall?: boolean
    /** 只有**真正发起检查**的路径才改 `checkOrigin`（状态刷新不得把 manual 降级成 background）。 */
    setCheckOrigin?: boolean
  }

  function applyEnvelope(raw: unknown, options: EnvelopeOptions): UpdateEnvelopeOutcome {
    const parsed = parseUpdateResponse(raw)
    const { action, origin } = options
    const empty: UpdateEnvelopeOutcome = {
      envelopeValid: false,
      rejected: false,
      checkValid: false,
      installValid: false,
      installAccepted: false,
      isCurrentFact: false,
    }
    if (parsed.kind === 'rejected') {
      recordError({ action, origin, code: 'rejected' })
      return { ...empty, envelopeValid: true, rejected: true }
    }
    if (parsed.kind === 'malformed') {
      recordError({ action, origin, code: 'malformed-envelope' })
      return empty
    }

    if (parsed.check !== null) {
      const patch: Partial<UpdateSnapshot> = { check: parsed.check }
      if (options.setCheckOrigin === true || snapshot.checkOrigin === null) patch.checkOrigin = origin
      update(patch)
    }
    const installAccepted =
      parsed.install === null
        ? false
        : applyInstall(parsed.install, {
            epoch: options.epoch,
            revision: options.revision,
            authoritative: options.authoritative === true,
            incidental: options.incidentalInstall === true,
          })

    const failure: UpdateFailureCode | null = parsed.invalid.includes('check')
      ? 'malformed-check'
      : parsed.invalid.includes('install')
        ? 'malformed-install'
        : null
    if (failure !== null) {
      recordError({ action, origin, code: failure })
    } else if (
      origin === 'manual' &&
      snapshot.error !== null &&
      snapshot.error.origin === 'manual' &&
      snapshot.error.action === action
    ) {
      // 手动操作成功就清掉它**自己**的旧错误；别的动作的错误（例如安装失败）留着继续显示。
      update({ error: null })
    }

    return {
      envelopeValid: true,
      rejected: false,
      checkValid: parsed.check !== null,
      installValid: parsed.install !== null,
      installAccepted,
      isCurrentFact: parsed.install !== null && installAccepted,
    }
  }

  /** 为什么这次 status 响应不能当作当前事务的事实。 */
  function statusFailureCodeOf(outcome: UpdateEnvelopeOutcome): UpdateFailureCode {
    if (!outcome.envelopeValid) return 'malformed-envelope'
    if (outcome.rejected) return 'rejected'
    if (!outcome.installValid) return 'malformed-install'
    return 'stale'
  }

  /**
   * 取一次状态，并回答"**是否取得了当前事务可用的合法 install 事实**"。
   *
   * 与 `updateStatus()` 的成功/失败不是一回事：信封不认识、被拒绝、install 字段非法、
   * 或者响应属于更早的事务，都不算事实。
   *
   * @param action - 这次取数是谁发起的（`status` 主动刷新 / `poll` 安装期间的轮询）。
   * @returns 事实与"没取到时为什么"。
   */
  async function fetchStatus(action: 'status' | 'poll'): Promise<StatusResult> {
    for (;;) {
      const inflight = statusInflight
      if (inflight !== null && inflight.epoch === activeEpoch) return inflight.promise
      if (inflight !== null) {
        // 旧世代的请求还在飞：它的结果对本事务无效，**等它落定再明确发一次当前世代的**。
        // （直接复用旧 Promise 等于拿旧事务的事实做判断 —— 第二轮审查点掉的就是这个。）
        await inflight.promise.catch(() => undefined)
        continue
      }
      const at = activeEpoch
      const revision = installRevision
      const run = (async (): Promise<StatusResult> => {
        let outcome: UpdateEnvelopeOutcome
        try {
          outcome = applyEnvelope(await deps.api.updateStatus(), {
            action,
            origin: 'background',
            epoch: at,
            revision,
            setCheckOrigin: snapshot.checkOrigin === null,
          })
        } catch (error) {
          // 传输失败只记 code；保留最后一次有效状态（不清空候选、不清空等待重启）。
          void error
          recordError({ action, origin: 'background', code: 'transport' })
          return { fact: false, code: 'transport' }
        }
        if (outcome.isCurrentFact) return { fact: true, code: null }
        // 具体原因已经由 `applyEnvelope()` 记过一条错误（malformed / rejected / …），这里只把
        // "没取到事实"及其原因**回答给调用方**，不再重复写状态 —— 重复写会用一个更粗的 code
        // 盖掉更准的那条（同时不认识 check 与 install 时会被记成 malformed-install）。
        // `stale` 是正常现象（新事务已经开跑），也不算错误。
        return { fact: false, code: statusFailureCodeOf(outcome) }
      })()
      statusInflight = { epoch: at, promise: run }
      try {
        return await run
      } finally {
        if (statusInflight !== null && statusInflight.promise === run) statusInflight = null
      }
    }
  }

  /** 一次检查：手动与后台共用单飞闸门（两个消费者同时点也只发一次）。 */
  function startCheck(origin: UpdateErrorOrigin): Promise<UpdateSnapshot> {
    if (checkInflight !== null) return checkInflight
    const at = activeEpoch
    const revision = installRevision
    const seq = (checkSeq += 1)
    const run = (async (): Promise<UpdateSnapshot> => {
      update({ checking: true })
      try {
        applyEnvelope(await deps.api.updateCheck(), {
          action: 'check',
          origin,
          epoch: at,
          revision,
          setCheckOrigin: true,
          incidentalInstall: true,
        })
      } catch (error) {
        void error
        recordError({ action: 'check', origin, code: 'transport' })
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

  // ── 轮询：由**当前事务**的 Host 事实驱动，不看 check ────────────────────────
  /** `snapshot.install` 是不是当前事务的结论。 */
  function currentInstallIsVisible(): boolean {
    return installEpoch === activeEpoch
  }

  /** 当前事务是否已经落定（终态已经写进快照）。 */
  function currentTransactionSettled(): boolean {
    return settledEpoch === activeEpoch
  }

  /** 当前事务的 Host 事实说"正在装"。上一事务留下的 installing 不算。 */
  function currentTransactionInstalling(): boolean {
    return currentInstallIsVisible() && snapshot.install !== null && snapshot.install.status === 'installing'
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
    // 当前事务已经落定 → 没有更多可观察的进展（哪怕 install 请求还没返回）。
    if (currentTransactionSettled()) return false
    // 本地有安装 / 取消请求在飞 → 开。这里刻意放在"当前事务落定"之后：
    // 新事务一开始就算轮询（上一事务的 failed / cancelled 不挡），
    // 但当前事务一旦落定就停 —— 不是让本地在飞永远压过终态。
    if (snapshot.installing || snapshot.cancelling) return true
    // 否则只看**当前事务**的 Host 事实（刷新页面恢复安装状态走这条）。
    return currentTransactionInstalling()
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
      // 新事务：**立刻**作废旧世代响应（比较基准是 activeEpoch，不是"写过的最高世代"）。
      activeEpoch += 1
      // 用户重新开始安装：上一次安装留下的手动错误到此为止（界面不能再挂着旧失败）。
      clearManualError('install')
      const at = activeEpoch
      const revision = installRevision
      const run = (async (): Promise<UpdateSnapshot> => {
        // 上一事务的状态仍然可见，但**不是**当前事务的事实（installCurrent=false）。
        update({ installing: true, installCurrent: currentInstallIsVisible() })
        syncPolling()
        try {
          let outcome: UpdateEnvelopeOutcome | null = null
          try {
            // 永远不发参数：安装目标由 Host 自己授权。
            outcome = applyEnvelope(await deps.api.updateInstall(), {
              action: 'install',
              origin: 'manual',
              epoch: at,
              revision,
              authoritative: true,
            })
          } catch (error) {
            // 传输失败 ≠ Host 没开始安装；下面统一取事实。
            void error
            outcome = null
          }
          if (outcome === null || !outcome.isCurrentFact) {
            // 不确定结果（传输失败 / 信封不认识 / 被拒 / install 字段非法）：立刻取一次事实，
            // 绝不凭空把安装判定成 idle 或成功。
            const status = await fetchStatus('status')
            const state = snapshot.install
            const progressing = state !== null && (state.status === 'installing' || isTerminalInstall(state))
            if (status.fact && progressing) {
              // 事实证明安装确实在推进：不接受"响应没读懂"造成的安装失败。
              clearManualError('install')
            } else if (status.fact) {
              // 拿到了合法事实，但事实说这次安装没有生效（Host 仍是 idle）。
              recordError({ action: 'install', origin: 'manual', code: 'no-effect' })
            } else {
              // 取不到可用事实：如实报安装失败（fail closed），绝不假装没发生。
              recordError({ action: 'install', origin: 'manual', code: status.code ?? 'transport' })
            }
          }
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
      const at = activeEpoch
      const revision = installRevision
      const seq = (cancelSeq += 1)
      clearManualError('cancel')
      const run = (async (): Promise<UpdateSnapshot> => {
        update({ cancelling: true })
        syncPolling()
        try {
          let outcome: UpdateEnvelopeOutcome | null = null
          try {
            outcome = applyEnvelope(await deps.api.updateCancel(), {
              action: 'cancel',
              origin: 'manual',
              epoch: at,
              revision,
              authoritative: true,
            })
          } catch (error) {
            void error
            outcome = null
          }
          if (outcome === null || !outcome.isCurrentFact) {
            const status = await fetchStatus('status')
            if (status.fact) {
              // 取到事实：以 Host 的 install 状态为准（可能还在装 —— 那就还能再取消一次）。
              clearManualError('cancel')
            } else {
              // 取不到事实就必须如实说"取消没成功"，不能悄悄结束。
              recordError({ action: 'cancel', origin: 'manual', code: status.code ?? 'transport' })
            }
          }
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
