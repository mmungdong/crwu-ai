/**
 * 类型化 RPC 门面（`features/report-audit/api.ts`）的测试。
 *
 * 门面的价值在于「操作名与参数形状有一个地方说了算」，所以测试要钉三件事：
 * 1. 每个方法发出的 `op` 与 `OPERATION_OF` 一致；
 * 2. 门面覆盖了 Host 的全部 handler（少一个 = 点下去 404）；
 * 3. `gatingOf` 的门禁判据正确（氚云与钉钉都要认证通过才能发起审核）。
 *
 * 请求本身走 `fetch`，所以这里用一个记录调用的 fetch 替身 —— 顺带验证了
 * 门面没有绕过同源 RPC 端点。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { workbenchApi, OPERATION_OF, gatingOf } = await import(new URL('src/client/features/report-audit/api.ts', ROOT).href)
const { WORKBENCH_ROUTE } = await import(new URL('src/shared/consts.ts', ROOT).href)

/** 记录每次 fetch 的 op，并回放一个固定应答。 */
function stubFetch(body = { ok: true }) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) })
    return { ok: true, status: 200, async json() { return body } }
  }
  return calls
}

test('every facade method posts to the same-origin route with its operation name', async () => {
  const calls = stubFetch({ ok: true })
  await workbenchApi.boot()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, WORKBENCH_ROUTE)
  assert.equal(calls[0].payload.op, 'boot')
  assert.deepEqual(calls[0].payload.args, {}, '无参数操作也必须发一个空对象，不能让 Host 收到 undefined')
})

test('the facade sends the declared operation for every method', async () => {
  const calls = stubFetch({ ok: true })
  const args = {
    env: { source: 's' },
    pending: { query: 'q', page: 2 },
    auditStatus: { keys: ['k'] },
    auditStart: { key: 'k' },
    auditStop: { childId: 'c' },
    ossResult: { key: 'k' },
    ossLink: { key: 'k' },
    ossUpload: { key: 'k' },
    ossCredSave: { accessKeyId: 'a', accessKeySecret: 'b' },
    workspace: { path: '/p' },
    bindSession: { sessionId: 's' },
    trust: { h3yun: true },
    dwsLogin: { device: true },
    clipboard: { text: 'x' },
    openPath: { path: '/p' },
    crwu: { argv: ['crwu'] },
  }
  for (const [method, operation] of Object.entries(OPERATION_OF)) {
    await workbenchApi[method](args[method] ?? {})
    const last = calls[calls.length - 1]
    assert.equal(last.payload.op, operation, `${method} 应发出 ${operation}`)
  }
})

test('the facade covers exactly the operations the Host registers', async () => {
  // 少一个方法的后果是点下去 404，而界面只显示「未知 op」—— 很难反查到是前端漏了。
  const { readFile } = await import('node:fs/promises')
  const hostSource = await readFile(new URL('src/host/ops/core.ts', ROOT), 'utf8')
  const table = hostSource.slice(hostSource.indexOf('return {'))
  const registered = [...table.matchAll(/^\s{4}(?:'([a-z-]+)'|([a-zA-Z]+)):\s/gm)].map((match) => match[1] ?? match[2])

  // 白名单里的是「宿主有、门面有意不提供」的操作，这样「漏了一个」和「有意不加」
  // 不会被混为一谈：
  // - `ping`：Host 侧的链路自检，客户端从不调用；
  // - `audit-release`：2026-09-20 按用户要求删掉了「只释放占用（不停子会话）」按钮 ——
  //   他会把占用锁解开而子会话继续跑，正是「两条子会话往同一个案例目录对写」那条闸门
  //   要拦的状态。操作本身留在宿主侧（应急用），界面上不再有入口。
  const HOST_ONLY = ['ping', 'audit-release']
  const facade = Object.values(OPERATION_OF)
  const missing = registered.filter((name) => !facade.includes(name) && !HOST_ONLY.includes(name))
  assert.deepEqual(missing, [], `Host 注册了但门面没有的操作：${missing.join(' ')}`)
  const extra = facade.filter((name) => !registered.includes(name))
  assert.deepEqual(extra, [], `门面声明了但 Host 没有的操作：${extra.join(' ')}`)
})

test('the facade never invents operation names', () => {
  // 全部小写 + 连字符，与 Host 的 handler 命名一致。
  for (const operation of Object.values(OPERATION_OF)) {
    assert.match(operation, /^[a-z][a-z-]*$/)
  }
})

test('a network failure propagates instead of resolving an empty result', async () => {
  globalThis.fetch = async () => { throw new Error('network down') }
  await assert.rejects(workbenchApi.boot(), /network down/)
})

test('an HTTP error becomes a rejection, not a silent empty object', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return {} } })
  await assert.rejects(workbenchApi.pending({}), /HTTP 500/)
})

// ── 门禁 ────────────────────────────────────────────────────────────────────

/** 构造一个只有 services 相关的 env 应答。 */
function envWith(services) {
  return { services }
}

test('gatingOf requires BOTH h3yun and dingtalk to be ready', () => {
  const both = gatingOf(envWith([{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }]), '')
  assert.equal(both.canDispatch, true)

  const noDingtalk = gatingOf(envWith([{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: false }]), '')
  assert.equal(noDingtalk.canDispatch, false, '钉钉没认证就不能派发')

  const noH3yun = gatingOf(envWith([{ id: 'h3yun', ok: false }, { id: 'dingtalk', ok: true }]), '')
  assert.equal(noH3yun.canDispatch, false)

  const absent = gatingOf(envWith([]), '')
  assert.equal(absent.canDispatch, false, '服务没探测到也不能当作通过')
})

test('gatingOf has no env yet and blocks dispatch', () => {
  const gating = gatingOf(null, '')
  assert.equal(gating.canDispatch, false)
  assert.equal(gating.canStart, true, '没有 env 不影响「当前没有审核占用」这个事实')
})

test('gatingOf derives canStart from the active key', () => {
  const idle = gatingOf(envWith([{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }]), '')
  assert.equal(idle.canStart, true)
  const busy = gatingOf(envWith([{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }]), '2026-301705-LX10170')
  assert.equal(busy.canStart, false, '已有审核占用时不能再起一条')
})

test('gatingOf lets the caller override the busy flags for progressive UI', () => {
  const gating = gatingOf(envWith([{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }]), '', { auditBusy: 'k' })
  assert.equal(gating.auditBusy, 'k')
  assert.equal(gating.canStart, true)
})
