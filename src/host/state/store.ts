import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkspaceView } from '../../shared/types.ts'
import type { WorkbenchState } from './types.ts'

/** 为一个 Cordis 插件实例创建隔离状态。 */
export function createWorkbenchState(config: WorkbenchConfig): WorkbenchState {
  return {
    caseRoot: config.caseRoot,
    manifest: null,
    workspacePath: '',
    workspaceTitle: '',
    workspaceSource: '',
    workspaceChosen: false,
    workspaceMissing: false,
    workspaceId: '',
    registryLoaded: false,
    startingKey: '',
    runs: {},
    parentSessionId: '',
    auditRoot: { workspacePath: '', sessionId: '', title: '', assignedAt: '' },
    trustH3yun: false,
    formCode: '',
    formName: '',
    audits: {},
    activeKey: '',
    activeChildId: '',
    activeSince: 0,
  }
}

/** 返回可通过线协议发送的工作空间视图。 */
export function workspaceView(state: WorkbenchState): WorkspaceView {
  return {
    chosen: state.workspaceChosen,
    path: state.workspacePath,
    title: state.workspaceTitle || state.workspacePath,
    id: state.workspaceId,
    source: state.workspaceSource,
    missing: state.workspaceMissing,
  }
}
