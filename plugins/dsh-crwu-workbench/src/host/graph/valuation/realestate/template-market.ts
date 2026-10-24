import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph'
import { TEMPLATE_MARKET_NODES, type TemplateMarketNodeId } from '../../../../shared/contracts/valuation-template-market.ts'
import { WorkflowState, type GraphDriveStatus, type WorkflowGraphState, type WorkflowGraphUpdate } from '../../state.ts'

export interface TemplateMarketNodeResult {
  status: GraphDriveStatus
  outputs?: Record<string, Record<string, unknown>>
  nextNode?: TemplateMarketNodeId
}
export type TemplateMarketNodeRunner = (nodeId: TemplateMarketNodeId, state: WorkflowGraphState) => Promise<TemplateMarketNodeResult>

export function compileTemplateMarketGraph(runner: TemplateMarketNodeRunner, checkpointer?: BaseCheckpointSaver) {
  const run = (nodeId: TemplateMarketNodeId) => async (state: WorkflowGraphState): Promise<WorkflowGraphUpdate> => {
    const result = await runner(nodeId, state)
    const patch: WorkflowGraphUpdate = { marketOutcomes: { [nodeId]: result.status } }
    if (result.outputs) patch.outputs = result.outputs
    if (nodeId !== 'templates' && nodeId !== 'materials') {
      patch.status = result.status
      patch.stage = nodeId
      patch.marketNext = result.nextNode ?? ''
    }
    return patch
  }
  const builder = new StateGraph(WorkflowState).addNode({
    templates: run('templates'), materials: run('materials'), 'collection-plan': run('collection-plan'),
    'confirm-plan': run('confirm-plan'), 'search-listings': run('search-listings'), 'candidate-workbook': run('candidate-workbook'),
    'select-cases': run('select-cases'), 'inspect-details': run('inspect-details'), 'check-inputs': run('check-inputs'),
    'fill-template': run('fill-template'), 'validate-delivery': run('validate-delivery'),
  })
  builder.addConditionalEdges(START, state => {
    if (state.status !== 'running') return END
    if (state.entry === 'templates' || state.entry === 'materials') return ['templates', 'materials']
    return TEMPLATE_MARKET_NODES.includes(state.entry as TemplateMarketNodeId) ? state.entry as TemplateMarketNodeId : END
  }, [...TEMPLATE_MARKET_NODES, END])
  builder.addEdge(['templates', 'materials'], 'collection-plan')
  const next: Partial<Record<TemplateMarketNodeId, TemplateMarketNodeId>> = {
    'collection-plan': 'confirm-plan', 'confirm-plan': 'search-listings', 'search-listings': 'candidate-workbook',
    'candidate-workbook': 'select-cases', 'select-cases': 'inspect-details', 'inspect-details': 'check-inputs',
    'check-inputs': 'fill-template', 'fill-template': 'validate-delivery',
  }
  for (const nodeId of TEMPLATE_MARKET_NODES.filter(id => id !== 'templates' && id !== 'materials')) {
    const alternatives: Partial<Record<TemplateMarketNodeId, TemplateMarketNodeId[]>> = {
      'confirm-plan': ['collection-plan'], 'select-cases': ['search-listings', 'collection-plan'], 'inspect-details': ['candidate-workbook'],
    }
    const targets = [...new Set([...(next[nodeId] ? [next[nodeId]!] : []), ...(alternatives[nodeId] ?? [])]), END]
    builder.addConditionalEdges(nodeId, state => state.status === 'running'
      ? state.marketNext as TemplateMarketNodeId || next[nodeId] || END : END, targets)
  }
  return builder.compile(checkpointer ? { checkpointer } : {})
}
