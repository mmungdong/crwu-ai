import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFixturePorts, createStartInput, loadWorkflowService, syntheticReferencePolicy,
} from '../../helpers/valuation-workflow-fixture.mjs'

const material = {
  materialId: 'material-001', fileName: '资产表.xlsx', digest: 'sha256:material-001',
  text: '估值对象：公寓甲；用途：公寓；建筑面积86.4平方米；评估目的：转让；基准日：2026-08-31。',
}
const intent = {
  business: 'valuation', assetType: 'realestate', status: 'resolved',
  objects: [{ objectId: 'object-a', materialIds: [material.materialId] }],
  evidence: [{ materialId: material.materialId, quote: '估值对象：公寓甲' }], questions: [],
}
const startInput = (patch = {}) => createStartInput({ userInput: '', materials: [{ ...material }], ...patch })

test('the service routes by actual intent before reading professional knowledge or running stages', async () => {
  const { ports, calls } = createFixturePorts()
  let seen
  ports.intent = { infer: async (input, ids) => {
    assert.equal(calls.knowledge.length, 0)
    assert.equal(calls.inference.length, 0)
    seen = { input, ids }
    return { ok: true, sessionId: 'actual-intent-1', intent }
  } }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(startInput())
  assert.ok(seen)
  assert.equal(seen.input.materials[0].text, material.text)
  assert.deepEqual(seen.ids, ['realestate'])
  assert.equal(result.snapshot.routing.route, 'realestate')
  assert.equal(result.snapshot.routing.intentSessionId, 'actual-intent-1')
  assert.equal(result.snapshot.outcome, 'partial')
  assert.equal(calls.inference[0].materials[0].text, material.text)
  await service.revise({
    runId: 'run-0001', nodeId: 'rights', expectedRevision: 1,
    submissionId: 'revise-1', reason: '面积更正', source: '补充测绘',
    changes: [{ field: 'areaSqm', value: 90 }],
  })
  assert.equal(calls.inference.filter((call) => call.stage === 'rights').length, 2)
  assert.equal((await service.get('run-0001')).routing.intentSessionId, 'actual-intent-1')
  service.dispose()
})

test('material-bound element candidates fill missing facts before asking the user again', async () => {
  const values = [
    ['purpose', '转让', '评估目的：转让'],
    ['baseDate', '2026-08-31', '基准日：2026-08-31'],
    ['useLabel', '公寓', '用途：公寓'],
    ['areaSqm', 86.4, '建筑面积86.4平方米'],
  ]
  const { ports } = createFixturePorts({ infer: async (request) => request.stage === 'elements' ? {
    ok: true, outputs: { sourceFacts: values.map(([field, value, quote]) => ({
      field, value, source: { materialId: material.materialId, digest: material.digest, quote },
    })) },
  } : undefined })
  ports.intent = { infer: async () => ({ ok: true, sessionId: 'intent-elements', intent }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(startInput({
    object: { objectId: 'object-a', useLabel: '', areaSqm: null }, purpose: null, baseDate: null,
  }))
  assert.equal(result.snapshot.clarification, null)
  assert.equal(result.snapshot.object.useLabel, '公寓')
  assert.equal(result.snapshot.object.areaSqm, 86.4)
  assert.equal(result.snapshot.outcome, 'partial')
  service.dispose()
})

test('unsupported enterprise intent cannot enter the realestate service through a property attachment', async () => {
  const { ports, calls } = createFixturePorts()
  ports.intent = { infer: async () => ({ ok: true, sessionId: 'enterprise-intent', intent: { ...intent, assetType: 'enterprise' } }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(startInput({ userInput: '企业整体转让估值，附一处房产材料' }))
  assert.equal(result.snapshot.status, 'blocked')
  assert.equal(calls.knowledge.length, 0)
  assert.equal(calls.inference.length, 0)
  assert.equal(calls.calculator.length, 0)
  assert.equal(result.snapshot.result, null)
  service.dispose()
})

test('unbound element values cannot become accepted facts or reach calculation', async () => {
  const { ports, calls } = createFixturePorts({ infer: async (request) => request.stage === 'elements' ? {
    ok: true, outputs: { sourceFacts: [{
      field: 'areaSqm', value: 1000,
      source: { materialId: material.materialId, digest: material.digest, quote: '建筑面积86.4平方米' },
    }] },
  } : undefined })
  ports.intent = { infer: async () => ({ ok: true, sessionId: 'intent-invalid-fact', intent }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(startInput({ object: { objectId: 'object-a', useLabel: '公寓', areaSqm: null } }))
  assert.equal(result.snapshot.object.areaSqm, null)
  assert.ok(['waiting-user', 'blocked'].includes(result.snapshot.status))
  assert.equal(calls.calculator.length, 0)
  service.dispose()
})

test('intent clarification can resume the same run and performs fresh intent inference', async () => {
  const { ports, calls } = createFixturePorts()
  let count = 0
  ports.intent = { infer: async () => ({ ok: true, sessionId: `intent-${++count}`, intent: count === 1 ? {
    business: 'unknown', assetType: null, status: 'needs-clarification',
    objects: [], evidence: [], questions: ['请确认本次估值对象'],
  } : intent }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const first = await service.start(startInput())
  assert.equal(first.snapshot.status, 'waiting-user')
  assert.equal(calls.inference.length, 0)
  assert.ok(first.snapshot.clarification)
  const question = first.snapshot.clarification.questions[0]
  const next = await service.answer({
    runId: 'run-0001', expectedRevision: 1, submissionId: 'answer-intent',
    clarificationId: first.snapshot.clarification.clarificationId,
    answers: { [question.field]: '本次仅估值公寓甲' },
  })
  assert.equal(count, 2)
  assert.equal(next.snapshot.outcome, 'partial')
  assert.equal(next.snapshot.routing.intentSessionId, 'intent-2')
  service.dispose()
})

test('two material objects pause for a single-object choice and resume with a fresh native intent', async () => {
  const { ports, calls } = createFixturePorts()
  let count = 0
  ports.intent = { infer: async (input) => {
    count += 1
    if (count > 1) assert.match(input.text, /仅估公寓甲/)
    return { ok: true, sessionId: `actual-intent-${count}`, intent: count === 1 ? { ...intent,
      objects: [...intent.objects, { objectId: '公寓乙', materialIds: [material.materialId] }],
    } : intent }
  } }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const first = await service.start(startInput({ object: { objectId: '', useLabel: '公寓', areaSqm: 86.4 } }))
  assert.equal(first.snapshot.status, 'waiting-user')
  assert.equal(calls.knowledge.length, 0)
  assert.equal(calls.inference.length, 0)
  assert.equal(first.snapshot.routing.intentSessionId, 'actual-intent-1')
  assert.equal(first.snapshot.routing.intent.objects.length, 2)
  assert.equal(first.snapshot.routing.route, '')
  const q = first.snapshot.clarification.questions[0]
  assert.match(q.prompt, /object-a/)
  assert.match(q.prompt, /公寓乙/)
  const next = await service.answer({ runId: 'run-0001', expectedRevision: 1, submissionId: 'single-choice',
    clarificationId: first.snapshot.clarification.clarificationId, answers: { [q.field]: '本轮仅估公寓甲' } })
  assert.equal(next.snapshot.outcome, 'partial')
  assert.equal(next.snapshot.routing.intentSessionId, 'actual-intent-2')
  assert.equal(next.snapshot.object.objectId, 'object-a')
  service.dispose()
})

test('knowledge selection receives admitted materials and user input before common element rules are read', async () => {
  let seen
  const { ports } = createFixturePorts({ readKnowledge: async (request) => {
    seen ??= structuredClone(request)
    if (request.materials?.[0]) request.materials[0].text = 'PORT_MUTATION'
    return { ok: true, sources: [syntheticReferencePolicy()] }
  } })
  ports.intent = { infer: async () => ({ ok: true, sessionId: 'intent-context', intent }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const userInput = '方法自动判断；只估合成公寓甲，不估乙'
  await service.start(startInput({ userInput, purpose: null, baseDate: null, mode: null }))
  assert.equal(seen.userInput, userInput)
  assert.deepEqual(seen.materials, [material])
  assert.equal(seen.assetType, 'realestate')
  assert.equal(seen.baseDate, '')
  assert.equal(seen.purpose, '')
  assert.equal(seen.mode, '', 'valuation basis has not been confirmed; do not substitute a method')
  assert.equal((await service.exportRun('run-0001')).materials[0].text, material.text)
  service.dispose()
})
