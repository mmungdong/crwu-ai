import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { shellInvoke } from '../platform/shell.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import { sandboxDenialNote, type ShellResult } from '../shell/run.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessOperation, LocalAccessSource } from '../access/operations.ts'

/**
 * `crwu` 命令执行器。
 *
 * ## 协议 18 起的三条门禁（缺一条就变成"工作台能执行任意命令"）
 *
 * 1. **只允许 argv[0] === 'crwu'**，其余一律拒绝；
 * 2. **合法子命令必须能映射到一个登记的本地访问操作**（`crwuOperationOf`）——
 *    映射不出来的直接失败。提权与否由那个**操作身份**决定，调用方提交不了；
 * 3. **执行一律经 Broker**：未授权时 Broker 连进程都不起，并把原因如实回给界面。
 *
 * ## 为什么把「提权开关」换成「argv → 操作」的固定映射
 *
 * 旧形态是 `escalate?: boolean` + `trusted: boolean`：`effective = (trusted ∧ 白名单) ∨ escalate`。
 * 那个 `escalate` 是**调用方**给的，同一个子命令在不同调用点可以拿到不同的权限，
 * 而审查时只能沿着调用链读。现在提权是**子命令自己**的属性：`crwu h3yun session status`
 * 就是 `h3yun.session.status`（要提权），`crwu h3yun records get` 就是 `h3yun.records.read`
 * （要提权）—— 没有第二个变量。模型与客户端都碰不到它（操作名不在任何 schema 里）。
 */

export interface CrwuRun {
  ok: boolean
  error: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  /** 调用方的取消信号是第一因（与 `error` = 基础设施故障分开）。 */
  aborted: boolean
  escalated: boolean
  /** 沙箱事实（请求 / 解析 / 实际 / 是否被拒）—— 归因与诊断的唯一依据，见 `shell/run.ts`。 */
  sandbox: ShellResult['sandbox']
  /** stdout/stderr 命中「钥匙串被拒」特征：提示用户需要无沙箱执行。 */
  keychainBlocked: boolean
  /** 界面应显示一次「授权入口」：本次读本机凭据被拦，且用户还没允许本机访问。 */
  escalateAvailable: boolean
}

/** `h3yun` 子命令 → 本机访问操作（**固定映射**，不是调用方参数）。 */
const CRWU_OPERATION_BY_SUBCOMMAND: Record<string, LocalAccessOperation> = {
  forms: 'h3yun.forms.read',
  records: 'h3yun.records.read',
  files: 'h3yun.files.read',
  file: 'h3yun.files.read',
}

/**
 * 把一条 **argv 形状合法**的 `crwu` 命令映射成本机访问操作。
 *
 * 返回 `null` = 这条子命令还没有登记操作 → **拒绝执行**（默认拒绝）。
 * 显式登记而不是"h3yun 开头的都放行"：氚云子命令会继续增加，新命令必须同时想清楚
 * 「它属于哪个 capability、要不要提权、哪些来源能做」——这正是这张表存在的意义。
 */
export function crwuOperationOf(argv: readonly string[]): LocalAccessOperation | null {
  if (text(argv[0]) !== 'crwu') return null
  const domain = text(argv[1])
  if (domain !== 'h3yun') return null
  const sub = text(argv[2])
  if (sub === 'session') {
    const action = text(argv[3])
    // `refresh` 也是会话管理动作：面板打开时的主动续期走它（CLI 侧的自动续期不覆盖 status）。
    if (action === 'status' || action === 'login' || action === 'bind' || action === 'refresh') return `h3yun.session.${action}`
    return null
  }
  return CRWU_OPERATION_BY_SUBCOMMAND[sub] ?? null
}

/** stdout/stderr 是否命中「凭据存储 / 钥匙串」失败特征。 */
export function keychainBlocked(result: { stdout?: unknown; stderr?: unknown }): boolean {
  const blob = `${text(result.stderr)} ${text(result.stdout)}`.toLowerCase()
  return blob.includes('credential store') || blob.includes('auto-refresh failed') || blob.includes('exit status 161')
}

/**
 * 给界面 / 诊断用的命令摘要：**只有域 + 子命令**。
 *
 * `--schema <表单 code>` / `--id <记录 id>` / `--out <本地路径>` 这类业务标识一律不进摘要 ——
 * 诊断是要给人看"发生过哪一类操作"，不是回放参数。
 */
export function describeCrwuCommand(argv: readonly string[]): string {
  const words: string[] = []
  for (const item of argv) {
    const token = text(item)
    if (token === '' || token.startsWith('-')) break
    words.push(token)
    if (words.length >= 4) break
  }
  return words.join(' ')
}

export interface CrwuOptions {
  workdir?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  /** 调用方（Tool 的 `exec.signal`）的取消信号；透传到 `ShellExecRequest.signal`。 */
  signal?: AbortSignal
  /** 用于拼接命令的引用方式；Windows 与 POSIX 不同。 */
  platform?: string
  /** Broker（协议 18）：唯一执行入口，提权由操作身份决定。 */
  access: LocalAccessBroker
  /** 这次调用是谁发起的。 */
  source: LocalAccessSource
  /**
   * 通过**标准输入**交给命令的文本（例如 `h3yun session bind --token-stdin` 的会话令牌）。
   *
   * 存在的理由只有一条：凭据不进命令行。argv 会被同机其它进程的 `ps` / 任务管理器看到，
   * 也会进 shell 的错误文案；标准输入不会。命令的 argv 形状不变，调用方自己负责把
   * 「会读 stdin」的那条参数（`--token-stdin`）拼进 `argv`。
   */
  stdinText?: string
}

/** 执行一条 crwu 命令。 */
export async function runCrwu(ctx: Context, argv: readonly string[], options: CrwuOptions): Promise<CrwuRun> {
  const failed = (error: string): CrwuRun => ({
    ok: false, error, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false,
    escalated: false,
    sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false },
    keychainBlocked: false, escalateAvailable: false,
  })

  if (!Array.isArray(argv) || argv.length === 0) return failed('缺少命令')
  const clean = argv.map((item) => text(item))
  if (clean[0] !== 'crwu') return failed('工作台只允许调用 crwu 命令')

  const operation = crwuOperationOf(clean)
  if (operation === null) {
    // 形状合法但没登记操作 = 这个功能还没有权限归属，**不猜、不放行**。
    return failed(`该 crwu 子命令还没有登记本机访问操作，拒绝执行：${describeCrwuCommand(clean)}`)
  }

  const platform = options.platform ?? ''
  // 命令名换成**包内绝对路径**：只按名字调用会在 Finder 启动的桌面端直接失败
  // （PATH 里没有 crwu，实测 `bash: crwu: command not found`），而那时「氚云登录」
  // 按钮点了没有任何反应。`shellInvoke` 负责 Windows 上的调用运算符 `&`。
  const resolved = await resolveBundledCommand(ctx, platform, 'crwu')

  // 临时目录也用系统默认：插件不再替 CLI 决定 TMPDIR/TEMP（自指定目录那条通道已整体下掉，见 §16）。
  const command = shellInvoke(resolved, clean.slice(1), platform)
  const result: ShellResult = await options.access.runShell(
    { operation, source: options.source, ...(options.workdir === undefined ? {} : { workdir: options.workdir }) },
    command,
    {
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.stdinText === undefined ? {} : { stdinText: options.stdinText }),
      summary: describeCrwuCommand(clean),
    },
  )

  const blocked = keychainBlocked(result)
  const granted = options.access.consent().state === 'granted'
  // 沙箱拒绝要认出并说清：受限沙箱下读钥匙串会回 `secret not found in keyring` ——
  // 那看起来像「真的没登录」。归因写在消息最前面，原文附在后面以供对照。
  const denied = result.ok ? '' : sandboxDenialNote(result)
  return {
    ok: result.ok,
    error: denied === ''
      ? result.error
      : (result.error === '' ? denied : `${denied}${result.error}`),
    exitCode: result.exitCode,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
    truncated: result.truncated,
    timedOut: result.timedOut,
    aborted: result.aborted,
    // `escalated` 现在是**事实**而不是请求：Broker 认为该提权、且确实按那个模式跑的。
    escalated: result.sandbox.requested === 'danger-full-access',
    sandbox: result.sandbox,
    keychainBlocked: blocked,
    // 需要给员工一个「允许入口」的两种情况：凭据读取被钥匙串/沙箱拦下（blocked），
    // 或者命令根本没跑起来（`error`：沙箱后端不可用、审批被拒、未授权）。
    // 已经允许过本机访问就不再打扰（那时该看的是真实故障，不是再点一次允许）。
    escalateAvailable: (blocked || result.error !== '') && !granted,
  }
}

/** 失败时给用户一句可读的原因：优先 stderr，其次错误，最后退出码。 */
export function describeFailure(run: { stderr?: unknown; error?: unknown; exitCode?: number | null }): string {
  const stderr = text(run.stderr).trim()
  if (stderr !== '') return stderr.slice(0, 400)
  const error = text(run.error).trim()
  if (error !== '') return error.slice(0, 400)
  return `命令退出码 ${String(run.exitCode ?? 'unknown')}`
}
