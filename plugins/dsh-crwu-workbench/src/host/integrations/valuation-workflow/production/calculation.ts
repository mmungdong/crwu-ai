/**
 * Production calculation adapter for the valuation workflow.
 *
 * Only the actual approved plan, its digest-bound observations and the accepted
 * evidence assessments become the fixed builder input. The packaged listing-reference
 * builder produces the four artifacts; a read-only pass re-verifies them semantically,
 * and only the trace's own numbers are returned. A plain receipt bound to the actual
 * plan revision is awaited before success, so a later review-only correction reuses
 * the earlier workbook instead of recomputing against a newer business revision.
 */
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { fileSystem, readTextIfExists } from '../../../core/fs/paths.ts'
import { ensureDirectory, writeCaseText } from '../../../tools/common/case-files.ts'
import { planFilePath } from '../../../domains/report-evaluation/delivery/finalize-facts.ts'
import { LISTING_REFERENCE_ARTIFACTS } from '../../../domains/report-evaluation/assets/realestate/listing-reference.ts'
import { knowledgeDigest } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { canonicalListingUrl } from '../../../domains/report-evaluation/market/candidates.ts'
import { buildWorkflowListingPayload } from '../../../domains/report-evaluation/workflow/listing-payload.ts'
import type { ValuationWorkflowPlan } from '../../../../shared/contracts/valuation-workflow.ts'
import type {
  ValuationArtifactVerificationPort,
  ValuationCalculatorPort,
  ValuationCalculatorRequest,
  ValuationCalculatorResult,
  ValuationObservedSample,
} from '../../../domains/report-evaluation/workflow/ports.ts'
import {
  runListingReference,
  validateListingReferenceArtifacts,
} from '../services/listing-reference.ts'
import type { ValuationServicePrincipal } from '../services/access.ts'
import type { HostWorkflowServiceDeps } from '../services/deps.ts'
import type { WorkflowCalculationArtifact, WorkflowCalculationReceipt, WorkflowFrozenInput } from './types.ts'

const INPUT_FILE = '挂牌参考输入.json'
/** Re-read bound on one artifact; larger than the largest expected workbook. */
const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? number : null
}

function listingKindOf(transactionType: string): string {
  const value = transactionType.trim().toLowerCase()
  if (value === 'listing' || value === '挂牌') return 'listing'
  if (value === 'deal' || value === 'sold' || value === '成交') return 'deal'
  return value === '' ? '' : 'other'
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

/**
 * Re-derive the immutable observed pool from the approved plan's digest-bound
 * observations. Mutable top-level aliases are ignored so a rewritten source cannot
 * smuggle a price into the fixed input.
 */
function observationsFromPlan(
  plan: ValuationWorkflowPlan,
  requestRevision: number,
): { ok: true; samples: ValuationObservedSample[] } | { ok: false; error: string } {
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
    const canonicalUrl = canonicalListingUrl(row.url)
    if (canonicalUrl === ''
      || canonicalUrl !== canonicalListingUrl(capture.sourceUrl)
      || canonicalUrl !== canonicalListingUrl(source.detailUrl)) continue
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
  if (samples.length === 0) return { ok: false, error: '预检方案没有可核对的实际挂牌案例' }
  return { ok: true, samples }
}

/** A full canonical builder-payload hash, as the native builder emits it. */
const FULL_INPUT_IDENTITY = /^sha256:[0-9a-f]{64}$/

/**
 * Read the trace document: only the numbers it reports plus its validated full input
 * hash. The native builder computes that hash from the exact fixed payload it read,
 * so it is the durable identity of the calculation input.
 */
function traceFacts(raw: string): { unitPrice: number; totalPrice: number; inputDigest: string } | null {
  let trace: unknown
  try {
    trace = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(trace)) return null
  const inputDigest = text(trace.inputDigest).toLowerCase()
  if (!FULL_INPUT_IDENTITY.test(inputDigest)) return null
  const objects = Array.isArray(trace.objects) ? trace.objects : []
  const first = objects.find(isRecord)
  if (first === undefined) return null
  const unitPrice = positiveNumber(first.unitPrice)
  const totalPrice = positiveNumber(first.totalValue) ?? positiveNumber(first.totalPrice)
  if (unitPrice === null || totalPrice === null) return null
  return { unitPrice, totalPrice, inputDigest }
}

export interface CreateWorkflowCalculationOptions {
  deps: HostWorkflowServiceDeps
  frozenInput: WorkflowFrozenInput
  projectId: string
  planId: string
  casePath: () => string
  /** Live principal for the current genuine execution. */
  principal: () => ValuationServicePrincipal | undefined
  getReceipt?: () => Promise<WorkflowCalculationReceipt | undefined>
  saveReceipt?: (receipt: WorkflowCalculationReceipt) => Promise<void>
}

export interface WorkflowCalculationPorts {
  calculator: ValuationCalculatorPort
  verification: ValuationArtifactVerificationPort
}

export function createWorkflowCalculationPorts(
  options: CreateWorkflowCalculationOptions,
): WorkflowCalculationPorts {
  const inputDigestOf = (plan: ValuationWorkflowPlan): string =>
    text(options.frozenInput.inputDigest) || text(plan.digest)

  /**
   * The real observed pool wins, including post-approval captures. Only a legacy
   * caller without a durable pool may derive preflight observations, and only when
   * every selected source id is proved by that derivation; the plan is never widened
   * to force post-approval cases into it.
   */
  const actualObservations = (
    input: ValuationCalculatorRequest,
    plan: ValuationWorkflowPlan,
  ): ValuationObservedSample[] | null => {
    if (Array.isArray(input.observations) && input.observations.length > 0) {
      return input.observations.map((sample) => ({ ...sample }))
    }
    const derived = observationsFromPlan(plan, input.revision)
    if (!derived.ok) return null
    const proved = new Set(derived.samples.map((sample) => sample.sourceId))
    if (!input.samples.every((sample) => proved.has(sample.sourceId))) return null
    return derived.samples
  }

  /** Frozen archived material references in the native closed shape; the template stays out of subject materials. */
  const materialReferences = (): Array<Record<string, unknown>> => {
    const templateId = text(options.frozenInput.templateFileId)
    const references: Array<Record<string, unknown>> = []
    for (const file of options.frozenInput.files) {
      if (templateId !== '' && text(file.fileId) === templateId) continue
      const archiveRelativePath = text(file.archiveRelativePath) || text(file.relativePath)
      references.push({
        fileId: text(file.fileId),
        fileName: text(file.fileName),
        archiveRelativePath,
        kind: text(file.kind),
        sizeBytes: file.sizeBytes,
        sha256: text(file.sha256),
        // Only an actual verified flag is readable; an absent value stays unproven.
        readable: file.readable === true,
      })
    }
    return references
  }

  /**
   * Rebase ONLY the exact approved template prefix to the builder's case-root form.
   * The shown plan object is never mutated; the payload template path is the sole
   * rebased projection, and an unknown prefix is left exactly as approved.
   */
  const rebasePlanTemplate = (plan: ValuationWorkflowPlan): ValuationWorkflowPlan => {
    const prefix = `方案/${options.planId}/`
    const relativePath = text(plan.template.relativePath)
    if (!relativePath.startsWith(prefix)) return plan
    return { ...plan, template: { ...plan.template, relativePath: relativePath.slice(prefix.length) } }
  }

  const calculator: ValuationCalculatorPort = {
    async compute(input: ValuationCalculatorRequest): Promise<ValuationCalculatorResult> {
      const principal = options.principal()
      if (principal === undefined) return { ok: false, error: '计算需要真实的本轮估值执行' }
      const assessment = input.assessment
      const plan = assessment?.plan
      if (assessment === undefined || plan === undefined) return { ok: false, error: '计算需要已采纳的预检方案' }
      const observations = actualObservations(input, plan)
      if (observations === null) {
        return { ok: false, error: '没有可核对的实际观察案例池：拒绝生成固定输入' }
      }
      const materials = materialReferences()

      const evidenceOutput = isRecord(input.evidenceOutput) ? input.evidenceOutput : {}
      const assessments = Array.isArray(evidenceOutput.assessments) ? evidenceOutput.assessments : []
      const fixed = buildWorkflowListingPayload({
        projectId: options.projectId,
        planId: options.planId,
        inputDigest: inputDigestOf(plan),
        // Confirmed frozen metadata; a revised subject purpose/date still wins below.
        methodRequest: options.frozenInput.methodRequest,
        valueType: options.frozenInput.valueType,
        supplementalPrompt: options.frozenInput.supplementalPrompt,
        request: {
          runId: input.runId,
          revision: input.revision,
          objectId: input.objectId,
          areaSqm: input.areaSqm,
          subject: input.subject,
          samples: input.samples,
          knowledge: input.knowledge,
          // Only the builder payload sees the rebased template path; the plan object stays as approved.
          assessment: { ...assessment, plan: rebasePlanTemplate(plan) },
        },
        observations,
        assessments,
        materials,
        generatedAt: new Date().toISOString(),
      })
      if (!fixed.ok || fixed.payload === undefined) {
        return { ok: false, error: fixed.error === undefined || fixed.error === '' ? '固定挂牌参考输入无法生成' : fixed.error }
      }

      const casePath = options.casePath()
      const revision = input.revision
      const targetRelative = planFilePath(options.planId, '', revision)
      if (targetRelative === '') return { ok: false, error: '方案 id 不是单段安全标识：无法落点固定输入' }
      const targetDir = joinLocalPath(casePath, targetRelative)
      const platform = await options.deps.world.platform()
      const session = principal.session
      const signal = principal.signal
      const made = await ensureDirectory(options.deps.access, targetDir, {
        workdir: casePath,
        platform,
        ...(session === undefined ? {} : { session }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (made.errorKind !== '' || made.postcondition !== 'directory') {
        return { ok: false, error: '无法准备方案目录：固定挂牌参考输入不能落点' }
      }
      const written = await writeCaseText(
        options.deps.ctx,
        joinLocalPath(targetDir, INPUT_FILE),
        `${JSON.stringify(fixed.payload, null, 2)}\n`,
        { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) },
      )
      if (!written.ok) return { ok: false, error: `固定挂牌参考输入未能写入案例目录（${written.errorKind || 'infrastructure'}）` }

      const built = await runListingReference({ planId: options.planId, revision }, options.deps, principal)
      if (!built.ok) return { ok: false, error: text(built.error) || '挂牌参考交付脚本没有成功执行' }
      const validated = await validateListingReferenceArtifacts(
        { planId: options.planId, revision },
        options.deps,
        principal,
      )
      if (!validated.ok) return { ok: false, error: text(validated.error) || '挂牌参考产物语义校验未通过' }

      const traceRaw = await readTextIfExists(
        options.deps.ctx,
        joinLocalPath(casePath, planFilePath(options.planId, '计算轨迹.json', revision)),
      )
      const facts = traceFacts(traceRaw)
      if (facts === null) return { ok: false, error: '计算轨迹没有返回可核对的正数金额与完整输入指纹' }

      const fs = fileSystem(options.deps.ctx)
      if (fs === undefined) return { ok: false, error: '宿主文件服务不可用：无法回读计算产物' }
      const artifacts: WorkflowCalculationArtifact[] = []
      for (const name of LISTING_REFERENCE_ARTIFACTS) {
        const relativePath = planFilePath(options.planId, name, revision)
        let bytes: Uint8Array
        try {
          bytes = await fs.readBytes(await fs.resolve(joinLocalPath(casePath, relativePath)), signal, ARTIFACT_MAX_BYTES)
        } catch {
          return { ok: false, error: `读不到计算产物：${name}` }
        }
        if (bytes.length <= 0) return { ok: false, error: `计算产物为空：${name}` }
        artifacts.push({ name, relativePath, digest: knowledgeDigest(bytes), bytes: bytes.length })
      }

      const receipt: WorkflowCalculationReceipt = {
        planId: options.planId,
        revision,
        // Full canonical builder-payload hash, tied to the actual fixed input by native validation.
        inputDigest: facts.inputDigest,
        artifacts,
        unitPrice: facts.unitPrice,
        totalPrice: facts.totalPrice,
        generatedAt: new Date().toISOString(),
      }
      if (options.saveReceipt !== undefined) {
        try {
          await options.saveReceipt(receipt)
        } catch {
          return { ok: false, error: '计算回执未能持久化：已停止后续交付' }
        }
      }
      return { ok: true, unitPrice: facts.unitPrice, totalPrice: facts.totalPrice }
    },
  }

  const verification: ValuationArtifactVerificationPort = {
    async verify(request) {
      const principal = options.principal()
      if (principal === undefined) return { ok: false, error: '产物验收需要真实的本轮估值执行' }
      const receipt = options.getReceipt === undefined ? undefined : await options.getReceipt()
      if (receipt === undefined || receipt.planId === '') {
        return { ok: false, error: '没有已保存的计算回执：不能确认交付产物' }
      }
      const casePath = options.casePath()
      const fs = fileSystem(options.deps.ctx)
      if (fs === undefined) return { ok: false, error: '宿主文件服务不可用：不能复核计算产物' }
      // 1. Every saved outer artifact identity must still match actual bytes, not metadata.
      for (const artifact of receipt.artifacts) {
        const relativePath = text(artifact.relativePath)
          || planFilePath(receipt.planId, artifact.name, receipt.revision)
        if (relativePath === '') return { ok: false, error: `计算回执的产物路径无效：${artifact.name}` }
        let bytes: Uint8Array
        try {
          bytes = await fs.readBytes(
            await fs.resolve(joinLocalPath(casePath, relativePath)),
            principal.signal,
            ARTIFACT_MAX_BYTES,
          )
        } catch {
          return { ok: false, error: `复核时读不到计算产物：${artifact.name}` }
        }
        if (bytes.length <= 0 || bytes.length !== artifact.bytes || knowledgeDigest(bytes) !== artifact.digest) {
          return { ok: false, error: `计算产物的实际字节与其回执身份不一致：${artifact.name}` }
        }
      }
      // 2. The trace/fixed-input identity must still be the saved full canonical input hash.
      const traceRaw = await readTextIfExists(
        options.deps.ctx,
        joinLocalPath(casePath, planFilePath(receipt.planId, '计算轨迹.json', receipt.revision)),
      )
      let trace: unknown
      try {
        trace = JSON.parse(traceRaw) as unknown
      } catch {
        trace = null
      }
      const traceDigest = isRecord(trace) ? text(trace.inputDigest).toLowerCase() : ''
      if (traceDigest === '' || traceDigest !== text(receipt.inputDigest).toLowerCase()) {
        return { ok: false, error: '计算轨迹的完整输入指纹与已保存回执不一致' }
      }
      // 3. Native read-only semantic validation at the saved plan revision only.
      const validated = await validateListingReferenceArtifacts(
        { planId: receipt.planId, revision: receipt.revision },
        options.deps,
        principal,
      )
      if (!validated.ok) return { ok: false, error: text(validated.error) || '挂牌参考产物语义复验未通过' }
      const missing = request.artifacts.filter((name) => !receipt.artifacts.some((artifact) => artifact.name === name))
      if (missing.length > 0) {
        return { ok: false, missing, error: `计算回执缺少产物：${missing.join('、')}` }
      }
      return { ok: true, verified: [...request.artifacts] }
    },
  }

  return { calculator, verification }
}
