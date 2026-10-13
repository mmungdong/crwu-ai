import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import { registryEntity } from './resolve.ts'
import { attachedSessionIds } from './verify.ts'
import type { SelectedWorkspace, SessionVerdict } from './types.ts'

/**
 * 把一条已经建好的会话挂到工作区下，并**回读**确认。
 *
 * 为什么单独一层：`attachSession` 在两种常见情况下会抛 —— 会话 cwd 与工作区路径不逐字相等，
 * 或者会话头还没落盘。历史实现（审核根）把抛出来的错误收成一句 notes 就继续跑了，结果是
 * "审核跑起来了，但会话在侧栏「未分组」下面"（用户 2026-09-30 报的故障）。
 * 这里把 attach + 回读打包成一个**不能忽略**的结论。
 */

/** 工作区实体在 attach 时要用的面。 */
interface AttachableWorkspaceLike {
  attachSession?: (sessionId: string) => Promise<void> | void
}

export async function attachSessionToWorkspace(
  ctx: Context,
  workspace: SelectedWorkspace,
  sessionId: string,
): Promise<SessionVerdict> {
  const id = text(sessionId)
  if (id === '') return { ok: false, reason: '会话 id 为空' }
  const entity = registryEntity(ctx, workspace.id)
  if (entity === undefined) return { ok: false, reason: `工作区注册表里没有 ${workspace.id}` }
  const attach = (entity as AttachableWorkspaceLike).attachSession
  if (typeof attach !== 'function') {
    return { ok: false, reason: '这个部署的工作区记录没有 attachSession：无法建立成员关系' }
  }
  try {
    await attach.call(entity, id)
  } catch (error) {
    return {
      ok: false,
      reason: `挂载失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // 回读：`attachSession` 正常返回**不等于**成员关系已经在读侧可见（记录有过滤索引）。
  if (!attachedSessionIds(ctx, workspace.id).includes(id)) {
    return { ok: false, reason: '挂载之后回读不到成员关系' }
  }
  return { ok: true, reason: '' }
}
