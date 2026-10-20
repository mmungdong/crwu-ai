import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph'

const load = () => import('../../../src/host/core/workflow-store/store.ts')
const current = (patch = {}) => ({
  workspaceId: 'workspace-a', stepId: 'valuation', runId: 'run-a', graphId: 'valuation.realestate', graphVersion: '1',
  revision: 1, status: 'waiting-user', state: { object: { useLabel: '公寓', areaSqm: 86.4 }, nodes: {}, acceptedPlan: null },
  files: [], ...patch,
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crwu-graph-db-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '.crwu', 'workflows.sqlite')
  let granted = true
  const authorize = () => ({ ok: granted, error: granted ? '' : '测试授权已撤销' })
  const { openWorkflowStore } = await load()
  const store = await openWorkflowStore({ path, authorize })
  t.after(() => store.close())
  return { root, path, store, authorize, revoke: () => { granted = false }, openWorkflowStore }
}

test('SQLite reopens one current task per workspace and step without losing field provenance', async (t) => {
  const f = await fixture(t)
  const original = current({ state: { object: { useLabel: '公寓' }, nodes: { rights: { source: 'material', quote: '规划用途：公寓', sessionId: 'actual-child' } } } })
  await f.store.saveCurrent(original)
  await f.store.saveCurrent(current({ stepId: 'another-step', runId: 'run-b' }))
  await f.store.close()
  const reopened = await f.openWorkflowStore({ path: f.path, authorize: f.authorize })
  t.after(() => reopened.close())
  assert.deepEqual(await reopened.getCurrent('workspace-a', 'valuation'), original)
  assert.equal((await reopened.getCurrent('workspace-a', 'another-step')).runId, 'run-b')
  assert.equal(await reopened.getCurrent('workspace-other', 'valuation'), null)
  const bytes = await stat(f.path)
  assert.ok(bytes.size > 0)
})

test('exports load as checked graph data and conditional clear cannot remove another task', async (t) => {
  const f = await fixture(t)
  const record = current()
  await f.store.saveCurrent(record)
  const exported = await f.store.exportCurrent('workspace-a', 'valuation')
  assert.equal(typeof exported, 'string')
  assert.equal(JSON.parse(exported).format, 'crwu.workflow.bundle.v1')
  assert.equal(await f.store.clearCurrent('workspace-a', 'valuation', 'foreign-run'), false)
  assert.deepEqual(await f.store.getCurrent('workspace-a', 'valuation'), record)
  assert.equal(await f.store.clearCurrent('workspace-a', 'valuation', 'run-a'), true)
  assert.equal(await f.store.getCurrent('workspace-a', 'valuation'), null)
  await f.store.importCurrent(exported, { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: '1' })
  assert.deepEqual(await f.store.getCurrent('workspace-a', 'valuation'), record)
  for (const invalid of ['{}', '{invalid', JSON.stringify({ ...JSON.parse(exported), format: 'unsupported' })]) {
    await assert.rejects(() => f.store.importCurrent(invalid, { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: '1' }))
    assert.deepEqual(await f.store.getCurrent('workspace-a', 'valuation'), record)
  }
  await assert.rejects(() => f.store.importCurrent(exported, { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: 'other' }))
})

test('revoked authorization stops reads and writes on an already open store', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current())
  f.revoke()
  await assert.rejects(() => f.store.getCurrent('workspace-a', 'valuation'))
  await assert.rejects(() => f.store.saveCurrent(current({ revision: 2 })))
  await assert.rejects(() => f.store.exportCurrent('workspace-a', 'valuation'))
})

test('a real LangGraph resumes from SQLite after process-lifetime close without rerunning completed work', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current({ status: 'running' }))
  let fetched = 0
  const State = Annotation.Root({ value: Annotation(), accepted: Annotation() })
  const build = (checkpointer) => new StateGraph(State)
    .addNode('fetch', async () => ({ value: ++fetched }))
    .addNode('confirm', () => ({ accepted: interrupt({ question: '确认本次方案' }) }))
    .addEdge(START, 'fetch').addEdge('fetch', 'confirm').addEdge('confirm', END).compile({ checkpointer })
  const config = { configurable: { thread_id: 'run-a' } }
  await build(f.store.checkpointer).invoke({ value: 0, accepted: false }, config)
  assert.equal(fetched, 1)
  await f.store.close()
  const reopened = await f.openWorkflowStore({ path: f.path, authorize: f.authorize })
  t.after(() => reopened.close())
  const graph = build(reopened.checkpointer)
  const state = await graph.getState(config)
  assert.equal(state.values.value, 1)
  assert.ok(state.next.includes('confirm'))
  const result = await graph.invoke(new Command({ resume: true }), config)
  assert.equal(result.accepted, true)
  assert.equal(result.value, 1)
  assert.equal(fetched, 1)
})

test('nested compiled graph checkpoints retain their namespaces on reload', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current({ status: 'running' }))
  const State = Annotation.Root({ value: Annotation() })
  const child = new StateGraph(State).addNode('leaf', () => ({ value: interrupt('继续节点') }))
    .addEdge(START, 'leaf').addEdge('leaf', END).compile()
  const root = new StateGraph(State).addNode('realestate', child).addEdge(START, 'realestate').addEdge('realestate', END)
    .compile({ checkpointer: f.store.checkpointer })
  const config = { configurable: { thread_id: 'run-a' } }
  await root.invoke({ value: 0 }, config)
  const tuples = []
  for await (const tuple of f.store.checkpointer.list(config)) tuples.push(tuple)
  assert.ok(tuples.some((tuple) => String(tuple.config.configurable.checkpoint_ns).includes('realestate')))
  assert.ok(tuples.some((tuple) => tuple.config.configurable.checkpoint_ns === ''))
})

test('export and import preserve the actual interrupt checkpoint, not just the displayed task', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current())
  let reads = 0
  const State = Annotation.Root({ value: Annotation(), accepted: Annotation() })
  const build = () => new StateGraph(State)
    .addNode('read', () => ({ value: ++reads }))
    .addNode('confirm', () => ({ accepted: interrupt('确认方案') }))
    .addEdge(START, 'read').addEdge('read', 'confirm').addEdge('confirm', END)
    .compile({ checkpointer: f.store.checkpointer })
  const config = { configurable: { thread_id: 'run-a' } }
  await build().invoke({ value: 0, accepted: false }, config)
  const exported = await f.store.exportCurrent('workspace-a', 'valuation')
  await f.store.clearCurrent('workspace-a', 'valuation', 'run-a')
  await f.store.importCurrent(exported, { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: '1' })
  const result = await build().invoke(new Command({ resume: true }), config)
  assert.equal(result.accepted, true)
  assert.equal(result.value, 1)
  assert.equal(reads, 1)
})

test('stale revisions and replacement of an active task cannot discard current state', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current({ revision: 2, status: 'running' }))
  await assert.rejects(() => f.store.saveCurrent(current({ revision: 1 })))
  await assert.rejects(() => f.store.saveCurrent(current({ revision: 3 }), 1))
  await assert.rejects(() => f.store.saveCurrent(current({ runId: 'replacement' })))
  await assert.rejects(() => f.store.clearCurrent('workspace-a', 'valuation', 'run-a'))
  assert.equal((await f.store.getCurrent('workspace-a', 'valuation')).revision, 2)
})

test('JSON-safe shared references are copied rather than mistaken for cycles', async (t) => {
  const f = await fixture(t)
  const fact = { quote: '规划用途：公寓' }
  await f.store.saveCurrent(current({ state: { fact, nodes: { rights: { fact } } } }))
  const saved = await f.store.getCurrent('workspace-a', 'valuation')
  assert.deepEqual(saved.state.fact, saved.state.nodes.rights.fact)
})

test('import cannot replace a live or unreconciled task', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current())
  const exported = await f.store.exportCurrent('workspace-a', 'valuation')
  for (const patch of [{ status: 'running' }, { status: 'failed', state: { stopUnknown: true, sessionId: 'actual-live-child' } }]) {
    await f.store.saveCurrent(current({ revision: 2, ...patch }))
    await assert.rejects(() => f.store.importCurrent(exported, { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: '1' }))
    assert.equal((await f.store.getCurrent('workspace-a', 'valuation')).revision, 2)
    await assert.rejects(() => f.store.clearCurrent('workspace-a', 'valuation', 'run-a'))
  }
})

test('a run ID cannot alias another workspace or step checkpoint owner', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current())
  await assert.rejects(() => f.store.saveCurrent(current({ workspaceId: 'foreign-workspace' })))
  await assert.rejects(() => f.store.saveCurrent(current({ stepId: 'foreign-step' })))
  assert.equal(await f.store.getCurrent('foreign-workspace', 'valuation'), null)
})

test('a closed child receipt does not occupy a completed task, while an unresolved stop does', async (t) => {
  const f = await fixture(t)
  for (const status of ['completed', 'failed']) {
    await f.store.saveCurrent(current({ status, state: { sessionId: 'actual-closed-child', stopUnknown: null } }))
    const exported = await f.store.exportCurrent('workspace-a', 'valuation')
    await f.store.importCurrent(exported, { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: '1' })
    assert.equal(await f.store.clearCurrent('workspace-a', 'valuation', 'run-a'), true)
  }
  await f.store.saveCurrent(current({ status: 'failed', state: { stopUnknown: { sessionId: 'actual-unresolved-child' } } }))
  await assert.rejects(() => f.store.clearCurrent('workspace-a', 'valuation', 'run-a'))
})

test('import validates decoded checkpoint payloads and duplicate tuples before replacing anything', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current())
  const State = Annotation.Root({ value: Annotation() })
  const graph = new StateGraph(State).addNode('pause', () => ({ value: interrupt('确认') }))
    .addEdge(START, 'pause').addEdge('pause', END).compile({ checkpointer: f.store.checkpointer })
  await graph.invoke({ value: 1 }, { configurable: { thread_id: 'run-a' } })
  const bundle = JSON.parse(await f.store.exportCurrent('workspace-a', 'valuation'))
  const identity = { workspaceId: 'workspace-a', stepId: 'valuation', graphId: 'valuation.realestate', graphVersion: '1' }
  const encode = (value) => Buffer.from(value).toString('base64')
  const mutations = [
    (b) => { b.checkpoints[0].checkpointBytes = encode('{invalid') },
    (b) => { b.checkpoints[0].checkpointType = 'unsupported' },
    (b) => { b.checkpoints[0].checkpointBytes = encode('{}') },
    (b) => { b.checkpoints[0].metadataBytes = encode('{"__proto__":{"test":true}}') },
    (b) => { b.checkpoints[0].checkpointBytes = encode('{"lc":1,"type":"constructor","id":["inert-test"]}') },
    (b) => { b.checkpoints.push(structuredClone(b.checkpoints[0])) },
    (b) => { b.checkpoints[0].checkpointId = 'mismatched-payload-id' },
  ]
  for (const mutate of mutations) {
    const invalid = structuredClone(bundle)
    mutate(invalid)
    await assert.rejects(() => f.store.importCurrent(JSON.stringify(invalid), identity))
    assert.deepEqual(await f.store.getCurrent('workspace-a', 'valuation'), current())
    assert.equal(await f.store.exportCurrent('workspace-a', 'valuation'), JSON.stringify(bundle))
  }
})

test('checkpoint list rechecks authorization when the iterator is advanced', async (t) => {
  const f = await fixture(t)
  await f.store.saveCurrent(current())
  const State = Annotation.Root({ value: Annotation() })
  const graph = new StateGraph(State).addNode('work', () => ({ value: 1 }))
    .addEdge(START, 'work').addEdge('work', END).compile({ checkpointer: f.store.checkpointer })
  await graph.invoke({ value: 0 }, { configurable: { thread_id: 'run-a' } })
  const iterator = f.store.checkpointer.list({ configurable: { thread_id: 'run-a' } })
  await iterator.next()
  f.revoke()
  await assert.rejects(() => iterator.next())
})
