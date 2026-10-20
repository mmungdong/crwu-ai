/**
 * Application service for the embedded valuation workflow.
 *
 * Host-neutral: run state, revision guards and one-active-writer rules live here;
 * DSH sessions, knowledge reads, calculation and artifact verification arrive as
 * injected ports. Every stage receipt records the actual session id returned by the
 * inference port (`correlationId` is only the caller's per-attempt key). Model output
 * is treated as candidates: source IDs and prices must resolve to the Host-observed
 * pool before they can reach the controlled calculator.
 */
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type {
  ValuationQuestionEdit,
  ValuationQuestionSubmit,
  ValuationWorkflowQuestionnaire,
} from '../../../../shared/contracts/valuation-questionnaire.ts'
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowClarification,
  type ValuationWorkflowDelivery,
  type ValuationWorkflowErrorKind,
  type ValuationWorkflowInitialInput,
  type ValuationWorkflowMode,
  type ValuationWorkflowObject,
  type ValuationWorkflowOperationOutcome,
  type ValuationWorkflowOutcome,
  type ValuationWorkflowPlan,
  type ValuationWorkflowRevisionChange,
  type ValuationWorkflowRevisionRecord,
  type ValuationWorkflowResult,
  type ValuationWorkflowRouting,
  type ValuationWorkflowSnapshot,
  type ValuationWorkflowStage,
  type ValuationWorkflowStageReceipt,
  type ValuationWorkflowStageState,
  type ValuationWorkflowStatus,
} from '../../../../shared/contracts/valuation-workflow.ts'
import { SUPPLEMENTAL_PROMPT_MAX_LENGTH } from '../project/contracts.ts'
import { PURPOSE_MAX_LENGTH } from '../../../../shared/contracts/valuation-project.ts'
import { nodeFailure, readNodeFailure } from './failure.ts'
import type { ValuationWorkflowNodeFailure } from '../../../../shared/contracts/valuation-workflow.ts'
import {
  LISTING_REFERENCE_ARTIFACTS,
  evaluateListingReferenceRequirement,
} from '../assets/realestate/listing-reference.ts'
import {
  bindKnowledgeRequirements,
  type AcceptedRequirement,
  type RequirementCandidate,
} from '../knowledge/requirements.ts'
import { compileWorkflowGraph } from '../../../graph/graph.ts'
import { compileValuationGraph } from '../../../graph/valuation/graph.ts'
import { createValuationGraphRegistry } from '../../../graph/valuation/registry.ts'
import { validateIntent } from '../../../graph/valuation/intent.ts'
import type { ValuationAssetGraph } from '../../../graph/valuation/registry.ts'
import { compileRealestateGraph } from '../../../graph/valuation/realestate/graph.ts'
import { registerRealestateGraph } from '../../../graph/valuation/realestate/register.ts'
import type {
  GraphDriveStatus,
  InferIntentResult,
  StageRunResult,
  ValuationIntent,
  WorkflowGraphState,
  WorkflowGraphUpdate,
  WorkflowInput,
} from '../../../graph/state.ts'
import { bindElementFacts, isRealCalendarDate } from './elements.ts'
import { cloneInitialInput, deriveInitialInput } from './input-context.ts'
import { canRetryWorkflowIntent } from './intent-retry.ts'
import { buildPlanDigest, clonePlan, validatePreparedPlan } from './plan.ts'
import {
  admitQuestions,
  emptyQuestionnaire,
  saveQuestionDraft,
  submitQuestionAnswers,
} from './questionnaire.ts'
import {
  parseRunRecord,
  serializeRunRecord,
  type ValuationWorkflowRunDTO,
} from './persistence.ts'
import type {
  ValuationEvidenceAcquireResult,
  ValuationEvidenceRetrievalAttempt,
  ValuationKnowledgeRef,
  ValuationObservedSample,
  ValuationPlanningResult,
  ValuationWorkflowPorts,
} from './ports.ts'

export interface ValuationWorkflowStartInput {
  runId: string
  object: { objectId: string; useLabel: string; areaSqm: number | null }
  materials?: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
  userInput?: string
  purpose?: string | null
  baseDate?: string | null
  mode?: ValuationWorkflowMode | null
  /** Explicit canonical first-submitted choices; absent derives only known values. */
  initialInput?: ValuationWorkflowInitialInput | null
}

export interface ValuationWorkflowAnswerInput {
  runId: string
  clarificationId: string
  submissionId: string
  expectedRevision: number
  answers: Record<string, string>
}

export interface ValuationWorkflowRevisionInput {
  runId: string
  nodeId: string
  submissionId: string
  expectedRevision: number
  reason: string
  source: string
  changes: Array<{ field: string; value: unknown }>
}

export interface ValuationWorkflowCancelInput {
  runId: string
  submissionId: string
}

/** Explicit retry of a run that stopped at the intent router before any stage. */
export interface ValuationWorkflowRetryIntentInput {
  runId: string
  expectedRevision: number
  submissionId: string
}

export interface ValuationWorkflowApprovePlanInput {
  runId: string
  expectedRevision: number
  planDigest: string
  submissionId: string
}

export interface ValuationWorkflowService {
  start(input: ValuationWorkflowStartInput): Promise<ValuationWorkflowOperationOutcome>
  get(runId: string): Promise<ValuationWorkflowSnapshot | null>
  answer(input: ValuationWorkflowAnswerInput): Promise<ValuationWorkflowOperationOutcome>
  saveDraft(input: ValuationQuestionEdit & { runId: string }): Promise<ValuationWorkflowOperationOutcome>
  submitQuestions(input: ValuationQuestionSubmit & { runId: string }): Promise<ValuationWorkflowOperationOutcome>
  revise(input: ValuationWorkflowRevisionInput): Promise<ValuationWorkflowOperationOutcome>
  approvePlan(input: ValuationWorkflowApprovePlanInput): Promise<ValuationWorkflowOperationOutcome>
  cancel(input: ValuationWorkflowCancelInput): Promise<ValuationWorkflowOperationOutcome>
  /**
   * Retry one stopped intent-only run with the cached prepared input it already has.
   * It never re-reads materials: a fresh intent child runs against the frozen text.
   * Once that child returns a valid single-object route, the registered professional
   * stages may continue from that route.
   */
  retryIntent(input: ValuationWorkflowRetryIntentInput): Promise<ValuationWorkflowOperationOutcome>
  /** Plain cloned durable image, or null when no such run is resident. */
  exportRun(runId: string): Promise<ValuationWorkflowRunDTO | null>
  /** Validate and admit a durable image; never performs inference or business IO. */
  restoreRun(input: unknown): Promise<ValuationWorkflowOperationOutcome>
  dispose(): void
}

/** Injected durable sink. The Host adapter owns encryption, paths and atomicity. */
export interface ValuationWorkflowPersistence {
  save(state: ValuationWorkflowRunDTO): Promise<void>
}

export interface ValuationWorkflowServiceOptions {
  persistence?: ValuationWorkflowPersistence
  /** Actual compiled-root saver; the routed drive lends it to the child graphs. */
  checkpointer?: BaseCheckpointSaver
}

/** Sanitized outward message; a storage failure never exposes its cause. */
const PERSIST_FAILURE = '运行状态未能持久化，已停止后续业务操作'

/** Internal marker that aborts the graph drive when a durable write fails. */
class DurableStoreFailure extends Error {}

interface StoredSource {
  sourceId: string
  spaceName: string
  path: string
  digest: string
  body: string
  kind: 'prose' | 'table'
}

export interface RunRecord {
  runId: string
  revision: number
  status: ValuationWorkflowStatus
  outcome: ValuationWorkflowOutcome | null
  object: ValuationWorkflowObject
  decision: { mode: ValuationWorkflowMode | null; accepted: boolean }
  clarification: ValuationWorkflowClarification | null
  questionnaire: ValuationWorkflowQuestionnaire
  stages: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  /** Revision-bound preflight receipt; null until the planning port runs. */
  plan: ValuationWorkflowPlan | null
  result: ValuationWorkflowResult | null
  delivery: ValuationWorkflowDelivery | null
  revisions: ValuationWorkflowRevisionRecord[]
  error: string
  errorKind: ValuationWorkflowErrorKind
  purpose: string
  baseDate: string
  userInput: string
  materials: Array<{ materialId: string; fileName: string; digest: string; text?: string }>
  /** Immutable canonical first-submitted choices; never rewritten by later corrections. */
  initialInput: ValuationWorkflowInitialInput | null
  routing: ValuationWorkflowRouting | null
  knowledgeSources: StoredSource[]
  knownSamples: Array<{ sourceId: string; unitPrice: number }>
  /** Host-observed case pool acquired from the real evidence provider, if configured. */
  observedSamples: ValuationObservedSample[]
  evidencePool: {
    key: string
    samples: ValuationObservedSample[]
    retrievalAttempts: ValuationEvidenceRetrievalAttempt[]
  } | null
  evidenceSamples: Array<{ sourceId: string; unitPrice: number }>
  acceptedRequirements: AcceptedRequirement[]
  calculation: { unitPrice: number; totalPrice: number } | null
  active: boolean
  cancelRequested: boolean
  usedSubmissions: Set<string>
  usedClarifications: Set<string>
  /** Per-node user prompt supplements bound into that node's inference task. */
  nodePrompts: Record<ValuationWorkflowStage, string>
  /** Set once a durable write failed; the workflow stops before further business IO. */
  storeFailed: boolean
  controller: AbortController | null
  /** A child whose quiescence is unknown keeps the writer occupied until resolved. */
  stopUnknown: { sessionId: string; error: string } | null
  updatedAt: string
}

const STAGE_STATE: ValuationWorkflowStageState = 'pending'

/** The stage that owns each editable current fact. */
const FIELD_OWNER: Record<string, ValuationWorkflowStage> = {
  areaSqm: 'rights',
  useLabel: 'rights',
  purpose: 'elements',
  baseDate: 'elements',
  mode: 'elements',
}

/**
 * Verified body bound into inference tasks. The bound is large enough to carry a full
 * business document; when a body still exceeds it the task gets an explicit coverage
 * note and the evidence stage refuses to deliver if an adopted quote is not included.
 */
const KNOWLEDGE_BODY_LIMIT = 64000
const CALCULATOR_IDS = ['listing-reference.mean']

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Deep copy of a plain JSON receipt; downstream ports never share mutable run state. */
function clonePlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function submittedQuestionContext(record: RunRecord, nodeId?: string): string {
  const questions = record.questionnaire.questions.filter((question) => question.applicable
    && !question.needsConfirmation && question.answer !== null && (nodeId === undefined || question.nodeId === nodeId))
  const notes = record.questionnaire.notes.filter((note) => nodeId === undefined || note.nodeId === nodeId)
  const legacy = record.questionnaire.legacy.filter((note) => nodeId === undefined || note.nodeId === nodeId)
  return [
    ...questions.map((question) => `${question.prompt}\n${question.answer?.unknown === true
      ? `无法确认：${question.answer.reason ?? ''}` : question.answer?.value ?? ''}`),
    ...notes.map((note) => `用户补充：${note.text}`),
    ...legacy.map((note) => `历史补充（原文）：${note.text}`),
  ].join('\n\n')
}

function currentUserInput(record: RunRecord): string {
  const context = submittedQuestionContext(record)
  return context === '' ? record.userInput : `${record.userInput}\n当前有效问答（不含草稿；不替代材料核验）：\n${context}`
}

/** Adapt the service's legacy stage string to the graph drive vocabulary. */
function toGraphStatus(status: string): GraphDriveStatus {
  if (status === 'stop-unknown') return 'failed'
  if (status === 'running' || status === 'waiting' || status === 'completed'
    || status === 'blocked' || status === 'failed' || status === 'cancelled') {
    return status
  }
  return 'blocked'
}

function stageRunResult(record: RunRecord, stage: ValuationWorkflowStage, status: string): StageRunResult {
  const graphStatus = toGraphStatus(status)
  if (graphStatus !== 'running') return { status: graphStatus }
  const outputs = record.stages[stage].outputs
  if (Object.keys(outputs).length === 0) return { status: graphStatus }
  return { status: graphStatus, outputs: { [stage]: { ...outputs } } }
}

function emptyStages(): Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt> {
  const stages = {} as Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  for (const stage of VALUATION_WORKFLOW_STAGES) {
    stages[stage] = { stage, state: STAGE_STATE, attempt: 0, sessionId: '', inputs: {}, outputs: {}, gaps: [] }
  }
  return stages
}

function copyStage(receipt: ValuationWorkflowStageReceipt): ValuationWorkflowStageReceipt {
  return {
    stage: receipt.stage,
    state: receipt.state,
    attempt: receipt.attempt,
    sessionId: receipt.sessionId,
    inputs: { ...receipt.inputs },
    outputs: { ...receipt.outputs },
    gaps: [...receipt.gaps],
  }
}

function copyStages(record: RunRecord): Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt> {
  const stages = {} as Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  for (const stage of VALUATION_WORKFLOW_STAGES) stages[stage] = copyStage(record.stages[stage])
  return stages
}

function emptyPrompts(): Record<ValuationWorkflowStage, string> {
  const prompts = {} as Record<ValuationWorkflowStage, string>
  for (const stage of VALUATION_WORKFLOW_STAGES) prompts[stage] = ''
  return prompts
}

function newRecord(input: ValuationWorkflowStartInput): RunRecord {
  const rawArea = input.object?.areaSqm
  return {
    runId: input.runId,
    revision: 1,
    status: 'running',
    outcome: null,
    object: {
      objectId: String(input.object?.objectId ?? ''),
      useLabel: String(input.object?.useLabel ?? ''),
      // A non-positive or non-finite area is not a fact: it becomes an open question.
      areaSqm: typeof rawArea === 'number' && Number.isFinite(rawArea) && rawArea > 0 ? rawArea : null,
    },
    decision: { mode: input.mode ?? null, accepted: input.mode !== null && input.mode !== undefined },
    clarification: null,
    questionnaire: emptyQuestionnaire(),
    stages: emptyStages(),
    plan: null,
    result: null,
    delivery: null,
    revisions: [],
    error: '',
    errorKind: '',
    purpose: input.purpose === null || input.purpose === undefined ? '' : String(input.purpose),
    baseDate: input.baseDate === null || input.baseDate === undefined ? '' : String(input.baseDate),
    userInput: typeof input.userInput === 'string' ? input.userInput : '',
    materials: (input.materials ?? []).map((material) => ({
      ...material,
      text: typeof material.text === 'string' ? material.text : '',
    })),
    // Explicit structured choices are cloned verbatim; an omitted snapshot derives
    // only the known start values and never guesses an asset or method.
    initialInput: cloneInitialInput(input.initialInput) ?? deriveInitialInput(input),
    routing: null,
    knowledgeSources: [],
    knownSamples: [],
    observedSamples: [],
    evidencePool: null,
    evidenceSamples: [],
    acceptedRequirements: [],
    calculation: null,
    active: false,
    cancelRequested: false,
    usedSubmissions: new Set(),
    usedClarifications: new Set(),
    nodePrompts: emptyPrompts(),
    storeFailed: false,
    controller: null,
    stopUnknown: null,
    updatedAt: new Date().toISOString(),
  }
}

function snapshotOf(record: RunRecord): ValuationWorkflowSnapshot {
  return {
    runId: record.runId,
    revision: record.revision,
    status: record.status,
    outcome: record.outcome,
    object: { ...record.object },
    decision: { ...record.decision },
    clarification: record.clarification === null ? null : clonePlainJson(record.clarification),
    questionnaire: clonePlainJson(record.questionnaire),
    stages: copyStages(record),
    plan: record.plan === null ? null : clonePlan(record.plan),
    result: record.result === null ? null : { ...record.result, sources: [...record.result.sources] },
    delivery: record.delivery === null ? null : { ...record.delivery, artifacts: [...record.delivery.artifacts] },
    currentInputs: {
      purpose: record.purpose,
      baseDate: record.baseDate,
      mode: record.decision.mode,
    },
    routing: record.routing === null ? null : {
      route: record.routing.route,
      intent: record.routing.intent === null ? null : {
        ...record.routing.intent,
        objects: record.routing.intent.objects.map((object) => ({ ...object, materialIds: [...object.materialIds] })),
        evidence: record.routing.intent.evidence.map((evidence) => (
          'source' in evidence
            ? { source: evidence.source, quote: evidence.quote }
            : { materialId: evidence.materialId, quote: evidence.quote }
        )),
        questions: [...record.routing.intent.questions],
      },
      intentSessionId: record.routing.intentSessionId,
    },
    revisions: record.revisions.map((revision) => ({
      ...revision,
      result: revision.result === null ? null : { ...revision.result, sources: [...revision.result.sources] },
      supersededNodeIds: [...revision.supersededNodeIds],
      ...(revision.changes === undefined
        ? {}
        : {
          changes: revision.changes.map((change) => ({
            nodeId: change.nodeId,
            field: change.field,
            before: change.before,
            after: change.after,
            sourceKind: change.sourceKind,
            source: change.source,
            reason: change.reason,
          })),
        }),
      ...(revision.stages === undefined ? {} : { stages: copyStagesOf(revision.stages) }),
      ...(revision.plan === undefined ? {} : { plan: clonePlan(revision.plan) }),
    })),
    updatedAt: record.updatedAt,
    error: record.error,
    errorKind: record.errorKind,
  }
}

function copyStagesOf(
  stages: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>,
): Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt> {
  const copy = {} as Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  for (const stage of VALUATION_WORKFLOW_STAGES) copy[stage] = copyStage(stages[stage])
  return copy
}

function outcomeOf(
  record: RunRecord,
  errorKind: ValuationWorkflowErrorKind = '',
  error = '',
): ValuationWorkflowOperationOutcome {
  // A run whose durable write failed must never look accepted, whatever the caller
  // requested. An unknown child stop still outranks storage, and only the sanitized
  // marker/occupancy text is exposed, never the underlying storage error.
  if (record.storeFailed) {
    if (record.stopUnknown !== null) {
      return { ok: false, errorKind: 'stop-unknown', error: record.stopUnknown.error, snapshot: snapshotOf(record) }
    }
    return {
      ok: false,
      errorKind: record.errorKind === '' ? 'infrastructure' : record.errorKind,
      error: record.error,
      snapshot: snapshotOf(record),
    }
  }
  return { ok: errorKind === '', errorKind, error, snapshot: snapshotOf(record) }
}

function routingIntentOf(intent: ValuationIntent | null): ValuationWorkflowRouting['intent'] {
  if (intent === null) return null
  return {
    business: intent.business,
    assetType: intent.assetType,
    status: intent.status,
    objects: intent.objects.map((object) => ({ ...object, materialIds: [...object.materialIds] })),
    evidence: intent.evidence.map((evidence) => (
      'source' in evidence
        ? { source: evidence.source, quote: evidence.quote }
        : { materialId: evidence.materialId, quote: evidence.quote }
    )),
    questions: [...intent.questions],
  }
}

function knowledgeRefs(record: RunRecord): ValuationKnowledgeRef[] {
  return record.knowledgeSources.map((source) => {
    const truncated = source.body.length > KNOWLEDGE_BODY_LIMIT
    return {
      sourceId: source.sourceId,
      path: source.path,
      section: '',
      quote: source.body.slice(0, 400),
      digest: source.digest,
      spaceName: source.spaceName,
      kind: source.kind,
      body: truncated ? source.body.slice(0, KNOWLEDGE_BODY_LIMIT) : source.body,
      bodyTruncated: truncated,
      coverageNote: truncated ? `正文超过 ${String(KNOWLEDGE_BODY_LIMIT)} 字符，按覆盖上限截断` : '',
    }
  })
}

function knowledgeReceiptRefs(record: RunRecord): Array<Record<string, unknown>> {
  return record.knowledgeSources.map((source) => {
    const truncated = source.body.length > KNOWLEDGE_BODY_LIMIT
    return {
      sourceId: source.sourceId,
      path: source.path,
      digest: source.digest,
      spaceName: source.spaceName,
      kind: source.kind,
      bodyTruncated: truncated,
      coverageNote: truncated ? `正文超过 ${String(KNOWLEDGE_BODY_LIMIT)} 字符，按覆盖上限截断` : '',
    }
  })
}

function acceptedUpstream(
  stage: ValuationWorkflowStage,
  state: WorkflowGraphState | undefined,
): Record<string, Record<string, unknown>> {
  const upstream: Record<string, Record<string, unknown>> = {}
  if (state === undefined) return upstream
  const stageIndex = VALUATION_WORKFLOW_STAGES.indexOf(stage)
  for (const [key, value] of Object.entries(state.outputs)) {
    const index = VALUATION_WORKFLOW_STAGES.indexOf(key as ValuationWorkflowStage)
    if (index < 0 || index >= stageIndex) continue
    upstream[key] = { ...value }
  }
  return upstream
}

function retainedStageOutputs(
  record: RunRecord,
  entry: ValuationWorkflowStage,
): Record<string, Record<string, unknown>> {
  const outputs: Record<string, Record<string, unknown>> = {}
  const entryIndex = VALUATION_WORKFLOW_STAGES.indexOf(entry)
  for (const stage of VALUATION_WORKFLOW_STAGES.slice(0, entryIndex)) {
    const receipt = record.stages[stage]
    if ((receipt.state === 'passed' || receipt.state === 'partial') && Object.keys(receipt.outputs).length > 0) {
      outputs[stage] = { ...receipt.outputs }
    }
  }
  return outputs
}

/**
 * Complete stage-output seed for one explicit entry. Every one of the seven keys is
 * present (non-retained stages become `{}`) so the graph's merging `outputs` reducer
 * cannot replay stale checkpoint values over accepted corrected inputs.
 */
function stateOutputsFor(
  record: RunRecord,
  entry: ValuationWorkflowStage,
): Record<string, Record<string, unknown>> {
  const retained = retainedStageOutputs(record, entry)
  const outputs: Record<string, Record<string, unknown>> = {}
  for (const stage of VALUATION_WORKFLOW_STAGES) outputs[stage] = retained[stage] ?? {}
  return outputs
}

function stageFacts(
  record: RunRecord,
  stage: ValuationWorkflowStage,
  upstream: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const currentRevision = record.revisions.find((item) => item.revision === record.revision)
  const initialInput = cloneInitialInput(record.initialInput)
  const routing = record.routing === null ? null : clonePlainJson(record.routing)
  const confirmedFacts = {
    objectId: record.object.objectId,
    useLabel: record.object.useLabel,
    areaSqm: record.object.areaSqm,
    purpose: record.purpose,
    baseDate: record.baseDate,
    mode: record.decision.mode,
  }
  const questionnaire = {
    questions: record.questionnaire.questions.map((question) => ({
      nodeId: question.nodeId, questionId: question.questionId, field: question.field, prompt: question.prompt,
      control: question.control, options: question.options, required: question.required, version: question.definitionVersion ?? question.version,
      applicable: question.applicable, inapplicabilityReason: question.inapplicabilityReason,
      answer: question.needsConfirmation ? null : question.answer, source: '用户回答',
    })),
    notes: record.questionnaire.notes.map((note) => ({ nodeId: note.nodeId, text: note.text })),
    legacy: clonePlainJson(record.questionnaire.legacy),
  }
  return {
    ...confirmedFacts,
    stage,
    // Current attempt context stays distinct from the immutable first snapshot.
    userInput: currentUserInput(record),
    questionnaire,
    currentQuestionnaire: clonePlainJson(questionnaire),
    initialInput,
    assetType: routing?.intent?.assetType ?? null,
    methodRequest: initialInput?.methodRequest ?? null,
    valueType: initialInput?.valueType ?? null,
    routing,
    promptSupplement: record.nodePrompts[stage] ?? '',
    materialIds: record.materials.map((material) => material.materialId),
    knowledgeSourceIds: record.knowledgeSources.map((source) => source.sourceId),
    confirmedFacts,
    ...(stage === 'evidence' && record.observedSamples.length > 0
      ? { observedSamples: record.observedSamples.map((sample) => ({ ...sample })) }
      : {}),
    ...(record.plan !== null && record.plan.accepted ? { plan: clonePlan(record.plan) } : {}),
    revision: {
      revision: record.revision,
      reason: currentRevision?.reason ?? '',
      source: currentRevision?.source ?? '',
      changes: currentRevision?.changes === undefined ? [] : clonePlainJson(currentRevision.changes),
    },
    upstream,
  }
}

function bindContext(record: RunRecord, stage: ValuationWorkflowStage) {
  const spaceName = record.knowledgeSources[0]?.spaceName ?? ''
  return {
    objectId: record.object.objectId,
    stage,
    mode: record.decision.mode ?? '',
    method: 'listing-reference',
    facts: { areaSqm: record.object.areaSqm, baseDate: record.baseDate },
    sourceScope: { spaceName, paths: record.knowledgeSources.map((source) => source.path) },
    allowedCalculatorIds: CALCULATOR_IDS,
  }
}

/**
 * Evaluate each accepted requirement against Host-observed actual values, and prove
 * the adopted quote really entered the task package. A mandatory requirement that is
 * violated, unsupported, unknown or not covered blocks the downstream calculation.
 */
function evaluateAcceptedRequirements(record: RunRecord, accepted: AcceptedRequirement[]): string[] {
  const refs = knowledgeRefs(record)
  const actual = {
    sampleCount: record.evidenceSamples.length,
    areaSqm: record.object.areaSqm,
    algorithm: 'listing-reference.mean',
  }
  const problems: string[] = []
  for (const requirement of accepted) {
    const ref = refs.find((item) => item.sourceId === requirement.sourceId)
    if (ref === undefined || !(ref.body ?? '').includes(requirement.quote)) {
      problems.push(`采用的原文没有完整进入本节点任务包：${requirement.requirementId}`)
      continue
    }
    const evaluation = evaluateListingReferenceRequirement({ parameter: requirement.parameter, actual })
    if (evaluation.status !== 'satisfied' && requirement.strength === 'must') {
      problems.push(`${requirement.requirementId}: ${evaluation.message}`)
    }
  }
  return problems
}

function cloneObservedSamples(samples: readonly ValuationObservedSample[]): ValuationObservedSample[] {
  return samples.map((sample) => ({ ...sample }))
}

/**
 * Identity of the immutable source pool an evidence acquisition belongs to.
 * Area is deliberately absent: an area-only revision reuses the same observed pool.
 * A use-label change, new knowledge or new materials produce a new key.
 */
function evidencePoolKey(record: RunRecord): string {
  return JSON.stringify({
    objectId: record.object.objectId,
    useLabel: record.object.useLabel,
    mode: record.decision.mode ?? '',
    purpose: record.purpose,
    baseDate: record.baseDate,
    knowledge: record.knowledgeSources.map((source) => `${source.sourceId}@${source.digest}`).sort(),
    materials: record.materials.map((material) => `${material.materialId}@${material.digest}`).sort(),
  })
}

/** Reject an acquisition that cannot be a genuine, independent observed pool. */
function observedSamplesProblem(
  samples: readonly ValuationObservedSample[] | undefined,
): { ok: true; samples: ValuationObservedSample[] } | { ok: false; gaps: string[] } {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { ok: false, gaps: ['证据来源没有返回任何可用样本'] }
  }
  const gaps: string[] = []
  const seen = new Set<string>()
  const accepted: ValuationObservedSample[] = []
  for (const raw of samples as unknown[]) {
    if (raw === null || typeof raw !== 'object') {
      gaps.push('证据来源返回了无效样本')
      continue
    }
    const item = raw as Record<string, unknown>
    const sourceId = typeof item.sourceId === 'string' ? item.sourceId.trim() : ''
    const unitPrice = item.unitPrice
    if (sourceId === '') {
      gaps.push('证据来源样本缺少来源标识')
      continue
    }
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      gaps.push(`证据来源 ${sourceId} 的单价不是正数`)
      continue
    }
    if (seen.has(sourceId)) {
      gaps.push(`证据来源重复：${sourceId}`)
      continue
    }
    seen.add(sourceId)
    accepted.push({ ...item, sourceId, unitPrice } as ValuationObservedSample)
  }
  if (gaps.length > 0) return { ok: false, gaps }
  return { ok: true, samples: accepted }
}

/**
 * Create the workflow service over injected capability ports.
 *
 * In-memory run state is bound to one service instance; the Host composition owns
 * the instance and disposes it with the plugin lifecycle.
 */
export function createValuationWorkflowService(
  ports: ValuationWorkflowPorts,
  options: ValuationWorkflowServiceOptions = {},
): ValuationWorkflowService {
  const runs = new Map<string, RunRecord>()
  const hasIntentPort = ports.intent !== undefined
  const persistence = options.persistence
  const checkpointer = options.checkpointer
  let persistenceTail: Promise<void> = Promise.resolve()

  const touch = (record: RunRecord): void => { record.updatedAt = new Date().toISOString() }

  /** One awaited durable write. When no sink is supplied the call is a no-op. */
  const persist = async (record: RunRecord): Promise<boolean> => {
    if (persistence === undefined) return true
    try {
      const image = serializeRunRecord(record)
      const saving = persistenceTail.then(async () => { await persistence.save(image) })
      persistenceTail = saving.catch(() => {})
      await saving
      return true
    } catch {
      return false
    }
  }

  /** Fail closed without ever surfacing the storage error text. */
  const markStoreFailure = (record: RunRecord): void => {
    record.storeFailed = true
    record.active = false
    record.controller = null
    record.status = 'failed'
    record.outcome = 'failed'
    if (record.stopUnknown === null) {
      record.errorKind = 'infrastructure'
      record.error = PERSIST_FAILURE
    } else {
      // An unknown child stop keeps writer occupancy even when storage also failed.
      record.errorKind = 'stop-unknown'
      record.error = record.stopUnknown.error
    }
    touch(record)
  }

  const persistOrThrow = async (record: RunRecord): Promise<void> => {
    if (!(await persist(record))) {
      markStoreFailure(record)
      throw new DurableStoreFailure()
    }
  }

  /** Final awaited save for a public operation, keeping the sanitized outcome. */
  const finish = async (
    record: RunRecord,
    errorKind: ValuationWorkflowErrorKind = '',
    error = '',
  ): Promise<ValuationWorkflowOperationOutcome> => {
    if (!(await persist(record))) {
      markStoreFailure(record)
      return outcomeOf(record)
    }
    return outcomeOf(record, errorKind, error)
  }

  const block = (record: RunRecord, receipt: ValuationWorkflowStageReceipt, gaps: string[], failure?: ValuationWorkflowNodeFailure): string => {
    receipt.state = 'blocked'
    const detail = failure ?? nodeFailure('business', gaps)
    receipt.outputs = { ...receipt.outputs, failure: detail }
    receipt.gaps = gaps.filter((gap) => gap.trim() !== '')
    if (receipt.gaps.length === 0) receipt.gaps = [...detail.requirements]
    record.status = 'blocked'
    record.outcome = 'blocked'
    record.errorKind = 'blocked'
    record.error = receipt.gaps.join('；') || '节点没有通过'
    touch(record)
    return 'blocked'
  }

  const fail = (record: RunRecord, receipt: ValuationWorkflowStageReceipt, error: string, failure?: ValuationWorkflowNodeFailure): string => {
    const detail = failure ?? nodeFailure('system', [error])
    receipt.outputs = { ...receipt.outputs, failure: detail }
    receipt.state = 'failed'
    receipt.gaps = [detail.reason]
    record.status = 'failed'
    record.outcome = 'failed'
    record.errorKind = 'failed'
    record.error = detail.reason
    touch(record)
    return 'failed'
  }

  const waitForQuestions = (record: RunRecord, receipt: ValuationWorkflowStageReceipt, raw: unknown): string | null => {
    if (!Array.isArray(raw)) return fail(record, receipt, '模型返回的问题清单格式无效')
    try {
      const candidates = raw.map((candidate: unknown) => {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid question')
        const question = candidate as Record<string, unknown>
        return { ...question, knownValue: typeof question.knownValue === 'string' ? question.knownValue : '', source: '节点模型核验',
          ...(question.applicable === false ? { inapplicabilityReason: question.reason } : {}) }
      })
      record.questionnaire = admitQuestions(record.questionnaire, receipt.stage, candidates as ValuationWorkflowClarification['questions'])
    } catch {
      return fail(record, receipt, '模型返回的问题定义无效，请重试该节点')
    }
    const open = record.questionnaire.questions.filter((question) => question.nodeId === receipt.stage && question.applicable)
    const unanswered = open.filter((question) => question.answer === null || question.needsConfirmation)
    if (unanswered.length > 0) {
      receipt.state = 'waiting'
      receipt.gaps = unanswered.map((question) => question.reason || question.prompt)
      record.status = 'waiting-user'
      record.outcome = null
      record.error = ''
      record.errorKind = ''
      touch(record)
      return 'waiting'
    }
    return raw.length > 0 && open.length > 0
      ? block(record, receipt, open.map((question) => `当前信息仍无法解决：${question.reason || question.prompt}`)) : null
  }

  const clarifyBusinessBlock = async (record: RunRecord, receipt: ValuationWorkflowStageReceipt,
    problems: Array<{ field: string; prompt: string }>, gaps: string[]): Promise<string> => {
    if (!ports.inference.supportsQuestions || problems.length === 0) return block(record, receipt, gaps)
    const facts = { ...stageFacts(record, receipt.stage, {}), questionGenerationOnly: true, problems, gaps }
    await persistOrThrow(record)
    const result = await ports.inference.infer({ runId: record.runId, revision: record.revision, nodeId: receipt.stage,
      stage: receipt.stage, attempt: receipt.attempt, correlationId: `${record.runId}:${receipt.stage}:questions:${record.revision}`,
      facts, materials: record.materials.map((material) => ({ ...material, text: material.text ?? '' })), knowledge: knowledgeRefs(record),
      ...(record.controller === null ? {} : { signal: record.controller.signal }) }).catch(() => null)
    if (result?.errorKind === 'stop-unknown') {
      record.stopUnknown = { sessionId: result.sessionId ?? '', error: result.error ?? '问题整理子会话停止尚未确认' }
      receipt.sessionId = result.sessionId ?? ''
      block(record, receipt, [record.stopUnknown.error], nodeFailure('system', [record.stopUnknown.error]))
      record.errorKind = 'stop-unknown'
      return 'stop-unknown'
    }
    if (record.cancelRequested) return 'cancelled'
    if (!result?.ok) {
      if (result?.sessionId) receipt.sessionId = result.sessionId
      const failure = result?.failure ?? nodeFailure('system', [...gaps,
        result?.error ?? '问题整理子会话没有返回完整问题或失败说明。'])
      return fail(record, receipt, failure.reason, failure)
    }
    receipt.sessionId = result.sessionId ?? receipt.sessionId
    const failure = readNodeFailure(result.outputs?.failure)
    if (result.outputs?.failure !== undefined && failure === null) {
      return fail(record, receipt, '问题整理返回的失败说明不完整：须有具体原因、未满足要求和恢复动作。')
    }
    if (failure !== null && failure.kind !== 'business') return fail(record, receipt, failure.reason, failure)
    if (result.outputs?.questions === undefined) return failure === null
      ? fail(record, receipt, '问题整理没有返回问题清单或完整失败说明，请重新执行节点。')
      : block(record, receipt, failure.requirements, failure)
    receipt.outputs = { ...receipt.outputs, questions: result.outputs.questions, ...(failure === null ? {} : { failure }) }
    return waitForQuestions(record, receipt, result.outputs.questions) ?? block(record, receipt, gaps)
  }

  const buildClarificationIfNeeded = (record: RunRecord): boolean => {
    const questions: ValuationWorkflowClarification['questions'] = []
    // With a real planning port an unspecified purpose is an accepted choice: the plan
    // preflight carries the business requirement instead of inventing a purpose question.
    // The legacy facade without planning keeps asking for it.
    if (record.purpose === '' && ports.planning === undefined) {
      questions.push({
        questionId: 'q-purpose', field: 'purpose', prompt: '请指定本次评估目的',
        knownValue: '', source: '用户输入', control: 'text',
      })
    }
    // A blank base date is an accepted choice, never a missing fact to ask for or fill.
    // With a planning port the preflight proposes the supported mode; do not ask a
    // pre-availability mode question at elements.
    if (record.decision.mode === null && ports.planning === undefined) {
      questions.push({
        questionId: 'q-mode', field: 'mode', prompt: '请确认正式估值或挂牌参考口径',
        knownValue: '', source: '用户输入', control: 'radio',
        options: [
          { value: 'listing-reference', label: '挂牌参考' },
          { value: 'formal', label: '正式评估' },
        ],
      })
    }
    if (record.object.useLabel === '') {
      questions.push({
        questionId: 'q-use-label', field: 'useLabel', prompt: '请确认估价对象原始用途',
        knownValue: '', source: '资料', control: 'text',
      })
    }
    if (record.object.areaSqm === null) {
      questions.push({
        questionId: 'q-area', field: 'areaSqm', prompt: '请确认估价对象建筑面积',
        knownValue: '', source: '资料', control: 'number',
      })
    }
    if (questions.length === 0) return false
    record.clarification = {
      clarificationId: `${record.runId}:clar:${String(record.revision)}`,
      revision: record.revision,
      questions,
    }
    record.questionnaire = admitQuestions(record.questionnaire, 'elements', questions.map((question) => ({ ...question, nodeId: 'elements' })))
    record.status = 'waiting-user'
    touch(record)
    return true
  }

  const buildIntentClarification = (record: RunRecord, intent: ValuationIntent | null): boolean => {
    if (intent === null || intent.status !== 'needs-clarification') return false
    const prompts = intent.questions.length > 0 ? intent.questions : ['请确认本次估值对象']
    record.clarification = {
      clarificationId: `${record.runId}:intent:${String(record.revision)}`,
      revision: record.revision,
      questions: prompts.map((prompt, index) => ({
        questionId: `q-intent-${String(index)}`,
        field: `intent-${String(index)}`,
        prompt,
        knownValue: '',
        source: '用户输入',
      })),
    }
    record.questionnaire = admitQuestions(record.questionnaire, 'intent', record.clarification.questions.map((question) => {
      const previous = record.questionnaire.questions.find((stored) => stored.nodeId === 'intent' && stored.field === question.field)
      return { ...question, nodeId: 'intent', control: 'text' as const,
        version: previous === undefined ? 1 : previous.prompt === question.prompt ? previous.version : previous.version + 1 }
    }))
    record.status = 'waiting-user'
    record.outcome = null
    record.error = ''
    record.errorKind = ''
    touch(record)
    return true
  }

  const inferRoutedIntent = async (
    record: RunRecord,
    input: WorkflowInput,
    registeredAssetIds: readonly string[],
  ): Promise<InferIntentResult> => {
    const intentPort = ports.intent
    if (intentPort === undefined) {
      return { ok: false, errorKind: 'capability-gap', error: '意图端口未配置' }
    }
    const result = await intentPort.infer({
      text: input.text,
      materials: input.materials.map((material) => ({ ...material, text: material.text ?? '' })),
      initialInput: cloneInitialInput(input.initialInput ?? record.initialInput),
    }, [...registeredAssetIds], record.controller?.signal)
    if (!result.ok) {
      return { ok: false, error: result.error, errorKind: result.errorKind, sessionId: result.sessionId }
    }
    const sessionId = String(result.sessionId ?? '')
    const validated = validateIntent(result.intent, input)
    if (!validated.ok) {
      return { ok: true, sessionId, intent: result.intent }
    }
    const intent = validated.intent
    const assetType = intent.status === 'resolved' ? intent.assetType : null
    const route = assetType !== null && registeredAssetIds.includes(assetType) ? assetType : ''
    const routing = { route, intent: routingIntentOf(intent), intentSessionId: sessionId }
    record.routing = routing
    if (intent.status === 'resolved') {
      if (intent.objects.length !== 1) {
        // More than one real object: the graph must not choose for the employee.
        // Convert the validated decision into a clarification that keeps the
        // actual objects/evidence and asks which exact object id to value.
        const objectIds = intent.objects.map((object) => object.objectId)
        const converted: ValuationIntent = {
          ...intent,
          status: 'needs-clarification',
          questions: [
            `本轮识别到 ${String(objectIds.length)} 个估值对象：${objectIds.join('、')}。`
            + '请选择本轮唯一要估值的对象，并填写其对象标识。',
          ],
        }
        record.routing = { route: '', intent: routingIntentOf(converted), intentSessionId: sessionId }
        return { ok: true, sessionId, intent: converted }
      }
      const objectId = intent.objects[0]?.objectId ?? ''
      if (record.object.objectId === '') {
        if (route !== '' && sessionId !== '') {
          record.object = { ...record.object, objectId }
        }
      } else if (record.object.objectId !== objectId) {
        record.routing = { ...routing, route: '' }
        return { ok: false, errorKind: 'blocked', error: '意图对象与当前已确认对象不一致', sessionId }
      }
    }
    return { ok: true, sessionId, intent: result.intent }
  }

  /** Validate a whole answer against the current open questions; never mutates. */
  const validateAnswers = (
    record: RunRecord,
    answers: Record<string, string>,
  ): { ok: true; patch: Partial<RunRecord> } | { ok: false; error: string } => {
    const patch: Partial<RunRecord> = {}
    const answeredStrings: string[] = []
    const questions = record.clarification?.questions ?? []
    const knownFields = new Set(questions.map((question) => question.field))
    for (const field of Object.keys(answers)) {
      if (!knownFields.has(field)) {
        return { ok: false, error: `这次待决事项没有字段：${field}` }
      }
    }
    for (const question of questions) {
      const raw = answers[question.field]
      const value = typeof raw === 'string' ? raw.trim() : ''
      const required = question.required !== false
      const options = Array.isArray(question.options) ? question.options : []
      const label = question.prompt.trim() === '' ? question.field : question.prompt.trim()
      if (question.control === 'select' || question.control === 'radio') {
        if (value !== '' && !options.some((option) => option.value === value)) {
          return { ok: false, error: `「${label}」只能从给定选项里选择` }
        }
        if (required && value === '') return { ok: false, error: `请补充${label}` }
      } else if (question.control === 'multiselect') {
        if (value === '') {
          if (required) return { ok: false, error: `请补充${label}` }
        } else {
          let parsed: unknown
          try {
            parsed = JSON.parse(value)
          } catch {
            return { ok: false, error: `「${label}」的选项不是有效列表` }
          }
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            return { ok: false, error: `「${label}」的选项不是有效列表` }
          }
          const selected = parsed as string[]
          if (new Set(selected).size !== selected.length) {
            return { ok: false, error: `「${label}」的选项重复` }
          }
          if (selected.some((item) => !options.some((option) => option.value === item))) {
            return { ok: false, error: `「${label}」包含未提供的选项` }
          }
          if (required && selected.length === 0) return { ok: false, error: `请补充${label}` }
        }
      } else if (required && value === ''
        && !['purpose', 'baseDate', 'mode', 'useLabel', 'areaSqm'].includes(question.field)
        && !question.field.startsWith('intent-')) {
        return { ok: false, error: `请补充${label}` }
      }
      if (question.field === 'purpose') {
        if (value === '') return { ok: false, error: '请补充本次评估目的' }
        patch.purpose = value
      } else if (question.field === 'baseDate') {
        if (value === '' || !isRealCalendarDate(value)) return { ok: false, error: '基准日必须是真实存在的 YYYY-MM-DD 日期' }
        patch.baseDate = value
      } else if (question.field === 'mode') {
        if (value !== 'formal' && value !== 'listing-reference') return { ok: false, error: '请确认正式估值或挂牌参考口径' }
        patch.decision = { mode: value, accepted: true }
      } else if (question.field === 'useLabel') {
        if (value === '') return { ok: false, error: '请补充估价对象原始用途' }
        patch.object = { ...(patch.object ?? record.object), useLabel: value }
      } else if (question.field === 'areaSqm') {
        const area = Number(value)
        if (value === '' || !Number.isFinite(area) || area <= 0) return { ok: false, error: '建筑面积必须是正数' }
        patch.object = { ...(patch.object ?? record.object), areaSqm: area }
      } else if (question.field.startsWith('intent-')) {
        if (value === '') return { ok: false, error: '请补充估值对象说明' }
      }
      // Carry the actual question with its answer: a later node (or a fresh intent
      // child) must see what was asked, not just an unlabelled bare value.
      if (value !== '') {
        answeredStrings.push(`${label}\n${value}`)
      }
    }
    if (answeredStrings.length > 0) {
      patch.userInput = [record.userInput, ...answeredStrings].filter((part) => part.trim() !== '').join('\n')
    }
    return { ok: true, patch }
  }

  const resolveEvidence = (
    record: RunRecord,
    outputs: Record<string, unknown>,
  ): { ok: true; samples: Array<{ sourceId: string; unitPrice: number }> } | { ok: false; error: string } => {
    const raw = Array.isArray(outputs.samples) ? outputs.samples : []
    if (raw.length === 0) return { ok: false, error: '证据节点没有给出任何候选样本' }
    const pool = new Map(record.knownSamples.map((sample) => [sample.sourceId, sample.unitPrice]))
    const samples: Array<{ sourceId: string; unitPrice: number }> = []
    const selected = new Set<string>()
    for (const item of raw) {
      const record0 = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
      const sourceId = String(record0.sourceId ?? '')
      if (sourceId === '') return { ok: false, error: '证据节点给出的候选样本缺少来源标识' }
      if (selected.has(sourceId)) {
        return { ok: false, error: `证据节点重复选择了同一来源，不能当作独立样本：${sourceId}` }
      }
      const hostPrice = pool.get(sourceId)
      if (hostPrice === undefined) return { ok: false, error: `候选来源 ${sourceId} 不在本轮 Host 观察到的来源池里` }
      if (record0.unitPrice !== undefined && Number(record0.unitPrice) !== hostPrice) {
        return { ok: false, error: `候选来源 ${sourceId} 申报的价格与 Host 观察值不一致` }
      }
      selected.add(sourceId)
      samples.push({ sourceId, unitPrice: hostPrice })
    }
    return { ok: true, samples }
  }

  const bindRequirements = async (
    record: RunRecord,
    stage: ValuationWorkflowStage,
    outputs: Record<string, unknown>,
  ): Promise<{ ok: boolean; accepted: AcceptedRequirement[]; gaps: string[] }> => {
    const raw = Array.isArray(outputs.requirements) ? outputs.requirements : []
    if (raw.length === 0) return { ok: false, accepted: [], gaps: ['没有给出可核对的采用要求候选'] }
    const bound = await bindKnowledgeRequirements({
      sources: record.knowledgeSources,
      candidates: raw as RequirementCandidate[],
      context: bindContext(record, stage),
    })
    return {
      ok: bound.ok && bound.accepted.length > 0,
      accepted: bound.accepted,
      gaps: bound.gaps.map((gap) => `${gap.kind}: ${gap.message}`),
    }
  }

  /**
   * Acquire the genuine observed case pool once per immutable source identity.
   * The provider is consulted before the evidence inference task; a failed or
   * unusable acquisition blocks the stage and never falls back to legacy knowledge
   * sample metadata.
   */
  const acquireEvidence = async (
    record: RunRecord,
  ): Promise<
    { ok: true; samples: ValuationObservedSample[]; attempts: ValuationEvidenceRetrievalAttempt[] }
    | { ok: false; gaps: string[] }
  > => {
    const port = ports.evidence
    if (port === undefined) {
      return { ok: true, samples: cloneObservedSamples(record.observedSamples), attempts: [] }
    }
    const key = evidencePoolKey(record)
    if (record.evidencePool !== null && record.evidencePool.key === key) {
      return {
        ok: true,
        samples: cloneObservedSamples(record.evidencePool.samples),
        attempts: record.evidencePool.retrievalAttempts.map((attempt) => ({ ...attempt })),
      }
    }
    let result: ValuationEvidenceAcquireResult
    try {
      result = await port.acquire({
        runId: record.runId,
        revision: record.revision,
        object: { ...record.object },
        purpose: record.purpose,
        baseDate: record.baseDate,
        mode: record.decision.mode,
        materials: record.materials.map((material) => ({ ...material })),
        userInput: currentUserInput(record),
        knowledge: knowledgeRefs(record),
        ...(record.plan === null ? {} : { plan: clonePlan(record.plan) }),
        initialInput: cloneInitialInput(record.initialInput),
        ...(record.controller === null ? {} : { signal: record.controller.signal }),
      })
    } catch {
      return { ok: false, gaps: ['证据来源获取失败：提供方没有返回可核对的结果'] }
    }
    if (!result.ok) {
      return {
        ok: false,
        gaps: [...new Set([
          ...(result.gaps ?? []),
          ...(result.error === undefined || result.error === '' ? [] : [result.error]),
        ])],
      }
    }
    const checked = observedSamplesProblem(result.samples)
    if (!checked.ok) return checked
    const attempts = Array.isArray(result.retrievalAttempts)
      ? result.retrievalAttempts.map((attempt) => ({ ...attempt }))
      : []
    record.evidencePool = { key, samples: checked.samples, retrievalAttempts: attempts }
    record.observedSamples = cloneObservedSamples(checked.samples)
    return { ok: true, samples: cloneObservedSamples(checked.samples), attempts }
  }

  /**
   * Run the actual source/template preflight once per current revision and pause on
   * a usable plan until the user accepts that exact revision. The domain validates
   * the returned facts; an unusable plan blocks with the real gaps instead of
   * falling through to acquisition.
   */
  const preparePlan = async (
    record: RunRecord,
    receipt: ValuationWorkflowStageReceipt,
    methodOutput: Record<string, unknown>,
  ): Promise<string> => {
    const port = ports.planning
    if (port === undefined) return 'running'
    if (record.plan !== null && record.plan.revision === record.revision) {
      if (record.plan.accepted) return 'running'
      if (!record.plan.ready) return block(record, receipt, record.plan.gaps)
      receipt.state = 'waiting'
      record.status = 'waiting-user'
      record.outcome = null
      touch(record)
      return 'waiting'
    }
    let result: ValuationPlanningResult
    try {
      result = await port.prepare({
        runId: record.runId,
        revision: record.revision,
        object: { ...record.object },
        purpose: record.purpose,
        baseDate: record.baseDate,
        userInput: currentUserInput(record),
        materials: record.materials.map((material) => ({ ...material })),
        knowledge: knowledgeRefs(record),
        methodOutput: { ...methodOutput },
        promptSupplement: record.nodePrompts['plan'] ?? '',
        initialInput: cloneInitialInput(record.initialInput),
        ...(record.controller === null ? {} : { signal: record.controller.signal }),
      })
    } catch {
      if (record.cancelRequested || record.controller?.signal.aborted === true) {
        receipt.state = 'cancelled'
        record.status = 'cancelled'
        record.outcome = 'cancelled'
        record.errorKind = ''
        record.error = ''
        touch(record)
        return 'cancelled'
      }
      return block(record, receipt, ['计划准备失败：无法完成来源与模板核对'])
    }
    if (result.errorKind === 'stop-unknown') {
      const error = result.error === undefined || result.error === ''
        ? '计划准备子会话停止状态未知'
        : result.error
      record.stopUnknown = { sessionId: String(result.sessionId ?? ''), error }
      receipt.sessionId = String(result.sessionId ?? '')
      receipt.state = 'blocked'
      receipt.gaps = [error]
      receipt.outputs = { ...receipt.outputs, failure: nodeFailure('system', [error]) }
      record.status = 'failed'
      record.outcome = 'failed'
      record.errorKind = 'stop-unknown'
      record.error = error
      touch(record)
      return 'stop-unknown'
    }
    if (record.cancelRequested || record.controller?.signal.aborted === true) {
      receipt.state = 'cancelled'
      record.status = 'cancelled'
      record.outcome = 'cancelled'
      record.errorKind = ''
      record.error = ''
      touch(record)
      return 'cancelled'
    }
    if (!result.ok) {
      if (result.questions !== undefined && result.questions.length > 0) {
        return await clarifyBusinessBlock(record, receipt, result.questions, [...(result.gaps ?? []), result.error ?? '规划存在未决业务问题'])
      }
      const gaps = [...new Set([
        ...(result.gaps ?? []),
        ...(result.error === undefined || result.error === '' ? [] : [result.error]),
      ])]
      return block(record, receipt, gaps, nodeFailure('system', gaps))
    }
    const validated = validatePreparedPlan(result.plan, record.knowledgeSources)
    if (validated.plan === null) {
      return block(record, receipt, validated.gaps.length > 0 ? validated.gaps : ['计划准备没有返回可用方案'])
    }
    const plan: ValuationWorkflowPlan = {
      ...validated.plan,
      digest: buildPlanDigest({
        runId: record.runId,
        revision: record.revision,
        object: { ...record.object },
        purpose: record.purpose,
        baseDate: record.baseDate,
        mode: record.decision.mode,
        plan: validated.plan,
      }),
      ready: validated.ok,
      accepted: false,
      revision: record.revision,
      gaps: validated.gaps,
    }
    record.plan = plan
    if (!validated.ok) return block(record, receipt, validated.gaps)
    if (record.decision.mode === null) {
      record.decision = { mode: plan.valuationMode, accepted: false }
    }
    receipt.state = 'waiting'
    receipt.gaps = []
    record.status = 'waiting-user'
    record.outcome = null
    record.error = ''
    record.errorKind = ''
    touch(record)
    return 'waiting'
  }

  const runStageInner = async (record: RunRecord, stage: ValuationWorkflowStage, state?: WorkflowGraphState): Promise<string> => {
    if (record.cancelRequested) {
      record.status = 'cancelled'
      record.outcome = 'cancelled'
      return 'cancelled'
    }
    const receipt = record.stages[stage]
    // Durable at the node-start boundary: before any knowledge read or child.
    await persistOrThrow(record)

    // Legacy ports read once at elements; a stage-aware port refreshes the actual
    // stage's selection after the user confirms the reference mode.
    const stageAware = ports.knowledge.stageAware === true
    const shouldReadKnowledge = stageAware || (stage === 'elements' && record.knowledgeSources.length === 0)
    if (shouldReadKnowledge) {
      const read = await ports.knowledge.read({
        runId: record.runId,
        revision: record.revision,
        stage,
        objectId: record.object.objectId,
        // `mode` stays the valuation basis only; the market method travels separately.
        mode: record.decision.mode ?? '',
        wikiPaths: [],
        knownSourceDigests: record.knowledgeSources.map((source) => source.digest),
        userInput: currentUserInput(record),
        // Deep copies: the port must never share mutable run-state references.
        materials: record.materials.map((material) => ({ ...material })),
        object: { ...record.object },
        assetType: record.routing?.intent?.assetType ?? null,
        purpose: record.purpose,
        baseDate: record.baseDate,
        promptSupplement: record.nodePrompts[stage] ?? '',
        initialInput: cloneInitialInput(record.initialInput),
      })
      const safeGaps = [...new Set([
        ...(read.gaps ?? []),
        ...(read.error === undefined || read.error === '' ? [] : [read.error]),
      ])]
      const sources = read.ok ? (read.sources ?? []) : []
      if (!read.ok || sources.length === 0) {
        const gaps = [...safeGaps, ...(read.ok ? ['没有可用的已验真知识正文'] : [])]
        return block(record, receipt, gaps, nodeFailure('system', gaps))
      }
      record.knowledgeSources = sources.map((source) => ({
        sourceId: source.sourceId,
        spaceName: source.spaceName,
        path: source.path,
        digest: source.digest,
        body: source.body,
        kind: source.kind,
      }))
      // A later stage read may omit samples; only an explicit sample list replaces
      // the pool the elements stage already observed.
      if (Array.isArray(read.samples)) {
        record.knownSamples = read.samples
          .filter((sample) => sample.sourceId !== '' && Number.isFinite(Number(sample.unitPrice)))
          .map((sample) => ({ sourceId: sample.sourceId, unitPrice: Number(sample.unitPrice) }))
      }
    }

    if (stage === 'evidence' && ports.evidence !== undefined) {
      const acquired = await acquireEvidence(record)
      if (!acquired.ok) return block(record, receipt, acquired.gaps)
      record.observedSamples = cloneObservedSamples(acquired.samples)
      record.knownSamples = acquired.samples.map((sample) => ({
        sourceId: sample.sourceId,
        unitPrice: sample.unitPrice,
      }))
    }

    receipt.attempt += 1
    const attempt = receipt.attempt
    const correlationId = `${record.runId}:${stage}:${String(attempt)}`
    const facts = stageFacts(record, stage, acceptedUpstream(stage, state))
    receipt.state = 'running'
    receipt.outputs = {}
    receipt.inputs = {
      runId: record.runId,
      revision: record.revision,
      stage,
      attempt,
      correlationId,
      promptSupplement: record.nodePrompts[stage] ?? '',
      facts,
      knowledgeRefs: knowledgeReceiptRefs(record),
    }
    touch(record)
    // Awaited durable write at the running boundary, before any child inference.
    await persistOrThrow(record)

    let result
    try {
      result = await ports.inference.infer({
        runId: record.runId,
        revision: record.revision,
        nodeId: stage,
        stage,
        attempt,
        correlationId,
        materials: record.materials.map((material) => ({
          materialId: material.materialId,
          fileName: material.fileName,
          digest: material.digest,
          text: material.text ?? '',
        })),
        // The receipt keeps its own immutable copy; a port that mutates its
        // request projection cannot corrupt the persisted stage receipt.
        facts: clonePlainJson(facts),
        knowledge: knowledgeRefs(record),
        ...(record.controller === null ? {} : { signal: record.controller.signal }),
      })
    } catch (error) {
      return fail(record, receipt, error instanceof Error ? error.message : String(error))
    }

    if (!result.ok && result.errorKind === 'stop-unknown') {
      // A child whose quiescence is unknown outranks a local cancel request: the
      // writer stays occupied and no new work may start until it is reconciled.
      record.stopUnknown = { sessionId: String(result.sessionId ?? ''), error: result.error ?? '停止未确认' }
      // Keep the actual child id on the receipt as well as in the occupancy record.
      receipt.sessionId = String(result.sessionId ?? '')
      receipt.state = 'blocked'
      receipt.gaps = [record.stopUnknown.error]
      receipt.outputs = { failure: nodeFailure('system', [record.stopUnknown.error]) }
      record.status = 'failed'
      record.outcome = 'failed'
      record.errorKind = 'stop-unknown'
      record.error = record.stopUnknown.error
      touch(record)
      return 'stop-unknown'
    }
    if (record.cancelRequested) {
      receipt.state = 'cancelled'
      record.status = 'cancelled'
      record.outcome = 'cancelled'
      touch(record)
      return 'cancelled'
    }
    receipt.sessionId = String(result.sessionId ?? '')
    if (!result.ok) {
      const failure = readNodeFailure(result.failure)
      const gaps = [...(result.gaps ?? []), ...(result.error === undefined ? [] : [result.error])]
      return failure === null ? block(record, receipt, gaps, nodeFailure('system', gaps))
        : failure.kind === 'business' ? block(record, receipt, failure.requirements, failure)
          : fail(record, receipt, failure.reason, failure)
    }
    receipt.outputs = { ...(result.outputs ?? {}) }
    if (receipt.outputs.failure !== undefined && readNodeFailure(receipt.outputs.failure) === null) {
      return fail(record, receipt, '节点返回的失败说明不完整：须有具体原因、未满足要求和恢复动作。')
    }
    const modelFailure = readNodeFailure(receipt.outputs.failure)
    if (modelFailure !== null && modelFailure.kind !== 'business') return fail(record, receipt, modelFailure.reason, modelFailure)
    if (receipt.outputs.questions !== undefined) {
      const waiting = waitForQuestions(record, receipt, receipt.outputs.questions)
      if (waiting !== null) return waiting
    }
    if (modelFailure !== null) return block(record, receipt, modelFailure.requirements, modelFailure)
    const unknown = record.questionnaire.questions.filter((question) => question.nodeId === stage
      && question.applicable && question.required !== false && question.answer?.unknown === true)
    if (unknown.length > 0) return block(record, receipt, unknown.map((question) => `仍无法确认：${question.prompt}`))
    receipt.state = 'passed'
    touch(record)

    if (stage === 'plan' && ports.planning !== undefined) {
      const planStatus = await preparePlan(record, receipt, receipt.outputs)
      if (planStatus !== 'running') return planStatus
    }

    if (stage === 'elements') {
      const bound = bindElementFacts({
        sourceFacts: receipt.outputs.sourceFacts,
        materials: record.materials,
        current: {
          purpose: record.purpose,
          baseDate: record.baseDate,
          useLabel: record.object.useLabel,
          areaSqm: record.object.areaSqm,
        },
      })
      if (!bound.ok) {
        receipt.gaps = [...bound.gaps, ...bound.conflicts]
        if (bound.conflicts.length === 0 && buildClarificationIfNeeded(record)) {
          receipt.state = 'waiting'
          touch(record)
          return 'waiting'
        }
        return block(record, receipt, receipt.gaps)
      }
      if (bound.patch.purpose !== undefined) record.purpose = bound.patch.purpose
      // The planned production workflow keeps an omitted base date omitted even when a
      // material contains a literal historical date: the observation stays in raw
      // sourceFacts but never becomes the requested valuation date.
      if (ports.planning === undefined && bound.patch.baseDate !== undefined) record.baseDate = bound.patch.baseDate
      if (bound.patch.useLabel !== undefined) record.object = { ...record.object, useLabel: bound.patch.useLabel }
      if (bound.patch.areaSqm !== undefined) record.object = { ...record.object, areaSqm: bound.patch.areaSqm }
      const adopted = ports.planning === undefined
        ? bound.adopted
        : bound.adopted.filter((fact) => fact.field !== 'baseDate')
      if (adopted.length > 0) {
        receipt.outputs = { ...receipt.outputs, adoptedFacts: adopted }
      }
      if (buildClarificationIfNeeded(record)) {
        receipt.state = 'waiting'
        touch(record)
        return 'waiting'
      }
    }

    if (stage === 'evidence') {
      const resolved = resolveEvidence(record, receipt.outputs)
      if (!resolved.ok) return block(record, receipt, [resolved.error])
      record.evidenceSamples = resolved.samples
      const bound = await bindRequirements(record, stage, receipt.outputs)
      if (!bound.ok) return block(record, receipt, bound.gaps)
      record.acceptedRequirements = bound.accepted
      const unmet = evaluateAcceptedRequirements(record, bound.accepted)
      if (unmet.length > 0) return block(record, receipt, unmet)
      receipt.outputs = { ...receipt.outputs, acceptedRequirementIds: bound.accepted.map((item) => item.requirementId) }
    }

    if (stage === 'review') {
      const issues = Array.isArray(receipt.outputs.issues) ? receipt.outputs.issues : []
      const unresolved = Array.isArray(receipt.outputs.unresolved) ? receipt.outputs.unresolved : []
      const blocking = issues.filter((item) => item !== null && typeof item === 'object'
        && String((item as Record<string, unknown>).severity) === 'blocking')
      const open = unresolved.filter((item) => String(item).trim() !== '')
      if (blocking.length > 0 || open.length > 0) {
        return block(record, receipt, [
          ...blocking.map((item) => `阻断问题：${String((item as Record<string, unknown>).message ?? '')}`),
          ...open.map((item) => `未解决：${String(item)}`),
        ])
      }
    }

    if (stage === 'calculation') {
      if (record.acceptedRequirements.length === 0) {
        return block(record, receipt, ['没有已采用的适用要求，不能进入计算'])
      }
      if (!isPositiveFinite(record.object.areaSqm)) {
        return block(record, receipt, ['建筑面积尚未确认，不能进入计算'])
      }
      const computed = await ports.calculator.compute({
        runId: record.runId,
        revision: record.revision,
        objectId: record.object.objectId,
        operation: 'listing-reference-mean',
        samples: record.evidenceSamples.map((sample) => ({ ...sample })),
        areaSqm: record.object.areaSqm,
        subject: {
          useLabel: record.object.useLabel,
          purpose: record.purpose,
          baseDate: record.baseDate,
        },
        knowledge: knowledgeRefs(record),
        // The durable Host-observed pool is the source of truth for the fixed builder
        // input, including captures made after approval; never model assertions.
        observations: cloneObservedSamples(record.observedSamples),
        ...(Object.keys(record.stages.evidence.outputs).length === 0
          ? {}
          : { evidenceOutput: clonePlainJson(record.stages.evidence.outputs) }),
        assessment: {
          mode: record.decision.mode,
          objectId: record.object.objectId,
          areaSqm: record.object.areaSqm,
          revision: record.revision,
          retrievalAttempts: record.evidencePool?.retrievalAttempts.map((attempt) => ({ ...attempt })) ?? [],
          ...(record.plan === null ? {} : { plan: clonePlan(record.plan) }),
        },
        ...(record.controller === null ? {} : { signal: record.controller.signal }),
      })
      if (!computed.ok || !isPositiveFinite(computed.unitPrice) || !isPositiveFinite(computed.totalPrice)) {
        return fail(record, receipt, computed.error ?? '计算器没有返回有效金额')
      }
      record.calculation = { unitPrice: computed.unitPrice, totalPrice: computed.totalPrice }
      receipt.outputs = {
        ...receipt.outputs,
        unitPrice: record.calculation.unitPrice,
        totalPrice: record.calculation.totalPrice,
      }
    }

    if (stage === 'delivery') {
      if (!isPositiveFinite(record.object.areaSqm) || record.calculation === null) {
        return block(record, receipt, ['计算成果尚未形成，不能进入交付'])
      }
      const artifacts = [...LISTING_REFERENCE_ARTIFACTS]
      const verified = await ports.verification.verify({
        runId: record.runId,
        revision: record.revision,
        objectId: record.object.objectId,
        artifacts,
        ...(record.controller === null ? {} : { signal: record.controller.signal }),
      })
      if (!verified.ok) return fail(record, receipt, verified.error ?? '产物验收未通过')
      receipt.outputs = { ...receipt.outputs, verified: verified.verified ?? artifacts }
    }
    return 'running'
  }

  /** Persist the accepted node image after the stage settles and before downstream work. */
  const runStage = async (
    record: RunRecord,
    stage: ValuationWorkflowStage,
    state?: WorkflowGraphState,
  ): Promise<string> => {
    const status = await runStageInner(record, stage, state)
    await persistOrThrow(record)
    return status
  }

  const finalize = (record: RunRecord): void => {
    if (record.status === 'running'
      && isPositiveFinite(record.object.areaSqm)
      && record.calculation !== null
      && record.evidenceSamples.length > 0) {
      record.status = 'completed'
      record.outcome = 'partial'
      record.delivery = {
        kind: 'listing-reference',
        artifacts: [...LISTING_REFERENCE_ARTIFACTS],
        referenceDelivered: true,
        formalComplete: false,
      }
      record.result = {
        objectId: record.object.objectId,
        useLabel: record.object.useLabel,
        areaSqm: record.object.areaSqm,
        unitPrice: record.calculation.unitPrice,
        totalPrice: record.calculation.totalPrice,
        currency: 'CNY',
        sources: record.evidenceSamples.map((sample) => sample.sourceId),
        generatedAt: new Date().toISOString(),
      }
    }
    if (record.status === 'completed') {
      const existing = record.revisions.find((item) => item.revision === record.revision)
      const recordRevision: ValuationWorkflowRevisionRecord = {
        revision: record.revision,
        status: record.status,
        outcome: record.outcome,
        result: record.result === null ? null : { ...record.result, sources: [...record.result.sources] },
        reason: existing?.reason ?? '',
        source: existing?.source ?? '',
        supersededNodeIds: existing?.supersededNodeIds ?? [],
        ...(existing?.changes === undefined
          ? {}
          : {
            changes: existing.changes.map((change) => ({
              nodeId: change.nodeId,
              field: change.field,
              before: change.before,
              after: change.after,
              sourceKind: change.sourceKind,
              source: change.source,
              reason: change.reason,
            })),
          }),
        stages: copyStages(record),
        ...(record.plan === null ? {} : { plan: clonePlan(record.plan) }),
        updatedAt: record.updatedAt,
      }
      const index = record.revisions.findIndex((item) => item.revision === record.revision)
      if (index >= 0) record.revisions[index] = recordRevision
      else record.revisions.push(recordRevision)
    }
    touch(record)
  }

  const applyRoutedOutcome = (record: RunRecord, outcome: WorkflowGraphState): void => {
    const route = typeof outcome.route === 'string' ? outcome.route : ''
    const intentSessionId = typeof outcome.intentSessionId === 'string' ? outcome.intentSessionId : ''
    record.routing = { route, intent: routingIntentOf(outcome.intent), intentSessionId }
    const currentStatus = record.status
    const currentErrorKind = record.errorKind
    const currentError = record.error
    const currentStopUnknown = record.stopUnknown
    const outcomeErrorKind = typeof outcome.errorKind === 'string' ? outcome.errorKind : ''
    const outcomeError = typeof outcome.error === 'string' ? outcome.error : ''
    if (currentStopUnknown !== null || outcomeErrorKind === 'stop-unknown') {
      const stop = currentStopUnknown ?? {
        sessionId: intentSessionId,
        error: outcomeError || '意图子会话停止状态未知',
      }
      record.stopUnknown = stop
      record.status = 'failed'
      record.outcome = 'failed'
      record.errorKind = 'stop-unknown'
      record.error = stop.error
      return
    }
    if (currentStatus === 'cancelled' || outcome.status === 'cancelled') {
      record.status = 'cancelled'
      record.outcome = 'cancelled'
      if (currentStatus !== 'cancelled') {
        record.errorKind = 'cancelled'
        record.error = outcomeError || '运行已取消'
      }
      return
    }
    if (currentStatus === 'failed' || outcome.status === 'failed') {
      record.status = 'failed'
      record.outcome = 'failed'
      record.errorKind = currentErrorKind === 'stop-unknown' ? 'stop-unknown' : (currentErrorKind || 'failed')
      record.error = currentError || outcomeError || '运行失败'
      return
    }
    if (currentStatus === 'blocked' || outcome.status === 'blocked') {
      record.status = 'blocked'
      record.outcome = 'blocked'
      record.errorKind = currentErrorKind || 'blocked'
      record.error = currentError || outcomeError || '意图或流程被阻断'
      return
    }
    if (currentStatus === 'waiting-user' || outcome.status === 'waiting') {
      record.status = 'waiting-user'
      record.outcome = null
      if (record.clarification === null) buildIntentClarification(record, outcome.intent)
      if (currentError === '') record.error = outcomeError
      return
    }
    finalize(record)
  }

  const runRoutedDrive = async (record: RunRecord, entry: ValuationWorkflowStage): Promise<void> => {
    record.status = 'running'
    record.outcome = null
    record.error = ''
    record.errorKind = ''
    record.cancelRequested = false
    record.controller = new AbortController()
    record.active = true
    touch(record)
    try {
      // Persist at the drive boundary before the intent child or any stage child.
      await persistOrThrow(record)
      const registry = createValuationGraphRegistry()
      registerRealestateGraph(registry, async (stage: ValuationWorkflowStage, state: WorkflowGraphState) => {
        return stageRunResult(record, stage, await runStage(record, stage, state))
      })
      const valuation = compileValuationGraph({
        registry,
        inferIntent: (input: WorkflowInput, ids: readonly string[]) => inferRoutedIntent(record, input, ids),
      }) as unknown as ValuationAssetGraph
      const root = compileWorkflowGraph(
        checkpointer === undefined ? { valuation } : { valuation, checkpointer },
      )
      const stateInput: Record<string, unknown> = {
        input: {
          text: currentUserInput(record),
          materials: record.materials.map((material) => ({ ...material, text: material.text ?? '' })),
          initialInput: cloneInitialInput(record.initialInput),
        },
        entry,
        stage: entry,
        status: 'running',
        // Every stage key is present (non-retained as `{}`) so the merging outputs
        // reducer cannot replay stale checkpoint values over corrected inputs.
        outputs: stateOutputsFor(record, entry),
        intent: null,
        intentSessionId: '',
        route: '',
        error: '',
        errorKind: '',
      }
      const adopted = record.routing
      if (adopted !== null && adopted.intent !== null && adopted.intent.status === 'resolved'
        && adopted.intentSessionId !== '') {
        stateInput.intent = adopted.intent
        stateInput.intentSessionId = adopted.intentSessionId
        stateInput.route = adopted.route
      }
      const outcome = await root.invoke(stateInput as unknown as WorkflowGraphUpdate, {
        configurable: { thread_id: record.runId },
        metadata: { businessRevision: record.revision },
      }) as WorkflowGraphState
      applyRoutedOutcome(record, outcome)
    } catch (error) {
      if (error instanceof DurableStoreFailure || record.storeFailed) {
        markStoreFailure(record)
      } else {
        record.status = 'failed'
        record.outcome = 'failed'
        record.errorKind = 'infrastructure'
        record.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      record.active = false
      record.controller = null
      touch(record)
      if (!(await persist(record))) markStoreFailure(record)
    }
  }

  const runDrive = async (record: RunRecord, entry: ValuationWorkflowStage): Promise<void> => {
    record.status = 'running'
    record.outcome = null
    record.error = ''
    record.errorKind = ''
    record.cancelRequested = false
    record.controller = new AbortController()
    record.active = true
    touch(record)
    try {
      await persistOrThrow(record)
      const compiled = compileRealestateGraph(async (stage: ValuationWorkflowStage, state: WorkflowGraphState) => {
        return stageRunResult(record, stage, await runStage(record, stage, state))
      })
      await compiled.invoke({
        entry,
        stage: entry,
        status: 'running',
        outputs: stateOutputsFor(record, entry),
      })
      finalize(record)
    } catch (error) {
      if (error instanceof DurableStoreFailure || record.storeFailed) {
        markStoreFailure(record)
      } else {
        record.status = 'failed'
        record.outcome = 'failed'
        record.errorKind = 'infrastructure'
        record.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      record.active = false
      record.controller = null
      touch(record)
      if (!(await persist(record))) markStoreFailure(record)
    }
  }

  /** Inspect materials and common knowledge before asking for possibly known facts. */
  const prepareElements = async (record: RunRecord): Promise<void> => {
    record.controller = new AbortController()
    try {
      await runStage(record, 'elements')
    } catch (error) {
      if (error instanceof DurableStoreFailure || record.storeFailed) markStoreFailure(record)
      else throw error
    } finally {
      record.controller = null
      record.active = false
      touch(record)
      if (!(await persist(record))) markStoreFailure(record)
    }
  }

  const start = async (input: ValuationWorkflowStartInput): Promise<ValuationWorkflowOperationOutcome> => {
    const runId = String(input.runId ?? '').trim()
    if (runId === '') return outcomeOf(newRecord(input), 'invalid-input', '缺少运行标识')
    const existing = runs.get(runId)
    if (existing !== undefined) return outcomeOf(existing, 'duplicate', '这一轮已经在运行或已存在')

    // Blank is a valid choice; a provided date must still be a real calendar day.
    const providedBaseDate = input.baseDate === null || input.baseDate === undefined
      ? ''
      : String(input.baseDate)
    if (providedBaseDate !== '' && !isRealCalendarDate(providedBaseDate)) {
      return outcomeOf(newRecord(input), 'invalid-input', '基准日必须是真实存在的 YYYY-MM-DD 日期')
    }

    const record = newRecord(input)
    runs.set(runId, record)

    if (record.decision.mode !== null && record.decision.mode !== 'listing-reference') {
      record.status = 'blocked'
      record.outcome = 'blocked'
      record.errorKind = 'blocked'
      record.error = '首个切片只支持挂牌参考口径；正式估值路径尚未接入'
      return await finish(record)
    }
    if (hasIntentPort) {
      await runRoutedDrive(record, 'elements')
      return await finish(record)
    }
    // Specialized facade without an intent port: inspect elements before rights.
    await prepareElements(record)
    if (record.status !== 'running') return await finish(record)
    if (buildClarificationIfNeeded(record)) return await finish(record)
    await runDrive(record, 'rights')
    return await finish(record)
  }

  const get = async (runId: string): Promise<ValuationWorkflowSnapshot | null> => {
    const record = runs.get(String(runId ?? '').trim())
    return record === undefined ? null : snapshotOf(record)
  }

  const saveDraft = async (input: ValuationQuestionEdit & { runId: string }): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(input.runId)
    if (record === undefined) return outcomeOf(newRecord({ runId: input.runId,
      object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    if (input.expectedRevision !== record.revision) return outcomeOf(record, 'stale-revision', '节点版本已变化，请保留草稿并重新核对')
    const saved = saveQuestionDraft(record.questionnaire, input)
    if (!saved.ok) return outcomeOf(record, 'stale-revision', saved.error)
    record.questionnaire = saved.state
    touch(record)
    return await finish(record)
  }

  const submitQuestions = async (input: ValuationQuestionSubmit & { runId: string }): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(input.runId)
    if (record === undefined) return outcomeOf(newRecord({ runId: input.runId,
      object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    if (record.active) return outcomeOf(record, 'duplicate', '节点仍在执行；草稿可以保存，请等待结束或确认停止后再提交')
    if (record.stopUnknown !== null) return outcomeOf(record, 'stop-unknown', '子会话停止尚未确认，暂不能提交新的回答')
    if (record.questionnaire.submissions.some((submission) => submission.submissionId === input.submissionId)) {
      const duplicate = submitQuestionAnswers(record.questionnaire, input)
      return duplicate.ok ? outcomeOf(record) : outcomeOf(record, 'invalid-input', duplicate.error)
    }
    if (input.expectedRevision !== record.revision) return outcomeOf(record, 'stale-revision', '回答基于的节点版本已经变化，请保留草稿并重新核对')
    if (input.nodeId !== 'intent' && !(VALUATION_WORKFLOW_STAGES as readonly string[]).includes(input.nodeId)) {
      return outcomeOf(record, 'invalid-input', '问题不属于当前流程节点')
    }
    const submitted = submitQuestionAnswers(record.questionnaire, input)
    if (!submitted.ok) return outcomeOf(record, input.expectedQuestionVersion !== record.questionnaire.version
      ? 'stale-revision' : 'invalid-input', submitted.error)
    record.questionnaire = submitted.state
    touch(record)
    if (!(await persist(record))) {
      markStoreFailure(record)
      return outcomeOf(record)
    }
    const applicable = record.questionnaire.questions.filter((question) => question.nodeId === input.nodeId && question.applicable)
    const conflicts: string[] = []
    const changes: Array<{ field: string; value: unknown }> = []
    for (const question of applicable) {
      if (FIELD_OWNER[question.field] === undefined || question.answer === null || question.answer.unknown) continue
      const proposed = question.field === 'areaSqm' ? Number(question.answer.value) : question.answer.value
      const adopted = Object.values(record.stages).flatMap((receipt) => Array.isArray(receipt.outputs.adoptedFacts)
        ? receipt.outputs.adoptedFacts as Array<{ field?: string; value?: unknown }> : [])
      if (adopted.some((fact) => fact.field === question.field && fact.value !== proposed)) {
        conflicts.push(`用户回答与已核验材料存在冲突：${question.prompt}；回答已保存，须补充依据后重新核验`)
      } else if (String(proposed) !== String(question.field === 'areaSqm' ? record.object.areaSqm
        : question.field === 'useLabel' ? record.object.useLabel : question.field === 'mode' ? record.decision.mode
          : question.field === 'purpose' ? record.purpose : record.baseDate)) {
        changes.push({ field: question.field, value: proposed })
      }
    }
    if (conflicts.length > 0) {
      const stage = input.nodeId === 'intent' ? 'elements' : input.nodeId as ValuationWorkflowStage
      record.revisions.push({ revision: record.revision, status: record.status, outcome: record.outcome,
        result: record.result === null ? null : clonePlainJson(record.result), stages: copyStages(record),
        ...(record.plan === null ? {} : { plan: clonePlan(record.plan) }), reason: '用户更正与材料冲突，旧结果待重新验证',
        source: '已保存的节点问答', supersededNodeIds: VALUATION_WORKFLOW_STAGES.slice(VALUATION_WORKFLOW_STAGES.indexOf(stage)) })
      record.revision += 1
      for (const downstream of VALUATION_WORKFLOW_STAGES.slice(VALUATION_WORKFLOW_STAGES.indexOf(stage))) {
        record.stages[downstream] = { ...record.stages[downstream], state: 'pending', sessionId: '', outputs: {}, gaps: [] }
      }
      record.plan = null
      record.result = null
      record.delivery = null
      record.calculation = null
      block(record, record.stages[stage], conflicts)
      return await finish(record)
    }
    if (!submitted.changed && record.status === 'blocked') {
      return await finish(record, 'blocked', '当前信息仍无法解决；已保存全部回答，请更正答案、补充资料或修复故障后重试')
    }
    if (input.nodeId === 'intent') {
      if (!hasIntentPort) return await finish(record, 'capability-gap', '当前没有意图路由能力，回答已保存')
      record.clarification = null
      record.routing = null
      record.revision += 1
      await runRoutedDrive(record, 'elements')
      return await finish(record)
    }
    changes.push({ field: 'promptSupplement', value: submittedQuestionContext(record, input.nodeId) || '已确认本节点当前问答' })
    return await revise({ runId: record.runId, nodeId: input.nodeId,
      submissionId: `${input.submissionId}:question-execution`, expectedRevision: record.revision,
      reason: '员工提交或更正节点问答', source: '已保存的节点问答', changes })
  }

  const answer = async (input: ValuationWorkflowAnswerInput): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(String(input.runId ?? '').trim())
    if (record === undefined) {
      return outcomeOf(newRecord({ runId: String(input.runId ?? ''), object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    }
    if (record.usedSubmissions.has(input.submissionId) || record.usedClarifications.has(input.clarificationId)
      || record.clarification === null || record.clarification.clarificationId !== input.clarificationId) {
      return outcomeOf(record, 'duplicate', '这次待决事项已经处理过')
    }
    if (record.stopUnknown !== null) {
      return outcomeOf(record, 'stop-unknown', `子会话静止状态未知（${record.stopUnknown.sessionId}）：不能接受新的推进`)
    }
    if (input.expectedRevision !== record.revision) {
      return outcomeOf(record, 'stale-revision', '回答基于的版本已经过期')
    }
    const validated = validateAnswers(record, input.answers ?? {})
    if (!validated.ok) return outcomeOf(record, 'invalid-input', validated.error)

    const answeredQuestions = record.clarification?.questions ?? []
    const answeredIntent = answeredQuestions.some((question) => question.field.startsWith('intent-'))
    let questionnaire = record.questionnaire
    const answeredFields = new Set(answeredQuestions.map((question) => question.field))
    const owners = new Set(questionnaire.questions.filter((question) => question.applicable && answeredFields.has(question.field))
      .map((question) => question.nodeId))
    for (const nodeId of owners) {
      const answers: ValuationQuestionSubmit['answers'] = {}
      for (const question of questionnaire.questions.filter((question) => question.nodeId === nodeId && question.applicable)) {
        const value = input.answers[question.field] ?? question.answer?.value
        if (value !== undefined) answers[question.questionId] = { value }
      }
      const submitted = submitQuestionAnswers(questionnaire, { nodeId, answers, expectedRevision: record.revision,
        expectedQuestionVersion: questionnaire.version, supplement: '', noteEdits: {}, submissionId: `${input.submissionId}:legacy:${nodeId}` })
      if (!submitted.ok) return outcomeOf(record, 'invalid-input', submitted.error)
      questionnaire = submitted.state
    }
    record.questionnaire = questionnaire
    if (validated.patch.purpose !== undefined) record.purpose = validated.patch.purpose
    if (validated.patch.baseDate !== undefined) record.baseDate = validated.patch.baseDate
    if (validated.patch.decision !== undefined) record.decision = validated.patch.decision
    if (validated.patch.object !== undefined) record.object = validated.patch.object
    if (validated.patch.userInput !== undefined) record.userInput = validated.patch.userInput
    record.usedSubmissions.add(input.submissionId)
    record.usedClarifications.add(input.clarificationId)
    record.clarification = null

    if (record.decision.mode !== null && record.decision.mode !== 'listing-reference') {
      record.status = 'blocked'
      record.outcome = 'blocked'
      record.errorKind = 'blocked'
      record.error = '首个切片只支持挂牌参考口径'
      return await finish(record)
    }
    if (answeredIntent && hasIntentPort) {
      record.routing = null
      await runRoutedDrive(record, 'elements')
      return await finish(record)
    }
    // A genuine waiting elements clarification is completed from the employee's own
    // answers: the original waiting receipt becomes passed, only the binding gaps those
    // answers resolved are cleared, and every model candidate the employee did not
    // answer is revalidated instead of being waived.
    const elementAnswerFields = ['purpose', 'baseDate', 'mode', 'useLabel', 'areaSqm']
    const elementQuestions = answeredQuestions.filter((question) => elementAnswerFields.includes(question.field))
    if (elementQuestions.length > 0 && record.stages.elements.state === 'waiting') {
      const receipt = record.stages.elements
      const supplied = new Set(elementQuestions.map((question) => question.field))
      const hadSourceFacts = Array.isArray(receipt.outputs.sourceFacts)
      const proposals = hadSourceFacts ? receipt.outputs.sourceFacts as unknown[] : []
      const superseded: unknown[] = []
      const remaining: unknown[] = []
      for (const proposal of proposals) {
        const field = proposal !== null && typeof proposal === 'object' && !Array.isArray(proposal)
          ? (proposal as Record<string, unknown>).field
          : undefined
        if (typeof field === 'string' && supplied.has(field)) superseded.push(proposal)
        else remaining.push(proposal)
      }
      const revalidated = bindElementFacts({
        sourceFacts: remaining,
        materials: record.materials,
        current: {
          purpose: record.purpose,
          baseDate: record.baseDate,
          useLabel: record.object.useLabel,
          areaSqm: record.object.areaSqm,
        },
      })
      if (!revalidated.ok) {
        // A partial answer never waives a real remaining source error.
        block(record, receipt, [...revalidated.gaps, ...revalidated.conflicts])
        return await finish(record)
      }
      if (revalidated.patch.purpose !== undefined) record.purpose = revalidated.patch.purpose
      if (ports.planning === undefined && revalidated.patch.baseDate !== undefined) record.baseDate = revalidated.patch.baseDate
      if (revalidated.patch.useLabel !== undefined) record.object = { ...record.object, useLabel: revalidated.patch.useLabel }
      if (revalidated.patch.areaSqm !== undefined) record.object = { ...record.object, areaSqm: revalidated.patch.areaSqm }
      const confirmedValueOf = (field: string): string | number | null => {
        if (field === 'purpose') return record.purpose
        if (field === 'baseDate') return record.baseDate
        if (field === 'mode') return record.decision.mode
        if (field === 'useLabel') return record.object.useLabel
        if (field === 'areaSqm') return record.object.areaSqm
        return null
      }
      const confirmedAnswers = elementQuestions.map((question) => ({
        field: question.field,
        question: question.prompt,
        answer: String(input.answers?.[question.field] ?? '').trim(),
        value: confirmedValueOf(question.field),
        clarificationId: input.clarificationId,
        submissionId: input.submissionId,
        source: 'user-confirmation' as const,
      }))
      const adopted = [
        ...(Array.isArray(receipt.outputs.adoptedFacts) ? receipt.outputs.adoptedFacts : []),
        ...revalidated.adopted,
      ]
      receipt.state = 'passed'
      receipt.gaps = []
      // Replaced model proposals stay audit-only; they are never shown as material-adopted.
      receipt.outputs = {
        ...receipt.outputs,
        ...(hadSourceFacts ? { sourceFacts: remaining } : {}),
        ...(superseded.length === 0 ? {} : { supersededSourceFacts: superseded }),
        confirmedAnswers,
        ...(adopted.length === 0 ? {} : { adoptedFacts: adopted }),
      }
      touch(record)
    }
    if (buildClarificationIfNeeded(record)) return await finish(record)
    if (hasIntentPort) await runRoutedDrive(record, 'rights')
    else await runDrive(record, 'rights')
    return await finish(record)
  }

  const revise = async (input: ValuationWorkflowRevisionInput): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(String(input.runId ?? '').trim())
    if (record === undefined) {
      return outcomeOf(newRecord({ runId: String(input.runId ?? ''), object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    }
    if (record.usedSubmissions.has(input.submissionId)) return outcomeOf(record, 'duplicate', '这次修订已经提交过')
    if (record.stopUnknown !== null) {
      return outcomeOf(record, 'stop-unknown', `子会话静止状态未知（${record.stopUnknown.sessionId}）：不能启动新的修订写入`)
    }
    if (input.expectedRevision !== record.revision) return outcomeOf(record, 'stale-revision', '修订基于的版本已经过期')
    const reason = String(input.reason ?? '').trim()
    const source = String(input.source ?? '').trim()
    if (reason === '' || source === '') {
      return outcomeOf(record, 'invalid-input', '修订必须说明理由与来源')
    }
    const changes = Array.isArray(input.changes) ? input.changes : []
    if (changes.length === 0) return outcomeOf(record, 'invalid-input', '修订没有要更改的字段')
    if (record.active) return outcomeOf(record, 'duplicate', '当前仍在执行，暂不能接受新修订')

    // A correction is only meaningful against one of the seven real business nodes.
    const nodeId = String(input.nodeId ?? '')
    const nodeIndex = (VALUATION_WORKFLOW_STAGES as readonly string[]).indexOf(nodeId)
    if (nodeIndex < 0) {
      return outcomeOf(record, 'invalid-input', `未知节点：${nodeId || '未提供'}`)
    }

    // Validate the whole patch before touching run state: reason, source,
    // submission, revision and every field must pass together.
    const seen = new Set<string>()
    const patch: {
      areaSqm?: number
      useLabel?: string
      purpose?: string
      baseDate?: string
      mode?: ValuationWorkflowMode
    } = {}
    const prompts: Record<string, string> = {}
    const recorded: ValuationWorkflowRevisionChange[] = []
    let entryIndex = nodeIndex
    for (const change of changes) {
      const field = String(change.field ?? '')
      if (seen.has(field)) return outcomeOf(record, 'invalid-input', `同一字段在一次修订里出现了多次：${field}`)
      seen.add(field)
      if (field === 'promptSupplement') {
        const supplement = String(change.value ?? '').trim()
        if (supplement === '') return outcomeOf(record, 'invalid-input', '节点补充说明不能为空')
        if (supplement.length > SUPPLEMENTAL_PROMPT_MAX_LENGTH) {
          return outcomeOf(record, 'invalid-input', `节点补充说明超过 ${String(SUPPLEMENTAL_PROMPT_MAX_LENGTH)} 字符`)
        }
        prompts[nodeId] = supplement
        recorded.push({
          nodeId: nodeId as ValuationWorkflowStage,
          field,
          before: record.nodePrompts[nodeId as ValuationWorkflowStage] ?? '',
          after: supplement,
          sourceKind: 'user',
          source,
          reason,
        })
        continue
      }
      const owner = FIELD_OWNER[field]
      if (owner === undefined) return outcomeOf(record, 'invalid-input', `字段不可修订或不属于本节点：${field}`)
      if (field === 'areaSqm') {
        const area = Number(change.value)
        if (!Number.isFinite(area) || area <= 0) return outcomeOf(record, 'invalid-input', '面积必须是正数')
        patch.areaSqm = area
        recorded.push({
          nodeId: owner, field, before: record.object.areaSqm, after: area, sourceKind: 'user', source, reason,
        })
      } else if (field === 'useLabel') {
        const label = String(change.value ?? '').trim()
        if (label === '') return outcomeOf(record, 'invalid-input', '原始用途不能为空')
        patch.useLabel = label
        recorded.push({
          nodeId: owner, field, before: record.object.useLabel, after: label, sourceKind: 'user', source, reason,
        })
      } else if (field === 'purpose') {
        const next = String(change.value ?? '').trim()
        if (next === '') return outcomeOf(record, 'invalid-input', '评估目的不能为空')
        if (next.length > PURPOSE_MAX_LENGTH) {
          return outcomeOf(record, 'invalid-input', `评估目的超过 ${String(PURPOSE_MAX_LENGTH)} 字符`)
        }
        patch.purpose = next
        recorded.push({
          nodeId: owner, field, before: record.purpose, after: next, sourceKind: 'user', source, reason,
        })
      } else if (field === 'baseDate') {
        const next = String(change.value ?? '').trim()
        if (next !== '' && !isRealCalendarDate(next)) {
          return outcomeOf(record, 'invalid-input', '基准日必须是真实存在的 YYYY-MM-DD 日期')
        }
        patch.baseDate = next
        recorded.push({
          nodeId: owner, field, before: record.baseDate, after: next, sourceKind: 'user', source, reason,
        })
      } else if (field === 'mode') {
        const next = String(change.value ?? '').trim()
        if (next !== 'formal' && next !== 'listing-reference') {
          return outcomeOf(record, 'invalid-input', '评估口径只接受 formal 或 listing-reference')
        }
        patch.mode = next
        recorded.push({
          nodeId: owner, field, before: record.decision.mode, after: next, sourceKind: 'user', source, reason,
        })
      }
      const ownerIndex = VALUATION_WORKFLOW_STAGES.indexOf(owner)
      if (ownerIndex < entryIndex) entryIndex = ownerIndex
    }
    const entry = VALUATION_WORKFLOW_STAGES[entryIndex] as ValuationWorkflowStage

    if (patch.areaSqm !== undefined) record.object = { ...record.object, areaSqm: patch.areaSqm }
    if (patch.useLabel !== undefined) record.object = { ...record.object, useLabel: patch.useLabel }
    if (patch.purpose !== undefined) record.purpose = patch.purpose
    if (patch.baseDate !== undefined) record.baseDate = patch.baseDate
    if (patch.mode !== undefined) record.decision = { mode: patch.mode, accepted: true }
    if (Object.keys(prompts).length > 0) {
      const nextPrompts = { ...record.nodePrompts }
      for (const [key, value] of Object.entries(prompts)) {
        if ((VALUATION_WORKFLOW_STAGES as readonly string[]).includes(key)) {
          nextPrompts[key as ValuationWorkflowStage] = value
        }
      }
      record.nodePrompts = nextPrompts
    }

    // A correction at or upstream of plan invalidates the accepted plan: keep the
    // prior receipt in revision history, then require a fresh preflight and approval.
    if (record.plan !== null && entryIndex <= VALUATION_WORKFLOW_STAGES.indexOf('plan')) {
      const previousPlan = clonePlan(record.plan)
      const history = record.revisions.find((item) => item.revision === record.revision)
      if (history === undefined) {
        record.revisions.push({
          revision: record.revision,
          status: record.status,
          outcome: record.outcome,
          result: record.result === null ? null : { ...record.result, sources: [...record.result.sources] },
          reason: '',
          source: '',
          supersededNodeIds: [],
          stages: copyStages(record),
          plan: previousPlan,
          updatedAt: record.updatedAt,
        })
      } else {
        history.plan = previousPlan
      }
      record.plan = null
    }

    record.usedSubmissions.add(input.submissionId)
    record.revision += 1
    const superseded = VALUATION_WORKFLOW_STAGES.slice(entryIndex)
    record.revisions.push({
      revision: record.revision,
      status: 'running',
      outcome: null,
      result: null,
      reason,
      source,
      supersededNodeIds: [...superseded],
      changes: recorded,
    })
    for (const stage of superseded) {
      record.stages[stage] = { ...record.stages[stage], state: 'pending', sessionId: '', outputs: {}, gaps: [] }
    }
    record.result = null
    record.delivery = null
    // A valid rerun supersedes any stale clarification or cancelled marker.
    record.clarification = null
    // Invalidate only state whose producer is at or after the entry node; a
    // deeper correction reuses the already computed upstream values.
    if (entryIndex <= VALUATION_WORKFLOW_STAGES.indexOf('calculation')) record.calculation = null
    if (entryIndex <= VALUATION_WORKFLOW_STAGES.indexOf('evidence')) {
      record.evidenceSamples = []
      record.acceptedRequirements = []
    }
    if (hasIntentPort) await runRoutedDrive(record, entry)
    else await runDrive(record, entry)
    return await finish(record)
  }

  const approvePlan = async (
    input: ValuationWorkflowApprovePlanInput,
  ): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(String(input.runId ?? '').trim())
    if (record === undefined) {
      return outcomeOf(newRecord({ runId: String(input.runId ?? ''), object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    }
    if (record.usedSubmissions.has(input.submissionId)) {
      return outcomeOf(record, 'duplicate', '这次方案确认已经提交过')
    }
    if (record.stopUnknown !== null) {
      return outcomeOf(record, 'stop-unknown', `子会话静止状态未知（${record.stopUnknown.sessionId}）：不能接受新的推进`)
    }
    if (record.cancelRequested || record.status === 'cancelled') {
      return outcomeOf(record, 'cancelled', '运行已取消，不能确认方案')
    }
    if (input.expectedRevision !== record.revision) {
      return outcomeOf(record, 'stale-revision', '方案确认基于的版本已经过期')
    }
    if (record.active) return outcomeOf(record, 'duplicate', '当前仍在执行，暂不能确认方案')
    const plan = record.plan
    if (plan === null || !plan.ready) {
      return outcomeOf(record, 'invalid-input', '当前版本没有可确认的完整方案')
    }
    if (plan.revision !== record.revision) {
      return outcomeOf(record, 'stale-revision', '方案回执不属于当前版本')
    }
    if (String(input.planDigest ?? '') !== plan.digest) {
      return outcomeOf(record, 'stale-revision', '方案摘要与当前版本不一致')
    }
    if (plan.accepted) return outcomeOf(record, 'duplicate', '这一版方案已经确认过')

    record.usedSubmissions.add(input.submissionId)
    plan.accepted = true
    record.decision = record.decision.mode === null
      ? { mode: plan.valuationMode, accepted: true }
      : { ...record.decision, accepted: true }

    const planReceipt = record.stages.plan
    planReceipt.state = 'passed'
    planReceipt.gaps = []
    record.status = 'running'
    record.outcome = null
    record.error = ''
    record.errorKind = ''
    if (hasIntentPort) await runRoutedDrive(record, 'evidence')
    else await runDrive(record, 'evidence')
    return await finish(record)
  }

  const cancel = async (input: ValuationWorkflowCancelInput): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(String(input.runId ?? '').trim())
    if (record === undefined) {
      return outcomeOf(newRecord({ runId: String(input.runId ?? ''), object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    }
    // An unknown child stop outranks cancellation: occupancy is not released.
    if (record.stopUnknown !== null) {
      return outcomeOf(record, 'stop-unknown', `子会话静止状态未知（${record.stopUnknown.sessionId}）：不能释放占用`)
    }
    if (record.usedSubmissions.has(input.submissionId)) return outcomeOf(record, 'duplicate', '这次取消已经提交过')
    if (record.status === 'completed' || record.delivery?.referenceDelivered === true) {
      return outcomeOf(record, 'invalid-input', '已经交付的这一轮不能再取消')
    }
    record.usedSubmissions.add(input.submissionId)
    record.cancelRequested = true
    record.status = 'cancelled'
    record.outcome = 'cancelled'
    record.errorKind = ''
    record.error = ''
    record.controller?.abort()
    touch(record)
    return await finish(record)
  }

  const retryIntent = async (input: ValuationWorkflowRetryIntentInput): Promise<ValuationWorkflowOperationOutcome> => {
    const record = runs.get(String(input.runId ?? '').trim())
    if (record === undefined) {
      return outcomeOf(newRecord({ runId: String(input.runId ?? ''), object: { objectId: '', useLabel: '', areaSqm: null } }), 'unknown-run', '没有这一轮运行')
    }
    const submissionId = String(input.submissionId ?? '').trim()
    if (submissionId === '') return outcomeOf(record, 'invalid-input', '缺少提交标识')
    if (record.usedSubmissions.has(submissionId)) return outcomeOf(record, 'duplicate', '这次意图重试已经提交过')
    if (record.stopUnknown !== null) {
      return outcomeOf(record, 'stop-unknown', `子会话静止状态未知（${record.stopUnknown.sessionId}）：不能接受新的推进`)
    }
    if (input.expectedRevision !== record.revision) {
      return outcomeOf(record, 'stale-revision', '重试基于的版本已经过期')
    }
    if (record.active) return outcomeOf(record, 'duplicate', '当前仍在执行，暂不能接受新的推进')
    if (!hasIntentPort) return outcomeOf(record, 'capability-gap', '意图端口未配置：拒绝重试意图路由')
    if (record.calculation !== null) return outcomeOf(record, 'invalid-input', '本轮已经进入计算：不能重试意图路由')
    if (!canRetryWorkflowIntent(snapshotOf(record))) {
      return outcomeOf(record, 'invalid-input', '这一轮不是可在意图阶段重试的停止状态')
    }
    record.usedSubmissions.add(submissionId)
    // The frozen inputs are reused exactly as prepared: only the router is retried.
    record.routing = null
    record.clarification = null
    record.error = ''
    record.errorKind = ''
    record.outcome = null
    await runRoutedDrive(record, 'elements')
    return await finish(record)
  }

  const exportRun = async (runId: string): Promise<ValuationWorkflowRunDTO | null> => {
    const record = runs.get(String(runId ?? '').trim())
    return record === undefined ? null : serializeRunRecord(record)
  }

  const restoreRun = async (input: unknown): Promise<ValuationWorkflowOperationOutcome> => {
    const parsed = parseRunRecord(input)
    if (!parsed.ok) {
      const candidateId = typeof input === 'object' && input !== null && !Array.isArray(input)
        && typeof (input as Record<string, unknown>).runId === 'string'
        ? String((input as Record<string, unknown>).runId)
        : ''
      return outcomeOf(
        newRecord({ runId: candidateId, object: { objectId: '', useLabel: '', areaSqm: null } }),
        'unknown-run',
        parsed.error,
      )
    }
    const record = parsed.record
    const existing = runs.get(record.runId)
    if (existing !== undefined) {
      return outcomeOf(existing, 'duplicate', '这一轮已经存在，不能覆盖现有运行')
    }
    // Admit only after the whole image has been validated.
    runs.set(record.runId, record)
    return outcomeOf(record)
  }

  return {
    start,
    get,
    answer,
    saveDraft,
    submitQuestions,
    revise,
    approvePlan,
    cancel,
    retryIntent,
    exportRun,
    restoreRun,
    dispose: () => {
      for (const record of runs.values()) {
        if (record.active || record.status === 'running') {
          record.cancelRequested = true
          record.status = 'cancelled'
          record.outcome = 'cancelled'
          record.controller?.abort()
        }
      }
      runs.clear()
    },
  }
}
