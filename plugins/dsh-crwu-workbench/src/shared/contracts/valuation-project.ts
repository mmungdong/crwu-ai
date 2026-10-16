/**
 * 房地产估值的 **v2 项目合同**（协议 35 的代际边界，设计稿 §7 / §10 / §11）。
 *
 * ## 为什么要有 v2，而不是继续加字段
 *
 * v1 的数据形状是**单对象、单方法**的：`valuation-result.schema.json` 里 `method` 是一个字符串、
 * `unitPrice` 是一个数字、`cases` 是扁平一列。它表达不了首期就必须有的三件事：
 *
 * - **项目 → 方案 → 对象**三层。同一个项目里"同小区三套住宅"是一个方案三个对象，
 *   而"住宅 + 商业"是两个方案 —— 一个 `unitPrice` 装不下。
 * - **房地分别评估**。土地与建筑物是**两个价值范围不同**的任务，合起来算总价会重复计价。
 * - **中断是可交付的状态**。`blocked` / `partial` 必须能出报告，而 v1 的必填金额字段
 *   让"没有金额"只能是失败。
 *
 * v1 的 DTO 在迁移期留在它自己的边界里（`contracts/report-evaluation.ts`），
 * 由 Task 4 移除 Client 依赖后下线。**同一个 Schema 不混两版字段** —— 混了之后没人分得清
 * 某个字段是"没有"还是"这一代不表达"。
 *
 * ## 这一层放什么
 *
 * 只放**跨进程**的输入/输出 DTO（Host 与 Client 都认），以及纯数据的联合类型。
 * 判定逻辑归 `host/domains/report-evaluation/**`，这里不实现业务规则。
 */

// ---------------------------------------------------------------------------
// Schema 版本
// ---------------------------------------------------------------------------

/** 冻结输入（`估值输入.json`）。 */
export const VALUATION_INPUT_SCHEMA_VERSION = 'crwu.valuation.input.v3'
/** 项目索引（`项目估值方案索引.json`）。 */
export const VALUATION_PROJECT_SCHEMA_VERSION = 'crwu.valuation.project.v2'
/** 报告数据（`估值报告数据.json`，约束 HTML 的唯一数据源）。 */
export const VALUATION_REPORT_DATA_SCHEMA_VERSION = 'crwu.valuation.report-data.v2'

// ---------------------------------------------------------------------------
// 取值集合
// ---------------------------------------------------------------------------

/** 用户提交的方法请求。`auto` 是**输入**，不是任何一种结论。 */
export type MethodRequest = 'auto' | 'market' | 'income' | 'cost'

/** 结论侧真的被采用的方法。 */
export type AdoptedMethod = Exclude<MethodRequest, 'auto'>

/** 房地路径：合一 / 分别 / 权益边界未解。 */
export type ValuationPath = 'combined' | 'separate' | 'unresolved'

/** 一个组件结果覆盖的价值范围。三者互斥，`land-and-building` 不能再叠加 `land-only`。 */
export type ValueScope = 'land-only' | 'building-only' | 'land-and-building'

/** 报告状态。判别联合的判别项。 */
export type ReportStatus = 'completed' | 'blocked' | 'partial' | 'failed' | 'cancelled'

/** 执行模式：健康时可有界并行，否则父会话顺序执行（顺序也是一条完整有效的路径）。 */
export type ExecutionMode = 'parallel' | 'sequential'

/** 组件任务要估的是什么。 */
export type AssetClass = 'realestate' | 'land' | 'building'

/** 物业类型。`apartment` 是**有依据的公寓业务分类**（规划用途「公寓/商品房」等）；`other` 是显式的"认出来了但不在首期口径内"，不是缺省值。 */
export type PropertyType = 'residential' | 'commercial' | 'office' | 'industrial' | 'apartment' | 'other'

/**
 * **资产类型**：用户在通用估值页选的业务入口（稳定业务标识，显示文案不承担路由）。
 *
 * 它决定装配哪一个资产 Skill（`real-estate` → `crwu-biz-valuation-realestate`），
 * 而不是决定"页面长什么样" —— 所以**初始必须是未选择**，由用户主动选；
 * 界面不允许替用户默认成房地产（那会把一个未确认的资产口径写进冻结输入）。
 *
 * 首期只有房地产：其它资产类型要连同 Skill、知识入口与能力一起加，
 * 不能只在下拉里加一个选项。
 */
export type AssetType = 'real-estate'

/**
 * **未指定** 的逐字声明（P14 / P16）。
 *
 * 为什么是共享常量而不是各写一句：它同时出现在提示词、报告数据（`limitations[]`）与报告
 * HTML 里。三处措辞一旦漂移，"报告到底有没有登记这个前提"就没法用机器判了 —— 而这几条
 * 正是"不许静默跳过时间因素 / 不许据此声称正式完成"的唯一判据。
 */
export const UNSPECIFIED_BASE_DATE_NOTICE = '本次未指定评估基准日'
export const UNSPECIFIED_PURPOSE_NOTICE = '本次未指定评估目的'
export const UNSPECIFIED_VALUE_TYPE_NOTICE = '本次未指定价值类型'

/**
 * 评估目的 / 价值类型的长度上限。
 *
 * 它们**是自由文本，不是本层定义的业务枚举**：可选值清单属于业务规范（本轮知识快照），
 * 由业务方确认后再作校验 —— 这里只挡住"把一句话塞进来"。
 */
export const PURPOSE_MAX_LENGTH = 200
export const VALUE_TYPE_MAX_LENGTH = 200

/** 估值链路的阶段（也是 blocked/partial 报告必须点名的 stage）。 */
export type ValuationStage =
  | 'intake'
  | 'extract'
  | 'grouping'
  | 'knowledge'
  | 'method-selection'
  | 'retrieval'
  | 'parameters'
  | 'template'
  | 'calculation'
  | 'delivery'

export const VALUATION_METHODS: readonly MethodRequest[] = ['auto', 'market', 'income', 'cost']
/** 首期可选的资产类型。**用户没选之前不在这个集合里做任何默认**。 */
export const ASSET_TYPES: readonly AssetType[] = ['real-estate']
export const VALUATION_PATHS: readonly ValuationPath[] = ['combined', 'separate', 'unresolved']
export const VALUE_SCOPES: readonly ValueScope[] = ['land-only', 'building-only', 'land-and-building']
export const REPORT_STATUSES: readonly ReportStatus[] = ['completed', 'blocked', 'partial', 'failed', 'cancelled']
export const EXECUTION_MODES: readonly ExecutionMode[] = ['parallel', 'sequential']
export const ASSET_CLASSES: readonly AssetClass[] = ['realestate', 'land', 'building']

// ---------------------------------------------------------------------------
// 输入与材料
// ---------------------------------------------------------------------------

/**
 * 归档到案例目录里的一份资料。
 *
 * **不含原始绝对路径**：绝对路径只在面板 metadata 里回显给员工本人，
 * 不进模型快照、不进交接指令、不进报告（设计稿 §5 / §11.1）。
 */
export interface ArchivedMaterial {
  /** 选择器给的稳定标识（同一份文件重复选中时相同）。 */
  fileId: string
  /** 原名称（显示标签）。 */
  fileName: string
  /** 归档副本相对项目目录的路径。 */
  archiveRelativePath: string
  /** 粗分类（pdf / docx / xlsx / image / text / other）。 */
  kind: string
  sizeBytes: number
  /** 归档**副本**的字节指纹；复制后重算，不沿用源文件自报值。 */
  sha256: string
  /** 创建时间；`birthtime` 不可靠时为 `null`（界面对应显示"创建时间未知"）。 */
  createdAt: string | null
  /** 最后修改时间。 */
  modifiedAt: string | null
  /** 归档副本是否可读。 */
  readable: boolean
  /** 内容与该 fileId 相同时填对方 fileId（真实路径不同但字节相同）。 */
  duplicateOf: string | null
}

/** 冻结的估值输入。确认那一刻写死，之后只能消费。 */
export interface FrozenInput {
  schemaVersion: typeof VALUATION_INPUT_SCHEMA_VERSION
  projectId: string
  /**
   * 用户选定的**资产类型**（通用入口的第一个选择）。
   *
   * 它决定这一轮装配哪个资产 Skill 与哪一份入口 Wiki；没有它就没有任何业务入口，
   * 所以它不是可选字段 —— 旧 v2 冻结输入缺这一项，按版本不兼容拒绝并提示重新确认。
   */
  assetType: AssetType
  methodRequest: MethodRequest
  /** 基准日 `YYYY-MM-DD`；未指定时 `null`（**绝不**从资料日期补一个）。 */
  baseDate: string | null
  /**
   * 评估目的（用户在启动页确认）；未指定时 `null`。
   *
   * 它**不是**"默认成转让/抵押"这类结论：没填就是没填，报告与提示词都要按"本次未指定评估目的"
   * 处理，且不得据此声称正式估值已完成（P16）。
   */
  purpose: string | null
  /** 价值类型（用户在启动页确认）；未指定时 `null`。可选值清单由业务方确认，不在合同里写死。 */
  valueType: string | null
  supplementalPrompt: string
  files: ArchivedMaterial[]
  /** 覆盖有序文件清单、方法、基准日、补充要求与 Schema 版本的规范化摘要。 */
  inputDigest: string
}

// ---------------------------------------------------------------------------
// 知识引用
// ---------------------------------------------------------------------------

/**
 * 一条业务规则的出处。
 *
 * 只有正文 hash 不足以证明"某条参数存在"，所以还要能落到**节/规则**：
 * 模型引用规则时必须给出 `snapshotDigest` + `sectionId`/`ruleId`（设计稿 §6.2）。
 */
export type KnowledgeRef = {
  /** Skill 自带的技术路由标识（不是库路径，也不是正文）。 */
  routeId: string
  /** 本轮知识快照的摘要。 */
  snapshotDigest: string
  sectionId?: string
  ruleId?: string
}

/** 物化后的知识来源（`source` 只允许这两种）。 */
export type KnowledgeSourceKind = 'dws' | 'verified-mirror'

/** 一次知识物化的结果记录。 */
export interface KnowledgeSourceRecord {
  routeId: string
  /** 业务库里实际的节点名（不是 Skill 里的别名）。 */
  nodeName: string
  resolvedPath: string
  source: KnowledgeSourceKind
  /** 业务库空间名（必须是**业务库**，不是审核库缓存）。 */
  spaceName: string
  updatedAt: string
  digest: string
  snapshotFile: string
  sectionIds: string[]
  ruleIds: string[]
}

// ---------------------------------------------------------------------------
// 项目 / 方案 / 对象 / 任务
// ---------------------------------------------------------------------------

/** 一个被识别的估值对象。 */
export interface ValuationObject {
  objectId: string
  displayName: string
  /** **业务分类**（知识规则下的判定）。名字里有"公寓"不构成依据 —— 依据在 `classificationBasis`。 */
  propertyType: PropertyType
  /**
   * **原始权证 / 登记用途**（资料原文，例如"公寓""成套住宅""商业服务"）。
   *
   * 它与 `propertyType` 是**两个字段**：登记用途是资料事实，业务分类是本轮知识规则下的判定。
   * 读不到就是空串 —— 不许拿业务分类倒填登记用途，也不许因为名称里有"公寓"就改写为住宅（P15）。
   */
  registeredUse: string
  /**
   * **业务分类的依据**（登记用途 / 规划用途 / 实际使用 + 资料坐标）。
   *
   * 空 = 依据缺失：该对象**挂起**（不进方案、不算结论），其余对象照常继续（P15）。
   */
  classificationBasis: string
  /** 资料坐标，例如 `material-001#page-2` / `material-002#sheet:Sheet1!B4`。 */
  sourceRefs: string[]
  /** 从资料里真的读到的要素；读不到就不出现。 */
  fields: Record<string, string>
  missingFields: string[]
}

/** 单一方法的判定结果。 */
export interface MethodAssessment {
  method: AdoptedMethod
  /** 知识判定它是否**适用**于这个方案（业务问题）。 */
  applicable: boolean
  /** 当前技术实现是否能完整执行它（能力问题）。 */
  implemented: boolean
  selected: boolean
  reason: string
  ruleRefs: KnowledgeRef[]
  conflicts: string[]
}

/**
 * 方案的方法判定。
 *
 * `primaryMethod` / `selectedMethods` / 逐方法理由分三个字段，是因为现有知识的选择方案
 * 涉及主/辅助方法，"恰好一个 adopted"不是长期业务规则（设计稿 §7.2）。
 */
export interface PlanAssessment {
  planId: string
  /** 用户请求的方法（约束，不是建议）。 */
  methodRequest: MethodRequest
  /** 资源采纳的方法；未定案时为 `null`。 */
  primaryMethod: AdoptedMethod | null
  selectedMethods: AdoptedMethod[]
  assessments: MethodAssessment[]
  /** 用户指定方法是否被采纳。`false` 时必须在会话内请求确认。 */
  requestedMethodHonored: boolean
  /** 业务不适用 / 未实现 / 冲突，都要在这里能读出来。 */
  notes: string[]
  decidedAt: string
}

/** 一个估值方案。 */
export interface ValuationPlan {
  planId: string
  title: string
  propertyType: PropertyType
  objectIds: string[]
  methodRequest: MethodRequest
  methodAssessment: PlanAssessment | null
  baseDate: string | null
  valuationPath: ValuationPath
  groupReason: string
  groupEvidenceRefs: string[]
  /** 同一方案内必须一致的口径（有冲突就不能自动合并）。 */
  conflicts: string[]
  status: 'draft' | 'ready-for-method-selection' | 'ready-for-retrieval' | 'blocked' | 'completed' | 'partial'
}

/**
 * 一个执行任务节点。
 *
 * 房地分别评估时，土地与建筑物是两个任务，可以**有依赖**（先取值再汇总），
 * 但只有知识规则与输入允许独立取值时才允许并行（设计稿 §7.3）。
 */
export type TaskNode = {
  taskId: string
  parentPlanId: string
  objectIds: string[]
  assetClass: AssetClass
  /** 需要的技术能力 ID（capability manifest 的键）。 */
  requestedCapability: string
  dependsOn: string[]
  valuationPath: ValuationPath
  valueScope: ValueScope
  basisRefs: KnowledgeRef[]
  status: 'pending' | 'ready' | 'running' | 'completed' | 'blocked' | 'failed'
}

/** 项目索引（`项目估值方案索引.json`）。 */
export interface ValuationProjectIndex {
  schemaVersion: typeof VALUATION_PROJECT_SCHEMA_VERSION
  projectId: string
  inputDigest: string
  objects: ValuationObject[]
  plans: ValuationPlan[]
  tasks: TaskNode[]
  /** 整个项目级别就不能继续时填这里（例如通用规则缺失）。 */
  projectBlockers: Blocker[]
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// 阻断与查找记录
// ---------------------------------------------------------------------------

/** 缺口的类别。前三个是**能力/范围**问题，后面的都要能落到具体检查位置。 */
export type BlockerKind =
  | 'input-invalid'
  | 'property-unsupported'
  | 'method-unsupported'
  | 'valuation-path-unsupported'
  | 'valuation-path-unresolved'
  | 'capability-missing'
  | 'knowledge-missing'
  | 'template-missing'
  | 'evidence-missing'
  | 'recalculation-unavailable'

/**
 * 一个阻断。
 *
 * 五要素（`stage` / `missing` / `checked` / `reason` / `remediation`）**全部必填**：
 * 只说"知识缺失"的中断报告，员工补不了任何东西（设计稿 §11.4）。
 */
export type Blocker = {
  kind: BlockerKind
  stage: ValuationStage
  /** 缺失项：到底缺什么。 */
  missing: string[]
  /** 检查位置：查过哪些精确路径 / 能力 ID / 文件。 */
  checked: string[]
  /** 原因。 */
  reason: string
  /** 补齐动作：员工或维护者要做什么。 */
  remediation: string
  /** 稳定错误码（供脚本与测试断言，不给员工看）。 */
  code?: string
  /** 缺失的能力 ID（`capability-missing` 时必填）。 */
  capabilityId?: string
  knowledgeRef?: KnowledgeRef
}

/** 一次知识查找尝试（`blocked` 报告必须列出来）。 */
export interface LookupAttempt {
  routeId: string
  /** 这次查的是哪一类候选。`manifest` 给的精确路径 / 同目录同名 / 身份已验证镜像 / 目录树。 */
  channel: 'exact-route' | 'same-name' | 'mirror' | 'dws-tree'
  /** 查的位置（库内路径或镜像相对路径）。 */
  target: string
  outcome: 'found' | 'missing' | 'empty' | 'ambiguous' | 'unreadable' | 'rejected-identity' | 'rejected-digest'
  detail: string
}

// ---------------------------------------------------------------------------
// 交接
// ---------------------------------------------------------------------------

/** 一次交接的回执。重试必须复用同一个 `parentSessionId`。 */
export interface HandoffReceipt {
  projectId: string
  parentSessionId: string
  dispatchAccepted: boolean
  reused: boolean
}

// ---------------------------------------------------------------------------
// 报告数据（约束 HTML 的唯一数据源）
// ---------------------------------------------------------------------------

/** 报告里的一段取数轨迹（技术过程，不是模型隐藏思维链）。 */
export interface RetrievalAttempt {
  taskId: string
  caseId: string
  providerId: string
  stage: 'search' | 'detail' | 'screenshot'
  outcome: 'ok' | 'blocked' | 'challenge-recovered' | 'waiting-user' | 'unsupported' | 'failed'
  finalUrl: string
  reasonCode: string
  /** 挑战恢复的技术摘要（策略 / 尝试次数）；不含 Cookie 与原始 CDP 指令。 */
  recoveryStrategy?: string
  recoveryAttempts?: number
}

/** 报告里的一个参数取值。 */
export interface ReportParameterRecord {
  parameterId: string
  label: string
  value: string | null
  unit: string
  valueDate: string | null
  region: string
  sourceRef: string
  ruleRef: KnowledgeRef | null
  /** 缺失与"不适用"必须与 0 分开。 */
  state: 'provided' | 'missing' | 'not-applicable'
  /**
   * `missing` 时的**处置**（P17）：字段缺失是登记缺口、可以继续；方法所需关键参数缺失要
   * **挂起相关计算**。两者混成一个 `state` 就分不清"这份资料少一栏"与"这个方法算不下去"。
   */
  missingImpact: 'registration-gap' | 'calculation-suspended'
}

/** 报告里的一个可比案例。 */
export interface ReportComparableRecord {
  caseId: string
  displayName: string
  provider: string
  sourceUrl: string
  transactionType: string
  publishedAt: string | null
  unitPrice: string | null
  buildingArea: string | null
  used: boolean
  keepReason: string
  dropReason: string
  screenshots: ScreenshotEvidenceRecord[]
}

/** 一段计算轨迹（中间值可复算）。 */
export interface ReportCalculationStep {
  stepId: string
  formulaId: string
  label: string
  expression: string
  operands: Array<{ name: string; value: string; unit: string; provenance: string }>
  value: string
  unit: string
  ruleRef: KnowledgeRef | null
}

/** 一条规则校验结论。 */
export interface ReportRuleCheck {
  ruleId: string
  label: string
  passed: boolean
  detail: string
  ruleRef: KnowledgeRef | null
}

/** 一个对象的价值结论。 */
export interface ReportConclusion {
  objectId: string
  valueScope: ValueScope
  method: AdoptedMethod
  unitPrice: string | null
  totalValue: string | null
  currency: string
  basisRefs: KnowledgeRef[]
  calculationRef: string | null
}

/** 一张正式证据截图。 */
export interface ScreenshotEvidenceRecord {
  caseId: string
  displayName: string
  provider: string
  sourceUrl: string
  capturedAt: string
  /** 相对**方案**推理结果目录的路径，必须落在 `推理结果/图片/<安全caseId-名称>/` 下。 */
  relativePath: string
  digest: string
  validity: 'valid' | 'missing' | 'invalid' | 'not-required'
  /** Optional evidence type; absent for legacy records and never inferred as detail. */
  evidenceType?: 'page-screenshot' | 'detail-screenshot' | 'alternative-evidence'
}

/** 一份交付工作簿。 */
export interface ReportWorkbookRecord {
  workbookId: string
  /** 相对项目目录的路径（集合交付时是多份对象级工作簿）。 */
  relativePath: string
  templateId: string
  templateDigest: string
  /** 对象级实例；汇总表之外每对象一份。 */
  objectIds: string[]
  recalculated: boolean
  recalculationNote: string
}

/** 一个交付件。 */
export interface ReportArtifact {
  artifactId: string
  kind: 'html' | 'workbook' | 'data' | 'screenshot'
  relativePath: string
  digest: string
  present: boolean
}

/** finalize 的校验回执（`completed` 必须带）。 */
export interface FinalizeValidationReceipt {
  projectId: string
  planId: string
  /** 冻结输入在 finalize 时刻重算的摘要必须与之相等。 */
  inputDigest: string
  knowledgeVerified: boolean
  templateVerified: boolean
  evidenceVerified: boolean
  calculationVerified: boolean
  workbookRecalculated: boolean
  reportRendered: boolean
  verifiedAt: string
  notes: string[]
}

/** 报告数据的公共部分。 */
interface ReportDataBase {
  schemaVersion: typeof VALUATION_REPORT_DATA_SCHEMA_VERSION
  projectId: string
  planId: string
  generatedAt: string
  methodRequest: MethodRequest
  method: AdoptedMethod | null
  baseDate: string | null
  /** 基准日是否由员工指定；`false` 时报告必须说明这是**未指定基准日**的测算。 */
  baseDateSpecified: boolean
  /** 评估目的；未指定时 `null`（**不默认**成某种正式目的）。 */
  purpose: string | null
  /** 评估目的是否由员工填写；`false` 时报告必须逐字写明「本次未指定评估目的」，且不得据此声称完成。 */
  purposeSpecified: boolean
  /** 价值类型；未指定时 `null`。 */
  valueType: string | null
  /** 价值类型是否由员工填写；`false` 时报告必须逐字写明「本次未指定价值类型」。 */
  valueTypeSpecified: boolean
  supplementalPrompt: string
  inputDigest: string
  materials: ArchivedMaterial[]
  knowledgeSources: KnowledgeSourceRecord[]
  retrievalAttempts: RetrievalAttempt[]
  artifacts: ReportArtifact[]
  limitations: string[]
}

/** 完成：对象结论、计算表、证据、知识引用与校验回执都通过。 */
export interface CompletedReportData extends ReportDataBase {
  status: 'completed'
  objects: ValuationObject[]
  methodAssessment: PlanAssessment
  parameters: ReportParameterRecord[]
  comparables: ReportComparableRecord[]
  calculationSteps: ReportCalculationStep[]
  ruleChecks: ReportRuleCheck[]
  conclusions: ReportConclusion[]
  evidence: ScreenshotEvidenceRecord[]
  workbooks: ReportWorkbookRecord[]
  validation: FinalizeValidationReceipt
}

/** 阻断：没有金额，也可以没有工作簿；但必须说清缺什么、查过哪、怎么补。 */
export interface BlockedReportData extends ReportDataBase {
  status: 'blocked'
  stage: ValuationStage
  blockers: Blocker[]
  lookupAttempts: LookupAttempt[]
  conclusion: null
  /** 阻断前已经做出来的对象结果（只作过程材料，不作结论）。 */
  partialObjectResults: ReportObjectResult[]
}

/** 部分完成：已有工作与未完成项分开，暂算金额不得作为最终结论展示。 */
export interface PartialReportData extends ReportDataBase {
  status: 'partial'
  stage: ValuationStage
  completedWork: string[]
  outstanding: string[]
  blockers: Blocker[]
  lookupAttempts: LookupAttempt[]
  provisionalResults: ReportObjectResult[]
  conclusion: null
}

/** 失败 / 取消：如实列出阶段与已有文件，不标为已估值完成。 */
export interface FailedReportData extends ReportDataBase {
  status: 'failed' | 'cancelled'
  stage: ValuationStage
  error: string
  blockers: Blocker[]
  conclusion: null
  availableArtifacts: string[]
}

/** 报告里的对象结果（blocked/partial 用它表达"已经做到哪一步"）。 */
export interface ReportObjectResult {
  objectId: string
  displayName: string
  valueScope: ValueScope
  method: AdoptedMethod | null
  unitPrice: string | null
  totalValue: string | null
  currency: string
  calculationRef: string | null
}

/** 报告数据的判别联合。HTML 只能由它渲染，模型不能直接写 HTML。 */
export type ReportData =
  | CompletedReportData
  | BlockedReportData
  | PartialReportData
  | FailedReportData

// ---------------------------------------------------------------------------
// 错误信封
// ---------------------------------------------------------------------------

/**
 * 所有结构化 Tool / 操作的失败信封。
 *
 * 业务失败**不抛裸错误**：抛出去之后就没有 `errorKind` 了，界面与 Skill 只能显示一句话。
 */
export interface FailureEnvelope {
  ok: false
  errorKind:
    | 'input-invalid'
    | 'scope-denied'
    | 'not-found'
    | 'unsupported'
    | 'capability-gap'
    | 'policy'
    | 'infrastructure'
    | 'conflict'
    | 'cancelled'
  error: string
  blocker?: Blocker
}
