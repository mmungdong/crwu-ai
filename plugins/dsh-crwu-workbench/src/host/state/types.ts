import type { ChildHandle } from '../audit/spawn.ts'
import type { EnvManifest } from '../environment/manifest-default.ts'

/** 单条审核运行记录。 */
export interface AuditRecord {
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
  /** 被本次重启替换掉的旧 childId（界面据此提示「已重启」）。 */
  replacedChildId?: string
  resultFile: string
  htmlFile: string
  caseName: string
  uploadedAt: string
  uploadError: string
  ossPrefix: string
  attempt: number
  childAlive?: boolean
  adopted?: boolean
  /** 该记录对应的密钥上传状态；`uploading` 是运行态，只在新记录里出现，不落盘。 */
  uploading?: boolean
  /** 界面上显示的当前活动（子代理 activity），仅当次查询有效。 */
  activity?: string
}

/** Host 插件实例的进程内状态。 */
export interface WorkbenchState {
  /** 当前有效清单：激活时由内置清单叠加 YAML，env 自检后再补入远程环境信息。 */
  manifest: EnvManifest
  caseRoot: string
  workspacePath: string
  workspaceTitle: string
  workspaceSource: string
  workspaceChosen: boolean
  /** 用户选过、但目录已经不在了：阻塞项，界面要求重选（不回落清单偏好）。 */
  workspaceMissing: boolean
  /** 工作空间注册表里的 id（用于回写与显示）。 */
  workspaceId: string
  /** 审核记录是否已从磁盘恢复（每个实例一次）。 */
  registryLoaded: boolean
  /** 正在创建中的任务标识；非空即拒绝新的创建请求（防重复点击并发起两条）。 */
  startingKey: string
  /** childId → 活的进程内句柄；绝不进任何 JSON 返回值。 */
  runs: Record<string, ChildHandle>
  parentSessionId: string
  /**
   * 审核根会话（子代理的挂载点）。
   *
   * 稳定优先：可用就一直用它，所有审核子代理整齐挂在同一棵树下；不可用就新建一个
   * （用户已确认接受分叉）。落盘是为了跨进程复用同一个根。
   */
  auditRoot: { workspacePath: string; sessionId: string; title: string; assignedAt: string }
  /**
   * 「信任本插件读取本机凭据」（氚云会话 / 钉钉登录态）。**一次授权、长期有效**：
   * 写入 `~/.dsh/crwu-workbench.json`，重启 profile 后仍生效（2026-09-22 用户口径）。
   * 没有它 = 读凭据的命令不被允许提权 → 环境自检把「需要授权」算作阻塞项，插件不可用。
   */
  trustCredentials: boolean
  /** 氚云表单「报告审核」的 code，首次定位后缓存（定位一次要 60 秒）。 */
  formCode: string
  /** 表单显示名，界面用。 */
  formName: string
  audits: Record<string, AuditRecord>
  activeKey: string
  activeChildId: string
  activeSince: number
}
