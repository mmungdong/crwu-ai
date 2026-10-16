/**
 * 外部案例 Tool（协议 32）的接线测试：两次尝试、登录门槛、证据落盘、挂牌纪律。
 *
 * 全部用**注入的抓取通道**（内存替身）：单测绝不访问真实站点。
 *
 * 这一层要钉死的是纯逻辑不覆盖的那一半 —— "框架说对了"不等于"接线接对了"：
 *
 * 1. 每个分页**真的**只尝试两次（数调用次数，不是看返回文案）；
 * 2. 两次全败 + 未确认登录 → `phase=browser-login-required` 且 `canProceed=false`；
 * 3. 同一轮里另一家来源的失败**不影响**这家（登录已确认时只记缺口继续）；
 * 4. 页面证据**真的**落在案例目录的 `来源证据/` 下，且案例的 `evidence` 指向它；
 * 5. 没有截图能力这件事**每次**都写进 `capabilityGaps`（否则"有证据文件"会被读成"有截图"）；
 * 6. 挂牌案例进结果时 `transaction_type` 是挂牌 —— 它不是可比实例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent, missingConsent } from '../../helpers/local-access-fixture.mjs'
import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'

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
// 证据 / 截图 / 案例清单按**方案**隔离：`方案/<planId>/`（设计稿 §11.1）。
const PLAN_ID = 'plan-001'
const PLAN_DIR = `${CASE_DIR}/方案/${PLAN_ID}`

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 内存 fs + 建目录的 shell 替身。
 *
 * 为什么要有 shell：`crwu_valuation_market_search` 会在 fetch / shot / dump **之前**
 * 幂等创建派生目录（`来源证据/`、`来源证据/页面/`），而那条路径经 Broker 走
 * `system.case-file.write` + `mkdir`，并**回读后置条件**。替身必须让成功的 mkdir 在
 * `stat`/探测上看得见，否则会造出一台"命令成功但文件系统没变"的假机器。
 *
 * `strict: true` 时写文件的目标目录必须先存在（真实 fs 的行为）：用来复现首次运行
 * `来源证据/` 不存在时的 `ENOENT`。
 */
function makeCtx({ failWrite, strict = false, mkdirFail = null } = {}) {
  const files = new Map()
  const directories = new Set([WORKSPACE, CASE_DIR])
  const commands = []
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir ?? WORKSPACE, timeoutMs: 1, stdoutMaxBytes: 1024 }),
    async execute(spec) {
      commands.push(spec.command)
      const probe = probeAnswer(spec.command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(probeKey(path)),
      })
      if (probe !== undefined) {
        return {
          result: async () => ({
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: probe, truncated: false }, stderr: { text: '', truncated: false },
          }),
        }
      }
      const failure = mkdirFail === null ? null : mkdirFail(spec.command)
      const exitCode = failure === null ? 0 : 1
      if (exitCode === 0) {
        applyShellEffect(spec.command, exitCode, {
          addDir: (path) => directories.add(probeKey(path)),
          removeFile: (path) => files.delete(path),
        })
      }
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: '', truncated: false }, stderr: { text: failure ?? '', truncated: false },
        }),
      }
    },
  }
  const parentOf = (target) => String(target).replace(/[\\/][^\\/]+$/, '')
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
      if (strict && !directories.has(parentOf(target.targetKey))) {
        const error = new Error(`ENOENT: no such file or directory, open '${String(target.targetKey)}'`)
        error.code = 'ENOENT'
        throw error
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
    files, directories, commands,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shell
      return undefined
    },
  }
}

function makeDeps({ ctx = makeCtx(), scopes = new ValuationScopes(), lifecycles = new ValuationLifecycles(), browserRuntime, screenshot } = {}) {
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
      ...(browserRuntime === undefined ? {} : { browserRuntime }),
      ...(screenshot === undefined ? {} : { screenshot }),
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

test('P11 预检：公开页 200 只说"公开页可访问"，绝不报成"已登录"', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html>公开检索页</html>')
  const result = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))

  assert.equal(result.ok, true, result.error)
  assert.match(result.meaning, /不读 Cookie/)
  assert.match(result.meaning, /不代表\*\*账号已登录/)
  assert.deepEqual(result.states.map((item) => item.id), ['fang', 'anjuke', 'wuba', 'lianjia'])
  for (const item of result.states) {
    // ① 登录事实：公开页 200 只说明"没观察到登录事实"。
    assert.equal(item.login, 'not-observed')
    // ② 可读性 / ③ 本次检索能力：两件独立的事实。
    assert.equal(item.readability, 'readable')
    assert.equal(item.retrieval, 'public-page-ok')
    // 访问结论的取值刻意**不叫** authenticated（那个词会被读成"账号已登录"）。
    assert.equal(item.accessVerdict, 'public-page-open')
    assert.equal(item.accessLabel, '公开页可访问')
    assert.equal(item.captcha, false)
    assert.match(item.nextAction, /无需登录动作/)
    assert.match(item.loginUrl, /^https:\/\//)
  }
  // 公开页放行 = 没有人需要去登录、也没有人需要过验证。
  assert.deepEqual(result.needsLogin, [])
  assert.deepEqual(result.needsChallenge, [])
  assert.deepEqual(result.needsCheck, [])
  assert.deepEqual(result.capabilityGaps, [])
})

test('P13 预检：登录墙才进 needsLogin；验证码是自己的类别，不混进"要登录"', async () => {
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
  assert.equal(byId.fang.login, 'not-observed')
  assert.equal(byId.fang.accessVerdict, 'public-page-open')
  // 登录墙：唯一"去登录"的一类。
  assert.equal(byId.anjuke.login, 'signed-out')
  assert.equal(byId.anjuke.readability, 'blocked')
  assert.equal(byId.anjuke.retrieval, 'needs-login')
  assert.equal(byId.anjuke.accessVerdict, 'login-wall')
  // 验证码：**不是**登录失败，自己一类 + 自己的下一步。
  assert.equal(byId.lianjia.login, 'not-observed')
  assert.equal(byId.lianjia.retrieval, 'needs-challenge')
  assert.equal(byId.lianjia.accessVerdict, 'unknown')
  assert.equal(byId.lianjia.captcha, true)
  assert.match(byId.lianjia.detail, /不会绕过验证/)
  assert.match(byId.lianjia.nextAction, /人工完成验证/)
  assert.match(byId.lianjia.nextAction, /不要\*\*把它当登录失败/)

  assert.deepEqual(result.needsLogin, ['anjuke'], 'needsLogin 只放登录墙')
  assert.deepEqual(result.needsChallenge, ['lianjia'])
  assert.deepEqual(result.needsCheck, [])
  assert.equal(result.capabilityGaps.length, 2)
  assert.equal(result.nextActions.length, 2, '两类各有自己的下一步')
  assert.equal(result.nextActions.some((text) => /登录该来源/.test(text)), true)
  assert.equal(result.nextActions.some((text) => /人工完成验证/.test(text)), true)
})

test('P13 预检：网络不可达是"无法检查"（needsCheck），绝不进 needsLogin', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => failResult(url, '请求失败：网络不可达')
  const result = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))
  for (const item of result.states) {
    assert.equal(item.accessVerdict, 'unknown')
    assert.equal(item.readability, 'unreachable')
    assert.equal(item.retrieval, 'unreachable')
    assert.equal(item.login, 'not-observed')
  }
  assert.deepEqual(result.needsLogin, [], '网络失败不是"没登录"')
  assert.deepEqual(result.needsChallenge, [])
  assert.deepEqual(result.needsCheck, ['fang', 'anjuke', 'wuba', 'lianjia'])
  assert.equal(result.nextActions.every((text) => /这不是登录问题/.test(text)), true)
  assert.match(result.states[0].detail, /网络不可达/)
})

// ── P12: network / DNS facts stay apart from login and captcha facts in the receipt ──
//
// The Tool output contract is frozen (`states[]` cannot take new fields), so the structured
// network facts travel inside `detail`: whoever reads the receipt can tell "this is a
// network/DNS fact" from "this is a login or captcha fact" instead of guessing.

test('P12 预检回执：DNS 失败与私网被边界拒绝都是网络事实，绝不进 needsLogin', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const withNetwork = (result, network) => ({ ...result, network })
  const transport = async (url) => {
    if (url.includes('search.fang.com')) {
      return withNetwork(failResult(url, '请求失败（网络错误或超时）：fetch failed'), {
        ok: false, source: 'transport', errorCode: 'ENOTFOUND', errorName: 'Error',
        phase: 'dns', addressKind: '', address: '', host: 'search.fang.com', refusedBy: '',
      })
    }
    if (url.includes('anjuke.com')) {
      return withNetwork(failResult(url, '目标站点不在允许清单里：127.0.0.1'), {
        ok: false, source: 'transport', errorCode: '', errorName: '', phase: 'boundary',
        addressKind: 'loopback', address: '127.0.0.1', host: '127.0.0.1', refusedBy: 'host-allow-list',
      })
    }
    return okResult(url, '<html>请完成安全验证 滑动验证</html>')
  }
  const result = await valuationBrowserPreflightTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId, VALUATION_TOOL_NAMES.browserPreflight))

  const byId = Object.fromEntries(result.states.map((item) => [item.id, item]))
  // ① DNS failure: needs a check, not a login and not a challenge; the DNS fact is readable.
  assert.equal(byId.fang.accessVerdict, 'unknown')
  assert.equal(byId.fang.login, 'not-observed')
  assert.equal(byId.fang.readability, 'unreachable')
  assert.equal(byId.fang.retrieval, 'unreachable')
  assert.equal(byId.fang.captcha, false)
  assert.match(byId.fang.detail, /网络\/DNS 事实/)
  assert.match(byId.fang.detail, /ENOTFOUND/)
  assert.match(byId.fang.detail, /不是登录或验证码事实/)

  // ② A private address refused by the LOCAL boundary: the refusal is named, verdict unchanged.
  assert.equal(byId.anjuke.accessVerdict, 'unknown')
  assert.equal(byId.anjuke.login, 'not-observed')
  assert.equal(byId.anjuke.readability, 'unreachable')
  assert.equal(byId.anjuke.captcha, false)
  assert.match(byId.anjuke.detail, /127\.0\.0\.1/)
  assert.match(byId.anjuke.detail, /本地边界/)
  assert.match(byId.anjuke.detail, /不是登录或验证码事实/)

  // ③ Captcha stays its own category, unrelated to the network facts.
  assert.equal(byId.lianjia.captcha, true)
  assert.equal(byId.lianjia.retrieval, 'needs-challenge')
  assert.equal(byId.lianjia.accessVerdict, 'unknown')
  assert.doesNotMatch(byId.lianjia.detail, /网络\/DNS 事实/)

  // ④ Neither a network failure nor a boundary refusal enters needsLogin (only a login wall does).
  assert.deepEqual(result.needsLogin, [])
  // 58同城的探测页在这个替身里也返回了"安全验证"文案 → 它同样进 needsChallenge。
  assert.deepEqual(result.needsChallenge, ['wuba', 'lianjia'])
  assert.deepEqual(result.needsCheck, ['fang', 'anjuke'])
  // 四条：fang 的网络 / DNS 事实、anjuke 的边界拒绝事实、以及 lianjia 与 wuba 的挑战事实。
  assert.equal(result.capabilityGaps.length, 4)
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

test('检索：每个分页**恰好**两次尝试（数调用次数），两次全败且登录未确认 → 暂停等人，但不算"要登录"', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const calls = []
  const transport = async (url) => {
    calls.push(url)
    // 预检页也要失败：于是登录状态是 unknown（未确认）。
    return failResult(url, '请求失败：超时')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.phase, 'browser-login-required', '有可做的人工动作（可恢复）')
  // 协议 39：**登录是可选用能力** —— 没取到不阻断整轮，改用替代来源继续；原因照实记录。
  assert.equal(result.canProceed, true, '未确认来源不阻断整轮')
  // 四家来源 ×（1 次预检 + 1 页 × 2 次尝试）= 12 次，一次不多。
  assert.equal(calls.length, 12, `实际请求次数：${calls.length}`)
  // **P13：unknown 不是"没登录"** —— 它进 unconfirmed，而不是 needsLogin。
  assert.deepEqual(result.needsLogin, [], '超时/不可达不是登录失败')
  assert.deepEqual(result.unconfirmed.sort(), ['anjuke', 'fang', 'lianjia', 'wuba'])
  assert.equal(result.providers.every((item) => item.failedPages === 1), true)
  assert.equal(result.providers.every((item) => item.attemptLimit === 2), true)
  // 缺口文案必须说清"没确认"，并且**不能**让员工去重登录一个没坏的账号。
  assert.match(result.capabilityGaps.join('；'), /登录状态未确认/)
  assert.match(result.capabilityGaps.join('；'), /不等于"没登录"/)
  assert.match(result.capabilityGaps.join('；'), /不作为案例依据/)
  assert.equal(result.nextActions.length, 1)
  assert.match(result.nextActions[0], /不要.*当成"没登录"/)

  // **写回轮次**：面板轮询的是宿主的事实。只把 phase 回给模型的话，界面永远停在"正在跑"。
  const record = deps.valuationLifecycles.get(VALUATION_ID)
  assert.equal(record.phase, 'browser-login-required', '阶段必须真的落到注册表上')
  assert.deepEqual(Object.keys(record.providerStates).sort(), ['anjuke', 'fang', 'lianjia', 'wuba'])
  assert.equal(Object.values(record.providerStates).every((item) => item.attempts === 2), true)
  assert.match(record.capabilityGaps.join('；'), /登录状态未确认/)
})

test('P13 检索：被登录墙挡住才进 needsLogin（这是唯一"去登录"的一类）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => {
    // 预检页（不带 `?`）回登录墙 → access=unauthenticated；检索页照样取不到。
    if (url.includes('/house/?')) return failResult(url, '请求失败：403')
    if (url.includes('fang.com')) return okResult(url, '<html>请先登录后查看</html>')
    return okResult(url, '<html>公开页</html>')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.deepEqual(result.needsLogin, ['fang'])
  assert.deepEqual(result.unconfirmed, [])
  assert.match(result.nextActions[0], /登录该来源/)
})

// ── P9 · 派生目录：写之前幂等创建，失败单独归类 ──────────────────────────────

test('P9 首次运行：派生目录不存在时由工具幂等创建，证据真的落进 来源证据/页面', async () => {
  // 严格 fs：写文件的目标目录必须先存在（真实 fs 的行为）。**初始目录只有工作空间与案例根**。
  const ctx = makeCtx({ strict: true })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  assert.equal(ctx.directories.has(`${PLAN_DIR}/来源证据`), false, '前置条件：派生目录一开始不存在')

  const result = await valuationMarketSearchTools(deps, async (url) => okResult(url, LISTING_HTML))[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.cases.length, 2)
  assert.equal(result.cases.every((item) => item.evidence_missing === false), true, '首次运行也要有证据')
  assert.equal(ctx.directories.has(`${PLAN_DIR}/来源证据`), true, '来源证据目录被创建')
  assert.equal(ctx.directories.has(`${PLAN_DIR}/来源证据/页面`), true, '页面证据目录被创建（fetch --out/--dump 的父目录）')
  assert.equal([...ctx.files.keys()].some((path) => path.startsWith(`${PLAN_DIR}/来源证据/`)), true)
})

test('P9 取证首次运行：来源证据目录不存在也能落盘', async () => {
  const ctx = makeCtx({ strict: true })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationMarketSearchTools(deps, async (url) => okResult(url, '<html>房源页</html>'))[1]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang', url: 'https://example.invalid/fang/9' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))
  assert.equal(result.ok, true, result.error)
  assert.equal(ctx.files.has(`${PLAN_DIR}/${result.file}`), true)
})

test('P9 目录建不出来：自己的失败类别（file），一个请求都不发、也绝不按登录/验证码处置', async () => {
  const ctx = makeCtx({ mkdirFail: (command) => (command.includes('mkdir') ? 'Operation not permitted' : null) })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return okResult(url, LISTING_HTML) }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'file', '文件 / 目录错误是**自己的**类别')
  assert.match(result.error, /派生目录创建失败/)
  assert.match(result.error, /不是网站登录或验证码问题/)
  // 关键：它不是登录问题，也没有被当成取数失败去重试两次。
  assert.deepEqual(result.needsLogin, [])
  assert.deepEqual(result.unconfirmed, [])
  assert.equal(result.phase, '')
  assert.equal(calls, 0, '目录都没建好就不该发任何取数请求')
  assert.equal([...ctx.files.keys()].length, 0, '失败时不留半个文件')
})

test('证据没留存时：案例显式标记 evidence_missing，缺口文案点明不得当可比实例', async () => {
  const { deps } = makeDeps({ ctx: makeCtx({ failWrite: /来源证据/ }) })
  const sessionId = openValuation(deps)
  // 只查一家，且用**有结构化房源**的那一页：这样"案例解析出来了"与"证据没落盘"两件事同时成立。
  const transport = async (url) => okResult(url, LISTING_HTML)
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

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
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, true, '写不回状态不该让检索失败')
  assert.equal(result.phase, 'browser-login-required', '工具自己的结论照旧')
  assert.equal(deps.valuationLifecycles.get(VALUATION_ID), undefined)
  assert.match(result.warnings.join('；'), /轮次状态没能回写/, '要如实说界面会少一条状态')
})

test('检索：登录已确认时两次失败只记缺口、继续其他来源（不让员工白登录一次）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => {
    // 只让房天下的**检索页**失败：预检页（`/house/`，不带 `?`）成功 → 登录状态已确认。
    if (url.includes('search.fang.com/house/?')) return failResult(url, '请求失败：521')
    return okResult(url, '<html>公开页</html>')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang', 'anjuke'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.phase, 'running', '已确认登录的失败不阻塞')
  assert.equal(result.canProceed, true)
  assert.deepEqual(result.needsLogin, [])
  const fang = result.providers.find((item) => item.id === 'fang')
  const anjuke = result.providers.find((item) => item.id === 'anjuke')
  assert.equal(fang.failedPages, 1)
  assert.equal(anjuke.failedPages, 0, '另一家来源不受影响')
  assert.match(result.capabilityGaps.join('；'), /房天下/)
  assert.match(result.capabilityGaps.join('；'), /最多 2 次尝试/)
})

test('检索：页面有结构化房源 → 标准化 + 证据落进案例目录 + 每次都说没有截图能力', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, LISTING_HTML)

  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.canProceed, true)
  assert.deepEqual(result.warnings, [SCREENSHOT_GAP], '没有截图能力这件事每次都要说')
  assert.equal(result.cases.length, 2)
  assert.equal(result.casesPath, `${PLAN_DIR}/估值案例.json`)

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
  const evidenceFiles = [...ctx.files.keys()].filter((path) => path.startsWith(`${PLAN_DIR}/来源证据/`))
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

test('检索：页面取到但既没有 JSON-LD 也不是结果页 → no-results（绝不按标题猜）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html><body>阳光小区 3室 200万 100平米</body></html>')
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.deepEqual(result.cases, [])
  assert.equal(result.counts.total, 0)
  // 正文里明明写着"200万 100平米"，但页面没有声明结构 —— **不许**按标题猜。
  assert.match(result.capabilityGaps.join('；'), /no-results/)
  assert.match(result.capabilityGaps.join('；'), /候选不足/)
})

/** 脱敏列表页（结构与实测一致：`ul.sellListContent > li.clear`）：**没有** JSON-LD。 */
const DOM_LIST_HTML = `<!doctype html><html><head><title>北京朝阳二手房</title></head><body>
<div class="listContent">
  <ul class="sellListContent">
    <li class="clear">
      <div class="title"><a href="https://bj.lianjia.com/ershoufang/101139646125.html">太阳公元 2室1厅 89.28平米</a></div>
      <div class="positionInfo"><a href="/xiaoqu/1111/">太阳公元</a> 朝阳 太阳宫</div>
      <div class="houseInfo">2室1厅 | 89.28平米 | 南 | 精装 | 低楼层/共18层</div>
      <div class="totalPrice"><span>998</span>万</div>
      <div class="unitPrice"><span>111783</span>元/平</div>
    </li>
  </ul>
</div></body></html>`

/** 结果页结构在、但一条房源项都没有（站点改版的形态）。 */
const STALE_LIST_HTML = `<html><body><div class="listContent"><ul class="sellListContent">
  <li class="clear"><div class="title"><a href="/agent/1">金牌经纪人推荐</a></div></li>
</ul></div></body></html>`

test('检索：只有 DOM（无 JSON-LD）→ 固定选择器兜底解析出案例（Agent 不猜选择器）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, DOM_LIST_HTML)
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '太阳公元', city: 'beijing', providers: ['lianjia'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.cases.length, 1, result.capabilityGaps.join('；'))
  assert.match(result.cases[0].title, /太阳公元/)
  assert.equal(result.cases[0].source, 'lianjia')
  assert.match(result.cases[0].url, /101139646125/)
})

test('检索：结果页结构在但选择器 0 命中 → template-stale（不是"该小区没有房源"）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, STALE_LIST_HTML)
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '太阳公元', city: 'beijing', providers: ['lianjia'] }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.cases.length, 0, JSON.stringify({ providers: result.providers, phase: result.phase, gaps: result.capabilityGaps }))
  const gaps = result.capabilityGaps.join('；')
  assert.match(gaps, /template-stale/)
  assert.match(gaps, /改版/)
  assert.equal(/没有可用的结构化房源数据/.test(gaps), false, '模板过期不能被写成"没有房源"')
  assert.equal(/没有结果（no-results）/.test(gaps), false)
})

test('检索：翻页上限被夹住（每页两次尝试，页数越多请求越多但有界）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const searchUrls = []
  const transport = async (url) => {
    if (url.includes('/house/?') || url.includes('/sale/?') || url.includes('/ershoufang/')) searchUrls.push(url)
    return url.includes('search.fang.com/house/?') ? okResult(url, LISTING_HTML) : okResult(url, '<html>公开页</html>')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'], maxPages: 99 }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  // 协议 39：单次调用的硬夹是 10 页（原 5 页）；累计口径由 Host 的持久预算回答。
  assert.equal(result.providers[0].fetchedPages, 10, '页数上限被夹到 10')
  assert.equal(searchUrls.length, 10, '一次不多地取 10 页')
  assert.equal(result.providers[0].budget.pageLimit, 10)
  // 每页返回的是**同一份**房源：同源重复条目不重复计候选，所以候选数不会因为翻 10 页翻 10 倍。
  assert.equal(result.providers[0].budget.pagesUsed, 10, '页数照记')
  assert.equal(result.providers[0].budget.candidatesUsed < 20, true,
    '同源重复条目不算新候选（否则"翻到上限"就能伪造出额度）')
})

/** 一页返回 N 条**互不相同**的房源（用来把候选计数推到上限）。 */
function listingPage(page, count) {
  const graph = Array.from({ length: count }, (_, index) => ({
    '@type': 'RealEstateListing',
    name: `小区${String(page)}-${String(index)} 3室2厅 挂牌价 ${String(200 + index)} 万`,
    url: `https://example.invalid/p${String(page)}/${String(index)}`,
    address: { '@type': 'PostalAddress', streetAddress: `小区${String(page)}-${String(index)}` },
    floorSize: { value: 100 + index, unitText: '㎡' },
    price: `${String(200 + index)}万`,
    datePosted: '2026-09-01',
  }))
  return `<!doctype html><html><head><script type="application/ld+json">`
    + JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    + '</script></head><body>房源列表</body></html>'
}

test('预算：页数是 Host 持久上限；未评估的原始候选不占合格名额', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let requests = 0
  const transport = async (url) => {
    if (!url.includes('search.fang.com/house/?')) return okResult(url, '<html>公开页</html>')
    requests += 1
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    return okResult(url, listingPage(Number.isFinite(page) ? page : 1, 12))
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const first = await tool.execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'], maxPages: 10 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  // Raw rows are not qualified candidates: they must not spend the qualified budget.
  assert.equal(first.providers[0].budget.candidatesUsed, 0)
  assert.equal(first.providers[0].budget.stoppedBy, 'page-limit', '页数上限才是这一轮的停止原因')
  assert.equal(first.providers[0].budget.pagesUsed, 10)
  // 预算落盘（Host 持久）：换一次调用读到的是同一份账。
  assert.equal([...deps.ctx.files.keys()].some((key) => key.endsWith('取数预算.json')), true)

  const before = requests
  const again = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'], maxPages: 10 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  assert.equal(requests, before, '页数触顶的来源不再发检索请求')
  assert.equal(again.providers[0].budget.stoppedBy, 'page-limit')
})

test('预算：换关键字**不**重置（同一份账继续累计）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let requests = 0
  const transport = async (url) => {
    if (!url.includes('search.fang.com/house/?')) return okResult(url, '<html>公开页</html>')
    requests += 1
    const keyword = new URL(url).searchParams.get('keyword') ?? ''
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    return okResult(url, listingPage(page, 12))
  }
  const run = async (keyword) => await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword, city: 'beijing', providers: ['fang'], maxPages: 10 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  const first = await run('阳光小区')
  assert.equal(first.providers[0].budget.pagesUsed >= 2, true)
  const used = first.providers[0].budget.pagesUsed
  const before = requests
  const second = await run('完全不同的关键字')
  assert.equal(second.providers[0].budget.pagesUsed, used,
    '换关键字不算新一轮：预算继续累计（否则"换个词"就是无限翻页的旁路）')
  assert.equal(requests, before, '已经触顶之后换词也不再发请求')
})

test('预算：轮次 / 分组不同则各记各的账；同组同轮才累计', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, LISTING_HTML)
    : okResult(url, '<html>公开页</html>')
  const run = async (patch) => await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'], ...patch },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  const sale = await run({ maxPages: 2 })
  assert.equal(sale.providers[0].budget.pagesUsed, 2)
  const saleAgain = await run({ maxPages: 2 })
  assert.equal(saleAgain.providers[0].budget.pagesUsed, 2,
    '同一身份命中已落盘列表快照：复用不重复消耗页数')
  // 换分组（租金）另起一份账；它读不到 sale 的页数。
  const rent = await run({ maxPages: 1, group: 'rent' })
  assert.equal(rent.providers[0].budget.pagesUsed, 1, '分组不同 = 另一份账')
})

test('检索：非估值会话被拒（普通会话不许写案例目录）', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const result = await valuationMarketSearchTools(deps, async (url) => okResult(url, LISTING_HTML))[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing' }, execOf('随便一条会话', VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(result.errorKind, 'policy')
  assert.equal([...ctx.files.keys()].length, 0, '被拒时不许落任何文件')
})

test('检索：keyword / city 为空时在发请求之前拒绝', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let calls = 0
  const tools = valuationMarketSearchTools(deps, async (url) => { calls += 1; return okResult(url, 'x') })
  for (const args of [{ keyword: '', city: 'beijing' }, { keyword: 'k', city: '  ' }]) {
    const result = await tools[0].execute({ caseDir: CASE_DIR, planId: PLAN_ID, ...args }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
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
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang', url: 'https://example.invalid/fang/9' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, true, result.error)
  assert.match(result.file, /^来源证据\/fang-.*\.html$/)
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.bytes, '<html>某套房源页</html>'.length)
  assert.deepEqual(result.capabilityGaps, [SCREENSHOT_GAP])
  assert.equal(ctx.files.has(`${CASE_DIR}/方案/${PLAN_ID}/${result.file}`), true)
})

test('取证：取不到页面时按两次尝试后报失败，不留半个文件', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return failResult(url, '连接被重置') }

  const result = await valuationMarketSearchTools(deps, transport)[1]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang', url: 'https://example.invalid/fang/9' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, false)
  assert.equal(calls, 2, '恰好两次')
  assert.match(result.error, /已尝试 2 次/)
  assert.equal([...ctx.files.keys()].length, 0, '失败时不许留半个证据文件')
})

test('取证：非法来源名被拒，一个请求都不发', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  let calls = 0
  const result = await valuationMarketSearchTools(deps, async (url) => { calls += 1; return okResult(url, 'x') })[1]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, source: 'baidu', url: 'https://example.invalid/x' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))
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
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  const capture = await valuationMarketSearchTools(deps, transport)[1]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang', url: 'https://example.invalid/x' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

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
      { caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang', 'lianjia'] },
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

// ── 能力门禁：知识声明了做不到的能力时，**在任何网络请求之前**阻断 ─────────────

test('能力门禁：知识声明 detail 能力而部署没有对应工具 → 阻断，且一个请求都不发', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return okResult(url, LISTING_HTML) }

  const result = await valuationMarketSearchTools(deps, transport)[0].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'],
    requiredCapabilities: ['market.residential.detail'],
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /能力门禁没有通过/)
  assert.match(result.error, /详情取证|market\.residential\.detail/)
  assert.equal(calls, 0, '门禁不过时不许发出任何取数请求（也不许"先试试看"）')
})

test('能力门禁：降级能力（重算）缺席不阻断取数', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, LISTING_HTML)

  const result = await valuationMarketSearchTools(deps, transport)[0].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'],
    requiredCapabilities: ['workbook.recalculate'],
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, true, result.error)
  assert.match(result.capabilityGaps.join('；'), /降级能力/)
})

test('能力门禁：知识写了不存在的 capability ID → 按缺失处理（不静默放过）', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return okResult(url, LISTING_HTML) }

  const result = await valuationMarketSearchTools(deps, transport)[0].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'],
    requiredCapabilities: ['market.residential.serach'],
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, false)
  assert.match(result.error, /capability ID/)
  assert.equal(calls, 0)
})

// ── P8 · 工具回执与声明的输出 Schema 必须**双向**一致 ────────────────────────
//
// 为什么在 Tool 这一层验：回执是先过 Schema 才进模型上下文的。Schema 少声明一个字段，
// 那条信息就在模型看到之前被丢掉（本轮复现的是 `dedupedAway`、每条案例的证据/截图五列）。
// 所以判据不是"代码看起来写了"，而是"真实回执过得了自己声明的 Schema"。

const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')

/** 文档点名的四条路径：零案例 / 有案例 / 等待验证 / 失败。 */
function searchPathFixtures() {
  return [
    { label: '零案例', transport: async (url) => okResult(url, '<html><body>没有结果</body></html>') },
    { label: '有案例', transport: async (url) => okResult(url, LISTING_HTML) },
    { label: '等待验证', transport: async (url) => failResult(url, '请求失败：超时') },
    {
      label: '失败',
      transport: async (url) => okResult(url, LISTING_HTML),
      requiredCapabilities: ['market.residential.detail'],
    },
  ]
}

function searchArgs(fixture) {
  return {
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'],
    ...(fixture.requiredCapabilities === undefined ? {} : { requiredCapabilities: fixture.requiredCapabilities }),
  }
}

test('P8 输出契约：四条路径的真实回执都通过工具自己声明的 Schema', async () => {
  for (const fixture of searchPathFixtures()) {
    const { deps } = makeDeps()
    const sessionId = openValuation(deps)
    const tools = valuationMarketSearchTools(deps, fixture.transport)
    const value = await tools[0].execute(searchArgs(fixture), execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
    const violations = validateJsonSchemaValue(tools[0].output.schema, value)
    assert.deepEqual(violations, [], `${fixture.label}：${violations.join('；')}`)
    // 被 Schema 拒掉的回执等于"模型看不到这条事实"，所以顺带钉住回执本身是成功的。
    assert.equal(typeof value.phase, 'string', fixture.label)
  }
})

test('P8 输出契约：Schema 声明的字段都在真实回执里出现过（不是"声明了却永不返回"）', async () => {
  const seen = { top: new Set(), case: new Set(), provider: new Set() }
  let schema
  for (const fixture of searchPathFixtures()) {
    const { deps } = makeDeps()
    const sessionId = openValuation(deps)
    const tools = valuationMarketSearchTools(deps, fixture.transport)
    schema = tools[0].output.schema
    const value = await tools[0].execute(searchArgs(fixture), execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
    for (const key of Object.keys(value)) seen.top.add(key)
    for (const item of value.cases ?? []) for (const key of Object.keys(item)) seen.case.add(key)
    for (const item of value.providers ?? []) for (const key of Object.keys(item)) seen.provider.add(key)
  }
  const missing = (declared, actual) => [...declared].filter((key) => !actual.has(key))
  assert.deepEqual(missing(Object.keys(schema.properties), seen.top), [], '顶层声明字段没有被返回')
  assert.deepEqual(missing(Object.keys(schema.properties.cases.items.properties), seen.case), [], '案例声明字段没有被返回')
  assert.deepEqual(missing(Object.keys(schema.properties.providers.items.properties), seen.provider), [], '来源声明字段没有被返回')
})

test('P8 输出契约：取证工具的成功与失败回执同样过 Schema', async () => {
  for (const transport of [
    async (url) => okResult(url, '<html>房源页</html>'),
    async (url) => failResult(url, '连接被重置'),
  ]) {
    const { deps } = makeDeps()
    const sessionId = openValuation(deps)
    const tools = valuationMarketSearchTools(deps, transport)
    const value = await tools[1].execute(
      { caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang', url: 'https://example.invalid/fang/9' },
      execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture),
    )
    const violations = validateJsonSchemaValue(tools[1].output.schema, value)
    assert.deepEqual(violations, [], violations.join('；'))
  }
})

test('P8 恢复任务回执：搜索结果带 retrievalTaskId，且按 项目/方案/来源/页面 绑定', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const tools = valuationMarketSearchTools(deps, async (url) => failResult(url, '请求失败：超时'))
  const result = await tools[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )

  // 人工验证之后要能"继续同一个页面任务"：回执必须给出稳定的任务 id 与逐页台账。
  assert.equal(typeof result.retrievalTaskId, 'string')
  assert.notEqual(result.retrievalTaskId, '')
  assert.equal(result.retrievalTasks.length, 1)
  assert.equal(result.retrievalTasks[0].providerId, 'fang')
  assert.equal(result.retrievalTasks[0].pageNo, 1)
  assert.equal(result.retrievalTasks[0].retrievalTaskId, result.retrievalTaskId)
  assert.equal(result.retrievalTasks[0].state, 'failed')
  const report = result.providers.find((item) => item.id === 'fang')
  assert.equal(report.retrievalTaskId, result.retrievalTaskId, '来源级回执与顶层回执必须指向同一个任务')
})

test('P8 恢复任务身份：相同关键词跨项目 / 跨方案 / 跨页面都不是同一个预算', async () => {
  const { retrievalTaskIdOf } = await import(
    new URL('src/host/tools/report-evaluation/market-search.ts', ROOT).href)
  const base = { projectId: '估值-A', planId: 'plan-001', providerId: 'lianjia', pageNo: 1, keyword: '太阳公元', city: 'beijing' }
  const same = retrievalTaskIdOf(base)
  assert.equal(same, retrievalTaskIdOf({ ...base }), '同一身份必须稳定')
  assert.notEqual(same, retrievalTaskIdOf({ ...base, projectId: '估值-B' }), '跨项目不许共用预算')
  assert.notEqual(same, retrievalTaskIdOf({ ...base, planId: 'plan-002' }), '跨方案不许共用预算')
  assert.notEqual(same, retrievalTaskIdOf({ ...base, providerId: 'fang' }), '跨来源不许共用预算')
  assert.notEqual(same, retrievalTaskIdOf({ ...base, pageNo: 2 }), '跨页面不许共用预算')
  assert.notEqual(same, retrievalTaskIdOf({ ...base, keyword: '太阳宫' }))
  assert.notEqual(same, retrievalTaskIdOf({ ...base, city: 'shanghai' }))
  assert.equal(same.includes('/'), false, '任务 id 不许带路径分隔符（它同时是文件名与恢复记录的键）')
})

// ── P7：业务城市 → 站点城市标识（适配器解析，不让模型猜 beijing） ────────────────

const CITY_PAGE_HTML = `<!doctype html><html><body>
<div class="city_list"><a href="https://bj.lianjia.com/">北京</a><a href="https://sh.lianjia.com/">上海</a></div>
</body></html>`

test('P7：提交业务城市「北京」→ URL 用站点标识 bj，回执带 cityStatus/cityCode', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const urls = []
  const transport = async (url) => {
    urls.push(url)
    return url.includes('/city/') ? okResult(url, CITY_PAGE_HTML) : okResult(url, LISTING_HTML)
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '太阳公元', city: '北京' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.cityStatus, 'resolved')
  assert.equal(result.cityCode, 'bj')
  assert.equal(result.city, '北京', '回执里的业务城市仍是用户提交的那一个')
  assert.equal(urls.some((one) => one.includes('bj.lianjia.com')), true, `实际请求：${urls.join(' | ')}`)
  assert.equal(urls.some((one) => one.includes('beijing.lianjia.com')), false, '不许把中文城市名拼进域名')
})

test('P7：城市不在来源覆盖范围 → **逐来源**记状态、跳过该来源，不把整个输入判非法', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const urls = []
  const transport = async (url) => {
    urls.push(url)
    return url.includes('/city/') ? okResult(url, CITY_PAGE_HTML) : okResult(url, LISTING_HTML)
  }
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '太阳公元', city: '天津' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  // 协议 39：**不**把"来源不覆盖这个地区"写成"你的输入非法" —— 那会让替代来源没机会跑。
  assert.equal(result.ok, true, result.error)
  assert.equal(result.errorKind, '')
  assert.equal(result.cityStatus, 'not-covered')
  assert.equal(result.cityCode, '', '解析不出来就不许给出一个标识')
  assert.deepEqual(result.cityCandidates, ['北京=bj', '上海=sh'])
  // 逐来源状态：**链家是不覆盖**（它自己公布的列表里没有），其他来源是"城市表还没适配"的能力缺口。
  const byId = new Map(result.providers.map((item) => [item.id, item]))
  assert.equal(byId.get('lianjia').cityStatus, 'not-covered')
  assert.equal(byId.get('fang').cityStatus, 'unresolved')
  const gaps = result.capabilityGaps.join('；')
  // "不覆盖"与"还没适配"必须分开说：混同会让员工以为这家不做这个地区。
  assert.match(gaps, /链家：\*\*该来源不覆盖\*\*「天津」这个地区/)
  for (const label of ['房天下', '安居客', '58同城']) {
    assert.match(gaps, new RegExp(`${label}：\\*\\*这个来源的城市表还没适配\\*\\*`))
    assert.match(gaps, new RegExp(`不是"${label}不覆盖这个地区"`),
      `${label} 的缺口必须写明"不是不覆盖"`)
  }
  assert.equal(/输入非法|input/.test(gaps), false)
  // 城市表的依据与来源页随结果交出：报告要能说明"这个结论是哪来的"。
  assert.equal(byId.get('fang').citySourceEvidence, 'public-pattern')
  assert.equal(byId.get('lianjia').cityStatus, 'not-covered')
  assert.equal(urls.some((one) => one.includes('ershoufang') || one.includes('/house/?') || one.includes('/sale/?')),
    false, '解析不出来时一个检索请求都不发（不许擅自换城市）')
  assert.equal(result.nextActions.length >= 1, true, '要给出下一步动作')
  assert.match(result.nextActions.join('；'), /不要\*\*擅自换城市/)
})

test('择优：名额由知识给（代码里没有默认），入选/落选/理由随结果交出，且不改动 cases', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, LISTING_HTML)
    : okResult(url, '<html>公开页</html>')
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const base = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }

  // ① 没给规则：`present: false`，一切照旧（既不猜名额也不猜优先级）。
  const plain = await tool.execute(base, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(plain.selection.present, false)
  assert.equal(plain.selection.maxAdopted, 0)

  // ② 给了规则：对**去重后**的候选做一次批量筛选。
  const picked = await tool.execute({
    ...base,
    selection: {
      maxAdopted: 1, order: [{ key: 'transaction-first' }], sourceOrder: [],
      assessments: [
        { url: 'https://example.invalid/fang/2', status: 'qualified', reason: '成交且字段完整', knowledgeRef: '02 市场法 §2.1' },
        { url: 'https://example.invalid/fang/1', status: 'near-miss', reason: '挂牌不可直接作可比实例', knowledgeRef: '01 渠道与降级策略 §3' },
      ],
    },
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(picked.ok, true, picked.error)
  assert.equal(picked.selection.present, true)
  assert.equal(picked.selection.maxAdopted, 1)
  assert.deepEqual(picked.selection.order, ['transaction-first'])
  assert.equal(picked.selection.adopted.length, 1)
  assert.equal(picked.selection.rejected.length, picked.cases.length - 1)
  assert.equal(picked.cases.length > picked.selection.adopted.length, true,
    'cases **不变**：相近未达标的候选仍要列给用户按编号选')

  // ③ 规则缺名额：拒绝在发请求之前（不按"惯例"补 3）。
  const noQuota = await tool.execute({
    ...base, selection: { order: [{ key: 'transaction-first' }] },
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(noQuota.ok, false)
  assert.equal(noQuota.errorKind, 'input')
  assert.match(noQuota.error, /没有默认名额/)
})

test('适配器依据随结果交出：没有归档字节的来源必须如实报"尚未真机验收"', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, LISTING_HTML)
    : okResult(url, '<html>公开页</html>')
  // 只挑 58同城：它没有归档字节（`public-pattern`），所以必须带一条"尚未真机验收"的缺口。
  const result = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['wuba'] },
      execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  const provider = result.providers[0]
  assert.equal(provider.evidence, 'public-pattern')
  const gaps = result.capabilityGaps.join('；')
  assert.match(gaps, /58同城：该来源的适配器\*\*尚未真机验收\*\*/)
  assert.match(gaps, /不得当成"该小区没有房源"/)

  // 有归档字节的来源（链家）不带这条缺口 —— 不许把"尚未验收"套到有依据的来源上。
  const lianjia = await valuationMarketSearchTools(deps, transport)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['lianjia'] },
      execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(lianjia.providers[0].evidence, 'archived-capture')
  assert.equal(/尚未真机验收/.test(lianjia.capabilityGaps.join('；')), false)
})

// ── 站点清单故障 ─────────────────────────────────────────────────────────────

test('站点清单加载失败时，取数以清单问题失败，且不发起任何取数', async () => {
  const runtime = {
    toolClient: {}, coordinator: {}, sites: [],
    sitesPath: '/nonexistent/browser-sites.json',
    sitesError: '站点清单不存在：/nonexistent/browser-sites.json',
  }
  const { deps } = makeDeps({ browserRuntime: runtime })
  const sessionId = openValuation(deps)
  const result = await valuationMarketSearchTools(deps, undefined)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '力鸿花园', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /站点清单加载失败/)
  assert.match(result.error, /站点清单不存在/, '必须带上清单自己的原因，而不是一句笼统的失败')
  assert.equal(result.cases.length, 0, '清单坏掉时不得产出任何案例')
  assert.equal(result.retrievalTasks.length, 0, '清单坏掉时不得生成取数任务')
})

// ── 协议 40 · 列表快照 / 页级截图 / 事务边界（红测，先于实现）────────────────────
//
// 2026-10-16 诊断里的四条根因在这里复现：
//   1. 截图在**每条房源**的循环里调用（`market-search.ts:915-939`），每条都触发一次
//      `browser shot` 导航 —— 应该是**每页一次**列表页图，供该页每条引用；
//   2. 已成功取回的列表页没有快照可复用：同请求再调一次会重新访问站点、重新消耗预算；
//   3. `估值案例.json` 每次调用**覆盖写**当前批次，而不是同方案/分组/轮次的累计并集；
//   4. `selection` 规则在网络取数与预算消费**之后**才校验。
//
// 断言失败即复现；本轮不改产品源码。第 5、6 条是防止"修成缓存一切"的守卫。

/**
 * 一条**页级**截图能力：同一页无论被问几次都返回同一张列表页图。
 *
 * 这里刻意不按 `caseId` 分文件 —— 普通取数能拿到的只是"这一页的列表图"，
 * 不是"每套房源的详情页证据"；把它说成逐套证明会超出证据实际能支撑的范围。
 */
function makePageScreenshot(ctx, file = '来源证据/截图-列表页.png') {
  const calls = []
  const capability = async (request) => {
    calls.push(request)
    ctx.files.set(`${request.casePath}/${file}`, 'png-bytes')
    return {
      ok: true, error: '', file,
      digest: `sha256:${'a'.repeat(64)}`, bytes: 9,
      capturedAt: '2026-10-16T00:00:00.000Z',
    }
  }
  return { calls, capability }
}

test('协议 40：一页 25 条候选全部保留；列表页截图只调一次并供每条引用', async () => {
  const ctx = makeCtx()
  const shots = makePageScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: shots.capability })
  const sessionId = openValuation(deps)
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, listingPage(1, 25))
    : okResult(url, '<html>公开页</html>')

  const result = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )

  assert.equal(result.cases.length, 25, '一页里明确声明的 25 条候选都要保留')
  assert.equal(result.providers[0].budget.candidatesUsed, 0, '未经评估的原始条目不计入合格候选预算')
  // 普通取数是**页级**截图：一次导航一张列表页图。
  assert.equal(shots.calls.length, 1, `列表页截图应只调用一次，实际 ${shots.calls.length} 次`)
  assert.equal(result.cases.every((item) => item.screenshot !== ''), true)
  assert.equal(new Set(result.cases.map((item) => item.screenshot)).size, 1,
    '同页所有案例引用同一张列表页截图（不能声称是逐套详情证据）')
})

test('协议 40：同一请求第二次复用已成功落盘的列表快照，零新增网络调用与零预算增长', async () => {
  const ctx = makeCtx()
  const shots = makePageScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: shots.capability })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }
  const first = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(first.cases.length, 2)
  const firstCalls = calls
  const firstPages = first.providers[0].budget.pagesUsed
  const firstShots = shots.calls.length

  const second = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls, firstCalls, `第二次同请求不该再访问站点，实际多了 ${calls - firstCalls} 次`)
  assert.equal(shots.calls.length, firstShots, '复用快照不该再触发截图（它同样是一次浏览器导航）')
  assert.equal(second.providers[0].budget.pagesUsed, firstPages, '复用快照不推进预算')
  assert.deepEqual(
    second.cases.map((item) => item.url).sort(),
    first.cases.map((item) => item.url).sort(),
    '复用快照后全部行仍在',
  )
})

test('协议 40：换关键字是新增批次，同方案/分组/轮次的案例清单是累计并集', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => {
    if (!url.includes('search.fang.com/house/?')) return okResult(url, '<html>公开页</html>')
    const keyword = new URL(url).searchParams.get('keyword') ?? ''
    // 两批候选的小区/面积/价格都不同，跨站去重不会把它们并掉。
    return okResult(url, keyword.includes('B') ? listingPage(2, 2) : listingPage(1, 2))
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const base = { caseDir: CASE_DIR, planId: PLAN_ID, city: 'beijing', providers: ['fang'] }
  const first = await tool.execute({ ...base, keyword: 'A' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  const second = await tool.execute({ ...base, keyword: 'B' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(first.cases.length, 2)
  assert.equal(second.cases.length, 4, '第二次结果应是两批候选的并集，不是覆盖')
  assert.equal(new Set([...first.cases, ...second.cases].map((item) => item.url)).size, 4)
  const persisted = JSON.parse(ctx.files.get(second.casesPath))
  assert.equal(persisted.cases.length, 4, '落盘的 估值案例.json 也必须是累计并集')
})

test('协议 40：非法 selection 在任何传输与预算消耗之前被拒', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => { calls += 1; return okResult(url, LISTING_HTML) }
  const result = await valuationMarketSearchTools(deps, transport)[0].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'],
    selection: { order: [{ key: 'transaction-first' }] }, // 缺 maxAdopted
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.errorKind, 'input')
  assert.equal(calls, 0, `非法规则必须在发请求之前拒绝；实际请求 ${calls} 次`)
  assert.equal([...ctx.files.keys()].some((key) => key.endsWith('取数预算.json')), false,
    '被拒时不许消耗预算')
})

test('协议 40：分组 / 轮次不同不得复用上一身份的成功快照（守卫）', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const base = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'], maxPages: 1 }
  await tool.execute({ ...base, group: 'sale', round: 1 }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  const beforeRent = calls
  const rent = await tool.execute({ ...base, group: 'rent', round: 1 }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls > beforeRent, true, '分组不同必须重新取数，不能回放上一分组的列表')
  assert.equal(rent.providers[0].budget.pagesUsed, 1, 'rent 另起一份账')

  const beforeRound = calls
  await tool.execute({ ...base, group: 'sale', round: 2 }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls > beforeRound, true, '轮次不同必须重新取数')
  const stored = [...ctx.files.entries()].find(([key]) => key.endsWith('取数预算.json'))
  assert.notEqual(stored, undefined)
  assert.equal(JSON.parse(stored[1]).round, 2, '新轮次写进自己的账本')
})

test('协议 40：失败 / captcha 页不得被当成成功快照缓存（守卫）', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  let pageOutcome = 'fail'
  const transport = async (url) => {
    calls += 1
    if (!url.includes('search.fang.com/house/?')) return okResult(url, '<html>公开页</html>')
    return pageOutcome === 'fail' ? failResult(url, '请求失败：超时') : okResult(url, LISTING_HTML)
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: '阳光小区', city: 'beijing', providers: ['fang'] }
  const failed = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(failed.cases.length, 0)

  const before = calls
  pageOutcome = 'ok'
  const second = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls > before, true, '上一次失败不能被当成成功快照：必须重新取数')
  assert.equal(second.cases.length, 2, '重取后拿到真实候选')
})

// Knowledge assessment drives the qualified budget; raw rows never count before it.

/** JSON-LD page from explicit row specs; `area: null` omits floorSize. */
function rowsPage(rows) {
  const graph = rows.map((row, index) => ({
    '@type': 'RealEstateListing',
    name: row.name,
    url: row.url,
    address: { '@type': 'PostalAddress', streetAddress: row.community ?? `小区${String(index)}` },
    ...(row.area === null ? {} : { floorSize: { value: row.area ?? 100, unitText: '㎡' } }),
    price: row.price ?? '200万',
    datePosted: '2026-09-01',
  }))
  return `<!doctype html><html><head><script type="application/ld+json">`
    + JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    + '</script></head><body>房源列表</body></html>'
}

test('协议 40：未经知识评估的原始候选全部返回，合格预算不因原始条数增加', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, listingPage(1, 25))
    : okResult(url, '<html>公开页</html>')
  const result = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  assert.equal(result.cases.length, 25, '一行都不许裁掉')
  assert.equal(result.providers[0].budget.pagesUsed, 1)
  assert.equal(result.providers[0].budget.candidatesUsed, 0, '未经评估的原始条目不计入合格候选')
})

test('协议 40：复用同查询快照时只按事实合格的 qualified 计合格预算', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const page = rowsPage([
    { name: '阳光小区 成交价 180 万', url: 'https://example.invalid/q1', area: 90 },
    { name: '阳光小区 成交价 181 万', url: 'https://example.invalid/q2', area: 91 },
    { name: '阳光小区 成交价 182 万', url: 'https://example.invalid/n1', area: 150 },
    { name: '阳光小区 挂牌价 200 万', url: 'https://example.invalid/u1', area: 90 },
    { name: '阳光小区 成交价 183 万', url: 'https://example.invalid/u2', area: null },
    // Factually eligible but left unassessed: it is unreviewed and must not count.
    { name: '阳光小区 成交价 184 万', url: 'https://example.invalid/u3', area: 92 },
  ])
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, page)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const base = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }
  await tool.execute(base, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  const firstCalls = calls
  const second = await tool.execute({
    ...base,
    selection: {
      maxAdopted: 3, order: [{ key: 'transaction-first' }], sourceOrder: [],
      assessments: [
        { url: 'https://example.invalid/q1', status: 'qualified', reason: '成交且字段完整', knowledgeRef: '02 市场法 §2.1' },
        { url: 'https://example.invalid/q2', status: 'qualified', reason: '成交且字段完整', knowledgeRef: '02 市场法 §2.1' },
        { url: 'https://example.invalid/n1', status: 'near-miss', reason: '面积偏差超过规则上限', knowledgeRef: '02 候选筛选与相近案例 §2' },
        { url: 'https://example.invalid/u1', status: 'qualified', reason: '模型标注为合格', knowledgeRef: '01 渠道与降级策略 §3' },
        { url: 'https://example.invalid/u2', status: 'qualified', reason: '模型标注为合格', knowledgeRef: '02 市场法 §2.1' },
      ],
    },
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(calls, firstCalls, '同一查询复用快照，不再访问站点')
  assert.equal(second.providers[0].budget.candidatesUsed, 2,
    '挂牌与缺面积即使被标 qualified 也不计；near-miss 不计')
})

test('协议 40：超出采用名额的合格候选仍计入合格预算', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const page = rowsPage([
    { name: '阳光小区 成交价 180 万', url: 'https://example.invalid/q1', area: 90 },
    { name: '阳光小区 成交价 181 万', url: 'https://example.invalid/q2', area: 91 },
    { name: '阳光小区 成交价 182 万', url: 'https://example.invalid/q3', area: 92 },
    { name: '阳光小区 成交价 183 万', url: 'https://example.invalid/q4', area: 93 },
    { name: '阳光小区 挂牌价 200 万', url: 'https://example.invalid/u1', area: 94 },
  ])
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, page)
    : okResult(url, '<html>公开页</html>')
  const assessments = [
    ...['q1', 'q2', 'q3', 'q4'].map((name) => ({
      url: `https://example.invalid/${name}`, status: 'qualified',
      reason: '成交且字段完整', knowledgeRef: '02 市场法 §2.1',
    })),
    { url: 'https://example.invalid/u1', status: 'qualified', reason: '模型标注为合格', knowledgeRef: '01 渠道与降级策略 §3' },
  ]
  const result = await valuationMarketSearchTools(deps, transport)[0].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'],
    selection: { maxAdopted: 2, order: [{ key: 'transaction-first' }], sourceOrder: [], assessments },
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.selection.adopted.length, 2)
  assert.equal(result.providers[0].budget.candidatesUsed, 4, '名额之外的合格候选同样占预算')
})

// ── Detail evidence: per-case screenshot, actual detail URL, durable image index ──

function makeDetailScreenshot(ctx, relative = '推理结果/图片/case-001-阳光小区/详情.png') {
  const calls = []
  const capability = async (request) => {
    calls.push(request)
    ctx.files.set(`${request.casePath}/${relative}`, 'png-bytes')
    return {
      ok: true, error: '', file: relative, digest: `sha256:${'d'.repeat(64)}`,
      bytes: 9, capturedAt: '2026-10-16T00:00:00.000Z',
    }
  }
  return { calls, capability, relative }
}

test('详情取证：可读详情页按 caseId 截详情页并落逐案证据与图片清单', async () => {
  const ctx = makeCtx()
  const detail = makeDetailScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: detail.capability })
  const sessionId = openValuation(deps)
  const finalUrl = 'https://fang.example.invalid/detail/阳光 小区-7'
  const requestedUrl = `${finalUrl}?utm_source=list`
  const transport = async (url) => okResult(finalUrl, '<html>某套房源详情页</html>')

  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: requestedUrl, caseId: 'case-001-阳光小区',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, true, result.error)
  assert.equal(detail.calls.length, 1, '详情页可读时必须且只截一次详情页')
  assert.equal(detail.calls[0].url, finalUrl, '截的必须是真实详情 URL（重定向之后的最终地址）')
  assert.equal(detail.calls[0].caseId, 'case-001-阳光小区')
  assert.equal(result.screenshot, detail.relative, '回执要带上详情页截图路径')
  assert.equal(result.sourceUrl, finalUrl, '回执要带上真实详情 URL')
  assert.equal(ctx.files.has(`${CASE_DIR}/方案/${PLAN_ID}/${detail.relative}`), true,
    '图片落在方案的 推理结果/图片/ 下')
  const manifestKey = [...ctx.files.keys()].find((key) => key.endsWith('推理结果/图片/图片清单.json'))
  assert.notEqual(manifestKey, undefined, '逐案证据必须写进 推理结果/图片/图片清单.json（可复核映射）')
  const manifest = JSON.stringify(JSON.parse(ctx.files.get(manifestKey)))
  assert.match(manifest, /case-001-阳光小区/)
  assert.match(manifest, /推理结果\/图片\//)
  assert.match(manifest, /https:\/\/fang\.example\.invalid\/detail\//)
  assert.match(manifest, /detail-screenshot/, '清单必须显式标明详情截图')
})

test('详情取证：图片清单已损坏时显式失败、不覆盖也不截图', async () => {
  const ctx = makeCtx()
  const detail = makeDetailScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: detail.capability })
  const sessionId = openValuation(deps)
  const manifestPath = `${PLAN_DIR}/推理结果/图片/图片清单.json`
  ctx.files.set(manifestPath, '{broken json')
  const transport = async (url) => okResult(url, '<html>某套房源详情页</html>')

  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/1', caseId: 'case-001',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, false, '损坏的清单必须显式失败')
  assert.equal(['file', 'infrastructure'].includes(result.errorKind), true, `errorKind=${result.errorKind}`)
  assert.equal(result.screenshot ?? '', '', '清单损坏时不许声称截图成功')
  assert.equal(detail.calls.length, 0, '清单损坏时必须在截图前失败')
  assert.equal(ctx.files.get(manifestPath), '{broken json', '不得覆盖已损坏的清单')
})

test('详情取证：图片清单属于别的方案时显式失败、不覆盖也不截图', async () => {
  const ctx = makeCtx()
  const detail = makeDetailScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: detail.capability })
  const sessionId = openValuation(deps)
  const manifestPath = `${PLAN_DIR}/推理结果/图片/图片清单.json`
  const other = JSON.stringify({
    schemaVersion: 'crwu.valuation.screenshot-manifest.v1',
    planId: 'plan-OTHER',
    entries: [{
      caseId: 'old', displayName: '旧案例', provider: 'fang',
      sourceUrl: 'https://fang.example.invalid/detail/old', capturedAt: '2026-10-15T00:00:00Z',
      relativePath: '推理结果/图片/old/1.png', digest: 'sha256:old', validity: 'valid',
    }],
  })
  ctx.files.set(manifestPath, other)
  const transport = async (url) => okResult(url, '<html>某套房源详情页</html>')

  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/1', caseId: 'case-001',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, false)
  assert.equal(['file', 'infrastructure'].includes(result.errorKind), true)
  assert.equal(detail.calls.length, 0, '清单身份不符时必须在截图前失败')
  assert.equal(ctx.files.get(manifestPath), other, '不得覆盖属于别的方案的清单')
})

test('详情取证：已有合法清单时保留其它案例并替换当前案例', async () => {
  const ctx = makeCtx()
  const detail = makeDetailScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: detail.capability })
  const sessionId = openValuation(deps)
  const manifestPath = `${PLAN_DIR}/推理结果/图片/图片清单.json`
  const oldEntry = {
    caseId: 'case-old', displayName: '旧案例', provider: 'fang',
    sourceUrl: 'https://fang.example.invalid/detail/old', capturedAt: '2026-10-15T00:00:00Z',
    relativePath: '推理结果/图片/case-old/1.png', digest: 'sha256:old', validity: 'valid',
    evidenceType: 'detail-screenshot',
  }
  ctx.files.set(manifestPath, JSON.stringify({
    schemaVersion: 'crwu.valuation.screenshot-manifest.v1', planId: PLAN_ID, entries: [oldEntry],
  }))
  const transport = async (url) => okResult(url, '<html>某套房源详情页</html>')
  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/1', caseId: 'case-001',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.ok, true, result.error)
  const stored = JSON.parse(ctx.files.get(manifestPath))
  assert.deepEqual(stored.entries.map((entry) => entry.caseId).sort(), ['case-001', 'case-old'],
    '旧案例必须保留')
})

test('详情取证：没有截图能力时如实记缺口，绝不伪造截图成功', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html>详情</html>')
  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/1', caseId: 'case-001',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.screenshot ?? '', '', '没有截图能力时不许给出截图路径')
  assert.match(result.capabilityGaps.join('；'), /截图|screenshot/i)
})

test('详情取证：截图失败只记缺口，不回填旧图也不伪造成功', async () => {
  const ctx = makeCtx()
  const capability = async () => ({ ok: false, error: '截图引擎失败', file: '', digest: '', bytes: 0, capturedAt: '' })
  const { deps } = makeDeps({ ctx, screenshot: capability })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html>详情</html>')
  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/1', caseId: 'case-001',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.screenshot ?? '', '')
  assert.match(result.capabilityGaps.join('；'), /截图|失败/)
})

test('详情取证：挑战 / 登录页不得被当成有效详情截图', async () => {
  const ctx = makeCtx()
  const detail = makeDetailScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: detail.capability })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult(url, '<html>请完成安全验证 滑动验证</html>', { captcha: true })
  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/1', caseId: 'case-001',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.screenshot ?? '', '', '挑战页不是详情证据')
  assert.match(result.capabilityGaps.join('；'), /挑战|验证|截图/)
  assert.equal(detail.calls.length, 0, '挑战页不得触发"详情截图成功"')
})

test('详情取证：重定向到另一条房源时不得当成原案例证据', async () => {
  const ctx = makeCtx()
  const detail = makeDetailScreenshot(ctx, '推理结果/图片/case-111/详情.png')
  const { deps } = makeDeps({ ctx, screenshot: detail.capability })
  const sessionId = openValuation(deps)
  const transport = async (url) => okResult('https://fang.example.invalid/detail/999.html', '<html>另一套房源详情</html>')
  const result = await valuationMarketSearchTools(deps, transport)[1].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, source: 'fang',
    url: 'https://fang.example.invalid/detail/111.html', caseId: 'case-111',
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketCapture))

  assert.equal(result.screenshot ?? '', '', '重定向到另一条房源时不得把这一页当原案例证据')
  assert.match(result.capabilityGaps.join('；'), /房源|重定向|不一致|截图/)
})

// ── List snapshot/ledger integrity and fail-fast environment writes ──

test('列表快照分账：sale 2页 → rent 1页 → sale 恢复原2页，新轮次不复用', async () => {
  const ctx = makeCtx()
  const shots = makePageScreenshot(ctx)
  const { deps } = makeDeps({ ctx, screenshot: shots.capability })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const base = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }
  const sale = await tool.execute({ ...base, group: 'sale', round: 1, maxPages: 2 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(sale.providers[0].budget.pagesUsed, 2)

  const rent = await tool.execute({ ...base, group: 'rent', round: 1, maxPages: 1 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(rent.providers[0].budget.pagesUsed, 1, '换分组另起一份账')

  const beforeCalls = calls
  const beforeShots = shots.calls.length
  const saleAgain = await tool.execute({ ...base, group: 'sale', round: 1, maxPages: 2 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls, beforeCalls, '恢复 sale 身份不该再访问站点')
  assert.equal(shots.calls.length, beforeShots, '恢复 sale 身份也不该再截图')
  assert.equal(saleAgain.providers[0].budget.pagesUsed, 2, '恢复的是 sale 原来的两页预算')

  const round2 = await tool.execute({ ...base, group: 'sale', round: 2, maxPages: 1 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls > beforeCalls, true, '新一轮不能复用上一轮的列表快照')
  assert.equal(round2.providers[0].budget.pagesUsed, 1, '新一轮另起一份账')
})

test('列表快照损坏：显式失败且不静默重取', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }
  const first = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(first.cases.length, 2)
  const pageKey = [...ctx.files.keys()].find((key) => key.includes('列表快照/pages/'))
  assert.notEqual(pageKey, undefined, '要先落下页面快照')
  ctx.files.set(pageKey, '{broken json')

  const before = calls
  const again = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(again.ok, false, '损坏的快照必须显式失败')
  assert.equal(['file', 'infrastructure'].includes(again.errorKind), true, `errorKind=${again.errorKind}`)
  assert.equal(calls, before, '不得静默重新取数')
})

test('台账落盘失败：环境写入失败即停止，不继续取剩余页', async () => {
  let ledgerWrites = 0
  const ctx = makeCtx({ failWrite: {
    test: (path) => String(path).includes('列表快照') && ++ledgerWrites > 1,
  } })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let pageFetches = 0
  const transport = async (url) => {
    if (!url.includes('search.fang.com/house/?')) return okResult(url, '<html>公开页</html>')
    pageFetches += 1
    return okResult(url, listingPage(1, 12))
  }
  const result = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'], maxPages: 5 },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  assert.equal(result.ok, false, '台账写不下去就必须显式失败')
  assert.equal(['file', 'infrastructure'].includes(result.errorKind), true, `errorKind=${result.errorKind}`)
  assert.equal(pageFetches < 5, true, '第一个环境写失败就停，不再取剩余页')
  assert.equal(result.cases.length > 0, true, '已经观察到的行要保留')
})

test('同一弱事实的 20 个不同 URL 合格候选都要占合格预算', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const rows = Array.from({ length: 20 }, (_, index) => ({
    name: '同小区 成交价 200 万',
    url: `https://example.invalid/same/${String(index)}`,
    community: '同小区', area: 90, price: '200万',
  }))
  const transport = async (url) => url.includes('search.fang.com/house/?')
    ? okResult(url, rowsPage(rows))
    : okResult(url, '<html>公开页</html>')
  const assessments = rows.map((row) => ({
    url: row.url, status: 'qualified', reason: '成交且字段完整', knowledgeRef: '02 市场法 §2.1',
  }))
  const result = await valuationMarketSearchTools(deps, transport)[0].execute({
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'],
    selection: { maxAdopted: 3, order: [{ key: 'transaction-first' }], sourceOrder: [], assessments },
  }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.cases.length, 20, '不同 URL 不能按弱事实合并')
  assert.equal(result.providers[0].budget.candidatesUsed, 20, '合格预算按不同 URL 计，不按弱事实合并')
})

test('未授权 + 中文城市：授权前零出站（城市解析也不许发请求）', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  const state = {
    ...createWorkbenchState(CONFIG),
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
  const transport = async (url) => { calls += 1; return okResult(url, '<html>城市列表</html>') }
  const result = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: '北京', providers: ['fang'] },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  assert.equal(result.errorKind, 'policy')
  assert.equal(calls, 0, '授权前零出站：中文城市解析也不许发请求')
})

test('列表台账按城市分账：不同城市不复用列表快照也不共用预算', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const base = {
    caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', providers: ['fang'],
    maxPages: 1, group: 'sale', round: 1,
  }
  const beijing = await tool.execute({ ...base, city: 'beijing' },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(beijing.providers[0].budget.pagesUsed, 1)

  const before = calls
  const shanghai = await tool.execute({ ...base, city: 'shanghai' },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls > before, true, '不同城市必须重新取数')
  assert.equal(shanghai.providers[0].budget.pagesUsed, 1, '不同城市另起一份账')

  const beforeReplay = calls
  const beijingAgain = await tool.execute({ ...base, city: 'beijing' },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls, beforeReplay, '回到原城市应复用已落盘的列表快照')
  assert.equal(beijingAgain.providers[0].budget.pagesUsed, 1, '回到原城市应恢复原来的预算')
})

test('预算镜像落盘失败不丢账：下一次从台账恢复预算且不重新取数', async () => {
  const ctx = makeCtx({ failWrite: /取数预算\.json/ })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'], maxPages: 2 }
  const first = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(first.ok, false, '镜像写失败必须显式失败')
  assert.equal(first.providers[0].budget.pagesUsed, 1, '环境写失败后不再取第二页')

  const before = calls
  const again = await tool.execute({ ...args, maxPages: 1 }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(calls, before, '台账仍在：恢复预算不该重新取数')
  assert.equal(again.providers[0].budget.pagesUsed, 1, '镜像失败后不得把预算重置为 0')
})

test('列表快照：证据字节变化后必须显式失败，不得静默重取', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }
  const first = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(first.cases.length, 2)

  const pageKey = [...ctx.files.keys()].find((key) => key.includes('列表快照/pages/'))
  const snapshot = JSON.parse(ctx.files.get(pageKey))
  const evidenceKey = [...ctx.files.keys()].find((key) => key.endsWith(snapshot.evidenceFile))
  assert.notEqual(evidenceKey, undefined, '快照必须指向已落盘的证据')
  ctx.files.set(evidenceKey, '<html>被改过的证据字节</html>')
  const before = calls
  const again = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(again.ok, false, '证据字节变化必须显式失败')
  assert.equal(['file', 'infrastructure'].includes(again.errorKind), true, `errorKind=${again.errorKind}`)
  assert.equal(calls, before, '证据损坏时不得静默重新取数')
})

test('列表快照：证据文件丢失后必须显式失败，不得静默重取', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }
  const first = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(first.cases.length, 2)

  const pageKey = [...ctx.files.keys()].find((key) => key.includes('列表快照/pages/'))
  const snapshot = JSON.parse(ctx.files.get(pageKey))
  const evidenceKey = [...ctx.files.keys()].find((key) => key.endsWith(snapshot.evidenceFile))
  ctx.files.delete(evidenceKey)
  const before = calls
  const again = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(again.ok, false, '证据丢失必须显式失败')
  assert.equal(['file', 'infrastructure'].includes(again.errorKind), true, `errorKind=${again.errorKind}`)
  assert.equal(calls, before, '证据丢失时不得静默重新取数')
})

test('列表快照：页面镜像缺失时从台账本地恢复，零浏览器重取', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return url.includes('search.fang.com/house/?')
      ? okResult(url, LISTING_HTML)
      : okResult(url, '<html>公开页</html>')
  }
  const tool = valuationMarketSearchTools(deps, transport)[0]
  const args = { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] }
  const first = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(first.providers[0].budget.pagesUsed, 1)

  const pageKey = [...ctx.files.keys()].find((key) => key.includes('列表快照/pages/'))
  assert.notEqual(pageKey, undefined, '先要有页面镜像')
  ctx.files.delete(pageKey)
  const before = calls
  const again = await tool.execute(args, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))
  assert.equal(again.ok, true, again.error)
  assert.equal(calls, before, '缺失的页面镜像必须从台账本地恢复，不得重取')
  assert.equal(again.providers[0].budget.pagesUsed, 1, '恢复不得增长预算')
  assert.equal(ctx.files.has(pageKey), true, '恢复后页面镜像必须回读一致')
})

test('非法 planId 在城市解析之前拒绝，零出站', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return okResult(url, '<html>城市列表</html>')
  }
  const result = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: '../escape', keyword: 'k', city: '北京', providers: ['fang'] },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  assert.equal(result.ok, false)
  assert.equal(calls, 0, '非法 planId 必须在任何城市网络之前拒绝')
})

test('列表台账解析：畸形行 / 预算 / 页面映射一律整体返回 null', async () => {
  const { LIST_LEDGER_SCHEMA, parseListLedger } = await import(
    new URL('src/host/domains/report-evaluation/market/list-snapshot.ts', ROOT).href)
  const scope = { projectId: 'p', planId: 'plan', group: 'sale', round: 1, city: 'beijing' }
  const base = { schemaVersion: LIST_LEDGER_SCHEMA, scope, city: 'beijing', updatedAt: 't' }
  const empty = parseListLedger({ ...base, rows: [] }, scope)
  assert.notEqual(empty, null, '空行数组是合法的初始台账')
  assert.equal(empty.rows.length, 0)
  assert.equal(parseListLedger({ ...base, rows: [null] }, scope), null, 'null 行必须整体拒绝')
  assert.equal(parseListLedger({ ...base, rows: [{ url: 'nope' }] }, scope), null, '非法 URL 行必须拒绝')
  assert.equal(parseListLedger({ ...base, rows: [], budget: { schemaVersion: 'bad' } }, scope), null,
    '提供的预算不合法时整体拒绝')
  assert.equal(parseListLedger({ ...base, rows: [], pages: { 'k-1': {} } }, scope), null,
    '页面映射条目非法时整体拒绝')
  const zeroRow = {
    url: 'https://example.invalid/1', source: 'fang', title: 'x', evidence: 'source.html',
    screenshot: '', screenshot_digest: '', screenshot_captured_at: '',
    building_area: 0, unit_price: 0, notes: [],
  }
  const withZero = parseListLedger({ ...base, rows: [zeroRow] }, scope)
  assert.notEqual(withZero, null, '零面积 / 零单价是观察值，缓存必须仍可回放')
  assert.equal(withZero.rows.length, 1)
})

test('损坏的取数预算镜像显式失败，零出站', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  ctx.files.set(`${PLAN_DIR}/取数预算.json`, '{broken json')
  let calls = 0
  const transport = async (url) => {
    calls += 1
    return okResult(url, LISTING_HTML)
  }
  const result = await valuationMarketSearchTools(deps, transport)[0].execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, keyword: 'k', city: 'beijing', providers: ['fang'] },
    execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch),
  )
  assert.equal(result.ok, false, '损坏的预算镜像必须显式失败')
  assert.equal(['file', 'infrastructure'].includes(result.errorKind), true, `errorKind=${result.errorKind}`)
  assert.equal(calls, 0, '预算损坏时不得发任何请求')
})
