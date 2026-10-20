import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createDeferred, tick,
} from '../../helpers/valuation-workflow-fixture.mjs'

const loadAdapter = () => import('../../../src/host/integrations/valuation-workflow/intent.ts')
const input = {
  text: '',
  materials: [{ materialId: 'm1', fileName: '权证.txt', digest: 'sha256:fixture', text: '用途：公寓；建筑面积86.4平方米。' }],
}
const intent = {
  business: 'valuation', assetType: 'realestate', status: 'resolved',
  objects: [{ objectId: 'o1', materialIds: ['m1'] }],
  evidence: [{ materialId: 'm1', quote: '用途：公寓' }], questions: [],
}
const parent = { id: 'parent', session: { history: ['PARENT-HISTORY-PRIVATE'] } }

async function adapter(runtime, options = {}) {
  const { createDshWorkflowIntent } = await loadAdapter()
  return createDshWorkflowIntent({ ctx: createInferenceContext(runtime), parentAgent: parent, ...options })
}

test('intent inference uses a fresh isolated structured child with full file text', async () => {
  let disposed = 0
  const runtime = createSubagentRuntime({
    fork: createSubagentProvider('fork', { inheritsParentContext: true }),
    spawn: createSubagentProvider('spawn'),
  }, {
    start: async (_name, _request, calls) => createSubagentRun({
      id: `actual-intent-${calls.starts.length}`, structured: intent,
      dispose: async () => { disposed += 1 },
    }),
  })
  const port = await adapter(runtime)
  for (let n = 1; n <= 2; n += 1) {
    const result = await port.infer(input, ['realestate'])
    assert.equal(result.ok, true, result.error)
    assert.equal(result.sessionId, `actual-intent-${n}`)
    assert.deepEqual(result.intent, intent)
    assert.equal('output' in result, false)
  }
  assert.equal(disposed, 2)
  for (const { name, request } of runtime.calls.starts) {
    assert.equal(name, 'spawn')
    assert.equal(request.parent, parent)
    assert.deepEqual(request.toolFilter, { allow: [] })
    assert.equal(request.outputSchema.type, 'object')
    assert.equal(request.outputSchema.additionalProperties, false)
    assert.doesNotThrow(() => assertObjectJsonSchema(request.outputSchema))
    const prompt = request.prompt.map((block) => block.text ?? '').join('\n')
    assert.ok(prompt.includes(input.materials[0].text))
    assert.match(prompt, /realestate/)
    assert.match(prompt, /JSON|结构化/)
    assert.doesNotMatch(prompt, /PARENT-HISTORY-PRIVATE/)
  }
})

test('intent adapter refuses inherited providers, forged evidence and narrative extras', async () => {
  const inherited = createSubagentRuntime({ fork: createSubagentProvider('fork', { inheritsParentContext: true }) })
  assert.equal((await (await adapter(inherited)).infer(input, ['realestate'])).ok, false)
  assert.equal(inherited.calls.starts.length, 0)
  for (const structured of [
    '这是公寓，进入房地产流程',
    { ...intent, commentary: '我将为您完成评估' },
    { ...intent, evidence: [{ materialId: 'm1', quote: '用途：住宅' }] },
  ]) {
    const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
      run: createSubagentRun({ structured }),
    })
    const result = await (await adapter(runtime)).infer(input, ['realestate'])
    assert.equal(result.ok, false)
    assert.equal(result.intent, undefined)
  }
})

test('intent failures explain missing fields and source validation without exposing rejected content', async () => {
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured: { business: 'valuation', assetType: 3, 'private-key': 'private-value' } }),
  })
  const result = await (await adapter(runtime)).infer(input, ['realestate'])
  assert.equal(result.ok, false)
  assert.match(result.error, /assetType/)
  assert.match(result.error, /status/)
  assert.match(result.error, /重新执行/)
  assert.doesNotMatch(result.error, /private-/)
})

test('intent cancellation aborts the actual child and never publishes its stale result', async () => {
  const deferred = createDeferred()
  let stopped = 0
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ result: deferred.promise, dispose: async () => { stopped += 1 } }),
  })
  const signal = new AbortController()
  const port = await adapter(runtime)
  const pending = port.infer(input, ['realestate'], signal.signal)
  await tick()
  signal.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'cancelled')
  assert.equal(result.intent, undefined)
  assert.equal(runtime.calls.starts[0].request.signal.aborted, true)
  assert.equal(stopped, 1)
  deferred.resolve({ stopReason: 'completed', structured: intent })
})
