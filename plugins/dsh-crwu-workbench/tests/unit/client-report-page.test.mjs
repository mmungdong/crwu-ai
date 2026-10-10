import assert from 'node:assert/strict'
import test from 'node:test'
import { createReportPageLoader } from '../../src/client/features/report-audit/page-loader.ts'

const A = '2026-301705-LX10170'
const B = '2026-301705-LX10171'
const task = (seqNo, id = seqNo) => ({ seqNo, id, name: seqNo })
const page = (rows, patch = {}) => ({ ok: true, error: '', rows, page: 2, size: 20, total: 80, query: 'LX', ...patch })
const batch = (seqs) => ({ ok: true, error: '', results: Object.fromEntries(seqs.map((seq) => [seq, { ok: true, error: '', item: null }])) })
const deferred = () => { let resolve; return { promise: new Promise((r) => { resolve = r }), resolve: (v) => resolve(v) } }

test('page rows determine one deduplicated batch; invalid serials stay visible and empty pages skip OSS', async () => {
  const calls = []
  const loader = createReportPageLoader({
    pending: async (args) => { calls.push(['pending', args]); return page([task(A), task(A, 'duplicate'), task(''), task('../unsafe'), task(B)]) },
    ossBatchIndex: async ({ seqNos }) => { calls.push(['oss', seqNos]); return batch(seqNos) },
  })
  await loader.load({ query: 'LX', page: 2, size: 20 })
  assert.deepEqual(calls, [['pending', { query: 'LX', page: 2, size: 20 }], ['oss', [A, B]]])
  assert.equal(loader.get().pending.rows.length, 5)
  assert.equal(loader.get().remote[A].status, 'ready')
  assert.equal(loader.get().remote[''].status, 'invalid')
  assert.equal(loader.get().remote['../unsafe'].status, 'invalid')
  const empty = createReportPageLoader({ pending: async () => page([]), ossBatchIndex: async () => { throw Error('must not call') } })
  await empty.load()
  assert.equal(empty.get().ossLoading, false)
  assert.deepEqual(empty.get().remote, {})
})

test('pending failure preserves the adopted page as stale, skips OSS and retains requested context separately', async () => {
  let fail = false
  let batches = 0
  const loader = createReportPageLoader({ pending: async () => fail ? page([], { ok: false, error: 'read failed', page: 3 }) : page([task(A)]),
    ossBatchIndex: async ({ seqNos }) => { batches++; return batch(seqNos) } })
  await loader.load({ query: 'LX', page: 2, size: 20 })
  fail = true
  await loader.load({ query: 'LX', page: 3, size: 20 })
  assert.equal(loader.get().pending.page, 2)
  assert.equal(loader.get().target.page, 3)
  assert.equal(loader.get().stale, true)
  assert.equal(loader.get().pageError, 'read failed')
  assert.equal(batches, 1)
})

test('new pages cancel older work and discard late responses from both request stages', async () => {
  const oldPage = deferred()
  const oldBatch = deferred()
  const signals = []
  const loader = createReportPageLoader({
    pending: (args, options) => { signals.push(options.signal); return args.page === 1 ? oldPage.promise : Promise.resolve(page([task(B)], { page: args.page })) },
    ossBatchIndex: ({ seqNos }) => seqNos[0] === B ? oldBatch.promise : Promise.resolve(batch(seqNos)),
  })
  const first = loader.load({ query: '', page: 1, size: 20 })
  const second = loader.load({ query: '', page: 2, size: 20 })
  await new Promise((r) => setImmediate(r))
  assert.equal(signals[0].aborted, true)
  const third = loader.load({ query: '', page: 3, size: 20 })
  oldPage.resolve(page([task(A)], { page: 1 }))
  oldBatch.resolve(batch([B]))
  await Promise.all([first, second, third])
  assert.equal(loader.get().pending.page, 3)
  assert.equal(loader.get().remote[A], undefined)
})

test('partial and top-level failures are explicit; single-row retries neither refetch pending nor touch other rows', async () => {
  const calls = []
  let count = 0
  const loader = createReportPageLoader({ pending: async () => { calls.push('pending'); return page([task(A), task(B)]) },
    ossBatchIndex: async ({ seqNos }) => { calls.push(seqNos); return ++count === 1 ? { ok: true, error: '', results: { [A]: { ok: false, error: 'denied', errorKind: 'access', item: null }, [B]: { ok: true, error: '', item: null } } } : batch(seqNos) } })
  await loader.load()
  assert.equal(loader.get().remote[A].status, 'failed')
  const other = loader.get().remote[B]
  await loader.retry(A)
  assert.deepEqual(calls, ['pending', [A, B], [A]])
  assert.equal(loader.get().remote[A].status, 'ready')
  assert.equal(loader.get().remote[B], other)
  loader.cancel()
  assert.equal(loader.get().ossLoading, false)
})

test('mismatched or missing batch entries cannot become absence; changing pages invalidates pending row retries', async () => {
  const retry = deferred()
  let count = 0
  const loader = createReportPageLoader({ pending: async (args) => page([task(args.page === 3 ? B : A)], { page: args.page }),
    ossBatchIndex: async ({ seqNos }) => ++count === 2 ? retry.promise : { ok: true, error: '', results: {} } })
  await loader.load()
  assert.equal(loader.get().remote[A].status, 'failed')
  const outstanding = loader.retry(A)
  await loader.load({ query: '', page: 3, size: 20 })
  retry.resolve(batch([A]))
  await outstanding
  assert.equal(loader.get().remote[A], undefined)
  assert.equal(loader.get().remote[B].status, 'failed')
})

test('upload refresh during a page batch suppresses the old row result and queries again after that batch', async () => {
  const old = deferred()
  const fresh = deferred()
  const calls = []
  const loader = createReportPageLoader({ pending: async () => page([task(A), task(B)]),
    ossBatchIndex: ({ seqNos }) => { calls.push(seqNos); return calls.length === 1 ? old.promise : fresh.promise } })
  const loading = loader.load()
  await new Promise((r) => setImmediate(r))
  const retry = loader.retry(A)
  const refresh = loader.refresh(A)
  assert.deepEqual(calls, [[A, B]])
  old.resolve(batch([A, B]))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, [[A, B], [A]])
  assert.equal(loader.get().remote[A].status, 'loading')
  assert.equal(loader.get().remote[B].status, 'ready')
  fresh.resolve({ ok: false, error: 'fresh failed', results: {} })
  await Promise.all([loading, retry, refresh])
  assert.equal(loader.get().remote[A].status, 'failed')
})

test('trimmed-only serial aliases stay loading during queued upload refresh and share the final row result', async () => {
  const old = deferred()
  const fresh = deferred()
  let count = 0
  const raw = ` ${A} `
  const loader = createReportPageLoader({ pending: async () => page([task(raw)]),
    ossBatchIndex: async ({ seqNos }) => ++count === 1 ? old.promise : fresh.promise })
  const loading = loader.load()
  await new Promise((r) => setImmediate(r))
  const refresh = loader.refresh(raw)
  old.resolve(batch([A]))
  await new Promise((r) => setImmediate(r))
  assert.equal(loader.get().remote[raw].status, 'loading')
  fresh.resolve(batch([A]))
  await Promise.all([loading, refresh])
  assert.equal(loader.get().remote[raw].status, 'ready')
})

test('single-row success preserves a batch-wide error while other rows still fail', async () => {
  let count = 0
  const loader = createReportPageLoader({ pending: async () => page([task(A), task(B)]),
    ossBatchIndex: async ({ seqNos }) => ++count === 1 ? { ok: false, error: 'OSS 未配置', results: {} } : batch(seqNos) })
  await loader.load()
  await loader.retry(A)
  assert.equal(loader.get().remote[A].status, 'ready')
  assert.equal(loader.get().remote[B].status, 'failed')
  assert.equal(loader.get().ossError, 'OSS 未配置')
})

test('upload during an active row retry coalesces a fresh read and never publishes the older result', async () => {
  const old = deferred()
  const fresh = deferred()
  const calls = []
  const loader = createReportPageLoader({ pending: async () => page([task(A), task(B)]),
    ossBatchIndex: ({ seqNos }) => {
      calls.push(seqNos)
      return calls.length === 1 ? Promise.resolve(batch(seqNos)) : calls.length === 2 ? old.promise : fresh.promise
    } })
  await loader.load()
  const retry = loader.retry(A)
  const firstUpload = loader.refresh(A)
  const secondUpload = loader.refresh(A)
  old.resolve(batch([A]))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, [[A, B], [A], [A]])
  assert.equal(loader.get().remote[A].status, 'loading')
  assert.equal(loader.get().remote[B].status, 'ready')
  fresh.resolve({ ok: true, error: '', results: { [A]: { ok: false, item: null, error: 'fresh denied', errorKind: 'access' } } })
  await Promise.all([retry, firstUpload, secondUpload])
  assert.equal(loader.get().remote[A].status, 'failed')
  assert.equal(loader.get().remote[A].error, 'fresh denied')
})
