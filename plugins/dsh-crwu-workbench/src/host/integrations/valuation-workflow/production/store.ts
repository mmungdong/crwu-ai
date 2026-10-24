import { workflowGraphVersionFor } from '../../../domains/report-evaluation/workflow/flow-version.ts'
/**
 * Durable single-current-task session for one valuation workflow Host.
 *
 * The Host derives the SQLite location from the selected workspace; this module owns
 * the plain record image, serialized read-modify-write updates and the runner's
 * persistence callbacks. It never stores an Agent, token, chat transcript or raw
 * credential: the record is JSON-only identity, frozen input, durable DTO and the
 * journal of actual native child ids.
 */
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowSnapshot,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { ValuationWorkflowRunDTO } from '../../../domains/report-evaluation/workflow/persistence.ts'
import { parseRunRecord, serializeRunRecord } from '../../../domains/report-evaluation/workflow/persistence.ts'
import { openWorkflowStore } from '../../../core/workflow-store/index.ts'
import type {
  WorkflowCurrentRecord,
  WorkflowStore,
} from '../../../core/workflow-store/index.ts'
import type { WorkflowMaterialsResult } from '../materials.ts'
import type {
  WorkflowCalculationReceipt,
  WorkflowFrozenInput,
  WorkflowJournalSettledEvent,
  WorkflowJournalStartedEvent,
} from './types.ts'

/** Fixed Host identity of the embedded valuation graph and its single step. */
export const WORKFLOW_STEP_ID = 'valuation'
export const WORKFLOW_GRAPH_ID = 'crwu.workflow'
export const WORKFLOW_GRAPH_VERSION = '1'

const MAX_JOURNAL_ENTRIES = 256

/** One actual published child, retained until the Host proves it stopped. */
export interface WorkflowChildJournalEntry {
  sessionId: string
  kind: 'stage' | 'intent'
  nodeId: string
  stage?: string
  operation?: string
  runId: string
  revision: number
  correlationId: string
  settled: boolean
  ok?: boolean
  errorKind?: string
  createdAt: string
}

/**
 * Plain durable business state of one current task.
 *
 * `stopUnknown` is mirrored at this top level (not only inside `dto`) so the generic
 * store occupancy guard refuses replacement and import until it is resolved.
 */
export interface WorkflowHostState {
  graphVersion?: '1' | '2'
  projectId: string
  parentSessionId: string
  workspaceId: string
  workspacePath: string
  casePath: string
  runId: string
  frozen: WorkflowFrozenInput | null
  planIds: string[]
  phase: string
  errorKind: string
  error: string
  dto: ValuationWorkflowRunDTO | null
  prepared: WorkflowMaterialsResult | null
  calculationReceipt: WorkflowCalculationReceipt | null
  journal: WorkflowChildJournalEntry[]
  stopUnknown: { sessionId: string; error: string } | null
  /** True while `runner.startInput` program work is in flight (or crashed mid-way). */
  preparing: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
}

function journalOf(value: unknown): WorkflowChildJournalEntry[] {
  if (!Array.isArray(value)) return []
  const entries: WorkflowChildJournalEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const sessionId = text(raw.sessionId)
    if (sessionId === '') continue
    const kind = raw.kind === 'intent' ? 'intent' : 'stage'
    entries.push({
      sessionId,
      kind,
      nodeId: text(raw.nodeId),
      ...(text(raw.stage) === '' ? {} : { stage: text(raw.stage) }),
      ...(text(raw.operation) === '' ? {} : { operation: text(raw.operation) }),
      runId: text(raw.runId),
      revision: typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0,
      correlationId: text(raw.correlationId),
      settled: raw.settled === true,
      ...(typeof raw.ok === 'boolean' ? { ok: raw.ok } : {}),
      ...(text(raw.errorKind) === '' ? {} : { errorKind: text(raw.errorKind) }),
      createdAt: text(raw.createdAt),
    })
  }
  return entries.slice(-MAX_JOURNAL_ENTRIES)
}

/** Read the plain Host state from one stored record; a malformed image is null. */
export function hostStateOf(record: WorkflowCurrentRecord): WorkflowHostState | null {
  const raw = record.state
  if (!isRecord(raw)) return null
  if (record.graphVersion !== '1' && record.graphVersion !== '2') return null
  const projectId = text(raw.projectId)
  if (projectId === '') return null
  const stopRaw = raw.stopUnknown
  const stopUnknown = isRecord(stopRaw)
    ? { sessionId: text(stopRaw.sessionId), error: text(stopRaw.error) }
    : null
  // A present but invalid durable DTO invalidates the whole state instead of being
  // silently downgraded to "no run yet": the caller must fail closed.
  const dtoRaw = raw.dto
  let dto: ValuationWorkflowRunDTO | null = null
  if (dtoRaw !== null && dtoRaw !== undefined) {
    if (!isRecord(dtoRaw) || !parseRunRecord(dtoRaw).ok) return null
    dto = dtoRaw as unknown as ValuationWorkflowRunDTO
    if (workflowGraphVersionFor({ dto, frozen: null }) !== record.graphVersion) return null
  }
  const preparing = raw.preparing === true
  const recordedPhase = text(raw.phase)
  // The recorded *business* phase stays exactly as the service wrote it. Derived writer
  // occupancy is mirrored only in the top-level `status` column, never folded back into
  // the phase, so a settled child can release occupancy on the next update.
  const phase = recordedPhase || text(record.status) || 'preparing'
  return {
    graphVersion: record.graphVersion,
    projectId,
    parentSessionId: text(raw.parentSessionId),
    workspaceId: text(raw.workspaceId) || text(record.workspaceId),
    workspacePath: text(raw.workspacePath),
    casePath: text(raw.casePath),
    runId: text(raw.runId) || text(record.runId),
    frozen: isRecord(raw.frozen) ? raw.frozen as unknown as WorkflowFrozenInput : null,
    planIds: asStringArray(raw.planIds),
    phase,
    errorKind: text(raw.errorKind),
    error: text(raw.error),
    dto,
    prepared: isRecord(raw.prepared) ? raw.prepared as unknown as WorkflowMaterialsResult : null,
    calculationReceipt: isRecord(raw.calculationReceipt)
      ? raw.calculationReceipt as unknown as WorkflowCalculationReceipt
      : null,
    journal: journalOf(raw.journal),
    stopUnknown,
    preparing,
  }
}

/** The service program's per-stage correlation key for the actual node attempt. */
function stageCorrelation(runId: string, stage: string, attempt: number): string {
  return `${runId}:${stage}:${attempt}`
}

/**
 * Overlay only the actual main-stage child id onto a currently running receipt.
 *
 * A helper operation (page-reading / knowledge-selection / planning-selection) or a
 * prior-revision attempt never substitutes for the real node child. The exact service
 * correlation key ties one journal entry to one stage attempt; a later empty save of
 * the same attempt re-derives the same real id from the retained journal.
 */
function overlayJournal(
  dto: ValuationWorkflowRunDTO,
  journal: readonly WorkflowChildJournalEntry[],
): ValuationWorkflowRunDTO {
  const copy = cloneJson(dto)
  for (const stage of VALUATION_WORKFLOW_STAGES) {
    const receipt = copy.stages[stage]
    if (receipt === undefined) continue
    // A real id already recorded by the service is never replaced or erased.
    if (text(receipt.sessionId) !== '') continue
    if (receipt.state !== 'running') continue
    const expected = stageCorrelation(copy.runId, stage, receipt.attempt)
    const entry = journal.find((candidate) => candidate.kind === 'stage'
      && candidate.stage === stage
      && (candidate.operation === undefined || candidate.operation === '')
      && candidate.runId === copy.runId
      && candidate.revision === copy.revision
      && candidate.correlationId === expected)
    if (entry !== undefined) receipt.sessionId = entry.sessionId
  }
  if (copy.routing !== null && text(copy.routing.intentSessionId) === '') {
    // Only the intent child bound to this exact run/revision may fill the router id.
    const entry = journal.find((candidate) => candidate.kind === 'intent'
      && candidate.runId === copy.runId
      && candidate.revision === copy.revision)
    if (entry !== undefined) {
      copy.routing = { ...copy.routing, intentSessionId: entry.sessionId }
    }
  }
  return copy
}

/**
 * Overlay the actual current-attempt journal child ids onto a resident live snapshot.
 *
 * Only for the exact current run/revision and a currently running main-stage receipt,
 * with the service correlation key; helper operations and older revisions never fill a
 * live receipt. A live snapshot that already carries a real id is left untouched.
 */
export function overlayLiveSnapshot(
  snapshot: ValuationWorkflowSnapshot,
  journal: readonly WorkflowChildJournalEntry[],
): ValuationWorkflowSnapshot {
  const copy = cloneJson(snapshot)
  for (const stage of VALUATION_WORKFLOW_STAGES) {
    const receipt = copy.stages[stage]
    if (receipt === undefined) continue
    if (text(receipt.sessionId) !== '') continue
    if (receipt.state !== 'running') continue
    const expected = stageCorrelation(copy.runId, stage, receipt.attempt)
    const entry = journal.find((candidate) => candidate.kind === 'stage'
      && candidate.stage === stage
      && (candidate.operation === undefined || candidate.operation === '')
      && candidate.runId === copy.runId
      && candidate.revision === copy.revision
      && candidate.correlationId === expected)
    if (entry !== undefined) receipt.sessionId = entry.sessionId
  }
  if (copy.routing !== null && text(copy.routing.intentSessionId) === '') {
    const entry = journal.find((candidate) => candidate.kind === 'intent'
      && candidate.runId === copy.runId
      && candidate.revision === copy.revision)
    if (entry !== undefined) {
      copy.routing = { ...copy.routing, intentSessionId: entry.sessionId }
    }
  }
  return copy
}

/**
 * Exact durable image left by a legacy pregraph preparation failure: a terminal
 * environment failure with no run, no child and no unknown stop, still marked busy.
 */
export function isLegacyPreparationFailure(state: WorkflowHostState): boolean {
  return state.phase === 'failed'
    && state.errorKind === 'environment'
    && state.dto === null
    && state.journal.length === 0
    && state.stopUnknown === null
    && state.preparing === true
}

/** Structured outcome of one legacy preparation repair attempt. */
export interface WorkflowLegacyRepairResult {
  ok: boolean
  repaired: boolean
  error: string
}

function recordFromState(state: WorkflowHostState, revision: number): WorkflowCurrentRecord {
  // An unsettled real child or in-flight program preparation owns the writer: the
  // generic store guard reads the top-level status, so occupancy is mirrored there.
  const occupied = state.preparing === true || state.journal.some((entry) => !entry.settled)
  return {
    workspaceId: state.workspaceId,
    stepId: WORKFLOW_STEP_ID,
    runId: state.runId,
    graphId: WORKFLOW_GRAPH_ID,
    graphVersion: workflowGraphVersionFor(state),
    revision,
    status: occupied ? 'running' : (state.phase === '' ? 'preparing' : state.phase),
    state: cloneJson(state) as unknown as Record<string, unknown>,
    files: cloneJson(state.frozen?.files ?? []),
  }
}

/**
 * One open store handle plus a serialized writer.
 *
 * All writes run one at a time on this handle: a callback never observes a half-applied
 * mutation, and a later save of an empty session id cannot erase an earlier journal id.
 */
export class WorkflowStoreSession {
  readonly store: WorkflowStore
  private readonly workspaceId: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(store: WorkflowStore, workspaceId: string) {
    this.store = store
    this.workspaceId = workspaceId
  }

  get checkpointer() {
    return this.store.checkpointer
  }

  async read(): Promise<WorkflowCurrentRecord | null> {
    return await this.store.getCurrent(this.workspaceId, WORKFLOW_STEP_ID)
  }

  async readState(): Promise<WorkflowHostState | null> {
    const record = await this.read()
    return record === null ? null : hostStateOf(record)
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** Atomic update of the one current record; the reader revalidates the latest revision. */
  private async updateState(mutator: (state: WorkflowHostState) => WorkflowHostState): Promise<void> {
    await this.run(async () => {
      const record = await this.store.getCurrent(this.workspaceId, WORKFLOW_STEP_ID)
      if (record === null) throw new Error('没有可更新的当前工作流任务')
      const current = hostStateOf(record)
      if (current === null) throw new Error('当前工作流状态不可读')
      const next = mutator(cloneJson(current))
      const revision = Math.max(record.revision, next.dto === null ? 0 : next.dto.revision)
      await this.store.saveCurrent(recordFromState(next, revision), record.revision)
    })
  }

  /** Persist the initial one current task before any model or child starts. */
  async saveInitial(state: WorkflowHostState): Promise<void> {
    await this.run(async () => {
      const existing = await this.store.getCurrent(this.workspaceId, WORKFLOW_STEP_ID)
      const revision = Math.max(existing?.revision ?? 1, state.dto?.revision ?? 0, 1)
      await this.store.saveCurrent(
        recordFromState(cloneJson(state), revision),
        existing === undefined || existing === null ? undefined : existing.revision,
      )
    })
  }

  async saveRun(dto: ValuationWorkflowRunDTO, planIds?: readonly string[]): Promise<void> {
    await this.updateState((state) => {
      const planned = planIds === undefined ? state.planIds : [...planIds]
      const merged = overlayJournal(dto, state.journal)
      return {
        ...state,
        planIds: planned,
        dto: merged,
        // A durable service image means program preparation handed over; occupancy now
        // follows the run status and any still-unsettled child.
        preparing: false,
        phase: merged.status,
        errorKind: merged.errorKind,
        error: merged.error,
        stopUnknown: merged.stopUnknown === null ? null : { ...merged.stopUnknown },
      }
    })
  }

  async journalStarted(event: WorkflowJournalStartedEvent): Promise<void> {
    await this.updateState((state) => {
      // The intent adapter emits no run/revision; bind it to the actual current DTO so
      // the router id can only ever attach to this exact run. No older intent fallback.
      const bound = event.kind === 'intent' && state.dto !== null
        ? { runId: state.dto.runId, revision: state.dto.revision }
        : { runId: event.runId, revision: event.revision }
      const entry: WorkflowChildJournalEntry = {
        sessionId: event.sessionId,
        kind: event.kind,
        nodeId: event.nodeId,
        ...(event.stage === undefined ? {} : { stage: event.stage }),
        ...(event.operation === undefined ? {} : { operation: event.operation }),
        runId: bound.runId,
        revision: bound.revision,
        correlationId: event.correlationId,
        settled: false,
        createdAt: new Date().toISOString(),
      }
      const journal = [...state.journal.filter((item) => item.sessionId !== entry.sessionId), entry]
        .slice(-MAX_JOURNAL_ENTRIES)
      if (journal.length === 0) return state
      return {
        ...state,
        journal,
        ...(state.dto === null ? {} : { dto: overlayJournal(state.dto, journal) }),
      }
    })
  }

  async journalSettled(event: WorkflowJournalSettledEvent): Promise<void> {
    await this.updateState((state) => {
      const journal = state.journal.map((entry) => (entry.sessionId === event.sessionId
        ? { ...entry, settled: true, ok: event.ok, errorKind: event.errorKind }
        : entry))
      return { ...state, journal }
    })
  }

  /** Mark program material preparation in flight; a crash keeps writer occupancy. */
  async beginPreparation(): Promise<void> {
    await this.updateState((state) => ({ ...state, preparing: true }))
  }

  async getPrepared(): Promise<WorkflowMaterialsResult | undefined> {
    const state = await this.readState()
    return state?.prepared ?? undefined
  }

  async savePrepared(result: WorkflowMaterialsResult): Promise<void> {
    await this.updateState((state) => ({ ...state, prepared: cloneJson(result) }))
  }

  async getCalculationReceipt(): Promise<WorkflowCalculationReceipt | undefined> {
    const state = await this.readState()
    return state?.calculationReceipt ?? undefined
  }

  async saveCalculationReceipt(receipt: WorkflowCalculationReceipt): Promise<void> {
    await this.updateState((state) => ({ ...state, calculationReceipt: cloneJson(receipt) }))
  }

  /**
   * Persist a sanitized preparation failure after `startInput` actually rejected.
   * Only that settled rejection releases program preparation occupancy; an unsettled
   * child or a trusted stop-unknown keeps the writer guard and its top-level flag.
   */
  async recordStartFailure(error: unknown): Promise<void> {
    const failure = isRecord(error) ? error : {}
    const errorKind = text(failure.errorKind) || 'failed'
    const message = error instanceof Error ? error.message : text(failure.error)
    const sessionIds = asStringArray(failure.sessionIds)
    await this.updateState((state) => {
      const stopUnknown = errorKind === 'stop-unknown'
        ? { sessionId: sessionIds[0] ?? '', error: '工作流准备阶段的子会话停止状态未知，运行时保持占用' }
        : state.stopUnknown
      // Only an actually settled rejection releases program preparation. An unsettled
      // child or any unknown stop keeps writer occupancy in the durable record.
      const settled = stopUnknown === null && state.journal.every((entry) => entry.settled)
      return {
        ...state,
        phase: 'failed',
        errorKind: errorKind === 'stop-unknown' ? 'stop-unknown' : (errorKind || 'failed'),
        error: message === '' ? '工作流准备失败' : message,
        stopUnknown,
        preparing: settled ? false : state.preparing,
      }
    })
  }

  /**
   * Clear exactly one legacy preparation marker after the Host proved the real parent
   * idle and the protected bytes intact. The latest durable image is revalidated inside
   * the serialized writer; anything else is refused without a write.
   */
  async repairLegacyPreparationFailure(identity: {
    projectId: string
    parentSessionId: string
  }): Promise<WorkflowLegacyRepairResult> {
    try {
      return await this.run(async () => {
        const record = await this.store.getCurrent(this.workspaceId, WORKFLOW_STEP_ID)
        if (record === null) {
          return { ok: false, repaired: false, error: '没有可修复的当前工作流任务' }
        }
        const state = hostStateOf(record)
        if (state === null) {
          return { ok: false, repaired: false, error: '当前工作流状态不可读' }
        }
        if (!isLegacyPreparationFailure(state)
          || state.projectId !== text(identity.projectId)
          || state.parentSessionId !== text(identity.parentSessionId)) {
          return { ok: false, repaired: false, error: '当前任务不是可修复的旧版准备失败标记' }
        }
        const next: WorkflowHostState = { ...cloneJson(state), preparing: false }
        const revision = Math.max(record.revision, next.dto === null ? 0 : next.dto.revision)
        await this.store.saveCurrent(recordFromState(next, revision), record.revision)
        return { ok: true, repaired: true, error: '' }
      })
    } catch {
      return { ok: false, repaired: false, error: '旧版准备失败标记未能修复：状态保持不变' }
    }
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}

/** Open the one store for an already verified workspace root and path. */
export async function openWorkflowStoreSession(options: {
  workspaceId: string
  storePath: string
  authorize: () => { ok: boolean }
}): Promise<WorkflowStoreSession> {
  const store = await openWorkflowStore({
    path: options.storePath,
    authorize: options.authorize,
    note: 'valuation workflow store',
  })
  return new WorkflowStoreSession(store, options.workspaceId)
}

/** Validate a stored DTO with the native parser and re-serialize an independent image. */
export function validatedSnapshot(dto: unknown): ValuationWorkflowRunDTO | null {
  if (dto === null || dto === undefined) return null
  const parsed = parseRunRecord(dto)
  return parsed.ok ? serializeRunRecord(parsed.record) : null
}
