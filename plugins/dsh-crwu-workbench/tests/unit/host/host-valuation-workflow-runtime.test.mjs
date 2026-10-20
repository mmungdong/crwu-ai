/**
 * Runtime boundary for the planned valuation workflow inference adapter (tests-only).
 *
 * The graph may only start a child on a provider that is verifiably isolated
 * (`inheritsParentContext === false`) and supports both a scoped Tool allow-list and
 * a structured output schema. Anything unverifiable must fail closed with an explicit
 * capability gap **before** a child is started. A successful attempt records the
 * actual started child id, publishes only the structured stage result, sends an
 * isolated prompt and a real empty allow-list, and disposes the handle. Cancellation
 * forwards the abort, waits for quiescence and never publishes a stale result.
 *
 * Uses in-memory DSH `ctx.subagents` fixtures; no real child session is created.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeferred,
  createInferenceContext,
  createSubagentProvider,
  createSubagentRun,
  createSubagentRuntime,
  createWorkflowInferenceRequest,
  loadWorkflowInference,
  tick,
} from '../../helpers/valuation-workflow-fixture.mjs'

const PARENT_MARKER = 'PARENT-ONLY-HISTORY'

function parentAgent() {
  return { id: 'parent-1', session: { header: { cwd: '/case' }, history: [PARENT_MARKER] } }
}

async function newAdapter(runtime, parent = parentAgent()) {
  const { createDshWorkflowInference } = await loadWorkflowInference()
  return createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: parent })
}

test('an isolated provider supporting toolFilter and outputSchema is started and its result published', async () => {
  let disposed = 0
  const runtime = createSubagentRuntime({
    fork: createSubagentProvider('fork', { inheritsParentContext: true }),
    spawn: createSubagentProvider('spawn'),
  }, {
    run: createSubagentRun({
      id: 'child-session-42',
      structured: { useLabel: '公寓', areaSqm: 86.4 },
      dispose: async () => { disposed += 1 },
    }),
  })
  const parent = parentAgent()
  const adapter = await newAdapter(runtime, parent)
  const result = await adapter.infer(createWorkflowInferenceRequest())

  // The ineligible `fork` provider was skipped; `spawn` was actually started once.
  assert.equal(result.ok, true, result.error)
  assert.equal(result.sessionId, 'child-session-42', 'the receipt must use the actual started id')
  assert.deepEqual(result.outputs, { useLabel: '公寓', areaSqm: 86.4 }, 'only the structured result is published')
  assert.equal(runtime.calls.starts.length, 1)
  const { name, request } = runtime.calls.starts[0]
  assert.equal(name, 'spawn')
  assert.equal(request.parent, parent, 'the caller-provided parent agent is used verbatim')
  assert.equal(request.signal instanceof AbortSignal, true, 'a real cancellation signal is passed to the provider')
  assert.deepEqual(request.toolFilter, { allow: [] }, 'the child gets a real empty Tool allow-list')
  assert.equal(request.outputSchema?.type, 'object', 'a structured output schema is requested')
  assert.equal(Array.isArray(request.prompt), true)
  const prompt = request.prompt.map((block) => block.text ?? '').join('\n')
  assert.match(prompt, /rights/, 'the prompt names the business node being run')
  assert.match(prompt, /公寓/, 'the prompt carries the task facts')
  assert.match(prompt, /可比案例数量不得少于 3 个。/, 'the prompt carries the adopted knowledge quote')
  assert.doesNotMatch(prompt, new RegExp(PARENT_MARKER), 'the parent history must not leak into the prompt')
  assert.equal(disposed, 1, 'the handle must be disposed after the result settles')
})

test('an inherited provider is refused with a capability gap and no child is started', async () => {
  const runtime = createSubagentRuntime({
    fork: createSubagentProvider('fork', { inheritsParentContext: true }),
  })
  const adapter = await newAdapter(runtime)
  const result = await adapter.infer(createWorkflowInferenceRequest())

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(result.sessionId, '')
  assert.equal(result.gaps.length > 0, true, 'the gap must say why nothing was started')
  assert.equal(runtime.calls.starts.length, 0, 'no child may be created before eligibility is verified')
})

test('a provider without toolFilter support is refused before start', async () => {
  const runtime = createSubagentRuntime({
    spawn: createSubagentProvider('spawn', { toolFilter: false }),
  })
  const result = await (await newAdapter(runtime)).infer(createWorkflowInferenceRequest())

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(runtime.calls.starts.length, 0)
})

test('a provider without outputSchema support is refused before start', async () => {
  const runtime = createSubagentRuntime({
    spawn: createSubagentProvider('spawn', { outputSchema: false }),
  })
  const result = await (await newAdapter(runtime)).infer(createWorkflowInferenceRequest())

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(runtime.calls.starts.length, 0)
})

test('an unverifiable provider registry is refused instead of guessed', async () => {
  const withoutLookup = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, { withoutGetProvider: true })
  const noLookup = await (await newAdapter(withoutLookup)).infer(createWorkflowInferenceRequest())
  assert.equal(noLookup.ok, false)
  assert.equal(noLookup.errorKind, 'capability-gap')

  const missingService = await loadWorkflowInference()
  const adapter = missingService.createDshWorkflowInference({
    ctx: createInferenceContext(undefined),
    parentAgent: parentAgent(),
  })
  const noService = await adapter.infer(createWorkflowInferenceRequest())
  assert.equal(noService.ok, false)
  assert.equal(noService.errorKind, 'capability-gap')
  assert.equal(noService.sessionId, '')
})

test('cancellation forwards the abort, awaits quiescence and publishes no stale result', async () => {
  const disposeGate = createDeferred()
  let disposed = false
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({
      id: 'child-cancel-1',
      // The child never settles: only cancellation can end this attempt.
      result: new Promise(() => {}),
      dispose: async () => { await disposeGate.promise; disposed = true },
    }),
  })
  const adapter = await newAdapter(runtime)
  const controller = new AbortController()
  let settled = false
  const pending = adapter.infer(createWorkflowInferenceRequest({ signal: controller.signal }))
    .then((value) => { settled = true; return value })
  await tick()

  controller.abort()
  await tick()
  assert.equal(runtime.calls.starts[0].request.signal.aborted, true, 'the abort must reach the child signal')
  assert.equal(settled, false, 'the attempt must wait for quiescence before resolving')

  disposeGate.resolve()
  const result = await pending
  assert.equal(disposed, true)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'cancelled')
  assert.equal(result.sessionId, 'child-cancel-1')
  assert.equal('outputs' in result, false, 'a cancelled attempt must not publish stale outputs')
})

test('a requested workspace is attached and read back, or the attempt fails closed before start', async () => {
  const { createDshWorkflowInference } = await loadWorkflowInference()
  const request = createWorkflowInferenceRequest()

  const noAttach = createSubagentRuntime({ spawn: createSubagentProvider('spawn') })
  const refused = await createDshWorkflowInference({
    ctx: createInferenceContext(noAttach), parentAgent: parentAgent(), workspace: { id: 'ws-1' },
  }).infer(request)
  assert.equal(refused.ok, false)
  assert.equal(refused.errorKind, 'capability-gap')
  assert.equal(noAttach.calls.starts.length, 0, 'no child may be created before workspace attachment is verifiable')

  const attached = createSubagentRuntime({ spawn: createSubagentProvider('spawn') })
  const attachedChildren = []
  const adapter = createDshWorkflowInference({
    ctx: createInferenceContext(attached),
    parentAgent: parentAgent(),
    workspace: { id: 'ws-1' },
    attachWorkspace: async (input) => { attachedChildren.push(input.childId); return { ok: true } },
  })
  const result = await adapter.infer(request)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(attachedChildren, ['child-session-1'])
  assert.equal(attached.calls.starts.length, 1)
})
