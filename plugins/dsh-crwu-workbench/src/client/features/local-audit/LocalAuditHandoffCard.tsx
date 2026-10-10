import * as React from 'react'
import { Button, Card } from '../../components/primitives.tsx'
import { CheckIcon, WarnIcon } from '../../components/icons.tsx'
import { LOCAL_AUDIT_CLASSES as L } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import type { LocalAuditHandoff } from './controller.ts'

/**
 * 本地审核的**结果卡**：成功移交 / 失败兜底 / 已经准备好快照三种形态。
 *
 * 失败兜底是这一页设计的重点（设计 §7）：Windows 上自动建会话可能被权限挡住，所以
 * 界面必须给一条**用户自己走得下去**的路 —— 三步说明 + 「复制审核提示词」+「重新准备文件」。
 * 两条长期约束：
 * - **不提供「自动重试创建会话」**：失败点就是自动路径本身，再点一次通常还是失败，
 *   而用户真正需要的是"把这段提示词粘到我已经有能力开的对话里"；
 * - 提示词是**可复制的完整一段**（`textarea` 只读、可全选），复制失败时也要能看到原文。
 */
export interface LocalAuditHandoffCardProps {
  done: boolean
  expired: boolean
  failed: boolean
  error: string
  handoff: LocalAuditHandoff | null
  providedCount: number
  skippedCount: number
  /** 刚刚复制成功（组件本地状态，2 秒后自动收起）。 */
  copied: boolean
  /** 复制失败的原因（空串 = 没失败过）。 */
  copyError: string
  /** 认领失败的原因（不阻塞，只是如实说明）。 */
  claimError: string
  busy: boolean
  onCopy: () => void
  onReprepare: () => void
}

/**
 * 复制之后的反馈（设计 §8 逐字三条）。
 *
 * 为什么不是一行 `已复制 · 粘贴即可`：用户真正要做的下一步是**先切权限、再建新对话**，
 * 只说"已复制"很容易让人以为在自己当前这条会话里粘贴就行；同时还要说明
 * 「已选内容与提示词仍然保留」，否则他会以为关掉页面就白选了。
 */
function CopyFeedback(props: { copied: boolean; copyError: string }): React.ReactElement | null {
  if (props.copyError !== '') {
    // 失败必须立刻被读出来（`role=alert`），而不是只在视觉上变红。
    return <div className={L.fatal} role="alert">{props.copyError}{zhCN.localAuditCopyFailedHint}</div>
  }
  if (!props.copied) return null
  return <div className={L.handoffCopied} role="status" aria-live="polite">
    <div>{zhCN.localAuditCopyDone}</div>
    <div>{zhCN.localAuditCopyFullAccess}</div>
    <div>{zhCN.localAuditCopyKept}</div>
  </div>
}

export function LocalAuditHandoffCard(props: LocalAuditHandoffCardProps): React.ReactElement {
  if (props.done) {
    return <Card title={zhCN.localAuditTab}>
      <div className={L.done}>
        <span className={L.doneMark} aria-hidden={true}><CheckIcon size={20} /></span>
        <span>
          <div className={L.doneTitle}>{zhCN.localAuditDoneTitle}</div>
          <div className={L.doneMeta}>{zhCN.localAuditProvided.replace('%s', String(props.providedCount))}</div>
          {props.skippedCount === 0
            ? null
            : <div className={L.doneMeta}>{zhCN.localAuditSkipped.replace('%s', String(props.skippedCount))}</div>}
          <div className={L.doneHint}>{zhCN.localAuditDoneHint}</div>
          {/* 认领失败**不改变结论**（对话里的模型还会再认领一次），但必须说出来。 */}
          {props.claimError === '' ? null : <div className={L.doneHint}>{zhCN.localAuditClaimFailed}{props.claimError}</div>}
        </span>
      </div>
    </Card>
  }

  if (props.expired) {
    return <Card title={zhCN.localAuditTab}>
      <div className={L.handoff}>
        <span className={L.handoffMark} aria-hidden={true}><WarnIcon size={20} /></span>
        <span>
          <div className={L.handoffTitle}>{zhCN.localAuditExpired}</div>
          <div className={L.handoffLead}>{zhCN.localAuditExpiredHint}</div>
          <div className={L.handoffActions}>
            {/* 次级：整页唯一的主按钮是底部的「开始本地审核」（过期时它是「重试准备」）。 */}
            <Button label={zhCN.localAuditReprepare} disabled={props.busy} onClick={props.onReprepare} />
          </div>
        </span>
      </div>
    </Card>
  }

  if (props.failed) {
    return <Card title={zhCN.localAuditTab}>
      <div className={L.handoff}>
        <span className={L.handoffMark} aria-hidden={true}><WarnIcon size={20} /></span>
        <span className={L.rowMain}>
          <div className={L.handoffTitle}>{zhCN.localAuditFailedTitle}</div>
          {/* 失败原因**紧邻标题**：只说"中断了"而不说为什么，用户只能猜。 */}
          {props.error === '' ? null : <div className={L.handoffLead}>{props.error}</div>}
          <div className={L.handoffLead}>{zhCN.localAuditFailedLead}</div>
          <ol className={L.handoffSteps}>
            {zhCN.localAuditFailedSteps.map((line) => <li key={line}>{line}</li>)}
          </ol>
          <div className={L.handoffActions}>
            <Button label={zhCN.localAuditCopyPrompt} disabled={props.busy} onClick={props.onCopy} />
            <Button label={zhCN.localAuditReprepare} disabled={props.busy} onClick={props.onReprepare} />
          </div>
          {/* 复制结果紧贴按钮：成功给一句确认，失败给原文所在的位置。 */}
          <CopyFeedback copied={props.copied} copyError={props.copyError} />
        </span>
      </div>
      {props.handoff === null ? null : <textarea
        className={L.handoffPrompt}
        readOnly={true}
        aria-label={zhCN.localAuditCopyPrompt}
        value={props.handoff.prompt}
        onFocus={(event) => { (event.target as { select?: () => void }).select?.() }}
      />}
    </Card>
  }

  if (props.handoff === null) {
    // 既没准备好快照、也没失败：这一段留空（正在准备时由阶段条负责说明进展）。
    return <></>
  }
  return <Card title={zhCN.localAuditTab}>
    <div className={L.done}>
      <span className={L.doneMark} aria-hidden={true}><CheckIcon size={20} /></span>
      <span>
        <div className={L.doneTitle}>{zhCN.localAuditPrepared}</div>
        <div className={L.doneMeta}>{zhCN.localAuditProvided.replace('%s', String(props.providedCount))}</div>
        {props.skippedCount === 0
          ? null
          : <div className={L.doneMeta}>{zhCN.localAuditSkipped.replace('%s', String(props.skippedCount))}</div>}
        <div className={L.doneHint}>{zhCN.localAuditPreparedHint}</div>
        <div className={L.handoffActions}>
          <Button label={zhCN.localAuditCopyPrompt} disabled={props.busy} onClick={props.onCopy} />
        </div>
        <CopyFeedback copied={props.copied} copyError={props.copyError} />
      </span>
    </div>
    <textarea
      className={L.handoffPrompt}
      readOnly={true}
      aria-label={zhCN.localAuditCopyPrompt}
      value={props.handoff.prompt}
      onFocus={(event) => { (event.target as { select?: () => void }).select?.() }}
    />
  </Card>
}
