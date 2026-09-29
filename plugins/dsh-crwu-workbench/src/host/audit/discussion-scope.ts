import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { failure, type ToolFailure } from '../tools/outcome.ts'
import type { WorkbenchState } from '../state/types.ts'
import { auditScopeFor, callerIdentity, requireAuditScope, type AuditScope } from './scope.ts'

/**
 * **讨论会话的受限材料范围**（协议 23）。
 *
 * ## 为什么需要它
 *
 * `crwu_h3yun_file_get` 原先只认**审核子会话**的 scope（`requireAuditScope`）。而报告讨论是
 * **另一条链路**：面板在工作空间下建一条**普通顶层会话**，靠会话名 `报告讨论 · <流水号>`
 * 找回；它没有、也不该有审核记录。于是讨论会话里调 `file_get` 一律拿到
 * 「调用者不在进行中的审核里」—— 材料一件也取不回来（用户报的第三条故障）。
 *
 * 修法不是"让讨论会话复用审核 scope"（那是扩大边界：审核 scope 绑着一条正在跑的子会话），
 * 而是给它一份**自己的、更窄的**范围：Host 在登记时**重新从氚云取一次附件清单**，
 * 只把那一批 `fileId` 写进白名单。
 *
 * ## 五条不许退回去的口径
 *
 * 1. **只活在 Host 内存里**：不落盘、不进报告、不进模型上下文。插件重启即失效 ——
 *    重新点一次「与 DeepSeek 讨论报告」就会重新登记。
 * 2. **绑定具体会话 id**：范围属于 `sessionId`，不是"某个工作空间"或"某条报告"。
 *    别的会话（包括同一个工作空间里的普通对话）拿不到它。
 * 3. **案例目录由 Host 算**：`<已选工作空间>/<流水号>`（`caseDirOf`），客户端提交不了路径。
 * 4. **附件白名单来自 Host 自己取的那一次数**：讨论会话不能自己指定 `objectId` / `fileId`，
 *    也不能靠这条范围去查记录（`record_get` / `files_list` 对它一律拒绝）。
 * 5. **有 TTL**：过期即失效，`get()` 顺手清掉 —— 一个长期不用的会话不该永久握着材料权限。
 */

/**
 * 范围的存活时间（毫秒）。
 *
 * 12 小时：讨论是"人跟 AI 聊一会儿"的形态，一次会话通常在这个窗口内；
 * 而它同时**不落盘**，插件重启就没了 —— 所以这个值只需要长到不让正常讨论中途失效。
 */
export const DISCUSSION_SCOPE_TTL_MS = 12 * 60 * 60 * 1000

/** 同时保留的范围条数上限（防止长期运行里无界增长；超出时丢最久没用的）。 */
export const DISCUSSION_SCOPE_LIMIT = 32

export interface DiscussionScope {
  sessionId: string
  seqNo: string
  objectId: string
  /** Host 算出的案例目录（`<已选工作空间>/<流水号>`）。 */
  caseDir: string
  /**
   * 允许下载的 `fileId` 白名单；**空数组 = 一个都不允许**（不是"都允许"）。
   *
   * 与审核 scope 的 `allowedAttachmentIds` **同名同义**：调用方（Tool）不必分支。
   */
  allowedAttachmentIds: readonly string[]
  createdAt: number
  lastUsedAt: number
  expiresAt: number
}

export interface DiscussionScopeRegistry {
  /** 登记 / 覆盖一条范围（同一条会话重复登记 = 刷新白名单与 TTL）。 */
  register(input: {
    sessionId: string
    seqNo: string
    objectId: string
    caseDir: string
    allowedAttachmentIds: readonly string[]
  }): DiscussionScope
  /** 取一条**未过期**的范围；顺带把 `lastUsedAt` 推到 `now`。过期 / 不存在返回 `undefined`。 */
  use(sessionId: string): DiscussionScope | undefined
  /** 只读（不推 `lastUsedAt`）：给拒绝方向的判据用。 */
  peek(sessionId: string): DiscussionScope | undefined
  drop(sessionId: string): void
  /** 当前有效的范围（诊断与测试用）。 */
  list(): DiscussionScope[]
  clear(): void
  size(): number
}

export interface DiscussionScopeRegistryOptions {
  /** 时钟（测试注入；缺省 `Date.now`）。 */
  now?: () => number
  ttlMs?: number
  limit?: number
}

export function createDiscussionScopeRegistry(options: DiscussionScopeRegistryOptions = {}): DiscussionScopeRegistry {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? DISCUSSION_SCOPE_TTL_MS
  const limit = options.limit ?? DISCUSSION_SCOPE_LIMIT
  const scopes = new Map<string, DiscussionScope>()

  /** 过期的一律先清掉：判据只有 `expiresAt` 与当前时刻。 */
  const sweep = (): void => {
    const at = now()
    for (const [id, scope] of scopes) {
      if (scope.expiresAt <= at) scopes.delete(id)
    }
  }
  /** 超出上限时丢**最久没用过**的（不是最早建的：人可能一直在用一条老会话）。 */
  const trim = (): void => {
    while (scopes.size > limit) {
      let oldestId = ''
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, scope] of scopes) {
        if (scope.lastUsedAt < oldestAt) {
          oldestAt = scope.lastUsedAt
          oldestId = id
        }
      }
      if (oldestId === '') return
      scopes.delete(oldestId)
    }
  }

  return {
    register(input) {
      const at = now()
      const scope: DiscussionScope = {
        sessionId: text(input.sessionId),
        seqNo: text(input.seqNo),
        objectId: text(input.objectId),
        caseDir: text(input.caseDir),
        allowedAttachmentIds: [...input.allowedAttachmentIds].map((id) => text(id)).filter((id) => id !== ''),
        createdAt: at,
        lastUsedAt: at,
        expiresAt: at + ttlMs,
      }
      scopes.set(scope.sessionId, scope)
      trim()
      return scope
    },
    use(sessionId) {
      sweep()
      const id = text(sessionId)
      if (id === '') return undefined
      const scope = scopes.get(id)
      if (scope === undefined) return undefined
      const touched: DiscussionScope = { ...scope, lastUsedAt: now() }
      scopes.set(id, touched)
      return touched
    },
    peek(sessionId) {
      sweep()
      return scopes.get(text(sessionId))
    },
    drop(sessionId) {
      scopes.delete(text(sessionId))
    },
    list() {
      sweep()
      return [...scopes.values()]
    },
    clear() {
      scopes.clear()
    },
    size() {
      sweep()
      return scopes.size
    },
  }
}

/**
 * 本次调用的**材料范围**：审核子会话的 scope 或讨论会话的 scope。
 *
 * 两个来源都存在时**以审核 scope 为准**：审核子会话的身份是记录里的 `childId`，
 * 它的边界更窄（绑着一条正在跑的审核），而讨论范围只是"这个会话可以取这批附件"。
 */
export type MaterialScope =
  | { kind: 'audit'; scope: AuditScope }
  | { kind: 'discussion'; scope: DiscussionScope }

export type MaterialScopeCheck = { ok: true; material: MaterialScope } | ({ ok: false } & ToolFailure)

/**
 * 案例内 Tool 的**统一门禁**：认证身份 → 解析范围 → 校验模型提交的标识。
 *
 * 与 `requireAuditScope` 的关系：后者是"审核子会话"这一支的实现，这里在它之前再加一支
 * "已登记的讨论会话"。**讨论会话绝不复用审核 scope**（见文件头第 2 条）。
 */
export async function requireMaterialScope(
  ctx: Context,
  state: WorkbenchState,
  scopes: DiscussionScopeRegistry,
  exec: ToolRunContext,
  args: { caseDir?: unknown; seqNo?: unknown; objectId?: unknown },
  options: { requireCaseDir?: boolean } = {},
): Promise<MaterialScopeCheck> {
  const { childId } = callerIdentity(exec)
  if (childId === '') {
    return { ...failure('policy', '无法确认调用者身份：案例内的操作只允许由本次审核的子会话或已登记的报告讨论会话发起') }
  }

  // ① 审核子会话：走原来那条路（精确相等的案例目录 + seqNo/objectId 一致）。
  if (auditScopeFor(state, childId) !== undefined) {
    const checked = await requireAuditScope(ctx, state, exec, args, options)
    if (!checked.ok) return checked
    return { ok: true, material: { kind: 'audit', scope: checked.scope } }
  }

  // ② 已登记的讨论会话：案例目录与白名单**全部来自 Host 记录**。
  const scope = scopes.use(childId)
  if (scope === undefined) {
    return {
      ...failure('policy',
        '调用者既不是进行中的审核子会话，也不是已登记的报告讨论会话：'
        + '案例内的操作一律拒绝（报告讨论请在工作台点「与 DeepSeek 讨论报告」重新登记材料范围）'),
    }
  }
  const seqNo = text(args.seqNo).trim()
  if (seqNo !== '' && seqNo !== scope.seqNo) {
    return { ...failure('input', '流水号与本次登记的材料范围不一致：拒绝操作') }
  }
  const objectId = text(args.objectId).trim()
  if (objectId !== '' && objectId !== scope.objectId) {
    return { ...failure('input', '记录标识与本次登记的材料范围不一致：拒绝操作') }
  }

  const caseDir = text(args.caseDir).trim()
  if (caseDir === '') {
    if (options.requireCaseDir === false) return { ok: true, material: { kind: 'discussion', scope } }
    return { ...failure('input', '缺少案例目录：案例内的操作必须带上本轮案例目录') }
  }
  // 与审核 scope 同一条判据：**规范解析后精确相等**（不判包含 —— 工作空间根、兄弟案例都不行）。
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ...failure('infrastructure', 'Host 文件服务不可用') }
  try {
    const given = await resolveTarget(ctx, caseDir)
    const expected = await resolveTarget(ctx, scope.caseDir)
    if (text(given.targetKey) === '' || given.targetKey !== expected.targetKey) {
      return { ...failure('policy', '案例目录必须是本次登记的那一个（不许用工作空间根、兄弟案例或子目录）') }
    }
  } catch (error) {
    return {
      ...failure('infrastructure', `案例目录解析失败：${error instanceof Error ? error.message : String(error)}`),
    }
  }
  return { ok: true, material: { kind: 'discussion', scope } }
}

/** 这次调用是不是**已登记**的报告讨论会话（给它开材料权限的那一条身份判据）。 */
export function isRegisteredDiscussion(scopes: DiscussionScopeRegistry, sessionId: string): boolean {
  return scopes.peek(sessionId) !== undefined
}
