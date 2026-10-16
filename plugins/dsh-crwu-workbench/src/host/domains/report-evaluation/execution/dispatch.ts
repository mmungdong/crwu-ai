import { text } from '../../../../shared/utils/value.ts'
import type { ExecutionMode, TaskNode } from '../../../../shared/contracts/valuation-project.ts'
import { decideExecution, type ExecutionFacts } from './decision.ts'
import type { TaskLeaseStore } from './leases.ts'
import { readyTaskIds } from '../project/task-graph.ts'

/**
 * **父会话的执行循环**：`dispatch`（排任务）+ `join`（结算任务）（设计稿 §9，计划 Task 7）。
 *
 * ## 为什么父会话需要一个显式的执行循环
 *
 * 顺序执行是**完整有效**的主路径，但它必须同样受单执行租约保护，否则会出现两种典型事故：
 *
 * 1. **重复执行**：父会话对同一个方案连排两次（模型重试、回合被打断后重来），
 *    两份结论写进同一个方案目录，谁后写谁生效；
 * 2. **超时后重算**：子会话启动请求超时、结果未知，父会话"没等到确认"就自己算一遍 ——
 *    而那个子会话其实正在跑。这正是 `start-unknown` 状态存在的理由。
 *
 * 所以这一层只做两件事，且都只依赖注入的事实：**根据真实事实决定并行还是顺序**，
 * 以及**把每个任务的执行者写进租约**。它不猜 Harness 的内部数字，也不自己起进程。
 *
 * ## 为什么调度决策与副作用分开
 *
 * `decideExecution` 是纯函数（可穷尽单测）；这里是它外面那圈**必须发生的记账**：
 * 拿租约、起子会话、回读可见性、失败时标 `start-unknown`。分开之后"决策对不对"与
 * "记账有没有漏"是两组各自可测的断言。
 */

/** 调度要看的任务事实（由调用方从项目索引读出，字段逐字对应 `TaskNode`）。 */
export interface DispatchTask {
  taskId: string
  planId: string
  objectIds: string[]
  dependsOn: string[]
  assetClass: string
  valuationPath: string
  valueScope: string
  /** `blocked` 的任务**不排**：它的方案已经被知识/能力缺口阻断。 */
  status: string
}

export interface DispatchInput {
  projectId: string
  /** 发起调度的会话（父会话；写进租约的 attemptId 由调用方给）。 */
  parentSessionId: string
  /** 本轮尝试标识（Host 铸号；同一个 attempt 重复调度是幂等的）。 */
  attemptId: string
  /** 只排这些任务（缺省 = 全部）；不属于本项目的任务必须被拒绝。 */
  taskIds?: readonly string[]
  /** 已知完成的任务（来自落盘结果/上一轮记录；缺省只看租约）。 */
  completedTaskIds?: readonly string[]
}

export interface StartChildInput {
  planId: string
  taskId: string
  objectIds: readonly string[]
}

export interface ChildStart {
  ok: boolean
  childId: string
  error: string
  /** 真实启动耗时（毫秒）；拿不到就是 `null`（**不是 0**）。 */
  durationMs: number | null
}

export interface DispatchDeps {
  tasks: readonly DispatchTask[]
  leases: TaskLeaseStore
  /** 读 Harness 真实状态（`harness-facts.ts` 的生产实现；测试接替身）。 */
  readFacts: (input: { readyTaskIds: readonly string[] }) => { facts: ExecutionFacts; notes: string[] }
  /** 起一个方案子会话（只在决策为 `parallel` 且可见性可验证时才调用）。 */
  startChild: (input: StartChildInput) => Promise<ChildStart>
  /** 回读子会话实际可见的工具；返回**缺失**的名字（空数组 = 齐备）。 */
  missingChildTools: (childId: string) => Promise<string[]>
  /** 停掉一个刚建好但没通过可见性回读的子会话（不留孤儿）。 */
  stopChild: (childId: string, reason: string) => Promise<void>
}

export interface DispatchOutcome {
  ok: boolean
  errorKind: string
  error: string
  mode: ExecutionMode
  reason: string
  degradation: string[]
  concurrencyCap: number
  /** 由**父会话**按依赖顺序执行的任务（顺序模式是主路径）。 */
  parentTaskIds: string[]
  /** 已委派给子会话的任务（只有回读通过才会出现在这里）。 */
  delegated: Array<{ taskId: string; planId: string; childSessionId: string }>
  /** 本轮不排的任务及原因。 */
  skipped: Array<{ taskId: string; reason: string }>
  /**
   * 启动或回读失败的任务。
   *
   * ⚠️ 这些任务的租约被标成 `start-unknown`：**父会话不许接手重算** ——
   * 结果未知不等于没有执行者。
   */
  failed: Array<{ taskId: string; error: string }>
  activeTaskIds: string[]
  notes: string[]
}

function taskOf(deps: DispatchDeps, taskId: string): DispatchTask | undefined {
  return deps.tasks.find((task) => task.taskId === text(taskId))
}

export async function dispatchReadyTasks(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const notes: string[] = []
  const skipped: DispatchOutcome['skipped'] = []
  const failed: DispatchOutcome['failed'] = []
  const delegated: DispatchOutcome['delegated'] = []
  const base = {
    ok: false, errorKind: '', error: '', mode: 'sequential' as ExecutionMode, reason: '',
    degradation: [] as string[], concurrencyCap: 0, parentTaskIds: [] as string[],
    delegated, skipped, failed, activeTaskIds: deps.leases.activeTaskIds(), notes,
  }

  // ① 选任务：只能排本项目索引里的任务；显式给了 taskIds 就逐个核对归属。
  const wanted = input.taskIds === undefined ? undefined : input.taskIds.map((id) => text(id)).filter((id) => id !== '')
  if (wanted !== undefined) {
    for (const taskId of wanted) {
      if (taskOf(deps, taskId) === undefined) {
        return { ...base, ...{ errorKind: 'input', error: `任务 ${taskId} 不在本项目索引里：不能调度别的项目的任务` } }
      }
    }
  }
  const selected = wanted === undefined
    ? [...deps.tasks]
    : deps.tasks.filter((task) => wanted.includes(task.taskId))

  // ② 完成集合 = 调用方给的 + 已结算租约。**在跑的任务不算完成**。
  const settled = new Set(deps.leases.list().filter((lease) => lease.state === 'settled').map((lease) => lease.taskId))
  const completed = new Set<string>([...(input.completedTaskIds ?? []).map((id) => text(id)), ...settled])
  const leased = new Set(deps.leases.activeTaskIds().map((id) => text(id)))

  const blocked = selected.filter((task) => task.status === 'blocked')
  for (const task of blocked) skipped.push({ taskId: task.taskId, reason: '该方案已被阻断（知识/能力缺口），不排执行' })

  const nodes = selected.map((task): TaskNode => ({
    taskId: task.taskId,
    parentPlanId: task.planId,
    objectIds: [...task.objectIds],
    assetClass: task.assetClass as TaskNode['assetClass'],
    requestedCapability: '',
    dependsOn: [...task.dependsOn],
    valuationPath: task.valuationPath as TaskNode['valuationPath'],
    valueScope: task.valueScope as TaskNode['valueScope'],
    basisRefs: [],
    status: task.status === 'blocked' ? 'blocked' : 'pending',
  }))
  const runnable = nodes.filter((node) => node.status !== 'blocked')
  const ready = readyTaskIds(runnable, [...completed])
    .filter((taskId) => !leased.has(taskId))
  for (const task of selected) {
    if (task.status === 'blocked') continue
    if (leased.has(task.taskId)) skipped.push({ taskId: task.taskId, reason: '已有执行者（租约未结算）：不重复调度' })
    else if (!ready.includes(task.taskId)) skipped.push({ taskId: task.taskId, reason: '依赖尚未完成' })
  }

  if (ready.length === 0) {
    return {
      ...base,
      ok: true,
      mode: 'sequential',
      reason: '没有依赖已满足且无执行者的任务：本轮不需要调度',
      concurrencyCap: 0,
      activeTaskIds: deps.leases.activeTaskIds(),
    }
  }

  // ③ 决策：事实来自真实读取；读不到就顺序（顺序是完整有效的路径）。
  const factCheck = deps.readFacts({ readyTaskIds: ready })
  notes.push(...factCheck.notes)
  const decision = decideExecution(factCheck.facts)

  if (decision.mode === 'parallel') {
    for (const taskId of decision.delegatedTaskIds) {
      const task = taskOf(deps, taskId)
      if (task === undefined) continue
      // 先拿租约再起子会话：并发调度同一任务时，第二个调用在这里就被挡住。
      if (!deps.leases.acquire({ taskId, planId: task.planId, attemptId: input.attemptId, executor: 'child' })) {
        skipped.push({ taskId, reason: '已经有一个执行者（含启动结果未知）持有该任务' })
        continue
      }
      const started = await deps.startChild({
        planId: task.planId, taskId, objectIds: [...task.objectIds],
      })
      if (!started.ok) {
        // **不释放**：结果未知时释放就等于"父会话可以接手重算"。
        deps.leases.markStartUnknown(taskId, input.attemptId)
        failed.push({ taskId, error: started.error || '子会话创建失败' })
        continue
      }
      const missing = await deps.missingChildTools(started.childId)
      if (missing.length > 0) {
        // 可见性回读不通过：停掉刚建的 child，并把租约留成"未知"（等确认静止）。
        await deps.stopChild(started.childId, `子会话看不到必需工具：${missing.join('、')}`)
        deps.leases.markStartUnknown(taskId, input.attemptId)
        failed.push({ taskId, error: `子会话创建成功但工具可见性不足（缺 ${missing.join('、')}）：已停止该子会话，任务保留在未知状态` })
        continue
      }
      const bound = deps.leases.bindChild(taskId, input.attemptId, started.childId, started.durationMs ?? undefined)
      if (!bound.ok) {
        await deps.stopChild(started.childId, bound.error)
        deps.leases.markStartUnknown(taskId, input.attemptId)
        failed.push({ taskId, error: bound.error })
        continue
      }
      delegated.push({ taskId, planId: task.planId, childSessionId: started.childId })
    }
  } else {
    notes.push(`顺序执行：${decision.reason}`)
  }

  // ④ 顺序部分（含并行模式下留给父会话的其余任务）同样先拿租约 —— 顺序不等于可以重复排。
  const parentTaskIds: string[] = []
  for (const taskId of decision.parentTaskIds) {
    const task = taskOf(deps, taskId)
    if (task === undefined) continue
    if (!deps.leases.acquire({ taskId, planId: task.planId, attemptId: input.attemptId, executor: 'parent' })) {
      skipped.push({ taskId, reason: '已经有一个执行者（含启动结果未知）持有该任务' })
      continue
    }
    parentTaskIds.push(taskId)
  }

  return {
    ok: failed.length === 0,
    errorKind: failed.length === 0 ? '' : 'infrastructure',
    error: failed.length === 0 ? '' : failed.map((row) => `${row.taskId}: ${row.error}`).join('；'),
    mode: decision.mode,
    reason: decision.reason,
    degradation: decision.degradation,
    concurrencyCap: decision.concurrencyCap,
    parentTaskIds,
    delegated,
    skipped,
    failed,
    activeTaskIds: deps.leases.activeTaskIds(),
    notes,
  }
}

export interface JoinInput {
  projectId: string
  taskIds: readonly string[]
  /**
   * 父会话执行完某个任务后的结论。
   *
   * 只有**给了结论**的父会话任务才会被结算：没有结论就说明它还没做完（或这一轮没做到），
   * 那时结算等于把"没做完"记成"做完了"。
   */
  outcomes?: Readonly<Record<string, { status: string; note?: string }>>
}

export interface JoinDeps {
  leases: TaskLeaseStore
  /** 子会话当前状态；读不到返回空串（**空串不是"已结束"**）。 */
  childStatusOf: (childId: string) => string
}

export interface JoinedTask {
  taskId: string
  planId: string
  executor: string
  childSessionId: string
  leaseState: string
  childStatus: string
  settled: boolean
  quiescent: boolean
  note: string
}

export interface JoinReceipt {
  ok: boolean
  errorKind: string
  error: string
  tasks: JoinedTask[]
  activeTaskIds: string[]
  /** 仍在跑（尚未静止）的任务。父会话顺序计算前要先等它们结束。 */
  runningTaskIds: string[]
}

const TERMINAL_STATUSES: readonly string[] = ['completed', 'blocked', 'partial', 'failed', 'cancelled']

export function joinTasks(input: JoinInput, deps: JoinDeps): JoinReceipt {
  const tasks: JoinedTask[] = []
  const running: string[] = []
  for (const raw of input.taskIds) {
    const taskId = text(raw)
    if (taskId === '') continue
    const lease = deps.leases.leaseOf(taskId)
    if (lease === undefined) {
      tasks.push({
        taskId, planId: '', executor: '', childSessionId: '', leaseState: 'none',
        childStatus: '', settled: false, quiescent: true, note: '没有租约：这个任务从未被调度过',
      })
      continue
    }
    const outcome = input.outcomes?.[taskId]
    let settled = lease.state === 'settled'
    let childStatus = ''
    let note = ''
    if (!settled && lease.childSessionId !== '') {
      childStatus = text(deps.childStatusOf(lease.childSessionId))
      if (childStatus === 'running') {
        note = '子会话仍在运行：不结算、也不换执行者'
        running.push(taskId)
      } else {
        // 空串（注册表里查不到）也算"没有活动执行者"，但如实记下这个事实 ——
        // 子会话的**结论**仍要由落盘结果核对，这里只回答"还有没有人占着"。
        const result = deps.leases.settle(taskId, lease.attemptId)
        settled = result.ok
        note = childStatus === ''
          ? '子会话已不在注册表里（按已结束处理）；结论仍须由该方案的落盘结果核对'
          : `子会话已结束（${childStatus}）`
        if (!result.ok) note = `结算失败：${result.error}`
      }
    } else if (!settled) {
      // 父会话执行的任务：只有拿到明确结论才结算。
      if (outcome !== undefined && TERMINAL_STATUSES.includes(text(outcome.status))) {
        const result = deps.leases.settle(taskId, lease.attemptId)
        settled = result.ok
        note = `父会话已给出结论（${text(outcome.status)}）${text(outcome.note) === '' ? '' : `：${text(outcome.note)}`}`
        if (!result.ok) note = `结算失败：${result.error}`
      } else {
        note = '父会话还没给出结论：任务仍在执行者手上'
        running.push(taskId)
      }
    } else {
      note = '已结算'
    }
    tasks.push({
      taskId,
      planId: lease.planId,
      executor: lease.executor,
      childSessionId: lease.childSessionId,
      leaseState: lease.state,
      childStatus,
      settled,
      quiescent: deps.leases.isQuiescent(taskId),
      note,
    })
  }
  return {
    ok: true,
    errorKind: '',
    error: '',
    tasks,
    activeTaskIds: deps.leases.activeTaskIds(),
    runningTaskIds: running,
  }
}
