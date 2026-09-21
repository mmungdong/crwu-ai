/**
 * 跨平台启动 `npm`。
 *
 * 为什么需要它：Windows 上 npm 是 `npm.cmd`，而 `execFile('npm', …)` **不走 shell** ——
 * CreateProcess 只会去找 `npm.exe`，Node ≥ 20.12 起还会直接拒绝 `.bat`/`.cmd`，
 * 结果就是 ENOENT / EINVAL。CI 的 `windows-latest`（Node 22 与 24 都是）正是挂在这一点上，
 * 而 macOS / Linux 上永远看不到。
 *
 * 做法：用**当前这个 node** 跑 npm 自己的 JS 入口，既不需要 shell（不用担心参数里的空格
 * 被 cmd 重新解析），也不依赖 `.cmd` 能不能被 spawn：
 *   1. `npm_execpath` —— `npm run …` 下由 npm 自己注入，CI 的每一步都是 `npm run …`；
 *   2. 常见安装布局（官方 tarball / nvm / fnm / setup-node）；
 *   3. 都找不到才退回裸命令名（win32 给 `npm.cmd`）。
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
}
