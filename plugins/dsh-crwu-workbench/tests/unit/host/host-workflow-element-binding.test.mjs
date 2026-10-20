import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixturePorts, createStartInput, loadWorkflowService, pluginUrl } from '../../helpers/valuation-workflow-fixture.mjs'

const { bindElementFacts } = await import(pluginUrl('src/host/domains/report-evaluation/workflow/elements.ts'))
const empty = { purpose: '', baseDate: '', useLabel: '', areaSqm: null }
const material = (text) => ({ materialId: 'synthetic-material', digest: 'sha256:synthetic', fileName: 'synthetic.pdf', text })
const fact = (field, value, quote) => ({ field, value, source: { materialId: 'synthetic-material', digest: 'sha256:synthetic', quote } })
const bind = (text, facts, current = empty) => bindElementFacts({ materials: [material(text)], sourceFacts: facts, current })

test('identical repeated labelled uses remain valid when every occurrence agrees', () => {
  const result = bind('对象甲；规划用途：公寓\n对象乙；规划用途：公寓\n', [fact('useLabel', '公寓', '规划用途：公寓')])
  assert.equal(result.ok, true, result.gaps.join('; '))
  assert.equal(result.patch.useLabel, '公寓')
})

for (const label of ['建筑面积(m²)：86.4', '建筑面积（平方米）：86.4', '| 建筑面积(m²) | 86.4 |', '建筑面积：86.4平方米    套内建筑面积：70平方米']) {
  test(`gross area is read from an explicit unit-bearing PDF field: ${label}`, () => {
    const quote = label.includes('    ') ? '建筑面积：86.4平方米' : label
    const result = bind(label, [fact('areaSqm', 86.4, quote)])
    assert.equal(result.ok, true, result.gaps.join('; '))
    assert.equal(result.patch.areaSqm, 86.4)
  })
}

test('repeated cropped text cannot hide another label or a different area kind', () => {
  for (const [text, candidate] of [
    ['规划用途：公寓式办公；', fact('useLabel', '公寓', '规划用途：公寓')],
    ['规划用途：公寓；规划用途：公寓式办公；', fact('useLabel', '公寓', '规划用途：公寓')],
    ['套内建筑面积：86.4平方米；', fact('areaSqm', 86.4, '建筑面积：86.4平方米')],
    ['土地建筑面积：86.4平方米；', fact('areaSqm', 86.4, '建筑面积：86.4平方米')],
    ['建筑面积（平方英尺）：86.4；', fact('areaSqm', 86.4, '建筑面积（平方英尺）：86.4')],
    ['建筑面积：86.4；', fact('areaSqm', 86.4, '建筑面积：86.4')],
    ['建筑面积(m²)：17(-1) 86.4', fact('areaSqm', 17, '建筑面积(m²)：17(-1) 86.4')],
    ['建筑面积(m²)：86.4 96.4', fact('areaSqm', 86.4, '建筑面积(m²)：86.4 96.4')],
    ['建筑面积(m²)：86.4e3', fact('areaSqm', 86.4, '建筑面积(m²)：86.4e3')],
    ['建筑面积：86.4平方米英尺', fact('areaSqm', 86.4, '建筑面积：86.4平方米英尺')],
    ['报价186.4；建筑面积：86.4平方米', fact('areaSqm', 86.4, '报价186.4；建筑面积：')],
  ]) assert.equal(bind(text, [candidate]).ok, false)
})

test('two different labelled areas in one quotation remain ambiguous', () => {
  const text = '建筑面积：86.4平方米；建筑面积：96.4平方米'
  assert.equal(bind(text, [fact('areaSqm', 86.4, text)]).ok, false)
})

test('PDF facts with repeated use and a unit in the header advance without employee re-entry', async (t) => {
  const text = '对象甲；规划用途：公寓\n建筑面积(m²)：86.4\n对象乙；规划用途：公寓\n'
  const { ports, calls } = createFixturePorts({ infer: async (r) => r.stage === 'elements' ? { ok: true, outputs: {
    sourceFacts: [fact('useLabel', '公寓', '规划用途：公寓'), fact('areaSqm', 86.4, '建筑面积(m²)：86.4')],
  } } : undefined })
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports); t.after(() => service.dispose())
  const result = await service.start(createStartInput({ object: { objectId: 'object-a', useLabel: '', areaSqm: null }, materials: [material(text)] }))
  assert.equal(result.snapshot.clarification, null)
  assert.equal(result.snapshot.stages.elements.state, 'passed')
  assert.ok(calls.inference.some((r) => r.stage === 'rights'))
  assert.equal(result.snapshot.object.areaSqm, 86.4)
})

test('a valid clarification completes the waiting elements receipt and removes stale errors before continuing', async (t) => {
  const { ports, calls } = createFixturePorts({ infer: async (r) => r.stage === 'elements' ? { ok: true, outputs: {
    sourceFacts: [fact('useLabel', '公寓', 'nonexistent synthetic quote'), fact('areaSqm', 86.4, 'nonexistent synthetic quote')],
  } } : undefined })
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports); t.after(() => service.dispose())
  const first = await service.start(createStartInput({ object: { objectId: 'object-a', useLabel: '', areaSqm: null }, materials: [material('不可直接核对的合成扫描正文')] }))
  assert.equal(first.snapshot.status, 'waiting-user')
  assert.equal(first.snapshot.stages.elements.gaps.length, 2)
  const result = await service.answer({ runId: 'run-0001', clarificationId: first.snapshot.clarification.clarificationId,
    expectedRevision: 1, submissionId: 'synthetic-confirmation', answers: { useLabel: '公寓', areaSqm: '86.4' } })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.snapshot.stages.elements.state, 'passed')
  assert.deepEqual(result.snapshot.stages.elements.gaps, [])
  const rights = calls.inference.find((r) => r.stage === 'rights')
  assert.ok(rights)
  assert.equal(rights.facts.areaSqm, 86.4)
  assert.ok(Object.keys(rights.facts.upstream.elements ?? {}).length > 0, 'the completed upstream receipt must reach the next node')
  assert.ok(rights.facts.userInput.includes('86.4'), 'the employee answer remains current input')
  const saved = await service.exportRun('run-0001')
  assert.equal(saved.initialInput.userInput, '')
  const completed = saved.stages.elements.outputs
  assert.equal(completed.sourceFacts.length, 0)
  assert.equal(completed.supersededSourceFacts.length, 2)
  assert.deepEqual(completed.confirmedAnswers.map(({ field, value, source }) => ({ field, value, source })), [
    { field: 'useLabel', value: '公寓', source: 'user-confirmation' },
    { field: 'areaSqm', value: 86.4, source: 'user-confirmation' },
  ])
  const restored = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => restored.dispose())
  assert.equal((await restored.restoreRun(JSON.parse(JSON.stringify(saved)))).ok, true)
  assert.deepEqual((await restored.exportRun('run-0001')).stages.elements.outputs.confirmedAnswers, completed.confirmedAnswers)
})

test('confirming use and area cannot waive another unverified source fact', async (t) => {
  const { ports, calls } = createFixturePorts({ infer: async (r) => r.stage === 'elements' ? { ok: true, outputs: {
    sourceFacts: [fact('useLabel', '公寓', 'missing'), fact('areaSqm', 86.4, 'missing'), fact('purpose', '转让', 'missing')],
  } } : undefined })
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports); t.after(() => service.dispose())
  const first = await service.start(createStartInput({ object: { objectId: 'object-a', useLabel: '', areaSqm: null }, materials: [material('合成扫描正文')] }))
  const result = await service.answer({ runId: 'run-0001', clarificationId: first.snapshot.clarification.clarificationId,
    expectedRevision: 1, submissionId: 'synthetic-unrelated-failure', answers: { useLabel: '公寓', areaSqm: '86.4' } })
  assert.equal(result.snapshot.status, 'blocked')
  assert.ok(result.snapshot.stages.elements.gaps.length > 0)
  assert.equal(calls.inference.some((r) => r.stage === 'rights'), false)
  assert.equal(calls.calculator.length, 0)
})
