import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { runShell } from '../shell/run.ts'
import { shellQuote } from '../environment/probe.ts'
import type { ShellResult } from '../shell/run.ts'

/**
 * `crwu` 命令执行器。
 *
 * 三条门禁，缺一条就会变成「工作台能执行任意命令」：
 * 1. **只允许 argv[0] === 'crwu'**，其余一律拒绝；
 * 2. **无沙箱执行（escalate）只有白名单子命令能申请**：`crwu h3yun session login` 与
 *    `forms/records/apps/files/file/tools`。这些都必须在沙箱外跑（要读钥匙串）；
 * 3. `escalate` 只是**申请**，实际是否提权还取决于 `trustH3yun` —— 用户没在面板上信任氚云时，
 *    即使白名单命中也走沙箱，失败后再由界面引导用户显式打开。
 */

export interface CrwuRun {
  ok: boolean
  error: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  escalated: boolean
  /** stdout/stderr 命中「钥匙串被拒」特征：提示用户需要无沙箱执行。 */
  keychainBlocked: boolean
  /** 本次没提权、但白名单允许提权 —— 界面据此显示「可授权」按钮。 */
  escalateAvailable: boolean
}

/**
 * 该 crwu 子命令是否允许无沙箱执行。
 *
 * 判据写成显式白名单而不是「h3yun 开头的都行」：氚云子命令将来会增加，默认必须是**拒绝**。
 */
export function escalationAllowed(argv: string[]): boolean {
  if (argv[1] !== 'h3yun') return false
  const sub = argv[2]
  if (sub === 'session') return argv[3] === 'login'
  return sub === 'forms' || sub === 'records' || sub === 'apps' || sub === 'files' || sub === 'file' || sub === 'tools'
}

/** stdout/stderr 是否命中「凭据存储 / 钥匙串」失败特征。 */
export function keychainBlocked(result: { stdout?: unknown; stderr?: unknown }): boolean {
  const blob = `${text(result.stderr)} ${text(result.stdout)}`.toLowerCase()
  return blob.includes('credential store') || blob.includes('auto-refresh failed') || blob.includes('exit status 161')
}

export interface CrwuOptions {
  workdir?: string
  timeoutMs?: number
  escalate?: boolean
  stdoutMaxBytes?: number
  /** 用户在面板上是否已信任氚云（写在插件状态里）。 */
  trusted: boolean
  /** 用于拼接命令的引用方式；Windows 与 POSIX 不同。 */
  platform?: string
}

/** 执行一条 crwu 命令。返回结构与 legacy 一致，界面不需要改。 */
export async function runCrwu(ctx: Context, argv: string[], options: CrwuOptions): Promise<CrwuRun> {
  const failed = (error: string): CrwuRun => ({
    ok: false, error, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false,
    escalated: false, keychainBlocked: false, escalateAvailable: false,
  })

  if (!Array.isArray(argv) || argv.length === 0) return failed('缺少命令')
  const clean = argv.map((item) => text(item))
  if (clean[0] !== 'crwu') return failed('工作台只允许调用 crwu 命令')

  const allowed = escalationAllowed(clean)
  if (options.escalate === true && !allowed) {
    return failed(`该 crwu 子命令不允许无沙箱执行：${clean.slice(0, 3).join(' ')}`)
  }
  const effective = options.escalate === true || (options.trusted && allowed)

  const quote = (value: string): string => shellQuote(value, options.platform ?? '')
  const result: ShellResult = await runShell(ctx, clean.map(quote).join(' '), {
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    timeoutMs: options.timeoutMs ?? 60_000,
    escalate: effective,
    ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
  })

  const blocked = keychainBlocked(result)
  return {
    ok: result.ok,
    error: result.error,
    exitCode: result.exitCode,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
    truncated: result.truncated,
    timedOut: result.timedOut,
    escalated: effective,
    keychainBlocked: blocked,
    escalateAvailable: blocked && !effective && allowed,
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
