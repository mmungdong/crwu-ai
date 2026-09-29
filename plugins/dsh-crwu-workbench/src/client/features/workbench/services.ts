import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { DiscussionPort } from '../report-audit/assistant-session.ts'

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
   * 选中并切换到某个会话：内部是 `replaceMain(sessionId, signal, 'reveal')`
   * —— 设置主会话（`selection`）+ `layout.selectPanel(null)`（切回原生对话）。
   *
   * 这是**唯一**有效的「跳到某条会话」入口（左侧会话列表被点也是走它）。
   * 注意客户端 `sessions` 服务上**没有** `open()`：不要写成 `sessions.open(id)`。
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

/**
 * 右侧栏浏览器（`@deepseek-ai/dsh-client-ui-sidebar-browser` 注册的 `browser` 标签类型）。
 *
 * 只声明我们用到的那一个动词。**标签类型不是必然存在的**：Web profile 默认关闭它
 * （`disabled: profileContext?.name !== 'desktop'`），旧桌面端也没有这个包 —— 所以
 * `openTab` 可能抛错，调用方必须能退回系统浏览器（见 `environment/open-url.ts`）。
 */
export interface SidebarRightService {
  openTab?: (kind: string, options: { params?: { url?: string } }) => unknown
}

export interface LayoutService {
  /** 切换主面板（跳回会话用）；`null` = 回到当前会话的原生对话。 */
  selectPanel?: (panel: string | null) => void
}

/**
 * 会话服务：既有的两条「查看会话」路径 + 讨论面板要的四个动词。
 *
 * 讨论面板用到的 `create` / `using` / `binding` / `list` 直接沿用 `DiscussionPort`
 * 的形状 —— 一处定义，面板与这里不会各写一份而对不上。
 *
 * **这个服务上没有 `open()`**：切会话是 `uiWorkspace.openSession`（见 `discussionPortOf`）。
 */
export interface SessionsService extends DiscussionPort {
  /** 在会话控制器里选中某个子会话（不会切主面板，所以要配合 layout.selectPanel）。 */
  openSubagent?: (input: { parentSessionId: string; childSessionId: string; mode: string }) => unknown
  /** 先把子会话拉进清单再 openSubagent，否则可能「清单里没有这个孩子」。 */
  refreshSubagents?: (parentSessionId: string) => Promise<unknown>
}

export interface ClientServices {
  uiWorkspace: UiWorkspaceService | undefined
  workspaces: WorkspacesService | undefined
  layout: LayoutService | undefined
  sidebarRight: SidebarRightService | undefined
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
    get sidebarRight() { return ctx.get('sidebarRight') as SidebarRightService | undefined },
    get sessions() { return ctx.get('sessions') as SessionsService | undefined },
  }
}

/**
 * 把客户端会话服务适配成讨论面板要的 `DiscussionPort`（只转发**真的存在**的四个动词）。
 *
 * 三条口径，都是 2026-09-25 那次「点讨论/复核跳不到会话、也建不出新对话」的结论：
 *
 * 1. **不许凭空发明方法**：port 里只放 `ClientSessions` 上确实有的
 *    `create` / `using` / `binding` / `list`。早先这里塞了一个 `open`（服务上不存在），
 *    可选链把它变成静默 no-op —— 点下去什么都不发生，也不报错。
 *    「跳到某条会话」由面板的 `onOpenDiscussion` 接 **`uiWorkspace.openSession`** 负责。
 * 2. **不许 `{ ...sessions }`**：`sessions` 是 `ClientSessions` 的**实例**，方法挂在原型上，
 *    展开只复制自有字段（`manager` / `list` / `scopes`…），四个动词全丢。
 * 3. **必须经接收者调用**（`svc.create(...)`）：这些方法都依赖 `this`（`this.manager` /
 *    `this.scopes`），先把方法取出来再调会在第一个调用上 `TypeError`，症状同样是「建不出会话」。
 *
 * 服务缺席时返回 `{}`，由面板如实报「这个宿主版本不支持…」，而不是抛出去把整页打崩。
 */
export function discussionPortOf(services: Pick<ClientServices, 'sessions'>): DiscussionPort {
  const sessions = services.sessions
  const port: DiscussionPort = {}
  if (sessions === undefined) return port
  const svc = sessions
  if (typeof svc.create === 'function') port.create = (input) => svc.create!(input)
  if (typeof svc.using === 'function') port.using = (id, options, operation) => svc.using!(id, options, operation)
  if (typeof svc.binding === 'function') port.binding = (id) => svc.binding!(id)
  if (svc.list !== undefined) port.list = svc.list
  return port
}
