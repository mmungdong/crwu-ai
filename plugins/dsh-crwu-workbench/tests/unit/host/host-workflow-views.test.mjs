import assert from 'node:assert/strict'
import test from 'node:test'
import { compileWorkflowGraph } from '../../../src/host/graph/graph.ts'
import { compileValuationGraph } from '../../../src/host/graph/valuation/graph.ts'
import { createValuationGraphRegistry } from '../../../src/host/graph/valuation/registry.ts'
import { registerRealestateGraph } from '../../../src/host/graph/valuation/realestate/register.ts'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

const loadDefinition = () => import('../../../src/host/graph/definition.ts')
const loadViews = () => import('../../../src/host/domains/report-evaluation/workflow/views.ts')

test('every blocked professional node has a failure explanation and legacy opaque failures are identified as contract faults', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot(), { view } = await definition()
  for (const stage of Object.keys(state.stages)) {
    state.stages[stage].state = 'blocked'
    state.stages[stage].gaps = ['缺少经核实的租赁起止日期']
    state.stages[stage].outputs = {}
    const detail = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: `valuation:realestate:${stage}` }).detail
    assert.match(detail.failure.reason, /租赁起止日期/)
    assert.ok(detail.failure.requirements.length > 0)
    assert.ok(detail.failure.actions.length > 0)
  }
  state.stages.plan.gaps = ['子会话没有返回本节点允许的结构化成果']
  const legacy = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'valuation:realestate:plan' }).detail
  assert.equal(legacy.failure.kind, 'output-contract')
  assert.match(legacy.failure.reason, /历史|未记录/)
})

async function definition() {
  let calls = 0
  const registry = createValuationGraphRegistry()
  registerRealestateGraph(registry, async () => { calls += 1; throw new Error('inspection cannot execute a stage') })
  const valuation = compileValuationGraph({ registry, inferIntent: async () => { calls += 1; throw new Error('inspection cannot infer intent') } })
  const root = compileWorkflowGraph({ valuation })
  const { describeWorkflowGraph } = await loadDefinition()
  const view = await describeWorkflowGraph(root, { graphId: 'valuation', version: '1' })
  return { view, native: await root.getGraphAsync({ xray: 2 }), calls: () => calls }
}

async function snapshot() {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts()
  const service = createValuationWorkflowService(ports)
  try { return (await service.start(createStartInput())).snapshot } finally { service.dispose() }
}

test('the UI definition comes from actual expanded graph metadata without running inference', async () => {
  const f = await definition()
  assert.equal(f.calls(), 0)
  assert.deepEqual(f.view.nodes.map((node) => node.nodeId).sort(), Object.values(f.native.nodes).map((node) => node.id).sort())
  const key = (edge) => `${edge.source}|${edge.target}|${Boolean(edge.conditional)}`
  assert.deepEqual(f.view.edges.map(key).sort(), f.native.edges.map(key).sort())
  assert.ok(f.view.nodes.every((node) => typeof node.label === 'string' && node.label !== ''))
})

test('node receipts distinguish actual program amounts from model output and retain the actual session', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  const { view } = await definition()
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'valuation:realestate:calculation' })
  assert.equal(result.detail.nodeId, 'valuation:realestate:calculation')
  assert.equal(result.detail.sessionId, state.stages.calculation.sessionId)
  const amount = result.detail.outputs.find((field) => field.field === 'unitPrice')
  assert.equal(amount.sourceKind, 'program')
  assert.equal(Number(amount.value.replaceAll(',', '')), state.result.unitPrice)
  assert.ok(result.detail.outputs.some((field) => field.field === 'boundInputs' && field.sourceKind === 'model'))
  assert.equal(result.detail.inputs.find((field) => field.field === 'useLabel').value, '公寓')
  assert.equal(result.progress.formalComplete, false)
  assert.equal(result.progress.referenceDelivered, true)
  assert.equal(result.progress.percentage, null)
  assert.deepEqual(result.progress.graph.nodes.map((node) => node.nodeId), view.nodes.map((node) => node.nodeId))
})

test('read sources are not mislabeled as adopted rules and foreign node IDs expose no receipt', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  state.stages.evidence.outputs.requirements.push({ requirementId: 'not-adopted', source: {
    sourceId: 'foreign-rule', quote: 'NOT_ADOPTED', section: 'fake' }, statement: 'NOT_ADOPTED' })
  const { view } = await definition()
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'valuation:realestate:evidence' })
  assert.ok(result.detail.knowledge.length > 0)
  assert.ok(result.detail.knowledge.every((ref) => ref.sourceId !== 'foreign-rule' && ref.quote !== 'NOT_ADOPTED'))
  assert.ok(result.detail.readSources.length > 0)
  assert.equal(projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'foreign-node' }).detail, null)
})

test('inspection requires the exact graph node ID and preserves precision in actual inputs', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  const { view } = await definition()
  state.stages.rights.inputs.facts.confirmedFacts.areaSqm = 100.125
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'valuation:realestate:rights' })
  assert.equal(result.detail.inputs.find((field) => field.field === 'areaSqm').value, '100.125')
  assert.equal(projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'rights' }).detail, null)
})

test('a later revision retains field-level user provenance and does not borrow another node prompt source', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  const { view } = await definition()
  state.revision = 3
  state.stages.rights.inputs.facts.confirmedFacts.areaSqm = 150
  state.stages.rights.inputs.promptSupplement = ''
  state.stages.elements.outputs.adoptedFacts = [{ field: 'areaSqm', value: 100,
    source: { materialId: 'original-title', digest: 'sha256:original', quote: '原建筑面积100平方米' } }]
  state.revisions = [
    { revision: 2, changes: [{ nodeId: 'rights', field: 'areaSqm', before: 100, after: 150,
      sourceKind: 'user', source: '用户补充测绘资料', reason: '补充测绘' }] },
    { revision: 3, changes: [{ nodeId: 'review', field: 'promptSupplement', before: '', after: '再查一次',
      sourceKind: 'user', source: '只用于复核节点', reason: '复核' }] },
  ]
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'valuation:realestate:rights' })
  const area = result.detail.inputs.find((field) => field.field === 'areaSqm')
  assert.equal(area.sourceKind, 'user')
  assert.equal(area.source, '用户补充测绘资料')
  assert.notEqual(result.detail.inputs.find((field) => field.field === 'promptSupplement').source, '只用于复核节点')
})

test('the inspector exposes cloned complete node receipts without rewriting the input or result', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  const { view } = await definition()
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: 'valuation:realestate:calculation' })
  assert.deepEqual(result.detail.rawInputs, state.stages.calculation.inputs)
  assert.deepEqual(result.detail.rawOutputs, state.stages.calculation.outputs)
  result.detail.rawInputs.synthetic = 'only-view'
  assert.equal(state.stages.calculation.inputs.synthetic, undefined)
})

test('router progress and inspection expose the actual routing receipt and admitted input', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  const { view } = await definition()
  const node = view.nodes.find((item) => item.nodeId.endsWith(':intent-router'))
  state.routing = { route: 'realestate', intentSessionId: 'actual-intent-session', intent: {
    business: 'valuation', assetType: 'realestate', status: 'resolved', objects: [], evidence: [], questions: [],
  } }
  const context = { userInput: '按上传材料自动识别', materials: [{ materialId: 'mat-1', fileName: '合成产权证.pdf', digest: 'sha256:synthetic', text: '合成公寓材料' }] }
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: node.nodeId, inputContext: context })
  assert.equal(result.progress.graph.nodes.find((item) => item.nodeId === node.nodeId).state, 'passed')
  assert.equal(result.detail.sessionId, 'actual-intent-session')
  assert.deepEqual(result.detail.rawInputs, context)
  assert.deepEqual(result.detail.rawOutputs, state.routing)
  assert.ok(result.detail.inputs.some((item) => item.field === 'userInput' && item.sourceKind === 'user'))
  assert.ok(result.detail.inputs.some((item) => item.field === 'materials' && item.sourceKind === 'material'))
  result.detail.rawInputs.materials[0].text = 'VIEW_ONLY'
  assert.equal(context.materials[0].text, '合成公寓材料')
  state.routing.intent.status = 'needs-clarification'
  state.routing.intent.questions = ['请明确资产类型']
  const waiting = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: node.nodeId, inputContext: context })
  assert.equal(waiting.progress.graph.nodes.find((item) => item.nodeId === node.nodeId).state, 'waiting')
  assert.deepEqual(waiting.detail.gaps, ['请明确资产类型'])
})

test('a blocked router without an adopted intent exposes the failed node and actual error', async () => {
  const { projectWorkflowSnapshot } = await loadViews()
  const state = await snapshot()
  const { view } = await definition()
  state.status = 'blocked'
  state.error = '当前只支持单一估值对象：请确认本次对象'
  state.routing = { route: '', intent: null, intentSessionId: 'actual-router-child' }
  for (const stage of Object.values(state.stages)) { stage.state = 'pending'; stage.attempt = 0 }
  const node = view.nodes.find((item) => item.nodeId.endsWith(':intent-router'))
  const result = projectWorkflowSnapshot({ snapshot: state, graph: view, selectedNodeId: node.nodeId })
  assert.equal(result.progress.graph.nodes.find((item) => item.nodeId === node.nodeId).state, 'blocked')
  assert.ok(result.detail.gaps.includes(state.error))
  assert.equal(result.detail.sessionId, 'actual-router-child')
})
