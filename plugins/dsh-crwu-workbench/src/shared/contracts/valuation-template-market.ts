import type { TemplateProfile, TemplateRequirements } from './valuation-template.ts'
import type { ValuationWorkflowInitialInput, ValuationWorkflowNodeFailure, ValuationWorkflowQuestion } from './valuation-workflow.ts'
import type { ValuationQuestionAnswer, ValuationWorkflowQuestionnaire } from './valuation-questionnaire.ts'

export const TEMPLATE_MARKET_NODES = ['templates', 'materials', 'collection-plan', 'confirm-plan',
  'search-listings', 'candidate-workbook', 'select-cases', 'inspect-details', 'check-inputs',
  'fill-template', 'validate-delivery'] as const
export type TemplateMarketNodeId = typeof TEMPLATE_MARKET_NODES[number]
export type TemplateMarketValue = string | number | boolean | null
export interface TemplateMarketSourceRef { sourceId: string; digest: string; location: string }
export interface TemplateMarketFact {
  value: TemplateMarketValue
  unit: string
  status: 'verified' | 'missing' | 'conflict' | 'not-applicable' | 'assumed'
  evidenceRefs: TemplateMarketSourceRef[]
}
export interface TemplateMarketCapability { id: string; state: 'ready' | 'missing' | 'failed' | 'unknown'; reason: string }
export interface TemplateMarketScope {
  objectId: string
  templateDigest: string
  fieldIds: string[]
  caseIds: string[]
  conditions: string
}
export interface TemplateMarketDisposition {
  dispositionId: string
  kind: 'leave-blank' | 'defer-verification' | 'stop-search' | 'accept-assumption'
  scope: TemplateMarketScope
  reason: string
  assumption: { value: TemplateMarketValue; unit: string } | null
  acceptedBySubmissionId: string
}
export interface TemplateMarketPlan {
  planId: string
  digest: string
  template: TemplateProfile
  requirements: TemplateRequirements
  subject: { objectId: string; useLabel: string; areaSqm: number | null }
  filters: { city: string; district: string; community: string; propertyType: string; areaMin: number | null; areaMax: number | null }
  priceBasis: 'listing' | 'transaction'
  providers: string[]
  budget: { maxPages: number | null; maxCandidates: number | null; maxDurationMs: number | null }
  stopRules: string[]
  proposedDispositions: TemplateMarketDisposition[]
}
export interface TemplateMarketCandidate {
  caseId: string
  providerId: string
  sourceUrl: string
  sourceRefs: TemplateMarketSourceRef[]
  listFacts: Record<string, TemplateMarketFact>
  detailFacts: Record<string, TemplateMarketFact>
  duplicateRefs: string[]
  status: 'pending' | 'eligible' | 'nearby' | 'rejected'
  similarities: string[]
  differences: string[]
  missingFields: string[]
  recommendation: string
  selectionState: 'unselected' | 'selected' | 'adopted' | 'excluded'
}
export interface TemplateMarketArtifact {
  relativePath: string
  digest: string
  bytes: number
  kind: 'candidates' | 'workpaper' | 'trace' | 'screenshot' | 'calculation'
}
export interface TemplateMarketAttempt {
  providerId: string
  action: 'list' | 'detail' | 'screenshot'
  page: number | null
  caseId: string | null
  state: 'completed' | 'failed' | 'cancelled'
  errorKind: '' | 'missing' | 'execution' | 'probe' | 'access' | 'output-contract' | 'cancelled'
  reason: string
  sourceRefs: TemplateMarketSourceRef[]
}
export interface TemplateMarketResumeTask { providerId: string; page: number }
export interface TemplateMarketBudgetUsed { pages: number; candidates: number; durationMs: number }
export interface TemplateMarketDeliveryDecision {
  path: 'calculate' | 'scenario' | 'workpaper' | 'needs-user'
  limitations: string[]
  missingFields: string[]
}
export interface TemplateMarketCalculation { algorithmId: string; unitPrice: number | null; totalPrice: number | null; traceDigest: string }
export interface TemplateMarketFillTrace {
  fieldId: string
  caseId: string | null
  sheet: string
  cell: string
  fact: TemplateMarketFact
}
export interface TemplateMarketNodeData {
  templates: { catalog: Array<{ templateId: string; relativePath: string; digest: string }>; profiles: TemplateProfile[];
    instructions: Array<TemplateMarketSourceRef & { body: string }>; technicalStatus: Array<{ templateId: string; canFill: boolean; canCalculate: boolean; reasons: string[] }> }
  materials: { subjectFacts: Record<string, TemplateMarketFact>; sourceRefs: TemplateMarketSourceRef[]; unverifiedFields: string[] }
  'collection-plan': { plan: TemplateMarketPlan }
  'confirm-plan': { planDigest: string; accepted: boolean; amendments: string }
  'search-listings': { candidates: TemplateMarketCandidate[]; attempts: TemplateMarketAttempt[]; budgetUsed: TemplateMarketBudgetUsed;
    resumeTasks: TemplateMarketResumeTask[]; stopReason: 'end' | 'budget' | 'access-gap' | 'user-stop' | 'cancelled' }
  'candidate-workbook': { candidateVersion: number; caseIds: string[]; artifact: TemplateMarketArtifact }
  'select-cases': { candidateVersion: number; selectedCaseIds: string[]; searchDecision: 'stop' | 'continue'; supplement: string }
  'inspect-details': { candidates: TemplateMarketCandidate[]; attempts: TemplateMarketAttempt[]; updatedArtifact: TemplateMarketArtifact;
    reselectionCaseIds: string[] }
  'check-inputs': { decision: TemplateMarketDeliveryDecision; missingFields: string[]; requiredJudgments: string[] }
  'fill-template': { artifacts: TemplateMarketArtifact[]; adoptedCaseIds: string[]; fillTrace: TemplateMarketFillTrace[];
    calculation: TemplateMarketCalculation | null; recalculation: 'not-run' | 'verified' | 'failed' }
  'validate-delivery': { verifiedArtifacts: TemplateMarketArtifact[]; deliveryKind: 'workpaper' | 'reference' | 'scenario';
    unverifiedItems: string[]; recoveryActions: string[] }
}
export type TemplateMarketNodeOutcome = 'completed' | 'needs-user' | 'completed-with-limits' | 'failed'
export interface TemplateMarketNodeOutput<N extends TemplateMarketNodeId = TemplateMarketNodeId> {
  outcome: TemplateMarketNodeOutcome
  summary: string
  data: TemplateMarketNodeData[N] | null
  questions: ValuationWorkflowQuestion[]
  limitations: string[]
  failure: ValuationWorkflowNodeFailure | null
}
export interface TemplateMarketNodeInput<N extends TemplateMarketNodeId = TemplateMarketNodeId> {
  runId: string
  nodeId: N
  candidateVersion: number
  inputVersion: number
  initialInput: ValuationWorkflowInitialInput | null
  facts: Record<string, TemplateMarketFact>
  upstream: Partial<{ [K in TemplateMarketNodeId]: TemplateMarketNodeData[K] }>
  knowledge: Array<TemplateMarketSourceRef & { body: string }>
  capabilities: TemplateMarketCapability[]
  answers: Record<string, ValuationQuestionAnswer>
  notes: Array<{ noteId: string; nodeId: string; text: string }>
  dispositions: TemplateMarketDisposition[]
}
export interface TemplateMarketNodeReceipt {
  nodeId: TemplateMarketNodeId
  state: 'pending' | 'running' | 'waiting' | 'passed' | 'partial' | 'failed' | 'cancelled'
  attempt: number
  inputVersion: number
  inputs: TemplateMarketNodeInput | null
  output: TemplateMarketNodeOutput | null
  updatedAt: string
}
export interface TemplateMarketState {
  flowVersion: 'template-market-v2'
  runId: string
  inputVersion: number
  status: 'running' | 'waiting-user' | 'completed' | 'partial' | 'failed' | 'cancelled'
  currentNode: TemplateMarketNodeId
  initialInput: ValuationWorkflowInitialInput | null
  facts: Record<string, TemplateMarketFact>
  knowledge: Array<TemplateMarketSourceRef & { body: string }>
  capabilities: TemplateMarketCapability[]
  receipts: Partial<Record<TemplateMarketNodeId, TemplateMarketNodeReceipt>>
  plan: TemplateMarketPlan | null
  approvedPlanDigest: string | null
  candidates: TemplateMarketCandidate[]
  candidateVersion: number
  selectedCaseIds: string[]
  selectionVersion: number | null
  dispositions: TemplateMarketDisposition[]
  budgetUsed: TemplateMarketBudgetUsed
  resumeTasks: TemplateMarketResumeTask[]
  artifacts: TemplateMarketArtifact[]
  questionnaire: ValuationWorkflowQuestionnaire
  error: string
  updatedAt: string
}
