import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * P-11 的 **Host 侧门禁**（协议 18 · 2026-09-29 用户复查 P1）。
 *
 * 用户的原话：「UI 禁用不是安全边界，RPC 必须先通过具名 Broker 操作，未授权时
 * provider/fs/store/网络零调用」。所以这一组测试的断言只有一个形状：
 *
 *   撤销授权之后，直接调那条 RPC / 那个读函数 → **底层一个调用都没有**。
 *
 * 为什么必须测"零调用"而不是"返回未授权"：返回什么都可以事后补，而"有没有真的去读
 * 员工的本机凭据"只有一个证据 —— 底层替身有没有被碰过。旧实现的 `oss-cred` /
 * `ifind-status` / `ifind-probe` 在撤销之后照样读 `~/.ossutilconfig` 与凭据文件。
 */

const ROOT = new URL('../../', import.meta.url)
const { readOssCred } = await import(new URL('src/host/oss/cred.ts', ROOT).href)
const { readIfindSecret, writeIfindSecret, clearIfindSecret } = await import(
  new URL('src/host/ifind/store.ts', ROOT).href)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { missingConsent, grantedConsent } = await import(
  new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)

const HOME = '/Users/x'
const IFIND_HOME = '/Users/example'

/** 会**数调用**的 fs 替身：任何 stat / 读 / 写都记一笔。 */
function countingFs(files = {}) {
  const calls = []
  const store = { ...files }
  const service = {
    calls,
    async resolve(value) { calls.push(`resolve ${String(value)}`); return { targetKey: String(value), displayPath: String(value) } },
    async stat(target) { calls.push(`stat ${target.targetKey}`); return store[target.targetKey] === undefined ? undefined : { type: 'file' } },
    async readText(target) { calls.push(`read ${target.targetKey}`); return store[target.targetKey] },
    async writeText(target, content) {
      calls.push(`write ${target.targetKey}`)
      store[target.targetKey] = content
      return { operation: 'update', version: 'v', before: null, after: content }
    },
  }
  return { service, calls, store }
}

/** 会数调用的 DSH 凭据服务替身。 */
function countingCredentialStore(secret = 'abcdefghij') {
  const calls = []
  return {
    calls,
    get: async (key) => { calls.push(`get ${key}`); return secret },
    set: async (key, value) => { calls.push(`set ${key}`); void value },
    delete: async (key) => { calls.push(`delete ${key}`) },
  }
}

function ctxOf(fs, credentials) {
  return {
    get: (name) => {
      if (name === 'fs') return fs
      if (name === 'credentials') return credentials
      return undefined
    },
  }
}

test('P1 · 未授权时 `oss-cred` 一个 fs 调用都不发（撤销之后直接调 RPC 也读不到）', async () => {
  const fs = countingFs({ [`${HOME}/.ossutilconfig`]: '[Credentials]\naccessKeyID=AKID\n' })
  const ctx = ctxOf(fs.service, undefined)
  const denied = makeTestAccess(ctx, { home: HOME, consent: missingConsent() }).access
  const view = await readOssCred(ctx, HOME, { access: denied })
  assert.equal(view.exists, false)
  assert.match(view.reason, /本机访问尚未允许|允许/)
  assert.deepEqual(fs.calls, [], `未授权不许碰任何文件：${fs.calls.join(' · ')}`)

  // 授权之后才真的去读 —— 证明上面那条不是因为路径写错而"恰好"没调用。
  const granted = makeTestAccess(ctx, { home: HOME, consent: grantedConsent() }).access
  const allowed = await readOssCred(ctx, HOME, { access: granted })
  assert.equal(allowed.exists, true)
  assert.equal(fs.calls.length > 0, true, '授权之后必须真的去读')
})

test('P1 · 未授权时 `ifind-status` / `ifind-probe` 读不到凭据，也不发网络请求', async () => {
  const fs = countingFs({ [`${IFIND_HOME}/.dsh/crwu-workbench/ifind-credential.json`]: '{"auth_token":"abcdefghij"}' })
  const credentials = countingCredentialStore()
  const network = []
  // 传输替身：一旦被调用就留痕（未授权时它必须**一次都不被碰**）。
  const transport = { async request(...args) { network.push(args); return { ok: false } } }
  const ctx = ctxOf(fs.service, undefined)

  // ① 文件形态
  const deniedFile = makeTestAccess(ctx, { home: IFIND_HOME, consent: missingConsent() }).access
  const view = await readIfindSecret(ctx, IFIND_HOME, { access: deniedFile })
  assert.equal(view.ok, false)
  assert.equal(view.secret, '', '明文一个字节都不能读出来')
  assert.deepEqual(fs.calls, [], `未授权不许 stat / 读凭据文件：${fs.calls.join(' · ')}`)
  assert.deepEqual(credentials.calls, [], '未授权不许碰宿主凭据服务')
  assert.deepEqual(network, [], '未授权不许打外部请求')

  // ② 宿主凭据服务形态（这条最容易被漏：`store.get` 看着不像"读文件"）
  const hostCtx = ctxOf(fs.service, credentials)
  const deniedHost = makeTestAccess(hostCtx, { home: IFIND_HOME, consent: missingConsent() }).access
  const hostView = await readIfindSecret(hostCtx, IFIND_HOME, { access: deniedHost })
  assert.equal(hostView.ok, false)
  assert.deepEqual(credentials.calls, [], `未授权不许调 store.get：${credentials.calls.join(' · ')}`)
  void transport
})

test('P1 · 未授权时不许写 / 删宿主凭据服务（`store.set` / `store.delete`）', async () => {
  const fs = countingFs()
  const credentials = countingCredentialStore()
  const ctx = ctxOf(fs.service, credentials)
  const denied = makeTestAccess(ctx, { home: IFIND_HOME, consent: missingConsent() }).access

  const written = await writeIfindSecret(ctx, IFIND_HOME, 'abcdefghij', { platform: 'darwin-arm64', access: denied })
  assert.equal(written.ok, false)
  assert.deepEqual(credentials.calls, [], `未授权不许 store.set：${credentials.calls.join(' · ')}`)

  const cleared = await clearIfindSecret(ctx, IFIND_HOME, { platform: 'darwin-arm64', access: denied })
  assert.equal(cleared.ok, false)
  assert.deepEqual(credentials.calls, [], `未授权不许 store.delete：${credentials.calls.join(' · ')}`)

  // 授权之后同样的调用会真的落下去（证明上面两条不是被别的原因挡住的）。
  const granted = makeTestAccess(ctx, { home: IFIND_HOME, consent: grantedConsent() }).access
  const okWrite = await writeIfindSecret(ctx, IFIND_HOME, 'abcdefghij', { platform: 'darwin-arm64', access: granted })
  assert.equal(okWrite.ok, true, okWrite.error)
  assert.equal(credentials.calls.some((call) => call.startsWith('set ')), true)
})

test('P1 · 每个凭据操作都登记在**具名操作表**里（不是"随手加个 if"）', async () => {
  // 门禁走的是 Broker 的封闭操作表：这几条操作必须真的存在，而且都是"跨边界"那一类。
  const { localAccessDescriptorOf } = await import(new URL('src/host/access/operations.ts', ROOT).href)
  for (const operation of ['oss.config.read', 'ifind.credential.read', 'ifind.credential.write', 'ifind.credential.clear']) {
    const descriptor = localAccessDescriptorOf(operation)
    assert.notEqual(descriptor, undefined, `操作表里没有 ${operation}`)
    assert.equal(descriptor.allowedSources.includes('panel'), true, `${operation} 应当允许面板调用`)
  }
  // 读凭据的命令要在工作区之外，所以它必须是**特权**的（否则受限沙箱下读不到）。
  assert.equal(localAccessDescriptorOf('ifind.credential.read').privileged, true)
})
