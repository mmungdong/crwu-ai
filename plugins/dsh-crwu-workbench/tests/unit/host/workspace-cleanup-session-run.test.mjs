/**
 * 会话侧的两个动作：先停并归档、再（可选）删日志。
 *
 * 这一层的安全语义只有一条：**没有确认静止，就不许往下删文件**。
 * 归档失败、列表读不出来、30 秒还没停 —— 三种情况都必须返回 `ok:false`，
 * 让编排层在碰文件之前中止。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { stopAndArchive, removeSessionLogs } = await import(
  new URL('src/host/domains/workspace-cleanup/session-run.ts', ROOT).href)

const session = (sessionId, extra = {}) => ({
  sessionId, title: sessionId, running: true, agentAvailable: true,
  parentSessionId: '', updatedAt: 1, ...extra,
})

function depsWith(sequence, options = {}) {
  const archives = []
  const removals = []
  let index = 0
  return {
    archives, removals,
    port: {
      async list() {
        const rows = sequence[Math.min(index, sequence.length - 1)]
        index += 1
        if (options.listError === true) throw new Error('list failed')
        return rows
      },
      async archive(input) {
        archives.push(input)
        if (options.archiveError === true) throw new Error('archive failed')
        return [input.sessionId]
      },
    },
    io: {
      async readdir(path) { return options.dirs?.[path] ?? [] },
      async lstat(path) { return options.stats?.[path] },
      async stat(path) { return options.stats?.[path] },
      async realpath(path) { return path },
      async removeTree(path) { removals.push(path) },
      async unlink(path) { removals.push(path) },
    },
    home: '/Users/x',
    now: options.now ?? (() => 0),
    sleep: async () => {},
    waitMs: options.waitMs ?? 50,
    pollMs: 1,
  }
}

const dir = (name) => ({ name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false })
const statsDir = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, size: 0, mtimeMs: 1 }

test('运行中的顶层会话带 stopActivity 归档；子代理不单独归档', async () => {
  const idle = (ids) => ids.map((id) => session(id, { running: false, agentAvailable: false }))
  const deps = depsWith([[session('a'), session('b')], idle(['a', 'b'])])
  const out = await stopAndArchive(deps, [session('a'), session('b', { parentSessionId: 'a' })])
  assert.equal(out.ok, true)
  assert.deepEqual(deps.archives, [{ sessionId: 'a', stopActivity: true }])
})

test('已归档但 Agent 仍 attached（running=false）算静止，不能等到超时', async () => {
  const idleAgent = session('a', { running: false, agentAvailable: true })
  const deps = depsWith([[idleAgent], [idleAgent]])
  const out = await stopAndArchive(deps, [idleAgent])
  assert.equal(out.ok, true)
  assert.deepEqual(out.archivedSessionIds, ['a'])
})

test('会话一直不停：aborted、零文件删除', async () => {
  const deps = depsWith([[session('a')], [session('a')]], {
    waitMs: 3, now: (() => { let time = 0; return () => { time += 1; return time } })(),
  })
  const out = await stopAndArchive(deps, [session('a')])
  assert.equal(out.ok, false)
  assert.deepEqual(out.stuckSessionIds, ['a'])
  assert.deepEqual(deps.removals, [])
})

test('归档抛错：立即中止并记 session-archive 失败', async () => {
  const deps = depsWith([[session('a')]], { archiveError: true })
  const out = await stopAndArchive(deps, [session('a')])
  assert.equal(out.ok, false)
  assert.equal(out.failures[0].kind, 'session-archive')
  assert.deepEqual(deps.removals, [])
})

test('会话列表读不出来：中止，不猜“应该都停了”', async () => {
  const deps = depsWith([[]], { listError: true })
  const out = await stopAndArchive(deps, [session('a')])
  assert.equal(out.ok, false)
  assert.match(out.reason, /会话列表/)
})

test('日志定位：0/1/2 命中三分支，投影缓存一并清', async () => {
  const root = '/Users/x/.dsh/sessions'
  const cache = '/Users/x/.dsh/storages/session_projcache/sessions'
  const deps = depsWith([[]], {
    dirs: { [root]: [dir('slug-a'), dir('slug-b')] },
    stats: {
      [`${root}/slug-a/a`]: statsDir,
      [`${root}/slug-a/b`]: statsDir,
      [`${root}/slug-b/b`]: statsDir,
      [`${cache}/session-a.json`]: { ...statsDir, isDirectory: () => false, isFile: () => true },
    },
  })
  const out = await removeSessionLogs(deps, [session('a'), session('b'), session('missing')])
  assert.deepEqual(out.deletedSessionLogs, ['a'])
  assert.equal(out.skippedSessionLogs.find((row) => row.sessionId === 'b').reason.includes('多个目录'), true)
  assert.equal(out.skippedSessionLogs.find((row) => row.sessionId === 'missing').reason.includes('不存在'), true)
  assert.deepEqual(deps.removals.sort(), [`${root}/slug-a/a`, `${cache}/session-a.json`].sort(),
    '单命中删日志与缓存；多命中的 b 连缓存都不许动')
})
