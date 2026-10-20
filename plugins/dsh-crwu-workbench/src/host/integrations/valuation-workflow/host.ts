/**
 * Real Host factory for the embedded valuation workflow, storage stage.
 *
 * Construction is inert: no `ctx.get`, filesystem call or database open happens here.
 * Every operation authorizes the named store capability before touching an optional
 * service, the selected workspace or the SQLite store. One lazy store handle is pinned
 * per original workspace so a later selected-workspace switch cannot redirect a live
 * run's persistence.
 *
 * This stage implements the persistent task lifecycle (prepare/current/node/
 * export/load/clear) plus the real panel decisions: action/preview/cancel/reconcile
 * and verified artifact opening. A decision is queued on the real runtime and then
 * delivered to the exact recorded parent Agent as one opaque command prompt.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { closeStoresUnder } from './store-registry.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { LocalAccessSource } from '../../core/access/operations.ts'
import type { WorkbenchConfig } from '../../config/config.ts'
import type { WorldFacts } from '../../core/platform/world.ts'
import type { PythonRuntimeResolver } from '../../core/runtime/python.ts'
import {
  pathKey,
  sessionHeader,
  verifySessionInWorkspace,
  workspaceSessionService,
} from '../../core/workspace-session/index.ts'
import type { SelectedWorkspace, WorkspaceSessionState } from '../../core/workspace-session/index.ts'
import {
  isSafeIdSegment,
  normalizeAssetType,
  type FrozenInput,
  type HandoffReceipt,
} from '../../domains/report-evaluation/project/contracts.ts'
import { isMethodRequest } from '../../domains/report-evaluation/project/coverage.ts'
import type { ValuationScope, ValuationScopeService, ValuationScopes } from '../../domains/report-evaluation/scope.ts'
import { planFilePath } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import {
  PROJECT_RECORD_FILE,
  projectRecordOf,
} from '../../domains/report-evaluation/lifecycle/project-record.ts'
import type { OperationMap } from '../../operations/types.ts'
import type { ValuationWorkflowSnapshot } from '../../../shared/contracts/valuation-workflow.ts'
import type { ValuationQuestionEdit } from '../../../shared/contracts/valuation-questionnaire.ts'
import {
  createValuationWorkflowRuntime,
  type ValuationWorkflowRuntime,
  type ValuationWorkflowRuntimeStatus,
} from './runtime.ts'
import {
  evidenceFilesOf,
  verifyProtectedProject,
} from './production/project.ts'
import { createWorkflowProductionRunner } from './production/runner.ts'
import {
  WORKFLOW_GRAPH_ID,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_STEP_ID,
  hostStateOf,
  isLegacyPreparationFailure,
  openWorkflowStoreSession,
  overlayLiveSnapshot,
  validatedSnapshot,
  type WorkflowHostState,
  type WorkflowStoreSession,
} from './production/store.ts'
import type { WorkflowFrozenInput } from './production/types.ts'
import { projectStoredWorkflow, workflowGraphView } from './production/view.ts'
import { canRetryWorkflowIntent } from '../../domains/report-evaluation/workflow/intent-retry.ts'
import {
  compiledNodeIdOfStage,
  openCaseFile,
  parseArtifactRequest,
  parseWorkflowAction,
  parseWorkflowPreview,
  resolveWorkflowArtifact,
} from './production/operations.ts'
import {
  claimWorkflowParentMaintenance,
  dispatchOpaqueCommand,
  ensureWorkflowParent,
} from './production/sessions.ts'

const STORE_OPERATION = 'system.valuation-workflow.store' as const
/** Native bundle bound is 16Mi chars; refuse oversized input before parsing it. */
const MAX_SERIALIZED_CHARS = 16 * 1024 * 1024
const STORE_DIR = '.crwu'
const STORE_FILE = 'workflows.sqlite'

export interface ValuationWorkflowHostOptions {
  ctx: Context
  state: WorkspaceSessionState
  access: LocalAccessBroker
  world: WorldFacts
  config: WorkbenchConfig
  python?: PythonRuntimeResolver
  valuationScopes?: ValuationScopeService
}

export interface WorkflowPrepareHandoffInput {
  receipt: HandoffReceipt
  frozen: FrozenInput
}

export interface WorkflowPrepareHandoffResult {
  ok: boolean
  error?: string
  prompt: string
}

export interface ValuationWorkflowHost {
  runtime: ValuationWorkflowRuntime
  operations: OperationMap
  prepareHandoff(input: WorkflowPrepareHandoffInput): Promise<WorkflowPrepareHandoffResult>
  /** 关闭 store 路径落在给定工作空间下的连接；清空工作空间删 `.crwu` 前调用。 */
  closeWorkspaceStores(workspacePath: string): Promise<string[]>
  dispose(): Promise<void>
}

interface StoreWorkspace {
  id: string
  path: string
}

interface LocatedStore {
  path: string
  rootReal: string
}

type SessionRequirement =
  | { ok: true; session: WorkflowStoreSession; workspace: SelectedWorkspace; rootReal: string }
  | { ok: false; error: string; errorKind: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function codeOf(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
}

function inside(rootReal: string, target: string): boolean {
  const fold = process.platform === 'win32'
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value
  const rel = relative(fold(rootReal), fold(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function lstatOrNull(path: string): Promise<{ ok: true; info: Awaited<ReturnType<typeof lstat>> | null } | { ok: false }> {
  try {
    return { ok: true, info: await lstat(path) }
  } catch (error) {
    return codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'
      ? { ok: true, info: null }
      : { ok: false }
  }
}

/**
 * Resolve the Host-derived store location under a real workspace root.
 *
 * A `.crwu` directory or `workflows.sqlite` symlink that resolves outside the real
 * workspace is refused; neither the panel nor a model can supply this path.
 */
async function locateStore(workspacePath: string): Promise<{ ok: true; located: LocatedStore } | { ok: false; error: string }> {
  let rootReal: string
  try {
    rootReal = await realpath(workspacePath)
  } catch {
    return { ok: false, error: '选定的工作区不可解析' }
  }
  const dir = joinLocalPath(rootReal, STORE_DIR)
  const target = joinLocalPath(dir, STORE_FILE)
  const dirInfo = await lstatOrNull(dir)
  if (!dirInfo.ok) return { ok: false, error: '工作区存储目录不可检查' }
  if (dirInfo.info !== null) {
    if (dirInfo.info.isSymbolicLink()) {
      let resolved: string
      try {
        resolved = await realpath(dir)
      } catch {
        return { ok: false, error: '工作区存储目录不可解析' }
      }
      if (!inside(rootReal, resolved)) return { ok: false, error: '工作区存储目录越出选定工作区' }
    } else if (!dirInfo.info.isDirectory()) {
      return { ok: false, error: '工作区存储位置不是目录' }
    }
  }
  const fileInfo = await lstatOrNull(target)
  if (!fileInfo.ok) return { ok: false, error: '工作流存储不可检查' }
  if (fileInfo.info !== null && fileInfo.info.isSymbolicLink()) {
    let resolved: string
    try {
      resolved = await realpath(target)
    } catch {
      return { ok: false, error: '工作流存储不可解析' }
    }
    if (!inside(rootReal, resolved)) return { ok: false, error: '工作流存储越出选定工作区' }
  }
  return { ok: true, located: { path: target, rootReal } }
}

export function createValuationWorkflowHost(options: ValuationWorkflowHostOptions): ValuationWorkflowHost {
  const { ctx, state, access, world } = options
  const sessions = new Map<string, Promise<WorkflowStoreSession>>()
  const opened = new Set<WorkflowStoreSession>()
  /** Host-minted opaque command ids already delivered to the parent Agent. */
  const dispatchedCommands = new Set<string>()
  let disposed = false

  /**
   * Named local-access authorization, always before any optional service or FS read.
   * A denied decision is final; it never falls back to another source.
   */
  const authorizeStore = (source: LocalAccessSource, summary: string): { ok: boolean; error: string } => {
    const call = { operation: STORE_OPERATION, source }
    const decision = access.authorize(call)
    if (!decision.ok) return { ok: false, error: decision.error || '本机访问未获授权' }
    access.note(call, { summary })
    return { ok: true, error: '' }
  }

  /** The store's own guard re-authorizes and notes every read/write/checkpoint step. */
  const guardStore = (): { ok: boolean } => {
    const call = { operation: STORE_OPERATION, source: 'host-background' as LocalAccessSource }
    const decision = access.authorize(call)
    if (decision.ok) access.note(call, { summary: 'valuation workflow store guard' })
    return { ok: decision.ok }
  }

  const ensureStore = async (workspace: StoreWorkspace, located: LocatedStore): Promise<WorkflowStoreSession> => {
    const key = `${workspace.id}\u0000${located.path}`
    const cached = sessions.get(key)
    if (cached !== undefined) return await cached
    const opening = openWorkflowStoreSession({
      workspaceId: workspace.id,
      storePath: located.path,
      authorize: guardStore,
    }).then((session) => {
      opened.add(session)
      return session
    })
    sessions.set(key, opening)
    try {
      return await opening
    } catch (error) {
      sessions.delete(key)
      throw error
    }
  }

  const ensureStoreForScope = async (scope: ValuationScope): Promise<WorkflowStoreSession> => {
    const workspacePath = text(scope.workspacePath)
    if (workspacePath === '') throw new Error('本轮估值没有工作区路径')
    // Fresh named authorization precedes every filesystem or database touch here.
    const allowed = authorizeStore('host-background', 'valuation workflow runner store')
    if (!allowed.ok) throw new Error(allowed.error)
    const located = await locateStore(workspacePath)
    if (!located.ok) throw new Error(located.error)
    return await ensureStore({ id: text(scope.workspaceId), path: workspacePath }, located.located)
  }

  const requireSession = async (summary: string): Promise<SessionRequirement> => {
    const allowed = authorizeStore('panel', summary)
    if (!allowed.ok) return { ok: false, error: allowed.error, errorKind: 'policy' }
    const selected = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
    if (!selected.ok) return { ok: false, error: selected.error, errorKind: 'policy' }
    const located = await locateStore(selected.workspace.path)
    if (!located.ok) return { ok: false, error: located.error, errorKind: 'policy' }
    try {
      const session = await ensureStore(
        { id: selected.workspace.id, path: selected.workspace.path },
        located.located,
      )
      return { ok: true, session, workspace: selected.workspace, rootReal: located.located.rootReal }
    } catch {
      return { ok: false, error: '工作流存储不可用', errorKind: 'infrastructure' }
    }
  }

  /**
   * Read the one current record without ever turning a store/auth/corruption failure
   * into "no task". Only a real `null` means the task is absent.
   */
  const readRecordSafe = async (session: WorkflowStoreSession) => {
    try {
      return { ok: true as const, record: await session.read() }
    } catch {
      return { ok: false as const }
    }
  }

  /** Persisted writer occupancy: an active run, unknown stop, in-flight preparation or unsettled child. */
  const isOccupied = (record: { status?: unknown }, stored: WorkflowHostState): boolean =>
    record.status === 'running'
    || stored.stopUnknown !== null
    || stored.preparing === true
    || stored.journal.some((entry) => !entry.settled)

  const runtime = createValuationWorkflowRuntime({
    scopes: {
      get: (projectId: string) => options.valuationScopes?.get(projectId),
    },
    createRunner: async ({ scope, getExecution }) => {
      const session = await ensureStoreForScope(scope)
      const stored = await session.readState()
      if (stored === null || stored.frozen === null) {
        throw new Error('没有可用的冻结输入：拒绝创建工作流运行器')
      }
      const projectId = text(scope.projectId) || text(scope.valuationId)
      const runner = await createWorkflowProductionRunner({
        deps: {
          ctx,
          config: options.config,
          access,
          world,
          ...(options.python === undefined ? {} : { python: options.python }),
          ...(options.valuationScopes === undefined ? {} : { valuationScopes: options.valuationScopes }),
        },
        scope,
        frozenInput: stored.frozen as WorkflowFrozenInput,
        getExecution,
        checkpointer: session.checkpointer,
        // Reads the live scope after `replacePlans`, never a cached plan list.
        saveRun: async (dto) => await session.saveRun(
          dto,
          options.valuationScopes?.get(projectId)?.planIds,
        ),
        journalStarted: async (event) => await session.journalStarted(event),
        journalSettled: async (event) => await session.journalSettled(event),
        getPrepared: async () => await session.getPrepared(),
        savePrepared: async (result) => await session.savePrepared(result),
        getCalculationReceipt: async () => await session.getCalculationReceipt(),
        saveCalculationReceipt: async (receipt) => await session.saveCalculationReceipt(receipt),
      })
      const startInput = runner.startInput
      return {
        service: runner.service,
        startInput: async () => {
          // A durable preparation marker owns the writer before program material work;
          // a crash mid-preparation therefore leaves the task occupied, not idle.
          await session.beginPreparation()
          try {
            return await startInput()
          } catch (error) {
            // Persist the sanitized failure and keep preparation occupancy before rethrow.
            try {
              await session.recordStartFailure(error)
            } catch {
              // The original structured failure is still the authoritative one.
            }
            throw error
          }
        },
      }
    },
  })

  interface ProjectedResolution {
    phase: string
    snapshot: ValuationWorkflowSnapshot | null
    errorKind: string
    error: string
    occupied: boolean
    live: boolean
  }

  /** Router input context comes from the persisted DTO; never a model read. */
  const inputContextOf = (stored: WorkflowHostState): { userInput: string; materials: Array<{ materialId: string; fileName: string; digest: string; text?: string }> } | undefined => {
    const dto = stored.dto
    if (dto === null) return undefined
    return {
      userInput: text(dto.userInput),
      materials: Array.isArray(dto.materials) ? dto.materials : [],
    }
  }

  /**
   * Read-only projection resolver for one stored task.
   *
   * A resident runtime whose status matches the stored project/parent/run and is in a
   * live phase supplies the actual snapshot (current-attempt journal ids merged). When
   * there is no such resident, the cold native parse of the durable DTO is used, and an
   * active cold image is reported as stop-unknown rather than a false idle.
   */
  const resolveProjection = async (stored: WorkflowHostState): Promise<ProjectedResolution> => {
    let status: ValuationWorkflowRuntimeStatus | null = null
    try {
      status = await runtime.status(stored.projectId)
    } catch {
      status = null
    }
    const matching = status !== null
      && status.projectId === stored.projectId
      // Exact parent identity: a blank runtime parent is never a match for this task.
      && text(status.parentSessionId) === stored.parentSessionId
    const livePhase = matching && status !== null ? text(status.phase) : ''
    const runMatches = matching && status !== null
      && (status.snapshot === null || text(status.snapshot.runId) === stored.runId)
    const resident = matching && runMatches
      && (livePhase === 'running' || livePhase === 'preparing' || livePhase === 'awaiting-agent')
    if (resident && status !== null) {
      const liveSnapshot = status.snapshot === null
        ? null
        : overlayLiveSnapshot(status.snapshot, stored.journal)
      if (liveSnapshot !== null) {
        return {
          // A queued decision is authoritative even while the previous business
          // snapshot is still non-null: the Client must poll, not read it as applied.
          phase: livePhase === 'awaiting-agent' ? 'awaiting-agent' : liveSnapshot.status,
          snapshot: liveSnapshot,
          errorKind: liveSnapshot.errorKind,
          error: liveSnapshot.error,
          occupied: status.occupied === true,
          live: true,
        }
      }
      return {
        phase: livePhase,
        snapshot: null,
        errorKind: '',
        error: text(status.error),
        occupied: status.occupied === true,
        live: true,
      }
    }

    const cold = validatedSnapshot(stored.dto)
    if (cold === null) {
      // No resident run and no durable image: an explicit failure keeps its own phase,
      // any other preparation is occupancy with unknown quiescence, never "preparing".
      if (stored.phase === 'failed' || stored.phase === 'blocked') {
        return {
          phase: stored.phase,
          snapshot: null,
          errorKind: stored.errorKind || (stored.phase === 'blocked' ? 'blocked' : 'failed'),
          error: stored.error,
          occupied: true,
          live: false,
        }
      }
      return {
        phase: 'blocked',
        snapshot: null,
        errorKind: 'stop-unknown',
        error: stored.error || '本轮工作流没有可确认的静止状态：需要先在宿主侧对账',
        occupied: true,
        live: false,
      }
    }
    if (cold.stopUnknown !== null) {
      const stopped: ValuationWorkflowSnapshot = {
        ...cold,
        status: 'failed',
        outcome: 'failed',
        errorKind: 'stop-unknown',
        error: cold.error || stored.error || '运行在保存时仍在执行：子会话静止状态未知，需要先对账',
      }
      return {
        phase: stopped.status,
        snapshot: stopped,
        errorKind: 'stop-unknown',
        error: stopped.error,
        occupied: true,
        live: false,
      }
    }
    return {
      phase: cold.status,
      snapshot: cold,
      errorKind: cold.errorKind,
      error: cold.error,
      occupied: false,
      live: false,
    }
  }

  const prepareHandoff = async (
    input: WorkflowPrepareHandoffInput,
  ): Promise<WorkflowPrepareHandoffResult> => {
    const fail = (error: string): WorkflowPrepareHandoffResult => ({ ok: false, error, prompt: '' })
    const projectId = text(input.receipt.projectId)
    const parentSessionId = text(input.receipt.parentSessionId)
    const frozen = input.frozen
    if (projectId === '' || parentSessionId === '') return fail('缺少项目或父会话标识')
    if (!isRecord(frozen)) return fail('缺少冻结输入')
    if (text(frozen.projectId) !== projectId) return fail('冻结输入的项目归属不一致')
    if (text(frozen.inputDigest) === '') return fail('冻结输入缺少摘要')

    const allowed = authorizeStore('panel', 'prepare valuation workflow handoff')
    if (!allowed.ok) return fail(allowed.error)
    const selected = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
    if (!selected.ok) return fail(selected.error)

    const header = sessionHeader(ctx, parentSessionId)
    if (header === undefined) return fail('读不到父估值会话：不能确认这一轮的原生会话身份')
    if (text(header.parentSession) !== '') return fail('子会话不能作为根估值会话')
    const placement = await verifySessionInWorkspace(ctx, selected.workspace, parentSessionId)
    if (!placement.ok) return fail('父估值会话不属于选定的工作区')

    const verified = await verifyProtectedProject({
      workspacePath: selected.workspace.path,
      workspaceId: selected.workspace.id,
      projectId,
      parentSessionId,
      frozen: frozen as unknown as WorkflowFrozenInput,
    })
    if (!verified.ok) return fail(verified.error)

    const liveScope = options.valuationScopes?.get(projectId)
    if (liveScope === undefined) return fail('项目没有登记的估值范围：不能准备这一轮')
    if ((text(liveScope.parentSessionId) || text(liveScope.sessionId)) !== parentSessionId) {
      return fail('项目不属于当前父会话')
    }
    if (text(liveScope.workspaceId) !== '' && text(liveScope.workspaceId) !== selected.workspace.id) {
      return fail('项目的估值范围不属于选定工作区')
    }

    const located = await locateStore(selected.workspace.path)
    if (!located.ok) return fail(located.error)
    let session: WorkflowStoreSession
    try {
      session = await ensureStore(
        { id: selected.workspace.id, path: selected.workspace.path },
        located.located,
      )
    } catch {
      return fail('工作流存储不可用')
    }

    const existingRead = await readRecordSafe(session)
    if (!existingRead.ok) return fail('当前工作流状态读取失败：不能确认是否已有任务')
    const existingRecord = existingRead.record
    const existing = existingRecord === null ? null : hostStateOf(existingRecord)
    if (existingRecord !== null && existing === null) return fail('当前工作流状态不可读')
    if (existing !== null && existing.projectId !== projectId) {
      return fail('已经有另一轮当前估值任务：请先载入或清空当前任务')
    }
    if (existingRecord !== null && existing !== null && isOccupied(existingRecord, existing)) {
      return fail('上一轮仍在执行或停止状态未知：不能重新准备')
    }

    const initial: WorkflowHostState = {
      projectId,
      parentSessionId,
      workspaceId: selected.workspace.id,
      workspacePath: selected.workspace.path,
      casePath: verified.casePath,
      runId: projectId,
      frozen: frozen as unknown as WorkflowFrozenInput,
      planIds: [...(Array.isArray(liveScope.planIds) ? liveScope.planIds : [])],
      phase: existing?.phase ?? 'preparing',
      errorKind: existing?.errorKind ?? '',
      error: existing?.error ?? '',
      dto: existing?.dto ?? null,
      prepared: existing?.prepared ?? null,
      calculationReceipt: existing?.calculationReceipt ?? null,
      journal: existing?.journal ?? [],
      stopUnknown: existing?.stopUnknown ?? null,
      preparing: false,
    }
    // The single current task is durable before the runtime mints any command.
    try {
      await session.saveInitial(initial)
    } catch {
      return fail('当前工作流任务未能持久化：没有进入执行')
    }

    const registered = runtime.register({ projectId, parentSessionId })
    if (!registered.ok) {
      return fail(registered.error === undefined || registered.error === ''
        ? '工作流运行时没有接受这一轮项目'
        : registered.error)
    }
    return {
      ok: true,
      prompt: `请立即调用工具 crwu_valuation_workflow_run，commandId=${registered.commandId}。不要调用其它工具。`,
    }
  }

  const current = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requirement = await requireSession('valuation workflow current')
    if (!requirement.ok) {
      return { ok: false, empty: false, errorKind: requirement.errorKind, error: requirement.error }
    }
    const read = await readRecordSafe(requirement.session)
    if (!read.ok) {
      return {
        ok: false, empty: false, errorKind: 'infrastructure',
        error: '当前工作流状态读取失败：不能当作没有任务',
      }
    }
    const record = read.record
    if (record === null) {
      return {
        ok: true, empty: true, projectId: '', parentSessionId: '', runId: '', phase: 'idle',
        snapshot: null, progress: null, graph: null, errorKind: '', error: '',
      }
    }
    const stored = hostStateOf(record)
    if (stored === null) {
      return {
        ok: false, empty: false, errorKind: 'infrastructure',
        error: '当前工作流状态不可读：拒绝按旧记录继续',
      }
    }
    const requestedProject = text(args.projectId)
    if (requestedProject !== '' && requestedProject !== stored.projectId) {
      return { ok: false, empty: false, errorKind: 'not-found', error: '当前工作流不属于这个项目' }
    }
    const graph = await workflowGraphView().catch(() => null)
    const resolution = await resolveProjection(stored)
    if (resolution.snapshot === null) {
      return {
        ok: true,
        empty: false,
        projectId: stored.projectId,
        parentSessionId: stored.parentSessionId,
        runId: stored.runId,
        phase: resolution.phase,
        snapshot: null,
        progress: null,
        graph,
        errorKind: resolution.errorKind,
        error: resolution.error,
      }
    }
    const snapshot = resolution.snapshot
    const inputContext = inputContextOf(stored)
    const projected = graph === null
      ? null
      : projectStoredWorkflow({
        snapshot,
        graph,
        selectedNodeId: '',
        ...(inputContext === undefined ? {} : { inputContext }),
      })
    return {
      ok: true,
      empty: false,
      projectId: stored.projectId,
      parentSessionId: stored.parentSessionId,
      runId: snapshot.runId,
      phase: resolution.phase,
      snapshot,
      progress: projected?.progress ?? null,
      graph,
      errorKind: resolution.errorKind || snapshot.errorKind,
      error: resolution.error || snapshot.error,
    }
  }

  const node = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requirement = await requireSession('valuation workflow node')
    if (!requirement.ok) return { ok: false, errorKind: requirement.errorKind, error: requirement.error }
    const read = await readRecordSafe(requirement.session)
    if (!read.ok) return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态读取失败' }
    const record = read.record
    const stored = record === null ? null : hostStateOf(record)
    if (stored === null) return { ok: false, errorKind: 'not-found', error: '没有当前工作流任务' }
    const requestedProject = text(args.projectId)
    if (requestedProject !== '' && requestedProject !== stored.projectId) {
      return { ok: false, errorKind: 'not-found', error: '当前工作流不属于这个项目' }
    }
    const nodeId = text(args.nodeId)
    if (nodeId === '') return { ok: false, errorKind: 'input-invalid', error: '缺少要查看的节点标识' }
    const resolution = await resolveProjection(stored)
    if (resolution.snapshot === null) {
      return {
        ok: false,
        errorKind: resolution.errorKind || 'not-found',
        error: resolution.error || '这一轮还没有可查看的运行状态',
      }
    }
    const graph = await workflowGraphView()
    const snapshot = resolution.snapshot
    const inputContext = inputContextOf(stored)
    const projected = projectStoredWorkflow({
      snapshot,
      graph,
      selectedNodeId: nodeId,
      ...(inputContext === undefined ? {} : { inputContext }),
    })
    if (projected.detail === null) {
      return { ok: false, errorKind: 'not-found', error: '节点不在实际编译的估值图里' }
    }
    return {
      ok: true,
      projectId: stored.projectId,
      runId: snapshot.runId,
      revision: snapshot.revision,
      graph,
      detail: projected.detail,
      progress: projected.progress,
    }
  }

  const exportCurrent = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requirement = await requireSession('valuation workflow export')
    if (!requirement.ok) return { ok: false, errorKind: requirement.errorKind, error: requirement.error }
    const read = await readRecordSafe(requirement.session)
    if (!read.ok) return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态读取失败' }
    const record = read.record
    const stored = record === null ? null : hostStateOf(record)
    if (record === null || stored === null) {
      return { ok: false, errorKind: 'not-found', error: '没有可导出的当前工作流任务' }
    }
    const requestedProject = text(args.projectId)
    if (requestedProject !== '' && requestedProject !== stored.projectId) {
      return { ok: false, errorKind: 'not-found', error: '当前工作流不属于这个项目' }
    }
    if (isOccupied(record, stored)) {
      return { ok: false, errorKind: 'blocked', error: '当前任务仍在执行或停止状态未知：不能导出' }
    }
    const serialized = await requirement.session.store
      .exportCurrent(requirement.workspace.id, WORKFLOW_STEP_ID)
      .catch(() => null)
    if (serialized === null) return { ok: false, errorKind: 'infrastructure', error: '导出当前工作流失败' }
    return { ok: true, projectId: stored.projectId, serialized }
  }

  const load = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requirement = await requireSession('valuation workflow load')
    if (!requirement.ok) return { ok: false, errorKind: requirement.errorKind, error: requirement.error }
    const serialized = text(args.serialized)
    if (serialized === '') return { ok: false, errorKind: 'input-invalid', error: '缺少要导入的工作流内容' }
    if (serialized.length > MAX_SERIALIZED_CHARS) {
      return { ok: false, errorKind: 'input-invalid', error: '导入内容超出大小上限' }
    }
    const existingRead = await readRecordSafe(requirement.session)
    if (!existingRead.ok) return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态读取失败' }
    const existingRecord = existingRead.record
    const existing = existingRecord === null ? null : hostStateOf(existingRecord)
    if (existingRecord !== null && (existing === null || isOccupied(existingRecord, existing))) {
      return { ok: false, errorKind: 'blocked', error: '当前任务仍在执行或停止状态未知：不能载入' }
    }
    let bundle: unknown
    try {
      bundle = JSON.parse(serialized) as unknown
    } catch {
      return { ok: false, errorKind: 'input-invalid', error: '导入内容无法解析' }
    }
    if (!isRecord(bundle) || bundle.format !== 'crwu.workflow.bundle.v1') {
      return { ok: false, errorKind: 'input-invalid', error: '导入格式不受支持' }
    }
    const identity = {
      workspaceId: requirement.workspace.id,
      stepId: WORKFLOW_STEP_ID,
    }
    if (bundle.workspaceId !== identity.workspaceId || bundle.stepId !== identity.stepId) {
      return { ok: false, errorKind: 'conflict', error: '导入任务不属于当前工作区或步骤' }
    }
    if (bundle.graphId !== WORKFLOW_GRAPH_ID || bundle.graphVersion !== WORKFLOW_GRAPH_VERSION) {
      return { ok: false, errorKind: 'conflict', error: '导入任务不属于受支持的估值图版本' }
    }
    const record = isRecord(bundle.current) ? bundle.current as unknown as Parameters<typeof hostStateOf>[0] : null
    const stored = record === null ? null : hostStateOf(record)
    if (stored === null) return { ok: false, errorKind: 'input-invalid', error: '导入任务缺少可读的当前状态' }
    if (stored.workspaceId !== requirement.workspace.id) {
      return { ok: false, errorKind: 'conflict', error: '导入任务不属于当前工作区' }
    }
    if (stored.parentSessionId === '' || !isSafeIdSegment(stored.projectId)) {
      return { ok: false, errorKind: 'input-invalid', error: '导入任务缺少项目或父会话标识' }
    }
    // The published record must carry the Host-derived paths for this selected
    // workspace: a bundle that keeps only the workspace id but swaps its paths is refused.
    const storedWorkspaceKey = await pathKey(ctx, stored.workspacePath)
    const selectedWorkspaceKey = await pathKey(ctx, requirement.workspace.path)
    const storedCaseKey = await pathKey(ctx, stored.casePath)
    const derivedCaseKey = await pathKey(ctx, joinLocalPath(requirement.workspace.path, stored.projectId))
    if (storedWorkspaceKey === '' || selectedWorkspaceKey === '' || storedWorkspaceKey !== selectedWorkspaceKey
      || storedCaseKey === '' || derivedCaseKey === '' || storedCaseKey !== derivedCaseKey) {
      return { ok: false, errorKind: 'conflict', error: '导入任务的记录路径不属于选定工作区' }
    }
    if (isOccupied(record as unknown as { status?: unknown }, stored)) {
      return { ok: false, errorKind: 'blocked', error: '导入任务仍在执行或停止状态未知：不能载入' }
    }
    if (stored.frozen === null || text(stored.frozen.inputDigest) === '') {
      return { ok: false, errorKind: 'input-invalid', error: '导入任务缺少冻结输入' }
    }
    // A present durable DTO must be a valid native image before anything is published.
    if (stored.dto !== null && validatedSnapshot(stored.dto) === null) {
      return { ok: false, errorKind: 'input-invalid', error: '导入任务的运行状态不是有效的原生运行镜像' }
    }
    const header = sessionHeader(ctx, stored.parentSessionId)
    if (header === undefined || text(header.parentSession) !== '') {
      return { ok: false, errorKind: 'policy', error: '导入任务的父会话不是仍可归属的顶层原生会话' }
    }
    const placement = await verifySessionInWorkspace(ctx, requirement.workspace, stored.parentSessionId)
    if (!placement.ok) return { ok: false, errorKind: 'policy', error: '导入任务的父会话不属于选定工作区' }
    const receipt = stored.calculationReceipt
    const receiptArtifacts = (receipt?.artifacts ?? []).map((artifact) => ({
      relativePath: text(artifact.relativePath)
        || planFilePath(receipt === null ? '' : text(receipt.planId), text(artifact.name), receipt === null ? 0 : receipt.revision),
      digest: text(artifact.digest),
      sizeBytes: artifact.bytes,
    }))
    const verified = await verifyProtectedProject({
      workspacePath: requirement.workspace.path,
      workspaceId: requirement.workspace.id,
      projectId: stored.projectId,
      parentSessionId: stored.parentSessionId,
      frozen: stored.frozen,
      extraFiles: [...evidenceFilesOf(stored.dto), ...receiptArtifacts],
    })
    if (!verified.ok) return { ok: false, errorKind: 'conflict', error: verified.error }
    try {
      await requirement.session.store.importCurrent(serialized, {
        workspaceId: requirement.workspace.id,
        stepId: WORKFLOW_STEP_ID,
        graphId: WORKFLOW_GRAPH_ID,
        graphVersion: WORKFLOW_GRAPH_VERSION,
      })
    } catch {
      return { ok: false, errorKind: 'input-invalid', error: '导入内容未通过完整校验：当前任务保持不变' }
    }
    return { ok: true, projectId: stored.projectId }
  }

  const clear = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requirement = await requireSession('valuation workflow clear')
    if (!requirement.ok) return { ok: false, errorKind: requirement.errorKind, error: requirement.error }
    const requestedProject = text(args.projectId)
    const read = await readRecordSafe(requirement.session)
    if (!read.ok) return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态读取失败' }
    let record = read.record
    if (record === null) return { ok: true, projectId: requestedProject, cleared: false }
    let stored = hostStateOf(record)
    if (stored === null) {
      return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态不可读：不能清空' }
    }
    if (requestedProject !== '' && requestedProject !== stored.projectId) {
      return { ok: false, errorKind: 'not-found', error: '当前工作流不属于这个项目' }
    }
    // Compare the exact identity before waiting: a replacement task may become current
    // while cancellation is in flight, and it must never be released or cleared.
    const observed = {
      projectId: stored.projectId,
      runId: stored.runId,
      recordRunId: record.runId,
      parentSessionId: stored.parentSessionId,
      workspaceId: stored.workspaceId,
      casePath: stored.casePath,
    }
    if (isOccupied(record, stored)) {
      // Stop preparation/execution first; a refusal keeps the current pointer.
      const cancelled = await runtime.cancel(stored.projectId)
      if (!cancelled.ok) {
        return { ok: false, errorKind: 'blocked', error: cancelled.error || '当前任务仍在执行或停止状态未知：不能清空' }
      }
      const recheck = await readRecordSafe(requirement.session)
      if (!recheck.ok) return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态读取失败' }
      const recheckRecord = recheck.record
      if (recheckRecord === null) return { ok: true, projectId: observed.projectId, cleared: false }
      const recheckStored = hostStateOf(recheckRecord)
      if (recheckStored === null) {
        return { ok: false, errorKind: 'infrastructure', error: '当前工作流状态不可读：不能清空' }
      }
      const replaced = recheckStored.projectId !== observed.projectId
        || recheckStored.runId !== observed.runId
        || recheckStored.parentSessionId !== observed.parentSessionId
        || recheckStored.workspaceId !== observed.workspaceId
        || recheckStored.casePath !== observed.casePath
        || recheckRecord.runId !== observed.recordRunId
      if (replaced) {
        return { ok: false, errorKind: 'blocked', error: '等待停止期间当前任务已被替换：请重新读取后再操作' }
      }
      if (isOccupied(recheckRecord, recheckStored)) {
        return { ok: false, errorKind: 'blocked', error: '停止尚未确认：当前任务仍持有执行，不能清空' }
      }
      record = recheckRecord
      stored = recheckStored
    }
    // The Host-owned runtime verdict comes before any deletion: a refused release keeps
    // the durable record, so the next read still has the actual project identity.
    const released = runtime.release(stored.projectId)
    if (!released.ok) {
      return { ok: false, errorKind: 'blocked', error: released.error || '当前项目仍持有活动执行，不能清空' }
    }
    const cleared = await requirement.session.store
      .clearCurrent(requirement.workspace.id, WORKFLOW_STEP_ID, record.runId)
      .catch(() => false)
    if (!cleared) return { ok: false, errorKind: 'infrastructure', error: '清空当前工作流失败' }
    // Archived materials and deliverables stay; only DB current/checkpoints are removed.
    return { ok: true, projectId: stored.projectId, cleared: true }
  }

  type StoredRecord = NonNullable<Awaited<ReturnType<WorkflowStoreSession['read']>>>
  type StoredTask =
    | { ok: true; requirement: Extract<SessionRequirement, { ok: true }>; record: StoredRecord; stored: WorkflowHostState }
    | { ok: false; result: Record<string, unknown> }

  /**
   * The shared panel read for the advanced handlers: named authorization first, then
   * the one current record. A missing or unreadable record never becomes a success.
   */
  const requireStoredTask = async (
    summary: string,
    args: Record<string, unknown>,
  ): Promise<StoredTask> => {
    const requirement = await requireSession(summary)
    if (!requirement.ok) {
      return { ok: false, result: { ok: false, errorKind: requirement.errorKind, error: requirement.error } }
    }
    const read = await readRecordSafe(requirement.session)
    if (!read.ok) {
      return { ok: false, result: { ok: false, errorKind: 'infrastructure', error: '当前工作流状态读取失败' } }
    }
    const record = read.record
    const stored = record === null ? null : hostStateOf(record)
    if (record === null || stored === null) {
      return { ok: false, result: { ok: false, errorKind: 'not-found', error: '没有当前工作流任务' } }
    }
    const requestedProject = text(args.projectId)
    if (requestedProject !== '' && requestedProject !== stored.projectId) {
      return { ok: false, result: { ok: false, errorKind: 'not-found', error: '当前工作流不属于这个项目' } }
    }
    // Pin the recorded paths to the selected workspace before any advanced request:
    // the selected workspace is authoritative, never the stored path strings.
    if (stored.workspaceId !== requirement.workspace.id || !isSafeIdSegment(stored.projectId)) {
      return { ok: false, result: { ok: false, errorKind: 'conflict', error: '当前任务的记录不属于选定工作区' } }
    }
    const storedWorkspaceKey = await pathKey(ctx, stored.workspacePath)
    const selectedWorkspaceKey = await pathKey(ctx, requirement.workspace.path)
    const storedCaseKey = await pathKey(ctx, stored.casePath)
    const derivedCaseKey = await pathKey(ctx, joinLocalPath(requirement.workspace.path, stored.projectId))
    if (storedWorkspaceKey === '' || selectedWorkspaceKey === '' || storedWorkspaceKey !== selectedWorkspaceKey
      || storedCaseKey === '' || derivedCaseKey === '' || storedCaseKey !== derivedCaseKey) {
      return { ok: false, result: { ok: false, errorKind: 'conflict', error: '当前任务的记录路径不属于选定工作区' } }
    }
    return { ok: true, requirement, record, stored }
  }

  /**
   * Re-prove the protected record, frozen input and every evidenced byte.
   *
   * The selected workspace path/id are authoritative; the stored strings are never
   * used as the verification root.
   */
  const reverifyProtected = async (
    stored: WorkflowHostState,
    workspace: SelectedWorkspace,
    extra?: { relativePath: string; digest: string; sizeBytes?: number },
  ): Promise<{ ok: boolean; error: string; casePath: string }> => {
    if (stored.frozen === null) {
      return { ok: false, error: '缺少冻结输入：不能确认这一轮的项目身份', casePath: '' }
    }
    const receipt = stored.calculationReceipt
    const receiptArtifacts = (receipt?.artifacts ?? []).map((artifact) => ({
      relativePath: text(artifact.relativePath)
        || planFilePath(text(receipt?.planId), text(artifact.name), receipt?.revision ?? 0),
      digest: text(artifact.digest),
      sizeBytes: artifact.bytes,
    }))
    const verified = await verifyProtectedProject({
      workspacePath: workspace.path,
      workspaceId: workspace.id,
      projectId: stored.projectId,
      parentSessionId: stored.parentSessionId,
      frozen: stored.frozen,
      extraFiles: [
        ...evidenceFilesOf(stored.dto),
        ...receiptArtifacts,
        ...(extra === undefined ? [] : [extra]),
      ],
    })
    return { ok: verified.ok, error: verified.error, casePath: verified.casePath }
  }

  /** The protected record's own creation time; absent is an empty string, never a guess. */
  const projectCreatedAt = async (casePath: string): Promise<string> => {
    const raw = await readFile(joinLocalPath(casePath, PROJECT_RECORD_FILE), 'utf8').catch(() => null)
    if (raw === null) return ''
    try {
      const parsed = projectRecordOf(JSON.parse(raw) as unknown)
      return parsed.ok ? text(parsed.record.createdAt) : ''
    } catch {
      return ''
    }
  }

  /**
   * Reopen the live scope of a cold task from its verified protected record and frozen
   * input. An already-registered scope is only accepted when its parent, workspace id and
   * workspace path are the selected ones; a foreign same-project scope is refused.
   */
  const openStoredScope = async (
    stored: WorkflowHostState,
    workspace: SelectedWorkspace,
  ): Promise<{ ok: boolean; error: string }> => {
    const service = options.valuationScopes as ValuationScopes | undefined
    if (service === undefined) return { ok: false, error: '这个部署没有登记估值范围：不能恢复这一轮' }
    const existing = service.get(stored.projectId)
    if (existing !== undefined) {
      const liveParent = text(existing.parentSessionId) || text(existing.sessionId)
      if (liveParent !== stored.parentSessionId || text(existing.workspaceId) !== workspace.id) {
        return { ok: false, error: '现有估值范围不属于记录的父会话或选定工作区' }
      }
      const liveKey = await pathKey(ctx, existing.workspacePath)
      const selectedKey = await pathKey(ctx, workspace.path)
      if (liveKey === '' || selectedKey === '' || liveKey !== selectedKey) {
        return { ok: false, error: '现有估值范围的工作区路径与选定工作区不一致' }
      }
      return { ok: true, error: '' }
    }
    if (stored.frozen === null) return { ok: false, error: '缺少冻结输入：不能恢复这一轮' }
    const verified = await reverifyProtected(stored, workspace)
    if (!verified.ok) return { ok: false, error: verified.error }
    const frozen = stored.frozen
    // 方法必须是一个指定方法：旧冻结输入里的 auto（或空值）在这里明确拒绝，
    // 不替它默认成任何一种方法。
    const methodRequest = text(frozen.methodRequest)
    if (!isMethodRequest(methodRequest)) {
      return {
        ok: false,
        error: `冻结输入里的评估方法不合法（${methodRequest || '空'}）：只允许 market / income / cost`,
      }
    }
    const assetType = normalizeAssetType(frozen.assetType)
    if (!assetType.ok) return { ok: false, error: `冻结输入里的资产类型不可用：${assetType.error}` }
    const casePath = text(verified.casePath) || joinLocalPath(workspace.path, stored.projectId)
    service.open({
      valuationId: stored.projectId,
      projectId: stored.projectId,
      previewId: stored.projectId,
      sessionId: stored.parentSessionId,
      parentSessionId: stored.parentSessionId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      casePath,
      openedAt: Date.now(),
      planIds: [...stored.planIds],
      snapshot: {
        valuationId: stored.projectId,
        method: methodRequest as ValuationScope['snapshot']['method'],
        baseDate: text(frozen.baseDate),
        purpose: text(frozen.purpose),
        valueType: text(frozen.valueType),
        supplementalPrompt: text(frozen.supplementalPrompt),
        assetType: assetType.value,
        templateFileId: frozen.templateFileId ?? null,
        digest: text(frozen.inputDigest),
        files: (frozen.files ?? []).map((file) => ({
          fileName: text(file.fileName),
          relativePath: text(file.relativePath) || text(file.archiveRelativePath),
          sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : 0,
          kind: text(file.kind),
          sha256: text(file.sha256),
        })),
        frozenAt: await projectCreatedAt(casePath),
      },
    })
    return { ok: true, error: '' }
  }

  /**
   * Hydrate the exact runtime for a stored task without any material preparation or
   * model call: open the verified scope and, when a durable DTO exists, restore the
   * saved run under the same project/parent. A resident exact-parent runtime is left
   * untouched. The caller keeps the occupancy refusal for preparing/unsettled/stopUnknown.
   */
  const ensureRuntimeForStored = async (
    stored: WorkflowHostState,
    workspace: SelectedWorkspace,
  ): Promise<{ ok: boolean; error: string }> => {
    const opened = await openStoredScope(stored, workspace)
    if (!opened.ok) return opened
    if (stored.dto === null) return { ok: true, error: '' }
    const resident = await runtime.status(stored.projectId).catch(() => null)
    const registered = resident !== null && text(resident.parentSessionId) === stored.parentSessionId
    if (registered) return { ok: true, error: '' }
    const restored = await runtime.restore({
      projectId: stored.projectId,
      parentSessionId: stored.parentSessionId,
      run: stored.dto,
    })
    return restored.ok ? { ok: true, error: '' } : { ok: false, error: text(restored.error) || '恢复运行状态未被接受' }
  }

  /** Deliver one opaque command to the exact recorded parent, at most once per id. */
  const deliverCommand = async (
    requirement: Extract<SessionRequirement, { ok: true }>,
    stored: WorkflowHostState,
    commandId: string,
  ): Promise<{ accepted: boolean; error: string }> => {
    if (commandId === '') return { accepted: false, error: '宿主没有铸出可下发的命令标识' }
    if (dispatchedCommands.has(commandId)) return { accepted: true, error: '' }
    const ensured = await ensureWorkflowParent({
      ctx,
      state,
      workspace: requirement.workspace,
      parentSessionId: stored.parentSessionId,
    })
    if (!ensured.ok) return { accepted: false, error: ensured.error }
    const sent = dispatchOpaqueCommand(ctx, stored.parentSessionId, commandId)
    if (sent.accepted) dispatchedCommands.add(commandId)
    return sent
  }

  const action = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = await requireStoredTask('valuation workflow action', args)
    if (!task.ok) return task.result
    const { requirement, record, stored } = task
    const graph = await workflowGraphView().catch(() => null)
    const parsed = parseWorkflowAction(args, graph)
    if (!parsed.ok || parsed.payload === null) {
      return { ok: false, errorKind: 'input-invalid', error: parsed.error }
    }
    const actionKind = parsed.action
    const payload = parsed.payload
    if (actionKind === '' || payload === null) {
      return { ok: false, errorKind: 'input-invalid', error: '不支持的命令动作' }
    }
    const dtoActive = stored.dto !== null && stored.dto.active === true
    if (actionKind !== 'questions-draft' && (isOccupied(record, stored) || dtoActive)) {
      return { ok: false, errorKind: 'blocked', error: '当前任务仍在执行或停止状态未知：不能提交决定' }
    }
    // The actual protected bytes are re-proved before a command is minted, even for a
    // resident live graph: a changed or missing archive/template/evidence/receipt refuses.
    const reverified = await reverifyProtected(stored, requirement.workspace)
    if (!reverified.ok) return { ok: false, errorKind: 'conflict', error: reverified.error }
    // A valid cold stopped image is hydrated here; a live exact-parent runtime is kept.
    const hydrated = await ensureRuntimeForStored(stored, requirement.workspace)
    if (!hydrated.ok) return { ok: false, errorKind: 'blocked', error: hydrated.error }
    const resolution = await resolveProjection(stored)
    const snapshot = resolution.snapshot
    if (snapshot === null) {
      return { ok: false, errorKind: 'blocked', error: resolution.error || '这一轮还没有可依据的运行版本' }
    }
    if (actionKind !== 'questions-submit' && snapshot.revision !== Number(payload.expectedRevision)) {
      return { ok: false, errorKind: 'stale-revision', error: '命令基于的版本已经过期', revision: snapshot.revision,
        snapshot, questionnaire: snapshot.questionnaire }
    }
    if (actionKind === 'questions-draft') {
      const saved = await runtime.saveDraft(stored.projectId, payload as unknown as ValuationQuestionEdit)
      const latest = saved.snapshot
      const projected = latest === null || graph === null ? null : projectStoredWorkflow({
        snapshot: latest, graph, selectedNodeId: '',
      })
      return { ...saved, projectId: stored.projectId, questionnaire: projected?.progress.questionnaire ?? latest?.questionnaire,
        progress: projected?.progress ?? null }
    }
    const queued = runtime.queue(stored.projectId, { action: actionKind, payload })
    if (!queued.ok) {
      return { ok: false, errorKind: 'blocked', error: queued.error || '决定未能进入工作流命令队列' }
    }
    const delivered = await deliverCommand(requirement, stored, queued.commandId)
    if (!delivered.accepted) {
      return { ok: false, errorKind: 'blocked', error: delivered.error, commandId: queued.commandId }
    }
    return { ok: true, projectId: stored.projectId, commandId: queued.commandId, stage: parsed.stage }
  }

  const preview = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = await requireStoredTask('valuation workflow preview', args)
    if (!task.ok) return task.result
    const { stored } = task
    const graph = await workflowGraphView().catch(() => null)
    // A client may send the preview intent flat or nested under `payload`; both are
    // reduced to the same closed shape before parsing.
    const previewSource = isRecord(args.payload)
      ? { ...(text(args.projectId) === '' ? {} : { projectId: args.projectId }), ...args.payload }
      : args
    const parsed = parseWorkflowPreview(previewSource, graph)
    if (!parsed.ok || parsed.stage === '') {
      return { ok: false, errorKind: 'input-invalid', error: parsed.error }
    }
    const stage = parsed.stage
    const resolution = await resolveProjection(stored)
    const snapshot = resolution.snapshot
    if (snapshot === null) {
      return { ok: false, errorKind: 'blocked', error: resolution.error || '这一轮还没有可预览的运行版本' }
    }
    if (snapshot.revision !== parsed.expectedRevision) {
      return { ok: false, errorKind: 'stale-revision', error: '预览基于的版本已经过期', revision: snapshot.revision }
    }
    const projected = runtime.preview(stored.projectId, stage, parsed.changes, parsed.expectedRevision)
    if (!projected.ok) {
      return { ok: false, errorKind: 'input-invalid', error: projected.error || '修订预览不可用' }
    }
    const supersededNodeIds = projected.supersededNodeIds
      .map((entry) => compiledNodeIdOfStage(graph, entry))
      .filter((nodeId) => nodeId !== '')
    return {
      ok: true,
      projectId: stored.projectId,
      nodeId: parsed.nodeId,
      stage,
      revision: snapshot.revision,
      expectedRevision: parsed.expectedRevision,
      supersededNodeIds,
      changes: projected.changes,
    }
  }

  const cancel = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = await requireStoredTask('valuation workflow cancel', args)
    if (!task.ok) return task.result
    const { stored } = task
    // Cancellation never resets occupancy and never clears the durable record.
    const cancelled = await runtime.cancel(stored.projectId)
    if (!cancelled.ok) {
      return { ok: false, errorKind: 'blocked', error: cancelled.error || '取消未能送达工作流' }
    }
    return { ok: true, projectId: stored.projectId, cancelled: true }
  }

  type LegacyPreparationRecovery =
    | { ok: true; stored: WorkflowHostState }
    | { ok: false; error: string }

  /**
   * Explicitly repair one exact legacy pregraph environment failure.
   *
   * `requireStoredTask` already took the named panel authorization for this request.
   * Protected project and frozen bytes plus the recorded native parent placement are
   * re-proved before any mutation, and the durable marker is cleared only inside the
   * real idle maintenance claim of that same parent. Command delivery stays outside
   * the claim, after it settles.
   */
  const recoverLegacyPreparation = async (
    requirement: Extract<SessionRequirement, { ok: true }>,
    stored: WorkflowHostState,
  ): Promise<LegacyPreparationRecovery> => {
    const header = sessionHeader(ctx, stored.parentSessionId)
    if (header === undefined || text(header.parentSession) !== '') {
      return { ok: false, error: '记录的父会话不是可归属的顶层原生会话：不能修复旧版准备标记' }
    }
    const placement = await verifySessionInWorkspace(ctx, requirement.workspace, stored.parentSessionId)
    if (!placement.ok) {
      return { ok: false, error: '记录的父会话不属于选定工作区：不能修复旧版准备标记' }
    }
    const reverified = await reverifyProtected(stored, requirement.workspace)
    if (!reverified.ok) return { ok: false, error: reverified.error }

    const claim = await claimWorkflowParentMaintenance({
      ctx,
      sessionId: stored.parentSessionId,
      task: async (signal: AbortSignal) => {
        if (signal.aborted) {
          return { ok: false, error: '父会话维护已取消：保持准备占用' }
        }
        // Under the atomic idle claim no resident runtime may own this task's writer.
        const residentResult = await runtime.status(stored.projectId).then(
          (status) => ({ ok: true as const, status }),
          () => ({ ok: false as const }),
        )
        if (!residentResult.ok) {
          return { ok: false, error: '宿主运行状态不可确认：保持准备占用' }
        }
        const resident = residentResult.status
        const residentParent = text(resident.parentSessionId)
        if (residentParent !== '') {
          const phase = text(resident.phase)
          if (resident.occupied === true
            || phase === 'running' || phase === 'preparing' || phase === 'awaiting-agent') {
            return { ok: false, error: '这一轮仍在宿主侧执行：保持准备占用' }
          }
          if (residentParent !== stored.parentSessionId) {
            return { ok: false, error: '这一轮已登记到其它父会话：不能修复当前标记' }
          }
        }
        if (signal.aborted) {
          return { ok: false, error: '父会话维护已取消：保持准备占用' }
        }
        const repaired = await requirement.session.repairLegacyPreparationFailure({
          projectId: stored.projectId,
          parentSessionId: stored.parentSessionId,
        })
        return repaired.ok
          ? { ok: true, error: '' }
          : { ok: false, error: repaired.error }
      },
    })
    if (!claim.ok) return { ok: false, error: claim.error }

    const latestRead = await readRecordSafe(requirement.session)
    if (!latestRead.ok) return { ok: false, error: '修复后当前工作流状态读取失败' }
    const latestRecord = latestRead.record
    if (latestRecord === null) return { ok: false, error: '修复后当前工作流状态不可读' }
    const latest = hostStateOf(latestRecord)
    if (latest === null) return { ok: false, error: '修复后当前工作流状态不可读' }
    if (latest.projectId !== stored.projectId || latest.parentSessionId !== stored.parentSessionId) {
      return { ok: false, error: '修复后的任务身份与记录的父会话不一致' }
    }
    if (isOccupied(latestRecord, latest)) {
      return { ok: false, error: '修复后任务仍处于占用状态：保持当前记录' }
    }
    return { ok: true, stored: latest }
  }

  const reconcile = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = await requireStoredTask('valuation workflow reconcile', args)
    if (!task.ok) return task.result
    const { requirement, record } = task
    let stored = task.stored
    const dtoActive = stored.dto !== null && stored.dto.active === true
    if (isOccupied(record, stored) || dtoActive) {
      // Only the exact legacy pregraph environment marker may be explicitly repaired;
      // every other occupied image stays an honest unknown-stop block.
      if (!isLegacyPreparationFailure(stored)) {
        return {
          ok: false,
          errorKind: 'stop-unknown',
          error: '停止状态未知：这一轮仍有未证实的子会话或准备占用，当前版本不自动对账',
          projectId: stored.projectId,
        }
      }
      const recovered = await recoverLegacyPreparation(requirement, stored)
      if (!recovered.ok) {
        return { ok: false, errorKind: 'blocked', error: recovered.error, projectId: stored.projectId }
      }
      stored = recovered.stored
    }
    const reverified = await reverifyProtected(stored, requirement.workspace)
    if (!reverified.ok) return { ok: false, errorKind: 'conflict', error: reverified.error }
    const hydrated = await ensureRuntimeForStored(stored, requirement.workspace)
    if (!hydrated.ok) return { ok: false, errorKind: 'blocked', error: hydrated.error }
    if (stored.dto !== null) {
      // A stopped intent-only graph may be explicitly retried under the same project
      // and native parent: the durable frozen inputs are reused, no material is read
      // again and no new session or workspace is created. Every other stopped image
      // stays restored-only for an explicit decision.
      const resident = await runtime.status(stored.projectId).catch(() => null)
      const snapshot = resident?.snapshot ?? null
      if (resident !== null
        && text(resident.parentSessionId) === stored.parentSessionId
        && resident.occupied === false
        && snapshot !== null
        && canRetryWorkflowIntent(snapshot)) {
        const queued = runtime.queue(stored.projectId, {
          action: 'retry-intent',
          payload: {
            expectedRevision: snapshot.revision,
            // A new Host lifetime must never reuse a submission identity that the
            // persisted run already consumed, or the service would refuse it as a
            // duplicate and the task would stay stopped forever.
            submissionId: `reconcile-intent-${randomUUID()}`,
          },
        })
        if (!queued.ok) {
          return { ok: false, errorKind: 'blocked', error: queued.error || '意图重试命令未能进入工作流命令队列' }
        }
        const delivered = await deliverCommand(requirement, stored, queued.commandId)
        if (!delivered.accepted) {
          return { ok: false, errorKind: 'blocked', error: delivered.error, commandId: queued.commandId }
        }
        return { ok: true, projectId: stored.projectId, commandId: queued.commandId, resumed: true }
      }
      return { ok: true, projectId: stored.projectId, restored: true, resumed: false }
    }
    // A settled pregraph failure leaves the live controller's start command done, so
    // replaying it would only return the cached failure. Retire exactly that idle
    // failed controller so the same parent receives a genuinely fresh attempt.
    const resident = await runtime.status(stored.projectId).catch(() => null)
    const settledResidentFailure = resident !== null
      && text(resident.parentSessionId) === stored.parentSessionId
      && text(resident.phase) === 'failed'
      && resident.occupied === false
      && resident.snapshot === null
      && stored.phase === 'failed'
      && stored.preparing === false
      && stored.journal.length === 0
      && stored.stopUnknown === null
    if (settledResidentFailure) {
      const released = runtime.release(stored.projectId)
      if (!released.ok) {
        return {
          ok: false,
          errorKind: 'blocked',
          error: released.error || '上一轮启动失败未能释放，不能重新下发',
        }
      }
    }
    const registered = runtime.register({
      projectId: stored.projectId,
      parentSessionId: stored.parentSessionId,
    })
    if (!registered.ok) {
      return { ok: false, errorKind: 'blocked', error: registered.error || '工作流运行时没有接受这一轮项目' }
    }
    const delivered = await deliverCommand(requirement, stored, registered.commandId)
    if (!delivered.accepted) {
      return { ok: false, errorKind: 'blocked', error: delivered.error, commandId: registered.commandId }
    }
    return { ok: true, projectId: stored.projectId, commandId: registered.commandId, resumed: true }
  }

  const openArtifact = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = await requireStoredTask('valuation workflow open artifact', args)
    if (!task.ok) return task.result
    const { requirement, stored } = task
    const request = parseArtifactRequest(args)
    if (!request.ok || request.kind === '') {
      return { ok: false, errorKind: 'input-invalid', error: request.error }
    }
    const kind = request.kind
    const resolved = resolveWorkflowArtifact({
      kind,
      dto: stored.dto,
      receipt: stored.calculationReceipt,
    })
    if (!resolved.ok || resolved.artifact === null) {
      return { ok: false, errorKind: 'not-found', error: resolved.error }
    }
    const artifact = resolved.artifact
    const verified = await reverifyProtected(stored, requirement.workspace, {
      relativePath: artifact.relativePath,
      digest: artifact.digest,
      ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
    })
    if (!verified.ok) return { ok: false, errorKind: 'conflict', error: verified.error }
    // The platform and workdir are capability facts: a failed probe is a structured
    // infrastructure failure, never a guessed default that could open the wrong thing.
    let platform = ''
    let workdir = ''
    try {
      platform = text(await world.platform())
      workdir = text(await world.workdir())
    } catch {
      return {
        ok: false,
        projectId: stored.projectId,
        kind: artifact.kind,
        label: artifact.label,
        errorKind: 'infrastructure',
        error: '本机平台或工作目录探测失败：无法打开文件，请稍后重试',
      }
    }
    if (platform === '' || workdir === '') {
      return {
        ok: false,
        projectId: stored.projectId,
        kind: artifact.kind,
        label: artifact.label,
        errorKind: 'infrastructure',
        error: '本机平台或工作目录不可用：无法打开文件',
      }
    }
    const casePath = verified.casePath
    const opened = await openCaseFile({
      access,
      platform,
      workdir,
      casePath,
      relativePath: artifact.relativePath,
    })
    return {
      ok: opened.ok,
      projectId: stored.projectId,
      kind: artifact.kind,
      label: artifact.label,
      referenceMode: artifact.referenceMode,
      errorKind: opened.ok ? '' : 'infrastructure',
      error: opened.error,
    }
  }

  const operations: OperationMap = {
    'valuation-workflow-current': current,
    'valuation-workflow-node': node,
    'valuation-workflow-action': action,
    'valuation-workflow-preview': preview,
    'valuation-workflow-cancel': cancel,
    'valuation-workflow-export': exportCurrent,
    'valuation-workflow-load': load,
    'valuation-workflow-clear': clear,
    'valuation-workflow-reconcile': reconcile,
    'valuation-workflow-open-artifact': openArtifact,
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      runtime.dispose()
    } catch {
      // Disposal is best-effort; a broken handle must not block the rest.
    }
    for (const session of opened) {
      try {
        await session.close()
      } catch {
        // A close failure leaves no usable state behind; continue closing others.
      }
    }
    opened.clear()
    sessions.clear()
  }

  const closeWorkspaceStores = async (workspacePath: string): Promise<string[]> =>
    await closeStoresUnder(sessions, opened, workspacePath)

  return { runtime, operations, prepareHandoff, closeWorkspaceStores, dispose }
}
