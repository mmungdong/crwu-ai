import { rpc } from '../../core/rpc.ts'

/**
 * 报告评估（房地产估值）的**业务 API**（协议 32）。
 *
 * 直接走底层 `rpc()`，不经 `modules/report-audit/api.ts`：那是**报告审核**模块的门面，
 * 让估值模块依赖它，等于把两个业务的契约捆在一起（改审核的门面会牵动估值页）。
 * 操作名与 Host 的八个操作逐字对应，两侧对账由冻结清单（`frozen-inventory.mjs`）保证。
 *
 * `baseDate` 是**契约的一部分**（§11.5）：未选择时传空串，客户端不许拿资料里的日期补一个。
 *
 * 与门面里的 `valuation*` 方法同一批操作：门面负责"Host 有没有这条操作"的对账，
 * 这里负责"这一页怎么调它"。两处都不是各自编名字 —— 名字只写在这里一次。
 */
export const valuationApi = {
  filesScan: (args: { paths: string[] }) => rpc('valuation-files-scan', args),
  intake: (args: { valuationId: string; method: string; baseDate: string; supplementalPrompt?: string; paths: string[] }) =>
    rpc('valuation-intake', args),
  browserPreflight: (args: { openLogin?: string }) => rpc('valuation-browser-preflight', args),
  start: (args: {
    valuationId: string
    method: string
    baseDate: string
    supplementalPrompt: string
    confirmedSnapshotDigest: string
  }) => rpc('valuation-start', args),
  status: (args: { valuationId: string }) => rpc('valuation-status', args),
  cancel: (args: { valuationId: string }) => rpc('valuation-cancel', args),
  result: (args: { valuationId: string }) => rpc('valuation-result', args),
  openArtifact: (args: { valuationId: string; name: string }) => rpc('valuation-open-artifact', args),
}
