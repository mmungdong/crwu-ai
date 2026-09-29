/**
 * 钉钉登录两阶段（协议 21）的单元测试。
 *
 * 四条要守的东西：
 * 1. `parseDwsAuthorization` 是**尽力而为**的解析：URL 会被取出来并去掉尾部标点，
 *    设备码有连字符形态与「标签后跟码」两种写法；
 * 2. `start` **立刻**返回快照（不再同步等 5 分钟），URL 在命令还在跑的时候就能给界面；
 * 3. 正在跑的时候再 `start` 不会起第二个进程（否则两个进程抢同一个 `~/.dws` 锁）；
 * 4. 结束/超时都会收尾：超时要**杀掉**进程，并且快照里说清是超时而不是业务失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { parseDwsAuthorization, createDwsLoginRegistry } = await import(
  new URL('src/host/system/ops.ts', ROOT).href)

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 轮询等待一个条件成立（有界）。 */
async function waitFor(predicate, budgetMs = 2000) {
  const started = Date.now()
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== false && value !== null) return value
    if (Date.now() - started > budgetMs) throw new Error('waitFor 超时')
    await sleep(5)
  }
}

/** 假 Broker：只实现 `startShell`，并让我们手动喂输出、定退出码。 */
function fakeAccess() {
  const calls = { start: [], kill: 0 }
  /** 每次 `startShell` 都造一个**独立**句柄：回退重试会起第二个进程，共用句柄就串了。 */
  const handles = []
  const latest = {}
  const makeHandle = () => {
    const state = { pending: '', exitCode: 0, status: 'running', sandbox: undefined, resolveDone: undefined }
    const handle = {
      read() { const delta = state.pending; state.pending = ''; return { delta, lossy: false } },
      kill() { calls.kill += 1; state.status = 'killed'; state.resolveDone?.(); return true },
      done: undefined,
      exitCode: () => state.exitCode,
      status: () => state.status,
      sandbox: () => state.sandbox,
    }
    handle.done = new Promise((resolve) => { state.resolveDone = resolve })
    handles.push({ state, handle })
    latest.state = state
    latest.handle = handle
    return handle
  }
  const fore = { calls: [], reply: () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }) }
  const access = {
    authorize: () => ({ ok: true, error: '', errorClass: '' }),
    /** 登录前的配置目录探针走前台执行（`runDws` → `auth status`）。 */
    runShell: async (call, command) => {
      fore.calls.push(command)
      const reply = fore.reply(command)
      return {
        ok: reply.ok, error: reply.error ?? '', exitCode: reply.exitCode,
        stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', truncated: false,
        timedOut: false, aborted: false,
        sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false },
      }
    },
    startShell: async (call, command, options) => {
      calls.start.push({ call, command, options })
      return { ok: true, handle: makeHandle() }
    },
    writeText: async () => { throw new Error('本用例不写文件') },
    consent: () => ({ state: 'granted' }),
    diagnostics: () => [],
    lastDiagnostic: () => null,
  }
  return {
    access, calls, handles, fore,
    /** 最近一次起的进程（既有用例都只起一次，所以照旧可用）。 */
    get state() { return latest.state },
    get handle() { return latest.handle },
  }
}

/**
 * 最小 SystemDeps。
 *
 * `fs` 必须让包内 `dws` 二进制「存在」：配置目录探针走 `runDws` → `requireBundledCommand`，
 * 那种严格解析**不回退裸命令名**，拿不到 fs 就会在起进程之前返回 capability gap
 * （于是探针一次都不跑，用例断言"探过两次"会红 —— 这里就是这么发现的）。
 */
function depsOf(access) {
  const target = (path) => ({ targetKey: path, displayPath: path })
  return {
    ctx: {
      get(name) {
        if (name !== 'fs') return undefined
        return {
          async resolve(path) { return target(path) },
          async stat(t) { return String(t.targetKey).endsWith('dws') ? { type: 'file' } : undefined },
          async readText() { return '' },
          async writeText() { return { operation: 'create', version: 'v' } },
          contains: () => true,
        }
      },
    },
    state: {},
    access,
    platform: 'darwin-arm64',
    workdir: async () => '/cases/session',
  }
}

// ── 解析 ───────────────────────────────────────────────────────────────────

test('parseDwsAuthorization：取 URL 并去掉尾部标点，认两种设备码写法', () => {
  const device = parseDwsAuthorization(
    'Please open the following link in your browser and enter the authorization code:\n'
    + 'https://login.dingtalk.com/oauth2/device\nABCD-EFGH\n',)
  assert.equal(device.url, 'https://login.dingtalk.com/oauth2/device')
  assert.equal(device.userCode, 'ABCD-EFGH')

  const punctuated = parseDwsAuthorization('Or open the following link: https://login.dingtalk.com/device.')
  assert.equal(punctuated.url, 'https://login.dingtalk.com/device', '尾部句号不算 URL 的一部分')

  const labelled = parseDwsAuthorization('authorization code: WXYZ1234')
  assert.equal(labelled.userCode, 'WXYZ1234')

  const empty = parseDwsAuthorization('还在等浏览器回调…')
  assert.equal(empty.url, '')
  assert.equal(empty.userCode, '')
})

// ── 两阶段 ─────────────────────────────────────────────────────────────────

test('start 立刻返回 running 快照，并在命令还在跑时把 URL 交给界面', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5 })
  try {
    const first = await registry.start(depsOf(fake.access), {}, '')
    assert.equal(first.phase, 'running', 'start 不许等命令结束')
    assert.equal(first.ok, false)
    assert.equal(first.url, '', '还没输出时 URL 是空的')
    assert.equal(fake.calls.start.length, 1)
    assert.match(fake.calls.start[0].command, /dws auth login/)
    assert.equal(fake.calls.start[0].options.summary, 'dws auth login')

    fake.state.pending = 'Cannot automatically open browser\nOr open the following link: https://login.dingtalk.com/oauth2/auth?x=1\n'
    const url = await waitFor(() => (registry.status()?.url !== '' ? registry.status().url : undefined))
    assert.equal(url, 'https://login.dingtalk.com/oauth2/auth?x=1')
    assert.equal(registry.status().phase, 'running', '拿到 URL 时命令仍在等回调')
  } finally {
    await registry.dispose()
  }
})

test('设备码流程把 user code 也给出来，且结束成 ok', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5 })
  try {
    await registry.start(depsOf(fake.access), { device: true }, '')
    assert.match(fake.calls.start[0].command, /auth login --device/)
    fake.state.pending = 'enter the authorization code:\nABCD-EFGH\n'
    await waitFor(() => (registry.status()?.userCode !== '' ? true : undefined))
    assert.equal(registry.status().device, true)
    assert.equal(registry.status().userCode, 'ABCD-EFGH')

    fake.state.exitCode = 0
    fake.state.status = 'completed'
    fake.state.resolveDone()
    await waitFor(() => (registry.status()?.phase === 'ok' ? true : undefined))
    assert.equal(registry.status().ok, true)
    assert.equal(registry.status().error, '')
  } finally {
    await registry.dispose()
  }
})

test('失败会带上原文尾巴，而不是只报一个退出码', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5 })
  try {
    await registry.start(depsOf(fake.access), {}, '')
    fake.state.pending = 'dingtalk login failed: acquiring file lock: Access is denied\n'
    fake.state.exitCode = 1
    fake.state.status = 'completed'
    fake.state.resolveDone()
    await waitFor(() => (registry.status()?.phase === 'failed' ? true : undefined))
    const snapshot = registry.status()
    assert.equal(snapshot.ok, false)
    assert.match(snapshot.tail, /Access is denied/, 'tail 必须是 CLI 原文，供归因与人工判断')
    assert.notEqual(snapshot.error, '')
  } finally {
    await registry.dispose()
  }
})

test('正在跑的时候再 start 不起第二个进程（同一个 ~/.dws 锁）', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5 })
  try {
    await registry.start(depsOf(fake.access), {}, '')
    await registry.start(depsOf(fake.access), {}, '')
    assert.equal(fake.calls.start.length, 1, '第二次 start 只该回当前快照')
  } finally {
    await registry.dispose()
  }
})

test('超时是超时：杀掉进程并把 phase 说成 timeout', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5, limitMs: 20 })
  try {
    await registry.start(depsOf(fake.access), {}, '')
    await waitFor(() => (registry.status()?.phase === 'timeout' ? true : undefined), 3000)
    assert.equal(fake.calls.kill, 1, '超时必须真的杀掉进程')
    assert.equal(registry.status().timedOut, true)
    assert.equal(registry.status().ok, false)
  } finally {
    await registry.dispose()
  }
})

test('dispose 会杀掉仍在跑的进程（不留看不见的锁占用）', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5 })
  await registry.start(depsOf(fake.access), {}, '')
  await registry.dispose()
  assert.equal(fake.calls.kill, 1)
})

// ── 不再自指定目录（2026-09-29 决定）：登录命令回到 CLI 默认形状 ──────────────

test('登录命令不再注入 DWS_CONFIG_DIR（配置目录用 CLI 默认）', async () => {
  const fake = fakeAccess()
  const registry = createDwsLoginRegistry({ pollMs: 5 })
  try {
    await registry.start(depsOf(fake.access), {}, '/Users/employee')
    assert.equal(fake.calls.start.length, 1, '只起一个进程：不探测、不重试')
    const command = fake.calls.start[0].command
    // 换目录被实测否定过（三个位置都试过，问题在机器按程序拦子进程）→ 这条通道整体下掉。
    assert.equal(command.includes('DWS_CONFIG_DIR'), false)
    assert.equal(command.includes('dws-home'), false)
    // 临时目录也不再由插件指定（同上：自指定目录的通道下掉）。
    assert.equal(command.includes('TMPDIR'), false)
    assert.equal(fake.fore.calls.length, 0, '不许为了探测配置目录再跑一条命令')
  } finally {
    await registry.dispose()
  }
})
