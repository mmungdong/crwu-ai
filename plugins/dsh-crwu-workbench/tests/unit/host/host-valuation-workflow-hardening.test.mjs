/**
 * Core hardening regressions (tests-only).
 *
 * These pin the supervisor-observed acceptance failures: forged evidence text,
 * numeric-string/decimal value confusion, unknown region/date applicability, missing
 * section anchors, pre-clarification knowledge/material inspection, atomic answers,
 * calendar validation, non-positive area, missing calculator amounts, invented source
 * prices, atomic multi-field revisions, terminal-run cancellation and dispose-abort.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LISTING_SAMPLES,
  createDeferred,
  createFixturePorts,
  createInferenceContext,
  createStartInput,
  createSubagentProvider,
  createSubagentRun,
  createSubagentRuntime,
  createWorkflowInferenceRequest,
  digestOf,
  lastInferenceFor,
  loadRequirements,
  loadWorkflowService,
  loadWorkflowInference,
  syntheticContext,
  syntheticCountCandidate,
  syntheticPolicyProse,
  syntheticReferenceCandidate,
  syntheticReferencePolicy,
  tick,
} from '../../helpers/valuation-workflow-fixture.mjs'

async function newService(ports) {
  const { createValuationWorkflowService } = await loadWorkflowService()
  return createValuationWorkflowService(ports)
}

async function bind(source, candidate, context = syntheticContext()) {
  const { bindKnowledgeRequirements } = await loadRequirements()
  return bindKnowledgeRequirements({ sources: [source], candidates: [candidate], context })
}

test('a forged evidenceQuote that is not in the verified source is refused', async () => {
  const candidate = syntheticCountCandidate()
  candidate.parameter = { ...candidate.parameter, value: 999, evidenceQuote: '不得少于 999 个' }
  assert.equal((await bind(syntheticPolicyProse(), candidate)).ok, false)
})

test('a numeric-string value must match a real source number token', async () => {
  const candidate = syntheticCountCandidate()
  candidate.parameter = { ...candidate.parameter, value: '999' }
  assert.equal((await bind(syntheticPolicyProse(), candidate)).ok, false)
})

test('the value 3 must not match the decimal token 3.5', async () => {
  const source = syntheticPolicyProse()
  source.body = source.body.replace('3 个', '3.5 个')
  source.digest = digestOf(source.body)
  const candidate = syntheticCountCandidate()
  candidate.source = { ...candidate.source, digest: source.digest, quote: '可比案例数量不得少于 3.5 个。' }
  candidate.parameter = { ...candidate.parameter, value: 3, evidenceQuote: '不得少于 3.5 个' }
  assert.equal((await bind(source, candidate)).ok, false)
})

test('a region-limited requirement cannot pass with an unknown actual region', async () => {
  const candidate = syntheticCountCandidate()
  candidate.appliesTo = { ...candidate.appliesTo, regions: ['synthetic-region'] }
  assert.equal((await bind(syntheticPolicyProse(), candidate)).ok, false)
})

test('effective dates are evaluated against the explicit base date', async () => {
  const candidate = syntheticCountCandidate()
  candidate.appliesTo = { ...candidate.appliesTo, effectiveTo: '2020-01-01' }
  const context = syntheticContext({ facts: { baseDate: '2026-08-31' } })
  assert.equal((await bind(syntheticPolicyProse(), candidate, context)).ok, false)
})

test('the adopted section must exist in the verified body and cover the quote', async () => {
  const candidate = syntheticCountCandidate()
  candidate.source = { ...candidate.source, section: 'nonexistent-section' }
  assert.equal((await bind(syntheticPolicyProse(), candidate)).ok, false)
})

test('common knowledge and material inspection happen before a clarification', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const result = await service.start(createStartInput({ purpose: null, baseDate: null }))

  assert.equal(result.snapshot.status, 'waiting-user')
  assert.ok(calls.knowledge.length > 0, 'common knowledge must be read before asking')
  assert.ok(calls.inference.some((call) => call.stage === 'elements'), 'materials must be inspected first')
})

test('the confirmed material list reaches the elements inference task package', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  await service.start(createStartInput())
  const task = calls.inference.find((call) => call.stage === 'elements')
  assert.ok(task, 'elements inference must run')
  assert.ok(JSON.stringify(task).includes('资产表.xlsx'), 'the original material must reach the task')
})

test('an empty answer is refused without consuming the clarification', async () => {
  const { ports } = createFixturePorts()
  const service = await newService(ports)
  const waiting = await service.start(createStartInput({ purpose: null, baseDate: null }))
  const base = {
    runId: waiting.snapshot.runId,
    clarificationId: waiting.snapshot.clarification.clarificationId,
    expectedRevision: waiting.snapshot.revision,
  }
  assert.equal((await service.answer({ ...base, submissionId: 'empty', answers: {} })).ok, false)
  const good = await service.answer({
    ...base, submissionId: 'good', answers: { purpose: '转让' },
  })
  assert.equal(good.ok, true, good.error)
  assert.equal(good.snapshot.outcome, 'partial')
})

test('an unselected date remains blank and never uses the run date', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const result = await service.start(createStartInput({ baseDate: null }))
  assert.equal(result.snapshot.outcome, 'partial')
  assert.ok(calls.inference.every((call) => call.facts.baseDate === ''))
  assert.equal(result.snapshot.clarification, null)
})

test('a non-positive area cannot reach delivery or the calculator', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  const result = await service.start(createStartInput({
    object: { objectId: 'object-a', useLabel: '公寓', areaSqm: -1 },
  }))
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true)
  assert.equal(calls.calculator.length, 0)
})

test('a calculator that returns no amounts is not delivered as zero', async () => {
  const { ports, calls } = createFixturePorts({ compute: async () => ({ ok: true }) })
  const service = await newService(ports)
  const result = await service.start(createStartInput())
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true)
  assert.equal(calls.verification.length, 0)
})

test('the model cannot invent a source price outside the Host-observed pool', async () => {
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => (input.stage === 'evidence'
      ? { ok: true, outputs: { samples: [{ sourceId: 'forged-source', unitPrice: 1 }] } }
      : fallback(input)),
  })
  const service = await newService(ports)
  const result = await service.start(createStartInput())
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true)
  assert.equal(calls.calculator.length, 0, 'only Host-observed source values may enter calculation')
})

test('a multi-field revision with a duplicate or invalid field is refused atomically', async () => {
  const { ports } = createFixturePorts()
  const service = await newService(ports)
  const first = await service.start(createStartInput())
  const result = await service.revise({
    runId: first.snapshot.runId,
    nodeId: 'rights',
    submissionId: 'bad-patch',
    expectedRevision: 1,
    reason: 'test correction',
    source: 'synthetic record',
    changes: [{ field: 'areaSqm', value: 90 }, { field: 'areaSqm', value: 'invalid' }],
  })
  assert.equal(result.ok, false)
  const now = await service.get(first.snapshot.runId)
  assert.equal(now.object.areaSqm, first.snapshot.object.areaSqm, 'all fields must stay unchanged')
  assert.equal(now.revision, 1)
})

test('a delivered run cannot be cancelled', async () => {
  const { ports } = createFixturePorts()
  const service = await newService(ports)
  const done = await service.start(createStartInput())
  const result = await service.cancel({ runId: done.snapshot.runId, submissionId: 'late-cancel' })
  assert.equal(result.ok, false)
  assert.equal((await service.get(done.snapshot.runId)).outcome, 'partial')
})

test('dispose aborts the active inference execution', async () => {
  const gate = createDeferred()
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => {
      if (input.stage === 'rights') await gate.promise
      return fallback(input)
    },
  })
  const service = await newService(ports)
  const active = service.start(createStartInput())
  await tick()
  const task = calls.inference.find((call) => call.stage === 'rights')
  assert.ok(task, 'rights inference must be in flight')
  service.dispose()
  assert.equal(task.signal.aborted, true, 'disposing the plugin must abort its active execution')
  gate.resolve()
  await active.catch(() => undefined)
})

test('a failed source-bound requirement stops the calculation', async () => {
  const forged = {
    ...syntheticReferenceCandidate(),
    source: { ...syntheticReferenceCandidate().source, digest: digestOf('别的版本') },
  }
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => (input.stage === 'evidence'
      ? { ok: true, outputs: { samples: LISTING_SAMPLES.map((sample) => ({ ...sample })), requirements: [forged] } }
      : fallback(input)),
  })
  const service = await newService(ports)
  const result = await service.start(createStartInput())
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true)
  assert.equal(calls.calculator.length, 0, 'a failed mandatory requirement must stop calculation')
  assert.equal(result.snapshot.stages.evidence.state, 'blocked')
})

test('the full necessary knowledge body, not the first 160 characters, reaches inference', async () => {
  const marker = `尾部标记-${'x'.repeat(300)}`
  const body = `${syntheticReferencePolicy().body}\n${marker}\n`
  const longSource = { ...syntheticReferencePolicy(), body, digest: digestOf(body) }
  const { ports, calls } = createFixturePorts({ sources: [longSource] })
  const service = await newService(ports)
  await service.start(createStartInput())
  const elements = lastInferenceFor(calls, 'elements')
  assert.ok(elements, 'elements inference must run')
  assert.ok(JSON.stringify(elements.request).includes(marker), 'the full adopted body must reach the task')
})

test('calculation and verification calls carry run, revision, object and abort context', async () => {
  const { ports, calls } = createFixturePorts()
  const service = await newService(ports)
  await service.start(createStartInput())

  const calc = calls.calculator[0]
  assert.ok(calc, 'calculator must run')
  assert.equal(calc.runId, 'run-0001')
  assert.equal(calc.revision, 1)
  assert.equal(calc.objectId, 'object-a')
  assert.ok(calc.signal instanceof AbortSignal, 'calculator must receive the run abort signal')

  const verify = calls.verification[0]
  assert.ok(verify, 'verification must run')
  assert.equal(verify.runId, 'run-0001')
  assert.equal(verify.revision, 1)
  assert.equal(verify.objectId, 'object-a')
  assert.ok(verify.signal instanceof AbortSignal, 'verification must receive the run abort signal')
})

// ---------------------------------------------------------------------------
// Bound requirement evaluation, review gating, occupancy and adapter redaction
// ---------------------------------------------------------------------------

test('a bound mandatory minimum is enforced against the actual selected count', async () => {
  const { ports, calls } = createFixturePorts({
    sources: [syntheticPolicyProse()],
    infer: async (input, _calls, fallback) => {
      const result = await fallback(input)
      if (input.stage === 'evidence') result.outputs.requirements = [syntheticCountCandidate()]
      return result
    },
  })
  const result = await newService(ports).then((service) => service.start(createStartInput()))
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true, 'minimum 3 with 2 actual cases must stop')
  assert.equal(calls.calculator.length, 0)
})

test('a bound mandatory requirement with an unknown value is not treated as satisfied', async () => {
  const candidate = syntheticCountCandidate()
  candidate.parameter = { ...candidate.parameter, value: null }
  const { ports, calls } = createFixturePorts({
    sources: [syntheticPolicyProse()],
    infer: async (input, _calls, fallback) => {
      const result = await fallback(input)
      if (input.stage === 'evidence') result.outputs.requirements = [candidate]
      return result
    },
  })
  const service = await newService(ports)
  const result = await service.start(createStartInput())
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true)
  assert.equal(calls.calculator.length, 0)
})

test('a blocking review issue prevents verification and delivery', async () => {
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => (input.stage === 'review'
      ? { ok: true, outputs: { issues: [{ severity: 'blocking', message: '合成测试：案例不适用' }], unresolved: ['适用条件未核'] } }
      : fallback(input)),
  })
  const service = await newService(ports)
  const result = await service.start(createStartInput())
  assert.notEqual(result.snapshot.delivery?.referenceDelivered, true)
  assert.equal(calls.verification.length, 0)
})

test('a stop-unknown child keeps its writer occupancy and blocks a new revision', async () => {
  const { ports, calls } = createFixturePorts({
    infer: async (input, _calls, fallback) => (input.stage === 'rights'
      ? { ok: false, sessionId: 'actual-child', errorKind: 'stop-unknown', error: '合成测试：停止未确认' }
      : fallback(input)),
  })
  const service = await newService(ports)
  const first = await service.start(createStartInput())
  const count = calls.inference.length
  const revise = await service.revise({
    runId: first.snapshot.runId,
    nodeId: 'rights',
    submissionId: 'new-write',
    expectedRevision: 1,
    reason: 'test',
    source: 'synthetic',
    changes: [{ field: 'areaSqm', value: 90 }],
  })
  assert.equal(revise.ok, false, 'unknown stop cannot release its writer')
  assert.equal(revise.errorKind, 'stop-unknown')
  assert.equal(calls.inference.length, count, 'no new inference may start while occupancy is unresolved')
})

test('a delivered requirement must carry its actual adopted quote in the task package', async () => {
  const source = syntheticReferencePolicy()
  source.body = `合成资料说明\n${'填充资料。'.repeat(1000)}\n${source.body}`
  source.digest = digestOf(source.body)
  const candidate = syntheticReferenceCandidate()
  candidate.source = { ...candidate.source, digest: source.digest }
  const { ports, calls } = createFixturePorts({
    sources: [source],
    infer: async (input, _calls, fallback) => {
      const result = await fallback(input)
      if (input.stage === 'evidence') result.outputs.requirements = [candidate]
      return result
    },
  })
  const service = await newService(ports)
  const result = await service.start(createStartInput())
  if (result.snapshot.delivery?.referenceDelivered === true) {
    const task = calls.inference.find((call) => call.stage === 'evidence')
    assert.ok(task, 'evidence task must exist')
    assert.ok(
      task.knowledge.some((ref) => (ref.body ?? ref.quote ?? '').includes(candidate.source.quote)),
      'delivery requires the actual adopted rule in the inference task, not an undisclosed prefix',
    )
  }
})

test('the adapter rejects a nonempty structured output unrelated to the stage', async () => {
  const { createDshWorkflowInference } = await loadWorkflowInference()
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ id: 'actual-child', structured: { unrelated: true } }),
  })
  const adapter = createDshWorkflowInference({
    ctx: createInferenceContext(runtime),
    parentAgent: { id: 'parent', session: { header: { cwd: '/case' } } },
  })
  const result = await adapter.infer(createWorkflowInferenceRequest())
  assert.equal(result.ok, false, 'a nonempty unrelated object is not a valid rights result')
})

test('adapter infrastructure errors never leak secret markers or private endpoints', async () => {
  const { createDshWorkflowInference } = await loadWorkflowInference()
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') })
  runtime.start = async () => {
    throw new Error('token=SYNTHETIC_SECRET_MARKER https://private.invalid/credential')
  }
  const adapter = createDshWorkflowInference({
    ctx: createInferenceContext(runtime),
    parentAgent: { id: 'parent' },
  })
  const result = await adapter.infer(createWorkflowInferenceRequest())
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET_MARKER|private\.invalid/)
})
