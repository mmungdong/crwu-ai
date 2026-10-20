import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import type { WorkspaceCleanupFailure, WorkspaceCleanupSession } from '../../../shared/contracts/workspace-cleanup.ts'
import {
  WORKSPACE_CLEANUP_SESSION_POLL_MS,
  WORKSPACE_CLEANUP_SESSION_WAIT_MS,
} from './consts.ts'
import type { CleanupIo, CleanupSessionPort, CleanupSessionRow } from './types.ts'

/**
 * 会话的「先停再归档」与「删日志」。
 *
 * 两条硬规则：
 * 1. **归档是删文件的前提**：归档失败就中止，绝不继续删 cwd —— 否则会留下
 *    一条指向空目录的活会话，而侧栏里看不出它已经坏了；
 * 2. **静止要等出来，不能假设**：`stopActivity` 只表示"请求了停止"，
 *    真正的静止看 `running / agentAvailable`，超时即中止。
 */
export interface SessionRunDeps {
  port: CleanupSessionPort
  io: CleanupIo
  home: string
  now(): number
  sleep(ms: number): Promise<void>
  waitMs?: number
  pollMs?: number
}

export interface ArchiveOutcome {
  ok: boolean
  reason: string
  archivedSessionIds: string[]
  failures: WorkspaceCleanupFailure[]
  stuckSessionIds: string[]
}

export interface LogOutcome {
  deletedSessionLogs: string[]
  skippedSessionLogs: { sessionId: string; reason: string }[]
  failures: WorkspaceCleanupFailure[]
}

export async function stopAndArchive(
  deps: SessionRunDeps,
  sessions: readonly WorkspaceCleanupSession[],
): Promise<ArchiveOutcome> {
  const empty: ArchiveOutcome = {
    ok: false, reason: '', archivedSessionIds: [], failures: [], stuckSessionIds: [],
  }
  const planned = new Set(sessions.map((session) => session.sessionId))
  let rows: CleanupSessionRow[]
  try {
    rows = await deps.port.list()
  } catch (error) {
    return { ...empty, reason: `会话列表读取失败：${reasonOf(error)}` }
  }
  const byId = new Map(rows.map((row) => [row.sessionId, row]))
  const archivedSessionIds: string[] = []
  for (const session of sessions) {
    if (session.parentSessionId !== '') continue
    const live = byId.get(session.sessionId)
    // 扫描之后已经消失的会话不需要归档（也不该因为"归档接口找不到它"而中止整次清理）。
    if (live === undefined) continue
    const stopActivity = live.running || live.agentAvailable
    try {
      const archived = await deps.port.archive({ sessionId: session.sessionId, stopActivity })
      if (!archived.includes(session.sessionId)) {
        return {
          ...empty,
          reason: `会话 ${session.sessionId} 没有确认归档`,
          failures: [{
            name: session.sessionId,
            kind: 'session-archive',
            reason: '归档接口没有返回这个会话 id',
          }],
          stuckSessionIds: [session.sessionId],
        }
      }
      archivedSessionIds.push(session.sessionId)
    } catch (error) {
      return {
        ...empty,
        reason: `会话归档失败：${reasonOf(error)}`,
        failures: [{ name: session.sessionId, kind: 'session-archive', reason: reasonOf(error) }],
        stuckSessionIds: [session.sessionId],
      }
    }
  }

  const waitMs = deps.waitMs ?? WORKSPACE_CLEANUP_SESSION_WAIT_MS
  const pollMs = deps.pollMs ?? WORKSPACE_CLEANUP_SESSION_POLL_MS
  const deadline = deps.now() + waitMs
  // 轮询次数上限是**独立**兜底：`now()` 被注入成常量时，只看时间会永远等下去。
  const maxPolls = Math.max(1, Math.ceil(waitMs / Math.max(1, pollMs)) + 1)
  for (let poll = 0; poll <= maxPolls; poll += 1) {
    let current: CleanupSessionRow[]
    try {
      current = await deps.port.list()
    } catch (error) {
      return { ...empty, reason: `会话列表读取失败：${reasonOf(error)}`, archivedSessionIds }
    }
    const liveById = new Map(current.map((row) => [row.sessionId, row]))
    // 只等"有没有正在跑的活"。`agentAvailable` 表示会话仍 attached，归档并不会让它变 false ——
    // 把它当静止条件会让每次清理都在 30 秒后中止（现场：审核根 agent 空闲但仍 attached）。
    const stuck = [...planned].filter((id) => liveById.get(id)?.running === true)
    if (stuck.length === 0) {
      return { ok: true, reason: '', archivedSessionIds, failures: [], stuckSessionIds: [] }
    }
    if (deps.now() >= deadline || poll === maxPolls) {
      return {
        ...empty,
        reason: '会话没有在等待时间内停止',
        archivedSessionIds,
        stuckSessionIds: stuck,
      }
    }
    await deps.sleep(pollMs)
  }
  return {
    ok: false,
    reason: '会话没有在等待时间内停止',
    archivedSessionIds,
    failures: [],
    stuckSessionIds: [...planned],
  }
}

export async function removeSessionLogs(
  deps: SessionRunDeps,
  sessions: readonly WorkspaceCleanupSession[],
): Promise<LogOutcome> {
  const sessionsRoot = joinLocalPath(deps.home, '.dsh', 'sessions')
  const cacheDir = joinLocalPath(deps.home, '.dsh', 'storages', 'session_projcache', 'sessions')
  const deletedSessionLogs: string[] = []
  const skippedSessionLogs: { sessionId: string; reason: string }[] = []
  const failures: WorkspaceCleanupFailure[] = []

  let slugs: string[] = []
  try {
    slugs = (await deps.io.readdir(sessionsRoot))
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
  } catch {
    // 会话根不存在 = 这个部署没有日志可删；不是失败。
    slugs = []
  }

  for (const session of sessions) {
    if (session.sessionId === '') continue
    const matches: string[] = []
    for (const slug of slugs) {
      const path = joinLocalPath(sessionsRoot, slug, session.sessionId)
      let stats
      try {
        stats = await deps.io.lstat(path)
      } catch (error) {
        failures.push({ name: session.sessionId, kind: 'session-log', reason: reasonOf(error) })
        continue
      }
      if (stats !== undefined && stats.isDirectory()) matches.push(path)
    }
    if (matches.length === 0) {
      skippedSessionLogs.push({ sessionId: session.sessionId, reason: '日志已不存在' })
    } else if (matches.length > 1) {
      skippedSessionLogs.push({
        sessionId: session.sessionId,
        reason: '会话 id 命中多个目录，拒绝猜测',
      })
      // 这条会话的日志都不确定是哪一份，投影缓存也不该单独动。
      continue
    } else {
      try {
        await deps.io.removeTree(matches[0])
        deletedSessionLogs.push(session.sessionId)
      } catch (error) {
        failures.push({ name: session.sessionId, kind: 'session-log', reason: reasonOf(error) })
      }
    }

    const cache = joinLocalPath(cacheDir, `session-${session.sessionId}.json`)
    let cacheStats
    try {
      cacheStats = await deps.io.lstat(cache)
    } catch (error) {
      failures.push({ name: session.sessionId, kind: 'session-log', reason: reasonOf(error) })
      continue
    }
    if (cacheStats !== undefined) {
      try {
        await deps.io.unlink(cache)
      } catch (error) {
        failures.push({ name: session.sessionId, kind: 'session-log', reason: reasonOf(error) })
      }
    }
  }
  return { deletedSessionLogs, skippedSessionLogs, failures }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
