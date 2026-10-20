/**
 * Realestate professional graph: seven compiled stage nodes over the shared state.
 *
 * The runner is an injected capability. A stage output is accumulated by stage and
 * the conditional edge advances only while the drive is still running.
 */
import { END, START, StateGraph } from '@langchain/langgraph'
import type { ValuationWorkflowStage } from '../../../../shared/contracts/valuation-workflow.ts'
import { VALUATION_WORKFLOW_STAGES } from '../../../../shared/contracts/valuation-workflow.ts'
import {
  WorkflowState,
  type GraphDriveStatus,
  type WorkflowGraphState,
  type WorkflowGraphUpdate,
  type WorkflowStageRunner,
} from '../../state.ts'

type StageDestination = ValuationWorkflowStage | typeof END

function advance(status: GraphDriveStatus, next: ValuationWorkflowStage): StageDestination {
  return status === 'running' ? next : END
}

function entryOf(state: WorkflowGraphState): StageDestination {
  if (state.status !== 'running') return END
  if ((VALUATION_WORKFLOW_STAGES as readonly string[]).includes(state.entry)) {
    return state.entry as ValuationWorkflowStage
  }
  return END
}

async function runNode(
  runner: WorkflowStageRunner,
  stage: ValuationWorkflowStage,
  state: WorkflowGraphState,
): Promise<WorkflowGraphUpdate> {
  const result = await runner(stage, state)
  const update: WorkflowGraphUpdate = { stage, status: result.status }
  const outputs = result.outputs
  if (outputs !== undefined) update.outputs = outputs
  return update
}

export function compileRealestateGraph(runner: WorkflowStageRunner) {
  const builder = new StateGraph(WorkflowState).addNode({
    elements: (state: WorkflowGraphState) => runNode(runner, 'elements', state),
    rights: (state: WorkflowGraphState) => runNode(runner, 'rights', state),
    plan: (state: WorkflowGraphState) => runNode(runner, 'plan', state),
    evidence: (state: WorkflowGraphState) => runNode(runner, 'evidence', state),
    calculation: (state: WorkflowGraphState) => runNode(runner, 'calculation', state),
    review: (state: WorkflowGraphState) => runNode(runner, 'review', state),
    delivery: (state: WorkflowGraphState) => runNode(runner, 'delivery', state),
  })

  // Explicit path maps make every executable conditional destination visible in
  // the compiled graph metadata instead of only being implied by the router.
  builder.addConditionalEdges(START, entryOf, [...VALUATION_WORKFLOW_STAGES, END])
  builder.addConditionalEdges('elements', (state: WorkflowGraphState) => advance(state.status, 'rights'), ['rights', END])
  builder.addConditionalEdges('rights', (state: WorkflowGraphState) => advance(state.status, 'plan'), ['plan', END])
  builder.addConditionalEdges('plan', (state: WorkflowGraphState) => advance(state.status, 'evidence'), ['evidence', END])
  builder.addConditionalEdges('evidence', (state: WorkflowGraphState) => advance(state.status, 'calculation'), ['calculation', END])
  builder.addConditionalEdges('calculation', (state: WorkflowGraphState) => advance(state.status, 'review'), ['review', END])
  builder.addConditionalEdges('review', (state: WorkflowGraphState) => advance(state.status, 'delivery'), ['delivery', END])
  builder.addEdge('delivery', END)

  return builder.compile()
}
