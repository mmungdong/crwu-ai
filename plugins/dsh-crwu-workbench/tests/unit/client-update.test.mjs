/**
 * Client 更新状态（门面收窄 / 实例级 Store / 纯 View Model）的单元测试。
 *
 * 三件事必须有能独立失败的测试：
 * 1. **运行时收窄**：Host 返回的是不可信 JSON，进 Store 之前逐字段重建安全对象，
 *    未知枚举、类型不符、恶意额外字段一律不接受，且不覆盖最后一次有效状态；
 * 2. **并发模型**：初始化单飞、手动检查单飞、安装单飞、取消不被安装锁挡住、
 *    安装期间的状态轮询不重叠且能停；晚到的旧响应不能把终态倒退；
 * 3. **渲染判据**：View Model 是纯函数（时间靠参数传入），优先级与禁用原因固定。
 *
 * 全部依赖注入（API / scheduler / 时钟），**不访问公网、不打真实 Host、不真实等待**。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { createUpdateStore } = await import(new URL('src/client/features/update/update-store.ts', ROOT).href)
const { createUpdateApi, updateApi, parseUpdateResponse, UPDATE_METHOD_OPERATION } = await import(
  new URL('src/client/features/update/api.ts', ROOT).href
)
const { updateViewModelOf } = await import(new URL('src/client/features/update/view-model.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { UPDATE_OPERATION_NAMES } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { UPDATE_SUCCESS_TTL_MS } = await import(new URL('src/shared/update/consts.ts', ROOT).href)

const NOW = '2026-09-28T10:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const NPMMIRROR = 'https://registry.npmmirror.com/'
const PRIVATE = 'https://npm.corp.example.com/'
const SECRET_TEXT = 'https://user:pass@npm.corp.example.com/ token=SECRET'

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

const tick = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 可注入 scheduler：测试自己决定什么时候"到点"，不做真实等待。 */
function fakeScheduler() {
  const tasks = []
  return {
    tasks,
    schedule(callback, delayMs) {
      const task = { callback, delayMs, cancelled: false, done: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    /** 跑下一个还挂着的任务（模拟一个轮询周期到点）。 */
    async runNext() {
      const task = tasks.find((item) => !item.cancelled && !item.done)
      if (task === undefined) return false
      task.done = true
      task.callback()
      await tick(10)
      return true
    },
    pending: () => tasks.filter((item) => !item.cancelled && !item.done).length,
  }
}

/** 记录调用的更新 API 替身；每个方法可以给固定值、deferred 或函数。 */
function fakeUpdateApi(script = {}) {
  const calls = []
  const next = async (name) => {
    calls.push(name)
    const handler = script[name]
    if (typeof handler === 'function') return await handler()
    if (handler !== undefined) return handler
    return okEnvelope()
  }
  return {
    calls,
    countOf: (name) => calls.filter((call) => call === name).length,
    updateStatus: () => next(UPDATE_OPERATION_NAMES[0]),
    updateCheck: () => next(UPDATE_OPERATION_NAMES[1]),
    updateInstall: () => next(UPDATE_OPERATION_NAMES[2]),
    updateCancel: () => next(UPDATE_OPERATION_NAMES[3]),
  }
}

const candidate = (patch = {}) => ({
  currentVersion: '0.0.11',
  targetVersion: '0.0.12',
  sourceKind: 'npmmirror',
  checkedAt: NOW,
  expiresAt: new Date(NOW_MS + UPDATE_SUCCESS_TTL_MS).toISOString(),
  ...patch,
})

const checkIdle = { status: 'idle' }
const checkChecking = (patch = {}) => ({ status: 'checking', ...patch })
const checkUpToDate = { status: 'up-to-date', checkedAt: NOW }
const checkAvailable = (patch = {}) => ({ status: 'available', checkedAt: NOW, candidate: candidate(), ...patch })
const checkUnsupported = (reason) => ({ status: 'unsupported', reason })
const checkError = (kind = 'timeout') => ({ status: 'error', kind, checkedAt: NOW })
const installIdle = { status: 'idle' }
const installInstalling = (patch = {}) => ({
  status: 'installing',
  stage: 'connecting',
  targetVersion: '0.0.12',
  startedAt: NOW,
  ...patch,
})
const installAwaiting = (patch = {}) => ({ status: 'awaiting-restart', targetVersion: '0.0.12', installedAt: NOW, ...patch })
const okEnvelope = (patch = {}) => ({ ok: true, check: checkIdle, install: installIdle, ...patch })

function storeFor(patch = {}) {
  const api = patch.api ?? fakeUpdateApi(patch.script)
  const scheduler = patch.scheduler ?? fakeScheduler()
  const store = createUpdateStore({
    api,
    scheduler,
    pollIntervalMs: patch.pollIntervalMs ?? 2000,
  })
  return { store, api, scheduler }
}

/** View Model 的默认输入（测试只覆盖关心的字段）。 */
function vm(snapshot, patch = {}) {
  return updateViewModelOf({
    snapshot,
    currentVersion: '0.0.11',
    auditBusy: false,
    nowMs: NOW_MS,
    ...patch,
  })
}

const snapshotOf = (patch = {}) => ({
  initialized: true,
  check: null,
  install: null,
  checkOrigin: null,
  checking: false,
  installing: false,
  cancelling: false,
  error: null,
  ...patch,
})

// ---------------------------------------------------------------------------
// 一、运行时收窄
// ---------------------------------------------------------------------------

test('1. 合法 payload 被逐字段收窄，未知字段一律丢弃', () => {
  const parsed = parseUpdateResponse({
    ok: true,
    check: {
      status: 'available',
      checkedAt: NOW,
      candidate: {
        ...candidate(),
        // 恶意/未知字段：都不许活下来
        registryUrl: PRIVATE,
        token: 'SECRET',
        distTags: { latest: '0.0.12' },
      },
      extra: 'junk',
    },
    install: { status: 'installing', stage: 'downloading', targetVersion: '0.0.12', startedAt: NOW, requestId: 'req-1' },
    registry: PRIVATE,
  })

  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.invalid.length, 0)
  assert.deepEqual(parsed.check, {
    status: 'available',
    checkedAt: NOW,
    candidate: {
      currentVersion: '0.0.11',
      targetVersion: '0.0.12',
      sourceKind: 'npmmirror',
      checkedAt: NOW,
      expiresAt: new Date(NOW_MS + UPDATE_SUCCESS_TTL_MS).toISOString(),
    },
  })
  assert.deepEqual(parsed.install, {
    status: 'installing',
    stage: 'downloading',
    targetVersion: '0.0.12',
    startedAt: NOW,
  })
  assert.deepEqual(Object.keys(parsed.check.candidate).sort(), [
    'checkedAt',
    'currentVersion',
    'expiresAt',
    'sourceKind',
    'targetVersion',
  ])
  const serialized = JSON.stringify(parsed)
  for (const forbidden of [PRIVATE, 'SECRET', 'req-1', 'distTags', 'registryUrl', 'extra']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
})

test('2. 未知状态 / 未知枚举 / 字段错误 / 数组 / null / 恶意额外字段都被拒绝', () => {
  const cases = [
    ['信封不是对象', 'nope'],
    ['信封是数组', []],
    ['信封是 null', null],
    ['ok 不是布尔', { ok: 'true', check: checkIdle, install: installIdle }],
    ['ok:true 缺 check', { ok: true, install: installIdle }],
    ['ok:true 缺 install', { ok: true, check: checkIdle }],
    ['check 是数组', { ok: true, check: [], install: installIdle }],
    ['check 状态未知', { ok: true, check: { status: 'weird' }, install: installIdle }],
    ['check available 缺 candidate', { ok: true, check: { status: 'available', checkedAt: NOW }, install: installIdle }],
    ['check up-to-date 缺 checkedAt', { ok: true, check: { status: 'up-to-date' }, install: installIdle }],
    ['check unsupported 原因未知', { ok: true, check: { status: 'unsupported', reason: 'whatever' }, install: installIdle }],
    ['check error 种类未知', { ok: true, check: { status: 'error', kind: 'exploded', checkedAt: NOW }, install: installIdle }],
    ['check checking 的 cached 不认识', { ok: true, check: { status: 'checking', cached: { targetVersion: 'x' } }, install: installIdle }],
    ['candidate 缺 targetVersion', { ok: true, check: { status: 'available', checkedAt: NOW, candidate: { currentVersion: '0.0.11', sourceKind: 'npmmirror', checkedAt: NOW, expiresAt: NOW } }, install: installIdle }],
    ['candidate sourceKind 未知', { ok: true, check: { status: 'available', checkedAt: NOW, candidate: candidate({ sourceKind: 'evil' }) }, install: installIdle }],
    ['candidate publishedAt 类型不对', { ok: true, check: { status: 'available', checkedAt: NOW, candidate: candidate({ publishedAt: 17 }) }, install: installIdle }],
    ['install 状态未知', { ok: true, check: checkIdle, install: { status: 'rebooting' } }],
    ['install stage 未知', { ok: true, check: checkIdle, install: installInstalling({ stage: 'rebooting' }) }],
    ['install installing 缺 startedAt', { ok: true, check: checkIdle, install: { status: 'installing', stage: 'connecting', targetVersion: '0.0.12' } }],
    ['install awaiting-restart 缺 installedAt', { ok: true, check: checkIdle, install: { status: 'awaiting-restart', targetVersion: '0.0.12' } }],
    ['install failed 种类未知', { ok: true, check: checkIdle, install: { status: 'failed', kind: 'exploded' } }],
    ['install updated 缺 version', { ok: true, check: checkIdle, install: { status: 'updated' } }],
    ['install 是数组', { ok: true, check: checkIdle, install: [] }],
    ['install 是 null', { ok: true, check: checkIdle, install: null }],
  ]

  for (const [label, raw] of cases) {
    const parsed = parseUpdateResponse(raw)
    assert.notEqual(parsed.kind, undefined, label)
    // 要么整个信封不认识，要么明确标出哪一半不认识（两者都不接受该字段）。
    if (parsed.kind === 'ok') {
      assert.ok(parsed.invalid.length > 0 || parsed.check === null || parsed.install === null, label)
      if (String(label).startsWith('check') || String(label).startsWith('candidate')) {
        assert.equal(parsed.check, null, `${label}：不认识的 check 不能进状态`)
      }
      if (String(label).startsWith('install')) {
        assert.equal(parsed.install, null, `${label}：不认识的 install 不能进状态`)
      }
    } else {
      assert.equal(parsed.kind, 'malformed', label)
    }
  }

  // ok:false 只在 error 是字符串时算"边界拒绝"；文本绝不外泄。
  assert.deepEqual(parseUpdateResponse({ ok: false, error: SECRET_TEXT }), { kind: 'rejected' })
  assert.equal(parseUpdateResponse({ ok: false }).kind, 'malformed')
  assert.equal(parseUpdateResponse({ ok: false, error: 17 }).kind, 'malformed')
})

test('3. registry URL / Token / 日志 / requestId / Host error 都不进 Store 快照', async () => {
  const { store } = storeFor({
    script: {
      [UPDATE_OPERATION_NAMES[0]]: {
        ok: true,
        check: {
          status: 'available',
          checkedAt: NOW,
          candidate: { ...candidate(), registry: PRIVATE, log: 'pnpm ERR!', requestId: 'req-1' },
        },
        install: { status: 'idle', output: `pnpm ERR! ${SECRET_TEXT}`, requestId: 'req-1' },
        error: SECRET_TEXT,
        registries: [PRIVATE],
      },
    },
  })
  await store.initialize()

  const serialized = JSON.stringify(store.get())
  for (const forbidden of [PRIVATE, 'npm.corp.example.com', 'user:pass', 'SECRET', 'token=', 'pnpm ERR', 'req-1', 'Error:']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }

  // Host 的拒绝信封文本也不进快照：只保留本地稳定 code。
  const rejected = storeFor({
    script: { [UPDATE_OPERATION_NAMES[1]]: { ok: false, error: SECRET_TEXT } },
  })
  await rejected.store.check()
  assert.deepEqual(rejected.store.get().error, { action: 'check', origin: 'manual', code: 'rejected' })
  assert.equal(JSON.stringify(rejected.store.get()).includes(SECRET_TEXT), false)
})

// ---------------------------------------------------------------------------
// 二、Store：初始化 / 单飞 / 并发
// ---------------------------------------------------------------------------

test('4/5. 两个消费者并发 initialize 只发一条链；完成后再次调用不重复请求', async () => {
  const gate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[0]]: async () => {
      await gate.promise
      return okEnvelope({ check: checkAvailable() })
    },
  })
  const { store } = storeFor({ api })

  const first = store.initialize()
  const second = store.initialize()
  await tick(4)
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[0]), 1, '并发只发一次 update-status')

  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(store.get().initialized, true)
  assert.equal(store.get().check.status, 'available')
  // status 已经给了终局结论（available）→ 不再接续 update-check。
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[1]), 0)

  await store.initialize()
  await store.initialize()
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[0]), 1, '初始化完成后不再重复请求')
})

test('5b. 初始化时若状态仍是 idle/checking，接续一次后台检查', async () => {
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope({ check: checkIdle }),
    [UPDATE_OPERATION_NAMES[1]]: okEnvelope({ check: checkAvailable() }),
  })
  const { store } = storeFor({ api })
  await store.initialize()

  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[1]), 1, 'idle 时要接续一次检查')
  assert.equal(store.get().check.status, 'available')
  assert.equal(store.get().checkOrigin, 'background', '这条路径属于后台/自动')
})

test('6. 自动初始化失败保留上次有效状态，并标记为 background', async () => {
  // 已有有效状态：先成功一次，再让同一个 store 的刷新失败。
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope({ check: checkAvailable(), install: installAwaiting() }),
  })
  const { store } = storeFor({ api })
  await store.initialize()
  const good = store.get()
  assert.equal(good.check.status, 'available')

  api.updateStatus = () => {
    throw new Error(`network down ${SECRET_TEXT}`)
  }
  await store.refreshStatus()

  assert.deepEqual(store.get().error, { action: 'status', origin: 'background', code: 'transport' })
  assert.deepEqual(store.get().check, good.check, '失败不清空最后一次有效 check')
  assert.deepEqual(store.get().install, good.install, '失败不清空等待重启状态')
  assert.equal(JSON.stringify(store.get()).includes(SECRET_TEXT), false, '异常原文不进状态')

  // 从来没有有效状态时（status 与接续的 check 都失败）：check 保持 null（不伪造结论），
  // 错误仍然是 background —— 后台失败不该弹给用户。
  const broken = () => {
    throw new Error('boom')
  }
  const fresh = storeFor({
    script: {
      [UPDATE_OPERATION_NAMES[0]]: broken,
      [UPDATE_OPERATION_NAMES[1]]: broken,
    },
  })
  await fresh.store.initialize()
  assert.equal(fresh.store.get().check, null)
  assert.deepEqual(fresh.store.get().error, { action: 'check', origin: 'background', code: 'transport' })
})

test('7. 手动 check 单飞，错误标记为 manual，成功后清除旧的手动错误', async () => {
  const gate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[1]]: async () => {
      await gate.promise
      return okEnvelope({ check: checkAvailable() })
    },
  })
  const { store } = storeFor({ api })

  const first = store.check()
  const second = store.check()
  await tick(4)
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[1]), 1, '并发点击共享同一次检查')
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(store.get().checkOrigin, 'manual')

  // 手动检查失败：manual + 稳定 code，且保留上一次有效 check。
  const failing = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[1]]: () => {
      throw new Error('boom')
    },
  })
  const { store: failingStore } = storeFor({ api: failing })
  await failingStore.check()
  assert.deepEqual(failingStore.get().error, { action: 'check', origin: 'manual', code: 'transport' })
  assert.equal(failingStore.get().checking, false, '失败也要退出检查中')

  // 成功后清掉手动错误
  failing.updateCheck = async () => okEnvelope({ check: checkAvailable() })
  failing.calls.length = 0
  await failingStore.check()
  assert.equal(failingStore.get().error, null, '成功的手动检查要清掉旧的手动错误')
})

test('8. install 双击只发一次 update-install，且永远发空参数', async () => {
  const gate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await gate.promise
      return okEnvelope({ check: checkAvailable(), install: installAwaiting() })
    },
  })
  const { store } = storeFor({ api })

  const first = store.install()
  const second = store.install()
  await tick(4)
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[2]), 1, '重复点击共享同一个安装 Promise')
  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(store.get().install.status, 'awaiting-restart', '以 Host 返回的真实快照为准')
  assert.equal(store.get().installing, false, '安装请求结束')
})

test('9/10. install 期间 cancel 立即可发（不受安装锁阻挡），cancel 双击只发一次', async () => {
  const installGate = deferred()
  const cancelGate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await installGate.promise
      return okEnvelope({ install: { status: 'cancelled', targetVersion: '0.0.12' } })
    },
    [UPDATE_OPERATION_NAMES[3]]: async () => {
      await cancelGate.promise
      return okEnvelope({ install: { status: 'cancelled', targetVersion: '0.0.12' } })
    },
  })
  const { store } = storeFor({ api })

  const installing = store.install()
  await tick(4)
  assert.equal(store.get().installing, true)

  // 安装请求还挂着：取消必须立刻能发出去（不被安装单飞锁挡住）。
  const cancelling = store.cancel()
  await tick(4)
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[3]), 1, '安装还没结束也必须能取消')
  assert.equal(store.get().cancelling, true)

  const cancellingAgain = store.cancel()
  await tick(4)
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[3]), 1, '重复取消共享同一个取消 Promise')

  cancelGate.resolve()
  installGate.resolve()
  await Promise.all([installing, cancelling, cancellingAgain])
  assert.equal(store.get().install.status, 'cancelled')
  assert.equal(store.get().cancelling, false, '取消请求结束')
})

// ---------------------------------------------------------------------------
// 三、Store：轮询与晚到响应
// ---------------------------------------------------------------------------

test('11. 安装期间状态轮询不重叠，终态与 dispose 后停止', async () => {
  const installGate = deferred()
  const statusGate = deferred()
  let statusCall = 0
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await installGate.promise
      return okEnvelope({ install: installAwaiting() })
    },
    [UPDATE_OPERATION_NAMES[0]]: async () => {
      statusCall += 1
      if (statusCall === 1) return okEnvelope({ check: checkAvailable() })
      await statusGate.promise
      return okEnvelope({ install: installInstalling({ stage: 'downloading' }) })
    },
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  await store.initialize()
  const installing = store.install()
  await tick(4)
  assert.equal(scheduler.pending(), 1, '安装期间安排了一次状态轮询')

  // 第一轮轮询挂住 → 再"到点"也不得有第二个并发 status 请求。
  await scheduler.runNext()
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[0]), 2)
  assert.equal(scheduler.pending(), 0, '上一个 status 还没回来时不再安排下一次')
  await scheduler.runNext()
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[0]), 2, '不重叠')

  statusGate.resolve()
  await tick(6)
  assert.equal(scheduler.pending(), 1, '上一轮回来后继续轮询')

  // 终态（awaiting-restart）→ 停止轮询。
  installGate.resolve()
  await installing
  await tick(6)
  assert.equal(store.get().install.status, 'awaiting-restart')
  assert.equal(scheduler.pending(), 0, '进入终态后停止轮询')

  // dispose 之后再安装一次：轮询不得启动。
  const disposeApi = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: installIdle,
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope(),
  })
  const disposeScheduler = fakeScheduler()
  const { store: disposable } = storeFor({ api: disposeApi, scheduler: disposeScheduler })
  disposable.dispose()
  await disposable.initialize()
  await disposable.install()
  assert.equal(disposeScheduler.tasks.length, 0, 'dispose 后不再安排轮询')
})

test('12. 晚到的旧 status 响应不能把终态倒退回 installing', async () => {
  const installGate = deferred()
  const lateStatus = deferred()
  let statusCall = 0
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await installGate.promise
      return okEnvelope({ install: installAwaiting() })
    },
    [UPDATE_OPERATION_NAMES[0]]: async () => {
      statusCall += 1
      if (statusCall === 1) return okEnvelope({ check: checkAvailable() })
      // 第二轮：先挂住，等安装落定成 awaiting-restart 之后再回来一个旧的 installing。
      await lateStatus.promise
      return okEnvelope({ install: installInstalling({ stage: 'downloading' }) })
    },
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  await store.initialize()
  const installing = store.install()
  await tick(4)
  await scheduler.runNext() // 发出挂住的那次 status
  installGate.resolve()
  await installing
  assert.equal(store.get().install.status, 'awaiting-restart')

  lateStatus.resolve()
  await tick(10)
  await scheduler.runNext()
  await tick(6)
  assert.equal(store.get().install.status, 'awaiting-restart', '晚到的旧响应不得把终态倒退')
})

test('13. transport/协议错误不清空 available 或 awaiting-restart', async () => {
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope({ check: checkAvailable(), install: installAwaiting() }),
  })
  const { store } = storeFor({ api })
  await store.initialize()
  const good = store.get()

  // 协议错误（响应不认识）：保留旧值，记稳定 code。
  api.updateStatus = async () => ({ ok: true, check: { status: 'weird' }, install: { status: 'nonsense' } })
  await store.refreshStatus()
  assert.deepEqual(store.get().check, good.check, '不认识的 check 不覆盖旧值')
  assert.deepEqual(store.get().install, good.install, '不认识的 install 不覆盖旧值')
  assert.deepEqual(store.get().error, { action: 'status', origin: 'background', code: 'malformed-check' })

  // 整个信封不认识
  api.updateStatus = async () => 'nope'
  await store.refreshStatus()
  assert.deepEqual(store.get().check, good.check)
  assert.deepEqual(store.get().install, good.install)
  assert.deepEqual(store.get().error, { action: 'status', origin: 'background', code: 'malformed-envelope' })

  // transport 失败
  api.updateStatus = () => {
    throw new Error('down')
  }
  await store.refreshStatus()
  assert.deepEqual(store.get().check, good.check)
  assert.deepEqual(store.get().install, good.install)
  assert.deepEqual(store.get().error, { action: 'status', origin: 'background', code: 'transport' })
})

test('22/23. Store 之间完全隔离；dispose 清理监听器与轮询', async () => {
  const first = storeFor({ script: { [UPDATE_OPERATION_NAMES[0]]: okEnvelope({ check: checkAvailable() }) } })
  const second = storeFor({ script: { [UPDATE_OPERATION_NAMES[0]]: okEnvelope({ check: checkUpToDate }) } })
  await first.store.initialize()
  await second.store.initialize()
  assert.equal(first.store.get().check.status, 'available')
  assert.equal(second.store.get().check.status, 'up-to-date', '两个实例互不影响')

  // 订阅、退订、dispose
  const seen = []
  const unsubscribe = first.store.subscribe((snapshot) => seen.push(snapshot.check?.status ?? 'none'))
  assert.equal(typeof unsubscribe, 'function')
  const before = seen.length
  await first.store.refreshStatus()
  assert.ok(seen.length >= before, '状态变化会通知订阅者')

  // 同一个状态再来一次：值没变就不通知（组件不做无意义的重渲染）。
  const same = seen.length
  await first.store.refreshStatus()
  assert.equal(seen.length, same, '值没有变化时不通知订阅者')

  const listener = () => {
    throw new Error('订阅者自己炸了')
  }
  first.store.subscribe(listener)
  await first.store.refreshStatus() // 不得把 Store 打挂

  unsubscribe()
  first.store.dispose()
  const afterDispose = seen.length
  await first.store.refreshStatus()
  assert.equal(seen.length, afterDispose, 'dispose 之后清空监听器，不再通知')
  assert.equal(first.scheduler.pending(), 0, 'dispose 停止轮询')
})

// ---------------------------------------------------------------------------
// 四、View Model
// ---------------------------------------------------------------------------

test('14. badge 文本与 tone', () => {
  assert.equal(vm(snapshotOf()).badgeText, `v0.0.11`)
  assert.equal(vm(snapshotOf()).badgeTone, 'neutral')

  const checking = vm(snapshotOf({ check: checkChecking(), checking: true }))
  assert.equal(checking.badgeText, `v0.0.11 · ${zhCN.updateBadgeChecking}`)
  assert.equal(checking.checking, true)

  const available = vm(snapshotOf({ check: checkAvailable() }))
  assert.equal(available.badgeText, `v0.0.11 · ${zhCN.updateBadgeUpdate}`)
  assert.equal(available.badgeTone, 'accent')

  const awaiting = vm(snapshotOf({ install: installAwaiting() }))
  assert.equal(awaiting.badgeText, `v0.0.11 · ${zhCN.updateBadgeAwaitingRestart}`)
  assert.equal(awaiting.badgeTone, 'warn')

  const updated = vm(snapshotOf({ install: { status: 'updated', version: '0.0.12' } }), { currentVersion: '0.0.12' })
  assert.equal(updated.badgeText, `v0.0.12 · ${zhCN.updateBadgeUpdated}`)
  assert.equal(updated.badgeTone, 'success')

  const dev = vm(snapshotOf({ check: checkUnsupported('development-install') }))
  assert.equal(dev.badgeText, zhCN.buildTagDev, 'dev 形态不显示版本号标签')
})

test('15/16. 三种 unsupported 原因与候选过期判据', () => {
  const dev = vm(snapshotOf({ check: checkUnsupported('development-install') }))
  assert.equal(dev.installBlockedReason, 'development-install')
  assert.equal(dev.canCheck, false)
  assert.equal(dev.canInstall, false)

  const enterprise = vm(snapshotOf({ check: checkUnsupported('enterprise-registry') }))
  assert.equal(enterprise.installBlockedReason, 'enterprise-registry')
  assert.equal(enterprise.canInstall, false)
  assert.equal(JSON.stringify(enterprise).includes('http'), false, '企业源不得带出 URL')

  const noManager = vm(snapshotOf({ check: checkUnsupported('manager-unavailable') }))
  assert.equal(noManager.installBlockedReason, 'manager-unavailable')
  assert.equal(noManager.canInstall, false)

  // candidate 正好到 expiresAt：已经过期
  const expiresAt = new Date(NOW_MS + UPDATE_SUCCESS_TTL_MS).toISOString()
  const atExpiry = vm(snapshotOf({ check: checkAvailable() }), { nowMs: Date.parse(expiresAt) })
  assert.equal(atExpiry.installBlockedReason, 'candidate-expired')
  assert.equal(atExpiry.canInstall, false)

  const beforeExpiry = vm(snapshotOf({ check: checkAvailable() }), { nowMs: Date.parse(expiresAt) - 1 })
  assert.equal(beforeExpiry.canInstall, true)
  assert.equal(beforeExpiry.installBlockedReason, null)

  // expiresAt 非法 → 也当作过期
  const invalid = vm(snapshotOf({ check: checkAvailable({ candidate: candidate({ expiresAt: '不是时间' }) }) }))
  assert.equal(invalid.installBlockedReason, 'candidate-expired')
  assert.equal(invalid.canInstall, false)
})

test('17/18. audit-active 禁止安装但允许检查；install-active 禁止再次安装并允许取消', () => {
  const audit = vm(snapshotOf({ check: checkAvailable() }), { auditBusy: true })
  assert.equal(audit.canInstall, false)
  assert.equal(audit.installBlockedReason, 'audit-active')
  assert.equal(audit.canCheck, true, '有审核也允许检查')

  const installing = vm(snapshotOf({ check: checkAvailable(), install: installInstalling(), installing: true }))
  assert.equal(installing.canInstall, false)
  assert.equal(installing.installBlockedReason, 'install-active')
  assert.equal(installing.canCancel, true)
  assert.equal(installing.installStage, 'connecting')
  assert.equal(installing.installing, true)
})

test('19/20. awaiting-restart 压过 available；updated 成功提示', () => {
  const awaiting = vm(snapshotOf({ check: checkAvailable(), install: installAwaiting() }))
  assert.equal(awaiting.awaitingRestart, true)
  assert.equal(awaiting.installBlockedReason, 'awaiting-restart')
  assert.equal(awaiting.canInstall, false)
  assert.equal(awaiting.badgeTone, 'warn')
  assert.equal(awaiting.targetVersion, '0.0.12', '仍然给出目标版本供展示')

  const updated = vm(snapshotOf({ check: checkUpToDate, install: { status: 'updated', version: '0.0.12' } }), {
    currentVersion: '0.0.12',
  })
  assert.equal(updated.showUpdated, true)
  assert.equal(updated.awaitingRestart, false)
  assert.equal(updated.canInstall, false, '没有候选就不能安装')
  assert.equal(updated.installBlockedReason, 'no-candidate')
})

test('21. 后台错误不展示，手动错误展示；安装失败给出稳定文案', () => {
  const background = vm(
    snapshotOf({ check: checkAvailable(), error: { action: 'poll', origin: 'background', code: 'transport' } }),
  )
  assert.equal(background.showManualCheckError, false, '后台失败不打断用户')

  const manual = vm(snapshotOf({ error: { action: 'check', origin: 'manual', code: 'transport' } }))
  assert.equal(manual.showManualCheckError, true)
  assert.equal(manual.manualCheckErrorText, zhCN.updateCheckFailedManual)

  // 手动检查被 Host 判为 error（checkOrigin=manual）→ 可见；后台则不可见
  const manualHostError = vm(snapshotOf({ check: checkError('timeout'), checkOrigin: 'manual', error: null }))
  assert.equal(manualHostError.showManualCheckError, true, '用户主动检查失败要可见')
  const backgroundHostError = vm(snapshotOf({ check: checkError('timeout'), checkOrigin: 'background' }))
  assert.equal(backgroundHostError.showManualCheckError, false, '后台检查失败不打断')

  const failed = vm(snapshotOf({ install: { status: 'failed', kind: 'source-unavailable', targetVersion: '0.0.12' } }))
  assert.equal(failed.showInstallError, true)
  assert.equal(failed.installErrorText, zhCN.updateInstallFailed)

  const cancelled = vm(snapshotOf({ install: { status: 'cancelled', targetVersion: '0.0.12' } }))
  assert.equal(cancelled.showInstallError, false, '取消不是错误')
  assert.equal(cancelled.canInstall, false)

  // 每一种禁用原因都要有稳定 code + 非空文案（界面不能渲染空字符串给用户）
  const reasons = [
    ['development-install', snapshotOf({ check: checkUnsupported('development-install') }), {}],
    ['enterprise-registry', snapshotOf({ check: checkUnsupported('enterprise-registry') }), {}],
    ['manager-unavailable', snapshotOf({ check: checkUnsupported('manager-unavailable') }), {}],
    ['candidate-expired', snapshotOf({ check: checkAvailable({ candidate: candidate({ expiresAt: '不是时间' }) }) }), {}],
    ['audit-active', snapshotOf({ check: checkAvailable() }), { auditBusy: true }],
    ['install-active', snapshotOf({ check: checkAvailable(), install: installInstalling(), installing: true }), {}],
    ['awaiting-restart', snapshotOf({ check: checkAvailable(), install: installAwaiting() }), {}],
    ['no-candidate', snapshotOf({ check: checkUpToDate }), {}],
  ]
  for (const [reason, snapshot, extra] of reasons) {
    const blocked = vm(snapshot, extra)
    assert.equal(blocked.installBlockedReason, reason, reason)
    assert.ok(blocked.installBlockedText.length > 0, `${reason} 必须有文案`)
  }
})

test('21b. 优先级固定：能力型不支持压过临时占用，等待重启压过一切', () => {
  // dev 安装里碰上一次审核：说"dev 不参与自助更新"，而不是"等审核结束就能装"（那永远装不了）。
  const devBusy = vm(snapshotOf({ check: checkUnsupported('development-install') }), { auditBusy: true })
  assert.equal(devBusy.installBlockedReason, 'development-install')
  const enterpriseBusy = vm(snapshotOf({ check: checkUnsupported('enterprise-registry') }), { auditBusy: true })
  assert.equal(enterpriseBusy.installBlockedReason, 'enterprise-registry')
  // 等待重启最优先：磁盘已经改过，重启前不许再动 profile。
  const restartBeatsAll = vm(
    snapshotOf({ check: checkAvailable(), install: installAwaiting(), installing: true }),
    { auditBusy: true },
  )
  assert.equal(restartBeatsAll.installBlockedReason, 'awaiting-restart')
  assert.equal(restartBeatsAll.awaitingRestart, true)
})

test('14b. 候选字段与来源类型暴露给界面；无候选时为空值', () => {
  const withCandidate = vm(snapshotOf({ check: checkAvailable({ candidate: candidate({ publishedAt: '2026-09-28T02:00:00.000Z' }) }) }))
  assert.equal(withCandidate.hasCandidate, true)
  assert.equal(withCandidate.targetVersion, '0.0.12')
  assert.equal(withCandidate.currentVersion, '0.0.11')
  assert.equal(withCandidate.publishedAt, '2026-09-28T02:00:00.000Z')
  assert.equal(withCandidate.sourceKind, 'npmmirror')

  const none = vm(snapshotOf({ check: checkUpToDate }))
  assert.equal(none.hasCandidate, false)
  assert.equal(none.targetVersion, '')
  assert.equal(none.publishedAt, '')
  assert.equal(none.sourceKind, null)
})

// ---------------------------------------------------------------------------
// 五、静态边界
// ---------------------------------------------------------------------------

test('门面：四个方法零参数、只发空 args、操作名来自共享常量', async () => {
  assert.deepEqual(Object.values(UPDATE_METHOD_OPERATION), [...UPDATE_OPERATION_NAMES])
  const calls = []
  const api = createUpdateApi(async (operation, args) => {
    calls.push({ operation, args })
    return okEnvelope()
  })
  // 即使调用方硬塞参数，请求里也只能是 {}
  await api.updateStatus({ version: '9.9.9' })
  await api.updateCheck({ registry: PRIVATE })
  await api.updateInstall({ spec: 'evil@1.0.0' })
  await api.updateCancel({ requestId: 'req-1' })

  assert.deepEqual(
    calls.map((call) => call.operation),
    [...UPDATE_OPERATION_NAMES],
  )
  for (const call of calls) {
    assert.deepEqual(call.args, {}, '更新方法的请求体永远是空对象')
  }
  for (const method of ['updateStatus', 'updateCheck', 'updateInstall', 'updateCancel']) {
    assert.equal(api[method].length, 0, `${method} 必须是零参数方法`)
  }
  // 默认门面（组合进 workbenchApi 的那份）也存在同样的四个方法
  assert.equal(typeof updateApi.updateInstall, 'function')
})

test('Client 侧静态边界：无 Node import、无 localStorage、无 React、时间靠参数', async () => {
  /** 只看代码：注释里说明"不使用 localStorage"当然不算违规。 */
  const codeOnly = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const file of ['api.ts', 'update-store.ts', 'view-model.ts']) {
    const source = codeOnly(await readFile(new URL(`src/client/features/update/${file}`, ROOT), 'utf8'))
    assert.equal(/from\s+'node:/.test(source), false, `${file} 不得导入 Node 模块`)
    assert.equal(source.includes('localStorage'), false, `${file} 不得使用 localStorage`)
    assert.equal(source.includes('sessionStorage'), false, `${file} 不得使用 sessionStorage`)
    assert.equal(/from\s+'react'/.test(source), false, `${file} 是纯状态层，不得依赖 React`)
    assert.equal(source.includes('Date.now'), false, `${file} 的时间必须由调用方传入`)
    assert.equal(source.includes('process.env'), false, `${file} 不得读环境变量`)
  }
  // 安装参数防注入由行为测试证明（门面零参数 + 四个方法只发 {} + Store 不拼参数），
  // 这里再钉一条静态事实：Store 里没有 requestId / 包名 / registry 的入口。
  const store = codeOnly(await readFile(new URL('src/client/features/update/update-store.ts', ROOT), 'utf8'))
  for (const forbidden of ['requestId:', 'packageName:', "spec:", 'approvedBuilds:', 'argv:']) {
    assert.equal(store.includes(forbidden), false, `Store 不得出现安装参数入口：${forbidden}`)
  }
})

// ---------------------------------------------------------------------------
// 六、审查修正：刷新恢复 / 并发覆盖 / 错误归属 / 过期响应
// ---------------------------------------------------------------------------

test('24. initialize 恢复到 installing：ViewModel 与轮询都要跟上', async () => {
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope({
      check: checkAvailable(),
      install: installInstalling({ stage: 'downloading' }),
    }),
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })
  await store.initialize()

  const snapshot = store.get()
  assert.equal(snapshot.install.status, 'installing', 'Host 说在装就是事实')
  const view = vm(snapshot)
  assert.equal(view.installing, true, '刷新后必须恢复成正在安装')
  assert.equal(view.canCancel, true, '刷新后必须还能取消')
  assert.equal(view.canInstall, false, '正在安装时不能再点安装')
  assert.equal(view.installBlockedReason, 'install-active')
  assert.equal(view.badgeSuffix, zhCN.updateBadgeInstalling, '不能显示成普通「有更新」')
  assert.equal(scheduler.pending(), 1, '恢复 installing 后要立刻恢复轮询')

  // 轮询继续按 Host 事实推进
  await scheduler.runNext()
  assert.equal(scheduler.pending(), 1, 'Host 仍在装 → 继续轮询')
  assert.equal(store.get().install.status, 'installing')
})

test('25. install 未完成时执行 check：安装活动与轮询都不能被冲掉', async () => {
  const installGate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await installGate.promise
      return okEnvelope({ install: installInstalling({ stage: 'installing' }) })
    },
    [UPDATE_OPERATION_NAMES[1]]: okEnvelope({ check: checkAvailable() }),
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  const installing = store.install()
  await tick(4)
  assert.equal(store.get().installing, true, '安装请求在飞')

  await store.check()
  assert.equal(store.get().checking, false, '检查已结束')
  assert.equal(store.get().installing, true, '检查不得清除安装活动')
  const view = vm(store.get())
  assert.equal(view.installing, true)
  assert.equal(view.canCancel, true, '取消入口不能丢')
  assert.equal(scheduler.pending(), 1, '轮询不能因为检查而停')

  installGate.resolve()
  await installing
  assert.equal(store.get().install.status, 'installing')
})

test('26. install 传输失败后立刻取事实：status=installing 时保持安装中并继续轮询', async () => {
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: () => {
      throw new Error(`install response lost ${SECRET_TEXT}`)
    },
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope({
      check: checkAvailable(),
      install: installInstalling({ stage: 'downloading' }),
    }),
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  const state = await store.install()
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[0]), 1, '传输失败后必须立刻取一次事实')
  assert.equal(state.install.status, 'installing', '不能凭空判定 idle 或成功')
  const view = vm(state)
  assert.equal(view.installing, true)
  assert.equal(view.canCancel, true)
  assert.equal(view.showManualCheckError, false, '不能显示成「检查更新失败」')
  assert.equal(view.showInstallError, false, '安装确实在进行，不报安装失败')
  assert.equal(scheduler.pending(), 1, '继续轮询观察阶段')
  assert.equal(JSON.stringify(state).includes(SECRET_TEXT), false, '异常原文不进状态')
})

test('27. install 传输失败且 status 也失败：error.action=install，不显示成检查失败', async () => {
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: () => {
      throw new Error('install lost')
    },
    [UPDATE_OPERATION_NAMES[0]]: () => {
      throw new Error('status lost')
    },
  })
  const { store } = storeFor({ api })
  const state = await store.install()

  assert.deepEqual(state.error, { action: 'install', origin: 'manual', code: 'transport' })
  const view = vm(state)
  assert.equal(view.showInstallError, true, '必须显示安装失败')
  assert.equal(view.showManualCheckError, false, '不能显示成检查失败')
  assert.equal(view.installErrorText, zhCN.updateInstallFailed)
  assert.equal(view.installing, false, '取不到事实时不得假装在装')
  assert.equal(JSON.stringify(state).includes('install lost'), false)
})

test('28. 较新的 completed 已应用后，较早请求返回 idle 不得覆盖', async () => {
  const statusGate = deferred()
  let statusCall = 0
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: okEnvelope({ install: installAwaiting() }),
    [UPDATE_OPERATION_NAMES[0]]: async () => {
      statusCall += 1
      if (statusCall === 1) {
        await statusGate.promise
        return okEnvelope({ check: checkAvailable(), install: installIdle })
      }
      return okEnvelope({ check: checkAvailable(), install: installAwaiting() })
    },
  })
  const { store } = storeFor({ api })

  const stale = store.refreshStatus() // 发得早：捕获旧世代
  await tick(4)
  await store.install() // 新事务落定
  assert.equal(store.get().install.status, 'awaiting-restart')

  statusGate.resolve()
  await stale
  assert.equal(store.get().install.status, 'awaiting-restart', '较早请求的 idle 不得覆盖较新的终态')
})

test('29. 较早的终态/installing 都不得覆盖较新事务的状态', async () => {
  const staleGate = deferred()
  let statusCall = 0
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: okEnvelope({ install: installInstalling({ stage: 'downloading' }) }),
    [UPDATE_OPERATION_NAMES[0]]: async () => {
      statusCall += 1
      if (statusCall === 1) {
        await staleGate.promise
        return okEnvelope({ install: { status: 'failed', kind: 'network', targetVersion: '0.0.12' } })
      }
      return okEnvelope({ install: installInstalling({ stage: 'downloading' }) })
    },
  })
  const { store } = storeFor({ api })

  const stale = store.refreshStatus() // 旧世代的响应：一个旧终态
  await tick(4)
  await store.install() // 新事务：Host 说在装
  assert.equal(store.get().install.status, 'installing')

  staleGate.resolve()
  await stale
  assert.equal(store.get().install.status, 'installing', '较早的终态不得覆盖新事务的状态')
  assert.equal(store.get().error, null)
})

test('29b. 同一事务内：较新的 cancelled 落定后，晚到的 installing 与旧终态都不得覆盖', async () => {
  const lateGate = deferred()
  let statusCall = 0
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: okEnvelope({ install: installInstalling({ stage: 'installing' }) }),
    [UPDATE_OPERATION_NAMES[3]]: okEnvelope({ install: { status: 'cancelled', targetVersion: '0.0.12' } }),
    [UPDATE_OPERATION_NAMES[0]]: async () => {
      statusCall += 1
      if (statusCall === 1) return okEnvelope({ install: installInstalling({ stage: 'connecting' }) })
      await lateGate.promise
      return okEnvelope({ install: { status: 'failed', kind: 'timeout', targetVersion: '0.0.12' } })
    },
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  await store.install()
  await store.cancel()
  assert.equal(store.get().install.status, 'cancelled')

  // 同一事务里，一个"发得早、回得晚"的轮询带着旧终态回来
  const late = store.refreshStatus()
  await tick(4)
  lateGate.resolve()
  await late
  assert.equal(store.get().install.status, 'cancelled', '晚到的旧终态不得覆盖已落定的 cancelled')
  assert.equal(store.get().cancelling, false)
  assert.equal(scheduler.pending(), 0, '终态后不再轮询')
})

test('30. Host 返回终态后：已有轮询被取消且不再安排', async () => {
  const installGate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await installGate.promise
      return okEnvelope({ install: installAwaiting() })
    },
    // 第一次 status 说在装（安装请求还没落定时的事实），之后说 cancelled
    [UPDATE_OPERATION_NAMES[0]]: (() => {
      let call = 0
      return () => {
        call += 1
        return call === 1
          ? okEnvelope({ install: installInstalling({ stage: 'installing' }) })
          : okEnvelope({ install: { status: 'cancelled', targetVersion: '0.0.12' } })
      }
    })(),
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  const installing = store.install()
  await tick(4)
  assert.equal(scheduler.pending(), 1, '安装期间在轮询')

  await scheduler.runNext() // 第一次轮询：Host 说在装
  assert.equal(store.get().install.status, 'installing')
  await scheduler.runNext() // 第二次轮询：Host 已落定（cancelled）
  assert.equal(store.get().install.status, 'cancelled')
  assert.equal(scheduler.pending(), 0, 'Host 落定后必须停止轮询')

  installGate.resolve()
  await installing
  assert.equal(store.get().install.status, 'awaiting-restart', '安装请求自己的终态仍然权威')
  assert.equal(scheduler.pending(), 0, '终态后不再安排下一次轮询')
})

test('31. check 与 status/poll 并发：check 的 finally 不清除安装状态或轮询', async () => {
  const installGate = deferred()
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await installGate.promise
      return okEnvelope({ install: installInstalling({ stage: 'installing' }) })
    },
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope({ install: installInstalling({ stage: 'downloading' }) }),
    [UPDATE_OPERATION_NAMES[1]]: okEnvelope({ check: checkAvailable() }),
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  const installing = store.install()
  await tick(4)
  await scheduler.runNext() // Host 事实：installing
  assert.equal(store.get().install.status, 'installing')

  await store.check() // 检查结束：不能顺手把安装/轮询清掉
  assert.equal(store.get().install.status, 'installing', '检查不得清除 Host 的安装事实')
  assert.equal(vm(store.get()).canCancel, true)

  await scheduler.runNext()
  assert.equal(scheduler.pending(), 1, '检查之后轮询必须继续')

  installGate.resolve()
  await installing
})

test('32. cancel 传输失败：status 仍说在装 → 保持安装中；status 也失败 → action=cancel', async () => {
  const cancelGate = deferred()
  const statusScript = { install: installInstalling({ stage: 'installing' }) }
  const api = fakeUpdateApi({
    [UPDATE_OPERATION_NAMES[2]]: async () => {
      await cancelGate.promise
      return okEnvelope({ install: installInstalling({ stage: 'installing' }) })
    },
    [UPDATE_OPERATION_NAMES[3]]: () => {
      throw new Error('cancel lost')
    },
    [UPDATE_OPERATION_NAMES[0]]: okEnvelope(statusScript),
  })
  const scheduler = fakeScheduler()
  const { store } = storeFor({ api, scheduler })

  const installing = store.install()
  await tick(4)
  const state = await store.cancel()
  assert.equal(api.countOf(UPDATE_OPERATION_NAMES[0]) >= 1, true, '取消失败后要取事实')
  assert.equal(state.install.status, 'installing', '事实说还在装 → 不谎报取消')
  assert.equal(vm(state).canCancel, true, '还能再取消一次')
  assert.equal(state.cancelling, false)

  // status 也失败：必须如实报 action=cancel
  const blind = storeFor({
    api: fakeUpdateApi({
      [UPDATE_OPERATION_NAMES[3]]: () => {
        throw new Error('cancel lost')
      },
      [UPDATE_OPERATION_NAMES[0]]: () => {
        throw new Error('status lost')
      },
    }),
  })
  const blindState = await blind.store.cancel()
  assert.deepEqual(blindState.error, { action: 'cancel', origin: 'manual', code: 'transport' })
  const blindView = vm(blindState)
  assert.equal(blindView.showCancelError, true)
  assert.equal(blindView.showManualCheckError, false)
  assert.equal(blindView.cancelErrorText, zhCN.updateCancelFailed)

  cancelGate.resolve()
  await installing
})
