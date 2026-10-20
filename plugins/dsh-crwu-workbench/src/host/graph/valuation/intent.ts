/**
 * Strict validation and deterministic routing for inferred valuation intent.
 *
 * A model result is untrusted input: prose, extra narrative keys, forged material
 * references and quotes that are absent from the submitted body are rejected before
 * any registered professional graph can run.
 */
import type {
  GraphDriveStatus,
  InferIntentResult,
  IntentEvidence,
  ValuationIntent,
  ValuationIntentObject,
  WorkflowInput,
  WorkflowMaterial,
} from '../state.ts'

const INTENT_KEYS = ['business', 'assetType', 'status', 'objects', 'evidence', 'questions'] as const
const OBJECT_KEYS = ['objectId', 'materialIds'] as const
const MATERIAL_EVIDENCE_KEYS = ['materialId', 'quote'] as const
const USER_INPUT_EVIDENCE_KEYS = ['source', 'quote'] as const

const INVALID_INTENT = '意图结果不是受支持的结构化对象'
const INFERENCE_FAILED = '意图识别未完成，请重试'
const MISSING_SESSION = '意图结果缺少真实子会话标识'
const UNREGISTERED_ASSET = '该资产类型没有已注册的专业估值图'
const UNSUPPORTED_INTENT = '该意图没有可执行的专业估值图'
const STOP_UNKNOWN_INTENT = '意图子会话停止状态未知'
const CANCELLED_INTENT = '意图识别已取消'

export interface IntentRouteOutcome {
  status: GraphDriveStatus
  intent: ValuationIntent | null
  intentSessionId: string
  route: string
  error: string
  errorKind: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

function invalid(): { ok: false; error: string } {
  return { ok: false, error: INVALID_INTENT }
}

function blocked(error: string): IntentRouteOutcome {
  return { status: 'blocked', intent: null, intentSessionId: '', route: '', error, errorKind: 'blocked' }
}

function submittedMaterials(input: WorkflowInput): Map<string, WorkflowMaterial> {
  const materials = new Map<string, WorkflowMaterial>()
  for (const material of Array.isArray(input.materials) ? input.materials : []) {
    if (isRecord(material) && typeof material.materialId === 'string') {
      materials.set(material.materialId, material as unknown as WorkflowMaterial)
    }
  }
  return materials
}

function readText(input: WorkflowInput): string {
  return typeof input.text === 'string' ? input.text : ''
}

function hasMeaningfulInput(input: WorkflowInput): boolean {
  if (readText(input).trim() !== '') return true
  return (Array.isArray(input.materials) ? input.materials : []).some(
    (material) => typeof material.text === 'string' && material.text.trim() !== '',
  )
}

function validateObjects(
  raw: unknown,
  materials: Map<string, WorkflowMaterial>,
): { ok: true; objects: ValuationIntentObject[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return invalid()
  const objects: ValuationIntentObject[] = []
  const objectIds = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item) || !hasExactKeys(item, OBJECT_KEYS)) return invalid()
    const objectId = item.objectId
    if (typeof objectId !== 'string' || objectId.trim() === '' || objectIds.has(objectId)) {
      return invalid()
    }
    if (!Array.isArray(item.materialIds)) return invalid()
    const materialIds: string[] = []
    const objectMaterialIds = new Set<string>()
    for (const materialId of item.materialIds) {
      if (typeof materialId !== 'string' || materialId.trim() === '' || !materials.has(materialId)) {
        return invalid()
      }
      if (objectMaterialIds.has(materialId)) return invalid()
      objectMaterialIds.add(materialId)
      materialIds.push(materialId)
    }
    objectIds.add(objectId)
    objects.push({ objectId, materialIds })
  }
  return { ok: true, objects }
}

function validateEvidence(
  raw: unknown,
  input: WorkflowInput,
  materials: Map<string, WorkflowMaterial>,
): { ok: true; evidence: IntentEvidence[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return invalid()
  const evidence: IntentEvidence[] = []
  const text = readText(input)
  for (const item of raw) {
    if (!isRecord(item)) return invalid()
    const quote = item.quote
    if (typeof quote !== 'string' || quote.trim() === '') return invalid()
    if (hasExactKeys(item, USER_INPUT_EVIDENCE_KEYS)) {
      if (item.source !== 'user-input' || !text.includes(quote)) return invalid()
      evidence.push({ source: 'user-input', quote })
      continue
    }
    if (hasExactKeys(item, MATERIAL_EVIDENCE_KEYS)) {
      const materialId = item.materialId
      if (typeof materialId !== 'string' || materialId.trim() === '') return invalid()
      const material = materials.get(materialId)
      if (material === undefined) return invalid()
      const body = material.text
      if (typeof body !== 'string' || !body.includes(quote)) return invalid()
      evidence.push({ materialId, quote })
      continue
    }
    return invalid()
  }
  return { ok: true, evidence }
}

function validateQuestions(raw: unknown): { ok: true; questions: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return invalid()
  const questions: string[] = []
  for (const question of raw) {
    if (typeof question !== 'string' || question.trim() === '') return invalid()
    questions.push(question)
  }
  return { ok: true, questions }
}

export function validateIntent(
  value: unknown,
  input: WorkflowInput,
): { ok: true; intent: ValuationIntent } | { ok: false; error: string } {
  if (!isRecord(value) || !hasExactKeys(value, INTENT_KEYS)) return invalid()
  const business = value.business
  if (business !== 'valuation' && business !== 'unknown') return invalid()
  const status = value.status
  if (status !== 'resolved' && status !== 'needs-clarification' && status !== 'unsupported') {
    return invalid()
  }
  const assetType = value.assetType
  if (assetType !== null && (typeof assetType !== 'string' || assetType.trim() === '')) {
    return invalid()
  }
  if (business === 'unknown' && status === 'resolved') return invalid()
  if (status === 'resolved' && assetType === null) return invalid()

  const materials = submittedMaterials(input)
  const objects = validateObjects(value.objects, materials)
  if (!objects.ok) return objects
  const evidence = validateEvidence(value.evidence, input, materials)
  if (!evidence.ok) return evidence
  const questions = validateQuestions(value.questions)
  if (!questions.ok) return questions

  if (status === 'resolved') {
    if (business !== 'valuation'
      || assetType === null
      || objects.objects.length === 0
      || evidence.evidence.length === 0
      || !hasMeaningfulInput(input)) {
      return invalid()
    }
  }
  if (status === 'needs-clarification' && questions.questions.length === 0) return invalid()

  return {
    ok: true,
    intent: {
      business,
      assetType,
      status,
      objects: objects.objects,
      evidence: evidence.evidence,
      questions: questions.questions,
    },
  }
}

function routeValidated(
  input: WorkflowInput,
  registeredAssetIds: readonly string[],
  rawIntent: unknown,
  sessionId: string,
): IntentRouteOutcome {
  const validated = validateIntent(rawIntent, input)
  if (!validated.ok) return blocked(validated.error)
  const intent = validated.intent
  if (intent.status === 'needs-clarification') {
    return { status: 'waiting', intent, intentSessionId: sessionId, route: '', error: '', errorKind: '' }
  }
  if (intent.status === 'unsupported') {
    return { status: 'blocked', intent, intentSessionId: sessionId, route: '', error: UNSUPPORTED_INTENT, errorKind: 'blocked' }
  }
  const assetType = intent.assetType
  if (assetType === null || !registeredAssetIds.includes(assetType)) {
    return { status: 'blocked', intent, intentSessionId: sessionId, route: '', error: UNREGISTERED_ASSET, errorKind: 'blocked' }
  }
  return { status: 'running', intent, intentSessionId: sessionId, route: assetType, error: '', errorKind: '' }
}

export function evaluateInference(
  input: WorkflowInput,
  registeredAssetIds: readonly string[],
  result: InferIntentResult,
): IntentRouteOutcome {
  if (typeof result !== 'object' || result === null) return blocked(INFERENCE_FAILED)
  if (result.ok !== true) {
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId.trim() : ''
    const errorKind = typeof result.errorKind === 'string' ? result.errorKind : ''
    if (errorKind === 'stop-unknown') {
      return {
        status: 'failed', intent: null, intentSessionId: sessionId, route: '',
        error: STOP_UNKNOWN_INTENT, errorKind: 'stop-unknown',
      }
    }
    if (errorKind === 'cancelled') {
      return {
        status: 'cancelled', intent: null, intentSessionId: sessionId, route: '',
        error: CANCELLED_INTENT, errorKind: 'cancelled',
      }
    }
    if (errorKind === 'blocked') {
      // A structured Host business refusal is controlled text, not an SDK error:
      // keep its concrete reason and the actual child identity.
      const reason = typeof result.error === 'string' && result.error.trim() !== ''
        ? result.error.trim()
        : INFERENCE_FAILED
      return {
        status: 'blocked', intent: null, intentSessionId: sessionId, route: '',
        error: reason, errorKind: 'blocked',
      }
    }
    return blocked(INFERENCE_FAILED)
  }
  const sessionId = typeof result.sessionId === 'string' ? result.sessionId.trim() : ''
  if (sessionId === '') return blocked(MISSING_SESSION)
  return routeValidated(input, registeredAssetIds, result.intent, sessionId)
}

export function evaluateAdopted(
  input: WorkflowInput,
  registeredAssetIds: readonly string[],
  intent: unknown,
  sessionId: unknown,
): IntentRouteOutcome {
  const adoptedSession = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (adoptedSession === '') return blocked(MISSING_SESSION)
  return routeValidated(input, registeredAssetIds, intent, adoptedSession)
}
