import { text } from '../../../../shared/utils/value.ts'
import { zhCN } from '../../../locales/zh-CN.ts'

/**
 * 报告评估页的**客户端状态机**（协议 32）。
 *
 * ## 为什么状态与"谁能改输入"是同一件事
 *
 * 方案对确认抽屉的要求是"**只读**"：抽屉里不许改字段、不许改提示词、不许改方法、不许改基准日。
 * 把这条写成"按钮不带 onClick"是**界面约定**，改一次渲染就可能悄悄失效；
 * 这里把它变成**状态机判据**：`canEditInputs(state)` 只在 `draft` / `failed` 阶段为真，
 * 一旦进入 `confirmation`，所有改输入的动作都会被拒绝并给出原因。
 * 于是"抽屉只读"是可断言的，而不是靠人看代码。
 *
 * 另一条同样重要的纪律：**"能不能改"与"显不显示"是两个判据**
 *（`canEditInputs` / `showsIntakeForm`）。提取中要显示表单（进度区与取消都在里面）
 * 但不许改；把两者合成一个判据，提取中整块工作面会消失，用户又回到"点了没反应"。
 *
 * ## 阶段与来源
 *
 * 阶段词与 Host 的 `ValuationPhase` 一致（同一套词，两侧不各说一套）。
 * `stale-host` 由客户端在发现协议代数不匹配时给出 —— 那时页面上的一切事实都不可信。
 */

export type ValuationPhase =
  | 'draft'
  | 'extracting'
  | 'confirmation'
  | 'queued'
  | 'running'
  | 'browser-login-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale-host'

export type ValuationMethod = 'auto' | 'market' | 'income' | 'cost'

export const VALUATION_METHODS: readonly ValuationMethod[] = ['auto', 'market', 'income', 'cost']

/** 方法选项（界面顺序即数组顺序；默认第一项 = 自动判定）。 */
export function valuationMethodOptions(): Array<{ value: ValuationMethod; label: string; hint: string }> {
  return [
    { value: 'auto', label: zhCN.valuationMethodAuto, hint: zhCN.valuationMethodAutoHint },
    { value: 'market', label: zhCN.valuationMethodMarket, hint: zhCN.valuationMethodMarketHint },
    { value: 'income', label: zhCN.valuationMethodIncome, hint: zhCN.valuationMethodIncomeHint },
    { value: 'cost', label: zhCN.valuationMethodCost, hint: zhCN.valuationMethodCostHint },
  ]
}

export function valuationMethodLabel(method: ValuationMethod): string {
  return valuationMethodOptions().find((item) => item.value === method)?.label ?? zhCN.valuationMethodAuto
}

export function isValuationMethod(value: unknown): value is ValuationMethod {
  return (VALUATION_METHODS as readonly string[]).includes(text(value))
}

/**
 * 这个阶段能不能改输入 —— **唯一**判据：界面禁用与状态机拒绝都用它。
 *
 * 2026-10-13 用户实测的 bug 就是这里两套判据打架：界面按 `draft || failed` 画（失败后
 * 表单看起来能改），状态机按 `draft || extracting` 拒（一点就报「输入已经冻结」），
 * 于是失败之后**既改不动、也看不到抽屉**（抽屉要 `confirmation`），整页卡死。
 *
 * 正确的是 `draft || failed`：
 * - `draft`：还没开始，当然能改；
 * - `failed`：这一轮没成 —— 用户的第一反应就是"改点什么再试一次"。失败之后不让改，
 *   唯一的结果是让人把面板关掉重开（资料还得重选一遍），那不叫冻结，叫卡死；
 * - `extracting`：**不能改**（§11.1「所有文件、方法、基准日、补充要求暂时不可编辑」）——
 *   改了会让"正在按什么输入提取"变得说不清。要改就先取消或等它结束；
 * - 确认之后（`queued` / `running` / `completed` / `browser-login-required`）：输入已冻结，
 *   要改走「返回修改」重新生成快照。
 */
export function canEditInputs(phase: ValuationPhase): boolean {
  return phase === 'draft' || phase === 'failed'
}

/**
 * 不能改的时候给一句**对症**的话。
 *
 * 提取中说"输入已经冻结"是错的：那时输入没冻结，只是正在按它跑，用户该做的是取消或等。
 */
export function inputLockedReason(phase: ValuationPhase): string {
  return phase === 'extracting' ? zhCN.valuationIntakeBusy : zhCN.valuationInputLocked
}

/**
 * 表单**工作面**该不该显示（草稿 / 提取中 / 失败回退都停在同一个表单上）。
 *
 * 与 `canEditInputs` 分开：提取中"要显示、但不能改" —— 进度区与「取消提取」就长在
 * 这个表单里（§11.1 要求点击后第一帧就有可见反馈）。
 */
export function showsIntakeForm(phase: ValuationPhase): boolean {
  return phase === 'draft' || phase === 'extracting' || phase === 'failed'
}

/** 抽屉该不该显示（"开始估值"之后、确认之前）。 */
export function showsConfirmationDrawer(phase: ValuationPhase): boolean {
  return phase === 'confirmation'
}

/** 页面顶部阶段提示（一句话说清"现在在等谁"）。 */
export function phaseHintOf(phase: ValuationPhase): string {
  switch (phase) {
    case 'draft': return zhCN.valuationPhaseDraft
    case 'extracting': return zhCN.valuationPhaseExtracting
    case 'confirmation': return zhCN.valuationPhaseConfirmation
    case 'queued': return zhCN.valuationPhaseQueued
    case 'running': return zhCN.valuationPhaseRunning
    case 'browser-login-required': return zhCN.valuationPhaseLogin
    case 'completed': return zhCN.valuationPhaseCompleted
    case 'failed': return zhCN.valuationPhaseFailed
    case 'cancelled': return zhCN.valuationPhaseCancelled
    default: return zhCN.valuationPhaseStale
  }
}

/** 一轮估值的**客户端视图**（Host 的事实 + 用户填的输入）。 */
export interface ValuationFileView {
  fileName: string
  relativePath: string
  kind: string
  sizeBytes: number
  status: string
  note: string
}

export interface ValuationKnowledgeView {
  space: string
  ready: boolean
  sources: Array<{ route: string; source: string; updatedAt: string; digest: string }>
  gaps: string[]
}

export interface ValuationProviderView {
  id: string
  label: string
  state: string
  stateLabel: string
  detail: string
  captcha?: boolean
  loginUrl?: string
}

/**
 * 外部来源预检的进行状态。
 *
 * `checking` = 抽屉已经打开、探测还在跑（来源行显示「检查中」）；
 * `done` = 三家都有结论了。它**不阻塞**资料确认信息的展示（§11.2）。
 */
export type ProviderCheckState = 'idle' | 'checking' | 'done'

/** 确认抽屉要显示的全部事实（由 Host 的 `valuation-intake` 回填）。 */
export interface ValuationIntakeView {
  valuationId: string
  casePath: string
  method: string
  baseDate: string
  supplementalPrompt: string
  digest: string
  files: ValuationFileView[]
  extractedFields: Record<string, string>
  missingFields: string[]
  unparsed: string[]
  capabilityGaps: string[]
  warnings: string[]
  knowledge: ValuationKnowledgeView
  providers: ValuationProviderView[]
  /** 每个已知要素来自哪一份资料（标签 → 文件名）。 */
  fieldSources: Record<string, string>
  /** 资料之间的冲突（同一要素在不同资料里不一致）。 */
  fieldConflicts: Array<{ label: string; values: Array<{ file: string; value: string }> }>
  /** 将要提交给估值会话的完整业务提示词（与执行时同一个构造器生成）。 */
  prompt: string
}

/**
 * 选择清单里的一份资料（**输入页**显示用）。
 *
 * 它来自 `valuation-files-scan`：用户在"还没开始提取"的时候也应该看得见自己选了什么、
 * 有多大、哪一份读不出来。以前这一页只拿得到一串绝对路径，于是只能把整条路径当标题
 *（用户原话：文件显示完整绝对路径，不容易辨认资料）。
 */
export interface ValuationSelectedFileView {
  /** 本机绝对路径（客户端内存里的事实，也是移除时的键）。 */
  path: string
  /** 主标题：文件名。 */
  name: string
  /** 同名文件的**目录摘要**（只有重名时才非空，用来区分是哪一个）。 */
  dirHint: string
  kind: string
  sizeBytes: number
  /** `scanned` = 读了；`skipped` = 没读（`reason` 说明为什么）。 */
  status: string
  reason: string
  /** 文件夹来源里实际纳入了几份（单文件是 1）。 */
  fileCount: number
}

/** 选择清单扫描的三种状态（输入页据此决定显示空态 / 骨架 / 列表 / 失败）。 */
export type ValuationScanState = 'idle' | 'scanning' | 'ready' | 'failed'

export interface ValuationProgressView {
  stage: string
  detail: string
  completed: number
  total: number
}

/** 结果页的最小视图（完整结果在 `估值结果.json` 里，界面只显示结论与案例）。 */
export interface ValuationResultView {
  method: string
  methodReason: string
  /** 方法判断记录（§7.2）：每条给出采用 / 不采用与依据。 */
  methodScreening: Array<{ method: string; verdict: string; reason: string }>
  /**
   * 用户指定的方法与结论冲突时的记录（§7.2）。
   *
   * `null` = 没有冲突（用户选了自动判定，或指定的方法就是采用的那个）。
   */
  methodConflict: { userMethod: string; adoptedMethod: string; reason: string } | null
  baseDate: string
  unitPrice: number | null
  totalValue: number | null
  /** 计价面积（㎡）＝建筑面积，权证面积优先；拿不到是 `null`。 */
  pricingArea: number | null
  /** 计价单位（统一「元/㎡」）。 */
  priceUnit: string
  manualConfirmationItems: string[]
  capabilityGaps: string[]
  cases: Array<{
    /** 来源平台 id（fang / anjuke / lianjia）。 */
    source: string
    /** 来源展示名（「房天下」/「链家 / 贝壳」…）。 */
    sourceLabel: string
    url: string
    title: string
    community: string
    transactionType: string
    usedAsComparable: boolean
    unitPrice: number | null
    buildingArea: number | null
    keepReason: string
    dropReason: string
    /** 案例状态（§8）：采用 / 条件不匹配 / 资料或证据不足 / 单项 / 综合 / 组内一致性未通过。 */
    status: string
    /**
     * 这条案例的**规则检查记录**（§8）。
     *
     * 每条至少给出规则 ID、实际值与阈值（数值型规则）、判定和理由 ——
     * "只有一句符合要求"在这里是写不出来的。
     */
    ruleChecks: Array<{
      ruleId: string
      actual: number | null
      threshold: number | null
      verdict: string
      reason: string
    }>
    /** 抓取时刻（可追溯的一部分）。 */
    capturedAt: string
    /**
     * 公开的中介联系方式（§9 第 5 条）。
     *
     * `state` 五态如实呈现；`phone` **原样保留**页面展示的形态（含脱敏），
     * 界面不提供拨号 / 联系入口 —— 只登记公开信息。
     */
    contact: { state: string; agency: string; person: string; phone: string; detail: string }
    /** 页面证据的相对路径（页面字节）；空串表示没留存。 */
    evidence: string
    /** 这一条**明确**没有留存证据（§9「证据不完整」的判据之一）。 */
    evidenceMissing: boolean
    /**
     * **页面截图**（§7.4）：相对案例目录；没有截图能力或截图失败时为空串。
     *
     * 与 `evidence` 分开两列：HTML 字节 / 指纹 / JSON-LD **不是截图**，
     * 两者在争议复核时的证明力不一样。
     */
    screenshot: string
    /** 截图指纹（取证要能核对文件没被换过）。 */
    screenshotDigest: string
    /** 截图采集时刻。 */
    screenshotCapturedAt: string
    /** 这一条**明确**没有截图（本部署没有截图能力时全部为 true）。 */
    screenshotMissing: boolean
  }>
  artifacts: { html: boolean; xlsx: boolean; json: boolean }
}

export interface ValuationPageState {
  phase: ValuationPhase
  /**
   * 本轮估值 ID（进入 intake 时由 Host 铸号；未铸号时为空串）。
   *
   * ⚠️ 它在**点下"检查并确认"的那一刻**就写进 state，不是等 Host 回来才写：
   * 提取过程中用户点「取消提取」要按这个 id 通知 Host，`state.valuationId` 还空着的话
   * 那个通知根本发不出去（宿主那一轮会一直在跑）。
   */
  valuationId: string
  /** 用户选择的本机文件 / 文件夹（绝对路径；只在客户端内存里）。 */
  selection: string[]
  /** 选择清单的**逐份事实**（扫描结果；`selection` 变了就作废）。 */
  files: ValuationSelectedFileView[]
  scanState: ValuationScanState
  scanError: string
  method: ValuationMethod
  /** 用户选择的基准日；未选择是空串。 */
  baseDate: string
  supplementalPrompt: string
  /** Host 回填的确认数据；还没跑过 intake 时为 `null`。 */
  intake: ValuationIntakeView | null
  progress: ValuationProgressView
  providerStates: Record<string, { state: string; attempts: number; detail: string }>
  /** 外部来源预检：抽屉打开后才开始跑，跑的过程中不挡资料确认信息。 */
  providerCheck: ProviderCheckState
  /** 逐家的公开登录页地址（宿主给的公开地址，不是凭据）。 */
  providerLoginUrls: Record<string, string>
  sessionId: string
  casePath: string
  result: ValuationResultView | null
  /**
   * 当前提取阶段的**人话**（来自宿主 `valuation-status` 的 `progress.stage`）。
   *
   * 客户端**不自己编阶段**：没有宿主结论时这里就是空串，界面退回一句
   * 「正在提取资料…」。按计时器逐条切换阶段文字是**假进度**（§4 明确禁止）。
   */
  intakeStage: string
  /**
   * 本轮提取请求的序号：只接受**当前**请求的响应。
   *
   * 用户「取消提取」或「返回修改」后旧响应才回来的话，用 `requestId` 一比就丢掉它 ——
   * 否则迟到的响应会把抽屉重新弹出来（用户明明已经退出了）。
   */
  intakeRequestId: number
  /**
   * 三件交付件的存在性（宿主 `valuation-status` 报的事实）。
   *
   * 它让"部分结果"可判：轮次失败了，但底稿 / 报告已经产出一部分 —— 那些东西要看得见，
   * 只是不能当正式结论。
   */
  artifacts: { html: boolean; xlsx: boolean; json: boolean }
  /**
   * 失败发生在那一个阶段（宿主报的最后一个阶段）。
   *
   * §4 要求失败时给出"具体原因、失败阶段和可执行动作"。阶段是**宿主报的**真实阶段，
   * 不是客户端猜的 —— 没拿到就是空串，那时界面只说原因。
   */
  failedStage: string
  /** 失败原因（人话）。 */
  error: string
  /** 需要用户在默认浏览器登录的来源（`browser-login-required` 阶段）。 */
  needsLogin: string[]
}

export function initialValuationState(patch: Partial<ValuationPageState> = {}): ValuationPageState {
  return {
    phase: 'draft',
    valuationId: '',
    selection: [],
    files: [],
    scanState: 'idle',
    scanError: '',
    method: 'auto',
    baseDate: '',
    supplementalPrompt: '',
    intake: null,
    progress: { stage: '', detail: '', completed: 0, total: 0 },
    providerStates: {},
    providerCheck: 'idle',
    providerLoginUrls: {},
    sessionId: '',
    casePath: '',
    result: null,
    artifacts: { html: false, xlsx: false, json: false },
    failedStage: '',
    intakeStage: '',
    intakeRequestId: 0,
    error: '',
    needsLogin: [],
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

/**
 * 改本机选择（只有能改输入的阶段允许）。
 *
 * 清掉 `files`：那是对**上一次**选择的扫描结论，选择一变它就不再是事实（留着会让界面
 * 显示已经移除的文件）。
 */
export function setSelection(state: ValuationPageState, selection: readonly string[]): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  return accept(state, {
    selection: selection.map((item) => text(item)).filter((item) => item !== ''),
    files: [],
    scanState: 'idle',
    scanError: '',
  })
}

/** 扫描开始（界面显示骨架）。 */
export function beginScan(state: ValuationPageState): MutationResult {
  return accept(state, { scanState: 'scanning', scanError: '' })
}

/** 扫描成功：逐份事实落地。 */
export function scanReady(state: ValuationPageState, files: readonly ValuationSelectedFileView[]): MutationResult {
  return accept(state, { scanState: 'ready', scanError: '', files: files.map((item) => ({ ...item })) })
}

/** 扫描失败：界面要说清楚是"读不出来"而不是"你还没选"。 */
export function scanFailed(state: ValuationPageState, error: string): MutationResult {
  return accept(state, { scanState: 'failed', scanError: error })
}

/** 改方法。 */
export function setMethod(state: ValuationPageState, method: ValuationMethod): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  return accept(state, { method })
}

/**
 * 改基准日。
 *
 * 只接受空串或 `YYYY-MM-DD`：其余一律拒绝而不是"尽量解析" —— 基准日错一天，
 * 交易日期修正与收益年限都跟着错，而那是看不出来的。
 */
export function setBaseDate(state: ValuationPageState, baseDate: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  const value = text(baseDate).trim()
  if (value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return refuse(state, zhCN.valuationBaseDateShape)
  return accept(state, { baseDate: value })
}

/** 改补充提示词。 */
export function setSupplementalPrompt(state: ValuationPageState, prompt: string): MutationResult {
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  return accept(state, { supplementalPrompt: text(prompt) })
}

/**
 * 开始提取（"检查并确认" → 抽屉之前的第一步）。
 *
 * `requestId` 由调用方传进来（控制器按单调递增发号）：它写在 state 上，迟到的响应
 * 一比就知道自己是不是当前那一次。
 */
export function beginIntake(state: ValuationPageState, requestId: number): MutationResult {
  if (state.selection.length === 0) return refuse(state, zhCN.valuationNeedFiles)
  if (!canEditInputs(state.phase)) return refuse(state, inputLockedReason(state.phase))
  return accept(state, {
    phase: 'extracting',
    intakeRequestId: requestId,
    intakeStage: '',
    error: '',
    intake: null,
  })
}

/**
 * 提取阶段推进（宿主报的真实阶段）。
 *
 * 只认**当前请求**的阶段：换了一次请求（重新提取）之后旧请求的阶段不能改这一轮的显示。
 */
export function intakeStage(state: ValuationPageState, requestId: number, stage: string): MutationResult {
  if (state.phase !== 'extracting') return refuse(state, zhCN.valuationNotInConfirmation)
  if (requestId !== state.intakeRequestId) return refuse(state, zhCN.valuationStaleIntake)
  return accept(state, { intakeStage: text(stage) })
}

/** 提取失败：**保留**资料、方法、基准日与补充要求（用户改一句再试，不必重选一遍）。 */
export function intakeFailed(state: ValuationPageState, error: string): MutationResult {
  return accept(state, {
    phase: 'failed',
    error,
    // 失败阶段 = 宿主最后报过的那个阶段（客户端不猜）。清掉 intakeStage，但把它留给
    // `failedStage`，界面因此能说"在「正在提取文件内容」这一步失败"。
    failedStage: state.intakeStage,
    intakeStage: '',
    progress: { stage: '', detail: '', completed: 0, total: 0 },
  })
}

/**
 * 部分结果（§4「部分结果」）。
 *
 * 轮次没跑完（失败 / 取消），但已经有交付件产出：把宿主给的那份结果落下来，
 * **阶段保持不变** —— 它不是 `completed`，结果页会以此打上"阶段结果"的标记、
 * 不制造"已给出正式结论"的观感。
 */
export function applyPartialResult(state: ValuationPageState, result: ValuationResultView): MutationResult {
  return accept(state, { result, error: state.error })
}

/** 交付件存在性落地（宿主事实）。 */
export function applyArtifacts(
  state: ValuationPageState,
  artifacts: { html: boolean; xlsx: boolean; json: boolean },
): MutationResult {
  return accept(state, { artifacts: { ...artifacts } })
}

/** 已经产出**至少一件**交付件（"部分结果"的判据之一）。 */
export function hasAnyArtifact(state: ValuationPageState): boolean {
  return state.artifacts.html || state.artifacts.xlsx || state.artifacts.json
}

/**
 * 提取超时：同样是可恢复的失败，但说明**等待**结束了、宿主可能还在跑。
 *
 * 不谎称"宿主已停止"：客户端就是不再等它了，那一轮要不要继续由用户在宿主侧决定。
 */
export function intakeTimedOut(state: ValuationPageState): MutationResult {
  return accept(state, {
    phase: 'failed',
    error: zhCN.valuationIntakeTimeout,
    intakeStage: '',
    progress: { stage: '', detail: '', completed: 0, total: 0 },
  })
}

/** 「取消提取」：回到可编辑的草稿态，**保留**资料与补充要求。 */
export function cancelIntake(state: ValuationPageState): MutationResult {
  if (state.phase !== 'extracting') return refuse(state, zhCN.valuationNotExtracting)
  return accept(state, {
    phase: 'draft',
    intakeRequestId: 0,
    intakeStage: '',
    error: '',
    intake: null,
  })
}

/**
 * 提取完成 → 打开只读确认抽屉。
 *
 * **不创建估值会话**：抽屉只是让人核对，确认那一步才动会话（方案 §5.4）。
 */
export function intakeReady(state: ValuationPageState, intake: ValuationIntakeView): MutationResult {
  return accept(state, {
    phase: 'confirmation',
    intake,
    valuationId: intake.valuationId || state.valuationId,
    casePath: intake.casePath,
    method: isValuationMethod(intake.method) ? intake.method : state.method,
    // 提取结束：阶段文字收掉，抽屉里的东西才是现在的事实。
    intakeStage: '',
    scanState: 'ready',
    // 来源探测**还没开始**（§11.2）：先把宿主给的三行落下来（状态一律"尚未检查"），
    // 探测由控制器随后异步发起。先落下来是为了让"探测失败"也能逐家写出「无法检查」。
    providerCheck: intake.providers.length === 0 ? 'idle' : 'checking',
    providerStates: Object.fromEntries(intake.providers.map((item) => [item.id, {
      state: item.state === '' ? 'unknown' : item.state, attempts: 0, detail: item.detail,
    }])),
    providerLoginUrls: Object.fromEntries(intake.providers.flatMap((item) => (
      item.loginUrl === undefined || item.loginUrl === '' ? [] : [[item.id, item.loginUrl]]
    ))),
    error: '',
  })
}

/** 外部来源预检的结论落地（逐家更新，不影响资料确认信息）。 */
export function providerCheckReady(
  state: ValuationPageState,
  providers: readonly ValuationProviderView[],
): MutationResult {
  if (providers.length === 0) return accept(state, { providerCheck: 'done' })
  return accept(state, {
    providerCheck: 'done',
    providerStates: Object.fromEntries(providers.map((item) => [item.id, {
      state: item.state, attempts: 0, detail: item.detail,
    }])),
    providerLoginUrls: {
      ...state.providerLoginUrls,
      ...Object.fromEntries(providers.flatMap((item) => (
        item.loginUrl === undefined || item.loginUrl === '' ? [] : [[item.id, item.loginUrl]]
      ))),
    },
  })
}

/** 外部来源预检失败：如实记下来（不谎称"已登录"），抽屉里那几行显示"无法检查"。 */
export function providerCheckFailed(state: ValuationPageState, error: string): MutationResult {
  return accept(state, {
    providerCheck: 'done',
    providerStates: Object.fromEntries(Object.keys(state.providerStates).map((id) => [id, {
      state: 'unknown', attempts: 0, detail: error,
    }])),
  })
}

/** 「返回修改」：回到表单，并**丢掉**上一次的确认数据（要重新生成快照）。 */
export function backToEdit(state: ValuationPageState): MutationResult {
  if (state.phase !== 'confirmation') return refuse(state, zhCN.valuationNotInConfirmation)
  return resetToDraft(state)
}

/**
 * 「取消」：从任何阶段回到取消态。
 *
 * `extracting` 也是可取消的（§11.4）：那一步会同时作废在途的提取请求，
 * 所以这里一并把 `intakeRequestId` 清掉 —— 旧响应回来时对不上号，自然被丢掉。
 */
export function cancelValuation(state: ValuationPageState): MutationResult {
  if (state.phase === 'completed') return refuse(state, zhCN.valuationAlreadyCompleted)
  return accept(state, { phase: 'cancelled', error: '', intakeRequestId: 0, intakeStage: '' })
}

/** 返回可编辑的草稿态并作废在途请求（「返回修改」「重新提取」共用）。 */
export function resetToDraft(state: ValuationPageState): MutationResult {
  return accept(state, {
    phase: 'draft',
    intake: null,
    intakeRequestId: 0,
    intakeStage: '',
    error: '',
  })
}

/** 这次响应是不是当前请求的（迟到的响应必须被丢掉）。 */
export function isCurrentIntake(state: ValuationPageState, requestId: number): boolean {
  return requestId !== 0 && state.intakeRequestId === requestId
}

/** 「确认并开始估值」：确认后输入冻结，页面转入自动运行。 */
export function confirmAndStart(state: ValuationPageState, patch: { sessionId?: string; casePath?: string; digest?: string } = {}): MutationResult {
  if (state.phase !== 'confirmation' || state.intake === null) return refuse(state, zhCN.valuationNotInConfirmation)
  return accept(state, {
    phase: 'queued',
    sessionId: text(patch.sessionId) || state.sessionId,
    casePath: text(patch.casePath) || state.casePath,
    error: '',
    progress: { stage: zhCN.valuationStageQueued, detail: '', completed: 0, total: 4 },
  })
}

export interface StatusPatch {
  phase: ValuationPhase
  artifacts?: { html: boolean; xlsx: boolean; json: boolean }
  progress?: ValuationProgressView
  providerStates?: Record<string, { state: string; attempts: number; detail: string }>
  sessionId?: string
  casePath?: string
  error?: string
  needsLogin?: readonly string[]
}

/**
 * 落地一次 Host 状态。
 *
 * `stale-host` **不覆盖**：协议不匹配时页面停在过期态，直到用户重启（那时任何进度都不可信）。
 */
export function applyStatus(state: ValuationPageState, patch: StatusPatch): MutationResult {
  if (state.phase === 'stale-host') return refuse(state, zhCN.valuationPhaseStale)
  // 提取阶段：宿主报的阶段就是进度区的文案（客户端不自己编，见 `intakeStage` 的说明）。
  const stage = patch.phase === 'extracting' ? text(patch.progress?.stage) : ''
  return accept(state, {
    phase: patch.phase,
    intakeStage: stage,
    artifacts: patch.artifacts ?? state.artifacts,
    progress: patch.progress ?? state.progress,
    providerStates: patch.providerStates ?? state.providerStates,
    sessionId: text(patch.sessionId) || state.sessionId,
    casePath: text(patch.casePath) || state.casePath,
    // 失败原因**不因为一次轮询就丢掉**：宿主在 `failed` 时会回 `recordError`，但其它阶段
    // 不回这个字段 —— 无条件覆盖会把用户刚看到的失败原因擦掉（界面只剩"原因见下"而没有原因）。
    // 所以：宿主给了就用宿主的；没给就保留上一份；只有走到 `completed` 才清。
    error: text(patch.error) !== '' ? text(patch.error) : (patch.phase === 'completed' ? '' : state.error),
    needsLogin: patch.needsLogin === undefined ? [] : patch.needsLogin.map((item) => text(item)),
  })
}

/** 协议代数不匹配 → 整页进入 `stale-host`。 */
export function markHostStale(state: ValuationPageState): ValuationPageState {
  return { ...state, phase: 'stale-host', error: zhCN.valuationPhaseStale }
}

/** 结果落地。 */
export function applyResult(state: ValuationPageState, result: ValuationResultView): MutationResult {
  return accept(state, { phase: 'completed', result, error: '', failedStage: '' })
}

/** 抽屉里的只读行（键 / 值 / 是否缺失）。 */
export interface FieldRow {
  key: string
  label: string
  value: string
  missing: boolean
}

/** 页面与抽屉共用的 12 个估值要素（顺序固定，与 `references/09` 一致）。 */
export const VALUATION_FIELD_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '坐落', label: zhCN.valuationFieldAddress },
  { key: '房屋性质', label: zhCN.valuationFieldNature },
  { key: '用途', label: zhCN.valuationFieldPurpose },
  { key: '建筑面积', label: zhCN.valuationFieldArea },
  { key: '楼层', label: zhCN.valuationFieldFloor },
  { key: '总楼层', label: zhCN.valuationFieldTotalFloors },
  { key: '建筑结构', label: zhCN.valuationFieldStructure },
  { key: '建成年代', label: zhCN.valuationFieldBuiltYear },
  { key: '权属信息', label: zhCN.valuationFieldOwnership },
  { key: '租赁信息', label: zhCN.valuationFieldLease },
  { key: '价格信息', label: zhCN.valuationFieldPrice },
  { key: '已知案例线索', label: zhCN.valuationFieldCases },
]

/**
 * 抽屉里的要素行。
 *
 * `missing` 由**值是否为空**判定，而不是由 Host 的 `missingFields` 决定 ——
 * 后者是 Host 的判据（可能因为提取器不同而不同），界面显示的是"这一行有没有内容"。
 */
export function fieldRowsOf(extractedFields: Record<string, string>): FieldRow[] {
  return VALUATION_FIELD_LABELS.map(({ key, label }) => {
    const value = text(extractedFields[key])
    return { key, label, value, missing: value === '' }
  })
}

/**
 * 规则校验摘要（§9 第 3 条）：按规则 ID 汇总"几条通过、几条没通过"，并给出组内比值。
 *
 * 结果页要有这一段，而不是只写"案例 3 条" —— 读者要一眼看到
 * 「这三条案例按哪几条规则查过、有没有没过的」。没过的规则**列出来**（不藏）。
 */
export function ruleCheckSummary(cases: ValuationResultView['cases']): {
  total: number
  adopted: number
  rows: Array<{ ruleId: string; passed: number; failed: number; thresholds: number[] }>
  groupRatio: number | null
  groupOverLimit: boolean
} {
  const rows = new Map<string, { ruleId: string; passed: number; failed: number; thresholds: number[] }>()
  let groupRatio: number | null = null
  let groupOverLimit = false
  for (const item of cases) {
    for (const check of item.ruleChecks) {
      if (check.ruleId === '') continue
      const row = rows.get(check.ruleId) ?? { ruleId: check.ruleId, passed: 0, failed: 0, thresholds: [] }
      if (check.verdict === 'pass') row.passed += 1
      if (check.verdict === 'fail') row.failed += 1
      if (check.threshold !== null && !row.thresholds.includes(check.threshold)) row.thresholds.push(check.threshold)
      rows.set(check.ruleId, row)
      if (check.ruleId === 'R-GROUP-1.2' && check.actual !== null) {
        groupRatio = check.actual
        groupOverLimit = check.verdict === 'fail'
      }
    }
  }
  return {
    total: cases.length,
    adopted: cases.filter((item) => item.usedAsComparable).length,
    rows: [...rows.values()],
    groupRatio,
    groupOverLimit,
  }
}

/**
 * 按**来源**汇总案例（§9 第 3 条：最终采用案例的**数量与来源**）。
 *
 * 只给一个总数看不出"结论压在几个站点上"：全押在一个站点、或某个站点一条都没取到，
 * 都是复核时要先知道的事。
 */
export function caseSourceSummary(cases: ValuationResultView['cases']): Array<{
  source: string
  label: string
  total: number
  adopted: number
}> {
  const rows = new Map<string, { source: string; label: string; total: number; adopted: number }>()
  for (const item of cases) {
    const key = item.source === '' ? item.sourceLabel : item.source
    if (key === '') continue
    const row = rows.get(key) ?? { source: item.source, label: item.sourceLabel || item.source, total: 0, adopted: 0 }
    row.total += 1
    if (item.usedAsComparable) row.adopted += 1
    // 展示名以**非空**的那个为准（有的来源只有 id）。
    if (row.label === '' || row.label === row.source) row.label = item.sourceLabel || row.label
    rows.set(key, row)
  }
  return [...rows.values()]
}

/** 案例表：拣出可直接作可比实例的（成交）与需要修正的（挂牌 / 询价 / 未知）。 */
export function caseBuckets(cases: ValuationResultView['cases']): {
  comparable: ValuationResultView['cases']
  listed: ValuationResultView['cases']
} {
  return {
    comparable: cases.filter((item) => item.usedAsComparable),
    listed: cases.filter((item) => !item.usedAsComparable),
  }
}

/**
 * 证据完整不完整（§9：证据不完整时不得制造"已给出正式结论"的观感）。
 *
 * 三种不完整：① 交付件缺件；② 有采用案例明确没留存证据；③ 宿主报了阻塞性能力缺口。
 * 这是**界面判据**，不是完成判定（完成判定在宿主侧，见 `valuation-status`）。
 */
export function evidenceIncomplete(result: ValuationResultView): boolean {
  if (!result.artifacts.html || !result.artifacts.xlsx || !result.artifacts.json) return true
  if (result.cases.some((item) => item.usedAsComparable && (item.evidence === '' || item.evidenceMissing))) return true
  return result.capabilityGaps.length > 0
}

/** 交付件齐不齐（结果页据此决定"能不能收工"）。 */
export function artifactsComplete(artifacts: { html: boolean; xlsx: boolean; json: boolean }): boolean {
  return artifacts.html && artifacts.xlsx && artifacts.json
}
