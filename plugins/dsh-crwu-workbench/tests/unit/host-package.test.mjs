/**
 * 包形态（src/）的单元测试。
 *
 * 直接 import `.ts`：本仓要求 node ^22.19 || >=24，这段时间线原生剥离类型（不转换语法），
 * 而 src 里不使用 enum / 参数属性 / namespace 这类需要生成的语法，所以测试无需构建步骤。
 * `npm run build`（tsdown）仍然负责交付产物。
 *
 * 这里只覆盖 Host 半（node 运行时）。Client 半含 JSX，Node 不做语法转换，因此浏览器侧的
 * 行为由本文件的注入式渲染树覆盖。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { Config, resolveWorkbenchConfig } = await import(new URL('src/host/config/config.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { PLUGIN_INJECT, PLUGIN_NAME } = await import(new URL('src/host/consts.ts', ROOT).href)
const { RPC_BODY_MAX_BYTES } = await import(new URL('src/host/http/consts.ts', ROOT).href)
const { createWorkbenchState, workspaceView } = await import(new URL('src/host/state/store.ts', ROOT).href)
const { createCoreOperations } = await import(new URL('src/host/ops/core.ts', ROOT).href)
const { WORKBENCH_ROUTE } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { readJsonBody, writeJson } = await import(new URL('src/host/http/json.ts', ROOT).href)

const YAML_CONFIG = new URL('config/crwu-workbench.yml', ROOT)
const YAML_RUNTIME = resolveWorkbenchConfig({ configFile: YAML_CONFIG.pathname })

/** 操作单测从真实 YAML 起步，只覆盖该用例关心的字段。 */
function resolveConfig(patch = {}) {
  return { ...YAML_RUNTIME, ...patch }
}

/** 最小的 webServer 替身：只保留 register 并把 handler 交出来。 */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    service: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

/** 读出 registerRpcRoute 交给 webServer 的 handler。 */
async function loadRoute(operations) {
  const { registerRpcRoute } = await import(new URL('src/host/http/route.ts', ROOT).href)
  const server = fakeWebServer()
  registerRpcRoute({ webServer: server.service }, operations)
  assert.equal(server.routes.length, 1)
  return server.routes[0]
}

/** 最小请求替身：异步产出 JSON 文本分片。 */
function makeRequest({ method = 'POST', origin, host = '127.0.0.1:3080', body } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const chunks = [Buffer.from(text, 'utf8')]
  return {
    method,
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...(host === undefined ? {} : { host }),
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 记录状态码、响应头与响应体的响应替身。 */
function makeResponse() {
  const response = { statusCode: 0, headers: {}, body: '' }
  return {
    response,
    res: {
      setHeader(name, value) { response.headers[name] = value },
      end(payload) { response.body = payload },
      set statusCode(value) { response.statusCode = value },
      get statusCode() { return response.statusCode },
    },
  }
}

async function invoke(handler, options) {
  const { res, response } = makeResponse()
  await handler(makeRequest(options), res)
  return { ...response, json: response.body === '' ? null : JSON.parse(response.body) }
}

// ── 配置 Schema ─────────────────────────────────────────────────────────────

test('Cordis config only selects an optional development YAML', () => {
  assert.deepEqual(Config({}), { configFile: '' })
  assert.deepEqual(Config({ configFile: '/tmp/dev.yml' }), { configFile: '/tmp/dev.yml' })
})

test('the package YAML is the runtime source of deployment values', () => {
  const config = resolveConfig()
  assert.equal(config.configSource, YAML_CONFIG.pathname)
  assert.equal(config.caseRoot, '')
  assert.equal(config.manifestUrl, 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-manifest.json')
  assert.equal(config.ossBucket, 'crwu-workspace')
  assert.equal(config.ossLinkMode, 'signed')
})

test('host declares exactly the services it reads', () => {
  // 少声明 → 插件等待或运行失败；多声明 → 无谓的激活依赖。
  assert.deepEqual(PLUGIN_INJECT, ["webServer", "shell"])
  assert.equal(PLUGIN_NAME, 'crwu-workbench')
  assert.equal(WORKBENCH_ROUTE, '/api/crwu-workbench')
})

// ── 状态 ────────────────────────────────────────────────────────────────────

test('each plugin instance gets isolated state seeded from its own config', () => {
  const first = createWorkbenchState(resolveConfig({ caseRoot: '/cases/a' }))
  const second = createWorkbenchState(resolveConfig({ caseRoot: '/cases/b' }))
  assert.equal(first.caseRoot, '/cases/a')
  assert.equal(second.caseRoot, '/cases/b')
  assert.equal(first.manifest?.oss.bucket, 'crwu-workspace', '插件激活后、env RPC 之前就要使用 YAML 的私有 OSS')
  assert.equal(first.manifest?.oss.prefix, 'crwu/audit')
  assert.equal(first.manifest?.oss.linkMode, 'signed')
  assert.notEqual(first.audits, second.audits)
  first.audits.k = 'x'
  assert.deepEqual(second.audits, {})
})

test('workspace view reports the path as the title until a title is chosen', () => {
  const state = createWorkbenchState(resolveConfig({ caseRoot: '/cases/a' }))
  assert.deepEqual(workspaceView(state), { chosen: false, path: '', title: '', id: '', source: '', missing: false })
  state.workspaceChosen = true
  state.workspacePath = '/cases/a'
  assert.equal(workspaceView(state).title, '/cases/a')
  state.workspaceTitle = '中瑞世联工作空间'
  assert.equal(workspaceView(state).title, '中瑞世联工作空间')
})

// ── 操作表 ──────────────────────────────────────────────────────────────────

/** 执行世界替身：默认「已探测到」的固定值，需要时用 patch 覆盖。 */
function fakeWorld(patch = {}) {
  const facts = { platform: 'darwin-arm64', home: '/Users/x', workdir: '/cases/session', ...patch }
  return {
    platform: async () => facts.platform,
    home: async () => facts.home,
    workdir: async () => facts.workdir,
    cached: () => ({ platform: facts.platform, home: facts.home }),
  }
}

function operationsFor(config = {}, sessions, world = fakeWorld()) {
  const resolved = resolveConfig(config)
  const state = createWorkbenchState(resolved)
  // ctx 必须是「服务在但答不出来」的形态：包形态的所有服务都走 `ctx.get`，
  // 服务缺失或命令失败都要降级成错误信封，而不是抛 TypeError。真实 DSH 里这些服务都在，
  // 所以给一个答不出话的替身比给 undefined 更接近实际。
  const stubShell = {
    resolve: (request) => request,
    async run() {
      return { exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: 'stub: 无服务', truncated: false } }
    },
  }
  const stubFs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat() { return undefined },
    async readText() { return '' },
    async writeText() { return { operation: 'create', version: 'v', before: null, after: '' } },
    async listDir() { return [] },
  }
  const ctx = {
    get: (name) => (name === 'shell' ? stubShell : (name === 'fs' ? stubFs : undefined)),
    // 真实 Cordis 上下文一定有 effect：插件用它登记随生命周期释放的资源。
    effect: (callback) => { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
    ...(sessions === undefined ? {} : { sessions }),
  }
  return { state, ctx, operations: createCoreOperations(ctx, resolved, state, world) }
}

test('buildKind 靠包根旁边有没有 src/ 判断：源码检出 = dev，装好的包 = installed', async () => {
  // 这枚标签直接告诉用户「你面对的是开发中的代码还是装好的版本」，判错比不显示更糟，
  // 所以判据本身要有测试：造两个真实目录（一个带 src/、一个不带），而不是靠 mock。
  const { hostBuildKindOf } = await import(new URL('src/host/build-info.ts', ROOT).href)
  const source = mkdtempSync(join(tmpdir(), 'crwu-src-'))
  mkdirSync(join(source, 'src'))
  mkdirSync(join(source, 'lib'))
  assert.equal(hostBuildKindOf(source), 'dev')

  const packed = mkdtempSync(join(tmpdir(), 'crwu-pkg-'))
  mkdirSync(join(packed, 'lib'))
  mkdirSync(join(packed, 'config'))
  assert.equal(hostBuildKindOf(packed), 'installed', '发布包里没有 src/，必须判成装好的包')

  // 本仓就是源码检出：正在跑的这份测试代码必须自报 dev（判据走的是这条包根）。
  const buildInfo = await import(new URL('src/host/build-info.ts', ROOT).href)
  assert.equal(buildInfo.HOST_BUILD_KIND, 'dev', '在源码仓里跑，形态必须是 dev')
})

test('ping and boot answer with the state the panel needs to render', async () => {
  const { operations } = operationsFor({ formName: '报告审核' })
  const pong = operations.ping()
  assert.equal(pong.ok, true)
  assert.match(String(pong.rev), /^pkg-\d/)
  // `rev` 必须**等于 package.json 的版本**：它是「我装到的是哪一版」的唯一口头依据，而
  // `version:set` 只改 package.json / VERSION / lockfile —— 漏改这里会静默地报出上一版的号。
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
  assert.equal(
    String(pong.rev), `pkg-${pkg.version}`,
    `包版本是 ${pkg.version}，rev 必须跟着改（src/host/ops/core.ts）`,
  )
  // 构建指纹：要么是空串（这种形态下读不到自己的 mtime），要么是能解析的 ISO 时间。
  // 它的用途是「重启后确认生效的是刚 build 的那份」—— rev 做不到这件事（同一轮开发里是常量）。
  assert.ok(
    pong.builtAt === '' || !Number.isNaN(Date.parse(String(pong.builtAt))),
    `builtAt 必须是有值的 ISO 时间或空串，实际是 ${String(pong.builtAt)}`,
  )
  // 面板标题旁显示的版本号来自 boot（客户端只调 boot，不调 ping），两处必须是同一个值。
  const bootAnswer = await operations.boot()
  assert.equal(bootAnswer.rev, pong.rev, 'boot 也要回版本号，否则标题旁只能显示「版本未知」')
  assert.equal(bootAnswer.builtAt, pong.builtAt, '构建时间同样要给，悬停时要看得到')
  assert.equal(bootAnswer.rev, `pkg-${pkg.version}`, 'boot.rev 与 package.json 版本必须一致')

  // 面板与侧栏入口那枚小标签要用它：dev（本地源码检出）还是装好的包 + 具体版本。
  assert.equal(pong.version, pkg.version, 'ping.version 必须等于 package.json 的版本')
  assert.equal(typeof pong.buildKind, 'string')
  assert.ok(pong.buildKind === 'dev' || pong.buildKind === 'installed', `buildKind 取值异常：${String(pong.buildKind)}`)
  assert.equal(bootAnswer.version, pong.version, 'boot 也要回版本号，否则侧栏入口只能显示「未知」')
  assert.equal(bootAnswer.buildKind, pong.buildKind, '运行形态同样要给，两处必须一致')

  // 它必须是**模块加载时算好的常量**，不是每次请求现读文件：现读的话
  // 「重新 build 但没重启」会报出新文件的时间，让人误以为新 build 已生效（第 33 轮实测过）。
  const buildInfo = await import(new URL('src/host/build-info.ts', ROOT).href)
  assert.equal(typeof buildInfo.HOST_BUILD_STAMP, 'string', 'HOST_BUILD_STAMP 必须是常量，不能是函数')
  assert.equal(buildInfo.HOST_BUILD_STAMP, pong.builtAt, 'ping 必须直接报这个常量')
  assert.equal(typeof buildInfo.HOST_BUILD_KIND, 'string', 'HOST_BUILD_KIND 也必须是常量')
  assert.equal(buildInfo.HOST_BUILD_KIND, pong.buildKind, 'ping 必须直接报这个常量')
  // boot 顺手恢复注册表并采用工作空间（legacy 行为），所以是异步的。
  const boot = await operations.boot()
  assert.equal(boot.ok, true)
  assert.equal(boot.formName, '报告审核')
  assert.equal(boot.parentSessionId, '')
  assert.deepEqual(boot.workspace, { chosen: false, path: '', title: '', id: '', source: '', missing: false })
  assert.ok(boot.ported.done.includes('boot'))
  // 24 个 legacy RPC 全部搬完：done 覆盖每一层，todo 为空。
  for (const name of ['env', 'pending', 'audit-start', 'audit-status', 'oss-index', 'oss-cred-save', 'clipboard', 'open-path', 'session', 'oss-cred']) {
    assert.ok(boot.ported.done.includes(name), `${name} 应当已移植`)
  }
  assert.deepEqual(boot.ported.todo, [], '不该再有未移植的操作')
})

test('the declared ported lists match which operations actually run', async () => {
  const { operations } = operationsFor()
  const boot = await operations.boot()

  // 每个已实现的操作都必须真的可调用（不抛未移植错误）。
  for (const name of boot.ported.done) {
    assert.equal(typeof operations[name], 'function', `${name} 声明为已移植但操作表里没有`)
    await assert.doesNotReject(async () => operations[name]({}), `${name} 声明为已移植但调用即抛`)
  }

  // 未移植的操作**如果**已经有处理器，必须明确报错，不能静默返回空壳 ——
  // 静默会让面板显示成「没有数据」。todo 里也允许有尚未落地的操作（如 clipboard）。
  for (const name of boot.ported.todo) {
    if (typeof operations[name] !== 'function') continue
    assert.throws(() => operations[name]({}), /尚未移植/, `${name} 应在骨架阶段明确抛错`)
  }

  // 操作表与声明表必须一一对应：漏登记会让新操作悄悄绕过上面两条检查。
  const declared = new Set([...boot.ported.done, ...boot.ported.todo])
  for (const name of Object.keys(operations)) {
    assert.ok(declared.has(name), `操作 ${name} 没有登记进 ported.done / ported.todo`)
  }
})

test('the Host half still registers the frozen inventory of 26 operations', async () => {
  // 旧形态退休后，原来「从它的源码读 handler 名单来对账」的来源没了。
  // 保留它真正守住的东西：**操作清单不能悄悄变少或改名**。所以这里把它冻成字面量。
  // 这份清单的来历是旧动态形态的 24 个 handler + 包形态新增的 ping（见 PORTING.md）。
  const FROZEN = [
    'ping', 'boot', 'workspace', 'workspace-auto', 'trust', 'bind-session', 'install-prompt', 'env', 'pending',
    'crwu', 'audit-start', 'audit-stop', 'audit-status', 'audit-release', 'oss-index', 'oss-result', 'oss-link',
    'oss-upload', 'oss-cred-save', 'open-path', 'clipboard', 'relogin', 'dws-login', 'session', 'oss-cred',
    // 第 26 个：一份报告的全部相关文件（只列举、不下载）—— 面板一打开就查。
    'report-files',
  ]
  const { operations } = operationsFor()
  assert.deepEqual(Object.keys(operations).sort(), [...FROZEN].sort())
  assert.equal(FROZEN.length, 26, '旧形态 24 个 handler + 包形态新增 ping、whoami、report-files')
})

test('every operation the client facade sends is declared as ported', async () => {
  // 原来是拿旧客户端的调用点来对账；旧形态退休后改用**活的门面**做来源，
  // 并额外要求 todo 为空 —— 那正是「收尾完成」的可观察状态。
  const { operations } = operationsFor()
  const boot = await operations.boot()
  const { OPERATION_OF } = await import(new URL('src/client/features/report-audit/api.ts', ROOT).href)
  const declared = new Set([...boot.ported.done, ...boot.ported.todo])
  for (const [method, op] of Object.entries(OPERATION_OF)) {
    assert.ok(declared.has(op), `门面方法 ${method} 发出 ${op}，但 ported 列表没登记它`)
  }
  assert.deepEqual(boot.ported.todo, [], '收尾之后不该还有 todo')
})

test('workspace selection trims trailing slashes and can be reset to auto', async () => {
  const { state, operations } = operationsFor({ caseRoot: '/cases/fallback' })
  const picked = await operations.workspace({ path: '/cases/x///', title: 'X', id: '1' })
  assert.equal(picked.ok, true)
  assert.deepEqual(workspaceView(state), { chosen: true, path: '/cases/x', title: 'X', id: '1', source: 'manual', missing: false })

  // 空路径 = 不改动选择，而不是把选择清掉。
  await operations.workspace({})
  assert.equal(state.workspacePath, '/cases/x')

  // 「恢复自动识别」= 清磁盘 + 清内存 + 重新采用；这里没有可命中的工作空间，
  // 所以最终是未选定状态（这正是 legacy 的行为）。
  const auto = await operations['workspace-auto']()
  assert.equal(auto.ok, true)
  assert.deepEqual(workspaceView(state), { chosen: false, path: '', title: '', id: '', source: '', missing: false })
})

test('trust 记一次长期授权：严格的 credentials 布尔 + 落盘（重启后仍有效）', async () => {
  const { state, operations, ctx } = operationsFor()
  const written = []
  const policies = []
  const fs = ctx.get('fs')
  const inner = fs.writeText
  fs.writeText = async (target, content, ...rest) => {
    written.push(content)
    // writeText(target, content, expected?, signal?, sandboxPolicy?) —— 策略是第 5 个参数。
    policies.push(rest[2])
    return await inner(target, content, ...rest)
  }

  // 只有严格 true 才算授权。
  assert.deepEqual(await operations.trust({ credentials: 'true' }), { ok: true, trust: { credentials: false } })
  assert.equal(state.trustCredentials, false)
  assert.deepEqual(await operations.trust({ credentials: true }), { ok: true, trust: { credentials: true } })
  assert.equal(state.trustCredentials, true)
  // 旧客户端的字段名（h3yun）继续接受：协议号虽已 +1，没必要为一个布尔值让旧页面报错。
  assert.deepEqual(await operations.trust({ h3yun: true }), { ok: true, trust: { credentials: true } })

  // **落盘**：一次授权长期有效，否则员工每次重启都要重新授权。
  assert.ok(written.length > 0, '授权必须写进工作台状态文件')
  const parsed = JSON.parse(written[written.length - 1])
  assert.equal(parsed.trustCredentials, true)
  // 员工默认是受限沙箱（workspace-write）：写 `~/.dsh/` 会被拦，于是「点了同意却存不住、
  // 重启又要重新授权」——实测踩到过。所以这次写入必须**逐次声明策略**。
  assert.equal(
    policies[policies.length - 1]?.mode,
    'danger-full-access',
    '状态文件写入必须带 sandboxPolicy，否则受限环境下授权存不住',
  )
})

test('授权状态重启后仍在（从状态文件读回，不需要重新授权）', async () => {
  // 这一条盯的是「一次授权、长期有效」：环境自检必须**先读盘**再决定是否阻塞。
  const { loadEnvironment } = await import(new URL('src/host/environment/ops.ts', ROOT).href)
  const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)
  const dirs = new Set(['/cases/space'])
  const files = { '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' }
  const ctx = {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async run(spec) {
            const command = String(spec.command)
            const out = command.includes('curl') ? '{}'
              : command.includes('dws auth status') ? JSON.stringify({ authenticated: true })
                : command.includes('h3yun session status') ? JSON.stringify({ data: { userId: 'u', expiresAt: '2099-01-01T00:00:00Z' } })
                  : command.includes(' ls ') ? 'ok\n'
                    : ''
            return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: out, truncated: false }, stderr: { text: '', truncated: false } }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\/]+$/, '')
            if (dirs.has(key)) return { type: 'directory' }
            return files[target.targetKey] === undefined ? undefined : { type: 'file' }
          },
          async readText(target) { return files[target.targetKey] ?? '' },
          async writeText(target, content) { files[target.targetKey] = content; return { operation: 'update', version: 'v', before: null, after: content } },
        }
      }
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }] }
      return undefined
    },
  }
  const state = createWorkbenchState(resolveConfig({}))
  const result = await loadEnvironment(
    { ctx, config: resolveConfig({}), state, home: '/Users/x', platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' },
    {},
  )
  assert.equal(state.trustCredentials, true, '重启后从状态文件恢复授权')
  assert.equal(result.blocked.includes('授权读取本机凭据（氚云 / 钉钉）'), false, '已授权不再阻塞')
})

test('bind-session refuses a subagent session as the audit parent', async () => {
  const sessions = {
    get(id) {
      if (id === 'sub-1') return { header: { origin: 'subagent', delegationDepth: 2, parentSession: 'top-1' } }
      if (id === 'top-1') return { header: { delegationDepth: 0 } }
      return undefined
    },
  }
  const { state, operations } = operationsFor({}, sessions)

  const rejected = await operations['bind-session']({ sessionId: 'sub-1' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.subagent, true)
  assert.equal(rejected.depth, 2)
  assert.match(rejected.error, /只允许挂在顶层会话下/)
  assert.equal(state.parentSessionId, '', '被拒绝时不得覆盖已登记的父级')

  const accepted = await operations['bind-session']({ sessionId: 'top-1' })
  assert.equal(accepted.ok, true)
  assert.equal(state.parentSessionId, 'top-1')
})

test('bind-session rejects an empty id and tolerates a missing sessions service', async () => {
  const withoutService = operationsFor()
  assert.deepEqual(await withoutService.operations['bind-session']({ sessionId: '' }), { ok: false, error: '缺少 sessionId' })
  assert.equal(withoutService.state.parentSessionId, '')
  // 会话服务不可用时保留「未知」状态，不阻断用户继续处理环境问题。
  assert.equal((await withoutService.operations['bind-session']({ sessionId: 'any' })).ok, true)
  assert.equal(withoutService.state.parentSessionId, 'any')

  // 已知偏差：包形态判空用严格 `=== ''`，legacy 用真值判断（`'   '` 两边都会被接受）。
  // 这里把当前行为钉住，好让将来收紧判空时是有意识的选择，而不是顺手改掉。
  const padded = operationsFor()
  assert.equal((await padded.operations['bind-session']({ sessionId: '   ' })).ok, true)
  assert.equal(padded.state.parentSessionId, '   ')
})

test('install-prompt resolves the URL manifest-first and keeps the legacy wording', () => {
  // 清单优先（现拉的、随组织变），Config 兜底 —— 与 env 返回 installDocUrl 的口径一致。
  const fromConfig = operationsFor({ installDocUrl: 'https://example.invalid/doc.md' })
  const result = fromConfig.operations['install-prompt']({ workspace: '/cases/x' })
  assert.equal(result.url, 'https://example.invalid/doc.md')
  assert.match(result.prompt, /先完整阅读这份安装清单/)
  assert.match(result.prompt, /不要凭经验跳步/)
  assert.match(result.prompt, /密钥、令牌一律不要回显/)
  assert.match(result.prompt, /\/cases\/x/)

  // 清单里给了地址就以它为准，哪怕 Config 也写了。
  const withManifest = operationsFor({ installDocUrl: 'https://example.invalid/doc.md' })
  withManifest.state.manifest = { ...DEFAULT_MANIFEST, installDocUrl: 'https://manifest.invalid/doc.md' }
  assert.equal(withManifest.operations['install-prompt']({}).url, 'https://manifest.invalid/doc.md')

  // 两个来源都没有时用内置常量，而不是给一个空地址。
  const fallback = operationsFor({ installDocUrl: '' })
  assert.match(fallback.operations['install-prompt']({}).url, /^https:\/\//)
})

test('audit-release clears the single-audit occupancy and reports what it released', async () => {
  const { state, operations } = operationsFor()
  state.activeKey = '2026-301705'
  state.activeChildId = 'child-1'
  state.activeSince = 123
  assert.deepEqual(await operations['audit-release']({}), { ok: true, released: '2026-301705' })
  assert.equal(state.activeKey, '')
  assert.equal(state.activeChildId, '')
  assert.equal(state.activeSince, 0)
  assert.deepEqual(await operations['audit-release']({}), { ok: true, released: '' })
})

// ── 同源 RPC 路由 ───────────────────────────────────────────────────────────

const pingOperations = { ping: async () => ({ ok: true, pong: true }) }

test('a same-origin POST reaches the named operation', async () => {
  const route = await loadRoute(pingOperations)
  const result = await invoke(route.handler, { origin: 'http://127.0.0.1:3080', body: { op: 'ping' } })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json, { ok: true, pong: true })
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.match(result.headers['content-type'], /application\/json/)
})

test('a request without an Origin header is allowed (same-origin fetch may omit it)', async () => {
  const route = await loadRoute(pingOperations)
  const result = await invoke(route.handler, { body: { op: 'ping' } })
  assert.equal(result.statusCode, 200)
})

test('a cross-origin POST is refused with 403', async () => {
  const route = await loadRoute(pingOperations)
  const result = await invoke(route.handler, { origin: 'http://evil.invalid', body: { op: 'ping' } })
  assert.equal(result.statusCode, 403)
  assert.match(result.json.error, /不允许跨域/)
})

test('a non-POST method is refused with 405', async () => {
  const route = await loadRoute(pingOperations)
  const result = await invoke(route.handler, { method: 'GET', body: { op: 'ping' } })
  assert.equal(result.statusCode, 405)
  assert.match(result.json.error, /仅支持 POST/)
})

test('an unknown operation is refused with 404 and never echoed as code', async () => {
  const route = await loadRoute(pingOperations)
  const result = await invoke(route.handler, { body: { op: 'audit-start' } })
  assert.equal(result.statusCode, 404)
  assert.match(result.json.error, /未知 op/)
})

test('an operation that throws degrades to an error envelope instead of a 500', async () => {
  const route = await loadRoute({
    boom: async () => { throw new Error('ossutil 未安装') },
  })
  const result = await invoke(route.handler, { body: { op: 'boom' } })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json, { ok: false, error: 'ossutil 未安装' })
})

test('a malformed body is an error envelope, not a crash', async () => {
  const route = await loadRoute(pingOperations)
  const result = await invoke(route.handler, { body: '{"op": "ping"' })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.ok, false)
})

test('a non-object args field degrades to an empty argument bag', async () => {
  const seen = []
  const route = await loadRoute({ ping: async (args) => { seen.push(args); return { ok: true } } })
  await invoke(route.handler, { body: { op: 'ping', args: null } })
  await invoke(route.handler, { body: { op: 'ping', args: 'nope' } })
  await invoke(route.handler, { body: { op: 'ping', args: { a: 1 } } })
  assert.deepEqual(seen, [{}, {}, { a: 1 }])
})

// ── 请求体读取 ──────────────────────────────────────────────────────────────

test('readJsonBody builds an argument object and rejects oversized payloads', async () => {
  assert.deepEqual(await readJsonBody(makeRequest({ body: { op: 'ping' } }), RPC_BODY_MAX_BYTES), { op: 'ping' })
  assert.deepEqual(await readJsonBody(makeRequest({ body: '' }), RPC_BODY_MAX_BYTES), {})

  const oversized = 'x'.repeat(RPC_BODY_MAX_BYTES + 1)
  await assert.rejects(
    readJsonBody(makeRequest({ body: oversized }), RPC_BODY_MAX_BYTES),
    /请求体过大/,
  )
})

test('RPC body cap stays at a sane order of magnitude', () => {
  assert.ok(RPC_BODY_MAX_BYTES >= 64 * 1024, '过小会让正常的分页请求被拒')
  assert.ok(RPC_BODY_MAX_BYTES <= 8 * 1024 * 1024, '过大等于没有上限')
})

test('writeJson always sends a no-store JSON body', () => {
  const { res, response } = makeResponse()
  writeJson(res, 418, { ok: false })
  assert.equal(response.statusCode, 418)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body, '{"ok":false}')
})

// ── 包清单契约 ──────────────────────────────────────────────────────────────

test('package.json entry points, files and exports stay consistent', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.deepEqual(pkg.exports, {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './package.json': './package.json',
  })
  // 装包的人必须拿到入口、补丁、许可与说明；仓库内部件（tests/legacy/install/scripts）不进包。
  for (const entry of ['lib/index.js', 'lib/client.js', 'config/crwu-workbench.yml', 'cordis.patch.yml', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md']) {
    assert.ok(pkg.files.includes(entry), `${entry} 不在 files 里，分发会缺件`)
  }
  // 技能随包发布：`skills/` 是插件专属技能，`common/skills/` 是打包前从 `plugins/common/skills/`
  // 同步进来的公共技能（npm 的 files 出不了包目录，所以必须是包内的一份真拷贝）。
  for (const entry of ['skills/', 'common/skills/']) {
    assert.ok(pkg.files.includes(entry), `${entry} 不在 files 里，员工装完就拿不到技能`)
  }
  for (const entry of ['tests', 'install', 'scripts', 'src']) {
    assert.ok(!pkg.files.includes(entry), `${entry} 是仓库内部件，不该进 npm 包`)
  }
  // git 安装拉的是源码：没有 prepare 就装不出 lib/；实现必须是随包发布的那个脚本
  // （npm 安装 tarball 时也会跑它，所以它不能依赖 src/ 或 tsconfig）。
  assert.equal(pkg.scripts.prepare, 'node scripts/prepare.mjs')
  // 打包前先同步公共技能：少了这一步，tarball 里只有插件专属技能。
  assert.match(pkg.scripts.prepack, /skills:sync/)
  assert.match(pkg.scripts.prepack, /config:check/)
  assert.match(pkg.scripts.prepack, /build:lib/)
  assert.match(pkg.scripts.build, /skills:sync/)
  assert.match(pkg.scripts.check, /skills:check/)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('the npm release path is wired: publishable, self-checked before publish', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
  // 这个插件要长期按 npm 包分发，所以不能是 private。
  assert.notEqual(pkg.private, true, '本仓按 npm 发布分发；private 会挡住发布')
  assert.equal(pkg.publishConfig.access, 'public')
  assert.equal(pkg.publishConfig.provenance, true)
  // 发布目标必须钉死在官方 registry：本机（以及国内很多开发机）的 npm registry 指向的是镜像，
  // 不钉的话 `npm publish` 会往镜像上发，而 `--provenance` 在镜像上根本不成立。
  // 这里同时核对 CI 里的 registry-url，两者不一致就是「本地一套、CI 另一套」的隐患。
  assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org')
  // 工作流在**仓库根**（`crwu-ai/.github/`），插件是子目录，所以每条 npm 命令都要靠
  // `working-directory` 立在包目录里 —— 漏了这一条，CI 会在仓根跑 npm ci 然后失败。
  const workflow = await readFile(new URL('../../.github/workflows/release.yml', ROOT), 'utf8')
  assert.match(workflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/, 'CI 与 publishConfig 必须指向同一个 registry')
  assert.match(workflow, /working-directory:\s*plugins\/dsh-crwu-workbench/, '工作流必须把 npm 命令立在插件目录里')
  // 发布前必须跑门禁与产物自检，而不是靠记得手动跑。
  assert.match(pkg.scripts.prepublishOnly, /pack:assert/)
  assert.match(pkg.scripts.prepublishOnly, /check/)
  assert.match(pkg.scripts.check, /version:check/)
  assert.match(pkg.engines.node, /22\.19/)
  // 发布前必须真的构建（prepack），否则会发出一个没有 lib/ 的包。
  assert.match(pkg.scripts.prepack, /build:lib/)
  assert.match(pkg.scripts['build:lib'], /prepare\.mjs --force/)
  assert.ok(pkg.files.includes('scripts/prepare.mjs'), 'prepare 入口必须随包发布')
})

test('an installed tarball can actually be installed and imported', async () => {
  // 这条是**对真实安装路径**的回归：npm 安装 tarball 时也会跑 `prepare`。
  // 曾经 prepare=tsdown（tarball 里没有 tsconfig）与 prepare 脚本不在 files 里两种写法都会让
  // 接收方的 `npm install` 直接失败，而本地门禁看不出来。这里真跑一遍 npm pack + npm install。
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  // Windows 上 `execFile('npm', …)` 起不来（npm 是 .cmd；Node ≥ 20.12 还直接拒绝 spawn .cmd），
  // 所以统一走 scripts/exec.mjs 的跨平台启动器。
  const { npmInvocation } = await import(new URL('scripts/exec.mjs', ROOT).href)
  const npm = npmInvocation()
  const { mkdtemp, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const run = promisify(execFile)

  const workdir = await mkdtemp(join(tmpdir(), 'crwu-pack-'))
  try {
    // npm 的 `dry_run` 配置会**继承给子进程**：在 `npm publish --dry-run`（发布前的常规自检）
    // 之下，这条测试里的 `npm pack` 会跟着变成 dry-run、不产出 tarball，于是门禁因为一个
    // 与被测行为无关的原因变红。这里显式关掉它，让测试只看「打包能不能装」这件事本身。
    const env = { ...process.env, npm_config_dry_run: 'false' }
    await run(npm.command, [...npm.args, 'pack', '--pack-destination', workdir], { cwd: fileURLToPath(ROOT), maxBuffer: 16 * 1024 * 1024, env })
    const tarball = (await (await import('node:fs/promises')).readdir(workdir)).find((name) => name.endsWith('.tgz'))
    assert.ok(tarball, 'npm pack 没有产出 tarball')

    const packageDir = join(workdir, 'pkg')
    await (await import('node:fs/promises')).mkdir(packageDir, { recursive: true })
    // 解包一律用**相对路径**：Windows 上 PATH 里的 `tar` 是 GNU tar，它把 `C:\Users\…`
    // 当成 `host:path` 去解析，于是报 `tar (child): Cannot connect to C: resolve failed`
    // （CI 的 windows 两个 Node 版本都挂在这里）。相对路径既避开这个解析，bsdtar 也照样吃。
    await run('tar', ['-xzf', tarball, '-C', 'pkg', '--strip-components=1'], { cwd: workdir })

    // 解包目录里没有 src/，所以 prepare 必须走「跳过」而不是失败。
    await run(npm.command, [...npm.args, 'install', '--no-audit', '--no-fund'], { cwd: packageDir, maxBuffer: 32 * 1024 * 1024, env })
    await stat(join(packageDir, 'lib', 'index.js'))
    await stat(join(packageDir, 'lib', 'client.js'))
    await stat(join(packageDir, 'config', 'crwu-workbench.yml'))
    // 技能是员工侧的唯一来源：专属技能与同步进来的公共技能都必须真的在包里。
    await stat(join(packageDir, 'skills', 'crwu-audit', 'SKILL.md'))
    await stat(join(packageDir, 'common', 'skills', 'crwu-dws', 'SKILL.md'))

    const activate = [
      'import("dsh-crwu-workbench").then(m => {',
      'const routes = [];',
      'const ctx = { webServer: { register: () => { routes.push(1); return () => {} } },',
      'get: () => undefined, on: () => () => {}, effect: (fn) => fn() };',
      'm.apply(ctx, m.Config({}));',
      'console.log(`${Object.keys(m).sort().join(",")}:${routes.length}`);',
      '})',
    ].join('')
    const { stdout } = await run('node', ['-e', activate], { cwd: packageDir })
    assert.equal(stdout.trim(), 'Config,ROUTE,apply,inject,name:1', '装出来的包必须从包内 YAML 激活并注册路由')
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('every client package the code imports is declared in dsh.client.inject', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
  // 扫描**整个** src/client —— 以前这里只列了 3 个文件，于是「新加一个文件、里面 import 一个新的
  // dsh-client 包」不会被发现，而 `dsh.client.inject` 决定的是激活顺序：漏声明会让面板在
  // 依赖的服务就绪之前注册槽位。
  const { readdir } = await import('node:fs/promises')
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`
      if (entry.isDirectory()) await walk(`${path}/`)
      else if (/\.tsx?$/.test(entry.name)) files.push(path)
    }
  }
  await walk('src/client/')
  assert.ok(files.length > 10, `扫描到的源文件太少（${files.length}），walk 可能没生效`)

  const imported = new Set()
  for (const file of files) {
    const source = await readFile(new URL(file, ROOT), 'utf8')
    for (const match of source.matchAll(/from\s+'(@deepseek-ai\/dsh-client-[^']+)'/g)) {
      imported.add(match[1].replace(/\/client$/, ''))
    }
  }
  assert.ok(imported.size > 0, '至少应导入一个 DSH client 包')
  for (const name of imported) {
    assert.ok(pkg.dsh.client.inject.includes(name), `${name} 被 import 但没在 dsh.client.inject 里声明`)
  }
})

test('every declared peer dependency is a real DSH package reference', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    assert.equal(typeof range, 'string')
    assert.ok(range.length > 0, `${name} 的版本区间为空`)
  }
  // 曾经把不存在于 DSH 安装里的 dsh-client-ui-slots 写进 devDependencies；这里钉住它不再出现。
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh-client-ui-slots'], undefined)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-slots'], undefined)
})
