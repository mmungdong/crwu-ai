import * as React from 'react'
import type {
  ValuationWorkflowGraphEdgeView,
  ValuationWorkflowGraphNodeView,
  ValuationWorkflowStageState,
} from '../../../../../shared/contracts/valuation-workflow.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'
import { currentNodeIdOf, phaseOfNode, stageLabelOf, stateLabelOf } from './model.ts'

export interface WorkflowGraphProps {
  graphId: string
  nodes: ValuationWorkflowGraphNodeView[]
  edges: ValuationWorkflowGraphEdgeView[]
  detailNodeId: string | null
  onSelectNode: (nodeId: string, target?: { focus?: () => void } | null) => void
  /** Pending projection during material reading: topology only, no node inspection. */
  readOnly?: boolean
  running?: boolean
}

const RUNNING_STATES = new Set<ValuationWorkflowStageState>(['running'])
const ATTENTION_STATES = new Set<ValuationWorkflowStageState>(['waiting', 'partial'])
const FAILED_STATES = new Set<ValuationWorkflowStageState>(['blocked', 'failed'])
const CANCELLED_STATES = new Set<ValuationWorkflowStageState>(['cancelled'])

/** Code-native state glyph: shape and colour both carry the state, never colour alone. */
function StateIcon(props: { state: ValuationWorkflowStageState }): React.ReactElement {
  const { state } = props
  if (RUNNING_STATES.has(state)) {
    return <span className={W.graphSpinner} aria-hidden="true" />
  }
  if (FAILED_STATES.has(state) || CANCELLED_STATES.has(state)) {
    return <svg className={W.graphStateIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  }
  if (ATTENTION_STATES.has(state)) {
    return <svg className={W.graphStateIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.6l6 10.8H2L8 2.6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6.6v3.1M8 11.4v.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  }
  if (state === 'passed') {
    return <svg className={W.graphStateIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.4l3.2 3.1L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  }
  return <svg className={W.graphStateIcon} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" fill="currentColor" />
  </svg>
}

/**
 * The connected work surface: exact Host node ids and edges, no fabricated stages.
 *
 * Edges are rendered as code-native connectors after their source node; each carries
 * `data-workflow-edge-from/to` so the shape is inspectable without reading pixels.
 * A read-only (pre-snapshot) graph states that it is still syncing and never claims
 * a completed stage or a percentage the Host has not reported.
 */
export function WorkflowGraph(props: WorkflowGraphProps): React.ReactElement {
  const current = currentNodeIdOf(props.nodes)
  const readOnly = props.readOnly === true
  const initializing = props.running === true && !readOnly
    && props.nodes.some((node) => node.state === 'pending' && phaseOfNode(node) !== 'boundary')
    && props.nodes.every((node) => node.state === 'pending' || node.state === 'passed')

  return <section className={W.graphPanel} data-workflow-graph={props.graphId}
    data-workflow-graph-readonly={String(readOnly)} aria-label="流程节点">
    <div className={W.graphHead}>
      <h3 className={W.panelTitle}>流程节点</h3>
      {readOnly
        ? <span className={W.graphSyncing} role="status" data-workflow-graph-syncing="true">
          <span className={W.graphSpinner} aria-hidden="true" />正在同步流程状态…
        </span>
        : null}
      {initializing
        ? <span className={W.graphSyncing} role="status" data-workflow-node-initializing="true">
          <span className={W.graphSpinner} aria-hidden="true" />下一个节点初始化中…
        </span>
        : null}
    </div>
    <ol className={W.graphNodes}>
      {props.nodes.map((node) => {
        const outgoing = props.edges.filter((edge) => edge.source === node.nodeId)
        const selected = props.detailNodeId === node.nodeId
        const phase = phaseOfNode(node)
        const canInspect = !readOnly && node.state !== 'pending'
        return <React.Fragment key={node.nodeId}>
          <li className={W.graphNodeItem} data-workflow-node-phase={phase}
            data-workflow-node-boundary={String(phase === 'boundary')}>
            <button
              type="button"
              className={W.graphNode}
              data-workflow-node={node.nodeId}
              data-workflow-node-selected={String(selected)}
              data-workflow-node-current={String(current === node.nodeId)}
              data-workflow-node-state={node.state}
              data-workflow-node-readonly={String(readOnly)}
              aria-pressed={selected}
              aria-label={`${node.label}，${stateLabelOf(node.state)}`}
              disabled={!canInspect}
              onClick={!canInspect
                ? undefined
                : (event) => {
                  props.onSelectNode(node.nodeId, (event as { currentTarget?: { focus?: () => void } } | null)?.currentTarget ?? null)
                }}
            >
              <span className={W.graphNodeState} data-workflow-node-indicator={node.state} aria-hidden="true">
                <StateIcon state={node.state} />
              </span>
              <span className={W.graphNodeBody}>
                <span className={W.graphNodeLabel}>{node.label}</span>
                <span className={W.graphNodeMeta}>
                  {node.stage === undefined
                    ? null
                    : <span className={W.graphStage}>{stageLabelOf(node.stage)}</span>}
                  <span className={W.graphState}>{stateLabelOf(node.state)}</span>
                </span>
              </span>
            </button>
          </li>
          {outgoing.map((edge) => <li
            key={`${edge.source}:${edge.target}`}
            className={W.graphEdge}
            data-workflow-edge-from={edge.source}
            data-workflow-edge-to={edge.target}
            data-workflow-edge-conditional={String(edge.conditional)}
          >
            <span className={W.graphEdgeLine} aria-hidden="true" />
            <span className={W.graphEdgeLabel}>{edge.conditional ? '条件分支' : '顺序执行'}</span>
          </li>)}
        </React.Fragment>
      })}
    </ol>
  </section>
}
