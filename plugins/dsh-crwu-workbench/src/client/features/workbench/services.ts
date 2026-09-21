import type { Context as ClientContext } from '@deepseek-ai/cordis'

/**
 * 工作台用到的**可选 Client 服务**。
 *
 * 这些是浏览器侧的服务（不由 Host 提供），所以不能用 `rpc` 走同源接口：
 * 目录选择器与工作空间注册表都在页面里。缺失时要降级（例如没有 `uiWorkspace`
 * 就只显示提示，而不是抛错），因此一律用 `ctx.get`，不进 Client 的 `inject`。
 *
 * 注意到 `slots` 是硬依赖（没它注册不了任何东西），所以它仍在 `inject` 里。
 */

export interface PickedWorkspaceView {
  workspaceId?: string
  path?: string
  title?: string
}

export interface UiWorkspaceService {
  /** 打开系统目录选择器；用户取消时返回 falsy。 */
  pickDirectory?: () => Promise<string | null>
  /**
   * 选中并切换到某个会话（内部就是会话控制器的 `open` + 切回会话面板）。
   *
   * 它是「查看会话」的第二条路径：`sessions.openSubagent` 走的是子代理地址，
   * 而这个是客户端根服务、按 id 直接开，激活顺序上更稳。
   */
  openSession?: (sessionId: string) => void
  /** 在 parent 下新建目录，返回新目录的绝对路径。 */
  createDirectory?: (parent: string, name: string) => Promise<string>
  /** 在指定工作空间里开一个新会话。 */
  openWorkspace?: (workspaceId: string) => Promise<unknown>
}

export interface WorkspacesService {
  /** 把某个目录注册成工作空间。 */
  create?: (input: { path: string }) => Promise<PickedWorkspaceView>
}

export interface LayoutService {
  /** 切换主面板（跳回会话用）。 */
  selectPanel?: (panel: string) => void
}

export interface SessionsService {
  /** 在会话控制器里选中某个子会话（不会切主面板，所以要配合 layout.selectPanel）。 */
  openSubagent?: (input: { parentSessionId: string; childSessionId: string; mode: string }) => unknown
  /** 先把子会话拉进清单再 openSubagent，否则可能「清单里没有这个孩子」。 */
  refreshSubagents?: (parentSessionId: string) => Promise<unknown>
}

export interface ClientServices {
  uiWorkspace: UiWorkspaceService | undefined
  workspaces: WorkspacesService | undefined
  layout: LayoutService | undefined
  sessions: SessionsService | undefined
}

/**
 * 从 Client 上下文读可选服务。
 *
 * **每个字段都是 getter，访问时才去 `ctx.get`** —— 这不是微优化，是修一个真实故障：
 * 早先这里在 `apply()` 里读一次、把结果快照成普通对象传下去，于是**插件比别的客户端插件先激活**
 * 的那些部署里，`sessions` / `uiWorkspace` 还没注册，快照就是 `undefined`，而且**永远不会再变**。
 * 用户点「查看会话」看到的就是「客户端 sessions 服务不可用」（实测踩到）。
 *
 * 这些服务都是客户端根服务（`rootCtx.reflect.provide("sessions", …)`），可能比我们晚注册；
 * 现读既符合「可选服务用 ctx.get」的约定，也顺手消掉了激活顺序这一类竞态。
 */
export function readClientServices(ctx: ClientContext): ClientServices {
  return {
    get uiWorkspace() { return ctx.get('uiWorkspace') as UiWorkspaceService | undefined },
    get workspaces() { return ctx.get('workspaces') as WorkspacesService | undefined },
    get layout() { return ctx.get('layout') as LayoutService | undefined },
    get sessions() { return ctx.get('sessions') as SessionsService | undefined },
  }
}
