import * as React from 'react'
import { Badge, Loading, Notice } from '../../../ui/primitives.tsx'
import { Button, TextInput } from '../../../ui/components/index.ts'
import { useInstanceId } from '../../../ui/components/ids.ts'
import { FileIcon, FolderIcon, WarnIcon } from '../../../ui/icons.tsx'
import { WORKBENCH_CLASSES as C } from '../../../shell/consts.ts'
import { zhCN } from '../../../locales/zh-CN.ts'
import {
  canApply, cleanupIsEmpty, cleanupResultSummary, cleanupSummary, formatBytes, type CleanupViewState,
} from '../model/workspace-cleanup.ts'
import { CLEANUP_CLASSES as S } from '../consts.ts'

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
  const id = useInstanceId('crwu-cleanup')
  const dialogRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const previous = document.activeElement
    dialogRef.current?.focus()
    return () => { if (previous instanceof HTMLElement) previous.focus() }
  }, [])
  React.useEffect(() => {
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus()
  }, [state.phase])
  // The RPC has no progress events; elapsed time must still update during cleanup.
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
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation?.()
      close()
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]'))
      .filter((element) => element.getClientRects().length > 0)
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey
      ? items[index <= 0 ? items.length - 1 : index - 1]
      : items[index < 0 || index === items.length - 1 ? 0 : index + 1]
    event.preventDefault()
    if (next === undefined) dialog.focus()
    else next.focus()
  }
  const canRescan = state.phase === 'ready' || state.phase === 'done' || state.phase === 'error'
  return <>
    <div className={C.aiDialogBackdrop} onClick={closable ? props.onClose : undefined} />
    <div className={S.dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-warning`} tabIndex={-1} ref={dialogRef} onKeyDown={onKeyDown}>
      <header className={S.head}>
        <div className={S.title}>
          <h2 id={`${id}-title`}>{zhCN.wsCleanupTitle}</h2>
          <Badge text={zhCN.wsCleanupIrreversible} tone="high" />
        </div>
        <p className={S.warning} id={`${id}-warning`} role="note">
          <WarnIcon size={15} />{zhCN.wsCleanupWarning}
        </p>
      </header>
      <div className={S.body} aria-busy={applying || state.phase === 'scanning'}>
        {renderBody(props, now, id)}
      </div>
      {applying || state.phase === 'closed' ? null : <footer className={S.footer}>
        <div>
          {canRescan ? <Button variant="text" size="sm" label={zhCN.wsCleanupRetry} onClick={props.onRescan} /> : null}
        </div>
        <div className={S.actions}>
          <Button variant="secondary" size="sm" label={zhCN.wsCleanupCancel} onClick={close} />
          {state.phase === 'ready'
            ? <Button
                variant="danger" size="sm" label={zhCN.wsCleanupApply}
                disabled={!canApply(state)} onClick={props.onApply}
              />
            : null}
        </div>
      </footer>}
    </div>
  </>
}

function renderBody(props: WorkspaceCleanupDialogProps, now: () => number, id: string): React.ReactNode {
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
  if (state.phase === 'done') {
    return <ResultBody state={state} />
  }
  const plan = state.plan
  if (plan === null) return <Notice tone="warn">{zhCN.wsCleanupBlocked}</Notice>
  const running = plan.totals.runningSessions
  const empty = cleanupIsEmpty(plan)
  const entryLabels = {
    directory: zhCN.wsCleanupEntryDirectory, file: zhCN.wsCleanupEntryFile,
    symlink: zhCN.wsCleanupEntrySymlink, other: zhCN.wsCleanupEntryOther,
  }
  return <>
    <section className={S.section}>
      <div className={S.label}>{zhCN.wsCleanupWorkspace}</div>
      <div className={S.path}><FolderIcon size={16} /><span>{plan.workspace.path}</span></div>
    </section>
    {empty ? <Notice tone="warn">{zhCN.wsCleanupEmpty}</Notice> : <>
      <section className={S.section} aria-label={zhCN.wsCleanupEntries}>
        <div className={S.stats} aria-label={cleanupSummary(plan)}>
          <div><strong>{String(plan.totals.folders)}</strong><span>{` ${zhCN.wsCleanupFolders}`}</span></div>
          <div><strong>{String(plan.totals.files)}</strong><span>{` ${zhCN.wsCleanupFiles}`}</span></div>
          <div><strong>{`${plan.totals.bytesComplete ? zhCN.wsCleanupSize : zhCN.wsCleanupSizeAtLeast}${formatBytes(plan.totals.bytes)}`}</strong>
            <span>{zhCN.wsCleanupSizeLabel}</span></div>
        </div>
        <ul
          className={S.entries}
          data-crwu-cleanup-entries="1"
          aria-label={zhCN.wsCleanupEntries} tabIndex={0}
        >
          {plan.entries.length === 0 ? <li className={S.hint}>{zhCN.wsCleanupNoEntries}</li> : null}
          {plan.entries.map((entry) => <li key={entry.name}>
            {entry.kind === 'directory' ? <FolderIcon size={15} /> : <FileIcon size={15} />}
            <span className={S.entryName}>{entry.name}</span>
            <span className={S.entryMeta}>{entryLabels[entry.kind]}
              {entry.kind === 'directory' ? ` · ${formatBytes(entry.sizeBytes)}` : ''}</span>
          </li>)}
        </ul>
        {plan.entriesTruncated === 0 ? null : <div className={S.hint}>
          {`另有 ${String(plan.entriesTruncated)} 项未展开`}
        </div>}
      </section>
      <section className={S.section}>
        <div className={S.sessionHead}>
          <span className={S.label}>{zhCN.wsCleanupSessionTitle}</span>
          <span className={S.hint}>{`${zhCN.wsCleanupSessions}：${String(plan.totals.sessions)} 条`}</span>
        </div>
        <p className={S.hint}>{`${zhCN.wsCleanupTopLevel} ${String(plan.totals.topLevelSessions)} · `
          + `${zhCN.wsCleanupSubagent} ${String(plan.totals.subagentSessions)}`}</p>
        <p className={S.hint}>{zhCN.wsCleanupSessionArchive}</p>
        {running === 0 ? null : <Notice tone="warn">
          <div>{`${String(running)} ${zhCN.wsCleanupRunning}`}</div>
          <div>{zhCN.wsCleanupStopWarn}</div>
        </Notice>}
        <div className={S.option}>
          <input
            id={`${id}-logs`}
            type="checkbox"
            checked={state.deleteSessionLogs}
            aria-describedby={`${id}-logs-hint`}
            onChange={(event) => props.onToggleDeleteSessionLogs(event.target.checked)}
          />
          <div>
            <label htmlFor={`${id}-logs`}>{zhCN.wsCleanupDeleteLogs}</label>
            <p className={S.hint} id={`${id}-logs-hint`}>{zhCN.wsCleanupDeleteLogsHint}</p>
          </div>
        </div>
      </section>
    </>}
    <div className={S.keep} data-crwu-cleanup-keep="1">
      <span>{zhCN.wsCleanupKeepTitle}</span><span>{zhCN.wsCleanupKeep}</span>
    </div>
    <details className={S.details}>
      <summary>{zhCN.wsCleanupDetails}</summary>
      <ul>
        {(plan.notes.length === 0
          ? [zhCN.wsCleanupLimitArchived, zhCN.wsCleanupLimitHistory]
          : plan.notes
        ).map((note) => <li key={note}>{note}</li>)}
      </ul>
    </details>
    <div className={S.confirm}>
      <label htmlFor={`${id}-confirm`}>{zhCN.wsCleanupConfirmHint.replace('{name}', plan.workspace.name)}</label>
      <TextInput
        id={`${id}-confirm`}
        value={state.confirmName}
        placeholder={zhCN.wsCleanupConfirmPlaceholder}
        autoComplete="off"
        spellCheck={false}
        disabled={empty}
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
