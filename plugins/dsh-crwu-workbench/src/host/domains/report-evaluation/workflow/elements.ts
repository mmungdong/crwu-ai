/**
 * Source-bound basic-fact adoption for the elements stage.
 *
 * A model may propose facts, but only a labelled value whose exact quote exists in
 * the named material (and whose digest matches that submitted material) can be
 * adopted. The whole proposed patch is validated before any field is applied.
 */

export type ElementFactField = 'purpose' | 'baseDate' | 'useLabel' | 'areaSqm'

export interface ElementFactSource {
  materialId: string
  digest: string
  quote: string
}

export interface AdoptedElementFact {
  field: ElementFactField
  value: string | number
  source: ElementFactSource
}

export interface ElementFactsPatch {
  purpose?: string
  baseDate?: string
  useLabel?: string
  areaSqm?: number
}

export interface ElementFactsCurrent {
  purpose: string
  baseDate: string
  useLabel: string
  areaSqm: number | null
}

export interface ElementBinderMaterial {
  materialId: string
  digest: string
  text?: string
}

export interface BindElementFactsInput {
  sourceFacts: unknown
  materials: ElementBinderMaterial[]
  current: ElementFactsCurrent
}

export interface BindElementFactsResult {
  ok: boolean
  patch: ElementFactsPatch
  adopted: AdoptedElementFact[]
  gaps: string[]
  conflicts: string[]
}

const FACT_KEYS = ['field', 'value', 'source'] as const
const SOURCE_KEYS = ['materialId', 'digest', 'quote'] as const

const FIELD_LABELS: Record<Exclude<ElementFactField, 'areaSqm'>, string[]> = {
  purpose: ['评估目的', '估值目的', '目的'],
  baseDate: ['评估基准日', '基准日'],
  useLabel: ['规划用途', '原始用途', '用途'],
}

const AREA_LABELS = ['总建筑面积', '房屋建筑面积', '建筑面积']
const AREA_UNITS = '平方米|平米|㎡|m²|m2'
/** An explicit unit inside a header such as `建筑面积(m²)：86.4`. */
const AREA_HEADER_UNIT = new RegExp(`^\\s*[（(]\\s*(?:${AREA_UNITS})\\s*[）)]`)
/** An explicit unit directly after the numeric value. */
const AREA_SUFFIX_UNIT = new RegExp(`^\\s*(?:${AREA_UNITS})`)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

export function isRealCalendarDate(value: string): boolean {
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

interface FieldOccurrence {
  start: number
  end: number
  value: string | number
  /** Exact position of the complete value inside the material. */
  valueStart: number
  valueEnd: number
}

const FIELD_END = /[；;。\n\r，,]/

function occurrenceEnd(text: string, from: number): number {
  const matched = FIELD_END.exec(text.slice(from))
  return matched === null ? text.length : from + matched.index
}

function textOccurrences(text: string, field: ElementFactField, labels: string[]): FieldOccurrence[] {
  const occurrences: FieldOccurrence[] = []
  for (const label of labels) {
    let at = text.indexOf(label)
    while (at >= 0) {
      const before = text.slice(0, at).replace(/\s+$/, '')
      if (field === 'useLabel' && label === '用途' && before.endsWith('土地')) {
        at = text.indexOf(label, at + 1)
        continue
      }
      const end = occurrenceEnd(text, at + label.length)
      const rawSegment = text.slice(at + label.length, end)
      const leading = /^[\s:：为是|]+/.exec(rawSegment)?.[0].length ?? 0
      const value = rawSegment.slice(leading).replace(/[\s|]+$/, '')
      if (value !== '') {
        const valueStart = at + label.length + leading
        occurrences.push({ start: at, end, value, valueStart, valueEnd: valueStart + value.length })
      }
      at = text.indexOf(label, at + 1)
    }
  }
  return occurrences
}

/** The next character after an area value must be a field boundary, never another token. */
function areaFieldBoundaryOk(text: string, from: number): boolean {
  const rest = text.slice(from)
  if (rest === '') return true
  const first = rest[0] ?? ''
  if (/[；;。\n\r，,]/.test(first)) return true
  if (first === '|') return true
  if (first === ' ' || first === '\t') {
    const afterLayout = rest.replace(/^[\s|]+/, '')
    if (afterLayout === '') return true
    // A further bare or parenthesised number is another unlabelled token.
    return !/^[（(]?\s*-?\d/.test(afterLayout)
  }
  return false
}

/**
 * Parse one labelled gross-area value starting right after its label.
 *
 * The value is only accepted with an explicit unit: either in a header such as
 * `建筑面积(m²)：86.4` / `建筑面积（平方米）：86.4` / `| 建筑面积(m²) | 86.4 |`, or as a
 * suffix such as `建筑面积：86.4平方米`. Exactly one complete value token is accepted:
 * an exponent, a further bare number or an unsupported mixed unit refuses. The span
 * stops at the end of that one value so a following separately labelled
 * `套内建筑面积` is never conflated with it.
 */
function areaValueFrom(
  text: string,
  labelEnd: number,
): { value: number; valueStart: number; valueEnd: number } | null {
  const rest = text.slice(labelEnd)
  const header = AREA_HEADER_UNIT.exec(rest)
  const unitBefore = header !== null
  const offset = header === null ? 0 : header[0].length
  const tail = rest.slice(offset)
  const separator = /^\s*[:：|]?\s*/.exec(tail)
  const separatorLength = separator === null ? 0 : separator[0].length
  const token = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(tail.slice(separatorLength))
  if (token === null) return null
  const numberToken = token[1] ?? ''
  if (/[eE]/.test(numberToken)) return null
  const valueStart = labelEnd + offset + separatorLength
  let valueEnd = valueStart + numberToken.length
  const suffix = AREA_SUFFIX_UNIT.exec(tail.slice(separatorLength + numberToken.length))
  if (!unitBefore && suffix === null) return null
  if (suffix !== null) valueEnd += suffix[0].length
  const value = Number(numberToken)
  if (!Number.isFinite(value)) return null
  if (!areaFieldBoundaryOk(text, valueEnd)) return null
  return { value, valueStart, valueEnd }
}

function areaOccurrences(text: string): FieldOccurrence[] {
  const occurrences: FieldOccurrence[] = []
  for (const label of AREA_LABELS) {
    let at = text.indexOf(label)
    while (at >= 0) {
      // A cropped quote cannot hide the descriptor preceding a generic gross-area label.
      const before = text.slice(0, at).replace(/\s+$/, '')
      if (label === '建筑面积' && (before.endsWith('套内') || before.endsWith('土地'))) {
        at = text.indexOf(label, at + 1)
        continue
      }
      const parsed = areaValueFrom(text, at + label.length)
      if (parsed !== null) {
        occurrences.push({
          start: at, end: parsed.valueEnd, value: parsed.value,
          valueStart: parsed.valueStart, valueEnd: parsed.valueEnd,
        })
      }
      at = text.indexOf(label, at + 1)
    }
  }
  return occurrences
}

function fieldOccurrences(text: string, field: ElementFactField): FieldOccurrence[] {
  if (field === 'areaSqm') return areaOccurrences(text)
  if (field === 'baseDate') return textOccurrences(text, field, FIELD_LABELS.baseDate)
  if (field === 'purpose') return textOccurrences(text, field, FIELD_LABELS.purpose)
  return textOccurrences(text, field, FIELD_LABELS.useLabel)
}

/**
 * Validate one model quote against every labelled occurrence it covers.
 *
 * An identical quote repeated in the material is not by itself a failure, but every
 * exact quote occurrence must contain a complete labelled field whose value agrees;
 * a quote that is merely cropped out of a longer labelled value (e.g. `公寓` inside
 * `公寓式办公`), or that covers two disagreeing labelled areas, is refused.
 */
function quotedOccurrence(text: string, field: ElementFactField, value: string | number, quote: string): boolean {
  const occurrences = fieldOccurrences(text, field)
  let quoteStart = text.indexOf(quote)
  if (quoteStart < 0) return false
  while (quoteStart >= 0) {
    const quoteEnd = quoteStart + quote.length
    // An occurrence is covered only when its label starts inside the quote and the
    // quote carries that occurrence's own complete value at its real position; an
    // unrelated numeric substring elsewhere in the quote cannot authorize it.
    const covered = occurrences.filter((occurrence) => occurrence.start >= quoteStart
      && occurrence.valueStart >= quoteStart
      && occurrence.valueEnd <= quoteEnd)
    if (covered.length === 0) return false
    if (!covered.every((occurrence) => occurrence.value === value)) return false
    quoteStart = text.indexOf(quote, quoteStart + 1)
  }
  return true
}

function validValue(field: ElementFactField, value: unknown, text: string, quote: string): value is string | number {
  if (field === 'areaSqm') {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      && quotedOccurrence(text, field, value, quote)
  }
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return false
  if (!quotedOccurrence(text, field, value, quote)) return false
  return field !== 'baseDate' || isRealCalendarDate(value)
}

function fail(gaps: string[], conflicts: string[] = []): BindElementFactsResult {
  return { ok: false, patch: {}, adopted: [], gaps, conflicts }
}

function currentValue(current: ElementFactsCurrent, field: ElementFactField): string | number | null {
  if (field === 'purpose') return current.purpose === '' ? null : current.purpose
  if (field === 'baseDate') return current.baseDate === '' ? null : current.baseDate
  if (field === 'useLabel') return current.useLabel === '' ? null : current.useLabel
  return current.areaSqm
}


/**
 * Validate every proposed source fact. Returns a patch only when all facts are
 * valid, bound to submitted material text, and unambiguous against current facts.
 */
export function bindElementFacts(input: BindElementFactsInput): BindElementFactsResult {
  if (input.sourceFacts === undefined) return { ok: true, patch: {}, adopted: [], gaps: [], conflicts: [] }
  if (!Array.isArray(input.sourceFacts)) return fail(['sourceFacts 必须是数组'])

  const materials = new Map<string, ElementBinderMaterial>()
  for (const material of input.materials) {
    if (typeof material.materialId === 'string' && typeof material.digest === 'string') {
      materials.set(`${material.materialId}\u0000${material.digest}`, material)
    }
  }

  const patch: ElementFactsPatch = {}
  const adopted: AdoptedElementFact[] = []
  const gaps: string[] = []
  const conflicts: string[] = []
  const seenFields = new Set<ElementFactField>()

  for (const [index, raw] of input.sourceFacts.entries()) {
    if (!isRecord(raw) || !hasExactKeys(raw, FACT_KEYS)) {
      gaps.push(`sourceFacts[${index}] 结构不完整`)
      continue
    }
    const field = raw.field
    if (field !== 'purpose' && field !== 'baseDate' && field !== 'useLabel' && field !== 'areaSqm') {
      gaps.push(`sourceFacts[${index}] 字段不受支持`)
      continue
    }
    if (seenFields.has(field)) {
      gaps.push(`sourceFacts[${index}] 字段重复：${field}`)
      continue
    }
    seenFields.add(field)

    const source = raw.source
    if (!isRecord(source) || !hasExactKeys(source, SOURCE_KEYS)) {
      gaps.push(`sourceFacts[${index}] 缺少完整来源`)
      continue
    }
    const materialId = source.materialId
    const digest = source.digest
    const quote = source.quote
    if (typeof materialId !== 'string' || typeof digest !== 'string'
      || typeof quote !== 'string' || quote.trim() === '') {
      gaps.push(`sourceFacts[${index}] 来源标识不完整`)
      continue
    }
    const material = materials.get(`${materialId}\u0000${digest}`)
    if (material === undefined || typeof material.text !== 'string' || !material.text.includes(quote)) {
      gaps.push(`sourceFacts[${index}] 来源材料或原文无法核对`)
      continue
    }
    const materialText = material.text
    const rawValue = raw.value
    if (!validValue(field, rawValue, materialText, quote)) {
      gaps.push(`sourceFacts[${index}] 值与带标签原文不一致`)
      continue
    }

    const existing = currentValue(input.current, field)
    if (existing !== null) {
      if (existing !== rawValue) conflicts.push(`字段 ${field} 与已确认值冲突`)
      continue
    }
    adopted.push({ field, value: rawValue, source: { materialId, digest, quote } })
    if (field === 'purpose' && typeof rawValue === 'string') patch.purpose = rawValue
    else if (field === 'baseDate' && typeof rawValue === 'string') patch.baseDate = rawValue
    else if (field === 'useLabel' && typeof rawValue === 'string') patch.useLabel = rawValue
    else if (field === 'areaSqm' && typeof rawValue === 'number') patch.areaSqm = rawValue
  }

  if (gaps.length > 0 || conflicts.length > 0) return fail(gaps, conflicts)
  return { ok: true, patch, adopted, gaps: [], conflicts: [] }
}
