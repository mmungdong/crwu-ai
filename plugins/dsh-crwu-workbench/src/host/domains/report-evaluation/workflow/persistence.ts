/**
 * Durable image of one valuation workflow run.
 *
 * The DTO is a plain, JSON-safe projection of the single in-memory `RunRecord`:
 * sets become arrays and every controller/session handle is omitted. Parsing
 * validates identity, schema, bounds and the accepted plan digest; it never
 * consults a port, performs IO or starts inference. Restoring a run that was
 * persisted while still executing is reconciliation-required, never silently idle.
 */
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowClarification,
  type ValuationWorkflowDecision,
  type ValuationWorkflowDelivery,
  type ValuationWorkflowErrorKind,
  type ValuationWorkflowInitialInput,
  type ValuationWorkflowMode,
  type ValuationWorkflowObject,
  type ValuationWorkflowOutcome,
  type ValuationWorkflowPlan,
  type ValuationWorkflowResult,
  type ValuationWorkflowRevisionChange,
  type ValuationWorkflowRevisionRecord,
  type ValuationWorkflowRouting,
  type ValuationWorkflowStage,
  type ValuationWorkflowStageReceipt,
  type ValuationWorkflowStageState,
  type ValuationWorkflowStatus,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { AcceptedRequirement } from '../knowledge/requirements.ts'
import { knowledgeDigest } from '../knowledge/snapshot.ts'
import { buildPlanDigest } from './plan.ts'
import { validateInitialInput } from './input-context.ts'
import type { ValuationEvidenceRetrievalAttempt, ValuationObservedSample } from './ports.ts'
import type { RunRecord } from './service.ts'
import type { ValuationWorkflowQuestionnaire } from '../../../../shared/contracts/valuation-questionnaire.ts'
import { legacyQuestionnaire, restoreQuestionnaire, validateWorkflowQuestion } from './questionnaire.ts'

export const VALUATION_RUN_FORMAT = 'crwu.valuation.run.v1'

/** Verified knowledge body image bound into the durable record. */
export interface ValuationWorkflowKnowledgeSourceImage {
  sourceId: string
  spaceName: string
  path: string
  digest: string
  body: string
  kind: 'prose' | 'table'
}

export interface ValuationWorkflowSampleImage {
  sourceId: string
  unitPrice: number
}

export interface ValuationWorkflowEvidencePoolImage {
  key: string
  samples: ValuationObservedSample[]
  retrievalAttempts: ValuationEvidenceRetrievalAttempt[]
}

export interface ValuationWorkflowRunDTO {
  format: typeof VALUATION_RUN_FORMAT
  runId: string
  revision: number
  status: ValuationWorkflowStatus
  outcome: ValuationWorkflowOutcome | null
  object: ValuationWorkflowObject
  decision: ValuationWorkflowDecision
  clarification: ValuationWorkflowClarification | null
  stages: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  plan: ValuationWorkflowPlan | null
  result: ValuationWorkflowResult | null
  delivery: ValuationWorkflowDelivery | null
  revisions: ValuationWorkflowRevisionRecord[]
  error: string
  errorKind: ValuationWorkflowErrorKind
  purpose: string
  baseDate: string
  userInput: string
  materials: Array<{ materialId: string; fileName: string; digest: string; text: string }>
  /** Canonical first-submitted choices; optional for legacy images (absent = null). */
  initialInput?: ValuationWorkflowInitialInput | null
  questionnaire?: ValuationWorkflowQuestionnaire
  routing: ValuationWorkflowRouting | null
  knowledgeSources: ValuationWorkflowKnowledgeSourceImage[]
  knownSamples: ValuationWorkflowSampleImage[]
  observedSamples: ValuationObservedSample[]
  evidencePool: ValuationWorkflowEvidencePoolImage | null
  evidenceSamples: ValuationWorkflowSampleImage[]
  acceptedRequirements: AcceptedRequirement[]
  calculation: { unitPrice: number; totalPrice: number } | null
  nodePrompts: Record<ValuationWorkflowStage, string>
  usedSubmissions: string[]
  usedClarifications: string[]
  stopUnknown: { sessionId: string; error: string } | null
  active: boolean
  updatedAt: string
}

export type RunRestoreResult =
  | { ok: true; record: RunRecord }
  | { ok: false; error: string }

const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_NESTING = 64
const MAX_ARRAY = 100000
const MAX_SET = 100000
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

/** Field names a durable image may carry; anything else is an unknown shape. */
const RUN_KEYS = new Set<string>([
  'format', 'runId', 'revision', 'status', 'outcome', 'object', 'decision', 'clarification',
  'stages', 'plan', 'result', 'delivery', 'revisions', 'error', 'errorKind', 'purpose', 'baseDate',
  'userInput', 'materials', 'initialInput', 'routing', 'knowledgeSources', 'knownSamples', 'observedSamples',
  'evidencePool', 'evidenceSamples', 'acceptedRequirements', 'calculation', 'nodePrompts',
  'usedSubmissions', 'usedClarifications', 'stopUnknown', 'active', 'updatedAt', 'questionnaire',
])

const STATUSES: readonly ValuationWorkflowStatus[] = [
  'running', 'waiting-user', 'completed', 'partial', 'blocked', 'failed', 'cancelled',
]
const OUTCOMES: readonly ValuationWorkflowOutcome[] = [
  'completed', 'partial', 'blocked', 'failed', 'cancelled',
]
const ERROR_KINDS: readonly ValuationWorkflowErrorKind[] = [
  '', 'invalid-input', 'stale-revision', 'duplicate', 'unknown-run', 'cancelled',
  'capability-gap', 'blocked', 'failed', 'stop-unknown', 'infrastructure',
]
const STAGE_STATES: readonly ValuationWorkflowStageState[] = [
  'pending', 'running', 'waiting', 'passed', 'partial', 'blocked', 'failed', 'cancelled',
]
const MODES: readonly ValuationWorkflowMode[] = ['formal', 'listing-reference']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asInteger(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null
}

function asPositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function isStage(value: unknown): value is ValuationWorkflowStage {
  return typeof value === 'string' && (VALUATION_WORKFLOW_STAGES as readonly string[]).includes(value)
}

function isStageState(value: unknown): value is ValuationWorkflowStageState {
  return typeof value === 'string' && (STAGE_STATES as readonly string[]).includes(value)
}

function isStatus(value: unknown): value is ValuationWorkflowStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

function isOutcome(value: unknown): value is ValuationWorkflowOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value)
}

function isErrorKind(value: unknown): value is ValuationWorkflowErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isPlainStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length <= MAX_ARRAY
}

function cloneJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Reject `__proto__`/`constructor`/`prototype` keys anywhere in the payload. */
function pollutionFree(value: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING) return false
  if (Array.isArray(value)) return value.every((item) => pollutionFree(item, depth + 1))
  if (!isRecord(value)) return true
  for (const key of Object.keys(value)) {
    if (POLLUTION_KEYS.has(key)) return false
    if (!pollutionFree(value[key], depth + 1)) return false
  }
  return true
}

function finiteNumbers(value: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => finiteNumbers(item, depth + 1))
  if (isRecord(value)) return Object.values(value).every((item) => finiteNumbers(item, depth + 1))
  return true
}

function withinPayloadSize(input: unknown): boolean {
  try {
    return JSON.stringify(input).length <= MAX_PAYLOAD_BYTES
  } catch {
    return false
  }
}

/** Exact image of a finite number as `num / 10^scale`, parsed from its string form. */
interface ScaledInteger {
  num: bigint
  scale: number
}

/**
 * Parse the shortest round-trip decimal form of a finite number (including scientific
 * notation) into an exact scaled integer. Binary floating point is never the arithmetic
 * source, so a decimal tie such as 10.075 stays exactly 10.075.
 */
function toScaledInteger(value: number): ScaledInteger | null {
  const parts = String(value).split(/[eE]/)
  const mantissa = parts[0]
  const exponent = parts.length > 1 ? Number(parts[1]) : 0
  const dot = mantissa.indexOf('.')
  const fractionLength = dot < 0 ? 0 : mantissa.length - dot - 1
  const digits = mantissa.replace('.', '')
  if (!/^[+-]?\d+$/.test(digits)) return null
  const magnitude = BigInt(digits.replace(/^[+-]/, ''))
  let num = digits.startsWith('-') ? -magnitude : magnitude
  let scale = fractionLength - exponent
  if (scale < 0) {
    num *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { num, scale }
}

/** Half-up rounding of `num / den` (den > 0) to hundredths, as an integer cent count. */
function halfUpCents(num: bigint, den: bigint): bigint {
  return (200n * num + den) / (2n * den)
}

/**
 * Reproduce the calculator's independent decimal half-up quantization: the unit price is
 * the half-up hundredth of the exact raw mean, and the total is the half-up hundredth of
 * the *unrounded* mean times the area. The unit price is never rounded first and then
 * multiplied, and no epsilon or tolerance is applied.
 */
function expectedMoney(
  samples: ReadonlyArray<{ unitPrice: number }>,
  areaSqm: number,
): { unitPrice: number; totalPrice: number } | null {
  if (samples.length === 0) return null
  const scaled: ScaledInteger[] = []
  for (const sample of samples) {
    const parsed = toScaledInteger(sample.unitPrice)
    if (parsed === null) return null
    scaled.push(parsed)
  }
  const area = toScaledInteger(areaSqm)
  if (area === null) return null
  const maxScale = scaled.reduce((max, item) => (item.scale > max ? item.scale : max), 0)
  const meanNum = scaled.reduce((sum, item) => sum + item.num * 10n ** BigInt(maxScale - item.scale), 0n)
  const meanDen = 10n ** BigInt(maxScale) * BigInt(samples.length)
  // total = raw mean * area, kept as one exact rational until the final quantization.
  const totalNum = meanNum * area.num
  const totalDen = meanDen * 10n ** BigInt(area.scale)
  return {
    unitPrice: Number(halfUpCents(meanNum, meanDen)) / 100,
    totalPrice: Number(halfUpCents(totalNum, totalDen)) / 100,
  }
}

function withinBounds(input: Record<string, unknown>): boolean {
  for (const key of [
    'materials', 'knowledgeSources', 'knownSamples', 'observedSamples', 'evidenceSamples',
    'acceptedRequirements', 'revisions', 'usedSubmissions', 'usedClarifications',
  ]) {
    const value = input[key]
    if (Array.isArray(value) && value.length > MAX_ARRAY) return false
  }
  return true
}

function isSample(value: unknown): boolean {
  return isRecord(value)
    && typeof value.sourceId === 'string' && value.sourceId !== ''
    && typeof value.unitPrice === 'number' && Number.isFinite(value.unitPrice) && value.unitPrice > 0
}

function isValidQuestion(value: unknown): boolean {
  return validateWorkflowQuestion(value)
}

function isValidClarification(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.clarificationId !== 'string' || value.clarificationId === '') return false
  if (asInteger(value.revision, 0) === null) return false
  if (!Array.isArray(value.questions)) return false
  return value.questions.every(isValidQuestion)
}

function isValidReceipt(value: unknown, stage: ValuationWorkflowStage): boolean {
  if (!isRecord(value)) return false
  if (value.stage !== stage) return false
  if (!isStageState(value.state)) return false
  if (asInteger(value.attempt, 0) === null) return false
  if (typeof value.sessionId !== 'string') return false
  if (!isRecord(value.inputs) || !isRecord(value.outputs)) return false
  return isPlainStringArray(value.gaps)
}

function isValidStages(value: unknown): value is Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== VALUATION_WORKFLOW_STAGES.length) return false
  return VALUATION_WORKFLOW_STAGES.every((stage) => isValidReceipt(value[stage], stage))
}

function isValidPlanSource(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.providerId === 'string'
    && typeof value.state === 'string'
    && typeof value.community === 'string'
    && typeof value.detailUrl === 'string'
    && isRecord(value.fields)
    && typeof value.transactionType === 'string'
    && typeof value.evidence === 'string'
}

function isValidPlan(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.digest !== 'string' || value.digest === '') return false
  if (typeof value.ready !== 'boolean' || typeof value.accepted !== 'boolean') return false
  if (asInteger(value.revision, 0) === null) return false
  if (!isPlainStringArray(value.gaps)) return false
  if (typeof value.method !== 'string' || typeof value.algorithm !== 'string') return false
  if (typeof value.valuationMode !== 'string' || !(MODES as readonly string[]).includes(value.valuationMode)) return false
  if (!Array.isArray(value.sources) || !value.sources.every(isValidPlanSource)) return false
  if (!isRecord(value.template)) return false
  const template = value.template
  if (typeof template.fileName !== 'string' || typeof template.relativePath !== 'string'
    || typeof template.digest !== 'string' || typeof template.verified !== 'boolean') return false
  if (!Array.isArray(template.mapping) || !Array.isArray(template.formulaChecks)) return false
  if (!Array.isArray(value.basis) || !isPlainStringArray(value.limitations)) return false
  return true
}

function isValidResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.objectId === 'string'
    && typeof value.useLabel === 'string'
    && asPositive(value.areaSqm) !== null
    && asPositive(value.unitPrice) !== null
    && asPositive(value.totalPrice) !== null
    && typeof value.currency === 'string'
    && isPlainStringArray(value.sources)
    && typeof value.generatedAt === 'string'
}

function isValidDelivery(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.kind === 'string' && (MODES as readonly string[]).includes(value.kind)
    && isPlainStringArray(value.artifacts)
    && typeof value.referenceDelivered === 'boolean'
    && typeof value.formalComplete === 'boolean'
}

function isValidRouting(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.route !== 'string' || typeof value.intentSessionId !== 'string') return false
  if (value.intent === null) return true
  if (!isRecord(value.intent)) return false
  const intent = value.intent
  if (intent.business !== 'valuation' && intent.business !== 'unknown') return false
  if (intent.assetType !== null && typeof intent.assetType !== 'string') return false
  if (intent.status !== 'resolved' && intent.status !== 'needs-clarification' && intent.status !== 'unsupported') return false
  if (!Array.isArray(intent.objects) || !intent.objects.every((object) => isRecord(object)
    && typeof object.objectId === 'string' && isPlainStringArray(object.materialIds))) return false
  if (!Array.isArray(intent.evidence) || !intent.evidence.every((evidence) => isRecord(evidence)
    && typeof evidence.quote === 'string')) return false
  return isPlainStringArray(intent.questions)
}

function isValidRequirement(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.requirementId !== 'string' || typeof value.statement !== 'string') return false
  if (typeof value.strength !== 'string' || typeof value.sourceId !== 'string') return false
  if (typeof value.sourceDigest !== 'string' || typeof value.resolvedPath !== 'string') return false
  if (typeof value.section !== 'string' || typeof value.quote !== 'string') return false
  if (value.calculatorId !== null && typeof value.calculatorId !== 'string') return false
  if (value.parameter === null) return true
  if (!isRecord(value.parameter)) return false
  const parameterValue = value.parameter.value
  return typeof value.parameter.name === 'string' && typeof value.parameter.unit === 'string'
    && (parameterValue === null || typeof parameterValue === 'string'
      || (typeof parameterValue === 'number' && Number.isFinite(parameterValue)))
}

function isValidChange(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isStage(value.nodeId)
    && typeof value.field === 'string' && value.field !== ''
    && value.sourceKind === 'user'
    && typeof value.source === 'string'
    && typeof value.reason === 'string'
}

function isValidRevision(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (asInteger(value.revision, 1) === null) return false
  if (!isStatus(value.status)) return false
  if (value.outcome !== null && !isOutcome(value.outcome)) return false
  if (value.result !== null && !isValidResult(value.result)) return false
  if (typeof value.reason !== 'string' || typeof value.source !== 'string') return false
  if (!isPlainStringArray(value.supersededNodeIds)) return false
  if (value.stages !== undefined && !isValidStages(value.stages)) return false
  if (value.plan !== undefined && value.plan !== null && !isValidPlan(value.plan)) return false
  if (value.changes !== undefined
    && (!Array.isArray(value.changes) || !value.changes.every(isValidChange))) return false
  return true
}

function isValidMaterial(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.materialId === 'string'
    && typeof value.fileName === 'string'
    && typeof value.digest === 'string'
    && (value.text === undefined || typeof value.text === 'string')
}

function isValidKnowledgeSource(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.sourceId === 'string' && value.sourceId !== ''
    && typeof value.spaceName === 'string'
    && typeof value.path === 'string'
    && typeof value.digest === 'string'
    && typeof value.body === 'string'
    && (value.kind === 'prose' || value.kind === 'table')
}

function isValidEvidencePool(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.key !== 'string' || value.key === '') return false
  if (!Array.isArray(value.samples) || !value.samples.every(isSample)) return false
  return Array.isArray(value.retrievalAttempts) && value.retrievalAttempts.every((attempt) => isRecord(attempt)
    && typeof attempt.provider === 'string' && typeof attempt.outcome === 'string')
}

function isValidNodePrompts(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, prompt]) => isStage(key) && typeof prompt === 'string')
}

function emptyPrompts(): Record<ValuationWorkflowStage, string> {
  const prompts = {} as Record<ValuationWorkflowStage, string>
  for (const stage of VALUATION_WORKFLOW_STAGES) prompts[stage] = ''
  return prompts
}

function copyStages(
  stages: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>,
): Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt> {
  const copy = {} as Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>
  for (const stage of VALUATION_WORKFLOW_STAGES) {
    const receipt = stages[stage]
    copy[stage] = {
      stage: receipt.stage,
      state: receipt.state,
      attempt: receipt.attempt,
      sessionId: receipt.sessionId,
      inputs: cloneJson<Record<string, unknown>>(receipt.inputs),
      outputs: cloneJson<Record<string, unknown>>(receipt.outputs),
      gaps: [...receipt.gaps],
    }
  }
  return copy
}

/** Project the live run record into an independent, JSON-safe image. */
export function serializeRunRecord(record: RunRecord): ValuationWorkflowRunDTO {
  const image: ValuationWorkflowRunDTO = {
    format: VALUATION_RUN_FORMAT,
    runId: record.runId,
    revision: record.revision,
    status: record.status,
    outcome: record.outcome,
    object: { ...record.object },
    decision: { ...record.decision },
    clarification: record.clarification === null ? null : cloneJson(record.clarification),
    stages: copyStages(record.stages),
    plan: record.plan === null ? null : cloneJson(record.plan),
    result: record.result === null ? null : cloneJson(record.result),
    delivery: record.delivery === null ? null : cloneJson(record.delivery),
    revisions: record.revisions.map((revision) => ({
      ...revision,
      result: revision.result === null ? null : cloneJson(revision.result),
      supersededNodeIds: [...revision.supersededNodeIds],
      ...(revision.changes === undefined
        ? {}
        : { changes: revision.changes.map((change) => cloneJson<ValuationWorkflowRevisionChange>(change)) }),
      ...(revision.stages === undefined ? {} : { stages: copyStages(revision.stages) }),
      ...(revision.plan === undefined ? {} : { plan: cloneJson(revision.plan) }),
    })),
    error: record.error,
    errorKind: record.errorKind,
    purpose: record.purpose,
    baseDate: record.baseDate,
    userInput: record.userInput,
    materials: record.materials.map((material) => ({
      materialId: material.materialId,
      fileName: material.fileName,
      digest: material.digest,
      text: material.text ?? '',
    })),
    initialInput: record.initialInput === null ? null : cloneJson(record.initialInput),
    questionnaire: cloneJson(record.questionnaire ?? legacyQuestionnaire(record)),
    routing: record.routing === null ? null : cloneJson(record.routing),
    knowledgeSources: record.knowledgeSources.map((source) => ({
      sourceId: source.sourceId,
      spaceName: source.spaceName,
      path: source.path,
      digest: source.digest,
      body: source.body,
      kind: source.kind,
    })),
    knownSamples: record.knownSamples.map((sample) => ({ ...sample })),
    observedSamples: record.observedSamples.map((sample) => ({ ...sample })),
    evidencePool: record.evidencePool === null ? null : {
      key: record.evidencePool.key,
      samples: record.evidencePool.samples.map((sample) => ({ ...sample })),
      retrievalAttempts: record.evidencePool.retrievalAttempts.map((attempt) => ({ ...attempt })),
    },
    evidenceSamples: record.evidenceSamples.map((sample) => ({ ...sample })),
    acceptedRequirements: cloneJson(record.acceptedRequirements),
    calculation: record.calculation === null ? null : { ...record.calculation },
    nodePrompts: { ...record.nodePrompts },
    usedSubmissions: [...record.usedSubmissions],
    usedClarifications: [...record.usedClarifications],
    stopUnknown: record.stopUnknown === null ? null : { ...record.stopUnknown },
    active: record.active,
    updatedAt: record.updatedAt,
  }
  return cloneJson(image)
}

function fail(error: string): RunRestoreResult {
  return { ok: false, error }
}

function lastRunningSession(stages: Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>): string {
  for (const stage of [...VALUATION_WORKFLOW_STAGES].reverse()) {
    if (stages[stage].state === 'running') return stages[stage].sessionId
  }
  return ''
}

/**
 * Validate a durable image and rebuild the exact in-memory run record.
 *
 * `null` on any required field, an unknown stage/status, a mismatched plan digest
 * or a prototype-polluting key all fail closed. No port is consulted and no
 * inference is performed.
 */
export function parseRunRecord(input: unknown): RunRestoreResult {
  if (!isRecord(input)) return fail('恢复数据必须是对象')
  if (!pollutionFree(input)) return fail('恢复数据包含不安全的字段名')
  if (!Object.keys(input).every((key) => RUN_KEYS.has(key))) return fail('恢复数据包含未知字段')
  if (input.format !== VALUATION_RUN_FORMAT) return fail('恢复数据格式不受支持')
  if (!finiteNumbers(input)) return fail('恢复数据包含无效数值')
  if (!withinBounds(input)) return fail('恢复数据超出大小上限')
  if (!withinPayloadSize(input)) return fail('恢复数据超出大小上限')

  const runId = asText(input.runId)
  if (runId === null || runId.trim() === '') return fail('恢复数据缺少运行标识')
  const revision = asInteger(input.revision, 1)
  if (revision === null) return fail('恢复数据的版本无效')
  if (!isStatus(input.status)) return fail('恢复数据的运行状态无效')
  const status = input.status
  if (input.outcome !== null && !isOutcome(input.outcome)) return fail('恢复数据的运行结论无效')
  const outcome = input.outcome === null ? null : input.outcome
  if (!isErrorKind(input.errorKind)) return fail('恢复数据的错误类型无效')
  const errorKind = input.errorKind
  const error = asText(input.error)
  const purpose = asText(input.purpose)
  const baseDate = asText(input.baseDate)
  if (error === null || purpose === null || baseDate === null) return fail('恢复数据缺少运行说明字段')
  const userInput = asText(input.userInput) ?? ''
  const updatedAt = asText(input.updatedAt)
  if (updatedAt === null) return fail('恢复数据缺少更新时间')

  if (!isRecord(input.object)) return fail('恢复数据缺少估价对象')
  const objectId = asText(input.object.objectId)
  const useLabel = asText(input.object.useLabel)
  if (objectId === null || useLabel === null) return fail('恢复数据的估价对象字段无效')
  const rawArea = input.object.areaSqm
  const areaSqm = rawArea === null ? null : asPositive(rawArea)
  if (rawArea !== null && areaSqm === null) return fail('恢复数据的建筑面积无效')

  if (!isRecord(input.decision)) return fail('恢复数据缺少口径决策')
  const mode = input.decision.mode
  if (mode !== null && (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode))) {
    return fail('恢复数据的估值口径无效')
  }
  if (typeof input.decision.accepted !== 'boolean') return fail('恢复数据的口径决策无效')

  if (input.clarification !== null && !isValidClarification(input.clarification)) {
    return fail('恢复数据的待决事项无效')
  }
  if (!isValidStages(input.stages)) return fail('恢复数据的节点回执无效')
  if (!Array.isArray(input.revisions) || !input.revisions.every(isValidRevision)) {
    return fail('恢复数据的修订历史无效')
  }
  const revisionHistory = cloneJson<ValuationWorkflowRevisionRecord[]>(input.revisions)

  const object: ValuationWorkflowObject = { objectId, useLabel, areaSqm }

  let plan: ValuationWorkflowPlan | null = null
  if (input.plan !== null) {
    if (!isValidPlan(input.plan)) return fail('恢复数据的方案回执无效')
    const candidate = cloneJson<ValuationWorkflowPlan>(input.plan)
    if (candidate.revision > revision) return fail('恢复数据的方案回执晚于当前版本')
    let digest = ''
    try {
      digest = buildPlanDigest({
        runId,
        revision: candidate.revision,
        object,
        purpose,
        baseDate,
        mode: mode as ValuationWorkflowMode | null,
        plan: candidate,
      })
    } catch {
      return fail('恢复数据的方案回执无法核对')
    }
    if (digest !== candidate.digest) return fail('方案摘要与运行状态不一致')
    // A downstream-only correction inherits the approved plan with its original
    // revision; it stays valid only when the immutable history holds that receipt.
    if (candidate.accepted && candidate.revision < revision) {
      const backed = revisionHistory.some((item) => item.revision === candidate.revision
        && item.plan !== undefined && item.plan.digest === candidate.digest)
      if (!backed) return fail('已确认方案缺少对应版本的不可变回执')
    }
    plan = candidate
  }

  if (input.result !== null && !isValidResult(input.result)) return fail('恢复数据的计算结果无效')
  if (input.delivery !== null && !isValidDelivery(input.delivery)) return fail('恢复数据的交付回执无效')
  if (input.routing !== null && !isValidRouting(input.routing)) return fail('恢复数据的意图路由无效')
  if (!Array.isArray(input.materials) || !input.materials.every(isValidMaterial)) {
    return fail('恢复数据的资料清单无效')
  }
  if (!Array.isArray(input.knowledgeSources) || !input.knowledgeSources.every(isValidKnowledgeSource)) {
    return fail('恢复数据的知识来源无效')
  }
  const knowledgeSources = cloneJson<ValuationWorkflowKnowledgeSourceImage[]>(input.knowledgeSources)
  for (const source of knowledgeSources) {
    if (knowledgeDigest(source.body) !== source.digest) {
      return fail('知识来源摘要与正文不一致')
    }
  }
  if (!Array.isArray(input.knownSamples) || !input.knownSamples.every(isSample)) {
    return fail('恢复数据的候选样本无效')
  }
  if (!Array.isArray(input.observedSamples) || !input.observedSamples.every(isSample)) {
    return fail('恢复数据的实际样本无效')
  }
  if (input.evidencePool !== null && !isValidEvidencePool(input.evidencePool)) {
    return fail('恢复数据的证据池无效')
  }
  if (!Array.isArray(input.evidenceSamples) || !input.evidenceSamples.every(isSample)) {
    return fail('恢复数据的采用样本无效')
  }
  const evidenceSamples = cloneJson<Array<{ sourceId: string; unitPrice: number }>>(input.evidenceSamples)
  if (!Array.isArray(input.acceptedRequirements) || !input.acceptedRequirements.every(isValidRequirement)) {
    return fail('恢复数据的采用要求无效')
  }
  const acceptedRequirements = cloneJson<AcceptedRequirement[]>(input.acceptedRequirements)
  const sourceById = new Map(knowledgeSources.map((source) => [source.sourceId, source]))
  for (const requirement of acceptedRequirements) {
    const source = sourceById.get(requirement.sourceId)
    if (source === undefined) return fail('采用要求引用了不在本轮的知识来源')
    if (requirement.sourceDigest !== source.digest) return fail('采用要求的来源摘要与知识正文不一致')
    if (requirement.resolvedPath !== source.path) return fail('采用要求的库内路径与知识来源不一致')
    if (requirement.quote === '' || !source.body.includes(requirement.quote)) {
      return fail('采用要求的原文不在知识正文里')
    }
  }
  let calculationImage: { unitPrice: number; totalPrice: number } | null = null
  if (input.calculation !== null) {
    if (!isRecord(input.calculation)
      || asPositive(input.calculation.unitPrice) === null
      || asPositive(input.calculation.totalPrice) === null) {
      return fail('恢复数据的计算金额无效')
    }
    calculationImage = {
      unitPrice: input.calculation.unitPrice as number,
      totalPrice: input.calculation.totalPrice as number,
    }
    if (evidenceSamples.length === 0) return fail('恢复数据的计算金额缺少采用样本')
    if (areaSqm === null) return fail('恢复数据的计算金额缺少建筑面积')
    const expected = expectedMoney(evidenceSamples, areaSqm)
    if (expected === null) return fail('恢复数据的计算金额无法核对')
    if (calculationImage.unitPrice !== expected.unitPrice) return fail('恢复数据的计算单价与采用样本均值不一致')
    // The builder quantizes the unrounded mean times the gross area independently,
    // so the total is not the rounded unit price multiplied by the area.
    if (calculationImage.totalPrice !== expected.totalPrice) {
      return fail('恢复数据的计算总价与单价面积不一致')
    }
  }
  const resultImage = input.result === null ? null : cloneJson<ValuationWorkflowResult>(input.result)
  if (resultImage !== null) {
    if (calculationImage === null) return fail('恢复数据的计算结果缺少计算金额')
    if (resultImage.unitPrice !== calculationImage.unitPrice
      || resultImage.totalPrice !== calculationImage.totalPrice) {
      return fail('恢复数据的计算结果与计算金额不一致')
    }
    if (areaSqm === null || resultImage.areaSqm !== areaSqm) return fail('恢复数据的计算结果与建筑面积不一致')
    if (resultImage.objectId !== objectId || resultImage.useLabel !== useLabel) {
      return fail('恢复数据的计算结果与估价对象不一致')
    }
    const adopted = new Set(evidenceSamples.map((sample) => sample.sourceId))
    if (!resultImage.sources.every((sourceId) => adopted.has(sourceId))) {
      return fail('恢复数据的计算结果引用了未采用的样本')
    }
  }
  if (!isValidNodePrompts(input.nodePrompts)) return fail('恢复数据的节点补充说明无效')
  if (!isPlainStringArray(input.usedSubmissions) || input.usedSubmissions.length > MAX_SET) {
    return fail('恢复数据的提交标识无效')
  }
  if (new Set(input.usedSubmissions).size !== input.usedSubmissions.length) {
    return fail('恢复数据的提交标识重复')
  }
  if (!isPlainStringArray(input.usedClarifications) || input.usedClarifications.length > MAX_SET) {
    return fail('恢复数据的待决标识无效')
  }
  if (new Set(input.usedClarifications).size !== input.usedClarifications.length) {
    return fail('恢复数据的待决标识重复')
  }
  let stopUnknownImage: { sessionId: string; error: string } | null = null
  if (input.stopUnknown !== null) {
    if (!isRecord(input.stopUnknown)
      || typeof input.stopUnknown.sessionId !== 'string'
      || typeof input.stopUnknown.error !== 'string') {
      return fail('恢复数据的停止状态无效')
    }
    stopUnknownImage = { sessionId: input.stopUnknown.sessionId, error: input.stopUnknown.error }
  }
  if (typeof input.active !== 'boolean') return fail('恢复数据的执行标记无效')

  // A legacy image without the field honestly restores `null`; a present but
  // malformed snapshot fails closed instead of being inferred from later state.
  let initialInputImage: ValuationWorkflowInitialInput | null = null
  if (input.initialInput !== undefined && input.initialInput !== null) {
    const validated = validateInitialInput(input.initialInput)
    if (!validated.ok) return fail(validated.error)
    initialInputImage = validated.value
  }

  const questionnaireImage = input.questionnaire === undefined
    ? legacyQuestionnaire(input)
    : restoreQuestionnaire(input.questionnaire)
  if (questionnaireImage === null) return fail('恢复数据的节点问卷无效')

  const stages = cloneJson<Record<ValuationWorkflowStage, ValuationWorkflowStageReceipt>>(input.stages)
  const nodePrompts = emptyPrompts()
  for (const [key, value] of Object.entries(cloneJson<Record<string, string>>(input.nodePrompts))) {
    if (isStage(key)) nodePrompts[key] = value
  }

  // A run saved mid-flight cannot be trusted to resume silently; keep the real
  // session ids and force reconciliation before any new write.
  const wasActive = input.active || status === 'running'
  const materials = cloneJson<Array<{ materialId: string; fileName: string; digest: string; text?: string }>>(
    input.materials,
  ).map((material) => ({
    materialId: material.materialId,
    fileName: material.fileName,
    digest: material.digest,
    text: material.text ?? '',
  }))

  const record: RunRecord = {
    runId,
    revision,
    status: wasActive ? 'failed' : status,
    outcome: wasActive ? 'failed' : outcome,
    object,
    decision: { mode: mode as ValuationWorkflowMode | null, accepted: input.decision.accepted },
    clarification: input.clarification === null
      ? null
      : cloneJson<ValuationWorkflowClarification>(input.clarification),
    stages,
    plan,
    result: input.result === null ? null : cloneJson<ValuationWorkflowResult>(input.result),
    delivery: input.delivery === null ? null : cloneJson<ValuationWorkflowDelivery>(input.delivery),
    revisions: cloneJson<ValuationWorkflowRevisionRecord[]>(input.revisions),
    error: wasActive ? '运行在保存时仍在执行，子会话静止状态未知，需要重新对账' : error,
    errorKind: wasActive ? 'infrastructure' : errorKind,
    purpose,
    baseDate,
    userInput,
    materials,
    initialInput: initialInputImage,
    questionnaire: questionnaireImage,
    routing: input.routing === null ? null : cloneJson<ValuationWorkflowRouting>(input.routing),
    knowledgeSources: cloneJson(input.knowledgeSources),
    knownSamples: cloneJson(input.knownSamples),
    observedSamples: cloneJson(input.observedSamples),
    evidencePool: input.evidencePool === null
      ? null
      : cloneJson<ValuationWorkflowEvidencePoolImage>(input.evidencePool),
    evidenceSamples: cloneJson(input.evidenceSamples),
    acceptedRequirements: cloneJson<AcceptedRequirement[]>(input.acceptedRequirements),
    calculation: calculationImage,
    active: false,
    cancelRequested: false,
    usedSubmissions: new Set(input.usedSubmissions),
    usedClarifications: new Set(input.usedClarifications),
    controller: null,
    stopUnknown: wasActive
      ? (stopUnknownImage ?? { sessionId: lastRunningSession(stages), error: '子会话静止状态未知' })
      : stopUnknownImage,
    updatedAt,
    nodePrompts,
    storeFailed: false,
  }

  return { ok: true, record }
}
