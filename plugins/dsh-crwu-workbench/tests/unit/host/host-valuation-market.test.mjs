/**
 * 外部案例框架（协议 32）的纯逻辑测试：尝试策略、登录状态 → 阶段、字段标准化与挂牌纪律。
 *
 * 每条断言都对着一个**会把错误数字带进估值**的失效模式：
 *
 * 1. 尝试次数必须**有界**且恰好是三次 —— 外部站点风控按频率封禁，"再试一次"是最容易
 *    把员工 IP 送进黑名单的做法；
 * 2. 三次失败后，**登录状态未确认**时必须停在 `browser-login-required`（可恢复），
 *    而已确认登录的失败只记缺口、不阻塞其他来源 —— 反过来会让员工反复登录一个没坏的账号；
 * 3. **挂牌价绝不能被当成成交价**：挂牌是卖方要价，系统性高于成交价，混用会把估值整体抬高；
 *    而且缺省必须是"未知"，不是"成交"；
 * 4. 解析价格靠**单位词**（万/亿）而不是数量级猜：`180` 既可能是 180 万也可能是 180 元；
 * 5. 拿不到的字段一律 `null`，**不填 0** —— "没有单价"与"单价为零"在后续校验里完全不同。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  MARKET_ATTEMPTS,
  withAttempts,
} = await import(new URL('src/host/domains/report-evaluation/browser/retry.ts', ROOT).href)
const {
  MARKET_PROVIDER_IDS,
  decidePhase,
  loginGapText,
  loginStateLabel,
  loginStateOf,
  providerLabel,
} = await import(new URL('src/host/domains/report-evaluation/browser/login-state.ts', ROOT).href)
const {
  isAllowedProvider,
  narrowProviders,
  providerCatalogue,
} = await import(new URL('src/host/domains/report-evaluation/browser/provider.ts', ROOT).href)
// 案例标准化在 `market/`：字段别名与"挂牌 ≠ 成交"的纪律归它，与来源框架分开放。
// 这一层刻意**不**从 `browser/` 再导出一次 —— 两个入口导出同一个名字，下一个人就会
// 在错的模块里改行为。
const {
  caseCounts,
  caseIsComparable,
  knownFieldAliases,
  normalizeCase,
  parseArea,
  parsePrice,
  transactionTypeOf,
  unitPriceOf,
} = await import(new URL('src/host/domains/report-evaluation/market/normalize.ts', ROOT).href)
const { listingsFromJsonLd } = await import(
  new URL('src/host/domains/report-evaluation/market/jsonld.ts', ROOT).href)

// ── 尝试策略 ────────────────────────────────────────────────────────────────

test('每个分页最多尝试两次：第二次失败即停，绝不尝试第三次', async () => {
  assert.equal(MARKET_ATTEMPTS, 2)
  const attempts = []
  const outcome = await withAttempts(async (attempt) => {
    attempts.push(attempt)
    throw new Error(`第 ${attempt} 次失败`)
  })
  assert.deepEqual(attempts, [1, 2], '恰好两次')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.attempts, 2)
  assert.deepEqual(outcome.errors, ['第 1 次失败', '第 2 次失败'], '每次失败都要留下证据')
})

test('成功即停：第一次就成功时不重试', async () => {
  const attempts = []
  const outcome = await withAttempts(async (attempt) => {
    attempts.push(attempt)
    return 'ok'
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.value, 'ok')
  assert.deepEqual(attempts, [1])
  assert.equal(outcome.attempts, 1)
})

test('第二次成功：记录先前失败，但值为第二次的结果', async () => {
  const outcome = await withAttempts(async (attempt) => {
    if (attempt === 1) throw new Error('网络抖动')
    return attempt
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.value, 2)
  assert.equal(outcome.attempts, 2)
  assert.deepEqual(outcome.errors, ['网络抖动'])
})

test('失败后不再多等一个周期（最后一次之后不 sleep）', async () => {
  const sleeps = []
  await withAttempts(async () => { throw new Error('x') }, {
    // 这里的 3 是**显式传值**，刻意为的是让「n 次尝试只有 n-1 个间隔」这条算术可读；
    // 它不读 `MARKET_ATTEMPTS`，所以常量改成 2 不影响本用例（那正是本用例要分开证明的事）。
    attempts: 3, delayMs: 10, sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.deepEqual(sleeps, [10, 10], '三次尝试只有两次间隔')
})

test('非 Error 抛出也收敛成一行文案（不许把整轮搜索打崩）', async () => {
  const outcome = await withAttempts(async () => { throw '字符串错误' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errors[0], '字符串错误')
})

// ── 登录状态 ────────────────────────────────────────────────────────────────

test('登录状态只认三个值；认不出来是 unknown（不假设已登录，也不假设未登录）', () => {
  assert.equal(loginStateOf('authenticated'), 'authenticated')
  assert.equal(loginStateOf('unauthenticated'), 'unauthenticated')
  assert.equal(loginStateOf('unknown'), 'unknown')
  for (const bad of ['', '已登录', true, null, undefined, {}]) {
    assert.equal(loginStateOf(bad), 'unknown', JSON.stringify(bad))
  }
  assert.deepEqual(
    ['authenticated', 'unauthenticated', 'unknown'].map(loginStateLabel),
    ['已登录', '未登录', '无法检查'],
  )
})

const run = (patch) => ({
  id: 'fang', login: 'authenticated', failedPages: 0, fetchedPages: 1, caseCount: 1,
  attemptLimit: MARKET_ATTEMPTS, detail: '', ...patch,
})

test('P13 三次失败：登录墙进 needsLogin、unknown 进 unconfirmed —— 两类处置不同，都不阻断整轮', () => {
  // 登录墙：唯一"去登录"的一类。协议 39 起它**不阻断**整轮 —— 改用其它来源继续。
  const wall = decidePhase([run({ login: 'unauthenticated', failedPages: 3, fetchedPages: 0, caseCount: 0, detail: '页面提示需要登录' })])
  assert.equal(wall.phase, 'browser-login-required')
  assert.equal(wall.canProceed, true, '未登录不阻止整轮：改用替代来源继续')
  assert.deepEqual(wall.needsLogin, ['fang'])
  assert.deepEqual(wall.unconfirmed, [])
  assert.match(wall.detail, /未登录/)
  assert.match(wall.detail, /改用其它来源/)

  // 登录状态**没确认**（网络 / 验证码 / 站点错误）：分类保留，但**不是**"去登录"。
  const unsure = decidePhase([run({ login: 'unknown', failedPages: 3, fetchedPages: 0, caseCount: 0, detail: '请求超时' })])
  assert.equal(unsure.phase, 'browser-login-required')
  assert.equal(unsure.canProceed, true, '没确认也不阻断整轮：按真实类别处置并继续替代来源')
  assert.deepEqual(unsure.needsLogin, [], 'unknown 不是登录失败')
  assert.deepEqual(unsure.unconfirmed, ['fang'])
  assert.match(unsure.detail, /没能确认/)
  assert.match(unsure.detail, /不要\*\*当成"没登录"/)
})

test('P13 两类同时出现时：needsLogin 与 unconfirmed 各自成列，下一步各说各的', () => {
  const decision = decidePhase([
    run({ id: 'fang', login: 'unauthenticated', failedPages: 3, fetchedPages: 0, caseCount: 0, detail: '登录墙' }),
    run({ id: 'lianjia', login: 'unknown', failedPages: 3, fetchedPages: 0, caseCount: 0, detail: '要求验证码' }),
  ])
  assert.deepEqual(decision.needsLogin, ['fang'])
  assert.deepEqual(decision.unconfirmed, ['lianjia'])
  assert.match(decision.detail, /房天下 未登录/)
  assert.match(decision.detail, /链家 的页面没有取到/)
  // 链家那一段必须是"按真实类别处置"，而不是"去登录"。
  const lianjia = decision.detail.slice(decision.detail.indexOf('链家'))
  assert.match(lianjia, /不要\*\*当成"没登录"/)
  assert.equal(/请在默认浏览器登录/.test(lianjia), false, '验证码/网络问题不该让员工去重新登录')
})

test('已确认登录却仍然失败 → 只记缺口继续其他来源（不让员工白登录一次）', () => {
  const decision = decidePhase([
    run({ login: 'authenticated', failedPages: 2, fetchedPages: 3, caseCount: 12 }),
    run({ id: 'anjuke', login: 'authenticated', failedPages: 0, fetchedPages: 2, caseCount: 8 }),
  ])
  assert.equal(decision.phase, 'running')
  assert.equal(decision.canProceed, true)
  assert.deepEqual(decision.needsLogin, [])
  assert.deepEqual(decision.failed, ['fang'])
  assert.match(decision.detail, /房天下/)
  assert.match(decision.detail, /能力缺口/)
})

test('一个来源需要登录时整轮停在登录页（其他来源照常保留结果）', () => {
  const decision = decidePhase([
    run({ id: 'fang', login: 'authenticated', failedPages: 0 }),
    run({ id: 'lianjia', login: 'unauthenticated', failedPages: 3, fetchedPages: 0, caseCount: 0 }),
  ])
  assert.equal(decision.phase, 'browser-login-required')
  assert.deepEqual(decision.needsLogin, ['lianjia'])
  assert.equal(decision.failed.length, 0)
  assert.match(decision.detail, /链家/)
})

test('全部成功（包括"都没抓到案例"）就是 completed，不误报登录问题', () => {
  const decision = decidePhase([run({ caseCount: 0, fetchedPages: 1, failedPages: 0 })])
  assert.equal(decision.phase, 'completed')
  assert.equal(decision.canProceed, true)
  assert.equal(decision.detail, '')
})

test('P13 缺口文案分得清"登录墙"、"状态未确认"与"已放行但抓不到"', () => {
  const wall = loginGapText(run({ login: 'unauthenticated', failedPages: 3, fetchedPages: 0, caseCount: 0, detail: '页面要求登录' }))
  assert.match(wall, /被登录墙挡住/)
  assert.match(wall, /请.*登录该来源/)
  assert.match(wall, /不作为案例依据/)

  const unsure = loginGapText(run({ login: 'unknown', failedPages: 3, fetchedPages: 0, caseCount: 0, detail: '请求超时' }))
  assert.match(unsure, /登录状态未确认/)
  assert.match(unsure, /不等于"没登录"/)
  assert.match(unsure, /不作为案例依据/)

  const logged = loginGapText(run({ login: 'authenticated', failedPages: 2 }))
  assert.match(logged, /已确认放行但/)
  assert.match(logged, /最多 2 次尝试/)
})

// ── 来源白名单 ──────────────────────────────────────────────────────────────

test('来源白名单四家（协议 39 补上 58 同城），展示名与枚举一一对应', () => {
  assert.deepEqual([...MARKET_PROVIDER_IDS], ['fang', 'anjuke', 'lianjia', 'wuba'])
  assert.deepEqual(providerCatalogue(), [
    { id: 'fang', label: '房天下' },
    { id: 'anjuke', label: '安居客' },
    { id: 'lianjia', label: '链家' },
    { id: 'wuba', label: '58同城' },
  ])
  assert.equal(isAllowedProvider('fang'), true)
  for (const bad of ['baidu', 'FANG', '', '安居客', null]) {
    assert.equal(isAllowedProvider(bad), false, JSON.stringify(bad))
  }
  assert.equal(providerLabel('anjuke'), '安居客')
})

test('来源清单：空 = 全部；含非法名字时**整批拒绝**（不许静默忽略）', () => {
  assert.deepEqual(narrowProviders([]), { ok: true, ids: ['fang', 'anjuke', 'lianjia', 'wuba'] })
  assert.deepEqual(narrowProviders(undefined), { ok: true, ids: ['fang', 'anjuke', 'lianjia', 'wuba'] })
  assert.deepEqual(narrowProviders(['fang', 'fang', 'lianjia']), { ok: true, ids: ['fang', 'lianjia'] }, '去重')
  const bad = narrowProviders(['fang', 'baidu'])
  assert.equal(bad.ok, false)
  assert.match(bad.error, /baidu/)
  assert.match(bad.error, /房天下/)
})

// ── 价格与面积解析 ──────────────────────────────────────────────────────────

test('价格按**单位词**换算，不靠数量级猜', () => {
  assert.equal(parsePrice('180万'), 1_800_000)
  assert.equal(parsePrice('1,800,000'), 1_800_000)
  assert.equal(parsePrice('1800000元'), 1_800_000)
  assert.equal(parsePrice('1.5亿'), 150_000_000)
  assert.equal(parsePrice('18000 元/㎡'), 18_000)
  // 三位数不带"万"时按元 —— 不猜成 180 万（那会把估值放大一万倍）。
  assert.equal(parsePrice('180'), 180)
  for (const bad of ['', '面议', '暂无', null, '0', '-5']) {
    assert.equal(parsePrice(bad), null, JSON.stringify(bad))
  }
})

test('面积解析：拿不到返回 null（不是 0）', () => {
  assert.equal(parseArea('120.5㎡'), 120.5)
  assert.equal(parseArea('120 平方米'), 120)
  for (const bad of ['', '暂无', null, '0']) {
    assert.equal(parseArea(bad), null, JSON.stringify(bad))
  }
})

test('单价优先用页面给的，否则总价/面积；缺一返回 null', () => {
  assert.equal(unitPriceOf(1_800_000, 120, '15000 元/㎡'), 15_000, '页面给了单价就用它')
  assert.equal(unitPriceOf(1_800_000, 120), 15_000)
  assert.equal(unitPriceOf(1_800_000, null), null, '缺面积算不出单价')
  assert.equal(unitPriceOf(null, 120), null)
  assert.equal(unitPriceOf(1_800_000, 0), null, '面积为零是脏数据，不算')
})

// ── 挂牌 / 成交纪律 ─────────────────────────────────────────────────────────

test('交易类型：**只有**明确写"成交"才算成交；缺省是"未知"而不是"成交"', () => {
  assert.equal(transactionTypeOf('成交价 180 万'), '成交')
  assert.equal(transactionTypeOf('房源已成交'), '成交')
  assert.equal(transactionTypeOf('sold out'), '成交')
  assert.equal(transactionTypeOf('挂牌价 200 万'), '挂牌')
  assert.equal(transactionTypeOf('售价 200 万'), '挂牌')
  assert.equal(transactionTypeOf('总价 200 万'), '挂牌')
  assert.equal(transactionTypeOf('价格面议'), '询价')
  assert.equal(transactionTypeOf(''), '未知')
  assert.equal(transactionTypeOf('三室两厅 南北通透'), '未知', '没有交易字样就是未知')
})

test('同时出现成交与挂牌时以**成交**为准（页面常把成交价与挂牌价并列）', () => {
  assert.equal(transactionTypeOf('成交价 180 万（挂牌价 200 万）'), '成交')
})

test('标准化：挂牌案例的 unitPrice 照算，但**不可直接作可比实例**', () => {
  const listed = normalizeCase({
    source: 'fang', url: 'https://example.invalid/a',
    title: '某小区 3室 挂牌价 200 万',
    fields: { 建筑面积: '100㎡', 总价: '200万', 小区: '某小区', 用途: '住宅' },
  })
  assert.equal(listed.transactionType, '挂牌')
  assert.equal(listed.price, 2_000_000)
  assert.equal(listed.unitPrice, 20_000)
  assert.equal(caseIsComparable(listed), false, '挂牌价绝不能直接当可比实例')

  const sold = normalizeCase({
    source: 'lianjia', url: 'https://example.invalid/b',
    title: '某小区 3室 成交价 180 万',
    fields: { 建筑面积: '100㎡', 成交价: '180万' },
  })
  assert.equal(sold.transactionType, '成交')
  assert.equal(sold.unitPrice, 18_000)
  assert.equal(caseIsComparable(sold), true)
})

test('标准化：字段别名跨站点识别（中文/英文/驼峰都认）', () => {
  const item = normalizeCase({
    source: 'anjuke', url: 'https://example.invalid/c', title: 't',
    fields: {
      communityName: '阳光小区', buildingArea: '88.5', totalFloors: '18',
      builtAge: '2010年', fitment: '精装', usage: '住宅', publishTime: '2026-09-01',
    },
  })
  assert.equal(item.community, '阳光小区')
  assert.equal(item.buildingArea, 88.5)
  assert.equal(item.totalFloors, '18')
  assert.equal(item.builtYear, '2010年')
  assert.equal(item.decoration, '精装')
  assert.equal(item.purpose, '住宅')
  assert.equal(item.publishedAt, '2026-09-01')
  assert.equal(item.sourceLabel, '安居客')
})

test('标准化：拿不到的字段是空串 / null，并且**说得出缺什么**', () => {
  const item = normalizeCase({ source: 'fang', url: 'https://example.invalid/d', title: '只有标题', fields: {} })
  assert.equal(item.buildingArea, null)
  assert.equal(item.price, null)
  assert.equal(item.unitPrice, null)
  assert.equal(item.community, '')
  assert.equal(item.capturedAt.length > 0, true, '抓取时间必须有（可追溯）')
  assert.equal(item.notes.some((note) => /建筑面积/.test(note)), true)
  assert.equal(item.notes.some((note) => /价格/.test(note)), true)
  assert.equal(item.notes.some((note) => /挂牌\/成交/.test(note)), true)
})

test('标准化：抓取时刻可以被注入（可复现的证据时间）', () => {
  const item = normalizeCase(
    { source: 'fang', url: 'u', title: 't', fields: {} },
    { capturedAt: '2026-10-12T00:00:00.000Z' },
  )
  assert.equal(item.capturedAt, '2026-10-12T00:00:00.000Z')
})

test('两个入口各司其职：来源框架在 browser/，字段标准化在 market/', async () => {
  const loginState = await import(new URL('src/host/domains/report-evaluation/browser/login-state.ts', ROOT).href)
  const normalize = await import(new URL('src/host/domains/report-evaluation/market/normalize.ts', ROOT).href)
  assert.equal('normalizeCase' in loginState, false, '标准化不许从 browser/ 再导出（否则改错模块也看不出来）')
  assert.equal(typeof normalize.normalizeCase, 'function')
  assert.equal('decidePhase' in normalize, false)
})

test('案例统计：按交易类型分别计数，可比实例只算成交', () => {
  const made = (transactionType, unitPrice = 15_000) => ({
    ...normalizeCase({ source: 'fang', url: 'u', title: 't', fields: {} }),
    transactionType, unitPrice, buildingArea: 100,
  })
  const counts = caseCounts([made('挂牌'), made('挂牌'), made('成交'), made('未知'), made('成交', null)])
  assert.deepEqual(counts, { 挂牌: 2, 成交: 2, 询价: 0, 未知: 1, total: 5, comparable: 1 })
})

test('JSON-LD 读出来的键名**全部**能被别名表识别（漏一个就会静默丢字段）', () => {
  // 两份列表（JSON-LD 那边产出的键 vs 别名表认得的名字）漂移的症状是"某字段静默为 null"：
  // 不报错、不缺数据的样子，只有最终数字不对。`floorSize` 就这么漏过一次 ——
  // 面积拿不到 → 单价算不出 → 市场法失去唯一的可比指标。
  const aliases = new Set(knownFieldAliases())
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'RealEstateListing',
    name: 'n', url: 'u', price: '100万',
    address: { '@type': 'PostalAddress', streetAddress: 'x' },
    floorSize: { value: 90, unitText: '㎡' },
    numberOfFloorLevels: 18, floorLevel: 6, yearBuilt: 2010,
    datePosted: '2026-01-01', itemCondition: '精装', description: 'd',
    numberOfRooms: 3, priceCurrency: 'CNY',
  })}</script>`
  const { listings } = listingsFromJsonLd(html, 'fang')
  assert.equal(listings.length, 1, '前提：这段 JSON-LD 要被认成房源')
  const produced = Object.keys(listings[0].fields).map((key) => key.toLowerCase().replace(/[\s_-]+/g, ''))
  assert.ok(produced.length >= 8, `产出字段太少：${produced.join('、')}`)
  for (const key of produced) {
    assert.equal(aliases.has(key), true, `JSON-LD 产出的字段「${key}」在别名表里没有对应项：它会被静默丢掉`)
  }
})

test('JSON-LD 的 floorSize 真的能推出单价（回归：曾因别名漏项静默为 null）', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'RealEstateListing', name: '成交价 180 万', url: 'u/2',
    floorSize: { value: 90, unitText: '㎡' }, price: '180万',
  })}</script>`
  const { listings } = listingsFromJsonLd(html, 'lianjia')
  const item = normalizeCase(listings[0])
  assert.equal(item.buildingArea, 90)
  assert.equal(item.price, 1_800_000)
  assert.equal(item.unitPrice, 20_000)
  assert.equal(item.transactionType, '成交')
  assert.equal(caseIsComparable(item), true)
})

// ── 预检失败的分类（§11.2）──────────────────────────────────────────────────
//
// 预检要区分四类：**需要登录 / 验证码或人机校验 / 网络超时或不可达 / 站点返回错误**。
// 为什么必须分开：它们的处置完全不同（去登录 vs 人工过验证 vs 换网络 vs 等站点恢复），
// 合成一句"无法检查"等于让用户自己猜。第五类「页面结构无法识别」不在预检这一层 ——
// 预检看的是"站点放不放行公开检索"，首页本来就没有房源列表；结构问题由检索那一步报
//（`页面取到了，但没有可用的结构化房源数据（不猜测）`，见 host-valuation-market-tool）。

test('预检分类：网络失败 / 验证码 / 登录墙 / 站点错误 各自给不同的话', async () => {
  const { classifyProbe } = await import(
    new URL('src/host/domains/report-evaluation/browser/login-probe.ts', ROOT).href)

  // ① 网络不可达 / 超时：换网络，不是去登录。
  const offline = classifyProbe({ ok: false, error: '连接超时', status: 0, body: '' })
  assert.equal(offline.state, 'unknown')
  assert.match(offline.detail, /无法访问该来源/)
  assert.match(offline.detail, /连接超时/)
  assert.equal(offline.captcha, false)

  // ② 验证码 / 人机校验：要人工过验证，插件不绕过。
  const captcha = classifyProbe({ ok: true, error: '', status: 200, body: '<div>请完成滑动验证后继续</div>' })
  assert.equal(captcha.state, 'unknown')
  assert.equal(captcha.captcha, true, '验证码要单独标出来')
  assert.match(captcha.detail, /验证码 \/ 人机校验/)
  assert.match(captcha.detail, /不会绕过验证/)

  // ③ 登录墙：去登录，不是网络问题。
  const wall = classifyProbe({ ok: true, error: '', status: 200, body: '<form class="login">请登录后查看</form>' })
  assert.equal(wall.state, 'unauthenticated')
  assert.match(wall.detail, /需要登录/)

  // ④ 站点返回错误：等站点恢复，或人工看一眼。
  const http500 = classifyProbe({ ok: true, error: '', status: 503, body: '' })
  assert.equal(http500.state, 'unknown')
  assert.match(http500.detail, /HTTP 503/)
  assert.match(classifyProbe({ ok: true, error: '', status: 0, body: '' }).detail, /没有拿到 HTTP 状态码/)

  // ⑤ 正常放行公开检索。
  const fine = classifyProbe({ ok: true, error: '', status: 200, body: '<html><body>房源列表</body></html>' })
  assert.equal(fine.state, 'authenticated')

  // 四类互不混淆：三种 `unknown`（网络 / 验证码 / 站点错误）的话各不相同，登录墙单独一态。
  const unknowns = [offline, captcha, http500]
  assert.deepEqual(unknowns.map((one) => one.state), ['unknown', 'unknown', 'unknown'])
  assert.equal(new Set(unknowns.map((one) => one.detail)).size, 3, '三种 unknown 的说明必须各不相同')
  assert.equal(wall.state, 'unauthenticated')
  assert.equal(fine.state, 'authenticated')
})

// ── 抓取失败的分类（§7.3：重试要区分这几类）────────────────────────────────

test('抓取失败分类：需要登录 / 验证码 / 限流 / 页面失效 / 站点错误 / 网络 各是一类', async () => {
  const { classifyFetchFailure, failureKindLabel } = await import(
    new URL('src/host/domains/report-evaluation/browser/fetch-transport.ts', ROOT).href)

  const of = (patch) => classifyFetchFailure({ ok: false, status: 200, ...patch })
  // ① 验证码优先于登录墙：被验证码挡住时页面里常有登录表单痕迹，
  //    说成"需要登录"会让用户反复登录而永远过不去。
  assert.equal(of({ captcha: true, loginRequired: true }), 'captcha')
  assert.equal(of({ loginRequired: true }), 'login')
  // ② 限流 / 风控：429 与 403 都要等一会儿，不是去登录。
  assert.equal(of({ status: 429 }), 'rate-limited')
  assert.equal(of({ status: 403 }), 'rate-limited')
  // ③ 页面失效：模板过期了（404 / 410）。
  assert.equal(of({ status: 404 }), 'not-found')
  assert.equal(of({ status: 410 }), 'not-found')
  // ④ 站点错误：5xx 与"拿不到状态码"。
  assert.equal(of({ status: 503 }), 'server-error')
  assert.equal(of({ status: 0 }), 'server-error')
  // ⑤ 401 是登录；认不出来的状态码不猜。
  assert.equal(of({ status: 401 }), 'login')
  assert.equal(of({ status: 418 }), 'unknown')
  // ⑥ 成功没有类别。
  assert.equal(classifyFetchFailure({ ok: true, status: 200 }), '')

  // 每一类都有单独的人话（重试记录里要看得出来是哪一类）。
  const kinds = ['login', 'captcha', 'rate-limited', 'not-found', 'server-error', 'network', 'blocked', 'unreadable', 'unknown']
  const labels = kinds.map((kind) => failureKindLabel(kind))
  assert.equal(new Set(labels).size, kinds.length, '每类失败的人话必须互不相同')
  assert.equal(failureKindLabel(''), '')
})

test('抓取通道：网络异常 / 白名单外重定向 / 状态码失败 都带上类别与可区分的话', async () => {
  const { fetchTransport } = await import(
    new URL('src/host/domains/report-evaluation/browser/fetch-transport.ts', ROOT).href)

  // ① 网络异常（fetch 抛错）。
  const boom = fetchTransport({ fetchImpl: async () => { throw new Error('socket hang up') } })
  const offline = await boom('https://www.fang.com/x')
  assert.equal(offline.ok, false)
  assert.equal(offline.failureKind, 'network')
  assert.match(offline.error, /网络错误或超时/)

  // ② 被重定向到白名单之外：这是白名单的漏口，单独一类。
  const redirect = fetchTransport({
    allowedHosts: ['fang.com'],
    fetchImpl: async () => ({ ok: true, status: 200, url: 'https://evil.example/x', headers: { get: () => 'text/html' }, text: async () => '<html></html>' }),
  })
  const escaped = await redirect('https://www.fang.com/x')
  assert.equal(escaped.failureKind, 'blocked')
  assert.match(escaped.error, /允许清单之外/)

  // ③ 限流：错误信息里带类别，重试记录因此能分辨。
  const limited = fetchTransport({
    fetchImpl: async () => ({ ok: false, status: 429, url: 'https://www.fang.com/x', headers: { get: () => 'text/html' }, text: async () => '<html></html>' }),
  })
  const rate = await limited('https://www.fang.com/x')
  assert.equal(rate.failureKind, 'rate-limited')
  assert.match(rate.error, /被限流或被风控拦下（HTTP 429）/)

  // ④ 页面失效。
  const gone = fetchTransport({
    fetchImpl: async () => ({ ok: false, status: 404, url: 'https://www.fang.com/x', headers: { get: () => 'text/html' }, text: async () => '' }),
  })
  assert.equal((await gone('https://www.fang.com/x')).failureKind, 'not-found')

  // ⑤ 正常响应没有类别、没有错误。
  const fine = fetchTransport({
    fetchImpl: async () => ({ ok: true, status: 200, url: 'https://www.fang.com/x', headers: { get: () => 'text/html' }, text: async () => '<html>ok</html>' }),
  })
  const good = await fine('https://www.fang.com/x')
  assert.equal(good.ok, true)
  assert.equal(good.failureKind, '')
  assert.equal(good.error, '')
})

// ── P12: network / DNS facts kept apart from login and captcha facts ───────
//
// Fail-first evidence before the implementation: `verdict.network` was `undefined`
// (reading `.ok` threw) and the receipt carried no "网络/DNS 事实" clause at all.
//
// Pinned here: (1) a transport failure records structured network facts (code / phase /
// address kind / refusing boundary); (2) they surface as their own field instead of being
// guessed from a message; (3) a private / loopback boundary refusal stays `unknown` +
// `unreachable` and never becomes authenticated / unauthenticated / blocked / captcha.

test('P12 网络事实：DNS 失败 / 超时 / 私网被边界拒绝 / 正常响应 各自留下结构化事实', async () => {
  const { fetchTransport } = await import(
    new URL('src/host/domains/report-evaluation/browser/fetch-transport.ts', ROOT).href)
  const { addressKindOf, classifyProbe, networkFactClause, networkFactsOfDetail } = await import(
    new URL('src/host/domains/report-evaluation/browser/login-probe.ts', ROOT).href)

  // ① DNS phase failure: undici wraps the real reason in `TypeError: fetch failed`.
  const dnsCause = Object.assign(new Error('getaddrinfo ENOTFOUND search.fang.com'), {
    code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'search.fang.com',
  })
  const dns = await fetchTransport({
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: dnsCause }) },
  })('https://search.fang.com/house/')
  assert.equal(dns.failureKind, 'network')
  assert.equal(dns.network.ok, false)
  assert.equal(dns.network.source, 'transport')
  assert.equal(dns.network.errorCode, 'ENOTFOUND')
  assert.equal(dns.network.phase, 'dns', 'DNS 阶段失败要能一眼看出来')
  assert.equal(dns.network.host, 'search.fang.com')
  assert.equal(dns.network.address, '', 'DNS 没解析出地址，不能编一个')
  assert.equal(dns.network.refusedBy, '')
  const dnsVerdict = classifyProbe(dns)
  assert.equal(dnsVerdict.network.phase, 'dns')
  assert.equal(dnsVerdict.network.errorCode, 'ENOTFOUND')
  assert.equal(dnsVerdict.state, 'unknown')
  assert.equal(dnsVerdict.login, 'not-observed', 'DNS 失败不是"没登录"')
  assert.equal(dnsVerdict.captcha, false)
  assert.match(dnsVerdict.detail, /网络\/DNS 事实/)
  assert.match(dnsVerdict.detail, /ENOTFOUND/)
  assert.match(dnsVerdict.detail, /不是登录或验证码事实/)

  // ② Timeout: both undici's ConnectTimeoutError and a local AbortError are time facts.
  const timeoutCause = Object.assign(new Error('Connect Timeout Error'), {
    code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError',
  })
  const timeout = await fetchTransport({
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: timeoutCause }) },
  })('https://search.fang.com/house/')
  assert.equal(timeout.network.ok, false)
  assert.equal(timeout.network.errorCode, 'UND_ERR_CONNECT_TIMEOUT')
  assert.equal(timeout.network.phase, 'timeout')
  assert.equal(classifyProbe(timeout).state, 'unknown')
  assert.match(classifyProbe(timeout).detail, /不是登录或验证码事实/)

  const aborted = await fetchTransport({
    fetchImpl: async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) },
  })('https://search.fang.com/house/')
  assert.equal(aborted.network.phase, 'timeout', '被中止（本层超时用的就是 AbortController）也是时间事实')
  assert.equal(classifyProbe(aborted).login, 'not-observed')

  // ③ A private / loopback address refused by the LOCAL boundary before any network I/O.
  const bounded = fetchTransport({ allowedHosts: ['fang.com'] })
  const refused = await bounded('http://127.0.0.1:8080/house/')
  assert.equal(refused.ok, false)
  assert.equal(refused.network.ok, false)
  assert.equal(refused.network.phase, 'boundary')
  assert.equal(refused.network.refusedBy, 'host-allow-list', '说得出是**哪条**边界拒绝的')
  assert.equal(refused.network.addressKind, 'loopback')
  assert.equal(refused.network.address, '127.0.0.1')
  assert.notEqual(refused.error, '', '拒绝要有话，但不是把它说成站点侧的问题')
  // The boundary was NOT relaxed: the same rule still refuses an ordinary public host.
  assert.equal((await bounded('https://www.example.com/x')).ok, false)
  assert.equal((await bounded('https://www.example.com/x')).network.refusedBy, 'host-allow-list')

  const refusedVerdict = classifyProbe(refused)
  assert.equal(refusedVerdict.state, 'unknown', '被边界拒绝 = 无法检查，不是"公开页放行"')
  assert.equal(refusedVerdict.login, 'not-observed', '被边界拒绝不是"没登录"')
  assert.equal(refusedVerdict.captcha, false)
  assert.equal(refusedVerdict.readability, 'unreachable')
  assert.notEqual(refusedVerdict.readability, 'blocked', '边界拒绝不能读成"站点把我们挡了"')
  assert.equal(refusedVerdict.retrieval, 'unreachable')
  assert.equal(refusedVerdict.network.refusedBy, 'host-allow-list')
  assert.match(refusedVerdict.detail, /网络\/DNS 事实/)
  assert.match(refusedVerdict.detail, /127\.0\.0\.1/)
  assert.match(refusedVerdict.detail, /不是登录或验证码事实/)

  // ③b The deployment boundary (`requirePublicHTTPURL` wording) also reports the address.
  const cliBoundary = await fetchTransport({
    fetchImpl: async () => { throw new Error('拒绝本机或内网地址：10.1.2.3') },
  })('https://www.fang.com/x')
  assert.equal(cliBoundary.network.phase, 'boundary')
  assert.equal(cliBoundary.network.refusedBy, 'network-boundary')
  assert.equal(cliBoundary.network.addressKind, 'private')
  assert.equal(cliBoundary.network.address, '10.1.2.3')
  assert.equal(classifyProbe(cliBoundary).readability, 'unreachable')

  // ③c The real incident's shape: a fake-IP address, every candidate unreachable
  //     (undici AggregateError). Both the code and the address kind must be recorded,
  //     otherwise "unreachable" cannot be told apart from a proxy-injected address.
  const fakeIp = Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED 198.18.0.7:443'), { code: 'ECONNREFUSED', address: '198.18.0.7' }),
      Object.assign(new Error('connect ETIMEDOUT 198.18.0.8:443'), { code: 'ETIMEDOUT', address: '198.18.0.8' }),
    ], 'aggregate'),
  })
  const fakeIpHit = await fetchTransport({ fetchImpl: async () => { throw fakeIp } })('https://search.fang.com/house/')
  assert.equal(fakeIpHit.network.phase, 'connect')
  assert.equal(fakeIpHit.network.errorCode, 'ECONNREFUSED')
  assert.equal(fakeIpHit.network.address, '198.18.0.7')
  assert.equal(fakeIpHit.network.addressKind, 'reserved')
  const fakeIpVerdict = classifyProbe(fakeIpHit)
  assert.equal(fakeIpVerdict.state, 'unknown')
  assert.equal(fakeIpVerdict.login, 'not-observed')
  assert.equal(fakeIpVerdict.captcha, false)
  assert.match(fakeIpVerdict.detail, /地址类别 保留 \/ 基准测试网段/)

  // ④ A successful response: facts are present (no network failure) and the verdict holds.
  const fine = await fetchTransport({
    fetchImpl: async () => ({
      ok: true, status: 200, url: 'https://www.fang.com/x',
      headers: { get: () => 'text/html' }, text: async () => '<html>ok</html>',
    }),
  })('https://www.fang.com/x')
  assert.equal(fine.network.ok, true)
  assert.equal(fine.network.source, 'transport')
  assert.equal(fine.network.errorCode, '')
  assert.equal(fine.network.phase, '')
  const fineVerdict = classifyProbe(fine)
  assert.equal(fineVerdict.state, 'authenticated')
  assert.equal(fineVerdict.network.ok, true)

  // ⑤ A site-side challenge page is NOT a network fact: `network.ok = true`, and the
  //    captcha verdict still stands on its own (calling a 403 a network fact would send
  //    the employee to change networks instead of completing the challenge).
  const challenge = await fetchTransport({
    fetchImpl: async () => ({
      ok: false, status: 403, url: 'https://www.fang.com/x',
      headers: { get: () => 'text/html' }, text: async () => '<div>请完成安全验证</div>',
    }),
  })('https://www.fang.com/x')
  assert.equal(challenge.network.ok, true)
  const challengeVerdict = classifyProbe(challenge)
  assert.equal(challengeVerdict.captcha, true)
  assert.equal(challengeVerdict.network.ok, true)
  assert.doesNotMatch(challengeVerdict.detail, /网络\/DNS 事实/)

  // ⑤b Without transport-witnessed facts, a failure is never read as a challenge page or a
  //     login wall — signatures inside an unreachable page are worthless.
  const unwitnessed = classifyProbe({
    ok: false, error: '请求失败：403', status: 403, body: '<div>请完成安全验证</div>',
  })
  assert.equal(unwitnessed.state, 'unknown')
  assert.equal(unwitnessed.readability, 'unreachable')
  assert.equal(unwitnessed.login, 'not-observed')
  assert.equal(unwitnessed.captcha, false)
  assert.match(unwitnessed.detail, /不是登录或验证码事实/)

  // ⑥ Address kind only comes from literal addresses; no DNS result is guessed.
  assert.equal(addressKindOf('8.8.8.8'), 'public')
  assert.equal(addressKindOf('10.1.2.3'), 'private')
  assert.equal(addressKindOf('172.20.0.1'), 'private')
  assert.equal(addressKindOf('192.168.1.1'), 'private')
  assert.equal(addressKindOf('127.0.0.1'), 'loopback')
  assert.equal(addressKindOf('::1'), 'loopback')
  assert.equal(addressKindOf('169.254.10.1'), 'link-local')
  assert.equal(addressKindOf('fd00::1'), 'private')
  assert.equal(addressKindOf('198.18.0.7'), 'reserved', '代理 fake-IP 常用网段（RFC 2544 保留）')
  assert.equal(addressKindOf('search.fang.com'), '', '没有解析过的域名不是地址')
  assert.equal(addressKindOf(''), '')

  // ⑦ The clause and its reader share one label table: generation -> recovery must not
  //    drift, because the frozen Tool receipt can only carry the facts through the clause.
  for (const [facts, expected] of [
    [dns.network, { phase: 'dns', errorCode: 'ENOTFOUND', address: '', addressKind: '', refusedBy: '' }],
    [refused.network, {
      phase: 'boundary', errorCode: '', address: '127.0.0.1',
      addressKind: 'loopback', refusedBy: 'host-allow-list',
    }],
  ]) {
    const clause = networkFactClause(facts)
    const recovered = networkFactsOfDetail(clause)
    assert.equal(recovered.ok, false)
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(recovered[key], value, `回认 ${key} 漂移了：${clause}`)
    }
    assert.equal(networkFactClause(recovered), clause, '往返之后文案必须逐字相同')
  }
  // Neither a success nor a challenge page has a network failure, so no noise is added.
  assert.equal(networkFactClause(fine.network), '')
  assert.equal(networkFactsOfDetail(classifyProbe(challenge).detail), undefined)
})

// ── 跨站去重（§7.3：同一套房源可能被不同来源重复展示）────────────────────

test('跨站去重：只有同一 canonical URL 合并；弱事实相同只标疑似重复', async () => {
  const { dedupeAcrossSources, crossSiteKey } = await import(
    new URL('src/host/domains/report-evaluation/market/normalize.ts', ROOT).href)

  const listing = (source, sourceLabel, url, patch = {}) => ({
    source, sourceLabel, url, title: '阳光小区 3室', community: '阳光小区',
    purpose: '住宅', propertyNature: '出让', buildingArea: 100, floor: '', totalFloors: '',
    builtYear: '', decoration: '', price: 2_000_000, unitPrice: 20000,
    transactionType: '挂牌', publishedAt: '', capturedAt: '', evidence: `来源证据/${source}.html`,
    keepReason: '', dropReason: '', notes: [], ...patch,
  })

  // ① 同一套房：同一 canonical URL 只多一个跟踪参数 —— 只留先出现的那一条。
  const merged = dedupeAcrossSources([
    listing('lianjia', '链家', 'https://bj.lianjia.com/1'),
    listing('lianjia', '链家', 'https://bj.lianjia.com/1?utm_source=page2'),
  ])
  assert.equal(merged.length, 1, '同一套房源不能算两个独立案例')
  assert.equal(merged[0].url, 'https://bj.lianjia.com/1', '留先出现的那一条')
  assert.match(merged[0].notes.join('；'), /同一房源重复/, '去重要留下痕迹，不是静默删除')

  // ② 跨平台：小区/面积/价格相同但 URL 不同**不足以**判定同一套 —— 两条都保留，
  //    只留"疑似重复"的痕迹（合并会把不同房源静默并掉）。
  const across = dedupeAcrossSources([
    listing('fang', '房天下', 'https://search.fang.com/1'),
    listing('lianjia', '链家', 'https://bj.lianjia.com/9'),
  ])
  assert.equal(across.length, 2, '弱事实相同不等于同一套房源')
  assert.deepEqual(
    across.map((item) => item.url).sort(),
    ['https://bj.lianjia.com/9', 'https://search.fang.com/1'].sort(),
  )
  assert.notEqual(across.flatMap((item) => item.notes).join('；'), '', '要留下疑似重复的痕迹')

  // ③ 同小区**不同**房源（面积或价格不同）不能合并 —— 那是两条独立案例。
  assert.equal(dedupeAcrossSources([
    listing('fang', '房天下', 'https://x/1'),
    listing('lianjia', '链家', 'https://x/2', { buildingArea: 120 }),
    listing('lianjia', '链家', 'https://x/3', { price: 2_600_000 }),
  ]).length, 3)

  // ④ 小区写法带营销后缀（"(3期)"）视为同一个；空白与大小写归一化。
  assert.equal(
    crossSiteKey(listing('fang', '房天下', '', { community: '阳光小区(3期)' })),
    crossSiteKey(listing('fang', '房天下', '', { community: ' 阳光小区 ' })),
  )

  // ⑤ 面积或价格拿不到时**不**用指纹合并：靠"小区相同"合并会把不同房源误判成一套
  //（比重复更危险：案例凭空少一条）。
  assert.equal(crossSiteKey(listing('fang', '房天下', '', { buildingArea: null })), '')
  assert.equal(crossSiteKey(listing('fang', '房天下', '', { price: null })), '')
  assert.equal(dedupeAcrossSources([
    listing('fang', '房天下', 'https://x/1', { buildingArea: null }),
    listing('lianjia', '链家', 'https://x/2', { buildingArea: null }),
  ]).length, 2, '拿不到指纹的案例照常保留')

  // ⑥ 价格档按千元取整到 0.1 万：同一价格在三个站点的四舍五入不同，差几百元不该算两套。
  assert.equal(
    crossSiteKey(listing('fang', '房天下', '', { price: 2_000_000 })),
    crossSiteKey(listing('lianjia', '链家', '', { price: 2_000_400 })),
  )
})

// ── 协议 40 · 交易性质的字段级判据（红测，先于实现）──────────────────────────
//
// `normalizeCase` 把**字段名**也喂进交易类型判定（`Object.keys(fields)`），而成交规则排在挂牌
// 之前（`normalize.ts` 的 `TRANSACTION_RULES`）。于是：
//   - 英文键 `transactionType`（命中 `/transaction/i`）、键 `soldDate`（命中 `/sold/i`）、
//     键 `成交价`（命中 `/成交价/`）都会把**明确的挂牌**覆盖成成交；
//   - 一个值为空的 `成交价` 字段名也会被当成成交证据。
// 这不是"页面上写了成交"，而是字段名本身被当成了语义（见 2026-10-16 诊断 §3.3）。

test('交易类型：显式「挂牌」必须压过别处的成交字样（字段名本身不算成交证据）', () => {
  const listed = normalizeCase({
    source: 'fang', url: 'https://example.invalid/listed',
    title: '阳光小区 3室 挂牌价 200 万',
    fields: {
      交易类型: '挂牌',
      transactionType: '挂牌',
      soldDate: '',
      成交价: '',
      price: '200万',
    },
  })
  assert.equal(listed.transactionType, '挂牌',
    '显式交易类型是挂牌时，空值字段名 / 英文键不得把它翻成成交')
  assert.equal(caseIsComparable(listed), false, '挂牌不是可直接采用的可比实例')

  // 别处**值**里的成交字样（例如备注里提到"成交价参考"）同样不能覆盖显式挂牌。
  const withNote = normalizeCase({
    source: 'fang', url: 'https://example.invalid/note',
    title: '阳光小区 3室 挂牌 200 万',
    fields: { 交易类型: '挂牌', 备注: '页面另附成交价参考', price: '200万' },
  })
  assert.equal(withNote.transactionType, '挂牌', '显式挂牌优先于别处值里的成交字样')
})

test('交易类型：值为空的「成交时间」「成交价」字段名不构成成交语义', () => {
  const byTimeKey = normalizeCase({
    source: 'fang', url: 'https://example.invalid/t',
    title: '阳光小区 3室 挂牌价 200 万',
    fields: { 交易类型: '挂牌', 成交时间: '', price: '200万' },
  })
  assert.equal(byTimeKey.transactionType, '挂牌', '空值的「成交时间」字段名不是成交证据')

  const byPriceKey = normalizeCase({
    source: 'fang', url: 'https://example.invalid/p',
    title: '阳光小区 3室 挂牌价 200 万',
    fields: { 交易类型: '挂牌', 成交价: '', price: '200万' },
  })
  assert.equal(byPriceKey.transactionType, '挂牌', '空值的「成交价」字段名不是成交证据')
})

test('交易类型：真正的显式成交仍然被接受', () => {
  const explicit = normalizeCase({
    source: 'lianjia', url: 'https://example.invalid/sold',
    title: '阳光小区 3室',
    fields: { 交易类型: '成交', 成交价: '180万', 建筑面积: '90㎡' },
  })
  assert.equal(explicit.transactionType, '成交')
  assert.equal(explicit.unitPrice, 20_000)
  assert.equal(caseIsComparable(explicit), true)

  const titled = normalizeCase({
    source: 'lianjia', url: 'https://example.invalid/sold2',
    title: '阳光小区 3室 已成交 180 万',
    fields: { 建筑面积: '90㎡', 成交价: '180万' },
  })
  assert.equal(titled.transactionType, '成交')
})

// URL identity: tracking-only changes merge; identity params and distinct URLs stay distinct.

test('URL 身份：只去跟踪参数，识别参数与不同 URL 都必须保留', async () => {
  const { dedupeAcrossSources } = await import(
    new URL('src/host/domains/report-evaluation/market/normalize.ts', ROOT).href)
  const listing = (source, sourceLabel, url, patch = {}) => ({
    source, sourceLabel, url, title: '阳光小区 3室', community: '阳光小区',
    purpose: '住宅', propertyNature: '出让', buildingArea: 100, floor: '', totalFloors: '',
    builtYear: '', decoration: '', price: 2_000_000, unitPrice: 20000,
    transactionType: '成交', publishedAt: '', capturedAt: '', evidence: `来源证据/${source}.html`,
    keepReason: '', dropReason: '', notes: [], ...patch,
  })

  // Same canonical URL + tracking-only change merges once, provenance kept.
  const tracked = dedupeAcrossSources([
    listing('lianjia', '链家', 'https://bj.lianjia.com/1'),
    listing('lianjia', '链家', 'https://bj.lianjia.com/1?utm_medium=share'),
  ])
  assert.equal(tracked.length, 1)
  assert.match(tracked[0].notes.join('；'), /同一房源重复/)

  // Identity-bearing query parameters must not be stripped: id=1 vs id=2 are two listings.
  const params = dedupeAcrossSources([
    listing('lianjia', '链家', 'https://bj.lianjia.com/1?id=1'),
    listing('lianjia', '链家', 'https://bj.lianjia.com/1?id=2'),
  ])
  assert.equal(params.length, 2)

  // Cross-source weak facts match but URLs differ: preserve both records.
  const weak = dedupeAcrossSources([
    listing('fang', '房天下', 'https://search.fang.com/1'),
    listing('lianjia', '链家', 'https://bj.lianjia.com/9'),
  ])
  assert.equal(weak.length, 2)
})

// Negative transaction wording: 未成交 / 未售出 / unsold never mean 成交.

test('交易类型：未成交 / 未售出 / unsold 绝不判成成交', () => {
  for (const label of ['未成交', '未售出', 'unsold', '尚未成交']) {
    assert.notEqual(transactionTypeOf(label), '成交', label)
  }
  const explicit = normalizeCase({
    source: 'fang', url: 'https://example.invalid/pending',
    title: '阳光小区 3室 挂牌价 200 万',
    fields: { 交易类型: '未成交', price: '200万' },
  })
  assert.notEqual(explicit.transactionType, '成交', '显式「未成交」不得判成成交')
})
