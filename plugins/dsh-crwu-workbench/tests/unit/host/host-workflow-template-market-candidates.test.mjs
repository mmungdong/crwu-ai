import test from 'node:test'
import assert from 'node:assert/strict'
import { candidate, fact } from '../../helpers/template-market-fixture.mjs'

test('candidate merge retains linked records without price and keeps original facts on conflicts', async () => {
  const module = await import('../../../src/host/domains/report-evaluation/workflow/template-market-candidates.ts').catch(() => null)
  assert.equal(typeof module?.mergeTemplateMarketCandidates, 'function')
  const original = candidate()
  const changed = candidate('foreign-id'); changed.sourceUrl = original.sourceUrl
  changed.listFacts.unitPrice = fact(61000, '元/㎡')
  const merged = module.mergeTemplateMarketCandidates([original], [changed])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].caseId, original.caseId)
  assert.equal(merged[0].listFacts.unitPrice.value, 60000)
  assert.equal(merged[0].listFacts.unitPrice.status, 'conflict')
  assert.match(merged[0].differences.join(' '), /61000/)
  const missingPrice = candidate('missing-price'); delete missingPrice.listFacts.unitPrice
  assert.equal(module.mergeTemplateMarketCandidates(merged, [missingPrice]).length, 2)
})

test('cross-provider duplicates require verified unit identity; weak similarities only warn', async () => {
  const { mergeTemplateMarketCandidates } = await import('../../../src/host/domains/report-evaluation/workflow/template-market-candidates.ts')
  const one = candidate('one'), two = candidate('two')
  two.providerId = 'fang'; two.sourceUrl = 'https://esf.fang.com/chushou/3_2.htm'
  one.listFacts.community = fact('合成小区'); two.listFacts.community = fact('合成小区')
  const weak = mergeTemplateMarketCandidates([one], [two])
  assert.equal(weak.length, 2)
  assert.ok(weak.every(c => c.missingFields.includes('sampleIndependence')))
  assert.ok(weak.every(c => c.differences.some(s => s.includes('疑似重复'))))
  one.listFacts.address = fact('北京市海淀区合成小区1号楼1单元101室')
  two.listFacts.address = fact('北京市海淀区合成小区1号楼1单元101室')
  const strong = mergeTemplateMarketCandidates([one], [two])
  assert.equal(strong.length, 1)
  assert.ok(strong[0].duplicateRefs.includes('two'))
  assert.ok(strong[0].differences.some(s => s.includes(two.sourceUrl)))
  two.listFacts.address.status = 'missing'
  assert.equal(mergeTemplateMarketCandidates([one], [two]).length, 2)
})
