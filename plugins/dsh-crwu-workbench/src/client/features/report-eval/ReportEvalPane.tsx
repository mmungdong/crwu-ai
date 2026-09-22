import * as React from 'react'
import { DocSparkIcon } from '../../components/icons.tsx'
import { zhCN } from '../../locales/zh-CN.ts'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'

/**
 * 「报告评估」的 Coming Soon 页（用户 2026-09-22 重新设计）。
 *
 * 口径：这是**中瑞世联 AI 工作台里一个规划中的正式模块**，不是"功能没写完"的占位。
 * 所以这一页要回答四件事，且只回答这四件：
 *   1. 这是什么模块 —— 功能图形 + 模块名（`报告评估`）；
 *   2. 它将来做什么 —— 一句 `AI 辅助资产评估工作流` + 一句最短说明；
 *   3. 它现在能不能用 —— 一枚 `● 开发中` 的**状态**（不是按钮、不是大胶囊）；
 *   4. 现在该去哪 —— 「目前可以继续使用」+ 一个文本动作 `报告审核 →`。
 *
 * 四条硬约束（都是用户点名的"不要做"）：**不套 Card / 不加边框 / 不做假进度 / 不编功能清单**
 * （业务定义还没定，编出来的三个功能卡片就是假信息）。留白靠排版给，不靠堆组件。
 * 功能图形带极轻的呼吸动画；整块内容入场 240ms 淡入上移；`prefers-reduced-motion` 下都停掉。
 */
export interface ReportEvalPaneProps {
  /** 切到「报告审核」（模块切换由模块 store 负责，这里只发一个意图）。 */
  onGoAudit?: () => void
}

export function ReportEvalPane(props: ReportEvalPaneProps): React.ReactElement {
  return <div className={C.eval}>
    <div className={C.evalInner}>
      <span className={C.evalIcon} aria-hidden={true}><DocSparkIcon size={26} /></span>
      <h2 className={C.evalTitle}>{zhCN.evalTitle}</h2>
      <div className={C.evalSubtitle}>{zhCN.evalSubtitle}</div>
      <p className={C.evalDesc}>{zhCN.evalDesc}</p>
      <div className={C.evalStatus}>
        <span className={C.evalDot} aria-hidden={true} />
        {zhCN.evalStatus}
      </div>
      <div className={C.evalNext}>
        <div className={C.evalNextLead}>{zhCN.evalAvailableLead}</div>
        <button
          type="button"
          className={C.evalLink}
          onClick={() => { props.onGoAudit?.() }}
        >
          {zhCN.evalGoAudit}
          <span className={C.evalArrow} aria-hidden={true}>→</span>
        </button>
      </div>
    </div>
  </div>
}
