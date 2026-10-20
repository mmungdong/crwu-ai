import assert from 'node:assert/strict'
import test from 'node:test'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

async function fixture() {
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
    basis: [{ sourceId: 'synthetic-reference-policy', quote: '合成参考口径：原始挂牌单价算术平均，不修正、不折扣。' }], limitations: ['合成测试'],
  } }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const runtime = createValuationWorkflowRuntime({ scopes, createRunner: async () => ({
    service: createValuationWorkflowService(f.ports), startInput: async () => createStartInput({ runId: 'project-a' }),
  }) })
  const exec = { token: Symbol('actual-control'), rootCallId: 'root-control',
    agent: { id: 'parent-a', session: { id: 'parent-a' } }, signal: new AbortController().signal }
  const command = runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const started = await runtime.execute(command.commandId, exec)
  return { ...f, runtime, exec, started }
}

test('the Host queues exact plan approval as a new opaque command and executes it once', async () => {
  const f = await fixture()
  assert.equal(f.started.snapshot.status, 'waiting-user')
  const queued = f.runtime.queue('project-a', { action: 'approve-plan', payload: {
    expectedRevision: 1, planDigest: f.started.snapshot.plan.digest, submissionId: 'approve-host-plan',
  } })
  assert.equal(queued.ok, true, queued.error)
  assert.ok(queued.commandId)
  assert.equal(f.calls.calculator.length, 0)
  const result = await f.runtime.execute(queued.commandId, f.exec)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.snapshot.plan.accepted, true)
  await f.runtime.execute(queued.commandId, f.exec)
  assert.equal(f.calls.calculator.length, 1)
  f.runtime.dispose()
})

test('Host plan queue rejects stale digests, wrong revisions and extra caller fields', async () => {
  const f = await fixture()
  const valid = { expectedRevision: 1, planDigest: f.started.snapshot.plan.digest, submissionId: 'approve-host-plan' }
  for (const patch of [{ expectedRevision: 0 }, { planDigest: 'foreign-plan' }, { caseDir: '/foreign' }]) {
    const refused = f.runtime.queue('project-a', { action: 'approve-plan', payload: { ...valid, ...patch } })
    assert.equal(refused.ok, false)
    assert.equal(refused.commandId, '')
  }
  assert.equal(f.calls.calculator.length, 0)
  f.runtime.dispose()
})
