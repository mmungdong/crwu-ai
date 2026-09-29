/**
 * 测试替身用的「shell 副作用模拟」。
 *
 * 为什么需要它：`ensureDirectory` / `removeFileIfExists` 现在会**回读后置条件** ——
 * 命令退出码为 0 不等于目录真的建出来了、文件真的删掉了（编码、占用、虚拟文件系统都可能骗过退出码），
 * 所以实现会用 `ctx.fs.stat` 复核一次。内存 fs 替身必须让成功的建/删命令在 `stat` 上看得见，
 * 否则替身会造出一台「命令成功但文件系统没变」的假机器，测试就在断言错误的东西。
 *
 * 只认中央适配器（`src/host/platform/shell.ts`）生成的那几种形状；形状不认识时**什么都不做** ——
 * 于是真实实现里「命令没生效」这类缺陷依然会让测试变红，替身不会替它遮掩。
 */

/** PowerShell 单引号字面量（内部单引号翻倍）。 */
const PS = String.raw`'([^']*(?:''[^']*)*)'`
/** POSIX 单引号字面量（内部单引号是 `'\''`）。 */
const SH = String.raw`'([^']*(?:'\\''[^']*)*)'`
/** 没有引号的裸参数（POSIX 安全白名单里的值）。 */
const BARE = String.raw`([^\s']+)`

const PATTERNS = [
  // mkdirCommand · POSIX
  { re: new RegExp(`^mkdir -p (?:${SH}|${BARE})$`), kind: 'dir' },
  // mkdirCommand · PowerShell
  { re: new RegExp(`^New-Item -ItemType Directory -Force -Path ${PS} \\| Out-Null$`), kind: 'dir' },
  // removeFileCommand · POSIX
  { re: new RegExp(`^rm -f -- (?:${SH}|${BARE})$`), kind: 'file' },
  // removeFileCommand · PowerShell
  {
    re: new RegExp(`^if \\(Test-Path -LiteralPath ${PS}\\) \\{ Remove-Item -LiteralPath ${PS} -Force -ErrorAction Stop \\}$`),
    kind: 'file',
  },
]

/**
 * 还原两种方言的字面量转义。
 *
 * 捕获组本身已经排除了外层引号，所以这里**无条件**折叠转义：
 * PowerShell 是 `''`，POSIX 是 `'\''`。（只在「被引号包住」时才折叠会漏掉这种形态。）
 */
function unquote(raw) {
  let value = String(raw ?? '').trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
  return value.split("''").join("'").split("'\\''").join("'")
}

/**
 * 把一条**已成功**的命令的副作用应用到内存 fs 替身。
 *
 * @param {string} command 交给 shell 的命令串
 * @param {number|null} exitCode 命令退出码；非 0 时不动文件系统
 * @param {{ addDir: (path: string) => void, removeFile: (path: string) => void }} fs
 */
export function applyShellEffect(command, exitCode, fs) {
  if (exitCode !== 0) return
  const text = String(command ?? '')
  for (const { re, kind } of PATTERNS) {
    const match = re.exec(text)
    if (match === null) continue
    // 捕获组 1 来自引号形式，组 2 来自裸参数形式。
    const path = unquote(match[1] ?? match[2])
    if (kind === 'dir') fs.addDir(path)
    else fs.removeFile(path)
    return
  }
}

// ── 只读路径探测（`pathProbeCommand`） ──────────────────────────────────────
//
// 2026-09-30 起建 / 删之后的后置条件不再走 `ctx.fs.stat`，而是走 Broker 上的
// `pathProbeCommand`（`test -d` / `Test-Path -PathType` 的等价值）—— 因为员工选的工作空间
// 在会话 cwd 之外，"查不出来"与"不存在"必须被实例分开。替身因此也要回答这条命令，
// 否则每个用例都会撞上「路径探测没有得到结论」。

/** POSIX 探测模板（`pathProbeCommand`）。 */
const PROBE_SH = new RegExp(`^if \\[ -d (?:${SH}|${BARE}) \\]; then printf %s directory; elif \\[ -f (?:${SH}|${BARE}) \\]; then printf %s file; else printf %s absent; fi$`)
/** PowerShell 探测模板（`pathProbeCommand`）。 */
const PROBE_PS = new RegExp(
  `^if \\(Test-Path -LiteralPath ${PS} -PathType Container\\) \\{ Write-Output 'directory' \\}`
  + ` elseif \\(Test-Path -LiteralPath ${PS} -PathType Leaf\\) \\{ Write-Output 'file' \\}`
  + ` else \\{ Write-Output 'absent' \\}$`,
)

/** 这条命令是不是路径探测；是的话返回它探测的目标路径。 */
export function pathProbeOf(command) {
  const text = String(command ?? '')
  const posix = PROBE_SH.exec(text)
  if (posix !== null) return unquote(posix[1] ?? posix[2])
  const powershell = PROBE_PS.exec(text)
  if (powershell !== null) return unquote(powershell[1])
  return undefined
}

/**
 * 替身对一条路径探测命令的**忠实回答**（`directory` / `file` / `absent`）。
 *
 * `fs` 只要回答两个问题：这个路径在不在、它是文件还是目录。返回 `undefined` 表示
 * "这条命令不是路径探测"，调用方照常走自己的 handler。
 */
export function probeAnswer(command, fs) {
  const target = pathProbeOf(command)
  if (target === undefined) return undefined
  if (fs.hasDir(target)) return 'directory'
  if (fs.hasFile(target)) return 'file'
  return 'absent'
}

/** 探测目标与内存 fs 之间的键归一（去掉尾部分隔符：`C:\a\` 与 `C:\a` 是同一个）。 */
export function probeKey(path) {
  return String(path ?? '').replace(/[\\/]+$/, '')
}
