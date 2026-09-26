import { discussionTitle, findDiscussions, nextOrdinal } from './assistant-context.ts'
import { auditAnalysisTitle, findAuditAnalyses, nextAuditOrdinal } from './audit-analysis.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 讨论会话的**客户端接线**（薄薄一层，把 DSH 的会话服务翻译成面板要的两件事：
 * 「拿到这份报告的讨论会话」与「往里发一句话」）。
 *
 * 三条口径（都是被 DSH 的契约逼出来的，改之前先读）：
 *
 * 1. **讨论会话是真实会话**（用户口径：「这个都是在环境中选中的工作空间下的对话…由左侧的
 *    会话列表统一管理」）。所以在环境里选中的工作空间下建一条顶层会话，它会出现在左侧会话
 *    列表里；我们不自己维护对话列表。
 * 2. **靠会话名复用**：`报告讨论 · <流水号>`。名称就是映射本身 —— 不需要给宿主加一个
 *    「报告 ↔ 会话」的状态操作，也不怕前端刷新丢映射（`sessions.create` 不接受标题，
 *    所以建完立刻 `rename`；找不到就新建一条）。
 * 3. **跳到会话由调用方的 `onOpenDiscussion` 负责**（面板接到 `uiWorkspace.openSession`）。
 *    这里**不**自己跳，也**不**假设 `sessions` 上有 `open()` —— 它没有（详见 DiscussionPort）。
 *    另：会话的事件窗口只在**当前会话**上是打开的（DSH 的 stage 语义），
 *    不把它设为当前会话，`binding(id).eventSource` 就一直是空的、面板里看不到流式输出。
 *    `open()` **只切会话选中**，不动主面板 —— 我们的面板仍然留在主区（这正是"数据在左、
 *    讨论在右"能成立的原因）。
 *
 * 这里全部是「服务可能缺席 / 旧宿主没有这个方法」的降级路径：拿不到就返回错误文案，
 * 面板上如实说，而不是抛出去把整页打崩。
 */

/** 会话列表里的一行（只取我们要的两个字段）。 */
export interface SessionSummaryLike {
  id: string
  displayTitle?: string
  title?: string
  /** 这条会话正在跑一轮（面板据此显示「AI 正在处理这份报告…」）。 */
  running?: boolean
}

export interface DiscussionSessionFace {
  prompt?: (content: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') => Promise<unknown>
  rename?: (title: string) => Promise<unknown>
}

export interface DiscussionBinding {
  session?: DiscussionSessionFace
  eventSource?: { getSnapshot: () => { entries?: readonly unknown[] } }
}

/** 会话列表快照（`sessions.list` 的 `getSnapshot()` 形状，只取我们用到的三个字段）。 */
export interface SessionListSnapshot {
  ids: string[]
  byId: Record<string, SessionSummaryLike>
  current?: string
}

export interface SessionListStore {
  getSnapshot: () => SessionListSnapshot
  subscribe?: (listener: () => void) => (() => void) | void
}

/** `sessions.using()` 回调里拿到的引用（只取我们用的 `binding`）。 */
export interface SessionReferenceLike {
  binding?: DiscussionBinding
}

/**
 * 讨论面板要的**会话服务四项能力**。
 *
 * **这里只放客户端 `sessions` 服务上真的存在的方法**（`ClientSessions`：`create` / `using` /
 * `binding` / `list`）。早先这里多了一个 `open`，而服务上根本没有它 —— 可选链
 * （`sessions?.open?.(id)`）把它变成静默 no-op，用户看到的就是「点讨论/复核跳不到对应会话」。
 *
 * 「跳到某条会话」是**调用方**的事：面板把 `onOpenDiscussion` 接到 `uiWorkspace.openSession(id)`
 * （见 `workbench/WorkbenchPanel.tsx`）。这样职责单一，也不会再凭空发明服务上不存在的方法。
 */
export interface DiscussionPort {
  create?: (input?: { workspaceId?: string; cwd?: string }) => Promise<string>
  /**
   * 借用会话 face（`rename` / `prompt`）的**正确入口**：
   * `sessions.using(id, { source }, (reference) => reference.binding.session.… )`。
   *
   * 它内部 = `retain` → 等 `ready` → 跑回调 → `release`，所以**对刚 `create()` 出来的会话也成立**。
   * 只靠下面的 `binding(id)` 不行：客户端实现是 `this.scopes.get(id)?.binding`，只有已被 retain 过的
   * 会话才有值 —— 刚建出来的那条拿到 `undefined`，rename 被静默跳过（会话没名字 → 下次找不到、
   * 只能再建一条），kickoff prompt 也根本发不出去（同一次故障的另一半）。
   */
  using?: (
    id: string,
    options: { source: string },
    operation: (reference: SessionReferenceLike) => Promise<unknown> | unknown,
  ) => Promise<unknown>
  /** 退路：宿主没有 `using`（更早的 DSH / 简化宿主）时，只能借已被 retain 的 binding。 */
  binding?: (id: string) => DiscussionBinding | undefined
  /** 会话列表快照商店：面板靠它认出「这份报告的讨论会话」（不靠自建映射表）。 */
  list?: SessionListStore
}

/**
 * 会话的**业务来源**。
 *
 * `report_discussion` = 报告列表那枚小鲸鱼（讨论原报告）；
 * `audit_analysis` = AI 审核列表那枚小鲸鱼（分析 AI 审核结果）。
 *
 * 两者**共用同一套 DSH 会话**（`Report → Conversations`，1:N），只是会话名前缀不同 ——
 * 这是本仓既有的"名字即映射"机制（`sessions.create` 不接受 metadata）。不去改会话数据库，
 * 也就不会影响左侧会话列表的统一管理。
 */
export type DiscussionKind = 'report_discussion' | 'audit_analysis'

const TITLE_OF: Record<DiscussionKind, (seqNo: string, ordinal?: number) => string> = {
  report_discussion: discussionTitle,
  audit_analysis: auditAnalysisTitle,
}

const FIND_OF: Record<DiscussionKind, <T extends { id: string; displayTitle?: string; title?: string }>(
  sessions: readonly T[],
  seqNo: string,
) => T[]> = {
  report_discussion: findDiscussions,
  audit_analysis: findAuditAnalyses,
}

const ORDINAL_OF: Record<DiscussionKind, <T extends { id: string; displayTitle?: string; title?: string }>(
  sessions: readonly T[],
  seqNo: string,
) => number> = {
  report_discussion: nextOrdinal,
  audit_analysis: nextAuditOrdinal,
}

/** 这份报告在某一来源下的全部会话（报告讨论 / 审核分析各自独立）。 */
export function sessionsOfKind<T extends { id: string; displayTitle?: string; title?: string }>(
  kind: DiscussionKind,
  sessions: readonly T[],
  seqNo: string,
): T[] {
  return FIND_OF[kind](sessions, seqNo)
}

export interface EnsureDiscussionInput {
  port: DiscussionPort | undefined
  /** 会话列表快照（来自标准 hook `useSessions`）。 */
  sessions: readonly SessionSummaryLike[]
  seqNo: string
  workspaceId: string
  workspacePath: string
  /** 真 = 不管有没有旧的都新建一条（气泡里选「新建对话」时走这条）。 */
  forceNew?: boolean
  /** 业务来源（默认报告讨论）；决定会话名前缀与"找回哪一类会话"。 */
  kind?: DiscussionKind
}

export type EnsureDiscussionResult =
  | { ok: true; id: string; created: boolean; renameError?: string }
  | { ok: false; error: string }

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

type FaceMethod = keyof DiscussionSessionFace

/** 这个 face 上真的能用 `method` 吗（顺带把可选方法收窄成必选）。 */
function usableFace<M extends FaceMethod>(
  face: DiscussionSessionFace | undefined,
  method: M,
): face is DiscussionSessionFace & Required<Pick<DiscussionSessionFace, M>> {
  return face !== undefined && typeof face[method] === 'function'
}

interface FaceCall {
  ok: boolean
  /** 服务/face 根本没有这个方法（旧宿主），调用方按「不支持」措辞报告。 */
  missing: boolean
  error: string
}

/**
 * 借一条会话的 face 执行一次操作。
 *
 * **优先 `using()`**：它会 retain 出 binding，所以对「刚 create 出来、还没被任何视图 retain」的
 * 会话也成立；`binding(id)` 只作为旧宿主的退路（对未 retain 的会话会返回 undefined —— 那正是
 * 2026-09-25 那次「建了会话但没名字、kickoff 也没发出去」的根因）。
 */
async function callFace<M extends FaceMethod>(
  port: DiscussionPort | undefined,
  id: string,
  source: string,
  method: M,
  run: (face: DiscussionSessionFace & Required<Pick<DiscussionSessionFace, M>>) => Promise<unknown>,
): Promise<FaceCall> {
  if (typeof port?.using === 'function') {
    const using = port.using
    let ran = false
    let threw = ''
    try {
      await using(id, { source }, async (reference) => {
        const face = reference?.binding?.session
        if (!usableFace(face, method)) return
        await run(face)
        ran = true
      })
    } catch (cause: unknown) {
      threw = describe(cause)
    }
    if (ran) return { ok: true, missing: false, error: '' }
    // 抛了错就说错；没抛错却没跑成 = 这个 face 上没这个方法。
    return threw !== ''
      ? { ok: false, missing: false, error: threw }
      : { ok: false, missing: true, error: '' }
  }
  const face = port?.binding?.(id)?.session
  if (!usableFace(face, method)) return { ok: false, missing: true, error: '' }
  try {
    await run(face)
    return { ok: true, missing: false, error: '' }
  } catch (cause: unknown) {
    return { ok: false, missing: false, error: describe(cause) }
  }
}

/**
 * 拿到这份报告的讨论会话：有就复用，没有就建一条（按流水号命名）。**不负责跳转** ——
 * 调用方拿到 `id` 后自己调 `onOpenDiscussion`。
 *
 * 建会话的落点优先级：`workspaceId` → 退化用 `cwd: workspacePath` → 都没有就报错。
 * 没有落点时会话会建在 DSH 默认目录下，那不是用户说的"环境里选中的工作空间"。
 */
export async function ensureDiscussion(input: EnsureDiscussionInput): Promise<EnsureDiscussionResult> {
  const { port, sessions, seqNo, workspaceId, workspacePath } = input
  const canReachFace = typeof port?.using === 'function' || typeof port?.binding === 'function'
  if (typeof port?.create !== 'function' || !canReachFace) {
    return { ok: false, error: zhCN.aiUnsupported }
  }
  const kind = input.kind ?? 'report_discussion'
  const existing = FIND_OF[kind](sessions, seqNo)[0]
  if (input.forceNew !== true && existing !== undefined) {
    // 不复用分支里也不「跳」：跳由调用方的 `onOpenDiscussion` 负责（见 DiscussionPort 注释）。
    return { ok: true, id: existing.id, created: false }
  }
  if (workspaceId === '' && workspacePath === '') return { ok: false, error: zhCN.aiNoWorkspace }
  try {
    const id = await port.create(workspaceId !== '' ? { workspaceId } : { cwd: workspacePath })
    // 会话名是复用凭据：`create` 不支持带标题，所以要在这里补一次 rename（`using` retain 之后）。
    // 失败不算致命（面板照样能聊），但**必须如实报出来** —— 名字没写上，下次就找不到这条会话、
    // 只能再建一条，用户看到的就是「每次点都新建」。
    const title = TITLE_OF[kind](seqNo, input.forceNew === true ? ORDINAL_OF[kind](sessions, seqNo) : 1)
    const renamed = await callFace(port, id, 'crwuWorkbench:discussion', 'rename', (face) => face.rename(title))
    const renameError = renamed.ok
      ? ''
      : (renamed.missing ? zhCN.aiUnsupported : `${zhCN.aiRenameFailed}${renamed.error}`)
    // 建完**不在这里跳**：调用方拿到 id 后调 `onOpenDiscussion`（面板接到 uiWorkspace.openSession）。
    // 两处都跳会连线两次 replaceMain，也会让「谁负责跳」变得说不清。
    return { ok: true, id, created: true, ...(renameError === '' ? {} : { renameError }) }
  } catch (cause: unknown) {
    return { ok: false, error: `${zhCN.aiCreateFailed}${describe(cause)}` }
  }
}

/** 把一句话发给讨论会话。返回空串 = 已受理；否则是给人看的失败原因。 */
export async function askDiscussion(port: DiscussionPort | undefined, id: string, text: string): Promise<string> {
  if (text === '') return ''
  const sent = await callFace(port, id, 'crwuWorkbench:discussion', 'prompt', (face) =>
    face.prompt([{ type: 'text', text }], 'queue'))
  if (sent.ok) return ''
  return sent.missing ? zhCN.aiUnsupported : `${zhCN.aiSendFailed}${sent.error}`
}
