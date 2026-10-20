import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createWorkflowInferenceRequest,
} from '../../helpers/valuation-workflow-fixture.mjs'

test('element inference receives material text and returns source-bound facts only', async () => {
  const material = { materialId: 'm1', fileName: '权证.txt', digest: 'sha256:fixture', text: '规划用途：公寓' }
  const structured = { sourceFacts: [{
    field: 'useLabel', value: '公寓', source: { materialId: 'm1', digest: material.digest, quote: material.text },
  }] }
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const result = await adapter.infer(createWorkflowInferenceRequest({ stage: 'elements', materials: [material] }))
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.outputs, structured)
  const request = runtime.calls.starts[0].request
  assert.ok(request.prompt.map((block) => block.text ?? '').join('\n').includes(material.text))
  assert.equal(request.outputSchema.additionalProperties, false)
  assert.doesNotThrow(() => assertObjectJsonSchema(request.outputSchema))
})

test('stage inference rejects extra narrative fields', async () => {
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured: { useLabel: '公寓', commentary: '让我为您仔细分析' } }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const result = await adapter.infer(createWorkflowInferenceRequest())
  assert.equal(result.ok, false)
  assert.equal(result.outputs, undefined)
})
