/**
 * 自助更新的 Host 操作层（`src/host/update/ops.ts`）与装配边界的单元测试。
 *
 * 这一层是**跨进程契约的入口**：四个 `update-*` 操作走既有同源 POST 路由，返回统一的
 * `{ ok, check, install }` 快照。判据只认两件事：
 * 1. **安装目标由 Host 自己授权**：调用方只能传空参数，任何 version / registry / spec / command
 *    之类输入都必须被边界挡下，且 checker、store、Plugin Manager 零调用；
 * 2. **装配不被外部依赖拖住**：恢复先跑、检查后跑、两者都不 await；Plugin Manager 缺失时
 *    Host 照常起来并如实回 `manager-unavailable`。
 *
 * 全部依赖注入（ctx / Manager / store / discovery / 时钟 / requestId），不访问公网、不碰真实 profile。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { createUpdateOperations } = await import(new URL('src/host/update/ops.ts', ROOT).href)
const { UPDATE_PACKAGE_NAME, UPDATE_SUCCESS_TTL_MS } = await import(
  new URL('src/shared/update/consts.ts', ROOT).href
)
const { UPDATE_OPERATION_NAMES, WORKBENCH_PROTOCOL } = await import(
  new URL('src/shared/consts.ts', ROOT).href
)
const { PLUGIN_INJECT } = await import(new URL('src/host/consts.ts', ROOT).href)
const { registerRpcRoute } = await import(new URL('src/host/http/route.ts', ROOT).href)
const { FROZEN_OPERATIONS } = await import(new URL('tests/helpers/frozen-inventory.mjs', ROOT).href)

const NOW = '2026-09-28T10:00:00.000Z'
const NPMMIRROR = 'https://registry.npmmirror.com/'
const PRIVATE = 'https://npm.corp.example.com/'
const SECRET_TEXT = 'https://user:pass@npm.corp.example.com/ token=SECRET'
const ARGS_REJECTED = '更新安装不接受任何参数'

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

function makeClock(startIso = NOW) {
  let current = new Date(startIso).getTime()
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms
      return new Date(current)
    },
  }
}

function spy(impl) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return impl(...args)
  }
  fn.calls = calls
  return fn
}

const tick = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

async function waitFor(predicate, label = '条件') {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.ok(predicate(), `等待超时：${label}`)
}

const publicProfile = () => ({ registry: NPMMIRROR, fallbackRegistries: [], resolved: NPMMIRROR })

/** 一次成功的发现（候选高于当前版本，过期时间按注入时钟算）。 */
function availableNow(clock, target = '0.0.12', current = '0.0.11') {
  const at = clock.now()
  return {
    candidate: {
      currentVersion: current,
      targetVersion: target,
      sourceKind: 'npmmirror',
      checkedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + UPDATE_SUCCESS_TTL_MS).toISOString(),
    },
    sources: [
      { kind: 'npmmirror', latestVersion: target },
      { kind: 'npm', latestVersion: target },
    ],
  }
}

const discoveryOf = (sources) => ({ sources })
const bothFailed = (failure) =>
  discoveryOf([
    { kind: 'npmmirror', failure },
    { kind: 'npm', failure },
  ])

const changeResult = (patch = {}) => ({
  changed: true,
  application: 'restart-required',
  stage: 'install',
  target: UPDATE_PACKAGE_NAME,
  ...patch,
})

const bundleInfo = (name, version, installed = true) => ({
  name,
  version,
  enabled: true,
  installed,
  optional: false,
  removable: true,
  rows: [],
  overrides: [],
})

/** PluginManager 公开方法替身（含检查器要用的 registries）。 */
function fakeManager(patch = {}) {
  return {
    registries: patch.registries ?? spy(async () => publicProfile()),
    listBundles:
      patch.listBundles ?? spy(async () => [bundleInfo(UPDATE_PACKAGE_NAME, patch.diskVersion ?? '0.0.12')]),
    installBundle: patch.installBundle ?? spy(async () => changeResult()),
    waitForInstall: patch.waitForInstall ?? spy(async () => null),
    cancelInstall: patch.cancelInstall ?? spy(async () => ({ status: 'cancelled' })),
  }
}

/** 内存持久化替身；`gate` 用来把恢复卡住，证明"恢复完成前不许安装"。 */
function fakeStore(patch = {}) {
  const state = { record: patch.record, writes: [], clears: 0 }
  const store = {
    gate: patch.gate ?? null,
    async read() {
      if (store.gate !== null) await store.gate
      return state.record
    },
    async write(record) {
      state.writes.push(record)
      if (patch.writeOk === false) return false
      state.record = record
      return true
    },
    async clear() {
      state.clears += 1
      if (patch.clearOk === false) return false
      state.record = undefined
      return true
    },
    get record() {
      return state.record
    },
    get writes() {
      return state.writes
    },
    get clears() {
      return state.clears
    },
  }
  return store
}

/** Cordis 上下文替身：只实现本模块真会用到的那几件事，并记录 get / on 的用法。 */
function fakeCtx(services = {}) {
  const registrations = new Map()
  const disposers = []
  const gets = []
  const ctx = {
    gets,
    get(name) {
      gets.push(name)
      return services[name]
    },
    on(name, listener) {
      registrations.set(name, [...(registrations.get(name) ?? []), listener])
      const dispose = () => {
        registrations.set(name, (registrations.get(name) ?? []).filter((item) => item !== listener))
      }
      disposers.push(dispose)
      return dispose
    },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    logger: { info: () => {}, warn: () => {} },
    emit(name, payload) {
      for (const listener of registrations.get(name) ?? []) listener(payload)
    },
    listenerCount(name) {
      return (registrations.get(name) ?? []).length
    },
    subscribed() {
      return [...registrations.keys()]
    },
    dispose() {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    },
  }
  return ctx
}

/**
 * 组装一个操作层实例。
 *
 * `manager` 的三种来源：
 * - 省略 / 传端口 → 直接注入（替身）；
 * - `null` → 服务不存在（`ctx.get` 回 undefined）；
 * - `'ctx'` → 由 ctx 提供，**刻意不注入**，用来证明可选服务真的经 `ctx.get` 读取。
 */
function buildOps(patch = {}) {
  const clock = patch.clock ?? makeClock()
  const viaCtx = patch.manager === 'ctx'
  const manager = patch.manager === null ? undefined : (viaCtx ? fakeManager() : (patch.manager ?? fakeManager()))
  const ctx = patch.ctx ?? fakeCtx(manager === undefined ? {} : { pluginManager: manager })
  const store = patch.store ?? fakeStore()
  const discovery = patch.discovery ?? spy(async () => availableNow(clock))
  const requestIds = patch.requestIds ?? spy(() => 'req-1')
  const state = patch.state ?? { activeKey: '', startingKey: '' }
  const runtime = createUpdateOperations({
    ctx,
    state,
    version: patch.version ?? '0.0.11',
    buildKind: patch.buildKind ?? 'installed',
    home: patch.home ?? (async () => '/Users/x'),
    now: clock.now,
    newRequestId: requestIds,
    discover: discovery,
    store,
    ...(viaCtx || manager === undefined ? {} : { manager }),
  })
  return { runtime, ctx, clock, state, manager, store, discovery, requestIds }
}

// ── 路由替身（走真实的 registerRpcRoute） ───────────────────────────────────

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

async function loadRoute(operations) {
  const server = fakeWebServer()
  registerRpcRoute({ webServer: server.service }, operations)
  assert.equal(server.routes.length, 1, '仍然只有一条同源路由')
  return server.routes[0]
}

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

function makeResponse() {
  const response = { statusCode: 0, headers: {}, body: '' }
  return {
    response,
    res: {
      setHeader(name, value) {
        response.headers[name] = value
      },
      end(payload) {
        response.body = payload
      },
      set statusCode(value) {
        response.statusCode = value
      },
      get statusCode() {
        return response.statusCode
      },
    },
  }
}

async function invoke(handler, options) {
  const { res, response } = makeResponse()
  await handler(makeRequest(options), res)
  return { ...response, json: response.body === '' ? null : JSON.parse(response.body) }
}

// ---------------------------------------------------------------------------
// 一、操作表与线协议
// ---------------------------------------------------------------------------

test('1. 四个 update 操作都在操作表里，且已登记进冻结名单', async () => {
  const { runtime } = buildOps()
  assert.deepEqual(Object.keys(runtime.operations).sort(), [...UPDATE_OPERATION_NAMES].sort())
  for (const name of UPDATE_OPERATION_NAMES) {
    assert.ok(FROZEN_OPERATIONS.includes(name), `${name} 必须在冻结清单里`)
  }
})

test('2. 四个操作都返回统一的 ok/check/install 快照', async () => {
  const { runtime } = buildOps()
  for (const name of UPDATE_OPERATION_NAMES) {
    const payload = await runtime.operations[name]({})
    assert.equal(payload.ok, true, name)
    assert.deepEqual(Object.keys(payload).sort(), ['check', 'install', 'ok'], name)
    assert.equal(typeof payload.check.status, 'string', name)
    assert.equal(typeof payload.install.status, 'string', name)
  }
})

test('3. update-status 不发起任何 registry 请求（也不读 policy）', async () => {
  const { runtime, discovery, manager, store } = buildOps()
  await runtime.autoCheck
  const payload = await runtime.operations['update-status']({})

  assert.equal(payload.ok, true)
  assert.equal(discovery.calls.length, 1, '只有启动时那一次后台检查')
  assert.equal(manager.registries.calls.length, 1, 'status 自己不再读 registry policy')
  assert.equal(manager.listBundles.calls.length, 0)
  assert.equal(store.writes.length, 0)
  assert.equal(store.clears, 0)
})

test('4. update-check 是用户手动检查：force 绕过 6 小时成功缓存', async () => {
  const { runtime, discovery } = buildOps()
  await runtime.autoCheck
  const afterStartup = discovery.calls.length

  await runtime.operations['update-check']({})
  assert.equal(discovery.calls.length, afterStartup + 1, '手动检查必须真的去问上游')
  await runtime.operations['update-check']({})
  assert.equal(discovery.calls.length, afterStartup + 2, '第二次仍然绕过缓存（force:true）')
})

// ---------------------------------------------------------------------------
// 二、安装边界：只接受空参数
// ---------------------------------------------------------------------------

test('5. update-install 不接受任何参数：恶意输入无法影响安装，依赖零调用', async () => {
  const injected = [
    { package: 'evil-pkg' },
    { name: 'evil-pkg' },
    { version: '9.9.9' },
    { targetVersion: '9.9.9' },
    { registry: PRIVATE },
    { profile: 'other-profile' },
    { spec: `${UPDATE_PACKAGE_NAME}@9.9.9` },
    { command: 'npm install evil' },
    { argv: ['npm', 'install', 'evil'] },
    { approvedBuilds: ['esbuild'] },
    { enabled: false },
    { path: '/tmp/evil.tgz' },
    { installed: true },
    { nested: { version: '9.9.9' } },
  ]

  for (const args of injected) {
    const { runtime, manager, store, discovery } = buildOps()
    await runtime.autoCheck
    const before = { discovery: discovery.calls.length, registries: manager.registries.calls.length }

    const payload = await runtime.operations['update-install'](args)
    assert.deepEqual(payload, { ok: false, error: ARGS_REJECTED }, JSON.stringify(args))
    assert.deepEqual(Object.keys(payload).sort(), ['error', 'ok'], '拒绝信封不带任何状态快照')
    assert.equal(manager.installBundle.calls.length, 0, JSON.stringify(args))
    assert.equal(manager.cancelInstall.calls.length, 0)
    assert.equal(manager.registries.calls.length, before.registries, 'checker 零调用（不读 policy）')
    assert.equal(discovery.calls.length, before.discovery, 'checker 零调用（不打上游）')
    assert.equal(store.writes.length, 0, 'store 零调用（不写 installing）')
    assert.equal(store.clears, 0)
  }
})

test('6. update-cancel 在没有活动安装时是空操作，不碰 Plugin Manager', async () => {
  const { runtime, manager, store } = buildOps()
  await runtime.autoCheck
  const payload = await runtime.operations['update-cancel']({})

  assert.equal(payload.ok, true)
  assert.deepEqual(payload.install, { status: 'idle' })
  assert.equal(manager.cancelInstall.calls.length, 0)
  assert.equal(manager.installBundle.calls.length, 0)
  assert.equal(store.clears, 0)
})

test('6b. update-cancel 只取消当前活动安装的那一个 requestId', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const manager = fakeManager({
    installBundle: spy(async () => {
      await gate
      return changeResult({ application: 'cancelled' })
    }),
    cancelInstall: spy(async () => ({ status: 'cancelled' })),
  })
  const { runtime } = buildOps({ manager })
  await runtime.autoCheck

  const installing = runtime.operations['update-install']({})
  await waitFor(() => manager.installBundle.calls.length === 1, '安装已下发')
  const cancelling = runtime.operations['update-cancel']({})
  release()
  await installing
  const payload = await cancelling

  assert.deepEqual(manager.cancelInstall.calls, [['req-1']])
  assert.equal(payload.install.status, 'cancelled')
})

// ---------------------------------------------------------------------------
// 三、启动恢复屏障与后台自动检查
// ---------------------------------------------------------------------------

test('7. update-install 必须等恢复完成才授权新安装', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const store = fakeStore({ gate })
  const { runtime, manager } = buildOps({ store })

  const installing = runtime.operations['update-install']({})
  let settledEarly = false
  void installing.then(() => {
    settledEarly = true
  })
  // 状态快照同样要等恢复：否则界面会在恢复判定之前看到一份不可靠的结论。
  const status = runtime.operations['update-status']({})
  let statusSettled = false
  void status.then(() => {
    statusSettled = true
  })
  await tick(12)
  assert.equal(settledEarly, false, '恢复未完成时 update-install 不得返回')
  assert.equal(statusSettled, false, '恢复未完成时 update-status 不得返回快照')
  assert.equal(manager.installBundle.calls.length, 0, '恢复未完成时不得开始改 profile')
  assert.equal(store.writes.length, 0)

  release()
  assert.equal((await status).ok, true, '恢复完成后状态快照可用')
  const beforeCheck = await installing
  assert.equal(beforeCheck.ok, true, '恢复完成后才返回')
  assert.equal(beforeCheck.install.status, 'failed', '还没有成功检查过 → 没有可授权的候选')
  assert.equal(manager.installBundle.calls.length, 0, '授权失败就不该碰安装')

  // 恢复完成、并且真的有一次成功检查之后（候选由 Host 自己授权），安装才可能开始。
  await runtime.autoCheck
  const installed = await runtime.operations['update-install']({})
  assert.equal(installed.install.status, 'awaiting-restart')
  assert.equal(manager.installBundle.calls.length, 1)
})

test('8/9. 恢复完成前不起自动检查；完成后在后台起一次（且只一次）', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const store = fakeStore({ gate })
  const { runtime, discovery } = buildOps({ store })

  await tick(12)
  assert.equal(discovery.calls.length, 0, '恢复完成之前不得开始自动检查')

  release()
  await runtime.autoCheck
  assert.equal(discovery.calls.length, 1, '恢复完成后正好一次后台检查')
  await tick(20)
  assert.equal(discovery.calls.length, 1, '没有定时器，不会重复检查')
})

test('10. 自动检查挂起或失败都不阻塞装配，也不产生未处理拒绝', async () => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    // 挂起：discovery 永不 resolve —— 装配仍然同步完成，status / install 照常可用。
    const hanging = buildOps({ discovery: spy(() => new Promise(() => {})) })
    assert.equal(typeof hanging.runtime.operations['update-status'], 'function', '装配是同步完成的')
    const status = await hanging.runtime.operations['update-status']({})
    assert.equal(status.ok, true, 'update-status 只等恢复，不等检查')
    const install = await hanging.runtime.operations['update-install']({})
    assert.equal(install.ok, true)

    // 失败：discovery 抛错 —— 收敛成稳定失败状态，不是未处理拒绝。
    const failing = buildOps({
      discovery: spy(async () => {
        throw new Error(`boom ${SECRET_TEXT}`)
      }),
    })
    const payload = await failing.runtime.operations['update-check']({})
    assert.equal(payload.ok, true)
    assert.equal(payload.check.status, 'error')
    assert.equal(payload.check.kind, 'unknown')

    await tick(20)
    assert.deepEqual(rejections, [], '所有后台 Promise 都必须被显式收敛')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

// ---------------------------------------------------------------------------
// 四、Plugin Manager 是可选能力
// ---------------------------------------------------------------------------

test('11. Plugin Manager 缺失时：正常装配、manager-unavailable、安装零动作', async () => {
  const store = fakeStore()
  const { runtime, ctx } = buildOps({ manager: null, store })

  assert.ok(ctx.gets.includes('pluginManager'), '必须经 ctx.get 读可选服务')
  await runtime.autoCheck
  const status = await runtime.operations['update-status']({})
  assert.equal(status.ok, true)
  assert.deepEqual(status.check, { status: 'unsupported', reason: 'manager-unavailable' })
  assert.deepEqual(status.install, { status: 'idle' })

  const install = await runtime.operations['update-install']({})
  assert.equal(install.ok, true)
  assert.deepEqual(install.install, { status: 'idle' }, '能力缺失时不得进入安装流程')
  assert.equal(store.writes.length, 0, '连 installing 标记都不该写')
  assert.equal(store.clears, 0)

  const check = await runtime.operations['update-check']({})
  assert.deepEqual(check.check, { status: 'unsupported', reason: 'manager-unavailable' })
  const cancel = await runtime.operations['update-cancel']({})
  assert.equal(cancel.ok, true)
})

test('12. pluginManager 不进 PLUGIN_INJECT，且是经 ctx.get 读到的可选服务', async () => {
  assert.deepEqual(PLUGIN_INJECT, ['webServer', 'shell', 'tools'])
  assert.equal(PLUGIN_INJECT.includes('pluginManager'), false, '可选能力不得变成硬依赖')

  const { runtime, ctx } = buildOps({ manager: 'ctx' })
  await runtime.autoCheck
  assert.ok(ctx.gets.includes('pluginManager'), '必须经 ctx.get 读，而不是注入')
  const status = await runtime.operations['update-status']({})
  assert.equal(status.check.status, 'available', '服务在时检查真的接上了（registries 被读过）')
})

// ---------------------------------------------------------------------------
// 五、进度事件
// ---------------------------------------------------------------------------

function gatedInstall(patch = {}) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const manager = fakeManager({
    installBundle: spy(async () => {
      await gate
      return changeResult()
    }),
    ...patch,
  })
  return { manager, release: () => release() }
}

test('13. plugin-manager/install-state 被转交给当前任务，且只认匹配的 requestId', async () => {
  const { manager, release } = gatedInstall()
  const { runtime, ctx } = buildOps({ manager })
  await runtime.autoCheck
  assert.deepEqual(ctx.subscribed(), ['plugin-manager/install-state'])

  const installing = runtime.operations['update-install']({})
  await waitFor(() => manager.installBundle.calls.length === 1, '安装已下发')
  assert.equal((await runtime.operations['update-status']({})).install.stage, 'connecting')

  ctx.emit('plugin-manager/install-state', {
    requestId: 'req-1',
    phase: 'installing',
    attempt: { registry: NPMMIRROR, index: 1, total: 2 },
  })
  assert.equal((await runtime.operations['update-status']({})).install.stage, 'downloading')

  ctx.emit('plugin-manager/install-state', { requestId: 'req-1', phase: 'applying' })
  assert.equal((await runtime.operations['update-status']({})).install.stage, 'installing')

  // 不匹配的 requestId 继续由状态机忽略。
  ctx.emit('plugin-manager/install-state', { requestId: 'other-request', phase: 'cancelling' })
  assert.equal((await runtime.operations['update-status']({})).install.stage, 'installing')

  release()
  await installing
})

test('14. 生命周期释放之后，进度事件不再生效', async () => {
  const { manager, release } = gatedInstall()
  const { runtime, ctx } = buildOps({ manager })
  await runtime.autoCheck

  const installing = runtime.operations['update-install']({})
  await waitFor(() => manager.installBundle.calls.length === 1, '安装已下发')
  ctx.emit('plugin-manager/install-state', { requestId: 'req-1', phase: 'applying' })
  assert.equal((await runtime.operations['update-status']({})).install.stage, 'installing')

  ctx.dispose() // 插件卸载：effect 的 disposer 链被调用
  assert.equal(ctx.listenerCount('plugin-manager/install-state'), 0, '监听器必须被释放')

  ctx.emit('plugin-manager/install-state', { requestId: 'req-1', phase: 'cancelling' })
  assert.equal((await runtime.operations['update-status']({})).install.stage, 'installing', '释放后不再生效')

  release()
  await installing
})

test('15. 只订阅 install-state，绝不订阅 install-log', async () => {
  const { runtime, ctx } = buildOps()
  await runtime.autoCheck
  assert.equal(ctx.listenerCount('plugin-manager/install-log'), 0, '不得订阅或转发 pnpm 日志')
  assert.deepEqual(ctx.subscribed(), ['plugin-manager/install-state'])
})

// ---------------------------------------------------------------------------
// 六、审核占用与主导状态
// ---------------------------------------------------------------------------

test('16. 审核忙判据同时覆盖 activeKey 与 startingKey', async () => {
  for (const keys of [{ activeKey: 'audit-1' }, { startingKey: 'audit-1' }]) {
    const { runtime, manager, store } = buildOps({ state: { activeKey: '', startingKey: '', ...keys } })
    await runtime.autoCheck
    const payload = await runtime.operations['update-install']({})

    assert.equal(payload.ok, true)
    assert.deepEqual(payload.install, { status: 'failed', kind: 'audit-active' }, JSON.stringify(keys))
    assert.equal(manager.installBundle.calls.length, 0, JSON.stringify(keys))
    assert.equal(store.writes.length, 0, JSON.stringify(keys))
  }

  const idle = buildOps()
  await idle.runtime.autoCheck
  assert.equal((await idle.runtime.operations['update-install']({})).install.status, 'awaiting-restart')
})

test('17. awaiting-restart 阻止重复安装，且检查不覆盖它', async () => {
  const record = {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  }
  const manager = fakeManager({ diskVersion: '0.0.12' })
  const { runtime, discovery } = buildOps({ manager, store: fakeStore({ record }) })

  assert.equal((await runtime.operations['update-status']({})).install.status, 'awaiting-restart')

  const install = await runtime.operations['update-install']({})
  assert.equal(install.install.status, 'awaiting-restart')
  assert.equal(manager.installBundle.calls.length, 0, '重启前不得再次修改 profile')
  assert.equal(manager.cancelInstall.calls.length, 0)

  const check = await runtime.operations['update-check']({})
  assert.equal(check.install.status, 'awaiting-restart', '检查不得覆盖安装状态')
  assert.ok(['available', 'up-to-date'].includes(check.check.status), check.check.status)
  assert.ok(discovery.calls.length >= 1)
})

test('18. 恢复得到 updated 时，update-status 返回本进程的一次性成功结论', async () => {
  const record = {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  }
  const store = fakeStore({ record })
  const { runtime } = buildOps({ version: '0.0.12', store })

  const payload = await runtime.operations['update-status']({})
  assert.deepEqual(payload.install, { status: 'updated', version: '0.0.12' })
  assert.equal(store.record, undefined, '磁盘标记必须已经清除')
  assert.equal(store.clears, 1)
  assert.equal(store.writes.length, 0, '不得建立第二份事实源')
})

// ---------------------------------------------------------------------------
// 七、脱敏、协议号与同源路由
// ---------------------------------------------------------------------------

test('19. 四个操作的响应里没有 URL、凭据、日志、命令、requestId 或异常原文', async () => {
  const manager = fakeManager({
    installBundle: spy(async () =>
      changeResult({
        application: 'failed',
        error: { code: 'operation-error', diagnostic: `boom ${SECRET_TEXT}` },
        registries: [PRIVATE],
        packageResult: {
          exitCode: 1,
          output: `pnpm ERR! ${SECRET_TEXT}`,
          truncated: false,
          logPath: '/tmp/pnpm.log',
          kind: 'network',
        },
        warnings: [`left as is ${SECRET_TEXT}`],
      }),
    ),
  })
  const { runtime } = buildOps({ manager, discovery: spy(async () => bothFailed({ kind: 'http', status: 500 })) })
  await runtime.autoCheck

  const payloads = [
    await runtime.operations['update-status']({}),
    await runtime.operations['update-check']({}),
    await runtime.operations['update-install']({}),
    await runtime.operations['update-cancel']({}),
  ]
  for (const payload of payloads) {
    const serialized = JSON.stringify(payload)
    for (const forbidden of [
      PRIVATE,
      'npm.corp.example.com',
      'user:pass',
      'SECRET',
      'token=',
      'pnpm ERR',
      'pnpm.log',
      'diagnostic',
      'req-1',
      'Error:',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} 出现在 ${serialized}`)
    }
  }
})

test('20. 协议号精确为 21（钉钉登录拆成两阶段）', () => {
  // 18 = 本机访问授权收据 + 授权前零副作用自检；19 = 审核 scope 绑定
  //（案例目录/根会话 cwd 与沙箱边界都从"工作空间"收紧到"本轮案例目录"，氚云记录查询移出审核能力集）；
  // 20 = 新增 `browser-session-bind`（客户端读到 h3_token 后经标准输入交给 CLI 落 OS 凭据存储）；
  // 21 = 钉钉登录拆成 `dws-login-start` / `dws-login-status`（`dws auth login` 改后台跑）。
  assert.equal(WORKBENCH_PROTOCOL, 21)
})

test('21. 四个操作名与冻结清单一致（boot 的声明由真实操作表推导）', async () => {
  const { runtime } = buildOps()
  assert.deepEqual(Object.keys(runtime.operations).sort(), [...UPDATE_OPERATION_NAMES].sort())
  assert.deepEqual(
    FROZEN_OPERATIONS.filter((name) => name.startsWith('update-')).sort(),
    [...UPDATE_OPERATION_NAMES].sort(),
  )
})

test('22. 四个操作都走既有的同源 POST 路由（不新增路由、不放宽跨域）', async () => {
  const { runtime } = buildOps()
  const route = await loadRoute(runtime.operations)

  for (const name of UPDATE_OPERATION_NAMES) {
    const answer = await invoke(route.handler, { body: { op: name, args: {} } })
    assert.equal(answer.statusCode, 200, name)
    assert.equal(answer.json.ok, true, name)
    assert.deepEqual(Object.keys(answer.json).sort(), ['check', 'install', 'ok'], name)
  }

  assert.equal((await invoke(route.handler, { method: 'GET' })).statusCode, 405, '仍然只支持 POST')
  assert.equal(
    (await invoke(route.handler, { origin: 'http://evil.example' })).statusCode,
    403,
    '跨域仍然被拒',
  )
  assert.equal((await invoke(route.handler, { body: { op: 'update-unknown', args: {} } })).statusCode, 404)

  // 参数注入在路由层就被挡住（操作层是唯一判据，路由不改）。
  const injected = await invoke(route.handler, { body: { op: 'update-install', args: { version: '9.9.9' } } })
  assert.equal(injected.statusCode, 200)
  assert.deepEqual(injected.json, { ok: false, error: ARGS_REJECTED })
})
