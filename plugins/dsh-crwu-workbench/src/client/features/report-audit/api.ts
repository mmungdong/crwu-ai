import { rpc } from '../../api/client.ts'
import { createUpdateApi, UPDATE_METHOD_OPERATION, type UpdateApi } from '../update/api.ts'
import type { AuditView, CloudItem, CredentialPermission, TaskRow } from '../../../shared/types.ts'
import type { Gating } from './types.ts'
import type {
  AccessDiagnosticsView, AuditRootView, DwsLocalDoctorView, DwsLocalRepairView, EnvResultView,
} from '../../../shared/types.ts'
import type { LocalAccessConsentView } from '../../../shared/access/types.ts'
import {
  blockerMessages, degradedMessages, primaryUserIssue, requiredTallyOf, statusProceedable,
  type EnvironmentIssueView, type EnvironmentTally, type EnvironmentStateView,
} from '../../../shared/environment/model.ts'

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
 *
 * 自助更新（协议 16）那四个方法不在这里手写：它们来自 `features/update/api.ts`，并由
 * `OPERATION_OF` 组合进同一张 Client→Host 操作清单。更新响应要走**运行时收窄**
 * （`parseUpdateResponse`）之后才进 UI 状态，所以那四个方法返回的是未收窄的 `unknown`。
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
  /**
   * 宿主实际执行的**权限说明版本**（协议 18）；缺这个字段 = 旧宿主，
   * 界面必须按「不一致」处理（旧宿主的授权语义是布尔值，执行不了新范围）。
   */
  permissionSchemaVersion?: number
  /** 宿主当前的授权收据视图（协议 18）；旧宿主没有这个字段。 */
  localAccess?: LocalAccessConsentView
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

/**
 * `env` 的应答：**直接就是线协议类型**（`shared/types.ts` 的 `EnvResultView`）。
 *
 * 以前这里手写一份形状，于是「Host 加了字段、客户端没跟上」只能靠人对着改；现在两处是同一个声明，
 * Host 侧的类型由 `shared/wire-contract.ts` 在 typecheck 阶段强制可赋值过来。
 */
export type EnvResult = EnvResultView

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
  /**
   * 现在能不能启动下一条审核（F4，**Host 权威**）。
   *
   * 缺字段 = 未知：客户端**不许**用 `status !== 'running'` 之类的本地事实推断，
   * 也不许把未知当成"可以启动"去发新的审核请求。
   */
  canStartNext?: boolean
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
  /** 云端对象（只列举，不下载）；长格式下带 size / lastModified / etag。 */
  oss: Array<{ key: string; name: string; size?: number; lastModified?: string; etag?: string }>
  /** 本地案例目录里的文件（名字 + 绝对路径 + 字节数 + DSH fs 版本令牌）。 */
  local: Array<{ name: string; path: string; size: number; version?: string }>
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

/**
 * 带类型的调用集合。每个方法对应 Host 的一个 `workbench:*` handler。
 *
 * 更新那四个方法来自 `features/update/api.ts`（`UpdateApi`）——门面在这里**组合**，
 * 操作名只有一份（`UPDATE_METHOD_OPERATION`），不在这里再手写字符串。
 */
export interface WorkbenchApi extends UpdateApi {
  boot: () => Promise<BootResult>
  /** `refresh: true` 由界面「重新自检」传：让宿主刷新 DSH 自带运行时的缓存。 */
  env: (args?: { refresh?: boolean }) => Promise<EnvResult>
  pending: (args: { query?: string; page?: number; size?: number }) => Promise<PendingResult>
  auditStatus: (args?: { keys?: string[]; parentSessionId?: string }) => Promise<AuditStatusResult>
  auditStart: (args: { key: string; seqNo?: string; objectId?: string; project?: string; retry?: boolean }) => Promise<StartResult>
  auditStop: (args?: { childId?: string }) => Promise<StopResult>
  /** 一份报告的全部相关文件（只列举、不下载）：面板一打开就查，见 AssistantPanel。 */
  reportFiles: (args: { seqNo: string; objectId?: string }) => Promise<ReportFilesResult>
  ossIndex: (args?: { seqNo?: string }) => Promise<OssIndexResult>
  ossResult: (args: { key: string }) => Promise<OssResultResult>
  ossLink: (args: { key: string }) => Promise<OssLinkResult>
  ossUpload: (args: { key: string }) => Promise<{ ok: boolean; error: string }>
  ossCred: () => Promise<{ ok: boolean; cred: EnvResult['delivery']['ossCred'] }>
  ossCredSave: (args: { accessKeyId: string; accessKeySecret: string; stsToken?: string; endpoint?: string }) => Promise<Record<string, unknown>>
  workspace: (args: { path: string; title?: string; id?: string }) => Promise<Record<string, unknown>>
  workspaceAuto: () => Promise<Record<string, unknown>>
  bindSession: (args: { sessionId: string }) => Promise<Record<string, unknown>>
  /**
   * 允许工作台访问本机账号和配置（协议 18）。
   *
   * 提交的是**当前版本的规范能力清单**（由 `consentRequestCapabilities()` 生成），不是布尔值：
   * Host 会逐字核对清单，被改过的客户端无法提交一个与界面不同的范围。
   */
  localAccessGrant: (args: { schemaVersion: number; capabilities: string[] }) => Promise<LocalAccessResult>
  /** 撤销本机访问（写一个空能力集合的墓碑）。 */
  localAccessRevoke: () => Promise<LocalAccessResult>
  session: () => Promise<{ ok: boolean; error: string; session: { userId: string; expiresAt: string; expiresIn: string } | null }>
  /**
   * 最近的本机访问诊断（协议 18 · B3）。**只读、零副作用、脱敏**。
   *
   * 给「开发者诊断」：验收要求每一行失败都能给出"操作名 / 来源 / 请求·解析·实际模式 /
   * 被拒与否 / runner 是否挂 / 归因类别 / 失败发生在进程创建之前还是之后"——
   * 这些事实只有这里拿得到。
   */
  accessDiagnostics: () => Promise<AccessDiagnosticsView>
  /**
   * DWS 本机目录只读体检（协议 18 · D2）。**不接受路径** —— 目录由 Host 推导。
   *
   * 返回的是脱敏事实（模式位 / 两个布尔 / 凭据存储状态 / 归因类别），
   * 没有 ACL 条目、账户名、钥匙串条目名或原始 `dws doctor` 输出。
   */
  dwsLocalDoctor: () => Promise<DwsLocalDoctorView>
  /**
   * 最小权限修复（协议 18 · D3）：**必须带 `confirm: true`**，且只在面板上二次确认后调用。
   *
   * 服务端还会再判一次：结论必须是"本机文件权限问题"，且所有者是当前账户。
   */
  dwsLocalPermissionRepair: (args: { confirm: true }) => Promise<DwsLocalRepairView>
  relogin: () => Promise<SimpleResult & { timedOut?: boolean; stdoutTail?: string; stderrTail?: string }>
  dwsLogin: (args?: { device?: boolean }) => Promise<SimpleResult & { timedOut?: boolean; stdoutTail?: string; stderrTail?: string }>
  clipboard: (args: { text: string }) => Promise<SimpleResult>
  openPath: (args: { path: string }) => Promise<SimpleResult & { path: string }>
  crwu: (args: { argv: string[]; workdir?: string; timeoutMs?: number }) => Promise<Record<string, unknown>>
  /** iFinD 凭据的脱敏状态（**没有明文**）。 */
  ifindStatus: () => Promise<IfindStatusResult>
  /** 保存 SK：Host 校验 → 写盘（0600）→ 收紧权限 → **立刻真实探测**。 */
  ifindCredentialSave: (args: { secret: string }) => Promise<IfindSaveResult>
  /** 清除 API-Key（不可撤销，界面必须二次确认）。 */
  ifindCredentialClear: (args: { confirm: boolean }) => Promise<{ ok: boolean; error: string; cleared: boolean; path: string }>
  /** 只做一次真实探测（保存之后的复检 / 界面上的「重新验证」）。 */
  ifindProbe: (args?: { serverType?: string }) => Promise<IfindProbeResult>
}

/**
 * 一次真实探测的结论。
 *
 * `state` 与 `errorKind` 是两件事：前者给界面说「现在处于哪一态」，后者给处置用
 * （`credential` 要重填、`entitlement` 要找管理员、`infrastructure` 要查网络）。
 */
export interface IfindProbeResult {
  ok: boolean
  state: string
  errorKind: string
  error: string
  toolCount: number
  toolNames: string[]
  protocolVersion: string
  checkedAt: string
  /** **真的取到数据了吗**（`tools/call` 成功返回内容）；`ok` 只代表认证通过。 */
  dataVerified: boolean
  /** 取数验证用的工具名。 */
  dataTool: string
  /** 取数结果的**脱敏**短摘要（最多 300 字符）。 */
  dataSample: string
  path?: string
}

/**
 * 授权/撤销的应答。
 *
 * `consent` 是**落盘回读后**的收据视图（不是"我们打算写什么"）：写盘失败时它仍是旧状态，
 * 界面据此显示「没有获得权限」而不是一句成功提示。
 */
export interface LocalAccessResult {
  ok: boolean
  error: string
  consent: LocalAccessConsentView
  permissionSchemaVersion?: number
}

export interface IfindStatusResult extends IfindProbeResult {
  credential: { path: string; exists: boolean; state: string; length: number; reason: string }
}

export interface IfindSaveResult {
  ok: boolean
  error: string
  errorKind: string
  view: { path: string; exists: boolean; state: string; length: number; reason: string }
  /** 凭据文件的权限结论（协议 17）：`verified` / `inherited` / `failed`。 */
  permission: CredentialPermission
  mode: string
  probe: IfindProbeResult
}

/** 把 Host 的应答转成声明的返回类型；失败信封（`ok: false`）交给调用方判断。 */
async function call<T>(operation: string, args?: unknown): Promise<T> {
  return await rpc(operation, args ?? {}) as unknown as T
}

export const workbenchApi: WorkbenchApi = {
  // 四个更新方法（零参数、只发 {}）；实现与收窄都在 features/update/ 里。
  ...createUpdateApi(),
  boot: () => call('boot'),
  env: (args) => call('env', args),
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
  localAccessGrant: (args) => call('local-access-grant', args),
  localAccessRevoke: () => call('local-access-revoke', {}),
  session: () => call('session'),
  accessDiagnostics: () => call('access-diagnostics'),
  dwsLocalDoctor: () => call('dws-local-doctor'),
  dwsLocalPermissionRepair: (args) => call('dws-local-permission-repair', args),
  relogin: () => call('relogin'),
  dwsLogin: (args) => call('dws-login', args),
  clipboard: (args) => call('clipboard', args),
  openPath: (args) => call('open-path', args),
  crwu: (args) => call('crwu', args),
  ifindStatus: () => call('ifind-status'),
  ifindCredentialSave: (args) => call('ifind-credential-save', args),
  ifindCredentialClear: (args) => call('ifind-credential-clear', args),
  ifindProbe: (args) => call('ifind-probe', args ?? {}),
}

/**
 * 方法名 → Host 操作名。
 *
 * 导出出来是为了让测试能**双向**核对：门面里的每个方法都要有对应的 Host handler，
 * 反之亦然。少一个的表现是点下去 404，而界面只会显示「未知 op」。
 */
export const OPERATION_OF: Record<keyof WorkbenchApi, string> = {
  // 更新四个操作：从更新模块的派生映射组合进来（操作名来自共享常量，这里不重写）。
  ...UPDATE_METHOD_OPERATION,
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
  localAccessGrant: 'local-access-grant',
  localAccessRevoke: 'local-access-revoke',
  session: 'session',
  accessDiagnostics: 'access-diagnostics',
  dwsLocalDoctor: 'dws-local-doctor',
  dwsLocalPermissionRepair: 'dws-local-permission-repair',
  relogin: 'relogin',
  dwsLogin: 'dws-login',
  clipboard: 'clipboard',
  openPath: 'open-path',
  crwu: 'crwu',
  ifindStatus: 'ifind-status',
  ifindCredentialSave: 'ifind-credential-save',
  ifindCredentialClear: 'ifind-credential-clear',
  ifindProbe: 'ifind-probe',
}

/**
 * 报告页需要的门禁。
 *
 * **判据来自统一环境模型**（`env.state.capabilities.auditCore`），不再由客户端自己拼
 * 「氚云 ok && 钉钉 ok」—— 那样漏掉工作空间 / 授权 / 包 / 运行时 / Tool 中的任何一条，
 * 界面就会放行一个 Host 必然拒绝的操作（用户看到的是"点了没反应"）。
 *
 * 旧宿主没有 `state`：退回「两个服务都 ok」这条较弱的判据（它至少不会比原来更松）。
 */
export function gatingOf(env: EnvResult | null, activeKey: string, patch: Partial<Gating> = {}): Gating {
  const state = env === null ? null : environmentStateOf(env)
  const canDispatch = state === null
    ? (env?.services ?? []).filter((service) => service.ok).length === (env?.services ?? []).length
      && (env?.services ?? []).length > 0
    : state.capabilities.auditCore === true
  return {
    canDispatch,
    canStart: activeKey === '',
    ...patch,
  }
}

/**
 * 取统一环境模型。
 *
 * 旧宿主不带 `state` 时返回 `null`（界面按"不认识 → 不放行"处理）—— 这正是协议号存在的意义：
 * 界面是新的、宿主是旧的时，宁可拦下来让用户重启 profile，也不能按旧逻辑放行新操作。
 */
export function environmentStateOf(env: EnvResult | null | undefined): EnvironmentStateView | null {
  if (env === null || env === undefined) return null
  const state = env.state
  if (state === null || state === undefined || typeof state !== 'object') return null
  return state
}

/** 环境页顶部的结论卡需要的全部派生值（一处算清，组件只画）。 */
export interface EnvironmentHeadline {
  status: string
  proceed: boolean
  passed: number
  total: number
  ratio: number
  blockers: string[]
  degraded: string[]
  /** 员工唯一该做的那一件事（系统/管理员故障不给员工派活）。 */
  primary: EnvironmentIssueView | null
}

export function headlineOf(env: EnvResult | null | undefined): EnvironmentHeadline {
  const state = environmentStateOf(env)
  if (state === null) {
    return {
      status: 'unknown', proceed: false, passed: 0, total: 0, ratio: 0,
      blockers: env?.blocked ?? [], degraded: [], primary: null,
    }
  }
  const tally: EnvironmentTally = requiredTallyOf({ systemHealth: state.systemHealth, userSetup: state.userSetup })
  return {
    status: state.status,
    proceed: statusProceedable(state.status),
    passed: tally.passed,
    total: tally.total,
    ratio: tally.ratio,
    blockers: blockerMessages(state),
    degraded: degradedMessages(state),
    primary: primaryUserIssue(state),
  }
}
