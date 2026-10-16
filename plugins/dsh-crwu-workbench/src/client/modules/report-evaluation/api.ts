import { rpc } from '../../core/rpc.ts'
import type { ValuationMethod } from '../../../shared/contracts/report-evaluation.ts'

/**
 * 报告评估（房地产估值）的**业务 API**（协议 35）。
 *
 * 直接走底层 `rpc()`，不经 `modules/report-audit/api.ts`：那是**报告审核**模块的门面，
 * 让估值模块依赖它，等于把两个业务的契约捆在一起（改审核的门面会牵动估值页）。
 * 操作名与 Host 的六个操作逐字对应，两侧对账由冻结清单（`frozen-inventory.mjs`）保证。
 *
 * ## 每一个在途请求都带 `AbortSignal`
 *
 * 用户切目录 / 换输入时，在途的扫描、预检、准备确认都必须能**作废**：
 * 迟到的响应回来时页面已经换了，落地它就会把新输入覆盖成旧结论。
 * 发号（controller 的 generation）与中止（这里的 signal）是同一件事的两半。
 *
 * ## `baseDate` / `purpose` / `valueType` 都是契约的一部分
 *
 * 未选择时传空串；Host 归一化成 `null` 并原样冻结 —— 客户端不许拿资料里的日期或用途补一个。
 * 评估目的与价值类型**没有可选值枚举**：口径清单属于业务规范，界面只提交用户原文。
 */

export interface RpcOptions {
  signal?: AbortSignal
}

export const valuationApi = {
  filesScan: (args: { paths: string[]; excluded?: string[] }, options: RpcOptions = {}) =>
    rpc('valuation-files-scan', args, options),
  /** 归档预览（确认抽屉的数据源）：**不提取、不联网、不拉知识**。 */
  intake: (args: {
    requestId: string
    paths: string[]
    excluded?: string[]
    /** 用户选定的资产类型（稳定业务标识；未选时 Host 直接拒绝预览）。 */
    assetType: string
    method: ValuationMethod
    baseDate: string
    /** 评估目的（空串 = 未指定）。 */
    purpose?: string
    /** 价值类型（空串 = 未指定）。 */
    valueType?: string
    supplementalPrompt?: string
  }, options: RpcOptions = {}) => rpc('valuation-intake', args, options),
  browserPreflight: (options: RpcOptions = {}) => rpc('valuation-browser-preflight', {}, options),
  /** 点登录**立刻**拉起可见浏览器；不在前端串行探测三个站点。 */
  browserLogin: (args: { siteId: string }, options: RpcOptions = {}) =>
    rpc('valuation-browser-login', args, options),
  browserLoginCancel: (args: { jobId: string }) => rpc('valuation-browser-login-cancel', args),
  /**
   * 打开**受控的验证窗口**（协议 37）。
   *
   * 只提交 `siteId`：受保护页地址与浏览器 profile 都由 Host 从可信站点清单取，
   * Client 提交不了任意 URL（也就没法把员工的浏览器导航到别处）。
   */
  browserOpenVerification: (args: { siteId: string }, options: RpcOptions = {}) =>
    rpc('valuation-browser-open-verification', args, options),
  /**
   * 项目续跑（协议 38 / P18）：插件实例重建后，用 `projectId` 把同一条会话的项目归属绑回来。
   *
   * 只提交 `projectId`；目录、会话与工作区都由 Host 自己核对与派生。
   */
  projectResume: (args: { projectId: string }, options: RpcOptions = {}) =>
    rpc('valuation-project-resume', args, options),
  /** 交接父会话：条件全部由 Host 从预览读，客户端只回确认摘要。 */
  start: (args: { previewId: string; confirmedInputDigest: string; requestId: string }) =>
    rpc('valuation-start', args),
}

/**
 * 估值 API 方法 → Host 操作名。
 *
 * 估值不再借报告审核门面（`modules/report-audit/api.ts`）登记操作：那份门面只留审核操作，
 * 估值操作清单的唯一事实源在这里。冻结清单对账（`host-operations` / `client-rpc-facade` /
 * `host-package`）把这份映射与审核门面的 `OPERATION_OF` 合并后一起核对。
 */
export const VALUATION_OPERATION_OF = {
  filesScan: 'valuation-files-scan',
  intake: 'valuation-intake',
  browserPreflight: 'valuation-browser-preflight',
  browserLogin: 'valuation-browser-login',
  browserLoginCancel: 'valuation-browser-login-cancel',
  browserOpenVerification: 'valuation-browser-open-verification',
  projectResume: 'valuation-project-resume',
  start: 'valuation-start',
} as const satisfies Record<keyof typeof valuationApi, string>
