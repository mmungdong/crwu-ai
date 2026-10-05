import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { basenameLocalPath } from '../../shared/utils/local-path.ts'
import { caseDirOf } from '../../shared/utils/case-dir.ts'
import { resolveTarget } from '../fs/paths.ts'
import { allowedCaseRootOf, requireCaseDir } from '../tools/case-dir.ts'
import { failure, type ToolFailure } from '../tools/outcome.ts'
import type { WorkbenchState } from '../state/types.ts'
import { callerIdentity, callerParentSessionId, isAuditChild, requireAuditScope } from './scope.ts'
import { requireMaterialScope, type DiscussionScopeRegistry } from './discussion-scope.ts'

type CaseAccess = {
  ok: true
  kind: 'audit' | 'discussion' | 'session'
  casePath: string
  allowedAttachmentIds?: readonly string[]
}

export async function requireCaseAccess(
  ctx: Context,
  state: WorkbenchState,
  discussions: DiscussionScopeRegistry,
  exec: ToolRunContext,
  args: { caseDir?: unknown; seqNo?: unknown; objectId?: unknown },
): Promise<CaseAccess | ToolFailure> {
  const { childId } = callerIdentity(exec)
  if (childId === '') return failure('policy', '无法确认调用者身份：案例操作需要会话上下文')

  const parentId = await callerParentSessionId(ctx, state, exec)
  // Managed children never fall back to ordinary session access after ending or during adoption.
  if (isAuditChild(state, childId, parentId)) {
    const checked = await requireAuditScope(ctx, state, exec, args)
    if (!checked.ok) return checked
    return { ok: true, kind: 'audit', casePath: checked.casePath, allowedAttachmentIds: checked.scope.allowedAttachmentIds }
  }
  const header = (exec.agent as { session?: { header?: unknown } } | undefined)?.session?.header
  const pending = Object.values(state.audits ?? {}).some((record) => record?.pending === true && record.childId === '')
  if (pending && parentId === '' && header === undefined) {
    return failure('policy', '审核子会话正在建立，尚无法确认调用者的会话范围：请稍后重试')
  }
  if (discussions.peek(childId) !== undefined) {
    const checked = await requireMaterialScope(ctx, state, discussions, exec, args)
    if (!checked.ok) return checked
    const scope = checked.material.scope
    return {
      ok: true, kind: checked.material.kind,
      casePath: checked.material.kind === 'audit' ? checked.material.scope.casePath : checked.material.scope.caseDir,
      allowedAttachmentIds: scope.allowedAttachmentIds,
    }
  }

  const root = allowedCaseRootOf(state)
  const checked = await requireCaseDir(ctx, args.caseDir, { allowedRoot: root })
  if (!checked.ok) return checked
  const seqNo = text(args.seqNo).trim() || basenameLocalPath(checked.path)
  if (seqNo === '.' || seqNo === '..' || /[\\/]/.test(seqNo)) {
    return failure('input', '流水号必须是单段案例目录名，不能包含路径分隔符')
  }
  const expectedPath = caseDirOf(root, seqNo)
  if (expectedPath === '') return failure('input', '流水号必须是有效的案例目录名')
  try {
    const given = await resolveTarget(ctx, checked.path)
    const expected = await resolveTarget(ctx, expectedPath)
    const workspace = await resolveTarget(ctx, root)
    if (text(given.targetKey) === '' || given.targetKey === workspace.targetKey || given.targetKey !== expected.targetKey) {
      return failure('policy', '案例目录必须是当前工作空间下的 `<工作空间>/<流水号>`，不能使用工作空间根或嵌套目录')
    }
  } catch (error) {
    return failure('infrastructure', `案例目录解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: true, kind: 'session', casePath: checked.path }
}
