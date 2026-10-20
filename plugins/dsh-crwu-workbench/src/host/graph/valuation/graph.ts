/**
 * Valuation business graph: intent routing over an explicit registry of compiled
 * professional subgraphs. No asset-specific branch lives in this module.
 */
import { END, START, StateGraph } from '@langchain/langgraph'
import {
  WorkflowState,
  type InferIntent,
  type InferIntentResult,
  type WorkflowGraphState,
  type WorkflowGraphUpdate,
} from '../state.ts'
import { evaluateAdopted, evaluateInference } from './intent.ts'
import type { ValuationAssetGraph, ValuationGraphRegistry } from './registry.ts'

type ValuationGraphBuilder = StateGraph<
  typeof WorkflowState,
  WorkflowGraphState,
  WorkflowGraphUpdate,
  string
>

export interface CompileValuationGraphOptions {
  registry: ValuationGraphRegistry
  inferIntent: InferIntent
}

interface RegisteredAsset {
  id: string
  graph: ValuationAssetGraph
}

function snapshotRegistry(registry: ValuationGraphRegistry): RegisteredAsset[] {
  return registry.ids().map((id) => {
    const graph = registry.get(id)
    if (graph === undefined) throw new Error(`资产图注册项缺失：${id}`)
    return { id, graph }
  })
}

function canReuseAdoptedIntent(state: WorkflowGraphState): boolean {
  const intent = state.intent
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) return false
  if (intent.status !== 'resolved') return false
  return typeof state.intentSessionId === 'string' && state.intentSessionId.trim() !== ''
}

export function compileValuationGraph({ registry, inferIntent }: CompileValuationGraphOptions) {
  const assets = snapshotRegistry(registry)
  const registeredAssetIds = assets.map((asset) => asset.id)

  const nodes: Record<string, unknown> = {
    'intent-router': async (state: WorkflowGraphState): Promise<WorkflowGraphUpdate> => {
      const outcome = canReuseAdoptedIntent(state)
        ? evaluateAdopted(state.input, registeredAssetIds, state.intent, state.intentSessionId)
        : await inferAndEvaluate(state.input, registeredAssetIds, inferIntent)
      return {
        intent: outcome.intent,
        intentSessionId: outcome.intentSessionId,
        route: outcome.route,
        status: outcome.status,
        error: outcome.error,
        errorKind: outcome.errorKind,
      }
    },
  }
  for (const asset of assets) nodes[asset.id] = asset.graph

  const base = new StateGraph(WorkflowState) as unknown as ValuationGraphBuilder
  const builder = base.addNode(nodes as unknown as Record<string, never>) as unknown as ValuationGraphBuilder
  builder.addEdge(START, 'intent-router')
  builder.addConditionalEdges('intent-router', (state: WorkflowGraphState) => (
    state.status === 'running' && state.route !== '' ? state.route : END
  ), [...registeredAssetIds, END])
  for (const asset of assets) builder.addEdge(asset.id, END)
  return builder.compile()
}

function inferenceInput(input: WorkflowGraphState['input']): WorkflowGraphState['input'] {
  const materials = Array.isArray(input.materials) ? input.materials : []
  return {
    text: typeof input.text === 'string' ? input.text : '',
    materials: materials.map((material) => ({ ...material })),
  }
}

async function inferAndEvaluate(
  input: WorkflowGraphState['input'],
  registeredAssetIds: readonly string[],
  inferIntent: InferIntent,
) {
  let result: InferIntentResult
  try {
    result = await inferIntent(inferenceInput(input), [...registeredAssetIds])
  } catch {
    return evaluateInference(input, registeredAssetIds, { ok: false, error: '' })
  }
  return evaluateInference(input, registeredAssetIds, result)
}
