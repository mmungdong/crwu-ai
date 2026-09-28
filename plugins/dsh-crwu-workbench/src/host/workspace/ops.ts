import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchConfig } from '../config/config.ts'
import type { WorldFacts } from '../platform/world.ts'
import { writeWorkbenchConfig } from '../state/persist.ts'
import { trimTrailingSeparators } from '../../shared/utils/local-path.ts'
import { workspaceView } from '../state/store.ts'
import type { WorkbenchState } from '../state/types.ts'
import { ensureWorkspace, sessionWorkspaceInfo, type SessionWorkspaceInfo } from './resolve.ts'

/**
 * 工作空间相关的操作。
 *
 * 这一层有两个**必须保留**的语义，都是"链路级"的（只核对操作名看不出来）：
 *
 * 1. `workspace-auto`（界面上叫「恢复自动识别」）不只是清空内存里的选择：
 *    - 必须把磁盘上的 `workspacePath` 一起清掉，否则重启后旧选择会从注册表恢复回来；
 *    - 必须立刻 `ensureWorkspace()` 重新采用清单偏好的那个工作空间，否则用户点完之后
 *      处于「没有任何工作空间」的状态，而**发起审核是要求已选定工作空间的**。
 * 2. `bind-session` 成功登记父级后要顺带把工作空间采用了：用户按引导做的第一步就是登记，
 *    不该再要求他额外去点一次「自检」才能开始。
 */

export interface WorkspaceOpsDeps {
  ctx: Context
  config: WorkbenchConfig
  state: WorkbenchState
  world: WorldFacts
}

/** 供 `ensureWorkspace` 使用的工作空间偏好（清单优先，其次配置）。 */
function preferWorkspace(deps: WorkspaceOpsDeps): { preferTitle: string; preferPath: string } {
  const manifest = deps.state.manifest
  return {
    preferTitle: deps.config.preferWorkspaceTitle || manifest?.workspace.preferTitle || '',
    preferPath: manifest?.workspace.preferPath ?? '',
  }
}

/** 采用清单偏好的工作空间（幂等）。 */
export async function adoptWorkspace(deps: WorkspaceOpsDeps): Promise<void> {
  await ensureWorkspace(deps.ctx, await deps.world.home(), deps.state, preferWorkspace(deps))
}

export interface WorkspaceSelectionResult {
  ok: boolean
  workspace: ReturnType<typeof workspaceView>
  sessionWorkspace: SessionWorkspaceInfo
  /** 磁盘写失败时非空；界面据此提示「选择没被保存」。 */
  persistError: string
}

/** 选定案例根目录（手动）。 */
export async function pickWorkspace(deps: WorkspaceOpsDeps, args: Record<string, unknown>): Promise<WorkspaceSelectionResult> {
  // 尾分隔符按路径风格裁剪：`replace(/\/+$/, '')` 对 `C:\Work\` 无效、对 `C:\` 会裁坏。
  const path = trimTrailingSeparators(String(args.path ?? '').trim())
  let persistError = ''
  if (path !== '') {
    const title = String(args.title ?? '') || path
    const id = String(args.id ?? '')
    deps.state.workspacePath = path
    deps.state.workspaceTitle = title
    deps.state.workspaceId = id
    deps.state.workspaceSource = 'manual'
    deps.state.workspaceChosen = true
    deps.state.workspaceMissing = false
    deps.state.caseRoot = path
    // **整份落盘**（path + title + id + source）：只存 path 的话，重启后 source 会从
    // 'manual' 变成 'saved'，界面上的标签与「恢复自动识别」按钮都会变样。
    const saved = await writeWorkbenchConfig(deps.ctx, await deps.world.home(), {
      workspacePath: path,
      workspaceTitle: title,
      workspaceId: id,
      workspaceSource: 'manual',
    })
    if (!saved) persistError = '工作空间选择没能写入磁盘，重启后会丢失'
  }
  return {
    ok: true,
    workspace: workspaceView(deps.state),
    sessionWorkspace: sessionWorkspaceInfo(deps.ctx, deps.state),
    persistError,
  }
}

/**
 * 恢复自动识别。
 *
 * 三步缺一不可：**清磁盘** → **清内存** → **重新采用**。
 * 只做第二步的话，用户点完会得到一个「没有工作空间」的状态，而发起审核需要它。
 */
export async function autoWorkspace(deps: WorkspaceOpsDeps): Promise<WorkspaceSelectionResult> {
  const persisted = await writeWorkbenchConfig(deps.ctx, await deps.world.home(), {
    workspacePath: '',
    workspaceTitle: '',
    workspaceId: '',
    workspaceSource: '',
  })
  deps.state.workspaceChosen = false
  deps.state.workspaceMissing = false
  deps.state.workspacePath = ''
  deps.state.workspaceTitle = ''
  deps.state.workspaceId = ''
  deps.state.workspaceSource = ''
  await adoptWorkspace(deps)
  return {
    ok: true,
    workspace: workspaceView(deps.state),
    sessionWorkspace: sessionWorkspaceInfo(deps.ctx, deps.state),
    persistError: persisted ? '' : '清理磁盘上的工作空间选择失败，重启后旧选择可能回来',
  }
}
