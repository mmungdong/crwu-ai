/**
 * 关闭估值工作流存储连接（删 `.crwu` 之前）。
 *
 * 为什么必须有这一步：`workflows.sqlite` 由 Host 内的 `node:sqlite` 打开并缓存，
 * Windows 上文件被占用时整条删除会失败。判据按 **store 路径**，不是按工作区 id ——
 * 同一个工作区可以有多个 store 路径（历史目录），也要一起关。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { closeStoresUnder } = await import(
  new URL('src/host/integrations/valuation-workflow/store-registry.ts', ROOT).href)

test('只关闭 store 路径落在 W 之下的会话，并清两处集合', async () => {
  const closed = []
  const inside = { close: async () => { closed.push('inside') } }
  const outside = { close: async () => { closed.push('outside') } }
  const sessions = new Map([
    ['w\u0000/w/.crwu', Promise.resolve(inside)],
    ['w\u0000/w2/.crwu', Promise.resolve(outside)],
  ])
  const opened = new Set([inside, outside])
  const keys = await closeStoresUnder(sessions, opened, '/w')
  assert.deepEqual(keys, ['w\u0000/w/.crwu'])
  assert.deepEqual(closed, ['inside'])
  assert.equal(sessions.size, 1)
  assert.equal(opened.has(inside), false)
  assert.equal(opened.has(outside), true)
})

test('close 抛错时保留句柄，下一次还能再试（Windows 文件占用就是这一类）', async () => {
  let attempts = 0
  const inside = { close: async () => { attempts += 1; throw new Error('busy') } }
  const sessions = new Map([['w\u0000/w/.crwu', Promise.resolve(inside)]])
  const opened = new Set([inside])
  const keys = await closeStoresUnder(sessions, opened, '/w')
  assert.deepEqual(keys, [])
  assert.equal(sessions.size, 1, '关不掉就留在缓存里，别让句柄丢失')
  assert.equal(opened.size, 1)
  await closeStoresUnder(sessions, opened, '/w')
  assert.equal(attempts, 2, '第二次必须还能重试')
})
