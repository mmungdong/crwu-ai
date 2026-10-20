/**
 * 归属会话的枚举与过滤（清空工作空间）。
 *
 * 判据只有一条：会话 `cwd` 落在 W 之内（含相等）。几件容易写错的事都在这里钉住：
 * 兄弟前缀（`/w2`）、Windows 大小写、空 cwd、子代理计数，以及控制器缺席时必须
 * **明确失败**而不是"当作没有会话"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { scanSessions } = await import(new URL('src/host/domains/workspace-cleanup/sessions.ts', ROOT).href)
const { cleanupSessionPort } = await import(
  new URL('src/host/domains/workspace-cleanup/session-port.ts', ROOT).href)

const WS = { id: 'w1', path: '/w', realPath: '/w', name: 'w' }
const row = (sessionId, cwd, extra = {}) => ({
  sessionId, cwd, running: false, agentAvailable: false,
  parentSessionId: '', updatedAt: 1, title: sessionId, ...extra,
})

test('只保留 cwd 在 W 之内（含相等），兄弟前缀不算', () => {
  const { sessions, totals } = scanSessions([
    row('a', '/w'), row('b', '/w/case-1'), row('c', '/w2/case'),
    row('d', '/w', { running: true }), row('e', '/w/case-1', { parentSessionId: 'a' }),
    row('f', ''),
  ], WS)
  assert.deepEqual(sessions.map((session) => session.sessionId), ['a', 'b', 'd', 'e'])
  assert.equal(totals.sessions, 4)
  assert.equal(totals.topLevelSessions, 3)
  assert.equal(totals.subagentSessions, 1)
  assert.equal(totals.runningSessions, 1)
})

test('W 是符号链接：cwd 记原路径或 realpath 都算归属', () => {
  const link = { id: 'w', path: '/link-w', realPath: '/real-w', name: 'link-w' }
  const { sessions } = scanSessions([row('a', '/link-w/case'), row('b', '/real-w/case')], link)
  assert.deepEqual(sessions.map((session) => session.sessionId), ['a', 'b'])
})

test('Windows 大小写不敏感', () => {
  const win = { id: 'w', path: 'C:\\Work', realPath: 'C:\\Work', name: 'Work' }
  const { sessions } = scanSessions([row('a', 'c:\\work\\case')], win)
  assert.equal(sessions.length, 1)
})

test('缺少会话控制器时给出明确失败', () => {
  const out = cleanupSessionPort({ get: () => undefined })
  assert.equal(out.ok, false)
  assert.match(out.error, /会话/)
})

test('翻页直到没有 cursor，并归一化标题与缺省字段', async () => {
  const pages = [
    { items: [{ sessionId: 's1', cwd: '/w', parentSessionId: undefined,
      projections: { values: { title: '标题' } } }], cursor: 'next' },
    { items: [{ sessionId: 's2', cwd: '/w' }] },
  ]
  let calls = 0
  const sessionController = { list: async () => pages[calls++] }
  const workspaceController = { archiveSession: async () => ({ archivedSessionIds: ['s1'] }) }
  const out = cleanupSessionPort({
    get: (name) => name === 'sessionController' ? sessionController
      : name === 'workspaceController' ? workspaceController : undefined,
  })
  assert.equal(out.ok, true)
  const rows = await out.port.list()
  assert.deepEqual(rows.map((entry) => entry.sessionId), ['s1', 's2'])
  assert.equal(rows[0].title, '标题')
  assert.equal(rows[1].title, 's2')
  assert.deepEqual(await out.port.archive({ sessionId: 's1', stopActivity: true }), ['s1'])
})
