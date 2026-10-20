import * as React from 'react'
import { Badge, Loading, Notice } from '../../../ui/primitives.tsx'
import { Button } from '../../../ui/components/index.ts'
import { TextInput } from '../../../ui/components/index.ts'
import { WORKBENCH_CLASSES as C } from '../../../shell/consts.ts'
import { zhCN } from '../../../locales/zh-CN.ts'
import {
  canApply, cleanupIsEmpty, cleanupResultSummary, cleanupSummary, type CleanupViewState,
} from '../model/workspace-cleanup.ts'

/**
 * 清空工作空间的确认弹窗。
 *
 * 三条硬规矩（对应 spec §10.2）：
 * 1. **先看清单再确认**：数量、会话、限制都摆在按钮之前；
 * 2. **逐字输入目录名**才点亮红色按钮 —— 误点一次就是整盘内容；
 * 3. **执行中不给关闭**：RPC 还在飞，关掉只会让人误以为取消了。
 */
export interface WorkspaceCleanupDialogProps {
  state: CleanupViewState
  now?: () => number
  onConfirmName(value: string): void
  onToggleDeleteSessionLogs(value: boolean): void
  onApply(): void
  onRescan(): void
  onClose(): void
}

export function WorkspaceCleanupDialog(props: WorkspaceCleanupDialogProps): React.ReactElement {
  const { state } = props
  const now = props.now ?? (() => Date.now())
  const applying = state.phase === 'applying'
  // 执行中每秒重渲染一次，"已用时"才是真的在走（RPC 本身不回报进度）。
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    if (!applying) return
    const timer = setInterval(() => { tick((value) => value + 1) }, 1000)
    return () => { clearInterval(timer) }
  }, [applying])
  const closable = !applying
  const close = (): void => {
    if (closable) props.onClose()
  }
  return <>
    <div className={C.aiDialogBackdrop} onClick={closable ? props.onClose : undefined} />
    <div className={C.aiDialog} role="dialog" aria-modal="true" aria-label={zhCN.wsCleanupTitle}>
      <div className={C.aiDialogTitle}>
        {zhCN.wsCleanupTitle}
        <Badge text={zhCN.wsCleanupIrreversible} tone="high" />
      </div>
      {renderBody(props, now)}
      <div className={C.aiDialogActions}>
        {applying || state.phase === 'closed' ? null
          : <Button variant="secondary" size="sm" label={zhCN.wsCleanupCancel} onClick={close} />}
        {state.phase === 'ready'
          ? <>
              <Button variant="secondary" size="sm" label={zhCN.wsCleanupRetry} onClick={props.onRescan} />
              <Button
                variant="danger"
                size="sm"
                label={zhCN.wsCleanupApply}
                disabled={!canApply(state)}
                onClick={props.onApply}
              />
            </>
          : null}
        {state.phase === 'done' || state.phase === 'error'
          ? <>
              <Button variant="secondary" size="sm" label={zhCN.wsCleanupRetry} onClick={props.onRescan} />
              <Button variant="secondary" size="sm" label={zhCN.wsCleanupCancel} onClick={props.onClose} />
            </>
          : null}
      </div>
    </div>
  </>
}

function renderBody(props: WorkspaceCleanupDialogProps, now: () => number): React.ReactNode {
  const { state } = props
  if (state.phase === 'scanning') return <Loading text={zhCN.wsCleanupTitle} />
  if (state.phase === 'applying') {
    const seconds = Math.max(0, Math.floor((now() - state.startedAt) / 1000))
    return <>
      <Notice tone="warn">
        <div>{zhCN.wsCleanupApplying}</div>
        <div className={C.muted}>{zhCN.wsCleanupElapsed.replace('{seconds}', String(seconds))}</div>
        <div className={C.muted}>{zhCN.wsCleanupStages}</div>
        <div className={C.muted}>{zhCN.wsCleanupRunHint}</div>
      </Notice>
    </>
  }
  if (state.phase === 'error') {
    return <Notice tone="warn">
      <div>{zhCN.wsCleanupFailed}</div>
      <div>{state.error}</div>
    </Notice>
  }
  if (state.phase === 'done' && state.result !== null) {
    return <ResultBody state={state} />
  }
  const plan = state.plan
  if (plan === null) return <Notice tone="warn">{zhCN.wsCleanupBlocked}</Notice>
  const running = plan.totals.runningSessions
  return <>
    <div className={C.mono} style={{ fontWeight: 600 }}>{plan.workspace.path}</div>
    {cleanupIsEmpty(plan) ? <Notice tone="warn">{zhCN.wsCleanupEmpty}</Notice> : <>
      <div className={C.muted} style={{ marginTop: '8px' }}>{cleanupSummary(plan)}</div>
      <ul
        className={C.muted}
        data-crwu-cleanup-entries="1"
        style={{ maxHeight: '180px', overflowY: 'auto', margin: '6px 0 0', paddingLeft: '18px' }}
      >
        {plan.entries.map((entry) => <li key={entry.name}>
          <span className={C.mono}>{entry.name}</span>
          {entry.kind === 'directory' ? ` · ${String(entry.sizeBytes)} B` : ''}
        </li>)}
      </ul>
      {plan.entriesTruncated === 0 ? null : <div className={C.muted}>
        {`另有 ${String(plan.entriesTruncated)} 项未展开`}
      </div>}
      <div className={C.muted} style={{ marginTop: '8px' }}>
        {`${zhCN.wsCleanupSessions}：${String(plan.totals.sessions)} 条（${zhCN.wsCleanupTopLevel} `
          + `${String(plan.totals.topLevelSessions)} · ${zhCN.wsCleanupSubagent} `
          + `${String(plan.totals.subagentSessions)}）`}
      </div>
      {running === 0 ? null : <Notice tone="warn">
        <div>{`${String(running)} ${zhCN.wsCleanupRunning}`}</div>
        <div>{zhCN.wsCleanupStopWarn}</div>
      </Notice>}
      <label className={C.row} style={{ marginTop: '8px', alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={state.deleteSessionLogs}
          onChange={(event) => props.onToggleDeleteSessionLogs(event.target.checked)}
        />
        <span>
          {zhCN.wsCleanupDeleteLogs}
          <span className={C.muted}>{` ${zhCN.wsCleanupDeleteLogsHint}`}</span>
        </span>
      </label>
    </>}
    <div className={C.muted} style={{ marginTop: '10px' }}>{zhCN.wsCleanupKeepTitle}：{zhCN.wsCleanupKeep}</div>
    <ul className={C.muted} style={{ marginTop: '6px', paddingLeft: '18px' }}>
      {(plan.notes.length === 0
        ? [zhCN.wsCleanupLimitArchived, zhCN.wsCleanupLimitHistory]
        : plan.notes
      ).map((note) => <li key={note}>{note}</li>)}
    </ul>
    <div style={{ marginTop: '12px' }}>
      <div className={C.muted}>{zhCN.wsCleanupConfirmHint.replace('{name}', plan.workspace.name)}</div>
      <TextInput
        value={state.confirmName}
        placeholder={zhCN.wsCleanupConfirmPlaceholder}
        disabled={cleanupIsEmpty(plan)}
        onChange={(value) => props.onConfirmName(value)}
      />
    </div>
  </>
}

function ResultBody(props: { state: CleanupViewState }): React.ReactElement {
  const result = props.state.result
  if (result === null) return <Notice tone="warn">{zhCN.wsCleanupFailed}</Notice>
  return <>
    <Notice tone={result.status === 'completed' ? 'ok' : 'warn'}>
      <div>{result.status === 'completed' ? zhCN.wsCleanupDone
        : result.status === 'aborted' ? zhCN.wsCleanupAborted
          : result.status === 'failed' ? zhCN.wsCleanupFailed : zhCN.wsCleanupPartial}</div>
      <div>{cleanupResultSummary(result)}</div>
    </Notice>
    {result.remainingNames.length === 0 ? null : <div className={C.muted} style={{ marginTop: '8px' }}>
      {zhCN.wsCleanupRemaining.replace('{count}', String(result.remaining))}
      {result.remainingNames.join('、')}
    </div>}
    {result.failures.length === 0 ? null : <ul className={C.muted} style={{ marginTop: '8px' }}>
      {result.failures.map((failure, index) => <li key={`${failure.name}-${String(index)}`}>
        {`${failure.name}：${failure.reason}`}
      </li>)}
    </ul>}
  </>
}
