import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferred } from '../../helpers/valuation-workflow-fixture.mjs'

const current = () => ({ ok: true, empty: false, projectId: 'project-1', runId: 'run-1', phase: 'waiting-user',
  snapshot: { runId: 'run-1', revision: 3, status: 'waiting-user',
    plan: { ready: true, accepted: false, digest: 'sha256:actual-approved-plan', revision: 3 }, clarification: null },
  graph: { nodes: [], edges: [] }, progress: { runId: 'run-1', revision: 3, waiting: true },
})
async function fixture(overrides = {}) {
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  const calls = { current: [], action: [], node: [] }
  const port = {
    current: async (...args) => { calls.current.push(args); return current() },
    node: async (args) => { calls.node.push(args); return { ok: true, detail: { nodeId: args.nodeId, revision: 3 } } },
    action: async (args) => { calls.action.push(args); return { ok: true } },
    ...overrides,
  }
  return { calls, controller: createValuationWorkflowController(port, { autoPoll: false }) }
}

test('opening the workflow reads the current graph without starting or recreating a task', async () => {
  const f = await fixture()
  await f.controller.activate()
  assert.equal(f.calls.current.length, 1)
  assert.equal(f.calls.action.length, 0)
  assert.equal(f.controller.getState().current.projectId, 'project-1')
  await f.controller.selectNode('valuation:realestate:rights')
  assert.equal(f.calls.node[0].nodeId, 'valuation:realestate:rights')
  assert.equal(f.controller.getState().detail.nodeId, 'valuation:realestate:rights')
  f.controller.deactivate()
})

test('clear invalidates old current and node responses and succeeds for a genuinely empty task', async () => {
  const currentWait = createDeferred(), nodeWait = createDeferred()
  let reading = false, cleared = false
  const f = await fixture({
    current: async () => {
      if (reading && !cleared) { await currentWait.promise; return current() }
      return cleared ? { ok: true, empty: true } : current()
    },
    node: async (args) => { await nodeWait.promise; return { ok: true, detail: { nodeId: args.nodeId, revision: 3 } } },
    clear: async () => { cleared = true; return { ok: true, cleared: true } },
  })
  await f.controller.activate()
  reading = true
  const refreshing = f.controller.refresh(), selecting = f.controller.selectNode('old-node')
  assert.equal(await f.controller.clear(), true)
  currentWait.resolve(); nodeWait.resolve()
  await Promise.all([refreshing, selecting])
  assert.equal(f.controller.getState().current.empty, true)
  assert.equal(f.controller.getState().detail, null)
  assert.equal(f.controller.getState().preview, null)
  assert.equal(await f.controller.clear(), true, 'empty task clear must not be rejected for missing local project ID')
  f.controller.dispose()
})

test('a refused clear retains the current run and selected receipt', async () => {
  const f = await fixture({ clear: async () => ({ ok: false, error: '停止尚未确认' }) })
  await f.controller.activate()
  await f.controller.selectNode('rights')
  assert.equal(await f.controller.clear(), false)
  assert.equal(f.controller.getState().current.projectId, 'project-1')
  assert.equal(f.controller.getState().detail.nodeId, 'rights')
  assert.match(f.controller.getState().error, /停止尚未确认/)
  f.controller.dispose()
})

test('plan confirmation sends the exact displayed digest once while an action is pending', async () => {
  const release = createDeferred()
  const calls = []
  const f = await fixture({ action: async (input) => { calls.push(input); await release.promise; return { ok: true } } })
  await f.controller.activate()
  const pending = f.controller.approvePlan()
  await Promise.resolve()
  await f.controller.approvePlan()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'approve-plan')
  assert.equal(calls[0].projectId, 'project-1')
  assert.equal(calls[0].payload.expectedRevision, 3)
  assert.equal(calls[0].payload.planDigest, 'sha256:actual-approved-plan')
  assert.ok(calls[0].payload.submissionId)
  release.resolve()
  await pending
  f.controller.deactivate()
})

test('a late detail response from an old selection cannot replace the current node', async () => {
  const release = createDeferred()
  const f = await fixture({ node: async (args) => {
    if (args.nodeId === 'old-node') await release.promise
    return { ok: true, detail: { nodeId: args.nodeId, revision: 3 } }
  } })
  await f.controller.activate()
  const old = f.controller.selectNode('old-node')
  await f.controller.selectNode('current-node')
  release.resolve()
  await old
  assert.equal(f.controller.getState().detail.nodeId, 'current-node')
  f.controller.deactivate()
})

test('an incomplete Host success is an observable protocol failure, not an empty ready workflow', async () => {
  const f = await fixture({ current: async () => ({ ok: true }) })
  await f.controller.activate()
  assert.ok(f.controller.getState().error)
  assert.equal(f.controller.getState().current, null)
  assert.equal(f.calls.action.length, 0)
  f.controller.deactivate()
})

test('a detail receipt from a different revision cannot be presented as the selected current node', async () => {
  const f = await fixture({ node: async (args) => ({ ok: true, detail: { nodeId: args.nodeId, revision: 2 } }) })
  await f.controller.activate()
  await f.controller.selectNode('valuation:realestate:rights')
  assert.equal(f.controller.getState().detail, null)
  assert.ok(f.controller.getState().error)
  f.controller.deactivate()
})

test('an incomplete action receipt cannot acknowledge the displayed plan', async () => {
  const f = await fixture({ action: async () => ({}) })
  await f.controller.activate()
  assert.equal(await f.controller.approvePlan(), false)
  assert.ok(f.controller.getState().error)
  f.controller.deactivate()
})

test('a refresh to another revision invalidates an in-flight node response', async () => {
  const release = createDeferred()
  let revision = 3
  const f = await fixture({
    current: async () => {
      const value = current()
      value.snapshot.revision = revision
      value.progress.revision = revision
      return value
    },
    node: async (args) => {
      await release.promise
      return { ok: true, detail: { nodeId: args.nodeId, revision: 3 } }
    },
  })
  await f.controller.activate()
  const pending = f.controller.selectNode('valuation:realestate:rights')
  revision = 4
  await f.controller.refresh()
  release.resolve()
  await pending
  assert.equal(f.controller.getState().detail, null)
  f.controller.deactivate()
})

test('a real parent awaiting the first business snapshot remains visible without starting another task', async () => {
  const pending = { ok: true, empty: false, projectId: 'project-1', parentSessionId: 'parent-1', runId: 'run-1',
    phase: 'preparing', snapshot: null, progress: null, error: '' }
  const f = await fixture({ current: async () => pending })
  await f.controller.activate()
  assert.equal(f.controller.getState().error, '')
  assert.equal(f.controller.getState().current.parentSessionId, 'parent-1')
  assert.equal(f.calls.action.length, 0)
  await f.controller.selectNode('valuation:realestate:elements')
  assert.equal(f.calls.node.length, 0, 'a node cannot be inspected before its revision exists')
  f.controller.deactivate()
})

test('the active page polls preparation until an actual business snapshot arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let reads = 0
  let actions = 0
  const controller = createValuationWorkflowController({
    current: async () => ++reads === 1
      ? { ok: true, empty: false, projectId: 'project-1', parentSessionId: 'parent-1', runId: 'run-1',
          phase: 'preparing', snapshot: null, progress: null, error: '' }
      : current(),
    node: async () => ({ ok: false }),
    action: async () => { actions += 1; return { ok: true } },
  }, { pollIntervalMs: 40 })
  t.after(() => controller.dispose())
  await controller.activate()
  t.mock.timers.tick(40)
  await new Promise(setImmediate)
  assert.equal(reads, 2)
  assert.equal(controller.getState().current.snapshot.revision, 3)
  assert.equal(actions, 0)
})

test('re-entering valuation hides the previous workspace projection until the fresh current read arrives', async () => {
  const release = createDeferred()
  let reads = 0
  const f = await fixture({ current: async () => ++reads === 1 ? current() : release.promise })
  await f.controller.activate()
  f.controller.deactivate()
  const pending = f.controller.activate()
  assert.equal(f.controller.getState().current, null)
  assert.equal(f.controller.getState().detail, null)
  release.resolve({ ok: true, empty: true })
  await pending
  assert.equal(f.controller.getState().current.empty, true)
  f.controller.deactivate()
})

test('a preparation failure retains the known parent and permits reconciliation without inventing a snapshot', async () => {
  const calls = []
  const f = await fixture({ current: async () => ({ ok: true, empty: false, projectId: 'project-1',
    parentSessionId: 'actual-parent', runId: 'project-1', phase: 'blocked', snapshot: null, progress: null,
    errorKind: 'stop-unknown', error: '资料判读会话停止状态待核对' }),
    reconcile: async (input) => { calls.push(input); return { ok: true } } })
  await f.controller.activate()
  assert.equal(f.controller.getState().current?.parentSessionId, 'actual-parent')
  assert.equal(f.controller.getState().current.snapshot, null)
  await f.controller.reconcile()
  assert.deepEqual(calls, [{ projectId: 'project-1' }])
  f.controller.deactivate()
})

test('a stale displayed plan cannot silently approve the newer plan held by the controller', async () => {
  const f = await fixture()
  await f.controller.activate()
  const result = await f.controller.approvePlan({ expectedRevision: 2, planDigest: 'sha256:previous-displayed-plan' })
  assert.equal(result, false)
  assert.equal(f.calls.action.length, 0)
  f.controller.deactivate()
})

test('an explicitly queued native command keeps polling even while the previous snapshot was waiting for approval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { createValuationWorkflowController } = await import('../../../src/client/modules/report-evaluation/workflow-controller.ts')
  let reads = 0
  const controller = createValuationWorkflowController({
    current: async () => { reads += 1; return { ...current(), phase: reads === 1 ? 'awaiting-agent' : 'running' } },
    node: async () => ({ ok: false }), action: async () => ({ ok: true }),
  }, { pollIntervalMs: 40 })
  t.after(() => controller.dispose())
  await controller.activate()
  t.mock.timers.tick(40)
  await new Promise(setImmediate)
  assert.equal(reads, 2)
})


test('an accepted decision still awaiting DSH cannot be submitted again against the previous plan', async () => {
  let queued = false
  const calls = []
  const f = await fixture({ current: async () => queued ? { ...current(), phase: 'awaiting-agent' } : current(),
    action: async (input) => { calls.push(input); queued = true; return { ok: true } } })
  await f.controller.activate()
  assert.equal(await f.controller.approvePlan(), true)
  assert.equal(await f.controller.approvePlan(), false)
  assert.equal(calls.length, 1)
  f.controller.deactivate()
})

test('an incomplete pre-business failure needs an explicit safe failure receipt', async () => {
  const f = await fixture({ current: async () => ({ ok: true, empty: false, projectId: 'project-1',
    parentSessionId: 'actual-parent', runId: 'project-1', phase: 'failed', snapshot: null, progress: null,
    errorKind: '', error: '' }) })
  await f.controller.activate()
  assert.equal(f.controller.getState().current, null)
  assert.ok(f.controller.getState().error)
  f.controller.deactivate()
})

test('correcting an invalid clarification answer can submit again while identical retries stay idempotent', async () => {
  const submitted = new Map()
  const received = []
  const f = await fixture({ action: async (input) => {
    const { submissionId, ...payload } = input.payload
    const canonical = JSON.stringify(payload)
    const before = submitted.get(submissionId)
    if (before !== undefined && before !== canonical) return { ok: false, error: 'submission conflict' }
    submitted.set(submissionId, canonical)
    received.push(input.payload)
    return payload.answers.areaSqm === '86.4' ? { ok: true } : { ok: false, error: 'invalid area' }
  } })
  await f.controller.activate()
  const base = { clarificationId: 'synthetic-clarification', expectedRevision: 3 }
  assert.equal(await f.controller.answer({ ...base, answers: { useLabel: '公寓', areaSqm: 'invalid' } }), false)
  assert.equal(await f.controller.answer({ ...base, answers: { useLabel: '公寓', areaSqm: '86.4' } }), true)
  assert.equal(await f.controller.answer({ ...base, answers: { areaSqm: '86.4', useLabel: '公寓' } }), true)
  assert.notEqual(received[0].submissionId, received[1].submissionId)
  assert.equal(received[1].submissionId, received[2].submissionId)
  f.controller.deactivate()
})

test('a changed snapshot refreshes selected node errors even when its run and revision are unchanged', async () => {
  let progressed = false
  const f = await fixture({
    current: async () => {
      const value = current()
      value.snapshot.updatedAt = progressed ? '2026-10-19T08:00:01Z' : '2026-10-19T08:00:00Z'
      return value
    },
    node: async (args) => ({ ok: true, detail: { nodeId: args.nodeId, revision: 3,
      gaps: progressed ? [] : ['synthetic previous binding error'] } }),
  })
  await f.controller.activate()
  await f.controller.selectNode('valuation:realestate:elements')
  assert.deepEqual(f.controller.getState().detail.gaps, ['synthetic previous binding error'])
  progressed = true
  await f.controller.refresh()
  assert.equal(f.controller.getState().detail.nodeId, 'valuation:realestate:elements')
  assert.deepEqual(f.controller.getState().detail.gaps, [])
  f.controller.deactivate()
})
