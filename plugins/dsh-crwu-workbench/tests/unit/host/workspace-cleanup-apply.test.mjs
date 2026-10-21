/**
 * 清理编排：顺序、失败继续、剩余回读。
 *
 * 顺序不是审美：归档 → 关存储 → 删日志 → 删子项 → 清插件状态。前一步没成立就不许
 * 进入下一步；单条子项失败只影响自己，但结果必须是 `partial`，绝不能报 `completed`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { applyCleanup } = await import(new URL('src/host/domains/workspace-cleanup/apply.ts', ROOT).href)
const { memoryCleanupIo } = await import(new URL('tests/helpers/workspace-cleanup-fixture.mjs', ROOT).href)

function harness(options = {}) {
  const calls = []
  const base = memoryCleanupIo(options.nodes ?? [
    { path: '/w/a', kind: 'dir' }, { path: '/w/a/x', kind: 'file', size: 1 },
  ])
  const io = {
    ...base,
    async removeTree(path) { calls.push(`removeTree ${path}`); return base.removeTree(path) },
    async unlink(path) { calls.push(`unlink ${path}`); return base.unlink(path) },
  }
  const deps = {
    io,
    port: {
      async list() { return options.rows ?? [] },
      async archive(input) { calls.push(`archive ${input.sessionId}`); return [input.sessionId] },
    },
    home: '/Users/x',
    async closeWorkflowStores(path) { calls.push(`close ${path}`) },
    clearAudits() { calls.push('clearAudits') },
    async persistAudits() { calls.push('persistAudits'); return true },
    reauthorize: () => ({ ok: true, error: '' }),
    now: () => 0,
    sleep: async () => {},
    waitMs: 5,
    pollMs: 1,
  }
  return { deps, io, calls, base }
}

const plan = (entries) => ({
  planId: 'p', digest: 'd', expiresAt: 1,
  identity: { id: 'w', path: '/w', realPath: '/w', name: 'w' },
  entries, sessions: [], totals: {}, notes: [],
})

test('顺序：关闭存储 → 删子项 → 清状态', async () => {
  const { deps, calls } = harness()
  const out = await applyCleanup(deps, {
    plan: plan([{ name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 }]),
    deleteSessionLogs: false,
  })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'completed')
  assert.deepEqual(calls.filter((line) => /close|removeTree|clearAudits|persistAudits/.test(line)), [
    'close /w', 'removeTree /w/a', 'clearAudits', 'persistAudits',
  ])
})

test('单条失败继续，结果 partial 且 remaining 准确', async () => {
  const { deps, io } = harness({ nodes: [
    { path: '/w/a', kind: 'dir' }, { path: '/w/a/x', kind: 'file', size: 1 },
    { path: '/w/f', kind: 'file', size: 2 },
  ] })
  const original = io.removeTree
  io.removeTree = async (path) => {
    if (path.endsWith('/a')) throw new Error('busy')
    return original(path)
  }
  const out = await applyCleanup(deps, {
    plan: plan([
      { name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 },
      { name: 'f', kind: 'file', sizeBytes: 2, mtimeMs: 1 },
    ]),
    deleteSessionLogs: false,
  })
  assert.equal(out.status, 'partial')
  assert.equal(out.ok, false)
  assert.equal(out.deleted.files, 1)
  assert.deepEqual(out.remainingNames, ['a'])
  assert.equal(out.failures[0].kind, 'entry')
})

test('会话停不下来：aborted，且零文件删除', async () => {
  const { deps, calls } = harness({ rows: [{
    sessionId: 's1', cwd: '/w', running: true, agentAvailable: true,
    parentSessionId: '', updatedAt: 1, title: 's1',
  }] })
  const out = await applyCleanup(deps, {
    plan: { ...plan([{ name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 }]),
      sessions: [{ sessionId: 's1', title: 's1', running: true, agentAvailable: true,
        parentSessionId: '', updatedAt: 1 }] },
    deleteSessionLogs: false,
  })
  assert.equal(out.status, 'aborted')
  assert.deepEqual(out.stuckSessionIds, ['s1'])
  assert.deepEqual(calls.filter((line) => line.startsWith('removeTree')), [])
  assert.equal(out.remaining, 1, '中止也要回读真实剩余')
  assert.deepEqual(out.remainingNames, ['a'])
})

test('状态写盘失败 → partial，不报 completed', async () => {
  const { deps } = harness()
  deps.persistAudits = async () => false
  const out = await applyCleanup(deps, { plan: plan([]), deleteSessionLogs: false })
  assert.equal(out.status, 'partial')
  assert.equal(out.failures.some((failure) => failure.kind === 'state'), true)
})

test('归档期间授权被撤回 → aborted，零删除', async () => {
  const { deps, calls } = harness({ rows: [{
    sessionId: 's1', cwd: '/w', running: false, agentAvailable: true,
    parentSessionId: '', updatedAt: 1, title: 's1',
  }] })
  let allowed = true
  deps.reauthorize = () => (allowed ? { ok: true, error: '' } : { ok: false, error: '授权已撤回' })
  const originalArchive = deps.port.archive
  // 归档是确认之后最长的一段等待：撤回就发生在这段时间里。
  deps.port.archive = async (input) => { allowed = false; return originalArchive(input) }

  const out = await applyCleanup(deps, {
    plan: { ...plan([{ name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 }]),
      sessions: [{ sessionId: 's1', title: 's1', running: false, agentAvailable: true,
        parentSessionId: '', updatedAt: 1 }] },
    deleteSessionLogs: false,
  })
  assert.equal(out.status, 'aborted')
  assert.equal(out.errorKind, 'policy')
  assert.deepEqual(calls.filter((line) => line.startsWith('removeTree')), [])
})

test('删除途中工作空间真实路径变了 → 立即停止，剩余条目一律不删', async () => {
  const { deps, io } = harness({ nodes: [
    { path: '/w/a', kind: 'dir' }, { path: '/w/b', kind: 'dir' },
  ] })
  let flipped = false
  const originalRealpath = io.realpath
  const originalRemove = io.removeTree
  io.realpath = async (path) => (flipped && path === '/w' ? '/elsewhere' : originalRealpath(path))
  io.removeTree = async (path) => { flipped = true; return originalRemove(path) }

  const out = await applyCleanup(deps, {
    plan: plan([
      { name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 },
      { name: 'b', kind: 'directory', sizeBytes: 1, mtimeMs: 1 },
    ]),
    deleteSessionLogs: false,
  })
  assert.equal(out.status, 'partial')
  assert.equal(out.deleted.folders, 1, '第一项是在换链之前删的')
  assert.deepEqual(out.remainingNames, ['b'], '换链之后必须停手，不能跟着新路径删下去')
  assert.equal(out.failures.some((failure) => /真实路径/.test(failure.reason)), true)
})

test('删除后回读失败 → partial，不能报 completed', async () => {
  const { deps, io } = harness()
  io.readdir = async () => { throw new Error('EACCES') }

  const out = await applyCleanup(deps, {
    plan: plan([{ name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 }]),
    deleteSessionLogs: false,
  })
  assert.notEqual(out.status, 'completed')
  assert.equal(out.ok, false, '读不到剩余项就不能宣布清空成功')
  assert.equal(out.failures.length > 0, true, '回读失败必须登记，不能悄悄当成 0 剩余')
})
