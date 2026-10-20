/**
 * Host adapter for source-backed market planning and durable evidence reuse.
 *
 * Planning binds the isolated planning-selection candidate to the actual admitted
 * materials, verified knowledge and registered catalogs before any business IO. It
 * then preflights the selected providers serially, keeps one honest receipt per
 * provider, and verifies a detail page through the narrow capture tool before the
 * template is prepared. Evidence acquisition reconstitutes the already-observed
 * samples from the user-approved plan only, so an adapter restart with plain JSON
 * needs no private in-memory cache and never re-searches.
 */
import type {
  ValuationEvidenceAcquireRequest,
  ValuationEvidenceAcquireResult,
  ValuationEvidencePort,
  ValuationObservedSample,
  ValuationPlanningPort,
  ValuationPlanningRequest,
  ValuationPlanningResult,
} from '../../domains/report-evaluation/workflow/ports.ts'
import type { ValuationKnowledgeRef } from '../../domains/report-evaluation/workflow/ports.ts'
import {
  bindWorkflowPlanningSelection,
  type WorkflowPlanningSelection,
  type WorkflowPlanningSelectionContext,
} from '../../domains/report-evaluation/workflow/planning-selection.ts'
import { canonicalListingUrl } from '../../domains/report-evaluation/market/candidates.ts'
import type {
  ValuationWorkflowPlanSource,
  ValuationWorkflowPlanTemplate,
} from '../../../shared/contracts/valuation-workflow.ts'

const MARKET_SEARCH_TOOL = 'crwu_valuation_market_search'
const MARKET_CAPTURE_TOOL = 'crwu_valuation_market_capture'
const PREFLIGHT_MAX_PAGES = 1
const MAX_DETAIL_PROBES = 3
const PLAN_METHOD = 'market'
const PLAN_ALGORITHM = 'raw-unit-price-arithmetic-mean'

export interface WorkflowMarketDispatchResult {
  ok: boolean
  errorKind?: string
  error?: string
  value?: unknown
}

export interface WorkflowMarketSelectResult {
  ok: boolean
  outputs?: Record<string, unknown>
  sessionId?: string
  errorKind?: string
  error?: string
}

export interface WorkflowMarketSelectInput {
  request: ValuationPlanningRequest
  materials: ValuationPlanningRequest['materials']
  userInput: string
  knowledge: ValuationKnowledgeRef[]
  allowedProviderIds: readonly string[]
  allowedTemplatePaths: readonly string[]
  promptSupplement: string
}

export interface WorkflowMarketPrepareTemplateInput {
  request: ValuationPlanningRequest
  selection: WorkflowPlanningSelection
  sources: ValuationWorkflowPlanSource[]
}

export interface WorkflowMarketTemplateResult {
  ok: boolean
  template?: ValuationWorkflowPlanTemplate
  limitations?: string[]
  error?: string
}

export interface CreateWorkflowMarketPortsOptions {
  casePath: string
  planId: string
  allowedProviderIds: readonly string[]
  allowedTemplatePaths: readonly string[]
  select: (input: WorkflowMarketSelectInput) => Promise<WorkflowMarketSelectResult>
  prepareTemplate: (input: WorkflowMarketPrepareTemplateInput) => Promise<WorkflowMarketTemplateResult>
  dispatch: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<WorkflowMarketDispatchResult>
}

export interface WorkflowMarketPorts {
  planning: ValuationPlanningPort
  evidence: ValuationEvidencePort
}

type JsonRecord = Record<string, unknown>

interface VerifiedCapture {
  file: string
  digest: string
  bytes: number
  status: number
  sourceUrl: string
  screenshot: string
  screenshotDigest: string
  raw: JsonRecord
}

interface VerifiedFacts {
  providerId: string
  row: JsonRecord
  capture: VerifiedCapture
}

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

function listingKindOf(transactionType: string): string {
  const value = transactionType.trim().toLowerCase()
  if (value === 'listing' || value === '挂牌') return 'listing'
  if (value === 'deal' || value === 'sold' || value === '成交') return 'deal'
  return value === '' ? '' : 'other'
}

function failureSource(providerId: string, reason: string): ValuationWorkflowPlanSource {
  return {
    providerId,
    state: 'unverified',
    community: '',
    detailUrl: '',
    fields: { unitPrice: null, areaSqm: null },
    transactionType: '',
    evidence: '',
    reason: reason === '' ? '来源未返回可用结果' : reason,
  }
}

const MAX_DIAGNOSTIC_FACTS = 8
const MAX_DIAGNOSTIC_LENGTH = 240

/** Bound one sanitized tool fact so diagnostics stay actionable and never dump raw objects. */
function boundedFact(value: unknown): string {
  if (typeof value !== 'string') return ''
  const line = value.trim().replace(/\s+/g, ' ')
  return line.length > MAX_DIAGNOSTIC_LENGTH ? `${line.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : line
}

function capabilityGapFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const facts: string[] = []
  for (const entry of value) {
    const line = boundedFact(entry)
    if (line !== '' && !facts.includes(line)) facts.push(line)
    if (facts.length >= 4) break
  }
  return facts
}

/** The receipt for this provider only; other providers' facts never stand in for it. */
function matchingProviderReport(value: JsonRecord, providerId: string): JsonRecord | null {
  if (!Array.isArray(value.providers)) return null
  for (const entry of value.providers) {
    if (isRecord(entry) && text(entry.id) === providerId) return entry
  }
  return null
}

function providerRecoveryFacts(value: JsonRecord, providerId: string): string[] {
  const report = matchingProviderReport(value, providerId)
  if (report === null) return []
  const facts: string[] = []
  const detail = boundedFact(report.detail)
  if (detail !== '') facts.push(`来源说明：${detail}`)
  const nextAction = boundedFact(report.nextAction)
  if (nextAction !== '') facts.push(`来源恢复动作：${nextAction}`)
  const retrievalTaskId = boundedFact(report.retrievalTaskId)
  if (retrievalTaskId !== '') facts.push(`来源取数任务：${retrievalTaskId}`)
  if (Array.isArray(report.notes)) {
    for (const note of report.notes.slice(0, 3)) {
      const line = boundedFact(note)
      if (line !== '') facts.push(`来源观察：${line}`)
    }
  }
  return facts
}

/** Safe capability/recovery facts carried by the actual tool receipt, bounded and deduped. */
function searchDiagnosticFacts(value: JsonRecord, providerId: string): string[] {
  const facts = capabilityGapFacts(value.capabilityGaps)
  for (const fact of providerRecoveryFacts(value, providerId)) {
    if (facts.length >= MAX_DIAGNOSTIC_FACTS) break
    if (!facts.includes(fact)) facts.push(fact)
  }
  return facts
}

function verifiedSource(
  providerId: string,
  row: JsonRecord,
  capture: VerifiedCapture,
  selection: WorkflowPlanningSelection,
  request: ValuationPlanningRequest,
): ValuationWorkflowPlanSource {
  const url = canonicalListingUrl(row.url)
  const unitPrice = positiveNumber(row.unit_price)
  const areaSqm = positiveNumber(row.building_area)
  return {
    providerId,
    providerLabel: text(row.source_label) || providerId,
    state: 'verified',
    community: text(row.community),
    detailUrl: url,
    fields: {
      unitPrice,
      areaSqm,
      priceSource: 'list-row',
      rawUnitPrice: row.unit_price ?? null,
      rawAreaSqm: row.building_area ?? null,
      listingCommunity: text(row.community),
      propertyNature: text(row.property_nature),
      // Material/user place refs stay on the source; only verified KB refs become plan basis.
      selection: cloneJson(selection),
      // Exact confirmed planning context, so phase 2 re-binds from the same saved user input.
      planningContext: {
        userInput: text(request.userInput),
        promptSupplement: text(request.promptSupplement),
      },
      observed: { row: cloneJson(row), capture: cloneJson(capture.raw) },
    },
    transactionType: text(row.transaction_type) || 'listing',
    evidence: capture.file,
    sourceId: `${providerId}:${url}`,
    sourceUrl: url,
    capturedAt: text(row.captured_at),
    screenshot: capture.screenshot,
    screenshotDigest: capture.screenshotDigest,
    screenshotMissing: capture.screenshot === '',
    evidenceMissing: false,
    listEvidence: text(row.evidence),
  }
}

function parseCapture(value: unknown): VerifiedCapture | null {
  if (!isRecord(value) || value.ok !== true) return null
  const status = positiveNumber(value.status)
  const bytes = positiveNumber(value.bytes)
  const file = text(value.file)
  const digest = text(value.digest)
  const sourceUrl = text(value.sourceUrl)
  if (status === null || !Number.isInteger(status) || status < 200 || status > 299) return null
  if (bytes === null || file === '' || digest === '' || sourceUrl === '') return null
  return {
    file,
    digest,
    bytes,
    status,
    sourceUrl,
    screenshot: text(value.screenshot),
    screenshotDigest: text(value.screenshotDigest),
    raw: cloneJson(value),
  }
}

/**
 * Effective user-source context for the planning-selection binder.
 *
 * The confirmed user input and the plan-node supplement are both real user context;
 * a location correction typed into the plan node must be provable by the binder.
 */
function planningUserInputOf(request: ValuationPlanningRequest): string {
  return [text(request.userInput), text(request.promptSupplement)]
    .filter((part) => part !== '')
    .join('\n')
}

function bindContextOf(
  request: ValuationPlanningRequest,
  allowedProviderIds: readonly string[],
  allowedTemplatePaths: readonly string[],
): WorkflowPlanningSelectionContext {
  return {
    userInput: planningUserInputOf(request),
    materials: (request.materials ?? []).map((material) => ({
      materialId: material.materialId,
      fileName: material.fileName,
      digest: material.digest,
      ...(material.text === undefined ? {} : { text: material.text }),
    })),
    knowledge: (request.knowledge ?? []).map((source) => ({
      sourceId: source.sourceId,
      ...(source.body === undefined ? {} : { body: source.body }),
    })),
    allowedProviderIds,
    allowedTemplatePaths,
  }
}

/** Plan basis may only cite verified knowledge bodies; place refs stay on the source. */
function planBasisFrom(
  selection: WorkflowPlanningSelection,
  knowledge: readonly ValuationKnowledgeRef[],
): Array<Record<string, unknown>> {
  const bodies = new Map<string, string>()
  for (const source of knowledge) {
    if (typeof source.body === 'string') bodies.set(source.sourceId, source.body)
  }
  const basis: Array<Record<string, unknown>> = []
  for (const item of selection.basis) {
    const body = bodies.get(item.sourceId)
    if (body === undefined || !body.includes(item.quote)) continue
    basis.push({ field: item.field, sourceId: item.sourceId, quote: item.quote })
  }
  return basis
}

function preflightLimitations(callbackLimitations: readonly string[]): string[] {
  return [
    ...callbackLimitations.filter((line) => line.trim() !== ''),
    '来源为公开挂牌信息，价格口径为挂牌参考，不是成交价',
    '未按面积、楼层、朝向等差异修正，仅供后续参考比对',
  ]
}

/** Durable observed samples reconstructed from an approved plan, never re-searched. */
function samplesFromApprovedPlan(
  plan: NonNullable<ValuationEvidenceAcquireRequest['plan']>,
  requestRevision: number,
): ValuationEvidenceAcquireResult {
  if (plan.accepted !== true || plan.ready !== true) {
    return { ok: false, error: '证据获取需要用户已采纳的预检方案' }
  }
  if (typeof plan.revision === 'number' && plan.revision > requestRevision) {
    return { ok: false, error: '预检方案修订号晚于当前请求，拒绝越界采纳' }
  }
  const samples: ValuationObservedSample[] = []
  for (const source of plan.sources) {
    if (source.state !== 'verified') continue
    const providerId = text(source.providerId)
    const fields = isRecord(source.fields) ? source.fields : null
    const observed = fields !== null && isRecord(fields.observed) ? fields.observed : null
    if (providerId === '' || fields === null || observed === null) continue
    const row = isRecord(observed.row) ? observed.row : null
    const capture = parseCapture(observed.capture)
    if (row === null || capture === null) continue
    // Re-derive every reported fact from the digest-bound observation; mutable
    // top-level aliases may have been rewritten after approval and are ignored.
    const canonicalUrl = canonicalListingUrl(row.url)
    if (
      canonicalUrl === ''
      || canonicalUrl !== canonicalListingUrl(capture.sourceUrl)
      || canonicalUrl !== canonicalListingUrl(source.detailUrl)
    ) continue
    if (text(row.source) !== providerId) continue
    if (listingKindOf(text(row.transaction_type)) !== 'listing') continue
    const unitPrice = positiveNumber(row.unit_price)
    const areaSqm = positiveNumber(row.building_area)
    if (unitPrice === null || areaSqm === null) continue
    if (unitPrice !== positiveNumber(source.fields?.unitPrice)) continue
    if (areaSqm !== positiveNumber(source.fields?.areaSqm)) continue
    const screenshot = capture.screenshot
    const screenshotDigest = capture.screenshotDigest
    const hasScreenshot = screenshot !== '' && screenshotDigest !== ''
    samples.push({
      sourceId: `${providerId}:${canonicalUrl}`,
      caseId: text(row.caseId) || text(row.case_id) || `${providerId}:${canonicalUrl}`,
      provider: providerId,
      unitPrice,
      areaSqm,
      listingKind: 'listing',
      community: text(row.community),
      propertyNature: text(row.property_nature),
      sourceUrl: canonicalUrl,
      transactionType: text(row.transaction_type),
      capturedAt: text(row.captured_at),
      evidence: capture.file,
      digest: capture.digest,
      bytes: capture.bytes,
      screenshot: hasScreenshot ? screenshot : '',
      screenshotDigest: hasScreenshot ? screenshotDigest : '',
      screenshotMissing: !hasScreenshot,
      priceSource: 'list-row',
    })
  }
  if (samples.length === 0) {
    return { ok: false, error: '预检方案没有可核对的实际挂牌案例' }
  }
  return { ok: true, samples, retrievalAttempts: [] }
}

export function createWorkflowMarketPorts(options: CreateWorkflowMarketPortsOptions): WorkflowMarketPorts {
  const planning: ValuationPlanningPort = {
    async prepare(request: ValuationPlanningRequest): Promise<ValuationPlanningResult> {
      const selectionInput: WorkflowMarketSelectInput = {
        request,
        materials: request.materials ?? [],
        userInput: planningUserInputOf(request),
        knowledge: request.knowledge ?? [],
        allowedProviderIds: options.allowedProviderIds,
        allowedTemplatePaths: options.allowedTemplatePaths,
        promptSupplement: request.promptSupplement ?? '',
      }
      let selected: WorkflowMarketSelectResult
      try {
        selected = await options.select(selectionInput)
      } catch {
        return { ok: false, errorKind: 'failed', error: '规划选择子会话调用失败', gaps: ['规划选择子会话调用失败'] }
      }
      if (!selected.ok) {
        const error = selected.error ?? '规划选择子会话没有返回可用结果'
        return {
          ok: false,
          errorKind: selected.errorKind ?? 'failed',
          error,
          ...(selected.sessionId === undefined ? {} : { sessionId: selected.sessionId }),
          gaps: [error],
        }
      }
      if (selected.outputs === undefined) {
        const error = '规划选择子会话没有返回结构化结果'
        return { ok: false, errorKind: 'failed', error, gaps: [error] }
      }

      const bound = bindWorkflowPlanningSelection(
        selected.outputs,
        bindContextOf(request, options.allowedProviderIds, options.allowedTemplatePaths),
      )
      if (!bound.ok) {
        return {
          ok: false,
          errorKind: 'failed',
          error: bound.error,
          ...(bound.questions === undefined ? {} : { questions: bound.questions.map((question) => ({ ...question })) }),
          gaps: [bound.error, ...(bound.questions ?? []).map((question) => `${question.field}: ${question.prompt}`)],
        }
      }
      const selection = bound.selection

      const sources: ValuationWorkflowPlanSource[] = []
      let verified: VerifiedFacts | null = null
      let probes = 0
      const wanted = new Set([selection.community, ...selection.nearbyCommunities])

      for (const providerId of selection.providerOrder) {
        if (verified !== null) break
        let search: WorkflowMarketDispatchResult | undefined
        try {
          search = await options.dispatch(MARKET_SEARCH_TOOL, {
            caseDir: options.casePath,
            planId: options.planId,
            city: selection.city,
            keyword: selection.community,
            providers: [providerId],
            propertyType: request.object.useLabel,
            method: PLAN_METHOD,
            maxPages: PREFLIGHT_MAX_PAGES,
          }, request.signal)
        } catch {
          sources.push(failureSource(providerId, '渠道检索调用失败'))
          continue
        }
        if (search === undefined) {
          sources.push(failureSource(providerId, '渠道检索调用失败'))
          continue
        }
        const searchValue = isRecord(search.value) ? search.value : {}
        if (!search.ok || searchValue.ok !== true) {
          const failureReason = text(searchValue.error) || search.error || '渠道未返回可用结果'
          const diagnostics = searchDiagnosticFacts(searchValue, providerId)
          sources.push(failureSource(
            providerId,
            diagnostics.length > 0 ? `${failureReason}；${diagnostics.join('；')}` : failureReason,
          ))
          continue
        }
        const rows = Array.isArray(searchValue.cases) ? searchValue.cases.filter(isRecord) : []
        const candidates = rows.filter((row) => {
          if (canonicalListingUrl(row.url) === '') return false
          if (text(row.source) !== providerId) return false
          if (!wanted.has(text(row.community))) return false
          if (listingKindOf(text(row.transaction_type)) !== 'listing') return false
          return positiveNumber(row.unit_price) !== null && positiveNumber(row.building_area) !== null
        })
        if (candidates.length === 0) {
          // Keep the tool's own capability/recovery receipt instead of overwriting it with a
          // blanket "no matching listings" claim the search never made.
          const diagnostics = searchDiagnosticFacts(searchValue, providerId)
          sources.push(failureSource(
            providerId,
            diagnostics.length > 0
              ? diagnostics.join('；')
              : '没有匹配所选小区且带有效价格/面积的实际挂牌案例',
          ))
          continue
        }
        let captured = false
        for (const row of candidates) {
          if (probes >= MAX_DETAIL_PROBES) break
          probes += 1
          const url = canonicalListingUrl(row.url)
          let capture: WorkflowMarketDispatchResult | undefined
          try {
            capture = await options.dispatch(MARKET_CAPTURE_TOOL, {
              caseDir: options.casePath,
              planId: options.planId,
              source: providerId,
              url,
              caseId: `${providerId}:${url}`,
              displayName: text(row.title),
            }, request.signal)
          } catch {
            break
          }
          const parsed = capture !== undefined && capture.ok ? parseCapture(capture.value) : null
          if (parsed === null || canonicalListingUrl(parsed.sourceUrl) !== url) break
          verified = { providerId, row, capture: parsed }
          sources.push(verifiedSource(providerId, row, parsed, selection, request))
          captured = true
          break
        }
        if (!captured && verified === null) {
          sources.push(failureSource(providerId, '详情证据未通过核对：无有效状态、字节或地址不一致'))
        }
      }

      if (verified === null) {
        const error = '没有取得匹配所选小区且带实际正数价格/面积的已验真挂牌来源'
        return {
          ok: false,
          errorKind: 'failed',
          error,
          gaps: [error, ...sources.map((source) => `${source.providerId}: ${text(source.reason)}`)],
          plan: {
            method: PLAN_METHOD,
            valuationMode: 'listing-reference',
            algorithm: PLAN_ALGORITHM,
            sources,
            basis: planBasisFrom(selection, request.knowledge ?? []),
            limitations: preflightLimitations([]),
          },
        }
      }

      let templateResult: WorkflowMarketTemplateResult
      try {
        templateResult = await options.prepareTemplate({ request, selection, sources })
      } catch {
        return { ok: false, errorKind: 'failed', error: '模板核对失败', gaps: ['模板核对失败'] }
      }
      if (!templateResult.ok || templateResult.template === undefined) {
        const error = templateResult.error ?? '模板核对没有返回可用模板'
        return { ok: false, errorKind: 'failed', error, gaps: [error] }
      }

      const plan = {
        method: PLAN_METHOD,
        valuationMode: 'listing-reference',
        algorithm: PLAN_ALGORITHM,
        sources,
        // Callback template object is adopted unchanged.
        template: templateResult.template,
        basis: planBasisFrom(selection, request.knowledge ?? []),
        limitations: preflightLimitations(templateResult.limitations ?? []),
      }
      return { ok: true, plan, gaps: [] }
    },
  }

  const evidence: ValuationEvidencePort = {
    async acquire(input: ValuationEvidenceAcquireRequest): Promise<ValuationEvidenceAcquireResult> {
      const plan = input.plan
      if (plan === undefined) {
        return { ok: false, error: '证据获取需要已采纳的预检方案' }
      }
      return samplesFromApprovedPlan(plan, input.revision)
    },
  }

  return { planning, evidence }
}
