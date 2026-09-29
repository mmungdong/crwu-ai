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
import { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } from '../src/host/tools/consts.ts'

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
  // `tools` 是硬依赖：`apply()` 会把必需 CRWU 工具注册进去（缺注册表直接抛）。
  // 替身只收集注册名并返回 disposer；「注册进真实注册表后的 schema/pipeline 行为」
  // 由 `tests/unit/host-tools.test.mjs` 对着真实契约覆盖。
  const registeredTools = []
  const tools = {
    register(definition) {
      registeredTools.push(definition.name)
      // 忠实替身：DSH 的 `tools.register` 返回 disposer，卸载时必须真的把工具摘掉。
      return () => {
        const index = registeredTools.indexOf(definition.name)
        if (index >= 0) registeredTools.splice(index, 1)
      }
    },
  }
  const ctx = {
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: (name) => (name === 'tools' ? tools : undefined),
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
        // 同上：返回真的注销函数，否则"卸载有没有把路由摘掉"根本观察不到。
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
  return { ctx, routes, effects, logs, listeners, registeredTools }
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
  // `tools`：审核链路只通过结构化 Tool 交付业务能力，没有注册表就不该激活。
  assert.deepEqual(module.inject, ['webServer', 'shell', 'tools'], 'inject 声明变了')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.Config, 'function', 'Config 必须是可以被 Cordis 调用的 schema')
  // DSH 以**位置参数**传 config（对照 dsh-tool-bash 的 `function apply(ctx, config = {})`）。
  assert.equal(module.apply.length >= 2, true, 'apply 必须接受 (ctx, config) 两个位置参数')

  const { ctx, routes, effects, listeners, registeredTools } = fakeHostContext()
  const config = module.Config({})
  module.apply(ctx, config)
  const routeCountAfterApply = routes.length
  assert.equal(routes.length, 1, '应当注册恰好一个同源路由')
  assert.equal(routes[0].path, module.ROUTE)
  // 没有这个订阅，ended / endReason 永远是空 → 「已中断」不出现、自动上传不触发。
  assert.equal(listeners.has('subagent/end'), true, 'apply() 必须订阅 subagent/end')
  assert.deepEqual(
    [...registeredTools].sort(),
    [...CRWU_BUSINESS_TOOLS].sort(),
    'apply() 注册的 CRWU 工具必须与 CRWU_BUSINESS_TOOLS 逐字一致（注册面 ≠ 审核子会话能力集）',
  )

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

  // 协议 18 新增的操作必须在**产物**里真的可达（不只是源码里有）。
  // `access-diagnostics` 是唯一零副作用、零外部依赖的新操作，适合放进 smoke：
  // 它证明路由表、参数收窄与返回体形状在打包之后都对。
  const diagnostics = fakeExchange({ op: 'access-diagnostics', args: {} })
  await routes[0].handler(diagnostics.req, diagnostics.res)
  assert.equal(diagnostics.response.statusCode, 200, 'access-diagnostics 应当可达')
  const diagPayload = JSON.parse(diagnostics.response.body)
  assert.equal(diagPayload.ok, true)
  assert.deepEqual(diagPayload.entries, [], '本次运行还没有任何本机访问')
  assert.equal(typeof diagPayload.consent?.state, 'string', '诊断要带上授权收据状态')

  // 「允许」在**没有文件服务**的环境里必然落盘失败 —— 这正是"写盘失败不许放行"的现场。
  // 从真实产物驱动一次，确认回的是关闭态（`persist-failed`）而不是磁盘上的旧授权。
  const grant = fakeExchange({
    op: 'local-access-grant',
    args: { schemaVersion: 1, capabilities: [
      'h3yun-credential-store', 'dws-profile', 'oss-config', 'ifind-credential', 'system-integration',
    ] },
  })
  await routes[0].handler(grant.req, grant.res)
  const grantPayload = JSON.parse(grant.response.body)
  assert.equal(grantPayload.ok, false, '没有文件服务时落盘必然失败')
  assert.notEqual(grantPayload.consent?.state, 'granted', '写盘失败绝不许回 granted')
  assert.equal(grantPayload.consent?.state, 'persist-failed')
  assert.deepEqual(grantPayload.consent?.capabilities, [])

  // 授权与体检两个操作也必须在产物里（这里只证明"登记了、参数被收窄"，不真跑它们：
  // 前者会写状态文件、后者要 shell 服务，都不是零副作用）。
  const doctorBadArgs = fakeExchange({ op: 'dws-local-permission-repair', args: { confirm: 'yes' } })
  await routes[0].handler(doctorBadArgs.req, doctorBadArgs.res)
  const repairPayload = JSON.parse(doctorBadArgs.response.body)
  assert.equal(repairPayload.ok, false, '形状不对的修复请求必须被拒')
  assert.match(String(repairPayload.error), /confirm/, '拒绝理由要说清是确认形状不对')

  // ── 卸载：把 `apply()` 里每个 `ctx.effect` 的 disposer 都跑一遍 ─────────────
  //
  // 为什么必须在这里做：**没有任何用例跑过插件的卸载路径** —— `smoke:built` 收集了 effects
  // 却从不调用，于是"忘了 `return` disposer"这类回归（Cordis 的经典坑）在本地完全看不见，
  // 表现为插件卸载后路由还在、看门狗还在轮询。这里跑一遍并断言**真的释放了**。
  assert.equal(effects.length > 0, true, 'apply() 应当至少注册一个 effect（路由 / 工具 / 看门狗）')
  for (const dispose of [...effects].reverse()) {
    if (typeof dispose === 'function') dispose()
  }
  assert.equal(routes.length, 0, '卸载后同源路由必须被摘掉（effect 的 disposer 必须真的注销）')
  assert.deepEqual([...registeredTools], [], '卸载后 CRWU 工具必须被逐个注销')
  return { routes: routeCountAfterApply }
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
    'sidebar.footer.action', 'main', 'tool.view.cordis', 'conversation.session.header.utilities',
  ], '必须注入这四个槽位')
  for (const entry of injections) {
    assert.equal(entry.insideEffect, false, 'slots.inject 不得包在 ctx.effect 里')
  }
  assert.deepEqual(registered.map((meta) => meta.name), [
    'sidebar.footer.action', 'main', 'tool.view.cordis', 'conversation.session.header.utilities',
  ])
  // 工作台常驻在左侧栏底部（Settings 上方），主面板 key 与它对齐。
  assert.equal(registered[0].id, 'crwu-workbench')
  // 侧栏读的是 options.label（resolveSlotLabel 对字符串原样返回），给中文字符串即可。
  assert.equal(typeof registered[0].label, 'string')
  assert.ok(registered[0].label.length > 0, '侧栏标签不能是空的，否则退回显示内部 id')
  assert.equal(registered[1].key, 'crwu-workbench')
  assert.equal(registered[3].id, 'crwu-audit-parent', '会话头按钮必须注册（登记父级的唯一入口）')
  assert.equal(styleElements.length, 1, '样式应当随 apply 插入一次')
  assert.equal(registered.length, 4, '注册的槽位数量变了')

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
await check('Client 半：经 __ModuleLoader__ 加载并注册四个槽位条目', async () => {
  const result = await smokeClient()
  slotCount = result.slots
  moduleId = result.loaded
  return `槽位条目 ${result.slots} 个 · 模块 id ${result.loaded}`
})

// 审核链路只走结构化 Tool：产物里必须能看到全部必需的 `crwu_*` 工具名，而且**不许**再出现
// 插件二进制目录或 PATH 注入这类「让模型自己拼命令行」的指纹。
// 真跑一次取数要连真实氚云/钉钉/OSS，只有用户点「AI 审核」才会发生（见 AGENTS.md §7.2）。
await check(`Host 产物：包含 ${String(REQUIRED_AUDIT_TOOLS.length)} 个 CRWU 结构化 Tool，且不含路径注入指纹`, async () => {
  const bundle = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
  for (const name of REQUIRED_AUDIT_TOOLS) {
    assert.equal(bundle.includes(name), true, `产物里缺少工具：${name}`)
  }
  assert.equal(bundle.includes('~/.dsh/skills'), false, '产物里不许出现写死的 ~/.dsh/skills')
  assert.equal(bundle.includes('export PATH='), false, '产物里不许出现 PATH 注入文案')
  // 只认**真的导入**：`shell/run.ts` 的注释里会出现这个词（说明「不得用」），注释不是执行路径。
  assert.equal(/from\s*["']node:child_process["']/.test(bundle), false, '产物里不许导入 node:child_process')
  assert.equal(/require\(\s*["']node:child_process["']\s*\)/.test(bundle), false, '产物里不许 require node:child_process')
  // 回传脚本的名字只出现在注释里（讲"为什么删掉它"），执行路径里不存在：
  // 审核链路的业务命令只有 `ctx.shell` + 包内二进制这一条，Python 不在其中。
  // 「不再依赖 Python 回传脚本 / 不再有裸命令拼接」由 `tests/unit/host-tools.test.mjs` 与
  // `host-audit-prompt.test.mjs` 对着**源码**与**提示词**逐条断言：产物里这些词会出现在
  // 讲"为什么删掉它们"的注释中，对 bundle 做文本包含式断言只会得到假红。
  return `lib/index.js → ${String(REQUIRED_AUDIT_TOOLS.length)} 个 crwu_* 工具，无路径注入指纹`
})

if (failures.length > 0) {
  console.error(`FAIL     构建产物冒烟：${failures.length} 项未通过`)
  process.exitCode = 1
} else {
  console.log(`PASS     构建产物冒烟：Host 路由 ${routeCount} 条 · Client 槽位 ${slotCount} 个 · 模块 id ${moduleId}`)
}
