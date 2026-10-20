import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferred, createNodeDetail } from '../../helpers/valuation-workflow-fixture.mjs'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'

const current = (version) => ({ ok: true, empty: false, projectId: 'p', runId: 'r', phase: 'running',
  snapshot: { runId: 'r', revision: 1, status: 'running', updatedAt: String(version) },
  progress: { runId: 'r', revision: 1, status: 'running' }, graph: { nodes: [], edges: [] } })

test('a slow open node detail must not stall workflow status polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  const detailWait = createDeferred()
  let currents = 0, nodes = 0
  const controller = createValuationWorkflowController({
    current: async () => current(++currents),
    node: async () => { if (++nodes > 1) await detailWait.promise; return { ok: true, detail: { nodeId: 'rights', revision: 1 } } },
    action: async () => ({ ok: true }),
  }, { pollIntervalMs: 100 })
  t.after(() => { detailWait.resolve(); controller.dispose() })
  await controller.activate()
  await controller.selectNode('rights')
  t.mock.timers.tick(100)
  await new Promise(setImmediate)
  assert.equal(currents, 2)
  t.mock.timers.tick(100)
  await new Promise(setImmediate)
  assert.ok(currents >= 3, `status reads stopped at ${currents} while node detail remained pending`)
  assert.equal(nodes, 2, 'polling must share the pending detail read instead of cancelling and restarting it')
})

test('closed node input and output do not eagerly render large receipt trees', async (t) => {
  const { NodeInspector } = await import('../../../src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx')
  const rows = Array.from({ length: 300 }, (_, index) => ({ id: index, records: ['材料', '来源', '计算记录'] }))
  const detail = createNodeDetail({ inputs: [{ field: 'large-input', label: '材料', rawValue: rows }],
    outputs: [{ field: 'large-output', label: '回执', rawValue: rows }] })
  const started = performance.now()
  const tree = render(NodeInspector, { detail, stale: false, busy: false, canRetry: false, retryAnswer: '',
    onRetryAnswerChange() {}, onRetrySubmit() {} }).tree
  const values = findAll(tree, (node) => node.props?.['data-workflow-field-value'] !== undefined)
  t.diagnostic(JSON.stringify({ collapsedRenderMs: Math.round((performance.now() - started) * 100) / 100, eagerFields: values.length }))
  assert.equal(values.length, 0, 'closed input/output still build every structured value')
})

test('reentering the same task cannot reuse an aborted background detail request', async (t) => {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  const oldDetail = createDeferred()
  let version = 0, nodes = 0
  const controller = createValuationWorkflowController({ current: async () => current(++version),
    node: async () => { if (++nodes === 2) await oldDetail.promise; return { ok: true, detail: { nodeId: 'rights', revision: 1 } } },
    action: async () => ({ ok: true }),
  }, { autoPoll: false })
  t.after(() => { oldDetail.resolve(); controller.dispose() })
  await controller.activate()
  await controller.selectNode('rights')
  const oldRefresh = controller.refresh()
  await new Promise(setImmediate)
  controller.deactivate()
  await controller.activate()
  await controller.selectNode('rights')
  const newRefresh = controller.refresh()
  await new Promise(setImmediate)
  assert.equal(nodes, 4, 'a new page lifecycle must issue its own detail refresh')
  oldDetail.resolve()
  await Promise.all([oldRefresh, newRefresh])
})

test('receipt sections mount independently on demand and reset for another node', async () => {
  const { NodeInspector } = await import('../../../src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx')
  const props = { detail: createNodeDetail({ rawInputs: { hidden: '完整输入' }, rawOutputs: { hidden: '完整输出' } }),
    stale: false, busy: false, canRetry: false, retryAnswer: '', onRetryAnswerChange() {}, onRetrySubmit() {} }
  const section = (tree, name) => find(tree, (node) => node.props?.['data-workflow-detail'] === name)
  let tree = render(NodeInspector, props).tree
  section(tree, 'input').props.onToggle({ currentTarget: { open: true } })
  tree = rerender(NodeInspector, props)
  assert.match(textOf(section(tree, 'input')), /完整输入/)
  assert.doesNotMatch(textOf(section(tree, 'output')), /完整输出/)
  section(tree, 'output').props.onToggle({ currentTarget: { open: true } })
  tree = rerender(NodeInspector, props)
  assert.match(textOf(section(tree, 'output')), /完整输出/)
  section(tree, 'input').props.onToggle({ currentTarget: { open: false } })
  tree = rerender(NodeInspector, props)
  assert.equal(findAll(section(tree, 'input'), (node) => node.props?.['data-workflow-field-value'] !== undefined).length, 0)
  tree = rerender(NodeInspector, { ...props, detail: { ...props.detail, nodeId: 'other-node' } })
  assert.equal(section(tree, 'output').props.open, false)
  assert.doesNotMatch(textOf(section(tree, 'output')), /完整输出/)
})
