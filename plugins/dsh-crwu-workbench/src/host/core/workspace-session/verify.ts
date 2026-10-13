import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import { pathKey, registryEntity } from './resolve.ts'
import type { SelectedWorkspace, SessionVerdict } from './types.ts'

/**
 * 会话归属的**回读判据**。
 *
 * 为什么必须回读，而不是相信 `create()` 的返回值：DSH 把"会话属于哪个工作区"记在
 * 工作区记录的 `sessionIds` 里（`Workspace.attachSession`），而侧栏「未分组」的判据正是
 * `workspace.sessionIds.includes(id)` —— 建会话成功、挂载失败时 `create()` 可能已经返回了 id，
 * 用户看到的却是会话跑到「未分组」下面。所以**只有回读到成员关系才算数**。
 *
 * 两条都查：
 *   1. 会话头的 `cwd` 逐字（规范键）等于工作区路径 —— 这是 `attachSession` 自己的前置条件；
 *   2. 工作区记录的 `sessionIds` 里真的有这个 id —— 这是侧栏分组的唯一凭据。
 */

/** 会话服务的最小面。 */
export interface SessionStoreLike {
  get?: (id: string) => { header?: Record<string, unknown> } | undefined
}

/** 工作区实体在回读时要用的面。 */
export interface AttachedWorkspaceLike extends SelectedWorkspace {
  sessionIds?: readonly string[]
}

/** 取会话头；会话不存在或服务缺失都返回 `undefined`。 */
export function sessionHeader(ctx: Context, sessionId: string): Record<string, unknown> | undefined {
  const sessions = ctx.get('sessions') as SessionStoreLike | undefined
  if (sessionId === '' || typeof sessions?.get !== 'function') return undefined
  try {
    return sessions.get(sessionId)?.header
  } catch (error) {
    void error
    return undefined
  }
}

/** 工作区记录当前认领的会话 id（服务/记录缺失时为空数组）。 */
export function attachedSessionIds(ctx: Context, workspaceId: string): readonly string[] {
  const entity = registryEntity(ctx, workspaceId) as AttachedWorkspaceLike | undefined
  const ids = entity?.sessionIds
  return Array.isArray(ids) ? ids : []
}

/**
 * 会话的 cwd 是否就落在工作区路径上。
 *
 * 单独提出来是因为**诊断顺序**有意义：cwd 不对时，"挂载失败"只是它的后果，
 * 真正的原因（会话被建到了别的目录）才是给用户/维护者看的那一句。
 */
export async function verifySessionCwd(
  ctx: Context,
  workspace: SelectedWorkspace,
  sessionId: string,
): Promise<SessionVerdict> {
  const id = text(sessionId)
  if (id === '') return { ok: false, reason: '会话 id 为空' }
  const header = sessionHeader(ctx, id)
  if (header === undefined) return { ok: false, reason: '读不到会话头（会话不存在或会话服务不可用）' }
  const cwd = text(header.cwd)
  if (cwd === '') return { ok: false, reason: '会话头没有 cwd' }
  const [left, right] = await Promise.all([pathKey(ctx, cwd), pathKey(ctx, workspace.path)])
  if (left === '' || left !== right) {
    return { ok: false, reason: `会话 cwd（${cwd}）不是选定工作区（${workspace.path}）` }
  }
  return { ok: true, reason: '' }
}

/**
 * 回读一个会话是否真的属于这个工作区。
 *
 * 失败一律给**可区分**的原因（调用方据此决定是"重建"还是"报错让人修"）。
 */
export async function verifySessionInWorkspace(
  ctx: Context,
  workspace: SelectedWorkspace,
  sessionId: string,
): Promise<SessionVerdict> {
  const id = text(sessionId)
  if (id === '') return { ok: false, reason: '会话 id 为空' }

  const placed = await verifySessionCwd(ctx, workspace, id)
  if (!placed.ok) return placed

  if (!attachedSessionIds(ctx, workspace.id).includes(id)) {
    return { ok: false, reason: `会话不在工作区（${workspace.title || workspace.path}）的成员清单里` }
  }
  return { ok: true, reason: '' }
}
