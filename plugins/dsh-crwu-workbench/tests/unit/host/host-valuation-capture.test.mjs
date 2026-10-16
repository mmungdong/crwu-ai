/**
 * 站点页面固定解析器（设计稿 §8.2，计划 Task 8）。
 *
 * 这一层存在的唯一理由是**不让 Agent 现场猜选择器**：站点结构写死在代码里，改版时改一处。
 * 三条错了会静默出错的判据：
 *
 * 1. **0 选择器命中 ≠ 没有案例**：结果页结构在却解析不出房源，只能是模板过期（`template-stale`），
 *    报成"这个小区没有房源"会让结论建立在一个错误的"无案例"事实上；
 * 2. **没有价格不是房源记录**：推荐位/广告位也没有价格，靠这一条把它们挡在外面；
 * 3. **恢复后的房源级校验看最终 URL 的房源 ID**：只看 HTTP 200 或"挑战消失"会把
 *    "挑战没了、页面是空的"当成成功。
 *
 * ⚠️ **真实验收边界**：下面的 fixture 是按 2026-10-13 归档的逐字结构（`session.v4.jsonl` L925/L930，
 * 见 `docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md` §2.4）
 * **构造**的脱敏 DOM，不是线上页面的字节复制。它只证明选择器与字段口径能被解析；
 * 真实站点当前是否可用仍需员工在授权环境验收一次 —— 这里不声称在线 provider 已验证。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  parseSitePage, listingFromListItem, listItemBlocks, looksLikeListPage,
  looksLikeDetailPage, listingIdOf, elementTextByClass,
} = await import(new URL('src/host/domains/report-evaluation/market/site-parsers.ts', ROOT).href)
const { normalizeCase } = await import(new URL('src/host/domains/report-evaluation/market/normalize.ts', ROOT).href)

/** 脱敏列表页：结构与实测一致（`ul.sellListContent > li.clear`），内容为构造值。 */
const LIST_HTML = `<!doctype html><html><head><title>北京朝阳二手房</title></head><body>
<div class="listContent">
  <ul class="sellListContent">
    <li class="clear">
      <div class="title"><a href="https://bj.lianjia.com/ershoufang/101139646125.html">太阳公元 2室1厅 89.28平米</a></div>
      <div class="positionInfo"><a href="/xiaoqu/1111/">太阳公元</a> 朝阳 太阳宫</div>
      <div class="houseInfo">2室1厅 | 89.28平米 | 南 | 精装 | 低楼层/共18层</div>
      <div class="totalPrice"><span>998</span>万</div>
      <div class="unitPrice"><span>111783</span>元/平</div>
    </li>
    <li class="clear">
      <div class="title"><a href="/ershoufang/101139646999.html">力鸿花园 3室1厅 159.59平米</a></div>
      <div class="positionInfo"><a href="/xiaoqu/2222/">力鸿花园</a> 朝阳 三元桥</div>
      <div class="houseInfo">3室1厅 | 159.59平米 | 南北 | 简装 | 中楼层/共12层</div>
      <div class="totalPrice"><span>1100</span>万</div>
      <div class="unitPrice"><span>68900</span>元/平</div>
    </li>
  </ul>
</div></body></html>`

/** 结果页结构在、但没有任何房源项。 */
const STALE_HTML = `<html><body><div class="listContent"><ul class="sellListContent">
  <li class="clear"><div class="title"><a href="/agent/1">金牌经纪人推荐</a></div></li>
</ul></div></body></html>`

test('列表页用固定选择器解析出房源，字段口径与 normalize 对齐', () => {
  const result = parseSitePage({ providerId: 'lianjia', body: LIST_HTML, finalUrl: 'https://bj.lianjia.com/ershoufang/chaoyang/' })
  assert.equal(result.failureKind, '')
  assert.equal(result.channel, 'dom')
  assert.equal(result.listings.length, 2)
  const first = result.listings[0]
  assert.equal(first.source, 'lianjia')
  assert.equal(first.url, 'https://bj.lianjia.com/ershoufang/101139646125.html')
  // 原始字段带着**单位词**：`normalize.parsePrice` 按单位词换算，裸数字会被读成"元"（差 10000 倍）。
  assert.equal(first.fields.price, '998万')
  assert.equal(first.fields.unitPrice, '111783元')
  assert.equal(first.fields.area, '89.28')
  assert.equal(first.fields.layout, '2室1厅')
  assert.equal(first.fields.floor, '低楼层')
  assert.equal(first.fields.totalFloors, '18')
  assert.equal(first.fields.decoration, '精装')
  assert.equal(first.fields.community, '太阳公元')
  assert.equal(first.fields.listingId, '101139646125')
  // 相对路径要按最终 URL 补齐（否则跨来源去重会拿到一堆同形相对路径）。
  assert.equal(result.listings[1].url, 'https://bj.lianjia.com/ershoufang/101139646999.html')

  // "字段口径与 normalize 对齐"这句必须真的成立 —— 原始字段穿过标准化后要是可用的数字。
  const canonical = normalizeCase(first)
  assert.equal(canonical.price, 9_980_000)
  assert.equal(canonical.unitPrice, 111_783)
  assert.equal(canonical.buildingArea, 89.28)
  assert.equal(canonical.totalFloors, '18')
  assert.equal(canonical.decoration, '精装')
  assert.equal(canonical.community, '太阳公元')
})

test('0 选择器命中 → template-stale，绝不是"没有案例"', () => {
  const result = parseSitePage({ providerId: 'lianjia', body: STALE_HTML, finalUrl: 'https://bj.lianjia.com/ershoufang/chaoyang/' })
  assert.equal(result.failureKind, 'template-stale')
  assert.deepEqual(result.listings, [])
  assert.equal(result.notes.some((note) => note.includes('模板')), true)
})

test('不像结果页的空态是 no-results（站点在回答"没有"）', () => {
  const result = parseSitePage({
    providerId: 'lianjia',
    body: '<html><body><div class="noResult">没有找到符合条件的房源</div></body></html>',
    finalUrl: 'https://bj.lianjia.com/ershoufang/',
  })
  assert.equal(result.failureKind, 'no-results')
})

test('空正文是 unreadable，不冒充"没有案例"', () => {
  assert.equal(parseSitePage({ providerId: 'lianjia', body: '   ', finalUrl: 'https://x/' }).failureKind, 'unreadable')
})

test('JSON-LD 优先于固定选择器', () => {
  const html = `${LIST_HTML}<script type="application/ld+json">${JSON.stringify({
    '@type': 'RealEstateListing', name: '结构化房源', url: 'https://bj.lianjia.com/ershoufang/999.html', price: 800,
  })}</script>`
  const result = parseSitePage({ providerId: 'lianjia', body: html, finalUrl: 'https://bj.lianjia.com/ershoufang/chaoyang/' })
  assert.equal(result.channel, 'json-ld')
  assert.equal(result.listings.length, 1)
  assert.equal(result.listings[0].url, 'https://bj.lianjia.com/ershoufang/999.html')
})

test('没有价格的列表项不是房源记录（推荐位/广告位也被挡掉）', () => {
  const block = '<li class="clear"><div class="title"><a href="/agent/1">金牌经纪人</a></div><div>立即咨询</div></li>'
  assert.equal(listingFromListItem(block, 'lianjia', 'https://bj.lianjia.com/ershoufang/'), null)
  const blocks = listItemBlocks(STALE_HTML)
  assert.equal(blocks.length, 1)
})

test('不同来源各自标注 source：逐条跟着 providerId', () => {
  const fang = parseSitePage({ providerId: 'fang', body: LIST_HTML, finalUrl: 'https://bj.fang.com/x/' })
  const lianjia = parseSitePage({ providerId: 'lianjia', body: LIST_HTML, finalUrl: 'https://bj.lianjia.com/x/' })
  assert.equal(fang.listings.every((row) => row.source === 'fang'), true)
  assert.equal(lianjia.listings.every((row) => row.source === 'lianjia'), true)
  // 相对 href 按各自的最终 URL 补齐：同一份 DOM 在两个来源下产出不同的绝对地址。
  // （绝对 href 按原样保留 —— 那是页面自己声明的地址，不该被站点基准改写。）
  assert.equal(lianjia.listings[1].url, 'https://bj.lianjia.com/ershoufang/101139646999.html')
  assert.equal(fang.listings[1].url, 'https://bj.fang.com/ershoufang/101139646999.html')
  assert.equal(lianjia.listings[0].url, 'https://bj.lianjia.com/ershoufang/101139646125.html')
})

test('详情页校验看最终 URL 的房源 ID 与业务字段，不看"挑战消失"', () => {
  const detail = '<html><body><div class="introContent"><span>89.28平米</span><span>998万</span></div></body></html>'
  assert.equal(looksLikeDetailPage(detail, '101139646125', 'https://bj.lianjia.com/ershoufang/101139646125.html').ok, true)
  // 恢复后误入另一个房源：拒绝。
  const wrong = looksLikeDetailPage(detail, '101139646125', 'https://bj.lianjia.com/ershoufang/999999999999.html')
  assert.equal(wrong.ok, false)
  assert.match(wrong.reason, /不一致/)
  // 页面是空的（挑战消失但没内容）：拒绝。
  assert.equal(looksLikeDetailPage('<html><body>请稍候</body></html>', '101139646125', 'https://bj.lianjia.com/ershoufang/101139646125.html').ok, false)
})

test('细节工具：ID 提取、class 判定、锚点文本', () => {
  assert.equal(listingIdOf('https://bj.lianjia.com/ershoufang/101139646125.html'), '101139646125')
  assert.equal(listingIdOf('https://bj.lianjia.com/ershoufang/'), '')
  assert.equal(looksLikeListPage(LIST_HTML), true)
  assert.equal(looksLikeListPage('<html><body>nothing</body></html>'), false)
  assert.equal(elementTextByClass(LIST_HTML, 'title'), '太阳公元 2室1厅 89.28平米')
})

// ── 能力门禁与取数任务（设计稿 §8.1 / §8.2） ────────────────────────────────

const { checkMethodCapabilities, CAPABILITY_CATALOGUE } = await import(
  new URL('src/host/domains/report-evaluation/execution/capabilities.ts', ROOT).href)

function planFixture(overrides = {}) {
  return {
    planId: 'plan-001', title: '同小区住宅', propertyType: 'residential',
    objectIds: ['object-001', 'object-002'], methodRequest: 'market', methodAssessment: null,
    baseDate: null, valuationPath: 'combined', groupReason: '', groupEvidenceRefs: [],
    conflicts: [], status: 'ready-for-retrieval', ...overrides,
  }
}

/** 一套"全都装好"的事实，逐条覆盖它来构造缺席场景。 */
function factsFixture(overrides = {}) {
  const tools = [...new Set(CAPABILITY_CATALOGUE.map((row) => row.registeredTool).filter((name) => name !== ''))]
  return {
    registeredTools: tools,
    visibleTools: tools,
    adapters: ['dws.read', 'dws.download', 'browser.cli', 'browser.challenge.script', 'python.runtime'],
    providerHealthy: { fang: true, lianjia: true },
    ...overrides,
  }
}

// (rule refs now live in the knowledge snapshot; capability checks take the plan fixtures directly)

test('方法要求截图而截图能力未装配时，取数前就 fail（不是抓完才发现）', () => {
  const demand = {
    projectId: 'project-001', planId: 'plan-001', propertyType: 'residential',
    valuationPath: 'combined', method: 'market',
    capabilityIds: ['market.residential.search', 'market.residential.detail', 'browser.page.screenshot'],
    requiredCapabilities: ['browser.page.screenshot', 'market.residential.search'],
    screenshotRequired: true,
  }
  const missingScreenshotRegistry = factsFixture({
    registeredTools: factsFixture().registeredTools.filter((name) => name !== 'crwu_valuation_market_capture'),
  })
  const check = checkMethodCapabilities(planFixture(), demand, missingScreenshotRegistry)
  assert.equal(check.ok, false)
  assert.equal(check.missing.some((row) => row.id === 'browser.page.screenshot'), true)
  assert.equal(check.blockers.length > 0, true)
  // 五要素必须齐全，员工才知道该补什么。
  const blocker = check.blockers.find((row) => row.capabilityId === 'browser.page.screenshot')
  assert.equal(blocker.kind, 'capability-missing')
  assert.equal(blocker.stage, 'retrieval')
  assert.equal(blocker.missing.length > 0, true)
  assert.equal(blocker.checked.length > 0, true)
  assert.notEqual(blocker.remediation.trim(), '')
})

test('"已注册但作用域不可见"与"没注册"必须分开报', () => {
  const demand = {
    projectId: 'p', planId: 'plan-001', propertyType: 'residential', valuationPath: 'combined', method: 'market',
    capabilityIds: ['market.residential.search'], requiredCapabilities: [], screenshotRequired: false,
  }
  const invisible = checkMethodCapabilities(planFixture(), demand, factsFixture({
    visibleTools: factsFixture().visibleTools.filter((name) => name !== 'crwu_valuation_market_search'),
  }))
  assert.equal(invisible.ok, false)
  assert.match(invisible.missing[0].reasons.join('；'), /不在当前作用域可见范围内/)

  const unregistered = checkMethodCapabilities(planFixture(), demand, factsFixture({
    registeredTools: factsFixture().registeredTools.filter((name) => name !== 'crwu_valuation_market_search'),
  }))
  assert.match(unregistered.missing[0].reasons.join('；'), /没有注册/)
})

test('能力全部装配时通过，并且来源不健康也算缺席', () => {
  const demand = {
    projectId: 'p', planId: 'plan-001', propertyType: 'residential', valuationPath: 'combined', method: 'market',
    capabilityIds: ['market.residential.search', 'valuation.market.calculate'],
    requiredCapabilities: ['template.xlsx.materialize'], screenshotRequired: false,
  }
  const healthy = checkMethodCapabilities(planFixture(), demand, factsFixture())
  assert.equal(healthy.ok, true, JSON.stringify(healthy.missing))
  assert.deepEqual(healthy.blockers, [])

  const providerDown = checkMethodCapabilities(planFixture(), demand, factsFixture({ providerHealthy: { fang: true, lianjia: false } }))
  assert.equal(providerDown.ok, false)
  assert.match(providerDown.missing[0].reasons.join('；'), /lianjia/)
})

test('降级能力缺席只记缺口，不阻断（缺重算 provider → partial 而不是失败）', () => {
  const demand = {
    projectId: 'p', planId: 'plan-001', propertyType: 'residential', valuationPath: 'combined', method: 'market',
    capabilityIds: ['workbook.recalculate'], requiredCapabilities: [], screenshotRequired: false,
  }
  const check = checkMethodCapabilities(planFixture(), demand, factsFixture({ adapters: ['dws.read'] }))
  assert.equal(check.ok, true, '重算能力缺席不该阻断')
  assert.deepEqual(check.degradable, ['workbook.recalculate'])
  assert.deepEqual(check.blockers, [])

  // 挑战恢复同样按降级口径：它缺席时仍可让员工人工完成，但必须显式记缺口。
  const recover = checkMethodCapabilities(planFixture(), {
    ...demand, capabilityIds: ['browser.challenge.recover'],
  }, factsFixture({ adapters: ['dws.read', 'dws.download', 'browser.cli'] }))
  assert.equal(recover.ok, true)
  assert.deepEqual(recover.degradable, ['browser.challenge.recover'])
})

test('土地能力不存在时永远是缺席，且原因是"尚未实现"', () => {
  const check = checkMethodCapabilities(planFixture({ valuationPath: 'separate' }), {
    projectId: 'p', planId: 'plan-001', propertyType: 'residential', valuationPath: 'separate', method: 'market',
    capabilityIds: ['land.valuation.execute'], requiredCapabilities: [], screenshotRequired: false,
  }, factsFixture())
  assert.equal(check.ok, false)
  assert.match(check.missing[0].reasons.join('；'), /尚未实现/)
})

test('认不出来的 capability ID 按缺失处理（知识文档写错 ID 不静默放过）', () => {
  const check = checkMethodCapabilities(planFixture(), {
    projectId: 'p', planId: 'plan-001', propertyType: 'residential', valuationPath: 'combined', method: 'market',
    capabilityIds: ['market.residential.serach'], requiredCapabilities: [], screenshotRequired: false,
  }, factsFixture())
  assert.equal(check.ok, false)
  assert.equal(check.missing[0].id, 'market.residential.serach')
  assert.equal(check.missing[0].degradable, false)
  assert.match(check.blockers[0].code, /unknown/)
  assert.match(check.blockers[0].reason, /capability ID/)
  assert.match(check.blockers[0].remediation, /逐字一致/)
})

// ── 浏览器传输层：取页面 → 可见挑战 → 固定恢复 → 重新取原 URL ──────────────

const { browserTransportForTask, pageEvidencePath, retryableOf } = await import(
  new URL('src/host/domains/report-evaluation/browser/browser-transport.ts', ROOT).href)

/** 造一个记录调用的假 client + 假 coordinator + 内存"磁盘"。 */
function transportFixture(pages) {
  const files = new Map()
  const calls = []
  const recoveries = []
  const client = {
    async fetch(request) {
      calls.push(request)
      const next = pages.length > 1 ? pages.shift() : pages[0]
      if (next.ok) files.set(request.out, next.body ?? '')
      return {
        ok: next.ok, failureKind: next.failureKind ?? '', verdict: next.verdict ?? '',
        finalUrl: next.finalUrl ?? request.url, title: '', file: next.ok ? request.out : '',
        digest: next.ok ? 'sha256:x' : '', bytes: (next.body ?? '').length, status: next.status ?? 200,
        error: next.error ?? '',
      }
    },
    async status() { throw new Error('unused') },
    async login() { throw new Error('unused') },
    async shot() { throw new Error('unused') },
    async recover() { throw new Error('unused') },
    sites() { return '/pkg/sites.json' },
  }
  const coordinator = {
    async attempt(input) {
      recoveries.push(input)
      return recoveries.length === 0 ? {} : {
        recoveryId: `rec-${input.retrievalTaskId}`, retrievalTaskId: input.retrievalTaskId,
        providerId: input.providerId, strategyId: 'geetest-v3-canvas', strategyVersion: '1',
        attempts: 1, beforeKind: 'geetest-v3-canvas', afterKind: 'none',
        state: 'recovered', reasonCode: 'no-visible-challenge', nextEligibleAt: '',
        strategies: ['geetest-v3-canvas'], notes: [],
        pageValidation: {
          finalUrl: input.url, title: '', hostMatches: true, readable: true,
          challengeVisible: false, loginWall: false, blocked: false, overlaySelectors: [], reason: '',
        },
      }
    },
    async resume() { throw new Error('unused') },
    budgetOf() { return undefined },
    cooldownUntilOf() { return 0 },
    dispose() {},
  }
  const transport = browserTransportForTask({
    client, coordinator,
    readPage: async (path) => {
      if (!files.has(path)) throw new Error('ENOENT')
      return files.get(path)
    },
  }, { retrievalTaskId: 'task-1', providerId: 'lianjia', caseRoot: '/cases/space/项目-001', pageDir: '来源证据/页面' })
  return { transport, calls, recoveries, files }
}

test('正常页面：取回字节并把 HTML 交给解析层', async () => {
  const f = transportFixture([{ ok: true, body: '<html><body>房源列表</body></html>' }])
  const result = await f.transport('https://bj.lianjia.com/ershoufang/chaoyang/', {})
  assert.equal(result.ok, true)
  assert.match(result.body, /房源列表/)
  assert.equal(result.captcha, false)
  assert.equal(f.calls[0].scroll, true, '列表页取数要滚动以触发懒加载')
  // 落盘路径由 Host 从受控案例目录派生，页面标题不参与拼路径。
  const { page } = pageEvidencePath({ retrievalTaskId: 'task-1', providerId: 'lianjia', caseRoot: '/cases/space/项目-001', pageDir: '来源证据/页面' }, 'chaoyang')
  assert.equal(page.startsWith('/cases/space/项目-001/来源证据/页面/'), true, page)
})

test('可见挑战：先调用固定恢复，成功后重新取原 URL', async () => {
  const f = transportFixture([
    { ok: false, failureKind: 'captcha', verdict: 'captcha', error: '页面判定为 captcha' },
    { ok: true, body: '<html><body>房源详情 998万</body></html>' },
  ])
  const result = await f.transport('https://bj.lianjia.com/ershoufang/101139646125.html', {})
  assert.equal(result.ok, true)
  assert.equal(f.recoveries.length, 1)
  assert.equal(f.recoveries[0].retrievalTaskId, 'task-1')
  assert.equal(f.recoveries[0].providerId, 'lianjia')
  assert.equal(f.calls.length, 2, '恢复后必须重新取一次原 URL')
  assert.equal(result.recovery.state, 'recovered')
  assert.match(result.notes.join('；'), /已由固定策略恢复/)
})

test('恢复未通过：保存断点，不伪造页面字节，也不把挑战页当证据', async () => {
  const f = transportFixture([{ ok: false, failureKind: 'captcha', verdict: 'captcha', error: '页面判定为 captcha' }])
  f.transport = browserTransportForTask({
    client: {
      async fetch(request) {
        f.calls.push(request)
        return {
          ok: false, failureKind: 'captcha', verdict: 'captcha', finalUrl: request.url, title: '',
          file: '', digest: '', bytes: 0, status: 200, error: '页面判定为 captcha',
        }
      },
      async status() { throw new Error('unused') }, async login() { throw new Error('unused') },
      async shot() { throw new Error('unused') }, async recover() { throw new Error('unused') },
      sites() { return '' },
    },
    coordinator: {
      async attempt(input) {
        return {
          recoveryId: 'rec', retrievalTaskId: input.retrievalTaskId, providerId: input.providerId,
          strategyId: 'auto', strategyVersion: '1', attempts: 2,
          beforeKind: 'geetest-v3-canvas', afterKind: 'geetest-v3-canvas',
          state: 'waiting-user', reasonCode: 'budget-exhausted', nextEligibleAt: '2026-10-14T10:00:00Z',
          strategies: ['geetest-v3-canvas'], notes: [],
          pageValidation: {
            finalUrl: input.url, title: '', hostMatches: true, readable: true,
            challengeVisible: true, loginWall: false, blocked: false,
            overlaySelectors: ['.geetest_panel'], reason: '自动恢复未通过：请人工完成网页验证',
          },
        }
      },
      async resume() { throw new Error('unused') }, budgetOf() { return undefined },
      cooldownUntilOf() { return 0 }, dispose() {},
    },
    readPage: async () => '',
  }, { retrievalTaskId: 'task-1', providerId: 'lianjia', caseRoot: '/cases/x', pageDir: '来源证据/页面' })

  const result = await f.transport('https://bj.lianjia.com/ershoufang/101.html', {})
  assert.equal(result.ok, false)
  assert.equal(result.body, '', '挑战页字节不许成为案例证据')
  assert.equal(result.failureKind, 'captcha')
  assert.equal(result.recovery.state, 'waiting-user')
  assert.equal(result.recovery.reasonCode, 'budget-exhausted')
  assert.match(result.notes.join('；'), /保留断点/)
})

test('真未登录引导登录，不是"验证码失败"', async () => {
  const f = transportFixture([{ ok: false, failureKind: 'login', verdict: 'login-wall', error: '页面要求登录' }])
  const result = await f.transport('https://bj.lianjia.com/ershoufang/', {})
  assert.equal(result.ok, false)
  assert.equal(result.loginRequired, true)
  assert.equal(result.captcha, false)
  assert.equal(f.recoveries.length, 0, '登录墙不该去解滑块')
})

// 协调器说 `recovered` 还不够：这一层再核一次"最终 URL 回到该来源、页面可读、无可见挑战"，
// 因为它决定**哪一页能成为案例证据**。没核过的"恢复"要如实失败，不能把那一页当原页面。
test('未通过页面核验的 recovered 不得当作恢复成功，也不得据此重取证据', async () => {
  const f = transportFixture([{ ok: false, failureKind: 'captcha', verdict: 'captcha', error: '页面判定为 captcha' }])
  const unverified = {
    recoveryId: 'rec', retrievalTaskId: 'task-1', providerId: 'lianjia',
    strategyId: 'auto', strategyVersion: '1', attempts: 1,
    beforeKind: 'site-challenge-page', afterKind: 'site-challenge-page',
    state: 'recovered', reasonCode: 'no-visible-challenge', nextEligibleAt: '',
    strategies: ['cooldown-renavigate'], notes: [],
    pageValidation: {
      finalUrl: 'https://hip.lianjia.com/captcha', title: 'CAPTCHA',
      hostMatches: false, readable: true, challengeVisible: false,
      loginWall: false, blocked: false, overlaySelectors: [], reason: '',
    },
  }
  f.transport = browserTransportForTask({
    client: {
      async fetch(request) {
        f.calls.push(request)
        return {
          ok: false, failureKind: 'captcha', verdict: 'captcha', finalUrl: request.url, title: '',
          file: '', digest: '', bytes: 0, status: 200, error: '页面判定为 captcha',
        }
      },
      async status() { throw new Error('unused') }, async login() { throw new Error('unused') },
      async shot() { throw new Error('unused') }, async recover() { throw new Error('unused') },
      sites() { return '' },
    },
    coordinator: {
      async attempt() { return unverified }, async resume() { throw new Error('unused') },
      budgetOf() { return undefined }, cooldownUntilOf() { return 0 }, dispose() {},
    },
    readPage: async () => '',
  }, { retrievalTaskId: 'task-1', providerId: 'lianjia', caseRoot: '/cases/x', pageDir: '来源证据/页面' })

  const result = await f.transport('https://bj.lianjia.com/ershoufang/101.html', {})
  assert.equal(result.ok, false)
  assert.equal(result.body, '', '挑战页字节不许成为案例证据')
  assert.equal(result.failureKind, 'captcha')
  assert.equal(result.recovery.hostMatches, false, '核验事实必须随摘要带出来')
  assert.equal(f.calls.length, 1, '未核验的 recovered 不许触发"恢复后重取原 URL"')
})

test('失败类别决定是否可重试（不能一律"请登录"）', () => {
  assert.equal(retryableOf('network'), true)
  assert.equal(retryableOf('rate-limited'), true)
  assert.equal(retryableOf('server-error'), true)
  assert.equal(retryableOf('login'), false)
  assert.equal(retryableOf('captcha'), false)
  assert.equal(retryableOf('not-found'), false)
})

test('页面字节超过上限：明确失败，不把截断后的页面当成功', async () => {
  let recoveries = 0
  const transport = browserTransportForTask({
    client: {
      async fetch(request) {
        return {
          ok: true, failureKind: '', verdict: 'ok', finalUrl: request.url, title: '',
          file: request.out, digest: 'sha256:y', bytes: 5000, status: 200, error: '',
        }
      },
      async status() { throw new Error('unused') }, async login() { throw new Error('unused') },
      async shot() { throw new Error('unused') }, async recover() { throw new Error('unused') },
      sites() { return '' },
    },
    coordinator: {
      async attempt() { recoveries += 1; throw new Error('不该尝试恢复') },
      async resume() { throw new Error('unused') },
      budgetOf() { return undefined }, cooldownUntilOf() { return 0 }, dispose() {},
    },
    readPage: async () => 'x'.repeat(5000),
    bodyMaxBytes: 1024,
  }, { retrievalTaskId: 'task-9', providerId: 'lianjia', caseRoot: '/cases/x', pageDir: '来源证据/页面' })
  const result = await transport('https://bj.lianjia.com/x/', {})
  assert.equal(result.ok, false, '截断的页面不是可用证据')
  assert.equal(result.failureKind, 'unreadable')
  assert.equal(result.body, '')
  assert.match(String(result.error), /不完整|截断|超过上限/)
  assert.equal(recoveries, 0, '截断不是挑战，不该走恢复')
})

test('UTF-8 字节超过上限（字符数没超）也要明确失败', async () => {
  const unicode = '阳'.repeat(600) // 600 chars but 1800 UTF-8 bytes > 1024
  const transport = browserTransportForTask({
    client: {
      async fetch(request) {
        return {
          ok: true, failureKind: '', verdict: 'ok', finalUrl: request.url, title: '',
          file: request.out, digest: 'sha256:y', bytes: 1800, status: 200, error: '',
        }
      },
      async status() { throw new Error('unused') }, async login() { throw new Error('unused') },
      async shot() { throw new Error('unused') }, async recover() { throw new Error('unused') },
      sites() { return '' },
    },
    coordinator: {
      async attempt() { throw new Error('不该尝试恢复') }, async resume() { throw new Error('unused') },
      budgetOf() { return undefined }, cooldownUntilOf() { return 0 }, dispose() {},
    },
    readPage: async () => unicode,
    bodyMaxBytes: 1024,
  }, { retrievalTaskId: 'task-9', providerId: 'lianjia', caseRoot: '/cases/x', pageDir: '来源证据/页面' })
  const result = await transport('https://bj.lianjia.com/x/', {})
  assert.equal(result.ok, false, '按 UTF-8 字节算超限也要失败')
  assert.equal(result.failureKind, 'unreadable')
  assert.equal(result.body, '')
})

// ── 站点城市码：中文城市名绝不能进域名（设计稿 §8.2） ──────────────────────

const { validateSiteCity, resolveSiteCity, isSafeCityCode, SITE_CITY_PATTERN } = await import(
  new URL('src/host/domains/report-evaluation/market/city.ts', ROOT).href)

test('中文城市名一律拒绝：它会被代进站点域名', () => {
  const rejected = validateSiteCity('北京')
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, '')
  assert.match(rejected.error, /非 ASCII|城市码/)
  // 这个失败必须发生在拼 URL **之前** —— 拼出 `https://北京.lianjia.com/…` 是取不到页面的。
  assert.equal(isSafeCityCode('北京'), false)
  assert.equal(SITE_CITY_PATTERN.test('北京'), false)
})

test('合法城市码大小写不敏感，统一小写', () => {
  assert.deepEqual(validateSiteCity('BJ'), { ok: true, code: 'bj', error: '' })
  assert.deepEqual(validateSiteCity(' beiJing '), { ok: true, code: 'beijing', error: '' })
  assert.equal(isSafeCityCode('sh'), true)
})

test('空格 / 点 / 斜杠 / 前导连字符 / 超长都拒绝', () => {
  for (const bad of ['', '   ', 'bei jing', 'bj.', 'bj/cn', '-bj', 'a'.repeat(40), 'bj\u0000']) {
    assert.equal(validateSiteCity(bad).ok, false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

test('来源覆盖优先于默认；没有规则就明确失败（不做拼音猜测）', () => {
  const rule = { city: 'beijing', cityByProvider: { lianjia: 'bj', anjuke: 'sh' } }
  assert.equal(resolveSiteCity(rule, 'lianjia').code, 'bj')
  assert.equal(resolveSiteCity(rule, 'anjuke').code, 'sh')
  // 规则里没写该来源的覆盖 → 用默认值。
  assert.equal(resolveSiteCity(rule, 'fang').code, 'beijing')

  const chinese = { city: '北京' }
  const failed = resolveSiteCity(chinese, 'lianjia')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /lianjia/)

  const noRule = resolveSiteCity(null, 'lianjia')
  assert.equal(noRule.ok, false)
  assert.match(noRule.error, /没有可用的选例规则/)
})

test('拼 URL 的最后一道：中文城市名不许进域名（服务端也会在拼串处拒绝）', async () => {
  const { expandTemplate } = await import(
    new URL('src/host/domains/report-evaluation/browser/providers.ts', ROOT).href)
  // 合法城市码照常拼。
  assert.equal(
    expandTemplate('https://{city}.lianjia.com/ershoufang/{keyword}pg{page}/', { city: 'bj', keyword: '太阳公元', page: 1 }),
    'https://bj.lianjia.com/ershoufang/%E5%A4%AA%E9%98%B3%E5%85%AC%E5%85%83pg1/',
  )
  // 中文城市名在**拼串处**就被拒（不是等到浏览器去打一个不存在的域名）。
  assert.throws(
    () => expandTemplate('https://{city}.lianjia.com/ershoufang/', { city: '北京' }),
    /站点城市标识不合规/,
  )
  // 不含 `{city}` 的模板不受影响（其他参数照旧编码）。
  assert.equal(expandTemplate('https://search.fang.com/house/?keyword={keyword}', { keyword: '太阳公元' }),
    'https://search.fang.com/house/?keyword=%E5%A4%AA%E9%98%B3%E5%85%AC%E5%85%83')
})

// ── 截图证据能力（设计稿 §11.2） ───────────────────────────────────────────

const { createBrowserScreenshotCapability, screenshotDirectoryName, SCREENSHOT_DIR } = await import(
  new URL('src/host/domains/report-evaluation/browser/screenshot.ts', ROOT).href)

function shotClient(outcome) {
  const calls = []
  return {
    calls,
    client: {
      async shot(request) {
        calls.push(request)
        return {
          ok: outcome.ok, failureKind: outcome.failureKind ?? '', verdict: outcome.verdict ?? '',
          finalUrl: outcome.finalUrl ?? request.url, title: '', file: outcome.ok ? request.out : '',
          digest: outcome.digest ?? '', bytes: outcome.bytes ?? 0, status: 200, error: outcome.error ?? '',
        }
      },
      async fetch() { throw new Error('unused') }, async status() { throw new Error('unused') },
      async login() { throw new Error('unused') }, async recover() { throw new Error('unused') },
      sites() { return '' },
    },
  }
}

test('截图落点是 推理结果/图片/<caseId-名称>/，文件名带来源，指纹来自 CLI', async () => {
  const { client, calls } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096 })
  const capability = createBrowserScreenshotCapability({
    client,
    displayNameOf: (caseId) => (caseId === 'C001' ? '太阳公元' : ''),
  })
  const result = await capability({ url: 'https://bj.lianjia.com/ershoufang/1.html', casePath: '/cases/x/项目-001', source: 'lianjia', caseId: 'C001' })
  assert.equal(result.ok, true)
  assert.equal(result.digest, 'sha256:png')
  assert.equal(result.bytes, 4096)
  assert.equal(result.sourceUrl, 'https://bj.lianjia.com/ershoufang/1.html',
    '成功结果必须带回截图这次导航的最终地址')
  assert.match(result.file, /^推理结果\/图片\/C001-太阳公元\/lianjia-C001.*\.png$/)
  // CLI 的落盘目标必须是案例目录下的绝对路径（调用方提交不了输出目录）。
  assert.equal(calls[0].out, `/cases/x/项目-001/${result.file}`)
  assert.equal(calls[0].fullPage, true)
})

test('页面没通过校验（登录墙/验证码/拦截）→ 没有截图，绝不拿页面字节顶替', async () => {
  const { client } = shotClient({ ok: false, verdict: 'captcha', failureKind: 'captcha', error: '' })
  const capability = createBrowserScreenshotCapability({ client })
  const result = await capability({ url: 'https://bj.lianjia.com/x', casePath: '/cases/x', source: 'lianjia', caseId: 'C001' })
  assert.equal(result.ok, false)
  assert.equal(result.file, '')
  assert.equal(result.digest, '')
  assert.match(result.error, /未通过校验|captcha/)
})

test('CLI 说成功却没给指纹/字节 → 按失败处理（没有指纹的证据无法核对）', async () => {
  const { client } = shotClient({ ok: true, digest: '', bytes: 0 })
  const capability = createBrowserScreenshotCapability({ client })
  const result = await capability({ url: 'https://bj.lianjia.com/x', casePath: '/cases/x', source: 'lianjia', caseId: 'C001' })
  assert.equal(result.ok, false)
  assert.match(result.error, /指纹/)
})

test('缺案例目录 / 缺 URL → 如实失败，不去猜路径', async () => {
  const { client, calls } = shotClient({ ok: true, digest: 'sha256:x', bytes: 1 })
  const capability = createBrowserScreenshotCapability({ client })
  assert.equal((await capability({ url: 'https://x/', casePath: '', source: 'lianjia', caseId: 'C001' })).ok, false)
  assert.equal((await capability({ url: '', casePath: '/cases/x', source: 'lianjia', caseId: 'C001' })).ok, false)
  assert.equal(calls.length, 0, '参数不成立时一个命令都不该发')
})

test('目录名把不安全的 caseId 折成可用片段，身份仍是 caseId', () => {
  assert.equal(screenshotDirectoryName('C001', '太阳公元'), 'C001-太阳公元')
  assert.equal(screenshotDirectoryName('C001', ''), 'C001')
  // 路径分隔符与 `..` 会被折掉 —— 目录名不能越出 推理结果/图片/。
  const folded = screenshotDirectoryName('../escape/1', '')
  assert.equal(folded.includes('/'), false)
  assert.equal(folded.includes('..'), false)
})

// ── 取数通道按来源分开（设计稿 §8.4） ──────────────────────────────────────

test('P8 取数任务 id 由 项目/方案/来源/页面/检索要素 派生：同一任务对得上，跨项目不共用预算', async () => {
  const { retrievalTaskIdOf } = await import(
    new URL('src/host/tools/report-evaluation/market-search.ts', ROOT).href)
  const base = { projectId: '估值-20261012-160000-bb22', planId: 'plan-001', providerId: 'lianjia', pageNo: 1, keyword: '太阳公元', city: 'beijing' }
  const same = retrievalTaskIdOf(base)
  assert.equal(same, retrievalTaskIdOf({ ...base }), '同一身份必须是同一个任务 id')
  // 来源不同 → 任务不同：否则"链家被打断"会吃掉"房天下"的自动恢复预算。
  assert.notEqual(same, retrievalTaskIdOf({ ...base, providerId: 'fang' }))
  assert.notEqual(same, retrievalTaskIdOf({ ...base, keyword: '太阳宫' }))
  assert.notEqual(same, retrievalTaskIdOf({ ...base, city: 'shanghai' }))
  // **项目 / 方案 / 页面**也必须是身份的一部分：跨项目查同一个小区不能共用预算，
  // 预检页（pageNo 0）也不能和第 1 页检索页共用一个断点。
  assert.notEqual(same, retrievalTaskIdOf({ ...base, projectId: '估值-别的项目' }))
  assert.notEqual(same, retrievalTaskIdOf({ ...base, planId: 'plan-002' }))
  assert.notEqual(same, retrievalTaskIdOf({ ...base, pageNo: 0 }))
  assert.notEqual(same, retrievalTaskIdOf({ ...base, pageNo: 2 }))
  // 不能带路径分隔符（它同时是证据文件名前缀与恢复记录的键）。
  assert.equal(retrievalTaskIdOf({ ...base, keyword: 'a/b\\c' }).includes('/'), false)
  assert.equal(retrievalTaskIdOf({ ...base, keyword: 'a/b\\c', projectId: 'x'.repeat(300) }).length < 130, true, '截断后仍要短')
})

// ── P9 · 截图输出目录在 shot 之前幂等创建 ────────────────────────────────────

test('P9 截图：shot --out 之前先建输出目录（CLI 不建父目录，首次运行会 ENOENT）', async () => {
  const { client, calls } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096 })
  const created = []
  let present = false
  const capability = createBrowserScreenshotCapability({
    client: { ...client, async shot(request) { assert.equal(present, true, '目录必须先存在再调 shot'); return await client.shot(request) } },
    displayNameOf: () => '太阳公元',
    ensureDirectory: async (absolutePath, request) => {
      created.push(absolutePath)
      assert.equal(request.caseId, 'C001')
      present = true
      return { ok: true, error: '' }
    },
  })
  const result = await capability({ url: 'https://bj.lianjia.com/ershoufang/1.html', casePath: '/cases/x/项目-001', source: 'lianjia', caseId: 'C001' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(created, ['/cases/x/项目-001/推理结果/图片/C001-太阳公元'])
  assert.equal(calls.length, 1)
})

test('P9 截图：目录建不出来是**文件错误**，不是"页面没通过校验"', async () => {
  const { client, calls } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096 })
  const capability = createBrowserScreenshotCapability({
    client,
    ensureDirectory: async () => ({ ok: false, error: 'Operation not permitted' }),
  })
  const result = await capability({ url: 'https://bj.lianjia.com/x', casePath: '/cases/x', source: 'lianjia', caseId: 'C001' })
  assert.equal(result.ok, false)
  assert.match(result.error, /截图目录创建失败/)
  assert.match(result.error, /不是页面校验问题/)
  assert.equal(calls.length, 0, '目录都没建好就不该去截图')
})

test('P9 截图：同一请求截两次得到两个不同文件且都保留', async () => {
  const { client, calls } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096 })
  const capability = createBrowserScreenshotCapability({ client, displayNameOf: () => '太阳公元' })
  const request = {
    url: 'https://bj.lianjia.com/ershoufang/1.html',
    casePath: '/cases/x/项目-001', source: 'lianjia', caseId: 'C001',
  }
  const first = await capability(request)
  const second = await capability(request)
  assert.equal(first.ok, true, first.error)
  assert.equal(second.ok, true, second.error)
  assert.notEqual(first.file, second.file, '重复截图不能覆盖旧图')
  assert.match(first.file, /^推理结果\/图片\/C001-太阳公元\/lianjia-C001.*\.png$/)
  assert.match(second.file, /^推理结果\/图片\/C001-太阳公元\/lianjia-C001.*\.png$/)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].out, calls[1].out, '两次截图的落盘路径必须不同')
})

test('截图是独立的一次导航：CLI 最终地址与请求详情不一致时拒绝', async () => {
  const { client } = shotClient({
    ok: true, digest: 'sha256:png', bytes: 4096,
    finalUrl: 'https://example.invalid/detail/other',
  })
  const capability = createBrowserScreenshotCapability({ client })
  const result = await capability({
    url: 'https://example.invalid/detail/original', casePath: '/cases/x', source: 'fang', caseId: 'C001',
  })
  assert.equal(result.ok, false, '截图导航到别的详情页不能当原案例证据')
  assert.equal(result.file, '')
  assert.match(result.error, /不一致|详情|other/)
})

test('截图成功但 CLI 没给最终地址：拒绝，不得拿请求 URL 顶替', async () => {
  const { client } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096, finalUrl: '' })
  const capability = createBrowserScreenshotCapability({ client })
  const result = await capability({
    url: 'https://example.invalid/detail/original', casePath: '/cases/x', source: 'fang', caseId: 'C001',
  })
  assert.equal(result.ok, false)
  assert.equal(result.file, '')
})

test('截图结果带回已核验的 sourceUrl 与显式 evidenceType', async () => {
  const { client } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096 })
  const capability = createBrowserScreenshotCapability({ client })
  const result = await capability({
    url: 'https://example.invalid/detail/original', casePath: '/cases/x', source: 'fang',
    caseId: 'C001', evidenceType: 'detail-screenshot',
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.sourceUrl, 'https://example.invalid/detail/original')
  assert.equal(result.evidenceType, 'detail-screenshot')
})

test('截图目录优先使用请求自带的 displayName', async () => {
  const { client } = shotClient({ ok: true, digest: 'sha256:png', bytes: 4096 })
  const capability = createBrowserScreenshotCapability({ client, displayNameOf: () => '回调名' })
  const result = await capability({
    url: 'https://example.invalid/detail/original', casePath: '/cases/x', source: 'fang',
    caseId: 'C001', displayName: '请求名',
  })
  assert.equal(result.ok, true, result.error)
  assert.match(result.file, /^推理结果\/图片\/C001-请求名\//)
})
