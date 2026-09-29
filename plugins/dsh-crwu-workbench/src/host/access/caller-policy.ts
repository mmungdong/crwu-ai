/**
 * **调用方会话的策略** —— 案例内操作唯一的一处解析口。
 *
 * ## 为什么必须由调用方解析，而且必须显式传下去
 *
 * DSH 的执行侧（shell 执行器与 fs 服务）**都不持有会话**：
 *
 * - `dsh-sandbox-policy`：*"executors and providers remain session-free"* ——
 *   `resolve()` 不带 session 时返回的是**部署默认**（`workspace-write` + 配置里的兜底根，
 *   通常就是进程 cwd）；
 * - `dsh-fs-sandbox` 的 `checkedTarget()`：`const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`
 *   —— 不传策略就落到同一个部署默认；
 * - `dsh-sandbox-policy` 的文档写得很直白：*"**A session cwd is its workspace-write boundary**;
 *   the configured root is the fallback for agentless calls and sessions without a cwd."*
 *
 * 于是一个"看起来只是写自己所在目录"的操作会被自家沙箱拒掉。2026-09-30 真机连挂三次，
 * 三次都是同一个形状，只是通道不同：
 *
 * | 次序 | 通道 | 现场 |
 * | --- | --- | --- |
 * | ① | 裸 `runShell` | 建**案例目录**回 `Operation not permitted`（案例目录在会话 cwd 之外，特权操作修好了） |
 * | ② | Broker 非特权 shell | 建**输入快照**目录回 `Operation not permitted`（换 ctx 没用，执行器不认识会话） |
 * | ③ | `ctx.fs.writeText` | **三个快照 JSON 写不进去**：`FS_SANDBOX_DENIED: cannot write "…": file access denied under workspace-write mode` |
 *
 * 三者的正解是同一条：**调用方把自己会话的策略算出来，放进这次调用里**。
 * 提权仍然只由操作描述表决定（`privileged`）；这里只回答"非特权操作落在谁的边界里"。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// 只为类型增强：`Context.sandboxPolicy`。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { text } from '../../shared/utils/value.ts'

/** 逐次声明的沙箱策略：与 DSH `SandboxExecutionPolicy` 的两个字段同形。 */
export interface CallerPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}

/**
 * 解析**某条会话**当前生效的策略；拿不到（无会话 / 服务不可用 / 模式不认识）时返回 `undefined`。
 *
 * `undefined` 不是"随便"：它意味着这次调用只能落在**部署默认**上 —— 那正是三次真机故障的形态，
 * 所以调用点必须把会话带上（见 `BrokerShellOptions.session` 与各 Tool 的 `callerSession(exec)`）。
 * `read-only` 也照原样返回：会话要是只读，案例内的写操作本来就该被拒，我们**不替它放宽**。
 */
export function callerSessionPolicy(ctx: Context, session: Session | undefined): CallerPolicy | undefined {
  if (session === undefined) return undefined
  const service = ctx.get('sandboxPolicy') as
    { resolve?: (request: { session?: Session }) => { mode?: unknown; workspaceRoot?: unknown } } | undefined
  if (typeof service?.resolve !== 'function') return undefined
  try {
    const resolved = service.resolve({ session })
    const mode = text(resolved?.mode)
    if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') return undefined
    return { mode, workspaceRoot: text(resolved?.workspaceRoot) }
  } catch (error) {
    void error
    return undefined
  }
}
