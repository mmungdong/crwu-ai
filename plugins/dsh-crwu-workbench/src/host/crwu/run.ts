import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { runShell, sandboxDenialNote } from '../shell/run.ts'
import { shellInvoke } from '../platform/shell.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import type { ShellResult } from '../shell/run.ts'

/**
 * `crwu` 命令执行器。
 *
 * 三条门禁，缺一条就会变成「工作台能执行任意命令」：
 * 1. **只允许 argv[0] === 'crwu'**，其余一律拒绝；
 * 2. **无沙箱执行（escalate）只有白名单子命令能声明**：`crwu h3yun session login` 与
 *    `forms/records/apps/files/file/tools`。这些都必须在沙箱外跑（要读系统钥匙串）。
 *    白名单是**必要条件**：不在白名单里的子命令即使调用方传 `escalate: true` 也直接失败；
 * 3. **提权的真实语义**（这一段曾与实现互相矛盾，以代码为准）：
 *    `effective = (trusted ∧ 白名单) ∨ escalate`。也就是说
 *    - 员工已在面板上授权（`trusted`）时，白名单内的读凭据命令**自动**提权，不再逐次询问；
 *    - 未授权时，只有调用方**显式**声明 `escalate: true` 才会提权（这是客户端「去授权」重试
 *      与插件内部初始化路径的通道），DSH 的审批策略决定放不放行。
 *    两种路径都**不要求员工改启动参数**。
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
  // `h3yun session` 整段放行：`login` 写钥匙串，而 `status` / `bind` **读**钥匙串 ——
  // 受限沙箱下读不到就会回 `secret not found in keyring`，那是**假结论**（实测同一台机器
  // 同一时刻：沙箱里「没找到」，带 `sandboxPolicy: danger-full-access` 时才拿到真状态）。
  // 只放行 `login` 是 2026-09-28 之前留下的缺口：面板因此把「未授权/被沙箱拦」显示成「未登录」。
  if (sub === 'session') return true
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
  /** 调用方（Tool 的 `exec.signal`）的取消信号；透传到 `ShellExecRequest.signal`。 */
  signal?: AbortSignal
}

/** 执行一条 crwu 命令。返回结构与 legacy 一致，界面不需要改。 */
export async function runCrwu(ctx: Context, argv: string[], options: CrwuOptions): Promise<CrwuRun> {
  const failed = (error: string): CrwuRun => ({
    ok: false, error, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false,
    escalated: false,
    sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false },
    keychainBlocked: false, escalateAvailable: false,
  })

  if (!Array.isArray(argv) || argv.length === 0) return failed('缺少命令')
  const clean = argv.map((item) => text(item))
  if (clean[0] !== 'crwu') return failed('工作台只允许调用 crwu 命令')

  const allowed = escalationAllowed(clean)
  if (options.escalate === true && !allowed) {
    return failed(`该 crwu 子命令不允许无沙箱执行：${clean.slice(0, 3).join(' ')}`)
  }
  // 提权 = 白名单 ∧ (已授权 ∨ 调用方显式声明)。授权就是用户对「读本机凭据」的同意；
  // 没授权又没显式声明时，这里不会偷偷无沙箱执行 —— 环境自检会把「未授权」算成阻塞项。
  const effective = (options.trusted === true && allowed) || options.escalate === true

  // 提权请求必须带 `workspaceRoot`（DSH 契约），所以会话工作区未知时**退回沙箱执行**：
  // 不能因为拿不到工作区就把命令直接判失败 —— 那样员工看到的是一句基础设施错误，
  // 而不是「钥匙串被拒，去授权」这条可操作的路径。
  const canEscalate = effective && (options.workdir ?? '') !== ''
  const platform = options.platform ?? ''
  // 上面已经按「argv[0] 必须是 crwu」放行过了；这里再把命令名换成**包内绝对路径**。
  // 只按名字调用会在 Finder 启动的桌面端直接失败（PATH 里没有 crwu，实测
  // `bash: crwu: command not found`），而那时「氚云登录」按钮点了没有任何反应。
  const resolved = await resolveBundledCommand(ctx, platform, 'crwu')
  // 命令位置必须走 `shellInvoke`：Windows 上的 PowerShell 需要调用运算符 `&`，
  // 否则以引号开头的绝对路径会被当成字符串表达式（员工实测的 ParserError）。
  const result: ShellResult = await runShell(ctx, shellInvoke(resolved, clean.slice(1), platform), {
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    timeoutMs: options.timeoutMs ?? 60_000,
    escalate: canEscalate,
    ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  const blocked = keychainBlocked(result)
  // 沙箱拒绝（受限沙箱下读钥匙串 / 写用户目录）要说清原因，否则上层会把
  // 「secret not found in keyring」当成「真的没登录」显示出去。
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
    escalated: canEscalate,
    sandbox: result.sandbox,
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
