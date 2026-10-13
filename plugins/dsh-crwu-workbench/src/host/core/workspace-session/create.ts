import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import { resolveSelectedWorkspace } from './resolve.ts'
import { attachSessionToWorkspace } from './attach.ts'
import { attachedSessionIds, verifySessionCwd, verifySessionInWorkspace } from './verify.ts'
import { workspaceFailure } from './errors.ts'
import type {
  CreateWorkspaceSessionInput,
  WorkspaceSessionResult,
  WorkspaceSessionState,
} from './types.ts'

/**
 * 在工作区里建一条会话 —— **插件里唯一合法的建会话路径**（协议 32）。
 *
 * 用 `ctx.sessionController.create({ workspaceId })`：DSH 自己就提供了这条"在工作区下开新会话"
 * 的正规入口（定位工作区 → `cwd = workspace.path` → 建/恢复 Agent → `attachSession`），
 * 而 `ensureSession` 出错时会先 `rejectCreation` 再抛，`attachSession` 出错时直接抛 ——
 * 也就是说它**本身就是 fail closed** 的，正是我们要的语义。
 *
 * ⚠️ 三条绝对不做的降级（历史上都写过）：
 *   - `cwd: ''`（真机上表现为 `failed to ensure project directory "": mkdir ''`）；
 *   - `cwd: 案例目录 / caseRoot`（会话挂不上工作区，只能落「未分组」）；
 *   - 什么都不传（DSH 会落到部署默认目录，产物写错地方）。
 */

/** 会话控制器的最小面（`@deepseek-ai/dsh-api-session-controller` 的 Host API）。 */
export interface SessionControllerLike {
  create?: (request: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  }) => Promise<{ sessionId?: unknown } | undefined>
  rename?: (request: { sessionId: string; title: string }) => Promise<unknown>
}

/** Agent 注册表的最小面。 */
export interface AgentLookupLike {
  get?: (id: string) => unknown
}

export interface CreateSessionDeps {
  ctx: Context
  state: WorkspaceSessionState
}

/**
 * 建一条落在**选定工作区**下的会话。
 *
 * 步骤（顺序不可换）：
 *   ① 解析并核对选定工作区（任一条不成立就停）；
 *   ② `sessionController.create({ workspaceId })` —— 不接受 `cwd`；
 *   ③ 显式 attach + 回读成员关系（DSH 那次 attach 失败在这里必然显形）；
 *   ④ 回读会话 cwd；
 *   ⑤ 改名（非致命，只记 note）。
 */
export async function createWorkspaceSession(
  deps: CreateSessionDeps,
  input: CreateWorkspaceSessionInput,
): Promise<WorkspaceSessionResult> {
  const { ctx, state } = deps
  const resolved = await resolveSelectedWorkspace(ctx, state)
  if (!resolved.ok) return resolved
  const { workspace } = resolved

  const controller = ctx.get('sessionController') as SessionControllerLike | undefined
  if (controller === undefined || typeof controller.create !== 'function') {
    return workspaceFailure(
      'services-unavailable',
      '这个部署没有装配 sessionController（会话业务 API）',
    )
  }

  const preset = text(input.presetHint)
  const requestedId = text(input.sessionId)
  let created: { sessionId?: unknown } | undefined
  try {
    created = await controller.create({
      workspaceId: workspace.id,
      ...(requestedId === '' ? {} : { sessionId: requestedId }),
      ...(preset === '' ? {} : { agentPreset: preset }),
    })
  } catch (error) {
    return workspaceFailure('session-create-failed', error instanceof Error ? error.message : String(error))
  }
  const sessionId = text(created?.sessionId) || requestedId
  if (sessionId === '') return workspaceFailure('session-create-failed', '会话服务没有返回会话 id')

  const notes: string[] = []

  // ③ 先看**落点**：会话 cwd 必须就是工作区路径。
  // 先查它而不是先挂载，是因为 cwd 不对时"挂载失败"只是后果 —— 真正要给用户看的是
  // "会话被建到了别的目录"。
  const placed = await verifySessionCwd(ctx, workspace, sessionId)
  if (!placed.ok) return workspaceFailure('session-cwd-mismatch', placed.reason)

  // ④ 挂载：只有成员关系**还不在**时才显式挂一次。
  // DSH 的 `create({ workspaceId })` 自己已经挂过了，所以多数情况下这里是空操作；
  // 但不主动重复调用 —— `attachSession` 每次都走一遍持久化变更队列，没必要。
  if (!attachedSessionIds(ctx, workspace.id).includes(sessionId)) {
    const attached = await attachSessionToWorkspace(ctx, workspace, sessionId)
    if (!attached.ok) return workspaceFailure('session-attach-failed', attached.reason)
  }

  // ⑤ 回读成员关系。不成立就不许继续往下走。
  const verified = await verifySessionInWorkspace(ctx, workspace, sessionId)
  if (!verified.ok) {
    const reason = /成员清单/.test(verified.reason) ? 'session-membership-missing' as const : 'session-cwd-mismatch' as const
    return workspaceFailure(reason, verified.reason)
  }

  // ⑥ 改名。失败不影响"会话已正确落位"，但要如实说出来。
  const title = text(input.title)
  if (title !== '') {
    if (typeof controller.rename !== 'function') {
      notes.push('这个部署没有会话改名能力：会话标题仍是默认值')
    } else {
      try {
        await controller.rename({ sessionId, title })
      } catch (error) {
        notes.push(`会话改名失败（不影响落点，只是标题不好认）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const agents = ctx.get('agents') as AgentLookupLike | undefined
  let agent: unknown
  if (agents !== undefined && typeof agents.get === 'function') {
    try {
      agent = agents.get(sessionId)
    } catch (error) {
      void error
      agent = undefined
    }
    if (agent === undefined) {
      return workspaceFailure('session-agent-missing', `会话 ${sessionId} 建好但 Agent 不在注册表里`)
    }
  }

  return { ok: true, sessionId, workspace, agent, notes }
}
