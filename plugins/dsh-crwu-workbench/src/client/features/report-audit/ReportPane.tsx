import * as React from 'react'
import { Button, Loading, LoadingBar, Notice } from '../../components/primitives.tsx'
import { CheckIcon, CopyIcon, DeepSeekIcon, RefreshIcon, SearchIcon } from '../../components/icons.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { stopPresentationOf } from './stop-view.ts'
import type { CloudItem } from '../../../shared/types.ts'
import { isSafeSeqNo } from '../../../shared/consts.ts'
import { Handoff } from '../workbench/Handoff.tsx'
import { workbenchApi } from './api.ts'
import { formatDateTime } from './time.ts'
import type { ReportFilesResult } from './api.ts'
import { discussionPrompt, findDiscussions, type DiscussionFacts } from './assistant-context.ts'
import { askDiscussion, ensureDiscussion, sessionsOfKind, type DiscussionPort, type SessionSummaryLike } from './assistant-session.ts'
import {
  auditArtifactOf, auditGeneratedAtOf, auditRemoteIdOf, buildAuditContextBlock, loadSnapshot,
  reportRemoteIdOf, saveSnapshot, snapshotOf, evidenceOf, reviewUpdatedAtOf, sourcesOf,
  type AuditAnalysisContext,
} from './audit-analysis.ts'
import { changesSince, freshnessOf, type AuditContextSnapshot, type SnapshotChange } from './audit-freshness.ts'
import { asRecord, textOf } from './audit-summary.ts'
import { AuditAnalysisDialog, type AuditAskState } from './AuditAnalysisDialog.tsx'
import { WorkbenchLoading } from '../workbench/LoadingPane.tsx'
import { buildRows, menuActionsOf, pageCount, primaryActionOf, resultItems, riskBadge } from './row.ts'
import type { AuditView, ButtonSpec, RowView, TaskRow } from './types.ts'
import { caseDirOf } from '../../../shared/utils/case-dir.ts'

/**
 * 报告页。
 *
 * 页内两个页签：**报告列表**（氚云记录 + 审核状态）与 **AI 审核列表**（云端交付件）。
 *
 * 形态（用户 2026-09-23 口径）：一层 **Workspace Surface**（白面 + 14px 圆角 + 一层轻阴影）
 * 落在浅灰的 App 底上；页签是浅槽里的 Segmented 白片；工具条 = 搜索 + 刷新；列表是发丝分隔的
 * 现代 Data List；操作列只有「一个主操作 + 小鲸鱼 + 必要时一个 •••」。详见 consts.ts §20。
 *
 * **右侧自绘对话框已撤**（用户 2026-09-22 口径：「这里不设计右侧对话框了，去掉吧」）。
 * 点操作列那枚小鲸鱼只做两件事：
 * 1. 用 crwu **拉一次这份报告的全部文件元数据**（`report-files`：氚云附件 + 本地案例目录 +
 *    云端交付件，只列举不下载），拼进给 AI 的上下文；
 * 2. **有绑定的讨论会话** → 弹一个气泡问「新建对话 / 继续上次聊天」；
 *    **没有** → 直接建一条新会话、注入上下文，并把主面板切到那条原生会话（对话本体、工具卡、
 *    审批、附件都在 DSH 原生那边，我们不再自绘聊天）。
 *
 * 一条重要约束（本仓反复强调的那个坑）：**切标签、翻页、检索都不得重新列举 OSS**。
 * 上云清单只在首次进入、显式刷新、或上传成功后拉取 —— 每次交互都扫一遍 OSS 会让页面
 * 变成几秒一次的对象列举。所以这一页只接收已经拉好的 `ossIndex`。
 */

export interface ReportPaneState {
  tasks: TaskRow[]
  audits: Record<string, AuditView>
  /**
   * 本地的审核记录（含子会话）是否已经查过一次。
   *
   * **为什么要有这个门禁**：行的主操作标签由「有没有审核记录」决定 —— 有记录是「重新审核」，
   * 没记录是「AI 审核」。`pending` 与 `audit-status` 是两个请求，谁先回来不确定，
   * 所以先画行就会出现「AI 审核 → 重新审核」的跳变（用户 2026-09-22 报的一致性缺陷）。
   * 结论：**等审核记录回来再画行**，标签一出现就是最终值；这期间列表区显示中瑞世联等待页。
   */
  auditsReady: boolean
  ossIndex: Record<string, CloudItem>
  ossIndexError: string
  ossLoading: boolean
  formName: string
  query: string
  page: number
  pageSize: number
  total: number
  filterMode: string
  activeKey: string
  /** 按流水号查云端交付件：查的是哪个流水号（回填输入框）。 */
  cloudSearchSeqNo: string
  /** 命中的交付件（0 条 = OSS 上没有这个流水号）。 */
  cloudSearchItems: CloudItem[]
  cloudSearchError: string
  cloudSearchBusy: boolean
  /** 是否已经查过一次（决定要不要显示"没有"——没查过时显示"没有"是错的）。 */
  cloudSearchDone: boolean
  /** Host 说「这次氚云读取被钥匙串拦住了，可以申请免沙箱重试」。 */
  escalateAvailable: boolean
  /** 发起审核失败时留下的手工兜底任务；非空即显示可复制的提示词。 */
  handoff: TaskRow | null
  notice: string
  childAliveHint: string
}

export interface ReportPaneProps {
  state: ReportPaneState
  gating: Parameters<typeof buildRows>[3]
  onSearch: (query: string) => void
  onGoPage: (page: number) => void
  onRefreshPending: () => void
  onRefreshCloud: () => void
  onStart: (task: TaskRow, retry: boolean) => void
  onStop: (childId: string) => void
  onRetryUpload: (key: string) => void
  onOpenCloud: (key: string) => void
  onOpenLocalHtml: (key: string) => void
  onOpenSession: (key: string) => void
  onOpenAuditInfo: (key: string, cloud: CloudItem) => void
  onOpenPath: (path: string) => void
  /**
   * 读一份报告的**已裁剪审核摘要**（`oss-result`），供「AI 审核结果分析会话」构建上下文。
   * 与抽屉走同一个 Host 操作，只是这里要的是数据而不是界面。
   */
  onLoadAuditInfo: (key: string, cloud: CloudItem) => Promise<{ info: Record<string, unknown> | null; error: string }>
  /** 按流水号查云端交付件（用户在输入框里按 Enter 才发，输入过程不发请求）。 */
  onSearchCloud: (seqNo: string) => void
  onClearCloudSearch: () => void
  onEscalateRetry: () => void
  onHandoffCopied: (copied: boolean) => void
  /**
   * 界面本地记下的"我刚点过停止"的时刻（0 = 没点过）。
   *
   * 为什么要本地记：`audit-stop` 是两阶段的，第一次 `audit-status` 轮询回来之前
   * （POLL 间隔 10 秒）界面必须已经显示「正在请求停止审核…」——
   * 否则用户会以为点了没反应（F1 的 100ms 要求）。
   */
  stopRequestedAt?: number
  /** 「继续等待」：只刷新状态，不再发起停止。 */
  onRefreshStatus?: () => void
  /** 「复制诊断」：把当前审核的停止诊断复制到剪贴板。 */
  onCopyDiagnostics?: (key: string) => void
  handoffCopied: boolean
  /** 环境里选中的工作空间（讨论会话建在它下面，也写进注入给 AI 的报告事实里）。 */
  workspace: { id: string; path: string }
  /** 客户端会话服务：讨论面板靠它建/复用真实会话（可能缺席）。 */
  port: DiscussionPort
  /** 在原生对话里打开讨论会话（切主面板回 conversation）。 */
  onOpenDiscussion: (sessionId: string) => void
}

/** 触发元素自己的 rect（浮层按它定位；列表层拿去做 fixed 浮层）。 */
type AnchorRect = { left: number; right: number; top: number; bottom: number }

/**
 * 复用的搜索组件（报告列表与 AI 审核列表是**同一个**）。
 *
 * 只支持流水号一条查询路径：输入过程不发请求，**Enter 才发起**；清空是输入框右侧那个 ×。
 * 没有「搜索 / 清空」两个传统按钮 —— 那是把网页表单的习惯带进工作台。
 */
function SearchField(props: {
  value: string
  placeholder: string
  ariaLabel: string
  onChange: (value: string) => void
  onSubmit: () => void
  onClear: () => void
}): React.ReactElement {
  return <span className={C.searchWrap}>
    <span className={C.searchGlyph} aria-hidden={true}><SearchIcon size={15} /></span>
    <input
      className={C.input}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onChange={(event) => { props.onChange(String((event.target as { value?: unknown }).value ?? '')) }}
      onKeyDown={(event) => {
        if ((event as unknown as { key?: string }).key !== 'Enter') return
        props.onSubmit()
      }}
    />
    {props.value === '' ? null : <button
      type="button"
      className={C.searchClear}
      aria-label={zhCN.clear}
      title={zhCN.clear}
      onClick={props.onClear}
    >×</button>}
  </span>
}

/** 一个按钮描述 → 元素。`confirm` 由组件本地状态承担（两段式点击）。 */
function RowButtons(props: {
  view: RowView
  onStart: (retry: boolean) => void
  onStop: () => void
  onRetryUpload: () => void
  onOpenCloud: () => void
  onOpenAuditInfo: () => void
  onOpenLocalHtml: () => void
  onDiscuss: () => void
  discussing: boolean
  /** 菜单是否开着（由列表层决定；行自己不持有 open，避免同时开多个）。 */
  menuOpen: boolean
  onToggleMenu: (rect: AnchorRect) => void
  onShowTip: (rect: AnchorRect) => void
  onHideTip: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false)
  const primary = primaryActionOf(props.view)
  const menu = menuActionsOf(props.view)

  const rectOf = (element: { getBoundingClientRect?: () => DOMRect } | null): AnchorRect => {
    const rect = element?.getBoundingClientRect?.()
    return rect === undefined
      ? { left: 0, right: 0, top: 0, bottom: 0 }
      : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }

  /** 主操作的派发（菜单项的动作由列表层统一派发，见 ReportPane.handleMenuAction）。 */
  const handlerOf = (id: string): (() => void) => {
    if (id === 'cloud-report') return props.onOpenCloud
    return props.onDiscuss
  }

  // 一行只有三样东西：**一个主操作 + 小鲸鱼 + 必要时一个 •••**（用户 2026-09-22 口径）。
  // 其余动作一律进菜单，状态信息一律不进这一列。
  return <div className={C.rowActions}>
    {primary === null ? null : (primary.id === 'progress'
      // 「审核中」不是可点的任务按钮：它只是主位上的一个状态（避免重复触发）。
      ? <span className={C.progressChip}>{primary.label}</span>
      : (primary.confirm === true && confirming
          ? <>
              <Button
                label={`确认${primary.label}`}
                tone="warn"
                small
                onClick={() => { setConfirming(false); props.onStart(primary.retry === true) }}
              />
              <Button label="取消" small onClick={() => { setConfirming(false) }} />
            </>
          : <Button
              label={primary.label}
              tone={primary.tone}
              disabled={primary.disabled}
              onClick={() => {
                if (primary.confirm === true) { setConfirming(true); return }
                if (primary.id === 'start') { props.onStart(primary.retry === true); return }
                handlerOf(primary.id)()
              }}
            />))}

    {/* 与 DeepSeek 讨论这份报告：唯一的会话入口（「查看会话」文字按钮已删除）。
        提示是**浮层 Tooltip**（渲染在表格之外，悬停立刻出现、带箭头），不用原生 title。 */}
    <button
      type="button"
      className={C.aiRowBtn}
      aria-label={zhCN.aiRowButton}
      disabled={props.discussing}
      onMouseEnter={(event) => { props.onShowTip(rectOf(event?.currentTarget ?? null)) }}
      onMouseLeave={props.onHideTip}
      onFocus={(event) => { props.onShowTip(rectOf(event?.currentTarget ?? null)) }}
      onBlur={props.onHideTip}
      onClick={props.onDiscuss}
    >
      <DeepSeekIcon size={18} />
    </button>

    {/* •••：Ghost Icon Button；菜单本身由**列表层**渲染成浮层（见 ReportPane）。
        打开时按钮保持一层略深的底，用户一眼知道菜单属于哪一行。 */}
    {menu.length === 0 ? null : <button
      type="button"
      className={[C.menu, props.menuOpen ? C.menuOpen : ''].filter((one) => one !== '').join(' ')}
      aria-haspopup="menu"
      aria-expanded={props.menuOpen}
      aria-label={zhCN.moreActions}
      onClick={(event) => { props.onToggleMenu(rectOf(event?.currentTarget ?? null)) }}
    >•••</button>}
  </div>
}

/** 流水号单元格：等宽文字 + 悬停才浮出的复制图标（复制完短暂变成对勾）。 */
function SeqNoCell(props: {
  value: string
  copied: boolean
  onCopy: () => void
}): React.ReactElement {
  return <span className={C.seq}>
    <span className={C.mono}>{props.value}</span>
    <button
      type="button"
      className={[C.seqCopy, props.copied ? C.seqCopyOn : ''].filter((one) => one !== '').join(' ')}
      aria-label={zhCN.copySeqNo}
      title={props.copied ? zhCN.copied : zhCN.copySeqNo}
      onClick={props.onCopy}
    >{props.copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}</button>
  </span>
}

function PendingTable(props: ReportPaneProps & {
  rows: RowView[]
  /** 正在拉这份报告的文件（按钮禁用，防连点）。 */
  discussing: string
  /** 点那枚小鲸鱼：拉文件 → 问用户 / 直接进新对话。 */
  onDiscuss: (key: string) => void
  /** 刚复制过的流水号（短暂显示对勾）。 */
  copiedSeq: string
  onCopySeq: (value: string) => void
  /** 当前开着菜单的那一行（列表层持有，天然只有一个）。 */
  openMenuKey: string
  onToggleMenu: (key: string, rect: AnchorRect) => void
  onShowTip: (key: string, rect: AnchorRect, kind?: 'discuss' | 'analyze') => void
  onHideTip: () => void
}): React.ReactElement {
  const { state } = props
  // 首屏/翻页/检索都可能还没拿到数据：这时说「暂无报告」是错的（上一秒还在加载）。
  if (props.rows.length === 0) {
    return props.gating.busy === true ? <Loading text={zhCN.loadingList} /> : <div className={C.empty}>
      <div>{zhCN.noRows}</div>
    </div>
  }
  return <div className={C.tableWrap}><table className={C.table}>
    {/* 列宽分工写在 colgroup + consts.ts 的 .crwu-audit-col-* 里：
        auto 布局会把多出来的宽度全给最宽的那一列（实测 1920px 视口时「报告名称」涨到 696px），
        于是右边一直很挤。fixed 布局 + 百分比让整张表严格等于容器宽度、各列按分工分配。 */}
    <colgroup>
      <col className={C.colName} />
      <col className={C.colSeqNo} />
      <col className={C.colRisk} />
      <col className={C.colReview} />
      <col className={C.colModified} />
      <col className={C.colAction} />
    </colgroup>
    <thead><tr>
      <th className={C.th}>{zhCN.colName}</th>
      <th className={C.th}>{zhCN.colSeqNo}</th>
      <th className={C.th}>{zhCN.colRisk}</th>
      <th className={C.th}>{zhCN.colReview}</th>
      <th className={C.th}>{zhCN.colModified}</th>
      <th className={C.th}>{zhCN.colAction}</th>
    </tr></thead>
    <tbody>
      {state.tasks.map((task, index) => {
        const view = props.rows[index]
        if (view === undefined) return null
        const risk = riskBadge(task.risk)
        return <tr key={view.key} className={[C.tbodyRow, props.openMenuKey === view.key ? C.tbodyRowOn : ''].filter((one) => one !== '').join(' ')}>
          <td className={`${C.td} ${C.tdName}`}>
            {/* 这份表单里 name 常常就等于流水号，重复显示既没用又占宽度：
                主行一律给项目名，名字与流水号不同（别的表单）时才补一行。 */}
            <div className={C.cellTitle}>{task.project === '' ? task.name : task.project}</div>
            {task.project !== '' && task.name !== task.seqNo
              ? <div className={C.cellSub}>{task.name}</div>
              : null}
            <div className={C.cellMono}>{task.idTail}</div>
          </td>
          {/* nowrap 列在固定布局里可能被压窄：截断时用 title 兜住完整值。 */}
          <td className={`${C.td} ${C.tdNowrap}`} title={task.seqNo}>
            <SeqNoCell
              value={task.seqNo}
              copied={props.copiedSeq === task.seqNo}
              onCopy={() => { props.onCopySeq(task.seqNo) }}
            />
          </td>
          {/* 风险等级是**扫描信息**，不是装饰：小圆点 + 等级字母，没有底色也没有描边
              （用户 2026-09-22 口径：不要 Ant Design Tag 那种彩色矩形）。 */}
          <td className={`${C.td} ${C.tdNowrap}`} title={`${zhCN.colRisk} ${risk.text}`}>
            <span className={C.risk}>
              <span className={[C.riskDot, dotClassOf(risk.tone)].join(' ')} aria-hidden={true} />
              {risk.text}
            </span>
          </td>
          <td className={`${C.td} ${C.tdReview}`}>
            {/* 主状态 13px、处理节点 12px（两级字重不同），间距 4px。**不新增任何业务枚举**：
                显示的还是氚云给的那两个字段，只是排版分开。 */}
            <div className={C.reviewMain}>{`${task.reviewLevel} · ${task.reviewState}`}</div>
            {task.currentNode === '' ? null : <div className={C.cellSub}>{task.currentNode}</div>}
            {view.badges.map((badge) => <div key={badge.text} className={C.cellSub}>{badge.text}</div>)}
            {/* 门禁说明（"宿主插件是旧构建，请重启 web profile"这类）必须说得出原因：
                它是**状态解释**，所以留在状态列，不进行动区。 */}
            {view.notes.map((note) => <div key={note} className={C.cellSub}>{note}</div>)}
          </td>
          {/* 业务时间**一律保留完整年份**（用户 2026-09-23 口径：禁止「昨天 / 09-20」这类相对时间，
              这是审核留痕系统，跨年数据很容易被误读）。完整原值留在 title 里。 */}
          <td className={`${C.td} ${C.tdNowrap}`} title={task.modifiedAt}>
            <div className={C.mono}>{formatDateTime(task.modifiedAt)}</div>
          </td>
          <td className={`${C.td} ${C.tdAction}`}>
            {/* 行动区只有操作：**一个主操作 + 小鲸鱼 + 必要时一个 •••**。
                状态徽章与备注属于状态列（见 人工复核 列），不在这里占位。 */}
            <RowButtons
              view={view}
              onStart={(retry) => props.onStart(task, retry)}
              onStop={() => props.onStop('')}
              onRetryUpload={() => props.onRetryUpload(view.key)}
              onOpenCloud={() => {
                // **行 key 是流水号，不是 OSS 对象 key**：`oss-link` 会按清单里配置的 prefix
                // 做隔离检查，把裸流水号拒掉。这一行要打开的是它云端交付件里的 HTML。
                const cloud = state.ossIndex[view.key]
                props.onOpenCloud(cloud?.htmlKey ?? '')
              }}
              onOpenAuditInfo={() => {
                const cloud = state.ossIndex[view.key]
                if (cloud !== undefined) props.onOpenAuditInfo(view.key, cloud)
              }}
              onOpenLocalHtml={() => props.onOpenLocalHtml(view.key)}
              onDiscuss={() => { props.onDiscuss(view.key) }}
              discussing={props.discussing !== ''}
              menuOpen={props.openMenuKey === view.key}
              onToggleMenu={(rect) => { props.onToggleMenu(view.key, rect) }}
              onShowTip={(rect) => { props.onShowTip(view.key, rect, 'discuss') }}
              onHideTip={props.onHideTip}
            />
          </td>
        </tr>
      })}
    </tbody>
  </table></div>
}

/** 交付件的**业务语义**：只认「审核报告 / 审核数据」两种，不把 .html/.json 或 OSS 路径端出去。 */
export function fileKindsOf(item: CloudItem): string[] {
  const kinds: string[] = []
  if (item.htmlKey !== '') kinds.push(zhCN.resultFileReport)
  if (item.jsonKey !== '') kinds.push(zhCN.resultFileData)
  return kinds
}

/** AI 审核列表一行的 ••• 菜单（只放真实存在的功能）。 */
export function resultMenuOf(item: CloudItem): ButtonSpec[] {
  const items: ButtonSpec[] = []
  if (item.htmlKey !== '' && item.jsonKey !== '') {
    items.push({ id: 'audit-info', label: zhCN.auditInfo, tone: 'plain', disabled: false })
  }
  if (item.htmlKey !== '' || item.jsonKey !== '') {
    items.push({ id: 'raw-artifact', label: zhCN.rawArtifact, tone: 'plain', disabled: false })
  }
  items.push({ id: 'copy-seqno', label: zhCN.copySeqNo, tone: 'plain', disabled: false })
  return items
}

/** `inFileResolution` 的中文口径（**逐字取交付规范 §6.1 的三态表**；认不出的保留原值）。 */
export function resolutionLabel(code: string): string {
  if (code === 'L-resolved') return zhCN.auditResolutionResolved
  if (code === 'L-open') return zhCN.auditResolutionOpen
  if (code === 'L-unclosed') return zhCN.auditResolutionUnclosed
  if (code === 'L-uncheckable') return zhCN.auditResolutionUncheckable
  return code
}

/**
 * 把审核摘要里的复核信息整理成给模型的**复核意见行**。
 *
 * 用户 §17：按真实数据结构读取，不假设固定三级。所以这里就是**有什么列什么** ——
 * `reviewFiles`（复核文件 + 级次 + 版本 + 时间）与 `reviewItems`（人工意见条目 + 原话 + 落实状态）。
 */
export function reviewLinesOf(info: Record<string, unknown>): string[] {
  const review = asRecord(info.reviewComparison)
  const lines: string[] = []
  const files = Array.isArray(review.reviewFiles) ? review.reviewFiles : []
  for (const raw of files) {
    const file = asRecord(raw)
    const head = [textOf(file.level), textOf(file.displayName), textOf(file.version)]
      .filter((part) => part !== '').join(' · ')
    if (head === '') continue
    const at = textOf(file.occurredAt)
    lines.push(at === '' ? head : `${head}（${formatDateTime(at)}）`)
  }
  const items = Array.isArray(review.reviewItems) ? review.reviewItems : []
  for (const raw of items) {
    const item = asRecord(raw)
    const parts = [
      textOf(item.title),
      textOf(item.reviewerQuote) === '' ? '' : `原话：${textOf(item.reviewerQuote)}`,
      resolutionLabel(textOf(item.inFileResolution)),
      Array.isArray(item.linkedIssueIds) && item.linkedIssueIds.length > 0
        ? `关联 AI 问题：${item.linkedIssueIds.map((id) => textOf(id)).filter((id) => id !== '').join('、')}`
        : '',
    ].filter((part) => part !== '')
    if (parts.length > 0) lines.push(parts.join('；'))
  }
  return lines
}

function ResultsTable(props: ReportPaneProps & {
  items: CloudItem[]
  copiedSeq: string
  onCopySeq: (value: string) => void
  openMenuKey: string
  onToggleMenu: (key: string, rect: AnchorRect, items: ButtonSpec[], cloud: CloudItem) => void
  /** 统一的 DeepSeek 入口：对**这一行**的 AI 审核结果开一次分析会话。 */
  onAnalyze: (cloud: CloudItem) => void
  analyzing: boolean
  onShowTip: (key: string, rect: AnchorRect, kind?: 'discuss' | 'analyze') => void
  onHideTip: () => void
}): React.ReactElement {
  if (props.items.length === 0) {
    return props.state.ossLoading
      ? <Loading text={zhCN.loadingCloud} />
      : <div className={C.empty}>
          <div>{zhCN.noResults}</div>
          <div className={C.emptyHint}>{zhCN.noResultsHint}</div>
        </div>
  }
  return <div className={C.tableWrap}><table className={C.table}>
    {/* 三列分工 38% / 42% / 20%：三列间距不再被 auto 布局极度拉开。 */}
    <colgroup>
      <col className={C.colResSeqNo} />
      <col className={C.colResFiles} />
      <col className={C.colResAction} />
    </colgroup>
    <thead><tr>
      <th className={C.th}>{zhCN.colResultSeqNo}</th>
      <th className={C.th}>{zhCN.colResultFiles}</th>
      <th className={C.th}>{zhCN.colAction}</th>
    </tr></thead>
    <tbody>
      {props.items.map((item) => {
        // 结果页只列**规范交付件**：辅助文件不该出现在「AI审核列表」里。
        const kinds = fileKindsOf(item)
        const menu = resultMenuOf(item)
        const open = props.openMenuKey === item.seqNo
        // 「N 个交付件」取**这一次列举真实看到的对象个数**（`item.files.length`），
        // 语义 Chip 仍是审核报告 / 审核数据；旧宿主没带 files[] 时退回语义条数。
        const deliverableCount = Math.max(item.files.length, kinds.length)
        return <tr key={item.seqNo} className={[C.tbodyRow, open ? C.tbodyRowOn : ''].filter((one) => one !== '').join(' ')}>
          <td className={`${C.td} ${C.tdNowrap}`} title={item.seqNo}>
            <SeqNoCell
              value={item.seqNo}
              copied={props.copiedSeq === item.seqNo}
              onCopy={() => { props.onCopySeq(item.seqNo) }}
            />
          </td>
          <td className={C.td}>
            {/* 交付件按业务语义展示：N 个交付件 + 轻量 Chip（审核报告 / 审核数据）。
                完整 OSS 路径只允许出现在「审核信息」与开发模式里，普通员工不需要知道。 */}
            <div className={C.resultFiles}>
              <span className={C.resultCount}>{zhCN.resultFilesCount.replace('%s', String(deliverableCount))}</span>
              {kinds.map((kind) => <span key={kind} className={C.fileChip}>{kind}</span>)}
            </div>
          </td>
          <td className={`${C.td} ${C.tdAction}`}>
            <div className={C.rowActions}>
              {item.htmlKey === '' ? null : <Button
                label={zhCN.openReport}
                tone="primary"
                onClick={() => { props.onOpenCloud(item.htmlKey) }}
              />}
              {/* 与「报告列表」**同一个 DeepSeek 图标组件 + 同一套 Icon Button 视觉**，
                  靠 Tooltip 区分业务含义：这里是「与 DeepSeek 分析审核结果」。
                  不加文字按钮、不加「可分析 / AI ready」这类噪音 Tag。 */}
              <button
                type="button"
                className={C.aiRowBtn}
                aria-label={zhCN.auditTooltipAnalyze}
                aria-describedby={undefined}
                disabled={props.analyzing}
                onMouseEnter={(event) => {
                  const rect = event?.currentTarget?.getBoundingClientRect?.()
                  props.onShowTip(item.seqNo, rect === undefined
                    ? { left: 0, right: 0, top: 0, bottom: 0 }
                    : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, 'analyze')
                }}
                onMouseLeave={props.onHideTip}
                onFocus={(event) => {
                  const rect = event?.currentTarget?.getBoundingClientRect?.()
                  props.onShowTip(item.seqNo, rect === undefined
                    ? { left: 0, right: 0, top: 0, bottom: 0 }
                    : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, 'analyze')
                }}
                onBlur={props.onHideTip}
                onClick={() => { props.onAnalyze(item) }}
              >
                <DeepSeekIcon size={18} />
              </button>
              {menu.length === 0 ? null : <button
                type="button"
                className={[C.menu, open ? C.menuOpen : ''].filter((one) => one !== '').join(' ')}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={zhCN.moreActions}
                onClick={(event) => {
                  const rect = event?.currentTarget?.getBoundingClientRect?.()
                  props.onToggleMenu(
                    item.seqNo,
                    rect === undefined
                      ? { left: 0, right: 0, top: 0, bottom: 0 }
                      : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                    menu,
                    item,
                  )
                }}
              >•••</button>}
            </div>
          </td>
        </tr>
      })}
    </tbody>
  </table></div>
}

export function ReportPane(props: ReportPaneProps): React.ReactElement {
  const { state } = props
  const [query, setQuery] = React.useState(state.query)
  // 页内标签只是本地视图状态：它**不触发任何 Host 调用**。
  const [view, setView] = React.useState<'pending' | 'results'>('pending')
  // 云端搜索框的输入与校验提示都是**本地**状态：输入过程不碰 Host。
  // （hook 顺序：0=query、1=view、2=cloudSeq、3=cloudHint —— 测试按这个顺序改 state。）
  const [cloudSeq, setCloudSeq] = React.useState(state.cloudSearchSeqNo)
  const [cloudHint, setCloudHint] = React.useState('')
  const rows = buildRows(state.tasks, state.audits, state.ossIndex, props.gating)
  // 逐字段兜底：这几个字段是后加的，父组件/旧 bundle 没给时不能把 undefined 渲染成文案。
  const cloudItems = state.cloudSearchItems ?? []
  const cloudError = state.cloudSearchError ?? ''
  const items = resultItems(state.ossIndex)
  // 正在按流水号看结果时，这一页显示的是**搜索结果**而不是全量云端清单。计数与表格必须同源：
  // 否则会出现「空列表 + 5 项」这种自相矛盾的读数（员工会以为列表坏了）。
  const cloudWatching = state.cloudSearchDone === true && cloudError === ''
  const shownItems = cloudWatching ? cloudItems : items
  const pages = pageCount(state.total, state.pageSize)
  // 翻页期间禁止重复点击（loading 时点了会打出重复请求）。
  const busyPage = props.gating.busy === true

  // 讨论相关：会话列表（订阅 sessions.list）+ 拉取中/气泡/错误三个页内状态。
  const sessions = useSessionRows(props.port)
  const [pulling, setPulling] = React.useState('')
  const [aiError, setAiError] = React.useState('')
  const [ask, setAsk] = React.useState<{ key: string; sessions: SessionSummaryLike[] } | null>(null)
  // **列表层**维护"哪个菜单开着"：行自己不持有 open，天然保证同一时间只有一个菜单
  // （用户 2026-09-22 口径）。切到另一行时浮层是同一个 DOM 节点、left/top 有过渡，
  // 看起来是"滑过去"而不是闪一下。
  const [openMenu, setOpenMenu] = React.useState<{
    key: string; x: number; y: number; flip: boolean; items: ButtonSpec[]; cloud: CloudItem | null
  } | null>(null)
  // 浮层提示带 kind：报告列表那枚是「讨论报告」，AI 审核列表那枚是「分析审核结果」——
  // 同一个图标、同一套浮层，靠文案区分业务含义（用户 §1）。
  const [tip, setTip] = React.useState<{ key: string; x: number; y: number; kind: 'discuss' | 'analyze' } | null>(null)
  const [jump, setJump] = React.useState('')
  const [jumpHint, setJumpHint] = React.useState('')
  // 刚复制过的流水号（1.2s 后自动收掉对勾）；定时器归组件管，卸载时清掉。
  const [copiedSeq, setCopiedSeq] = React.useState('')
  const copyTimer = React.useRef<number | null>(null)
  React.useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  // ── 「AI 审核结果分析会话」的页内状态 ─────────────────────────────────────
  /** 真实阶段（不显示假百分比）；非空即在列表数据区盖中瑞企业 Loading。 */
  const [analysisStage, setAnalysisStage] = React.useState('')
  /** 建立会话前的版本检查对话框（stale / possibly / existing / limited）。 */
  const [auditAsk, setAuditAsk] = React.useState<AuditAskState | null>(null)
  /** 远端资料一项都取不到：**不 fallback 本地**，也不建会话（用户 §8/§16）。 */
  const [remoteMissing, setRemoteMissing] = React.useState<{ mode: 'discuss' | 'analyze'; seqNo: string; canRestart: boolean } | null>(null)
  const [auditBusy, setAuditBusy] = React.useState(false)
  /** 待确认的上下文（用户在对话框里点了哪个选项，就用这一份去建/续会话）。 */
  const pendingAudit = React.useRef<{
    cloud: CloudItem
    context: AuditAnalysisContext
    /** 与注入内容同源的那份快照（保证"存下来的"就是"注入进去的"）。 */
    snapshot: AuditContextSnapshot
    existing: SessionSummaryLike[]
    task: TaskRow | undefined
  } | null>(null)

  /** 复制流水号：剪贴板不可用（老宿主 / 非安全上下文）时静默不改状态，不假装成功。 */
  const copySeqNo = (value: string): void => {
    const clipboard = (globalThis.navigator as { clipboard?: { writeText?: (text: string) => Promise<void> } } | undefined)?.clipboard
    if (typeof clipboard?.writeText !== 'function' || value === '') return
    void clipboard.writeText(value).then(() => {
      setCopiedSeq(value)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        setCopiedSeq((current) => (current === value ? '' : current))
      }, 1200)
    }).catch((cause: unknown) => {
      // 复制失败只是"没复制上"：不改状态、不弹错，用户再点一次即可。
      void cause
    })
  }

  /**
   * 把一行氚云记录翻译成给 AI 的「报告事实」。
   *
   * `remote` 传本次远端拉到的资料（`report-files` 的**氚云附件 + 云端交付件**）：
   * 用户 2026-09-23 强制口径 —— 报告业务会话只允许用远端资料，所以这里**不写工作空间路径、
   * 不写本地案例目录内容**，只把远端资料的来源清单交给模型。
   */
  const factsOf = (key: string, remote?: { lines: string[]; sources: string[]; files: string[] }): DiscussionFacts => {
    const task = state.tasks[rows.findIndex((row) => row.key === key)]
    return {
      seqNo: key,
      // 本次会话唯一的读写目录（与 Host 审核提示词共用同一条约定，见 shared/utils/case-dir.ts）。
      caseDir: caseDirOf(props.workspace.path, key),
      // 氚云记录 id：crwu 靠它列这份报告的附件。
      objectId: task?.id ?? '',
      project: task?.project ?? '',
      name: task?.name ?? '',
      risk: task?.risk ?? '',
      reviewLevel: task?.reviewLevel ?? '',
      reviewState: task?.reviewState ?? '',
      currentNode: task?.currentNode ?? '',
      modifiedAt: task?.modifiedAt ?? '',
      formName: state.formName,
      files: remote?.files ?? (state.ossIndex[key]?.files ?? []).map((file) => `云端交付件 ${file.name}`),
      fetchedAt: new Date().toISOString(),
      sources: remote?.sources ?? [],
    }
  }

  /**
   * 拼注入上下文的那份**远端资料清单**。
   *
   * 用户 2026-09-23 强制口径：报告业务会话**只允许用远端资料**，
   * 所以这里**只列氚云附件与云端交付件** —— 本地案例目录（`pulled.local`）一律不进上下文：
   * 既不给路径，也不给文件名，模型没有任何"本机文件"可引用。本地那份仍然在 Host 侧被列举，
   * 但只用于界面显示与内部实现，不作为会话的业务来源（见 §15 数据边界）。
   *
   * 逐组兜底：旧宿主或异常回包可能缺某一组，缺一组就当那一组为空，不因此崩掉。
   */
  const fileLinesOf = (pulled: ReportFilesResult): string[] => [
    ...(pulled.h3yun ?? []).map((file) => `氚云附件 ${file.name}${file.size > 0 ? `（${formatBytes(file.size)}）` : ''}`),
    ...(pulled.oss ?? []).map((file) => `云端交付件 ${file.name}${typeof file.size === 'number' && file.size > 0 ? `（${formatBytes(file.size)}）` : ''}${file.etag === undefined || file.etag === '' ? '' : ` · ETag ${file.etag.slice(0, 16)}`}`),
  ]

  /** 新建一条讨论会话：注入上下文 + 开场，然后把主面板切到那条原生会话。 */
  /**
   * **新建对话**：重新读一遍当前报告的资料（氚云附件 + 本地案例目录 + **OSS 审核产物**），
   * 注入专业版协作 Prompt，然后跳到新会话。
   *
   * 用户口径（2026-09-22）：「新建对话意味着 Fresh Context，所以即使以前拉取过文件，
   * 也不要直接复用旧会话里的附件上下文」。所以这条路径**一定**重新拉。
   */
  const startNewChat = async (key: string): Promise<void> => {
    setAiError('')
    setPulling(key)
    try {
      // 一次调用取远端资料：氚云附件（权威来源）+ 云端交付件。**本地案例目录不进上下文**。
      let pulled: ReportFilesResult | null = null
      try {
        pulled = await workbenchApi.reportFiles({ seqNo: key, objectId: factsOf(key).objectId })
        if (!pulled.ok && pulled.error !== '') setAiError(pulled.error)
      } catch (cause: unknown) {
        setAiError(describe(cause))
      }
      const lines = pulled === null ? [] : fileLinesOf(pulled)
      // 远端资料一项都取不到 → **不建会话、不找本地替代**（用户 §8/§16）：
      // 直接说"远端资料拿不到"，给重试。
      if (lines.length === 0) {
        setRemoteMissing({ mode: 'discuss', seqNo: key, canRestart: true })
        return
      }
      const facts = factsOf(key, {
        lines,
        files: lines,
        sources: (pulled === null ? [] : sourcesOf({ pulled, cloud: { htmlKey: '', jsonKey: '' }, info: {}, fetchedAt: new Date().toISOString() }))
          .map((ref) => [ref.provider, ref.remoteId, ref.remoteVersion, ref.remoteUpdatedAt === '' ? '' : formatDateTime(ref.remoteUpdatedAt), ref.digest === '' ? '' : `digest ${ref.digest.slice(0, 16)}`].filter((part) => part !== '').join(' · ')),
      })
      // 报告讨论的材料范围（协议 23）：Host 自己重新取一次附件清单，只把那一批 `fileId`
      // 写进内存白名单。**必须在 kickoff 之前**登记 —— 提示词里的落盘名与 fileId 就来自它。
      // `objectId` 为空（这条报告没有氚云记录）时不登记：没有可下载的附件，也不该拦下讨论。
      const objectId = facts.objectId
      const created = await ensureDiscussion({
        port: props.port,
        sessions,
        seqNo: key,
        workspaceId: props.workspace.id,
        workspacePath: props.workspace.path,
        forceNew: true,
        ...(objectId === '' ? {} : {
          openMaterial: async (sessionId: string) => await workbenchApi.discussionMaterialOpen({ sessionId, seqNo: key, objectId }),
        }),
      })
      if (!created.ok) { setAiError(created.error); return }
      // 命名失败要报：会话名就是「报告 ↔ 会话」的映射，没写上名下次点会再建一条。
      if (created.renameError !== undefined) setAiError(created.renameError)
      // 案例目录与材料清单以 **Host 回传的**为准（不拿本地拼的那份去覆盖它）。
      const material = created.material
      const promptFacts = material === undefined
        ? facts
        : {
          ...facts,
          ...(material.caseDir === undefined || material.caseDir === '' ? {} : { caseDir: material.caseDir }),
          ...(material.attachments === undefined ? {} : { materials: material.attachments }),
        }
      const failure = await askDiscussion(props.port, created.id, discussionPrompt(promptFacts, zhCN.aiKickoff, true))
      if (failure !== '') setAiError(failure)
      props.onOpenDiscussion(created.id)
    } finally {
      setPulling('')
    }
  }

  /**
   * **续聊一条已有的讨论会话**：只切会话（不重新拉文件 / 不重新读 OSS / 不重复注入 Prompt），
   * 但**要重新登记材料范围** —— 范围只活在 Host 内存里（插件重启 / 12 小时 TTL 之后即失效），
   * 不登记的话"继续上次聊天"就会取不到附件，而用户看到的又是同一条故障。
   *
   * 登记失败**不拦着进会话**：用户点的是"继续聊"，历史与上下文都在；失败原因如实写进面板，
   * 会话里 `crwu_h3yun_file_get` 也会给出"请重新登记"的可执行文案。
   */
  const continueDiscussion = async (key: string, id: string): Promise<void> => {
    const objectId = factsOf(key).objectId
    if (objectId !== '') {
      try {
        const opened = await workbenchApi.discussionMaterialOpen({ sessionId: id, seqNo: key, objectId })
        if (!opened.ok) setAiError(`${zhCN.aiMaterialFailed}${opened.error === '' ? zhCN.aiMaterialUnknown : opened.error}`)
      } catch (cause: unknown) {
        setAiError(`${zhCN.aiMaterialFailed}${describe(cause)}`)
      }
    }
    props.onOpenDiscussion(id)
  }

  /**
   * 点小鲸鱼：**先解析这份报告的历史会话**，再决定走哪条路。
   *
   * - 已有会话 → 弹选择 Dialog（**这一步不拉任何文件**：用户口径是「继续上次对话…
   *   不要重新拉取报告文件、不要重新读取 OSS、不要重复创建上下文」，目标是"快"）；
   * - 没有会话 → 直接准备资料并新建（不弹确认框）。
   */
  const openDiscussion = async (key: string): Promise<void> => {
    setAiError('')
    const existing = findDiscussions(sessions, key)
    if (existing.length > 0) {
      setAsk({ key, sessions: existing })
      return
    }
    await startNewChat(key)
  }

  /**
   * **AI 审核结果分析会话**（用户 2026-09-23）。
   *
   * 点 DeepSeek 之后**不立刻建会话**，先做一次 Audit Conversation Preflight：
   * 1. 取最新原始资料（`report-files`：氚云附件 + 本地案例目录 + 云端交付件，只列举不下载）；
   * 2. 取该报告的**已裁剪审核摘要**（`oss-result`）——AI 审核报告 / 结构化结果 / 复核意见都在里面；
   * 3. 与上次的 Context Snapshot 比版本（digest → version → etag → mtime → 时间退化）；
   * 4. 按结论决定：直进 / stale 选择框 / possibly 选择框 / 已有会话选择框 / 缺原始资料（Limited）。
   *
   * 全程**不修改任何历史审核产物**：AI Audit T1 / Current Report T2 / 本会话分析 T3 三者独立。
   */
  const runAuditAnalysis = async (cloud: CloudItem): Promise<void> => {
    const key = cloud.seqNo
    const task = state.tasks.find((row) => (row.seqNo !== '' ? row.seqNo : row.name) === key)
    setAiError('')
    setAuditAsk(null)
    setPulling('')
    setAnalysisStage(zhCN.auditStageReport)
    try {
      // 1) 最新原始资料（只列举元数据；模型在会话里按路径回看原文）
      let pulled: ReportFilesResult | null = null
      try {
        pulled = await workbenchApi.reportFiles({ seqNo: key, objectId: task?.id ?? '' })
      } catch (cause: unknown) {
        setAiError(describe(cause))
      }
      // 2) AI 审核报告 + 结构化结果 + 复核意见
      setAnalysisStage(zhCN.auditStageAudit)
      let loaded: { info: Record<string, unknown> | null; error: string } = { info: null, error: '' }
      try {
        loaded = await props.onLoadAuditInfo(key, cloud)
      } catch (cause: unknown) {
        loaded = { info: null, error: describe(cause) }
      }
      if (loaded.error !== '') setAiError(loaded.error)
      const info = loaded.info ?? {}

      // 3) 复核意见时间 + 版本关系
      setAnalysisStage(zhCN.auditStageReview)
      const reportUpdatedAt = task?.modifiedAt ?? ''
      // 审核产物对象在 OSS 上的 ETag / 最后写入时间（`ossutil ls` 长格式一次列举就有）：
      // 判"审核结果有没有重新生成过"用它，比产物内部写的 generatedAt 更硬。
      const artifact = auditArtifactOf(cloud)
      const evidence = evidenceOf({
        info, reportUpdatedAt, auditEtag: artifact.etag, auditLastModified: artifact.lastModified,
      })
      setAnalysisStage(zhCN.auditStageVersion)
      const verdict = freshnessOf(evidence)
      const fetchedAt = new Date().toISOString()

      // 4) 组装上下文（缺失项**如实记录**，不伪装成完整分析）
      const reportLines = pulled === null ? [] : fileLinesOf(pulled)
      const missing: string[] = []
      if (reportLines.length === 0) missing.push(zhCN.auditCtxLimitedOriginal)
      if (cloud.htmlKey === '') missing.push(zhCN.auditCtxLimitedHtml)
      if (loaded.info === null) missing.push(zhCN.auditCtxLimitedJson)
      if (reviewUpdatedAtOf(info) === '') missing.push(zhCN.auditCtxLimitedReview)
      const auditLines = [
        cloud.htmlKey === '' ? '' : `${zhCN.resultFileReport}：${cloud.htmlKey}`,
        cloud.jsonKey === '' ? '' : `${zhCN.resultFileData}：${cloud.jsonKey}`,
      ].filter((line) => line !== '')
      const context: AuditAnalysisContext = {
        seqNo: key,
        // 与报告讨论同一条约定：本次会话唯一的读写目录，取数规则要用它。
        caseDir: caseDirOf(props.workspace.path, key),
        project: task === undefined ? '' : (task.project !== '' ? task.project : task.name),
        reportUpdatedAt,
        reportVersion: textOf(info.reportVersion),
        auditGeneratedAt: auditGeneratedAtOf(info),
        auditSourceDigest: evidence.auditSourceDigest,
        auditArtifactVersion: textOf(info.schemaVersion),
        reviewUpdatedAt: reviewUpdatedAtOf(info),
        fetchedAt,
        sources: sourcesOf({ pulled, cloud, info, fetchedAt }),
        reportLines,
        auditLines,
        reviewLines: reviewLinesOf(info),
        missing,
        verdict,
      }

      const existing = sessionsOfKind('audit_analysis', sessions, key)
      const snapshot = loadSnapshot(key)
      const current = snapshotOf({
        seqNo: key, info, reportUpdatedAt,
        // 报告资料的同源指纹（DSH fs 的版本令牌聚合）：以后判"资料是否变过"用它。
        reportRemoteId: reportRemoteIdOf(pulled),
        auditRemoteId: auditRemoteIdOf(cloud),
        auditEtag: artifact.etag,
        auditLastModified: artifact.lastModified,
        fetchedAt,
        createdAt: new Date().toISOString(),
      })
      const changes: SnapshotChange | null = snapshot === null ? null : changesSince(snapshot, current)
      pendingAudit.current = { cloud, context, snapshot: current, existing, task }

      // 5) 决定：缺原始资料 / 确认过期 / 可能过期 / 已有会话 / 直进
      // 远端原始资料一项都没取到：**不建会话、不 fallback 本地**（用户 §8/§16），只给重试。
      if (reportLines.length === 0) {
        setAuditAsk({
          mode: 'insufficient', seqNo: key, reportUpdatedAt, auditGeneratedAt: context.auditGeneratedAt,
          reviewUpdatedAt: context.reviewUpdatedAt, changes, canRestart: task !== undefined,
        })
        return
      }
      if (verdict.status === 'stale') {
        setAuditAsk({
          mode: 'stale', seqNo: key, reportUpdatedAt, auditGeneratedAt: context.auditGeneratedAt,
          reviewUpdatedAt: context.reviewUpdatedAt, changes, canRestart: task !== undefined,
        })
        return
      }
      if (verdict.status === 'possibly_stale') {
        setAuditAsk({
          mode: 'possibly', seqNo: key, reportUpdatedAt, auditGeneratedAt: context.auditGeneratedAt,
          reviewUpdatedAt: context.reviewUpdatedAt, changes, canRestart: task !== undefined,
        })
        return
      }
      if (existing.length > 0) {
        setAuditAsk({
          mode: 'existing', seqNo: key, reportUpdatedAt, auditGeneratedAt: context.auditGeneratedAt,
          reviewUpdatedAt: context.reviewUpdatedAt, changes, canRestart: task !== undefined,
        })
        return
      }
      await createAuditAnalysis()
    } finally {
      setAnalysisStage('')
    }
  }

  /**
   * 新建分析会话 = **Fresh Snapshot**：一定要用刚取到的那份上下文重新注入，
   * 绝不复用上次会话的附件/缓存（用户 §14）。
   */
  const createAuditAnalysis = async (): Promise<void> => {
    const pending = pendingAudit.current
    if (pending === null) return
    setAuditBusy(true)
    setAnalysisStage(zhCN.auditStagePrepare)
    try {
      // 与报告讨论同一条材料登记（协议 23）：分析会话也要能把这份报告的附件取进来，
      // 而 `fetchRules` 是两处共用的那一段。`objectId` 取不到时不登记（没有可下载的附件）。
      const analysisObjectId = pending.task?.id ?? ''
      const created = await ensureDiscussion({
        port: props.port,
        sessions,
        seqNo: pending.context.seqNo,
        workspaceId: props.workspace.id,
        workspacePath: props.workspace.path,
        forceNew: true,
        kind: 'audit_analysis',
        ...(analysisObjectId === '' ? {} : {
          openMaterial: async (sessionId: string) => await workbenchApi.discussionMaterialOpen({
            sessionId, seqNo: pending.context.seqNo, objectId: analysisObjectId,
          }),
        }),
      })
      if (!created.ok) { setAiError(created.error); return }
      if (created.renameError !== undefined) setAiError(created.renameError)
      const failure = await askDiscussion(props.port, created.id,
        buildAuditContextBlock(pending.context, created.material?.attachments))
      if (failure !== '') setAiError(failure)
      // Context Snapshot：以后打开这条会话时用它判"是否已经过期"。
      // **存的就是刚才注入的那一份**（不是重新算一遍 —— 两份一旦不同，续聊检查会误报）。
      saveSnapshot(pending.snapshot)
      props.onOpenDiscussion(created.id)
    } finally {
      setAuditBusy(false)
      setAnalysisStage('')
      setAuditAsk(null)
    }
  }

  /** 继续已有分析会话：**只做轻量元数据检查**（不重新下载大文件），资料没变就直接进。 */
  const continueAuditAnalysis = async (): Promise<void> => {
    const pending = pendingAudit.current
    if (pending === null || pending.existing.length === 0) return
    setAuditAsk(null)
    props.onOpenDiscussion(pending.existing[0].id)
  }

  /** 「重新 AI 审核」：走**已有**的审核发起流程，不在这里另写一套。 */
  const restartAuditFromAsk = (): void => {
    const pending = pendingAudit.current
    if (pending === null || pending.task === undefined) return
    setAuditAsk(null)
    props.onStart(pending.task, true)
  }

  /** ESC、点浮层之外这两条通用关闭路径（滚动关闭挂在滚动容器的 onScroll 上）。 */
  React.useEffect(() => {
    if (openMenu === null && tip === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setOpenMenu(null); setTip(null) }
    }
    const onDown = (event: Event): void => {
      const target = event.target as Element | null
      if (target !== null && typeof target.closest === 'function'
        && target.closest('.crwu-audit-float, .crwu-audit-menu') !== null) return
      setOpenMenu(null); setTip(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [openMenu, tip])

  /** 打开/切换/收起某一行的 ••• 菜单（再次点同一行 = 关闭）。位置按触发按钮的 rect 算：
   *  默认贴按钮下方、右边缘对齐；下方放不下就翻到按钮上方（两处都留 8px 间距）。 */
  const toggleMenu = (
    key: string,
    rect: AnchorRect,
    menuItems: ButtonSpec[],
    cloud: CloudItem | null,
  ): void => {
    setTip(null)
    if (openMenu?.key === key) { setOpenMenu(null); return }
    const menuWidth = 152
    const menuHeight = 10 + menuItems.length * 34
    const viewportW = typeof window === 'undefined' ? 1440 : window.innerWidth
    const viewportH = typeof window === 'undefined' ? 900 : window.innerHeight
    const flip = rect.bottom + 8 + menuHeight > viewportH && rect.top - 8 - menuHeight > 0
    setOpenMenu({
      key,
      items: menuItems,
      cloud,
      x: Math.max(8, Math.min(rect.right - menuWidth, viewportW - menuWidth - 8)),
      y: flip ? rect.top - 8 - menuHeight : rect.bottom + 8,
      flip,
    })
  }

  /** 小鲸鱼的提示：悬停**立刻**出现在按钮上方（自绘浮层；原生 title 要等约一秒、样式也不受控）。 */
  const showTip = (key: string, rect: AnchorRect, kind: 'discuss' | 'analyze' = 'discuss'): void => {
    if (openMenu !== null) return
    const width = 190
    const viewportW = typeof window === 'undefined' ? 1440 : window.innerWidth
    const center = rect.left + (rect.right - rect.left) / 2
    setTip({ key, kind, x: Math.max(8, Math.min(center - width / 2, viewportW - width - 8)), y: rect.top - 12 - 30 })
  }

  /** 菜单项动作 → 行为（与原来行内的派发完全一致，只是移到了列表层）。 */
  const handleMenuAction = (id: string): void => {
    const current = openMenuRef.current
    const key = current?.key ?? ''
    const task = state.tasks[rows.findIndex((row) => row.key === key)]
    const cloud = current?.cloud ?? state.ossIndex[key]
    if (id === 'restart') { if (task !== undefined) props.onStart(task, true); return }
    if (id === 'stop') { props.onStop(''); return }
    if (id === 'retry-upload') { props.onRetryUpload(key); return }
    if (id === 'cloud-report') { props.onOpenCloud(cloud?.htmlKey ?? ''); return }
    if (id === 'audit-info') { if (cloud !== undefined && cloud !== null) props.onOpenAuditInfo(key, cloud); return }
    if (id === 'open-html') { props.onOpenLocalHtml(key); return }
    // 「原始交付件」= 打开这一行的 OSS 原始对象（有审核数据就先给数据，否则给审核报告）。
    if (id === 'raw-artifact') {
      const raw = cloud?.jsonKey !== undefined && cloud.jsonKey !== '' ? cloud.jsonKey : (cloud?.htmlKey ?? '')
      if (raw !== '') props.onOpenCloud(raw)
      return
    }
    if (id === 'copy-seqno') { copySeqNo(key); return }
    if (id === 'start') { if (task !== undefined) props.onStart(task, false) }
  }
  const openMenuRef = React.useRef<typeof openMenu>(null)
  openMenuRef.current = openMenu

  return <>
    <div className={C.surface}>
    {/* 页面头：只有标题。用户口径（2026-09-22）：「不要副标题」「不要把 8652 份报告 / 5 份交付件
        放在标题旁边 —— 这些数据应该存在于下面的 View Switch」「页面标题区域必须非常安静」。
        计数只在页签里出现一次。 */}
    <div className={C.pageHead}>
      <div className={C.pageTitle}>{zhCN.auditPageTitle}</div>
    </div>

    <div className={C.paneHead}>
      {/* 轻量 Segmented Workspace Tabs：容器是浅槽，选中项是浮起的白片（样式见 §4）。
          没有下划线指示条、没有品牌红 underline —— 那套已按用户 2026-09-23 口径撤掉。 */}
      <div className={C.tabs}>
        <button
          className={`${C.tab} ${view === 'pending' ? C.tabOn : ''}`}
          type="button"
          onClick={() => { setView('pending') }}
        >
          {zhCN.tabPending}<span className={C.tabCount}>{String(state.total)}</span>
        </button>
        <button
          className={`${C.tab} ${view === 'results' ? C.tabOn : ''}`}
          type="button"
          onClick={() => { setView('results') }}
        >
          {/* 计数**只在这一处**（用户口径：不要"页面头 + 卡头 + 共 N 条"三处重复）。
              按流水号查过之后，显示的是**那一份**的结果 —— 计数就跟着它走，
              不能一边列 1 条一边写 5，正是那条历史缺陷（"空列表 + 5 项"）要防的事。 */}
          {zhCN.tabResults}<span className={C.tabCount}>{String(
            cloudWatching ? shownItems.length : Object.keys(state.ossIndex).length,
          )}</span>
        </button>
      </div>
    </div>

    <div
      className={C.paneMain}
      // 列表一滚就收掉浮层（用户口径：菜单不该在内容移动后还悬在原处）。
      // scroll 事件不冒泡，所以必须挂在真正滚动的这个容器上。
      onScroll={() => { if (openMenu !== null) setOpenMenu(null); if (tip !== null) setTip(null) }}
    >
    {state.notice === '' ? null : <Notice tone="warn">{state.notice}</Notice>}

    {state.handoff === null
      ? null
      : <Handoff task={state.handoff} workspacePath={props.workspace?.path} copied={props.handoffCopied} onCopied={props.onHandoffCopied} />}
    {state.childAliveHint === '' ? null : <div className={C.muted}>{state.childAliveHint}</div>}

    {state.activeKey === '' ? null : (() => {
      // ── 当前审核摘要卡（F2/F3）────────────────────────────────────────────
      // 位置很关键：它在**表格之外**，所以当前审核不在当前分页 / 筛选结果里时，
      // 这张卡与「打开审核会话」入口依然可见（用户明确要求）。
      const activeRecord = state.audits[state.activeKey]
      const stop = stopPresentationOf({
        stop: activeRecord?.stop,
        requestedAt: props.stopRequestedAt ?? 0,
        now: Date.now(),
      })
      const childId = activeRecord?.childId ?? ''
      const canOpen = childId !== ''
      // `Notice` 只支持 ok/warn 两种语气（不改它的 API）：阶段语义由文案表达，
      // 成功态用 `ok`，其余（等待 / 超时 / 失败）用 `warn`。
      return <Notice tone={stop.tone === 'success' ? 'ok' : 'warn'}>
        <div className={C.row}>
          <strong>{zhCN.currentAuditTitle}</strong>
          <span className={C.grow}>{`${state.activeKey}${activeRecord?.project === undefined || activeRecord.project === '' ? '' : ` · ${activeRecord.project}`}`}</span>
          <Button
            label={canOpen ? zhCN.openAuditSession : zhCN.openAuditSessionPending}
            onClick={() => { props.onOpenSession(state.activeKey) }}
            disabled={!canOpen}
            title={zhCN.openAuditSessionHint}
          />
        </div>
        <div className={C.cellSub}>
          {`${activeRecord?.status ?? ''}${activeRecord === undefined ? '' : ` · ${zhCN.currentAuditAttempt}${activeRecord.attempt}${zhCN.currentAuditAttemptSuffix}`}${activeRecord?.startedAt === undefined || activeRecord.startedAt === '' ? '' : ` · ${zhCN.currentAuditStarted}${formatDateTime(activeRecord.startedAt)}`}${childId === '' ? '' : ` · ${zhCN.currentAuditChildTail}${childId.slice(-8)}`}`}
        </div>
        {/* 阶段文案用 aria-live 播报：键盘焦点不动，屏幕阅读器也能听到阶段变化（F2）。
            记录还没拿到（`audit-status` 首次返回前）时不渲染这一行 —— 那时说"宿主没回报"
            只会让人以为部署有问题。 */}
        <div className={C.row} style={{ marginTop: '6px' }}>
          {/* 阶段文案用 aria-live 播报：键盘焦点不动，屏幕阅读器也能听到阶段变化（F2）。
              记录还没拿到（`audit-status` 首次返回前）时不渲染这句 —— 那时说"宿主没回报"
              只会让人以为部署有问题；但**停止按钮一直在**（占用锁在，用户必须能停）。 */}
          {activeRecord === undefined
            ? <span className={C.grow} />
            : <span aria-live="polite" role="status" className={C.grow}>
                {stop.label}
                {stop.elapsedText === '' ? '' : ` · ${stop.elapsedText}`}
                {stop.waitHint === '' ? '' : ` · ${stop.waitHint}`}
              </span>}
          <Button label={zhCN.stopAudit} tone="warn" onClick={() => { props.onStop('') }} disabled={stop.stopDisabled} />
          {stop.actions.keepWaiting ? <Button label={zhCN.stopActionKeepWaiting} onClick={() => { props.onRefreshStatus?.() }} /> : null}
          {stop.actions.stopAgain ? <Button label={zhCN.stopActionStopAgain} tone="warn" onClick={() => { props.onStop('') }} /> : null}
          {stop.actions.openSession ? <Button label={zhCN.stopActionOpenSession} onClick={() => { props.onOpenSession(state.activeKey) }} /> : null}
          {stop.actions.copyDiagnostics ? <Button label={zhCN.stopActionCopyDiagnostics} onClick={() => { props.onCopyDiagnostics?.(state.activeKey) }} /> : null}
        </div>
        {activeRecord === undefined || stop.hint === '' ? null : <div className={C.cellSub}>{stop.hint}</div>}
        {stop.notes.length === 0 ? null : <div className={C.cellSub}>{stop.notes.join('；')}</div>}
      </Notice>
    })()}

    {state.ossIndexError === '' ? null : <Notice tone="warn">{zhCN.cloudFailed + state.ossIndexError}</Notice>}

    {/* 读本机凭据被钥匙串拦住时的免沙箱重试（与「列表有没有画出来」无关，所以放在视图分支之外）。 */}
    {state.escalateAvailable
      ? <Notice tone="warn">
          <div>{zhCN.escalateReason}</div>
          <div style={{ marginTop: '6px' }}>
            <Button label={zhCN.escalateRetry} tone="warn" small onClick={props.onEscalateRetry} />
          </div>
        </Notice>
      : null}

    {view === 'pending'
      // **不再套 Card**（用户口径：不要再嵌套一个巨大的 Card）：内容直接落在 Workspace Surface 里。
      ? <>
          {/* 首次加载那一轮不挂顶部进度条：等待页自己已经有一条，两条同时动只是噪音。 */}
          <LoadingBar active={props.gating.busy === true && state.auditsReady} />
          <div className={C.toolbar}>
            <SearchField
              value={query}
              placeholder={zhCN.searchPlaceholder}
              ariaLabel={zhCN.searchPlaceholder}
              onChange={setQuery}
              onSubmit={() => { props.onSearch(query) }}
              onClear={() => { setQuery(''); props.onSearch('') }}
            />
            {/* 刷新属于**列表工具条**（刷的是这张列表），不属于页面头 —— 放这里用户才能建立
                "刷新 → 刷新当前列表"的直接关系。刷新期间只有图标转，已有列表保持展示。 */}
            <span className={C.searchAction}>
              <button
                type="button"
                className={[C.ghost, props.gating.busy === true ? C.ghostBusy : ''].filter((one) => one !== '').join(' ')}
                disabled={props.gating.busy === true}
                onClick={props.onRefreshPending}
              >
                <RefreshIcon size={15} />{zhCN.refresh}
              </button>
            </span>
          </div>
          {/* 列表数据区：首次加载与拉报告资料的等待页**只盖这一块** ——
              页头、页签、工具条保持可见（用户 2026-09-23 口径：Loading 只覆盖列表数据区）。
              min-height 与列表可视区齐平，数据回来时不会 Layout Shift。 */}
          <div className={C.listArea}>
            {pulling === '' ? null : <div className={C.aiMask}>
              {/* 用户 2026-09-22 口径：loading 只留中瑞世联的 logo + 一句干净文案，
                  不要出现"正在拉取氚云数据 / 正在读取报告文件"这类分步字样。 */}
              <WorkbenchLoading title={zhCN.prepTitle} size={56} />
            </div>}
            {!state.auditsReady
              // 审核记录还没回来：**先别画行**（否则标签会从「AI 审核」跳成「重新审核」）。
              // 只遮列表数据区，页头 / 页签 / 搜索 / 刷新照常可用。
              ? <div className={C.aiMask}><WorkbenchLoading title={zhCN.loadingReports} size={56} hint="" /></div>
              : <div className={props.gating.busy === true ? C.dim : ''}>
                  <PendingTable
                    {...props}
                    rows={rows}
                    discussing={pulling}
                    onDiscuss={openDiscussion}
                    copiedSeq={copiedSeq}
                    onCopySeq={copySeqNo}
                    openMenuKey={openMenu?.key ?? ''}
                    onToggleMenu={(key, rect) => { toggleMenu(key, rect, menuActionsOf(rows.find((row) => row.key === key) ?? { key, badges: [], buttons: [], notes: [] }), state.ossIndex[key] ?? null) }}
                    onShowTip={showTip}
                    onHideTip={() => { setTip(null) }}
                  />
                  <Pager
                    page={state.page}
                    pages={pages}
                    busy={busyPage}
                    jump={jump}
                    jumpHint={jumpHint}
                    onJumpChange={(value) => { setJump(value); setJumpHint('') }}
                    onJumpSubmit={() => {
                      const target = Number(jump.trim())
                      if (!Number.isFinite(target) || Math.floor(target) !== target || target < 1 || target > pages) {
                        setJumpHint(zhCN.paginationRange.replace('%s', String(pages)))
                        return
                      }
                      setJumpHint('')
                      props.onGoPage(target)
                    }}
                    onGoPage={props.onGoPage}
                  />
                </div>}
          </div>
        </>
      : <>
          <LoadingBar active={state.ossLoading} />
          {/* 按流水号查交付件是**这一页**的工具条（这一页本来就是云端交付件列表）。
              和报告列表共用同一个 SearchField：**只在 Enter 时发一次列举**；
              输入过程不发请求 —— 防抖自动查会变成反复扫 OSS。 */}
          <div className={C.toolbar}>
            <SearchField
              value={cloudSeq}
              placeholder={zhCN.cloudSearchPlaceholder}
              ariaLabel={zhCN.cloudSearchAria}
              onChange={setCloudSeq}
              onSubmit={() => {
                // 形状不对就地拦下、**不发请求**；Host 侧还会再校验一次（那是安全边界）。
                if (!isSafeSeqNo(cloudSeq)) { setCloudHint(zhCN.cloudSearchInvalid); return }
                setCloudHint('')
                props.onSearchCloud(cloudSeq.trim())
              }}
              onClear={() => { setCloudSeq(''); setCloudHint(''); props.onClearCloudSearch() }}
            />
            <span className={C.searchAction}>
              <button
                type="button"
                className={[C.ghost, state.ossLoading ? C.ghostBusy : ''].filter((one) => one !== '').join(' ')}
                disabled={state.ossLoading}
                onClick={props.onRefreshCloud}
              >
                <RefreshIcon size={15} />{zhCN.refresh}
              </button>
            </span>
          </div>
          {cloudHint === '' ? null : <Notice tone="warn">{cloudHint}</Notice>}
          {cloudError === '' ? null : <Notice tone="warn">{zhCN.cloudFailed + cloudError}</Notice>}
          {/* 准备分析会话：只盖列表数据区，工具条与页签保持可见（真实阶段，不显示假百分比）。 */}
          {analysisStage === '' ? null : <div className={C.aiMask}>
            <WorkbenchLoading title={analysisStage} size={56} hint="" />
          </div>}
          <div className={C.listArea}>
            <div className={state.ossLoading ? C.dim : ''}>
              {cloudWatching && cloudItems.length === 0
                // 「没找到」是明确结论，不是错误、也不回退去猜别的流水号。
                ? <div className={C.empty}><div>{zhCN.cloudSearchEmpty}</div></div>
                : <ResultsTable
                    {...props}
                    items={shownItems}
                    copiedSeq={copiedSeq}
                    onCopySeq={copySeqNo}
                    openMenuKey={openMenu?.key ?? ''}
                    onToggleMenu={(key, rect, menuItems, cloud) => { toggleMenu(key, rect, menuItems, cloud) }}
                    onAnalyze={(cloud) => { void runAuditAnalysis(cloud) }}
                    analyzing={analysisStage !== ''}
                    onShowTip={(key, rect, kind) => { showTip(key, rect, kind) }}
                    onHideTip={() => { setTip(null) }}
                  />}
            </div>
          </div>
        </>}
    </div>

  </div>

    {/* 统一的浮层：**渲染在表格之外**（不撑高任何一行、也不会被表格的横向滚动容器裁掉），
        position: fixed + 触发元素的 rect 定位。Tooltip 与 Dropdown 共用同一套 token 与动画。 */}
    {openMenu === null ? null : <div
      className={[C.floatLayer, C.floatMenu].join(' ')}
      role="menu"
      data-flip={openMenu.flip ? 'top' : 'bottom'}
      style={{ left: openMenu.x, top: openMenu.y }}
    >
      <span className={C.floatArrow} aria-hidden={true} />
      {openMenu.items.map((item) => <button
        key={item.id}
        type="button"
        role="menuitem"
        className={C.floatItem}
        disabled={item.disabled}
        onClick={() => {
          const id = item.id
          // 先关菜单、再执行动作（用户口径：不要执行完菜单还留着）。
          setOpenMenu(null)
          handleMenuAction(id)
        }}
      >{item.label}</button>)}
    </div>}

    {tip === null ? null : <div
      className={[C.floatLayer, C.floatTip].join(' ')}
      role="tooltip"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.kind === 'analyze' ? zhCN.auditTooltipAnalyze : zhCN.aiRowButton}
      <span className={C.floatArrow} aria-hidden={true} />
    </div>}

    {/* 远端资料一项都取不到：不建会话、不找本地替代（用户 §8/§16）。 */}
    {remoteMissing === null ? null : <>
      <div className={C.aiDialogBackdrop} onClick={() => { setRemoteMissing(null) }} />
      <div className={C.aiDialog} role="dialog" aria-modal="true" aria-label={zhCN.auditRemoteMissingTitle}>
        <div className={C.aiDialogTitle}>{zhCN.auditRemoteMissingTitle}</div>
        <div className={C.aiDialogBody}>{zhCN.auditRemoteMissingBody}</div>
        <button
          type="button"
          className={[C.aiDialogOption, C.aiDialogOptionOn].join(' ')}
          onClick={() => {
            const target = remoteMissing
            setRemoteMissing(null)
            if (target.mode === 'discuss') { void startNewChat(target.seqNo); return }
            const cloud = state.ossIndex[target.seqNo]
            if (cloud !== undefined) void runAuditAnalysis(cloud)
          }}
        >
          <span className={C.aiDialogOptionTitle}>{zhCN.auditRetry}</span>
        </button>
        <div className={C.aiDialogActions}>
          <Button label={zhCN.auditCancel} small onClick={() => { setRemoteMissing(null) }} />
        </div>
      </div>
    </>}

    {/* AI 审核结果分析会话的版本检查（stale / possibly / existing / insufficient）：
        点 DeepSeek 之后**先检查报告与审核的版本关系**，绝不静默把旧审核结论当当前事实。 */}
    {auditAsk === null ? null : <AuditAnalysisDialog
      ask={auditAsk}
      busy={auditBusy}
      onRestart={restartAuditFromAsk}
      onProceed={() => { void createAuditAnalysis() }}
      onContinue={() => { void continueAuditAnalysis() }}
      onRetry={() => { const cloud = pendingAudit.current?.cloud; if (cloud !== undefined) void runAuditAnalysis(cloud) }}
      onCancel={() => { setAuditAsk(null) }}
    />}

    {/* 已有报告会话：弹选择 Dialog（**这一步不拉任何文件** —— 续聊要快，新建才重读）。 */}
    {ask === null ? null : <>
      <div className={C.aiDialogBackdrop} onClick={() => { setAsk(null) }} />
      <div className={C.aiDialog} role="dialog" aria-modal="true" aria-label={zhCN.aiDialogTitle}>
        <div className={C.aiDialogTitle}>{zhCN.aiDialogTitle}</div>
        <div className={C.aiDialogBody}>{zhCN.aiDialogBody}</div>
        <button
          type="button"
          className={[C.aiDialogOption, C.aiDialogOptionOn].join(' ')}
          onClick={() => {
            if (ask === null) return
            const id = ask.sessions[0]?.id ?? ''
            const key = ask.key
            setAsk(null)
            if (id !== '') void continueDiscussion(key, id)
          }}
        >
          <span className={C.aiDialogOptionTitle}>{zhCN.aiContinue}</span>
          <span className={C.aiDialogOptionHint}>{zhCN.aiContinueHint}</span>
        </button>
        <button
          type="button"
          className={C.aiDialogOption}
          onClick={() => {
            if (ask === null) return
            const key = ask.key
            setAsk(null)
            // 新对话：Fresh Context —— 重新读当前报告资料与最新审核产物。
            void startNewChat(key)
          }}
        >
          <span className={C.aiDialogOptionTitle}>{zhCN.aiNewChat}</span>
          <span className={C.aiDialogOptionHint}>{zhCN.aiNewHint}</span>
        </button>
        <div className={C.aiDialogActions}>
          <Button label={zhCN.aiDialogClose} small onClick={() => { setAsk(null) }} />
        </div>
      </div>
    </>}
  </>
}

/** 分页：首页 / 上一页 / 页码窗口 / 下一页 / 末页 + 跳至第 N 页（越界只提示，不发请求）。 */
function Pager(props: {
  page: number
  pages: number
  busy: boolean
  jump: string
  jumpHint: string
  onJumpChange: (value: string) => void
  onJumpSubmit: () => void
  onGoPage: (page: number) => void
}): React.ReactElement {
  return <div className={C.pager}>
    <button
      type="button" className={C.pagerNav} aria-label={zhCN.paginationFirst} title={zhCN.paginationFirst}
      disabled={props.busy || props.page <= 1} onClick={() => { props.onGoPage(1) }}
    >«</button>
    <button
      type="button" className={C.pagerNav} aria-label={zhCN.paginationPrev} title={zhCN.paginationPrev}
      disabled={props.busy || props.page <= 1} onClick={() => { props.onGoPage(props.page - 1) }}
    >‹</button>
    {pageWindow(props.page, props.pages).map((item, index) => item === 0
      ? <span key={`gap-${String(index)}`} className={C.pagerGap}>…</span>
      : <button
          key={item}
          type="button"
          className={[C.pagerPage, item === props.page ? C.pagerPageOn : ''].filter((one) => one !== '').join(' ')}
          aria-current={item === props.page ? 'page' : undefined}
          disabled={props.busy}
          onClick={() => { props.onGoPage(item) }}
        >{String(item)}</button>)}
    <button
      type="button" className={C.pagerNav} aria-label={zhCN.paginationNext} title={zhCN.paginationNext}
      disabled={props.busy || props.page >= props.pages} onClick={() => { props.onGoPage(props.page + 1) }}
    >›</button>
    <button
      type="button" className={C.pagerNav} aria-label={zhCN.paginationLast} title={zhCN.paginationLast}
      disabled={props.busy || props.page >= props.pages} onClick={() => { props.onGoPage(props.pages) }}
    >»</button>
    {/* 跳页：非法/越界一律 clamp 到合法范围并给一句提示，**不发请求**。 */}
    <span className={C.pagerJumpWrap}>
      <span className={C.muted}>{zhCN.paginationJump}</span>
      <input
        className={C.pagerJump}
        value={props.jump}
        inputMode="numeric"
        aria-label={zhCN.paginationJump}
        onChange={(event) => { props.onJumpChange(String((event.target as { value?: unknown }).value ?? '')) }}
        onKeyDown={(event) => {
          if ((event as unknown as { key?: string }).key !== 'Enter') return
          props.onJumpSubmit()
        }}
      />
      <span className={C.muted}>{zhCN.paginationJumpSuffix}</span>
    </span>
    {props.jumpHint === '' ? null : <span className={C.muted}>{props.jumpHint}</span>}
  </div>
}

/** 文件大小：人读的量级（清单里出现 78761669 没有意义）。 */
function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 订阅会话列表（这块以前在右侧面板里；面板撤掉后搬到这里）。
 *
 * 不用 `useSessions` 标准 hook：那是**槽位登记回调**拿到的标准 props，要一层层当 prop 传下来；
 * 会话服务对象本来就在我们手里（`services.sessions`），它的 `list` 快照商店可以直接订阅。
 */
function useSessionRows(port: DiscussionPort | undefined): SessionSummaryLike[] {
  const [rows, setRows] = React.useState<SessionSummaryLike[]>(() => sessionRowsOf(port))
  React.useEffect(() => {
    const store = port?.list
    const sync = (): void => { setRows(sessionRowsOf(port)) }
    sync()
    if (typeof store?.subscribe !== 'function') return undefined
    const dispose = store.subscribe(sync)
    return typeof dispose === 'function' ? dispose : undefined
  }, [port])
  return rows
}

function sessionRowsOf(port: DiscussionPort | undefined): SessionSummaryLike[] {
  const snapshot = port?.list?.getSnapshot()
  if (snapshot === undefined) return []
  const ids = Array.isArray(snapshot.ids) ? snapshot.ids : []
  return ids.map((id) => snapshot.byId?.[id] ?? { id })
}

/** 风险等级圆点的颜色：按**已有 tone** 映射，不新增任何业务枚举。 */
function dotClassOf(tone: string): string {
  if (tone === 'high') return C.riskDotHigh
  if (tone === 'medium') return C.riskDotMedium
  if (tone === 'ok') return C.riskDotOk
  return C.riskDotLow
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 分页的页码窗口（纯函数）：首页、末页、当前页前后各 2 页，中间用 0 表示省略号。
 *
 * 用户口径（2026-09-22）：「总页数很多时不要渲染全部页码」。8652 条 / 20 一页 = 433 页，
 * 全渲染会是一排 433 个按钮。第 125 页时给：1 … 123 124 125 126 127 … 433。
 */
export function pageWindow(current: number, total: number): number[] {
  if (total <= 0) return []
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const now = Math.min(Math.max(1, current), total)
  const window = new Set<number>([1, total, now])
  for (let offset = 1; offset <= 2; offset += 1) {
    if (now - offset >= 1) window.add(now - offset)
    if (now + offset <= total) window.add(now + offset)
  }
  const sorted = [...window].sort((a, b) => a - b)
  const out: number[] = []
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) out.push(0)
    out.push(page)
  })
  return out
}
