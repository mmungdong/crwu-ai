import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferred, createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

function verifiedPlan() {
  return {
    method: 'market', valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean',
    sources: [{ providerId: 'fixture', state: 'verified', community: '合成测试小区', detailUrl: 'https://example.invalid/listing/1',
      fields: { unitPrice: 32000, areaSqm: 100 }, transactionType: 'listing', evidence: '合成样例（测试）' }],
    template: { fileName: '合成计算表.xlsx', relativePath: '模板/合成计算表.xlsx', digest: 'sha256:fixture-template',
      verified: true, mapping: [{ field: 'unitPrice', sheet: '计算', range: 'B2' }], formulaChecks: [{ ok: true, name: 'fixture' }] },
    basis: [{ sourceId: 'synthetic-reference-policy', quote: '合成参考口径：原始挂牌单价算术平均，不修正、不折扣。' }], limitations: ['测试参考口径'],
  }
}
async function fixture(overrides = {}) {
  const { ports, calls } = createFixturePorts(overrides)
  const preflights = []
  ports.planning = { prepare: async (input) => {
    preflights.push(input)
    return overrides.prepare?.(input) ?? { ok: true, plan: verifiedPlan() }
  } }
  const { createValuationWorkflowService } = await loadWorkflowService()
  return { service: createValuationWorkflowService(ports), calls, preflights }
}

test('the real plan stage pauses with its verified data path and exact template before execution', async () => {
  const f = await fixture()
  const result = await f.service.start(createStartInput())
  assert.equal(result.snapshot.status, 'waiting-user')
  assert.equal(result.snapshot.plan.accepted, false)
  assert.equal(result.snapshot.plan.ready, true)
  assert.ok(result.snapshot.plan.digest)
  assert.equal(result.snapshot.plan.template.fileName, '合成计算表.xlsx')
  assert.equal(result.snapshot.plan.sources[0].detailUrl, 'https://example.invalid/listing/1')
  assert.equal(f.preflights.length, 1)
  assert.equal(f.calls.inference.some((call) => call.stage === 'evidence'), false)
  assert.equal(f.calls.calculator.length, 0)
  assert.equal(f.calls.verification.length, 0)
  const approved = await f.service.approvePlan({ runId: result.snapshot.runId, expectedRevision: 1,
    planDigest: result.snapshot.plan.digest, submissionId: 'approve-real-plan' })
  assert.equal(approved.ok, true, approved.error)
  assert.equal(approved.snapshot.plan.accepted, true)
  assert.equal(approved.snapshot.outcome, 'partial')
  assert.equal(f.calls.calculator.length, 1)
  f.service.dispose()
})

test('stale or different plan approval cannot trigger data acquisition or calculation', async () => {
  const f = await fixture()
  const result = await f.service.start(createStartInput())
  assert.ok(result.snapshot.plan, 'a preflighted plan is exposed')
  for (const patch of [{ expectedRevision: 0 }, { planDigest: 'sha256:other-plan' }]) {
    const refused = await f.service.approvePlan({ runId: result.snapshot.runId, expectedRevision: 1,
      planDigest: result.snapshot.plan.digest, submissionId: `refuse-${JSON.stringify(patch)}`, ...patch })
    assert.equal(refused.ok, false)
  }
  assert.equal(f.calls.calculator.length, 0)
  assert.equal(f.calls.inference.some((call) => call.stage === 'evidence'), false)
  f.service.dispose()
})

test('a failed data path or noncalculable template cannot produce a ready plan', async () => {
  for (const plan of [
    { ...verifiedPlan(), sources: [] },
    { ...verifiedPlan(), sources: [{ ...verifiedPlan().sources[0], state: 'failed', fields: {} }] },
    { ...verifiedPlan(), template: { ...verifiedPlan().template, verified: false } },
    { ...verifiedPlan(), method: 'income' },
    { ...verifiedPlan(), template: { ...verifiedPlan().template, relativePath: '../../foreign.xlsx' } },
    { ...verifiedPlan(), template: { ...verifiedPlan().template, formulaChecks: [] } },
  ]) {
    const f = await fixture({ prepare: async () => ({ ok: true, plan }) })
    const result = await f.service.start(createStartInput())
    assert.notEqual(result.snapshot.plan?.ready, true)
    assert.equal(result.snapshot.outcome, 'blocked')
    assert.equal(f.calls.calculator.length, 0)
    f.service.dispose()
  }
})

test('an upstream correction invalidates the accepted plan and requires approval of the new revision', async () => {
  const f = await fixture()
  const started = await f.service.start(createStartInput())
  assert.ok(started.snapshot.plan, 'the plan must exist before approval')
  const approval = { runId: started.snapshot.runId, expectedRevision: 1,
    planDigest: started.snapshot.plan.digest, submissionId: 'once-only-approval' }
  await f.service.approvePlan(approval)
  await f.service.approvePlan(approval)
  assert.equal(f.calls.calculator.length, 1, 'duplicate approval cannot repeat calculation')
  const revised = await f.service.revise({ runId: started.snapshot.runId, nodeId: 'rights',
    expectedRevision: 1, submissionId: 'change-plan-area', reason: '合成面积更正', source: '合成补充资料',
    changes: [{ field: 'areaSqm', value: 150 }] })
  assert.equal(revised.ok, true, revised.error)
  assert.equal(revised.snapshot.revision, 2)
  assert.equal(revised.snapshot.plan.accepted, false)
  assert.equal(revised.snapshot.status, 'waiting-user')
  assert.equal(f.preflights.length, 2)
  assert.equal(f.calls.calculator.length, 1, 'revised inputs cannot execute using an old approval')
  assert.notEqual(revised.snapshot.plan.digest, started.snapshot.plan.digest)
  const oldPlan = await f.service.approvePlan({ ...approval, expectedRevision: 2, submissionId: 'old-plan-new-revision' })
  assert.equal(oldPlan.ok, false)
  assert.equal(f.calls.calculator.length, 1)
  f.service.dispose()
})

test('an undecided valuation mode is proposed with the tested plan and accepted once by plan approval', async () => {
  const f = await fixture()
  const started = await f.service.start(createStartInput({ mode: null }))
  assert.ok(started.snapshot.plan?.ready, 'source availability must be checked before asking the user to choose a fallback')
  assert.equal(started.snapshot.clarification, null)
  assert.equal(started.snapshot.decision.accepted, false)
  assert.equal(f.calls.calculator.length, 0)
  const approved = await f.service.approvePlan({ runId: started.snapshot.runId, expectedRevision: 1,
    planDigest: started.snapshot.plan.digest, submissionId: 'accept-proposed-reference' })
  assert.equal(approved.ok, true, approved.error)
  assert.equal(approved.snapshot.decision.mode, 'listing-reference')
  assert.equal(approved.snapshot.decision.accepted, true)
  assert.equal(approved.snapshot.outcome, 'partial')
  f.service.dispose()
})

test('an unspecified purpose and date do not block a knowledge-backed listing-reference plan', async () => {
  const f = await fixture()
  const started = await f.service.start(createStartInput({ purpose: null, baseDate: null, mode: null }))
  assert.equal(started.snapshot.clarification, null)
  assert.equal(started.snapshot.plan?.ready, true)
  assert.equal(f.preflights[0].purpose, '')
  assert.equal(f.preflights[0].baseDate, '')
  assert.equal(f.calls.calculator.length, 0)
  const approved = await f.service.approvePlan({ runId: started.snapshot.runId, expectedRevision: 1,
    planDigest: started.snapshot.plan.digest, submissionId: 'approve-unspecified-reference' })
  assert.equal(approved.ok, true, approved.error)
  assert.equal(approved.snapshot.outcome, 'partial')
  assert.equal(f.calls.calculator[0].subject.purpose, '')
  assert.equal(f.calls.calculator[0].subject.baseDate, '')
  f.service.dispose()
})

test('leaving the base date blank prevents a material date from becoming the requested valuation date', async () => {
  const quote = '评估基准日：2025-08-31'
  const f = await fixture({ infer: async (input) => input.stage === 'elements' ? { ok: true, outputs: {
    sourceFacts: [{ field: 'baseDate', value: '2025-08-31', source: { materialId: 'old-report', digest: 'sha256:old-report', quote } }],
  } } : undefined })
  const started = await f.service.start(createStartInput({ baseDate: null, materials: [
    { materialId: 'old-report', fileName: '合成历史报告.txt', digest: 'sha256:old-report', text: quote },
  ] }))
  assert.equal(started.snapshot.plan?.ready, true)
  assert.equal(f.preflights[0].baseDate, '', 'a material fact must not silently fill an intentionally omitted input')
  assert.equal((started.snapshot.stages.elements.outputs.adoptedFacts ?? []).some((fact) => fact.field === 'baseDate'), false)
  f.service.dispose()
})

test('a plan needs an actual adopted knowledge quote rather than a self-declared basis', async () => {
  for (const basis of [[], [{ sourceId: 'unknown-policy', quote: '合成参考口径：原始挂牌单价算术平均，不修正、不折扣。' }],
    [{ sourceId: 'synthetic-reference-policy', quote: '未出现在知识库里的估算规则' }]]) {
    const f = await fixture({ prepare: async () => ({ ok: true, plan: { ...verifiedPlan(), basis } }) })
    const started = await f.service.start(createStartInput())
    assert.notEqual(started.snapshot.plan?.ready, true)
    assert.equal(started.snapshot.outcome, 'blocked')
    assert.equal(f.calls.calculator.length, 0)
    f.service.dispose()
  }
})

test('a late successful plan preflight cannot revive a cancelled run', async () => {
  const entered = createDeferred()
  const release = createDeferred()
  const f = await fixture({ prepare: async () => {
    entered.resolve()
    await release.promise
    return { ok: true, plan: verifiedPlan() }
  } })
  const drive = f.service.start(createStartInput())
  await entered.promise
  await f.service.cancel({ runId: 'run-0001', submissionId: 'cancel-preflight' })
  release.resolve()
  const result = await drive
  assert.equal(result.snapshot.status, 'cancelled')
  assert.equal(result.snapshot.outcome, 'cancelled')
  assert.notEqual(result.snapshot.plan?.ready, true)
  assert.equal(f.calls.calculator.length, 0)
  f.service.dispose()
})

test('unknown child quiescence from plan preparation retains occupancy after cancellation', async () => {
  const entered = createDeferred()
  const release = createDeferred()
  const f = await fixture({ prepare: async () => {
    entered.resolve()
    await release.promise
    return { ok: false, errorKind: 'stop-unknown', sessionId: 'unknown-plan-child', error: '合成停止状态未知' }
  } })
  const drive = f.service.start(createStartInput())
  await entered.promise
  await f.service.cancel({ runId: 'run-0001', submissionId: 'cancel-unknown-preflight' })
  release.resolve()
  const result = await drive
  assert.equal(result.snapshot.errorKind, 'stop-unknown')
  const revision = await f.service.revise({ runId: 'run-0001', nodeId: 'rights', expectedRevision: 1,
    submissionId: 'unsafe-new-plan', reason: '合成更正', source: '合成资料', changes: [{ field: 'areaSqm', value: 150 }] })
  assert.equal(revision.ok, false)
  assert.equal(revision.errorKind, 'stop-unknown')
  f.service.dispose()
})
