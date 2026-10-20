/**
 * Pure mapper from an accepted listing-reference run to the fixed builder input.
 *
 * The fixed input is the only thing the packaged `build_listing_reference.py`
 * consumes; this module never computes an amount and never invents property facts.
 * Every adopted case price must equal the immutable Host observation, every adopted
 * case must carry exactly one qualified source-bound suitability assessment, and a
 * missing screenshot stays missing instead of being synthesized. The template keeps
 * the exact approved plan identity (path, digest, mapping and formula checks).
 */
import { canonicalListingUrl } from '../market/candidates.ts'

export interface WorkflowListingPayloadResult {
  ok: boolean
  payload?: Record<string, unknown>
  error?: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? number : null
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** A stable case id derived from the source identity; never a running index. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function listingKindOf(value: unknown): string {
  const kind = text(value).toLowerCase()
  if (kind === 'listing' || kind === '挂牌') return 'listing'
  if (kind === 'deal' || kind === 'sold' || kind === '成交') return 'deal'
  return kind === '' ? '' : 'other'
}

function httpUrlProblem(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '不是 HTTP(S) 地址'
    if (url.hostname === '') return '缺少主机名'
    if (url.username !== '' || url.password !== '') return '携带用户名或口令'
    return ''
  } catch {
    return '不是合法地址'
  }
}

/** Native closed enums for one retrieval attempt; anything else is refused, never dropped. */
const RETRIEVAL_STAGES = new Set(['search', 'detail', 'screenshot'])
const RETRIEVAL_OUTCOMES = new Set(['ok', 'blocked', 'challenge-recovered', 'waiting-user', 'unsupported', 'failed'])

interface RetrievalNormalization {
  ok: boolean
  rows: JsonRecord[]
  error?: string
}

/**
 * Project one real workflow retrieval attempt into the native closed row.
 *
 * Only the seven native fields survive: a stable technical task identity is derived
 * from the actual run/revision/index, the provider keeps its actual id, stage and
 * outcome must be supported enum values (a malformed attempt is a refusal, not a
 * silent drop), and a missing URL is an honest blank rather than a guessed address.
 */
function normalizeRetrievalAttempts(
  raw: unknown,
  identity: { runId: string; revision: number },
): RetrievalNormalization {
  if (raw === undefined || raw === null) return { ok: true, rows: [] }
  if (!Array.isArray(raw)) return { ok: false, rows: [], error: '检索尝试必须是数组' }
  const rows: JsonRecord[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    if (!isRecord(item)) return { ok: false, rows: [], error: `检索尝试 ${String(index + 1)} 不是对象` }
    const stage = text(item.stage)
    if (!RETRIEVAL_STAGES.has(stage)) {
      return { ok: false, rows: [], error: `检索尝试 ${String(index + 1)} 的阶段不受支持：${stage || '未提供'}` }
    }
    const outcome = text(item.outcome)
    if (!RETRIEVAL_OUTCOMES.has(outcome)) {
      return { ok: false, rows: [], error: `检索尝试 ${String(index + 1)} 的结论不受支持：${outcome || '未提供'}` }
    }
    const runId = text(identity.runId)
    const taskId = text(item.taskId)
      || `${runId === '' ? 'run' : runId}:${String(identity.revision)}:retrieval:${String(index + 1)}`
    rows.push({
      taskId,
      caseId: text(item.caseId),
      providerId: text(item.providerId) || text(item.provider),
      stage,
      outcome,
      finalUrl: text(item.finalUrl) || text(item.url),
      reasonCode: text(item.reasonCode) || text(item.reason) || text(item.errorKind),
    })
  }
  return { ok: true, rows }
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
}

const WORKFLOW_KNOWLEDGE_REF_FORMAT = 'crwu.valuation.knowledge-ref.v1'

/**
 * Explicit verified-workflow snapshot ref: only the real identity, path, digest and body
 * survive. Unknown library/updatedAt/snapshot metadata stays absent instead of being invented;
 * the native builder re-verifies the body SHA before any ref can reach the report.
 */
function workflowKnowledgeRef(ref: JsonRecord): JsonRecord {
  const record: JsonRecord = {
    format: WORKFLOW_KNOWLEDGE_REF_FORMAT,
    sourceId: text(ref.sourceId),
    path: text(ref.path),
    digest: text(ref.digest),
    body: typeof ref.body === 'string' ? ref.body : '',
  }
  const spaceName = text(ref.spaceName)
  if (spaceName !== '') record.spaceName = spaceName
  const section = text(ref.section)
  if (section !== '') record.section = section
  const quote = text(ref.quote)
  if (quote !== '') record.quote = quote
  return record
}

const IMAGE_DIR = '推理结果/图片/'

/** Only a real PNG reference under the evidence image directory may reach the builder. */
function safeImagePath(value: string): boolean {
  if (value === '' || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  return value.startsWith(IMAGE_DIR) && /\.png$/i.test(value)
}

/** An accepted plan must actually be the ready, user-adopted listing-reference plan. */
function acceptedPlanProblem(plan: JsonRecord, requestRevision: number): string {
  if (plan.accepted !== true) return '预检方案尚未被用户采纳'
  if (plan.ready !== true) return '预检方案尚未就绪'
  if (text(plan.method) !== 'market') return '预检方案的方法不是市场法'
  if (text(plan.valuationMode) !== 'listing-reference') return '预检方案不是挂牌参考口径'
  if (text(plan.algorithm) !== 'raw-unit-price-arithmetic-mean') {
    return '预检方案的算法不是原始挂牌单价算术平均'
  }
  const revision = plan.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return '预检方案缺少有效的修订号'
  }
  if (revision > requestRevision) return '预检方案的修订号晚于本轮请求'
  return ''
}

export function buildWorkflowListingPayload(input: unknown): WorkflowListingPayloadResult {
  const fail = (error: string): WorkflowListingPayloadResult => ({ ok: false, error })
  if (!isRecord(input)) return fail('固定挂牌参考输入必须是对象')

  const projectId = text(input.projectId)
  const planId = text(input.planId)
  const inputDigest = text(input.inputDigest)
  if (projectId === '' || planId === '' || inputDigest === '') {
    return fail('固定输入缺少 projectId / planId / inputDigest')
  }

  const request = isRecord(input.request) ? input.request : null
  if (request === null) return fail('固定输入缺少本轮估值请求')
  const assessment = isRecord(request.assessment) ? request.assessment : null
  if (assessment === null) return fail('本轮估值请求缺少已采纳的评估上下文')
  const plan = isRecord(assessment.plan) ? assessment.plan : null
  if (plan === null) return fail('本轮估值请求缺少已采纳的预检方案')
  const requestRevision = typeof request.revision === 'number' ? request.revision : Number.NaN
  if (!Number.isFinite(requestRevision)) return fail('本轮估值请求的修订号无效')
  const planProblem = acceptedPlanProblem(plan, requestRevision)
  if (planProblem !== '') return fail(planProblem)

  const rawTemplate = isRecord(plan.template) ? plan.template : null
  if (rawTemplate === null) return fail('预检方案缺少受控计算模板')
  if (rawTemplate.verified !== true) return fail('预检方案的计算模板尚未验真')
  const templateFileName = text(rawTemplate.fileName)
  const templateDigest = text(rawTemplate.digest)
  const templateRelativePath = text(rawTemplate.relativePath)
  if (templateFileName === '' || templateDigest === '' || templateRelativePath === '') {
    return fail('预检方案的计算模板缺少文件名、相对路径或摘要')
  }
  const planPrefix = `方案/${planId}/`
  const normalizedTemplatePath = templateRelativePath.startsWith(planPrefix)
    ? templateRelativePath.slice(planPrefix.length)
    : templateRelativePath
  if (normalizedTemplatePath === '') return fail('预检方案的计算模板相对路径无效')

  const subject = isRecord(request.subject) ? request.subject : {}
  const useLabel = text(subject.useLabel)
  const purpose = text(subject.purpose)
  const baseDateValue = text(subject.baseDate)
  const areaSqm = positiveNumber(request.areaSqm)
  if (areaSqm === null) return fail('固定输入缺少有效的建筑面积')

  const knowledge = (Array.isArray(request.knowledge) ? request.knowledge : []).filter(isRecord)
  const knowledgeIndex = new Map<string, JsonRecord>()
  for (const ref of knowledge) {
    const sourceId = text(ref.sourceId)
    if (sourceId !== '' && !knowledgeIndex.has(sourceId)) knowledgeIndex.set(sourceId, ref)
  }

  const observations = (Array.isArray(input.observations) ? input.observations : []).filter(isRecord)
  const observationIndex = new Map<string, JsonRecord>()
  for (const observation of observations) {
    const sourceId = text(observation.sourceId)
    if (sourceId === '') return fail('Host 观察样本缺少来源标识')
    if (observationIndex.has(sourceId)) return fail(`Host 观察样本重复：${sourceId}`)
    observationIndex.set(sourceId, observation)
  }

  const assessments = (Array.isArray(input.assessments) ? input.assessments : []).filter(isRecord)
  const assessmentIndex = new Map<string, JsonRecord>()
  for (const item of assessments) {
    const sourceId = text(item.sourceId)
    if (sourceId === '') return fail('适用性评估缺少来源标识')
    if (assessmentIndex.has(sourceId)) return fail(`来源 ${sourceId} 出现了多条适用性评估`)
    assessmentIndex.set(sourceId, item)
  }

  const samples = Array.isArray(request.samples) ? request.samples : []
  if (samples.length === 0) return fail('本轮估值请求没有选择任何挂牌案例')

  const cases: JsonRecord[] = []
  const caseEvidence: JsonRecord[] = []
  const referenceCaseIds: string[] = []
  const limitations: string[] = []
  const boundQuotes: string[] = []
  const seenSourceIds = new Set<string>()
  const seenCanonicalUrls = new Set<string>()
  const seenCaseIds = new Set<string>()

  for (const rawSample of samples) {
    if (!isRecord(rawSample)) return fail('选中的挂牌案例不是对象')
    const sourceId = text(rawSample.sourceId)
    if (sourceId === '') return fail('选中的挂牌案例缺少来源标识')
    if (seenSourceIds.has(sourceId)) return fail(`选中的挂牌案例重复：${sourceId}`)
    seenSourceIds.add(sourceId)

    const observation = observationIndex.get(sourceId)
    if (observation === undefined) return fail(`选中来源 ${sourceId} 不在本轮 Host 观察到的来源池里`)
    const hostPrice = positiveNumber(observation.unitPrice)
    if (hostPrice === null) return fail(`Host 观察样本 ${sourceId} 没有有效的正数单价`)
    if (rawSample.unitPrice !== observation.unitPrice) {
      return fail(`选中来源 ${sourceId} 申报的价格与 Host 观察值不一致`)
    }

    const declaredKind = text(observation.listingKind)
    if (declaredKind !== '' && declaredKind !== 'listing') {
      return fail(`选中来源 ${sourceId} 不是实际挂牌案例`)
    }
    if (listingKindOf(observation.transactionType) !== 'listing') {
      return fail(`选中来源 ${sourceId} 的交易性质不是挂牌`)
    }

    const rawUrl = text(observation.sourceUrl)
    const urlProblem = httpUrlProblem(rawUrl)
    if (urlProblem !== '') return fail(`选中来源 ${sourceId} 的来源地址不可用：${urlProblem}`)
    const canonical = canonicalListingUrl(rawUrl)
    if (canonical === '') return fail(`选中来源 ${sourceId} 缺少可核对的来源地址`)
    if (seenCanonicalUrls.has(canonical)) return fail(`选中的挂牌案例来源地址重复：${rawUrl}`)
    seenCanonicalUrls.add(canonical)

    const capturedAt = text(observation.capturedAt)
    if (!isIsoDateTime(capturedAt)) return fail(`选中来源 ${sourceId} 缺少真实的抓取时间`)

    const found = assessmentIndex.get(sourceId)
    if (found === undefined) return fail(`选中来源 ${sourceId} 没有适用性评估`)
    if (text(found.status) !== 'qualified') return fail(`选中来源 ${sourceId} 的适用性评估不是 qualified`)
    const reason = text(found.reason)
    if (reason === '') return fail(`选中来源 ${sourceId} 的适用性评估缺少理由`)
    const knowledgeClaim = isRecord(found.knowledge) ? found.knowledge : null
    if (knowledgeClaim === null) return fail(`选中来源 ${sourceId} 的适用性评估缺少知识依据`)
    const claimSourceId = text(knowledgeClaim.sourceId)
    const claimDigest = text(knowledgeClaim.digest)
    const claimQuote = text(knowledgeClaim.quote)
    const verifiedRef = knowledgeIndex.get(claimSourceId)
    if (verifiedRef === undefined) return fail(`选中来源 ${sourceId} 引用了不在本轮任务包里的知识来源`)
    if (claimDigest === '' || text(verifiedRef.digest) !== claimDigest) {
      return fail(`选中来源 ${sourceId} 的知识依据摘要与已验真来源不一致`)
    }
    const body = typeof verifiedRef.body === 'string' ? verifiedRef.body : ''
    if (claimQuote === '' || !body.includes(claimQuote)) {
      return fail(`选中来源 ${sourceId} 的知识依据原文不在已验真正文里`)
    }

    const explicitCaseId = text(observation.caseId)
    const caseId = explicitCaseId !== '' ? explicitCaseId : `listing-${stableHash(sourceId)}`
    if (seenCaseIds.has(caseId)) return fail(`选中的挂牌案例编号重复：${caseId}`)
    seenCaseIds.add(caseId)
    referenceCaseIds.push(caseId)
    boundQuotes.push(claimQuote)

    const knowledgeSection = text(verifiedRef.section)
    const knowledgePath = text(verifiedRef.path)
    const caseRecord: JsonRecord = {
      caseId,
      transactionType: text(observation.transactionType) || '挂牌',
      unitPrice: hostPrice,
      currency: 'CNY',
      unitPriceUnit: 'CNY/m2',
      sourceUrl: canonical,
      capturedAt,
      referenceAssessment: {
        status: 'qualified',
        reason,
        knowledgeRef: `wiki:${knowledgePath}${knowledgeSection === '' ? '' : `#${knowledgeSection}`}`,
      },
    }
    // Observation metadata is preserved for review only; controlled price/source fields win.
    for (const key of ['community', 'propertyType', 'propertyNature', 'provider', 'priceSource']) {
      const value = observation[key]
      if (value !== undefined) caseRecord[key] = cloneJson(value)
    }
    cases.push(caseRecord)

    const screenshot = text(observation.screenshot)
    const screenshotDigest = text(observation.screenshotDigest)
    if (screenshot === '' || screenshotDigest === '') {
      limitations.push(`以下挂牌案例没有可核对截图证据（screenshot_missing）：${caseId}`)
      continue
    }
    if (!safeImagePath(screenshot)) {
      return fail(`选中来源 ${sourceId} 的截图路径不安全，拒绝交给固定构建器`)
    }
    caseEvidence.push({
      caseId,
      displayName: text(observation.community) || caseId,
      provider: text(observation.provider),
      sourceUrl: canonical,
      relativePath: screenshot,
      digest: screenshotDigest,
      capturedAt,
      evidenceType: 'detail-screenshot',
    })
  }

  const planBasis = (Array.isArray(plan.basis) ? plan.basis : []).filter(isRecord)
  const basisQuotes: string[] = []
  for (const item of planBasis) {
    const quote = text(item.quote)
    if (quote !== '') basisQuotes.push(quote)
  }
  if (basisQuotes.length === 0) {
    for (const quote of boundQuotes) {
      if (!basisQuotes.includes(quote)) basisQuotes.push(quote)
    }
  }
  if (basisQuotes.length === 0) return fail('预检方案没有可用的比较口径依据')

  const planLimitations = (Array.isArray(plan.limitations) ? plan.limitations : [])
    .map((line) => text(line))
    .filter((line) => line !== '')
  for (const line of planLimitations) limitations.push(line)

  const retrieval = normalizeRetrievalAttempts(assessment.retrievalAttempts, {
    runId: text(request.runId),
    revision: requestRevision,
  })
  if (!retrieval.ok) return fail(retrieval.error ?? '检索尝试无法归一化')

  const methodRequest = text(input.methodRequest) || 'market'
  const valueTypeText = text(input.valueType)
  const valueType = valueTypeText === '' ? null : valueTypeText
  const supplementalPrompt = text(input.supplementalPrompt)

  const objectRecord: JsonRecord = {
    objectId: text(request.objectId),
    displayName: useLabel || text(request.objectId),
    buildingArea: areaSqm,
    currency: 'CNY',
    referenceCaseIds,
  }
  if (useLabel !== '') objectRecord.propertyType = useLabel
  const valueScope = text(request.valueScope)
  if (valueScope !== '') objectRecord.valueScope = valueScope

  const payload: JsonRecord = {
    valuationMode: 'listing-reference',
    projectId,
    planId,
    inputDigest,
    referencePolicy: {
      aggregation: 'arithmetic-mean',
      rounding: { mode: 'half-up', digits: 2 },
      basis: [...new Set(basisQuotes)].join('；'),
    },
    objects: [objectRecord],
    cases,
    caseEvidence,
    materials: cloneJson(Array.isArray(input.materials) ? input.materials : []),
    knowledgeSources: knowledge.map(workflowKnowledgeRef),
    retrievalAttempts: retrieval.rows,
    template: {
      fileName: templateFileName,
      relativePath: normalizedTemplatePath,
      digest: templateDigest,
      verified: true,
      mapping: cloneJson(Array.isArray(rawTemplate.mapping) ? rawTemplate.mapping : []),
      formulaChecks: cloneJson(Array.isArray(rawTemplate.formulaChecks) ? rawTemplate.formulaChecks : []),
    },
    status: 'partial',
    methodRequest,
    purpose,
    baseDate: baseDateValue === '' ? null : baseDateValue,
    valueType,
    supplementalPrompt,
    limitations,
  }
  const generatedAt = text(input.generatedAt)
  if (generatedAt !== '') payload.generatedAt = generatedAt
  return { ok: true, payload }
}
