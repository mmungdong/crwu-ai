import type { Context } from '@deepseek-ai/cordis'
import { resolveSelectedWorkspace } from './resolve.ts'
import { attachSessionToWorkspace } from './attach.ts'
import { verifySessionInWorkspace } from './verify.ts'
import { createWorkspaceSession } from './create.ts'
import { verifyReusableSession, type SessionPlacement } from './reuse.ts'
import type {
  CreateWorkspaceSessionInput,
  SelectedWorkspace,
  SessionVerdict,
  WorkspaceResolution,
  WorkspaceSessionResult,
  WorkspaceSessionState,
} from './types.ts'

export * from './types.ts'
export { workspaceFailure, workspaceFailureReasonText } from './errors.ts'
export { resolveSelectedWorkspace, pathKey, registryEntity, workspaceRegistry } from './resolve.ts'
export { attachSessionToWorkspace } from './attach.ts'
export { sessionHeader, attachedSessionIds, verifySessionCwd, verifySessionInWorkspace } from './verify.ts'
export { createWorkspaceSession } from './create.ts'
export type { CreateSessionDeps, SessionControllerLike, AgentLookupLike } from './create.ts'
export { verifyReusableSession } from './reuse.ts'
export type { SessionPlacement } from './reuse.ts'

/**
 * 工作区会话服务（协议 32）。
 *
 * 把所有"会话该落在哪儿"的问题收成一个对象交给调用方：审核根、审核子会话、报告讨论、
 * 本地审核、估值都从这里走，于是**不存在第二条口径**。服务本身不持有状态 ——
 * 状态是 `WorkbenchState`，每次调用现读，避免工作区切换后拿到上一次解析的缓存。
 */
export interface WorkspaceSessionService {
  /** 解析并核对当前选中的工作区；不成立时给出指名道姓的失败。 */
  requireSelectedWorkspace(): Promise<WorkspaceResolution>

  /** 在选中工作区里建一条会话，并回读确认归属。 */
  createSession(input: CreateWorkspaceSessionInput): Promise<WorkspaceSessionResult>

  /** 回读一条会话是否真的属于给定工作区。 */
  verifySession(input: { sessionId: string; workspace: SelectedWorkspace }): Promise<SessionVerdict>

  /** 把一条已存在的会话挂到工作区下并回读。 */
  attachSession(input: { sessionId: string; workspace: SelectedWorkspace }): Promise<SessionVerdict>

  /** 复用旧会话之前的重新验证（工作区一致性 + Agent 存活 + 归属）。 */
  verifyPlacement(placement: SessionPlacement): Promise<SessionVerdict>
}

export function workspaceSessionService(ctx: Context, state: WorkspaceSessionState): WorkspaceSessionService {
  return {
    requireSelectedWorkspace: () => resolveSelectedWorkspace(ctx, state),
    createSession: (input) => createWorkspaceSession({ ctx, state }, input),
    verifySession: ({ sessionId, workspace }) => verifySessionInWorkspace(ctx, workspace, sessionId),
    attachSession: ({ sessionId, workspace }) => attachSessionToWorkspace(ctx, workspace, sessionId),
    verifyPlacement: (placement) => verifyReusableSession(ctx, state, placement),
  }
}
