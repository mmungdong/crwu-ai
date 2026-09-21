/**
 * 线协议的**编译期契约检查**（没有运行时代码）。
 *
 * 这里做的事只有一件：把 Host 侧的内部类型赋值给 `shared/types.ts` 里的线协议类型。
 * 只要两边的字段名或类型漂移，`npm run typecheck` 就会失败。
 *
 * 为什么值得单独一个文件：这类漂移的**运行期表现是空白**（Client 读到 undefined 就渲染成空），
 * 没有异常、没有日志，只有用户看到「列表是空的」。所以必须在编译期挡住。
 *
 * Host 侧的内部类型**允许比线协议多字段**（多出来的不上线即可），但不允许少字段或类型不兼容。
 * 操作级的返回类型（boot / pending / audit-status 的整个信封）目前由 handler 直接构造字面量，
 * 没有独立的 Host 类型可对照；它们的字段靠 `tests/unit/client-report-rules.test.mjs` 与
 * Host 侧测试双向钉住。
 */

import type { EnvCheck, IfindCheck, ServiceCheck } from '../host/environment/probe.ts'
import type { H3yunTask } from '../host/h3yun/records.ts'
import type { OssItem } from '../host/oss/parse.ts'
import type { AuditRecord } from '../host/state/types.ts'
import type { AudRootHostType } from '../host/audit/root.ts'
import type { AuditRootView, AuditView, CloudItem, EnvCheckView, IfindCheckView, ServiceCheckView, TaskRow, WorkspaceView } from './types.ts'

/** 赋值本身就是检查：不兼容会在 typecheck 阶段报错。 */
export const TASK_ROW_FROM_HOST: (task: H3yunTask) => TaskRow = (task) => task
export const AUDIT_VIEW_FROM_HOST: (record: AuditRecord) => AuditView = (record) => record
export const CLOUD_ITEM_FROM_HOST: (item: OssItem) => CloudItem = (item) => item
export const ENV_CHECK_FROM_HOST: (check: EnvCheck) => EnvCheckView = (check) => check
export const SERVICE_CHECK_FROM_HOST: (check: ServiceCheck) => ServiceCheckView = (check) => check
export const IFIND_CHECK_FROM_HOST: (check: IfindCheck) => IfindCheckView = (check) => check
export const WORKSPACE_VIEW_FROM_HOST: (view: WorkspaceView) => WorkspaceView = (view) => view
export const AUDIT_ROOT_VIEW_FROM_HOST: (view: AudRootHostType) => AuditRootView = (view) => view
