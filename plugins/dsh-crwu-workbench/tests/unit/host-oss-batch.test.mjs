import assert from 'node:assert/strict'
import test from 'node:test'
import { createOssBatchQueue } from '../../src/host/oss/batch.ts'
import { makeTestAccess } from '../helpers/local-access-broker-fixture.mjs'
import { manifestFixture } from '../helpers/manifest-fixture.mjs'

const SEQ = '2026-301705-LX10170'
const OTHER = '2026-301705-LX10171'
const listing = (seq) => [
  `2026-10-09 12:00:00 +0800 CST 42 Standard 1234567890ABCDEF oss://bkt/crwu/audit/${seq}/审核结果.${seq}.json`,
  'Object Number is: 1',
].join('\n')

function fixture(read = (seq) => ({ stdout: listing(seq) }), options = {}) {
  const commands = []
  let resolutions = 0
  const ctx = {
    get(name) {
      if (name === 'fs') return {
        resolve: async (path) => ({ targetKey: path, displayPath: path }),
        stat: async () => ({ type: 'file' }),
      }
      if (name === 'shell') return {
        resolve: (spec) => spec,
        async execute(spec) {
          commands.push(spec)
          const seq = spec.command.match(/audit\/([^/]+)\//)?.[1] ?? ''
          const out = await read(seq, spec.signal)
          return { result: async () => ({
            exitCode: out.exitCode ?? 0, timedOut: false, aborted: false,
            stdout: { text: out.stdout ?? '', truncated: out.truncated ?? false },
            stderr: { text: out.stderr ?? '', truncated: false },
          }) }
        },
      }
    },
  }
  const deps = {
    ctx, access: makeTestAccess(ctx, { home: '/Users/x' }).access,
    source: 'panel', platform: 'darwin-arm64', home: '/Users/x', workdir: async () => '/cases',
    manifest: manifestFixture({ oss: { enabled: true, bucket: 'bkt', prefix: 'crwu/audit' } }),
  }
  const queue = createOssBatchQueue(async () => { resolutions++; return deps }, options)
  return { queue, commands, resolutions: () => resolutions }
}

test('batch rejects invalid inputs before resolving dependencies and empty input performs zero I/O', async () => {
  const f = fixture()
  for (const args of [{}, { seqNos: null }, { seqNos: 'x' }, { seqNos: [SEQ, 1] },
    { seqNos: ['../x'] }, { seqNos: Array(101).fill(SEQ) }, { seqNos: [SEQ], seqNo: SEQ }]) {
    assert.equal((await f.queue.run(args)).ok, false)
  }
  assert.deepEqual(await f.queue.run({ seqNos: [] }), { ok: true, error: '', results: {} })
  assert.equal(f.resolutions(), 0)
  assert.equal(f.commands.length, 0)
  f.queue.dispose()
})

test('batch deduplicates serials, lists exact directories and preserves JSON-only metadata', async () => {
  const f = fixture()
  const out = await f.queue.run({ seqNos: [SEQ, ` ${SEQ} `, OTHER] })
  assert.equal(out.ok, true)
  assert.deepEqual(Object.keys(out.results), [SEQ, OTHER])
  assert.equal(f.resolutions(), 1)
  assert.equal(f.commands.length, 2)
  assert.equal(out.results[SEQ].item.htmlKey, '')
  assert.equal(out.results[SEQ].item.files[0].size, 42)
  assert.equal(out.results[SEQ].item.files[0].etag, '1234567890abcdef')
  for (const command of f.commands) {
    assert.match(command.command, /oss:\/\/bkt\/crwu\/audit\/2026-301705-LX1017[01]\//)
    assert.equal(command.command.includes('--short-format'), false)
  }
  f.queue.dispose()
})

test('batch separates absent results, failed commands, truncation and invalid/wrong-serial output', async () => {
  for (const [raw, kind] of [
    [{ exitCode: 1, stderr: 'network failure' }, 'command'],
    [{ stdout: listing(SEQ), truncated: true }, 'truncated'],
    [{ stdout: 'unexpected output' }, 'invalid-result'],
    [{ stdout: listing(SEQ).split('\n')[0] }, 'invalid-result'],
    [{ stdout: `2026-10-09 12:00:00 malformed oss://bkt/crwu/audit/${SEQ}/审核结果.${SEQ}.json\nObject Number is: 0` }, 'invalid-result'],
    [{ stdout: listing(OTHER) }, 'invalid-result'],
    [{ stdout: `oss://other/crwu/audit/${SEQ}/审核结果.${SEQ}.json\nObject Number is: 1` }, 'invalid-result'],
  ]) {
    const f = fixture((seq) => seq === SEQ ? raw : { stdout: listing(OTHER) })
    const out = await f.queue.run({ seqNos: [SEQ, OTHER] })
    assert.equal(out.ok, true)
    assert.equal(out.results[SEQ].errorKind, kind)
    assert.equal(out.results[OTHER].ok, true)
    f.queue.dispose()
  }
  const f = fixture(() => ({ stdout: 'Object Number is: 0' }))
  assert.deepEqual((await f.queue.run({ seqNos: [SEQ] })).results[SEQ], { ok: true, error: '', item: null })
  f.queue.dispose()
})

test('batch deadline includes dependency resolution before any command starts', async () => {
  let resolved = false
  const queue = createOssBatchQueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
    resolved = true
    throw Error('private configuration error')
  }, { deadlineMs: 10 })
  const out = await queue.run({ seqNos: [SEQ] })
  assert.equal(resolved, false)
  assert.equal(out.results[SEQ].errorKind, 'timeout')
  queue.dispose()
})

test('concurrent batches share a ceiling of three directory reads', async () => {
  let active = 0
  let peak = 0
  const f = fixture(async (seq) => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return { stdout: listing(seq) }
  })
  await Promise.all(Array.from({ length: 4 }, () => f.queue.run({ seqNos: [SEQ, OTHER] })))
  assert.equal(peak, 3)
  f.queue.dispose()
})

test('deadline and cancellation reach the runner and prevent queued reads from starting', async () => {
  const f = fixture(async (_seq, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return { exitCode: 1 }
  }, { deadlineMs: 15 })
  const seqs = Array.from({ length: 5 }, (_, i) => `2026-301705-LX${i}`)
  const out = await f.queue.run({ seqNos: seqs })
  assert.equal(f.commands.length, 3)
  assert.ok(Object.values(out.results).every((item) => item.errorKind === 'timeout'))
  assert.ok(f.commands.every((spec) => spec.signal.aborted))
  f.queue.dispose()

  const g = fixture(async (_seq, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return { exitCode: 1 }
  })
  const controller = new AbortController()
  const pending = g.queue.run({ seqNos: seqs }, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  const cancelled = await pending
  assert.ok(Object.values(cancelled.results).every((item) => item.errorKind === 'cancelled'))
  assert.equal(g.commands.length, 3)
  g.queue.dispose()
})
