/**
 * 环境自检的线协议视图（`env` 的应答形状）。
 *
 * 与 `shared/environment/model.ts` 的分工：model 是**两侧共用的判据**（什么叫就绪），
 * 这里只是**线上一行行的事实**。判据只能有一处，视图可以有很多条。
 */

import type { DeliveryView, IfindCheckView, PackageIntegrityView, ServiceCheckView } from './common.ts'
import type { AuditRootView } from './report-audit.ts'
// 环境视图复用两个**已经定了定义处**的模型：本机访问授权回执与统一环境模型
//（后者是两侧共用的判据，不只属于线协议）。这里只引用，不复制定义。
import type { LocalAccessConsentView } from '../access/types.ts'
import type { EnvironmentStateView } from '../environment/model.ts'

/** 钉钉设备流登录的一次快照（协议 32）。 */
export interface DwsDeviceLoginView {
  phase: 'running' | 'ok' | 'failed' | 'timeout' | 'cancelled'
  url: string
  urlManual: string
  userCode: string
  tail: string
  error: string
  advice: string
  sandboxBlocked: boolean
  deadlineAt: string
  opened: boolean
  openError: string
}

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
 * Host 侧的内部类型（`host/core/environment/ops.ts` 的 `EnvResult`）由 `shared/wire/environment.ts` 强制
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
