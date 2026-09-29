import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// 只为类型增强：`@deepseek-ai/dsh-tools` 声明了 `Context.tools`。运行时它由 base bundle
// 以稳定 id `tools` 挂载（`dsh-base/cordis.patch.yml`），所以这里**不重复插入第二个实例**。
import type {} from '@deepseek-ai/dsh-tools'
import { WORKBENCH_ROUTE } from '../shared/consts.ts'
import { HOST_BUILD_KIND } from './build-info.ts'
import { PLUGIN_VERSION } from './consts.ts'
import { resolveWorkbenchConfig, type PluginConfig } from './config/config.ts'
import { registerRpcRoute } from './http/route.ts'
import { subscribeAuditEvents } from './audit/events.ts'
import { createCoreOperations } from './ops/core.ts'
import { createUpdateOperations } from './update/ops.ts'
import { createWorldFacts } from './platform/world.ts'
import { localAccessGranted } from './access/consent.ts'
import { createWorkbenchState } from './state/store.ts'
import { createLocalAccessBroker } from './access/broker.ts'
import { workbenchConfigPath } from './state/persist.ts'
import { ifindCredentialPath } from './ifind/store.ts'
import { ossConfigPath } from './oss/cred.ts'
import { WORKBENCH_PROTOCOL } from '../shared/consts.ts'
import { H3yunFormResolver } from './h3yun/form.ts'
import { createPythonRuntimeResolver } from './runtime/python.ts'
import { registerCrwuTools } from './tools/register.ts'

/** 装配 DSH 工作台 Host 插件。 */
export function apply(ctx: Context, pluginConfig: PluginConfig): void {
  const config = resolveWorkbenchConfig(pluginConfig)
  const state = createWorkbenchState(config)
  // 执行世界的事实（平台/主目录/会话根）按插件实例缓存：探测各要跑子进程，逐次重探太贵。
  const world = createWorldFacts(ctx)
  /**
   * **本地访问代理（Broker）**：所有跨工作区边界的 Host 操作的唯一策略所有者（协议 18）。
   *
   * 为什么在 `apply()` 里建、而且建在其它一切之前：它是**实例级**的（诊断缓冲、授权判据都跟着
   * 插件生命周期），而下面每一个子系统（Tool / 环境自检 / 审核 / 更新 / 工作空间）都要用它。
   * 三个可写目标的路径由各自的领域模块给出，Broker 只做「种类 + 路径必须逐字对上」的比对 ——
   * 它不认识业务路径，也就不可能被诱导去写别的文件。
   */
  const access = createLocalAccessBroker({
    ctx,
    state,
    home: () => world.home(),
    workdir: () => world.workdir(),
    platform: () => world.platform(),
    targets: {
      'workbench-state': workbenchConfigPath,
      'ifind-credential': ifindCredentialPath,
      'oss-config': ossConfigPath,
    },
    hostVersion: PLUGIN_VERSION,
    protocolVersion: WORKBENCH_PROTOCOL,
  })
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
    access,
    platform: () => world.platform(),
    workdir: () => world.workdir(),
  })
  const python = createPythonRuntimeResolver({ ctx, world })
  // 自研审核链路的全部业务能力都以结构化 Tool 交付（`crwu_*`）。注册进 DSH 的注册表，
  // schema 自动进 system prompt，并走同一条审批/沙箱/取消 pipeline。
  ctx.effect(() => registerCrwuTools(ctx, { ctx, config, state, world, form, access }), 'crwu-workbench: tools')
  // 自助更新（Task 4）：每个插件实例一套检查器 / 持久化 / 安装服务。
  // 这里只装配 —— 恢复与后台自动检查都在它内部启动，**不 await**（registry 故障、
  // Plugin Manager 缺失或检查挂起都不得挡住插件激活或下面的路由注册）。
  const update = createUpdateOperations({
    ctx,
    state,
    version: PLUGIN_VERSION,
    buildKind: HOST_BUILD_KIND,
    home: () => world.home(),
    access,
  })
  const operations = createCoreOperations(
    ctx,
    config,
    state,
    world,
    { form, python, access },
    { update: update.operations },
  )
  ctx.effect(() => registerRpcRoute(ctx, operations), 'crwu-workbench: rpc route')
  ctx.logger?.info?.('中瑞世联工作台 Host 半（包形态骨架）已装配 %o', {
    route: WORKBENCH_ROUTE,
    operations: Object.keys(operations).length,
    configSource: config.configSource,
  })
}
