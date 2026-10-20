/**
 * Session-side helpers for the production valuation-workflow Host.
 *
 * The Host never lets a user action drive a business tool directly: a queued decision
 * is delivered to the exact recorded native parent Agent as one fixed, opaque
 * `crwu_valuation_workflow_run` prompt carrying only the Host-minted command id. If
 * that Agent is not resident, the recorded native session is reopened first through
 * the single workspace-session service and re-verified; no anonymous replacement is
 * ever created. Nothing here inspects a model payload, prompt or knowledge text.
 */
import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../../shared/utils/value.ts'
import {
  sessionHeader,
  verifySessionInWorkspace,
  workspaceSessionService,
} from '../../../core/workspace-session/index.ts'
import type { SelectedWorkspace, WorkspaceSessionState } from '../../../core/workspace-session/index.ts'

const CONTROL_TOOL_NAME = 'crwu_valuation_workflow_run'

/** One native Agent inbox: both queues must exist before idle can be claimed. */
export interface WorkflowAgentInboxLike {
  nextTurn?: readonly unknown[]
  nextStep?: readonly unknown[]
}

/** Minimal live Agent face; recovery reads native occupancy and claims maintenance. */
export interface WorkflowAgentLike {
  followup?: (message: unknown) => void
  status?: unknown
  inbox?: WorkflowAgentInboxLike | null
  runMaintenance?: (task: (signal: AbortSignal) => Promise<unknown>) => Promise<unknown>
}

/** The live Agent registered for one native session, or `undefined`. */
export function workflowAgentOf(ctx: Context, sessionId: string): WorkflowAgentLike | undefined {
  const id = text(sessionId)
  if (id === '') return undefined
  const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
  if (agents === undefined || typeof agents.get !== 'function') return undefined
  try {
    const agent = agents.get(id)
    return agent === undefined || agent === null ? undefined : agent as WorkflowAgentLike
  } catch {
    return undefined
  }
}

/** True only when the recorded parent can actually receive a followup. */
export function workflowParentResident(ctx: Context, sessionId: string): boolean {
  return typeof workflowAgentOf(ctx, sessionId)?.followup === 'function'
}

/** Structured result of one explicit parent maintenance claim. */
export interface WorkflowMaintenanceResult {
  ok: boolean
  error: string
}

/**
 * Claim one genuinely idle recorded parent for an atomic maintenance task.
 *
 * The call is refused before claiming unless the actual Agent is idle, both native
 * inbox queues are present and empty, and the real maintenance entry point exists.
 * `runMaintenance` itself is the only atomic idle proof: a missing entry point, a
 * throw or a missing outcome refuses without a "probably idle" fallback.
 */
export async function claimWorkflowParentMaintenance(input: {
  ctx: Context
  sessionId: string
  task: (signal: AbortSignal) => Promise<WorkflowMaintenanceResult>
}): Promise<WorkflowMaintenanceResult> {
  const sessionId = text(input.sessionId)
  if (sessionId === '') return { ok: false, error: '缺少父会话标识' }
  const agent = workflowAgentOf(input.ctx, sessionId)
  if (agent === undefined) return { ok: false, error: '父会话的 Agent 不在运行中：不能取得维护占用' }
  let status: unknown = undefined
  let nextTurn: unknown = undefined
  let nextStep: unknown = undefined
  let runMaintenance: WorkflowAgentLike['runMaintenance'] = undefined
  try {
    status = agent.status
    nextTurn = agent.inbox?.nextTurn
    nextStep = agent.inbox?.nextStep
    runMaintenance = agent.runMaintenance
  } catch {
    return { ok: false, error: '读不到父会话的运行时占用事实：不能确认空闲' }
  }
  if (text(status) !== 'idle') {
    return { ok: false, error: '父会话当前不处于空闲：不能取得维护占用' }
  }
  if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) {
    return { ok: false, error: '读不到父会话的待处理输入：不能确认空闲' }
  }
  if (nextTurn.length > 0 || nextStep.length > 0) {
    return { ok: false, error: '父会话仍有待处理输入：保持当前占用' }
  }
  if (typeof runMaintenance !== 'function') {
    return { ok: false, error: '这个部署的 Agent 不支持维护占用：不能确认空闲' }
  }
  let outcome: WorkflowMaintenanceResult = { ok: false, error: '父会话维护任务没有执行：状态保持不变' }
  try {
    await runMaintenance.call(agent, async (signal: AbortSignal) => {
      if (signal.aborted) {
        outcome = { ok: false, error: '父会话维护已取消：状态保持不变' }
        return outcome
      }
      outcome = await input.task(signal)
      // A cancellation that lands while the task runs still refuses the claim.
      if (signal.aborted) {
        outcome = { ok: false, error: '父会话维护已取消：状态保持不变' }
      }
      return outcome
    })
  } catch {
    return { ok: false, error: '父会话维护占用未能取得：状态保持不变' }
  }
  return outcome
}

/** The one fixed dispatch prompt; it carries no payload, reason, prompt or knowledge. */
export function opaqueCommandPrompt(commandId: string): string {
  return `请立即调用工具 ${CONTROL_TOOL_NAME}，commandId=${commandId}。不要调用其它工具。`
}

/**
 * Deliver one opaque command to the exact recorded parent Agent.
 *
 * A missing Agent is a retryable refusal, never a fallback to another session.
 */
export function dispatchOpaqueCommand(
  ctx: Context,
  sessionId: string,
  commandId: string,
): { accepted: boolean; error: string } {
  const agent = workflowAgentOf(ctx, sessionId)
  const followup = agent?.followup
  if (typeof followup !== 'function') {
    return { accepted: false, error: '估值父会话的 Agent 不在运行中：无法下发固定指令（状态已保留，可重试）' }
  }
  try {
    followup.call(agent, {
      id: `crwu-valuation-${commandId}`,
      role: 'user',
      content: [{ type: 'text', text: opaqueCommandPrompt(commandId) }],
      source: { kind: 'user' },
    })
    return { accepted: true, error: '' }
  } catch {
    return { accepted: false, error: '固定指令未能送达父会话' }
  }
}

/**
 * Make the exact recorded parent session drivable again.
 *
 * The actual native placement (root header, workspace cwd, workspace membership) is
 * always re-verified against the selected workspace before any dispatch — the mere
 * presence of a live Agent is never placement proof. Only after that is a resident
 * Agent used verbatim; otherwise the recorded native session is reopened through
 * `workspaceSessionService.createSession` and re-checked.
 */
export async function ensureWorkflowParent(input: {
  ctx: Context
  state: WorkspaceSessionState
  workspace: SelectedWorkspace
  parentSessionId: string
  title?: string
}): Promise<{ ok: boolean; error: string }> {
  const parentSessionId = text(input.parentSessionId)
  if (parentSessionId === '') return { ok: false, error: '缺少父会话标识' }

  const header = sessionHeader(input.ctx, parentSessionId)
  if (header === undefined) return { ok: false, error: '读不到记录的父估值会话：不能确认原生会话身份' }
  if (text(header.parentSession) !== '') return { ok: false, error: '记录的父会话不是顶层原生会话' }
  const placement = await verifySessionInWorkspace(input.ctx, input.workspace, parentSessionId)
  if (!placement.ok) return { ok: false, error: '记录的父会话不属于选定工作区' }

  if (workflowParentResident(input.ctx, parentSessionId)) return { ok: true, error: '' }

  const created = await workspaceSessionService(input.ctx, input.state).createSession({
    title: text(input.title) || '估值工作流',
    source: 'valuation',
    sessionId: parentSessionId,
  })
  if (!created.ok) return { ok: false, error: '无法重新打开记录的父估值会话' }
  if (!workflowParentResident(input.ctx, parentSessionId)) {
    return { ok: false, error: '父估值会话已重新打开，但 Agent 仍未进入运行：拒绝下发指令' }
  }
  return { ok: true, error: '' }
}
