import { text } from '../../../../shared/utils/value.ts'
import type { BrowserClient, RecoveryOutcome } from './cli-client.ts'

/**
 * 人机验证恢复的**协调器**（设计稿 §8.4）。
 *
 * ## 为什么预算与冷却不能交给模型或 CLI 进程
 *
 * - 交给模型：它会 `sleep`、会反复调用恢复 Tool、会在两次自动尝试之外再开两次 ——
 *   要求里写的是"最多 2 次自动尝试、总窗口 120 秒"，一个能被调用方放宽的预算不是预算。
 * - 交给 CLI 进程：冷却要占用**同一 profile 的串行队列**几十秒，而这段时间别的来源
 *   本来可以正常取数。要求明确写的是"冷却由 coordinator 定时任务管理、释放 profile 队列"。
 *
 * 所以这里持有三件状态：**每任务的尝试预算**、**每来源的冷却窗口**、**每个恢复任务的
 * 原 URL 与来源**（显式继续时不许调用方改 URL —— 那等于把恢复变成"导航到任意页面"）。
 *
 * ## 一条注意：挑战截图永远不是证据
 *
 * 协调器**不写任何案例文件**。它只返回结论；正式截图必须由取数链路在恢复成功后**重新抓取**，
 * 并经过"原房源字段 + 最终 URL + 无可见遮罩"的校验。恢复期间的挑战画布只作临时排障材料。
 */

/** 一次取数任务的自动恢复最多 2 次尝试。 */
export const RECOVERY_MAX_ATTEMPTS = 2
/** 总窗口 120 秒。 */
export const RECOVERY_WINDOW_MS = 120_000
/** 单次脚本/CDP 调用最多 30 秒。 */
export const RECOVERY_SCRIPT_TIMEOUT_MS = 30_000
/** 自动尝试之间的冷却（由这里在队列**之外**等待）。 */
export const RECOVERY_COOLDOWN_MS = 30_000

export interface RecoveryBudgetView {
  retrievalTaskId: string
  providerId: string
  attempts: number
  remainingAttempts: number
  windowStartedAt: number
  windowRemainingMs: number
}

/**
 * CLI 报出的"站点挑战页"原因码（`recover.go` 的 `ReasonChallengePageWaitingUser`）。
 *
 * 与 CLI 常量逐字对齐：这里用它决定**不再冷却重试**，所以对不上就等于把风控敲门又敲一遍。
 */
export const CHALLENGE_PAGE_WAITING_USER = 'challenge-page-waiting-user'

export interface ChallengeRecoveryCoordinator {
  /**
   * 取数链路遇到可见挑战时调用。内部最多发起两次有界尝试，并在两次之间于**队列之外**冷却。
   */
  attempt(
    input: { providerId: string; retrievalTaskId: string; url: string; caseId?: string; strategy?: 'auto' | 'cooldown-renavigate' | 'geetest-v3-canvas' },
    signal?: AbortSignal,
  ): Promise<RecoveryOutcome>
  /**
   * 结构化 Tool 的**显式继续**入口：员工完成网页验证之后，用同一个取数任务继续。
   *
   * 输入只有 `providerId` + `retrievalTaskId`；原 URL 从受保护的预算记录里读，
   * 调用方提交不了自由 URL。未登记过的任务直接拒绝（不能凭空发起一次导航）。
   */
  resume(input: { providerId: string; retrievalTaskId: string }, signal?: AbortSignal): Promise<RecoveryOutcome>
  budgetOf(retrievalTaskId: string): RecoveryBudgetView | undefined
  /** 该来源的冷却截止时刻（epoch ms；0 = 无冷却）。后续取数请求要遵守它。 */
  cooldownUntilOf(providerId: string): number
  dispose(): void
}

export interface ChallengeRecoveryDeps {
  client: BrowserClient
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  cooldownMs?: number
}

/**
 * 一次 `recovered` 结论要同时满足三件事才算数。
 *
 * CLI 只会在这三条都成立时回 `recovered`，这里仍然自己核一遍：判定是两层的
 * （CLI 的页面检查 + Host 的房源字段检查），而"最终 URL 回到该来源、页面可读、
 * 不带着可见挑战"是能不能拿这一页当证据的前提。挑战页与挑战画布**永远不是证据**。
 */
export function recoveryVerified(outcome: RecoveryOutcome): boolean {
  return outcome.state === 'recovered'
    && outcome.pageValidation.hostMatches === true
    && outcome.pageValidation.readable === true
    && outcome.pageValidation.challengeVisible === false
}

/**
 * 未经核验的 `recovered` 降级为 `waiting-user`（`reasonCode=recovery-unverified`）。
 *
 * 宁可让员工再看一眼那个可见窗口，也不把"脚本/命令说好了"当成恢复成功 ——
 * 退出码与脚本文案从来不是判据。
 */
function certified(outcome: RecoveryOutcome): RecoveryOutcome {
  if (outcome.state !== 'recovered' || recoveryVerified(outcome)) return outcome
  return {
    ...outcome,
    state: 'waiting-user',
    reasonCode: 'recovery-unverified',
    pageValidation: {
      ...outcome.pageValidation,
      reason: '恢复结论没有通过页面核验（最终 URL 未回到原站点 / 页面不可读 / 仍有可见挑战）：'
        + '请在可见窗口确认后用同一取数任务继续',
    },
  }
}

interface TaskBudget {
  retrievalTaskId: string
  providerId: string
  url: string
  caseId: string
  attempts: number
  windowStartedAt: number
  strategy?: 'auto' | 'cooldown-renavigate' | 'geetest-v3-canvas'
}

const cancelledOutcome = (input: { providerId: string; retrievalTaskId: string; recoveryId: string }): RecoveryOutcome => ({
  recoveryId: input.recoveryId,
  retrievalTaskId: input.retrievalTaskId,
  providerId: input.providerId,
  strategyId: '',
  strategyVersion: '',
  attempts: 0,
  beforeKind: '',
  afterKind: '',
  state: 'cancelled',
  reasonCode: 'cancelled',
  nextEligibleAt: '',
  strategies: [],
  notes: [],
  pageValidation: {
    finalUrl: '', title: '', hostMatches: false, readable: false,
    challengeVisible: false, loginWall: false, blocked: false, overlaySelectors: [],
    reason: '恢复被取消',
  },
})

/**
 * 可取消的等待。冷却在**队列之外**发生，所以这里不持有任何 profile 租约。
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('恢复冷却被取消'))
    }
    if (signal?.aborted === true) {
      clearTimeout(timer)
      reject(new Error('恢复冷却被取消'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createChallengeRecoveryCoordinator(deps: ChallengeRecoveryDeps): ChallengeRecoveryCoordinator {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? defaultSleep
  const cooldownMs = deps.cooldownMs ?? RECOVERY_COOLDOWN_MS
  const tasks = new Map<string, TaskBudget>()
  const cooldowns = new Map<string, number>()

  const recoveryIdOf = (retrievalTaskId: string): string => `rec-${retrievalTaskId}`

  const remainingAttempts = (budget: TaskBudget): number =>
    Math.max(0, RECOVERY_MAX_ATTEMPTS - budget.attempts)

  const windowRemaining = (budget: TaskBudget): number =>
    Math.max(0, RECOVERY_WINDOW_MS - (now() - budget.windowStartedAt))

  const waitingUser = (
    budget: TaskBudget,
    reasonCode: string,
    reason: string,
    nextEligibleAt: number,
  ): RecoveryOutcome => ({
    ...cancelledOutcome({ providerId: budget.providerId, retrievalTaskId: budget.retrievalTaskId, recoveryId: recoveryIdOf(budget.retrievalTaskId) }),
    state: 'waiting-user',
    reasonCode,
    nextEligibleAt: nextEligibleAt > 0 ? new Date(nextEligibleAt).toISOString() : '',
    pageValidation: {
      finalUrl: budget.url, title: '', hostMatches: false, readable: false,
      challengeVisible: true, loginWall: false, blocked: false, overlaySelectors: [],
      reason,
    },
  })

  const run = async (budget: TaskBudget, signal?: AbortSignal): Promise<RecoveryOutcome> => {
    for (;;) {
      if (signal?.aborted === true) {
        return cancelledOutcome({ providerId: budget.providerId, retrievalTaskId: budget.retrievalTaskId, recoveryId: recoveryIdOf(budget.retrievalTaskId) })
      }
      const remaining = remainingAttempts(budget)
      const windowLeft = windowRemaining(budget)
      if (remaining <= 0) {
        const until = now() + cooldownMs
        cooldowns.set(budget.providerId, until)
        return waitingUser(budget, 'budget-exhausted', '自动恢复尝试次数已用完：请人工完成网页验证后继续同一任务', until)
      }
      if (windowLeft <= 0) {
        const until = now() + cooldownMs
        cooldowns.set(budget.providerId, until)
        return waitingUser(budget, 'window-exhausted', '自动恢复窗口已用完：请人工完成网页验证后继续同一任务', until)
      }

      // 冷却在队列**之外**等待：这段时间 profile 可以服务别的来源与计算任务。
      const until = cooldowns.get(budget.providerId) ?? 0
      if (until > now()) {
        try {
          await sleep(Math.min(until - now(), windowLeft), signal)
        } catch {
          return cancelledOutcome({ providerId: budget.providerId, retrievalTaskId: budget.retrievalTaskId, recoveryId: recoveryIdOf(budget.retrievalTaskId) })
        }
        continue
      }

      const outcome = certified(await deps.client.recover({
        providerId: budget.providerId,
        url: budget.url,
        retrievalTaskId: budget.retrievalTaskId,
        recoveryId: recoveryIdOf(budget.retrievalTaskId),
        ...(budget.strategy === undefined ? {} : { strategy: budget.strategy }),
        attempts: remaining,
        windowMs: windowLeft,
        // 显式 0：冷却由这里管理，不在 CLI 进程里睡。
        cooldownMs: 0,
        scriptTimeoutMs: RECOVERY_SCRIPT_TIMEOUT_MS,
      }, signal))

      const used = Math.max(1, Math.min(remaining, outcome.attempts))
      budget.attempts += used

      if (outcome.state === 'recovered') {
        cooldowns.delete(budget.providerId)
        return outcome
      }
      // 基础设施类与"不支持"不进冷却循环：重试同一个不认识的东西只是浪费窗口。
      if (outcome.state === 'unsupported' || outcome.state === 'unavailable'
        || outcome.state === 'cancelled' || outcome.state === 'failed') {
        return outcome
      }
      // **站点挑战页**直接交回人工，不做冷却重试。
      //
      // 2026-10-13 成功那一轮的做法是"每 URL 只导航一次 + 列表 9s / 详情 8.5s"；归档同时显示
      // 站点在 11:31 开始回 captcha —— 同一页多敲几次正是把风控请出来的方式。所以这一类
      // 一族一次就够：冷却重试只会让风控更紧，而人工本来就必须介入（那一页没有可驱动的控件）。
      if (outcome.state === 'waiting-user' && outcome.reasonCode === CHALLENGE_PAGE_WAITING_USER) {
        return outcome
      }
      // waiting-user：冷却之后再看预算是否还允许下一次自动尝试。
      const nextUntil = cooldownMs > 0 ? now() + cooldownMs : 0
      if (nextUntil > 0) cooldowns.set(budget.providerId, nextUntil)
      if (remainingAttempts(budget) <= 0 || windowRemaining(budget) <= 0) {
        return {
          ...outcome,
          nextEligibleAt: nextUntil > 0 ? new Date(nextUntil).toISOString() : outcome.nextEligibleAt,
        }
      }
    }
  }

  return {
    async attempt(input, signal) {
      const retrievalTaskId = text(input.retrievalTaskId).trim()
      const providerId = text(input.providerId).trim()
      if (retrievalTaskId === '' || providerId === '') {
        throw new Error('恢复缺少 retrievalTaskId 或 providerId')
      }
      const existing = tasks.get(retrievalTaskId)
      if (existing !== undefined && existing.providerId !== providerId) {
        // 同一取数任务不能中途换来源：那会让"恢复的是哪一个房源"变得无法追溯。
        throw new Error(`取数任务 ${retrievalTaskId} 已经绑定在来源 ${existing.providerId} 上，不能改用 ${providerId}`)
      }
      const budget: TaskBudget = existing ?? {
        retrievalTaskId,
        providerId,
        url: text(input.url),
        caseId: text(input.caseId),
        attempts: 0,
        windowStartedAt: now(),
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      }
      if (budget.url === '') throw new Error('恢复缺少原页面 URL')
      tasks.set(retrievalTaskId, budget)
      return await run(budget, signal)
    },

    async resume(input, signal) {
      const retrievalTaskId = text(input.retrievalTaskId).trim()
      const providerId = text(input.providerId).trim()
      const budget = tasks.get(retrievalTaskId)
      // 没有受保护的预算记录 = 这次恢复不是从真实取数任务继续过来的：拒绝。
      if (budget === undefined) {
        throw new Error(`没有登记过的取数任务 ${retrievalTaskId || '（空）'}：恢复只能从真实取数任务继续`)
      }
      if (budget.providerId !== providerId) {
        throw new Error(`取数任务 ${retrievalTaskId} 属于来源 ${budget.providerId}，不能按 ${providerId} 继续`)
      }
      // 员工主动继续**不重置自动预算**；它只做一次页面核验（CLI 在页面已恢复时不会拖拽）。
      const outcome = certified(await deps.client.recover({
        providerId: budget.providerId,
        url: budget.url,
        retrievalTaskId: budget.retrievalTaskId,
        recoveryId: recoveryIdOf(budget.retrievalTaskId),
        strategy: 'auto',
        attempts: 1,
        windowMs: Math.max(1000, windowRemaining(budget)),
        cooldownMs: 0,
        scriptTimeoutMs: RECOVERY_SCRIPT_TIMEOUT_MS,
      }, signal))
      if (outcome.state === 'recovered') cooldowns.delete(budget.providerId)
      return outcome
    },

    budgetOf(retrievalTaskId) {
      const budget = tasks.get(text(retrievalTaskId))
      if (budget === undefined) return undefined
      return {
        retrievalTaskId: budget.retrievalTaskId,
        providerId: budget.providerId,
        attempts: budget.attempts,
        remainingAttempts: remainingAttempts(budget),
        windowStartedAt: budget.windowStartedAt,
        windowRemainingMs: windowRemaining(budget),
      }
    },

    cooldownUntilOf(providerId) {
      return cooldowns.get(text(providerId)) ?? 0
    },

    dispose() {
      tasks.clear()
      cooldowns.clear()
    },
  }
}
