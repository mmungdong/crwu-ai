import * as React from 'react'
import { text } from '../../../../shared/utils/value.ts'
import { SideDrawer } from '../../../ui/SideDrawer.tsx'
import { FileIcon } from '../../../ui/icons.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import { ValuationCapabilityArea } from './ValuationCapabilityArea.tsx'
import { Button } from '../../../ui/components/index.ts'
import { VALUATION_CLASSES as V } from '../model/styles.ts'
import {
  assetTypeLabelOf,
  createdAtTextOf,
  dirnameOf,
  duplicateNamesOf,
  fileKindLabel,
  fileKindOf,
  formatBytes,
  valuationMethodHintOf,
  valuationMethodLabel,
} from '../model/valuation-state.ts'
import type {
  ArchivedMaterialView,
  ValuationPreviewView,
} from '../../../../shared/contracts/report-evaluation.ts'
import type { ValuationPageState } from '../model/valuation-state.ts'

/**
 * **只读确认抽屉**（设计稿 §10）。
 *
 * ## 它展示什么
 *
 * 1. **本轮估值摘要**：资产类型、评估方法、真实纳入份数、基准日 —— 用轻量键值面呈现，
 *    四个关键事实在第一屏就能扫到（以前三十份文件会把方法与日期推到底部）；
 * 2. **补充条件**：评估目的、价值类型、补充要求（保留原换行的完整用户输入，可展开）；
 * 3. **本次纳入的资料**：文件名是主信息、类型/大小是次信息；完整路径 / 创建时间 / 重复说明
 *    **按需展开**（不再逐行平铺，把主要信息淹掉）；
 * 4. **未纳入项**：默认只给数量与摘要，可展开逐条看原因；
 * 5. **信息获取辅助 · 可选**：链家状态与适用动作。它**不是**估值启动的门禁 ——
 *    未登录 / 未知 / 检查失败都可以继续。
 *
 * 上一版抽屉里塞了知识库状态、已知/缺失字段、冲突表、完整 Prompt、取证能力与输入摘要 ——
 * 那些是**父会话**要做的判断，放在"请核对资料"的抽屉里只会让人以为要在这里改。
 * 它们一个都不许回来；但辅助能力**是允许的环境操作**（登录 / 检查 / 验证），
 * 所以这一版明确把辅助区放进来（旧约束"抽屉里一个能力都不许出现"已作废）。
 *
 * ## 只读是结构性的
 *
 * 资产类型与评估方法**取自 Host 的 `preview`**（`prepareReady` 已经校验过完整性与一致性），
 * 组件不再接收一份可能漂移的草稿方法 —— 因此"抽屉里显示的条件"与"被冻结的输入"
 * 在类型上就是同一份事实。
 *
 * ## 创建期间
 *
 * 点击「开始估值」之后**继续显示同一个抽屉实例**，footer 主按钮变成「正在创建会话…」；
 * X / Escape / 遮罩 / 返回修改四条关闭路径一起失效，并在状态区说明原因（不弹二次确认）。
 */
export interface ValuationConfirmationDrawerProps {
  preview: ValuationPreviewView
  /** 整页状态：辅助区与创建期间的长等待说明都要用它（业务条件仍然只来自 `preview`）。 */
  state: ValuationPageState
  open: boolean
  /** 交接已经开始：主按钮换成「正在创建会话…」、关闭路径全部失效。 */
  creating: boolean
  /** 正在播退出动画（父层 150ms 后卸载）。 */
  closing?: boolean
  /** 创建超过 15 秒的说明（`''` = 还没到）。 */
  slow?: boolean
  onBack: () => void
  onConfirm: () => void
  /** 信息获取辅助区（可选能力，两个 UI 实例共用同一份 controller 动作）。 */
  onCheckCapability: () => void
  onLoginSite: (siteId: string) => void
  onVerifySite: (siteId: string) => void
  onCancelLogin: (jobId: string) => void
  /** 关闭动画完成后由父层把焦点还给「核对资料」。 */
  returnFocusTo?: { current: { focus?: () => void } | null } | null
}

/** 复制成功的短反馈时长（之后恢复原状，不改变按钮 / 行宽，不抢焦点）。 */
export const COPY_FEEDBACK_MS = 1_500

/** 补充要求超过这个长度才给"展开全部"（短内容不需要多一次点击）。 */
export const PROMPT_EXPAND_THRESHOLD = 240

type CopyState = '' | 'done' | 'failed'

/** 复制路径：只写本机剪贴板，不写日志、不进模型（设计稿 §10.3）。 */
export function CopyPathButton(props: { path: string }): React.ReactElement {
  const [state, setState] = React.useState<CopyState>('')
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 卸载时清掉计时器：留一个会写已卸载组件状态的 timer 是最典型的泄漏。 */
  React.useEffect(() => () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
  }, [])
  const copy = (): void => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    // 短确认 1.5 秒后**恢复**（以前 done 一旦置真就再也不下来了）；不抢焦点。
    const settle = (next: Exclude<CopyState, ''>): void => {
      setState(next)
      timer.current = setTimeout(() => {
        timer.current = null
        setState('')
      }, COPY_FEEDBACK_MS)
    }
    try {
      const clipboard = (globalThis as {
        navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } }
      }).navigator?.clipboard?.writeText
      if (typeof clipboard !== 'function') { settle('failed'); return }
      void Promise.resolve(clipboard.call((globalThis as { navigator?: unknown }).navigator, props.path))
        .then(() => { settle('done') })
        .catch(() => { settle('failed') })
    } catch (error) {
      void error
      settle('failed')
    }
  }
  return <>
    <Button variant="text" size="sm" className="crwu-valuation-copy" onClick={copy}>{zhCN.valuationDrawerCopyPath}</Button>
    {/* 复制失败时路径依旧可选中，这里说明"请手动复制"。 */}
    {state === 'done' ? <span className="crwu-valuation-copy-state" role="status">{zhCN.valuationDrawerCopied}</span> : null}
    {state === 'failed' ? <span className="crwu-valuation-copy-state" role="status">{zhCN.valuationDrawerCopyFailed}</span> : null}
  </>
}

/** 一条只读键值（摘要面用；`dl` 的语义靠父子结构，不靠视觉）。 */
function Kv(props: { term: string; children: React.ReactNode; wide?: boolean }): React.ReactElement {
  return <>
    <dt>{props.term}</dt>
    <dd {...(props.wide === true ? { 'data-valuation-kv-wide': 'true' } : {})}>{props.children}</dd>
  </>
}

/** 一份资料的紧凑主行 + 按需展开的完整详情。 */
function FileRow(props: {
  file: ArchivedMaterialView
  duplicated: boolean
  duplicateOfName: string | null
  open: boolean
  onToggle: (fileId: string) => void
}): React.ReactElement {
  const { file } = props
  const kind = file.kind === '' ? fileKindOf(file.fileName) : file.kind
  const size = formatBytes(file.sizeBytes)
  const detailsId = `crwu-valuation-file-details-${file.fileId}`
  return <li className={V.drawerFileRow} data-valuation-drawer-file={file.fileId}>
    <span className="crwu-valuation-drawer-file-icon" aria-hidden="true"><FileIcon size={14} /></span>
    <span className={V.drawerFileMain}>
      <span className="crwu-valuation-drawer-file-name">{file.fileName}</span>
      <span className="crwu-valuation-drawer-file-meta">
        {kind === '' ? null : <span>{fileKindLabel(kind)}</span>}
        {size === '' ? null : <span>{size}</span>}
        {/* 同名材料：主行就给出所在目录，两条同名也分得开（完整路径在详情里）。 */}
        {props.duplicated && dirnameOf(file.absolutePath) !== ''
          ? <span className="crwu-valuation-drawer-file-dir">{dirnameOf(file.absolutePath)}</span>
          : null}
      </span>
    </span>
    <Button
      variant="text"
      size="sm"
      className="crwu-valuation-more crwu-valuation-drawer-file-toggle"
      aria-expanded={props.open}
      aria-controls={detailsId}
      onClick={() => { props.onToggle(file.fileId) }}
    >{props.open ? zhCN.valuationDrawerDetailsHide : zhCN.valuationDrawerDetails}</Button>
    <div className={V.drawerFileDetails} id={detailsId} hidden={!props.open}>
      {/* 原始绝对路径：可换行、可选中复制（核对"我选的是哪一份"靠它）。 */}
      <span className="crwu-valuation-drawer-file-path" data-valuation-drawer-path={file.fileId}>
        {file.absolutePath}
      </span>
      <span className={V.drawerFileTools}>
        {(kind === '' ? null : <span className="crwu-valuation-drawer-file-meta">{fileKindLabel(kind)}</span>)}
        {(size === '' ? null : <span className="crwu-valuation-drawer-file-meta">{size}</span>)}
        {/* 创建时间是 ISO-8601 **UTC** 字面量：必须标注 UTC，避免被读成本地时间。 */}
        <span className="crwu-valuation-drawer-file-meta">
          {zhCN.valuationDrawerCreatedAt.replace('{at}', createdAtTextOf(file.createdAt))}
        </span>
      </span>
      <span className={V.drawerFileTools}>
        <CopyPathButton path={file.absolutePath} />
      </span>
      {/* 重名：附短 fileId（同名不同路径的两条都要分得开）。 */}
      {props.duplicated
        ? <span className="crwu-valuation-drawer-file-dup" data-valuation-drawer-duplicate-name={file.fileId}>
          {zhCN.valuationDrawerDuplicateName.replace('{fileId}', file.fileId)}
        </span>
        : null}
      {/* 重复内容：不同路径、字节相同 —— 两条都留着，只把来源关系写出来。 */}
      {file.duplicateOf === null
        ? null
        : <span className="crwu-valuation-drawer-file-dup" data-valuation-drawer-duplicate-content={file.duplicateOf}>
          {props.duplicateOfName === null
            ? zhCN.valuationDrawerDuplicateContent.replace('{fileId}', file.duplicateOf)
            : zhCN.valuationDrawerDuplicateContentNamed
              .replace('{name}', props.duplicateOfName)
              .replace('{fileId}', file.duplicateOf)}
        </span>}
    </div>
  </li>
}

export function ValuationConfirmationDrawer(props: ValuationConfirmationDrawerProps): React.ReactElement {
  const { preview } = props
  const duplicates = duplicateNamesOf(preview.files)
  const nameOfId = new Map(preview.files.map((file) => [file.fileId, file.fileName]))
  const methodLabel = valuationMethodLabel(preview.methodRequest)
  const methodHint = valuationMethodHintOf(preview.methodRequest)
  const assetLabel = assetTypeLabelOf(preview.assetType)
  /** Host 按 canonical 路径绑定的模板归档件；有 fileId 但找不到行时如实显示 fileId。 */
  const templateFile = preview.templateFileId === null
    ? null
    : (preview.files.find((file) => file.fileId === preview.templateFileId) ?? null)
  const prompt = preview.supplementalPrompt
  const [openFiles, setOpenFiles] = React.useState<Record<string, boolean>>({})
  const [promptExpanded, setPromptExpanded] = React.useState(false)
  const [skippedOpen, setSkippedOpen] = React.useState(false)
  const unspecified = text(preview.purpose) === '' || text(preview.valueType) === ''
    || preview.baseDate === null || preview.baseDate === ''

  // `SideDrawer` 自己管开关动画与 Esc；`open` 为假时父层直接不渲染它。
  if (!props.open) return <></>
  return <SideDrawer
    title={zhCN.valuationDrawerTitle}
    description={zhCN.valuationDrawerSubtitle}
    onClose={props.onBack}
    closing={props.closing === true}
    closeDisabled={props.creating}
    initialFocus="heading"
    returnFocusTo={props.returnFocusTo ?? null}
    // 稳定的测试锚点：抽屉"打开了没有"不该靠猜类名组合。
    dataAttributes={{ 'data-valuation-confirmation-drawer': 'true' }}
    footer={<div className={V.drawerFooter}>
      {/* 创建期间：返回修改不可用（它会让"正在按什么输入创建"变得说不清）。 */}
      <Button
        variant="secondary"
        className={V.btn}
        disabled={props.creating}
        onClick={props.onBack}
      >{zhCN.valuationDrawerBack}</Button>
      <Button
        variant="primary"
        className={`${V.btn} ${V.btnPrimary}`}
        disabled={props.creating}
        loading={props.creating}
        onClick={props.onConfirm}
      >{props.creating ? zhCN.valuationCreatingSession : zhCN.valuationDrawerConfirm}</Button>
    </div>}
  >
    {/* 创建期间的状态说明：**不**覆盖整个抽屉的大 spinner，待核对内容继续可读。 */}
    {props.creating
      ? <p className="crwu-valuation-drawer-status" role="status" data-valuation-creating="true">
        {props.slow === true ? zhCN.valuationCreatingSlow : zhCN.valuationCreatingNote}
        <span className="crwu-valuation-drawer-status-lock">{zhCN.valuationCreatingCannotClose}</span>
      </p>
      : null}

    {/* ── 本轮估值：四个关键事实在第一屏 ─────────────────────────────────── */}
    <section className={V.drawerSummary} data-valuation-drawer-summary="true">
      <h4>{zhCN.valuationDrawerSummary}</h4>
      <dl className={V.drawerKv}>
        <Kv term={zhCN.valuationDrawerAssetTitle}>
          <span data-valuation-readonly="assetType">
            {assetLabel === '' ? zhCN.valuationDrawerUnspecified : assetLabel}
          </span>
        </Kv>
        <Kv term={zhCN.valuationDrawerMethodTitle}>
          <span data-valuation-readonly="method">
            {methodLabel === '' ? zhCN.valuationDrawerUnspecified : methodLabel}
          </span>
        </Kv>
        <Kv term={zhCN.valuationDrawerDataCount}>
          <span data-valuation-readonly="fileCount">
            {zhCN.valuationDrawerFileCount.replace('{count}', String(preview.files.length))}
          </span>
        </Kv>
        <Kv term={zhCN.valuationDrawerBaseDateTitle}>
          <span data-valuation-readonly="baseDate">
            {preview.baseDate === null || preview.baseDate === ''
              ? zhCN.valuationDrawerNoBaseDate
              : preview.baseDate}
          </span>
        </Kv>
        <Kv term="计算表模板">
          <span data-valuation-readonly="template">
            {preview.templateFileId === null
              ? '未指定'
              : (templateFile === null ? preview.templateFileId : templateFile.fileName)}
          </span>
        </Kv>
      </dl>
      {/* 方法说明**与本次选择相符**（自动判定与三种指定方法各说各的）。 */}
      {methodLabel === ''
        ? null
        : <p className="crwu-valuation-hint" data-valuation-drawer-method-hint={preview.methodRequest}>
          {methodHint === '' ? methodLabel : zhCN.valuationMethodHintOnce
            .replace('{label}', methodLabel)
            .replace('{hint}', methodHint)}
        </p>}
    </section>

    {/* ── 补充条件 ──────────────────────────────────────────────────────── */}
    <section className={V.drawerSummary} data-valuation-drawer-conditions="true">
      <h4>{zhCN.valuationDrawerConditions}</h4>
      <dl className={V.drawerKv}>
        <Kv term={zhCN.valuationDrawerPurposeTitle}>
          <span data-valuation-readonly="purpose">
            {text(preview.purpose) === '' ? zhCN.valuationDrawerNoPurpose : preview.purpose}
          </span>
        </Kv>
        <Kv term={zhCN.valuationDrawerValueTypeTitle}>
          <span data-valuation-readonly="valueType">
            {text(preview.valueType) === '' ? zhCN.valuationDrawerNoValueType : preview.valueType}
          </span>
        </Kv>
      </dl>
      <div className="crwu-valuation-drawer-blocks">
        <span className="crwu-valuation-drawer-block-title">{zhCN.valuationDrawerPromptTitle}</span>
        {prompt === ''
          ? <p className="crwu-valuation-hint">{zhCN.valuationDrawerPromptNone}</p>
          : <>
            {/* 用户原文：保留换行；长内容可展开，展开后进入**同一条**正文滚动。 */}
            <p className="crwu-valuation-drawer-prompt" data-valuation-readonly="prompt">
              {!promptExpanded && prompt.length > PROMPT_EXPAND_THRESHOLD
                ? `${prompt.slice(0, PROMPT_EXPAND_THRESHOLD)}…`
                : prompt}
            </p>
            {prompt.length > PROMPT_EXPAND_THRESHOLD
              ? <Button
                variant="text"
                size="sm"
                className="crwu-valuation-more"
                aria-expanded={promptExpanded}
                onClick={() => { setPromptExpanded(!promptExpanded) }}
              >{promptExpanded ? zhCN.valuationDrawerPromptCollapse : zhCN.valuationDrawerPromptExpand}</Button>
              : null}
          </>}
      </div>
      {/* 未指定条件的**必要影响**合并成一条（不逐字段各附一段提示）。 */}
      {unspecified
        ? <p className="crwu-valuation-hint" data-valuation-drawer-unspecified="true">
          {zhCN.valuationDrawerUnspecifiedNote}
        </p>
        : null}
    </section>

    {/* ── 本次纳入的资料 ────────────────────────────────────────────────── */}
    <section className={V.drawerSummary} data-valuation-drawer-files-section="true">
      <h4>
        {zhCN.valuationDrawerFiles}
        <span className="crwu-valuation-drawer-count">
          {zhCN.valuationDrawerFileCount.replace('{count}', String(preview.files.length))}
        </span>
      </h4>
      {/* 选的是文件夹时，展示的是**实际归档文件**（不再只显示入口文件夹名）。 */}
      <ul className="crwu-valuation-drawer-files">
        {preview.files.map((file) => <FileRow
          key={file.fileId}
          file={file}
          duplicated={duplicates.has(file.fileName)}
          duplicateOfName={file.duplicateOf === null ? null : (nameOfId.get(file.duplicateOf) ?? null)}
          open={openFiles[file.fileId] === true}
          onToggle={(fileId) => {
            setOpenFiles((prev) => ({ ...prev, [fileId]: prev[fileId] !== true }))
          }}
        />)}
      </ul>
      {duplicates.size === 0
        ? null
        : <p className="crwu-valuation-drawer-note">
          {zhCN.valuationDrawerDuplicateNames.replace('{count}', String(duplicates.size))}
        </p>}
    </section>

    {/* 未纳入项属于"资料范围说明"：默认只给数量，原因按需展开。 */}
    {preview.skipped.length === 0
      ? null
      : <section className={V.drawerSummary} data-valuation-drawer-skipped="true">
        <Button
          variant="text"
          size="sm"
          className="crwu-valuation-more"
          aria-expanded={skippedOpen}
          aria-controls="crwu-valuation-drawer-skipped-list"
          onClick={() => { setSkippedOpen(!skippedOpen) }}
        >{zhCN.valuationDrawerSkippedTitle.replace('{count}', String(preview.skipped.length))}</Button>
        <ul className="crwu-valuation-skipped" id="crwu-valuation-drawer-skipped-list" hidden={!skippedOpen}>
          {preview.skipped.map((item) => <li key={item}>
            <span className="crwu-valuation-skipped-name">{item}</span>
          </li>)}
        </ul>
      </section>}

    {/* ── 信息获取辅助 · 可选 ─────────────────────────────────────────────
        这里的资产/方法/材料是**只读输入**；登录、检查、验证属于允许的环境操作。
        未登录 / 未知 / 检查失败都**不是**估值启动的门禁。 */}
    <section className={V.drawerSummary} data-valuation-drawer-capability="true">
      <h4>
        {zhCN.valuationCapabilityTitle}
        <span className="crwu-valuation-drawer-count"> · {zhCN.valuationCapabilityOptional}</span>
      </h4>
      <ValuationCapabilityArea
        state={props.state}
        // 创建期间**不再发起**新的登录 / 验证 / 检查（在途任务仍可取消）。
        locked={props.creating}
        onRecheck={props.onCheckCapability}
        onLogin={props.onLoginSite}
        onCancelLogin={props.onCancelLogin}
        onVerify={props.onVerifySite}
      />
    </section>
  </SideDrawer>
}
