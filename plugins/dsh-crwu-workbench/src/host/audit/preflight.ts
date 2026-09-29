import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { TOOL_NAMES } from '../tools/consts.ts'
import { missingAuditTools } from '../tools/register.ts'

/**
 * 审核链路的**确定性** capability 门禁。
 *
 * 为什么必须是确定性的、而不是只写进提示词：提示词是「请求」，不是门禁。
 * 子代理看不到某个 Tool 时，它自然会去找别的手段（裸命令、`which`、改 PATH）——
 * 那正是本次改造要消灭的行为。所以插件在**创建子代理之前**自己检查一遍，
 * 缺任何一个就明确失败并列出缺失的工具名。
 *
 * 检查分两步，覆盖两类失败：
 * 1. **可见性**：`ctx.tools.get(name, agent)` —— 注册表 resolver 会把 scoped restriction
 *    与 presentation collapse 都算进去，所以它回答的是「这个 Agent 到底看不看得见」；
 * 2. **policy pipeline**：真的通过 `ctx.tools.execute()` 调一次**零副作用**的
 *    `crwu_audit_capabilities`。这一步同时证明注册表可用、参数校验通过、pre/guard/post
 *    链路能跑通、输出 schema 与实现一致 —— 只查注册表是证明不了这些的。
 */

export interface ToolCallOutcome {
  ok: boolean
  /** 成功时的结构化返回值；失败时为 null。 */
  value: Record<string, unknown> | null
  error: string
}

export interface CapabilityPreflight {
  ok: boolean
  /** 失败时给用户/日志的一句话（含缺失的工具名）。 */
  error: string
  /** 对审核根 Agent 不可见的必需工具。 */
  missingTools: string[]
  /** 能力自检返回的结构化值（成功时）；失败时为 null。 */
  value: Record<string, unknown> | null
}

const PREFLIGHT_TIMEOUT_MS = 30_000
/** 输入快照要跑两条取数 CLI（各 90 秒预算），给足余量。 */
const BOOTSTRAP_TIMEOUT_MS = 240_000

/** 注册表的最小结构面：只取这里真的会用到的方法，不把 dsh-tools 的内部类型带进来。 */
interface ToolExecutionOutcome {
  isError: boolean
  value?: unknown
  error?: { code?: string; name?: string; message?: string }
}

interface ToolsRuntimeLike {
  execute(input: {
    callId: unknown
    name: string
    arguments: unknown
    agent?: unknown
    signal: AbortSignal
  }): Promise<ToolExecutionOutcome>
}

/** 只查可见性（不执行任何东西）。 */
export function auditToolsVisible(
  ctx: Context,
  agent: unknown,
  required?: readonly string[],
): string[] {
  const scope = agent as Parameters<typeof missingAuditTools>[1]
  return required === undefined ? missingAuditTools(ctx, scope) : missingAuditTools(ctx, scope, required)
}

/** 可见性 + 真实调用一次能力自检。 */
export async function capabilityPreflight(ctx: Context, agent: unknown): Promise<CapabilityPreflight> {
  const missing = auditToolsVisible(ctx, agent)
  if (missing.length > 0) {
    return {
      ok: false,
      missingTools: missing,
      value: null,
      error: `审核所需的 CRWU Tool 对当前审核根 Agent 不可见：${missing.join('、')}。请在部署里确认 dsh-crwu-workbench 已装配 @deepseek-ai/dsh-tools（base bundle 的 tools 行），再重试。`,
    }
  }
  if (agent === undefined) {
    return {
      ok: false,
      missingTools: [...missing],
      value: null,
      error: '审核根会话的 Agent 不在运行中，无法验证工具链路。',
    }
  }

  const called = await executeToolForAgent(ctx, agent, TOOL_NAMES.capabilities, {}, {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    label: 'capability 预检',
  })
  if (!called.ok) return { ok: false, missingTools: [...missing], value: called.value, error: called.error }
  const doc = called.value ?? {}
  if (doc.ok !== true) {
    return {
      ok: false,
      missingTools: [...missing],
      value: doc,
      error: `capability gap：${text(doc.error) || '能力自检报告 ok=false'}`,
    }
  }
  return { ok: true, error: '', missingTools: [], value: doc }
}

/**
 * 通过 `ctx.tools.execute()` 真调一个 Tool，并把这次的调用放进 `agent` 的 scope。
 *
 * 为什么要走这里而不是直接调 Tool 的实现函数：只有经过注册表的 `execute`，才会跑
 * `tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` 这条 policy pipeline
 * （审批、超时、取消、参数校验、输出 schema 校验都在那里）。Host 自己「顺手」调用实现函数
 * 会绕开用户审批 —— 而这一步恰恰是在**替子代理**做本该公司自己做的取数。
 *
 * `agent` 为空（环境自检等没有 Agent 的场景）时省略 scope，仍然走同一条 registry 链路。
 */
export async function executeToolForAgent(
  ctx: Context,
  agent: unknown,
  name: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<ToolCallOutcome> {
  const label = options.label ?? name
  const registry = ctx.get('tools') as ToolsRuntimeLike | undefined
  if (registry === undefined || typeof registry.execute !== 'function') {
    return { ok: false, value: null, error: 'Host tools 服务不可用' }
  }
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = ctx.get('timer') as { timeout?: (ms: number) => Promise<void> } | undefined
  const call = registry.execute({
    callId: `crwu-host-${name}-${Date.now().toString(36)}`,
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: controller.signal,
  })
  const pending = call.then(
    (result) => ({ kind: 'settled' as const, result }),
    (error: unknown) => ({ kind: 'threw' as const, error }),
  )
  const raced = timer === undefined || typeof timer.timeout !== 'function'
    ? await pending
    : await Promise.race([pending, timer.timeout(timeoutMs).then(() => ({ kind: 'timeout' as const }))])
  if (raced.kind === 'timeout') {
    controller.abort(new Error(`${label}超时`))
    return { ok: false, value: null, error: `${label}超时（${Math.round(timeoutMs / 1000)} 秒内没有返回）` }
  }
  if (raced.kind === 'threw') {
    return {
      ok: false,
      value: null,
      error: `${label}调用抛错：${raced.error instanceof Error ? raced.error.message : String(raced.error)}`,
    }
  }
  const result = raced.result
  if (result.isError === true) {
    const info = result.error ?? { message: '未提供原因' }
    return {
      ok: false,
      value: null,
      error: `${label}失败（${text(info.code) || text(info.name) || 'unknown'}）：${text(info.message)}`,
    }
  }
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, value: null, error: `${label}没有返回结构化对象` }
  }
  return { ok: true, value: value as Record<string, unknown>, error: '' }
}

/** 审核启动前的输入快照交接：失败必须**在创建子代理之前**终止。 */
export async function bootstrapInputSnapshot(
  ctx: Context,
  agent: unknown,
  args: { objectId: string; seqNo: string; caseDir: string; attemptId: string; refresh: boolean },
): Promise<{ ok: boolean; error: string; snapshot: Record<string, unknown> | null }> {
  const called = await executeToolForAgent(ctx, agent, TOOL_NAMES.auditCaseBootstrap, { ...args }, {
    // 取数要跑两条 CLI（各 90 秒预算），这里给足；超时按失败处理，不创建子代理。
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    label: '输入快照交接',
  })
  if (!called.ok) return { ok: false, error: called.error, snapshot: null }
  const doc = called.value ?? {}
  if (doc.ok !== true) {
    return {
      ok: false,
      error: `输入快照交接失败（${text(doc.errorKind) || 'unknown'}）：${text(doc.error) || 'bootstrap 报告 ok=false'}`,
      snapshot: null,
    }
  }
  return { ok: true, error: '', snapshot: doc }
}
