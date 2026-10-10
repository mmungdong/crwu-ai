import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { basenameLocalPath } from '../../shared/utils/local-path.ts'
import { caseDirOf } from '../../shared/utils/case-dir.ts'
import { resolveTarget, fileSystem } from '../fs/paths.ts'
import { allowedCaseRootOf, requireCaseDir } from '../tools/case-dir.ts'
import { failure, type ToolFailure } from '../tools/outcome.ts'
import type { LocalAuditScopeRegistry } from '../local-audit/scope.ts'
import type { WorkbenchState } from '../state/types.ts'
import { callerIdentity, callerParentSessionId, isAuditChild, requireAuditScope } from './scope.ts'
import { requireMaterialScope, type DiscussionScopeRegistry } from './discussion-scope.ts'

type CaseAccess = {
  ok: true
  kind: 'audit' | 'discussion' | 'local' | 'session'
  casePath: string
  allowedAttachmentIds?: readonly string[]
}

/**
 * 本地审核的产物**不上传、不回传**（协议 28）。
 *
 * 产品口径是「审核结果只存在于这次对话里」：对话的固定提示词里已经写了不许调用这三条工具，
 * 但提示词是**请求**，不是门禁。真正的边界在这里 —— OSS 发布与钉钉归档 / 通知三条交付工具
 * 在本地审核的案例 scope 下一律拒绝，理由明确指向产品口径，而不是让模型以为"配置坏了"。
 */
export function localDeliveryRefused(access: { kind: string }): ToolFailure | null {
  if (access.kind !== 'local') return null
  return failure('policy',
    '本地审核的产物只留在本机临时案例目录里：不上传 OSS、也不做钉钉归档与通知。'
    + '请把交付件留在案例目录并直接向我汇报，不要改道到任何远端。')
}

export async function requireCaseAccess(
  ctx: Context,
  state: WorkbenchState,
  discussions: DiscussionScopeRegistry,
  exec: ToolRunContext,
  args: { caseDir?: unknown; seqNo?: unknown; objectId?: unknown },
  /**
   * **本地审核的一次性案例 scope**（协议 28）。
   *
   * 本地审核的案例目录在操作系统临时目录下（不在员工选定的工作空间里），所以它**不可能**
   * 通过下面那条「`<工作空间>/<流水号>` 精确相等」的普通会话判据。它走自己的注册表：
   * `local-audit-claim` 成功时把案例目录绑到**那一条会话**上，这里只认「这条会话是谁」。
   *
   * 可选是为了不让只关心别的边界的测试夹具被迫造一个注册表；缺省 = 没有本地审核 scope。
   */
  localAudit?: LocalAuditScopeRegistry,
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
  // 本地审核会话：**身份判据是会话 id 逐字相等**（注册表由 claim 写入），
  // 并且模型提交的 `caseDir` 必须与那一份案例目录规范解析后精确相等。
  const local = localAudit?.scopeOf(childId)
  if (local !== undefined) {
    const caseDir = text(args.caseDir).trim()
    if (caseDir === '') return { ok: true, kind: 'local', casePath: local.casePath }
    const fs = fileSystem(ctx)
    if (fs === undefined) return failure('infrastructure', 'Host 文件服务不可用')
    try {
      const given = await resolveTarget(ctx, caseDir)
      const expected = await resolveTarget(ctx, local.casePath)
      if (text(given.targetKey) === '' || given.targetKey !== expected.targetKey) {
        return failure('policy', '案例目录必须是**本次本地审核自己的**临时快照目录')
      }
    } catch (error) {
      return failure('infrastructure', `案例目录解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: true, kind: 'local', casePath: local.casePath }
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
