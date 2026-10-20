import type { OperationMap } from './types.ts'
import type { OperationHost } from './common.ts'
import {
  createWorkspaceCleanupService, type WorkspaceCleanupService,
} from '../domains/workspace-cleanup/index.ts'
import { cleanupSessionPort } from '../domains/workspace-cleanup/session-port.ts'
import { nodeCleanupIo } from '../domains/workspace-cleanup/io.ts'
import { resolveSelectedWorkspace } from '../core/workspace-session/index.ts'
import { persistAudits } from '../core/state/registry.ts'
import { text } from '../../shared/utils/value.ts'
import type { WorkspaceCleanupRequest } from '../../shared/contracts/workspace-cleanup.ts'

/**
 * 工作空间清理的两条 RPC（协议 49）。
 *
 * 服务在**装配时构造一次**：计划租约是进程内状态，plan 与 apply 必须看到同一份。
 * 每条 handler 只做形状检查 —— 授权、工作空间解析、指纹与执行顺序都在服务里，
 * 那里才是唯一的判据来源。
 */
export function workspaceCleanupOperations(host: OperationHost): OperationMap {
  const service: WorkspaceCleanupService = createWorkspaceCleanupService({
    access: host.resolvers.access,
    resolveWorkspace: () => resolveSelectedWorkspace(host.ctx, host.state),
    home: () => host.world.home(),
    platform: () => host.world.platform(),
    sessionPort: () => cleanupSessionPort(host.ctx),
    io: nodeCleanupIo(),
    closeWorkflowStores: async (workspacePath) => {
      await host.extra.closeWorkspaceStores?.(workspacePath)
    },
    clearAudits: () => {
      // 磁盘与会话都清掉之后，这些记录只会指向空目录；留着等于让员工点开一个坏掉的案例。
      host.state.audits = {}
      host.state.activeKey = ''
      host.state.activeChildId = ''
      host.state.auditRoot = {
        workspaceId: '', workspacePath: '', casePath: '', sessionId: '', title: '', assignedAt: '',
      }
    },
    persistAudits: async () => await persistAudits({
      ctx: host.ctx,
      home: await host.world.home(),
      state: host.state,
      access: host.resolvers.access,
    }),
    invalidate: () => host.gate.invalidate(),
  })
  return {
    'workspace-cleanup-plan': async () => await service.plan(),
    'workspace-cleanup-apply': async (args) => await service.apply(readRequest(args)),
  }
}

/** 只接受契约里的四个字段；多余字段忽略，错误类型在服务里再判一次。 */
function readRequest(args: Record<string, unknown>): WorkspaceCleanupRequest {
  return {
    planId: text(args.planId),
    digest: text(args.digest),
    confirmName: text(args.confirmName),
    deleteSessionLogs: args.deleteSessionLogs === true,
  }
}
