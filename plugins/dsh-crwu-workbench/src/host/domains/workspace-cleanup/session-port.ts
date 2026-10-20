import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import type { CleanupSessionPort, CleanupSessionRow } from './types.ts'

/**
 * 把 DSH 的两个控制器适配成清理用的会话端口。
 *
 * `sessionController.list()` 负责枚举，`workspaceController.archiveSession()` 负责归档；
 * 两个服务缺任何一个都**不能继续** —— 没有归档就删文件，会让会话指向一个不存在的目录。
 *
 * 分页放在这里而不是扫描层：扫描只看"归属哪些会话"，不该关心宿主的分页细节。
 * 总条数有上限（默认 5,000）：一次清理不值得把几万条会话拉进内存，超限按能力缺口报。
 */
const DEFAULT_PAGE_LIMIT = 5_000

export type SessionPortOutcome =
  | { ok: true; port: CleanupSessionPort }
  | { ok: false; error: string }

interface SessionListResult {
  items?: unknown
  cursor?: unknown
}

interface SessionControllerLike {
  list?: (request: { cursor?: string }) => Promise<SessionListResult | undefined>
}

interface WorkspaceControllerLike {
  archiveSession?: (request: {
    sessionId: string; stopActivity?: boolean
  }) => Promise<{ archivedSessionIds?: unknown } | undefined>
}

export function cleanupSessionPort(
  ctx: Pick<Context, 'get'>,
  options: { pageLimit?: number } = {},
): SessionPortOutcome {
  const sessions = ctx.get('sessionController') as SessionControllerLike | undefined
  const workspaces = ctx.get('workspaceController') as WorkspaceControllerLike | undefined
  const listSessions = sessions?.list
  if (sessions === undefined || typeof listSessions !== 'function') {
    return { ok: false, error: '这个宿主没有会话列表能力，无法安全清理工作空间里的会话' }
  }
  if (workspaces === undefined || typeof workspaces.archiveSession !== 'function') {
    return { ok: false, error: '这个宿主没有会话归档能力，无法在删除目录前处理会话' }
  }
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT
  const workspaceController = workspaces
  return {
    ok: true,
    port: {
      async list(): Promise<CleanupSessionRow[]> {
        const rows: CleanupSessionRow[] = []
        let cursor: string | undefined
        const seen = new Set<string>()
        for (;;) {
          const page = await listSessions.call(sessions, cursor === undefined ? {} : { cursor })
          const items = Array.isArray(page?.items) ? page?.items : []
          for (const item of items) {
            rows.push(normalizeRow(item))
            if (rows.length > pageLimit) {
              throw new Error(`会话数量超过 ${String(pageLimit)} 条，无法一次安全清理`)
            }
          }
          const next = text(page?.cursor)
          if (next === '' || seen.has(next)) break
          seen.add(next)
          cursor = next
        }
        return rows
      },
      async archive(input): Promise<string[]> {
        const result = await workspaceController.archiveSession?.({
          sessionId: input.sessionId,
          stopActivity: input.stopActivity,
        })
        const ids = result?.archivedSessionIds
        return Array.isArray(ids) ? ids.map((id) => text(id)).filter((id) => id !== '') : []
      },
    },
  }
}

function normalizeRow(item: unknown): CleanupSessionRow {
  const raw = (item ?? {}) as Record<string, unknown>
  const projections = (raw.projections ?? {}) as Record<string, unknown>
  const values = (projections.values ?? {}) as Record<string, unknown>
  const updatedAt = Number(raw.updatedAt)
  const sessionId = text(raw.sessionId)
  return {
    sessionId,
    cwd: text(raw.cwd),
    running: raw.running === true,
    agentAvailable: raw.agentAvailable === true,
    parentSessionId: text(raw.parentSessionId),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    title: text(values.title) || sessionId.slice(0, 8),
  }
}
