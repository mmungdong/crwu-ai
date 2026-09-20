import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkbenchState } from './types.ts'

/** 为一个 Cordis 插件实例创建隔离状态。 */
export function createWorkbenchState(config: WorkbenchConfig): WorkbenchState {
  return {
    caseRoot: config.caseRoot,
    workspacePath: '',
    workspaceTitle: '',
    workspaceSource: '',
    workspaceChosen: false,
    parentSessionId: '',
    trustH3yun: false,
    audits: {},
    activeKey: '',
    activeChildId: '',
    activeSince: 0,
  }
}

/** 返回可通过线协议发送的工作空间视图。 */
export function workspaceView(state: WorkbenchState): Record<string, unknown> {
  return {
    chosen: state.workspaceChosen,
    path: state.workspacePath,
    title: state.workspaceTitle || state.workspacePath,
    source: state.workspaceSource,
  }
}
