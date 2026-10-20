import assert from 'node:assert/strict'
import test from 'node:test'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

async function fixture(options = {}) {
  const { createValuationWorkflowRuntime } = await import('../../../src/host/integrations/valuation-workflow/runtime.ts')
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'project-a', projectId: 'project-a', sessionId: 'parent-a', parentSessionId: 'parent-a',
    casePath: '/workspace/project-a', workspaceId: 'workspace-a', workspacePath: '/workspace', openedAt: 1,
    snapshot: { valuationId: 'project-a', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'frozen', files: [], frozenAt: '2026-10-17' } })
  const f = createFixturePorts()
  f.ports.planning = { prepare: async () => ({ ok: true, plan: {
    method: 'market', valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean',
    sources: [{ providerId: 'fixture', state: 'verified', community: '合成小区', detailUrl: 'https://example.invalid/1',
      fields: { unitPrice: 32000, areaSqm: 100 }, transactionType: 'listing', evidence: '合成测试' }],
    template: { fileName: '测试.xlsx', relativePath: '模板/测试.xlsx', digest: 'sha256:test', verified: true,
      mapping: [{ field: 'unitPrice', sheet: '计算', range: 'B2' }], formulaChecks: [{ name: '合成检查', ok: true }] },
    basis: [{ sourceId: 'synthetic-reference-policy', quote: '合成参考口径：原始挂牌单价算术平均，不修正、不折扣。' }], limitations: [],
  } }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const calls = { runner: 0, prepare: 0 }
  const runtime = createValuationWorkflowRuntime({ scopes, verifyStopped: options.verifyStopped, createRunner: async () => {
    calls.runner++
    return { service: Object.assign(createValuationWorkflowService(f.ports), options.exportRunNull ? { exportRun: async () => null } : {}), startInput: async () => {
      calls.prepare++
      return createStartInput({ runId: 'run-a' })
    } }
  } })
  const exec = { agent: { id: 'parent-a', session: { id: 'parent-a' } }, signal: new AbortController().signal }
  return { ...f, businessCalls: f.calls, calls, scopes, runtime, exec, createValuationWorkflowService }
}

async function saved() {
  const f = await fixture()
  const service = f.createValuationWorkflowService(f.ports)
  const started = await service.start(createStartInput({ runId: 'run-a' }))
  const run = JSON.parse(JSON.stringify(await service.exportRun('run-a')))
  service.dispose()
  f.runtime.dispose()
  return { run, started }
}

test('a stopped intent-only failure retries through an opaque command without preparing the PDF again', async () => {
  const f = await fixture()
  f.ports.intent = { infer: async () => ({ ok: false, errorKind: 'blocked', error: '合成对象范围未确认', sessionId: 'old-intent' }) }
  const service = f.createValuationWorkflowService(f.ports)
  await service.start(createStartInput({ runId: 'run-a' }))
  const run = await service.exportRun('run-a')
  service.dispose()
  let intents = 0
  f.ports.intent.infer = async () => { intents += 1; return { ok: true, sessionId: 'retry-native-intent', intent: {
    business: 'valuation', assetType: 'realestate', status: 'needs-clarification', objects: [], evidence: [], questions: ['请选择合成对象'],
  } } }
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  const command = f.runtime.queue('project-a', { action: 'retry-intent', payload: { expectedRevision: 1, submissionId: 'retry-router' } })
  assert.equal(command.ok, true, command.error)
  const duplicate = f.runtime.queue('project-a', { action: 'retry-intent', payload: { expectedRevision: 1, submissionId: 'another-reconcile-click' } })
  assert.equal(duplicate.commandId, command.commandId, 'concurrent recovery clicks must reuse the pending command')
  assert.equal(f.runtime.queue('project-a', { action: 'retry-intent', payload: { expectedRevision: 1, submissionId: 'bad-extra', materials: [] } }).ok, false)
  const result = await f.runtime.execute(command.commandId, f.exec)
  assert.equal(result.snapshot.status, 'waiting-user')
  assert.equal(result.snapshot.routing.intentSessionId, 'retry-native-intent')
  assert.equal(intents, 1)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.businessCalls.inference.length, 0)
  assert.equal((await f.runtime.execute(command.commandId, f.exec)).snapshot.status, 'waiting-user')
  assert.equal(intents, 1)
  f.runtime.dispose()
})

test('a restored runtime approves its saved plan without preparing files or restarting the graph', async () => {
  const { run, started } = await saved()
  const f = await fixture()
  assert.equal(typeof f.runtime.restore, 'function')
  const restored = await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })
  assert.equal(restored.ok, true, restored.error)
  const status = await f.runtime.status('project-a')
  assert.equal(status.phase, 'waiting-user')
  assert.equal(status.snapshot.plan.digest, started.snapshot.plan.digest)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.businessCalls.inference.length, 0)
  const command = f.runtime.queue('project-a', { action: 'approve-plan', payload: {
    expectedRevision: 1, planDigest: started.snapshot.plan.digest, submissionId: 'approve-after-restart',
  } })
  assert.equal(command.ok, true, command.error)
  const executed = await f.runtime.execute(command.commandId, f.exec)
  assert.equal(executed.ok, true, executed.error)
  assert.equal(executed.snapshot.outcome, 'partial')
  assert.equal(f.calls.prepare, 0)
  assert.ok(f.businessCalls.inference.every((request) => !['elements', 'rights', 'plan'].includes(request.stage)))
  assert.equal(f.businessCalls.calculator.length, 1)
  f.runtime.dispose()
})

test('restoration rejects foreign callers, malformed state and occupied replacement atomically', async () => {
  const { run } = await saved()
  const f = await fixture()
  assert.equal(typeof f.runtime.restore, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'foreign', run })).ok, false)
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run: {} })).ok, false)
  assert.equal(f.calls.prepare, 0)
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, false)
  assert.equal((await f.runtime.status('project-a')).snapshot.plan.digest, run.plan.digest)
  f.runtime.dispose()
})

test('restored active child identity remains occupied and cannot accept another command', async () => {
  const { run } = await saved()
  run.active = true
  run.status = 'running'
  run.stages.plan.state = 'running'
  run.stages.plan.sessionId = 'actual-running-child'
  const f = await fixture()
  assert.equal(typeof f.runtime.restore, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  const status = await f.runtime.status('project-a')
  assert.equal(status.occupied, true)
  assert.equal(status.snapshot.stages.plan.sessionId, 'actual-running-child')
  assert.equal(f.runtime.queue('project-a', { action: 'approve-plan', payload: {
    expectedRevision: 1, planDigest: run.plan.digest, submissionId: 'unsafe-repeat',
  } }).ok, false)
  assert.equal(f.businessCalls.inference.length, 0)
  f.runtime.dispose()
})

test('concurrent restore requests cannot publish two runners for one current project', async () => {
  const { run } = await saved()
  const f = await fixture()
  assert.equal(typeof f.runtime.restore, 'function')
  const input = { projectId: 'project-a', parentSessionId: 'parent-a', run }
  const results = await Promise.all([f.runtime.restore(input), f.runtime.restore(input)])
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal((await f.runtime.status('project-a')).snapshot.plan.digest, run.plan.digest)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.businessCalls.inference.length, 0)
  f.runtime.dispose()
})

test('a scope closed while its runner is hydrating cannot be published by restore', async () => {
  const { run } = await saved()
  const f = await fixture()
  assert.equal(typeof f.runtime.restore, 'function')
  const pending = f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })
  f.scopes.close('project-a')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.businessCalls.inference.length, 0)
  f.runtime.dispose()
})


test('a missing exported image cannot erase an already verified unknown child stop', async () => {
  const { run } = await saved()
  run.active = true
  run.status = 'running'
  run.stages.plan.state = 'running'
  run.stages.plan.sessionId = 'actual-running-child'
  const f = await fixture({ exportRunNull: true })
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  assert.equal((await f.runtime.status('project-a')).occupied, true)
  f.runtime.dispose()
})

test('releasing an idle current task invalidates its commands and permits loading it again', async () => {
  const { run } = await saved()
  const f = await fixture()
  assert.equal(typeof f.runtime.release, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  const command = f.runtime.queue('project-a', { action: 'approve-plan', payload: {
    expectedRevision: 1, planDigest: run.plan.digest, submissionId: 'released-old-command',
  } })
  assert.equal(command.ok, true)
  assert.equal(f.runtime.release('project-a').ok, true)
  assert.equal((await f.runtime.execute(command.commandId, f.exec)).ok, false)
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.businessCalls.inference.length, 0)
  f.runtime.dispose()
})

test('an unknown stopped child cannot be released to replace the current task', async () => {
  const { run } = await saved()
  run.active = true
  run.status = 'running'
  run.stages.plan.state = 'running'
  run.stages.plan.sessionId = 'actual-running-child'
  const f = await fixture()
  assert.equal(typeof f.runtime.release, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  assert.equal(f.runtime.release('project-a').ok, false)
  assert.equal((await f.runtime.status('project-a')).occupied, true)
  f.runtime.dispose()
})

test('only the Host verifier can retire an occupied controller after persisting a stopped state', async () => {
  const { run } = await saved()
  run.active = true
  run.status = 'running'
  run.stages.plan.state = 'running'
  run.stages.plan.sessionId = 'actual-running-child'
  let proven = false
  const verified = []
  const f = await fixture({ verifyStopped: async (identity) => { verified.push(identity); return { ok: proven } } })
  assert.equal(typeof f.runtime.reconcile, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  assert.equal((await f.runtime.reconcile('project-a')).ok, false)
  assert.equal((await f.runtime.status('project-a')).occupied, true)
  proven = true
  assert.equal((await f.runtime.reconcile('project-a')).ok, true)
  assert.equal((await f.runtime.status('project-a')).occupied, false)
  assert.equal(verified.length, 2)
  assert.deepEqual(verified[0], { projectId: 'project-a', parentSessionId: 'parent-a' })
  assert.equal(f.businessCalls.inference.length, 0)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' }).ok, true)
  f.runtime.dispose()
})

test('an occupied controller without a Host verifier stays occupied after reconciliation', async () => {
  const { run } = await saved()
  run.active = true
  run.status = 'running'
  run.stages.plan.state = 'running'
  run.stages.plan.sessionId = 'actual-running-child'
  const f = await fixture()
  assert.equal(typeof f.runtime.reconcile, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  assert.equal((await f.runtime.reconcile('project-a')).ok, false)
  assert.equal((await f.runtime.status('project-a')).occupied, true)
  f.runtime.dispose()
})

test('a late quiescence proof cannot release a project whose scope changed while awaiting proof', async () => {
  const { run } = await saved()
  run.active = true
  run.status = 'running'
  run.stages.plan.state = 'running'
  run.stages.plan.sessionId = 'actual-running-child'
  let resolveProof
  const proof = new Promise((resolve) => { resolveProof = resolve })
  const f = await fixture({ verifyStopped: async () => proof })
  assert.equal(typeof f.runtime.reconcile, 'function')
  assert.equal((await f.runtime.restore({ projectId: 'project-a', parentSessionId: 'parent-a', run })).ok, true)
  const pending = f.runtime.reconcile('project-a')
  f.scopes.close('project-a')
  resolveProof({ ok: true })
  assert.equal((await pending).ok, false)
  assert.equal(f.businessCalls.inference.length, 0)
  f.runtime.dispose()
})

test('reconciliation never calls the stop verifier while its control execution is still active', async () => {
  let verified = 0
  const f = await fixture({ verifyStopped: async () => { verified++; return { ok: true } } })
  assert.equal(typeof f.runtime.reconcile, 'function')
  let releaseInference
  let markEntered
  const blocked = new Promise((resolve) => { releaseInference = resolve })
  const entered = new Promise((resolve) => { markEntered = resolve })
  const infer = f.ports.inference.infer
  f.ports.inference.infer = async (input) => { markEntered(); await blocked; return infer(input) }
  const command = f.runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const pending = f.runtime.execute(command.commandId, f.exec)
  await entered
  assert.equal((await f.runtime.reconcile('project-a')).ok, false)
  assert.equal(verified, 0)
  releaseInference()
  await pending
  f.runtime.dispose()
})
