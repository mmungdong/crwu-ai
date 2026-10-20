import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  createFixturePorts, createStartInput, loadWorkflowService, syntheticReferencePolicy,
  createSubagentRuntime, createSubagentRun, createSubagentProvider, createInferenceContext,
  createWorkflowInferenceRequest, LISTING_SAMPLES, digestOf,
} from '../../helpers/valuation-workflow-fixture.mjs'

test('stage-aware knowledge is refreshed after the user confirms the reference mode', async () => {
  const policy = syntheticReferencePolicy()
  const body = '合成方法选择说明（测试），尚未选择参考口径。'
  const initial = { ...policy, sourceId: 'initial-route', path: '合成入口.adoc', body, digest: digestOf(body) }
  const { ports, calls } = createFixturePorts({ readKnowledge: async (input) => ({
    ok: true, sources: input.mode === '' ? [initial] : [policy], samples: LISTING_SAMPLES,
  }) })
  ports.knowledge.stageAware = true
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const first = await service.start(createStartInput({ mode: null }))
  assert.equal(first.snapshot.status, 'waiting-user')
  const second = await service.answer({
    runId: 'run-0001', expectedRevision: 1, submissionId: 'accept-reference',
    clarificationId: first.snapshot.clarification.clarificationId, answers: { mode: 'listing-reference' },
  })
  assert.equal(second.snapshot.outcome, 'partial')
  assert.ok(calls.knowledge.some((call) => call.stage === 'rights' && call.mode === 'listing-reference'))
  const rights = calls.inference.find((call) => call.stage === 'rights')
  assert.deepEqual(rights.knowledge.map((ref) => ref.sourceId), [policy.sourceId])
  assert.ok(calls.knowledge.some((call) => call.stage === 'review'))
  service.dispose()
})

test('later knowledge reads do not erase an already observed case pool', async () => {
  const policy = syntheticReferencePolicy()
  const { ports, calls } = createFixturePorts({ readKnowledge: async (input) => ({
    ok: true, sources: [policy], ...(input.stage === 'elements' ? { samples: LISTING_SAMPLES } : {}),
  }) })
  ports.knowledge.stageAware = true
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.outcome, 'partial')
  assert.equal(calls.knowledge.length, 7)
  assert.equal(calls.calculator[0].samples.length, LISTING_SAMPLES.length)
  service.dispose()
})

test('DS knowledge selection uses an isolated structured operation, not a free tool loop', async () => {
  const output = {
    entryDigest: 'sha256:entry', questions: [],
    selections: [{ path: '01 估值与测算/通用.adoc', role: 'common', quote: '[通用](通用.adoc)' }],
  }
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ id: 'actual-selection', structured: output }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const result = await adapter.infer(createWorkflowInferenceRequest({
    stage: 'elements', operation: 'knowledge-selection', nodeId: 'knowledge-routing',
    facts: { entryDigest: 'sha256:entry', allowedLinks: [{ path: output.selections[0].path }],
      methodRequest: 'market', mode: '', baseDate: '', purpose: '', applicableRoles: ['common'] },
  }))
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.outputs, output)
  assert.equal(result.sessionId, 'actual-selection')
  const request = runtime.calls.starts[0].request
  const promptText = JSON.stringify(request.prompt)
  assert.match(promptText, /mode[^。\n]*口径/)
  const body = request.prompt.map((block) => block.text ?? '').join('\n')
  const factsLine = body.split('\n').find((line) => line.startsWith('已确认事实：'))
  assert.equal(JSON.parse(factsLine.slice('已确认事实：'.length)).methodRequest, 'market')
  assert.match(promptText, /基准日[^。\n]*(?:可选|留空|未指定)/)
  assert.deepEqual(request.toolFilter, { allow: [] })
  assert.equal(request.outputSchema.additionalProperties, false)
  assert.doesNotThrow(() => assertObjectJsonSchema(request.outputSchema))
})
