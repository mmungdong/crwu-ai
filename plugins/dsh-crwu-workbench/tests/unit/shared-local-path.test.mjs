import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 本地展示路径的纯函数（`shared/utils/local-path.ts`）。
 *
 * 这些函数同时被 Host 与 Client 使用，所以**不引用 `node:path`** —— 但也正因为如此，
 * 历史实现里各处用 `/` 硬拼，Windows 上出现「混用分隔符 / 取末段取到整条路径 /
 * 把 `C:\` 或 UNC 根裁坏」三类错误。这一份就是那三类错误的判据。
 */
const ROOT = new URL('../../', import.meta.url)
const {
  isWindowsStylePath, isAbsoluteLocalPath, trimTrailingSeparators, localSeparator,
  joinLocalPath, basenameLocalPath,
} = await import(new URL('src/shared/utils/local-path.ts', ROOT).href)

test('isWindowsStylePath 只认盘符与 UNC，不把 POSIX 绝对路径当 Windows', () => {
  assert.equal(isWindowsStylePath('C:\\Work'), true)
  assert.equal(isWindowsStylePath('C:/Work'), true)
  assert.equal(isWindowsStylePath('c:\\work\\x'), true)
  assert.equal(isWindowsStylePath('C:'), true)
  assert.equal(isWindowsStylePath('\\\\server\\share'), true)
  assert.equal(isWindowsStylePath('//server/share'), true)
  assert.equal(isWindowsStylePath('/work'), false)
  assert.equal(isWindowsStylePath('work/S1'), false)
  assert.equal(isWindowsStylePath(''), false)
  // 中文与空格不影响判断
  assert.equal(isWindowsStylePath('C:\\Users\\张三\\Case\'s Work'), true)
})

test('isAbsoluteLocalPath 覆盖 POSIX 根、盘符与 UNC', () => {
  assert.equal(isAbsoluteLocalPath('/work'), true)
  assert.equal(isAbsoluteLocalPath('C:\\Work'), true)
  assert.equal(isAbsoluteLocalPath('\\\\server\\share\\x'), true)
  assert.equal(isAbsoluteLocalPath('work/S1'), false)
  assert.equal(isAbsoluteLocalPath('~/x'), false)
  assert.equal(isAbsoluteLocalPath(''), false)
})

test('trimTrailingSeparators 保留根，不把盘符或 UNC 裁成残废路径', () => {
  assert.equal(trimTrailingSeparators('/work/'), '/work')
  assert.equal(trimTrailingSeparators('/'), '/')
  assert.equal(trimTrailingSeparators('//'), '/')
  assert.equal(trimTrailingSeparators('C:\\Work\\'), 'C:\\Work')
  // `C:` 是「盘符相对路径」，与 `C:\` 完全不是一回事 —— 不能裁掉。
  assert.equal(trimTrailingSeparators('C:\\'), 'C:\\')
  assert.equal(trimTrailingSeparators('C:/'), 'C:/')
  assert.equal(trimTrailingSeparators('\\\\server\\share\\'), '\\\\server\\share')
  // `\\server` 单独存在没有意义（它不是共享名），所以保留原样。
  assert.equal(trimTrailingSeparators('\\\\server\\'), '\\\\server\\')
  assert.equal(trimTrailingSeparators(''), '')
})

test('localSeparator 随路径风格走', () => {
  assert.equal(localSeparator('C:\\Work'), '\\')
  assert.equal(localSeparator('\\\\server\\share'), '\\')
  assert.equal(localSeparator('/work'), '/')
  assert.equal(localSeparator('work'), '/')
})

test('joinLocalPath 用调用方路径风格的分隔符拼接', () => {
  assert.equal(joinLocalPath('C:\\Work', 'a', 'b'), 'C:\\Work\\a\\b')
  assert.equal(joinLocalPath('/work', 'a', 'b'), '/work/a/b')
  assert.equal(joinLocalPath('/work/', 'a'), '/work/a')
  assert.equal(joinLocalPath('C:\\Work\\', 'a'), 'C:\\Work\\a')
  // 根上的尾分隔符不能再补一个：`/` + `a` 不能变成 `//a`。
  assert.equal(joinLocalPath('/', 'a'), '/a')
  assert.equal(joinLocalPath('C:\\', 'a'), 'C:\\a')
  assert.equal(joinLocalPath('\\\\server\\share\\', 'a'), '\\\\server\\share\\a')
  assert.equal(joinLocalPath('\\\\server\\', 'a'), '\\\\server\\a')
  assert.equal(joinLocalPath('C:\\Work', '张三', "Case's [1]"), "C:\\Work\\张三\\Case's [1]")
  // 空片段跳过；片段里的另一种分隔符规范成目标分隔符。
  assert.equal(joinLocalPath('/work', '', 'a'), '/work/a')
  assert.equal(joinLocalPath('C:\\Work', 'a/b'), 'C:\\Work\\a\\b')
  assert.equal(joinLocalPath('/work', 'a\\b'), '/work/a/b')
})

test('joinLocalPath 拒绝绝对片段与 .. 片段，而不是静默清洗', () => {
  // 静默清洗最危险：调用方会以为拿到的是一条安全路径。
  for (const bad of ['/etc/passwd', 'C:\\Windows\\System32', '\\\\server\\share', 'D:/x']) {
    assert.throws(() => joinLocalPath('/work', bad), RangeError, `应当拒绝绝对片段 ${bad}`)
  }
  for (const bad of ['..', '../x', 'a/../..', '..\\x', 'a\\..\\b']) {
    assert.throws(() => joinLocalPath('/work', bad), RangeError, `应当拒绝 .. 片段 ${bad}`)
  }
  // 「含点但不是 .. 段」的文件名照常通过（`审核结果.v1.json`）。
  assert.equal(joinLocalPath('/work', '审核结果.v1.json'), '/work/审核结果.v1.json')
  assert.equal(joinLocalPath('/work', 'a..b'), '/work/a..b')
})

test('joinLocalPath 根为空时返回相对片段，不伪造绝对路径', () => {
  assert.equal(joinLocalPath('', 'a', 'b'), 'a/b')
  assert.equal(joinLocalPath('', ''), '')
})

test('basenameLocalPath 两种分隔符都能取到末段', () => {
  assert.equal(basenameLocalPath('/work/S1'), 'S1')
  assert.equal(basenameLocalPath('/work/S1/'), 'S1')
  // 历史缺陷：`split('/')` 在 Windows 上返回整条路径，界面上的案例名变成一长串。
  assert.equal(basenameLocalPath('C:\\Work\\S1'), 'S1')
  assert.equal(basenameLocalPath('C:\\Work\\S1\\'), 'S1')
  assert.equal(basenameLocalPath('C:/Work/S1/'), 'S1')
  assert.equal(basenameLocalPath('\\\\server\\share\\2026-301705-LX10170-BG8746'), '2026-301705-LX10170-BG8746')
  assert.equal(basenameLocalPath('C:\\Users\\张三\\Case\'s Work'), "Case's Work")
  // 根本身没有「末段」，原样返回。
  assert.equal(basenameLocalPath('/'), '/')
  assert.equal(basenameLocalPath('C:\\'), 'C:\\')
  assert.equal(basenameLocalPath(''), '')
})

test('共享层不得引入 node:path（Client 产物要进浏览器）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const source = await readFile(fileURLToPath(new URL('src/shared/utils/local-path.ts', ROOT)), 'utf8')
  assert.equal(/from 'node:/.test(source), false, 'shared/ 下的纯函数不能引用 Node 模块')
  assert.equal(/require\(/.test(source), false)
})

// ── 消费者：案例目录约定（Host 审核指令与客户端讨论共用一份） ─────────────────

const { caseDirOf, caseDirName } = await import(new URL('src/shared/utils/case-dir.ts', ROOT).href)

test('caseDirOf 的分隔符随工作空间风格走（Windows 上不能拼成 C:\Work/S1）', () => {
  assert.equal(caseDirOf('/Users/me/工作空间/', 'S-1'), '/Users/me/工作空间/S-1')
  assert.equal(caseDirOf('C:\\Work', 'S-1'), 'C:\\Work\\S-1')
  assert.equal(caseDirOf('C:\\Work\\', 'S-1'), 'C:\\Work\\S-1')
  assert.equal(caseDirOf('C:\\Users\\张三\\Case\'s Work', 'S-1'), "C:\\Users\\张三\\Case's Work\\S-1")
  assert.equal(caseDirOf('\\\\server\\share', 'S-1'), '\\\\server\\share\\S-1')
  // 任一侧为空 → 空串（调用方据此不写这一段，而不是给半截路径）。
  assert.equal(caseDirOf('', 'S-1'), '')
  assert.equal(caseDirOf('/work', ''), '')
  // 流水号不是安全的一段时也返回空串（拒绝而不是清洗出越界路径）。
  assert.equal(caseDirOf('/work', '..'), '')
  assert.equal(caseDirOf('/work', '/etc/passwd'), '')
})

test('caseDirName 与 caseDirOf 同源', () => {
  assert.equal(caseDirName('/work/space/', 'S-1'), 'S-1')
  assert.equal(caseDirName('C:\\Work', 'S-1'), 'S-1')
  assert.equal(caseDirName('', 'S-1'), '')
})
