import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDeferred, createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createWorkflowInferenceRequest, tick,
} from '../../helpers/valuation-workflow-fixture.mjs'

async function fixture(kind, onStarted, dispose = async () => {}) {
  const input = { text: '估值这套公寓', materials: [] }
  const structured = kind === 'intent' ? {
    business: 'valuation', assetType: 'realestate', status: 'resolved',
    objects: [{ objectId: 'o1', materialIds: [] }],
    evidence: [{ source: 'user-input', quote: '这套公寓' }], questions: [],
  } : { useLabel: '公寓', areaSqm: 100 }
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ id: 'actual-published-child', structured, dispose }),
  })
  const options = { ctx: createInferenceContext(runtime), parentAgent: { id: 'actual-parent' }, onStarted, stopTimeoutMs: 5 }
  if (kind === 'intent') {
    const { createDshWorkflowIntent } = await import('../../../src/host/integrations/valuation-workflow/intent.ts')
    const port = createDshWorkflowIntent(options)
    return () => port.infer(input, ['realestate'])
  }
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const port = createDshWorkflowInference(options)
  return () => port.infer(createWorkflowInferenceRequest())
}

for (const kind of ['intent', 'stage']) {
  test(`${kind}: the actual child ID is journaled before its result can be accepted`, async () => {
    const saved = createDeferred()
    const events = []
    const infer = await fixture(kind, async (event) => { events.push(event); await saved.promise })
    let settled = false
    const pending = infer().then((result) => { settled = true; return result })
    try {
      await tick()
      assert.equal(events.length, 1)
      assert.equal(events[0].sessionId, 'actual-published-child')
      assert.equal(settled, false, 'a child result cannot outrun its durable session association')
    } finally {
      saved.resolve()
      await pending
    }
  })

  test(`${kind}: failed session journaling stops the published child and hides raw errors`, async () => {
    let stops = 0
    const infer = await fixture(kind, async () => { throw new Error('Bearer synthetic-private-token') }, async () => { stops += 1 })
    const result = await infer()
    assert.equal(result.ok, false)
    assert.equal(result.sessionId, 'actual-published-child')
    assert.equal(stops, 1)
    assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-private-token/)
  })

  test(`${kind}: a failed journal and unknown disposal preserve the real child for reconciliation`, async () => {
    let writes = 0
    const infer = await fixture(kind, async () => { writes += 1; throw new Error('synthetic-journal-failure') }, async () => new Promise(() => {}))
    const result = await infer()
    assert.equal(writes, 1)
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'stop-unknown')
    assert.equal(result.sessionId, 'actual-published-child')
  })
}
