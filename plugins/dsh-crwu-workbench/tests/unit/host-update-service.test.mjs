/**
 * 安装服务（`src/host/update/service.ts`）、Plugin Manager 薄适配（`manager.ts`）与
 * `pluginUpdate` 持久化（`persist.ts`）的单元测试。
 *
 * 这一层管的是**真正会改 profile 的动作**，所以判据必须硬：
 * - 安装 spec 与 options 由 Host 固定构造，Client 无从提交包名/版本/registry；
 * - 授权来自 Task 2 的异步 `installableCandidate()`，授权失败一律不碰 Manager；
 * - 先持久化 `installing`，写不进去就不开始装；
 * - 成功必须由**磁盘事实**确认，Promise resolve 不算成功；
 * - 取消不谎报，恢复不自动重装，且对外状态里没有日志、URL、凭据或异常原文。
 *
 * 全部依赖注入：不碰真实 home、不调用真实 Plugin Manager、不访问公网。
 * 持久化用例走**真实**的 `readWorkbenchConfigResult` / `writeWorkbenchConfig`（配内存 fs 替身），
 * 因此"合并写入保留兄弟字段""清除后整键消失"是真判据，不是替身自证。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { createUpdateService } = await import(new URL('src/host/update/service.ts', ROOT).href)
const { installSpecOf, installOptionsOf, installStageOf, classifyChangeResult, readDiskVersion, installThroughManager } =
  await import(new URL('src/host/update/manager.ts', ROOT).href)
const { createPluginUpdateStore, pluginUpdateStoreOf, parsePluginUpdate, pluginUpdatePatch, clearPluginUpdatePatch } =
  await import(new URL('src/host/update/persist.ts', ROOT).href)
const { UPDATE_PACKAGE_NAME, UPDATE_SUCCESS_TTL_MS } = await import(
  new URL('src/shared/update/consts.ts', ROOT).href
)

const NOW = '2026-09-28T10:00:00.000Z'
const NPMMIRROR = 'https://registry.npmmirror.com/'
const PRIVATE = 'https://npm.corp.example.com/'
const SECRET_TEXT = 'https://user:pass@npm.corp.example.com/ token=SECRET'

// ---------------------------------------------------------------------------
// 替身与工具
// ---------------------------------------------------------------------------

/** 可推进的注入时钟。 */
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

/** 计数替身：调用次数与实参就是"有没有打上游/有没有碰 Manager"的判据。 */
function spy(impl) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return impl(...args)
  }
  fn.calls = calls
  return fn
}

/** Task 2 的授权读取替身。 */
function fakeChecker(candidate) {
  return {
    installableCandidate: spy(async () => candidate),
    status: () => ({ status: 'idle' }),
    check: async () => ({ status: 'idle' }),
  }
}

/** 一次仍有效的授权候选。 */
function availableCandidate(clock, target = '0.0.12', current = '0.0.11') {
  const at = clock.now()
  return {
    currentVersion: current,
    targetVersion: target,
    sourceKind: 'npmmirror',
    checkedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + UPDATE_SUCCESS_TTL_MS).toISOString(),
  }
}

/** 实例级持久化替身（内存），并把写入顺序记进共享日志。 */
function memoryStore(options = {}) {
  const state = { record: options.record, writes: [], clears: 0 }
  const log = options.log
  const store = {
    // 暴露给测试：失败模式可以中途改（例如"第一次清除失败、第二次成功"）。
    options,
    get record() {
      return state.record
    },
    get writes() {
      return state.writes
    },
    get clears() {
      return state.clears
    },
    async read() {
      if (store.options.readThrows === true) throw new Error(`read boom ${SECRET_TEXT}`)
      return state.record
    },
    async write(record) {
      state.writes.push(record)
      log?.push(`persist:${record.phase}`)
      if (store.options.writeOk === false) return false
      state.record = record
      return true
    },
    async clear() {
      state.clears += 1
      log?.push('persist:clear')
      if (store.options.clearThrows === true) throw new Error(`clear boom ${SECRET_TEXT}`)
      if (store.options.clearOk === false) return false
      state.record = undefined
      return true
    },
  }
  return store
}

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

/** PluginManager 公开方法替身。 */
function fakeManager(options = {}) {
  const log = options.log
  return {
    listBundles:
      options.listBundles ??
      spy(async () => {
        log?.push('manager:listBundles')
        return [bundleInfo(UPDATE_PACKAGE_NAME, options.diskVersion ?? '0.0.12')]
      }),
    installBundle:
      options.installBundle ??
      spy(async () => {
        log?.push('manager:install')
        return changeResult()
      }),
    waitForInstall:
      options.waitForInstall ??
      spy(async () => {
        log?.push('manager:wait')
        return null
      }),
    cancelInstall:
      options.cancelInstall ??
      spy(async () => {
        log?.push('manager:cancel')
        return { status: 'cancelled' }
      }),
  }
}

function createHarness(options = {}) {
  const clock = options.clock ?? makeClock()
  const log = options.log ?? []
  const candidate = 'candidate' in options ? options.candidate : availableCandidate(clock)
  const checker = options.checker ?? fakeChecker(candidate)
  const store = options.store ?? memoryStore({ record: options.record, log, ...(options.storeOptions ?? {}) })
  const manager = options.manager ?? fakeManager({ log, ...(options.managerOptions ?? {}) })
  const requestIds = options.requestIds ?? spy(() => 'req-1')
  const service = createUpdateService({
    version: options.version ?? '0.0.11',
    now: clock.now,
    newRequestId: requestIds,
    checker,
    manager,
    store,
    auditBusy: options.auditBusy ?? (() => false),
  })
  return { service, clock, checker, store, manager, requestIds, log }
}

/** 让出若干个微任务，便于制造"安装进行中"的中间态。 */
const tick = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/** 等到某个条件成立（有界）。异步状态机里不要在"以为已经走到某一步"上赌微任务次数。 */
async function waitFor(predicate, label = '条件') {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.ok(predicate(), `等待超时：${label}`)
}

/** 内存 fs 替身（与 tests/unit/host-state-workspace.test.mjs 同一手法）。 */
function memoryFs(initial = {}) {
  const files = { ...initial }
  return {
    files,
    ctx: {
      get: (name) =>
        name === 'fs'
          ? {
              async resolve(path) {
                return { targetKey: path, displayPath: path }
              },
              async stat(target) {
                return files[target.targetKey] === undefined ? undefined : { type: 'file' }
              },
              async readText(target) {
                return files[target.targetKey]
              },
              async writeText(target, content) {
                files[target.targetKey] = content
                return { operation: 'update', version: 'v', before: null, after: content }
              },
            }
          : undefined,
    },
  }
}

const CONFIG_PATH = '/Users/x/.dsh/crwu-workbench.json'
const readConfigFile = (fs) => JSON.parse(fs.files[CONFIG_PATH])

const FORBIDDEN = [PRIVATE, 'npm.corp.example.com', 'user:pass', 'SECRET', 'token=', 'Error:', 'pnpm ERR']

function assertClean(value, label) {
  const serialized = JSON.stringify(value)
  for (const forbidden of FORBIDDEN) {
    assert.equal(serialized.includes(forbidden), false, `${label} 不得包含 ${forbidden}`)
  }
  return serialized
}

// ---------------------------------------------------------------------------
// 一、持久化（需求 1–6）
// ---------------------------------------------------------------------------

test('持久化 1：合法记录可解析，版本与时间被规范化', async () => {
  const installing = parsePluginUpdate({
    pluginUpdate: {
      phase: 'installing',
      fromVersion: '0.0.11',
      targetVersion: '0.0.12',
      startedAt: NOW,
    },
  })
  assert.deepEqual(installing, {
    phase: 'installing',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
  })

  const awaiting = {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  }
  assert.deepEqual(parsePluginUpdate({ pluginUpdate: awaiting }), awaiting)

  // 非规范写法（v 前缀 / 带空白的日期）解析后是规范化形式。
  const normalized = parsePluginUpdate({
    pluginUpdate: { ...awaiting, fromVersion: 'v0.0.11' },
  })
  assert.equal(normalized.fromVersion, '0.0.11')

  // 真实 store 走真实读盘（readWorkbenchConfigResult）。
  const fs = memoryFs({ [CONFIG_PATH]: JSON.stringify({ workspacePath: '/cases/a', pluginUpdate: awaiting }) })
  const store = pluginUpdateStoreOf(fs.ctx, '/Users/x')
  assert.deepEqual(await store.read(), awaiting)
})

test('持久化 2：malformed 记录一律安全忽略（不抛异常）', async () => {
  const base = {
    phase: 'installing',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
  }
  const cases = [
    ['缺少 pluginUpdate', {}],
    ['pluginUpdate 不是对象', { pluginUpdate: 'installing' }],
    ['pluginUpdate 是数组', { pluginUpdate: [] }],
    ['phase 不认识', { pluginUpdate: { ...base, phase: 'installed' } }],
    ['phase 不认识但带 installedAt（不得被当成 awaiting-restart）', { pluginUpdate: { ...base, phase: 'installed', installedAt: NOW } }],
    ['phase 是数字', { pluginUpdate: { ...base, phase: 1, installedAt: NOW } }],
    ['phase 缺失', { pluginUpdate: { fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW } }],
    ['fromVersion 非法', { pluginUpdate: { ...base, fromVersion: '不是版本' } }],
    ['targetVersion 非法', { pluginUpdate: { ...base, targetVersion: '0.0' } }],
    ['target 等于 from', { pluginUpdate: { ...base, targetVersion: '0.0.11' } }],
    ['target 低于 from', { pluginUpdate: { ...base, targetVersion: '0.0.10' } }],
    ['startedAt 非法', { pluginUpdate: { ...base, startedAt: '不是时间' } }],
    ['startedAt 类型不对', { pluginUpdate: { ...base, startedAt: 17 } }],
    ['installing 伪造 installedAt', { pluginUpdate: { ...base, installedAt: NOW } }],
    ['awaiting-restart 缺 installedAt', { pluginUpdate: { ...base, phase: 'awaiting-restart' } }],
    ['awaiting-restart 的 installedAt 非法', { pluginUpdate: { ...base, phase: 'awaiting-restart', installedAt: 'x' } }],
    ['顶层不是对象', 'nope'],
    ['顶层是数组', [base]],
  ]
  for (const [label, config] of cases) {
    let parsed
    assert.doesNotThrow(() => {
      parsed = parsePluginUpdate(config)
    }, label)
    assert.equal(parsed, undefined, label)
  }
})

test('持久化 3：合并写入保留 workspace/trust/audit 与未知兄弟字段', async () => {
  const fs = memoryFs({
    [CONFIG_PATH]: JSON.stringify({
      workspacePath: '/cases/a',
      trustCredentials: true,
      audits: [{ key: 'k1' }],
      futureField: { nested: [1, 2, 3] },
    }),
  })
  const store = pluginUpdateStoreOf(fs.ctx, '/Users/x')
  const record = {
    phase: 'installing',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
  }
  assert.equal(await store.write(record), true)

  const file = readConfigFile(fs)
  assert.deepEqual(file.pluginUpdate, record)
  assert.equal(file.workspacePath, '/cases/a')
  assert.equal(file.trustCredentials, true)
  assert.deepEqual(file.audits, [{ key: 'k1' }])
  assert.deepEqual(file.futureField, { nested: [1, 2, 3] })
  assert.deepEqual(Object.keys(file).sort(), ['audits', 'futureField', 'pluginUpdate', 'trustCredentials', 'workspacePath'])
})

test('持久化 4：清除后顶层 pluginUpdate 真正消失，其它字段一个不少', async () => {
  const fs = memoryFs({
    [CONFIG_PATH]: JSON.stringify({
      workspacePath: '/cases/a',
      trustCredentials: true,
      pluginUpdate: {
        phase: 'awaiting-restart',
        fromVersion: '0.0.11',
        targetVersion: '0.0.12',
        startedAt: NOW,
        installedAt: NOW,
      },
    }),
  })
  const store = pluginUpdateStoreOf(fs.ctx, '/Users/x')
  assert.equal(await store.clear(), true)

  const file = readConfigFile(fs)
  assert.equal('pluginUpdate' in file, false, '清除必须是整键消失')
  assert.equal(file.workspacePath, '/cases/a')
  assert.equal(file.trustCredentials, true)

  // 补丁本身也只带这一个键（不得整体覆盖）。
  assert.deepEqual(Object.keys(pluginUpdatePatch({
    phase: 'installing',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
  })), ['pluginUpdate'])
  assert.deepEqual(Object.keys(clearPluginUpdatePatch()), ['pluginUpdate'])
  assert.equal(clearPluginUpdatePatch().pluginUpdate, undefined)
})

test('持久化 5：落盘内容只有恢复必需字段，没有 registry/requestId/日志/token/命令', async () => {
  const fs = memoryFs({})
  const store = pluginUpdateStoreOf(fs.ctx, '/Users/x')
  await store.write({ phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW })
  await store.write({
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  })

  const file = readConfigFile(fs)
  assert.deepEqual(Object.keys(file.pluginUpdate).sort(), [
    'fromVersion',
    'installedAt',
    'phase',
    'startedAt',
    'targetVersion',
  ])
  const serialized = JSON.stringify(file)
  for (const forbidden of ['registry', 'requestId', 'npmmirror', 'pnpm', 'token', 'command', 'output', 'log']) {
    assert.equal(serialized.includes(forbidden), false, `持久化内容不得包含 ${forbidden}`)
  }
})

test('持久化 6：installing 写入失败时绝不调用 Plugin Manager', async () => {
  const harness = createHarness({ storeOptions: { writeOk: false } })
  const state = await harness.service.install()

  assert.equal(state.status, 'failed')
  assert.equal(harness.store.writes.length, 1, '尝试过写入')
  assert.equal(harness.manager.installBundle.calls.length, 0)
  assert.equal(harness.manager.waitForInstall.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 二、安装（需求 7–22）
// ---------------------------------------------------------------------------

test('安装 7/8/9：无参数、固定 spec 与 options、target 来自授权读取', async () => {
  const harness = createHarness({ log: [] })
  assert.equal(harness.service.install.length, 0, 'install() 不接受任何参数')

  await harness.service.install()

  assert.equal(harness.checker.installableCandidate.calls.length, 1)
  assert.deepEqual(harness.manager.installBundle.calls, [
    [`${UPDATE_PACKAGE_NAME}@0.0.12`, { enabled: true, requestId: 'req-1', registry: NPMMIRROR }],
  ])
  assert.equal(installSpecOf('0.0.12'), `${UPDATE_PACKAGE_NAME}@0.0.12`)
  assert.deepEqual(installOptionsOf('req-1'), { enabled: true, requestId: 'req-1', registry: NPMMIRROR })
})

test('安装 10：授权 undefined 时 manager 零调用', async () => {
  const harness = createHarness({ candidate: undefined })
  const state = await harness.service.install()

  assert.equal(state.status, 'failed')
  assert.equal(harness.manager.installBundle.calls.length, 0)
  assert.equal(harness.store.writes.length, 0, '没有授权就不该留下 installing 标记')
})

test('安装 11：审核任务进行中拒绝安装，返回稳定 audit-active', async () => {
  const harness = createHarness({ auditBusy: () => true })
  const state = await harness.service.install()

  assert.deepEqual(state, { status: 'failed', kind: 'audit-active' })
  assert.equal(harness.manager.installBundle.calls.length, 0)
  assert.equal(harness.checker.installableCandidate.calls.length, 0, '审核中连授权都不必读')
  assert.equal(harness.store.writes.length, 0)
})

test('安装 12：target 不高于运行版本（含预发布）时拒绝', async () => {
  const clock = makeClock()
  for (const target of ['0.0.11', '0.0.10', '0.0.12-rc.1']) {
    const harness = createHarness({ clock, candidate: availableCandidate(clock, target) })
    const state = await harness.service.install()
    assert.equal(state.status, 'failed', target)
    assert.equal(harness.manager.installBundle.calls.length, 0, target)
    assert.equal(harness.store.writes.length, 0, target)
  }
})

test('安装 13：并发两次只产生一个 requestId、一次持久化、一次 manager 调用', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const log = []
  let sequence = 0
  const harness = createHarness({
    log,
    requestIds: spy(() => `req-${(sequence += 1)}`),
    managerOptions: {
      installBundle: spy(async () => {
        log.push('manager:install')
        await gate
        return changeResult()
      }),
    },
  })

  const first = harness.service.install()
  const second = harness.service.install()
  assert.equal(first, second, '重复点击必须复用同一 in-flight')

  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(harness.requestIds.calls.length, 1)
  assert.deepEqual(
    harness.store.writes.map((record) => record.phase),
    ['installing', 'awaiting-restart'],
    'installing 只落盘一次（另一次是成功后的 awaiting-restart）',
  )
  assert.equal(harness.manager.installBundle.calls.length, 1)
  assert.equal(harness.manager.installBundle.calls[0][1].requestId, 'req-1')

  // 完成后 in-flight 被清掉：下一次安装是一个新任务（新 requestId）。
  const third = await harness.service.install()
  assert.equal(third.status, 'awaiting-restart')
  assert.equal(harness.requestIds.calls.length, 2)
  assert.equal(harness.manager.installBundle.calls.length, 2)
  assert.equal(harness.manager.installBundle.calls[1][1].requestId, 'req-2')
})

test('安装 14：installing 在调用 Manager 之前已经持久化', async () => {
  const log = []
  const harness = createHarness({ log })
  await harness.service.install()

  assert.deepEqual(log, ['persist:installing', 'manager:install', 'manager:listBundles', 'persist:awaiting-restart'])
})

test('安装 15/16：四阶段映射；不匹配 requestId 的进度被忽略', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = createHarness({
    managerOptions: {
      installBundle: spy(async () => {
        await gate
        return changeResult()
      }),
    },
  })

  assert.deepEqual(harness.service.status(), { status: 'idle' })
  // 没有活动安装时任何进度都不接受。
  harness.service.acceptProgress({ requestId: 'req-1', phase: 'applying' })
  assert.deepEqual(harness.service.status(), { status: 'idle' })

  const installing = harness.service.install()
  await waitFor(() => harness.service.status().status === 'installing', '进入安装中')
  const active = harness.service.status()
  assert.equal(active.stage, 'connecting', '调用开始、还没收到事件时是 connecting')
  assert.equal(active.targetVersion, '0.0.12')

  harness.service.acceptProgress({ requestId: 'other-request', phase: 'applying' })
  assert.equal(harness.service.status().stage, 'connecting', '不匹配的 requestId 必须忽略')

  harness.service.acceptProgress({
    requestId: 'req-1',
    phase: 'installing',
    attempt: { registry: NPMMIRROR, index: 1, total: 2 },
  })
  assert.equal(harness.service.status().stage, 'downloading')

  // 带 attempt 的那次进度之后立刻检查：进度状态里不得带 attempt / registry。
  const afterProgress = assertClean(harness.service.status(), '带 attempt 的进度状态')
  assert.equal(afterProgress.includes('registry'), false)
  assert.equal(afterProgress.includes('attempt'), false)

  harness.service.acceptProgress({ requestId: 'req-1', phase: 'applying' })
  assert.equal(harness.service.status().stage, 'installing')

  harness.service.acceptProgress({ requestId: 'req-1', phase: 'cancelling' })
  assert.equal(harness.service.status().stage, 'cancelling')

  const serialized = assertClean(harness.service.status(), '进度状态')
  assert.equal(serialized.includes('registry'), false)
  assert.equal(serialized.includes('attempt'), false)

  release()
  await installing
  assert.deepEqual(installStageOf('installing'), 'downloading')
  assert.deepEqual(installStageOf('applying'), 'installing')
  assert.deepEqual(installStageOf('cancelling'), 'cancelling')
})

test('安装 17：成功结果 + 磁盘目标版本 → awaiting-restart，并持久化 installedAt', async () => {
  for (const application of ['restart-required', 'applied']) {
    const clock = makeClock()
    const harness = createHarness({
      clock,
      managerOptions: { installBundle: spy(async () => changeResult({ application })) },
    })
    const state = await harness.service.install()

    assert.equal(state.status, 'awaiting-restart', application)
    assert.equal(state.targetVersion, '0.0.12')
    assert.equal(state.installedAt, clock.now().toISOString())
    assert.deepEqual(harness.store.writes.map((record) => record.phase), ['installing', 'awaiting-restart'])
    assert.deepEqual(harness.store.record, {
      phase: 'awaiting-restart',
      fromVersion: '0.0.11',
      targetVersion: '0.0.12',
      startedAt: NOW,
      installedAt: clock.now().toISOString(),
    })
  }

  // 磁盘上是更高版本也算"目标已达成"。
  const higher = createHarness({ managerOptions: { diskVersion: '0.0.13' } })
  assert.equal((await higher.service.install()).status, 'awaiting-restart')
})

test('安装 18：failed/cancelled/overridden/自相矛盾结果都不进入 awaiting-restart', async () => {
  const clock = makeClock()
  const cases = [
    [
      'failed',
      changeResult({ application: 'failed', packageResult: { exitCode: 1, output: 'x', truncated: false, logPath: '/l', kind: 'disk-full' } }),
      (state) => assert.deepEqual(state, { status: 'failed', kind: 'disk-full', targetVersion: '0.0.12' }),
    ],
    ['cancelled', changeResult({ application: 'cancelled' }), (state) => assert.deepEqual(state, { status: 'cancelled', targetVersion: '0.0.12' })],
    [
      'overridden',
      changeResult({ application: 'overridden' }),
      (state) => assert.deepEqual(state, { status: 'failed', kind: 'unknown', targetVersion: '0.0.12' }),
    ],
  ]
  for (const [label, result, check] of cases) {
    const harness = createHarness({ clock, managerOptions: { installBundle: spy(async () => result) } })
    check(await harness.service.install())
    assert.equal(
      harness.store.writes.some((record) => record.phase === 'awaiting-restart'),
      false,
      `${label} 不得写入 awaiting-restart`,
    )
  }

  // ChangeResult 说成功，但磁盘自相矛盾（旧版本 / 没有这个包 / 读不出来）→ unknown。
  const contradictions = [
    ['磁盘仍是旧版本', { diskVersion: '0.0.11' }],
    ['磁盘没有这个包', { listBundles: spy(async () => []) }],
    ['磁盘版本不可解析', { listBundles: spy(async () => [bundleInfo(UPDATE_PACKAGE_NAME, 'not-a-version')]) }],
    ['包未装入 profile', { listBundles: spy(async () => [bundleInfo(UPDATE_PACKAGE_NAME, '0.0.12', false)]) }],
    [
      'listBundles 抛错',
      {
        listBundles: spy(async () => {
          throw new Error(`boom ${SECRET_TEXT}`)
        }),
      },
    ],
  ]
  for (const [label, managerOptions] of contradictions) {
    const harness = createHarness({ clock, managerOptions })
    const state = await harness.service.install()
    assert.deepEqual(state, { status: 'failed', kind: 'unknown', targetVersion: '0.0.12' }, label)
    assert.equal(
      harness.store.writes.some((record) => record.phase === 'awaiting-restart'),
      false,
      label,
    )
  }
})

test('安装 19/20：installBundle 抛错后用 waitForInstall 恢复；返回 null 只能判 unknown', async () => {
  const clock = makeClock()
  const thrown = {
    installBundle: spy(async () => {
      throw new Error(`boom ${SECRET_TEXT}`)
    }),
  }

  const recovered = createHarness({
    clock,
    managerOptions: { ...thrown, waitForInstall: spy(async () => changeResult()) },
  })
  assert.equal((await recovered.service.install()).status, 'awaiting-restart')
  assert.deepEqual(recovered.manager.waitForInstall.calls, [['req-1']])

  const cancelled = createHarness({
    clock,
    managerOptions: { ...thrown, waitForInstall: spy(async () => changeResult({ application: 'cancelled' })) },
  })
  assert.equal((await cancelled.service.install()).status, 'cancelled')

  for (const managerOptions of [
    { ...thrown, waitForInstall: spy(async () => null) },
    {
      ...thrown,
      waitForInstall: spy(async () => {
        throw new Error(`wait boom ${SECRET_TEXT}`)
      }),
    },
  ]) {
    const harness = createHarness({ clock, managerOptions })
    const state = await harness.service.install()
    assert.deepEqual(state, { status: 'failed', kind: 'unknown', targetVersion: '0.0.12' }, 'null 不能猜成功')
    assert.equal(harness.store.writes.some((record) => record.phase === 'awaiting-restart'), false)
  }
})

test('安装 21：Plugin Manager 失败种类映射稳定', async () => {
  const failure = (kind, patch = {}) =>
    changeResult({
      application: 'failed',
      packageResult: { exitCode: 1, output: 'out', truncated: false, logPath: '/l', kind },
      ...patch,
    })
  const cases = [
    ['not-found', failure('not-found'), { kind: 'failed', reason: 'not-found' }],
    ['no-matching-version', failure('no-matching-version'), { kind: 'failed', reason: 'not-found' }],
    ['network', failure('network'), { kind: 'failed', reason: 'source-unavailable' }],
    ['timeout', failure('timeout'), { kind: 'failed', reason: 'timeout' }],
    ['disk-full', failure('disk-full'), { kind: 'failed', reason: 'disk-full' }],
    ['permission', failure('permission'), { kind: 'failed', reason: 'permission' }],
    ['build-blocked', failure('build-blocked'), { kind: 'failed', reason: 'build-blocked' }],
    ['integrity', failure('integrity'), { kind: 'failed', reason: 'integrity' }],
    ['pnpm-missing', failure('pnpm-missing'), { kind: 'failed', reason: 'unknown' }],
    ['没有 kind', failure(undefined), { kind: 'failed', reason: 'unknown' }],
    [
      'error.code 不兼容',
      failure('network', { error: { code: 'incompatible-version' } }),
      { kind: 'failed', reason: 'incompatible-version' },
    ],
    [
      'packageResult.incompatible',
      failure('network', {
        packageResult: {
          exitCode: 1,
          output: '',
          truncated: false,
          logPath: '/l',
          kind: 'network',
          incompatible: [{ name: 'x', version: '1', runtimeVersion: '0', peers: {} }],
        },
      }),
      { kind: 'failed', reason: 'incompatible-version' },
    ],
    ['等待批准的构建脚本', changeResult({ application: 'failed', pendingBuilds: ['esbuild'] }), { kind: 'failed', reason: 'build-blocked' }],
    ['干净的成功结果', changeResult(), { kind: 'ok', application: 'restart-required' }],
    ['applied 也算成功', changeResult({ application: 'applied' }), { kind: 'ok', application: 'applied' }],
    ['overridden 不得谎报成功', changeResult({ application: 'overridden' }), { kind: 'unknown' }],
    ['cancelled', changeResult({ application: 'cancelled' }), { kind: 'cancelled' }],
  ]
  for (const [label, result, expected] of cases) {
    assert.deepEqual(classifyChangeResult(result), expected, label)
  }

  // 端到端：状态里只出现稳定分类，不出现日志/诊断/registry 数组。
  const harness = createHarness({
    managerOptions: {
      installBundle: spy(async () =>
        failure('permission', {
          error: { code: 'operation-error', diagnostic: `failed at ${PRIVATE} token=SECRET` },
          registries: [PRIVATE, NPMMIRROR],
          packageResult: {
            exitCode: 1,
            output: `pnpm ERR! ${SECRET_TEXT}`,
            truncated: false,
            logPath: '/tmp/pnpm.log',
            kind: 'permission',
          },
        }),
      ),
    },
  })
  const state = await harness.service.install()
  assert.deepEqual(state, { status: 'failed', kind: 'permission', targetVersion: '0.0.12' })
  assertClean(state, '安装失败状态')
})

test('安装 22：输出状态与持久化记录不含日志、URL、凭据与异常原文', async () => {
  const harness = createHarness({
    managerOptions: {
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
    },
  })
  const state = await harness.service.install()

  assert.equal(state.status, 'failed')
  assertClean(state, '安装状态')
  assertClean(harness.store.writes, '持久化记录')
  assertClean(harness.manager.installBundle.calls, '调用实参')
  assert.equal(JSON.stringify(state).includes('pnpm.log'), false)
})

// ---------------------------------------------------------------------------
// 三、取消（需求 23–26）
// ---------------------------------------------------------------------------

test('取消 23/24：没有活动安装不调用 cancelInstall；有活动安装只取消当前 requestId', async () => {
  const idle = createHarness()
  assert.deepEqual(await idle.service.cancel(), { status: 'idle' })
  assert.equal(idle.manager.cancelInstall.calls.length, 0)

  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const active = createHarness({
    managerOptions: {
      installBundle: spy(async () => {
        await gate
        return changeResult({ application: 'cancelled' })
      }),
      cancelInstall: spy(async () => ({ status: 'cancelled' })),
    },
  })
  const installing = active.service.install()
  await waitFor(() => active.manager.installBundle.calls.length === 1, '安装已下发')
  const cancelling = active.service.cancel()
  release()
  const cancelled = await cancelling
  await installing

  assert.deepEqual(active.manager.cancelInstall.calls, [['req-1']], '只取消当前活动 requestId')
  assert.deepEqual(cancelled, { status: 'cancelled', targetVersion: '0.0.12' })

  // 安装完成后活动任务已清理，再取消不得再碰 Manager。
  await active.service.cancel()
  assert.equal(active.manager.cancelInstall.calls.length, 1)
})

test('取消 25：cancelled / too-late / not-running 三种结果都不谎报', async () => {
  const run = async (cancelStatus, application) => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const harness = createHarness({
      managerOptions: {
        installBundle: spy(async () => {
          await gate
          return application === undefined ? changeResult() : changeResult({ application })
        }),
        cancelInstall: spy(async () => ({ status: cancelStatus })),
      },
    })
    const installing = harness.service.install()
    await waitFor(() => harness.manager.installBundle.calls.length === 1, '安装已下发')
    const cancelling = harness.service.cancel()
    release()
    const settled = await installing
    const after = await cancelling
    await tick(8)
    return { harness, settled, after, final: harness.service.status() }
  }

  // Manager 确认取消（文件已恢复）→ 最终状态必须是 cancelled。
  const confirmed = await run('cancelled', 'cancelled')
  assert.equal(confirmed.settled.status, 'cancelled')
  assert.equal(confirmed.after.status, 'cancelled')
  assert.equal(confirmed.final.status, 'cancelled')

  // too-late：不能谎报取消成功，真实结果说了算（取消返回的不是 cancelled，最终状态是安装的真实结论）。
  const late = await run('too-late', 'restart-required')
  assert.equal(late.settled.status, 'awaiting-restart')
  assert.notEqual(late.after.status, 'cancelled')
  assert.equal(late.final.status, 'awaiting-restart')

  // not-running：不猜成功也不猜已取消，由安装结果决定。
  const notRunning = await run('not-running', 'failed')
  assert.notEqual(notRunning.after.status, 'cancelled')
  assert.equal(notRunning.final.status, 'failed')

  // 进度阶段在 too-late 时退回安装自己的阶段，而不是停在"正在取消"。
  let releaseCancel
  const cancelGate = new Promise((resolve) => {
    releaseCancel = resolve
  })
  let releaseInstall
  const installGate = new Promise((resolve) => {
    releaseInstall = resolve
  })
  const stage = createHarness({
    managerOptions: {
      installBundle: spy(async () => {
        await installGate
        return changeResult()
      }),
      cancelInstall: spy(async () => {
        await cancelGate
        return { status: 'too-late' }
      }),
    },
  })
  const installing = stage.service.install()
  await waitFor(() => stage.manager.installBundle.calls.length === 1, '安装已下发')
  stage.service.acceptProgress({ requestId: 'req-1', phase: 'applying' })
  const cancelling = stage.service.cancel()
  assert.equal(stage.service.status().stage, 'cancelling')
  releaseCancel()
  await cancelling
  assert.equal(stage.service.status().stage, 'installing', 'too-late 后退回真实阶段')
  releaseInstall()
  await installing
})

test('取消 26：取消与安装 settlement 的竞态不会产生两个最终状态', async () => {
  // 安装先成功落定，取消随后才返回 too-late：状态必须保持安装的真实结论。
  let releaseCancel
  const cancelGate = new Promise((resolve) => {
    releaseCancel = resolve
  })
  let releaseInstall
  const installGate = new Promise((resolve) => {
    releaseInstall = resolve
  })
  const harness = createHarness({
    managerOptions: {
      installBundle: spy(async () => {
        await installGate
        return changeResult({ application: 'restart-required' })
      }),
      cancelInstall: spy(async () => {
        await cancelGate
        return { status: 'too-late' }
      }),
    },
  })

  const installing = harness.service.install()
  await waitFor(() => harness.manager.installBundle.calls.length === 1, '安装已下发')
  const cancelling = harness.service.cancel()
  releaseInstall()
  await installing
  assert.equal(harness.service.status().status, 'awaiting-restart')

  releaseCancel()
  const after = await cancelling
  assert.equal(after.status, 'awaiting-restart', '迟到的 too-late 不得覆盖最终状态')
  assert.equal(harness.service.status().status, 'awaiting-restart')

  // 反向：Manager 确认取消、安装结果却自相矛盾地报 failed → 最终仍是 cancelled。
  let releaseCancel2
  const cancelGate2 = new Promise((resolve) => {
    releaseCancel2 = resolve
  })
  let releaseInstall2
  const installGate2 = new Promise((resolve) => {
    releaseInstall2 = resolve
  })
  const contradictory = createHarness({
    managerOptions: {
      installBundle: spy(async () => {
        await installGate2
        return changeResult({
          application: 'failed',
          packageResult: { exitCode: 1, output: '', truncated: false, logPath: '/l', kind: 'network' },
        })
      }),
      cancelInstall: spy(async () => {
        await cancelGate2
        return { status: 'cancelled' }
      }),
    },
  })
  const installing2 = contradictory.service.install()
  await waitFor(() => contradictory.manager.installBundle.calls.length === 1, '第二次安装已下发')
  const cancelling2 = contradictory.service.cancel()
  releaseCancel2()
  releaseInstall2()
  await installing2
  const final = await cancelling2

  assert.equal(final.status, 'cancelled', 'Manager 确认取消后最终状态必须是 cancelled')
  assert.equal(contradictory.service.status().status, 'cancelled')
  assert.equal(contradictory.store.writes.some((record) => record.phase === 'awaiting-restart'), false)
})

// ---------------------------------------------------------------------------
// 四、恢复（需求 27–35）
// ---------------------------------------------------------------------------

test('恢复 27/30：当前运行版本已到/高于 target → updated 并清除标记', async () => {
  for (const [phase, version] of [
    ['installing', '0.0.12'],
    ['installing', '0.0.13'],
    ['awaiting-restart', '0.0.12'],
    ['awaiting-restart', '0.0.13'],
  ]) {
    const record =
      phase === 'installing'
        ? { phase, fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW }
        : { phase, fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW, installedAt: NOW }
    const harness = createHarness({ version, record })
    const state = await harness.service.recover()

    assert.deepEqual(state, { status: 'updated', version }, `${phase} @ ${version}`)
    assert.equal(harness.store.clears, 1, '标记必须被清除')
    assert.equal(harness.store.record, undefined)
    assert.equal(harness.manager.installBundle.calls.length, 0)
    assert.equal(harness.manager.listBundles.calls.length, 0, '运行版本已到目标时不必读磁盘')
  }
})

test('恢复 28：installing + 磁盘已是 target → 改写为 awaiting-restart', async () => {
  const clock = makeClock()
  const harness = createHarness({
    clock,
    record: { phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW },
    managerOptions: { diskVersion: '0.0.12' },
  })
  const state = await harness.service.recover()

  assert.deepEqual(state, { status: 'awaiting-restart', targetVersion: '0.0.12', installedAt: clock.now().toISOString() })
  assert.deepEqual(harness.store.record, {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: clock.now().toISOString(),
  })
  assert.equal(harness.manager.installBundle.calls.length, 0, '恢复绝不自动重装')
})

test('恢复 29/33：installing + 磁盘仍旧/缺失/不可确认 → failed，不自动重装', async () => {
  const cases = [
    ['磁盘仍旧', { diskVersion: '0.0.11' }],
    ['磁盘更低', { diskVersion: '0.0.10' }],
    ['磁盘没有这个包', { listBundles: spy(async () => []) }],
    ['磁盘版本不可解析', { listBundles: spy(async () => [bundleInfo(UPDATE_PACKAGE_NAME, 'nope')]) }],
    [
      'listBundles 抛错',
      {
        listBundles: spy(async () => {
          throw new Error(`boom ${SECRET_TEXT}`)
        }),
      },
    ],
  ]
  for (const [label, managerOptions] of cases) {
    const harness = createHarness({
      record: { phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW },
      managerOptions,
    })
    const state = await harness.service.recover()
    assert.deepEqual(state, { status: 'failed', kind: 'unknown' }, label)
    assert.equal(harness.store.clears, 1, `${label}：无效的 installing 标记要被清掉`)
    assert.equal(harness.manager.installBundle.calls.length, 0, `${label}：绝不自动重装`)
    assertClean(state, label)
  }
})

test('恢复 31：awaiting-restart + Host 仍旧但磁盘已是 target/更高 → 继续等待重启', async () => {
  const record = {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  }
  for (const diskVersion of ['0.0.12', '0.0.13']) {
    const harness = createHarness({ record, managerOptions: { diskVersion } })
    const state = await harness.service.recover()
    assert.deepEqual(state, { status: 'awaiting-restart', targetVersion: '0.0.12', installedAt: NOW }, diskVersion)
    assert.equal(harness.store.writes.length, 0, '保持等待重启：不重写、不刷新有效期')
    assert.equal(harness.store.clears, 0)
    assert.equal(harness.manager.installBundle.calls.length, 0)
  }
})

test('恢复 32：awaiting-restart + 磁盘旧/缺失/矛盾 → failed，不自动安装', async () => {
  const record = {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  }
  for (const managerOptions of [
    { diskVersion: '0.0.11' },
    { listBundles: spy(async () => []) },
    {
      listBundles: spy(async () => {
        throw new Error(`boom ${SECRET_TEXT}`)
      }),
    },
  ]) {
    const harness = createHarness({ record, managerOptions })
    const state = await harness.service.recover()
    assert.deepEqual(state, { status: 'failed', kind: 'unknown' })
    assert.equal(harness.manager.installBundle.calls.length, 0, '绝不自动安装')
  }
})

test('恢复 34：malformed 持久化 → idle，绝不下发安装', async () => {
  const fs = memoryFs({
    [CONFIG_PATH]: JSON.stringify({ workspacePath: '/cases/a', pluginUpdate: { phase: 'installed', nonsense: true } }),
  })
  const harness = createHarness({ store: pluginUpdateStoreOf(fs.ctx, '/Users/x') })
  const state = await harness.service.recover()

  assert.deepEqual(state, { status: 'idle' })
  assert.equal(harness.manager.installBundle.calls.length, 0)
  assert.equal(harness.manager.listBundles.calls.length, 0)
  assert.deepEqual(readConfigFile(fs).workspacePath, '/cases/a', '坏记录不写盘，更不覆盖兄弟字段')

  // 读盘抛错、没有记录，都同样安全忽略。
  const throwing = createHarness({ storeOptions: { readThrows: true } })
  assert.deepEqual(await throwing.service.recover(), { status: 'idle' })
  assert.equal(throwing.manager.installBundle.calls.length, 0)

  const empty = createHarness()
  assert.deepEqual(await empty.service.recover(), { status: 'idle' })
})

test('恢复 35：updated 是本进程的一次结论，磁盘标记已清除', async () => {
  const harness = createHarness({
    version: '0.0.12',
    record: {
      phase: 'awaiting-restart',
      fromVersion: '0.0.11',
      targetVersion: '0.0.12',
      startedAt: NOW,
      installedAt: NOW,
    },
  })
  assert.deepEqual(await harness.service.recover(), { status: 'updated', version: '0.0.12' })
  assert.equal(harness.store.record, undefined, '磁盘标记必须已经清除')

  // 再恢复一次：没有记录就不再触发（也不重复清除、不重复安装）。
  assert.deepEqual(await harness.service.recover(), { status: 'updated', version: '0.0.12' })
  assert.equal(harness.store.clears, 1)
  assert.equal(harness.manager.installBundle.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 五、适配层纯函数（供 service 与 Task 4 复用）
// ---------------------------------------------------------------------------

test('适配：readDiskVersion 只认固定包，且不猜版本', async () => {
  assert.deepEqual(await readDiskVersion(fakeManager({ diskVersion: '0.0.12' })), { kind: 'installed', version: '0.0.12' })
  assert.deepEqual(await readDiskVersion(fakeManager({ listBundles: spy(async () => []) })), { kind: 'absent' })
  assert.deepEqual(
    await readDiskVersion(fakeManager({ listBundles: spy(async () => [bundleInfo('other-plugin', '0.0.12')]) })),
    { kind: 'absent' },
  )
  assert.deepEqual(
    await readDiskVersion(fakeManager({ listBundles: spy(async () => [bundleInfo(UPDATE_PACKAGE_NAME, undefined)]) })),
    { kind: 'unknown' },
  )
  assert.deepEqual(
    await readDiskVersion(
      fakeManager({
        listBundles: spy(async () => {
          throw new Error('boom')
        }),
      }),
    ),
    { kind: 'unknown' },
  )
})

test('适配：installThroughManager 固定 spec/options，并把抛错收敛成 unknown', async () => {
  const ok = fakeManager()
  assert.deepEqual(await installThroughManager(ok, '0.0.12', 'req-9'), { kind: 'ok', application: 'restart-required' })
  assert.deepEqual(ok.installBundle.calls, [[`${UPDATE_PACKAGE_NAME}@0.0.12`, { enabled: true, requestId: 'req-9', registry: NPMMIRROR }]])

  const thrown = fakeManager({
    installBundle: spy(async () => {
      throw new Error(`boom ${SECRET_TEXT}`)
    }),
  })
  assert.deepEqual(await installThroughManager(thrown, '0.0.12', 'req-9'), { kind: 'unknown' })
  assert.deepEqual(thrown.waitForInstall.calls, [['req-9']])
  assertClean(await installThroughManager(thrown, '0.0.12', 'req-9'), '适配结论')
})

test('适配：createPluginUpdateStore 的读/写/清除都返回稳定结果', async () => {
  const written = []
  const store = createPluginUpdateStore({
    readConfig: async () => ({ ok: true, value: { pluginUpdate: { phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW } } }),
    writeConfig: async (patch) => {
      written.push(patch)
      return true
    },
  })
  assert.deepEqual(await store.read(), { phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW })
  assert.equal(await store.write({ phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW }), true)
  assert.equal(await store.clear(), true)
  assert.deepEqual(written, [
    { pluginUpdate: { phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW } },
    { pluginUpdate: undefined },
  ])

  // 读失败 / 写抛错都不抛给调用方（service 据此 fail closed）。
  const broken = createPluginUpdateStore({
    readConfig: async () => ({ ok: false, value: {} }),
    writeConfig: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(await broken.read(), undefined)
  assert.equal(await broken.write({ phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12', startedAt: NOW }), false)
  assert.equal(await broken.clear(), false)
})

// ---------------------------------------------------------------------------
// 六、清理可靠性与一次性恢复（修正轮）
// ---------------------------------------------------------------------------

test('恢复 36：清除失败不产生 updated，记录仍在，下次 recover 会重试', async () => {
  const record = {
    phase: 'awaiting-restart',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
    installedAt: NOW,
  }
  const harness = createHarness({ version: '0.0.12', record, storeOptions: { clearOk: false } })

  const first = await harness.service.recover()
  assert.deepEqual(first, { status: 'failed', kind: 'unknown' }, '清不掉标记就不能声称更新成功')
  assert.notEqual(first.status, 'updated')
  assertClean(first, '清除失败状态')
  assert.deepEqual(harness.store.record, record, '标记必须还在磁盘上')
  assert.equal(harness.store.clears, 1)

  // 第二次：文件现在可写了 → 才允许 updated，并且记录真的消失。
  harness.store.options.clearOk = true
  const second = await harness.service.recover()
  assert.deepEqual(second, { status: 'updated', version: '0.0.12' })
  assert.equal(harness.store.record, undefined)
  assert.equal(harness.store.clears, 2)

  // 第三次：标记已消失 → 不再清除、不再触发新的恢复动作（status 继续供 UI 消费）。
  const third = await harness.service.recover()
  assert.deepEqual(third, { status: 'updated', version: '0.0.12' })
  assert.equal(harness.store.clears, 2, '不得再次清除')
  assert.equal(harness.manager.installBundle.calls.length, 0)
  assert.equal(harness.manager.listBundles.calls.length, 0)
})

test('恢复 37：清除抛异常与返回 false 同样处理，异常原文不进状态', async () => {
  const record = {
    phase: 'installing',
    fromVersion: '0.0.11',
    targetVersion: '0.0.12',
    startedAt: NOW,
  }
  const harness = createHarness({ version: '0.0.12', record, storeOptions: { clearThrows: true } })

  const state = await harness.service.recover()
  assert.deepEqual(state, { status: 'failed', kind: 'unknown' })
  assert.notEqual(state.status, 'updated')
  assertClean(state, '清除抛错状态')
  assert.deepEqual(harness.store.record, record, '抛错时记录也还在')
  assert.equal(harness.store.clears, 1)
})

test('安装 38：明确 failed 结果清除 installing 标记，并保留稳定失败分类', async () => {
  const failing = () =>
    changeResult({
      application: 'failed',
      packageResult: { exitCode: 1, output: 'x', truncated: false, logPath: '/l', kind: 'permission' },
    })

  const harness = createHarness({ managerOptions: { installBundle: spy(async () => failing()) } })
  const state = await harness.service.install()
  assert.deepEqual(state, { status: 'failed', kind: 'permission', targetVersion: '0.0.12' }, '分类不被清理动作改变')
  assert.equal(harness.store.clears, 1, '已知失败要清掉 installing 标记')
  assert.equal(harness.store.record, undefined)
  assert.equal(harness.store.writes.some((entry) => entry.phase === 'awaiting-restart'), false)

  // 清除失败也不能把失败谎报成成功；记录留下由下次恢复处理。
  const stubborn = createHarness({
    managerOptions: { installBundle: spy(async () => failing()) },
    storeOptions: { clearOk: false },
  })
  const stubbornState = await stubborn.service.install()
  assert.deepEqual(stubbornState, { status: 'failed', kind: 'permission', targetVersion: '0.0.12' })
  assert.equal(stubborn.store.record.phase, 'installing')
})

test('安装 39：明确 cancelled 结果清除 installing 标记，最终仍是 cancelled', async () => {
  const cancelled = () => changeResult({ application: 'cancelled' })

  const harness = createHarness({ managerOptions: { installBundle: spy(async () => cancelled()) } })
  const state = await harness.service.install()
  assert.deepEqual(state, { status: 'cancelled', targetVersion: '0.0.12' })
  assert.equal(harness.store.clears, 1, '已知取消要清掉 installing 标记')
  assert.equal(harness.store.record, undefined)
  assert.equal(harness.store.writes.some((entry) => entry.phase === 'awaiting-restart'), false)

  const stubborn = createHarness({
    managerOptions: { installBundle: spy(async () => cancelled()) },
    storeOptions: { clearOk: false },
  })
  assert.equal((await stubborn.service.install()).status, 'cancelled', '清不掉也还是取消')
  assert.equal(stubborn.store.record.phase, 'installing')
})

test('安装 40：unknown 结果保留 installing 记录，供启动恢复确认磁盘事实', async () => {
  const harness = createHarness({
    managerOptions: {
      installBundle: spy(async () => {
        throw new Error(`lost ${SECRET_TEXT}`)
      }),
      waitForInstall: spy(async () => null),
    },
  })
  const state = await harness.service.install()
  assert.deepEqual(state, { status: 'failed', kind: 'unknown', targetVersion: '0.0.12' })
  assert.equal(harness.store.clears, 0, '结果不确定就不清除')
  assert.equal(harness.store.record.phase, 'installing')
  assert.equal(harness.store.record.targetVersion, '0.0.12')

  // 记录确实还有用：磁盘已经是 target → 恢复时自愈成"等待重启"。
  const recovered = await harness.service.recover()
  assert.deepEqual(recovered, {
    status: 'awaiting-restart',
    targetVersion: '0.0.12',
    installedAt: harness.clock.now().toISOString(),
  })
})

test('安装 41：声称成功但磁盘对不上时保留 installing 记录，且不写 awaiting-restart', async () => {
  const harness = createHarness({ managerOptions: { diskVersion: '0.0.11' } })
  const state = await harness.service.install()

  assert.deepEqual(state, { status: 'failed', kind: 'unknown', targetVersion: '0.0.12' })
  assert.equal(harness.store.clears, 0, '不确定的记录要留给启动恢复')
  assert.equal(harness.store.record.phase, 'installing')
  assert.equal(harness.store.writes.some((entry) => entry.phase === 'awaiting-restart'), false)
})

test('持久化 42：时间字段只接受带时区的 ISO 8601 date-time', () => {
  const base = { phase: 'installing', fromVersion: '0.0.11', targetVersion: '0.0.12' }

  const accepted = [
    ['毫秒 + Z', '2026-09-28T10:00:00.000Z', '2026-09-28T10:00:00.000Z'],
    ['显式 offset', '2026-09-28T18:00:00+08:00', '2026-09-28T10:00:00.000Z'],
    ['负 offset', '2026-09-28T05:00:00-05:00', '2026-09-28T10:00:00.000Z'],
    ['无秒但带时区', '2026-09-28T10:00Z', '2026-09-28T10:00:00.000Z'],
    ['无冒号的 offset', '2026-09-28T18:00:00+0800', '2026-09-28T10:00:00.000Z'],
    ['亚毫秒精度', '2026-09-28T10:00:00.123456Z', '2026-09-28T10:00:00.123Z'],
  ]
  for (const [label, value, expected] of accepted) {
    const parsed = parsePluginUpdate({ pluginUpdate: { ...base, startedAt: value } })
    assert.equal(parsed?.startedAt, expected, label)
  }

  const rejected = [
    ['自然语言', 'September 28 2026'],
    ['只有日期', '2026-09-28'],
    ['无时区', '2026-09-28T10:00:00'],
    ['纯数字', '0'],
    ['空串', ''],
    ['只有时间', '10:00:00Z'],
    ['本地习惯格式', '09/28/2026 10:00:00Z'],
    ['超范围月份', '2026-13-01T10:00:00Z'],
    ['不存在的日期（2026-02-31）', '2026-02-31T10:00:00Z'],
    ['超范围小时', '2026-09-28T25:00:00Z'],
    ['紧凑格式（无分隔符）', '20260928T100000Z'],
    ['非字符串（epoch 毫秒）', 1759053600000],
    ['数组', [NOW]],
  ]
  for (const [label, value] of rejected) {
    assert.equal(parsePluginUpdate({ pluginUpdate: { ...base, startedAt: value } }), undefined, label)
  }

  // awaiting-restart 的 installedAt 走同一条判据（带上 startedAt，否则测的是另一条判据）。
  const awaiting = { ...base, startedAt: NOW, phase: 'awaiting-restart' }
  assert.equal(
    parsePluginUpdate({ pluginUpdate: { ...awaiting, installedAt: '2026-09-28' } }),
    undefined,
    'installedAt 也必须带时区',
  )
  assert.equal(parsePluginUpdate({ pluginUpdate: { ...awaiting, installedAt: 'September 28 2026' } }), undefined)
  assert.deepEqual(
    parsePluginUpdate({ pluginUpdate: { ...awaiting, installedAt: '2026-09-28T18:00:00+08:00' } }),
    { ...awaiting, installedAt: '2026-09-28T10:00:00.000Z' },
    '合法 offset 统一规范成 UTC',
  )
})
