import type { LocalAccessConsentView } from '../../../../shared/access/types.ts'
import type { CredentialPermission } from '../../../../shared/contracts/common.ts'

/**
 * 环境信息模块的**应答类型**（iFinD 探测与保存、本机访问授权）。
 *
 * 它们描述的是**环境事实**（凭据在不在、能不能真取到数、授权收据是什么），
 * 原先长在报告审核的门面里 —— 那是历史位置，不是职责归属。搬到这里之后，
 * 环境页只依赖环境模块；报告审核门面转出它们以保持旧导入路径可用。
 */

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


/**
 * `boot` 的**环境那一半**。
 *
 * `boot` 的应答同时携带环境事实（工作区、案例根、协议代数、授权收据）与审核事实
 * （审核根、占用、已迁移操作清单）。环境页只需要前一半，所以把它单独声明出来，
 * 审核门面用 `interface BootResult extends EnvironmentBootView` 补上后一半 ——
 * 这样环境模块不必反向 import 审核门面（方案 §4.1 的禁止项）。
 */
export interface EnvironmentBootView {
  ok: boolean
  /** 宿主插件的协议代数（见 shared/consts.ts）。缺这个字段 = 旧构建。 */
  protocol?: number
  /** 宿主产物的版本指纹（`pkg-0.0.1`）与写入时间；缺 = 旧宿主。 */
  rev?: string
  builtAt?: string
  /** 宿主包版本与运行形态（`dev` / `installed`）；缺两个字段 = 旧宿主，不谎报形态。 */
  version?: string
  buildKind?: 'dev' | 'installed'
  /** 宿主实际执行的**权限说明版本**；缺 = 旧宿主，界面必须按「不一致」处理。 */
  permissionSchemaVersion?: number
  /** 宿主当前的授权收据视图；旧宿主没有这个字段。 */
  localAccess?: LocalAccessConsentView
  caseRoot: string
  home: string
  formName: string
  parentSessionId: string
  workspace: { chosen: boolean; path: string; title: string; id: string; source: string; missing: boolean }
}

/** Host 返回的错误信封；各操作失败时都带 `ok: false` + `error`。 */
export interface SimpleResult {
  ok: boolean
  error: string
}
