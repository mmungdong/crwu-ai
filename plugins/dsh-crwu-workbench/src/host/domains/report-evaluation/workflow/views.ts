import type { TemplateMarketNodeId } from '../../../../shared/contracts/valuation-template-market.ts'
/**
 * Read-only Host projection for the valuation workflow pane.
 *
 * The projector consumes one accepted snapshot plus the actual compiled graph
 * descriptor and returns plain serializable facts. It performs no IO, starts no
 * child and calls no callback. Adopted rules never mix with read documents, and
 * every value keeps the provenance the Host can actually prove.
 */
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowFieldSourceKind,
  type ValuationWorkflowGraphEdgeView,
  type ValuationWorkflowGraphNodeView,
  type ValuationWorkflowGraphView,
  type ValuationWorkflowKnowledgeRefView,
  type ValuationWorkflowNodeFieldView,
  type ValuationWorkflowNodeView,
  type ValuationWorkflowProgressView,
  type ValuationWorkflowReadSourceView,
  type ValuationWorkflowRevisionChange,
  type ValuationWorkflowSnapshot,
  type ValuationWorkflowStage,
  type ValuationWorkflowStageReceipt,
  type ValuationWorkflowStageState,
  type ValuationWorkflowStageView,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { ValuationWorkflowQuestionnaire } from '../../../../shared/contracts/valuation-questionnaire.ts'
import { TEMPLATE_MARKET_NODES } from '../../../../shared/contracts/valuation-template-market.ts'
import { nodeFailure, readNodeFailure } from './failure.ts'

export interface WorkflowInputContext {
  userInput: string
  materials: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
}

export interface ProjectWorkflowSnapshotInput {
  snapshot: ValuationWorkflowSnapshot
  graph: ValuationWorkflowGraphView
  selectedNodeId: string
  /** Actual admitted inputs for the router node; never inferred from intent output. */
  inputContext?: WorkflowInputContext
}

export interface ProjectedWorkflowView {
  progress: ValuationWorkflowProgressView
  detail: ValuationWorkflowNodeView | null
}

/** The stage that owns each editable object field; only these stay editable. */
const RIGHTS_FIELDS = new Set<string>(['useLabel', 'areaSqm'])

const INPUT_LABELS: Record<string, string> = {
  objectId: '估值对象标识',
  useLabel: '原始用途',
  areaSqm: '建筑面积（㎡）',
  purpose: '评估目的',
  baseDate: '评估基准日',
  mode: '评估口径',
  promptSupplement: '节点补充说明',
}

const OUTPUT_LABELS: Record<string, string> = {
  objectId: '估值对象标识',
  useLabel: '原始用途',
  areaSqm: '建筑面积（㎡）',
  method: '估值方法',
  algorithm: '计算口径',
  methodOutput: '方法输出',
  sourceFacts: '要素来源事实',
  adoptedFacts: '已采用要素事实',
  samples: '可比样本',
  requirements: '采用要求候选',
  acceptedRequirementIds: '已采用要求',
  boundInputs: '计算绑定输入',
  unitPrice: '评估单价（元/㎡）',
  totalPrice: '评估总价（元）',
  checked: '复核结论',
  limitations: '限制条件',
  issues: '复核问题',
  unresolved: '未解决事项',
  artifacts: '交付产物',
  verified: '验收产物',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function cloneJson<T>(value: T): T {
  // Optional facts may be absent; JSON.parse(undefined) would throw and lose the node.
  const encoded = JSON.stringify(value)
  return encoded === undefined ? value : JSON.parse(encoded) as T
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  // Keep the actual number; never round an arbitrary input to two decimals.
  const text = String(value)
  const matched = /^(-?)(\d+)(\.\d+)?$/.exec(text)
  if (matched === null) return text
  const sign = matched[1] ?? ''
  const integer = matched[2] ?? ''
  const decimal = matched[3] ?? ''
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${decimal}`
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => formatFieldValue(item)).join('、')
  if (isRecord(value)) {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

/** Exact-or-JSON equality for matching an accepted change to the displayed value. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (isRecord(left) && isRecord(right)) {
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Every accepted field correction up to the current revision, newest revision
 * first, so a matching after-value resolves to the most recent user correction.
 */
function changeHistory(snapshot: ValuationWorkflowSnapshot): ValuationWorkflowRevisionChange[] {
  const records = snapshot.revisions
    .filter((item) => item.revision <= snapshot.revision)
    .slice()
    .sort((left, right) => right.revision - left.revision)
  const changes: ValuationWorkflowRevisionChange[] = []
  for (const record of records) {
    if (Array.isArray(record.changes)) changes.push(...record.changes)
  }
  return changes
}

interface AdoptedFact {
  field: string
  value: unknown
  source: Record<string, unknown>
}

function adoptedFacts(snapshot: ValuationWorkflowSnapshot): AdoptedFact[] {
  const outputs = snapshot.stages.elements.outputs
  const raw = isRecord(outputs) && Array.isArray(outputs.adoptedFacts) ? outputs.adoptedFacts : []
  const facts: AdoptedFact[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const field = asString(item.field)
    if (field === '' || !isRecord(item.source)) continue
    facts.push({ field, value: item.value, source: item.source })
  }
  return facts
}

function materialSource(fact: AdoptedFact): string {
  const materialId = asString(fact.source.materialId)
  return materialId === '' ? '材料来源' : `材料：${materialId}`
}

function readSourceViews(receipt: ValuationWorkflowStageReceipt): ValuationWorkflowReadSourceView[] {
  const raw = isRecord(receipt.inputs) && Array.isArray(receipt.inputs.knowledgeRefs)
    ? receipt.inputs.knowledgeRefs
    : []
  const views: ValuationWorkflowReadSourceView[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    views.push({
      sourceId: asString(item.sourceId),
      path: asString(item.path),
      digest: asString(item.digest),
      coverage: asString(item.coverageNote),
    })
  }
  return views
}

function projectInputs(
  snapshot: ValuationWorkflowSnapshot,
  receipt: ValuationWorkflowStageReceipt,
  stage: ValuationWorkflowStage,
): ValuationWorkflowNodeFieldView[] {
  const inputs = isRecord(receipt.inputs) ? receipt.inputs : {}
  const facts = isRecord(inputs.facts) ? inputs.facts : {}
  const confirmed = isRecord(facts.confirmedFacts) ? facts.confirmedFacts : facts
  const changes = changeHistory(snapshot)
  const adopted = adoptedFacts(snapshot)
  const fields: ValuationWorkflowNodeFieldView[] = []

  for (const [field, value] of Object.entries(confirmed)) {
    // Shared object fields keep a prior user correction; other fields stay node-scoped.
    const change = RIGHTS_FIELDS.has(field)
      ? changes.find((item) => item.field === field && sameValue(item.after, value))
      : changes.find((item) => item.nodeId === stage && item.field === field && sameValue(item.after, value))
    // Material provenance needs an adoptedFact whose value is the displayed input.
    const fact = adopted.find((item) => item.field === field && sameValue(item.value, value))
    let sourceKind: ValuationWorkflowFieldSourceKind = 'confirmed'
    let source = '已确认输入'
    if (change !== undefined) {
      sourceKind = 'user'
      source = asString(change.source) === '' ? '员工更正' : asString(change.source)
    } else if (fact !== undefined) {
      sourceKind = 'material'
      source = materialSource(fact)
    }
    fields.push({
      field,
      label: INPUT_LABELS[field] ?? field,
      value: formatFieldValue(value),
      source,
      sourceKind,
      editable: stage === 'rights' && RIGHTS_FIELDS.has(field),
      rawValue: cloneJson(value),
    })
  }

  const supplement = asString(inputs.promptSupplement)
  const supplementChange = changes.find((item) => item.nodeId === stage
    && item.field === 'promptSupplement' && sameValue(item.after, supplement))
  fields.push({
    field: 'promptSupplement',
    label: INPUT_LABELS.promptSupplement ?? '节点补充说明',
    value: supplement,
    source: supplementChange === undefined ? '节点补充说明' : asString(supplementChange.source),
    sourceKind: supplementChange === undefined ? 'confirmed' : 'user',
    editable: true,
    rawValue: supplement,
  })

  return fields
}

function outputSourceKind(stage: ValuationWorkflowStage, field: string): ValuationWorkflowFieldSourceKind {
  if (stage === 'calculation' && (field === 'unitPrice' || field === 'totalPrice')) return 'program'
  return 'model'
}

function projectOutputs(
  receipt: ValuationWorkflowStageReceipt,
  stage: ValuationWorkflowStage,
): ValuationWorkflowNodeFieldView[] {
  const outputs = isRecord(receipt.outputs) ? receipt.outputs : {}
  const fields: ValuationWorkflowNodeFieldView[] = []
  for (const [field, value] of Object.entries(outputs)) {
    const sourceKind = outputSourceKind(stage, field)
    fields.push({
      field,
      label: OUTPUT_LABELS[field] ?? field,
      value: formatFieldValue(value),
      source: sourceKind === 'program' ? 'Host 计算' : '模型输出',
      sourceKind,
      editable: false,
      rawValue: cloneJson(value),
    })
  }
  return fields
}

function planBasisKnowledge(snapshot: ValuationWorkflowSnapshot): ValuationWorkflowKnowledgeRefView[] {
  const basis = snapshot.plan?.basis
  if (!Array.isArray(basis)) return []
  const refs: ValuationWorkflowKnowledgeRefView[] = []
  for (const item of basis) {
    if (!isRecord(item)) continue
    const source = isRecord(item.source) ? item.source : {}
    refs.push({
      sourceId: asString(item.sourceId) || asString(source.sourceId),
      path: asString(item.path) || asString(source.path),
      section: asString(item.section) || asString(source.section),
      quote: asString(item.quote) || asString(item.statement) || asString(source.quote),
    })
  }
  return refs
}

function projectKnowledge(
  snapshot: ValuationWorkflowSnapshot,
  receipt: ValuationWorkflowStageReceipt,
  stage: ValuationWorkflowStage,
): ValuationWorkflowKnowledgeRefView[] {
  if (stage === 'plan') return planBasisKnowledge(snapshot)
  if (stage !== 'evidence') return []

  // Only ids the Host actually accepted may resolve a candidate into adopted knowledge.
  const outputs = isRecord(receipt.outputs) ? receipt.outputs : {}
  const acceptedIds = Array.isArray(outputs.acceptedRequirementIds)
    ? outputs.acceptedRequirementIds.filter((value): value is string => typeof value === 'string')
    : []
  const candidates = Array.isArray(outputs.requirements) ? outputs.requirements : []
  const reads = readSourceViews(receipt)
  const refs: ValuationWorkflowKnowledgeRefView[] = []
  const seen = new Set<string>()
  for (const requirementId of acceptedIds) {
    const candidate = candidates.find((item) => isRecord(item) && item.requirementId === requirementId)
    if (!isRecord(candidate)) continue
    const source = isRecord(candidate.source) ? candidate.source : {}
    const sourceId = asString(source.sourceId)
    if (sourceId === '' || seen.has(sourceId)) continue
    seen.add(sourceId)
    const metadata = reads.find((item) => item.sourceId === sourceId)
    refs.push({
      sourceId,
      path: metadata?.path ?? '',
      section: asString(source.section),
      quote: asString(source.quote),
    })
  }
  return refs
}

function projectDependents(graph: ValuationWorkflowGraphView, selectedNodeId: string): Array<{ nodeId: string; label: string }> {
  const reachable = new Set<string>()
  const queue = [selectedNodeId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of graph.edges) {
      if (edge.source !== current || reachable.has(edge.target)) continue
      reachable.add(edge.target)
      queue.push(edge.target)
    }
  }
  return graph.nodes
    .filter((node) => node.stage !== undefined && node.nodeId !== selectedNodeId && reachable.has(node.nodeId))
    .map((node) => ({ nodeId: node.nodeId, label: node.label }))
}

function professionalDetail(
  snapshot: ValuationWorkflowSnapshot,
  graph: ValuationWorkflowGraphView,
  graphNode: ValuationWorkflowGraphNodeView,
  stage: ValuationWorkflowStage,
): ValuationWorkflowNodeView {
  const receipt = snapshot.stages[stage]
  const legacyContractFault = receipt.gaps.includes('子会话没有返回本节点允许的结构化成果')
  const failure = readNodeFailure(receipt.outputs.failure) ?? (legacyContractFault
    ? nodeFailure('output-contract', ['历史回执只记录了结构化成果被拒绝，未记录具体校验字段；无法据此确定需要补充的业务信息。'])
    : nodeFailure(receipt.state === 'failed' || snapshot.errorKind === 'stop-unknown' ? 'system' : 'business', receipt.gaps))
  return {
    nodeId: graphNode.nodeId,
    stage,
    label: graphNode.label,
    revision: snapshot.revision,
    current: true,
    sessionId: receipt.sessionId,
    inputs: projectInputs(snapshot, receipt, stage),
    outputs: projectOutputs(receipt, stage),
    knowledge: projectKnowledge(snapshot, receipt, stage),
    readSources: readSourceViews(receipt),
    gaps: [...receipt.gaps],
    ...(['blocked', 'failed'].includes(receipt.state) ? { failure } : {}),
    dependents: projectDependents(graph, graphNode.nodeId),
    rawInputs: cloneJson(receipt.inputs),
    rawOutputs: cloneJson(receipt.outputs),
  }
}

function isRouterNode(nodeId: string): boolean {
  return nodeId.endsWith(':intent-router') || nodeId === 'intent-router'
}

/** True only before any professional stage has been attempted. */
function noProfessionalStageAttempted(snapshot: ValuationWorkflowSnapshot): boolean {
  return VALUATION_WORKFLOW_STAGES.every((stage) => snapshot.stages[stage].attempt === 0)
}

/**
 * A router that stopped before any stage ran: no adopted intent, no route, a real
 * intent child id, and a blocked/failed run. Resolved routes never take this path.
 */
function routerStoppedBeforeStages(snapshot: ValuationWorkflowSnapshot): boolean {
  const routing = snapshot.routing
  if (routing === null || routing.intent !== null) return false
  if (routing.route !== '' || routing.intentSessionId.trim() === '') return false
  if (snapshot.status !== 'blocked' && snapshot.status !== 'failed') return false
  return noProfessionalStageAttempted(snapshot)
}

/** Actual router state from the routing receipt; never inferred from intent output. */
function routerStateOf(snapshot: ValuationWorkflowSnapshot): ValuationWorkflowStageState {
  const status = snapshot.routing?.intent?.status
  if (status === 'resolved') return 'passed'
  if (status === 'needs-clarification') return 'waiting'
  if (status === 'unsupported') return 'blocked'
  if (routerStoppedBeforeStages(snapshot)) return snapshot.status === 'failed' ? 'failed' : 'blocked'
  return 'pending'
}

/** Gaps are the actual unresolved router questions or the real stop error, never rewritten. */
function routerGapsOf(snapshot: ValuationWorkflowSnapshot): string[] {
  const questions = snapshot.routing?.intent?.questions
  if (Array.isArray(questions)) {
    const asked = questions.filter((item): item is string => typeof item === 'string')
    if (asked.length > 0) return asked
  }
  if (routerStoppedBeforeStages(snapshot) && snapshot.error.trim() !== '') return [snapshot.error]
  return []
}

/** Deep-cloned plain record; `{}` when the source is absent or not a record. */
function deepRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {}
}

function routerInputs(inputContext: WorkflowInputContext | undefined): ValuationWorkflowNodeFieldView[] {
  if (inputContext === undefined) return []
  return [
    {
      field: 'userInput',
      label: '用户输入',
      value: inputContext.userInput,
      source: '用户输入',
      sourceKind: 'user',
      editable: false,
    },
    {
      field: 'materials',
      label: '本轮材料',
      value: formatFieldValue(inputContext.materials),
      source: '材料来源',
      sourceKind: 'material',
      editable: false,
    },
  ]
}

function routerDetail(
  snapshot: ValuationWorkflowSnapshot,
  graph: ValuationWorkflowGraphView,
  graphNode: ValuationWorkflowGraphNodeView,
  inputContext: WorkflowInputContext | undefined,
): ValuationWorkflowNodeView {
  const routing = snapshot.routing
  const intent = routing?.intent ?? null
  const outputs: ValuationWorkflowNodeFieldView[] = []
  if (routing !== null) {
    outputs.push({
      field: 'route',
      label: '实际路由',
      value: routing.route,
      source: 'Host 路由',
      sourceKind: 'program',
      editable: false,
    })
  }
  if (intent !== null) {
    outputs.push(
      { field: 'business', label: '业务类型', value: intent.business, source: '模型输出', sourceKind: 'model', editable: false },
      { field: 'assetType', label: '资产类型', value: intent.assetType ?? '', source: '模型输出', sourceKind: 'model', editable: false },
      { field: 'status', label: '意图状态', value: intent.status, source: 'Host 校验', sourceKind: 'program', editable: false },
    )
  }
  return {
    nodeId: graphNode.nodeId,
    stage: null,
    label: graphNode.label,
    revision: snapshot.revision,
    current: true,
    sessionId: routing?.intentSessionId ?? '',
    inputs: routerInputs(inputContext),
    outputs,
    knowledge: [],
    readSources: [],
    gaps: routerGapsOf(snapshot),
    ...(['blocked', 'failed'].includes(graphNode.state) ? { failure: nodeFailure(
      snapshot.routing?.intent?.status === 'needs-clarification' ? 'business' : 'system', routerGapsOf(snapshot)) } : {}),
    dependents: projectDependents(graph, graphNode.nodeId),
    rawInputs: deepRecord(inputContext),
    rawOutputs: deepRecord(routing),
    route: routing?.route ?? '',
    evidence: intent === null ? [] : cloneJson(intent.evidence),
  }
}

function progressGraph(snapshot: ValuationWorkflowSnapshot, graph: ValuationWorkflowGraphView): ValuationWorkflowGraphView {
  const nodes: ValuationWorkflowGraphNodeView[] = graph.nodes.map((node) => {
    if (isRouterNode(node.nodeId)) {
      return {
        nodeId: node.nodeId,
        label: node.label,
        state: routerStateOf(snapshot),
        gaps: routerGapsOf(snapshot),
      }
    }
    const receipt = node.stage === undefined ? undefined : snapshot.stages[node.stage]
    const view: ValuationWorkflowGraphNodeView = {
      nodeId: node.nodeId,
      label: node.label,
      state: receipt?.state ?? 'pending',
      gaps: receipt === undefined ? [] : [...receipt.gaps],
    }
    if (node.stage !== undefined) view.stage = node.stage
    return view
  })
  const edges: ValuationWorkflowGraphEdgeView[] = graph.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    conditional: edge.conditional,
  }))
  return { graphId: graph.graphId, version: graph.version, nodes, edges }
}

function progressStages(snapshot: ValuationWorkflowSnapshot): ValuationWorkflowStageView[] {
  return VALUATION_WORKFLOW_STAGES.map((stage) => {
    const receipt = snapshot.stages[stage]
    const accepted = receipt.state === 'passed' || receipt.state === 'partial'
    return {
      stage,
      state: receipt.state,
      objectCount: receipt.attempt > 0 ? 1 : 0,
      passedCount: accepted ? 1 : 0,
      waitingCount: receipt.state === 'waiting' ? 1 : 0,
      gaps: [...receipt.gaps],
    }
  })
}

/** Exact compiled node id that owns a business stage, or '' when the graph has none. */
function ownerNodeIdOf(graph: ValuationWorkflowGraphView, stage: ValuationWorkflowStage): string {
  return graph.nodes.find((node) => node.stage === stage)?.nodeId ?? ''
}

/**
 * Current editable conditions plus honest read-only initial choices.
 *
 * Editable entries need a real graph owner; a synthetic/legacy graph without that
 * stage never exposes an actionable edit. Values and raw structured copies are
 * cloned so the caller cannot mutate live run state.
 */
function globalInputsOf(
  snapshot: ValuationWorkflowSnapshot,
  graph: ValuationWorkflowGraphView,
): Array<ValuationWorkflowNodeFieldView & { nodeId: string }> {
  const fields: Array<ValuationWorkflowNodeFieldView & { nodeId: string }> = []
  const push = (
    field: string,
    label: string,
    value: unknown,
    source: string,
    sourceKind: ValuationWorkflowFieldSourceKind,
    editable: boolean,
    stage?: ValuationWorkflowStage,
  ): void => {
    const nodeId = snapshot.templateMarket && stage !== undefined
      ? graph.nodes.find(n => n.templateMarketNodeId === (stage === 'rights' ? 'materials' : 'collection-plan'))?.nodeId ?? ''
      : stage === undefined ? '' : ownerNodeIdOf(graph, stage)
    if (editable && nodeId === '') return
    fields.push({
      field,
      label,
      value: formatFieldValue(value),
      source,
      sourceKind,
      editable,
      nodeId,
      rawValue: cloneJson(value),
    })
  }

  push('objectId', INPUT_LABELS.objectId ?? 'objectId', snapshot.object.objectId,
    '估值范围', 'confirmed', false)
  push('useLabel', INPUT_LABELS.useLabel ?? 'useLabel', snapshot.object.useLabel,
    '已确认对象', 'confirmed', true, 'rights')
  push('areaSqm', INPUT_LABELS.areaSqm ?? 'areaSqm', snapshot.object.areaSqm,
    '已确认对象', 'confirmed', true, 'rights')

  const current = snapshot.currentInputs
  if (current !== undefined) {
    push('purpose', INPUT_LABELS.purpose ?? 'purpose', current.purpose,
      '当前估值条件', 'confirmed', true, 'elements')
    push('baseDate', INPUT_LABELS.baseDate ?? 'baseDate', current.baseDate,
      '当前估值条件', 'confirmed', true, 'elements')
    if (!snapshot.templateMarket) push('mode', INPUT_LABELS.mode ?? 'mode', current.mode,
      '当前估值条件', 'confirmed', true, 'elements')
  }
  return fields
}

function resolveGraphNode(
  graph: ValuationWorkflowGraphView,
  selectedNodeId: string,
): ValuationWorkflowGraphNodeView | undefined {
  // Only an exact actual graph node id is inspectable; no bare-stage aliases.
  return graph.nodes.find((node) => node.nodeId === selectedNodeId)
}

function projectQuestionnaire(
  questionnaire: ValuationWorkflowQuestionnaire, graph: ValuationWorkflowGraphView,
): ValuationWorkflowQuestionnaire {
  const result = cloneJson(questionnaire)
  const owner = (nodeId: string): string => {
    if (graph.nodes.some(node => node.nodeId === nodeId)) return nodeId
    if (nodeId === 'intent') return graph.nodes.find(node => isRouterNode(node.nodeId))?.nodeId ?? nodeId
    return graph.nodes.find(node => node.stage === nodeId)?.nodeId ?? nodeId
  }
  for (const item of [...result.questions, ...result.drafts, ...result.notes, ...result.legacy]) item.nodeId = owner(item.nodeId)
  for (const submission of result.submissions) {
    submission.nodeId = owner(submission.nodeId)
    for (const note of submission.notes) note.nodeId = owner(note.nodeId)
    for (const question of submission.questions ?? []) if (question.nodeId !== undefined) question.nodeId = owner(question.nodeId)
  }
  return result
}

function projectMarketSnapshot(input: ProjectWorkflowSnapshotInput): ProjectedWorkflowView {
  const { snapshot } = input
  const market = snapshot.templateMarket!
  const graph = cloneJson(input.graph)
  for (const node of graph.nodes) {
    const receipt = node.templateMarketNodeId ? market.receipts[node.templateMarketNodeId] : undefined
    const interrupted = snapshot.status === 'failed' && market.status === 'running' && receipt?.state === 'running'
    node.state = interrupted ? 'failed' : receipt?.state ?? 'pending'
    node.gaps = interrupted ? [snapshot.error || '本轮执行中断，请核对当前任务']
      : receipt?.output?.failure ? [...new Set([receipt.output.failure.reason, ...receipt.output.failure.requirements].filter(Boolean))]
        : receipt?.output?.limitations ?? []
  }
  const marketNodes = (TEMPLATE_MARKET_NODES as readonly string[]).map((id) => {
    const receipt = market.receipts[id as keyof typeof market.receipts]
    const data = receipt?.output?.data as Record<string, unknown> | null | undefined
    const meta = (() => {
      if (receipt === undefined || data === null || data === undefined) return ''
      if (id === 'templates') return `${(data.profiles as unknown[] | undefined)?.length ?? 0} 个模板`
      if (id === 'materials') return `${Object.keys((data.subjectFacts as Record<string, unknown> | undefined) ?? {}).length} 项事实`
      if (id === 'collection-plan') return `${(data.plan as { providers?: string[] } | undefined)?.providers?.length ?? 0} 个来源`
      if (id === 'confirm-plan') return (data.accepted as boolean | undefined) === true ? '已确认' : '待确认'
      if (id === 'search-listings') return `${(data.candidates as unknown[] | undefined)?.length ?? 0} 条候选`
      if (id === 'candidate-workbook') return `${(data.caseIds as unknown[] | undefined)?.length ?? 0} 条候选`
      if (id === 'select-cases') return `${(data.selectedCaseIds as unknown[] | undefined)?.length ?? 0} 个案例`
      if (id === 'inspect-details') return `${(data.candidates as unknown[] | undefined)?.length ?? 0} 个案例`
      if (id === 'check-inputs') return `${(data.decision as { path?: string } | undefined)?.path ?? '待确认'}`
      if (id === 'fill-template') return `${(data.artifacts as unknown[] | undefined)?.length ?? 0} 个交付件`
      if (id === 'validate-delivery') return `${(data.deliveryKind as string | undefined) ?? '待交付'}`
      return ''
    })()
    const projected = graph.nodes.find(node => node.templateMarketNodeId === id)
    return { nodeId: id as TemplateMarketNodeId, state: projected?.state ?? receipt?.state ?? 'pending',
      summary: projected?.state === 'failed' ? projected.gaps[0] ?? snapshot.error : receipt?.output?.summary ?? '', meta }
  })
  const accepted = Object.values(market.receipts).filter(r => r.state === 'passed' || r.state === 'partial').length
  const progress: ValuationWorkflowProgressView = { runId: snapshot.runId, revision: snapshot.revision, status: snapshot.status,
    outcome: snapshot.outcome, deliveryKind: snapshot.delivery?.kind ?? null, referenceDelivered: snapshot.delivery?.referenceDelivered === true,
    formalComplete: snapshot.delivery?.formalComplete === true, waiting: snapshot.status === 'waiting-user', stages: [],
    acceptedTaskCount: accepted, plannedTaskCount: null, percentage: null, clarification: null,
    questionnaire: cloneJson(market.questionnaire), updatedAt: snapshot.updatedAt, graph, plan: null, result: null,
    revisions: cloneJson(snapshot.revisions), globalInputs: globalInputsOf(snapshot, graph), market: cloneJson({ currentNode: market.currentNode, plan: market.plan,
      candidates: market.candidates, candidateVersion: market.candidateVersion, selectedCaseIds: market.selectedCaseIds,
      artifacts: market.artifacts, nodes: marketNodes,
      recovery: { retryAllowed: snapshot.status === 'failed' && snapshot.errorKind !== 'stop-unknown' && snapshot.errorKind !== 'infrastructure',
        reason: snapshot.error } }) }
  const node = graph.nodes.find(n => n.nodeId === input.selectedNodeId)
  if (!node?.templateMarketNodeId) return { progress, detail: null }
  const receipt = market.receipts[node.templateMarketNodeId]
  const fields = (data: unknown): ValuationWorkflowNodeFieldView[] => !isRecord(data) ? [] : Object.entries(data).map(([field, value]) =>
    ({ field, label: field, value: formatFieldValue(value), rawValue: cloneJson(value), source: '节点已保存回执', sourceKind: 'program' }))
  const output = receipt?.output
  return { progress, detail: { nodeId: node.nodeId, stage: null, label: node.label, revision: snapshot.revision,
    current: market.currentNode === node.templateMarketNodeId, sessionId: '', inputs: fields(receipt?.inputs), outputs: fields(output?.data),
    knowledge: market.plan?.requirements.fields.flatMap(f => f.basis.map(b => ({ sourceId: b.sourceId, path: market.knowledge.find(k => k.sourceId === b.sourceId)?.location ?? '', section: f.label, quote: b.quote }))) ?? [],
    readSources: (receipt?.inputs?.knowledge ?? []).map(k => ({ sourceId: k.sourceId, path: k.location, digest: k.digest, coverage: '已载入节点上下文' })),
    gaps: node.gaps, ...(output?.failure ? { failure: cloneJson(output.failure) }
      : node.state === 'failed' ? { failure: { kind: 'system' as const, reason: snapshot.error || node.gaps[0] || '本轮执行中断', requirements: node.gaps,
        actions: [snapshot.errorKind === 'stop-unknown' ? '核对子会话停止状态，暂不能重试' : '保留当前任务，核对原因后恢复'] } } : {}),
    dependents: graph.nodes.filter(n => n.templateMarketNodeId && graph.edges.some(e => e.source === node.nodeId && e.target === n.nodeId)).map(n => ({ nodeId: n.nodeId, label: n.label })),
    rawInputs: deepRecord(receipt?.inputs), rawOutputs: deepRecord(output) } }
}

export function projectWorkflowSnapshot(input: ProjectWorkflowSnapshotInput): ProjectedWorkflowView {
  if (input.snapshot.templateMarket) return projectMarketSnapshot(input)
  const { snapshot, graph } = input
  const acceptedTaskCount = VALUATION_WORKFLOW_STAGES
    .filter((stage) => snapshot.stages[stage].state === 'passed' || snapshot.stages[stage].state === 'partial')
    .length

  const progress: ValuationWorkflowProgressView = {
    runId: snapshot.runId,
    revision: snapshot.revision,
    status: snapshot.status,
    outcome: snapshot.outcome,
    deliveryKind: snapshot.delivery?.kind ?? null,
    referenceDelivered: snapshot.delivery?.referenceDelivered === true,
    formalComplete: snapshot.delivery?.formalComplete === true,
    waiting: snapshot.status === 'waiting-user',
    stages: progressStages(snapshot),
    acceptedTaskCount,
    // No Host-validated workload total means unknown; never turn it into a percentage.
    plannedTaskCount: null,
    percentage: null,
    clarification: snapshot.clarification === null ? null : cloneJson(snapshot.clarification),
    updatedAt: snapshot.updatedAt,
    graph: progressGraph(snapshot, graph),
    plan: snapshot.plan === null ? null : cloneJson(snapshot.plan),
    result: snapshot.result === null ? null : cloneJson(snapshot.result),
    revisions: cloneJson(snapshot.revisions),
    globalInputs: globalInputsOf(snapshot, graph),
    ...(snapshot.questionnaire === undefined ? {} : { questionnaire: projectQuestionnaire(snapshot.questionnaire, graph) }),
  }

  const graphNode = resolveGraphNode(graph, input.selectedNodeId)
  if (graphNode === undefined) return { progress, detail: null }

  if (graphNode.stage !== undefined) {
    return { progress, detail: professionalDetail(snapshot, graph, graphNode, graphNode.stage) }
  }
  return {
    progress,
    detail: isRouterNode(graphNode.nodeId) ? routerDetail(snapshot, graph, graphNode, input.inputContext) : null,
  }
}
