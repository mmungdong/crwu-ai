import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createWorkflowInferenceRequest,
} from '../../helpers/valuation-workflow-fixture.mjs'

const input = { text: '估值这套公寓', materials: [] }
const intent = {
  business: 'valuation', assetType: 'realestate', status: 'resolved',
  objects: [{ objectId: 'o1', materialIds: [] }],
  evidence: [{ source: 'user-input', quote: '这套公寓' }], questions: [],
}

async function make(kind, options, run) {
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, { run })
  const shared = { ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' }, ...options }
  if (kind === 'intent') {
    const { createDshWorkflowIntent } = await import('../../../src/host/integrations/valuation-workflow/intent.ts')
    const port = createDshWorkflowIntent(shared)
    return () => port.infer(input, ['realestate'])
  }
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const port = createDshWorkflowInference(shared)
  return () => port.infer(createWorkflowInferenceRequest())
}

for (const kind of ['intent', 'stage']) {
  test(`${kind}: a thrown workspace attachment is sanitized and disposes the actual child`, async () => {
    let disposed = 0
    const infer = await make(kind, {
      workspace: { id: 'w1' },
      attachWorkspace: async () => { throw new Error('synthetic-private-token') },
    }, createSubagentRun({ structured: kind === 'intent' ? intent : { useLabel: '公寓' }, dispose: async () => { disposed += 1 } }))
    const result = await infer()
    assert.equal(result.ok, false)
    assert.equal(disposed, 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token/)
  })

  test(`${kind}: cleanup timeout reports unknown stop instead of waiting forever`, async () => {
    const infer = await make(kind, { stopTimeoutMs: 5 }, createSubagentRun({
      id: 'actual-hung-child', structured: kind === 'intent' ? intent : { useLabel: '公寓' },
      dispose: async () => new Promise(() => {}),
    }))
    let timer
    try {
      const result = await Promise.race([
        infer(), new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 100) }),
      ])
      assert.equal(result.timeout, undefined)
      assert.equal(result.ok, false)
      assert.equal(result.errorKind, 'stop-unknown')
      assert.equal(result.sessionId, 'actual-hung-child')
    } finally {
      clearTimeout(timer)
    }
  })
}
