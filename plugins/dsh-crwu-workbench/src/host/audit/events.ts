import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import type { WorkbenchState } from '../state/types.ts'

/**
 * 子代理生命周期事件 → 审核记录。
 *
 * **为什么必须有这个订阅**（不是「轮询也能凑合」）：
 * `ended` 与 `endReason` 只有这里会写，而下游有两处依赖它们：
 * 1. `assessAudit` 用 `endReason` 区分「正常跑完但还没扫到交付件」（idle）与「中断/超 token」
 *    （failed）。没有这个订阅，**「已中断」这个状态永远不会出现**，一次报错的审核会一直显示
 *    「未出结果」；
 * 2. `runUploadWatch` 只处理「当前活动的」或 `ended === true` 的记录。没有这个订阅，
 *    一次正常跑完的审核永远进不了自动上传队列 —— **「交付件自动上云」整个功能不会生效**。
 *
 * 这两个后果都是静默的：没有报错，只有「该出现的东西没出现」。
 *
 * 事件契约（对照 `@deepseek-ai/dsh-subagent` / `@deepseek-ai/dsh-agent` 的类型）：
 * - `subagent/end(info)`：`info.id` 是子会话 id，`info.stopReason` 是终止原因；
 * - `agent/status(payload)`：`payload.agent` + `payload.status`（`'idle' | 'running'`）。
 *
 * 用 `ctx.on` 订阅（Cordis 的监听器随 fiber 释放），不要自己存句柄。
 */
export function subscribeAuditEvents(ctx: Context, state: WorkbenchState): void {
  const agents = ctx.get('agents')
  if (agents !== undefined) {
    ctx.on('agent/status', (payload: { agent?: { id?: unknown }; status?: unknown }) => {
      const id = text(payload?.agent?.id)
      if (id === '') return
      const running = payload?.status === 'running'
      for (const [key, record] of Object.entries(state.audits)) {
        // 已结束的记录不再被状态事件改写：事件可能晚于 subagent/end 到达。
        if (record.childId !== id || record.ended === true) continue
        state.audits[key] = { ...record, status: running ? 'running' : 'idle' }
      }
    })
  }

  ctx.on('subagent/end', (info: { id?: unknown; childId?: unknown; stopReason?: unknown }) => {
    const id = text(info?.childId) || text(info?.id)
    if (id === '') return
    // 拿不到原因时按 error 处理：宁可在界面上提示「已中断」，也不要假装正常跑完。
    const reason = text(info?.stopReason) || 'error'
    for (const [key, record] of Object.entries(state.audits)) {
      if (record.childId !== id) continue
      state.audits[key] = {
        ...record,
        ended: true,
        endReason: reason,
        // 正常跑完 → idle（等扫描把交付件找出来再升级成 done）；
        // 被用户停过的保持 stopped（那是用户的明确动作，优先于这里推断）。
        status: record.stopped === true ? 'stopped' : 'idle',
      }
    }
  })
}
