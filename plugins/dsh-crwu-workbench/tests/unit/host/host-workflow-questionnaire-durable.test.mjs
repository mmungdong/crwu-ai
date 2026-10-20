import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'
import { emptyQuestionnaire, admitQuestions, submitQuestionAnswers, saveQuestionDraft } from '../../../src/host/domains/report-evaluation/workflow/questionnaire.ts'
import { parseRunRecord as restoreRunRecord, serializeRunRecord } from '../../../src/host/domains/report-evaluation/workflow/persistence.ts'
import { projectWorkflowSnapshot } from '../../../src/host/domains/report-evaluation/workflow/views.ts'
import { openWorkflowStore } from '../../../src/host/core/workflow-store/index.ts'

function questionnaire() {
  const first = admitQuestions(emptyQuestionnaire(), 'elements', [{ questionId: 'q-a', field: 'a', prompt: 'A', knownValue: '', source: 'employee' }])
  const input = { nodeId: 'elements', expectedRevision: 1, expectedQuestionVersion: first.version, answers: { 'q-a': { value: 'A' } }, noteEdits: {}, supplement: 'saved note', submissionId: 'saved-submission' }
  const accepted = submitQuestionAnswers(first, input).state
  return saveQuestionDraft(accepted, { ...input, expectedQuestionVersion: accepted.version, supplement: 'draft note', answers: { 'q-a': { value: 'correction' } } }).state
}

async function image() {
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(createFixturePorts().ports)
  try {
    const started = await service.start(createStartInput())
    return { image: await service.exportRun(started.snapshot.runId), snapshot: started.snapshot }
  } finally { service.dispose() }
}

test('durable questionnaire roundtrip preserves drafts, submitted history and notes without mutable aliases', async () => {
  const source = (await image()).image
  source.questionnaire = questionnaire()
  const restored = restoreRunRecord(source)
  assert.equal(restored.ok, true, restored.error)
  assert.deepEqual(restored.record.questionnaire, source.questionnaire)
  const original = structuredClone(restored.record.questionnaire)
  const dto = serializeRunRecord(restored.record)
  assert.deepEqual(dto.questionnaire, original)
  dto.questionnaire.questions[0].answer.value = 'mutated image'
  assert.deepEqual(restored.record.questionnaire, original)
  for (const mutate of [q => { q.questions[0].control = 'image' }, q => { q.drafts[0].answers.foreign = { value: 'x' } }, q => { q.version = -1 }]) {
    const invalid = structuredClone(source)
    mutate(invalid.questionnaire)
    assert.equal(restoreRunRecord(invalid).ok, false)
  }
})

test('legacy DTO without questionnaire migrates original node and revision text', async () => {
  const source = (await image()).image
  delete source.questionnaire
  source.nodePrompts.rights = 'legacy original text'
  const result = restoreRunRecord(source)
  assert.equal(result.ok, true, result.error)
  assert.ok(result.record.questionnaire.legacy.some(note => note.nodeId === 'rights' && note.text === 'legacy original text' && note.revision === source.revision))
})

test('the actual SQLite JSON restores the full questionnaire and clear deletes its row without an archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crwu-questionnaire-sqlite-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { path: join(root, '.crwu', 'workflows.sqlite'), authorize: () => ({ ok: true, error: '' }) }
  const dto = (await image()).image
  dto.questionnaire = questionnaire()
  let store = await openWorkflowStore(options)
  const record = { workspaceId: 'synthetic-workspace', stepId: 'valuation', runId: dto.runId,
    graphId: 'synthetic-graph', graphVersion: '1', revision: dto.revision, status: dto.status, state: { dto }, files: [] }
  await store.saveCurrent(record)
  await store.close()
  store = await openWorkflowStore(options)
  const restored = await store.getCurrent(record.workspaceId, record.stepId)
  assert.deepEqual(restored.state.dto.questionnaire, dto.questionnaire)
  assert.equal(restoreRunRecord(restored.state.dto).ok, true)
  assert.equal(await store.clearCurrent(record.workspaceId, record.stepId, dto.runId), true)
  await store.close()
  store = await openWorkflowStore(options)
  assert.equal(await store.getCurrent(record.workspaceId, record.stepId), null)
  await store.close()
})

test('snapshot projection consistently maps every questionnaire owner to compiled node IDs', async () => {
  const source = (await image()).snapshot
  source.questionnaire = questionnaire()
  source.questionnaire.legacy.push({ nodeId: 'rights', text: 'legacy', revision: 1 })
  const intent = admitQuestions(emptyQuestionnaire(), 'intent', [{ questionId: 'intent-q', field: 'intent', prompt: 'Intent', knownValue: '', source: 'employee' }])
  source.questionnaire.questions.push(...intent.questions)
  const graph = { graphId: 'test', version: '1', nodes: [
    { nodeId: 'valuation:intent-router', label: '意图', state: 'pending', gaps: [] },
    ...Object.keys(source.stages).map(stage => ({ nodeId: `compiled:${stage}`, stage, label: stage, state: 'pending', gaps: [] })),
  ], edges: [] }
  const before = structuredClone(source.questionnaire)
  const { progress } = projectWorkflowSnapshot({ snapshot: source, graph, selectedNodeId: '' })
  const q = progress.questionnaire
  assert.equal(q.questions[0].nodeId, 'compiled:elements')
  assert.equal(q.questions[1].nodeId, 'valuation:intent-router')
  assert.equal(q.drafts[0].nodeId, 'compiled:elements')
  assert.equal(q.notes[0].nodeId, 'compiled:elements')
  assert.equal(q.submissions[0].nodeId, 'compiled:elements')
  assert.equal(q.submissions[0].notes[0].nodeId, 'compiled:elements')
  assert.equal(q.legacy[0].nodeId, 'compiled:rights')
  assert.deepEqual(source.questionnaire, before)
  q.questions[0].answer.value = 'mutated'
  assert.deepEqual(source.questionnaire, before)
})
