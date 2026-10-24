import * as React from 'react'
import type { ReportEvaluationController } from '../controller.ts'
import type { ValuationWorkflowController } from '../workflow-controller.ts'
import {
  createValuationExperienceController,
  type ValuationExperienceController,
} from '../valuation/controller.ts'
import { ValuationExperience, ValuationOverview } from '../valuation/index.tsx'
import { CRWU_SCOPE_PROPS } from '../../../styles/scope.ts'

/**
 * Asset-assessment entry (protocol 43, redesigned 2026-10-23).
 *
 * Overview → 01 valuation intake → six-step valuation workface. The old graph
 * workface and market drawer are intentionally no longer the default surface; the
 * new controller projects Host state into the prototype's information hierarchy.
 */
export type AssetWorkflowStep = 'overview' | 'valuation'

export interface AssetAssessmentWorkflowProps {
  workflow: ValuationWorkflowController
  evaluation: ReportEvaluationController
  /** Optional: production assembly owns one instance so drafts survive module switches. */
  experience?: ValuationExperienceController
  step: AssetWorkflowStep
  onStep: (step: AssetWorkflowStep) => void
  /** Opens the real parent session on an employee click; never automatic. */
  onOpenParentSession: (sessionId: string) => void
}

export function AssetAssessmentWorkflow(props: AssetAssessmentWorkflowProps): React.ReactElement {
  const fallback = React.useRef<ValuationExperienceController | null>(null)
  if (props.experience === undefined && fallback.current === null) {
    fallback.current = createValuationExperienceController({
      evaluation: props.evaluation,
      workflow: props.workflow,
    })
  }
  const controller = props.experience ?? (fallback.current as ValuationExperienceController)
  React.useEffect(() => {
    if (props.experience !== undefined) return undefined
    return () => { fallback.current?.dispose() }
  }, [props.experience])

  const state = React.useSyncExternalStore
    ? React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
    : useFallbackState(controller)

  const enter = (): void => {
    const current = controller.getState()
    if (current.mode === 'host' && current.host.projectId !== '') controller.setView('workspace')
    else controller.setView('intake')
    props.onStep('valuation')
  }

  return <section {...CRWU_SCOPE_PROPS} className="ve-asset-workflow-root" data-asset-assessment-workflow="true" data-asset-workflow-step={props.step}>
    {props.step === 'overview'
      ? <ValuationOverview controller={controller} onBackOverview={() => { props.onStep('overview') }} onEnter={enter} />
      : <ValuationExperience
        controller={controller}
        onBackOverview={() => { props.onStep('overview') }}
        onOpenSession={props.onOpenParentSession}
      />}
    {state.error === '' ? null : <p className="ve-sr-only" role="alert" data-asset-workflow-error="true">{state.error}</p>}
  </section>
}

function useFallbackState(controller: ValuationExperienceController): ReturnType<ValuationExperienceController['getState']> {
  const [state, setState] = React.useState(controller.getState)
  React.useEffect(() => controller.subscribe(setState), [controller])
  return state
}
