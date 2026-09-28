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
import type { EnvironmentStateView } from './environment/model.ts'

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

/**
 * 凭据文件的权限状态（协议 17）。
 *
 * **为什么不能只给一个布尔**（2026-09-28）：旧形态是 `chmodOk: boolean`，而 Windows 上根本没有
 * `chmod`（POSIX 权限位不适用），跳过之后只能报 `true` —— 字段名读起来是「chmod 成功了」，
 * 界面文案也会跟着这么说，员工于是以为这份文件被 0600 保护着。三件事必须分开：
 *
 * - `verified`：真的执行了收紧命令并回读确认（目前只有 POSIX 0600 走到这里）；
 * - `inherited`：**没有**执行收紧命令，权限由现有机制负责（Windows 上由当前账户 ACL），
 *   `mechanism` 说明是谁在负责 —— 这不是失败，也不是「已验证」；
 * - `failed`：试图收紧但失败了（POSIX 上 chmod 报错、或被沙箱拒绝），`message` 是原因。
 *
 * 界面**不得**把 `inherited` 显示成成功；`status` 与 `mechanism` 是唯一的说话依据。
 */
export interface CredentialPermission {
  status: 'verified' | 'inherited' | 'failed'
  /** `posix-0600`（文件模式位）/ `windows-acl`（账户 ACL）/ `host-store`（DSH 凭据服务托管）。 */
  mechanism: 'posix-0600' | 'windows-acl' | 'host-store'
  /** 人话原因：`failed` 必有；`inherited` 说明谁在负责；`verified` 为空串。 */
  message: string
}

/** 服务（氚云/钉钉/OSS）探测结果。 */
export interface ServiceCheckView {
  id: string
  label: string
  required: boolean
  ok: boolean
  state: string
  detail: string
  /**
   * OSS 探测的结构化归因（2026-09-26 收紧）：
   * `credential`（AK 无效）/ `permission`（凭据有效但无 Bucket/Prefix 权限）/
   * `config`（Bucket 或 Endpoint 配错）/ `infrastructure`（网络、超时、包内 ossutil 或执行环境）。
   * 氚云 / 钉钉没有归因，留空。
   */
  errorKind?: string
  /** 探测目标（`oss://bucket/prefix/`），**不含凭据**；只用于开发者诊断。 */
  target?: string
}

/**
 * iFinD 凭据检查结果（**只回长度与状态，绝不回显**）。
 *
 * 2026-09-26 起凭据由插件 Host 自己保管（`~/.dsh/crwu-workbench/ifind-credential.json`，0600），
 * 不再读 `ifind-finance-data` 技能目录里的 `mcp_config.json` —— 那既让运行时依赖一个
 * 随时可能被上游改写的第三方文件，也把「员工机器上必须有那个技能」变成了隐含前提。
 *
 * `state` 必须是五态之一（`unconfigured` / `unverified` / `authenticated` / `invalid` /
 * `unreachable`），界面才能把「没填」与「填了连不上」分开处置。
 */
export interface IfindCheckView {
  /** 凭据文件路径（插件状态目录内）；只用于维护者详情。 */
  path: string
  required: boolean
  ok: boolean
  /** `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable`。 */
  state: string
  /** `credential`（401/签名）| `entitlement`（403 权益）| `infrastructure` | `''`。 */
  errorKind: string
  reason: string
  tokenLength: number
  /** 最近一次真实探测的时刻（ISO 串）；没探过是空串。 */
  checkedAt: string
  /** 这次真实探测拿到了几个工具（认证成功的旁证）；没探过是 0。 */
  toolCount: number
  /** **真的取到数据了吗**（`tools/call` 成功返回内容）。`ok` 只代表认证通过。 */
  dataVerified: boolean
  /** 取数用的工具名（没取数时空串）。 */
  dataTool: string
  /** 取数结果的**脱敏**短摘要（最多 300 字符）；绝不回传 token。 */
  dataSample: string
  /** 「获取 API-Key」的官方入口（页面上的链接）；Host 不代填、不索取。 */
  applyUrl: string
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
 * 协议号 13 追加 `state`（统一环境模型，见 `shared/environment/model.ts`）：事实分区不变，
 * 但"这些事实意味着什么"（状态 / 阻塞 / 归属 / 通过率 / 门禁）改由 Host 推出一次，客户端不再自己算。
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
  /**
   * **统一环境模型**（协议 13）。
   *
   * 上面那些分区是「探测事实」，这一块是「这些事实意味着什么」：状态、阻塞与否、归属于谁、
   * 通过率、以及门禁结论。旧客户端不读它（照旧按 `allOk` 判断），新客户端只读它 ——
   * 一侧负责事实、一侧负责解释，避免两边各推一套结论（`allOk` 说就绪、通过率说 7/8 那种）。
   *
   * 可选是刻意的：宿主是旧构建时没有它，界面走「不认识 → 不放行」的失败关闭路径（§7.12）。
   */
  state?: EnvironmentStateView
}
