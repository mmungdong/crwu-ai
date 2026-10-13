/**
 * 跨领域共用的线协议类型（环境自检的零件、OSS 视图、脱敏凭据视图、本机访问诊断）。
 *
 * 放在 `contracts/` 而不是一个大 `types.ts` 里：这些类型有三个消费者（Host 的操作表、
 * Wire 层的编译期契约检查、Client 的渲染），按领域分开之后"改哪一块会影响谁"是看得见的。
 * `shared/types.ts` 仍然整体 re-export（迁移期兼容），所以旧导入路径不会断。
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
 * 与 `host/core/access/diagnostics.ts` 的 `AccessDiagnostic` 同形：Host 那边 `operation` / `source`
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
