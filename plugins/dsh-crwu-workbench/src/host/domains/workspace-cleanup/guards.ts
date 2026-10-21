import type { WorkspaceCleanupEntryKind } from '../../../shared/contracts/workspace-cleanup.ts'
import {
  basenameLocalPath,
  isAbsoluteLocalPath,
  isLocalPathUnder,
  joinLocalPath,
  trimTrailingSeparators,
} from '../../../shared/utils/local-path.ts'
import type { WorkspaceIdentity } from './types.ts'

/**
 * 清空工作空间的**边界守卫**。
 *
 * 这一层不碰文件系统以外的任何东西，也不决定"删什么"：它只回答"这个目录配不配被清空"。
 * 判据全部用**规范路径**（`realpath`）做身份比较，展示仍用员工选的原路径 ——
 * 扫描之后把 W 换成另一个符号链接，删除也不会跟着链接跑到别处。
 *
 * 拒绝清单（任何一条成立就整体拒绝）：
 * - 不是绝对路径 / 不存在 / 不是目录 / `realpath` 失败；
 * - 文件系统根（`/`、`C:`、`C:\`、UNC 共享根）；
 * - 主目录本身，或是主目录的祖先（主目录与候选都按**真实路径**比，软链不放过）；
 * - `~/.dsh` 本身、它的祖先、以及它内部的任何目录（插件状态与会话日志都在里面）；
 * - 是插件状态文件 `~/.dsh/crwu-workbench.json` 的祖先。
 */

export interface GuardDeps {
  stat(path: string): Promise<{ isDirectory(): boolean } | undefined>
  realpath(path: string): Promise<string>
}

export interface GuardInput {
  workspace: { id: string; path: string; title: string }
  home: string
  platform: string
  deps: GuardDeps
}

export type GuardOutcome =
  | { ok: true; identity: WorkspaceIdentity }
  | { ok: false; error: string }

export function isFilesystemRoot(path: string): boolean {
  const raw = trimTrailingSeparators(path)
  if (raw === '/') return true
  if (raw === '') return false
  // 盘符根：`C:` 与 `C:\` 是同一条；`C:\Work` 不是。
  if (/^[A-Za-z]:[\\/]?$/.test(raw)) return true
  // UNC 共享根：`\\server\share` / `//server/share`（再往下才是共享内的目录）。
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(raw)
}

/**
 * `child` 是不是 `parent` 的**直接**子项（一层）。
 *
 * 用 `joinLocalPath(parent, basename(child)) === child` 判断，而不是字符串前缀：
 * 前缀比较在 Windows 上既漏（分隔符）又错（`/w` 会命中 `/w2`）。
 */
export function isDirectChild(parent: string, child: string): boolean {
  const base = trimTrailingSeparators(parent)
  const target = trimTrailingSeparators(child)
  if (base === '' || target === '' || base === target) return false
  const name = basenameLocalPath(target)
  if (name === '' || name === '/' || name === '\\' || /[\\/]/.test(name)) return false
  if (/^[A-Za-z]:$/.test(name)) return false
  try {
    return joinLocalPath(base, name) === target
  } catch {
    // `joinLocalPath` 对绝对片段 / `..` 抛错：那本来就不是"直接子项"。
    return false
  }
}

export function classifyEntry(name: string, facts: {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}): WorkspaceCleanupEntryKind {
  void name
  if (facts.isSymbolicLink()) return 'symlink'
  if (facts.isDirectory()) return 'directory'
  if (facts.isFile()) return 'file'
  return 'other'
}

export async function guardWorkspace(input: GuardInput): Promise<GuardOutcome> {
  const path = trimTrailingSeparators(input.workspace.path)
  if (path === '' || !isAbsoluteLocalPath(path)) {
    return { ok: false, error: '选定的工作空间不是绝对路径，无法清理' }
  }
  let info: { isDirectory(): boolean } | undefined
  try {
    info = await input.deps.stat(path)
  } catch (error) {
    return { ok: false, error: `无法确认工作空间是否存在：${reasonOf(error)}` }
  }
  if (info === undefined) return { ok: false, error: '选定的工作空间目录不在了，请重新选择' }
  if (!info.isDirectory()) return { ok: false, error: '选定的工作空间不是目录，无法清理' }

  let real: string
  try {
    real = trimTrailingSeparators(await input.deps.realpath(path))
  } catch (error) {
    return { ok: false, error: `无法解析工作空间的真实路径：${reasonOf(error)}` }
  }
  if (real === '' || !isAbsoluteLocalPath(real)) {
    return { ok: false, error: '工作空间的真实路径不可用，无法清理' }
  }
  if (isFilesystemRoot(real)) return { ok: false, error: '拒绝对文件系统根目录执行清理' }

  const home = trimTrailingSeparators(input.home)
  if (home !== '') {
    /**
     * 主目录也必须换成真实路径再比：`/Users/x` 常常是指向 `/Volumes/Data/x` 的软链，
     * 只比原串时，真实路径那一侧的主目录、它的祖先、`~/.dsh` 全部失配 —— 二次确认后
     * 删掉的就是真实主目录。解析不出来时**拒绝**，不退回字符串比较。
     */
    let homeReal: string
    try {
      homeReal = trimTrailingSeparators(await input.deps.realpath(home))
    } catch (error) {
      return { ok: false, error: `无法解析主目录的真实路径，拒绝清理：${reasonOf(error)}` }
    }
    if (homeReal === '' || !isAbsoluteLocalPath(homeReal)) {
      return { ok: false, error: '主目录的真实路径不可用，拒绝清理' }
    }
    for (const base of new Set([home, homeReal])) {
      if (isLocalPathUnder(base, real)) {
        return { ok: false, error: '拒绝清理主目录或主目录的祖先' }
      }
      const dshHome = joinLocalPath(base, '.dsh')
      if (isLocalPathUnder(real, dshHome) || isLocalPathUnder(dshHome, real)) {
        return { ok: false, error: '拒绝清理 DSH 主目录（~/.dsh）本身、其祖先或内部目录' }
      }
      const statePath = joinLocalPath(dshHome, 'crwu-workbench.json')
      if (isLocalPathUnder(statePath, real)) {
        return { ok: false, error: '拒绝清理包含插件状态文件的工作空间' }
      }
    }
  }

  const name = basenameLocalPath(path) || basenameLocalPath(real)
  if (name === '' || isFilesystemRoot(name)) {
    return { ok: false, error: '无法确定工作空间目录名，无法清理' }
  }
  return {
    ok: true,
    identity: { id: input.workspace.id, path, realPath: real, name },
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
