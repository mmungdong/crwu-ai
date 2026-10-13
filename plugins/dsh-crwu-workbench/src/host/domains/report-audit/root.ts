import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { text } from '../../../shared/utils/value.ts'
import { shellDialect } from '../../core/platform/shell.ts'
import { agentRegistry } from './spawn.ts'
import { auditToolsVisible } from './preflight.ts'
import { applyAuditRootPolicy, inspectAuditRootPolicy, type AuditPolicyView } from './policy.ts'
import { samePathText } from './scope.ts'
import { persistAuditRoot } from '../../core/state/registry.ts'
import { resolveSelectedWorkspace, verifyReusableSession, workspaceSessionService } from '../../core/workspace-session/index.ts'
import type { AuditRootView } from '../../../shared/types.ts'
import type { WorkbenchState } from '../../core/state/types.ts'
import type { WorldFacts } from '../../core/platform/world.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'

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

/**
 * 预检指令：一次调用同时证明「模型能回」「shell 能用、cwd 正确」「CRWU Tool 链路与 policy pipeline 通」。
 *
 * **必须按平台生成**（2026-09-28）：旧文案写死了「用 bash 执行 `pwd`」，而 DSH 在 Windows 上挂的是
 * PowerShell（`@deepseek-ai/dsh-pwsh-local`，整串命令交给 `pwsh -Command`）。后果是宿主侧环境自检
 * 全绿、Agent 预检却直接失败，错误里还出现一个这台机器上根本不存在的 `bash` —— 让人往
 * 「装 Git Bash」的方向排查。这里给出的命令一律是**当前平台 shell 的真实写法**。
 */
export function auditRootProbe(platform: string): string {
  const cwd = shellDialect(platform) === 'powershell' ? '`Get-Location`' : '`pwd`'
  const shellName = shellDialect(platform) === 'powershell' ? 'PowerShell' : 'POSIX shell'
  return 'hello，请依次做两件事：① 用**当前平台的 shell 工具**执行 ' + cwd + ' 输出当前目录'
    + `（这个会话的 shell 是 ${shellName}，不要再去找别的 shell）；② 调用 \`crwu_audit_capabilities\`（无参数）。`
    + '然后回复当前目录，以及该工具返回的 `ok`、`platform` 与 `binPlatform`。'
}

export interface AuditRootDeps {
  ctx: Context
  state: WorkbenchState
  world: WorldFacts
  /** Broker（协议 18）：根会话落盘走 `workbench.state.write`。 */
  access: LocalAccessBroker
}

export interface AuditRootResult {
  ok: boolean
  error: string
  sessionId: string
  /** 这一次是复用了已有的根，还是新建的。 */
  created: boolean
  /** 已经做过的事（新建时用于界面提示/诊断）。 */
  notes: string[]
  /**
   * 审核根的沙箱 / 审批策略事实（协议 18 · 子项目 C）。
   *
   * 它**不是**"我们请求了什么"，而是回读 + 按 DSH 委派口径预测出来的"子会话会继承到什么"。
   * 界面（⑧ 审核根会话）与诊断都读它。
   */
  policy: AuditPolicyView
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
export function probeMessage(sessionSeed: string, platform: string): Record<string, unknown> {
  return {
    id: `msg-${sessionSeed}`,
    role: 'user',
    content: [{ type: 'text', text: auditRootProbe(platform) }],
    source: { kind: 'user' },
  }
}

interface LiveAgent {
  id: string
  session?: { header?: Record<string, unknown> }
  followup?: (message: unknown) => void
  whenIdle?: () => Promise<void>
}

/**
 * 审核会话的沙箱边界 = **已选工作区**（协议 32 起没有第二个来源）。
 *
 * 以前这里是 `workspacePath || caseRoot`：工作区没选时退到配置里的案例根。那条降级已经删除 ——
 * `caseRoot` 是**部署配置**里的一个目录，不是用户在【环境信息】里选的工作区。拿它当边界会让
 * "忘了选工作区"变成"审核照样跑，但产物写到部署默认目录"。
 */
export function auditBoundaryOf(state: WorkbenchState): string {
  return text(state.workspacePath)
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
 * 审核根会话的**沙箱边界 = 会话 cwd = 已选工作空间**（2026-09-30 口径，协议 24）。
 *
 * 为什么必须是工作空间而不是案例目录 —— DSH 的两条硬规则把它钉死了：
 *
 * 1. `SandboxPolicyService.resolve()`：*"**A session cwd is its workspace-write boundary**"* ——
 *    边界**就是**会话 cwd，没有第二个旋钮；
 * 2. `Workspace.attachSession()`：`if (cwd !== this.record.path) throw …` —— 会话要挂到工作空间下，
 *    它的 cwd 必须**逐字等于**工作空间路径。
 *
 * 两者合起来只有一种活法：**cwd = 工作空间**，于是边界也是工作空间。
 * 这正是 DSH 自己创建"工作空间下的新会话"的做法（`session-controller` 的 `create()`：
 * `cwd = workspace.path` → `ensureSession` → `attachSession`），也是本插件"与 DeepSeek 讨论"
 * 那条链路一直在用的做法（客户端 `sessions.create({ workspaceId })`）。
 * 之前我们自己用 `agents.create({ meta: { cwd: 案例目录 } })` 建根，cwd 与工作空间路径不等，
 * `attachSession` 必然抛错，于是审核根只能落在「未分组」——那就是 2026-09-30 用户报的 bug。
 *
 * ⚠️ **案例目录的门禁不靠这个边界**，靠的是 `requireAuditScope`：审核子会话发起的每一个案例内
 * Tool 都要求 `caseDir` 与本轮记录的 `casePath` **规范解析后精确相等**（工作空间根、兄弟案例、
 * 案例子目录一律拒绝）。也就是说：**会话边界回答"这个进程能写哪儿"，案例 scope 回答
 * "这次审核被允许碰哪个案例"** —— 后者才是跨案例的隔离判据，而且它不随 cwd 变化。
 */
export async function auditRootUsability(ctx: Context, state: WorkbenchState, casePath: string): Promise<RootUsability> {
  const sessionId = state.auditRoot.sessionId
  if (sessionId === '') return { ok: false, reason: '还没有审核根会话' }
  if (casePath === '') return { ok: false, reason: '缺少案例目录：无法确认审核根的边界' }
  // 用 `text()` 收窄：老状态文件、被手改过的文件都可能**没有**这个字段（`undefined`）。
  // 那种情况与空串同义（工作空间级旧根）—— 不许因为"不是空串"就走到比较那一步。
  const rootCase = text(state.auditRoot.casePath)
  if (rootCase === '') {
    return { ok: false, reason: '已有的根是「工作空间级」根（没有案例目录）：按过期处理，为本轮新建一个' }
  }
  if (!samePathText(rootCase, casePath)) {
    return { ok: false, reason: `根属于另一个案例目录（根在 ${rootCase}，本轮是 ${casePath}）` }
  }

  // 工作区本身必须先成立：旧根不能替用户绕过环境门禁。
  const resolved = await resolveSelectedWorkspace(ctx, state)
  if (!resolved.ok) return { ok: false, reason: resolved.error }

  // 工作区一致性 + Agent 存活 + cwd + 成员关系（协议 32 起统一走 core/workspace-session）。
  // 这四件事原先散在这里手写，其中「成员关系」**根本没查** —— 于是挂载丢了的根会被复用来跑审核。
  const placement = await verifyReusableSession(ctx, state, {
    workspaceId: text(state.auditRoot.workspaceId),
    workspacePath: text(state.auditRoot.workspacePath),
    sessionId,
  })
  if (!placement.ok) return { ok: false, reason: placement.reason }

  // **策略也是可用性的一部分**（协议 18 · C-02）：带着 `auto` / `danger-full-access`
  // permission preset 的会话、或者策略被别人改漂了的会话，一律不复用 ——
  // 「先复用再纠正」会让子代理继承到错的边界，而那正是这一层要防的事。
  const policy = inspectAuditRootPolicy(ctx, agentRegistry(ctx)?.get(sessionId as never), resolved.workspace.path)
  if (!policy.ok) return { ok: false, reason: `策略不符合要求：${policy.error}` }
  return { ok: true, reason: '' }
}

/**
 * 拿到一个可用的审核根会话：能用就用，不能用就新建（登记已有工作空间 → 建会话 →
 * 命名 → hello 预检 → 落钩子）。
 *
 * ⚠️ **本函数不创建任何目录**（2026-09-30 口径）：工作空间根目录必须由用户先选好、且**真实存在**；
 * 案例目录由调用方（`audit/ops.ts`）在**进入本函数之前**创建。这里连 `mkdir` 都不再拼 ——
 * 「工作空间不存在就建一个」正是这条口径要消灭的行为。
 */
export async function ensureAuditRoot(
  deps: AuditRootDeps,
  options: { presetHint?: string; casePath: string },
): Promise<AuditRootResult> {
  const { ctx, state } = deps
  const casePath = text(options.casePath)
  // `notes` 在 `fail` 之前声明：**失败也要把已经做过的事带回去** ——
  // 后面那些"已释放这条会话 / 策略已收敛"的观察，如果只挂在成功路径上就全丢了。
  const notes: string[] = []
  const fail = (error: string, policy?: AuditPolicyView): AuditRootResult => ({
    ok: false, error, sessionId: '', created: false, notes: [...notes],
    policy: policy ?? { ok: false, error, sandboxMode: '', workspaceRoot: '', approvalPolicy: '', permissionPreset: '' },
  })

  // ① 工作区：**唯一**来源是【环境信息】里选中的那个（协议 32）。
  // 这里以前用 `state.workspacePath || state.caseRoot` 并允许 mkdir 补建 —— 两条都删了：
  // 忘了选工作区时就该停下来，而不是退到部署配置的目录里继续跑。
  const resolved = await resolveSelectedWorkspace(ctx, state)
  if (!resolved.ok) return fail(resolved.error)
  const workspace = resolved.workspace
  if (casePath === '') return fail('缺少案例目录：审核根会话的边界就是本轮案例目录（不许用整个工作空间）。')

  // 平台事实只探一次：预检指令与"当前目录"的写法都要用它。
  const platform = await deps.world.platform()

  const usable = await auditRootUsability(ctx, state, casePath)
  if (usable.ok) {
    // 复用已有的根：策略事实同样要如实带回去（它是**检查过**的，不是"假定还行"）。
    const policy = inspectAuditRootPolicy(ctx, agentRegistry(ctx)?.get(state.auditRoot.sessionId as never), workspace.path)
    return { ok: true, error: '', sessionId: state.auditRoot.sessionId, created: false, notes: [], policy }
  }

  if (state.auditRoot.sessionId !== '') notes.push(`上一个根不可用：${usable.reason}（按约定新建一个，旧树保留）`)

  const presetId = await resolvePresetId(ctx, options.presetHint ?? '')
  const title = auditRootTitle(new Date())

  // ② 建一条**顶层**会话，落点由统一服务负责（`sessionController.create({ workspaceId })` →
  //    显式挂载 → 回读 cwd 与成员关系）。任何一步不成立都在这里失败，**不落钩子**。
  const createdSession = await workspaceSessionService(ctx, state).createSession({
    title,
    source: 'audit-root',
    presetHint: presetId,
  })
  if (!createdSession.ok) return fail(createdSession.error)
  const sessionId = createdSession.sessionId
  notes.push(...createdSession.notes)
  const agent = createdSession.agent as LiveAgent | undefined

  /**
   * 建完之后的任一步失败都**释放**这条刚建的会话。
   *
   * 为什么必须释放：不释放就会在左侧会话列表里留下一条"审核子代理根节点"的空对话，
   * 而它带着 workspace-write 边界却没有任何钩子记着它 —— 用户会以为审核已经跑过一轮。
   * 释放是 best-effort（Agent 可能已经没了），失败只记一句，不影响"这次创建失败"这个结论。
   */
  const release = (reason: string): void => {
    const live = agent ?? liveAgent(ctx, sessionId)
    const cancel = (live as { cancel?: (reason: unknown) => void } | undefined)?.cancel
    if (typeof cancel !== 'function') {
      notes.push(`创建失败后没能释放这条会话（${reason}）：请手动删除它`)
      return
    }
    try {
      cancel.call(live, { kind: 'parent' })
      notes.push(`创建失败后已释放这条会话（${reason}）`)
    } catch (error) {
      notes.push(`创建失败后释放会话出错（${reason}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ③ **策略收敛**（协议 18 · 子项目 C）：写 `workspace-write` + `never`，回读确认，
  // 并按 DSH 的委派捕获口径确认"子会话将要继承到什么"。**必须在 hello 预检之前** ——
  // 预检本身会驱动一次模型回合，而那一轮就该已经跑在正确的沙箱与审批之下。
  const policy = applyAuditRootPolicy(ctx, agent, workspace.path)
  if (!policy.ok) {
    release('沙箱/审批策略没有收敛')
    return fail(`审核根会话的沙箱/审批策略没有收敛：${policy.error}`, policy)
  }
  notes.push(`策略已收敛：沙箱 ${policy.sandboxMode} · 边界 ${policy.workspaceRoot} · 审批 ${policy.approvalPolicy}`)

  // ④ hello 预检：证明这个会话真的能被驱动，并且 CRWU 工具链路可用。
  const probeError = await preflight(ctx, agent as LiveAgent, sessionId, platform)
  if (probeError !== '') {
    release('预检未通过')
    return fail(`审核根会话预检未通过：${probeError}`)
  }

  // ⑤ 确定性门禁：必需 Tool 必须对该 Agent 可见。
  //
  // 这一步**不能**只写在预检提示词里：提示词是请求，看不到工具的子代理会自己去找别的手段
  // （裸命令 / `which` / 改 PATH）。缺任何一个就在这里失败，并列出缺失的工具名，
  // 把「跑不起来」拦在创建审核子代理之前。
  const missing = auditToolsVisible(ctx, agent as unknown as Agent)
  if (missing.length > 0) {
    release('必需的 CRWU Tool 不可见')
    return fail(`审核所需的 CRWU Tool 对该 Agent 不可见：${missing.join('、')}。请确认部署已装配 @deepseek-ai/dsh-tools（base bundle 的 tools 行）。`)
  }

  // 这一段才是「钩子」：先落到进程内状态，再落盘。
  state.auditRoot = {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    casePath,
    sessionId,
    title,
    assignedAt: new Date().toISOString(),
  }
  // 落盘没成功不算失败（本次照样能用），但要说出来：下次进程重启会再建一个（分叉）。
  const persisted = await persistAuditRoot({ ctx, home: await deps.world.home(), state, access: deps.access })
  if (!persisted) notes.push('根会话没能写入磁盘：重启后会新建一个（旧的树保留）')
  return { ok: true, error: '', sessionId, created: true, notes, policy }
}

/** 一次 hello 预检；返回空串表示通过。 */
export async function preflight(
  ctx: Context,
  agent: LiveAgent,
  sessionSeed: string,
  platform: string,
  timeoutMs = 90_000,
): Promise<string> {
  if (typeof agent.followup !== 'function' || typeof agent.whenIdle !== 'function') {
    return '这个部署的 Agent 不支持 followup/whenIdle，无法确认会话可驱动'
  }
  try {
    agent.followup(probeMessage(sessionSeed, platform))
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

/**
 * 审核用什么 preset：优先跟「你正在用的那个会话」，取不到就用部署默认。
 *
 * ⚠️ 这里**只解析 id**，不自己建会话：会话由 `core/workspace-session` 统一创建
 * （`sessionController.create({ workspaceId, agentPreset })`），preset 的挂载在那条路径里完成。
 * 以前这里还自己 `agents.create` + `agentPresets.mount`，两条路各挂一次是漂移的来源。
 */
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

/** Host 侧对线协议类型的别名：契约检查（shared/wire/report-audit.ts）用它做赋值核对。 */
export type AudRootHostType = AuditRootView

/**
 * 根会话在界面上的样子（类型定义在线协议里，这里只负责投影）。
 *
 * 协议 32 起它是 async：可用性判定要**回读**工作区成员关系与会话 cwd（那是两个异步服务），
 * 不能只按记录里的字符串下结论 —— 挂载丢了的根在面板上照样显示"可用"正是这一版要断掉的事。
 */
export async function auditRootView(ctx: Context, state: WorkbenchState): Promise<AuditRootView> {
  // 面板问的是"**这条已记录的根**还能不能用"：所以判据是它自己记录的案例目录
  //（不是当前选定的工作空间 —— 那是"下一次发起会用哪个根"的问题，由 `ensureAuditRoot` 回答）。
  const casePath = text(state.auditRoot.casePath)
  const usability = state.auditRoot.sessionId === ''
    ? { ok: false, reason: '尚未创建（发起审核时自动创建）' }
    : await auditRootUsability(ctx, state, casePath)
  // ⑧ 上要能看到「审核根跑在什么边界下」：这是设计文档验收 P-12 的可见性要求，
  // 也是员工/维护者判断"审核为什么写不进案例目录"的第一手事实。
  const policy = state.auditRoot.sessionId === ''
    ? undefined
    : inspectAuditRootPolicy(ctx, agentRegistry(ctx)?.get(state.auditRoot.sessionId as never), auditBoundaryOf(state))
  return {
    sessionId: state.auditRoot.sessionId,
    title: state.auditRoot.title,
    workspacePath: state.auditRoot.workspacePath,
    casePath: text(state.auditRoot.casePath),
    assignedAt: state.auditRoot.assignedAt,
    usable: usability.ok,
    reason: usability.reason,
    sandboxMode: policy?.sandboxMode ?? '',
    approvalPolicy: policy?.approvalPolicy ?? '',
  }
}
