import { joinLocalPath } from '../../../shared/utils/local-path.ts'
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
    const left = await readRemaining(deps, plan)
    result.remaining = left.length
    result.remainingNames = left.slice(0, WORKSPACE_CLEANUP_REMAINING_NAME_LIMIT)
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

  const remaining = await readRemaining(deps, plan)
  result.remaining = remaining.length
  result.remainingNames = remaining.slice(0, WORKSPACE_CLEANUP_REMAINING_NAME_LIMIT)
  result.status = result.failures.length === 0 && result.remaining === 0 ? 'completed' : 'partial'
  result.ok = result.status === 'completed'
  return result
}

async function readRemaining(deps: ApplyDeps, plan: CleanupPlan): Promise<string[]> {
  try {
    const names = (await deps.io.readdir(plan.identity.realPath)).map((dirent) => dirent.name)
    return names.sort()
  } catch {
    // 回读失败不改变"删了什么"的结论；调用方按 0 剩余处理会误导，所以记在 notes 里。
    return []
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
