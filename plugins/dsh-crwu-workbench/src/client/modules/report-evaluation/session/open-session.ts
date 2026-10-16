import { zhCN } from '../../../locales/zh-CN.ts'

/**
 * 把估值页的**父会话**打开给员工看（计划 Task 4 · 设计稿 §4.5）。
 *
 * ## 为什么单独一个薄适配器，而不是写在做面板里
 *
 * 这段逻辑有两条**容易写错、写错又看不出来**的口径，所以它必须能单独断言：
 *
 * 1. **这是顶层父会话，走 `uiWorkspace.openSession`，绝不走 `openSubagent`**。
 *    估值会话不是审核子会话（它没有父级、不在任何审核树里）；用 `openSubagent` 去开它
 *    只会在会话控制器里找一个不存在的父子关系，表现为"提示成功了、屏幕上什么都没有"。
 * 2. **`uiWorkspace` 可能比本插件晚注册**，所以服务**在调用时现读**，不在装配时快照
 *    （本仓在 `sessions` / `uiWorkspace` 上踩过三次同一个坑）。所以这里收的是
 *    `{ get uiWorkspace() }` 形状的活服务，而不是一个值。
 *
 * 切主面板是**尽力而为**：`layout.selectPanel` 缺席或抛错都不影响"会话已经打开了"这个事实，
 * 所以它失败不算导航失败。
 */

export interface ValuationSessionServices {
  uiWorkspace?: { openSession?: (sessionId: string) => void }
  layout?: { selectPanel?: (panel: string | null) => void }
}

export interface OpenValuationSessionResult {
  ok: boolean
  error: string
}

export async function openValuationSession(
  services: ValuationSessionServices,
  sessionId: string,
): Promise<OpenValuationSessionResult> {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return { ok: false, error: zhCN.openSessionNoChild }
  const open = services?.uiWorkspace?.openSession
  if (typeof open !== 'function') return { ok: false, error: zhCN.openSessionNoService }
  try {
    open.call(services.uiWorkspace, id)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `${zhCN.openSessionFailed}${reason}` }
  }
  // 打开之后必须切回会话面板，否则「打开了但看不见」（我们自己的工作台还占着主面板）。
  try {
    services.layout?.selectPanel?.('conversation')
  } catch (error) {
    void error
  }
  return { ok: true, error: '' }
}
