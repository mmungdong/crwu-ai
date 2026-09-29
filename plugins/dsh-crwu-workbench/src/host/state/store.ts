import type { WorkbenchConfig } from '../config/config.ts'
import { applyDeploymentConfig } from '../config/deployment.ts'
import { missingLocalAccessView } from '../access/consent.ts'
import { DEFAULT_MANIFEST } from '../environment/manifest-default.ts'
import type { WorkspaceView } from '../../shared/types.ts'
import type { WorkbenchState } from './types.ts'

/** 为一个 Cordis 插件实例创建隔离状态。 */
export function createWorkbenchState(config: WorkbenchConfig): WorkbenchState {
  return {
    caseRoot: config.caseRoot,
    // 启动时就让 TGZ 内 YAML 生效；远程清单稍后由 env 自检补充并覆盖非部署字段。
    manifest: applyDeploymentConfig(DEFAULT_MANIFEST, config),
    workspacePath: '',
    workspaceTitle: '',
    workspaceSource: '',
    workspaceChosen: false,
    workspaceMissing: false,
    workspaceId: '',
    registryLoaded: false,
    startingKey: '',
    runs: {},
    stopInFlight: {},
    parentSessionId: '',
    auditRoot: { workspacePath: '', casePath: '', sessionId: '', title: '', assignedAt: '' },
    // 授权收据的初值是 `missing`：在真正读一次磁盘之前**绝不**假定已授权。
    // 启动时是它、`boot`/`env` 会立刻用真实读盘结果覆盖。
    localAccess: missingLocalAccessView(),
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
