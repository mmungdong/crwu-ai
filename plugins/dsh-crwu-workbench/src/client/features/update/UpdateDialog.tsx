import * as React from 'react'
import { Button } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { formatDateTime } from '../report-audit/time.ts'
import { updateViewModelOf } from './view-model.ts'
import type { UpdateSnapshot } from './update-store.ts'

/**
 * 自助更新面板。
 *
 * ## 口径（用户 2026-09-28）
 *
 * - **只给人看"现在能不能装、装到哪一步、装完要做什么"**：当前/目标版本、可选发布时间、
 *   公开来源类型（npmmirror / npm 的本地中文标签）、诚实的离散安装阶段（**没有百分比**）；
 * - **安装完成之后只给手动重启说明**：CRWU 不会、也不能替你重启 DeepSeek Harness，
 *   所以这里没有"立即重启"这类按钮，也不声称已经重启过桌面上那个应用；
 * - **只渲染脱敏信息**：私有 registry 地址、认证头、Token、完整 pnpm 日志、requestId
 *   以及任何 Host 原文都不进这个组件（它们也进不了 Task 5 收窄后的快照）。
 *
 * ## 无障碍与误触
 *
 * `role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向真实存在的标题；
 * 关闭按钮始终在（键盘可达，任何时候都能退出）。**安全状态**下 Esc 可以关闭；
 * 安装 / 取消进行中时 Esc 与遮罩点击都不关闭 —— 关键动作不该被一次误触丢掉，
 * 而"关闭按钮仍可用"保证这不会变成键盘用户的死胡同。
 */

export interface UpdateDialogProps {
  /** Task 5 收窄后的更新快照（唯一事实源）。 */
  snapshot: UpdateSnapshot
  /** 当前运行的版本（来自 build store）。 */
  currentVersion: string
  /** Host 构建形态；`dev` 时徽标与面板都按"不参与自助更新"显示。 */
  buildKind?: 'dev' | 'installed' | ''
  /** 是否有审核任务在跑（由面板折算后传入）。 */
  auditBusy?: boolean
  /** 当前时间（毫秒）；缺省取本机时钟（过期判据只用它）。 */
  nowMs?: number
  /** 当前平台：决定重启说明里的 macOS 提示。 */
  platform?: 'mac' | 'other'
  onClose: () => void
  onCheck?: () => void
  onInstall?: () => void
  onCancel?: () => void
}

type KeydownTarget = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
}

type FocusableNode = {
  focus?: () => void
  querySelectorAll?: (selector: string) => ArrayLike<FocusableNode>
}

type FocusDocument = KeydownTarget & {
  activeElement?: FocusableNode | null
  getElementById?: (id: string) => FocusableNode | null
}

/** 弹窗容器的 id：焦点接管与 Tab 循环都要先在文档里找到它（无 ref 也能工作）。 */
const DIALOG_ID = 'crwu-audit-update-dialog'

/** 弹窗里"当前可用"的可聚焦元素（disabled 的不在其中 —— 这是 Tab 循环的判据）。 */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

type KeyLikeEvent = { key?: unknown; shiftKey?: unknown; preventDefault?: () => void }

function join(...all: Array<string | false | undefined>): string {
  return all.filter((item): item is string => typeof item === 'string' && item !== '').join(' ')
}

export function UpdateDialog(props: UpdateDialogProps): React.ReactElement {
  const { onClose } = props
  const view = updateViewModelOf({
    snapshot: props.snapshot,
    currentVersion: props.currentVersion,
    auditBusy: props.auditBusy === true,
    nowMs: props.nowMs ?? Date.now(),
    buildKind: props.buildKind ?? '',
    platform: props.platform ?? 'other',
  })
  const titleId = 'crwu-audit-update-dialog-title'
  // 关键动作进行中：Esc 与遮罩点击都不关闭（关闭按钮仍然可用，见 §无障碍）。
  const critical = view.installing || view.cancelling

  // 事件处理器要读到**最新**的 critical/onClose，但焦点接管只能做一次（重复订阅会在每次
  // 重渲染时把焦点又拽回弹窗）。所以处理器从 ref 读最新值，订阅本身只挂一次。
  const latest = React.useRef({ critical, onClose })
  React.useEffect(() => {
    latest.current = { critical, onClose }
  })

  React.useEffect(() => {
    const doc = (globalThis as { document?: FocusDocument }).document
    if (doc?.addEventListener === undefined) return undefined
    const dialog = doc.getElementById?.(DIALOG_ID) ?? null
    const previouslyFocused = doc.activeElement ?? null
    const focusables = (): FocusableNode[] => {
      const found = dialog?.querySelectorAll?.(FOCUSABLE_SELECTOR)
      return found === undefined ? [] : Array.from(found)
    }

    // 1) 打开后焦点进入弹窗：优先第一个可用控件；一个都没有时聚焦容器本身（tabIndex=-1）。
    const first = focusables()[0]
    if (first !== undefined) first.focus?.()
    else dialog?.focus?.()

    const onKeyDown = (event: unknown): void => {
      const key = (event as KeyLikeEvent | null)?.key
      if (key === 'Escape') {
        if (latest.current.critical) return
        latest.current.onClose()
        return
      }
      if (key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      // 2) Tab / Shift+Tab 在当前可用控件之间循环，绝不走进背后的工作台。
      const index = items.indexOf((doc.activeElement ?? null) as FocusableNode)
      const shift = (event as KeyLikeEvent | null)?.shiftKey === true
      const next = shift
        ? (index <= 0 ? items[items.length - 1] : items[index - 1])
        : (index === -1 || index >= items.length - 1 ? items[0] : items[index + 1])
      ;(event as KeyLikeEvent | null)?.preventDefault?.()
      next?.focus?.()
    }
    doc.addEventListener('keydown', onKeyDown)
    return () => {
      // 6) 监听随卸载释放；3) 焦点尽量还给打开前的元素。
      doc.removeEventListener?.('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [])

  const notice = view.installNotice
  const sourceKind = view.sourceKind === null ? zhCN.updateDiagNone : view.sourceKind
  const errorLine = props.snapshot.error === null
    ? zhCN.updateDiagNone
    : `${props.snapshot.error.action}/${props.snapshot.error.code}`

  const rows: Array<{ key: string; label: string; value: string; mono: boolean }> = [
    { key: 'current', label: zhCN.updateFieldCurrent, value: view.currentVersionLabel, mono: true },
  ]
  if (view.targetVersion !== '') {
    rows.push({ key: 'target', label: zhCN.updateFieldTarget, value: `v${view.targetVersion}`, mono: true })
  }
  if (view.publishedAt !== '') {
    rows.push({ key: 'published', label: zhCN.updateFieldPublished, value: formatDateTime(view.publishedAt), mono: true })
  }
  if (view.sourceKindLabel !== '') {
    rows.push({ key: 'source', label: zhCN.updateFieldSource, value: view.sourceKindLabel, mono: false })
  }
  if (view.installStageLabel !== '') {
    rows.push({ key: 'stage', label: zhCN.updateFieldStage, value: view.installStageLabel, mono: false })
  }

  return <React.Fragment>
    <div
      className={C.updateDialogBackdrop}
      {...(critical ? {} : { onClick: onClose })}
    />
    <div
      className={C.updateDialog}
      id={DIALOG_ID}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className={C.updateDialogHead}>
        <span className={C.updateDialogTitle} id={titleId}>{zhCN.updateDialogTitle}</span>
        <Button label={zhCN.updateActionClose} onClick={onClose} />
      </div>

      <div className={C.updateDialogBody}>
        {/* 装完 / 等待重启：唯一要说的就是"完全退出再打开"，并把 macOS 的退出方式讲明白。 */}
        {notice === null ? null : <div className={C.updateDialogNotice}>
          <div>{notice.line}</div>
          {notice.hint === '' ? null : <div className={C.updateDialogNoticeHint}>{notice.hint}</div>}
        </div>}

        {view.hasCandidate || view.installStageLabel !== '' ? <div className={C.kv}>
          {rows.map((row) => <React.Fragment key={row.key}>
            <div className={C.kvKey}>{row.label}</div>
            <div className={C.kvValue}>
              <span className={row.mono ? C.mono : undefined}>{row.value}</span>
            </div>
          </React.Fragment>)}
        </div> : <div className={C.muted}>{zhCN.updateNoCandidateLine}</div>}

        {/* 安装阶段单独一行：诚实的离散阶段，不写百分比、不写预计剩余时间。 */}
        {view.installStageLabel === '' ? null : <div className={C.updateDialogStages}>
          <span className={join(C.updateDialogStage, view.installStage !== null && C.updateDialogStageOn)}>
            {view.installStageLabel}
          </span>
        </div>}

        {/* 不能安装的原因（每种原因一句固定中文，来自 View Model）。 */}
        {view.installBlockedText === '' ? null : <div className={C.updateDialogReason}>{view.installBlockedText}</div>}

        {/* 错误按动作分派：检查 / 安装 / 取消各自说自己那句，绝不混。 */}
        {view.showManualCheckError ? <div className={C.updateDialogError}>{view.manualCheckErrorText}</div> : null}
        {view.showInstallError ? <div className={C.updateDialogError}>{view.installErrorText}</div> : null}
        {view.showCancelError ? <div className={C.updateDialogError}>{view.cancelErrorText}</div> : null}

        {/* 脱敏诊断：只有稳定分类、阶段、目标版本与公开来源类型。 */}
        <details className={C.updateDialogDiag}>
          <summary className={C.detailsTitle}>{zhCN.updateDiagnostics}</summary>
          {[
            { key: 'check', label: zhCN.updateDiagCheck, value: props.snapshot.check === null ? zhCN.updateDiagNone : props.snapshot.check.status },
            { key: 'install', label: zhCN.updateDiagInstall, value: props.snapshot.install === null ? zhCN.updateDiagNone : props.snapshot.install.status },
            { key: 'stage', label: zhCN.updateDiagStage, value: view.installStage ?? zhCN.updateDiagNone },
            { key: 'target', label: zhCN.updateDiagTarget, value: view.targetVersion === '' ? zhCN.updateDiagNone : view.targetVersion },
            { key: 'source', label: zhCN.updateDiagSource, value: sourceKind },
            { key: 'error', label: zhCN.updateDiagError, value: errorLine },
          ].map((row) => <div className={C.updateDialogDiagRow} key={row.key}>
            <span className={C.kvKey}>{row.label}</span>
            <span className={join(C.kvValue, C.mono)}>{row.value}</span>
          </div>)}
        </details>
      </div>

      <div className={C.updateDialogActions}>
        {/* 等待重启时**只**给一个"我知道了"：这一刻没有可做的安装动作，重启要用户自己来。 */}
        {view.awaitingRestart
          ? <Button label={zhCN.updateActionOk} tone="primary" onClick={onClose} />
          : <React.Fragment>
              <Button
                label={zhCN.updateActionCheck}
                disabled={!view.canCheck}
                onClick={() => { props.onCheck?.() }}
              />
              <Button
                label={zhCN.updateActionInstall}
                tone="primary"
                disabled={!view.canInstall}
                onClick={() => { props.onInstall?.() }}
              />
              {view.canCancel
                ? <Button label={zhCN.updateActionCancel} onClick={() => { props.onCancel?.() }} />
                : null}
            </React.Fragment>}
      </div>
    </div>
  </React.Fragment>
}
