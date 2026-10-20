#!/usr/bin/env node
/**
 * 解析 DSH 自带 Python —— `make plugin-check` 的 OCR 门禁只认它。
 *
 * 为什么不退回系统 `python3`：员工机器与干净机器上那一份既不保证存在，也不保证带 Pillow；
 * 缺了它两条 OCR 用例只会 skip，而 **skip 不是通过证据**（Makefile 旧注释已经写明）。
 * 插件运行时可以从 `load_workspace_dependencies` 拿到绝对路径，维护门禁没有会话，只能在
 * 文件系统上按 DSH 自己的目录约定找：
 *
 *   $DSH_HOME（缺省 ~/.dsh）/dsh-runtimes/<runtime>/dependencies/python/
 *     bin/python3         macOS / Linux 入口（DSH 运行时里指向真正的 3.12）
 *     python.exe          Windows 入口（DSH 在 Windows 上直接放在 python/ 下）
 *
 * 输出契约：stdout **只**打印一个绝对路径（供 `$(shell)` 捕获），诊断全部走 stderr；
 * 找不到可用解释器时 exit 1，并逐个说明候选被排除的原因 —— 不猜路径、不退回 python3。
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

/** macOS / Windows 两种布局的固定入口，按优先级排列。 */
const FIXED_NAMES = ['bin/python3', 'bin/python3.exe', 'python.exe', 'bin/python.exe']

/** 探测脚本输出一行「解释器版本 Pillow 版本」；导入失败即视为缺 Pillow。 */
export const PROBE_ARGV = [
  '-c',
  'import sys, PIL; print(sys.version.split()[0] + " " + getattr(PIL, "__version__", "unknown"))',
]

/**
 * DSH 主目录：`$DSH_HOME` 优先（与 DSH 自己的口径一致），否则 `~/.dsh`。
 */
export function dshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/**
 * 运行时目录：主运行时排在最前，其余按名字排序 —— 同一台机器上装过多个运行时的时候，
 * `dsh-primary-runtime` 才是 DSH 自己认的那一份。
 */
export function runtimeDirs(home) {
  const root = join(home, 'dsh-runtimes')
  if (!existsSync(root)) return []
  const names = readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory()
    } catch {
      return false
    }
  })
  const rank = (name) => (name === 'dsh-primary-runtime' ? 0 : 1)
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  return names.map((name) => join(root, name))
}

/**
 * 单个运行时下的候选解释器：固定入口在前，`bin/python3.<n>` 按版本号从高到低补在后面。
 */
export function runtimeCandidates(runtimeDir) {
  const pythonRoot = join(runtimeDir, 'dependencies', 'python')
  const found = FIXED_NAMES.map((name) => join(pythonRoot, ...name.split('/')))
  const binDir = join(pythonRoot, 'bin')
  let versioned = []
  if (existsSync(binDir)) {
    versioned = readdirSync(binDir)
      .map((name) => /^python3\.(\d+)$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => ({ name: match[0], minor: Number(match[1]) }))
      .sort((a, b) => b.minor - a.minor)
      .map((entry) => join(binDir, entry.name))
  }
  // 去重：Windows 上 `bin/python3.exe` 可能同时命中固定名与版本名以外的路径。
  return [...new Set([...found, ...versioned])]
}

/** POSIX 要求可执行位；Windows 只认存在性（`X_OK` 在 Windows 上等价于存在）。 */
function executableAt(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 真实探测：跑一次 `-c "import sys, PIL"`。
 * 返回 `{ ok, versionText }` 或 `{ ok: false, reason }`。
 */
export function probeInterpreter(path) {
  try {
    const stdout = execFileSync(path, PROBE_ARGV, {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, versionText: stdout.trim() }
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    const lastLine = stderr === '' ? '' : stderr.split('\n').filter((line) => line.trim() !== '').pop()
    if (error?.code === 'ENOENT') return { ok: false, reason: '无法执行（文件不存在）' }
    return { ok: false, reason: lastLine === '' ? String(error?.message ?? error) : lastLine }
  }
}

/**
 * 解析函数。`probe` 传 `null` 表示只做路径选择（测试与 `--no-probe` 用）。
 *
 * @returns {{ ok: boolean, path?: string, versionText?: string, home?: string,
 *             searched?: string[], failures?: Array<{ path: string, reason: string }> }}
 */
export function resolveDshPython({ home = dshHome(), probe = probeInterpreter } = {}) {
  const searched = runtimeDirs(home)
  const failures = []
  for (const runtimeDir of searched) {
    for (const candidate of runtimeCandidates(runtimeDir)) {
      if (!existsSync(candidate)) continue
      if (!executableAt(candidate)) {
        failures.push({ path: candidate, reason: '存在但不可执行' })
        continue
      }
      if (probe === null) return { ok: true, path: candidate, versionText: '' }
      const result = probe(candidate)
      if (result.ok) return { ok: true, path: candidate, versionText: result.versionText }
      failures.push({ path: candidate, reason: result.reason })
    }
  }
  return { ok: false, home, searched, failures }
}

/** stderr 上的失败说明：搜过哪里、每个候选为什么不行、下一步怎么做。 */
export function describeFailure(result) {
  const lines = []
  lines.push(`✖ 找不到可用的 DSH 自带 Python（OCR 门禁只认它，不退回系统 python3）。`)
  lines.push(`  搜索根：${result.home}${existsSync(join(result.home, 'dsh-runtimes')) ? '' : '（dsh-runtimes 不存在）'}`)
  if (result.searched.length === 0) {
    lines.push('  未发现任何运行时目录：$DSH_HOME/dsh-runtimes/<runtime>/dependencies/python')
  }
  for (const failure of result.failures) {
    lines.push(`  - ${failure.path}：${failure.reason}`)
  }
  lines.push('  处理：启动一次 DeepSeek Harness，让它生成 ~/.dsh/dsh-runtimes；')
  lines.push('        或显式指定 make plugin-check DSH_PYTHON=<python 绝对路径>。')
  return lines.join('\n')
}

/** 打印用路径：Windows 统一成正斜杠，避免反斜杠在 Make 食谱 / shell 引号里被二次解释。 */
function printablePath(path) {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path
}

function main(argv) {
  const verbose = argv.includes('--verbose')
  const noProbe = argv.includes('--no-probe')
  const result = resolveDshPython({ probe: noProbe ? null : probeInterpreter })
  if (!result.ok) {
    process.stderr.write(`${describeFailure(result)}\n`)
    process.exitCode = 1
    return
  }
  if (verbose) {
    const detail = result.versionText === '' ? '' : `（${result.versionText}）`
    process.stderr.write(`DSH 自带 Python：${printablePath(result.path)}${detail}\n`)
  }
  process.stdout.write(`${printablePath(result.path)}\n`)
}

// 只在直接执行时跑 CLI；被测试 import 时不产生副作用（`pathToFileURL` 处理 Windows 盘符与空格）。
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2))
}
