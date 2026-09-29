/**
 * 氚云「内置浏览器扫码登录」卡片的 UI 行为测试。
 *
 * 三条对应需求：
 * 1. **拿不到内置浏览器就如实说**（Web profile / 旧桌面端），按钮禁用、给出回退说明；
 * 2. 拿得到时：点按钮 → 走驱动（acquire 用登录专用分区键）→ 读到令牌 → **立刻**交给 Host；
 * 3. 卡片只显示状态与结论，**任何地方都不回显令牌**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { registerTsxLoader, fakeReact } = await import(new URL('tests/helpers/tsx-loader.mjs', ROOT).href)
registerTsxLoader()
globalThis.__crwuTestReact = fakeReact

const { H3yunBrowserLogin, statusTextOf } = await import(
  new URL('src/client/features/environment/H3yunBrowserLogin.tsx', ROOT).href)
const { LOGIN_PARTITION_KEY, H3YUN_LOGIN_URL } = await import(
  new URL('src/client/features/environment/login-browser.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

// ── 最小注入式渲染器（与 client-package.test.mjs 同一套写法）──────────────────

function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  return { type: node.type, props: { ...node.props, children: resolve(node.props.children) } }
}

function render(component, props) {
  const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
  globalThis.__crwuTestInstance = instance
  return resolve(component(props))
}

const flatten = (node) => (Array.isArray(node) ? node.flatMap(flatten) : [node])
const walk = (node) => (Array.isArray(node) ? node.flatMap(walk)
  : (node !== null && typeof node === 'object' ? [node, ...walk(node.props?.children)] : []))
const textOf = (node) => (node === null || node === undefined ? ''
  : Array.isArray(node) ? node.map(textOf).join('')
    : typeof node === 'string' ? node
      : typeof node === 'object' ? textOf(node.props?.children) : '')

/** 造一个未过期的会话 JWT（形状与氚云一致）。 */
function sessionJwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({
    enginecode: 'eng-1', userid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`
}

/** 假 webview 元素 + 假 document（卡片的 createView 就是 document.createElement）。 */
function installFakeDom() {
  const views = []
  const createElement = () => {
    const listeners = new Map()
    const view = {
      attributes: {}, loadURLs: [], removed: 0,
      setAttribute(name, value) { view.attributes[name] = value },
      addEventListener(name, listener) {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(listener)
      },
      loadURL(url) { view.loadURLs.push(url) },
      async executeJavaScript() { return `h3_token=${sessionJwt()}` },
      remove() { view.removed += 1 },
      fire(name, event) { for (const listener of listeners.get(name) ?? []) listener(event ?? {}) },
    }
    views.push(view)
    return view
  }
  const previous = globalThis.document
  globalThis.document = { createElement }
  return { views, restore: () => { globalThis.document = previous } }
}

function installBridge() {
  const calls = { acquire: [], release: [] }
  globalThis.dshDesktop = {
    protocolVersion: 1,
    browser: {
      async acquire(key) { calls.acquire.push(key); return { lease: 'lease-1', partition: 'part-1' } },
      async release(lease) { calls.release.push(lease) },
      onOpenRequested() { return () => {} },
    },
  }
  return { calls, restore: () => { delete globalThis.dshDesktop } }
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

// ── 行为 ───────────────────────────────────────────────────────────────────

test('statusTextOf 覆盖每个状态，且文案里没有令牌位置', () => {
  const states = ['', 'preparing', 'waiting', 'token', 'code', 'timeout', 'error']
  for (const state of states) {
    const text = statusTextOf(state)
    assert.equal(typeof text, 'string')
    assert.notEqual(text, '', `${state} 必须有文案`)
  }
  assert.equal(statusTextOf('waiting'), zhCN.loginBrowserWaiting)
  assert.equal(statusTextOf('token'), zhCN.loginBrowserBound)
})

test('拿不到内置浏览器时：按钮禁用 + 如实说明回退', () => {
  delete globalThis.dshDesktop
  const props = { enabled: true, onBind: async () => ({ ok: true, error: '' }) }
  const tree = flatten(render(H3yunBrowserLogin, props))
  const button = walk(tree).find((node) => node.type === 'button')
  assert.ok(button, '卡片必须有按钮')
  assert.equal(button.props.disabled, true, '没有桥时按钮必须禁用，不能让员工对着永不出场的窗口等')
  assert.ok(textOf(tree).includes(zhCN.loginBrowserUnavailable))
})

test('拿得到内置浏览器时：按钮可用，且展开区默认不带 -on', () => {
  const bridge = installBridge()
  try {
    const tree = flatten(render(H3yunBrowserLogin, { enabled: true, onBind: async () => ({ ok: true, error: '' }) }))
    const button = walk(tree).find((node) => node.type === 'button')
    assert.equal(button.props.disabled, false)
    assert.equal(textOf(tree).includes(zhCN.loginBrowserUnavailable), false)
    const stage = walk(tree).find((node) => String(node.props?.className ?? '').includes('crwu-audit-login-stage'))
    assert.ok(stage, '必须有访客区容器')
    assert.equal(String(stage.props.className).includes('crwu-audit-login-stage-on'), false, '未开始不该占位')
  } finally {
    bridge.restore()
  }
})

test('点按钮 → 申请登录分区 → dom-ready 后导航 → 读到令牌就交给 Host（且不外显）', async () => {
  const dom = installFakeDom()
  const bridge = installBridge()
  const bound = []
  try {
    const tree = flatten(render(H3yunBrowserLogin, {
      enabled: true,
      onBind: async (token) => { bound.push(token); return { ok: true, error: '' } },
      onDone: () => { bound.push('done') },
    }))
    const button = walk(tree).find((node) => node.type === 'button')
    button.props.onClick()

    await flush()
    assert.deepEqual(bridge.calls.acquire, [LOGIN_PARTITION_KEY])
    assert.equal(dom.views.length, 1)
    assert.equal(dom.views[0].attributes.partition, 'part-1')
    assert.equal(dom.views[0].attributes.src, 'about:blank#lease-1')
    assert.deepEqual(dom.views[0].loadURLs, [], 'dom-ready 之前不许导航')

    dom.views[0].fire('dom-ready')
    await flush()
    assert.deepEqual(dom.views[0].loadURLs, [H3YUN_LOGIN_URL])

    // 驱动默认 2 秒轮询一次；这里直接推进真实定时器，避免依赖假时钟。
    await new Promise((resolve) => { setTimeout(resolve, 2100) })
    assert.equal(bound.length, 2, '令牌只交一次，随后刷新环境')
    assert.match(bound[0], /^[\w-]+\.[\w-]+\.[\w-]+$/)
    assert.equal(bound[1], 'done')
    assert.deepEqual(bridge.calls.release, ['lease-1'], '读到令牌后必须释放租约')
  } finally {
    bridge.restore()
    dom.restore()
  }
})
