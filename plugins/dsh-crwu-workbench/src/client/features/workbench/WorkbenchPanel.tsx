import * as React from 'react'
import { BrandMark } from '../../components/BrandMark.tsx'
import { Notice } from '../../components/primitives.tsx'
import { Button } from '../../components/primitives.tsx'
import { SideDrawer } from '../../components/SideDrawer.tsx'
import { BUILD_TAG_CLASSES, WORKBENCH_CLASSES as C } from './consts.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { environmentStateOf, gatingOf, workbenchApi } from '../report-audit/api.ts'
import type { PendingResult } from '../report-audit/api.ts'
import type { AuditView, CloudItem, DwsLocalDoctorView, DwsLocalRepairView, TaskRow } from '../../../shared/types.ts'
import { openChildSession } from './open-session.ts'
import { discussionPortOf } from './services.ts'
import type { ClientServices } from './services.ts'
import { EnvironmentPane } from '../environment/EnvironmentPane.tsx'
import { createEnvStatusStore, useEnvStatus, type EnvStatusStore } from '../environment/status.ts'
import { AuditInfoDrawer } from '../report-audit/AuditInfoDrawer.tsx'
import { ReportPane } from '../report-audit/ReportPane.tsx'
import { openReportNotice, openSessionTarget, pendingArgs } from '../report-audit/row.ts'
import { ReportEvalPane } from '../report-eval/ReportEvalPane.tsx'
import { WorkbenchLoading } from './LoadingPane.tsx'
import { createModuleStore, useModule, type ModuleStore } from './module-store.ts'
import { moduleLabel, type ModuleId } from './modules.ts'
import type { NavigateResult } from '../../../shared/environment/model.ts'
import { buildTagOf, createBuildStore, currentVersionOf, hostIsStale, hostPermissionSchemaStale, useBuild, type BuildStore } from './build-store.ts'
import { consentGranted, consentOf, consentRequestCapabilities } from '../environment/local-access.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../../shared/access/types.ts'
import { UpdateDialog } from '../update/UpdateDialog.tsx'
import { useUpdateDialog, useUpdateStore } from '../update/react.ts'
import { updateViewModelOf, type UpdateBadgeTone } from '../update/view-model.ts'
import type { UpdateDialogStore } from '../update/dialog-store.ts'
import type { UpdateStore } from '../update/update-store.ts'
import { greetingLine } from './greeting.ts'

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
  /** 由 apply 创建的更新状态；侧栏那枚版本徽标与这里的更新面板共用同一份。 */
  update?: UpdateStore
  /** 由 apply 创建的更新面板开关状态（侧栏徽标点开的就是它）。 */
  updateDialog?: UpdateDialogStore
  /** 当前平台：决定等待重启说明里的 macOS 提示。 */
  platform?: 'mac' | 'other'
  /** 过期判据用的时钟；缺省本机时钟（测试注入固定值）。 */
  now?: () => number
}

/** 更新徽标的语气 → 附加类（与侧栏入口共用同一套）。 */
const UPDATE_TONE_CLASSES: Record<UpdateBadgeTone, string> = {
  neutral: '',
  accent: C.updateBadgeAccent,
  warn: C.updateBadgeWarn,
  success: C.updateBadgeOk,
}

export function WorkbenchPanel(props: WorkbenchPanelProps): React.ReactElement {
  // 没从 apply 传进来时（单测直接渲染组件）就地建一个：它属于组件实例，不是模块级单例。
  const fallback = React.useRef<EnvStatusStore | null>(null)
  if (fallback.current === null) fallback.current = createEnvStatusStore()
  const envStatus = props.envStatus ?? fallback.current
  const snapshot = useEnvStatus(envStatus)
  const env = snapshot.env
  const envState = environmentStateOf(env)
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
  /**
   * **统一导航入口的本地包装**。
   *
   * 每一次跳转（侧栏子项、环境页的「进入报告审核」、报告页内跳转、报告评估页的引导）
   * 都走这一条：门禁判据只有一份（`module-store` → `shared/environment/model.ts` 的纯函数），
   * 面板不再自己写"能不能进 audit"。
   */
  const go = React.useCallback((target: ModuleId): NavigateResult => {
    const verdict = modules.navigate(target, { state: environmentStateOf(envStatus.get().env) })
    if (verdict.blocked && mounted.current) {
      // 被门禁拦下来：把原因留下来（环境页顶部会显示「进入【目标页】前…」）。
      setNotice(verdict.reason)
    }
    return verdict
  }, [modules, envStatus])

  const buildFallback = React.useRef<BuildStore | null>(null)
  if (buildFallback.current === null) buildFallback.current = createBuildStore()
  const buildStore = props.build ?? buildFallback.current
  const build = useBuild(buildStore)
  const tag = buildTagOf(build)
  // 自助更新：与侧栏那枚徽标共用**同一个** store（apply 里创建的唯一一份）。
  // hook 无条件调用，缺省时不注入任何东西（单测直接渲染组件也能跑）。
  const updateSnapshot = useUpdateStore(props.update)
  const updateDialogState = useUpdateDialog(props.updateDialog)

  /** 被门禁拦住的界面状态：running = 正在重新自检，blocked = 自检没过。 */
  const [gate, setGate] = React.useState<'idle' | 'running' | 'blocked'>('idle')
  // 登录结果（成功/失败原因/CLI 打印的 URL 或设备码）。**不能丢**：命令跑不起来时
  // 它是用户唯一的线索 —— 实测「点了钉钉登录没有任何反应」就是因为它被丢掉了。
  const [loginMessage, setLoginMessage] = React.useState('')
  // 授权门槛：拒绝**不落盘**（下次打开页面还会再问）；同意落盘在 Host 的 trustCredentials 里。
  const [authDeclined, setAuthDeclined] = React.useState(false)
  const [authBusy, setAuthBusy] = React.useState(false)
  const [authError, setAuthError] = React.useState('')
  const [pending, setPending] = React.useState<PendingResult | null>(null)
  const [audits, setAudits] = React.useState<Record<string, AuditView>>({})
  /**
   * 本地记下的"我刚点过停止"的时刻（F1）。
   *
   * `audit-stop` 是两阶段的：RPC 只**接受**请求，真正停下要等后台。而状态轮询是 10 秒一次 ——
   * 只靠轮询的话，用户点完会盯着没反应的按钮最多 10 秒。本地这个时刻让界面立刻显示
   * 「正在请求停止审核…」，阶段与结论仍然以 Host 回报为准。
   */
  const [stopRequestedAt, setStopRequestedAt] = React.useState(0)
  /**
   * Host 说"现在能不能启动下一条审核"（F4）。**只信 Host**：
   * 缺字段（旧宿主）按"没有正在停的审核"处理，否则老版本界面会被永久禁用。
   */
  const [canStartNext, setCanStartNext] = React.useState(true)
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
  /** Drawer 正在播关闭动画（150ms 后再卸载）。 */
  const [drawerClosing, setDrawerClosing] = React.useState(false)
  const drawerTimer = React.useRef<number | null>(null)
  const [wsBusy, setWsBusy] = React.useState(false)
  const [wsMessage, setWsMessage] = React.useState('')
  // 钉钉本机目录体检（协议 18 · D）：诊断结果是**组件状态**，不进全局 store ——
  // 它只服务这一个面板，而且"查过一次"这个事实本身没有跨页面意义。
  const [dwsLocal, setDwsLocal] = React.useState<DwsLocalDoctorView | null>(null)
  const [dwsLocalRepair, setDwsLocalRepair] = React.useState<DwsLocalRepairView | null>(null)
  const [dwsLocalBusy, setDwsLocalBusy] = React.useState(false)
  const [dwsLocalError, setDwsLocalError] = React.useState('')
  // 二次确认：**许可**（允许读本机凭据）与**改权限**是两件事，必须分开问。
  const [dwsLocalConfirming, setDwsLocalConfirming] = React.useState(false)
  const [escalateAvailable, setEscalateAvailable] = React.useState(false)
  const [handoff, setHandoff] = React.useState<TaskRow | null>(null)
  const [handoffCopied, setHandoffCopied] = React.useState(false)
  // 请求序号：迟到的应答必须被丢弃，否则快速切换时会显示上一条的内容。
  const requestSeq = React.useRef(0)
  // 卸载标记：面板切走之后到达的应答**不得**再写状态。
  // 没有这个守卫时，React 会对已卸载组件设置状态，而且旧数据可能覆盖下一次挂载的结果。
  const mounted = React.useRef(true)

  const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

  // 卸载时清掉关闭动画的计时器（面板关掉之后不许再 setState）。
  React.useEffect(() => () => {
    if (drawerTimer.current !== null) window.clearTimeout(drawerTimer.current)
  }, [])

  /**
   * 跑一次登录并把结果**显示出来**。
   *
   * 这两条命令会开浏览器、等人扫码（宿主侧超时 5 分钟），所以：成功也要给一句话，
   * 失败必须带原因，CLI 打到 stdout 的 URL / 设备码 / 提示原样带出来 —— 浏览器打不开时，
   * 那串 URL 就是员工唯一能自己走下去的路。
   */
  const runLogin = React.useCallback(async (label: string, call: () => Promise<{ ok: boolean; error?: string; timedOut?: boolean; stdoutTail?: string; stderrTail?: string }>) => {
    setLoginMessage(`${label}：正在等待浏览器授权…（最多 5 分钟）`)
    try {
      const result = await call()
      if (!mounted.current) return
      const lines: string[] = []
      if (result.ok) lines.push(`${label}：命令已执行完成，请刷新查看结果。`)
      else if (result.timedOut === true) lines.push(`${label}：等待超时（5 分钟）。若浏览器没有自动打开，请重试或改用设备码登录。`)
      else lines.push(`${label}失败：${result.error || result.stderrTail || '未知原因'}`)
      const detail = (result.stdoutTail ?? '').trim() || (result.stderrTail ?? '').trim()
      if (detail !== '') lines.push(detail)
      setLoginMessage(lines.join('\n'))
    } catch (cause) {
      if (mounted.current) setLoginMessage(`${label}失败：${describe(cause)}`)
    }
    if (mounted.current) await envStatus.refresh()
  }, [envStatus])

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

  /**
   * 「复制诊断」：把当前审核的停止诊断整理成一段可粘贴的文本。
   *
   * 只放**维护者需要的事实**（key / childId 尾 / 阶段 / 错误 / 观察 / attempt / 开始时间）——
   * 路径、凭据一律不进（脱敏口径见 AGENTS §4.4.2）。
   */
  const copyStopDiagnostics = React.useCallback((key: string) => {
    const record = audits[key]
    if (record === undefined) return
    const stop = record.stop
    const lines = [
      `key=${key}`,
      `child=${record.childId === '' ? '(空)' : record.childId.slice(-8)}`,
      `attempt=${record.attempt}`,
      `status=${record.status}`,
      `startedAt=${record.startedAt}`,
      `stop.phase=${stop?.phase ?? '(未知)'}`,
      `stop.quiesced=${String(stop?.quiesced ?? '(未知)')}`,
      `stop.aborted=${String(stop?.aborted ?? '(未知)')}`,
      `stop.disposed=${String(stop?.disposed ?? '(未知)')}`,
      `stop.elapsedMs=${String(stop?.elapsedMs ?? 0)}`,
      `stop.error=${stop?.error === undefined || stop.error === '' ? '(无)' : stop.error}`,
      `stop.notes=${stop?.notes === undefined || stop.notes.length === 0 ? '(无)' : stop.notes.join('；')}`,
    ].join('\n')
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard
    if (clipboard?.writeText !== undefined) {
      void clipboard.writeText(lines).then(() => { setNotice(zhCN.copyDiagnosticsDone) }).catch(() => { setNotice(zhCN.copyDiagnosticsFailed) })
      return
    }
    // 没有浏览器剪贴板（旧 webview）→ 退回宿主剪贴板。
    void workbenchApi.clipboard({ text: lines })
      .then((result) => { setNotice(result.ok ? zhCN.copyDiagnosticsDone : result.error) })
      .catch((cause: unknown) => { setNotice(describe(cause)) })
  }, [audits])

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
      setCanStartNext(result.canStartNext !== false)
    } catch (cause) {
      // 轮询失败不改状态：下一轮会自愈，把界面清空反而更糟。
      void cause
    }
  }, [])

  // 首次进入：boot（宿主版本 / 协议代数 / 已登记父级）+ 环境自检。
  // 侧栏入口也会 refresh 这两个 store，store 内部做并发去重，所以整页只发一次真实请求。
  React.useEffect(() => {
    void buildStore.refresh()
    // 自检**一次就够**：用户口径（2026-09-22）「这个钉钉 cli 环境监测一遍就可以了，不需要每次
    // 切换页面都去调，本质就是从环境信息把这个人的信息拿到」。面板会被关掉再打开（切会话、
    // 切模块），而一次自检要探二进制、问氚云与钉钉、列一次 OSS —— 所以只在**还没有结论**时补一次；
    // 要重跑有页面上的「重新自检」按钮，以及登录 / 授权成功后的那几次显式刷新。
    const current = envStatus.get()
    if (current.env === null && !current.busy) void envStatus.refresh()
    // 自助更新：面板也调一次 initialize()，store 自己保证幂等 + 单飞
    //（侧栏那枚常驻徽标通常已经先跑过，这里不会重复请求）。
    if (props.update !== undefined && !props.update.get().initialized) void props.update.initialize()
    return () => {
      mounted.current = false
    }
  }, [envStatus, buildStore])

  // 环境结论落地 → 交给 store 决定两件事：首次自动落位一次；以及**检查通过后恢复**
  // 最近一次被门禁拦下来的目标（没有 pendingTarget 时什么都不做，绝不无条件弹走用户）。
  //
  // 依赖用**统一模型的引用**：它是 Host 每次应答里的新对象，只在自检真的回来时变化。
  // 只盯解出来的 `env` 会漏掉「重新检查通过了、但 active 已经被用户改过」的那次通知，
  // 表现就是"检查通过了、人还卡在环境页"（实测踩到）。
  React.useEffect(() => {
    if (envState === null) return
    modules.envChanged({ state: envState })
  }, [modules, envState])

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
   * 走统一导航：能进就进；不能进时**不是静默禁用按钮**，而是当场重新检查一次环境 ——
   * 用户刚装完 / 刚登录完，最想做的就是再点一次，而不是先去别处找「重新检查」。
   * 检查通过后由 store 恢复这个被拦下来的目标（`pendingTarget`）。
   */
  const enterReport = (): void => {
    const verdict = go('audit')
    // 被拦时统一导航层已经记下 `blocked` + `gateReason`（上面那段 props 直接读它）；
    // 通过时把它清回 idle。
    setGate(verdict.blocked ? 'blocked' : 'idle')
  }

  /** 顶部结论卡与拦截屏共用的「重新检查环境」：跑完让 store 决定要不要恢复目标。 */
  const recheck = (): void => {
    setGate('running')
    void envStatus.refresh({ refresh: true }).then((result) => {
      if (!mounted.current) return
      const state = environmentStateOf(result)
      // 检查结论落地后由 store 统一决定"恢复还是继续留在环境页"。
      modules.envChanged({ state })
      setGate(result !== null && state?.proceed === true ? 'idle' : 'blocked')
    })
  }

  /** 抽屉里「查看更多审核依据」的动作：打开这一行的交付件 HTML（没有就不给入口）。 */
  const reportOpenerOf = (key: string): (() => void) | undefined => {
    const cloud = ossIndex[key]
    if (cloud === undefined || cloud.htmlKey === '') return undefined
    const htmlKey = cloud.htmlKey
    return () => {
      void workbenchApi.ossLink({ key: htmlKey })
        // 判据在 `openReportNotice` 里（纯函数、可单测）：`ok` 只代表签名成功，
        // 「打开浏览器」失败时也必须出声，否则用户只看到「点了没反应」。
        .then((result) => { const note = openReportNotice(result); if (note !== '') setNotice(note) })
        .catch((cause: unknown) => { setNotice(describe(cause)) })
    }
  }

  /**
   * 关闭 Drawer：**先播 150ms 关闭动画，再卸载**。
   *
   * `onClose` 依旧被立刻调用（Esc / 遮罩 / × 的行为不变），只是把"从 DOM 上消失"
   * 推迟到动画之后；重新打开会取消上一次的计时器，避免"关到一半又打开"时被中途卸载。
   */
  const closeDrawer = React.useCallback((): void => {
    setDrawerClosing(true)
    if (drawerTimer.current !== null) window.clearTimeout(drawerTimer.current)
    drawerTimer.current = window.setTimeout(() => {
      drawerTimer.current = null
      setDrawer(null)
      setDrawerClosing(false)
    }, 150)
  }, [])

  const openAuditInfo = async (key: string, cloud: CloudItem): Promise<void> => {
    // 上一次的关闭动画还没跑完就又打开了：取消卸载，直接换成新的内容。
    if (drawerTimer.current !== null) { window.clearTimeout(drawerTimer.current); drawerTimer.current = null }
    setDrawerClosing(false)
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

  // 授权态：Host 回的本机访问收据（`env.localAccess`）是**唯一**判据（落盘后重启仍在）。
  // 客户端不许从「有没有凭据 / 是不是登录过」倒推 —— 那正是"未授权时报未登录"的来源。
  // 未授权**不遮住整页**（用户口径：「不要让一个模态层遮住整个环境页」）：它变成
  // 「账号连接」这一步里的第一张卡；真实门禁仍在 Host 侧（未授权一律拒绝）。
  const consent = consentOf(env)
  const authorized = env !== null && consentGranted(env)
  /**
   * 允许本机访问。
   *
   * 提交的是**规范能力清单 + 权限说明版本**（不是 `{credentials: true}`）：Host 逐字核对清单，
   * 所以「界面显示的清单」与「落盘的收据」不可能不一致。返回的 `consent` 是回读结果 ——
   * 写盘失败时它不是 granted，界面就照实说"没有获得权限"，而不是一句成功提示。
   */
  const grantCredentials = (): void => {
    setAuthBusy(true)
    setAuthError('')
    void workbenchApi.localAccessGrant({
      schemaVersion: PERMISSION_SCHEMA_VERSION,
      capabilities: consentRequestCapabilities(),
    })
      .then((result) => {
        if (result.ok !== true) { setAuthError(result.error || zhCN.envConsentPersistFailedGrant); return null }
        setAuthDeclined(false)
        return envStatus.refresh()
      })
      .catch((cause: unknown) => { setAuthError(describe(cause)) })
      .finally(() => { setAuthBusy(false) })
  }
  /** 撤销本机访问：Host 侧**内存先关**，写盘失败也 fail closed（只在界面上如实报错）。 */
  const revokeCredentials = (): void => {
    setAuthBusy(true)
    setAuthError('')
    void workbenchApi.localAccessRevoke()
      .then((result) => {
        setAuthDeclined(false)
        // **撤销失败时不刷新环境**：宿主内存里已经关闭，但磁盘上可能还是上一份授权；
        // 刷新会走一次 `syncLocalAccessConsent`，把那份旧授权重新采纳回来 ——
        // 界面上就会出现"明明报了失败，却仍然是已允许"。宿主侧也有墓碑兜底（见 consent.ts），
        // 这里不去触发那条路径，是为了不制造一个自相矛盾的画面。
        if (result.ok !== true) {
          setAuthError(result.error || zhCN.envConsentPersistFailed)
          return undefined
        }
        return envStatus.refresh()
      })
      .catch((cause: unknown) => { setAuthError(describe(cause)) })
      .finally(() => { setAuthBusy(false) })
  }

  // 宿主与客户端不同代：明说 + 停发起审核（其余只读功能照常）。
  // 客户端产物随页面刷新就换新，宿主产物只有重启 profile 才换 —— 不同代时必须拦住，
  // 否则界面是新的、逻辑是旧的，会按旧规则把审核挂到「当前会话」下（实测踩过）。
  const hostStale = hostIsStale(build)
  // 权限说明版本不一致（含旧宿主没给这个字段）：**本机凭据操作必须停住**（授权卡整体禁用），
  // 因为执行旧授权范围的宿主"看起来授权成功"比拦住更危险。
  //
  // 为什么它不像 `hostStale` 那样替换整屏：协议 18 起两者是同一个 bundle 里的常量，
  // 「协议相同但 schema 不同」只有被改过的产物才可能出现 —— 那种情况下该拦的是凭据动作，
  // 而不是把整个工作台（包括只读的诊断信息）也一起换掉。
  const permissionStale = hostPermissionSchemaStale(build)
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
  // 有审核在跑时禁的是"安装"（不动 profile），**不禁检查** —— 这一点由 View Model 决定。
  // 判据只认两种**真的在跑审核**的状态：正在发起（auditBusy）与 Host 已确认在跑（activeKey）。
  // `busy` 是报告列表的加载/翻页状态，把它算进来会对着一个"正在刷新列表"的用户说
  // "有审核任务正在进行"（口径错误，第 6 轮审查点掉的就是这个）。
  const gatingHasAudit = auditBusy !== '' || activeKey !== ''
  const updateView = updateViewModelOf({
    snapshot: updateSnapshot,
    currentVersion: currentVersionOf(build),
    auditBusy: gatingHasAudit,
    nowMs: (props.now ?? Date.now)(),
    buildKind: build.buildKind,
    platform: props.platform ?? 'other',
  })
  const gating = gatingOf(env, activeKey, {
    busy,
    ...(auditBusy === '' ? {} : { auditBusy }),
    stopBusy,
    retryBusy,
    // 停止没确认静默之前不许再起一条（F1/F2）：与 Host 的 `canStartNext` 取交，
    // 这样行上的「AI 审核 / 重新审核」会一起变灰，而不是只靠文案提醒。
    ...(canStartNext ? {} : { canStart: false, gateReason: zhCN.stopNoRestartHint }),
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

  /**
   * 只读体检：**不是随时可跑的健康检查**，而是"刚才那次为什么失败"的事后归因。
   *
   * 设计 §D2 规定它只在"刚刚发生过一次 DWS 失败、且结构化事实排除沙箱"之后运行；
   * Host 在没有任何可归因失败时直接拒绝（`not-applicable`），界面如实显示那句话。
   * 这里不自己判断"该不该给按钮" —— 那是 Host 的判据，客户端再判一次就会有两套口径。
   */
  const checkDwsLocal = (): void => {
    setDwsLocalBusy(true)
    setDwsLocalError('')
    void workbenchApi.dwsLocalDoctor()
      .then((view) => { setDwsLocal(view); if (!view.ok) setDwsLocalError(view.error) })
      .catch((error: unknown) => { setDwsLocalError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDwsLocalBusy(false) })
  }
  /** 修复：只有走完二次确认才会到这里。 */
  const repairDwsLocal = (): void => {
    setDwsLocalConfirming(false)
    setDwsLocalBusy(true)
    setDwsLocalError('')
    void workbenchApi.dwsLocalPermissionRepair({ confirm: true })
      .then((result) => {
        setDwsLocalRepair(result)
        setDwsLocal(result.doctor)
        if (!result.ok) setDwsLocalError(result.error)
      })
      .catch((error: unknown) => { setDwsLocalError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDwsLocalBusy(false) })
  }

  // 环境信息页的公共 props：env===null（正在自检/失败）与已有结论时只差 env 本身。
  const envPane = <EnvironmentPane
    env={env}
    build={build}
    error={snapshot.error !== '' ? snapshot.error : bootError}
    busy={snapshot.busy}
    checkedAt={snapshot.checkedAt}
    onRefresh={recheck}
    onRelogin={() => { void runLogin('氚云登录', workbenchApi.relogin) }}
    onDwsLogin={() => { void runLogin('钉钉登录', () => workbenchApi.dwsLogin({})) }}
    onDwsLoginDevice={() => { void runLogin('钉钉设备码登录', () => workbenchApi.dwsLogin({ device: true })) }}
    loginMessage={loginMessage}
    // 拦截说明**直接读统一导航层记下来的结论**（`gate` + `pendingTarget` + `gateReason`）：
    // 侧栏点子项被拦回来的那一刻就要说清"本来要去哪、为什么没进去"，
    // 不能等用户自己再点一次「重新检查」才出现。
    //
    // `gate` 的优先级：界面自己刚点的动作（`running` / `blocked`）> 统一导航层的 `blocked`。
    // 顺序不能反：用户刚点「重新检查」时要先看到 loading，而不是上一轮的拦截说明。
    {...(gate !== 'idle' ? { gate } : (mod.blocked ? { gate: 'blocked' as const } : {}))}
    {...(mod.pendingTarget === null ? {} : { gateTarget: moduleLabel(mod.pendingTarget) })}
    {...(mod.gateReason === '' ? {} : { gateReason: mod.gateReason })}
    services={props.services}
    wsBusy={wsBusy}
    wsMessage={wsMessage}
    onWsBusy={setWsBusy}
    onWsMessage={setWsMessage}
    // 授权（一次性、长期有效）**整合进配置流程**：不再用一个模态层遮住整页环境信息。
    authorized={authorized}
    authBusy={authBusy}
    authError={authError}
    authDeclined={authDeclined}
    onGrantCredentials={grantCredentials}
    onRevokeCredentials={revokeCredentials}
    onDeclineCredentials={() => { setAuthError(''); setAuthDeclined(true) }}
    authSchemaMismatch={permissionStale}
    onRegrant={() => { setAuthError(''); setAuthDeclined(false) }}
    dwsLocal={dwsLocal}
    dwsLocalRepair={dwsLocalRepair}
    dwsLocalBusy={dwsLocalBusy}
    dwsLocalError={dwsLocalError}
    dwsLocalConfirming={dwsLocalConfirming}
    onDwsLocalCheck={checkDwsLocal}
    onDwsLocalAskRepair={() => { setDwsLocalConfirming(true) }}
    onDwsLocalCancelRepair={() => { setDwsLocalConfirming(false) }}
    onDwsLocalConfirmRepair={repairDwsLocal}
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
      <Button label={zhCN.moduleEnv} onClick={() => { go('env') }} />
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
    {/* 自助更新面板：与侧栏那枚徽标共用同一个开关状态与同一份更新状态。
        `position: fixed` 让它盖在面板之上，但仍长在面板壳内（--crwu-* token 照常继承）。 */}
    {updateDialogState.open && props.update !== undefined
      ? <UpdateDialog
          snapshot={updateSnapshot}
          currentVersion={currentVersionOf(build)}
          buildKind={build.buildKind}
          auditBusy={gatingHasAudit}
          nowMs={(props.now ?? Date.now)()}
          platform={props.platform ?? 'other'}
          onClose={() => { props.updateDialog?.close() }}
          onCheck={() => { void props.update?.check() }}
          onInstall={() => { void props.update?.install() }}
          onCancel={() => { void props.update?.cancel() }}
        />
      : null}
    <div className={C.header}>
      {/* 品牌标记：与侧栏入口同一个图形（用户给的原图描成的矢量版）。 */}
      <BrandMark size={22} />
      <span className={C.title}>{zhCN.title}</span>
      {/* 同一枚小标签：dev（本地源码检出）或 v<版本>（装好的包）。
          客户端刷新就换新、宿主只有重启才换，所以这枚标签是「我到底在跑哪一版」的唯一凭据
          （悬停看形态说明与构建时间）。 */}
      {props.update === undefined
        ? <span className={[C.version, BUILD_TAG_CLASSES[tag.tone]].join(' ')} title={tag.title}>{tag.text}</span>
        : <button
            type="button"
            className={[C.version, C.updateBadge, UPDATE_TONE_CLASSES[updateView.badgeTone]].filter((item) => item !== '').join(' ')}
            title={updateView.badgeTitle}
            aria-label={updateView.badgeTitle}
            onClick={() => { props.updateDialog?.open() }}
          >{updateView.badgeText}</button>}
      <span className={C.grow} />
      {/* 头部右侧只放一句问候：`下午好，杨凡宾`。姓名来自宿主的钉钉 CLI（`whoami`），
          **拿不到就整句不渲染**（用户 2026-09-22 口径：钉钉 CLI 没有登录信息就什么也不展示）。
          这里原先写的是当前模块名，用户要求去掉 —— 模块在哪一页由侧栏那张分组卡的高亮说了算。 */}
      {greeting === '' ? null : <span className={C.greeting}>{greeting}</span>}
    </div>

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
        ? <ReportEvalPane onGoAudit={() => { go('audit') }} />
        : null}

      {!awaitingEnv && (module === 'env' || env === null) ? envPane : null}

      {module === 'audit' && env !== null
        ? (envOk
            ? <ReportPane
                state={reportState}
                gating={gating}
                workspace={{ id: env?.workspace.id ?? '', path: env?.workspace.path ?? '' }}
                // 讨论面板只拿**真实存在的四个动词**（create/using/binding/list），
                // 适配器保证经接收者调用；「跳会话」不在 port 里（见下面的 onOpenDiscussion）。
                port={discussionPortOf(props.services)}
                onOpenDiscussion={(sessionId) => {
                  // 「跳到这条讨论会话」= DSH 原生入口 `uiWorkspace.openSession(id)`：
                  // 内部 replaceMain(…, 'reveal') 会设置主会话并切回原生对话
                  //（工具调用、审批、完整渲染都在那边）。左侧会话列表被点也是走它。
                  props.services.uiWorkspace?.openSession?.(sessionId)
                  // 保底：`uiWorkspace` 缺席（旧宿主）时至少把插件面板让开，
                  // 用户还能在左侧列表里点那条会话。`openSession` 自己也会调这一句，幂等。
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
                  // 点下去**立刻**进入"正在停止"（100ms 内可见），不等轮询。
                  setStopRequestedAt(Date.now())
                  void workbenchApi.auditStop(childId === '' ? {} : { childId })
                    .then((result) => {
                      // 两阶段：`ok` 在这里表示"请求已被接受"；**是否真的停下**由 Host 的阶段回答，
                      // 所以这里不报"已停止"，只把失败原因说出来。
                      setNotice(result.ok ? '' : result.error)
                      return refreshAudits()
                    })
                    .catch((cause: unknown) => {
                      setStopRequestedAt(0)
                      setNotice(describe(cause))
                    })
                    .finally(() => { setStopBusy(false) })
                }}
                stopRequestedAt={stopRequestedAt}
                onRefreshStatus={() => { void refreshAudits() }}
                onCopyDiagnostics={(key) => { copyStopDiagnostics(key) }}
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
                  void workbenchApi.openPath({ path: joinLocalPath(record.casePath, record.htmlFile) })
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
                // 「AI 审核结果分析会话」要的是**数据**（不是抽屉界面）：同一个 `oss-result`
                // 操作，把裁剪过的审核摘要直接交回去；失败如实返回原因，由页内降级处理。
                onLoadAuditInfo={async (key, cloud) => {
                  if (cloud.jsonKey === '') return { info: null, error: '' }
                  try {
                    const result = await workbenchApi.ossResult({ key: cloud.jsonKey })
                    return { info: result.ok ? result.info : null, error: result.ok ? '' : result.error }
                  } catch (cause: unknown) {
                    return { info: null, error: describe(cause) }
                  }
                }}
                handoffCopied={handoffCopied}
                onHandoffCopied={setHandoffCopied}
                onEscalateRetry={() => {
                  setEscalateAvailable(false)
                  setBusy(true)
                  // 协议 18：不再提交 `escalate` —— 提权由操作身份决定，不是调用方的参数。
                  // 这个按钮现在做的是"允许本机访问之后再取一次"，失败时 Host 的原文会说清去干什么。
                  void workbenchApi.pending({
                    ...(query === '' ? {} : { query }),
                    page: reportState.page,
                    size: reportState.pageSize,
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
      title={zhCN.auditInfo}
      subtitle={drawer.key}
      closing={drawerClosing}
      onClose={closeDrawer}
    >
      <AuditInfoDrawer
        seqNo={drawer.key}
        info={drawer.info}
        error={drawer.error}
        // 「查看更多审核依据」回到完整审核报告（交付件 HTML）——抽屉里不放规则证据链。
        // 这一行**没有**交付件时不给入口（给了就是假功能）。
        onOpenReport={reportOpenerOf(drawer.key)}
      />
    </SideDrawer>}
  </div>
}
