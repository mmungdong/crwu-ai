/**
 * 外部案例 Tool（协议 32）的接线测试：三次尝试、登录门槛、证据落盘、挂牌纪律。
 *
 * 全部用**注入的抓取通道**（内存替身）：单测绝不访问真实站点。
 *
 * 这一层要钉死的是纯逻辑不覆盖的那一半 —— "框架说对了"不等于"接线接对了"：
 *
 * 1. 每个分页**真的**只尝试三次（数调用次数，不是看返回文案）；
 * 2. 三次全败 + 未确认登录 → `phase=browser-login-required` 且 `canProceed=false`；
 * 3. 同一轮里另一家来源的失败**不影响**这家（登录已确认时只记缺口继续）；
 * 4. 页面证据**真的**落在案例目录的 `来源证据/` 下，且案例的 `evidence` 指向它；
 * 5. 没有截图能力这件事**每次**都写进 `capabilityGaps`（否则"有证据文件"会被读成"有截图"）；
 * 6. 挂牌案例进结果时 `transaction_type` 是挂牌 —— 它不是可比实例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent, missingConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationMarketSearchTools } = await import(new URL('src/host/tools/report-evaluation/market-search.ts', ROOT).href)
const { valuationBrowserPreflightTools } = await import(new URL('src/host/tools/report-evaluation/browser-preflight.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { ValuationLifecycles } = await import(new URL('src/host/domains/report-evaluation/lifecycle/index.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { SCREENSHOT_GAP } = await import(new URL('src/host/domains/report-evaluation/browser/capture.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-160000-bb22'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

function makeCtx({ failWrite } = {}) {
  const files = new Map()
  const directories = new Set([WORKSPACE, CASE_DIR])
  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) {
      // 注入写失败：用来跑"页面取到了但证据没留住"这条路径（它正是最容易被当成成功的那条）。
      if (failWrite !== undefined && failWrite.test(String(target.targetKey))) {
        throw new Error('注入的写失败')
      }
      files.set(target.targetKey, content)
      return { operation: 'create', version: 'v' }
    },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }
  return {
    files, directories,
    get(name) { return name === 'fs' ? fsService : undefined },
  }
}

function makeDeps({ ctx = makeCtx(), scopes = new ValuationScopes(), lifecycles = new ValuationLifecycles() } = {}) {
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, state, scopes, lifecycles,
    deps: {
      ctx, config: { ...CONFIG }, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
      // 与 `apply.ts` 同一条装配：**同一个**注册表实例同时给操作表与 Tool 闭包。
      valuationLifecycles: lifecycles,
      world: {
        platform: async () => 'darwin-arm64',
        home: async () => '/Users/x',
        workdir: async () => WORKSPACE,
        cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
      },
    },
  }
}

function openValuation(deps, sessionId = 'valuation-session-1') {
  // 真实流程里轮次是 `valuation-start` 开的、工具跑在 `running`。夹具照抄这一段，
  // 否则"工具把结论写回轮次"这件事根本没有接收方（回归测试会变成假绿）。
  if (deps.valuationLifecycles !== undefined && deps.valuationLifecycles.get(VALUATION_ID) === undefined) {
    deps.valuationLifecycles.open({
      valuationId: VALUATION_ID, casePath: CASE_DIR, workspaceId: 'w1', workspacePath: WORKSPACE,
      method: 'market', baseDate: '', digest: 'sha256:x', sessionId,
    })
    deps.valuationLifecycles.update(VALUATION_ID, 'extracting', {})
    deps.valuationLifecycles.update(VALUATION_ID, 'confirmation', {})
    deps.valuationLifecycles.update(VALUATION_ID, 'queued', {})
    deps.valuationLifecycles.update(VALUATION_ID, 'running', {})
  }
  deps.valuationScopes.open({
    valuationId: VALUATION_ID, casePath: CASE_DIR, sessionId,
    workspaceId: 'w1', workspacePath: WORKSPACE,
    snapshot: {
      valuationId: VALUATION_ID, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:x', frozenAt: '2026-10-12T00:00:00.000Z', files: [],
    },
    openedAt: 1,
  })
  return sessionId
}

function execOf(sessionId, name) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'), name, arguments: {},
    signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

function okResult(url, body, patch = {}) {
  return {
    ok: true, error: '', status: 200, body, contentType: 'text/html; charset=utf-8',
    url, loginRequired: false, captcha: false, ...patch,
  }
}

function failResult(url, error) {
  return {
    ok: false, error, status: 0, body: '', contentType: '', url,
    loginRequired: false, captcha: false,
  }
}

/** 一段带 JSON-LD 房源声明的页面（挂牌价与成交价各一条）。 */
const LISTING_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"RealEstateListing","name":"阳光小区 3室2厅 挂牌价 200 万","url":"https://example.invalid/fang/1",
  "address":{"@type":"PostalAddress","streetAddress":"阳光小区"},"floorSize":{"value":100,"unitText":"㎡"},
  "price":"200万","datePosted":"2026-09-01"},
 {"@type":"RealEstateListing","name":"阳光小区 2室1厅 成交价 180 万","url":"https://example.invalid/fang/2",
  "address":{"@type":"PostalAddress","streetAddress":"阳光小区"},"floorSize":{"value":90,"unitText":"㎡"},
  "price":"180万"}
]}
</script></head><body>房源列表</body></html>`

// ── 注册面 ──────────────────────────────────────────────────────────────────

test('三家来源的 Tool 都在注册清单里，且都**不在**审核必需集', () => {
  for (const name of [
    VALUATION_TOOL_NAMES.browserPreflight,
    VALUATION_TOOL_NAMES.marketSearch,
    VALUATION_TOOL_NAMES.marketCapture,
  ]) {
    assert.equal(CRWU_BUSINESS_TOOLS.includes(name), true, name)
    assert.equal(REQUIRED_AUDIT_TOOLS.includes(name), false, name)
  }
})

// ── 预检 ────────────────────────────────────────────────────────────────────

test('预检：状态语义写清楚"不读 Cookie、不知道账号状态"，并给出登录入口', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html>公开检索页</html>')
  const result = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))

  assert.equal(result.ok, true, result.error)
  assert.match(result.meaning, /不读 Cookie/)
  assert.deepEqual(result.states.map((item) => item.id), ['fang', 'anjuke', 'lianjia'])
  for (const item of result.states) {
    assert.equal(item.state, 'authenticated')
    assert.equal(item.stateLabel, '可用')
    assert.match(item.loginUrl, /^https:\/\//)
  }
  assert.deepEqual(result.capabilityGaps, [])
})

test('预检：被登录墙挡住 = 需要登录；验证码 = 无法检查（且不做绕过）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => {
    if (url.includes('anjuke.com')) return okResult(url, '<html>请先登录后查看</html>')
    if (url.includes('lianjia.com')) return okResult(url, '<html>请完成安全验证 滑动验证</html>')
    return okResult(url, '<html>ok</html>')
  }
  const result = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))

  const byId = Object.fromEntries(result.states.map((item) => [item.id, item]))
  assert.equal(byId.fang.state, 'authenticated')
  assert.equal(byId.anjuke.state, 'unauthenticated')
  assert.equal(byId.lianjia.state, 'unknown')
  assert.equal(byId.lianjia.captcha, true)
  assert.match(byId.lianjia.detail, /不会绕过验证/)
  assert.deepEqual(result.needsLogin.sort(), ['anjuke', 'lianjia'])
  assert.equal(result.capabilityGaps.length, 2)
})

test('预检：网络不可达是"无法检查"，不是"未登录"（用户要换网络而不是去登录）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => failResult(url, '请求失败：网络不可达')
  const result = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))
  for (const item of result.states) assert.equal(item.state, 'unknown')
  assert.match(result.states[0].detail, /网络不可达/)
})

test('预检：非估值会话被拒', async () => {
  const { deps } = makeDeps()
  const result = await valuationBrowserPreflightTools(deps, async () => failResult('u', 'x'))[0]
    .execute({ caseDir: CASE_DIR }, execOf('随便一条会话', VALUATION_TOOL_NAMES.browserPreflight))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
})

test('预检：非法来源名整批拒绝，一个请求都不发', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let calls = 0
  const result = await valuationBrowserPreflightTools(deps, async (url) => { calls += 1; return okResult(url, 'x') })[0]
    .execute({ caseDir: CASE_DIR, providers: ['fang', 'baidu'] }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))
  assert.equal(result.errorKind, 'input')
  assert.equal(calls, 0)
})

// ── 检索 ────────────────────────────────────────────────────────────────────

test('检索：每个分页**恰好**三次尝试（数调用次数），三次全败且未确认登录 → browser-login-required', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const calls = []
  const transport = async (url) => {
    calls.push(url)
    // 预检页也要失败：于是登录状态是 unknown（未确认）。
    return failResult(url, '请求失败：超时')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.phase, 'browser-login-required')
  assert.equal(result.canProceed, false, '未确认登录时不许静默继续')
  // 三家来源 ×（1 次预检 + 1 页 × 3 次尝试）= 12 次，一次不多。
  assert.equal(calls.length, 12, `实际请求次数：${calls.length}`)
  assert.deepEqual(result.needsLogin.sort(), ['anjuke', 'fang', 'lianjia'])
  assert.equal(result.providers.every((item) => item.failedPages === 1), true)
  assert.equal(result.providers.every((item) => item.attemptLimit === 3), true)
  // 缺口文案必须说清"没确认登录"，而不是含糊的"没抓到"。
  assert.match(result.capabilityGaps.join('；'), /无法检查|未登录/)
  assert.match(result.capabilityGaps.join('；'), /不作为案例依据/)

  // **写回轮次**：面板轮询的是宿主的事实。只把 phase 回给模型的话，界面永远停在"正在跑"。
  const record = deps.valuationLifecycles.get(VALUATION_ID)
  assert.equal(record.phase, 'browser-login-required', '阶段必须真的落到注册表上')
  assert.deepEqual(Object.keys(record.providerStates).sort(), ['anjuke', 'fang', 'lianjia'])
  assert.equal(Object.values(record.providerStates).every((item) => item.attempts === 3), true)
  assert.match(record.capabilityGaps.join('；'), /无法检查|未登录/)
})

test('证据没留存时：案例显式标记 evidence_missing，缺口文案点明不得当可比实例', async () => {
  const { deps } = makeDeps({ ctx: makeCtx({ failWrite: /来源证据/ }) })
  const sessionId = openValuation(deps)
  // 只查一家，且用**有结构化房源**的那一页：这样"案例解析出来了"与"证据没落盘"两件事同时成立。
  const transport = async (url) => okResult(url, LISTING_HTML)
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  // 页面取到了、案例也解析出来了，但**证据没落盘** —— 这正是"看着成功、其实不可复核"的情形。
  assert.equal(result.cases.length > 0, true)
  assert.equal(result.cases.every((item) => item.evidence === ''), true)
  assert.equal(result.cases.every((item) => item.evidence_missing === true), true, '必须显式标出缺证据')
  assert.match(result.capabilityGaps.join('；'), /不得\*\*直接当可比实例使用/)
})

test('写回是尽力而为：没开这一轮时检索照样成功（界面少一条状态，不影响工具的结论）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  // 抹掉轮次记录：模拟"宿主没有这一轮"（重启过 / 被更新的轮次挤掉）。
  deps.valuationLifecycles.close(VALUATION_ID)
  const transport = async (url) => failResult(url, '请求失败：超时')
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, true, '写不回状态不该让检索失败')
  assert.equal(result.phase, 'browser-login-required', '工具自己的结论照旧')
  assert.equal(deps.valuationLifecycles.get(VALUATION_ID), undefined)
  assert.match(result.warnings.join('；'), /轮次状态没能回写/, '要如实说界面会少一条状态')
})

test('检索：登录已确认时三次失败只记缺口、继续其他来源（不让员工白登录一次）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => {
    // 只让房天下的**检索页**失败：预检页（`/house/`，不带 `?`）成功 → 登录状态已确认。
    if (url.includes('search.fang.com/house/?')) return failResult(url, '请求失败：521')
    return okResult(url, '<html>公开页</html>')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing', providers: ['fang', 'anjuke'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.phase, 'running', '已确认登录的失败不阻塞')
  assert.equal(result.canProceed, true)
  assert.deepEqual(result.needsLogin, [])
  const fang = result.providers.find((item) => item.id === 'fang')
  const anjuke = result.providers.find((item) => item.id === 'anjuke')
  assert.equal(fang.failedPages, 1)
  assert.equal(anjuke.failedPages, 0, '另一家来源不受影响')
  assert.match(result.capabilityGaps.join('；'), /房天下/)
  assert.match(result.capabilityGaps.join('；'), /最多 3 次尝试/)
})

test('检索：页面有结构化房源 → 标准化 + 证据落进案例目录 + 每次都说没有截图能力', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, LISTING_HTML)

  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.canProceed, true)
  assert.deepEqual(result.warnings, [SCREENSHOT_GAP], '没有截图能力这件事每次都要说')
  assert.equal(result.cases.length, 2)
  assert.equal(result.casesPath, `${CASE_DIR}/估值案例.json`)

  // 挂牌价与成交价分开标注 —— 这是最重要的一条。
  const listed = result.cases.find((item) => item.url.endsWith('/1'))
  const sold = result.cases.find((item) => item.url.endsWith('/2'))
  assert.equal(listed.transaction_type, '挂牌')
  assert.equal(listed.price, 2_000_000)
  assert.equal(listed.unit_price, 20_000)
  assert.equal(sold.transaction_type, '成交')
  assert.equal(sold.unit_price, 20_000, '180 万 / 90 ㎡')
  assert.equal(result.counts.挂牌, 1)
  assert.equal(result.counts.成交, 1)
  assert.equal(result.counts.comparable, 1, '只有成交案例可直接作可比实例')

  // 证据：文件真的在案例目录的 来源证据/ 下，且案例指向它。
  const evidenceFiles = [...ctx.files.keys()].filter((path) => path.startsWith(`${CASE_DIR}/来源证据/`))
  assert.equal(evidenceFiles.length, 1, `证据文件数：${evidenceFiles.join('、')}`)
  assert.match(evidenceFiles[0], /fang-.*\.html$/)
  for (const item of result.cases) {
    assert.equal(item.evidence, `来源证据/${evidenceFiles[0].split('/').pop()}`, '案例必须指向它被读到的出处')
    assert.equal(item.evidence_missing, false, '有证据的案例不该标成缺证据')
  }
  // 案例清单也落了盘（可追溯）。
  const written = JSON.parse(ctx.files.get(result.casesPath))
  assert.equal(written.schema, 'crwu.valuation.cases.v1')
  assert.equal(written.cases.length, 2)
  assert.equal(written.phase, 'completed')
})

test('检索：页面取到但**没有**结构化房源 → 0 条 + 能力缺口（绝不按标题猜）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html><body>阳光小区 3室 200万 100平米</body></html>')
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.deepEqual(result.cases, [])
  assert.equal(result.counts.total, 0)
  assert.match(result.capabilityGaps.join('；'), /没有可用的结构化房源数据/)
  assert.match(result.capabilityGaps.join('；'), /不猜测/)
})

test('检索：翻页上限被夹住（每页三次尝试，页数越多请求越多但有界）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const searchUrls = []
  const transport = async (url) => {
    if (url.includes('/house/?') || url.includes('/sale/?') || url.includes('/ershoufang/')) searchUrls.push(url)
    return url.includes('search.fang.com/house/?') ? okResult(url, LISTING_HTML) : okResult(url, '<html>公开页</html>')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: 'k', city: 'beijing', providers: ['fang'], maxPages: 99 }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.providers[0].fetchedPages, 5, '页数上限被夹到 5')
  assert.equal(searchUrls.length, 5, '一次不多地取 5 页')
})

test('检索：非估值会话被拒（普通会话不许写案例目录）', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const result = await valuationMarketSearchTools(deps, async (url) => okResult(url, LISTING_HTML))[0]
    .execute({ caseDir: CASE_DIR, keyword: 'k', city: 'beijing' }, execOf('随便一条会话', VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(result.errorKind, 'policy')
  assert.equal([...ctx.files.keys()].length, 0, '被拒时不许落任何文件')
})

test('检索：keyword / city 为空时在发请求之前拒绝', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let calls = 0
  const tools = valuationMarketSearchTools(deps, async (url) => { calls += 1; return okResult(url, 'x') })
  for (const args of [{ keyword: '', city: 'beijing' }, { keyword: 'k', city: '  ' }]) {
    const result = await tools[0].execute({ caseDir: CASE_DIR, ...args }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
    assert.equal(result.errorKind, 'input')
  }
  assert.equal(calls, 0)
})

// ── 取证 ────────────────────────────────────────────────────────────────────

test('取证：页面字节落进案例目录，带指纹；截图缺口如实上报', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html>某套房源页</html>')

  const result = await valuationMarketSearchTools(deps, transport)[1]
    .execute({ caseDir: CASE_DIR, source: 'fang', url: 'https://example.invalid/fang/9' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, true, result.error)
  assert.match(result.file, /^来源证据\/fang-.*\.html$/)
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.bytes, '<html>某套房源页</html>'.length)
  assert.deepEqual(result.capabilityGaps, [SCREENSHOT_GAP])
  assert.equal(ctx.files.has(`${CASE_DIR}/${result.file}`), true)
})

test('取证：取不到页面时按三次尝试后报失败，不留半个文件', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return failResult(url, '连接被重置') }

  const result = await valuationMarketSearchTools(deps, transport)[1]
    .execute({ caseDir: CASE_DIR, source: 'fang', url: 'https://example.invalid/fang/9' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, false)
  assert.equal(calls, 3, '恰好三次')
  assert.match(result.error, /已尝试 3 次/)
  assert.equal([...ctx.files.keys()].length, 0, '失败时不许留半个证据文件')
})

test('取证：非法来源名被拒，一个请求都不发', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let calls = 0
  const result = await valuationMarketSearchTools(deps, async (url) => { calls += 1; return okResult(url, 'x') })[1]
    .execute({ caseDir: CASE_DIR, source: 'baidu', url: 'https://example.invalid/x' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))
  assert.equal(result.errorKind, 'input')
  assert.equal(calls, 0)
})

test('授权门禁：未在本机访问授权里放行时，一个外部请求都不发', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  const state = {
    ...createWorkbenchState(CONFIG),
    // 未授权：`localAccess` 是缺省值（missing）。
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state, consent: missingConsent() })
  const deps = {
    ctx, config: { ...CONFIG }, state, access,
    discussionScopes: createDiscussionScopeRegistry(), valuationScopes: scopes,
    world: {
      platform: async () => 'darwin-arm64', home: async () => '/Users/x',
      workdir: async () => WORKSPACE, cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
    },
  }
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return okResult(url, 'x') }

  const preflight = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))
  const search = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, keyword: 'k', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  const capture = await valuationMarketSearchTools(deps, transport)[1]
    .execute({ caseDir: CASE_DIR, source: 'fang', url: 'https://example.invalid/x' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  for (const result of [preflight, search, capture]) {
    assert.equal(result.errorKind, 'policy', result.error)
    assert.match(result.error, /本机访问授权/)
  }
  assert.equal(calls, 0, '未授权时零请求')
  assert.equal([...ctx.files.keys()].length, 0, '未授权时零落盘')
})

test('跨站去重接进检索：结果里的案例数是**合并之后**的，并给出合并了几条', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  // 两家来源都回**同一批**房源（URL 也是站点自己的，所以按 URL 去重去不掉）。
  const transport = async (url) => okResult(url, LISTING_HTML)

  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute(
      { caseDir: CASE_DIR, keyword: '阳光小区', city: 'beijing', providers: ['fang', 'lianjia'] },
      execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
    )

  // 一家取到 2 条、两家共 4 条，同一批房源合并成 2 条。
  assert.equal(result.cases.length, 2, '同一套房源在多个来源出现不能算多条')
  assert.equal(result.dedupedAway, 2)
  assert.match(result.warnings.join('；'), /跨站去重：合并了 2 条/)
  // 留下的那条要能看出"与谁重复"。
  const notes = result.cases.flatMap((item) => item.notes ?? []).join('；')
  assert.match(notes, /同一房源重复/)
})
