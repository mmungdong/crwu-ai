import assert from 'node:assert/strict'
import test from 'node:test'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'

const question = (control = 'multiselect') => ({ questionId: 'q', nodeId: 'valuation:realestate:template-market:select-cases',
  field: 'caseIds', prompt: '采用哪些案例？', source: '候选表', knownValue: '', control, required: true,
  options: [{ value: 'a', label: '案例甲' }, { value: 'b', label: '案例乙' }],
  answerProtocol: 2, version: 1, applicable: true, needsConfirmation: false, answer: null })
const marked = (key, value) => n => n.props?.[key] === value

test('modern choices have exclusive other, require its text, and preserve inactive local drafts', async () => {
  const { QuestionAnswerEditor } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionAnswerEditor.tsx')
  let props = { question: question(), answer: { kind: 'choice', values: ['a'], supplement: '原补充' },
    onChange: answer => { props = { ...props, answer } } }
  let tree = render(QuestionAnswerEditor, props).tree
  find(tree, marked('data-workflow-choice', '__other__')).props.onChange()
  tree = rerender(QuestionAnswerEditor, props)
  assert.deepEqual(props.answer, { kind: 'other', text: '' })
  assert.equal(find(tree, marked('data-workflow-choice', 'a')).props.checked, false)
  find(tree, marked('data-workflow-other', 'q')).props.onChange({ currentTarget: { value: '按其他范围搜索' } })
  tree = rerender(QuestionAnswerEditor, props)
  find(tree, marked('data-workflow-choice', 'a')).props.onChange()
  tree = rerender(QuestionAnswerEditor, props)
  assert.deepEqual(props.answer, { kind: 'choice', values: ['a'], supplement: '原补充' })
  find(tree, marked('data-workflow-choice', '__other__')).props.onChange()
  assert.deepEqual(props.answer, { kind: 'other', text: '按其他范围搜索' })
})

test('select/radio expose other, and free values only defer when Host permits', async () => {
  const { QuestionAnswerEditor } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionAnswerEditor.tsx')
  for (const control of ['select', 'radio']) {
    const tree = render(QuestionAnswerEditor, { question: question(control), onChange() {} }).tree
    assert.match(textOf(tree), /以上都不是，补充说明/)
    assert.equal(find(tree, marked('data-workflow-defer', 'q')), null)
  }
  for (const control of ['text', 'textarea', 'number', 'date']) {
    let answer
    const tree = render(QuestionAnswerEditor, { question: { ...question(control), options: undefined, allowDefer: true },
      onChange: value => { answer = value } }).tree
    find(tree, marked('data-workflow-question-answer', 'q')).props.onChange({ currentTarget: { value: '0' } })
    assert.deepEqual(answer, { kind: 'value', value: '0', supplement: '' })
    find(tree, marked('data-workflow-defer', 'q')).props.onChange({ currentTarget: { checked: true } })
    assert.deepEqual(answer, { kind: 'defer', reason: '' })
  }
})

test('waiting modern questionnaire validates other and displays one primary action with readable history', async () => {
  const { QuestionnairePanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/QuestionnairePanel.tsx')
  const q = question('radio'), nodeId = q.nodeId
  const questionnaire = { version: 1, questions: [q], drafts: [], notes: [], legacy: [], submissions: [
    { submissionId: 's', nodeId, version: 1, updatedAt: '2026-10-21', questions: [q],
      answers: { q: { kind: 'choice', values: ['a'], supplement: '已核对' } }, notes: [] }] }
  let props = { questionnaire, nodeId, revision: 1, running: false, onSave() {}, onSubmit() {} }
  let tree = render(QuestionnairePanel, props).tree
  assert.match(textOf(tree), /案例甲；已核对/)
  assert.equal(findAll(tree, marked('data-workflow-questions-submit', 'true')).length, 1)
  assert.equal(find(tree, marked('data-workflow-questions-submit', 'true')).props.disabled, true)
  props = { ...props, localDraft: { status: 'saved', edit: { nodeId, expectedRevision: 1, expectedQuestionVersion: 1,
    answers: { q: { kind: 'other', text: '换一个条件' } }, supplement: '', noteEdits: {} } } }
  tree = rerender(QuestionnairePanel, props)
  assert.equal(find(tree, marked('data-workflow-questions-submit', 'true')).props.disabled, false)
  assert.equal(findAll(tree, n => n.props?.className?.includes('spinner')).length, 0)
  assert.match(textOf(tree), /草稿已保存/)
})

test('candidate cards display actual evidence gaps without preselecting recommendations and plan facts are readable', async () => {
  const { CandidateSelection } = await import('../../../src/client/modules/report-evaluation/ui/workflow/CandidateSelection.tsx')
  const { MarketPlanSummary } = await import('../../../src/client/modules/report-evaluation/ui/workflow/MarketPlanSummary.tsx')
  const { candidate, plan } = await import('../../helpers/template-market-fixture.mjs')
  const c = candidate('a'); c.missingFields = ['单价']; c.differences = ['楼层待核']
  const tree = render(CandidateSelection, { candidates: [c], version: 7, options: [{ value: 'a', label: '案例甲' }], selected: [], onToggle() {} }).tree
  assert.equal(find(tree, marked('data-workflow-choice', 'a')).props.checked, false)
  assert.equal(find(tree, marked('data-workflow-candidate-version', 7)).props['data-workflow-candidate-version'], 7)
  assert.match(textOf(tree), /单价/)
  assert.match(textOf(tree), /楼层待核/)
  const p = render(MarketPlanSummary, { plan: plan() }).tree
  assert.match(textOf(p), /挂牌价/)
  assert.match(textOf(p), /链家/)
})
