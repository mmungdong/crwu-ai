import assert from 'node:assert/strict'
import test from 'node:test'
import { marketPorts } from '../../helpers/template-market-fixture.mjs'
import { createValuationWorkflowService } from '../../../src/host/domains/report-evaluation/workflow/service.ts'

test('service persists v2 questions, restores without IO, submits once and leaves v1 explicit', async () => {
  const calls = [], saved = []
  const ports = { templateMarket: marketPorts(calls) }
  const service = createValuationWorkflowService(ports, { persistence: { save: async image => saved.push(structuredClone(image)) } })
  const input = { runId: 'service-v2', object: { objectId: 'object-1', useLabel: '住宅', areaSqm: 80 },
    initialInput: { userInput: '', assetType: 'real-estate', methodRequest: 'market', purpose: null, baseDate: null,
      valueType: null, templateFileId: null, supplementalPrompt: '', inputDigest: null, files: [] } }
  const started = await service.start(input)
  assert.equal(started.snapshot.templateMarket?.currentNode, 'confirm-plan')
  assert.equal(started.snapshot.status, 'waiting-user')
  const image = await service.exportRun(input.runId)
  assert.equal(image.format, 'crwu.valuation.run.v2')
  service.dispose()
  const restored = createValuationWorkflowService(ports)
  const before = calls.length
  assert.equal((await restored.restoreRun(image)).ok, true)
  assert.equal(calls.length, before)
  const q = image.questionnaire
  const submission = { runId: input.runId, nodeId: 'confirm-plan', expectedRevision: image.revision,
    expectedQuestionVersion: q.version, submissionId: 'approve-once', supplement: '', noteEdits: {},
    answers: { 'confirm-plan:approval': { kind: 'choice', values: ['accept'], supplement: '' } } }
  const accepted = await restored.submitQuestions(submission)
  assert.equal(accepted.snapshot.templateMarket.currentNode, 'select-cases')
  assert.equal(calls.filter(c => c.name === 'search').length, 1)
  await restored.submitQuestions(submission)
  assert.equal(calls.filter(c => c.name === 'search').length, 1)
  const forged = structuredClone(await restored.exportRun(input.runId))
  forged.templateMarket.runId = 'another-run'
  assert.equal((await createValuationWorkflowService(ports).restoreRun(forged)).ok, false)
  assert.ok(saved.some(s => s.templateMarket?.currentNode === 'confirm-plan' && s.status === 'waiting-user'))
})

test('new run image restores waiting questions without IO and rejects forged output or approval', async () => {
  const loaded = await import('../../../src/host/domains/report-evaluation/workflow/template-market-flow.ts').catch(() => null)
  assert.equal(typeof loaded?.parseTemplateMarketState, 'function')
  const flow = loaded.createTemplateMarketFlow(marketPorts(), { save: async () => {} })
  const state = await flow.drive(loaded.createTemplateMarketState({ runId: 'run-1', initialInput: null }), 'templates')
  assert.deepEqual(loaded.parseTemplateMarketState(JSON.parse(JSON.stringify(state))), state)
  for (const mutate of [s => { s.approvedPlanDigest = 'forged' }, s => { s.receipts.templates.output.data.shell = 'exec' },
    s => { s.selectedCaseIds = ['foreign'] }, s => { s.receipts['not-a-node'] = {} }, s => { s.extra = true }]) {
    const bad = structuredClone(state); mutate(bad)
    assert.equal(loaded.parseTemplateMarketState(bad), null)
  }
})

test('semantic invalidation preserves original input and unrelated evidence but revokes affected approval', async () => {
  const loaded = await import('../../../src/host/domains/report-evaluation/workflow/template-market-flow.ts').catch(() => null)
  assert.equal(typeof loaded?.createTemplateMarketFlow, 'function')
  const flow = loaded.createTemplateMarketFlow(marketPorts(), { save: async () => {} })
  const state = await flow.drive(loaded.createTemplateMarketState({ runId: 'run-1', initialInput: null }), 'templates')
  const same = flow.invalidate(state, ['note'])
  assert.equal(same.receipts.templates.state, 'passed')
  const changed = flow.invalidate(state, ['template'])
  assert.equal(changed.approvedPlanDigest, null)
  assert.equal(changed.receipts.materials.state, 'passed')
  assert.deepEqual(changed.initialInput, state.initialInput)
  assert.equal(state.receipts.templates.state, 'passed')
})
