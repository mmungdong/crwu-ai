/**
 * Real-estate listing-reference contract (first valuation slice).
 *
 * The reference path uses raw listing unit prices, arithmetic mean, no adjustment
 * and no discount, and always delivers `partial` with four artifacts. It also maps
 * entry-Wiki links to the resolved library path the knowledge channel must read.
 */

export const LISTING_REFERENCE_MODE = 'listing-reference'

export const LISTING_REFERENCE_ARTIFACTS = [
  '计算轨迹.json',
  '估值底稿.xlsx',
  '估值报告数据.json',
  '估值报告.html',
] as const

export interface ListingReferenceLink {
  label: string
  /** Raw author-written target, preserved verbatim (may keep angle brackets). */
  target: string
  /** Resolved library path; empty when the link is not a knowledge node. */
  path: string
  anchor: string
  kind: string
  error: string
}

export interface ListingReferenceRejection {
  target: string
  kind: string
  reason: string
}

/**
 * Select the library paths to read next from an entry Wiki.
 *
 * Only `knowledge` links whose resolved `path` is present in the accepted source
 * index are usable; the raw `target` is never used as a library path.
 */
export function selectListingReferenceSources(input: {
  links: readonly ListingReferenceLink[]
  accepted: ReadonlyArray<{ sourceId: string; path: string }>
}): { wikiPaths: string[]; rejected: ListingReferenceRejection[] } {
  const acceptedPaths = new Set(input.accepted.map((item) => item.path).filter((path) => path !== ''))
  const wikiPaths: string[] = []
  const rejected: ListingReferenceRejection[] = []
  for (const link of input.links) {
    if (link.kind !== 'knowledge' || link.path === '') {
      rejected.push({
        target: link.target,
        kind: link.kind,
        reason: link.error !== '' ? link.error : `不是可用的库内知识链接（${link.kind}）`,
      })
      continue
    }
    if (!acceptedPaths.has(link.path)) {
      rejected.push({
        target: link.target,
        kind: 'unverified-source',
        reason: `解析出的库内路径不在本轮已验真来源里：${link.path}`,
      })
      continue
    }
    if (!wikiPaths.includes(link.path)) wikiPaths.push(link.path)
  }
  return { wikiPaths, rejected }
}

// ---------------------------------------------------------------------------
// Reference-specific requirement evaluation
// ---------------------------------------------------------------------------

export type ListingRequirementStatus = 'satisfied' | 'violated' | 'unsupported' | 'unknown'

export interface ListingRequirementEvaluation {
  status: ListingRequirementStatus
  message: string
}

/** Host-observed facts a registered reference evaluator may read. */
export interface ListingReferenceActual {
  sampleCount: number
  areaSqm: number | null
  algorithm: string | null
}

interface ListingMetric {
  unit: string
  evaluate(actual: ListingReferenceActual, value: number): { satisfied: boolean; message: string }
}

/**
 * Explicit allow-list of reference metrics.
 *
 * The evaluator compares a Host-observed actual value, never the requirement's own
 * `met` flag or a rule name alone. An unregistered metric is `unsupported` and a
 * missing/unknown value is `unknown`; a mandatory requirement in either state cannot
 * be treated as satisfied.
 */
const LISTING_METRICS: Record<string, ListingMetric> = {
  'comparableCount.min': {
    unit: '个',
    evaluate: (actual, value) => ({
      satisfied: actual.sampleCount >= value,
      message: `可比案例数量 ${String(actual.sampleCount)} 少于要求 ${String(value)}`,
    }),
  },
  'referenceSampleCount.min': {
    unit: '个',
    evaluate: (actual, value) => ({
      satisfied: actual.sampleCount >= value,
      message: `挂牌参考样本数量 ${String(actual.sampleCount)} 少于要求 ${String(value)}`,
    }),
  },
}

export function evaluateListingReferenceRequirement(input: {
  parameter: { name: string; value: number | string | null; unit: string } | null
  actual: ListingReferenceActual
}): ListingRequirementEvaluation {
  const parameter = input.parameter
  if (parameter === null) return { status: 'satisfied', message: '没有可数值化的要求' }
  const metric = LISTING_METRICS[parameter.name]
  if (metric === undefined) {
    return { status: 'unsupported', message: `没有已登记的要求评估器：${parameter.name}` }
  }
  if (parameter.unit !== '' && parameter.unit !== metric.unit) {
    return { status: 'unsupported', message: `单位与已登记评估器不一致：${parameter.unit} ≠ ${metric.unit}` }
  }
  if (parameter.value === null) {
    return { status: 'unknown', message: `要求 ${parameter.name} 的取值未知，不能视为已满足` }
  }
  const value = typeof parameter.value === 'number' ? parameter.value : Number(parameter.value)
  if (!Number.isFinite(value)) {
    return { status: 'unknown', message: `要求 ${parameter.name} 的取值不是有效数字` }
  }
  const outcome = metric.evaluate(input.actual, value)
  return outcome.satisfied
    ? { status: 'satisfied', message: `已满足 ${parameter.name}` }
    : { status: 'violated', message: outcome.message }
}
