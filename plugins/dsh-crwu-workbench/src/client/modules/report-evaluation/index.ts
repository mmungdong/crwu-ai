import { pickFilesFromInput, type DirectoryPicker, type FilePicker } from '../local-audit/pick.ts'
import { valuationApi } from './api.ts'
import { createReportEvaluationController, type ReportEvaluationController, type ValuationPort } from './controller.ts'

/**
 * 报告评估模块的**组装入口**：把 RPC、本机选择器与控制器接起来。
 *
 * 选择器复用本地审核那一套（`modules/local-audit/pick.ts`）：浏览器拿不到绝对路径，
 * 必须走宿主原生对话框。两套各写一遍迟早会在"回什么形状的路径"上分叉。
 */
export interface ReportEvaluationServices extends DirectoryPicker, FilePicker {
  /** 环境 / 授权门禁（未就绪时不起估值）。 */
  ready?: () => { ok: boolean; error: string }
}

export function createReportEvaluationPaneController(services: ReportEvaluationServices): ReportEvaluationController {
  // ⚠️ **不能 `...services` 展开**：展开会把 capability 上的 getter **求值一次**并固化，
  // 于是"能力晚一点才注册"就变成永远不可用（本仓踩过三次）。这里逐条**转发**，
  // 读的时刻就是调用的时刻。
  const port: ValuationPort = {
    get hostPaths() { return services.hostPaths },
    get pickDirectory() { return services.pickDirectory },
    fileInput: pickFilesFromInput,
    scan: (input) => valuationApi.filesScan(input),
    intake: (input) => valuationApi.intake(input),
    preflight: (input) => valuationApi.browserPreflight(input),
    start: (input) => valuationApi.start(input),
    status: (input) => valuationApi.status(input),
    cancel: (input) => valuationApi.cancel(input),
    result: (input) => valuationApi.result(input),
    openArtifact: (input) => valuationApi.openArtifact(input),
    ...(services.ready === undefined ? {} : { ready: services.ready }),
  }
  return createReportEvaluationController(port)
}

export { pickFilesFromInput }
export type { ReportEvaluationController, ValuationPort }
export { ReportEvaluationPane } from './ui/ReportEvaluationPane.tsx'
export type { ReportEvaluationPaneProps } from './ui/ReportEvaluationPane.tsx'
export * from './model/valuation-state.ts'
