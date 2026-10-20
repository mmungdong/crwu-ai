import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFixturePorts, createStartInput, loadWorkflowService, WORKFLOW_STAGES,
} from '../../helpers/valuation-workflow-fixture.mjs'

const userInput = 'Only assess synthetic apartment A; preserve apartment use and the blank date.'
const initialInput = () => ({
  userInput, assetType: 'real-estate', methodRequest: 'market', purpose: 'synthetic transfer', baseDate: null,
  valueType: 'synthetic-market-value', templateFileId: null, supplementalPrompt: userInput,
  inputDigest: 'sha256:synthetic-input',
  files: [{ fileId: 'material-001', fileName: 'synthetic.txt', relativePath: '资料/synthetic.txt', digest: 'sha256:material-001' }],
})
const startInput = (patch = {}) => createStartInput({
  userInput, purpose: 'synthetic transfer', baseDate: null, initialInput: initialInput(), ...patch,
})

test('a fresh legacy caller retains its exact first text without inventing choices', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts()
  const service = createValuationWorkflowService(ports)
  t.after(() => service.dispose())
  const exactText = '  synthetic original scope  \n'
  await service.start(createStartInput({ userInput: exactText, baseDate: null }))
  const original = (await service.exportRun('run-0001')).initialInput
  assert.ok(original)
  assert.equal(original.userInput, exactText)
  assert.equal(original.assetType, null)
  assert.equal(original.methodRequest, null)
  assert.equal(original.baseDate, null)
})

test('all seven nodes retain every original entry choice and the current user input', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports, calls } = createFixturePorts()
  ports.knowledge.stageAware = true
  const service = createValuationWorkflowService(ports)
  t.after(() => service.dispose())
  const result = await service.start(startInput())
  assert.equal(result.snapshot.outcome, 'partial')
  assert.deepEqual(calls.inference.map((call) => call.stage), WORKFLOW_STAGES)
  for (const request of calls.inference) {
    assert.equal(request.facts.userInput, userInput, `${request.stage} lost user input`)
    assert.deepEqual(request.facts.initialInput, initialInput(), `${request.stage} lost entry choices`)
    assert.equal(request.facts.methodRequest, 'market')
    assert.equal(request.facts.valueType, 'synthetic-market-value')
    assert.equal(request.facts.baseDate, '')
    assert.deepEqual(result.snapshot.stages[request.stage].inputs.facts.initialInput, initialInput())
  }
  assert.equal(calls.knowledge.length, 7)
  for (const request of calls.knowledge) assert.deepEqual(request.initialInput, initialInput())
  assert.deepEqual((await service.exportRun('run-0001')).initialInput, initialInput())
})

test('the planning port receives the original snapshot alongside current facts', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts()
  let request
  ports.planning = { prepare: async (input) => {
    request = input
    return { ok: false, gaps: ['synthetic preflight intentionally stopped'] }
  } }
  const service = createValuationWorkflowService(ports)
  t.after(() => service.dispose())
  await service.start(startInput())
  assert.ok(request, 'exercise the actual planning boundary')
  assert.deepEqual(request.initialInput, initialInput())
  assert.equal(request.userInput, userInput)
  assert.equal(request.baseDate, '')
  assert.equal(request.object.objectId, 'object-a')
})

test('cold restore and a later area correction preserve the original choices and correction provenance', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const first = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => first.dispose())
  await first.start(startInput())
  const durable = JSON.parse(JSON.stringify(await first.exportRun('run-0001')))
  const { ports, calls } = createFixturePorts()
  const restored = createValuationWorkflowService(ports)
  t.after(() => restored.dispose())
  assert.equal((await restored.restoreRun(durable)).ok, true)
  assert.equal(calls.inference.length, 0, 'restore performs no model work')
  const revised = await restored.revise({ runId: 'run-0001', nodeId: 'rights', expectedRevision: 1,
    submissionId: 'synthetic-area-correction', reason: 'synthetic correction', source: 'synthetic user confirmation',
    changes: [{ field: 'areaSqm', value: 90 }] })
  assert.equal(revised.ok, true, revised.error)
  const third = calls.inference.find((call) => call.stage === 'plan')
  assert.ok(third)
  assert.equal(third.facts.areaSqm, 90)
  assert.equal(third.facts.userInput, userInput)
  assert.deepEqual(third.facts.initialInput, initialInput())
  assert.equal(third.facts.revision.changes[0].source, 'synthetic user confirmation')
  const saved = await restored.exportRun('run-0001')
  assert.deepEqual(saved.initialInput, initialInput())
  saved.initialInput.files[0].fileName = 'external mutation'
  assert.deepEqual((await restored.exportRun('run-0001')).initialInput, initialInput())
})

test('a node cannot mutate the canonical initial choices or its persisted input receipt through its request', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports, calls } = createFixturePorts()
  const infer = ports.inference.infer
  ports.inference.infer = async (request) => {
    if (request.stage === 'rights' && request.facts.initialInput) {
      request.facts.initialInput.files[0].fileName = 'mutated by adapter'
    }
    return infer(request)
  }
  const service = createValuationWorkflowService(ports)
  t.after(() => service.dispose())
  const result = await service.start(startInput())
  assert.deepEqual((await service.exportRun('run-0001')).initialInput, initialInput())
  assert.deepEqual(calls.inference.find((call) => call.stage === 'plan').facts.initialInput, initialInput())
  assert.deepEqual(result.snapshot.stages.rights.inputs.facts.initialInput, initialInput())
})

test('legacy restored state keeps the missing original snapshot unknown and malformed new snapshots are rejected', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const original = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => original.dispose())
  await original.start(startInput())
  const saved = JSON.parse(JSON.stringify(await original.exportRun('run-0001')))
  const legacy = structuredClone(saved)
  delete legacy.initialInput
  const restored = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => restored.dispose())
  assert.equal((await restored.restoreRun(legacy)).ok, true)
  assert.equal((await restored.exportRun('run-0001')).initialInput, null)
  for (const bad of [42, { ...initialInput(), methodRequest: 42 },
    ...[42, null, {}, []].map((relativePath) => ({ ...initialInput(), files: [{ ...initialInput().files[0], relativePath }] })),
    { ...initialInput(), files: [{ ...initialInput().files[0], relativePath: '../another-case/file.txt' }] }]) {
    const rejected = createValuationWorkflowService(createFixturePorts().ports)
    try {
      assert.equal((await rejected.restoreRun({ ...saved, initialInput: bad })).ok, false)
    } finally { rejected.dispose() }
  }
})

test('single-object clarification reaches the third node without rewriting the first submitted input', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports, calls } = createFixturePorts()
  const material = { materialId: 'material-001', fileName: 'synthetic.txt', digest: 'sha256:material-001',
    text: '估值对象：公寓甲；另有公寓乙。' }
  let attempt = 0
  const intentRequests = []
  ports.intent = { infer: async (input) => {
    intentRequests.push(structuredClone(input))
    return { ok: true, sessionId: `actual-synthetic-intent-${++attempt}`, intent: {
      business: 'valuation', assetType: 'realestate', status: 'resolved',
      objects: attempt === 1
        ? [{ objectId: 'object-a', materialIds: [material.materialId] }, { objectId: 'object-b', materialIds: [material.materialId] }]
        : [{ objectId: 'object-a', materialIds: [material.materialId] }],
      evidence: [{ materialId: material.materialId, quote: '估值对象：公寓甲' }], questions: [],
    } }
  } }
  const service = createValuationWorkflowService(ports)
  t.after(() => service.dispose())
  const first = await service.start(startInput({ materials: [material], object: { objectId: '', useLabel: '公寓', areaSqm: 86.4 } }))
  assert.equal(first.snapshot.status, 'waiting-user')
  const q = first.snapshot.clarification.questions[0]
  const answer = '本轮只估公寓甲，排除公寓乙'
  const next = await service.answer({ runId: 'run-0001', expectedRevision: 1, submissionId: 'synthetic-object-answer',
    clarificationId: first.snapshot.clarification.clarificationId, answers: { [q.field]: answer } })
  assert.equal(next.snapshot.outcome, 'partial')
  assert.deepEqual(intentRequests[0].initialInput, initialInput())
  const third = calls.inference.find((call) => call.stage === 'plan')
  assert.ok(third.facts.userInput.includes(answer))
  assert.ok(third.facts.userInput.includes(q.prompt))
  assert.deepEqual(third.facts.initialInput, initialInput())
  assert.equal(third.facts.routing.intentSessionId, 'actual-synthetic-intent-2')
  assert.equal(third.facts.assetType, 'realestate')
})
