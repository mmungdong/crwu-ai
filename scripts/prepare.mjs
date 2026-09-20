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
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE_MARKERS = ['tsconfig.json', 'tsdown.config.ts', join('src', 'index.ts'), join('src', 'client', 'index.ts')]

/** 源码是否齐备（齐备 = 我们在 git 克隆里，可以构建）。 */
export function missingSources() {
  return SOURCE_MARKERS.filter((marker) => !existsSync(join(ROOT, marker)))
}

export function build() {
  console.log('[build] tsdown 构建 lib/ …')
  const result = spawnSync('tsdown', { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) {
    console.error(`[build] 构建失败：${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

/** 供测试使用：按给定模式决定跳过还是构建。 */
export function run({ force }) {
  const missing = missingSources()
  if (missing.length > 0) {
    if (force) {
      console.error(`[build] 缺少构建所需文件：${missing.join(', ')}`)
      return 1
    }
    console.log(`[build] 跳过构建：这是已发布的预构建产物（缺 ${missing.join(', ')}），lib/ 已随包提供。`)
    return 0
  }
  return build()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run({ force: process.argv.includes('--force') }))
}
