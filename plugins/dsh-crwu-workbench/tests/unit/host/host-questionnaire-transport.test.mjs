import assert from 'node:assert/strict'
import test from 'node:test'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { parseWorkflowAction } from '../../../src/host/integrations/valuation-workflow/production/operations.ts'
import { createValuationWorkflowRuntime } from '../../../src/host/integrations/valuation-workflow/runtime.ts'
import { createDeferred } from '../../helpers/valuation-workflow-fixture.mjs'
import { parseQuestionEdit } from '../../../src/host/integrations/valuation-workflow/production/operations.ts'

test('typed answer transport preserves discriminators and refuses mixed or injected shapes', () => {
  const request = { nodeId: 'confirm-plan', expectedRevision: 1, expectedQuestionVersion: 1,
    answers: { q1: { kind: 'other', text: '补充一个具体方案' } }, supplement: '', noteEdits: {}, submissionId: 'typed-1' }
  assert.deepEqual(parseQuestionEdit(request, true), request)
  for (const answer of [{ kind: 'other', text: '说明', value: 'injected' }, { kind: 'choice', values: ['x'], supplement: '', command: 'exec' },
    { kind: 'defer', reason: 'later', unknown: true }, { kind: 'value', value: 'x', supplement: '', toolName: 'shell' }]) {
    assert.equal(parseQuestionEdit({ ...request, answers: { q1: answer } }, true), null)
  }
})

const graph = { nodes: [
  { nodeId: 'valuation:realestate:rights', stage: 'rights' },
  { nodeId: 'valuation:intent-router' }, { nodeId: '__end__' },
] }
const edit = (patch = {}) => ({ nodeId: 'rights', expectedRevision: 1, expectedQuestionVersion: 2,
  answers: { tenure: { value: '租赁' } }, supplement: '', noteEdits: {}, ...patch })

test('closed panel parser resolves real nodes and intent without trusting node suffixes', () => {
  for (const action of ['questions-draft', 'questions-submit']) {
    const payload = edit({ nodeId: 'valuation:realestate:rights', ...(action === 'questions-submit' ? { submissionId: 'submit-a' } : {}) })
    const parsed = parseWorkflowAction({ action, payload }, graph)
    assert.equal(parsed.ok, true, parsed.error)
    assert.equal(parsed.payload.nodeId, 'rights')
    const router = parseWorkflowAction({ action, payload: { ...payload, nodeId: 'valuation:intent-router' } }, graph)
    assert.equal(router.ok, true, router.error)
    assert.equal(router.payload.nodeId, 'intent')
    for (const patch of [{ nodeId: 'forged:rights' }, { nodeId: '__end__' }, { path: '/escape' },
      { expectedQuestionVersion: '2' }, { answers: { tenure: { value: 'x', command: 'escape' } } },
      { noteEdits: { note: { value: 'escape' } } }]) {
      assert.equal(parseWorkflowAction({ action, payload: { ...payload, ...patch } }, graph).ok, false)
    }
  }
})

test('the transport admits cumulative answers beyond one model question batch', () => {
  const answers = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`q-${index}`, { value: '已回答' }]))
  const parsed = parseWorkflowAction({ action: 'questions-draft',
    payload: edit({ nodeId: 'valuation:realestate:rights', answers }) }, graph)
  assert.equal(parsed.ok, true, parsed.error)
  assert.equal(Object.keys(parsed.payload.answers).length, 70)
})

async function fixture() {
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'project-a', projectId: 'project-a', sessionId: 'parent-a', parentSessionId: 'parent-a',
    casePath: '/workspace/project-a', workspaceId: 'workspace-a', workspacePath: '/workspace', openedAt: 1,
    snapshot: { valuationId: 'project-a', digest: 'frozen', files: [], frozenAt: '2026-10-17' } })
  const calls = { draft: [], submit: [] }
  const entered = createDeferred(), release = createDeferred()
  let snapshot = { runId: 'run-a', revision: 1, status: 'waiting-user', outcome: 'blocked', error: '',
    questionnaire: { version: 2, questions: [{ nodeId: 'rights', questionId: 'tenure' },
      { nodeId: 'elements', questionId: 'foreign-question' }], notes: [{ nodeId: 'elements', noteId: 'foreign-note' }] } }
  const service = {
    start: async () => ({ ok: true, snapshot }), get: async () => snapshot,
    saveDraft: async (input) => { calls.draft.push(input); snapshot = { ...snapshot, questionnaire: { ...snapshot.questionnaire,
      version: snapshot.questionnaire.version + 1 } }; return { ok: true, snapshot } },
    submitQuestions: async (input) => { calls.submit.push(input); snapshot = { ...snapshot, status: 'running' };
      entered.resolve(); await release.promise; snapshot = { ...snapshot, status: 'waiting-user' }; return { ok: true, snapshot } },
    dispose() {},
  }
  const runtime = createValuationWorkflowRuntime({ scopes, createRunner: async () => ({ service,
    startInput: async () => ({ runId: 'run-a' }) }) })
  const exec = { token: Symbol('actual'), rootCallId: 'root', agent: { id: 'parent-a', session: { id: 'parent-a' } },
    signal: new AbortController().signal }
  await runtime.execute(runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' }).commandId, exec)
  return { runtime, scopes, calls, entered, release, exec, service }
}

test('drafts save directly with ownership and independent questionnaire version checks', async (t) => {
  const f = await fixture(); t.after(() => f.runtime.dispose())
  for (const patch of [{ expectedRevision: 0 }, { expectedQuestionVersion: 1 }, { nodeId: 'foreign' },
    { answers: { 'foreign-question': { value: 'x' } } }, { noteEdits: { 'foreign-note': 'x' } }, { command: 'escape' }]) {
    assert.equal((await f.runtime.saveDraft('project-a', edit(patch))).ok, false, JSON.stringify(patch))
  }
  assert.equal(f.calls.draft.length, 0)
  const saved = await f.runtime.saveDraft('project-a', edit())
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.snapshot.questionnaire.version, 3)
  assert.equal(f.calls.draft.length, 1)
  assert.equal(f.calls.draft[0].runId, 'run-a')
  assert.equal(f.calls.submit.length, 0)
  f.scopes.close('project-a')
  assert.equal((await f.runtime.saveDraft('project-a', edit({ expectedQuestionVersion: 3 }))).ok, false)
})

test('formal submissions use one genuine parent execution, reject active submits and allow active drafts', async (t) => {
  const f = await fixture(); t.after(() => { f.release.resolve(); f.runtime.dispose() })
  const input = { action: 'questions-submit', payload: { ...edit(), submissionId: 'submit-a' } }
  const queued = f.runtime.queue('project-a', input)
  assert.equal(queued.ok, true, queued.error)
  assert.equal(f.calls.submit.length, 0)
  assert.equal(f.runtime.queue('project-a', input).commandId, queued.commandId)
  assert.equal((await f.runtime.execute(queued.commandId, { ...f.exec, agent: { id: 'foreign' } })).ok, false)
  const driving = f.runtime.execute(queued.commandId, f.exec)
  await f.entered.promise
  assert.equal(f.runtime.queue('project-a', { ...input, payload: { ...input.payload, submissionId: 'submit-b' } }).ok, false)
  assert.equal((await f.runtime.saveDraft('project-a', edit({ supplement: 'execution-time edit' }))).ok, true)
  f.release.resolve(); assert.equal((await driving).ok, true)
  assert.equal(f.calls.submit.length, 1)
})

test('an identical completed submission remains idempotent after a newer draft version', async (t) => {
  const f = await fixture(); t.after(() => f.runtime.dispose())
  const input = { action: 'questions-submit', payload: { ...edit(), submissionId: 'submit-a' } }
  const queued = f.runtime.queue('project-a', input)
  f.release.resolve(); assert.equal((await f.runtime.execute(queued.commandId, f.exec)).ok, true)
  assert.equal((await f.runtime.saveDraft('project-a', edit())).ok, true)
  assert.equal(f.runtime.queue('project-a', input).commandId, queued.commandId)
  assert.equal(f.runtime.queue('project-a', { ...input, payload: { ...input.payload, supplement: 'changed' } }).ok, false)
  assert.equal(f.calls.submit.length, 1)
})

test('a draft rechecks its live scope after the asynchronous current snapshot read', async (t) => {
  const f = await fixture(); t.after(() => f.runtime.dispose())
  const entered = createDeferred(), release = createDeferred()
  const original = f.service.get
  f.service.get = async (...args) => { entered.resolve(); await release.promise; return await original(...args) }
  const saving = f.runtime.saveDraft('project-a', edit())
  await entered.promise; f.scopes.close('project-a'); release.resolve()
  assert.equal((await saving).ok, false)
  assert.equal(f.calls.draft.length, 0)
})
