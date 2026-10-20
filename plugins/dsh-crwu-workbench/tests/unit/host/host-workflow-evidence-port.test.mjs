import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixturePorts, createStartInput, loadWorkflowService, LISTING_SAMPLES } from '../../helpers/valuation-workflow-fixture.mjs'

test('real observed cases are acquired before DS selection and reach the controlled calculator', async () => {
  const { ports, calls } = createFixturePorts({ readKnowledge: undefined })
  const read = ports.knowledge.read
  ports.knowledge.read = async (input) => { const result = await read(input); delete result.samples; return result }
  const acquired = []
  ports.evidence = { acquire: async (input) => {
    acquired.push(input)
    return { ok: true, samples: LISTING_SAMPLES, retrievalAttempts: [{ provider: 'fixture', outcome: 'success' }] }
  } }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.outcome, 'partial', result.snapshot.error)
  assert.equal(acquired.length, 1)
  assert.equal(acquired[0].object.useLabel, '公寓')
  assert.equal(acquired[0].purpose, '转让')
  assert.deepEqual(calls.inference.find((x) => x.stage === 'evidence').facts.observedSamples, LISTING_SAMPLES)
  assert.deepEqual(calls.calculator[0].samples, LISTING_SAMPLES.map(({ sourceId, unitPrice }) => ({ sourceId, unitPrice })))
  assert.deepEqual(calls.calculator[0].observations, LISTING_SAMPLES,
    'native calculation needs the actual acquired evidence pool, including post-approval details')
  assert.equal(calls.calculator[0].subject.useLabel, '公寓')
  assert.equal(calls.calculator[0].subject.baseDate, '2026-08-31')
  service.dispose()
})

test('a provider failure remains visible and prevents any fabricated calculation', async () => {
  const { ports, calls } = createFixturePorts()
  ports.evidence = { acquire: async () => ({ ok: false, error: '测试来源被验证页挡住', gaps: ['来源甲需要验证，来源乙尚未检查'] }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.status, 'blocked')
  assert.equal(calls.calculator.length, 0)
  assert.ok(result.snapshot.stages.evidence.gaps.some((s) => s.includes('来源乙尚未检查')))
  service.dispose()
})

test('repeated selected source ids never count as independent samples', async () => {
  const { ports, calls } = createFixturePorts({ infer: async (input, _calls, fallback) => {
    const result = await fallback(input)
    if (input.stage === 'evidence') result.outputs.samples = [LISTING_SAMPLES[0], LISTING_SAMPLES[0]]
    return result
  } })
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.status, 'blocked')
  assert.equal(calls.calculator.length, 0)
  service.dispose()
})
