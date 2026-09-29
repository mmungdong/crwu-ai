import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// 只为类型增强（`Context.sandboxPolicy` / `Context.approval`）与**两个写入口**：
// 它们就是 DSH 自己的会话策略写路径，不自己 append 事件（那样会绕过取值校验）。
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { text } from '../../shared/utils/value.ts'
import { samePathText } from './scope.ts'

/**
 * **审核会话的沙箱与审批策略**（协议 18 · 子项目 C）。
 *
 * ## 这一层要回答的问题
 *
 * 「审核跑起来之后，它到底能不能碰工作区之外的东西？」—— 设计文档 §3.1 的口径是：
 * 审核根与审核子会话**永远**是 `workspace-write`，审批策略**永远**是 `never`，
 * 子代理**不许**也**不需要**提权。本机凭据只由 Broker 在**已授权**的前提下按操作执行。
 *
 * ## 为什么不依赖部署默认值
 *
 * DSH 的沙箱模式是 `session 覆盖 ?? 部署默认`，而部署默认可以是 `danger-full-access`
 * （开发自测、CI 常见）。「审核跟着部署默认走」等于把审核的边界交给别人配 —— 所以这里
 * **显式写一次覆盖**，再把它**回读**确认，而不是假定"部署默认应该是安全的"。
 *
 * ## 为什么必须用 DSH 的两个 setter
 *
 * `setSandboxMode` / `setApprovalPolicy` 是「会话策略覆盖」的**唯一**写路径（各 append 一条
 * 事件）；手写 `session.append('sandbox/mode', …)` 会绕开它们的取值校验，而且一旦事件名或
 * 形状漂移就会**静默不生效**（策略没变，但代码以为变了）。
 */

/** 审核会话**唯一**允许的沙箱模式。 */
export const AUDIT_SANDBOX_MODE = 'workspace-write'
/** 审核会话**唯一**允许的审批策略：无人值守，任何 ask 都必须确定性拒绝。 */
export const AUDIT_APPROVAL_POLICY = 'never'
/** 这两种 permission preset 让子代理继承到「不受限」，审核根一旦是它们就不可用。 */
const UNSAFE_PERMISSION_PRESETS = ['auto', 'danger-full-access'] as const

export interface AuditPolicyView {
  ok: boolean
  /** 失败原因（人话，含"应该是什么、实际是什么"）。 */
  error: string
  sandboxMode: string
  workspaceRoot: string
  approvalPolicy: string
  permissionPreset: string
}

/**
 * 子会话**将要继承到**的策略事实。
 *
 * 这不是我们自己发明的判据：它逐字复刻 DSH 在委派边界上的捕获口径
 * （`@deepseek-ai/dsh-subagent` 的 `captureDelegatedPolicyOverrides`）——
 * 每次 `subagents.start` 都调它，捕获到的三项就是子会话日志里被 seed 进去的值。
 * 所以"审核根设对了没有"这件事可以**在创建子代理之前**确定性回答，不必等子会话跑起来再看。
 *
 * 三条口径（对照上游实现）：
 * - `sandboxMode`：父会话的**显式**覆盖（不含部署默认）；
 * - `approvalPolicy`：只要审批能力被装配，子会话一律被钉成 `'never'`；
 * - `permissionPreset`：父会话在 Auto / Full access 下**会**被继承 —— 这一条最危险，
 *   所以它是审核根不可用的判据之一。
 *
 * 与上游的一致性由 `tests/unit/host-audit-policy.test.mjs` 里对真
 * `captureDelegatedPolicyOverrides` 的对照断言钉住（宿主产物不依赖 dsh-subagent）。
 */
export function delegatedPolicyFacts(ctx: Context, session: Session): {
  sandboxMode: string
  approvalPolicy: string
  permissionPreset: string
} {
  const presets = ctx.get('permissionPresets') as
    { current?: (session: Session) => unknown } | undefined
  const preset = typeof presets?.current === 'function' ? presets.current(session) : undefined
  return {
    sandboxMode: text(ctx.get('sandboxPolicy')?.overrideOf(session)),
    approvalPolicy: ctx.get('approval') === undefined ? '' : AUDIT_APPROVAL_POLICY,
    permissionPreset: (UNSAFE_PERMISSION_PRESETS as readonly unknown[]).includes(preset) ? text(preset) : '',
  }
}

/** 会话策略读回来的样子（只取我们判定的那两项）。 */
function resolvedPolicy(ctx: Context, session: Session): { mode: string; workspaceRoot: string; available: boolean } {
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) return { mode: '', workspaceRoot: '', available: false }
  try {
    const resolved = service.resolve({ session })
    return { mode: text(resolved?.mode), workspaceRoot: text(resolved?.workspaceRoot), available: true }
  } catch (error) {
    void error
    return { mode: '', workspaceRoot: '', available: false }
  }
}

/**
 * 路径字符串比较（去掉尾部分隔符后逐字相等）。
 *
 * 两边都是**我们自己写下去的路径字符串**（记录 `casePath`、`meta.cwd`、策略服务回读的
 * `workspaceRoot`），不是 `FsTarget.targetKey` 那种不透明 ID —— 所以按路径语义比；
 * 但**不折叠大小写**（折叠会在区分大小写的卷上把两个目录判成同一个）。
 */
function samePath(a: string, b: string): boolean {
  return samePathText(a, b)
}

/**
 * 只读检查：这个会话当前的策略是不是审核要求的样子。**不写任何东西。**
 *
 * 用在「复用一个已有的审核根」时：策略漂移（有人手动切过、或上一版代码没设）必须被拦下，
 * 而不是带着错的边界继续跑。
 */
export function inspectAuditRootPolicy(ctx: Context, agent: unknown, casePath: string): AuditPolicyView {
  const session = (agent as { session?: Session } | undefined)?.session
  const fail = (error: string, patch: Partial<AuditPolicyView> = {}): AuditPolicyView => ({
    ok: false, error,
    sandboxMode: '', workspaceRoot: '', approvalPolicy: '', permissionPreset: '',
    ...patch,
  })
  if (session === undefined) return fail('审核根会话没有可用的 session（拿不到策略事实）')
  if (casePath === '') return fail('缺少案例目录：无法确认沙箱边界')

  const facts = delegatedPolicyFacts(ctx, session)
  const resolved = resolvedPolicy(ctx, session)
  const base = {
    sandboxMode: resolved.mode,
    workspaceRoot: resolved.workspaceRoot,
    approvalPolicy: facts.approvalPolicy,
    permissionPreset: facts.permissionPreset,
  }

  // ① 不受限的 permission preset：**不可修复**（那是会话的身份，不是一次覆盖），只能拒绝。
  if (facts.permissionPreset !== '') {
    return fail(`审核根会话带着不受限的 permission preset（${facts.permissionPreset}）：子代理会继承它，`
      + '审核不允许在这种会话下运行。请新建一个普通会话后重试。', base)
  }
  // ② 提权被降级 / 覆盖没生效：请求是 workspace-write，解析回来却是别的模式。
  if (!resolved.available) {
    return fail('沙箱策略服务不可用：无法确认审核的沙箱边界（fail closed）', base)
  }
  if (resolved.mode !== AUDIT_SANDBOX_MODE) {
    return fail(`审核根会话的沙箱模式是 ${resolved.mode || '（空）'}，要求 ${AUDIT_SANDBOX_MODE}`, base)
  }
  // ③ 边界必须是**本轮的案例目录**（不是工作空间）：工作空间级边界会让通用 shell / fs
  //    能改同一工作空间里的**其他案例**。判据与 Tool 的 `requireAuditScope` 同一条：
  //    精确相等（Windows 上大小写不敏感）。
  if (!samePath(resolved.workspaceRoot, casePath)) {
    return fail(`审核根会话的沙箱边界是 ${resolved.workspaceRoot || '（空）'}，不是本轮的案例目录 ${casePath}`, base)
  }
  // ③.5 会话自己的 cwd 也必须是案例目录：子会话继承的是**父会话的 cwd**，
  //     边界对了而 cwd 还是工作空间，通用 fs 的默认落点仍然指向别处（两件事都要对）。
  //
  //     cwd 是我们在 `agents.create({ meta: { cwd: casePath } })` 里给的，这里是**回读核对**；
  //     读不到（某些部署形态的 Session 头不带 cwd）时不假装核对过 —— 边界回读（第 ③ 条）才是硬门禁，
  //     这一条在能读到的时候必须相符。
  const cwd = text((session as unknown as { header?: Record<string, unknown> }).header?.cwd)
  if (cwd !== '' && !samePath(cwd, casePath)) {
    return fail(`审核根会话的 cwd 是 ${cwd}，不是本轮的案例目录 ${casePath}`, base)
  }
  // ④ 审批策略：无人值守审核必须在 `never` 之下运行 —— 申请不到审批，也不能把员工晾在一个
  //    永远不会有人回答的弹窗上。审批能力没装配时同样算不可用（那意味着策略不由我们决定）。
  const approvalOverride = ctx.get('approval')?.overrideOf(session)
  if (approvalOverride !== AUDIT_APPROVAL_POLICY) {
    return fail(`审核根会话的审批策略是 ${text(approvalOverride) || '未设置'}，要求 ${AUDIT_APPROVAL_POLICY}`
      + '（无人值守审核没有可用的审批通道）', base)
  }
  // ⑤ 子会话会继承到的沙箱覆盖必须正是我们设的这一条（不含部署默认）。
  if (facts.sandboxMode !== AUDIT_SANDBOX_MODE) {
    return fail(`审核根会话没有显式的 ${AUDIT_SANDBOX_MODE} 覆盖（子代理会继承到部署默认）`, base)
  }
  return { ok: true, error: '', ...base }
}

/**
 * 写入并回读审核根的策略。**在 `agents.create` 之后、hello 预检之前调用。**
 *
 * 顺序是硬要求：先写（两条覆盖）→ 再回读（模式 / 边界 / 审批）→ 最后按 DSH 的委派口径
 * 确认「子会话将要继承到什么」。任何一步不对就返回结构化失败，**不创建子代理**。
 */
export function applyAuditRootPolicy(ctx: Context, agent: unknown, casePath: string): AuditPolicyView {
  const session = (agent as { session?: Session } | undefined)?.session
  if (session === undefined) {
    return {
      ok: false, error: '审核根会话没有可用的 session，无法写入沙箱/审批策略',
      sandboxMode: '', workspaceRoot: '', approvalPolicy: '', permissionPreset: '',
    }
  }
  if (casePath === '') {
    return {
      ok: false, error: '缺少案例目录：没有可用的沙箱边界，拒绝创建审核根',
      sandboxMode: '', workspaceRoot: '', approvalPolicy: '', permissionPreset: '',
    }
  }
  try {
    setSandboxMode(session, AUDIT_SANDBOX_MODE)
    setApprovalPolicy(session, AUDIT_APPROVAL_POLICY)
  } catch (error) {
    return {
      ok: false,
      error: `写入审核根的沙箱/审批策略失败：${error instanceof Error ? error.message : String(error)}`,
      sandboxMode: '', workspaceRoot: '', approvalPolicy: '', permissionPreset: '',
    }
  }
  return inspectAuditRootPolicy(ctx, agent, casePath)
}
