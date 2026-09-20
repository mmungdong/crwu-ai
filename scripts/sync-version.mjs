/**
 * 版本号一致性：`package.json` 与 `VERSION` 必须相同。
 *
 * 为什么要它：同一个 semver 写在三处（`package.json`、`VERSION`、`CHANGELOG.md`），
 * 发布前对不上就会出现「装到的包和记录的版本不是一个东西」。
 * `CHANGELOG.md` 里的标题由人写，脚本只校验它至少存在对应版本的小节。
 *
 *   node scripts/sync-version.mjs 0.1.3     # 改 package.json + VERSION（并同步 lockfile 根版本）
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
    const problems = []
    if (pkg.version !== fileVersion) {
      problems.push(`${PACKAGE_FILE} version=${pkg.version} 与 ${VERSION_FILE}=${fileVersion} 不一致`)
    }
    if (!SEMVER.test(pkg.version)) problems.push(`${PACKAGE_FILE} version 不是合法 semver：${pkg.version}`)
    if (!changelog.includes(`## package · ${pkg.version}`)) {
      problems.push(`${CHANGELOG_FILE} 里没有 \`## package · ${pkg.version}\` 小节`)
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL     ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`PASS     版本一致：${pkg.version}（${PACKAGE_FILE} / ${VERSION_FILE} / ${CHANGELOG_FILE}）`)
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
