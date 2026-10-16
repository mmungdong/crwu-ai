import { rpc } from '../../core/rpc.ts'
import type {
  AccessDiagnosticsView, DwsLocalDoctorView, DwsLocalRepairView, EnvResultView,
} from '../../../shared/contracts/index.ts'
import type {
  EnvironmentBootView, IfindProbeResult, IfindSaveResult, IfindStatusResult, LocalAccessResult, SimpleResult,
} from './model/types.ts'

/**
 * **环境信息**模块的业务 API（协议 32 · Task 3）。
 *
 * ## 为什么这一层要独立
 *
 * 原先环境页的全部调用都写在 `modules/report-audit/api.ts` 里。那不是"复用"，是**方向反了**：
 * 环境页是修复入口（工作区没就绪时它是唯一能进的页面），却要依赖报告审核的门面 ——
 * 审核门面动一个字段，环境页就跟着变。方案 §4.1 把这条列为禁止项。
 *
 * 现在环境相关的操作在这里，报告审核那一份只保留审核操作（并转出这里的名字，
 * 迁移期旧导入路径不断）。**依赖方向：环境 ← 审核**，不再反过来。
 *
 * ⚠️ 这里的每个方法都是**客户端**的：读环境事实、选工作区、授予/撤销本机访问、体检与修复
 * DWS 目录、读 iFinD 凭据状态。真正的权限判定在 Host 的 Broker 里 —— 界面禁用不是边界。
 */

/** `env` 的应答类型（线协议视图）。 */
export type EnvResult = EnvResultView
export type { EnvironmentBootView, IfindProbeResult, IfindSaveResult, IfindStatusResult, LocalAccessResult, SimpleResult }

/** 登录类操作的应答（可能带宿主的超时/沙箱提示）。 */
export type LoginResult = SimpleResult & {
  timedOut?: boolean
  stdoutTail?: string
  stderrTail?: string
  sandboxBlocked?: boolean
  advice?: string
}

/**
 * 把 Host 的应答转成声明的返回类型。
 *
 * **一处转型**：`rpc()` 回的是 `Record<string, unknown>`（同源 HTTP 的原始形状），
 * 每个方法各自 `as unknown as T` 会把转型撒得到处都是，也没法统一加校验。
 * 失败信封（`ok: false`）交给调用方判断 —— 与报告审核门面同一条口径。
 */
async function call<T>(operation: string, args?: unknown): Promise<T> {
  return await rpc(operation, args ?? {}) as unknown as T
}

export const environmentApi = {
  // `boot` 的应答在 Host 侧是同一个信封；这里只声明**环境那一半**（审核那一半由审核门面补全）。
  boot: () => call<EnvironmentBootView>('boot', {}),
  env: (args?: { refresh?: boolean }) => call<EnvResult>('env', args ?? {}),
  workspace: (args: { path: string; title?: string; id?: string }) => call<Record<string, unknown>>('workspace', args),
  workspaceAuto: () => call<Record<string, unknown>>('workspace-auto', {}),
  localAccessGrant: (args: { schemaVersion: number; capabilities: string[] }) =>
    call<LocalAccessResult>('local-access-grant', args),
  localAccessRevoke: () => call<LocalAccessResult>('local-access-revoke', {}),
  session: () => call<{ ok: boolean; error: string; session: { userId: string; expiresAt: string; expiresIn: string } | null }>('session', {}),
  accessDiagnostics: () => call<AccessDiagnosticsView>('access-diagnostics', {}),
  dwsLocalDoctor: () => call<DwsLocalDoctorView>('dws-local-doctor', {}),
  dwsLocalPermissionRepair: (args: { confirm: true }) =>
    call<DwsLocalRepairView>('dws-local-permission-repair', args),
  relogin: () => call<LoginResult>('relogin', {}),
  dwsLogin: () => call<LoginResult>('dws-login', {}),
  /** 剪贴板：环境页的"复制诊断信息"用它（浏览器剪贴板不可用时的兜底）。 */
  clipboard: (args: { text: string }) => call<SimpleResult>('clipboard', args),
  ossCred: () => call<{ ok: boolean; cred: EnvResult['delivery']['ossCred'] }>('oss-cred', {}),
  /** OSS 凭据落盘：环境页的交付配置区块用它（凭据本体从不回显）。 */
  ossCredSave: (args: { accessKeyId: string; accessKeySecret: string; stsToken?: string; endpoint?: string }) =>
    call<Record<string, unknown>>('oss-cred-save', args),
  ifindStatus: () => call<IfindStatusResult>('ifind-status', {}),
  ifindCredentialSave: (args: { secret: string }) => call<IfindSaveResult>('ifind-credential-save', args),
  ifindCredentialClear: (args: { confirm: boolean }) =>
    call<{ ok: boolean; error: string; cleared: boolean; path: string }>('ifind-credential-clear', args),
  ifindProbe: (args?: { serverType?: string }) => call<IfindProbeResult>('ifind-probe', args ?? {}),
}

export { environmentStateOf, headlineOf } from './model/state.ts'
export type { EnvironmentHeadline } from './model/state.ts'
