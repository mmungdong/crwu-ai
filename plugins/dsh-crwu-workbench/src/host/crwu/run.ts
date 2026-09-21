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
 * 2. **无沙箱执行（escalate）只有白名单子命令能声明**：`crwu h3yun session login` 与
 *    `forms/records/apps/files/file/tools`。这些都必须在沙箱外跑（要读系统钥匙串）；
 * 3. **员工零配置**（2026-09-22 定的口径）：命中白名单就**自己声明**所需权限
 *    （`ShellExecSpec.sandboxPolicy`），不要求员工改任何启动参数、也不要求先勾选什么。
 *    是否放行由 DSH 的审批策略决定；`trusted` 只是「记住授权、不再逐次询问」的优化，
 *    它**不再**决定提不提权（旧口径是「没勾信任就退回沙箱」，结果员工读氚云一直撞钥匙串）。
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
  /** 界面应显示一次「授权入口」：本次读本机凭据被拦，且用户还没记住授权。 */
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
  // 提权 = 白名单 ∧ 已授权（授权就是用户对「读本机凭据」的同意；没授权时环境自检会硬阻塞，
  // 这里也不再偷偷无沙箱执行）。`options.escalate` 保留为客户端显式重试的通道（同样只对白名单生效）。
  const effective = (options.trusted === true && allowed) || options.escalate === true

  // 提权请求必须带 `workspaceRoot`（DSH 契约），所以会话工作区未知时**退回沙箱执行**：
  // 不能因为拿不到工作区就把命令直接判失败 —— 那样员工看到的是一句基础设施错误，
  // 而不是「钥匙串被拒，去授权」这条可操作的路径。
  const canEscalate = effective && (options.workdir ?? '') !== ''
  const quote = (value: string): string => shellQuote(value, options.platform ?? '')
  const result: ShellResult = await runShell(ctx, clean.map(quote).join(' '), {
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    timeoutMs: options.timeoutMs ?? 60_000,
    escalate: canEscalate,
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
    escalated: canEscalate,
    keychainBlocked: blocked,
    // 需要给员工一个「授权入口」的两种情况：凭据读取被钥匙串/沙箱拦下（blocked），
    // 或者命令根本没跑起来（`error`：沙箱后端不可用、审批被拒）。已经记住授权就不再打扰。
    escalateAvailable: (blocked || result.error !== '') && options.trusted !== true,
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
