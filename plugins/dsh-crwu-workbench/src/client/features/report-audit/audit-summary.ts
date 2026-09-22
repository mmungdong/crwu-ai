/**
 * 「审核信息」Drawer 的**派生规则**。
 *
 * 这一层只做两件事：把外部 JSON 收窄成明确类型、把**代码/规范里已经定义过**的程序枚举翻成业务文案。
 * 它是纯 `.ts`（无 JSX），所以能被 `node --test` 直接加载 —— Drawer 的排版会变，这些规则不该跟着变。
 *
 * ## 语义的唯一来源（不许在这里另立一套）
 *
 * | 字段 | 取值 | 依据 |
 * | --- | --- | --- |
 * | `summary.overallDecision` | `pass` / `fail` / `pending_confirmation` | `audit_result.schema.json` 的 enum |
 * | `reviewComparison.status` | `not_performed` / `performed` | schema enum + `audit_delivery.py` 的 `REVIEW_STATUS_LABEL` |
 * | `reviewComparison.bands` | `overlap` / `aiOnly` / `reviewerOnly` / `divergent` | `11-html-delivery-spec.md` §6.1 的「双向三条带」表 + `REVIEW_CATEGORY_LABEL` |
 *
 * **认不出的取值一律不翻译**：原值原样交给界面（并进技术详情），绝不为好看编一个中文。
 */

import { zhCN } from '../../locales/zh-CN.ts'

/** 外部 JSON 的唯一收窄入口：不是对象就当空对象，禁止后续直接索引 unknown。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** 数值字段：字符串数字也认（Host 侧是 `numberOrText`，两种形态都可能来）。 */
export function numOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number(typeof value === 'string' ? value.trim() : value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 文本字段：非字符串一律空串（不把 undefined 渲染成 "undefined"）。 */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : '')
}

/** 字段在不在（`false` / `0` 也算在）—— 决定"这一行要不要画"。 */
export function hasField(record: Record<string, unknown>, key: string): boolean {
  return record[key] !== undefined && record[key] !== null && record[key] !== ''
}

// ── 审核结论 ────────────────────────────────────────────────────────────────

export type DecisionTone = 'pass' | 'fail' | 'pending' | 'unknown'

export interface DecisionView {
  tone: DecisionTone
  /** 业务文案；认不出的取值为空串（界面回退显示原值）。 */
  label: string
  /** 原始枚举值（技术详情用）。 */
  raw: string
}

const DECISION: Record<string, { tone: DecisionTone; label: string }> = {
  pass: { tone: 'pass', label: zhCN.auditDecisionPass },
  fail: { tone: 'fail', label: zhCN.auditDecisionFail },
  pending_confirmation: { tone: 'pending', label: zhCN.auditDecisionPending },
}

export function decisionOf(raw: string): DecisionView {
  const key = raw.trim()
  const hit = DECISION[key]
  // 认不出的取值不翻译：界面回退显示原值（原值同时进技术详情），绝不为好看编中文。
  if (hit === undefined) return { tone: 'unknown', label: '', raw: key }
  return { tone: hit.tone, label: hit.label, raw: key }
}

// ── 复核状态 ────────────────────────────────────────────────────────────────

export interface ReviewStatusView {
  /** 业务文案；认不出的为空串（界面回退显示原值）。 */
  label: string
  raw: string
}

const REVIEW_STATUS: Record<string, string> = {
  not_performed: zhCN.auditReviewNotPerformed,
  performed: zhCN.auditReviewPerformed,
}

export function reviewStatusOf(raw: string): ReviewStatusView {
  const key = raw.trim()
  return { label: REVIEW_STATUS[key] ?? '', raw: key }
}

// ── 问题计数 ────────────────────────────────────────────────────────────────

export interface RiskCount {
  key: 'high' | 'medium' | 'low'
  label: string
  dot: 'high' | 'medium' | 'low'
  value: number
}

export interface CountsView {
  total: number
  hasTotal: boolean
  risks: RiskCount[]
  pending: number
  hasPending: boolean
  notChecked: number
  hasNotChecked: boolean
  hasAux: boolean
  /** 一个计数都没有：这时整段不渲染（不要画一排 0）。 */
  empty: boolean
}

const RISK_FIELDS: Array<{ key: RiskCount['key']; label: string }> = [
  { key: 'high', label: zhCN.auditRiskHigh },
  { key: 'medium', label: zhCN.auditRiskMedium },
  { key: 'low', label: zhCN.auditRiskLow },
]

export function countsOf(counts: Record<string, unknown>): CountsView {
  const risks = RISK_FIELDS
    .filter((field) => hasField(counts, field.key))
    .map((field) => ({ key: field.key, label: field.label, dot: field.key, value: numOf(counts[field.key]) }))
  const hasPending = hasField(counts, 'pendingConfirmation')
  const hasNotChecked = hasField(counts, 'notChecked')
  const hasTotal = hasField(counts, 'issuesTotal')
  return {
    total: numOf(counts.issuesTotal),
    hasTotal,
    risks,
    pending: hasPending ? numOf(counts.pendingConfirmation) : 0,
    hasPending,
    notChecked: hasNotChecked ? numOf(counts.notChecked) : 0,
    hasNotChecked,
    hasAux: hasPending || hasNotChecked,
    empty: !hasTotal && risks.length === 0 && !hasPending && !hasNotChecked,
  }
}

// ── 复核命中（只呈现既有字段，不重算算法）─────────────────────────────────────

export interface HitView {
  /** `33.3%`；没有可信取值时为空串。 */
  rate: string
  /** `1 / 3 条命中`；分母缺失/为 0 时为空串。 */
  count: string
  /** `精确 1 · 部分 0`；两个字段都没有时为空串。 */
  detail: string
}

/** 从可能带公式的字符串里取**第一个百分数**（引擎的 `aiHitRate` 里可能带口径说明）。 */
export function percentOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}%`
  const text = textOf(value)
  const matched = /-?\d+(?:\.\d+)?\s*%/.exec(text)
  return matched === null ? '' : matched[0].replace(/\s+/g, '')
}

export function hitOf(metrics: Record<string, unknown>): HitView {
  const exact = numOf(metrics.exactHits)
  const partial = numOf(metrics.partialHits)
  const evaluable = numOf(metrics.evaluable)
  // 只在引擎真的给了数字时才拼计数行：分母缺失时不写 0 / 0（那会被读成"一条都没命中"）。
  const count = hasField(metrics, 'exactHits') && hasField(metrics, 'partialHits') && evaluable > 0
    ? zhCN.auditHitCount.replace('%s', String(exact + partial)).replace('%s', String(evaluable))
    : ''
  const detail = hasField(metrics, 'exactHits') || hasField(metrics, 'partialHits')
    ? zhCN.auditHitDetail.replace('%s', String(exact)).replace('%s', String(partial))
    : ''
  // 主指标优先用引擎写好的 `aiHitRate`（当前 Drawer 展示的就是它），退回 `hitRate`。
  let rate = percentOf(metrics.aiHitRate) || percentOf(metrics.hitRate)
  // 规范口径（11-html-delivery-spec.md §6.2）：分母为 0 时显示「不适用」，不得伪造 0%。
  if (rate === '' && hasField(metrics, 'evaluable') && evaluable === 0) rate = zhCN.auditNotApplicable
  return { rate, count, detail }
}

// ── 复核三条带 ──────────────────────────────────────────────────────────────

export interface BandView {
  key: string
  /** 界面上的短标签。 */
  label: string
  /** 悬停说明：逐字取交付规范/渲染脚本里的权威措辞，不改写。 */
  full: string
  value: number
}

const BANDS: Array<{ key: string; label: string; full: string }> = [
  { key: 'overlap', label: zhCN.auditBandOverlap, full: zhCN.auditBandOverlapFull },
  { key: 'aiOnly', label: zhCN.auditBandAiOnly, full: zhCN.auditBandAiOnlyFull },
  { key: 'reviewerOnly', label: zhCN.auditBandReviewerOnly, full: zhCN.auditBandReviewerOnlyFull },
  { key: 'divergent', label: zhCN.auditBandDivergent, full: zhCN.auditBandDivergentFull },
]

/** 只列出**载荷里真的存在**的带；一条都没有时返回空数组（整段不渲染）。 */
export function bandsOf(bands: Record<string, unknown>): BandView[] {
  return BANDS
    .filter((band) => hasField(bands, band.key))
    .map((band) => ({ ...band, value: numOf(bands[band.key]) }))
}

// ── 技术详情 ────────────────────────────────────────────────────────────────

/** JSON 单行：技术详情里"原始计数"这类小对象用（表格里换行显示）。 */
export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch (cause: unknown) {
    // 序列化失败不该让抽屉崩掉：调用方拿到空串就不渲染这一行。
    void cause
    return ''
  }
}

/** JSON 美化：技术详情里唯一允许直接展示原始结构的地方（默认折叠）。 */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch (cause: unknown) {
    // 循环引用等序列化失败不该让抽屉崩掉：退回一句人话，原对象仍在内存里。
    void cause
    return ''
  }
}

// ── AI 检出问题 与 「已提出但仍未整改」──────────────────────────────────────
//
// 这两块直接用 Host 裁剪过的 `issues[]` / `reviewComparison.reviewItems[]`
// （见 `src/host/audit/summary.ts` 的两组最小集），**不在前端重新生成问题描述**。
//
// `reviewItems[].linkedIssueIds` 与 `inFileResolution` 是"已提未改"的**唯一**判据：
//   - `linkedIssueIds`：这一条人工复核意见正式关联到哪些 AI issueId（schema：string[]）；
//   - `inFileResolution === 'L-open'`：交付规范 §6.1「复核已提出 · 被审件未落实」——
//     也就是"人工提出过、当前材料里仍然没改"。同表的 L-resolved / L-unclosed /
//     L-uncheckable 分别是"已落实 / 答复称已改但未落地 / 材料缺失无法核验"，**都不算**这一档。
// 因此判定写成"两个条件同时成立"，而不是看 `overlap > 0`、也不是看 `issue.flowStatus`。

/** 严重程度排序权重：高 → 中 → 低 → 认不出的排最后（同级保持原有顺序）。 */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

export interface IssueView {
  issueId: string
  title: string
  /** 原始严重程度（high / medium / low）；认不出的保留原值。 */
  severity: string
  /** 业务文案：高 / 中 / 低；认不出的为空串（界面显示原值）。 */
  severityLabel: string
  /** 圆点色调（复用列表那一套风险色）。 */
  tone: 'high' | 'medium' | 'low'
  /** 首屏简述：优先 `gapAnalysis.difference`，退回 `problemDescription` 的第一行/首句。 */
  brief: string
  locationSummary: string
  handlingRequirement: string
}

const SEVERITY_LABEL: Record<string, { label: string; tone: IssueView['tone'] }> = {
  high: { label: zhCN.auditRiskHigh, tone: 'high' },
  medium: { label: zhCN.auditRiskMedium, tone: 'medium' },
  low: { label: zhCN.auditRiskLow, tone: 'low' },
}

/** `problemDescription` 的第一行；没有换行就取第一句（补回句号）——不要截断到看不懂。 */
export function firstSentence(value: string): string {
  const text = value.trim()
  if (text === '') return ''
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '')
  if (line !== undefined && line !== text) return line
  const sentence = text.split(/[。；!?！？]/).map((part) => part.trim()).find((part) => part !== '')
  if (sentence === undefined || sentence === '') return text
  return sentence === text ? text : `${sentence}。`
}

function issueViewOf(raw: Record<string, unknown>): IssueView {
  const severity = textOf(raw.severity).trim()
  const hit = SEVERITY_LABEL[severity]
  const difference = textOf(raw.difference).trim()
  const description = textOf(raw.problemDescription)
  return {
    issueId: textOf(raw.issueId),
    title: textOf(raw.title),
    severity,
    severityLabel: hit?.label ?? '',
    tone: hit?.tone ?? 'low',
    brief: difference !== '' ? difference : firstSentence(description),
    locationSummary: textOf(raw.locationSummary),
    handlingRequirement: textOf(raw.handlingRequirement),
  }
}

/** 载荷里的 AI 检出问题，按 高 → 中 → 低 稳定排序。 */
export function issuesOf(info: Record<string, unknown>): IssueView[] {
  return (Array.isArray(info.issues) ? info.issues : [])
    .map((item) => issueViewOf(asRecord(item)))
    .filter((issue) => issue.title !== '' || issue.brief !== '' || issue.issueId !== '')
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => (
      (SEVERITY_RANK[left.issue.severity] ?? 3) - (SEVERITY_RANK[right.issue.severity] ?? 3)
      || left.index - right.index
    ))
    .map((entry) => entry.issue)
}

export interface RaisedView extends IssueView {
  /** 来源复核项 id（技术详情可查）。 */
  itemId: string
  /** 人工复核当时提出的原话（`reviewItems[].reviewerEvidence.quote`）。 */
  reviewerQuote: string
  /** 来源复核项的标题（人工意见的标题）。 */
  reviewerTitle: string
}

/**
 * 「已提出但仍未整改」= 人工复核项**既关联了 AI issue**、又判定为 `L-open`（被审件未落实）。
 *
 * 两个条件缺一不可：
 * - 只见 `L-open` 而没有 `linkedIssueIds`：那是"人工提出、AI 没检出"，不是"AI 又重新发现"；
 * - 只见 `linkedIssueIds` 而 `inFileResolution` 不是 `L-open`：可能已经改了（L-resolved），
 *   说成"仍未整改"就是误报 —— 用户口径是「宁可暂时不显示，也不要误报」。
 *
 * 结果按 issueId 去重（同一个问题可能被多条复核意见指向，取第一条复核意见的原话）。
 */
export function raisedUnresolvedOf(info: Record<string, unknown>): RaisedView[] {
  const review = asRecord(info.reviewComparison)
  const items = Array.isArray(review.reviewItems) ? review.reviewItems : []
  const byId = new Map<string, IssueView>()
  for (const issue of issuesOf(info)) {
    if (issue.issueId !== '' && !byId.has(issue.issueId)) byId.set(issue.issueId, issue)
  }
  const seen = new Set<string>()
  const out: RaisedView[] = []
  for (const raw of items) {
    const item = asRecord(raw)
    if (textOf(item.inFileResolution).trim() !== 'L-open') continue
    const linked = Array.isArray(item.linkedIssueIds) ? item.linkedIssueIds : []
    for (const id of linked) {
      const issueId = textOf(id).trim()
      if (issueId === '' || seen.has(issueId)) continue
      const issue = byId.get(issueId)
      // 关联不到问题正文时不猜：这条不算（宁可少显示，也不编一个标题出来）。
      if (issue === undefined) continue
      seen.add(issueId)
      out.push({
        ...issue,
        itemId: textOf(item.itemId),
        reviewerQuote: textOf(item.reviewerQuote),
        reviewerTitle: textOf(item.title),
      })
    }
  }
  return out
}

/** AI 检出条数：优先用 `summary.counts.issuesTotal`；没有才退回实际列表长度。 */
export function detectedOf(info: Record<string, unknown>, issues: IssueView[]): { count: number; hasCount: boolean } {
  const counts = asRecord(asRecord(info.summary).counts)
  if (hasField(counts, 'issuesTotal')) return { count: numOf(counts.issuesTotal), hasCount: true }
  return { count: issues.length, hasCount: issues.length > 0 }
}
