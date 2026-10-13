import { rpc } from '../../core/rpc.ts'
import type { LocalAuditScanView, LocalAuditStartView } from '../../../shared/contracts/local-audit.ts'

/**
 * **本地审核**模块的业务 API（协议 32 · Task 3）。
 *
 * 与其它模块同一条口径：模块自己的操作写在自己的 `api.ts` 里，不借报告审核的门面。
 * 借门的后果不是"多一层"，而是**改审核门面会牵动本地审核页**，而这两件事在业务上没有关系。
 */

async function call<T>(operation: string, args?: unknown): Promise<T> {
  return await rpc(operation, args ?? {}) as unknown as T
}

export const localAuditApi = {
  /** 展开一次本机选择（递归、去重、大小、可读性、是否超限），只回事实。 */
  status: (input: { selection: string[]; excluded?: string[] }) =>
    call<LocalAuditScanView>('local-audit-status', input),
  /** 建快照并拿一次性 handoff（可复制的固定提示词也在应答里）。 */
  start: (input: { selection: string[]; excluded?: string[]; prompt?: string }) =>
    call<LocalAuditStartView>('local-audit-start', input),
  /** 把 handoff 绑到客户端刚创建的那条会话（Tool 侧走 `crwu_audit_local_claim`）。 */
  claim: (input: { handoffId: string; sessionId: string }) =>
    call<{ ok?: boolean; error?: string }>('local-audit-claim', input),
}
