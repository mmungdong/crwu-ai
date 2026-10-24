import { TEMPLATE_MARKET_NODES, type TemplateMarketNodeId } from '../../shared/contracts/valuation-template-market.ts'
/**
 * Plain serializable projection of the actual compiled workflow graph.
 *
 * The descriptor reads the real `getGraphAsync({ xray: 2 })` metadata and keeps
 * every native node id and edge. It never runs a stage, never infers intent and
 * never serializes native node data, functions or graph context.
 */
import { END, START } from '@langchain/langgraph'
import {
  VALUATION_WORKFLOW_STAGES,
  type ValuationWorkflowGraphEdgeView,
  type ValuationWorkflowGraphNodeView,
  type ValuationWorkflowGraphView,
  type ValuationWorkflowStage,
} from '../../shared/contracts/valuation-workflow.ts'

/** Concise Chinese labels for the known business nodes. */
const BUSINESS_LABELS: Record<ValuationWorkflowStage, string> = {
  elements: '项目要素核实',
  rights: '对象核实',
  plan: '方法与计算方案',
  evidence: '证据与案例',
  calculation: '按口径测算',
  review: '成果复核',
  delivery: '成果验收与交付',
}

const MARKET_LABELS: Record<TemplateMarketNodeId, string> = { templates: '计算表模板', materials: '上传资料', 'collection-plan': '制定采集方案', 'confirm-plan': '确认采集方案', 'search-listings': '检索案例列表', 'candidate-workbook': '生成候选案例表', 'select-cases': '选择案例', 'inspect-details': '核实详情与截图', 'check-inputs': '检查填表条件', 'fill-template': '回填计算表', 'validate-delivery': '校验与交付' }

const ROUTER_LABEL = '意图识别与路由'
const START_LABEL = '开始'
const END_LABEL = '结束'

/** The native intent router node name used inside the valuation graph. */
const INTENT_ROUTER_NAME = 'intent-router'

interface NativeDrawableNode {
  id: string
  name: string
}

interface NativeDrawableEdge {
  source: string
  target: string
  data?: string
  conditional?: boolean
}

interface NativeDrawableGraph {
  nodes: Record<string, NativeDrawableNode>
  edges: NativeDrawableEdge[]
}

/** Structural view of a compiled graph; only the metadata read is required. */
export interface CompiledWorkflowGraphLike {
  getGraphAsync(config: { xray?: boolean | number }): Promise<NativeDrawableGraph>
}

export interface DescribeWorkflowGraphOptions {
  graphId: string
  version: string
}

function isBusinessStage(value: string): value is ValuationWorkflowStage {
  return (VALUATION_WORKFLOW_STAGES as readonly string[]).includes(value)
}

function presentNode(nodeId: string, nativeName: string): { label: string; stage?: ValuationWorkflowStage } {
  if (isBusinessStage(nativeName)) {
    return { label: BUSINESS_LABELS[nativeName], stage: nativeName }
  }
  if (nodeId === START) return { label: START_LABEL }
  if (nodeId === END) return { label: END_LABEL }
  if (nativeName === INTENT_ROUTER_NAME || nodeId.endsWith(`:${INTENT_ROUTER_NAME}`)) {
    return { label: ROUTER_LABEL }
  }
  // Unknown registered ids keep an inert native label instead of a business claim.
  const inert = nativeName.trim() !== '' ? nativeName : nodeId
  return { label: inert }
}

function toNodeView(node: NativeDrawableNode): ValuationWorkflowGraphNodeView {
  const nodeId = String(node.id)
  const nativeName = typeof node.name === 'string' ? node.name : ''
  const marketId = (TEMPLATE_MARKET_NODES as readonly string[]).includes(nativeName) ? nativeName as TemplateMarketNodeId : undefined
  const presented = marketId ? { label: MARKET_LABELS[marketId] } : presentNode(nodeId, nativeName)
  const view: ValuationWorkflowGraphNodeView = {
    nodeId,
    ...(marketId ? { templateMarketNodeId: marketId } : {}),
    label: presented.label,
    state: 'pending',
    gaps: [],
  }
  if (presented.stage !== undefined) view.stage = presented.stage
  return view
}

function toEdgeView(edge: NativeDrawableEdge): ValuationWorkflowGraphEdgeView {
  return {
    source: String(edge.source),
    target: String(edge.target),
    conditional: edge.conditional === true,
  }
}

/**
 * Describe the actual compiled root graph as plain serializable facts.
 *
 * Nodes and edges are copied one-to-one from the native expanded metadata, so
 * intent routing and sentinel nodes stay visible to the Client.
 */
export async function describeWorkflowGraph(
  compiledRoot: CompiledWorkflowGraphLike,
  options: DescribeWorkflowGraphOptions,
): Promise<ValuationWorkflowGraphView> {
  const native = await compiledRoot.getGraphAsync({ xray: 2 })
  const nativeNodes = Object.values(native.nodes ?? {})
  const nativeEdges = Array.isArray(native.edges) ? native.edges : []
  return {
    graphId: options.graphId,
    version: options.version,
    nodes: nativeNodes.map(toNodeView),
    edges: nativeEdges.map(toEdgeView),
  }
}
