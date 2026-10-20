import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createWorkflowInferenceRequest,
} from '../../helpers/valuation-workflow-fixture.mjs'
import { createDshWorkflowInference } from '../../../src/host/integrations/valuation-workflow/inference.ts'

const question = (patch = {}) => ({ questionId: 'tenure', field: 'tenure', prompt: '请确认权利期限',
  control: 'text', required: true, version: 1, applicable: true, reason: '材料未明确期限', ...patch })

async function infer(structured, patch = {}) {
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured }),
  })
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const result = await adapter.infer(createWorkflowInferenceRequest(patch))
  return { result, request: runtime.calls.starts[0].request }
}

test('every regular stage can return only typed employee blockers with complete submitted context', async () => {
  for (const stage of ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']) {
    const structured = { questions: [question()] }
    const { result, request } = await infer(structured, { stage, facts: {
      questionAnswers: [{ field: 'prior', value: 'previous-answer' }], questionNotes: ['previous-note'],
    } })
    assert.equal(result.ok, true, `${stage}: ${result.error}`)
    assert.deepEqual(result.outputs, structured)
    assert.doesNotThrow(() => assertObjectJsonSchema(request.outputSchema))
    const prompt = request.prompt.map((p) => p.text ?? '').join('\n')
    assert.match(prompt, /previous-answer/)
    assert.match(prompt, /previous-note/)
    assert.match(prompt, /语义版本/)
    assert.match(prompt, /系统/)
  }
})

test('all supported controls and bounded closed option objects are admitted', async () => {
  for (const control of ['text', 'textarea', 'number', 'date', 'select', 'radio', 'multiselect', 'boolean']) {
    const options = ['select', 'radio', 'multiselect'].includes(control)
      ? { options: [{ value: 'lease', label: '租赁' }, { value: 'owned', label: '自有' }] } : {}
    const { result } = await infer({ questions: [question({ control, ...options })] })
    assert.equal(result.ok, true, `${control}: ${result.error}`)
  }
})

test('malformed model questions fail the structured output contract without publishing outputs', async () => {
  const invalid = [
    question({ control: 'javascript' }), question({ version: 1.5 }), question({ version: 0 }),
    question({ field: '' }), question({ prompt: 'a'.repeat(4001) }), question({ required: 'yes' }),
    question({ control: 'select' }), question({ control: 'radio', options: [] }),
    question({ control: 'select', options: [{ value: 'x', label: 'X', command: 'escape' }] }),
    question({ control: 'select', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }),
    question({ applicable: false, reason: '' }), question({ nodeId: 'foreign-node' }),
  ]
  for (const candidate of invalid) {
    const { result } = await infer({ useLabel: '公寓', questions: [candidate] })
    assert.equal(result.ok, false, JSON.stringify(candidate).slice(0, 160))
    assert.equal(result.outputs, undefined)
  }
  assert.equal((await infer({ questions: Array.from({ length: 65 }, (_, n) => question({ questionId: `q${n}`, field: `f${n}` })) })).result.ok, false)
})

test('legacy regular stage output remains valid without a questions collection', async () => {
  assert.equal((await infer({ useLabel: '公寓', areaSqm: 86.4 })).result.ok, true)
})

test('native structured output with empty options on a text question keeps the whole business questionnaire', async () => {
  const structured = { method: 'market', algorithm: '受控比较计算', questions: [
    question({ questionId: 'use', field: 'use', control: 'radio', options: [{ value: 'registered', label: '沿用登记用途' }] }),
    question({ questionId: 'term', field: 'term', control: 'text', options: [] }),
  ] }
  const { result } = await infer(structured, { stage: 'plan' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.outputs.questions.length, 2)
  assert.equal(result.outputs.questions[1].options, undefined)
  assert.deepEqual(structured.questions[1].options, [], 'normalization must not mutate the provider receipt')
  assert.equal((await infer({ questions: [question({ options: [{ value: 'x', label: 'X' }] })] })).result.ok, false)
})

test('the model receives the actual schema and every stage admits a concrete failure receipt', async () => {
  const failure = { kind: 'business', reason: '没有租赁合同，不能验证租期', requirements: ['确认租赁起止日期'], actions: ['补充租赁合同或回答租期问题'] }
  for (const stage of ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']) {
    const { result, request } = await infer({ failure }, { stage })
    assert.equal(result.ok, true, stage)
    assert.deepEqual(result.outputs.failure, failure)
    assert.match(request.prompt.map(p => p.text ?? '').join('\n'), /"additionalProperties":false/)
  }
  for (const invalid of [{ ...failure, reason: '' }, { ...failure, reason: '受阻' }, { ...failure, requirements: [] }, { ...failure, actions: [] }]) {
    assert.equal((await infer({ failure: invalid })).result.ok, false)
  }
})

test('missing structured output, schema violations and abnormal stops return different concrete recovery receipts', async () => {
  for (const [value, reason] of [
    [{ stopReason: 'completed', output: [{ type: 'text', text: 'private-model-text' }] }, /结构化对象/],
    [{ stopReason: 'completed', structured: { areaSqm: 'private-bad-value', 'private-unknown-key': 1 } }, /areaSqm/],
    [{ stopReason: 'error', diagnostic: 'private-diagnostic' }, /异常结束/],
  ]) {
    const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, { run: createSubagentRun({ result: Promise.resolve(value) }) })
    const port = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
    const result = await port.infer(createWorkflowInferenceRequest())
    assert.equal(result.ok, false)
    assert.match(result.failure.reason, reason)
    assert.ok(result.failure.requirements.length > 0)
    assert.ok(result.failure.actions.length > 0)
    assert.doesNotMatch(JSON.stringify(result), /private-/)
  }
})
