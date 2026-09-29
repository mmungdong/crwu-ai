import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { shellInvoke } from '../platform/shell.ts'
import { requireBundledCommand } from '../platform/command.ts'
import { sandboxDenialNote, type ShellResult } from '../shell/run.ts'
import { DWS_ALLOWED_PREFIXES, DWS_OPERATION_BY_PREFIX, DWS_STDOUT_MAX, DWS_TIMEOUT_MS } from './consts.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessOperation, LocalAccessSource } from '../access/operations.ts'

/**
 * `dws` 的结构化执行器：**唯一**允许调用 `dws` 的地方（自研审核链路）。
 *
 * 四道门禁，缺一条就会退化成「模型能跑任意 dws 命令」：
 * 1. **命令白名单**（`assertDwsCommand`）：argv 必须匹配 `dws/consts.ts` 登记的形状，
 *    表外默认拒绝。模型永远不接触 argv —— 它只提交业务参数，argv 由各 Tool 自己拼。
 * 2. **包内绝对路径**：走 `requireBundledCommand`，受支持平台上二进制必须存在，
 *    否则回 capability gap。**绝不回退裸命令名** —— 那会让模型看到 `command not found`
 *    然后去猜/搜 PATH，正是本次改造要消灭的行为。
 * 3. **提权只对本机凭据操作开放**：见 `DWS_ESCALATION_RULES`，且必须已授权 + workspaceRoot 已知。
 *    模型无法通过任何参数请求提权。
 * 4. **sandbox / approval / 取消信号全部保留**：命令最终由 `ctx.shell.execute` 执行，
 *    `signal` 透传，失败按「审批拒绝 / shell 基础设施故障 / CLI 非零退出」三分类返回。
 */

/** 命令被白名单拒绝。 */
export interface DwsRejected {
  ok: false
  errorKind: 'input'
  error: string
}

export type DwsCommandCheck = { ok: true; prefix: readonly string[] } | DwsRejected

/** 允许出现在产品域之前的**全局**取值 flag；值必须紧随其后。 */
const GLOBAL_VALUE_FLAGS = ['--profile'] as const

/**
 * 拆出前导全局 flag。
 *
 * `dws --profile <id> wiki space list …` 是本仓既有回传脚本验证过的调用形状
 * （`--profile` 是持久 flag，位置在产品域之前）。白名单校验只看剩下的 argv，
 * 而 profile 的取值**永远来自真实返回**（Tool 内部解析），不是模型提交。
 */
export function splitDwsGlobalFlags(argv: readonly string[]): { globals: string[]; rest: string[] } {
  const globals: string[] = []
  let index = 0
  while (index < argv.length && (GLOBAL_VALUE_FLAGS as readonly string[]).includes(text(argv[index]))) {
    globals.push(text(argv[index]), text(argv[index + 1]))
    index += 2
  }
  return { globals, rest: argv.slice(index).map((item) => text(item)) }
}

/** 找出 argv 命中的白名单前缀（最长匹配优先，避免「短前缀放行更长的命令」）。 */
export function matchDwsPrefix(argv: readonly string[]): readonly string[] | null {
  const { rest } = splitDwsGlobalFlags(argv)
  let best: readonly string[] | null = null
  for (const prefix of DWS_ALLOWED_PREFIXES) {
    if (prefix.length > rest.length) continue
    if (!prefix.every((word, index) => rest[index] === word)) continue
    if (best === null || prefix.length > best.length) best = prefix
  }
  return best
}

/**
 * 校验一条 `dws` argv 是否在白名单里。
 *
 * 只做**形状**校验（argv 前缀逐字相等），不解释业务参数：参数由各 Tool 用固定模板拼装，
 * 并且都经过 `shellQuote`。这就是「模型输入不进任意命令字符串」的落点。
 */
export function assertDwsCommand(argv: readonly string[]): DwsCommandCheck {
  if (argv.length === 0) return { ok: false, errorKind: 'input', error: 'dws 命令为空' }
  const prefix = matchDwsPrefix(argv)
  if (prefix === null) {
    const { rest } = splitDwsGlobalFlags(argv)
    return {
      ok: false,
      errorKind: 'input',
      error: `dws 命令不在白名单内：${rest.slice(0, 3).join(' ')}`,
    }
  }
  return { ok: true, prefix }
}

/**
 * 把一条**形状合法**的 `dws` 命令映射成本机访问操作。
 *
 * 与命令白名单是**两层**：白名单回答「能不能跑」，这一层回答「算哪一类本机访问、
 * 要不要提权、哪些来源能做」。表外（或白名单里有、操作表里没有）一律返回 `null` → 拒绝执行。
 *
 * 最长前缀优先与 `matchDwsPrefix` 保持一致：`drive +upload` 不能被 `drive +list` 之类的
 * 短前缀抢走，否则一次上传会被算成只读操作。
 */
export function dwsOperationOf(argv: readonly string[]): LocalAccessOperation | null {
  const prefix = matchDwsPrefix(argv)
  if (prefix === null) return null
  let best: { length: number; operation: LocalAccessOperation } | null = null
  for (const [candidate, operation] of DWS_OPERATION_BY_PREFIX) {
    if (candidate.length !== prefix.length) continue
    if (!candidate.every((word, index) => word === prefix[index])) continue
    if (best === null || candidate.length > best.length) best = { length: candidate.length, operation }
  }
  return best?.operation ?? null
}

/** 失败分类：与「命令跑完了但退出码非 0」严格区分。 */
export type DwsErrorKind = '' | 'input' | 'capability-gap' | 'approval' | 'infrastructure' | 'cli' | 'cancelled'

export interface DwsRunResult {
  ok: boolean
  errorKind: DwsErrorKind
  error: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  aborted: boolean
  escalated: boolean
  /** 经白名单校验的展示用命令（已脱敏：只有域 + 子命令 + 显式 flag 名，不含任何凭据）。 */
  command: string
}

export interface DwsRunOptions {
  /** 命令的工作目录；提权必须有它（DSH 契约）。 */
  workdir: string
  /** Tool 的 `exec.signal`。 */
  signal?: AbortSignal
  timeoutMs?: number
  stdoutMaxBytes?: number
  /** Broker（协议 18）：唯一执行入口。提权由操作身份决定，调用方提交不了。 */
  access: LocalAccessBroker
  /** 这次调用是谁发起的（面板登录 / 审核 Tool / 宿主后台）。 */
  source: LocalAccessSource
}

/** 给界面/日志用的命令摘要：只保留命中的白名单前缀，避免把参数里的业务标识散出去。 */
export function describeDwsCommand(argv: readonly string[]): string {
  const prefix = matchDwsPrefix(argv) ?? splitDwsGlobalFlags(argv).rest.slice(0, 2)
  return ['dws', ...prefix].filter((part) => part !== '').join(' ')
}

/**
 * 失败归类。
 *
 * 三件事必须分开，否则排查方向会完全错：
 * - `approval`：命令被审批策略拒绝（DSH 用基础设施 reject 表达）；
 * - `infrastructure`：shell 服务缺失 / 沙箱后端不可用等**命令没跑起来**的情况；
 * - `cli`：命令跑完了，退出码非 0（业务失败）。
 */
export function classifyShellFailure(result: { error: string; aborted: boolean; exitCode: number | null }): DwsErrorKind {
  if (result.aborted) return 'cancelled'
  if (result.error !== '') {
    return /approval|denied|reject|审批/i.test(result.error) ? 'approval' : 'infrastructure'
  }
  return result.exitCode === 0 ? '' : 'cli'
}

function failure(errorKind: DwsErrorKind, error: string, command: string, escalated = false): DwsRunResult {
  return {
    ok: false, errorKind, error, exitCode: null, stdout: '', stderr: '',
    truncated: false, timedOut: false, aborted: errorKind === 'cancelled', escalated, command,
  }
}

/**
 * 执行一条 `dws` 命令。
 *
 * 命令名的解析是**严格**的：受支持平台上包内二进制必须存在，否则返回 capability gap，
 * 不会退回裸 `dws`。不支持随包二进制的平台（例如 linux-x64）同样回 capability gap ——
 * 那种部署要靠显式配置/受信 world facts 决定执行世界的 CLI，而不是让模型去找路径。
 */
export async function runDws(
  ctx: Context,
  platform: string,
  argv: readonly string[],
  options: DwsRunOptions,
): Promise<DwsRunResult> {
  const shown = describeDwsCommand(argv)
  const checked = assertDwsCommand(argv)
  if (!checked.ok) return failure('input', checked.error, shown)

  const operation = dwsOperationOf(argv)
  if (operation === null) {
    // 形状合法但没有权限归属 = 这个功能还没有登记本机访问操作：**不猜、不放行**。
    return failure('input', `${shown} 还没有登记本机访问操作，拒绝执行`, shown)
  }

  const resolved = await requireBundledCommand(ctx, platform, 'dws')
  if (!resolved.ok) return failure(resolved.errorKind, resolved.error, shown)

  // 配置目录用 CLI 自己的默认（`<HOME>/.dws`）：插件**不**再替它决定位置 ——
  // 曾经为了绕开"某台机器不让 DSH 子进程建目录"固定到插件树，实测证明换目录解决不了问题
  // （详见 docs/development-notes.md §16），所以那条自指定目录的通道整体下掉。
  const command = shellInvoke(resolved.path, argv.map((item) => text(item)), platform)
  const result: ShellResult = await options.access.runShell(
    { operation, source: options.source, workdir: options.workdir },
    command,
    {
      ...(options.workdir === '' ? {} : { workdir: options.workdir }),
      timeoutMs: options.timeoutMs ?? DWS_TIMEOUT_MS,
      stdoutMaxBytes: options.stdoutMaxBytes ?? DWS_STDOUT_MAX,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      summary: shown,
    },
  )

  const errorKind = classifyShellFailure(result)
  // 沙箱拒绝要认出并说清：dws 自己的报错（`Access is denied` 写 `~/.dws`）看起来像它的 bug，
  // 实际是「命令碰了工作区之外的路径」。归因写在消息最前面，原文附在后面以供对照。
  const denied = result.ok ? '' : sandboxDenialNote(result)
  return {
    ok: result.ok,
    errorKind: result.ok ? '' : (errorKind === '' ? 'cli' : errorKind),
    error: result.ok
      ? ''
      : ((denied === ''
        ? (text(result.stderr).trim() || text(result.error).trim() || `dws 退出码 ${String(result.exitCode ?? 'unknown')}`)
        : `${denied}原文：${text(result.stderr).trim() || text(result.error).trim() || `退出码 ${String(result.exitCode ?? 'unknown')}`}`)).slice(0, 600),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    aborted: result.aborted,
    // `escalated` 是**事实**：Broker 认为该提权、且请求确实带着 danger-full-access 出去了。
    escalated: result.sandbox.requested === 'danger-full-access',
    command: shown,
  }
}
