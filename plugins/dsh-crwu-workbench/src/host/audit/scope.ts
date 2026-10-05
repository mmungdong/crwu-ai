import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { trimTrailingSeparators } from '../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { failure, type ToolFailure } from '../tools/outcome.ts'
import type { WorkbenchState } from '../state/types.ts'

/**
 * **审核 scope**：本轮审核的权威范围，由 Host 在创建记录时写死，落插件状态文件。
 *
 * ## 为什么需要它
 *
 * 2026-09-29 用户复查的 P1：案例内的 Tool 只校验到"`caseDir` 落在选定工作空间之下"
 *（`requireCaseDir` 的 `allowedRoot`）。而工作空间里通常有**很多**案例目录，
 * 于是编号 S1 的子会话可以：
 *
 * - 传 `caseDir = <工作空间>/S2`（另一个案例）→ `oss_publish` 把别的案例的交付件传到 OSS、
 *   `file_get` 往别的案例里写文件；
 * - 传 `caseDir = <工作空间>`（根本身）再读 `S2/xxx`——`requireInsideCase` 认的是
 *   "在 `caseDir` 之下"，所以工作空间根把**所有**案例都包含了进去；
 * - 传别的 `objectId` / `fileId`：氚云的记录与附件标识都由模型提交，Host 没有门禁。
 *
 * 根因是**信任域选错了一层**：安全边界不是"工作空间"，而是"本轮审核自己的案例目录"。
 * 所以判据从"包含于工作空间"改成"**与 Host 记录的 `casePath` 规范解析后精确相等**"，
 * 并要求 `seqNo` / `objectId` 与本轮记录一致。
 *
 * ## 三条不许退回去的口径
 *
 * 1. **权威值来自 Host 记录**（`state.audits[key]`，落盘、跨重启保留），不是模型提交的字符串；
 *    Tool 之后一律用 `scope.casePath`，不把模型给的 `caseDir` 当路径用。
 * 2. **精确相等，不判包含**：工作空间根、兄弟案例、案例目录的子目录，三者都必须拒绝。
 * 3. **找不到就 fail closed**：调用者没有 Agent 身份、不在进行中的审核里、记录已结束、
 *    或 scope 字段不完整（认领来的旧记录就是这种），一律拒绝 —— 不许"退回宽松判据"。
 */

/** 本轮审核的权威范围。字段全部来自 Host 记录。 */
export interface AuditScope {
  key: string
  childId: string
  seqNo: string
  objectId: string
  /** Host 自己算出的案例目录（`<工作空间>/<流水号>`）。 */
  casePath: string
  attemptId: string
  /** 可信输入快照里登记的附件 id；空数组 = 一个都不允许（不是"都允许"）。 */
  allowedAttachmentIds: readonly string[]
}

/**
 * 调用者身份：审核子会话的 `Agent.id` 就是它自己的 session id，也就是记录里的 `childId`。
 *
 * 拿不到 Agent（例如宿主后台直接调用）时返回空串 —— 由调用方 fail closed，
 * 而不是"当成合法调用者"。
 */
export function callerSessionId(exec: ToolRunContext): string {
  return text((exec.agent as { id?: unknown } | undefined)?.id)
}

/**
 * 调用者身份：自己的 session id + **父会话 id**（审核子会话的父就是审核根）。
 *
 * 父会话从子 Agent 的 session 头读（DSH 在委派时写 `meta.parentSession`）。
 * 读不到就是空串 —— 由门禁决定怎么处理，绝不猜。
 */
export function callerIdentity(exec: ToolRunContext): { childId: string; parentSessionId: string } {
  const agent = exec.agent as { id?: unknown; session?: { header?: Record<string, unknown> } } | undefined
  return {
    childId: text(agent?.id),
    parentSessionId: text(agent?.session?.header?.parentSession),
  }
}

/**
 * 纯函数：按 `childId` 找**进行中且 scope 完整**的那条记录。
 *
 * 找不到 / 已结束 / 被停止 / 字段不完整（`casePath`、`attemptId`、`seqNo` 有空串）→ `undefined`。
 * 最后一种对应"认领来的记录"：它没有本轮 scope，所以案例内操作必须拒绝，
 * 不许拿工作空间当兜底判据。
 */
export function auditScopeFor(state: WorkbenchState, childId: string): AuditScope | undefined {
  if (childId === '') return undefined
  const records = Object.values(state.audits ?? {})
  // 唯一判据：记录里的 `childId` **逐字等于**调用者身份。
  const record = records.find((item) => item !== undefined && item.childId === childId)
  // ② **待接管窗口**（`start()` 还没返回、子会话已经在跑）：按"父会话 = 审核根"认领。
  //    没有这一条，窗口内案例内 Tool 会随机 fail closed，而面板类 Tool 的身份拒绝会失效。
  // ⚠️ **绝不按父会话放行**（2026-09-29 第三轮复查的 P1）。
  //
  // 曾经在这里做过"窗口内按父会话认领"：`pending === true && childId === '' &&
  // parentSessionId === 调用者的父`。那是**放行**判据，而父会话 id 只能证明
  // "这个 child 是同一个 root 的某个孩子"（`listChildren` 也只回答归属/存活），
  // **证明不了它就是本次 `start()` 创建的那一个** —— 同一个 root 下的旧 sibling
  // 可以在窗口内冒领新审核的案例 scope。
  //
  // one-shot `start()` **没有**预留 child id 的参数，也就拿不到不可伪造的 launch token，
  // 所以窗口内唯一安全的选择是：**没有权威 childId 就没有 scope**，案例内 Tool fail closed
  //（子会话发起的第一次调用会拿到"会话正在建立"的 policy 失败，稍后重试即可）。
  if (record === undefined) return undefined
  {
    if (record.ended === true || record.stopped === true) return undefined
    // 退役（没确认停下就失败的那一轮）：**不放行**任何案例内操作。
    if (record.retired === true) return undefined
    if (record.casePath === '' || record.attemptId === '' || record.seqNo === '') return undefined
    return {
      key: record.key,
      // 窗口内 childId 还没回来：返回**记录里的值**（可能是空串），由调用方按 `scope.key` 用。
      childId: record.childId,
      seqNo: record.seqNo,
      objectId: record.objectId,
      casePath: record.casePath,
      attemptId: record.attemptId,
      allowedAttachmentIds: record.allowedAttachmentIds ?? [],
    }
  }
  return undefined
}

/**
 * 解析成 DSH 的**规范目标**，只取不透明身份 `targetKey`。
 *
 * ⚠️ `FsTarget.targetKey` 是 `Branded<'FsTargetKey'>` —— 后端内部的**不透明标识**，
 * 合同只允许**等值比较**（官方对 `displayPath` 的注释写明它 "for model/UI-facing output"）。
 * 2026-09-29 用户复查的 P2：这里曾经把 `targetKey` 当路径字符串做分隔符与大小写归一化，
 * 于是一个"恰好形似 Windows 路径、但其实区分大小写"的后端会返回两个不同的 key 而被判成同一个 ——
 * 门禁被错误放行。现在**只做 `===`**，解析与规范化全部交给后端的 `resolve`。
 */
async function canonicalTargetKey(ctx: Context, path: string): Promise<string> {
  const target = await resolveTarget(ctx, path)
  return text(target.targetKey)
}

/**
 * 我们自己产生的**路径字符串**是不是同一个（**不是**不透明 ID）。
 *
 * 用在"记录里的 `casePath` vs 会话头 / 策略回读里的 `cwd` / `workspaceRoot`"这种场合：
 * 两边都是我们自己写下去的路径字符串，所以按"去掉尾部分隔符后逐字相等"比较。
 * **不做大小写折叠**：那会把两个只差大小写的不同目录判成同一个（在区分大小写的卷上就是放行）。
 * "是不是同一个文件/目录"由 `resolve` + `targetKey` 等值判定，不由这里猜。
 */
export function samePathText(a: unknown, b: unknown): boolean {
  const norm = (value: unknown): string => trimTrailingSeparators(text(value))
  const left = norm(a)
  return left !== '' && left === norm(b)
}

/**
 * 这个 childId 是不是**任何一轮审核的子会话**（不要求 scope 可用）。
 *
 * 与 `auditScopeFor` 的区别很关键：那个回答"这一轮审核的权威范围是什么"（已结束 / scope 不完整
 * 就返回 `undefined`，好让案例内 Tool fail closed）；这一个回答"调用者是不是审核子会话"。
 *
 * 为什么两者都要有：像 `crwu_h3yun_record_get` 这种"面板能用、审核子会话不能用"的 Tool，
 * 判据必须是**身份**而不是"scope 是否可用" —— 否则一轮审核刚结束（`ended: true`）时，
 * 那个还活着的子会话就能以"没有可用 scope"为由绕过拒绝，去读**任意** `objectId` 的记录
 *（2026-09-29 自审发现的漏洞：拒绝条件写成了 `auditScopeFor(...) !== undefined`）。
 */
export function isAuditChild(state: WorkbenchState, childId: string, parentSessionId = ''): boolean {
  if (childId === '') return false
  if (parentSessionId !== '' && parentSessionId === state.auditRoot?.sessionId) return true
  for (const record of Object.values(state.audits ?? {})) {
    if (record === undefined) continue
    if (record.childId === childId || record.replacedChildId === childId) return true
    // Parent identity is only a denial criterion; it cannot grant an audit scope.
    if (parentSessionId !== '' && record.parentSessionId === parentSessionId) return true
  }
  return false
}

/**
 * 调用者的父会话 id：先读会话头，读不到就**问 `subagents` 服务**（Host 权威）。
 *
 * ⚠️ 它**只**服务**拒绝方向**的身份判断（`isAuditChild`：判定"这是不是审核子会话"从而拒绝
 * 面板类 Tool），**绝不**用于放行案例内 Tool —— 见 `auditScopeFor` 的注释。
 * 拒绝方向的误判最坏是"多拒绝一个同 root 的 sibling"，方向是安全的。
 * 会话头（`meta.parentSession`）是最直接的来源，但它是**委派时写进 session 元数据**的字段 ——
 * 一个插件不该把安全判据全押在"另一个组件的元数据一定在"上。
 * 退路问的是会话存储本身：**审核根的孩子里有没有这个调用者**。
 * 两条都拿不到才算"问不到"，由门禁 fail closed（不猜）。
 *
 * Query known audit roots so replaced children retain their managed identity.
 */
export async function callerParentSessionId(
  ctx: Context,
  state: WorkbenchState,
  exec: ToolRunContext,
): Promise<string> {
  const { childId, parentSessionId } = callerIdentity(exec)
  if (childId === '') return parentSessionId
  if (parentSessionId !== '') return parentSessionId
  const subagents = ctx.get('subagents') as {
    listChildren?: (parentSessionId: string) => Promise<unknown>
  } | undefined
  if (subagents === undefined || typeof subagents.listChildren !== 'function') return ''
  const candidates = new Set([
    text(state.auditRoot?.sessionId),
    ...Object.values(state.audits ?? {}).map((record) => text(record?.parentSessionId)),
  ].filter((id) => id !== ''))
  for (const parentId of candidates) {
    try {
      const children = await subagents.listChildren(parentId)
      if (!Array.isArray(children)) continue
      for (const child of children) {
        if (child === null || typeof child !== 'object') continue
        const record = child as Record<string, unknown>
        if (text(record.kind) !== 'child') continue
        // 会话存储驱动的列表：确认"这个调用者确实是审核根的孩子"。
        if (text(record.id) === childId) return parentId
      }
    } catch (error) {
      // Failed ancestry queries cannot establish an audit identity.
      void error
    }
  }
  return ''
}

export type AuditScopeCheck =
  | { ok: true; scope: AuditScope; casePath: string }
  | ({ ok: false } & ToolFailure)

/**
 * 案例内 Tool 的统一门禁。
 *
 * 传入的 `args` 是**模型提交**的参数：`seqNo` / `objectId` / `caseDir` 只要出现就必须与本轮
 * 记录一致；`caseDir` 还必须与 `scope.casePath` 规范解析后**精确相等**。
 * 通过时返回 Host 的 `casePath`，调用方**必须**用它，而不是自己再拼一次模型给的字符串。
 */
export async function requireAuditScope(
  ctx: Context,
  state: WorkbenchState,
  exec: ToolRunContext,
  args: { caseDir?: unknown; seqNo?: unknown; objectId?: unknown },
  options: { requireCaseDir?: boolean } = {},
): Promise<AuditScopeCheck> {
  const { childId } = callerIdentity(exec)
  if (childId === '') {
    return { ...failure('policy', '无法确认调用者身份：案例内的操作只允许由本次审核的子会话发起') }
  }
  const scope = auditScopeFor(state, childId)
  if (scope === undefined) {
    // 两种情形都在这里 fail closed，文案要能让子会话知道"稍后重试"，而不是以为配置坏了：
    // ① 窗口内（记录还是 pending、childId 还没写回）—— one-shot `start()` 没有预留 child id 的
    //    机制，拿不到不可伪造的 launch token，**没有权威 childId 就不给 scope**
    //（2026-09-29 第三轮复查的 P1：按父会话认领会允许同 root 的旧 sibling 冒领）；
    // ② 已结束 / 被停止 / 记录不完整。
    const pending = Object.values(state.audits ?? {}).some((record) => record !== undefined
      && record.pending === true && record.childId === '')
    return {
      ...failure('policy', pending
        ? '本次审核的子会话还在建立中（Host 尚未拿到权威 childId）：此刻案例内的操作一律拒绝，请稍后重试'
        : '调用者不在进行中的审核里（或本轮案例范围不完整 / 已结束）：案例内的操作一律拒绝'),
    }
  }

  const seqNo = text(args.seqNo).trim()
  if (seqNo !== '' && seqNo !== scope.seqNo) {
    return { ...failure('input', '流水号与本次审核不一致：拒绝操作') }
  }
  const objectId = text(args.objectId).trim()
  if (objectId !== '' && objectId !== scope.objectId) {
    return { ...failure('input', '记录标识与本次审核不一致：拒绝操作') }
  }

  const caseDir = text(args.caseDir).trim()
  if (caseDir === '') {
    return options.requireCaseDir === false
      ? { ok: true, scope, casePath: scope.casePath }
      : { ...failure('input', '缺少案例目录：案例内的操作必须带上本轮案例目录') }
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ...failure('infrastructure', 'Host 文件服务不可用') }
  let given: string
  let expected: string
  try {
    given = await canonicalTargetKey(ctx, caseDir)
    expected = await canonicalTargetKey(ctx, scope.casePath)
  } catch (error) {
    return {
      ...failure('infrastructure', `案例目录解析失败：${error instanceof Error ? error.message : String(error)}`),
    }
  }
  // 不透明 ID：只允许等值比较，不许归一化（见 `canonicalTargetKey` 的注释）。
  if (given === '' || given !== expected) {
    // 不判包含关系：工作空间根、兄弟案例、案例目录的子目录都在这一条上被拒。
    return {
      ...failure('policy', '案例目录必须是**本次审核自己的**案例目录（不许用工作空间根、兄弟案例或子目录）'),
    }
  }
  return { ok: true, scope, casePath: scope.casePath }
}
