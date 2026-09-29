import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { WorldFacts } from '../platform/world.ts'
import { localAccessGranted } from '../access/consent.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { H3yunFormResolver } from '../h3yun/form.ts'
import type { IfindTransport } from '../ifind/mcp.ts'

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

/** 会话工作目录（命令的默认 workdir）；取不到返回空串。 */
export async function sessionWorkdir(deps: ToolDeps): Promise<string> {
  return await deps.world.workdir()
}

/** 是否已在面板上授权读取本机凭据。 */
export function credentialsTrusted(deps: ToolDeps): boolean {
  return localAccessGranted(deps.state.localAccess)
}
