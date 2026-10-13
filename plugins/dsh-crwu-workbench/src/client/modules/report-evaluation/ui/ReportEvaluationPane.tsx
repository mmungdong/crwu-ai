import * as React from 'react'
import { ValuationIntakePane } from './ValuationIntakePane.tsx'
import { ValuationConfirmationDrawer } from './ValuationConfirmationDrawer.tsx'
import { ValuationProgressPane } from './ValuationProgressPane.tsx'
import { ValuationResultPane } from './ValuationResultPane.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import { phaseHintOf, showsConfirmationDrawer, showsIntakeForm, type ValuationPageState } from '../model/valuation-state.ts'

/**
 * 「报告评估 → 房地产估值」的模块外壳（协议 32，方案 §5）。
 *
 * ```text
 * 环境检查 → 上传资料 → 资料提取 → 只读确认抽屉 → 用户确认 → 自动运行 → 结果
 * ```
 *
 * ## 它是**哑**的：只按阶段选择显示哪一块
 *
 * 所有状态与动作都由 controller 提供（`ReportEvaluationController`）。这样"只读确认抽屉"
 * 这件事只有一处判据：阶段是 `confirmation` 时才渲染抽屉，而抽屉的 props 里没有任何
 * `onChange` —— 输入在那一刻已经冻结。
 *
 * ## 环境门禁不在这里
 *
 * 它由统一的导航层负责（`module-store` 的 `navigate`）：环境没就绪时根本进不到这一页。
 * 页面自己再判一次会与导航层分叉（"点得进来、进来又说不行"）。
 */

export interface ReportEvaluationController {
  getState: () => ValuationPageState
  subscribe: (listener: (state: ValuationPageState) => void) => () => void
  pickFiles: () => void
  pickFolder: () => void
  removeSelection: (path: string) => void
  setMethod: (method: ValuationPageState['method']) => void
  setBaseDate: (value: string) => void
  setPrompt: (value: string) => void
  start: () => void
  /** 提取中「取消提取」：作废在途请求并回到可编辑的草稿态。 */
  cancelIntake: () => void
  backToEdit: () => void
  confirm: () => void
  cancel: () => void
  recheck: () => void
  openLogin: (providerId: string) => void
  openArtifact: (name: string) => void
  /**
   * 问一次轮次状态（宿主为准）。
   *
   * 它由**工作台面板**的定时器调用，而不是页面自己：用户切到别的目录时这一页会卸载，
   * 而"正在跑的估值不能因为切目录被取消 / 阶段要能自己走到完成"要求轮询活在页面之外。
   */
  poll: () => void
}

export interface ReportEvaluationPaneProps {
  controller: ReportEvaluationController
}

export function ReportEvaluationPane(props: ReportEvaluationPaneProps): React.ReactElement {
  const controller = props.controller
  const state = React.useSyncExternalStore
    ? React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
    : useFallbackState(controller)

  const showingForm = showsIntakeForm(state.phase)

  return <div className="crwu-valuation">
    {/* 页面标题与那句简短说明由**面板按导航元数据**渲染（估值 / 房地产 → 「房地产估值」）。
        这一页只留"现在处在哪个阶段"这一行 —— 写死一个抬头正是用户点掉的东西。 */}
    <p className="crwu-valuation-phase" data-valuation-phase={state.phase}>{phaseHintOf(state.phase)}</p>

    {state.phase === 'stale-host'
      ? <p className="crwu-valuation-error">{zhCN.valuationPhaseStale}</p>
      : null}

    {/* 输入工作面：草稿、提取中、失败回退都停在**同一个**表单上（不在阶段之间重建页面）。
        `extracting` 也要渲染它：进度区与「取消提取」就长在它里面。 */}
    {showingForm
      ? <ValuationIntakePane
        state={state}
        onPickFiles={controller.pickFiles}
        onPickFolder={controller.pickFolder}
        onRemoveSelection={controller.removeSelection}
        onMethodChange={controller.setMethod}
        onBaseDateChange={controller.setBaseDate}
        onPromptChange={controller.setPrompt}
        onStart={controller.start}
        onCancelIntake={controller.cancelIntake}
      />
      : null}

    {state.intake === null ? null : <ValuationConfirmationDrawer
      open={showsConfirmationDrawer(state.phase)}
      intake={state.intake}
      method={state.method}
      providerCheck={state.providerCheck}
      providerStates={state.providerStates}
      onBack={controller.backToEdit}
      onConfirm={controller.confirm}
      onRecheck={controller.recheck}
      onOpenLogin={controller.openLogin}
    />}

    {state.phase === 'queued' || state.phase === 'running' || state.phase === 'browser-login-required'
      ? <ValuationProgressPane
        state={state}
        onOpenLogin={controller.openLogin}
        onRecheck={controller.recheck}
        onCancel={controller.cancel}
      />
      : null}

    {/* 结果页在**有结果时**就渲染：`completed` 是正式结论，失败 / 取消但有交付件时是
        「部分结果」（结果页自己会打上标记）。没有结果的失败只显示上面的错误与可执行动作。 */}
    {state.result === null ? null : <ValuationResultPane
      state={state}
      onOpenArtifact={controller.openArtifact}
      onCancel={controller.cancel}
    />}
  </div>
}

/**
 * 没有 `useSyncExternalStore` 时的退路（注入式渲染器/更老的 React）。
 *
 * 它**只在挂载时读一次**：这类宿主本来就不会有异步状态推进（测试与静态渲染），
 * 有它就能渲染，而不是让整页因为一个未定义的方法崩掉。
 */
function useFallbackState(controller: ReportEvaluationController): ValuationPageState {
  const [state, setState] = React.useState(controller.getState)
  React.useEffect(() => controller.subscribe(setState), [controller])
  return state
}
