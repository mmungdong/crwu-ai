/**
 * 设备流登录的**客户端逻辑**判据（协议 32）。
 *
 * 为什么逻辑在纯模块里、断言也打在纯模块上：本仓的 React 替身
 * （`tests/helpers/tsx-loader.mjs` 的 `fakeReact`）只实现渲染 —— `useEffect` 只被塞进数组、
 * 从不执行，`useState` 的 setter 也不触发重渲染。把轮询放进 `.tsx`，这段逻辑就**一点覆盖都没有**。
 * 所以 store 与视图派生是框架无关的纯函数，`.tsx` 只负责把它们画出来。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { createDeviceLoginStore, deviceLoginCardView, formatRemaining, loginManualOpenLines } = await import(
  new URL('src/client/modules/environment/model/device-login.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

const DEADLINE = '2026-10-13T00:05:00.000Z'

/** 一份 running 快照；`patch` 覆盖任意字段。 */
function view(patch = {}) {
  return {
    phase: 'running', url: '', urlManual: '', userCode: '', tail: '', error: '', advice: '',
    sandboxBlocked: false, deadlineAt: DEADLINE, opened: false, openError: '',
    ...patch,
  }
}

/** 假 api：`status` 按脚本逐次出牌，牌发完就一直回最后一个。 */
function fakeApi(script = {}) {
  const calls = []
  const queue = [...(script.status ?? [])]
  return {
    calls,
    dwsLoginDeviceStart: async () => { calls.push('start'); return script.start ?? view() },
    dwsLoginDeviceStatus: async () => {
      calls.push('status')
      if (queue.length > 1) return queue.shift()
      return queue[0] ?? null
    },
    dwsLoginDeviceCancel: async () => { calls.push('cancel'); return script.cancel ?? view({ phase: 'cancelled' }) },
  }
}

function fakeTimers() {
  const real = { set: globalThis.setInterval, clear: globalThis.clearInterval }
  const jobs = new Map()
  let seq = 0
  let cleared = 0
  globalThis.setInterval = (callback) => { seq += 1; jobs.set(seq, callback); return seq }
  globalThis.clearInterval = (id) => { cleared += 1; jobs.delete(id) }
  return {
    tick() { for (const callback of [...jobs.values()]) callback() },
    pending: () => jobs.size,
    cleared: () => cleared,
    restore() { globalThis.setInterval = real.set; globalThis.clearInterval = real.clear },
  }
}

const flush = () => new Promise((resolve) => { setImmediate(resolve) })

test('resume 时 status 已经是终态：直接显示终态，不排轮询', async () => {
  const timers = fakeTimers()
  try {
    const settled = []
    const api = fakeApi({ status: [view({ phase: 'ok' })] })
    const store = createDeviceLoginStore({ api, onSettled: (v) => settled.push(v.phase) })
    await store.resume()
    assert.equal(store.get().phase, 'ok')
    assert.equal(timers.pending(), 0, '已经结束的会话不该再轮询')
    assert.deepEqual(settled, ['ok'], '重挂之后仍然要把"已授权"这件事刷一次环境')
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('请求失败（旧宿主 404 / 传输错误）时给出失败快照，而不是让按钮变成死的', async () => {
  // 协议号挡的是"能发出去"的那一半；`rpc()` 对非 2xx 是**抛错**的，没有 catch 就只剩一个
  // unhandled rejection —— 员工看到的就是"点一下没反应"，正是协议号要消灭的那种表象。
  const timers = fakeTimers()
  try {
    const boom = async () => { throw new Error('工作台请求失败：HTTP 404') }
    const store = createDeviceLoginStore({
      api: { dwsLoginDeviceStart: boom, dwsLoginDeviceStatus: boom, dwsLoginDeviceCancel: boom },
    })
    await store.start()
    assert.equal(store.get().phase, 'failed')
    assert.match(store.get().error, /404/)
    assert.equal(timers.pending(), 0, '失败之后不许留下轮询')

    // resume 同样要有结论（面板一挂载就问，旧宿主会 404）。
    await store.resume()
    assert.equal(store.get().phase, 'failed')

    // cancel 失败也不能把卡片永远卡在"等待中"。
    await store.cancel()
    assert.equal(store.get().phase, 'failed')
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('切走再切回（重复 resume）时，"已授权"只通知一次', async () => {
  const timers = fakeTimers()
  try {
    const settled = []
    const api = fakeApi({ status: [view({ phase: 'ok' })] })
    const store = createDeviceLoginStore({ api, onSettled: (v) => settled.push(v.phase) })
    await store.resume()
    await store.resume()
    await store.resume()
    assert.deepEqual(settled, ['ok'], '每次重挂都刷一次环境等于把"重新检查"打成连发')
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('从没起过会话时 resume 什么都不做', async () => {
  const timers = fakeTimers()
  try {
    const api = fakeApi({ status: [null] })
    const store = createDeviceLoginStore({ api })
    await store.resume()
    assert.equal(store.get(), null)
    assert.equal(timers.pending(), 0)
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('start 后进入轮询，到终态停下，onSettled 只触发一次', async () => {
  const timers = fakeTimers()
  try {
    const settled = []
    const api = fakeApi({ start: view(), status: [view(), view({ phase: 'ok' })] })
    const store = createDeviceLoginStore({ api, onSettled: (v) => settled.push(v.phase) })
    await store.start()
    assert.equal(store.get().phase, 'running')

    timers.tick()
    await flush()
    assert.equal(store.get().phase, 'running')

    timers.tick()
    await flush()
    assert.equal(store.get().phase, 'ok')
    assert.deepEqual(settled, ['ok'])

    // 终态之后不许再轮询（否则一次登录会刷很多次环境）。
    const before = api.calls.filter((c) => c === 'status').length
    timers.tick()
    await flush()
    assert.equal(api.calls.filter((c) => c === 'status').length, before)
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('失败与超时同样只触发一次 onSettled，且把详情带出来', async () => {
  const timers = fakeTimers()
  try {
    const settled = []
    const api = fakeApi({
      start: view(),
      status: [view({ phase: 'timeout', error: '等待授权超时（5 分钟）', tail: '原文' })],
    })
    const store = createDeviceLoginStore({ api, onSettled: (v) => settled.push(v.phase) })
    await store.start()
    timers.tick()
    await flush()
    timers.tick()
    await flush()
    assert.equal(store.get().phase, 'timeout')
    assert.deepEqual(settled, ['timeout'])
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('cancel 之后不再轮询，且已经是终态的快照不会被覆写', async () => {
  const timers = fakeTimers()
  try {
    const api = fakeApi({ start: view(), status: [view()], cancel: view({ phase: 'cancelled' }) })
    const store = createDeviceLoginStore({ api })
    await store.start()
    await store.cancel()
    assert.equal(store.get().phase, 'cancelled')
    assert.equal(timers.pending(), 0)
    const before = api.calls.filter((c) => c === 'status').length
    timers.tick()
    await flush()
    assert.equal(api.calls.filter((c) => c === 'status').length, before)
    store.dispose()
  } finally {
    timers.restore()
  }
})

test('dispose 停掉轮询', async () => {
  const timers = fakeTimers()
  try {
    const api = fakeApi({ start: view(), status: [view()] })
    const store = createDeviceLoginStore({ api })
    await store.start()
    assert.equal(timers.pending(), 1)
    store.dispose()
    assert.equal(timers.pending(), 0)
    assert.ok(timers.cleared() >= 1)
  } finally {
    timers.restore()
  }
})

test('卡片视图：等待中给码、给链接、可取消、不可重试', () => {
  const card = deviceLoginCardView(
    view({ userCode: 'ABCD-EFGH', url: 'https://s.dingtalk.com/abc' }),
    { now: Date.parse('2026-10-13T00:00:23.000Z'), busy: false },
  )
  assert.equal(card.phase, 'running')
  assert.equal(card.code, 'ABCD-EFGH')
  assert.equal(card.link, 'https://s.dingtalk.com/abc')
  assert.equal(card.remaining, '4:37')
  assert.equal(card.canCancel, true)
  assert.equal(card.canRetry, false)
  assert.equal(card.canStart, false)
  assert.equal(card.canOpen, true)
})

test('卡片视图：没有链接时不能"打开授权页面"', () => {
  const card = deviceLoginCardView(view({ userCode: 'ABCD-EFGH' }), { now: 0, busy: false })
  assert.equal(card.canOpen, false)
})

test('卡片视图：忙碌时不能开始；取消过与会话为空一样都算闲置', () => {
  const idle = deviceLoginCardView(null, { now: 0, busy: false })
  assert.equal(idle.phase, 'idle')
  assert.equal(idle.canStart, true)

  // loopback 正在跑：不能**直接**再起一条（两个 dws 抢同一把 .dws 锁），
  // 但必须给员工一条出路 —— 那颗按钮变成「改用设备流登录」（先取消再起）。
  const busy = deviceLoginCardView(null, { now: 0, busy: true })
  assert.equal(busy.canStart, false, '不许直接并排再起一条设备流')
  assert.equal(busy.canSwitch, true, '要能"改用设备流登录"，否则员工点了登录钉钉就只能干等 5 分钟')
  assert.equal(deviceLoginCardView(null, { now: 0, busy: false }).canSwitch, false)
  const running = deviceLoginCardView(view(), { now: 0, busy: true })
  assert.equal(running.canSwitch, false, '已经有一条设备流在跑了，不需要"改用"')

  const cancelled = deviceLoginCardView(view({ phase: 'cancelled' }), { now: 0, busy: false })
  assert.equal(cancelled.phase, 'idle', '一次主动取消不该被显示成"失败"')
  assert.equal(cancelled.canStart, true)
  assert.equal(cancelled.detail, '')
})

test('卡片视图：失败时把原因、下一步动作与原文一起带出来', () => {
  const card = deviceLoginCardView(
    view({ phase: 'failed', error: '一句人话', advice: '下一步动作', tail: 'dws 原文' }),
    { now: 0, busy: false },
  )
  assert.equal(card.phase, 'failed')
  assert.equal(card.detail.includes('一句人话'), true)
  assert.equal(card.detail.includes('下一步动作'), true)
  assert.equal(card.detail.includes('dws 原文'), true)
  assert.equal(card.canRetry, true)
  assert.equal(card.canCancel, false)
})

test('卡片视图：把「手动输入授权码」那条链接单独带出来', () => {
  const card = deviceLoginCardView(
    view({ url: 'https://x.dingtalk.com/complete?user_code=A', urlManual: 'https://x.dingtalk.com/plain' }),
    { now: 0, busy: false },
  )
  assert.equal(card.link, 'https://x.dingtalk.com/complete?user_code=A')
  assert.equal(card.linkManual, 'https://x.dingtalk.com/plain')

  // 同一条链接不必说两遍。
  const same = deviceLoginCardView(
    view({ url: 'https://x.dingtalk.com/a', urlManual: 'https://x.dingtalk.com/a' }), { now: 0, busy: false })
  assert.equal(same.linkManual, '')

  const none = deviceLoginCardView(view({ url: 'https://x.dingtalk.com/a' }), { now: 0, busy: false })
  assert.equal(none.linkManual, '')
})

test('卡片视图：Host 没能打开授权页时说出来（否则员工以为点了没反应）', () => {
  const failed = deviceLoginCardView(
    view({ url: 'https://x.dingtalk.com/a', openError: 'open: 没有权限' }), { now: 0, busy: false })
  assert.equal(failed.openFailed, true)
  assert.equal(failed.detail.includes('open: 没有权限'), true)

  const ok = deviceLoginCardView(view({ url: 'https://x.dingtalk.com/a', opened: true }), { now: 0, busy: false })
  assert.equal(ok.openFailed, false)
})

test('客户端不自己开授权页：Host 已经开过一次，补开会开出两个窗口', () => {
  // 2026-10-13 评审抓到的竞态：客户端拿到的 `opened === false` 分不清"Host 还没试"和
  // "Host 那次调用还在飞"，于是它和 Host 各开一个窗口。可靠路径是那颗「打开授权页面」按钮。
  return Promise.all([
    readFile(new URL('src/client/modules/environment/model/device-login.ts', ROOT), 'utf8'),
    readFile(new URL('src/client/shell/WorkbenchPanel.tsx', ROOT), 'utf8'),
  ]).then(([feature, panel]) => {
    assert.equal(/window\.open/.test(feature), false, '登录特性里不许有自动开页')
    assert.equal(/shouldAutoOpenDeviceUrl/.test(panel), false, '面板不许再引用自动开页判据')
  })
})

test('formatRemaining 倒计时到 0:00，拿不到截止时间就回空串', () => {
  const now = Date.parse('2026-10-13T00:00:00.000Z')
  assert.equal(formatRemaining('2026-10-13T00:00:05.000Z', now), '0:05')
  assert.equal(formatRemaining('2026-10-13T00:05:00.000Z', now), '5:00')
  assert.equal(formatRemaining('2026-10-12T23:59:00.000Z', now), '0:00')
  assert.equal(formatRemaining('', now), '')
  assert.equal(formatRemaining('not-a-date', now), '')
})
