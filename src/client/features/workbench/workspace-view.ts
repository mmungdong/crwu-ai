import type { WorkspaceView } from '../../../shared/types.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 工作空间卡片的**判定逻辑**（纯函数，可独立测试）。
 *
 * 三件事：
 * 1. 已选定 / 未选定 / **选过的目录没了** + 来源文案；
 * 2. 显示哪些按钮（「恢复自动识别」只在手动选过、或目录丢了时才出现）；
 * 3. 审核产物的落盘位置说明。
 *
 * **刻意不看当前会话**：审核锚在插件选定的案例根目录上，不该因为「你从哪个会话点进来」
 * 而变样 —— 早先这里会比对父会话 cwd 并弹一句「不是同一个」，结果是每换一个会话，
 * 卡片就变一次（用户报的就是这个）。会话事实在 ⑧ 运行环境信息里如实展示。
 */

export interface WorkspaceStatus {
  chosen: boolean
  /** 用户选过的目录已经不在了：阻塞项，必须重选。 */
  missing: boolean
  path: string
  sourceLabel: string
  /** 用户手动选过（或选的那个丢了）→ 才显示「恢复自动识别」。 */
  canAuto: boolean
}

function sourceLabel(source: string): string {
  if (source === 'saved') return zhCN.wsSourceSaved
  if (source === 'manifest-workspace') return zhCN.wsSourceManifest
  if (source === 'manual') return zhCN.wsSourceManual
  return ''
}

export function workspaceStatus(workspace: WorkspaceView | null | undefined): WorkspaceStatus {
  const missing = workspace?.missing === true
  return {
    chosen: workspace?.chosen === true,
    missing,
    path: workspace?.path ?? '',
    sourceLabel: sourceLabel(workspace?.source ?? ''),
    // 目录丢了也要留出口：否则用户会卡在「选过的路径不存在」上，连恢复自动识别都点不到。
    canAuto: missing || (workspace?.source ?? '') === 'manual',
  }
}

/** 审核产物的落盘位置说明（用户最常问的问题：东西写到哪了）。 */
export function artifactHint(path: string): string {
  return `${zhCN.wsArtifactPrefix}${path}/<报告流水号>/。${zhCN.wsCwdNote}`
}
