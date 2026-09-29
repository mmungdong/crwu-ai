/**
 * 内置浏览器登录（客户端核心）的单测。
 *
 * 重点四条：
 * 1. **桥的形状判据**：少一个方法就整体降级（半个桥只会在用户点下去之后才炸）；
 * 2. **令牌形状**：不到「像 JWT 且未过期」绝不外送（否则等于让 CLI 去说"令牌无效"）；
 * 3. **attach 顺序**：先 acquire → 用批准的分区 + `about:blank#<lease>` 建元素 → 挂上 →
 *    等 `dom-ready` → 才导航（顺序错了主进程会把 guest 关掉，且日志干净）；
 * 4. **令牌只出现一次**：读到就 onToken，随后自动收尾并释放 lease。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const {
  LOGIN_PARTITION_KEY, H3YUN_LOGIN_URL, bridgeOf, parseH3yunToken, isSessionJwt,
  authCodeLocationOf, startH3yunLoginGuest,
} = await import(new URL('src/client/features/environment/login-browser.ts', ROOT).href)

/** 造一个未过期的会话 JWT（形状与氚云一致：enginecode / userid / exp）。 */
function sessionJwt(overrides = {}) {
  const claims = { enginecode: 'eng-1', userid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600, ...overrides }
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

/** 假时钟：等待变成可手动触发的事件。 */
function fakeClock() {
  const afters = []
  const everies = []
  return {
    afters, everies,
    every(ms, run) { const entry = { ms, run, cancelled: false }; everies.push(entry); return () => { entry.cancelled = true } },
    after(ms, run) { const entry = { ms, run, cancelled: false }; afters.push(entry); return () => { entry.cancelled = true } },
  }
}

/** 假 `<webview>`：记录属性、导航、脚本调用，并允许手动触发事件。 */
function fakeView(cookieValue = '') {
  const listeners = new Map()
  const attributes = {}
  const calls = { loadURL: [], scripts: [], removed: 0 }
  return {
    attributes, calls,
    setAttribute(name, value) { attributes[name] = value },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
    },
    loadURL(url) { calls.loadURL.push(url) },
    async executeJavaScript(code) { calls.scripts.push(code); return cookieValue },
    remove() { calls.removed += 1 },
    fire(name, event) { for (const listener of listeners.get(name) ?? []) listener(event ?? {}) },
    hasListener(name) { return (listeners.get(name) ?? []).length > 0 },
  }
}

function fakeBridge() {
  const calls = { acquire: [], release: [], openRequested: [] }
  const openListeners = new Map()
  return {
    calls, openListeners,
    async acquire(key) { calls.acquire.push(key); return { lease: 'lease-1', partition: 'dsh-sidebar-browser-x' } },
    async release(lease) { calls.release.push(lease) },
    onOpenRequested(lease, listener) {
      calls.openRequested.push(lease)
      openListeners.set(lease, listener)
      return () => { openListeners.delete(lease) }
    },
  }
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

// ── 纯函数 ─────────────────────────────────────────────────────────────────

test('bridgeOf 只在三个方法都在时才认这座桥', () => {
  const full = { acquire() {}, release() {}, onOpenRequested() {} }
  assert.equal(bridgeOf({ protocolVersion: 1, browser: full }), full)
  // Web profile 的载体就是这个形状：有 protocolVersion、没有 browser。
  assert.equal(bridgeOf({ protocolVersion: 1 }), undefined)
  assert.equal(bridgeOf(undefined), undefined)
  assert.equal(bridgeOf(null), undefined)
  assert.equal(bridgeOf({ browser: null }), undefined)
  // 少任何一个方法都整体降级：半个桥会在用到时才炸，而那时用户已经点了按钮。
  for (const missing of ['acquire', 'release', 'onOpenRequested']) {
    const partial = { ...full }
    delete partial[missing]
    assert.equal(bridgeOf({ browser: partial }), undefined, `缺 ${missing} 必须判为不可用`)
  }
})

test('parseH3yunToken 只取 h3_token，取不到就回空串', () => {
  assert.equal(parseH3yunToken('a=1; h3_token=abc.def.ghi; b=2'), 'abc.def.ghi')
  assert.equal(parseH3yunToken('h3_token=abc'), 'abc')
  assert.equal(parseH3yunToken('h3_token= abc '), 'abc')
  assert.equal(parseH3yunToken('h3_token_other=1'), '')
  // 值里出现 `h3_token=` 不算：判据是「cookie 名在边界上」，不是「字符串里出现过」。
  assert.equal(parseH3yunToken('other=h3_token=FAKE'), '')
  assert.equal(parseH3yunToken(''), '')
  assert.equal(parseH3yunToken('a=1'), '')
})

test('isSessionJwt 只接受三段式、claims 齐全且未过期的令牌', () => {
  assert.equal(isSessionJwt(sessionJwt()), true)
  assert.equal(isSessionJwt('a.b'), false, '两段不是 JWT')
  assert.equal(isSessionJwt(''), false)
  assert.equal(isSessionJwt('a..c'), false, '空段不是有效 JWT')
  assert.equal(isSessionJwt(sessionJwt({ exp: Math.floor(Date.now() / 1000) - 10 })), false, '过期的不外送')
  assert.equal(isSessionJwt(sessionJwt({ exp: undefined })), false, '没有 exp 的不外送')
  assert.equal(isSessionJwt(sessionJwt({ userid: undefined })), false, '缺少身份声明的不外送')
  assert.equal(isSessionJwt('not-base64.not-json.x'), false, '解析不了就当作不是')
})

test('authCodeLocationOf 只回主机与路径，绝不带 code 值', () => {
  assert.equal(authCodeLocationOf('https://www.h3yun.com/entry/login/corp?code=SECRET&state=STATE'),
    'www.h3yun.com/entry/login/corp')
  assert.equal(authCodeLocationOf('https://www.h3yun.com/entry/login/dingtalk'), '')
  assert.equal(authCodeLocationOf('not a url'), '')
})

// ── 驱动 ───────────────────────────────────────────────────────────────────

test('驱动按「先 attach 再导航」的顺序走，并在读到令牌后收尾', async () => {
  const cookie = `a=1; h3_token=${sessionJwt()}; b=2`
  const bridge = fakeBridge()
  const view = fakeView(cookie)
  const clock = fakeClock()
  const states = []
  const tokens = []
  const mounted = []
  const controller = startH3yunLoginGuest({
    bridge, createView: () => view, mount: (element) => mounted.push(element),
    onState: (state) => states.push(state), onToken: (token) => tokens.push(token), clock,
  })

  await flush()
  // ① 分区键是登录专用键，不是工作空间键。
  assert.deepEqual(bridge.calls.acquire, [LOGIN_PARTITION_KEY])
  // ② 元素用的必须是主进程批准的分区与 `about:blank#<lease>`，否则 attach 会被拒。
  assert.equal(view.attributes.partition, 'dsh-sidebar-browser-x')
  assert.equal(view.attributes.src, 'about:blank#lease-1')
  assert.equal(mounted.length, 1)
  // ③ 还没 dom-ready 就不许导航。
  assert.deepEqual(view.calls.loadURL, [], 'dom-ready 之前不许导航')

  view.fire('dom-ready')
  await flush()
  assert.deepEqual(view.calls.loadURL, [H3YUN_LOGIN_URL])
  assert.deepEqual(states, ['preparing', 'waiting'])

  // ④ 轮询一次：读到合法令牌 → 只回调一次 → 自动收尾。
  clock.everies[0].run()
  await flush()
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0], parseH3yunToken(cookie))
  assert.equal(states.includes('token'), true)
  assert.deepEqual(bridge.calls.release, ['lease-1'], '收尾必须释放 lease')
  assert.equal(view.calls.removed, 1)

  // ⑤ 收尾后再触发轮询也不该再回调（幂等）。
  clock.everies[0].run()
  await flush()
  assert.equal(tokens.length, 1)
  await controller.stop()
  assert.deepEqual(bridge.calls.release, ['lease-1'], 'stop 可重复调用')
})

test('驱动在令牌过期时不外送，仍然等下一条 cookie', async () => {
  const expired = sessionJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
  const bridge = fakeBridge()
  const view = fakeView(`h3_token=${expired}`)
  const clock = fakeClock()
  const tokens = []
  const states = []
  startH3yunLoginGuest({
    bridge, createView: () => view, mount: () => {}, clock,
    onState: (state) => states.push(state), onToken: (token) => tokens.push(token),
  })
  await flush()
  view.fire('dom-ready')
  await flush()
  clock.everies[0].run()
  await flush()
  assert.deepEqual(tokens, [], '过期令牌不该送出去')
  assert.equal(states.includes('token'), false)
})

test('导航里出现 ?code= 时走备通道，且只回主机与路径', async () => {
  const bridge = fakeBridge()
  const view = fakeView('')
  const clock = fakeClock()
  const codes = []
  startH3yunLoginGuest({
    bridge, createView: () => view, mount: () => {}, clock,
    onState: () => {}, onToken: () => {}, onAuthCode: (location) => codes.push(location),
  })
  await flush()
  view.fire('dom-ready')
  await flush()
  view.fire('did-navigate', { url: 'https://www.h3yun.com/entry/login/corp?code=SECRET' })
  assert.deepEqual(codes, ['www.h3yun.com/entry/login/corp'])
  assert.equal(codes.join('').includes('SECRET'), false, 'code 值绝不进状态/日志')
})

test('超时与 attach 失败都收尾并释放 lease', async () => {
  const bridge = fakeBridge()
  const view = fakeView('')
  const clock = fakeClock()
  const states = []
  startH3yunLoginGuest({
    bridge, createView: () => view, mount: () => {}, clock,
    onState: (state) => states.push(state), onToken: () => {},
  })
  await flush()
  view.fire('dom-ready')
  await flush()
  // after[0] 是 dom-ready 守卫，after[1] 才是登录总超时。
  clock.afters[1].run()
  await flush()
  assert.equal(states.at(-1), 'timeout')
  assert.deepEqual(bridge.calls.release, ['lease-1'])

  // attach 失败：dom-ready 守卫超时 → error，且不许导航。
  const bridge2 = fakeBridge()
  const view2 = fakeView('')
  const clock2 = fakeClock()
  const states2 = []
  startH3yunLoginGuest({
    bridge: bridge2, createView: () => view2, mount: () => {}, clock: clock2,
    onState: (state) => states2.push(state), onToken: () => {},
  })
  await flush()
  clock2.afters[0].run()
  await flush()
  assert.equal(states2.at(-1), 'error')
  assert.deepEqual(view2.calls.loadURL, [], 'attach 没成就绝不导航')
  assert.deepEqual(bridge2.calls.release, ['lease-1'])
})
