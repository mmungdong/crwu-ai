import * as React from 'react'
import { FileIcon, FolderIcon, CloseIcon } from '../../../ui/icons.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import {
  canEditInputs,
  valuationMethodOptions,
  type ValuationMethod,
  type ValuationPageState,
  type ValuationSelectedFileView,
} from '../model/valuation-state.ts'

/**
 * 估值输入表单 —— **一个完整的工作面，按任务顺序纵向排列**（§3）。
 *
 * ```text
 * 估值资料            [添加文件] [添加文件夹]
 * 空态上传区 / 紧凑文件列表
 * ─────────────────────────────────────
 * 评估方法
 * 自动判定  市场法  收益法  成本法      ← 紧凑四项，宽屏一行
 * 当前选项的一句说明                     ← 只说一次
 * 评估基准日 · 可选   留空说明
 * ─────────────────────────────────────
 * 补充要求 · 可选
 * 多行输入框
 * ─────────────────────────────────────
 * 已添加 N 份资料                        [检查并确认]
 * ```
 *
 * ## 为什么不再是左右等宽双栏
 *
 * 以前是"左资料 / 右设置"的 1:1 网格。左边只有少量文件时下半屏全空，右边把方法、基准日、
 * 补充要求竖着叠成三张大卡 —— 两栏都难看，而且主操作被推到屏幕下方。**纵向任务流**同时
 * 解决这两件事：内容按用户实际的操作顺序排，主操作跟在最后，工作面上限宽居中。
 *
 * 响应式以**面板实际可用宽度**为准（容器查询），不是浏览器窗口宽度：宿主侧栏展开后
 * 面板可能只有 500px，那时还按窗口宽度套宽屏布局就会横向溢出。
 *
 * ## 这个组件不认识 RPC
 *
 * 它只接收状态与回调，由 controller 落状态与调 Host。"能改输入"的判据只有一处
 *（状态机的 `canEditInputs`），组件不自己判断阶段。
 *
 * ## 「读取状态」只能说实话
 *
 * 逐份资料的状态来自 `valuation-files-scan`（文件名 / 大小 / 读得出来吗）。扫描还没回来时
 * 显示"正在读取资料清单…"，**不预告**某一份能不能解析出来。
 */

export interface ValuationIntakePaneProps {
  state: ValuationPageState
  onPickFiles: () => void
  onPickFolder: () => void
  onRemoveSelection: (path: string) => void
  onMethodChange: (method: ValuationMethod) => void
  onBaseDateChange: (value: string) => void
  onPromptChange: (value: string) => void
  /** 「检查并确认」：进入提取。 */
  onStart: () => void
  /** 提取中「取消提取」。 */
  onCancelIntake: () => void
}

/** 超过这个份数就先只画前几条（后面的设置不能被一堆文件推到很远）。 */
const VISIBLE_FILE_LIMIT = 8

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 目录摘要：只取最后两层，太长的话没有信息量。 */
function shortDir(dir: string): string {
  if (dir === '') return ''
  const parts = dir.split(/[\\/]/).filter((part) => part !== '')
  return parts.slice(-2).join('/')
}

function fileStatusText(file: ValuationSelectedFileView): string {
  if (file.status === 'scanned') return zhCN.valuationFileStatusScanned
  if (file.status === 'skipped') return zhCN.valuationFileStatusSkipped
  return zhCN.valuationFileStatusUnknown
}

/** 一份资料行：类型图标 + 文件名 + 大小 + 读取状态 + 移除。 */
function FileRow(props: {
  file: ValuationSelectedFileView
  disabled: boolean
  onRemove: (path: string) => void
}): React.ReactElement {
  const { file } = props
  const size = formatBytes(file.sizeBytes)
  return <li className={`crwu-valuation-file${file.status === 'skipped' ? ' crwu-valuation-file-off' : ''}`}>
    <span className="crwu-valuation-file-icon" aria-hidden="true"><FileIcon size={14} /></span>
    <span className="crwu-valuation-file-main">
      {/* 主标题是**文件名**；完整路径留在 `title` 与下面的目录摘要里（用户口径：
          显示完整绝对路径反而认不出是哪一份）。 */}
      <span className="crwu-valuation-file-name" title={file.path}>{file.name}</span>
      <span className="crwu-valuation-file-meta">
        {size === '' ? null : <span>{size}</span>}
        {file.fileCount > 1 ? <span>{zhCN.valuationFileFolderCount.replace('{count}', String(file.fileCount))}</span> : null}
        {file.dirHint === '' ? null : <span className="crwu-valuation-file-dir">{shortDir(file.dirHint)}</span>}
      </span>
      {file.reason === '' ? null : <span className="crwu-valuation-file-reason">{file.reason}</span>}
    </span>
    <span className="crwu-valuation-file-status">{fileStatusText(file)}</span>
    <button
      type="button"
      className="crwu-valuation-file-remove"
      aria-label={`${zhCN.valuationFileRemove}：${file.name}`}
      title={`${zhCN.valuationFileRemove}：${file.name}`}
      disabled={props.disabled}
      onClick={() => { props.onRemove(file.path) }}
    ><CloseIcon size={12} /></button>
  </li>
}

/** 提取进度区：必须落在**当前可视区域内**，并且带 `role="status"`（§11.1）。 */
function IntakeStatus(props: { stage: string }): React.ReactElement {
  const label = props.stage === '' ? zhCN.valuationIntakeStageUnknown : props.stage
  return <div
    className="crwu-valuation-intake-status"
    role="status"
    aria-live="polite"
    data-valuation-intake-status="extracting"
  >
    <span className="crwu-valuation-spinner" aria-hidden="true" />
    <span className="crwu-valuation-intake-status-label">{zhCN.valuationIntakeRunning}</span>
    <span className="crwu-valuation-intake-status-stage">{label}</span>
  </div>
}

export function ValuationIntakePane(props: ValuationIntakePaneProps): React.ReactElement {
  const { state } = props
  const busy = state.phase === 'extracting'
  const count = state.selection.length
  const [showAll, setShowAll] = React.useState(false)
  /**
   * 焦点回到「检查并确认」（§11.3）。
   *
   * 抽屉关闭 / 「返回修改」之后，刚才那个抽屉整个卸载了 —— 焦点会掉到 `body` 上，
   * 键盘用户得从头 Tab 一遍。所以由**仍然在的**这一侧接手：记住上一帧的阶段，
   * 只要从"抽屉打开过"回到可编辑态，就把焦点送回主操作。
   * 注入式渲染替身里 ref 不接 DOM，`?.` 一路兜底。
   */
  const primaryRef = React.useRef<HTMLButtonElement | null>(null)
  const wasAway = React.useRef(false)
  React.useEffect(() => {
    // 判据与状态机**同一处**（`canEditInputs`）：两套判据打架正是失败后卡死的成因。
    const editable = canEditInputs(state.phase)
    if (!editable) { wasAway.current = true; return }
    if (!wasAway.current) return
    wasAway.current = false
    primaryRef.current?.focus?.()
  }, [state.phase])

  // 逐份事实来自扫描；扫不出来（旧宿主 / 还没扫完）时按"只知道路径"渲染，不假装知道大小。
  const files: ValuationSelectedFileView[] = state.files.length > 0
    ? state.files
    : state.selection.map((path) => ({
      path, name: path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path,
      dirHint: '', kind: '', sizeBytes: 0, status: 'unknown', reason: '', fileCount: 1,
    }))
  const visible = showAll ? files : files.slice(0, VISIBLE_FILE_LIMIT)
  const hidden = files.length - visible.length

  const methods = valuationMethodOptions()
  const current = methods.find((option) => option.value === state.method) ?? methods[0]

  return <div className="crwu-valuation-intake">
    <section className="crwu-valuation-block">
      <header className="crwu-valuation-block-head">
        <h3 className="crwu-valuation-block-title">{zhCN.valuationWorkfaceFiles}</h3>
        <div className="crwu-valuation-pick">
          <button type="button" className="crwu-valuation-btn" disabled={busy} onClick={props.onPickFiles}>
            <FileIcon size={14} /> {zhCN.valuationAddFiles}
          </button>
          <button type="button" className="crwu-valuation-btn" disabled={busy} onClick={props.onPickFolder}>
            <FolderIcon size={14} /> {zhCN.valuationAddFolder}
          </button>
        </div>
      </header>

      {/* 有文件之后收起大上传空态，只留紧凑列表（§4）。
          空态是**引导**不是投放区：宿主没有把拖放交过来，所以这里没有 onDrop，
          文案也不提拖拽 —— 名字同样不叫 drop（那个名字在说一件没做的事）。 */}
      {files.length === 0
        ? <div className="crwu-valuation-empty">
          <p className="crwu-valuation-empty-title">{zhCN.valuationFilesEmptyTitle}</p>
          <p className="crwu-valuation-empty-hint">{zhCN.valuationFilesEmptyHint}</p>
        </div>
        : <ul className="crwu-valuation-files">
          {visible.map((file) => <FileRow
            key={file.path}
            file={file}
            disabled={busy}
            onRemove={props.onRemoveSelection}
          />)}
        </ul>}

      {hidden > 0 || showAll
        ? <button type="button" className="crwu-valuation-more" onClick={() => { setShowAll(!showAll) }}>
          {showAll ? zhCN.valuationFilesShowLess : zhCN.valuationFilesShowAll.replace('{count}', String(files.length))}
        </button>
        : null}

      <p className="crwu-valuation-count">
        <span className="crwu-valuation-count-num">
          {zhCN.valuationSelectedCount.replace('{count}', String(count))}
        </span>
        {state.scanState === 'scanning'
          ? <span className="crwu-valuation-count-state">{zhCN.valuationScanRunning}</span>
          : null}
        {state.scanState === 'failed'
          ? <span className="crwu-valuation-count-error" role="alert">{state.scanError}</span>
          : null}
      </p>
    </section>

    <section className="crwu-valuation-block">
      <h3 className="crwu-valuation-block-title">{zhCN.valuationMethodTitle}</h3>
      {/* 紧凑四项：宽屏一行、窄屏两行 / 纵向（容器查询，见 styles/pane.ts）。
          原生 radio 语义 + 可见标签，键盘可用；选中由底色 + 标识 + 文字共同表达。 */}
      <div className="crwu-valuation-methods" role="radiogroup" aria-label={zhCN.valuationMethodTitle}>
        {methods.map((option) => <label
          key={option.value}
          className={`crwu-valuation-method${state.method === option.value ? ' crwu-valuation-method-on' : ''}`}
        >
          <input
            type="radio"
            name="crwu-valuation-method"
            value={option.value}
            checked={state.method === option.value}
            disabled={busy}
            onChange={() => { props.onMethodChange(option.value) }}
          />
          <span className="crwu-valuation-method-label">{option.label}</span>
        </label>)}
      </div>
      {/* 当前选项的说明**只在这里出现一次**（以前每张卡各带一段说明，视觉重量过高）。 */}
      <p className="crwu-valuation-hint" data-valuation-method-hint={current.value}>
        {zhCN.valuationMethodHintOnce.replace('{label}', current.label).replace('{hint}', current.hint)}
      </p>
    </section>

    <section className="crwu-valuation-block">
      <h3 className="crwu-valuation-block-title">
        {zhCN.valuationBaseDateTitle}
        <span className="crwu-valuation-block-optional"> · {zhCN.valuationBaseDateOptional}</span>
      </h3>
      <input
        type="date"
        className="crwu-valuation-date"
        value={state.baseDate}
        disabled={busy}
        aria-label={zhCN.valuationBaseDateTitle}
        onChange={(event) => { props.onBaseDateChange(event.target.value) }}
      />
      <p className="crwu-valuation-hint">{zhCN.valuationBaseDateHint}</p>
    </section>

    <section className="crwu-valuation-block">
      <h3 className="crwu-valuation-block-title">
        {zhCN.valuationPromptTitle}
        <span className="crwu-valuation-block-optional"> · {zhCN.valuationPromptOptional}</span>
      </h3>
      <textarea
        className="crwu-valuation-prompt"
        rows={4}
        placeholder={zhCN.valuationPromptPlaceholder}
        value={state.supplementalPrompt}
        disabled={busy}
        aria-label={zhCN.valuationPromptTitle}
        onChange={(event) => { props.onPromptChange(event.target.value) }}
      />
      <p className="crwu-valuation-hint">{zhCN.valuationPromptHint}</p>
    </section>

    {/* 进度区跟在工作面里、操作区之前：它必须在**当前可视区域内**，
        不能被后面的大块内容推到页面最下方（§11.1）。 */}
    {busy ? <IntakeStatus stage={state.intakeStage} /> : null}

    {state.phase === 'failed' && state.error !== ''
      ? <div className="crwu-valuation-intake-error" role="alert" data-valuation-intake-error="true">
        <strong>{zhCN.valuationIntakeFailedTitle}</strong>
        {/* §4：失败要给出"具体原因 + 失败阶段 + 可执行动作"。阶段是宿主报的，没拿到就不写。 */}
        {state.failedStage === ''
          ? null
          : <p data-valuation-failed-stage="true">
            {zhCN.valuationFailedAtStage.replace('{stage}', state.failedStage)}
          </p>}
        <p>{state.error}</p>
        <button type="button" className="crwu-valuation-btn" onClick={props.onStart}>
          {zhCN.valuationIntakeRetry}
        </button>
      </div>
      : null}

    {/* 操作区：**面板内**粘性（不是宿主页面的全局固定底栏），所以不会盖住宿主界面。
        始终显示当前资料数量与主操作；提取中换成「取消提取」。 */}
    <div className="crwu-valuation-actionbar">
      <span className="crwu-valuation-action-count">
        {zhCN.valuationSelectedCount.replace('{count}', String(count))}
      </span>
      <span className="crwu-valuation-grow" />
      {busy
        ? <button type="button" className="crwu-valuation-btn" onClick={props.onCancelIntake}>
          {zhCN.valuationIntakeCancel}
        </button>
        : null}
      <button
        type="button"
        ref={primaryRef}
        className="crwu-valuation-btn crwu-valuation-btn-primary"
        disabled={busy || count === 0}
        aria-describedby={count === 0 ? 'crwu-valuation-action-reason' : undefined}
        onClick={props.onStart}
      >
        {busy ? zhCN.valuationIntakeRunning : zhCN.valuationCheckAndConfirm}
      </button>
      {/* 禁用按钮旁边说明原因（§4）。 */}
      {count === 0
        ? <span className="crwu-valuation-hint" id="crwu-valuation-action-reason">
          {zhCN.valuationActionDisabledNoFiles}
        </span>
        : null}
    </div>
  </div>
}
