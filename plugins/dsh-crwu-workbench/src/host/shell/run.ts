import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecSpec, ShellExecutor } from '@deepseek-ai/dsh-shell'
import { finiteNumber, text } from '../../shared/utils/value.ts'

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
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_STDOUT_MAX_BYTES = 65_536

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

function failed(error: string): ShellResult {
  return { ok: false, error, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false }
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
    stdoutMaxBytes?: number
    stdinText?: string
  } = {},
): Promise<ShellResult> {
  const shell = ctx.get('shell') as ShellExecutor | undefined
  if (shell === undefined) return failed('Host shell 服务不可用')

  const workRoot = options.workdir ?? ''
  if (options.escalate === true && workRoot === '') {
    return failed('未知会话工作区，无法申请无沙箱执行')
  }

  let spec: ShellExecSpec
  try {
    spec = shell.resolve({
      command,
      ...(workRoot === '' ? {} : { workdir: workRoot }),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdoutMaxBytes: options.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES,
      ...(options.stdinText === undefined ? {} : { stdin: options.stdinText }),
      ...(options.escalate === true
        ? { sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workRoot } }
        : {}),
    })
  } catch (error) {
    return failed(`执行失败：${failureMessage(error)}`)
  }

  try {
    const result = await shell.run(spec)
    return {
      ok: result.exitCode === 0,
      error: '',
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: text(result.stdout?.text),
      stderr: text(result.stderr?.text),
      truncated: result.stdout?.truncated === true || result.stderr?.truncated === true,
      timedOut: result.timedOut === true,
    }
  } catch (error) {
    return failed(`执行失败：${failureMessage(error)}`)
  }
}

/**
 * 命令**根本没有执行**（shell 服务缺失、沙箱后端不可用、审批拒绝、`resolve` 抛错）。
 *
 * 依据 DSH 契约（`@deepseek-ai/dsh-shell` 的 `ShellExecutor.run` 文档）：
 * 「`run` 只为**基础设施故障** reject；非零退出、超时击杀、取消击杀都 resolve 成
 * `ShellRunResult`」。所以本模块里带 `error` 的结果只可能来自 reject 或 `resolve` 抛错，
 * 与「命令跑完了、只是退出码非 0」是两件事。
 *
 * **为什么这个区分必须存在**（真实 DSH 上踩到过）：沙箱后端不可用（macOS 上
 * `sandbox-exec: sandbox_apply: Operation not permitted`，典型原因是进程本身已在沙箱里）时，
 * `command -v node` 会执行失败。若把「执行失败」当成「命令不存在」，环境自检页就会对一台装好了
 * Node / Python 的机器报「未安装」，把人送去装一个已经装好的东西。
 */
export function shellUnavailable(result: ShellResult): boolean {
  return result.error !== ''
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
