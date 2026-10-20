import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferred, createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

const stages = ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']

test('a node prompt correction reruns that node and its dependants with a fresh actual session', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  for (const stage of stages) {
    const { ports, calls } = createFixturePorts()
    const service = createValuationWorkflowService(ports)
    const initial = await service.start(createStartInput())
    const priorSession = initial.snapshot.stages[stage].sessionId
    const offset = calls.inference.length
    const result = await service.revise({ runId: initial.snapshot.runId, nodeId: stage,
      expectedRevision: 1, submissionId: `prompt-${stage}`, reason: '核对合成输入口径', source: '合成补充说明',
      changes: [{ field: 'promptSupplement', value: '请核对建筑面积，保留公寓原始用途。' }] })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.snapshot.revision, 2)
    const subsequent = calls.inference.slice(offset)
    assert.deepEqual(subsequent.map((call) => call.stage), stages.slice(stages.indexOf(stage)))
    assert.equal(subsequent[0].facts.promptSupplement, '请核对建筑面积，保留公寓原始用途。')
    assert.notEqual(result.snapshot.stages[stage].sessionId, priorSession)
    assert.equal(initial.snapshot.stages[stage].sessionId, priorSession)
    assert.equal(result.snapshot.result.unitPrice, initial.snapshot.result.unitPrice)
    service.dispose()
  }
})

test('an unknown node cannot mutate facts or create a replacement revision', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports, calls } = createFixturePorts()
  const service = createValuationWorkflowService(ports)
  const started = await service.start(createStartInput())
  const count = calls.inference.length
  const result = await service.revise({ runId: started.snapshot.runId, nodeId: 'foreign-node',
    expectedRevision: 1, submissionId: 'wrong-node', reason: '合成更正', source: '合成资料',
    changes: [{ field: 'areaSqm', value: 150 }] })
  assert.equal(result.ok, false)
  assert.equal(result.snapshot.revision, 1)
  assert.equal(calls.inference.length, count)
  service.dispose()
})

test('cancellation cannot release a stage whose inference child has an unknown stop', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const entered = createDeferred()
  const release = createDeferred()
  const { ports } = createFixturePorts({ infer: async (input) => {
    if (input.stage !== 'rights') return undefined
    entered.resolve()
    await release.promise
    return { ok: false, errorKind: 'stop-unknown', sessionId: 'unknown-stage-child', error: '合成停止状态未知' }
  } })
  const service = createValuationWorkflowService(ports)
  const drive = service.start(createStartInput())
  await entered.promise
  await service.cancel({ runId: 'run-0001', submissionId: 'cancel-stage' })
  release.resolve()
  const stopped = await drive
  assert.equal(stopped.snapshot.errorKind, 'stop-unknown')
  const revision = await service.revise({ runId: 'run-0001', nodeId: 'rights', expectedRevision: 1,
    submissionId: 'unsafe-restart', reason: '合成更正', source: '合成资料', changes: [{ field: 'areaSqm', value: 150 }] })
  assert.equal(revision.ok, false)
  assert.equal(revision.errorKind, 'stop-unknown')
  service.dispose()
})

test('field corrections preserve before/after values and user provenance without replacing material facts', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const material = { materialId: 'synthetic-title', fileName: '合成权证.txt', digest: 'sha256:synthetic-title',
    text: '规划用途：公寓；建筑面积：100平方米。' }
  const { ports } = createFixturePorts({ infer: async (input) => input.stage === 'elements' ? {
    ok: true, outputs: { sourceFacts: [
      { field: 'useLabel', value: '公寓', source: { materialId: material.materialId, digest: material.digest, quote: '规划用途：公寓' } },
      { field: 'areaSqm', value: 100, source: { materialId: material.materialId, digest: material.digest, quote: '建筑面积：100平方米' } },
    ] },
  } : undefined })
  const service = createValuationWorkflowService(ports)
  const initial = await service.start(createStartInput({ materials: [material],
    object: { objectId: 'object-a', useLabel: '', areaSqm: null } }))
  assert.equal(initial.snapshot.object.areaSqm, 100)
  const revised = await service.revise({ runId: 'run-0001', nodeId: 'rights', expectedRevision: 1,
    submissionId: 'traceable-correction', reason: '补充资料更正', source: '合成用户确认',
    changes: [{ field: 'areaSqm', value: 150 }] })
  const history = revised.snapshot.revisions.find((item) => item.revision === 2)
  assert.ok(Array.isArray(history.changes), 'field-level correction history must survive finalization')
  assert.deepEqual(history.changes, [{ nodeId: 'rights', field: 'areaSqm', before: 100, after: 150,
    sourceKind: 'user', source: '合成用户确认', reason: '补充资料更正' }])
  assert.equal(revised.snapshot.object.useLabel, '公寓')
  assert.equal(revised.snapshot.stages.elements.outputs.adoptedFacts.find((item) => item.field === 'useLabel').source.quote, '规划用途：公寓')
  assert.equal(initial.snapshot.object.areaSqm, 100)
  service.dispose()
})
