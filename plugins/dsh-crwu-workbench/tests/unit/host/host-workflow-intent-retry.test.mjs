import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

test('an explicit intent retry reuses frozen material text and starts only a fresh router attempt', async () => {
  const { ports, calls } = createFixturePorts()
  const seen = []
  ports.intent = { infer: async (input) => {
    seen.push(input)
    return seen.length === 1
      ? { ok: false, errorKind: 'blocked', error: '合成对象范围未确认', sessionId: 'old-native-intent' }
      : { ok: true, sessionId: 'new-native-intent', intent: {
        business: 'valuation', assetType: 'realestate', status: 'needs-clarification', objects: [], evidence: [],
        questions: ['请确认合成对象甲或乙'],
      } }
  } }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const first = await service.start(createStartInput({ materials: [{ materialId: 'm1', fileName: '合成.pdf', digest: 'sha256:fixture', text: '已判读合成原文' }] }))
  assert.equal(first.snapshot.status, 'blocked')
  assert.equal(typeof service.retryIntent, 'function')
  const stale = await service.retryIntent({ runId: 'run-0001', expectedRevision: 9, submissionId: 'stale' })
  assert.equal(stale.ok, false)
  assert.equal(seen.length, 1)
  assert.equal((await service.retryIntent({ runId: 'run-0001', expectedRevision: 1, submissionId: '' })).ok, false)
  assert.equal(seen.length, 1, 'invalid submission identity must not start another native child')
  const next = await service.retryIntent({ runId: 'run-0001', expectedRevision: 1, submissionId: 'retry-1' })
  assert.equal(next.snapshot.status, 'waiting-user')
  assert.equal(next.snapshot.routing.intentSessionId, 'new-native-intent')
  assert.deepEqual(seen[0], seen[1])
  assert.equal(calls.knowledge.length, 0)
  assert.equal(calls.inference.length, 0)
  assert.equal(calls.calculator.length, 0)
  assert.equal((await service.retryIntent({ runId: 'run-0001', expectedRevision: 1, submissionId: 'retry-1' })).ok, false)
  assert.equal(seen.length, 2)
  service.dispose()
})

test('intent retry never replays a run that reached professional stages', async () => {
  const { ports } = createFixturePorts()
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  await service.start(createStartInput())
  assert.equal(typeof service.retryIntent, 'function')
  assert.equal((await service.retryIntent({ runId: 'run-0001', expectedRevision: 1, submissionId: 'late' })).ok, false)
  service.dispose()
})
