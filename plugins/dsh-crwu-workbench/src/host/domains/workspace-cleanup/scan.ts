import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { classifyEntry } from './guards.ts'
import { WORKSPACE_CLEANUP_SIZE_ENTRY_BUDGET } from './consts.ts'
import type { CleanupIo, EntryTotals, ScannedEntry, WorkspaceIdentity } from './types.ts'

/**
 * 扫描工作空间根下的**直接子项**。
 *
 * 只列一层，是因为确认框承诺的就是"删掉这些顶层项"；目录里的内容由删除动作整体带走，
 * 不参与逐项核对。目录大小递归统计只是为了让人对"要删多少"有量感，超出预算就如实标
 * `bytesComplete=false`，不假装数完。
 */
export async function scanEntries(
  io: CleanupIo,
  workspace: WorkspaceIdentity,
): Promise<{ entries: ScannedEntry[]; totals: EntryTotals }> {
  const dirents = await io.readdir(workspace.realPath)
  const budget = { left: WORKSPACE_CLEANUP_SIZE_ENTRY_BUDGET, complete: true }
  const totals: EntryTotals = {
    folders: 0, files: 0, symlinks: 0, other: 0, bytes: 0, bytesComplete: true,
  }
  const entries: ScannedEntry[] = []
  for (const dirent of dirents) {
    const path = joinLocalPath(workspace.realPath, dirent.name)
    const stats = await io.lstat(path)
    if (stats === undefined) continue
    const kind = classifyEntry(dirent.name, stats)
    let sizeBytes = 0
    if (kind === 'directory') {
      totals.folders += 1
      sizeBytes = await measureDirectory(io, path, budget)
    } else if (kind === 'file') {
      totals.files += 1
      sizeBytes = Math.max(0, stats.size)
    } else if (kind === 'symlink') {
      totals.symlinks += 1
    } else {
      totals.other += 1
    }
    totals.bytes += sizeBytes
    entries.push({ name: dirent.name, kind, sizeBytes, mtimeMs: stats.mtimeMs })
  }
  totals.bytesComplete = budget.complete
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  return { entries, totals }
}

/** 递归累加目录大小；预算耗尽时停下并把 `complete` 置 false。 */
async function measureDirectory(
  io: CleanupIo,
  path: string,
  budget: { left: number; complete: boolean },
): Promise<number> {
  if (budget.left <= 0) {
    budget.complete = false
    return 0
  }
  let bytes = 0
  const dirents = await io.readdir(path)
  for (const dirent of dirents) {
    if (budget.left <= 0) {
      budget.complete = false
      return bytes
    }
    budget.left -= 1
    const child = joinLocalPath(path, dirent.name)
    const stats = await io.lstat(child)
    if (stats === undefined) continue
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      bytes += await measureDirectory(io, child, budget)
    } else if (stats.isFile()) {
      bytes += Math.max(0, stats.size)
    }
  }
  return bytes
}
