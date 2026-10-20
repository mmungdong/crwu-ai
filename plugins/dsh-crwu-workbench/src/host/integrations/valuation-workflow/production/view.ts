/**
 * Read-only projection of the actual compiled valuation workflow graph.
 *
 * The descriptor is built from the same compile/register builders the service uses,
 * with inert handlers that a metadata read never invokes. No node list is handwritten,
 * so a UI graph id is always a real native id and a foreign one is simply absent.
 */
import {
  type ValuationWorkflowGraphView,
  type ValuationWorkflowSnapshot,
} from '../../../../shared/contracts/valuation-workflow.ts'
import { compileWorkflowGraph } from '../../../graph/graph.ts'
import { describeWorkflowGraph } from '../../../graph/definition.ts'
import type { InferIntent, WorkflowStageRunner } from '../../../graph/state.ts'
import { compileValuationGraph } from '../../../graph/valuation/graph.ts'
import { registerRealestateGraph } from '../../../graph/valuation/realestate/register.ts'
import { createValuationGraphRegistry } from '../../../graph/valuation/registry.ts'
import type { ValuationAssetGraph } from '../../../graph/valuation/registry.ts'
import {
  projectWorkflowSnapshot,
  type ProjectedWorkflowView,
  type WorkflowInputContext,
} from '../../../domains/report-evaluation/workflow/views.ts'
import { WORKFLOW_GRAPH_ID, WORKFLOW_GRAPH_VERSION } from './store.ts'

/** A stage runner that is never called by an xray metadata read. */
const inertRunner: WorkflowStageRunner = async () => ({ status: 'blocked' })

/** An intent port that is never called by an xray metadata read. */
const inertIntent: InferIntent = async () => ({ ok: false, errorKind: 'blocked', error: 'inert' })

let cached: Promise<ValuationWorkflowGraphView> | null = null

async function buildGraphView(): Promise<ValuationWorkflowGraphView> {
  const registry = createValuationGraphRegistry()
  registerRealestateGraph(registry, inertRunner)
  const valuation = compileValuationGraph({ registry, inferIntent: inertIntent }) as unknown as ValuationAssetGraph
  const root = compileWorkflowGraph({ valuation })
  return await describeWorkflowGraph(root, {
    graphId: WORKFLOW_GRAPH_ID,
    version: WORKFLOW_GRAPH_VERSION,
  })
}

/** The actual native descriptor; a failed build is not cached. */
export function workflowGraphView(): Promise<ValuationWorkflowGraphView> {
  if (cached === null) {
    cached = buildGraphView().catch((error: unknown) => {
      cached = null
      throw error
    })
  }
  return cached
}

/** Pure projection of one validated snapshot against the actual graph. */
export function projectStoredWorkflow(options: {
  snapshot: ValuationWorkflowSnapshot
  graph: ValuationWorkflowGraphView
  selectedNodeId: string
  inputContext?: WorkflowInputContext
}): ProjectedWorkflowView {
  return projectWorkflowSnapshot(options)
}
