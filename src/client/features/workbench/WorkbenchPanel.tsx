import * as React from 'react'
import { Notice } from '../../components/primitives.tsx'
import { SideDrawer } from '../../components/SideDrawer.tsx'
import { WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { gatingOf, workbenchApi } from '../report-audit/api.ts'
import type { PendingResult } from '../report-audit/api.ts'
import type { AuditView, CloudItem, TaskRow } from '../../../shared/types.ts'
import { openChildSession } from './open-session.ts'
import type { ClientServices } from './services.ts'
import { EnvironmentPane } from '../environment/EnvironmentPane.tsx'
import { EnvironmentStatusIcon } from '../environment/EnvironmentStatusIcon.tsx'
import { createEnvStatusStore, useEnvStatus, type EnvStatusStore } from '../environment/status.ts'
import { WORKBENCH_PROTOCOL } from '../../../shared/consts.ts'
import { AuditInfoDrawer } from '../report-audit/AuditInfoDrawer.tsx'
import { ReportPane } from '../report-audit/ReportPane.tsx'
import { openReportNotice, openSessionTarget } from '../report-audit/row.ts'

/**
 * 工作台外壳。
 *
 * 职责只有三件：拉数据、把状态分发给下面两页、把用户操作翻译成 RPC。
 * **所有业务规则都不在这里** —— 它们在 `report-audit/row.ts`（可独立测试）与 Host 侧。
 *
 * 视图与门禁（用户要求的行为，别改回去）：
 * - 进入工作台先跑一次环境自检，自检期间显示 loading；
 * - **自检通过就直接进报告审核**；
 * - 不通过就停在环境自检页；点「进入报告审核」会用 loading 状态拦住（当场重新自检一次，
 *   通过才放行），**不通过不给进报告页**；
 * - 环境结论来自 `envStatus` store：会话头那颗指示灯与这里看到的是同一个。
 *
 * 轮询策略：只在报告页处于激活状态时按 10 秒轮询 `audit-status`，卸载时清掉定时器。
 * 轮询本身不是新鲜事，但**必须可释放**：否则切走面板后请求还在跑。
 */

const POLL_INTERVAL_MS = 10_000

export interface WorkbenchPanelProps {
  /** 由 apply 注入的浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  /** 由 apply 创建的环境状态 store；会话头的指示灯与这里共用同一份。 */
  envStatus?: EnvStatusStore
}

export function WorkbenchPanel(props: WorkbenchPanelProps): React.ReactElement {
  // 没从 apply 传进来时（单测直接渲染组件）就地建一个：它属于组件实例，不是模块级单例。
  const fallback = React.useRef<EnvStatusStore | null>(null)
  if (fallback.current === null) fallback.current = createEnvStatusStore()
  const envStatus = props.envStatus ?? fallback.current

  const snapshot = useEnvStatus(envStatus)
  const env = snapshot.env
  const envOk = env !== null && env.allOk === true

  const [view, setView] = React.useState<'env' | 'report'>('env')
  /** 被门禁拦住的界面状态：running = 正在重新自检，blocked = 自检没过。 */
  const [gate, setGate] = React.useState<'idle' | 'running' | 'blocked'>('idle')
  const [bootError, setBootError] = React.useState('')
  /**
   * 宿主报回来的协议代数；null = 还没答（或答失败）。
   *
   * 客户端产物随页面刷新就换新，宿主产物只有重启 profile 才换 —— 不同代时**必须拦住发起审核**，
   * 否则界面是新的、逻辑是旧的，会按旧规则把审核挂到「当前会话」下（实测踩过）。
   */
  const [hostProtocol, setHostProtocol] = React.useState<number | null>(null)
  const [boundParentId, setBoundParentId] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [pending, setPending] = React.useState<PendingResult | null>(null)
  const [audits, setAudits] = React.useState<Record<string, AuditView>>({})
  const [activeKey, setActiveKey] = React.useState('')
  const [activeChildId, setActiveChildId] = React.useState('')
  const [ossIndex, setOssIndex] = React.useState<Record<string, CloudItem>>({})
  const [ossError, setOssError] = React.useState('')
  const [ossLoading, setOssLoading] = React.useState(false)
  const [ossLoaded, setOssLoaded] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [auditBusy, setAuditBusy] = React.useState('')
  const [stopBusy, setStopBusy] = React.useState(false)
  const [retryBusy, setRetryBusy] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [drawer, setDrawer] = React.useState<{ key: string; info: Record<string, unknown> | null; error: string } | null>(null)
  const [wsBusy, setWsBusy] = React.useState(false)
  const [wsMessage, setWsMessage] = React.useState('')
  const [escalateAvailable, setEscalateAvailable] = React.useState(false)
  const [handoff, setHandoff] = React.useState<TaskRow | null>(null)
  const [handoffCopied, setHandoffCopied] = React.useState(false)
  const [prompt, setPrompt] = React.useState('')
  const [promptUrl, setPromptUrl] = React.useState('')
  const [promptBusy, setPromptBusy] = React.useState(false)
  const [promptCopied, setPromptCopied] = React.useState(false)
  const [promptMessage, setPromptMessage] = React.useState('')
  // 请求序号：迟到的应答必须被丢弃，否则快速切换时会显示上一条的内容。
  const requestSeq = React.useRef(0)
  // 卸载标记：面板切走之后到达的应答**不得**再写状态。
  // 没有这个守卫时，React 会对已卸载组件设置状态，而且旧数据可能覆盖下一次挂载的结果。
  const mounted = React.useRef(true)
  // 「已经自动进过报告页」：用户手动回环境自检页之后不许再把他弹走。
  const autoEntered = React.useRef(false)

  const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

  const loadPrompt = React.useCallback(async () => {
    setPromptBusy(true)
    try {
      const result = await workbenchApi.installPrompt({})
      if (!mounted.current) return
      setPrompt(result.prompt ?? '')
      setPromptUrl(result.url ?? '')
    } catch (cause) {
      if (mounted.current) setPromptMessage(describe(cause))
    } finally {
      if (mounted.current) setPromptBusy(false)
    }
  }, [])

  const loadCloud = React.useCallback(async (force: boolean) => {
    // **只在首次进入、显式刷新或上传成功后列举 OSS**：切标签、翻页、检索都不得重复列举。
    if (!force && ossLoaded) return
    setOssLoading(true)
    try {
      const result = await workbenchApi.ossIndex()
      if (!mounted.current) return
      if (result.ok) {
        setOssIndex(result.items)
        setOssError('')
      } else {
        // 云端清单失败**不拖垮氚云列表**：只记错误，列表照常显示。
        setOssError(result.error)
      }
      setOssLoaded(true)
    } catch (cause) {
      if (mounted.current) setOssError(describe(cause))
    } finally {
      if (mounted.current) setOssLoading(false)
    }
  }, [ossLoaded])

  const loadReport = React.useCallback(async (options: { query?: string; page?: number } = {}) => {
    setBusy(true)
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    try {
      const result = await workbenchApi.pending({
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.page === undefined ? {} : { page: options.page }),
      })
      if (!mounted.current || requestSeq.current !== seq) return
      setPending(result)
      setNotice(result.ok ? '' : result.error)
    } catch (cause) {
      if (!mounted.current || requestSeq.current !== seq) return
      setNotice(describe(cause))
    } finally {
      if (mounted.current && requestSeq.current === seq) setBusy(false)
    }
  }, [])

  const refreshAudits = React.useCallback(async () => {
    try {
      const result = await workbenchApi.auditStatus({})
      if (!mounted.current || !result.ok) return
      const next: Record<string, AuditView> = {}
      for (const record of result.audits) next[record.key] = record
      setAudits(next)
      setActiveKey(result.active.key)
      setActiveChildId(result.active.childId)
    } catch (cause) {
      // 轮询失败不改状态：下一轮会自愈，把界面清空反而更糟。
      void cause
    }
  }, [])

  // 首次进入：boot → 环境自检（报告页按需拉列表与云端清单）。
  React.useEffect(() => {
    let alive = true
    workbenchApi.boot()
      .then((result) => {
        if (!alive) return
        if (!result.ok) setBootError('Host 未就绪')
        setHostProtocol(result.protocol ?? null)
        setBoundParentId(result.parentSessionId ?? '')
      })
      .catch((cause: unknown) => { if (alive) setBootError(describe(cause)) })
    void envStatus.refresh()
    void loadPrompt()
    return () => {
      alive = false
      mounted.current = false
    }
  }, [envStatus, loadPrompt])

  // 自检直接通过 → 直接进报告审核。只自动进一次，用户手动回环境页后不再弹走。
  React.useEffect(() => {
    if (!envOk || autoEntered.current) return
    autoEntered.current = true
    setGate('idle')
    setView('report')
  }, [envOk])

  // 报告页激活时才轮询状态；离开时清掉定时器。
  React.useEffect(() => {
    if (view !== 'report') return undefined
    void refreshAudits()
    void loadReport()
    void loadCloud(false)
    const timer = setInterval(() => { void refreshAudits() }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [view, refreshAudits, loadReport, loadCloud])

  /**
   * 「进入报告审核」。
   *
   * 不通过时**不是静默禁用按钮**，而是用 loading 状态拦住并当场重新自检一次：用户刚装完
   * 二进制 / 刚登录完账号，最想做的就是再点一次，而不是先去别处找「重新自检」。
   */
  const enterReport = (): void => {
    if (envOk) {
      autoEntered.current = true
      setGate('idle')
      setView('report')
      return
    }
    setGate('running')
    void envStatus.refresh().then((result) => {
      if (!mounted.current) return
      if (result !== null && result.allOk) {
        autoEntered.current = true
        setGate('idle')
        setView('report')
        return
      }
      setGate('blocked')
    })
  }

  const openAuditInfo = async (key: string, cloud: CloudItem): Promise<void> => {
    setDrawer({ key, info: null, error: '' })
    if (cloud.jsonKey === '') {
      setDrawer({ key, info: null, error: '这条报告没有审核结果 JSON' })
      return
    }
    try {
      const result = await workbenchApi.ossResult({ key: cloud.jsonKey })
      setDrawer({ key, info: result.info, error: result.ok ? '' : result.error })
    } catch (cause) {
      setDrawer({ key, info: null, error: describe(cause) })
    }
  }

  // 宿主与客户端不同代：明说 + 停发起审核（其余只读功能照常）。
  const hostStale = hostProtocol !== null && hostProtocol !== WORKBENCH_PROTOCOL
  const gating = gatingOf(env, activeKey, {
    busy,
    ...(auditBusy === '' ? {} : { auditBusy }),
    stopBusy,
    retryBusy,
    ...(hostStale ? { canDispatch: false, gateReason: zhCN.hostStaleGate } : {}),
  })

  const childAliveHint = activeChildId !== ''
    ? `当前占用的子会话：${activeChildId.slice(0, 8)}…`
    : ''

  const reportState = {
    tasks: (pending?.rows ?? []) as TaskRow[],
    audits,
    ossIndex,
    ossIndexError: ossError,
    ossLoading,
    formName: pending?.formName ?? '',
    query,
    page: pending?.page ?? page,
    pageSize: pending?.size ?? 20,
    total: pending?.total ?? 0,
    filterMode: pending?.filterMode ?? '',
    activeKey,
    escalateAvailable,
    handoff,
    notice,
    childAliveHint,
  }

  // 环境页的公共 props：env===null（正在自检/失败）与已有结论时只差 env 本身。
  const envPane = <EnvironmentPane
    env={env}
    error={snapshot.error !== '' ? snapshot.error : bootError}
    busy={snapshot.busy}
    checkedAt={snapshot.checkedAt}
    onRefresh={() => { void envStatus.refresh() }}
    onCopyPrompt={() => { void loadPrompt() }}
    copied={copied}
    onRelogin={() => { void workbenchApi.relogin().then(() => envStatus.refresh()) }}
    onDwsLogin={() => { void workbenchApi.dwsLogin({}).then(() => envStatus.refresh()) }}
    onTrust={(h3yun) => { void workbenchApi.trust({ h3yun }).then(() => envStatus.refresh()) }}
    onEnterReport={enterReport}
    gate={gate}
    services={props.services}
    wsBusy={wsBusy}
    wsMessage={wsMessage}
    onWsBusy={setWsBusy}
    onWsMessage={setWsMessage}
    prompt={prompt}
    promptUrl={promptUrl}
    promptBusy={promptBusy}
    promptCopied={promptCopied}
    promptMessage={promptMessage}
    onPromptRefresh={() => { setPromptCopied(false); setPromptMessage(''); void loadPrompt() }}
    onPromptCopied={(message) => { setPromptCopied(true); setPromptMessage(message) }}
  />

  return <div className={C.root}>
    <div className={C.header}>
      <span className={C.title}>{zhCN.title}</span>
      <span className={C.grow} />
      {/* 面板自己的右上角指示灯：兼作「回到环境自检」的入口（与环境页的门禁是同一份结论）。 */}
      <EnvironmentStatusIcon
        store={envStatus}
        active={view === 'env'}
        onOpen={() => { setView('env') }}
      />
    </div>

    {bootError === '' ? null : <Notice tone="warn">{bootError}</Notice>}

    {hostStale
      ? <Notice tone="warn">
          <div className={C.itemName}>{zhCN.hostStaleTitle}</div>
          <div>{zhCN.hostStaleHint}</div>
        </Notice>
      : null}

    {view === 'env' || env === null
      ? envPane
      : <ReportPane
          state={reportState}
          gating={gating}
          onSearch={(next) => { setQuery(next); setPage(1); void loadReport({ query: next, page: 1 }) }}
          onGoPage={(next) => { setPage(next); void loadReport({ page: next }) }}
          onRefreshPending={() => { void loadReport() }}
          onRefreshCloud={() => { void loadCloud(true) }}
          onStart={(task, retry) => {
            const key = task.seqNo !== '' ? task.seqNo : task.name
            setAuditBusy(key)
            void workbenchApi.auditStart({
              key,
              seqNo: task.seqNo,
              objectId: task.id,
              project: task.project,
              ...(retry ? { retry: true } : {}),
            }).then((result) => {
              setNotice(result.ok ? '' : result.error)
              // 失败时留下手工兜底：审核本身可以在普通会话里做，不该让用户干等。
              setHandoff(result.ok ? null : task)
              setHandoffCopied(false)
              if (result.ok) {
                setActiveKey(key)
                setActiveChildId(result.childId)
                // 上传成功后才会重新列举 OSS；这里只是启动审核，不动云端清单。
                void refreshAudits()
              }
            }).catch((cause: unknown) => { setNotice(describe(cause)) })
              .finally(() => { setAuditBusy('') })
          }}
          onStop={(childId) => {
            setStopBusy(true)
            void workbenchApi.auditStop(childId === '' ? {} : { childId })
              .then((result) => { setNotice(result.ok ? '' : result.error); return refreshAudits() })
              .catch((cause: unknown) => { setNotice(describe(cause)) })
              .finally(() => { setStopBusy(false) })
          }}
          onRetryUpload={(key) => {
            setRetryBusy(true)
            void workbenchApi.ossUpload({ key })
              .then((result) => {
                setNotice(result.ok ? '' : result.error)
                // 上传成功才重新列举云端清单。
                if (result.ok) void loadCloud(true)
                return refreshAudits()
              })
              .catch((cause: unknown) => { setNotice(describe(cause)) })
              .finally(() => { setRetryBusy(false) })
          }}
          onOpenCloud={(key) => {
            void workbenchApi.ossLink({ key })
              // 判据在 `openReportNotice` 里（纯函数、可单测）：`ok` 只代表签名成功，
              // 「打开浏览器」失败时也必须出声，否则用户只看到「点了没反应」。
              .then((result) => { const note = openReportNotice(result); if (note !== '') setNotice(note) })
              .catch((cause: unknown) => { setNotice(describe(cause)) })
          }}
          onOpenLocalHtml={(key) => {
            const record = audits[key]
            if (record === undefined || record.casePath === '' || record.htmlFile === '') {
              setNotice('这条记录还没有本地 HTML')
              return
            }
            void workbenchApi.openPath({ path: `${record.casePath.replace(/\/+$/, '')}/${record.htmlFile}` })
              .then((result) => { if (!result.ok) setNotice(result.error) })
          }}
          onOpenSession={(key) => {
            // 用**被点那一行**的 key，不要拿 activeKey 顶替：那是「当前在跑的那条」，
            // 点别的行会开到错的孩子，activeKey 为空时报「该记录没有子会话 id。」（实测踩到）。
            const { childId, parentSessionId } = openSessionTarget(key, audits, boundParentId)
            void openChildSession(props.services, { childId, parentSessionId })
              .then((result) => {
                setNotice(result.ok ? `${zhCN.openSessionOpened}${childId.slice(0, 8)}…` : result.error)
              })
          }}
          onOpenAuditInfo={(key, cloud) => { void openAuditInfo(key, cloud) }}
          handoffCopied={handoffCopied}
          onHandoffCopied={setHandoffCopied}
          onEscalateRetry={() => {
            setEscalateAvailable(false)
            setBusy(true)
            void workbenchApi.pending({
              ...(query === '' ? {} : { query }),
              page: reportState.page,
              size: reportState.pageSize,
              escalate: true,
            }).then((result) => {
              setPending(result)
              setEscalateAvailable(result.escalateAvailable === true)
              setNotice(result.ok ? '' : result.error)
            }).catch((cause: unknown) => { setNotice(describe(cause)) })
              .finally(() => { setBusy(false) })
          }}
          onOpenPath={(path) => {
            void workbenchApi.openPath({ path })
              .then((result) => { if (!result.ok) setNotice(result.error) })
          }}
        />}

    {/* 审核信息走**右侧抽屉**：不离开当前列表就能看明细，关掉之后列表还在原来的位置。 */}
    {drawer === null ? null : <SideDrawer
      title={`${zhCN.auditInfo} · ${drawer.key}`}
      onClose={() => setDrawer(null)}
    >
      <AuditInfoDrawer seqNo={drawer.key} info={drawer.info} error={drawer.error} />
    </SideDrawer>}
  </div>
}
