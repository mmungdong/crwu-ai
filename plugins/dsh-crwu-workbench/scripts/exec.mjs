/**
 * 跨平台启动 `npm`。
 *
 * 为什么需要它：Windows 上 npm 是 `npm.cmd`，而 `execFile('npm', …)` **不走 shell** ——
 * CreateProcess 只会去找 `npm.exe`，Node ≥ 20.12 起还会直接拒绝 `.bat`/`.cmd`，
 * 结果就是 ENOENT / EINVAL。CI 的 `windows-latest`（Node 22 与 24 都是）正是挂在这一点上，
 * 而 macOS / Linux 上永远看不到。
 *
 * 做法：用**当前这个 node** 跑 npm 自己的 JS 入口，既不需要 shell（不用担心参数里的空格
 * 被 cmd 重新解析），也不依赖 `.cmd` 能不能被 spawn。候选顺序：
 *   1. `npm_execpath` —— `npm run …` 下由 npm 自己注入，CI 的每一步都是 `npm run …`；
 *   2. 常见安装布局（官方 tarball / nvm / fnm / setup-node）；
 *   3. `resolvePackageCli('npm')` —— 走 Node 自己的 node_modules 解析（pnpm / 工作区布局）；
 *   4. 都找不到才退回裸命令名（win32 给 `npm.cmd`）。
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolvePackageCli } from './lib/cli-entry.mjs'

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch (error) {
    void error
    return false
  }
}

export function npmInvocation() {
  const fromEnv = typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath : ''
  const bin = dirname(process.execPath)
  const candidates = [
    fromEnv,
    join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(bin), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const cli of candidates) {
    if (cli !== '' && isFile(cli)) return { command: process.execPath, args: [cli] }
  }
  try {
    // 第 3 条：包管理器把 npm 装进了某个 node_modules（pnpm / 工作区）时也能解析出来。
    return { command: process.execPath, args: [resolvePackageCli('npm', { from: process.cwd(), binName: 'npm' })] }
  } catch (error) {
    // 解析不到不是异常：下面这条兜底与历史行为一致。
    void error
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
}
