import type { Context } from '@deepseek-ai/cordis'
import { shellInvoke } from '../platform/shell.ts'
import type { ShellResult } from '../shell/run.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessOperation, LocalAccessSource } from '../access/operations.ts'

/**
 * `ossutil` 的**唯一**执行入口（协议 18）。
 *
 * ## 为什么必须收成一个文件
 *
 * `ossutil` 的**每一次**调用都会读 `~/.ossutilconfig` —— 那是工作区之外的凭据文件，
 * 受限沙箱（`workspace-write`）下读不到，命令会以一个**和 AK 无关**的错失败
 * （员工实测：`Access is denied` / `permission denied`，看着像密钥错，其实是沙箱）。
 *
 * 所以每一次调用都必须经 Broker 逐次声明 `danger-full-access`，并且带上"这次是谁在做什么"：
 * 读（`ls` / `cat` / `sign`）算 `oss.remote.read`，写（`cp` 上传）算 `oss.remote.write`。
 *
 * 2026-09-29 复查抓到：`oss/ops.ts` 与 `tools/oss.ts` 里各有几处**直接**调 `shell/run.ts`
 * 的 `runShell`，只有探测那一条走了 Broker —— 于是列举 / 读结果 / 签名 / 上传 / 写后校验
 * 全都在受限沙箱下跑，审核子会话里必然失败。静态门禁当时只检查"文件里出现过一次
 * `access.runShell`"，所以是**假绿**；现在的判据是"OSS 代码里不许出现裸 `runShell`"。
 *
 * 这一层是**纯执行器**：命令形状由调用方拼（都是固定模板 + 经过前缀隔离的 key），
 * 它只负责"经 Broker、带对的操作、带对的来源"。
 */

export interface OssExecDeps {
  ctx: Context
  /** Broker：授权、来源、提权与诊断都在它那里判。 */
  access: LocalAccessBroker
  platform: string
  /** 命令的工作目录（案例目录或会话工作区）。 */
  workdir: string
  /** 这次调用是谁发起的（面板 / 审核 Tool / 宿主后台）。 */
  source: LocalAccessSource
}

export interface OssExecOptions {
  /** `oss.remote.read`（ls / cat / sign）或 `oss.remote.write`（cp 上传）。 */
  operation: Extract<LocalAccessOperation, 'oss.remote.read' | 'oss.remote.write'>
  /** 完整 argv，第一个元素是 `ossutil` 的可执行路径。 */
  argv: readonly string[]
  timeoutMs?: number
  stdoutMaxBytes?: number
  signal?: AbortSignal
  /** 脱敏摘要（只留域名与子命令）。 */
  summary?: string
}

/**
 * 跑一条 `ossutil` 命令。
 *
 * 未授权时**一个进程都不起**（Broker 直接拒），返回的结果带着 `error`，
 * 调用方的错误分支会把它如实说出来 —— 而不是把一个沙箱假象当成"密钥错"。
 */
export async function runOssutil(deps: OssExecDeps, options: OssExecOptions): Promise<ShellResult> {
  const executable = options.argv[0] ?? ''
  const command = shellInvoke(executable, options.argv.slice(1), deps.platform)
  return deps.access.runShell(
    { operation: options.operation, source: deps.source, workdir: deps.workdir },
    command,
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.summary === undefined ? {} : { summary: options.summary }),
    },
  )
}
