import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecSpec, ShellExecutor } from '@deepseek-ai/dsh-shell'
import { finiteNumber, text } from '../../shared/utils/value.ts'
import { windowsCaptureCommand } from '../platform/shell.ts'

/**
 * 一次 shell 运行的结果。
 *
 * 形状**刻意与历史实现一致**：`tests/` 下的测试都按
 * `{ ok, stdout, stderr, exitCode, timedOut }` 断言，且 `ctx.shell` 的
 * `CollectedOutput` 本身就是 `{ text, truncated }`，所以这里不需要翻译层。
 * 与 DSH 的唯一差别是 legacy 把 `stdoutMaxBytes` 默认成 64KB —— 那个默认值保持不变，
 * 因为氚云分页列表会超过它（见 `RECORDS_STDOUT_MAX`）。
 */
export interface ShellResult {
  ok: boolean
  error: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  /**
   * 调用方的取消信号（`ShellExecRequest.signal`）是不是**第一因**。
   *
   * 必须与 `error`（=「命令根本没跑起来」的基础设施故障，见 `shellUnavailable`）分开：
   * 把「被取消」当成「shell 服务不可用」会让上层把一次正常的取消报成部署故障。
   */
  aborted: boolean
  /**
   * 沙箱事实（2026-09-28 接上）。DSH 的 `ShellRunResult.sandbox` 会回
   * `{ mode, denied, runnerFailed }` —— 「命令**实际**跑在哪个模式」「沙箱是否真的拒绝了一次
   * 文件操作」是**结构化事实**，不必再从错误文本里猜。
   *
   * 为什么必须收下来：员工在 Windows 上看到的三段报错（写 `~/.ossutilconfig` 被拒、
   * `secret not found in keyring`、`dws` 的 `.data.lock: Access is denied`）表现完全不同，
   * 原因却是同一个。有了这几个字段，插件就能把「请求了什么、解析回来是什么、实际跑在什么下、
   * 是否被拒」逐条说清 —— 而不是把沙箱拒绝显示成「未登录」。
   */
  sandbox: {
    /** 请求里声明的模式（空串 = 没声明，交给执行器默认）。 */
    requested: string
    /** `resolve()` 回来、执行器实际会用的模式（空串 = 该执行器不上沙箱）。 */
    resolved: string
    /** 命令**实际**跑在哪个模式（`ShellRunResult.sandbox.mode`）；不上沙箱时为空串。 */
    ran: string
    /** 沙箱是否真的拒绝了一次文件操作（`ShellRunResult.sandbox.denied`）。 */
    denied: boolean
    /** 沙箱 runner 在命令跑起来之前就失败了。 */
    runnerFailed: boolean
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_STDOUT_MAX_BYTES = 65_536

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

const NO_SANDBOX_FACTS = { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false } as const

function failed(error: string, sandbox: ShellResult['sandbox'] = NO_SANDBOX_FACTS): ShellResult {
  return {
    ok: false, error, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false,
    sandbox,
  }
}

/**
 * 运行一条命令。
 *
 * 三条必须遵守的约束（来自 `AGENTS.md` §4.3）：
 * 1. 必须走 DSH 注入的 `ctx.shell`，不得用 `node:child_process` 绕过沙箱与审批；
 * 2. `escalate` 需要 `workspaceRoot`：不知道工作区就不申请无沙箱执行，避免用服务器 cwd 兜底；
 * 3. 不吞异常：`shell.run` 抛错时把原因带回调用方，而不是假装命令失败。
 *
 * **提权是怎么生效的**（对照 `docs/subsystems/sandbox.md`）：在 `resolve()` 的请求里带上
 * `sandboxPolicy: { mode: 'danger-full-access', workspaceRoot }`。契约原文是
 * 「Only the first two modes can be sent to a provider. A `danger-full-access` consumer spawns its
 * original argv and does not call `ctx.sandbox`」—— 也就是说这个模式让执行器**直接 spawn 原始 argv、
 * 完全不碰沙箱**，正是 `crwu h3yun session login` 这类需要读钥匙串的命令所必需的。
 *
 * 请求对象**不做类型断言**：`ShellExecRequest` 本身就声明了 `sandboxPolicy`，留着断言会把
 * 「字段改名 / 模式取值变化」这类漂移藏起来，而它恰恰是静默失效（提权不生效、登录永远失败）。
 */
export async function runShell(
  ctx: Context,
  command: string,
  options: {
    workdir?: string
    timeoutMs?: number
    escalate?: boolean
    /**
     * **逐次声明的沙箱策略**（调用方用自己的会话 `sandboxPolicy.resolve({ session })` 算出来）。
     *
     * 为什么必须有这一条（2026-09-30 真机）：DSH 的执行器**不持有会话**
     * （`dsh-sandbox-policy` 的原话是 "executors and providers remain session-free"），
     * 请求里不带 `sandboxPolicy` 时它只会用自己的**部署默认**（`workspace-write` + 配置里的兜底根，
     * 通常就是进程 cwd）。所以"按某个会话的作用域执行"不是换个 `ctx` 就能成立的 ——
     * 必须由调用方把那个会话解析出来的策略放进请求里，DSH 自带的 bash / fs 也是这么做的。
     *
     * 与 `escalate` 的关系：`escalate` 是**提权**（特权操作专用，策略由操作表钉死为
     * `danger-full-access`）；`sandboxPolicy` 是调用方算出来的**本会话策略**（非特权操作用它对齐边界）。
     * 两者都给时以 `sandboxPolicy` 为准（Broker 只会给其中一个）。
     */
    sandboxPolicy?: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
    stdoutMaxBytes?: number
    stdinText?: string
    /**
     * 调用方（通常是 Tool 的 `exec.signal`）的取消信号。
     *
     * 直接交给 `ShellExecRequest.signal`：DSH 在它触发时杀掉命令，并把它算作
     * `ShellRunResult.aborted` 的第一因。没有这一条，Tool 的取消只能在命令跑完之后
     * 才生效 —— 取消一条正在跑的 `dws` / `ossutil` 会退化成「等它自己结束」。
     */
    signal?: AbortSignal
  } = {},
): Promise<ShellResult> {
  const shell = ctx.get('shell') as ShellExecutor | undefined
  if (shell === undefined) return failed('Host shell 服务不可用')

  const workRoot = options.workdir ?? ''
  if (options.escalate === true && workRoot === '') {
    return failed('未知会话工作区，无法申请无沙箱执行')
  }

  // 请求的模式：显式策略 > 提权 > 交给执行器默认（空串 = 我们没声明）。
  const declared = options.sandboxPolicy
    ?? (options.escalate === true ? { mode: 'danger-full-access' as const, workspaceRoot: workRoot } : undefined)
  const requestedMode = declared === undefined ? '' : declared.mode
  let spec: ShellExecSpec
  try {
    // On Windows DSH's restricted PowerShell can start, but a native child
    // inheriting its stdout/stderr pipe may fail during DLL initialization
    // (0xC0000142).  `shellInvoke()` commands are recognized by their leading
    // PowerShell call operator; cmdlet-only scripts are left byte-for-byte
    // unchanged.  Keeping this at the final ctx.shell seam also covers host
    // calls made by the audit child through the LocalAccessBroker.
    //
    // ⚠️ **只在真跑受限沙箱时才上捕获**（`nativeCaptureNeeded`）：`danger-full-access` 不做任何
    // confinement，那个 DLL 初始化缺陷的前提不存在；而捕获要走 PowerShell 的文本层，会把
    // CLI 的字节改掉 —— 凭据类命令全是提权的，套上去就等于读不到凭据
    // （2026-09-30 真机回归：同一台 Windows 上 main 能读、这个分支读不到）。
    const effectiveCommand = windowsCaptureCommand(command, requestedMode)
    spec = shell.resolve({
      command: effectiveCommand,
      ...(workRoot === '' ? {} : { workdir: workRoot }),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdoutMaxBytes: options.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES,
      ...(options.stdinText === undefined ? {} : { stdin: options.stdinText }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(declared === undefined ? {} : { sandboxPolicy: declared }),
    })
  } catch (error) {
    return failed(`执行失败：${failureMessage(error)}`, { ...NO_SANDBOX_FACTS, requested: requestedMode })
  }

  // `resolve()` 回来的策略就是执行器实际会用的那个 —— 请求被降级时这里能看出来。
  // 执行器不上沙箱时该字段是 `undefined`（例如测试替身与不设限的部署）。
  const resolvedMode = text(spec.sandboxPolicy?.mode)
  const baseSandbox = { requested: requestedMode, resolved: resolvedMode, ran: '', denied: false, runnerFailed: false }

  try {
    // 0.1.7 把原来的 `run(spec)` 拆成两步：`execute(spec)` 返回进程句柄（`ShellExecution`），
    // 句柄上的 `result()` 才是前台投影（收齐 stdout/stderr 并给出 timedOut/aborted 归因）。
    // 两步都会为**基础设施故障** reject，所以一起包在同一个 try 里。
    const execution = await shell.execute(spec)
    const result = await execution.result()
    return {
      ok: result.exitCode === 0,
      error: '',
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: text(result.stdout?.text),
      stderr: text(result.stderr?.text),
      truncated: result.stdout?.truncated === true || result.stderr?.truncated === true,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      sandbox: {
        ...baseSandbox,
        ran: text(result.sandbox?.mode),
        denied: result.sandbox?.denied === true,
        runnerFailed: result.sandbox?.runnerFailed === true,
      },
    }
  } catch (error) {
    // 抛错时也别把已经知道的事实丢掉（解析到的策略仍然说明「本来会跑在什么下」）。
    return failed(`执行失败：${failureMessage(error)}`, baseSandbox)
  }
}

/**
 * 后台命令句柄：只暴露这一层需要的东西。
 *
 * 存在的理由只有一条：钉钉登录（`dws auth login`）要**边跑边把授权 URL 交给界面**。
 * 前台 `runShell` 只在进程结束时才回来，URL 到界面时用户早就不在等了（CLI 那 5 分钟里
 * 界面什么都看不到）。DSH 的 `ctx.shell.start(spec)` 正好给这个能力：立即返回句柄、
 * `readOutput()` 增量读、`kill()` 终止。
 */
export interface ShellBackgroundHandle {
  /** 自上次读取以来的输出增量（**消耗式**：连续两次读不会重复给同一段）。 */
  read(): { delta: string; lossy: boolean }
  /** 终止；已经结束返回 false（幂等）。 */
  kill(): boolean
  /** 进程结束（从不 reject）。 */
  done: Promise<void>
  /** 结束后的退出码；null = 被信号杀或还在跑。 */
  exitCode(): number | null
  status(): 'running' | 'completed' | 'killed'
  /** 结束后才有的沙箱事实（受限执行器才有；不限沙箱的部署是 `undefined`）。 */
  sandbox(): { mode?: string | undefined; denied?: boolean | undefined; runnerFailed?: boolean | undefined } | undefined
}

export type ShellStartResult =
  | { ok: true; handle: ShellBackgroundHandle }
  | { ok: false; error: string; sandbox: ShellResult['sandbox'] }

/**
 * 起一条**后台**命令并立刻拿到句柄。
 *
 * 与 `runShell` 共用同一段 `resolve()` 逻辑（沙箱策略、请求/解析模式的事实都在那里），
 * 区别只有两点：
 * - 用 `onExpiry: 'none'`：**不武装**执行器的默认死线。钉钉登录要等人在浏览器里完成授权，
 *   默认的 60 秒会把一次正常等待变成超时；超时由调用方自己控制（`kill()`）。
 * - 只 `execute()`、**不** `result()`：DSH 的契约写得很清楚 ——「前台」是调用方要不要 await
 *   结果的性质，不是 spawn 的性质。拿住句柄就是后台跑。
 *
 * 失败一律是**基础设施**失败（`resolve` / `execute` 抛错）——与「命令跑完了、退出码非 0」
 * 分开：后者要等 `done` 之后读 `exitCode()`。
 */
export async function startShell(
  ctx: Context,
  command: string,
  options: {
    workdir?: string
    escalate?: boolean
    /** 与 `runShell` 同义：调用方按自己的会话解析出来的策略（见那边的长注释）。 */
    sandboxPolicy?: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
    stdoutMaxBytes?: number
  } = {},
): Promise<ShellStartResult> {
  const shell = ctx.get('shell') as ShellExecutor | undefined
  if (shell === undefined) {
    return { ok: false, error: 'Host shell 服务不可用', sandbox: NO_SANDBOX_FACTS }
  }

  const workRoot = options.workdir ?? ''
  if (options.escalate === true && workRoot === '') {
    return { ok: false, error: '未知会话工作区，无法申请无沙箱执行', sandbox: NO_SANDBOX_FACTS }
  }

  const declared = options.sandboxPolicy
    ?? (options.escalate === true ? { mode: 'danger-full-access' as const, workspaceRoot: workRoot } : undefined)
  const requestedMode = declared === undefined ? '' : declared.mode
  let spec: ShellExecSpec
  try {
    // 与前台同一条判据（见上面的注释）：提权调用不套捕获。
    const effectiveCommand = windowsCaptureCommand(command, requestedMode)
    spec = shell.resolve({
      command: effectiveCommand,
      ...(workRoot === '' ? {} : { workdir: workRoot }),
      // 后台进程自己管超时：执行器的默认死线只适合前台命令。
      onExpiry: 'none',
      ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
      ...(declared === undefined ? {} : { sandboxPolicy: declared }),
    })
  } catch (error) {
    return {
      ok: false,
      error: `执行失败：${failureMessage(error)}`,
      sandbox: { ...NO_SANDBOX_FACTS, requested: requestedMode },
    }
  }

  const resolvedMode = text(spec.sandboxPolicy?.mode)
  const baseSandbox = {
    requested: requestedMode, resolved: resolvedMode, ran: '', denied: false, runnerFailed: false,
  }
  try {
    const execution = await shell.execute(spec)
    return {
      ok: true,
      handle: {
        read: () => {
          const read = execution.readOutput()
          return { delta: text(read.delta), lossy: read.lossy === true }
        },
        kill: () => execution.kill(),
        done: execution.done,
        exitCode: () => (typeof execution.exitCode === 'number' ? execution.exitCode : null),
        status: () => execution.status,
        sandbox: () => execution.sandbox,
      },
    }
  } catch (error) {
    return { ok: false, error: `执行失败：${failureMessage(error)}`, sandbox: baseSandbox }
  }
}

/**
 * 命令**根本没有执行**（shell 服务缺失、沙箱后端不可用、审批拒绝、`resolve` 抛错）。
 *
 * 依据 DSH 契约（`@deepseek-ai/dsh-shell` 的 `ShellExecution.result` 文档）：
 * 「Rejects only for **infrastructure failures** (a spawn that never produced a process)；
 * 非零退出、超时击杀、取消击杀都 resolve 成 `ShellRunResult`」。所以本模块里带 `error`
 * 的结果只可能来自 reject 或 `resolve` 抛错，与「命令跑完了、只是退出码非 0」是两件事。
 *
 * **为什么这个区分必须存在**（真实 DSH 上踩到过）：沙箱后端不可用（macOS 上
 * `sandbox-exec: sandbox_apply: Operation not permitted`，典型原因是进程本身已在沙箱里）时，
 * `command -v node` 会执行失败。若把「执行失败」当成「命令不存在」，环境自检页就会对一台装好了
 * Node / Python 的机器报「未安装」，把人送去装一个已经装好的东西。
 */
export function shellUnavailable(result: ShellResult): boolean {
  return result.error !== ''
}

/**
 * 这条命令是不是被**沙箱**拦下的（而不是它自己业务失败）。
 *
 * ## 为什么需要它（2026-09-28 员工实测）
 *
 * 受限沙箱（`workspace-write`）下，凡是需要碰**工作区之外**的命令都会失败，而且失败的
 * 样子**完全不像权限问题**：
 *
 * - `crwu h3yun session status` 读操作系统凭据存储 → 回
 *   `secret not found in keyring`（看起来像「没登录」）；
 * - `dws auth login` 要写 `%USERPROFILE%\.dws\` → 回
 *   `acquiring file lock: opening lock file: open C:\Users\<用户>\.dws\.data.lock: Access is denied.`
 *   （看起来像 dws 自己的 bug）；
 * - 插件的 `fs.writeText` 写 `~/.ossutilconfig` → 回
 *   `file access denied under workspace-write mode`（这条是 DSH 自己的标记，最好认）。
 *
 * 三种表现对应同一个原因，而「未登录 / 登录失败 / 写不进去」的处置完全不同 —— 所以这里统一认一次，
 * 由调用方把那句话补进错误里，让员工（和模型）看到的是**原因加动作**，不是 CLI 的表象。
 *
 * 判据分两档，措辞也分两档（不把猜测说成结论）：
 * - **确定**：出现 DSH 自己的标记 `file access denied under <mode> mode`；
 * - **疑似**：出现 `Access is denied` / `Permission denied`，且同一段文本里带着工作区外的
 *   用户目录或凭据存储线索（`.dws` / `.ossutilconfig` / `keyring` / `credential store`）——
 *   这种情况也可能是真的 NTFS ACL 或文件占用，所以只说「疑似」并给出两条排查方向。
 */
export function sandboxDenialNote(result: {
  stdout?: unknown
  stderr?: unknown
  error?: unknown
  sandbox?: { requested?: string; resolved?: string; ran?: string; denied?: boolean; runnerFailed?: boolean }
}): string {
  const facts = result.sandbox
  const requested = text(facts?.requested)
  const resolved = text(facts?.resolved)
  const ran = text(facts?.ran)

  // ① 结构化事实优先：DSH 会告诉我们命令**实际**跑在哪个模式、沙箱有没有真的拒绝。
  if (facts?.denied === true) {
    return `DSH 沙箱拒绝了这次操作（${ran || resolved || requested || '当前模式'}）：`
      + '这条命令需要访问工作区之外的路径。'
  }
  if (facts?.runnerFailed === true) {
    return 'DSH 的沙箱 runner 在命令跑起来之前就失败了（不是命令本身的业务失败）。'
  }
  // ② 提权请求被降级：请求了 A、解析回来是 B —— 这是「授权了却仍被拦」的确定证据。
  if (requested !== '' && resolved !== '' && requested !== resolved) {
    return `提权请求被降级：请求 ${requested}，执行器实际按 ${resolved} 跑 —— `
      + '这条命令需要访问工作区之外的路径，当前沙箱模式把它拦下了。'
  }

  // ③ 只有在**拿不到结构化事实**时才退回文本判据（老版本 DSH / 非 shell 通道）。
  //
  // 反过来做会很危险：事实已经说明「沙箱没拒、命令跑在我们请求的模式下」时再去猜文本，
  // 就会把一份被别的进程占用的文件或异常 NTFS ACL 说成沙箱问题 —— 员工按「去授权」处理，
  // 问题永远修不掉。**事实在手就不猜。**
  if (facts !== undefined && (requested !== '' || resolved !== '' || ran !== '' || facts.denied === false)) {
    return ''
  }
  const blob = `${text(result.stderr)}\n${text(result.stdout)}\n${text(result.error)}`
  const marker = /file access denied under\s+(\S+)\s+mode/i.exec(blob)
  if (marker !== null) {
    return `这是 DSH 沙箱（${marker[1] ?? '当前模式'}）的拒绝，不是命令本身的业务失败：`
      + '这条命令需要访问工作区之外的路径。'
  }
  if (/access is denied|permission denied|拒绝访问/i.test(blob)
    && (/\.dws|ossutilconfig|keyring|credential store|credential-store/i.test(blob))) {
    return '疑似被沙箱拦下（命令要访问工作区外的用户目录或凭据存储）：'
      + '如果这台机器开着 workspace-write，请先在面板「授权读取本机凭据」；'
      + '若它确实是一份被别的进程占用的文件或 NTFS 权限问题，也会报同样的字样。'
  }
  return ''
}

/**
 * 把沙箱事实压成**一行**给开发者诊断/错误消息用（人话、无凭据）。
 *
 * 典型用途：员工报「授权了还是不行」时，这一行直接回答「请求了什么、实际跑在什么下、有没有被拒」，
 * 不必再猜是沙箱还是文件权限。
 */
export function describeSandboxFacts(result: { sandbox?: { requested?: string; resolved?: string; ran?: string; denied?: boolean; runnerFailed?: boolean } }): string {
  const f = result.sandbox
  if (f === undefined) return ''
  const requested = text(f.requested)
  const resolved = text(f.resolved)
  const ran = text(f.ran)
  const parts: string[] = []
  if (requested !== '') parts.push(`请求 ${requested}`)
  if (resolved !== '' && resolved !== requested) parts.push(`解析为 ${resolved}`)
  if (ran !== '') parts.push(`实际 ${ran}`)
  if (f.denied === true) parts.push('沙箱拒绝=是')
  if (f.runnerFailed === true) parts.push('runner 失败=是')
  return parts.join(' · ')
}

/** 命令是否可用/成功：只看 `ok`，方便调用方做 `if (!(await ok(...)))`。 */
export async function commandOk(ctx: Context, command: string, options: Parameters<typeof runShell>[2] = {}): Promise<boolean> {
  const result = await runShell(ctx, command, options)
  return result.ok
}

/** 取命令输出的第一行并去掉首尾空白；失败返回空串。 */
export async function commandLine(ctx: Context, command: string, options: Parameters<typeof runShell>[2] = {}): Promise<string> {
  const result = await runShell(ctx, command, options)
  if (!result.ok) return ''
  return text(result.stdout).trim().split('\n')[0]?.trim() ?? ''
}

/** 命令的输出按行拆分并去掉空行；失败返回空数组。 */
export async function commandLines(ctx: Context, command: string, options: Parameters<typeof runShell>[2] = {}): Promise<string[]> {
  const result = await runShell(ctx, command, options)
  if (!result.ok) return []
  return text(result.stdout).split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** 把外部值当整数读（用于探测输出里的行数/数量）。 */
export function intOf(value: unknown): number {
  return Math.trunc(finiteNumber(value))
}
