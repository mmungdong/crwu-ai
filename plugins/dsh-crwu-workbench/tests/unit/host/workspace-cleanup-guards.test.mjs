/**
 * 工作空间边界守卫（清空工作空间）。
 *
 * 这一层的判据是**不可逆删除的最后一道闸**：
 * - 只接受绝对路径、真实存在的目录；
 * - 根、主目录、`~/.dsh`（双向）一律拒绝，避免"清空"变成清空用户家目录；
 * - 身份比较用 `realpath`，删除路径也用它 —— 扫描后 W 被换成另一个符号链接时，
 *   不能让删除跟着链接走。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { guardWorkspace, isDirectChild, isFilesystemRoot } = await import(
  new URL('src/host/domains/workspace-cleanup/guards.ts', ROOT).href)

const HOME = '/Users/x'

function depsOf(paths = {}) {
  return {
    async stat(path) {
      return Object.hasOwn(paths, path) ? { isDirectory: () => paths[path] === 'dir' } : undefined
    },
    async realpath(path) { return paths[`real:${path}`] ?? path },
  }
}

function input(path, home = HOME, deps = depsOf()) {
  return { workspace: { id: 'w1', path, title: 't' }, home, platform: 'darwin-arm64', deps }
}

test('正常目录通过，并使用 realpath 作为删除路径', async () => {
  const out = await guardWorkspace({
    ...input('/Users/x/work'),
    deps: depsOf({ '/Users/x/work': 'dir', 'real:/Users/x/work': '/private/Users/x/work' }),
  })
  assert.equal(out.ok, true)
  assert.equal(out.identity.realPath, '/private/Users/x/work')
  assert.equal(out.identity.path, '/Users/x/work')
  assert.equal(out.identity.name, 'work')
})

test('拒绝文件系统根、主目录与 ~/.dsh（含祖先与内部）', async () => {
  for (const path of ['/', '/Users/x', '/Users', '/Users/x/.dsh', '/Users/x/.dsh/profiles']) {
    const out = await guardWorkspace({ ...input(path), deps: depsOf({ [path]: 'dir' }) })
    assert.equal(out.ok, false, `${path} 必须被拒`)
  }
})

test('主目录是符号链接时，真实主目录、其祖先与 ~/.dsh 仍被拒绝', async () => {
  // macOS 常见形态：/Users/x 是指向 /Volumes/Data/x 的软链。只比原串时，
  // 真实路径那一侧的判据全部失配 —— 二次确认后删的是真实主目录。
  const deps = depsOf({
    '/Volumes/Data': 'dir',
    '/Volumes/Data/x': 'dir',
    '/Volumes/Data/x/.dsh': 'dir',
    '/Volumes/Data/x/work': 'dir',
    'real:/Users/x': '/Volumes/Data/x',
  })
  for (const path of ['/Volumes/Data/x', '/Volumes/Data', '/Volumes/Data/x/.dsh']) {
    const out = await guardWorkspace({ ...input(path, HOME, deps) })
    assert.equal(out.ok, false, `${path} 必须被拒（主目录真实路径是 /Volumes/Data/x）`)
  }
  // 反例：主目录内部的工作空间是正常用法，不能被这道判据连坐。
  const inside = await guardWorkspace({ ...input('/Volumes/Data/x/work', HOME, deps) })
  assert.equal(inside.ok, true, '主目录内的工作空间必须仍可清理')
})

test('Windows 盘符根、UNC 共享根与主目录祖先也被拒', async () => {
  assert.equal(isFilesystemRoot('C:\\'), true)
  assert.equal(isFilesystemRoot('C:'), true)
  assert.equal(isFilesystemRoot('\\\\server\\share\\'), true)
  assert.equal(isFilesystemRoot('C:\\Work'), false)
  const out = await guardWorkspace({
    ...input('C:\\Users', 'C:\\Users\\x', depsOf({ 'C:\\Users': 'dir' })),
    platform: 'win32-x64',
  })
  assert.equal(out.ok, false)
})

test('不存在 / 不是目录 / realpath 失败都拒绝', async () => {
  assert.equal((await guardWorkspace(input('/Users/x/missing'))).ok, false)
  const file = await guardWorkspace({ ...input('/Users/x/f'), deps: depsOf({ '/Users/x/f': 'file' }) })
  assert.equal(file.ok, false)
  const broken = {
    async stat() { return { isDirectory: () => true } },
    async realpath() { throw new Error('ENOENT') },
  }
  assert.equal((await guardWorkspace({ ...input('/Users/x/work'), deps: broken })).ok, false)
})

test('直接子项判定：兄弟前缀不算，嵌套不算', () => {
  assert.equal(isDirectChild('/w', '/w/a'), true)
  assert.equal(isDirectChild('/w', '/w2/a'), false)
  assert.equal(isDirectChild('/w', '/w'), false)
  assert.equal(isDirectChild('/w', '/w/a/b'), false)
  assert.equal(isDirectChild('C:\\Work', 'C:\\Work\\a'), true)
})
