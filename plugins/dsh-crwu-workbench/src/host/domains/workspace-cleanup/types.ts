import type { WorkspaceCleanupEntry } from '../../../shared/contracts/workspace-cleanup.ts'

/**
 * 清理工作空间的**内部类型**（不进线协议）。
 *
 * `WorkspaceIdentity` 与 `WorkspaceCleanupPlan.workspace` 刻意分开：线上只需要展示路径、
 * 目录名与 id，而删除必须用 `realPath`。把 `realPath` 放进线协议就等于把"删哪个目录"
 * 变成客户端可以观察甚至回传的字段 —— 它只该留在 Host 里。
 */
export interface WorkspaceIdentity {
  /** DSH 工作区 id（跨重启稳定）。 */
  id: string
  /** 员工看到的路径（原样，可能是符号链接）。 */
  path: string
  /** 规范路径（realpath）；执行阶段只对它的直接子项动手。 */
  realPath: string
  /** 末段目录名（确认框要求逐字输入的那一段）。 */
  name: string
}

/** 扫描到的顶层项：线上的展示字段 + 只给指纹用的 `mtimeMs`。 */
export interface ScannedEntry extends WorkspaceCleanupEntry {
  mtimeMs: number
}

/** 一次 `readdir` 的条目（只需类型判定，不搬 Node 的 `Dirent`）。 */
export interface CleanupDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface CleanupStats {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
  size: number
  mtimeMs: number
}

/**
 * 清空工作空间用到的**全部文件系统动词**。
 *
 * 可注入是刻意的：删除是不可逆动作，单测必须在内存里跑（见
 * `tests/helpers/workspace-cleanup-fixture.mjs`）。生产实现只有 `io.ts` 一处 import `node:fs/promises`。
 */
export interface CleanupIo {
  readdir(path: string): Promise<CleanupDirent[]>
  lstat(path: string): Promise<CleanupStats | undefined>
  stat(path: string): Promise<CleanupStats | undefined>
  realpath(path: string): Promise<string>
  removeTree(path: string): Promise<void>
  unlink(path: string): Promise<void>
}

/** 顶层项的统计（不含会话）。 */
export interface EntryTotals {
  folders: number
  files: number
  symlinks: number
  other: number
  bytes: number
  bytesComplete: boolean
}

/** 会话控制器返回的一行（已归一化，不搬 DSH 的原始形状）。 */
export interface CleanupSessionRow {
  sessionId: string
  cwd: string
  running: boolean
  agentAvailable: boolean
  parentSessionId: string
  updatedAt: number
  title: string
}

/** 会话侧的两个动词：枚举与归档。缺任一都不能安全清理。 */
export interface CleanupSessionPort {
  list(): Promise<CleanupSessionRow[]>
  archive(input: { sessionId: string; stopActivity: boolean }): Promise<string[]>
}

/** 归属会话的统计。 */
export interface SessionTotals {
  sessions: number
  topLevelSessions: number
  subagentSessions: number
  runningSessions: number
}
