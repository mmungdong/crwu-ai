import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 案例目录门禁（`host/tools/case-dir.ts`）。
 *
 * 这是审核链路唯一一道「模型给的路径能不能用」的边界，所以判据必须自己站得住：
 * `requireCaseDir` 只接受**绝对**路径，`requireInsideCase` 只接受案例目录内的相对路径。
 *
 * 2026-09-28 复查发现的回归：`isAbsoluteLocalPath` 复用了「Windows 风格」的判断，
 * 而风格判断为了兼容 `C:` 这种写法接受了**裸盘符** —— 于是 `C:`（盘符相对路径，
 * 指向「这个盘上的当前目录」）被当成绝对路径放行，案例目录会随进程 cwd 漂移。
 */
const ROOT = new URL('../../', import.meta.url)
const { requireCaseDir, requireInsideCase } = await import(new URL('src/host/tools/case-dir.ts', ROOT).href)

/** 一个只认识给定目录的 fs 替身。 */
function ctxWith(dirs = []) {
  const set = new Set(dirs)
  return {
    get(name) {
      if (name !== 'fs') return undefined
      return {
        async resolve(path, opts) {
          const base = opts?.cwd ?? ''
          // 绝对 = POSIX 根 / 盘符根 / UNC（与实现同一判据）。
          const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
          const full = absolute ? path : `${String(base).replace(/[\\/]+$/, '')}/${path}`
          return { targetKey: full, displayPath: full }
        },
        async stat(target) {
          return set.has(target.targetKey) ? { type: 'directory', version: 'v' } : undefined
        },
        // 包含判断交给 fs（实现不做字符串前缀比较）。
        contains(parent, child) {
          const p = String(parent.displayPath).replace(/[\\/]+$/, '')
          const c = String(child.displayPath)
          return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
        },
      }
    },
  }
}

test('requireCaseDir 只接受绝对路径：裸盘符、相对路径、空串一律拒绝', async () => {
  // **裸 `C:` 不是绝对路径**：它是「盘符相对路径」，指向该盘上的当前目录。
  // 接受它就等于接受一条随进程 cwd 变化的案例目录 —— 产物落点不可预测。
  for (const bad of ['C:', 'c:', 'work/S1', './S1', '../S1', 'S1', '']) {
    const result = await requireCaseDir(ctxWith([]), bad)
    assert.equal(result.ok, false, `必须拒绝：${JSON.stringify(bad)}`)
    assert.equal(result.errorKind, 'input')
    assert.match(result.error, /绝对路径|缺少案例目录/)
  }
})

test('requireCaseDir 拒绝含 .. 片段的路径（两种分隔符都查）', async () => {
  for (const bad of ['/work/../etc', 'C:\\work\\..\\etc', '\\\\server\\share\\..\\x']) {
    const result = await requireCaseDir(ctxWith([]), bad)
    assert.equal(result.ok, false, `必须拒绝：${bad}`)
    assert.match(result.error, /不能包含 \.\./)
  }
})

test('requireCaseDir 接受 POSIX 根、盘符根与 UNC，并按 fs 的事实回 displayPath', async () => {
  const dirs = ['/work/S1', 'C:\\Work\\S1', '\\\\server\\share\\S1']
  for (const good of dirs) {
    const result = await requireCaseDir(ctxWith(dirs), good)
    assert.equal(result.ok, true, `必须接受：${good}（${result.ok ? '' : result.error}）`)
    assert.equal(result.path, good)
  }
})

test('requireCaseDir 对不存在 / 不是目录的目标如实拒绝，不猜', async () => {
  const missing = await requireCaseDir(ctxWith([]), '/work/S1')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在或不是目录/)

  const file = { get: (name) => (name === 'fs' ? { resolve: async (p) => ({ targetKey: p, displayPath: p }), stat: async () => ({ type: 'file', version: 'v' }) } : undefined) }
  const asFile = await requireCaseDir(file, '/work/S1')
  assert.equal(asFile.ok, false)
  assert.match(asFile.error, /不存在或不是目录/)
})

test('requireInsideCase 只接受案例目录内的相对路径', async () => {
  const ctx = ctxWith(['/work/S1'])
  const ok = await requireInsideCase(ctx, '/work/S1', '材料-源/报告.pdf')
  assert.equal(ok.ok, true, ok.ok ? '' : ok.error)
  assert.match(ok.path, /材料-源\/报告\.pdf$/)

  for (const bad of ['/etc/passwd', 'C:\\Windows\\x', 'C:x', '\\\\server\\share\\x', '..', '../x', 'a/../b', '']) {
    const result = await requireInsideCase(ctx, '/work/S1', bad)
    assert.equal(result.ok, false, `必须拒绝：${JSON.stringify(bad)}`)
  }
})

test('requireInsideCase 用 fs.contains 而不是字符串前缀', async () => {
  // 前缀比较会把 `/work/S1-evil/x` 判成「在 /work/S1 之内」；fs.contains 不会。
  const ctx = ctxWith(['/work/S1'])
  const escaped = await requireInsideCase(ctx, '/work/S1', 'x.txt')
  assert.equal(escaped.ok, true)
  assert.equal(escaped.path.startsWith('/work/S1/'), true)

  const sibling = ctxWith(['/work/S1-evil'])
  const forged = await requireInsideCase(
    { get: () => ({ ...sibling.get('fs'), contains: () => false }) },
    '/work/S1',
    'x.txt',
  )
  assert.equal(forged.ok, false)
  assert.match(forged.error, /逃出了案例目录/)
})
