import * as React from 'react'
import { FileIcon, FolderIcon, CloseIcon } from '../../../ui/icons.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import { VALUATION_PROMPT_MAX_LENGTH } from '../../../../shared/consts.ts'
import { ASSET_TYPES } from '../../../../shared/contracts/valuation-project.ts'
import { ValuationCapabilityArea } from './ValuationCapabilityArea.tsx'
import { Button, DatePicker, FormField, IconButton, Select, TextArea, TextInput, type SelectOption } from '../../../ui/components/index.ts'
import { useInstanceId } from '../../../ui/components/ids.ts'
import { VALUATION_CLASSES as V } from '../model/styles.ts'
import {
  actionSummaryOf,
  canEditInputs,
  entryStatusText,
  fileKindLabel,
  fileKindOf,
  fileStatusOf,
  scopeCountsText,
  sizeTextOf,
  startDisabledReason,
  valuationMethodOptions,
  type ValuationFileRowView,
  type ValuationMethodChoice,
  type ValuationPageState,
  type ValuationSelectedFileView,
} from '../model/valuation-state.ts'

/**
 * 估值输入工作面 —— **按任务顺序纵向排列**（设计稿 §8 / §9）。
 *
 * ```text
 * 估值资料                             [选择文件] [选择文件夹]
 * v 项目资料            文件夹 · 纳入 3 份            [移除文件夹]
 *    权属资料.pdf       PDF · 2.4 MB   已纳入        [移除]
 * 已纳入 3 / 30 份；跳过 1 项                          [查看跳过项]
 * ─────────────────────────────────────────────────────────────
 * 资产类型 *                     评估方法 *
 * [请选择资产类型        ▾]     [请选择评估方法        ▾]
 * ─────────────────────────────────────────────────────────────
 * 补充条件 · 可选
 * 评估目的          价值类型          评估基准日
 * [          ]     [          ]     [                ]
 * 补充要求
 * [                                                  ]
 * ─────────────────────────────────────────────────────────────
 * 信息获取辅助 · 可选
 * 链家   尚未检查                            [检查状态]
 * 用于辅助获取公开信息；未登录可继续估值。
 * ─────────────────────────────────────────────────────────────
 * 就绪摘要 / 下一步提示                    [核对资料]
 * ```
 *
 * ## 六条硬口径
 *
 * 1. **一屏一个 primary**：右下角**唯一**的实心按钮就是「核对资料」（逐字）；
 * 2. **两个必填项紧跟资料区**：资产类型与评估方法排在**所有**可选条件与辅助能力之前，
 *    两者用同一种单选下拉；长文件清单靠紧凑行、目录折叠与摘要消化，不把它们推下去；
 * 3. **禁用必须说原因**：可见文字 + `aria-describedby` 关联到按钮上，不只挂 `title`；
 *    字段级错误只在失焦或清空已填值之后出现 —— 初次进入不是满屏红字；
 * 4. **份数以递归去重后的文件数**为准（用户选中的目录数不作数），>30 整批阻止、不截取；
 *    评估目的 / 价值类型**不预置任何正式结论**：未填就是空，界面按"未指定"解释；
 * 5. **入口与实际文件是两层**：文件夹能真的展开/收起、里面的每一份能单独移除（写进排除范围，
 *    重扫与归档都不再出现）—— 被收起的后代不留在键盘顺序里；
 * 6. **移除可撤销**：反馈在资料区下方，8 秒内有效；准备确认时冻结范围、隐藏撤销。
 *
 * 这个组件不认识 RPC：它只接收状态与回调，"能不能改"的唯一判据是状态机的 `canEditInputs`。
 */

export interface ValuationIntakePaneProps {
  state: ValuationPageState
  onPickFiles: () => void
  onPickFolder: () => void
  /** 移除一个**选择入口**（文件夹或直接选中的文件）。 */
  onRemoveSelection: (path: string) => void
  /** 逐个移除一份具体文件（写进排除范围）。 */
  onExcludeFile: (path: string) => void
  /** 重新纳入之前被移除的文件。 */
  onReincludeFile: (path: string) => void
  /** 撤销最近一次移除。 */
  onUndoRemoval: () => void
  /** 扫描失败 / 清单不完整时的「重新读取清单」。 */
  onRescan: () => void
  onMethodChange: (method: ValuationMethodChoice) => void
  /** 选资产类型（空串 = 还没选；状态机只接受已登记的取值）。 */
  onAssetTypeChange: (assetType: string) => void
  /** 查一次信息获取辅助能力状态（进页面不自动查；辅助区与抽屉各触发一次）。 */
  onCheckCapability: () => void
  /** 为某个来源拉起登录窗口（可选能力，失败不拦页面）。 */
  onLoginSite: (siteId: string) => void
  /** 打开某个来源的验证窗口（已登录但页面要人机验证时唯一的出路）。 */
  onVerifySite: (siteId: string) => void
  /** 取消本页发起的那条登录任务。 */
  onCancelLogin: (jobId: string) => void
  onBaseDateChange: (value: string) => void
  /** 评估目的（空串 = 未指定）。 */
  onPurposeChange: (value: string) => void
  /** 价值类型（空串 = 未指定）。 */
  onValueTypeChange: (value: string) => void
  onPromptChange: (value: string) => void
  /** 「核对资料」：递归校验 + 字节归档 + 元信息回显。 */
  onConfirm: () => void
  /** 准备核对期间真实存在的「返回修改」（作废在途请求、回到可编辑草稿）。 */
  onBackToEdit: () => void
  /**
   * 主操作按钮的 ref（由外层持有）。
   *
   * 抽屉关闭时焦点要回到**同一个**「核对资料」按钮：这一页在抽屉打开期间只是隐藏、没有卸载，
   * 所以把外层拿到的 ref 挂上去，`SideDrawer.returnFocusTo` 就能把焦点还回来。
   */
  primaryRef?: React.MutableRefObject<HTMLButtonElement | null>
}

/** 默认展开到首批最多 8 个文件行（设计稿 §8.2）。 */
const VISIBLE_FILE_LIMIT = 8

/** 撤销提示的存活时间。 */
const UNDO_WINDOW_MS = 8_000

/** 目录摘要：只取最后两层，太长的话没有信息量。 */
function shortDir(dir: string): string {
  if (dir === '') return ''
  const parts = dir.split(/[\\/]/).filter((part) => part !== '')
  return parts.slice(-2).join('/')
}

/**
 * 资产类型下拉的选项：**集合来自共享合同**，显示文案只在这里映射。
 *
 * 显示名不承担路由 —— 提交给 Host 的永远是稳定业务标识（`real-estate`）。
 */
function assetTypeOptions(): SelectOption[] {
  return ASSET_TYPES.map((value) => ({
    value,
    label: value === 'real-estate' ? zhCN.valuationAssetTypeRealEstate : value,
  }))
}

/**
 * 方法选项：四项**全部可选**（协议 39）。
 *
 * 「自动判定」是一个明确的用户选项，带一枚轻量「推荐」标记，但**不是默认值** ——
 * 新草稿里它是未选状态（`state.method === ''`）。
 */
function methodOptions(): SelectOption[] {
  return valuationMethodOptions().map((option) => ({
    value: option.value,
    label: option.label,
    hint: option.hint,
    ...(option.value === 'auto' ? { badge: zhCN.valuationMethodRecommended } : {}),
  }))
}

/** 一份资料（真实文件行）：类型图标 + 文件名 + 元信息 + 状态 + 移除/重新纳入。 */
function SubFileRow(props: {
  file: ValuationFileRowView
  scanState: ValuationPageState['scanState']
  disabled: boolean
  onExclude: (path: string) => void
  onReinclude: (path: string) => void
  /** 登记移除按钮：移除之后焦点要落到"下一份"（设计稿 §17.1），不能掉到 body。 */
  registerRef: (path: string, node: HTMLButtonElement | null) => void
}): React.ReactElement {
  const { file } = props
  const status = fileStatusOf(file, props.scanState)
  const kind = file.kind === '' ? fileKindOf(file.name) : file.kind
  return <li
    className="crwu-valuation-subfile"
    data-valuation-subfile={file.path}
    data-valuation-subfile-state={status.key}
  >
    <span className="crwu-valuation-subfile-icon" aria-hidden="true"><FileIcon size={14} /></span>
    <span className="crwu-valuation-subfile-main">
      <span className="crwu-valuation-subfile-name" title={file.path}>{file.name}</span>
      {/* 同名材料才附目录摘要：每一行都顶一长串路径，扫一眼还是认不出是哪一份。 */}
      {file.parentPath === '' || shortDir(file.parentPath) === '' ? null
        : <span className="crwu-valuation-subfile-meta">
          <span>{fileKindLabel(kind)}</span>
          <span>{sizeTextOf(file.sizeBytes)}</span>
        </span>}
    </span>
    <span className="crwu-valuation-subfile-status">{status.text}</span>
    <span className="crwu-valuation-subfile-actions">
      {file.state === 'excluded'
        ? <Button
          variant="text"
          size="sm"
          className="crwu-valuation-reinclude"
          disabled={props.disabled}
          aria-label={`${zhCN.valuationReinclude}：${file.name}`}
          onClick={() => { props.onReinclude(file.path) }}
        >{zhCN.valuationReinclude}</Button>
        : <IconButton
          variant="text"
          className="crwu-valuation-file-remove"
          label={`${zhCN.valuationFileRemove}：${file.name}`}
          buttonRef={(node) => { props.registerRef(file.path, node) }}
          disabled={props.disabled}
          onClick={() => { props.onExclude(file.path) }}
        ><CloseIcon size={12} /></IconButton>}
    </span>
  </li>
}

/**
 * 一个选择入口：文件夹可展开到真实文件；移除入口是**独立**按钮，不触发展开。
 *
 * 折叠是**真的**收起：`aria-expanded=false` 时子列表**不渲染**，于是被收起的后代
 * 也不在键盘顺序里（以前的条件是 `(isFolder && rows.length > 0) || open`，
 * 于是有文件的目录**永远**展开 —— 那个箭头点了没有任何效果）。
 */
function EntryRow(props: {
  entry: ValuationSelectedFileView
  rows: ValuationFileRowView[]
  scanState: ValuationPageState['scanState']
  disabled: boolean
  open: boolean
  showAll: boolean
  onToggle: (path: string) => void
  onShowAll: () => void
  onRemove: (path: string) => void
  onExclude: (path: string) => void
  onReinclude: (path: string) => void
  registerRef: (path: string, node: HTMLButtonElement | null) => void
}): React.ReactElement {
  const { entry } = props
  const isFolder = entry.kind === 'directory' || entry.fileCount > 1 || props.rows.length > 1
  const included = props.rows.filter((row) => row.state === 'included').length
  const visible = props.showAll ? props.rows : props.rows.slice(0, VISIBLE_FILE_LIMIT)
  const hidden = props.rows.length - visible.length
  const status = entryStatusText(entry.status)
  const groupId = `crwu-valuation-group-${encodeURIComponent(entry.path).replace(/%/g, '')}`
  const expandable = isFolder && props.rows.length > 0
  return <li className="crwu-valuation-entry" data-valuation-entry={entry.path}
    data-valuation-entry-kind={isFolder ? 'directory' : 'file'}>
    <div className="crwu-valuation-entry-head">
      {expandable
        ? <button
          type="button"
          className="crwu-valuation-entry-toggle"
          aria-expanded={props.open}
          aria-controls={groupId}
          aria-label={(props.open ? zhCN.valuationFolderCollapse : zhCN.valuationFolderExpand)
            .replace('{name}', entry.name)}
          onClick={() => { props.onToggle(entry.path) }}
        >
          <FolderIcon size={14} />
          {/* 展开箭头：只做视觉（rotate 由 CSS 按 aria-expanded 驱动），语义由按钮自己承担。 */}
          <span className="crwu-valuation-entry-chevron" aria-hidden="true">›</span>
          <span className="crwu-valuation-entry-name" title={entry.path}>{entry.name}</span>
        </button>
        : <span className="crwu-valuation-entry-toggle crwu-valuation-entry-static">
          <span className="crwu-valuation-entry-icon" aria-hidden="true"><FileIcon size={14} /></span>
          <span className="crwu-valuation-entry-name" title={entry.path}>{entry.name}</span>
        </span>}
      <span className="crwu-valuation-entry-meta">
        {isFolder
          ? zhCN.valuationFolderIncluded.replace('{count}', String(props.rows.length))
          : [fileKindLabel(fileKindOf(entry.name)), sizeTextOf(entry.sizeBytes)].filter((one) => one !== '').join(' · ')}
      </span>
      {included === 0 && props.rows.length > 0
        ? <span className="crwu-valuation-entry-status">{zhCN.valuationFileStatusRemoved}</span>
        : null}
      {/* 入口状态：`scanned` 与"文件夹 · 纳入 N 份"说的是同一件事，重复显示只是噪音（UX-13）。 */}
      {status === '' || status === zhCN.valuationFileStatusScanned
        ? null
        : <span className="crwu-valuation-entry-status">{status}</span>}
      <Button
        variant="text"
        size="sm"
        className="crwu-valuation-entry-remove"
        disabled={props.disabled}
        aria-label={`${zhCN.valuationFolderRemove}：${entry.name}`}
        title={`${zhCN.valuationFolderRemove}：${entry.name}`}
        onClick={() => { props.onRemove(entry.path) }}
      >{isFolder ? zhCN.valuationFolderRemove : zhCN.valuationFileRemove}</Button>
    </div>
    {entry.reason === '' ? null : <p className="crwu-valuation-entry-reason">{entry.reason}</p>}
    {expandable && props.open
      ? <ul className="crwu-valuation-sublist" id={groupId} data-valuation-subfile-group={entry.path}>
        {visible.map((row) => <SubFileRow
          key={row.path}
          file={row}
          scanState={props.scanState}
          disabled={props.disabled}
          onExclude={props.onExclude}
          onReinclude={props.onReinclude}
          registerRef={props.registerRef}
        />)}
      </ul>
      : null}
    {expandable && props.open && (hidden > 0 || (props.showAll && props.rows.length > VISIBLE_FILE_LIMIT))
      ? <Button variant="text" size="sm" className="crwu-valuation-more" onClick={props.onShowAll}>
        {props.showAll
          ? zhCN.valuationFilesShowLess
          : zhCN.valuationFilesShowAll.replace('{count}', String(props.rows.length))}
      </Button>
      : null}
  </li>
}

/** 一份"只知道路径"的回落行（旧宿主 / 未扫描完成时用；不假装知道大小）。 */
function fallbackEntries(state: ValuationPageState): ValuationSelectedFileView[] {
  if (state.files.length > 0) return state.files
  return state.selection.map((path) => ({
    path,
    name: path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path,
    dirHint: '', kind: '', sizeBytes: 0, status: 'reading', reason: '', fileCount: 1,
  }))
}

export function ValuationIntakePane(props: ValuationIntakePaneProps): React.ReactElement {
  const { state } = props
  const instanceId = useInstanceId('crwu-valuation-intake')
  const fieldId = (name: string): string => `${instanceId}-${name}`
  const editable = canEditInputs(state.phase)
  const preparing = state.phase === 'preparing-confirmation'
  /** 每个入口的展开状态：默认展开（员工要看得到里面有什么）。 */
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = React.useState(false)
  const [showSkipped, setShowSkipped] = React.useState(false)
  /** 撤销提示的可见性（8 秒后自己收掉；有焦点时不移除可操作控件）。 */
  const [undoVisible, setUndoVisible] = React.useState(false)
  /** 字段级错误只在"失焦"或"清空过已填值"之后出现 —— 初次进入不是满屏红字。 */
  const [blurred, setBlurred] = React.useState<{ assetType: boolean; method: boolean }>({
    assetType: false, method: false,
  })
  /** 共享 DatePicker 上报的基准日草稿有效性（无效时门禁主操作）。 */
  const [dateValid, setDateValid] = React.useState(true)
  const undoRef = React.useRef<HTMLButtonElement | null>(null)
  const localPrimaryRef = React.useRef<HTMLButtonElement | null>(null)
  const primaryRef = props.primaryRef ?? localPrimaryRef
  const addFilesRef = React.useRef<HTMLButtonElement | null>(null)
  /**
   * 中文输入法合成期间不打上限错误（设计稿 §8.9）。
   *
   * composition 中间态会出现"半个合成串"，那时长度不是用户的最终输入：据此报错就是噪音。
   */
  const composingRef = React.useRef(false)
  /** 移除之后要把焦点交给谁（`''` = 回到「选择文件」）。 */
  const pendingFocusRef = React.useRef<string | null>(null)
  /** 每份文件的移除按钮（按路径登记；同一份资料在多个入口下也只登记最后一次）。 */
  const removeRefs = React.useRef(new Map<string, HTMLButtonElement | null>())
  /** "曾经填过又被清空"的必填项：清空是用户动作，这时给短错误不是噪音。 */
  const clearedRef = React.useRef<{ assetType: boolean; method: boolean }>({
    assetType: false, method: false,
  })
  const previousRef = React.useRef({ assetType: state.assetType, method: state.method })
  if (previousRef.current.assetType !== '' && state.assetType === '') clearedRef.current.assetType = true
  if (previousRef.current.method !== '' && state.method === '') clearedRef.current.method = true
  previousRef.current = { assetType: state.assetType, method: state.method }

  /**
   * 移除之后的焦点落点（§17.1）：下一份文件 → 上一份 → 「选择文件」。
   *
   * 焦点掉到 `body` 上会让键盘用户从头 Tab 一遍，而"刚移除的那一行"已经不在了。
   */
  React.useEffect(() => {
    const target = pendingFocusRef.current
    if (target === null) return
    pendingFocusRef.current = null
    const node = target === '' ? null : removeRefs.current.get(target)
    if (node !== null && node !== undefined) { node.focus?.(); return }
    addFilesRef.current?.focus?.()
    // 依赖 data：文件集合变了才结算一次焦点（不在每次重渲染时抢焦点）。
  }, [state.fileRows])

  const handleExclude = React.useCallback((path: string): void => {
    const included = state.fileRows.filter((row) => row.state === 'included').map((row) => row.path)
    const index = included.indexOf(path)
    const next = index >= 0 ? (included[index + 1] ?? included[index - 1] ?? '') : ''
    pendingFocusRef.current = next
    props.onExcludeFile(path)
  }, [state.fileRows, props.onExcludeFile])

  // 撤销窗口：有新的一次移除就重新计时；准备确认时范围冻结，提示立即消失。
  const removal = state.lastRemoval
  React.useEffect(() => {
    if (removal === null || preparing) { setUndoVisible(false); return }
    setUndoVisible(true)
    const handle = setTimeout(() => { setUndoVisible(false) }, UNDO_WINDOW_MS)
    return () => { clearTimeout(handle) }
  }, [removal, preparing])

  const entries = fallbackEntries(state)
  const rowsByEntry = (path: string): ValuationFileRowView[] =>
    state.fileRows.filter((row) => row.parentPath === path)
  const methods = methodOptions()
  const assetTypes = assetTypeOptions()
  const currentMethod = methods.find((option) => option.value === state.method)

  /** 不能点「核对资料」的原因（空串 = 能点）。禁用理由必须**可见**。 */
  const reason = preparing ? '' : (dateValid ? startDisabledReason(state) : zhCN.valuationBaseDateInvalid)
  const disabled = preparing || reason !== ''

  // 字段级错误：只在失焦 / 清空过之后出现，文案与底栏那句**同一档**（短、可执行）。
  const assetTypeError = state.assetType === ''
    && (blurred.assetType || clearedRef.current.assetType)
    ? zhCN.valuationActionDisabledNoAssetType
    : ''
  const methodError = state.method === ''
    && (blurred.method || clearedRef.current.method)
    ? zhCN.valuationActionDisabledNoMethod
    : ''

  const promptLength = state.supplementalPrompt.length
  const remaining = VALUATION_PROMPT_MAX_LENGTH - promptLength

  return <div className={V.intake}>
    {/* 正文滚动区：工作面是**确定高度的 flex 列**，只有这一层滚（§9.2 的第一方案）。
        底部操作栏因此是真正的 footer（`flex:none`），不再用 sticky 压在内容上面。 */}
    <div className="crwu-valuation-intake-body">
    <section className="crwu-valuation-block" data-valuation-block="files">
      <header className="crwu-valuation-block-head">
        <h3 className="crwu-valuation-block-title">{zhCN.valuationWorkfaceFiles}</h3>
        <div className="crwu-valuation-pick">
          <Button variant="secondary" className={V.btn} buttonRef={addFilesRef} disabled={!editable} onClick={props.onPickFiles}>
            <FileIcon size={14} /> {zhCN.valuationPickFiles}
          </Button>
          <Button variant="secondary" className={V.btn} disabled={!editable} onClick={props.onPickFolder}>
            <FolderIcon size={14} /> {zhCN.valuationPickFolder}
          </Button>
        </div>
      </header>

      {/* 空态是**引导**不是投放区：宿主没有把拖放交过来，所以这里没有 onDrop，文案也不提拖拽。 */}
      {entries.length === 0
        ? <div className="crwu-valuation-empty">
          <p className="crwu-valuation-empty-title">{zhCN.valuationFilesEmptyTitle}</p>
          <p className="crwu-valuation-empty-hint">{zhCN.valuationFilesEmptyHint}</p>
        </div>
        : <ul className="crwu-valuation-files">
          {entries.map((entry) => <EntryRow
            key={entry.path}
            entry={entry}
            rows={rowsByEntry(entry.path)}
            scanState={state.scanState}
            disabled={!editable}
            open={collapsed[entry.path] !== true}
            showAll={showAll}
            onToggle={(path) => { setCollapsed((prev) => ({ ...prev, [path]: prev[path] !== true })) }}
            onShowAll={() => { setShowAll(!showAll) }}
            onRemove={props.onRemoveSelection}
            onExclude={handleExclude}
            onReinclude={props.onReincludeFile}
            registerRef={(path, node) => { removeRefs.current.set(path, node) }}
          />)}
        </ul>}

      {/* 份数明细（含跳过项）只在资料区出现；底栏只放一句可行动摘要。 */}
      <p className="crwu-valuation-count">
        <span className="crwu-valuation-count-num">{scopeCountsText(state)}</span>
        {state.scanState === 'scanning'
          ? <span className="crwu-valuation-count-state">{zhCN.valuationScanRescanning}</span>
          : null}
      </p>
      {/* 一个轻 live region 宣布范围变化；不给每个文件都挂 role=status。 */}
      <p className="crwu-valuation-live" role="status" aria-live="polite">
        {state.scanState === 'ready' && !preparing ? scopeCountsText(state) : ''}
      </p>

      {state.scanSkipped.length > 0
        ? <>
          <Button
            variant="text"
            size="sm"
            className="crwu-valuation-more"
            aria-expanded={showSkipped}
            onClick={() => { setShowSkipped(!showSkipped) }}
          >{showSkipped
              ? zhCN.valuationFilesHideSkipped
              : zhCN.valuationFilesViewSkipped}</Button>
          {showSkipped
            ? <ul className="crwu-valuation-skipped" data-valuation-skipped="true">
              {state.scanSkipped.map((item) => <li key={`${item.path}:${item.reason}`}>
                <span className="crwu-valuation-skipped-name">{item.name}</span>
                <span className="crwu-valuation-skipped-reason">{item.reason}</span>
              </li>)}
            </ul>
            : null}
        </>
        : null}

      {/* 清单被安全上限截断：**禁止确认**，不能把截断数量当全部数量。 */}
      {state.truncated
        ? <p className="crwu-valuation-truncated" role="alert"
          data-valuation-truncated="true">{zhCN.valuationFilesTruncated}</p>
        : null}

      {/* 扫描失败：保留入口与条件，给一次真实的「重新读取清单」。 */}
      {state.scanState === 'failed'
        ? <div className="crwu-valuation-intake-error" role="alert" data-valuation-scan-error="true">
          <strong>{zhCN.valuationScanFailed}</strong>
          <p>{state.scanError}</p>
          <Button variant="secondary" className={V.btn} disabled={!editable} onClick={props.onRescan}>
            {zhCN.valuationScanRetry}
          </Button>
        </div>
        : null}

      {/* 移除后的撤销：只在资料区下方出现一次，保留 8 秒。 */}
      {removal !== null && undoVisible
        ? <div className="crwu-valuation-undobar" data-valuation-undo="true" role="status">
          <span>
            {(removal.kind === 'root' ? zhCN.valuationFilesRemovedFolder : zhCN.valuationFilesRemoved)
              .replace('{name}', removal.name)}
          </span>
          <Button
            variant="secondary"
            className={V.btn}
            buttonRef={undoRef}
            disabled={!editable}
            onClick={props.onUndoRemoval}
          >{zhCN.valuationUndo}</Button>
        </div>
        : null}
    </section>

    {/* ── 两个必填项：紧跟资料区，排在所有可选条件与辅助能力之前 ──────────────
        容器 ≥560px 时并排等宽；更窄时纵向堆叠（容器查询按**面板实际宽度**判断）。 */}
    <section className="crwu-valuation-block" data-valuation-block="required">
      <div className={V.requiredRow}>
        <FormField
          className={V.field}
          id={fieldId('asset-type')}
          label={zhCN.valuationAssetTypeTitle}
          required
          hint={state.assetType === '' ? zhCN.valuationAssetTypeRequired : zhCN.valuationAssetTypeHint}
          error={assetTypeError}
          dataAttributes={{ 'data-valuation-asset-type': 'true' }}
          errorData={{ 'data-valuation-field-error': 'asset-type' }}
        >
          {(field) => <Select
            name="asset-type"
            labelId={field.labelId}
            id={field.id}
            value={state.assetType}
            placeholder={zhCN.valuationAssetTypePlaceholder}
            options={assetTypes}
            disabled={!editable}
            required
            invalid={field.invalid}
            describedBy={field.describedBy}
            dataAttributes={{ 'data-valuation-select': 'asset-type' }}
            optionAttributes={(option) => ({ 'data-valuation-option': option.value })}
            onBlur={() => { setBlurred((prev) => ({ ...prev, assetType: true })) }}
            onChange={props.onAssetTypeChange}
          />}
        </FormField>

        <FormField
          className={V.field}
          id={fieldId('method')}
          label={zhCN.valuationMethodTitle}
          required
          hint={currentMethod === undefined
            ? zhCN.valuationMethodEmptyHint
            : zhCN.valuationMethodHintOnce
              .replace('{label}', currentMethod.label)
              .replace('{hint}', currentMethod.hint ?? '')}
          error={methodError}
          dataAttributes={{ 'data-valuation-method-field': 'true' }}
          hintData={{ 'data-valuation-method-hint': currentMethod?.value ?? '' }}
          errorData={{ 'data-valuation-field-error': 'method' }}
        >
          {(field) => <Select
            name="method"
            labelId={field.labelId}
            id={field.id}
            value={state.method}
            placeholder={zhCN.valuationMethodPlaceholder}
            options={methods}
            disabled={!editable}
            required
            invalid={field.invalid}
            describedBy={field.describedBy}
            dataAttributes={{ 'data-valuation-select': 'method' }}
            optionAttributes={(option) => ({ 'data-valuation-option': option.value })}
            onBlur={() => { setBlurred((prev) => ({ ...prev, method: true })) }}
            onChange={(value) => { props.onMethodChange(value as ValuationMethodChoice) }}
          />}
        </FormField>
      </div>
    </section>

    {/* ── 补充条件 · 可选：三列（宽）/ 两列（中）/ 一列（窄）────────────────── */}
    <section className="crwu-valuation-block" data-valuation-block="conditions">
      <h3 className="crwu-valuation-block-title">
        {zhCN.valuationConditionsTitle}
        <span className={V.fieldOptional}> · {zhCN.valuationPurposeOptional}</span>
      </h3>
      <div className={V.conditions}>
        <FormField
          className={V.field}
          id={fieldId('purpose')}
          label={zhCN.valuationPurposeTitle}
          hint={state.purpose === '' ? zhCN.valuationPurposeHintEmpty : zhCN.valuationPurposeHint}
        >
          {(field) => <TextInput
            id={field.id}
            value={state.purpose}
            disabled={!editable}
            describedBy={field.describedBy}
            placeholder={zhCN.valuationPurposePlaceholder}
            controlClassName="crwu-valuation-purpose"
            data-valuation-purpose="true"
            onChange={(value) => { props.onPurposeChange(value) }}
          />}
        </FormField>

        <FormField
          className={V.field}
          id={fieldId('value-type')}
          label={zhCN.valuationValueTypeTitle}
          hint={state.valueType === '' ? zhCN.valuationValueTypeHintEmpty : zhCN.valuationValueTypeHint}
        >
          {(field) => <TextInput
            id={field.id}
            value={state.valueType}
            disabled={!editable}
            describedBy={field.describedBy}
            placeholder={zhCN.valuationValueTypePlaceholder}
            controlClassName="crwu-valuation-value-type"
            data-valuation-value-type="true"
            onChange={(value) => { props.onValueTypeChange(value) }}
          />}
        </FormField>

        <FormField
          className={V.field}
          id={fieldId('base-date')}
          label={zhCN.valuationBaseDateTitle}
          hint={state.baseDate === '' ? zhCN.valuationBaseDateHintEmpty : zhCN.valuationBaseDateHintFilled}
          dataAttributes={{ 'data-valuation-base-date-field': 'true' }}
        >
          {(field) => <DatePicker
            id={field.id}
            value={state.baseDate}
            disabled={!editable}
            describedBy={field.describedBy}
            onValidityChange={setDateValid}
            onChange={(value) => { props.onBaseDateChange(value) }}
          />}
        </FormField>
      </div>

      <FormField
        className={V.field}
        id={fieldId('prompt')}
        label={zhCN.valuationPromptTitle}
        hint={<>
          {zhCN.valuationPromptHint}
          <span className="crwu-valuation-prompt-count">
            {zhCN.valuationPromptCount
              .replace('{count}', String(promptLength))
              .replace('{limit}', String(VALUATION_PROMPT_MAX_LENGTH))}
          </span>
          {remaining > 0 && remaining <= 400
            ? <span className="crwu-valuation-prompt-count">
              {zhCN.valuationPromptRemaining.replace('{count}', String(remaining))}
            </span>
            : null}
        </>}
        error={state.promptOverLimit
          ? zhCN.valuationPromptOverLimit.replace('{limit}', String(VALUATION_PROMPT_MAX_LENGTH))
          : ''}
        errorData={{ 'data-valuation-prompt-over': 'true' }}
      >
        {(field) => <TextArea
          id={field.id}
          value={state.supplementalPrompt}
          rows={3}
          autoGrow
          maxRows={8}
          disabled={!editable}
          describedBy={field.describedBy}
          invalid={state.promptOverLimit}
          placeholder={zhCN.valuationPromptPlaceholder}
          controlClassName="crwu-valuation-prompt"
          onChange={(value) => {
            if (composingRef.current) return
            props.onPromptChange(value)
          }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={(event) => {
            composingRef.current = false
            props.onPromptChange((event.target as { value?: string }).value ?? '')
          }}
        />}
      </FormField>
    </section>

    {/* ── 信息获取辅助 · 可选 ──────────────────────────────────────────────
        公开信息的辅助能力（当前是链家）的**真实状态**与登录 / 验证入口。它不拦页面：
        未登录、未知或该站失败都不阻止填写与启动，原因随来源策略交给父会话。 */}
    <section className="crwu-valuation-block" data-valuation-block="capability">
      <h3 className="crwu-valuation-block-title">
        {zhCN.valuationCapabilityTitle}
        <span className={V.fieldOptional}> · {zhCN.valuationCapabilityOptional}</span>
      </h3>
      <ValuationCapabilityArea
        state={state}
        onRecheck={props.onCheckCapability}
        onLogin={props.onLoginSite}
        onCancelLogin={props.onCancelLogin}
        onVerify={props.onVerifySite}
      />
    </section>

    {state.error === '' ? null : <div className="crwu-valuation-intake-error" role="alert" data-valuation-intake-error="true">
      <strong>{zhCN.valuationIntakeFailedTitle}</strong>
      <p>{state.error}</p>
    </div>}
    </div>

    {/* 操作区是**确定高度 flex 列**的 footer（`flex:none`），不属于宿主页面的 fixed 底栏：
        它不覆盖任何内容，也不参与正文滚动。 */}
    <div className={V.actionbar}>
      {/*
        左侧**只有一行**：禁用时说的是"为什么不能点"，可用时说的是"下一步做什么"。
        以前这里是两行（摘要 + 原因），而两者在空输入等情形下是同一句话 —— 纯噪音（UX-13）。
      */}
      <span
        className="crwu-valuation-action-line"
        id={V.actionReason}
        {...(reason === '' ? {} : { 'data-valuation-action-reason': 'true' })}
        {...(preparing ? { 'data-valuation-prepare-note': 'true' } : {})}
      >
        {preparing
          ? zhCN.valuationPrepareBusy
          : (reason === '' ? actionSummaryOf(state) : reason)}
      </span>
      {/* 15 秒后的长等待说明是**新信息**（"还能做什么"），保留为第二行。 */}
      {state.slowWait === 'prepare'
        ? <span className="crwu-valuation-hint" data-valuation-slow-wait="prepare">{zhCN.valuationPrepareSlow}</span>
        : null}
      {/* 右侧动作组：摘要永远在左，动作永远在右；窄面板只让这一组自己换行，不拉伸主按钮。 */}
      <span className="crwu-valuation-action-actions">
        {/* 准备中：**唯一**能做的真事就是"返回修改"（它真的会作废在途请求并回到草稿）。 */}
        {preparing
          ? <Button variant="secondary" className={V.btn} onClick={props.onBackToEdit}>
            {zhCN.valuationDrawerBack}
          </Button>
          : null}
        <Button
          variant="primary"
          buttonRef={primaryRef}
          className={`${V.btn} ${V.btnPrimary}`}
          disabled={disabled}
          loading={preparing}
          describedBy={reason === '' ? undefined : V.actionReason}
          onClick={props.onConfirm}
        >{preparing ? zhCN.valuationPreparePending : zhCN.valuationConfirm}</Button>
      </span>
    </div>
  </div>
}
