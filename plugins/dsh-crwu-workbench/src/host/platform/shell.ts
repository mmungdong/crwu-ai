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
 * **只读**路径探测：这个路径是目录 / 普通文件 / 不存在？
 *
 * ## 为什么不让命令的退出码承载结论
 *
 * `test -d` 用退出码 1 表示"不是目录"，而退出码 1 在这条链路上还有别的含义（命令没跑起来、
 * 沙箱拒绝、被信号杀掉）。把两者混在一起，"读不到"就会变成"不存在"，而这两句话在界面上
 * 指向完全不同的动作（去重选路径 vs 去查文件权限）。所以这里让命令**永远以 0 退出**，
 * 结论只走 stdout 上的一个词：`directory` / `file` / `absent`。
 *
 * 沙箱拒绝或命令不可用时，插件拿到的是**执行失败**（`ok:false`）——那对应"查不出来"，
 * 调用方必须如实上报，不许折叠成 `absent`。
 *
 * PowerShell 用 `-LiteralPath`：路径来自员工，`[` `]` 这类字符在 `-Path` 下是通配符语法。
 */
export function pathProbeCommand(path: string, platform: string): string {
  const quoted = shellQuote(path, platform)
  return shellDialect(platform) === 'powershell'
    ? `if (Test-Path -LiteralPath ${quoted} -PathType Container) { Write-Output 'directory' }`
      + ` elseif (Test-Path -LiteralPath ${quoted} -PathType Leaf) { Write-Output 'file' }`
      + ` else { Write-Output 'absent' }`
    : `if [ -d ${quoted} ]; then printf %s directory; elif [ -f ${quoted} ]; then printf %s file; else printf %s absent; fi`
}

/** 路径探测的三态；`undefined` = 没有结论（命令没跑起来 / 输出不可识别）。 */
export type PathProbeKind = 'directory' | 'file' | 'absent'

/**
 * 解析 {@link pathProbeCommand} 的输出。
 *
 * 判据只在**最后一行**上找：命令失败时 stderr 会把原文混进 stdout，随便扫全文就等于
 * 让一句报错里恰好出现的 `absent` 决定结论。
 */
export function parsePathProbe(result: { ok?: boolean; stdout?: unknown } | undefined): PathProbeKind | undefined {
  if (result === undefined || result.ok !== true) return undefined
  const lines = text(result.stdout).split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const last = lines[lines.length - 1] ?? ''
  return last === 'directory' || last === 'file' || last === 'absent' ? last : undefined
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
 * 读取一个文件的 POSIX 权限模式（八进制，例如 `600`）。
 *
 * **为什么需要它**：`chmod` 在个别文件系统（网络盘、被容器/虚拟化层挡住的挂载点）上会
 * **静默无效** —— 退出码 0 但模式没变。只信退出码就把「命令跑过了」说成「权限已验证」，
 * 而 0600 正是凭据文件的安全边界。所以收紧之后要回读一次。
 *
 * GNU 与 BSD 的 `stat` 参数不同，这个分歧只在这里出现一次：
 * `stat -c %a`（GNU/Linux）与 `stat -f %Lp`（BSD/macOS）。Windows 没有 POSIX 模式位，返回空串。
 */
export function readFileModeCommand(path: string, platform: string): string {
  if (shellDialect(platform) === 'powershell') return ''
  const quoted = shellQuote(path, platform)
  return text(platform).startsWith('darwin') ? `stat -f %Lp ${quoted}` : `stat -c %a ${quoted}`
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

// ── 本机目录诊断与最小权限修复（协议 18 · 子项目 D） ──────────────────────────
//
// 这一组命令有三个硬约束，写在生成处而不是调用处：
// 1. **路径由插件内部推导**（`<home>/.dws`），任何模型输入都进不来；
// 2. **只读探测与写入修复分开**：`dws*Probe*` 只读事实，`chmod*` / `grant*` 才改权限；
// 3. **绝不 `chown` / `takeown` / `sudo`**：所有权不对时只能报给管理员人工处理（设计 §D3）。

/**
 * 读一个路径的**所有者 uid 与模式位**（POSIX）。
 *
 * 为什么要一条命令同时取这两项：`ctx.fs.stat` 不给模式与所有者，而分成两条命令会让
 * "这两个值来自同一次观察"这个前提消失（诊断里的"所有者匹配但模式不对"必须自洽）。
 */
/**
 * **锁占用**正向探测（协议 18 · D）：谁正在持有这个文件？
 *
 * `lockExists` 不是 `lockHeld` —— 一个残留的锁文件与"真有进程握着它"看着完全一样，
 * 而处置完全不同（前者可以直接删锁，后者要先停掉那个进程）。
 *
 * - POSIX：`lsof -t -- <path>` 列出持有者 PID；退出码 1 = **没有**人持有（这是"确认为假"的
 *   正向结论，不是"探测失败"）。
 * - Windows：没有既可靠又只读的原生手段（`openfiles` 需要管理员且只覆盖共享打开）。
 *   这里如实返回空串 = **无法确认**，调用方必须把结论留成 `unknown`，
 *   **不许**因为"文件在"就判 `file-lock`。
 */
/**
 * **锁占用**正向探测（协议 18 · D）：谁正在持有这个文件？
 *
 * `lockExists` 不是 `lockHeld` —— 一个残留的锁文件与"真有进程握着它"看着完全一样，
 * 而处置完全不同（前者可以直接删锁，后者要先停掉那个进程）。
 *
 * ## POSIX
 *
 * `lsof -t -- <path>` 列出持有者 PID；退出码 1 且无输出 = **没有**人持有
 *（这是"确认为假"的正向结论，不是"探测失败"）。
 *
 * ## Windows
 *
 * 尝试以 `FileShare.None`（独占、只读、**不写内容**）打开现有锁文件：
 *
 * - 打开成功 → 没有别人持有 → `False`；
 * - 失败且 HRESULT 低 16 位是 32（`ERROR_SHARING_VIOLATION`）或 33（`ERROR_LOCK_VIOLATION`）
 *   → **有人持有** → `True`；
 * - 失败原因是 `UnauthorizedAccessException`（ACL 不让读）→ `Unknown`：
 *   那是**权限**问题，交给 ACL 判决，**不许**混成"锁被占用"。
 *
 * 句柄在 `finally` 里关掉，全程不写入任何字节 —— 体检是只读的。
 */
export function lockProbeCommand(path: string, platform: string): string {
  if (path === '') return ''
  if (!isWindowsPlatform(platform)) return `lsof -t -- ${shellQuote(path, platform)}`
  const quoted = shellQuote(path, platform)
  // ⚠️ 这里是**整段脚本**，不要退回去用 `['a', 'b'].join('; ')` 拼：join 的分号会落在
  // `try {` 这类左花括号后面，拼出 `try {;` 这种空语句。本机没有 pwsh，
  // 结构错误只会在 Windows 上表现为"探测拿不到结论"，所以由用例做结构自检（配平 + 空语句）。
  return [
    `$p = ${quoted}`,
    'try {',
    "  $fs = [IO.File]::Open($p, 'Open', 'Read', 'None')",
    '  $fs.Close()',
    "  Write-Output 'locked=False'",
    '} catch {',
    // ⚠️ **必须沿 `InnerException` 解包到根异常**：PowerShell 调用 .NET 方法时抛出的异常
    // 会被包成 `MethodInvocationException`，真正的 `IOException`（带 32/33 这两个共享冲突码）
    // 在 `InnerException` 里。直接读 `$_.Exception.HResult` 拿到的是**外层包装**的 HRESULT，
    // 于是"真的有进程持锁"也会被判成 `Unknown` —— W-05 依旧归不了 `file-lock`（用户复查的 P1）。
    '  $e = $_.Exception',
    '  $denied = $false',
    '  $depth = 0',
    '  while ($depth -lt 8) {',
    '    if ($e -is [System.UnauthorizedAccessException]) { $denied = $true }',
    '    if ($null -eq $e.InnerException) { break }',
    '    $e = $e.InnerException',
    '    $depth = $depth + 1',
    '  }',
    // 根异常的 HRESULT 低 16 位：32 = ERROR_SHARING_VIOLATION、33 = ERROR_LOCK_VIOLATION。
    '  $hr = $e.HResult -band 0xFFFF',
    // ACL 不让读（链上出现过 UnauthorizedAccess）是**权限**问题，交给 ACL 判决 —— 不许混成"锁被占用"。
    '  if ($denied) {',
    "    Write-Output 'locked=Unknown'",
    '  } elseif ($hr -eq 32 -or $hr -eq 33) {',
    "    Write-Output 'locked=True'",
    '  } else {',
    "    Write-Output 'locked=Unknown'",
    '  }',
    '}',
  ].join('\n')
}

/**
 * 锁探测的结论：`true` 有人持有 / `false` 没有 / `undefined` 拿不到结论。
 *
 * 两种平台形态都收在这里：Windows 读脚本自己打的 `locked=` 行；
 * POSIX 按 `lsof` 的退出码语义（1 + 空输出 = 没被占用）。
 */
export function parseLockProbe(result: { exitCode?: number | null; stdout?: unknown; error?: unknown } | undefined): boolean | undefined {
  if (result === undefined) return undefined
  // 命令根本没跑起来（沙箱拦下 / 没有 lsof / 没有 pwsh）→ 不知道。
  if (typeof result.error === 'string' && result.error !== '') return undefined
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  // Windows 形态：脚本自己给出三态结论。
  const windowsLine = /^locked=(True|False|Unknown)$/im.exec(stdout)
  if (windowsLine !== null) {
    const value = windowsLine[1]?.toLowerCase()
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }
  // POSIX 形态：`lsof` 的退出码。
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
  if (exitCode === null) return undefined
  if (exitCode === 1 && stdout.trim() === '') return false
  if (exitCode === 0) return stdout.trim() !== ''
  // 其它退出码（例如 127 找不到 lsof）→ 不知道。
  return undefined
}

export function statOwnerModeCommand(path: string, platform: string): string {
  if (shellDialect(platform) === 'powershell') return ''
  const quoted = shellQuote(path, platform)
  // ⚠️ **格式串必须是一个参数**：BSD 的 `stat -f` 只吃紧跟其后的那**一个** token，
  // 写成 `stat -f %u %Lp <path>` 会把 `%Lp` 当成文件操作数 →
  // `stat: %Lp: stat: No such file or directory`（2026-09-29 由
  // `tests/windows/powershell-contract.test.mjs` 的真 shell 用例抓到）。
  const format = shellQuote(text(platform).startsWith('darwin') ? '%u %Lp' : '%u %a', platform)
  const flag = text(platform).startsWith('darwin') ? '-f' : '-c'
  return `stat ${flag} ${format} ${quoted}`
}

/** 当前进程的 uid（POSIX）。和 `statOwnerModeCommand` 的第一个字段比对。 */
export function currentUidCommand(platform: string): string {
  return shellDialect(platform) === 'powershell' ? '' : 'id -u'
}

/**
 * 「当前账户能不能改这个路径」的**真实**探测（POSIX）。
 *
 * 用 `test -w` 而不是读模式位自己算：ACL、只读挂载、immutable 标志、以及"模式看起来能写
 * 但实际写不进去"都会让自算的结果骗人。这条命令的退出码就是答案。
 */
export function pathWritableCommand(path: string, platform: string): string {
  if (shellDialect(platform) === 'powershell') return ''
  return `test -w ${shellQuote(path, platform)}`
}

/**
 * Windows：用 PowerShell 就地评估 ACL，**只输出两个布尔**。
 *
 * 设计明确禁止把 ACL 条目、账户名、SID、原始输出带回客户端（§D2）—— 所以脚本自己算完
 * `owner=` / `modify=` 两行就结束，名字与 SID 一步都不出这台机器。
 */
/**
 * Windows ACL → 一条**只读**的、可判定的判决（协议 18 · D）。
 *
 * ## 为什么不能"找当前 SID 的 Allow ACE"
 *
 * 旧实现只查"当前用户 SID 有没有 Allow+Modify ACE"。它错在三处（用户复查 P1）：
 * 1. **忽略用户所属组**拿到的权限 —— 域里最常见的授权方式就是给组；
 * 2. **忽略 Deny 优先级** —— 显式 Deny 永远压过 Allow，旧实现看不见；
 * 3. 于是"修的其实没生效"（Deny 还在）也会被报成 `modify=true`，修复验证形同虚设。
 *
 * ## 现在怎么算
 *
 * 把当前**访问令牌**里的 SID（自己的 + 所属组）都算作"我方"，逐条扫描继承与非继承的
 * ACE，按 Windows 的规则算有效权限：**我方有 Deny（且覆盖 Modify/写/完全控制）就否**，
 * 否则我方有 Allow 覆盖 Modify 就算有。
 *
 * ## 为什么输出的是标签而不是 SID
 *
 * 判决在 PowerShell 里做（它才拿得到 SID），但**输出的每一行都不含 SID、账户名或域名** ——
 * 只有 `self` / `group` / `other` 三种角色标签与权限标志。返回体因此可以安全地进诊断与界面
 * （§D2 明确禁止回显 SID 与账户名）。插件侧再用纯函数 `parseAclVerdict` 复算一遍，
 * 这样"Deny 优先"这条规则有可单测的实现，而不是埋在没人能测的 PowerShell 里。
 */
/**
 * Windows ACL → 一条**只读**的、可判定的判决（协议 18 · D）。
 *
 * ## 为什么不能"找当前 SID 的 Allow ACE"
 *
 * 旧实现只查"当前用户 SID 有没有 Allow+Modify ACE"。它错在三处：
 * 1. **忽略用户所属组**拿到的权限 —— 域里最常见的授权方式就是给组；
 * 2. **忽略 Deny 优先级** —— 显式 Deny 永远压过 Allow；
 * 3. **忽略部分 Deny**：只 Deny `WriteData` / `Delete`（或 `(W)`）同样会让人写不进去，
 *    而旧版把这种 ACE 标成 `partial` 后在插件侧被整个忽略 —— 于是"可改"被判成真，
 *    修复入口也不出现（2026-09-29 复查的 P2）。
 *
 * ## 现在输出什么
 *
 * 判决的核心算术放在**插件侧**（可单测的纯函数）：脚本只给出原始事实 ——
 *
 * ```
 * crwu-acl/2
 * owner=True
 * modify-mask=197055           ← 这个平台上 "Modify" 的权限位（由 .NET 枚举给出；FullControl 是 2032127）
 * ace=allow:self:197055        ← 我方（本人 SID）的 ACE 与**权限位掩码**
 * ace=deny:group:1179785
 * ```
 *
 * 插件侧算 `effective = (∪allow) & ~(∪deny)`，再判它是否完整覆盖 `modify-mask`。
 * 这样"Deny 优先"与"部分 Deny 也算数"两条规则都有可单测的实现，
 * 而不是埋在没人能测的 PowerShell 里。
 *
 * ## 为什么不回 SID / 账户名
 *
 * 脚本在出口处就把每条 ACE 标成 `self` / `group` / `other` 三种角色，
 * **SID、账户名、域名一律不出机器**（§D2）。权限位掩码是数字，不是身份。
 */
export function windowsAclVerdictCommand(path: string, platform: string): string {
  if (shellDialect(platform) !== 'powershell') return ''
  const quoted = shellQuote(path, platform)
  // ⚠️ 同 `lockProbeCommand`：整段脚本，不要用 `join('; ')`（会在 `foreach (...) {` 后面留下空语句）。
  return [
    `$p = ${quoted}`,
    '$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$mine = @{}',
    '$mine[$id.User.Value] = "self"',
    'foreach ($g in $id.Groups) {',
    '  if (-not $mine.ContainsKey($g.Value)) { $mine[$g.Value] = "group" }',
    '}',
    '$acl = Get-Acl -LiteralPath $p',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    "Write-Output 'crwu-acl/2'",
    "Write-Output ('owner=' + [bool]($owner -eq $id.User.Value))",
    // "Modify" 的定义交给 .NET 自己的枚举 —— 插件侧不硬编码权限位。
    'Write-Output ("modify-mask=" + [int][System.Security.AccessControl.FileSystemRights]::Modify)',
    // 继承与非继承都要看：域策略下"能不能改"常常由继承决定。
    '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
    'foreach ($r in $rules) {',
    '  $key = $r.IdentityReference.Value',
    '  $role = if ($mine.ContainsKey($key)) { $mine[$key] } else { "other" }',
    '  $kind = if ($r.AccessControlType -eq "Allow") { "allow" } else { "deny" }',
    // 权限位掩码：整数，不含任何身份信息。
    '  Write-Output ("ace=" + $kind + ":" + $role + ":" + [int]$r.FileSystemRights)',
    '}',
  ].join('\n')
}

/**
 * 权限收紧之后，**真的去写一下**（只在修复的读回里用）。
 *
 * ACE 算出来的"有效权限"仍然是推断；这里让 Windows 自己回答"我现在能不能写"。
 * 目录用建一个临时文件再删掉，文件用 `OpenWrite` 打开。
 *
 * 它**只**能出现在修复路径上：体检是只读的，不许往员工的本机目录里写任何东西。
 */
export function windowsModifyProbeCommand(target: string, kind: 'directory' | 'file', platform: string): string {
  if (shellDialect(platform) !== 'powershell') return ''
  const quoted = shellQuote(target, platform)
  const body = kind === 'directory'
    ? [
        `$probe = Join-Path ${quoted} ('.crwu-write-probe-' + [Guid]::NewGuid().ToString('N'))`,
        'try { [IO.File]::WriteAllText($probe, ""); Remove-Item -LiteralPath $probe -Force; Write-Output "modify=True" }',
        'catch { Write-Output "modify=False" }',
      ]
    : [
        `try { $f = [IO.File]::Open(${quoted}, 'Open', 'Write', 'None'); $f.Close(); Write-Output "modify=True" }`,
        'catch { Write-Output "modify=False" }',
      ]
  return body.join('; ')
}

/**
 * Windows：给**当前账户**补一条最小 Modify 授权。
 *
 * `icacls /grant` 是**追加**一条 ACE，不动 SYSTEM / Administrators / 继承来的条目（设计 §D3）。
 * 用 SID 而不是账户名：账户名要按当前的显示语言改写，SID 不会。
 * 目录加 `(OI)(CI)` 继承标记（新建/改名/删除都要），锁文件不加。
 */
export function grantModifyAclCommand(path: string, platform: string, options: { inherit: boolean }): string {
  if (shellDialect(platform) !== 'powershell') return ''
  const quoted = shellQuote(path, platform)
  const rights = options.inherit ? ':(OI)(CI)M' : ':M'
  return '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; '
    + `icacls ${quoted} /grant ('*' + $sid + '${rights}')`
}

/** POSIX：把路径设成给定模式（八进制）。**只允许** `700` / `600` 两个值。 */
export function chmodCommand(mode: string, path: string, platform: string): string {
  if (shellDialect(platform) === 'powershell') return ''
  if (mode !== '700' && mode !== '600') {
    throw new Error(`chmodCommand 只接受 700 / 600（收到 ${mode}）`)
  }
  return `chmod ${mode} ${shellQuote(path, platform)}`
}
