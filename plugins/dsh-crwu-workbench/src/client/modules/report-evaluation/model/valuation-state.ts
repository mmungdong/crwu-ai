import { text } from '../../../../shared/utils/value.ts'
import { VALUATION_PROMPT_MAX_LENGTH } from '../../../../shared/consts.ts'
import {
  ASSET_TYPES,
  PURPOSE_MAX_LENGTH,
  VALUE_TYPE_MAX_LENGTH,
} from '../../../../shared/contracts/valuation-project.ts'
import { zhCN } from '../../../locales/zh-CN.ts'
import type {
  AuthGateView,
  CreationDisposition,
  LoginJobView,
  SiteRowView,
  SiteStatusView,
  ValuationMethod,
  ValuationPagePhase,
  ValuationPreviewView,
  ValuationHandoffView,
} from '../../../../shared/contracts/report-evaluation.ts'

/**
 * 房地产启动页的**客户端状态机**（协议 35 · 计划 Task 4）。
 *
 * ## 这一代换了什么
 *
 * 协议 32 那一版的页面阶段直接照搬 Host 的轮次（`extracting` / `running` / `completed` …），
 * 于是页面必须**追着轮次跑**：面板得持有估值专用轮询、结果页得读交付件存在性、抽屉里塞满了
 * 提取结果（知识库状态、已知/缺失字段、冲突表、完整 Prompt、取证能力、digest）。
 *
 * 这一代把两件事彻底分开：
 *
 * - **页面只知道"能不能创建、是不是已经交接"**：阶段是 `ValuationPagePhase`（见 shared 合同）；
 * - **方案识别、方法判定、取知识、抓案例、填表、勾稽全在父会话里**，页面不再有它们的 API。
 *
 * 于是"交接成功后不再有任何请求"不是靠纪律，而是**写不出来**：这一层没有 status / result /
 * 运行期 cancel 这些动作。
 *
 * ## 只读抽屉仍然由状态机保证
 *
 * 抽屉里不许改方法 / 基准日 / 补充要求 —— 这条不靠"按钮没绑 onClick"，而是
 * `canEditInputs(phase)` 只在 `draft` 为真：确认阶段的一切改输入动作都会被拒绝并给出原因。
 */

// 这几个是**跨进程合同**里的类型，组件从 model 取（页面不直接依赖 shared 的形状名）。
export type { ValuationMethod, ValuationPagePhase, ValuationPreviewView, ValuationHandoffView }

export const VALUATION_METHODS: readonly ValuationMethod[] = ['market', 'income', 'cost']

/**
 * 草稿里的评估方法：**空串是"还没选"**。
 *
 * 方法必须由用户在选择页明确指定（市场法 / 收益法 / 成本法），没有「自动判定」这一档。
 * 草稿用空串表示"还没选"，提交与冻结输入才收窄成 `ValuationMethod`。
 */
export type ValuationMethodChoice = '' | ValuationMethod

/**
 * 收窄成正式方法：空串与未知枚举都不是有效方法。
 *
 * 参数刻意是 `unknown`：Host 回包里的 `methodRequest` 在收窄之前就是 `string`，
 * 而"它是不是有效方法"必须由这一个函数判，不能靠调用方先强转一次。
 */
export function chosenMethod(method: unknown): ValuationMethod | null {
  return isValuationMethod(method) ? method : null
}

/** 资产类型是不是已登记的取值（空串 = 还没选，不是"未知"）。 */
export function isKnownAssetType(value: unknown): boolean {
  return (ASSET_TYPES as readonly string[]).includes(text(value))
}

/**
 * 资产类型的**显示名**（稳定业务标识 → 人话）。
 *
 * 未登记的取值原样返回：宁可让员工看到一个陌生的标识，也不要把它显示成别的资产类型。
 * 空串返回空串（调用方自己决定写"未指定"还是"请选择"）。
 */
export function assetTypeLabelOf(assetType: string): string {
  const value = text(assetType).trim()
  if (value === '') return ''
  if (value === 'real-estate') return zhCN.valuationAssetTypeRealEstate
  // 未登记的取值原样返回：宁可让员工看到一个陌生的标识，也不要把它显示成别的资产类型。
  return value
}

/**
 * 全部方法都**开放**（协议 39）。
 *
 * 旧实现把收益法 / 成本法画成禁用项，理由是"正文与模板还没就绪" —— 那是**知识侧**的事实，
 * 不是入口该拦的东西：知识补一章之后，UI 不该跟着发一次版。开放入口也不等于缺口消失：
 * 资料、参数、模板或能力不够时，由本轮会话按 Wiki 的缺失处置如实登记缺口。
 */
export function methodSupported(_method: ValuationMethod): boolean {
  return true
}

/**
 * 方法选项（界面顺序即数组顺序）。
 *
 * 三项指定方法都不禁用。真正的适用性判断归本轮知识（方法选择方案正文），归 Agent 执行，
 * 不归这一层写死；没有「自动判定」这一档。
 */
export function valuationMethodOptions(): Array<{
  value: ValuationMethod
  label: string
  hint: string
  disabled: boolean
}> {
  return [
    { value: 'market', label: zhCN.valuationMethodMarket, hint: zhCN.valuationMethodMarketHint, disabled: false },
    { value: 'income', label: zhCN.valuationMethodIncome, hint: zhCN.valuationMethodIncomeHint, disabled: false },
    { value: 'cost', label: zhCN.valuationMethodCost, hint: zhCN.valuationMethodCostHint, disabled: false },
  ]
}

/**
 * 方法显示名。
 *
 * 认不出来时返回**空串**：以前这里回退成「自动判定」，于是空值与未知枚举在界面上
 * 都被显示成"用户选了自动判定"（这正是本轮要拆掉的掩盖）。
 */
export function valuationMethodLabel(method: string): string {
  return valuationMethodOptions().find((item) => item.value === method)?.label ?? ''
}

/**
 * 方法的一句话说明（与**本次选择**相符）。
 *
 * 抽屉与表单共用同一份口径：以前抽屉里写的是"当前支持住宅市场法 / 收益法成本法尚未提供"，
 * 那是知识侧的旧事实，与用户选了什么毫无关系。
 */
export function valuationMethodHintOf(method: string): string {
  return valuationMethodOptions().find((item) => item.value === method)?.hint ?? ''
}

export function isValuationMethod(value: unknown): value is ValuationMethod {
  return (VALUATION_METHODS as readonly string[]).includes(text(value))
}

export type ValuationScanState = 'idle' | 'scanning' | 'ready' | 'failed'

/** 门禁检查的进行状态。 */
export type AuthCheckState = 'idle' | 'checking' | 'ready'

export interface ValuationLoginState {
  check: AuthCheckState
  /** Host 推出的门禁结论；还没查过是 `null`。 */
  gate: AuthGateView | null
  rows: SiteRowView[]
  sites: SiteStatusView[]
  loginJobs: LoginJobView[]
  /** 最近一次检查**没做成**的原因（不是"未登录"）。 */
  error: string
  /** 本页发起、当前在跑的那一条登录任务。 */
  job: LoginJobView | null
}

/** 输入页里的一份资料（对"选中的目录"来说是一行，`fileCount` 是它展开后的份数）。 */
export interface ValuationSelectedFileView {
  path: string
  name: string
  /** 重名时才给的目录摘要（完整路径留在 `path` 与 `title` 里）。 */
  dirHint: string
  kind: string
  sizeBytes: number
  status: string
  reason: string
  fileCount: number
}

/**
 * 入口展开后的**真实文件行**（协议 37 · 设计稿 §8.2）。
 *
 * `state` 是界面状态而不是 Host 状态：Host 只会回"还留在本次范围里的文件"，所以
 * "已从本次范围移除"这一档由客户端记着 —— 它必须仍然**看得见**（否则员工无从核对，
 * 也没有「重新纳入」的落点）。
 */
export interface ValuationFileRowView {
  path: string
  name: string
  kind: string
  sizeBytes: number
  /** 它属于哪个已选入口（入口的绝对路径）。 */
  parentPath: string
  state: 'included' | 'excluded'
}

/** 一次扫描里被跳过的条目（符号链接 / 特殊文件 / 权限不足）。 */
export interface ValuationScanSkippedView {
  path: string
  name: string
  reason: string
}

/**
 * 一次"移除"之前的完整范围（撤销用它**原样**还原）。
 *
 * 存整份范围而不是只存一个路径：移除文件夹会同时改 `selection` 与 `excluded`，
 * 只回滚其中一个会留下一个既不在选择里、又被排除的范围。
 */
export interface ValuationScopeSnapshot {
  selection: string[]
  excluded: string[]
  files: ValuationFileRowView[]
}

/** 最近一次移除（只保留一条：连续移除以**最近一次**为单位撤销）。 */
export interface ValuationRemovalMemory {
  kind: 'file' | 'root'
  name: string
  scope: ValuationScopeSnapshot
}

export interface ValuationPageState {
  phase: ValuationPagePhase
  login: ValuationLoginState
  /** 用户选中的本机文件 / 文件夹（绝对路径；只在客户端内存里）。 */
  selection: string[]
  /** 入口层事实（文件夹只在这里带一个份数）。 */
  files: ValuationSelectedFileView[]
  /** 入口展开后的真实文件行（含"已移除"的那些）。 */
  fileRows: ValuationFileRowView[]
  /** 扫描跳过的条目（带原因；不混进已纳入份数）。 */
  scanSkipped: ValuationScanSkippedView[]
  /**
   * 员工逐个移除掉的文件（绝对路径）。
   *
   * 它与 `selection` 一起提交给 Host：扫描、预览与归档**共用同一份**范围 ——
   * 只过滤 UI 列表就是"假排除"。
   */
  excluded: string[]
  /** 最近一次移除（8 秒内可撤销；准备确认时冻结并清掉）。 */
  lastRemoval: ValuationRemovalMemory | null
  scanState: ValuationScanState
  scanError: string
  /** 枚举被安全上限截断：清单不完整 → 不能确认。 */
  truncated: boolean
  /** 递归去重后的**文件数**（用户选中的目录数不作数）。 */
  fileCount: number
  /** 扫描说超限（>30）：**整批阻止**，不悄悄截取。 */
  overLimit: boolean
  /** 扫描里读得出来的份数（0 = 一份都读不出来，不能启动）。 */
  readableCount: number
  /** Host 报的份数上限（界面照它说"上限 N 份"）。 */
  limit: number
  /** 用户选定的评估方法；未选择是空串（详见 `ValuationMethodChoice`）。 */
  method: ValuationMethodChoice
  /**
   * 用户选定的**资产类型**；未选择是空串。
   *
   * 通用入口的第一个选择，也是装配哪个 Skill / 哪份入口 Wiki 的唯一依据 —— 所以
   * **初始必须是空**，不替用户默认成房地产（那会把未确认的资产口径写进冻结输入）。
   */
  assetType: string
  /** 用户选择的基准日；未选择是空串。 */
  baseDate: string
  /**
   * 用户填的**评估目的**；未填是空串（= 未指定）。
   *
   * 它不参与"能不能确认"的判据（业务前提允许后补），但会随摘要冻结，
   * 且报告里必须按"未指定"呈现 —— **不是**默认成某种正式目的。
   */
  purpose: string
  /** 用户填的**价值类型**；未填是空串（= 未指定）。可选值清单待业务方确认，界面不做枚举。 */
  valueType: string
  /**
   * 可选的计算表模板（本机绝对路径，协议 43）。
   *
   * 空串 = 不指定。它**不在** `selection` / `excluded` 里：模板是"算哪张表"的角色，
   * 与"本轮纳入哪些资料"是两件事；Host 预览时按 canonical 路径把它绑到归档 fileId。
   */
  templatePath: string
  supplementalPrompt: string
  /** 超过上限的输入原文（让"粘贴超长"有明确说明而不是静默截断）。 */
  promptOverLimit: boolean
  /** Host 回填的归档预览（确认抽屉的数据源）；还没准备过是 `null`。 */
  preview: ValuationPreviewView | null
  projectId: string
  parentSessionId: string
  dispatchAccepted: boolean
  /**
   * 交接结果的**权威创建判据**（Host 给的）。
   *
   * 只有 `not-created` 才允许「返回修改」；`unknown` 与 `created` 都必须先完成同一轮恢复。
   */
  creationDisposition: CreationDisposition
  /**
   * Host-provided executable recovery for the last failure.
   *
   * Only `refresh-preview` (an expired preview with no parent session) turns the primary
   * action into a fresh preparation; everything else keeps the same-request recovery.
   */
  recoveryAction: '' | 'refresh-preview' | 'retry-handoff'
  /** 同一 requestId / previewId 已经交接成功过（界面据此不重复提示）。 */
  reused: boolean
  /** 会话建好了、但自动打开失败：重试**只重新导航**，不再创建。 */
  openFailed: boolean
  /** 指令没发出去：重试要发回**同一个会话**。 */
  retrySameSession: boolean
  /** 准备确认的发号器（迟到的响应一比就知道自己是不是当前那一次）。 */
  prepareRequestId: number
  /**
   * 交接的请求标识：**只在第一次点「开始估值」时铸一次**。
   *
   * 超时重试必须带着它原样再发一次 —— Host 按它复用同一个父会话；每次重试都换一个
   * requestId 就会在宿主侧变成"新的一次交接"，于是留下不止一个空会话。
   */
  handoffRequestId: string
  /**
   * 长等待提示（15 秒后出现）。
   *
   * 它不是错误，只是"这一步确实要久一点 + 现在能做什么"。定时器句柄由 controller 管，
   * 这里只存事实，界面据此多画一行说明。
   */
  slowWait: '' | 'auth' | 'prepare' | 'create'
  /** 最近一次成功交接的父会话（再次进入这一页时给一个中性入口）。 */
  recentSessionId: string
  error: string
  notice: string
}

export function initialValuationState(patch: Partial<ValuationPageState> = {}): ValuationPageState {
  return {
    // 协议 39：**进页面就是草稿**，不先探测案例来源 —— 登录是可选用能力，
    // 让它决定首帧画什么，等于又把它变回门禁（用户口径：先允许整理资料）。
    phase: 'draft',
    login: { check: 'idle', gate: null, rows: [], sites: [], loginJobs: [], error: '', job: null },
    selection: [],
    files: [],
    fileRows: [],
    scanSkipped: [],
    excluded: [],
    lastRemoval: null,
    scanState: 'idle',
    scanError: '',
    truncated: false,
    fileCount: 0,
    overLimit: false,
    readableCount: 0,
    limit: 200,
    // 新草稿里两个必填项都**未选择**：资产类型与评估方法都由用户主动选，
    // 没有「自动识别 / 自动判定」这一档，也不替用户默认成房地产或某一种方法。
    method: '',
    assetType: '',
    baseDate: '',
    purpose: '',
    valueType: '',
    templatePath: '',
    supplementalPrompt: '',
    promptOverLimit: false,
    preview: null,
    projectId: '',
    parentSessionId: '',
    dispatchAccepted: false,
    creationDisposition: 'unknown',
    recoveryAction: '',
    reused: false,
    openFailed: false,
    retrySameSession: false,
    prepareRequestId: 0,
    handoffRequestId: '',
    slowWait: '',
    recentSessionId: '',
    error: '',
    notice: '',
    ...patch,
  }
}

export interface MutationResult {
  ok: boolean
  error: string
  state: ValuationPageState
}

function refuse(state: ValuationPageState, error: string): MutationResult {
  return { ok: false, error, state }
}

function accept(state: ValuationPageState, patch: Partial<ValuationPageState>): MutationResult {
  return { ok: true, error: '', state: { ...state, ...patch } }
}

// ── 阶段判据（界面禁用与状态机拒绝共用同一处）────────────────────────────────

/**
 * 这个阶段能不能改输入 —— **唯一**判据。
 *
 * 只有 `draft` 能改：`preparing-confirmation` / `confirmation` / `creating-session` 都在
 * "已经按当前输入往下走"的路上，改了会让"正在按什么输入准备"变得说不清；
 * `handoff-failed` 也不能改 —— 那一屏的主操作是**重试**（或打开已建好的会话），
 * 不是把输入改掉重来（那会变成第二个项目目录）。
 */
export function canEditInputs(phase: ValuationPagePhase): boolean {
  return phase === 'draft'
}

/** 不能改的时候给一句对症的话。 */
export function inputLockedReason(phase: ValuationPagePhase): string {
  if (phase === 'preparing-confirmation') return zhCN.valuationPrepareLocked
  if (phase === 'confirmation') return zhCN.valuationInputLocked
  if (phase === 'creating-session') return zhCN.valuationCreatingLocked
  if (phase === 'handoff-failed') return zhCN.valuationHandoffLocked
  if (phase === 'handed-off') return zhCN.valuationHandedOffLocked
  return zhCN.valuationInputLocked
}

/** 输入工作面该不该**显示**（草稿与"正在准备确认"停在同一个表单上）。 */
export function showsIntakeForm(phase: ValuationPagePhase): boolean {
  return phase === 'draft' || phase === 'preparing-confirmation'
}

/**
 * 输入工作面该不该**留在 DOM 里**（`confirmation` / `creating-session` 期间隐藏但保留）。
 *
 * 为什么要保留而不是卸载：抽屉打开时把整个表单卸载会丢掉**展开状态、查看全部状态、
 * 滚动位置与焦点锚点**，关掉抽屉后员工面对的是一个被重置的表单（设计稿 §16 的"表单展示记忆"）。
 * 隐藏 + `inert`（由抽屉负责）仍然满足"背景不可访问"，而且"焦点回到原「确认」按钮"变成
 * 把焦点还给**同一个**元素。
 */
export function keepsIntakeMounted(phase: ValuationPagePhase): boolean {
  return showsIntakeForm(phase) || showsConfirmationDrawer(phase)
}

/**
 * 案例来源能力区该不该显示。
 *
 * 协议 39 起它**不是门禁屏**：能力区就长在输入工作面里（资料区下方），所以这一档
 * 永远为 `false` —— 保留函数是为了让"门禁屏"这个概念在代码里只剩这一处可查的否定。
 */
export function showsAuthGate(_phase: ValuationPagePhase): boolean {
  return false
}

/**
 * 确认抽屉该不该显示。
 *
 * `creating-session` **也算**：点下「开始估值」之后抽屉必须继续开着、同一颗按钮变成
 * 「正在创建会话…」—— 让原操作界面在点击瞬间消失正是 UX-01 的缺陷。
 */
export function showsConfirmationDrawer(phase: ValuationPagePhase): boolean {
  return phase === 'confirmation' || phase === 'creating-session'
}

/** 页面顶部那一行"现在在等谁"。 */
export function phaseHintOf(phase: ValuationPagePhase): string {
  switch (phase) {
    case 'draft': return zhCN.valuationPhaseDraft
    case 'preparing-confirmation': return zhCN.valuationPhasePreparing
    case 'confirmation': return zhCN.valuationPhaseConfirmation
    case 'creating-session': return zhCN.valuationPhaseCreating
    case 'handoff-failed': return zhCN.valuationPhaseHandoffFailed
    case 'handed-off': return zhCN.valuationPhaseHandedOff
    case 'stale-host': return zhCN.valuationPhaseStale
  }
}

/**
 * Expired-preview recovery copy.
 *
 * The generic not-created copy says "retry creation", which would resubmit an expired
 * handoff. When the Host explicitly asks to refresh the preview there is no parent session
 * to recover, so the only correct primary action is a fresh preparation.
 */
export const HANDOFF_REFRESH_PREVIEW_LABEL = '重新准备确认'
export const HANDOFF_REFRESH_PREVIEW_NOTE = '这次预览已经过期：请重新准备确认，资料与条件会原样保留。'

/**
 * Whether the Host's expired-preview recovery is actionable: authoritative `not-created`
 * with no known parent session. Anything else keeps the same-request recovery path.
 */
export function canRefreshExpiredPreview(state: ValuationPageState): boolean {
  return state.phase === 'handoff-failed'
    && state.recoveryAction === 'refresh-preview'
    && state.creationDisposition === 'not-created'
    && state.parentSessionId === ''
}

/**
 * 交接失败/结果未知时的结构化标题（UX-17）。
 *
 * 标题来自**结构化事实**，不是一句泛化的阶段话：会话已经建出来时还说"未创建"就是自相矛盾。
 */
export function handoffTitleOf(state: ValuationPageState): string {
  if (state.creationDisposition === 'created' || state.parentSessionId !== '') {
    return zhCN.valuationHandoffCreatedTitle
  }
  if (state.creationDisposition === 'not-created') return zhCN.valuationHandoffNotCreatedTitle
  return zhCN.valuationHandoffUnknownTitle
}

/** 交接失败时的解释句（与标题配对，不再叠一句泛化阶段说明）。 */
export function handoffNoteOf(state: ValuationPageState): string {
  if (canRefreshExpiredPreview(state)) return HANDOFF_REFRESH_PREVIEW_NOTE
  if (state.creationDisposition === 'created' || state.parentSessionId !== '') {
    return zhCN.valuationHandoffCreatedNote
  }
  if (state.creationDisposition === 'not-created') return zhCN.valuationHandoffNotCreatedNote
  return zhCN.valuationHandoffUnknownNote
}

/**
 * 「返回修改」是否可用：**只有 Host 明确说"没有创建"**才允许。
 *
 * 结果未知或已有会话时先完成同一轮恢复 —— 直接回草稿会生成第二个项目目录。
 */
export function canReturnToEdit(state: ValuationPageState): boolean {
  if (state.phase === 'confirmation' || state.phase === 'preparing-confirmation') return true
  if (state.phase !== 'handoff-failed') return false
  return state.creationDisposition === 'not-created'
}

/** 「重试创建」与「恢复交接」共用同一颗按钮：复用 requestId 就是恢复。 */
export function handoffRetryLabelOf(state: ValuationPageState): string {
  if (canRefreshExpiredPreview(state)) return HANDOFF_REFRESH_PREVIEW_LABEL
  if (state.creationDisposition === 'not-created') return zhCN.valuationHandoffRetryCreate
  if (state.creationDisposition === 'created' || state.parentSessionId !== '') {
    return zhCN.valuationHandoffRetryDispatch
  }
  return zhCN.valuationHandoffRecover
}

/**
 * 「确认」为什么不能点（空串 = 能点）。
 *
 * 每一条都必须**可见地**说出来，而不是只把按钮画灰：用户点不动又不知道为什么，
 * 唯一的结果是把面板关掉重开。
 *
 * 优先级：清单完整性 → 资料有效性 → **资产类型** → **评估方法** → 文本校验（设计稿 §9.1）。
 * 两个必填项紧挨着：先决定"做哪一种资产"，再决定"用什么方法" —— 它们的错误提示也挨着出现，
 * 用户不会在同一屏的上下两头来回找。
 */
export function startDisabledReason(state: ValuationPageState): string {
  if (!canEditInputs(state.phase)) return inputLockedReason(state.phase)
  if (state.truncated) return zhCN.valuationActionDisabledTruncated
  if (state.scanState === 'failed') return zhCN.valuationActionSummaryScanFailed
  if (state.scanState === 'scanning') return zhCN.valuationScanRunning
  // Revision 2: materials are optional. An intentional empty selection (idle scan,
  // no phantom files) can start; any explicit nonempty selection keeps every safety
  // gate below.
  if (state.selection.length > 0) {
    if (state.overLimit) {
      return zhCN.valuationTooManyFiles
        .replace('{count}', String(state.fileCount))
        .replace('{limit}', String(state.limit))
    }
    if (state.fileCount === 0) return zhCN.valuationActionDisabledSelectionUnscanned
    if (state.readableCount === 0) return zhCN.valuationActionDisabledUnreadable
  }
  if (state.assetType === '') return zhCN.valuationActionDisabledNoAssetType
  if (!isKnownAssetType(state.assetType)) {
    return zhCN.valuationAssetTypeUnknown.replace('{value}', state.assetType)
  }
  if (chosenMethod(state.method) === null) return zhCN.valuationActionDisabledNoMethod
  // 模板是可选角色，但一旦选了就必须是原生选择器给出的 .xlsx 绝对路径。
  if (state.templatePath !== '' && !isTemplatePath(state.templatePath)) {
    return TEMPLATE_INVALID
  }
  if (state.promptOverLimit || state.supplementalPrompt.length > VALUATION_PROMPT_MAX_LENGTH) {
    return zhCN.valuationPromptTooLong.replace('{limit}', String(VALUATION_PROMPT_MAX_LENGTH))
  }
  return ''
}

/** 底栏左侧的"当前可行动摘要"（数量明细留在资料区，不在这里重复）。 */
export function actionSummaryOf(state: ValuationPageState): string {
  if (state.phase === 'preparing-confirmation') return zhCN.valuationActionSummaryPreparing
  if (state.scanState === 'scanning') return zhCN.valuationActionSummaryScanning
  if (state.scanState === 'failed') return zhCN.valuationActionSummaryScanFailed
  if (state.selection.length === 0) return zhCN.valuationActionSummaryOptional
  if (state.fileCount === 0) return zhCN.valuationActionSummaryPendingScan
  if (state.overLimit) {
    return zhCN.valuationActionSummaryOverLimit
      .replace('{count}', String(state.fileCount))
      .replace('{limit}', String(state.limit))
  }
  return zhCN.valuationActionSummaryReady.replace('{count}', String(state.fileCount))
}

/** 资料区的"已纳入 N / limit 份；跳过 M 项"（数量明细只出现在这里）。 */
export function scopeCountsText(state: ValuationPageState): string {
  const base = zhCN.valuationFilesIncluded
    .replace('{count}', String(state.fileCount))
    .replace('{limit}', String(state.limit))
  const skip = state.scanSkipped.length
  return skip === 0 ? base : `${base}；${zhCN.valuationFilesSkippedCount.replace('{count}', String(skip))}`
}

export function canStart(state: ValuationPageState): boolean {
  return state.phase === 'draft' && startDisabledReason(state) === ''
}

// ── 输入 ────────────────────────────────────────────────────────────────────

/**
 * 改本机选择（只有能改输入的阶段允许）。
 *
 * 清掉 `files` / 真实文件行与份数：那是对**上一次**选择的扫描结论，选择一变它就不再是事实。
 * 排除范围（`excluded`）**保留**：本期是"排除优先" —— 被移除的文件不会因为再添加一个
 * 含它的文件夹就自动回来（设计稿 §8.4）。
 */
export function setSelection(state: ValuationPageState, selection: readonly string[]): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  // 同一个绝对路径重复选择：**保留第一次**（提示由调用方给），不把它记成一份失败文件。
  // 更彻底的去重（符号链接、同内容不同路径）按 canonical 路径由 Host 负责。
  const seen = new Set<string>()
  const next: string[] = []
  for (const item of selection) {
    const path = text(item)
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    next.push(path)
  }
  return accept(state, {
    selection: next,
    files: [],
    fileRows: [],
    scanSkipped: [],
    fileCount: 0,
    overLimit: false,
    readableCount: 0,
    truncated: false,
    scanState: 'idle',
    scanError: '',
    error: '',
  })
}

/**
 * 进入"正在重新读取清单"。
 *
 * **不清空旧行**：上一次的事实继续显示（标记为旧事实），主按钮临时禁用；新结果在同一次
 * 状态更新里整组落地（设计稿 §8.6：不要先清空再出现，页面会闪）。
 */
export function beginScan(state: ValuationPageState): MutationResult {
  return accept(state, { scanState: 'scanning', scanError: '' })
}

export interface ScanFacts {
  fileCount: number
  overLimit: boolean
  readableCount: number
  limit: number
  truncated?: boolean
}

/**
 * 扫描结果落地。
 *
 * `rows` 是 Host 回的**真实文件明细**；上一次已被员工移除的那些行不会被 Host 回传，
 * 所以这里把"还不在结果里的已排除行"合并回去 —— 员工必须还能看见它们、也还能「重新纳入」。
 */
export function scanReady(
  state: ValuationPageState,
  files: readonly ValuationSelectedFileView[],
  rows: readonly ValuationFileRowView[],
  facts: ScanFacts,
  skipped: readonly ValuationScanSkippedView[] = [],
): MutationResult {
  const incoming = rows.map((row) => ({ ...row, state: 'included' as const }))
  const incomingPaths = new Set(incoming.map((row) => row.path))
  const kept = state.fileRows
    .filter((row) => row.state === 'excluded' && !incomingPaths.has(row.path))
    .map((row) => ({ ...row }))
  return accept(state, {
    scanState: 'ready',
    scanError: '',
    files: files.map((item) => ({ ...item })),
    fileRows: [...incoming, ...kept],
    scanSkipped: skipped.map((item) => ({ ...item })),
    fileCount: facts.fileCount,
    overLimit: facts.overLimit,
    readableCount: facts.readableCount,
    limit: facts.limit,
    truncated: facts.truncated === true,
  })
}

/** 扫描失败：界面要说清楚是"读不出来"而不是"你还没选"；**保留**入口与条件。 */
export function scanFailed(state: ValuationPageState, error: string): MutationResult {
  return accept(state, {
    scanState: 'failed', scanError: error, fileCount: 0, readableCount: 0, truncated: false,
  })
}

// ── 资料范围：逐个移除 / 移除文件夹 / 撤销 / 重新纳入（§8.4）──────────────────

/** 撤销用的范围快照。 */
function snapshotOf(state: ValuationPageState): ValuationScopeSnapshot {
  return {
    selection: [...state.selection],
    excluded: [...state.excluded],
    files: state.fileRows.map((row) => ({ ...row })),
  }
}

/**
 * 逐个移除一份文件。
 *
 * 它写的是 `excluded`：Host 在扫描 / 预览 / 归档三处共用同一份范围，所以"移除"是真的
 * 不在本次范围里，而不是只从列表上藏起来。
 */
export function excludeFile(state: ValuationPageState, path: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const target = text(path)
  const row = state.fileRows.find((item) => item.path === target)
  if (row === undefined) return refuse(state, zhCN.valuationFilesExcludedReadd)
  if (state.excluded.includes(target)) return refuse(state, zhCN.valuationFilesExcludedReadd)
  return accept(state, {
    excluded: [...state.excluded, target],
    fileRows: state.fileRows.map((item) => (item.path === target ? { ...item, state: 'excluded' } : item)),
    lastRemoval: { kind: 'file', name: row.name, scope: snapshotOf(state) },
    error: '',
  })
}

/**
 * 重新纳入一份之前被移除的文件（本期"排除优先"，所以需要一个显式动作）。
 */
export function reincludeFile(state: ValuationPageState, path: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const target = text(path)
  if (!state.excluded.includes(target)) return refuse(state, zhCN.valuationFilesExcludedReadd)
  return accept(state, {
    excluded: state.excluded.filter((item) => item !== target),
    // 行状态先按"已纳入"显示；真正的份数以紧接着那次重扫为准。
    fileRows: state.fileRows.map((item) => (item.path === target ? { ...item, state: 'included' } : item)),
    lastRemoval: null,
    error: '',
  })
}

/**
 * 移除一个**选择入口**（真个文件夹/文件）。
 *
 * 同时清理只属于该入口的排除项：入口都不在范围里了，它的排除记录再留着只会在
 * 重新添加同一路径时把文件莫名其妙地藏起来。
 */
export function removeSelection(state: ValuationPageState, path: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const target = text(path)
  const row = state.files.find((item) => item.path === target)
  if (row === undefined) return refuse(state, zhCN.valuationActionSummaryEmpty)
  const owned = new Set(state.fileRows.filter((item) => item.parentPath === target).map((item) => item.path))
  return accept(state, {
    selection: state.selection.filter((item) => item !== target),
    excluded: state.excluded.filter((item) => !owned.has(item)),
    fileRows: state.fileRows.filter((item) => item.parentPath !== target),
    lastRemoval: { kind: 'root', name: row.name, scope: snapshotOf(state) },
    error: '',
  })
}

/** 撤销最近一次移除（文件或文件夹）：原样还原那一刻的范围。 */
export function undoRemoval(state: ValuationPageState): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const memory = state.lastRemoval
  if (memory === null) return refuse(state, zhCN.valuationFilesExcludedReadd)
  return accept(state, {
    selection: [...memory.scope.selection],
    excluded: [...memory.scope.excluded],
    fileRows: memory.scope.files.map((row) => ({ ...row })),
    lastRemoval: null,
    error: '',
  })
}

/** 准备确认时冻结范围：撤销入口必须消失（可编辑操作不进只读抽屉）。 */
export function freezeScope(state: ValuationPageState): MutationResult {
  return accept(state, { lastRemoval: null })
}

/**
 * 选**资产类型**。
 *
 * 它是通用入口的第一个选择，也是装配哪个 Skill / 哪份入口 Wiki 的唯一依据。允许清回空串
 * （"我选错了"），但**不允许**在用户没选时替它填一个默认值 —— 所以空串是合法状态，
 * 只是不能确认。
 *
 * 切换资产类型**保留共用输入**（资料、目的、价值类型、基准日、补充要求）；专属条件不兼容
 * 时由各自的方法选项与提示说明，不在这里悄悄清空用户的输入。
 */
export function setAssetType(state: ValuationPageState, assetType: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(assetType).trim()
  if (value === '') return accept(state, { assetType: '' })
  if (!(ASSET_TYPES as readonly string[]).includes(value)) {
    return refuse(state, zhCN.valuationAssetTypeUnknown.replace('{value}', value))
  }
  return accept(state, { assetType: value })
}

/**
 * 选**评估方法**。
 *
 * 四项都可选，但**空串与未知枚举都不是有效方法**：旧实现的判据是 `methodSupported()`，
 * 而它恒真 —— 于是"没选"和"选了一个不存在的枚举"都能通过校验，一路走到 Host 才被拒。
 * 现在这里就是那道校验（`''` 允许，表示清回未选）。
 */
export function setMethod(state: ValuationPageState, method: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(method).trim()
  if (value === '') return accept(state, { method: '' })
  if (!isValuationMethod(value)) {
    return refuse(state, zhCN.valuationMethodUnknown.replace('{value}', value))
  }
  if (!methodSupported(value)) return refuse(state, zhCN.valuationMethodUnsupported)
  return accept(state, { method: value })
}

/**
 * 改基准日。
 *
 * 只接受空串或**真实存在**的 `YYYY-MM-DD`：其余一律拒绝而不是"尽量解析" —— 基准日错一天，
 * 交易日期修正与收益年限都跟着错，而那是看不出来的。形状对但日期不存在的（`2026-02-30`）
 * 同样必须拒绝：`new Date('2026-02-30')` 会悄悄滚到 3 月 2 日，这正是要断掉的那类静默归一。
 */
export function setBaseDate(state: ValuationPageState, baseDate: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(baseDate).trim()
  if (value === '') return accept(state, { baseDate: '' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealCalendarDate(value)) {
    return refuse(state, zhCN.valuationBaseDateShape)
  }
  return accept(state, { baseDate: value })
}

/**
 * `YYYY-MM-DD` 是不是一个**真实存在**的日历日期。
 *
 * 逐字段回读而不是 `Date.parse`：后者对越界日期做溢出归一（`2026-02-30` → 3 月 2 日），
 * 于是"员工填错了一天"会变成"系统替他换了另一天"。这里刻意**不用** UTC 转换，
 * 所以日期值不会因为时区前后移动一天。
 */
export function isRealCalendarDate(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12 || day < 1) return false
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= (daysInMonth[month - 1] ?? 0)
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * 改**评估目的** / **价值类型**。
 *
 * 与基准日同一套口径：空串是"未指定"（合法），超长拒绝而不是截断。
 * 不在状态机里校验业务枚举 —— 可选值清单属于业务规范，代码不发明。
 */
export function setPurpose(state: ValuationPageState, purpose: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(purpose).trim()
  if (value.length > PURPOSE_MAX_LENGTH) {
    return refuse(state, zhCN.valuationPurposeTooLong.replace('{limit}', String(PURPOSE_MAX_LENGTH)))
  }
  return accept(state, { purpose: value })
}

export function setValueType(state: ValuationPageState, valueType: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(valueType).trim()
  if (value.length > VALUE_TYPE_MAX_LENGTH) {
    return refuse(state, zhCN.valuationValueTypeTooLong.replace('{limit}', String(VALUE_TYPE_MAX_LENGTH)))
  }
  return accept(state, { valueType: value })
}

/**
 * 改补充要求（原样用户输入，只受长度上限约束）。
 *
 * 超限时**不静默截断**：写进 `promptOverLimit` 并给一句说明，`supplementalPrompt` 保持
 * 上一次的有效内容（粘贴一大段不该把已写好的要求吃掉）。
 */
export function setSupplementalPrompt(state: ValuationPageState, prompt: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(prompt)
  if (value.length > VALUATION_PROMPT_MAX_LENGTH) {
    const error = zhCN.valuationPromptOverLimit.replace('{limit}', String(VALUATION_PROMPT_MAX_LENGTH))
    return { ok: false, error, state: { ...state, promptOverLimit: true, error } }
  }
  return accept(state, { supplementalPrompt: value, promptOverLimit: false })
}

/** 模板不合规时唯一的一句人话（`setTemplate` 与底栏判据共用）。 */
export const TEMPLATE_INVALID = '计算表模板必须是一份本机 .xlsx 文件：请通过「选择模板」重新选择。'

/**
 * 模板路径的**形状**判据：必须是原生选择器给出的绝对路径，且扩展名是 `.xlsx`。
 *
 * 为什么非要绝对路径：浏览器里 `File.name` 只有一个文件名，那对 Host 毫无意义。
 * 拿它冒充路径会让"模板已选中"变成一句假话 —— 预览时 Host 找不到这份文件。
 */
export function isTemplatePath(value: unknown): boolean {
  const path = text(value).trim()
  if (path === '') return false
  if (!/\.xlsx$/i.test(path)) return false
  // POSIX 绝对路径 / Windows 盘符 / UNC 三种原生形态；相对路径一律不接受。
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * 选 / 清计算表模板（`''` = 不指定）。
 *
 * 只接受单份 `.xlsx` 的绝对路径；选择与移除是两个显式动作（移除不影响资料范围）。
 */
export function setTemplate(state: ValuationPageState, templatePath: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(templatePath).trim()
  if (value === '') return accept(state, { templatePath: '' })
  if (!isTemplatePath(value)) return refuse(state, TEMPLATE_INVALID)
  return accept(state, { templatePath: value })
}

// ── 案例来源能力（**不是门禁**） ──────────────────────────────────────────────

/**
 * 开始（或重新开始）一次来源能力检查。
 *
 * **不改阶段**：协议 39 起登录是可选用能力，"正在检查"不许把页面挡在草稿之外。
 * 它只更新能力区自己的 `check`。
 */
export function authChecking(state: ValuationPageState): MutationResult {
  return accept(state, {
    login: { ...state.login, check: 'checking', error: '' },
    error: '',
    slowWait: '',
  })
}

/** 已经在"正文之内"的阶段：一次复查放行时不该把页面重置回草稿。 */
function insideBody(phase: ValuationPagePhase): boolean {
  return phase === 'draft' || phase === 'preparing-confirmation' || phase === 'confirmation'
    || phase === 'creating-session' || phase === 'handoff-failed' || phase === 'handed-off'
    || phase === 'stale-host'
}

/**
 * 把本页那条登录任务与 Host 的最新任务列表对齐（UX-07）。
 *
 * 判据只有 `jobId`：Host 的任务列表里还有它就用**新状态**（含 `waiting-user`），
 * 没有就把它丢掉 —— 否则一次 `running` 会被无限保留，重新检查之后界面上还挂着上一条登录。
 */
export function syncLoginJob(
  job: LoginJobView | null,
  jobs: readonly LoginJobView[],
): LoginJobView | null {
  if (job === null) return null
  return jobs.find((item) => item.jobId === job.jobId) ?? null
}

/**
 * 能力状态落地。
 *
 * **不再有"释放正文"这一档**：未登录 / 未知 / 该站失败都只更新能力事实，页面的阶段
 * （草稿、确认、交接）原样保留。这样"没登录也能填完并启动"不是靠调用方自觉，而是
 * 写不出来 —— 这个函数根本不碰 `phase`。
 */
export function authReady(state: ValuationPageState, view: {
  rows: SiteRowView[]
  sites: SiteStatusView[]
  gate: AuthGateView
  loginJobs: LoginJobView[]
}): MutationResult {
  return accept(state, {
    phase: insideBody(state.phase) ? state.phase : 'draft',
    login: {
      check: 'ready',
      gate: view.gate,
      rows: view.rows.map((row) => ({ ...row })),
      sites: view.sites.map((site) => ({ ...site })),
      loginJobs: view.loginJobs.map((job) => ({ ...job })),
      error: '',
      // 按 jobId 对齐：Host 已经不认这条任务了就不再显示它。
      job: syncLoginJob(state.login.job, view.loginJobs),
    },
    error: '',
    slowWait: '',
  })
}

/** 能力检查**没查成**（清单读不出来 / 浏览器不可用）：如实说不可用，并给"重新检查"。 */
export function authFailed(state: ValuationPageState, error: string): MutationResult {
  return accept(state, {
    phase: insideBody(state.phase) ? state.phase : 'draft',
    login: {
      ...state.login,
      check: 'ready',
      error,
      gate: {
        released: false, required: [], optional: [], reason: error, unavailable: true, checkedAt: '',
      },
    },
    error: '',
    slowWait: '',
  })
}

/**
 * 检查**等超时**（页面等待结束，不是 Host 失败）。
 *
 * 措辞只说"这次检查没等到结论"：不能宣称 Host 那边的操作已经被取消，也不能说来源未登录。
 */
export function authTimedOut(state: ValuationPageState): MutationResult {
  return accept(state, {
    phase: insideBody(state.phase) ? state.phase : 'draft',
    login: {
      ...state.login,
      check: 'ready',
      error: zhCN.valuationAuthCheckTimedOut,
      gate: {
        released: false, required: [], optional: [],
        reason: zhCN.valuationAuthCheckTimedOut, unavailable: true, checkedAt: '',
      },
    },
    error: '',
    slowWait: '',
  })
}

/** 长等待提示（15 秒）：只是"这一步确实要久一点 + 现在能做什么"。 */
export function markSlowWait(state: ValuationPageState, which: '' | 'auth' | 'prepare' | 'create'): MutationResult {
  return accept(state, { slowWait: which })
}

/** 打开验证窗口的结果：`opened` **只**说明窗口开了，不说明验证已经通过。 */
export function verificationOpened(state: ValuationPageState, view: {
  ok: boolean
  error: string
  opened: boolean
  siteId: string
}): MutationResult {
  const label = state.login.rows.find((row) => row.siteId === view.siteId)?.label ?? view.siteId
  if (view.ok && view.opened) {
    return accept(state, {
      login: { ...state.login, error: '' },
      notice: zhCN.valuationAuthVerifyOpened.replace('{label}', label),
      error: '',
    })
  }
  const reason = view.error === '' ? zhCN.valuationAuthVerifyFailed : view.error
  return accept(state, {
    login: { ...state.login, error: reason },
    error: '',
    notice: '',
  })
}

/** 登录任务受理（`reused` = 复用正在跑的那一条）。 */
export function loginStarted(state: ValuationPageState, view: {
  ok: boolean
  error: string
  jobId: string
  reused: boolean
  job: LoginJobView | null
}): MutationResult {
  const siteId = view.job?.siteId ?? state.login.job?.siteId ?? ''
  const label = state.login.rows.find((row) => row.siteId === siteId)?.label ?? siteId
  if (!view.ok) {
    return accept(state, { login: { ...state.login, error: view.error }, error: view.error, notice: '' })
  }
  return accept(state, {
    login: { ...state.login, job: view.job, error: '' },
    notice: (view.reused ? zhCN.valuationAuthLoginReused : zhCN.valuationAuthLoginStarted)
      .replace('{label}', label),
    error: '',
  })
}

/** 取消本页发起的那一条登录任务（权威结论仍由下一次 preflight 给）。 */
export function loginCancelled(state: ValuationPageState): MutationResult {
  return accept(state, { login: { ...state.login, job: null }, notice: '' })
}

// ── 准备确认（「确认」） ─────────────────────────────────────────────────────

export function beginPrepare(state: ValuationPageState, requestId: number): MutationResult {
  const reason = startDisabledReason(state)
  if (reason !== '') return refuse(state, reason)
  return accept(state, {
    phase: 'preparing-confirmation',
    prepareRequestId: requestId,
    preview: null,
    recoveryAction: '',
    // 冻结范围：可编辑操作（撤销）不许带进只读抽屉（设计稿 §8.4）。
    lastRemoval: null,
    error: '',
    notice: '',
    slowWait: '',
  })
}

/**
 * 归档预览落地 → 打开只读确认抽屉。
 *
 * ## 为什么 `ok:true` 还不够
 *
 * 抽屉里的资产类型与方法是**本次 Host 核对的事实**，不是草稿的回声。所以一份"成功"回包
 * 只要缺资产类型 / 方法，或者回显与本次提交不一致，就不是一次可信的核对结果：
 * 旧实现会把草稿里的旧方法原样填进去（`?? state.method`），于是抽屉显示的条件与被冻结的
 * 输入可能根本不是同一份。现在这两种情形都返回**可恢复错误**并留在草稿（输入一个字不动）。
 */
export function prepareReady(
  state: ValuationPageState,
  requestId: number,
  preview: ValuationPreviewView,
): MutationResult {
  if (!isCurrentPrepare(state, requestId)) return refuse(state, zhCN.valuationStaleIntake)
  if (preview.ok !== true) {
    return accept(state, {
      phase: 'draft',
      prepareRequestId: 0,
      preview: null,
      error: preview.error || zhCN.valuationIntakeFailed,
    })
  }
  const recover = (error: string): MutationResult => accept(state, {
    phase: 'draft', prepareRequestId: 0, preview: null, error, slowWait: '',
  })
  const verifiedMethod = chosenMethod(preview.methodRequest)
  if (!isKnownAssetType(preview.assetType) || verifiedMethod === null) {
    return recover(zhCN.valuationPreviewIncomplete)
  }
  if (preview.assetType !== state.assetType || verifiedMethod !== state.method) {
    return recover(zhCN.valuationPreviewMismatch)
  }
  // 模板角色必须与本次提交一致：选了模板却没有归档 fileId（或反之）都不是可信的回执。
  if ((state.templatePath !== '') !== (text(preview.templateFileId) !== '')) {
    return recover(zhCN.valuationPreviewIncomplete)
  }
  return accept(state, {
    phase: 'confirmation',
    prepareRequestId: 0,
    preview,
    recoveryAction: '',
    projectId: preview.projectId || state.projectId,
    // 资产类型与方法**逐字**取自 Host 回包（已在上面的校验里确认过是本次提交的那一份）。
    assetType: preview.assetType,
    method: verifiedMethod,
    baseDate: preview.baseDate ?? state.baseDate,
    // 评估目的 / 价值类型：Host 回 `null` 就是"未指定"（**不回填**草稿里的旧值，
    // 否则"清空"会被一次预览悄悄还原成上一轮的结论）。
    purpose: preview.purpose ?? '',
    valueType: preview.valueType ?? '',
    supplementalPrompt: preview.supplementalPrompt,
    error: '',
    slowWait: '',
  })
}

/** 准备确认失败（Host 拒绝 / 网络）：回到可编辑草稿并**保留**全部输入。 */
export function prepareFailed(state: ValuationPageState, requestId: number, error: string): MutationResult {
  if (!isCurrentPrepare(state, requestId)) return refuse(state, zhCN.valuationStaleIntake)
  return accept(state, {
    phase: 'draft', prepareRequestId: 0, preview: null, error, slowWait: '',
  })
}

/**
 * 「返回修改」：丢掉这一次预览（下一次「确认」会铸一个新的 requestId）。
 *
 * `handoff-failed` 只有在 Host **明确说没有创建会话**时才允许走这里（UX-06）：
 * 结果未知时回草稿会生成第二个项目目录。
 */
export function backToEdit(state: ValuationPageState): MutationResult {
  if (!canReturnToEdit(state)) {
    return refuse(state, state.phase === 'handoff-failed'
      ? zhCN.valuationHandoffFrozen
      : zhCN.valuationNotInConfirmation)
  }
  return accept(state, {
    phase: 'draft',
    preview: null,
    prepareRequestId: 0,
    handoffRequestId: '',
    // 新建一轮草稿不再持有上一轮的会话身份（最近会话入口另行保留）。
    parentSessionId: state.phase === 'handoff-failed' ? '' : state.parentSessionId,
    creationDisposition: 'unknown',
    recoveryAction: '',
    dispatchAccepted: false,
    retrySameSession: false,
    error: '',
    notice: '',
    slowWait: '',
  })
}

/** 这次响应是不是**当前**那一次准备（迟到的响应必须被丢掉）。 */
export function isCurrentPrepare(state: ValuationPageState, requestId: number): boolean {
  return requestId !== 0 && state.prepareRequestId === requestId
}

// ── 交接（「开始估值」） ─────────────────────────────────────────────────────

/**
 * 开始（或重试）一次交接。
 *
 * `requestId` 由调用方给：第一次铸号后写进 state，**重试时原样再用一次** ——
 * Host 按它复用同一个父会话。
 */
export function beginCreate(state: ValuationPageState, requestId: string): MutationResult {
  if (state.preview === null) return refuse(state, zhCN.valuationNotInConfirmation)
  if (state.phase !== 'confirmation' && state.phase !== 'handoff-failed') {
    return refuse(state, inputLockedReason(state.phase))
  }
  // 已经建出会话、或结果未知时，"重试"是**恢复同一轮**（同一个 requestId），不是新一轮。
  return accept(state, {
    phase: 'creating-session',
    handoffRequestId: requestId,
    error: '',
    notice: '',
    slowWait: '',
  })
}

/**
 * 交接成功：会话已建、指令已受理 → 立刻导航。
 *
 * `notice` 只覆盖"正在打开"这一小段：打开成功的那一刻 `openCreatedSession` 就把页面
 * 交回 `resetAfterHandoff`（成功页不留）；打开失败则走 `sessionOpenFailed` 的恢复页。
 */
export function handoffDone(state: ValuationPageState, receipt: ValuationHandoffView): MutationResult {
  const sessionId = receipt.parentSessionId || state.parentSessionId
  return accept(state, {
    phase: 'handed-off',
    preview: null,
    projectId: receipt.projectId || state.projectId,
    parentSessionId: sessionId,
    dispatchAccepted: true,
    creationDisposition: 'created',
    recoveryAction: '',
    reused: receipt.reused === true,
    openFailed: false,
    retrySameSession: false,
    // 成功之后**不再保留**上一轮的失败态提示；最近会话入口供再次进入时使用。
    recentSessionId: sessionId,
    error: '',
    notice: zhCN.valuationSessionCreated,
    slowWait: '',
  })
}

/**
 * 交接没成。
 *
 * 界面据此给动作的**唯一**判据是 Host 的 `creationDisposition`：
 * - `not-created`：会话确定没建出来 —— 可以重试创建，也可以返回修改；
 * - `created`：会话已经建好、只是固定指令没发出去 —— 重试要发回**同一个会话**；
 * - `unknown`：回执没拿到 —— 只能恢复同一轮，**不许**回草稿生成第二个项目。
 *
 * 缺字段时按 `unknown` 处理：默认值必须偏向安全的一侧。
 */
export function handoffFailed(
  state: ValuationPageState,
  receipt: Partial<ValuationHandoffView>,
  error: string,
): MutationResult {
  const sessionId = text(receipt.parentSessionId) || state.parentSessionId
  const raw = text(receipt.creationDisposition)
  const disposition: CreationDisposition = raw === 'not-created' || raw === 'created' || raw === 'unknown'
    ? raw
    : (sessionId === '' ? 'unknown' : 'created')
  const recovery = text(receipt.recoveryAction)
  const recoveryAction: ValuationPageState['recoveryAction'] =
    recovery === 'refresh-preview' ? 'refresh-preview' : recovery === 'retry-handoff' ? 'retry-handoff' : ''
  return accept(state, {
    phase: 'handoff-failed',
    projectId: text(receipt.projectId) || state.projectId,
    parentSessionId: sessionId,
    dispatchAccepted: false,
    creationDisposition: disposition,
    recoveryAction,
    reused: receipt.reused === true,
    // "重试要发回同一条会话"是**会话存在**的事实（与判据分开）：`unknown` 时也可能已经建出
    // 会话来了，重试同样必须复用它。能不能「返回修改」只看 `creationDisposition`。
    retrySameSession: sessionId !== '',
    error,
    notice: '',
    slowWait: '',
  })
}

/** 自动打开失败：会话**已经建好了**，只是没跳到它上面。 */
export function sessionOpenFailed(state: ValuationPageState, error: string): MutationResult {
  return accept(state, {
    phase: 'handed-off',
    openFailed: true,
    creationDisposition: 'created',
    error: `${zhCN.valuationSessionOpenFailed}：${error}`,
    notice: '',
  })
}

/**
 * 交接这一轮结束、**跳转已经发生**：清掉上一轮交接的痕迹，回到**新的草稿**。
 *
 * 两个入口共用它：成功跳转之后立刻调用（页面因此不会停在"估值会话已创建，正在打开…"
 * 那张死页上），以及再次进入估值页时。
 *
 * 成功跳转之后所有页面请求与计时器都停了，这一页不该留着上一轮的状态看板。
 * `recentSessionId` 是唯一被留下来的东西：它只是一个中性入口，不读执行进度、不读交付件。
 *
 * **资产类型一起清回未选择**：下一轮是全新的一次估值，替用户保留上一轮的资产类型
 * 等于让他"以为已经选过了"。
 */
export function resetAfterHandoff(state: ValuationPageState): MutationResult {
  return accept(state, {
    phase: 'draft',
    selection: [],
    files: [],
    fileRows: [],
    scanSkipped: [],
    excluded: [],
    lastRemoval: null,
    scanState: 'idle',
    scanError: '',
    truncated: false,
    fileCount: 0,
    overLimit: false,
    readableCount: 0,
    // 开始新一轮：两个必填项回到未选择，模板与用户文本一起清空。
    method: '',
    assetType: '',
    baseDate: '',
    purpose: '',
    valueType: '',
    templatePath: '',
    supplementalPrompt: '',
    promptOverLimit: false,
    preview: null,
    projectId: '',
    parentSessionId: '',
    dispatchAccepted: false,
    creationDisposition: 'unknown',
    recoveryAction: '',
    reused: false,
    openFailed: false,
    retrySameSession: false,
    prepareRequestId: 0,
    handoffRequestId: '',
    slowWait: '',
    recentSessionId: state.recentSessionId,
    error: '',
    notice: '',
  })
}

/**
 * 切走再回来时的**临时状态清理**（UX-05）。
 *
 * 只清"这一次页面请求的瞬时状态"，不动用户的输入，也不动 Host 那边的登录任务：
 * - `checking` → `idle`：回来时 `checkAuth` 会重新发一次真实检查（否则守卫会认为
 *   "已经有一次检查在途"，页面就永远停在 checking）；
 * - `preparing-confirmation` → `draft`：在途的准备结果已经作废，回来必须是可编辑草稿，
 *   而不是一个永远 pending 的按钮（迟到的响应由 generation 丢掉）。
 *
 * 交接（`creating-session`）**不在这里清理**：会话是 Host 的事务，切走不能中断它。
 */
export function pruneTransientState(state: ValuationPageState): ValuationPageState {
  const checking = state.login.check === 'checking'
  const preparing = state.phase === 'preparing-confirmation'
  if (!checking && !preparing) return state
  return {
    ...state,
    phase: preparing ? 'draft' : state.phase,
    ...(preparing ? { prepareRequestId: 0, preview: null } : {}),
    slowWait: '',
    login: checking ? { ...state.login, check: 'idle' } : state.login,
  }
}

/** 协议代数不匹配 → 整页进入 `stale-host`（那时页面上的一切事实都不可信）。 */
export function markHostStale(state: ValuationPageState): ValuationPageState {
  return { ...state, phase: 'stale-host', error: zhCN.valuationPhaseStale }
}

// ── 输入页 / 抽屉的展示辅助 ─────────────────────────────────────────────────

interface ScanItemLike {
  path?: unknown
  name?: unknown
  kind?: unknown
  sizeBytes?: unknown
  status?: unknown
  reason?: unknown
  fileCount?: unknown
}

/** 路径末段（两种分隔符都认；客户端产物不许引 `node:path`）。 */
export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/** 路径的目录部分（同上）。 */
export function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? '' : path.slice(0, index)
}

/**
 * 把 `valuation-files-scan` 的 `items` 收成输入页的逐份视图。
 *
 * 主标题是**文件名**，只有**重名**的那些才附一行目录摘要 —— 每一行都顶着一长串路径的话，
 * 扫一眼还是认不出是哪一份。
 */
export function selectedFilesOf(
  items: readonly unknown[],
  fallbackPaths: readonly string[],
): ValuationSelectedFileView[] {
  const rows = items.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const raw = item as ScanItemLike
    const path = text(raw.path)
    if (path === '') return []
    return [{
      path,
      name: text(raw.name) || basenameOf(path),
      kind: text(raw.kind),
      sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : 0,
      status: text(raw.status) || 'skipped',
      reason: text(raw.reason),
      fileCount: typeof raw.fileCount === 'number' && Number.isFinite(raw.fileCount) ? raw.fileCount : 1,
    }]
  })
  const list = rows.length > 0 ? rows : fallbackPaths.map((path) => ({
    path, name: basenameOf(path), kind: '', sizeBytes: 0, status: 'skipped', reason: '', fileCount: 1,
  }))
  const duplicated = new Map<string, number>()
  for (const row of list) duplicated.set(row.name, (duplicated.get(row.name) ?? 0) + 1)
  return list.map((row) => ({
    ...row,
    dirHint: (duplicated.get(row.name) ?? 0) > 1 ? dirnameOf(row.path) : '',
  }))
}

/** 人话字节数（`0` / 拿不到时给空串，不编"0 B"当事实）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 大小文本：未知时说"大小待确认"，**不编 0 B**（设计稿 §8.3）。 */
export function sizeTextOf(bytes: number): string {
  return formatBytes(bytes) === '' ? zhCN.valuationFileSizeUnknown : formatBytes(bytes)
}

interface ScanFileLike {
  path?: unknown
  name?: unknown
  kind?: unknown
  sizeBytes?: unknown
  parentPath?: unknown
}

/**
 * 把 `valuation-files-scan` 的 `files[]` 收成真实文件行（协议 37）。
 *
 * `parentPath` 缺字段时退化成它自己：直接选中的文件就是自己的入口，
 * 这样"移除整个入口"的判据不会因为缺一个字段而永远匹配不上。
 */
export function fileRowsOf(files: readonly unknown[]): ValuationFileRowView[] {
  return files.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const raw = item as ScanFileLike
    const path = text(raw.path)
    if (path === '') return []
    return [{
      path,
      name: text(raw.name) || basenameOf(path),
      kind: text(raw.kind),
      sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : 0,
      parentPath: text(raw.parentPath) || path,
      state: 'included' as const,
    }]
  })
}

/** 把 `valuation-files-scan` 的 `skipped[]` 收成可展示的跳过项（带原因）。 */
export function scanSkippedOf(skipped: readonly unknown[]): ValuationScanSkippedView[] {
  return skipped.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const raw = item as { path?: unknown; name?: unknown; reason?: unknown }
    const path = text(raw.path)
    const name = text(raw.name)
    if (path === '' && name === '') return []
    return [{ path, name: name || basenameOf(path), reason: text(raw.reason) }]
  })
}

/** 资料类型的人话名（按扩展名判，认不出来是"未知类型"）。 */
export function fileKindLabel(kind: string): string {
  switch (text(kind)) {
    case 'pdf': return zhCN.valuationKindPdf
    case 'word': return zhCN.valuationKindWord
    case 'excel': return zhCN.valuationKindExcel
    case 'image': return zhCN.valuationKindImage
    case 'text': return zhCN.valuationKindText
    case 'archive': return zhCN.valuationKindArchive
    default: return zhCN.valuationKindUnknown
  }
}

/** 扩展名 → 类型（客户端不引 `node:path`，只做一次小写匹配）。 */
export function fileKindOf(name: string): string {
  const raw = text(name)
  const at = raw.lastIndexOf('.')
  if (at <= 0 || at === raw.length - 1) return 'unknown'
  const ext = raw.slice(at).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.doc' || ext === '.docx') return 'word'
  if (ext === '.xls' || ext === '.xlsx' || ext === '.xlsm') return 'excel'
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.heic', '.tif', '.tiff'].includes(ext)) return 'image'
  if (['.txt', '.md', '.csv', '.json'].includes(ext)) return 'text'
  if (['.zip', '.rar', '.7z'].includes(ext)) return 'archive'
  return 'unknown'
}

/**
 * 一份文件的**界面状态**：入口是否目录、是否被移除、扫描是否说它读不出来。
 *
 * 未知状态一律落到"状态待确认"（设计稿 §8.3 的最后一档）：不能把它读成
 * "已纳入"或"待读取"，那会让员工以为这份资料没问题。
 */
export function fileStatusOf(
  row: ValuationFileRowView,
  scanState: ValuationScanState,
): { key: string; text: string } {
  if (row.state === 'excluded') {
    return { key: 'removed', text: zhCN.valuationFileStatusRemoved }
  }
  if (scanState === 'scanning') {
    return { key: 'reading', text: zhCN.valuationFileStatusReading }
  }
  return { key: 'scanned', text: zhCN.valuationFileStatusScanned }
}

/** 入口行的扫描状态文案（完整映射，不再落进"待读取"）。 */
export function entryStatusText(status: string): string {
  switch (text(status)) {
    case 'scanned': return zhCN.valuationFileStatusScanned
    case 'skipped': return zhCN.valuationFileStatusSkipped
    case 'unreadable': return zhCN.valuationFileStatusUnreadable
    case 'over-limit': return zhCN.valuationFileStatusOverLimit
    case 'removed': return zhCN.valuationFileStatusRemoved
    case 'reading': return zhCN.valuationFileStatusReading
    default: return zhCN.valuationFileStatusUnknown
  }
}

/**
 * 归档资料的创建时间显示。
 *
 * 与 `report-audit/model/time.ts` 同一条口径：**只取字面量**，不做时区换算
 * （Host 给的是 ISO-8601 UTC 记录，换算会让"记录里写的那一刻"在别的时区变成另一天）。
 * `null` = `birthtime` 不可用 → 明说"创建时间未知"，**绝不**拿 mtime 冒充。
 */
export function createdAtTextOf(createdAt: string | null): string {
  const raw = text(createdAt)
  if (raw === '') return zhCN.valuationDrawerCreatedAtUnknown
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw)
  if (matched === null) return raw
  const [, year, month, day, hour, minute] = matched
  return hour === undefined || minute === undefined
    ? `${year}-${month}-${day}`
    : `${year}-${month}-${day} ${hour}:${minute}`
}

/** 同一批资料里出现多次的文件名（抽屉据此附上短 fileId 与目录）。 */
export function duplicateNamesOf(files: readonly { fileName: string }[]): Set<string> {
  const seen = new Map<string, number>()
  for (const file of files) seen.set(file.fileName, (seen.get(file.fileName) ?? 0) + 1)
  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name))
}
