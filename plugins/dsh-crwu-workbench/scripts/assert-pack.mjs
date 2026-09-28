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
import { BIN_MANIFEST_NAME, BIN_PLATFORMS, BIN_TOOLS, binFileName, readBinManifest, verifyBinDir } from './bin-manifest.mjs'

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
  // 装配二进制的脚本与下载缓存同样不进包：前者是开发机工具，后者是 100MB 的中间产物。
  'scripts/sync-binaries.mjs',
  'scripts/bin-manifest.mjs',
  'scripts/check-skill-cli-guard.mjs',
  'scripts/sync-common-skills.mjs',
  'scripts/sync-dws-skills.mjs',
  '.cache/',
  'node_modules/',
  '.github/',
  'tsconfig.json',
  'tsdown.config.ts',
]

// `--ignore-scripts` 很重要：`prepare`/`prepack` 会把构建日志写进 stdout，把 --json 打坏。
// **调用方负责先构建**：`prepublishOnly` 现在是 `check`（含 build）在前、`pack:assert:strict` 在后
// —— 反过来的话，在一份没构建过的工作树上必然先红，而那和"包有没有问题"无关。
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
// 体积上限。技能正文是随包发布的主体（`crwu` 层约 2.7MB + vendored 的 `dws` 层约 3.0MB），
// 而**自带二进制才是大头**：darwin-arm64 与 win32-x64 各一套 crwu/dws/ossutil，
// 两个平台合计解包约 100MB（dws 一个平台就 32MB）。所以这里卡的是「有没有多打了不该进包的东西」，
// 不是「包小不小」——超过上限就去看 `npm pack --dry-run --json` 的清单。
// 两个平台都装配时约 110MB；CI 不装配，只算技能那部分（约 6MB）。
const MAX_UNPACKED_BYTES = 160 * 1024 * 1024
if (bytes > MAX_UNPACKED_BYTES) {
  problems.push(`解包体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_UNPACKED_BYTES / 1024 / 1024}MB，确认没有误打大文件`)
}

/**
 * 自带二进制必须真的进包 —— 分**非严格**与**发布严格**两档。
 *
 * **为什么要分档**：装配要 `make build` 加约 110MB 下载，普通开发与 CI（Ubuntu/Windows）
 * 不做这件事，硬要求会让它们全红。所以：
 * - 非严格（默认）：`bin/` 完全没装配 → 只提示；一旦装配了 → 六个二进制与 `bin/manifest.json`
 *   一个都不能少，且 manifest 里的 size/sha256 必须与**工作树里**的文件一致；
 * - 严格（`--strict` / `npm run pack:assert:strict`，**发布链路必须用**）：
 *   - 两个平台全部六个二进制必须存在；
 *   - `bin/manifest.json` 必须存在且 schema 正确；
 *   - 真正 `npm pack` 出 tarball、解包后按 manifest **逐个重算 size 与 sha256**；
 *   - `bin/` 下不许有任何未在 manifest 中声明的文件（运行残留）。
 *
 * 为什么不能只看 `npm pack --dry-run` 的文件清单：它只给名字，证明不了「员工装到的那份字节
 * 就是我们校验过的那份」—— 解包、chmod、拷贝任何一步出错都发现不了。
 */
const { existsSync } = await import('node:fs')
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')

const MANIFEST = `bin/${BIN_MANIFEST_NAME}`
const strict = process.argv.includes('--strict') || process.env.CRWU_PACK_STRICT === '1'
/**
 * 自带二进制的来源目录。默认是本包 `bin/`；`CRWU_BIN_DIR` 允许指到别处 ——
 * 与 `sync-binaries.mjs` 共用同一个变量（发布矩阵把产物汇总到共享目录时也用它），
 * 顺带让「缺平台 / 缺工具 / 缺 manifest 时必须失败」这几条能在几 KB 的假目录上被测到。
 */
const BIN_ROOT = process.env.CRWU_BIN_DIR !== undefined && process.env.CRWU_BIN_DIR !== ''
  ? process.env.CRWU_BIN_DIR
  : `${ROOT}/bin`

/**
 * `bin/` 里**只允许**那六个二进制加一份 manifest。
 *
 * 不是洁癖：手工跑一次 `./bin/darwin-arm64/dws version` 会让 dws 在自己旁边落一个 `.dws/`
 * 状态目录（`.data.lock` + `logs/dws.log`），而 `files` 里的 `bin/` 会把它整包带走 ——
 * 实测就这么混进过 `npm pack` 清单（当时是 0 字节，但那是**运行产物**，
 * 而且 dws 的日志将来完全可能带凭据）。所以按白名单卡死，而不是列举黑名单。
 */
const binStrays = files.filter((file) => file.startsWith('bin/') && !/^bin\/[^/]+\/(crwu|dws|ossutil)(\.exe)?$/.test(file) && file !== MANIFEST)
for (const stray of binStrays) {
  problems.push(`bin/ 里混进了不该发布的东西：${stray}（多半是跑过 dws 留下的运行产物，重跑 make plugin-bin）`)
}

const assembledPlatforms = BIN_PLATFORMS.filter((platform) => existsSync(`${BIN_ROOT}/${platform}`))
const manifestPath = `${BIN_ROOT}/${BIN_MANIFEST_NAME}`
const manifestExists = existsSync(manifestPath)

if (assembledPlatforms.length === 0 && !manifestExists) {
  if (strict) {
    problems.push(`发布严格模式要求自带二进制：${BIN_PLATFORMS.join('、')} 两个平台各 ${BIN_TOOLS.length} 个二进制 + ${MANIFEST} —— 一个都没有（先跑 \`make plugin-bin\`）`)
  } else {
    console.log('WARN     未装配 `bin/`（跑 `make plugin-bin`）—— 本次只校验包形状，不校验自带二进制')
  }
} else {
  for (const platform of BIN_PLATFORMS) {
    for (const tool of BIN_TOOLS) {
      const path = `bin/${platform}/${binFileName(tool, platform)}`
      if (!files.includes(path)) problems.push(`缺少自带二进制：${path}（已装配却没进包，检查 package.json 的 files）`)
    }
  }
  if (!manifestExists) {
    problems.push(`缺少构建产物清单：${MANIFEST}（跑 \`node scripts/sync-binaries.mjs\` 重新装配）`)
  }
}

/** 工作树里的 `bin/`：按清单重算 size 与 sha256（与 `--check` 同一判据）。 */
if (manifestExists) {
  const loaded = await readBinManifest(manifestPath)
  if (loaded.ok === false) problems.push(loaded.error)
  else problems.push(...await verifyBinDir(BIN_ROOT, loaded.manifest, { requireAll: strict }))
}

if (strict && problems.length > 0) {
  // 已经知道发布形状不完整（缺平台/工具/manifest、bin 里有残留……）时**不再打 tarball**：
  // 打一份 108MB 的包只为了再报一次同样的错，代价与信息量都不划算。
  console.log('SKIP     严格模式的 tarball 复验：bin/ 已经不合格（见上面的 FAIL）')
} else if (strict) {
  // 真正打一份 tarball 并解包：只有这样才能证明「进包的字节」与清单一致。
  const work = await mkdtemp(`${tmpdir()}/crwu-strict-pack-`)
  try {
    await run(npm.command, [...npm.args, 'pack', '--pack-destination', work, '--ignore-scripts'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
    const { readdir, readFile: readTarball } = await import('node:fs/promises')
    const produced = await readdir(work)
    const tarball = produced.find((name) => name.endsWith('.tgz'))
    if (tarball === undefined) {
      // 诊断信息必须够定位：`pack` 命令明明退出 0（在真 npm 上已实测），却在这里找不到 .tgz ——
      // 只报一句"没有产出 tarball"让人无从下手。所以把「打到哪个目录」「那个目录里实际有什么」
      // 「npm 是怎么被调起来的」「当前有哪些会改变 pack 行为的 npm_config_*」全打出来。
      const packEnvs = Object.entries(process.env)
        .filter(([key]) => key.startsWith('npm_config_'))
        .map(([key, value]) => `${key}=${String(value)}`)
        .sort()
      problems.push('严格模式：npm pack 没有产出 tarball')
      console.error(`         目的地：${work}`)
      console.error(`         目录内容：${produced.length === 0 ? '（空）' : produced.slice(0, 20).join(', ')}`)
      console.error(`         调用方式：${npm.command} ${[...npm.args, 'pack', '--pack-destination', '<work>', '--ignore-scripts'].join(' ')}（cwd=${ROOT}）`)
      console.error(`         npm_config_*：${packEnvs.length === 0 ? '（无）' : packEnvs.join(' ')}`)
      console.error('         自查：直接在本包目录跑 `npm pack --pack-destination "$(mktemp -d)"` 看 .tgz 落在哪；'
        + '若只落到了包目录（`ls *.tgz`），说明 --pack-destination 没被这份 npm 采纳。')
    } else {
      const { join } = await import('node:path')
      const { mkdir } = await import('node:fs/promises')
      // `--strip-components=1` 去掉 tarball 里的 `package/` 前缀，所以**必须先建好目标目录**：
      // 直接把 `-C work` 当解包根会把文件摊进 work，再去找 `<work>/pkg/bin` 自然找不到。
      const unpacked = join(work, 'pkg')
      await mkdir(unpacked, { recursive: true })
      await run('tar', ['-xzf', join(work, tarball), '-C', unpacked, '--strip-components=1'], { cwd: work })
      const binDir = join(unpacked, 'bin')
      if (!existsSync(binDir)) {
        problems.push('严格模式：tarball 里没有 bin/ 目录')
      } else {
        const tarballManifest = await readTarball(join(unpacked, MANIFEST), 'utf8').catch(() => null)
        if (tarballManifest === null) {
          problems.push(`严格模式：tarball 里没有 ${MANIFEST}`)
        } else {
          const loaded = await readBinManifest(join(unpacked, MANIFEST))
          if (loaded.ok === false) problems.push(`严格模式：${loaded.error}`)
          else problems.push(...(await verifyBinDir(binDir, loaded.manifest, { requireAll: true }))
            .map((problem) => `严格模式（tarball）：${problem}`))
        }
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
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
