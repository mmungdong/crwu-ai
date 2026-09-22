import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 「与 DeepSeek 共同讨论这份报告」的**上下文构造**（纯函数，可单测）。
 *
 * 用户口径（2026-09-22）：
 * - 面板里那一栏是**定制**的：先展示这份报告的基本信息、云端内容、其他文件，
 *   再让用户基于这份报告和 AI 沟通；
 * - **开始聊的时候给 AI 注入上下文**：「你是一个资深的资产评估师，现在正在与该报告负责人
 *   讨论当前这份报告的信息，你需要做的是回答用户的疑问，还有就是一起和用户保证当前这份
 *   报告的质量」。
 *
 * 为什么注入放在**首轮提问**里，而不是去改会话的 system prompt：客户端建会话只有
 * `sessions.create({ workspaceId })` 这一条路，它不接受 system prompt；把角色与报告事实
 * 作为第一条消息发出去，既不需要额外的宿主操作，也让这段上下文在会话里**看得见、可追溯**
 * （会话列表点开就是它）。之后的轮次不再重复注入 —— 同一会话的历史本来就在上下文里。
 */

/** 讨论会话要注入的「报告事实」。全部来自已有数据（氚云行 + OSS 清单），不额外发请求。 */
export interface DiscussionFacts {
  seqNo: string
  /** 氚云记录 id（`crwu h3yun files list --id` 要它）。 */
  objectId: string
  /** 项目名（没有项目名时用表单名兜底，与大列表主行一致）。 */
  project: string
  name: string
  risk: string
  reviewLevel: string
  reviewState: string
  currentNode: string
  modifiedAt: string
  formName: string
  /**
   * **远端**资料行（氚云附件 + 云端交付件）。
   *
   * 用户 2026-09-23 强制口径：报告业务会话只允许用远端资料 ——
   * 这里**不许**出现本地案例目录的文件名或路径，也不许把工作空间路径写进上下文。
   */
  files: readonly string[]
  /** 本次从远端获取这批资料的时刻。 */
  fetchedAt: string
  /** 远端来源清单（provider + 远端标识 + 版本/时间 + 指纹），**不含 localPath**。 */
  sources: readonly string[]
}

/**
 * 讨论会话的名字。**靠它找回**这份报告的全部讨论会话。
 *
 * 用户口径（2026-09-22）：同一份报告可以有**多条**讨论 —— 点鲸鱼时气泡会问
 * 「新建对话 / 继续上次聊天」。所以标题以 `报告讨论 · <流水号>` 为**前缀**，
 * 新建时依次追加 ` #2` ` #3`；找回时按**前缀**匹配，不要求逐字相等，
 * 否则第二条之后再也认不出来，"继续上次"就会指错人。
 */
export function discussionTitle(seqNo: string, ordinal = 1): string {
  return ordinal <= 1 ? `${zhCN.aiSessionPrefix}${seqNo}` : `${zhCN.aiSessionPrefix}${seqNo} #${String(ordinal)}`
}

/** 会话列表里这份报告的**全部**讨论会话（保持列表顺序，最近的在前）。 */
export function findDiscussions<T extends { id: string; displayTitle?: string; title?: string }>(
  sessions: readonly T[],
  seqNo: string,
): T[] {
  const base = discussionTitle(seqNo)
  return sessions.filter((item) => {
    const title = item.displayTitle ?? item.title ?? ''
    // 要么逐字等于基础名，要么是「基础名 #N」。**不能**用纯 startsWith：
    // `报告讨论 · X-1` 是 `报告讨论 · X-10` 的前缀，那样会把别的报告的对话也算进来。
    return title === base || title.startsWith(`${base} #`)
  })
}

/** 下一条该用的序号：已有 n 条就建第 n+1 条。 */
export function nextOrdinal<T extends { id: string; displayTitle?: string; title?: string }>(
  sessions: readonly T[],
  seqNo: string,
): number {
  return findDiscussions(sessions, seqNo).length + 1
}

function line(key: string, value: string): string {
  return value.trim() === '' ? '' : `- ${key}：${value.trim()}`
}

/**
 * 首轮注入的上下文块。
 *
 * 报告事实一律**逐行列出、缺项不写**（不写「未知」也不写空行）：空字段占位会让模型
 * 以为"没有这个字段"，而漏掉一行它自己会去会话里问。
 */
export function discussionBrief(facts: DiscussionFacts): string {
  const rows = [
    line(zhCN.aiFactSeqNo, facts.seqNo),
    line(zhCN.aiFactProject, facts.project !== '' ? facts.project : facts.name),
    line(zhCN.aiFactForm, facts.formName),
    line(zhCN.aiFactRisk, facts.risk),
    line(zhCN.aiFactReview, [facts.reviewLevel, facts.reviewState].filter((part) => part !== '').join(' · ')),
    line(zhCN.aiFactNode, facts.currentNode),
    line(zhCN.aiFactModified, facts.modifiedAt),
    // **不写工作空间路径**：本地路径既不是业务来源，也会把模型引向本机文件（用户 §4/§11）。
    line(zhCN.auditCtxFetchedAt, facts.fetchedAt),
  ].filter((row) => row !== '')

  const files = facts.files.length === 0
    ? [zhCN.aiFactFilesNone]
    : facts.files.map((name) => `- ${name}`)
  const sources = facts.sources.length === 0
    ? [zhCN.auditCtxNone]
    : facts.sources.map((ref) => `- ${ref}`)

  return [
    // 专业版协作 Prompt 逐字注入（用户 2026-09-22 定稿）+ 数据边界（用户 2026-09-23 定稿）。
    // 只在**新建对话**时发一次，「继续上次对话」不重复注入 —— 历史里已经有它了。
    zhCN.aiSystemPrompt,
    '',
    zhCN.aiDataBoundaryDiscuss,
    '',
    `${zhCN.aiFactHead}：`,
    ...rows,
    '',
    `${zhCN.aiFileHead}（远端资料 ${String(facts.files.length)} 项）：`,
    ...files,
    '',
    `${zhCN.auditCtxSourceHead}（${String(facts.sources.length)}）：`,
    ...sources,
  ].join('\n')
}

/**
 * 组装一次提问：`first` 为真时把上下文块拼在前面（首轮），否则只发问题本身。
 *
 * 空问题返回空串 —— 调用方据此**不发请求**（空提问既浪费一次模型调用，也会在会话里
 * 留一条没有内容的用户消息）。
 */
export function discussionPrompt(facts: DiscussionFacts, question: string, first: boolean): string {
  const asked = question.trim()
  if (asked === '') return ''
  if (!first) return asked
  return `${discussionBrief(facts)}\n\n${zhCN.aiQuestionHead}：\n${asked}`
}
