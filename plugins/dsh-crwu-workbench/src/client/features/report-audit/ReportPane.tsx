import * as React from 'react'
import { Badge, Button, Empty, Loading, LoadingBar, Notice, Spinner } from '../../components/primitives.tsx'
import { DeepSeekIcon } from '../../components/icons.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import type { CloudItem } from '../../../shared/types.ts'
import { isSafeSeqNo } from '../../../shared/consts.ts'
import { Handoff } from '../workbench/Handoff.tsx'
import { workbenchApi } from './api.ts'
import type { ReportFilesResult } from './api.ts'
import { discussionPrompt, findDiscussions, type DiscussionFacts } from './assistant-context.ts'
import { askDiscussion, ensureDiscussion, type DiscussionPort, type SessionSummaryLike } from './assistant-session.ts'
import { WorkbenchLoading } from '../workbench/LoadingPane.tsx'
import { buildRows, menuActionsOf, pageCount, primaryActionOf, resultItems, riskBadge } from './row.ts'
import type { AuditView, ButtonSpec, RowView, TaskRow } from './types.ts'

/**
 * 报告页。
 *
 * 页内两个页签：**报告列表**（氚云记录 + 审核状态）与 **AI 审核列表**（云端交付件）。
 *
 * 形态（用户 2026-09-22 口径）：正文**只有一个大圆角框**（`.crwu-audit-surface`），
 * 页签是下划线式、框内的卡片不再各自带描边（见 consts.ts §16）。
 *
 * **右侧自绘对话框已撤**（用户同日晚些时候改口径：「这里不设计右侧对话框了，去掉吧，
 * 只会增加负担」）。现在点操作列那枚小鲸鱼只做两件事：
 * 1. 用 crwu **拉一次这份报告的全部文件元数据**（`report-files`：氚云附件 + 本地案例目录 +
 *    云端交付件，只列举不下载），拼进给 AI 的上下文；
 * 2. **有绑定的讨论会话** → 弹一个气泡问「新建对话 / 继续上次聊天」；
 *    **没有** → 直接建一条新会话、注入上下文，并把主面板切到那条原生会话（对话本体、工具卡、
 *    审批、附件都在 DSH 原生那边，我们不再自绘聊天）。
 *
 * 一条重要约束（本仓反复强调的那个坑）：**切标签、翻页、检索都不得重新列举 OSS**。
 * 上云清单只在首次进入、显式刷新、或上传成功后拉取 —— 每次交互都扫一遍 OSS 会让页面
 * 变成几秒一次的对象列举。所以这一页只接收已经拉好的 `ossIndex`，自己不发起列举。
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
  /** 按流水号查云端交付件（用户点「查找」才发，输入过程不发请求）。 */
  onSearchCloud: (seqNo: string) => void
  onClearCloudSearch: () => void
  onEscalateRetry: () => void
  onHandoffCopied: (copied: boolean) => void
  handoffCopied: boolean
  /** 环境里选中的工作空间（讨论会话建在它下面，也写进注入给 AI 的报告事实里）。 */
  workspace: { id: string; path: string }
  /** 客户端会话服务：讨论面板靠它建/复用真实会话（可能缺席）。 */
  port: DiscussionPort
  /** 在原生对话里打开讨论会话（切主面板回 conversation）。 */
  onOpenDiscussion: (sessionId: string) => void
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
  onToggleMenu: (rect: { left: number; right: number; top: number; bottom: number }) => void
  onShowTip: (rect: { left: number; right: number; top: number; bottom: number }) => void
  onHideTip: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false)
  const primary = primaryActionOf(props.view)
  const menu = menuActionsOf(props.view)

  /** 触发元素自己的 rect（浮层按它定位；列表层拿去做 fixed 浮层）。 */
  const rectOf = (element: { getBoundingClientRect?: () => DOMRect } | null): { left: number; right: number; top: number; bottom: number } => {
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
              <Button label="取消" small onClick={() => setConfirming(false)} />
            </>
          : <Button
              label={primary.label}
              tone={primary.tone}
              disabled={primary.disabled}
              small
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
      aria-describedby={undefined}
      disabled={props.discussing}
      onMouseEnter={(event) => { props.onShowTip(rectOf(event?.currentTarget ?? null)) }}
      onMouseLeave={props.onHideTip}
      onFocus={(event) => { props.onShowTip(rectOf(event?.currentTarget ?? null)) }}
      onBlur={props.onHideTip}
      onClick={props.onDiscuss}
    >
      <DeepSeekIcon size={18} />
    </button>

    {/* •••：真正的 Icon Button；菜单本身由**列表层**渲染成浮层（见 ReportPane）。
        打开时按钮保持 selected，用户一眼知道菜单属于哪一行。 */}
    {menu.length === 0 ? null : <button
      type="button"
      // 底色/字色复用主操作那套变体（用户 2026-09-23：「更多操作的三个点也需要改下颜色适配，
      // 和前面的 AI 审核一样，按钮的背景色什么的，这样看起来很清楚」）；C.menu 只给几何与选中环。
      className={[C.btn, C.btnPrimary, C.menu, props.menuOpen ? C.menuOpen : ''].filter((one) => one !== '').join(' ')}
      aria-haspopup="menu"
      aria-expanded={props.menuOpen}
      aria-label={zhCN.moreActions}
      onClick={(event) => { props.onToggleMenu(rectOf(event?.currentTarget ?? null)) }}
    >•••</button>}
  </div>
}

function PendingTable(props: ReportPaneProps & {
  rows: RowView[]
  /** 正在拉这份报告的文件（按钮禁用，防连点）。 */
  discussing: string
  /** 点那枚小鲸鱼：拉文件 → 问用户 / 直接进新对话。 */
  onDiscuss: (key: string) => void
  /** 当前开着菜单的那一行（列表层持有，天然只有一个）。 */
  openMenuKey: string
  onToggleMenu: (key: string, rect: { left: number; right: number; top: number; bottom: number }, items: ButtonSpec[]) => void
  onShowTip: (key: string, rect: { left: number; right: number; top: number; bottom: number }) => void
  onHideTip: () => void
}): React.ReactElement {
  const { state } = props
  // 首屏/翻页/检索都可能还没拿到数据：这时说「没有待审核报告」是错的（上一秒还在加载）。
  if (props.rows.length === 0) {
    return props.gating.busy === true ? <Loading text={zhCN.loadingList} /> : <Empty text={zhCN.noRows} />
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
          <td className={`${C.td} ${C.tdNowrap}`} title={task.seqNo}><div className={C.mono}>{task.seqNo}</div></td>
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
            {task.currentNode === '' ? null : <div className={C.cellSub} style={{ marginTop: '4px' }}>{task.currentNode}</div>}
            {view.badges.map((badge) => <div key={badge.text} style={{ marginTop: '4px' }}>
              <Badge text={badge.text} tone={badge.tone} />
            </div>)}
            {/* 门禁说明（"宿主插件是旧构建，请重启 web profile"这类）必须说得出原因：
                它是**状态解释**，所以留在状态列，不进行动区。 */}
            {view.notes.map((note) => <div key={note} className={C.muted} style={{ marginTop: '4px' }}>{note}</div>)}
          </td>
          <td className={`${C.td} ${C.tdNowrap}`} title={task.modifiedAt}>
            <div className={C.mono}>{formatWhen(task.modifiedAt)}</div>
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
                // 做隔离检查，把裸流水号拒掉（实测 `ok:false`「对象不在配置的 OSS 前缀内」，
                // 界面只弹一句提示 —— 就是「查看报告打不开」）。这一行要打开的是它云端交付件
                // 里的 HTML，所以取 `state.ossIndex[view.key].htmlKey`。
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
              onToggleMenu={(rect) => { props.onToggleMenu(view.key, rect, menuActionsOf(view)) }}
              onShowTip={(rect) => { props.onShowTip(view.key, rect) }}
              onHideTip={props.onHideTip}
            />
          </td>
        </tr>
      })}
    </tbody>
  </table></div>
}

function ResultsTable(props: ReportPaneProps & { items: CloudItem[] }): React.ReactElement {
  if (props.items.length === 0) {
    return props.state.ossLoading ? <Loading text={zhCN.loadingCloud} /> : <Empty text={zhCN.noResults} />
  }
  return <div className={C.tableWrap}><table className={C.table}>
    <thead><tr>
      <th className={C.th}>{zhCN.colResultSeqNo}</th>
      <th className={C.th}>{zhCN.colResultCloud}</th>
      <th className={C.th}>{zhCN.colAction}</th>
    </tr></thead>
    <tbody>
      {props.items.map((item) => {
        // 结果页只列**规范交付件**：辅助文件不该出现在「AI审核结果」里。
        const files = [item.htmlKey, item.jsonKey].filter((key) => key !== '')
        return <tr key={item.seqNo} className={C.tbodyRow}>
          <td className={C.td}><div className={C.mono}>{item.seqNo}</div></td>
          <td className={C.td}>
            {files.map((key) => <div key={key} className={C.mono}>{key}</div>)}
          </td>
          <td className={`${C.td} ${C.tdAction}`}>
            <div className={C.row}>
              {item.htmlKey === '' ? null : <Button label={zhCN.openReport} tone="primary" small onClick={() => props.onOpenCloud(item.htmlKey)} />}
              {item.jsonKey === '' || item.htmlKey === '' ? null : <Button
                label={zhCN.auditInfo}
                small
                onClick={() => props.onOpenAuditInfo(item.seqNo, item)}
              />}
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
    key: string; x: number; y: number; flip: boolean; items: ButtonSpec[]
  } | null>(null)
  const [tip, setTip] = React.useState<{ key: string; x: number; y: number } | null>(null)
  const tabsRef = React.useRef<{ querySelector?: (selector: string) => { offsetLeft?: number; offsetWidth?: number } | null } | null>(null)
  const [tabInd, setTabInd] = React.useState({ x: 0, w: 0 })
  React.useEffect(() => {
    const row = tabsRef.current
    if (row?.querySelector === undefined) return
    const active = row.querySelector('.crwu-audit-tab-on')
    if (active?.offsetLeft === undefined || active.offsetWidth === undefined) return
    // 指示条是**固定宽度的小横条**（设计稿 28–36px），居中在选中页签下方 ——
    // 不是铺满整条页签（实测那样会变成 92px，像下划线）。
    const width = 32
    setTabInd({ x: (active.offsetLeft ?? 0) + ((active.offsetWidth ?? 0) - width) / 2, w: width })
  }, [view, state.auditsReady, state.total, state.ossIndex])
  const [jump, setJump] = React.useState('')
  const [jumpHint, setJumpHint] = React.useState('')

  /** 把一行氚云记录翻译成给 AI 的「报告事实」。 */
  const factsOf = (key: string): DiscussionFacts => {
    const task = state.tasks[rows.findIndex((row) => row.key === key)]
    return {
      seqNo: key,
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
      files: (state.ossIndex[key]?.files ?? []).map((file) => file.name),
      workspacePath: props.workspace.path,
    }
  }

  /** 把 crwu 拉到的三组文件拼成注入上下文里那份清单（只名字与大小，不含正文）。 */
  // 逐组兜底：旧宿主或异常回包可能缺某一组（实测缺组会让整个点击崩掉），
  // 缺一组就当那一组为空，绝不因此挡住"开对话"这件事。
  const fileLinesOf = (pulled: ReportFilesResult): string[] => [
    ...(pulled.h3yun ?? []).map((file) => `${file.name}（氚云附件${file.size > 0 ? ` · ${formatBytes(file.size)}` : ''}）`),
    ...(pulled.local ?? []).map((file) => `${file.path}（本地案例目录）`),
    ...(pulled.oss ?? []).map((file) => `${file.name}（云端交付件）`),
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
    const facts = factsOf(key)
    setAiError('')
    setPulling(key)
    try {
      // 一次调用同时取三组：氚云附件 / 本地案例目录 / 该流水号的 OSS 审核产物。
      let pulled: ReportFilesResult | null = null
      try {
        pulled = await workbenchApi.reportFiles({ seqNo: key, objectId: facts.objectId })
        if (!pulled.ok && pulled.error !== '') setAiError(pulled.error)
      } catch (cause: unknown) {
        // 拉资料失败不白屏：给出原因，用户仍然可以围绕已有信息讨论。
        setAiError(describe(cause))
      }
      const lines = pulled === null ? [] : fileLinesOf(pulled)
      const briefFacts = lines.length === 0 ? facts : { ...facts, files: lines }
      const created = await ensureDiscussion({
        port: props.port,
        sessions,
        seqNo: key,
        workspaceId: props.workspace.id,
        workspacePath: props.workspace.path,
        forceNew: true,
      })
      if (!created.ok) { setAiError(created.error); return }
      const failure = await askDiscussion(props.port, created.id, discussionPrompt(briefFacts, zhCN.aiKickoff, true))
      if (failure !== '') setAiError(failure)
      props.onOpenDiscussion(created.id)
    } finally {
      setPulling('')
    }
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
    rect: { left: number; right: number; top: number; bottom: number },
    items: ButtonSpec[],
  ): void => {
    setTip(null)
    if (openMenu?.key === key) { setOpenMenu(null); return }
    const menuWidth = 152
    const menuHeight = 10 + items.length * 34
    const viewportW = typeof window === 'undefined' ? 1440 : window.innerWidth
    const viewportH = typeof window === 'undefined' ? 900 : window.innerHeight
    const flip = rect.bottom + 8 + menuHeight > viewportH && rect.top - 8 - menuHeight > 0
    setOpenMenu({
      key,
      items,
      x: Math.max(8, Math.min(rect.right - menuWidth, viewportW - menuWidth - 8)),
      y: flip ? rect.top - 8 - menuHeight : rect.bottom + 8,
      flip,
    })
  }

  /** 小鲸鱼的提示：悬停**立刻**出现在按钮上方（自绘浮层；原生 title 要等约一秒、样式也不受控）。 */
  const showTip = (key: string, rect: { left: number; right: number; top: number; bottom: number }): void => {
    if (openMenu !== null) return
    const width = 152
    const viewportW = typeof window === 'undefined' ? 1440 : window.innerWidth
    const center = rect.left + (rect.right - rect.left) / 2
    setTip({ key, x: Math.max(8, Math.min(center - width / 2, viewportW - width - 8)), y: rect.top - 12 - 30 })
  }

  /** 菜单项动作 → 行为（与原来行内的派发完全一致，只是移到了列表层）。 */
  const handleMenuAction = (id: string): void => {
    const key = openMenuKeyRef.current
    const task = state.tasks[rows.findIndex((row) => row.key === key)]
    const cloud = state.ossIndex[key]
    if (id === 'restart') { if (task !== undefined) props.onStart(task, true); return }
    if (id === 'stop') { props.onStop(''); return }
    if (id === 'retry-upload') { props.onRetryUpload(key); return }
    if (id === 'cloud-report') { props.onOpenCloud(cloud?.htmlKey ?? ''); return }
    if (id === 'audit-info') { if (cloud !== undefined) props.onOpenAuditInfo(key, cloud); return }
    if (id === 'open-html') { props.onOpenLocalHtml(key); return }
    if (id === 'start') { if (task !== undefined) props.onStart(task, false) }
  }
  const openMenuKeyRef = React.useRef('')
  openMenuKeyRef.current = openMenu?.key ?? ''

  return <>
    <div className={C.surface}>
    {/* 页面头：只有标题 + 右侧一个「同步」。用户口径（2026-09-22）：
        「不要副标题」「不要把 8652 份报告 / 5 份交付件放在标题旁边 —— 这些数据应该存在于下面的
        View Switch」「页面标题区域必须非常安静」。计数只在下方的视图切换里出现一次。 */}
    <div className={C.pageHead}>
      <div className={C.pageTitle}>{zhCN.auditPageTitle}</div>
    </div>

    <div className={C.paneHead}>
      <div className={C.tabs} ref={tabsRef as never}>
        <span className={C.tabInd} aria-hidden={true} style={{ transform: `translateX(${tabInd.x}px)`, width: `${tabInd.w}px` }} />
        <button
          className={`${C.tab} ${view === 'pending' ? C.tabOn : ''}`}
          type="button"
          onClick={() => setView('pending')}
        >
          {zhCN.tabPending}<span className={C.tabCount}>{String(state.total)}</span>
        </button>
        <button
          className={`${C.tab} ${view === 'results' ? C.tabOn : ''}`}
          type="button"
          onClick={() => setView('results')}
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

    <div className={C.paneMain}>
    {state.notice === '' ? null : <Notice tone="warn">{state.notice}</Notice>}

    {state.handoff === null
      ? null
      : <Handoff task={state.handoff} copied={props.handoffCopied} onCopied={props.onHandoffCopied} />}
    {state.childAliveHint === '' ? null : <div className={C.muted}>{state.childAliveHint}</div>}

    {state.activeKey === '' ? null : <Notice tone="warn">
      {zhCN.activePrefix + state.activeKey + zhCN.activeSuffix}
      <div className={C.row} style={{ marginTop: '6px' }}>
        <Button label={zhCN.stopAudit} tone="warn" onClick={() => props.onStop('')} />
        <span className={C.grow}>{zhCN.stopHint}</span>
      </div>
      {/*
        「只释放占用（不停子会话）」按钮在 2026-09-20 按用户要求删掉了：他说用不到。
        宿主侧的 `audit-release` 操作保留（`client-rpc-facade.test.mjs` 的 HOST_ONLY），
        但界面上不再提供 —— 它会把占用锁解开而子会话继续跑，正是「两条子会话往同一个
        案例目录对写」那条闸门要拦的状态。
      */}
    </Notice>}

    {state.ossIndexError === '' ? null : <Notice tone="warn">{zhCN.cloudFailed + state.ossIndexError}</Notice>}

    {/* 准备会话期间的等待页：**只盖列表区**（用户口径：Loading 必须出现在报告数据区域，
        而不是锁死整个 Workspace —— 页头/搜索/刷新/视图切换仍然可见），并且 min-height
        与列表可视区齐平，数据回来时不会 Layout Shift。 */}
    {pulling === '' ? null : <div className={C.aiMask}>
      {/* 用户 2026-09-22 口径：loading 只留中瑞世联的 logo + 一句干净文案，
          不要出现"正在拉取氚云数据 / 正在读取报告文件"这类分步字样。 */}
      <WorkbenchLoading title={zhCN.prepTitle} size={56} />
    </div>}

    {state.escalateAvailable
      ? <Notice tone="warn">
          <div>{zhCN.escalateReason}</div>
          <div style={{ marginTop: '6px' }}>
            <Button label={zhCN.escalateRetry} tone="warn" small onClick={props.onEscalateRetry} />
          </div>
        </Notice>
      : null}

    {view === 'pending' && !state.auditsReady
      // 审核记录还没回来：**先别画行**（否则标签会从「AI 审核」跳成「重新审核」）。
      // 只遮列表区，页头/视图切换/搜索/刷新照常可见 —— 与拉报告资料时同一套等待页。
      ? <div className={C.aiMask}><WorkbenchLoading title={zhCN.loadingReports} size={56} /></div>
      : view === 'pending'
      // **不再套 Card**（用户口径：不要再嵌套一个巨大的 Card，减少 Border/Card/Header/Container
      // 层级；Apple 风格的核心是"减少不必要的视觉容器"）。内容直接落在工作台主体里。
      ? <>
          <LoadingBar active={props.gating.busy === true} />
          <div className={C.row}>
            {/* Spotlight 式搜索：输入即搜（回车触发），不设「搜索 / 清空」两个传统按钮；
                清空是输入框右侧那个 ×。 */}
            <span className={C.searchWrap}>
              <input
                className={C.input}
                value={query}
                placeholder={zhCN.searchPlaceholder}
                aria-label={zhCN.searchPlaceholder}
                onChange={(event) => setQuery(String((event.target as { value?: unknown }).value ?? ''))}
                onKeyDown={(event) => {
                  if ((event as unknown as { key?: string }).key !== 'Enter') return
                  props.onSearch(query)
                }}
              />
              {query === '' ? null : <button
                type="button"
                className={C.searchClear}
                aria-label={zhCN.clear}
                title={zhCN.clear}
                onClick={() => { setQuery(''); props.onSearch('') }}
              >×</button>}
            </span>
            {/* 刷新属于**列表工具条**（刷的是这张列表），不属于页面头 —— 放这里用户才能建立
                "刷新 → 刷新当前列表"的直接关系。刷新期间按钮禁用，已有列表保持展示。 */}
            <span className={C.searchAction}>
              <Button
                label={zhCN.refreshGlyph}
                disabled={props.gating.busy === true}
                onClick={props.onRefreshPending}
              />
            </span>
          </div>
          <div className={props.gating.busy === true ? C.dim : ''}>
            <PendingTable
              {...props}
              rows={rows}
              discussing={pulling}
              onDiscuss={openDiscussion}
              openMenuKey={openMenu?.key ?? ''}
              onToggleMenu={toggleMenu}
              onShowTip={showTip}
              onHideTip={() => { setTip(null) }}
            />
            <div className={C.pager}>
              <Button label={zhCN.paginationFirst} small disabled={busyPage} onClick={() => props.onGoPage(1)} />
              <Button label={zhCN.paginationPrev} small disabled={busyPage || state.page <= 1} onClick={() => props.onGoPage(state.page - 1)} />
              {pageWindow(state.page, pages).map((item, index) => item === 0
                ? <span key={`gap-${String(index)}`} className={C.pagerGap}>…</span>
                : <button
                    key={item}
                    type="button"
                    className={[C.pagerPage, item === state.page ? C.pagerPageOn : ''].filter((one) => one !== '').join(' ')}
                    aria-current={item === state.page ? 'page' : undefined}
                    disabled={busyPage}
                    onClick={() => props.onGoPage(item)}
                  >{String(item)}</button>)}
              <Button label={zhCN.paginationNext} small disabled={busyPage || state.page >= pages} onClick={() => props.onGoPage(state.page + 1)} />
              <Button label={zhCN.paginationLast} small disabled={busyPage || state.page >= pages} onClick={() => props.onGoPage(pages)} />
              <span className={C.grow} />
              {/* 跳页：非法/越界一律 clamp 到合法范围并给一句提示，**不发请求**。 */}
              <span className={C.pagerJumpWrap}>
                <span className={C.muted}>{zhCN.paginationJump}</span>
                <input
                  className={C.pagerJump}
                  value={jump}
                  inputMode="numeric"
                  aria-label={zhCN.paginationJump}
                  onChange={(event) => { setJump(String((event.target as { value?: unknown }).value ?? '')); setJumpHint('') }}
                  onKeyDown={(event) => {
                    if ((event as unknown as { key?: string }).key !== 'Enter') return
                    const target = Number(jump.trim())
                    if (!Number.isFinite(target) || Math.floor(target) !== target || target < 1 || target > pages) {
                      setJumpHint(zhCN.paginationRange.replace('%s', String(pages)))
                      return
                    }
                    setJumpHint('')
                    props.onGoPage(target)
                  }}
                />
                <span className={C.muted}>{zhCN.paginationJumpSuffix}</span>
              </span>
              <span className={C.muted}>{zhCN.paginationPage.replace('%s', String(state.page)).replace('%s', String(pages))}</span>
              {/* 翻页时不在这里再挂一条「正在加载…」：用户口径是把它去掉 ——
                  顶部那条不确定进度条 + 列表压暗已经足够说明"正在取下一页"，右下角再挂一行只是噪音。 */}
              {jumpHint === '' ? null : <span className={C.muted}>{jumpHint}</span>}
            </div>
          </div>
        </>
      : <>
          <LoadingBar active={state.ossLoading} />
          {/* 按流水号查交付件是**这一页**的工具条（这一页本来就是云端交付件列表）。
              **只在点「查找」时发一次列举**；输入过程不发请求 —— 防抖自动查会变成反复扫 OSS。 */}
          <div className={C.row}>
            <input
              className={C.input}
              value={cloudSeq}
              placeholder={zhCN.cloudSearchPlaceholder}
              onChange={(event) => setCloudSeq(String((event.target as { value?: unknown }).value ?? ''))}
            />
            <Button label={zhCN.cloudSearchButton} small onClick={() => {
              // 形状不对就地拦下、**不发请求**；Host 侧还会再校验一次（那是安全边界）。
              if (!isSafeSeqNo(cloudSeq)) { setCloudHint(zhCN.cloudSearchInvalid); return }
              setCloudHint('')
              props.onSearchCloud(cloudSeq.trim())
            }} />
            <Button label={zhCN.clear} small onClick={() => { setCloudSeq(''); setCloudHint(''); props.onClearCloudSearch() }} />
            <span className={C.grow} />
            {state.cloudSearchBusy === true || state.ossLoading ? <><Spinner /><span className={C.muted}>{zhCN.loadingCloud}</span></> : null}
          </div>
          {/* 说清"现在看的是哪一份"：只显示该流水号的结果 vs 全量列表 —— 否则员工会以为列表坏了。 */}
          <div className={C.muted}>
            {cloudWatching
              ? `${zhCN.cloudSearchWatchingPrefix} ${state.cloudSearchSeqNo} ${zhCN.cloudSearchWatchingSuffix}`
              : zhCN.cloudSearchAll}
          </div>
          {cloudHint === '' ? null : <Notice tone="warn">{cloudHint}</Notice>}
          {cloudError === '' ? null : <Notice tone="warn">{zhCN.cloudFailed + cloudError}</Notice>}
          <div className={state.ossLoading ? C.dim : ''}>
            {cloudWatching
              ? (cloudItems.length === 0
                  // 「没找到」是明确结论，不是错误、也不回退去猜别的流水号。
                  ? <Empty text={zhCN.cloudSearchEmpty} />
                  : <ResultsTable {...props} items={cloudItems} />)
              : <ResultsTable {...props} items={items} />}
          </div>
        </>}
    </div>

    {/* 拉文件期间的等待页：**整块正文**（用户口径：「crwu 在查询的时候，应该有个中瑞世联的
        Loading 页面」）。查询只几分钟秒级，遮住正文也正好防住连点。 */}


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
      {zhCN.aiRowButton}
      <span className={C.floatArrow} aria-hidden={true} />
    </div>}

    {/* 已有报告会话：弹选择 Dialog（**这一步不拉任何文件** —— 续聊要快，新建才重读）。 */}
    {ask === null ? null : <>
      <div className={C.aiDialogBackdrop} onClick={() => setAsk(null)} />
      <div className={C.aiDialog} role="dialog" aria-modal="true" aria-label={zhCN.aiDialogTitle}>
        <div className={C.aiDialogTitle}>{zhCN.aiDialogTitle}</div>
        <div className={C.aiDialogBody}>{zhCN.aiDialogBody}</div>
        <button
          type="button"
          className={[C.aiDialogOption, C.aiDialogOptionOn].join(' ')}
          onClick={() => {
            if (ask === null) return
            const id = ask.sessions[0]?.id ?? ''
            setAsk(null)
            // 续聊：只切会话，不重新拉文件 / 不重新读 OSS / 不重复注入 Prompt。
            if (id !== '') props.onOpenDiscussion(id)
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
          <Button label={zhCN.aiDialogClose} small onClick={() => setAsk(null)} />
        </div>
      </div>
    </>}
  </>
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
 * 更新时间：秒对审核流程没有价值，按"今天 / 昨天 / 更早"口语化，完整值留在 title 里。
 *
 * 用户口径（2026-09-22）：「统一显示 09-22 18:15；今天的数据 18:15；昨天 昨天 18:15；
 * 不要一直显示 2026-09-22 18:15:08」。认不出的形状**原样返回**（不猜、不吞）。
 */
export function formatWhen(value: string, now: Date = new Date()): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value.trim())
  if (matched === null) return value
  const [, year, month, day, hour, minute] = matched
  const sameDay = (offset: number): boolean => {
    const probe = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
    return probe.getFullYear() === Number(year) && probe.getMonth() + 1 === Number(month) && probe.getDate() === Number(day)
  }
  const clock = `${hour}:${minute}`
  if (sameDay(0)) return clock
  if (sameDay(1)) return `${zhCN.yesterday} ${clock}`
  return `${month}-${day} ${clock}`
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
