/**
 * Host behavior for the planned embedded valuation workflow (tests-only).
 *
 * Runs against injected in-memory ports: no real DSH session, knowledge base,
 * calculator, artifact store or credential is touched.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OBJECT_AREA,
  EXPECTED_TOTAL_PRICE,
  EXPECTED_UNIT_PRICE,
  LISTING_SAMPLES,
  REFERENCE_ARTIFACTS,
  createDeferred,
  createFixturePorts,
  createStartInput,
  lastInferenceFor,
  loadListingReferenceAsset,
  loadSharedContracts,
  loadWorkflowService,
  tick,
} from '../../helpers/valuation-workflow-fixture.mjs'

const RUN = 'run-0001'

async function newService(ports) {
  const { createValuationWorkflowService } = await loadWorkflowService()
  return createValuationWorkflowService(ports)
}

test('shared contract pins the seven visible stages and the run statuses', async () => {
  const shared = await loadSharedContracts()
  assert.deepEqual(
    [...shared.VALUATION_WORKFLOW_STAGES],
    ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery'],
  )
  for (const status of ['running', 'waiting-user', 'completed', 'partial', 'blocked', 'failed', 'cancelled']) {
    assert.equal(shared.VALUATION_WORKFLOW_STATUSES.includes(status), true, status)
  }
})

test('successful listing-reference run: seven receipts, preserved facts, real ports, partial not formal', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const outcome = await service.start(createStartInput())

  assert.equal(outcome.ok, true, outcome.error)
  const snapshot = outcome.snapshot
  assert.equal(snapshot.runId, RUN)
  assert.equal(snapshot.revision, 1)

  // ① Seven visible stage receipts, each with an inspected input and output.
  for (const stage of ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']) {
    const receipt = snapshot.stages[stage]
    assert.ok(receipt, `missing stage receipt: ${stage}`)
    assert.equal(receipt.stage, stage)
    assert.ok(Object.keys(receipt.inputs).length > 0, `${stage} input receipt must be populated`)
    assert.ok(Object.keys(receipt.outputs).length > 0, `${stage} output receipt must be populated`)
  }

  // ② Original use "公寓" and the accepted area survive into the stage output and result.
  assert.equal(snapshot.stages.rights.outputs.useLabel, '公寓')
  assert.equal(snapshot.stages.rights.outputs.areaSqm, OBJECT_AREA)
  assert.equal(snapshot.result.useLabel, '公寓')
  assert.equal(snapshot.result.areaSqm, OBJECT_AREA)

  // ③ Amounts come from the injected deterministic calculator and match exactly.
  assert.equal(snapshot.result.unitPrice, EXPECTED_UNIT_PRICE)
  assert.equal(snapshot.result.totalPrice, EXPECTED_TOTAL_PRICE)
  assert.equal(calls.calculator.length, 1, 'calculator port must be invoked exactly once')
  assert.equal(calls.calculator[0].operation, 'listing-reference-mean')
  assert.equal(calls.calculator[0].areaSqm, OBJECT_AREA)
  assert.deepEqual(
    calls.calculator[0].samples.map((sample) => sample.sourceId),
    LISTING_SAMPLES.map((sample) => sample.sourceId),
  )
  // Source identity is preserved end to end.
  assert.deepEqual(snapshot.result.sources, LISTING_SAMPLES.map((sample) => sample.sourceId))

  // ④ Artifact verification is a real, separate port call over the fixed artifact set.
  assert.equal(calls.verification.length, 1, 'artifact verification port must be invoked')
  assert.deepEqual(calls.verification[0].artifacts, [...REFERENCE_ARTIFACTS])
  const asset = await loadListingReferenceAsset()
  assert.deepEqual([...asset.LISTING_REFERENCE_ARTIFACTS], [...REFERENCE_ARTIFACTS])

  // ⑤ Reference delivery is explicitly partial and never a formal completion.
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.outcome, 'partial')
  assert.equal(snapshot.delivery.kind, 'listing-reference')
  assert.equal(snapshot.delivery.referenceDelivered, true)
  assert.equal(snapshot.delivery.formalComplete, false)

  // ⑥ The adapter returns the actual session id; each receipt records that id.
  const correlationIds = calls.inference.map((call) => call.correlationId)
  assert.ok(correlationIds.length > 0, 'the run must use the inference port')
  assert.equal(new Set(correlationIds).size, correlationIds.length, 'each attempt has a distinct correlation key')
  const returned = calls.inferenceReturns.map((result) => result.sessionId)
  assert.equal(returned.length, calls.inference.length)
  assert.equal(new Set(returned).size, returned.length, 'each attempt returns its own actual session')
  for (const stage of ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']) {
    const entry = lastInferenceFor(calls, stage)
    assert.ok(entry, `${stage} must use the inference port`)
    assert.equal(snapshot.stages[stage].sessionId, entry.result.sessionId,
      `${stage} receipt must record the returned actual session id`)
    assert.notEqual(snapshot.stages[stage].sessionId, entry.request.correlationId,
      `${stage} receipt must not echo the proposed correlation key`)
    assert.notEqual(snapshot.stages[stage].sessionId, '')
  }
})

test('an unselected base date stays unused; purpose is asked once and the accepted reference mode is retained', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const waiting = await service.start(createStartInput({ purpose: null, baseDate: null }))

  assert.equal(waiting.ok, true, waiting.error)
  assert.equal(waiting.snapshot.status, 'waiting-user')
  assert.ok(waiting.snapshot.clarification, 'a waiting run must expose the open clarification')
  assert.equal(waiting.snapshot.clarification.questions.length, 1, 'the optional date must not cause a clarification')
  assert.deepEqual(
    waiting.snapshot.clarification.questions.map((question) => question.field).sort(),
    ['purpose'],
  )
  assert.equal(waiting.snapshot.decision.mode, 'listing-reference')
  assert.equal(calls.calculator.length, 0, 'nothing downstream may run while waiting')

  const clarificationId = waiting.snapshot.clarification.clarificationId
  const stale = await service.answer({
    runId: RUN,
    clarificationId,
    submissionId: 'ans-stale',
    expectedRevision: waiting.snapshot.revision - 1,
    answers: { purpose: '转让' },
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.errorKind, 'stale-revision')
  assert.equal(calls.calculator.length, 0, 'a refused answer must not drive the run')

  const answered = await service.answer({
    runId: RUN,
    clarificationId,
    submissionId: 'ans-1',
    expectedRevision: waiting.snapshot.revision,
    answers: { purpose: '转让' },
  })
  assert.equal(answered.ok, true, answered.error)
  assert.equal(answered.snapshot.clarification, null)
  assert.equal(answered.snapshot.decision.mode, 'listing-reference', 'accepted reference choice must be retained')
  assert.equal(answered.snapshot.outcome, 'partial')
  assert.equal(answered.snapshot.result.areaSqm, OBJECT_AREA)

  // The same clarification is consumed: replay is refused without a second drive.
  const inferenceCalls = calls.inference.length
  const replay = await service.answer({
    runId: RUN,
    clarificationId,
    submissionId: 'ans-2',
    expectedRevision: waiting.snapshot.revision,
    answers: { purpose: '转让' },
  })
  assert.equal(replay.ok, false)
  assert.equal(replay.errorKind, 'duplicate')
  assert.equal(calls.inference.length, inferenceCalls, 'a refused continuation must not re-run the graph')
})

test('an unmet knowledge requirement stops the run before calculation and delivery', async () => {
  const { ports, calls } = createFixturePorts({
    readKnowledge: async () => ({ ok: false, sources: [], gaps: ['未找到适用知识正文'] }),
  })
  const service = await newService(ports)
  const outcome = await service.start(createStartInput())
  const snapshot = outcome.snapshot

  assert.equal(['blocked', 'failed', 'waiting-user'].includes(snapshot.status), true, snapshot.status)
  assert.equal(calls.calculator.length, 0, 'calculation must not run without the required knowledge')
  assert.equal(calls.verification.length, 0, 'delivery must not be verified')
  assert.equal(snapshot.delivery?.referenceDelivered === true, false, 'nothing may be delivered as a reference result')
  for (const stage of ['calculation', 'review', 'delivery']) {
    assert.notEqual(snapshot.stages[stage].state, 'passed', `${stage} must not pass after an unmet requirement`)
  }
})

test('an unmet object fact stops dependent stages instead of filling a default', async () => {
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => (input.stage === 'rights'
      ? { ok: false, gaps: ['面积口径无法确认'] }
      : fallback(input)),
  })
  const service = await newService(ports)
  const outcome = await service.start(createStartInput())
  const snapshot = outcome.snapshot

  assert.equal(snapshot.stages.rights.gaps.includes('面积口径无法确认'), true, 'the gap must be recorded')
  assert.notEqual(snapshot.stages.rights.state, 'passed')
  assert.equal(calls.calculator.length, 0)
  assert.equal(calls.verification.length, 0)
  assert.equal(snapshot.delivery?.referenceDelivered === true, false)
  assert.equal(snapshot.result === null || snapshot.result === undefined, true, 'no amount may be invented')
})

test('calculator failure prevents artifact verification and reference delivery', async () => {
  const { ports, calls } = createFixturePorts({
    compute: async () => ({ ok: false, error: '计算器不可用' }),
  })
  const service = await newService(ports)
  const outcome = await service.start(createStartInput())
  const snapshot = outcome.snapshot

  assert.equal(calls.verification.length, 0, 'unverified artifacts must not be delivered')
  assert.equal(snapshot.delivery?.referenceDelivered === true, false)
  assert.notEqual(snapshot.outcome, 'partial', 'a failed calculation cannot produce the reference outcome')
  assert.equal(['failed', 'blocked'].includes(snapshot.stages.calculation.state), true)
})

test('get exposes a running snapshot while start is still in flight', async () => {
  const gate = createDeferred()
  const { ports } = createFixturePorts({
    infer: async (input, _calls, fallback) => {
      if (input.stage === 'rights') await gate.promise
      return fallback(input)
    },
  })
  const service = await newService(ports)
  const running = service.start(createStartInput())
  await tick()

  const snapshot = await service.get(RUN)
  assert.ok(snapshot, 'the run must be queryable while it is driving')
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.stages.rights.state, 'running')

  gate.resolve()
  const settled = await running
  assert.equal(settled.ok, true, settled.error)
})

test('overlapping starts are refused and a late callback cannot publish a cancelled run', async () => {
  const gate = createDeferred()
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => {
      if (input.stage === 'rights') await gate.promise
      return fallback(input)
    },
  })
  const service = await newService(ports)
  const first = service.start(createStartInput())
  await tick()

  const overlap = await service.start(createStartInput())
  assert.equal(overlap.ok, false)
  assert.equal(overlap.errorKind, 'duplicate')
  assert.equal(calls.inference.filter((call) => call.stage === 'rights').length, 1, 'a second drive must not start')

  gate.resolve()
  const done = await first
  assert.equal(done.ok, true, done.error)
  assert.equal(done.snapshot.outcome, 'partial')

  // A cancelled run must ignore a late inference result instead of delivering it.
  const lateGate = createDeferred()
  const second = createFixturePorts({
    infer: async (input, _calls, fallback) => {
      if (input.stage === 'evidence') await lateGate.promise
      return fallback(input)
    },
  })
  const secondService = await newService(second.ports)
  const cancelledRun = secondService.start(createStartInput({ runId: 'run-cancel' }))
  await tick()

  const cancelled = await secondService.cancel({ runId: 'run-cancel', submissionId: 'cancel-1' })
  assert.equal(cancelled.ok, true, cancelled.error)
  assert.equal(cancelled.snapshot.status, 'cancelled')

  lateGate.resolve()
  // The in-flight start may settle or reject on cancellation; the authoritative fact
  // is the persisted snapshot, so a rejection here is not itself a failure.
  await cancelledRun.catch(() => undefined)
  const final = await secondService.get('run-cancel')
  assert.equal(final.status, 'cancelled')
  assert.equal(final.delivery?.referenceDelivered === true, false)
  assert.equal(second.calls.calculator.length, 0, 'a late callback must not reach calculation')
})

test('revising area reruns the actual dependants in fresh sessions, reuses sources and keeps the original result', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const first = await service.start(createStartInput())
  assert.equal(first.ok, true, first.error)

  const originalResult = first.snapshot.result
  const originalRightsSession = first.snapshot.stages.rights.sessionId
  const originalElementsSession = first.snapshot.stages.elements.sessionId
  const knowledgeReads = calls.knowledge.length

  const stale = await service.revise({
    runId: RUN,
    nodeId: 'rights',
    submissionId: 'rev-stale',
    expectedRevision: 0,
    reason: '面积更正',
    source: '权证 2026-08-01',
    changes: [{ field: 'areaSqm', value: 90 }],
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.errorKind, 'stale-revision')
  assert.equal(calls.knowledge.length, knowledgeReads, 'a refused revision must not refetch knowledge')

  const revised = await service.revise({
    runId: RUN,
    nodeId: 'rights',
    submissionId: 'rev-1',
    expectedRevision: first.snapshot.revision,
    reason: '面积更正',
    source: '权证 2026-08-01',
    changes: [{ field: 'areaSqm', value: 90 }],
  })
  assert.equal(revised.ok, true, revised.error)
  const snapshot = revised.snapshot

  assert.equal(snapshot.revision, 2)
  assert.equal(snapshot.result.areaSqm, 90, 'the corrected area must drive the new calculation')
  assert.equal(snapshot.result.totalPrice, Math.round(EXPECTED_UNIT_PRICE * 90 * 100) / 100)

  // Rights and its actual dependants rerun; the upstream elements stage is reused.
  for (const stage of ['rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']) {
    assert.equal(snapshot.stages[stage].attempt >= 2, true, `${stage} must rerun when area changes`)
  }
  assert.equal(snapshot.stages.elements.attempt, 1, 'an upstream stage must not rerun')
  assert.equal(snapshot.stages.elements.sessionId, originalElementsSession)
  assert.notEqual(snapshot.stages.rights.sessionId, originalRightsSession, 'rerun must use a fresh inference session')
  const correlationIds = calls.inference.map((call) => call.correlationId)
  assert.equal(new Set(correlationIds).size, correlationIds.length, 'every attempt has a distinct correlation key')
  const returned = calls.inferenceReturns.map((result) => result.sessionId)
  assert.equal(new Set(returned).size, returned.length, 'every attempt returns its own actual session')
  assert.equal(snapshot.stages.rights.sessionId, lastInferenceFor(calls, 'rights').result.sessionId,
    'the revised receipt must record the newly returned session id')

  // Verified sources are reused, not re-read.
  assert.equal(calls.knowledge.length, knowledgeReads, 'the valid source pool must be reused')

  // The original result stays queryable and is never overwritten in place.
  const originalRevision = snapshot.revisions.find((record) => record.revision === 1)
  assert.ok(originalRevision, 'revision history must retain revision 1')
  assert.equal(originalRevision.result.totalPrice, originalResult.totalPrice)
  assert.equal(originalRevision.result.areaSqm, originalResult.areaSqm)

  // The same revision submission is refused as a duplicate.
  const replay = await service.revise({
    runId: RUN,
    nodeId: 'rights',
    submissionId: 'rev-1',
    expectedRevision: snapshot.revision,
    reason: '面积更正',
    source: '权证 2026-08-01',
    changes: [{ field: 'areaSqm', value: 90 }],
  })
  assert.equal(replay.ok, false)
  assert.equal(replay.errorKind, 'duplicate')
})

test('a formal-mode run is never reported as a completed listing reference', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const outcome = await service.start(createStartInput({ mode: 'formal' }))
  const snapshot = outcome.snapshot

  // The first slice only implements the listing-reference chain; a formal request
  // must land as blocked/unsupported rather than borrowing the reference outcome.
  assert.notEqual(snapshot.outcome, 'partial')
  assert.equal(snapshot.delivery?.formalComplete === true, false)
  assert.equal(calls.verification.length, 0)
})
