import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { text } from '../../shared/utils/value.ts'
import { mkdirCommand } from '../platform/shell.ts'
import { runShell } from '../shell/run.ts'
import { agentRegistry } from './spawn.ts'
import { auditToolsVisible } from './preflight.ts'
import { persistAuditRoot } from '../state/registry.ts'
import type { AuditRootView } from '../../shared/types.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { WorldFacts } from '../platform/world.ts'

/**
 * 审核根会话（子代理的挂载点）。
 *
 * 为什么需要它：子会话的 cwd 与「子代理树挂在谁下面」都是由**父会话**决定的，而父会话原来是
 * 「哪个会话头最后挂载」——于是你从工作空间 A 的会话点开面板，审核就挂到 A 的会话下，
 * 从别处点开又挂到别处（用户报的「创建新会话时挂错地方」）。
 *
 * 规则（与用户确认过）：
 * 1. **稳定优先**：已有一个可用的根就一直用它，所有审核子代理整齐挂在同一棵树下；
 * 2. 根不可用（进程重启后 Agent 没了、工作空间换了、会话没了）→ **新建一个**，接受分叉；
 * 3. 根必须是一个**干净的真实对话**、cwd 就是插件选定的工作空间，并且命名到「见名知义」；
 * 4. 建完先跑一次 **hello 预检**：证明这个会话真的能被驱动（模型链路 + 工具链 + 沙箱 + cwd），
 *    预检不过就不落钩子、不起审核 —— 否则问题会推迟到第一条真审核才暴露。
 */

/** 根会话的标题前缀；后面会补时间戳，便于区分分叉出来的多棵树。 */
export const AUDIT_ROOT_TITLE = '审核子代理根节点'

/** 预检指令：一次调用同时证明「模型能回」「bash 能用、cwd 正确」「CRWU Tool 链路与 policy pipeline 通」。 */
export const AUDIT_ROOT_PROBE = 'hello，请依次做两件事：① 用 bash 执行 `pwd`；② 调用 `crwu_audit_capabilities`（无参数）。然后回复当前目录，以及该工具返回的 `ok`、`platform` 与 `binPlatform`。'

export interface AuditRootDeps {
  ctx: Context
  state: WorkbenchState
  world: WorldFacts
}

export interface AuditRootResult {
  ok: boolean
  error: string
  sessionId: string
  /** 这一次是复用了已有的根，还是新建的。 */
  created: boolean
  /** 已经做过的事（新建时用于界面提示/诊断）。 */
  notes: string[]
}

/** 根标题：`审核子代理根节点 · 09-20 21:30`。 */
export function auditRootTitle(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${AUDIT_ROOT_TITLE} · ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 生成一个会话 id；DSH 那边只是字符串，格式与自带的一致（`session-<uuid>`）。 */
export function mintSessionId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const uuid = typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  return `session-${uuid}`
}

/**
 * 一次 `followup` 用的用户消息。
 *
 * 不走 `@deepseek-ai/dsh-llm` 的 `createUserMessage`：那会把 dsh-llm 变成我们的一条运行时依赖，
 * 而这里只需要「一条带 id 与 role 的用户消息」这个形状（字段与它产出的完全一致）。
 */
export function probeMessage(sessionSeed: string): Record<string, unknown> {
  return {
    id: `msg-${sessionSeed}`,
    role: 'user',
    content: [{ type: 'text', text: AUDIT_ROOT_PROBE }],
    source: { kind: 'user' },
  }
}

interface LiveAgent {
  id: string
  session?: { header?: Record<string, unknown> }
  followup?: (message: unknown) => void
  whenIdle?: () => Promise<void>
}

/** 取活的 Agent（`agents` 注册表里的就是运行时面，带 followup/whenIdle）。 */
function liveAgent(ctx: Context, sessionId: string): LiveAgent | undefined {
  return agentRegistry(ctx)?.get(sessionId as never) as LiveAgent | undefined
}

export interface RootUsability {
  ok: boolean
  reason: string
}

/**
 * 现有的根还能用吗。
 *
 * 四个判据缺一不可：Agent 还活着（`subagents.start` 要的是活对象，不是 id）、
 * 会话的 cwd 仍然是当前工作空间、它不是子代理、工作空间没换。
 */
export function auditRootUsability(ctx: Context, state: WorkbenchState, workspacePath: string): RootUsability {
  const sessionId = state.auditRoot.sessionId
  if (sessionId === '') return { ok: false, reason: '还没有审核根会话' }
  if (state.auditRoot.workspacePath !== workspacePath) {
    return { ok: false, reason: `工作空间已换（根在 ${state.auditRoot.workspacePath}，现在是 ${workspacePath}）` }
  }
  const agent = liveAgent(ctx, sessionId)
  if (agent === undefined) return { ok: false, reason: '审核根会话已不在运行中（进程重启或被释放）' }
  const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: Record<string, unknown> } | undefined } | undefined
  const header = typeof sessions?.get === 'function' ? sessions.get(sessionId)?.header : undefined
  if (header !== undefined) {
    if (text(header.origin) === 'subagent') return { ok: false, reason: '审核根会话本身是子代理' }
    const cwd = text(header.cwd)
    if (cwd !== '' && cwd !== workspacePath) return { ok: false, reason: `审核根会话的 cwd（${cwd}）不是当前工作空间` }
  }
  return { ok: true, reason: '' }
}

/**
 * 目录不存在就建（`workspaceRegistry.create` 要求目录已存在）。
 *
 * 命令由 `platform/shell.ts` 按平台生成：POSIX 是 `mkdir -p`，Windows 是 PowerShell 的
 * `New-Item -ItemType Directory -Force`（`cmd` 的 `mkdir` 既不认 `-p`，引号解析也是第二套规则）。
 */
async function ensureDirectory(ctx: Context, path: string, workspace: string, platform: string): Promise<string> {
  const result = await runShell(ctx, mkdirCommand(path, platform), { timeoutMs: 20_000, workdir: workspace })
  return result.ok ? '' : (result.error === '' ? `创建目录失败：${path}` : `创建目录失败：${result.error}`)
}

/**
 * 拿到一个可用的审核根会话：能用就用，不能用就新建（建目录 → 登记工作空间 → 建会话 →
 * 命名 → hello 预检 → 落钩子）。
 */
export async function ensureAuditRoot(deps: AuditRootDeps, options: { presetHint?: string } = {}): Promise<AuditRootResult> {
  const { ctx, state } = deps
  const workspacePath = state.workspacePath || state.caseRoot
  const fail = (error: string): AuditRootResult => ({ ok: false, error, sessionId: '', created: false, notes: [] })
  if (workspacePath === '') return fail('尚未选定工作空间：审核根会话需要一个明确的工作空间。')

  const usable = auditRootUsability(ctx, state, workspacePath)
  if (usable.ok) return { ok: true, error: '', sessionId: state.auditRoot.sessionId, created: false, notes: [] }

  const notes: string[] = []
  if (state.auditRoot.sessionId !== '') notes.push(`上一个根不可用：${usable.reason}（按约定新建一个，旧树保留）`)

  const agents = ctx.get('agents') as { create?: (options: Record<string, unknown>) => Promise<{ agent: LiveAgent }> } | undefined
  if (agents === undefined || typeof agents.create !== 'function') return fail('Host agents 服务不可用，无法创建审核根会话')

  // ① 工作空间：先解析，解析不到就建目录再登记。
  let workspace = await resolveWorkspaceEntity(ctx, workspacePath)
  if (workspace === undefined) {
    const mkdirError = await ensureDirectory(ctx, workspacePath, await deps.world.workdir(), await deps.world.platform())
    if (mkdirError !== '') return fail(mkdirError)
    workspace = await createWorkspace(ctx, workspacePath, state.workspaceTitle || workspacePath)
    if (workspace === undefined) return fail(`工作空间登记失败：${workspacePath}`)
    notes.push(`已把目录登记成工作空间：${workspacePath}`)
  }

  // ② 新建一个真正的顶层会话（不带 parentAgent = 不是子代理）。
  const sessionId = mintSessionId()
  const presetId = await resolvePresetId(ctx, options.presetHint ?? '')
  const model = currentModel(ctx)
  let created: { agent: LiveAgent }
  try {
    created = await agents.create({
      sessionId,
      meta: { cwd: workspacePath, ...(presetId === '' ? {} : { agentPreset: presetId }) },
      agentOptions: model,
      setup: async (agentCtx: Context, agent: unknown) => {
        const presets = ctx.get('agentPresets') as { mount?: (agentCtx: Context, id: string) => Promise<unknown> } | undefined
        if (presetId !== '' && typeof presets?.mount === 'function') await presets.mount(agentCtx, presetId)
        void agent
      },
    })
  } catch (error) {
    return fail(`创建审核根会话失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ③ 挂到工作空间 + 命名（rename 要求会话活着，此刻正是）。
  if (workspace !== undefined && typeof workspace.attachSession === 'function') {
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      // 挂不上只是侧栏分组不对，不影响审核能不能跑，所以只记一句。
      notes.push(`会话已建，但没能挂到工作空间：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const title = auditRootTitle(new Date())
  const renamed = renameSession(ctx, sessionId, title)
  if (!renamed) notes.push('根会话改名失败（不影响审核，只是标题不好认）')

  // ④ hello 预检：证明这个会话真的能被驱动，并且 CRWU 工具链路可用。
  const probeError = await preflight(ctx, created.agent, sessionId)
  if (probeError !== '') return fail(`审核根会话预检未通过：${probeError}`)

  // ⑤ 确定性门禁：必需 Tool 必须对该 Agent 可见。
  //
  // 这一步**不能**只写在预检提示词里：提示词是请求，看不到工具的子代理会自己去找别的手段
  // （裸命令 / `which` / 改 PATH）。缺任何一个就在这里失败，并列出缺失的工具名，
  // 把「跑不起来」拦在创建审核子代理之前。
  const missing = auditToolsVisible(ctx, created.agent as unknown as Agent)
  if (missing.length > 0) {
    return fail(`审核所需的 CRWU Tool 对该 Agent 不可见：${missing.join('、')}。请确认部署已装配 @deepseek-ai/dsh-tools（base bundle 的 tools 行）。`)
  }

  // 这一段才是「钩子」：先落到进程内状态，再落盘。
  state.auditRoot = { workspacePath, sessionId, title, assignedAt: new Date().toISOString() }
  // 落盘没成功不算失败（本次照样能用），但要说出来：下次进程重启会再建一个（分叉）。
  const persisted = await persistAuditRoot(ctx, await deps.world.home(), state)
  if (!persisted) notes.push('根会话没能写入磁盘：重启后会新建一个（旧的树保留）')
  return { ok: true, error: '', sessionId, created: true, notes }
}

/** 一次 hello 预检；返回空串表示通过。 */
export async function preflight(ctx: Context, agent: LiveAgent, sessionSeed: string, timeoutMs = 90_000): Promise<string> {
  if (typeof agent.followup !== 'function' || typeof agent.whenIdle !== 'function') {
    return '这个部署的 Agent 不支持 followup/whenIdle，无法确认会话可驱动'
  }
  try {
    agent.followup(probeMessage(sessionSeed))
  } catch (error) {
    return `发送预检消息失败：${error instanceof Error ? error.message : String(error)}`
  }
  const timer = ctx.get('timer') as { timeout?: (ms: number) => Promise<void> } | undefined
  const idle = agent.whenIdle().then(() => 'idle' as const, (error: unknown) => `失败：${error instanceof Error ? error.message : String(error)}`)
  if (timer === undefined || typeof timer.timeout !== 'function') {
    const outcome = await idle
    return outcome === 'idle' ? '' : outcome
  }
  const outcome = await Promise.race([idle, timer.timeout(timeoutMs).then(() => 'timeout' as const)])
  if (outcome === 'timeout') return `预检超时（${Math.round(timeoutMs / 1000)} 秒内没有跑完）`
  return outcome === 'idle' ? '' : outcome
}

interface WorkspaceEntity {
  id: string
  path: string
  attachSession?: (sessionId: string) => Promise<void>
}

async function resolveWorkspaceEntity(ctx: Context, path: string): Promise<WorkspaceEntity | undefined> {
  const registry = ctx.get('workspaceRegistry') as {
    list?: () => Array<{ id: string; path: string }>
    resolveByPath?: (path: string) => Promise<unknown> | unknown
    get?: (id: string) => unknown
  } | undefined
  if (registry === undefined) return undefined
  try {
    if (typeof registry.resolveByPath === 'function') {
      const found = await registry.resolveByPath(path)
      if (found !== null && typeof found === 'object') return found as WorkspaceEntity
      return undefined
    }
    const hit = (registry.list?.() ?? []).find((entry) => text(entry.path) === path)
    if (hit === undefined || typeof registry.get !== 'function') return undefined
    return registry.get(hit.id) as WorkspaceEntity
  } catch (error) {
    // 目录不存在时 realpath 会 reject —— 这正是「还没登记」的信号，交给调用方去建。
    void error
    return undefined
  }
}

async function createWorkspace(ctx: Context, path: string, title: string): Promise<WorkspaceEntity | undefined> {
  const registry = ctx.get('workspaceRegistry') as { create?: (path: string, title?: string) => Promise<WorkspaceEntity> } | undefined
  if (registry === undefined || typeof registry.create !== 'function') return undefined
  try {
    return await registry.create(path, title)
  } catch (error) {
    void error
    return undefined
  }
}

function renameSession(ctx: Context, sessionId: string, title: string): boolean {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const titles = ctx.get('sessionTitle') as { rename?: (session: unknown, title: string) => unknown } | undefined
  const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  if (session === undefined || typeof titles?.rename !== 'function') return false
  try {
    titles.rename(session, title)
    return true
  } catch (error) {
    void error
    return false
  }
}

/** 审核用什么 preset：优先跟「你正在用的那个会话」，取不到就用部署默认。 */
async function resolvePresetId(ctx: Context, hint: string): Promise<string> {
  const presets = ctx.get('agentPresets') as { resolve?: (id?: string) => Promise<{ id?: string }> } | undefined
  if (typeof presets?.resolve !== 'function') return text(hint)
  try {
    const resolved = await presets.resolve(hint === '' ? undefined : hint)
    return text(resolved?.id)
  } catch (error) {
    // 指定的 preset 不存在（比如那个会话用的是已被删掉的 preset）→ 退回默认。
    void error
    try {
      return text((await presets.resolve(undefined))?.id)
    } catch (inner) {
      void inner
      return ''
    }
  }
}

function currentModel(ctx: Context): Record<string, unknown> {
  const store = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined
  const selection = typeof store?.currentSelection === 'function' ? store.currentSelection() : undefined
  return selection === undefined ? {} : { provider: text(selection.provider), model: text(selection.model) }
}

/** Host 侧对线协议类型的别名：契约检查（shared/wire-contract.ts）用它做赋值核对。 */
export type AudRootHostType = AuditRootView

/** 根会话在界面上的样子（类型定义在线协议里，这里只负责投影）。 */
export function auditRootView(ctx: Context, state: WorkbenchState): AuditRootView {
  const workspacePath = state.workspacePath || state.caseRoot
  const usability = state.auditRoot.sessionId === ''
    ? { ok: false, reason: '尚未创建（发起审核时自动创建）' }
    : auditRootUsability(ctx, state, workspacePath)
  return {
    sessionId: state.auditRoot.sessionId,
    title: state.auditRoot.title,
    workspacePath: state.auditRoot.workspacePath,
    assignedAt: state.auditRoot.assignedAt,
    usable: usability.ok,
    reason: usability.reason,
  }
}
