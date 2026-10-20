import assert from 'node:assert/strict'
import test from 'node:test'

const load = () => import('../../../src/host/domains/report-evaluation/workflow/questionnaire.ts')
const question = (field, patch = {}) => ({ questionId: `q-${field}`, field, prompt: field,
  knownValue: '', source: 'employee', control: 'text', ...patch })
const edit = (state, answers, patch = {}) => ({ nodeId: 'elements', expectedRevision: 1,
  expectedQuestionVersion: state.version, answers, supplement: '', noteEdits: {}, ...patch })
const submit = (model, state, answers, patch = {}) => model.submitQuestionAnswers(state,
  { ...edit(state, answers), submissionId: `submit-${state.version}`, ...patch })

test('submitted history keeps the original question definition after later semantic changes', async () => {
  const m = await load()
  const state = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a', { prompt: '是否包含土地？', version: 1 })])
  const accepted = submit(m, state, { 'q-a': { value: '包含' } }).state
  const changed = m.admitQuestions(accepted, 'elements', [question('a', { prompt: '是否仅包含土地？', version: 2 })])
  assert.equal(changed.submissions[0].questions[0].prompt, '是否包含土地？')
  assert.equal(changed.submissions[0].questions[0].version, 1)
  assert.equal(m.restoreQuestionnaire(changed).submissions[0].questions[0].prompt, '是否包含土地？')
})

test('an empty canonical node draft survives restore for optional free supplements', async () => {
  const m = await load()
  const state = m.emptyQuestionnaire()
  const draft = m.saveQuestionDraft(state, edit(state, {}, { supplement: '尚未提交的补充' }))
  assert.equal(draft.ok, true, draft.error)
  assert.equal(m.restoreQuestionnaire(draft.state).drafts[0].supplement, '尚未提交的补充')
})

test('questionnaire accumulates A then B and preserves editable accepted history independently from drafts', async () => {
  const m = await load()
  const empty = m.emptyQuestionnaire()
  const a = m.admitQuestions(empty, 'elements', [question('a')])
  assert.equal(empty.questions.length, 0)
  const first = submit(m, a, { 'q-a': { value: 'A' } }, { supplement: 'first note' })
  assert.equal(first.ok, true, first.error)
  const b = m.admitQuestions(first.state, 'elements', [question('b')])
  assert.equal(b.questions.length, 2)
  assert.deepEqual(m.effectiveQuestionAnswers(b), { 'q-a': { value: 'A' } })
  assert.equal(submit(m, b, { 'q-a': { value: 'A' } }).ok, false)
  const draft = m.saveQuestionDraft(b, edit(b, { 'q-a': { value: 'corrected' } }))
  assert.equal(draft.ok, true)
  assert.deepEqual(m.effectiveQuestionAnswers(draft.state), { 'q-a': { value: 'A' } })
  const noteId = b.notes[0].noteId
  const second = submit(m, draft.state, { 'q-a': { value: 'corrected' }, 'q-b': { value: 'B' } },
    { noteEdits: { [noteId]: 'updated note' }, supplement: 'second note' })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.changed, true)
  assert.equal(second.state.submissions[0].answers['q-a'].value, 'A')
  assert.equal(second.state.submissions[0].notes[0].text, 'first note')
  assert.deepEqual(second.state.notes[0].history, ['first note'])
  assert.equal(second.state.submissions[1].answers['q-b'].value, 'B')
  const restored = m.restoreQuestionnaire(JSON.parse(JSON.stringify(second.state)))
  assert.deepEqual(restored, second.state)
  restored.questions[0].answer.value = 'external'
  assert.equal(second.state.questions[0].answer.value, 'corrected')
  assert.equal(m.emptyQuestionnaire().questions.length, 0)
})

test('typed answers validate false, numbers, dates and choices; unknown needs a reason and remains unknown', async () => {
  const m = await load()
  const definitions = [question('flag', { control: 'boolean' }), question('number', { control: 'number' }),
    question('date', { control: 'date' }), question('choice', { control: 'select', options: [{ value: 'x', label: 'X' }] }),
    question('many', { control: 'multiselect', options: [{ value: 'x', label: 'X' }] })]
  const state = m.admitQuestions(m.emptyQuestionnaire(), 'elements', definitions)
  const answers = { 'q-flag': { value: 'false' }, 'q-number': { value: '0' }, 'q-date': { value: '2024-02-29' },
    'q-choice': { value: 'x' }, 'q-many': { value: '["x"]' } }
  assert.equal(submit(m, state, answers).ok, true)
  for (const [key, value] of [['q-flag', 'yes'], ['q-number', 'Infinity'], ['q-number', '0x10'],
    ['q-date', '2023-02-29'], ['q-choice', 'foreign'], ['q-many', '["foreign"]'], ['q-many', '["x","x"]']]) {
    assert.equal(submit(m, state, { ...answers, [key]: { value } }).ok, false, `${key}: ${value}`)
  }
  assert.equal(submit(m, state, { ...answers, 'q-number': { value: '', unknown: true } }).ok, false)
  const unknown = submit(m, state, { ...answers, 'q-number': { value: '', unknown: true, reason: 'await material' } })
  assert.equal(unknown.ok, true)
  assert.equal(unknown.unknown, true)
  assert.equal(m.effectiveQuestionAnswers(unknown.state)['q-number'].unknown, true)
})

test('semantic changes, explicit inapplicability and reappearance require confirmation; cosmetic changes keep answers', async () => {
  const m = await load()
  const first = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a')])
  const answered = submit(m, first, { 'q-a': { value: '1' } }).state
  const cosmetic = m.admitQuestions(answered, 'elements', [question('a', { questionId: 'replacement', prompt: 'Better words' })])
  assert.equal(cosmetic.questions[0].questionId, 'q-a')
  assert.equal(cosmetic.questions[0].needsConfirmation, false)
  const semantic = m.admitQuestions(cosmetic, 'elements', [question('a', { control: 'number' })])
  assert.equal(semantic.questions[0].needsConfirmation, true)
  assert.deepEqual(m.effectiveQuestionAnswers(semantic), {})
  const inactive = m.admitQuestions(answered, 'elements', [question('a', { applicable: false, inapplicabilityReason: 'scope changed' })])
  assert.equal(inactive.questions[0].answer.value, '1')
  assert.deepEqual(m.effectiveQuestionAnswers(inactive), {})
  assert.equal(m.admitQuestions(inactive, 'elements', [question('a')]).questions[0].needsConfirmation, true)
  assert.throws(() => m.admitQuestions(answered, 'elements', [question('a', { applicable: false })]))
})

test('optimistic saves reject stale state, foreign answers and notes; duplicate submissions are idempotent', async () => {
  const m = await load()
  const state = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a')])
  const original = JSON.stringify(state)
  const input = edit(state, { 'q-a': { value: 'A' } })
  const draft = m.saveQuestionDraft(state, input)
  assert.equal(m.saveQuestionDraft(draft.state, input).ok, false)
  assert.equal(submit(m, state, { foreign: { value: 'x' } }).ok, false)
  assert.equal(submit(m, state, { 'q-a': { value: 'A' } }, { noteEdits: { foreign: 'x' } }).ok, false)
  assert.equal(JSON.stringify(state), original)
  const request = { ...input, submissionId: 'stable-id' }
  const accepted = m.submitQuestionAnswers(state, request)
  const duplicate = m.submitQuestionAnswers(accepted.state, request)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.changed, false)
  assert.deepEqual(duplicate.state, accepted.state)
  assert.equal(m.submitQuestionAnswers(accepted.state, { ...request, answers: { 'q-a': { value: 'different' } } }).ok, false)
})

test('strict restore rejects malformed images and drafts remain separate from submitted answers', async () => {
  const m = await load()
  const state = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a')])
  const saved = m.saveQuestionDraft(state, edit(state, { 'q-a': { value: '' } })).state
  assert.deepEqual(m.restoreQuestionnaire(saved), saved)
  assert.deepEqual(m.effectiveQuestionAnswers(m.restoreQuestionnaire(saved)), {})
  for (const mutate of [s => { s.version = -1 }, s => { s.questions[0].control = 'image' },
    s => { s.questions.push(structuredClone(s.questions[0])) }, s => { s.drafts[0].answers.foreign = { value: 'x' } },
    s => { s.questions[0].answer = { value: 'x', unexpected: true } }, s => { s.notes = [{ nodeId: 'elements' }] }]) {
    const malformed = structuredClone(saved)
    mutate(malformed)
    assert.equal(m.restoreQuestionnaire(malformed), null)
  }
  assert.equal(m.restoreQuestionnaire(JSON.parse('{"__proto__":{},"version":0}')), null)
})

test('legacy migration preserves attributable structured answers and original text without inferring prose types', async () => {
  const m = await load()
  const record = { revision: 3, nodePrompts: { elements: 'current note' }, revisions: [{ revision: 2,
    changes: [{ nodeId: 'rights', field: 'promptSupplement', before: 'old note', after: 'new note' }] }],
    stages: { elements: { outputs: { confirmedAnswers: [{ field: 'a', question: 'Legacy A', answer: 'A' }] } } },
    clarification: { questions: [question('a', { nodeId: 'elements' })] } }
  const state = m.legacyQuestionnaire(record)
  assert.deepEqual(m.effectiveQuestionAnswers(state), { 'q-a': { value: 'A' } })
  assert.ok(state.legacy.some(note => note.text === 'current note' && note.nodeId === 'elements' && note.revision === 3))
  assert.ok(state.legacy.some(note => note.text === 'old note' && note.revision === 2))
  assert.equal(state.questions.length, 1)
})

test('changing a choice label with stable value requires confirmation and keeps the old answer visible', async () => {
  const m = await load()
  const first = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a', { control: 'select', options: [{ value: 'x', label: '包含' }] })])
  const accepted = submit(m, first, { 'q-a': { value: 'x' } }).state
  const revised = m.admitQuestions(accepted, 'elements', [question('a', { control: 'select', options: [{ value: 'x', label: '不包含' }] })])
  assert.equal(revised.questions[0].needsConfirmation, true)
  assert.equal(revised.questions[0].answer.value, 'x')
  assert.deepEqual(m.effectiveQuestionAnswers(revised), {})
})

test('legacy answered records without clarification preserve known fixed fields and original unknown question-answer text', async () => {
  const m = await load()
  const state = m.legacyQuestionnaire({ revision: 4, stages: { elements: { outputs: { confirmedAnswers: [
    { field: 'areaSqm', question: 'Original area prompt', answer: '25', value: 25 },
    { field: 'custom', question: 'Unspecified original prompt', answer: 'Original answer text' },
  ] } } } })
  assert.ok(state.questions.some(q => q.field === 'areaSqm' && q.control === 'number' && q.answer.value === '25' && q.prompt === 'Original area prompt'))
  assert.ok(state.legacy.some(note => note.nodeId === 'elements' && note.revision === 4 && note.text.includes('Unspecified original prompt') && note.text.includes('Original answer text')))
  assert.ok(!state.questions.some(q => q.field === 'custom'))
})

test('idempotent submission compares answer maps independent of property order', async () => {
  const m = await load()
  const state = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a'), question('b')])
  const accepted = submit(m, state, { 'q-a': { value: 'A' }, 'q-b': { value: 'B' } }, { submissionId: 'stable' })
  const duplicate = submit(m, accepted.state, { 'q-b': { value: 'B' }, 'q-a': { value: 'A' } }, { submissionId: 'stable' })
  assert.equal(duplicate.ok, true, duplicate.error)
  assert.equal(duplicate.changed, false)
})

test('strict restore rejects invalid timestamps, orphan drafts and impossible accepted answer flags', async () => {
  const m = await load()
  const state = m.admitQuestions(m.emptyQuestionnaire(), 'elements', [question('a')])
  const accepted = submit(m, state, { 'q-a': { value: 'A' } }).state
  for (const mutate of [s => { s.submissions[0].updatedAt = 'not-a-date' },
    s => { s.drafts.push({ nodeId: 'foreign', answers: {}, supplement: '', noteEdits: {}, updatedAt: '2026-10-20T00:00:00.000Z' }) },
    s => { s.questions[0].answer = null }, s => { s.submissions[0].version = 0 }]) {
    const invalid = structuredClone(accepted)
    mutate(invalid)
    assert.equal(m.restoreQuestionnaire(invalid), null)
  }
})
