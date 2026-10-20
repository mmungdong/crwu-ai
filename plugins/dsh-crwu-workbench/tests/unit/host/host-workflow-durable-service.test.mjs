import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySaver } from '@langchain/langgraph'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

const plan = () => ({
  method: 'market', valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean',
  sources: [{ providerId: 'fixture', state: 'verified', community: '合成小区', detailUrl: 'https://example.invalid/1',
    fields: { unitPrice: 32000, areaSqm: 100 }, transactionType: 'listing', evidence: '合成测试' }],
  template: { fileName: '测试.xlsx', relativePath: '模板/测试.xlsx', digest: 'sha256:test', verified: true,
    mapping: [{ field: 'unitPrice', sheet: '计算', range: 'B2' }], formulaChecks: [{ name: '合成检查', ok: true }] },
  basis: [{ sourceId: 'synthetic-reference-policy', quote: '合成参考口径：原始挂牌单价算术平均，不修正、不折扣。' }], limitations: ['合成测试'],
})
async function fixture(options) {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts()
  f.ports.planning = { prepare: async () => ({ ok: true, plan: plan() }) }
  return { ...f, service: createValuationWorkflowService(f.ports, options) }
}

test('restored business state approves the exact saved plan without rerunning completed nodes', async () => {
  const first = await fixture()
  const started = await first.service.start(createStartInput())
  assert.equal(typeof first.service.exportRun, 'function')
  const durable = await first.service.exportRun(started.snapshot.runId)
  const serialized = JSON.stringify(durable)
  assert.doesNotMatch(serialized, /AbortController|ToolRunContext/)
  first.service.dispose()
  const restored = await fixture()
  const receipt = await restored.service.restoreRun(JSON.parse(serialized))
  assert.equal(receipt.ok, true, receipt.error)
  assert.equal(receipt.snapshot.plan.digest, started.snapshot.plan.digest)
  assert.equal(restored.calls.inference.length, 0)
  const approved = await restored.service.approvePlan({ runId: started.snapshot.runId, expectedRevision: 1,
    planDigest: started.snapshot.plan.digest, submissionId: 'approve-restored' })
  assert.equal(approved.ok, true, approved.error)
  assert.equal(approved.snapshot.outcome, 'partial')
  assert.ok(restored.calls.inference.every((call) => !['elements', 'rights', 'plan'].includes(call.stage)))
  assert.equal(restored.calls.calculator.length, 1)
  const after = JSON.parse(JSON.stringify(await restored.service.exportRun(started.snapshot.runId)))
  restored.service.dispose()
  const final = await fixture()
  assert.equal((await final.service.restoreRun(after)).ok, true)
  const duplicate = await final.service.approvePlan({ runId: started.snapshot.runId, expectedRevision: 1,
    planDigest: started.snapshot.plan.digest, submissionId: 'approve-restored' })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.errorKind, 'duplicate')
  assert.equal(final.calls.calculator.length, 0)
  final.service.dispose()
})

test('durable writes are awaited before inference and include the accepted node receipt', async () => {
  const saved = []
  const f = await fixture({ persistence: { save: async (state) => { saved.push(JSON.parse(JSON.stringify(state))) } } })
  const infer = f.ports.inference.infer
  f.ports.inference.infer = async (input) => {
    assert.ok(saved.length > 0, 'persist the run before any child starts')
    if (input.stage === 'rights') {
      assert.ok(JSON.stringify(saved.at(-1)).includes('inference-session-1'), 'save actual accepted prior session before the next node')
    }
    return infer(input)
  }
  const started = await f.service.start(createStartInput())
  assert.equal(started.snapshot.status, 'waiting-user')
  assert.deepEqual(saved.at(-1), await f.service.exportRun(started.snapshot.runId))
  f.service.dispose()
})

test('a failed durable write stops the graph before business inference', async () => {
  const f = await fixture({ persistence: { save: async () => { throw new Error('Bearer synthetic-private-token') } } })
  const result = await f.service.start(createStartInput())
  assert.equal(result.ok, false)
  assert.equal(f.calls.inference.length, 0)
  assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-private-token/)
  f.service.dispose()
})

test('malformed or duplicate restore cannot overwrite an existing run', async () => {
  const f = await fixture()
  const started = await f.service.start(createStartInput())
  assert.equal(typeof f.service.restoreRun, 'function')
  const durable = await f.service.exportRun(started.snapshot.runId)
  assert.equal((await f.service.restoreRun(durable)).ok, false)
  for (const invalid of [{}, { format: 'unsupported' }, JSON.parse('{"__proto__":{"bad":true}}')]) {
    const rejected = await f.service.restoreRun(invalid)
    assert.equal(rejected.ok, false)
    assert.equal((await f.service.get(started.snapshot.runId)).plan.digest, started.snapshot.plan.digest)
  }
  f.service.dispose()
})

test('the business root uses the supplied real saver including its nested asset graph', async () => {
  const checkpointer = new MemorySaver()
  const f = await fixture({ checkpointer })
  f.ports.intent = { infer: async () => ({ ok: true, sessionId: 'actual-intent-child', intent: {
    business: 'valuation', assetType: 'realestate', status: 'resolved',
    objects: [{ objectId: 'object-a', materialIds: [] }],
    evidence: [{ source: 'user-input', quote: '测试房地产估值' }], questions: [],
  } }) }
  f.service.dispose()
  const { createValuationWorkflowService } = await loadWorkflowService()
  f.service = createValuationWorkflowService(f.ports, { checkpointer })
  const result = await f.service.start(createStartInput({ userInput: '测试房地产估值' }))
  assert.equal(result.snapshot.status, 'waiting-user')
  const tuples = []
  for await (const tuple of checkpointer.list({ configurable: { thread_id: 'run-0001' } })) tuples.push(tuple)
  assert.ok(tuples.length > 0, 'actual business invocation must write graph checkpoints')
  assert.ok(tuples.some((tuple) => String(tuple.config.configurable.checkpoint_ns).includes('realestate')))
  f.service.dispose()
})

test('a downstream correction retains the approved plan identity across export and restore', async () => {
  const first = await fixture()
  const started = await first.service.start(createStartInput())
  await first.service.approvePlan({ runId: started.snapshot.runId, expectedRevision: 1,
    planDigest: started.snapshot.plan.digest, submissionId: 'approve-original' })
  const revised = await first.service.revise({ runId: started.snapshot.runId, nodeId: 'review',
    expectedRevision: 1, submissionId: 'review-only', reason: '补充复核说明', source: '合成用户确认',
    changes: [{ field: 'promptSupplement', value: '复核原始挂牌性质及限制' }] })
  assert.equal(revised.ok, true, revised.error)
  assert.equal(revised.snapshot.plan.digest, started.snapshot.plan.digest)
  assert.equal(first.calls.calculator.length, 1, 'review correction must retain upstream program values')
  assert.equal(typeof first.service.exportRun, 'function')
  const image = JSON.parse(JSON.stringify(await first.service.exportRun(started.snapshot.runId)))
  first.service.dispose()
  const second = await fixture()
  const restored = await second.service.restoreRun(image)
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.snapshot.plan.digest, started.snapshot.plan.digest)
  assert.equal(restored.snapshot.revision, 2)
  assert.equal(second.calls.inference.length, 0)
  second.service.dispose()
})
