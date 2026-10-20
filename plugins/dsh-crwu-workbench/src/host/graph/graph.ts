/**
 * Overall compiled workflow graph. The root adds the actual compiled valuation
 * business graph as a child; it does not reimplement stage or intent logic.
 */
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph'
import {
  WorkflowState,
  type WorkflowGraphState,
  type WorkflowGraphUpdate,
} from './state.ts'
import type { ValuationAssetGraph } from './valuation/registry.ts'

type WorkflowGraphBuilder = StateGraph<
  typeof WorkflowState,
  WorkflowGraphState,
  WorkflowGraphUpdate,
  string
>

export interface CompileWorkflowGraphOptions {
  valuation: ValuationAssetGraph
  /** Actual saver supplied by the Host; absent runs keep the in-memory graph. */
  checkpointer?: BaseCheckpointSaver
}

export function compileWorkflowGraph({ valuation, checkpointer }: CompileWorkflowGraphOptions) {
  const nodes: Record<string, unknown> = { valuation }
  const base = new StateGraph(WorkflowState) as unknown as WorkflowGraphBuilder
  const builder = (base.addNode(nodes as unknown as Record<string, never>)) as unknown as WorkflowGraphBuilder
  builder.addEdge(START, 'valuation')
  builder.addEdge('valuation', END)
  // The lent saver is inherited by the compiled child graphs, so the real
  // valuation/realestate namespaces write their own checkpoints.
  return checkpointer === undefined ? builder.compile() : builder.compile({ checkpointer })
}
