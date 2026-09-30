import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { WorldFacts } from '../platform/world.ts'
import { localAccessGranted } from '../access/consent.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { H3yunFormResolver } from '../h3yun/form.ts'
import type { IfindTransport } from '../ifind/mcp.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { DiscussionScopeRegistry } from '../audit/discussion-scope.ts'
import type { PythonRuntimeResolver } from '../runtime/python.ts'

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
  /** Broker（协议 18）：审核 Tool 的每一次跨边界调用都经它（来源 = audit-tool）。 */
  access: LocalAccessBroker
  /**
   * **讨论会话的受限材料范围**（协议 23，进程内、不落盘）。
   *
   * `crwu_h3yun_file_get` 的材料门禁要回答"这个调用者能取哪些附件"：
   * 审核子会话走审核记录里的白名单，**报告讨论会话**走这里登记的 `fileId` 白名单。
   * 它必须由 `apply()` 创建并随插件生命周期释放（模块级会跨实例串味）。
   */
  discussionScopes: DiscussionScopeRegistry
  /**
   * DSH 自带 Python 的**实例级**解析器（`crwu_run_python_script` 用它）。
   *
   * 与审核启动、环境自检共用同一个实例，所以"哪一份 Python"只有一处判据、也只解析一次。
   * 可选只是为了不让只关心别的 Tool 的测试夹具被迫造一个运行时：**生产形态一定传**
   * （`apply.ts` 与 Broker 同处装配），缺了只会让那一个 Tool 如实回 `capability-gap`，
   * 绝不允许因此改去用系统解释器。
   */
  python?: PythonRuntimeResolver
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
