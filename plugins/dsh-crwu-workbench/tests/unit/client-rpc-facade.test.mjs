/**
 * 类型化 RPC 门面（`features/report-audit/api.ts` + `features/update/api.ts`）的测试。
 *
 * 门面的价值在于「操作名与参数形状有一个地方说了算」，所以测试要钉四件事：
 * 1. 每个方法发出的 `op` 与 `OPERATION_OF` 一致；
 * 2. 门面覆盖了 Host 的全部 handler（少一个 = 点下去 404），**双向**核对；
 * 3. 更新四个方法不接受任何安装控制参数（额外传参也必须被忽略）；
 * 4. `gatingOf` 的门禁判据正确（氚云与钉钉都要认证通过才能发起审核）。
 *
 * 请求本身走 `fetch`，所以这里用一个记录调用的 fetch 替身 —— 顺带验证了
 * 门面没有绕过同源 RPC 端点。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { workbenchApi, OPERATION_OF, gatingOf } = await import(new URL('src/client/features/report-audit/api.ts', ROOT).href)
const { WORKBENCH_ROUTE, UPDATE_OPERATION_NAMES } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { FROZEN_OPERATIONS } = await import(new URL('tests/helpers/frozen-inventory.mjs', ROOT).href)

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

test('page batch facade preserves serials and cancellation on the same oss-index operation', async () => {
  const calls = stubFetch({ ok: true, error: '', results: {} })
  const controller = new AbortController()
  await workbenchApi.ossBatchIndex({ seqNos: ['2026-301705-LX1'] }, { signal: controller.signal })
  assert.deepEqual(calls[0].payload, { op: 'oss-index', args: { seqNos: ['2026-301705-LX1'] } })
  assert.equal(calls[0].init.signal, controller.signal)
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

/**
 * 长期 HOST_ONLY：**只有**这两个操作客户端有意不提供，别的一律要有门面方法。
 *
 * - `ping`：Host 侧的链路自检，客户端从不调用；
 * - `audit-release`：2026-09-20 按用户要求删掉了「只释放占用（不停子会话）」按钮 ——
 *   他会把占用锁解开而子会话继续跑，正是「两条子会话往同一个案例目录对写」那条闸门
 *   要拦的状态。操作本身留在宿主侧（应急用），界面上不再有入口。
 *
 * Task 4 曾把四个 `update-*` 临时列进来；Task 5 的门面已接上，那四项临时豁免**必须**
 * 保持删除状态（`host-operations.test.mjs` 与这里一起盯）。
 */
const HOST_ONLY = [
  'ping',
  'audit-release',
  // `trust`：协议 18 起**保留一代但不再授予任何权限**（只回协议不匹配的失败）。
  // 新客户端一律调 `local-access-grant` / `local-access-revoke`，所以它是 HOST_ONLY。
  'trust',
]

test('the facade covers exactly the frozen Host operation inventory (both directions)', () => {
  // 为什么以**冻结清单**为准而不是正则扫 `core.ts` 的对象字面量：Task 4 的四个更新操作是
  // `...updateOperations` 组合进去的，正则看不见它们 —— 那种"扫源码"的对账会静默漏掉一整类
  // 操作（这正是它曾经漏掉四个 update 操作的方式）。冻结清单是交付形状的单一事实源。
  const facade = Object.values(OPERATION_OF)

  const missing = FROZEN_OPERATIONS.filter((name) => !facade.includes(name) && !HOST_ONLY.includes(name))
  assert.deepEqual(missing, [], `Host 有但门面没有的操作：${missing.join(' ')}`)
  const extra = facade.filter((name) => !FROZEN_OPERATIONS.includes(name))
  assert.deepEqual(extra, [], `门面声明了但 Host 没有的操作：${extra.join(' ')}`)

  // 四个更新操作必须真的在门面里（不再享有临时豁免）。
  for (const name of UPDATE_OPERATION_NAMES) {
    assert.ok(facade.includes(name), `${name} 必须由门面提供`)
    assert.equal(HOST_ONLY.includes(name), false, `${name} 不得继续留在 HOST_ONLY`)
  }
})

test('the update facade methods are zero-argument and never carry install parameters', async () => {
  const calls = stubFetch({ ok: true })
  const injected = {
    updateStatus: { version: '9.9.9' },
    updateCheck: { force: true },
    updateInstall: { package: 'evil', version: '9.9.9', registry: 'https://evil.example/', spec: 'x@1' },
    updateCancel: { requestId: 'req-1' },
  }
  for (const [method, operation] of Object.entries(OPERATION_OF)) {
    if (!UPDATE_OPERATION_NAMES.includes(operation)) continue
    // 恶意/多余参数：实现必须忽略（方法签名就是零参数）。
    await workbenchApi[method](injected[method])
    const last = calls[calls.length - 1]
    assert.equal(last.payload.op, operation, method)
    assert.deepEqual(last.payload.args, {}, `${method} 只允许发空 args`)
    assert.deepEqual(Object.keys(last.payload).sort(), ['args', 'op'], `${method} 不得夹带别的字段`)
  }
  assert.equal(calls.length, UPDATE_OPERATION_NAMES.length)

  for (const method of ['updateStatus', 'updateCheck', 'updateInstall', 'updateCancel']) {
    assert.equal(workbenchApi[method].length, 0, `${method} 必须是零参数方法`)
  }
})

test('no update request body ever contains an install control field', async () => {
  const calls = stubFetch({ ok: true })
  const forbidden = [
    'package', 'name', 'version', 'targetVersion', 'registry', 'profile',
    'spec', 'command', 'argv', 'approvedBuilds', 'enabled',
  ]
  await workbenchApi.updateInstall({ version: '9.9.9', registry: 'https://evil.example/', command: 'npm i evil' })
  const body = JSON.stringify(calls[calls.length - 1].payload)
  for (const field of forbidden) {
    assert.equal(body.includes(field), false, `请求体不得出现 ${field}`)
  }
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
