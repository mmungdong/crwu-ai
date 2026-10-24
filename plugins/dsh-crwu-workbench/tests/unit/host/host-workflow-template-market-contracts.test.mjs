import assert from 'node:assert/strict'
import test from 'node:test'
import { candidate, disposition, fact, input, output, plan, profile, requirements, scope } from '../../helpers/template-market-fixture.mjs'

async function contracts() {
  const loaded = await import('../../../src/host/domains/report-evaluation/workflow/template-market-contracts.ts').catch(() => null)
  assert.equal(typeof loaded?.validateTemplateMarketOutput, 'function', 'new nodes need strict independent contracts')
  return loaded
}

test('node outputs reject extra keys, invalid enums and empty needs-user questions', async () => {
  const { validateTemplateMarketOutput: validate } = await contracts()
  const valid = output({ subjectFacts: { areaSqm: fact(80, '㎡') }, sourceRefs: [], unverifiedFields: [] })
  assert.equal(validate('materials', valid).ok, true)
  for (const mutate of [x => { x.shell = 'exec' }, x => { x.data.extra = true },
    x => { x.outcome = 'approved' }, x => { x.data.subjectFacts.areaSqm.status = 'guessed' },
    x => { x.data.subjectFacts.areaSqm.default = 1 }, x => { x.outcome = 'needs-user' }]) {
    const bad = structuredClone(valid); mutate(bad)
    assert.equal(validate('materials', bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(validate('select-cases', valid).ok, false)
})

test('node inputs reject arbitrary fields and candidate selections outside upstream version', async () => {
  const { validateTemplateMarketInput: validate, validateTemplateMarketBinding } = await contracts()
  assert.equal(validate('materials', input()).ok, true)
  assert.equal(validate('materials', { ...input(), toolName: 'shell' }).ok, false)
  assert.equal(validate('templates', input()).ok, false)
  const data = output({ candidateVersion: 2, selectedCaseIds: ['foreign'], searchDecision: 'stop', supplement: '' })
  assert.equal(validateTemplateMarketBinding('select-cases', data, { plan: plan(), candidates: [candidate()], candidateVersion: 2 }).ok, false)
  data.data.selectedCaseIds = ['case-1']
  assert.equal(validateTemplateMarketBinding('select-cases', data, { plan: plan(), candidates: [candidate()], candidateVersion: 2 }).ok, true)
  data.data.candidateVersion = 1
  assert.equal(validateTemplateMarketBinding('select-cases', data, { plan: plan(), candidates: [candidate()], candidateVersion: 2 }).ok, false)
})

test('plan binds actual template cells, digest and admitted knowledge while keeping business limitations', async () => {
  const { bindTemplateRequirements } = await import('../../../src/host/domains/report-evaluation/workflow/case-collection.ts')
  const pending = requirements(); pending.fields[0].applicability = 'pending'
  pending.questions = [{ field: 'areaSqm', prompt: '待核面积口径' }]
  const result = bindTemplateRequirements(pending, profile(), [{ sourceId: 'kb', body: '取得建筑面积' }], { allowUnresolved: true })
  assert.equal(result.ok, true, JSON.stringify(result.gaps))
  assert.match(result.limitations.join(' '), /面积/)
  for (const mutate of [x => { x.templateDigest = `sha256:${'b'.repeat(64)}` },
    x => { x.fields[0].targetRefs[0].cell = 'Z999' }, x => { x.fields[0].basis[0].sourceId = 'foreign' }]) {
    const forged = requirements(); mutate(forged)
    assert.equal(bindTemplateRequirements(forged, profile(), [{ sourceId: 'kb', body: '取得建筑面积' }], { allowUnresolved: true }).ok, false)
  }
})

test('dispositions remain valid across irrelevant revisions but not changed subject or selection', async () => {
  const loaded = await import('../../../src/host/domains/report-evaluation/workflow/template-market-dispositions.ts').catch(() => null)
  assert.equal(typeof loaded?.applicableTemplateMarketDispositions, 'function')
  const accepted = disposition(), before = structuredClone(accepted)
  assert.equal(loaded.applicableTemplateMarketDispositions([accepted], scope()).length, 1)
  assert.equal(loaded.applicableTemplateMarketDispositions([accepted], { ...scope(), objectId: 'other' }).length, 0)
  assert.equal(loaded.applicableTemplateMarketDispositions([accepted], { ...scope(), caseIds: ['case-2'] }).length, 0)
  assert.deepEqual(accepted, before)
})

test('delivery decisions preserve unknown facts and never replace missing engines with a mean', async () => {
  const loaded = await import('../../../src/host/domains/report-evaluation/workflow/template-market-dispositions.ts').catch(() => null)
  assert.equal(typeof loaded?.evaluateTemplateMarketInputs, 'function')
  const state = { plan: plan(), candidates: [candidate()], selectedCaseIds: ['case-1'],
    facts: { areaSqm: fact(null, '㎡', 'missing') }, dispositions: [disposition()], capabilities: [] }
  const copy = structuredClone(state)
  assert.equal(loaded.evaluateTemplateMarketInputs(state).path, 'workpaper')
  assert.deepEqual(state, copy)
  state.capabilities = [{ id: 'template-calculation', state: 'ready', reason: '' }]
  assert.equal(loaded.evaluateTemplateMarketInputs(state).path, 'workpaper')
  state.dispositions[0] = { ...disposition(), kind: 'accept-assumption', assumption: { value: 80, unit: '㎡' } }
  assert.equal(loaded.evaluateTemplateMarketInputs(state).path, 'scenario')
  assert.equal(state.facts.areaSqm.status, 'missing')
})
