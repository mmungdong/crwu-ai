import type {
  ValuationWorkflowGraphNodeView,
  ValuationWorkflowNodeView,
  ValuationWorkflowProgressView,
  ValuationWorkflowQuestion,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { TemplateMarketCandidate, TemplateMarketNodeId, TemplateMarketPlan } from '../../../../shared/contracts/valuation-template-market.ts'

/**
 * Presentation model for the template-driven market workface.
 *
 * Every node, state, count and label is derived from the Host projection. The demo
 * fixture lives outside this module and is marked as fixture data by the caller.
 */

export type MarketNodeTone = 'done' | 'current' | 'executing' | 'pending' | 'restricted' | 'failed' | 'skipped'

export interface MarketNodeView {
  id: TemplateMarketNodeId
  index: number
  label: string
  description: string
  meta: string
  state: MarketNodeTone
  stateLabel: string
  edge?: string
  parallel: boolean
  conditional: boolean
  gaps: string[]
}

export interface MarketStatusView {
  tone: 'waiting' | 'queued' | 'executing' | 'done' | 'restricted' | 'failed' | 'skipped' | 'idle'
  text: string
}

export interface MarketSummaryView {
  materials: { value: string; sub: string }
  template: { value: string; sub: string }
  progress: { value: string; sub: string }
}

export interface MarketView {
  title: string
  subtitle: string
  project: string
  task: string
  code: string
  updatedAt: string
  status: MarketStatusView
  summary: MarketSummaryView
  nodes: MarketNodeView[]
  currentNodeId: TemplateMarketNodeId | null
  currentNodeLabel: string
  currentIndex: number
  pendingQuestionCount: number
  selectedCaseIds: string[]
  candidateVersion: number
  candidates: TemplateMarketCandidate[]
  plan: TemplateMarketPlan | null
  deliveryKind: string | null
  outcome: string | null
  fixture: boolean
}

export const MARKET_NODE_META: ReadonlyArray<{
  id: TemplateMarketNodeId
  label: string
  description: string
  parallel?: boolean
  edge?: string
  conditional?: boolean
}> = [
  { id: 'templates', label: '读取市场法模板与说明', description: '读取知识库中的市场法模板与填写说明。', parallel: true },
  { id: 'materials', label: '读取用户资料', description: '读取本轮上传资料并登记出处。', parallel: true },
  { id: 'collection-plan', label: '制定采集方案', description: '按模板字段与对象事实形成采集方案。', edge: '汇合' },
  { id: 'confirm-plan', label: '确认采集方案', description: '确认模板、范围、价格口径与来源后才能检索。' },
  { id: 'search-listings', label: '检索并读取列表页', description: '按已确认方案读取列表页。' },
  { id: 'candidate-workbook', label: '初筛并生成候选案例表', description: '初筛并生成真实候选案例表。' },
  { id: 'select-cases', label: '选择拟核实案例', description: '选择需要核实详情的案例。' },
  { id: 'inspect-details', label: '读取详情与截图', description: '仅读取所选案例详情并保存截图。', conditional: true },
  { id: 'check-inputs', label: '检查输入并确定交付范围', description: '核对可计算输入与交付范围。' },
  { id: 'fill-template', label: '回填模板并计算', description: '回填原模板副本并执行实际具备能力的计算。', conditional: true },
  { id: 'validate-delivery', label: '校验与交付', description: '校验交付件并保留限制说明。' },
]

export const MARKET_NODE_IDS: readonly TemplateMarketNodeId[] = MARKET_NODE_META.map((node) => node.id)

const STATE_LABELS: Record<MarketNodeTone, string> = {
  done: '已完成',
  current: '等待回答',
  executing: '执行中',
  pending: '待执行',
  restricted: '受限完成',
  failed: '执行失败',
  skipped: '已跳过',
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

export function nodeToneOf(state: string, isCurrent = false): MarketNodeTone {
  if (state === 'passed') return 'done'
  if (state === 'waiting') return 'current'
  if (state === 'running') return 'executing'
  if (state === 'partial') return 'restricted'
  if (state === 'failed' || state === 'blocked') return 'failed'
  if (state === 'cancelled') return 'skipped'
  return isCurrent ? 'current' : 'pending'
}

export function statusOf(progress: ValuationWorkflowProgressView, pendingQuestionCount: number): MarketStatusView {
  const nodeLabel = currentNodeOf(progress)?.label ?? ''
  switch (progress.status) {
    case 'waiting-user':
      return { tone: 'waiting', text: pendingQuestionCount > 0
        ? `等待你的选择 · ${pendingQuestionCount} 项待确认`
        : '等待你的确认 · 可以提交' }
    case 'running':
      return { tone: 'executing', text: nodeLabel === '' ? '正在执行' : `正在执行 · ${nodeLabel}` }
    case 'completed':
      return { tone: 'done', text: '已完成 · 可以查看交付' }
    case 'partial':
      return { tone: 'restricted', text: '带限制完成 · 保留待核说明' }
    case 'failed':
    case 'blocked':
      return { tone: 'failed', text: '执行失败 · 可恢复' }
    case 'cancelled':
      return { tone: 'skipped', text: '已取消' }
    default:
      return { tone: 'idle', text: '等待开始' }
  }
}

function currentNodeOf(progress: ValuationWorkflowProgressView): ValuationWorkflowGraphNodeView | undefined {
  const nodes = Array.isArray(progress.graph?.nodes) ? progress.graph.nodes : []
  const market = progress.market
  if (market !== undefined && market !== null) {
    return nodes.find((node) => node.templateMarketNodeId === market.currentNode)
  }
  return nodes.find((node) => node.state === 'waiting' || node.state === 'running')
}

function stageOfQuestion(question: ValuationWorkflowQuestion): string {
  return text(question.nodeId)
}

export function pendingQuestionsOf(
  progress: ValuationWorkflowProgressView,
  stage: TemplateMarketNodeId,
): ValuationWorkflowQuestion[] {
  const questions = progress.questionnaire?.questions
  if (!Array.isArray(questions)) return []
  return questions.filter((question) => question.applicable !== false
    && question.required !== false
    && (question.answer === null || question.answer === undefined)
    && (stageOfQuestion(question) === stage
      || stageOfQuestion(question).endsWith(`:${stage}`)
      || stageOfQuestion(question).endsWith(`:template-market:${stage}`)))
}

function nodeDescription(node: ValuationWorkflowGraphNodeView, meta: (typeof MARKET_NODE_META)[number], state: MarketNodeTone): string {
  const summary = text((node as { summary?: unknown }).summary)
  if (summary !== '') return summary
  if (state === 'failed') return text(node.gaps[0]) || '执行失败，请打开节点查看原因和恢复操作。'
  if (state === 'pending') return meta.description
  if (state === 'executing') return '正在执行当前节点。'
  return meta.description
}

function nodeMetaText(node: ValuationWorkflowGraphNodeView, state: MarketNodeTone): string {
  const summary = record((node as { marketSummary?: unknown }).marketSummary)
  const meta = summary === null ? '' : text(summary.meta)
  if (meta !== '') return meta
  if (state === 'done') return '已完成'
  if (state === 'current') return '等待回答'
  if (state === 'executing') return '处理中'
  if (state === 'failed') return '需处理'
  if (state === 'restricted') return '待核'
  if (state === 'skipped') return '未执行'
  return '待执行'
}

function nodesOf(progress: ValuationWorkflowProgressView): ValuationWorkflowGraphNodeView[] {
  return Array.isArray(progress.graph?.nodes) ? progress.graph.nodes : []
}

export function deriveMarketView(
  progress: ValuationWorkflowProgressView,
  detail: ValuationWorkflowNodeView | null = null,
  options: { queued?: boolean } = {},
): MarketView {
  const current = currentNodeOf(progress)
  const currentId = (current?.templateMarketNodeId ?? progress.market?.currentNode ?? null) as TemplateMarketNodeId | null
  const currentIndex = Math.max(1, MARKET_NODE_META.findIndex((node) => node.id === currentId) + 1)
  const pendingQuestionCount = currentId === null ? 0 : pendingQuestionsOf(progress, currentId).length
  const graphNodes = nodesOf(progress)
  const hostNodes = new Map((progress.market?.nodes ?? []).map((node) => [node.nodeId, node]))
  const waitingCases = (progress.market?.candidates?.length ?? 0)
  const nodes = MARKET_NODE_META.map((meta, offset) => {
    const graphNode = graphNodes.find((node) => node.templateMarketNodeId === meta.id)
    const state = nodeToneOf(graphNode?.state ?? 'pending', meta.id === currentId)
    const summaryNode = graphNode ?? {
      nodeId: meta.id,
      label: meta.label,
      state: 'pending',
      gaps: [],
    }
    const host = hostNodes.get(meta.id)
    return {
      id: meta.id,
      index: offset + 1,
      label: meta.label,
      description: host?.summary !== undefined && host.summary !== '' ? host.summary
        : meta.id === 'select-cases' && state === 'current' ? `${waitingCases} 条候选待选择；需确认后续处理方式。`
          : nodeDescription(summaryNode, meta, state),
      meta: host?.meta !== undefined && host.meta !== '' ? host.meta : nodeMetaText(summaryNode, state),
      state,
      stateLabel: STATE_LABELS[state],
      ...(meta.edge === undefined ? {} : { edge: meta.edge }),
      parallel: meta.parallel === true,
      conditional: meta.conditional === true,
      gaps: Array.isArray(summaryNode.gaps) ? summaryNode.gaps.slice(0, 4) : [],
    } satisfies MarketNodeView
  })
  const status = options.queued === true
    ? { tone: 'queued' as const, text: '回答已保存 · 等待执行' }
    : statusOf(progress, pendingQuestionCount)
  const plan = progress.market?.plan ?? null
  const templatePath = plan === null ? '' : text(plan.template?.relativePath)
  const templateName = templatePath === '' ? '尚未确定' : templatePath.replace(/\\/g, '/').split('/').pop() ?? templatePath
  const fields = plan === null ? 0 : (plan.requirements?.fields?.length ?? 0)
  const priceBasis = plan === null ? '' : plan.priceBasis === 'listing' ? '挂牌价' : plan.priceBasis === 'transaction' ? '成交价' : ''
  const materialsNode = nodes.find(node => node.id === 'materials')
  const materialReceipt = hostNodes.get('materials')
  const sourceCount = plan?.providers?.length ?? 0
  const progressText = currentId === null
    ? '尚未开始'
    : `节点 ${String(currentIndex).padStart(2, '0')} / 11`
  const progressSub = pendingQuestionCount > 0
    ? `${pendingQuestionCount} 项待确认`
    : status.tone === 'restricted' ? '保留待核' : status.tone === 'done' ? '已交付' : '无待答问题'
  return {
    title: '估值工作流',
    subtitle: plan === null ? '房地产 · 市场法' : `房地产 · 市场法 · ${priceBasis === '' ? '价格口径待确认' : priceBasis}`,
    project: plan === null ? '市场法估值任务' : text(plan.subject?.useLabel) || '市场法估值任务',
    task: '任务草稿',
    code: text(progress.runId).slice(0, 18),
    updatedAt: text(progress.updatedAt),
    status,
    summary: {
      materials: {
        value: materialReceipt?.meta || (materialsNode?.state === 'done' || materialsNode?.state === 'restricted' ? '已读取'
          : materialsNode?.state === 'executing' ? '读取中' : materialsNode?.state === 'failed' ? '读取未完成' : '尚未读取'),
        sub: materialReceipt?.summary || '来源与页范围以资料节点回执为准',
      },
      template: {
        value: templateName,
        sub: plan === null ? '等待模板读取' : `${priceBasis || '价格口径待确认'} · ${fields} 个字段`,
      },
      progress: {
        value: progressText,
        sub: progressSub,
      },
    },
    nodes,
    currentNodeId: currentId,
    currentNodeLabel: current?.label ?? '',
    currentIndex,
    pendingQuestionCount,
    selectedCaseIds: Array.isArray(progress.market?.selectedCaseIds) ? progress.market.selectedCaseIds.slice() : [],
    candidateVersion: progress.market?.candidateVersion ?? 0,
    candidates: Array.isArray(progress.market?.candidates) ? progress.market.candidates.slice() : [],
    plan: plan as MarketView['plan'],
    deliveryKind: progress.deliveryKind ?? null,
    outcome: progress.outcome ?? null,
    fixture: false,
  }
}

export function nodeOf(view: MarketView, id: string): MarketNodeView | undefined {
  return view.nodes.find((node) => node.id === id)
}

export function nodeStateLabelOf(view: MarketView, id: string): string {
  return nodeOf(view, id)?.stateLabel ?? '待执行'
}

export function candidateCountText(view: MarketView): string {
  return `${view.selectedCaseIds.length} 条已选 · ${view.candidates.length} 条候选`
}

export function priceBasisLabelOf(plan: MarketView['plan']): string {
  const value = plan === null ? '' : text(plan.priceBasis)
  return value === 'listing' ? '挂牌价' : value === 'transaction' ? '成交价' : '价格性质待确认'
}

export function nodeIndexText(index: number): string {
  return String(index).padStart(2, '0')
}

export function planProviderLabels(plan: MarketView['plan']): string[] {
  if (plan === null) return []
  const labels: Record<string, string> = { lianjia: '链家', fang: '房天下', '58': '58同城', anjuke: '安居客' }
  return (plan.providers ?? []).map((provider) => labels[provider] ?? provider)
}

export function filterRangeText(plan: MarketView['plan']): string {
  if (plan === null) return ''
  const min = numberText(plan.filters?.areaMin)
  const max = numberText(plan.filters?.areaMax)
  if (min === '' && max === '') return '面积范围待确认'
  return `${min || '不限'}–${max || '不限'} ㎡`
}
