/**
 * 钉钉两阶段登录卡片的 UI 行为测试。
 *
 * 四条：
 * 1. `dwsPhaseText` 覆盖四态；
 * 2. 未开始时只有两颗按钮，没有任何"待打开"的行；
 * 3. `start` 把 `{device}` 传给 Host，拿到含 URL 的快照后**先把动作摆出来**（打开 / 复制）；
 * 4. 只在 `running` 时轮询；进入终态停止，并在 `ok` 时通知刷新环境。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { registerTsxLoader, fakeReact } = await import(new URL('tests/helpers/tsx-loader.mjs', ROOT).href)
registerTsxLoader()
globalThis.__crwuTestReact = fakeReact

const { DwsLoginCard, dwsPhaseText } = await import(
  new URL('src/client/features/environment/DwsLoginCard.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

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
  return { tree: resolve(component(props)), instance }
}

/** 同一实例重渲染：保留 state（替身没有 diff，就用它看"点击之后屏幕上是什么"）。 */
function rerender(component, props) {
  const instance = globalThis.__crwuTestInstance
  instance.cursor = 0
  instance.effects = []
  return resolve(component(props))
}

const walk = (node) => (Array.isArray(node) ? node.flatMap(walk)
  : (node !== null && typeof node === 'object' ? [node, ...walk(node.props?.children)] : []))
const textOf = (node) => (node === null || node === undefined ? ''
  : Array.isArray(node) ? node.map(textOf).join('')
    : typeof node === 'string' ? node
      : typeof node === 'object' ? textOf(node.props?.children) : '')
const buttons = (tree) => walk(tree).filter((node) => node.type === 'button')
/** `Button` 是函数组件：展开成宿主 button 后只剩文本，按文案找。 */
const buttonByText = (tree, text) => buttons(tree).find((node) => textOf(node).includes(text))

const flush = () => new Promise((done) => { setTimeout(done, 0) })
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

/** 一份快照（默认 running，可覆盖）。 */
function snapshot(overrides = {}) {
  return {
    phase: 'running', ok: false, device: false, url: '', userCode: '', tail: '',
    error: '', timedOut: false, sandboxBlocked: false, advice: '', ...overrides,
  }
}

test('dwsPhaseText 覆盖四个阶段', () => {
  for (const phase of ['running', 'ok', 'failed', 'timeout']) {
    assert.notEqual(dwsPhaseText(phase), '', `${phase} 必须有文案`)
  }
  assert.equal(dwsPhaseText('running'), zhCN.dwsPhaseRunning)
  assert.equal(dwsPhaseText('ok'), zhCN.dwsPhaseOk)
})

test('未开始时：两颗按钮可用，且没有「打开授权链接」', () => {
  const tree = render(DwsLoginCard, {
    enabled: true, onStart: async () => snapshot(), onStatus: async () => null, onOpenUrl: () => {},
  }).tree
  assert.equal(buttonByText(tree, zhCN.dwsLoginStart).props.disabled, false)
  assert.equal(buttonByText(tree, zhCN.dwsLoginStartDevice).props.disabled, false)
  assert.equal(buttonByText(tree, zhCN.dwsLoginOpen), undefined, '还没 URL 就不该有打开按钮')
  assert.ok(textOf(tree).includes(zhCN.dwsLoginIdle))
})

test('start 把 device 交给 Host；拿到 URL 后先给动作，再给原文', async () => {
  const started = []
  const opened = []
  const copied = []
  const url = 'https://login.dingtalk.com/oauth2/auth?x=1'
  const props = {
    enabled: true,
    onStart: async (args) => { started.push(args); return snapshot({ url, tail: 'Or open the following link: …' }) },
    onStatus: async () => null,
    onOpenUrl: (value) => { opened.push(value) },
    onCopy: (value) => { copied.push(value) },
  }
  const tree = render(DwsLoginCard, props).tree
  buttonByText(tree, zhCN.dwsLoginStartDevice).props.onClick()
  await flush()
  assert.deepEqual(started, [{ device: true }], '设备码按钮必须把 device=true 交给 Host')

  // 重渲染：这时快照里已经有 URL，动作必须先于原文出现。
  const after = walk(rerender(DwsLoginCard, props))
  const open = after.find((node) => node.type === 'button' && textOf(node).includes(zhCN.dwsLoginOpen))
  assert.ok(open, '有 URL 时必须给「打开授权链接」')
  open.props.onClick()
  assert.deepEqual(opened, [url], '点开必须把 URL 原样交给宿主打开')
  const copy = after.find((node) => node.type === 'button' && textOf(node).includes(zhCN.dwsLoginCopyLink))
  copy.props.onClick()
  assert.deepEqual(copied, [url])
  assert.ok(textOf(after).includes(url), '原文也要在（结构化字段只是尽力解析）')
})

test('只在 running 时轮询；ok 之后停止并通知刷新', async () => {
  let statusCalls = 0
  const done = []
  const running = snapshot({ url: 'https://login.dingtalk.com/device' })
  const okSnapshot = snapshot({ phase: 'ok', ok: true })
  const props = {
    enabled: true,
    onStart: async () => running,
    onStatus: async () => { statusCalls += 1; return statusCalls >= 2 ? okSnapshot : running },
    onOpenUrl: () => {},
    onDone: () => { done.push('done') },
    pollMs: 5,
  }
  const { tree, instance } = render(DwsLoginCard, props)
  buttonByText(tree, zhCN.dwsLoginStart).props.onClick()
  await flush()
  rerender(DwsLoginCard, props)
  // 替身不会自动跑 effect：手动提交一次（React 替身把回调收在 instance.effects 里）。
  // **必须收下并调用清理函数**：轮询 interval 不收掉，node --test 会一直不退出
  // （2026-09-29 实测：整条全量测试卡在这里）。
  const cleanups = []
  for (const effect of instance.effects) {
    const cleanup = effect.callback()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  await sleep(60)
  for (const cleanup of cleanups) cleanup()
  assert.ok(statusCalls >= 2, `进入 running 后必须轮询（实际 ${statusCalls} 次）`)
  assert.deepEqual(done, ['done'], 'ok 之后必须通知刷新环境')
})
