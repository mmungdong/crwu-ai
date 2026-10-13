import type { H3yunTask } from '../../host/integrations/h3yun/records.ts'
import type { OssItem } from '../../host/integrations/oss/parse.ts'
import type { OssBatchQueue } from '../../host/integrations/oss/batch.ts'
import type { AuditRecord } from '../../host/core/state/types.ts'
import type { AudRootHostType } from '../../host/domains/report-audit/root.ts'
import type { AuditRootView, AuditView, CloudItem, OssBatchIndexResult, TaskRow } from '../contracts/report-audit.ts'

/**
 * 报告审核的**编译期线协议契约**（没有运行时代码）。
 *
 * 每个常量都是一次赋值：把 Host 侧的内部类型赋给线协议类型。字段名或类型一漂移，
 * `npm run typecheck` 就红。
 *
 * 为什么值得单独一类文件：这类漂移的**运行期表现是空白** —— Client 读到 `undefined`
 * 就渲染成空，没有异常、没有日志，只有用户看到"列表是空的"。
 *
 * ⚠️ `OSS_BATCH_FROM_HOST` 的右侧曾经写成 `WorkbenchApi['ossBatchIndex']`，那是从
 * 报告审核的 Client 门面（现在是 `modules/report-audit/api.ts`） **反向**取类型。方向反了有两层坏处：
 * ① 契约层本该两端都不依赖、只被两端依赖，反向依赖会让"Client 改一个字段"悄悄放宽契约；
 * ② 打包形态上 Client 与 Host 分开构建，共享层引用 Client 类型是把两个边界缝在一起。
 * 现在用线协议自己的 `OssBatchIndexResult`（Client 那一侧本来就声明它返回这个类型）。
 */
export const TASK_ROW_FROM_HOST: (task: H3yunTask) => TaskRow = (task) => task
export const AUDIT_VIEW_FROM_HOST: (record: AuditRecord) => AuditView = (record) => record
export const CLOUD_ITEM_FROM_HOST: (item: OssItem) => CloudItem = (item) => item
export const OSS_BATCH_FROM_HOST: (result: Awaited<ReturnType<OssBatchQueue['run']>>) => OssBatchIndexResult =
  (result) => result
/** Host 侧对线协议类型的别名（`host/domains/report-audit/root.ts` 用它做赋值核对）。 */
export const AUDIT_ROOT_VIEW_FROM_HOST: (view: AudRootHostType) => AuditRootView = (view) => view
