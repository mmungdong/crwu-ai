import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'
import { projectWorkflowSnapshot } from '../../../src/host/domains/report-evaluation/workflow/views.ts'

const graph = { graphId: 'valuation', version: '1', nodes: ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']
  .map((stage) => ({ nodeId: `valuation:realestate:${stage}`, label: stage, stage, state: 'pending', gaps: [] })), edges: [] }
const revision = (changes, patch = {}) => ({ runId: 'run-0001', nodeId: 'elements', expectedRevision: 1,
  submissionId: 'global-edit', reason: '更新全局评估条件', source: '员工全局参数输入', changes, ...patch })

test('global inputs expose current Host facts and actual editable node owners without selecting a node', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), service = createValuationWorkflowService(f.ports)
  t.after(() => service.dispose())
  const started = await service.start(createStartInput())
  const view = projectWorkflowSnapshot({ snapshot: started.snapshot, graph, selectedNodeId: '' })
  assert.equal(view.detail, null)
  assert.ok(Array.isArray(view.progress.globalInputs), 'global inputs need their own authoritative projection')
  const fields = Object.fromEntries(view.progress.globalInputs.map((field) => [field.field, field]))
  assert.equal(fields.areaSqm.value, '86.4')
  assert.equal(fields.areaSqm.nodeId, 'valuation:realestate:rights')
  assert.equal(fields.purpose.nodeId, 'valuation:realestate:elements')
  assert.equal(fields.purpose.editable, true)
  assert.equal(fields.objectId.editable, false)
  assert.equal(fields.unitPrice, undefined, 'calculated output is not an editable global input')
})

test('global condition changes rerun from their owning stage and survive durable restore', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), service = createValuationWorkflowService(f.ports)
  t.after(() => service.dispose())
  await service.start(createStartInput())
  const before = f.calls.inference.length
  const result = await service.revise(revision([{ field: 'purpose', value: '资产处置参考' }, { field: 'baseDate', value: '2026-10-19' }]))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.snapshot.revision, 2)
  assert.equal(f.calls.inference[before].stage, 'elements')
  assert.equal(f.calls.inference[before].facts.purpose, '资产处置参考')
  assert.equal(f.calls.inference[before].facts.baseDate, '2026-10-19')
  const history = result.snapshot.revisions.find((item) => item.revision === 2)
  assert.deepEqual(history.changes.map((item) => item.field), ['purpose', 'baseDate'])
  const image = JSON.parse(JSON.stringify(await service.exportRun('run-0001')))
  const other = createFixturePorts(), restored = createValuationWorkflowService(other.ports)
  t.after(() => restored.dispose())
  const receipt = await restored.restoreRun(image)
  assert.equal(receipt.ok, true, receipt.error)
  const view = projectWorkflowSnapshot({ snapshot: receipt.snapshot, graph, selectedNodeId: '' })
  assert.equal(view.progress.globalInputs.find((field) => field.field === 'purpose').value, '资产处置参考')
  assert.equal(other.calls.inference.length, 0)
})

test('invalid global patches are atomic and stale requests cannot dispatch new inference', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), service = createValuationWorkflowService(f.ports)
  t.after(() => service.dispose())
  await service.start(createStartInput())
  const before = JSON.stringify(await service.exportRun('run-0001')), count = f.calls.inference.length
  for (const changes of [
    [{ field: 'purpose', value: '有效修改' }, { field: 'baseDate', value: '2026-02-30' }],
    [{ field: 'mode', value: 'invented-mode' }],
    [{ field: 'unitPrice', value: '99999' }],
  ]) {
    const result = await service.revise(revision(changes))
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(await service.exportRun('run-0001')), before)
  }
  const stale = await service.revise(revision([{ field: 'purpose', value: '旧请求' }], { expectedRevision: 0 }))
  assert.equal(stale.errorKind, 'stale-revision')
  assert.equal(f.calls.inference.length, count)
})

test('node fields retain raw structured values for arrays and nested receipts', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), service = createValuationWorkflowService(f.ports)
  t.after(() => service.dispose())
  const started = await service.start(createStartInput())
  const nested = [{ name: '案例甲', note: '第一行\n第二行', facts: { area: 100 } }]
  started.snapshot.stages.evidence.outputs.samples = nested
  const view = projectWorkflowSnapshot({ snapshot: started.snapshot, graph, selectedNodeId: 'valuation:realestate:evidence' })
  const field = view.detail.outputs.find((item) => item.field === 'samples')
  assert.deepEqual(field.rawValue, nested)
  field.rawValue[0].facts.area = 1
  assert.equal(started.snapshot.stages.evidence.outputs.samples[0].facts.area, 100)
})

test('closed mode questions publish choices that remain validated by Host', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), service = createValuationWorkflowService(f.ports)
  t.after(() => service.dispose())
  const started = await service.start(createStartInput({ mode: null, purpose: '' }))
  const clarification = started.snapshot.clarification
  const mode = clarification.questions.find((question) => question.field === 'mode')
  assert.equal(mode.control, 'radio')
  assert.deepEqual(mode.options, [{ value: 'listing-reference', label: '挂牌参考' }, { value: 'formal', label: '正式评估' }])
  const inferenceCountBeforeAnswer = f.calls.inference.length
  const rejected = await service.answer({ runId: 'run-0001', expectedRevision: 1, submissionId: 'invalid-answer',
    clarificationId: clarification.clarificationId, answers: { mode: 'anything', purpose: '内部参考' } })
  assert.equal(rejected.ok, false)
  assert.equal(f.calls.inference.length, inferenceCountBeforeAnswer, 'invalid choices must not dispatch new inference')
})

test('restored structured questions reject invalid choices, unknown fields and incomplete required answers', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), source = createValuationWorkflowService(f.ports)
  t.after(() => source.dispose())
  await source.start(createStartInput({ mode: null, purpose: '' }))
  const image = JSON.parse(JSON.stringify(await source.exportRun('run-0001')))
  image.clarification.questions = [
    { questionId: 'q-choice', field: 'intent-choice', prompt: '请选择对象', knownValue: '', source: '对象确认', control: 'radio',
      options: [{ value: 'a', label: '对象甲' }, { value: 'b', label: '对象乙' }] },
    { questionId: 'q-checks', field: 'intent-checks', prompt: '请选择来源', knownValue: '', source: '对象确认', control: 'multiselect',
      options: [{ value: 'fang', label: '房天下' }, { value: 'wuba', label: '58同城' }] },
  ]
  for (const answers of [
    { 'intent-choice': 'invented', 'intent-checks': '["fang"]' },
    { 'intent-choice': 'a', 'intent-checks': '["fang","fang"]' },
    { 'intent-choice': 'a', 'intent-checks': '["unknown"]' },
    { 'intent-choice': 'a' },
    { 'intent-choice': 'a', 'intent-checks': '["fang"]', foreign: 'extra' },
  ]) {
    const other = createFixturePorts(), service = createValuationWorkflowService(other.ports)
    try {
      assert.equal((await service.restoreRun(structuredClone(image))).ok, true)
      const before = JSON.stringify(await service.exportRun('run-0001'))
      const result = await service.answer({ runId: 'run-0001', expectedRevision: 1, submissionId: 'invalid-choice',
        clarificationId: image.clarification.clarificationId, answers })
      assert.equal(result.ok, false, 'the Host must enforce declared options and complete answers')
      assert.equal(JSON.stringify(await service.exportRun('run-0001')), before)
      assert.equal(other.calls.inference.length, 0)
    } finally { service.dispose() }
  }
})


test('optional undefined node fields remain readable instead of crashing the projection', async (t) => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const f = createFixturePorts(), service = createValuationWorkflowService(f.ports)
  t.after(() => service.dispose())
  const started = await service.start(createStartInput())
  started.snapshot.stages.evidence.inputs.facts = { confirmedFacts: { optionalValue: undefined } }
  started.snapshot.stages.evidence.outputs.optionalValue = undefined
  const view = projectWorkflowSnapshot({ snapshot: started.snapshot, graph, selectedNodeId: 'valuation:realestate:evidence' })
  for (const rows of [view.detail.inputs, view.detail.outputs]) {
    const field = rows.find((row) => row.field === 'optionalValue')
    assert.ok(field)
    assert.equal(field.value, '')
    assert.equal(field.rawValue, undefined)
  }
})
