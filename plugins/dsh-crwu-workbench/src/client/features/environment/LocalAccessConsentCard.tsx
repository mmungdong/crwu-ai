import * as React from 'react'
import { Button, Chip, Notice, StatusDot } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import type { LocalAccessCapability, LocalAccessConsentView } from '../../../shared/access/types.ts'
import { consentCapabilities } from './local-access.ts'

/**
 * 本机访问授权卡（协议 18）。
 *
 * ## 为什么是一张卡、不是一个模态层
 *
 * 产品口径（2026-09-26 起，本次沿用）：授权**放在「账号连接」这一步里**，不许用一个遮住整页的
 * 模态框。原因不是审美：模态层会挡住「我到底允许了什么」的上下文，也让"暂不允许"看起来像
 * 把整个插件关掉了 —— 实际上未授权时工作台照常显示环境信息，只是账号、审核与交付保持禁用。
 *
 * ## 三条不许退回去的口径
 *
 * 1. **逐条列出能力**（五项，与收据里的 capability 一一对应）。旧文案是一句「信任本插件读取
 *    本机凭据」+ 一个开关，员工根本不知道自己同意了写 `~/.ossutilconfig`、写 `.dws`、
 *    执行三个二进制这些事；
 * 2. **按钮说的是动作**：「允许并继续」/「暂不允许」，不是「确定 / 取消」——
 *    后者读起来像在关一个对话框；
 * 3. **已允许时给撤销入口**，并显示允许时间。收据能撤销才叫「可撤销的同意」。
 */

export interface LocalAccessConsentCardProps {
  consent: LocalAccessConsentView
  busy: boolean
  /** 上一次操作的失败原因（Host 原文）；空串表示没有。 */
  error: string
  declined: boolean
  /** 客户端与宿主的权限说明版本不一致（旧宿主）：一切都禁用并给出重启指引。 */
  schemaMismatch?: boolean
  onGrant: () => void
  onDecline: () => void
  onRevoke: () => void
}

/** capability → 界面文案；缺一项就是漏了一条要展示的授权范围，测试会盯着这里的覆盖。 */
export function capabilityLabel(capability: LocalAccessCapability): string {
  if (capability === 'h3yun-credential-store') return zhCN.envConsentCapH3yun
  if (capability === 'dws-profile') return zhCN.envConsentCapDws
  if (capability === 'oss-config') return zhCN.envConsentCapOss
  if (capability === 'ifind-credential') return zhCN.envConsentCapIfind
  return zhCN.envConsentCapSystem
}

/** 授权态的短标签（Chip 用）。 */
export function consentChipText(consent: LocalAccessConsentView): string {
  if (consent.state === 'granted') return zhCN.envItemOk
  if (consent.state === 'revoked') return zhCN.envConsentRevoke
  return zhCN.envItemMissing
}

function consentNote(consent: LocalAccessConsentView): string {
  if (consent.state === 'granted') return zhCN.envConsentDone
  if (consent.state === 'revoked') return zhCN.envConsentRevoked
  if (consent.state === 'persist-failed') return zhCN.envConsentPersistFailed
  if (consent.state === 'outdated') return consent.reason || zhCN.envConsentOutdated
  return zhCN.envConsentIntro
}

export function LocalAccessConsentCard(props: LocalAccessConsentCardProps): React.ReactElement {
  const { consent } = props
  const granted = consent.state === 'granted'
  const blocked = props.schemaMismatch === true
  // 「暂不允许」之后按钮换成「重新允许一次」：员工拒绝过，就不要再用同一句话问他一遍。
  const agreeLabel = props.declined ? zhCN.envConsentRegrant : zhCN.envConsentAgree

  return <div className={C.item} data-crwu-env-item="consent" data-crwu-consent-state={consent.state}>
    <StatusDot tone={granted ? 'ok' : 'bad'} />
    <div className={C.itemMain}>
      <div className={C.itemHead}>
        <span className={C.itemName}>{zhCN.envConsentTitle}</span>
        <Chip text={consentChipText(consent)} tone={granted ? 'ok' : 'bad'} />
      </div>

      <div className={C.itemNote} data-crwu-consent-note="1">{consentNote(consent)}</div>

      {granted
        ? null
        : <div data-crwu-consent-scope="1">
            <div className={C.itemNote}>{zhCN.envConsentScopeTitle}</div>
            <ul className={C.muted}>
              {consentCapabilities().map((capability) => <li key={capability}>{capabilityLabel(capability)}</li>)}
            </ul>
          </div>}

      {granted
        ? <div className={C.itemNote}>
            {zhCN.envConsentGrantedAt}：{consent.grantedAt}
          </div>
        : <div className={C.itemNote}>{zhCN.envConsentBoundary}</div>}

      {props.error === '' ? null : <Notice tone="warn">{props.error}</Notice>}
      {!granted && props.declined ? <Notice tone="warn">{zhCN.envConsentDeclined}</Notice> : null}
      {blocked ? <Notice tone="warn">{zhCN.envConsentSchemaMismatch}</Notice> : null}

      <div className={C.row}>
        {granted
          ? <Button
              label={zhCN.envConsentRevoke}
              small
              disabled={props.busy || blocked}
              onClick={props.onRevoke}
            />
          : <Button
              label={agreeLabel}
              tone="primary"
              disabled={props.busy || blocked}
              onClick={props.onGrant}
            />}
        {!granted && !props.declined
          ? <Button label={zhCN.envConsentDecline} small disabled={props.busy} onClick={props.onDecline} />
          : null}
        {props.busy ? <span className={C.muted}>{zhCN.envConsentBusy}</span> : null}
      </div>
    </div>
  </div>
}
