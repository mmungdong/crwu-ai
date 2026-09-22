import { rpc } from '../../api/client.ts'
import type { AuditView, CloudItem, TaskRow } from '../../../shared/types.ts'
import type { Gating } from './types.ts'
import type { AuditRootView, EnvCheckView, IfindCheckView, ServiceCheckView } from '../../../shared/types.ts'

/**
 * 工作台的同源 RPC 门面。
 *
 * 为什么不让组件直接写 `rpc('pending', {...})`：操作名与参数形状是跨进程契约，
 * 散在组件里就没人能保证它和 Host 的 handler 对齐。集中在这里以后：
 * - 组件只调方法，拼错操作名会编译失败；
 * - 有一处可以对着 Host 的操作名单做一致性检查（见测试）。
 *
 * 注意**每个方法都只做类型标注**，不做字段改名：Host 返回什么字段，这里就声明什么字段。
 * 改名会让「Host 与 Client 的字段对不上」变成运行期才发现的静默问题。
 */

/** Host 返回的错误信封；各操作失败时都带 `ok: false` + `error`。 */
export interface RpcFailure {
  ok: false
  error: string
}

export interface BootResult {
  ok: boolean
  /**
   * 宿主插件的协议代数（见 shared/consts.ts）。
   *
   * 缺这个字段 = 旧构建（字段是后加的）。
   */
  protocol?: number
  /**
   * 宿主产物的版本指纹（`pkg-0.0.1`）与它的写入时间；缺这两个字段 = 旧宿主。
   * 面板标题旁就显示它 —— 用户报问题时先看这个号。
   */
  rev?: string
  builtAt?: string
  /**
   * 宿主包版本（`0.0.4` 这种，不带前缀）与它的运行形态。
   *
   * `buildKind` 是 `dev`（源码检出 / `link:` 安装）或 `installed`（装好的 TGZ / npm 包）——
   * 侧栏入口那枚小标签就显示它（dev 显示「dev」，否则显示具体版本）。
   * 缺这两个字段 = 旧宿主：界面只显示 `rev` 去掉前缀后的兜底值，不谎报形态。
   */
  version?: string
  buildKind?: 'dev' | 'installed'
  caseRoot: string
  home: string
  formName: string
  parentSessionId: string
  workspace: { chosen: boolean; path: string; title: string; id: string; source: string; missing: boolean }
  /**
   * 审核子代理的挂载点（建在工作空间里的顶层会话）。
   *
   * 可选：老版本 Host 不带这个字段，界面按「尚未创建」显示即可，不该因此崩掉。
   */
  auditRoot?: AuditRootView
  active: { key: string; childId: string; since: number }
  ported: { done: string[]; todo: string[] }
}

export interface EnvResult {
  ok: boolean
  manifestSource: string
  manifestKind: string
  manifestLoaded: boolean
  manifestError: string
  manifestUpdatedAt: string
  installDocUrl: string
  checks: EnvCheckView[]
  ifindKey: IfindCheckView
  services: ServiceCheckView[]
  blocked: string[]
  allOk: boolean
  home: string
  platform: string
  trust: { credentials: boolean }
  workspace: BootResult['workspace']
  /** 审核子代理的挂载点；老版本 Host 不带这个字段（见 BootResult.auditRoot）。 */
  auditRoot?: AuditRootView
  sessionWorkspace: { parentSessionId: string; sessionCwd: string; workspaceId: string; workspacePath: string; workspaceTitle: string }
  oss: Record<string, unknown>
  ossCred: { path: string; exists: boolean; endpoint: string; accessKeyIdMasked: string; hasSecret: boolean; hasSts: boolean; language: string }
  /**
   * 「我是谁」：面板头部那句「晚上好，某某某」的姓名，来自**同一次自检**里的钉钉 CLI。
   * 三个字段都可能是空串（没授权 / 没登录 / 命令没跑起来）→ 界面**整句不展示**。
   */
  me: { name: string; org: string; userId: string }
}

export interface PendingResult {
  ok: boolean
  error: string
  rows: TaskRow[]
  formName: string
  page: number
  size: number
  total: number
  query: string
  filterMode: string
  escalated: boolean
  escalateAvailable: boolean
}

export interface AuditStatusResult {
  ok: boolean
  audits: AuditView[]
  parentSessionId: string
  active: { key: string; childId: string; since: number }
}

export interface OssIndexResult {
  ok: boolean
  error: string
  bucket: string
  prefix: string
  count: number
  items: Record<string, CloudItem>
  truncated: boolean
}

export interface ReportFilesResult {
  ok: boolean
  error: string
  seqNo: string
  /** 氚云附件（权威来源：这份报告该有哪些文件；只元数据、不下载）。 */
  h3yun: Array<{ field: string; fileId: string; name: string; size: number; contentType: string }>
  /** 氚云那一路失败的原因（不影响本地/云端两组照常显示）。 */
  h3yunError: string
  /** 云端对象（只列举，不下载）。 */
  oss: Array<{ key: string; name: string }>
  /** 本地案例目录里的文件（名字 + 绝对路径 + 字节数）。 */
  local: Array<{ name: string; path: string; size: number }>
  /** 本地案例目录的绝对路径；空串 = 还没选定工作空间。 */
  localDir: string
  /** 本地是否真的存在这个案例目录（"不存在"与"存在但空"要分开说）。 */
  localExists: boolean
  truncated: boolean
}

export interface OssResultResult {
  ok: boolean
  error: string
  key: string
  info: Record<string, unknown> | null
}

export interface OssLinkResult {
  ok: boolean
  error: string
  url: string
  mode: string
  ttl: number
  opened: boolean
  openError: string
}

export interface StartResult {
  ok: boolean
  error: string
  childId: string
  provider: string
  parentSessionId: string
  isRetry: boolean
  replaced: string
  replacedCount: number
  startedAt: string
  attempt: number
}

export interface StopResult {
  ok: boolean
  error: string
  key: string
  errors: string[]
}

export interface SimpleResult {
  ok: boolean
  error: string
}

/** 带类型的调用集合。每个方法对应 Host 的一个 `workbench:*` handler。 */
export interface WorkbenchApi {
  boot: () => Promise<BootResult>
  env: () => Promise<EnvResult>
  pending: (args: { query?: string; page?: number; size?: number; escalate?: boolean }) => Promise<PendingResult>
  auditStatus: (args?: { keys?: string[]; parentSessionId?: string }) => Promise<AuditStatusResult>
  auditStart: (args: { key: string; seqNo?: string; objectId?: string; project?: string; retry?: boolean }) => Promise<StartResult>
  auditStop: (args?: { childId?: string }) => Promise<StopResult>
  /** 一份报告的全部相关文件（只列举、不下载）：面板一打开就查，见 AssistantPanel。 */
  reportFiles: (args: { seqNo: string; objectId?: string }) => Promise<ReportFilesResult>
  ossIndex: (args?: { seqNo?: string }) => Promise<OssIndexResult>
  ossResult: (args: { key: string }) => Promise<OssResultResult>
  ossLink: (args: { key: string }) => Promise<OssLinkResult>
  ossUpload: (args: { key: string }) => Promise<{ ok: boolean; error: string }>
  ossCred: () => Promise<{ ok: boolean; cred: EnvResult['ossCred'] }>
  ossCredSave: (args: { accessKeyId: string; accessKeySecret: string; stsToken?: string; endpoint?: string }) => Promise<Record<string, unknown>>
  workspace: (args: { path: string; title?: string; id?: string }) => Promise<Record<string, unknown>>
  workspaceAuto: () => Promise<Record<string, unknown>>
  bindSession: (args: { sessionId: string }) => Promise<Record<string, unknown>>
  trust: (args: { credentials: boolean }) => Promise<Record<string, unknown>>
  installPrompt: (args: { workspace?: string }) => Promise<{ ok: boolean; url: string; prompt: string }>
  session: () => Promise<{ ok: boolean; error: string; session: { userId: string; expiresAt: string; expiresIn: string } | null }>
  relogin: () => Promise<SimpleResult & { stdoutTail?: string; stderrTail?: string }>
  dwsLogin: (args?: { device?: boolean }) => Promise<SimpleResult & { stdoutTail?: string; stderrTail?: string }>
  clipboard: (args: { text: string }) => Promise<SimpleResult>
  openPath: (args: { path: string }) => Promise<SimpleResult & { path: string }>
  crwu: (args: { argv: string[]; workdir?: string; timeoutMs?: number; escalate?: boolean }) => Promise<Record<string, unknown>>
}

/** 把 Host 的应答转成声明的返回类型；失败信封（`ok: false`）交给调用方判断。 */
async function call<T>(operation: string, args?: unknown): Promise<T> {
  return await rpc(operation, args ?? {}) as unknown as T
}

export const workbenchApi: WorkbenchApi = {
  boot: () => call('boot'),
  env: () => call('env'),
  pending: (args) => call('pending', args),
  auditStatus: (args) => call('audit-status', args),
  auditStart: (args) => call('audit-start', args),
  auditStop: (args) => call('audit-stop', args),
  reportFiles: (args) => call('report-files', args),
  ossIndex: (args) => call('oss-index', args ?? {}),
  ossResult: (args) => call('oss-result', args),
  ossLink: (args) => call('oss-link', args),
  ossUpload: (args) => call('oss-upload', args),
  ossCred: () => call('oss-cred'),
  ossCredSave: (args) => call('oss-cred-save', args),
  workspace: (args) => call('workspace', args),
  workspaceAuto: () => call('workspace-auto'),
  bindSession: (args) => call('bind-session', args),
  trust: (args) => call('trust', args),
  installPrompt: (args) => call('install-prompt', args),
  session: () => call('session'),
  relogin: () => call('relogin'),
  dwsLogin: (args) => call('dws-login', args),
  clipboard: (args) => call('clipboard', args),
  openPath: (args) => call('open-path', args),
  crwu: (args) => call('crwu', args),
}

/**
 * 方法名 → Host 操作名。
 *
 * 导出出来是为了让测试能**双向**核对：门面里的每个方法都要有对应的 Host handler，
 * 反之亦然。少一个的表现是点下去 404，而界面只会显示「未知 op」。
 */
export const OPERATION_OF: Record<keyof WorkbenchApi, string> = {
  boot: 'boot',
  env: 'env',
  pending: 'pending',
  auditStatus: 'audit-status',
  auditStart: 'audit-start',
  auditStop: 'audit-stop',
  reportFiles: 'report-files',
  ossIndex: 'oss-index',
  ossResult: 'oss-result',
  ossLink: 'oss-link',
  ossUpload: 'oss-upload',
  ossCred: 'oss-cred',
  ossCredSave: 'oss-cred-save',
  workspace: 'workspace',
  workspaceAuto: 'workspace-auto',
  bindSession: 'bind-session',
  trust: 'trust',
  installPrompt: 'install-prompt',
  session: 'session',
  relogin: 'relogin',
  dwsLogin: 'dws-login',
  clipboard: 'clipboard',
  openPath: 'open-path',
  crwu: 'crwu',
}

/** 报告页需要的门禁：氚云与钉钉都认证通过才能发起审核。 */
export function gatingOf(env: EnvResult | null, activeKey: string, patch: Partial<Gating> = {}): Gating {
  const services = env?.services ?? []
  const ready = (id: string): boolean => services.some((service) => service.id === id && service.ok)
  return {
    canDispatch: ready('h3yun') && ready('dingtalk'),
    canStart: activeKey === '',
    ...patch,
  }
}
