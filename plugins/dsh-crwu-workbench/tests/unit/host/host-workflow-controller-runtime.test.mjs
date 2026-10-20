import assert from 'node:assert/strict'
import test from 'node:test'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { createDeferred, createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

const load = () => import('../../../src/host/integrations/valuation-workflow/runtime.ts')
async function fixture(options = {}) {
  const { createValuationWorkflowRuntime } = await load()
  const scopes = new ValuationScopes()
  const scope = { valuationId: 'project-a', projectId: 'project-a', sessionId: 'parent-a', parentSessionId: 'parent-a',
    casePath: '/workspace/project-a', workspaceId: 'workspace-a', workspacePath: '/workspace', openedAt: 1,
    snapshot: { valuationId: 'project-a', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'frozen', files: [], frozenAt: '2026-10-17' } }
  scopes.open(scope)
  const calls = []
  const { ports } = createFixturePorts(options)
  const { createValuationWorkflowService } = await loadWorkflowService()
  const runtime = createValuationWorkflowRuntime({ scopes, createRunner: async (input) => {
    calls.push(input)
    return { service: createValuationWorkflowService(ports), startInput: options.prepare ?? (async () => createStartInput({ runId: 'project-a' })) }
  } })
  const exec = { agent: { id: 'parent-a', session: { id: 'parent-a' } }, signal: new AbortController().signal }
  return { runtime, calls, scopes, exec }
}

test('preparation can be cancelled before the first snapshot and releases only after the command settles', async () => {
  const entered = createDeferred()
  let executionSignal
  const f = await fixture({ prepare: async () => {
    executionSignal = f.calls[0].getExecution().signal
    entered.resolve()
    await new Promise((resolve) => {
      if (executionSignal.aborted) resolve()
      else executionSignal.addEventListener('abort', resolve, { once: true })
    })
    throw Object.assign(new Error('用户取消准备'), { errorKind: 'cancelled' })
  } })
  const registered = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const driving = f.runtime.execute(registered.commandId, f.exec)
  await entered.promise
  const stopped = await f.runtime.cancel('project-a')
  if (!stopped.ok) {
    // The old implementation has no owned abort signal; leave no hanging test job.
    f.runtime.dispose()
    assert.equal(stopped.ok, true, stopped.error)
    return
  }
  assert.equal(executionSignal.aborted, true)
  await driving
  assert.equal(f.runtime.release('project-a').ok, true)
  f.runtime.dispose()
})

test('cancelling a queued start prevents its old command from starting a replacement run', async () => {
  const f = await fixture()
  const registered = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const stopped = await f.runtime.cancel('project-a')
  assert.equal(stopped.ok, true, stopped.error)
  const result = await f.runtime.execute(registered.commandId, f.exec)
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.runtime.release('project-a').ok, true)
  f.runtime.dispose()
})

test('a scoped parent consumes a Host-minted start command once and exposes real progress', async () => {
  const f = await fixture()
  const registered = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  assert.equal(registered.ok, true)
  assert.ok(registered.commandId)
  assert.equal((await f.runtime.status('project-a')).phase, 'awaiting-agent')
  const first = await f.runtime.execute(registered.commandId, f.exec)
  assert.equal(first.ok, true)
  assert.equal(first.snapshot.outcome, 'partial')
  assert.equal(f.calls.length, 1)
  const same = await f.runtime.execute(registered.commandId, f.exec)
  assert.deepEqual(same, first)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.runtime.status('project-a')).snapshot.result.useLabel, '公寓')
  f.runtime.dispose()
})

test('foreign or closed scopes cannot construct a runner or consume pending commands', async () => {
  const f = await fixture()
  assert.equal(f.runtime.register({ projectId: 'project-a', parentSessionId: 'foreign' }).ok, false)
  const good = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  assert.equal((await f.runtime.execute(good.commandId, { ...f.exec, agent: { id: 'foreign' } })).ok, false)
  assert.equal(f.calls.length, 0)
  f.scopes.close('project-a')
  assert.equal((await f.runtime.execute(good.commandId, f.exec)).ok, false)
  assert.equal(f.calls.length, 0)
  f.runtime.dispose()
})

test('re-registering the same live project reuses its pending command', async () => {
  const f = await fixture()
  const one = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const two = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  assert.equal(one.commandId, two.commandId)
  assert.equal(f.calls.length, 0)
  f.runtime.dispose()
})

test('a reopened scope cannot replace a still running writer', async () => {
  const started = createDeferred()
  const release = createDeferred()
  const f = await fixture({ gate: async (input) => {
    if (input.stage === 'elements') { started.resolve(); await release.promise }
  } })
  const first = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const drive = f.runtime.execute(first.commandId, f.exec)
  await started.promise
  const original = f.scopes.get('project-a')
  f.scopes.open({ ...original, openedAt: original.openedAt + 1 })
  const replacement = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  release.resolve()
  await drive
  assert.equal(replacement.ok, false, 'changing scope metadata cannot release a live writer')
  assert.equal(f.calls.length, 1)
  f.runtime.dispose()
})


test('unknown visual stop before business start retains occupancy and hides the preparation exception', async () => {
  let attempts = 0
  const f = await fixture({ prepare: async () => {
    attempts += 1
    throw Object.assign(new Error('Bearer synthetic-private-preparation-token'), {
      errorKind: 'stop-unknown', sessionIds: ['actual-visual-child'],
    })
  } })
  const command = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const result = await f.runtime.execute(command.commandId, f.exec)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'stop-unknown')
  assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-private-preparation-token/)
  assert.equal((await f.runtime.status('project-a')).occupied, true)
  assert.equal((await f.runtime.status('project-a')).phase, 'blocked')
  await f.runtime.execute(command.commandId, f.exec)
  assert.equal(attempts, 1)
  const original = f.scopes.get('project-a')
  f.scopes.open({ ...original, openedAt: original.openedAt + 1 })
  assert.equal(f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' }).ok, false)
  f.runtime.dispose()
})


test('only an idle project can release its runtime and other projects stay registered', async () => {
  const entered = createDeferred()
  const release = createDeferred()
  const f = await fixture({ gate: async (input) => {
    if (input.stage === 'elements') { entered.resolve(); await release.promise }
  } })
  assert.equal(typeof f.runtime.release, 'function')
  const a = f.scopes.get('project-a')
  f.scopes.open({ ...a, projectId: 'project-b', valuationId: 'project-b', parentSessionId: 'parent-b', sessionId: 'parent-b', casePath: '/workspace/project-b' })
  const other = f.runtime.register({ projectId: 'project-b', parentSessionId: 'parent-b' })
  assert.equal(other.ok, true)
  const command = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const drive = f.runtime.execute(command.commandId, f.exec)
  await entered.promise
  assert.equal(f.runtime.release('project-a').ok, false)
  release.resolve()
  await drive
  assert.equal(f.runtime.release('project-a').ok, true)
  assert.equal((await f.runtime.status('project-b')).phase, 'awaiting-agent')
  f.runtime.dispose()
})


test('a pending decision reuses its exact submission and remains observable as awaiting-agent', async () => {
  const f = await fixture()
  const start = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const initial = await f.runtime.execute(start.commandId, f.exec)
  const payload = { nodeId: 'rights', expectedRevision: initial.snapshot.revision, submissionId: 'stable-user-decision',
    reason: '核对原文', source: '用户确认', changes: [{ field: 'areaSqm', value: 101 }] }
  const first = f.runtime.queue('project-a', { action: 'revise', payload })
  const repeated = f.runtime.queue('project-a', { action: 'revise', payload })
  assert.equal(first.ok, true, first.error)
  assert.equal(repeated.commandId, first.commandId)
  assert.equal((await f.runtime.status('project-a')).phase, 'awaiting-agent')
  assert.equal(f.runtime.queue('project-a', { action: 'revise', payload: { ...payload,
    changes: [{ field: 'areaSqm', value: 102 }] } }).ok, false)
  f.runtime.dispose()
})
