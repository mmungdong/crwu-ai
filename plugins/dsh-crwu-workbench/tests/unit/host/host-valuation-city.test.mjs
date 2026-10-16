/**
 * 业务城市 → 站点城市标识（P7）：映射只能来自**站点自己公布的城市列表**。
 *
 * 这一层钉的是"模型的轮盘赌"这一类失效 —— 工具对 `city` 只做形状校验时，`北京 / beijing / bj`
 * 三种写法只有一个能过，模型只能猜；猜错的表现是**取不到页面**，而调用方读到的却是
 * "这个来源没有案例"（一个看起来像业务结论的错误）。所以：
 *
 * 1. `北京` → `bj` 必须由 `https://www.lianjia.com/city/` 的页面内容推出，不能是代码里的表；
 * 2. 已经是站点标识的 `bj` 原样通过（现有调用方与测试不受影响），且**不打网络**；
 * 3. 公布列表里没有 / 一个名字对上多个标识 → `not-covered`（**该来源不覆盖**）+ 候选清单，
 *    **绝不**静默退到 `bj`；列表读不出来是 `unavailable`（基础设施问题），两者必须分开；
 * 4. 页面读一次就进进程内缓存：第二次解析同一个城市不再取数。
 *
 * fixture 是按 2026-10-15 实际观察到的 `https://www.lianjia.com/city/` 结构**合成**的 HTML
 * （无真实页面字节、无个人信息）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  SITE_KEY_PATTERN,
  LIANJIA_CITY_LIST_PAGE,
  parseCityListPage,
  loadCityList,
  clearCityListCache,
} = await import(new URL('src/host/domains/report-evaluation/market/city-list.ts', ROOT).href)

const { resolveBusinessCity, providerCityStatus, validateSiteCity, SITE_CITY_PATTERN } = await import(
  new URL('src/host/domains/report-evaluation/market/city.ts', ROOT).href)
const {
  CITY_LIST_SOURCES, adaptedCitySourceIds, cityListSourceOf, citySourceFacts, providerCityVerdict,
  unadaptedCitySourceIds,
} = await import(new URL('src/host/domains/report-evaluation/market/city-sources.ts', ROOT).href)

const FIXTURE_PAGE = 'https://example.invalid/city-list-fixture/'

/** 合成：两家城市 + 一个名字对上两个标识的歧义条目。 */
const FIXTURE_HTML = `<div class="city_list">
  <ul>
    <li><a href="https://bj.lianjia.com/">北京</a></li>
    <li><a href="https://sh.lianjia.com/">上海</a></li>
    <li><a href="https://hy.lianjia.com/">衡阳</a></li>
    <li><a href="https://hengyang.lianjia.com/">衡阳</a></li>
  </ul>
</div>`

/**
 * 合成：真机观察到的页面结构（网页文本转写为等价的锚点结构）。
 *
 * 观察到的形状：`城市选择` 下按省份分组，城市链接恰好是 `https://<标识>.lianjia.com/`
 * （如 `北京 → https://bj.lianjia.com/`）；`热门城市` 与省份分组会重复同一个城市；
 * 少数城市公布成 `黔西南 → https://qxn.fang.lianjia.com/`、`琼海 → http://you.lianjia.com/qh`，
 * 这类**不能用** `<标识>.lianjia.com` 表达；页脚另有 `北京链家简介` / `朝阳区二手房` /
 * `海门房产网` 这类同域名但非城市入口的链接。
 */
const REAL_SHAPED_HTML = `<!doctype html>
<html lang="zh-CN"><head><title>链家城市列表</title></head>
<body>
  <div class="city_hot">
    <h3>热门城市</h3>
    <a href="https://bj.lianjia.com/">北京</a>
    <a href="https://sh.lianjia.com/">上海</a>
    <a href="https://sz.lianjia.com/">深圳</a>
  </div>
  <div class="city_list">
    <h3>城市选择</h3>
    <div class="city_province">
      <p class="letter">B</p><p class="province">北京</p>
      <ul><li><a href="https://bj.lianjia.com/">北京</a></li></ul>
    </div>
    <div class="city_province">
      <p class="letter">C</p><p class="province">重庆</p>
      <ul><li><a href="https://cq.lianjia.com/">重庆</a></li></ul>
    </div>
    <div class="city_province">
      <p class="letter">G</p><p class="province">广东</p>
      <ul>
        <li><a href="https://gz.lianjia.com/">广州</a></li>
        <li><a href="https://sz.lianjia.com/">深圳</a></li>
      </ul>
    </div>
    <div class="city_province">
      <p class="letter">G</p><p class="province">贵州</p>
      <ul>
        <li><a href="https://gy.lianjia.com/">贵阳</a></li>
        <li><a href="https://qxn.fang.lianjia.com/">黔西南</a></li>
      </ul>
    </div>
    <div class="city_province">
      <p class="letter">H</p><p class="province">海南</p>
      <ul>
        <li><a href="http://you.lianjia.com/qh">琼海</a></li>
        <li><a href="https://san.lianjia.com/">三亚</a></li>
      </ul>
    </div>
  </div>
  <div class="footer">
    <a href="https://bj.lianjia.com/about/aboutlianjia/">北京链家简介</a>
    <a href="https://bj.lianjia.com/ershoufang/chaoyangqu/">朝阳区二手房</a>
    <a href="https://bj.lianjia.com/xiaoqu/1111814813052882/">亦园</a>
    <a href="https://haimen.lianjia.com/">海门房产网</a>
    <a href="http://beian.miit.gov.cn">京ICP备16057509号</a>
  </div>
</body></html>`

function countingTransport(body, { ok = true, status = 200, error = '' } = {}) {
  const calls = []
  const transport = async (url) => {
    calls.push(url)
    return { ok, status, body, error }
  }
  return { transport, calls }
}

// ── 页面解析：映射来自页面，不来自代码里的表 ────────────────────────────────

test('真实页面结构：只有 `<标识>.lianjia.com/` 的首页链接成为映射，重复项去重', () => {
  const snapshot = parseCityListPage(REAL_SHAPED_HTML, LIANJIA_CITY_LIST_PAGE, '2026-10-15T00:00:00.000Z')
  assert.deepEqual(snapshot.entries.map((entry) => `${entry.name}->${entry.key}`), [
    '北京->bj', '上海->sh', '深圳->sz', '重庆->cq', '广州->gz', '贵阳->gy', '三亚->san',
  ])
  // 每个标识都必须能进域名。
  for (const entry of snapshot.entries) assert.ok(SITE_KEY_PATTERN.test(entry.key), entry.key)
  assert.equal(snapshot.page, LIANJIA_CITY_LIST_PAGE)
})

test('真实页面结构：公布的链接不能表达成单段域名时如实记录，不硬塞一个标识', () => {
  const snapshot = parseCityListPage(REAL_SHAPED_HTML, LIANJIA_CITY_LIST_PAGE, '2026-10-15T00:00:00.000Z')
  assert.deepEqual(snapshot.unusable.map((entry) => entry.name), ['黔西南', '琼海'])
  assert.equal(snapshot.entries.some((entry) => entry.name === '黔西南'), false)
  assert.equal(snapshot.entries.some((entry) => entry.name === '琼海'), false)
  // 页脚的非城市入口（同域名、带多段路径；或文案不是城市名）既不是映射也不是"不可用城市入口"。
  for (const name of ['北京链家简介', '朝阳区二手房', '亦园', '海门房产网']) {
    assert.equal(snapshot.entries.some((entry) => entry.name === name), false, name)
    assert.equal(snapshot.unusable.some((entry) => entry.name === name), false, name)
  }
})

// ── 标识形状：city key 会进域名，必须是单段 DNS 标签 ────────────────────────

test('城市标识是单段 DNS 标签：数字 / 连字符 / 超长一律拒绝', () => {
  assert.equal(SITE_CITY_PATTERN.source, SITE_KEY_PATTERN.source)
  assert.equal(validateSiteCity('bj').ok, true)
  assert.equal(validateSiteCity('beijing').ok, true)
  for (const bad of ['bj1', 'bj-cn', 'a', 'a'.repeat(11), '北京']) {
    assert.equal(validateSiteCity(bad).ok, false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

test('畸形 HTML（非法数字实体 / 未闭合锚点）不会让解析炸掉，也不编出条目', () => {
  const snapshot = parseCityListPage(
    '<a href="https://bj.lianjia.com/">北京&#99999999;</a><a href="https://sh.lianjia.com/">上海',
    LIANJIA_CITY_LIST_PAGE,
    '2026-10-15T00:00:00.000Z',
  )
  assert.deepEqual(snapshot.entries, [{ name: '北京', key: 'bj' }])
})

// ── 业务城市解析 ────────────────────────────────────────────────────────────

test('已经是站点标识：原样通过，且不打网络', async () => {
  clearCityListCache()
  const { transport, calls } = countingTransport(FIXTURE_HTML)
  const upper = await resolveBusinessCity('BJ', { transport, page: FIXTURE_PAGE })
  assert.deepEqual(
    { status: upper.status, ok: upper.ok, code: upper.code, via: upper.via },
    { status: 'resolved', ok: true, code: 'bj', via: 'site-key' },
  )
  assert.equal(calls.length, 0, '站点标识不需要读城市列表')
})

test('业务城市名：经站点公布的城市列表解析出标识', async () => {
  clearCityListCache()
  const { transport } = countingTransport(FIXTURE_HTML)
  const beijing = await resolveBusinessCity('北京', { transport, page: FIXTURE_PAGE })
  assert.deepEqual(
    { status: beijing.status, ok: beijing.ok, code: beijing.code, via: beijing.via },
    { status: 'resolved', ok: true, code: 'bj', via: 'published-list' },
  )
  // `北京市` 这种带行政后缀的写法按同一条规则解析，不是另一张表。
  clearCityListCache()
  const suffixed = await resolveBusinessCity('北京市', { transport, page: FIXTURE_PAGE })
  assert.equal(suffixed.code, 'bj')
})

test('页面只读一次：同一进程里第二个城市不再取数', async () => {
  clearCityListCache()
  const { transport, calls } = countingTransport(FIXTURE_HTML)
  assert.equal((await resolveBusinessCity('北京', { transport, page: FIXTURE_PAGE })).code, 'bj')
  assert.equal((await resolveBusinessCity('上海', { transport, page: FIXTURE_PAGE })).code, 'sh')
  assert.equal(calls.length, 1, `城市列表应只取一次，实际 ${String(calls.length)} 次`)
  assert.equal(calls[0], FIXTURE_PAGE)
  const loaded = await loadCityList({ transport, page: FIXTURE_PAGE })
  assert.equal(loaded.ok, true)
  assert.equal(calls.length, 1)
})

test('城市不在公布列表里 → **not-covered（该来源不覆盖）**，带候选清单与页面，绝不退到 bj', async () => {
  clearCityListCache()
  const { transport } = countingTransport(FIXTURE_HTML)
  const result = await resolveBusinessCity('天津', { transport, page: FIXTURE_PAGE })
  // 协议 39：这是"该来源不覆盖这个地区"（按来源处置、改用替代来源），
  // **不是**"整个业务输入非法" —— 两者混同会让替代来源根本没机会跑。
  assert.equal(result.status, 'not-covered')
  assert.equal(result.ok, false)
  assert.equal(result.code, '', '拿不准就不能给出一个标识')
  assert.notEqual(result.code, 'bj')
  assert.equal(result.via, '')
  assert.match(result.reason, /天津/)
  assert.equal(result.page, FIXTURE_PAGE)
  assert.deepEqual(result.candidates, [
    { name: '北京', key: 'bj' },
    { name: '上海', key: 'sh' },
    { name: '衡阳', key: 'hy' },
    { name: '衡阳', key: 'hengyang' },
  ])
})

test('一个名字对上多个标识 → not-covered（该来源无法确定地区），把冲突的标识报出来而不是挑第一个', async () => {
  clearCityListCache()
  const { transport } = countingTransport(FIXTURE_HTML)
  const result = await resolveBusinessCity('衡阳', { transport, page: FIXTURE_PAGE })
  assert.equal(result.status, 'not-covered')
  assert.equal(result.ok, false)
  assert.equal(result.code, '')
  assert.match(result.reason, /衡阳/)
  assert.match(result.reason, /hy/)
  assert.match(result.reason, /hengyang/)
})

test('解析不出来（网络失败 / 页面改版）→ unavailable（基础设施问题，不是"没有这个城市"），且失败不进缓存', async () => {
  clearCityListCache()
  const failing = countingTransport('', { ok: false, status: 502, error: 'HTTP 502' })
  const first = await resolveBusinessCity('北京', { transport: failing.transport, page: FIXTURE_PAGE })
  assert.equal(first.status, 'unavailable')
  assert.equal(first.ok, false)
  assert.equal(first.code, '')
  assert.equal(first.page, FIXTURE_PAGE)
  assert.match(first.reason, /城市列表/)
  // 失败不缓存：一次网络抖动不该让整个进程后面都解析不出城市。
  await resolveBusinessCity('北京', { transport: failing.transport, page: FIXTURE_PAGE })
  assert.equal(failing.calls.length, 2)

  clearCityListCache()
  const empty = countingTransport('<!doctype html><html><body><a href="https://bj.lianjia.com/">北京二手房</a></body></html>')
  const unparsed = await resolveBusinessCity('北京', { transport: empty.transport, page: FIXTURE_PAGE })
  assert.equal(unparsed.ok, false)
  assert.match(unparsed.reason, /城市列表/)
})

test('空城市：在取数之前就拒绝', async () => {
  clearCityListCache()
  const { transport, calls } = countingTransport(FIXTURE_HTML)
  const result = await resolveBusinessCity('   ', { transport, page: FIXTURE_PAGE })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('解析出的标识可以直接进链家域名（最后一道形状闸门仍然生效）', async () => {
  clearCityListCache()
  const { transport } = countingTransport(FIXTURE_HTML)
  const { expandTemplate } = await import(
    new URL('src/host/domains/report-evaluation/browser/providers.ts', ROOT).href)
  const result = await resolveBusinessCity('北京', { transport, page: FIXTURE_PAGE })
  assert.equal(
    expandTemplate('https://{city}.lianjia.com/ershoufang/rs{keyword}/pg{page}/',
      { city: result.code, keyword: '力鸿花园', page: 1 }),
    'https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/pg1/',
  )
})

// ── 各来源独立解析地区（协议 39）────────────────────────────────────────────

test('城市表逐来源登记：只有链家已适配，其余如实标"尚未适配"（含依据与来源页）', () => {
  assert.deepEqual([...CITY_LIST_SOURCES].map((item) => item.providerId),
    ['lianjia', 'anjuke', 'wuba', 'fang'])
  assert.deepEqual(adaptedCitySourceIds(), ['lianjia'])
  assert.deepEqual(unadaptedCitySourceIds(), ['anjuke', 'wuba', 'fang'])
  for (const item of CITY_LIST_SOURCES) {
    assert.match(item.page, /^https:\/\//, item.providerId)
    assert.ok(['subdomain', 'query'].includes(item.placement), item.providerId)
    assert.ok(['archived-capture', 'public-pattern'].includes(item.evidence), item.providerId)
    assert.notEqual(item.note.trim(), '', `${item.providerId} 缺少依据说明`)
    // 已适配就必须有归档依据；没适配就只能有公开路径约定。
    assert.equal(item.adapted, item.evidence === 'archived-capture', item.providerId)
  }
  // 房天下的城市走**查询参数**，其余走子域名 —— 这个区别决定中文能不能进 URL。
  assert.equal(cityListSourceOf('fang').placement, 'query')
  assert.equal(cityListSourceOf('lianjia').placement, 'subdomain')
  assert.equal(cityListSourceOf('不认识的来源'), null)
  assert.deepEqual(citySourceFacts().map((item) => item.providerId), ['fang', 'anjuke', 'lianjia', 'wuba'])
})

test('解析成功时所有来源都能用；结论里带上标识是哪来的', () => {
  const verdict = providerCityVerdict({
    providerId: 'fang', resolvedCode: 'bj', uncovered: false, coveredBy: 'lianjia', input: '北京',
  })
  assert.equal(verdict.status, 'ok')
  assert.equal(verdict.code, 'bj')
  assert.equal(verdict.evidence, 'archived-capture', '标识来自链家那份已适配的城市表，依据要如实回')
  assert.equal(verdict.sourcePage, LIANJIA_CITY_LIST_PAGE)
})

test('只有**自己那份表已适配**才谈得上「该来源不覆盖这个地区」', () => {
  const lianjia = providerCityVerdict({
    providerId: 'lianjia', resolvedCode: '', uncovered: true, coveredBy: 'lianjia', input: '天津',
  })
  assert.equal(lianjia.status, 'not-covered')
  assert.match(lianjia.reason, /该来源不覆盖这个地区/)
  assert.equal(lianjia.evidence, 'archived-capture')

  // 同一份列表说"没有天津"，但 58 自己的表没适配：这是能力缺口，不是"58 不覆盖天津"。
  for (const id of ['anjuke', 'wuba', 'fang']) {
    const verdict = providerCityVerdict({
      providerId: id, resolvedCode: '', uncovered: true, coveredBy: 'lianjia', input: '天津',
    })
    assert.equal(verdict.status, 'unsupported', id)
    assert.match(verdict.reason, /尚未适配/)
    assert.match(verdict.reason, /不是".*不覆盖这个地区"/)
    assert.equal(verdict.evidence, 'public-pattern')
  }
})

test('没有登记城市表的来源说"还没登记"，不借用别家的覆盖范围', () => {
  const verdict = providerCityVerdict({
    providerId: '不认识的来源', resolvedCode: '', uncovered: true, coveredBy: 'lianjia', input: '天津',
  })
  assert.equal(verdict.status, 'unsupported')
  assert.match(verdict.reason, /还没有登记城市表/)
})

test('providerCityStatus：输入非法 / 城市表读不出来对每个来源都是同一件事', () => {
  const invalid = providerCityStatus(
    { status: 'invalid', ok: false, input: '', code: '', via: '', reason: '城市为空：请提交业务城市', candidates: [], page: '' },
    'lianjia')
  assert.equal(invalid.status, 'unsupported')
  assert.match(invalid.reason, /城市为空/)

  const unavailable = providerCityStatus(
    { status: 'unavailable', ok: false, input: '北京', code: '', via: '', reason: '读取城市列表失败：HTTP 502', candidates: [], page: '' },
    'fang')
  assert.equal(unavailable.status, 'unsupported')
  assert.match(unavailable.reason, /HTTP 502/)
  // 这两种都不许被写成"该来源不覆盖这个地区"。
  assert.equal(/不覆盖/.test(invalid.reason + unavailable.reason), false)
})
