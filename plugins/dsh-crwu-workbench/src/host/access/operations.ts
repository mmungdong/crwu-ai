import type { LocalAccessCapability } from '../../shared/access/types.ts'

/**
 * 本机访问的**封闭操作表**（协议 18 · 子项目 B）。
 *
 * ## 为什么是"命名操作"而不是"命令 + 权限布尔"
 *
 * 旧形态是调用方传 `escalate: true`。那个布尔值的含义只能从**调用点**读出来：
 * 「这个 true 是读钥匙串，还是写用户目录，还是打开浏览器？」—— 审查一处改动时，
 * 必须把整条调用链读一遍才知道它到底放行了什么。更糟的是布尔值可以被复制粘贴到
 * 一个新的调用点上，而**没有任何地方会因此变红**。
 *
 * 现在每个特权动作都是一个**具名操作**，它的四件事在 Host 内固定：
 * 需要哪个 capability、走哪条通道、要不要逐次声明 `danger-full-access`、允许哪些来源调用。
 * 调用方（面板 / 审核 Tool / 宿主后台）只能**选一个名字**，不能提交命令、二进制路径、
 * 沙箱模式或提权开关（B-03）。
 *
 * ## 表是封闭的
 *
 * `LOCAL_ACCESS_OPERATIONS` 是唯一取值来源；表外的一律拒绝（`authorize` 走 `invalid-source` 之前
 * 就先判"不认识这个操作"）。新增能力必须显式登记 —— 默认拒绝。
 */

/** 一次本机访问是谁发起的。它决定"这个来源配不配做这件事"。 */
export type LocalAccessSource = 'panel' | 'audit-tool' | 'host-background'

/**
 * 封闭操作表。
 *
 * 命名口径：`<域>.<对象>.<动作>`。域与 capability 一一对应（`workbench.*` 除外 ——
 * 它是插件**自己的**状态文件，不属于员工授予的任何能力范围）。
 */
export type LocalAccessOperation =
  | 'workbench.state.write'
  | 'ifind.credential.read'
  | 'ifind.credential.write'
  | 'ifind.credential.clear'
  | 'ifind.credential.permission'
  | 'h3yun.session.status'
  | 'h3yun.session.login'
  | 'h3yun.session.bind'
  | 'h3yun.session.refresh'
  | 'h3yun.forms.read'
  | 'h3yun.records.read'
  | 'h3yun.files.read'
  | 'dws.auth.status'
  | 'dws.auth.login'
  | 'dws.profile.read'
  | 'dws.doctor.read'
  | 'dws.local.permission'
  | 'dws.local.permission.repair'
  | 'dws.knowledge.read'
  | 'dws.drive.read'
  | 'dws.drive.write'
  | 'dws.contact.read'
  | 'dws.message.write'
  | 'oss.config.read'
  | 'oss.config.write'
  | 'oss.config.permission'
  | 'oss.remote.read'
  | 'oss.remote.write'
  | 'system.browser.open'
  | 'system.clipboard.write'
  | 'system.case-file.open'

export interface LocalAccessDescriptor {
  /**
   * 需要员工授予的能力。
   *
   * `host-owned-state` **不是**员工授予的能力：它只覆盖插件自己的状态文件那**一个**路径，
   * 用来落盘授权收据与工作空间选择。它不能执行任何 shell 命令（见 `transport`）。
   */
  capability: LocalAccessCapability | 'host-owned-state'
  transport: 'shell' | 'filesystem'
  /**
   * 要不要为**这一次调用**显式声明 `sandboxPolicy: danger-full-access`。
   *
   * 判据只有一条：这条操作必须碰工作区之外的路径（钥匙串、`~/.dws`、`~/.ossutilconfig`、
   * 插件状态目录）或打开系统程序。其余一律走部署的默认沙箱 —— 能给最小权限就给最小。
   */
  privileged: boolean
  /**
   * 允许的来源。
   *
   * 判据是"这个来源**应不应该**做这件事"，不是"它能不能"：
   * - 登录类只给 `panel`：审核子代理永远不该替员工登录（C 子项目）；
   * - 业务读取给 `audit-tool`：审核链路要取数；
   * - 环境自检给的登录态探测给 `host-background`；
   * - 结果回传（OSS 上传 / 钉钉归档）既可能来自审核 Tool，也可能来自上传看门狗。
   */
  allowedSources: readonly LocalAccessSource[]
}

/** 只用于 `writeText` 的三个目标：每个操作只能写**它自己那一个**路径。 */
export type LocalAccessTargetKind = 'workbench-state' | 'ifind-credential' | 'oss-config'

/** 操作 → 允许写的目标种类。没登记的操作不允许写文件。 */
export const LOCAL_ACCESS_WRITE_TARGETS: Partial<Record<LocalAccessOperation, LocalAccessTargetKind>> = {
  'workbench.state.write': 'workbench-state',
  'ifind.credential.write': 'ifind-credential',
  'oss.config.write': 'oss-config',
}

/** 全部操作名（界面、测试与文档的单一来源）。 */
export const LOCAL_ACCESS_OPERATION_NAMES = [
  'workbench.state.write',
  'ifind.credential.read',
  'ifind.credential.write',
  'ifind.credential.clear',
  'ifind.credential.permission',
  'h3yun.session.status',
  'h3yun.session.login',
  'h3yun.session.bind',
  'h3yun.session.refresh',
  'h3yun.forms.read',
  'h3yun.records.read',
  'h3yun.files.read',
  'dws.auth.status',
  'dws.auth.login',
  'dws.profile.read',
  'dws.doctor.read',
  'dws.local.permission',
  'dws.local.permission.repair',
  'dws.knowledge.read',
  'dws.drive.read',
  'dws.drive.write',
  'dws.contact.read',
  'dws.message.write',
  'oss.config.read',
  'oss.config.write',
  'oss.config.permission',
  'oss.remote.read',
  'oss.remote.write',
  'system.browser.open',
  'system.clipboard.write',
  'system.case-file.open',
] as const satisfies readonly LocalAccessOperation[]

const PANEL: readonly LocalAccessSource[] = ['panel']
const PANEL_OR_BACKGROUND: readonly LocalAccessSource[] = ['panel', 'host-background']
const EVERY_SOURCE: readonly LocalAccessSource[] = ['panel', 'audit-tool', 'host-background']

/**
 * 唯一的描述表。
 *
 * `satisfies` + 逐项登记：新增一个操作名却忘了登记描述时 `typecheck` 直接红 ——
 * 这正是"封闭表"要拦住的那种静默放行。
 */
export const LOCAL_ACCESS_OPERATIONS = {
  // 插件自己的状态文件：不是员工授予的能力，只覆盖那一个固定路径，且不能跑命令。
  'workbench.state.write': {
    capability: 'host-owned-state', transport: 'filesystem', privileged: true, allowedSources: EVERY_SOURCE,
  },
  // iFinD 凭据：读取给审核链路（要取数），写与清除只给面板（员工自己的密钥，审核不许改）。
  'ifind.credential.read': {
    // 同上：`~/.dsh/crwu-workbench/ifind-credential.json` 也在工作区之外。
    capability: 'ifind-credential', transport: 'filesystem', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'ifind.credential.write': {
    capability: 'ifind-credential', transport: 'filesystem', privileged: true, allowedSources: PANEL,
  },
  'ifind.credential.clear': {
    capability: 'ifind-credential', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  // 凭据文件的"落到正确位置且权限正确"：建状态目录 + 收紧权限 + 回读模式位。
  // 单独成一个操作（而不是塞进文件写入）是因为它跑的是 **shell**：同一件事在两条通道上，
  // 谁在什么时候能跑必须一眼看得出来。
  'ifind.credential.permission': {
    capability: 'ifind-credential', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  // 氚云：整条链路都可能读/刷新操作系统凭据存储，所以都要求这个能力、都要提权。
  'h3yun.session.status': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true,
    allowedSources: PANEL_OR_BACKGROUND,
  },
  'h3yun.session.login': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  'h3yun.session.bind': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  // 主动续期（面板打开时顺手做一次）：同样要读钥匙串并回写，所以是特权 + 只给面板。
  'h3yun.session.refresh': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true,
    allowedSources: PANEL_OR_BACKGROUND,
  },
  'h3yun.forms.read': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'h3yun.records.read': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'h3yun.files.read': {
    capability: 'h3yun-credential-store', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  // 钉钉：`dws` 的 token 在 `~/.dws` 与系统钥匙串里，所以任何一条都可能要碰工作区外。
  'dws.auth.status': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: PANEL_OR_BACKGROUND,
  },
  'dws.auth.login': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  'dws.profile.read': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  // 只读健康检查（`dws doctor --json`）：与 `auth status` 同类，碰 `~/.dws` 与钥匙串。
  'dws.doctor.read': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: PANEL_OR_BACKGROUND,
  },
  // 本机目录的**只读**权限事实（模式位、所有者、可写性；Windows 上是 ACL 结论）。
  'dws.local.permission': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: PANEL_OR_BACKGROUND,
  },
  // 最小权限修复：**只给面板** —— 它要员工第二次显式确认，不是自动动作，
  // 也不该由审核子代理发起（设计 §3.4「不自动改操作系统权限」）。
  'dws.local.permission.repair': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  'dws.knowledge.read': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'dws.drive.read': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'dws.drive.write': {
    capability: 'dws-profile', transport: 'shell', privileged: true,
    allowedSources: ['panel', 'audit-tool'],
  },
  'dws.contact.read': {
    capability: 'dws-profile', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'dws.message.write': {
    capability: 'dws-profile', transport: 'shell', privileged: true,
    allowedSources: ['panel', 'audit-tool'],
  },
  // OSS：`ossutil` **每次**都会读 `~/.ossutilconfig`，所以远端动作也要算本机凭据访问。
  'oss.config.read': {
    // **特权**：`~/.ossutilconfig` 在工作区之外，受限沙箱下读不到 —— 读它必须逐次声明。
    capability: 'oss-config', transport: 'filesystem', privileged: true, allowedSources: PANEL_OR_BACKGROUND,
  },
  'oss.config.write': {
    capability: 'oss-config', transport: 'filesystem', privileged: true, allowedSources: PANEL,
  },
  'oss.config.permission': {
    capability: 'oss-config', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  'oss.remote.read': {
    capability: 'oss-config', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  'oss.remote.write': {
    capability: 'oss-config', transport: 'shell', privileged: true, allowedSources: EVERY_SOURCE,
  },
  // 系统集成：打开浏览器 / 剪贴板 / 在文件管理器里定位案例目录。只给面板。
  'system.browser.open': {
    capability: 'system-integration', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  'system.clipboard.write': {
    capability: 'system-integration', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
  'system.case-file.open': {
    capability: 'system-integration', transport: 'shell', privileged: true, allowedSources: PANEL,
  },
} as const satisfies Record<LocalAccessOperation, LocalAccessDescriptor>

/** 是不是一个登记过的操作名。表外的一律拒绝。 */
export function isLocalAccessOperation(value: unknown): value is LocalAccessOperation {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCAL_ACCESS_OPERATIONS, value)
}

/** 取描述；未登记返回 `undefined`（调用方按拒绝处理）。 */
export function localAccessDescriptorOf(operation: string): LocalAccessDescriptor | undefined {
  return isLocalAccessOperation(operation) ? LOCAL_ACCESS_OPERATIONS[operation] : undefined
}
