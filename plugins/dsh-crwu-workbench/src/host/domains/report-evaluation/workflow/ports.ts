/**
 * Capability ports for the host-neutral valuation workflow domain.
 *
 * The domain imports nothing from DSH, Cordis, Tools or the filesystem: every real
 * capability arrives as an injected port. The inference port returns the **actual**
 * child session id started by the adapter; `correlationId` is only the caller's
 * per-attempt key.
 */
import type {
  ValuationWorkflowInitialInput,
  ValuationWorkflowMode,
  ValuationWorkflowPlan,
  ValuationWorkflowStage,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { ValuationWorkflowQuestionControl, ValuationWorkflowQuestionOption } from '../../../../shared/contracts/valuation-workflow.ts'
import type { TemplateMarketNodeId, TemplateMarketNodeInput, TemplateMarketNodeOutput } from '../../../../shared/contracts/valuation-template-market.ts'

export type TemplateMarketPort<N extends TemplateMarketNodeId> = (input: TemplateMarketNodeInput<N>, signal?: AbortSignal) => Promise<TemplateMarketNodeOutput<N>>
export class TemplateMarketPortError extends Error {}
export interface TemplateMarketPorts {
  readTemplates: TemplateMarketPort<'templates'>
  readMaterials: TemplateMarketPort<'materials'>
  plan: TemplateMarketPort<'collection-plan'>
  search: TemplateMarketPort<'search-listings'>
  writeCandidates: TemplateMarketPort<'candidate-workbook'>
  inspectDetails: TemplateMarketPort<'inspect-details'>
  fillTemplate: TemplateMarketPort<'fill-template'>
  verifyDelivery: TemplateMarketPort<'validate-delivery'>
}

/** Untrusted typed blocker candidate; the domain admits it before business outputs. */
export interface ValuationInferenceQuestion {
  answerProtocol?: 2
  allowDefer?: boolean
  questionId: string
  field: string
  prompt: string
  control: ValuationWorkflowQuestionControl
  required: boolean
  version: number
  applicable: boolean
  reason: string
  options?: ValuationWorkflowQuestionOption[]
}

/**
 * Canonical first-submitted entry choices, independently cloned per port call.
 * Null/absent stays unknown; it never authorizes an automatic selection.
 */
export type { ValuationWorkflowInitialInput }

export interface ValuationKnowledgeRef {
  sourceId: string
  path: string
  section: string
  quote: string
  /** Verified snapshot digest; lets a task package prove which version it saw. */
  digest?: string
  spaceName?: string
  kind?: 'prose' | 'table'
  /**
   * Bounded verified body. When `bodyTruncated` is true the task carries an explicit
   * coverage note instead of silently dropping the rest.
   */
  body?: string
  bodyTruncated?: boolean
  coverageNote?: string
}

/**
 * Neutral durable image wire shape for the domain boundary.
 *
 * The host adapter admits real bytes and returns its own durable reference; the
 * domain only needs these stable structural fields and never imports the host
 * attachment library.
 */
export interface ValuationImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export interface ValuationInferenceRequest {
  runId: string
  revision: number
  nodeId: string
  stage: ValuationWorkflowStage
  attempt: number
  /** Caller-proposed per-attempt correlation key; never presented as a real session. */
  correlationId: string
  /**
   * Optional non-stage operation. `knowledge-selection` runs the isolated source
   * selection contract instead of a stage output contract; `page-reading` sends
   * already-admitted page images through the strict page-reading contract;
   * `planning-selection` runs the isolated market planning-selection contract.
   * `template-analysis` proposes requirements from an inspected workbook and knowledge.
   */
  operation?: 'knowledge-selection' | 'page-reading' | 'planning-selection' | 'template-analysis' | 'template-market'
  /** Admitted page images; only meaningful for the `page-reading` operation. */
  images?: ValuationImageAttachmentRef[]
  /** Confirmed materials; the elements stage inspects these before asking for facts. */
  materials?: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
  facts: Record<string, unknown>
  knowledge: ValuationKnowledgeRef[]
  /** Optional cancellation forwarded by the domain. */
  signal?: AbortSignal
}

export interface ValuationInferenceResult {
  ok: boolean
  /** The actual DSH child session id returned by the adapter. */
  sessionId?: string
  outputs?: Record<string, unknown> & { questions?: ValuationInferenceQuestion[] }
  gaps?: string[]
  error?: string
  errorKind?: string
  failure?: import('../../../../shared/contracts/valuation-workflow.ts').ValuationWorkflowNodeFailure
}

export interface ValuationInferencePort {
  supportsQuestions?: boolean
  infer(input: ValuationInferenceRequest): Promise<ValuationInferenceResult>
}

export interface KnowledgeSourceRecord {
  sourceId: string
  spaceName: string
  path: string
  digest: string
  body: string
  kind: 'prose' | 'table'
}

export interface ValuationKnowledgeReadRequest {
  runId: string
  revision: number
  stage: ValuationWorkflowStage
  objectId: string
  /** Valuation basis (`formal` / `listing-reference`); never the market method. */
  mode: string
  wikiPaths: string[]
  knownSourceDigests: string[]
  /** Actual current user input, when the caller has one. */
  userInput?: string
  /** Frozen admitted materials; same item shape as `ValuationInferenceRequest`. */
  materials?: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
  /** Actual object identity/facts; never a shared mutable record reference. */
  object?: { objectId: string; useLabel: string; areaSqm: number | null }
  /** Resolved routing asset type, or null when no route was adopted. */
  assetType?: string | null
  purpose?: string
  baseDate?: string
  /** Current node's recorded user prompt supplement, when one exists. */
  promptSupplement?: string
  /** Canonical first-submitted choices; cloned, never a shared reference. */
  initialInput?: ValuationWorkflowInitialInput | null
}

export interface ValuationKnowledgeReadResult {
  ok: boolean
  sources?: KnowledgeSourceRecord[]
  samples?: Array<{ sourceId: string; unitPrice: number }>
  gaps?: string[]
  error?: string
}

export interface ValuationKnowledgePort {
  /**
   * When true the service reads verified knowledge for every actual stage and
   * replaces the active references with that stage's selection. The default keeps
   * the legacy single read at the elements stage.
   */
  stageAware?: boolean
  read(input: ValuationKnowledgeReadRequest): Promise<ValuationKnowledgeReadResult>
}

/** One genuinely observed case candidate. Extra source metadata is preserved. */
export interface ValuationObservedSample {
  sourceId: string
  unitPrice: number
  listingKind?: string
  [key: string]: unknown
}

export interface ValuationEvidenceRetrievalAttempt {
  provider: string
  outcome: string
  [key: string]: unknown
}

export interface ValuationEvidenceAcquireRequest {
  runId: string
  revision: number
  object: { objectId: string; useLabel: string; areaSqm: number | null }
  purpose: string
  baseDate: string
  mode: ValuationWorkflowMode | null
  materials: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
  userInput: string
  knowledge: ValuationKnowledgeRef[]
  /**
   * Exact user-approved preflight plan. Durable evidence is derived from its verified
   * sources; a missing, unaccepted, unready or future-revision plan fails closed.
   */
  plan?: ValuationWorkflowPlan
  /** Canonical first-submitted choices; cloned, never a shared reference. */
  initialInput?: ValuationWorkflowInitialInput | null
  signal?: AbortSignal
}

export interface ValuationEvidenceAcquireResult {
  ok: boolean
  samples?: ValuationObservedSample[]
  retrievalAttempts?: ValuationEvidenceRetrievalAttempt[]
  gaps?: string[]
  error?: string
}

export interface ValuationEvidencePort {
  acquire(input: ValuationEvidenceAcquireRequest): Promise<ValuationEvidenceAcquireResult>
}

export interface ValuationCalculatorSubject {
  useLabel: string
  purpose: string
  baseDate: string
}

export interface ValuationCalculatorAssessment {
  mode: ValuationWorkflowMode | null
  objectId: string
  areaSqm: number
  revision: number
  retrievalAttempts?: ValuationEvidenceRetrievalAttempt[]
  /** The user-approved plan that governs this calculation. */
  plan?: ValuationWorkflowPlan
}

export interface ValuationCalculatorRequest {
  runId: string
  revision: number
  objectId: string
  operation: 'listing-reference-mean'
  samples: Array<{ sourceId: string; unitPrice: number }>
  areaSqm: number
  subject: ValuationCalculatorSubject
  /** Adopted, verified knowledge references for the eventual full builder input. */
  knowledge: ValuationKnowledgeRef[]
  /**
   * Exact accepted evidence-stage outputs (including per-source suitability
   * assessments) passed through unchanged. It is a plain copy of the persisted
   * receipt, never a new model call, and it lets the outer adapter read the
   * accepted assessments without trusting a recomputed amount.
   */
  evidenceOutput?: Record<string, unknown>
  /**
   * The real Host-observed case pool for this revision, including any captures made
   * after approval. Plain copy of the durable observed samples; the outer adapter
   * must prefer it over anything re-derived from the preflight plan.
   */
  observations?: ValuationObservedSample[]
  assessment?: ValuationCalculatorAssessment
  signal?: AbortSignal
}

export interface ValuationCalculatorResult {
  ok: boolean
  unitPrice?: number
  totalPrice?: number
  error?: string
}

export interface ValuationCalculatorPort {
  compute(input: ValuationCalculatorRequest): Promise<ValuationCalculatorResult>
}

export interface ValuationArtifactVerificationRequest {
  runId: string
  revision: number
  objectId: string
  artifacts: string[]
  signal?: AbortSignal
}

export interface ValuationArtifactVerificationResult {
  ok: boolean
  verified?: string[]
  missing?: string[]
  error?: string
}

export interface ValuationArtifactVerificationPort {
  verify(input: ValuationArtifactVerificationRequest): Promise<ValuationArtifactVerificationResult>
}

export interface ValuationIntentRequest {
  text: string
  materials: Array<{ materialId: string; fileName: string; digest: string; text: string }>
  /** Canonical first-submitted choices; cloned, never a shared reference. */
  initialInput?: ValuationWorkflowInitialInput | null
}

export interface ValuationIntentResult {
  ok: boolean
  sessionId?: string
  intent?: unknown
  error?: string
  errorKind?: string
}

export interface ValuationIntentPort {
  infer(
    input: ValuationIntentRequest,
    registeredAssetIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ValuationIntentResult>
}

/** Actual source/template preflight performed by the Host adapter. */
export interface ValuationPlanningRequest {
  runId: string
  revision: number
  object: { objectId: string; useLabel: string; areaSqm: number | null }
  purpose: string
  /** Blank is an accepted choice; the adapter never invents a date. */
  baseDate: string
  userInput: string
  materials: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
  knowledge: ValuationKnowledgeRef[]
  /** Candidate method/algorithm output from the plan inference task. */
  methodOutput: Record<string, unknown>
  /** Optional user/operator stage note forwarded to the isolated selection task. */
  promptSupplement?: string
  /** Canonical first-submitted choices; cloned, never a shared reference. */
  initialInput?: ValuationWorkflowInitialInput | null
  signal?: AbortSignal
}

export interface ValuationPlanningResult {
  ok: boolean
  /** Untrusted candidate facts; the domain validates them before use. */
  plan?: unknown
  gaps?: string[]
  questions?: Array<{ field: string; prompt: string }>
  error?: string
  /** Structured stop classification; `stop-unknown` retains writer occupancy. */
  errorKind?: string
  /** Actual preflight child session id when the adapter started one. */
  sessionId?: string
}

export interface ValuationPlanningPort {
  prepare(input: ValuationPlanningRequest): Promise<ValuationPlanningResult>
}

export interface ValuationWorkflowPorts {
  templateMarket?: TemplateMarketPorts
  inference: ValuationInferencePort
  knowledge: ValuationKnowledgePort
  /** Optional real observed-case acquisition; legacy fixtures run without it. */
  evidence?: ValuationEvidencePort
  calculator: ValuationCalculatorPort
  verification: ValuationArtifactVerificationPort
  /** Optional for the existing professional-stage facade; required by routed runs. */
  intent?: ValuationIntentPort
  /** Optional actual plan preflight; legacy runs without it keep the old flow. */
  planning?: ValuationPlanningPort
}
