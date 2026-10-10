import { mkdir, copyFile, rm, writeFile, readFile } from 'node:fs/promises'
import { joinLocalPath, trimTrailingSeparators } from '../../shared/utils/local-path.ts'
import { canonicalJson, digestOf } from '../tools/snapshot.ts'
import {
  LOCAL_AUDIT_MANIFEST_FILE,
  LOCAL_AUDIT_META_FILE,
  LOCAL_AUDIT_CASE_PARENT_DIR,
  LOCAL_AUDIT_SOURCE_DIR,
} from './consts.ts'
import type { LocalAuditCandidate, LocalAuditSkipped } from './scan.ts'

/**
 * 本地审核的**输入快照**：把用户选中的普通文件复制进一个临时案例目录。
 *
 * ## 为什么必须复制（而不是让对话直接读原路径）
 *
 * 1. **原始文件在审核期间被删除/移动不会让首次对话崩溃** —— 快照是唯一来源；
 * 2. **可复制的提示词里不出现用户的绝对路径**（设计 §8 的硬要求）；
 * 3. 对话的沙箱边界就是快照目录，写交付件不需要任何提权。
 *
 * ## 目录形状（与报告审核的案例目录同构，便于复用技能与脚本）
 *
 * ```
 * <已选工作空间>/本地审核/<handoffId>/
 *   材料-源/<用户所选入口的相对路径…>
 *   本地审核清单.json
 *   快照元数据.json
 * ```
 *
 * 逐件复制失败**不中断整批**（记进 `skipped`，原因如实写"快照读取失败"）；
 * 全部失败才算 `ok:false` —— 那时界面必须禁用开始按钮。
 */

/** 快照需要的文件操作（可注入：单测用内存替身，绝不写真实磁盘）。 */
export interface SnapshotIo {
  makeDir(path: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  writeText(path: string, content: string): Promise<void>
  readText(path: string): Promise<string>
  removeTree(path: string): Promise<void>
}

/** 生产实现：`node:fs/promises`。 */
export function nodeSnapshotIo(): SnapshotIo {
  return {
    async makeDir(path) { await mkdir(path, { recursive: true }) },
    async copyFile(from, to) { await copyFile(from, to) },
    async writeText(path, content) { await writeFile(path, content, 'utf8') },
    async readText(path) { return await readFile(path, 'utf8') },
    async removeTree(path) { await rm(path, { recursive: true, force: true }) },
  }
}

/**
 * 本地审核案例目录的父目录（在员工选定的工作空间下；空工作空间 = 不能开始本地审核）。
 *
 * 「工作空间」由 Host 从状态里取（`state.workspacePath`），不由调用方提交 ——
 * 与报告审核的案例目录同一条口径。
 */
export function localAuditRootDir(workspacePath: string): string {
  const root = trimTrailingSeparators(workspacePath)
  return root === '' ? '' : joinLocalPath(root, LOCAL_AUDIT_CASE_PARENT_DIR)
}

/** 一次 handoff 的案例目录（`<工作空间>/本地审核/<handoffId>`）。 */
export function localAuditCaseDir(workspacePath: string, handoffId: string): string {
  const root = localAuditRootDir(workspacePath)
  return root === '' ? '' : joinLocalPath(root, handoffId)
}

export interface SnapshotFile {
  /** 案例目录内的相对路径（`材料-源/…`，固定 `/` 分隔）。 */
  relativePath: string
  name: string
  sizeBytes: number
}

export interface SnapshotOutcome {
  ok: boolean
  error: string
  errorKind: 'input' | 'infrastructure' | 'no-readable-files' | ''
  casePath: string
  files: SnapshotFile[]
  skipped: LocalAuditSkipped[]
  digest: string
}

/**
 * 建立快照。
 *
 * `handoffId` 由调用方（Host）生成 —— 它同时也是案例目录名，所以必须是安全的单段标识。
 */
export async function prepareSnapshot(
  handoffId: string,
  candidates: readonly LocalAuditCandidate[],
  io: SnapshotIo,
  /**
   * `casePath` 由**调用方**（Host 的 `local-audit-start`）按员工选定的工作空间算出来。
   * 这里不再自己拼路径：案例目录的落点只能有一处判据（与报告审核的 `caseDirOf` 同一条口径）。
   */
  options: { casePath: string, now?: () => string },
): Promise<SnapshotOutcome> {
  const casePath = options.casePath
  const empty: SnapshotOutcome = {
    ok: false, error: '', errorKind: '', casePath, files: [], skipped: [], digest: '',
  }
  if (casePath === '') {
    return { ...empty, errorKind: 'input', error: '还没有选定工作空间：请先在「环境信息」里选择工作空间' }
  }
  if (candidates.length === 0) {
    return { ...empty, errorKind: 'no-readable-files', error: '没有可审核的文件' }
  }
  const files: SnapshotFile[] = []
  const skipped: LocalAuditSkipped[] = []
  try {
    await io.makeDir(casePath)
  } catch (error) {
    return {
      ...empty,
      errorKind: 'infrastructure',
      error: `无法创建本地审核临时目录：${reasonOf(error)}`,
    }
  }
  for (const candidate of candidates) {
    // 相对路径是按 `/` 拼的展示路径；`joinLocalPath` 按案例目录风格重拼，并拒绝绝对片段与 `..`。
    const parts = candidate.relativePath.split('/').filter((part) => part !== '')
    const target = joinLocalPath(casePath, LOCAL_AUDIT_SOURCE_DIR, ...parts)
    const targetDir = joinLocalPath(casePath, LOCAL_AUDIT_SOURCE_DIR, ...parts.slice(0, -1))
    try {
      await io.makeDir(targetDir)
      await io.copyFile(candidate.sourcePath, target)
      files.push({
        relativePath: `${LOCAL_AUDIT_SOURCE_DIR}/${candidate.relativePath}`,
        name: candidate.name,
        sizeBytes: candidate.sizeBytes,
      })
    } catch (error) {
      void error
      skipped.push({ relativePath: candidate.relativePath, name: candidate.name, reason: '快照读取失败' })
    }
  }
  if (files.length === 0) {
    // 一件都没复制成功：清掉半截目录，如实报"没有可审核的文件"。
    await io.removeTree(casePath).catch(() => undefined)
    return {
      ...empty,
      errorKind: 'no-readable-files',
      error: '没有可审核的文件：请检查文件是否存在、是否被其他程序锁定，或重新选择文件',
      skipped,
    }
  }
  const createdAt = (options.now ?? (() => new Date().toISOString()))()
  const digest = digestOf([handoffId, createdAt, ...files.map((item) => canonicalJson(item))])
  const manifest = {
    schema: 'crwu.local-audit-manifest.v1',
    handoffId,
    createdAt,
    mode: 'local',
    fileCount: files.length,
    skippedCount: skipped.length,
    files: files.map((item) => ({ name: item.name, relativePath: item.relativePath, sizeBytes: item.sizeBytes })),
    skipped: skipped.map((item) => ({ name: item.name, relativePath: item.relativePath, reason: item.reason })),
  }
  const meta = {
    schema: 'crwu.local-audit-snapshot.v1',
    handoffId,
    createdAt,
    mode: 'local',
    fileCount: files.length,
    skippedCount: skipped.length,
    digest,
  }
  try {
    await io.writeText(joinLocalPath(casePath, LOCAL_AUDIT_MANIFEST_FILE), `${canonicalJson(manifest)}\n`)
    await io.writeText(joinLocalPath(casePath, LOCAL_AUDIT_META_FILE), `${canonicalJson(meta)}\n`)
  } catch (error) {
    await io.removeTree(casePath).catch(() => undefined)
    return {
      ...empty,
      errorKind: 'infrastructure',
      error: `写入本地审核清单失败：${reasonOf(error)}`,
    }
  }
  return { ok: true, error: '', errorKind: '', casePath, files, skipped, digest }
}

/**
 * 读回清单（claim 时核对快照还在、内容与 handoff 记录一致）。
 *
 * ⚠️ 路径由**调用方给**（handoff 记录里的 `casePath`），不要在这里重新按 id 拼一次：
 * 一旦两处拼法漂移，"清单读不到"就会变成一次莫名其妙的 capability gap。
 */
export async function readManifest(
  io: SnapshotIo,
  casePath: string,
  handoffId: string,
): Promise<{ fileCount: number; skippedCount: number } | null> {
  try {
    const raw = await io.readText(joinLocalPath(casePath, LOCAL_AUDIT_MANIFEST_FILE))
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const doc = parsed as Record<string, unknown>
    if (doc.handoffId !== handoffId) return null
    return {
      fileCount: typeof doc.fileCount === 'number' ? doc.fileCount : 0,
      skippedCount: typeof doc.skippedCount === 'number' ? doc.skippedCount : 0,
    }
  } catch (error) {
    void error
    return null
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
