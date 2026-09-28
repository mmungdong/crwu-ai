/**
 * 版本号一致性：`package.json` 与 `VERSION` 必须相同。
 *
 * 为什么要它：同一个 semver 写在三处（`package.json`、`VERSION`、`CHANGELOG.md`），
 * 发布前对不上就会出现「装到的包和记录的版本不是一个东西」。
 * `CHANGELOG.md` 里的标题由人写，脚本只校验它至少存在对应版本的小节。
 *
 *   node scripts/sync-version.mjs 0.0.2     # 改 package.json + VERSION + src/host/consts.ts（并同步 lockfile 根版本）
 *   node scripts/sync-version.mjs --check   # 只校验（CI / prepublishOnly 用）
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_FILE = 'package.json'
const VERSION_FILE = 'VERSION'
const LOCK_FILE = 'package-lock.json'
const CHANGELOG_FILE = 'CHANGELOG.md'
// 包版本在代码里还有第三份：`PLUGIN_VERSION`（`ping` / `boot` 与界面版本徽章都用它）。
// 它必须一起改 —— 只改 package.json 会让界面显示上一版的号，而排查时那正是「我装到的是哪一版」的
// 唯一口头依据（§7.2）。`tests/unit/host-package.test.mjs` 断言它等于 package.json 的版本，
// 所以漏改会在门禁里立刻红，而不是等用户报「面板显示的还是 v0.0.5」。
const CONSTS_FILE = 'src/host/consts.ts'
const PLUGIN_VERSION_RE = /(export const PLUGIN_VERSION = ')([^']*)(')/

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

async function readJson(file) {
  return JSON.parse(await readFile(join(ROOT, file), 'utf8'))
}

async function writeJson(file, value) {
  await writeFile(join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const [, , ...args] = process.argv
  const check = args.includes('--check')
  const target = args.find((arg) => !arg.startsWith('--')) || ''

  const pkg = await readJson(PACKAGE_FILE)
  const fileVersion = (await readFile(join(ROOT, VERSION_FILE), 'utf8')).trim()

  if (check) {
    const changelog = await readFile(join(ROOT, CHANGELOG_FILE), 'utf8')
    const consts = await readFile(join(ROOT, CONSTS_FILE), 'utf8')
    const problems = []
    if (pkg.version !== fileVersion) {
      problems.push(`${PACKAGE_FILE} version=${pkg.version} 与 ${VERSION_FILE}=${fileVersion} 不一致`)
    }
    if (!SEMVER.test(pkg.version)) problems.push(`${PACKAGE_FILE} version 不是合法 semver：${pkg.version}`)
    if (!changelog.includes(`## package · ${pkg.version}`)) {
      problems.push(`${CHANGELOG_FILE} 里没有 \`## package · ${pkg.version}\` 小节`)
    }
    const constsVersion = consts.match(PLUGIN_VERSION_RE)?.[2] ?? ''
    if (constsVersion !== pkg.version) {
      problems.push(`${CONSTS_FILE} 的 PLUGIN_VERSION='${constsVersion}' 与 ${PACKAGE_FILE} 的 ${pkg.version} 不一致（跑 version:set 会一起改）`)
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL     ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`PASS     版本一致：${pkg.version}（${PACKAGE_FILE} / ${VERSION_FILE} / ${CHANGELOG_FILE} / ${CONSTS_FILE}）`)
    return
  }

  if (target === '') {
    console.error('用法：node scripts/sync-version.mjs <version> | --check')
    process.exitCode = 1
    return
  }
  if (!SEMVER.test(target)) {
    console.error(`FAIL     ${target} 不是合法 semver`)
    process.exitCode = 1
    return
  }

  pkg.version = target
  await writeJson(PACKAGE_FILE, pkg)
  await writeFile(join(ROOT, VERSION_FILE), `${target}\n`)

  // 代码里的那一份也要跟着走，否则界面版本徽章与 `ping.version` 会停在上一版 ——
  // 而它们正是「我装到的是哪一版」的唯一口头依据。找不到标记行就直接报错，不静默放过。
  const consts = await readFile(join(ROOT, CONSTS_FILE), 'utf8')
  if (!PLUGIN_VERSION_RE.test(consts)) {
    console.error(`FAIL     ${CONSTS_FILE} 里找不到 \`export const PLUGIN_VERSION = '…'\``)
    process.exitCode = 1
    return
  }
  await writeFile(join(ROOT, CONSTS_FILE), consts.replace(PLUGIN_VERSION_RE, `$1${target}$3`))

  // lockfile 的根版本也要跟着走，否则 `npm ci` 会报 lockfile 与 package.json 不同步。
  const lock = await readJson(LOCK_FILE).catch(() => null)
  if (lock !== null && lock.packages?.[''] !== undefined) {
    lock.packages[''].version = target
    lock.version = target
    await writeJson(LOCK_FILE, lock)
  }

  console.log(`OK       ${PACKAGE_FILE} / ${VERSION_FILE} → ${target}`)
  console.log(`TODO     在 ${CHANGELOG_FILE} 加一节 \`## package · ${target} · <日期>\`，再跑 npm run check`)
}

await main()
