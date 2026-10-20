/**
 * Host-neutral validation and identity for the preflighted valuation plan.
 *
 * The planning port performs the actual source/template inspection; this module
 * treats its returned facts as untrusted candidates. A plan is ready only when at
 * least one verified source carries real positive unit/area numbers and the exact
 * template identity, mapping and formula checks are usable. Failed source attempts
 * stay in the receipt with their reason instead of disappearing.
 */
import { createHash } from 'node:crypto'
import type {
  ValuationWorkflowMode,
  ValuationWorkflowPlan,
  ValuationWorkflowPlanContent,
  ValuationWorkflowPlanFormulaCheck,
  ValuationWorkflowPlanMapping,
  ValuationWorkflowPlanSource,
  ValuationWorkflowPlanTemplate,
} from '../../../../shared/contracts/valuation-workflow.ts'

/** Methods the current reference-mean plan can actually execute. */
export const SUPPORTED_PLAN_METHODS = ['market', 'listing-reference'] as const

/** Algorithms the current listing-reference calculator can actually execute. */
export const SUPPORTED_PLAN_ALGORITHMS = [
  'raw-unit-price-arithmetic-mean',
  'listing-reference.mean',
  'listing-reference-mean',
] as const

export interface PlanKnowledgeSource {
  sourceId: string
  body: string
}

export interface PreparedPlanValidation {
  ok: boolean
  plan: ValuationWorkflowPlanContent | null
  gaps: string[]
}

export interface PlanDigestInput {
  runId: string
  revision: number
  object: { objectId: string; useLabel: string; areaSqm: number | null }
  purpose: string
  baseDate: string
  mode: ValuationWorkflowMode | null
  plan: ValuationWorkflowPlanContent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** A detail URL must be a real HTTP(S) address and must not embed credentials. */
function safeDetailUrl(value: string): boolean {
  if (value === '') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== ''
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/** A template locator must stay relative, traversal-free and point at an XLSX. */
function safeRelativeXlsx(value: string): boolean {
  if (value === '') return false
  if (/^[\\/]/.test(value)) return false
  if (/^[A-Za-z]:/.test(value)) return false
  const segments = value.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '..')) return false
  return /\.xlsx$/i.test(segments[segments.length - 1] ?? '')
}

function normalizeSource(raw: unknown, index: number, gaps: string[]): ValuationWorkflowPlanSource | null {
  if (!isRecord(raw)) {
    gaps.push(`来源 ${String(index + 1)} 不是可核对的对象`)
    return null
  }
  const reportedState = text(raw.state) || 'unverified'
  const providerId = text(raw.providerId)
  const detailUrl = text(raw.detailUrl)
  const fields = isRecord(raw.fields) ? raw.fields : {}
  const unitPrice = positiveNumber(fields.unitPrice)
  const areaSqm = positiveNumber(fields.areaSqm)
  let state = reportedState

  if (providerId === '') gaps.push(`来源 ${String(index + 1)} 缺少提供方标识`)
  if (reportedState === 'verified') {
    if (!safeDetailUrl(detailUrl)) {
      gaps.push(`来源 ${providerId || String(index + 1)} 的详情地址不是安全的 HTTP(S) 地址`)
      state = 'unverified'
    }
    if (unitPrice === null || areaSqm === null) {
      gaps.push(`来源 ${providerId || String(index + 1)} 缺少有效的实际单价或面积`)
      state = 'unverified'
    }
  }

  const source: ValuationWorkflowPlanSource = {
    ...raw,
    providerId,
    state,
    community: text(raw.community),
    detailUrl,
    fields: { ...fields, unitPrice, areaSqm },
    transactionType: text(raw.transactionType),
    evidence: text(raw.evidence),
  }
  const reason = text(raw.reason) || text(raw.error) || text(raw.detail)
  if (reason !== '') source.reason = reason
  return source
}

function normalizeMappings(raw: unknown, gaps: string[]): ValuationWorkflowPlanMapping[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    gaps.push('计划模板缺少字段映射')
    return []
  }
  const mapping: ValuationWorkflowPlanMapping[] = []
  for (const item of raw) {
    if (!isRecord(item)
      || text(item.field) === '' || text(item.sheet) === '' || text(item.range) === '') {
      gaps.push('计划模板的字段映射不完整')
      continue
    }
    mapping.push({
      ...item,
      field: text(item.field),
      sheet: text(item.sheet),
      range: text(item.range),
    })
  }
  return mapping
}

function normalizeFormulaChecks(raw: unknown, gaps: string[]): ValuationWorkflowPlanFormulaCheck[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    gaps.push('计划模板没有成功的公式检查回执')
    return []
  }
  const checks: ValuationWorkflowPlanFormulaCheck[] = []
  for (const item of raw) {
    if (!isRecord(item) || text(item.name) === '') {
      gaps.push('计划模板的公式检查回执不完整')
      continue
    }
    if (item.ok !== true) gaps.push(`计划模板公式检查未通过：${text(item.name)}`)
    checks.push({ ...item, ok: item.ok === true, name: text(item.name) })
  }
  return checks
}

function normalizeTemplate(raw: unknown, gaps: string[]): ValuationWorkflowPlanTemplate | null {
  if (!isRecord(raw)) {
    gaps.push('计划没有指定计算模板')
    return null
  }
  const fileName = text(raw.fileName)
  const relativePath = text(raw.relativePath)
  const digest = text(raw.digest)
  if (fileName === '' || relativePath === '' || digest === '') {
    gaps.push('计划模板的文件名、相对路径或摘要不完整')
  }
  if (!safeRelativeXlsx(relativePath)) {
    gaps.push('计划模板的相对路径不是安全的 XLSX 相对路径')
  }
  if (raw.verified !== true) gaps.push('计划模板尚未验真')
  return {
    ...raw,
    fileName,
    relativePath,
    digest,
    verified: raw.verified === true,
    mapping: normalizeMappings(raw.mapping, gaps),
    formulaChecks: normalizeFormulaChecks(raw.formulaChecks, gaps),
  }
}

function normalizeBasis(
  raw: unknown,
  knowledgeSources: readonly PlanKnowledgeSource[],
  gaps: string[],
): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || raw.length === 0) {
    gaps.push('计划没有引用本轮已验真的知识依据')
    return []
  }
  const verified = new Map(knowledgeSources.map((source) => [source.sourceId, source.body]))
  const basis: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!isRecord(item)) {
      gaps.push('计划依据清单包含无效条目')
      continue
    }
    const sourceId = text(item.sourceId)
    const quote = text(item.quote)
    if (sourceId === '' || quote === '') {
      gaps.push('计划依据缺少来源标识或原文')
      continue
    }
    const body = verified.get(sourceId)
    if (body === undefined) {
      gaps.push(`计划依据引用了未验真的知识来源：${sourceId}`)
      continue
    }
    if (!body.includes(quote)) {
      gaps.push(`计划依据原文不在已验真知识来源中：${sourceId}`)
      continue
    }
    basis.push({ ...item, sourceId, quote })
  }
  return basis
}

function normalizeLimitations(raw: unknown, gaps: string[]): string[] {
  if (!Array.isArray(raw)) {
    gaps.push('计划缺少限制条件')
    return []
  }
  const limitations: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      gaps.push('计划限制条件不是有效文本')
      continue
    }
    limitations.push(item.trim())
  }
  return limitations
}

/** Validate the untrusted planning-port result against this stage's verified knowledge. */
export function validatePreparedPlan(
  raw: unknown,
  knowledgeSources: readonly PlanKnowledgeSource[] = [],
): PreparedPlanValidation {
  if (!isRecord(raw)) return { ok: false, plan: null, gaps: ['计划准备没有返回方案对象'] }
  const gaps: string[] = []
  const method = text(raw.method)
  if (!(SUPPORTED_PLAN_METHODS as readonly string[]).includes(method)) {
    gaps.push(`计划方法不受支持：${method || '未提供'}`)
  }
  const mode = raw.valuationMode === 'formal' ? 'formal' : 'listing-reference'
  if (raw.valuationMode !== 'listing-reference') {
    gaps.push('当前只支持挂牌参考口径的计划')
  }
  const algorithm = text(raw.algorithm)
  if (!(SUPPORTED_PLAN_ALGORITHMS as readonly string[]).includes(algorithm)) {
    gaps.push(`计划算法不受支持：${algorithm || '未提供'}`)
  }

  const rawSources = Array.isArray(raw.sources) ? raw.sources : []
  if (rawSources.length === 0) gaps.push('计划没有可核对的可比来源')
  const sources = rawSources
    .map((source, index) => normalizeSource(source, index, gaps))
    .filter((source): source is ValuationWorkflowPlanSource => source !== null)
  const verified = sources.filter((source) => (
    source.state === 'verified'
    && positiveNumber(source.fields.unitPrice) !== null
    && positiveNumber(source.fields.areaSqm) !== null
  ))
  if (verified.length === 0) gaps.push('计划没有至少一个已验真的实际价格来源')

  const template = normalizeTemplate(raw.template, gaps)
  const basis = normalizeBasis(raw.basis, knowledgeSources, gaps)
  const limitations = normalizeLimitations(raw.limitations, gaps)

  if (template === null) {
    return {
      ok: false,
      plan: {
        method,
        valuationMode: mode,
        algorithm,
        sources,
        template: {
          fileName: '',
          relativePath: '',
          digest: '',
          verified: false,
          mapping: [],
          formulaChecks: [],
        },
        basis,
        limitations,
      },
      gaps,
    }
  }
  return {
    ok: gaps.length === 0,
    plan: { method, valuationMode: mode, algorithm, sources, template, basis, limitations },
    gaps,
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = stableValue(value[key])
    return sorted
  }
  return value
}

/**
 * Stable canonical digest. Acceptance and timestamps are deliberately excluded, so
 * the same revision and the same verified facts always produce the same identity.
 */
export function buildPlanDigest(input: PlanDigestInput): string {
  const canonical = JSON.stringify(stableValue({
    runId: input.runId,
    revision: input.revision,
    object: {
      objectId: input.object.objectId,
      useLabel: input.object.useLabel,
      areaSqm: input.object.areaSqm,
    },
    purpose: input.purpose,
    baseDate: input.baseDate,
    mode: input.mode ?? input.plan.valuationMode,
    method: input.plan.method,
    valuationMode: input.plan.valuationMode,
    algorithm: input.plan.algorithm,
    sources: input.plan.sources.map((source) => ({
      providerId: source.providerId,
      state: source.state,
      community: source.community,
      detailUrl: source.detailUrl,
      fields: source.fields,
      transactionType: source.transactionType,
      evidence: source.evidence,
      reason: source.reason ?? '',
    })),
    template: {
      fileName: input.plan.template.fileName,
      relativePath: input.plan.template.relativePath,
      digest: input.plan.template.digest,
      verified: input.plan.template.verified,
      mapping: input.plan.template.mapping,
      formulaChecks: input.plan.template.formulaChecks,
    },
    basis: input.plan.basis,
    limitations: input.plan.limitations,
  })) ?? ''
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/** Deep-copy a plan receipt so a caller cannot mutate stored run state. */
export function clonePlan(plan: ValuationWorkflowPlan): ValuationWorkflowPlan {
  return JSON.parse(JSON.stringify(plan) ?? '{}') as ValuationWorkflowPlan
}
