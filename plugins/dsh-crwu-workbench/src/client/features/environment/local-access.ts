import {
  LOCAL_ACCESS_CAPABILITIES,
  PERMISSION_SCHEMA_VERSION,
  type LocalAccessCapability,
  type LocalAccessConsentView,
} from '../../../shared/access/types.ts'
import type { EnvResult } from '../report-audit/api.ts'

/**
 * 本机访问授权的**客户端纯逻辑**。
 *
 * 判据只有一份、而且来自 Host（`env.localAccess` 与 `boot.localAccess`）：
 * 客户端不许自己从「有没有凭据 / 是不是登录过」倒推授权状态 —— 那正是"未授权时报未登录"
 * 那类假结论的来源。
 *
 * 这一层只做三件事：取视图、判「能不能放行」、判「要不要立刻把员工送到授权卡上」。
 */

/** 还没拿到 Host 结论时的空视图：按**未授权**处理（fail closed）。 */
export const MISSING_LOCAL_ACCESS: LocalAccessConsentView = {
  state: 'missing',
  schemaVersion: 0,
  requiredSchemaVersion: PERMISSION_SCHEMA_VERSION,
  grantedAt: '',
  capabilities: [],
  reason: '',
}

/** 取环境应答里的授权视图；旧宿主 / 还没自检回来时按未授权处理。 */
export function consentOf(env: EnvResult | null | undefined): LocalAccessConsentView {
  const view = env?.localAccess
  return view === undefined || view === null ? MISSING_LOCAL_ACCESS : view
}

/** 唯一放行判据。 */
export function consentGranted(env: EnvResult | null | undefined): boolean {
  return consentOf(env).state === 'granted'
}

/**
 * 要不要**立刻**把员工送到授权卡上。
 *
 * 只有 `missing` 与 `outdated` 算 —— 这两种是「他还没就新范围做过决定」。
 * `revoked` 不算：员工**主动撤销**过，再自动弹一次就是不听他的；`persist-failed` 同理
 * （他刚点过撤销，界面该显示的是"撤销没能写盘"，而不是又一张同意卡）。
 */
export function consentNeedsDecision(consent: LocalAccessConsentView): boolean {
  return consent.state === 'missing' || consent.state === 'outdated'
}

/** 授权卡上的固定能力清单（顺序与收据一致，界面不许自己重排）。 */
export function consentCapabilities(): readonly LocalAccessCapability[] {
  return LOCAL_ACCESS_CAPABILITIES
}

/** 这次提交的能力清单（规范顺序，逐字来自共享常量）。 */
export function consentRequestCapabilities(): LocalAccessCapability[] {
  return [...LOCAL_ACCESS_CAPABILITIES]
}

/**
 * 客户端与宿主的**权限说明版本**是否一致。
 *
 * `null` 表示宿主没给这个字段（旧宿主）—— 按**不一致**处理：旧宿主的授权语义是布尔值，
 * 它不可能执行新范围，让它"看起来一致"比拦住更危险。
 */
export function permissionSchemaMismatch(value: unknown): boolean {
  return value !== PERMISSION_SCHEMA_VERSION
}
