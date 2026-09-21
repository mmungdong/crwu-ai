import * as React from 'react'
import { Badge, Button, Card, Empty, Loading, LoadingBar, Notice, Spinner } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import type { CloudItem } from '../../../shared/types.ts'
import { isSafeSeqNo } from '../../../shared/consts.ts'
import { Handoff } from '../workbench/Handoff.tsx'
import { buildRows, filterModeText, pageCount, resultItems, riskBadge } from './row.ts'
import type { AuditView, RowView, TaskRow } from './types.ts'

/**
 * 报告页。
 *
 * 页内两个标签：**待审核报告**（氚云记录 + 审核状态）与 **AI审核结果**（云端交付件）。
 *
 * 一条重要约束（本仓反复强调的那个坑）：**切标签、翻页、检索都不得重新列举 OSS**。
 * 上云清单只在首次进入、显式刷新、或上传成功后拉取 —— 每次交互都扫一遍 OSS 会让页面
 * 变成几秒一次的对象列举。所以这一页只接收已经拉好的 `ossIndex`，自己不发起列举。
 */

export interface ReportPaneState {
  tasks: TaskRow[]
  audits: Record<string, AuditView>
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
  onOpenSession: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false)
  const start = props.view.buttons.find((button) => button.id === 'start')
  const others = props.view.buttons.filter((button) => button.id !== 'start')

  const handlerOf = (id: string): (() => void) => {
    if (id === 'stop') return props.onStop
    if (id === 'retry-upload') return props.onRetryUpload
    if (id === 'cloud-report') return props.onOpenCloud
    if (id === 'audit-info') return props.onOpenAuditInfo
    if (id === 'open-html') return props.onOpenLocalHtml
    return props.onOpenSession
  }

  return <div className={C.row}>
    {others.map((button) => <Button
      key={button.id}
      label={button.label}
      tone={button.tone}
      disabled={button.disabled}
      small
      onClick={handlerOf(button.id)}
    />)}
    {start === undefined ? null : (start.confirm === true && confirming
      ? <>
          <Button
            label={`确认${start.label}`}
            tone="warn"
            disabled={start.disabled}
            small
            onClick={() => { setConfirming(false); props.onStart(start.retry === true) }}
          />
          <Button label="取消" small onClick={() => setConfirming(false)} />
        </>
      : <Button
          label={start.label}
          tone={start.tone}
          disabled={start.disabled}
          small
          title={start.disabled ? zhCN.noRows : ''}
          onClick={() => { if (start.confirm === true) { setConfirming(true); return } props.onStart(start.retry === true) }}
        />)}
  </div>
}

function PendingTable(props: ReportPaneProps & { rows: RowView[] }): React.ReactElement {
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
        return <tr key={view.key}>
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
          <td className={`${C.td} ${C.tdNowrap}`}><Badge text={risk.text} tone={risk.tone} /></td>
          <td className={`${C.td} ${C.tdReview}`}>
            <div className={`${C.cellSub} ${C.cellNowrap}`} style={{ marginTop: 0 }}>{`${task.reviewLevel} · ${task.reviewState}`}</div>
            {task.currentNode === '' ? null : <div className={C.cellSub}>{task.currentNode}</div>}
          </td>
          <td className={`${C.td} ${C.tdNowrap}`} title={task.modifiedAt}><div className={C.mono}>{task.modifiedAt}</div></td>
          <td className={`${C.td} ${C.tdAction}`}>
            {view.badges.map((badge) => <Badge key={badge.text} text={badge.text} tone={badge.tone} />)}
            {view.notes.map((note) => <div key={note} className={`${C.muted} ${C.mono}`}>{note}</div>)}
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
              onOpenSession={() => props.onOpenSession(view.key)}
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
        return <tr key={item.seqNo}>
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

  return <div>
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

    {state.escalateAvailable
      ? <Notice tone="warn">
          <div>{zhCN.escalateReason}</div>
          <div style={{ marginTop: '6px' }}>
            <Button label={zhCN.escalateRetry} tone="warn" small onClick={props.onEscalateRetry} />
          </div>
        </Notice>
      : null}

    <div className={C.tabs}>
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
        {zhCN.tabResults}<span className={C.tabCount}>{String(Object.keys(state.ossIndex).length)}</span>
      </button>
    </div>

    {view === 'pending'
      ? <Card
          title={state.formName === '' ? zhCN.tabPending : state.formName}
          extra={<span className={C.muted}>{`共 ${state.total} 条${filterModeText(state.filterMode)}`}</span>}
        >
          {/* 取列表（首屏 / 翻页 / 检索 / 刷新氚云）时给一个看得见的加载态。 */}
          <LoadingBar active={props.gating.busy === true} />
          <div className={C.row}>
            <input
              className={C.input}
              value={query}
              placeholder={zhCN.colSeqNo}
              onChange={(event) => setQuery(String((event.target as { value?: unknown }).value ?? ''))}
            />
            <Button label={zhCN.search} small onClick={() => props.onSearch(query)} />
            <Button label={zhCN.clear} small onClick={() => { setQuery(''); props.onSearch('') }} />
            <span className={C.grow} />
            <Button label={zhCN.refreshPending} small disabled={props.gating.busy === true} onClick={props.onRefreshPending} />
            <Button label={zhCN.refreshCloud} small onClick={props.onRefreshCloud} />
          </div>
          <div className={props.gating.busy === true ? C.dim : ''}>
            <PendingTable {...props} rows={rows} />
            <div className={C.row} style={{ marginTop: '8px' }}>
              <Button label={zhCN.prevPage} small disabled={state.page <= 1} onClick={() => props.onGoPage(state.page - 1)} />
              <span className={C.muted}>{`第 ${state.page} / ${pages} ${zhCN.pageOf}`}</span>
              <Button label={zhCN.nextPage} small disabled={state.page >= pages} onClick={() => props.onGoPage(state.page + 1)} />
              {/* 翻页时用户正看着页面底部：卡片顶部那条进度条常常已经滚出视口，
                  所以加载提示要**跟着翻页控件**再出现一次。 */}
              {props.gating.busy === true && rows.length > 0 ? <Loading text={zhCN.loadingList} /> : null}
            </div>
          </div>
        </Card>
      : <Card
          title={zhCN.tabResults}
          extra={<span className={C.muted}>{`${shownItems.length} ${zhCN.items}`}</span>}
        >
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
            <Button label={zhCN.refreshCloud} small disabled={state.ossLoading} onClick={props.onRefreshCloud} />
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
        </Card>}
  </div>
}
