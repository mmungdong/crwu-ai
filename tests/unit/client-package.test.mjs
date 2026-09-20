/**
 * 包形态 **Client 半** 的直接测试。
 *
 * 这是长期维护的那一半，所以必须有能独立失败的测试，而不是只靠别的形态间接
 * 覆盖。做法：用 `tests/helpers/tsx-loader.mjs` 让 Node 能加载 `.tsx`，再用一个极小的 React
 * 替身渲染树 —— 打的是 `src/` 的源码。
 *
 * 覆盖：同源 RPC 客户端（fetch 契约与错误处理）、槽位注册（名称/键/顺序/清理）、面板在
 * 未加载 / 已加载 / 失败 / 卸载后迟到响应四种状态下的行为、以及主题 token 与文案的稳定键。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { fakeReact, registerTsxLoader } from '../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)

const { WORKBENCH_ROUTE } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { WORKBENCH_CLASSES, WORKBENCH_STYLE_ID, WORKBENCH_STYLE_TEXT } = await import(
  new URL('src/client/features/workbench/consts.ts', ROOT).href
)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { installWorkbenchStyles } = await import(new URL('src/client/features/workbench/styles.ts', ROOT).href)

const React = fakeReact

/** 渲染一个函数组件，返回元素树与它的 hook 状态；实例留在 global 上供 rerender 使用。 */
function render(component, props = {}) {
  const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
  globalThis.__crwuTestInstance = instance
  return { tree: resolve(component(props)), instance }
}

/**
 * 展开一个**已存在**的组件实例，模拟重渲染：保留 state、重置 hook 游标、不重跑 effect。
 *
 * 为什么需要它：本仓不引入 react-dom（不需要 diff 算法），但要断言「effect 跑完、state 写入
 * 之后屏幕上是什么」，就必须能对同一实例重渲染一次。
 */
function rerender(component, props = {}) {
  const instance = globalThis.__crwuTestInstance
  assert.ok(instance, 'rerender 必须在 render() 之后使用')
  instance.cursor = 0
  instance.effects = []
  return resolve(component(props))
}

/** 展开函数组件，保留宿主元素形状。 */
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
    globalThis.__crwuTestInstance = instance
    try {
      return resolve(node.type(node.props))
    } finally {
      globalThis.__crwuTestInstance = saved
    }
  }
  return { type: node.type, props: { ...node.props, children: resolve(node.props.children) } }
}

const { rpc } = await import(new URL('src/client/api/client.ts', ROOT).href)
const { apply } = await import(new URL('src/client/apply.ts', ROOT).href)
const { WorkbenchPanel } = await import(new URL('src/client/features/workbench/WorkbenchPanel.tsx', ROOT).href)
const { PanelIcon } = await import(new URL('src/client/components/PanelIcon.tsx', ROOT).href)

/** 深度查找第一个满足条件的宿主元素。 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.props.children, predicate)
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props.children)
}

/**
 * 取一条 `Kv` 行的**值**文本（`Kv` 展开成相邻的 `kvKey` / `kvValue` 两个 div）。
 *
 * 为什么不直接对整页 `textOf(...).includes(x)`：同一个值常常在别处也出现
 * （① 的案例根目录与 ⑧ 的审核根工作空间就是同一个路径），整页断言会被它满足 ——
 * 这正是 AGENTS.md §6 点名的「文本包含式断言」假通过，实测漏过一次。
 */
function rowValueOf(node, label) {
  if (Array.isArray(node)) {
    for (let i = 1; i < node.length; i += 1) {
      const value = node[i]
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && value.props?.className === WORKBENCH_CLASSES.kvValue
        && textOf(node[i - 1]) === label) return textOf(value)
    }
    for (const child of node) {
      const hit = rowValueOf(child, label)
      if (hit !== null) return hit
    }
    return null
  }
  if (node !== null && typeof node === 'object') return rowValueOf(node.props.children, label)
  return null
}

/** 记录 fetch 调用并按队列回放响应。 */
function stubFetch(responses) {
  const calls = []
  const queue = [...responses]
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch 调用次数超出预期')
    if (next instanceof Error) throw next
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async json() { return next.body },
    }
  }
  return calls
}

/** 冲刷微任务队列，让 .then/.catch 跑完。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

// ── RPC 客户端 ──────────────────────────────────────────────────────────────

test('rpc posts the operation to the same-origin route', async () => {
  const calls = stubFetch([{ status: 200, body: { ok: true } }])
  const result = await rpc('boot', { a: 1 })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, WORKBENCH_ROUTE)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { op: 'boot', args: { a: 1 } })
})

test('rpc defaults args to an empty object so the Host never sees undefined', async () => {
  const calls = stubFetch([{ status: 200, body: { ok: true } }])
  await rpc('ping')
  assert.deepEqual(JSON.parse(calls[0].init.body), { op: 'ping', args: {} })
})

test('rpc surfaces the HTTP status instead of resolving a broken body', async () => {
  stubFetch([{ status: 500, body: { ok: false } }])
  await assert.rejects(rpc('boot'), /HTTP 500/)
})

test('rpc propagates a network failure to the caller', async () => {
  stubFetch([new Error('network down')])
  await assert.rejects(rpc('boot'), /network down/)
})

// ── 槽位注册 ────────────────────────────────────────────────────────────────

/**
 * 最小的 Client 上下文替身：记录 effect、slots.inject 与 register。
 *
 * 特意记录「inject 是在 effect 内部还是外部调用的」：DSH 自带的客户端插件都在 effect **外面**
 * 直接调 `slots.inject`（槽位寿命由 slots 服务自己管），而 `effect` 对回调返回值有类型要求 ——
 * 包错了会让 `apply()` 在激活阶段抛 `Invalid effect`，表现为「装上了但面板不出现」。
 */
function fakeClientContext() {
  const effects = []
  const injections = []
  const registrations = []
  const disposed = []
  let depth = 0
  const ctx = {
    // 真实 Client 上下文一定有 get：插件用它读可选服务（这里读 layout 以便跳转面板）。
    get: (name) => (name === 'layout' ? { selectPanel() {} } : undefined),
    effect(callback, label) {
      depth += 1
      let disposer
      try {
        disposer = callback()
      } finally {
        depth -= 1
      }
      effects.push({ label, disposer })
      return () => {
        disposed.push(label)
        if (typeof disposer === 'function') disposer()
      }
    },
    slots: {
      inject(name, callback) {
        injections.push({ name, insideEffect: depth > 0 })
        return callback()
      },
      register(meta, component) {
        registrations.push({ meta, component })
        // 真实实现返回解除注册的函数（对照 DSH web bundle 里 register 的实现）。
        return () => registrations.splice(registrations.indexOf(meta), 1)
      },
    },
  }
  return { ctx, effects, injections, registrations, disposed }
}

test('apply registers every slot through slots.inject', () => {
  installDoc()
  const { ctx, effects, injections, registrations } = fakeClientContext()
  apply(ctx)

  // 只有样式走 effect；槽位注入直接调用（与 DSH 自带的客户端插件一致）。
  assert.equal(effects.length, 1)
  assert.deepEqual(injections.map((entry) => entry.name), [
    'sidebar.panellist', 'main', 'tool.view.cordis', 'conversation.session.header.utilities',
  ], '四个槽位缺一不可：少了会话头那个，界面上就没有办法登记审核父级')
  for (const entry of injections) {
    assert.equal(entry.insideEffect, false, 'slots.inject 不得包在 ctx.effect 里')
  }
  // 会话头那个 list 槽位挂了**两个**条目（环境指示灯 + 子会话父级），所以注册数比注入数多一个。
  assert.deepEqual(registrations.map((entry) => entry.meta.name), [
    'sidebar.panellist', 'main', 'tool.view.cordis',
    'conversation.session.header.utilities', 'conversation.session.header.utilities',
  ])
  assert.equal(registrations[0].meta.id, 'crwu-workbench')
  assert.equal(registrations[0].meta.label, zhCN.sidebarLabel)
  assert.equal(typeof registrations[0].meta.order, 'number')
  assert.equal(registrations[1].meta.key, 'crwu-workbench')
  // 环境指示灯必须在最右边（order 比子会话父级大）：它是「环境行不行」唯一常驻的可见结论。
  assert.equal(registrations[3].meta.id, 'crwu-env-status')
  assert.equal(registrations[3].meta.order, 6)
  assert.equal(registrations[3].meta.label, zhCN.envLampLabel)
  assert.equal(registrations[4].meta.id, 'crwu-audit-parent')
  assert.equal(registrations[4].meta.order, 5)
  for (const entry of registrations) assert.equal(typeof entry.component, 'function')
})

test('every effect callback returns a callable or nothing (Cordis rejects the rest)', () => {
  // Cordis 的 effect：函数会被收集成 disposer，null/undefined 放过，
  // 其余非空、非 thenable、非可迭代的值抛 TypeError("Invalid effect")。
  installDoc()
  const { ctx, effects } = fakeClientContext()
  apply(ctx)
  assert.ok(effects.length > 0)
  for (const { label, disposer } of effects) {
    assert.ok(
      disposer === undefined || disposer === null || typeof disposer === 'function',
      `effect「${label}」的返回值是 ${typeof disposer}，Cordis 会拒绝`,
    )
  }
})

test('the sidebar component renders the DSH panel icon with the slot props', () => {
  installDoc()
  const { ctx, registrations } = fakeClientContext()
  apply(ctx)
  const tree = resolve(registrations[0].component({ size: 20, active: true }))
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 20)
  assert.equal(tree.props.stroke, 'var(--dsw-alias-brand-primary)')
})

test('PanelIcon falls back to an inactive 16px icon', () => {
  const tree = resolve(PanelIcon({}))
  assert.equal(tree.props.width, 16)
  assert.equal(tree.props.stroke, 'var(--dsw-alias-label-secondary)')
})

// ── 主题样式 ────────────────────────────────────────────────────────────────

function fakeDocument(existing = null) {
  const removed = []
  const head = { appended: [], appendChild(element) { this.appended.push(element) } }
  return {
    document: {
      getElementById: () => existing,
      createElement: () => ({ id: '', dataset: {}, textContent: '', remove() { removed.push(this) } }),
      head,
    },
    head,
    removed,
  }
}

/** apply() 会安装样式，所以任何调用它的测试都要先有一个 document。 */
function installDoc() {
  globalThis.document = fakeDocument().document
}

test('installWorkbenchStyles installs one tagged style element and removes it on dispose', () => {
  const fake = fakeDocument()
  globalThis.document = fake.document
  const dispose = installWorkbenchStyles()
  assert.equal(fake.head.appended.length, 1)
  const element = fake.head.appended[0]
  assert.equal(element.id, WORKBENCH_STYLE_ID)
  assert.equal(element.dataset.plugin, 'dsh-crwu-workbench')
  assert.equal(element.textContent, WORKBENCH_STYLE_TEXT)
  dispose()
  assert.equal(fake.removed.length, 1)
})

test('installWorkbenchStyles is idempotent when the style is already installed', () => {
  const fake = fakeDocument({ id: WORKBENCH_STYLE_ID })
  globalThis.document = fake.document
  const dispose = installWorkbenchStyles()
  assert.equal(fake.head.appended.length, 0, '重复安装会插出第二份样式')
  assert.equal(typeof dispose, 'function')
})

test('the stylesheet uses DSH theme tokens and no hard-coded colors', () => {
  for (const match of WORKBENCH_STYLE_TEXT.matchAll(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/g)) {
    assert.fail(`样式里出现硬编码颜色 ${match[0]}，应使用 DSH 语义颜色变量`)
  }
  assert.match(WORKBENCH_STYLE_TEXT, /--dsw-/)
  for (const className of Object.values(WORKBENCH_CLASSES)) {
    assert.ok(WORKBENCH_STYLE_TEXT.includes(`.${className}`), `样式里缺少 .${className}`)
  }
})

// ── 面板外壳（挂载 → 自检 → 失败/卸载）────────────────────────────────────────

/**
 * 一个按 op 回放的 fetch 替身。
 *
 * `handlers[op]` 可以是**应答描述对象**（`{ body, status }`），也可以是**函数**（拿到 payload 再决定）。
 * 两种都支持：多数用例只关心 body，少数要按参数分支。
 */
function stubOps(handlers) {
  const ops = []
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    ops.push(payload.op)
    const entry = handlers[payload.op]
    if (entry === undefined) return { ok: true, status: 200, async json() { return { ok: true } } }
    const out = typeof entry === 'function' ? entry(payload) : entry
    if (out instanceof Error) throw out
    return {
      ok: out.status === undefined || out.status < 400,
      status: out.status ?? 200,
      async json() { return out.body ?? { ok: true } },
    }
  }
  return ops
}

/** 浏览器侧可选服务替身；不给就是「服务不可用」的降级路径。 */
function fakeServices(patch = {}) {
  return { uiWorkspace: undefined, workspaces: undefined, layout: undefined, sessions: undefined, ...patch }
}

/** 一次完整挂载：跑挂载 effect → 冲刷微任务 → 重渲染。 */
async function mount(services = fakeServices()) {
  const rendered = render(WorkbenchPanel, { services })
  for (const effect of rendered.instance.effects) await effect.callback()
  await settle()
  return { tree: rerender(WorkbenchPanel, { services }), instance: rendered.instance }
}

test('before the Host answers the shell shows the top-right lamp and the self-check loading copy', () => {
  // 环境自检的入口是右上角那颗指示灯（不是页内标签页），所以标题必须一直在，
  // 而「待审核报告」在自检出结论之前不该出现 —— 没通过就不能进报告审核。
  stubOps({})
  const { tree } = render(WorkbenchPanel, { services: fakeServices() })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.title), true)
  assert.equal(text.includes(zhCN.tabEnv), true, '右上角要有环境自检入口')
  assert.equal(text.includes(zhCN.tabPending), false, '自检没出结论前不给进报告审核')
  assert.equal(text.includes(zhCN.tabResults), false)
})

test('before the environment answers the shell shows the self-check loading copy', () => {
  // 首次加载时 busy 还没翻成 true，所以「没有数据 + 没有错误」必须显示加载中，
  // 否则会先闪一个空面板。
  stubOps({})
  const { tree } = render(WorkbenchPanel, { services: fakeServices() })
  assert.equal(textOf(tree).includes(zhCN.loadingEnv), true)
})

test('after boot and env the shell renders the self-check result', async () => {
  stubOps({
    boot: { body: { ok: true, parentSessionId: '', workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false }, active: { key: '', childId: '', since: 0 }, ported: { done: [], todo: [] } } },
    env: {
      body: {
        ok: true, manifestSource: 'https://x.invalid/m.json', manifestKind: 'url', manifestLoaded: true, manifestError: '',
        manifestUpdatedAt: '', installDocUrl: '', platform: 'darwin-arm64',
        checks: [{ name: 'node', command: 'node', required: true, note: '', found: true, path: '/usr/bin/node', versionText: 'v22.19.0', actual: '22.19.0', expect: '>=16.7', ok: true, reason: '', url: '', sha256: '', target: '' }],
        ifindKey: { path: '/Users/x/cfg.json', required: true, ok: true, reason: '', tokenLength: 12 },
        services: [{ id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId u1' }],
        blocked: [], allOk: true, home: '/Users/x', trust: { h3yun: false },
        workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
        sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
        oss: { bucket: '', prefix: 'crwu/audit', linkMode: 'signed', autoUpload: true, ossutilReady: false },
        ossCred: { path: '/Users/x/.ossutilconfig', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
      },
    },
  })
  const { tree } = await mount()
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.loadingEnv), false, '拿到数据后不该还显示加载中')
  assert.equal(text.includes(zhCN.allOk), true, '环境就绪要有明确结论')
  assert.equal(text.includes('https://x.invalid/m.json'), true, '清单来源必须显示：它决定下面各项的判据')
  assert.equal(text.includes('/usr/bin/node'), true, '每项都要显示实际路径')
})

test('a blocked environment lists exactly what is missing', async () => {
  stubOps({
    boot: { body: { ok: true } },
    env: {
      body: {
        ok: true, manifestSource: '', manifestKind: 'builtin', manifestLoaded: false, manifestError: '未配置清单地址',
        manifestUpdatedAt: '', installDocUrl: '', platform: '', checks: [],
        ifindKey: { path: '/cfg', required: true, ok: false, reason: 'auth_token 为空', tokenLength: 0 },
        services: [], blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择', '运行平台未识别'],
        allOk: false, home: '/Users/x', trust: { h3yun: false },
        workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
        sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
        oss: { bucket: '', prefix: '', linkMode: 'signed', autoUpload: true, ossutilReady: false },
        ossCred: { path: '/Users/x/.ossutilconfig', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
      },
    },
  })
  const { tree } = await mount()
  const text = textOf(tree)
  assert.equal(text.includes('未找到工作空间「中瑞世联工作空间」，请手动选择'), true)
  assert.equal(text.includes('运行平台未识别'), true)
  assert.equal(text.includes(zhCN.allOk), false, '有 blocked 就不能显示「环境就绪」')
})

test('a failing env call surfaces the reason instead of an empty panel', async () => {
  stubOps({ boot: { body: { ok: true } }, env: { status: 503 } })
  const { tree } = await mount()
  assert.match(textOf(tree), /HTTP 503/)
})

test('the self-check never shows the iFinD token itself, only its length', async () => {
  stubOps({
    boot: { body: { ok: true } },
    env: {
      body: {
        ok: true, manifestSource: '', manifestKind: 'builtin', manifestLoaded: true, manifestError: '', manifestUpdatedAt: '',
        installDocUrl: '', platform: 'darwin-arm64', checks: [],
        ifindKey: { path: '/cfg.json', required: true, ok: true, reason: '', tokenLength: 12 },
        services: [], blocked: [], allOk: true, home: '/Users/x', trust: { h3yun: false },
        workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
        sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
        oss: { bucket: '', prefix: '', linkMode: 'signed', autoUpload: true, ossutilReady: false },
        ossCred: { path: '/cfg', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
      },
    },
  })
  const { tree } = await mount()
  const text = textOf(tree)
  assert.equal(text.includes('长度 12'), true)
  assert.equal(text.includes('your ifind-mcp key'), false)
})

test('an unmounted self-check never writes late state', async () => {
  let release
  globalThis.fetch = () => new Promise((resolve) => { release = resolve })
  const { instance } = render(WorkbenchPanel, { services: fakeServices() })
  const cleanups = instance.effects.map((effect) => effect.callback())
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  release({ ok: true, status: 200, async json() { return { ok: true } } })
  await settle()
  // 不按下标断言：hook 顺序会随实现变化（加一个 useState 就会移位）。
  // 这里断言「没有任何 state 槽位被迟到的应答写入」。
  const written = Object.values(instance.state).some(
    (value) => value !== null && typeof value === 'object' && value.ok === true,
  )
  assert.equal(written, false, '卸载后 env 不得被迟到响应写入')
})

test('the panel reads copy through the locale table, not inline strings', async () => {
  const source = await readFile(new URL('src/client/features/workbench/WorkbenchPanel.tsx', ROOT), 'utf8')
  // 只检查 JSX 文本节点（`>中文<`）与属性里的中文字符串，注释与类型参数不算。
  const inline = [...source.matchAll(/>\s*([^<>{}\n]*[\u4e00-\u9fff][^<>{}\n]*?)\s*</g)].map((m) => m[1])
  assert.deepEqual(inline, [], `面板里的中文文案必须走 locales，不能内联：${inline.join(' / ')}`)
  assert.match(source, /zhCN\./)
})

// ── 会话头「子会话父级」按钮 ────────────────────────────────────────────────
//
// 这是唯一能把当前会话 id 交给插件的入口，而 audit-start 要求父级已登记 ——
// 少了它，包形态的界面上没有任何办法开始一次审核。

test('the session-header button binds the session automatically on mount', async () => {
  const ops = stubOps({ 'bind-session': { body: { ok: true, parentSessionId: 'sess-1' } } })
  const { AuditParentButton } = await import(new URL('src/client/features/workbench/AuditParentButton.tsx', ROOT).href)
  const { instance } = render(AuditParentButton, { sessionId: 'sess-1' })
  for (const effect of instance.effects) await effect.callback()
  await settle()
  assert.deepEqual(ops, ['bind-session'], '挂载即登记，用户不必先找到按钮再点')
  const tree = rerender(AuditParentButton, { sessionId: 'sess-1' })
  assert.equal(textOf(tree).includes(zhCN.bound), true, '登记成功后显示已登记')
})

test('the session-header button reports a rejected parent instead of pretending success', async () => {
  stubOps({ 'bind-session': { body: { ok: false, subagent: true, error: '本身是子代理' } } })
  const { AuditParentButton } = await import(new URL('src/client/features/workbench/AuditParentButton.tsx', ROOT).href)
  const { instance } = render(AuditParentButton, { sessionId: 'sub-1' })
  for (const effect of instance.effects) await effect.callback()
  await settle()
  const tree = rerender(AuditParentButton, { sessionId: 'sub-1' })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.bindSubagent), true, '子代理被拒时必须显示原因，而不是装作登记好了')
  assert.equal(text.includes('本身是子代理'), true)
})

test('the session-header button renders nothing without a session id', async () => {
  const ops = stubOps({})
  const { AuditParentButton } = await import(new URL('src/client/features/workbench/AuditParentButton.tsx', ROOT).href)
  const { tree } = render(AuditParentButton, {})
  assert.equal(tree, null, '没有会话 id 就什么都不渲染（槽位可能不带 sessionId）')
  assert.deepEqual(ops, [], '也不该发出任何请求')
})

test('the run-card action also binds and offers a jump into the panel', async () => {
  const ops = stubOps({ 'bind-session': { body: { ok: true } } })
  const { RunCardAction } = await import(new URL('src/client/features/workbench/RunCardAction.tsx', ROOT).href)
  let selected = ''
  const { instance } = render(RunCardAction, { sessionId: 'sess-9', selectPanel: (name) => { selected = name } })
  for (const effect of instance.effects) await effect.callback()
  await settle()
  assert.deepEqual(ops, ['bind-session'], '运行卡片也顺带登记，看到卡片就等于登记好了')
  const tree = rerender(RunCardAction, { sessionId: 'sess-9', selectPanel: (name) => { selected = name } })
  assert.equal(textOf(tree).includes(zhCN.runCardSummary), true)
  const button = findButtonLike(tree, zhCN.openWorkbench)
  assert.ok(button, '要有跳转面板的入口')
  button.props.onClick()
  assert.equal(selected, 'crwu-workbench')
})

/** 按标签找一个按钮节点。 */
function findButtonLike(node, label) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButtonLike(child, label)
      if (hit) return hit
    }
    return null
  }
  if (node.type === 'button' && textOf(node) === label) return node
  return findButtonLike(node.props?.children, label)
}

// ── ① 工作空间卡片（案例根目录是发起审核的前置条件）──────────────────────────
//
// audit-start 硬性要求已选定工作空间。所以「清单偏好没命中」的部署必须有办法手动选，
// 否则这个插件在那种部署下完全用不了。

test('workspaceStatus reads only the chosen workspace: label, buttons, and the missing case', async () => {
  const { workspaceStatus } = await import(new URL('src/client/features/workbench/workspace-view.ts', ROOT).href)
  const chosen = { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manifest-workspace', missing: false }

  const ok = workspaceStatus(chosen)
  assert.equal(ok.chosen, true)
  assert.equal(ok.sourceLabel, zhCN.wsSourceManifest)
  assert.equal(ok.canAuto, false, '清单指定的不显示「恢复自动识别」')
  assert.equal('mismatch' in ok, false, '这里**不许**再有任何「当前会话」相关的判定（用户报过：换会话卡片就变）')

  const manual = workspaceStatus({ ...chosen, source: 'manual' })
  assert.equal(manual.canAuto, true, '手动选过的才给「恢复自动识别」')
  assert.equal(manual.sourceLabel, zhCN.wsSourceManual)

  const none = workspaceStatus({ chosen: false, path: '', title: '', id: '', source: '', missing: false })
  assert.equal(none.chosen, false)
  assert.equal(none.sourceLabel, '')

  // 选过的目录没了：既不算已选定，也得留「恢复自动识别」这条出口。
  const gone = workspaceStatus({ chosen: false, path: '/cases/gone', title: '', id: '', source: 'manual', missing: true })
  assert.equal(gone.missing, true)
  assert.equal(gone.chosen, false)
  assert.equal(gone.path, '/cases/gone', '路径要留着，界面才能说清是哪一个没了')
  assert.equal(gone.canAuto, true)
})

test('a stale host build is called out and blocks starting audits', async () => {
  // 客户端随页面刷新就换新，宿主只有重启 profile 才换。不同代时必须**明说 + 停发起审核**：
  // 否则界面是新的、逻辑是旧的（审核会按老规则挂到「当前会话」下），用户只会看到「还是挂错位置」。
  stubOps({
    boot: { body: { ok: true, protocol: 1, parentSessionId: '' } },
    env: { body: okEnvBody() },
    pending: { body: { ok: true, error: '', rows: [PENDING_TASK], formName: '报告审核', page: 1, size: 20, total: 1, query: '', filterMode: '', escalated: false, escalateAvailable: false } },
    'audit-status': { body: { ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 } } },
    'oss-index': { body: { ok: true, error: '', bucket: 'b', prefix: '', count: 0, items: {}, truncated: false } },
  })
  const services = fakeServices()
  const noTimer = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  try {
    const rendered = render(WorkbenchPanel, { services })
    await flushEffects(rendered.instance)
    rerender(WorkbenchPanel, { services })
    await flushEffects(rendered.instance)
    rerender(WorkbenchPanel, { services })
    await flushEffects(rendered.instance)
    const tree = rerender(WorkbenchPanel, { services })
    const text = textOf(tree)
    assert.equal(text.includes(zhCN.hostStaleTitle), true, '要明确说宿主是旧构建')
    assert.equal(text.includes(zhCN.hostStaleGate), true, '行内门禁也要说清原因，而不是「需先通过钉钉认证」')
    const start = findButtonLike(tree, 'AI 审核')
    assert.ok(start, '按钮还在（只是禁用）')
    assert.equal(start.props.disabled, true, '旧宿主下不许发起审核')
  } finally {
    globalThis.setInterval = noTimer.setInterval
    globalThis.clearInterval = noTimer.clearInterval
  }
})

test('the pending table surfaces the risk level and stops duplicating the seqNo', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  // 真实数据里 name 常常就等于 seqNo（本机抽样：50/50），重复显示既没用又占宽度。
  const task = { ...PENDING_TASK, risk: 'A', project: '某某资产评估项目', name: PENDING_TASK.seqNo }
  const { tree } = render(ReportPane, reportPaneProps({ state: { tasks: [task], total: 1 } }))
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.colRisk), true, '要有「风险等级」列')
  assert.equal(text.includes('A'), true, '风险等级要透出来')
  assert.equal(text.includes('某某资产评估项目'), true, '主行给项目名')
  // name === seqNo 时不该出现两次流水号（一次在名称列、一次在流水号列）。
  const occurrences = text.split(PENDING_TASK.seqNo).length - 1
  assert.equal(occurrences, 1, `流水号只该出现一次，实际 ${occurrences} 次`)
})

test('the workspace card asks the user to pick when nothing is chosen', async () => {
  stubOps({})
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const services = fakeServices({
    uiWorkspace: { pickDirectory: async () => null },
    workspaces: { create: async () => ({}) },
  })
  const { tree } = render(WorkspaceCard, {
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    services,
    busy: false,
    message: '',
    onBusy: () => {},
    onMessage: () => {},
    onRefresh: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.wsMissing), true, '未选定时要明说没找到，并给选择入口')
  assert.equal(text.includes(zhCN.wsPick), true)
  assert.equal(text.includes(zhCN.wsCreate), true)
})

test('picking a directory registers it as a workspace and tells the Host', async () => {
  const ops = stubOps({ workspace: { body: { ok: true, workspace: { chosen: true, path: '/cases/new' } } } })
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const created = []
  let refreshed = 0
  const messages = []
  const services = fakeServices({
    uiWorkspace: { pickDirectory: async () => '/cases/new', openWorkspace: async () => undefined },
    workspaces: { create: async ({ path }) => { created.push(path); return { workspaceId: 'w9', path, title: 'new' } } },
  })
  const { tree, instance } = render(WorkspaceCard, {
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    services,
    busy: false,
    message: '',
    onBusy: () => {},
    onMessage: (m) => messages.push(m),
    onRefresh: () => { refreshed += 1 },
  })
  const pickButton = findButtonLike(tree, zhCN.wsPick)
  assert.ok(pickButton, '要有「选择目录作为工作空间」按钮')
  pickButton.props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  assert.deepEqual(created, ['/cases/new'], '选到的目录要注册成工作空间')
  assert.deepEqual(ops, ['workspace'], '还要通知 Host 记下来（Host 负责落盘）')
  assert.equal(refreshed >= 1, true, '选定后要刷新自检页')
  assert.equal(messages.some((m) => m.includes('/cases/new')), true)
  void instance
})

test('the workspace card degrades instead of throwing when the services are missing', async () => {
  const ops = stubOps({})
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const messages = []
  const { tree } = render(WorkspaceCard, {
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    services: fakeServices(),
    busy: false,
    message: '',
    onBusy: () => {},
    onMessage: (m) => messages.push(m),
    onRefresh: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.wsServiceUnavailable), true, '缺服务要明说，而不是抛错')
  const pickButton = findButtonLike(tree, zhCN.wsPick)
  assert.equal(pickButton.props.disabled, true, '服务不可用时按钮应禁用')
  assert.deepEqual(ops, [], '也不该发出请求')
})

test('the workspace card does not react to which session you came from', async () => {
  // 用户的报障：从别的工作空间的会话点进面板，① 就说「你的工作空间不对」；每换一个会话就变一次。
  // 根因是卡片比对「当前登记的父会话 cwd」并弹提醒。审核锚在插件选定的案例根目录上，
  // 卡片**不该有任何会话输入** —— 这条断言就是钉住「那段提醒不许回来」。
  stubOps({})
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const { tree } = render(WorkspaceCard, {
    workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manifest-workspace', missing: false },
    services: fakeServices({ uiWorkspace: { openWorkspace: async () => undefined } }),
    busy: false, message: '', onBusy: () => {}, onMessage: () => {}, onRefresh: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes('/cases/a'), true, '选定后要显示案例根目录')
  assert.equal(text.includes('不是同一个'), false, '① 不再拿当前会话说事')
  assert.equal(text.includes('的会话中打开工作台'), false, '那个「在 X 的会话中打开」按钮也一起删掉了')
  assert.equal(text.includes(zhCN.wsChange), true, '「更换工作空间」仍在')
})

test('the workspace card names the missing directory instead of quietly switching', async () => {
  stubOps({})
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const { tree } = render(WorkspaceCard, {
    workspace: { chosen: false, path: '/cases/gone', title: '', id: '', source: 'manual', missing: true },
    services: fakeServices({
      uiWorkspace: { pickDirectory: async () => null },
      workspaces: { create: async () => ({}) },
    }),
    busy: false, message: '', onBusy: () => {}, onMessage: () => {}, onRefresh: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.wsMissingDir), true, '要说清是哪一个目录没了')
  assert.equal(text.includes('/cases/gone'), true)
  assert.equal(text.includes(zhCN.wsMissing), false, '这不是「没找到清单指定的工作空间」，别混用文案')
  assert.equal(text.includes(zhCN.wsAuto), true, '要留「恢复自动识别」这条出口')
})

test('the workspace card offers 恢复自动识别 only after a manual choice', async () => {
  stubOps({})
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const base = {
    services: fakeServices({ uiWorkspace: { openWorkspace: async () => undefined } }),
    busy: false, message: '', onBusy: () => {}, onMessage: () => {}, onRefresh: () => {},
  }
  const manual = render(WorkspaceCard, { ...base, workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manual', missing: false } })
  assert.equal(textOf(manual.tree).includes(zhCN.wsAuto), true)
  const manifest = render(WorkspaceCard, { ...base, workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manifest-workspace', missing: false } })
  assert.equal(textOf(manifest.tree).includes(zhCN.wsAuto), false)
})

// ── ⑥ OSS 授权表单（Host 有实现但一直没有入口 = 等于不存在）──────────────────

test('the AK form refuses an incomplete credential pair before calling the Host', async () => {
  const ops = stubOps({})
  const { OssAuthCard } = await import(new URL('src/client/features/environment/OssAuthCard.tsx', ROOT).href)
  const { tree } = render(OssAuthCard, { cred: null, defaultEndpoint: '', onRefresh: () => {} })
  const saveButton = findButtonLike(tree, zhCN.ossCredSave)
  assert.ok(saveButton, '要有「保存并实测」按钮')
  saveButton.props.onClick()
  for (let i = 0; i < 4; i += 1) await settle()
  assert.deepEqual(ops, [], '两个字段都空时不该发请求')
})

test('the AK form posts the credential and never keeps the secret in state', async () => {
  const posts = []
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    posts.push(payload)
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, path: '/Users/x/.ossutilconfig', chmodOk: true, probe: { ok: true, state: 'AK 正常' } }
      },
    }
  }
  const { OssAuthCard } = await import(new URL('src/client/features/environment/OssAuthCard.tsx', ROOT).href)
  let refreshed = 0
  const { tree, instance } = render(OssAuthCard, { cred: null, defaultEndpoint: 'oss-cn-x.aliyuncs.com', onRefresh: () => { refreshed += 1 } })
  // 填表：直接改 state（替身没有真实 DOM 事件）。
  const inputs = collectInputs(tree)
  assert.equal(inputs.length >= 3, true, 'AK ID / Secret / STS / endpoint 四个输入框')
  instance.state[0] = 'AKID1234567890'
  instance.state[1] = 'TOPSECRET'
  instance.cursor = 0
  const filled = rerender(OssAuthCard, { cred: null, defaultEndpoint: 'oss-cn-x.aliyuncs.com', onRefresh: () => { refreshed += 1 } })
  findButtonLike(filled, zhCN.ossCredSave).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].op, 'oss-cred-save')
  assert.equal(posts[0].args.accessKeyId, 'AKID1234567890')
  assert.equal(posts[0].args.accessKeySecret, 'TOPSECRET')
  // 提交成功后密钥必须从组件状态里消失。
  assert.equal(instance.state[1], '', 'Secret 提交后必须清空')
  assert.equal(refreshed >= 1, true, '保存后要刷新自检页以拿到新的脱敏视图')
})

test('the AK form shows the probe result instead of claiming success on a mere file write', async () => {
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    void payload
    return {
      ok: true,
      status: 200,
      async json() {
        // 「写进文件了」但实测失败 —— 界面必须显示失败原因。
        return { ok: true, path: '/cfg', probe: { ok: false, state: 'AK 无权限', detail: 'AccessDenied' } }
      },
    }
  }
  const { OssAuthCard } = await import(new URL('src/client/features/environment/OssAuthCard.tsx', ROOT).href)
  const { tree, instance } = render(OssAuthCard, { cred: null, defaultEndpoint: '', onRefresh: () => {} })
  instance.state[0] = 'AK'
  instance.state[1] = 'SK'
  instance.cursor = 0
  const filled = rerender(OssAuthCard, { cred: null, defaultEndpoint: '', onRefresh: () => {} })
  findButtonLike(filled, zhCN.ossCredSave).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  const after = rerender(OssAuthCard, { cred: null, defaultEndpoint: '', onRefresh: () => {} })
  const text = textOf(after)
  assert.equal(text.includes(zhCN.ossCredProbeFailed), true, '实测没过就必须说没过')
  assert.equal(text.includes('AccessDenied'), true)
  void tree
})

test('the AK card shows only masked credentials from the Host', async () => {
  stubOps({})
  const { OssAuthCard } = await import(new URL('src/client/features/environment/OssAuthCard.tsx', ROOT).href)
  const { tree } = render(OssAuthCard, {
    cred: { path: '/Users/x/.ossutilconfig', exists: true, endpoint: 'oss-cn-x.aliyuncs.com', accessKeyIdMasked: 'AKID****7890', hasSecret: true, hasSts: false, language: 'CH' },
    defaultEndpoint: 'oss-cn-x.aliyuncs.com',
    onRefresh: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes('AKID****7890'), true, '只展示掩码后的 AK ID')
  assert.equal(text.includes(zhCN.ossCredWritten), true)
  assert.equal(text.includes(zhCN.ossCredConfigured), true)
})

/** 收集树里所有表单控件（input 与 textarea）。 */
function collectInputs(node, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collectInputs(child, found)
    return found
  }
  if (node.type === 'input' || node.type === 'textarea') found.push(node)
  collectInputs(node.props?.children, found)
  return found
}

// ── 氚云授权开关与免沙箱重试（Host 的提权链路要有人能开）──────────────────────

test('the trust toggle posts the standing authorization and refreshes', async () => {
  // 没有这个开关，`state.trustH3yun` 永远是 false，白名单内的 crwu 子命令
  // 就不会自动免沙箱 —— 读氚云会一直撞钥匙串。
  const posts = []
  globalThis.fetch = async (url, init) => {
    posts.push(JSON.parse(init.body))
    const op = JSON.parse(init.body).op
    return {
      ok: true,
      status: 200,
      async json() {
        return op === 'trust' ? { ok: true, trust: { h3yun: true } } : { ok: true, trust: { h3yun: true }, checks: [], services: [], blocked: [], allOk: true, manifestSource: '', manifestLoaded: true, platform: 'darwin-arm64', ifindKey: { ok: true, tokenLength: 1, path: 'p', required: true, reason: '' }, workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false }, sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' }, oss: {}, ossCred: { exists: false, path: '', endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' } }
      },
    }
  }
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const env = {
    ok: true, manifestSource: '', manifestKind: 'builtin', manifestLoaded: true, manifestError: '', manifestUpdatedAt: '',
    installDocUrl: '', platform: 'darwin-arm64', checks: [],
    ifindKey: { path: 'p', required: true, ok: true, reason: '', tokenLength: 1 },
    services: [], blocked: [], allOk: true, home: '/Users/x', trust: { h3yun: false },
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
    oss: {}, ossCred: { path: '', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
  }
  const pending = []
  const { tree } = render(EnvironmentPane, {
    env, error: '', busy: false, onRefresh: () => {}, onCopyPrompt: () => {}, copied: false,
    onRelogin: () => {}, onDwsLogin: () => {}, onTrust: (v) => { pending.push(v) },
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    prompt: '', promptUrl: '', promptBusy: false, promptCopied: false, promptMessage: '',
    onPromptRefresh: () => {}, onPromptCopied: () => {},
  })
  const box = collectInputs(tree).find((node) => node.props.type === 'checkbox')
  assert.ok(box, '要有「记住氚云授权」复选框')
  assert.equal(box.props.checked, false, '默认关闭')
  box.props.onChange({ target: { checked: true } })
  assert.deepEqual(pending, [true])
  void posts
})

test('⑧ 里说清审核根会话挂在哪个工作空间（用户报的就是「没挂到我的工作空间里」）', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const baseEnv = {
    ok: true, manifestSource: '', manifestKind: 'builtin', manifestLoaded: true, manifestError: '',
    manifestUpdatedAt: '', installDocUrl: '', platform: 'darwin-arm64', checks: [], services: [],
    blocked: [], allOk: true, home: '/Users/mungdong', trust: { h3yun: false },
    ifindKey: { ok: true, tokenLength: 1, path: 'p', required: true, reason: '' },
    workspace: { chosen: true, path: '/Users/mungdong/中瑞世联工作空间', title: '中瑞世联工作空间', id: 'w1', source: 'manifest-workspace', missing: false },
    sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
    oss: {}, ossCred: { exists: false, path: '', endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
  }
  const props = (env) => ({
    env, error: '', busy: false, onRefresh: () => {}, onCopyPrompt: () => {}, copied: false,
    onRelogin: () => {}, onDwsLogin: () => {}, onTrust: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    prompt: '', promptUrl: '', promptBusy: false, promptCopied: false, promptMessage: '',
    onPromptRefresh: () => {}, onPromptCopied: () => {},
  })
  const ROOT_WORKSPACE = '/Users/mungdong/中瑞世联工作空间'

  const { tree } = render(EnvironmentPane, props({
    ...baseEnv,
    auditRoot: {
      sessionId: 'session-abcdef12-3456', title: '审核子代理根节点 · 09-20 22:40',
      workspacePath: ROOT_WORKSPACE, assignedAt: '2026-09-20T14:40:00Z', usable: true, reason: '',
    },
  }))
  // 必须**只看那一行**：整页 includes 会被 ① 里同一个路径满足 —— 一开始就是这么写的，
  // 把「这一行不显示工作空间」的缺陷放过去了（§6「文本包含式断言」那一类）。
  const row = rowValueOf(tree, zhCN.envAuditRoot)
  assert.notEqual(row, null, '⑧ 里要有「审核根会话」这一行')
  assert.equal(row.includes('审核子代理根节点 · 09-20 22:40'), true, '要显示根会话标题')
  // 短 id 必须是 uuid 那一段：`session-<uuid>` 直接取前 8 位只会得到 'session-'，
  // 用户拿它去侧栏什么也核对不到。
  assert.equal(row.includes('abcdef12'), true, '要给出可核对的会话 id 短码')
  assert.equal(row.includes('session-…'), false, '不能把 `session-` 当短码显示出来')
  assert.equal(row.includes(ROOT_WORKSPACE), true, '这一行自己要给出工作空间路径，别让人去比对 ①')
  assert.equal(row.includes(zhCN.envAuditRootStale), false, '可用的根不该说「已失效」')

  const staleTree = render(EnvironmentPane, props({
    ...baseEnv,
    auditRoot: {
      sessionId: 'session-abcdef12-3456', title: '审核子代理根节点 · 09-20 22:40',
      workspacePath: ROOT_WORKSPACE, assignedAt: '', usable: false, reason: '工作空间已换',
    },
  })).tree
  assert.equal(
    rowValueOf(staleTree, zhCN.envAuditRoot).includes(zhCN.envAuditRootStale),
    true,
    '失效的根要说明下次会自动新建',
  )

  const noneTree = render(EnvironmentPane, props({
    ...baseEnv,
    auditRoot: { sessionId: '', title: '', workspacePath: '', assignedAt: '', usable: false, reason: '' },
  })).tree
  assert.equal(
    rowValueOf(noneTree, zhCN.envAuditRoot).includes(zhCN.envAuditRootNone),
    true,
    '还没建过要说清是「发起审核时自动建在工作空间里」',
  )
})

test('the report page offers a sandbox-free retry when the keychain blocked the read', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  let retried = 0
  const props = {
    state: {
      tasks: [], audits: {}, ossIndex: {}, ossIndexError: '', ossLoading: false, formName: '',
      query: '', page: 1, pageSize: 20, total: 0, filterMode: '', activeKey: '',
      escalateAvailable: true, handoff: null, notice: '', childAliveHint: '',
    },
    gating: { canDispatch: true, canStart: true },
    onSearch: () => {}, onGoPage: () => {}, onRefreshPending: () => {}, onRefreshCloud: () => {},
    onStart: () => {}, onStop: () => {}, onRetryUpload: () => {},
    onOpenCloud: () => {}, onOpenLocalHtml: () => {}, onOpenSession: () => {},
    onOpenAuditInfo: () => {}, onOpenPath: () => {}, onEscalateRetry: () => { retried += 1 },
    handoffCopied: false, onHandoffCopied: () => {},
  }
  const { tree } = render(ReportPane, props)
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.escalateReason), true, '要解释为什么被拦住')
  const button = findButtonLike(tree, zhCN.escalateRetry)
  assert.ok(button, '要给出免沙箱重试入口')
  button.props.onClick()
  assert.equal(retried, 1)

  // 没有 escalateAvailable 时不显示这个提示。
  const quiet = render(ReportPane, { ...props, state: { ...props.state, escalateAvailable: false } })
  assert.equal(textOf(quiet.tree).includes(zhCN.escalateRetry), false)
})

test('占用提示里只剩「停止这条审核」，不再有「只释放占用」', async () => {
  // 2026-09-20 用户要求删掉那个按钮（原话：「这个按钮用不到了，可以删除掉」）。
  // 它会解开占用锁而子会话还在跑 —— 正是「两条子会话往同一个案例目录对写」那条闸门
  // 要拦的状态，所以界面不再提供入口；宿主侧的 `audit-release` 操作仍保留（HOST_ONLY）。
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const stopped = []
  const { tree } = render(ReportPane, {
    state: {
      tasks: [], audits: {}, ossIndex: {}, ossIndexError: '', ossLoading: false, formName: '',
      query: '', page: 1, pageSize: 20, total: 0, filterMode: '', activeKey: '2026-301705-LX10170',
      escalateAvailable: false, handoff: null, notice: '', childAliveHint: '',
    },
    gating: { canDispatch: true, canStart: false },
    onSearch: () => {}, onGoPage: () => {}, onRefreshPending: () => {}, onRefreshCloud: () => {},
    onStart: () => {}, onStop: (childId) => { stopped.push(childId) }, onRetryUpload: () => {},
    onOpenCloud: () => {}, onOpenLocalHtml: () => {}, onOpenSession: () => {},
    onOpenAuditInfo: () => {}, onOpenPath: () => {}, onEscalateRetry: () => {},
    handoffCopied: false, onHandoffCopied: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.activePrefix), true, '有占用时要显示这条提示')
  assert.equal(text.includes(zhCN.stopAudit), true, '「停止这条审核」必须还在')
  assert.equal(text.includes('只释放占用'), false, '「只释放占用（不停子会话）」按钮不该再出现')
  assert.equal(text.includes('只是状态没更新时用这个'), false, '连它那句说明也不该再出现')

  // 删掉另一个按钮不该顺手把「停止」的可用性也弄坏（原来它和释放按钮共用一个 busy 状态）。
  const stop = findButtonLike(tree, zhCN.stopAudit)
  assert.equal(stop.props.disabled, false, '没有 busy 状态时「停止」必须可点（Button 默认 disabled=false）')
  stop.props.onClick()
  assert.deepEqual(stopped, [''], '停止整条审核时 childId 传空串，由 Host 决定停哪一条')
})

// ── 「查看会话」：点了要有反应（不是打印一句提示）────────────────────────────

test('the optional client services are read lazily, not snapshotted at apply time', async () => {
  // 真实故障：`readClientServices` 原来在 apply() 里把 ctx.get 的结果快照成普通对象，
  // 于是「插件比会话控制器先激活」的部署里 `sessions` 永远是 undefined ——
  // 用户点「查看会话」看到「客户端 sessions 服务不可用」，而且刷新页面也不会好。
  const { readClientServices } = await import(new URL('src/client/features/workbench/services.ts', ROOT).href)
  const registry = {}
  const services = readClientServices({ get: (name) => registry[name] })
  assert.equal(services.sessions, undefined, '还没注册时当然是 undefined')

  // 服务晚到：现读的实现立刻就能看到，快照实现会一直看不到。
  registry.sessions = { openSubagent() {} }
  registry.uiWorkspace = { openSession() {} }
  assert.equal(typeof services.sessions.openSubagent, 'function', '晚注册的服务必须能被看到')
  assert.equal(typeof services.uiWorkspace.openSession, 'function')
})

test('openChildSession falls back to uiWorkspace.openSession when sessions is missing', async () => {
  const { openChildSession } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  const calls = []
  const result = await openChildSession(
    {
      sessions: undefined,
      layout: { selectPanel: (panel) => calls.push(['panel', panel]) },
      uiWorkspace: { openSession: (id) => calls.push(['open', id]) },
    },
    { childId: 'child-1', parentSessionId: 'root-1' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.via, 'openSession', '走的是兜底路径')
  assert.deepEqual(calls[0], ['open', 'child-1'])
  assert.deepEqual(calls[calls.length - 1], ['panel', 'conversation'], '打开了还要切过去，否则看不见')
})

test('openChildSession says the service is unavailable only when BOTH paths are missing', async () => {
  const { openChildSession } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  const missing = await openChildSession({ sessions: undefined, layout: undefined, uiWorkspace: undefined }, { childId: 'c', parentSessionId: 'p' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /sessions 服务不可用/)
})

test('openChildSession refreshes the list, tries modes in order, then switches the panel', async () => {
  const { openChildSession, modeCandidates } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  const calls = []
  const services = {
    sessions: {
      async refreshSubagents(parentSessionId) { calls.push(['refresh', parentSessionId]) },
      openSubagent(input) {
        calls.push(['open', input.mode])
        // 模拟：记录里的 mode 不被接受，第二次才成功。
        if (input.mode !== 'one-shot') throw new Error('unsupported mode')
      },
    },
    layout: { selectPanel: (panel) => calls.push(['panel', panel]) },
  }
  const result = await openChildSession(services, { childId: 'child-1', parentSessionId: 'parent-1', mode: 'continuable' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], ['refresh', 'parent-1'], '必须先刷清单，否则 openSubagent 可能找不到孩子')
  assert.deepEqual(calls.filter((c) => c[0] === 'open').map((c) => c[1]), ['continuable', 'one-shot'])
  // 关键：openSubagent 只选中子会话，不切面板；不切就「打开了但看不见」。
  assert.deepEqual(calls[calls.length - 1], ['panel', 'conversation'])
})

test('modeCandidates always tries one-shot and continuable after the recorded mode', async () => {
  const { modeCandidates } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  assert.deepEqual(modeCandidates(undefined), ['one-shot', 'continuable'])
  assert.deepEqual(modeCandidates(''), ['one-shot', 'continuable'])
  assert.deepEqual(modeCandidates('continuable'), ['continuable', 'one-shot'])
  assert.deepEqual(modeCandidates('one-shot'), ['one-shot', 'continuable'])
  assert.deepEqual(modeCandidates('exotic'), ['exotic', 'one-shot', 'continuable'])
})

test('openChildSession explains every precondition instead of failing silently', async () => {
  const { openChildSession } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  const withSessions = { sessions: { openSubagent() {} }, layout: undefined }
  assert.match((await openChildSession(withSessions, { childId: '', parentSessionId: 'p' })).error, /没有子会话 id/)
  assert.match((await openChildSession(withSessions, { childId: 'c', parentSessionId: '' })).error, /缺少父会话 id/)
  assert.match(
    (await openChildSession({ sessions: undefined, layout: undefined }, { childId: 'c', parentSessionId: 'p' })).error,
    /sessions 服务不可用/,
  )
})

test('openChildSession reports the last failure when every mode is rejected', async () => {
  const { openChildSession } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  const result = await openChildSession(
    { sessions: { openSubagent() { throw new Error('boom') } }, layout: undefined },
    { childId: 'c', parentSessionId: 'p' },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
})

test('openChildSession still succeeds when the list refresh itself fails', async () => {
  // refreshSubagents 失败不阻断：有些部署没有它，清单也可能已经是新的。
  const { openChildSession } = await import(new URL('src/client/features/workbench/open-session.ts', ROOT).href)
  const result = await openChildSession(
    {
      sessions: { async refreshSubagents() { throw new Error('offline') }, openSubagent() {} },
      layout: { selectPanel() { throw new Error('no layout') } },
    },
    { childId: 'c', parentSessionId: 'p' },
  )
  assert.equal(result.ok, true, '刷新失败或切面板失败都不该让「已经打开了」变成失败')
})

test('「查看会话」取被点那一行的 key，不拿面板的 activeKey 顶替', async () => {
  // 真实故障：面板原来用 activeKey（「当前在跑的那条」）当目标 —— 在别的行上点「查看会话」
  // 会开到错的孩子；activeKey 为空时更直接，得到「该记录没有子会话 id。」（实测踩到）。
  const { openSessionTarget } = await import(new URL('src/client/features/report-audit/row.ts', ROOT).href)
  const audits = {
    A: { childId: 'child-a', parentSessionId: 'root-a' },
    B: { childId: 'child-b', parentSessionId: 'root-b' },
  }
  assert.deepEqual(
    openSessionTarget('B', audits, 'root-fallback'),
    { childId: 'child-b', parentSessionId: 'root-b' },
    '点的是 B，就必须开 B 的孩子',
  )
  assert.deepEqual(
    openSessionTarget('C', audits, 'root-fallback'),
    { childId: '', parentSessionId: 'root-fallback' },
    '这一行没有记录时不许把别人的孩子端出来',
  )
  assert.deepEqual(
    openSessionTarget('D', { D: { childId: 'child-d', parentSessionId: '' } }, 'root-1'),
    { childId: 'child-d', parentSessionId: 'root-1' },
    '老记录没存父级 → 退回登记的审核根',
  )
})

test('报告页把行 key 交给 onOpenSession（不是交给 activeKey）', async () => {
  // 上一半测「用哪个 key 取孩子」，这一半测「渲染层真的把行 key 传出来了」——
  // 门面的声明与真的发出的参数是两件事，两条都要覆盖（AGENTS.md §6）。
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const task = {
    name: '报告甲', project: '项目甲', business: '', risk: 'B', reviewLevel: '初审',
    reviewState: '', currentNode: '', seqNo: '2026-000001-LX1-BG1', status: '', statusName: '',
    modifiedAt: '', id: '1', idTail: '',
  }
  const audit = {
    key: task.seqNo, childId: 'child-real', seqNo: task.seqNo, project: '项目甲', objectId: '',
    startedAt: '', parentSessionId: 'root-real', status: 'done', ended: true, stopped: false,
    stopReason: '', endReason: '', casePath: '', resultFile: '', htmlFile: '', caseName: '',
    uploadedAt: '', uploadError: '', ossPrefix: '', attempt: 1,
  }
  const opened = []
  const { tree } = render(ReportPane, {
    state: {
      tasks: [task], audits: { [task.seqNo]: audit }, ossIndex: {}, ossIndexError: '', ossLoading: false,
      formName: '', query: '', page: 1, pageSize: 20, total: 1, filterMode: '',
      activeKey: '另一条在跑的', escalateAvailable: false, handoff: null,
      notice: '', childAliveHint: '',
    },
    gating: { canDispatch: true, canStart: true },
    onSearch: () => {}, onGoPage: () => {}, onRefreshPending: () => {}, onRefreshCloud: () => {},
    onStart: () => {}, onStop: () => {}, onRetryUpload: () => {},
    onOpenCloud: () => {}, onOpenLocalHtml: () => {},
    onOpenSession: (key) => { opened.push(key) },
    onOpenAuditInfo: () => {}, onOpenPath: () => {}, onEscalateRetry: () => {},
    handoffCopied: false, onHandoffCopied: () => {},
  })
  const button = findButtonLike(tree, '查看会话')
  assert.ok(button, '这一行的记录有 childId，就该有「查看会话」')
  button.props.onClick()
  assert.deepEqual(opened, [task.seqNo], '发出去的是被点那一行的 key')
})

// ── 手工兜底提示词 ──────────────────────────────────────────────────────────

test('handoffPrompt names the skill, the two phases and all three locating fields', async () => {
  const { handoffPrompt } = await import(new URL('src/client/features/workbench/Handoff.tsx', ROOT).href)
  const prompt = handoffPrompt({ id: 'obj-1', seqNo: '2026-301705-LX10170', name: '汇报', project: '某项目' })
  assert.match(prompt, /crwu-audit 技能/)
  assert.match(prompt, /完整两阶段流程/)
  assert.match(prompt, /obj-1/)
  assert.match(prompt, /2026-301705-LX10170/)
  assert.match(prompt, /某项目/)
})

test('handoffPrompt tells the user how to recover from missing fields', async () => {
  // 字段缺失时给出可操作的提示，而不是留空让 agent 猜。
  const { handoffPrompt } = await import(new URL('src/client/features/workbench/Handoff.tsx', ROOT).href)
  const prompt = handoffPrompt({ id: '', seqNo: '', name: '只有名字', project: '' })
  assert.match(prompt, /缺失，请先用 SeqNo 精确定位/)
  assert.match(prompt, /只有名字/, 'SeqNo 缺失时退回报告名')
  assert.match(prompt, /未取到/)
})

test('the handoff card offers a copy button and reports it was copied', async () => {
  stubOps({})
  const { Handoff } = await import(new URL('src/client/features/workbench/Handoff.tsx', ROOT).href)
  // Node 24 的 globalThis.navigator 只有 getter，直接赋值会抛错。
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => undefined } },
    configurable: true,
  })
  let copied = false
  const { tree } = render(Handoff, { task: { id: 'o', seqNo: 's', name: 'n', project: 'p' }, copied: false, onCopied: (v) => { copied = v } })
  const button = findButtonLike(tree, zhCN.handoffCopy)
  assert.ok(button, '要有复制按钮')
  button.props.onClick()
  for (let i = 0; i < 4; i += 1) await settle()
  assert.equal(copied, true)
  delete globalThis.navigator
})

test('the report page shows the handoff block only when a start failed', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const base = {
    state: {
      tasks: [], audits: {}, ossIndex: {}, ossIndexError: '', ossLoading: false, formName: '',
      query: '', page: 1, pageSize: 20, total: 0, filterMode: '', activeKey: '',
      escalateAvailable: false, notice: '', childAliveHint: '',
    },
    gating: { canDispatch: true, canStart: true },
    onSearch: () => {}, onGoPage: () => {}, onRefreshPending: () => {}, onRefreshCloud: () => {},
    onStart: () => {}, onStop: () => {}, onRetryUpload: () => {},
    onOpenCloud: () => {}, onOpenLocalHtml: () => {}, onOpenSession: () => {},
    onOpenAuditInfo: () => {}, onOpenPath: () => {}, onEscalateRetry: () => {},
    handoffCopied: false, onHandoffCopied: () => {},
  }
  const quiet = render(ReportPane, { ...base, state: { ...base.state, handoff: null } })
  assert.equal(textOf(quiet.tree).includes(zhCN.handoffTitle), false, '成功时不该出现兜底块')
  const shown = render(ReportPane, { ...base, state: { ...base.state, handoff: { id: 'o', seqNo: 's', name: 'n', project: 'p', ...{} } } })
  assert.equal(textOf(shown.tree).includes(zhCN.handoffTitle), true)
})

// ── ⑤ 安装提示词块与 ④ iFinD 卡片 ───────────────────────────────────────────

test('the prompt block shows the instruction verbatim instead of embedding the checklist', async () => {
  stubOps({})
  const { InstallPromptBlock } = await import(new URL('src/client/features/environment/InstallPromptBlock.tsx', ROOT).href)
  const { tree } = render(InstallPromptBlock, {
    prompt: '请完成本机 crwu 审核环境的安装。',
    url: 'https://doc.invalid/install.md',
    busy: false, copied: false, message: '',
    onRefresh: () => {}, onCopied: () => {},
  })
  const inputs = collectInputs(tree)
  assert.equal(inputs.length, 1, '提示词要放在只读输入框里，剪贴板被拒时还能手动全选')
  assert.equal(inputs[0].props.readOnly, true)
  assert.equal(inputs[0].props.value.includes('请完成本机 crwu 审核环境的安装'), true)
  const text = textOf(tree)
  assert.equal(text.includes('doc.invalid/install.md'), true, '要显示清单地址')
  assert.equal(text.includes('可公开读取'), true, '403 是最常见的失败原因，要说明')
})

test('the prompt block regenerates on demand', async () => {
  stubOps({})
  const { InstallPromptBlock } = await import(new URL('src/client/features/environment/InstallPromptBlock.tsx', ROOT).href)
  let refreshed = 0
  const { tree } = render(InstallPromptBlock, {
    prompt: 'x', url: '', busy: false, copied: false, message: '',
    onRefresh: () => { refreshed += 1 }, onCopied: () => {},
  })
  findButtonLike(tree, zhCN.promptRegenerate).props.onClick()
  assert.equal(refreshed, 1)
})

test('the iFinD card never echoes the token and points at the source when missing', async () => {
  stubOps({})
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const base = {
    error: '', busy: false, onRefresh: () => {}, onCopyPrompt: () => {}, copied: false,
    onRelogin: () => {}, onDwsLogin: () => {}, onTrust: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    prompt: '', promptUrl: '', promptBusy: false, promptCopied: false, promptMessage: '',
    onPromptRefresh: () => {}, onPromptCopied: () => {},
  }
  const envBase = {
    ok: true, manifestSource: '', manifestKind: 'builtin', manifestLoaded: true, manifestError: '', manifestUpdatedAt: '',
    installDocUrl: '', platform: 'darwin-arm64', checks: [], services: [], blocked: ['iFinD 密钥'], allOk: false,
    home: '/Users/x', trust: { h3yun: false },
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
    oss: {}, ossCred: { path: '', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
  }
  const missing = render(EnvironmentPane, { ...base, env: { ...envBase, ifindKey: { path: '/cfg.json', required: true, ok: false, reason: 'auth_token 为空', tokenLength: 0 } } })
  const text = textOf(missing.tree)
  assert.equal(text.includes(zhCN.ifindTitle), true)
  assert.equal(text.includes('auth_token 为空'), true, '要说清为什么没过')
  assert.equal(text.includes('mcp.51ifind.com'), true, '要给出密钥来源地址')

  const ok = render(EnvironmentPane, { ...base, env: { ...envBase, blocked: [], allOk: true, ifindKey: { path: '/cfg.json', required: true, ok: true, reason: '', tokenLength: 12 } } })
  const okText = textOf(ok.tree)
  assert.equal(okText.includes(`${zhCN.ifindConfigured}12`), true, '只回长度')
})

// ── 环境自检的门禁与右上角指示灯 ────────────────────────────────────────────
//
// 用户要求的三条可观察行为，这一节逐条钉住：
// 1. 自检通过 → **直接进报告审核**；
// 2. 自检不通过 → 停在这一页，点「进入报告审核」会被 loading 拦住，报告页不出来；
// 3. 右上角那颗灯：通过亮绿、不通过亮红，悬停就把「还差什么」说清。

/** 一份全通过的 env 应答（真实字段名取自 Host 的 EnvResult）。 */
function okEnvBody(patch = {}) {
  return {
    ok: true, manifestSource: 'https://x.invalid/m.json', manifestKind: 'url', manifestLoaded: true,
    manifestError: '', manifestUpdatedAt: '2026-09-20T10:00:00.000Z', installDocUrl: 'https://doc.invalid/install.md',
    platform: 'darwin-arm64',
    checks: [{
      name: 'node', command: 'node', required: true, note: '最上游运行时', found: true, path: '/usr/bin/node',
      versionText: 'v22.19.0', actual: '22.19.0', expect: '>=16.7', ok: true, reason: '', url: '', sha256: '', target: '',
    }],
    ifindKey: { path: '/Users/x/cfg.json', required: true, ok: true, reason: '', tokenLength: 12 },
    services: [{ id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId u1' }],
    blocked: [], allOk: true, home: '/Users/x', trust: { h3yun: false },
    workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manual', missing: false },
    sessionWorkspace: { parentSessionId: 'p1', sessionCwd: '/cases/a', workspaceId: 'w1', workspacePath: '/cases/a', workspaceTitle: 'A' },
    oss: {
      bucket: 'crwu-bucket', prefix: 'crwu/audit', endpoint: 'oss-cn-x.aliyuncs.com', linkMode: 'signed', linkTtl: 3600,
      autoUpload: true, ossutilReady: true, probe: { ok: true, state: 'AK 正常', detail: 'AK 可访问 oss://crwu-bucket/' },
    },
    ossCred: {
      path: '/Users/x/.ossutilconfig', exists: true, endpoint: 'oss-cn-x.aliyuncs.com',
      accessKeyIdMasked: 'AKID****7890', hasSecret: true, hasSts: false, language: 'CH',
    },
    ...patch,
  }
}

/** 一份不通过的 env 应答：平台没识别、工作空间没选定。 */
function blockedEnvBody(patch = {}) {
  return okEnvBody({
    allOk: false, platform: '',
    blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择', '运行平台未识别'],
    ...patch,
  })
}

/** 跑掉当前实例上待执行的 effect。替身不会按依赖重跑 effect，测试自己决定何时跑。 */
async function flushEffects(instance) {
  const pending = instance.effects
  instance.effects = []
  for (const effect of pending) await effect.callback()
  await settle()
}

/**
 * 挂载 → 自检落地 → 再跑一轮 effect。
 *
 * 替身的 effect 只在被调用时执行、也不看依赖数组，所以「envOk 从 false 变 true」触发的那次
 * 自动跳转必须在第二轮显式跑一遍；真实 React 里它由依赖变化自己触发。
 */
async function mountChecked(services = fakeServices()) {
  const rendered = render(WorkbenchPanel, { services })
  await flushEffects(rendered.instance)
  rerender(WorkbenchPanel, { services })
  await flushEffects(rendered.instance)
  return { tree: rerender(WorkbenchPanel, { services }), instance: rendered.instance }
}

test('a passing self-check goes straight into the report page', async () => {
  stubOps({ boot: { body: { ok: true } }, env: { body: okEnvBody() } })
  const { tree } = await mountChecked()
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.tabPending), true, '自检通过就直接进报告审核')
  assert.equal(text.includes(zhCN.tabResults), true)
  assert.equal(text.includes(zhCN.enterReport), false, '已经进来了就不该还停在环境自检页')
})

test('a failing self-check blocks the report page behind a loading state', async () => {
  stubOps({ boot: { body: { ok: true } }, env: { body: blockedEnvBody() } })
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  assert.equal(textOf(tree).includes(zhCN.tabPending), false, '没通过就不能进报告审核')
  assert.equal(textOf(tree).includes(zhCN.envHeroBad), true, '要明说没通过')

  const entry = findButtonLike(tree, zhCN.enterReport)
  assert.ok(entry, '环境自检页要留「进入报告审核」入口 —— 不通过时由 loading 拦住，而不是把按钮藏掉')
  entry.props.onClick()
  const running = rerender(WorkbenchPanel, { services })
  assert.equal(textOf(running).includes(zhCN.gateRunningTitle), true, '点下去先用 loading 拦住')

  for (let i = 0; i < 6; i += 1) await settle()
  const after = rerender(WorkbenchPanel, { services })
  const text = textOf(after)
  assert.equal(text.includes(zhCN.gateBlockedTitle), true, '自检没过就停在这一页并说明被拦住了')
  assert.equal(text.includes(zhCN.tabPending), false, '报告页不许出来')
})

test('after the environment is fixed the blocked entry lets the user through', async () => {
  // 前两次自检（挂载时两轮 effect）不通过，用户修好之后再点一次应当放行。
  let calls = 0
  stubOps({
    boot: { body: { ok: true } },
    env: () => {
      calls += 1
      return { body: calls <= 2 ? blockedEnvBody() : okEnvBody() }
    },
  })
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  assert.equal(textOf(tree).includes(zhCN.tabPending), false)

  findButtonLike(tree, zhCN.enterReport).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  const after = rerender(WorkbenchPanel, { services })
  assert.equal(textOf(after).includes(zhCN.tabPending), true, '修好后再点一次就直接进报告审核')
})

test('the environment store shares one in-flight self-check and keeps the last good result', async () => {
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return okEnvBody() } }
  }
  const store = createEnvStatusStore()
  const [first, second] = await Promise.all([store.refresh(), store.refresh()])
  assert.equal(calls, 1, '会话头的灯与面板几乎同时挂载时，只应该有一次真实自检')
  assert.equal(first?.allOk, true)
  assert.equal(second?.allOk, true)

  // 失败时**保留**上一次的结论：灯退化成「不知道」比保持上一次的真实颜色更糟。
  globalThis.fetch = async () => { throw new Error('offline') }
  const failed = await store.refresh()
  assert.equal(failed, null)
  assert.equal(store.get().env?.allOk, true)
  assert.match(store.get().error, /offline/)
})

test('the lamp is red on failure, green on success, and its tooltip names the blockers', async () => {
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  const { EnvironmentStatusIcon } = await import(
    new URL('src/client/features/environment/EnvironmentStatusIcon.tsx', ROOT).href
  )
  const store = createEnvStatusStore()
  stubOps({ env: { body: blockedEnvBody() } })
  await store.refresh()

  let selected = ''
  const { tree } = render(EnvironmentStatusIcon, { store, compact: true, selectPanel: (panel) => { selected = panel } })
  const dot = find(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.dot}-`))
  assert.ok(dot, '右上角那颗灯必须真的画出来')
  assert.equal(dot.props.className.includes(WORKBENCH_CLASSES.dotBad), true, '不通过要亮红灯')
  assert.equal(textOf(tree), '', 'compact 模式只画灯（会话头位置窄）')
  assert.equal(tree.props.title.includes(zhCN.envLampBad), true)
  assert.equal(tree.props.title.includes('运行平台未识别'), true, '悬停就要说清还差什么')
  tree.props.onClick()
  assert.equal(selected, 'crwu-workbench', '点它要能把工作台面板叫出来')

  // 换成通过的结果：同一颗灯变绿。
  stubOps({ env: { body: okEnvBody() } })
  await store.refresh()
  const green = render(EnvironmentStatusIcon, { store, compact: true })
  const greenDot = find(green.tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.dot}-`))
  assert.equal(greenDot.props.className.includes(WORKBENCH_CLASSES.dotOk), true)
})

test('envLampOf and envTally derive the light and the pass rate from the snapshot', async () => {
  const { envLampOf, envTally } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  assert.equal(envLampOf({ env: null, busy: true, error: '', checkedAt: '' }), 'busy')
  assert.equal(envLampOf({ env: null, busy: false, error: '', checkedAt: '' }), 'idle')
  assert.equal(envLampOf({ env: null, busy: false, error: 'boom', checkedAt: '' }), 'bad')
  assert.equal(envLampOf({ env: blockedEnvBody(), busy: false, error: '', checkedAt: '' }), 'bad')
  assert.equal(envLampOf({ env: okEnvBody(), busy: false, error: '', checkedAt: '' }), 'ok')
  // 正在重新自检时先亮黄：结论未出之前不该继续显示上一次的绿。
  assert.equal(envLampOf({ env: okEnvBody(), busy: true, error: '', checkedAt: '' }), 'busy')
  assert.equal(envLampOf({ env: blockedEnvBody(), busy: true, error: '', checkedAt: '' }), 'busy')

  // 参与计数的是：二进制 + 服务 + iFinD + 工作空间 + 平台。
  const tally = envTally(okEnvBody())
  assert.equal(tally.total, 5)
  assert.equal(tally.passed, 5)
  assert.equal(tally.ratio, 1)
  const partial = envTally(blockedEnvBody())
  assert.equal(partial.passed, 4, '平台没识别那一项没过')
  assert.equal(partial.total, 5)
  assert.equal(envTally(null).ratio, 0)
})

test('the self-check page shows every section, including the facts that used to be missing', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const { tree } = render(EnvironmentPane, {
    env: okEnvBody(),
    error: '', busy: false, checkedAt: '2026-09-20T10:00:00.000Z',
    onRefresh: () => {}, onCopyPrompt: () => {}, copied: false,
    onRelogin: () => {}, onDwsLogin: () => {}, onTrust: () => {}, onEnterReport: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    prompt: '', promptUrl: '', promptBusy: false, promptCopied: false, promptMessage: '',
    onPromptRefresh: () => {}, onPromptCopied: () => {},
  })
  const text = textOf(tree)
  for (const expected of [
    zhCN.envHeroOk,
    zhCN.wsSectionTitle,
    zhCN.envSectionRuntime,
    zhCN.envSectionAccounts,
    zhCN.envSectionIfind,
    zhCN.envSectionOss,
    zhCN.promptTitle,
    zhCN.envSectionInfo,
    '/usr/bin/node',
    'v22.19.0',
    'AKID****7890',
    'crwu/audit',
    'darwin-arm64',
    'https://doc.invalid/install.md',
    '/cases/a',
    `${zhCN.ifindConfigured}12`,
  ]) assert.equal(text.includes(expected), true, `自检页缺了「${expected}」`)
  assert.equal(text.includes(zhCN.trustHint), true, '氚云授权开关要留着（没有它 crwu 读氚云会一直撞钥匙串）')
})

test('a blocked self-check lists the blockers and still offers the install prompt', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const { tree } = render(EnvironmentPane, {
    env: blockedEnvBody(),
    error: '', busy: false, checkedAt: '',
    onRefresh: () => {}, onCopyPrompt: () => {}, copied: false,
    onRelogin: () => {}, onDwsLogin: () => {}, onTrust: () => {}, onEnterReport: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    prompt: '', promptUrl: '', promptBusy: false, promptCopied: false, promptMessage: '',
    onPromptRefresh: () => {}, onPromptCopied: () => {},
  })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.envBlockedTitle), true)
  assert.equal(text.includes('运行平台未识别'), true)
  assert.equal(text.includes('未找到工作空间「中瑞世联工作空间」，请手动选择'), true)
  assert.equal(text.includes(zhCN.promptTitle), true, '不通过时最需要安装提示词')
})

test('the lamp in the panel header switches back to the self-check page', async () => {
  stubOps({ boot: { body: { ok: true } }, env: { body: okEnvBody() } })
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  assert.equal(textOf(tree).includes(zhCN.tabPending), true, '通过之后面板停在报告审核页')

  const lamp = find(tree, (node) => node.type === 'button' && node.props?.['aria-label'] === zhCN.envLampLabel)
  assert.ok(lamp, '面板头部要有环境指示灯')
  lamp.props.onClick()
  const after = rerender(WorkbenchPanel, { services })
  assert.equal(textOf(after).includes(zhCN.envSectionRuntime), true, '点灯要能回到环境自检页')
  assert.equal(textOf(after).includes(zhCN.tabPending), false)
})

// ── 加载态与右侧抽屉（审核信息）─────────────────────────────────────────────
//
// 用户要求的两条可观察行为：
// 1. 首屏取数 / 翻页 / 重新自检时要有**看得见**的加载态（不是只把按钮改成 …）；
// 2. 审核信息改成**右侧抽屉**，不离开列表就能看明细。

/** 一条待审核报告（字段照 Host 的 TaskRow）。 */
const PENDING_TASK = {
  name: '某项目资产评估报告', project: '某项目', business: '资产经营', risk: '低',
  reviewLevel: '初审', reviewState: '审核中', currentNode: '三级复核人',
  seqNo: '2026-301705-LX10170-BG8746', status: 'doing', statusName: '进行中',
  modifiedAt: '2026-09-20 18:18:59', id: 'daf6f5f6-0000-0000-0000-000000000000', idTail: 'daf6f5f6',
}

/** 该报告的云端交付件（HTML + JSON 都在，才有「审核信息」入口）。 */
const PENDING_CLOUD = {
  seqNo: PENDING_TASK.seqNo,
  files: [{ key: `crwu/audit/${PENDING_TASK.seqNo}/审核意见.html`, name: '审核意见.html' }],
  htmlKey: `crwu/audit/${PENDING_TASK.seqNo}/审核意见.html`,
  jsonKey: `crwu/audit/${PENDING_TASK.seqNo}/审核结果.json`,
}

/** 报告页的最小 props（默认空态、不忙）。 */
function reportPaneProps(patch = {}) {
  const state = {
    tasks: [], audits: {}, ossIndex: {}, ossIndexError: '', ossLoading: false, formName: '',
    query: '', page: 1, pageSize: 20, total: 0, filterMode: '', activeKey: '',
    escalateAvailable: false, handoff: null, notice: '', childAliveHint: '',
    ...(patch.state ?? {}),
  }
  return {
    state,
    gating: { canDispatch: true, canStart: true, ...(patch.gating ?? {}) },
    onSearch: () => {}, onGoPage: (page) => { patch.onGoPage?.(page) }, onRefreshPending: () => {}, onRefreshCloud: () => {},
    onStart: () => {}, onStop: () => {}, onRetryUpload: () => {},
    onOpenCloud: () => {}, onOpenLocalHtml: () => {}, onOpenSession: () => {},
    onOpenAuditInfo: () => {}, onOpenPath: () => {}, onEscalateRetry: () => {},
    handoffCopied: false, onHandoffCopied: () => {},
  }
}

/** 元素树里有没有某个 class（用前缀匹配，避免把 tone 类当成基类）。 */
function hasClass(node, className) {
  return find(node, (item) => String(item.props?.className ?? '').includes(className)) !== null
}

/**
 * 元素树里有没有**恰好带这个 class** 的元素。
 *
 * `includes` 在这里不够用：`crwu-audit-side-drawer` 是 `crwu-audit-side-drawer-backdrop` 的子串，
 * 用 includes 会先命中遮罩，把「抽屉本体画出来了吗」变成一条永远为真的断言。
 */
function hasExactClass(node, className) {
  return find(node, (item) => String(item.props?.className ?? '').split(/\s+/).includes(className)) !== null
}

test('the pending list shows a loading state instead of “没有待审核报告” on first entry', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const loading = render(ReportPane, reportPaneProps({ gating: { busy: true } }))
  const loadingText = textOf(loading.tree)
  assert.equal(loadingText.includes(zhCN.loadingList), true, '首屏还没拿到数据时要显示正在拉取')
  assert.equal(loadingText.includes(zhCN.noRows), false, '加载中不能说「没有待审核报告」')

  const idle = render(ReportPane, reportPaneProps())
  assert.equal(textOf(idle.tree).includes(zhCN.noRows), true, '确实没有数据时才显示空态')
})

test('paging and refreshing dim the table and draw a progress bar', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const busy = render(ReportPane, reportPaneProps({
    state: { tasks: [PENDING_TASK], total: 1 },
    gating: { busy: true },
  }))
  assert.equal(hasClass(busy.tree, WORKBENCH_CLASSES.loadBar), true, '取列表时要有进度条')
  assert.equal(hasClass(busy.tree, WORKBENCH_CLASSES.dim), true, '正文要压暗（同时防手快连点）')
  assert.equal(textOf(busy.tree).includes(zhCN.noRows), false)
  // 顶部进度条在滚下去之后看不见，所以翻页控件旁边也要有加载提示。
  assert.equal(textOf(busy.tree).includes(zhCN.loadingList), true, '翻页控件旁要有加载提示')

  const idle = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  assert.equal(hasClass(idle.tree, WORKBENCH_CLASSES.loadBar), false, '不在加载时不该有进度条')
  assert.equal(hasClass(idle.tree, WORKBENCH_CLASSES.dim), false)
})

test('the self-check page draws a progress bar and dims the body while re-checking', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const props = {
    error: '', checkedAt: '', onRefresh: () => {}, onCopyPrompt: () => {}, copied: false,
    onRelogin: () => {}, onDwsLogin: () => {}, onTrust: () => {}, onEnterReport: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    prompt: '', promptUrl: '', promptBusy: false, promptCopied: false, promptMessage: '',
    onPromptRefresh: () => {}, onPromptCopied: () => {},
  }
  const busy = render(EnvironmentPane, { ...props, env: okEnvBody(), busy: true })
  assert.equal(hasClass(busy.tree, WORKBENCH_CLASSES.loadBar), true, '重新自检时要有进度条')
  assert.equal(hasClass(busy.tree, WORKBENCH_CLASSES.dim), true, '正文要压暗')

  const idle = render(EnvironmentPane, { ...props, env: okEnvBody(), busy: false })
  assert.equal(hasClass(idle.tree, WORKBENCH_CLASSES.loadBar), false)
  assert.equal(hasClass(idle.tree, WORKBENCH_CLASSES.dim), false)
})

test('the side drawer closes on the backdrop and on Escape', async () => {
  const { SideDrawer } = await import(new URL('src/client/components/SideDrawer.tsx', ROOT).href)
  const listeners = []
  globalThis.document = {
    ...fakeDocument().document,
    addEventListener: (type, listener) => { listeners.push({ type, listener }) },
    removeEventListener: () => {},
  }
  let closed = 0
  const { tree, instance } = render(SideDrawer, { title: '审核信息 · X', onClose: () => { closed += 1 } })
  for (const effect of instance.effects) await effect.callback()

  assert.equal(listeners[0]?.type, 'keydown', '要挂键盘监听（Esc 关闭）')
  listeners[0].listener({ key: 'Escape' })
  assert.equal(closed, 1, 'Esc 要能关掉抽屉')

  const backdrop = find(tree, (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.sideDrawerBackdrop))
  assert.ok(backdrop, '要有遮罩（点一下也关）')
  backdrop.props.onClick()
  assert.equal(closed, 2)

  const panel = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.sideDrawer))
  assert.ok(panel, '抽屉本体要画出来')
  assert.equal(panel.props.role, 'dialog')
  assert.equal(panel.props['aria-modal'], 'true')
  delete globalThis.document
})

test('the audit info opens in a right-side drawer, loads, and closes back to the list', async () => {
  stubOps({
    boot: { body: { ok: true } },
    env: { body: okEnvBody() },
    pending: {
      body: {
        ok: true, error: '', rows: [PENDING_TASK], formName: '报告审核', page: 1, size: 20,
        total: 1, query: '', filterMode: '', escalated: false, escalateAvailable: false,
      },
    },
    'audit-status': { body: { ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 } } },
    'oss-index': {
      body: { ok: true, error: '', bucket: 'b', prefix: 'crwu/audit', count: 1, items: { [PENDING_TASK.seqNo]: PENDING_CLOUD }, truncated: false },
    },
    'oss-result': {
      body: {
        ok: true, error: '', key: PENDING_CLOUD.jsonKey,
        info: {
          projectId: 'P-2026-001', auditTime: '2026-09-20 18:20:00', engineVersion: 'crwu-engine/1.4',
          summary: { decision: '通过', counts: { issuesTotal: 13, high: 2, medium: 9, low: 2 } },
        },
      },
    },
  })
  const services = fakeServices()
  // 报告页激活后会挂 10 秒轮询：测试里换成替身，否则定时器会一直挂着进程。
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  try {
    const rendered = render(WorkbenchPanel, { services })
    await flushEffects(rendered.instance)
    rerender(WorkbenchPanel, { services })
    await flushEffects(rendered.instance)
    // 自检通过的那一轮把 view 切成 report；再跑一轮，报告页的 effect 才真的发 pending / oss-index。
    rerender(WorkbenchPanel, { services })
    await flushEffects(rendered.instance)
    const tree = rerender(WorkbenchPanel, { services })

    const entry = findButtonLike(tree, zhCN.auditInfo)
    assert.ok(entry, '报告行里要有「审核信息」入口')
    entry.props.onClick()

    // 抽屉立刻出现（内容还在读），且是右侧固定面板而不是页面底部的一张卡片。
    const opened = rerender(WorkbenchPanel, { services })
    assert.ok(
      find(opened, (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.sideDrawerBackdrop)),
      '审核信息要开在右侧抽屉里（带遮罩）',
    )
    assert.ok(hasExactClass(opened, WORKBENCH_CLASSES.sideDrawer), '抽屉本体要画出来')
    assert.equal(textOf(opened).includes(zhCN.loadingAuditInfo), true, '读 JSON 期间要有加载态')

    for (let i = 0; i < 6; i += 1) await settle()
    const loaded = rerender(WorkbenchPanel, { services })
    const loadedText = textOf(loaded)
    assert.equal(loadedText.includes('项目编号'), true, '读到之后要渲染摘要字段')
    assert.equal(loadedText.includes('P-2026-001'), true)
    assert.equal(loadedText.includes('问题总数'), true)

    findButtonLike(loaded, zhCN.closeDrawer).props.onClick()
    const closed = rerender(WorkbenchPanel, { services })
    assert.equal(hasExactClass(closed, WORKBENCH_CLASSES.sideDrawer), false, '关闭后抽屉必须消失')
    assert.equal(
      find(closed, (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.sideDrawerBackdrop)),
      null,
      '遮罩也要一起收掉',
    )
    // 关掉抽屉之后要回到列表本身（行还在，而不是把整页清空）。
    assert.equal(textOf(closed).includes(PENDING_TASK.seqNo), true, '关闭后列表还在原处')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})
