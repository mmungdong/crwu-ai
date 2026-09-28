/**
 * 构建入口：`prepare`（git 安装 / 本地开发）与 `prepack`（发布前）都用它。
 *
 * **这个文件必须随包发布**（在 package.json 的 `files` 里）：npm 在**安装已发布的 tarball** 时
 * 也会执行 `prepare`，如果它不在包里，装包的人会看到
 * `npm error command sh -c node scripts/prepare.mjs`。这里连踩了两次，都记下来：
 *   1. `prepare: "tsdown"` → tarball 里没有 `tsconfig.json` / `tsdown.config.ts`，tsdown 直接失败；
 *   2. `prepare: "node scripts/build.mjs"` → `scripts/` 不在 `files` 里，脚本本身找不到。
 *
 * 两条路径怎么区分（判据是源码在不在）：
 *   - **git 安装 / 本地开发**：源码在 → 真的构建。
 *   - **npm 安装已发布产物**：源码不在 → 跳过（`lib/` 已随包提供）。
 *
 * 发布路径不允许静默出一个没有 `lib/` 的包：`prepack` 用 `--force`，源码不在即失败。
 *
 * ## 为什么不再 `spawnSync('tsdown', { shell: process.platform === 'win32' })`
 *
 * 那条命令在 Windows 上只能靠 shell 才能找到 `tsdown.cmd`，而**一旦过 shell，项目路径里的
 * 空格与单引号就会被第二套解析规则改写**（`C:\Users\张三\Case's Work\…` 必踩），
 * 退出码与 stderr 也可能被 shell 自己吃掉。现在解析出 tsdown 的 **JS 入口**、用
 * `process.execPath` 直接执行（`scripts/lib/cli-entry.mjs`）：没有 shell，就没有第二次解析。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeCommand, resolvePackageCli } from './lib/cli-entry.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE_MARKERS = ['tsconfig.json', 'tsdown.config.ts', join('src', 'index.ts'), join('src', 'client', 'index.ts')]

/** 源码是否齐备（齐备 = 我们在 git 克隆里，可以构建）。 */
export function missingSources(root = ROOT) {
  return SOURCE_MARKERS.filter((marker) => !existsSync(join(root, marker)))
}

/**
 * 这一次构建要跑的**精确 argv**（不含 shell）。
 *
 * 导出它是为了让测试能直接断言「命令位置是当前 node + tsdown 的 JS 入口」，
 * 而不是靠跑一遍构建去间接猜。tsdown 没装时抛错，由 `build()` 翻成退出码 1。
 */
export function buildPlan(root = ROOT) {
  const entry = resolvePackageCli('tsdown', { from: root, binName: 'tsdown' })
  return { ...nodeCommand(entry), cwd: root }
}

/**
 * 真构建。
 *
 * 进度日志一律走 **stderr**：stdout 留给机器可读输出。npm 10（Node 22 自带）在
 * `npm pack --dry-run --json --ignore-scripts` 下仍然会执行 prepare，这些日志一旦混进
 * stdout，消费 `--json` 的脚本 `JSON.parse` 就炸了（CI 的 ubuntu/node22 就是这么红的）。
 * 子进程的 stdout 也转去 stderr（'inherit' 会让 tsdown 的 ℹ 行落进我们的 stdout）。
 *
 * @param {{ root?: string, spawn?: typeof spawnSync, log?: (message: string) => void }} [options]
 */
export function build(options = {}) {
  const root = options.root ?? ROOT
  const spawn = options.spawn ?? spawnSync
  const log = options.log ?? ((message) => console.error(message))
  log('[build] tsdown 构建 lib/ …')

  let plan
  try {
    plan = buildPlan(root)
  } catch (error) {
    log(`[build] 构建失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  // **没有 shell**：argv 原样交给 CreateProcess / posix_spawn，路径里的空格与引号不参与解析。
  const result = spawn(plan.command, plan.args, { cwd: plan.cwd, stdio: ['inherit', 2, 'inherit'] })
  if (result.error) {
    log(`[build] 构建失败：${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

/** 供测试使用：按给定模式决定跳过还是构建。 */
export function run(options = {}) {
  const root = options.root ?? ROOT
  const log = options.log ?? ((message) => console.error(message))
  const missing = missingSources(root)
  if (missing.length > 0) {
    if (options.force === true) {
      log(`[build] 缺少构建所需文件：${missing.join(', ')}`)
      return 1
    }
    log(`[build] 跳过构建：这是已发布的预构建产物（缺 ${missing.join(', ')}），lib/ 已随包提供。`)
    return 0
  }
  return build({ ...options, root, log })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run({ force: process.argv.includes('--force') }))
}
