import type { OperationMap } from './types.ts'
import type { IfindTransport } from '../integrations/ifind/mcp.ts'
import type { H3yunFormResolver } from '../integrations/h3yun/form.ts'
import type { PythonRuntimeResolver } from '../core/runtime/python.ts'
import type { LocalAccessBroker } from '../core/access/broker.ts'
import type { DiscussionScopeRegistry } from '../domains/report-audit/discussion-scope.ts'
import type { LocalAuditRegistry } from '../domains/local-audit/handoff.ts'
import type { LocalAuditFs } from '../domains/local-audit/scan.ts'
import type { SnapshotIo } from '../domains/local-audit/snapshot.ts'
import type { DwsDeviceLoginRegistry, LoginHandleHolder } from '../core/system/device-login.ts'

/**
 * 操作表的**注入面**（协议 32 · Task 3 从 `core.ts` 抽出）。
 *
 * 单独一个文件而不是塞进 `common.ts`：这两个类型是**调用方（`apply.ts`）与测试夹具**用的，
 * 而 `common.ts` 是操作层内部的共享依赖。混在一起会让"注入面"跟着内部实现一起变。
 */

/**
 * 可注入的替身（**只给测试与本地部署用**）。
 *
 * - `ifind.transport` 让单测用内存替身（永不访问真实网络）；
 * - `ifind.timeoutMs` 让单测用短超时；
 * - `auditTools` 让「必需 Tool 是否可见」这件事在自检里有真实事实（替身里也可以模拟收窄）。
 */
export interface CoreDeps {
  ifindTransport?: IfindTransport
  ifindTimeoutMs?: number
  auditTools?: (options: { refresh: boolean }) => Promise<{ missing: string[]; checked: boolean }>
  /** Task 4 的四个自助更新操作（由 `update/ops.ts` 组装）。 */
  update?: OperationMap
  /** 报告评估（房地产估值）的八个操作（协议 32）。 */
  valuation?: OperationMap
  /** 关闭某工作空间下已打开的估值工作流存储（清空工作空间前调用）。 */
  closeWorkspaceStores?: (workspacePath: string) => Promise<string[] | void>
}

export interface HostResolvers {
  /** 氚云表单 code 的实例级解析器（列表 / 审核启动 / 业务 Tool 共用）。 */
  form: H3yunFormResolver
  /** DSH 自带 Python 的实例级解析器（审核启动与环境页共用）。 */
  python: PythonRuntimeResolver
  /** **本地访问代理（协议 18）**：所有跨边界的调用都带着"操作 + 来源"交给它判。 */
  access: LocalAccessBroker
  /** 讨论会话的受限材料范围（协议 23）：`discussion-material-open` 写它，业务 Tool 读它。 */
  discussionScopes: DiscussionScopeRegistry
  /** 本地审核的一次性 handoff 与案例 scope（协议 28）。 */
  localAudit?: LocalAuditRegistry
  /** 本地审核扫描用的文件系统能力（测试注入内存替身）。 */
  localAuditFs?: LocalAuditFs
  /** 本地审核快照的 IO（测试注入内存替身）。 */
  localAuditIo?: SnapshotIo
  /** 钉钉设备流登录会话注册表（协议 32）。 */
  deviceLogin?: DwsDeviceLoginRegistry
  /** 正在运行的 loopback 登录句柄（协议 32）。 */
  loginHandles?: LoginHandleHolder
}
