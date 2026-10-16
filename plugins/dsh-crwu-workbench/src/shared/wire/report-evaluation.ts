import type {
  CreationDisposition,
  HostValuationPhase,
  LoginJobView,
  ScanFileView,
  SiteRowView,
  ValuationHandoffView,
  ValuationPagePhase,
  ValuationPreviewView,
} from '../contracts/report-evaluation.ts'

/**
 * 报告评估（房地产估值，协议 35）的**编译期线协议契约**。
 *
 * ## 这里能查什么、不能查什么
 *
 * 能查的：Client 侧读到的字段名与取值集合（页面阶段、来源状态、登录任务状态）与线协议一致。
 * **不能**查的：Host 侧的内部记录类型直接赋给这些视图 —— 那不是线协议形状。所以那一侧由
 * Host 自己的测试钉住，这里只钉"两端都认同一套词"。
 */

/**
 * Host 轮次的阶段词（**不上线**，但两侧仍是同一套词）。
 *
 * v1 线协议曾把它搬上页面（协议 32），于是页面必须跟着轮次走、面板还得持有估值专用轮询。
 * 协议 35 起页面只认 `VALUATION_PAGE_PHASES`；这一份留着是为了让 Host 轮次与页面阶段
 * 的差异**写在明处**（谁把轮次词再搬回页面，这条断言不会红，但两侧词表就在这里对照着）。
 */
export const VALUATION_PHASES: readonly HostValuationPhase[] = [
  'draft', 'extracting', 'confirmation', 'queued', 'running',
  'browser-login-required', 'completed', 'failed', 'cancelled', 'stale-host',
]

/**
 * 页面的阶段词：**只有这些**（多一个少一个都会在这里红）。
 *
 * 协议 39 起删掉了 `checking-auth` / `auth-blocked`：登录不再是门禁，"进页面先等一次检查"
 * 这个阶段本身就不该存在（进页面直接是草稿，能力状态在能力区与确认抽屉里各自更新）。
 */
export const VALUATION_PAGE_PHASES: readonly ValuationPagePhase[] = [
  'draft', 'preparing-confirmation',
  'confirmation', 'creating-session', 'handoff-failed', 'handed-off', 'stale-host',
]

/** 来源登录状态：只有这三态（`unknown` 是"查不出来"，不能显示成"已登录"或"没登录"）。 */
export const VALUATION_SITE_STATES: readonly string[] = ['authenticated', 'unauthenticated', 'unknown']

/** 登录任务状态。 */
export const VALUATION_LOGIN_JOB_STATES: readonly string[] = [
  'running', 'succeeded', 'failed', 'cancelled', 'waiting-user',
]

/**
 * 交接的创建判据（协议 37）：只有这三种。
 *
 * 界面必须按它分派恢复动作 —— `not-created` 才允许「返回修改」，`created` 只能重试交接 /
 * 打开会话，`unknown` 只能恢复同一轮交接。Client 自己从"没有 sessionId"推断未创建是禁止的。
 */
export const VALUATION_CREATION_DISPOSITIONS: readonly CreationDisposition[] = [
  'not-created', 'created', 'unknown',
]

/** 扫描回来的真实文件行：`path` 是面板本地回显口径，归档摘要里不含它。 */
export const SCAN_FILE_SHAPE: (file: ScanFileView) => ScanFileView = (file) => file

/** 交易性质：只有这四种，界面按它分桶（成交才允许作可比实例）。 */
export const VALUATION_TRANSACTION_TYPES: readonly string[] = ['挂牌', '成交', '询价', '未知']

/** 方法：结论侧只有三种（`auto` 是用户输入，不是结论）。 */
export const VALUATION_CONCLUSION_METHODS: readonly string[] = ['market', 'income', 'cost']

/**
 * 可选的**资产类型**（协议 39）。
 *
 * 与宿主 `ASSET_TYPES` 同一份集合：界面下拉的选项、Host 的装配判据、冻结输入里的取值
 * 三者必须是同一个枚举。首期只有房地产。
 */
export const VALUATION_ASSET_TYPES: readonly string[] = ['real-estate']

/**
 * 资产类型**不许有默认值**（协议 39）。
 *
 * 与 `PREVIEW_KEEPS_NULL_BUSINESS_INPUTS` 同一类语义提醒：`assetType === ''` 是**未选择**，
 * 它必须一路保持"未选择"直到用户主动选 —— 谁要是把它默认成 `real-estate`，
 * 类型系统不会拦（都是合法字符串），但状态机单测与 Host 预览用例会。
 */
export const ASSET_TYPE_IS_NOT_DEFAULTED: (value: string) => string = (value) => value

/**
 * 能力状态是**带时刻的事实**，不是门禁（协议 39）。
 *
 * `AuthGateView.checkedAt` 为空串表示"旧宿主 / 还没查过" —— 界面不许把它当成"已检查且正常"。
 */
export const CAPABILITY_IS_A_TIMED_FACT: (checkedAt: string) => string = (checkedAt) => checkedAt

/** 逐站展示行必须同时带必需/可选与人话状态（界面直接显示后者，不再自己映射）。 */
export const SITE_ROW_SHAPE: (row: SiteRowView) => SiteRowView = (row) => row

/** 登录任务视图：`running` 时 `finishedAt` 必须是 `null`（界面据此说"正在登录"）。 */
export const LOGIN_JOB_SHAPE: (job: LoginJobView) => LoginJobView = (job) => job

/**
 * 创建时间**不许**被 mtime 顶替。
 *
 * 这条不是形状检查（`string | null` 本来就允许 null），而是**语义提醒**：
 * `birthtime` 不可用时必须留 `null`，界面显示"创建时间未知"。谁要是把 mtime 填进
 * `createdAt`，类型系统不会拦 —— 只有这条注释、确认抽屉的用例和 Host 侧用例会。
 */
export const PREVIEW_KEEPS_NULL_CREATED_AT: (view: ValuationPreviewView) => ValuationPreviewView = (view) => view

/**
 * 未指定的**业务前提**必须保持 `null`（协议 38）。
 *
 * 与创建时间同一种语义提醒：`purpose` / `valueType` / `baseDate` 的 `null` 是**未指定**，
 * 不是空串、更不是"某个默认的正式结论"。谁把 `null` 归一成空串（或反过来填一个默认值），
 * 类型系统不会拦 —— 只有这条注释、确认抽屉的用例与 Host 侧冻结输入用例会。
 */
export const PREVIEW_KEEPS_NULL_BUSINESS_INPUTS: (view: ValuationPreviewView) => ValuationPreviewView = (view) => view

/** 交接回执：`dispatchAccepted === false` 时 `parentSessionId` 可能非空（重试要发回同一个会话）。 */
export const HANDOFF_KEEPS_SESSION: (view: ValuationHandoffView) => ValuationHandoffView = (view) => view

/**
 * 交接回执的**创建判据**（协议 37）。
 *
 * 与 `HANDOFF_KEEPS_SESSION` 同一类语义提醒：`parentSessionId === ''` **不**等于未创建
 * （回执可能丢在路上），所以"能不能返回修改"只认这一个字段。谁要是用它之外的东西推断，
 * 类型系统不会拦 —— 状态机单测与失败屏用例会。
 */
export const HANDOFF_KEEPS_DISPOSITION: (view: ValuationHandoffView) => ValuationHandoffView = (view) => view
