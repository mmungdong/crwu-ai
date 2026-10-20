/**
 * Subagent start across the two supported DSH lines.
 *
 * The deployed desktop runtime (`0.2.1-rc.2`) exposes `subagents.startActivation`
 * and advertises `agentPreset` instead of `toolFilter`/`persona`; the older
 * `0.1.7` line exposes `subagents.start(name, request)` and returns a run handle
 * with `id` / `localAgent`. A plugin that speaks only one line starts no child at
 * all on the other, so both are asserted here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createActivationProvider, createActivationSubagentRuntime, createInferenceContext,
  createSubagentProvider, createSubagentRun, createSubagentRuntime, createWorkflowInferenceRequest,
} from '../../helpers/valuation-workflow-fixture.mjs'

const loadInference = () => import('../../../src/host/integrations/valuation-workflow/inference.ts')
const loadIntent = () => import('../../../src/host/integrations/valuation-workflow/intent.ts')

const parent = { id: 'parent', session: { history: ['PARENT-HISTORY-PRIVATE'] } }
const material = { materialId: 'm1', fileName: '权证.txt', digest: 'sha256:fixture', text: '规划用途：公寓' }
const intent = {
  business: 'valuation', assetType: 'realestate', status: 'resolved',
  objects: [{ objectId: 'o1', materialIds: ['m1'] }],
  evidence: [{ materialId: 'm1', quote: '规划用途' }], questions: [],
}

test('stage inference starts a 0.2.x activation child without a toolFilter capability', async () => {
  const structured = { sourceFacts: [{
    field: 'useLabel', value: '公寓', source: { materialId: 'm1', digest: material.digest, quote: '规划用途：公寓' },
  }] }
  const runtime = createActivationSubagentRuntime({
    fork: createActivationProvider('fork', { inheritsParentContext: true }),
    spawn: createActivationProvider('spawn'),
  }, { activation: { childId: 'actual-stage-1', structured } })
  const { createDshWorkflowInference } = await loadInference()
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: parent })

  const result = await adapter.infer(createWorkflowInferenceRequest({
    stage: 'elements', materials: [material],
  }))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.sessionId, runtime.calls.activations[0].childId)
  assert.ok(result.sessionId)
  assert.deepEqual(result.outputs, structured)

  assert.equal(runtime.calls.activations.length, 1)
  const spec = runtime.calls.activations[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'valuation:elements')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.parent, parent)
  assert.equal(spec.request.outputSchema.additionalProperties, false)
  assert.equal('toolFilter' in spec.request, false)
  assert.deepEqual(runtime.calls.restrictions, [{ id: result.sessionId, filter: { allow: [] } }])
  assert.equal(runtime.calls.listeners, 0)
  const prompt = spec.request.prompt.map((block) => block.text ?? '').join('\n')
  assert.ok(prompt.includes(material.text))
  assert.doesNotMatch(prompt, /PARENT-HISTORY-PRIVATE/)
})

test('intent inference publishes the activation childId and reads its structured intent', async () => {
  let disposed = 0
  const runtime = createActivationSubagentRuntime({
    spawn: createActivationProvider('spawn'),
  }, {
    activation: {
      childId: 'actual-intent-1',
      structured: intent,
      dispose: async () => { disposed += 1 },
    },
  })
  const { createDshWorkflowIntent } = await loadIntent()
  const port = createDshWorkflowIntent({ ctx: createInferenceContext(runtime), parentAgent: parent })

  const result = await port.infer(
    { text: '', materials: [material] },
    ['realestate'],
  )

  assert.equal(result.ok, true, result.error)
  assert.equal(result.sessionId, runtime.calls.activations[0].childId)
  assert.ok(result.sessionId)
  assert.deepEqual(runtime.calls.restrictions, [{ id: result.sessionId, filter: { allow: [] } }])
  assert.deepEqual(result.intent, intent)
  assert.equal(disposed, 1)
  const spec = runtime.calls.activations[0]
  assert.equal(spec.request.outputSchema.type, 'object')
  assert.equal('toolFilter' in spec.request, false)
})

test('0.2.x line: a provider without the structured contract is never chosen', async () => {
  const runtime = createActivationSubagentRuntime({
    spawn: createActivationProvider('spawn', { outputSchema: false }),
  })
  const { createDshWorkflowInference } = await loadInference()
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: parent })

  const result = await adapter.infer(createWorkflowInferenceRequest())

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(runtime.calls.activations.length, 0)
})

test('0.2.x line: an external activation is refused instead of published as a result', async () => {
  const runtime = createActivationSubagentRuntime({
    spawn: createActivationProvider('spawn', { local: false }),
  })
  const { createDshWorkflowInference } = await loadInference()
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: parent })

  const result = await adapter.infer(createWorkflowInferenceRequest())

  assert.equal(result.ok, false)
  assert.equal(result.outputs, undefined)
})

test('0.1.7 line keeps tool isolation mandatory before publishing a child', async () => {
  const structured = { sourceFacts: [{
    field: 'useLabel', value: '公寓', source: { materialId: 'm1', digest: material.digest, quote: '规划用途：公寓' },
  }] }
  const declared = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured }),
  })
  const quiet = createSubagentRuntime({
    spawn: createSubagentProvider('spawn', { toolFilter: false }),
  }, {
    run: createSubagentRun({ structured }),
  })
  const { createDshWorkflowInference } = await loadInference()
  const request = createWorkflowInferenceRequest({ stage: 'elements', materials: [material] })

  const withFilter = await createDshWorkflowInference({
    ctx: createInferenceContext(declared), parentAgent: parent,
  }).infer(request)
  const withoutFilter = await createDshWorkflowInference({
    ctx: createInferenceContext(quiet), parentAgent: parent,
  }).infer(request)

  assert.equal(withFilter.ok, true, withFilter.error)
  assert.equal(withoutFilter.ok, false)
  assert.equal(quiet.calls.starts.length, 0)
  assert.deepEqual(declared.calls.starts[0].request.toolFilter, { allow: [] })
})

test('activation without a prepublication restriction hook cannot start a business child', async () => {
  const runtime = createActivationSubagentRuntime({ spawn: createActivationProvider('spawn') })
  const { createDshWorkflowInference } = await loadInference()
  const result = await createDshWorkflowInference({ ctx: { get: () => runtime }, parentAgent: parent }).infer(createWorkflowInferenceRequest())
  assert.equal(result.ok, false)
  assert.equal(runtime.calls.activations.length, 0)
})

test('an unverifiable activation receipt keeps its actual identity when disposal cannot settle', async () => {
  const runtime = createActivationSubagentRuntime({ spawn: createActivationProvider('spawn') }, {
    startActivation: async () => ({ childId: 'actual-unverifiable-child',
      result: Promise.resolve({ structured: {}, stopReason: 'completed' }), dispose: () => new Promise(() => {}) }),
  })
  const { createDshWorkflowInference } = await loadInference()
  const result = await Promise.race([
    createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: parent, stopTimeoutMs: 5 })
      .infer(createWorkflowInferenceRequest()),
    new Promise((resolve) => setTimeout(() => resolve({ errorKind: 'unbounded-disposal' }), 500)),
  ])
  assert.equal(result.errorKind, 'stop-unknown')
  assert.equal(result.sessionId, 'actual-unverifiable-child')
})
