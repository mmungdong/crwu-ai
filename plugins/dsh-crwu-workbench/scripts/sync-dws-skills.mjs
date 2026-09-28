/**
 * 把上游 **dingtalk-workspace-cli（`dws`）** 自带的钉钉技能 vendored 进本插件包（`skills/dws/`）。
 *
 * 为什么要有这一步而不是直接引用 `~/.agents/skills`：员工机器上那份是 `dws skill install`
 * 装出来的运行时副本，谁都能改、也会随 CLI 升版漂移。仓库里必须是**可复现、可审计**的一份：
 * 版本、集合、逐技能摘要都写在 `skills/dws/provenance.json` 里，`--check` 只比内容不碰源。
 *
 * 上游来源（按顺序找，取第一个存在的）：
 *   1. `--source <dir>` 或 `$DWS_SKILLS_SOURCE`（显式指定，最优先）；
 *   2. `dws` 可执行文件所在包的 `share/skills/`（覆盖 WorkBuddy 这类托管安装）；
 *   3. 当前 Node 的全局 `node_modules/dingtalk-workspace-cli/share/skills/`；
 *   4. `~/.dws/skills/`（CLI 已安装的技能缓存；LICENSE / NOTICE 从 2 或 3 补）。
 *
 * 三种运行环境都要对：
 *   1. 仓库内开发 / 打包（找得到上游）→ 拷贝 + 写 provenance；
 *   2. 员工用 tarball 安装（本脚本不在包里、也没有上游）→ 本脚本根本不会被调用；
 *   3. `--check` → **不碰源**，只校验仓库里那份与 `provenance.json` 逐字节一致（CI 用）。
 *
 * 升级上游 = 一次显式动作：`npm run dws:sync -- --allow-version-change`，然后审 diff。
 * 版本对不上而不带这个开关时**拒绝写入** —— 上游静默换版不该悄悄改掉随包内容。
 */
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestDir, digestFile, exists, skillNames } from './lib/skill-digest.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DWS_DIR = join(PLUGIN_DIR, 'skills', 'dws')
const PROVENANCE = join(DWS_DIR, 'provenance.json')

const PACKAGE_NAME = 'dingtalk-workspace-cli'
const UPSTREAM = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli'
/** 集合：`multi` = 一产品一技能（DSH 默认用它）；`mono` = 单个 `dws` 大技能。 */
const SETS = {
  multi: { dir: 'multi', flatten: true },
  mono: { dir: 'mono', flatten: false },
}
/** 必须随技能一起保留的上游文件（Apache-2.0 的 LICENSE 与 NOTICE）。 */
const LICENSE_FILES = ['LICENSE', 'NOTICE']

function parseArgs(argv) {
  const options = { check: false, set: 'multi', source: process.env.DWS_SKILLS_SOURCE ?? null, updateVersion: false, setChange: false }
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === '--check') options.check = true
    else if (arg === '--allow-version-change') options.updateVersion = true
    else if (arg === '--allow-set-change') options.setChange = true
    else if (arg === '--set') options.set = argv[++at] ?? ''
    else if (arg === '--source') options.source = argv[++at] ?? ''
    else throw new Error(`未知参数：${arg}`)
  }
  if (!(options.set in SETS)) throw new Error(`--set 只支持 ${Object.keys(SETS).join(' / ')}，收到：${options.set || '（空）'}`)
  return options
}

/** 可执行文件在 PATH 里解析出的真实路径（不调用 shell）。 */
async function resolveExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      if (!(await exists(candidate))) continue
      try {
        return await realpath(candidate)
      } catch (error) {
        void error
        return candidate
      }
    }
  }
  return null
}

/** 上游包目录下 `share/skills` 是否存在；存在就返回它。 */
async function shareSkillsOf(packageDir) {
  const dir = join(packageDir, 'share', 'skills')
  return (await exists(join(dir, 'multi'))) || (await exists(join(dir, 'mono'))) ? dir : null
}

/** 从可执行文件位置向上找上游包（npm 布局是祖先目录，WorkBuddy 这类托管布局是同级的 lib/node_modules）。 */
async function shareSkillsFromExecutable(executable) {
  let current = dirname(executable)
  for (let up = 0; up < 6; up += 1) {
    const candidates = [current, join(current, 'node_modules', PACKAGE_NAME), join(current, 'lib', 'node_modules', PACKAGE_NAME)]
    for (const candidate of candidates) {
      const share = await shareSkillsOf(candidate)
      if (share !== null) return share
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** 当前 Node 的全局包目录（`<prefix>/lib/node_modules`；Windows 为 `<prefix>/node_modules`）。 */
function globalNodeModules() {
  const binDir = dirname(process.execPath)
  return process.platform === 'win32' ? join(binDir, 'node_modules') : join(binDir, '..', 'lib', 'node_modules')
}

async function sourceCandidates(options) {
  const candidates = []
  if (options.source) candidates.push(resolve(options.source))
  const executable = await resolveExecutable('dws')
  if (executable !== null) {
    const share = await shareSkillsFromExecutable(executable)
    if (share !== null) candidates.push(share)
  }
  const share = await shareSkillsOf(join(globalNodeModules(), PACKAGE_NAME))
  if (share !== null) candidates.push(share)
  candidates.push(join(homedir(), '.dws', 'skills'))
  return candidates
}

/**
 * 读上游版本。两种源布局各有一条线索：
 * - 上游包：`<pkg>/share/skills` → 上两级是 `<pkg>/package.json`；
 * - CLI 技能缓存：`~/.dws/skills` → 上一级是 `~/.dws/skills-state.json`。
 */
async function readVersion(sourceDir) {
  for (const parent of [dirname(sourceDir), dirname(dirname(sourceDir))]) {
    const packageJson = join(parent, 'package.json')
    if (await exists(packageJson)) {
      try {
        const parsed = JSON.parse(await readFile(packageJson, 'utf8'))
        if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string') return parsed.version
      } catch (error) {
        void error
      }
    }
    const state = join(parent, 'skills-state.json')
    if (await exists(state)) {
      try {
        const parsed = JSON.parse(await readFile(state, 'utf8'))
        if (typeof parsed.version === 'string') return parsed.version
      } catch (error) {
        void error
      }
    }
  }
  return null
}

/** 源目录里 `<set>/` 下的技能名（`mono` 是整包一个技能，名字取上游 frontmatter 的 name）。 */
async function sourceSkillNames(sourceDir, set) {
  const setDir = join(sourceDir, SETS[set].dir)
  if (!SETS[set].flatten) return [await readSkillName(setDir)]
  const names = (await skillNames(setDir)) ?? []
  return names.filter((name) => name !== '')
}

/** 读技能 frontmatter 的 `name:`（`mono` 集合的目录名与技能名不同，必须以 frontmatter 为准）。 */
async function readSkillName(skillDir) {
  const raw = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  const match = /^name:\s*(\S+)\s*$/m.exec(raw)
  if (match === null) throw new Error(`技能 ${skillDir} 的 SKILL.md 里没有 name 字段`)
  return match[1]
}

/** LICENSE / NOTICE：优先源目录，其次可执行文件所在包与全局包的 `share/skills/`。 */
async function resolveLicenseFiles(sourceDir, options) {
  const found = {}
  for (const name of LICENSE_FILES) {
    const direct = join(sourceDir, name)
    if (await exists(direct)) {
      found[name] = direct
      continue
    }
    for (const candidate of await sourceCandidates({ ...options, source: null })) {
      const fallback = join(candidate, name)
      if (await exists(fallback)) {
        found[name] = fallback
        break
      }
    }
  }
  const missing = LICENSE_FILES.filter((name) => !(name in found))
  if (missing.length > 0) {
    throw new Error(
      `找不到上游 ${missing.join(' / ')}：请用 --source 指向 dingtalk-workspace-cli 的 share/skills 目录` +
        '（Apache-2.0 要求随技能保留 LICENSE 与 NOTICE）',
    )
  }
  return found
}

async function readProvenance() {
  if (!(await exists(PROVENANCE))) return null
  return JSON.parse(await readFile(PROVENANCE, 'utf8'))
}

/** 目录下每个技能都有自己的 SKILL.md；缺了说明拷贝不完整，宁可报错也不落一份坏数据。 */
async function assertSkillDirs(dir, names) {
  for (const name of names) {
    if (!(await exists(join(dir, name, 'SKILL.md')))) throw new Error(`${join(dir, name)} 缺 SKILL.md`)
  }
}

async function buildProvenance(targetDir, version, set, names) {
  const skills = {}
  for (const name of names) skills[name] = `sha256:${await digestDir(join(targetDir, name))}`
  const files = {}
  for (const name of LICENSE_FILES) {
    if (await exists(join(targetDir, name))) files[name] = `sha256:${await digestFile(join(targetDir, name))}`
  }
  return {
    package: PACKAGE_NAME,
    upstream: UPSTREAM,
    version: version ?? 'unknown',
    license: 'Apache-2.0',
    set,
    skills,
    files,
  }
}

async function checkCommitted() {
  const provenance = await readProvenance()
  if (provenance === null) {
    console.error(`[dws] 缺少 ${PROVENANCE}：先跑一次 \`npm run dws:sync\` 并提交结果`)
    return 1
  }
  const names = (await skillNames(DWS_DIR)) ?? []
  const expected = Object.keys(provenance.skills).sort()
  if (names.length !== expected.length || !names.every((name, at) => name === expected[at])) {
    console.error(`[dws] skills/dws 的技能集合与 provenance 不一致：目录=${names.join(' ') || '（空）'} / 记录=${expected.join(' ')}`)
    console.error('[dws] 跑一次 `npm run dws:sync` 再提交')
    return 1
  }
  for (const name of names) {
    const got = `sha256:${await digestDir(join(DWS_DIR, name))}`
    if (got !== provenance.skills[name]) {
      console.error(`[dws] 技能 ${name} 的内容与 provenance 不一致（vendored 内容只能由同步脚本改写）`)
      console.error('[dws] 跑一次 `npm run dws:sync` 再提交')
      return 1
    }
  }
  for (const [name, want] of Object.entries(provenance.files ?? {})) {
    const path = join(DWS_DIR, name)
    if (!(await exists(path))) {
      console.error(`[dws] 缺少上游 ${name}（Apache-2.0 要求随技能保留）`)
      return 1
    }
    if (`sha256:${await digestFile(path)}` !== want) {
      console.error(`[dws] 上游文件 ${name} 被改过（vendored 内容只能由同步脚本改写）`)
      return 1
    }
  }
  console.log(`[dws] 一致：${names.length} 个 ${provenance.package}@${provenance.version} 技能（set=${provenance.set}），内容逐文件比对通过`)
  return 0
}

async function sync(options) {
  let sourceDir = null
  for (const candidate of await sourceCandidates(options)) {
    if (await exists(join(candidate, SETS[options.set].dir))) {
      sourceDir = candidate
      break
    }
  }
  if (sourceDir === null) {
    console.log(`[dws] 跳过：本机没有 ${PACKAGE_NAME} 的 skill 源（可用 --source 或 $DWS_SKILLS_SOURCE 指定）`)
    return 0
  }

  const version = await readVersion(sourceDir)
  const previous = await readProvenance()
  if (previous !== null && !options.updateVersion && version !== previous.version) {
    console.error(`[dws] 上游版本变了：${previous.version} → ${version ?? 'unknown'}（源：${sourceDir}）`)
    console.error('[dws] 先审 diff 再执行 `npm run dws:sync -- --allow-version-change`，并把版本写进 CHANGELOG')
    return 1
  }
  if (previous !== null && !options.setChange && options.set !== previous.set) {
    console.error(`[dws] 集合要变：${previous.set} → ${options.set}`)
    console.error('[dws] 换集合会整层替换技能，先审 diff 再执行 `npm run dws:sync -- --set <集合> --allow-set-change`')
    return 1
  }

  const names = await sourceSkillNames(sourceDir, options.set)
  if (names.length === 0) {
    console.error(`[dws] 上游 ${join(sourceDir, SETS[options.set].dir)} 里没有技能：源找对了但内容是空的`)
    return 1
  }
  const licenses = await resolveLicenseFiles(sourceDir, options)

  // 整层替换：上游删掉的技能不能在包里留残骸。
  await rm(DWS_DIR, { recursive: true, force: true })
  await mkdir(DWS_DIR, { recursive: true })
  if (SETS[options.set].flatten) {
    for (const name of names) await cp(join(sourceDir, SETS[options.set].dir, name), join(DWS_DIR, name), { recursive: true })
  } else {
    for (const name of names) await cp(join(sourceDir, SETS[options.set].dir), join(DWS_DIR, name), { recursive: true })
  }
  for (const [name, path] of Object.entries(licenses)) await cp(path, join(DWS_DIR, name))
  await assertSkillDirs(DWS_DIR, names)

  const provenance = await buildProvenance(DWS_DIR, version, options.set, names)
  await writeFile(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(`[dws] 已同步 ${names.length} 个技能（${PACKAGE_NAME}@${version ?? 'unknown'}，set=${options.set}）→ ${DWS_DIR}`)
  console.log(`[dws] ${names.join(' ')}`)
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // `--source` 指向不存在的路径时立刻报错，不要静默回落到别的源（否则会拷错版本还看不出来）。
  if (options.source !== null && !(await exists(options.source))) {
    console.error(`[dws] --source 指向的目录不存在：${options.source}`)
    return 1
  }
  return options.check ? checkCommitted() : sync(options)
}

process.exitCode = await main()
