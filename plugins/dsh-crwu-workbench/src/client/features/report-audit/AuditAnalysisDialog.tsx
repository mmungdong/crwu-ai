import * as React from 'react'
import { Button } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { formatDateTime } from './time.ts'
import type { SnapshotChange } from './audit-freshness.ts'

/**
 * 「AI 审核结果分析会话」建立之前的**版本检查对话框**。
 *
 * 四种情形（用户 §8/§9/§13/§26）：
 *
 * | mode | 什么时候 | 选项 |
 * | --- | --- | --- |
 * | `limited` | 拿不到最新原始报告（核心依赖） | 重试 / 仍以有限资料继续（进入 Limited Context） |
 * | `stale` | 有同源 digest/version/etag 证明内容已变 | 重新 AI 审核 / 仍以当前审核结果分析 / 取消 |
 * | `possibly` | 只有时间关系（报告更新时间晚于审核时间） | 使用最新资料重新分析 / 继续查看原审核上下文 |
 * | `existing` | 已有该报告的分析会话 | 继续上次分析 / 新建分析会话（资料更新时加一句提示） |
 *
 * 三条硬规矩：
 * 1. **不静默进入**：`stale` / `possibly` / `limited` 都必须由用户明确选择；
 * 2. **不用过度确定的语言**：只有强证据才说"已经变化"，纯时间差说"存在更新记录，无法确认是否影响结论"；
 * 3. **不替用户作决定**：`existing` 里检测到更新只**建议**新建，不自动选。
 */

export type AuditAskMode = 'insufficient' | 'stale' | 'possibly' | 'existing'

export interface AuditAskState {
  mode: AuditAskMode
  seqNo: string
  reportUpdatedAt: string
  auditGeneratedAt: string
  reviewUpdatedAt: string
  /** 与上次快照相比发生了什么（没有快照时为 null）。 */
  changes: SnapshotChange | null
  /** 报告当前是否在列表里（决定"重新 AI 审核"能不能点）。 */
  canRestart: boolean
}

export interface AuditAnalysisDialogProps {
  ask: AuditAskState
  busy: boolean
  onRestart: () => void
  /** 以当前审核结果 / 最新资料继续（新建会话，Fresh Snapshot）。 */
  onProceed: () => void
  /** 继续已有会话。 */
  onContinue: () => void
  onRetry: () => void
  onCancel: () => void
}

function timeRow(label: string, value: string): React.ReactElement | null {
  if (value.trim() === '') return null
  return <React.Fragment>
    <div className={C.kvKey}>{label}</div>
    {/* 业务时间保留完整年份（YYYY-MM-DD HH:mm）；原值留在 title 里。 */}
    <div className={C.kvValue}><span className={C.mono} title={value}>{formatDateTime(value)}</span></div>
  </React.Fragment>
}

function headOf(mode: AuditAskMode): { title: string; body: string } {
  // 远端最新资料拿不到：**不 fallback 本地、也不建会话**（用户 2026-09-23 §8/§16）。
  if (mode === 'insufficient') return { title: zhCN.auditRemoteMissingTitle, body: zhCN.auditRemoteMissingBody }
  if (mode === 'stale') return { title: zhCN.auditStaleTitle, body: zhCN.auditStaleBody }
  if (mode === 'possibly') return { title: zhCN.auditPossibleTitle, body: zhCN.auditPossibleBody }
  return { title: zhCN.auditAskExistingTitle, body: zhCN.auditAskExistingBody }
}

export function AuditAnalysisDialog(props: AuditAnalysisDialogProps): React.ReactElement {
  const { ask } = props
  const head = headOf(ask.mode)
  const changes = ask.changes
  const changeLines = changes === null
    ? []
    : [
      changes.report ? zhCN.auditChangeReport : '',
      changes.audit ? zhCN.auditChangeAudit : '',
      changes.review ? zhCN.auditChangeReview : '',
      changes.digest ? zhCN.auditChangeDigest : '',
    ].filter((line) => line !== '')

  /** 选项块：标题 + 说明（与「已有报告会话」那套视觉完全一致）。 */
  const option = (label: string, hint: string, onClick: () => void, primary = false): React.ReactElement =>
    <button
      type="button"
      className={[C.aiDialogOption, primary ? C.aiDialogOptionOn : ''].filter((one) => one !== '').join(' ')}
      disabled={props.busy}
      onClick={onClick}
    >
      <span className={C.aiDialogOptionTitle}>{label}</span>
      <span className={C.aiDialogOptionHint}>{hint}</span>
    </button>

  return <>
    <div className={C.aiDialogBackdrop} onClick={props.busy ? undefined : props.onCancel} />
    <div className={C.aiDialog} role="dialog" aria-modal="true" aria-label={head.title}>
      <div className={C.aiDialogTitle}>{head.title}</div>
      <div className={C.aiDialogBody}>{head.body}</div>

      {/* 版本对照：业务时间一律完整年份（用户 §33）。 */}
      <div className={C.kv} style={{ marginTop: '12px' }}>
        {timeRow(zhCN.auditCtxReportUpdatedAt, ask.reportUpdatedAt)}
        {timeRow(zhCN.auditCtxAuditGeneratedAt, ask.auditGeneratedAt)}
        {timeRow(zhCN.auditCtxReviewUpdatedAt, ask.reviewUpdatedAt)}
      </div>

      {changeLines.length === 0 ? null : <div className={C.muted} style={{ marginTop: '10px' }}>
        {ask.mode === 'existing' ? zhCN.auditUpdatedHint : changeLines.join(' · ')}
      </div>}

      {ask.mode === 'insufficient' ? <>
        {option(zhCN.auditRetry, zhCN.auditRemoteMissingBody, props.onRetry, true)}
      </> : null}

      {ask.mode === 'stale' ? <>
        {option(
          zhCN.auditRestart,
          ask.canRestart ? zhCN.auditStaleBody : zhCN.auditRestartMissing,
          props.onRestart,
          true,
        )}
        {option(zhCN.auditProceedStale, zhCN.auditFreshStale.replace('{basis}', ''), props.onProceed)}
      </> : null}

      {ask.mode === 'possibly' ? <>
        {option(zhCN.auditProceedFresh, zhCN.auditNewAnalysisHint, props.onProceed, true)}
        {option(zhCN.auditContinueOld, zhCN.auditContinueAnalysisHint, props.onContinue)}
      </> : null}

      {ask.mode === 'existing' ? <>
        {option(
          zhCN.auditContinueAnalysis,
          zhCN.auditContinueAnalysisHint,
          props.onContinue,
          changeLines.length === 0,
        )}
        {option(zhCN.auditNewAnalysis, zhCN.auditNewAnalysisHint, props.onProceed, changeLines.length > 0)}
      </> : null}

      <div className={C.aiDialogActions}>
        <Button label={zhCN.auditCancel} small disabled={props.busy} onClick={props.onCancel} />
      </div>
    </div>
  </>
}
