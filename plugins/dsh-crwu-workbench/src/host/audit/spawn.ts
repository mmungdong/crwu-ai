import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { text } from '../../shared/utils/value.ts'
import { AUDIT_CHILD_DENIED_TOOLS } from '../tools/consts.ts'

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
  /**
   * `SubagentRun.localAgent`：**本进程**里那个真实的子 Agent（远程 provider 是 `undefined`）。
   *
   * 为什么要留着它（2026-09-29 第三轮复查的 P1）：子会话的沙箱/审批/工具可见性复查
   * 全靠"读到那个 child Agent"。远程运行拿不到它，`agents.get(id)` 也可能查不到 ——
   * 那时**必须 fail closed**，不能只记一条 warning 就把审核放过去。
   */
  localAgent: Agent | undefined
}

/** 可选的 agents 服务。 */
export function agentRegistry(ctx: Context): AgentRegistry | undefined {
  return ctx.get('agents') as AgentRegistry | undefined
}

/**
 * 面板**已绑定的父会话**对应的 agent（`bind-session` 落盘的那个 id）。
 *
 * 为什么需要它：环境自检跑在 `host-background`，RPC 负载里只有 `{ op, args }`、**没有会话上下文**，
 * 而 `load_workspace_dependencies` 需要 agent 作用域 —— 不带 agent 调它就是"工具报错"，
 * 运行时于是永远解析不出来（2026-09-29 员工 Windows 实测：会话里调同一个工具返回完整载荷）。
 * 审核启动用的就是这个 agent，自检复用同一个来源，两处口径一致。
 *
 * 没绑定 / 拿不到 → `undefined`，调用方退回不带 agent 的调用（那种情况只报「待复核」，不判缺失）。
 */
export function boundParentAgent(ctx: Context, parentSessionId: string): unknown {
  const id = text(parentSessionId)
  if (id === '') return undefined
  return agentRegistry(ctx)?.get(id as SessionId)
}

/** 可选的 subagents 服务。 */
export function subagentRegistry(ctx: Context): SubagentRuntime | undefined {
  return ctx.get('subagents') as SubagentRuntime | undefined
}

/**
 * 挑选子代理 provider：spawn > fork > 第一个注册的，**且必须支持 `toolFilter`**。
 *
 * 为什么把"支持过滤"当成硬条件：审核子会话的工具可见范围必须真的收窄
 *（`record_get` / `files_list` / `case_bootstrap` 不能给它）—— 只靠"必需集名单"是**假边界**，
 * 子会话照样看得到、也执行得了。不支持过滤的 provider 直接在**创建子会话之前**拒绝。
 */
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
  // ⚠️ **不再回退到"第一个注册的"**（2026-09-29 第三轮复查的 P1）：审核要求
  //   · provider 支持 `toolFilter`（真工具边界），且
  //   · 它能给出**本进程**的子 Agent（`localAgent`）从而让沙箱/审批/cwd/workspaceRoot 可回读。
  // 远程 provider 满足不了第二条，所以只接受 DSH 的本地 in-process provider（`spawn` / `fork`）。
  const provider = names.includes('spawn') ? 'spawn' : 'fork'
  if (!names.includes(provider)) {
    return {
      ok: false,
      error: `审核只允许本地可验证的子代理 provider（spawn / fork）：当前部署注册的是 ${names.join('、')}。远程 provider 无法回读子会话的沙箱与审批事实，因此拒绝创建审核子会话。`,
      provider: '',
      names,
    }
  }
  const filter = toolFilterSupport(subagents, provider)
  if (!filter.ok) return { ok: false, error: filter.error, provider: '', names }
  return { ok: true, error: '', provider, names }
}

/**
 * 这个 provider 能不能做子会话工具过滤。
 *
 * 三级都要过：服务有 `getProvider` → provider 在注册表里 → `capabilities.toolFilter === true`。
 * 任何一级问不到都算**不支持**（fail closed）：宁可拒绝起审核，也不让子会话带着未收窄的工具集跑。
 */
function toolFilterSupport(
  subagents: SubagentRuntime,
  provider: string,
): { ok: boolean; error: string } {
  if (typeof subagents.getProvider !== 'function') {
    return { ok: false, error: 'subagents 服务没有 getProvider：无法确认子代理支持 toolFilter，拒绝创建审核子会话。' }
  }
  const descriptor = subagents.getProvider(provider)
  if (descriptor === undefined) {
    return { ok: false, error: `子代理 provider（${provider}）不在注册表里：无法确认它支持 toolFilter。` }
  }
  if (descriptor.capabilities?.toolFilter !== true) {
    return {
      ok: false,
      error: `子代理 provider（${provider}）不支持 toolFilter：无法把审核子会话的工具集收窄到必需的那几条，拒绝创建。`,
    }
  }
  return { ok: true, error: '' }
}

/** 创建一条审核子会话。 */
export async function startChild(
  ctx: Context,
  options: { label: string; prompt: string; parentSessionId: string },
): Promise<SpawnResult> {
  const failed = (error: string): SpawnResult => ({
    ok: false, error, childId: '', provider: '',
    handle: { run: undefined, abort: undefined }, localAgent: undefined,
  })
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
      // **真实的工具边界**：DSH 在子会话的创建窗口里做 scoped `tools.restrict()` ——
      // deny 的工具从 prompt 消失**并且**拒绝执行（一个可见性），未知名字会被响亮地校验出来。
      toolFilter: { deny: [...AUDIT_CHILD_DENIED_TOOLS] },
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
    // DSH 在 start 兑现时给出的**本进程子 Agent**；远程 provider 为 undefined。
    localAgent: started.localAgent,
  }
}

export interface StopOutcome {
  childId: string
  aborted: boolean
  /** dispose **真的**完成了（超时不算）。 */
  disposed: boolean
  /**
   * 是不是**确认停下来了**：dispose 完成，或 Agent 已不再 running。
   *
   * 重启/覆盖记录之前必须看这一个 —— 只看 `aborted` 会把"信号发出去了"当成"它停了"。
   */
  quiesced: boolean
  interrupted: boolean
  agentCancelled: boolean
  /** 阻塞性错误：非空就不许当成"停好了"。 */
  errors: string[]
  /** 非阻塞的观察（例如"dispose 超时但 Agent 已不在运行"）。 */
  notes: string[]
}

/**
 * 停止一条审核子会话。
 *
 * 顺序是硬要求：abort → dispose；句柄缺失时退到 `agents.get(childId).cancel()`。
 * 每一步的失败都收进 `errors` 而不是抛出 —— 调用方需要据此决定「是否继续重启」。
 */
/**
 * 有界等待：`pending` 先完成 → `'settled'`；计时器先到 → `'timeout'`。
 *
 * 三级来源：DSH 的 `timer` 服务 → 全局 `setTimeout` → 都没有就**立刻**算超时。
 * 最后那一级是刻意的：停止路径**不允许无界等待**（dispose 不收敛时，宁可按"没停下"处理）。
 */
async function raceWithTimeout(
  pending: Promise<unknown>,
  timer: { timeout?: (ms: number) => Promise<void> } | undefined,
  ms: number,
): Promise<'settled' | 'timeout'> {
  const started = pending.then(() => 'settled' as const)
  if (timer !== undefined && typeof timer.timeout === 'function') {
    return await Promise.race([started, timer.timeout(ms).then(() => 'timeout' as const)])
  }
  const globalSetTimeout = (globalThis as { setTimeout?: (handler: () => void, ms: number) => unknown }).setTimeout
  if (typeof globalSetTimeout !== 'function') return 'timeout'
  return await Promise.race([
    started,
    new Promise<'timeout'>((resolve) => { globalSetTimeout(() => { resolve('timeout') }, ms) }),
  ])
}

export async function stopChild(
  ctx: Context,
  childId: string,
  reason: string,
  options: {
    handle?: ChildHandle
    parentSessionId?: string
    /**
     * 阶段回调（F1 两阶段停止）：每次进入新阶段时调用一次，让调用方**立刻落盘**。
     * 不返回 Promise 也不 await —— 落盘由调用方自己排队，避免把停止路径拖长。
     */
    onPhase?: (phase: 'aborting' | 'waiting-quiescence' | 'quiesced' | 'timeout') => void | Promise<void>
  },
): Promise<StopOutcome> {
  const out: StopOutcome = {
    childId, aborted: false, disposed: false, quiesced: false,
    interrupted: false, agentCancelled: false, errors: [], notes: [],
  }
  const handle = options.handle

  await options.onPhase?.('aborting')
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
    const registry = agentRegistry(ctx)
    const child = registry?.get(childId as SessionId) as { cancel?: (reason: unknown) => void } | undefined
    if (child !== undefined && typeof child.cancel === 'function') {
      try {
        child.cancel({ kind: 'parent' })
        out.agentCancelled = true
        out.aborted = true
      } catch (error) {
        out.errors.push(`cancel：${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (registry === undefined) {
      // 问不到：不许当成"已经结束了"（下面 `quiesced` 会据此 fail closed）。
      out.errors.push('agents 服务不可用：无法确认子会话是否还在运行。')
    } else {
      // 注册表在、查不到它 → **它已经不在运行**：这是好事，不是错误。
      out.notes.push('该子会话已不在 Agent 注册表里（已结束），无需取消。')
    }
  }

  // 发出取消之后、进入"等静默"之前：界面到这里就必须显示"正在确认子会话已完全停止"。
  await options.onPhase?.('waiting-quiescence')
  if (handle?.run !== undefined && typeof handle.run.dispose === 'function') {
    const timer = ctx.get('timer') as { timeout?: (ms: number) => Promise<void> } | undefined
    let settled = false
    const pending = handle.run.dispose().then(
      () => { settled = true },
      (error: unknown) => { out.errors.push(`dispose：${error instanceof Error ? error.message : String(error)}`) },
    )
    try {
      // ⚠️ 计时器是**正常 resolve** 的：`Promise.race` 里它赢的时候**不会进 catch**，
      // 于是旧实现在超时时 `disposed=false` 但 `errors=[]` —— 上层只要 abort 发出就继续重试，
      // 而旧子会话可能还在跑，随后第二条会覆盖它的 childId（2026-09-29 用户复查的 P1）。
      // 所以这里显式区分"谁赢了"，并**必须**用"Agent 已不再 running"来佐证"真的停下来了"。
      //
      // ⚠️ 等待**必须有界**：没有 timer 服务时退化成全局定时器；连它都没有就按超时处理。
      // 旧实现的无 `timer` 分支是 `await pending` —— dispose 不收敛会把整条停止路径挂死
      //（2026-09-29 写这条用例时当场挂住）。
      const winner = await raceWithTimeout(pending, timer, 8_000)
      if (winner === 'timeout') out.notes.push('dispose 在 8 秒内没有结束（计时器先完成）')
    } catch (error) {
      void error
      out.errors.push(`dispose 等待失败：${error instanceof Error ? error.message : String(error)}`)
    }
    out.disposed = settled
  }

  // **静默判据**（不看 dispose 的返回值，只看"它还在不在跑"）：
  // 只有"dispose 真的完成"或"Agent 已不在 running"才算停下来了。
  // 拿不准（既不完成、又仍显示 running）→ 记一条错误，且**不许**丢句柄 / 覆盖记录。
  //
  // 先给一个**有界的等待**再下结论：`abort()` 发出后子会话不会瞬间从注册表消失，
  // 立刻读状态会把"正在死"误判成"没停下来"（手动停止会因此报失败）。
  // 三态：`true` = 还在跑；`false` = **确认**不在跑（注册表在、且查不到 / 状态不是 running）；
  // `undefined` = **问不到**（没有 agents 服务）—— 这时不许当"已经停了"。
  const runningNow = (): boolean | undefined => {
    const registry = agentRegistry(ctx)
    if (registry === undefined || typeof registry.get !== 'function') return undefined
    const agent = registry.get(childId as SessionId) as { status?: unknown } | undefined
    return agent === undefined ? false : text(agent.status) === 'running'
  }
  if (!out.disposed) {
    const timer = ctx.get('timer') as { timeout?: (ms: number) => Promise<void> } | undefined
    const sleep = async (ms: number): Promise<void> => {
      if (timer !== undefined && typeof timer.timeout === 'function') { await timer.timeout(ms); return }
      // 测试替身可能没有 timer：退化成"立刻再看一眼"（用例自己控制 status 何时翻）。
    }
    for (let attempt = 0; attempt < 8 && runningNow() === true; attempt += 1) await sleep(250)
  }
  const running = runningNow()
  out.quiesced = out.disposed || running === false
  await options.onPhase?.(out.quiesced ? 'quiesced' : 'timeout')
  if (!out.quiesced && running === undefined) {
    out.errors.push('没法确认子会话是否已经停下来（agents 服务不可用）：不释放它的身份，也不启动下一条。')
  }
  if (!out.quiesced) {
    out.errors.push('无法确认子会话已经停下来（dispose 未完成，且 Agent 仍在运行）：不会释放它的身份，也不会启动下一条。')
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
