import { text } from '../../shared/utils/value.ts'
import { isWindowsPlatform } from './detect.ts'

/**
 * **唯一**的 shell 方言适配器：所有经 `ctx.shell` 发出的命令都从这里生成。
 *
 * ## 为什么必须集中（2026-09-28 员工在 Windows 上实测报错）
 *
 * DSH 在 Windows 挂的执行器是 `@deepseek-ai/dsh-pwsh-local`：它把整条命令作为**一个 argv 元素**
 * 交给 `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`，也就是说插件拼的是
 * **PowerShell 脚本**，不是 POSIX 的 `bash -c` 行，也不是 `cmd.exe` 的批处理行。三套解析规则
 * 不一样，之前每个调用点各拼各的，于是同一类错误反复出现：
 *
 * 1. **命令位置**：以引号开头的 token 在 PowerShell 里是字符串表达式，不是命令调用 ——
 *    `"C:\…\crwu.exe" h3yun session status` 直接 ParserError，必须写 `& 'C:\…\crwu.exe' …`。
 * 2. **参数引用**：PowerShell 双引号会插值 `$` 与反引号，只有单引号是纯字面量，且内部单引号要翻倍；
 *    POSIX 单引号内部则要写成 `'\''`。
 * 3. **第二套解析规则**：`cmd /c start` / `cmd /c mkdir` / `cmd /c del` 把引号解析再交给 cmd，
 *    转义错误被放大一倍；`-ErrorAction SilentlyContinue` 会把真实失败伪装成成功。
 *
 * 集中之后每一条规则只实现一次、只测一次，新增调用点不可能再漏掉 Windows。
 *
 * ## 平台从哪来
 *
 * `platform` 一律由调用方**显式传入**（Host runtime 的 world facts / 操作参数）。业务函数内部
 * **不得**回退 `process.platform`：那会让单测与真实运行使用不同方言，Windows 分支永远测不到，
 * 而这正是本次要修的形态。
 */

/** 两条方言：PowerShell（Windows）与 POSIX（macOS / Linux）。 */
export type ShellDialect = 'powershell' | 'posix'

/** 一段文本是否可以不加引号直接放进 POSIX 命令（保守白名单，含 `$` 就不行）。 */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * NUL 无法在命令串里表达（两个平台都一样）：原样带进去会截断命令、把后面的内容变成新命令。
 * 所以这里是**明确拒绝**，而不是「尽量拼一个」。
 */
function assertNoNul(value: string, what: string): string {
  if (value.includes('\u0000')) {
    throw new Error(`${what} 含 NUL 字符，无法安全放进 shell 命令`)
  }
  return value
}

/** 该平台键走哪条方言。`win32-x64` / `win32-arm64` 都是 PowerShell。 */
export function shellDialect(platform: string): ShellDialect {
  return isWindowsPlatform(text(platform)) ? 'powershell' : 'posix'
}

/**
 * 把一个**参数**安全地引用成字面量。
 *
 * - PowerShell：一律单引号 + 内部单引号翻倍。**不用双引号** —— 双引号会插值 `$` / 反引号，
 *   路径或 URL 里的 `$` 会被当变量展开。
 * - POSIX：能不加引号就不加（可读性），否则单引号 + `'\''`。
 *
 * 换行、制表、回车都**安全表示**（单引号内部是字面量，不会变成语句分隔符）；只有 NUL 抛错。
 */
export function shellQuote(value: unknown, platform: string): string {
  const raw = assertNoNul(text(value), '参数')
  if (shellDialect(platform) === 'powershell') {
    return `'${raw.replace(/'/g, "''")}'`
  }
  if (raw !== '' && POSIX_SAFE.test(raw)) return raw
  return `'${raw.replace(/'/g, "'\\''")}'`
}

/**
 * 拼一条「可执行文件 + 参数」的命令（**命令位置**）。
 *
 * Windows 上第一个 token 必须是 `& <引用后的路径>`：`&` 才是「把这段字符串当命令执行」。
 * POSIX 上**绝不能**加 `&` —— 在 `bash -c` 里它是后台作业，会把前台命令变成异步执行。
 */
export function shellInvoke(executable: string, args: readonly string[], platform: string): string {
  const parts = [executable, ...args].map((item) => shellQuote(item, platform))
  return shellDialect(platform) === 'powershell' ? `& ${parts.join(' ')}` : parts.join(' ')
}

/** 幂等建目录（`mkdir -p` 的等价物）。 */
export function mkdirCommand(path: string, platform: string): string {
  return shellDialect(platform) === 'powershell'
    // `New-Item -Force` 在目录已存在时也是成功的：重审会再走一次，不能因此报错。
    ? `New-Item -ItemType Directory -Force -Path ${shellQuote(path, platform)} | Out-Null`
    : `mkdir -p ${shellQuote(path, platform)}`
}

/**
 * 幂等删除一个普通文件。
 *
 * 「目标本来不存在」是幂等成功，其余失败（权限、占用、父目录错误）必须让退出码非 0：
 * PowerShell 分支用 `-ErrorAction Stop` 让错误终止，并用 `if (Test-Path …)` 把「没有这个文件」
 * 挡在删除之前 —— **不用** `-ErrorAction SilentlyContinue`，那会把真实失败也吞成成功。
 */
export function removeFileCommand(path: string, platform: string): string {
  if (shellDialect(platform) !== 'powershell') return `rm -f -- ${shellQuote(path, platform)}`
  const quoted = shellQuote(path, platform)
  return `if (Test-Path -LiteralPath ${quoted}) { Remove-Item -LiteralPath ${quoted} -Force -ErrorAction Stop }`
}

/** 用系统默认程序打开一个文件或 URL。 */
export function openExternalCommand(target: string, platform: string): string {
  if (shellDialect(platform) === 'powershell') return `Start-Process -FilePath ${shellQuote(target, platform)}`
  if (text(platform).startsWith('darwin')) return `open ${shellQuote(target, platform)}`
  return `xdg-open ${shellQuote(target, platform)}`
}

/**
 * 把 stdin 写进系统剪贴板的命令。
 *
 * 内容**只走 stdin**、永远不作为参数（提示词里的引号、反引号、`$` 拼进命令行会被解释）。
 */
export function clipboardCommand(platform: string): string {
  if (text(platform).startsWith('darwin')) return 'pbcopy'
  if (shellDialect(platform) === 'powershell') return 'clip'
  return 'xclip -selection clipboard 2>/dev/null || xsel -b'
}

/**
 * 探测执行世界主目录的命令。
 *
 * Windows 只用 PowerShell 自己的环境变量：`python3` / `printf` 在 Windows 上都不保证存在，
 * 拿它们当探针会把「插件包装配」变成「系统装没装 Python」。POSIX 侧同理不依赖 `python3`。
 */
export function homeProbeCommand(platform: string): string {
  return shellDialect(platform) === 'powershell' ? 'Write-Output $env:USERPROFILE' : 'printf %s "$HOME"'
}

/**
 * 把普通文件权限收紧到「仅属主可读写」。
 *
 * Windows 没有 POSIX 权限位、也没有 `chmod` 命令，返回空串表示**这一项不适用**（凭据文件在
 * 用户配置目录内，由用户 ACL 保护）。调用方据此上报「继承当前账户 ACL」而不是伪造一次成功。
 */
export function privateFileCommand(path: string, platform: string): string {
  if (shellDialect(platform) === 'powershell') return ''
  return `chmod 600 ${shellQuote(path, platform)}`
}

/**
 * 该平台用哪种机制保护凭据文件 —— 与 `privateFileCommand` **同一判据**。
 *
 * 拆出来是因为调用方要把「谁在负责」写进结构化的权限结论（`CredentialPermission.mechanism`），
 * 而不是只看命令字符串空不空。
 */
export function privateFileMechanism(platform: string): 'posix-0600' | 'windows-acl' {
  return shellDialect(platform) === 'powershell' ? 'windows-acl' : 'posix-0600'
}
