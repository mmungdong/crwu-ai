import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferred, createFixturePorts, createStartInput, loadWorkflowService,
  createSubagentRuntime, createSubagentProvider, createSubagentRun, createInferenceContext } from '../../helpers/valuation-workflow-fixture.mjs'

const question = (field, patch = {}) => ({ questionId: field, field, prompt: `请确认${field}`,
  knownValue: '', source: '节点核验', control: 'text', required: true, version: 1, applicable: true, ...patch })
const submission = (snapshot, id, answers, patch = {}) => ({ runId: snapshot.runId, nodeId: 'rights',
  expectedRevision: snapshot.revision, expectedQuestionVersion: snapshot.questionnaire.version,
  submissionId: id, answers, supplement: '', noteEdits: {}, ...patch })

test('a native plan receipt with empty non-choice options reaches the complete persisted waiting questionnaire', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const modelQuestions = [
    { questionId: 'use', field: 'use', prompt: '用途前提？', control: 'radio', options: [{ value: 'registered', label: '登记用途' }], required: true, version: 1, applicable: true, reason: '用途前提需要确认' },
    { questionId: 'term', field: 'term', prompt: '租赁期限？', control: 'text', options: [], required: true, version: 1, applicable: true, reason: '材料没有租赁期限' },
  ]
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured: { method: 'market', algorithm: '受控比较计算', questions: modelQuestions } }),
  })
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'synthetic-parent' } })
  const { ports } = createFixturePorts({ infer: (input) => input.stage === 'plan' ? adapter.infer(input) : undefined })
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.status, 'waiting-user')
  assert.equal(result.snapshot.stages.plan.state, 'waiting')
  assert.deepEqual(result.snapshot.questionnaire.questions.map(q => q.field), ['use', 'term'])
  const restored = createValuationWorkflowService(ports)
  assert.equal((await restored.restoreRun(await service.exportRun(result.snapshot.runId))).ok, true)
  assert.equal((await restored.get(result.snapshot.runId)).questionnaire.questions.length, 2)
  service.dispose(); restored.dispose()
})

test('two node question rounds preserve, restore, correct and resend the first answer', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  let round = 0
  const { ports, calls } = createFixturePorts({ infer: async (input) => {
    if (input.stage !== 'rights') return undefined
    round++
    if (round === 1) return { ok: true, outputs: { questions: [question('A')] } }
    if (round === 2) return { ok: true, outputs: { questions: [question('B')] } }
    return undefined
  } })
  const saved = []
  const service = createValuationWorkflowService(ports, { persistence: { save: async (dto) => saved.push(structuredClone(dto)) } })
  const first = await service.start(createStartInput())
  assert.equal(first.snapshot.status, 'waiting-user')
  const second = await service.submitQuestions(submission(first.snapshot, 'a-1', { A: { value: '旧答案' } }))
  assert.equal(second.snapshot.questionnaire.questions.find((q) => q.field === 'A').answer.value, '旧答案')
  assert.deepEqual(second.snapshot.questionnaire.questions.map((q) => q.field), ['A', 'B'])
  const restored = createValuationWorkflowService(ports)
  assert.equal((await restored.restoreRun(await service.exportRun(first.snapshot.runId))).ok, true)
  const image = await restored.get(first.snapshot.runId)
  const third = await restored.submitQuestions(submission(image, 'ab-2', { A: { value: '更正答案' }, B: { value: '第二题答案' } }))
  assert.equal(third.ok, true, third.error)
  const lastRights = calls.inference.filter((call) => call.stage === 'rights').at(-1)
  assert.match(JSON.stringify(lastRights.facts.questionnaire), /更正答案/)
  assert.match(JSON.stringify(lastRights.facts.questionnaire), /第二题答案/)
  assert.equal(third.snapshot.questionnaire.submissions[0].answers.A.value, '旧答案')
  assert.equal(third.snapshot.questionnaire.questions.find((q) => q.field === 'A').answer.value, '更正答案')
  assert.ok(saved.some((dto) => dto.questionnaire?.submissions.length === 1), 'submission must be durable before the next model execution')
  service.dispose(); restored.dispose()
})

test('a running node can persist incomplete drafts but cannot submit a second execution', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const entered = createDeferred(), release = createDeferred()
  let rights = 0
  const { ports } = createFixturePorts({ infer: async (input) => {
    if (input.stage !== 'rights') return undefined
    if (++rights === 1) return { ok: true, outputs: { questions: [question('A')] } }
    entered.resolve(); await release.promise
    return undefined
  } })
  const service = createValuationWorkflowService(ports)
  const first = await service.start(createStartInput())
  const drive = service.submitQuestions(submission(first.snapshot, 'start', { A: { value: '已提交' } }))
  await entered.promise
  const current = await service.get(first.snapshot.runId)
  const draft = await service.saveDraft(submission(current, 'unused', { A: { value: '未提交更正' } }))
  assert.equal(draft.ok, true, draft.error)
  const rejected = await service.submitQuestions(submission(draft.snapshot, 'unsafe', { A: { value: '未提交更正' } }))
  assert.equal(rejected.ok, false)
  release.resolve(); await drive
  const final = await service.get(first.snapshot.runId)
  assert.equal(final.questionnaire.questions.find((q) => q.field === 'A').answer.value, '已提交')
  assert.equal(final.questionnaire.drafts[0].answers.A.value, '未提交更正')
  service.dispose()
})

test('saved answers survive inference failure and unknown mandatory answers never pass the node', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  for (const unknown of [false, true]) {
    let rights = 0
    const { ports } = createFixturePorts({ infer: async (input) => {
      if (input.stage !== 'rights') return undefined
      if (++rights === 1) return { ok: true, outputs: { questions: [question('A')] } }
      return unknown ? undefined : { ok: false, error: '合成模型故障' }
    } })
    const service = createValuationWorkflowService(ports)
    const first = await service.start(createStartInput())
    const answer = unknown ? { value: '', unknown: true, reason: '尚无材料' } : { value: '回答已保存' }
    const next = await service.submitQuestions(submission(first.snapshot, 'save-first', { A: answer }))
    assert.deepEqual(next.snapshot.questionnaire.questions.find((q) => q.field === 'A').answer, answer)
    assert.notEqual(next.snapshot.stages.rights.state, 'passed')
    const fresh = createValuationWorkflowService(ports)
    assert.equal((await fresh.restoreRun(await service.exportRun(first.snapshot.runId))).ok, true)
    assert.deepEqual((await fresh.get(first.snapshot.runId)).questionnaire.questions.find((q) => q.field === 'A').answer, answer)
    service.dispose(); fresh.dispose()
  }
})

test('technical failures do not fabricate employee questions', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts({ infer: async () => ({ ok: false, errorKind: 'capability-gap', error: '合成能力缺失' }) })
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.questionnaire.questions.length, 0)
  service.dispose()
})

test('a model failure cannot be accepted as a passed stage and remains visible after durable restore', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const failure = { kind: 'business', reason: '没有租赁合同，不能验证租期', requirements: ['确认租赁起止日期'], actions: ['补充租赁合同'] }
  const { ports } = createFixturePorts({ infer: async (input) => input.stage === 'rights' ? { ok: true, sessionId: 'actual-failed-node', outputs: { failure } } : undefined })
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.stages.rights.state, 'blocked')
  assert.deepEqual(result.snapshot.stages.rights.outputs.failure, failure)
  const restored = createValuationWorkflowService(ports)
  assert.equal((await restored.restoreRun(await service.exportRun(result.snapshot.runId))).ok, true)
  assert.deepEqual((await restored.get(result.snapshot.runId)).stages.rights.outputs.failure, failure)
  service.dispose(); restored.dispose()
})

test('adapter contract failures retain the actual session and actionable diagnostic instead of becoming a business blocker', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const failure = { kind: 'output-contract', reason: '方法字段类型错误：method 应为字符串', requirements: ['method 必须为字符串'], actions: ['重新执行该节点；无需猜测补充业务答案'] }
  const { ports } = createFixturePorts({ infer: async () => ({ ok: false, errorKind: 'failed', sessionId: 'actual-failed-node', failure, error: failure.reason }) })
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  const receipt = result.snapshot.stages.elements
  assert.equal(receipt.state, 'failed')
  assert.equal(receipt.sessionId, 'actual-failed-node')
  assert.deepEqual(receipt.outputs.failure, failure)
  service.dispose()
})

test('model-owned questions receive Host provenance before admission', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts({ infer: async (input) => input.stage === 'rights' ? { ok: true,
    outputs: { questions: [{ questionId: 'q', field: 'ownership', prompt: '是否共有？', control: 'boolean',
      required: true, version: 1, applicable: true, reason: '产权范围待确认' }] } } : undefined })
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.status, 'waiting-user')
  assert.equal(result.snapshot.questionnaire.questions[0].source, '节点模型核验')
  assert.equal(result.snapshot.questionnaire.questions[0].knownValue, '')
  service.dispose()
})

test('planning business questions are turned into typed questions without asking employees to fix technical failures', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports, calls } = createFixturePorts({ infer: async (input) => input.facts.questionGenerationOnly ? {
    ok: true, outputs: { questions: [{ questionId: 'city', field: 'city', prompt: '所在城市？', control: 'text',
      required: true, version: 1, applicable: true, reason: '规划缺少城市依据' }] },
  } : undefined })
  ports.inference.supportsQuestions = true
  ports.planning = { prepare: async () => ({ ok: false, error: '业务事实缺少城市',
    questions: [{ field: 'city', prompt: '所在城市？' }] }) }
  const service = createValuationWorkflowService(ports)
  const first = await service.start(createStartInput())
  assert.equal(first.snapshot.status, 'waiting-user')
  assert.equal(first.snapshot.questionnaire.questions.find((q) => q.field === 'city').nodeId, 'plan')
  assert.equal(calls.inference.filter((call) => call.facts.questionGenerationOnly).length, 1)
  service.dispose()
})

test('question generation preserves failure details and a system fault takes precedence over returned employee questions', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  for (const kind of ['system', 'business']) {
    const failure = { kind, reason: '规划所需资料读取未完成', requirements: ['核实资料可读性'], actions: ['恢复资料读取后再执行'] }
    const { ports } = createFixturePorts({ infer: async input => input.facts.questionGenerationOnly ? {
      ok: true, outputs: { failure, questions: [{ questionId: 'city', field: 'city', prompt: '所在城市？', control: 'text',
        required: true, version: 1, applicable: true, reason: '规划缺少城市依据' }] },
    } : undefined })
    ports.inference.supportsQuestions = true
    ports.planning = { prepare: async () => ({ ok: false, error: '业务事实缺少城市', questions: [{ field: 'city', prompt: '所在城市？' }] }) }
    const service = createValuationWorkflowService(ports)
    const result = await service.start(createStartInput())
    assert.equal(result.snapshot.status, kind === 'system' ? 'failed' : 'waiting-user')
    assert.deepEqual(result.snapshot.stages.plan.outputs.failure, failure)
    service.dispose()
  }
})

test('unknown stop while generating questions remains a system fault without asking employees to correct business answers', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts({ infer: async input => input.facts.questionGenerationOnly
    ? { ok: false, errorKind: 'stop-unknown', sessionId: 'synthetic-unsettled-child', error: '问题整理子会话尚未确认停止' } : undefined })
  ports.inference.supportsQuestions = true
  ports.planning = { prepare: async () => ({ ok: false, error: '业务事实缺少城市', questions: [{ field: 'city', prompt: '所在城市？' }] }) }
  const service = createValuationWorkflowService(ports)
  const result = await service.start(createStartInput())
  assert.equal(result.snapshot.errorKind, 'stop-unknown')
  assert.equal(result.snapshot.stages.plan.outputs.failure.kind, 'system')
  assert.doesNotMatch(result.snapshot.stages.plan.outputs.failure.actions.join(''), /更正答案/)
  service.dispose()
})

test('a node without typed questions retains every free supplement as separate submitted context', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports, calls } = createFixturePorts()
  const service = createValuationWorkflowService(ports)
  const first = await service.start(createStartInput())
  const second = await service.submitQuestions(submission(first.snapshot, 'note1', {}, { supplement: '第一份补充' }))
  assert.equal(second.ok, true, second.error)
  const third = await service.submitQuestions(submission(second.snapshot, 'note2', {}, { supplement: '第二份补充' }))
  assert.equal(third.ok, true, third.error)
  assert.deepEqual(third.snapshot.questionnaire.notes.map((note) => note.text), ['第一份补充', '第二份补充'])
  const facts = calls.inference.filter((call) => call.stage === 'rights').at(-1).facts
  assert.match(facts.userInput, /第一份补充/)
  assert.match(facts.userInput, /第二份补充/)
  service.dispose()
})

test('legacy clarification submissions also preserve original questions and answers in the durable questionnaire', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts()
  const service = createValuationWorkflowService(ports)
  const first = await service.start(createStartInput({ object: { objectId: 'object-a', useLabel: '', areaSqm: null } }))
  assert.ok(first.snapshot.clarification)
  const next = await service.answer({ runId: first.snapshot.runId, expectedRevision: first.snapshot.revision,
    clarificationId: first.snapshot.clarification.clarificationId, submissionId: 'legacy-answer',
    answers: { useLabel: '公寓', areaSqm: '86.4' } })
  assert.equal(next.ok, true, next.error)
  assert.equal(next.snapshot.questionnaire.questions.find((question) => question.field === 'useLabel').answer.value, '公寓')
  assert.equal(next.snapshot.questionnaire.questions.find((question) => question.field === 'areaSqm').answer.value, '86.4')
  assert.equal(next.snapshot.questionnaire.submissions.length, 1)
  service.dispose()
})

test('correcting an answer conflicting with adopted material invalidates current results without deleting the answer', async () => {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const { ports } = createFixturePorts()
  const seed = createValuationWorkflowService(ports)
  const completed = await seed.start(createStartInput())
  const dto = await seed.exportRun(completed.snapshot.runId)
  dto.stages.elements.outputs.adoptedFacts = [{ field: 'areaSqm', value: 86.4, source: { materialId: 'm', digest: 'd', quote: '建筑面积86.4平方米' } }]
  const { admitQuestions, emptyQuestionnaire } = await import('../../../src/host/domains/report-evaluation/workflow/questionnaire.ts')
  dto.questionnaire = admitQuestions(emptyQuestionnaire(), 'rights', [question('areaSqm', { control: 'number' })])
  const service = createValuationWorkflowService(ports)
  assert.equal((await service.restoreRun(dto)).ok, true)
  const snapshot = await service.get(dto.runId)
  const next = await service.submitQuestions(submission(snapshot, 'area-conflict', { areaSqm: { value: '120' } }))
  assert.equal(next.snapshot.status, 'blocked')
  assert.equal(next.snapshot.result, null)
  assert.equal(next.snapshot.delivery, null)
  assert.equal(next.snapshot.stages.calculation.state, 'pending')
  assert.equal(next.snapshot.questionnaire.questions[0].answer.value, '120')
  assert.ok(next.snapshot.revisions.some((revision) => revision.result !== null))
  seed.dispose(); service.dispose()
})
