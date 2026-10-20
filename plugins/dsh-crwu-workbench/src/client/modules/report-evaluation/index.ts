import { pickFilesFromInput, type DirectoryPicker, type FilePicker } from '../local-audit/pick.ts'
import { valuationApi } from './api.ts'
import { openValuationSession } from './session/open-session.ts'
import {
  createReportEvaluationController,
  type ReportEvaluationController,
  type ValuationPort,
} from './controller.ts'
import type { ValuationPageState } from './model/valuation-state.ts'
import type { ClientServices } from '../../shell/services.ts'
import {
  createValuationWorkflowController,
  type ValuationWorkflowController,
  type ValuationWorkflowPort,
} from './workflow-controller.ts'
import type { ValuationHandoffView } from '../../../shared/contracts/report-evaluation.ts'

/**
 * 报告评估模块的**组装入口**：把 RPC、本机选择器、会话跳转与控制器接起来。
 *
 * 选择器复用本地审核那一套（`modules/local-audit/pick.ts`）：浏览器拿不到绝对路径，
 * 必须走宿主原生对话框。两套各写一遍迟早会在"回什么形状的路径"上分叉。
 *
 * ## 服务一律**现读**
 *
 * ⚠️ **不能 `...services` 展开**：展开会把 capability 上的 getter **求值一次**并固化，
 * 于是"能力晚一点才注册"就变成永远不可用（本仓踩过三次）。所以端口与适配器都逐条转发，
 * 读的时刻就是调用的时刻 —— `uiWorkspace` / `layout` 尤其如此（它们比本插件晚注册是常态）。
 */
export interface ReportEvaluationServices extends DirectoryPicker, FilePicker {
  /** 环境 / 授权门禁（未就绪时不起估值）。 */
  ready?: () => { ok: boolean; error: string }
  /** 打开父会话用的两个客户端服务（现读）。 */
  uiWorkspace?: ClientServices['uiWorkspace']
  layout?: ClientServices['layout']
}

/**
 * 把"活的"选择器能力与会话服务合成估值页要的服务对象。
 *
 * 单独一个函数是为了让**两个装配点**（`apply.ts` 与 `WorkbenchPanel` 的兜底）用同一份转发，
 * 而不是各自手写一遍 getter —— 手写那两处只要有一处漏了 getter，就会退化成装配时快照。
 */
export function reportEvaluationPaneServices(
  pickers: DirectoryPicker & FilePicker & { ready?: () => { ok: boolean; error: string } },
  client: () => Pick<ClientServices, 'uiWorkspace' | 'layout'>,
): ReportEvaluationServices {
  return {
    get hostPaths() { return pickers.hostPaths },
    get pickDirectory() { return pickers.pickDirectory },
    get fileInput() { return pickers.fileInput },
    get ready() { return pickers.ready },
    get uiWorkspace() { return client().uiWorkspace },
    get layout() { return client().layout },
  }
}

export function createReportEvaluationPaneController(
  services: ReportEvaluationServices,
  /**
   * 起始状态（只在用例 / 特殊装配里给；页面正常从"正在检查门禁"开始）。
   *
   * `onHandoff`：交接被 Host 接受后**留在工作流里**。生产装配把它接到同一个
   * workflow controller 的 `refresh()`；没有这个回调的旧调用方保持"立刻打开父会话"的旧行为。
   */
  options: {
    initial?: Partial<ValuationPageState>
    onHandoff?: (receipt: ValuationHandoffView) => void | Promise<void>
  } = {},
): ReportEvaluationController {
  const port: ValuationPort = {
    get hostPaths() { return services.hostPaths },
    get pickDirectory() { return services.pickDirectory },
    fileInput: pickFilesFromInput,
    scan: (input, options) => valuationApi.filesScan(input, options),
    intake: (input, options) => valuationApi.intake(input, options),
    preflight: (_input, options) => valuationApi.browserPreflight(options),
    login: (input, options) => valuationApi.browserLogin(input, options),
    loginCancel: (input) => valuationApi.browserLoginCancel(input),
    verificationWindow: (input, options) => valuationApi.browserOpenVerification(input, options),
    start: (input) => valuationApi.start(input),
    // 父会话由统一会话服务打开（**不是** openSubagent）：服务现读，注册顺序不影响。
    openSession: (sessionId) => openValuationSession({
      get uiWorkspace() { return services.uiWorkspace },
      get layout() { return services.layout },
    }, sessionId),
    ...(services.ready === undefined ? {} : { ready: services.ready }),
  }
  return createReportEvaluationController(port, options)
}

/**
 * 图工作流的客户端端口：每个方法对应一个同源 `valuation-workflow-*` 操作。
 *
 * 只有 `rpc` 一条网络出口；端口本身不持有状态，状态由 controller 管。
 */
export function valuationWorkflowPort(): ValuationWorkflowPort {
  return {
    current: (input, options) => valuationApi.workflowCurrent(input, options),
    node: (input, options) => valuationApi.workflowNode(input, options),
    action: (input, options) => valuationApi.workflowAction(input, options),
    preview: (input, options) => valuationApi.workflowPreview(input, options),
    cancel: (input, options) => valuationApi.workflowCancel(input, options),
    export: (input, options) => valuationApi.workflowExport(input, options),
    load: (input, options) => valuationApi.workflowLoad(input, options),
    clear: (input, options) => valuationApi.workflowClear(input, options),
    reconcile: (input, options) => valuationApi.workflowReconcile(input, options),
    openArtifact: (input, options) => valuationApi.workflowOpenArtifact(input, options),
  }
}

export { createValuationWorkflowController }
export type {
  ValuationWorkflowController,
  ValuationWorkflowControllerState,
  ValuationWorkflowPort,
} from './workflow-controller.ts'
export { pickFilesFromInput }
export type { ReportEvaluationController, ValuationPort }
export { ReportEvaluationPane } from './ui/ReportEvaluationPane.tsx'
export type { ReportEvaluationPaneProps } from './ui/ReportEvaluationPane.tsx'
export { AssetAssessmentWorkflow } from './ui/AssetAssessmentWorkflow.tsx'
export type { AssetAssessmentWorkflowProps, AssetWorkflowStep } from './ui/AssetAssessmentWorkflow.tsx'
export * from './model/valuation-state.ts'
