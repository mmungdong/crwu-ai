/**
 * 本机选择器的**接线**（协议 32）。
 *
 * 这一层专门测"线有没有接上"，而不是"选择器本身对不对"（后者在 `client-local-audit.test.mjs` 里
 * 逐条覆盖）。为什么要单独一层 —— 2026-10-12 用户实测的缺陷**不在 `pick.ts` 里**：
 *
 *   `pick.ts` 一切正常；是**报告评估那一页**在装配时漏了两件事，
 *   于是点「选文件」永远得到「当前运行环境拿不到本机绝对路径…请在桌面端打开本页」——
 *   而桌面端也拿不到，因为缺的正是这根线。
 *
 * 三处漏法（都会在这里被判红）：
 *   1. 没接 `hostPaths` —— 现代 Electron 已移除 `File.path`，绝对路径只能由它提供；
 *   2. 装配时**快照** `uiWorkspace.pickDirectory` —— 服务晚注册就永远不可用；
 *   3. 端口对象 `{ ...services }` **展开** —— 把 getter 求值一次，同样变成快照。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

// `report-evaluation/index.ts` 会转出 `.tsx` 组件，所以这个 loader 必须挂上（与本目录其它页面测试一致）。
registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const { hostPickerCapabilities, pickFile, pickDirectory } = await import(
  new URL('src/client/modules/local-audit/pick.ts', ROOT).href)
const { createReportEvaluationPaneController } = await import(
  new URL('src/client/modules/report-evaluation/index.ts', ROOT).href)

/**
 * 桌面端的路径桥（preload 注入的全局）。装一次、用完即卸。
 *
 * ⚠️ 必须 `await body()`：只 `return body()` 的话 `finally` 会**在异步体跑完之前**就卸掉全局，
 * 于是被测代码在它的 `.then` 链里读到的桥已经没了 —— 测试于是假红/假绿（本文件第一版踩过）。
 */
async function withHostPaths(bridge, body) {
  const key = '__DSH_HOST_PATHS__'
  const previous = globalThis[key]
  globalThis[key] = bridge
  try {
    return await body()
  } finally {
    if (previous === undefined) delete globalThis[key]
    else globalThis[key] = previous
  }
}

test('接了 hostPaths：选文件拿到绝对路径，不再报「拿不到本机绝对路径」', async () => {
  await withHostPaths({ pathFor: (file) => `/Users/someone/资料/${file.name}` }, async () => {
    const capabilities = hostPickerCapabilities(() => ({}))
    const picked = await pickFile(capabilities, [{ name: 'a.pdf', path: '' }, { name: 'b.xlsx', path: '' }])
    assert.equal(picked.ok, true, '有路径桥时不该判成"不支持"')
    assert.deepEqual(picked.paths, ['/Users/someone/资料/a.pdf', '/Users/someone/资料/b.xlsx'])
  })
})

test('能力**晚于**装配才出现时也要认（这就是 2026-10-11 那次快照 bug）', async () => {
  // 装配那一刻：全局没注入、ui-workspace 也没注册。
  const services = {}
  const capabilities = hostPickerCapabilities(() => services)
  // 装配之后它们才到。
  services.uiWorkspace = { pickDirectory: async () => '/Users/someone/资料' }
  await withHostPaths({ pathFor: (file) => `/Users/someone/资料/${file.name}` }, async () => {
    const picked = await pickFile(capabilities, [{ name: 'a.pdf', path: '' }])
    assert.equal(picked.ok, true, '晚注册的路径桥必须被认到')
    assert.deepEqual(await pickDirectory(capabilities), { ok: true, paths: ['/Users/someone/资料'], unsupported: false, error: '' })
  })
})

test('控制器端口**不许**把能力展开成快照（`{...services}` 会把 getter 求值一次）', async () => {
  // 造一个最小的 file input：点一下就把给定的文件交给 change 监听器。
  // 这样我们能**真的走一遍** `controller.pickFiles()`，而不是只看形状。
  const files = [{ name: 'a.pdf', path: '' }]
  const listeners = {}
  const previousDocument = globalThis.document
  // ⚠️ 必须返回**同一个**元素：每次 `createElement` 都新建的话，`click` 里塞的文件
  // 与 `pickFilesFromInput` 读的 `element.files` 不是同一个对象 —— 它会读到空清单，
  // 于是"没选任何文件"，测试假绿（第一次就是这么写的）。
  const element = {
    type: '', multiple: false, accept: '', files: null,
    addEventListener: (type, listener) => { listeners[type] = listener },
    click: () => { element.files = files; listeners.change?.() },
  }
  globalThis.document = { createElement: () => element }
  try {
    const services = {}
    const controller = createReportEvaluationPaneController(hostPickerCapabilities(() => services))
    // 装配**之后**才注入路径桥：端口若是快照，此刻它记的还是 undefined。
    await withHostPaths({ pathFor: (file) => `/Users/someone/资料/${file.name}` }, async () => {
      controller.pickFiles()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(controller.getState().selection, ['/Users/someone/资料/a.pdf'],
      '晚注入的路径桥必须被认到（端口存了快照就会退化成"拿不到绝对路径"）')
    assert.equal(/拿不到本机绝对路径/.test(controller.getState().error), false,
      `不该报"拿不到绝对路径"，实际：${controller.getState().error}`)
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('门禁没接时不许默认放行（`ready` 缺省 = `ok: true` 是个陷阱）', async () => {
  const calls = []
  const controller = createReportEvaluationPaneController({
    ...hostPickerCapabilities(() => ({})),
    ready: () => ({ ok: false, error: '环境信息还没就绪' }),
    intake: async (input) => { calls.push(input); return { ok: true } },
    start: async () => ({ ok: true }),
    status: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    result: async () => ({ ok: true }),
    openArtifact: async () => ({ ok: true }),
  })
  controller.setMethod('market')
  controller.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, [], '门禁不过时一个请求都不该发')
  assert.match(controller.getState().error, /环境信息还没就绪/)
})

// ── 静态判据：两个装配点都必须走同一份适配器 ──────────────────────────────────

test('估值控制器的两个装配点都必须用 hostPickerCapabilities（不许各自拼一份）', () => {
  for (const relative of ['src/client/apply.ts', 'src/client/shell/WorkbenchPanel.tsx']) {
    const code = readFileSync(new URL(relative, ROOT), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.match(code, /createReportEvaluationPaneController\(hostPickerCapabilities\(/,
      `${relative} 必须用共用的选择器适配器建估值控制器`)
    // 手拼能力的老写法（装配时快照）不许回来。
    assert.equal(/uiWorkspace\?\.pickDirectory === undefined/.test(code), false,
      `${relative} 又出现了"装配时判一次 uiWorkspace"的快照写法`)
    // 门禁必须接上，否则 `port.ready?.() ?? { ok: true }` 会默认放行。
    assert.match(code, /ready: \(\) =>/, `${relative} 必须把环境门禁接进估值控制器`)
  }
})
