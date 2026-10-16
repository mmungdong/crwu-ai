import { text } from '../../../shared/utils/value.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { pickDirectory, pickFile, type DirectoryPicker, type FilePicker } from '../local-audit/pick.ts'
import {
  authChecking,
  authFailed,
  authReady,
  authTimedOut,
  backToEdit,
  beginPrepare,
  beginCreate,
  beginScan,
  chosenMethod,
  excludeFile,
  fileRowsOf,
  handoffDone,
  handoffFailed,
  initialValuationState,
  isCurrentPrepare,
  loginCancelled,
  loginStarted,
  markHostStale,
  markSlowWait,
  prepareFailed,
  prepareReady,
  pruneTransientState,
  reincludeFile,
  removeSelection,
  resetAfterHandoff,
  scanFailed,
  scanReady,
  scanSkippedOf,
  selectedFilesOf,
  sessionOpenFailed,
  setAssetType,
  setBaseDate,
  setMethod,
  setPurpose,
  setSelection,
  setSupplementalPrompt,
  setValueType,
  undoRemoval,
  verificationOpened,
  type MutationResult,
  type ValuationFileRowView,
  type ValuationMethodChoice,
  type ValuationPageState,
  type ValuationSelectedFileView,
} from './model/valuation-state.ts'
import type {
  CreationDisposition,
  LoginJobView,
  SiteChallengeView,
  SiteRowView,
  SiteStatusView,
  AuthGateView,
  ValuationHandoffView,
  ValuationLoginView,
  ValuationMethod,
  ValuationPreviewView,
} from '../../../shared/contracts/report-evaluation.ts'

/**
 * 房地产启动页的**控制器**（协议 35 · 计划 Task 4）。
 *
 * 与本地审核的控制器同一个形状：纯状态机 + 可注入的 RPC 端口，没有 React、没有 DOM。
 * 好处是这一页最要紧的几条行为可以直接断言：
 *
 * 1. **门禁只拦正文**：未登录时页面停在 `auth-blocked`，但**一次请求都不往会话层发**；
 * 2. **确认之后输入不可变**：`confirmation` / `creating-session` 改输入一律被拒；
 * 3. **一次只建一个父会话**：双击被阶段判据吃掉，超时重试复用同一个 `requestId`；
 * 4. **交接成功后不再有任何请求**：这一层没有 status / result / 运行期 cancel 这些动作，
 *    所以"面板不再轮询"不是纪律，是写不出来；
 * 5. **迟到的响应不许覆盖新页面**：`generation` + `AbortSignal`（`invalidate`）。
 *
 * ## 这里**不做**的三件事
 *
 * 不提取正文、不拉知识库、不抓案例：那些全在父会话里（父会话由 Host 交接时创建）。
 * 页面只负责"资料归档预览 + 用户确认 + 跳转"。
 */

/** `valuation-files-scan` / `valuation-intake` 应答里每条资料的形状（缺字段时给安全默认）。 */
export interface ValuationPort extends DirectoryPicker, FilePicker {
  scan?: (input: { paths: string[]; excluded?: string[] }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  /**
   * 归档预览（「确认」那一步）。
   *
   * `baseDate` / `purpose` / `valueType` 必须**逐字**传下去（未填就是空串）：Host 按它们冻结输入
   * 并归一化成 `null`（未指定）。`excluded` 是员工逐个移除掉的文件：
   * Host 在扫描 / 预览 / 归档三处共用同一份范围。
   */
  intake: (input: {
    requestId: string
    paths: string[]
    excluded?: string[]
    /** 用户选定的资产类型（稳定业务标识；未选时 Host 直接拒绝预览）。 */
    assetType: string
    method: ValuationMethod
    baseDate: string
    /** 评估目的（空串 = 未指定）。 */
    purpose?: string
    /** 价值类型（空串 = 未指定）。 */
    valueType?: string
    supplementalPrompt?: string
  }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  /** 门禁预检（三态 + 登录任务）。 */
  preflight?: (input?: { openLogin?: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  /** 点登录**立刻**拉起可见浏览器。 */
  login?: (input: { siteId: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  /** 取消本页发起的那一条登录任务。 */
  loginCancel?: (input: { jobId: string }) => Promise<Record<string, unknown>>
  /**
   * 打开**受控的验证窗口**（协议 37）。
   *
   * 只提交 `siteId`：站点与 URL 由 Host 从可信清单取，客户端提交不了任意地址。
   * `opened` 只说明窗口开了，**不说明验证已经通过**。
   */
  verificationWindow?: (input: { siteId: string }, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>
  /** 交接父会话。 */
  start: (input: { previewId: string; confirmedInputDigest: string; requestId: string }) => Promise<Record<string, unknown>>
  /** 打开**顶层父会话**（不是 `openSubagent`）。 */
  openSession: (sessionId: string) => Promise<{ ok: boolean; error: string }>
  /** 环境 / 授权门禁的结论（未就绪时不起估值）。 */
  ready?: () => { ok: boolean; error: string }
  clock?: () => number
  /** 超时句柄（测试注入假实现；缺省 `setTimeout`）。 */
  scheduleTimeout?: (handler: () => void, ms: number) => unknown
  clearScheduledTimeout?: (handle: unknown) => void
  /** 准备确认的等待上限；缺省 120s。 */
  intakeTimeoutMs?: number
  /** 交接的等待上限；缺省 180s（超时后可以按同一个 requestId 重试）。 */
  handoffTimeoutMs?: number
  /** 门禁检查的页面等待上限；缺省 60s（到期回可重试的 blocked，不假称 Host 已取消）。 */
  authTimeoutMs?: number
  /** 长等待提示的出现时刻；缺省 15s。 */
  slowWaitMs?: number
}

export interface ReportEvaluationController {
  getState: () => ValuationPageState
  subscribe: (listener: (state: ValuationPageState) => void) => () => void

  /** 门禁：加载时 / 「重新检查」时各查一次（`force` = 用户主动点）。 */
  checkAuth: () => void
  recheckAuth: () => void
  login: (siteId: string) => void
  cancelLogin: (jobId: string) => void
  /** 打开受控验证窗口（只提交 siteId）。 */
  openVerification: (siteId: string) => void

  pickFiles: () => void
  pickFolder: () => void
  /** 移除一个**选择入口**（文件或文件夹）。 */
  removeSelection: (path: string) => void
  /** 逐个移除一份具体文件（写进排除范围，重新扫描后仍然生效）。 */
  excludeFile: (path: string) => void
  /** 重新纳入一份之前被移除的文件。 */
  reincludeFile: (path: string) => void
  /** 撤销最近一次移除（8 秒内的那一次）。 */
  undoRemoval: () => void
  rescan: () => void
  /** 选资产类型（空串 = 还没选；状态机只接受已登记的取值）。 */
  setAssetType: (assetType: string) => void
  /** 选评估方法（空串 = 还没选；状态机拒绝未知枚举）。 */
  setMethod: (method: ValuationMethodChoice) => void
  /** 改评估目的（空串 = 未指定）。 */
  setPurpose: (value: string) => void
  /** 改价值类型（空串 = 未指定）。 */
  setValueType: (value: string) => void
  setBaseDate: (value: string) => void
  setPrompt: (value: string) => void

  /** 「确认」：递归校验 + 字节归档 + 元信息回显（pending 文案「正在准备确认信息…」）。 */
  preparePreview: () => void
  /** 「返回修改」：丢掉这一次预览，保留输入。只有 Host 说"没创建"时才允许离开失败态。 */
  backToEdit: () => void
  /** 「开始估值」：交接父会话并**立刻**打开它；重试复用同一个 requestId。 */
  confirm: () => void
  /** 「打开估值会话」：只重新导航（会话已经建好，不再创建）。 */
  openCreatedSession: () => void

  /**
   * 作废在途的页面请求（切目录 / 换输入）。
   *
   * 除了中止请求，它还**清理这一次页面请求的瞬时状态**：检查中 → 回到可重查，
   * 准备中 → 回到可编辑草稿。否则切走再回来会永久卡在 checking / pending（UX-05）。
   * 交接（`creating-session`）不清理：会话是 Host 的事务，切走不能中断它。
   */
  invalidate: () => void
  /** 协议代数不匹配时由外层调用。 */
  markStale: () => void
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 准备确认的等待上限：本机复制几十兆 PDF 加磁盘抖动，两分钟还没回话就属于卡住了。 */
const DEFAULT_INTAKE_TIMEOUT_MS = 120_000
/** 交接的等待上限：它要建目录、建会话、发指令；三分钟不回话就给可重试的失败。 */
const DEFAULT_HANDOFF_TIMEOUT_MS = 180_000
/** 页面上的门禁检查等待上限（设计稿 §7.2 建议 60 秒）。 */
const DEFAULT_AUTH_TIMEOUT_MS = 60_000
/** 长等待提示的出现时刻（≥15 秒给"用时较长 + 现在能做什么"）。 */
const DEFAULT_SLOW_WAIT_MS = 15_000

/** 挑战处置的逐字段收窄（缺字段时按"没检测到"处理，不猜）。 */
function challengeOf(value: unknown): SiteChallengeView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  return {
    detected: raw.detected === true,
    attempted: raw.attempted === true,
    state: text(raw.state),
    reasonCode: text(raw.reasonCode),
    verifyUrl: text(raw.verifyUrl),
  }
}

function rowsOf(value: unknown): SiteRowView[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const challenge = challengeOf(raw.challenge)
    return [{
      siteId: text(raw.siteId),
      label: text(raw.label),
      state: (text(raw.state) || 'unknown') as SiteStatusView['state'],
      reason: text(raw.reason),
      verdict: text(raw.verdict),
      protectedUrl: text(raw.protectedUrl),
      expiresAt: text(raw.expiresAt),
      sessionCookie: raw.sessionCookie === true,
      required: raw.required === true,
      stateLabel: text(raw.stateLabel),
      ...(challenge === undefined ? {} : { challenge }),
    }]
  }) : []
}

function sitesOf(value: unknown): SiteStatusView[] {
  return Array.isArray(value) ? value.flatMap((item) => (item !== null && typeof item === 'object'
    ? [{
      siteId: text((item as Record<string, unknown>).siteId),
      label: text((item as Record<string, unknown>).label),
      state: (text((item as Record<string, unknown>).state) || 'unknown') as SiteStatusView['state'],
      reason: text((item as Record<string, unknown>).reason),
      verdict: text((item as Record<string, unknown>).verdict),
      protectedUrl: text((item as Record<string, unknown>).protectedUrl),
      expiresAt: text((item as Record<string, unknown>).expiresAt),
      sessionCookie: (item as Record<string, unknown>).sessionCookie === true,
    }]
    : [])) : []
}

/**
 * 登录任务的逐字段收窄。
 *
 * ⚠️ 未知状态**不许**伪装成 `running`（UX-03）：`waiting-user`（凭据到位、等待页面验证）
 * 曾经被归一成"还在登录"，于是"请去完成验证"这条路径永远到不了。这里只认五个合法值，
 * 其余落到 `failed` —— 那是唯一不会骗人的兜底（`running` 会让界面一直等下去）。
 */
function jobsOf(value: unknown): LoginJobView[] {
  const known: readonly string[] = ['running', 'succeeded', 'failed', 'cancelled', 'waiting-user']
  return Array.isArray(value) ? value.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const state = text(raw.state)
    return [{
      jobId: text(raw.jobId),
      siteId: text(raw.siteId),
      state: (known.includes(state) ? state : 'failed') as LoginJobView['state'],
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
      detail: text(raw.detail),
      sites: sitesOf(raw.sites),
      commandOk: raw.commandOk === true,
      recoveryAttempts: typeof raw.recoveryAttempts === 'number' ? raw.recoveryAttempts : 0,
    }]
  }) : []
}

function gateOf(value: unknown, fallbackReason: string): AuthGateView {
  if (value === null || typeof value !== 'object') {
    return {
      released: false, required: [], optional: [], reason: fallbackReason, unavailable: true, checkedAt: '',
    }
  }
  const raw = value as Record<string, unknown>
  return {
    released: raw.released === true,
    required: Array.isArray(raw.required) ? raw.required.map((item) => text(item)) : [],
    optional: Array.isArray(raw.optional) ? raw.optional.map((item) => text(item)) : [],
    reason: text(raw.reason) || fallbackReason,
    unavailable: raw.unavailable === true,
    // 检查时刻：缺字段 / 空串 = **没有时刻**（界面显示"尚未检查"），不许补一个当前时间。
    checkedAt: text(raw.checkedAt),
  }
}

/** 门禁预检应答的收窄（缺字段时给"查不出来"，**不**当成已登录）。 */
export function preflightViewOf(payload: Record<string, unknown>): {
  ok: boolean
  error: string
  sites: SiteStatusView[]
  rows: SiteRowView[]
  gate: AuthGateView
  loginJobs: LoginJobView[]
} {
  const error = text(payload?.error)
  return {
    ok: payload?.ok !== false,
    error,
    sites: sitesOf(payload?.sites),
    rows: rowsOf(payload?.rows),
    gate: gateOf(payload?.gate, error || zhCN.valuationProviderCheckFailed),
    loginJobs: jobsOf(payload?.loginJobs),
  }
}

/** 登录应答的收窄。 */
export function loginViewOf(payload: Record<string, unknown>): ValuationLoginView {
  const jobs = jobsOf([payload?.job])
  return {
    ok: payload?.ok === true,
    error: text(payload?.error),
    jobId: text(payload?.jobId),
    reused: payload?.reused === true,
    job: jobs.length > 0 ? jobs[0] : null,
  }
}

/** 归档预览应答的收窄（这一层只做形状收窄，不解释业务含义）。 */
export function previewViewOf(payload: Record<string, unknown>): ValuationPreviewView {
  const files = Array.isArray(payload?.files)
    ? payload.files.flatMap((item) => (item !== null && typeof item === 'object'
      ? [{
        fileId: text((item as Record<string, unknown>).fileId),
        fileName: text((item as Record<string, unknown>).fileName),
        absolutePath: text((item as Record<string, unknown>).absolutePath),
        archiveRelativePath: text((item as Record<string, unknown>).archiveRelativePath),
        kind: text((item as Record<string, unknown>).kind),
        sizeBytes: typeof (item as Record<string, unknown>).sizeBytes === 'number'
          ? (item as Record<string, unknown>).sizeBytes as number : 0,
        sha256: text((item as Record<string, unknown>).sha256),
        // `createdAt` **只认字符串**：拿不到就是 null（界面显示"创建时间未知"）。
        createdAt: typeof (item as Record<string, unknown>).createdAt === 'string'
          ? (item as Record<string, unknown>).createdAt as string : null,
        modifiedAt: typeof (item as Record<string, unknown>).modifiedAt === 'string'
          ? (item as Record<string, unknown>).modifiedAt as string : null,
        readable: (item as Record<string, unknown>).readable !== false,
        duplicateOf: typeof (item as Record<string, unknown>).duplicateOf === 'string'
          ? (item as Record<string, unknown>).duplicateOf as string : null,
      }]
      : []))
    : []
  return {
    ok: payload?.ok === true,
    errorKind: text(payload?.errorKind),
    error: text(payload?.error),
    requestId: text(payload?.requestId),
    previewId: text(payload?.previewId),
    projectId: text(payload?.projectId),
    casePath: text(payload?.casePath),
    inputDigest: text(payload?.inputDigest),
    // 资产类型：Host 是唯一权威。旧宿主不回这个字段 → 空串（界面按"未选择/未知"处理，
    // 不替它默认成房地产）。
    assetType: text(payload?.assetType),
    methodRequest: text(payload?.methodRequest),
    // 基准日：Host 未指定时给 `null`；缺字段也按"未指定"处理，**不猜**。
    baseDate: typeof payload?.baseDate === 'string' && (payload.baseDate as string) !== ''
      ? payload.baseDate as string : null,
    // 评估目的 / 价值类型同理：`null`、空串、缺字段都是"未指定"，**不许**填一个默认结论。
    purpose: typeof payload?.purpose === 'string' && (payload.purpose as string).trim() !== ''
      ? payload.purpose as string : null,
    valueType: typeof payload?.valueType === 'string' && (payload.valueType as string).trim() !== ''
      ? payload.valueType as string : null,
    supplementalPrompt: text(payload?.supplementalPrompt),
    files,
    fileCount: typeof payload?.fileCount === 'number' ? payload.fileCount as number : files.length,
    overLimit: payload?.overLimit === true,
    skipped: Array.isArray(payload?.skipped) ? payload.skipped.map((item) => text(item)) : [],
    capabilityGaps: Array.isArray(payload?.capabilityGaps)
      ? payload.capabilityGaps.map((item) => text(item)) : [],
    createdAt: text(payload?.createdAt),
    expiresAt: text(payload?.expiresAt),
  }
}

/** 交接应答的收窄。 */
export function handoffViewOf(payload: Record<string, unknown>): ValuationHandoffView {
  const raw = text(payload?.creationDisposition)
  const parentSessionId = text(payload?.parentSessionId)
  /**
   * 缺字段 / 不认识时的兜底，**方向必须安全**：
   *
   * - 回执里带着 `parentSessionId` → 事实就是"会话已经建出来了"（设计稿 §11.1 的第二类：
   *   重试交接、打开会话），所以归 `created`；
   * - 什么都没带（超时 / 网络异常 / 旧宿主只回一句话）→ `unknown`。
   *
   * ⚠️ 唯一**绝对**不许自己推的方向是 `not-created`：那会让界面放行「返回修改」，
   * 于是同一批资料被交接成第二个项目目录。Host 明确给的值永远优先。
   */
  const creationDisposition: CreationDisposition = raw === 'not-created' || raw === 'created' || raw === 'unknown'
    ? raw
    : (parentSessionId !== '' ? 'created' : 'unknown')
  return {
    ok: payload?.ok === true,
    errorKind: text(payload?.errorKind),
    error: text(payload?.error),
    projectId: text(payload?.projectId),
    parentSessionId,
    dispatchAccepted: payload?.dispatchAccepted === true,
    reused: payload?.reused === true,
    creationDisposition,
  }
}

/** 验证窗口应答的收窄（`opened` 只说明窗口开了）。 */
export function verificationViewOf(payload: Record<string, unknown>): {
  ok: boolean
  error: string
  opened: boolean
  siteId: string
} {
  return {
    ok: payload?.ok === true,
    error: text(payload?.error),
    opened: payload?.opened === true,
    siteId: text(payload?.siteId),
  }
}

export function createReportEvaluationController(
  port: ValuationPort,
  options: { initial?: Partial<ValuationPageState> } = {},
): ReportEvaluationController {
  let state = initialValuationState(options.initial)
  const scheduleTimeout = port.scheduleTimeout ?? ((handler, ms) => setTimeout(handler, ms))
  const clearScheduledTimeout = port.clearScheduledTimeout
    ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const intakeTimeoutMs = port.intakeTimeoutMs ?? DEFAULT_INTAKE_TIMEOUT_MS
  const handoffTimeoutMs = port.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS
  const authTimeoutMs = port.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const slowWaitMs = port.slowWaitMs ?? DEFAULT_SLOW_WAIT_MS

  /** 订阅者集合（面板与页面各一个）。 */
  const listeners = new Set<(next: ValuationPageState) => void>()
  /** 页面请求发号器：单调递增、不回收（回收会让两轮的号撞上）。 */
  let generation = 0
  /** 准备确认的请求号：同样单调递增（迟到的响应靠它 + generation 双重作废）。 */
  let prepareSeq = 0
  /** 交接的请求号：**只在第一次点「开始估值」时铸一次**，重试复用。 */
  let handoffSeq = 0
  /** 在途的**页面**请求（扫描 / 预检 / 准备确认）。交接**不**走它 —— 会话必须建出来。 */
  let pageAbort: AbortController | null = null
  /**
   * 页面请求的定时器集合（长等待提示 + 阶段超时）。
   *
   * 分成一组而不是一个句柄：准备/创建都同时需要"15 秒提示"和"到点超时"，
   * 共用一个句柄时后设的会把先设的顶掉。
   */
  const timers = new Set<unknown>()

  const write = (next: ValuationPageState): void => {
    state = next
    // 复制一份再遍历：回调里可能会退订（React 卸载时就会）。
    for (const notify of [...listeners]) notify(next)
  }
  const apply = (result: MutationResult): ValuationPageState => {
    // 被拒时只把原因写进 `error`，**不动别的字段**。
    write(result.ok ? result.state : { ...state, error: result.error })
    return state
  }
  /**
   * 写一次状态变更，并把**变更结果本身**交给调用方。
   *
   * 与 `apply` 的差别只在返回值：需要"这次到底成不成"的动作（范围变更之后要不要重扫）
   * 必须看 `ok`，不能看引用是否变化 —— 被拒时 `apply` 也会写一个新对象。
   */
  const mutate = (result: MutationResult): MutationResult => {
    write(result.ok ? result.state : { ...state, error: result.error })
    return result
  }
  const clearTimer = (): void => {
    for (const handle of timers) clearScheduledTimeout(handle)
    timers.clear()
  }
  /** 安排一次页面请求内的定时器（登记在案，`clearTimer` 会一起收掉）。 */
  const after = (ms: number, handler: () => void): void => {
    const handle = scheduleTimeout(() => {
      timers.delete(handle)
      handler()
    }, ms)
    timers.add(handle)
  }
  /** 作废在途的页面请求（发号 + 中止）。 */
  const abortPage = (): void => {
    generation += 1
    if (pageAbort !== null) {
      try { pageAbort.abort() } catch (error) { void error }
      pageAbort = null
    }
  }
  const beginPage = (): { generation: number; signal: AbortSignal } => {
    abortPage()
    const controller = new AbortController()
    pageAbort = controller
    return { generation, signal: controller.signal }
  }
  /** 门禁是否就绪（不确定就**不放行**）。 */
  const gate = (): { ok: boolean; error: string } => port.ready?.() ?? { ok: true, error: '' }

  // ── 门禁 ──────────────────────────────────────────────────────────────────

  const runPreflight = (force: boolean): void => {
    if (port.preflight === undefined) {
      apply(authFailed(state, zhCN.valuationProviderCheckUnsupported))
      return
    }
    // 同一个检查请求在途时按钮 disabled（不重复发）。
    if (state.login.check === 'checking') return
    // 已经有结论就不再自动打扰：切目录来回不该变成反复的网络请求。
    // 用户要重查有一条显式入口（「重新检查」），它带 `force`。
    if (!force && state.login.check === 'ready') return
    const round = beginPage()
    apply(authChecking(state))
    clearTimer()
    // ≥15 秒给一句"检查用时较长"，但**不假报失败**（检查仍在进行）。
    after(slowWaitMs, () => { apply(markSlowWait(state, 'auth')) })
    // 页面等待上限：到期回到可重试的 blocked。这只描述"页面不再等"，不宣称 Host 已取消。
    after(authTimeoutMs, () => {
      if (round.generation !== generation) return
      abortPage()
      apply(authTimedOut(state))
    })
    void Promise.resolve(port.preflight({}, { signal: round.signal })).then((payload) => {
      if (round.generation !== generation) return
      clearTimer()
      const view = preflightViewOf(payload ?? {})
      if (!view.ok && view.error !== '') {
        apply(authFailed(state, view.error))
        return
      }
      apply(authReady(state, view))
    }).catch((cause: unknown) => {
      if (round.generation !== generation) return
      clearTimer()
      apply(authFailed(state, `${zhCN.valuationProviderCheckFailed}：${describe(cause)}`))
    })
  }

  // ── 扫描 ──────────────────────────────────────────────────────────────────

  const runScan = (paths: readonly string[], excluded: readonly string[] = state.excluded): void => {
    if (paths.length === 0) {
      write({
        ...state,
        files: [],
        fileRows: [],
        scanSkipped: [],
        scanState: 'idle',
        scanError: '',
        fileCount: 0,
        overLimit: false,
        readableCount: 0,
        truncated: false,
      })
      return
    }
    if (port.scan === undefined) {
      // 旧宿主 / 单测替身：**不假装扫过** —— 只知道路径的那一份事实（份数按选择条目算）。
      const files = selectedFilesOf([], paths)
      apply(scanReady(state, files, fileRowsOf(paths.map((path) => ({ path }))), {
        fileCount: files.length,
        overLimit: false,
        readableCount: files.length,
        limit: state.limit,
      }))
      return
    }
    const asked = [...paths]
    const askedExcluded = [...excluded]
    const round = beginPage()
    // 旧行**保留**显示（标记为"正在重新读取"），主按钮临时禁用；新结果一次落地（§8.6）。
    apply(beginScan(state))
    void Promise.resolve(port.scan({ paths: asked, excluded: askedExcluded }, { signal: round.signal }))
      .then((payload) => {
        if (round.generation !== generation) return
        const items = Array.isArray(payload?.items) ? payload.items as unknown[] : []
        const files = selectedFilesOf(items, asked)
        if (payload?.ok === false) {
          apply(scanFailed(state, text(payload.error) || zhCN.valuationScanFailed))
          return
        }
        const rows: ValuationFileRowView[] = fileRowsOf(
          Array.isArray(payload?.files) ? payload.files as unknown[] : [])
        const skipped = scanSkippedOf(Array.isArray(payload?.skipped) ? payload.skipped as unknown[] : [])
        // 旧宿主不回 `files[]` 时退化成"只知道入口"的行，并要求重新检查协议（协议 37 起才有一份）。
        apply(scanReady(state, files, rows.length > 0 ? rows : fileRowsOf(asked.map((path) => ({ path }))), {
          // 份数以**递归去重后的文件数**为准（用户选中的目录数不作数）。
          fileCount: typeof payload?.fileCount === 'number' ? payload.fileCount : files.length,
          overLimit: payload?.overLimit === true,
          readableCount: typeof payload?.readableCount === 'number' ? payload.readableCount : files.length,
          limit: typeof payload?.limit === 'number' ? payload.limit : state.limit,
          truncated: payload?.truncated === true,
        }, skipped))
      }).catch((cause: unknown) => {
        if (round.generation !== generation) return
        apply(scanFailed(state, `${zhCN.valuationScanFailed}：${describe(cause)}`))
      })
  }

  const pick = (run: (picker: ValuationPort) => Promise<{
    ok: boolean
    paths: string[]
    unsupported: boolean
    error: string
  }>, unsupportedText: string): void => {
    void run(port).then((picked) => {
      if (!picked.ok) {
        write({ ...state, error: picked.unsupported ? unsupportedText : (picked.error || zhCN.valuationNeedFiles) })
        return
      }
      if (picked.paths.length === 0) return
      // 同一个真实路径重复选择：交给 Host 的去重（它按 canonical 路径算），这里只提示一次。
      const before = state.selection.length
      const next = apply(setSelection(state, [...state.selection, ...picked.paths]))
      const added = next.selection.length - before
      if (added < picked.paths.length) {
        write({ ...next, notice: zhCN.valuationFilesDuplicateIgnored })
      }
      runScan(next.selection, next.excluded)
    }).catch((cause: unknown) => {
      write({ ...state, error: `${zhCN.valuationNeedFiles}（${describe(cause)}）` })
    })
  }

  // ── 交接 ──────────────────────────────────────────────────────────────────

  /**
   * 打开已经建好的父会话；失败只影响"自动打开"这一件事（会话本身还在）。
   *
   * **跳转成功之后不留成功页**：会话已经打开了，这一页直接回到新草稿（保留一条中性的
   * 最近会话入口）。停在"估值会话已创建，正在打开…"上是一张没有可做之事的死页 ——
   * 员工再进「估值」时只会被它挡在一张空白页前面。
   */
  const openCreatedSession = (): void => {
    // 草稿里的最近会话入口已经没有 `parentSessionId`（新一轮清过），所以回退到 `recentSessionId`。
    const sessionId = state.parentSessionId || state.recentSessionId
    if (sessionId === '') {
      write({ ...state, error: zhCN.openSessionNoChild })
      return
    }
    void Promise.resolve(port.openSession(sessionId)).then((result) => {
      if (result?.ok === true) {
        // 这一页的使命到此为止：会话已经打开，页面回到新草稿。
        apply(resetAfterHandoff(state))
        return
      }
      apply(sessionOpenFailed(state, text(result?.error) || zhCN.openSessionFailed))
    }).catch((cause: unknown) => {
      apply(sessionOpenFailed(state, describe(cause)))
    })
  }

  return {
    getState: () => state,
    subscribe: (next) => {
      // **不在这里同步回调**：`useSyncExternalStore` 订阅完自己会读一次快照。
      listeners.add(next)
      return () => { listeners.delete(next) }
    },

    checkAuth: () => {
      // 上一轮交接**成功跳转**之后再次进入这一页 = 新的草稿入口（不留上一轮的状态看板）。
      // ⚠️ 自动打开失败时**不重置**：会话已经建好了、员工根本没离开这一页，
      // 他此刻要的是「打开估值会话」这个动作，而不是被清成一份空草稿。
      if (state.phase === 'handed-off' && !state.openFailed) apply(resetAfterHandoff(state))
      runPreflight(false)
    },
    recheckAuth: () => {
      // 「重新检查」可能是在等一条登录任务：顺手把它的最新状态一起取回来。
      runPreflight(true)
    },
    login: (siteId) => {
      if (port.login === undefined) {
        write({ ...state, error: zhCN.valuationProviderCheckUnsupported })
        return
      }
      const id = text(siteId).trim()
      if (id === '') return
      void Promise.resolve(port.login({ siteId: id })).then((payload) => {
        apply(loginStarted(state, loginViewOf(payload ?? {})))
      }).catch((cause: unknown) => {
        write({ ...state, error: `${zhCN.valuationProviderCheckFailed}：${describe(cause)}` })
      })
    },
    cancelLogin: (jobId) => {
      const id = text(jobId).trim()
      if (id === '' || port.loginCancel === undefined) return
      void Promise.resolve(port.loginCancel({ jobId: id })).then((payload) => {
        if (payload?.ok === false) {
          write({ ...state, error: text(payload.error) || zhCN.valuationProviderCheckFailed })
          return
        }
        apply(loginCancelled(state))
      }).catch((cause: unknown) => {
        write({ ...state, error: describe(cause) })
      })
    },
    /**
     * 「打开验证窗口」：**只**提交 siteId，URL 与 profile 由 Host 定。
     *
     * 它不是"重新检查"的别名：检查回答"现在是什么状态"，这个动作回答"把我的验证窗口打开"。
     * 打开成功也不等于验证通过 —— 文案里必须说清这一点。
     */
    openVerification: (siteId) => {
      const id = text(siteId).trim()
      if (id === '') return
      if (port.verificationWindow === undefined) {
        // 旧宿主：如实说能力缺口，并保留「重新检查」这条可用路径。
        write({
          ...state,
          login: { ...state.login, error: zhCN.valuationProviderCheckUnsupported },
        })
        return
      }
      void Promise.resolve(port.verificationWindow({ siteId: id })).then((payload) => {
        apply(verificationOpened(state, verificationViewOf(payload ?? {})))
      }).catch((cause: unknown) => {
        void cause
        // 原始 message 可能带命令与路径：只回一句人话（设计稿 §13.2）。
        apply(verificationOpened(state, {
          ok: false, error: zhCN.valuationAuthVerifyFailed, opened: false, siteId: id,
        }))
      })
    },

    pickFiles: () => { pick((picker) => pickFile(picker), zhCN.valuationPickFilesUnsupported) },
    pickFolder: () => { pick((picker) => pickDirectory(picker), zhCN.valuationPickFolderUnsupported) },
    removeSelection: (path) => {
      // ⚠️ 范围动作要用**变更结果本身**判成败：`apply` 无论成功还是被拒都会换掉 `state`
      // 对象，拿"引用有没有变"当判据会让失败也走进重扫（或反过来把成功静默跳过）。
      const outcome = mutate(removeSelection(state, path))
      if (!outcome.ok) return
      runScan(outcome.state.selection, outcome.state.excluded)
    },
    excludeFile: (path) => {
      const outcome = mutate(excludeFile(state, path))
      if (!outcome.ok) return
      // 移除之后**必须重扫**：份数与"到底归档哪几份"都要按新的排除范围重算。
      runScan(outcome.state.selection, outcome.state.excluded)
    },
    reincludeFile: (path) => {
      const outcome = mutate(reincludeFile(state, path))
      if (!outcome.ok) return
      runScan(outcome.state.selection, outcome.state.excluded)
    },
    undoRemoval: () => {
      const outcome = mutate(undoRemoval(state))
      if (!outcome.ok) return
      runScan(outcome.state.selection, outcome.state.excluded)
    },
    rescan: () => { runScan(state.selection, state.excluded) },
    setAssetType: (assetType) => { apply(setAssetType(state, assetType)) },
    setMethod: (method) => { apply(setMethod(state, method)) },
    setBaseDate: (value) => { apply(setBaseDate(state, value)) },
    setPurpose: (value) => { apply(setPurpose(state, value)) },
    setValueType: (value) => { apply(setValueType(state, value)) },
    setPrompt: (value) => { apply(setSupplementalPrompt(state, value)) },

    /**
     * 「确认」：先做**递归校验**（份数 / 可读性 / 上限），再让 Host 按字节归档并回元信息。
     *
     * 顺序是刻意的：先发号 + 进入 `preparing-confirmation`（同一批 `write` 里发生，
     * 所以首帧就能看到「正在准备确认信息…」），最后才发 RPC。
     */
    preparePreview: () => {
      const ready = gate()
      if (!ready.ok) {
        write({ ...state, error: ready.error })
        return
      }
      prepareSeq += 1
      const requestId = prepareSeq
      const round = beginPage()
      const begun = apply(beginPrepare(state, requestId))
      if (begun.phase !== 'preparing-confirmation') return
      const asked = [...state.selection]
      const askedExcluded = [...state.excluded]
      const assetType = state.assetType
      // 提交给 Host 的必须是**收窄后的正式方法**：`beginPrepare` 已经保证了这一点，
      // 这里再收一次是为了让"提交空方法"在这条路径上根本写不出来。
      const method = chosenMethod(state.method)
      if (method === null) return
      const baseDate = state.baseDate
      const purpose = state.purpose
      const valueType = state.valueType
      const supplementalPrompt = state.supplementalPrompt

      clearTimer()
      // ≥15 秒：说明"仍在准备 + 可以返回修改，原输入会保留"。
      after(slowWaitMs, () => { apply(markSlowWait(state, 'prepare')) })
      after(intakeTimeoutMs, () => {
        apply(prepareFailed(state, requestId, zhCN.valuationIntakeTimeout))
      })

      void Promise.resolve(port.intake({
        requestId: `valuation-${String(requestId)}`,
        paths: asked,
        // 排除范围与选择范围一起提交：扫描 / 预览 / 归档共用同一份（不假排除）。
        excluded: askedExcluded,
        assetType,
        method,
        // 基准日**逐字**提交：未选择就是空串，客户端不许拿资料里识别到的日期补一个。
        baseDate,
        // 评估目的 / 价值类型同理：未填就是空串（Host 归一化成"未指定"），不预置任何正式结论。
        purpose,
        valueType,
        supplementalPrompt,
      }, { signal: round.signal })).then((payload) => {
        // 迟到的响应：用户已经返回修改 / 换了输入 —— 丢掉，不许改现在的状态。
        if (round.generation !== generation || !isCurrentPrepare(state, requestId)) return
        clearTimer()
        apply(prepareReady(state, requestId, previewViewOf(payload ?? {})))
      }).catch((cause: unknown) => {
        if (round.generation !== generation || !isCurrentPrepare(state, requestId)) return
        clearTimer()
        apply(prepareFailed(state, requestId, `${zhCN.valuationIntakeFailed}：${describe(cause)}`))
      })
    },

    backToEdit: () => {
      // 返回修改 = 作废这一次预览：在途请求的响应回来时必须被丢掉。
      clearTimer()
      abortPage()
      apply(backToEdit(state))
    },

    confirm: () => {
      // 双击去重：第二次点进来时阶段已经不是 `confirmation` 了。
      if (state.phase === 'creating-session') return
      const preview = state.preview
      if (preview === null) {
        write({ ...state, error: zhCN.valuationNotInConfirmation })
        return
      }
      // 交接**不**走页面发号器：会话必须建出来（用户切走也不能半途作废它）。
      clearTimer()
      abortPage()
      if (state.handoffRequestId === '') handoffSeq += 1
      const requestId = state.handoffRequestId !== ''
        ? state.handoffRequestId
        : `valuation-start-${String(handoffSeq)}`
      const begun = apply(beginCreate(state, requestId))
      if (begun.phase !== 'creating-session') return

      // ≥15 秒：不伪造目录/指令的细分步骤，只说"还在确认交接结果、别重复开始"。
      after(slowWaitMs, () => { apply(markSlowWait(state, 'create')) })
      after(handoffTimeoutMs, () => {
        // ⚠️ **超时不等于"没有创建"**：回执可能还在路上。判据缺省就是 `unknown`，
        // 界面因此只提供「恢复交接」，不会让员工回草稿再生一个项目。
        apply(handoffFailed(state, {}, zhCN.valuationHandoffTimeout))
      })

      void Promise.resolve(port.start({
        previewId: preview.previewId,
        confirmedInputDigest: preview.inputDigest,
        requestId,
      })).then((payload) => {
        clearTimer()
        const view = handoffViewOf(payload ?? {})
        if (!view.ok) {
          apply(handoffFailed(state, view, view.error || zhCN.valuationHandoffFailureGeneric))
          return
        }
        if (!view.dispatchAccepted) {
          // 会话已经建好、只是固定指令没发出去：**保留 sessionId**，重试发回同一个会话。
          apply(handoffFailed(state, view, view.error || zhCN.valuationHandoffCreatedTitle))
          return
        }
        apply(handoffDone(state, view))
        // 提示与跳转在**同一批**里发生：不给员工一个"盯着成功页"的等待。
        openCreatedSession()
      }).catch((cause: unknown) => {
        clearTimer()
        // 网络异常同样属于"结果未知"：异常 message 不进主文案（它可能带命令与路径）。
        void cause
        apply(handoffFailed(state, {}, zhCN.valuationHandoffUnknownNote))
      })
    },

    openCreatedSession,

    invalidate: () => {
      clearTimer()
      abortPage()
      // 清理这一次页面请求的瞬时状态：检查中 → 可重查；准备中 → 可编辑草稿。
      // 交接的 `creating-session` 不动（会话是 Host 的事务，切走不能中断它）。
      const pruned = pruneTransientState(state)
      if (pruned !== state) write(pruned)
    },
    markStale: () => { write(markHostStale(state)) },
  }
}

/** 供输入页把"回什么"判据收在一处（组件不自己判阶段）。 */
export type { ValuationSelectedFileView }
