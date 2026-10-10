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
import type { LocalAccessConsentView } from './access/types.ts'

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

/**
 * 审核停止的**阶段**（F1 的状态机，Host 与 Client 用同一套枚举）。
 *
 * - `idle`：没发起过停止
 * - `requested`：已收到停止请求，还没发出 abort
 * - `aborting`：abort / cancel 已发出，等子会话退出
 * - `waiting-quiescence`：dispose 未完成，或 Agent 仍显示 running
 * - `quiesced`：已确认停下（dispose 完成，或 Agent 已不在 running）
 * - `timeout`：有界等待到点，仍无法确认静默
 * - `failed`：停止过程发生基础设施 / 持久化错误
 */
export type AuditStopPhase =
  | 'idle' | 'requested' | 'aborting' | 'waiting-quiescence' | 'quiesced' | 'timeout' | 'failed'

/**
 * 停止状态的线上视图。
 *
 * ⚠️ 客户端拿到**缺失字段**时必须按"未知"处理，**不许**自行推断成 stopped / quiesced
 *（2026-09-29 第三轮复查的 F4）：只有 Host 能回答"是不是真的停下了"。
 */
export interface AuditStopView {
  phase: AuditStopPhase
  /** 发起停止的时刻（epoch ms，0 = 没发起过）。 */
  requestedAt: number
  /** 已经等了多久（由 Host 计算，客户端不自己算 —— 时钟不同源）。 */
  elapsedMs: number
  /** 是否已确认静默。**只有它决定"能不能启动下一条"**。 */
  quiesced: boolean
  /** abort / cancel 是否真的发出去过（诊断用，不许写死）。 */
  aborted: boolean
  /** dispose 是否真的完成了（超时不算）。 */
  disposed: boolean
  /** 阻塞性错误（phase = failed 时的原因）。 */
  error: string
  /** 非阻塞观察（例如"dispose 超时但 Agent 已不在运行"）。 */
  notes: string[]
  /** 能不能启动下一条审核 —— **只能由 Host 判定**。 */
  canStartNext: boolean
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
  /**
   * 停止状态（F4）。缺失 = 未知（旧宿主 / 老记录），客户端按"不知道"处理。
   */
  stop?: AuditStopView
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

export type OssBatchItemResult =
  | { ok: true; error: ''; item: CloudItem | null }
  | { ok: false; error: string; errorKind: 'access' | 'config' | 'command' | 'truncated' | 'invalid-result' | 'timeout' | 'cancelled'; item: null }

export interface OssBatchIndexResult {
  ok: boolean
  error: string
  results: Record<string, OssBatchItemResult>
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
  /**
   * 这次自检**没能问到**运行时的答案（工具调用失败/超时/报错），因此**不能**据此判"缺失"。
   *
   * 真实成因（2026-09-29 员工 Windows 实测）：环境自检不带会话 agent，而
   * `load_workspace_dependencies` 需要 agent 作用域 —— 同一个工具在会话里调用返回完整载荷
   * （`python` + 全部必需包），在自检上下文里却报错。把"我没问到"渲染成"系统故障"会
   * 直接把审核入口关掉，所以这一支必须是**非阻塞**的，并在发起审核时由审核根会话复核。
   */
  unresolved: boolean
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
  /** 这条根服务的**案例目录**（协议 19 起：根的 cwd 与沙箱边界都是它）。 */
  casePath: string
  assignedAt: string
  /** 现在还可用吗；不可用会在下次发起审核时自动新建一个（旧的树保留）。 */
  usable: boolean
  reason: string
  /**
   * 审核根的沙箱模式与审批策略（协议 18 · 子项目 C）。
   *
   * 空串 = 还没建根 / 读不到。⑧ 上显示它们，验收里也要求"根与子会话都显示
   * workspace-write / never" —— 只写提示词不算数，得看得见。
   */
  sandboxMode?: string
  approvalPolicy?: string
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
  /** ④ 只放登录/授权那两条（氚云 + 钉钉）；OSS 归 `delivery`。 */
  services: ServiceCheckView[]
  delivery: DeliveryView
  external: IfindCheckView
  blocked: string[]
  allOk: boolean
  home: string
  platform: string
  /**
   * 本机访问授权收据（协议 18）：取代了旧的 `trust: { credentials: boolean }`。
   *
   * 界面读它来决定「显示授权卡 / 禁用凭据类操作」，Host 门禁读同一份事实 —— 两侧不许各算一遍。
   */
  localAccess: LocalAccessConsentView
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

/**
 * DWS 本机目录的**只读体检**结果（协议 18 · 子项目 D2）。
 *
 * 脱敏口径写在这里，因为它是跨进程契约：没有 ACL 条目、账户名、SID、钥匙串条目名、
 * 原始 `dws doctor` 输出。`directoryMode` / `lockMode` 只在 POSIX 上是规范八进制串，
 * Windows 上恒为空串；两个布尔拿不到结论时是 `null`（"不知道"与"不行"处置不同）。
 */
export interface DwsLocalDoctorView {
  ok: boolean
  error: string
  platform: string
  permissionMechanism: 'windows-acl' | 'posix-mode' | 'unknown'
  /**
   * 目录 / 锁文件**在不在**：`true` 在、`false` 确实没有、`null` **探测失败**。
   *
   * `null` 这一态不能省：Windows 上 `Access is denied` 与"真的没有"是两件事，
   * 压成一个 `false` 会让体检报「目录不存在，请先登录一次」（用户复查抓到的 P1）。
   */
  directoryExists: boolean | null
  lockExists: boolean | null
  ownerMatchesCurrentUser: boolean | null
  currentUserCanModify: boolean | null
  /**
   * 锁文件**自身**能不能被当前账户改：`true` 能、`false` 确定不能、`null` 不知道 / 锁不存在。
   *
   * 与 `currentUserCanModify`（说的是目录）分开：真实现场里"目录能写、`.data.lock` 单独不可写"
   * 很常见，而原始报错通常正是 `opening lock file ... Access is denied`。
   * 合成一个布尔会让体检报「可读写，正常」却同时给出修复入口（自相矛盾的画面）。
   */
  lockWritable: boolean | null
  /** 锁文件属主是不是当前账户（`null` = 不知道 / 锁不存在）。 */
  lockOwnerMatchesCurrentUser: boolean | null
  directoryMode: string
  lockMode: string
  credentialStoreState: 'unknown' | 'available' | 'missing-secret' | 'interaction-denied' | 'access-denied'
  dwsDoctorState: string
  /**
   * 这次体检有没有真的跑起来（`false` = 前置条件不满足，按规定拒绝）。
   *
   * 由 Host 给出，界面据此解释"为什么没有结论" —— **不要让客户端自己推断**。
   */
  canDiagnose: boolean
  /** 归因类别（与开发者诊断同一套词表）。空串 = 还没有可归因的失败。 */
  classification: string
}

/**
 * 本地审核：一个**选择项**（文件或文件夹）的扫描结果（协议 28）。
 *
 * `path` 是用户本机的绝对路径，**只在本机界面显示与后续调用里用**：它不进提示词、不上云、
 * 也不出现在任何交付件里（可复制提示词只带展示名 + 相对路径 + handoffId）。
 */
export interface LocalAuditItemView {
  path: string
  name: string
  /** `file` | `directory`。 */
  kind: string
  /** 文件字节数；文件夹为 0。 */
  sizeBytes: number
  /** 展开后的普通文件数：文件为 1，文件夹为递归结果（0 = 里面没有普通文件）。 */
  fileCount: number
  /** `scanned` | `unreadable` | `skipped` | `over-limit`（Host 原文，界面据此选图标与颜色）。 */
  status: string
  reason: string
}

/** 逐件跳过的**普通文件**（不是选择项）：文件夹展开后读不了/不适用那些。 */
export interface LocalAuditSkippedView {
  /** 展示名（相对用户所选入口的相对路径）。 */
  relativePath: string
  name: string
  reason: string
}

/** 进快照的普通文件（展示名 + 相对路径；绝对路径不出现）。 */
export interface LocalAuditFileView {
  relativePath: string
  name: string
}

/**
 * `local-audit-status` 的应答：**本次选择**展开后的状态。
 *
 * 它只服务当前准备流程（选完就扫、改完再扫），不是全局 sidecar，也不代表任何历史。
 */
/**
 * 扫描结果里的**一个文件**（界面「展开到文件级」那一行）。
 *
 * 有了它，员工在开始之前就能看见**到底会审哪些文件**、并能逐个移除 ——
 * 而不是只看见一个文件夹名和一句"展开后共 N 个文件"。
 *
 * 与 `LocalAuditFileView` 的区别：那个是**快照内部**的形态（只有展示名 + 相对路径，
 * 会进清单、可能被模型读到）；这个多带 `path` 与 `parentPath`，只在**界面**上用。
 */
export interface LocalAuditScannedFileView {
  /** 它属于哪个已选入口（文件夹的绝对路径）—— 界面据此把文件挂在那个文件夹行下面。 */
  parentPath: string
  /** 完整绝对路径：**只用于关掉某一个文件**（排除清单的键），不进提示词、不进快照清单。 */
  path: string
  name: string
  /** 相对所选入口的展示路径。 */
  relativePath: string
  sizeBytes: number
}

export interface LocalAuditScanView {
  ok: boolean
  error: string
  errorKind: string
  /** 去重后的普通文件总数（实际会被审核的数量）。 */
  fileCount: number
  /** 单次上限（30）；仅在 `overLimit` 为真时有意义。 */
  limit: number
  overLimit: boolean
  /** 快照阶段预期能读到的文件数（`fileCount` 去掉已知不可读项）。 */
  readableCount: number
  skippedCount: number
  items: LocalAuditItemView[]
  /**
   * 展开后的文件级清单（已扣掉排除项）；`parentPath` 指回上面的入口。
   *
   * 界面在扫描完成后**必须逐行展示完整文件名**（用户 2026-10-11 口径），
   * 每一行右侧一枚 X 表示"移除这个文件"。
   */
  files: LocalAuditScannedFileView[]
  skipped: LocalAuditSkippedView[]
}

/**
 * `local-audit-start` 的应答：一次性 handoff + **可复制的固定提示词**。
 *
 * `prompt` 是给用户复制/或由客户端直接发给新会话的那一段：只含 `handoffId`、展示名、相对路径、
 * 快照状态、固定审核要求与用户补充提示词 —— **不含**原始绝对路径、凭据、OSS 地址、氚云信息。
 */
export interface LocalAuditStartView {
  ok: boolean
  error: string
  errorKind: string
  handoffId: string
  prompt: string
  /** 已提供（进快照）的文件数。 */
  providedCount: number
  skippedCount: number
  /** handoff 过期时刻（epoch ms；0 = 不适用）。 */
  expiresAt: number
  /**
   * 新会话的 **cwd**：员工选定的工作空间（逐字）。
   *
   * DSH 按 cwd 把会话归到工作空间下（cwd 不等于工作空间路径就会落「未分组」），
   * 而它同时是会话的沙箱边界 —— 案例目录就在它之内，所以对话里的案例内工具写得进去。
   *
   * ⚠️ 只回给客户端，**不进提示词**。
   */
  workspacePath: string
  /**
   * 本轮案例目录：`<工作空间>/本地审核/<handoffId>`。
   *
   * 交付件（HTML / JSON）就落在这里，员工在自己的工作空间里找得到。
   * 同样**只回给客户端**，不进提示词（提示词里只有 `handoffId`、展示名与快照内相对路径）。
   */
  casePath: string
  files: LocalAuditFileView[]
  skipped: LocalAuditSkippedView[]
}

/** 最小权限修复的结果（协议 18 · 子项目 D3）。 */
export interface DwsLocalRepairView {
  ok: boolean
  error: string
  /** 修了哪几类目标（**不**回具体路径：都在 `<home>/.dws` 之内）。 */
  repaired: string[]
  /** 想做但没做成的（命令被拒、路径是符号链接……）。 */
  skipped: string[]
  /** 修复后**重新体检**的结果：它是"修好了没有"的唯一判据。 */
  doctor: DwsLocalDoctorView
  /** 修复后 `dws auth status` 的结论词（不给原始输出）。 */
  authStatus: string
}

/**
 * 最近一次本机访问的**脱敏事实**（协议 18 · B3 的诊断视图）。
 *
 * 与 `host/access/diagnostics.ts` 的 `AccessDiagnostic` 同形：Host 那边 `operation` / `source`
 * 是更窄的联合类型，赋给这里的 `string` 是结构兼容的。允许出现的只有操作名、来源、三个模式、
 * 两个布尔、归因类别、是否起过进程、版本与时刻 —— **没有** AccessKey / token / 命令原文 / 路径。
 */
export interface AccessDiagnosticView {
  operation: string
  source: string
  consentVersion: number
  requestedMode: string
  resolvedMode: string
  ranMode: string
  sandboxDenied: boolean
  runnerFailed: boolean
  errorClass: string
  processStarted: boolean
  hostVersion: string
  protocolVersion: number
  summary: string
  at: string
}

/** `access-diagnostics` 的返回体。 */
export interface AccessDiagnosticsView {
  ok: boolean
  entries: AccessDiagnosticView[]
  consent: { state: string; schemaVersion: number }
  /**
   * 现在**能不能**做可归因的 DWS 体检 —— 由 Host 按体检前置条件同一判据算好。
   *
   * 界面用它决定「检查本机目录」是否可点：**不让客户端自己推断**
   *（客户端看不到 `lockRelated` 这类事实，猜出来的一定与 Host 不一致）。
   */
  dwsDiagnosable: boolean
}
