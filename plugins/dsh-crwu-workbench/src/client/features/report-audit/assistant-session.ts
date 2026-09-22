import { discussionTitle, findDiscussions, nextOrdinal } from './assistant-context.ts'
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
 * 3. **发问前 `open(id)`**：会话的事件窗口只在**当前会话**上是打开的（DSH 的 stage 语义），
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

export interface DiscussionPort {
  create?: (input?: { workspaceId?: string; cwd?: string }) => Promise<string>
  open?: (id: string) => void
  binding?: (id: string) => DiscussionBinding | undefined
  /** 会话列表快照商店：面板靠它认出「这份报告的讨论会话」（不靠自建映射表）。 */
  list?: SessionListStore
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
}

export type EnsureDiscussionResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; error: string }

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 拿到这份报告的讨论会话：有就复用（顺带 `open`），没有就建一条。
 *
 * 建会话的落点优先级：`workspaceId` → 退化用 `cwd: workspacePath` → 都没有就报错。
 * 没有落点时会话会建在 DSH 默认目录下，那不是用户说的"环境里选中的工作空间"。
 */
export async function ensureDiscussion(input: EnsureDiscussionInput): Promise<EnsureDiscussionResult> {
  const { port, sessions, seqNo, workspaceId, workspacePath } = input
  if (typeof port?.create !== 'function' || typeof port?.binding !== 'function') {
    return { ok: false, error: zhCN.aiUnsupported }
  }
  const existing = findDiscussions(sessions, seqNo)[0]
  if (input.forceNew !== true && existing !== undefined) {
    port.open?.(existing.id)
    return { ok: true, id: existing.id, created: false }
  }
  if (workspaceId === '' && workspacePath === '') return { ok: false, error: zhCN.aiNoWorkspace }
  try {
    const id = await port.create(workspaceId !== '' ? { workspaceId } : { cwd: workspacePath })
    // 会话名是复用凭据：`create` 不支持带标题，所以这里补一次 rename。失败不算致命 ——
    // 面板照样能聊，只是下次打开会再建一条（所以失败要如实报出来）。
    const face = port.binding(id)?.session
    if (typeof face?.rename === 'function') {
      await face.rename(discussionTitle(seqNo, input.forceNew === true ? nextOrdinal(sessions, seqNo) : 1))
    }
    port.open?.(id)
    return { ok: true, id, created: true }
  } catch (cause: unknown) {
    return { ok: false, error: `${zhCN.aiCreateFailed}${describe(cause)}` }
  }
}

/** 把一句话发给讨论会话。返回空串 = 已受理；否则是给人看的失败原因。 */
export async function askDiscussion(port: DiscussionPort | undefined, id: string, text: string): Promise<string> {
  if (text === '') return ''
  const face = port?.binding?.(id)?.session
  if (typeof face?.prompt !== 'function') return zhCN.aiUnsupported
  try {
    await face.prompt([{ type: 'text', text }], 'queue')
    return ''
  } catch (cause: unknown) {
    return `${zhCN.aiSendFailed}${describe(cause)}`
  }
}
