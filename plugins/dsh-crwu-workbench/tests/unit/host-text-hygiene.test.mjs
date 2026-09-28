import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 文本文件的行尾卫生。
 *
 * ## 为什么值得一条门禁（2026-09-28 复查发现）
 *
 * 复查时用 `git diff --check` 检查「工作区干净」，得到的结论**不准确**：那条命令只看
 * 工作区与索引的差异，**看不到已提交内容**。正确做法是 `git diff --check main...HEAD`
 * （或提交前 `git diff --cached --check`），它报出了
 * `tests/unit/host-credential-permission.test.mjs:137: new blank line at EOF`。
 *
 * 「末尾多一个空行」本身无害，但它会让下面这类判断失真，而且每条分支都可能再犯一次。
 * 所以这里把它机器化，不依赖人记得用哪种 diff 形式：
 *
 * 1. **末尾恰好一个换行**：多一个空行（`…}\n\n`）或完全没有末尾换行都算违反；
 * 2. **不得出现 CRLF**：仓库在 macOS/Linux 上开发、在 Windows 上跑 CI，
 *    行尾混用会让「按行断言」的测试与 PowerShell 里的字符串比较出现假红假绿。
 *
 * 范围是本包自己的源码 / 测试 / 脚本 / 文档 / 配置，加上两个 CI 工作流。
 * `skills/` 与 `bin/` 不在范围内：前者含 vendored 上游正文（由 `dws:check` 按 provenance 守），
 * 后者是二进制。
 */
const PLUGIN_DIR = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TEXT_FILE = /\.(?:ts|tsx|mjs|js|md|yml|yaml|json|css)$/

const ROOTS = [
  join(PLUGIN_DIR, 'src'),
  join(PLUGIN_DIR, 'tests'),
  join(PLUGIN_DIR, 'scripts'),
  join(PLUGIN_DIR, 'docs'),
  join(PLUGIN_DIR, 'config'),
  join(REPO_ROOT, '.github', 'workflows'),
]
const EXTRA_FILES = [
  join(PLUGIN_DIR, 'package.json'),
  join(PLUGIN_DIR, 'tsconfig.json'),
  join(PLUGIN_DIR, 'VERSION'),
]

/** 递归收集文本文件（跳过 node_modules / __pycache__ / 二进制）。 */
function collect(dir, out) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    void error
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '__pycache__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (TEXT_FILE.test(entry.name) && statSync(full).isFile()) out.push(full)
  }
  return out
}

function textFiles() {
  const files = [...EXTRA_FILES]
  for (const root of ROOTS) collect(root, files)
  return files
}

test('文本文件的行尾卫生：末尾恰好一个换行、不得出现 CRLF', () => {
  const files = textFiles()
  assert.ok(files.length > 50, `收集到的文本文件太少（${String(files.length)}），扫描范围可能写错了`)

  const blankAtEof = []
  const missingFinalNewline = []
  const crlf = []
  for (const file of files) {
    // 按 UTF-8 读成字符串：`Buffer` 没有 `endsWith`，而这些文件按定义都是文本。
    const raw = readFileSync(file, 'utf8')
    const label = relative(REPO_ROOT, file)
    if (raw.endsWith('\n\n')) blankAtEof.push(label)
    if (!raw.endsWith('\n')) missingFinalNewline.push(label)
    if (raw.includes('\r\n')) crlf.push(label)
  }

  assert.deepEqual(blankAtEof, [], '这些文件末尾多了一个空行（`git diff --check main...HEAD` 会报 new blank line at EOF）')
  assert.deepEqual(missingFinalNewline, [], '这些文件缺少末尾换行')
  assert.deepEqual(crlf, [], '这些文件用了 CRLF 行尾（Windows 检出后按行断言会失真）')
})
