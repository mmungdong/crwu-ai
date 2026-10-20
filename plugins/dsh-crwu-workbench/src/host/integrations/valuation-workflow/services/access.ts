/**
 * Authorized valuation service actor binding.
 *
 * Host outer adapters (registered Tools today, the project runtime later) translate
 * their own transport context into a {@link ValuationServicePrincipal}. The service
 * layer then **independently** rechecks the live registered valuation scope: the
 * session must still own the case and project, and the requested case must match the
 * registered case. A model/UI cannot supply a verified boolean, a foreign case or a
 * copied parent scope.
 */
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../../shared/utils/value.ts'
import { samePathText } from '../../../domains/report-audit/scope.ts'
import type { ValuationScopeService } from '../../../domains/report-evaluation/scope.ts'
import type { ValuationServiceErrorKind } from './errors.ts'

export type ValuationServiceSource = 'valuation-tool' | 'workflow-runtime'

/** What a genuine Host adapter knows before calling a business service. */
export interface ValuationServicePrincipal {
  /** Actual DSH session id whose registered valuation scope must own the case. */
  sessionId: string
  /** Case path already resolved by the caller's own authorization layer. */
  caseDir: string
  source: ValuationServiceSource
  /** Genuine session/agent/signal for Broker ownership and cancellation. */
  session?: Session
  agent?: unknown
  signal?: AbortSignal
}

/** The live-bound actor a business service may use for real I/O. */
export interface ValuationServiceActor {
  sessionId: string
  caseDir: string
  projectId: string
  /** `undefined` means the round never declared a plan list (legacy behaviour). */
  planIds: string[] | undefined
  /** Exact live-scope key: a closed/reopened round never reuses cached I/O. */
  scopeKey: string
  source: ValuationServiceSource
  session?: Session
  agent?: unknown
  signal?: AbortSignal
}

export interface ValuationActorBinding {
  ok: boolean
  errorKind: ValuationServiceErrorKind
  error: string
  actor: ValuationServiceActor
}

function emptyActor(principal: ValuationServicePrincipal): ValuationServiceActor {
  return {
    sessionId: text(principal.sessionId),
    caseDir: text(principal.caseDir),
    projectId: '',
    planIds: undefined,
    scopeKey: '',
    source: principal.source,
    ...(principal.session === undefined ? {} : { session: principal.session }),
    ...(principal.agent === undefined ? {} : { agent: principal.agent }),
    ...(principal.signal === undefined ? {} : { signal: principal.signal }),
  }
}

/**
 * Recheck the live scope and bind an actor. Fails closed (no I/O) on an unknown
 * session, a missing case/project, or a case that is not the registered one.
 */
export function requireBoundValuationActor(
  principal: ValuationServicePrincipal,
  deps: { valuationScopes?: ValuationScopeService },
): ValuationActorBinding {
  const actor = emptyActor(principal)
  const sessionId = text(principal.sessionId)
  if (sessionId === '') {
    return { ok: false, errorKind: 'policy', error: '缺少真实的调用会话：拒绝登记范围之外的业务 I/O', actor }
  }
  const scope = deps.valuationScopes?.scopeOf(sessionId)
  if (scope === undefined) {
    return { ok: false, errorKind: 'policy', error: '这条会话没有本轮估值的案例归属：拒绝登记范围之外的业务 I/O', actor }
  }
  const casePath = text(scope.casePath)
  if (casePath === '') {
    return { ok: false, errorKind: 'policy', error: '本轮估值没有登记案例目录：拒绝业务 I/O', actor }
  }
  const requestedCase = text(principal.caseDir)
  if (requestedCase !== '' && !samePathText(requestedCase, casePath)) {
    return { ok: false, errorKind: 'policy', error: '请求的案例目录不属于本轮估值：拒绝业务 I/O', actor }
  }
  const projectId = text(scope.projectId) || text(scope.valuationId)
  if (projectId === '') {
    return { ok: false, errorKind: 'policy', error: '本轮估值没有项目归属：拒绝业务 I/O', actor }
  }
  return {
    ok: true,
    errorKind: '',
    error: '',
    actor: {
      sessionId,
      caseDir: casePath,
      projectId,
      planIds: Array.isArray(scope.planIds) ? [...scope.planIds] : undefined,
      scopeKey: `${scope.valuationId}\u0000${scope.sessionId}\u0000${String(scope.openedAt)}`,
      source: principal.source,
      ...(principal.session === undefined ? {} : { session: principal.session }),
      ...(principal.agent === undefined ? {} : { agent: principal.agent }),
      ...(principal.signal === undefined ? {} : { signal: principal.signal }),
    },
  }
}
