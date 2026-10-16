import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../../shared/utils/value.ts'
import type { ExecutionFacts } from './decision.ts'
import { agentRegistry, subagentRegistry, pickProvider } from '../../report-audit/spawn.ts'
import type { TaskLeaseStore } from './leases.ts'

/**
 * **把"Harness 的真实状态"读成 `ExecutionFacts`**（设计稿 §9.3，计划 Task 7）。
 *
 * ## 为什么单独一层
 *
 * `decideExecution` 是纯函数：它只根据事实判断"能不能并行"。事实从哪来是另一件事，
 * 而且这里最容易骗自己 —— 读不到就当成"没人占用"、provider 解析不出来就当成"可用"，
 * 于是并发在没有任何依据的情况下开起来。所以本层只做一件事：
 * **读到的写成事实，读不到的写成"不知道"**，让决策层去退化成顺序。
 *
 * ## 三条不许美化的口径
 *
 * 1. **服务缺失 / 抛错 → `statusKnown = false`**，不是 `externalRunningCount = 0`。
 *    "没人跑"和"我不知道有没有人跑"在并发决策里是两件完全不同的事。
 * 2. **provider 解析失败 → `providerUsable = false`**（原因带回 `notes`）。
 * 3. **Tool filter 无法验证 → `filterSupported = false`**：可见性保证不了时不许放子 Agent ——
 *    子会话看不见必需工具，跑出来的结论不可复核。
 *
 * `lastStartDurationMs` / `lastStartFailure` 来自租约记录（上一次真实启动），
 * 没有过启动就是 `null`，不是 0。
 */

export interface HarnessFactsInput {
  ctx: Context
  /** 本项目已经占用执行的任务（由租约给出，而不是"我们以为在跑"）。 */
  leases?: TaskLeaseStore
  /** 依赖已满足的任务。 */
  readyTaskIds: readonly string[]
  /** 排队等父会话执行的并发上限覆盖（缺省用决策层的默认）。 */
  maxConcurrency?: number
  startSlaMs?: number
}

export interface HarnessFactsResult {
  facts: ExecutionFacts
  /** 读事实时发现的问题（**不阻断**：降级为顺序，但要能解释为什么）。 */
  notes: string[]
}

/** `subagents` 服务上"当前有多少个运行中的子会话"；读不到返回 `null`（**不是 0**）。 */
function runningChildCount(subagents: unknown): number | null {
  const runtime = subagents as { list?: () => unknown; runs?: () => unknown } | undefined
  if (runtime === undefined) return null
  const raw = typeof runtime.list === 'function'
    ? runtime.list()
    : (typeof runtime.runs === 'function' ? runtime.runs() : undefined)
  if (raw === undefined || raw === null) return null
  if (Array.isArray(raw)) return raw.length
  if (typeof raw === 'object') {
    // Map / Set 形态也能数。
    const size = (raw as { size?: unknown }).size
    if (typeof size === 'number' && Number.isFinite(size)) return size
  }
  return null
}

export function readHarnessFacts(input: HarnessFactsInput): HarnessFactsResult {
  const notes: string[] = []
  const activeOwnedTaskIds = input.leases === undefined ? [] : input.leases.activeTaskIds()

  let statusKnown = false
  let externalRunningCount = 0
  let running: number | null = null
  try {
    const agents = agentRegistry(input.ctx)
    const subagents = subagentRegistry(input.ctx)
    if (agents === undefined && subagents === undefined) {
      notes.push('Host 的 agents / subagents 服务都读不到：按"状态未知"处理')
    } else {
      running = runningChildCount(subagents)
      if (running === null) {
        notes.push('读不到运行中的子会话数量：按"状态未知"处理（不当成 0）')
      } else {
        statusKnown = true
        externalRunningCount = running
      }
    }
  } catch (error) {
    // 抛错同样是"不知道"，不是"没人跑"。
    notes.push(`读 Agent 运行状态时出错：${error instanceof Error ? error.message : String(error)}`)
    statusKnown = false
  }

  let providerUsable = false
  try {
    const picked = pickProvider(input.ctx)
    providerUsable = picked.ok
    if (!picked.ok) notes.push(`子 Agent provider 不可用：${picked.error}`)
  } catch (error) {
    notes.push(`解析子 Agent provider 时出错：${error instanceof Error ? error.message : String(error)}`)
  }

  // 可见性：只有 provider 真的支持 `toolFilter` 才算"可以验证"。
  // `pickProvider` 已经把"支持 toolFilter"当成硬条件（支持不了就返回不可用），所以这里的
  // 判据与它是同一条；差别只在措辞 —— 决策层要区分"没有 provider"和"provider 不能收窄工具集"。
  // 即便如此，**创建之后仍必须回读**子会话实际可见的工具（`execution.ts` 的
  // `missingChildTools`）：能力声明是必要条件，不是充分证据。
  const filterSupported = providerUsable
  if (!filterSupported) {
    notes.push('子代理 provider 不支持 / 无法验证 toolFilter：不放子会话，由父会话顺序执行')
  } else {
    notes.push('子代理 provider 声明支持 toolFilter：创建后仍要回读子会话实际可见的工具，回读不过就停掉它')
  }

  const leases = input.leases
  const started = leases === undefined
    ? []
    : leases.list().filter((lease) => lease.startDurationMs !== null && lease.startDurationMs !== undefined)
  const lastStartDurationMs = started.length === 0
    ? null
    : Math.max(...started.map((lease) => Number(lease.startDurationMs)))

  const facts: ExecutionFacts = {
    statusKnown,
    externalRunningCount,
    providerUsable,
    filterSupported,
    activeOwnedTaskIds,
    lastStartDurationMs,
    // 曾被标记 `start-unknown` 却没绑上子会话 = 上一次启动结果不明。
    lastStartFailure: leases !== undefined && leases.list().some((lease) => lease.state === 'start-unknown'),
    readyTaskIds: input.readyTaskIds.map((id) => text(id)).filter((id) => id !== ''),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.startSlaMs === undefined ? {} : { startSlaMs: input.startSlaMs }),
  }
  return { facts, notes }
}
