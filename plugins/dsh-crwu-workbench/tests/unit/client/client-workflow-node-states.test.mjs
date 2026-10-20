import assert from 'node:assert/strict'
import test from 'node:test'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'
import { createNodeDetail, createProgressView } from '../../helpers/valuation-workflow-fixture.mjs'

const attr = (name) => (node) => node.props?.[name] !== undefined
const nodes = [
  { nodeId: '__start__', label: '开始', state: 'pending', gaps: [] },
  { nodeId: 'plan', label: '方法与计算方案', state: 'passed', stage: 'plan', gaps: [] },
  { nodeId: 'evidence', label: '证据与案例', state: 'pending', stage: 'evidence', gaps: [] },
]

test('only pending nodes are disabled; readonly still disables all nodes', async () => {
  const { WorkflowGraph } = await import('../../../src/client/modules/report-evaluation/ui/workflow/WorkflowGraph.tsx')
  const states = ['pending', 'running', 'waiting', 'passed', 'partial', 'blocked', 'failed', 'cancelled']
  for (const readOnly of [false, true]) {
    const selected = []
    const tree = render(WorkflowGraph, {
      graphId: 'synthetic', nodes: states.map((state) => ({ nodeId: state, label: state, state, gaps: [] })),
      edges: [], detailNodeId: null, readOnly, onSelectNode: (id) => selected.push(id),
    }).tree
    for (const button of findAll(tree, attr('data-workflow-node'))) {
      const state = button.props['data-workflow-node-state']
      const enabled = !readOnly && state !== 'pending'
      assert.equal(button.props.disabled, !enabled, state)
      button.props.onClick?.()
    }
    assert.deepEqual(selected, readOnly ? [] : states.filter((state) => state !== 'pending'))
  }
})

test('a blocked node opens its loading drawer and then shows the block reason', async () => {
  const { ValuationWorkflowPane } = await import('../../../src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx')
  const selected = []
  const props = {
    progress: createProgressView({ status: 'blocked', graph: { graphId: 'synthetic',
      nodes: [{ nodeId: 'evidence', label: '证据与案例', stage: 'evidence', state: 'blocked', gaps: ['请补充案例资料'] }], edges: [] } }),
    detail: null, onSelectNode: (id) => selected.push(id), onRefresh() {}, onSubmitRevision() {},
  }
  let tree = render(ValuationWorkflowPane, props).tree
  find(tree, (node) => node.props?.['data-workflow-node'] === 'evidence').props.onClick()
  assert.deepEqual(selected, ['evidence'])
  tree = rerender(ValuationWorkflowPane, props)
  assert.ok(find(tree, attr('data-workflow-node-loading')))
  tree = rerender(ValuationWorkflowPane, { ...props,
    detail: createNodeDetail({ nodeId: 'evidence', label: '证据与案例', stage: 'evidence', gaps: ['请补充案例资料'] }),
  })
  assert.match(textOf(find(tree, (node) => node.props?.role === 'dialog')), /请补充案例资料/)
})

test('between nodes the running workflow shows initialization text with a spinner', async () => {
  const { ValuationWorkflowPane } = await import('../../../src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx')
  const progress = createProgressView({ status: 'running', outcome: null, graph: { graphId: 'synthetic', nodes, edges: [] } })
  const props = { progress, detail: null, onSelectNode() {}, onRefresh() {}, onSubmitRevision() {} }
  const tree = render(ValuationWorkflowPane, props).tree
  const status = find(tree, attr('data-workflow-node-initializing'))
  assert.ok(status)
  assert.equal(status.props.role, 'status')
  assert.match(textOf(status), /下一个节点初始化中/)
  assert.ok(find(status, (node) => node.props?.className?.includes('graph-spinner')))
  assert.equal(find(tree, (node) => node.props?.['data-workflow-node'] === 'evidence').props.disabled, true)
  assert.equal(findAll(tree, (node) => node.props?.['data-workflow-node-state'] === 'running').length, 0)
  for (const patch of [
    { status: 'waiting-user', waiting: true }, { status: 'failed' }, { status: 'blocked' },
    { status: 'completed' }, { status: 'partial' }, { status: 'cancelled' },
    { graph: { graphId: 'synthetic', nodes: nodes.map((node) => node.nodeId === 'evidence' ? { ...node, state: 'running' } : node), edges: [] } },
    { graph: { graphId: 'synthetic', nodes: nodes.map((node) => ({ ...node, state: 'passed' })), edges: [] } },
  ]) {
    const next = render(ValuationWorkflowPane, { ...props, progress: { ...progress, ...patch } }).tree
    assert.equal(find(next, attr('data-workflow-node-initializing')), null, JSON.stringify(patch))
  }
  for (const runPhase of ['failed', 'blocked', 'cancelled', 'completed', 'waiting-user']) {
    const next = render(ValuationWorkflowPane, { ...props, runPhase }).tree
    assert.equal(find(next, attr('data-workflow-node-initializing')), null, runPhase)
  }
})
