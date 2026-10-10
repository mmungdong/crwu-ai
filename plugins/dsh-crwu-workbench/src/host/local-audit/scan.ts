import { constants as FS_CONSTANTS } from 'node:fs'
import { access, lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basenameLocalPath, trimTrailingSeparators } from '../../shared/utils/local-path.ts'
import {
  LOCAL_AUDIT_MAX_FILES,
  LOCAL_AUDIT_SCAN_MAX_ENTRIES,
  LOCAL_AUDIT_SCAN_MAX_FILES,
} from './consts.ts'

/**
 * 本地审核的**选择扫描**：把用户选的若干「文件或文件夹」展开成一份确定的普通文件清单。
 *
 * 它在**没有建立任何快照之前**就能回答界面上那三件事：展开后几个文件、每个选择项什么状态、
 * 有没有超过 30 个。因此它必须足够便宜（只读元数据，不读内容）也足够诚实（读不到就报读不到）。
 *
 * ## 五条判据（都与设计文档的验收场景一一对应）
 *
 * 1. **只认绝对路径入口**：相对路径一律拒绝 —— 客户端提交的字符串必须已经是它从选择器 /
 *    Electron `pathFor` 拿到的绝对路径。
 * 2. **不跟随符号链接**：目录与文件符号链接都**不进审核范围**（记 `skipped`，写明原因），
 *    否则一个链到 `/` 的目录能把整台机器读进来。
 * 3. **特殊文件跳过**：FIFO / socket / 设备节点不是「材料」，读它们会挂住。
 * 4. **去重按真实路径**：同一个文件通过多个入口（例如同时选了文件本身和它所在的目录）
 *    只出现一次；顺序取**首次出现**（选择顺序 + 展开顺序），所以结果是确定的。
 * 5. **超过 30 个不截取**：`overLimit` 为真并保留真实数量 —— 静默截取前 30 个是明确禁止的。
 */

/** 一个路径的类型；`absent` = 不存在（与"读不到"分开）。 */
export type LocalAuditPathKind = 'file' | 'directory' | 'symlink' | 'other' | 'absent'

export interface LocalAuditDirEntry {
  name: string
  kind: LocalAuditPathKind
  sizeBytes: number
}

/**
 * 扫描需要的**最小文件系统能力**。
 *
 * 单独抽出来是为了可测：单测注入内存替身，绝不碰员工机器上的真实文件；
 * 生产实现在 `nodeLocalAuditFs()` 里，是本功能**唯一**直接使用 `node:fs` 的地方。
 */
export interface LocalAuditFs {
  kindOf(path: string): Promise<LocalAuditPathKind>
  list(path: string): Promise<LocalAuditDirEntry[]>
  /** 规范化真实路径（去重判据）。解析失败返回原串。 */
  canonical(path: string): Promise<string>
  /** 当前账户能不能读它（只读探测，不读内容）。 */
  readable(path: string): Promise<boolean>
  /** 普通文件字节数；读不到返回 0。 */
  sizeOf(path: string): Promise<number>
}

/** 生产实现：`node:fs/promises`。 */
export function nodeLocalAuditFs(): LocalAuditFs {
  return {
    async kindOf(path) {
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) return 'symlink'
        if (info.isFile()) return 'file'
        if (info.isDirectory()) return 'directory'
        return 'other'
      } catch (error) {
        if (isAbsent(error)) return 'absent'
        // 读不到元数据（权限 / 占用）与"不存在"是两件事：这里统一按 `other` 上报，
        // 由调用方在 `readable()` 上再问一次，避免把"查不出来"说成"没有这个文件"。
        return 'other'
      }
    },
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true })
      const out: LocalAuditDirEntry[] = []
      for (const entry of entries) {
        const full = `${trimTrailingSeparators(path)}/${entry.name}`
        let sizeBytes = 0
        if (entry.isFile()) {
          try {
            sizeBytes = (await stat(full)).size
          } catch (error) {
            void error
            sizeBytes = 0
          }
        }
        out.push({
          name: entry.name,
          kind: entry.isSymbolicLink() ? 'symlink'
            : entry.isFile() ? 'file'
              : entry.isDirectory() ? 'directory' : 'other',
          sizeBytes,
        })
      }
      // 稳定的枚举顺序：readdir 不承诺顺序，而"去重取首次出现"要求它是确定的。
      out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return out
    },
    async canonical(path) {
      try {
        return await realpath(path)
      } catch (error) {
        void error
        return trimTrailingSeparators(path)
      }
    },
    async readable(path) {
      try {
        await access(path, FS_CONSTANTS.R_OK)
        return true
      } catch (error) {
        void error
        return false
      }
    },
    async sizeOf(path) {
      try {
        return (await stat(path)).size
      } catch (error) {
        void error
        return 0
      }
    },
  }
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 一个选择项（用户选的入口）的扫描结果。 */
export interface LocalAuditItem {
  path: string
  name: string
  /** `file` | `directory`。 */
  kind: string
  sizeBytes: number
  fileCount: number
  /** `scanned` | `unreadable` | `skipped` | `over-limit`。 */
  status: string
  reason: string
}

/** 进快照的普通文件（展示名 + 相对路径 + 绝对路径只在 Host 内部用）。 */
export interface LocalAuditCandidate {
  /** 用户机器上的绝对路径；只在本机内部流转。 */
  sourcePath: string
  /** 展示名（相对所选入口的相对路径）。 */
  relativePath: string
  /** 末段名（界面上的移除按钮要说出具体文件名）。 */
  name: string
  sizeBytes: number
  /**
   * 它属于哪个**已选入口**（文件夹的绝对路径；直接选中的文件就是它自己）。
   *
   * 界面用它在"文件夹行"下面把文件逐行挂出来（用户 2026-10-11 口径：扫描后要完整展示
   * 文件名称、并允许逐个移除）。
   */
  parentPath: string
}

export interface LocalAuditSkipped {
  relativePath: string
  name: string
  reason: string
}

export interface LocalAuditScan {
  ok: boolean
  error: string
  errorKind: 'input' | 'infrastructure' | ''
  items: LocalAuditItem[]
  /** 去重后的普通文件（超过上限时**仍然完整**，由 `overLimit` 表达）。 */
  files: LocalAuditCandidate[]
  skipped: LocalAuditSkipped[]
  fileCount: number
  limit: number
  overLimit: boolean
  readableCount: number
  skippedCount: number
  /** 枚举被安全上限截断（误选巨型目录）：不影响审核结论，但界面要如实说。 */
  truncated: boolean
}

function emptyScan(): LocalAuditScan {
  return {
    ok: false, error: '', errorKind: '', items: [], files: [], skipped: [],
    fileCount: 0, limit: LOCAL_AUDIT_MAX_FILES, overLimit: false,
    readableCount: 0, skippedCount: 0, truncated: false,
  }
}

/** 展示用的相对路径拼接：固定用 `/`（提示词与界面都读它，和平台无关）。 */
function relativeOf(root: string, rest: string): string {
  return rest === '' ? root : `${root}/${rest}`
}

/**
 * 展开一次选择。
 *
 * `selection` 是用户在界面上选的全部入口（绝对路径，顺序即用户选择顺序）。
 *
 * `options.excluded` 是员工在界面上**逐个移除**掉的文件（绝对路径）—— 被排除的文件不进
 * 清单、不计入数量、也不进快照，因此"移除一个文件"这件事在重新扫描后依然成立。
 * 它只认**入口之内**的文件：入口本身要去掉就把它从 `selection` 里删掉（界面就是这么做的）。
 */
export async function scanSelection(
  selection: readonly string[],
  fs: LocalAuditFs,
  options: { excluded?: readonly string[] } = {},
): Promise<LocalAuditScan> {
  const scan = emptyScan()
  const roots: string[] = []
  const seenRoots = new Set<string>()
  const excludedKeys = new Set<string>()
  for (const raw of options.excluded ?? []) {
    const path = trimTrailingSeparators(raw)
    if (path === '' || !isAbsolute(path)) continue
    excludedKeys.add(await fs.canonical(path))
  }
  for (const raw of selection) {
    const path = trimTrailingSeparators(raw)
    if (path === '') continue
    // 相对路径一律拒绝：客户端必须把选择器 / Electron `pathFor` 的绝对路径交上来。
    if (!isAbsolute(path)) {
      return { ...scan, ok: false, errorKind: 'input', error: `本地审核只接受绝对路径：${path}` }
    }
    const key = await fs.canonical(path)
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    roots.push(path)
  }
  if (roots.length === 0) return scan

  const items: LocalAuditItem[] = []
  const files: LocalAuditCandidate[] = []
  const skipped: LocalAuditSkipped[] = []
  const seenFiles = new Set<string>()
  let entries = 0
  let truncated = false
  /** 命中了多少条排除项（只用来把"全被移除"与"压根读不到"分开说）。 */
  let excludedHits = 0

  const pushFile = async (
    sourcePath: string,
    relativePath: string,
    sizeBytes: number,
    parentPath: string,
  ): Promise<void> => {
    const key = await fs.canonical(sourcePath)
    // 去重：同一个文件经多个入口进来只算一次，且取**首次出现**。
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    // 员工逐个移除掉的：既不算"跳过"也不算"读不到"，就是不在本次范围里。
    if (excludedKeys.has(key)) { excludedHits += 1; return }
    if (files.length >= LOCAL_AUDIT_SCAN_MAX_FILES) {
      truncated = true
      return
    }
    if (!await fs.readable(sourcePath)) {
      skipped.push({ relativePath, name: basenameLocalPath(relativePath), reason: '权限不足' })
      return
    }
    files.push({ sourcePath, relativePath, name: basenameLocalPath(relativePath), sizeBytes, parentPath })
  }

  const walk = async (dir: string, prefix: string, root: string, budget: { left: number }): Promise<boolean> => {
    let listing: LocalAuditDirEntry[]
    try {
      listing = await fs.list(dir)
    } catch (error) {
      void error
      return false
    }
    for (const entry of listing) {
      if (budget.left <= 0) { truncated = true; return true }
      budget.left -= 1
      entries += 1
      if (entries > LOCAL_AUDIT_SCAN_MAX_ENTRIES) { truncated = true; return true }
      const child = `${trimTrailingSeparators(dir)}/${entry.name}`
      const rel = relativeOf(prefix, entry.name)
      if (entry.kind === 'symlink') {
        skipped.push({ relativePath: rel, name: entry.name, reason: '符号链接不纳入审核范围' })
        continue
      }
      if (entry.kind === 'other') {
        skipped.push({ relativePath: rel, name: entry.name, reason: '特殊文件（不是普通文件或目录）' })
        continue
      }
      if (entry.kind === 'directory') {
        if (await walk(child, rel, root, budget)) return true
        continue
      }
      await pushFile(child, rel, entry.sizeBytes, root)
    }
    return false
  }

  for (const root of roots) {
    const name = basenameLocalPath(root) || root
    const kind = await fs.kindOf(root)
    if (kind === 'absent') {
      items.push({ path: root, name, kind: 'file', sizeBytes: 0, fileCount: 0, status: 'unreadable', reason: '路径不存在或无法读取' })
      continue
    }
    if (kind === 'symlink') {
      items.push({ path: root, name, kind: 'file', sizeBytes: 0, fileCount: 0, status: 'skipped', reason: '符号链接不纳入审核范围' })
      continue
    }
    if (kind === 'other') {
      items.push({ path: root, name, kind: 'file', sizeBytes: 0, fileCount: 0, status: 'skipped', reason: '特殊文件（不是普通文件或目录）' })
      continue
    }
    if (kind === 'file') {
      const before = files.length
      const size = await fs.sizeOf(root)
      // 入口本身被移除：不当成"读不到"（那是另一回事，会误导用户去查权限）。
      const excludedHere = excludedKeys.has(await fs.canonical(root))
      await pushFile(root, name, size, root)
      const accepted = files.length > before
      items.push({
        path: root, name, kind: 'file', sizeBytes: size,
        fileCount: accepted ? 1 : 0,
        status: accepted ? 'scanned' : (excludedHere ? 'removed' : 'unreadable'),
        reason: accepted ? '' : (excludedHere ? '已移除，不参与本次审核' : '无法读取（权限不足或文件被占用）'),
      })
      continue
    }
    // 目录：递归展开（不跟随符号链接、跳过特殊文件）。
    const before = files.length
    const skillSkipped = skipped.length
    const excludedBefore = excludedHits
    const budget = { left: LOCAL_AUDIT_SCAN_MAX_ENTRIES - entries }
    const stop = await walk(root, name, root, budget)
    if (stop) truncated = true
    const added = files.length - before
    const refused = skipped.length - skillSkipped
    const removed = excludedHits - excludedBefore
    items.push({
      path: root, name, kind: 'directory', sizeBytes: 0, fileCount: added,
      status: added > 0 ? 'scanned' : (removed > 0 ? 'removed' : 'unreadable'),
      reason: added > 0 ? '' : (removed > 0
        ? '展开后的文件都被移除了'
        : (refused > 0 ? '展开后没有可读取的普通文件' : '目录为空或无法读取')),
    })
  }

  const overLimit = files.length > LOCAL_AUDIT_MAX_FILES
  if (overLimit) {
    for (const item of items) {
      if (item.status === 'scanned') {
        item.status = 'over-limit'
        item.reason = `展开后共 ${String(files.length)} 个文件，超过单次最多 ${String(LOCAL_AUDIT_MAX_FILES)} 个文件的限制`
      }
    }
  }
  return {
    ...scan,
    ok: true,
    items,
    files,
    skipped,
    fileCount: files.length,
    overLimit,
    readableCount: files.length,
    skippedCount: skipped.length,
    truncated,
  }
}

/** 绝对路径判据：与 `shared/utils/local-path.ts` 同口径，但这里只需要布尔。 */
function isAbsolute(path: string): boolean {
  if (path.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  return /^[\\/]{2}[^\\/]/.test(path)
}
