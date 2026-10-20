/**
 * Explicit realestate registration: compile the professional graph and register it
 * under its stable asset id. New assets register the same way without editing the
 * valuation or root graph.
 */
import type { WorkflowStageRunner } from '../../state.ts'
import type { ValuationAssetGraph, ValuationGraphRegistry } from '../registry.ts'
import { compileRealestateGraph } from './graph.ts'

export const REALESTATE_GRAPH_ID = 'realestate'

export function registerRealestateGraph(
  registry: ValuationGraphRegistry,
  runner: WorkflowStageRunner,
): void {
  const compiled = compileRealestateGraph(runner)
  registry.register(REALESTATE_GRAPH_ID, compiled as unknown as ValuationAssetGraph)
}
