import assert from 'node:assert/strict'
import test from 'node:test'
import { marketPorts } from '../../helpers/template-market-fixture.mjs'

async function load() {
  const module = await import('../../../src/host/domains/report-evaluation/workflow/template-market-flow.ts').catch(() => null)
  assert.equal(typeof module?.createTemplateMarketFlow, 'function', 'new runs must execute a real template-driven graph')
  return module
}
const command = (state, answers, id) => ({ nodeId: state.currentNode, expectedRevision: state.inputVersion,
  expectedQuestionVersion: state.questionnaire.version, answers, supplement: '', noteEdits: {}, submissionId: id })
async function answer(state, values, id) {
  const { submitQuestionAnswers } = await import('../../../src/host/domains/report-evaluation/workflow/questionnaire.ts')
  const answers = Object.fromEntries(state.questionnaire.questions.filter(q => q.nodeId === state.currentNode)
    .map(q => [q.questionId, values[q.field]]))
  const submitted = submitQuestionAnswers(state.questionnaire, command(state, answers, id))
  assert.equal(submitted.ok, true, submitted.error)
  return { ...state, questionnaire: submitted.state }
}

test('real graph forks preparation, joins before planning and stops at both persisted confirmations', async () => {
  const { createTemplateMarketFlow, createTemplateMarketState } = await load()
  const calls = [], images = []
  const ports = marketPorts(calls)
  let releaseTemplates
  const barrier = new Promise(resolve => { releaseTemplates = resolve })
  const templates = ports.readTemplates
  ports.readTemplates = async (...args) => { await barrier; return templates(...args) }
  const materials = ports.readMaterials
  ports.readMaterials = async (...args) => { releaseTemplates(); return materials(...args) }
  const flow = createTemplateMarketFlow(ports, { save: async s => { images.push(structuredClone(s)) } })
  let state = await flow.drive(createTemplateMarketState({ runId: 'run-1', initialInput: null }), 'templates')
  assert.equal(state.status, 'waiting-user')
  assert.equal(state.currentNode, 'confirm-plan')
  assert.deepEqual(calls.map(c => c.name).sort(), ['materials', 'plan', 'templates'])
  assert.equal(images.at(-1).status, 'waiting-user')
  const count = calls.length
  await flow.drive(state, 'confirm-plan')
  assert.equal(calls.length, count, 'polling a waiting confirmation never starts another model')
  state = await answer(state, { approval: { kind: 'choice', values: ['accept'], supplement: '' } }, 'plan-1')
  state = await flow.drive(state, 'confirm-plan')
  assert.equal(state.currentNode, 'select-cases')
  assert.equal(calls.filter(c => c.name === 'search').length, 1)
  assert.equal(calls.filter(c => c.name === 'workbook').length, 1)
  assert.equal(calls.filter(c => c.name === 'details').length, 0)
  state = await answer(state, { caseIds: { kind: 'choice', values: ['case-2'], supplement: '' },
    searchDecision: { kind: 'choice', values: ['stop'], supplement: '' } }, 'select-1')
  state = await flow.drive(state, 'select-cases')
  assert.equal(state.status, 'partial')
  assert.deepEqual(calls.find(c => c.name === 'details').input.upstream['select-cases'].selectedCaseIds, ['case-2'])
  assert.equal(state.receipts['fill-template'].output.data.calculation, null)
  assert.equal(state.artifacts.some(a => a.kind === 'workpaper'), true)
})

test('failed preparation cannot be overwritten by its successful parallel sibling', async () => {
  const { createTemplateMarketFlow, createTemplateMarketState } = await load()
  const calls = [], ports = marketPorts(calls)
  ports.readTemplates = async () => ({ outcome: 'failed', summary: '模板读取失败', data: null, questions: [], limitations: [],
    failure: { kind: 'system', reason: '模板服务返回错误', requirements: [], actions: ['修复服务后重试'] } })
  const flow = createTemplateMarketFlow(ports, { save: async () => {} })
  const state = await flow.drive(createTemplateMarketState({ runId: 'run-1', initialInput: null }), 'templates')
  assert.equal(state.status, 'failed')
  assert.equal(calls.some(c => c.name === 'plan'), false)
  assert.equal(state.receipts.templates.state, 'failed')
  assert.equal(state.receipts.materials.state, 'passed')
})

test('durable write failure prevents all later side effects and cancellation retains completed preparation', async () => {
  const { createTemplateMarketFlow, createTemplateMarketState } = await load()
  const calls = []
  const flow = createTemplateMarketFlow(marketPorts(calls), { save: async () => { throw Error('private storage error') } })
  await assert.rejects(flow.drive(createTemplateMarketState({ runId: 'run-1', initialInput: null }), 'templates'), /持久化/)
  assert.equal(calls.length, 0)
  const controller = new AbortController(), ports = marketPorts(calls)
  const read = ports.readMaterials
  ports.readMaterials = async (...args) => { const result = await read(...args); controller.abort(); return result }
  const cancelFlow = createTemplateMarketFlow(ports, { save: async () => {} })
  const state = await cancelFlow.drive(createTemplateMarketState({ runId: 'run-1', initialInput: null }), 'templates', controller.signal)
  assert.equal(state.status, 'cancelled')
  assert.equal(calls.some(c => c.name === 'plan'), false)
})

test('native graph exposes actual eleven nodes and parallel join edges', async () => {
  const loaded = await import('../../../src/host/graph/valuation/realestate/template-market.ts').catch(() => null)
  assert.equal(typeof loaded?.compileTemplateMarketGraph, 'function')
  const graph = await loaded.compileTemplateMarketGraph(async () => ({ status: 'waiting', outputs: {} })).getGraphAsync()
  assert.equal(Object.keys(graph.nodes).filter(key => !['__start__', '__end__'].includes(key)).length, 11)
  assert.equal(graph.edges.some(edge => edge.source === 'templates' && edge.target === 'collection-plan'), true)
  assert.equal(graph.edges.some(edge => edge.source === 'materials' && edge.target === 'collection-plan'), true)
  assert.equal(graph.edges.some(edge => edge.source === 'confirm-plan' && edge.target === 'fill-template'), false, 'the descriptor must not advertise impossible shortcuts')
})

test('known port capability failures keep actionable diagnostics without exposing raw exceptions', async () => {
  const module = await import('../../../src/host/domains/report-evaluation/workflow/template-market-flow.ts')
  const { TemplateMarketPortError } = await import('../../../src/host/domains/report-evaluation/workflow/ports.ts')
  assert.equal(typeof TemplateMarketPortError, 'function')
  const { marketPorts } = await import('../../helpers/template-market-fixture.mjs')
  const ports = marketPorts()
  ports.readTemplates = async () => { throw new TemplateMarketPortError('工作簿 Python/openpyxl 本平台不存在，请管理员修复 DSH 运行时后重试') }
  const state = module.createTemplateMarketState({ runId: 'capability-error', initialInput: null })
  const result = await module.createTemplateMarketFlow(ports, { save: async () => {} }).drive(state, 'templates')
  assert.match(result.receipts.templates.output.failure.reason, /本平台不存在/)
  assert.match(result.receipts.templates.output.failure.actions.join(' '), /管理员修复/)
  ports.readTemplates = async () => { throw new Error('raw private endpoint credential') }
  const raw = await module.createTemplateMarketFlow(ports, { save: async () => {} }).drive(state, 'templates')
  assert.doesNotMatch(JSON.stringify(raw), /raw private endpoint credential/)
})

test('graph generation uses the entry wire type and keeps an already registered generation', async () => {
  const { usesTemplateMarketFlow, workflowGraphVersionFor } = await import('../../../src/host/domains/report-evaluation/workflow/flow-version.ts')
  const frozen = { assetType: 'real-estate', methodRequest: 'market' }
  assert.equal(usesTemplateMarketFlow(frozen), true)
  assert.equal(usesTemplateMarketFlow({ ...frozen, assetType: 'realestate' }), false)
  assert.equal(usesTemplateMarketFlow({ ...frozen, methodRequest: 'income' }), false)
  assert.equal(workflowGraphVersionFor({ dto: null, frozen }), '2')
  assert.equal(workflowGraphVersionFor({ dto: {}, frozen }), '1')
  assert.equal(workflowGraphVersionFor({ dto: null, frozen, graphVersion: '1' }), '1')
})
