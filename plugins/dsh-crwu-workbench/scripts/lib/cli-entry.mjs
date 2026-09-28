/**
 * 解析一个 npm 包的 **JS CLI 入口**，并用**当前这个 node** 直接执行它。
 *
 * ## 为什么不能 `spawn('tsdown', …, { shell: true })`
 *
 * Windows 上包的可执行文件是 `node_modules/.bin/tsdown.cmd`（外加 `.ps1`），
 * `CreateProcess` 既不认无扩展名的 `tsdown`，Node ≥ 20.12 还会直接拒绝 spawn `.cmd`；
 * 于是只能开 `shell: true` —— 而一旦过 shell，**项目路径里的空格就会被第二套解析规则改写**
 * （`C:\Users\张三\Case's Work\...` 每次都踩），而且退出码与 stderr 还可能被 shell 自己吃掉。
 *
 * 做法与 `exec.mjs` 对 npm 的做法一致：解析出包的 JS 入口文件，用 `process.execPath` 起它。
 * 没有 shell，就没有第二次解析。
 *
 * ## 解析顺序
 *
 * 1. `createRequire(<from>/package.json).resolve('<pkg>/package.json')` —— 走 Node 自己的
 *    node_modules 解析（npm / pnpm / yarn 布局都认，软链接也认）；
 * 2. 读该 package.json 的 `bin`，按 `binName` 取出入口相对路径；
 * 3. 只接受**真实存在的 .js / .mjs / .cjs**：命中 `.cmd` / `.ps1` / shell 脚本一律报错，
 *    绝不退回「让 shell 去跑它」—— 那正是本模块要消灭的形态。
 *
 * 解析不到就**抛错**（带可读原因），由调用方决定是失败还是降级；不静默换一种执行方式。
 */
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 可执行入口必须是 JS，不能是 Windows 的 `.cmd` / `.ps1` shim。 */
const JS_ENTRY = /\.(?:mjs|cjs|js)$/i

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch (error) {
    // 权限 / 断链：都只意味着「这个候选不可用」。
    void error
    return false
  }
}

/** `bin` 字段既可能是字符串，也可能是 `{ 名字: 相对路径 }`。 */
function binEntryOf(bin, binName, packageName) {
  if (typeof bin === 'string') return bin
  if (bin !== null && typeof bin === 'object') {
    const table = bin
    const wanted = binName !== '' ? binName : packageName.split('/').pop() ?? ''
    const direct = table[wanted]
    if (typeof direct === 'string') return direct
    // 只有一个入口时按它走（包名与命令名不一致的包，例如 `@scope/tool` → `tool-cli`）。
    const values = Object.values(table).filter((value) => typeof value === 'string')
    if (values.length === 1) return values[0]
  }
  return ''
}

/**
 * 解析 `<packageName>` 的 CLI 入口绝对路径。
 *
 * @param {string} packageName 包名，例如 `tsdown`
 * @param {{ from?: string, binName?: string }} [options] `from` = 解析起点目录（默认本文件所属插件根）
 * @returns {string} 入口文件的绝对路径（一定是 JS 文件）
 * @throws 解析不到、或只找到非 JS shim 时
 */
export function resolvePackageCli(packageName, options = {}) {
  const from = options.from ?? process.cwd()
  const binName = options.binName ?? ''
  const require_ = createRequire(pathToFileURL(join(from, 'package.json')).href)

  let manifestPath = ''
  try {
    manifestPath = require_.resolve(`${packageName}/package.json`)
  } catch (error) {
    throw new Error(`找不到 ${packageName}：${error instanceof Error ? error.message : String(error)}`)
  }
  let manifest
  try {
    manifest = require_(manifestPath)
  } catch (error) {
    throw new Error(`${packageName} 的 package.json 读不出来：${error instanceof Error ? error.message : String(error)}`)
  }
  const relative = binEntryOf(manifest?.bin, binName, packageName)
  const candidates = []
  if (relative !== '') {
    candidates.push(isAbsolute(relative) ? relative : resolve(dirname(manifestPath), relative))
  }
  // 少数包不写 `bin` 或写法不规范：按常见入口名兜底（仍然只接受 JS 文件）。
  const packageDir = dirname(manifestPath)
  const name = packageName.split('/').pop() ?? packageName
  candidates.push(
    join(packageDir, 'dist', `${name}.mjs`),
    join(packageDir, 'dist', `${name}.js`),
    join(packageDir, 'dist', 'run.mjs'),
    join(packageDir, 'bin', `${name}.mjs`),
    join(packageDir, 'bin', `${name}.js`),
  )

  for (const candidate of candidates) {
    if (JS_ENTRY.test(candidate) && isFile(candidate)) return candidate
  }
  const shim = join(from, 'node_modules', '.bin', binName !== '' ? binName : name)
  if (existsSync(shim)) {
    throw new Error(`${packageName} 只找到了 ${shim}（Windows 上是 .cmd/.ps1 shim）—— 不要用 shell 去跑它，` +
      '请在 package.json 里为该包声明 JS 入口，或让上游补上规范入口')
  }
  throw new Error(`${packageName} 没有可用的 JS 入口（试过：${candidates.join(', ')}）`)
}

/** 把入口包成「用当前 node 执行」的 argv。 */
export function nodeCommand(entryPath, args = []) {
  return { command: process.execPath, args: [entryPath, ...args] }
}
