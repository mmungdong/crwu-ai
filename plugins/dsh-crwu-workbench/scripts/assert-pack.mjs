/**
 * 发布前的产物自检：`npm pack` 出来的 tarball 里该有的都有、不该有的都没有。
 *
 * 为什么不能只靠 `files` 字段：`files` 是**声明**，真正打进去什么要问 npm。历史上这里踩过
 * 「声明里有 lib/ 但实际没有」「install/ 被打了进去」两类问题，而这两类问题只有装包的人
 * 才会遇到。所以发布前直接跑一次 `npm pack --dry-run --json` 核对真实清单。
 *
 * 用法：node scripts/assert-pack.mjs（`prepublishOnly` 与 CI 都会调用）
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { npmInvocation } from './exec.mjs'

const run = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 从 `npm pack --json` 的 stdout 里取出那个 JSON 数组。
 *
 * 为什么不能直接 `JSON.parse(stdout)`：**npm 10（Node 22 自带）在 `--ignore-scripts` 下仍会
 * 执行 `prepare`**（npm 11 不会），构建日志因此混进 stdout —— 实测首行是
 * `[build] tsdown 构建 lib/ …`，直接 parse 必炸。CI 的 ubuntu/node22 就是这么红的。
 * `prepare.mjs` 的日志现在也走 stderr 了，但这里再兜一层：npm 的数组是 stdout 里最后一个
 * 顶格 `[` 起的整段，从那里截一份再试。
 */
function parsePackReport(stdout) {
  const candidates = []
  const at = stdout.lastIndexOf('\n[')
  if (at >= 0) candidates.push(stdout.slice(at + 1))
  candidates.push(stdout)
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
      if (parsed !== null && typeof parsed === 'object') return [parsed]
    } catch (error) {
      void error
    }
  }
  throw new Error(`npm pack --json 的输出里找不到 JSON 数组，前 200 字符：${stdout.slice(0, 200)}`)
}

/** 装包的人必须有这些，否则插件根本装不上或不该用。 */
const REQUIRED = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  // npm 安装 tarball 时也会跑 prepare；这个入口不在包里，装包的人就会看到
  // `npm error command sh -c node scripts/prepare.mjs`。它必须随包发布。
  'scripts/prepare.mjs',
  'config/crwu-workbench.yml',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'LICENSE',
  // 技能随插件发布（`cordis.patch.yml` 的 crwu-workbench-skills 行把**每一层**注册成一个技能根）：
  // 员工装完插件就有全部技能，不再靠 skills-manager 往 `~/.dsh/skills` 里拷。
  // 每一层各钉一个代表 —— 公共层是打包前 `skills:sync` 从 `plugins/common/skills/` 拷进来的，
  // dws 层是 vendored 的上游正文，漏了任一步都只有一层能装上。
  'skills/README.md',
  'skills/crwu/crwu-audit/SKILL.md',
  'skills/dws/dingtalk-doc/SKILL.md',
  'skills/dws/provenance.json',
  'common/skills/crwu-dws/SKILL.md',
]

/** 这些进包只会让下载变大、并制造「包和仓库长得一样」的错觉。 */
const FORBIDDEN = [
  'AGENTS.md',
  'PORTING.md',
  'tests/',
  'legacy/',
  'install/',
  'scripts/sync-version.mjs',
  'scripts/assert-pack.mjs',
  // 同上：只有 prepare.mjs 随包发布，其它 scripts 一律不进包。
  'scripts/exec.mjs',
  'node_modules/',
  '.github/',
  'tsconfig.json',
  'tsdown.config.ts',
]

// `--ignore-scripts` 很重要：`prepare`/`prepack` 会把构建日志写进 stdout，把 --json 打坏。
// 调用方负责先构建（prepublishOnly 里 pack:assert 在前、check 里的 build 在后）。
const npm = npmInvocation()
const { stdout } = await run(npm.command, [...npm.args, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  maxBuffer: 16 * 1024 * 1024,
})
const [report] = parsePackReport(stdout)
const files = (report.files || []).map((entry) => entry.path)
const total = files.length
const bytes = report.unpackedSize ?? report.size ?? 0

const problems = []
for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`缺少必需文件：${required}`)
}
for (const forbidden of FORBIDDEN) {
  const hit = files.filter((file) => file === forbidden || file.startsWith(forbidden))
  if (hit.length > 0) problems.push(`打进了不该发布的路径：${hit.slice(0, 3).join(', ')}${hit.length > 3 ? ` 等 ${hit.length} 项` : ''}`)
}
// 体积上限：技能正文是随包发布的主体（`crwu` 层约 2.7MB + vendored 的 `dws` 层约 3.0MB，
// 其中 `crwu-dev-audit-optimize/template/echarts.min.js` 与 `dingtalk-misc` 各自占约 1MB），
// 所以这里卡的是「有没有误打 node_modules / 大二进制」这件事，不是「包小不小」。
// 超过就说明有不该进包的东西，看 `npm pack --dry-run --json` 的清单。
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024
if (bytes > MAX_UNPACKED_BYTES) {
  problems.push(`解包体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_UNPACKED_BYTES / 1024 / 1024}MB，确认没有误打大文件`)
}

/**
 * 加载契约检查：产物必须符合 DSH 的模块加载方式。
 *
 * 这几条以前只能靠「装进真实 DSH 看能不能起来」发现，代价很高。它们是**纯静态**的，
 * 所以放在发布自检里 —— 一旦谁改了 tsdown 配置、给 client 加了一个外部依赖、
 * 或把 ModuleLoader 包装去掉，这里立刻失败，而不是等接收方装完发现面板不出现。
 *
 * 三条依据（对照已安装的 DSH 与它自带的客户端包）：
 * 1. 客户端产物必须是 `window.__ModuleLoader__.load({ id, factory })` 形式，且 `id` 等于包名；
 * 2. 它的 `require(...)` **只能**要 `react` / `react/jsx-runtime`（DSH 的模块表提供这两个）；
 *    任何别的 require 都要求模块表里有对应条目，而插件无法保证；
 * 3. Host 产物是 ESM，且必须导出 DSH 函数插件协议要求的成员。
 */
const { readFile } = await import('node:fs/promises')
const { join } = await import('node:path')

const ALLOWED_REQUIRES = new Set(['react', 'react/jsx-runtime'])
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

if (files.includes('lib/client.js')) {
  const client = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(client)
  if (idMatch === null) {
    problems.push('lib/client.js 缺少 window.__ModuleLoader__.load({ id, factory }) 包装')
  } else if (idMatch[1] !== manifest.name) {
    problems.push(`lib/client.js 的模块 id 是 ${idMatch[1]}，与包名 ${manifest.name} 不一致`)
  }
  const requires = [...client.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1])
  for (const specifier of new Set(requires)) {
    if (!ALLOWED_REQUIRES.has(specifier)) {
      problems.push(`lib/client.js 依赖了 ${specifier}：DSH 模块表只保证提供 react 与 react/jsx-runtime`)
    }
  }
}

if (files.includes('lib/index.js')) {
  const host = await readFile(join(ROOT, 'lib/index.js'), 'utf8')
  if (!/export\s*\{/.test(host)) problems.push('lib/index.js 不是 ESM 导出形式')
  for (const member of ['apply', 'name', 'inject']) {
    if (!host.includes(member)) problems.push(`lib/index.js 缺少 DSH 插件协议要求的导出：${member}`)
  }
}


if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL     ${problem}`)
  console.error(`FAIL     ${report.filename} 共 ${total} 个文件`)
  process.exitCode = 1
} else {
  console.log(`PASS     ${report.filename}：${total} 个文件 / 解包 ${(bytes / 1024).toFixed(0)}KB`)
}
