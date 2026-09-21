import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { text } from '../../shared/utils/value.ts'

/**
 * 子代理的创建、句柄保存与停止。
 *
 * 这一层最容易踩的坑（legacy 里都有血泪注释，这里保持同样结论）：
 *
 * 1. **停一条 one-shot 审核必须「先 abort 再 dispose」**。`subagents.interrupt` 对一次性运行
 *    是记录在案的 no-op；真正的取消只发生在驱动监听调用方 signal 的 abort 事件时
 *    （onAbort → child.cancel）。而 `run.dispose()` 会先摘掉 abort 监听再 await 结果 ——
 *    拿一个不会响的信号去 dispose，等于干等审核跑完。所以句柄里必须留着可 abort 的信号。
 * 2. **句柄会随插件重装失效**。每次 `cordis_define`/profile 重启都是新实例，`runs` 表必然为空，
 *    而子会话还在跑。所以停止要有退路：直接对 `agents.get(childId).cancel()` 下手。
 * 3. **provider 要挑**：优先 `spawn`，其次 `fork`，否则用第一个注册的。
 */

export interface ChildHandle {
  /** 已发布的 run；持有它是为了在停止时调用 `dispose()`。 */
  run: SubagentRun | undefined
  /** 取消通道：必须在 dispose 之前触发，否则 dispose 会一直等到审核跑完。 */
  abort: ((reason?: unknown) => void) | undefined
}

export interface SpawnResult {
  ok: boolean
  error: string
  childId: string
  provider: string
  handle: ChildHandle
}

/** 可选的 agents 服务。 */
export function agentRegistry(ctx: Context): AgentRegistry | undefined {
  return ctx.get('agents') as AgentRegistry | undefined
}

/** 可选的 subagents 服务。 */
export function subagentRegistry(ctx: Context): SubagentRuntime | undefined {
  return ctx.get('subagents') as SubagentRuntime | undefined
}

/** 挑选子代理 provider：spawn > fork > 第一个注册的。 */
export function pickProvider(ctx: Context): { ok: boolean; error: string; provider: string; names: string[] } {
  const subagents = subagentRegistry(ctx)
  if (subagents === undefined) return { ok: false, error: 'Host subagents 服务不可用', provider: '', names: [] }
  let names: string[] = []
  try {
    const listed = subagents.list()
    names = Array.isArray(listed) ? listed.map((item) => text(item)) : []
  } catch (error) {
    // 列不出来就当作没有 provider，让上层给出准确提示。
    void error
    names = []
  }
  if (names.length === 0) return { ok: false, error: '当前部署没有注册任何子代理 provider', provider: '', names }
  const provider = names.includes('spawn') ? 'spawn' : (names.includes('fork') ? 'fork' : (names[0] ?? ''))
  return { ok: true, error: '', provider, names }
}

/** 创建一条审核子会话。 */
export async function startChild(
  ctx: Context,
  options: { label: string; prompt: string; parentSessionId: string },
): Promise<SpawnResult> {
  const failed = (error: string): SpawnResult => ({ ok: false, error, childId: '', provider: '', handle: { run: undefined, abort: undefined } })
  const agents = agentRegistry(ctx)
  const subagents = subagentRegistry(ctx)
  if (agents === undefined) return failed('Host agents 服务不可用')
  if (subagents === undefined) return failed('Host subagents 服务不可用')

  const parent = agents.get(options.parentSessionId as SessionId)
  if (parent === undefined) {
    return failed(`父会话的 Agent 不在运行中（id ${options.parentSessionId}），无法创建子会话。`)
  }

  const picked = pickProvider(ctx)
  if (!picked.ok) return failed(picked.error)

  // 包形态有真正的 AbortController：legacy 手写的 signal 替身整段可以删掉。
  const controller = new AbortController()
  let started: SubagentRun
  try {
    started = await subagents.start(picked.provider, {
      label: options.label,
      prompt: [{ type: 'text', text: options.prompt }],
      parent: parent as Agent,
      signal: controller.signal,
    })
  } catch (error) {
    return failed(`创建子会话失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    ok: true,
    error: '',
    childId: text(started.id),
    provider: picked.provider,
    handle: { run: started, abort: (reason?: unknown) => controller.abort(reason ?? new Error('用户在中瑞世联工作台停止了这条审核')) },
  }
}

export interface StopOutcome {
  childId: string
  aborted: boolean
  disposed: boolean
  interrupted: boolean
  agentCancelled: boolean
  errors: string[]
}

/**
 * 停止一条审核子会话。
 *
 * 顺序是硬要求：abort → dispose；句柄缺失时退到 `agents.get(childId).cancel()`。
 * 每一步的失败都收进 `errors` 而不是抛出 —— 调用方需要据此决定「是否继续重启」。
 */
export async function stopChild(
  ctx: Context,
  childId: string,
  reason: string,
  options: { handle?: ChildHandle; parentSessionId?: string },
): Promise<StopOutcome> {
  const out: StopOutcome = { childId, aborted: false, disposed: false, interrupted: false, agentCancelled: false, errors: [] }
  const handle = options.handle

  if (handle !== undefined && typeof handle.abort === 'function') {
    try {
      handle.abort(new Error(reason === '' ? '用户在中瑞世联工作台停止了这条审核' : reason))
      out.aborted = true
    } catch (error) {
      out.errors.push(`abort：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    // 句柄没了的退路：插件重装后子会话还在跑，但 runs 表已清空。
    // `agents.get(childId)` 拿到的就是那个还活着的子 Agent。
    const child = agentRegistry(ctx)?.get(childId as SessionId)
    if (child !== undefined && typeof child.cancel === 'function') {
      try {
        child.cancel({ kind: 'parent' })
        out.agentCancelled = true
        out.aborted = true
      } catch (error) {
        out.errors.push(`cancel：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      out.errors.push('该子会话已不在运行中的 Agent 注册表里（可能已结束），没有可用的取消入口。')
    }
  }

  if (handle?.run !== undefined && typeof handle.run.dispose === 'function') {
    const timer = ctx.get('timer') as { timeout?: (ms: number) => Promise<void> } | undefined
    let settled = false
    const pending = handle.run.dispose().then(
      () => { settled = true },
      (error: unknown) => { out.errors.push(`dispose：${error instanceof Error ? error.message : String(error)}`) },
    )
    try {
      if (timer !== undefined && typeof timer.timeout === 'function') {
        await Promise.race([pending, timer.timeout(8_000)])
      } else {
        await pending
      }
    } catch (error) {
      void error
      out.errors.push('dispose 等待超时；取消信号已发出，句柄会自行释放。')
    }
    out.disposed = settled
  }

  const subagents = subagentRegistry(ctx)
  if (subagents !== undefined && typeof subagents.interrupt === 'function' && (options.parentSessionId ?? '') !== '') {
    try {
      subagents.interrupt(childId as SessionId, { kind: 'user', parentSessionId: options.parentSessionId as SessionId })
      out.interrupted = true
    } catch (error) {
      out.errors.push(`interrupt：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return out
}
