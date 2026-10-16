import { text } from '../../../../shared/utils/value.ts'
import type {
  AdoptedMethod,
  AssetClass,
  Blocker,
  KnowledgeRef,
  PlanAssessment,
  TaskNode,
  ValuationPath,
  ValuationPlan,
  ValueScope,
} from '../../../../shared/contracts/valuation-project.ts'

/**
 * 执行任务图与**价值范围合同**（设计稿 §7.3，计划 Task 6）。
 *
 * ## 为什么房地分别评估必须是一张图，而不是两个独立方案
 *
 * 土地与建筑物是**同一个估价对象**的两个组成部分。做成两份互不相关的估值，就会出现
 * 「含地价的住宅市场法结论」再加一次「土地价值」—— 总价看起来更大、更"完整"，
 * 而它是重复计价。所以这里把关的是两件事：
 *
 * 1. **依赖图无环**，土地/建筑物只有在前置汇总任务之前、且知识允许独立取值时才并行；
 * 2. **价值范围互斥**：`land-only` / `building-only` / `land-and-building` 三者不能相加。
 *
 * ## 本期土地能力**不存在**
 *
 * `LAND_EXECUTION_CAPABILITY` 明确标 `available: false`：没有 Skill、没有结构化 Tool、
 * 没有知识路由、没有模板。触发 `separate` 时这里产出 blocker，**不创建空壳 Skill、
 * 不注册假工具、不拿普通住宅市场法当 building-only 的替代**。其他独立方案照常继续。
 */

/** 未来土地估值的执行能力。本期只作为"不满足条件"的证据出现。 */
export const LAND_EXECUTION_CAPABILITY = {
  id: 'land.valuation.execute',
  skill: 'crwu-biz-valuation-land',
  available: false as const,
  reason: '土地估值 Skill 尚未实现：没有方法正文、知识路由、结构化 Tool 与计算表模板',
} as const

/** 仅建筑物的专门方法（同样未实现）。 */
export const BUILDING_ONLY_CAPABILITY = {
  id: 'valuation.building-only.calculate',
  available: false as const,
  reason: '仅建筑物的专门测算方法尚未实现',
} as const

export interface TaskGraph {
  planId: string
  valuationPath: ValuationPath
  nodes: TaskNode[]
  /** 有依赖的边（`from` 必须先完成）。 */
  edges: Array<{ from: string; to: string }>
  blockers: Blocker[]
  ok: boolean
}

export interface ScopeCheck {
  ok: boolean
  /** 出现重复计价风险时列出相互冲突的价值范围。 */
  overlapping: ValueScope[]
  reason: string
}

function nodeOf(
  plan: ValuationPlan,
  taskId: string,
  assetClass: AssetClass,
  valueScope: ValueScope,
  requestedCapability: string,
  dependsOn: string[],
  objectIds: string[],
  basisRefs: KnowledgeRef[],
): TaskNode {
  return {
    taskId,
    parentPlanId: plan.planId,
    objectIds,
    assetClass,
    requestedCapability,
    dependsOn,
    valuationPath: plan.valuationPath,
    valueScope,
    basisRefs,
    status: dependsOn.length === 0 ? 'ready' : 'pending',
  }
}

/**
 * 由方案与方法判定造任务图。
 *
 * - `combined`：房地合一，**每个采用的方法一个任务**（价值范围 `land-and-building`）——
 *   自动判断采用组合方法时，市场法与收益法各跑一次、各自留痕；只按 `primaryMethod` 建任务
 *   会让"知识要求两种方法互相校核"在任务图上根本不存在；
 * - `separate`：土地任务 + 建筑物任务 + 汇总任务，汇总依赖前两者；
 * - `unresolved`：不造任务，产出 blocker 请员工确认权益边界。
 *
 * 采用方法为空时退回单个默认任务（方法判定阶段已经把"一个都跑不了"记成 blocker）。
 */
export function buildTaskGraph(
  plan: ValuationPlan,
  assessment: PlanAssessment | null,
  options: { basisRefs?: KnowledgeRef[] } = {},
): TaskGraph {
  const basis = (options.basisRefs ?? []).map((item) => ({ ...item }))
  const adopted: AdoptedMethod[] = assessment?.selectedMethods?.length
    ? [...assessment.selectedMethods]
    : [assessment?.primaryMethod ?? 'market']
  const blockers: Blocker[] = []
  const nodes: TaskNode[] = []
  const edges: Array<{ from: string; to: string }> = []
  const path: ValuationPath = plan.valuationPath

  if (path === 'unresolved') {
    blockers.push({
      kind: 'valuation-path-unresolved',
      stage: 'grouping',
      code: 'valuation.task-graph.path-unresolved',
      missing: ['房地权益边界（房地合一或分别评估）的确认结论'],
      checked: ['knowledge:01 房地产评估方法选择方案', `plan:${plan.planId}`],
      reason: `方案 ${plan.planId} 的房地权益边界未解：自行选路径会直接改变价值范围`,
      remediation: '在本估值会话内向员工确认权益边界后重跑该方法判定；不要自行假定。',
    })
    return { planId: plan.planId, valuationPath: path, nodes, edges, blockers, ok: false }
  }

  if (path === 'combined') {
    // **每个采用的方法一个任务**：任务 id 带方法，交付件也按任务隔离。
    for (const method of adopted) {
      nodes.push(nodeOf(
        plan,
        `${plan.planId}-${method}`,
        'realestate',
        'land-and-building',
        `valuation.${method}.calculate`,
        [],
        plan.objectIds,
        basis,
      ))
    }
    return { planId: plan.planId, valuationPath: path, nodes, edges, blockers, ok: true }
  }

  // separate：土地与建筑物各自取值，再有一个汇总任务。
  const landId = `${plan.planId}-land`
  const buildingId = `${plan.planId}-building`
  const joinId = `${plan.planId}-join`
  nodes.push(nodeOf(plan, landId, 'land', 'land-only', LAND_EXECUTION_CAPABILITY.id, [], plan.objectIds, basis))
  nodes.push(nodeOf(plan, buildingId, 'building', 'building-only', BUILDING_ONLY_CAPABILITY.id, [], plan.objectIds, basis))
  nodes.push(nodeOf(plan, joinId, 'realestate', 'land-and-building', 'valuation.land-building.aggregate', [landId, buildingId], plan.objectIds, basis))
  edges.push({ from: landId, to: joinId }, { from: buildingId, to: joinId })

  const cycle = detectCycle(nodes)
  if (cycle !== null) {
    blockers.push({
      kind: 'valuation-path-unsupported',
      stage: 'method-selection',
      code: 'valuation.task-graph.cycle',
      missing: ['无环的任务依赖图'],
      checked: nodes.map((node) => node.taskId),
      reason: `任务依赖图存在环：${cycle.join(' → ')}`,
      remediation: '依赖图必须无环：有依赖的任务先完成前置再启动。请修正任务定义后重跑。',
    })
    return { planId: plan.planId, valuationPath: path, nodes, edges, blockers, ok: false }
  }

  // 能力缺席就阻断**这个方案**，而不是把任务标成可跑。
  for (const capability of [LAND_EXECUTION_CAPABILITY, BUILDING_ONLY_CAPABILITY]) {
    if (capability.available) continue
    blockers.push({
      kind: 'valuation-path-unsupported',
      stage: 'method-selection',
      code: 'valuation.task-graph.capability-unavailable',
      capabilityId: capability.id,
      missing: [capability.reason],
      checked: ['skill' in capability
        ? `capability:${capability.id}（候选 Skill ${capability.skill}）`
        : `capability:${capability.id}`],
      reason: `方案 ${plan.planId} 需要房地分别评估，而「${capability.id}」当前不可用；`
        + '继续合并取值会把土地价值重复计入房地综合结论。',
      remediation: `先实现并验证 ${'skill' in capability ? capability.skill : capability.id} 的 Skill、结构化 Tool、知识路由与模板，`
        + '再按三个互斥价值范围重跑本方案；本期只交付说明原因的中断报告，不给金额。',
    })
  }

  return { planId: plan.planId, valuationPath: path, nodes, edges, blockers, ok: blockers.length === 0 }
}

/** 返回第一个环（节点 id 序列），无环返回 `null`。 */
export function detectCycle(nodes: readonly TaskNode[]): string[] | null {
  const depends = new Map(nodes.map((node) => [node.taskId, node.dependsOn.filter((id) => nodes.some((other) => other.taskId === id))]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let found: string[] | null = null

  const visit = (taskId: string): void => {
    if (found !== null) return
    const current = state.get(taskId)
    if (current === 'done') return
    if (current === 'visiting') {
      const start = stack.indexOf(taskId)
      found = [...stack.slice(start === -1 ? 0 : start), taskId]
      return
    }
    state.set(taskId, 'visiting')
    stack.push(taskId)
    for (const next of depends.get(taskId) ?? []) visit(next)
    stack.pop()
    state.set(taskId, 'done')
  }

  for (const node of nodes) visit(node.taskId)
  return found
}

/**
 * 汇总前的**价值范围互斥**校验。
 *
 * 规则只有一条，但它是这条链路上最贵的一条：`land-and-building` 已经包含了土地权益，
 * 不能再与 `land-only` 相加。`building-only` 与 `land-and-building` 相加同样重复。
 */
export function validateValueScopes(components: ReadonlyArray<{ valueScope: ValueScope }>): ScopeCheck {
  const scopes = components.map((item) => item.valueScope)
  const combined = scopes.includes('land-and-building')
  const land = scopes.includes('land-only')
  const building = scopes.includes('building-only')

  if (combined && (land || building)) {
    const overlapping: ValueScope[] = ['land-and-building']
    if (land) overlapping.push('land-only')
    if (building) overlapping.push('building-only')
    return {
      ok: false,
      overlapping,
      reason: '`land-and-building` 已包含土地与建筑物权益，不能再与 `land-only` / `building-only` 相加：那是重复计价',
    }
  }
  if (scopes.length !== new Set(scopes).size) {
    return {
      ok: false,
      overlapping: [...new Set(scopes)],
      reason: '同一个价值范围出现多次：汇总前请先确认它们是不是同一个估价对象的重复任务',
    }
  }
  return { ok: true, overlapping: [], reason: '' }
}

/** 一个价值范围是"仅土地"还是"含建筑物"（汇总口径用它，不是业务规则）。 */
export function scopeIncludesLand(scope: ValueScope): boolean {
  return scope === 'land-only' || scope === 'land-and-building'
}

export function scopeIncludesBuilding(scope: ValueScope): boolean {
  return scope === 'building-only' || scope === 'land-and-building'
}

/** 只在前置任务完成后才允许 ready 的判定（顺序执行与并行执行共用）。 */
export function readyTaskIds(nodes: readonly TaskNode[], completed: readonly string[]): string[] {
  const done = new Set(completed)
  return nodes
    .filter((node) => node.status === 'pending' || node.status === 'ready')
    // 已完成的任务不是"可以启动"：把它再排一次就是重复执行同一个方案。
    .filter((node) => !done.has(node.taskId))
    .filter((node) => node.dependsOn.every((id) => done.has(id)))
    .map((node) => node.taskId)
}

/** 任务图里的对象归属必须与方案一致（防跨方案写）。 */
export function taskGraphOwnsObjects(graph: TaskGraph, plan: ValuationPlan): boolean {
  const planObjects = new Set(plan.objectIds)
  return graph.nodes.every((node) =>
    node.parentPlanId === plan.planId
    && node.objectIds.length > 0
    && node.objectIds.every((id) => planObjects.has(id)))
}

/** 方案目录/任务目录里的安全后缀。 */
export function taskSlug(node: Pick<TaskNode, 'assetClass' | 'taskId'>): string {
  const tail = text(node.taskId).split('-').pop() ?? ''
  return `${node.assetClass}-${tail}`
}
