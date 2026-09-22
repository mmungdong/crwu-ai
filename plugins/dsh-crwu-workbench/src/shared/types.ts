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

/** 二进制探测结果。 */
export interface EnvCheckView {
  name: string
  command: string
  required: boolean
  note: string
  found: boolean
  path: string
  versionText: string
  actual: string
  expect: string
  ok: boolean
  reason: string
  url: string
  sha256: string
  target: string
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
