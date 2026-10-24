import type { TemplateMarketCandidate, TemplateMarketFact, TemplateMarketState } from '../../../../shared/contracts/valuation-template-market.ts'
import { canonicalListingUrl } from '../market/candidates.ts'
import { validateTemplateMarketBinding, type ValidationResult } from './template-market-contracts.ts'

function mergeFacts(previous: Record<string, TemplateMarketFact>, incoming: Record<string, TemplateMarketFact>, differences: string[]): Record<string, TemplateMarketFact> {
  const facts = structuredClone(previous)
  for (const [field, fact] of Object.entries(incoming)) {
    const old = facts[field]
    if (old && old.value !== null && fact.value !== null && (old.value !== fact.value || old.unit !== fact.unit)) {
      differences.push(`${field}：原列表 ${String(old.value)} ${old.unit}；本次观察 ${String(fact.value)} ${fact.unit}，待核实`)
      facts[field] = { ...old, status: 'conflict', evidenceRefs: [...old.evidenceRefs, ...fact.evidenceRefs] }
    } else if (!old || old.value === null) facts[field] = structuredClone(fact)
  }
  return facts
}
function verifiedValue(candidate: TemplateMarketCandidate, field: string): string {
  const fact = candidate.detailFacts[field] ?? candidate.listFacts[field]
  return fact?.status === 'verified' && fact.value !== null && fact.evidenceRefs.length
    ? `${String(fact.value).replace(/\s+/g, '').toLowerCase()}|${fact.unit}` : ''
}
function unitIdentity(candidate: TemplateMarketCandidate): string {
  for (const field of ['address', 'community']) {
    const value = verifiedValue(candidate, field)
    if (/(?:市|区|县).+(?:号楼|栋|幢).*[0-9一二三四五六七八九十]+(?:号)?室\|/.test(value)) return value
  }
  return ''
}
export function mergeTemplateMarketCandidates(current: TemplateMarketCandidate[], incoming: TemplateMarketCandidate[]): TemplateMarketCandidate[] {
  const merged = structuredClone(current)
  for (const item of incoming) {
    const identity = unitIdentity(item)
    const existing = merged.find(c => canonicalListingUrl(c.sourceUrl) === canonicalListingUrl(item.sourceUrl)
      || (identity !== '' && c.providerId !== item.providerId && unitIdentity(c) === identity))
    if (!existing) { merged.push(structuredClone(item)); continue }
    existing.listFacts = mergeFacts(existing.listFacts, item.listFacts, existing.differences)
    existing.detailFacts = mergeFacts(existing.detailFacts, item.detailFacts, existing.differences)
    existing.sourceRefs = [...existing.sourceRefs, ...item.sourceRefs].filter((r, at, all) => all.findIndex(other => other.sourceId === r.sourceId && other.digest === r.digest) === at)
    existing.duplicateRefs = [...new Set([...existing.duplicateRefs, ...item.duplicateRefs, ...(item.caseId === existing.caseId ? [] : [item.caseId])])]
    if (canonicalListingUrl(existing.sourceUrl) !== canonicalListingUrl(item.sourceUrl)) existing.differences.push(`同一户室的其他来源：${item.sourceUrl}`)
    existing.differences = [...new Set([...existing.differences, ...item.differences])]
  }
  for (let left = 0; left < merged.length; left += 1) for (let right = left + 1; right < merged.length; right += 1) {
    const a = merged[left]!, b = merged[right]!
    if (a.providerId === b.providerId || !['community', 'areaSqm', 'unitPrice'].every(field => {
      const value = verifiedValue(a, field)
      return value !== '' && value === verifiedValue(b, field)
    })) continue
    for (const [one, other] of [[a, b], [b, a]]) {
      one!.differences = [...new Set([...one!.differences, `与 ${other!.caseId} 疑似重复，户室身份未证实，样本独立性待核`])]
      one!.missingFields = [...new Set([...one!.missingFields, 'sampleIndependence'])]
    }
  }
  return merged
}
export function validateTemplateMarketSelection(state: TemplateMarketState, selection: { candidateVersion: number; selectedCaseIds: string[] }): ValidationResult {
  return validateTemplateMarketBinding('select-cases', { outcome: 'completed', summary: '已选择',
    data: { ...selection, searchDecision: 'stop', supplement: '' }, questions: [], limitations: [], failure: null }, state)
}
