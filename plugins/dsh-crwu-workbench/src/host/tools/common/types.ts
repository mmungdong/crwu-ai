import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkbenchConfig } from '../../config/config.ts'
import type { WorkbenchState } from '../../core/state/types.ts'
import type { WorldFacts } from '../../core/platform/world.ts'
import { localAccessGranted } from '../../core/access/consent.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { H3yunFormResolver } from '../../integrations/h3yun/form.ts'
import type { ValuationScreenshotCapability } from '../../domains/report-evaluation/browser/capture.ts'
import type { ValuationBrowserRuntime } from '../../domains/report-evaluation/browser/runtime.ts'
import type { IfindTransport } from '../../integrations/ifind/mcp.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { DiscussionScopeRegistry } from '../../domains/report-audit/discussion-scope.ts'
import type { LocalAuditRegistry } from '../../domains/local-audit/handoff.ts'
import type { ValuationScopeService } from '../../domains/report-evaluation/scope.ts'
import type { ValuationLifecycles } from '../../domains/report-evaluation/lifecycle/index.ts'
import type { TaskLeaseStore } from '../../domains/report-evaluation/execution/leases.ts'
import type { SnapshotIo } from '../../domains/local-audit/snapshot.ts'
import type { PythonRuntimeResolver } from '../../core/runtime/python.ts'
import type { ValuationWorkflowRuntime } from '../../integrations/valuation-workflow/runtime.ts'

/**
 * 所有 CRWU Tool 的共享依赖。
 *
 * 工具是**闭包**：`register.ts` 在 `apply()` 里用这一份 deps 造出工具定义并注册，
 * 插件卸载时由注册返回的 disposer 一起撤销。所以这里不放任何进程级可变状态 ——
 * 状态本来就归 `WorkbenchState`。
 */
export interface ToolDeps {
  ctx: Context
  config: WorkbenchConfig
  state: WorkbenchState
  world: WorldFacts
  /**
   * 氚云表单 code 的**实例级**解析器。
   *
   * 记录类 Tool（`record_get` / `files_list` / `case_bootstrap`）需要 `schemaCode`，
   * 而它是 Host 的基础设施状态：模型既不能提交也不能猜。所有需要它的 Tool 都从这里取 ——
   * 已缓存则零成本，未缓存时全插件只发现一次（并发共享同一个 in-flight Promise）。
   */
  form: H3yunFormResolver
  /**
   * iFinD 取数的**可注入传输**（OPT-006）。
   *
   * 生产形态缺省用 `defaultIfindTransport()`（全局 `fetch` + 正常 TLS 校验）；
   * 测试注入内存替身，**永不访问真实网络**。
   */
  ifind?: IfindTransport
  /** iFinD 单次请求超时（毫秒）；缺省 60s。测试注入短超时验证超时分支。 */
  ifindTimeoutMs?: number
  /**
   * **页面截图能力**的可注入实现（§7.4）。
   *
   * 缺省不注入 = 本部署没有截图能力 → 每个候选案例显式写 `screenshot_missing`，
   * 并把缺口写进 `capabilityGaps`。**绝不用页面字节 / 指纹顶替截图。**
   *
   * 宿主若能提供用户在 DSH 中已验证的浏览器截图通道，在这里接上即可 ——
   * 采集与留痕纪律（案例关联、指纹、URL、采集时刻、失败不伪造）都已经在调用侧写好。
   */
  screenshot?: ValuationScreenshotCapability
  /** Broker（协议 18）：审核 Tool 的每一次跨边界调用都经它（来源 = audit-tool）。 */
  access: LocalAccessBroker
  /** Registered case and attachment boundaries, owned by this plugin instance's lifecycle. */
  discussionScopes: DiscussionScopeRegistry
  /**
   * **本地审核的一次性 handoff 与案例 scope 注册表**（协议 28）。
   *
   * 与 `discussionScopes` 同类：进程内、随插件生命周期释放。本地审核的案例目录在操作系统
   * 临时目录下，普通会话判据（`<工作空间>/<流水号>`）覆盖不到它，所以它必须有自己的注册表。
   *
   * 可选只是为了让只关心别的 Tool 的测试夹具不被逼着造一个注册表：缺失时
   * `crwu_audit_local_claim` 如实回 `capability-gap`，案例门禁也只是少一类本地 scope。
   */
  localAudit?: LocalAuditRegistry
  /** 本地审核快照的 IO（claim 时要回读清单确认快照仍在）；测试注入内存替身。 */
  localAuditIo?: SnapshotIo
  /**
   * **估值轮次的案例 scope 注册表**（协议 32）。
   *
   * 与 `localAudit` 同类：进程内、随插件生命周期释放。估值案例目录虽然就在工作区下，
   * 但普通会话判据只认"`<工作空间>/<某段>` 这个形状"，认不出**归属** ——
   * 于是同一条估值会话能把 caseDir 指向另一个案例目录。这里按会话 id 钉死归属。
   */
  valuationScopes?: ValuationScopeService
  /**
   * 估值轮次的注册表（协议 32）。
   *
   * **估值 Tool 需要写它**：`browser-login-required` 这个阶段与来源状态都不是"模型说一声"
   * 就能生效的 —— 面板轮询的是宿主的事实。工具拿到自己那一轮的 id（经 `valuationScopes.bySession`）
   * 之后把阶段 / 来源状态 / 能力缺口写进去，界面才看得到"需要登录、点了重新检查"。
   */
  valuationLifecycles?: ValuationLifecycles
  /**
   * **估值浏览器能力**（协议 35）。
   *
   * 缺省不注入 = 本部署没有浏览器通道：`crwu_valuation_browser_recover` 如实回
   * `capability-gap`，而**不是**去装库、拼命令或改用别的通道抓网页。
   *
   * 为什么整份 runtime 一起传：`toolClient`（取数）与 `panelClient`（门禁）必须共用
   * **同一条 profile 串行队列**，拆开注入就会出现"两条队列锁不住同一个标签页"。
   */
  browserRuntime?: ValuationBrowserRuntime
  /**
   * **估值执行租约**（协议 35，计划 Task 7）。
   *
   * 与 `valuationScopes` 同类：进程内、随插件生命周期释放。它回答的是"这个执行任务现在
   * 有没有执行者"，而"启动请求发出但结果未知"**也是**一种执行者状态 —— 那种状态下父会话
   * 接手重算，同一个方案会写出两份看起来都正常的结论。
   */
  valuationLeases?: TaskLeaseStore
  /**
   * DSH 自带 Python 的**实例级**解析器（`crwu_run_python_script` 用它）。
   *
   * 与审核启动、环境自检共用同一个实例，所以"哪一份 Python"只有一处判据、也只解析一次。
   * 可选只是为了不让只关心别的 Tool 的测试夹具被迫造一个运行时：**生产形态一定传**
   * （`apply.ts` 与 Broker 同处装配），缺了只会让那一个 Tool 如实回 `capability-gap`，
   * 绝不允许因此改去用系统解释器。
   */
  python?: PythonRuntimeResolver
  /**
   * **受控估值工作流运行时**（协议 43）。
   *
   * 与 `apply.ts` 的 Host 工厂、操作表共用**同一个**实例：`crwu_valuation_workflow_run`
   * 只转发 Host 铸造的不透明 commandId，运行时自己再核对真实执行上下文与父会话归属。
   * 缺省 = 本部署没有装配工作流（工具如实回 `capability-gap`），绝不另造一个运行时。
   */
  workflowRuntime?: ValuationWorkflowRuntime
}

/**
 * 取这次工具调用应该使用的 Context：**优先调用者 Agent 的 scope**。
 *
 * 为什么不无条件用插件的根 `ctx`：根 ctx 是「插件安装点」，不带任何 Agent 权限上下文；
 * 而 Agent 的 `ctx` 是 Cordis scope，继承部署的 `shell`/`fs` 等服务，同时带上该 Agent 的
 * 局部贡献。从审核子代理发起的业务命令应当按**子代理**的 scope 执行。
 *
 * 回退只在 Agent 没有 scope 时发生（例如老的部署形态），而且仍然是同一套 `ctx.shell` seam ——
 * 不会另建一个绕过沙箱与审批的执行通道。
 */
export function toolContext(root: Context, exec: ToolRunContext): Context {
  const scoped = (exec.agent as { ctx?: Context } | undefined)?.ctx
  return scoped ?? root
}

/**
 * 调用方那条**会话**（`exec.agent.session`）。
 *
 * 为什么案例内操作必须带上它：DSH 的执行器**不持有会话**，请求里不带 `sandboxPolicy` 时只会用
 * 部署默认（进程 cwd）。Broker 拿这个会话去 `sandboxPolicy.resolve({ session })`，
 * 才能让命令落在**调用方自己的**沙箱边界里（审核根 / 子会话的边界就是本轮案例目录）。
 * 拿不到（老宿主 / 无 Agent 的宿主调用）时返回 `undefined`，由调用方按失败处理。
 */
export function callerSession(exec: ToolRunContext): Session | undefined {
  return (exec.agent as { session?: Session } | undefined)?.session
}

/** 会话工作目录（命令的默认 workdir）；取不到返回空串。 */
export async function sessionWorkdir(deps: ToolDeps): Promise<string> {
  return await deps.world.workdir()
}

/** 是否已在面板上授权读取本机凭据。 */
export function credentialsTrusted(deps: ToolDeps): boolean {
  return localAccessGranted(deps.state.localAccess)
}
