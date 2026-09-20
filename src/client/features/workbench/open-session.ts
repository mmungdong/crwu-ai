import type { ClientServices, LayoutService } from './services.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 打开一条审核子会话。
 *
 * 三步的顺序是**有意义**的，不是随手写的（legacy 的注释给了原因）：
 *
 * 1. **先 `refreshSubagents(parentId)`**（如果有这个方法）：让会话控制器先把子会话拉进清单，
 *    否则紧接着的 `openSubagent` 会因为「清单里没有这个孩子」而抛错；
 * 2. **`openSubagent({parentSessionId, childSessionId, mode})` 按 mode 逐个试**：
 *    先试记录里记的 mode，再 `one-shot`，最后 `continuable`。这个三元尝试是因为
 *    同一份记录在不同 DSH 版本/条件下可能落在不同 mode 上，试错比报错便宜；
 * 3. **`layout.selectPanel('conversation')`**：`openSubagent` 只是在会话控制器里**选中**那个
 *    子会话，并不会切主面板 —— 而当前主面板正是工作台自己，不切过去就是「打开了但看不见」。
 *
 * 另外还有一条**独立的兜底路径**：`uiWorkspace.openSession(id)`。它内部就是
 * `sessions.open(id)` + 切回会话面板，走的是客户端根服务。两条路径都试一遍的理由是
 * 「服务注册有先后」：某些部署里 `sessions` 会比我们晚注册，只认这一条路就会报
 * 「客户端 sessions 服务不可用」（用户实测踩到）。
 */

export interface SessionsService {
  openSubagent?: (input: { parentSessionId: string; childSessionId: string; mode: string }) => unknown
  refreshSubagents?: (parentSessionId: string) => Promise<unknown>
}

export interface OpenSessionInput {
  childId: string
  parentSessionId: string
  mode?: string
}

export interface OpenSessionResult {
  ok: boolean
  error: string
  /** 走通的路径；两条都没走通时为空串。 */
  via?: 'subagent' | 'openSession'
}

/** 可尝试的 mode 顺序：记录里的优先，然后是两个已知取值。 */
export function modeCandidates(recorded: string | undefined): string[] {
  const first = recorded === undefined || recorded === '' ? 'one-shot' : recorded
  const rest = ['one-shot', 'continuable'].filter((mode) => mode !== first)
  return [first, ...rest]
}

export async function openChildSession(
  services: Pick<ClientServices, 'sessions' | 'layout' | 'uiWorkspace'>,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  if (input.childId === '') return { ok: false, error: zhCN.openSessionNoChild }
  const sessions = services.sessions as SessionsService | undefined
  const uiWorkspace = services.uiWorkspace
  // 两条路径都没有才叫「服务不可用」：只看 sessions 会在它晚注册时报假警报。
  if (sessions === undefined && typeof uiWorkspace?.openSession !== 'function') {
    return { ok: false, error: zhCN.openSessionNoService }
  }
  if (input.parentSessionId === '' && sessions?.openSubagent !== undefined) {
    return { ok: false, error: zhCN.openSessionNoParent }
  }

  let last = ''
  if (typeof sessions?.openSubagent === 'function') {
    // 第 1 步：先刷新清单。失败不阻断 —— 有些部署没有这个方法，清单可能已经是新的。
    if (typeof sessions.refreshSubagents === 'function') {
      try {
        await sessions.refreshSubagents(input.parentSessionId)
      } catch (error) {
        void error
      }
    }

    // 第 2 步：按 mode 逐个试。
    for (const mode of modeCandidates(input.mode)) {
      try {
        sessions.openSubagent({ parentSessionId: input.parentSessionId, childSessionId: input.childId, mode })
        // 第 3 步：切到会话面板，否则「打开了但看不见」。
        selectConversation(services.layout)
        return { ok: true, error: '', via: 'subagent' }
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
    }
  }

  // 兜底路径：客户端根服务按 id 直接开（内部自己会切面板）。
  if (typeof uiWorkspace?.openSession === 'function') {
    try {
      uiWorkspace.openSession(input.childId)
      selectConversation(services.layout)
      return { ok: true, error: '', via: 'openSession' }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
  }

  return { ok: false, error: last === '' ? zhCN.openSessionNoService : `${zhCN.openSessionFailed}${last}` }
}

/** 切主面板；服务缺失或抛错都不该影响「已经打开了」这个事实。 */
function selectConversation(layout: LayoutService | undefined): void {
  try {
    layout?.selectPanel?.('conversation')
  } catch (error) {
    void error
  }
}
