import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

async function completed() {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const fixture = createFixturePorts()
  const service = createValuationWorkflowService(fixture.ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.outcome, 'partial')
  assert.equal(typeof service.exportRun, 'function')
  const image = await service.exportRun(result.snapshot.runId)
  return { service, image, createValuationWorkflowService }
}

test('restoration rejects changed knowledge, duplicate submission identity and inconsistent program money atomically', async () => {
  const first = await completed()
  const changes = [
    (image) => { image.knowledgeSources[0].body += '\nUnverified replacement policy' },
    (image) => { image.usedSubmissions = ['same-submission', 'same-submission'] },
    (image) => { image.calculation.totalPrice += 1 },
    (image) => { image.result.unitPrice += 1 },
    (image) => { image.acceptedRequirements[0].quote = 'This quote is not in the verified source' },
  ]
  for (const change of changes) {
    const image = structuredClone(first.image)
    change(image)
    const fixture = createFixturePorts()
    const target = first.createValuationWorkflowService(fixture.ports)
    const rejected = await target.restoreRun(image)
    assert.equal(rejected.ok, false, 'a malformed durable business state must not become an accepted run')
    assert.equal(await target.get(image.runId), null)
    assert.equal(fixture.calls.inference.length, 0)
    assert.equal((await target.restoreRun(structuredClone(first.image))).ok, true, 'invalid import must leave the run slot untouched')
    target.dispose()
  }
  first.service.dispose()
})

test('an interrupted restored run retains child identity and occupancy until Host reconciliation', async () => {
  const first = await completed()
  const image = structuredClone(first.image)
  image.active = true
  image.status = 'running'
  image.outcome = null
  image.stages.review.state = 'running'
  image.stages.review.sessionId = 'actual-unsettled-child'
  const fixture = createFixturePorts()
  const target = first.createValuationWorkflowService(fixture.ports)
  const restored = await target.restoreRun(image)
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.snapshot.stages.review.sessionId, 'actual-unsettled-child')
  assert.match(restored.snapshot.error, /未知|对账|核对/)
  const revised = await target.revise({ runId: image.runId, nodeId: 'review', expectedRevision: image.revision,
    submissionId: 'unsafe-replacement', reason: 'review again', source: 'test user',
    changes: [{ field: 'promptSupplement', value: '复核证据' }] })
  assert.equal(revised.ok, false)
  assert.equal(fixture.calls.inference.length, 0)
  first.service.dispose()
  target.dispose()
})

test('restore respects independently rounded raw-mean totals rather than multiplying the rounded unit price', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const observed = [1, 1, 2].map((unitPrice, index) => ({ sourceId: `rounding-${index}`, unitPrice, listingKind: 'listing' }))
  const fixture = createFixturePorts({ infer: async (input, _calls, fallback) => {
    const result = await fallback(input)
    if (input.stage === 'evidence') result.outputs.samples = observed
    return result
  } })
  const read = fixture.ports.knowledge.read
  fixture.ports.knowledge.read = async (input) => ({ ...await read(input), samples: observed })
  fixture.ports.calculator.compute = async () => ({ ok: true, unitPrice: 1.33, totalPrice: 133.33 })
  const service = createValuationWorkflowService(fixture.ports)
  const finished = await service.start(createStartInput({ object: { objectId: 'object-a', useLabel: '公寓', areaSqm: 100 } }))
  assert.equal(finished.snapshot.outcome, 'partial')
  assert.equal(typeof service.exportRun, 'function')
  const image = JSON.parse(JSON.stringify(await service.exportRun(finished.snapshot.runId)))
  const restored = createValuationWorkflowService(fixture.ports)
  assert.equal((await restored.restoreRun(image)).ok, true, 'the Python builder independently quantizes unrounded mean × area')
  restored.dispose()
  image.calculation.totalPrice = 133
  image.result.totalPrice = 133
  image.stages.calculation.outputs.totalPrice = 133
  const invalid = createValuationWorkflowService(fixture.ports)
  assert.equal((await invalid.restoreRun(image)).ok, false, 'premature unit-price rounding must be detected')
  invalid.dispose()
  service.dispose()
})

test('restore uses decimal half-up rounding at a binary floating-point tie', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const observed = [1, 2].map((index) => ({ sourceId: `decimal-tie-${index}`, unitPrice: 10.075, listingKind: 'listing' }))
  const fixture = createFixturePorts({ infer: async (input, _calls, fallback) => {
    const result = await fallback(input)
    if (input.stage === 'evidence') result.outputs.samples = observed
    return result
  } })
  const read = fixture.ports.knowledge.read
  fixture.ports.knowledge.read = async (input) => ({ ...await read(input), samples: observed })
  fixture.ports.calculator.compute = async () => ({ ok: true, unitPrice: 10.08, totalPrice: 1007.5 })
  const service = createValuationWorkflowService(fixture.ports)
  const finished = await service.start(createStartInput({ object: { objectId: 'object-a', useLabel: '公寓', areaSqm: 100 } }))
  assert.equal(finished.snapshot.outcome, 'partial')
  const image = JSON.parse(JSON.stringify(await service.exportRun(finished.snapshot.runId)))
  const restored = createValuationWorkflowService(fixture.ports)
  const admitted = await restored.restoreRun(image)
  assert.equal(admitted.ok, true, admitted.error)
  restored.dispose()
  service.dispose()
})
