import * as React from 'react'
import { Card } from '../../../ui/primitives.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import { phaseHintOf, type ValuationPageState } from '../model/valuation-state.ts'

/**
 * 进度页（`queued` / `running` / `browser-login-required`）。
 *
 * ## 绝不伪造进度
 *
 * 进度只来自 Host 的 `valuation-status`（`progress.completed / total`）。没有结论时这里
 * 显示阶段说明而不是一条假进度条 —— 方案明确要求"页面不会伪造进度"。
 * `total === 0`（宿主没给总数）时**不画进度条**，只写文字阶段。
 *
 * ## 登录是外部动作，不是改输入
 *
 * `browser-login-required` 时给出"在默认浏览器登录"与"重新检查并继续"两个动作。
 * 前者只打开来源的公开登录页（会话由浏览器自己保持，插件不读 Cookie、不存密码）；
 * 后者重新跑一次检索。两者都**不修改**本轮的冻结输入。
 */

export interface ValuationProgressPaneProps {
  state: ValuationPageState
  onOpenLogin: (providerId: string) => void
  onRecheck: () => void
  onCancel: () => void
}

export function ValuationProgressPane(props: ValuationProgressPaneProps): React.ReactElement {
  const { state } = props
  const { progress } = state
  const percent = progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)))
    : 0

  return <div className="crwu-valuation-progress">
    <Card title={zhCN.valuationProgressTitle}>
      <p className="crwu-valuation-phase">{phaseHintOf(state.phase)}</p>
      {progress.stage === '' ? null : <p className="crwu-valuation-stage">{progress.stage}{progress.detail === '' ? '' : ` · ${progress.detail}`}</p>}
      {progress.total > 0 ? <div
        className="crwu-valuation-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
        aria-label={zhCN.valuationProgressTitle}
      >
        <div className="crwu-valuation-bar-fill" style={{ width: `${String(percent)}%` }} />
      </div> : null}
      {progress.total > 0 ? <p className="crwu-valuation-hint">{progress.completed} / {progress.total}</p> : null}
      <p className="crwu-valuation-hint">{zhCN.valuationNoFakeProgress}</p>
    </Card>

    {Object.keys(state.providerStates).length === 0 ? null : <Card title={zhCN.valuationDrawerProviders}>
      <ul className="crwu-valuation-providers">
        {Object.entries(state.providerStates).map(([id, item]) => <li key={id}>
          <span>{id}</span>
          <span>{item.state}</span>
          <span className="crwu-valuation-hint">{item.attempts} 次尝试</span>
          {item.detail === '' ? null : <span className="crwu-valuation-hint">{item.detail}</span>}
        </li>)}
      </ul>
    </Card>}

    {state.phase === 'browser-login-required' ? <Card title={zhCN.valuationLoginTitle}>
      <p className="crwu-valuation-phase">{zhCN.valuationPhaseLogin}</p>
      <div className="crwu-valuation-actions">
        {state.needsLogin.map((id) => <button
          key={id}
          type="button"
          className="crwu-valuation-btn"
          onClick={() => { props.onOpenLogin(id) }}
        >
          {zhCN.valuationLoginAction}（{id}）
        </button>)}
        <button type="button" className="crwu-valuation-btn crwu-valuation-btn-primary" onClick={props.onRecheck}>
          {zhCN.valuationRecheck}
        </button>
      </div>
    </Card> : null}

    {state.error === '' ? null : <p className="crwu-valuation-error">{state.error}</p>}
    <div className="crwu-valuation-actions">
      <button type="button" className="crwu-valuation-btn" onClick={props.onCancel}>{zhCN.valuationResultCancel}</button>
    </div>
  </div>
}
