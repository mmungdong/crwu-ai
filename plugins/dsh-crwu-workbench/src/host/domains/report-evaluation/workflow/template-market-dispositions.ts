import type { TemplateMarketCandidate, TemplateMarketCapability, TemplateMarketDeliveryDecision, TemplateMarketDisposition,
  TemplateMarketFact, TemplateMarketPlan, TemplateMarketScope } from '../../../../shared/contracts/valuation-template-market.ts'

const sameSet = (left: string[], right: string[]): boolean => left.length === right.length && left.every(value => right.includes(value))
export const templateMarketConditionsKey = (plan: TemplateMarketPlan): string => JSON.stringify({ priceBasis: plan.priceBasis, ...plan.filters })
export function applicableTemplateMarketDispositions(dispositions: TemplateMarketDisposition[], scope: TemplateMarketScope): TemplateMarketDisposition[] {
  return dispositions.filter(item => item.acceptedBySubmissionId !== '' && item.reason.trim() !== ''
    && item.scope.objectId === scope.objectId && item.scope.templateDigest === scope.templateDigest
    && item.scope.conditions === scope.conditions && sameSet(item.scope.caseIds, scope.caseIds)
    && item.scope.fieldIds.every(field => scope.fieldIds.includes(field)))
}

export function evaluateTemplateMarketInputs(state: {
  plan: TemplateMarketPlan | null; candidates: TemplateMarketCandidate[]; selectedCaseIds: string[];
  facts: Record<string, TemplateMarketFact>; dispositions: TemplateMarketDisposition[]; capabilities: TemplateMarketCapability[];
}): TemplateMarketDeliveryDecision {
  const plan = state.plan
  if (plan === null) return { path: 'needs-user', limitations: ['尚未确定计算模板'], missingFields: [] }
  const missingFields = plan.requirements.fields.filter(field => field.applicability === 'pending'
    || (field.owner !== 'case' && field.applicability === 'applicable' && field.criticalFor.includes('calculation')
      && (!state.facts[field.fieldId] || state.facts[field.fieldId]!.status !== 'verified'))).map(field => field.fieldId)
  for (const caseId of state.selectedCaseIds) {
    const candidate = state.candidates.find(item => item.caseId === caseId)
    if (!candidate || candidate.status === 'rejected') missingFields.push(`case:${caseId}`)
    else for (const field of plan.requirements.fields) {
      if (field.owner === 'subject' || field.owner === 'shared' || !field.criticalFor.includes('calculation') || field.category !== 'source-fact' || field.applicability === 'not-applicable') continue
      const fact = candidate.detailFacts[field.fieldId] ?? candidate.listFacts[field.fieldId]
      if (!fact || fact.status !== 'verified' || fact.value === null) missingFields.push(`${caseId}:${field.fieldId}`)
    }
  }
  const limitations = [...new Set(missingFields)].map(field => `待核字段：${field}`)
  if (state.selectedCaseIds.length === 0) limitations.push('未采用案例，仅整理已取得资料')
  if (!state.capabilities.some(item => item.id === 'template-calculation' && item.state === 'ready')) {
    limitations.push('原模板计算路径尚未通过验真，交付已填底稿')
    return { path: 'workpaper', limitations, missingFields: [...new Set(missingFields)] }
  }
  const scope: TemplateMarketScope = { objectId: plan.subject.objectId, templateDigest: plan.template.digest,
    fieldIds: plan.requirements.fields.map(field => field.fieldId), caseIds: state.selectedCaseIds,
    conditions: templateMarketConditionsKey(plan) }
  const accepted = applicableTemplateMarketDispositions(state.dispositions, scope)
  const assumed = accepted.filter(item => item.kind === 'accept-assumption' && item.assumption?.value !== null && item.assumption?.value !== undefined)
  const uncovered = missingFields.filter(field => !assumed.some(item => item.scope.fieldIds.includes(field)))
  if (missingFields.length && uncovered.length === 0 && state.selectedCaseIds.length > 0) {
    return { path: 'scenario', limitations: [...limitations, '采用用户明确提供的情景假设'], missingFields }
  }
  return { path: missingFields.length || state.selectedCaseIds.length === 0 ? 'workpaper' : 'calculate', limitations, missingFields }
}
