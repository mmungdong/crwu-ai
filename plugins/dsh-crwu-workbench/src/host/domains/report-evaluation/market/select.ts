import { text } from '../../../../shared/utils/value.ts'
import type { ValuationCase } from './normalize.ts'

/**
 * **候选的批量筛选与优选**（协议 40 · 设计稿 §7.2「列表先批量筛选」/ §7.3「跨站去重与优选」）。
 *
 * ## 这一层负责"机械"，知识负责"业务"
 *
 * 采用几条（名额）、按什么顺序排（优先级）、来源的渠道顺序、以及每条候选是否合格 ——
 * 这些都是**业务事实**，由本轮知识正文声明、调用方传进来。**代码里没有默认名额、没有默认
 * 优先级、没有默认渠道顺序，也没有默认"合格"**：缺任何一条就如实拒绝或记未评估。
 *
 * 代码这一侧只做能被穷尽核对的事：
 *
 * 1. **知识评估是采用的前提**：没有 `assessments` 条目的候选是 `unreviewed`，绝不进入 adopted；
 * 2. **事实门禁**：交易性质未确认 / 挂牌询价 / 无证据 / 非正面积或单价的候选不得作可比实例；
 * 3. **确定性排序 + 名额截断**：多关键字、多来源、多次调用下同一批输入必须给出同一批入选。
 *
 * ## 为什么不用浮点打分
 *
 * 打分需要权重，而权重是业务参数；一旦代码里出现"综合得分"，阈值就偷偷变成了代码常量。
 * 所以这里是**逐级比较**（`order` 数组即优先级），每一级都是可核对的字段比较，
 * 并逐条给出落选理由（差额用十进制文本，不四舍五入成"差不多"）。
 */

/** 一级比较键（顺序即优先级，由知识声明）。 */
export type SelectionComparator =
  /** 按知识给的**来源渠道顺序**（渠道之外的排最后）。
   */
  | { key: 'source-rank' }
  /** 成交优先（挂牌 / 询价排在后面；是否排除由硬性规则决定）。 */
  | { key: 'transaction-first' }
  /** 与对象的面积差额**从小到大**（`subjectArea` 必须给）。 */
  | { key: 'area-delta-asc'; subjectArea: number }
  /** 与对象的单价差额从小到大（`subjectUnitPrice` 必须给）。 */
  | { key: 'unit-price-delta-asc'; subjectUnitPrice: number }
  /** 发布时间新的优先（没有发布时间的排最后）。 */
  | { key: 'published-desc' }

const COMPARATOR_KEYS: readonly SelectionComparator['key'][] = [
  'source-rank', 'transaction-first', 'area-delta-asc', 'unit-price-delta-asc', 'published-desc',
]

/** Knowledge assessment status for one candidate (from the live knowledge body). */
export type AssessmentStatus = 'qualified' | 'near-miss' | 'excluded'

const ASSESSMENT_STATUSES: readonly AssessmentStatus[] = ['qualified', 'near-miss', 'excluded']

/** One candidate assessment: status plus the knowledge citation it came from. */
export interface SelectionAssessment {
  url: string
  status: AssessmentStatus
  reason: string
  knowledgeRef: string
}

/** 本轮知识声明的择优规则。**名额 / 顺序 / 渠道顺序都是必填** —— 缺一条就拒绝，不补默认值。 */
export interface SelectionRule {
  /** 最多采用几条（来自知识）。 */
  maxAdopted: number
  /** 优先级顺序（来自知识）。 */
  order: readonly SelectionComparator[]
  /** 来源渠道顺序（来自知识）；`source-rank` 用它。 */
  sourceOrder: readonly string[]
  /** 每条候选的知识评估（可选；缺省 = 全部未评估）。 */
  assessments?: readonly SelectionAssessment[]
}

export interface RejectedCase {
  case: ValuationCase
  /** 落选理由（人话；**具体到差额与名额**）。 */
  reason: string
}

export interface SelectionOutcome {
  ok: boolean
  error: string
  adopted: ValuationCase[]
  rejected: RejectedCase[]
  /** 名额没满 / 未评估 / 硬性排除的说明（不是错误，但必须被看见）。 */
  notes: string[]
  /** 本轮评估（原样带回，供结果与报告引用 knowledgeRef）。 */
  assessments: SelectionAssessment[]
}

/** 规则收窄：形状不对**不**猜，返回人话原因。 */
export function normalizeSelectionRule(value: unknown): { ok: boolean; rule: SelectionRule | null; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, rule: null, error: '择优规则必须是一个对象（maxAdopted / order / sourceOrder）' }
  }
  const raw = value as Record<string, unknown>
  const maxAdopted = typeof raw.maxAdopted === 'number' && Number.isInteger(raw.maxAdopted) ? raw.maxAdopted : 0
  if (maxAdopted <= 0) {
    return {
      ok: false, rule: null,
      error: '择优规则缺少正整数的 maxAdopted：采用几条是**业务事实**（来自本轮知识正文），'
        + '代码里没有默认名额，也不会按"惯例"补一个',
    }
  }
  if (!Array.isArray(raw.order)) {
    return { ok: false, rule: null, error: '择优规则缺少 order：优先级顺序来自本轮知识正文，代码里没有默认顺序' }
  }
  const order: SelectionComparator[] = []
  for (const item of raw.order as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return {
        ok: false, rule: null,
        error: '择优规则的 order 里每一项都必须是对象（含 key）：认不出的项不会被跳过',
      }
    }
    const key = text((item as Record<string, unknown>).key)
    if (!(COMPARATOR_KEYS as readonly string[]).includes(key)) {
      return { ok: false, rule: null, error: `不认识的择优比较键：${key}（只允许 ${COMPARATOR_KEYS.join(' / ')}）` }
    }
    order.push(item as SelectionComparator)
  }
  if (order.length === 0) {
    return { ok: false, rule: null, error: '择优规则缺少 order：优先级顺序来自本轮知识正文，代码里没有默认顺序' }
  }
  const sourceOrder = (Array.isArray(raw.sourceOrder) ? raw.sourceOrder : [])
    .map((item) => text(item)).filter((item) => item !== '')
  if (order.some((item) => item.key === 'source-rank') && sourceOrder.length === 0) {
    return { ok: false, rule: null, error: 'order 里有 source-rank，但没给 sourceOrder：渠道顺序是业务事实' }
  }
  for (const item of order) {
    if (item.key === 'area-delta-asc'
      && (typeof item.subjectArea !== 'number' || !Number.isFinite(item.subjectArea) || item.subjectArea <= 0)) {
      return { ok: false, rule: null, error: 'area-delta-asc 需要 subjectArea（正数的对象建筑面积）' }
    }
    if (item.key === 'unit-price-delta-asc'
      && (typeof item.subjectUnitPrice !== 'number'
        || !Number.isFinite(item.subjectUnitPrice) || item.subjectUnitPrice <= 0)) {
      return { ok: false, rule: null, error: 'unit-price-delta-asc 需要 subjectUnitPrice（正数的对象单价）' }
    }
  }

  const assessments: SelectionAssessment[] = []
  const seenUrls = new Set<string>()
  if (raw.assessments !== undefined) {
    if (!Array.isArray(raw.assessments)) {
      return { ok: false, rule: null, error: 'assessments 必须是数组（每条含 url / status / reason / knowledgeRef）' }
    }
    for (const item of raw.assessments as unknown[]) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, rule: null, error: 'assessments 的每一项都必须是对象' }
      }
      const entry = item as Record<string, unknown>
      const url = text(entry.url).trim()
      const status = text(entry.status).trim()
      const reason = text(entry.reason).trim()
      const knowledgeRef = text(entry.knowledgeRef).trim()
      if (url === '') return { ok: false, rule: null, error: 'assessments 缺少 url：评估必须指向具体候选' }
      if (!(ASSESSMENT_STATUSES as readonly string[]).includes(status)) {
        return { ok: false, rule: null, error: `assessments 的 status「${status}」不是 supported 集合` }
      }
      if (reason === '') return { ok: false, rule: null, error: `assessments（${url}）缺少 reason：评估必须说明理由` }
      if (knowledgeRef === '') {
        return { ok: false, rule: null, error: `assessments（${url}）缺少 knowledgeRef：评估必须给出知识出处` }
      }
      if (seenUrls.has(url)) return { ok: false, rule: null, error: `assessments 里 url 重复：${url}` }
      seenUrls.add(url)
      assessments.push({ url, status: status as AssessmentStatus, reason, knowledgeRef })
    }
  }

  return { ok: true, rule: { maxAdopted, order, sourceOrder, assessments }, error: '' }
}

/** 差额的十进制文本（不四舍五入成"差不多"，也不隐藏量级）。 */
function deltaText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * 事实门禁：这四条是业务**合同**（不是阈值），所以在这里落地。
 *
 * 返回空串表示可用；否则是排除理由。知识评估只能在此之上收窄，不能覆盖它。
 */
export function hardExclusionOf(item: ValuationCase): string {
  const transaction = text(item.transactionType)
  if (transaction !== '成交') {
    if (transaction === '') {
      return '交易性质未确认（页面未标明挂牌/成交）：不得直接作为可比实例'
    }
    return `交易性质是「${transaction}」：挂牌 / 询价只能作观察，不能直接作为可比实例`
  }
  if (text(item.evidence) === '') {
    return '没有页面证据：没有证据的案例不能作可比实例（缺口要能被看见，不能用它凑名额）'
  }
  if (typeof item.buildingArea !== 'number' || !Number.isFinite(item.buildingArea) || item.buildingArea <= 0) {
    return '缺少正数的建筑面积：无法换算单价，不能作可比实例'
  }
  if (typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice <= 0) {
    return '缺少正数单价：不能作可比实例'
  }
  return ''
}

/** 逐级比较（`order` 即优先级）；完全相等时按 URL 兜底，保证**同一批输入同一批入选**。 */
function compareCases(a: ValuationCase, b: ValuationCase, rule: SelectionRule): number {
  for (const item of rule.order) {
    const delta = compareAt(a, b, item, rule)
    if (delta !== 0) return delta
  }
  return text(a.url).localeCompare(text(b.url))
}

function compareAt(a: ValuationCase, b: ValuationCase, item: SelectionComparator, rule: SelectionRule): number {
  switch (item.key) {
    case 'source-rank': {
      const rank = (value: ValuationCase): number => {
        const index = rule.sourceOrder.indexOf(text(value.source))
        return index === -1 ? rule.sourceOrder.length : index
      }
      return rank(a) - rank(b)
    }
    case 'transaction-first': {
      const rank = (value: ValuationCase): number => (text(value.transactionType) === '成交' ? 0 : 1)
      return rank(a) - rank(b)
    }
    case 'area-delta-asc': {
      const subject = item.subjectArea as number
      const deltaOf = (value: ValuationCase): number =>
        typeof value.buildingArea === 'number' && Number.isFinite(value.buildingArea)
          ? Math.abs(value.buildingArea - subject) : Number.POSITIVE_INFINITY
      return deltaOf(a) - deltaOf(b)
    }
    case 'unit-price-delta-asc': {
      const subject = item.subjectUnitPrice as number
      const deltaOf = (value: ValuationCase): number =>
        typeof value.unitPrice === 'number' && Number.isFinite(value.unitPrice)
          ? Math.abs(value.unitPrice - subject) : Number.POSITIVE_INFINITY
      return deltaOf(a) - deltaOf(b)
    }
    case 'published-desc': {
      const timeOf = (value: ValuationCase): number => {
        const raw = text(value.publishedAt)
        const parsed = Date.parse(raw)
        return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
      }
      return timeOf(b) - timeOf(a)
    }
    default: return 0
  }
}

/** 名额截断时给出的理由（具体到名次与名额）。 */
function overQuotaReason(rank: number, rule: SelectionRule): string {
  const keyText = rule.order.map((entry) => entry.key).join(' → ')
  return `按知识声明的优先级（${keyText}）排在第 ${String(rank)} 名，超出本轮名额（${String(rule.maxAdopted)} 条）：`
    + '不是"不合格"，而是这一轮采用名额已满；它仍在候选清单里，可按编号纳入重算'
}

/**
 * 批量筛选并优选。
 *
 * 顺序：知识评估（未评估 / 非 qualified 不采用）→ 事实门禁 → 确定性排序 → 名额截断。
 * 每条都留下可核对理由；`adopted` 永远是"知识合格且事实合格"的交集。
 */
export function selectCandidates(
  cases: readonly ValuationCase[],
  rule: SelectionRule,
): SelectionOutcome {
  const assessments = rule.assessments ?? []
  const byUrl = new Map(assessments.map((item) => [item.url, item]))
  const excluded: RejectedCase[] = []
  const usable: ValuationCase[] = []
  let hardExcluded = 0
  for (const item of cases) {
    const factual = hardExclusionOf(item)
    if (factual !== '') {
      hardExcluded += 1
      excluded.push({ case: item, reason: factual })
      continue
    }
    const assessment = byUrl.get(item.url)
    if (assessment === undefined) {
      excluded.push({
        case: item,
        reason: '未评估（unreviewed）：没有本轮知识评估的候选不能自动采用，等待按知识正文逐条评估',
      })
      continue
    }
    if (assessment.status !== 'qualified') {
      excluded.push({
        case: item,
        reason: `知识评估未通过（${assessment.status}）：${assessment.reason}`,
      })
      continue
    }
    usable.push(item)
  }
  const sorted = [...usable].sort((a, b) => compareCases(a, b, rule))
  const adopted = sorted.slice(0, rule.maxAdopted)
  const rejected: RejectedCase[] = [
    ...excluded,
    ...sorted.slice(rule.maxAdopted).map((item, index) => ({
      case: item,
      reason: overQuotaReason(rule.maxAdopted + index + 1, rule),
    })),
  ]
  const notes: string[] = []
  if (assessments.length === 0) {
    notes.push('本轮没有知识评估：全部候选按未评估处理，不得自动采用；请按知识正文逐条评估后再筛选')
  }
  if (adopted.length < rule.maxAdopted) {
    notes.push(`可用候选只有 ${String(adopted.length)} 条，少于知识声明的名额 ${String(rule.maxAdopted)} 条：`
      + '按少案例处置（给参考结论与实际限制，或与用户沟通），**不要**用不可用的案例凑数')
  }
  if (hardExcluded > 0) {
    notes.push(`硬性排除 ${String(hardExcluded)} 条（交易性质未确认 / 挂牌 / 无证据 / 缺正面积或单价）：`
      + '它们不能因为"数量不够"而被启用')
  }
  // 对象侧的基准值就在比较键里（只有一个来源），说明从它读 —— 不从别处再传一个副本。
  const areaKey = rule.order.find((item) => item.key === 'area-delta-asc')
  if (areaKey !== undefined && areaKey.key === 'area-delta-asc') {
    notes.push(`面积差额以对象 ${deltaText(areaKey.subjectArea)} ㎡ 为基准`)
  }
  return { ok: true, error: '', adopted, rejected, notes, assessments: [...assessments] }
}
