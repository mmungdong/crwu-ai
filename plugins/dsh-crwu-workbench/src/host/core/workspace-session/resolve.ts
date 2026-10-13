import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import { trimTrailingSeparators } from '../../../shared/utils/local-path.ts'
import { fileSystem, isDir } from '../fs/paths.ts'
import { workspaceFailure } from './errors.ts'
import type {
  SelectedWorkspace,
  WorkspaceResolution,
  WorkspaceSessionState,
} from './types.ts'

/**
 * 按【环境信息】里的选中工作区，解析出一个**已经与 DSH 注册表核对过**的工作区。
 *
 * 这是整条链路的唯一入口：任何要创建会话的地方都必须先过这里。它有两种结果 ——
 * 通过，或者一个**指名道姓的失败原因**；没有第三条"先凑合"的路。
 *
 * 判据顺序是刻意排的（越靠前越"用户能自己修"）：
 *   id 空 → 路径空 → 目录丢了 → 自检没完成 → 服务缺失 → 注册表查不到 → 路径不一致 → 不是目录。
 */

/** 工作区实体（只取本层要用的字段，避免依赖 DSH 的类型包）。 */
export interface WorkspaceEntityLike {
  id: string
  path: string
  title?: string
}

/** 注册表的最小面。 */
export interface WorkspaceRegistryLike {
  get?: (id: string) => WorkspaceEntityLike | undefined
  list?: () => WorkspaceEntityLike[]
}

/** 取工作区注册表；未装配时 `undefined`。 */
export function workspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  return ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
}

/**
 * 路径的**规范键**。
 *
 * 优先问 `fs.resolve().targetKey`：本地后端给的就是 realpath，于是符号链接、大小写、
 * 分隔符风格都被后端自己收敛，我们不做字符串猜测（`C:\` 与 `c:/` 是同一个目录，
 * 而 `replace(/\/+$/,'')` 会把盘根裁成盘符相对路径 —— 那是另一个目录）。
 * fs 不可用或解析失败时退回"去尾分隔符"的文本比较：**只是**显示层面的兜底。
 */
export async function pathKey(ctx: Context, path: string): Promise<string> {
  const fs = fileSystem(ctx)
  if (fs !== undefined) {
    try {
      return String((await fs.resolve(path)).targetKey)
    } catch (error) {
      void error
    }
  }
  return trimTrailingSeparators(path)
}

/** 从注册表里按 id 取实体（`get` 缺失时退回 `list` 扫描，兼容简化宿主）。 */
export function registryEntity(ctx: Context, id: string): WorkspaceEntityLike | undefined {
  const registry = workspaceRegistry(ctx)
  if (registry === undefined || id === '') return undefined
  try {
    if (typeof registry.get === 'function') {
      const found = registry.get(id)
      if (found !== undefined && found !== null) return found
    }
    if (typeof registry.list === 'function') {
      return (registry.list() ?? []).find((entry) => text(entry?.id) === id)
    }
  } catch (error) {
    void error
  }
  return undefined
}

/**
 * 解析选中的工作区。
 *
 * ⚠️ 这里**不**接受任何降级来源：不要 `caseRoot`、不要部署默认目录、不要父会话的 cwd。
 * 唯一来源是 `state.workspace*`（用户在【环境信息】里显式选的那个）。
 */
export async function resolveSelectedWorkspace(
  ctx: Context,
  state: WorkspaceSessionState,
): Promise<WorkspaceResolution> {
  const id = text(state.workspaceId)
  const path = trimTrailingSeparators(text(state.workspacePath))
  if (id === '' || path === '') return workspaceFailure('no-workspace')
  if (state.workspaceMissing) return workspaceFailure('workspace-missing')
  // 自检没跑完时 `workspaceId` 可能是上一轮的残留：结论不可信，不入业务。
  if (!state.workspaceChosen) return workspaceFailure('workspace-unchecked')

  if (workspaceRegistry(ctx) === undefined) return workspaceFailure('services-unavailable')

  const entity = registryEntity(ctx, id)
  if (entity === undefined) return workspaceFailure('workspace-unregistered')

  const entityPath = trimTrailingSeparators(text(entity.path))
  if (entityPath === '') return workspaceFailure('workspace-unregistered')
  // 两条都要比：先比规范键（真实目录），再比字面（注册表被手改过时也能给出准确结论）。
  const [left, right] = await Promise.all([pathKey(ctx, entityPath), pathKey(ctx, path)])
  if (left === '' || right === '' || left !== right) {
    return workspaceFailure('workspace-path-mismatch')
  }
  if (!await isDir(ctx, entityPath)) return workspaceFailure('workspace-not-a-directory')

  const workspace: SelectedWorkspace = {
    id,
    path: entityPath,
    title: text(state.workspaceTitle) || text(entity.title) || entityPath,
  }
  return { ok: true, workspace }
}
