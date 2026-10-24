import { normalizeQuestionAnswer } from '../../../shared/contracts/valuation-question-answer.ts'
import type {
  ValuationWorkflowGraphView,
  ValuationWorkflowNodeView,
  ValuationWorkflowPlan,
  ValuationWorkflowProgressView,
  ValuationWorkflowSnapshot,
} from '../../../shared/contracts/valuation-workflow.ts'
import type { ValuationQuestionEdit, ValuationWorkflowQuestionnaire } from '../../../shared/contracts/valuation-questionnaire.ts'

/**
 * Client controller for the valuation workflow (protocol 43).
 *
 * Read-only toward the Host: `activate()` performs one passive `current` read and never
 * starts or resumes a run. Employee decisions (plan approval, answers, revisions, cancel,
 * load/clear/reconcile) are forwarded as explicit receipts.
 *
 * Stale responses are discarded with per-stream generation counters plus AbortSignals.
 * Mutations share one `busy` gate; a submission id stays stable per decision until accepted.
 */

/** Public projection of `valuation-workflow-current`. Missing fields are treated as missing. */
export interface ValuationWorkflowCurrentView {
  ok?: boolean
  empty?: boolean
  projectId?: string
  parentSessionId?: string
  runId?: string
  phase?: string
  snapshot?: ValuationWorkflowSnapshot | null
  progress?: ValuationWorkflowProgressView | null
  graph?: ValuationWorkflowGraphView | null
  errorKind?: string
  error?: string
}

export type ValuationWorkflowActionName = 'answer' | 'revise' | 'approve-plan' | 'questions-draft' | 'questions-submit'

export interface ValuationLocalQuestionDraft {
  edit: ValuationQuestionEdit
  submissionId?: string
  status: 'unsaved' | 'saving' | 'saved' | 'conflict' | 'error' | 'queued' | 'submitted'
  error: string
}

export interface ValuationWorkflowActionInput {
  action: ValuationWorkflowActionName
  projectId: string
  payload: Record<string, unknown>
}

export interface ValuationWorkflowRevisionInput {
  nodeId: string
  expectedRevision: number
  changes: Array<{ field: string; value: string }>
  reason: string
  source: string
}

export interface ValuationWorkflowAnswerInput {
  clarificationId: string
  expectedRevision: number
  answers: Record<string, string>
}

/** The exact plan identity displayed to the employee when they confirmed. */
export interface ValuationWorkflowPlanIdentity {
  expectedRevision: number
  planDigest: string
}

export interface ValuationWorkflowPreviewInput {
  nodeId: string
  expectedRevision: number
  changes: Array<{ field: string; value: string }>
}

export interface ValuationWorkflowDraftRevision {
  ok: boolean
  supersededNodeIds: string[]
  changes: Array<{ field: string; owner?: string }>
  error: string
}

export interface ValuationWorkflowControllerState {
  /** Host current projection; null means not read yet or rejected as malformed. */
  current: ValuationWorkflowCurrentView | null
  /** Selected node detail; null when none is selected. */
  detail: ValuationWorkflowNodeView | null
  loading: boolean
  busy: boolean
  error: string
  preview: ValuationWorkflowDraftRevision | null
  questionDrafts?: Record<string, ValuationLocalQuestionDraft>
}

/** Each method maps to one `valuation-workflow-*` Host operation. */
export interface ValuationWorkflowPort {
  current: (input: { projectId?: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  node: (input: { nodeId: string; projectId?: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  action: (input: ValuationWorkflowActionInput, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  preview?: (input: ValuationWorkflowPreviewInput & { projectId?: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  cancel?: (input: { projectId: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  export?: (input: { projectId: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  load?: (input: { serialized: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  /** Clear the Host current task; the optional project is only an ownership hint. */
  clear?: (input: { projectId?: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  reconcile?: (input: { projectId: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  openArtifact?: (input: { kind: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
}

export interface ValuationWorkflowController {
  getState: () => ValuationWorkflowControllerState
  subscribe: (listener: (state: ValuationWorkflowControllerState) => void) => () => void

  /** Enter the workflow: one passive `current` read, never a start/resume. */
  activate: () => Promise<void>
  /** Leave: abort in-flight reads and stop polling. */
  deactivate: () => void
  /** Final cleanup on plugin disposal; idempotent with `deactivate`. */
  dispose: () => void
  /** Read the current workflow again (refresh button or accepted handoff). */
  refresh: () => Promise<void>

  selectNode: (nodeId: string) => Promise<void>
  /** Approve the displayed plan with its exact revision and digest. */
  approvePlan: (displayed?: ValuationWorkflowPlanIdentity) => Promise<boolean>
  answer: (input: ValuationWorkflowAnswerInput) => Promise<boolean>
  saveQuestionDraft?: (input: ValuationQuestionEdit) => Promise<boolean>
  submitQuestions?: (input: ValuationQuestionEdit) => Promise<boolean>
  reconcileQuestionDraft?: (nodeId: string) => Promise<boolean>
  revise: (input: ValuationWorkflowRevisionInput) => Promise<boolean>
  /** Ask the Host to project the revision impact; never inferred on the Client. */
  preview: (input: ValuationWorkflowPreviewInput) => Promise<ValuationWorkflowDraftRevision | null>
  cancel: () => Promise<boolean>

  /** Export the current workflow JSON; empty string on failure. */
  export: () => Promise<string>
  load: (serialized: string) => Promise<boolean>
  clear: () => Promise<boolean>
  reconcile: () => Promise<boolean>
  /** Artifacts are addressed by kind only; the Host owns paths and opening. */
  openArtifact: (kind: string) => Promise<boolean>
}

export interface ValuationWorkflowControllerOptions {
  /** Poll only while active and running; enabled by default. */
  autoPoll?: boolean
  /** Poll interval; defaults to 4000ms. */
  pollIntervalMs?: number
  draftDebounceMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 4_000

const MESSAGES = {
  noCurrent: '还没有可用的估值进度：请先刷新。',
  noProject: '当前没有可继续的估值记录：请先完成资料核对。',
  serviceUnavailable: '估值服务暂时不可用：请稍后重试或重启应用。',
  protocol: '估值服务返回的数据无法识别：请稍后重试或重启应用。',
  currentFailed: '读取估值进度失败',
  nodeFailed: '读取节点详情失败',
  nodeMismatch: '节点版本与当前进度不一致：请刷新后重试。',
  actionFailed: '提交估值决定失败',
  planMissing: '还没有可以确认的评估方案：请刷新后重试。',
  planStale: '这份评估方案已经更新：请刷新后按最新方案重新确认。',
  decisionPending: 'Host 正在处理上一条决定：请等待状态刷新后再提交。',
  notReady: '方案还没有准备好：请先处理待确认事项。',
  alreadyAccepted: '这份方案已经确认过了。',
  clarificationMissing: '当前没有待确认事项。',
  revisionMissing: '修订需要节点、版本、理由、来源与至少一项变更。',
  revisionStale: '节点版本已经更新：请刷新后按最新版本重新修订。',
  previewFailed: '预演修订影响范围失败',
  cancelFailed: '取消当前估值失败',
  exportFailed: '导出估值流程失败',
  loadFailed: '导入估值流程失败',
  clearFailed: '清空当前估值失败',
  reconcileFailed: '重新对接估值服务失败',
  artifactFailed: '打开交付件失败',
} as const

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function asDetail(value: unknown): ValuationWorkflowNodeView | null {
  return isRecord(value) && text(value.nodeId) !== '' ? value as unknown as ValuationWorkflowNodeView : null
}

function revisionNumberOf(value: unknown): number | null {
  return isRecord(value) && typeof value.revision === 'number' && Number.isFinite(value.revision)
    ? value.revision
    : null
}

function revisionOf(current: ValuationWorkflowCurrentView | null): number | null {
  if (current === null) return null
  return revisionNumberOf(current.progress) ?? revisionNumberOf(current.snapshot)
}

/** Identity includes the revision so a refreshed revision invalidates the selected detail. */
function identityOf(current: ValuationWorkflowCurrentView | null): string {
  if (current === null) return ''
  return [text(current.projectId), text(current.runId), String(revisionOf(current) ?? '')].join('\u0000')
}

function taskIdentityOf(current: ValuationWorkflowCurrentView | null): string {
  return current === null ? '' : `${text(current.projectId)}\u0000${text(current.runId)}`
}

function questionnaireOf(current: ValuationWorkflowCurrentView | null): ValuationWorkflowQuestionnaire | undefined {
  return current?.progress?.questionnaire ?? current?.snapshot?.questionnaire
}

function orderedEdit(input: ValuationQuestionEdit, questionnaire?: ValuationWorkflowQuestionnaire, normalize = true): ValuationQuestionEdit {
  const answers: ValuationQuestionEdit['answers'] = {}
  for (const question of questionnaire?.questions ?? []) {
    if (question.nodeId === input.nodeId && question.applicable && question.answer !== null && !question.needsConfirmation) {
      answers[question.questionId] = question.answer
    }
  }
  Object.assign(answers, input.answers)
  for (const question of questionnaire?.questions ?? []) {
    if (question.nodeId === input.nodeId && !question.applicable) delete answers[question.questionId]
  }
  const clean: ValuationQuestionEdit['answers'] = {}
  for (const key of Object.keys(answers).sort()) {
    const answer = answers[key]
    clean[key] = normalizeQuestionAnswer(answer, normalize)
  }
  const noteEdits: Record<string, string> = {}
  for (const key of Object.keys(input.noteEdits).sort()) noteEdits[key] = normalize ? input.noteEdits[key].trim() : input.noteEdits[key]
  return { ...input, answers: clean, supplement: normalize ? input.supplement.trim() : input.supplement, noteEdits }
}

function statusOf(current: ValuationWorkflowCurrentView | null): string {
  if (current === null) return ''
  const progress = isRecord(current.progress) ? current.progress : null
  if (progress !== null && text(progress.status) !== '') return text(progress.status)
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  if (snapshot !== null && text(snapshot.status) !== '') return text(snapshot.status)
  return text(current.phase)
}

/**
 * The real snapshot timestamp, read from the existing shared field. It lets a
 * same-run/same-revision advance invalidate a selected node detail without adding
 * a wire field.
 */
function snapshotVersionOf(current: ValuationWorkflowCurrentView | null): string {
  if (current === null) return ''
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  const fromSnapshot = snapshot === null ? '' : text(snapshot.updatedAt)
  if (fromSnapshot !== '') return fromSnapshot
  const progress = isRecord(current.progress) ? current.progress : null
  return progress === null ? '' : text(progress.updatedAt)
}

function planOf(current: ValuationWorkflowCurrentView | null): ValuationWorkflowPlan | null {
  if (current === null) return null
  const progress = isRecord(current.progress) ? current.progress : null
  const fromProgress = progress !== null && isRecord(progress.plan) ? progress.plan : null
  if (fromProgress !== null) return fromProgress as unknown as ValuationWorkflowPlan
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  return snapshot !== null && isRecord(snapshot.plan) ? snapshot.plan as unknown as ValuationWorkflowPlan : null
}

function clarificationOf(current: ValuationWorkflowCurrentView | null): { clarificationId: string; revision: number } | null {
  if (current === null) return null
  const progress = isRecord(current.progress) ? current.progress : null
  const fromProgress = progress !== null && isRecord(progress.clarification) ? progress.clarification : null
  if (fromProgress !== null && text(fromProgress.clarificationId) !== '') {
    return {
      clarificationId: text(fromProgress.clarificationId),
      revision: typeof fromProgress.revision === 'number' ? fromProgress.revision : 0,
    }
  }
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  const fromSnapshot = snapshot !== null && isRecord(snapshot.clarification) ? snapshot.clarification : null
  if (fromSnapshot !== null && text(fromSnapshot.clarificationId) !== '') {
    return {
      clarificationId: text(fromSnapshot.clarificationId),
      revision: typeof fromSnapshot.revision === 'number' ? fromSnapshot.revision : 0,
    }
  }
  return null
}

function errorOf(payload: Record<string, unknown>, fallback: string): string {
  const error = text(payload.error)
  if (error !== '') return error
  const kind = text(payload.errorKind)
  if (kind === 'capability-gap') return MESSAGES.serviceUnavailable
  if (kind === 'stale-revision') return MESSAGES.revisionStale
  return fallback
}

function previewOf(value: unknown): ValuationWorkflowDraftRevision | null {
  if (!isRecord(value)) return null
  return {
    ok: value.ok === true,
    supersededNodeIds: Array.isArray(value.supersededNodeIds)
      ? value.supersededNodeIds.filter((item): item is string => typeof item === 'string')
      : [],
    changes: Array.isArray(value.changes)
      ? value.changes.flatMap((item) => {
        if (!isRecord(item)) return []
        const field = text(item.field)
        if (field === '') return []
        return [{ field, owner: text(item.owner) }]
      })
      : [],
    error: text(value.error),
  }
}

type CurrentValidation =
  | { ok: true; current: ValuationWorkflowCurrentView }
  | { ok: false; error: string }

/**
 * Native queue/preparation phases the Host may report before any business snapshot
 * exists. They are the only explicit phases allowed with `snapshot === null`.
 */
const PENDING_PHASES = new Set(['preparing', 'awaiting-agent', 'blocked', 'failed'])

/** Pre-business failure phases must carry an explicit safe failure receipt. */
const FAILURE_PHASES = new Set(['blocked', 'failed'])

/** Phases that still have live work on the Host side, so the page keeps polling. */
const ACTIVE_PHASES = new Set(['preparing', 'awaiting-agent', 'running'])

/** A real parent waiting for its first snapshot, or a known pre-business failure. */
function isPendingCurrent(current: ValuationWorkflowCurrentView | null): boolean {
  if (current === null || current.empty === true) return false
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  const progress = isRecord(current.progress) ? current.progress : null
  return (snapshot === null || progress === null) && PENDING_PHASES.has(text(current.phase))
}

/**
 * Validate the current receipt just enough to trust identity, revision, graph and progress.
 * The Host owns full DTO validation; this layer must not demand every stage field, but it
 * must refuse absent/contradictory identity instead of showing a stale or invented run.
 */
function validateCurrent(payload: Record<string, unknown>): CurrentValidation {
  if (payload.ok !== true) return { ok: false, error: errorOf(payload, MESSAGES.currentFailed) }
  if (typeof payload.empty !== 'boolean') return { ok: false, error: MESSAGES.protocol }
  const current = payload as ValuationWorkflowCurrentView
  if (current.empty === true) return { ok: true, current }
  const projectId = text(current.projectId)
  const runId = text(current.runId)
  if (projectId === '' || runId === '') return { ok: false, error: MESSAGES.protocol }
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  const progress = isRecord(current.progress) ? current.progress : null
  /**
   * Pre-snapshot states are accepted only for an explicit known phase with a real parent.
   * A `blocked`/`failed` receipt must also carry a safe failure reason, otherwise an
   * unexplained null failure would look like a successful empty run.
   */
  if (snapshot === null || progress === null) {
    const phase = text(current.phase)
    if (!PENDING_PHASES.has(phase)) return { ok: false, error: MESSAGES.protocol }
    if (text(current.parentSessionId) === '') return { ok: false, error: MESSAGES.protocol }
    if (FAILURE_PHASES.has(phase)
      && (text(current.errorKind) === '' || text(current.error) === '')) {
      return { ok: false, error: MESSAGES.protocol }
    }
    return { ok: true, current }
  }
  const graph = isRecord(current.graph)
    ? current.graph
    : (isRecord(progress.graph) ? progress.graph : null)
  if (graph === null) {
    return { ok: false, error: MESSAGES.protocol }
  }
  if (text(progress.runId) !== runId || text(snapshot.runId) !== runId) {
    return { ok: false, error: MESSAGES.protocol }
  }
  const snapshotRevision = revisionNumberOf(snapshot)
  const progressRevision = revisionNumberOf(progress)
  if (snapshotRevision === null || progressRevision === null || snapshotRevision !== progressRevision) {
    return { ok: false, error: MESSAGES.protocol }
  }
  return { ok: true, current }
}

export function createValuationWorkflowController(
  port: ValuationWorkflowPort,
  options: ValuationWorkflowControllerOptions = {},
): ValuationWorkflowController {
  const autoPoll = options.autoPoll !== false
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  let state: ValuationWorkflowControllerState = {
    current: null,
    detail: null,
    loading: false,
    busy: false,
    error: '',
    preview: null,
  }
  const listeners = new Set<(next: ValuationWorkflowControllerState) => void>()
  let active = false
  let readGeneration = 0
  let nodeGeneration = 0
  let readAbort: AbortController | null = null
  let nodeAbort: AbortController | null = null
  let detailRefresh: { key: string; promise: Promise<void> } | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const submissions = new Map<string, string>()
  type PendingDraft = { timer: ReturnType<typeof setTimeout> | null; running: boolean; sequence: number; waiters: Array<(ok: boolean) => void> }
  const pendingDrafts = new Map<string, PendingDraft>()
  let draftQueue: Promise<unknown> = Promise.resolve()
  let questionEpoch = 0
  let submissionSeq = 0
  /** Set after the controller object exists; used to refresh a selected node in place. */
  let reSelect: ((nodeId: string) => Promise<void>) | null = null

  const write = (next: Partial<ValuationWorkflowControllerState>): void => {
    state = { ...state, ...next }
    for (const notify of [...listeners]) notify(state)
  }

  const writeDraft = (nodeId: string, draft: ValuationLocalQuestionDraft): void => {
    write({ questionDrafts: { ...state.questionDrafts, [nodeId]: draft } })
  }

  const stopDrafts = (): void => {
    questionEpoch += 1
    for (const pending of pendingDrafts.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      for (const resolve of pending.waiters) resolve(false)
    }
    pendingDrafts.clear()
  }

  const acceptQuestionnaire = (questionnaire: ValuationWorkflowQuestionnaire): void => {
    const current = state.current
    if (current === null) return
    const previous = questionnaireOf(current)
    if (previous !== undefined && questionnaire.version < previous.version) return
    const drafts = { ...state.questionDrafts }
    for (const [id, draft] of Object.entries(drafts)) {
      if (draft.status !== 'conflict') drafts[id] = { ...draft, edit: { ...draft.edit, expectedQuestionVersion: questionnaire.version } }
    }
    write({ current: { ...current,
      ...(current.progress ? { progress: { ...current.progress, questionnaire } } : {}),
      ...(current.snapshot ? { snapshot: { ...current.snapshot, questionnaire } } : {}) }, questionDrafts: drafts })
  }

  const flushDraft = (nodeId: string): Promise<boolean> => {
    const pending = pendingDrafts.get(nodeId)
    if (pending === undefined) return Promise.resolve(state.questionDrafts?.[nodeId]?.status === 'saved')
    if (pending.timer !== null) { clearTimeout(pending.timer); pending.timer = null }
    const promise = new Promise<boolean>((resolve) => { pending.waiters.push(resolve) })
    if (pending.running) return promise
    pending.running = true
    const epoch = questionEpoch
    const identity = taskIdentityOf(state.current)
    draftQueue = draftQueue.then(async () => {
      let ok = false
      while (epoch === questionEpoch && identity === taskIdentityOf(state.current)) {
        const draft = state.questionDrafts?.[nodeId]
        if (draft === undefined || draft.status === 'conflict') break
        const sequence = pending.sequence
        const sent = orderedEdit(draft.edit, questionnaireOf(state.current))
        writeDraft(nodeId, { ...draft, status: 'saving', error: '' })
        try {
          const result = await port.action({ action: 'questions-draft', projectId: projectIdOf(), payload: { ...sent } })
          if (epoch !== questionEpoch || identity !== taskIdentityOf(state.current)) break
          const latest = state.questionDrafts?.[nodeId] ?? draft
          if (result.ok !== true) {
            const conflict = /conflict|stale|version/.test(text(result.errorKind)) || /版本|冲突/.test(text(result.error))
            writeDraft(nodeId, { ...latest, status: conflict ? 'conflict' : 'error', error: errorOf(result, '草稿保存失败，请重试。') })
            break
          }
          if (isRecord(result.questionnaire) && typeof result.questionnaire.version === 'number') {
            acceptQuestionnaire(result.questionnaire as unknown as ValuationWorkflowQuestionnaire)
          } else {
            await readCurrent()
          }
          if (epoch !== questionEpoch) break
          const saved = state.questionDrafts?.[nodeId] ?? latest
          if (pending.sequence !== sequence) continue
          writeDraft(nodeId, { ...saved, status: 'saved', error: '' })
          ok = true
          break
        } catch (cause) {
          if (epoch !== questionEpoch) break
          const latest = state.questionDrafts?.[nodeId] ?? draft
          writeDraft(nodeId, { ...latest, status: 'error', error: `草稿保存失败：${describe(cause)}` })
          break
        }
      }
      pending.running = false
      for (const resolve of pending.waiters.splice(0)) resolve(ok)
    })
    return promise
  }

  const abortRead = (): void => {
    if (readAbort !== null) {
      try { readAbort.abort() } catch (error) { void error }
      readAbort = null
    }
  }

  const abortNode = (): void => {
    detailRefresh = null
    if (nodeAbort !== null) {
      try { nodeAbort.abort() } catch (error) { void error }
      nodeAbort = null
    }
  }

  const clearPoll = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  const projectIdOf = (): string => text(state.current?.projectId)

  const submissionIdOf = (key: string): string => {
    const existing = submissions.get(key)
    if (existing !== undefined) return existing
    submissionSeq += 1
    const minted = `valuation-workflow-${String(submissionSeq)}-${String(Date.now())}`
    submissions.set(key, minted)
    return minted
  }

  /**
   * Poll while the Host reports live work. The native queue phase is authoritative:
   * `awaiting-agent` must keep polling even when the previous snapshot was still
   * `waiting-user`, otherwise plan confirmation would stall the page.
   */
  const shouldPoll = (current: ValuationWorkflowCurrentView | null): boolean => {
    if (current === null || current.empty === true) return false
    if (ACTIVE_PHASES.has(text(current.phase))) return true
    return statusOf(current) === 'running'
  }

  /**
   * The native phase is authoritative for decisions too. While the Host still reports a
   * queued/running phase, the previous snapshot may still say `waiting-user`; submitting
   * again would duplicate an already-accepted command against an outdated plan.
   */
  const decisionsBlocked = (): boolean => {
    const current = state.current
    if (current === null || current.empty === true) return false
    return ACTIVE_PHASES.has(text(current.phase))
  }

  const schedulePoll = (): void => {
    clearPoll()
    if (!autoPoll || !active) return
    if (!shouldPoll(state.current)) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      if (!active) return
      void readCurrent(false)
    }, pollIntervalMs)
  }

  const readCurrent = async (waitForDetail = true): Promise<void> => {
    readGeneration += 1
    const round = readGeneration
    abortRead()
    const controller = new AbortController()
    readAbort = controller
    write({ loading: true })
    try {
      const payload = await port.current({}, { signal: controller.signal })
      if (round !== readGeneration) return
      readAbort = null
      const validated = validateCurrent(payload)
      if (!validated.ok) {
        write({ loading: false, current: null, detail: null, error: validated.error })
        return
      }
      const previous = identityOf(state.current)
      const next = identityOf(validated.current)
      const previousVersion = snapshotVersionOf(state.current)
      const nextVersion = snapshotVersionOf(validated.current)
      const sameIdentity = previous !== '' && previous === next
      const sameTask = taskIdentityOf(state.current) === taskIdentityOf(validated.current)
      const oldQuestionnaire = questionnaireOf(state.current)
      const incomingQuestionnaire = questionnaireOf(validated.current)
      if (!sameTask) stopDrafts()
      const questionDrafts = sameTask ? { ...state.questionDrafts } : {}
      if (sameTask && incomingQuestionnaire !== undefined) {
        if (oldQuestionnaire !== undefined && incomingQuestionnaire.version < oldQuestionnaire.version) {
          if (validated.current.progress) validated.current.progress = { ...validated.current.progress, questionnaire: oldQuestionnaire }
          if (validated.current.snapshot) validated.current.snapshot = { ...validated.current.snapshot, questionnaire: oldQuestionnaire }
        } else {
          for (const [id, draft] of Object.entries(questionDrafts)) {
            if (draft.status === 'queued' && incomingQuestionnaire.submissions.some((submission) => submission.submissionId === draft.submissionId)) {
              delete questionDrafts[id]
              continue
            }
            if (draft.edit.expectedQuestionVersion === incomingQuestionnaire.version || pendingDrafts.get(id)?.running) continue
            if (draft.status === 'saved' || draft.status === 'submitted') delete questionDrafts[id]
            else questionDrafts[id] = { ...draft, status: 'conflict', error: '问卷已有新版本。已保留本地修改，请核对最新问题后继续保存。' }
          }
        }
      }
      write({
        loading: false,
        current: validated.current,
        // A changed project/run/revision invalidates the selected node detail.
        detail: sameIdentity ? state.detail : null,
        error: '',
        questionDrafts,
      })
      // An accepted submission keeps its stable id while the identity is unchanged; once
      // the Host moves to another run/revision, the old binding is dropped.
      if (previous !== next) submissions.clear()
      // The same run/revision can still advance (a clarification was answered, a
      // correction settled). A real snapshot timestamp change invalidates the stale
      // selected detail and refreshes that same node through the existing guards.
      let refreshing: Promise<void> | null = null
      if (sameIdentity && state.detail !== null
        && previousVersion !== '' && nextVersion !== '' && previousVersion !== nextVersion) {
        const selected = state.detail.nodeId
        const key = `${next}\u0000${selected}`
        if (reSelect !== null) {
          if (detailRefresh === null || detailRefresh.key !== key) {
            const pending = { key, promise: reSelect(selected) }
            detailRefresh = pending
            const settled = (): void => { if (detailRefresh === pending) detailRefresh = null }
            void pending.promise.then(settled, settled)
          }
          refreshing = detailRefresh.promise
        }
      }
      if (active) schedulePoll()
      if (waitForDetail && refreshing !== null) await refreshing
    } catch (cause) {
      if (round !== readGeneration) return
      readAbort = null
      write({ loading: false, current: null, detail: null, error: `${MESSAGES.currentFailed}：${describe(cause)}` })
    }
  }

  const dispatch = async (
    action: ValuationWorkflowActionName,
    payload: Record<string, unknown>,
    submissionKey: string,
  ): Promise<boolean> => {
    if (state.busy) return false
    const projectId = projectIdOf()
    if (projectId === '') {
      write({ error: MESSAGES.noProject })
      return false
    }
    write({ busy: true, error: '' })
    try {
      const result = await port.action({ action, projectId, payload })
      if (result.ok !== true) {
        write({ busy: false, error: errorOf(result, MESSAGES.actionFailed) })
        return false
      }
      // Keep the accepted submission binding: a failed/unknown retry and any follow-up
      // against the same identity reuse the same submission id until identity changes.
      write({ busy: false, error: '' })
      await readCurrent()
      return true
    } catch (cause) {
      write({ busy: false, error: `${MESSAGES.actionFailed}：${describe(cause)}` })
      return false
    }
  }

  const projectAction = async (
    call: ((input: { projectId: string }, options: { signal?: AbortSignal }) => Promise<Record<string, unknown>>) | undefined,
    fallback: string,
  ): Promise<boolean> => {
    const projectId = projectIdOf()
    if (projectId === '') {
      write({ error: MESSAGES.noProject })
      return false
    }
    if (call === undefined) {
      write({ error: MESSAGES.serviceUnavailable })
      return false
    }
    if (state.busy) return false
    write({ busy: true, error: '' })
    try {
      const result = await call({ projectId }, {})
      if (result.ok !== true) {
        write({ busy: false, error: errorOf(result, fallback) })
        return false
      }
      write({ busy: false, error: '' })
      await readCurrent()
      return true
    } catch (cause) {
      write({ busy: false, error: `${fallback}：${describe(cause)}` })
      return false
    }
  }

  const controller: ValuationWorkflowController = {
    getState: () => state,
    subscribe: (next) => {
      listeners.add(next)
      return () => { listeners.delete(next) }
    },

    activate: async () => {
      const previousTask = taskIdentityOf(state.current)
      if (pendingDrafts.size > 0) await Promise.all([...pendingDrafts.keys()].map((nodeId) => flushDraft(nodeId)))
      const retainedDrafts = Object.fromEntries(Object.entries(state.questionDrafts ?? {})
        .filter(([, draft]) => !['saved', 'submitted', 'queued'].includes(draft.status)))
      active = true
      // Re-entering the page (module switch, workspace change) must not keep showing the
      // previous workspace's projection while the fresh passive read is in flight.
      readGeneration += 1
      nodeGeneration += 1
      abortRead()
      abortNode()
      clearPoll()
      submissions.clear()
      stopDrafts()
      write({ current: null, detail: null, preview: null, error: '', loading: true, questionDrafts: {} })
      await readCurrent()
      if (previousTask !== '' && previousTask === taskIdentityOf(state.current) && Object.keys(retainedDrafts).length > 0) {
        write({ questionDrafts: { ...state.questionDrafts, ...retainedDrafts } })
      }
    },

    deactivate: () => {
      for (const nodeId of pendingDrafts.keys()) void flushDraft(nodeId)
      active = false
      readGeneration += 1
      nodeGeneration += 1
      abortRead()
      abortNode()
      clearPoll()
    },

    dispose: () => {
      controller.deactivate()
      stopDrafts()
      listeners.clear()
    },

    refresh: async () => {
      await readCurrent()
    },

    selectNode: async (nodeId) => {
      const id = text(nodeId)
      if (id === '') return
      const current = state.current
      const expectedIdentity = identityOf(current)
      const projectId = text(current?.projectId)
      const expectedRevision = revisionOf(current)
      if (expectedRevision === null) {
        // Before the first snapshot there is no revision to inspect; a known pending run
        // simply has no node detail yet, it is not an error the employee must fix.
        if (!isPendingCurrent(current)) write({ error: MESSAGES.noCurrent })
        return
      }
      // A node the employee just selected must not keep showing the previous node's
      // receipt while its own read is in flight. Re-selecting the same node keeps the
      // current receipt visible during polling refreshes.
      if (state.detail !== null && state.detail.nodeId !== id) write({ detail: null })
      nodeGeneration += 1
      const round = nodeGeneration
      abortNode()
      const nodeController = new AbortController()
      nodeAbort = nodeController
      try {
        const payload = await port.node(
          { nodeId: id, ...(projectId === '' ? {} : { projectId }) },
          { signal: nodeController.signal },
        )
        if (round !== nodeGeneration) return
        nodeAbort = null
        if (payload.ok !== true) {
          write({ error: errorOf(payload, MESSAGES.nodeFailed) })
          return
        }
        // The Host must still describe the same run/revision we selected from.
        if (identityOf(state.current) !== expectedIdentity) return
        const detail = asDetail(payload.detail)
        const detailRevision = detail === null ? null : revisionNumberOf(detail)
        if (detail === null || detail.nodeId !== id || detailRevision !== expectedRevision) {
          write({ detail: null, error: MESSAGES.nodeMismatch })
          return
        }
        write({ detail, error: '' })
      } catch (cause) {
        if (round !== nodeGeneration) return
        nodeAbort = null
        write({ error: `${MESSAGES.nodeFailed}：${describe(cause)}` })
      }
    },

    approvePlan: async (displayed) => {
      if (state.busy) return false
      if (decisionsBlocked()) {
        write({ error: MESSAGES.decisionPending })
        return false
      }
      const projectId = projectIdOf()
      if (projectId === '') {
        write({ error: MESSAGES.noProject })
        return false
      }
      const plan = planOf(state.current)
      if (plan === null || text(plan.digest) === '' || typeof plan.revision !== 'number') {
        write({ error: MESSAGES.planMissing })
        return false
      }
      // Acceptance is bound to the exact plan the employee saw. If the Host already moved
      // to a newer plan/revision, refuse instead of silently approving the undisplayed one.
      if (displayed !== undefined) {
        const expectedRevision = typeof displayed.expectedRevision === 'number'
          ? displayed.expectedRevision
          : Number.NaN
        if (plan.revision !== expectedRevision || plan.digest !== text(displayed.planDigest)) {
          write({ error: MESSAGES.planStale })
          return false
        }
      }
      if (plan.ready !== true) {
        write({ error: MESSAGES.notReady })
        return false
      }
      if (plan.accepted === true) {
        write({ error: MESSAGES.alreadyAccepted })
        return false
      }
      const key = `approve-plan:${plan.digest}:${String(plan.revision)}`
      return await dispatch('approve-plan', {
        expectedRevision: plan.revision,
        planDigest: plan.digest,
        submissionId: submissionIdOf(key),
      }, key)
    },

    answer: async (input) => {
      if (state.busy) return false
      if (decisionsBlocked()) {
        write({ error: MESSAGES.decisionPending })
        return false
      }
      const clarificationId = text(input?.clarificationId)
      const answers = isRecord(input?.answers) ? input.answers : {}
      const cleaned: Record<string, string> = {}
      for (const [field, value] of Object.entries(answers)) {
        if (text(field) === '') continue
        const answer = text(value)
        if (answer !== '') cleaned[field] = answer
      }
      if (clarificationId === '' || Object.keys(cleaned).length === 0) {
        write({ error: MESSAGES.clarificationMissing })
        return false
      }
      const expectedRevision = typeof input.expectedRevision === 'number'
        ? input.expectedRevision
        : (clarificationOf(state.current)?.revision ?? 0)
      // Bind the submission to the exact cleaned answers so a corrected value mints a
      // new id while an identical retry (even with reordered fields) reuses the old one.
      // The same sorted object is sent as the payload so the runtime's canonical
      // payload comparison agrees with the controller's submission identity.
      const orderedAnswers: Record<string, string> = {}
      for (const field of Object.keys(cleaned).sort()) orderedAnswers[field] = cleaned[field] as string
      const key = `answer:${clarificationId}:${String(expectedRevision)}:${JSON.stringify(orderedAnswers)}`
      return await dispatch('answer', {
        clarificationId,
        submissionId: submissionIdOf(key),
        expectedRevision,
        answers: orderedAnswers,
      }, key)
    },

    saveQuestionDraft: async (input) => {
      if (projectIdOf() === '') return false
      const id = text(input.nodeId)
      if (id === '') return false
      const previous = state.questionDrafts?.[id]
      const edit = orderedEdit(input, questionnaireOf(state.current), false)
      // Only versions acknowledged by this controller may advance a local edit.
      if (previous !== undefined) edit.expectedQuestionVersion = previous.edit.expectedQuestionVersion
      writeDraft(id, { edit, status: previous?.status === 'conflict' ? 'conflict' : 'unsaved', error: previous?.status === 'conflict' ? previous.error : '' })
      if (previous?.status === 'conflict') return false
      let pending = pendingDrafts.get(id)
      if (pending === undefined) {
        pending = { timer: null, running: false, sequence: 0, waiters: [] }
        pendingDrafts.set(id, pending)
      }
      pending.sequence += 1
      if (pending.timer !== null) clearTimeout(pending.timer)
      const promise = new Promise<boolean>((resolve) => { pending.waiters.push(resolve) })
      if (!pending.running) {
        if (options.draftDebounceMs === 0) void flushDraft(id)
        else pending.timer = setTimeout(() => { void flushDraft(id) }, options.draftDebounceMs ?? 500)
      }
      return await promise
    },

    reconcileQuestionDraft: async (nodeId) => {
      const identity = taskIdentityOf(state.current)
      await readCurrent()
      const latest = state.questionDrafts?.[nodeId]
      const q = questionnaireOf(state.current)
      if (latest === undefined || q === undefined || identity !== taskIdentityOf(state.current)) return false
      const edit = { ...latest.edit, expectedRevision: revisionOf(state.current) ?? latest.edit.expectedRevision, expectedQuestionVersion: q.version }
      writeDraft(nodeId, { edit, status: 'unsaved', error: '' })
      const saving = controller.saveQuestionDraft!(edit)
      void flushDraft(nodeId)
      return await saving
    },

    submitQuestions: async (input) => {
      if (state.busy || decisionsBlocked() || statusOf(state.current) === 'running') return false
      const identity = taskIdentityOf(state.current)
      const id = input.nodeId
      if (state.questionDrafts?.[id]?.status === 'conflict') return false
      const latest = state.questionDrafts?.[id]
      const edit = orderedEdit(input, questionnaireOf(state.current))
      const content = (value: ValuationQuestionEdit): string => JSON.stringify({ answers: value.answers, supplement: value.supplement, noteEdits: value.noteEdits })
      if (latest === undefined || content(latest.edit) !== content(edit) || !['saved', 'submitted'].includes(latest.status)) {
        const saving = controller.saveQuestionDraft!(edit)
        void flushDraft(id)
        if (!await saving) return false
      }
      if (identity !== taskIdentityOf(state.current) || state.busy || decisionsBlocked()) return false
      const saved = state.questionDrafts?.[id]
      if (saved === undefined || saved.status === 'conflict') return false
      const payload = { ...orderedEdit(saved.edit, questionnaireOf(state.current)), expectedRevision: revisionOf(state.current) ?? saved.edit.expectedRevision }
      const key = `questions-submit:${JSON.stringify(payload)}`
      const submissionId = submissionIdOf(key)
      const accepted = await dispatch('questions-submit', { ...payload, submissionId }, key)
      if (!accepted && identity === taskIdentityOf(state.current)) {
        const error = state.error || '正式答案未被接收，请保留修改并重试。'
        const conflict = /版本|冲突|过期/.test(error)
        const retained = state.questionDrafts?.[id] ?? saved
        await readCurrent()
        if (identity === taskIdentityOf(state.current)) writeDraft(id, { ...(state.questionDrafts?.[id] ?? retained),
          status: conflict ? 'conflict' : 'error', error })
      }
      if (accepted && identity === taskIdentityOf(state.current)) {
        const retained = state.questionDrafts?.[id]
        if (retained !== undefined && content(retained.edit) === content(saved.edit)) {
          const persisted = questionnaireOf(state.current)?.submissions.some((submission) => submission.submissionId === submissionId) === true
          writeDraft(id, { ...retained, edit: { ...retained.edit, ...(persisted ? { supplement: '' } : {}) },
            submissionId, status: persisted ? 'submitted' : 'queued', error: '' })
        }
      }
      return accepted
    },

    revise: async (input) => {
      if (state.busy) return false
      if (decisionsBlocked()) {
        write({ error: MESSAGES.decisionPending })
        return false
      }
      const nodeId = text(input?.nodeId)
      const changes = Array.isArray(input?.changes) ? input.changes : []
      const reason = text(input?.reason)
      const source = text(input?.source)
      const expectedRevision = typeof input?.expectedRevision === 'number' ? input.expectedRevision : -1
      const failedMarketRetry = state.current?.progress?.status === 'failed'
        && state.current.progress.market?.recovery?.retryAllowed === true
      if (nodeId === '' || expectedRevision < 0 || reason === '' || source === '' || (changes.length === 0 && !failedMarketRetry)) {
        write({ error: MESSAGES.revisionMissing })
        return false
      }
      if (state.detail !== null && state.detail.nodeId === nodeId && state.detail.revision !== expectedRevision) {
        write({ error: MESSAGES.revisionStale })
        return false
      }
      const key = `revise:${nodeId}:${String(expectedRevision)}:${JSON.stringify(changes)}:${reason}:${source}`
      return await dispatch('revise', {
        nodeId,
        submissionId: submissionIdOf(key),
        expectedRevision,
        reason,
        source,
        changes: changes.map((change) => ({ field: text(change.field), value: change.value })),
      }, key)
    },

    preview: async (input) => {
      const nodeId = text(input?.nodeId)
      const expectedRevision = typeof input?.expectedRevision === 'number' ? input.expectedRevision : -1
      const changes = Array.isArray(input?.changes) ? input.changes : []
      if (nodeId === '' || expectedRevision < 0 || changes.length === 0) {
        write({ error: MESSAGES.revisionMissing })
        return null
      }
      if (port.preview === undefined) {
        write({ error: MESSAGES.serviceUnavailable })
        return null
      }
      try {
        const projectId = projectIdOf()
        const payload = await port.preview({
          ...(projectId === '' ? {} : { projectId }),
          nodeId,
          expectedRevision,
          changes: changes.map((change) => ({ field: text(change.field), value: change.value })),
        }, {})
        if (payload.ok !== true) {
          write({ error: errorOf(payload, MESSAGES.previewFailed) })
          return null
        }
        const preview = previewOf(payload)
        if (preview === null) {
          write({ error: MESSAGES.previewFailed })
          return null
        }
        write({ preview, error: '' })
        return preview
      } catch (cause) {
        write({ error: `${MESSAGES.previewFailed}：${describe(cause)}` })
        return null
      }
    },

    cancel: async () => await projectAction(port.cancel, MESSAGES.cancelFailed),

    export: async () => {
      const projectId = projectIdOf()
      if (projectId === '') {
        write({ error: MESSAGES.noProject })
        return ''
      }
      if (port.export === undefined) {
        write({ error: MESSAGES.serviceUnavailable })
        return ''
      }
      try {
        const result = await port.export({ projectId }, {})
        const serialized = text(result.serialized)
        if (result.ok !== true || serialized === '') {
          write({ error: errorOf(result, MESSAGES.exportFailed) })
          return ''
        }
        write({ error: '' })
        return serialized
      } catch (cause) {
        write({ error: `${MESSAGES.exportFailed}：${describe(cause)}` })
        return ''
      }
    },

    load: async (serialized) => {
      const value = text(serialized)
      if (value === '') {
        write({ error: MESSAGES.loadFailed })
        return false
      }
      if (port.load === undefined) {
        write({ error: MESSAGES.serviceUnavailable })
        return false
      }
      if (state.busy) return false
      write({ busy: true, error: '' })
      try {
        const result = await port.load({ serialized: value }, {})
        if (result.ok !== true) {
          write({ busy: false, error: errorOf(result, MESSAGES.loadFailed) })
          return false
        }
        write({ busy: false, error: '' })
        await readCurrent()
        return true
      } catch (cause) {
        write({ busy: false, error: `${MESSAGES.loadFailed}：${describe(cause)}` })
        return false
      }
    },

    clear: async () => {
      if (state.busy) return false
      if (port.clear === undefined) {
        write({ error: MESSAGES.serviceUnavailable })
        return false
      }
      const projectId = projectIdOf()
      write({ busy: true, error: '' })
      /**
       * Invalidate every in-flight read *before* the Host call: a late `current` or node
       * response from the cleared run must not resurrect the old graph after success.
       * The Host owns the stop-before-clear guard; a refusal keeps identity and draft.
       */
      readGeneration += 1
      nodeGeneration += 1
      abortRead()
      abortNode()
      clearPoll()
      try {
        const result = await port.clear(projectId === '' ? {} : { projectId }, {})
        if (result.ok !== true) {
          write({ busy: false, error: errorOf(result, MESSAGES.clearFailed) })
          return false
        }
        submissions.clear()
        stopDrafts()
        write({ busy: false, current: null, detail: null, preview: null, error: '', questionDrafts: {} })
        // Re-read the now-empty Host current: success means the cleared identity, not a
        // Client-invented empty projection.
        await readCurrent()
        return true
      } catch (cause) {
        write({ busy: false, error: `${MESSAGES.clearFailed}：${describe(cause)}` })
        return false
      }
    },
    reconcile: async () => await projectAction(port.reconcile, MESSAGES.reconcileFailed),

    openArtifact: async (kind) => {
      const artifactKind = text(kind)
      if (artifactKind === '') return false
      if (port.openArtifact === undefined) {
        write({ error: MESSAGES.serviceUnavailable })
        return false
      }
      try {
        const result = await port.openArtifact({ kind: artifactKind }, {})
        if (result.ok !== true) {
          write({ error: errorOf(result, MESSAGES.artifactFailed) })
          return false
        }
        write({ error: '' })
        return true
      } catch (cause) {
        write({ error: `${MESSAGES.artifactFailed}：${describe(cause)}` })
        return false
      }
    },
  }

  reSelect = controller.selectNode
  return controller
}
