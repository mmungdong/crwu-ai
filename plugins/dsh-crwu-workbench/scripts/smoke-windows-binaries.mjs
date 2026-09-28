/**
 * 发布二进制冒烟：**在目标平台上真的把二进制启动一次**。
 *
 * ## 为什么不能只看哈希
 *
 * 发布链路原先在 macOS 上交叉编译六个二进制、核对清单与 SHA-256 就发出去 —— 哈希一致只证明
 * 「文件没变」，不证明「在 Windows 上能跑」。踩过的形态：`.exe` 是坏的 / 架构不对（报
 * 「不是有效的 Win32 应用程序」）、缺 DLL、被杀软拦下、`powershell` 里根本找不到文件。
 * 这些在 macOS 上永远看不出来，只有员工装完才暴露。
 *
 * 所以这里做四件事（全部针对 `bin/manifest.json` 里**声明过的**平台）：
 *   1. 清单里每个平台、每个工具：文件存在、字节数与 sha256 与清单一致；
 *   2. 把该平台的可执行文件复制到临时目录，`HOME` / `USERPROFILE` / `TMPDIR` 一并指过去，
 *      再用**无副作用**的命令各跑一次，断言进程真的启动、退出码符合约定；
 *   3. 断言发布树（`bin/`）没有运行残留（例如 `dws` 会在当前目录旁建状态目录）；
 *   4. 清单里**没有**的平台一律如实报「该平台没有随包二进制」，绝不退到别的架构上。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/smoke-windows-binaries.mjs                    # 默认 win32-x64（CI 的 Windows runner）
 * node scripts/smoke-windows-binaries.mjs --platform=darwin-arm64   # 本机自检
 * node scripts/smoke-windows-binaries.mjs --all
 * ```
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BIN_PLATFORMS, binFileName } from './bin-manifest.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN_DIR = join(PLUGIN_DIR, 'bin')
const MANIFEST = join(BIN_DIR, 'manifest.json')
const DEFAULT_PLATFORM = 'win32-x64'

/**
 * 每个工具的「无副作用命令」与它约定的退出码。
 *
 * 退出码是在 darwin 产物上实测得到的（`--help` / `version` 都回 0），Windows 产物是同一份
 * Go / 上游源码编出来的，语义一致；真跑出非零就是**这次发布有问题**，不是「约定变了」。
 */
const PROBES = [
  { tool: 'crwu', args: ['--help'], expected: [0], why: 'Go CLI 打印用法后回 0' },
  { tool: 'ossutil', args: ['--help'], expected: [0], why: 'ossutil 打印用法后回 0' },
  { tool: 'dws', args: ['version'], expected: [0], why: 'dws 打印版本后回 0（不吃 stdin、不联网）' },
]

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 递归列出目录内全部文件（相对 bin/ 的路径），用来对比运行前后有没有残留。 */
function listTree(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTree(full, base))
    else out.push(full.slice(base.length + 1))
  }
  return out.sort()
}

function parseArgs(argv) {
  const options = { platforms: [DEFAULT_PLATFORM] }
  for (const arg of argv.slice(2)) {
    if (arg === '--all') options.platforms = null
    else if (arg.startsWith('--platform=')) options.platforms = [arg.slice('--platform='.length)]
    else throw new Error(`无法识别的参数：${arg}`)
  }
  return options
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`FAIL  找不到 ${MANIFEST}（发布作业要先跑 node scripts/sync-binaries.mjs 装配 bin/）`)
    return 1
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const declared = new Map((manifest.platforms ?? []).map((entry) => [String(entry.platform ?? ''), entry]))
  const wanted = parseArgs(process.argv).platforms ?? [...declared.keys()]

  let failed = 0
  for (const platform of wanted) {
    const entry = declared.get(platform)
    if (entry === undefined) {
      // 明确报「该平台没有随包二进制」，绝不拿别的架构顶上（插件侧同样如此：
      // `binPlatformDir()` 返回空串 → capability gap，不回退 x64）。
      console.error(`FAIL  ${platform}：bin/manifest.json 没有声明这个平台（发布范围：${[...declared.keys()].join(' / ') || '空'}）`)
      failed += 1
      continue
    }
    failed += smokePlatform(platform, entry)
  }

  if (failed > 0) {
    console.error(`\n发布二进制冒烟：${String(failed)} 项失败`)
    return 1
  }
  console.log(`\nPASS  发布二进制冒烟：${wanted.join(' / ')} 全部启动正常、哈希一致、发布树无残留`)
  return 0
}

function smokePlatform(platform, entry) {
  let failed = 0
  const tools = Array.isArray(entry.tools) ? entry.tools : []
  if (tools.length === 0) {
    console.error(`FAIL  ${platform}：清单里没有任何工具`)
    return 1
  }
  if (!BIN_PLATFORMS.includes(platform)) {
    console.error(`FAIL  ${platform}：这个平台不在随包发布范围里（${BIN_PLATFORMS.join(' / ')}）`)
    return 1
  }

  const before = listTree(BIN_DIR)
  const sandbox = mkdtempSync(join(tmpdir(), `crwu-bin-smoke-${platform.replace(/[^\w-]/g, '_')}-`))
  try {
    // ① 清单完整性：文件在、字节数对、sha256 对。
    for (const tool of tools) {
      const file = String(tool.file ?? '')
      const path = join(BIN_DIR, platform, file)
      if (file === '' || !existsSync(path)) {
        console.error(`FAIL  ${platform}/${String(tool.tool)}：清单声明了 ${file} 但文件不存在`)
        failed += 1
        continue
      }
      const size = statSync(path).size
      if (size !== tool.size) {
        console.error(`FAIL  ${platform}/${String(tool.tool)}：字节数不一致（磁盘 ${String(size)} / 清单 ${String(tool.size)}）`)
        failed += 1
        continue
      }
      const digest = sha256(path)
      if (digest !== tool.sha256) {
        console.error(`FAIL  ${platform}/${String(tool.tool)}：sha256 不一致（磁盘 ${digest} / 清单 ${String(tool.sha256)}）`)
        failed += 1
        continue
      }
    }

    // ② 真正启动：复制到临时目录，把 HOME/USERPROFILE/TMPDIR 都指过去（任何状态都落在那里）。
    for (const probe of PROBES) {
      const declaredTool = tools.find((tool) => String(tool.tool ?? '') === probe.tool)
      if (declaredTool === undefined) continue
      const name = binFileName(probe.tool, platform)
      const source = join(BIN_DIR, platform, name)
      if (!existsSync(source)) {
        console.error(`FAIL  ${platform}/${probe.tool}：${source} 不存在`)
        failed += 1
        continue
      }
      const target = join(sandbox, name)
      copyFileSync(source, target)
      const result = spawnSync(target, probe.args, {
        cwd: sandbox,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
      })
      if (result.error !== undefined) {
        console.error(`FAIL  ${platform}/${probe.tool}：进程起不来 —— ${result.error.message}`)
        failed += 1
        continue
      }
      const blob = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      if (/not a valid Win32 application|不是有效的 Win32|ENOEXEC|Exec format error/i.test(blob)) {
        console.error(`FAIL  ${platform}/${probe.tool}：架构/格式不对 —— ${blob.slice(0, 300)}`)
        failed += 1
        continue
      }
      if (!probe.expected.includes(result.status ?? -1)) {
        console.error(`FAIL  ${platform}/${probe.tool}：${probe.args.join(' ')} 退出码 ${String(result.status)}（期望 ${probe.expected.join('/')}）`)
        console.error(blob.slice(0, 600))
        failed += 1
        continue
      }
      console.log(`OK    ${platform}/${probe.tool} ${probe.args.join(' ')} → 退出码 ${String(result.status)}（${probe.why}）`)
    }

    // ③ 发布树不许有运行残留（`dws` 这类 CLI 会在工作目录旁建状态目录）。
    const after = listTree(BIN_DIR)
    const added = after.filter((file) => !before.includes(file))
    if (added.length > 0) {
      console.error(`FAIL  ${platform}：发布树里出现了运行残留 —— ${added.slice(0, 5).join(', ')}`)
      failed += 1
    }
    if (existsSync(join(BIN_DIR, platform, '.dws'))) {
      console.error(`FAIL  ${platform}：bin/${platform}/.dws 被创建了（发布树必须干净）`)
      failed += 1
    }
  } finally {
    // 只清自己 mkdtemp 出来的目录。
    if (sandbox.startsWith(tmpdir())) rmSync(sandbox, { recursive: true, force: true })
  }
  return failed
}

process.exit(main())
