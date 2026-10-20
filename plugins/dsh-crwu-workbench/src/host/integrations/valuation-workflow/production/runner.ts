/**
 * Production composition for the embedded valuation workflow runner.
 *
 * Construction is lazy and performs no `ctx.get`, filesystem IO or model call. Every
 * capability port re-derives the current genuine execution before any IO: the shared
 * execution callback rechecks the parent Agent/session, the registry-issued token, the
 * root call id and the exact live scope. A verified prepared-material cache is only
 * reused after the frozen file bytes are re-contained, re-sized and re-hashed.
 */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat as statPath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { ASSET_TYPES } from '../../../../shared/contracts/valuation-project.ts'
import type { ValuationWorkflowInitialInput } from '../../../../shared/contracts/valuation-workflow.ts'
import { attachSessionToWorkspace, type SelectedWorkspace } from '../../../core/workspace-session/index.ts'
import { callerSession } from '../../../tools/common/types.ts'
import { samePathText } from '../../../domains/report-audit/scope.ts'
import type { ValuationWorkflowStartInput } from '../../../domains/report-evaluation/workflow/service.ts'
import { createValuationWorkflowService } from '../../../domains/report-evaluation/workflow/service.ts'
import { isMethodRequest } from '../../../domains/report-evaluation/project/coverage.ts'
import type {
  ValuationInferencePort,
  ValuationInferenceRequest,
  ValuationIntentPort,
  ValuationWorkflowPorts,
} from '../../../domains/report-evaluation/workflow/ports.ts'
import type { ValuationScope } from '../../../domains/report-evaluation/scope.ts'
import { createDshWorkflowInference, type DshWorkflowIntentStartedEvent, type DshWorkflowStartedEvent } from '../inference.ts'
import { createDshWorkflowIntent } from '../intent.ts'
import {
  prepareWorkflowMaterials,
  type WorkflowMaterialsDeps,
  type WorkflowMaterialsResult,
} from '../materials.ts'
import { createDshWorkflowPdfRenderer } from '../native-pdf.ts'
import type { ValuationWorkflowRunner, ValuationWorkflowExecution } from '../runtime.ts'
import { createDshWorkflowVisualReader } from '../visual.ts'
import { createWorkflowCalculationPorts } from './calculation.ts'
import { createWorkflowKnowledgeAdapter } from './knowledge.ts'
import { createWorkflowPlanningPorts } from './planning.ts'
import type {
  WorkflowCalculationReceipt,
  WorkflowFrozenFile,
  WorkflowFrozenInput,
  WorkflowJournalStartedEvent,
  WorkflowProductionRunnerOptions,
} from './types.ts'
import type { ValuationServicePrincipal } from '../services/access.ts'

const WORKFLOW_PREPARE_STOP_UNKNOWN = '资料准备阶段的视觉子会话停止状态未知，运行时保持占用'
const WORKFLOW_CACHE_UNVERIFIED = '缓存资料未能通过冻结核对：拒绝复用'

/** Confirmed choice labels bound into the intent/planning user input; identifiers stay verbatim. */
const CONFIRMED_ASSET_LABELS: Record<string, string> = { 'real-estate': '房地产' }
const CONFIRMED_METHOD_LABELS: Record<string, string> = {
  market: '市场法',
  income: '收益法',
  cost: '成本法',
}

interface LiveExecution {
  exec: ValuationWorkflowExecution
  scope: ValuationScope
}

interface TemplateArchive {
  path: string
  digest: string
}

function normalizeRelative(value: string): string {
  const raw = text(value).replace(/\\/g, '/').replace(/^\.\//, '')
  return process.platform === 'win32' ? raw.toLowerCase() : raw
}

function normalizeDigest(value: string): string {
  const raw = text(value).trim().toLowerCase()
  if (raw === '') return ''
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`
}

function codeOf(error: unknown): string {
  return error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
}

function resolvedInside(caseRootReal: string, target: string): boolean {
  const fold = process.platform === 'win32'
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value
  const rel = relative(fold(caseRootReal), fold(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Trusted structured preparation failure; the runtime keeps occupancy on stop-unknown. */
function structuredError(errorKind: string, error: string, sessionIds: string[] = []): Error {
  const failure = new Error(error)
  ;(failure as { errorKind?: string }).errorKind = errorKind
  ;(failure as { sessionIds?: string[] }).sessionIds = sessionIds
  return failure
}

/** Re-read one frozen file through the real filesystem and compare its actual bytes. */
async function verifyCaseBytes(
  caseRootReal: string,
  casePath: string,
  relativePath: string,
  expectedDigest: string,
  expectedSize: number,
): Promise<string> {
  let joined: string
  try {
    joined = joinLocalPath(casePath, relativePath)
  } catch {
    return 'input-changed'
  }
  let resolved: string
  try {
    resolved = await realpath(joined)
  } catch (error) {
    return codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR' ? 'input-changed' : 'environment'
  }
  if (!resolvedInside(caseRootReal, resolved)) return 'policy'
  let info: Awaited<ReturnType<typeof statPath>>
  try {
    info = await statPath(resolved)
  } catch {
    return 'environment'
  }
  if (!info.isFile()) return 'input-changed'
  if (info.size !== expectedSize) return 'input-changed'
  let bytes: Buffer
  try {
    bytes = await readFile(resolved)
  } catch {
    return 'environment'
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  return digest === expectedDigest ? '' : 'input-changed'
}

/** Explicit known-field discriminant: only the intent event declares `kind`. */
function isIntentStartedEvent(event: DshWorkflowStartedEvent): event is DshWorkflowIntentStartedEvent {
  return 'kind' in event
}

function journalEventOf(event: DshWorkflowStartedEvent): WorkflowJournalStartedEvent {
  if (isIntentStartedEvent(event)) {
    return { sessionId: event.sessionId, kind: 'intent', nodeId: 'intent', runId: '', revision: 0, correlationId: '' }
  }
  return {
    sessionId: event.sessionId,
    kind: 'stage',
    nodeId: event.nodeId,
    stage: event.stage,
    ...(event.operation === undefined ? {} : { operation: event.operation }),
    runId: event.runId,
    revision: event.revision,
    correlationId: event.correlationId,
  }
}

/** Bind the actual saved calculation artifacts into the delivery inference facts. */
async function withDeliveryArtifacts(
  request: ValuationInferenceRequest,
  getReceipt: (() => Promise<WorkflowCalculationReceipt | undefined>) | undefined,
): Promise<ValuationInferenceRequest> {
  if (request.stage !== 'delivery' || getReceipt === undefined) return request
  let receipt: WorkflowCalculationReceipt | undefined
  try {
    receipt = await getReceipt()
  } catch {
    return request
  }
  if (receipt === undefined) return request
  return {
    ...request,
    facts: {
      ...request.facts,
      calculationArtifacts: receipt.artifacts.map((artifact) => ({
        name: artifact.name,
        relativePath: artifact.relativePath,
        digest: artifact.digest,
        bytes: artifact.bytes,
      })),
    },
  }
}

export async function createWorkflowProductionRunner(
  options: WorkflowProductionRunnerOptions,
): Promise<ValuationWorkflowRunner> {
  const scope = options.scope
  const projectId = text(scope.projectId) || text(scope.valuationId)
  const boundValuationId = text(scope.valuationId)
  const boundSessionId = text(scope.sessionId)
  const boundOpenedAt = scope.openedAt
  const parentSessionId = text(scope.parentSessionId) || boundSessionId
  const boundCasePath = text(scope.casePath)
  const boundWorkspaceId = text(scope.workspaceId)
  const boundWorkspacePath = text(scope.workspacePath)
  const planId = text(options.planId) || `plan-${projectId}`
  const frozenInput: WorkflowFrozenInput = options.frozenInput

  const configLike = options.deps.config as unknown as
    | { valuation?: { knowledge?: { wikiPath?: unknown } } }
    | undefined
  const entryWikiPath = text(configLike?.valuation?.knowledge?.wikiPath)

  /** Recheck the actual caller and the exact live scope; never a stored execution. */
  const liveExecution = (): LiveExecution | null => {
    const exec = options.getExecution()
    if (exec === undefined || exec === null) return null
    const agent = (exec as { agent?: unknown }).agent
    const agentId = agent !== null && typeof agent === 'object' && typeof (agent as { id?: unknown }).id === 'string'
      ? (agent as { id: string }).id
      : ''
    if (agentId === '' || agentId !== parentSessionId) return null
    if (typeof (exec as { token?: unknown }).token !== 'symbol') return null
    if (text((exec as { rootCallId?: unknown }).rootCallId) === '') return null
    // The real caller session must be the same parent session this runner is bound to.
    const session = callerSession(exec)
    if (session === undefined || text(session.id) !== parentSessionId) return null
    const live = options.deps.valuationScopes?.get(projectId)
    if (live === undefined) return null
    if (text(live.valuationId) !== boundValuationId) return null
    if (text(live.sessionId) !== boundSessionId) return null
    if (live.openedAt !== boundOpenedAt) return null
    if ((text(live.parentSessionId) || text(live.sessionId)) !== parentSessionId) return null
    if (!samePathText(text(live.casePath), boundCasePath)) return null
    if (text(live.workspaceId) !== boundWorkspaceId) return null
    if (!samePathText(text(live.workspacePath), boundWorkspacePath)) return null
    return { exec, scope: live }
  }

  /**
   * Named local-access authorization for the material read. It must pass before any
   * cached read, native filesystem call or `ctx.get`, and a denied receipt is final.
   */
  const authorizeCaseRead = (live: LiveExecution): void => {
    const call = {
      operation: 'system.case-file.read' as const,
      source: 'audit-tool' as const,
      workdir: text(live.scope.casePath),
    }
    const decision = options.deps.access.authorize(call)
    if (!decision.ok) {
      throw structuredError('policy', '本机访问未获授权：拒绝读取本轮估值资料')
    }
    options.deps.access.note(call, { summary: 'valuation workflow material read' })
  }

  const principalOf = (live: LiveExecution): ValuationServicePrincipal => {
    const session = callerSession(live.exec)
    const signal = (live.exec as { signal?: AbortSignal }).signal
    return {
      sessionId: parentSessionId,
      caseDir: live.scope.casePath,
      source: 'workflow-runtime',
      ...(session === undefined ? {} : { session }),
      ...(live.exec.agent === undefined ? {} : { agent: live.exec.agent }),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  const workspaceOf = (live: LiveExecution): SelectedWorkspace => ({
    id: text(live.scope.workspaceId),
    path: text(live.scope.workspacePath),
    title: '',
  })

  const attachWorkspace = async (
    input: { childId: string; workspace: unknown; parentAgent: unknown },
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const verdict = await attachSessionToWorkspace(options.deps.ctx, input.workspace as SelectedWorkspace, input.childId)
      return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason }
    } catch {
      return { ok: false, error: '子会话工作区挂载与回读失败' }
    }
  }

  /**
   * One wrapped inference call: build the adapter from the current genuine execution,
   * journal the actual published child, then await settlement after bounded disposal.
   */
  const inference: ValuationInferencePort = {
    async infer(request) {
      const live = liveExecution()
      if (live === null) {
        return { ok: false, errorKind: 'policy', error: '本轮工作流没有可用的受控执行：拒绝创建业务子会话' }
      }
      let startedId = ''
      const adapter = createDshWorkflowInference({
        ctx: options.deps.ctx,
        parentAgent: live.exec.agent,
        workspace: workspaceOf(live),
        attachWorkspace,
        onStarted: async (event) => {
          startedId = event.sessionId
          if (options.journalStarted !== undefined) await options.journalStarted(journalEventOf(event))
        },
      })
      const result = await adapter.infer(await withDeliveryArtifacts(request, options.getCalculationReceipt))
      const sessionId = text(result.sessionId) || startedId
      if (result.errorKind === 'stop-unknown') return result
      if (sessionId !== '' && options.journalSettled !== undefined) {
        try {
          await options.journalSettled({ sessionId, ok: result.ok, errorKind: text(result.errorKind) })
        } catch {
          return {
            ok: false,
            errorKind: 'infrastructure',
            sessionId,
            error: '子会话结算日志写入失败：已停止后续业务操作',
          }
        }
      }
      return result
    },
  }

  const intent: ValuationIntentPort = {
    async infer(input, registeredAssetIds, signal) {
      const live = liveExecution()
      if (live === null) {
        return { ok: false, errorKind: 'policy', error: '本轮工作流没有可用的受控执行：拒绝创建意图子会话' }
      }
      let startedId = ''
      const adapter = createDshWorkflowIntent({
        ctx: options.deps.ctx,
        parentAgent: live.exec.agent,
        workspace: workspaceOf(live),
        attachWorkspace,
        onStarted: async (event) => {
          startedId = event.sessionId
          if (options.journalStarted !== undefined) {
            await options.journalStarted({
              sessionId: event.sessionId,
              kind: 'intent',
              nodeId: 'intent',
              runId: '',
              revision: 0,
              correlationId: '',
            })
          }
        },
      })
      const result = await adapter.infer(input, registeredAssetIds, signal)
      const sessionId = text(result.sessionId) || startedId
      const errorKind = result.ok ? '' : result.errorKind
      if (errorKind === 'stop-unknown') {
        return {
          ok: false,
          errorKind: 'stop-unknown',
          error: result.ok ? '' : result.error,
          ...(sessionId === '' ? {} : { sessionId }),
        }
      }
      if (sessionId !== '' && options.journalSettled !== undefined) {
        try {
          await options.journalSettled({ sessionId, ok: result.ok, errorKind: text(errorKind) })
        } catch {
          return {
            ok: false,
            errorKind: 'infrastructure',
            error: '子会话结算日志写入失败：已停止后续业务操作',
            ...(sessionId === '' ? {} : { sessionId }),
          }
        }
      }
      if (result.ok) return { ok: true, sessionId: result.sessionId, intent: result.intent }
      return {
        ok: false,
        error: result.error,
        errorKind: result.errorKind,
        ...(sessionId === '' ? {} : { sessionId }),
      }
    },
  }

  const knowledge = createWorkflowKnowledgeAdapter({
    deps: options.deps,
    entryWikiPath,
    // Frozen at preparation time; never derived from the valuation-basis `mode`.
    methodRequest: text(frozenInput.methodRequest),
    principal: () => {
      const live = liveExecution()
      return live === null ? undefined : principalOf(live)
    },
    planId: () => planId,
    inference,
  })

  const planningPorts = createWorkflowPlanningPorts({
    deps: options.deps,
    frozenInput,
    planId,
    casePath: () => boundCasePath,
    principal: () => {
      const live = liveExecution()
      return live === null ? undefined : principalOf(live)
    },
    currentExecution: () => {
      const live = liveExecution()
      return live === null ? undefined : live.exec
    },
    inference,
    knowledge,
  })

  const calculationPorts = createWorkflowCalculationPorts({
    deps: options.deps,
    frozenInput,
    projectId,
    planId,
    casePath: () => boundCasePath,
    principal: () => {
      const live = liveExecution()
      return live === null ? undefined : principalOf(live)
    },
    ...(options.getCalculationReceipt === undefined ? {} : { getReceipt: options.getCalculationReceipt }),
    ...(options.saveCalculationReceipt === undefined ? {} : { saveReceipt: options.saveCalculationReceipt }),
  })

  const ports: ValuationWorkflowPorts = {
    inference,
    knowledge: knowledge.port,
    evidence: planningPorts.evidence,
    calculator: calculationPorts.calculator,
    verification: calculationPorts.verification,
    intent,
    planning: planningPorts.planning,
  }

  const service = createValuationWorkflowService(ports, {
    ...(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer }),
    ...(options.saveRun === undefined ? {} : { persistence: { save: options.saveRun } }),
  })

  const templateArchive = (): TemplateArchive | undefined => {
    const fileId = text(frozenInput.templateFileId)
    if (fileId === '') return undefined
    const file = frozenInput.files.find((item) => text(item.fileId) === fileId)
    if (file === undefined) return undefined
    const path = text(file.archiveRelativePath) || text(file.relativePath)
    return path === '' ? undefined : { path, digest: text(file.sha256) }
  }

  /**
   * Re-verify the whole frozen archive against a cached preparation before reuse.
   *
   * Every frozen archived identity must be represented exactly once as a prepared or
   * unverified entry, every represented identity must resolve to the frozen record, and
   * every record is re-contained, re-sized and re-hashed against actual archived bytes.
   * An unknown, duplicate, omitted or mismatched identity refuses the cache.
   */
  const admitPrepared = async (
    live: LiveExecution,
    result: WorkflowMaterialsResult,
  ): Promise<{ ok: true; result: WorkflowMaterialsResult } | { ok: false; errorKind: string; error: string }> => {
    const refuse = (errorKind = 'input-changed'): { ok: false; errorKind: string; error: string } =>
      ({ ok: false, errorKind, error: WORKFLOW_CACHE_UNVERIFIED })
    const frozen = new Map<string, WorkflowFrozenFile>()
    for (const file of frozenInput.files) {
      const key = normalizeRelative(text(file.archiveRelativePath) || text(file.relativePath))
      if (key === '' || frozen.has(key)) return refuse('policy')
      frozen.set(key, file)
    }
    const represented = new Set<string>()
    for (const material of Array.isArray(result.materials) ? result.materials : []) {
      const key = normalizeRelative(text(material.relativePath))
      const entry = frozen.get(key)
      if (key === '' || entry === undefined || represented.has(key)) return refuse('policy')
      const expected = normalizeDigest(text(entry.sha256))
      if (expected === '' || normalizeDigest(text(material.digest)) !== expected) return refuse()
      if (material.sizeBytes !== entry.sizeBytes) return refuse()
      represented.add(key)
    }
    for (const entry of Array.isArray(result.unverified) ? result.unverified : []) {
      const key = normalizeRelative(text(entry.relativePath))
      const frozenEntry = frozen.get(key)
      if (key === '' || frozenEntry === undefined || represented.has(key)) return refuse('policy')
      const expected = normalizeDigest(text(frozenEntry.sha256))
      if (expected === '' || normalizeDigest(text(entry.digest)) !== expected) return refuse()
      represented.add(key)
    }
    // A successful cache must cover the exact frozen archive: no silent omission.
    if (represented.size !== frozen.size) return refuse()
    if (frozen.size === 0) return { ok: true, result }
    let caseRootReal: string
    try {
      caseRootReal = await realpath(text(live.scope.casePath))
    } catch {
      return { ok: false, errorKind: 'environment', error: '案例目录不可解析：不能核对缓存资料' }
    }
    for (const [key, entry] of frozen) {
      const expected = normalizeDigest(text(entry.sha256))
      if (expected === '') return refuse()
      const problem = await verifyCaseBytes(caseRootReal, text(live.scope.casePath), key, expected, entry.sizeBytes)
      if (problem !== '') return { ok: false, errorKind: problem, error: WORKFLOW_CACHE_UNVERIFIED }
    }
    return { ok: true, result }
  }

  const subjectMaterials = (
    result: WorkflowMaterialsResult,
    template: TemplateArchive | undefined,
  ): ValuationWorkflowStartInput['materials'] => {
    const templateKey = template === undefined ? '' : normalizeRelative(template.path)
    const materials: NonNullable<ValuationWorkflowStartInput['materials']> = []
    for (const material of result.materials) {
      if (templateKey !== '' && normalizeRelative(text(material.relativePath)) === templateKey) continue
      materials.push({
        materialId: material.materialId,
        fileName: material.fileName,
        digest: material.digest,
        text: material.text,
      })
    }
    return materials
  }

  const preparedFor = async (live: LiveExecution): Promise<WorkflowMaterialsResult> => {
    const cached = options.getPrepared === undefined ? undefined : await options.getPrepared()
    if (cached !== undefined && cached.ok === true) {
      const admitted = await admitPrepared(live, cached)
      if (!admitted.ok) throw structuredError(admitted.errorKind, admitted.error)
      return admitted.result
    }
    const visualReader = createDshWorkflowVisualReader({
      ctx: options.deps.ctx,
      parentAgent: live.exec.agent,
      inference,
    })
    // Built from the same genuine live execution as the other Host adapters, so
    // the renderer can inherit the registry token and the real cancellation.
    const pdfRenderer = createDshWorkflowPdfRenderer({
      ctx: options.deps.ctx,
      access: options.deps.access,
      world: options.deps.world,
      execution: live.exec,
    })
    const materialDeps: WorkflowMaterialsDeps = {
      ctx: options.deps.ctx,
      access: options.deps.access,
      world: options.deps.world,
      ...(options.deps.python === undefined ? {} : { python: options.deps.python }),
      ...(options.deps.valuationScopes === undefined ? {} : { valuationScopes: options.deps.valuationScopes }),
      visualReader,
      pdfRenderer,
    }
    const fresh = await prepareWorkflowMaterials(materialDeps, live.exec)
    if (fresh.errorKind === 'stop-unknown' || fresh.stopUnknown !== undefined) {
      throw structuredError('stop-unknown', WORKFLOW_PREPARE_STOP_UNKNOWN, fresh.stopUnknown?.sessionIds ?? [])
    }
    if (!fresh.ok) {
      throw structuredError(fresh.errorKind === '' ? 'failed' : fresh.errorKind, text(fresh.error) || '本轮资料没有准备成功')
    }
    if (options.savePrepared !== undefined) {
      try {
        await options.savePrepared(fresh)
      } catch {
        throw structuredError('infrastructure', '资料准备结果未能持久化：已停止后续业务操作')
      }
    }
    return fresh
  }

  const startInput = async (): Promise<ValuationWorkflowStartInput> => {
    const live = liveExecution()
    if (live === null) {
      throw structuredError('policy', '本轮工作流没有可用的受控执行：拒绝准备业务资料')
    }
    // Named local-access authorization precedes every cached read, native FS call and ctx.get.
    authorizeCaseRead(live)
    options.deps.valuationScopes?.replacePlans(projectId, [planId])
    const assetType = text(frozenInput.assetType)
    // Both entry choices are explicit employee decisions: an empty, removed `auto`
    // or unknown value is refused before any material preparation.
    if (!(ASSET_TYPES as readonly string[]).includes(assetType)) {
      throw structuredError('input-invalid', `冻结输入里的资产类别不合法（${assetType || '空'}）：只允许已登记的资产类别`)
    }
    const methodRequest = text(frozenInput.methodRequest)
    if (!isMethodRequest(methodRequest)) {
      throw structuredError(
        'input-invalid',
        `冻结输入里的评估方法不合法（${methodRequest || '空'}）：只允许 market / income / cost`,
      )
    }
    const template = templateArchive()
    const prepared = await preparedFor(live)
    // The confirmed frozen choices must reach the real intent router and planning task.
    const confirmed: string[] = []
    {
      const label = CONFIRMED_ASSET_LABELS[assetType] ?? ''
      confirmed.push(label === '' ? `资产类别：${assetType}` : `资产类别：${label}（${assetType}）`)
    }
    {
      const label = CONFIRMED_METHOD_LABELS[methodRequest] ?? ''
      confirmed.push(label === '' ? `估值方法：${methodRequest}` : `估值方法：${label}（${methodRequest}）`)
    }
    const purpose = frozenInput.purpose === null || frozenInput.purpose === undefined ? '' : text(frozenInput.purpose)
    if (purpose !== '') confirmed.push(`评估目的：${purpose}`)
    const baseDate = frozenInput.baseDate === null || frozenInput.baseDate === undefined ? '' : text(frozenInput.baseDate)
    if (baseDate !== '') confirmed.push(`评估基准日：${baseDate}`)
    const valueType = frozenInput.valueType === null || frozenInput.valueType === undefined ? '' : text(frozenInput.valueType)
    if (valueType !== '') confirmed.push(`价值类型：${valueType}`)
    // Keep the employee's original supplemental text in the first-input snapshot.
    const rawSupplement = typeof frozenInput.supplementalPrompt === 'string' ? frozenInput.supplementalPrompt : ''
    const supplement = text(frozenInput.supplementalPrompt)
    if (supplement !== '') confirmed.push(supplement)
    // The uploaded workbook is an explicit user choice, not a subject fact: bind only its
    // actual archived relative identity and digest so source-bound planning can prove the
    // selected local template path without re-reading any absolute path.
    if (template !== undefined && template.path !== '' && template.digest !== '') {
      confirmed.push(`用户上传计算表：${template.path}（摘要 ${template.digest}）`)
    }
    const userInput = confirmed.join('\n')
    const inputDigest = text(frozenInput.inputDigest)
    const templateFileId = frozenInput.templateFileId === null || frozenInput.templateFileId === undefined
      ? null
      : text(frozenInput.templateFileId) || null
    const initialInput: ValuationWorkflowInitialInput = {
      userInput,
      assetType,
      methodRequest,
      purpose: purpose === '' ? null : purpose,
      baseDate: baseDate === '' ? null : baseDate,
      valueType: valueType === '' ? null : valueType,
      templateFileId,
      supplementalPrompt: rawSupplement,
      inputDigest: inputDigest === '' ? null : inputDigest,
      // Every frozen uploaded file stays represented by its archived relative identity.
      files: frozenInput.files.map((file) => ({
        fileId: text(file.fileId),
        fileName: text(file.fileName),
        relativePath: text(file.archiveRelativePath) || text(file.relativePath),
        digest: text(file.sha256),
      })),
    }
    return {
      // Stable Host run identity: derived from the project, never from a session.
      runId: projectId,
      object: { objectId: '', useLabel: '', areaSqm: null },
      materials: subjectMaterials(prepared, template),
      userInput,
      purpose: frozenInput.purpose ?? null,
      baseDate: frozenInput.baseDate ?? null,
      // Method selection does not imply a valuation basis; planning proposes it.
      mode: null,
      initialInput,
    }
  }

  return { service, startInput }
}
