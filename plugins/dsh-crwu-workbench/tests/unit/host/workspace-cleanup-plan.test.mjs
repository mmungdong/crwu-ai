/**
 * 清理计划：指纹与租约。
 *
 * 指纹只覆盖「会删哪些顶层项、哪些会话」：
 * - 不含目录大小（统计受预算影响，会让"什么都没变"偶发拒绝）；
 * - 不含会话运行状态（用户犹豫几秒就变，执行时以实时列表决定 stopActivity）。
 *
 * 租约是安全边界的一半：计划单次使用、有 TTL、同一时刻只允许一份执行。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { createPlanStore, fingerprint } = await import(
  new URL('src/host/domains/workspace-cleanup/plan.ts', ROOT).href)

const entry = (name, mtimeMs = 1) => ({ name, kind: 'directory', sizeBytes: 0, mtimeMs })
const plan = (id = 'p1') => ({
  planId: id, digest: 'd', expiresAt: 0,
  identity: { id: 'w', path: '/w', realPath: '/w', name: 'w' },
  entries: [entry('a')], sessions: [], totals: {}, notes: [],
})

test('单次使用：第二次 take 返回 used', () => {
  let time = 1_000
  const store = createPlanStore({ now: () => time, id: () => 'p1' })
  store.put(plan())
  assert.equal(store.take('p1').ok, true)
  time += 1
  assert.deepEqual(store.take('p1'), { ok: false, reason: 'used' })
})

test('过期返回 expired 并移除', () => {
  let time = 0
  const store = createPlanStore({ now: () => time, ttlMs: 100, id: () => 'p1' })
  store.put(plan())
  time = 101
  assert.deepEqual(store.take('p1'), { ok: false, reason: 'expired' })
  assert.deepEqual(store.take('p1'), { ok: false, reason: 'unknown' })
})

test('锁：同一次只允许一份执行', () => {
  const store = createPlanStore()
  assert.equal(store.acquire(), true)
  assert.equal(store.acquire(), false)
  assert.equal(store.busy(), true)
  store.release()
  assert.equal(store.busy(), false)
})

test('指纹：只随"哪些顶层项/会话"变化；大小与 mtime 都不算', () => {
  const base = fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 1)], sessionIds: ['s1'] })
  assert.equal(fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 1)], sessionIds: ['s1'] }), base)
  assert.equal(fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 2)], sessionIds: ['s1'] }), base,
    '目录 mtime 会因子目录内部写入而变化，不能让它把计划打回重扫')
  assert.notEqual(fingerprint({ workspaceRealPath: '/w', entries: [entry('b', 1)], sessionIds: ['s1'] }), base)
  assert.notEqual(fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 1)], sessionIds: ['s1', 's2'] }), base)
  assert.equal(fingerprint({
    workspaceRealPath: '/w',
    entries: [{ name: 'a', kind: 'directory', sizeBytes: 999, mtimeMs: 1 }],
    sessionIds: ['s1'],
  }), base)
})
