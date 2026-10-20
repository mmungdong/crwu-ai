/**
 * Pure eligibility predicate for an explicit intent-router retry.
 *
 * The projection consumes only the public snapshot: a stopped run that never left
 * the router, with no professional stage attempted and no accepted plan, result or
 * delivery. It never inspects runtime occupancy or the durable record; the Host and
 * runtime own those checks against the actual run state.
 */
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowSnapshot,
} from '../../../../shared/contracts/valuation-workflow.ts'

/**
 * Whether a stopped snapshot describes an intent-only failure that may be retried.
 *
 * A resolved route, any attempted professional stage, or any accepted plan, result
 * or delivery disqualifies the run: retrying would replay business work.
 */
export function canRetryWorkflowIntent(snapshot: ValuationWorkflowSnapshot | null | undefined): boolean {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return false
  if (snapshot.status !== 'blocked' && snapshot.status !== 'failed') return false
  if (snapshot.errorKind === 'stop-unknown') return false
  const routing = snapshot.routing
  if (routing === null || routing === undefined || routing.route !== '') return false
  if (snapshot.plan !== null || snapshot.result !== null || snapshot.delivery !== null) return false
  return VALUATION_WORKFLOW_STAGES.every((stage) => {
    const receipt = snapshot.stages[stage]
    return receipt !== undefined && receipt.attempt === 0 && receipt.state === 'pending'
  })
}
