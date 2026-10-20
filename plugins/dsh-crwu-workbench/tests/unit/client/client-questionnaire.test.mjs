import assert from 'node:assert/strict'
import test from 'node:test'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'
import { createDeferred, createNodeDetail } from '../../helpers/valuation-workflow-fixture.mjs'

const nodeId = 'valuation:realestate:rights'
const questionnaire = () => ({ version: 4, questions: [
  { questionId: 'A', nodeId, field: 'community', prompt: '小区', source: '资料', knownValue: '', control: 'text', required: true,
    version: 1, applicable: true, needsConfirmation: false, answer: { value: '旧小区' } },
  { questionId: 'B', nodeId, field: 'confirmed', prompt: '是否出租', source: '资料', knownValue: '', control: 'boolean', required: true,
    version: 1, applicable: true, needsConfirmation: true, answer: null },
], drafts: [], notes: [{ noteId: 'note-A', nodeId, text: '旧补充', history: [] }], submissions: [], legacy: [{ nodeId, text: '历史原文', revision: 1 }] })
const current = (q = questionnaire(), phase = 'waiting-user') => ({ ok: true, empty: false, projectId: 'p', runId: 'r', phase, graph: { nodes: [], edges: [] },
  snapshot: { runId: 'r', revision: 2, status: phase, questionnaire: q }, progress: { runId: 'r', revision: 2, stages: [], questionnaire: q } })
const edit = (patch = {}) => ({ nodeId, expectedRevision: 2, expectedQuestionVersion: 4,
  answers: { A: { value: '新小区' }, B: { value: 'false' } }, supplement: '', noteEdits: {}, ...patch })
const attr = (key) => (node) => node.props?.[key] !== undefined

test('queued execution is not reported as durably accepted before the service saves the answers', async () => {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let q = questionnaire()
  let submittedId = ''
  const controller = createValuationWorkflowController({ current: async () => current(q), node: async () => ({}),
    action: async (input) => {
      if (input.action === 'questions-draft') { q = { ...q, version: q.version + 1 }; return { ok: true, questionnaire: q } }
      submittedId = input.payload.submissionId
      return { ok: true, commandId: 'queued-but-not-executed' }
    } }, { autoPoll: false, draftDebounceMs: 0 })
  await controller.activate()
  assert.equal(await controller.submitQuestions(edit()), true)
  assert.equal(controller.getState().questionDrafts[nodeId].status, 'queued')
  assert.equal(controller.getState().questionDrafts[nodeId].edit.answers.A.value, '新小区')
  q = { ...q, version: q.version + 1, submissions: [{ submissionId: submittedId, answers: edit().answers }] }
  await controller.refresh()
  assert.equal(controller.getState().questionDrafts[nodeId], undefined, 'the accepted receipt must release the queued local draft rather than invent a conflict')
  controller.dispose()
})

test('durable form restores previous answers and submits corrections together with newly answered boolean false', async () => {
  const { QuestionnairePanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionnairePanel.tsx')
  const saves = [], submits = []
  let props = { questionnaire: questionnaire(), nodeId, revision: 2, running: false,
    onSave: (input) => saves.push(input), onSubmit: (input) => submits.push(input) }
  let tree = render(QuestionnairePanel, props).tree
  assert.equal(find(tree, (n) => n.props?.['data-workflow-question-answer'] === 'A').props.value, '旧小区')
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, true)
  find(tree, (n) => n.props?.['data-workflow-question-answer'] === 'A').props.onChange({ currentTarget: { value: '新小区' } })
  tree = rerender(QuestionnairePanel, props)
  find(tree, (n) => n.props?.['data-workflow-question-answer'] === 'B').props.onChange({ currentTarget: { value: 'false' } })
  tree = rerender(QuestionnairePanel, props)
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, false)
  find(tree, attr('data-workflow-questions-submit')).props.onClick()
  assert.deepEqual(submits[0].answers, { A: { value: '新小区' }, B: { value: 'false' } })
  assert.equal(find(tree, attr('data-workflow-note-edit')).props.value, '旧补充')
  assert.match(textOf(tree), /历史原文/)
})

test('unknown requires a reason, running allows edits but refuses submit, and IO collapses independently', async () => {
  const { QuestionnairePanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionnairePanel.tsx')
  const props = { questionnaire: questionnaire(), nodeId, revision: 2, running: false, onSave() {}, onSubmit() {} }
  let tree = render(QuestionnairePanel, props).tree
  find(tree, (n) => n.props?.['data-workflow-question-unknown'] === 'B').props.onChange({ currentTarget: { checked: true } })
  tree = rerender(QuestionnairePanel, props)
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, true)
  find(tree, (n) => n.props?.['data-workflow-question-reason'] === 'B').props.onChange({ currentTarget: { value: '材料没有记载' } })
  tree = rerender(QuestionnairePanel, props)
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, false)
  tree = rerender(QuestionnairePanel, { ...props, running: true })
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, true)
  assert.equal(find(tree, (n) => n.props?.['data-workflow-question-answer'] === 'A').props.disabled, false)
  assert.match(textOf(tree), /执行.*草稿/s)
  const { NodeInspector } = await import('../../../src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx')
  tree = render(NodeInspector, { detail: createNodeDetail(), stale: false, busy: false, retryAnswer: '', canRetry: false,
    onRetryAnswerChange() {}, onRetrySubmit() {} }).tree
  const io = findAll(tree, (n) => ['input', 'output'].includes(n.props?.['data-workflow-detail']))
  assert.equal(io.length, 2)
  assert.ok(io.every((n) => n.type === 'details' && n.props.open !== true))
  assert.ok(io.every((n) => find(n, (child) => child.type === 'summary')))
})

test('draft saving bypasses execution busy, serializes changes and flushes the newest draft before submission', async () => {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let q = questionnaire(), phase = 'running'
  const release = createDeferred(), calls = []
  const controller = createValuationWorkflowController({ current: async () => current(q, phase), node: async () => ({}),
    action: async (input) => {
      calls.push(input)
      if (calls.length === 1) await release.promise
      q = { ...q, version: q.version + 1 }
      return { ok: true, questionnaire: q }
    } }, { autoPoll: false, draftDebounceMs: 0 })
  await controller.activate()
  const first = controller.saveQuestionDraft(edit())
  await new Promise(setImmediate)
  assert.equal(controller.getState().busy, false)
  assert.equal(calls[0].action, 'questions-draft')
  assert.equal(await controller.submitQuestions(edit()), false, 'running cannot accept a formal submission')
  const second = controller.saveQuestionDraft(edit({ supplement: '最后说明' }))
  release.resolve()
  await Promise.all([first, second])
  phase = 'waiting-user'; await controller.refresh()
  assert.equal(await controller.submitQuestions(edit({ supplement: '最后说明' })), true)
  assert.equal(calls.at(-1).action, 'questions-submit')
  assert.equal(calls.at(-1).payload.expectedQuestionVersion, q.version - 1)
  assert.equal(calls.at(-1).payload.supplement, '最后说明')
  assert.equal(calls.at(-1).payload.answers.A.value, '新小区')
  controller.dispose()
})

test('conflict freezes autosave and polls retain local correction until explicit reconciliation', async () => {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let q = questionnaire(), reject = true
  const calls = []
  const controller = createValuationWorkflowController({ current: async () => current(q), node: async () => ({}),
    action: async (input) => { calls.push(input); return reject ? { ok: false, errorKind: 'questionnaire-conflict', error: '版本冲突' }
      : { ok: true, questionnaire: { ...q, version: q.version + 1 } } } }, { autoPoll: false, draftDebounceMs: 0 })
  await controller.activate()
  assert.equal(await controller.saveQuestionDraft(edit()), false)
  q = { ...q, version: 6 }; await controller.refresh()
  assert.equal(controller.getState().questionDrafts[nodeId].edit.answers.A.value, '新小区')
  assert.equal(controller.getState().questionDrafts[nodeId].status, 'conflict')
  await controller.saveQuestionDraft(edit({ supplement: '继续编辑' }))
  assert.equal(calls.length, 1)
  reject = false
  assert.equal(await controller.reconcileQuestionDraft(nodeId), true)
  assert.equal(calls.at(-1).payload.expectedQuestionVersion, 6)
  assert.equal(calls.at(-1).payload.supplement, '继续编辑')
  controller.dispose()
})

test('debounce preserves typed whitespace, repeated polls and task replacement discard stale save receipts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  const release = createDeferred(), calls = []
  let next = current()
  const controller = createValuationWorkflowController({ current: async () => next, node: async () => ({}),
    action: async (input) => { calls.push(input); await release.promise; return { ok: true, questionnaire: { ...questionnaire(), version: 9 } } },
    clear: async () => ({ ok: false, error: '尚未停止' }) }, { autoPoll: false, draftDebounceMs: 500 })
  await controller.activate()
  const first = controller.saveQuestionDraft(edit({ answers: { A: { value: '新小区 ' } }, supplement: '正在输入 ' }))
  assert.equal(calls.length, 0)
  await controller.refresh()
  assert.equal(controller.getState().questionDrafts[nodeId].edit.supplement, '正在输入 ')
  t.mock.timers.tick(500); await new Promise(setImmediate)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.supplement, '正在输入')
  assert.equal(controller.getState().questionDrafts[nodeId].edit.answers.A.value, '新小区 ')
  next = { ...current(), projectId: 'other-project', runId: 'other-run',
    snapshot: { ...current().snapshot, runId: 'other-run' }, progress: { ...current().progress, runId: 'other-run' } }
  await controller.refresh()
  release.resolve(); await first; await new Promise(setImmediate)
  assert.deepEqual(controller.getState().questionDrafts, {})
  assert.equal(controller.getState().current.progress.questionnaire.version, 4)
  controller.dispose()
})

test('semantic reconfirmation and invalid choices, numbers and dates cannot silently submit', async () => {
  const { QuestionnairePanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionnairePanel.tsx')
  const q = questionnaire()
  q.questions = [ { ...q.questions[0], needsConfirmation: true },
    { ...q.questions[1], questionId: 'C', control: 'select', options: [{ value: 'yes', label: '有' }] },
    { ...q.questions[1], questionId: 'N', control: 'number' },
    { ...q.questions[1], questionId: 'D', control: 'date' } ]
  const props = { questionnaire: q, nodeId, revision: 2, running: false, onSave() {}, onSubmit() {} }
  let tree = render(QuestionnairePanel, props).tree
  assert.ok(find(tree, attr('data-workflow-question-reconfirm')))
  for (const [id, value] of [['A', '确认小区'], ['C', 'not-an-option'], ['N', 'Infinity'], ['D', '2026-02-30']]) {
    find(tree, (n) => n.props?.['data-workflow-question-answer'] === id).props.onChange({ currentTarget: { value } })
    tree = rerender(QuestionnairePanel, props)
  }
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, true)
  for (const [id, value] of [['C', 'yes'], ['N', '0'], ['D', '2026-02-28']]) {
    find(tree, (n) => n.props?.['data-workflow-question-answer'] === id).props.onChange({ currentTarget: { value } })
    tree = rerender(QuestionnairePanel, props)
  }
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, false)
})

test('leaving the page flushes pending drafts and reentering retains failed local corrections', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  const calls = []
  const controller = createValuationWorkflowController({ current: async () => current(), node: async () => ({}),
    action: async (input) => { calls.push(input); return { ok: false, error: '合成临时写入故障' } } },
  { autoPoll: false, draftDebounceMs: 500 })
  await controller.activate()
  const saving = controller.saveQuestionDraft(edit({ supplement: '离开时仍须保留' }))
  controller.deactivate()
  await new Promise(setImmediate)
  assert.equal(calls.length, 1, 'deactivate must flush without waiting for the debounce timer')
  assert.equal(await saving, false)
  await controller.activate()
  assert.equal(controller.getState().questionDrafts[nodeId].edit.supplement, '离开时仍须保留')
  assert.equal(controller.getState().questionDrafts[nodeId].status, 'error')
  controller.dispose()
})

test('a stale formal submission exposes a conflict and keeps the submitted correction', async () => {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let q = questionnaire()
  const controller = createValuationWorkflowController({ current: async () => current(q), node: async () => ({}),
    action: async (input) => {
      if (input.action === 'questions-draft') { q = { ...q, version: q.version + 1 }; return { ok: true, questionnaire: q } }
      q = { ...q, version: q.version + 1 }
      return { ok: false, errorKind: 'stale-revision', error: '问卷版本已被另一页面更新' }
    } }, { autoPoll: false, draftDebounceMs: 0 })
  await controller.activate()
  assert.equal(await controller.submitQuestions(edit()), false)
  assert.equal(controller.getState().questionDrafts[nodeId].status, 'conflict')
  assert.equal(controller.getState().questionDrafts[nodeId].edit.answers.A.value, '新小区')
  controller.dispose()
})

test('an optional multiselect may be cleared without blocking all other valid answers', async () => {
  const { QuestionnairePanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionnairePanel.tsx')
  const q = questionnaire()
  q.questions = [{ ...q.questions[0], control: 'multiselect', required: false, answer: { value: '["x"]' },
    options: [{ value: 'x', label: '选项' }] }]
  const props = { questionnaire: q, nodeId, revision: 2, running: false, onSave() {}, onSubmit() {} }
  let tree = render(QuestionnairePanel, props).tree
  find(tree, attr('data-workflow-question-answer')).props.onChange()
  tree = rerender(QuestionnairePanel, props)
  assert.equal(find(tree, attr('data-workflow-question-answer')).props.checked, false)
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, false)
})

test('a system failure shows its concrete cause and recovery before saved answers, without an answer submission action', async () => {
  const { NodeInspector } = await import('../../../src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx')
  const detail = { ...createNodeDetail(), failure: { kind: 'output-contract', reason: 'method 字段类型错误', requirements: ['method 必须为字符串'], actions: ['重新执行该节点'] } }
  let retries = 0
  const tree = render(NodeInspector, { detail, stale: false, busy: false, retryAnswer: '', canRetry: false,
    onRetryAnswerChange() {}, onRetrySubmit() {}, onRetryNode: () => retries++,
    questionnaireProps: { questionnaire: questionnaire(), nodeId, revision: 2, running: false, onSave() {}, onSubmit() {} } }).tree
  assert.match(textOf(tree), /method 字段类型错误/)
  assert.match(textOf(tree), /method 必须为字符串/)
  assert.equal(find(tree, attr('data-workflow-questions-submit')), null)
  find(tree, attr('data-workflow-node-retry')).props.onClick()
  assert.equal(retries, 1)
})

test('a node without questions cannot submit an empty supplement as if it had answered required questions', async () => {
  const { QuestionnairePanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionnairePanel.tsx')
  const q = { ...questionnaire(), questions: [] }
  const tree = render(QuestionnairePanel, { questionnaire: q, nodeId, revision: 2, running: false, onSave() {}, onSubmit() {} }).tree
  assert.equal(find(tree, attr('data-workflow-questions-submit')).props.disabled, true)
  assert.match(textOf(tree), /提交补充并执行/)
})

test('a rejected submission preserves newer corrections typed while the submission was pending', async () => {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let q = questionnaire()
  const release = createDeferred(), dispatched = createDeferred()
  const controller = createValuationWorkflowController({ current: async () => current(q), node: async () => ({}),
    action: async (input) => {
      if (input.action === 'questions-draft') { q = { ...q, version: q.version + 1 }; return { ok: true, questionnaire: q } }
      dispatched.resolve()
      await release.promise
      return { ok: false, error: '问卷版本已经过期' }
    } }, { autoPoll: false, draftDebounceMs: 0 })
  await controller.activate()
  const submitting = controller.submitQuestions(edit())
  await dispatched.promise
  assert.equal(await controller.saveQuestionDraft(edit({ answers: { A: { value: '等待期间的新更正' }, B: { value: 'true' } }, supplement: '新的补充' })), true)
  release.resolve()
  assert.equal(await submitting, false)
  const retained = controller.getState().questionDrafts[nodeId]
  assert.equal(retained.status, 'conflict')
  assert.equal(retained.edit.answers.A.value, '等待期间的新更正')
  assert.equal(retained.edit.answers.B.value, 'true')
  assert.equal(retained.edit.supplement, '新的补充')
  controller.dispose()
})
