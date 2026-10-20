import assert from 'node:assert/strict'
import test from 'node:test'

const policy = { sourceId: 'policy', path: '来源与模板.adoc', digest: 'sha256:fixture', body: '先尝试链家，失败后可使用房天下、安居客和58同城；范围为房地合一；模板链接：[市场模板](./市场模板.xlsx)' }
const selection = () => ({
  city: '北京市', community: '合成小区', nearbyCommunities: [], valueScope: '房地合一',
  providerOrder: ['lianjia', 'fang', 'anjuke', 'wuba'], templatePath: '市场模板.xlsx', questions: [],
  basis: [
    { field: 'city', sourceId: 'material-1', quote: '坐落：北京市朝阳区合成小区' },
    { field: 'community', sourceId: 'material-1', quote: '坐落：北京市朝阳区合成小区' },
    { field: 'providerOrder', sourceId: 'policy', quote: '先尝试链家，失败后可使用房天下、安居客和58同城' },
    { field: 'templatePath', sourceId: 'policy', quote: '模板链接：[市场模板](./市场模板.xlsx)' },
    { field: 'valueScope', sourceId: 'policy', quote: '范围为房地合一' },
  ],
})
const request = () => ({ runId: 'run-market-fixture', revision: 1,
  object: { objectId: 'object-1', useLabel: '公寓', areaSqm: 86.4 }, purpose: '测试参考', baseDate: '', userInput: '',
  materials: [{ materialId: 'material-1', fileName: '合成小区产权证.txt', digest: 'sha256:material', text: '坐落：北京市朝阳区合成小区；规划用途：公寓' }],
  knowledge: [policy], methodOutput: { method: 'market', algorithm: 'raw-unit-price-arithmetic-mean' },
})
const template = () => ({ fileName: '估值底稿.xlsx', relativePath: '方案/plan-fixture/模板/估值底稿.xlsx', digest: 'sha256:template',
  verified: true, mapping: [{ field: 'unitPrice', sheet: '估值结果', range: 'B5' }], formulaChecks: [{ name: '独立计算与单位检查', ok: true }] })
const listing = () => ({ source: 'fang', source_label: '房天下', url: 'https://bj.esf.fang.com/chushou/3_fixture.htm',
  title: '合成小区在售公寓', community: '合成小区', purpose: '公寓', property_nature: '公寓', building_area: 88,
  unit_price: 32000, price: 2816000, transaction_type: 'listing', captured_at: '2026-10-17T00:00:00Z',
  evidence: '来源证据/列表.html', evidence_missing: false, screenshot: '', screenshot_missing: true })
async function fixture(patch = {}) {
  const { createWorkflowMarketPorts } = await import('../../../src/host/integrations/valuation-workflow/market.ts')
  const calls = []
  const ports = createWorkflowMarketPorts({
    casePath: '/synthetic/valuation', planId: 'plan-fixture',
    allowedProviderIds: ['lianjia', 'fang', 'anjuke', 'wuba'], allowedTemplatePaths: ['市场模板.xlsx'],
    select: async () => ({ ok: true, outputs: selection() }),
    prepareTemplate: async () => ({ ok: true, template: template(), limitations: ['合成计算表测试'] }),
    dispatch: async (name, args) => {
      calls.push({ name, args })
      if (name.endsWith('market_search')) {
        return { ok: true, value: args.providers[0] === 'lianjia'
          ? { ok: false, errorKind: 'browser-login-required', error: '本渠道需要验证', cases: [], providers: [{ id: 'lianjia', login: 'unconfirmed' }] }
          : { ok: true, cases: [listing()], providers: [{ id: 'fang', login: 'confirmed' }] } }
      }
      return { ok: true, value: { ok: true, sourceUrl: args.url, url: args.url, status: 200,
        file: '来源证据/详情.html', digest: 'sha256:detail', bytes: 128, screenshot: '', screenshotDigest: '' } }
    },
    ...patch,
  })
  return { ports, calls }
}

test('preflight uses the knowledge-selected route, reaches a detail and discloses the exact table', async () => {
  const { ports, calls } = await fixture()
  const result = await ports.planning.prepare(request())
  assert.equal(result.ok, true, result.error)
  assert.equal(result.plan.sources[0].state === 'verified', false)
  assert.equal(result.plan.sources.find((s) => s.state === 'verified').providerId, 'fang')
  assert.deepEqual(result.plan.template, template())
  const searches = calls.filter((call) => call.name.endsWith('market_search'))
  assert.deepEqual(searches.map((call) => call.args.providers), [['lianjia'], ['fang']])
  assert.ok(searches.every((call) => call.args.propertyType === '公寓' && call.args.city === '北京市'))
  assert.equal(calls.filter((call) => call.name.endsWith('market_capture')).length, 1)
  assert.ok(result.plan.limitations.some((line) => /挂牌|参考/.test(line)))
  const { validatePreparedPlan } = await import('../../../src/host/domains/report-evaluation/workflow/plan.ts')
  const checked = validatePreparedPlan(result.plan, request().knowledge)
  assert.equal(checked.ok, true, checked.gaps.join('；'))
})

test('unbound location or invented catalog path is refused before any business IO', async () => {
  for (const patch of [{ city: '上海市' }, { templatePath: '未知模板.xlsx' }]) {
    let writes = 0
    const { ports, calls } = await fixture({ select: async () => ({ ok: true, outputs: { ...selection(), ...patch } }),
      prepareTemplate: async () => { writes++; return { ok: true, template: template() } } })
    assert.equal((await ports.planning.prepare(request())).ok, false)
    assert.equal(calls.length, 0)
    assert.equal(writes, 0)
  }
})

test('a user planning correction binds location and remains available to restored approved evidence', async () => {
  const correction = '补充坐落：北京市朝阳区合成小区'
  const corrected = selection()
  corrected.basis = corrected.basis.map((item) => ['city', 'community'].includes(item.field)
    ? { ...item, sourceId: 'user-input', quote: correction } : item)
  const first = await fixture({ select: async () => ({ ok: true, outputs: corrected }) })
  const prepared = await first.ports.planning.prepare({ ...request(), materials: [], promptSupplement: correction })
  assert.equal(prepared.ok, true, prepared.error)
  const plan = structuredClone({ ...prepared.plan, revision: 2, digest: 'sha256:corrected-plan', accepted: true, ready: true, gaps: [] })
  const recreated = await fixture()
  const { createWorkflowExecutionEvidencePort } = await import('../../../src/host/integrations/valuation-workflow/production/evidence.ts')
  const port = createWorkflowExecutionEvidencePort({
    casePath: '/synthetic/valuation', planId: 'plan-fixture', approvedEvidence: recreated.ports.evidence,
    allowedProviderIds: ['lianjia', 'fang', 'anjuke', 'wuba'], allowedTemplatePaths: ['市场模板.xlsx'],
    dispatch: async () => ({ ok: true, value: { ok: true, cases: [listing()] } }),
  })
  const result = await port.acquire({ ...request(), revision: 2, materials: [], mode: 'listing-reference', plan })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.samples[0].unitPrice, 32000)
})

test('a reachable search page without matching numeric detail evidence is never a verified source', async () => {
  const { ports } = await fixture({ dispatch: async (name, args) => ({ ok: true, value: name.endsWith('market_search')
    ? { ok: true, cases: [{ ...listing(), community: '其他小区', unit_price: null }], providers: [] }
    : { ok: true, sourceUrl: 'https://example.invalid/redirect', status: 200, file: '详情.html', digest: 'sha256:x' } }) })
  const result = await ports.planning.prepare(request())
  assert.equal(result.ok, false)
  assert.equal(result.plan?.sources.some((source) => source.state === 'verified') ?? false, false)
  assert.doesNotMatch(result.error ?? '', /全网|网上.*取不到/)
})

test('empty search receipts retain source capability and recovery facts instead of claiming no listings', async () => {
  const { ports } = await fixture({ dispatch: async () => ({ ok: true, value: {
    ok: true, cases: [], capabilityGaps: ['页面未识别，无法判断是否存在匹配房源'],
    providers: [{ id: 'wuba', detail: '当前页面结构不能解析', nextAction: '核对来源适配器后继续原页面任务',
      retrievalTaskId: 'synthetic-page-task', notes: [] }],
  } }) })
  const result = await ports.planning.prepare(request())
  assert.equal(result.ok, false)
  assert.match(result.gaps.join(' '), /页面未识别/)
  assert.match(result.gaps.join(' '), /核对来源适配器后继续原页面任务/)
  assert.match(result.gaps.join(' '), /synthetic-page-task/)
  assert.equal(result.plan.sources.some((source) => source.state === 'verified'), false)
})

test('approved preflight cases survive adapter recreation and are reused without another search', async () => {
  const first = await fixture()
  const prepared = await first.ports.planning.prepare(request())
  assert.equal(prepared.ok, true, prepared.error)
  const approved = { ...prepared.plan, revision: 1, digest: 'sha256:approved-fixture', accepted: true, ready: true, gaps: [] }
  const second = await fixture({ dispatch: async () => { throw new Error('preflight observations must be reusable') } })
  const acquired = await second.ports.evidence.acquire({ ...request(), mode: 'listing-reference', plan: approved })
  assert.equal(acquired.ok, true, acquired.error)
  assert.equal(acquired.samples.length, 1)
  assert.equal(acquired.samples[0].unitPrice, 32000)
  assert.equal(acquired.samples[0].listingKind, 'listing')
  assert.equal(acquired.samples[0].sourceUrl, listing().url)
  assert.equal((await second.ports.evidence.acquire({ ...request(), mode: 'listing-reference', plan: { ...approved, accepted: false } })).ok, false)
})

test('restored evidence comes from digest-bound observations and preserves the actual screenshot digest', async () => {
  const { ports } = await fixture({ dispatch: async (name, args) => ({ ok: true, value: name.endsWith('market_search')
    ? { ok: true, cases: [listing()] }
    : { ok: true, sourceUrl: `${args.url}?utm_source=detail`, status: 200, file: '来源证据/详情.html', digest: 'sha256:html', bytes: 128,
      screenshot: '推理结果/图片/真实案例.png', screenshotDigest: 'sha256:actual-image' } }) })
  const prepared = await ports.planning.prepare(request())
  assert.equal(prepared.ok, true, prepared.error)
  const plan = { ...prepared.plan, revision: 1, digest: 'sha256:approved', accepted: true, ready: true, gaps: [] }
  const source = plan.sources.find((item) => item.state === 'verified')
  source.sourceUrl = 'https://example.invalid/unbound-source'
  source.screenshot = 'unbound-image.png'
  source.screenshotDigest = 'sha256:unbound-image'
  source.capturedAt = '1900-01-01T00:00:00Z'
  const result = await ports.evidence.acquire({ ...request(), mode: 'listing-reference', plan })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.samples[0].sourceUrl, listing().url)
  assert.equal(result.samples[0].capturedAt, listing().captured_at)
  assert.equal(result.samples[0].screenshot, '推理结果/图片/真实案例.png')
  assert.equal(result.samples[0].screenshotDigest, 'sha256:actual-image')
  delete source.fields.observed
  assert.equal((await ports.evidence.acquire({ ...request(), mode: 'listing-reference', plan })).ok, false)
})

test('transaction rows and unsuccessful detail HTTP responses cannot become ready listing plans', async () => {
  for (const [row, status] of [[{ ...listing(), transaction_type: 'deal' }, 200], [listing(), 503]]) {
    const { ports } = await fixture({ dispatch: async (name, args) => ({ ok: true, value: name.endsWith('market_search')
      ? { ok: true, cases: [row] }
      : { ok: true, sourceUrl: args.url, status, file: '来源证据/详情.html', digest: 'sha256:html', bytes: 128 } }) })
    assert.equal((await ports.planning.prepare(request())).ok, false)
  }
})

async function executionEvidenceFixture(patch = {}) {
  const { createWorkflowExecutionEvidencePort } = await import('../../../src/host/integrations/valuation-workflow/production/evidence.ts')
  const first = await fixture()
  const prepared = await first.ports.planning.prepare(request())
  assert.equal(prepared.ok, true, prepared.error)
  const plan = { ...prepared.plan, revision: 1, digest: 'sha256:approved-execution', accepted: true, ready: true, gaps: [] }
  const calls = []
  const port = createWorkflowExecutionEvidencePort({
    casePath: '/synthetic/valuation', planId: 'plan-fixture', approvedEvidence: first.ports.evidence,
    allowedProviderIds: ['lianjia', 'fang', 'anjuke', 'wuba'], maxDetailCases: 3,
    dispatch: async (name, args) => {
      calls.push({ name, args })
      if (name.endsWith('market_search')) return { ok: true, value: { ok: true, cases: [
        listing(), { ...listing(), url: 'https://bj.esf.fang.com/chushou/3_fixture2.htm', unit_price: 33000 },
        { ...listing(), url: 'https://bj.esf.fang.com/chushou/3_fixture3.htm', unit_price: 34000 },
        { ...listing(), url: 'https://bj.esf.fang.com/chushou/3_foreign.htm', community: '别的小区', unit_price: 1 },
      ] } }
      return { ok: true, value: { ok: true, sourceUrl: args.url, url: args.url, status: 200, bytes: 128,
        file: '来源证据/执行详情.html', digest: 'sha256:execution-detail', screenshot: '', screenshotDigest: '' } }
    }, ...patch,
  })
  return { port, plan, calls }
}

test('execution acquires additional details only after approval and reuses the verified preflight case', async () => {
  const f = await executionEvidenceFixture()
  assert.equal((await f.port.acquire({ ...request(), mode: 'listing-reference', plan: { ...f.plan, accepted: false } })).ok, false)
  assert.equal(f.calls.length, 0)
  const result = await f.port.acquire({ ...request(), mode: 'listing-reference', plan: f.plan })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.samples.length, 3)
  assert.deepEqual(result.samples.map((sample) => sample.unitPrice).sort(), [32000, 33000, 34000])
  const searches = f.calls.filter((call) => call.name.endsWith('market_search'))
  assert.equal(searches.length, 1)
  assert.deepEqual(searches[0].args.providers, ['fang'])
  assert.equal(searches[0].args.city, '北京市')
  assert.equal(searches[0].args.propertyType, '公寓')
  const captures = f.calls.filter((call) => call.name.endsWith('market_capture'))
  assert.equal(captures.length, 2, 'the approved first detail is not captured again')
  assert.ok(captures.every((call) => !call.args.url.includes('foreign')))
})

test('failed additional detail capture preserves actual reference evidence without admitting the failed row', async () => {
  let attempts = 0
  const f = await executionEvidenceFixture({ dispatch: async (name, args) => {
    if (name.endsWith('market_search')) return { ok: true, value: { ok: true, cases: [listing(),
      { ...listing(), url: 'https://bj.esf.fang.com/chushou/3_failed.htm', unit_price: 99999 }] } }
    attempts += 1
    return { ok: true, value: { ok: true, sourceUrl: args.url, status: 503, bytes: 128,
      file: '来源证据/错误页.html', digest: 'sha256:error' } }
  } })
  const result = await f.port.acquire({ ...request(), mode: 'listing-reference', plan: f.plan })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.samples.length, 1)
  assert.equal(result.samples[0].unitPrice, 32000)
  assert.equal(attempts, 1)
  assert.ok((result.retrievalAttempts ?? []).length > 0)
})

test('execution rejects an unbound change to the saved place selection before additional IO', async () => {
  const f = await executionEvidenceFixture()
  f.plan.sources.find((source) => source.state === 'verified').fields.selection.city = '上海市'
  const result = await f.port.acquire({ ...request(), mode: 'listing-reference', plan: f.plan })
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
})

test('a failed dispatch cannot admit its otherwise successful-looking detail payload', async () => {
  const f = await executionEvidenceFixture({ dispatch: async (name, args) => name.endsWith('market_search')
    ? { ok: true, value: { ok: true, cases: [{ ...listing(), url: 'https://bj.esf.fang.com/chushou/3_unadmitted.htm' }] } }
    : { ok: false, value: { ok: true, sourceUrl: args.url, status: 200, bytes: 128,
      file: '来源证据/未被受理.html', digest: 'sha256:unadmitted' } } })
  const result = await f.port.acquire({ ...request(), mode: 'listing-reference', plan: f.plan })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.samples.length, 1)
  assert.ok(result.retrievalAttempts.some((attempt) => attempt.outcome === 'failed'))
})

test('repeated source failures have a bounded detail-attempt budget', async () => {
  let captures = 0
  const f = await executionEvidenceFixture({ dispatch: async (name) => {
    if (name.endsWith('market_search')) return { ok: true, value: { ok: true, cases: Array.from({ length: 100 }, (_, i) => ({
      ...listing(), url: `https://bj.esf.fang.com/chushou/3_failed_${i}.htm`,
    })) } }
    captures++
    return { ok: false, errorKind: 'failed' }
  } })
  const result = await f.port.acquire({ ...request(), mode: 'listing-reference', plan: f.plan })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.samples.length, 1)
  assert.ok(captures > 0 && captures <= 20, 'a provider failure must not scan an unbounded list of detail pages')
})
