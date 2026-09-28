/**
 * 把工作台需要的三个二进制装配进包内 `bin/<平台>/`。
 *
 * **为什么二进制要进包**：DSH 没有任何「把插件里的 bin 挂到 PATH」的机制 —— 实测确认
 * `dsh-package-manifest` 不认 `bin` 字段、`dsh-bash-local` 的 Config 没有 env/PATH 入口、
 * `dsh-shell-env` 只接收 `DSH_*` 键（`lib/index.js` 里 key 前缀校验会直接抛错）、`.env` 明确
 * 拒绝 `PATH`。所以插件只能自己按平台算出绝对路径，而「算得出来」的前提是文件真在包里。
 *
 * 目录名用 `<os>-<arch>`，与 `normalizePlatform()` 的输出、以及环境清单里 `platforms` 的键同一套：
 *
 *   bin/darwin-arm64/{crwu,dws,ossutil}
 *   bin/win32-x64/{crwu.exe,dws.exe,ossutil.exe}
 *
 * **来源都可复现**（不依赖开发机上已经装好的东西）：
 * | 二进制 | 来源 | 校验 |
 * | --- | --- | --- |
 * | `crwu` | 本仓构建产物 `bin/darwin/crwu`、`bin/windows/crwu.exe`（先跑 `make build`） | 无（自己构建） |
 * | `ossutil` | 阿里云官方包 | URL 与 sha256 直接取自 `src/host/environment/manifest-default.ts`，**同一事实源** |
 * | `dws` | npm 包 `dingtalk-workspace-cli` 的 `assets/dws-*` | 对照包内 `assets/checksums.txt` |
 *
 * **软链接进不了包**：npm 打包会**静默丢掉**符号链接（实测：放进去的相对/绝对链接都不在 tarball 里，
 * 只有真实文件会），所以这里一律落真实文件 —— 开发机上也是拷贝，避免「本机能用、员工装上少文件」。
 *
 * **构建产物清单**（`bin/manifest.json`，2026-09-25 起）：
 *
 * 归档地址与哈希只能证明「下载到的东西是对的」，证明不了「**最终落进包里的文件**是对的」——
 * 解包、`chmod`、拷贝任何一步出错，`--check` 只看「文件在不在、非不非空」是发现不了的。
 * 所以每次装配都写一份清单，记录每个平台每个工具的：来源、版本、目标、最终文件大小与
 * **最终文件 sha256**（dws/ossutil 另外记下载归档本身的哈希）。`--check` 按清单**重算最终文件哈希**。
 *
 * 用法：
 *   node scripts/sync-binaries.mjs            装配（同时写 bin/manifest.json）
 *   node scripts/sync-binaries.mjs --check    按清单重算最终文件哈希；不写盘、不下载
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  BIN_MANIFEST_NAME,
  BIN_MANIFEST_SCHEMA,
  BIN_PLATFORMS as PLATFORMS,
  BIN_TOOLS,
  binFileName as exeName,
  readBinManifest,
  sha256,
  verifyBinDir,
} from './bin-manifest.mjs'

const run = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(ROOT))
/**
 * 装配目标目录。默认是包内 `bin/`；`CRWU_BIN_DIR` 可以指到别处 ——
 * 发布矩阵把产物汇总到共享目录、以及单测用几 KB 的假文件覆盖每条失败分支，都靠它。
 */
const OUT_ROOT = process.env.CRWU_BIN_DIR !== undefined && process.env.CRWU_BIN_DIR !== ''
  ? process.env.CRWU_BIN_DIR
  : join(ROOT, 'bin')
const CACHE = join(ROOT, '.cache', 'binaries')

/**
 * ossutil 的上游下载表。
 *
 * **它住在构建脚本里，不在运行时清单里**（2026-09-25 拆开）：清单是发到员工机器上的运行时数据，
 * 只该回答「装了什么、版本够不够」；下载地址与哈希是**发布时**才用的东西。两者混在一起时，
 * 清单里那几个字段会被误读成「运行时还能去下载」—— 而那条路正是要删掉的。
 * 换版本只改这里（`OSSUTIL_VERSION` + 两个 sha256）。
 */
const OSSUTIL_VERSION = '1.7.19'
const OSSUTIL_BASE = `https://gosspublic.alicdn.com/ossutil/${OSSUTIL_VERSION}`
const OSSUTIL_PLATFORMS = {
  'darwin-arm64': {
    url: `${OSSUTIL_BASE}/ossutil-v${OSSUTIL_VERSION}-mac-arm64.zip`,
    sha256: '10ece4d328c5d2440833adc5f4167168e9b2a4c5d364f673b0c45bcc4fd02ec5',
    member: 'ossutil',
  },
  'win32-x64': {
    url: `${OSSUTIL_BASE}/ossutil-v${OSSUTIL_VERSION}-windows-amd64.zip`,
    sha256: '8e9176aedc87d230ccd97dc7236b16564f2a068609ed301acdc73dc27faf7e77',
    member: 'ossutil.exe',
  },
}

/** dws 的固定上游版本：与 `skills/dws/` 的 provenance 同源，改这里要同时跑 `npm run dws:sync`。 */
const DWS_PACKAGE = 'dingtalk-workspace-cli'
const DWS_VERSION = '1.0.61'


const isWindowsPlatform = (platform) => platform.startsWith('win32')

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')

/** 下载到缓存并校验 sha256；缓存命中且校验通过就不重复下载。 */
async function fetchVerified(url, expected, cacheName) {
  await mkdir(CACHE, { recursive: true })
  const cached = join(CACHE, cacheName)
  if (existsSync(cached) && (await sha256(cached)) === expected) return cached
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`sha256 不匹配：${url}\n  期望 ${expected}\n  实际 ${actual}`)
  await writeFile(cached, bytes)
  return cached
}

/**
 * 从 tar.gz / zip 里取出一个成员，写到目标路径并加可执行位。
 *
 * `member` 按**文件名**匹配而不是按归档内路径：上游包的成员带一层版本目录
 * （`ossutil-v1.7.19-mac-arm64/ossutil`），而清单里写的是 `ossutil` —— 认路径会在升级
 * 版本号时立刻断，认文件名才跟得住。
 */
async function extractMember(archive, member, target) {
  const work = await mkdtemp(join(tmpdir(), 'crwu-bin-'))
  try {
    if (archive.endsWith('.zip')) await run('unzip', ['-q', '-o', archive, '-d', work])
    else await run('tar', ['-xzf', archive, '-C', work])
    const found = await findByName(work, member)
    if (found === '') throw new Error(`归档里没有名为 ${member} 的成员：${archive}`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(found, target)
    await chmod(target, 0o755)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** 在目录树里按文件名找第一个匹配项；找不到返回空串。 */
async function findByName(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findByName(full, name)
      if (nested !== '') return nested
    } else if (entry.name === name) {
      return full
    }
  }
  return ''
}

/** crwu 来自本仓构建产物；先 `make build`。 */
async function stageCrwu(platform, target) {
  const built = isWindowsPlatform(platform)
    ? join(REPO_ROOT, 'bin', 'windows', 'crwu.exe')
    : join(REPO_ROOT, 'bin', 'darwin', 'crwu')
  if (!existsSync(built)) {
    throw new Error(`找不到本仓构建产物 ${built}\n  先跑 \`make build\`（它把 crwu 交叉编译成 darwin + windows 两份）`)
  }
  await mkdir(dirname(target), { recursive: true })
  await copyFile(built, target)
  await chmod(target, 0o755)
  return {
    source: 'repo-build',
    sourceVersion: await crwuSourceVersion(),
    target: isWindowsPlatform(platform) ? 'windows/amd64' : 'darwin/arm64',
    buildCommit: REPO_COMMIT,
  }
}

/** 本仓 commit（构建 crwu 时写进了 `internal/buildinfo`，清单里是可复现性的关键字段）。 */
async function repoCommit() {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
    return stdout.trim()
  } catch (error) {
    void error
    return 'unknown'
  }
}

/**
 * crwu 的版本号。
 *
 * 取自 `Makefile` 的 `VERSION`（与 `internal/buildinfo` 同一事实源，见根 `AGENTS.md`：
 * 「Keep the default application version synchronized between `internal/buildinfo` and the
 * root `Makefile`」）。**不执行**刚装配出来的二进制：win32 那份在 macOS 上根本跑不起来，
 * 而且「构建脚本顺带运行产物」正是本仓要避免的一类副作用。
 */
async function crwuSourceVersion() {
  try {
    const text = await readFile(join(REPO_ROOT, 'Makefile'), 'utf8')
    return /^VERSION\s*\??=\s*(\S+)/m.exec(text)?.[1] ?? ''
  } catch (error) {
    void error
    return ''
  }
}

const REPO_COMMIT = await repoCommit()

/** ossutil：URL 与 sha256 取自内置清单，避免两处维护同一组地址。 */
async function stageOssutil(platform, target, checkOnlyRun) {
  const spec = OSSUTIL_PLATFORMS[platform]
  if (spec === undefined) throw new Error(`清单里没有 ${platform} 的 ossutil 包`)
  if (checkOnlyRun) {
    return { archiveSha256: spec.sha256, source: spec.url, sourceVersion: OSSUTIL_VERSION, target: platform }
  }
  const archive = await fetchVerified(spec.url, spec.sha256, `ossutil-${platform}.zip`)
  await extractMember(archive, spec.member, target)
  return { archiveSha256: spec.sha256, source: spec.url, sourceVersion: OSSUTIL_VERSION, target: platform }
}

/** 找到 dws 的平台归档：优先 $DWS_ASSETS_DIR，否则从 npm 拉固定版本。 */
async function dwsArchive(platform) {
  const name = isWindowsPlatform(platform) ? 'dws-windows-amd64.zip' : 'dws-darwin-arm64.tar.gz'
  const local = process.env.DWS_ASSETS_DIR
  if (local !== undefined && local !== '') return { archive: join(local, name), assets: local }

  await mkdir(CACHE, { recursive: true })
  const marker = join(CACHE, `dws-${DWS_VERSION}`)
  const assets = join(marker, 'package', 'assets')
  if (!existsSync(assets)) {
    const work = await mkdtemp(join(tmpdir(), 'dws-pack-'))
    await run('npm', ['pack', `${DWS_PACKAGE}@${DWS_VERSION}`, '--pack-destination', work], { cwd: work })
    const [tgz] = (await run('ls', [work])).stdout.trim().split('\n')
    await mkdir(marker, { recursive: true })
    await run('tar', ['-xzf', join(work, tgz), '-C', marker])
    await rm(work, { recursive: true, force: true })
  }
  return { archive: join(assets, name), assets }
}

/** dws 的 sha256 来自包内 checksums.txt（不把哈希抄进本仓，避免与上游漂移）。 */
async function dwsExpectedSha(assets, archive) {
  const name = archive.split('/').pop()
  const text = await readFile(join(assets, 'checksums.txt'), 'utf8')
  for (const line of text.split('\n')) {
    const [hash, file] = line.trim().split(/\s+/)
    if (file === name) return hash
  }
  throw new Error(`checksums.txt 里没有 ${name}`)
}

async function stageDws(platform, target, checkOnlyRun) {
  const { archive, assets } = await dwsArchive(platform)
  if (!existsSync(archive)) throw new Error(`找不到 dws 归档 ${archive}`)
  // `checksums.txt` 记的是**归档**的 sha256，不是解包后二进制的 —— 校验收到的字节，
  // 解包结果由 `tar`/`unzip` 决定（同一归档必然产出同一文件）。
  const expected = await dwsExpectedSha(assets, archive)
  const actual = await sha256(archive)
  if (actual !== expected) {
    throw new Error(`dws 归档 sha256 不匹配（${platform}）：\n  ${archive}\n  期望 ${expected}\n  实际 ${actual}`)
  }
  if (checkOnlyRun) {
    return {
      archiveSha256: expected,
      source: `${DWS_PACKAGE}@${DWS_VERSION}/${archive.split('/').pop()}`,
      sourceVersion: DWS_VERSION,
      target: platform,
    }
  }
  const member = isWindowsPlatform(platform) ? 'dws.exe' : 'dws'
  await extractMember(archive, member, target)
  return {
    archiveSha256: expected,
    source: `${DWS_PACKAGE}@${DWS_VERSION}/${archive.split('/').pop()}`,
    sourceVersion: DWS_VERSION,
    target: platform,
  }
}

/** 一次装配的产物清单：每个平台每个工具都要有来源、版本、大小与最终哈希。 */
async function writeManifest(entries) {
  const payload = {
    schemaVersion: BIN_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    platforms: entries,
  }
  await writeFile(join(OUT_ROOT, BIN_MANIFEST_NAME), `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

/** `--check`：按清单重算**最终文件**的 size 与 sha256，而不只是看文件在不在。 */
async function checkAssembled() {
  const loaded = await readBinManifest(join(OUT_ROOT, BIN_MANIFEST_NAME))
  if (loaded.ok === false) {
    console.error('[binaries] 校验未通过：')
    console.error(`  - ${loaded.error}`)
    console.error('  跑 `node scripts/sync-binaries.mjs` 装配（它会先清空平台目录并重写 manifest）。')
    process.exit(1)
  }
  const problems = await verifyBinDir(OUT_ROOT, loaded.manifest, { requireAll: true })
  if (problems.length > 0) {
    console.error('[binaries] 校验未通过：')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('  跑 `node scripts/sync-binaries.mjs` 重新装配（它会先清空平台目录并重写 manifest）。')
    process.exit(1)
  }
  console.log(`[binaries] 已装配 ${PLATFORMS.length} 个平台 × ${BIN_TOOLS.length} 个二进制；按 manifest 重算 size 与 sha256 全部一致`)
}

async function assemble() {
  const platforms = []
  for (const platform of PLATFORMS) {
    const dir = join(OUT_ROOT, platform)
    // **先清空平台目录再装配**，不是 `mkdir -p` 就完事：
    // 手工跑一次二进制核对（`./bin/darwin-arm64/dws version`）会让 dws 在自己旁边落一个
    // `.dws/` 状态目录（`.data.lock` + `logs/dws.log`），而 `files` 里的 `bin/` 会把它整包带走 ——
    // 实测就是这么混进 `npm pack` 清单的（0 字节，但那是**运行产物**，而且 dws 的日志将来可能带凭据）。
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    const tools = []

    const crwu = join(dir, exeName('crwu', platform))
    const crwuMeta = await stageCrwu(platform, crwu)
    tools.push(await toolEntry('crwu', platform, crwu, crwuMeta))
    console.log(`[binaries] crwu    ${platform} → ${crwu} (${(await stat(crwu)).size} B)`)

    const ossutil = join(dir, exeName('ossutil', platform))
    const ossSpec = OSSUTIL_PLATFORMS[platform]
    // 不按「文件已存在」跳过：落盘的二进制要靠下面的 sha256 说话，重做最省事也最安全。
    const ossMeta = await stageOssutil(platform, ossutil, false)
    tools.push(await toolEntry('ossutil', platform, ossutil, ossMeta))
    console.log(`[binaries] ossutil ${platform} → ${ossutil} (${(await stat(ossutil)).size} B)`)

    const dws = join(dir, exeName('dws', platform))
    const dwsMeta = await stageDws(platform, dws, false)
    tools.push(await toolEntry('dws', platform, dws, dwsMeta))
    console.log(`[binaries] dws     ${platform} → ${dws} (${(await stat(dws)).size} B) ← ${dwsMeta.source}`)

    platforms.push({ platform, tools })
  }
  const manifest = await writeManifest(platforms)
  console.log(`[binaries] 完成：${OUT_ROOT}（manifest ${manifest.platforms.length} 个平台 × ${BIN_TOOLS.length} 个工具）`)
}

/** 清单条目：来源 + 版本 + 目标 + **最终文件** size/sha256（归档哈希另记）。 */
async function toolEntry(tool, platform, path, meta) {
  return {
    tool,
    file: exeName(tool, platform),
    platform,
    source: meta.source,
    sourceVersion: meta.sourceVersion ?? '',
    target: meta.target ?? platform,
    ...(meta.buildCommit === undefined ? {} : { buildCommit: meta.buildCommit }),
    ...(meta.archiveSha256 === undefined ? {} : { archiveSha256: meta.archiveSha256 }),
    size: (await stat(path)).size,
    sha256: await sha256(path),
  }
}

async function main() {
  if (checkOnly) {
    await checkAssembled()
    return
  }
  await assemble()
}

await main()
