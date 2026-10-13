import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import { resolveSelectedWorkspace, pathKey } from './resolve.ts'
import { sessionHeader, verifySessionInWorkspace } from './verify.ts'
import type { SessionVerdict, WorkspaceSessionState } from './types.ts'
import type { AgentLookupLike } from './create.ts'

/**
 * 复用一条**旧会话**之前的重新验证（协议 32）。
 *
 * 为什么"记录里写着它是我的根"不算数：会话记录会跨进程重启活下来，而工作区选择、注册表、
 * Agent 生命周期都不会。任何一条变了，旧会话就不再是"同一个落点" —— 而复用一个落点不对的会话
 * 比新建一条危险得多（内容会写进用户以为早已换掉的那个目录）。
 *
 * 逐条核（顺序即诊断优先级）：
 *   ① 记录里的 `workspaceId` 必须还是**当前**选中的那个（换过工作区就不复用）；
 *   ② 记录里的 `workspacePath` 必须与解析出来的工作区路径同一个目录；
 *   ③ Agent 仍在注册表里（进程重启后必然不在）；
 *   ④ 会话头 cwd = 工作区路径，且成员关系在位；
 *   ⑤ 会话本身不是子代理（根必须是顶层会话）。
 *
 * 沙箱/审批策略不在这里 —— 那是 `audit/policy.ts` 的判据，由调用方接着问一次。
 */

/** 一条被记录下来的会话落点。 */
export interface SessionPlacement {
  workspaceId: string
  workspacePath: string
  sessionId: string
}

export async function verifyReusableSession(
  ctx: Context,
  state: WorkspaceSessionState,
  placement: SessionPlacement,
): Promise<SessionVerdict> {
  const resolved = await resolveSelectedWorkspace(ctx, state)
  if (!resolved.ok) return { ok: false, reason: resolved.error }
  const { workspace } = resolved

  const recordedId = text(placement.workspaceId)
  if (recordedId !== '' && recordedId !== workspace.id) {
    return { ok: false, reason: `记录属于另一个工作区（记录 ${recordedId}，当前 ${workspace.id}）` }
  }

  const recordedPath = text(placement.workspacePath)
  if (recordedPath !== '') {
    const [left, right] = await Promise.all([pathKey(ctx, recordedPath), pathKey(ctx, workspace.path)])
    if (left === '' || left !== right) {
      return { ok: false, reason: `记录的工作区路径（${recordedPath}）与当前选定工作区不一致` }
    }
  }

  const sessionId = text(placement.sessionId)
  if (sessionId === '') return { ok: false, reason: '记录里没有会话 id' }

  const agents = ctx.get('agents') as AgentLookupLike | undefined
  if (agents !== undefined && typeof agents.get === 'function') {
    let agent: unknown
    try {
      agent = agents.get(sessionId)
    } catch (error) {
      void error
      agent = undefined
    }
    if (agent === undefined) return { ok: false, reason: '会话已不在运行中（进程重启或被释放）' }
  }

  const header = sessionHeader(ctx, sessionId)
  if (header !== undefined && text(header.origin) === 'subagent') {
    return { ok: false, reason: '这条会话本身是子代理，不能当作根' }
  }

  return await verifySessionInWorkspace(ctx, workspace, sessionId)
}
