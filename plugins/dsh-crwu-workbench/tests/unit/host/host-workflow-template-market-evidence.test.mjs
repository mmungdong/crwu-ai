import test from 'node:test'
import assert from 'node:assert/strict'
import { input, plan, candidate, artifact, digest } from '../../helpers/template-market-fixture.mjs'

test('list acquisition never captures details and detail acquisition only uses the selected current IDs', async () => {
  const module = await import('../../../src/host/integrations/valuation-workflow/production/template-market-evidence.ts').catch(() => null)
  assert.equal(typeof module?.createTemplateMarketEvidencePorts, 'function')
  const calls = []
  const ports = module.createTemplateMarketEvidencePorts({ casePath: () => '/case', planId: 'plan-1',
    dispatch: async (name, args) => { calls.push({ name, args }); return { ok: true, value: name.endsWith('search')
      ? { ok: true, cases: [{ source: 'lianjia', url: candidate().sourceUrl, community: '合成小区', building_area: 81, unit_price: null,
        transaction_type: 'listing', evidence: '来源证据/list.html' }], providers: [{ id: 'lianjia', retrievalTasks: [{ providerId: 'lianjia', pageNo: 1, state: 'fetched' }], notes: ['no-results'] }] }
      : { ok: true, status: 200, sourceUrl: args.url, file: '来源证据/detail.html', digest, bytes: 8, screenshot: '', screenshotDigest: '' } } },
    readEvidence: async () => ({ body: '<html></html>', digest, bytes: 8 }),
    writeCandidates: async () => ({ outcome: 'completed', summary: '已保存', data: { candidateVersion: 1, caseIds: ['case-1'], artifact: artifact() }, questions: [], limitations: [], failure: null }),
  })
  const request = input('search-listings')
  request.upstream['collection-plan'] = { plan: plan() }
  request.upstream['confirm-plan'] = { planDigest: plan().digest, accepted: true, amendments: '' }
  const listed = await ports.search(request)
  assert.equal(listed.outcome, 'completed')
  assert.ok(listed.data.candidates.length)
  assert.equal(calls.filter(c => c.name.endsWith('capture')).length, 0)
  assert.match(calls[0].args.group ?? '', /^template-market:/)
  assert.equal(calls[0].args.round, request.inputVersion)
  assert.equal(listed.data.candidates[0].listFacts.unitPrice.value, null)
  const detailInput = input('inspect-details')
  detailInput.upstream = { ...request.upstream, 'search-listings': { ...listed.data, candidates: [candidate('case-1'), candidate('case-2')] },
    'candidate-workbook': { candidateVersion: 1, caseIds: ['case-1', 'case-2'], artifact: artifact() },
    'select-cases': { candidateVersion: 1, selectedCaseIds: ['case-2'], searchDecision: 'stop', supplement: '' } }
  const detailed = await ports.inspectDetails(detailInput)
  assert.equal(calls.filter(c => c.name.endsWith('capture')).length, 1)
  assert.match(calls.find(c => c.name.endsWith('capture')).args.url, /case-2/)
  assert.ok(detailed.limitations.some(s => s.includes('截图')))
})

test('failed page report stops its source despite successful envelope and cumulative old rows', async () => {
  const { createTemplateMarketEvidencePorts } = await import('../../../src/host/integrations/valuation-workflow/production/template-market-evidence.ts')
  const pages = [], p = plan(); p.budget.maxPages = 4
  const ports = createTemplateMarketEvidencePorts({ casePath: () => '/case', planId: 'plan-1',
    dispatch: async (_name, args) => { pages.push(args.startPage); const ok = args.startPage === 1; return { ok: true, value: { ok: true,
      providers: [{ id: 'lianjia', fetchedPages: ok ? 1 : 0, failedPages: ok ? 0 : 1,
        retrievalTasks: [{ providerId: 'lianjia', pageNo: args.startPage, state: ok ? 'fetched' : 'failed' }], notes: [] }],
      cases: [{ source: 'lianjia', url: candidate().sourceUrl, community: '合成小区', building_area: 81,
        unit_price: 60000, transaction_type: 'listing', evidence: '来源证据/list.html' }] } } },
    readEvidence: async () => ({ body: 'synthetic', digest, bytes: 9 }), writeCandidates: async () => ({}) })
  const request = input('search-listings'); request.upstream = { 'collection-plan': { plan: p }, 'confirm-plan': { accepted: true, planDigest: p.digest, amendments: '' } }
  const result = await ports.search(request)
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(result.data.attempts.map(a => a.state), ['completed', 'failed'])
  assert.equal(result.data.stopReason, 'access-gap')
  assert.equal(result.data.candidates.length, 1)
})
