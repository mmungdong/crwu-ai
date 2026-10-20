/**
 * Production evidence acquisition for the listing-reference workflow.
 *
 * Planning already observed and digest-bound one verified detail. This adapter admits
 * that approved plan through the real preflight evidence port, re-binds the saved
 * place/provider/template selection against the actual request inputs, then reuses the
 * same provider search so the native list ledger cache is hit, and captures a small
 * technical number of extra details. It never re-searches the whole web, never invents
 * facts, and never lets a failed extra capture erase the verified baseline.
 */
import { text } from '../../../../shared/utils/value.ts'
import type {
  ValuationEvidenceAcquireRequest,
  ValuationEvidenceAcquireResult,
  ValuationEvidencePort,
  ValuationEvidenceRetrievalAttempt,
  ValuationObservedSample,
} from '../../../domains/report-evaluation/workflow/ports.ts'
import {
  bindWorkflowPlanningSelection,
  type WorkflowPlanningSelectionContext,
} from '../../../domains/report-evaluation/workflow/planning-selection.ts'
import { canonicalListingUrl } from '../../../domains/report-evaluation/market/candidates.ts'
import type { WorkflowMarketDispatchResult } from '../market.ts'

const MARKET_SEARCH_TOOL = 'crwu_valuation_market_search'
const MARKET_CAPTURE_TOOL = 'crwu_valuation_market_capture'
const PLAN_METHOD = 'market'
const SEARCH_MAX_PAGES = 1
const DEFAULT_MAX_DETAIL_CASES = 3
const ABSOLUTE_MAX_DETAIL_CASES = 20
/** Technical cap on extra detail capture attempts, separate from the successful-sample cap. */
const MAX_ADDITIONAL_CAPTURE_ATTEMPTS = 20
const CANCELLED_ERROR = '本次证据获取已被取消'
const REPLAN_REQUIRED = '已采纳方案的地点选择与实际输入不再一致，请重新规划来源'
const SEARCH_FAILED_REASON = '渠道检索调用失败'
const DETAIL_UNVERIFIED_REASON = '详情证据未通过核对：无有效状态、字节或地址不一致'

type JsonRecord = Record<string, unknown>

interface ExecutionVerifiedSource {
  providerId: string
  selection: JsonRecord
  /** Exact confirmed planning context saved with the approved plan, when present. */
  planningContext: JsonRecord | null
}

interface VerifiedCapture {
  file: string
  digest: string
  bytes: number
  status: number
  sourceUrl: string
  screenshot: string
  screenshotDigest: string
}

export interface CreateWorkflowExecutionEvidencePortOptions {
  casePath: string
  planId: string
  /** Real phase-1 preflight evidence port; admits the approved plan and its observed samples. */
  approvedEvidence: ValuationEvidencePort
  allowedProviderIds: readonly string[]
  /**
   * Registered template catalog. Real composition passes the same catalog used by planning;
   * legacy wiring without one falls back to the saved selection path.
   */
  allowedTemplatePaths?: readonly string[]
  /** Technical detail-case cap (baseline included); never a business minimum. */
  maxDetailCases?: number
  dispatch: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<WorkflowMarketDispatchResult>
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Avoids property narrowing on `signal.aborted` across awaits (repeated `=== true` checks). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
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
  }
}

function verifiedSourceOf(sources: unknown): ExecutionVerifiedSource | null {
  if (!Array.isArray(sources)) return null
  for (const source of sources) {
    if (!isRecord(source) || text(source.state) !== 'verified') continue
    const providerId = text(source.providerId)
    const fields = isRecord(source.fields) ? source.fields : null
    const selection = fields !== null && isRecord(fields.selection) ? fields.selection : null
    if (providerId === '' || selection === null) continue
    const planningContext = fields !== null && isRecord(fields.planningContext) ? fields.planningContext : null
    return {
      providerId,
      selection: cloneJson(selection),
      planningContext: planningContext === null ? null : cloneJson(planningContext),
    }
  }
  return null
}

/**
 * Rebuild the effective user-source context from the approved plan.
 *
 * A saved planning context must still describe the exact same original user input;
 * then it contributes the original input plus the plan-node supplement. A legacy
 * plan without a saved context falls back to the request's own user input only.
 */
function savedPlanningUserInput(
  verified: ExecutionVerifiedSource,
  input: ValuationEvidenceAcquireRequest,
): string | null {
  const context = verified.planningContext
  if (context === null) return text(input.userInput)
  const savedUserInput = text(context.userInput)
  if (savedUserInput !== text(input.userInput)) return null
  return [savedUserInput, text(context.promptSupplement)]
    .filter((part) => part !== '')
    .join('\n')
}

function bindContextOf(
  input: ValuationEvidenceAcquireRequest,
  options: CreateWorkflowExecutionEvidencePortOptions,
  registeredTemplates: readonly string[],
  userInput: string,
): WorkflowPlanningSelectionContext {
  return {
    userInput,
    materials: (input.materials ?? []).map((material) => ({
      materialId: material.materialId,
      fileName: material.fileName,
      digest: material.digest,
      ...(material.text === undefined ? {} : { text: material.text }),
    })),
    knowledge: (input.knowledge ?? []).map((source) => ({
      sourceId: source.sourceId,
      ...(source.body === undefined ? {} : { body: source.body }),
    })),
    allowedProviderIds: options.allowedProviderIds,
    allowedTemplatePaths: registeredTemplates,
  }
}

function sampleFrom(row: JsonRecord, capture: VerifiedCapture, providerId: string): ValuationObservedSample | null {
  const url = canonicalListingUrl(row.url)
  const unitPrice = positiveNumber(row.unit_price)
  const areaSqm = positiveNumber(row.building_area)
  if (url === '' || unitPrice === null || areaSqm === null) return null
  const hasScreenshot = capture.screenshot !== '' && capture.screenshotDigest !== ''
  return {
    sourceId: `${providerId}:${url}`,
    caseId: text(row.caseId) || text(row.case_id) || `${providerId}:${url}`,
    provider: providerId,
    unitPrice,
    areaSqm,
    listingKind: 'listing',
    community: text(row.community),
    propertyNature: text(row.property_nature),
    sourceUrl: url,
    transactionType: text(row.transaction_type),
    capturedAt: text(row.captured_at),
    evidence: capture.file,
    digest: capture.digest,
    bytes: capture.bytes,
    screenshot: hasScreenshot ? capture.screenshot : '',
    screenshotDigest: hasScreenshot ? capture.screenshotDigest : '',
    screenshotMissing: !hasScreenshot,
    priceSource: 'list-row',
  }
}

export function createWorkflowExecutionEvidencePort(
  options: CreateWorkflowExecutionEvidencePortOptions,
): ValuationEvidencePort {
  const requested = options.maxDetailCases
  const cap = Math.max(1, Math.min(
    typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MAX_DETAIL_CASES,
    ABSOLUTE_MAX_DETAIL_CASES,
  ))

  return {
    async acquire(input: ValuationEvidenceAcquireRequest): Promise<ValuationEvidenceAcquireResult> {
      const plan = input.plan
      if (plan === undefined) return { ok: false, error: '证据获取需要已采纳的预检方案' }

      // 1. Admit the real approved plan and reuse its digest-bound preflight observation.
      let baseline: ValuationEvidenceAcquireResult
      try {
        baseline = await options.approvedEvidence.acquire(input)
      } catch {
        return { ok: false, error: '已采纳预检方案的证据复用失败', gaps: ['已采纳预检方案的证据复用失败'] }
      }
      if (!baseline.ok) {
        return {
          ok: false,
          ...(baseline.error === undefined ? {} : { error: baseline.error }),
          gaps: [...(baseline.gaps ?? [])],
        }
      }
      const samples: ValuationObservedSample[] = [...(baseline.samples ?? [])]
      const attempts: ValuationEvidenceRetrievalAttempt[] = [...(baseline.retrievalAttempts ?? [])]
      const gaps: string[] = [...(baseline.gaps ?? [])]
      if (isAborted(input.signal)) return { ok: false, error: CANCELLED_ERROR }

      const verified = verifiedSourceOf(plan.sources)
      if (verified === null) {
        return { ok: false, error: REPLAN_REQUIRED, gaps: [REPLAN_REQUIRED] }
      }

      // 2. Re-bind the saved selection against actual materials/user input/verified knowledge
      //    and the registered catalogs before any additional IO.
      const registeredTemplates = options.allowedTemplatePaths
        ?? (text(verified.selection.templatePath) === '' ? [] : [text(verified.selection.templatePath)])
      const planningUserInput = savedPlanningUserInput(verified, input)
      if (planningUserInput === null) {
        return {
          ok: false,
          error: `${REPLAN_REQUIRED}：已采纳方案的规划上下文与实际输入不再一致`,
          gaps: [`${REPLAN_REQUIRED}：已采纳方案的规划上下文与实际输入不再一致`],
        }
      }
      const bound = bindWorkflowPlanningSelection(
        verified.selection,
        bindContextOf(input, options, registeredTemplates, planningUserInput),
      )
      if (!bound.ok) {
        const gap = `${REPLAN_REQUIRED}：${bound.error}`
        return {
          ok: false,
          error: gap,
          gaps: [gap, ...(bound.questions ?? []).map((question) => `${question.field}: ${question.prompt}`)],
        }
      }
      const selection = bound.selection
      if (!options.allowedProviderIds.includes(verified.providerId)) {
        const gap = `已采纳方案的渠道不再登记：${verified.providerId}`
        return { ok: false, error: gap, gaps: [gap] }
      }
      if (isAborted(input.signal)) return { ok: false, error: CANCELLED_ERROR }

      const knownUrls = new Set<string>()
      for (const sample of samples) {
        const url = canonicalListingUrl(sample.sourceUrl)
        if (url !== '') knownUrls.add(url)
      }
      if (samples.length >= cap) {
        return { ok: true, samples, retrievalAttempts: attempts, ...(gaps.length === 0 ? {} : { gaps }) }
      }

      // 3. Same-provider search: the native list ledger cache is reused, no web-wide re-search.
      let searchValue: JsonRecord = {}
      try {
        const search = await options.dispatch(MARKET_SEARCH_TOOL, {
          caseDir: options.casePath,
          planId: options.planId,
          city: selection.city,
          keyword: selection.community,
          providers: [verified.providerId],
          propertyType: input.object.useLabel,
          method: PLAN_METHOD,
          maxPages: SEARCH_MAX_PAGES,
        }, input.signal)
        searchValue = search.ok && isRecord(search.value) ? search.value : {}
        if (!search.ok || searchValue.ok !== true) {
          attempts.push({ provider: verified.providerId, outcome: 'failed', stage: 'search', reason: SEARCH_FAILED_REASON })
          gaps.push(`${verified.providerId}: ${SEARCH_FAILED_REASON}`)
        }
      } catch {
        attempts.push({ provider: verified.providerId, outcome: 'failed', stage: 'search', reason: SEARCH_FAILED_REASON })
        gaps.push(`${verified.providerId}: ${SEARCH_FAILED_REASON}`)
      }
      if (isAborted(input.signal)) return { ok: false, error: CANCELLED_ERROR }

      const wanted = new Set([selection.community, ...selection.nearbyCommunities])
      const rows = Array.isArray(searchValue.cases) ? searchValue.cases.filter(isRecord) : []
      const candidates: JsonRecord[] = []
      for (const row of rows) {
        const url = canonicalListingUrl(row.url)
        if (url === '' || knownUrls.has(url)) continue
        if (text(row.source) !== verified.providerId) continue
        if (!wanted.has(text(row.community))) continue
        if (listingKindOf(text(row.transaction_type)) !== 'listing') continue
        if (positiveNumber(row.unit_price) === null || positiveNumber(row.building_area) === null) continue
        knownUrls.add(url)
        candidates.push(row)
      }

      // 4. Capture only until the technical cap; a failed capture keeps the baseline intact.
      // The attempt budget is separate from the successful-sample cap so a run of failed rows
      // cannot trigger unbounded captures.
      let captureAttempts = 0
      for (const row of candidates) {
        if (samples.length >= cap) break
        if (captureAttempts >= MAX_ADDITIONAL_CAPTURE_ATTEMPTS) {
          gaps.push(`${verified.providerId}: 详情取证尝试达到技术上限（${String(MAX_ADDITIONAL_CAPTURE_ATTEMPTS)}），已保留已核对样本`)
          break
        }
        if (isAborted(input.signal)) return { ok: false, error: CANCELLED_ERROR }
        captureAttempts += 1
        const url = canonicalListingUrl(row.url)
        let capture: VerifiedCapture | null = null
        let status: number | null = null
        try {
          const dispatched = await options.dispatch(MARKET_CAPTURE_TOOL, {
            caseDir: options.casePath,
            planId: options.planId,
            source: verified.providerId,
            url,
            caseId: `${verified.providerId}:${url}`,
            displayName: text(row.title),
          }, input.signal)
          const value: JsonRecord = dispatched.ok && isRecord(dispatched.value) ? dispatched.value : {}
          status = positiveNumber(value.status)
          // Only an admitted successful dispatch may contribute a capture.
          capture = dispatched.ok ? parseCapture(dispatched.value) : null
          if (capture !== null && canonicalListingUrl(capture.sourceUrl) !== url) capture = null
        } catch {
          capture = null
        }
        if (capture === null) {
          attempts.push({
            provider: verified.providerId,
            outcome: 'failed',
            stage: 'detail',
            url,
            ...(status === null ? {} : { status }),
            reason: DETAIL_UNVERIFIED_REASON,
          })
          gaps.push(`${verified.providerId}: ${DETAIL_UNVERIFIED_REASON}`)
          continue
        }
        const sample = sampleFrom(row, capture, verified.providerId)
        if (sample === null) {
          attempts.push({ provider: verified.providerId, outcome: 'failed', stage: 'detail', url, reason: DETAIL_UNVERIFIED_REASON })
          gaps.push(`${verified.providerId}: ${DETAIL_UNVERIFIED_REASON}`)
          continue
        }
        samples.push(sample)
      }
      if (isAborted(input.signal)) return { ok: false, error: CANCELLED_ERROR }

      return { ok: true, samples, retrievalAttempts: attempts, ...(gaps.length === 0 ? {} : { gaps }) }
    },
  }
}
