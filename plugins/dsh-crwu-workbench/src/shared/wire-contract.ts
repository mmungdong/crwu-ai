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
 * `boot` / `pending` / `audit-status` 这类由 handler 直接构造字面量的应答没有独立的 Host 类型，
 * 它们的字段靠 `tests/unit/client-report-rules.test.mjs` 与 Host 侧测试双向钉住。
 */

import type { IfindCheck, PackageIntegrityCheck, ServiceCheck } from '../host/environment/probe.ts'
import type { EnvResult } from '../host/environment/ops.ts'
import type { OssCredView as HostOssCredView } from '../host/oss/cred.ts'
import type { H3yunTask } from '../host/h3yun/records.ts'
import type { OssItem } from '../host/oss/parse.ts'
import type { AuditRecord } from '../host/state/types.ts'
import type { AudRootHostType } from '../host/audit/root.ts'
import type {
  AuditRootView, AuditView, CloudItem, EnvResultView, IfindCheckView,
  OssCredView, PackageIntegrityView, ServiceCheckView, TaskRow, WorkspaceView,
} from './types.ts'

/** 赋值本身就是检查：不兼容会在 typecheck 阶段报错。 */
export const TASK_ROW_FROM_HOST: (task: H3yunTask) => TaskRow = (task) => task
export const AUDIT_VIEW_FROM_HOST: (record: AuditRecord) => AuditView = (record) => record
export const CLOUD_ITEM_FROM_HOST: (item: OssItem) => CloudItem = (item) => item
export const PACKAGE_INTEGRITY_FROM_HOST: (check: PackageIntegrityCheck) => PackageIntegrityView = (check) => check
export const SERVICE_CHECK_FROM_HOST: (check: ServiceCheck) => ServiceCheckView = (check) => check
export const IFIND_CHECK_FROM_HOST: (check: IfindCheck) => IfindCheckView = (check) => check
export const OSS_CRED_VIEW_FROM_HOST: (view: HostOssCredView) => OssCredView = (view) => view
export const WORKSPACE_VIEW_FROM_HOST: (view: WorkspaceView) => WorkspaceView = (view) => view
export const AUDIT_ROOT_VIEW_FROM_HOST: (view: AudRootHostType) => AuditRootView = (view) => view
/** `env` 的整个信封：六块分区少一块、或某块字段漂移，这里就红。 */
export const ENV_RESULT_FROM_HOST: (env: EnvResult) => EnvResultView = (env) => env
