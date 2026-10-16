import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../common/types.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { text } from '../../../shared/utils/value.ts'

/**
 * 把**工具侧的结论写回轮次状态**（协议 32）。
 *
 * ## 为什么工具需要写轮次
 *
 * `browser-login-required` 与每个来源的登录/失败状态都不是"模型说一声"就能生效的：
 * 宿主侧的事实住在轮次注册表里（协议 35 起没有任何页面轮询它）。工具只把结论回给模型的话，
 * 界面永远停在"正在跑"—— 而"需要登录"这件事恰恰只有工具知道（它才是发请求的那一方）。
 *
 * ## 身份只从 Agent 取
 *
 * 会话 id 来自 `callerIdentity(exec)`（与案例归属门禁**同一个**来源）：
 * 调用方提交不了它，所以"把状态写到别人的轮次上"在结构上写不出来。
 *
 * ## 为什么是"尽力而为"
 *
 * 写不进去（没装配注册表 / 会话不在本轮 scope 里 / 阶段转移非法）**不影响工具本身的结论** ——
 * 那些都是"界面少显示一条状态"，不该让一次已经成功的检索变成失败。所以这些函数不抛错，
 * 返回 `{ ok, reason }` 让调用方把它如实写进 `warnings`（**不许静默**：静默的后果是
 * 界面与子会话看到的事实不一致，而没有任何地方会提这件事）。
 */

export interface ValuationWriteback {
  ok: boolean
  reason: string
  /** 解析到的轮次 id；空串 = 连"这是哪一轮"都没认出来。 */
  valuationId: string
}

/** 调用方所属的那一轮估值（认不出来就是 `null`）。 */
export function valuationOfCaller(deps: ToolDeps, exec: ToolRunContext): { valuationId: string; casePath: string } | null {
  const scopes = deps.valuationScopes
  if (scopes === undefined) return null
  const { childId } = callerIdentity(exec)
  if (childId === '') return null
  const scope = scopes.scopeOf(childId)
  if (scope === undefined) return null
  const valuationId = text((scope as { valuationId?: unknown }).valuationId)
  if (valuationId === '') return null
  return { valuationId, casePath: text((scope as { casePath?: unknown }).casePath) }
}

function idle(reason: string): ValuationWriteback {
  return { ok: false, reason, valuationId: '' }
}

/** 记一次来源状态（`ValuationRecord.providerStates` 就来自它；能力门禁也读它）。 */
export function recordProviderState(
  deps: ToolDeps,
  exec: ToolRunContext,
  providerId: string,
  state: { state: string; attempts: number; detail: string },
): ValuationWriteback {
  const target = valuationOfCaller(deps, exec)
  if (target === null) return idle('这一轮不在宿主登记里：来源状态无法回写（界面会少一条状态）')
  const lifecycles = deps.valuationLifecycles
  if (lifecycles === undefined) return idle('宿主没有装配轮次注册表')
  const written = lifecycles.setProviderState(target.valuationId, providerId, state)
  return { ok: written.ok, reason: written.ok ? '' : written.error, valuationId: target.valuationId }
}

/** 记一条能力缺口（去重）。 */
export function recordCapabilityGap(deps: ToolDeps, exec: ToolRunContext, gap: string): ValuationWriteback {
  const target = valuationOfCaller(deps, exec)
  if (target === null) return idle('这一轮不在宿主登记里：能力缺口无法回写（界面会少一条缺口）')
  const lifecycles = deps.valuationLifecycles
  if (lifecycles === undefined) return idle('宿主没有装配轮次注册表')
  const written = lifecycles.addCapabilityGap(target.valuationId, gap)
  return { ok: written.ok, reason: written.ok ? '' : written.error, valuationId: target.valuationId }
}

/**
 * 记一次**交付校验**的结论（§9）。
 *
 * 为什么必须写回：finalize 与能力的来源判据都读注册表。校验只回给模型的话，
 * "交付前两道校验都过了吗"就只有模型自己知道 —— 而 §9 明确要求 `completed` 不能靠模型声称。
 * 写回失败**不影响校验结论**（与其它写回同一条口径：如实进 warnings，不许静默）。
 */
export function recordValidation(
  deps: ToolDeps,
  exec: ToolRunContext,
  passed: boolean,
  problems: readonly string[] = [],
): ValuationWriteback {
  const target = valuationOfCaller(deps, exec)
  if (target === null) return idle('这一轮不在宿主登记里：交付校验结论无法回写（完成门槛仍会要求它）')
  const lifecycles = deps.valuationLifecycles
  if (lifecycles === undefined) return idle('宿主没有装配轮次注册表')
  const written = lifecycles.setValidation(target.valuationId, passed, problems)
  return { ok: written.ok, reason: written.ok ? '' : written.error, valuationId: target.valuationId }
}

/**
 * 推进轮次阶段。
 *
 * 非法转移**不算错误**（`advance` 会拒绝并把记录原样返回）：工具跑在两条路径上
 * （首次检索在 `running`；用户点"重新检查并继续"时也在 `browser-login-required`），
 * 各写一遍"什么阶段允许什么"必然漂移，所以这里只尝试推。
 * 但**推不动仍要如实回报** —— 界面停在旧阶段是用户看得见的事实，不该由工具替它隐瞒。
 */
export function recordPhase(
  deps: ToolDeps,
  exec: ToolRunContext,
  phase: 'running' | 'browser-login-required' | 'completed',
  patch: { progressDetail?: string } = {},
): ValuationWriteback {
  const target = valuationOfCaller(deps, exec)
  if (target === null) return idle('这一轮不在宿主登记里：阶段无法回写（界面会停在旧阶段）')
  const lifecycles = deps.valuationLifecycles
  if (lifecycles === undefined) return idle('宿主没有装配轮次注册表')
  const written = lifecycles.update(target.valuationId, phase, {
    ...(patch.progressDetail === undefined ? {} : { progress: { detail: patch.progressDetail } }),
  })
  return { ok: written.ok, reason: written.ok ? '' : written.error, valuationId: target.valuationId }
}
