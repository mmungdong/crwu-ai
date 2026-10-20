import type {
  ValuationWorkflowFieldSourceKind,
  ValuationWorkflowGraphNodeView,
  ValuationWorkflowStage,
  ValuationWorkflowStageState,
} from '../../../../../shared/contracts/valuation-workflow.ts'

/**
 * Pure presentation facts for the workflow workface (protocol 43).
 *
 * Every label below maps a Host-supplied enum to Simplified Chinese. Nothing here
 * infers progress, order or business steps: unknown values fall back to the raw
 * Host string so a new Host state never becomes an invented label.
 */

/** The submitted correction payload; the contract stays stable across callers. */
export interface ValuationWorkflowRevisionSubmission {
  nodeId: string
  expectedRevision: number
  changes: Array<{ field: string; value: string }>
  reason: string
  source: string
}

const STATUS_LABELS: Record<string, string> = {
  preparing: '正在准备资料',
  'awaiting-agent': '等待模型处理',
  running: '正在执行',
  'waiting-user': '等待员工处理',
  completed: '已完成',
  partial: '参考成果已交付',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
}

const OUTCOME_LABELS: Record<string, string> = {
  completed: '已完成',
  partial: '部分完成',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
}

const STAGE_LABELS: Record<ValuationWorkflowStage, string> = {
  elements: '基本要素',
  rights: '权属与面积',
  plan: '估值方案',
  evidence: '案例取证',
  calculation: '计算测算',
  review: '复核',
  delivery: '成果交付',
}

const STATE_LABELS: Record<ValuationWorkflowStageState, string> = {
  pending: '待执行',
  running: '进行中',
  waiting: '等待处理',
  passed: '已通过',
  partial: '部分完成',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
}

const SOURCE_KIND_LABELS: Record<ValuationWorkflowFieldSourceKind, string> = {
  material: '材料',
  // Host marks accepted upstream inputs and prompt supplements as `confirmed`.
  // They are confirmed employee/upstream input, never an adopted knowledge citation.
  confirmed: '已确认输入',
  model: '模型判断',
  program: '程序',
  user: '用户',
}

const MODE_LABELS: Record<string, string> = {
  formal: '正式评估',
  'listing-reference': '挂牌参考',
}

/** Real comparable-source providers; an unknown id stays raw (never a fabricated name). */
const PROVIDER_LABELS: Record<string, string> = {
  lianjia: '链家',
  fang: '房天下',
  anjuke: '安居客',
  '58': '58同城',
}

const METHOD_LABELS: Record<string, string> = {
  market: '市场法',
  income: '收益法',
  cost: '成本法',
  'listing-reference': '挂牌参考',
}

const ALGORITHM_LABELS: Record<string, string> = {
  'raw-unit-price-arithmetic-mean': '原始挂牌单价算术平均',
}

const SOURCE_STATE_LABELS: Record<string, string> = {
  verified: '已核实',
  unverified: '未核实',
  pending: '待核实',
  rejected: '已排除',
  failed: '取证失败',
  error: '取证失败',
}

const TRANSACTION_LABELS: Record<string, string> = {
  listing: '挂牌',
  transaction: '成交',
  sold: '成交',
  lease: '租赁',
}

/** Host question fields that are a closed decision, not free text. */
export const CLARIFICATION_MODE_FIELD = 'mode'
export const CLARIFICATION_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'listing-reference', label: '挂牌参考' },
  { value: 'formal', label: '正式评估' },
]

export function statusLabelOf(status: string): string {
  return STATUS_LABELS[status] ?? status
}

export function outcomeLabelOf(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome
}

export function stageLabelOf(stage: string): string {
  return STAGE_LABELS[stage as ValuationWorkflowStage] ?? stage
}

export function stateLabelOf(state: string): string {
  return STATE_LABELS[state as ValuationWorkflowStageState] ?? state
}

export function modeLabelOf(mode: string | null | undefined): string {
  if (mode === null || mode === undefined || mode === '') return ''
  return MODE_LABELS[mode] ?? mode
}

export function sourceKindLabelOf(kind: ValuationWorkflowFieldSourceKind | undefined): string | null {
  if (kind === undefined) return null
  return SOURCE_KIND_LABELS[kind] ?? String(kind)
}

function rawText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Numeric-looking Host value as text; an absent value is an em dash, never a zero. */
function valueText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const raw = rawText(value).trim()
  return raw === '' ? '—' : raw
}

export function providerLabelOf(providerId: string): string {
  const value = rawText(providerId)
  if (value === '') return ''
  return PROVIDER_LABELS[value] ?? value
}

export function planMethodLabelOf(method: string): string {
  const value = rawText(method)
  if (value === '') return ''
  return METHOD_LABELS[value] ?? value
}

export function algorithmLabelOf(algorithm: string): string {
  const value = rawText(algorithm)
  if (value === '') return ''
  return ALGORITHM_LABELS[value] ?? value
}

export function sourceStateLabelOf(state: string): string {
  const value = rawText(state)
  if (value === '') return ''
  return SOURCE_STATE_LABELS[value] ?? value
}

export function transactionTypeLabelOf(transactionType: string): string {
  const value = rawText(transactionType)
  if (value === '') return ''
  return TRANSACTION_LABELS[value] ?? value
}

/** Unit price with its unit; `元/㎡` is the only unit the Host actually reports. */
export function unitPriceTextOf(value: unknown): string {
  const text = valueText(value)
  return text === '—' ? text : `${text} 元/㎡`
}

export function areaTextOf(value: unknown): string {
  const text = valueText(value)
  return text === '—' ? text : `${text} ㎡`
}

/**
 * A safe public source URL: only http(s), never with embedded credentials.
 * Anything else returns null so the caller renders plain text instead of a link.
 */
export function safeExternalUrl(url: string): string | null {
  const value = rawText(url).trim()
  if (!/^https?:\/\//i.test(value)) return null
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/)[0] ?? ''
  if (authority === '' || authority.includes('@')) return null
  return value
}

export type ValuationWorkflowNodePhase = 'boundary' | 'preparation' | 'execution' | 'delivery'

/** Coarse visual band derived from the Host node identity, never a business step. */
export function phaseOfNode(node: ValuationWorkflowGraphNodeView): ValuationWorkflowNodePhase {
  if (node.nodeId === '__start__' || node.nodeId === '__end__') return 'boundary'
  if (node.stage === 'delivery') return 'delivery'
  if (node.stage === undefined) return 'preparation'
  return 'execution'
}

/**
 * The node the employee is actually on: the running/waiting node, else the last
 * passed one. Returns null when no Host state proves a current node.
 */
export function currentNodeIdOf(nodes: ValuationWorkflowGraphNodeView[]): string | null {
  const active = nodes.find((node) => node.state === 'running' || node.state === 'waiting')
  if (active !== undefined) return active.nodeId
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node.state === 'passed' || node.state === 'partial') return node.nodeId
  }
  return null
}
