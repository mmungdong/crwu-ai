import test from 'node:test'
import assert from 'node:assert/strict'
import { plan, candidate, input, fact } from '../../helpers/template-market-fixture.mjs'

test('fill mapping distinguishes subject and case fields and never substitutes missing values or formulas', async () => {
  const module = await import('../../../src/host/integrations/valuation-workflow/services/market-workbook.ts').catch(() => null)
  assert.equal(typeof module?.buildMarketFillTrace, 'function')
  const p = plan(); p.requirements.fields[0].owner = 'case'; p.requirements.fields[0].unit = '㎡'
  p.requirements.fields[0].targetRefs = [{ sheet: '测算', cell: 'B2' }, { sheet: '测算', cell: 'C2' }]
  const cases = [candidate('case-1'), candidate('case-2')]
  cases[1].listFacts.areaSqm = fact(null, '㎡', 'missing')
  const request = input('fill-template'); request.facts.areaSqm = fact(999, '㎡')
  request.upstream = { 'collection-plan': { plan: p }, 'search-listings': { candidates: cases },
    'select-cases': { candidateVersion: 1, selectedCaseIds: ['case-1', 'case-2'], searchDecision: 'stop', supplement: '' } }
  const result = module.buildMarketFillTrace(request)
  assert.equal(result.fillTrace.length, 1)
  assert.equal(result.fillTrace[0].fact.value, 81)
  assert.equal(result.fillTrace[0].caseId, 'case-1')
  assert.ok(result.limitations.some(s => s.includes('case-2')))
  cases[0].listFacts.areaSqm.unit = '亩'
  assert.equal(module.buildMarketFillTrace(request).fillTrace.length, 0)
})

test('explicit scoped user assumptions stay assumed in the fill trace and expire with changed conditions', async () => {
  const { buildMarketFillTrace } = await import('../../../src/host/integrations/valuation-workflow/services/market-workbook.ts')
  const { disposition } = await import('../../helpers/template-market-fixture.mjs')
  const request = input('fill-template'), p = plan()
  request.upstream = { 'collection-plan': { plan: p }, 'search-listings': { candidates: [candidate()] },
    'select-cases': { selectedCaseIds: ['case-1'] } }
  request.dispositions = [{ ...disposition(), kind: 'accept-assumption', assumption: { value: 82, unit: '㎡' } }]
  const result = buildMarketFillTrace(request)
  assert.equal(result.fillTrace[0]?.fact.status, 'assumed')
  assert.equal(result.fillTrace[0]?.fact.value, 82)
  assert.ok(result.limitations.some(s => s.includes('情景假设')))
  p.filters.community = '另一个小区'
  assert.equal(buildMarketFillTrace(request).fillTrace.length, 0)
})

test('case assumptions never fill unoccupied template columns', async () => {
  const { buildMarketFillTrace } = await import('../../../src/host/integrations/valuation-workflow/services/market-workbook.ts')
  const { disposition } = await import('../../helpers/template-market-fixture.mjs')
  const request = input('fill-template'), p = plan(), c = candidate()
  p.requirements.fields[0].owner = 'case'
  p.requirements.fields[0].targetRefs = ['B2', 'C2', 'D2'].map(cell => ({ sheet: '测算', cell }))
  c.listFacts.areaSqm = fact(null, '㎡', 'missing')
  request.upstream = { 'collection-plan': { plan: p }, 'search-listings': { candidates: [c] }, 'select-cases': { selectedCaseIds: ['case-1'] } }
  request.dispositions = [{ ...disposition(), kind: 'accept-assumption', assumption: { value: 80, unit: '㎡' } }]
  const result = buildMarketFillTrace(request)
  assert.equal(result.fillTrace.length, 1)
  assert.equal(result.fillTrace[0].caseId, 'case-1')
  assert.deepEqual(result.clearRefs.map(r => r.cell), ['C2', 'D2'])
})
