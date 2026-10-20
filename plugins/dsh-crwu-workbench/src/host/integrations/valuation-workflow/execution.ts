/**
 * Authorized composite dispatch for the embedded valuation workflow.
 *
 * The workflow graph never owns DSH execution state: this adapter is created from
 * the genuine {@link ToolRunContext} of the parent workflow call and forwards each
 * business Tool through the official `ToolRuntime.execute` transport. The runtime
 * assigns the registry-owned execution token; this module never mints one.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { isAbsoluteLocalPath } from '../../../shared/utils/local-path.ts'
import { callerIdentity, samePathText } from '../../domains/report-audit/scope.ts'
import type { ValuationScopeService } from '../../domains/report-evaluation/scope.ts'
import { VALUATION_TOOL_NAMES } from '../../tools/report-evaluation/consts.ts'
import { callerSession } from '../../tools/common/types.ts'
import { requireBoundValuationActor } from './services/access.ts'

export interface WorkflowToolDispatcherDeps {
  ctx: Context
  valuationScopes?: ValuationScopeService
}

export interface WorkflowToolDispatchResult {
  ok: boolean
  errorKind?: string
  error?: string
  value?: unknown
}

export interface WorkflowToolDispatcher {
  dispatch(name: string, args: unknown, signal?: AbortSignal): Promise<WorkflowToolDispatchResult>
}

/** Only the narrow, registered business names the workflow actually needs. */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  VALUATION_TOOL_NAMES.marketSearch,
  VALUATION_TOOL_NAMES.marketCapture,
  VALUATION_TOOL_NAMES.templateMaterialize,
  VALUATION_TOOL_NAMES.fileExtract,
])

/** Case-local market calls must also name a plan registered on this live round. */
const PLAN_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  VALUATION_TOOL_NAMES.marketSearch,
  VALUATION_TOOL_NAMES.marketCapture,
  VALUATION_TOOL_NAMES.templateMaterialize,
])

const PUBLIC_EXECUTION_ERROR = '工作流业务工具执行失败：底层详情已省略，请由 Host 诊断后重试'
const CANCELLED_ERROR = '本次工作流业务调用已被取消'

function policy(message: string): WorkflowToolDispatchResult {
  return { ok: false, errorKind: 'policy', error: message }
}

function input(message: string): WorkflowToolDispatchResult {
  return { ok: false, errorKind: 'input', error: message }
}

function cancelled(): WorkflowToolDispatchResult {
  return { ok: false, errorKind: 'cancelled', error: CANCELLED_ERROR }
}

function identityIssue(exec: ToolRunContext): string {
  if (exec.agent === undefined || exec.agent === null || typeof exec.agent !== 'object') {
    return '缺少真实的调用 Agent：拒绝转发工作流业务工具'
  }
  if (callerSession(exec) === undefined) return '缺少真实的调用会话：拒绝转发工作流业务工具'
  if (typeof (exec as { token?: unknown }).token !== 'symbol') {
    return '缺少注册表签发的执行令牌：拒绝伪造执行上下文'
  }
  if (text(exec.rootCallId) === '') return '缺少根调用标识：拒绝转发工作流业务工具'
  if (callerIdentity(exec).childId === '') return '缺少调用会话身份：拒绝转发工作流业务工具'
  return ''
}

function bindActor(exec: ToolRunContext, deps: WorkflowToolDispatcherDeps) {
  const session = callerSession(exec)
  const signal = (exec as { signal?: AbortSignal }).signal
  return requireBoundValuationActor({
    sessionId: callerIdentity(exec).childId,
    // The registered scope is the only source of the case path.
    caseDir: '',
    source: 'workflow-runtime',
    ...(session === undefined ? {} : { session }),
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(signal === undefined ? {} : { signal }),
  }, { valuationScopes: deps.valuationScopes })
}

/**
 * Fuse caller and outer cancellation, then release both listeners when the
 * dispatch settles. A completed call must leave no abort listener behind on the
 * long-lived parent signal.
 */
interface CombinedSignal {
  signal: AbortSignal
  dispose(): void
}

function combineSignals(...signals: Array<AbortSignal | undefined>): CombinedSignal {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  const attached: AbortSignal[] = []
  for (const signal of signals) {
    if (signal === undefined) continue
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    attached.push(signal)
  }
  return {
    signal: controller.signal,
    dispose(): void {
      for (const signal of attached) signal.removeEventListener('abort', abort)
    },
  }
}

function ferryResult(exec: ToolRunContext, outcome: ToolExecutionResult): void {
  if (Array.isArray(outcome.additionalContexts)) {
    for (const context of outcome.additionalContexts) exec.deferContext(context)
  }
  if (outcome.isError === false && outcome.concludesTurn === true) exec.concludeTurn()
}

/**
 * Bind the live scope once, then re-bind on every call so a closed or reopened
 * round can never reuse a captured dispatcher.
 */
export function createWorkflowToolDispatcher(
  deps: WorkflowToolDispatcherDeps,
  exec: ToolRunContext,
): WorkflowToolDispatcher {
  const issue = identityIssue(exec)
  const initial = issue === '' ? bindActor(exec, deps) : undefined
  const initialActor = initial !== undefined && initial.ok ? initial.actor : undefined
  const initialScopeKey = initialActor?.scopeKey ?? ''

  return {
    async dispatch(name, args, signal): Promise<WorkflowToolDispatchResult> {
      if (!ALLOWED_TOOLS.has(name)) {
        return policy(`不转发未注册的工作流业务工具：${text(name)}`)
      }
      if (issue !== '') return policy(issue)
      if (initial === undefined || !initial.ok || initialActor === undefined) {
        return policy(initial?.error ?? '本轮估值范围不可用：拒绝转发工作流业务工具')
      }
      const live = bindActor(exec, deps)
      if (!live.ok) return policy(live.error)
      if (live.actor.scopeKey !== initialScopeKey
        || live.actor.projectId !== initialActor.projectId
        || !samePathText(live.actor.caseDir, initialActor.caseDir)) {
        return policy('本轮估值范围已变更或已结束：拒绝复用旧的执行上下文')
      }

      const record = args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : null
      if (record === null) return input('工作流业务工具的参数必须是一个对象')
      const requestedCase = text(record.caseDir).trim()
      if (!isAbsoluteLocalPath(requestedCase)) {
        return input('工作流业务工具必须携带本轮估值案例目录的绝对路径')
      }
      if (!samePathText(requestedCase, live.actor.caseDir)) {
        return policy('请求的案例目录不属于本轮估值：拒绝转发业务 I/O')
      }
      if (PLAN_REQUIRED_TOOLS.has(name)) {
        const planId = text(record.planId).trim()
        if (planId === '') return input('市场取数必须指定本轮已登记的方案标识（planId）')
        if (deps.valuationScopes?.planOf(live.actor.sessionId, planId) !== true) {
          return policy('方案未登记在本轮估值里：拒绝转发市场取数')
        }
      }

      const runtime = deps.ctx.get('tools') as ToolRuntime | undefined
      if (runtime === undefined || typeof runtime.execute !== 'function') {
        return {
          ok: false,
          errorKind: 'capability-gap',
          error: 'Host 的 tools 服务不可用（缺少 execute）：拒绝转发工作流业务工具',
        }
      }

      const outerSignal = (exec as { signal?: AbortSignal }).signal
      if (outerSignal?.aborted === true || signal?.aborted === true) return cancelled()
      const combined = combineSignals(outerSignal, signal)

      let outcome: ToolExecutionResult | undefined
      try {
        outcome = await runtime.execute({
          callId: ToolCallId(randomUUID()),
          rootCallId: exec.rootCallId,
          parent: exec.token,
          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
          signal: combined.signal,
          name,
          arguments: args,
        })
      } catch {
        return { ok: false, errorKind: 'failed', error: PUBLIC_EXECUTION_ERROR }
      } finally {
        combined.dispose()
      }

      // A late success from an already-cancelled dispatch must not be published.
      if (combined.signal.aborted) return cancelled()
      if (outcome === undefined) {
        return { ok: false, errorKind: 'failed', error: PUBLIC_EXECUTION_ERROR }
      }
      ferryResult(exec, outcome)
      if (outcome.isError === true) {
        return { ok: false, errorKind: 'failed', error: PUBLIC_EXECUTION_ERROR }
      }
      return { ok: true, value: outcome.value }
    },
  }
}
