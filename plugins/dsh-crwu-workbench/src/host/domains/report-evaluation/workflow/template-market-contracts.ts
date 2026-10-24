import { TEMPLATE_MARKET_NODES, type TemplateMarketNodeId, type TemplateMarketNodeOutput,
  type TemplateMarketPlan, type TemplateMarketCandidate } from '../../../../shared/contracts/valuation-template-market.ts'
import { isTemplateProfile, isTemplateRequirements } from './case-collection.ts'
import { validateWorkflowQuestion } from './questionnaire.ts'

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }
export interface MarketJsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, MarketJsonSchema>
  additionalProperties?: boolean | MarketJsonSchema
  required?: string[]
  items?: MarketJsonSchema
  enum?: Array<string | number | boolean | null>
  anyOf?: MarketJsonSchema[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  maxItems?: number
  pattern?: string
}
const s: MarketJsonSchema = { type: 'string', maxLength: 12000 }
const nonempty: MarketJsonSchema = { ...s, minLength: 1 }
const id: MarketJsonSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\x00-\\x1f]+$' }
const digest: MarketJsonSchema = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
const n: MarketJsonSchema = { type: 'number' }
const integer: MarketJsonSchema = { type: 'integer', minimum: 0 }
const positive: MarketJsonSchema = { type: 'integer', minimum: 1 }
const b: MarketJsonSchema = { type: 'boolean' }
const nil: MarketJsonSchema = { type: 'null' }
const nullable = (schema: MarketJsonSchema): MarketJsonSchema => ({ anyOf: [schema, nil] })
const choice = (...values: string[]): MarketJsonSchema => ({ type: 'string', enum: values })
const array = (items: MarketJsonSchema, maxItems = 1000): MarketJsonSchema => ({ type: 'array', items, maxItems })
const strings = array(s)
const ids = array(id)
const object = (properties: Record<string, MarketJsonSchema>, required = Object.keys(properties)): MarketJsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false })
const dictionary = (items: MarketJsonSchema): MarketJsonSchema => ({ type: 'object', additionalProperties: items })
const scalar: MarketJsonSchema = { anyOf: [s, n, b, nil] }
const ref = object({ sourceId: id, digest, location: nonempty })
const refs = array(ref)
const fact = object({ value: scalar, unit: s, status: choice('verified', 'missing', 'conflict', 'not-applicable', 'assumed'), evidenceRefs: refs })
const capability = object({ id, state: choice('ready', 'missing', 'failed', 'unknown'), reason: s })
const scope = object({ objectId: id, templateDigest: digest, fieldIds: ids, caseIds: ids, conditions: s })
const disposition = object({ dispositionId: id, kind: choice('leave-blank', 'defer-verification', 'stop-search', 'accept-assumption'),
  scope, reason: nonempty, assumption: nullable(object({ value: scalar, unit: s })), acceptedBySubmissionId: id })
const cellRef = object({ sheet: nonempty, cell: { type: 'string', pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}$' } })
const profile = object({ templateId: id, digest, relativePath: nonempty,
  sheets: array(object({ name: nonempty, rows: positive, columns: positive, mergedRanges: strings }), 64),
  cells: array(object({ ...cellRef.properties, value: scalar, formula: s }), 100000),
  definedNames: array(object({ name: nonempty, ref: s })), coverage: object({ complete: b, issues: strings }) })
const requirements = object({ templateId: id, templateDigest: digest, version: positive,
  fields: array(object({ owner: choice('subject', 'case', 'shared'), unit: s, fieldId: id, label: nonempty, labelRef: cellRef, targetRefs: array(cellRef),
    category: choice('source-fact', 'shared-fact', 'judgment', 'derived', 'calculation'),
    applicability: choice('applicable', 'not-applicable', 'pending'), criticalFor: array(choice('eligibility', 'calculation')),
    basis: array(object({ sourceId: id, quote: nonempty })) })), questions: array(object({ field: id, prompt: nonempty }), 64) })
const subject = object({ objectId: id, useLabel: s, areaSqm: nullable({ type: 'number', minimum: 0 }) })
const budget = object({ maxPages: nullable(positive), maxCandidates: nullable(positive), maxDurationMs: nullable(positive) })
export const TEMPLATE_MARKET_PLAN_SCHEMA = object({ planId: id, digest, template: profile, requirements, subject,
  filters: object({ city: s, district: s, community: s, propertyType: s, areaMin: nullable(n), areaMax: nullable(n) }),
  priceBasis: choice('listing', 'transaction'), providers: ids, budget, stopRules: strings,
  proposedDispositions: array(object({ ...disposition.properties, acceptedBySubmissionId: choice('') })) })
const candidate = object({ caseId: id, providerId: id, sourceUrl: { type: 'string', pattern: '^https?://[^\\s]+$' },
  sourceRefs: refs, listFacts: dictionary(fact), detailFacts: dictionary(fact), duplicateRefs: ids,
  status: choice('pending', 'eligible', 'nearby', 'rejected'), similarities: strings, differences: strings,
  missingFields: ids, recommendation: s, selectionState: choice('unselected', 'selected', 'adopted', 'excluded') })
const relativePath: MarketJsonSchema = { type: 'string', minLength: 1, maxLength: 1000,
  pattern: '^(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.?(?:[\\\\/]|$))[^:\\x00-\\x1f]+$' }
const artifact = object({ relativePath, digest, bytes: positive, kind: choice('candidates', 'workpaper', 'trace', 'screenshot', 'calculation') })
const attempt = object({ providerId: id, action: choice('list', 'detail', 'screenshot'), page: nullable(positive), caseId: nullable(id),
  state: choice('completed', 'failed', 'cancelled'), errorKind: choice('', 'missing', 'execution', 'probe', 'access', 'output-contract', 'cancelled'),
  reason: s, sourceRefs: refs })
const resume = object({ providerId: id, page: positive })
const budgetUsed = object({ pages: integer, candidates: integer, durationMs: integer })
const decision = object({ path: choice('calculate', 'scenario', 'workpaper', 'needs-user'), limitations: strings, missingFields: ids })
const question = object({ questionId: id, field: id, prompt: nonempty, knownValue: s, source: s,
  control: choice('text', 'textarea', 'number', 'date', 'select', 'radio', 'multiselect', 'boolean'),
  required: b, version: positive, applicable: b, reason: nonempty, answerProtocol: { type: 'integer', enum: [2] },
  allowDefer: b, nodeId: id, options: array(object({ value: id, label: nonempty }), 200), inapplicabilityReason: s },
['questionId', 'field', 'prompt', 'knownValue', 'source', 'control', 'required', 'version', 'applicable', 'reason', 'answerProtocol', 'allowDefer'])
const failure = object({ kind: choice('business', 'output-contract', 'system'), reason: nonempty, requirements: strings, actions: strings })
export const TEMPLATE_MARKET_DATA_SCHEMAS: Record<TemplateMarketNodeId, MarketJsonSchema> = {
  templates: object({ catalog: array(object({ templateId: id, relativePath, digest })), profiles: array(profile, 64), instructions: array(object({ ...ref.properties, body: nonempty })),
    technicalStatus: array(object({ templateId: id, canFill: b, canCalculate: b, reasons: strings })) }),
  materials: object({ subjectFacts: dictionary(fact), sourceRefs: refs, unverifiedFields: ids }),
  'collection-plan': object({ plan: TEMPLATE_MARKET_PLAN_SCHEMA }),
  'confirm-plan': object({ planDigest: digest, accepted: b, amendments: s }),
  'search-listings': object({ candidates: array(candidate), attempts: array(attempt), budgetUsed, resumeTasks: array(resume),
    stopReason: choice('end', 'budget', 'access-gap', 'user-stop', 'cancelled') }),
  'candidate-workbook': object({ candidateVersion: positive, caseIds: ids, artifact }),
  'select-cases': object({ candidateVersion: positive, selectedCaseIds: ids, searchDecision: choice('stop', 'continue'), supplement: s }),
  'inspect-details': object({ candidates: array(candidate), attempts: array(attempt), updatedArtifact: artifact, reselectionCaseIds: ids }),
  'check-inputs': object({ decision, missingFields: ids, requiredJudgments: ids }),
  'fill-template': object({ artifacts: array(artifact), adoptedCaseIds: ids,
    fillTrace: array(object({ fieldId: id, caseId: nullable(id), sheet: nonempty, cell: cellRef.properties!.cell!, fact })),
    calculation: nullable(object({ algorithmId: id, unitPrice: nullable(n), totalPrice: nullable(n), traceDigest: digest })),
    recalculation: choice('not-run', 'verified', 'failed') }),
  'validate-delivery': object({ verifiedArtifacts: array(artifact), deliveryKind: choice('workpaper', 'reference', 'scenario'),
    unverifiedItems: strings, recoveryActions: strings }),
}
export const templateMarketOutputSchema = (nodeId: TemplateMarketNodeId): MarketJsonSchema => object({
  outcome: choice('completed', 'needs-user', 'completed-with-limits', 'failed'), summary: nonempty,
  data: nullable(TEMPLATE_MARKET_DATA_SCHEMAS[nodeId]), questions: array(question, 64), limitations: strings, failure: nullable(failure),
})

const typedAnswer: MarketJsonSchema = { anyOf: [object({ kind: choice('choice'), values: ids, supplement: s }),
  object({ kind: choice('other'), text: s }), object({ kind: choice('value'), value: s, supplement: s }),
  object({ kind: choice('defer'), reason: s })] }
const initial = object({ userInput: s, assetType: nullable(s), methodRequest: nullable(s), purpose: nullable(s),
  baseDate: nullable(s), valueType: nullable(s), templateFileId: nullable(s), supplementalPrompt: s, inputDigest: nullable(s),
  files: array(object({ fileId: id, fileName: nonempty, relativePath, digest })) })
export const templateMarketInputSchema = (nodeId: TemplateMarketNodeId): MarketJsonSchema => object({
  runId: id, nodeId: choice(nodeId), candidateVersion: integer, inputVersion: positive, initialInput: nullable(initial), facts: dictionary(fact),
  upstream: object(TEMPLATE_MARKET_DATA_SCHEMAS, []), knowledge: array(object({ ...ref.properties, body: nonempty })),
  capabilities: array(capability), answers: dictionary(typedAnswer), notes: array(object({ noteId: id, nodeId: id, text: s })), dispositions: array(disposition),
})

export const TEMPLATE_MARKET_STATE_DATA_SCHEMA = object({
  flowVersion: choice('template-market-v2'), runId: id, inputVersion: positive,
  status: choice('running', 'waiting-user', 'completed', 'partial', 'failed', 'cancelled'), currentNode: choice(...TEMPLATE_MARKET_NODES),
  initialInput: nullable(initial), facts: dictionary(fact), knowledge: array(object({ ...ref.properties, body: nonempty })),
  capabilities: array(capability), plan: nullable(TEMPLATE_MARKET_PLAN_SCHEMA), approvedPlanDigest: nullable(digest),
  candidates: array(candidate), candidateVersion: integer, selectedCaseIds: ids, selectionVersion: nullable(positive),
  dispositions: array(disposition), budgetUsed, resumeTasks: array(resume), artifacts: array(artifact), error: s, updatedAt: nonempty,
})

function matches(schema: MarketJsonSchema, value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (schema.anyOf) return schema.anyOf.some(item => matches(item, value, depth + 1))
  if (schema.enum && !schema.enum.some(item => item === value)) return false
  switch (schema.type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'number': case 'integer': return typeof value === 'number' && Number.isFinite(value)
      && (schema.type !== 'integer' || Number.isSafeInteger(value))
      && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum)
    case 'string': return typeof value === 'string' && value.length <= (schema.maxLength ?? 12000)
      && value.length >= (schema.minLength ?? 0) && (schema.pattern === undefined || new RegExp(schema.pattern).test(value))
    case 'array': return Array.isArray(value) && value.length <= (schema.maxItems ?? 1000)
      && value.every(item => schema.items !== undefined && matches(schema.items, item, depth + 1))
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
      const row = value as Record<string, unknown>
      if ((schema.required ?? []).some(key => !Object.hasOwn(row, key)) || Object.keys(row).length > 10000) return false
      return Object.entries(row).every(([key, item]) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false
        const property = schema.properties?.[key]
        if (property) return matches(property, item, depth + 1)
        return typeof schema.additionalProperties === 'object' && matches(schema.additionalProperties, item, depth + 1)
      })
    }
    default: return false
  }
}
export function validateMarketSchema(schema: MarketJsonSchema, value: unknown): ValidationResult {
  return matches(schema, value) ? { ok: true } : { ok: false, errors: ['字段、类型、枚举或引用结构不符合当前节点契约'] }
}
export function validateTemplateMarketInput(nodeId: TemplateMarketNodeId, value: unknown): ValidationResult {
  if (!TEMPLATE_MARKET_NODES.includes(nodeId)) return { ok: false, errors: ['未知节点'] }
  return validateMarketSchema(templateMarketInputSchema(nodeId), value)
}
export function validateTemplateMarketOutput(nodeId: TemplateMarketNodeId, value: unknown): ValidationResult {
  if (!TEMPLATE_MARKET_NODES.includes(nodeId)) return { ok: false, errors: ['未知节点'] }
  const valid = validateMarketSchema(templateMarketOutputSchema(nodeId), value)
  if (!valid.ok) return valid
  const out = value as TemplateMarketNodeOutput
  if (out.outcome === 'needs-user' && (out.questions.length === 0 || !out.questions.every(validateWorkflowQuestion))) {
    return { ok: false, errors: ['等待用户必须包含有效的有类型问题'] }
  }
  if ((out.outcome === 'failed') !== (out.failure !== null) || (out.data === null && !['failed', 'needs-user'].includes(out.outcome))) {
    return { ok: false, errors: ['故障或业务数据与节点结果不一致'] }
  }
  if (nodeId === 'collection-plan' && out.data !== null) {
    const plan = (out.data as { plan: TemplateMarketPlan }).plan
    if (!isTemplateProfile(plan.template) || !isTemplateRequirements(plan.requirements)
      || plan.requirements.templateDigest !== plan.template.digest || plan.requirements.templateId !== plan.template.templateId) {
      return { ok: false, errors: ['方案与实际模板身份不一致'] }
    }
  }
  return { ok: true }
}
export function validateTemplateMarketBinding(nodeId: TemplateMarketNodeId, out: TemplateMarketNodeOutput,
  context: { plan: TemplateMarketPlan | null; candidates: TemplateMarketCandidate[]; candidateVersion: number }): ValidationResult {
  const valid = validateTemplateMarketOutput(nodeId, out)
  if (!valid.ok || out.data === null) return valid
  if (nodeId === 'select-cases') {
    const data = out.data as { candidateVersion: number; selectedCaseIds: string[] }
    if (data.candidateVersion !== context.candidateVersion || new Set(data.selectedCaseIds).size !== data.selectedCaseIds.length
      || data.selectedCaseIds.some(id => !context.candidates.some(c => c.caseId === id && c.status !== 'rejected'))) {
      return { ok: false, errors: ['案例集合已变化或包含不属于当前版本的案例'] }
    }
  }
  if (nodeId === 'confirm-plan' && (out.data as { planDigest: string }).planDigest !== context.plan?.digest) {
    return { ok: false, errors: ['确认的方案不是当前显示版本'] }
  }
  return { ok: true }
}
