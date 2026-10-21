import { joinLocalPath, trimTrailingSeparators } from '../../../shared/utils/local-path.ts'
import type {
  WorkspaceCleanupFailure, WorkspaceCleanupResult,
} from '../../../shared/contracts/workspace-cleanup.ts'
import { WORKSPACE_CLEANUP_REMAINING_NAME_LIMIT } from './consts.ts'
import { isDirectChild } from './guards.ts'
import { removeSessionLogs, stopAndArchive, type SessionRunDeps } from './session-run.ts'
import type { CleanupPlan } from './plan.ts'
import type { CleanupIo, CleanupSessionPort } from './types.ts'

/**
 * 执行清理。
 *
 * 前置校验（planId / 目录名 / 指纹 / 工作空间仍是同一个）由服务层负责；
 * 到这里时计划已经确认过，本函数只做「按顺序执行 + 如实回报」。
 *
 * 顺序：归档 → 关估值存储 →（可选）删会话日志 → 删子项 → 清插件状态 → 回读剩余。
 * 归档不成立就整体中止：让活会话的 cwd 被删掉，比什么都不做更危险。
 */
export interface ApplyDeps extends SessionRunDeps {
  io: CleanupIo
  port: CleanupSessionPort
  closeWorkflowStores(workspacePath: string): Promise<void>
  clearAudits(): void
  persistAudits(): Promise<boolean>
  /**
   * 授权复核。扫描与归档加起来可能有数十秒，授权在这段时间里被撤回必须能挡住删除：
   * 只在确认之前判一次，等于让撤回对不可逆动作无效。
   */
  reauthorize(): { ok: boolean; error: string }
}

export async function applyCleanup(
  deps: ApplyDeps,
  input: { plan: CleanupPlan; deleteSessionLogs: boolean },
): Promise<WorkspaceCleanupResult> {
  const { plan } = input
  const result = baseResult()
  const archive = await stopAndArchive(deps, plan.sessions)
  result.archivedSessionIds = archive.archivedSessionIds
  if (!archive.ok) {
    result.status = 'aborted'
    result.error = archive.reason
    result.errorKind = 'infrastructure'
    result.failures.push(...archive.failures)
    result.stuckSessionIds = archive.stuckSessionIds
    // 中止也要说真话：一条都没删，`remaining` 就是 W 现在的真实样子。
    recordReadback(result, await readRemaining(deps, plan))
    return result
  }

  // 归档是本轮最长的一段等待。授权在确认之后被撤回时，一条都不许删。
  const allowed = deps.reauthorize()
  if (!allowed.ok) {
    result.status = 'aborted'
    result.error = `本机访问授权已撤回，未删除任何内容：${allowed.error}`
    result.errorKind = 'policy'
    recordReadback(result, await readRemaining(deps, plan))
    return result
  }

  try {
    await deps.closeWorkflowStores(plan.identity.realPath)
  } catch (error) {
    result.failures.push({
      name: '.crwu', kind: 'workflow-store', reason: reasonOf(error),
    })
  }

  if (input.deleteSessionLogs) {
    const logs = await removeSessionLogs(deps, plan.sessions)
    result.deletedSessionLogs = logs.deletedSessionLogs
    result.skippedSessionLogs = logs.skippedSessionLogs
    result.failures.push(...logs.failures)
  }

  for (const entry of plan.entries) {
    // 确认到动手之间的空档里，祖先目录可能被改名并换成指向别处的软链：
    // 每次删除前重新核对真实路径，变了就整体停手，绝不跟着新路径删下去。
    const changed = await workspaceRealPathChanged(deps, plan)
    if (changed !== '') {
      result.failures.push({ name: entry.name, kind: 'entry', reason: changed })
      break
    }
    const path = joinLocalPath(plan.identity.realPath, entry.name)
    if (!isDirectChild(plan.identity.realPath, path)) {
      result.failures.push({ name: entry.name, kind: 'entry', reason: '不是工作空间的直接子项' })
      continue
    }
    let stats
    try {
      stats = await deps.io.lstat(path)
    } catch (error) {
      result.failures.push({ name: entry.name, kind: 'entry', reason: reasonOf(error) })
      continue
    }
    if (stats === undefined) {
      result.failures.push({ name: entry.name, kind: 'entry', reason: '扫描后已不存在' })
      continue
    }
    try {
      if (entry.kind === 'symlink') {
        await deps.io.unlink(path)
        result.deleted.symlinks += 1
      } else if (entry.kind === 'directory') {
        await deps.io.removeTree(path)
        result.deleted.folders += 1
      } else if (entry.kind === 'file') {
        await deps.io.removeTree(path)
        result.deleted.files += 1
      } else {
        result.failures.push({ name: entry.name, kind: 'entry', reason: '不认识的条目类型，未删除' })
      }
    } catch (error) {
      result.failures.push({ name: entry.name, kind: 'entry', reason: reasonOf(error) })
    }
  }

  // 审核历史与磁盘必须一起清：否则报告审核页会指向刚被删掉的空目录。
  deps.clearAudits()
  try {
    if (!await deps.persistAudits()) {
      result.failures.push({ name: '审核历史', kind: 'state', reason: '写盘失败，重启后可能恢复旧记录' })
    }
  } catch (error) {
    result.failures.push({ name: '审核历史', kind: 'state', reason: reasonOf(error) })
  }

  recordReadback(result, await readRemaining(deps, plan))
  result.status = result.failures.length === 0 && result.remaining === 0 ? 'completed' : 'partial'
  result.ok = result.status === 'completed'
  return result
}

async function readRemaining(deps: ApplyDeps, plan: CleanupPlan): Promise<{ names: string[]; error: string }> {
  try {
    const names = (await deps.io.readdir(plan.identity.realPath)).map((dirent) => dirent.name)
    return { names: names.sort(), error: '' }
  } catch (error) {
    // 回读失败不是"剩余为 0"：读不到就说不出来，绝不能据此宣布清空成功。
    return { names: [], error: reasonOf(error) }
  }
}

/**
 * 把回读结果写进结论。失败的**必须**登记成 failure —— 只有 `failures` 与 `remaining`
 * 一起为空才会被判定为 `completed`，所以"零剩余"不能由一次读失败伪造出来。
 */
function recordReadback(result: WorkspaceCleanupResult, left: { names: string[]; error: string }): void {
  result.remaining = left.names.length
  result.remainingNames = left.names.slice(0, WORKSPACE_CLEANUP_REMAINING_NAME_LIMIT)
  if (left.error === '') return
  result.failures.push({
    name: '剩余回读', kind: 'state', reason: `删除后无法回读工作空间：${left.error}`,
  })
  result.notes.push('剩余数量未知：回读失败，不能当作已清空')
}

/**
 * 工作空间的真实路径是否还是确认时的那一个。
 *
 * 只做 realpath：确认时已经用 realpath 建立了身份，执行时再取一次就是判据 ——
 * 祖先被换成软链时这里会指向别处，目录被改名移走时这里会抛 ENOENT，两种都停手。
 * 检查到 `unlink` 之间仍有极短的空档，Node 没有 `unlinkat`，做不到完全免疫；
 * 这里保证的是"换链之后一个都不再删"。
 */
async function workspaceRealPathChanged(deps: ApplyDeps, plan: CleanupPlan): Promise<string> {
  try {
    const real = trimTrailingSeparators(await deps.io.realpath(plan.identity.realPath))
    if (real === plan.identity.realPath) return ''
    return `工作空间真实路径已变为 ${real}：确认期间目录被替换，已停止删除`
  } catch (error) {
    return `无法复核工作空间真实路径，已停止删除：${reasonOf(error)}`
  }
}

function baseResult(): WorkspaceCleanupResult {
  return {
    ok: false,
    status: 'failed',
    error: '',
    errorKind: '',
    archivedSessionIds: [],
    deletedSessionLogs: [],
    skippedSessionLogs: [],
    deleted: { folders: 0, files: 0, symlinks: 0, other: 0 },
    failures: [] as WorkspaceCleanupFailure[],
    remaining: 0,
    remainingNames: [],
    stuckSessionIds: [],
    notes: [],
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
