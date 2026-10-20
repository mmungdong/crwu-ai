/**
 * Bind prose/table requirement candidates to verified knowledge snapshots.
 *
 * A candidate is accepted only when its source identity, digest, verified section
 * anchor and exact quote all match, its evidence text really occurs in that source,
 * its applicability (object/stage/mode/method/region/effective dates) is satisfied by
 * explicit facts, and its value/unit is carried by the quoted text as a complete
 * token. Unknown values stay `null` (bound unknown, never numeric readiness); truly
 * conflicting candidates are left `ambiguous`.
 */

export type RequirementGapKind =
  | 'source-missing'
  | 'out-of-scope'
  | 'digest-mismatch'
  | 'section-missing'
  | 'quote-missing'
  | 'evidence-mismatch'
  | 'unit-mismatch'
  | 'value-mismatch'
  | 'ambiguous'
  | 'not-applicable'
  | 'unsafe-formula'
  | 'unsupported-calculator'

export interface RequirementSource {
  sourceId: string
  spaceName: string
  path: string
  digest: string
  body: string
  kind: 'prose' | 'table'
}

export interface RequirementSourceRef {
  sourceId: string
  digest: string
  section?: string
  quote: string
}

export interface RequirementAppliesTo {
  objectIds?: string[]
  stages?: string[]
  methods?: string[]
  modes?: string[]
  regions?: string[]
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export interface RequirementParameterCandidate {
  name: string
  value: number | string | null
  unit: string
  evidenceQuote?: string
}

export interface RequirementExecutorCandidate {
  calculatorId: string
  inputSlots?: string[]
}

export interface RequirementCandidate {
  requirementId: string
  source: RequirementSourceRef
  statement: string
  strength?: string
  appliesTo?: RequirementAppliesTo
  parameter?: RequirementParameterCandidate | null
  executor?: RequirementExecutorCandidate | null
}

export interface RequirementContext {
  objectId: string
  stage: string
  mode?: string
  method?: string
  region?: string
  useLabel?: string
  facts?: Record<string, unknown>
  /** Explicit evaluation date when it is not carried in `facts.baseDate`. */
  date?: string
  sourceScope: { spaceName: string; paths: string[] }
  allowedCalculatorIds: string[]
}

export interface AcceptedRequirement {
  requirementId: string
  statement: string
  strength: string
  sourceId: string
  sourceDigest: string
  resolvedPath: string
  section: string
  quote: string
  parameter: { name: string; value: number | string | null; unit: string } | null
  calculatorId: string | null
}

export interface RequirementGap {
  requirementId: string
  kind: RequirementGapKind
  message: string
}

export interface RequirementBindingResult {
  ok: boolean
  error: string
  accepted: AcceptedRequirement[]
  gaps: RequirementGap[]
}

const NUMERIC_STRING = /^[-+]?\d+(?:\.\d+)?$/
const UNSAFE_VALUE = /[*+()=;]|=>|\beval\b|\bfunction\b|\breturn\b|`/
const NUMERIC_TOKEN = /(?<![\d.])-?\d+(?:\.\d+)?(?![\d.])/g

/** Every complete signed/decimal numeric token in the text. */
function numericTokens(text: string): number[] {
  const values: number[] = []
  for (const match of text.matchAll(NUMERIC_TOKEN)) values.push(Number(match[0]))
  return values
}

/** A value is carried only when a complete source token equals it numerically. */
function numberValuePresent(text: string, value: number): boolean {
  return numericTokens(text).includes(value)
}

/** A unit appears as a complete token: `元` never matches `万元`. */
function unitTokenAppears(text: string, unit: string): boolean {
  if (unit === '') return true
  const boundary = (char: string): boolean => char === '' || !/[\p{L}\p{N}]/u.test(char)
  let index = text.indexOf(unit)
  while (index >= 0) {
    const before = index > 0 ? text[index - 1] ?? '' : ''
    const after = index + unit.length < text.length ? text[index + unit.length] ?? '' : ''
    if (boundary(before) && boundary(after)) return true
    index = text.indexOf(unit, index + 1)
  }
  return false
}

function isRealCalendarDate(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12 || day < 1) return false
  const days = [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ]
  return day <= (days[month - 1] ?? 0)
}

function findSource(sources: readonly RequirementSource[], sourceId: string): RequirementSource | undefined {
  return sources.find((source) => source.sourceId === sourceId)
}

/**
 * The adopted section must exist once and actually cover the quoted clause. A quote
 * that is simply absent is reported separately as `quote-missing`.
 */
function sectionProblem(
  body: string,
  section: string,
  quote: string,
): { kind: RequirementGapKind; message: string } | null {
  const anchor = String(section ?? '')
  if (anchor.trim() === '') return { kind: 'section-missing', message: '候选没有声明采用的章节' }
  const first = body.indexOf(anchor)
  if (first < 0) return { kind: 'section-missing', message: `采用的章节不在已验真正文里：${anchor}` }
  if (body.indexOf(anchor, first + 1) >= 0) {
    return { kind: 'section-missing', message: `采用的章节在正文里出现多次，无法消歧：${anchor}` }
  }
  const quoteAt = body.indexOf(quote)
  if (quoteAt < 0) return { kind: 'quote-missing', message: '引用的原文片段不在已验真正文里' }
  if (quoteAt < first) return { kind: 'section-missing', message: `采用的章节没有覆盖引用的原文：${anchor}` }
  return null
}

function appliesProblem(candidate: RequirementCandidate, context: RequirementContext): string {
  const applies = candidate.appliesTo ?? {}
  const matches = (list: string[] | undefined, actual: string | undefined | null): boolean => {
    if (list === undefined || list.length === 0) return true
    if (actual === undefined || actual === null || actual === '') return false
    return list.includes(String(actual))
  }
  if (!matches(applies.objectIds, context.objectId)) return 'requirement does not apply to this object'
  if (!matches(applies.stages, context.stage)) return 'requirement does not apply to this stage'
  if (!matches(applies.modes, context.mode)) return 'requirement does not apply to this mode'
  if (!matches(applies.methods, context.method)) return 'requirement does not apply to this method'
  if (!matches(applies.regions, context.region)) return 'region-limited requirement has no known actual region'

  const from = applies.effectiveFrom ?? null
  const to = applies.effectiveTo ?? null
  if (from !== null || to !== null) {
    const when = context.date ?? (typeof context.facts?.baseDate === 'string' ? context.facts.baseDate : '')
    if (when === '' || !isRealCalendarDate(when)) return 'date-limited requirement has no known evaluation date'
    if (from !== null && !isRealCalendarDate(from)) return `规则的生效日期不是真实日历日期：${from}`
    if (to !== null && !isRealCalendarDate(to)) return `规则的失效日期不是真实日历日期：${to}`
    if (from !== null && from > when) return `规则在评估时点尚未生效（${from} > ${when}）`
    if (to !== null && to < when) return `规则在评估时点已经失效（${to} < ${when}）`
  }
  return ''
}

function parameterProblem(
  candidate: RequirementCandidate,
  source: RequirementSource,
): { ok: true; parameter: AcceptedRequirement['parameter'] } | { ok: false; kind: RequirementGapKind; message: string } {
  const parameter = candidate.parameter ?? null
  if (parameter === null) return { ok: true, parameter: null }
  const quote = candidate.source.quote
  const evidence = parameter.evidenceQuote !== undefined && parameter.evidenceQuote !== ''
    ? parameter.evidenceQuote
    : quote
  if (parameter.evidenceQuote !== undefined && parameter.evidenceQuote !== ''
    && !quote.includes(parameter.evidenceQuote) && !source.body.includes(parameter.evidenceQuote)) {
    return { ok: false, kind: 'evidence-mismatch', message: '参数引用的证据片段不在采用原文或已验真正文里' }
  }
  if (!unitTokenAppears(evidence, parameter.unit)) {
    return { ok: false, kind: 'unit-mismatch', message: `引用原文没有携带单位「${parameter.unit}」` }
  }

  const value = parameter.value
  if (value === null) return { ok: true, parameter: { name: parameter.name, value: null, unit: parameter.unit } }
  if (typeof value === 'number') {
    if (!numberValuePresent(evidence, value)) {
      return { ok: false, kind: 'value-mismatch', message: `引用原文没有携带数值 ${String(value)}（完整数值比对）` }
    }
    return { ok: true, parameter: { name: parameter.name, value, unit: parameter.unit } }
  }
  if (NUMERIC_STRING.test(value)) {
    const numeric = Number(value)
    if (!numberValuePresent(evidence, numeric)) {
      return { ok: false, kind: 'value-mismatch', message: `引用原文没有携带数值 ${value}（完整数值比对）` }
    }
    return { ok: true, parameter: { name: parameter.name, value: numeric, unit: parameter.unit } }
  }
  if (UNSAFE_VALUE.test(value)) {
    return { ok: false, kind: 'unsafe-formula', message: '参数值看起来是可执行表达式；不接受任意生成公式' }
  }
  if (!evidence.includes(value)) {
    return { ok: false, kind: 'value-mismatch', message: '引用原文没有携带该取值' }
  }
  return { ok: true, parameter: { name: parameter.name, value, unit: parameter.unit } }
}

function bindOne(
  candidate: RequirementCandidate,
  sources: readonly RequirementSource[],
  context: RequirementContext,
): { ok: true; accepted: AcceptedRequirement } | { ok: false; kind: RequirementGapKind; message: string } {
  const source = findSource(sources, candidate.source.sourceId)
  if (source === undefined) {
    return { ok: false, kind: 'source-missing', message: `没有这份已验真来源：${candidate.source.sourceId}` }
  }
  const scope = context.sourceScope
  if (source.spaceName !== scope.spaceName || !scope.paths.includes(source.path)) {
    return { ok: false, kind: 'out-of-scope', message: `来源不在本轮允许的库与路径范围内：${source.path}` }
  }
  if (candidate.source.digest !== source.digest) {
    return { ok: false, kind: 'digest-mismatch', message: '候选引用的来源摘要与已验真正文不一致' }
  }
  const section = sectionProblem(source.body, candidate.source.section ?? '', candidate.source.quote)
  if (section !== null) return { ok: false, kind: section.kind, message: section.message }

  const applies = appliesProblem(candidate, context)
  if (applies !== '') return { ok: false, kind: 'not-applicable', message: applies }

  const bound = parameterProblem(candidate, source)
  if (!bound.ok) return bound

  const executor = candidate.executor ?? null
  if (executor !== null && (executor.calculatorId === '' || !context.allowedCalculatorIds.includes(executor.calculatorId))) {
    return { ok: false, kind: 'unsupported-calculator', message: `没有已登记的计算器：${executor.calculatorId}` }
  }

  return {
    ok: true,
    accepted: {
      requirementId: candidate.requirementId,
      statement: candidate.statement,
      strength: candidate.strength ?? 'unspecified',
      sourceId: source.sourceId,
      sourceDigest: source.digest,
      resolvedPath: source.path,
      section: candidate.source.section ?? '',
      quote: candidate.source.quote,
      parameter: bound.parameter,
      calculatorId: executor === null ? null : executor.calculatorId,
    },
  }
}

/**
 * Bind requirement candidates to verified sources.
 *
 * Each candidate fails on its first problem so one faulty candidate produces exactly
 * one explicit gap. Individually valid candidates that disagree on the same
 * requirement are left `ambiguous` and not accepted.
 */
export async function bindKnowledgeRequirements(input: {
  sources: readonly RequirementSource[]
  candidates: readonly RequirementCandidate[]
  context: RequirementContext
}): Promise<RequirementBindingResult> {
  const sources = Array.isArray(input.sources) ? input.sources : []
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const accepted: AcceptedRequirement[] = []
  const gaps: RequirementGap[] = []

  const valid: AcceptedRequirement[] = []
  for (const candidate of candidates) {
    const result = bindOne(candidate, sources, input.context)
    if (result.ok) valid.push(result.accepted)
    else gaps.push({ requirementId: candidate.requirementId, kind: result.kind, message: result.message })
  }

  const byRequirement = new Map<string, AcceptedRequirement[]>()
  for (const item of valid) {
    const bucket = byRequirement.get(item.requirementId)
    if (bucket === undefined) byRequirement.set(item.requirementId, [item])
    else bucket.push(item)
  }
  for (const [requirementId, bucket] of byRequirement) {
    const values = new Set(bucket.map((item) => JSON.stringify(item.parameter)))
    if (bucket.length > 1 && values.size > 1) {
      gaps.push({
        requirementId,
        kind: 'ambiguous',
        message: `同一要求出现 ${String(bucket.length)} 个不同取值：需先消歧，不按读取先后选择`,
      })
      continue
    }
    accepted.push(bucket[0] as AcceptedRequirement)
  }

  return {
    ok: gaps.length === 0,
    error: gaps.map((gap) => `${gap.kind}: ${gap.message}`).join('；'),
    accepted,
    gaps,
  }
}
