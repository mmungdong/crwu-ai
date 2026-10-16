import { text } from '../../../../shared/utils/value.ts'

/**
 * **单执行租约**（设计稿 §9.2 规则 5 / §9.3，计划 Task 7）。
 *
 * ## 为什么必须有租约
 *
 * 子 Agent 的启动是**可能超时且结果未知**的：请求发出去了、进程也建起来了，而调用方在
 * 超时那一刻并不知道。如果这时父会话"因为没收到确认"就自己把同一个方案再算一遍，
 * 结果就是两份结论写进同一个方案目录 —— 谁先谁后不确定，而且没有任何地方会报错。
 *
 * 所以租约的语义只有一条：**一个任务同一时刻只能有一个执行者**，而"启动状态未知"**也是**
 * 一种执行者状态（`start-unknown`）—— 它不释放、不允许别人接手，直到确认静止。
 *
 * ## 三条边界
 *
 * 1. **换执行者必须先确认静止**：`release` 只对已 `settled` 的租约生效；
 *    `start-unknown` 期间任何 `acquire` 都失败。
 * 2. **身份不符不许写**：绑定子会话、结算、释放都必须带上**同一个** `attemptId`；
 *    另一个 attempt 拿着别的身份来结算，等于把别人的工作结果记到自己名下。
 * 3. **跨方案不许写**：租约记住 `planId`，`belongsToPlan` 是唯一的归属判据，
 *    目录由它派生 —— 模型提交不了任意 `caseDir`。
 */

export type LeaseExecutor = 'parent' | 'child'
export type LeaseState = 'starting' | 'running' | 'start-unknown' | 'settled'

export interface TaskLease {
  taskId: string
  planId: string
  attemptId: string
  executor: LeaseExecutor
  /** 子会话 id；`parent` 执行或尚未绑定时为空串。 */
  childSessionId: string
  state: LeaseState
  acquiredAt: number
  updatedAt: number
  /** 启动耗时（绑定成功时写下真实值）。 */
  startDurationMs: number | null
}

export interface LeaseResult {
  ok: boolean
  error: string
}

export interface TaskLeaseStore {
  /** 取得单执行租约。同一 attempt 重复调用是幂等的；别的 attempt 一律 false。 */
  acquire(input: { taskId: string; planId: string; attemptId: string; executor: LeaseExecutor }, now?: number): boolean
  /** 启动请求发出但结果未知：保留租约、不许别人接手。 */
  markStartUnknown(taskId: string, attemptId: string): LeaseResult
  /** 回读并绑定真实子会话身份。 */
  bindChild(taskId: string, attemptId: string, childSessionId: string, startDurationMs?: number): LeaseResult
  /** 结算（子会话结束或被父会话接管完成）。 */
  settle(taskId: string, attemptId: string): LeaseResult
  /** 释放：只对已结算的租约生效，之后再允许换执行者。 */
  release(taskId: string): LeaseResult
  leaseOf(taskId: string): TaskLease | undefined
  /** 该任务是否已确认静止（没有租约，或已结算）。 */
  isQuiescent(taskId: string): boolean
  belongsToPlan(taskId: string, planId: string): boolean
  /** 本项目里尚未静止的任务 id（父会话顺序执行前等它静止）。 */
  activeTaskIds(): string[]
  list(): TaskLease[]
}

export interface TaskLeaseStoreOptions {
  maxEntries?: number
  now?: () => number
}

export function createTaskLeaseStore(options: TaskLeaseStoreOptions = {}): TaskLeaseStore {
  const now = options.now ?? (() => Date.now())
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256))
  const leases = new Map<string, TaskLease>()

  const stamp = (at: number): number => (Number.isFinite(at) ? at : now())

  const prune = (): void => {
    while (leases.size > maxEntries) {
      // 淘汰最旧的**已结算**租约；没有可淘汰的就停手（不许把在跑的挤掉）。
      let oldest: TaskLease | undefined
      for (const lease of leases.values()) {
        if (lease.state !== 'settled') continue
        if (oldest === undefined || lease.updatedAt < oldest.updatedAt) oldest = lease
      }
      if (oldest === undefined) return
      leases.delete(oldest.taskId)
    }
  }

  return {
    acquire(input, at) {
      const taskId = text(input.taskId)
      const planId = text(input.planId)
      const attemptId = text(input.attemptId)
      if (taskId === '' || planId === '' || attemptId === '') return false
      const existing = leases.get(taskId)
      if (existing !== undefined) {
        // 同一个 attempt 重复取得是幂等的（重试同一件事不该被判成冲突）。
        if (existing.attemptId === attemptId) return true
        // 别的 attempt：无论租约处于什么状态都不许接手 —— 包括 `start-unknown`。
        return false
      }
      const moment = stamp(at ?? now())
      leases.set(taskId, {
        taskId, planId, attemptId, executor: input.executor,
        childSessionId: '', state: 'starting',
        acquiredAt: moment, updatedAt: moment, startDurationMs: null,
      })
      prune()
      return true
    },

    markStartUnknown(taskId, attemptId) {
      const lease = leases.get(text(taskId))
      if (lease === undefined) return { ok: false, error: '没有这个任务的租约' }
      if (lease.attemptId !== text(attemptId)) return { ok: false, error: 'attempt 身份不符：不能改动别人的租约' }
      lease.state = 'start-unknown'
      lease.updatedAt = now()
      return { ok: true, error: '' }
    },

    bindChild(taskId, attemptId, childSessionId, startDurationMs) {
      const lease = leases.get(text(taskId))
      if (lease === undefined) return { ok: false, error: '没有这个任务的租约' }
      if (lease.attemptId !== text(attemptId)) return { ok: false, error: 'attempt 身份不符：不能改动别人的租约' }
      const child = text(childSessionId)
      if (child === '') return { ok: false, error: '子会话身份为空：不能把任务记给一个不知道是谁的执行者' }
      if (lease.childSessionId !== '' && lease.childSessionId !== child) {
        return { ok: false, error: `任务 ${lease.taskId} 已经绑定在子会话 ${lease.childSessionId} 上，不能再绑定 ${child}` }
      }
      lease.childSessionId = child
      lease.executor = 'child'
      lease.state = 'running'
      lease.updatedAt = now()
      if (typeof startDurationMs === 'number' && Number.isFinite(startDurationMs)) {
        lease.startDurationMs = Math.max(0, Math.floor(startDurationMs))
      }
      return { ok: true, error: '' }
    },

    settle(taskId, attemptId) {
      const lease = leases.get(text(taskId))
      if (lease === undefined) return { ok: false, error: '没有这个任务的租约' }
      if (lease.attemptId !== text(attemptId)) return { ok: false, error: 'attempt 身份不符：不能结算别人的租约' }
      lease.state = 'settled'
      lease.updatedAt = now()
      return { ok: true, error: '' }
    },

    release(taskId) {
      const lease = leases.get(text(taskId))
      if (lease === undefined) return { ok: false, error: '没有这个任务的租约' }
      // 只有确认静止才允许释放：`start-unknown` 被释放就等于"父会话接手去重算"。
      if (lease.state !== 'settled') {
        return { ok: false, error: `任务 ${lease.taskId} 尚未确认静止（${lease.state}）：不能换执行者` }
      }
      leases.delete(lease.taskId)
      return { ok: true, error: '' }
    },

    leaseOf(taskId) {
      return leases.get(text(taskId))
    },

    isQuiescent(taskId) {
      const lease = leases.get(text(taskId))
      return lease === undefined || lease.state === 'settled'
    },

    belongsToPlan(taskId, planId) {
      const lease = leases.get(text(taskId))
      if (lease === undefined) return false
      // 归属判据是租约里的 planId，不是调用方提交的目录。
      return lease.planId === text(planId)
    },

    activeTaskIds() {
      return [...leases.values()].filter((lease) => lease.state !== 'settled').map((lease) => lease.taskId)
    },

    list() {
      return [...leases.values()].map((lease) => ({ ...lease }))
    },
  }
}
