/**
 * 工作空间清理（清空）的**线协议类型**。
 *
 * 一次清理拆成两次调用：`workspace-cleanup-plan` 只读扫描并产出一份带指纹的计划，
 * `workspace-cleanup-apply` 带 planId + 指纹 + 目录名执行。类型放共享层是因为
 * Host 产出的计划要**原样**给界面展示，界面提交的确认请求也要**原样**回到 Host ——
 * 各写一份的后果是"确认框列的项"和"Host 实际删的项"漂移，而那种漂移没有任何地方会报错。
 *
 * 这一层不做任何 I/O，也不 import Host / Client 专有模块。
 */

/** 明细回给界面的展示上限；Host 计划内部保留完整清单，删除以 Host 计划为准。 */
export const WORKSPACE_CLEANUP_ENTRY_LIMIT = 500

/** 失败归因。空串表示没有失败。 */
export type WorkspaceCleanupErrorKind =
  | '' | 'input' | 'policy' | 'capability-gap' | 'infrastructure' | 'conflict'

export type WorkspaceCleanupEntryKind = 'directory' | 'file' | 'symlink' | 'other'

export interface WorkspaceCleanupEntry {
  name: string
  kind: WorkspaceCleanupEntryKind
  /** 递归大小（目录）；符号链接与其它类型为 0。 */
  sizeBytes: number
}

export interface WorkspaceCleanupSession {
  sessionId: string
  title: string
  running: boolean
  agentAvailable: boolean
  /** 空串 = 顶层会话；非空 = 子代理。 */
  parentSessionId: string
  updatedAt: number
}

export interface WorkspaceCleanupTotals {
  folders: number
  files: number
  symlinks: number
  other: number
  bytes: number
  /** false = 递归大小超出扫描预算，`bytes` 只是已统计部分。 */
  bytesComplete: boolean
  sessions: number
  topLevelSessions: number
  subagentSessions: number
  runningSessions: number
}

export interface WorkspaceCleanupPlan {
  ok: boolean
  error: string
  errorKind: WorkspaceCleanupErrorKind
  planId: string
  digest: string
  expiresAt: number
  /** `name` = W 的末段目录名，也是确认框要求逐字输入的那一段。 */
  workspace: { path: string; name: string; id: string }
  /** **只用于界面展示**，最多 `WORKSPACE_CLEANUP_ENTRY_LIMIT` 项。 */
  entries: WorkspaceCleanupEntry[]
  /** 被截掉的项数（计数与指纹都覆盖完整清单）。 */
  entriesTruncated: number
  sessions: WorkspaceCleanupSession[]
  totals: WorkspaceCleanupTotals
  /** 必须展示给用户的限制说明（已归档会话不可枚举等）。 */
  notes: string[]
}

export interface WorkspaceCleanupRequest {
  planId: string
  digest: string
  /** 逐字等于 `workspace.name`（仅去掉首尾空白）。 */
  confirmName: string
  /** 缺省 false：只归档。 */
  deleteSessionLogs: boolean
}

export interface WorkspaceCleanupFailure {
  name: string
  kind: 'entry' | 'session-archive' | 'session-log' | 'workflow-store' | 'state'
  reason: string
}

export interface WorkspaceCleanupResult {
  ok: boolean
  status: 'completed' | 'partial' | 'aborted' | 'failed'
  error: string
  errorKind: WorkspaceCleanupErrorKind
  archivedSessionIds: string[]
  deletedSessionLogs: string[]
  skippedSessionLogs: { sessionId: string; reason: string }[]
  deleted: { folders: number; files: number; symlinks: number; other: number }
  failures: WorkspaceCleanupFailure[]
  /** 执行结束后 W 下剩余的直接子项数（正常应为 0）。 */
  remaining: number
  /** 剩余项名字，最多回 50 个；`remaining` 是完整计数。 */
  remainingNames: string[]
  /** 中止时未能停下的会话；此时未删除任何子项。 */
  stuckSessionIds: string[]
  notes: string[]
}
