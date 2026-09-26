/**
 * Host ↔ Client 的**线协议**类型（跨域传输的 JSON 形状）。
 *
 * 为什么单独放这里：这些字段两边都要用。Host 侧各自有内部类型（`H3yunTask` / `AuditRecord` /
 * `OssItem` / `EnvCheck`），Client 侧只能看到 JSON。如果两边各写一份声明，改名时会出现
 * 「Host 返回了新字段名、Client 还在读旧字段名」这种**运行期才暴露、且表现为空白**的漂移。
 *
 * 因此约定：
 * - 这里定义线协议（唯一声明）；
 * - Host 的内部类型必须**可赋值**给这里的类型（由 `wire-contract.ts` 在 typecheck 阶段强制）；
 * - Client 只 import 这里的类型。
 */

/** 一行氚云待审核记录。 */
export interface TaskRow {
  name: string
  project: string
  business: string
  risk: string
  reviewLevel: string
  reviewState: string
  currentNode: string
  seqNo: string
  status: string
  statusName: string
  modifiedAt: string
  id: string
  idTail: string
}

/** 一条审核记录的线上视图。 */
export interface AuditView {
  key: string
  childId: string
  seqNo: string
  project: string
  objectId: string
  startedAt: string
  parentSessionId: string
  status: string
  ended: boolean
  stopped: boolean
  stopReason: string
  endReason: string
  casePath: string
  resultFile: string
  htmlFile: string
  caseName: string
  uploadedAt: string
  uploadError: string
  ossPrefix: string
  attempt: number
  adopted?: boolean
  childAlive?: boolean
  activity?: string
}

/** 云端一个流水号下的交付件。 */
export interface CloudItem {
  seqNo: string
  /**
   * 该流水号下的**全部**云端对象。`size` / `lastModified` / `etag` 来自 `ossutil ls` 的
   * 长格式（一次列举就有；旧宿主不传这三个字段时客户端按缺失处理）。
   * ETag 是"审核结果有没有重新生成过"的客观依据，所以别再用 `--short-format` 把它丢掉。
   */
  files: Array<{ key: string; name: string; size?: number; lastModified?: string; etag?: string }>
  htmlKey: string
  jsonKey: string
}

/**
 * 随插件发布的组件（`crwu` / `dws` / `ossutil`）的检查结果。
 *
 * 它们**不是 PATH 命令**：只按包内 `bin/<平台>/<文件>` 与包内 `bin/manifest.json` 核对，
 * 所以这里没有 `command` / `versionText` 这类字段（旧线协议的 `EnvCheckView` 就是混装的产物）。
 */
export interface PackagedToolView {
  name: string
  label: string
  /** 包内文件名（Windows 平台带 `.exe`）。 */
  file: string
  present: boolean
  sizeBytes: number
  /** 包内清单声明的字节数；读不到时是 0。 */
  manifestSizeBytes: number
  /** 包内清单记的 sha256（不在自检里重算）；读不到时是空串。 */
  sha256: string
  expectedVersion: string
  note: string
  ok: boolean
  reason: string
}

/** 插件包完整性（② 层）：唯一一个聚合项，三件组件不各占一行。 */
export interface PackageIntegrityView {
  ok: boolean
  /** 当前平台是否有随包发布的组件目录。 */
  supported: boolean
  platform: string
  packageRoot: string
  manifestPath: string
  manifestFound: boolean
  tools: PackagedToolView[]
  note: string
}

/**
 * DSH 自带脚本运行时（③ 层）。
 *
 * `source` 必须明说「DSH 自带（bundled runtime）」—— 写成系统 Python 会把员工指去装一份
 * 插件根本不会用的解释器。
 */
export interface RuntimeView {
  ok: boolean
  /** 'ok' | 'capability-gap' | 'missing-package' | 'failed'（其它值按 Host 原文显示）。 */
  state: string
  path: string
  versionText: string
  distributions: Record<string, string>
  missingPackages: string[]
  error: string
  source: string
  /** 清单对该运行时的要求（版本约束 / 必需包），只用于展示与维护者对账。 */
  expect: string
  required: boolean
  requiredPackages: string[]
  note: string
}

/** OSS 配置视图（⑤ 层）。 */
export interface OssConfigView {
  enabled: boolean
  bucket: string
  endpoint: string
  prefix: string
  linkMode: string
  linkTtl: number
  autoUpload: boolean
  /** 包内 ossutil 是否就绪（只认包内，不回退 PATH）。 */
  ossutilReady: boolean
  /** 维护者详情：包内 ossutil 的绝对路径；未就绪时空串。 */
  ossutilPath: string
}

/** OSS 凭据的**脱敏**视图（只回掩码后的 AK ID，绝不回显 Secret）。 */
export interface OssCredView {
  path: string
  exists: boolean
  endpoint: string
  accessKeyIdMasked: string
  hasSecret: boolean
  hasSts: boolean
  language: string
}

/** ⑤ OSS 交付配置：配置 + 凭据 + 一次真实连通性探测。 */
export interface DeliveryView {
  oss: OssConfigView
  ossCred: OssCredView
  probe: ServiceCheckView
}

/** 服务（氚云/钉钉/OSS）探测结果。 */
export interface ServiceCheckView {
  id: string
  label: string
  required: boolean
  ok: boolean
  state: string
  detail: string
}

/** iFinD 密钥检查结果（**只回长度，不回显**）。 */
export interface IfindCheckView {
  path: string
  required: boolean
  ok: boolean
  reason: string
  tokenLength: number
}

/** 工作空间视图。 */
export interface WorkspaceView {
  chosen: boolean
  path: string
  title: string
  id: string
  source: string
  /**
   * 用户选过的那个目录已经不在了。
   *
   * 这时 `chosen` 是 false（不能拿它跑审核），但 `path` 仍然带着用户选过的路径，
   * 界面据此说清「你选的那个没了，请重选」——**绝不静默换成清单偏好里的另一个工作空间**。
   */
  missing: boolean
}

/**
 * 审核根会话视图。
 *
 * 所有审核子代理都挂在这一个会话下面（它是建在插件选定工作空间里的顶层会话），
 * 所以「子代理树挂在谁下面」不再取决于「你从哪个会话点开了面板」。
 */
export interface AuditRootView {
  sessionId: string
  title: string
  workspacePath: string
  assignedAt: string
  /** 现在还可用吗；不可用会在下次发起审核时自动新建一个（旧的树保留）。 */
  usable: boolean
  reason: string
}

/** 占用门禁。 */
export interface ActiveView {
  key: string
  childId: string
  since: number
}

/** 当前会话（父会话）的事实：只用于显示与 preset 提示，不决定审核父级。 */
export interface SessionWorkspaceView {
  parentSessionId: string
  sessionCwd: string
  workspaceId: string
  workspacePath: string
  workspaceTitle: string
}

/**
 * `env` 操作的**线协议**应答。
 *
 * 六块分区是这一版（协议号 12）的核心：② 插件包完整性 / ③ DSH 自带运行时 / ④ 登录与凭据授权 /
 * ⑤ OSS 交付配置 / ⑥ 外部数据，加上 ① 工作空间。旧线协议把它们混在 `checks[]` 里，
 * 于是界面只能平铺成一列命令清单。
 *
 * Host 侧的内部类型（`host/environment/ops.ts` 的 `EnvResult`）由 `wire-contract.ts` 强制
 * 可赋值给这里 —— 少字段或类型漂移在 typecheck 阶段就会红。
 */
export interface EnvResultView {
  ok: boolean
  configSource: string
  packageIntegrity: PackageIntegrityView
  runtime: RuntimeView
  /** ④ 只放登录/授权那两条（氚云 + 钉钉）；OSS 归 `delivery`。 */
  services: ServiceCheckView[]
  delivery: DeliveryView
  external: IfindCheckView
  blocked: string[]
  allOk: boolean
  home: string
  platform: string
  trust: { credentials: boolean }
  /** ① 案例根目录。 */
  workspace: WorkspaceView
  /** 可选：老版本 Host 不带这个字段，界面按「尚未创建」显示即可。 */
  auditRoot?: AuditRootView
  sessionWorkspace: SessionWorkspaceView
  /** 「我是谁」：三个字段都可能是空串，界面整句不展示。 */
  me: { name: string; org: string; userId: string }
}
