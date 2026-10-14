/**
 * 设备流会话注册表的判据（协议 32）。
 *
 * 这里守的是**面板看得见的那几条行为**，不是实现细节：
 * 秒级拿到码（不是等命令跑完）、重发码后显示**最新**那个、取消幂等、超时兜底、
 * 卸载不留定时器、以及**授权码绝不进日志与诊断**。
 *
 * 替身说明：现有 `host-system-ops.test.mjs` 的 ctx 只实现了前台的 `result()`；
 * 后台句柄要的是 `startShell()` 真正会读的那六个成员（`readOutput` 是**消耗式**的）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { createDwsDeviceLoginRegistry, createLoginHandleHolder } = await import(
  new URL('src/host/core/system/device-login.ts', ROOT).href)

const NOW = Date.parse('2026-10-13T00:00:00.000Z')
const WORKDIR = '/cases/session'

/** 后台 exec 句柄：`readOutput` 只给上次读取之后的增量。 */
function backgroundExec() {
  let buffer = ''
  let status = 'running'
  let exitCode
  let sandboxFacts
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  return {
    push(chunk) { buffer += chunk },
    finish(code) { status = 'completed'; exitCode = code; resolveDone() },
    /** 执行器给出的**结构化**沙箱事实（受限执行器才有）。 */
    setSandbox(facts) { sandboxFacts = facts },
    exec: {
      readOutput() { const delta = buffer; buffer = ''; return { delta, lossy: false } },
      kill() { if (status !== 'running') return false; status = 'killed'; resolveDone(); return true },
      done,
      get exitCode() { return exitCode },
      get status() { return status },
      // ⚠️ **属性**不是方法：DSH 的 `ShellExecution.sandbox` 是值，`run.ts` 用
      // `sandbox: () => execution.sandbox` 取它。写成方法的话 `handle.sandbox()` 会回一个函数，
      // 结构化事实永远读不到（这条路径因此曾经完全没有被跑到过）。
      get sandbox() { return sandboxFacts },
    },
  }
}

/**
 * ctx：shell 按顺序记下每次命令，并同时支持两种执行形态。
 *
 * 后台句柄要那六个成员（`readOutput` 等）；而插件打开授权页走的是**前台** `runShell`，
 * 它读的是 `result()`。所以每次 execute 回一个两者都有的对象 —— 替身必须像真执行器那样
 * "前台/后台只是调用方要不要 await 结果"。
 */
function makeCtx() {
  const commands = []
  const procs = []
  const logs = []
  return {
    commands,
    procs,
    logs,
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    get(name) {
      if (name === 'shell') {
        return {
          resolve(request) { return request },
          async execute(spec) {
            commands.push(spec.command)
            const proc = backgroundExec()
            procs.push(proc)
            return {
              // ⚠️ 不能 `{...proc.exec}`：展开会把 `status` / `exitCode` 这两个 **getter 求值固化**，
              // 于是 `handle.status()` 永远回 'running'，终态再也落不下来。
              readOutput: proc.exec.readOutput,
              kill: proc.exec.kill,
              done: proc.exec.done,
              // 同样必须是 getter：写成 `sandbox: proc.exec.sandbox` 会在构造时把值固化。
              get sandbox() { return proc.exec.sandbox },
              get exitCode() { return proc.exec.exitCode },
              get status() { return proc.exec.status },
              result: async () => ({
                exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
              }),
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
          async stat() { return undefined },
          async readText() { return '' },
          async writeText() { return { operation: 'update', version: 'v', before: null, after: '' } },
          async listDir() { return [] },
          contains() { return false },
        }
      }
      return undefined
    },
  }
}

/** 假定时器：拦 `globalThis.setInterval` / `clearInterval`（实现只走这两个入口）。 */
function fakeTimers() {
  const real = { set: globalThis.setInterval, clear: globalThis.clearInterval }
  const jobs = new Map()
  let seq = 0
  let cleared = 0
  globalThis.setInterval = (callback) => { seq += 1; jobs.set(seq, callback); return seq }
  globalThis.clearInterval = (id) => { cleared += 1; jobs.delete(id) }
  return {
    tick() { for (const callback of [...jobs.values()]) callback() },
    cleared: () => cleared,
    pending: () => jobs.size,
    restore() { globalThis.setInterval = real.set; globalThis.clearInterval = real.clear },
  }
}

const flush = () => new Promise((resolve) => { setImmediate(resolve) })

function setup(patch = {}) {
  const ctx = makeCtx()
  const access = makeTestAccess(ctx).access
  const registry = createDwsDeviceLoginRegistry({
    now: () => NOW,
    ...patch,
  })
  const deps = { ctx, access, platform: 'darwin-arm64', workdir: async () => WORKDIR }
  return { ctx, access, registry, deps }
}

test('start 立刻回 running 快照，异步读到输出后带出 URL 与授权码', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    const first = await registry.start(deps)
    assert.equal(first.phase, 'running')
    assert.equal(first.url, '')
    assert.equal(first.userCode, '')
    assert.equal(first.deadlineAt, '2026-10-13T00:05:00.000Z')

    ctx.procs[0].push('请在浏览器中打开以下链接，并输入授权码：\nhttps://s.dingtalk.com/abc\n  ABCD-EFGH\n')
    timers.tick()
    const view = registry.status()
    assert.equal(view.url, 'https://s.dingtalk.com/abc')
    assert.equal(view.userCode, 'ABCD-EFGH')
    assert.equal(ctx.commands.filter((command) => command.includes('dws auth login')).length, 1)
    assert.match(ctx.commands[0], /dws auth login --device/)
  } finally {
    timers.restore()
  }
})

test('重复 start 不启第二个进程，只回当前快照', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    await registry.start(deps)
    assert.equal(ctx.commands.length, 1, '两个 dws 会抢同一把 ~/.dws 锁，第二个必然失败')
  } finally {
    timers.restore()
  }
})

test('dws 重发授权码后，快照里是最新的码（旧码已失效）', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].push('打开 https://s.dingtalk.com/one 并输入 ABCD-EFGH\n')
    timers.tick()
    assert.equal(registry.status().userCode, 'ABCD-EFGH')

    // 码过期后 dws 自己重发：旧码此刻已经无效，面板必须显示新的那个。
    ctx.procs[0].push('授权码已过期，正在重新发起设备授权流程...\n打开 https://s.dingtalk.com/two 并输入 ZZZZ-YYYY\n')
    timers.tick()
    assert.equal(registry.status().userCode, 'ZZZZ-YYYY')
    assert.equal(registry.status().url, 'https://s.dingtalk.com/two')
  } finally {
    timers.restore()
  }
})

test('授权成功：进程结束后 phase 是 ok，且终态不会被后续轮询改掉', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].push('授权成功!\n')
    ctx.procs[0].finish(0)
    timers.tick()
    assert.equal(registry.status().phase, 'ok')
    assert.equal(registry.status().error, '')
    timers.tick()
    assert.equal(registry.status().phase, 'ok')
  } finally {
    timers.restore()
  }
})

test('进程立刻失败（.dws 锁被占）时给出沙箱归因，而不是干等到超时', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].push('acquiring file lock: opening lock file: open C:\\Users\\x\\.dws\\.data.lock: Access is denied.\n')
    ctx.procs[0].finish(2)
    timers.tick()
    const view = registry.status()
    assert.equal(view.phase, 'failed')
    assert.equal(view.sandboxBlocked, true)
    assert.notEqual(view.advice, '')
  } finally {
    timers.restore()
  }
})

test('到 limitMs 就杀进程并落 timeout', async () => {
  const timers = fakeTimers()
  try {
    let clock = NOW
    const { ctx, registry, deps } = setup({ limitMs: 50, now: () => clock })
    await registry.start(deps)
    clock = NOW + 100
    timers.tick()
    assert.equal(registry.status().phase, 'timeout')
    assert.equal(ctx.procs[0].exec.status, 'killed')
  } finally {
    timers.restore()
  }
})

test('cancel 幂等：已经成功的会话再取消不会把 ok 覆写成失败', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].finish(0)
    timers.tick()
    assert.equal(registry.status().phase, 'ok')
    const after = registry.cancel()
    assert.equal(after.phase, 'ok')
    assert.equal(registry.status().phase, 'ok')
  } finally {
    timers.restore()
  }
})

test('cancel 掉正在跑的会话：落 cancelled 而不是失败', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    const after = registry.cancel()
    assert.equal(after.phase, 'cancelled')
    assert.equal(ctx.procs[0].exec.status, 'killed')
    assert.equal(registry.running(), false)
  } finally {
    timers.restore()
  }
})

test('dispose 杀掉仍在跑的进程并清掉定时器', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    assert.equal(timers.pending(), 1)
    await registry.dispose()
    assert.equal(registry.running(), false)
    assert.equal(ctx.procs[0].exec.status, 'killed')
    assert.equal(timers.pending(), 0)
    assert.ok(timers.cleared() >= 1, '不清定时器会让测试进程永远退不出来')
  } finally {
    timers.restore()
  }
})

test('设备流自己也不再让 dws 开浏览器（--no-browser），改由插件打开', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    assert.match(ctx.commands[0], /dws auth login --device --no-browser|dws auth login --no-browser --device/)
  } finally {
    timers.restore()
  }
})

test('拿到链接就打开一次，且打开的是「已填入授权码」那一版', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].push([
      '  授权码: ABCD-EFGH',
      '  授权链接（已填入授权码）：',
      '  https://login.dingtalk.com/oauth2/device/verify?user_code=ABCD-EFGH',
      '  手动输入授权码的链接：',
      '  https://login.dingtalk.com/oauth2/device/verify',
    ].join('\n') + '\n')
    timers.tick()
    await flush()
    const opens = ctx.commands.filter((command) => /^open /.test(command))
    assert.equal(opens.length, 1, '只开一次：轮询会反复看到同一个链接')
    assert.match(opens[0], /^open -n /, '强制新实例：无头浏览器实例会吞掉 URL')
    assert.match(opens[0], /user_code=ABCD-EFGH/, '开的是已填入授权码那一版（员工只要点确认）')
    assert.equal(registry.status().opened, true)
    assert.equal(registry.status().openError, '')
    assert.equal(registry.status().urlManual, 'https://login.dingtalk.com/oauth2/device/verify')

    // 再读一次同一段输出不许再开一个窗口。
    timers.tick()
    await flush()
    assert.equal(ctx.commands.filter((command) => /^open /.test(command)).length, 1)
  } finally {
    timers.restore()
  }
})

test('没拿到链接之前 opened 是 false（面板据此自己再开一次）', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    const first = await registry.start(deps)
    assert.equal(first.opened, false)
    assert.equal(first.openError, '')
    assert.deepEqual(ctx.commands.filter((command) => /^open /.test(command)), [], '还没有链接就一个浏览器都不许开')
  } finally {
    timers.restore()
  }
})

test('登录句柄持有者：取消会杀掉正在跑的那个，并复位到下一次会话', () => {
  // 为什么需要它：loopback 那条路最长占 5 分钟，那期间员工没有任何出路 ——
  // 实测「点了登录钉钉之后设备流按钮一直是灰的」。有了可杀的句柄，面板才能"改用设备流登录"。
  const holder = createLoginHandleHolder()
  assert.equal(holder.cancel(), false, '还没起进程时没什么可杀的')
  assert.equal(holder.cancelled, false)

  const proc = backgroundExec()
  holder.set(proc.exec)
  assert.equal(holder.cancelled, false, 'set 之后是干净的')
  assert.equal(holder.cancel(), true)
  assert.equal(holder.cancelled, true)
  assert.equal(proc.exec.status, 'killed')

  // 下一次会话不受上一次取消影响。
  const next = backgroundExec()
  holder.set(next.exec)
  assert.equal(holder.cancelled, false)
  assert.equal(next.exec.status, 'running')

  holder.dispose()
  assert.equal(next.exec.status, 'killed', 'dispose 也要收尾，不能留下占着 ~/.dws 锁的进程')
})

test('进程失败时用**结构化沙箱事实**归因，不是只靠文本', async () => {
  // 真机上 dws 可能在还没打印任何东西时就被沙箱挡住（一个字的输出都没有）——
  // 那时文本判据没有原料，只有执行器给的 `{ mode, denied }` 能说明问题。
  const timers = fakeTimers()
  try {
    const { ctx, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].setSandbox({ mode: 'workspace-write', denied: true })
    ctx.procs[0].finish(2)
    timers.tick()
    const view = registry.status()
    assert.equal(view.phase, 'failed')
    assert.equal(view.sandboxBlocked, true, '结构化事实说被沙箱拒了，就必须认')
    assert.match(view.advice, /完全权限/)
  } finally {
    timers.restore()
  }
})

test('授权码与 dws 原文绝不进日志、也不进本机访问诊断', async () => {
  const timers = fakeTimers()
  try {
    const { ctx, access, registry, deps } = setup()
    await registry.start(deps)
    ctx.procs[0].push('打开 https://s.dingtalk.com/abc 并输入 ABCD-EFGH\n')
    ctx.procs[0].finish(0)
    timers.tick()
    await flush()

    const haystacks = [JSON.stringify(ctx.logs), JSON.stringify(access.diagnostics())]
    for (const haystack of haystacks) {
      assert.equal(haystack.includes('ABCD-EFGH'), false, '授权码不得出现在日志或诊断里')
      assert.equal(haystack.includes('https://s.dingtalk.com/abc'), false, '授权链接不得出现在日志或诊断里')
    }
  } finally {
    timers.restore()
  }
})
