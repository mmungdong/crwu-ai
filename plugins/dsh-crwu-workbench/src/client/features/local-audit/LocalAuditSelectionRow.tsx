import * as React from 'react'
import { CheckIcon, CloseIcon, FileIcon, FolderIcon, InfoIcon, WarnIcon } from '../../components/icons.tsx'
import { LOCAL_AUDIT_CLASSES as L } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { formatBytes, itemMetaOf, itemStatusOf, type LocalAuditTone } from './selection.ts'

/**
 * 「已选择内容」里的行。
 *
 * 三条硬要求（设计 §5 / §9）：
 * 1. 逐项状态是**图标 + 文字 + 颜色**三重表达（只靠颜色在有色彩障碍时读不出来）；
 * 2. 辅助事实分开说：文件给字节数、文件夹给展开后的文件数；
 * 3. 移除按钮的可访问名必须说出**具体是哪一个文件**（一屏十几个"移除"读屏时无法区分）。
 *
 * 行的层级（用户 2026-10-11 口径）：**入口行**（用户选的文件夹/文件）+ 文件夹下面
 * **每个文件一行**（完整文件名）。移除一律是右侧一枚 X 图标：入口行移除整个入口，
 * 文件行只移除那个文件（记进排除清单，重新扫描后依然不审）。
 */

/** 语气 → 颜色类。只映射到本页自己的 tone 类，不碰别的区域的样式。 */
const TONE_CLASS: Record<LocalAuditTone, string> = {
  ok: L.toneOk,
  warn: L.toneWarn,
  error: L.toneError,
  muted: L.toneMuted,
}

/** 语气 → 图标。绿色的对勾、琥珀的叹号、灰色的信息，形状本身就能区分。 */
function statusIconOf(tone: LocalAuditTone): React.ReactElement {
  if (tone === 'ok') return <CheckIcon size={14} />
  if (tone === 'warn' || tone === 'error') return <WarnIcon size={14} />
  return <InfoIcon size={14} />
}

/**
 * 右侧那枚 X。
 *
 * 它必须**自带具体名字**（`aria-label` / `title`）：一屏十几枚同样的 X，
 * 读屏和悬停时都得说清"移除的是哪一个"。
 */
function RemoveButton(props: { name: string; onClick: () => void }): React.ReactElement {
  const label = zhCN.localAuditRemoveAria.replace('%s', props.name)
  return <button
    type="button"
    className={L.rowRemove}
    aria-label={label}
    title={label}
    onClick={props.onClick}
  >
    <CloseIcon size={14} />
  </button>
}

export interface LocalAuditSelectionRowProps {
  path: string
  name: string
  kind: string
  sizeBytes: number
  fileCount: number
  status: string
  reason: string
  /** 相对所选根目录的展示路径（与 `name` 相同则不重复渲染）。 */
  relativePath: string
  onRemove: (path: string) => void
}

/** 入口行的内容（不含 `<li>` 外壳）：文件夹被当作小标题、下面挂文件行时复用同一份内容。 */
export function LocalAuditRowContent(props: LocalAuditSelectionRowProps): React.ReactElement {
  const status = itemStatusOf(props.status)
  const relative = props.relativePath !== '' && props.relativePath !== props.name ? props.relativePath : ''
  return <>
    <span className={L.rowIcon} aria-hidden={true}>
      {/* kind 为空 = 还没扫到（「待审核」行）：给中性图标，不猜成文件或文件夹。 */}
      {props.kind === 'directory'
        ? <FolderIcon size={16} />
        : (props.kind === 'file' ? <FileIcon size={16} /> : <InfoIcon size={16} />)}
    </span>
    <span className={L.rowMain}>
      <span className={L.rowName}>{props.name}</span>
      <span className={L.rowMeta}>{itemMetaOf(props)}</span>
      {relative === '' ? null : <span className={L.rowReason}>{relative}</span>}
      {/* 不可读 / 已跳过 / 超限的原因要露出来：只说"无法读取"而不说为什么，用户无从下手。 */}
      {props.reason === '' ? null : <span className={L.rowReason}>{props.reason}</span>}
    </span>
    <span className={[L.rowStatus, TONE_CLASS[status.tone]].join(' ')}>
      <span aria-hidden={true}>{statusIconOf(status.tone)}</span>
      {status.label}
    </span>
    <RemoveButton name={props.name} onClick={() => { props.onRemove(props.path) }} />
  </>
}

export function LocalAuditSelectionRow(props: LocalAuditSelectionRowProps): React.ReactElement {
  return <li className={L.listRow}><LocalAuditRowContent {...props} /></li>
}

export interface LocalAuditFileRowProps {
  /** 文件的完整绝对路径（排除清单的键）。 */
  path: string
  name: string
  /** 相对所选入口的展示路径（与文件名不同才渲染，用来区分同名文件）。 */
  relativePath: string
  sizeBytes: number
  onRemove: (path: string) => void
}

/**
 * 一个**文件**一行：完整文件名 + 相对路径 + 大小 + 右侧 X。
 *
 * 名字**不截断**（`overflow-wrap: anywhere` 换行展示），这是用户口径里的"完整展示文件名称"。
 */
export function LocalAuditFileRow(props: LocalAuditFileRowProps): React.ReactElement {
  const relative = props.relativePath !== '' && props.relativePath !== props.name ? props.relativePath : ''
  return <li className={[L.listRow, L.listRowFile].join(' ')}>
    <span className={L.rowIcon} aria-hidden={true}><FileIcon size={14} /></span>
    <span className={L.rowMain}>
      <span className={L.rowName}>{props.name}</span>
      {relative === '' ? null : <span className={L.rowReason}>{relative}</span>}
    </span>
    <span className={L.rowMeta}>{formatBytes(props.sizeBytes)}</span>
    <RemoveButton name={props.name} onClick={() => { props.onRemove(props.path) }} />
  </li>
}
