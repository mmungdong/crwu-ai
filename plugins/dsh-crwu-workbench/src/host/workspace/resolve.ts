import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { isDir } from '../fs/paths.ts'
import { readWorkbenchConfig } from '../state/persist.ts'
import type { WorkbenchState } from '../state/types.ts'

/**
 * 工作空间解析。
 *
 * 本仓的一条硬规则（legacy 注释里写得很清楚）：**绝不采用「父会话自己的工作空间」当默认值**。
 * 父会话常常就开在源码仓库里，照搬会把审核产物写进代码仓库。所以这里的判据只有两个：
 * 用户在面板上显式选过的路径（落盘），或清单里按名字/路径命中且**真实存在**的工作空间。
 * 都不命中就返回 `ok: false`，由界面要求用户手动选 —— 宁可不选，也不能猜。
 */

export interface WorkspaceResolution {
  ok: boolean
  path: string
  id: string
  title: string
  source: '' | 'saved' | 'manual' | 'manifest-workspace'
  /**
   * 「用户选过、但目录已经不在了」。
   *
   * 这时 `ok` 是 false 但**不回落**到清单偏好：静默换一个工作空间比停下来问一句危险得多 ——
   * 审核产物会写进另一个目录，而用户以为自己还在原来那儿。
   */
  missing: boolean
}

export interface WorkspaceEntry {
  id: string
  path: string
  title: string
}

/** 去掉结尾斜杠；空值保持空。 */
export function trimSlash(value: unknown): string {
  return text(value).replace(/[\\/]+$/, '')
}

/**
 * 落盘里记的来源，**原样恢复**。
 *
 * 老文件只存了 `workspacePath`（没有 source），那种情况按 `'saved'`（「上次选择」）显示；
 * 新文件存了 `'manual'`，重启后标签仍是「手动选择」、`canAuto` 仍是 true ——
 * 「恢复自动识别」按钮不会凭空消失。
 */
function sourceOfSaved(config: Record<string, unknown>): 'saved' | 'manual' | 'manifest-workspace' {
  const raw = text(config.workspaceSource)
  if (raw === 'manual') return 'manual'
  if (raw === 'manifest-workspace') return 'manifest-workspace'
  return 'saved'
}

/** 读工作空间注册表；服务不可用或抛错都返回空数组。 */
export function registryList(ctx: Context): WorkspaceEntry[] {
  const registry = ctx.get('workspaceRegistry') as { list?: () => unknown } | undefined
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    const list = registry.list()
    if (!Array.isArray(list)) return []
    return list.map((item) => {
      const record = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
      return { id: text(record.id), path: trimSlash(record.path), title: text(record.title) }
    })
  } catch (error) {
    void error
    return []
  }
}

/**
 * 选出审核产物该写到哪里。
 *
 * 优先级：**面板显式选过（落盘）且仍存在 > 清单的 `preferPath` > 清单的 `preferTitle`**
 * （先精确匹配标题，再退化为路径包含标题）。清单那两档都要求目录真实存在，否则继续往下找。
 *
 * 唯一**不回落**的分支是「用户选过的目录不见了」：那是 `missing: true`，由界面要求重选。
 */
export async function resolveAuditWorkspace(
  ctx: Context,
  home: string,
  prefer: { preferTitle: string; preferPath: string },
): Promise<WorkspaceResolution> {
  const miss: WorkspaceResolution = { ok: false, path: '', id: '', title: '', source: '', missing: false }
  const list = registryList(ctx)

  const config = await readWorkbenchConfig(ctx, home)
  const savedPath = trimSlash(config.workspacePath)
  if (savedPath !== '') {
    if (!await isDir(ctx, savedPath)) {
      // 用户选过的东西不能"自动换一个"：留着路径让界面说清楚。
      return { ok: false, path: savedPath, id: '', title: '', source: sourceOfSaved(config), missing: true }
    }
    let id = text(config.workspaceId)
    try {
      const registry = ctx.get('workspaceRegistry') as { resolveByPath?: (path: string) => Promise<unknown> | unknown } | undefined
      if (id === '' && registry !== undefined && typeof registry.resolveByPath === 'function') {
        const resolved = await registry.resolveByPath(savedPath)
        id = text(resolved !== null && typeof resolved === 'object' ? (resolved as Record<string, unknown>).id : '')
      }
    } catch (error) {
      // 注册表解析失败不影响「用用户选过的路径」这个结论。
      void error
    }
    const hit = list.find((entry) => entry.path === savedPath)
    return {
      ok: true,
      path: savedPath,
      // 选定时落盘的三件套原样恢复：标签与按钮不该因为重启而变样。
      source: sourceOfSaved(config),
      id: id || text(hit?.id),
      title: text(config.workspaceTitle) || text(hit?.title) || savedPath,
      missing: false,
    }
  }

  const wantPath = trimSlash(prefer.preferPath)
  const wantTitle = text(prefer.preferTitle)
  let hit = wantPath === '' ? undefined : list.find((entry) => entry.path === wantPath)
  if (hit === undefined && wantTitle !== '') hit = list.find((entry) => entry.title === wantTitle)
  if (hit === undefined && wantTitle !== '') hit = list.find((entry) => entry.path.includes(wantTitle))
  if (hit !== undefined && await isDir(ctx, hit.path)) {
    return {
      ok: true,
      path: hit.path,
      source: 'manifest-workspace',
      id: hit.id,
      title: hit.title || wantTitle,
      missing: false,
    }
  }
  return miss
}

/**
 * 幂等地采用一个工作空间。
 *
 * 已选定就不再动：每次环境自检都重新解析会把用户在面板上的选择覆盖掉。
 */
export async function ensureWorkspace(
  ctx: Context,
  home: string,
  state: WorkbenchState,
  prefer: { preferTitle: string; preferPath: string },
): Promise<void> {
  // 已经选定且没丢 → 不动它（每次自检都重新解析会把用户的选择覆盖掉）。
  if (state.workspaceChosen && state.workspacePath !== '' && !state.workspaceMissing) return
  const resolved = await resolveAuditWorkspace(ctx, home, prefer)
  if (resolved.missing) {
    // 用户选过的目录没了：**只报告，不换**。path 留着给界面说清楚是哪一个。
    state.workspaceMissing = true
    state.workspaceChosen = false
    state.workspacePath = resolved.path
    state.workspaceTitle = ''
    state.workspaceId = ''
    state.workspaceSource = resolved.source
    state.caseRoot = ''
    return
  }
  if (!resolved.ok) return
  state.workspaceMissing = false
  state.workspacePath = resolved.path
  state.workspaceTitle = resolved.title
  state.workspaceId = resolved.id
  state.workspaceSource = resolved.source
  state.caseRoot = resolved.path
  state.workspaceChosen = true
}

export interface SessionWorkspaceInfo {
  parentSessionId: string
  sessionCwd: string
  workspaceId: string
  workspacePath: string
  workspaceTitle: string
}

/**
 * 父会话自己开在哪个工作空间。
 *
 * 只用于**显示**，不参与 `resolveAuditWorkspace` 的判据 —— 显示用户可以核对，采用则会写错目录。
 * 匹配取最长前缀：一个工作空间可能是另一个的子目录。
 */
export function sessionWorkspaceInfo(ctx: Context, state: WorkbenchState): SessionWorkspaceInfo {
  const out: SessionWorkspaceInfo = {
    parentSessionId: state.parentSessionId,
    sessionCwd: '',
    workspaceId: '',
    workspacePath: '',
    workspaceTitle: '',
  }
  if (state.parentSessionId === '') return out

  const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: Record<string, unknown> } | undefined } | undefined
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      const header = sessions.get(state.parentSessionId)?.header
      out.sessionCwd = text(header?.cwd)
    } catch (error) {
      void error
      out.sessionCwd = ''
    }
  }
  if (out.sessionCwd === '') return out

  let best: WorkspaceEntry | null = null
  for (const entry of registryList(ctx)) {
    if (entry.path === '') continue
    if (out.sessionCwd === entry.path || out.sessionCwd.startsWith(`${entry.path}/`)) {
      if (best === null || entry.path.length > best.path.length) best = entry
    }
  }
  if (best !== null) {
    out.workspaceId = best.id
    out.workspacePath = best.path
    out.workspaceTitle = best.title || best.path
  }
  return out
}
