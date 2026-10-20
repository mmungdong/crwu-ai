import type { OperationMap } from './types.ts'
import type { OperationHost } from './common.ts'
import { localAuditClaim, localAuditStart, localAuditStatus } from '../domains/local-audit/ops.ts'
import { LOCAL_AUDIT_MAX_FILES } from '../domains/local-audit/consts.ts'

/**
 * **本地审核**（协议 28）的三条操作。
 *
 * 它们**不判环境门禁**：本地审核的存在意义就是"不需要氚云 / OSS / 工作空间也能审本机文件"。
 * 它唯一需要的是**本机访问授权**，而那一条由 Broker 在自己的操作表里判。
 */
export function localAuditOperations(host: OperationHost): OperationMap {
  const { localAuditDeps, localAuditUnwired } = host
  return {
    /**
     * **本地审核**（协议 28）。
     *
     * 三条操作共用一份依赖：注册表、扫描用的 fs、快照 IO。它们**不判环境门禁** ——
     * 本地审核的存在意义就是"不需要氚云 / OSS / 工作空间也能审本机文件"；它唯一需要的是
     * **本机访问授权**，而那一条由 Broker 在自己的操作表里判（`local-audit-start` 内）。
     */
    'local-audit-status': async (args) => {
      const ready = localAuditDeps()
      if (ready === null) {
        return {
          ...localAuditUnwired, fileCount: 0, limit: LOCAL_AUDIT_MAX_FILES, overLimit: false,
          readableCount: 0, skippedCount: 0, items: [], skipped: [],
        }
      }
      return await localAuditStatus(ready, args)
    },
    'local-audit-start': async (args) => {
      const ready = localAuditDeps()
      if (ready === null) {
        return {
          ...localAuditUnwired, handoffId: '', prompt: '',
          providedCount: 0, skippedCount: 0, expiresAt: 0, workspacePath: '', casePath: '', files: [], skipped: [],
        }
      }
      // 顺手清一次过期快照：准备新的一轮时正是清理旧的时候。
      await ready.registry.sweep(ready.io).catch(() => undefined)
      return await localAuditStart(ready, args)
    },
    /**
     * 认领。`sessionId` 由**客户端**提交（它刚创建了那条会话，这是它自己的事实），
     * Tool 侧走的是 `crwu_audit_local_claim`（身份来自 Agent，不经过这里）。
     */
    'local-audit-claim': async (args) => {
      const ready = localAuditDeps()
      if (ready === null) {
        return { ...localAuditUnwired, casePath: '', fileCount: 0, skippedCount: 0, files: [], skipped: [] }
      }
      return await localAuditClaim(ready, args)
    },
  }
}
