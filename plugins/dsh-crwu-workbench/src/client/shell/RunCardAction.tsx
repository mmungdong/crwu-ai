import * as React from 'react'
import { Button } from '../ui/primitives.tsx'
import { WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../locales/zh-CN.ts'
import { workbenchApi } from '../modules/report-audit/api.ts'
import { CRWU_SCOPE_PROPS } from '../styles/scope.ts'

/**
 * Cordis 运行卡片里的动作区（`tool.view.cordis` 槽位）。
 *
 * 两件事，都对应 legacy 的行为：
 * 1. **挂载时自动登记当前会话为审核父级** —— 和会话头按钮同一个目的：让用户「看到运行卡片」
 *    就等于「父级登记好了」，不必再去找按钮；
 * 2. 给一个直接跳到面板的入口（用 `layout.selectPanel`，槽位不提供跳转能力，只能问 layout 服务）。
 */

export interface RunCardActionProps {
  sessionId?: string
  /** 由 apply 注入：`ctx.get('layout').selectPanel(name)`。 */
  selectPanel?: (panel: string) => void
}

export function RunCardAction(props: RunCardActionProps): React.ReactElement {
  const sessionId = props.sessionId === undefined ? '' : String(props.sessionId)

  React.useEffect(() => {
    if (sessionId === '') return undefined
    let alive = true
    // 失败静默：这里是顺带登记，用户真正的入口是会话头按钮，不该因为一次竞态就弹错。
    workbenchApi.bindSession({ sessionId })
      .then(() => { void alive })
      .catch(() => { void alive })
    return () => { alive = false }
  }, [sessionId])

  // 运行卡片是**独立挂载点**（不属于工作台面板的 DOM），所以自带插件作用域。
  return <div {...CRWU_SCOPE_PROPS} style={{ padding: '8px 2px' }}>
    <div className={`${C.muted}`} style={{ fontSize: '12px', marginBottom: '8px' }}>{zhCN.runCardSummary}</div>
    <Button
      label={zhCN.openWorkbench}
      tone="primary"
      onClick={() => { props.selectPanel?.('crwu-workbench') }}
    />
  </div>
}
