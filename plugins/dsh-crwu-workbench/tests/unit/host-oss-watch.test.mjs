/**
 * 上传看门狗的测试。
 *
 * 为什么单独测它：审核跑完**不会**回调插件（一次性运行没有通知），交付件是子会话自己写进案例目录的。
 * 所以「有结果就传」只能靠轮询 —— 而轮询如果因为契约用错而**静默不跑**，症状是
 * 「什么都没上传」，没有任何报错。这一层必须能被测出来。
 *
 * 契约已对照 `@deepseek-ai/cordis-plugin-timer` 的类型声明核实：
 * `interval(callback, delay): () => void`（返回 disposer），`timeout(delay): Promise<void>`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { createUploadWatch } = await import(new URL('src/host/oss/watch.ts', ROOT).href)
const { normalizeAudit } = await import(new URL('src/host/state/registry.ts', ROOT).href)
const { manifestFixture } = await import(new URL('tests/helpers/manifest-fixture.mjs', ROOT).href)

const SEQ = '2026-301705-LX10170'

/** ctx：可选提供 timer；shell 与 fs 只答探测所需。 */
function makeCtx({ withTimer = true } = {}) {
  const intervals = []
  const cleared = []
  return {
    intervals,
    cleared,
    get(name) {
      if (name === 'timer' && withTimer) {
        return {
          interval(callback, delay) {
            intervals.push({ callback, delay })
            return () => { cleared.push(delay) }
          },
        }
      }
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute(spec) {
            const out = spec.command.startsWith('command -v')
              ? { stdout: '/usr/local/bin/ossutil\n' }
              : { stdout: 'ok' }
            return { result: async () => ({
              exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout, truncated: false }, stderr: { text: '', truncated: false },
            }) }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat() { return { type: 'file' } },
          async readText() { return '{}' },
          async listDir() {
            return [
              { type: 'file', name: `审核意见.${SEQ}.html`, target: { targetKey: 'h' } },
              { type: 'file', name: `审核结果.${SEQ}.json`, target: { targetKey: 'j' } },
            ]
          },
        }
      }
      return undefined
    },
  }
}

function depsOf(ctx, state) {
  return {
    ctx,
    state,
    manifest: manifestFixture({ oss: { enabled: true, bucket: 'bkt', prefix: 'crwu/audit', autoUpload: true } }),
    platform: 'darwin-arm64',
    home: '/Users/x',
    workdir: async () => '/cases/session',
  }
}

test('the watch starts a single interval through the injected timer service', () => {
  const ctx = makeCtx()
  const state = { audits: {}, activeKey: '', activeChildId: '' }
  const watch = createUploadWatch(ctx, state, async () => depsOf(ctx, state))
  watch.start()
  assert.equal(ctx.intervals.length, 1)
  assert.equal(ctx.intervals[0].delay, 30_000)
  // 重复 start 不得叠加定时器 —— 叠了就是每 30 秒扫两遍 OSS。
  watch.start()
  assert.equal(ctx.intervals.length, 1)
})

test('the watch is a safe no-op without a timer service', () => {
  // 缺 timer 时**不能抛**：环境自检页在没有 timer 的组合里也要能渲染。
  const ctx = makeCtx({ withTimer: false })
  const state = { audits: {}, activeKey: '', activeChildId: '' }
  const watch = createUploadWatch(ctx, state, async () => depsOf(ctx, state))
  assert.doesNotThrow(() => watch.start())
  assert.doesNotThrow(() => watch.stop())
})

test('a tick uploads a finished audit and then stops the interval', async () => {
  // 「都传完了就停表」：留着空转会让插件一直占着 timer，也让日志看起来还在跑。
  const ctx = makeCtx()
  const record = { ...normalizeAudit('k', {}), key: SEQ, casePath: `/cases/${SEQ}`, ended: true }
  const state = { audits: { [SEQ]: record }, activeKey: '' }
  const watch = createUploadWatch(ctx, state, async () => depsOf(ctx, state))
  watch.start()
  await watch.kick()
  assert.ok(record.uploadedAt !== '', '结束后的一轮应当把交付件传上去')
  assert.deepEqual(ctx.cleared, [30_000], '没有待上传项时必须释放定时器')
})

test('a tick keeps the interval alive while an audit is still pending', async () => {
  const ctx = makeCtx()
  // 活动中的那条还没结束 —— 没有可传的东西，但也不该收工（它随时可能出结果）。
  const record = { ...normalizeAudit('k', {}), key: SEQ, casePath: '', ended: false }
  const state = { audits: { [SEQ]: record }, activeKey: SEQ }
  const watch = createUploadWatch(ctx, state, async () => depsOf(ctx, state))
  watch.start()
  await watch.kick()
  assert.deepEqual(ctx.cleared, [], '还有活动中的审核时不能收工')
})

test('「还没有东西可传」不写 uploadError，也不留下 uploading', async () => {
  // 这一条区分两种「没传上去」：
  // - 没有 casePath / 案例还没交付件 = **还没有东西可传**，只把原因返回给调用方，
  //   **不**写 uploadError —— 写了界面就会给一条尚未出结果的记录挂上「上云失败」徽章；
  // - 真的尝试上传但失败 = 写 uploadError，界面据此提供「重传 OSS」。
  const ctx = makeCtx()
  const record = { ...normalizeAudit('k', {}), key: SEQ, casePath: '', ended: true }
  const state = { audits: { [SEQ]: record }, activeKey: '' }
  const watch = createUploadWatch(ctx, state, async () => depsOf(ctx, state))
  watch.start()
  await watch.kick()
  assert.equal(record.uploadError, '', '尚未定位案例目录不算上传失败')
  assert.equal(record.uploadedAt, '')
  assert.ok(record.uploading !== true, '提前返回时不得留下 uploading 标记')
})

test('a case with nothing to deliver is reported as an error without stamping the record', async () => {
  const ctx = makeCtx()
  const { maybeAutoUpload } = await import(new URL('src/host/oss/auto.ts', ROOT).href)
  const record = { ...normalizeAudit('k', {}), key: SEQ, casePath: `/cases/${SEQ}` }
  // 这个 ctx 的 listDir 会给出交付件；换成 EmptyList 来模拟「案例目录还没有交付件」。
  const emptyCtx = {
    get(name) {
      const base = ctx.get(name)
      if (name !== 'fs' || base === undefined) return base
      return { ...base, async listDir() { return [{ type: 'directory', name: '材料-源2026', target: { targetKey: 'm' } }] } }
    },
  }
  const out = await maybeAutoUpload({ ...depsOf(emptyCtx, {}), ctx: emptyCtx }, record)
  assert.equal(out.ok, false)
  assert.match(out.error, /还没有交付件/)
  assert.equal(record.uploadError, '', '「还没有交付件」同样不是上传失败')
  assert.ok(record.uploading !== true)
})
