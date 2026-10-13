/**
 * 报告评估（房地产估值，协议 32）的**线协议类型**。
 *
 * ## 为什么这些类型必须在这里，而不是在 Host 的 domain 里
 *
 * 两侧要就同一批字段达成一致：Host 的八个操作回什么、Client 的页面读什么。
 * 定义在 Host 的 domain 里会让 Client 反向依赖 Host（打包形态上根本不可能），
 * 定义在 Client 里则会让 Wire 层的契约检查反向依赖 Client —— 这一层存在的意义
 * 就是**两端都不依赖，只被两端依赖**。
 *
 * 字段名与取值的事实源在 Host 一侧（`domains/report-evaluation/`）与
 * `skills/biz/crwu-biz-valuation-realestate/references/09-output-contract.md`；
 * 这里只声明**线上形状**。
 */

/** 页面 / 轮次的阶段。`stale-host` 只由客户端在协议代数不匹配时给出。 */
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

/** 用户可选的评估方法；`auto` 是**输入**，结论里只会出现 market / income / cost。 */
export type ValuationMethod = 'auto' | 'market' | 'income' | 'cost'

/** 交付件存在性（三件套）。 */
export interface ValuationArtifactPresence {
  html: boolean
  xlsx: boolean
  json: boolean
}

/** 一轮估值的进度（`total <= 0` 表示宿主没给总数，界面据此不画进度条）。 */
export interface ValuationProgressView {
  stage: string
  detail: string
  completed: number
  total: number
}

/** 一个外部来源的运行状态。 */
export interface ValuationProviderStateView {
  state: string
  attempts: number
  detail: string
}

/** 输入清单里的一份资料（`status` 为 `parsed` / `unparsed`）。 */
export interface ValuationFileView {
  fileName: string
  relativePath: string
  kind: string
  sizeBytes: number
  sha256?: string
  status: string
  fieldCount?: number
  note: string
}

/** 知识来源（`source` 只能是 `dws` 或 `local`；缺失只能出现在能力缺口里）。 */
export interface ValuationKnowledgeSourceView {
  route: string
  source: string
  updatedAt: string
  digest: string
}

/** 知识库状态。 */
export interface ValuationKnowledgeView {
  space: string
  ready: boolean
  sources: ValuationKnowledgeSourceView[]
  gaps: string[]
}

/** 外部来源预检的一行。 */
export interface ValuationProviderView {
  id: string
  label: string
  state: string
  stateLabel: string
  detail: string
  captcha?: boolean
  loginUrl?: string
}

/** `valuation-intake` 的应答（确认抽屉的数据源）。 */
export interface ValuationIntakeView {
  ok: boolean
  errorKind: string
  error: string
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
}

/** `valuation-status` 的应答。 */
export interface ValuationStatusView {
  ok: boolean
  error: string
  valuationId: string
  phase: ValuationPhase
  workspaceId: string
  workspacePath: string
  sessionId: string
  progress: ValuationProgressView
  providerStates: Record<string, ValuationProviderStateView>
  capabilityGaps: string[]
  /** 这一轮自己的失败原因（与信封的 `error` 不是一回事）。 */
  recordError?: string
  /** 宿主是否还有这一轮的记录；false = 重启过或已被更新的轮次挤掉。 */
  known: boolean
  method?: ValuationMethod
  baseDate?: string
  digest?: string
  casePath?: string
  artifacts?: ValuationArtifactPresence
}

/** 一条案例（字段名与 `估值结果.json` 的 snake_case 保持一致）。 */
export interface ValuationCaseView {
  url: string
  title: string
  community: string
  transaction_type: string
  used_as_comparable: boolean
  unit_price: number | null
  building_area: number | null
  keep_reason: string
  drop_reason: string
  captured_at?: string
}

/** `估值结果.json` 的线上视图（缺的数字是 `null`，绝不是 0）。 */
export interface ValuationResultView {
  valuationId: string
  method: string
  methodReason: string
  baseDate: string
  unitPrice: number | null
  totalValue: number | null
  manual_confirmation_items: string[]
  capability_gaps: string[]
  knowledge_sources: ValuationKnowledgeSourceView[]
  cases: ValuationCaseView[]
  artifacts: { html: string; xlsx: string; json: string }
}

/** `valuation-result` 的应答。 */
export interface ValuationResultEnvelopeView {
  ok: boolean
  error: string
  valuationId: string
  casePath: string
  phase: string
  artifacts: ValuationArtifactPresence
  result: ValuationResultView | null
}

/** `valuation-start` 的应答。 */
export interface ValuationStartView {
  ok: boolean
  error: string
  valuationId: string
  casePath: string
  sessionId?: string
  phase?: ValuationPhase
  /** 同一 ID 已经开过 → true（界面据此不重复提示"正在启动"）。 */
  reused?: boolean
  digest?: string
}

/** `valuation-browser-preflight` 的应答。 */
export interface ValuationBrowserPreflightView {
  ok: boolean
  error: string
  providers: ValuationProviderView[]
  /** 是否真的代为打开了默认浏览器登录页。 */
  opened: boolean
  openError: string
}
