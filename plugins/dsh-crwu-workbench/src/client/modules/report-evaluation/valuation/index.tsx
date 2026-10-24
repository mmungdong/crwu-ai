import * as React from 'react'
import type { ValuationExperienceController } from './controller.ts'
import type { ExperienceState } from './model.ts'
import { IntakeExperience } from './ui/intake.tsx'
import { WorkspaceExperience } from './ui/workspace.tsx'
import { AssetOverview } from './ui/shell.tsx'
import { CRWU_SCOPE_PROPS } from '../../../styles/scope.ts'

export interface ValuationExperienceProps {
  controller: ValuationExperienceController
  onBackOverview: () => void
  onOpenSession?: (sessionId: string) => void
}

function useExperienceState(controller: ValuationExperienceController): ExperienceState {
  if (React.useSyncExternalStore) {
    return React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  }
  const [state, setState] = React.useState(controller.getState)
  React.useEffect(() => controller.subscribe(setState), [controller])
  return state
}

export function ValuationExperience(props: ValuationExperienceProps): React.ReactElement {
  const state = useExperienceState(props.controller)
  return <div {...CRWU_SCOPE_PROPS} className="ve-experience-root" data-valuation-experience="true">
    {state.view === 'intake'
      ? <IntakeExperience state={state} controller={props.controller} onBackOverview={props.onBackOverview} />
      : <WorkspaceExperience state={state} controller={props.controller} onBackOverview={props.onBackOverview} {...(props.onOpenSession === undefined ? {} : { onOpenSession: props.onOpenSession })} />}
  </div>
}

export function ValuationOverview(props: ValuationExperienceProps & { onEnter: () => void }): React.ReactElement {
  const state = useExperienceState(props.controller)
  return <div {...CRWU_SCOPE_PROPS} className="ve-experience-root" data-valuation-experience="true">
    <AssetOverview experience={props.controller} state={state} onEnter={props.onEnter} />
  </div>
}
