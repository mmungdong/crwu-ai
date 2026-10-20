/**
 * 报告评估（房地产估值，协议 35）的**线协议类型**。
 *
 * ## 这一层存在的理由
 *
 * 两侧要就同一批字段达成一致：Host 的六个操作回什么、Client 的页面读什么。
 * 定义在 Host 的 domain 里会让 Client 反向依赖 Host（打包形态上根本不可能），
 * 定义在 Client 里则会让 Wire 层的契约检查反向依赖 Client —— 这一层**两端都不依赖，
 * 只被两端依赖**。
 *
 * ## 协议 35 起：线协议里不再有"轮次阶段"
 *
 * 32 代那一版把 Host 的轮次阶段（`draft` / `extracting` / …）直接搬到了客户端页面上，
 * 于是页面必须**跟着轮次走**才能显示对（面板还得为此持有估值专用轮询）。这一代把两件事分开：
 *
 * - Host 侧仍然有轮次（lifecycles，父会话执行用），但**不上线**；
 * - 页面自己的阶段是 `ValuationPagePhase` —— 它只回答"这一页现在该画什么"。
 *
 * 字段名与取值的事实源在 Host 一侧（`domains/report-evaluation/`）与
 * `skills/biz/crwu-biz-valuation-realestate/references/09-output-contract.md`；
 * 这里只声明**线上形状**。
 */

/** 用户可选的评估方法：必须是一个**指定**方法，没有「自动判定」这一档。 */
export type ValuationMethod = 'market' | 'income' | 'cost'

/**
 * Host 轮次的阶段（`domains/report-evaluation/lifecycle`）。
 *
 * ⚠️ 它**不在**这一代的线协议里：页面只认 `ValuationPagePhase`。保留这个类型是为了让两侧
 * 继续对同一套词（Host 的轮次记录、冻结清单、Host 侧用例都从它派生），而不是各写一套。
 */
export type HostValuationPhase =
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

/**
 * 估值启动页自己的阶段（协议 39 · 设计稿 §3）。
 *
 * 它只描述"页面在干什么"：草稿、准备确认、确认、建会话、交接结果。
 * **没有门禁阶段**：案例来源登录从协议 39 起是可选能力，未登录 / 未知 / 该站失败都不拦页面。
 */
export type ValuationPagePhase =
  | 'draft'
  | 'preparing-confirmation'
  | 'confirmation'
  | 'creating-session'
  | 'handoff-failed'
  | 'handed-off'
  | 'stale-host'

/** 一个来源的登录状态三态（`unknown` 是"查不出来"，不是"没登录"）。 */
export type SiteAuthState = 'authenticated' | 'unauthenticated' | 'unknown'

/**
 * 一次人工登录任务的状态。
 *
 * `waiting-user` = **登录凭据已到位，但受保护页要人机验证**：登录本身成功了，缺的是
 * 员工在可见窗口里过掉那一次验证。它**不是** `failed`（那会告诉员工"你没登录成功"）。
 */
export type LoginJobState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting-user'

/** 逐站的权威登录结论（`valuation-browser-preflight` 的 `sites[]`）。 */
export interface SiteStatusView {
  siteId: string
  label: string
  state: SiteAuthState
  reason: string
  /** 受保护页的页面判定（ok / login-wall / captcha / blocked）；未读页面时为空。 */
  verdict: string
  /** 受保护页地址（公开配置）：需要人工过验证时打开它。 */
  protectedUrl: string
  /** 凭据到期时间（RFC3339）；会话 cookie 时为空。 */
  expiresAt: string
  /** 凭据没有自己的到期时间（关掉浏览器即失效）。 */
  sessionCookie: boolean
}

/**
 * 一个来源这一次检查里做过的挑战处置。
 *
 * 为什么它必须与"登录状态"分开：受保护页给人机验证时，员工**已经登录**了，
 * 需要的是"去那个窗口完成验证"，而不是重新登录一遍。
 */
export interface SiteChallengeView {
  detected: boolean
  /** 已经做过一次有界自动尝试（预算由宿主管理，重复点击不会重置）。 */
  attempted: boolean
  /** 自动尝试的结论（recovered / waiting-user / unsupported / failed / unavailable…）。 */
  state: string
  reasonCode: string
  /** 员工可以在可见窗口里完成验证的页面。 */
  verifyUrl: string
}

/** 逐站展示行：在 `SiteStatusView` 上加"必需/可选"、人话状态与挑战处置。 */
export interface SiteRowView extends SiteStatusView {
  required: boolean
  stateLabel: string
  challenge?: SiteChallengeView
}

/**
 * 能力（案例来源）状态结论（Host 推一次，页面只渲染）。
 *
 * ## 协议 39 起它不再是「门禁」
 *
 * 旧语义是：必需来源没全部 `authenticated` → 正文不可进入。新语义是：**它只是一次检查的
 * 事实快照** —— 未登录 / 未知 / 该站失败都不阻止填写与启动，父会话拿到的来源策略里会带原因。
 * `released` 保留是为了让旧宿主 / 旧用例读得到同一个字段，但**不再参与任何禁用判据**。
 */
export interface AuthGateView {
  /** ⚠️ 保留字段：**不再**是"能不能进正文"的判据（协议 39 起登录是可选用能力）。 */
  released: boolean
  /** 已确认为可用的来源（只是事实，不是放行条件）。 */
  required: string[]
  /** 只展示、不阻塞的来源。 */
  optional: string[]
  /** 一句话说明现在这些来源是什么状态。 */
  reason: string
  /** 连"检查"都没做成（清单读不出来 / 浏览器不可用）→ 界面给"重新检查"。 */
  unavailable: boolean
  /**
   * 这次检查的**时刻**（RFC3339）。
   *
   * 它是"运行初始事实"：检查过了不等于整轮始终可用，所以时间必须跟着结论一起走。
   * 旧宿主不回它 → 空串（界面显示"检查时间未知"，不编一个）。
   */
  checkedAt: string
}

/** 一次人工登录任务（可查询、可取消）。 */
export interface LoginJobView {
  jobId: string
  siteId: string
  state: LoginJobState
  /** 毫秒时间戳（`finishedAt` 为 `null` = 还在跑）。 */
  startedAt: number
  finishedAt: number | null
  /** 给人看的一句话（失败原因 / 已确认状态）。 */
  detail: string
  /** 权威 `status` 的逐站结果；登录结束前为空数组。 */
  sites: SiteStatusView[]
  /** 登录命令自身的退出事实。**不代表**登录成功。 */
  commandOk: boolean
  /** 本次任务里跑过几次挑战恢复辅助。 */
  recoveryAttempts: number
}

/** `valuation-browser-preflight` 的应答（**能力状态**的唯一数据源；不再阻断页面）。 */
export interface ValuationPreflightView {
  ok: boolean
  error: string
  sites: SiteStatusView[]
  rows: SiteRowView[]
  gate: AuthGateView
  loginJobs: LoginJobView[]
  opened: boolean
  openError: string
}

/** `valuation-browser-login` 的应答（`reused: true` = 复用正在跑的那一条）。 */
export interface ValuationLoginView {
  ok: boolean
  error: string
  jobId: string
  reused: boolean
  job: LoginJobView | null
}

/**
 * `valuation-browser-open-verification` 的应答（协议 37）。
 *
 * `opened: true` 只说明"受控窗口已经打开"，**不说明验证已经完成** —— 验证完成与否只由下一次
 * `valuation-browser-preflight` 的逐站结论回答。界面因此不能把 `opened` 当成功。
 */
export interface ValuationVerificationView {
  ok: boolean
  error: string
  opened: boolean
  siteId: string
}

/**
 * 一个选择入口展开后的**真实文件**（协议 37）。
 *
 * 为什么必须单独回一份：`items[]` 是"用户选中的入口"（文件夹只带一个份数），而员工要核对的
 * 是**具体哪几份文件**，也只有在文件这一层才能逐个移除。`path` 是员工机器上的绝对路径，
 * 只回显给面板，**不进归档摘要、不进模型输入**。
 */
export interface ScanFileView {
  /** 本机绝对路径（面板本地回显；也是 `excludedPaths` 的回传口径）。 */
  path: string
  name: string
  kind: string
  sizeBytes: number
  /** 它属于哪个已选入口（该入口的绝对路径）。 */
  parentPath: string
}

/** 扫描时被跳过的条目（符号链接 / 特殊文件 / 权限不足），带原因。 */
export interface ScanSkippedView {
  path: string
  name: string
  reason: string
}

/**
 * `valuation-files-scan` 的应答（协议 37）。
 *
 * `items[]` 是入口层事实，`files[]` 是**递归去重后的真实文件**；两者必须来自同一次扫描，
 * 否则界面上的"纳入 N 份"和真正会归档的份数会对不上。
 */
export interface ValuationScanView {
  ok: boolean
  error: string
  errorKind: string
  items: unknown[]
  files: ScanFileView[]
  skipped: ScanSkippedView[]
  fileCount: number
  readableCount: number
  skippedCount: number
  overLimit: boolean
  /** 枚举被安全上限截断（误选巨型目录）：界面要如实说"清单未完整读取"并禁止确认。 */
  truncated: boolean
  limit: number
}

/**
 * 交接的**权威创建判据**（协议 37）。
 *
 * `not-created` 只允许在"Host 确认本次处理已终止且没有已建/在途会话"时给出；
 * 网络超时、回执丢失与未知异常一律 `unknown` —— Client **无权**把未知改成未创建，
 * 否则"返回修改"会造出第二个项目目录。
 */
export type CreationDisposition = 'not-created' | 'created' | 'unknown'

/**
 * 一份归档资料的元信息（确认抽屉逐行显示的那一份）。
 *
 * `absolutePath` 是**唯一**回显给面板的绝对路径：它不进确认摘要、不进冻结输入、
 * 不进交接指令、不进报告（设计稿 §5 / §11.1）。
 */
export interface ArchivedMaterialView {
  /** 稳定标识：同一批里唯一（同名不同路径也能分辨）。 */
  fileId: string
  fileName: string
  /** 源文件在员工机器上的原始绝对路径。**只回显给面板**。 */
  absolutePath: string
  /** 归档副本相对项目目录的路径（唯一、已去重）。 */
  archiveRelativePath: string
  kind: string
  sizeBytes: number
  /** **归档副本**的字节指纹（复制后重算）。 */
  sha256: string
  /** 创建时间；`birthtime` 不可靠时是 `null`（界面显示"创建时间未知"，不许拿 mtime 冒充）。 */
  createdAt: string | null
  modifiedAt: string | null
  readable: boolean
  /** 内容与本批另一份相同时填对方的 `fileId`。 */
  duplicateOf: string | null
}

/** `valuation-intake` 的应答：确认抽屉的数据源（**不提取、不联网、不拉知识**）。 */
export interface ValuationPreviewView {
  ok: boolean
  errorKind: string
  error: string
  requestId: string
  previewId: string
  projectId: string
  casePath: string
  /** 确认摘要：交接时必须**逐字**回传。 */
  inputDigest: string
  /**
   * 用户选定的**资产类型**（协议 39）。
   *
   * 它是通用入口的第一个选择，也是装配哪个 Skill / 哪份入口 Wiki 的唯一依据；
   * 未选时 Host 直接拒绝预览（不存在"默认房地产"这一档）。
   */
  assetType: string
  methodRequest: string
  baseDate: string | null
  /** 评估目的；**未指定是 `null`**（协议 38）—— 界面与报告都按"未指定"呈现。 */
  purpose: string | null
  /** 价值类型；未指定是 `null`。可选取值清单待业务方确认，线协议不写死枚举。 */
  valueType: string | null
  /**
   * `valuation-intake` 提交的**计算表模板**归档后的 fileId（协议 43）。
   *
   * 未选模板是 `null`。它由 Host 按 canonical 路径与本次扫描候选绑定，客户端只回显
   * `files[]` 里那一份；不拿草稿里的路径冒充已归档事实。
   */
  templateFileId: string | null
  supplementalPrompt: string
  files: ArchivedMaterialView[]
  fileCount: number
  overLimit: boolean
  skipped: string[]
  capabilityGaps: string[]
  createdAt: string
  expiresAt: string
}

/** `valuation-start` 的应答：一次幂等的父会话交接。 */
export interface ValuationHandoffView {
  ok: boolean
  errorKind: string
  error: string
  projectId: string
  parentSessionId: string
  /** 固定指令是否已经被受理（false = 会话已建但指令没发出去，重试要发回同一个会话）。 */
  dispatchAccepted: boolean
  /** 同一 requestId / previewId 已经交接成功过 → true。 */
  reused: boolean
  /**
   * Host 的权威创建判据（协议 37）：只有它说 `not-created`，界面才允许「返回修改」。
   * 缺字段按 `unknown` 处理 —— 类默认值偏向"不许回草稿"。
   */
  creationDisposition: CreationDisposition
  /**
   * 失败后的**可执行恢复动作**（可选、封闭取值）：
   * - `refresh-preview`：预览过期/丢失且**没有**已建父会话 —— 返回修改并重新准备确认；
   * - `retry-handoff`：父会话已建、指令未受理 —— 对同一条会话重试交接。
   * 缺省表示界面按 `creationDisposition` 的通用分支处理。
   */
  recoveryAction?: 'refresh-preview' | 'retry-handoff'
}
