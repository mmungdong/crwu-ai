import * as React from 'react'
import { Button } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 插件级**授权门槛**。
 *
 * 为什么是弹框而不是"环境自检里的一行勾选框"（用户 2026-09-22 定的口径）：本插件要读本机凭据
 * （氚云会话 + 钉钉登录态）才能干活，没授权就取不到待办、发不出钉钉回传 —— 这是**硬前置**，
 * 不是"某个检查项没配好"。摆在检查列表里，员工会以为可以绕过、或者根本不知道要点。
 *
 * 三种状态：
 *   1. 未授权 + 没拒绝过 → 模态弹框挡住整个面板（遮罩 + 居中卡片），同意/拒绝二选一；
 *   2. 点了拒绝（**不落盘**，下次打开页面还会再问）→ 换成一屏说明 + 「再次授权」；
 *   3. 已授权 → 本组件不渲染（面板照常）。
 *
 * 键盘：Esc 等于拒绝；主按钮在 DOM 里靠前，Enter 即同意。
 */
export interface AuthorizationGateProps {
  declined: boolean
  busy: boolean
  error: string
  onAgree: () => void
  onDecline: () => void
  onRegrant: () => void
}

/** 三件必须讲清的事：要什么 / 为什么 / 不会做什么。 */
function Points(): React.ReactElement {
  return <>
    <div className={C.authSection}>{zhCN.authWhatLabel}</div>
    <div className={C.authText}>{zhCN.authWhat}</div>
    <div className={C.authSection}>{zhCN.authWhyLabel}</div>
    <div className={C.authText}>{zhCN.authWhy}</div>
    <div className={C.authSection}>{zhCN.authNoLabel}</div>
    <div className={C.authText}>{zhCN.authNo}</div>
  </>
}

export function AuthorizationGate(props: AuthorizationGateProps): React.ReactElement {
  if (props.declined) {
    return <div className={C.authBlocked}>
      <div className={C.authCard}>
        <div className={C.authTitle}>{zhCN.authDeclinedTitle}</div>
        <div className={C.authLead}>{zhCN.authDeclinedLead}</div>
        <Points />
        {props.error === '' ? null : <div className={C.error}>{props.error}</div>}
        <div className={C.authActions}>
          <Button label={zhCN.authRegrant} tone="primary" disabled={props.busy} onClick={props.onRegrant} />
        </div>
      </div>
    </div>
  }
  return <div
    className={C.authMask}
    role="dialog"
    aria-modal="true"
    aria-label={zhCN.authTitle}
    onKeyDown={(event) => {
      // Esc 视同拒绝：弹框只有这两个出口，键盘用户不该被困住。
      if ((event as { key?: string }).key === 'Escape') props.onDecline()
    }}
  >
    <div className={C.authCard}>
      <div className={C.authTitle}>{zhCN.authTitle}</div>
      <div className={C.authLead}>{zhCN.authLead}</div>
      <Points />
      {props.error === '' ? null : <div className={C.error}>{props.error}</div>}
      <div className={C.authActions}>
        <Button
          label={props.busy ? zhCN.authAgreeBusy : zhCN.authAgree}
          tone="primary"
          disabled={props.busy}
          onClick={props.onAgree}
        />
        <Button label={zhCN.authDecline} disabled={props.busy} onClick={props.onDecline} />
      </div>
    </div>
  </div>
}
