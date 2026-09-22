import * as React from 'react'
import { BrandMark } from '../../components/BrandMark.tsx'
import { Notice } from '../../components/primitives.tsx'
import { Button } from '../../components/primitives.tsx'
import { SideDrawer } from '../../components/SideDrawer.tsx'
import { BUILD_TAG_CLASSES, WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { gatingOf, workbenchApi } from '../report-audit/api.ts'
import type { PendingResult } from '../report-audit/api.ts'
import type { AuditView, CloudItem, TaskRow } from '../../../shared/types.ts'
import { openChildSession } from './open-session.ts'
import type { ClientServices } from './services.ts'
import { EnvironmentPane } from '../environment/EnvironmentPane.tsx'
import { createEnvStatusStore, useEnvStatus, type EnvStatusStore } from '../environment/status.ts'
import { AuditInfoDrawer } from '../report-audit/AuditInfoDrawer.tsx'
import { ReportPane } from '../report-audit/ReportPane.tsx'
import { openReportNotice, openSessionTarget, pendingArgs } from '../report-audit/row.ts'
import { ReportEvalPane } from '../report-eval/ReportEvalPane.tsx'
import { WorkbenchLoading } from './LoadingPane.tsx'
import { createModuleStore, useModule, type ModuleStore } from './module-store.ts'
import { buildTagOf, createBuildStore, hostIsStale, useBuild, type BuildStore } from './build-store.ts'
import { greetingLine } from './greeting.ts'
import { AuthorizationGate } from './AuthorizationGate.tsx'

/**
 * 工作台外壳。
 *
 * 职责只有三件：拉数据、把状态分发给下面三个模块、把用户操作翻译成 RPC。
 * **所有业务规则都不在这** —— 它们在 `report-audit/row.ts`（可独立测试）与 Host 侧。
 *
 * 结构（2026-09-22 重构）：
 * - 头部：标题 + 宿主版本徽章（吸顶不再需要，滚动已经交给正文区）；
 * - 正文：当前模块的内容（环境信息 / 报告审核 / 报告评估占位）；
 * - 底部：**常驻**的模块切换条 —— 无论正文滚到哪，三个模块都点得到。
 *
 * 视图与门禁（用户要求的行为，别改回去）：
 * - 进入工作台先跑一次环境自检，自检期间停在加载态；
 * - **自检通过就直接进报告审核**；
 * - 不通过就停在环境信息页；在报告审核页里则被门禁挡住（说明 + 重新自检 + 回环境信息）；
 * - 环境结论来自 `envStatus` store：侧栏底部那枚入口与这里看到的是同一个。
 *
 * 轮询策略：只在报告审核模块处于激活状态时按 10 秒轮询 `audit-status`，卸载时清掉定时器。
 * 轮询本身不是新鲜事，但**必须可释放**：否则切走面板后请求还在跑。
 */

const POLL_INTERVAL_MS = 10_000

export interface WorkbenchPanelProps {
  /** 由 apply 注入的浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  /** 由 apply 创建的环境状态 store；侧栏入口与这里共用同一份。 */
  envStatus?: EnvStatusStore
  /** 由 apply 创建的「跑的是哪一份插件」store；侧栏入口与这里共用同一份。 */
  build?: BuildStore
  /** 由 apply 创建的模块状态；侧栏那张分组卡上的三个子项与这里的三页是同一个模块。 */
  modules?: ModuleStore
}

export function WorkbenchPanel(props: WorkbenchPanelProps): React.ReactElement {
  // 没从 apply 传进来时（单测直接渲染组件）就地建一个：它属于组件实例，不是模块级单例。
  const fallback = React.useRef<EnvStatusStore | null>(null)
  if (fallback.current === null) fallback.current = createEnvStatusStore()
  const envStatus = props.envStatus ?? fallback.current
  const snapshot = useEnvStatus(envStatus)
  const env = snapshot.env
  const envOk = env !== null && env.allOk === true
  // 问候的姓名来自**环境自检**（`env.me`，钉钉 CLI 在同一次自检里取回），所以这里不额外发请求 ——
  // 用户口径（2026-09-22）：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调」。
  // 按**本地时钟**的小时分档；姓名拿不到时 greetingLine 返回空串 → 整句不渲染。
  const greeting = greetingLine(new Date().getHours(), env?.me?.name ?? '')

  // 「现在跑的是哪一份插件」与侧栏入口共用同一份结论：dev（本地源码检出）还是装好的包 + 版本号。
  // 单测直接渲染组件时没有 props.build，就地建一个（属于组件实例，不是模块级单例）。
  // 模块状态与侧栏那张分组卡共用同一份；单测直接渲染组件时就地造一份（不是模块级单例）。
  const moduleFallback = React.useRef<ModuleStore | null>(null)
  if (moduleFallback.current === null) moduleFallback.current = createModuleStore()
  const modules = props.modules ?? moduleFallback.current
  const mod = useModule(modules)
  const module = mod.active

  const buildFallback = React.useRef<BuildStore | null>(null)
  if (buildFallback.current === null) buildFallback.current = createBuildStore()
  const buildStore = props.build ?? buildFallback.current
  const build = useBuild(buildStore)
  const tag = buildTagOf(build)

  /** 被门禁拦住的界面状态：running = 正在重新自检，blocked = 自检没过。 */
  const [gate, setGate] = React.useState<'idle' | 'running' | 'blocked'>('idle')
  const [copied, setCopied] = React.useState(false)
  // 授权门槛：拒绝**不落盘**（下次打开页面还会再问）；同意落盘在 Host 的 trustCredentials 里。
  const [authDeclined, setAuthDeclined] = React.useState(false)
  const [authBusy, setAuthBusy] = React.useState(false)
  const [authError, setAuthError] = React.useState('')
  const [pending, setPending] = React.useState<PendingResult | null>(null)
  const [audits, setAudits] = React.useState<Record<string, AuditView>>({})
  const [activeKey, setActiveKey] = React.useState('')
  const [activeChildId, setActiveChildId] = React.useState('')
  const [ossIndex, setOssIndex] = React.useState<Record<string, CloudItem>>({})
  // 按流水号查云端交付件：查的是哪个流水号、命中什么、是否已经查过。
  const [cloudSearch, setCloudSearch] = React.useState({
    seqNo: '', items: [] as CloudItem[], error: '', busy: false, done: false,
  })
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
    // **只在首次进入、显式刷新或上传成功后列举 OSS**：切模块、翻页、检索都不得重复列举。
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

  const searchCloud = React.useCallback(async (raw: string) => {
    const seqNo = raw.trim()
    // 用户操作触发 → 允许**一次**列举，且只列这一个流水号那一层。
    setCloudSearch({ seqNo, items: [], error: '', busy: true, done: false })
    try {
      const result = await workbenchApi.ossIndex({ seqNo })
      if (!mounted.current) return
      setCloudSearch({
        seqNo,
        items: result.ok ? Object.values(result.items) : [],
        error: result.ok ? '' : result.error,
        busy: false,
        done: true,
      })
    } catch (cause) {
      if (mounted.current) setCloudSearch({ seqNo, items: [], error: describe(cause), busy: false, done: true })
    }
  }, [])

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

  // 「本地的审核记录 / 子会话是否已经查过一次」。报告行的主操作标签（AI 审核 / 重新审核）
  // 取决于这份数据，所以**必须先有它再画行**：否则用户会看到「AI 审核」先出现、
  // 过一会儿跳成「重新审核」（用户 2026-09-22 报的一致性问题）。
  const [auditsReady, setAuditsReady] = React.useState(false)

  const refreshAudits = React.useCallback(async () => {
    try {
      const result = await workbenchApi.auditStatus({})
      if (!mounted.current || !result.ok) return
      setAuditsReady(true)
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

  // 首次进入：boot（宿主版本 / 协议代数 / 已登记父级）+ 环境自检 + 安装提示词。
  // 侧栏入口也会 refresh 这两个 store，store 内部做并发去重，所以整页只发一次真实请求。
  React.useEffect(() => {
    void buildStore.refresh()
    // 自检**一次就够**：用户口径（2026-09-22）「这个钉钉 cli 环境监测一遍就可以了，不需要每次
    // 切换页面都去调，本质就是从环境信息把这个人的信息拿到」。面板会被关掉再打开（切会话、
    // 切模块），而一次自检要探二进制、问氚云与钉钉、列一次 OSS —— 所以只在**还没有结论**时补一次；
    // 要重跑有页面上的「重新自检」按钮，以及登录 / 授权成功后的那几次显式刷新。
    const current = envStatus.get()
    if (current.env === null && !current.busy) void envStatus.refresh()
    void loadPrompt()
    return () => {
      mounted.current = false
    }
  }, [envStatus, loadPrompt, buildStore])

  // 自检直接通过 → 直接进报告审核。只自动进一次，用户手动切过模块之后不再弹走。
  // 「自动进过没有」记在 store 里（不再是组件内的 ref）：面板关掉再打开也不该把用户弹走第二次。
  React.useEffect(() => {
    if (!envOk) return
    if (modules.get().autoEntered) return
    modules.autoEnter(true)
    setGate('idle')
  }, [envOk, modules])

  // 从侧栏子项切模块时清掉上一次的拦截态：用户已经补好环境、再点回「报告审核」，
  // 不能还看到那张过期的「自检没过」拦截屏（以前由底部模块条的 onSelect 负责）。
  React.useEffect(() => {
    if (mod.selectEpoch === 0) return
    setGate('idle')
  }, [mod.selectEpoch])

  // 报告审核模块激活时才轮询状态；离开时清掉定时器。
  React.useEffect(() => {
    if (module !== 'audit' || !envOk) return undefined
    void refreshAudits()
    void loadReport()
    void loadCloud(false)
    const timer = setInterval(() => { void refreshAudits() }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [module, envOk, refreshAudits, loadReport, loadCloud])

  /**
   * 「进入报告审核」。
   *
   * 不通过时**不是静默禁用按钮**，而是用 loading 状态拦住并当场重新自检一次：用户刚装完
   * 二进制 / 刚登录完账号，最想做的就是再点一次，而不是先去别处找「重新自检」。
   */
  const enterReport = (): void => {
    if (envOk) {
      modules.select('audit')
      setGate('idle')
      return
    }
    setGate('running')
    void envStatus.refresh().then((result) => {
      if (!mounted.current) return
      if (result !== null && result.allOk) {
        modules.select('audit')
        setGate('idle')
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

  // 授权态：Host 的 `env.trust.credentials` 是唯一判据（落盘后重启仍在）。
  const authorized = env !== null && env.trust.credentials === true
  const showGate = env !== null && !authorized
  const grantCredentials = (): void => {
    setAuthBusy(true)
    setAuthError('')
    void workbenchApi.trust({ credentials: true })
      .then((result) => {
        // 写盘失败时 Host 回 `persistError`：不能假装已授权（下次重启就没了）。
        const persistError = typeof result.persistError === 'string' ? result.persistError : ''
        if (persistError !== '') { setAuthError(persistError); return null }
        setAuthDeclined(false)
        return envStatus.refresh()
      })
      .catch((cause: unknown) => { setAuthError(describe(cause)) })
      .finally(() => { setAuthBusy(false) })
  }

  // 宿主与客户端不同代：明说 + 停发起审核（其余只读功能照常）。
  // 客户端产物随页面刷新就换新，宿主产物只有重启 profile 才换 —— 不同代时必须拦住，
  // 否则界面是新的、逻辑是旧的，会按旧规则把审核挂到「当前会话」下（实测踩过）。
  const hostStale = hostIsStale(build)
  /**
   * 是不是"第一次进来、还没拿到自检结论"。
   *
   * 三种情况下**不**显示等待页：
   * - 已经有结论（那当然直接渲染对应模块）；
   * - 宿主是旧构建（那是配置问题，要看到「请重启 profile」那句话，转圈会把它藏起来）；
   * - 请求已经失败（`snapshot.error` 非空）—— 失败要看到真实原因，不能一直转圈。
   */
  const awaitingEnv = env === null && !hostStale && snapshot.error === ''
  const bootError = build.error
  const boundParentId = build.parentSessionId
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
    /** 审核记录查过没有 —— 报告页据此决定"现在能不能画行"（见 ReportPaneState 注释）。 */
    auditsReady,
    ossIndex,
    ossIndexError: ossError,
    ossLoading,
    cloudSearchSeqNo: cloudSearch.seqNo,
    cloudSearchItems: cloudSearch.items,
    cloudSearchError: cloudSearch.error,
    cloudSearchBusy: cloudSearch.busy,
    cloudSearchDone: cloudSearch.done,
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

  // 环境信息页的公共 props：env===null（正在自检/失败）与已有结论时只差 env 本身。
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
    promptMessage={promptMessage}
  />

  /**
   * 报告审核模块被门禁挡住时的正文。
   *
   * 它和「环境信息」页不是一回事：这里只回答两件事 —— 为什么进不去、以及下一步点哪。
   * 详细的分层排查留在环境信息模块里（那是它唯一的职责）。
   */
  const auditGate = <div className={C.gate}>
    <div className={C.gateTitle}>
      {gate === 'running' ? zhCN.gateRunningTitle : zhCN.gateBlockedTitle}
    </div>
    <div className={C.muted}>{gate === 'running' ? zhCN.gateRunningHint : zhCN.gateBlockedHint}</div>
    <div className={C.row} style={{ marginTop: '12px' }}>
      <Button label={zhCN.recheck} tone="primary" disabled={gate === 'running'} onClick={enterReport} />
      <Button label={zhCN.moduleEnv} onClick={() => { modules.select('env') }} />
    </div>
    {env !== null && env.blocked.length > 0
      ? <ul className={C.blockers}>
          {env.blocked.map((item, index) => <li key={item} className={C.blocker}>
            <span className={C.blockerIndex}>{String(index + 1)}</span>
            <span>{item}</span>
          </li>)}
        </ul>
      : null}
  </div>

  return <div className={C.root}>
    <div className={C.header}>
      {/* 品牌标记：与侧栏入口同一个图形（用户给的原图描成的矢量版）。 */}
      <BrandMark size={22} />
      <span className={C.title}>{zhCN.title}</span>
      {/* 同一枚小标签：dev（本地源码检出）或 v<版本>（装好的包）。
          客户端刷新就换新、宿主只有重启才换，所以这枚标签是「我到底在跑哪一版」的唯一凭据
          （悬停看形态说明与构建时间）。 */}
      <span className={[C.version, BUILD_TAG_CLASSES[tag.tone]].join(' ')} title={tag.title}>{tag.text}</span>
      <span className={C.grow} />
      {/* 头部右侧只放一句问候：`下午好，杨凡宾`。姓名来自宿主的钉钉 CLI（`whoami`），
          **拿不到就整句不渲染**（用户 2026-09-22 口径：钉钉 CLI 没有登录信息就什么也不展示）。
          这里原先写的是当前模块名，用户要求去掉 —— 模块在哪一页由侧栏那张分组卡的高亮说了算。 */}
      {greeting === '' ? null : <span className={C.greeting}>{greeting}</span>}
    </div>

    {/* 未授权：整块面板被门槛盖住（Host 侧另有 blocked 兜底，绕过 UI 调操作也进不去）。
        授权是一次落盘写，所以按钮期间禁用，失败如实显示（`persistError` 语义）。 */}
    {showGate
      ? <AuthorizationGate
          declined={authDeclined}
          busy={authBusy}
          error={authError}
          onAgree={grantCredentials}
          onDecline={() => { setAuthDeclined(true) }}
          onRegrant={() => { setAuthError(''); setAuthDeclined(false) }}
        />
      : null}

    <div className={C.body}>
      {bootError === '' ? null : <Notice tone="warn">{bootError}</Notice>}

      {hostStale
        ? <Notice tone="warn">
            <div className={C.itemName}>{zhCN.hostStaleTitle}</div>
            <div>{zhCN.hostStaleHint}</div>
          </Notice>
        : null}

      {/* 自检没出结论之前，正文只放这一页统一等待页 —— 这时候谈"在哪一页"没有意义：
          结论一到，autoEnter() 会把用户送到该去的那一页（通过 → 报告审核，不通过 → 环境信息）。 */}
      {awaitingEnv ? <WorkbenchLoading /> : null}

      {/* 「报告评估」还没开放：这一页是 Coming Soon，页内给一条去「报告审核」的路。 */}
      {!awaitingEnv && module === 'eval'
        ? <ReportEvalPane onGoAudit={() => { modules.select('audit') }} />
        : null}

      {!awaitingEnv && (module === 'env' || env === null) ? envPane : null}

      {module === 'audit' && env !== null
        ? (envOk
            ? <ReportPane
                state={reportState}
                gating={gating}
                workspace={{ id: env?.workspace.id ?? '', path: env?.workspace.path ?? '' }}
                // 讨论面板要的是**会话服务本身**（create/open/binding/list 四个动词）。
                // 服务可能缺席（别的部署/旧宿主），面板会自己降级成一句「请用会话中打开」。
                port={props.services.sessions ?? {}}
                onOpenDiscussion={(sessionId) => {
                  // 「在会话中打开」= 把这条讨论会话设为当前会话 + 主面板切回原生对话
                  // （工具调用、审批、完整渲染都在那边）。
                  props.services.sessions?.open?.(sessionId)
                  props.services.layout?.selectPanel?.(null)
                }}
                onSearch={(next) => { setQuery(next); setPage(1); void loadReport(pendingArgs(next, 1)) }}
                onGoPage={(next) => { setPage(next); void loadReport(pendingArgs(query, next)) }}
                onRefreshPending={() => { void loadReport(pendingArgs(query, page)) }}
                onRefreshCloud={() => { void loadCloud(true) }}
                onSearchCloud={(seqNo) => { void searchCloud(seqNo) }}
                onClearCloudSearch={() => { setCloudSearch({ seqNo: '', items: [], error: '', busy: false, done: false }) }}
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
              />
            : auditGate)
        : null}
    </div>

    {/* 审核信息走**右侧抽屉**：不离开当前列表就能看明细，关掉之后列表还在原来的位置。 */}
    {drawer === null ? null : <SideDrawer
      title={`${zhCN.auditInfo} · ${drawer.key}`}
      onClose={() => setDrawer(null)}
    >
      <AuditInfoDrawer seqNo={drawer.key} info={drawer.info} error={drawer.error} />
    </SideDrawer>}
  </div>
}
