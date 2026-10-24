import type { TemplateMarketState, TemplateMarketNodeId } from './valuation-template-market.ts'
/**
 * Wire types for the embedded valuation workflow (protocol 43).
 *
 * The shared contract only carries serializable business facts. Host graph logic,
 * DSH sessions and Cordis context stay outside this module.
 */

import type { ValuationWorkflowQuestionnaire } from './valuation-questionnaire.ts'

export const VALUATION_WORKFLOW_STAGES = [
  'elements',
  'rights',
  'plan',
  'evidence',
  'calculation',
  'review',
  'delivery',
] as const
export type ValuationWorkflowStage = (typeof VALUATION_WORKFLOW_STAGES)[number]

export const VALUATION_WORKFLOW_STATUSES = [
  'running',
  'waiting-user',
  'completed',
  'partial',
  'blocked',
  'failed',
  'cancelled',
] as const
export type ValuationWorkflowStatus = (typeof VALUATION_WORKFLOW_STATUSES)[number]

export type ValuationWorkflowOutcome = 'completed' | 'partial' | 'blocked' | 'failed' | 'cancelled'

export type ValuationWorkflowStageState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'passed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export type ValuationWorkflowMode = 'formal' | 'listing-reference'

export interface ValuationWorkflowNodeFailure {
  kind: 'business' | 'output-contract' | 'system'
  reason: string
  requirements: string[]
  actions: string[]
}

export type ValuationWorkflowErrorKind =
  | ''
  | 'invalid-input'
  | 'stale-revision'
  | 'duplicate'
  | 'unknown-run'
  | 'cancelled'
  | 'capability-gap'
  | 'blocked'
  | 'failed'
  | 'stop-unknown'
  | 'infrastructure'

/** One inspected stage receipt. */
export interface ValuationWorkflowStageReceipt {
  stage: ValuationWorkflowStage
  state: ValuationWorkflowStageState
  attempt: number
  /** Actual DSH child session id returned by the inference adapter, not a correlation key. */
  sessionId: string
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
  gaps: string[]
}

/** Accepted object facts for the run. */
export interface ValuationWorkflowObject {
  objectId: string
  useLabel: string
  areaSqm: number | null
}

/** The accepted business mode decision, retained across clarifications. */
export interface ValuationWorkflowDecision {
  mode: ValuationWorkflowMode | null
  accepted: boolean
}

/** One frozen archived file identity first submitted with the run. */
export interface ValuationWorkflowInitialInputFile {
  fileId: string
  fileName: string
  /** Archived case-relative path; never an absolute machine path. */
  relativePath: string
  digest: string
}

/**
 * Canonical immutable snapshot of the entry choices first submitted for a run.
 *
 * It is the original record only: later clarifications, corrections and current
 * facts never rewrite it. Unknown optional choices stay `null`; they never imply
 * an automatic selection.
 */
export interface ValuationWorkflowInitialInput {
  userInput: string
  assetType: string | null
  methodRequest: string | null
  purpose: string | null
  baseDate: string | null
  valueType: string | null
  templateFileId: string | null
  supplementalPrompt: string
  inputDigest: string | null
  files: ValuationWorkflowInitialInputFile[]
}

/** One inspected comparable source in the preflighted valuation plan. */
export interface ValuationWorkflowPlanSource {
  providerId: string
  state: string
  community: string
  detailUrl: string
  fields: {
    unitPrice: number | null
    areaSqm: number | null
    [key: string]: unknown
  }
  transactionType: string
  evidence: string
  /** Why an unusable source attempt failed; never rewritten to `verified`. */
  reason?: string
  [key: string]: unknown
}

export interface ValuationWorkflowPlanMapping {
  field: string
  sheet: string
  range: string
  [key: string]: unknown
}

export interface ValuationWorkflowPlanFormulaCheck {
  ok: boolean
  name: string
  [key: string]: unknown
}

export interface ValuationWorkflowPlanTemplate {
  fileName: string
  relativePath: string
  digest: string
  verified: boolean
  mapping: ValuationWorkflowPlanMapping[]
  formulaChecks: ValuationWorkflowPlanFormulaCheck[]
  [key: string]: unknown
}

/** Host-validated plan content returned by the actual planning preflight. */
export interface ValuationWorkflowPlanContent {
  method: string
  valuationMode: ValuationWorkflowMode
  algorithm: string
  sources: ValuationWorkflowPlanSource[]
  template: ValuationWorkflowPlanTemplate
  basis: Array<Record<string, unknown>>
  limitations: string[]
}

/** Immutable, revision-bound plan receipt shown before data acquisition. */
export interface ValuationWorkflowPlan extends ValuationWorkflowPlanContent {
  /** Host-computed canonical digest; acceptance is bound to this exact value. */
  digest: string
  ready: boolean
  accepted: boolean
  revision: number
  gaps: string[]
}

/** Native editor a Host question renders; free text when the Host does not name one. */
export type ValuationWorkflowQuestionControl =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'multiselect'
  | 'boolean'

export interface ValuationWorkflowQuestionOption {
  value: string
  label: string
}

export interface ValuationWorkflowQuestion {
  answerProtocol?: 2
  allowDefer?: boolean
  questionId: string
  field: string
  prompt: string
  knownValue: string
  source: string
  /** Native control; absent means free text (or the known `mode` select). */
  control?: ValuationWorkflowQuestionControl
  /** Closed choices for `select` / `radio` / `multiselect`. */
  options?: ValuationWorkflowQuestionOption[]
  /** Defaults to required; only an explicit `false` makes a question optional. */
  required?: boolean
  /** The node this question blocks, when the Host can attribute it. */
  nodeId?: string
  /** Explicit semantic version; cosmetic prompt edits may keep the same version. */
  version?: number
  applicable?: boolean
  inapplicabilityReason?: string
  reason?: string
}

export interface ValuationWorkflowClarification {
  clarificationId: string
  revision: number
  questions: ValuationWorkflowQuestion[]
}

export interface ValuationWorkflowResult {
  objectId: string
  useLabel: string
  areaSqm: number
  unitPrice: number
  totalPrice: number
  currency: string
  sources: string[]
  generatedAt: string
}

export interface ValuationWorkflowIntentObject {
  objectId: string
  materialIds: string[]
}

export type ValuationWorkflowIntentEvidence =
  | { materialId: string; quote: string }
  | { source: 'user-input'; quote: string }

/** Serializable intent/route projection for a routed run. */
export interface ValuationWorkflowRouting {
  route: string
  intent: {
    business: 'valuation' | 'unknown'
    assetType: string | null
    status: 'resolved' | 'needs-clarification' | 'unsupported'
    objects: ValuationWorkflowIntentObject[]
    evidence: ValuationWorkflowIntentEvidence[]
    questions: string[]
  } | null
  intentSessionId: string
}

export interface ValuationWorkflowDelivery {
  kind: ValuationWorkflowMode
  artifacts: string[]
  referenceDelivered: boolean
  formalComplete: boolean
}

/** One reviewed field change recorded with the exact value it replaced. */
export interface ValuationWorkflowRevisionChange {
  nodeId: ValuationWorkflowStage | TemplateMarketNodeId
  field: string
  before: unknown
  after: unknown
  /** Only a user-submitted correction is labelled `user`; material facts are not relabelled. */
  sourceKind: 'user'
  source: string
  reason: string
}

export interface ValuationWorkflowRevisionRecord {
  templateMarket?: TemplateMarketState
  revision: number
  status: ValuationWorkflowStatus
  outcome: ValuationWorkflowOutcome | null
  result: ValuationWorkflowResult | null
  reason: string
  source: string
  supersededNodeIds: string[]
  /** Field-level user corrections applied to produce this revision. */
  changes?: ValuationWorkflowRevisionChange[]
  /** Immutable receipt snapshots as they were accepted for this revision. */
  stages?: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  /** Plan receipt accepted (or under review) for this revision. */
  plan?: ValuationWorkflowPlan
  updatedAt?: string
}

export interface ValuationWorkflowSnapshot {
  templateMarket?: TemplateMarketState
  flowVersion?: 'legacy-v1' | 'template-market-v2'
  runId: string
  revision: number
  status: ValuationWorkflowStatus
  outcome: ValuationWorkflowOutcome | null
  object: ValuationWorkflowObject
  decision: ValuationWorkflowDecision
  clarification: ValuationWorkflowClarification | null
  questionnaire?: ValuationWorkflowQuestionnaire
  stages: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  /** Preflighted plan; null for legacy runs without a planning port. */
  plan: ValuationWorkflowPlan | null
  result: ValuationWorkflowResult | null
  delivery: ValuationWorkflowDelivery | null
  revisions: ValuationWorkflowRevisionRecord[]
  /** Current editable conditions; never the immutable first-submitted snapshot. */
  currentInputs?: {
    purpose: string
    baseDate: string
    mode: ValuationWorkflowMode | null
  }
  /** Intent/route projection for runs routed through the overall workflow graph. */
  routing: ValuationWorkflowRouting | null
  updatedAt: string
  error: string
  errorKind: ValuationWorkflowErrorKind
}

export interface ValuationWorkflowOperationOutcome {
  ok: boolean
  errorKind: ValuationWorkflowErrorKind
  error: string
  snapshot: ValuationWorkflowSnapshot
}

// ---------------------------------------------------------------------------
// Client-facing projections (Host-computed, read-only)
// ---------------------------------------------------------------------------

export interface ValuationWorkflowStageView {
  stage: ValuationWorkflowStage
  state: ValuationWorkflowStageState
  objectCount: number
  passedCount: number
  waitingCount: number
  gaps: string[]
}

/** Where one projected field value actually came from. */
export type ValuationWorkflowFieldSourceKind =
  | 'program'
  | 'model'
  | 'material'
  | 'user'
  | 'confirmed'

export interface ValuationWorkflowNodeFieldView {
  field: string
  label: string
  value: string
  source: string
  /** Absent only when the Host cannot prove provenance; never invented. */
  sourceKind?: ValuationWorkflowFieldSourceKind
  editable?: boolean
  /** Structured value for display; `value` stays the wire-safe text projection. */
  rawValue?: unknown
}

export interface ValuationWorkflowKnowledgeRefView {
  sourceId: string
  path: string
  section: string
  quote: string
}

/** One document actually read into the node task, with its real coverage note. */
export interface ValuationWorkflowReadSourceView {
  sourceId: string
  path: string
  digest: string
  coverage: string
}

export interface ValuationWorkflowNodeView {
  nodeId: string
  /** Business stage owned by the actual node; null for router/sentinel nodes. */
  stage: ValuationWorkflowStage | null
  label: string
  revision: number
  current: boolean
  /** Actual DSH child session id from the receipt. */
  sessionId: string
  inputs: ValuationWorkflowNodeFieldView[]
  outputs: ValuationWorkflowNodeFieldView[]
  /** Adopted rules only; raw candidates never appear here. */
  knowledge: ValuationWorkflowKnowledgeRefView[]
  /** Documents read for this node, exposed without invented quotes. */
  readSources: ValuationWorkflowReadSourceView[]
  gaps: string[]
  failure?: ValuationWorkflowNodeFailure
  dependents: Array<{ nodeId: string; label: string }>
  /** Complete cloned receipt.inputs for inspection; absent on non-receipt nodes. */
  rawInputs?: Record<string, unknown>
  /** Complete cloned receipt.outputs for inspection; absent on non-receipt nodes. */
  rawOutputs?: Record<string, unknown>
  /** Actual router projection, read-only; only meaningful on the router node. */
  route?: string
  evidence?: ValuationWorkflowIntentEvidence[]
}

/** One actual compiled graph node, by its exact native id. */
export interface ValuationWorkflowGraphNodeView {
  templateMarketNodeId?: TemplateMarketNodeId
  nodeId: string
  label: string
  state: ValuationWorkflowStageState
  /** Business stage when the actual node owns one; absent for router/sentinels. */
  stage?: ValuationWorkflowStage
  gaps: string[]
}

export interface ValuationWorkflowGraphEdgeView {
  source: string
  target: string
  conditional: boolean
}

/** Plain serializable projection of the actual compiled workflow graph. */
export interface ValuationWorkflowGraphView {
  graphId: string
  version: string
  nodes: ValuationWorkflowGraphNodeView[]
  edges: ValuationWorkflowGraphEdgeView[]
}

export interface ValuationWorkflowProgressView {
  market?: Pick<TemplateMarketState, 'currentNode' | 'plan' | 'candidates' | 'candidateVersion' | 'selectedCaseIds' | 'artifacts'> & {
    /** Host-computed per-node summary/meta; never parsed from raw Node data by the Client. */
    nodes?: Array<{ nodeId: TemplateMarketNodeId; state: string; summary: string; meta: string }>
    recovery?: { retryAllowed: boolean; reason: string }
  }
  runId: string
  revision: number
  status: ValuationWorkflowStatus
  outcome: ValuationWorkflowOutcome | null
  deliveryKind: ValuationWorkflowMode | null
  referenceDelivered: boolean
  formalComplete: boolean
  waiting: boolean
  stages: ValuationWorkflowStageView[]
  acceptedTaskCount: number
  plannedTaskCount: number | null
  percentage: number | null
  clarification: ValuationWorkflowClarification | null
  questionnaire?: ValuationWorkflowQuestionnaire
  updatedAt: string
  /** Actual compiled graph with per-receipt states and gaps. */
  graph: ValuationWorkflowGraphView
  /** Host-validated plan facts for this revision; null when none exists. */
  plan: ValuationWorkflowPlan | null
  /** Accepted result facts; null before a result exists. */
  result: ValuationWorkflowResult | null
  /** Durable revision history, including exact field-level corrections. */
  revisions: ValuationWorkflowRevisionRecord[]
  /** Host-declared global input fields; the owning node supplies the revision target. */
  globalInputs?: Array<ValuationWorkflowNodeFieldView & { nodeId: string }>
}
