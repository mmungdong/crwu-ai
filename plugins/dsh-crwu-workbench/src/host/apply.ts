import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// 只为类型增强：`@deepseek-ai/dsh-tools` 声明了 `Context.tools`。运行时它由 base bundle
// 以稳定 id `tools` 挂载（`dsh-base/cordis.patch.yml`），所以这里**不重复插入第二个实例**。
import type {} from '@deepseek-ai/dsh-tools'
import { WORKBENCH_ROUTE } from '../shared/consts.ts'
import { resolveWorkbenchConfig, type PluginConfig } from './config/config.ts'
import { registerRpcRoute } from './http/route.ts'
import { subscribeAuditEvents } from './audit/events.ts'
import { createCoreOperations } from './ops/core.ts'
import { createWorldFacts } from './platform/world.ts'
import { createWorkbenchState } from './state/store.ts'
import { H3yunFormResolver } from './h3yun/form.ts'
import { createPythonRuntimeResolver } from './runtime/python.ts'
import { registerCrwuTools } from './tools/register.ts'

/** 装配 DSH 工作台 Host 插件。 */
export function apply(ctx: Context, pluginConfig: PluginConfig): void {
  const config = resolveWorkbenchConfig(pluginConfig)
  const state = createWorkbenchState(config)
  // 执行世界的事实（平台/主目录/会话根）按插件实例缓存：探测各要跑子进程，逐次重探太贵。
  const world = createWorldFacts(ctx)
  // 子代理事件是 ended / endReason 的唯一来源；没有它「已中断」永不出现、自动上传永不触发。
  subscribeAuditEvents(ctx, state)
  // 两个**实例级**解析器（都在 `apply()` 里创建、随插件生命周期释放）：
  // - 表单 code：全插件只发现一次，列表 / 审核启动 / 业务 Tool 共用同一个 in-flight；
  // - DSH 自带 Python：只调一次 `load_workspace_dependencies` 并缓存成功结果。
  // 放实例上而不是模块顶层，是因为它们都带缓存；模块级会跨插件实例串味。
  const form = new H3yunFormResolver({
    ctx,
    config,
    state,
    trusted: () => state.trustCredentials === true,
    platform: () => world.platform(),
    workdir: () => world.workdir(),
  })
  const python = createPythonRuntimeResolver({ ctx, world })
  // 自研审核链路的全部业务能力都以结构化 Tool 交付（`crwu_*`）。注册进 DSH 的注册表，
  // schema 自动进 system prompt，并走同一条审批/沙箱/取消 pipeline。
  ctx.effect(() => registerCrwuTools(ctx, { ctx, config, state, world, form }), 'crwu-workbench: tools')
  const operations = createCoreOperations(ctx, config, state, world, { form, python })
  ctx.effect(() => registerRpcRoute(ctx, operations), 'crwu-workbench: rpc route')
  ctx.logger?.info?.('中瑞世联工作台 Host 半（包形态骨架）已装配 %o', {
    route: WORKBENCH_ROUTE,
    operations: Object.keys(operations).length,
    configSource: config.configSource,
  })
}
