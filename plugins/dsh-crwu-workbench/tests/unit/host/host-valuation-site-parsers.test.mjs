/**
 * 链家列表页 DOM 解析与站点 URL 模板的回归测试。
 *
 * 这一层钉的是**"页面取到了、数字却不对/字段却丢了"**这一类静默失效 —— 它们不报错，
 * 只在最终估值数字上体现，事后无法回溯：
 *
 * 1. 检索 URL 少了 `rs` 段与独立的 `/pg<N>/` 段，会落到另一个页面（取不到 54 条）；
 * 2. 总价丢掉单位词「万」，`parsePrice` 会把它按"元"读 —— **差 10000 倍**；
 * 3. `floor` / `totalFloors` / `decoration` 是结果契约里**已有**的字段，解析层不产出就等于恒为空串；
 * 4. 多方向朝向（`南 西南 西`）被打散成一个方向，比较因素会算错。
 *
 * fixture 是**按归档里的列表行结构合成**的最小 DOM（脱敏、无真实页面字节、无个人信息）；
 * 逐字出处见 `docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md`。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { PROVIDER_SITES, expandTemplate, siteOf } = await import(
  new URL('src/host/domains/report-evaluation/browser/providers.ts', ROOT).href
)
const { listItemBlocks, looksLikeListPage, parseSitePage } = await import(
  new URL('src/host/domains/report-evaluation/market/site-parsers.ts', ROOT).href
)
const { normalizeCase } = await import(new URL('src/host/domains/report-evaluation/market/normalize.ts', ROOT).href)

/** 合成的一条链家列表行（结构照抄归档，文案与数值都是编的）。 */
const LIANJIA_LIST_HTML = `
<div class="content">
  <ul class="sellListContent">
    <li class="clear LOGCLICKDATA" data-lj_action_resblock_id="1111027377871" data-lj_action_housedel_id="101131385498">
      <a class="noresultRecommend img LOGCLICKDATA" href="https://bj.lianjia.com/ershoufang/101131385498.html" target="_blank" data-housecode="101131385498">
        <img class="lj-lazy" src="https://image1.ljcdn.com/110000-inspection/example.jpg.296x216.jpg">
      </a>
      <div class="info clear">
        <div class="title"><a href="https://bj.lianjia.com/ershoufang/101131385498.html">某小区 明厨明卫三居室 南向</a></div>
        <div class="address">
          <div class="houseInfo">3室2厅1厨2卫 | 157平米 | 南 西南 西 | 简装 | 高楼层 (共24层) | 1998年建 | 塔楼</div>
          <div class="positionInfo"><a href="/xiaoqu/1111027377871/">示例花园</a> 朝阳 国展</div>
        </div>
        <div class="priceInfo">
          <div class="totalPrice"><span>1100</span>万</div>
          <div class="unitPrice"><span>70,064元/㎡</span></div>
        </div>
      </div>
    </li>
  </ul>
</div>`

// ── 检索 URL 模板 ───────────────────────────────────────────────────────────

test('链家检索 URL 带 rs 段与独立的 /pg<N>/ 段（归档实测的那一条形状）', () => {
  const site = siteOf('lianjia')
  assert.equal(site.searchUrl, 'https://{city}.lianjia.com/ershoufang/rs{keyword}/pg{page}/')

  const page1 = expandTemplate(site.searchUrl, { keyword: '力鸿花园', city: 'bj', page: 1 })
  // 逐字对照 2026-10-13 归档：`https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/`
  // 与 `…/ershoufang/rs<关键词>/pg1/`（两次都返回 54 条）。
  assert.equal(page1, 'https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/pg1/')
  assert.equal(expandTemplate(site.searchUrl, { keyword: '力鸿花园', city: 'bj', page: 2 }),
    'https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/pg2/')

  // 回归：曾经的样子是 `/ershoufang/<关键词>pg1/` —— 没有 `rs`、`pg` 前也没有 `/`。
  assert.ok(page1.includes('/ershoufang/rs'), '关键词检索必须有 rs 段')
  assert.ok(!/\/ershoufang\/[^/]*pg\d/.test(page1), 'pg 必须是独立的路径段')
})

test('城市码进域名，中文城市名仍然被拒（不拼一个一定取不到的地址）', () => {
  const site = siteOf('lianjia')
  assert.throws(() => expandTemplate(site.searchUrl, { keyword: 'x', city: '北京', page: 1 }), RangeError)
  assert.equal(expandTemplate(site.searchUrl, { keyword: 'a b', city: 'sh', page: 1 }),
    'https://sh.lianjia.com/ershoufang/rsa%20b/pg1/')
})

test('每个来源的模板都还在自己那一家的域名内（模板写错就是白名单漏口）', () => {
  // 域名白名单**逐来源**判：一个来源的模板落到别人家的域名上，就是白名单漏口。
  // 声明顺序即取数顺序（与 `MARKET_PROVIDER_IDS` 一致）；域名逐个判。
  const HOSTS = {
    fang: /(^|\.)fang\.com$/,
    anjuke: /(^|\.)anjuke\.com$/,
    wuba: /(^|\.)58\.com$/,
    lianjia: /(^|\.)lianjia\.com$/,
  }
  assert.deepEqual(PROVIDER_SITES.map((site) => site.id), Object.keys(HOSTS),
    '站点定义与域名白名单必须一一对应（新增来源时两处一起加）')
  for (const site of PROVIDER_SITES) {
    for (const key of ['searchUrl', 'probeUrl', 'loginUrl']) {
      const url = new URL(site[key].replace(/\{[a-z]+\}/g, 'bj'))
      assert.equal(url.protocol, 'https:', `${site.id}.${key} 必须是 https`)
      assert.ok(HOSTS[site.id].test(url.hostname), `${site.id}.${key} 落到了 ${url.hostname}`)
    }
    // 依据必须如实登记：归档字节还是公开路径约定（协议 39 要求"没验收"可核对）。
    assert.ok(['archived-capture', 'public-pattern'].includes(site.evidence), site.id)
    assert.notEqual(site.evidenceNote.trim(), '', `${site.id} 缺少依据说明`)
  }
})

// ── 列表行解析 ─────────────────────────────────────────────────────────────

test('列表行：价格/单价/面积/户型/楼层/总层数/朝向/装修/小区/房源 ID 全部读出', () => {
  assert.equal(looksLikeListPage(LIANJIA_LIST_HTML), true)
  assert.equal(listItemBlocks(LIANJIA_LIST_HTML).length, 1)

  const parsed = parseSitePage({ providerId: 'lianjia', body: LIANJIA_LIST_HTML, finalUrl: 'https://bj.lianjia.com/ershoufang/rsx/pg1/' })
  assert.equal(parsed.failureKind, '')
  assert.equal(parsed.channel, 'dom')
  assert.equal(parsed.listings.length, 1)

  const row = parsed.listings[0]
  assert.equal(row.source, 'lianjia')
  assert.equal(row.url, 'https://bj.lianjia.com/ershoufang/101131385498.html')
  assert.deepEqual(row.fields, {
    price: '1100万',
    unitPrice: '70064元',
    area: '157',
    layout: '3室2厅',
    floor: '高楼层',
    totalFloors: '24',
    orientation: '南 西南 西',
    decoration: '简装',
    builtYear: '1998',
    community: '示例花园',
    listingId: '101131385498',
  })
})

test('总价必须带单位词：裸数字会按"元"读，差 10000 倍', () => {
  const parsed = parseSitePage({ providerId: 'lianjia', body: LIANJIA_LIST_HTML, finalUrl: 'https://bj.lianjia.com/ershoufang/rsx/pg1/' })
  const item = normalizeCase(parsed.listings[0])
  assert.equal(item.price, 11_000_000, '1100万 是 1100 万元，不是 1100 元')
  assert.equal(item.unitPrice, 70_064, '页面给了单价就用页面给的')
})

test('字段穿过标准化后落进结果契约里已有的键：floor / total_floors / decoration', () => {
  const parsed = parseSitePage({ providerId: 'lianjia', body: LIANJIA_LIST_HTML, finalUrl: 'https://bj.lianjia.com/ershoufang/rsx/pg1/' })
  const item = normalizeCase(parsed.listings[0])
  assert.equal(item.floor, '高楼层')
  assert.equal(item.totalFloors, '24', '总层数曾是恒为空串：解析层把「共24层」折进了 floor')
  assert.equal(item.decoration, '简装', '装修曾是恒为空串：别名表里有，解析层不产出')
  assert.equal(item.buildingArea, 157)
  assert.equal(item.community, '示例花园')
})

test('多方向朝向不被截断成一个方向', () => {
  const parsed = parseSitePage({ providerId: 'lianjia', body: LIANJIA_LIST_HTML, finalUrl: 'https://bj.lianjia.com/ershoufang/rsx/pg1/' })
  assert.equal(parsed.listings[0].fields.orientation, '南 西南 西')
  // 回归：旧的 `/(朝?[东南西北]{1,3})\s*[|｜]/` 只会留下紧邻 `|` 的那一个方向。
  assert.notEqual(parsed.listings[0].fields.orientation, '西')
})

test('楼层两种写法都拆成 floor + totalFloors（`(共N层)` 与 `/共N层`）', () => {
  for (const [rendered, floor, total] of [
    ['高楼层 (共24层)', '高楼层', '24'],
    ['低楼层/共18层', '低楼层', '18'],
    ['顶层', '顶层', ''],
  ]) {
    const body = `<ul class="sellListContent"><li class="clear">`
      + `<div class="title"><a href="/ershoufang/101131385498.html">示例</a></div>`
      + `<div class="houseInfo">3室2厅 | 157平米 | 南 | 简装 | ${rendered} | 1998年建</div>`
      + `<div class="totalPrice"><span>1100</span>万</div></li></ul>`
    const parsed = parseSitePage({ providerId: 'lianjia', body, finalUrl: 'https://bj.lianjia.com/ershoufang/rsx/pg1/' })
    assert.equal(parsed.listings[0]?.fields.floor, floor, rendered)
    const total2 = parsed.listings[0]?.fields.totalFloors
    if (total === '') assert.equal(total2, undefined, `${rendered} 没有总层数就不该编一个`)
    else assert.equal(total2, total, rendered)
  }
})

// ── 失败分类 ───────────────────────────────────────────────────────────────

test('像结果页却 0 命中 → template-stale（不是"这个小区没有房源"）', () => {
  const body = '<ul class="sellListContent"><li class="clear"><div class="title">广告位</div></li></ul>'
  const parsed = parseSitePage({ providerId: 'lianjia', body, finalUrl: 'https://bj.lianjia.com/ershoufang/rsx/pg1/' })
  assert.equal(parsed.listings.length, 0)
  assert.equal(parsed.failureKind, 'template-stale')
})

test('挑战页（合成的最小形状）解析出 0 条，且不编造案例', () => {
  const body = '<html><head><title>CAPTCHA</title></head><body><div class="geetest_panel">人机验证 点击按钮开始验证</div></body></html>'
  const parsed = parseSitePage({ providerId: 'lianjia', body, finalUrl: 'https://hip.lianjia.com/captcha' })
  assert.equal(parsed.listings.length, 0)
  assert.equal(parsed.channel, 'none')
  assert.equal(parsed.failureKind, 'unreadable')
})

test('unrecognized navigation and script shells do not prove that a community has no listings', () => {
  for (const body of [
    '<html><body><nav>首页 登录 二手房</nav><div id="app"></div></body></html>',
    '<html><body><div id="app"></div><script>const emptyState = "暂无相关房源";</script></body></html>',
  ]) {
    const result = parseSitePage({ providerId: 'wuba', body, finalUrl: 'https://bj.58.com/ershoufang/' })
    assert.equal(result.failureKind, 'unreadable')
    assert.deepEqual(result.listings, [])
    assert.doesNotMatch(result.notes.join(' '), /确实回答了|明确回答了/)
  }
})

test('a visible explicit empty result is distinct from an unrecognized page layout', () => {
  for (const body of [
    '<html><body><div>暂无符合条件的房源</div></body></html>',
    '<html><body><ul class="sellListContent"></ul><div>没有找到相关房源</div></body></html>',
  ]) {
    const result = parseSitePage({ providerId: 'wuba', body, finalUrl: 'https://bj.58.com/ershoufang/' })
    assert.equal(result.failureKind, 'no-results')
    assert.deepEqual(result.listings, [])
  }
})

// ── 部署清单的登录判据页 ─────────────────────────────────────────────────────

test('部署清单的 protectedUrl 必须是要求会话的页，不能与公开预检页相同', async () => {
  const raw = await readFile(
    new URL('skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json', ROOT), 'utf8',
  )
  const sites = JSON.parse(raw)
  assert.ok(Array.isArray(sites) && sites.length > 0, '站点清单不能为空')
  for (const site of sites) {
    const provider = PROVIDER_SITES.find((item) => item.id === site.id)
    assert.ok(provider, `清单里的来源 ${site.id} 在 providers.ts 中没有定义`)
    // probeUrl 按定义是"公开、免登录也能打开"的页；protectedUrl 按定义是"要求会话"的页。
    // 两者相等 → status --verify-page 在未登录时也会说 authenticated，门禁形同虚设。
    assert.notEqual(
      site.protectedUrl,
      provider.probeUrl,
      `${site.id} 的 protectedUrl 与公开预检页相同，登录门禁无法判出未登录`,
    )
  }
  const lianjia = sites.find((item) => item.id === 'lianjia')
  assert.equal(lianjia.protectedUrl, 'https://bj.lianjia.com/ershoufang/chaoyang/')
})
