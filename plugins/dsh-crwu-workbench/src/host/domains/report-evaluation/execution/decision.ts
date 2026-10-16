import { text } from '../../../../shared/utils/value.ts'
import type { ExecutionMode } from '../../../../shared/contracts/valuation-project.ts'

/**
 * **调度决策的纯函数**（设计稿 §9.1 / §9.2，计划 Task 7）。
 *
 * ## 为什么是纯函数
 *
 * "该不该起子 Agent"这件事必须能用一串事实回答清楚，而不是散在调用链里：
 * 状态读不出来时悄悄并行、启动慢时继续扩张、上一轮刚被拒还接着试 —— 这三种都会
 * 让同一份资料被两个执行者同时算，而两边各自的结论看起来都正常。
 *
 * ## 这一层**不猜**任何 Harness 内部数字
 *
 * - 没有"CPU 快慢评分"，没有 `remainingSlots`。`externalRunningCount` 是**真实读到的**
 *   其他运行中 Agent 数；`providerUsable` / `filterSupported` 是**实际探测**的结果；
 *   `lastStartDurationMs` 是**上一次真实启动**花了多久。
 * - `maxConcurrency = 2` 是**安全上限**，不是"必须并行 2 个"；
 * - `startSlaMs = 10000` 是**技术启动 SLA**，不是"用户机器慢"的判据。
 *
 * 顺序执行是**完整有效**的路径：它不是降级到"功能缺失"，而是资源不足/状态未知时的正常选择。
 */

/** 判断输入。每一项都是**事实**，不是估计。 */
export interface ExecutionFacts {
  /** Agent 运行状态是否真的读到了（读不到 → 顺序）。 */
  statusKnown: boolean
  /** 当前**其他**运行中的 Agent 数（本项目之外）。 */
  externalRunningCount: number
  /** 子 Agent 的 provider / 服务是否可用。 */
  providerUsable: boolean
  /** Tool filter 是否可以验证（不可验证 → 顺序：可见性无法保证时不能放子 Agent）。 */
  filterSupported: boolean
  /** 本项目**已经**在执行的任务（防止重复启动同一个方案）。 */
  activeOwnedTaskIds: readonly string[]
  /** 上一次启动真实花了多久；没有过启动就是 `null`。 */
  lastStartDurationMs: number | null
  /** 上一次启动被拒或超时未确认。 */
  lastStartFailure: boolean
  /** 依赖已满足、可以开始的任务（由任务图算出）。 */
  readyTaskIds: readonly string[]
  /** 安全并发上限（缺省 2）。 */
  maxConcurrency?: number
  /** 启动健康阈值：超过它就**停止扩张**（缺省 10000ms）。 */
  startSlaMs?: number
}

export interface ExecutionDecision {
  mode: ExecutionMode
  /** 人话说明为什么是这个模式（进日志与报告，不进员工界面）。 */
  reason: string
  /** 允许委派给子 Agent 的任务。 */
  delegatedTaskIds: string[]
  /** 由**父会话**按顺序执行的任务（顺序模式是主路径，不是兜底）。 */
  parentTaskIds: string[]
  /** 降级原因清单（逐条可核对）。 */
  degradation: string[]
  concurrencyCap: number
}

export const DEFAULT_MAX_CONCURRENCY = 2
export const DEFAULT_START_SLA_MS = 10_000

/** 由事实推出调度决策。 */
export function decideExecution(facts: ExecutionFacts): ExecutionDecision {
  const cap = Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, Math.floor(facts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)))
  const sla = Math.max(1, Math.floor(facts.startSlaMs ?? DEFAULT_START_SLA_MS))
  const owned = new Set((facts.activeOwnedTaskIds ?? []).map((id) => text(id)))
  const ready = (facts.readyTaskIds ?? []).map((id) => text(id)).filter((id) => id !== '')

  const degradation: string[] = []
  const sequential = (reason: string): ExecutionDecision => ({
    mode: 'sequential',
    reason,
    delegatedTaskIds: [],
    // 已经在别的执行者手上的任务不进父会话队列：那正是"名义顺序、实际重复"的来源。
    parentTaskIds: ready.filter((id) => !owned.has(id)),
    degradation,
    concurrencyCap: cap,
  })

  if (!facts.statusKnown) {
    degradation.push('读不到 Agent 运行状态')
    return sequential('Agent 状态未知：无法确认没有资源争用，由父会话顺序执行')
  }
  if (!facts.providerUsable) {
    degradation.push('子 Agent 服务不可用')
    return sequential('子 Agent 服务不可用：由父会话顺序执行')
  }
  if (!facts.filterSupported) {
    degradation.push('Tool filter 不可验证')
    return sequential('无法验证子会话的工具可见性：不放子 Agent，由父会话顺序执行')
  }
  if (facts.externalRunningCount > 0) {
    degradation.push(`存在 ${String(facts.externalRunningCount)} 个其他运行中的 Agent`)
    return sequential('还有别的任务在跑：不与它们争用资源，由父会话顺序执行')
  }
  if (facts.lastStartFailure) {
    degradation.push('上一次启动被拒')
    return sequential('上一次启动被拒：不再扩张，由父会话顺序执行')
  }
  // 启动慢就**停止扩张**：这是技术启动 SLA，不是"用户 CPU 慢"。
  if (facts.lastStartDurationMs !== null && facts.lastStartDurationMs > sla) {
    degradation.push(`上一次启动耗时 ${String(facts.lastStartDurationMs)}ms 超过 ${String(sla)}ms`)
    return sequential('子 Agent 启动已超过技术 SLA：停止扩张，由父会话顺序执行')
  }

  const pending = ready.filter((id) => !owned.has(id))
  if (pending.length === 0) {
    return sequential(ready.length === 0 ? '没有依赖已满足的任务' : '可执行任务都已有执行者')
  }
  // 规则 1：单方案直接父会话执行。
  if (pending.length === 1) {
    return sequential('只有一个可执行方案：由父会话执行，不为此单开子 Agent')
  }

  const delegated = pending.slice(0, cap)
  const rest = pending.slice(cap)
  return {
    mode: 'parallel',
    reason: `状态明确且无外部繁忙任务：先启动 ${String(delegated.length)} 个方案子 Agent（安全上限 ${String(cap)}）`,
    delegatedTaskIds: delegated,
    parentTaskIds: rest,
    degradation,
    concurrencyCap: cap,
  }
}
