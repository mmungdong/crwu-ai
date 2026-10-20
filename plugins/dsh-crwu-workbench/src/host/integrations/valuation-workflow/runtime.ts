/**
 * In-memory Host controller for the embedded valuation workflow.
 *
 * One live case scope owns one lazily created runner, one service and one opaque
 * start command. Commands are minted by the Host; the model never supplies a parent,
 * case path, tool or execution context. Every execution rechecks the current live
 * scope and the genuine caller before touching the runner, and only the currently
 * executing ToolRunContext is exposed to the runner while a drive is in flight.
 *
 * Command IDs are never persisted: restarting the Host drops every minted command, so
 * a reopened scope can never resume a command from an earlier lifetime. A validated
 * durable run image may still be hydrated through `restore`, which admits the saved
 * service state without minting a fresh start command.
 */
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowOperationOutcome,
  type ValuationWorkflowSnapshot,
  type ValuationWorkflowStage,
  type ValuationWorkflowStatus,
} from '../../../shared/contracts/valuation-workflow.ts'
import type { ValuationScope } from '../../domains/report-evaluation/scope.ts'
import { SUPPLEMENTAL_PROMPT_MAX_LENGTH } from '../../domains/report-evaluation/project/contracts.ts'
import { PURPOSE_MAX_LENGTH } from '../../../shared/contracts/valuation-project.ts'
import { isRealCalendarDate } from '../../domains/report-evaluation/workflow/elements.ts'
import type {
  ValuationWorkflowService,
  ValuationWorkflowStartInput,
} from '../../domains/report-evaluation/workflow/service.ts'
import { parseRunRecord } from '../../domains/report-evaluation/workflow/persistence.ts'
import { canRetryWorkflowIntent } from '../../domains/report-evaluation/workflow/intent-retry.ts'
import type { ValuationQuestionEdit, ValuationQuestionSubmit } from '../../../shared/contracts/valuation-questionnaire.ts'
import { parseQuestionEdit } from './production/operations.ts'

const MAX_PROJECTS = 64
const MAX_COMMANDS_PER_PROJECT = 64

const CONTROL_TOOL_NAME = 'crwu_valuation_workflow_run'
const RUN_CODE_TRANSPORT = 'run_code'
/** Sanitized marker for a preparation child whose quiescence is unknown. */
const PREPARE_STOP_UNKNOWN = '工作流准备阶段的子会话停止状态未知，运行时保持占用'

const EDITABLE_FIELD_OWNER: Record<string, ValuationWorkflowStage> = {
  areaSqm: 'rights',
  useLabel: 'rights',
  purpose: 'elements',
  baseDate: 'elements',
  mode: 'elements',
}

export type ValuationWorkflowRuntimePhase =
  | 'awaiting-agent'
  | 'preparing'
  | 'running'
  | 'waiting-user'
  | 'partial'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'

/**
 * The genuine Tool execution context. Only the object supplied to `execute` is
 * ever exposed; the controller never mints a token, agent id or session id.
 */
export type ValuationWorkflowExecution = ToolRunContext

export interface ValuationWorkflowRunnerInput {
  scope: ValuationScope
  /** Only the current genuine execution; undefined outside an active drive. */
  getExecution: () => ValuationWorkflowExecution | undefined
}

export interface ValuationWorkflowRunner {
  service: ValuationWorkflowService
  startInput: () => Promise<ValuationWorkflowStartInput>
}

export interface CreateValuationWorkflowRuntimeOptions {
  scopes: { get(projectId: string): ValuationScope | undefined }
  createRunner(input: ValuationWorkflowRunnerInput): Promise<ValuationWorkflowRunner>
  /**
   * Host-owned stop verifier. The Host separately verifies this project's exact
   * journaled own child turn closure plus actual Agent/native job quiescence and
   * atomically persists a native-validated stopped DTO before answering ok. Never a
   * Client boolean or an action payload.
   */
  verifyStopped?: (identity: { projectId: string; parentSessionId: string }) => Promise<{ ok: boolean; error?: string }>
}

export interface ValuationWorkflowRuntimeExecution {
  ok: boolean
  errorKind?: string
  error?: string
  snapshot: ValuationWorkflowSnapshot | null
}

export interface ValuationWorkflowRuntimeRegistration {
  ok: boolean
  commandId: string
  error?: string
}

export interface ValuationWorkflowRuntimeRestoreInput {
  projectId: string
  parentSessionId: string
  run: unknown
}

export interface ValuationWorkflowRuntimeRestoreResult {
  ok: boolean
  error?: string
}

export interface ValuationWorkflowRuntimeStatus {
  phase: ValuationWorkflowRuntimePhase
  snapshot: ValuationWorkflowSnapshot | null
  projectId: string
  parentSessionId: string
  error: string
  occupied: boolean
}

export interface ValuationWorkflowRuntimeQueueInput {
  action: 'answer' | 'revise' | 'approve-plan' | 'retry-intent' | 'questions-submit'
  payload: unknown
}

export interface ValuationWorkflowRuntimeCommand {
  ok: boolean
  commandId: string
  error?: string
}

export interface ValuationWorkflowRuntimePreview {
  ok: boolean
  projectId: string
  nodeId: string
  expectedRevision: number
  supersededNodeIds: ValuationWorkflowStage[]
  changes: Array<{ field: string; owner: ValuationWorkflowStage }>
  error?: string
}

interface AnswerPayload {
  clarificationId: string
  submissionId: string
  expectedRevision: number
  answers: Record<string, string>
}

interface RevisePayload {
  nodeId: string
  submissionId: string
  expectedRevision: number
  reason: string
  source: string
  changes: Array<{ field: string; value: unknown }>
}

interface ApprovePlanPayload {
  expectedRevision: number
  planDigest: string
  submissionId: string
}

/** Host-internal retry of an intent-only stop; never a model- or Client-supplied business input. */
interface RetryIntentPayload {
  expectedRevision: number
  submissionId: string
}

type CommandIntent =
  | { kind: 'start' }
  | { kind: 'answer'; payload: AnswerPayload }
  | { kind: 'revise'; payload: RevisePayload }
  | { kind: 'approve-plan'; payload: ApprovePlanPayload }
  | { kind: 'retry-intent'; payload: RetryIntentPayload }
  | { kind: 'questions-submit'; payload: ValuationQuestionSubmit }

type QueuedIntent = Exclude<CommandIntent, { kind: 'start' }>

/** Canonical form of a queued intent payload; identical submissions reuse one command. */
function intentPayloadKey(intent: QueuedIntent): string {
  return JSON.stringify(intent)
}

interface CommandState {
  id: string
  projectId: string
  intent: CommandIntent
  status: 'pending' | 'running' | 'done'
  promise: Promise<ValuationWorkflowRuntimeExecution> | null
  result: ValuationWorkflowRuntimeExecution | null
}

interface ProjectState {
  projectId: string
  parentSessionId: string
  scope: ValuationScope
  scopeKey: string
  startCommandId: string
  commands: Map<string, CommandState>
  commandOrder: string[]
  runner: ValuationWorkflowRunner | null
  runnerPromise: Promise<ValuationWorkflowRunner> | null
  service: ValuationWorkflowService | null
  startInput: (() => Promise<ValuationWorkflowStartInput>) | null
  runId: string
  started: boolean
  starting: boolean
  occupied: boolean
  activeCommandId: string | null
  currentExecution: ValuationWorkflowExecution | undefined
  /** Owned abort signal for the active command's child work. */
  executionController: AbortController | null
  lastSnapshot: ValuationWorkflowSnapshot | null
  disposed: boolean
}

export interface ValuationWorkflowRuntime {
  register(input: { projectId: string; parentSessionId: string }): ValuationWorkflowRuntimeRegistration
  execute(
    commandId: string,
    execution: ValuationWorkflowExecution,
  ): Promise<ValuationWorkflowRuntimeExecution>
  status(projectId: string): Promise<ValuationWorkflowRuntimeStatus>
  guard(execution: Readonly<ToolExecution>): string | undefined
  restore(input: ValuationWorkflowRuntimeRestoreInput): Promise<ValuationWorkflowRuntimeRestoreResult>
  release(projectId: string): { ok: boolean; error?: string }
  /** Retire one occupied resident project only after the Host-owned stop proof. */
  reconcile(projectId: string): Promise<{ ok: boolean; error?: string }>
  queue(
    projectId: string,
    input: ValuationWorkflowRuntimeQueueInput,
  ): ValuationWorkflowRuntimeCommand
  saveDraft(projectId: string, input: ValuationQuestionEdit): Promise<ValuationWorkflowRuntimeExecution>
  cancel(projectId: string): Promise<{ ok: boolean; error?: string }>
  preview(
    projectId: string,
    nodeId: string,
    changes: Array<{ field: string; value: unknown }>,
    expectedRevision: number,
  ): ValuationWorkflowRuntimePreview
  dispose(): void
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

/** A trusted runner preparation failure that reports an unknown child stop. */
function preparationStopUnknown(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { errorKind?: unknown }).errorKind === 'stop-unknown'
}

function scopeProjectId(scope: ValuationScope): string {
  return scope.projectId ?? scope.valuationId
}

function scopeParentSessionId(scope: ValuationScope): string {
  return scope.parentSessionId ?? scope.sessionId
}

function scopeKeyOf(scope: ValuationScope): string {
  return [
    scopeProjectId(scope),
    scopeParentSessionId(scope),
    scope.sessionId,
    String(scope.openedAt),
  ].join('\u0000')
}

function cloneExecution(value: ValuationWorkflowRuntimeExecution): ValuationWorkflowRuntimeExecution {
  return value.snapshot === null
    ? { ok: value.ok, errorKind: value.errorKind, error: value.error, snapshot: null }
    : JSON.parse(JSON.stringify(value)) as ValuationWorkflowRuntimeExecution
}

function asExecution(outcome: ValuationWorkflowOperationOutcome): ValuationWorkflowRuntimeExecution {
  return {
    ok: outcome.ok,
    errorKind: outcome.errorKind,
    error: outcome.error,
    snapshot: outcome.snapshot,
  }
}

function phaseOf(status: ValuationWorkflowStatus, outcome: ValuationWorkflowSnapshot['outcome']): ValuationWorkflowRuntimePhase {
  if (status === 'completed') return outcome === 'partial' ? 'partial' : 'completed'
  if (status === 'running') return 'running'
  if (status === 'waiting-user') return 'waiting-user'
  if (status === 'partial') return 'partial'
  if (status === 'blocked') return 'blocked'
  if (status === 'failed') return 'failed'
  return 'cancelled'
}

function refusal(
  error: string,
  snapshot: ValuationWorkflowSnapshot | null,
): ValuationWorkflowRuntimeExecution {
  return { ok: false, errorKind: 'blocked', error, snapshot }
}

function commandFailure(
  error: string,
  snapshot: ValuationWorkflowSnapshot | null,
): ValuationWorkflowRuntimeExecution {
  return { ok: false, errorKind: 'failed', error, snapshot }
}

function previewError(projectId: string, nodeId: string, expectedRevision: number, error: string): ValuationWorkflowRuntimePreview {
  return { ok: false, projectId, nodeId, expectedRevision, supersededNodeIds: [], changes: [], error }
}

/**
 * Pure dependency projection for a proposed revision. No service or model is
 * consulted: the earliest affected stage and everything after it are reported.
 */
export function previewValuationWorkflowRevision(
  projectId: string,
  nodeId: string,
  changes: Array<{ field: string; value: unknown }>,
  expectedRevision: number,
): ValuationWorkflowRuntimePreview {
  if (!Array.isArray(changes) || changes.length === 0) {
    return previewError(projectId, nodeId, expectedRevision, '修订没有要更改的字段')
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return previewError(projectId, nodeId, expectedRevision, '修订必须基于有效版本')
  }
  const nodeIndex = (VALUATION_WORKFLOW_STAGES as readonly string[]).indexOf(nodeId)
  if (nodeIndex < 0) {
    return previewError(projectId, nodeId, expectedRevision, `未知节点：${nodeId || '未提供'}`)
  }
  let entryIndex = nodeIndex
  const seen = new Set<string>()
  const accepted: Array<{ field: string; owner: ValuationWorkflowStage }> = []
  for (const change of changes) {
    if (!isRecord(change)) return previewError(projectId, nodeId, expectedRevision, '修订字段无效')
    const field = text(change.field)
    if (seen.has(field)) return previewError(projectId, nodeId, expectedRevision, `同一字段在一次修订里出现了多次：${field}`)
    seen.add(field)
    if (field === 'promptSupplement') {
      const supplement = text(change.value)
      if (supplement === '') return previewError(projectId, nodeId, expectedRevision, '节点补充说明不能为空')
      if (supplement.length > SUPPLEMENTAL_PROMPT_MAX_LENGTH) {
        return previewError(projectId, nodeId, expectedRevision, `节点补充说明超过 ${String(SUPPLEMENTAL_PROMPT_MAX_LENGTH)} 字符`)
      }
      accepted.push({ field, owner: nodeId as ValuationWorkflowStage })
      continue
    }
    const owner = EDITABLE_FIELD_OWNER[field]
    if (owner === undefined) return previewError(projectId, nodeId, expectedRevision, `字段不可修订或不属于本节点：${field}`)
    if (field === 'areaSqm') {
      const area = Number(change.value)
      if (!Number.isFinite(area) || area <= 0) return previewError(projectId, nodeId, expectedRevision, '面积必须是正数')
    } else if (field === 'purpose') {
      const next = text(change.value).trim()
      if (next === '') return previewError(projectId, nodeId, expectedRevision, '评估目的不能为空')
      if (next.length > PURPOSE_MAX_LENGTH) {
        return previewError(projectId, nodeId, expectedRevision, `评估目的超过 ${String(PURPOSE_MAX_LENGTH)} 字符`)
      }
    } else if (field === 'baseDate') {
      const next = text(change.value).trim()
      if (next !== '' && !isRealCalendarDate(next)) {
        return previewError(projectId, nodeId, expectedRevision, '基准日必须是真实存在的 YYYY-MM-DD 日期')
      }
    } else if (field === 'mode') {
      const next = text(change.value).trim()
      if (next !== 'formal' && next !== 'listing-reference') {
        return previewError(projectId, nodeId, expectedRevision, '评估口径只接受 formal 或 listing-reference')
      }
    } else if (text(change.value) === '') {
      return previewError(projectId, nodeId, expectedRevision, '原始用途不能为空')
    }
    accepted.push({ field, owner })
    entryIndex = Math.min(entryIndex, VALUATION_WORKFLOW_STAGES.indexOf(owner))
  }
  if (!Number.isFinite(entryIndex) || entryIndex < 0) {
    return previewError(projectId, nodeId, expectedRevision, '修订没有可执行的起点')
  }
  return {
    ok: true,
    projectId,
    nodeId,
    expectedRevision,
    supersededNodeIds: [...VALUATION_WORKFLOW_STAGES.slice(entryIndex)],
    changes: accepted,
  }
}

export function createValuationWorkflowRuntime(
  options: CreateValuationWorkflowRuntimeOptions,
): ValuationWorkflowRuntime {
  const projects = new Map<string, ProjectState>()
  const commandIndex = new Map<string, { state: ProjectState; command: CommandState }>()
  let commandSequence = 0
  let cancelSequence = 0

  const removeProject = (state: ProjectState): void => {
    state.disposed = true
    state.executionController?.abort()
    state.executionController = null
    state.currentExecution = undefined
    state.service?.dispose()
    for (const command of state.commands.values()) commandIndex.delete(command.id)
    state.commands.clear()
    state.commandOrder = []
    state.runner = null
    state.runnerPromise = null
    state.service = null
    state.startInput = null
    projects.delete(state.projectId)
  }

  const makeRoomForProject = (): boolean => {
    while (projects.size >= MAX_PROJECTS) {
      let victim: ProjectState | undefined
      for (const candidate of projects.values()) {
        const hasUnconsumed = [...candidate.commands.values()].some((command) => command.status !== 'done')
        if (candidate.activeCommandId === null && !candidate.occupied && !hasUnconsumed) {
          victim = candidate
          break
        }
      }
      if (victim === undefined) return false
      removeProject(victim)
    }
    return true
  }

  const evictOldCommand = (state: ProjectState): boolean => {
    for (const id of state.commandOrder) {
      if (id === state.startCommandId) continue
      const command = state.commands.get(id)
      if (command !== undefined && command.status === 'done') {
        state.commands.delete(id)
        commandIndex.delete(id)
        state.commandOrder = state.commandOrder.filter((entry) => entry !== id)
        return true
      }
    }
    return false
  }

  const addCommand = (state: ProjectState, intent: CommandIntent): CommandState | null => {
    while (state.commands.size >= MAX_COMMANDS_PER_PROJECT) {
      if (!evictOldCommand(state)) return null
    }
    commandSequence += 1
    const suffix = Math.random().toString(36).slice(2, 10)
    const command: CommandState = {
      id: `workflow-command-${String(commandSequence)}-${suffix}`,
      projectId: state.projectId,
      intent,
      status: 'pending',
      promise: null,
      result: null,
    }
    state.commands.set(command.id, command)
    state.commandOrder.push(command.id)
    commandIndex.set(command.id, { state, command })
    return command
  }

  const authorizationProblem = (
    state: ProjectState,
    execution: ValuationWorkflowExecution | undefined,
  ): string => {
    if (state.disposed) return '工作流运行时已释放'
    const scope = options.scopes.get(state.projectId)
    if (scope === undefined) return '项目已关闭或不存在'
    if (scopeKeyOf(scope) !== state.scopeKey) return '项目已被重新打开，原命令不再有效'
    const caller = execution?.agent?.id
    if (typeof caller !== 'string' || caller !== state.parentSessionId) return '命令不属于当前父会话'
    return ''
  }

  const ensureRunner = async (state: ProjectState): Promise<ValuationWorkflowRunner> => {
    if (state.runner !== null) return state.runner
    if (state.runnerPromise !== null) return state.runnerPromise
    state.starting = true
    const promise = (async () => {
      try {
        const runner = await options.createRunner({
          scope: state.scope,
          getExecution: () => state.currentExecution,
        })
        state.runner = runner
        state.service = runner.service
        state.startInput = runner.startInput
        return runner
      } finally {
        state.starting = false
      }
    })()
    state.runnerPromise = promise
    try {
      return await promise
    } catch {
      state.runnerPromise = null
      throw new Error('工作流运行器创建失败')
    }
  }

  const currentSnapshot = async (state: ProjectState): Promise<ValuationWorkflowSnapshot | null> => {
    const service = state.service
    if (service === null || state.runId === '') return null
    try {
      return await service.get(state.runId)
    } catch {
      return null
    }
  }

  const runCommand = async (
    state: ProjectState,
    command: CommandState,
  ): Promise<ValuationWorkflowRuntimeExecution> => {
    if (command.intent.kind === 'start') {
      const runner = await ensureRunner(state)
      const prepared = await runner.startInput().catch((error: unknown) => {
        if (!preparationStopUnknown(error)) throw error
        return null
      })
      if (prepared === null) {
        // A trusted preparation stop keeps writer occupancy even without a business
        // snapshot; ordinary failures keep the existing path.
        return {
          ok: false,
          errorKind: 'stop-unknown',
          error: PREPARE_STOP_UNKNOWN,
          snapshot: state.lastSnapshot,
        }
      }
      state.runId = text(prepared.runId)
      if (state.runId === '') {
        return commandFailure('启动输入缺少运行标识', state.lastSnapshot)
      }
      state.starting = true
      try {
        const outcome = await runner.service.start(prepared)
        state.started = true
        return asExecution(outcome)
      } finally {
        state.starting = false
      }
    }
    const service = state.service
    if (!state.started || service === null || state.runId === '') {
      return refusal('工作流尚未启动', state.lastSnapshot)
    }
    try {
      if (command.intent.kind === 'answer') {
        return asExecution(await service.answer({
          runId: state.runId,
          clarificationId: command.intent.payload.clarificationId,
          submissionId: command.intent.payload.submissionId,
          expectedRevision: command.intent.payload.expectedRevision,
          answers: { ...command.intent.payload.answers },
        }))
      }
      if (command.intent.kind === 'questions-submit') {
        return asExecution(await service.submitQuestions({ runId: state.runId, ...command.intent.payload }))
      }
      if (command.intent.kind === 'approve-plan') {
        return asExecution(await service.approvePlan({
          runId: state.runId,
          expectedRevision: command.intent.payload.expectedRevision,
          planDigest: command.intent.payload.planDigest,
          submissionId: command.intent.payload.submissionId,
        }))
      }
      if (command.intent.kind === 'retry-intent') {
        // The service reuses the frozen inputs; the runtime never prepares again.
        return asExecution(await service.retryIntent({
          runId: state.runId,
          expectedRevision: command.intent.payload.expectedRevision,
          submissionId: command.intent.payload.submissionId,
        }))
      }
      return asExecution(await service.revise({
        runId: state.runId,
        nodeId: command.intent.payload.nodeId,
        submissionId: command.intent.payload.submissionId,
        expectedRevision: command.intent.payload.expectedRevision,
        reason: command.intent.payload.reason,
        source: command.intent.payload.source,
        changes: command.intent.payload.changes.map((change) => ({ field: change.field, value: change.value })),
      }))
    } catch {
      return commandFailure('工作流执行失败', state.lastSnapshot)
    }
  }

  const register = (input: { projectId: string; parentSessionId: string }): ValuationWorkflowRuntimeRegistration => {
    const projectId = text(input.projectId)
    const parentSessionId = text(input.parentSessionId)
    if (projectId === '' || parentSessionId === '') {
      return { ok: false, commandId: '', error: '缺少项目或父会话标识' }
    }
    const scope = options.scopes.get(projectId)
    if (scope === undefined) return { ok: false, commandId: '', error: '项目不存在或其案例已经关闭' }
    if (scopeProjectId(scope) !== projectId) return { ok: false, commandId: '', error: '项目归属不一致' }
    if (scopeParentSessionId(scope) !== parentSessionId) {
      return { ok: false, commandId: '', error: '项目不属于当前父会话' }
    }
    const key = scopeKeyOf(scope)
    const existing = projects.get(projectId)
    if (existing !== undefined && existing.scopeKey === key) {
      return { ok: true, commandId: existing.startCommandId }
    }
    if (existing !== undefined) {
      // Changing the live scope metadata must never release a writer that is
      // still executing or whose child quiescence is unresolved.
      if (existing.activeCommandId !== null || existing.starting || existing.occupied) {
        return { ok: false, commandId: '', error: '上一轮仍在执行或停止状态未知，不能替换当前项目' }
      }
      removeProject(existing)
    }
    if (!makeRoomForProject()) {
      return { ok: false, commandId: '', error: '同时打开的项目超过上限' }
    }
    const state: ProjectState = {
      projectId,
      parentSessionId,
      scope,
      scopeKey: key,
      startCommandId: '',
      commands: new Map(),
      commandOrder: [],
      runner: null,
      runnerPromise: null,
      service: null,
      startInput: null,
      runId: '',
      started: false,
      starting: false,
      occupied: false,
      activeCommandId: null,
      currentExecution: undefined,
      executionController: null,
      lastSnapshot: null,
      disposed: false,
    }
    const startCommand = addCommand(state, { kind: 'start' })
    if (startCommand === null) return { ok: false, commandId: '', error: '命令历史无法再容纳启动命令' }
    state.startCommandId = startCommand.id
    projects.set(projectId, state)
    return { ok: true, commandId: startCommand.id }
  }

  const restore = async (
    input: ValuationWorkflowRuntimeRestoreInput,
  ): Promise<ValuationWorkflowRuntimeRestoreResult> => {
    const projectId = text(input.projectId)
    const parentSessionId = text(input.parentSessionId)
    if (projectId === '' || parentSessionId === '') {
      return { ok: false, error: '缺少项目或父会话标识' }
    }
    const scope = options.scopes.get(projectId)
    if (scope === undefined) return { ok: false, error: '项目不存在或其案例已经关闭' }
    if (scopeProjectId(scope) !== projectId) return { ok: false, error: '项目归属不一致' }
    if (scopeParentSessionId(scope) !== parentSessionId) {
      return { ok: false, error: '项目不属于当前父会话' }
    }
    if (projects.has(projectId)) return { ok: false, error: '项目已经登记，不能覆盖当前运行' }
    // Pure validation of the durable image before any runner is built.
    const parsed = parseRunRecord(input.run)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const runId = text(parsed.record.runId)
    if (runId === '') return { ok: false, error: '恢复数据缺少运行标识' }

    // The temporary state is never published until every check passes; its runner
    // is built lazily and `startInput` is never called.
    const state: ProjectState = {
      projectId,
      parentSessionId,
      scope,
      scopeKey: scopeKeyOf(scope),
      startCommandId: '',
      commands: new Map(),
      commandOrder: [],
      runner: null,
      runnerPromise: null,
      service: null,
      startInput: null,
      runId: '',
      started: false,
      starting: false,
      occupied: false,
      activeCommandId: null,
      currentExecution: undefined,
      executionController: null,
      lastSnapshot: null,
      disposed: false,
    }
    const releaseTemporary = (): void => {
      state.service?.dispose()
    }
    try {
      await ensureRunner(state)
    } catch {
      releaseTemporary()
      return { ok: false, error: '工作流运行器创建失败' }
    }
    const live = options.scopes.get(projectId)
    if (live === undefined || scopeKeyOf(live) !== state.scopeKey || projects.has(projectId)) {
      releaseTemporary()
      return { ok: false, error: '项目已关闭、已被重新打开或已经登记，不能恢复' }
    }
    const service = state.service
    if (service === null) {
      releaseTemporary()
      return { ok: false, error: '工作流运行器创建失败' }
    }
    try {
      const outcome = await service.restoreRun(input.run)
      if (!outcome.ok) {
        releaseTemporary()
        return { ok: false, error: text(outcome.error) || '恢复数据未被接受' }
      }
      const savedRunId = text(outcome.snapshot.runId) || runId
      // Occupancy lives on the durable image, not on the public snapshot.
      let occupied = parsed.record.stopUnknown !== null
      try {
        const exported = await service.exportRun(savedRunId)
        // A missing image is not proof that an unknown child stopped; only add facts.
        if (exported !== null) occupied = occupied || exported.stopUnknown !== null
      } catch {
        // keep the pure-image occupancy reading
      }
      // Recheck the live scope and the registration in one synchronous block so
      // exactly one concurrent restore (or register) can win.
      const published = options.scopes.get(projectId)
      if (published === undefined || scopeKeyOf(published) !== state.scopeKey || projects.has(projectId)) {
        releaseTemporary()
        return { ok: false, error: '项目已关闭、已被重新打开或已经登记，不能恢复' }
      }
      if (!makeRoomForProject()) {
        releaseTemporary()
        return { ok: false, error: '同时打开的项目超过上限' }
      }
      state.runId = savedRunId
      state.started = true
      state.occupied = occupied
      state.lastSnapshot = outcome.snapshot
      projects.set(projectId, state)
      return { ok: true }
    } catch {
      releaseTemporary()
      return { ok: false, error: '恢复数据未被接受' }
    }
  }

  /**
   * Release exactly one idle current controller. Unknown projects are an idempotent
   * no-op; a running, preparing or occupied controller is refused. Release never
   * certifies an unknown child as stopped and has no force override.
   */
  const release = (projectId: string): { ok: boolean; error?: string } => {
    const state = projects.get(text(projectId))
    if (state === undefined) return { ok: true }
    if (state.activeCommandId !== null || state.starting || state.occupied) {
      return { ok: false, error: '当前项目仍在执行或停止状态未知，不能释放' }
    }
    removeProject(state)
    return { ok: true }
  }

  /**
   * Retire one occupied resident controller after the Host-owned stop proof. The
   * runtime never infers quiescence itself: it captures the exact resident project and
   * its live scope identity, awaits the Host verifier, then rechecks both before
   * removing anything. A missing, false or throwing verifier keeps occupancy, and a
   * project replaced or a scope reopened while awaiting proof is never retired.
   */
  const reconcile = async (projectId: string): Promise<{ ok: boolean; error?: string }> => {
    const id = text(projectId)
    const state = projects.get(id)
    if (state === undefined) return { ok: false, error: '没有这一轮项目' }
    if (state.disposed) return { ok: false, error: '工作流运行时已释放' }
    // A live drive or a runner that is still starting owns the writer: never verify.
    if (state.activeCommandId !== null || state.starting) {
      return { ok: false, error: '当前项目仍在执行或启动中，不能收口' }
    }
    if (!state.occupied) return { ok: false, error: '当前项目没有需要宿主确认的停止占用' }
    const scope = options.scopes.get(id)
    if (scope === undefined || scopeKeyOf(scope) !== state.scopeKey) {
      return { ok: false, error: '项目已关闭或已被重新打开' }
    }
    const verify = options.verifyStopped
    if (verify === undefined) return { ok: false, error: '宿主没有提供停止状态核实能力' }
    let proven = false
    try {
      const outcome = await verify({ projectId: state.projectId, parentSessionId: state.parentSessionId })
      proven = isRecord(outcome) && outcome.ok === true
    } catch {
      proven = false
    }
    if (!proven) return { ok: false, error: '停止状态未获宿主确认，运行时保持占用' }
    // Recheck the exact resident project and live scope after the await so a replaced
    // project or a reopened scope cannot be retired by a late proof.
    const live = options.scopes.get(id)
    if (projects.get(id) !== state || live === undefined || scopeKeyOf(live) !== state.scopeKey) {
      return { ok: false, error: '项目在核实期间已被替换或重新打开，不能收口' }
    }
    removeProject(state)
    return { ok: true }
  }

  const execute = async (
    commandId: string,
    execution: ValuationWorkflowExecution,
  ): Promise<ValuationWorkflowRuntimeExecution> => {
    const located = commandIndex.get(text(commandId))
    if (located === undefined) {
      return refusal('未知的 Host 命令', null)
    }
    const { state, command } = located
    const problem = authorizationProblem(state, execution)
    if (problem !== '') {
      return refusal(problem, state.lastSnapshot)
    }
    if (command.status === 'done' && command.result !== null) {
      return cloneExecution(command.result)
    }
    if (state.occupied) {
      return refusal('上一轮停止状态未知，不能启动新的执行', state.lastSnapshot)
    }
    if (command.status === 'running' && command.promise !== null) {
      return command.promise
    }
    if (state.activeCommandId !== null) {
      return refusal('当前已有执行中的命令，不能并发写入', state.lastSnapshot)
    }

    command.status = 'running'
    state.activeCommandId = command.id
    const owned = new AbortController()
    state.executionController = owned
    const wrapped = { ...execution, signal: owned.signal } as ValuationWorkflowExecution
    state.currentExecution = wrapped
    const promise = runCommand(state, command)
      .catch(() => commandFailure('工作流执行失败', state.lastSnapshot))
      .then((result) => {
        const cached = cloneExecution(result)
        command.result = cached
        command.status = 'done'
        if (result.snapshot !== null) state.lastSnapshot = result.snapshot
        if (result.errorKind === 'stop-unknown'
          || result.snapshot?.errorKind === 'stop-unknown') {
          state.occupied = true
        }
        return cloneExecution(cached)
      })
      .finally(() => {
        if (state.activeCommandId === command.id) state.activeCommandId = null
        if (state.currentExecution === wrapped) state.currentExecution = undefined
        if (state.executionController === owned) state.executionController = null
        command.promise = null
        if (command.status !== 'done') command.status = 'done'
      })
    command.promise = promise
    return promise
  }

  const status = async (projectId: string): Promise<ValuationWorkflowRuntimeStatus> => {
    const id = text(projectId)
    const state = projects.get(id)
    if (state === undefined) {
      return {
        phase: 'failed', snapshot: null, projectId: id, parentSessionId: '', error: '没有这一轮项目', occupied: false,
      }
    }
    const withoutSnapshot = (phase: ValuationWorkflowRuntimePhase, error: string): ValuationWorkflowRuntimeStatus => ({
      phase,
      snapshot: state.lastSnapshot,
      projectId: state.projectId,
      parentSessionId: state.parentSessionId,
      error,
      occupied: state.occupied,
    })
    const scope = options.scopes.get(state.projectId)
    if (scope === undefined || scopeKeyOf(scope) !== state.scopeKey) {
      return withoutSnapshot('failed', '项目已关闭或已被重新打开')
    }
    const snapshot = await currentSnapshot(state)
    if (state.occupied) {
      const effective = snapshot ?? state.lastSnapshot
      return {
        // An unknown child stop without a business snapshot is a blocked run, never
        // an idle awaiting-agent one.
        phase: effective === null ? 'blocked' : 'failed',
        snapshot: effective,
        projectId: state.projectId,
        parentSessionId: state.parentSessionId,
        error: effective?.error || '上一轮停止状态未知，运行时保持占用',
        occupied: true,
      }
    }
    // A queued but not yet consumed decision is authoritative: the UI must poll rather
    // than read the previous business phase as if the decision had been applied.
    const pending = [...state.commands.values()].some((command) => command.status === 'pending')
    if (pending && state.activeCommandId === null && !state.starting) {
      return {
        phase: 'awaiting-agent',
        snapshot: snapshot ?? state.lastSnapshot,
        projectId: state.projectId,
        parentSessionId: state.parentSessionId,
        error: '',
        occupied: false,
      }
    }
    if (snapshot === null) {
      if (state.starting || state.activeCommandId !== null) return withoutSnapshot('preparing', '')
      const startResult = state.commands.get(state.startCommandId)?.result
      if (startResult !== null && startResult !== undefined && !startResult.ok) {
        return withoutSnapshot('failed', startResult.error ?? '工作流启动失败')
      }
      return withoutSnapshot('awaiting-agent', '')
    }
    return {
      phase: phaseOf(snapshot.status, snapshot.outcome),
      snapshot,
      projectId: state.projectId,
      parentSessionId: state.parentSessionId,
      error: snapshot.error,
      occupied: state.occupied,
    }
  }

  const questionnaireProblem = (snapshot: ValuationWorkflowSnapshot, input: ValuationQuestionEdit): string => {
    if (snapshot.revision !== input.expectedRevision) return '命令基于的版本已经过期'
    if ((snapshot.questionnaire?.version ?? 0) !== input.expectedQuestionVersion) return '问卷版本已经过期，请核对当前问题后重试'
    if (input.nodeId !== 'intent' && !(VALUATION_WORKFLOW_STAGES as readonly string[]).includes(input.nodeId)) {
      return '问卷节点无效'
    }
    const questions = snapshot.questionnaire?.questions ?? []
    if (Object.keys(input.answers).some((id) => !questions.some((q) => q.questionId === id && q.nodeId === input.nodeId))) {
      return '回答包含不属于该节点的问题'
    }
    const notes = snapshot.questionnaire?.notes ?? []
    if (Object.keys(input.noteEdits).some((id) => !notes.some((n) => n.noteId === id && n.nodeId === input.nodeId))) {
      return '备注修改不属于该节点'
    }
    return ''
  }

  const saveDraft = async (projectId: string, input: ValuationQuestionEdit): Promise<ValuationWorkflowRuntimeExecution> => {
    const state = projects.get(text(projectId))
    if (state === undefined || state.disposed) return refusal('没有这一轮项目', null)
    const scope = options.scopes.get(state.projectId)
    if (scope === undefined || scopeKeyOf(scope) !== state.scopeKey) return refusal('项目已关闭或已被重新打开', state.lastSnapshot)
    if (state.occupied) return refusal('上一轮停止状态未知，不能保存草稿', state.lastSnapshot)
    const edit = parseQuestionEdit(input, false)
    if (edit === null) return refusal('问卷草稿参数无效', state.lastSnapshot)
    const snapshot = await currentSnapshot(state)
    if (snapshot === null || state.service === null || state.runId === '') return refusal('工作流尚未启动', state.lastSnapshot)
    const currentScope = options.scopes.get(state.projectId)
    if (state.disposed || currentScope === undefined || scopeKeyOf(currentScope) !== state.scopeKey) {
      return refusal('项目已关闭或已被重新打开', snapshot)
    }
    const problem = questionnaireProblem(snapshot, edit)
    if (problem !== '') return { ok: false, errorKind: 'stale-revision', error: problem, snapshot }
    try {
      const outcome = asExecution(await state.service.saveDraft({ runId: state.runId, ...edit }))
      if (outcome.snapshot !== null) state.lastSnapshot = outcome.snapshot
      return outcome
    } catch {
      return commandFailure('问卷草稿保存失败', snapshot)
    }
  }

  const queue = (
    projectId: string,
    input: ValuationWorkflowRuntimeQueueInput,
  ): ValuationWorkflowRuntimeCommand => {
    const state = projects.get(text(projectId))
    if (state === undefined || state.disposed) return { ok: false, commandId: '', error: '没有这一轮项目' }
    const scope = options.scopes.get(state.projectId)
    if (scope === undefined || scopeKeyOf(scope) !== state.scopeKey) {
      return { ok: false, commandId: '', error: '项目已关闭或已被重新打开' }
    }
    if (state.occupied) return { ok: false, commandId: '', error: '上一轮停止状态未知，不能排入新命令' }
    const payload = input.payload
    if (!isRecord(payload)) return { ok: false, commandId: '', error: '命令参数必须是对象' }
    const action = input.action
    let intent: QueuedIntent
    if (action === 'questions-submit') {
      const edit = parseQuestionEdit(payload, true) as ValuationQuestionSubmit | null
      if (edit === null) return { ok: false, commandId: '', error: '问卷提交参数无效' }
      if (state.activeCommandId !== null || state.starting || state.lastSnapshot?.status === 'running') {
        return { ok: false, commandId: '', error: '当前节点仍在执行，不能提交问卷' }
      }
      const candidate: QueuedIntent = { kind: 'questions-submit', payload: edit }
      for (const existing of state.commands.values()) {
        if (existing.intent.kind === 'start' || existing.intent.payload.submissionId !== edit.submissionId) continue
        return intentPayloadKey(existing.intent) === intentPayloadKey(candidate)
          ? { ok: true, commandId: existing.id }
          : { ok: false, commandId: '', error: '同一提交标识已经用于另一条命令' }
      }
      if (state.lastSnapshot === null) return { ok: false, commandId: '', error: '工作流尚未启动' }
      const problem = questionnaireProblem(state.lastSnapshot, edit)
      if (problem !== '') return { ok: false, commandId: '', error: problem }
      intent = { kind: 'questions-submit', payload: edit }
    } else if (action === 'answer') {
      if (!hasExactKeys(payload, ['clarificationId', 'submissionId', 'expectedRevision', 'answers'])) {
        return { ok: false, commandId: '', error: '回答命令只接受待决事项、提交标识、版本与回答' }
      }
      const answers = payload.answers
      if (!isRecord(answers) || !Object.values(answers).every((value) => typeof value === 'string')) {
        return { ok: false, commandId: '', error: '回答必须是以字段名为键的文本值' }
      }
      intent = {
        kind: 'answer',
        payload: {
          clarificationId: text(payload.clarificationId),
          submissionId: text(payload.submissionId),
          expectedRevision: Number(payload.expectedRevision),
          answers: { ...(answers as Record<string, string>) },
        },
      }
    } else if (action === 'revise') {
      if (!hasExactKeys(payload, ['nodeId', 'submissionId', 'expectedRevision', 'reason', 'source', 'changes'])) {
        return { ok: false, commandId: '', error: '修订命令只接受节点、提交标识、版本、理由、来源与变更' }
      }
      if (!Array.isArray(payload.changes)) {
        return { ok: false, commandId: '', error: '修订必须给出变更清单' }
      }
      intent = {
        kind: 'revise',
        payload: {
          nodeId: text(payload.nodeId),
          submissionId: text(payload.submissionId),
          expectedRevision: Number(payload.expectedRevision),
          reason: text(payload.reason),
          source: text(payload.source),
          changes: payload.changes.map((change) => (
            isRecord(change) ? { field: text(change.field), value: change.value } : { field: '', value: undefined }
          )),
        },
      }
    } else if (action === 'approve-plan') {
      if (!hasExactKeys(payload, ['expectedRevision', 'planDigest', 'submissionId'])) {
        return { ok: false, commandId: '', error: '方案确认命令只接受版本、方案摘要与提交标识' }
      }
      intent = {
        kind: 'approve-plan',
        payload: {
          expectedRevision: Number(payload.expectedRevision),
          planDigest: text(payload.planDigest),
          submissionId: text(payload.submissionId),
        },
      }
    } else if (action === 'retry-intent') {
      if (!hasExactKeys(payload, ['expectedRevision', 'submissionId'])) {
        return { ok: false, commandId: '', error: '意图重试命令只接受版本与提交标识' }
      }
      intent = {
        kind: 'retry-intent',
        payload: {
          expectedRevision: Number(payload.expectedRevision),
          submissionId: text(payload.submissionId),
        },
      }
    } else {
      return { ok: false, commandId: '', error: '不支持的命令动作' }
    }
    if (!Number.isInteger(intent.payload.expectedRevision) || intent.payload.expectedRevision < 0) {
      return { ok: false, commandId: '', error: '命令必须携带有效版本' }
    }
    if (intent.kind === 'answer' && (intent.payload.clarificationId === '' || intent.payload.submissionId === '')) {
      return { ok: false, commandId: '', error: '回答命令缺少待决事项或提交标识' }
    }
    if (intent.kind === 'revise'
      && (intent.payload.nodeId === '' || intent.payload.submissionId === '' || intent.payload.reason === '' || intent.payload.source === '')) {
      return { ok: false, commandId: '', error: '修订命令缺少节点、提交标识、理由或来源' }
    }
    if (intent.kind === 'approve-plan' && (intent.payload.planDigest === '' || intent.payload.submissionId === '')) {
      return { ok: false, commandId: '', error: '方案确认命令缺少方案摘要或提交标识' }
    }
    if (intent.kind === 'retry-intent' && intent.payload.submissionId === '') {
      return { ok: false, commandId: '', error: '意图重试命令缺少提交标识' }
    }
    if (!state.started) return { ok: false, commandId: '', error: '工作流尚未启动' }
    const snapshot = state.lastSnapshot
    if (snapshot === null) return { ok: false, commandId: '', error: '工作流还没有可回答的版本' }
    if (snapshot.revision !== intent.payload.expectedRevision) {
      return { ok: false, commandId: '', error: '命令基于的版本已经过期' }
    }
    if (intent.kind === 'approve-plan') {
      const plan = snapshot.plan
      if (plan === null || !plan.ready || plan.accepted || plan.revision !== snapshot.revision) {
        return { ok: false, commandId: '', error: '当前版本没有可确认的完整方案' }
      }
      if (plan.digest !== intent.payload.planDigest) {
        return { ok: false, commandId: '', error: '方案摘要与当前版本不一致' }
      }
    }
    if (intent.kind === 'retry-intent') {
      // A live write owns the project; a stopped intent-only run is the only
      // eligible shape. Occupancy is already refused above.
      if (state.activeCommandId !== null) {
        return { ok: false, commandId: '', error: '当前已有执行中的命令，不能并发写入' }
      }
      if (!canRetryWorkflowIntent(snapshot)) {
        return { ok: false, commandId: '', error: '这一轮不是可在意图阶段重试的停止状态' }
      }
      // Concurrent recovery clicks reuse the one pending retry instead of
      // dispatching a second native attempt.
      for (const existing of state.commands.values()) {
        if (existing.intent.kind !== 'retry-intent') continue
        if (existing.status === 'done') continue
        return { ok: true, commandId: existing.id }
      }
    }
    // One submission id maps to exactly one queued command: an identical retry reuses the
    // existing opaque id (so the Host neither mints a new command nor re-dispatches),
    // while the same id with a changed payload is a conflict, never a second command.
    const submissionId = intent.payload.submissionId
    for (const existing of state.commands.values()) {
      if (existing.intent.kind === 'start') continue
      if (existing.intent.payload.submissionId !== submissionId) continue
      if (intentPayloadKey(existing.intent) === intentPayloadKey(intent)) {
        return { ok: true, commandId: existing.id }
      }
      return { ok: false, commandId: '', error: '同一提交标识已经用于另一条命令' }
    }
    const command = addCommand(state, intent)
    if (command === null) return { ok: false, commandId: '', error: '命令历史已满' }
    return { ok: true, commandId: command.id }
  }

  const cancel = async (projectId: string): Promise<{ ok: boolean; error?: string }> => {
    const state = projects.get(text(projectId))
    if (state === undefined || state.disposed) return { ok: false, error: '没有这一轮项目' }
    const scope = options.scopes.get(state.projectId)
    if (scope === undefined || scopeKeyOf(scope) !== state.scopeKey) {
      return { ok: false, error: '项目已关闭或已被重新打开' }
    }
    if (state.occupied) return { ok: false, error: '停止状态未知，不能确认取消完成' }
    const active = state.activeCommandId === null ? undefined : state.commands.get(state.activeCommandId)
    // Abort the owned child signal first: preparation and inference observe it.
    state.executionController?.abort()
    // A queued command must never start a replacement run after this cancellation.
    for (const command of state.commands.values()) {
      if (command.status !== 'pending') continue
      command.status = 'done'
      command.result = {
        ok: false,
        errorKind: 'cancelled',
        error: '命令已取消',
        snapshot: state.lastSnapshot,
      }
    }
    const service = state.service
    if (service !== null && state.runId !== '' && state.started) {
      cancelSequence += 1
      try {
        const outcome = await service.cancel({
          runId: state.runId,
          submissionId: `runtime-cancel-${String(cancelSequence)}`,
        })
        state.lastSnapshot = outcome.snapshot
        if (!outcome.ok) return { ok: false, error: outcome.error }
      } catch {
        return { ok: false, error: '取消未能送达工作流' }
      }
    }
    // Wait until the owned command really settles; release must not race it.
    if (active !== undefined && active.promise !== null) {
      let result: ValuationWorkflowRuntimeExecution | null = null
      try {
        result = await active.promise
      } catch {
        result = null
      }
      if (result !== null
        && (result.errorKind === 'stop-unknown' || result.snapshot?.errorKind === 'stop-unknown')) {
        state.occupied = true
        return { ok: false, error: result.error ?? PREPARE_STOP_UNKNOWN }
      }
      if (state.lastSnapshot === null && result?.snapshot !== null && result?.snapshot !== undefined) {
        state.lastSnapshot = result.snapshot
      }
    }
    return { ok: true }
  }

  const preview = (
    projectId: string,
    nodeId: string,
    changes: Array<{ field: string; value: unknown }>,
    expectedRevision: number,
  ): ValuationWorkflowRuntimePreview => previewValuationWorkflowRevision(
    text(projectId), text(nodeId), changes, expectedRevision,
  )

  /**
   * Pure guard for the genuine DSH pipeline. Only sessions owned by a registered
   * parent are constrained: they may enter the graph solely through the reserved
   * transports, and any nested business call must carry the exact live execution.
   */
  const guard = (execution: Readonly<ToolExecution>): string | undefined => {
    const agentId = execution.agent?.id
    if (typeof agentId !== 'string' || agentId === '') return undefined
    let owned: ProjectState | undefined
    for (const candidate of projects.values()) {
      if (candidate.parentSessionId === agentId) {
        owned = candidate
        break
      }
    }
    if (owned === undefined) return undefined
    if (execution.name === CONTROL_TOOL_NAME || execution.name === RUN_CODE_TRANSPORT) return undefined
    const current = owned.currentExecution
    if (current === undefined) return '本轮工作流尚未进入受控图执行：业务工具只能由图执行内部调用'
    const scope = options.scopes.get(owned.projectId)
    if (scope === undefined || scopeKeyOf(scope) !== owned.scopeKey) {
      return '本轮项目已关闭或已被重新打开：命令与业务工具都不再有效'
    }
    if (execution.parent !== current.token) return '业务工具只能由当前受控执行发出'
    if (execution.agent !== current.agent) return '调用身份与当前受控执行不一致'
    if (execution.rootCallId !== current.rootCallId) return '调用不属于当前受控执行的同一次请求'
    return undefined
  }

  const dispose = (): void => {
    for (const state of [...projects.values()]) removeProject(state)
    commandIndex.clear()
  }

  return { register, execute, status, guard, restore, release, reconcile, queue, saveDraft, cancel, preview, dispose }
}
