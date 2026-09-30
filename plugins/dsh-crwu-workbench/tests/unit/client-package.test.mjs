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
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { fakeReact, registerTsxLoader } from '../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)
const { grantedConsent, missingConsent } = await import(new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)
const { PERMISSION_SCHEMA_VERSION, LOCAL_ACCESS_CAPABILITIES } = await import(new URL('src/shared/access/types.ts', ROOT).href)
const { capabilityLabel } = await import(new URL('src/client/features/environment/LocalAccessConsentCard.tsx', ROOT).href)

const { DEVELOPER_CONTACT_URL, WORKBENCH_ROUTE } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { WORKBENCH_CLASSES, WORKBENCH_STYLE_ID, WORKBENCH_STYLE_TEXT } = await import(
  new URL('src/client/features/workbench/consts.ts', ROOT).href
)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { installWorkbenchStyles } = await import(new URL('src/client/features/workbench/styles.ts', ROOT).href)
const { createModuleStore } = await import(new URL('src/client/features/workbench/module-store.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)

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
const { WorkbenchSidebarEntry } = await import(new URL('src/client/features/workbench/WorkbenchSidebarEntry.tsx', ROOT).href)
const { environmentStateOf } = await import(new URL('src/client/features/report-audit/api.ts', ROOT).href)
const { BrandMark } = await import(new URL('src/client/components/BrandMark.tsx', ROOT).href)
const { buildTagOf, createBuildStore, hostIsStale, hostPermissionSchemaStale } = await import(
  new URL('src/client/features/workbench/build-store.ts', ROOT).href
)

/** 一个不联网的 build store 替身：只把快照喂给组件读（刷新由 store 自己的用例覆盖）。 */
function fakeBuildStore(patch = {}) {
  const snapshot = {
    ok: true, error: '', rev: 'pkg-9.9.9', version: '9.9.9', buildKind: 'installed',
    builtAt: '', protocol: WORKBENCH_PROTOCOL, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
    parentSessionId: '', ...patch,
  }
  return { get: () => snapshot, subscribe: () => () => {}, refresh: async () => snapshot }
}

/**
 * `boot` 的就绪应答。
 *
 * **协议号必须跟着源码走**：客户端拿 `WORKBENCH_PROTOCOL` 与宿主回的 `protocol` 比对，
 * 不一致就按「宿主是旧构建」拦下所有发起类操作。协议号 +1 之后仍然手写
 * `{ ok: true }` 的夹具会**静默**变成"旧宿主"路径 —— 那时测试看起来还在跑，
 * 断言却落在"请重启 profile"那一屏上。
 */
function bootOk(patch = {}) {
  return { ok: true, protocol: WORKBENCH_PROTOCOL, parentSessionId: '', ...patch }
}

/** 深度查找第一个满足条件的宿主元素。 */
/** 收集所有命中的节点（前序），用来钉「恰好三行、顺序固定」这种结构断言。 */
function findAll(node, predicate) {
  const hits = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (predicate(current)) hits.push(current)
    walk(current.props.children)
  }
  walk(node)
  return hits
}

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
function fakeClientContext(layout = null) {
  const effects = []
  const injections = []
  const registrations = []
  const disposed = []
  let depth = 0
  const ctx = {
    // 真实 Client 上下文一定有 get：插件用它读可选服务（这里读 layout 以便跳转面板）。
    get: (name) => (name === 'layout' ? (layout ?? { selectPanel() {} }) : undefined),
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

  // 只有两处走 effect：样式元素，以及自助更新状态（轮询定时器 + 面板开关的监听器）。
  // 槽位注入直接调用（与 DSH 自带的客户端插件一致）。
  assert.deepEqual(effects.map((entry) => entry.label), ['crwu-workbench: styles', 'crwu-workbench: update state'])
  assert.deepEqual(injections.map((entry) => entry.name), [
    'sidebar.footer.action', 'main', 'tool.view.cordis', 'conversation.session.header.utilities',
  ], '四个槽位缺一不可：少了会话头那个，界面上就没有办法登记审核父级')
  for (const entry of injections) {
    assert.equal(entry.insideEffect, false, 'slots.inject 不得包在 ctx.effect 里')
  }
  assert.deepEqual(registrations.map((entry) => entry.meta.name), [
    'sidebar.footer.action', 'main', 'tool.view.cordis', 'conversation.session.header.utilities',
  ])
  // 工作台常驻在左侧栏底部（Settings 上方），主面板 key 与它对齐。
  assert.equal(registrations[0].meta.id, 'crwu-workbench')
  assert.equal(registrations[0].meta.label, zhCN.sidebarLabel)
  assert.equal(typeof registrations[0].meta.order, 'number')
  assert.equal(registrations[1].meta.key, 'crwu-workbench')
  // 会话头只留「登记为子会话父级」：环境结论已经由侧栏底部入口那枚标记常驻表达，
  // 再在会话头挂一颗指示灯就是同一件事说两遍（2026-09-22 用户口径）。
  assert.equal(registrations[3].meta.id, 'crwu-audit-parent')
  assert.equal(registrations[3].meta.order, 5)
  for (const entry of registrations) assert.equal(typeof entry.component, 'function')
})

test('the old top-of-sidebar entry and the header lamp are gone for good', async () => {
  installDoc()
  const { ctx, registrations } = fakeClientContext()
  apply(ctx)
  const names = registrations.map((entry) => entry.meta.name)
  assert.equal(names.includes('sidebar.panellist'), false, '顶部图标入口要撤掉')
  assert.equal(
    registrations.some((entry) => entry.meta.id === 'crwu-env-status'),
    false,
    '会话头那颗环境指示灯要撤掉',
  )
  // 撤掉的组件不能只是「没人引用」——它必须真的不在源码里了，否则下次又会被接回去。
  await assert.rejects(
    import(new URL('src/client/features/environment/EnvironmentStatusIcon.tsx', ROOT).href),
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
  )
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

test('侧栏那一席是一张分组卡：卡头 + 三个子项，顺序固定', async () => {
  installDoc()
  const { ctx, registrations } = fakeClientContext()
  apply(ctx)
  const tree = resolve(registrations[0].component({ wide: true }))
  // 用户要的是「看起来像一个模块」：外框是一张卡，不是三个挨着的入口。
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className.includes(WORKBENCH_CLASSES.sideCard), true)
  // 侧栏卡与面板必须拿到**同一个** store 对象：各自一份就是「侧栏高亮 A、面板显示 B」的根因。
  assert.equal(
    registrations[0].component({ wide: true }).props.modules,
    registrations[1].component().props.modules,
    '侧栏分组卡与面板要共用同一份模块状态',
  )
  // 卡头：模块名 + 版本标签。**它是纯标题，不是第四个可选项**（用户口径：
  // 「中瑞世联工作台这个本身不应该能选中」）—— 所以它既不是 button，也没有 onClick。
  const head = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.sideCardHead))
  assert.equal(head.type, 'div', '卡头不是可点的控件')
  assert.equal(head.props.onClick, undefined, '卡头上不该有任何点击行为')
  assert.equal(textOf(head).includes(zhCN.sidebarLabel), true)
  assert.ok(find(tree, (node) => String(node.props?.className ?? '').includes(`${WORKBENCH_CLASSES.version} `)))
  // 卡身：三行子项，顺序固定为 报告评估 / 报告审核 / 环境信息 —— 不按条件重排。
  // （外部数据源不是第四个模块：它是环境信息页配置列表里的一步，必检与否用红色星号区分。）
  const rows = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.module))
  // 环境那一行的悬停文案顺带给出自检结论（颜色对色觉障碍用户不可读），所以它带结论后缀。
  assert.deepEqual(rows.map((row) => row.props.title), [zhCN.moduleEval, zhCN.moduleAudit, zhCN.moduleEnvMarkIdle])
  const evalRow = rows[0]
  // 还没开发的子项跟一枚**灰色小 tag**「开发中」（用户 2026-09-22 口径：图标难看，换回文字标签）。
  const devTag = find(evalRow, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.moduleTag))
  assert.ok(devTag, '还没开发的子项旁边要有「开发中」标签')
  assert.equal(devTag.props.children, zhCN.moduleDevTag)
  assert.equal(find(devTag, (node) => node.type === 'svg'), null, '不要图标，只要文字标签')
  // 报告审核旁边不再标报告数（用户 2026-09-22 口径）：那一行只有图标 + 名字。
  assert.equal(
    find(rows[1], (node) => typeof node.props?.children === 'string' && /\d/.test(node.props.children)),
    null,
    '报告审核旁边不该再出现数字',
  )
  // 环境结论标记**只属于「环境信息」那一行**：挂在报告审核后面会被读成「那条审核通过了」，
  // 用户 2026-09-22 要求去掉那些、只留环境那一栏。
  assert.equal(
    find(rows[1], (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.sideEntryMark)),
    null,
    '报告审核那一行右侧不该有环境标记',
  )
  assert.ok(
    find(rows[2], (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.sideEntryMark)),
    '环境信息那一行右侧必须有环境标记',
  )
  // 折叠成 56px 轨道：只留一颗图标按钮（轨道放不下卡头 + 三行，硬塞会截成省略号）。
  const rail = resolve(registrations[0].component({ wide: false }))
  assert.equal(rail.type, 'button')
  assert.equal(rail.props.className.includes(WORKBENCH_CLASSES.sideEntryRail), true)
  assert.equal(textOf(rail).includes(zhCN.sidebarLabel), false)
  // 轨道上**不画环境徽标**（用户 2026-09-22：「左侧栏收起来时不应展示绿色的标记」）：
  // 收起来时只留品牌标记那一枚图形；结论不丢 —— `title` 里仍然写着「环境信息：…」。
  assert.equal(findByClass(rail, WORKBENCH_CLASSES.sideEntryMark), null, '折叠轨道上不该有环境标记')
  const railGlyph = findByClass(rail, WORKBENCH_CLASSES.sideEntryGlyph)
  assert.ok(railGlyph, '折叠轨道上要有品牌标记')
  assert.equal(
    find(railGlyph, (node) => node.type === 'svg')?.props?.viewBox,
    '0 0 101 104',
    '轨道上留下的那一枚图形必须是品牌标记本身',
  )
})

test('BrandMark 画的是品牌四个色块，尺寸按原图比例算', () => {
  // 用户给的是一张位图；矢量版必须**形状对得上**，不是"看着差不多"。
  // 形状本身的正确性由描图时的逐像素比对保证（见 BrandMark 的注释），这里钉住外部契约：
  // 四个多边形、三红一金、按 101:104 的比例缩放、默认不参与朗读。
  const tree = resolve(BrandMark({}))
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 16)
  assert.equal(tree.props.viewBox, '0 0 101 104')
  assert.equal(tree.props['aria-hidden'], true, '默认不朗读：旁边紧跟的就是品牌名')

  const shapes = tree.props.children
  assert.equal(shapes.length, 4, '四个色块缺一不可')
  assert.equal(shapes.filter((shape) => shape.props.fill === '#b50120').length, 3, '三块品牌红')
  assert.equal(shapes.filter((shape) => shape.props.fill === '#cf9950').length, 1, '一块品牌金（右上那格）')
  for (const shape of shapes) assert.equal(shape.type, 'polygon')

  const sized = resolve(BrandMark({ size: 20, label: '中瑞世联' }))
  assert.equal(sized.props['aria-label'], '中瑞世联')
  assert.equal(sized.props.height, Math.round((20 * 104) / 101 * 100) / 100)
})

test('buildTagOf：dev 显示 dev，装好的包显示具体版本，旧宿主退回 rev', async () => {
  const base = { ok: true, error: '', rev: 'pkg-9.9.9', version: '9.9.9', buildKind: 'installed', builtAt: '', protocol: 6, parentSessionId: '' }
  const dev = buildTagOf({ ...base, buildKind: 'dev' })
  assert.equal(dev.text, 'dev', 'dev 模式不显示版本号（对开发没意义）')
  assert.equal(dev.tone, 'dev')
  assert.match(dev.title, /本地源码检出/, '悬停要说清这是源码检出、改了要重新 build')

  const installed = buildTagOf(base)
  assert.equal(installed.text, 'v9.9.9')
  assert.equal(installed.tone, 'installed')
  assert.match(installed.title, /已安装的插件包 v9\.9\.9/)

  // 旧宿主没有 version / buildKind：退回 rev 去掉 pkg- 前缀，绝不显示空白标签。
  const legacy = buildTagOf({ ...base, version: '', buildKind: '' })
  assert.equal(legacy.text, 'v9.9.9')
  // 什么都没有时才说「未知」。
  const unknown = buildTagOf({ ...base, version: '', buildKind: '', rev: '' })
  assert.equal(unknown.text, '未知')
  assert.equal(unknown.tone, 'unknown')
})

test('build store 的并发去重：入口与面板同时挂载只打一次 boot', async () => {
  // 侧栏入口与面板都要「跑的是哪一份插件」，各自 boot() 会白打一次请求，
  // 还会出现「标签是新的、门禁说旧的」这种自相矛盾的画面。
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return { ok: true, rev: 'pkg-9.9.9', version: '9.9.9', buildKind: 'installed', protocol: 6, parentSessionId: 'session-1' } } }
  }
  const store = createBuildStore()
  const [first, second] = await Promise.all([store.refresh(), store.refresh()])
  assert.equal(calls, 1, '并发调用必须共享同一次 boot')
  assert.equal(first.buildKind, 'installed')
  assert.equal(second.parentSessionId, 'session-1')
  assert.equal(store.get().version, '9.9.9')
})

test('侧栏入口在名字后面标出 dev 模式或具体版本（用户口径）', async () => {
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  const { WorkbenchSidebarEntry } = await import(
    new URL('src/client/features/workbench/WorkbenchSidebarEntry.tsx', ROOT).href
  )
  const store = createEnvStatusStore()
  stubOps({ env: { body: okEnvBody() } })
  await store.refresh()

  const findTag = (tree) => find(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.version} `))

  // 本地源码检出：显示 dev，并用琥珀色提醒「这不是装好的包」。
  const dev = render(WorkbenchSidebarEntry, {
    store, build: fakeBuildStore({ buildKind: 'dev' }), wide: true, onOpen: () => {},
  })
  const devTag = findTag(dev.tree)
  assert.ok(devTag, '名字后面必须有一枚小标签')
  assert.equal(textOf(devTag), 'dev')
  assert.equal(devTag.props.className.includes(WORKBENCH_CLASSES.versionDev), true)
  assert.match(String(devTag.props.title), /本地源码检出/)

  // 装好的包：显示具体版本（用户要的就是这个号）。
  const installed = render(WorkbenchSidebarEntry, {
    store, build: fakeBuildStore({ version: '0.0.4' }), wide: true, onOpen: () => {},
  })
  const installedTag = findTag(installed.tree)
  assert.equal(textOf(installedTag), 'v0.0.4')
  assert.equal(installedTag.props.className.includes(WORKBENCH_CLASSES.versionInstalled), true)

  // 折叠成轨道：标记、名字、标签都不画（只留品牌图形）。
  const rail = render(WorkbenchSidebarEntry, {
    store, build: fakeBuildStore(), wide: false, onOpen: () => {},
  })
  assert.equal(findTag(rail.tree), null)
  assert.equal(textOf(rail.tree).includes('dev'), false)
  // 这条 store 的自检结论是**通过**（绿勾），正是用户报的那种情形：收起来时那枚绿标记不该再出现。
  assert.equal(findByClass(rail.tree, WORKBENCH_CLASSES.sideEntryMark), null, '折叠轨道上不该有环境标记')
  assert.equal(
    findByClass(rail.tree, WORKBENCH_CLASSES.sideEntryMarkOk),
    null,
    '折叠轨道上尤其不该有那枚绿色通过标记',
  )
  // 但结论不能丢：轨道那颗按钮的悬停文案仍然写着「环境信息：已通过」。
  assert.equal(String(rail.tree.props.title).includes(zhCN.moduleEnvMarkOk), true, String(rail.tree.props.title))
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

test('选中行的底色与悬停底色分得开，卡头不可点、卡激活只换描边', () => {
  // 用户 2026-09-22 报的三件事：① 悬停别的子项时底色和激活那条一样，看不出自己在哪一页；
  // ② 「中瑞世联工作台」那一行本身不应该能选中；③ 卡整块换底色不好看。
  // 三条都盯在**真实规则文本**上，而不是 `includes` 一句就算。
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = new RegExp(`${escaped}(?:\\s*,\\s*[^{}]*)?\\s*\\{([^}]*)\\}`).exec(WORKBENCH_STYLE_TEXT)
    assert.ok(hit !== null, `样式里找不到 ${selector} 规则`)
    return hit[1]
  }
  const declaration = (body, prop) => {
    const hit = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`).exec(body)
    assert.ok(hit !== null, `规则里找不到 ${prop}`)
    return hit[1].trim()
  }

  const hover = rule('.crwu-audit-module:hover')
  const on = rule('.crwu-audit-module-on')
  assert.notEqual(
    declaration(hover, 'background'),
    declaration(on, 'background'),
    '悬停与选中的底色不能是同一档（这正是用户报的那个缺陷）',
  )
  // 选中用品牌色低浓度底 + 左侧强调条；悬停只是一层中性极浅底。
  assert.match(declaration(on, 'background'), /color-mix/)
  assert.match(declaration(on, 'box-shadow'), /inset 3px 0 0/)
  assert.doesNotMatch(declaration(hover, 'background'), /color-mix/)
  // 悬停自己那条选中行时不许被降级成悬停底色：两条同特异度，必须显式钉住。
  assert.match(rule('.crwu-audit-module-on:hover'), /color-mix/)

  // 卡头是纯标题：没有手型光标，也没有悬停规则。
  assert.doesNotMatch(rule('.crwu-audit-side-card-head'), /cursor\s*:\s*pointer/)
  assert.equal(/\.crwu-audit-side-card-head:hover/.test(WORKBENCH_STYLE_TEXT), false, '卡头不该有悬停态')

  // 卡激活（面板开着）只换描边，不整块换底色。
  const cardOn = rule('.crwu-audit-side-card-on')
  assert.match(cardOn, /border-color/)
  assert.doesNotMatch(cardOn, /background\s*:/)
})

test('环境标记是实心圆徽标（圆底 + 白字形），四态各有形状', () => {
  // 用户 2026-09-22：「环境信息检测通过的标记与否还是可以再设计一下，现在并不好看」
  // —— 选定 iOS 设置风：实心状态色圆底 + 白字形；四态各有形状，不只靠颜色区分。
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = new RegExp(`${escaped}(?:\\s*,\\s*[^{}]*)?\\s*\\{([^}]*)\\}`).exec(WORKBENCH_STYLE_TEXT)
    assert.ok(hit !== null, `样式里找不到 ${selector} 规则`)
    return hit[1]
  }
  const badge = rule('.crwu-audit-side-entry-mark')
  assert.match(badge, /border-radius:\s*50%/, '圆徽标必须是圆的')
  assert.match(badge, /width:\s*16px/, '尺寸固定，四态之间不许因为形状不同而跳动')
  // 白字形：色块上的字形必须恒为白，所以用 static 白而不是会在深色主题翻黑的那几个 alias。
  assert.match(badge, /color:\s*var\(--dsw-static-neutral-bluish-00\)/)
  // 通过 / 不通过 / 自检中都是**实心**圆底（各自的状态色），尚未自检才是空心圈。
  for (const [tone, token] of [
    ['ok', '--dsw-alias-state-success-primary'],
    ['bad', '--dsw-alias-state-error-primary'],
    ['busy', '--dsw-alias-state-warn-primary'],
  ]) {
    assert.match(rule(`.crwu-audit-side-entry-mark-${tone}`), new RegExp(`background:\\s*var\\(${token}\\)`), `${tone} 要有实心圆底`)
  }
  const idle = rule('.crwu-audit-side-entry-mark-idle')
  assert.match(idle, /background:\s*transparent/)
  assert.match(idle, /border:/, '尚未自检是空心圈，靠描边成形')
  // 自检中：圆里那段旋转白弧（动画 + 白顶边），不额外增加图形资产。
  const busyArc = rule('.crwu-audit-side-entry-mark-busy::after')
  assert.match(busyArc, /animation:\s*crwu-audit-spin/)
  assert.match(busyArc, /border-top-color:\s*var\(--dsw-static-neutral-bluish-00\)/)
})

test('统一等待页：品牌标记依次亮起 + 进度条，且尊重"减少动态效果"', () => {
  // 用户 2026-09-22 口径：「需要一个统一的 loading 页面…这个注意有个好看的 svg」。
  // 那条 svg 就是品牌标记本身 —— 四个色块按顺序呼吸，不再额外引入图形资产。
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = new RegExp(`${escaped}(?:\\s*,\\s*[^{}]*)?\\s*\\{([^}]*)\\}`).exec(WORKBENCH_STYLE_TEXT)
    assert.ok(hit !== null, `样式里找不到 ${selector} 规则`)
    return hit[1]
  }
  assert.match(rule('.crwu-audit-loading-pane'), /display:\s*flex/)
  assert.match(rule('.crwu-audit-loading-title'), /font-size:/)
  assert.match(rule('.crwu-audit-loading-hint'), /max-width:/, '说明文案要限宽，别横贯整页')
  // 品牌标记：整体呼吸 + 每个色块按顺序亮起（四个延迟必须互不相同，否则四个块一起闪，看不出"依次"）。
  assert.match(rule('.crwu-audit-loading-mark'), /animation:\s*crwu-audit-breathe/)
  assert.match(rule('.crwu-audit-loading-mark svg polygon'), /animation:\s*crwu-audit-brand-wave/)
  const delays = new Set([2, 3, 4].map((n) => {
    const hit = rule(`.crwu-audit-loading-mark svg polygon:nth-child(${String(n)})`)
    return /animation-delay:\s*([0-9.]+s)/.exec(hit)?.[1] ?? ''
  }))
  assert.equal(delays.size, 3, '三个后置色块的延迟要各不相同')
  assert.equal([...delays].includes(''), false)
  assert.match(WORKBENCH_STYLE_TEXT, /@keyframes crwu-audit-brand-wave/)
  assert.match(WORKBENCH_STYLE_TEXT, /@keyframes crwu-audit-breathe/)
  // 进度条限宽（等待页里它是一条"心跳"，不该横贯整个正文）。
  assert.match(rule('.crwu-audit-loading-pane .crwu-audit-load-bar'), /width:/)
  // 系统开了"减少动态效果"就关掉动画：会动的东西必须让路。
  assert.match(WORKBENCH_STYLE_TEXT, /@media \(prefers-reduced-motion: reduce\)/)
  const reduced = WORKBENCH_STYLE_TEXT.slice(WORKBENCH_STYLE_TEXT.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reduced, /\.crwu-audit-loading-mark svg polygon/)
  assert.match(reduced, /animation:\s*none/)
})

test('the stylesheet uses design tokens and no hard-coded colors', () => {
  // 口径（2026-09-22 起）：**唯一的 token 声明块**允许写原始色值（单点维护的工作台色板），
  // 其余任何规则只允许引用 var(--crwu-*) / var(--dsw-*)。所以扫描前先把那一块剔除。
  const tokenBlock = /19\. 工作台 Design Token[\s\S]*?(?=\/\* ═)/.exec(WORKBENCH_STYLE_TEXT)
  assert.ok(tokenBlock, '找不到 token 声明块（它必须在，且带编号标题）')
  assert.ok(tokenBlock[0].includes('--crwu-app-bg'), 'token 块里要有工作台色板')
  const scannable = WORKBENCH_STYLE_TEXT.replace(tokenBlock[0], '')
  for (const match of scannable.matchAll(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/g)) {
    assert.fail(`样式里出现硬编码颜色 ${match[0]}，应当引用 --crwu-* 或 --dsw-* 设计 token`)
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

test('头部右侧永远是那句问候：姓名来自自检结果，拿不到就整句不展示', async () => {
  const { zhCN: copy } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  // 姓名跟着**环境自检**一起回来（`env.me`），不再单独发一次请求 —— 用户口径：
  // 「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调」。
  const ops = stubOps({
    boot: { body: bootOk() },
    env: { body: okEnvBody({ me: { name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '1' } }) },
  })
  const services = fakeServices()
  const envStatus = createEnvStatusStore()
  await envStatus.refresh()
  const { tree } = render(WorkbenchPanel, { services, envStatus })
  const header = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.header))
  const headerText = textOf(header)
  // 分档取的是本地时钟，所以断言"是某一档问候 + 逗号 + 姓名"，而不是钉死某一个时段。
  const greeting = headerText.match(/(凌晨好|早上好|上午好|中午好|下午好|晚上好)，([^\s]+)/)
  assert.ok(greeting, `头部要有「某档问候，姓名」，实际是 ${JSON.stringify(headerText)}`)
  assert.equal(greeting[2], '杨凡宾', '姓名必须来自自检结果里的 me.name')
  // 只发过一次自检，没有额外的 whoami 请求。
  assert.deepEqual(ops.filter((op) => op === 'env').length, 1)
  // 头部**不再**出现模块名（用户 2026-09-22 要求去掉：在哪一页由侧栏那张卡的高亮说了算）。
  for (const label of [copy.moduleEval, copy.moduleAudit, copy.moduleEnv]) {
    assert.equal(headerText.includes(label), false, `头部不该再出现「${label}」`)
  }

  // 钉钉 CLI 没有登录信息 / 没授权：`me.name` 是空串 → **整句都不展示**（连问候语也不留）。
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const blankStatus = createEnvStatusStore()
  await blankStatus.refresh()
  const empty = render(WorkbenchPanel, { services, envStatus: blankStatus })
  const emptyHeader = textOf(find(empty.tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.header)))
  assert.equal(
    /(凌晨好|早上好|上午好|中午好|下午好|晚上好)/.test(emptyHeader),
    false,
    `拿不到姓名时什么也不展示，实际是 ${JSON.stringify(emptyHeader)}`,
  )
  assert.equal(
    find(empty.tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.greeting)),
    null,
  )
})

test('before the Host answers the shell shows the title and the self-check loading copy', () => {
  // 三个模块的入口搬到了左侧栏那张分组卡上，面板里**不再有自己的模块条**；
  // 而「待审核报告」在自检出结论之前不该出现 —— 没通过就不能进报告审核。
  stubOps({})
  const { tree } = render(WorkbenchPanel, { services: fakeServices() })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.title), true)
  // 头部**不再**显示当前模块名（用户 2026-09-22 要求去掉）：在哪一页由侧栏那张卡的高亮说了算，
  // 头部右侧那一格留给问候语。这里只查头部，正文里出现模块名是另一回事。
  const headerText = textOf(find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.header)))
  for (const label of [zhCN.moduleEnv, zhCN.moduleAudit, zhCN.moduleEval]) {
    assert.equal(headerText.includes(label), false, `头部不该再出现「${label}」`)
  }
  // 还没出结论 → 整块正文是那一页统一等待页（有文案、有品牌标记、有进度条）。
  const pane = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.loadingPane))
  assert.ok(pane, '自检期间正文要是统一等待页')
  assert.equal(text.includes(zhCN.loadingEnv), true)
  assert.equal(text.includes(zhCN.loadingHint), true)
  assert.equal(find(pane, (node) => node.type === 'svg' && node.props.children.length === 4) !== null, true, '等待页要有品牌标记')
  assert.ok(find(pane, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.loadBar)))
  assert.equal(text.includes(zhCN.tabPending), false, '自检没出结论前不给进报告审核')
  assert.equal(text.includes(zhCN.tabResults), false)
  assert.equal(
    find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.module)),
    null,
    '面板里不该再有模块条（入口只剩侧栏那一处）',
  )
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
    boot: { body: bootOk({ workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false }, active: { key: '', childId: '', since: 0 }, ported: { done: [], todo: [] } }) },
    env: {
      body: {
        ok: true, platform: 'darwin-arm64',
        packageIntegrity: packagesOk(),
        runtime: runtimeOk(),
        external: externalOk(),
        services: [{ id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId u1' }],
        blocked: [], allOk: true, home: '/Users/x', localAccess: grantedConsent(),
        delivery: deliveryOk(),
        workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
        sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
        state: stateBody(),
      },
    },
  })
  const { tree } = await mount()
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.loadingEnv), false, '拿到数据后不该还显示加载中')
  // 顶部**紧凑状态卡**：一句结论 + 通过率 + 最近检查时间。
  assert.equal(text.includes(zhCN.envStatusReady), true, '环境就绪要有明确结论')
  // 7 项必需项：运行时自 2026-09-29 起不在环境自检里，iFinD 自 2026-09-30 起是可选数据源。
  assert.equal(text.includes('7/7'), true, '通过率与结论必须自洽（只统计必需项）')
  // 页面按"我接下来要做什么"分三步（新结构：左侧步骤导航 + 右侧当前步骤）；
  // 技术细节收进默认收起的「开发者诊断」。
  for (const title of [
    zhCN.envStepAccounts, zhCN.envStepOss, zhCN.envStepIfind, zhCN.envStepWorkspace,
    zhCN.envGroupMaintenance,
  ]) {
    assert.equal(text.includes(title), true, `缺了步骤/折叠区「${title}」`)
  }
  // 四步都在导航上（外部数据源和别的配置项并排），而且这一段是全通过的部署。
  for (const id of ['accounts', 'oss', 'ifind', 'workspace']) {
    assert.equal(stepStateOf(tree, id), 'done', `「${id}」这一步应当是已完成`)
  }
  // 必检项带红色星号，可选的外部数据源**不带**（页面才不乱）。
  assert.equal(text.includes(zhCN.envStepRequiredHint), true, '要说明星号的含义')
  // **员工视野里只有他能做的事**：包内组件 / 平台 / Tool 可见性只在开发者诊断里，
  // 默认收起 —— 所以正文里看不到技术细节（收起时连它们的行标签都不渲染）。
  // （DSH 自带运行时自 2026-09-29 起不在环境自检里，相关行与文案已一并移除。）
  assert.equal(text.includes(zhCN.envDiagToolsOk), false, 'Tool 可见性只在开发者诊断里')
  assert.equal(text.includes(zhCN.envPackagesManifest), false, '包内清单路径只在开发者诊断里')
  assert.equal(text.includes(zhCN.envLayerPackages), false, '旧的"五层"标题不该再出现')
  // AK 掩码是**许可**出现的（它就是脱敏摘要，员工要用来核对是哪一份 AK）；
  // 不许出现的是 Secret 与 SK 明文 —— 那两条在各自卡片的用例里逐字钉住。
  assert.equal(text.includes('TOPSECRET'), false, 'Secret 绝不出现在页面上')
})

test('a blocked environment names the first thing still missing instead of a second checklist', async () => {
  // 新结构（2026-09-26）：顶部**只给第一条**员工能修的下一步，不再把 `blocked[]` 罗列一遍
  // （哪里不对由左侧步骤导航回答）；技术类故障的原文只在默认收起的开发者诊断里。
  stubOps({
    boot: { body: bootOk() },
    env: {
      body: {
        ok: true, platform: '',
        packageIntegrity: packagesOk({ ok: false, supported: false, tools: packagesOk().tools.map((tool) => ({ ...tool, present: false, sizeBytes: 0, ok: false, reason: '插件包不完整 / 平台不受支持' })) }),
        external: externalOk({ path: '/cfg', ok: false, state: 'unconfigured', dataVerified: false, dataTool: '', dataSample: '', reason: '还没有保存 iFinD API-Key', tokenLength: 0 }),
        services: [], blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择', '运行平台未识别'],
        allOk: false, home: '/Users/x', localAccess: grantedConsent(),
        delivery: deliveryOk(),
        workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
        sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
        state: stateBody({
          status: 'action-required', proceed: false, allOk: false, passed: 6, total: 8,
          capabilities: { global: false, auditCore: false, delivery: true, externalData: false },
          userSetup: {
            ...stateBody().userSetup,
            workspace: { state: 'unconfigured', value: '', reason: '未找到工作空间「中瑞世联工作空间」，请手动选择', required: true },
            ifind: { state: 'unconfigured', value: '', reason: '还没有保存 iFinD API-Key', required: true },
          },
          issues: [
            { id: 'workspace', owner: 'user', blocking: true, scope: 'global', action: '选择案例根目录', message: '未找到工作空间「中瑞世联工作空间」，请手动选择' },
            { id: 'ifind', owner: 'user', blocking: true, scope: 'global', action: '填写 iFinD API-Key（向管理员获取）', message: 'iFinD 外部数据暂不可用：还没有保存 iFinD API-Key' },
          ],
          blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择', '运行平台未识别'],
        }),
      },
    },
  })
  const { tree } = await mount()
  const text = textOf(tree)
  // 第一条员工能修的下一步（归属是 user 的那条）。
  assert.equal(text.includes('未找到工作空间「中瑞世联工作空间」，请手动选择'), true, '要说清第一条该修什么')
  assert.match(text, new RegExp(`${zhCN.envStatusAction}2${zhCN.envStatusActionTail}`), '只说还差几项，不罗列全部阻塞项')
  // 旧的 `blocked[]` 只是兼容派生字段：页面读统一模型的 `issues`，不再把它当清单画出来。
  assert.equal(text.includes('运行平台未识别'), false, '页面不许再罗列 blocked[] 里的原文')
  assert.equal(text.includes(zhCN.envStatusReady), false, '有阻塞就不能显示「环境就绪」')
})

test('a failing env call surfaces the reason instead of an empty panel', async () => {
  stubOps({ boot: { body: bootOk() }, env: { status: 503 } })
  const { tree } = await mount()
  assert.match(textOf(tree), /HTTP 503/)
})

test('iFinD 数据源卡片只回长度，绝不回显 API-Key（就在环境信息页的那一步里）', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const props = envPaneProps(okEnvBody())
  const tree = render(EnvironmentPane, props).tree
  // 外部数据源是**配置步骤里的一步**（用户口径：和别人放在一起，不单开一块）。
  findStep(tree, 'ifind').props.onClick()
  const after = rerender(EnvironmentPane, props)
  const text = textOf(after)
  // 那一步的正文就是卡片本身（用户口径 2026-09-30：直接显示状态，不再堆口径说明、也不再另起一块）。
  assert.equal(
    findAll(after, (node) => node.props?.['data-crwu-ifind-card'] !== undefined).length, 1,
    'iFinD 那一步渲染它的 API-Key 卡片',
  )
  assert.equal(
    findAll(after, (node) => node.props?.['data-crwu-env-ifind-optional'] !== undefined).length, 0,
    '那一步不该再有额外的口径块',
  )
  // 卡片只回**脱敏摘要**（长度），绝不回显 API-Key 本身。
  assert.equal(text.includes(`${zhCN.ifindConfigured}12`), true, '只回长度')
  assert.equal(text.includes('your ifind-mcp key'), false, '不得出现占位符或任何密钥内容')
  assert.equal(text.includes(zhCN.envIfindNeverAsk), true, '要明说不要把 API-Key 贴进对话')
  // 输入框永远是空的（已保存的 API-Key 不会回填到输入框）。
  for (const input of collectInputs(after)) {
    assert.notEqual(input.props?.value, 'abcdefghijkl', 'API-Key 绝不回填到输入框')
  }
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
  // 「审核信息」Drawer 一起纳入：它的字段名/小节名全是用户可见文案，内联一份就必然与 locales 漂移。
  for (const file of ['src/client/features/workbench/WorkbenchPanel.tsx', 'src/client/features/report-audit/AuditInfoDrawer.tsx']) {
    const source = await readFile(new URL(file, ROOT), 'utf8')
    // 只检查 JSX 文本节点（`>中文<`）与属性里的中文字符串，注释与类型参数不算。
    const inline = [...source.matchAll(/>\s*([^<>{}\n]*[\u4e00-\u9fff][^<>{}\n]*?)\s*</g)].map((m) => m[1])
    assert.deepEqual(inline, [], `${file} 里的中文文案必须走 locales，不能内联：${inline.join(' / ')}`)
    assert.match(source, /zhCN\./)
  }
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
/**
 * 找到带某个类名的第一个宿主元素（层级卡片头、排查详情头都用它）。
 */
function findByClass(node, className) {
  return find(node, (item) => String(item.props?.className ?? '').split(/\s+/).includes(className))
}

/**
 * 点开开发者诊断（新结构里**唯一**的收起区；账号 / 交付 / 工作空间三块常驻可见）。
 *
 * 旧版是"点开某一层"，新版把技术细节收进一个「开发者诊断」折叠区，所以断言里要展开的是它。
 */
function expandMaintenance(tree) {
  const head = find(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.detailsHead)
    && textOf(node).includes(zhCN.envGroupMaintenance))
  assert.ok(head, '环境信息页要有「开发者诊断」折叠区')
  head.props.onClick()
  return head
}

/** 点开页脚的「排查详情」（维护者信息默认收起）。 */
function expandDetails(tree) {
  const head = findByClass(tree, WORKBENCH_CLASSES.detailsHead)
  assert.ok(head, '环境自检页要有「排查详情」入口')
  head.props.onClick()
}

/** 数一数宿主树里有多少个按钮，文本恰好等于 `label`。用于「全页只留一枚复制入口」这类断言。 */
function countButtonsLike(node, label) {
  if (node === null || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countButtonsLike(child, label), 0)
  // 按钮里可能是**多个子节点**（图标 + 文案 / 两段文案），`textOf` 只取第一个子节点，
  // 用它当判据会漏掉「展开 / 收起」这种双段按钮 —— 这里取整棵子树的文本。
  const self = node.type === 'button' && textOfAll(node).trim().includes(label) ? 1 : 0
  return self + countButtonsLike(node.props?.children, label)
}

/** 整棵子树的文本（`textOf` 只取第一个子节点，做"按钮里写了什么"的判据时不够）。 */
function textOfAll(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfAll).join('')
  return textOfAll(node.props?.children)
}

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

/**
 * 按 `data-crwu-env-step` 找一个步骤导航按钮。
 *
 * 不能用 `findButtonLike(tree, zhCN.envStepOss)`：导航按钮里除了步骤标题还有状态词
 * （已完成 / 待处理 / 进行中），整段文本是「阿里云 OSS已完成」，与纯标题不相等。
 * 步骤导航自己给了稳定的 `data-crwu-env-step`，按它找最可靠（也是它存在的理由）。
 */
function findStep(tree, id) {
  const node = find(tree, (item) => item.props?.['data-crwu-env-step'] === id)
  assert.ok(node, `环境页要有「${id}」这一步的导航按钮`)
  return node
}

/** 步骤导航上某一步的状态（`done` / `todo` / `doing`）。 */
function stepStateOf(tree, id) {
  return findStep(tree, id).props['data-state']
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
    boot: { body: bootOk({ protocol: 1 }) },
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

test('点「查看报告」送的是交付件的 htmlKey，而且「没打开」必须说出来', async () => {
  // 这条链上有两个真实故障（用户报的「oss 查看报告打不开」）：
  // 1. 行里的按钮原来送的是**行 key（流水号）**，而 `oss-link` 按清单的 OSS 前缀做隔离检查，
  //    会把裸流水号拒掉（实测 `ok:false`「对象不在配置的 OSS 前缀内」）；
  // 2. `ok:true` 但 `opened:false`（签名成功、打开浏览器失败）时界面**什么都不说** ——
  //    点下去毫无反应。两半都要闭住。
  let sentKey = ''
  stubOps({
    boot: { body: bootOk({ parentSessionId: '' }) },
    env: { body: okEnvBody() },
    pending: { body: { ok: true, error: '', rows: [PENDING_TASK], formName: '报告审核', page: 1, size: 20, total: 1, query: '', filterMode: '', escalated: false, escalateAvailable: false } },
    'audit-status': { body: { ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 } } },
    'oss-index': { body: { ok: true, error: '', bucket: 'b', prefix: 'crwu/audit', count: 1, items: { [PENDING_TASK.seqNo]: PENDING_CLOUD }, truncated: false } },
    'oss-link': (payload) => {
      sentKey = String(payload.args?.key ?? '')
      return {
        body: {
          ok: true, error: '', url: 'https://example.invalid/report', mode: 'signed', ttl: 60,
          opened: false, openError: '沙箱拒绝了 open 命令',
        },
      }
    },
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
    let tree = rerender(WorkbenchPanel, { services })

    const button = findButtonLike(tree, zhCN.openReport)
    assert.ok(button, '云端有交付件时，行里要有「查看报告」')
    button.props.onClick()
    await settle()
    await settle()
    tree = rerender(WorkbenchPanel, { services })

    assert.equal(sentKey, PENDING_CLOUD.htmlKey, '送的必须是交付件的完整对象 key，不是流水号')
    const text = textOf(tree)
    assert.equal(text.includes('没能打开浏览器'), true, '打开失败也要出声，否则就是「点了没反应」')
    assert.equal(text.includes('沙箱拒绝了 open 命令'), true, '要把真实原因带出来')
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
  // 口径（2026-09-30）：插件不为用户创建工作空间根目录 —— 「新建目录」按钮不许再出现。
  assert.equal(text.includes('新建目录'), false, '没有「新建目录并用作工作空间」按钮')
  assert.equal(
    findAll(tree, (node) => typeof node.props?.label === 'string' && node.props.label.includes('新建')).length,
    0,
    '一个「新建…」按钮都不许渲染',
  )
})

test('picking a directory never creates a directory, even when the service exists', async () => {
  // §8-2：`UiWorkspaceService.createDirectory` 不再被调用。服务仍然挂在 `uiWorkspace` 上
  // （宿主可能提供），判据是**调用次数必须是 0** —— 只断言"类型里没有"是不够的。
  const createdDirs = []
  const ops = stubOps({ workspace: { body: { ok: true, workspace: { chosen: true, path: '/cases/a' } } } })
  const { WorkspaceCard } = await import(new URL('src/client/features/workbench/WorkspaceCard.tsx', ROOT).href)
  const services = fakeServices({
    uiWorkspace: {
      pickDirectory: async () => '/cases/a',
      createDirectory: async (parent, name) => { createdDirs.push([parent, name]); return '/cases/a/crwu-workspace' },
      openWorkspace: async () => undefined,
    },
    workspaces: { create: async ({ path }) => ({ workspaceId: 'w1', path, title: 'A' }) },
  })
  const { tree } = render(WorkspaceCard, {
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    services,
    busy: false, message: '', onBusy: () => {}, onMessage: () => {}, onRefresh: () => {},
  })
  findButtonLike(tree, zhCN.wsPick).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  assert.deepEqual(createdDirs, [], '插件不得创建工作空间根目录')
  assert.deepEqual(ops, ['workspace'], '只把用户选中的已有目录登记给 Host')
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
  assert.equal(text.includes('在新会话中打开'), false, '「在新会话中打开」按钮也已删除')
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

// ── ⑤ 阿里云 AK 表单（Host 有实现但一直没有入口 = 等于不存在）──────────────────

test('the AK form refuses an incomplete credential pair before calling the Host', async () => {
  const ops = stubOps({})
  const { OssCredCard } = await import(new URL('src/client/features/environment/OssCredCard.tsx', ROOT).href)
  // 没保存过 AK 时卡片才画表单（已保存时只给掩码 + 「替换 AccessKey」）。
  const { tree } = render(OssCredCard, { delivery: deliveryUnsaved(), onSaved: () => {} })
  const saveButton = findButtonLike(tree, zhCN.envOssSubmit)
  assert.ok(saveButton, '要有「保存并验证」按钮')
  assert.equal(saveButton.props.disabled, true, '两个字段都空时按钮必须禁用')
  // 两个字段各有**真实 label**（窄窗口里纵向排布，不靠 placeholder 认字段）。
  const labels = findAll(tree, (node) => node.type === 'label').map((node) => textOf(node))
  assert.deepEqual(labels, [zhCN.envOssAkLabel, zhCN.envOssSkLabel], 'AK 表单要有 AccessKey ID / AccessKey Secret 两个带 label 的字段')
  for (let i = 0; i < 4; i += 1) await settle()
  assert.deepEqual(ops, [], '两个字段都空时不该发请求')
  // 只填一半也不许发（半份凭据写下去会让 ossutil 报一个与根因无关的错）。
  const { instance } = render(OssCredCard, { delivery: deliveryUnsaved(), onSaved: () => {} })
  instance.state[0] = 'AKID1234567890'
  instance.cursor = 0
  const half = findButtonLike(rerender(OssCredCard, { delivery: deliveryUnsaved(), onSaved: () => {} }), zhCN.envOssSubmit)
  assert.equal(half.props.disabled, true, '只填 ID 时按钮仍必须禁用')
  for (let i = 0; i < 4; i += 1) await settle()
  assert.deepEqual(ops, [], '半份凭据不该发请求')
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
        return { ok: true, path: '/Users/x/.ossutilconfig', permission: { status: 'inherited', mechanism: 'windows-acl', message: '使用当前 Windows 账户 ACL；POSIX 0600 不适用' }, probe: { ok: true, state: 'AK 正常' } }
      },
    }
  }
  const { OssCredCard } = await import(new URL('src/client/features/environment/OssCredCard.tsx', ROOT).href)
  let refreshed = 0
  const props = { delivery: deliveryUnsaved(), onSaved: () => { refreshed += 1 } }
  const { tree, instance } = render(OssCredCard, props)
  // 填表：直接改 state（替身没有真实 DOM 事件）。
  const inputs = collectInputs(tree)
  // 表单**只有** ID / Secret：STS 与 endpoint 已从员工视野删掉（endpoint 由 Host 回落部署配置）。
  assert.equal(inputs.length, 2, 'AK 表单只有 AccessKey ID 与 AccessKey Secret 两个输入框')
  assert.deepEqual(inputs.map((input) => input.props.name), ['crwu-oss-ak', 'crwu-oss-sk'])
  instance.state[0] = 'AKID1234567890'
  instance.state[1] = 'TOPSECRET'
  instance.cursor = 0
  const filled = rerender(OssCredCard, props)
  findButtonLike(filled, zhCN.envOssSubmit).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].op, 'oss-cred-save')
  assert.equal(posts[0].args.accessKeyId, 'AKID1234567890')
  assert.equal(posts[0].args.accessKeySecret, 'TOPSECRET')
  // 新客户端不送 stsToken / endpoint（endpoint 空着时由 Host 回落到部署配置）。
  assert.equal('stsToken' in posts[0].args, false, '面板不再提交 STS Token')
  assert.equal('endpoint' in posts[0].args, false, '面板不再提交 endpoint（交给 Host 回落）')
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
  const { OssCredCard } = await import(new URL('src/client/features/environment/OssCredCard.tsx', ROOT).href)
  const props = { delivery: deliveryUnsaved(), onSaved: () => {} }
  const { tree, instance } = render(OssCredCard, props)
  instance.state[0] = 'AK'
  instance.state[1] = 'SK'
  instance.cursor = 0
  const filled = rerender(OssCredCard, props)
  findButtonLike(filled, zhCN.envOssSubmit).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  const text = textOf(rerender(OssCredCard, props))
  // 「写进文件了」不算成功：实测失败时界面必须显示失败原因（Host 的原文）。
  assert.equal(text.includes('AccessDenied'), true, '实测没过就必须说没过')
  assert.equal(text.includes(zhCN.envOssSaved), false, '不得在实测失败时说"已保存并验证通过"')
  void tree
})

test('the AK card shows only masked credentials from the Host', async () => {
  stubOps({})
  const { OssCredCard } = await import(new URL('src/client/features/environment/OssCredCard.tsx', ROOT).href)
  const { tree } = render(OssCredCard, { delivery: deliveryOk(), onSaved: () => {} })
  const text = textOf(tree)
  assert.equal(text.includes('AKID****7890'), true, '只展示掩码后的 AK ID')
  assert.equal(text.includes('TOPSECRET'), false, '绝不回显 Secret')
  // 输入框永远是空的（已保存的密钥只以掩码呈现，不会再填回输入框）。
  const inputs = collectInputs(tree)
  assert.equal(inputs.every((input) => input.props?.value === ''), true, '输入框不得带出已保存的密钥')
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

test('未授权时不遮整页：授权卡在「账号连接」里，逐条列出范围；允许 → 落盘并重检', async () => {
  // 口径（2026-09-26 起沿用，协议 18）：授权是插件级硬前置（Host 侧未授权一律拒绝），
  // 但界面上**不**用一个模态层遮住整个环境页 —— 员工口径是「不要让一个模态层遮住整个环境页」。
  // 协议 18 起它还要**逐条列出**这次允许覆盖的固定功能（旧文案只说"信任本插件读取本机凭据"）。
  const posts = []
  let granted = false
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    posts.push(body)
    const envBody = { ...okEnvBody(), localAccess: granted ? grantedConsent() : missingConsent(),
      state: stateBody({
        status: granted ? 'ready' : 'action-required',
        proceed: granted,
        allOk: granted,
        passed: granted ? 8 : 7,
        userSetup: {
          ...stateBody().userSetup,
          credentialsConsent: granted
            ? { state: 'ok', value: '', reason: '', required: true }
            : { state: 'unconfigured', value: '', reason: zhCN.envConsentIntro, required: true },
        },
        issues: granted ? [] : [{ id: 'consent', owner: 'user', blocking: true, scope: 'global', action: '允许工作台访问本机账号和配置', message: '还没有允许工作台访问本机账号和配置' }],
        blocked: granted ? [] : ['还没有允许工作台访问本机账号和配置'],
      }) }
    return {
      ok: true,
      status: 200,
      async json() {
        if (body.op === 'local-access-grant') { granted = true; return { ok: true, error: '', consent: grantedConsent(), permissionSchemaVersion: PERMISSION_SCHEMA_VERSION } }
        // `boot` 必须回当前协议号：否则客户端会按「宿主是旧构建」拦下一切发起类操作，
        // 断言就会落在"请重启 profile"那一屏上（这正是协议号存在的意义）。
        if (body.op === 'boot') return bootOk()
        return envBody
      },
    }
  }
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  const before = textOf(tree)
  // 未授权时**不进入**报告审核（Host 侧也会拒绝），停在环境页并说清为什么。
  assert.equal(before.includes(zhCN.tabPending), false, '未授权不该进报告审核')
  assert.equal(before.includes(zhCN.envConsentTitle), true, '授权卡必须在「账号连接」里可见')
  assert.equal(before.includes(zhCN.envConsentIntro), true, '要讲清"这不是授予所有权限"，范围就是清单')
  assert.equal(before.includes(zhCN.envConsentAgree), true, '要有「允许并继续」')
  assert.equal(before.includes(zhCN.envConsentDecline), true, '要有「暂不允许」')
  // 五项固定能力逐条可读 —— 这是本次改造的核心：员工要知道自己同意了写 .ossutilconfig 这类事。
  for (const capability of LOCAL_ACCESS_CAPABILITIES) {
    assert.equal(before.includes(capabilityLabel(capability)), true, `能力清单缺一项：${capability}`)
  }
  // 「未授权」不许显示成「未登录」：那一行只说"需要先允许"。
  assert.equal(before.includes(zhCN.envConsentBoundary), true, '要说清边界：不给 Agent 凭据、不给任意命令')

  const agree = findButtonLike(tree, zhCN.envConsentAgree)
  assert.ok(agree, '授权卡要有「允许并继续」')
  agree.props.onClick()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const grantPost = posts.find((post) => post.op === 'local-access-grant')
  assert.ok(grantPost, '允许要真的发 local-access-grant 操作')
  // 提交的是**版本 + 规范能力清单**，不是布尔值：被改过的客户端提交不出与界面不同的范围。
  assert.deepEqual(grantPost.args, {
    schemaVersion: PERMISSION_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(posts.some((post) => post.op === 'trust'), false, '协议 18 不再走旧 trust 入口')
  // 授权成功会再跑一次自检；替身不会按依赖重跑 effect，所以这里显式再跑一轮
  // （真实 React 里由 store 通知 + 依赖变化自己触发）。
  await flushEffects(globalThis.__crwuTestInstance)
  const after = textOf(rerender(WorkbenchPanel, { services }))
  assert.equal(after.includes(zhCN.envConsentAgree), false, '允许之后不再显示「允许并继续」')
  // 允许后环境转为就绪；「恢复被拦下来的目标」这条行为由
  // `client-module-gate.test.mjs` 的「重新检查通过后只恢复最近一次被拦的目标」逐条钉住。
  assert.equal(after.includes(zhCN.envStatusReady), true, '允许后环境结论要翻成「已就绪」')
  // 「已允许」那一句在**账号连接**步骤里；四项都完成时页面默认停在最后一步，
  // 所以直接渲染环境页并切到那一步再断言（一次只渲染当前步骤的正文）。
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const paneProps = envPaneProps({ ...okEnvBody(), localAccess: grantedConsent() })
  const paneTree = render(EnvironmentPane, paneProps).tree
  findStep(paneTree, 'accounts').props.onClick()
  const paneText = textOf(rerender(EnvironmentPane, paneProps))
  assert.equal(paneText.includes(zhCN.envConsentAgree), false, '已允许后不再显示「允许并继续」')
  assert.equal(paneText.includes(zhCN.envConsentDone), true, '要显示已允许')
  assert.equal(paneText.includes(zhCN.envConsentRevoke), true, '已允许时要有撤销入口（同意必须可撤销）')
})

test('已授权的部署不再显示授权入口，直接按环境结论进面板', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  const shown = textOf(tree)
  assert.equal(shown.includes(zhCN.envConsentAgree), false, '已授权不该再显示「同意并继续」')
  assert.equal(shown.includes(zhCN.tabPending), true, '已授权就直接按环境结论进面板')
})

test('暂不允许：不改动任何 Host 状态，界面如实说明功能禁用', async () => {
  let posts = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.op === 'local-access-grant' || body.op === 'trust') posts += 1
    return { ok: true, status: 200, async json() {
      if (body.op === 'boot') return bootOk()
      // 未授权：模型必须**如实**说需要员工先允许本机访问（Host 侧也会拒绝发起审核）。
      return { ...okEnvBody(), localAccess: missingConsent(), state: stateBody({
        status: 'action-required', proceed: false, allOk: false, passed: 5, total: 7,
        userSetup: { ...stateBody().userSetup, credentialsConsent: { state: 'unconfigured', value: '', reason: zhCN.envConsentIntro, required: true } },
        issues: [{ id: 'consent', owner: 'user', blocking: true, scope: 'global', action: '允许工作台访问本机账号和配置', message: '还没有允许工作台访问本机账号和配置' }],
        blocked: ['还没有允许工作台访问本机账号和配置'],
      }) }
    } }
  }
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  const consent = find(tree, (node) => node.props?.['data-crwu-env-item'] === 'consent')
  assert.ok(consent, '未授权要有那张卡（账号连接里的一张卡，不是模态层）')
  assert.equal(textOf(tree).includes(zhCN.tabPending), false, '未授权时进不去报告审核（Host 侧也会拒绝）')

  // 点「暂不允许」：**不发任何 Host 操作**，只在本地收起同意按钮并给一句说明。
  const decline = findButtonLike(tree, zhCN.envConsentDecline)
  assert.ok(decline, '未授权时要有「暂不允许」')
  decline.props.onClick()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(posts, 0, '「暂不允许」不许产生任何 Host 变更')
  const declined = textOf(rerender(WorkbenchPanel, { services }))
  assert.equal(declined.includes(zhCN.envConsentDeclined), true, '拒绝后要说清账号 / 审核 / 交付保持禁用')
  // 拒绝之后按钮换成「重新允许一次」：不要再用同一句话问他一遍。
  assert.equal(declined.includes(zhCN.envConsentRegrant), true)
})

test('⑧ 里说清审核根会话挂在哪个工作空间（用户报的就是「没挂到我的工作空间里」）', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const baseEnv = {
    ok: true, platform: 'darwin-arm64', services: [],
    blocked: [], allOk: true, home: '/Users/mungdong', localAccess: grantedConsent(),
    packageIntegrity: packagesOk(),
    runtime: runtimeOk(),
    external: externalOk({ path: 'p', tokenLength: 1 }),
    delivery: deliveryOk(),
    workspace: { chosen: true, path: '/Users/mungdong/中瑞世联工作空间', title: '中瑞世联工作空间', id: 'w1', source: 'manifest-workspace', missing: false },
    sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
    state: stateBody(),
  }
  const props = (env) => ({
    env, error: '', busy: false, onRefresh: () => {},
    onRelogin: () => {}, onDwsLogin: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
  })
  const ROOT_WORKSPACE = '/Users/mungdong/中瑞世联工作空间'
  /** 审核根会话属于**开发者诊断**（默认收起）：先像用户那样点开，再重渲染同一实例。 */
  const rooted = (env) => {
    const paneProps = props(env)
    const collapsed = render(EnvironmentPane, paneProps)
    assert.equal(rowValueOf(collapsed.tree, zhCN.envAuditRoot), null, '开发者诊断默认不展开时不该出现这一行')
    expandMaintenance(collapsed.tree)
    return rerender(EnvironmentPane, paneProps)
  }

  const tree = rooted({
    ...baseEnv,
    auditRoot: {
      sessionId: 'session-abcdef12-3456', title: '审核子代理根节点 · 09-20 22:40',
      workspacePath: ROOT_WORKSPACE, assignedAt: '2026-09-20T14:40:00Z', usable: true, reason: '',
    },
  })
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

  const staleTree = rooted({
    ...baseEnv,
    auditRoot: {
      sessionId: 'session-abcdef12-3456', title: '审核子代理根节点 · 09-20 22:40',
      workspacePath: ROOT_WORKSPACE, assignedAt: '', usable: false, reason: '工作空间已换',
    },
  })
  assert.equal(
    rowValueOf(staleTree, zhCN.envAuditRoot).includes(zhCN.envAuditRootStale),
    true,
    '失效的根要说明下次会自动新建',
  )

  const noneTree = rooted({
    ...baseEnv,
    auditRoot: { sessionId: '', title: '', workspacePath: '', assignedAt: '', usable: false, reason: '' },
  })
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
    onOpenLocalHtml: () => {}, onOpenSession: () => {},
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
  // 2026-09-29 起这里是「当前审核」摘要卡（F3）：流水号、状态、停止阶段都在这一张卡上。
  assert.equal(text.includes(zhCN.currentAuditTitle), true, '有占用时要显示「当前审核」摘要卡')
  assert.equal(text.includes('2026-301705-LX10170'), true, '摘要卡必须显示流水号')
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

test('报告页把行 key 交给讨论入口（不是交给 activeKey）', async () => {
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
  stubOps({})
  const { tree } = render(ReportPane, {
    workspace: { id: 'ws-1', path: '/ws' },
    port: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    state: {
      auditsReady: true,
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
  // 「查看会话」文字按钮已删除（与小鲸鱼重复）；同一条"key 必须是被点那一行"的规矩
  // 现在由小鲸鱼承担 —— 渲染层要把**行自己的 key** 递出去，而不是面板的 activeKey。
  assert.equal(findButtonLike(tree, '查看会话'), null, '查看会话已删除')
  const whale = find(
    tree,
    (node) => node.type === 'button'
      && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn),
  )
  assert.ok(whale, '讨论入口（小鲸鱼）必须在')
  const discussed = []
  const withSpy = { ...{}, }
  void withSpy
  whale.props.onClick()
  await settle()
  // onDiscuss 由 ReportPane 内部持有；这里断言它用的是这一行的 key（没有历史会话时会去
  // 拉文件并尝试建会话，stubOps 给了空回包、port 没有 create 也会优雅降级）。
  assert.deepEqual(opened, [], '小鲸鱼不该再把 key 交给 onOpenSession')
})

// ── 讨论会话：适配器与面板接线（2026-09-25 用户报「跳不到会话 / 建不出新对话」） ──

/**
 * 忠实的客户端 `sessions` 服务替身。
 *
 * 真实实现（DSH `ClientSessions`）的三个语义必须都建模，否则缺陷会从门禁里漏过去
 * （上一版替身就是给每条会话都预置了 binding，比真服务宽容）：
 * - `binding(id)` = 只有**当前被 retain** 的会话才有值；
 * - `create()` 只登记清单、**不** retain → 紧接着 `binding(id)` 是 undefined；
 * - 上面**没有** `open()`；切会话是 `uiWorkspace.openSession(id)`（这里放一个诱饵 `open` 抓错）。
 */
class FakeSessionsService {
  constructor() {
    this.calls = []
    this.known = new Set()
    this.scopes = new Map()
    this.list = { getSnapshot: () => ({ ids: [...this.known], byId: {}, phase: 'ready' }) }
  }
  async create(input) {
    this.calls.push(['create', input])
    this.known.add('session-new')
    return 'session-new'
  }
  async using(id, options, operation) {
    this.calls.push(['using', id, options?.source])
    this.scopes.set(id, { session: { rename: async () => {}, prompt: async () => {} } })
    try {
      return await operation({ binding: this.scopes.get(id) })
    } finally {
      this.scopes.delete(id)
    }
  }
  binding(id) {
    this.calls.push(['binding', id])
    return this.scopes.get(id)
  }
  /** 诱饵：真实服务上不存在这个方法。 */
  open(id) { this.calls.push(['decoy-open', id]) }
}

test('讨论 port 适配器：只转发真实存在的四个动词，且经接收者调用（不解绑 this）', async () => {
  const { discussionPortOf } = await import(new URL('src/client/features/workbench/services.ts', ROOT).href)
  const sessions = new FakeSessionsService()
  const port = discussionPortOf({ sessions })
  // ① 逐方法转发：**不能**写成 `{ ...sessions }` —— 方法在原型上，展开只会留下字段。
  // ② 经接收者调用：`this` 一丢，真实 `ClientSessions` 的 `create` 立刻 TypeError。
  assert.equal(await port.create({ workspaceId: 'ws-1' }), 'session-new')
  await port.using('session-new', { source: 'x' }, () => undefined)
  port.binding?.('session-new')
  assert.deepEqual(sessions.calls.map((row) => row[0]), ['create', 'using', 'binding'])
  assert.equal(typeof port.list?.getSnapshot, 'function', 'list 也要转发')
  // ③ port 上不许凭空多出方法：`sessions.open` 不存在，早先那个 `open` 就是静默 no-op 的来源。
  assert.deepEqual(Object.keys(port).sort(), ['binding', 'create', 'list', 'using'])
  assert.equal(sessions.calls.some((row) => row[0] === 'decoy-open'), false)
  // 服务缺席：空 port，面板据此如实报「这个宿主版本不支持…」。
  assert.deepEqual(Object.keys(discussionPortOf({ sessions: undefined })), [])
})

test('点小鲸鱼从面板一路跳到会话：uiWorkspace.openSession 收到新会话 id', async () => {
  // 用户报「点讨论/复核跳不到对应的会话，也创建不出新对话」。链路是
  // 小鲸鱼 → report-files → ensureDiscussion(create+rename) → onOpenDiscussion → openSession。
  const { createModuleStore } = await import(new URL('src/client/features/workbench/module-store.ts', ROOT).href)
  const sessions = new FakeSessionsService()
  const opened = []
  stubOps({
    boot: { body: bootOk({ parentSessionId: '' }) },
    env: { body: okEnvBody() },
    pending: { body: { ok: true, error: '', rows: [PENDING_TASK], formName: '报告审核', page: 1, size: 20, total: 1, query: '', filterMode: '', escalated: false, escalateAvailable: false } },
    'audit-status': { body: { ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 } } },
    'oss-index': { body: { ok: true, error: '', bucket: 'b', prefix: '', count: 0, items: {}, truncated: false } },
    'report-files': { body: { ok: true, error: '', seqNo: PENDING_TASK.seqNo, h3yun: [{ field: 'F1', fileId: 'f1', name: 'V2定稿-估值报告.zip', size: 1, contentType: 'application/zip' }], h3yunError: '', oss: [], local: [], localDir: '', localExists: false, truncated: false } },
  })
  const services = fakeServices({ sessions, uiWorkspace: { openSession: (id) => { opened.push(id) } } })
  const modules = createModuleStore()
  modules.navigate('audit', { state: environmentStateOf(okEnvBody()) })
  const noTimer = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  try {
    const rendered = render(WorkbenchPanel, { services, modules })
    await flushEffects(rendered.instance)
    rerender(WorkbenchPanel, { services, modules })
    await flushEffects(rendered.instance)
    const tree = rerender(WorkbenchPanel, { services, modules })
    const whale = find(
      tree,
      (node) => node.type === 'button'
        && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn),
    )
    assert.ok(whale, '报告审核页要有那枚小鲸鱼')
    whale.props.onClick({ clientX: 40, clientY: 60 })
    await settle()
    assert.deepEqual(sessions.calls.filter((row) => row[0] === 'create').map((row) => row[1]), [{ workspaceId: 'w1' }])
    // 恰好跳一次：`ensureDiscussion` 不再自己跳（两处都跳会连线两次 replaceMain）。
    assert.deepEqual(opened, ['session-new'], '必须真的跳到新建的讨论会话，且只跳一次')
    // 两次 retain：一次改名、一次发开场（每次操作各自 retain/release，是真实 using 的语义）。
    assert.deepEqual(
      sessions.calls.filter((row) => row[0] === 'using').map((row) => row[1]),
      ['session-new', 'session-new'],
      '命名与发问都必须经 using 拿到 face',
    )
    assert.equal(sessions.calls.some((row) => row[0] === 'decoy-open'), false, '不许调用 sessions 上不存在的 open')
  } finally {
    globalThis.setInterval = noTimer.setInterval
    globalThis.clearInterval = noTimer.clearInterval
  }
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

test('the handoff card tells the user exactly how to switch the session to full access', async () => {
  // 用户口径（2026-09-30）：手工兜底跑在员工自己的会话里，必须先把它切成「完全权限」，
  // 而员工大多不知道这个开关在哪 —— 只说一句「打开完全权限」等于没说。所以控件名、选项名、
  // 确认弹窗里的勾选、以及一条命令行的等价做法都要在卡片里逐条写出来。
  const { Handoff } = await import(new URL('src/client/features/workbench/Handoff.tsx', ROOT).href)
  const { tree } = render(Handoff, {
    task: { id: 'o', seqNo: 's', name: 'n', project: 'p' }, copied: false, onCopied: () => {},
  })
  const text = textOf(tree)
  for (const needed of [
    zhCN.handoffFullAccessTitle,
    '访问模式',                 // 控件名（DSH 客户端的实际文案）
    '完全权限',                 // 选项名
    '确认启用完全权限？',        // 确认弹窗标题
    '我已了解风险，并愿意继续',   // 弹窗里的确认勾选
    '/permission danger-full-access', // 命令行等价做法
  ]) {
    assert.ok(text.includes(needed), `权限提醒里必须出现「${needed}」：${text}`)
  }
  // 顺序也是判据：提醒必须排在提示词**之前**（先粘后改权限 = 白跑一轮）。
  assert.ok(
    text.indexOf(zhCN.handoffFullAccessTitle) < text.indexOf(zhCN.handoffIntro),
    '权限提醒要排在提示词前面',
  )
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
  // 「完全权限」提醒是**兜底块的一部分**：没有失败时不许出现在报告页上（审核子会话按设计
  // 固定在 workspace-write，平时看到这句会让员工以为每次都要切完全权限）。
  assert.equal(textOf(quiet.tree).includes(zhCN.handoffFullAccessTitle), false, '没有失败时不该出现权限提醒')
  const shown = render(ReportPane, { ...base, state: { ...base.state, handoff: { id: 'o', seqNo: 's', name: 'n', project: 'p', ...{} } } })
  const shownText = textOf(shown.tree)
  assert.equal(shownText.includes(zhCN.handoffTitle), true)
  assert.equal(shownText.includes(zhCN.handoffFullAccessTitle), true, '兜底块里必须有权限提醒')
})

// ── ⑤ 安装提示词块与 ④ iFinD 卡片 ───────────────────────────────────────────

test('环境页不再有「复制安装提示词」入口（那套做法已删）', async () => {
  // 用户口径（2026-09-26）：环境页不需要这个按钮，那段提示词也不再需要。
  // 二进制随包发布、登录与密钥都在界面上完成之后，它没有任何运行时用途，
  // 留在页面上只会把员工指去绕路（让 Agent 代做本机的事）。
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  for (const env of [okEnvBody(), blockedEnvBody()]) {
    const text = textOf(render(EnvironmentPane, envPaneProps(env)).tree)
    for (const gone of ['复制安装提示词', '安装提示词', '重新生成', '复制提示词']) {
      assert.equal(text.includes(gone), false, `环境页不该再出现「${gone}」`)
    }
    // 手工兜底的「完全权限」提醒**只属于那张兜底卡**（用户 2026-09-30 口径：只加在那一处）：
    // 环境页出现它，员工会以为平时也要把权限切到完全权限。
    assert.equal(text.includes(zhCN.handoffFullAccessTitle), false, '环境页不该出现手工兜底的权限提醒')
  }
})

test('iFinD 数据源卡片：不取数就不谎报已验证，官方入口与开发者诊断各归其位', async () => {
  stubOps({})
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const envBase = okEnvBody({
    external: externalOk({
      path: '/cfg.json', ok: false, state: 'unconfigured', dataVerified: false,
      dataTool: '', dataSample: '', reason: '还没有保存 iFinD API-Key', tokenLength: 0,
    }),
  })
  const paneProps = envPaneProps(envBase)

  // 未配置：**那一步**给「未配置」+ 官方入口（href 来自 Host 下发的 applyUrl），并明说不要代填。
  const stepTree = render(EnvironmentPane, paneProps).tree
  findStep(stepTree, 'ifind').props.onClick()
  const missing = rerender(EnvironmentPane, paneProps)
  const missingText = textOf(missing)
  assert.equal(missingText.includes(zhCN.envIfindStateUnconfigured), true, '未配置要说成未配置')
  assert.equal(missingText.includes(zhCN.envIfindGet), true, '要给出「获取 iFinD API-Key」入口')
  assert.equal(missingText.includes(zhCN.envIfindNeverAsk), true, '要明说不要让 Agent 代填')
  assert.equal(
    find(missing, (node) => node.type === 'a').props.href,
    'https://mcp.51ifind.com/',
    '链接地址必须来自 Host 下发的 applyUrl',
  )
  // 那一步**直接显示状态**，且**不出现**任何阻塞告警 / 「必需项」字样。
  assert.equal(missingText.includes(zhCN.envIfindStateUnconfigured), true, '未配置时就显示「未配置」')
  // §8「iFinD」6：报告是否涉及外部数据都不知道时**不许**给出误导性的缺失告警 ——
  // 未配置只说明"会记未检查"，不渲染任何 warn 级别的 Notice，也不出现"必需 / 阻塞"字样。
  assert.equal(
    findAll(missing, (node) => node.props?.tone === 'warn').length,
    0,
    '未配置外部数据源不产生任何告警块',
  )
  for (const forbidden of ['必需完成', '阻塞', '无法进行']) {
    assert.equal(missingText.includes(forbidden), false, `这一步不许出现「${forbidden}」`)
  }

  // 已配置且真的取到过数据：只给「已配置并验证」+ 最近验证时间。
  const okProps = envPaneProps(okEnvBody({ external: externalOk({ path: '/cfg.json' }) }))
  const okTree0 = render(EnvironmentPane, okProps).tree
  findStep(okTree0, 'ifind').props.onClick()
  const okTree = rerender(EnvironmentPane, okProps)
  const okText = textOf(okTree)
  assert.equal(okText.includes(zhCN.envIfindStateVerified), true, '取到过数据 → 已配置并验证')
  assert.equal(okText.includes(zhCN.envIfindDataAt.trim()), true, '要显示最近真实验证时间')
  assert.equal(okText.includes(zhCN.envIfindNoData), false, '验过时**不**再说「没取到数据」')
  // 工具名与取数样本只在**开发者诊断**里（默认收起），不进用户视野。
  assert.equal(okText.includes('get_stock_summary'), false, '验证工具名不进用户视野')
  assert.equal(okText.includes('{"value":42}'), false, '取数样本不进用户视野')
  const diagTree = render(EnvironmentPane, okProps).tree
  expandMaintenance(diagTree)
  const diagText = textOf(rerender(EnvironmentPane, okProps))
  assert.equal(diagText.includes(zhCN.envDiagIfindTool), true, '开发者诊断里要给出验证用的工具名')
  assert.equal(diagText.includes('get_stock_summary'), true, '要显示验证用的工具名')
  assert.equal(diagText.includes(zhCN.envDiagIfindSample), true, '开发者诊断里要给出取数样本')
  assert.equal(diagText.includes('{"value":42}'), true, '取数摘要要显示（脱敏后人工核对证据）')
  assert.equal(diagText.includes('abcdefghijkl'), false, '任何情况下都不回显 API-Key')
})

// ── 环境自检的门禁与右上角指示灯 ────────────────────────────────────────────
//
// 用户要求的三条可观察行为，这一节逐条钉住：
// 1. 自检通过 → **直接进报告审核**；
// 2. 自检不通过 → 停在这一页，点「进入报告审核」会被 loading 拦住，报告页不出来；
// 3. 右上角那颗灯：通过亮绿、不通过亮红，悬停就把「还差什么」说清。

/**
 * ② 插件内置组件的就绪形状：三件组件都在包里，字节数与包内清单一致。
 *
 * 用函数声明（而不是 `const`）是刻意的：这份夹具在文件前半段的用例里就要用，函数声明会提升。
 */
function packagesOk(patch = {}) {
  const tool = (name, size) => ({
    name, label: `${name} 组件`, file: name, present: true, sizeBytes: size, manifestSizeBytes: size,
    sha256: `sha-${name}`, expectedVersion: name === 'dws' ? '>=0.2.14' : '', note: `${name} 的用途`,
    ok: true, reason: '',
  })
  return {
    ok: true, supported: true, platform: 'darwin-arm64',
    packageRoot: '/Users/x/.dsh/plugins/dsh-crwu-workbench',
    manifestPath: '/Users/x/.dsh/plugins/dsh-crwu-workbench/bin/manifest.json',
    manifestFound: true,
    tools: [tool('crwu', 7351330), tool('dws', 32432720), tool('ossutil', 10849218)],
    note: '插件内置组件 3/3 完整：字节数与包内 bin/manifest.json 一致。',
    ...patch,
  }
}

/** ③ DSH 自带脚本运行时的就绪形状。 */
function runtimeOk(patch = {}) {
  return {
    ok: true, state: 'ok', path: '/opt/dsh/python/bin/python3', versionText: '3.12.3',
    distributions: { openpyxl: '3.1.2', 'python-docx': '1.1.2' },
    missingPackages: [], error: '', source: 'DSH 自带（bundled runtime）',
    expect: '>=3.10', required: true, requiredPackages: ['openpyxl', 'python-docx'],
    note: '审核技能脚本用的 Python 运行时，由 DSH 自带',
    ...patch,
  }
}

/** ⑥ 外部数据（iFinD）的就绪形状。 */
function externalOk(patch = {}) {
  // `applyUrl` 是 Host 下发的官方入口（协议 13 新增）：界面上的「获取 iFinD API-Key」链接用它，
  // 插件不自己拼地址、更不代填。
  // `dataVerified` 是**真的取到数据**（协议 14 起每次环境校验都做一次取数验证）——
  // 夹具默认按"验过了"给，专门测"没取到数据"的用例显式覆盖它。
  return {
    path: '/Users/x/cfg.json', required: false, ok: true, state: 'authenticated', errorKind: '',
    reason: '', tokenLength: 12, checkedAt: '2026-09-26T10:00:00.000Z', toolCount: 3,
    dataVerified: true, dataTool: 'get_stock_summary', dataSample: '{"value":42}',
    applyUrl: 'https://mcp.51ifind.com/', ...patch,
  }
}

/** ⑤ OSS 交付配置的就绪形状：AK 写好且实测通过。 */
function deliveryOk(patch = {}) {
  return {
    oss: {
      enabled: true, bucket: 'crwu-bucket', endpoint: 'oss-cn-x.aliyuncs.com', prefix: 'crwu/audit',
      linkMode: 'signed', linkTtl: 3600, autoUpload: true, ossutilReady: true,
      ossutilPath: '/Users/x/.dsh/plugins/dsh-crwu-workbench/bin/darwin-arm64/ossutil',
    },
    ossCred: {
      path: '/Users/x/.ossutilconfig', exists: true, endpoint: 'oss-cn-x.aliyuncs.com',
      accessKeyIdMasked: 'AKID****7890', hasSecret: true, hasSts: false, language: 'CH',
    },
    probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: true, state: 'AK 正常', detail: 'AK 可访问 oss://crwu-bucket/' },
    ...patch,
  }
}

/**
 * ⑤ 还没保存过 AK 的交付形状（`OssCredCard` 只在**没保存**或点了「替换」时才画表单）。
 *
 * 3 条表单用例测的是「填表 → 提交」这条链，所以夹具必须让输入框真的出现；
 * 已保存态由 `deliveryOk()` 覆盖（那时只给掩码，没有输入框）。
 */
function deliveryUnsaved(patch = {}) {
  return deliveryOk({
    ossCred: {
      path: '/Users/x/.ossutilconfig', exists: false, endpoint: '', accessKeyIdMasked: '',
      hasSecret: false, hasSts: false, language: '',
    },
    probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: false, state: '未配置', detail: '' },
    ...patch,
  })
}

/**
 * 统一环境模型（协议 13 的 `env.state`）。
 *
 * 界面**只读它**做结论（结论 / 通过率 / 门禁），所以测试夹具必须带上它 —— 缺了它界面会按
 * 「旧宿主」处理（不放行），那正是协议号存在的意义。
 */
function stateBody(patch = {}) {
  const item = (state, extra = {}) => ({ state, value: '', reason: '', required: true, ...extra })
  return {
    status: 'ready',
    proceed: true,
    userSetup: {
      workspace: item('ok', { value: '/cases/a' }),
      credentialsConsent: item('ok'),
      h3yun: item('ok', { value: 'userId u1' }),
      dingtalk: item('ok'),
      aliyunOss: item('ok', { value: 'AKID****7890 · AK 正常' }),
      // iFinD 自 2026-09-30 起是**可选数据源**（`required: false`，不进必需项分母）。
      ifind: item('authenticated', { value: 'API-Key 已保存（长度 12，不回显）', required: false }),
    },
    systemHealth: {
      packageIntegrity: item('ok'),
      dshRuntime: item('ok'),
      platform: item('ok'),
      toolRegistry: item('unverified', { required: false }),
    },
    capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    issues: [],
    passed: 7,
    total: 7,
    blocked: [],
    allOk: true,
    checkError: '',
    ...patch,
  }
}

/** 一份全通过的 env 应答（真实字段名取自 Host 的 `EnvResult`：六个分区 + 工作空间 + state）。 */
function okEnvBody(patch = {}) {
  return {
    ok: true, configSource: '/tmp/test-crwu-workbench.yml', platform: 'darwin-arm64',
    packageIntegrity: packagesOk(),
    runtime: runtimeOk(),
    external: externalOk(),
    services: [{ id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId u1' }],
    blocked: [], allOk: true, home: '/Users/x', localAccess: grantedConsent(),
    delivery: deliveryOk(),
    workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manual', missing: false },
    sessionWorkspace: { parentSessionId: 'p1', sessionCwd: '/cases/a', workspaceId: 'w1', workspacePath: '/cases/a', workspaceTitle: 'A' },
    // 「我是谁」跟着自检一起回来；默认空姓名 = 头部那句问候整句不展示。
    me: { name: '', org: '', userId: '' },
    state: stateBody(),
    ...patch,
  }
}

/** 一份不通过的 env 应答：工作空间没选定（员工要处理的那一类）。 */
function blockedEnvBody(patch = {}) {
  const state = stateBody({
    status: 'action-required', proceed: false, allOk: false,
    passed: 6, total: 7,
    capabilities: { global: false, auditCore: false, delivery: true, externalData: true },
    userSetup: { ...stateBody().userSetup, workspace: { state: 'unconfigured', value: '', reason: '未找到工作空间「中瑞世联工作空间」，请手动选择', required: true } },
    issues: [{ id: 'workspace', owner: 'user', blocking: true, scope: 'global', action: '选择案例根目录', message: '未找到工作空间「中瑞世联工作空间」，请手动选择' }],
    blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择'],
  })
  return okEnvBody({
    allOk: false,
    blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择'],
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    state,
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
  const modules = createModuleStore()
  const rendered = render(WorkbenchPanel, { services, modules })
  await flushEffects(rendered.instance)
  // 自检落地 → 再跑一轮 effect（`envChanged` 那一支依赖已就绪的 env；
  // 替身不会按依赖自动重跑，所以这里显式多跑一轮），然后才渲染出最终形态。
  rerender(WorkbenchPanel, { services, modules })
  await flushEffects(rendered.instance)
  return { tree: rerender(WorkbenchPanel, { services, modules }), instance: rendered.instance, modules }
}

test('a passing self-check goes straight into the report page', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const { tree } = await mountChecked()
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.tabPending), true, '自检通过就直接进报告审核')
  assert.equal(text.includes(zhCN.tabResults), true)
  assert.equal(text.includes(zhCN.enterReport), false, '已经进来了就不该还停在环境自检页')
})

test('标题旁的小标签：装好的包显示具体版本（悬停看形态与构建时间）', async () => {
  // 用户要求：标题旁要有「现在跑的是哪一版」，报问题时先看这个号。
  // 客户端刷新就换新、宿主只有重启才换，所以这枚标签是判断「我到底在跑哪一版」的唯一凭据。
  stubOps({
    boot: {
      body: {
        rev: 'pkg-9.9.9', version: '9.9.9',
        buildKind: 'installed', builtAt: '2026-09-20T10:00:00.000Z',
      },
    },
    env: { body: okEnvBody() },
  })
  const { tree } = await mountChecked()
  const chip = find(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.version} `))
  assert.ok(chip, '标题旁要有版本标签')
  assert.equal(textOf(chip), 'v9.9.9', '装好的包显示具体版本（不是 pkg- 前缀的 rev）')
  assert.equal(chip.props.className.includes(WORKBENCH_CLASSES.versionInstalled), true)
  assert.match(String(chip.props.title), /已安装的插件包 v9\.9\.9/)
  assert.match(String(chip.props.title), /2026-09-20T10:00:00\.000Z/, '悬停要看得到构建时间（同版本两次 build 只能靠它区分）')
})

test('dev 形态在标题旁标 dev（琥珀色），而不是假装成某个版本', async () => {
  stubOps({
    boot: { body: bootOk({ rev: 'pkg-9.9.9', version: '9.9.9', buildKind: 'dev' }) },
    env: { body: okEnvBody() },
  })
  const { tree } = await mountChecked()
  const chip = find(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.version} `))
  assert.equal(textOf(chip), 'dev')
  assert.equal(chip.props.className.includes(WORKBENCH_CLASSES.versionDev), true)
  assert.match(String(chip.props.title), /本地源码检出/)
})

test('旧宿主不报版本时退回 rev，仍有标签而不是留空', async () => {
  stubOps({ boot: { body: bootOk({ rev: 'pkg-1.2.3' }) }, env: { body: okEnvBody() } })
  const { tree } = await mountChecked()
  const chip = find(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.version} `))
  assert.ok(chip, '旧宿主也要有标签（否则用户以为界面坏了）')
  assert.equal(textOf(chip), 'v1.2.3')
})

test('旧宿主什么都不报时显示「未知」，而不是空标签', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const { tree } = await mountChecked()
  const chip = find(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(`${WORKBENCH_CLASSES.version} `))
  assert.equal(textOf(chip), zhCN.buildTagUnknown)
})

test('a failing self-check blocks the report page and lands on the environment page', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: blockedEnvBody() } })
  const services = fakeServices()
  const { tree, modules } = await mountChecked(services)
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.tabPending), false, '没通过就不能进报告审核')
  // 结论卡必须说清"还差几项"，并且**唯一**主动作是「重新检查」（而不是把用户送去别处找按钮）。
  assert.match(text, new RegExp(`${zhCN.envStatusAction}1${zhCN.envStatusActionTail}`), '要说清还差 1 项')
  assert.equal(text.includes(zhCN.envActionRecheck), true, '主动作是重新检查')
  // 环境页上**没有**「进入报告审核」按钮（统一导航负责跳转，就绪时也只留一句提示）。
  assert.equal(countButtonsLike(tree, '进入报告审核'), 0, '不通过时更不该有「进入报告审核」按钮')
  // ⚠️ 不再断言"字面上不出现"：非阻塞的外部数据提示里有一句「不影响进入报告审核」，
  // 那是**说明**不是动作。判据是"没有被做成入口"，由上面的按钮计数与这句钉住。
  assert.equal(
    findAll(tree, (node) => node.type === 'button' && textOfAll(node).includes('进入报告审核')).length, 0,
    '环境页不许把「进入报告审核」做成按钮',
  )
  assert.equal(text.includes('未找到工作空间「中瑞世联工作空间」，请手动选择'), true, '要说清差什么')

  // 用户从任意入口想去报告审核：**不进入**目标页，落到环境页并记下被拦的目标。
  const verdict = modules.navigate('audit', { state: environmentStateOf(blockedEnvBody()) })
  assert.equal(verdict.blocked, true, '自检没过时统一导航必须拦住')
  assert.equal(textOf(rerender(WorkbenchPanel, { services, modules })).includes(zhCN.tabPending), false, '报告页不许出来')
  assert.equal(modules.get().pendingTarget, 'audit', '要记下被拦下来的目标')

  // 在环境页点「重新检查」：先用 loading 拦住；这次仍然不通过 → 留在环境页，
  // 状态摘要里给出「进入【报告审核】前…」这条轻提示（不再是一张独立大卡）。
  findButtonLike(tree, zhCN.envActionRecheck).props.onClick()
  const running = rerender(WorkbenchPanel, { services, modules })
  assert.equal(textOf(running).includes(zhCN.envGateRunningTitle), true, '点下去先用 loading 拦住')
  for (let i = 0; i < 6; i += 1) await settle()
  const after = rerender(WorkbenchPanel, { services, modules })
  assert.equal(textOf(after).includes(zhCN.tabPending), false, '报告页不许出来')
  const blockedNote = find(after, (node) => node.props?.['data-crwu-env-gate'] === 'blocked')
  assert.ok(blockedNote, '要说明被拦住了（状态摘要里的一条轻提示）')
  assert.equal(textOf(blockedNote).includes(zhCN.moduleAudit), true, '要说清拦的是哪一页')
})

test('外部数据源未就绪：侧栏仍然进得了报告审核；那一步自己说明"不影响审核"', async () => {
  // 2026-09-30 口径：iFinD 是**可选**数据源 —— 它没配好**不拦**任何页面。
  // 配置入口就是配置工作区里的那一步（和别的配置项并排），拦截说明只由**基础必检项**触发。
  stubOps({ boot: { body: bootOk() }, env: { body: externalDegradedEnvBody() } })
  const services = fakeServices()
  const { tree, modules } = await mountChecked(services)
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.tabPending), true, '通过基础门禁就直接进报告审核（外部数据不拦）')
  assert.equal(find(tree, (node) => node.props?.['data-crwu-env-gate'] === 'blocked'), null, '没被拦过就不该有说明')

  // 切到环境页：那一步在导航上，且**不带星号**（它不是必检项）。
  modules.navigate('env', { state: environmentStateOf(externalDegradedEnvBody()) })
  const envTree = rerender(WorkbenchPanel, { services, modules })
  const envText = textOf(envTree)
  assert.equal(
    findAll(envTree, (node) => node.props?.['data-crwu-env-workspace'] !== undefined).length, 1,
    '环境步骤工作区在同一页上',
  )
  assert.equal(envText.includes(zhCN.envStepIfind), true, 'iFinD 是配置步骤里的一步（和别的配置项并排）')
  assert.equal(envText.includes(zhCN.envStepRequiredHint), true, '要说明星号的含义')
  assert.equal(countButtonsLike(envTree, '进入报告审核'), 0, '环境页不许把跳转做成按钮')
  assert.equal(modules.get().active, 'env')
  // "这一步是可选的、不影响审核"由直接渲染那一步的用例钉住（`data-crwu-env-ifind-optional`）——
  // 外壳渲染里 `EnvironmentPane` 的局部 state 在测试替身中不跨 rerender 保留，别在这里假装点了它。
})

/** 基础环境全过、只有外部数据源（iFinD）未就绪的应答：degraded + externalData=false，**零阻塞**。 */
function externalDegradedEnvBody() {
  const state = stateBody({
    status: 'degraded', proceed: true, allOk: true,
    passed: 7, total: 7,
    capabilities: { global: true, auditCore: true, delivery: true, externalData: false },
    userSetup: { ...stateBody().userSetup, ifind: { state: 'unconfigured', value: '', reason: '还没有配置外部数据源', required: false } },
    issues: [
      {
        id: 'ifind', owner: 'user', blocking: false, scope: 'external-data',
        action: '配置外部数据源（同花顺 iFinD API-Key）',
        message: '外部数据核查未就绪（同花顺 iFinD）：还没有配置外部数据源。不影响进入报告审核，涉及外部数据的项目会标记为「未检查」。',
      },
    ],
    blocked: [],
  })
  return okEnvBody({
    allOk: true,
    blocked: [],
    external: externalOk({
      path: '/cfg.json', ok: false, state: 'unconfigured', dataVerified: false,
      dataTool: '', dataSample: '', reason: '还没有配置外部数据源', tokenLength: 0, checkedAt: '',
    }),
    state,
  })
}

test('after the environment is fixed the blocked entry lets the user through', async () => {
  // 挂载时那次自检不通过，用户修好之后再点「重新检查」应当现场重检并放行。
  let calls = 0
  stubOps({
    boot: { body: bootOk() },
    env: () => {
      calls += 1
      return { body: calls <= 1 ? blockedEnvBody() : okEnvBody() }
    },
  })
  const services = fakeServices()
  const { tree } = await mountChecked(services)
  assert.equal(textOf(tree).includes(zhCN.tabPending), false)

  findButtonLike(tree, zhCN.envActionRecheck).props.onClick()
  for (let i = 0; i < 6; i += 1) await settle()
  // 真实 React 会在依赖变化后再跑一轮 effect（`envState` 变了 → `modules.envChanged` 恢复目标）；
  // 替身不自动跑，所以这里显式模拟：rerender → 冲 effect → 再取树。
  rerender(WorkbenchPanel, { services })
  await flushEffects(globalThis.__crwuTestInstance)
  const after = textOf(rerender(WorkbenchPanel, { services }))
  assert.equal(after.includes(zhCN.tabPending), true, '修好后再点一次就直接进报告审核')
})

test('自检只跑一次：面板重新挂载不重跑，显式重检仍然要跑', async () => {
  // 用户口径（2026-09-22）：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调，
  // 本质就是从环境信息把这个人的信息拿到」。面板会被关掉再打开（切会话、切模块），
  // 而一次自检要探二进制、问氚云与钉钉、列一次 OSS —— 所以重新挂载必须复用已有结论。
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  let calls = 0
  stubOps({ boot: { body: bootOk() }, env: () => { calls += 1; return { body: okEnvBody() } } })
  const services = fakeServices()
  const envStatus = createEnvStatusStore()

  const first = render(WorkbenchPanel, { services, envStatus })
  for (const effect of first.instance.effects) await effect.callback()
  await settle()
  assert.equal(calls, 1, '首次挂载跑一次自检')

  // 关掉面板再打开 = 组件重新挂载，但 store 还是那一份（apply() 创建、随 props 下发）。
  const second = render(WorkbenchPanel, { services, envStatus })
  for (const effect of second.instance.effects) await effect.callback()
  await settle()
  assert.equal(calls, 1, '重新挂载不许再跑一次自检')

  // 页面上的「重新自检」按钮、登录成功后的刷新都直接调 store.refresh()，那条路必须仍然能真跑。
  await envStatus.refresh()
  assert.equal(calls, 2, '显式重检必须真的再跑一次')
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

test('the sidebar entry mark is a red dot when the env fails and a green check when it passes', async () => {
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  const { WorkbenchSidebarEntry } = await import(
    new URL('src/client/features/workbench/WorkbenchSidebarEntry.tsx', ROOT).href
  )
  const store = createEnvStatusStore()
  stubOps({ env: { body: blockedEnvBody() } })
  await store.refresh()

  let opened = 0
  const build = fakeBuildStore()
  const modules = createModuleStore()
  const { tree } = render(WorkbenchSidebarEntry, {
    store, build, modules, wide: true, onOpen: () => { opened += 1 },
  })
  const marks = findAll(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes(WORKBENCH_CLASSES.sideEntryMark))
  assert.equal(marks.length, 1, '整张卡上只有一枚环境标记（其余子项右侧留空）')
  const mark = marks[0]
  const envRow = find(tree, (node) => node.type === 'button' && node.props?.title === zhCN.moduleEnvMarkBad)
  assert.ok(find(envRow, (node) => node === mark), '那枚标记必须长在「环境信息」那一行里')
  assert.equal(mark.props.className.includes(WORKBENCH_CLASSES.sideEntryMarkBad), true, '不通过要亮红灯')
  assert.equal(mark.props.children.type, 'svg', '不通过画的是白叹号（圆底由 CSS 画）')
  assert.equal(mark.props.children.props.strokeWidth, 3, '实心圆里的字形要加粗，1.6px 会糊成灰边')
  assert.equal(tree.props.title.includes(zhCN.moduleEnvMarkBad), true)
  // 卡头不可点（它是纯标题），所以「打开面板」只能靠子项 —— 点当前子项也算一次重新进入。
  const head = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.sideCardHead))
  assert.equal(head.props.onClick, undefined)
  assert.equal(opened, 0, '渲染本身不该打开任何东西')
  // 环境不通过时点「报告审核」：**不进入**那一页，落到环境页并记下 pendingTarget。
  // （门禁上提到统一导航层之后的行为；能不能恢复由 client-module-gate.test.mjs 逐条钉住。）
  const auditRow = find(tree, (node) => node.type === 'button' && node.props?.title === zhCN.moduleAudit)
  auditRow.props.onClick()
  assert.equal(opened, 1, '点子项要能打开面板')
  assert.equal(modules.get().active, 'env', '环境不通过就不进入目标页')
  assert.equal(modules.get().pendingTarget, 'audit', '要记下被拦的目标')
  assert.equal(modules.get().blocked, true)
  // 环境恢复之后，同一个子项点下去就真的切过去（侧栏与面板同一份状态）。
  stubOps({ env: { body: okEnvBody() } })
  await store.refresh()
  const ready = render(WorkbenchSidebarEntry, {
    store, build, modules, wide: true, onOpen: () => { opened += 1 },
  })
  const auditReady = find(ready.tree, (node) => node.type === 'button' && node.props?.title === zhCN.moduleAudit)
  auditReady.props.onClick()
  assert.equal(modules.get().active, 'audit', '环境就绪后点子项要真的把模块切过去')
  // 再点一次同一个子项：仍然要打开面板（用户从别的页面回到工作台就靠这一下）。
  const auditRowAgain = find(ready.tree, (node) => node.type === 'button' && node.props?.title === zhCN.moduleAudit)
  auditRowAgain.props.onClick()
  assert.equal(opened, 3, '点当前子项也要把面板叫出来')

  // 换成通过的结果：同一枚标记变成绿勾（用户要的就是「通过就在后面打个绿色的 check」）。
  stubOps({ env: { body: okEnvBody() } })
  await store.refresh()
  const green = render(WorkbenchSidebarEntry, { store, build, modules, wide: true, onOpen: () => {} })
  const greenMarks = findAll(green.tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes(WORKBENCH_CLASSES.sideEntryMark))
  assert.equal(greenMarks.length, 1, '通过之后仍然只有环境那一行带标记')
  assert.equal(greenMarks[0].props.className.includes(WORKBENCH_CLASSES.sideEntryMarkOk), true)
  assert.equal(greenMarks[0].props.children.type, 'svg', '通过画的是白勾（圆底由 CSS 画）')
  assert.equal(greenMarks[0].props.children.props.strokeWidth, 3)
  assert.equal(green.tree.props.title.includes(zhCN.moduleEnvMarkOk), true)
  // 尚未自检 / 自检中都不画字形：前者是空心圈（不给结论），后者是 CSS 里那段旋转白弧。
  stubOps({ env: { body: blockedEnvBody() } })
  const busyStore = createEnvStatusStore()
  let resolveEnv = null
  globalThis.fetch = () => new Promise((done) => { resolveEnv = done })
  const pendingRefresh = busyStore.refresh()
  const busy = render(WorkbenchSidebarEntry, { store: busyStore, build, modules, wide: true, onOpen: () => {} })
  const busyMark = find(busy.tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes(WORKBENCH_CLASSES.sideEntryMark))
  assert.equal(busyMark.props.className.includes(WORKBENCH_CLASSES.sideEntryMarkBusy), true, '自检中亮琥珀')
  assert.equal(busyMark.props.children, null, '自检中不画字形（旋转弧在 CSS 的 ::after 上）')
  resolveEnv({ ok: true, status: 200, async json() { return okEnvBody() } })
  await pendingRefresh
  stubOps({})
  // 全新实例、没自检过 = idle：空心圈，不画字形。
  const idle = render(WorkbenchSidebarEntry, {
    store: createEnvStatusStore(), build, modules, wide: true, onOpen: () => {},
  })
  const idleMark = find(idle.tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes(WORKBENCH_CLASSES.sideEntryMark))
  assert.equal(idleMark.props.className.includes(WORKBENCH_CLASSES.sideEntryMarkIdle), true)
  assert.equal(idleMark.props.children, null, '尚未自检是空心圈，不画字形')
  // 选中的入口要有选中态。卡用**卡自己的**类（只压实描边），不用导航项那套底色 ——
  // 整块换底色在侧栏里就是一块突兀的色块（用户说「背景色不好看」）。
  const on = render(WorkbenchSidebarEntry, {
    store, build, modules, wide: true, onOpen: () => {}, usePanelInfo: () => true,
  })
  assert.equal(on.tree.props.className.includes(WORKBENCH_CLASSES.sideCardOn), true)
  assert.equal(
    on.tree.props.className.includes(WORKBENCH_CLASSES.sideEntryOn),
    false,
    '展开态的卡不该套用侧栏导航项的选中底色',
  )
  // 面板正开着 → 当前那一页才是选中行。
  assert.ok(
    find(on.tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.moduleOn)),
    '面板开着时当前模块那一行要选中',
  )
})

test('工作台面板切走之后不许再高亮：选中态只属于"面板正开着"', async () => {
  // 用户 2026-09-22 报的 bug：在左侧栏点开自己的会话之后，工作台那张卡里上一次那个子项
  // 还亮着 —— 看起来像工作台还在前台。所以选中态必须**同时**满足：面板是当前主面板 + 是当前模块。
  const { createEnvStatusStore } = await import(new URL('src/client/features/environment/status.ts', ROOT).href)
  const { WorkbenchSidebarEntry } = await import(
    new URL('src/client/features/workbench/WorkbenchSidebarEntry.tsx', ROOT).href
  )
  stubOps({ env: { body: okEnvBody() } })
  const store = createEnvStatusStore()
  await store.refresh()
  const modules = createModuleStore()
  const build = fakeBuildStore()
  const className = (node) => String(node.props?.className ?? '').split(/\s+/)
  const rows = (tree) => findAll(tree, (node) => node.type === 'button' && className(node).includes(WORKBENCH_CLASSES.module))

  modules.navigate('audit', { state: environmentStateOf(okEnvBody()) })
  // 面板切到别处（选中会话）：整张卡不选中，三行也不许有一行是选中态。
  const away = render(WorkbenchSidebarEntry, {
    store, build, modules, wide: true, onOpen: () => {}, usePanelInfo: () => false,
  })
  assert.equal(away.tree.props.className.includes(WORKBENCH_CLASSES.sideCardOn), false, '面板切走就不该是选中态')
  for (const [index, row] of rows(away.tree).entries()) {
    assert.equal(
      className(row).includes(WORKBENCH_CLASSES.moduleOn),
      false,
      `面板切走后第 ${String(index + 1)} 行不许还是选中态`,
    )
    assert.equal(row.props['aria-pressed'], false)
  }
  // 回到工作台：记忆还在（还是报告审核那一页），而且重新亮起来。
  const back = render(WorkbenchSidebarEntry, {
    store, build, modules, wide: true, onOpen: () => {}, usePanelInfo: () => true,
  })
  assert.equal(back.tree.props.className.includes(WORKBENCH_CLASSES.sideCardOn), true)
  assert.equal(className(rows(back.tree)[1]).includes(WORKBENCH_CLASSES.moduleOn), true, '回到工作台要回到原来那一页')
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

  // `degraded`（唯一来源是**可选**外部数据源未配置）也是**绿灯**：它与 `ready` 一样放行，
  // 灯与页面结论必须说同一件事，否则会出现"红点 + 基础环境已就绪"的自相矛盾。
  const degraded = okEnvBody({
    state: stateBody({
      status: 'degraded', proceed: true,
      capabilities: { global: true, auditCore: true, delivery: true, externalData: false },
      issues: [{ id: 'ifind', owner: 'user', blocking: false, scope: 'external-data', action: '配置外部数据源', message: '外部数据核查未就绪' }],
    }),
  })
  assert.equal(envLampOf({ env: degraded, busy: false, error: '', checkedAt: '' }), 'ok')

  // 参与计数的**只有必需项**：包(1) + 平台(1) + 工作空间(1) + 授权(1)
  // + 氚云(1) + 钉钉(1) + OSS(1) = 7。
  // （DSH 自带运行时自 2026-09-29 起不在环境自检里；iFinD 自 2026-09-30 起是**可选数据源**，
  // 所以它不在分母里 —— 这正是"基础环境已就绪"与"N/N 通过"必须同时成立的原因。）
  const tally = envTally(okEnvBody())
  assert.equal(tally.total, 7)
  assert.equal(tally.passed, 7)
  assert.equal(tally.ratio, 1)
  const partial = envTally(blockedEnvBody())
  assert.equal(partial.passed, 6, '工作空间那一项没过（iFinD 是可选数据源，不参与扣分）')
  assert.equal(partial.total, 7)
  assert.equal(envTally(null).ratio, 0)
})

/** 环境自检页的公共 props（直接渲染这一页，不走外壳）。 */
function envPaneProps(env, patch = {}) {
  return {
    env,
    build: {
      ok: true, error: '', rev: 'pkg-0.0.10', version: '0.0.10', buildKind: 'installed',
      builtAt: '2026-09-27T10:00:00.000Z', protocol: 15, parentSessionId: 'p1',
    },
    error: '', busy: false, checkedAt: '2026-09-20T10:00:00.000Z',
    onRefresh: () => {},
    onRelogin: () => {}, onDwsLogin: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    ...patch,
  }
}

test('账号连接只读取、检查已有凭据：没有内置浏览器登录、没有二维码、没有设备码', async () => {
  // §8「登录」清单 1~4：页面不存在氚云内置浏览器登录按钮 / 不存在钉钉设备码按钮 /
  // DSH 不打开内置浏览器 Tab / 不生成二维码或设备码。四条一起用两种判据钉住：
  // ① 相关**模块文件**已经删掉（没有 Tab、没有二维码渲染器、也没有内置浏览器优先的打开器）；
  // ② 面板上没有任何带这些字样的按钮，正文里也不出现"设备码 / 内置浏览器"这类承诺。
  for (const gone of [
    'src/client/features/environment/H3yunBrowserLogin.tsx',
    'src/client/features/environment/login-browser.ts',
    'src/client/features/environment/DwsLoginCard.tsx',
    'src/client/features/environment/open-url.ts',
  ]) {
    assert.equal(existsSync(new URL(gone, ROOT)), false, `${gone} 必须已被删除（DSH 不再提供内置登录）`)
  }

  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const tree = render(EnvironmentPane, envPaneProps(okEnvBody())).tree
  const text = textOf(tree)
  // 账号连接是默认停在的那一步吗？不一定（就绪时停在最后一步），所以显式点开它。
  findStep(tree, 'accounts').props.onClick()
  const accounts = rerender(EnvironmentPane, envPaneProps(okEnvBody()))
  const accountsText = textOf(accounts)
  // 被删掉的是「提供」那些能力的具体承诺（§3 点名的句子），**不是**"DSH 不提供…"这句免责说明 ——
  // 后者正是推荐文案（员工要知道为什么点不到二维码 / 设备码）。
  for (const forbidden of [
    '在内置浏览器里扫码登录', '准备内置浏览器', '请用钉钉扫描二维码', '已绑定氚云会话',
    '内置浏览器登录未完成', '用设备码登录', '复制设备码', '等待浏览器授权',
  ]) {
    assert.equal(accountsText.includes(forbidden), false, `账号连接里不许再出现「${forbidden}」`)
  }
  const labels = findAll(accounts, (node) => node.type === 'button')
    .map((node) => String(node.props?.label ?? '') + textOf(node))
  for (const label of labels) {
    assert.equal(/用设备码登录|设备码登录|在内置浏览器里扫码/.test(label), false, `按钮文案「${label}」不许提设备码 / 内置浏览器登录`)
  }
  // 兼容路径仍在：走本机 CLI（打开**系统浏览器**）的两颗按钮 + 说明。
  assert.ok(findButtonLike(accounts, zhCN.envLoginH3yun), '氚云登录按钮仍在（走本机 CLI）')
  assert.ok(findButtonLike(accounts, zhCN.dwsLogin), '钉钉登录按钮仍在（走本机 CLI）')
  assert.equal(accountsText.includes(zhCN.envLoginNoBuiltinBrowser), true, '要明说 DSH 不提供内置浏览器扫码登录')
  assert.equal(accountsText.includes(zhCN.envDwsLoginNoDeviceCode), true, '要明说 DSH 不提供设备码登录')
  assert.equal(text.includes(zhCN.loadingEnv), false)
})

test('可选步骤（同花顺）未配置时只说「未配置」，芯片不报红', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const props = envPaneProps(okEnvBody({
    external: externalOk({
      path: '/cfg.json', ok: false, state: 'unconfigured', dataVerified: false,
      dataTool: '', dataSample: '', reason: '还没有配置外部数据源', tokenLength: 0, checkedAt: '',
    }),
    state: stateBody({
      userSetup: { ...stateBody().userSetup, ifind: { state: 'unconfigured', value: '', reason: '', required: false } },
    }),
  }))
  const tree = render(EnvironmentPane, props).tree
  findStep(tree, 'ifind').props.onClick()
  const step = rerender(EnvironmentPane, props)
  const text = textOf(step)
  // 状态就是说「未配置」（不堆别的说法）。
  assert.equal(text.includes(zhCN.envIfindStateUnconfigured), true, '直接显示「未配置」')
  // 可选步骤的芯片**不报红**（红 = 必须处理）。
  const chips = findAll(step, (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.chip))
  assert.ok(chips.length > 0, '步骤标题旁要有状态芯片')
  for (const chip of chips) {
    assert.equal(
      String(chip.props.className).includes(WORKBENCH_CLASSES.chipBad),
      false,
      `可选步骤不该出现红色芯片：${textOf(chip)}`,
    )
  }
})

test('Windows 上提醒"以管理员身份运行"；其它平台不提醒', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  // 钉钉 CLI（dws）在 Windows 上要碰 <HOME>\.dws 的登录态与锁文件，权限不足时登录一直不成功。
  // 提醒挂在**账号连接**这一步（钉钉登录态就在那里），所以要看那一步的正文。
  const winProps = envPaneProps(okEnvBody({ platform: 'win32-x64' }))
  const winTree = render(EnvironmentPane, winProps).tree
  findStep(winTree, 'accounts').props.onClick()
  const winStep = rerender(EnvironmentPane, winProps)
  assert.equal(
    findAll(winStep, (node) => node.props?.['data-crwu-env-windows-admin'] !== undefined).length,
    1,
    'Windows 上账号连接那一步要有一条提醒',
  )
  const winText = textOf(winStep)
  assert.equal(winText.includes(zhCN.envWindowsAdminHint), true, '要有那句可执行的提醒')
  assert.match(zhCN.envWindowsAdminHint, /管理员/, '提醒必须说清"以管理员身份运行"')
  assert.match(zhCN.envWindowsAdminHint, /钉钉/, '提醒必须说清是为了钉钉 CLI')

  // 非 Windows：一个字都不提（避免无意义的噪音）。
  const macProps = envPaneProps(okEnvBody())
  const macTree = render(EnvironmentPane, macProps).tree
  findStep(macTree, 'accounts').props.onClick()
  const macStep = rerender(EnvironmentPane, macProps)
  assert.equal(
    findAll(macStep, (node) => node.props?.['data-crwu-env-windows-admin'] !== undefined).length,
    0,
    '非 Windows 不出现这条提醒',
  )
  assert.equal(textOf(macStep).includes(zhCN.envWindowsAdminHint), false)
})

test('环境页主区只有员工要处理的事：状态摘要 + 步骤工作区 + 折叠的开发者诊断', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const paneProps = envPaneProps(okEnvBody())
  const { tree } = render(EnvironmentPane, paneProps)
  const text = textOf(tree)
  for (const expected of [
    zhCN.envStatusReady,           // 顶部紧凑状态摘要
    zhCN.envStepAccounts,          // 三步导航（顺序固定，不按状态重排）
    zhCN.envStepOss,
    zhCN.envStepWorkspace,
    zhCN.envStepDone,              // 每一步的状态词
    zhCN.envGroupMaintenance,      // 开发者诊断（默认收起）
    zhCN.envStatusProceedHint,     // 就绪时唯一一句"接下来去哪"
    '/cases/a',                    // 四项都完成 → 默认停在最后一步（工作空间）
  ]) assert.equal(text.includes(expected), true, `环境页缺了「${expected}」`)
  // 摘要态也要能更换工作空间（用户要换的时候不用先猜怎么展开）。
  assert.equal(text.includes(zhCN.wsChange), true)
  // 一次只有**一个**步骤正文：别的步骤的卡片 / 表单不在页面上（旧版是全部平铺）。
  assert.equal(
    findAll(tree, (node) => node.props?.['data-crwu-env-step-panel'] !== undefined).length, 1,
    '一次只渲染当前步骤',
  )
  assert.equal(findAll(tree, (node) => node.props?.['data-crwu-oss-card'] !== undefined).length, 0, 'OSS 卡片不在当前步骤里')
  // iFinD 卡片随它自己那一步渲染（一次只有**一个**步骤正文）。
  assert.equal(
    findAll(tree, (node) => node.props?.['data-crwu-ifind-card'] !== undefined).length, 0,
    'iFinD 卡片不在当前步骤里（就绪时停在最后一步）',
  )
  findStep(tree, 'ifind').props.onClick()
  const ifindStep = rerender(EnvironmentPane, paneProps)
  assert.equal(
    findAll(ifindStep, (node) => node.props?.['data-crwu-ifind-card'] !== undefined).length, 1,
    '切到 iFinD 那一步才渲染它的卡片',
  )
  assert.equal(text.includes(zhCN.envConsentTitle), false, '账号连接的正文也不常驻')
  // 三项都完成：一句完成摘要（而不是"还需完成 0 项"）。
  assert.equal(findAll(tree, (node) => node.props?.['data-crwu-env-alldone'] !== undefined).length, 1, '三项都完成要给一句完成摘要')
  assert.equal(text.includes(zhCN.envStepDoneSummary), true)
  // 顶部只允许**一枚**主动作：重新检查。**没有**「进入报告审核」按钮 ——
  // 就绪时只写一句提示（跳转交给左侧栏的统一导航门禁）。
  assert.equal(countButtonsLike(tree, zhCN.envActionRecheck), 1, '顶部唯一主动作是重新检查')
  assert.equal(countButtonsLike(tree, '进入报告审核'), 0, '环境页不再有「进入报告审核」按钮')
  assert.equal(
    findAll(tree, (node) => node.type === 'button' && textOfAll(node).includes('报告审核')).length, 0,
    '「进入报告审核」不许被做成按钮',
  )
  // 通过率与结论自洽：只统计必需项（运行时不在其中、iFinD 是可选数据源，所以是 7/7）。
  assert.equal(text.includes('7/7'), true)
  // 技术细节默认看不到（包路径 / 清单 / 平台值都在收起的开发者诊断里）。
  for (const hidden of [zhCN.envPackagesManifest, 'darwin-arm64']) {
    assert.equal(text.includes(hidden), false, `「${hidden}」默认不该出现`)
  }

  // 切到「账号连接」：授权行 + 氚云 / 钉钉都在这一步里，上一步的正文不在页面上。
  findStep(tree, 'accounts').props.onClick()
  const accountsTree = rerender(EnvironmentPane, paneProps)
  assert.equal(
    findAll(accountsTree, (node) => node.props?.['data-crwu-env-step-panel'] !== undefined)[0].props['data-crwu-env-step-panel'],
    'accounts',
  )
  const accountsText = textOf(accountsTree)
  for (const expected of [zhCN.envConsentTitle, zhCN.envConsentDone, zhCN.envLoginH3yun, zhCN.dwsLogin]) {
    assert.equal(accountsText.includes(expected), true, `账号连接步骤缺了「${expected}」`)
  }
  assert.equal(
    findAll(accountsTree, (node) => node.props?.['data-crwu-oss-card'] !== undefined).length, 0,
    '切走之后上一步的正文不在页面上',
  )
  // 三步都完成时导航上每一步都是 done（步骤名恒定、状态跟着环境模型走）。
  for (const id of ['accounts', 'oss', 'workspace']) {
    assert.equal(stepStateOf(accountsTree, id), 'done', `三步都完成时「${id}」应当是 done`)
  }

  // 还没保存 AK 的部署：默认停在第一项未完成的步骤（OSS），那一步才画表单。
  const ossProps = envPaneProps(okEnvBody({
    state: stateBody({
      status: 'action-required', proceed: false, allOk: false,
      userSetup: { ...stateBody().userSetup, aliyunOss: { state: 'unconfigured', value: '', reason: '还没有保存 AccessKey', required: true } },
    }),
    delivery: deliveryUnsaved(),
  }))
  const ossTree = render(EnvironmentPane, ossProps).tree
  assert.equal(stepStateOf(ossTree, 'oss'), 'doing', '默认停在第一项未完成的步骤')
  assert.equal(
    findAll(ossTree, (node) => node.props?.['data-crwu-env-step-panel'] !== undefined)[0].props['data-crwu-env-step-panel'],
    'oss',
  )
  assert.equal(findAll(ossTree, (node) => node.props?.['data-crwu-oss-card'] !== undefined).length, 1)
  assert.equal(textOf(ossTree).includes(zhCN.envOssAkLabel), true)
  assert.deepEqual(collectInputs(ossTree).map((input) => input.props.name), ['crwu-oss-ak', 'crwu-oss-sk'])
})

test('工作空间就绪时压缩成摘要；缺失/失效时才展开', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const ready = textOf(render(EnvironmentPane, envPaneProps(okEnvBody())).tree)
  // 摘要里仍然给出路径与「更换」入口（用户要换的时候不需要先猜怎么展开）。
  assert.equal(ready.includes('/cases/a'), true)
  assert.ok(ready.includes(zhCN.wsChange), '摘要态也要能更换')

  const missing = textOf(render(EnvironmentPane, envPaneProps(blockedEnvBody())).tree)
  // 缺失/失效：展开完整卡片 —— 给出选已有目录 / 恢复自动识别（没有「新建目录」）。
  assert.equal(missing.includes(zhCN.wsPick), true, '没选定时要能手动选已有目录')
  assert.equal(missing.includes('新建目录'), false, '插件不再提供「新建目录并用作工作空间」')
  assert.equal(missing.includes(zhCN.wsMissingDirHint) || missing.includes(zhCN.wsMissing), true)
})

test('没就绪时：说清"还差 N 项"与怎么修，且不出现"请安装二进制/装 Python/改 PATH"', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const base = okEnvBody()
  const brokenPackage = {
    ...base,
    blocked: ['插件内置组件：插件包不完整 / 平台不受支持'],
    state: stateBody({
      status: 'system-blocked', proceed: false, allOk: false, passed: 6, total: 8,
      capabilities: { global: false, auditCore: false, delivery: false, externalData: true },
      systemHealth: { ...stateBody().systemHealth, packageIntegrity: { state: 'invalid', value: '', reason: '插件包不完整：包内缺少 dws', required: true } },
      issues: [{ id: 'package', owner: 'system', blocking: true, scope: 'global', action: '重新安装插件或联系管理员', message: '插件内置组件：插件包不完整 / 平台不受支持' }],
      blocked: ['插件内置组件：插件包不完整 / 平台不受支持'],
    }),
  }
  const paneProps = envPaneProps(brokenPackage)
  const { tree } = render(EnvironmentPane, paneProps)
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.envStatusSystem), true, '结论要明说系统故障')
  assert.equal(text.includes(zhCN.envStatusReady), false, '系统故障不能同时显示「环境就绪」')
  // 系统故障的技术原因**不进员工视野**（它不是员工能修的）：只在开发者诊断里。
  assert.equal(text.includes('插件包不完整'), false, '员工页不出现包内组件故障的技术细节')
  assert.equal(text.includes('插件内置组件'), false, '旧的 blocked[] 文案也不许再画到页面上')
  // 系统故障**不给员工派活**：没有"下一步：装点什么"。
  assert.equal(/请安装\s*(crwu|dws|ossutil)/i.test(text), false, '不该提示员工安装这三个命令')
  assert.equal(/安装系统 ?Python|export PATH|command -v/i.test(text), false, '不该提示装 Python 或改 PATH')
  // 系统故障时主动作仍然是「重新检查」（唯一动作），不是"复制安装提示词"。
  assert.ok(findButtonLike(tree, zhCN.envActionRecheck), '系统故障时主动作是重新检查')
  // 技术原因在「开发者诊断」里能看到（默认收起，展开一次即可）。
  expandMaintenance(tree)
  const expanded = textOf(rerender(EnvironmentPane, paneProps))
  assert.equal(expanded.includes('插件包不完整'), true, '系统故障的技术原因要在开发者诊断里可查')
})

test('开发者诊断默认收起：包内组件 / 平台 / Tool 可见性 + 技术细节都在里面', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const paneProps = envPaneProps(okEnvBody())
  const collapsed = render(EnvironmentPane, paneProps)
  const collapsedText = textOf(collapsed.tree)
  for (const hidden of [zhCN.envDiagToolsOk, zhCN.envPackagesManifest, zhCN.envRuntimeExpect, zhCN.envRuntimeDistributions]) {
    assert.equal(collapsedText.includes(hidden), false, `「${hidden}」默认不该出现`)
  }
  expandMaintenance(collapsed.tree)
  const text = textOf(rerender(EnvironmentPane, paneProps))
  for (const expected of [
    zhCN.envDiagPackages, zhCN.envDiagPlatform, zhCN.envDiagTools,
    // 包路径、清单与字节数这些技术细节也只在开发者诊断里。
    // （DSH 自带运行时自 2026-09-29 起不再出现在环境自检里，相关行已移除。）
    '/Users/x/.dsh/plugins/dsh-crwu-workbench',
    zhCN.envPackagesManifest,
    zhCN.envPackagesSize,
    zhCN.envConfigSource,
  ]) assert.equal(text.includes(expected), true, `开发者诊断里缺了「${expected}」`)
})

test('开发者诊断入口使用 SVG 图标，且不再向员工解释内部检查项', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const paneProps = envPaneProps(okEnvBody())
  const collapsed = render(EnvironmentPane, paneProps)
  const head = find(collapsed.tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.detailsHead))

  assert.ok(head, '环境信息页要保留默认收起的开发者诊断入口')
  assert.equal(textOfAll(head).includes('开发者诊断'), true, '入口应使用面向开发同学的名称')
  assert.equal(findAll(head, (node) => node.type === 'svg').length, 1, '入口标题左侧应有一枚 SVG 诊断图标')
  assert.equal(
    textOf(collapsed.tree).includes('包内组件、平台与 Tool 可见性；员工日常不需要看。'),
    false,
    '收起时不应再显示内部检查项说明',
  )

  head.props.onClick()
  const expanded = rerender(EnvironmentPane, paneProps)
  assert.equal(
    textOf(expanded).includes('包内组件、平台与 Tool 可见性；员工日常不需要看。'),
    false,
    '展开后也不应再显示内部检查项说明',
  )
})

test('开发者诊断收起时是内容区右下角的轻量入口，展开内容位于入口上方', () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = new RegExp(`${escaped}(?:\\s*,\\s*[^{}]*)?\\s*\\{([^}]*)\\}`).exec(WORKBENCH_STYLE_TEXT)
    assert.ok(hit !== null, `样式里找不到 ${selector} 规则`)
    return hit[1]
  }

  const wrapper = rule('.crwu-audit-details')
  assert.match(wrapper, /align-items:\s*flex-end/, '入口要贴内容区右侧')
  assert.doesNotMatch(wrapper, /position:\s*fixed/, '不能用悬浮定位遮挡员工表单')

  const head = rule('.crwu-audit-details-head')
  assert.match(head, /width:\s*auto/, '收起入口不再占满整行')
  assert.match(head, /border:\s*(?:0|none)/, '收起入口不再使用整行虚线框')

  const body = rule('.crwu-audit-details-body')
  assert.match(body, /align-self:\s*stretch/, '展开后的诊断数据仍占可读的完整宽度')
  assert.match(body, /order:\s*-1/, '展开内容显示在右下角入口上方')
})

test('开发者诊断下方提供可直接打开钉钉个人名片的排查入口', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const { tree } = render(EnvironmentPane, envPaneProps(okEnvBody()))
  const contact = find(tree, (node) => node.type === 'a' && textOf(node).includes(zhCN.envDeveloperContact))

  assert.ok(contact, '普通员工遇到问题时应能直接找到开发同学')
  assert.equal(contact.props.href, DEVELOPER_CONTACT_URL, '必须使用用户名片二维码中的真实钉钉链接')
  assert.equal(contact.props.target, '_blank')
  assert.match(contact.props.rel, /noopener/)
})

test('开发者诊断把全部信息放进一个大面板，并补齐插件版本与同花顺 iFinD 连接状态', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const paneProps = envPaneProps(okEnvBody())
  const rendered = render(EnvironmentPane, paneProps)
  expandMaintenance(rendered.tree)
  const expanded = rerender(EnvironmentPane, paneProps)
  const panels = findAll(expanded, (node) => node.props?.['data-crwu-developer-panel'] === '1')

  assert.equal(panels.length, 1, '所有诊断行应收进同一个大型信息面板')
  const panelText = textOf(panels[0])
  for (const expected of [
    'CRWU Workbench 版本', 'v0.0.10',
    '同花顺 iFinD 连接状态', '已连接，真实取数成功',
    zhCN.envDiagPackages, zhCN.envDiagPlatform, zhCN.envDiagTools,
    zhCN.envDiagOssTarget, zhCN.envPackagesRoot, zhCN.envConfigSource,
  ]) assert.equal(panelText.includes(expected), true, `诊断大面板缺少「${expected}」`)

  assert.ok(findButtonLike(panels[0], '复制诊断信息'), '诊断面板顶部应提供复制按钮')
})

test('复制诊断信息会复制面板里的完整可转发文本', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  let copied = ''
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (value) => { copied = value } } },
    configurable: true,
  })
  try {
    const paneProps = envPaneProps(okEnvBody())
    const rendered = render(EnvironmentPane, paneProps)
    expandMaintenance(rendered.tree)
    const expanded = rerender(EnvironmentPane, paneProps)
    const copy = findButtonLike(expanded, '复制诊断信息')
    assert.ok(copy, '展开后应有复制诊断信息按钮')
    copy.props.onClick()
    for (let i = 0; i < 4; i += 1) await settle()

    for (const expected of [
      'CRWU Workbench 版本: v0.0.10',
      '同花顺 iFinD 连接状态: 已连接，真实取数成功',
      '包内组件:', 'Tool 可见性:', 'OSS 验证目标:',
    ]) assert.equal(copied.includes(expected), true, `复制文本缺少「${expected}」`)
  } finally {
    delete globalThis.navigator
  }
})

test('同花顺 iFinD 是配置步骤里的一步（带品牌名），且**不带**必检星号', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const paneProps = envPaneProps(okEnvBody())
  const tree = render(EnvironmentPane, paneProps).tree
  const text = textOf(tree)
  // 四步都在导航里，其中 iFinD 与别的配置项并排（用户口径：不单拆一块，页面才不乱）。
  for (const title of [zhCN.envStepAccounts, zhCN.envStepOss, zhCN.envStepIfind, zhCN.envStepWorkspace]) {
    assert.equal(text.includes(title), true, `步骤导航缺了「${title}」`)
  }
  // 星号只挂在必检项上：导航里数出来的星号数 = 必检步骤数（3），iFinD 那一步没有。
  const nav = find(tree, (node) => node.props?.['data-crwu-env-stepnav'] !== undefined)
  const marks = findAll(nav, (node) => String(node.props?.className ?? '') === WORKBENCH_CLASSES.stepRequired)
  assert.equal(marks.length, 3, '只有三个基础必检项带红色星号')
  // 当前那一步的面板标题里也有一枚（必检时）—— 就绪时停在最后一步（工作空间，必检）。
  assert.equal(
    findAll(find(tree, (node) => node.props?.['data-crwu-env-step-panel'] !== undefined),
      (node) => String(node.props?.className ?? '') === WORKBENCH_CLASSES.stepRequired).length,
    1,
    '面板标题上的星号跟着当前这一步的必检与否走',
  )
  const ifindRow = findStep(tree, 'ifind')
  assert.equal(
    findAll(ifindRow, (node) => String(node.props?.className ?? '') === WORKBENCH_CLASSES.stepRequired).length,
    0,
    'iFinD 是可选外部数据源，不带星号',
  )
  for (const id of ['accounts', 'oss', 'workspace']) {
    assert.equal(
      findAll(findStep(tree, id), (node) => String(node.props?.className ?? '') === WORKBENCH_CLASSES.stepRequired).length,
      1,
      `「${id}」是必检项，要带星号`,
    )
  }
  // 点开那一步：带上同花顺品牌名与覆盖能力。
  findStep(tree, 'ifind').props.onClick()
  const ifindText = textOf(rerender(EnvironmentPane, paneProps))
  assert.equal(ifindText.includes(zhCN.envIfindCardTitle), true, '数据源卡片要带同花顺品牌名')
  assert.equal(ifindText.includes(zhCN.envIfindCoverage), true, '要列出这个数据源覆盖的能力')
})

test('a blocked self-check names the missing item and still offers the maintainer fallback', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const { tree } = render(EnvironmentPane, envPaneProps(blockedEnvBody()))
  const text = textOf(tree)
  // 顶部只给结论与条数，以及**第一条**员工能修的下一步。
  assert.match(text, new RegExp(`${zhCN.envStatusAction}1${zhCN.envStatusActionTail}`), '说清还差 1 项')
  assert.equal(text.includes(zhCN.envStatusReady), false, '有阻塞就不能显示「环境就绪」')
  assert.equal(text.includes('未找到工作空间「中瑞世联工作空间」，请手动选择'), true)
  // 「进入报告审核」不再是环境页上的按钮（跳转交给左侧栏的统一导航门禁），
  // 安装提示词那条兜底路径也已整体删除。
  assert.equal(countButtonsLike(tree, '进入报告审核'), 0)
  assert.equal(
    findAll(tree, (node) => node.type === 'button' && textOfAll(node).includes('进入报告审核')).length, 0,
    '环境页不许把「进入报告审核」做成按钮',
  )
  assert.equal(text.includes('安装提示词'), false, '旧的「复制安装提示词」兜底不该再出现')
  assert.equal(countButtonsLike(tree, zhCN.envActionRecheck) >= 1, true, '主动作是重新检查')
  // 开发者兜底（默认收起的诊断区）仍在同一页上。
  assert.ok(
    find(tree, (node) => node.type === 'button' && textOf(node).includes(zhCN.envGroupMaintenance)),
    '开发者兜底入口要留着（默认收起）',
  )
})

test('侧栏分组卡上的子项就是模块切换：报告审核 ⇄ 环境信息', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const services = fakeServices()
  const { tree, modules } = await mountChecked(services)
  assert.equal(textOf(tree).includes(zhCN.tabPending), true, '通过之后面板停在报告审核页')

  // 侧栏子项点下去写的就是这个 store（那条断言在上面的侧栏卡测试里），
  // 这里验另一半：store 一改，面板就停在对应的那一页。
  modules.navigate('env', { state: environmentStateOf(okEnvBody()) })
  const after = rerender(WorkbenchPanel, { services, modules })
  // 环境页的四个步骤名在左侧导航上**恒定可见**（不随状态重排）。
  assert.equal(textOf(after).includes(zhCN.envStepAccounts), true, '切到环境信息要看到步骤导航')
  assert.equal(textOf(after).includes(zhCN.envStepWorkspace), true)
  assert.equal(textOf(after).includes(zhCN.tabPending), false)

  // 再切回报告审核：双向的，不是一次性跳转。
  modules.navigate('audit', { state: environmentStateOf(okEnvBody()) })
  const back = rerender(WorkbenchPanel, { services, modules })
  assert.equal(textOf(back).includes(zhCN.tabPending), true)
})

test('报告评估 是 Coming Soon 页：说清是什么/将来做什么/现在能不能用/下一步去哪', async () => {
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  const services = fakeServices()
  const { modules } = await mountChecked(services)

  // 入口在侧栏分组卡上（那里是一枚「开发中」小图标，见侧栏卡那条测试）；这里只验面板这一页。
  modules.navigate('eval', { state: environmentStateOf(okEnvBody()) })
  const after = rerender(WorkbenchPanel, { services, modules })
  const pane = find(after, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.eval))
  assert.ok(pane, 'Coming Soon 页的容器要在')
  const paneText = textOf(pane)
  // 四件事，缺一不可（用户 2026-09-22 重新设计的验收口径）。
  assert.ok(paneText.includes(zhCN.evalTitle), '要有模块名（开发中不是标题，是状态）')
  assert.ok(paneText.includes(zhCN.evalSubtitle), '要有一句"它将来做什么"')
  assert.ok(paneText.includes(zhCN.evalDesc), '要有一段最短说明')
  assert.ok(paneText.includes(zhCN.evalStatus), '要用状态字样说明现在能不能用')
  assert.ok(paneText.includes(zhCN.evalAvailableLead) && paneText.includes(zhCN.evalGoAudit), '要告诉用户下一步去哪')
  // 状态是一枚圆点 + 文字，不是可点的按钮、也不是大胶囊。
  const link = find(pane, (node) => node.type === 'button')
  assert.ok(link, '要有去「报告审核」的动作')
  assert.equal(textOf(link).includes(zhCN.evalStatus), false, '「开发中」不能被做进按钮里')
  // 不编功能清单、不编进度、不写营销语（业务定义还没定）。
  assert.equal(find(pane, (node) => node.type === 'ul'), null, '不要列功能清单')
  for (const banned of ['敬请期待', '重磅', '赋能', '智能驱动', '%', '进度']) {
    assert.equal(paneText.includes(banned), false, `不该出现「${banned}」`)
  }
  // 占位页不画报告列表、也不画环境四层：它是第三种状态，别让人误会。
  const text = textOf(after)
  assert.equal(text.includes(zhCN.tabPending), false)
  assert.equal(text.includes(zhCN.envLayerPackages), false)
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
    // 默认"审核记录已就绪"：绝大多数用例关心的是列表本身，不是首个 loading 门禁；
    // 门禁那一条用例显式传 auditsReady: false（见"审核记录没回来先不画行"）。
    auditsReady: true,
    tasks: [], audits: {}, ossIndex: {}, ossIndexError: '', ossLoading: false, formName: '',
    query: '', page: 1, pageSize: 20, total: 0, filterMode: '', activeKey: '',
    escalateAvailable: false, handoff: null, notice: '', childAliveHint: '',
    cloudSearchSeqNo: '', cloudSearchItems: [], cloudSearchError: '', cloudSearchBusy: false, cloudSearchDone: false,
    ...(patch.state ?? {}),
  }
  return {
    state,
    gating: { canDispatch: true, canStart: true, ...(patch.gating ?? {}) },
    onSearch: () => {}, onGoPage: (page) => { patch.onGoPage?.(page) }, onRefreshPending: () => {}, onRefreshCloud: () => {},
    onStart: () => {}, onStop: () => {}, onRetryUpload: () => {},
    onOpenCloud: () => {}, onOpenLocalHtml: () => {}, onOpenSession: () => {},
    onOpenAuditInfo: () => {}, onOpenPath: () => {}, onEscalateRetry: () => {},
    onOpenCloud: (key) => { patch.onOpenCloud?.(key) },
    onSearchCloud: (seqNo) => { patch.onSearchCloud?.(seqNo) },
    // 「AI 审核结果分析会话」读审核摘要的门面（默认返回空摘要，用例按需覆盖）。
    onLoadAuditInfo: (key, cloud) => patch.onLoadAuditInfo?.(key, cloud) ?? Promise.resolve({ info: null, error: '' }),
    onClearCloudSearch: () => { patch.onClearCloudSearch?.() },
    handoffCopied: false, onHandoffCopied: () => {},
    // 右侧 AI 讨论面板要的两样：环境里选中的工作空间 + 会话服务。这里给一个空 port：
    // 面板会走「找不到会话就先不建」的分支 —— 建会话只发生在真的发第一句时。
    workspace: { id: 'ws-1', path: '/ws/中瑞世联工作空间' },
    port: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    onOpenDiscussion: () => {},
  }
}

test('点小鲸鱼：没有绑定会话时，用 crwu 拉完文件就直接进新对话（上下文一起注入）', async () => {
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const task = {
    name: '2026-302441-LX9967-BG8790', project: '华润万家拟处置房地产项目', business: '', risk: 'B',
    reviewLevel: '初审', reviewState: '审核中', currentNode: '一级复核人',
    seqNo: '2026-302441-LX9967-BG8790', status: '2', statusName: '',
    modifiedAt: '2026-09-22 18:15:08', id: '5f6924e2-f722-4477-9d34-d52aa855a1ad', idTail: 'a855a1ad',
  }
  // 拉到的三组文件（形状抄真实的 `report-files` 回包）。
  const ops = stubOps({
    'report-files': {
      body: {
        ok: true, error: '', seqNo: task.seqNo,
        h3yun: [{ field: 'F0000143', fileId: 'f1', name: 'V2定稿-估值报告.zip', size: 78761669, contentType: 'application/zip' }],
        h3yunError: '',
        oss: [{ key: 'k1', name: '审核意见.html' }],
        local: [{ name: '说明.md', path: '/ws/seq/说明.md', size: 2048 }],
        localDir: '/ws/seq', localExists: true, truncated: false,
      },
    },
  })
  const made = { created: [], renamed: [], prompted: [], opened: [] }
  const port = {
    create: async (input) => { made.created.push(input); return 'session-new' },
    open: (id) => { made.opened.push(id) },
    binding: () => ({
      session: {
        rename: async (title) => { made.renamed.push(title) },
        prompt: async (content, mode) => { made.prompted.push({ content, mode }) },
      },
    }),
    list: { getSnapshot: () => ({ ids: [], byId: {} }) },
  }
  const opened = []
  const props = reportPaneProps({ state: { tasks: [task], total: 1, formName: '报告审核' } })
  const view = render(ReportPane, { ...props, port, onOpenDiscussion: (id) => { opened.push(id) } })
  const button = find(
    view.tree,
    (node) => node.type === 'button'
      && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn),
  )
  assert.ok(button, '操作列要有那枚小鲸鱼')
  button.props.onClick({ clientX: 40, clientY: 60 })
  await settle()
  // 拉的是 crwu 的 report-files（带上氚云记录 id），**不是**自己扫目录
  assert.ok(ops.includes('report-files'))
  // 建了会话、按流水号命名、把上下文（角色 + 三组文件）注进去，然后跳到那条会话
  assert.deepEqual(made.created, [{ workspaceId: 'ws-1' }])
  assert.deepEqual(made.renamed, [zhCN.aiSessionPrefix + task.seqNo])
  assert.equal(made.prompted.length, 1)
  const sent = made.prompted[0].content[0].text
  assert.ok(sent.includes('你是一名资深资产评估师'), '要注入专业版协作 Prompt')
  assert.ok(sent.includes('共同发现问题'), 'Prompt 正文要完整注入')
  assert.ok(sent.includes('V2定稿-估值报告.zip'), '氚云附件要进上下文')
  // 用户 2026-09-23 强制口径：报告业务会话**只允许远端资料** —— 本地案例目录的内容不进上下文。
  assert.equal(sent.includes('/ws/seq/说明.md'), false, '本地文件不得进入上下文')
  assert.equal(sent.includes('/ws/seq'), false, '本地路径不得出现在上下文里')
  assert.equal(sent.includes('本地案例目录'), false)
  assert.ok(sent.includes('审核意见.html'), '云端交付件也要进上下文')
  assert.deepEqual(opened, ['session-new'], '拉完直接跳到新对话')
})

test('点小鲸鱼：已有会话时弹选择 Dialog（续聊不重拉文件），不直接建', async () => {
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const task = {
    name: 'S-1', project: 'P', business: '', risk: 'C', reviewLevel: '初审', reviewState: '审核中',
    currentNode: '', seqNo: 'S-1', status: '2', statusName: '', modifiedAt: '', id: 'o-1', idTail: 'a1',
  }
  const ops = stubOps({ 'report-files': { body: { ok: true, error: '', seqNo: 'S-1', h3yun: [], h3yunError: '', oss: [], local: [], localDir: '', localExists: false, truncated: false } } })
  const made = { created: [], opened: [] }
  const old = { id: 'session-old', displayTitle: zhCN.aiSessionPrefix + 'S-1' }
  const port = {
    create: async (input) => { made.created.push(input); return 'session-new' },
    open: (id) => { made.opened.push(id) },
    binding: () => ({ session: { rename: async () => undefined, prompt: async () => undefined } }),
    list: { getSnapshot: () => ({ ids: [old.id], byId: { [old.id]: old } }) },
  }
  const opened = []
  const props = reportPaneProps({ state: { tasks: [task], total: 1, formName: '报告审核' } })
  const view = render(ReportPane, { ...props, port, onOpenDiscussion: (id) => { opened.push(id) } })
  const button = find(
    view.tree,
    (node) => node.type === 'button'
      && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn),
  )
  button.props.onClick()
  await settle()
  const asked = rerender(ReportPane, { ...props, port, onOpenDiscussion: (id) => { opened.push(id) } })
  assert.ok(findByClass(asked, WORKBENCH_CLASSES.aiDialog), '要弹选择 Dialog')
  assert.deepEqual(made.created, [], '问清楚之前不许建会话')
  // 续聊路径**不许**重新拉文件（用户口径：不要重新拉取报告文件、不要重新读 OSS）。
  assert.deepEqual(
    ops.filter((op) => op === 'report-files'), [],
    '弹选择 Dialog 这一步不该发起 report-files',
  )
  const text = textOf(findByClass(asked, WORKBENCH_CLASSES.aiDialog))
  assert.ok(text.includes(zhCN.aiNewChat) && text.includes(zhCN.aiContinue), '两个选项都要给')
  assert.ok(text.includes(zhCN.aiContinueHint) && text.includes(zhCN.aiNewHint), '两个选项都要有说明')
  // 选「继续上次聊天」→ 打开那条已有会话，不新建
  const continueButton = findAll(asked, (node) => node.type === 'button')
    .find((node) => textOf(node).includes(zhCN.aiContinue))
  assert.ok(continueButton, '要有「继续上次聊天」按钮')
  continueButton.props.onClick()
  await settle()
  assert.deepEqual(made.created, [], '继续不该新建')
  assert.deepEqual(opened, ['session-old'])
})


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
  // 用户 2026-09-22 口径：分页行右下角**不再挂**一条「正在加载…」——
  // 顶部不确定进度条 + 列表压暗已经说明了状态，再挂一行只是噪音。
  assert.equal(textOf(busy.tree).includes(zhCN.loadingList), false, '分页行不该再出现加载文案')

  const idle = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  assert.equal(hasClass(idle.tree, WORKBENCH_CLASSES.loadBar), false, '不在加载时不该有进度条')
  assert.equal(hasClass(idle.tree, WORKBENCH_CLASSES.dim), false)
})

test('the self-check page draws a progress bar and dims the body while re-checking', async () => {
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const props = {
    error: '', checkedAt: '', onRefresh: () => {},
    onRelogin: () => {}, onDwsLogin: () => {},
    services: fakeServices(), wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
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
    boot: { body: bootOk() },
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

    // 「查看审核信息」已移进 ••• 菜单，而菜单渲染在**列表层的浮层**里（表格之外）。
    // 这一条验的是浮层契约本身；**读取 JSON 并渲染摘要**（项目编号/问题总数/结论/阶段）
    // 由真机验收里的「审核信息抽屉」那一段覆盖（读的是真实 OSS 对象）。
    //
    // 为什么另起一个直接渲染 ReportPane 的场景：注入式渲染器里，**嵌套组件每次渲染都会拿到
    // 全新的实例**（见 tests/helpers/tsx-loader.mjs 的 resolve：函数组件各自新建 instance），
    // 所以只有顶层组件的 state 能跨 rerender 存活。ReportPane 作为顶层渲染时，
    // ••• 的开关状态才保得住。
    const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
    const called = []
    // reportPaneProps 里的 onOpenAuditInfo 是固定空函数，这里在返回对象上再覆盖一次。
    const pane = {
      ...reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1, ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } } }),
      onOpenAuditInfo: (key, cloud) => { called.push({ key, cloud }) },
    }
    const first = render(ReportPane, pane)
    const menuButton = find(first.tree, (node) => node.type === 'button'
      && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.menu))
    assert.ok(menuButton, '这一行要有 ••• 菜单按钮')
    assert.equal(String(menuButton.props['aria-haspopup']), 'menu', '••• 要声明它弹出菜单')
    assert.equal(menuButton.props['aria-expanded'], false)
    // ••• 是 **Ghost Icon Button**（用户 2026-09-23 口径：透明底、悬停 `#F0F1F3`、打开 `#EDEEF0`）。
    // 与主操作共用实心变体那条旧口径已撤：一屏里只允许一处实心，••• 不该是第二处实心。
    const menuClasses = String(menuButton.props.className).split(/\s+/)
    assert.ok(menuClasses.includes(WORKBENCH_CLASSES.menu), '••• 要有自己的几何类')
    assert.equal(menuClasses.includes(WORKBENCH_CLASSES.btn), false, '••• 不该再复用按钮基类')
    assert.equal(menuClasses.includes(WORKBENCH_CLASSES.btnPrimary), false, '••• 不该再是实心主按钮')

    menuButton.props.onClick()
    const withMenu = rerender(ReportPane, pane)
    assert.ok(findByClass(withMenu, WORKBENCH_CLASSES.floatMenu), '点 ••• 要出现浮层菜单')
    // **浮层不在工作台大框里**：它在表格之外（position: fixed + rect），所以表格的
    // 横向滚动容器裁不到它 —— 这就是本轮要修的那条真缺陷的回归断言。
    assert.equal(
      textOf(findByClass(withMenu, WORKBENCH_CLASSES.surface)).includes('查看审核信息'),
      false,
      '菜单不能渲染进表格/工作台大框内部（否则会被 overflow 裁掉）',
    )
    const entry = findButtonLike(withMenu, '查看审核信息')
    assert.ok(entry, '浮层里要有「查看审核信息」')
    entry.props.onClick()
    assert.equal(called.length, 1, '点菜单项要派发一次')
    assert.equal(called[0].key, PENDING_TASK.seqNo, '派发的必须是这一行的 key')
    assert.equal(called[0].cloud.htmlKey, PENDING_CLOUD.htmlKey, '要把这一行的云端件一起给出去')
    // 点完就收菜单（不要执行完还留着）。
    assert.equal(findByClass(rerender(ReportPane, pane), WORKBENCH_CLASSES.floatMenu), null, '点完要自动收菜单')

  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

// ── 按流水号查云端交付件（AI 审核页的搜索框）─────────────────────────────────

const CLOUD_SEQ = '2026-301705-LX10170-BG8746'

/**
 * 切到「AI审核结果」标签：`view` 是组件本地状态（hook #1）。
 * 注意 `rerender` 返回的就是树本身（不是 `{ tree }`）—— 这里踩过一次。
 */
function openResults(Component, props, instance) {
  instance.state[1] = 'results'
  instance.cursor = 0
  return rerender(Component, props)
}

/** 找「按流水号查找」的输入框（按 aria-label 认，别用 placeholder —— 两个列表的 placeholder 相同）。 */
function findCloudSearchInput(tree) {
  return find(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === zhCN.cloudSearchAria)
}

/** 在搜索框里按 Enter（新口径：**没有「查找」按钮**，Enter 才发起查询）。 */
function submitSearchInput(input) {
  input.props.onKeyDown({ key: 'Enter' })
}

test('按流水号查找：搜索框只在「AI审核列表」页里，报告列表页没有', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const props = reportPaneProps({})
  const { tree, instance } = render(ReportPane, props)
  assert.equal(findCloudSearchInput(tree), null, '「报告列表」页里不该有按流水号查交付件的搜索框')
  const results = openResults(ReportPane, props, instance)
  assert.ok(findCloudSearchInput(results), '「AI审核列表」页里要有按流水号查交付件的搜索框')
})

test('按流水号查找：输入过程不发请求，按 Enter 才把流水号交给 Host', async () => {
  const posts = []
  globalThis.fetch = async (url, init) => {
    posts.push(JSON.parse(init.body))
    return { ok: true, status: 200, async json() { return { ok: true, error: '', bucket: 'b', prefix: '', count: 0, items: {}, truncated: false } } }
  }
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const searched = []
  const props = reportPaneProps({ onSearchCloud: (seqNo) => { searched.push(seqNo) } })
  const { instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  // 切标签本身不得列举 OSS（页面第一条约束）。
  assert.deepEqual(posts, [], '切到结果页不发请求')
  assert.deepEqual(searched, [], '切到结果页不触发查找')

  // 打字（改组件本地 state）不得发请求 —— 防抖自动查会变成反复扫 OSS。
  instance.state[2] = CLOUD_SEQ
  instance.cursor = 0
  const typed = rerender(ReportPane, props)
  assert.deepEqual(posts, [], '输入过程不发请求')
  assert.deepEqual(searched, [], '输入过程不触发查找')

  submitSearchInput(findCloudSearchInput(typed))
  assert.deepEqual(searched, [CLOUD_SEQ], '按 Enter 才把流水号交给 Host')
})

test('按流水号查找：命中就只列该流水号的交付件与「查看报告」，交付件按业务语义呈现', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const item = {
    seqNo: CLOUD_SEQ,
    files: [{ key: `crwu/audit/${CLOUD_SEQ}/审核意见.${CLOUD_SEQ}.html`, name: `审核意见.${CLOUD_SEQ}.html` }],
    htmlKey: `crwu/audit/${CLOUD_SEQ}/审核意见.${CLOUD_SEQ}.html`,
    jsonKey: `crwu/audit/${CLOUD_SEQ}/审核结果.${CLOUD_SEQ}.json`,
  }
  let opened = ''
  const props = reportPaneProps({
    state: { cloudSearchSeqNo: CLOUD_SEQ, cloudSearchItems: [item], cloudSearchDone: true },
    onOpenCloud: (key) => { opened = key },
  })
  const { instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  const text = textOf(results)
  // 用户 2026-09-23 口径：普通员工不需要看到 OSS 原始路径（crwu/audit/... .html）。
  assert.equal(text.includes(item.htmlKey), false, '不该把 OSS 原始对象 key 端到列表上')
  assert.equal(text.includes('crwu/audit'), false, '不该出现 OSS 前缀')
  // 只讲业务语义：N 个交付件 + 「审核报告 / 审核数据」两枚轻量 Chip。
  assert.equal(text.includes(zhCN.resultFileReport), true, '要显示「审核报告」')
  assert.equal(text.includes(zhCN.resultFileData), true, '要显示「审核数据」')
  assert.equal(text.includes(zhCN.resultFilesCount.replace('%s', '2')), true, '要显示交付件数量')
  assert.equal(text.includes(CLOUD_SEQ), true, '要写清是哪个流水号')
  const open = findButtonLike(results, zhCN.openReport)
  assert.ok(open, '命中时要有「查看报告」')
  open.props.onClick()
  assert.equal(opened, item.htmlKey, '打开的是命中那条的 htmlKey，不是流水号')
  assert.equal(text.includes(zhCN.cloudSearchEmpty), false, '命中时不该说"没有"')
})

test('按流水号查找：没命中就说「OSS 上没有这个流水号的交付件」', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const props = reportPaneProps({ state: { cloudSearchSeqNo: CLOUD_SEQ, cloudSearchDone: true } })
  const { instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  assert.equal(textOf(results).includes(zhCN.cloudSearchEmpty), true)
  // 没查过（done=false）时说"没有"是错的。
  const before = render(ReportPane, reportPaneProps({}))
  assert.equal(textOf(openResults(ReportPane, reportPaneProps({}), before.instance)).includes(zhCN.cloudSearchEmpty), false, '还没查过不能说"没有"')
})

test('按流水号查找：视图切换上的计数跟着**正在显示的那一份**走', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const other = {
    seqNo: '2026-301705-LX10170-BG8000',
    files: [],
    htmlKey: 'crwu/audit/2026-301705-LX10170-BG8000/审核意见.html',
    jsonKey: '',
  }
  const hit = {
    seqNo: CLOUD_SEQ,
    files: [],
    htmlKey: `crwu/audit/${CLOUD_SEQ}/审核意见.html`,
    jsonKey: '',
  }
  const full = { [other.seqNo]: other, [hit.seqNo]: hit }
  // 全量清单 2 条、搜索命中 1 条：计数显示 2 就是"空列表 + 5 项"那类自相矛盾的读数。
  const watched = reportPaneProps({
    state: { ossIndex: full, cloudSearchSeqNo: CLOUD_SEQ, cloudSearchItems: [hit], cloudSearchDone: true },
  })
  const watchedRender = render(ReportPane, watched)
  const watchedTree = openResults(ReportPane, watched, watchedRender.instance)
  // 计数现在只有一处（视图切换的页签里）：搜索命中 1 条就该显示 1，不能还写全量的 2。
  const tabCounts = findAll(watchedTree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.tabCount))
    .map((node) => textOf(node).trim())
  assert.equal(tabCounts[1], '1', `搜索命中时计数要按搜索结果算，实际 ${tabCounts.join(' / ')}`)
  // 清空（done=false）回到全量：同一个计数跟着回到 2。
  const cleared = reportPaneProps({ state: { ossIndex: full } })
  const clearedRender = render(ReportPane, cleared)
  const clearedTree = openResults(ReportPane, cleared, clearedRender.instance)
  const clearedCounts = findAll(clearedTree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.tabCount))
    .map((node) => textOf(node).trim())
  assert.equal(clearedCounts[1], '2', `回到全量时计数要是 2，实际 ${clearedCounts.join(' / ')}`)
})

test('按流水号查找：形状不对就地拦下，不发请求也不去找别的流水号', async () => {
  const searched = []
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const props = reportPaneProps({ onSearchCloud: (seqNo) => { searched.push(seqNo) } })
  const { instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  instance.state[2] = '../../other-prefix'
  instance.cursor = 0
  const typed = rerender(ReportPane, props)
  submitSearchInput(findCloudSearchInput(typed))
  const after = rerender(ReportPane, props)
  assert.deepEqual(searched, [], '非法流水号不得发请求')
  assert.equal(textOf(after).includes(zhCN.cloudSearchInvalid), true, '要给人话提示')
})

test('按流水号查找：真发出去的请求是 oss-index + seqNo（不是文本包含式假通过）', async () => {
  const calls = stubFetch([{ status: 200, body: { ok: true, error: '', bucket: 'b', prefix: '', count: 0, items: {}, truncated: false } }])
  const { workbenchApi } = await import(new URL('src/client/features/report-audit/api.ts', ROOT).href)
  await workbenchApi.ossIndex({ seqNo: CLOUD_SEQ })
  assert.equal(calls.length, 1)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.op, 'oss-index', '操作名必须是 oss-index')
  assert.deepEqual(body.args, { seqNo: CLOUD_SEQ }, '流水号必须原样发给 Host（Host 侧再校验一次是安全边界）')
})

test('分页页码窗口：总页数很多时只给首页/末页/当前页附近，中间用省略号', async () => {
  const { pageWindow } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  // 少页时全列出来，不出现省略号。
  assert.deepEqual(pageWindow(1, 5), [1, 2, 3, 4, 5])
  // 8652 条 / 20 一页 = 433 页：第 125 页时给 1 … 123 124 125 126 127 … 433。
  assert.deepEqual(pageWindow(125, 433), [1, 0, 123, 124, 125, 126, 127, 0, 433])
  // 边界：首页/末页不该多出省略号。
  assert.deepEqual(pageWindow(1, 433), [1, 2, 3, 0, 433])
  assert.deepEqual(pageWindow(433, 433), [1, 0, 431, 432, 433])
  // 越界 clamp，总页数为 0 时给空（不渲染分页）。
  assert.deepEqual(pageWindow(999, 10), pageWindow(10, 10))
  assert.deepEqual(pageWindow(1, 0), [])
})

const paneTree = (tree) => (Array.isArray(tree) ? tree : [tree])

test('审核记录没回来之前**不画行**：标签不会从「AI 审核」跳成「重新审核」', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const task = {
    name: '2026-302441-LX9967-BG8790', project: '华润万家拟处置房地产项目', business: '', risk: 'B',
    reviewLevel: '初审', reviewState: '审核中', currentNode: '一级复核人',
    seqNo: '2026-302441-LX9967-BG8790', status: '2', statusName: '',
    modifiedAt: '2026-09-22 18:15:08', id: 'o-1', idTail: 'a855a1ad',
  }
  const audit = {
    key: task.seqNo, childId: 'child-1', seqNo: task.seqNo, project: '项目', objectId: '',
    startedAt: '', parentSessionId: '', status: 'done', ended: true, stopped: false, stopReason: '',
    endReason: '', casePath: '', resultFile: '', htmlFile: '', caseName: '', uploadedAt: '',
    uploadError: '', ossPrefix: '', attempt: 1,
  }
  // ① 审核记录还没到：一行都不画（只有等待页），免得先渲染出「AI 审核」再跳变。
  const pendingAudits = render(ReportPane, reportPaneProps({
    state: { tasks: [task], total: 1, auditsReady: false },
  }))
  assert.equal(
    findAll(paneTree(pendingAudits.tree), (node) => node.type === 'tr'
      && String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.tbodyRow)).length,
    0,
    '审核记录没回来时不该先画出行来',
  )
  assert.ok(
    find(pendingAudits.tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.loadingPane)),
    '这时候列表区应该是中瑞世联等待页',
  )
  assert.equal(textOf(pendingAudits.tree).includes(zhCN.loadingReports), true)
  // 等待页**只盖列表数据区**（用户 2026-09-23 口径）：页头 / 页签 / 工具条仍然可见。
  const area = findByClass(pendingAudits.tree, WORKBENCH_CLASSES.listArea)
  assert.ok(area, '要有列表数据区容器（等待页挂在它里面）')
  assert.ok(findByClass(area, WORKBENCH_CLASSES.loadingPane), '等待页要落在列表数据区里')
  assert.ok(findByClass(pendingAudits.tree, WORKBENCH_CLASSES.tabs), '首次加载时页签仍可见')
  assert.ok(findByClass(pendingAudits.tree, WORKBENCH_CLASSES.toolbar), '首次加载时工具条仍可见')
  assert.ok(findByClass(pendingAudits.tree, WORKBENCH_CLASSES.searchWrap), '首次加载时搜索框仍可见')
  assert.ok(findByClass(pendingAudits.tree, WORKBENCH_CLASSES.pageTitle), '首次加载时页面标题仍可见')

  // ② 记录到位（这条有记录）：行画出来时主操作**已经是**「重新审核」，中间没有 AI 审核那一帧。
  const ready = render(ReportPane, reportPaneProps({
    state: { tasks: [task], total: 1, audits: { [task.seqNo]: audit }, auditsReady: true },
  }))
  // 只在**操作列**里找主操作（工具条的「刷新」也是 .crwu-audit-btn，不能误取）。
  const primary = findByClass(findByClass(ready.tree, WORKBENCH_CLASSES.tdAction), WORKBENCH_CLASSES.btn)
  assert.ok(primary, '行里要有主操作')
  assert.equal(textOf(primary).trim(), '重新审核', '有记录时第一帧就是「重新审核」')
  // 只在**操作列**里断言（页面别处本来就有「AI 审核列表」这个视图名，整页断言会假红）。
  assert.equal(
    textOf(findByClass(ready.tree, WORKBENCH_CLASSES.tdAction)).includes('AI 审核'),
    false,
    '操作列里不该再出现 AI 审核这个标签',
  )
})

test('按钮变体一律用双类选择器，不会被靠后的基础按钮样式吃掉底色', () => {
  // 用户 2026-09-22 报的缺陷：鼠标移到操作列的「AI 审核 / 重新审核」上整个按钮变全黑。
  // 根因不是颜色本身，而是选择器特异性：基础按钮 .crwu-audit-btn 是 (0,1,0)，而 §20 迁移层
  // 把它写在样式表**最后**；同特异性的单类变体 .crwu-audit-btn-primary 因此被它的
  // background/color 覆盖（主按钮退化成普通按钮），可 hover 那条变体规则特异性更高、反而生效，
  // 于是深底 + 深字 = 全黑。变体必须用双类（(0,2,0)）把顺序依赖去掉。
  const bareVariants = (WORKBENCH_STYLE_TEXT.match(/^\.crwu-audit-(?:btn-primary|btn-warn)[\s,{]/gm) ?? [])
  assert.deepEqual(bareVariants, [], `变体不能用单类选择器（会被基础按钮按顺序覆盖）：${bareVariants.join()}`)

  for (const variant of ['crwu-audit-btn-primary', 'crwu-audit-btn-warn']) {
    assert.ok(
      WORKBENCH_STYLE_TEXT.includes(`.crwu-audit-btn.${variant}`),
      `${variant} 必须写成 .crwu-audit-btn.${variant}（双类）`,
    )
  }

  // 基础按钮自己有一条 :hover:not(:disabled)（(0,2,0)），变体的 hover 必须把这条也带上，
  // 否则「悬停一个不可用/普通按钮」的那条规则会重新盖住变体。
  assert.ok(
    WORKBENCH_STYLE_TEXT.includes('.crwu-audit-btn.crwu-audit-btn-primary:hover:not(:disabled)'),
    '主按钮 hover 要显式压过基础按钮的 :hover:not(:disabled)',
  )

  // 主按钮的 hover 底色必须真的被声明（不能只有基础按钮的 hover 生效）。
  const hoverRule = /\.crwu-audit-btn\.crwu-audit-btn-primary:hover[^{]*\{([^}]*)\}/.exec(WORKBENCH_STYLE_TEXT)
  assert.ok(hoverRule !== null, '找不到主按钮 hover 规则')
  assert.match(hoverRule[1], /background\s*:/, '主按钮 hover 必须自己声明底色')
})

// ── 报告审核页 2026-09-23 视觉重构：Segmented 页签 / 工具条 / 操作列 / AI 列表语义 ──

test('页签是浅槽里的轻量 Segmented 控件，没有下划线指示条', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const { tree } = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  const track = findByClass(tree, WORKBENCH_CLASSES.tabs)
  assert.ok(track, '要有页签容器')
  const tabs = findAll(track, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.tab))
  assert.equal(tabs.length, 2, '只有两个视图：报告列表 / AI 审核列表')
  const active = tabs.filter((node) => String(node.props.className).split(/\s+/).includes(WORKBENCH_CLASSES.tabOn))
  assert.equal(active.length, 1, '同一时间只有一个选中页签（不是背景 + 下划线双重选中）')
  // 计数（8652 / 5）只出现在页签里，且两个页签各一份。
  const counts = findAll(track, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.tabCount))
  assert.equal(counts.length, 2, '两个页签各带一个计数')
  // 文字型 + 品牌色下划线那套已撤：DOM 里不该再有那枚指示条。
  assert.equal(
    findAll(tree, (node) => String(node.props?.className ?? '').includes('crwu-audit-tab-ind')).length,
    0,
    '下划线指示条应当已删除',
  )
  // 选中态靠「容器是浅槽、选中项是白片」，样式表里必须有这条槽底色。
  const tabsRule = /\.crwu-audit-tabs\s*\{([^}]*)\}/.exec(WORKBENCH_STYLE_TEXT)
  assert.ok(tabsRule !== null, '找不到页签容器规则')
  assert.match(tabsRule[1], /background:\s*var\(--crwu-tab-track\)/, '容器要有浅槽底色（Segmented 而不是纯文字页签）')
  const onRule = /\.crwu-audit-tab-on,\s*\.crwu-audit-tab-on:hover\s*\{([^}]*)\}/.exec(WORKBENCH_STYLE_TEXT)
  assert.ok(onRule !== null, '找不到选中页签规则')
  assert.match(onRule[1], /background:\s*var\(--crwu-surface\)/, '选中项要是浮起的白片')
  assert.match(onRule[1], /box-shadow:\s*var\(--crwu-shadow-tab\)/, '选中项要有一层轻投影')
})

test('列表工具条：搜索 + 刷新同属一行，刷新是 Ghost 按钮', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const busy = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 }, gating: { busy: true } }))
  const toolbar = findByClass(busy.tree, WORKBENCH_CLASSES.toolbar)
  assert.ok(toolbar, '列表工具条要在（搜索与刷新同一行）')
  const ghost = findByClass(toolbar, WORKBENCH_CLASSES.ghost)
  assert.ok(ghost, '刷新要是 Ghost 按钮')
  assert.equal(ghost.props.disabled, true, '刷新中按钮禁用（但列表保持显示）')
  assert.ok(
    String(ghost.props.className).split(/\s+/).includes(WORKBENCH_CLASSES.ghostBusy),
    '刷新中图标要转（只转图标，不清列表）',
  )
  const search = findByClass(toolbar, WORKBENCH_CLASSES.searchWrap)
  assert.ok(search, '搜索框与刷新同属工具条')
  // 刷新不在页面头：页面头里只有标题。
  const head = findByClass(busy.tree, WORKBENCH_CLASSES.pageHead)
  assert.equal(findByClass(head, WORKBENCH_CLASSES.ghost), null, '刷新不该回到页面右上角')
})

test('流水号单元格带悬停才出现的复制按钮', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const { tree } = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  const copy = findAll(tree, (node) => node.type === 'button' && node.props?.['aria-label'] === zhCN.copySeqNo)
  assert.equal(copy.length, 1, '流水号旁要有一枚复制按钮')
  // 平时不显示（opacity 0），行悬停/聚焦才浮出 —— 这条由样式表里的悬停规则保证。
  assert.match(
    WORKBENCH_STYLE_TEXT,
    /\.crwu-audit-tbody-row:hover \.crwu-audit-seq-copy[\s\S]*?\{\s*opacity:\s*1/,
    '复制图标只在行悬停时出现',
  )
})

test('操作列：没有线上报告的行走「AI 审核 + 小鲸鱼」，没有 •••', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const { tree } = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  const action = findByClass(tree, WORKBENCH_CLASSES.tdAction)
  assert.ok(findButtonLike(action, 'AI 审核'), '首次发起是 AI 审核')
  assert.ok(findByClass(action, WORKBENCH_CLASSES.aiRowBtn), '要有小鲸鱼')
  assert.equal(findByClass(action, WORKBENCH_CLASSES.menu), null, '只有一个主操作时不该出现 •••')
})

test('操作列：已有线上报告的行走「查看报告 + 小鲸鱼 + •••」', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const { tree } = render(ReportPane, reportPaneProps({
    state: { tasks: [PENDING_TASK], total: 1, ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } },
  }))
  const action = findByClass(tree, WORKBENCH_CLASSES.tdAction)
  assert.ok(findButtonLike(action, zhCN.openReport), '有线上报告时主操作是「查看报告」')
  assert.ok(findByClass(action, WORKBENCH_CLASSES.aiRowBtn), '要有小鲸鱼')
  assert.ok(findByClass(action, WORKBENCH_CLASSES.menu), '要有 •••')
  // 操作列不再出现「已出结果 / 已上云 / 未出结果」这类状态噪音。
  const actionText = textOf(action)
  for (const noise of ['已出结果', '已上云', '未出结果', '未查看会话']) {
    assert.equal(actionText.includes(noise), false, `操作列不该出现「${noise}」`)
  }
})

test('AI 审核列表一行的交付件走业务语义，••• 只放真实存在的功能', async () => {
  const { fileKindsOf, resultMenuOf } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  assert.deepEqual(fileKindsOf(PENDING_CLOUD), [zhCN.resultFileReport, zhCN.resultFileData])
  assert.deepEqual(fileKindsOf({ seqNo: 'S', files: [], htmlKey: 'a.html', jsonKey: '' }), [zhCN.resultFileReport])
  assert.deepEqual(fileKindsOf({ seqNo: 'S', files: [], htmlKey: '', jsonKey: 'a.json' }), [zhCN.resultFileData])
  // HTML + JSON 都在 → 审核信息可用；原始交付件永远可用；复制流水号永远可用。
  assert.deepEqual(resultMenuOf(PENDING_CLOUD).map((item) => item.label), [zhCN.auditInfo, zhCN.rawArtifact, zhCN.copySeqNo])
  // 只有 HTML（没有 JSON）时不给「审核信息」——抽屉里没有内容，给了就是假功能。
  assert.deepEqual(
    resultMenuOf({ seqNo: 'S', files: [], htmlKey: 'a.html', jsonKey: '' }).map((item) => item.label),
    [zhCN.rawArtifact, zhCN.copySeqNo],
  )
})

test('AI 审核列表不暴露 OSS 原始路径，空态给业务说明', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const props = reportPaneProps({ state: { ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } } })
  const { instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  const text = textOf(results)
  assert.equal(text.includes('crwu/audit'), false, '不该显示 OSS 路径')
  assert.equal(text.includes('.html'), false, '不该显示 .html 后缀')
  assert.equal(text.includes('.json'), false, '不该显示 .json 后缀')
  assert.equal(text.includes(zhCN.resultFileReport), true)
  assert.equal(text.includes(zhCN.resultFileData), true)

  const blank = render(ReportPane, reportPaneProps({}))
  const emptyText = textOf(openResults(ReportPane, reportPaneProps({}), blank.instance))
  assert.equal(emptyText.includes(zhCN.noResults), true, '空态要说明"暂无 AI 审核结果"')
  assert.equal(emptyText.includes(zhCN.noResultsHint), true, '空态要给出下一步说明')
})

test('分页支持首页 / 上一页 / 下一页 / 末页与跳页', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const goto = []
  const { tree } = render(ReportPane, reportPaneProps({
    state: { tasks: [PENDING_TASK], total: 8652, page: 125, pageSize: 20 },
    onGoPage: (page) => { goto.push(page) },
  }))
  const pager = findByClass(tree, WORKBENCH_CLASSES.pager)
  assert.ok(pager, '要有分页条')
  for (const label of [zhCN.paginationFirst, zhCN.paginationPrev, zhCN.paginationNext, zhCN.paginationLast]) {
    assert.ok(
      find(pager, (node) => node.type === 'button' && node.props?.['aria-label'] === label),
      `要有「${label}」`,
    )
  }
  // 页码窗口：1 … 123 124 125 126 127 … 433。
  const numbers = findAll(pager, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.pagerPage))
    .map((node) => textOf(node))
  assert.deepEqual(numbers, ['1', '123', '124', '125', '126', '127', '433'])
  assert.ok(findByClass(pager, WORKBENCH_CLASSES.pagerJumpWrap), '要有跳至指定页')
  // 总数已经在页签上，分页条不再重复「共 N 条」。
  assert.equal(textOf(pager).includes('共'), false)

  // ⚠️ 只断言"渲染出来了"是一半：还得证明**按钮真的接到了回调**。
  // 早先这条用例收集了 `goto` 却从没触发过它 —— 把 `onClick` 接错（或接不上）照样通过，
  // 而"点了页码没反应"正是这种一半断言放过去的东西（AGENTS §6 点名的"只断言一半"）。
  const clickByLabel = (label) => {
    const button = find(pager, (node) => node.type === 'button' && node.props?.['aria-label'] === label)
    assert.ok(button, `找不到「${label}」按钮`)
    button.props.onClick()
  }
  clickByLabel(zhCN.paginationFirst)
  clickByLabel(zhCN.paginationPrev)
  clickByLabel(zhCN.paginationNext)
  clickByLabel(zhCN.paginationLast)
  assert.deepEqual(goto, [1, 124, 126, 433], `首页/上页/下页/末页必须各自回调正确的页码：${JSON.stringify(goto)}`)

  // 点具体页码也要回调（页码窗口里的 "126"）。
  const pageButton = findAll(pager, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.pagerPage))
    .find((node) => textOf(node) === '126')
  assert.ok(pageButton, '页码窗口里应当有 126')
  pageButton.props.onClick()
  assert.deepEqual(goto.slice(4), [126], '点页码要回调该页码')
})

test('D2 · 「检查本机目录」按 Host 给的事实禁用（不让员工点一个必然被拒的按钮）', async () => {
  // 用户 2026-09-29 的决定：能不能体检由 **Host** 给事实（`dwsDiagnosable` → 卡片 `canDiagnose`），
  // 客户端不自己推断（它看不到诊断里的结构化事实，猜出来的一定与 Host 不一致）。
  const { DwsLocalCard } = await import(new URL('src/client/features/environment/DwsLocalCard.tsx', ROOT).href)
  const base = {
    doctor: null, repair: null, busy: false, confirming: false, error: '',
    onCheck: () => {}, onAskRepair: () => {}, onCancelRepair: () => {}, onConfirmRepair: () => {},
  }
  const checkButton = (tree) => {
    const button = find(tree, (node) => node.type === 'button'
      && String(node.props?.children ?? '').includes(zhCN.dwsLocalCheck))
    assert.ok(button, '卡片上要有「检查本机目录」')
    return button
  }

  // ① Host 明确说不可以 → 禁用 + 说明"先复现一次"。
  const disabled = render(DwsLocalCard, { ...base, canDiagnose: false })
  assert.equal(checkButton(disabled.tree).props.disabled, true, 'Host 说不能体检时必须禁用')
  const note = find(disabled.tree, (node) => node.props?.['data-crwu-dws-local-note'] === '1')
  assert.ok(note, '要说明"先复现一次"')
  assert.equal(note.props['data-crwu-dws-local-disabled'], '1')

  // ② 还没问到（`undefined`）→ 保持可点：Host 仍是那道真门禁，界面不抢先猜。
  assert.equal(checkButton(render(DwsLocalCard, { ...base }).tree).props.disabled, false)
  // ③ Host 说可以 → 可点。
  assert.equal(checkButton(render(DwsLocalCard, { ...base, canDiagnose: true }).tree).props.disabled, false)
})

test('两个版本判据的 null 语义**刻意不对称**：协议 null 不算旧，权限说明 null 算不一致', () => {
  const snapshot = (patch) => ({ ...fakeBuildStore(patch).get() })

  // 协议：`null` = 宿主还没答（或答失败）—— 不能因为"没答"就断言"是旧构建"。
  assert.equal(hostIsStale(snapshot({ protocol: WORKBENCH_PROTOCOL })), false)
  assert.equal(hostIsStale(snapshot({ protocol: WORKBENCH_PROTOCOL - 1 })), true, '不同代必须拦住')
  assert.equal(hostIsStale(snapshot({ protocol: null })), false, '还没答 ≠ 旧构建')

  // 权限说明版本：`null` = **旧宿主根本没给这个字段**（那时授权语义还是布尔值，执行不了新范围）
  // → 按不一致处理。两条判据的 null 语义相反是刻意的，别"顺手统一"。
  assert.equal(hostPermissionSchemaStale(snapshot({ permissionSchemaVersion: PERMISSION_SCHEMA_VERSION })), false)
  assert.equal(hostPermissionSchemaStale(snapshot({ permissionSchemaVersion: PERMISSION_SCHEMA_VERSION + 1 })), true)
  assert.equal(hostPermissionSchemaStale(snapshot({ permissionSchemaVersion: null })), true, '旧宿主没给字段 = 不一致')
})

test('权限说明版本不一致：环境页把卡片**禁用**（接线：环境页 → 卡片）', async () => {
  // 卡片自己的 `schemaMismatch` 分支有零件级用例（`client-local-access`），但"环境页收到
  // `authSchemaMismatch` 之后真的把它传下去、并因此禁用「允许」"这一步没有证据 ——
  // 也就是"零件对、接线没证据"。协议号**相同**、只有权限说明版本不同（或旧宿主没给字段）时，
  // 该停的是凭据类动作，而**不是**换成"宿主是旧构建"整屏。
  const { EnvironmentPane } = await import(new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
  const env = { ...okEnvBody(), localAccess: missingConsent() }
  const paneProps = envPaneProps(env, { authSchemaMismatch: true })
  const tree = render(EnvironmentPane, paneProps).tree
  findStep(tree, 'accounts').props.onClick()
  const text = textOf(rerender(EnvironmentPane, paneProps))
  assert.equal(text.includes(zhCN.envConsentSchemaMismatch), true, '权限说明不一致要明说')
  assert.equal(text.includes(zhCN.hostStaleTitle), false, '协议相同就不该说"宿主是旧构建"')
  const agree = findButtonLike(rerender(EnvironmentPane, paneProps), zhCN.envConsentAgree)
  assert.ok(agree, '授权按钮还在（只是禁用）')
  assert.equal(agree.props.disabled, true, '权限说明不一致时必须禁用「允许」')

  // 最后一段跳线（面板 → 环境页）在 JSX 里只有一处，静态钉住它：
  // 面板必须用 `hostPermissionSchemaStale(build)` 的结果，而不是自己算或恒为 false。
  const source = await readFile(new URL('src/client/features/workbench/WorkbenchPanel.tsx', ROOT), 'utf8')
  assert.equal(source.includes('const permissionStale = hostPermissionSchemaStale(build)'), true,
    '面板要用 hostPermissionSchemaStale(build) 判权限说明版本')
  assert.equal(source.includes('authSchemaMismatch={permissionStale}'), true,
    '面板要把这个结论原样传给环境页（不许在中间改写）')
})

test('次级控件共用同一套中性底：刷新 / 小鲸鱼 / ••• 三者底色一致，主操作是唯一实心', () => {
  // 用户 2026-09-23 报的缺陷：「操作列的按钮颜色不一致，还有刷新按钮」。
  // 现场是同一行里三种形态：主操作实心反色、小鲸鱼填充浅中性、••• 完全透明、工具条的刷新又是另一套 Ghost。
  // 现在规则是：**所有次级控件走同一对 token**（`--crwu-control` / `--crwu-control-hover`），
  // 只有主操作（`.crwu-audit-btn-primary`）实心。这条断言把"同一套底"钉成机器判据。
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = new RegExp(`${escaped}(?:\\s*,\\s*[^{}]*)?\\s*\\{([^}]*)\\}`).exec(WORKBENCH_STYLE_TEXT)
    assert.ok(hit !== null, `样式里找不到 ${selector} 规则`)
    return hit[1]
  }
  const background = (selector) => {
    const hit = /background:\s*([^;]+)/.exec(rule(selector))
    assert.ok(hit !== null, `${selector} 没声明 background`)
    return hit[1].trim()
  }

  const controls = ['.crwu-audit-ghost', '.crwu-audit-ai-row-btn', '.crwu-audit-menu']
  for (const selector of controls) {
    assert.equal(
      background(selector),
      'var(--crwu-control)',
      `${selector} 必须和另外两个次级控件共用同一套中性底`,
    )
  }
  // 悬停也要同格，否则"颜色不一致"只是从静止态挪到了悬停态。
  for (const selector of ['.crwu-audit-ghost:hover:not(:disabled)', '.crwu-audit-ai-row-btn:hover', '.crwu-audit-menu:hover']) {
    assert.equal(/background:\s*([^;]+)/.exec(rule(selector))?.[1].trim(), 'var(--crwu-control-hover)', `${selector} 的悬停底要和别人一致`)
  }
  // 中性底必须与行悬停底**分得开**：同格的话，悬停到那一行时小鲸鱼 / ••• 的底会被行底吃掉。
  for (const [, value] of WORKBENCH_STYLE_TEXT.matchAll(/--crwu-control:\s*([^;]+);/g)) {
    assert.notEqual(value.trim(), 'var(--crwu-hover)', '--crwu-control 不能和 --crwu-hover 指同一个值')
  }
  const lightControl = /--crwu-control:\s*([^;]+);/.exec(WORKBENCH_STYLE_TEXT)?.[1].trim() ?? ''
  const lightHover = /--crwu-hover:\s*([^;]+);/.exec(WORKBENCH_STYLE_TEXT)?.[1].trim() ?? ''
  assert.notEqual(lightControl, lightHover, '浅色下中性底与行悬停底不能是同一档')
  // 深色那一份（body[data-ds-dark-theme] 块）同样要分开。
  const darkBlock = /body\[data-ds-dark-theme\] \.crwu-audit-root\s*\{([\s\S]*?)\n\}/.exec(WORKBENCH_STYLE_TEXT)
  assert.ok(darkBlock !== null, '找不到深色 token 块')
  const darkControl = /--crwu-control:\s*([^;]+);/.exec(darkBlock[1])?.[1].trim() ?? ''
  const darkHover = /--crwu-hover:\s*([^;]+);/.exec(darkBlock[1])?.[1].trim() ?? ''
  assert.notEqual(darkControl, darkHover, '深色下中性底与行悬停底不能是同一档')
  assert.notEqual(darkControl, '', '深色块里要有 --crwu-control')

  // 主操作仍然是唯一的实心：中性控件不许再偷偷挂主按钮变体。
  assert.match(rule('.crwu-audit-btn.crwu-audit-btn-primary'), /background:\s*var\(--crwu-primary-bg\)/)
  assert.equal(
    /\.crwu-audit-menu\s*\{[^}]*background:\s*var\(--crwu-primary-bg\)/.test(WORKBENCH_STYLE_TEXT),
    false,
    '••• 不能是实心主色',
  )
})

// ── 「审核信息」Drawer：时间规范 / 程序枚举映射 / 信息架构（2026-09-23 重构）──────────

test('业务时间一律绝对化：YYYY-MM-DD HH:mm / YYYY-MM-DD，永不相对', async () => {
  const { formatDateTime, formatDate, parseStamp } = await import(
    new URL('src/client/features/report-audit/time.ts', ROOT).href
  )
  assert.equal(formatDateTime('2026-09-20 17:40:00'), '2026-09-20 17:40')
  assert.equal(formatDateTime('2026-09-20T17:40:00+0800'), '2026-09-20 17:40')
  assert.equal(formatDateTime('2026-09-20T17:40:00.000Z'), '2026-09-20 17:40')
  // 不做时区换算：记录里写的墙钟时刻就是展示的时刻（offset 原文留在 title / 技术详情）。
  assert.equal(formatDateTime('2026-09-20T09:40:00+08:00'), '2026-09-20 09:40')
  // 只有日期不补 00:00（那会凭空造出一个不存在的时刻）。
  assert.equal(formatDateTime('2026-09-20'), '2026-09-20')
  assert.equal(formatDate('2026-09-20 17:40:00'), '2026-09-20')
  assert.equal(formatDate('2026-09-20T17:40:00+0800'), '2026-09-20')
  // 认不出的形状原样返回：不猜、不取子串、不补零。
  assert.equal(formatDateTime('2026年8月12日'), '2026年8月12日')
  assert.equal(formatDateTime(''), '')
  assert.equal(parseStamp('不是时间'), null)
  // **今天的数据也必须带年份**（用户口径：这是审核留痕系统，禁止"今天/昨天"）。
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 18:15:08`
  const out = formatDateTime(today)
  assert.equal(out, `${today.slice(0, 10)} 18:15`)
  for (const value of [out, formatDateTime('2026-09-20 17:40:00')]) {
    assert.match(value, /^\d{4}-\d{2}-\d{2}/, '业务时间必须以完整年份开头')
    assert.equal(/昨天|今天|前天|天前|小时前|分钟前/.test(value), false, `不许出现相对时间：${value}`)
  }
})

test('报告列表的更新时间保留完整年份，不再出现「昨天 / 09-20」', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const task = { ...PENDING_TASK, modifiedAt: '2026-09-20 18:18:59' }
  const { tree } = render(ReportPane, reportPaneProps({ state: { tasks: [task], total: 1 } }))
  const row = textOf(tree)
  // 只看窄列（流水号 / 风险 / 更新时间）的**整格文本**：用 includes 判断"省略年份"会被
  // `2026-09-20 18:18` 里的子串 `09-20 18:18` 满足 —— 那是假通过。
  const nowrap = findAll(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.tdNowrap))
    .map(textOf)
  assert.equal(nowrap.includes('2026-09-20 18:18'), true, '列表里的业务时间要带完整年份')
  assert.equal(nowrap.some((text) => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(text)), false, '不许再出现省略年份的写法')
  assert.equal(/昨天|今天|前天|天前/.test(row), false, '不许再出现相对时间')
})

test('程序枚举只在有权威定义时才翻中文，认不出的原值不构造语义', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  // summary.overallDecision：schema enum = pass / fail / pending_confirmation
  assert.deepEqual(m.decisionOf('fail'), { tone: 'fail', label: zhCN.auditDecisionFail, raw: 'fail' })
  assert.equal(m.decisionOf('pass').tone, 'pass')
  assert.equal(m.decisionOf('pass').label, zhCN.auditDecisionPass)
  assert.equal(m.decisionOf('pending_confirmation').label, zhCN.auditDecisionPending)
  // reviewComparison.status：schema enum + audit_delivery.py 的 REVIEW_STATUS_LABEL
  assert.equal(m.reviewStatusOf('performed').label, zhCN.auditReviewPerformed)
  assert.equal(m.reviewStatusOf('not_performed').label, zhCN.auditReviewNotPerformed)
  // 没定义过的取值：**不翻译**，只留原值（界面显示 —，原值进技术详情）。
  for (const [fn, raw] of [[m.decisionOf, 'weird_state'], [m.reviewStatusOf, 'something_else']]) {
    const view = fn(raw)
    assert.equal(view.label, '', `认不出的取值不许编中文：${raw}`)
    assert.equal(view.raw, raw)
  }
  assert.equal(m.decisionOf('').label, '')
})

test('命中率只取第一个百分数：公式留在原始字段里，不进主界面', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  const raw = '33.3% (= (exact 1 + partial 0) / evaluable 3；部分命中计为命中)'
  assert.equal(m.percentOf(raw), '33.3%')
  assert.equal(m.percentOf('66.7%'), '66.7%')
  assert.equal(m.percentOf(33.3), '33.3%')
  assert.equal(m.percentOf('没有百分数'), '')
  const hit = m.hitOf({ evaluable: 3, exactHits: 1, partialHits: 0, aiHitRate: raw })
  assert.equal(hit.rate, '33.3%', '主界面只留百分数')
  assert.equal(hit.count, zhCN.auditHitCount.replace('%s', '1').replace('%s', '3'))
  assert.equal(hit.detail, zhCN.auditHitDetail.replace('%s', '1').replace('%s', '0'))
  // 分母为 0 → 规范口径是「不适用」，不得伪造 0%（11-html-delivery-spec §6.2）。
  assert.equal(m.hitOf({ evaluable: 0, exactHits: 0, partialHits: 0 }).rate, zhCN.auditNotApplicable)
  // 分母缺失 → 不写 0 / 0（会被读成"一条都没命中"）。
  assert.equal(m.hitOf({ exactHits: 1, partialHits: 0 }).count, '')
})

test('复核三条带只列载荷里存在的项，标签与悬停说明都来自交付规范', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  const bands = m.bandsOf({ overlap: 1, aiOnly: 12, reviewerOnly: 0, divergent: 0 })
  assert.deepEqual(bands.map((b) => b.label), [
    zhCN.auditBandOverlap, zhCN.auditBandAiOnly, zhCN.auditBandReviewerOnly, zhCN.auditBandDivergent,
  ])
  assert.deepEqual(bands.map((b) => b.value), [1, 12, 0, 0])
  // 权威措辞逐字保留（悬停可读），短标签只是它的压缩写法。
  assert.equal(bands[0].full, zhCN.auditBandOverlapFull)
  assert.equal(bands[1].full, zhCN.auditBandAiOnlyFull)
  assert.equal(bands[2].full, zhCN.auditBandReviewerOnlyFull)
  assert.equal(bands[3].full, zhCN.auditBandDivergentFull)
  // 载荷里没有的带不出现在界面上（不补 0）。
  assert.deepEqual(m.bandsOf({ overlap: 2 }).map((b) => b.key), ['overlap'])
  assert.deepEqual(m.bandsOf({}), [])
})

test('问题计数：缺字段不画 0，待确认/未检查是辅助位', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  const full = m.countsOf({ issuesTotal: 13, fail: 4, high: 2, medium: 9, low: 2, pendingConfirmation: 2, notChecked: 3 })
  assert.equal(full.total, 13)
  assert.equal(full.hasTotal, true)
  assert.deepEqual(full.risks.map((r) => [r.key, r.value]), [['high', 2], ['medium', 9], ['low', 2]])
  assert.equal(full.hasPending, true)
  assert.equal(full.hasNotChecked, true)
  assert.equal(full.empty, false)
  // 只有一部分字段时：只列存在的那几项。
  const partial = m.countsOf({ issuesTotal: 3, high: 1 })
  assert.deepEqual(partial.risks.map((r) => r.key), ['high'])
  assert.equal(partial.hasPending, false)
  assert.equal(partial.hasAux, false)
  const none = m.countsOf({})
  assert.equal(none.empty, true, '一个计数都没有时整段不渲染')
  assert.equal(none.hasTotal, false)
})

/**
 * 一份**逐字段照 Host 裁剪结果**（`auditInfoFromResult`）写的真实形状样本。
 *
 * 2026-09-23 起它多了两组字段：`issues[]`（已裁剪）与 `reviewComparison.reviewItems[]`
 * —— 抽屉的「AI 检出问题」与「已提未改」直接读它们。
 */
function auditInfoFixture(patch = {}) {
  return {
    schemaVersion: '1.0',
    projectId: '2026-302474-LX9995-BG8740',
    auditTime: '2026-09-20T17:40:00+0800',
    engineVersion: 'crwu-engine/1.4',
    reportVersion: '复核报告（中瑞评报字[2026]第123号） / 复核报告日期2026年8月12日',
    stage: '复核',
    issues: [
      {
        issueId: 'ISS-02', title: '收益法评估结果数值小数点与千分位混用', severity: 'medium', decision: 'fail',
        difference: '同一金额存在不同数字格式，导致金额量级失真。',
        problemDescription: '收益法评估结果数值格式错误。汇总表与正文的写法不一致。',
        locationSummary: '收益法评估结果汇总表', handlingRequirement: '统一金额格式并复核量级。',
      },
      {
        issueId: 'ISS-01', title: '资产基础法评估结果在三处出现两个不同数值', severity: 'high', decision: 'fail',
        difference: '正文与汇总表同一指标存在 362.68 万元差异。',
        problemDescription: '资产基础法评估结果不一致。正文、汇总表与结论段三处数值不同。',
        locationSummary: '二、被复核资产评估报告简介……资产评估结果汇总表……',
        handlingRequirement: '核定资产基础法股东全部权益的唯一数值，并同步修改汇总表、结论分析与结论段。',
      },
      {
        issueId: 'ISS-03', title: '披露章节缺少评估依据的说明', severity: 'low',
        difference: '', problemDescription: '评估依据章节未列示行为依据。补充说明即可。',
        locationSummary: '评估依据章节', handlingRequirement: '补列行为依据。',
      },
    ],
    summary: {
      decision: 'fail',
      counts: { issuesTotal: 13, fail: 4, high: 2, medium: 9, low: 2, pendingConfirmation: 2, notChecked: 3 },
    },
    reviewComparison: {
      status: 'performed',
      metrics: {
        total: 12, evaluable: 3, resolved: 1, uncheckable: 0, exactHits: 1, partialHits: 0, misses: 2,
        hitRate: '33.3%',
        aiHitRate: '33.3% (= (exact 1 + partial 0) / evaluable 3；部分命中计为命中)',
      },
      bands: { overlap: 1, aiOnly: 12, reviewerOnly: 0, divergent: 0 },
      reviewItems: [
        // 人工提出过 + 被审件未落实（L-open）→ 计入「已提未改」
        {
          itemId: 'R-1', title: '未见委托合同', matchStatus: 'partial', linkedIssueIds: ['ISS-01'],
          inFileResolution: 'L-open', reviewerQuote: '未见委托合同',
        },
        // 已经落实（L-resolved）→ **不算**未整改
        {
          itemId: 'R-2', title: '复核依据缺少行为依据', matchStatus: 'exact', linkedIssueIds: ['ISS-03'],
          inFileResolution: 'L-resolved', reviewerQuote: '复核依据章节缺少行为依据',
        },
        // L-open 但没关联任何 AI issue（人工提出、AI 没检出）→ 不算
        {
          itemId: 'R-3', title: '底稿未见复核记录', matchStatus: 'miss', linkedIssueIds: [],
          inFileResolution: 'L-open', reviewerQuote: '底稿未见复核记录',
        },
      ],
    },
    fileTrace: { generatedAt: '2026-09-20 17:41:02', rendererVersion: 'renderer/2', sourceDigest: 'sha256:abc' },
    ...patch,
  }
}

/** Drawer 里 `data-open` 的折叠块（已提未改 / 其他事项 / 报告信息 / 技术详情）。 */
function drawerFolds(tree) {
  return findAll(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.fold))
}

test('审核信息 Drawer：数据没回来时只显示加载态，不画空小节', async () => {
  stubOps({})
  const { AuditInfoDrawer } = await import(new URL('src/client/features/report-audit/AuditInfoDrawer.tsx', ROOT).href)
  const loading = render(AuditInfoDrawer, { seqNo: 'S-4', info: null, error: '' })
  assert.equal(textOf(loading.tree).includes(zhCN.loadingAuditInfo), true)
  assert.equal(findByClass(loading.tree, WORKBENCH_CLASSES.km), null, '没有数据时不该画核心指标块')
  assert.deepEqual(drawerFolds(loading.tree), [], '没有数据时不该画折叠小节')
  const failed = render(AuditInfoDrawer, { seqNo: 'S-4', info: null, error: '不是合法 JSON' })
  assert.equal(textOf(failed.tree).includes('不是合法 JSON'), true, '失败要给真实原因')
})

test('Drawer 头部：标题 + 一行等宽流水号 + × 关闭（不再有「关闭」文字按钮）', async () => {
  stubOps({})
  const { SideDrawer } = await import(new URL('src/client/components/SideDrawer.tsx', ROOT).href)
  const { tree } = render(SideDrawer, { title: zhCN.auditInfo, subtitle: '2026-302474-LX9995-BG8740', onClose: () => {} })
  const head = findByClass(tree, WORKBENCH_CLASSES.sideDrawerHead)
  assert.equal(textOf(findByClass(head, WORKBENCH_CLASSES.sideDrawerTitle)).includes(zhCN.auditInfo), true)
  // 流水号只在头部出现一次。
  assert.equal(textOf(tree).split('2026-302474-LX9995-BG8740').length - 1, 1)
  assert.ok(findByClass(head, WORKBENCH_CLASSES.sideDrawerSub), '副标题用等宽小字')
  assert.equal(findButtonLike(head, zhCN.closeDrawer), null, '「关闭」文字按钮已删除')
  const close = find(head, (node) => node.type === 'button' && node.props?.['aria-label'] === zhCN.closeDrawer)
  assert.ok(close, '要有 × 关闭按钮（aria-label=关闭）')
  assert.equal(textOf(close), '×')
})

test('Drawer 关闭动画：onClose 立刻回调，`-out` 类只在 closing 时加', async () => {
  stubOps({})
  const { SideDrawer } = await import(new URL('src/client/components/SideDrawer.tsx', ROOT).href)
  let closed = 0
  const base = { title: zhCN.auditInfo, subtitle: 'S', onClose: () => { closed += 1 } }
  const plain = render(SideDrawer, base)
  assert.equal(hasExactClass(plain.tree, WORKBENCH_CLASSES.sideDrawerOut), false)
  const closing = render(SideDrawer, { ...base, closing: true })
  assert.equal(hasExactClass(closing.tree, WORKBENCH_CLASSES.sideDrawerOut), true, '关闭中要加 -out 类')
  assert.equal(hasExactClass(closing.tree, WORKBENCH_CLASSES.sideDrawerBackdropOut), true)
  find(closing.tree, (node) => node.type === 'button' && node.props?.['aria-label'] === zhCN.closeDrawer).props.onClick()
  assert.equal(closed, 1, '点 × 立刻回调（动画由父层延迟卸载）')
})

// ── 「审核信息」Drawer 第二轮：它是「AI 审核质量与问题摘要」（2026-09-23）──────────

test('AI 检出问题：取 title/severity/difference，按 高 → 中 → 低 稳定排序', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  const issues = m.issuesOf(auditInfoFixture())
  assert.deepEqual(issues.map((i) => i.issueId), ['ISS-01', 'ISS-02', 'ISS-03'], '高 → 中 → 低')
  assert.deepEqual(issues.map((i) => i.severityLabel), [zhCN.auditRiskHigh, zhCN.auditRiskMedium, zhCN.auditRiskLow])
  assert.equal(issues[0].title, '资产基础法评估结果在三处出现两个不同数值', '标题逐字用 issue.title')
  assert.equal(issues[0].brief, '正文与汇总表同一指标存在 362.68 万元差异。', '简述优先 gapAnalysis.difference')
  // 没有 difference 时退回 problemDescription 的第一句（并补回句号）。
  assert.equal(issues[2].brief, '评估依据章节未列示行为依据。')
  // 同级保持原有顺序；认不出的严重程度排最后且不编中文。
  const mixed = m.issuesOf({
    issues: [
      { issueId: 'A', title: '中', severity: 'medium' },
      { issueId: 'B', title: '未知', severity: 'weird' },
      { issueId: 'C', title: '高', severity: 'high' },
    ],
  })
  assert.deepEqual(mixed.map((i) => i.issueId), ['C', 'A', 'B'])
  assert.equal(mixed[2].severityLabel, '', '认不出的严重程度不翻译')
  assert.equal(mixed[2].severity, 'weird', '原值保留')
})

test('firstSentence：先取第一行，没有换行才取第一句', async () => {
  const { firstSentence } = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  assert.equal(firstSentence('第一行\n第二行'), '第一行')
  assert.equal(firstSentence('一句话说清问题。第二段补充。'), '一句话说清问题。')
  assert.equal(firstSentence('没有句号的一整句'), '没有句号的一整句')
  assert.equal(firstSentence('  '), '')
})

test('已提未改：必须 linkedIssueIds 与 L-open 同时成立，宁可少显示也不误报', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  const raised = m.raisedUnresolvedOf(auditInfoFixture())
  assert.deepEqual(raised.map((i) => i.issueId), ['ISS-01'], '只有 R-1 那条同时满足两个条件')
  assert.equal(raised[0].itemId, 'R-1')
  assert.equal(raised[0].reviewerQuote, '未见委托合同', '人工当时提出的原话')
  assert.equal(raised[0].brief, '正文与汇总表同一指标存在 362.68 万元差异。', 'AI 当前仍然发现的')
  assert.equal(raised[0].severityLabel, zhCN.auditRiskHigh)

  const base = auditInfoFixture()
  const withItems = (items) => m.raisedUnresolvedOf({
    ...base,
    reviewComparison: { ...base.reviewComparison, reviewItems: items },
  })
  // 已落实 → 不算未整改（这是最要紧的一条：不能把改好的说成没改）
  assert.deepEqual(withItems([{ itemId: 'X', linkedIssueIds: ['ISS-01'], inFileResolution: 'L-resolved' }]), [])
  // 答复称已改但未落地 / 材料缺失：都不属于 L-open 这一档
  assert.deepEqual(withItems([{ itemId: 'X', linkedIssueIds: ['ISS-01'], inFileResolution: 'L-unclosed' }]), [])
  assert.deepEqual(withItems([{ itemId: 'X', linkedIssueIds: ['ISS-01'], inFileResolution: 'L-uncheckable' }]), [])
  // 没有关联 AI issue（人工提出、AI 没检出）→ 不算
  assert.deepEqual(withItems([{ itemId: 'X', linkedIssueIds: [], inFileResolution: 'L-open' }]), [])
  // 关联到不存在的 issueId → 不猜，直接不算
  assert.deepEqual(withItems([{ itemId: 'X', linkedIssueIds: ['NOPE'], inFileResolution: 'L-open' }]), [])
  // 同一个 issue 被两条复核意见指向 → 按 issueId 去重
  const dup = withItems([
    { itemId: 'X1', linkedIssueIds: ['ISS-01'], inFileResolution: 'L-open', reviewerQuote: '第一次' },
    { itemId: 'X2', linkedIssueIds: ['ISS-01'], inFileResolution: 'L-open', reviewerQuote: '第二次' },
  ])
  assert.equal(dup.length, 1)
  assert.equal(dup[0].reviewerQuote, '第一次')
  // 没有 reviewItems（旧宿主）→ 空数组，界面降级成 0/—，不报错
  assert.deepEqual(m.raisedUnresolvedOf({ ...base, reviewComparison: { metrics: {} } }), [])
})

test('AI 检出条数：优先 counts.issuesTotal，缺字段才退回 issues.length', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-summary.ts', ROOT).href)
  const issues = m.issuesOf(auditInfoFixture())
  const detected = m.detectedOf(auditInfoFixture(), issues)
  assert.deepEqual(detected, { count: 13, hasCount: true }, 'counts.issuesTotal 是权威值（不是列表长度 3）')
  // 没有 counts.issuesTotal → 退回列表长度
  const noCounts = m.detectedOf({ ...auditInfoFixture(), summary: { decision: 'fail' } }, issues)
  assert.deepEqual(noCounts, { count: 3, hasCount: true })
  // 两边都没有 → 不显示数字
  assert.deepEqual(m.detectedOf({}, []), { count: 0, hasCount: false })
})

test('Drawer 第一屏：命中率最大，其次是 AI 检出与已提未改，且没有结论大卡', async () => {
  stubOps({})
  const { AuditInfoDrawer } = await import(new URL('src/client/features/report-audit/AuditInfoDrawer.tsx', ROOT).href)
  const { tree } = render(AuditInfoDrawer, { seqNo: 'S-9', info: auditInfoFixture(), error: '' })
  const km = findByClass(tree, WORKBENCH_CLASSES.km)
  assert.ok(km, '第一屏要有核心指标块')
  // P0：命中率是最大的那个数字，且**只**展示百分数（公式不进主界面）
  assert.equal(textOf(findByClass(km, WORKBENCH_CLASSES.rateValue)).trim(), '33.3%')
  const kmText = textOf(km).replace(/\s+/g, ' ')
  assert.equal(kmText.includes(zhCN.auditHitRate), true)
  assert.equal(kmText.includes('1 / 3 条命中'), true)
  assert.equal(kmText.includes('精确 1 · 部分 0'), true)
  for (const noise of ['evaluable', '部分命中计为命中', '= (']) {
    assert.equal(kmText.includes(noise), false, `命中率公式不进第一屏：${noise}`)
  }
  // P1：AI 检出（用 counts.issuesTotal=13，不是列表长度 3）与已提未改 1
  const kmValues = findAll(km, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.kmValue))
    .map((node) => textOf(node).trim())
  assert.deepEqual(kmValues, [zhCN.auditCountUnit.replace('%s', '13'), zhCN.auditCountUnit.replace('%s', '1')])
  assert.equal(kmText.includes(zhCN.auditDetected), true)
  assert.equal(kmText.includes(zhCN.auditRaised), true)
  assert.equal(kmText.includes(zhCN.auditDetectedAiOnly.replace('%s', '12')), true, '独立发现只作 secondary')
  // 顶部不再有结论大卡：km 里不许出现「未通过 / 已执行」，它们挪进了折叠的报告信息
  assert.equal(kmText.includes(zhCN.auditDecisionFail), false, '第一屏不放大结论')
  assert.equal(kmText.includes(zhCN.auditReviewPerformed), false)
  // 而且第一个 DOM 小节就是核心指标块（没有审核摘要卡）
  const header = findByClass(tree, WORKBENCH_CLASSES.sideDrawerHead)
  const order = findAll(tree, (node) => {
    const cls = String(node.props?.className ?? '').split(/\s+/)
    return cls.includes(WORKBENCH_CLASSES.km) || cls.includes(WORKBENCH_CLASSES.sec) || cls.includes(WORKBENCH_CLASSES.fold)
  })
  assert.ok(order.indexOf(km) >= 0)
  // 抽屉头里不许出现「审核摘要」这种结论小标题（`auditSecSummary` 这个键早已不存在，
  // 用 `zhCN.<缺失键>` 断言是 `includes(undefined)` —— 永远为 false 的假通过，所以写字面量）。
  assert.equal(textOf(header).includes('审核摘要'), false)
})

test('Drawer：AI 检出问题列表直接给标题与简述，点开才给位置与建议', async () => {
  stubOps({})
  const { AuditInfoDrawer } = await import(new URL('src/client/features/report-audit/AuditInfoDrawer.tsx', ROOT).href)
  const props = { seqNo: 'S-10', info: auditInfoFixture(), error: '', onOpenReport: () => {} }
  const { tree, instance } = render(AuditInfoDrawer, props)
  const rows = findAll(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.issueRow))
  // 3 条问题 + 0 条已提未改（已提未改在 raised 块里，raished 未展开但仍在 DOM）→ 这里是 3 + 1
  assert.equal(rows.length, 4, '三条问题 + 一条已提未改')
  const issueRows = rows.filter((row) => String(row.props.className).includes(WORKBENCH_CLASSES.acc))
  assert.equal(String(issueRows[0].props['data-open']), 'false', '问题默认折叠')
  const first = textOf(rows[1]).replace(/\s+/g, ' ')
  assert.equal(first.includes('资产基础法评估结果在三处出现两个不同数值'), true, '直接展示 issue.title')
  assert.equal(first.includes('正文与汇总表同一指标存在 362.68 万元差异。'), true, '简述用 difference')
  assert.equal(first.includes('ISS-01'), false, '默认不显示内部编号')
  // 展开第一条：位置与建议出现
  const head = findByClass(rows[1], WORKBENCH_CLASSES.issueHead)
  assert.equal(head.props['aria-expanded'], false)
  head.props.onClick()
  const opened = rerender(AuditInfoDrawer, props)
  void instance
  const openedRows = findAll(opened, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.issueRow))
  const openedRow = openedRows[1]
  assert.equal(String(openedRow.props['data-open']), 'true')
  const detail = textOf(openedRow).replace(/\s+/g, ' ')
  assert.equal(detail.includes(zhCN.auditIssueLocation), true)
  assert.equal(detail.includes('资产评估结果汇总表'), true)
  assert.equal(detail.includes(zhCN.auditIssueSuggestion), true)
  assert.equal(detail.includes('核定资产基础法股东全部权益的唯一数值'), true)
  assert.equal(detail.includes(zhCN.auditIssueMore), true, '有交付件时给回完整报告的入口')
  // 一次只展开一条
  const secondHead = findByClass(openedRows[2], WORKBENCH_CLASSES.issueHead)
  secondHead.props.onClick()
  const swapped = rerender(AuditInfoDrawer, props)
  const swappedRows = findAll(swapped, (node) => String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.issueRow))
  assert.equal(String(swappedRows[1].props['data-open']), 'false', '展开另一条时上一条自动收起')
  assert.equal(String(swappedRows[2].props['data-open']), 'true')
})

test('Drawer：「已提未改」默认折叠，展开后给出人工原话与 AI 当前检出', async () => {
  stubOps({})
  const { AuditInfoDrawer } = await import(new URL('src/client/features/report-audit/AuditInfoDrawer.tsx', ROOT).href)
  const props = { seqNo: 'S-11', info: auditInfoFixture(), error: '' }
  const { tree } = render(AuditInfoDrawer, props)
  const raised = findByClass(tree, WORKBENCH_CLASSES.raised)
  assert.ok(raised, '要有已提未改折叠区')
  assert.equal(String(raised.props['data-open']), 'false', '默认折叠')
  assert.equal(textOf(findByClass(raised, WORKBENCH_CLASSES.raisedCount)).trim(), '1', '数量 badge')
  const raisedText = textOf(raised).replace(/\s+/g, ' ')
  assert.equal(raisedText.includes(zhCN.auditRaisedTitle), true)
  assert.equal(raisedText.includes(zhCN.auditRaisedSubtitle), true)
  assert.equal(raisedText.includes(zhCN.auditRaisedReviewer), true)
  assert.equal(raisedText.includes('未见委托合同'), true, '人工当时提出的原话')
  assert.equal(raisedText.includes(zhCN.auditRaisedAi), true)
  assert.equal(raisedText.includes('正文与汇总表同一指标存在 362.68 万元差异。'), true, 'AI 当前仍发现什么')
  // 展开
  findByClass(raised, WORKBENCH_CLASSES.raisedHead).props.onClick()
  const opened = rerender(AuditInfoDrawer, props)
  assert.equal(String(findByClass(opened, WORKBENCH_CLASSES.raised).props['data-open']), 'true')
  // 没有「已提未改」时不画这一块
  const none = render(AuditInfoDrawer, {
    seqNo: 'S-12',
    info: auditInfoFixture({ reviewComparison: { ...auditInfoFixture().reviewComparison, reviewItems: [] } }),
    error: '',
  })
  assert.equal(findByClass(none.tree, WORKBENCH_CLASSES.raised), null)
})

test('Drawer：报告信息与技术详情默认折叠，结论/枚举/JSON 都在里面', async () => {
  stubOps({})
  const { AuditInfoDrawer } = await import(new URL('src/client/features/report-audit/AuditInfoDrawer.tsx', ROOT).href)
  const { tree } = render(AuditInfoDrawer, { seqNo: 'S-13', info: auditInfoFixture(), error: '' })
  const folds = drawerFolds(tree)
  assert.equal(folds.length >= 2, true, '至少要有报告信息 + 技术详情两个折叠区')
  for (const fold of folds) {
    assert.equal(String(fold.props['data-open']), 'false', '折叠区默认全部收起')
  }
  const texts = folds.map((fold) => textOf(fold))
  const report = texts.find((text) => text.includes(zhCN.auditSecReport))
  const tech = texts.find((text) => text.includes(zhCN.auditSecTech))
  assert.ok(report, '要有报告信息')
  assert.equal(report.includes(zhCN.auditConclusion), true, '审核结论挪进报告信息')
  assert.equal(report.includes(zhCN.auditDecisionFail), true)
  assert.equal(report.includes(zhCN.auditReviewStatusLabel), true)
  assert.equal(report.includes('2026-09-20 17:40'), true, '业务时间保留完整年份')
  assert.equal(report.includes('crwu-engine/1.4'), false, '引擎版本不进报告信息')
  assert.ok(tech, '要有技术详情')
  assert.equal(tech.includes('crwu-engine/1.4'), true, '引擎版本进技术详情')
  assert.equal(tech.includes('fail'), true, '原始结论值进技术详情')
  assert.equal(tech.includes('performed'), true, '原始复核状态进技术详情')
  assert.equal(tech.includes('"overlap":1'), true, '原始复核计数 JSON')
  assert.equal(tech.includes('2026-09-20T17:40:00+0800'), true, '原始 ISO 时间')
  assert.equal(tech.includes('R-1'), true, '原始复核项（reviewItems）可查')
})

test('Drawer：业务区不出现程序枚举 / 原始 JSON（只在折叠的技术详情里）', async () => {
  stubOps({})
  const { AuditInfoDrawer } = await import(new URL('src/client/features/report-audit/AuditInfoDrawer.tsx', ROOT).href)
  const { tree } = render(AuditInfoDrawer, { seqNo: 'S-14', info: auditInfoFixture(), error: '' })
  // 业务区 = 整棵树减去**技术详情那一整块**（子树文本在整串里是连续的一段，直接 split 掉最稳；
  // 用"拼接若干行再 replace"会因为没有分隔符而替换失败，那是一次假通过）。
  const techFold = drawerFolds(tree).find((fold) => textOf(fold).includes(zhCN.auditSecTech))
  assert.ok(techFold, '要有技术详情折叠块')
  const all = textOf(tree)
  const business = all.split(textOf(techFold)).join('')
  for (const noise of ['fail', 'performed', 'overlap', 'aiOnly', 'reviewerOnly', 'divergent', 'ISS-01', '{"', 'L-open', 'R-1']) {
    assert.equal(business.includes(noise), false, `业务区不该出现程序原语/内部编号：${noise}`)
  }
})

// ── 「AI 审核结果分析会话」（audit_analysis，2026-09-23）────────────────────────

/**
 * 对话框里的一个选项（标题 + 说明两行）。`findButtonLike` 是**逐字相等**匹配，
 * 对这种两行按钮永远找不到 —— 这里按"包含"找，避免又一次假阴性。
 */
function findOptionLike(node, label) {
  return find(node, (item) => item.type === 'button' && textOf(item).includes(label))
}

test('版本判定优先级：digest → version → etag → mtime，最后才退化到时间', async () => {
  const { freshnessOf, digestComparable } = await import(new URL('src/client/features/report-audit/audit-freshness.ts', ROOT).href)
  const base = {
    reportDigest: '', auditSourceDigest: '', reportVersion: '', auditSourceVersion: '',
    reportEtag: '', auditSourceEtag: '', reportModifiedAt: '', auditModifiedAt: '',
    reportUpdatedAt: '', auditGeneratedAt: '',
  }
  // ① digest 两侧都有 → 唯一的**强结论**来源
  assert.deepEqual(
    freshnessOf({ ...base, reportDigest: 'sha:a', auditSourceDigest: 'sha:a', reportUpdatedAt: '2026-09-25 10:00', auditGeneratedAt: '2026-09-20 10:00' }),
    { status: 'current', basis: 'digest', note: 'digest 一致' },
    'digest 一致就是 CURRENT —— 即使记录更新时间更晚（那可能是非内容性操作）',
  )
  assert.equal(freshnessOf({ ...base, reportDigest: 'sha:a', auditSourceDigest: 'sha:b' }).status, 'stale')
  // digest 优先于 version/etag/mtime：后面三个都不一致也不改变结论
  assert.equal(
    freshnessOf({ ...base, reportDigest: 'sha:a', auditSourceDigest: 'sha:a', reportVersion: 'v2', auditSourceVersion: 'v1' }).basis,
    'digest',
  )
  // ② 只有一侧有 digest → 不可比，继续往下降级（不能因为"没得比"就下结论）
  assert.equal(digestComparable({ ...base, reportDigest: 'sha:a' }), false)
  assert.equal(
    freshnessOf({ ...base, auditSourceDigest: 'sha:a', reportVersion: 'v2', auditSourceVersion: 'v1' }).basis,
    'version',
  )
  assert.equal(freshnessOf({ ...base, reportEtag: 'e1', auditSourceEtag: 'e2' }).status, 'stale')
  assert.equal(freshnessOf({ ...base, reportModifiedAt: '2026-09-21 10:00', auditModifiedAt: '2026-09-20 10:00' }).status, 'stale')
  // ③ 只剩时间关系：**只能**得出 possibly_stale（更新时间可能来自非内容性操作）
  assert.equal(
    freshnessOf({ ...base, reportUpdatedAt: '2026-09-22 16:30', auditGeneratedAt: '2026-09-20 17:40' }).status,
    'possibly_stale',
  )
  assert.equal(
    freshnessOf({ ...base, reportUpdatedAt: '2026-09-19 10:00', auditGeneratedAt: '2026-09-20 17:40' }).status,
    'current',
  )
  // ④ 有一侧时间读不出来 → UNKNOWN（不许猜）
  assert.equal(freshnessOf({ ...base, reportUpdatedAt: '不是时间', auditGeneratedAt: '2026-09-20 17:40' }).status, 'unknown')
  assert.equal(freshnessOf(base).status, 'unknown')
})

test('快照差异：报告 / AI 审核 / 复核意见三条信号各自独立', async () => {
  const { changesSince } = await import(new URL('src/client/features/report-audit/audit-freshness.ts', ROOT).href)
  const snap = {
    reportSerialNumber: 'S', reportUpdatedAt: '2026-09-20 17:00', reportDigest: '',
    auditGeneratedAt: '2026-09-20 17:40', auditSourceDigest: '', auditArtifactVersion: '',
    reviewUpdatedAt: '2026-09-21 14:20', conversationCreatedAt: '2026-09-21 15:00', contextStatus: 'current',
  }
  assert.deepEqual(changesSince(snap, snap), { report: false, audit: false, review: false, digest: false, any: false })
  const reportMoved = { ...snap, reportUpdatedAt: '2026-09-22 16:30' }
  assert.deepEqual(changesSince(snap, reportMoved), { report: true, audit: false, review: false, digest: false, any: true })
  assert.equal(changesSince(snap, { ...snap, auditGeneratedAt: '2026-09-22 09:00' }).audit, true)
  assert.equal(changesSince(snap, { ...snap, reviewUpdatedAt: '2026-09-22 10:00' }).review, true)
  assert.equal(changesSince(snap, { ...snap, reportDigest: 'sha:new' }).digest, false, '快照里没有 digest 就不比（不可比）')
  assert.equal(
    changesSince({ ...snap, reportDigest: 'sha:old' }, { ...snap, reportDigest: 'sha:new' }).digest,
    true,
  )
})

test('分析会话命名与找回：与报告讨论互不串味，且 X-1 不命中 X-10', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const { sessionsOfKind } = await import(new URL('src/client/features/report-audit/assistant-session.ts', ROOT).href)
  assert.equal(m.auditAnalysisTitle('X-1'), `${zhCN.auditSessionPrefix}X-1`)
  assert.equal(m.auditAnalysisTitle('X-1', 2), `${zhCN.auditSessionPrefix}X-1 #2`)
  const sessions = [
    { id: 'a', displayTitle: `${zhCN.auditSessionPrefix}X-1` },
    { id: 'b', displayTitle: `${zhCN.auditSessionPrefix}X-1 #2` },
    { id: 'c', displayTitle: `${zhCN.aiSessionPrefix}X-1` },
    { id: 'd', displayTitle: `${zhCN.auditSessionPrefix}X-10` },
  ]
  assert.deepEqual(m.findAuditAnalyses(sessions, 'X-1').map((s) => s.id), ['a', 'b'], 'X-10 不能算进来')
  assert.deepEqual(sessionsOfKind('report_discussion', sessions, 'X-1').map((s) => s.id), ['c'])
  assert.deepEqual(sessionsOfKind('audit_analysis', sessions, 'X-1').map((s) => s.id), ['a', 'b'])
  assert.equal(m.nextAuditOrdinal(sessions, 'X-1'), 3)
})

test('Context Snapshot：字段来自真实来源，可存可读，坏数据不炸', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const info = auditInfoFixture()
  assert.equal(m.auditGeneratedAtOf(info), '2026-09-20 17:41:02', '优先 fileTrace.generatedAt')
  assert.equal(m.auditGeneratedAtOf({ auditTime: '2026-09-20T17:40:00+0800' }), '2026-09-20T17:40:00+0800', '没有 generatedAt 才退回 auditTime')
  // 复核更新时间取 reviewFiles[].occurredAt 里最晚的一个
  assert.equal(m.reviewUpdatedAtOf({ reviewComparison: { reviewFiles: [{ occurredAt: '2026-08-12' }, { occurredAt: '2026-09-21 14:20' }] } }), '2026-09-21 14:20')
  assert.equal(m.reviewUpdatedAtOf(info), '', 'fixture 里没有 reviewFiles → 复核更新时间留空（不猜）')
  const snap = m.snapshotOf({ seqNo: 'S-1', info, reportUpdatedAt: '2026-09-22 16:30', createdAt: '2026-09-23T00:00:00.000Z' })
  assert.equal(snap.reportSerialNumber, 'S-1')
  assert.equal(snap.reportUpdatedAt, '2026-09-22 16:30')
  assert.equal(snap.auditGeneratedAt, '2026-09-20 17:41:02')
  assert.equal(snap.auditSourceDigest, 'sha256:abc')
  assert.equal(snap.conversationCreatedAt, '2026-09-23T00:00:00.000Z')
  assert.equal(snap.contextStatus, 'possibly_stale', '只有时间关系 → possibly_stale')
  // 本地留存（stub localStorage）
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) },
  }
  m.saveSnapshot(snap)
  assert.deepEqual(m.loadSnapshot('S-1'), snap)
  assert.equal(m.loadSnapshot('NOPE'), null)
  // 被手改 / 旧版本写坏的 JSON：当作"没有快照"，不抛
  store.set('crwu.audit-analysis.S-1', '{ not json')
  assert.equal(m.loadSnapshot('S-1'), null)
  store.set('crwu.audit-analysis.S-1', JSON.stringify({ reportSerialNumber: 'S-1', contextStatus: 'weird' }))
  assert.equal(m.loadSnapshot('S-1').contextStatus, 'unknown', '认不出的状态码归到 unknown')
  delete globalThis.localStorage
})

test('上下文包：逐字注入 System Instruction，并如实写出缺失项与版本关系', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const { freshnessOf } = await import(new URL('src/client/features/report-audit/audit-freshness.ts', ROOT).href)
  const verdict = freshnessOf({
    reportDigest: '', auditSourceDigest: 'sha256:abc', reportVersion: '', auditSourceVersion: '',
    reportEtag: '', auditSourceEtag: '', reportModifiedAt: '', auditModifiedAt: '',
    reportUpdatedAt: '2026-09-22 16:30', auditGeneratedAt: '2026-09-20 17:41',
  })
  const block = m.buildAuditContextBlock({
    // 2026-09-25 用户口径：必须给出**唯一**允许读写的案例目录，模型才不会 `ls`/`find` 去猜。
    caseDir: '/Users/me/中瑞世联工作空间/2026-302474-LX9995-BG8740',
    seqNo: '2026-302474-LX9995-BG8740', project: '某项目', reportUpdatedAt: '2026-09-22 16:30',
    reportVersion: '复核报告', auditGeneratedAt: '2026-09-20 17:41', auditSourceDigest: 'sha256:abc',
    auditArtifactVersion: '1.0', reviewUpdatedAt: '2026-08-12',
    fetchedAt: '2026-09-23T10:00:00.000Z',
    sources: [{ sourceType: 'remote', provider: 'h3yun', remoteId: 'f1', remoteVersion: '报告.zip', remoteUpdatedAt: '', digest: '', fetchedAt: '2026-09-23T10:00:00.000Z' }],
    reportLines: ['V2定稿-估值报告.zip（氚云附件 · 1.0 MB）'],
    auditLines: ['审核报告：crwu/audit/S/审核意见.html', '审核数据：crwu/audit/S/审核结果.json'],
    reviewLines: ['一级复核 · 复核报告（2026-08-12）'],
    missing: ['本次未取到 AI 审核结构化数据（只有 HTML），无法做结构化问题分析。'],
    verdict,
  })
  // System Instruction 逐字在（抽样三句 + 流水号替换）
  assert.equal(block.includes('你是一名资深资产评估师，正在与当前报告的项目负责人共同分析这份报告及其 AI 审核结果。'), true)
  // §13 的数据边界强制规则必须在（不是只写在文档里）
  assert.equal(block.includes('数据边界（强制）：'), true)
  assert.equal(block.includes('你不得主动读取、搜索、引用或依赖任何未加入当前会话的本地文件、工作区文件、缓存文件或其它文件系统内容。'), true)
  assert.equal(block.includes('你的目标不是证明 AI 审核是正确的。'), true)
  assert.equal(block.includes('【REPORT_SERIAL_NUMBER】'), false, '占位符要被真实流水号替换')
  assert.equal(block.includes('2026-302474-LX9995-BG8740'), true)
  assert.equal(block.includes('避免只修改一个点而造成前后文、表格或结论仍然不一致'), true)
  // 版本关系的中文表述（不是英文枚举、也不是过度确定的语言）
  assert.equal(block.includes(zhCN.auditFreshPossibly), true)
  assert.equal(/(current|possibly_stale|stale|unknown)/.test(block), false, '不许把英文枚举写进上下文')
  // 来源清单（只有远端标识）+ 缺失项都在
  assert.equal(block.includes(zhCN.auditCtxSourceHead), true)
  assert.equal(block.includes(`h3yun · ${zhCN.auditCtxRemoteId}：f1`), true, '来源清单要写明远端标识')
  // 取数规则：**只有**案例目录这一条本机路径 + 用哪个 Tool 取 + 每次新建会话都重下 + 禁扫描
  assert.equal(block.includes(zhCN.aiCaseDirHead), true)
  assert.equal(block.includes('/Users/me/中瑞世联工作空间/2026-302474-LX9995-BG8740'), true, '要给出案例目录')
  assert.equal(block.includes('crwu_h3yun_file_get({ fileId, caseDir, relativePath: "材料-源/<落盘名>" })'), true)
  assert.equal(block.includes('**落盘名必须用下面「本次登记的材料」里给出的那个名字**'), true)
  assert.equal(block.includes('**每一次新建对话都要重新执行**'), true)
  assert.equal(block.includes('**禁止**用 `ls`、`find`、`grep`、`glob`'), true)
  // 除案例目录之外的本地路径一律不许出现（`/Users/me/中瑞世联工作空间` 仅在那一行里）
  const localPaths = block.match(/\/Users\/[^\s」、）)]*/g) ?? []
  assert.deepEqual([...new Set(localPaths)], ['/Users/me/中瑞世联工作空间/2026-302474-LX9995-BG8740'], '本地路径只允许出现案例目录这一条')
  assert.equal(/\/tmp\/|\/ws\//.test(block), false, '别的本地路径不许出现')
  assert.equal(block.includes('本地案例目录'), false)
  assert.equal(block.includes('工作区下面'), false)
  // 三类资料 + 缺失项都在
  assert.equal(block.includes('V2定稿-估值报告.zip'), true)
  assert.equal(block.includes('审核意见.html'), true)
  assert.equal(block.includes('一级复核 · 复核报告（2026-08-12）'), true)
  assert.equal(block.includes(zhCN.auditCtxMissingHead), true)
  // 业务时间保留完整年份
  assert.equal(block.includes('2026-09-22 16:30'), true)
})

test('AI 审核列表：统一的 DeepSeek 入口（同一个组件 + Icon Button，Tooltip 区分业务）', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const props = reportPaneProps({ state: { ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } } })
  const { tree, instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  const action = findByClass(results, WORKBENCH_CLASSES.tdAction)
  // 同一枚小鲸鱼按钮类 + 同一个 aria-label（= 同一个组件、同一套视觉）
  const whale = find(action, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn))
  assert.ok(whale, 'AI 审核列表要有 DeepSeek 入口')
  assert.equal(whale.props['aria-label'], zhCN.auditTooltipAnalyze)
  assert.equal(String(whale.props.className).split(/\s+/).includes(WORKBENCH_CLASSES.menu), false, '不是 •••')
  // 没有新增文字按钮 / 噪音 Tag
  const actionText = textOf(action)
  for (const noise of ['AI分析', '查看会话', '可分析', 'AI ready', '已同步', '上下文完整']) {
    assert.equal(actionText.includes(noise), false, `不该出现「${noise}」`)
  }
  // Tooltip：AI 列表那枚是「分析审核结果」，报告列表那枚仍是「讨论报告」
  whale.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 10, right: 42, top: 100, bottom: 132 }) } })
  const withTip = rerender(ReportPane, props)
  assert.equal(textOf(findByClass(withTip, WORKBENCH_CLASSES.floatTip)).includes(zhCN.auditTooltipAnalyze), true)
  // 报告列表那枚的 Tooltip 不变
  const pending = render(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  findByClass(pending.tree, WORKBENCH_CLASSES.aiRowBtn).props.onMouseEnter({
    currentTarget: { getBoundingClientRect: () => ({ left: 10, right: 42, top: 100, bottom: 132 }) },
  })
  const pendingTip = rerender(ReportPane, reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1 } }))
  assert.equal(textOf(findByClass(pendingTip, WORKBENCH_CLASSES.floatTip)).includes(zhCN.aiRowButton), true)
})

test('点 DeepSeek：报告在审核后更新过 → 弹「存在更新记录」选择框（不静默进入）', async () => {
  stubOps({ 'report-files': { body: { ok: true, error: '', seqNo: PENDING_TASK.seqNo, h3yun: [{ field: 'F', fileId: 'f1', name: '报告.zip', size: 1024, contentType: 'application/zip' }], h3yunError: '', oss: [], local: [], localDir: '', localExists: false, truncated: false } } })
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const props = reportPaneProps({
    state: { tasks: [PENDING_TASK], total: 1, ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } },
    onLoadAuditInfo: () => Promise.resolve({ info: auditInfoFixture(), error: '' }),
  })
  const view = render(ReportPane, props)
  const results = openResults(ReportPane, props, view.instance)
  const whale = find(results, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn))
  whale.props.onClick()
  for (let i = 0; i < 10; i += 1) await settle()
  const asked = rerender(ReportPane, props)
  const dialog = findByClass(asked, WORKBENCH_CLASSES.aiDialog)
  assert.ok(dialog, '要弹版本检查对话框')
  const text = textOf(dialog)
  // PENDING_TASK.modifiedAt = 2026-09-20 18:18，审核生成时间 2026-09-20 17:41 → 报告更晚 → possibly_stale
  assert.equal(text.includes(zhCN.auditPossibleTitle), true, '只用时间关系时是"存在更新记录"，不是"已失效"')
  assert.equal(text.includes(zhCN.auditStaleTitle), false, '没有 digest 证据就不能说"报告已更新"')
  assert.equal(text.includes('2026-09-20 18:18'), true, '报告更新时间保留完整年份')
  assert.equal(text.includes('2026-09-20 17:41'), true, 'AI 审核时间保留完整年份')
  assert.ok(findOptionLike(dialog, zhCN.auditProceedFresh), '要有「使用最新资料重新分析」')
  assert.ok(findOptionLike(dialog, zhCN.auditContinueOld), '要有「继续查看原审核上下文」')
})

test('点 DeepSeek：没有历史会话且版本一致 → 直接新建 audit_analysis 会话并注入上下文', async () => {
  const ops = stubOps({ 'report-files': { body: { ok: true, error: '', seqNo: PENDING_TASK.seqNo, h3yun: [{ field: 'F', fileId: 'f1', name: '报告.zip', size: 1024, contentType: 'application/zip' }], h3yunError: '', oss: [{ key: 'k', name: '审核意见.html' }], local: [{ name: '说明.md', path: '/ws/S/说明.md', size: 20 }], localDir: '/ws/S', localExists: true, truncated: false } } })
  void ops
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  // 让报告更新时间不晚于审核时间 → CURRENT → 无历史会话 → 直进
  const task = { ...PENDING_TASK, modifiedAt: '2026-09-19 10:00' }
  const made = { created: [], renamed: [], prompted: [], opened: [] }
  const port = {
    create: async (input) => { made.created.push(input); return 'session-audit' },
    open: (id) => { made.opened.push(id) },
    binding: () => ({ session: { rename: async (t) => { made.renamed.push(t) }, prompt: async (c, m) => { made.prompted.push({ c, m }) } } }),
    list: { getSnapshot: () => ({ ids: [], byId: {} }) },
  }
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, v) } }
  const props = reportPaneProps({
    state: { tasks: [task], total: 1, ossIndex: { [task.seqNo]: PENDING_CLOUD } },
    onLoadAuditInfo: () => Promise.resolve({ info: auditInfoFixture(), error: '' }),
  })
  // 注意：`openResults` 会 rerender，闭包里用的是**它自己那份 props** ——
  // onOpenDiscussion 必须一起传进去，否则点下去走的是默认空函数（这条踩过一次）。
  const paneProps = { ...props, port, onOpenDiscussion: (id) => { made.opened.push(`open:${id}`) } }
  const view = render(ReportPane, paneProps)
  const results = openResults(ReportPane, paneProps, view.instance)
  const whale = find(results, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn))
  whale.props.onClick()
  for (let i = 0; i < 12; i += 1) await settle()
  assert.equal(made.created.length, 1, '直接建一条会话（不弹框）')
  assert.deepEqual(made.renamed, [`${zhCN.auditSessionPrefix}${task.seqNo}`], '会话名走 audit_analysis 前缀')
  assert.equal(made.prompted.length, 1)
  const sent = made.prompted[0].c[0].text
  assert.equal(sent.includes('你是一名资深资产评估师，正在与当前报告的项目负责人共同分析这份报告及其 AI 审核结果。'), true, 'System Instruction 逐字注入')
  assert.equal(sent.includes('你不得主动读取、搜索、引用或依赖任何未加入当前会话的本地文件、工作区文件、缓存文件或其它文件系统内容。'), true, '数据边界逐字注入')
  assert.equal(sent.includes(task.seqNo), true)
  assert.equal(sent.includes('报告.zip'), true, '原始报告必须在上下文里（§15）')
  assert.equal(sent.includes('说明.md'), false, '本地案例目录的文件不得进上下文（远端-only）')
  assert.equal(sent.includes(zhCN.auditCtxHead), true)
  assert.equal(made.opened.includes('open:session-audit'), true, '建完跳到那条会话')
  // Context Snapshot 落盘（下次打开它判"是否已经过期"）
  const saved = JSON.parse(store.get(`crwu.audit-analysis.${task.seqNo}`))
  assert.equal(saved.reportSerialNumber, task.seqNo)
  assert.equal(saved.reportUpdatedAt, '2026-09-19 10:00')
  assert.equal(saved.auditGeneratedAt, '2026-09-20 17:41:02')
  delete globalThis.localStorage
})

test('点 DeepSeek：已有分析会话 → 弹「继续 / 新建」；资料没变时推荐继续', async () => {
  stubOps({ 'report-files': { body: { ok: true, error: '', seqNo: PENDING_TASK.seqNo, h3yun: [{ field: 'F', fileId: 'f1', name: '报告.zip', size: 1024, contentType: 'application/zip' }], h3yunError: '', oss: [], local: [], localDir: '', localExists: false, truncated: false } } })
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const task = { ...PENDING_TASK, modifiedAt: '2026-09-19 10:00' }
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, v) } }
  // 预置一份与当前完全一致的快照 → changes 全 false
  const { snapshotOf } = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const snap = snapshotOf({ seqNo: task.seqNo, info: auditInfoFixture(), reportUpdatedAt: task.modifiedAt, createdAt: '2026-09-20T00:00:00.000Z' })
  store.set(`crwu.audit-analysis.${task.seqNo}`, JSON.stringify(snap))
  const old = { id: 'session-old', displayTitle: `${zhCN.auditSessionPrefix}${task.seqNo}` }
  const port = {
    create: async () => 'session-new',
    open: () => {},
    binding: () => ({ session: { rename: async () => undefined, prompt: async () => undefined } }),
    list: { getSnapshot: () => ({ ids: [old.id], byId: { [old.id]: old } }) },
  }
  const props = reportPaneProps({
    state: { tasks: [task], total: 1, ossIndex: { [task.seqNo]: PENDING_CLOUD } },
    onLoadAuditInfo: () => Promise.resolve({ info: auditInfoFixture(), error: '' }),
  })
  const opened = []
  const view = render(ReportPane, { ...props, port, onOpenDiscussion: (id) => { opened.push(id) } })
  const results = openResults(ReportPane, { ...props, port }, view.instance)
  const whale = find(results, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn))
  whale.props.onClick()
  for (let i = 0; i < 12; i += 1) await settle()
  const asked = rerender(ReportPane, { ...props, port, onOpenDiscussion: (id) => { opened.push(id) } })
  const dialog = findByClass(asked, WORKBENCH_CLASSES.aiDialog)
  assert.ok(dialog, '已有分析会话要弹选择框')
  const text = textOf(dialog)
  assert.equal(text.includes(zhCN.auditAskExistingTitle), true)
  assert.equal(text.includes(zhCN.auditContinueAnalysis), true)
  assert.equal(text.includes(zhCN.auditNewAnalysis), true)
  assert.equal(text.includes(zhCN.auditUpdatedHint), false, '资料没变时不提"建议新建"')
  // 点「继续上次分析」→ 打开旧会话（不新建）
  findOptionLike(dialog, zhCN.auditContinueAnalysis).props.onClick()
  for (let i = 0; i < 4; i += 1) await settle()
  assert.deepEqual(opened, ['session-old'])
  delete globalThis.localStorage
})

test('点 DeepSeek：远端原始资料一项都取不到 → 只给重试，不 fallback 本地、不建会话', async () => {
  stubOps({ 'report-files': { body: { ok: true, error: '', seqNo: PENDING_TASK.seqNo, h3yun: [], h3yunError: '', oss: [], local: [], localDir: '', localExists: false, truncated: false } } })
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const view = render(ReportPane, reportPaneProps({
    state: { tasks: [PENDING_TASK], total: 1, ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } },
    onLoadAuditInfo: () => Promise.resolve({ info: auditInfoFixture(), error: '' }),
  }))
  const props = reportPaneProps({
    state: { tasks: [PENDING_TASK], total: 1, ossIndex: { [PENDING_TASK.seqNo]: PENDING_CLOUD } },
    onLoadAuditInfo: () => Promise.resolve({ info: auditInfoFixture(), error: '' }),
  })
  const results = openResults(ReportPane, props, view.instance)
  const whale = find(results, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes(WORKBENCH_CLASSES.aiRowBtn))
  whale.props.onClick()
  for (let i = 0; i < 12; i += 1) await settle()
  const asked = rerender(ReportPane, props)
  const dialog = findByClass(asked, WORKBENCH_CLASSES.aiDialog)
  assert.ok(dialog, '缺原始报告必须拦一下')
  const text = textOf(dialog)
  assert.equal(text.includes(zhCN.auditRemoteMissingTitle), true)
  assert.equal(text.includes(zhCN.auditRemoteMissingBody), true, '要说清"为避免用过期/来源不明的数据，本次未创建会话"')
  assert.ok(findOptionLike(dialog, zhCN.auditRetry), '要有重试')
  assert.equal(findOptionLike(dialog, zhCN.auditLimitedProceed), null, '不许有"仍以有限资料继续"（那会去找本地替代）')
})

// ── OSS 一次列举带回的元数据：审核对象 ETag + 报告资料指纹（2026-09-23）──────────

test('审核对象元数据：取审核结果 JSON 的 ETag / 最后写入时间，没有就退回 HTML', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const cloud = {
    jsonKey: 'crwu/audit/S/审核结果.S.json',
    htmlKey: 'crwu/audit/S/审核意见.S.html',
    files: [
      { key: 'crwu/audit/S/审核意见.S.html', name: '审核意见.S.html', size: 254300, lastModified: '2026-09-20 17:11:18', etag: '46f90eb092e15b169f30fcd429d7b885' },
      { key: 'crwu/audit/S/审核结果.S.json', name: '审核结果.S.json', size: 96903, lastModified: '2026-09-20 17:11:19', etag: '4850d73d2a28ca5a70e337afddc16e04' },
    ],
  }
  assert.deepEqual(m.auditArtifactOf(cloud), {
    etag: '4850d73d2a28ca5a70e337afddc16e04',
    lastModified: '2026-09-20 17:11:19',
  })
  // 没有 JSON → 退回 HTML
  assert.deepEqual(m.auditArtifactOf({ ...cloud, jsonKey: '' }).etag, '46f90eb092e15b169f30fcd429d7b885')
  // 旧宿主不带元数据 → 空串（界面按"没有版本证据"处理，不许猜）
  assert.deepEqual(m.auditArtifactOf({ jsonKey: 'k', htmlKey: '', files: [{ key: 'k', name: 'k' }] }), { etag: '', lastModified: '' })
})

test('报告远端标识：只用远端 fileId / OSS key，**不把本地路径当身份**', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const pulled = {
    h3yun: [{ fileId: 'f1', name: '报告.zip' }, { fileId: 'f2', name: '说明.pdf' }],
    oss: [{ key: 'crwu/audit/S/审核意见.S.html' }],
    // 本地那份即使也在，也不参与标识（用户 §11）
    local: [{ name: '报告.docx', path: '/ws/S/报告.docx', size: 1024, version: 'v1' }],
  }
  const base = m.reportRemoteIdOf(pulled)
  assert.equal(base !== '', true)
  assert.equal(m.reportRemoteIdOf(pulled), base, '同一批远端资料 → 同一个标识')
  assert.equal(m.reportRemoteIdOf({ ...pulled, local: [{ name: 'x', path: '/tmp/x' }] }), base, '本地文件变了**不影响**远端标识（localPath 不是业务身份）')
  assert.notEqual(m.reportRemoteIdOf({ ...pulled, h3yun: [{ fileId: 'f9', name: '报告.zip' }] }), base, '远端换了附件 → 标识变')
  assert.notEqual(m.reportRemoteIdOf({ ...pulled, oss: [] }), base, '云端交付件变了 → 标识变')
  assert.equal(m.reportRemoteIdOf({ h3yun: [], oss: [] }), '')
  assert.equal(m.reportRemoteIdOf(null), '')
  // 审核产物的远端标识 = 它的 OSS key（与顺序无关）
  assert.equal(m.auditRemoteIdOf({ htmlKey: 'h', jsonKey: 'j' }), m.auditRemoteIdOf({ htmlKey: 'j', jsonKey: 'h' }))
  assert.equal(m.auditRemoteIdOf({}), '')
})

test('快照比对：远端标识 / ETag 是**远端客观**信号，记录时间没动也能判出"变过"', async () => {
  const { changesSince } = await import(new URL('src/client/features/report-audit/audit-freshness.ts', ROOT).href)
  const snap = {
    reportSerialNumber: 'S', reportUpdatedAt: '2026-09-20 17:00', reportDigest: '',
    reportRemoteId: 'abc123', auditGeneratedAt: '2026-09-20 17:40', auditSourceDigest: '',
    auditRemoteId: 'aud-1', fetchedAt: '2026-09-23T10:00:00.000Z',
    auditEtag: 'aaa', auditLastModified: '2026-09-20 17:40', auditArtifactVersion: '',
    reviewUpdatedAt: '', conversationCreatedAt: '', contextStatus: 'current',
  }
  // 记录时间没动、复核没动，但远端换了附件（远端标识变了）→ 报告已更新（客观）
  assert.deepEqual(
    changesSince(snap, { ...snap, reportRemoteId: 'def456' }),
    { report: true, audit: false, review: false, digest: false, any: true },
  )
  // 审核产物的远端标识 / ETag 变了 → 审核结果重新生成过
  assert.equal(changesSince(snap, { ...snap, auditRemoteId: 'aud-2' }).audit, true)
  assert.equal(changesSince(snap, { ...snap, auditEtag: 'bbb' }).audit, true)
  // 两侧都没有该字段（旧宿主）→ 不猜
  assert.equal(changesSince({ ...snap, reportRemoteId: '' }, { ...snap, reportRemoteId: '' }).report, false)
  assert.equal(changesSince({ ...snap, auditEtag: '', auditRemoteId: '' }, { ...snap, auditEtag: '', auditRemoteId: '' }).audit, false)
})

test('审核摘要里的 ETag 会进入版本证据（供"与上次快照比"用）', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const evidence = m.evidenceOf({
    info: auditInfoFixture(),
    reportUpdatedAt: '2026-09-22 16:30',
    auditEtag: '4850d73d2a28ca5a70e337afddc16e04',
    auditLastModified: '2026-09-20 17:11:19',
  })
  assert.equal(evidence.auditSourceEtag, '4850d73d2a28ca5a70e337afddc16e04')
  assert.equal(evidence.auditModifiedAt, '2026-09-20 17:11:19')
  // 报告侧没有 OSS 对象 → 这一侧仍然缺位；两侧不齐时**不许**拿 audit 的 ETag 去和空值比出 STALE
  const { freshnessOf } = await import(new URL('src/client/features/report-audit/audit-freshness.ts', ROOT).href)
  assert.equal(freshnessOf(evidence).status, 'possibly_stale', '仍按时间退化判断，不伪造强结论')
  // 快照把两者都记下来
  const snap = m.snapshotOf({
    seqNo: 'S', info: auditInfoFixture(), reportUpdatedAt: '2026-09-22 16:30',
    reportRemoteId: 'remote-abc', auditRemoteId: 'aud-xyz',
    auditEtag: evidence.auditSourceEtag, auditLastModified: evidence.auditModifiedAt,
    fetchedAt: '2026-09-23T10:00:00.000Z', createdAt: 'T',
  })
  assert.equal(snap.reportRemoteId, 'remote-abc')
  assert.equal(snap.auditRemoteId, 'aud-xyz')
  assert.equal(snap.fetchedAt, '2026-09-23T10:00:00.000Z')
  assert.equal(snap.auditEtag, '4850d73d2a28ca5a70e337afddc16e04')
  assert.equal(snap.auditLastModified, '2026-09-20 17:11:19')
})

test('AI 审核列表的交付件数量以一次列举真实看到的对象个数为准', async () => {
  stubOps({})
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  // 目录里有 3 个对象（含一个辅助文件）：数量说 3，语义 Chip 仍然只有审核报告 / 审核数据。
  const item = {
    seqNo: PENDING_TASK.seqNo,
    files: [
      { key: 'crwu/audit/S/审核意见.S.html', name: '审核意见.S.html', size: 254300, lastModified: '2026-09-20 17:11:18', etag: '46f9' },
      { key: 'crwu/audit/S/审核结果.S.json', name: '审核结果.S.json', size: 96903, lastModified: '2026-09-20 17:11:19', etag: '4850' },
      { key: 'crwu/audit/S/说明.txt', name: '说明.txt' },
    ],
    htmlKey: 'crwu/audit/S/审核意见.S.html',
    jsonKey: 'crwu/audit/S/审核结果.S.json',
  }
  const props = reportPaneProps({ state: { ossIndex: { [PENDING_TASK.seqNo]: item } } })
  const { tree, instance } = render(ReportPane, props)
  const results = openResults(ReportPane, props, instance)
  const text = textOf(results).replace(/\s+/g, ' ')
  assert.equal(text.includes(zhCN.resultFilesCount.replace('%s', '3')), true, '数量取真实对象个数')
  assert.equal(text.includes(zhCN.resultFileReport), true)
  assert.equal(text.includes(zhCN.resultFileData), true)
  assert.equal(text.includes('说明.txt'), false, '辅助文件不进 Chip（仍然是业务语义）')
})

// ── DeepSeek 会话的统一数据边界：只允许本次会话注入的**远端**资料（2026-09-23 强制）──

test('数据来源清单：只记远端标识，绝不含 localPath', async () => {
  const m = await import(new URL('src/client/features/report-audit/audit-analysis.ts', ROOT).href)
  const refs = m.sourcesOf({
    pulled: {
      h3yun: [{ field: 'F', fileId: 'f1', name: '报告.zip', size: 1024 }],
      oss: [{ key: 'crwu/audit/S/审核结果.S.json', name: '审核结果.S.json', size: 96903, lastModified: '2026-09-20 17:11:19', etag: '4850d73d' }],
      // 本地那份也在对象里 —— 但**不许**变成来源
      local: [{ name: '说明.md', path: '/ws/S/说明.md', size: 20, version: 'v1' }],
    },
    cloud: { htmlKey: 'crwu/audit/S/审核意见.S.html', jsonKey: 'crwu/audit/S/审核结果.S.json' },
    info: auditInfoFixture(),
    fetchedAt: '2026-09-23T10:00:00.000Z',
  })
  assert.equal(refs.every((ref) => ref.sourceType === 'remote'), true, '本地文件系统不是业务来源')
  assert.equal(refs.every((ref) => ref.provider === 'h3yun' || ref.provider === 'oss'), true)
  assert.equal(refs.some((ref) => ref.provider === 'h3yun' && ref.remoteId === 'f1'), true)
  assert.equal(refs.some((ref) => ref.provider === 'oss' && ref.remoteId.endsWith('审核结果.S.json')), true)
  assert.equal(refs.every((ref) => ref.fetchedAt === '2026-09-23T10:00:00.000Z'), true)
  // 来源对象里**没有** localPath 之类的字段：本地路径只能属于内部实现，不是业务来源
  for (const ref of refs) {
    assert.equal('localPath' in ref, false)
    assert.equal(JSON.stringify(ref).includes('/ws/'), false, '来源里不许出现本地路径')
  }
  assert.equal(refs.some((ref) => ref.remoteId === '/ws/S/说明.md'), false)
})

test('报告讨论上下文：写入远端数据边界 + 唯一的案例目录 + 可执行的取数规则', async () => {
  const { discussionBrief } = await import(new URL('src/client/features/report-audit/assistant-context.ts', ROOT).href)
  const text = discussionBrief({
    seqNo: 'S-1', objectId: 'o-1', project: '某项目', name: '某报告', risk: 'B',
    reviewLevel: '初审', reviewState: '审核中', currentNode: '一级复核人',
    modifiedAt: '2026-09-22 16:30', formName: '报告审核',
    // 2026-09-25 用户口径：必须给出唯一允许读写的案例目录，并要求每次新建对话重新从远端下载。
    caseDir: '/Users/me/中瑞世联工作空间/S-1',
    files: ['氚云附件 报告.zip（1.0 MB）', '云端交付件 审核意见.S.html'],
    fetchedAt: '2026-09-23T10:00:00.000Z',
    sources: ['h3yun · 远端标识：f1 · 报告.zip', 'oss · 远端标识：crwu/audit/S/审核意见.S.html'],
  })
  // §12 的数据边界逐字在
  for (const line of [
    '你不得主动读取、搜索、引用或依赖任何未明确加入当前会话的本地文件、工作区文件、缓存文件或其它文件系统内容。',
    '即使你能够访问文件系统工具，也不得将这些工具用于获取当前报告的业务资料。',
    '不得通过其它文件补齐缺失信息。',
  ]) {
    assert.equal(text.includes(line), true, `数据边界要逐字注入：${line.slice(0, 20)}…`)
  }
  // 取数规则（2026-09-25 用户口径「必须束缚模型不能去我电脑的目录里找已有文件」）：
  // 给出**唯一**允许读写的案例目录 + 用哪个 Tool 取 + 每次新建对话都重下 + 禁止扫描本机。
  assert.equal(text.includes(zhCN.aiCaseDirHead), true)
  assert.equal(text.includes('/Users/me/中瑞世联工作空间/S-1'), true, '要给出本次会话的案例目录')
  assert.equal(text.includes(zhCN.aiFetchRulesHead), true)
  assert.equal(text.includes('`h3yun · <远端标识> · <文件名>` 里的**远端标识就是 `fileId`**'), true)
  assert.equal(text.includes('crwu_h3yun_file_get({ fileId, caseDir, relativePath: "材料-源/<落盘名>" })'), true)
  assert.equal(text.includes('**每次新建对话都必须重新下载**'), true)
  assert.equal(text.includes('**禁止**用 `ls`、`find`、`grep`、`glob`'), true)
  assert.equal(text.includes('不要读任何本机路径'), true)
  // 7 条规则逐字钉住：这段文本是**交给模型的作业指令**，改写丢一条就等于少一道约束
  // （安装提示词那次「意思差不多地改写」真的丢过安全指令，所以这里也逐条断言）。
  for (const rule of zhCN.aiFetchRules) {
    assert.equal(text.includes(rule), true, `取数规则要逐字注入：${rule.slice(0, 24)}…`)
  }
  assert.equal(zhCN.aiFetchRules.length, 7)
  // 本地路径**只允许**出现案例目录这一条（别的路径一概不许进上下文）
  const localPaths = text.match(/\/Users\/[^\s」、）)]*/g) ?? []
  assert.deepEqual([...new Set(localPaths)], ['/Users/me/中瑞世联工作空间/S-1'], '本地路径只允许出现案例目录这一条')
  assert.equal(/\/tmp\/|\/ws\/|\/cases\//.test(text), false, '别的本地路径不许出现')
  for (const forbidden of ['本地案例目录', '本地已经', '工作区下面', '从本地读取', '本地缓存']) {
    assert.equal(text.includes(forbidden), false, `不许提示模型去本地找：${forbidden}`)
  }
  // 没给案例目录（旧宿主）时整段不写：宁可不给，也不给半截路径。
  const without = discussionBrief({
    seqNo: 'S-1', objectId: '', project: '', name: '', risk: '', reviewLevel: '', reviewState: '',
    currentNode: '', modifiedAt: '', formName: '', caseDir: '', files: [], fetchedAt: '',
    sources: [],
  })
  assert.equal(without.includes(zhCN.aiCaseDirHead), false)
  assert.equal(without.includes(zhCN.aiFetchRulesHead), false)
  // 远端资料与来源清单都在
  assert.equal(text.includes('氚云附件 报告.zip'), true)
  assert.equal(text.includes('云端交付件 审核意见.S.html'), true)
  assert.equal(text.includes(zhCN.auditCtxSourceHead), true)
  assert.equal(text.includes('h3yun · 远端标识：f1'), true)
})

test('点小鲸鱼：远端一项都取不到（只有本地文件）→ 不建会话，也不读本地', async () => {
  // 远端两侧都空、只有本地案例目录有文件：**这正是"fallback 到本地"的诱饵**。
  const ops = stubOps({
    'report-files': { body: { ok: true, error: '', seqNo: PENDING_TASK.seqNo, h3yun: [], h3yunError: '', oss: [], local: [{ name: '报告.docx', path: '/ws/S/报告.docx', size: 1024, version: 'v1' }], localDir: '/ws/S', localExists: true, truncated: false } },
  })
  const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
  const made = { created: [], prompted: [] }
  const port = {
    create: async () => { made.created.push('x'); return 'session-1' },
    open: () => {},
    binding: () => ({ session: { rename: async () => undefined, prompt: async (c) => { made.prompted.push(c) } } }),
    list: { getSnapshot: () => ({ ids: [], byId: {} }) },
  }
  const props = reportPaneProps({ state: { tasks: [PENDING_TASK], total: 1, ossIndex: {} } })
  const { tree } = render(ReportPane, { ...props, port })
  const whale = findByClass(tree, WORKBENCH_CLASSES.aiRowBtn)
  whale.props.onClick()
  for (let i = 0; i < 10; i += 1) await settle()
  const after = rerender(ReportPane, { ...props, port })
  assert.deepEqual(made.created, [], '远端没有资料时**不许**建会话')
  assert.deepEqual(made.prompted, [], '更不许把本地文件路径发进会话')
  const dialog = findByClass(after, WORKBENCH_CLASSES.aiDialog)
  assert.ok(dialog, '要给"远端资料拿不到"的提示')
  assert.equal(textOf(dialog).includes(zhCN.auditRemoteMissingTitle), true)
  assert.ok(findOptionLike(dialog, zhCN.auditRetry), '只给重试')
  assert.equal(textOf(after).includes('/ws/S/报告.docx'), false, '界面上也不回显"我们有本地这份"')
  assert.equal(ops.includes('oss-result'), false, '没资料就不该继续往后走')
})

// ── 自助更新界面（Task 6）─────────────────────────────────────────────────────

const { createUpdateStore } = await import(new URL('src/client/features/update/update-store.ts', ROOT).href)
const { createUpdateApi } = await import(new URL('src/client/features/update/api.ts', ROOT).href)

const UPDATE_NOW = Date.parse('2026-09-28T10:00:00.000Z')

/** 一份合法的 `update-*` 应答信封；用例按需覆盖 check / install。 */
function updateOk(patch = {}) {
  return { ok: true, check: { status: 'idle' }, install: { status: 'idle' }, ...patch }
}

function updateCandidate(patch = {}) {
  return {
    currentVersion: '9.9.9',
    targetVersion: '9.9.10',
    sourceKind: 'npmmirror',
    checkedAt: '2026-09-28T10:00:00.000Z',
    expiresAt: '2026-10-28T10:00:00.000Z',
    ...patch,
  }
}

function updateAvailable(patch = {}) {
  return { status: 'available', checkedAt: '2026-09-28T10:00:00.000Z', candidate: updateCandidate(), ...patch }
}

function updateInstalling(stage = 'connecting', patch = {}) {
  return { status: 'installing', stage, targetVersion: '9.9.10', startedAt: '2026-09-28T10:00:00.000Z', ...patch }
}

function updateAwaiting(patch = {}) {
  return { status: 'awaiting-restart', targetVersion: '9.9.10', installedAt: '2026-09-28T10:00:05.000Z', ...patch }
}

/** 只回固定应答的更新 API 替身（记录操作名，不碰 global fetch）。 */
function fakeUpdateApi(responses = {}) {
  const calls = []
  const respond = async (operation) => {
    calls.push(operation)
    const entry = responses[operation]
    return typeof entry === 'function' ? await entry() : (entry ?? updateOk())
  }
  return {
    calls,
    countOf: (operation) => calls.filter((call) => call === operation).length,
    updateStatus: () => respond('update-status'),
    updateCheck: () => respond('update-check'),
    updateInstall: () => respond('update-install'),
    updateCancel: () => respond('update-cancel'),
  }
}

/** 一个不联网的 env 状态 store 替身（侧栏入口需要它才能渲染）。 */
function fakeEnvStore(patch = {}) {
  const snapshot = { busy: false, error: '', env: null, ...patch }
  return { get: () => snapshot, subscribe: () => () => {}, refresh: async () => snapshot }
}

/** 更新面板开关状态的替身：只回答"开着没有"。 */
function fakeDialogStore(open) {
  return { get: () => ({ open }), open: () => {}, close: () => {}, subscribe: () => () => {}, dispose: () => {} }
}

/** 空 scheduler：测试里绝不创建真实定时器（轮询计时器会把测试进程拖住不退出）。 */
function noTimers() {
  return { schedule: () => () => {} }
}

/**
 * 只回答一份固定快照的 update store 替身。
 *
 * 内容断言（面板渲染出什么）用它：`error` / `install` 这类字段是 store 的**内部状态**，
 * 没法从 wire 信封注入，而 store 自身的行为已经由 `client-update.test.mjs` 逐条覆盖。
 */
function updateStoreStub(snapshot) {
  const full = {
    initialized: true, check: null, install: null, installCurrent: true, checkOrigin: null,
    checking: false, installing: false, cancelling: false, error: null, ...snapshot,
  }
  return {
    get: () => full,
    subscribe: () => () => {},
    initialize: async () => full,
    check: async () => full,
    install: async () => full,
    cancel: async () => full,
    refreshStatus: async () => full,
    dispose: () => {},
  }
}

/** 用固定应答装好的 update store（真实 store，注入 API 与空 scheduler，不联网、不起真定时器）。 */
async function updateStoreWith(snapshot) {
  const store = createUpdateStore({
    api: fakeUpdateApi({ 'update-status': updateOk(snapshot) }),
    scheduler: noTimers(),
  })
  await store.initialize()
  return store
}

/**
 * 挂上主面板（更新面板开着），返回展开后的元素树。
 *
 * 内容断言走**面板**而不是单独渲染 `UpdateDialog`：这样在基线（还没有更新界面）上，
 * 这些用例是**行为失败**（树里根本没有那个 dialog），而不是"模块找不到"。
 */
async function panelWithUpdate(snapshot, patch = {}) {
  installDoc()
  const { auditActive = false, ...rest } = patch
  stubOps({
    boot: { body: bootOk() },
    env: { body: okEnvBody() },
    // 「有审核在跑」走真实链路：面板读 audit-status 的 active.key 才知道自己被占用。
    ...(auditActive
      ? { 'audit-status': { body: { ok: true, audits: [], parentSessionId: '', active: { key: '2026-301705-LX10170', childId: 'child-1', since: 1 } } } }
      : {}),
  })
  const update = updateStoreStub(snapshot)
  const props = {
    services: fakeServices(),
    build: fakeBuildStore({ version: '9.9.9' }),
    update,
    updateDialog: fakeDialogStore(true),
    now: () => UPDATE_NOW,
    platform: 'mac',
    ...rest,
  }
  const rendered = render(WorkbenchPanel, props)
  for (const effect of rendered.instance.effects) await effect.callback()
  await settle()
  const tree = rerender(WorkbenchPanel, props)
  return auditActive ? rerender(WorkbenchPanel, props) : tree
}

/** 面板里那颗按钮（按文字找，避免依赖类名顺序）。 */
function buttonByLabel(node, label) {
  return find(node, (item) => item.type === 'button' && textOf(item).includes(label))
}

test('启动自动检查是静默的：只改徽标、不弹更新面板，两个消费者共用一次请求', async () => {
  installDoc()
  const ops = stubOps({
    boot: { body: bootOk() },
    env: { body: okEnvBody() },
    'update-status': { body: updateOk({ check: { status: 'idle' } }) },
    'update-check': { body: updateOk({ check: updateAvailable() }) },
  })
  // 唯一一份 update store：侧栏徽标与主面板共用（apply 里就是这么接的）。
  const update = createUpdateStore({ api: createUpdateApi(), scheduler: noTimers() })
  const updateDialog = fakeDialogStore(false)
  const build = fakeBuildStore({ version: '9.9.9' })
  const entryProps = {
    store: fakeEnvStore(), build, update, updateDialog, onOpen: () => {},
  }

  const entry = render(WorkbenchSidebarEntry, entryProps)
  for (const effect of entry.instance.effects) await effect.callback()
  await settle()
  // 侧栏用**它自己**的实例重渲染（rerender 认的是最近一次 render 的实例）。
  const entryTree = rerender(WorkbenchSidebarEntry, entryProps)
  assert.equal(find(entryTree, (node) => node.props?.role === 'dialog'), null, '侧栏不该弹窗')

  // 徽标说清「有更新」，而且它自己是更新入口
  const badge = findByClass(entryTree, WORKBENCH_CLASSES.updateBadge)
  assert.ok(badge !== null, '侧栏徽标要能被找到（更新入口）')
  assert.equal(textOf(badge), 'v9.9.9 · 有更新')
  assert.equal(badge.type, 'button', '徽标本身才是更新入口')

  const panel = render(WorkbenchPanel, {
    services: fakeServices(), build, update, updateDialog, now: () => UPDATE_NOW,
  })
  for (const effect of panel.instance.effects) await effect.callback()
  await settle()
  assert.equal(find(panel.tree, (node) => node.props?.role === 'dialog'), null, '面板也不该自动弹窗')
  assert.equal(updateDialog.get().open, false)

  // 两个消费者各调一次 initialize()，但只打了一次请求（store 的幂等 + 单飞）
  assert.equal(ops.filter((op) => op === 'update-status').length, 1, 'update-status 只发一次')
  assert.equal(ops.filter((op) => op === 'update-check').length, 1, 'update-check 只发一次')
  update.dispose()
})

test('点击侧栏版本徽标：打开面板并弹出更新面板（卡头仍是纯标题）', async () => {
  installDoc()
  const update = await updateStoreWith({ check: updateAvailable() })
  let opened = 0
  const props = {
    store: fakeEnvStore(),
    build: fakeBuildStore({ version: '9.9.9' }),
    update,
    updateDialog: fakeDialogStore(false),
    onOpen: () => {},
    onOpenUpdate: () => { opened += 1 },
  }
  const entry = render(WorkbenchSidebarEntry, props)
  for (const effect of entry.instance.effects) await effect.callback()
  await settle()
  const tree = rerender(WorkbenchSidebarEntry, props)

  const badge = findByClass(tree, WORKBENCH_CLASSES.updateBadge)
  assert.equal(badge.type, 'button')
  badge.props.onClick()
  assert.equal(opened, 1, '点徽标要打开更新入口（apply 里 = 打开面板 + 打开更新面板）')

  // 卡头整体仍然不可点
  const head = findByClass(tree, WORKBENCH_CLASSES.sideCardHead)
  assert.notEqual(head.type, 'button')
  assert.equal(head.props.onClick, undefined)
})

test('更新面板展示当前/目标版本、发布时间与公开来源，且不出现私有源地址或凭据', async () => {
  const poisoned = {
    ...updateAvailable(),
    candidate: {
      ...updateCandidate({ publishedAt: '2026-09-27T02:00:00.000Z' }),
      registryUrl: 'https://npm.corp.example.com/private',
      token: 'SECRET-TOKEN',
      log: 'pnpm ERR! full log',
      requestId: 'req-1',
    },
    error: 'Host 原文错误',
  }
  const tree = await panelWithUpdate({ check: poisoned })
  const dialog = find(tree, (node) => node.props?.role === 'dialog')
  assert.ok(dialog !== null, '更新面板要被渲染出来')
  const text = textOf(dialog)
  assert.ok(text.includes('9.9.9'), '要显示当前版本')
  assert.ok(text.includes('9.9.10'), '要显示目标版本')
  assert.ok(text.includes(zhCN.updateFieldPublished), '要显示发布时间这一行')
  assert.equal(text.includes(zhCN.updateSourceNpmmirror), true, '来源用本地中文标签')
  for (const leak of ['npm.corp.example.com', 'SECRET-TOKEN', 'pnpm ERR', 'req-1', 'Host 原文错误', 'registryUrl']) {
    assert.equal(text.includes(leak), false, `不得展示 ${leak}`)
  }
})

test('安装阶段用诚实地离散中文，且不伪造百分比', async () => {
  for (const [stage, label] of [
    ['connecting', zhCN.updateStageConnecting],
    ['downloading', zhCN.updateStageDownloading],
    ['installing', zhCN.updateStageInstalling],
    ['cancelling', zhCN.updateStageCancelling],
  ]) {
    const tree = await panelWithUpdate({ install: updateInstalling(stage), installing: true })
    const text = textOf(find(tree, (node) => node.props?.role === 'dialog'))
    assert.equal(text.includes(label), true, `阶段 ${stage} 要说清在做什么`)
    assert.equal(text.includes('%'), false, '不伪造百分比')
  }
})

test('禁用状态逐项给出原因（八种），且安装按钮真的 disabled', async () => {
  const cases = [
    ['development-install', { check: { status: 'unsupported', reason: 'development-install' } }, {}],
    ['enterprise-registry', { check: { status: 'unsupported', reason: 'enterprise-registry' } }, {}],
    ['manager-unavailable', { check: { status: 'unsupported', reason: 'manager-unavailable' } }, {}],
    ['candidate-expired', { check: updateAvailable({ candidate: updateCandidate({ expiresAt: '2026-09-28T09:00:00.000Z' }) }) }, {}],
    ['install-active', { check: updateAvailable(), install: updateInstalling('installing') }, { installing: true }],
    ['awaiting-restart', { check: updateAvailable(), install: updateAwaiting() }, {}],
    ['no-candidate', { check: { status: 'up-to-date', checkedAt: '2026-09-28T10:00:00.000Z' } }, {}],
  ]
  const expected = {
    'development-install': zhCN.updateReasonDevelopment,
    'enterprise-registry': zhCN.updateReasonEnterprise,
    'manager-unavailable': zhCN.updateReasonManagerUnavailable,
    'candidate-expired': zhCN.updateReasonCandidateExpired,
    'audit-active': zhCN.updateReasonAuditActive,
    'install-active': zhCN.updateReasonInstallActive,
    'awaiting-restart': zhCN.updateReasonAwaitingRestart,
    'no-candidate': zhCN.updateReasonNoCandidate,
  }
  for (const [reason, snapshot, extra] of cases) {
    const tree = await panelWithUpdate(snapshot, extra)
    const dialog = find(tree, (node) => node.props?.role === 'dialog')
    const install = buttonByLabel(dialog, zhCN.updateActionInstall)
    if (reason === 'awaiting-restart') {
      assert.equal(install, null, '等待重启时连安装按钮都不给')
      assert.ok(buttonByLabel(dialog, zhCN.updateActionOk) !== null, '只给「我知道了」')
    } else {
      assert.ok(install !== null, `${reason}: 要有安装按钮`)
      assert.equal(install.props.disabled, true, `${reason}: 安装按钮必须 disabled`)
    }
    assert.equal(textOf(dialog).includes(expected[reason]), true, `${reason}: 要说清原因`)
  }
  const ok = await panelWithUpdate({ check: updateAvailable() })
  assert.equal(buttonByLabel(ok, zhCN.updateActionInstall).props.disabled, false)

  // 「有审核在跑」这一种走组件级：面板里的 audit-busy 来自 audit-status RPC，
  // 而 View Model 的 auditBusy → audit-active 映射由 client-update.test.mjs 单独钉住。
  const { UpdateDialog } = await import(new URL('src/client/features/update/UpdateDialog.tsx', ROOT).href)
  const audited = render(UpdateDialog, {
    snapshot: updateStoreStub({ check: updateAvailable() }).get(),
    currentVersion: '9.9.9', nowMs: UPDATE_NOW, platform: 'mac', auditBusy: true, onClose: () => {},
  })
  assert.equal(buttonByLabel(audited.tree, zhCN.updateActionInstall).props.disabled, true, 'audit-active 也要禁用安装')
  assert.equal(textOf(audited.tree).includes(zhCN.updateReasonAuditActive), true)
})

test('错误按动作分派：手动检查失败可见、后台失败不打断、安装/取消失败各说各的', async () => {
  const manualCheck = await panelWithUpdate({ error: { action: 'check', origin: 'manual', code: 'transport' } })
  assert.equal(textOf(manualCheck).includes(zhCN.updateCheckFailedManual), true, '手动检查失败要可见')

  const background = await panelWithUpdate({ check: updateAvailable(), error: { action: 'poll', origin: 'background', code: 'transport' } })
  assert.equal(textOf(background).includes(zhCN.updateCheckFailedManual), false, '后台失败不打断用户')

  const installFailed = await panelWithUpdate({ check: updateAvailable(), error: { action: 'install', origin: 'manual', code: 'transport' } })
  const installText = textOf(installFailed)
  assert.equal(installText.includes(zhCN.updateInstallFailed), true, '安装失败要显示安装错误')
  assert.equal(installText.includes(zhCN.updateCheckFailedManual), false, '安装失败不能说成检查失败')

  const cancelFailed = await panelWithUpdate({
    check: updateAvailable(), install: updateInstalling('installing'), error: { action: 'cancel', origin: 'manual', code: 'transport' },
  })
  const cancelText = textOf(cancelFailed)
  assert.equal(cancelText.includes(zhCN.updateCancelFailed), true, '取消失败要显示取消错误')
  assert.equal(cancelText.includes(zhCN.updateCheckFailedManual), false)
  assert.equal(cancelText.includes(zhCN.updateInstallFailed), false)
})

test('等待重启：逐字说明 + macOS 退出方式 + 只有「我知道了」，没有立即重启', async () => {
  const tree = await panelWithUpdate({ check: updateAvailable(), install: updateAwaiting() })
  const dialog = find(tree, (node) => node.props?.role === 'dialog')
  const text = textOf(dialog)
  assert.equal(text.includes(zhCN.updateInstalledLine.replace('{version}', '9.9.10')), true, '安装完成那句要逐字出现')
  assert.equal(text.includes('关闭窗口不一定退出应用'), true, 'macOS 要说清关闭窗口 ≠ 退出')
  assert.equal(text.includes('Command-Q'), true, 'macOS 要给键盘方式')
  assert.ok(buttonByLabel(dialog, zhCN.updateActionOk) !== null, '等待重启时给「我知道了」')
  assert.equal(buttonByLabel(dialog, zhCN.updateActionInstall), null, '等待重启时不再给安装')
  assert.equal(buttonByLabel(dialog, zhCN.updateActionCancel), null)
  assert.equal(text.includes('立即重启'), false)

  // 非 macOS 不给 macOS 专门的说明
  const other = await panelWithUpdate({ install: updateAwaiting() }, { platform: 'other' })
  assert.equal(textOf(other).includes('Command-Q'), false)
})

test('协议不一致继续拦审核，且提示以「完全退出并重新打开 DeepSeek Harness」为准', () => {
  installDoc()
  stubOps({ boot: { body: bootOk({ protocol: WORKBENCH_PROTOCOL - 1 }) }, env: { body: okEnvBody() } })
  const { tree } = render(WorkbenchPanel, {
    services: fakeServices(),
    build: fakeBuildStore({ protocol: WORKBENCH_PROTOCOL - 1 }),
  })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.hostStaleTitle), true)
  assert.equal(zhCN.hostStaleTitle.includes('完全退出并重新打开 DeepSeek Harness'), true, '提示要指名"完全退出并重新打开"')
  assert.equal(zhCN.hostStaleGate.includes('完全退出并重新打开 DeepSeek Harness'), true)
  assert.equal(text.includes('重启 profile'), false, '不要再只说含糊的"重启 profile"')
})

test('更新面板有无障碍语义：role/aria-modal/关联标题/关闭按钮，Esc 在安全时关闭', async () => {
  // 这一条直接渲染面板组件本体（Esc 监听器长在它身上，面板外壳里拿不到它的 effect）。
  const { UpdateDialog } = await import(new URL('src/client/features/update/UpdateDialog.tsx', ROOT).href)
  const snapshot = {
    initialized: true, check: updateAvailable(), install: null, installCurrent: true, checkOrigin: null,
    checking: false, installing: false, cancelling: false, error: null,
  }
  const closed = []
  const rendered = render(UpdateDialog, {
    snapshot, currentVersion: '9.9.9', nowMs: UPDATE_NOW, platform: 'mac', onClose: () => { closed.push('x') },
  })
  const dialog = find(rendered.tree, (node) => node.props?.role === 'dialog')
  assert.ok(dialog !== null, '必须是 role=dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(typeof dialog.props['aria-labelledby'], 'string', '标题要能被关联')
  assert.ok(find(rendered.tree, (node) => node.props?.id === dialog.props['aria-labelledby']) !== null, '关联的标题必须真的存在')
  assert.ok(buttonByLabel(rendered.tree, zhCN.updateActionClose) !== null, '要有明确关闭按钮')

  // 键盘处理挂在 dialog 元素上（随 render 原子更新）：Esc 由它处理。
  for (const effect of rendered.instance.effects) await effect.callback()
  const escOf = (tree) => find(tree, (node) => node.props?.role === 'dialog').props.onKeyDown
  assert.equal(typeof escOf(rendered.tree), 'function', '要能处理 Escape')
  escOf(rendered.tree)({ key: 'Escape' })
  assert.equal(closed.length, 1, '安全状态下 Esc 关闭')

  // 安装进行中：Esc 与遮罩都不关闭（避免误触丢状态），关闭按钮仍在
  const busy = render(UpdateDialog, {
    snapshot: { ...snapshot, install: updateInstalling('installing'), installing: true },
    currentVersion: '9.9.9', nowMs: UPDATE_NOW, platform: 'mac', onClose: () => { closed.push('busy') },
  })
  for (const effect of busy.instance.effects) await effect.callback()
  escOf(busy.tree)({ key: 'Escape' })
  assert.equal(closed.length, 1, '安装中 Esc 不关闭')
  const backdrop = findByClass(busy.tree, WORKBENCH_CLASSES.updateDialogBackdrop)
  assert.equal(backdrop.props.onClick, undefined, '安装中遮罩不可点关闭')
  assert.ok(buttonByLabel(busy.tree, zhCN.updateActionClose) !== null, '关闭按钮始终在（可访问性）')
})

// ── Task 6 审查修正：真实装配 / 审核占用 / 空版本 / 模态焦点 ────────────────────

/** 一个能模拟"焦点"的 document 替身：给弹窗的焦点接管与 Tab 循环用。 */
function fakeFocusDocument(elements = null) {
  const listeners = []
  const doc = {
    activeElement: null,
    getElementById: () => dialogNode,
    createElement: () => ({ id: '', dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
    addEventListener: (type, listener) => { listeners.push({ type, listener }) },
    removeEventListener: (type, listener) => {
      const index = listeners.findIndex((one) => one.type === type && one.listener === listener)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  // 元素带 tag/disabled，**真的按传入 selector 过滤**：看不见 disabled 不入选、
  // summary 只有选择器里写了才会出现 —— 否则焦点循环测试就是假通过。
  const nodes = (elements ?? [
    { name: 'close', tag: 'button' },
    { name: 'check', tag: 'button' },
    { name: 'install', tag: 'button' },
  ]).map((spec) => ({
    name: spec.name,
    tag: spec.tag,
    disabled: spec.disabled === true,
    focus() { doc.activeElement = this },
  }))
  const matches = (node, selector) => selector.split(',').map((one) => one.trim()).some((token) => {
    const tag = token.replace(/:not\(\[disabled\]\)$/, '').replace(/\[.*$/, '')
    if (node.tag !== tag) return false
    if (token.includes(':not([disabled])') && node.disabled) return false
    return true
  })
  const dialogNode = {
    focusables: () => nodes.filter((node) => !node.disabled),
    querySelectorAll: (selector) => nodes.filter((node) => matches(node, selector)),
    focus() { doc.activeElement = dialogNode },
  }
  return { doc, listeners, dialogNode, focused: [] }
}

test('apply 真实装配：点侧栏版本徽标 = 打开面板 + 打开同一份更新弹窗（卡头仍不可点）', () => {
  installDoc()
  const selected = []
  const { ctx, registrations } = fakeClientContext({ selectPanel: (key) => { selected.push(key) } })
  stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
  apply(ctx)

  const sidebar = registrations.find((entry) => entry.meta.name === 'sidebar.footer.action')
  const main = registrations.find((entry) => entry.meta.name === 'main')
  assert.ok(sidebar !== undefined && main !== undefined)

  // 从 apply 注册出来的**真实**侧栏组件开始（不手工注入 onOpenUpdate）
  // 只断言**装配出来的**界面形状与点击行为，不跑那些会打 RPC 的挂载 effect：
  // 徽标在首次渲染时就已经是可点按钮（文案随 store 快照走，与 effect 无关）。
  const sidebarProps = { wide: true, usePanelInfo: () => false }
  const tree = render(sidebar.component, sidebarProps).tree

  const badge = findByClass(tree, WORKBENCH_CLASSES.updateBadge)
  assert.equal(badge.type, 'button', '真实装配下徽标必须是可点按钮')
  assert.equal(typeof badge.props.onClick, 'function', 'apply 必须把 onOpenUpdate 接上（缺了就点不动）')
  // 卡头仍然是纯标题：不可点
  const head = findByClass(tree, WORKBENCH_CLASSES.sideCardHead)
  assert.notEqual(head.type, 'button')
  assert.equal(head.props.onClick, undefined)

  badge.props.onClick()
  assert.deepEqual(selected, ['crwu-workbench'], '点徽标要 selectPanel(WORKBENCH_PANEL_KEY)')

  // main 组件读的是**同一份** updateDialog：它现在应该渲染出 role=dialog
  const panelTree = render(main.component, {}).tree
  assert.ok(find(panelTree, (node) => node.props?.role === 'dialog') !== null, '同一份 dialog store 要变 open 并渲染出更新弹窗')
  assert.equal(textOf(panelTree).includes(zhCN.updateDialogTitle), true, '渲染出来的就是更新面板')

  // 并且没有第二份 store：侧栏这一次点击只让 main 那份开了
  assert.equal(selected.length, 1)
})


test('Host 还没回报版本时不得显示孤立的 v（徽标、悬停说明、弹窗当前版本）', async () => {
  for (const unknown of [{ version: '', rev: '' }, { version: '', rev: '' , buildKind: ''}]) {
    installDoc()
    stubOps({ boot: { body: bootOk() }, env: { body: okEnvBody() } })
    const update = updateStoreStub({ check: updateAvailable() })
    const props = {
      services: fakeServices(),
      build: fakeBuildStore({ ...unknown }),
      update,
      updateDialog: fakeDialogStore(true),
      now: () => UPDATE_NOW,
    }
    const rendered = render(WorkbenchPanel, props)
    for (const effect of rendered.instance.effects) await effect.callback()
    await settle()
    const tree = rerender(WorkbenchPanel, props)
    const dialog = find(tree, (node) => node.props?.role === 'dialog')
    const text = textOf(dialog)
    assert.equal(text.includes('vundefined'), false)
    assert.equal(text.includes('vnull'), false)
    // 「当前版本」那一行的值必须是"未知"口径，而不是孤立的 v
    const row = find(dialog, (node) => node.props?.children === zhCN.updateFieldCurrent)
    assert.ok(row !== null, '要有"当前版本"这一行')
    assert.equal(text.includes(zhCN.updateFieldCurrent), true)
    const kvText = textOf(find(dialog, (node) => String(node.props?.className ?? '').includes(WORKBENCH_CLASSES.kv)))
    assert.equal(kvText.includes(`${zhCN.updateFieldCurrent}未知`) || kvText.includes(`${zhCN.updateFieldCurrent}v`), true)
    assert.equal(/当前版本\s*v(?![0-9])/.test(kvText), false, '不许出现孤立的 v')
  }
})


// ── Task 6 第 3 轮：轮询 cleanup / summary 焦点 / critical 陈旧窗口 ──────────────

/**
 * 挂载面板若干轮，**收集每一轮 effect 返回的 cleanup**。
 *
 * 为什么必须收集：审核模块激活后每轮都会 `setInterval(refreshAudits, 10_000)`，
 * 测试如果只跑 effect 不跑 cleanup，进程会被这些定时器拖住不退出（既泄漏句柄，
 * 又可能让上一组的轮询读已经替换掉的全局 fetch）。
 */
async function mountPanelRounds(props, rounds = 3) {
  const cleanups = []
  let tree = render(WorkbenchPanel, props).tree
  for (let round = 0; round < rounds; round += 1) {
    for (const effect of globalThis.__crwuTestInstance.effects) {
      const cleanup = await effect.callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    await settle()
    tree = rerender(WorkbenchPanel, props)
  }
  return { tree, cleanups }
}

/** 逆序执行 cleanup（React 的卸载顺序），任何一步抛错都不影响其余释放。 */
function unmountAll(cleanups) {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup()
    } catch (error) {
      // 释放阶段的异常不该掩盖用例结论，但要如实抛出来让人看见。
      throw error
    }
  }
}

test('审核在跑：active.key 禁用安装；卸载后不留轮询定时器（测试进程能自然退出）', async () => {
  const active = { key: '2026-301705-LX10170', childId: 'child-1', since: 1 }
  const body = (activeKey) => ({
    boot: { body: bootOk() },
    env: { body: okEnvBody() },
    pending: { body: { ok: true, error: '', rows: [], formName: '报告审核', page: 1, size: 20, total: 0, query: '', filterMode: '', escalated: false, escalateAvailable: false } },
    'audit-status': { body: { ok: true, audits: [], parentSessionId: '', active: { ...active, key: activeKey } } },
    'oss-index': { body: { ok: true, error: '', bucket: 'b', prefix: '', count: 0, items: {}, truncated: false } },
  })
  const { createModuleStore } = await import(new URL('src/client/features/workbench/module-store.ts', ROOT).href)

  const runScenario = async (activeKey) => {
    installDoc()
    const ops = stubOps(body(activeKey))
    const modules = createModuleStore()
    modules.navigate('audit', { state: 'ready' })
    const props = {
      services: fakeServices(),
      modules,
      build: fakeBuildStore({ version: '9.9.9' }),
      update: updateStoreStub({ check: updateAvailable() }),
      updateDialog: fakeDialogStore(true),
      now: () => UPDATE_NOW,
      platform: 'mac',
    }
    const { tree, cleanups } = await mountPanelRounds(props)
    return { tree, cleanups, ops }
  }

  // 第一组：Host 确认有审核在跑
  const first = await runScenario(active.key)
  try {
    assert.equal(first.ops.filter((op) => op === 'audit-status').length > 0, true, '面板要真的问过 audit-status')
    const dialog = find(first.tree, (node) => node.props?.role === 'dialog')
    assert.equal(buttonByLabel(dialog, zhCN.updateActionInstall).props.disabled, true, '已有审核在运行时必须禁用安装')
    assert.equal(textOf(dialog).includes(zhCN.updateReasonAuditActive), true)
  } finally {
    // 必须在切到 idle 场景之前**完整卸载**（否则第一组的轮询会跨场景读新的 fetch）
    unmountAll(first.cleanups)
  }

  // 第二组：没有审核在跑（报告列表加载不算）
  const second = await runScenario('')
  try {
    const dialog = find(second.tree, (node) => node.props?.role === 'dialog')
    assert.equal(textOf(dialog).includes(zhCN.updateReasonAuditActive), false, '没有审核在跑就不能说"有审核任务正在进行"')
    assert.equal(buttonByLabel(dialog, zhCN.updateActionInstall).props.disabled, false)
  } finally {
    unmountAll(second.cleanups)
  }
})

test('诊断信息 summary 参与焦点循环（Tab 能到达、首尾能循环）', async () => {
  const { UpdateDialog } = await import(new URL('src/client/features/update/UpdateDialog.tsx', ROOT).href)
  const fake = fakeFocusDocument([
    { name: 'close', tag: 'button' },
    { name: 'check', tag: 'button' },
    { name: 'install', tag: 'button' },
    { name: 'diag', tag: 'summary' },
  ])
  globalThis.document = fake.doc
  const rendered = render(UpdateDialog, {
    snapshot: updateStoreStub({ check: updateAvailable() }).get(),
    currentVersion: '9.9.9', nowMs: UPDATE_NOW, platform: 'mac', onClose: () => {},
  })
  const cleanups = rendered.instance.effects.map((effect) => effect.callback())
  try {
    // summary 必须在"当前可用可聚焦元素"里（选择器漏了它，键盘用户永远到不了诊断信息）
    assert.deepEqual(
      fake.dialogNode.focusables().map((one) => one.name),
      ['close', 'check', 'install', 'diag'],
      'summary 必须在焦点循环里',
    )
    const dialog = find(rendered.tree, (node) => node.props?.role === 'dialog')
    const onKeyDown = dialog.props.onKeyDown
    assert.equal(typeof onKeyDown, 'function', '键盘处理必须挂在 dialog 元素上（随 render 原子更新）')

    fake.doc.activeElement = fake.dialogNode.focusables().at(-1)
    onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() {} })
    assert.equal(fake.doc.activeElement.name, 'close', 'Tab 从最后一项回到第一项')

    fake.doc.activeElement = fake.dialogNode.focusables()[0]
    onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() {} })
    assert.equal(fake.doc.activeElement.name, 'diag', 'Shift+Tab 从第一项回到最后一项（也就是 summary）')

    // disabled 的控件不进入循环
    const disabled = fakeFocusDocument([
      { name: 'close', tag: 'button' },
      { name: 'install', tag: 'button', disabled: true },
    ])
    globalThis.document = disabled.doc
    assert.deepEqual(disabled.dialogNode.focusables().map((one) => one.name), ['close'], 'disabled 不入循环')

    // 打开后焦点进入弹窗
    globalThis.document = fake.doc
    fake.doc.activeElement = { name: 'outside', focus() { fake.doc.activeElement = this } }
    const reopened = render(UpdateDialog, {
      snapshot: updateStoreStub({ check: updateAvailable() }).get(),
      currentVersion: '9.9.9', nowMs: UPDATE_NOW, platform: 'mac', onClose: () => {},
    })
    const reopenCleanups = reopened.instance.effects.map((effect) => effect.callback())
    assert.equal(fake.doc.activeElement.name, 'close', '打开后焦点进入弹窗（第一个可用控件）')
    // 关闭/卸载：焦点还给打开前的元素
    const outside = fake.doc.activeElement
    unmountAll(reopenCleanups)
    assert.notEqual(fake.doc.activeElement, outside, '卸载后不再停在弹窗里')
  } finally {
    unmountAll(cleanups)
  }
})

test('critical 状态跃迁：rerender 成 installing 后立即按 Esc 不得关闭（不等被动 effect）', async () => {
  const { UpdateDialog } = await import(new URL('src/client/features/update/UpdateDialog.tsx', ROOT).href)
  const fake = fakeFocusDocument([{ name: 'close', tag: 'button' }, { name: 'install', tag: 'button' }])
  globalThis.document = fake.doc
  let closed = 0
  const base = {
    snapshot: updateStoreStub({ check: updateAvailable() }).get(),
    currentVersion: '9.9.9', nowMs: UPDATE_NOW, platform: 'mac', onClose: () => { closed += 1 },
  }
  // 挂载为 idle，并跑完这一轮的 effect（聚焦/恢复焦点那一套）
  const mounted = render(UpdateDialog, base)
  const cleanups = mounted.instance.effects.map((effect) => effect.callback())
  try {
    const idle = find(mounted.tree, (node) => node.props?.role === 'dialog')
    idle.props.onKeyDown({ key: 'Escape' })
    assert.equal(closed, 1, '安全状态下 Esc 关闭')

    // 同一实例重渲染为 installing：**故意不跑**新收集的被动 effect
    const busyTree = rerender(UpdateDialog, {
      ...base,
      snapshot: { ...base.snapshot, install: { status: 'installing', stage: 'installing', targetVersion: '9.9.10', startedAt: '2026-09-28T10:00:00.000Z' }, installing: true },
    })
    const busy = find(busyTree, (node) => node.props?.role === 'dialog')
    busy.props.onKeyDown({ key: 'Escape' })
    assert.equal(closed, 1, '关键动作进行中：当前 render 的 Esc 就必须不关闭（不能等被动 effect）')

    // 反向：回到安全状态，当前 render 的 Esc 立刻又能关
    const safeTree = rerender(UpdateDialog, base)
    const safe = find(safeTree, (node) => node.props?.role === 'dialog')
    safe.props.onKeyDown({ key: 'Escape' })
    assert.equal(closed, 2, '回到安全状态后当前 render 的 Esc 必须能关')
  } finally {
    unmountAll(cleanups)
  }
})

// ── Windows 本地路径：界面上的落盘位置说明 ────────────────────────────────────

test('artifactHint 在 Windows 工作空间下用 `\\` 拼（界面不能显示 `C:\\.../<流水号>/`）', async () => {
  const { artifactHint } = await import(new URL('src/client/features/workbench/workspace-view.ts', ROOT).href)
  const win = artifactHint('C:\\Users\\张三\\Case\'s Work')
  assert.match(win, /C:\\Users\\张三\\Case's Work\\<报告流水号>\\/, win)
  assert.equal(/Case's Work\//.test(win), false, '不得混用分隔符')

  const posix = artifactHint('/Users/me/工作空间')
  assert.match(posix, /\/Users\/me\/工作空间\/<报告流水号>\//, posix)
})
