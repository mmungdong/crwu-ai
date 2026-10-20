import { isLocalPathUnder } from '../../../shared/utils/local-path.ts'
import type { WorkspaceCleanupSession } from '../../../shared/contracts/workspace-cleanup.ts'
import type {
  CleanupSessionRow, SessionTotals, WorkspaceIdentity,
} from './types.ts'

/**
 * 从会话列表里筛出**归属该工作空间**的那些。
 *
 * 判据是 `cwd` 落在 W 之内（含相等），这里只做纯计算：
 * 取数、分页与归档由 `session-port.ts` 负责，编排由 `index.ts` 负责。
 * `/w` 不能命中 `/w2`、Windows 大小写不敏感 —— 两条都由 `isLocalPathUnder` 统一。
 */
export function scanSessions(
  rows: readonly CleanupSessionRow[],
  workspace: WorkspaceIdentity,
): { sessions: WorkspaceCleanupSession[]; totals: SessionTotals } {
  const sessions: WorkspaceCleanupSession[] = []
  for (const row of rows) {
    // W 可能是符号链接：会话 cwd 记的是原路径或 realpath 都算归属。
    const under = row.cwd !== '' && (
      isLocalPathUnder(row.cwd, workspace.realPath)
      || (workspace.path !== workspace.realPath && isLocalPathUnder(row.cwd, workspace.path))
    )
    if (!under) continue
    sessions.push({
      sessionId: row.sessionId,
      title: row.title === '' ? row.sessionId.slice(0, 8) : row.title,
      running: row.running,
      agentAvailable: row.agentAvailable,
      parentSessionId: row.parentSessionId,
      updatedAt: row.updatedAt,
    })
  }
  sessions.sort((left, right) =>
    left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
  const totals: SessionTotals = {
    sessions: sessions.length,
    topLevelSessions: sessions.filter((session) => session.parentSessionId === '').length,
    subagentSessions: sessions.filter((session) => session.parentSessionId !== '').length,
    runningSessions: sessions.filter((session) => session.running).length,
  }
  return { sessions, totals }
}
