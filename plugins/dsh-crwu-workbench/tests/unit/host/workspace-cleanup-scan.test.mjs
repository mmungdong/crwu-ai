/**
 * 直接子项扫描。
 *
 * 三条判据：
 * 1. **只扫一层**：W 的孙子项不单独成项，但目录的递归大小要把它们算进去；
 * 2. 符号链接按"一个项"统计，大小为 0、不跟随目标；
 * 3. 递归大小有**条目预算**，超了要如实标 `bytesComplete=false`，不能假装数完了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { scanEntries } = await import(new URL('src/host/domains/workspace-cleanup/scan.ts', ROOT).href)
const { memoryCleanupIo } = await import(new URL('tests/helpers/workspace-cleanup-fixture.mjs', ROOT).href)

const WS = { id: 'w1', path: '/w', realPath: '/w', name: 'w' }

test('计数、递归大小与排序', async () => {
  const io = memoryCleanupIo([
    { path: '/w/b', kind: 'dir', mtimeMs: 2 },
    { path: '/w/b/x', kind: 'file', size: 10 },
    { path: '/w/b/nested', kind: 'dir' },
    { path: '/w/b/nested/y', kind: 'file', size: 5 },
    { path: '/w/a', kind: 'file', size: 3, mtimeMs: 1 },
    { path: '/w/link', kind: 'symlink', mtimeMs: 3 },
  ])
  const { entries, totals } = await scanEntries(io, WS)
  assert.deepEqual(entries.map((entry) => entry.name), ['a', 'b', 'link'])
  assert.equal(entries.find((entry) => entry.name === 'b').kind, 'directory')
  assert.equal(entries.find((entry) => entry.name === 'b').sizeBytes, 15)
  assert.equal(entries.find((entry) => entry.name === 'link').sizeBytes, 0)
  assert.equal(totals.folders, 1)
  assert.equal(totals.files, 1)
  assert.equal(totals.symlinks, 1)
  assert.equal(totals.other, 0)
  assert.equal(totals.bytes, 18)
  assert.equal(totals.bytesComplete, true)
})

test('超过 50,000 项预算时停止并标记不完整', async () => {
  const nodes = [{ path: '/w/big', kind: 'dir' }]
  for (let index = 0; index < 50_001; index += 1) {
    nodes.push({ path: `/w/big/f${String(index)}`, kind: 'file', size: 1 })
  }
  const { totals } = await scanEntries(memoryCleanupIo(nodes), WS)
  assert.equal(totals.bytesComplete, false)
  assert.equal(totals.bytes, 50_000)
})

test('空目录给出零计数且不抛错', async () => {
  const { entries, totals } = await scanEntries(memoryCleanupIo([{ path: '/w', kind: 'dir' }]), WS)
  assert.deepEqual(entries, [])
  assert.equal(totals.folders, 0)
  assert.equal(totals.bytes, 0)
  assert.equal(totals.bytesComplete, true)
})
