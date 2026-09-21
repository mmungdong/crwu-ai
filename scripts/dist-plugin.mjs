/**
 * 把插件 tarball 发到 OSS，并**守住「同版本只发一次」**。
 *
 * 为什么需要这条纪律（用户 2026-09-21 明确要求）：分发包的 URL 是 `<包名>-<版本>.tgz`，
 * 员工侧 `dsh plugin add <URL>` 认的就是这个 URL。如果同一个版本号被重发一次，URL 不变而内容
 * 变了，就会出现「同一版本号、两份内容」：
 *   - 早装的员工和重装的员工跑的**不是同一份代码**，报同一个版本号却对不上；
 *   - 出问题回滚/复现时无法确定那个版本到底是哪一份；
 *   - `dsh plugin add` 也未必真的会替换（pnpm 见 spec 未变就跳过，实测过）。
 * 所以：**改了内容就升版本号**，不要覆盖已发布的同版本对象。
 *
 * 三种结果：
 *   1. 远端没有该对象            → 上传（dry-run 只打印）；
 *   2. 远端有、MD5 与本地一致    → 什么都不做（幂等，重复跑不会踩到远端）；
 *   3. 远端有、MD5 或大小不一致  → **拒绝上传**，退出码 1，提示升版本号；
 *      `ossutil stat` 读不出来（网络/权限/输出变了）也按第 3 种处理 —— 安全默认，
 *      不确定的时候宁可不动远端。
 *
 * 用法：node scripts/dist-plugin.mjs --tgz <文件> --config <crwu-workbench.yml> \
 *                                    [--dry-run] [--self-test]
 *
 * `--self-test` 只跑判定逻辑（不起进程、不联网），`make plugin-check` 与 CI 都会跑它。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { distributionTargetsFromFile } from './plugin-distribution-config.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag.startsWith('--')) continue
    const name = flag.slice(2)
    if (name === 'dry-run' || name === 'self-test') {
      args[name === 'dry-run' ? 'dryRun' : 'selfTest'] = true
      continue
    }
    args[name] = argv[index + 1]
    index += 1
  }
  return args
}

/**
 * 唯一一处判定：远端状态 + 本地摘要 → 该做什么。
 * `remote` 为 null = 远端没有该对象；`{ unknown: true }` = 读不出来（网络/权限/输出变了）。
 */
export function decide(localMd5, remote) {
  if (remote === null) return 'upload'
  if (remote.unknown === true) return 'unknown'
  return remote.md5 === localMd5 ? 'skip' : 'refuse'
}

/**
 * 自检：判定表必须保持这四条。任何一条变红都说明「同版本只发一次」的纪律被改松了 ——
 * 尤其是 `refuse`（同版本不同内容必须拒绝）与 `unknown`（读不出来时不动远端）。
 */
function selfTest() {
  const cases = [
    ['远端没有该对象 → 上传', decide('a', null), 'upload'],
    ['远端同一份 → 跳过（幂等）', decide('a', { md5: 'a', size: 1 }), 'skip'],
    ['远端同版本不同内容 → 拒绝', decide('a', { md5: 'b', size: 1 }), 'refuse'],
    ['远端读不出来 → 按「不确定」处理', decide('a', { unknown: true }), 'unknown'],
  ]
  const problems = cases.filter(([, actual, expected]) => actual !== expected)
  for (const [label, actual, expected] of cases) {
    console.log(`${actual === expected ? 'OK  ' : 'FAIL'} ${label}（${actual}）`)
  }
  if (problems.length > 0) {
    console.error(`FAIL dist-plugin 判定自检：${problems.length} 条不符`)
    process.exit(1)
  }
  console.log('PASS dist-plugin 判定自检：4 条')
}

const args = parseArgs(process.argv.slice(2))
if (args.selfTest === true) {
  selfTest()
  process.exit(0)
}
if (!args.tgz || !args.config) {
  console.error('用法：node scripts/dist-plugin.mjs --tgz <文件> --config <crwu-workbench.yml> [--dry-run]')
  process.exit(2)
}

const tgz = args.tgz
const { ossUrl, installUrl } = distributionTargetsFromFile(args.config, basename(tgz))
const dryRun = args.dryRun === true

/** 本机 tarball 的 MD5（base64，与 OSS `Content-Md5` 同格式）与字节数。 */
const bytes = readFileSync(tgz)
const localMd5 = createHash('md5').update(bytes).digest('base64')
const localSize = statSync(tgz).size

/** 只读查一次远端元信息；查不到（404 / 网络 / 权限）都返回 null，由调用方按「不确定」处理。 */
function statRemote() {
  const result = spawnSync('ossutil', ['stat', ossUrl], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // 404：对象不存在（ossutil 1.7 对 NoSuchKey 走 stderr，退出码是 0 —— 不能只看退出码）。
  if (/NoSuchKey|StatusCode=404/.test(output)) return null
  const md5 = /^Content-Md5\s*:\s*(\S+)/m.exec(output)?.[1]
  const size = Number(/^Content-Length\s*:\s*(\d+)/m.exec(output)?.[1] ?? Number.NaN)
  if (md5 === undefined || Number.isNaN(size)) return { unknown: true, output }
  return { md5, size }
}

console.log(`[dist] 本地 ${tgz}`)
console.log(`[dist]       ${localSize} 字节 · md5 ${localMd5}`)
console.log(`[dist] 远端 ${ossUrl}`)

const remote = statRemote()
const action = decide(localMd5, remote)

if (action === 'upload') {
  console.log('[dist] 远端没有这个对象')
  if (dryRun) {
    console.log(`[dist] --dry-run：不执行 ossutil cp -f ${tgz} ${ossUrl}`)
  } else {
    const upload = spawnSync('ossutil', ['cp', '-f', tgz, ossUrl], { stdio: 'inherit' })
    if ((upload.status ?? 1) !== 0) {
      console.error(`[dist] 上传失败（ossutil 退出码 ${upload.status}），远端保持原样`)
      process.exit(1)
    }
    console.log('[dist] 已上传')
  }
} else if (action === 'unknown') {
  console.error('[dist] 读不出远端对象的元信息（网络/权限/输出格式变了？）。')
  console.error('[dist] 不确定远端内容时**不动远端** —— 请人工确认后重跑。原始输出：')
  console.error(remote.output.trim())
  process.exit(1)
} else if (action === 'skip') {
  console.log(`[dist] 远端已有同一份（md5 ${remote.md5}），无需重发`)
} else {
  console.error(`[dist] 远端已存在 ${ossUrl}`)
  console.error(`[dist]       远端 ${remote.size} 字节 · md5 ${remote.md5}`)
  console.error(`[dist]       本地 ${localSize} 字节 · md5 ${localMd5}`)
  console.error('[dist] 同版本号的两份内容会让员工之间装的不是同一份，且版本号失去意义 —— 拒绝上传。')
  console.error('[dist] 正确做法：升版本号后发布（在插件目录里 `npm run version:set <新版本>`，')
  console.error('[dist] 手动往 CHANGELOG.md 加一节，再跑 make plugin-dist）。')
  process.exit(1)
}

if (installUrl !== '') {
  console.log('')
  console.log('员工安装 / 升级（在员工机器的 DSH 上执行，然后重启 profile）：')
  console.log(`  dsh plugin --profile web add ${installUrl}`)
}
