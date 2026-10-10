import * as React from 'react'
import { Card } from '../../components/primitives.tsx'
import { FolderIcon } from '../../components/icons.tsx'
import { LOCAL_AUDIT_CLASSES as L } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { LocalAuditFileRow, LocalAuditRowContent, LocalAuditSelectionRow } from './LocalAuditSelectionRow.tsx'
import { overLimitMessageOf, summaryLineOf, type LocalAuditEntryView } from './selection.ts'
import type { LocalAuditScannedFileView, LocalAuditSkippedView } from '../../../shared/types.ts'

/**
 * 「已选择内容」卡片。
 *
 * 空态与已选态是**同一张卡的两种状态**（不是两块不同的界面）：空态给一枚文件夹图标 + 三行说明，
 * 已选态给一个语义化列表（`<ul>/<li>`）。超限的明确阻止贴在汇总行下面 —— 它就是"当前选择"
 * 这件事的一部分，放进别的卡片会让用户找不到自己刚触发了什么。
 */
export interface LocalAuditSelectionListProps {
  items: LocalAuditEntryView[]
  /**
   * 扫描后的文件级清单（`parentPath` 指回上面某个入口）。
   *
   * 界面**逐行**把它挂在对应文件夹下面：用户 2026-10-11 口径是"审核文件在扫描后应该完整
   * 展示文件名称，右侧有个 X 表示移除该文件"。
   */
  files: LocalAuditScannedFileView[]
  fileCount: number
  limit: number
  overLimit: boolean
  skippedCount: number
  skipped: LocalAuditSkippedView[]
  /** 正在读取选择范围（此刻的行都是「待审核」占位行，计数还不知道）。 */
  scanning?: boolean
  onRemove: (path: string) => void
}

export function LocalAuditSelectionList(props: LocalAuditSelectionListProps): React.ReactElement {
  const summary = summaryLineOf({ items: props.items, fileCount: props.fileCount })
  const overLimit = overLimitMessageOf({ overLimit: props.overLimit, fileCount: props.fileCount, limit: props.limit })
  if (props.items.length === 0) {
    /**
     * 「正在扫描」与「还没选」是两件事：扫描窗口里一个行都还没有时，
     * 画空态会让人以为自己没选上（用户口径：不要显示错误的 0 个文件）。
     * 这里给三行骨架 + 一句状态（`role="status"`，读屏也会播报"正在读取…"）。
     */
    if (props.scanning === true) {
      return <Card title={zhCN.localAuditSelectedTitle}>
        <div className={L.skeleton} role="status" aria-live="polite">
          <div className={L.skeletonLine} />
          <div className={L.skeletonLine} />
          <div className={L.skeletonLine} />
          <div className={L.cardHint}>{zhCN.localAuditScanningSummary}</div>
        </div>
      </Card>
    }
    return <Card title={zhCN.localAuditSelectedTitle}>
      <div className={L.empty}>
        {/* 空态只给一枚线性文件夹图标：不用插画，也不放按钮（按钮在下方的选择卡里）。 */}
        <div className={L.emptyMark}><FolderIcon size={40} /></div>
        <div>{zhCN.localAuditEmptyTitle}</div>
        <div className={L.cardHint}>{zhCN.localAuditEmptyLead}</div>
        <div className={L.cardHint}>{zhCN.localAuditEmptyLimit}</div>
      </div>
    </Card>
  }
  const rowPropsOf = (item: LocalAuditEntryView): Omit<React.ComponentProps<typeof LocalAuditSelectionRow>, 'onRemove'> => ({
    path: item.path,
    name: item.name,
    kind: item.kind,
    sizeBytes: item.sizeBytes,
    fileCount: item.fileCount,
    status: item.status,
    reason: item.reason,
    relativePath: item.relativePath,
  })
  return <Card title={zhCN.localAuditSelectedTitle}>
    <ul className={L.list}>
      {props.items.map((item) => {
        const key = item.path === '' ? item.name : item.path
        const children = props.files.filter((file) => file.parentPath === item.path)
        // 文件夹 = 小标题 + 下面每个文件一行；文件入口就是它自己一行（不再套一层）。
        if (item.kind !== 'directory' || children.length === 0) {
          return <LocalAuditSelectionRow key={key} {...rowPropsOf(item)} onRemove={props.onRemove} />
        }
        return <li key={key} className={L.rowGroup}>
          <div className={L.rowHead}>
            <LocalAuditRowContent {...rowPropsOf(item)} onRemove={props.onRemove} />
          </div>
          <ul className={L.listNested}>
            {children.map((file) => <LocalAuditFileRow
              key={file.path === '' ? `${item.path}/${file.name}` : file.path}
              path={file.path}
              name={file.name}
              relativePath={file.relativePath}
              sizeBytes={file.sizeBytes}
              onRemove={props.onRemove}
            />)}
          </ul>
        </li>
      })}
    </ul>
    {/* 扫描窗口里**不报数字**：这时 items 全是「待审核」占位行，说"展开后共 0 个文件"是假结论。 */}
    <div className={L.summary}>{props.scanning === true ? zhCN.localAuditScanningSummary : summary}</div>
    {overLimit === '' ? null : <div className={L.overLimit} role="alert">{overLimit}</div>}
    {/* 跳过：先说数量，逐条原因收在 `<details>` 里 —— 默认不占版面，要查时一键展开
        （`<details>` 自带键盘与读屏语义：summary 是按钮、展开态由 aria-expanded 表达）。 */}
    {props.skippedCount === 0 ? null : <div className={L.skippedNote}>
      {props.skipped.length === 0
        ? <div>{zhCN.localAuditSkippedNote.replace('%s', String(props.skippedCount))}</div>
        : <details className={L.skippedDetails}>
            <summary className={L.skippedSummary}>
              {zhCN.localAuditSkippedNote.replace('%s', String(props.skippedCount))}
              <span className={L.skippedHint}>{zhCN.localAuditSkippedExpand}</span>
            </summary>
            <ul className={L.list}>
              {props.skipped.map((item, index) => <li key={`${item.relativePath}-${String(index)}`} className={L.rowReason}>
                {`${item.name}（${item.relativePath}）：${item.reason}`}
              </li>)}
            </ul>
          </details>}
    </div>}
  </Card>
}
