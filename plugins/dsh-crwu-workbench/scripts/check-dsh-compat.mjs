/**
 * DSH 运行时兼容矩阵：**真的装一遍**，而不是只读一遍 peer 区间。
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-09-28 的事故：插件的 DSH peer 只写了 `^0.1.7-rc.2`（= `>=0.1.7-rc.2 <0.2.0-0`），
 * DSH 升到 `0.2.0-rc.1` 之后整包被判不兼容 —— 症状是「装上了但被禁用」，而代码一行没跑。
 * 扩区间的那次修改（`22b31b9`）只带了一条读区间字符串的单元测试，它证明不了
 * 「DSH 真的会加载这个包」：DSH 的判据是 `@deepseek-ai/dsh-app-boot` 的
 * `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`，输入是**已安装的**
 * 插件 package.json 与**运行时自己的**版本。
 *
 * 所以这里做的三件事都是真的：
 *   1. `npm pack` 出真实 tarball，装进一个干净的临时工程（不靠 `--legacy-peer-deps` 掩盖）；
 *   2. 在临时工程里调用 DSH 自己的 `evaluatePluginCompatibility()`，断言返回 `undefined`
 *      （= 不被 skip / disable），并顺带断言 `0.3.x` **不在**声明范围内；
 *   3. 把 `src/` 复制过去、用**该版本**的 DSH 类型跑一次 `tsc --noEmit`（类型漂移只有这一步能发现）。
 *
 * ## fixture 从哪来
 *
 * 待装包集合由 `package.json` 的 peer + dependencies + devDependencies **加** `src/` 里真正
 * import 的 `@deepseek-ai/*` 模块共同生成，并把每个 `@deepseek-ai/dsh*` 逐个钉到目标版本。
 * 手写名单必然漏（`dsh-sandbox`、`cordis`、`dsh-util-values` 都漏过一次）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-dsh-compat.mjs                    # 全矩阵
 * node scripts/check-dsh-compat.mjs --runtime=0.2.0-rc.2
 * node scripts/check-dsh-compat.mjs --keep             # 保留临时工程（排障）
 * node scripts/check-dsh-compat.mjs --no-typecheck     # 只验安装与兼容判定（快）
 * ```
 *
 * 退出码 0 = 全部运行时通过。任何一步失败都会打印**结构化原因**并返回非 0。
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation } from './exec.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 声明支持、且**必须真的装一遍**的 DSH 运行时：一条声明线一个代表版本。
 *
 * `0.2.0-rc.1` → `0.2.0-rc.2` 的逐包比对结论（2026-09-29，16 个包全部 `npm pack` 后逐文件 diff）：
 * **所有 `.d.ts` 零差异**，13 个包只有 `package.json` 的版本号与内部依赖表变化，
 * 另外 3 个只有运行时代码的小改动 —— `dsh-subagent/lib/typert.host.js` 多一条
 * `user-question-reply` 协议声明、`dsh-client-ui-renderer/lib/client.js` 加一个 `useMemo`、
 * `dsh-client-ui-sidebar/lib/client.js` 去掉品牌按钮外层 `Tooltip` 并换版本号。
 * 所以 0.2 线用 rc.2 作代表即可（同线后续 rc 补丁与正式版由区间语义覆盖）。
 */
const RUNTIMES = ['0.1.7-rc.2', '0.2.0-rc.2']

/** 明确**不在**支持范围内：声明区间必须以这条为界（防止手滑写成 `>=0.1.7`）。 */
const OUT_OF_RANGE_RUNTIME = '0.3.0-rc.1'

const TEMP_PREFIX = 'crwu-dsh-compat-'

function log(message) {
  process.stderr.write(`${message}\n`)
}

function fail(message) {
  log(`FAIL  ${message}`)
  return false
}

/** 跑一条命令，继承 stdio 之外还收集输出；失败返回非 0 退出码。 */
function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PLUGIN_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      // **不走 shell**：参数里的空格/中文路径不能被第二套解析规则改写（Windows 尤其）。
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolveRun({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }))
    child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}

function parseArgs(argv) {
  const options = { keep: false, typecheck: true, runtimes: RUNTIMES }
  for (const arg of argv.slice(2)) {
    if (arg === '--keep') options.keep = true
    else if (arg === '--no-typecheck') options.typecheck = false
    else if (arg.startsWith('--runtime=')) {
      const wanted = arg.slice('--runtime='.length)
      if (!RUNTIMES.includes(wanted)) {
        throw new Error(`--runtime 只接受声明支持的版本：${RUNTIMES.join(' / ')}（收到 ${wanted}）`)
      }
      options.runtimes = [wanted]
    } else {
      throw new Error(`无法识别的参数：${arg}`)
    }
  }
  return options
}

/** `src/**` 里真正被 import 的 `@deepseek-ai/*` 包名（手写名单会漏，所以从源码里读）。 */
async function importedDeepseekPackages(srcDir) {
  const names = new Set()
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(full, 'utf8')
        for (const match of source.matchAll(/from\s+'(@deepseek-ai\/[^/']+)/g)) names.add(match[1])
      }
    }
  }
  await walk(srcDir)
  return [...names].sort()
}

/**
 * 生成临时工程的依赖表。
 *
 * 规则：`@deepseek-ai/dsh*` 一律钉到**目标运行时版本**；其余外部包取插件自己声明的区间
 * （peer 优先，其次 dependencies / devDependencies）—— 这样「DSH 升一个版本」时两边都跟着走，
 * 而 `cordis` / `schemastery` / `react` 这些独立版本线的包不会被误钉。
 */
function fixtureDependencies(pkg, runtime, imported) {
  const out = {}
  const declared = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }
  const names = new Set([...Object.keys(declared), ...imported])
  for (const name of [...names].sort()) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      out[name] = runtime
      continue
    }
    const range = pkg.peerDependencies?.[name] ?? pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
    if (range !== undefined) out[name] = range
  }
  return out
}

/** 断言「不兼容判定」按预期工作：运行时为 0.3 时必须被判不兼容。 */
async function assertOutOfRangeRejected(tempDir, manifest) {
  const appBoot = join(tempDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  const mod = await import(new URL(`file://${appBoot}`).href)
  if (typeof mod.evaluatePluginCompatibility !== 'function') {
    return 'DSH 的 dsh-app-boot 没有导出 evaluatePluginCompatibility（契约变了，本脚本必须跟着改）'
  }
  const issue = mod.evaluatePluginCompatibility(manifest, {}, OUT_OF_RANGE_RUNTIME)
  if (issue === undefined) {
    return `${OUT_OF_RANGE_RUNTIME} 竟然被判定兼容 —— 声明区间写宽了`
  }
  return ''
}

async function checkRuntime(pkg, runtime, options) {
  const label = `dsh ${runtime}`
  const workdir = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${runtime.replace(/[^\w.-]/g, '_')}-`))
  const npm = npmInvocation()
  const env = {
    // 明确关掉：用 `--legacy-peer-deps` 掩盖真实依赖等于把这道门禁作废。
    npm_config_legacy_peer_deps: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    // 让 npm 在临时工程里自己决定 registry（不继承仓库的 .npmrc 之外的怪配置）。
    npm_config_workspaces: 'false',
  }
  try {
    if (!existsSync(join(PLUGIN_DIR, 'src', 'index.ts'))) {
      return fail(`${label}：缺少 src/index.ts（这个脚本要在源码检出里跑）`)
    }
    const imported = await importedDeepseekPackages(join(PLUGIN_DIR, 'src'))
    const dependencies = fixtureDependencies(pkg, runtime, imported)
    // 类型检查要在临时工程里跑：`types: ["node","react"]` 由这两组提供。
    dependencies['@types/node'] = pkg.devDependencies['@types/node']
    dependencies['@types/react'] = pkg.devDependencies['@types/react']
    dependencies['@types/semver'] = pkg.devDependencies['@types/semver']
    dependencies.typescript = pkg.devDependencies.typescript

    await writeFile(join(workdir, 'package.json'), `${JSON.stringify({
      name: 'crwu-dsh-compat-probe',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies,
    }, null, 2)}\n`)

    log(`\n== ${label}：安装 DSH 完整 peer 集（${String(Object.keys(dependencies).length)} 个包，逐个钉版本）`)
    const install = await run(npm.command, [...npm.args, 'install', '--no-audit', '--no-fund'], { cwd: workdir, env })
    if (install.code !== 0) {
      log(install.stdout.slice(-2000))
      log(install.stderr.slice(-4000))
      return fail(`${label}：peer 依赖装不上（不许用 --legacy-peer-deps 掩盖）`)
    }

    // 运行时版本必须是**真的装到的那一个**，不是我们以为的那个。
    const appBootPkg = JSON.parse(await readFile(
      join(workdir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), 'utf8'))
    if (appBootPkg.version !== runtime) {
      return fail(`${label}：实际装到的是 ${appBootPkg.version}，与目标不一致（registry 漂移）`)
    }

    log(`== ${label}：装插件 tarball`)
    const packResult = await run(npm.command, [...npm.args, 'pack', '--pack-destination', workdir], {
      cwd: PLUGIN_DIR,
      env: { ...env, npm_config_dry_run: 'false' },
    })
    if (packResult.code !== 0) {
      log(packResult.stdout.slice(-2000))
      log(packResult.stderr.slice(-4000))
      return fail(`${label}：npm pack 失败`)
    }
    const tarball = (await readdir(workdir)).find((name) => name.endsWith('.tgz'))
    if (tarball === undefined) return fail(`${label}：npm pack 没有产出 tarball`)

    const installPlugin = await run(npm.command, [...npm.args, 'install', './' + tarball, '--no-audit', '--no-fund'], { cwd: workdir, env })
    if (installPlugin.code !== 0) {
      log(installPlugin.stdout.slice(-2000))
      log(installPlugin.stderr.slice(-4000))
      return fail(`${label}：插件 tarball 装不进目标运行时（peer 判定不通过 / 依赖树冲突）`)
    }

    log(`== ${label}：用 DSH 自己的判定函数检查插件是否会被 skip / disable`)
    const installedManifest = JSON.parse(await readFile(
      join(workdir, 'node_modules', pkg.name, 'package.json'), 'utf8'))
    const appBoot = await import(new URL(`file://${join(workdir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')}`).href)
    if (typeof appBoot.evaluatePluginCompatibility !== 'function') {
      return fail(`${label}：dsh-app-boot 没有导出 evaluatePluginCompatibility（DSH 契约变了）`)
    }
    const runtimeVersion = appBoot.getDshRuntimeVersion()
    if (runtimeVersion !== runtime) {
      return fail(`${label}：dsh-app-boot 报的运行时版本是 ${runtimeVersion}，与安装版本不一致`)
    }
    const issue = appBoot.evaluatePluginCompatibility(installedManifest, {}, runtimeVersion)
    if (issue !== undefined) {
      log(appBoot.pluginCompatibilityWarning(issue))
      return fail(`${label}：插件会被判不兼容（peer 区间没有覆盖这个运行时）`)
    }

    const outOfRange = await assertOutOfRangeRejected(workdir, installedManifest)
    if (outOfRange !== '') return fail(`${label}：${outOfRange}`)

    // 插件产物真的能 import（Host 半是 ESM，导出集与 DSH 自带工具插件一致）。
    const pluginEntry = await import(new URL(`file://${join(workdir, 'node_modules', pkg.name, 'lib', 'index.js')}`).href)
    const expected = ['Config', 'apply', 'inject', 'name']
    const missing = expected.filter((key) => pluginEntry[key] === undefined)
    if (missing.length > 0) {
      return fail(`${label}：装出来的产物缺少导出 ${missing.join(', ')}`)
    }

    if (options.typecheck) {
      log(`== ${label}：用该版本的 DSH 类型跑 tsc --noEmit`)
      await cp(join(PLUGIN_DIR, 'src'), join(workdir, 'src'), { recursive: true })
      await cp(join(PLUGIN_DIR, 'tsconfig.json'), join(workdir, 'tsconfig.json'))
      const tsc = join(workdir, 'node_modules', 'typescript', 'bin', 'tsc')
      const typecheck = await run(process.execPath, [tsc, '--noEmit', '-p', join(workdir, 'tsconfig.json')], { cwd: workdir, env })
      if (typecheck.code !== 0) {
        log(typecheck.stdout.slice(-4000))
        log(typecheck.stderr.slice(-2000))
        return fail(`${label}：类型检查不通过（我们对这个版本的 DSH 类型有依赖漂移）`)
      }
    }

    log(`PASS  ${label}：peer 解析 / 兼容判定 / 产物导入${options.typecheck ? ' / 类型检查' : ''} 全部通过`)
    return true
  } catch (error) {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error))
    return fail(`${label}：脚本异常`)
  } finally {
    // 清理**只限自己创建并验证过**的临时目录：失败也清。
    if (options.keep) log(`[keep] 临时工程保留在 ${workdir}`)
    else if (workdir.startsWith(join(tmpdir(), TEMP_PREFIX))) await rm(workdir, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv)
  const pkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  const results = []
  for (const runtime of options.runtimes) {
    // 顺序执行：同时装两套 DSH 会把磁盘与网络打满，而失败原因也更难读。
    results.push(await checkRuntime(pkg, runtime, options))
  }
  const passed = results.filter(Boolean).length
  log(`\nDSH 兼容矩阵：${String(passed)}/${String(results.length)} 通过（${options.runtimes.join(' / ')}）`)
  if (passed !== results.length) {
    log('提示：真实 DSH 会按 `evaluatePluginCompatibility` 判定并可能直接禁用插件；')
    log('      修 peer 区间后要同时更新 `engines.dsh` 与 tests/unit/host-package.test.mjs 的支持矩阵。')
    return 1
  }
  return 0
}

process.exit(await main())
