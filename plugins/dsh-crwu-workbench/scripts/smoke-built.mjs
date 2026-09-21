/**
 * **构建产物**的冒烟测试（不是源码测试）。
 *
 * 为什么单独一个脚本：`tests/` 里的测试全部 import `src/` 的源码，所以它们证明不了
 * 「打出来的 `lib/index.js` / `lib/client.js` 能被 DSH 加载」。而这两件事恰恰是接收方
 * 唯一会遇到的现实 —— 源码测试全绿、装上去面板不出现，是插件开发里最典型的落差。
 *
 * 它做两件真实世界会做的事：
 * 1. Host 半：用**真的 `lib/index.js`** 配一个 Cordis 替身跑 `apply()`，再走一遍同源路由，
 *    确认 `ping` 这种操作真的能经由 HTTP 处理器返回；
 * 2. Client 半：用**真的 `lib/client.js`** 配一个 `window.__ModuleLoader__` 替身、一个
 *    `react` / `react/jsx-runtime` 替身、一个浏览器 DOM 替身，跑 `apply()`，确认槽位条目
 *    真的被注册（槽位名与 DSH 的真实注册表一致）。
 *
 * 它**不能**替代真实安装：DSH 是否真的把 `shell` / `fs` / `subagents` 交给插件，
 * 只有装一次才知道。这一点写在 README 的验证清单里。
 *
 * 必须在 `npm run build` 之后运行（`check` 与 CI 都按这个顺序）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const failures = []

/**
 * 逐项跑并收集失败。
 *
 * 必须**接住**每一项的错误：早先我直接 await 两个 smoke，结果断言失败变成未捕获的
 * promise rejection，打印的是栈而不是「哪一项坏了、坏在哪」—— 排查成本差很多。
 */
async function check(label, run) {
  try {
    const detail = await run()
    console.log(`OK       ${label}${detail === undefined ? '' : ` · ${detail}`}`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    failures.push(`${label}：${reason}`)
    console.error(`FAIL     ${label}：${reason}`)
  }
}

/** 最小 Cordis 上下文替身：记录注册，提供可选服务。 */
function fakeHostContext() {
  const routes = []
  const effects = []
  const logs = []
  const listeners = new Map()
  const ctx = {
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: () => undefined,
    // 插件订阅子代理事件（ended / endReason 的唯一来源），所以 ctx.on 必须存在并返回解除函数。
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => { list.splice(list.indexOf(listener), 1) }
    },
    logger: { info: (...args) => logs.push(args) },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, effects, logs, listeners }
}

/** 最小请求/应答替身，够走完一次同源 RPC。 */
function fakeExchange(body) {
  const text = JSON.stringify(body)
  const response = { statusCode: 0, headers: {}, body: '' }
  return {
    response,
    req: {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(text, 'utf8') },
    },
    res: {
      setHeader(name, value) { response.headers[name] = value },
      end(payload) { response.body = payload },
      set statusCode(value) { response.statusCode = value },
      get statusCode() { return response.statusCode },
    },
  }
}

export async function smokeHost() {
  const module = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
  // 导出的成员与 DSH 自带的函数插件一致（对照 `@deepseek-ai/dsh-tool-bash`：{ Config, apply, inject, name }）。
  assert.equal(module.name, 'crwu-workbench', 'name 导出不对')
  assert.ok(Array.isArray(module.inject), 'inject 必须是服务名数组')
  assert.ok(module.inject.every((item) => typeof item === 'string'), 'inject 里只能放字符串服务名')
  assert.deepEqual(module.inject, ['webServer', 'shell'], 'inject 声明变了')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.Config, 'function', 'Config 必须是可以被 Cordis 调用的 schema')
  // DSH 以**位置参数**传 config（对照 dsh-tool-bash 的 `function apply(ctx, config = {})`）。
  assert.equal(module.apply.length >= 2, true, 'apply 必须接受 (ctx, config) 两个位置参数')

  const { ctx, routes, listeners } = fakeHostContext()
  const config = module.Config({})
  module.apply(ctx, config)
  assert.equal(routes.length, 1, '应当注册恰好一个同源路由')
  assert.equal(routes[0].path, module.ROUTE)
  // 没有这个订阅，ended / endReason 永远是空 → 「已中断」不出现、自动上传不触发。
  assert.equal(listeners.has('subagent/end'), true, 'apply() 必须订阅 subagent/end')

  // 走一遍真实的 HTTP 处理器：这是「装上去之后 RPC 到底通不通」的最小证据。
  const { req, res, response } = fakeExchange({ op: 'ping' })
  await routes[0].handler(req, res)
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.match(String(payload.rev), /^pkg-/, 'ping 应当回一个版本号')

  // 未知操作必须被拒（而不是 500）。
  const unknown = fakeExchange({ op: 'no-such-op' })
  await routes[0].handler(unknown.req, unknown.res)
  assert.equal(unknown.response.statusCode, 404)

  // 跨域必须被拒。
  const cross = fakeExchange({ op: 'ping' })
  cross.req.headers.origin = 'http://evil.invalid'
  await routes[0].handler(cross.req, cross.res)
  assert.equal(cross.response.statusCode, 403)
  return { routes: routes.length }
}

export async function smokeClient() {
  const source = await readFile(join(ROOT, 'lib/client.js'), 'utf8')

  // ── 浏览器替身：只补 bundle 真正会碰到的那些全局 ──────────────────────────
  const loaded = []
  const registered = []
  const injections = []
  const styleElements = []

  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: Symbol.for('smoke.fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  }
  const jsxRuntime = { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment }
  const modules = { react, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxRuntime }

  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded.push(id)
        // 真实 loader 也是这么做的：用模块表解析 require，然后调用 factory。
        const exports = factory((specifier) => {
          if (!(specifier in modules)) throw new Error(`模块表里没有 ${specifier}`)
          return modules[specifier]
        })
        globalThis.__smokeClientExports = exports
      },
    },
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => {
      const element = { id: '', dataset: {}, textContent: '', remove() {} }
      styleElements.push(element)
      return element
    },
    head: { appendChild() {} },
  }

  // bundle 是 CJS 形态的脚本，用 import 会当成 ESM 解析失败 —— 这里显式求值。
  const { runInThisContext } = await import('node:vm')
  runInThisContext(source, { filename: 'lib/client.js' })

  assert.deepEqual(loaded, ['dsh-crwu-workbench'], 'ModuleLoader 的 id 必须是包名')
  const exports = globalThis.__smokeClientExports
  assert.equal(typeof exports.apply, 'function', 'client 半必须导出 apply')
  assert.deepEqual(exports.inject, ['slots'], 'client 的 inject 应当只声明 slots')

  let depth = 0
  const ctx = {
    effect(callback) {
      depth += 1
      let dispose
      try {
        dispose = callback()
      } finally {
        depth -= 1
      }
      // 与 Cordis 一致：非函数、非空的返回值会被拒绝。
      assert.ok(
        dispose === undefined || dispose === null || typeof dispose === 'function',
        `effect 返回值类型 ${typeof dispose} 会被 Cordis 拒绝`,
      )
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: (name) => (name === 'layout' ? { selectPanel() {} } : undefined),
    slots: {
      inject(name, callback) { injections.push({ name, insideEffect: depth > 0 }); return callback() },
      register(meta) { registered.push(meta); return () => {} },
    },
  }
  exports.apply(ctx)

  // 四个槽位缺一不可：少了 session.header 那个，界面上就没有办法登记审核父级，
  // 而 audit-start 要求父级已登记 —— 等于整个审核流程无法从界面发起。
  assert.deepEqual(injections.map((entry) => entry.name), [
    'sidebar.panellist', 'main', 'tool.view.cordis', 'conversation.session.header.utilities',
  ], '必须注入这四个槽位')
  for (const entry of injections) {
    assert.equal(entry.insideEffect, false, 'slots.inject 不得包在 ctx.effect 里')
  }
  // 会话头那个 list 槽位挂了两个条目：环境指示灯（页面右上角）+ 子会话父级按钮。
  assert.deepEqual(registered.map((meta) => meta.name), [
    'sidebar.panellist', 'main', 'tool.view.cordis',
    'conversation.session.header.utilities', 'conversation.session.header.utilities',
  ])
  assert.equal(registered[0].id, 'crwu-workbench')
  // 侧栏读的是 options.label（resolveSlotLabel 对字符串原样返回），给中文字符串即可。
  assert.equal(typeof registered[0].label, 'string')
  assert.ok(registered[0].label.length > 0, '侧栏标签不能是空的，否则退回显示内部 id')
  assert.equal(registered[1].key, 'crwu-workbench')
  assert.equal(registered[3].id, 'crwu-env-status', '右上角环境指示灯必须注册（绿/红那盏）')
  assert.equal(registered[3].order, 6, '指示灯要在最右边')
  assert.equal(registered[4].id, 'crwu-audit-parent', '会话头按钮必须注册（登记父级的唯一入口）')
  assert.equal(styleElements.length, 1, '样式应当随 apply 插入一次')
  assert.equal(registered.length, 5, '注册的槽位数量变了')

  delete globalThis.window
  delete globalThis.document
  delete globalThis.__smokeClientExports
  return { loaded: loaded[0], slots: registered.length }
}

let routeCount = 0
let slotCount = 0
let moduleId = ''

await check('Host 半：apply() 注册同源路由并真的应答 RPC', async () => {
  const result = await smokeHost()
  routeCount = result.routes
  return `路由 ${result.routes} 条`
})
await check('Client 半：经 __ModuleLoader__ 加载并注册五个槽位条目', async () => {
  const result = await smokeClient()
  slotCount = result.slots
  moduleId = result.loaded
  return `槽位条目 ${result.slots} 个 · 模块 id ${result.loaded}`
})

// 审核指令里的钉钉回传脚本路径是**随包发布**的（`src/host/audit/skill-paths.ts`）。
// 这里能证明的是「产物里没有写死路径 + 脚本真的在包内那份 skills/ 下」；真正跑一次回传
// 要连真实钉钉，只有用户点「AI 审核」才会发生（见 AGENTS.md §7.2）。
await check('Host 产物：钉钉回传脚本按包内相对路径解析，脚本随包存在', async () => {
  const bundle = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.equal(bundle.includes('~/.dsh/skills'), false, '产物里不许再出现写死的 ~/.dsh/skills（员工机器上不存在）')
  assert.equal(bundle.includes('../skills/'), true, '产物要按自身所在目录解析包内 skills/')
  const script = join(ROOT, 'skills', 'crwu-audit', 'scripts', 'upload_audit_result.py')
  assert.equal(existsSync(script), true, `脚本必须随包发布：${script}（package.json 的 files 要有 skills/）`)
  return 'lib/index.js → ../skills/…'
})

if (failures.length > 0) {
  console.error(`FAIL     构建产物冒烟：${failures.length} 项未通过`)
  process.exitCode = 1
} else {
  console.log(`PASS     构建产物冒烟：Host 路由 ${routeCount} 条 · Client 槽位 ${slotCount} 个 · 模块 id ${moduleId}`)
}
