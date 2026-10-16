import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// 只为类型增强：`@deepseek-ai/dsh-tools` 声明了 `Context.tools`。运行时它由 base bundle
// 以稳定 id `tools` 挂载（`dsh-base/cordis.patch.yml`），所以这里**不重复插入第二个实例**。
import type {} from '@deepseek-ai/dsh-tools'
import { WORKBENCH_ROUTE } from '../shared/consts.ts'
import { HOST_BUILD_KIND } from './build-info.ts'
import { PLUGIN_VERSION } from './consts.ts'
import { resolveWorkbenchConfig, type PluginConfig } from './config/config.ts'
import { registerRpcRoute } from './core/http/route.ts'
import { subscribeAuditEvents } from './domains/report-audit/events.ts'
import { createCoreOperations } from './operations/core.ts'
import { createUpdateOperations } from './update/ops.ts'
import { createWorldFacts } from './core/platform/world.ts'
import { createWorkbenchState } from './core/state/store.ts'
import { createLocalAccessBroker } from './core/access/broker.ts'
import { workbenchConfigPath } from './core/state/persist.ts'
import { ifindCredentialPath } from './integrations/ifind/store.ts'
import { ossConfigPath } from './integrations/oss/cred.ts'
import { WORKBENCH_PROTOCOL } from '../shared/consts.ts'
import { H3yunFormResolver } from './integrations/h3yun/form.ts'
import { createPythonRuntimeResolver } from './core/runtime/python.ts'
import { registerCrwuTools } from './tools/register.ts'
import type { ToolDeps } from './tools/common/types.ts'
import { createValuationOperations } from './operations/report-evaluation.ts'
import { createValuationBrowserRuntime } from './domains/report-evaluation/browser/runtime.ts'
import { ValuationLifecycles } from './domains/report-evaluation/lifecycle/index.ts'
import { ValuationScopes } from './domains/report-evaluation/scope.ts'
import { createTaskLeaseStore } from './domains/report-evaluation/execution/leases.ts'
import { createDiscussionScopeRegistry } from './domains/report-audit/discussion-scope.ts'
import { createLocalAuditRegistry } from './domains/local-audit/handoff.ts'
import { createDwsDeviceLoginRegistry, createLoginHandleHolder } from './core/system/device-login.ts'
import { nodeSnapshotIo } from './domains/local-audit/snapshot.ts'
import { nodeLocalAuditFs } from './domains/local-audit/scan.ts'

/**
 * `ToolDeps` 的**装配视图**：所有可选依赖在这里都是必需的。
 *
 * 加一个可选依赖到 `ToolDeps` 之后，这里立刻编译不过 —— 必须回 `apply()` 把它接上，
 * 或者显式写 `undefined`（那也是一个决定，而不是遗忘）。单测夹具不受影响。
 */
type AssembledToolDeps = ToolDeps & Required<Omit<ToolDeps, 'ctx' | InjectionOnlyToolDeps>>

/**
 * 生产装配**故意不提供**的依赖。
 *
 * 写在这里而不是散在注释里：这份名单本身就是"我们想过这两个字段"的记录。
 * 三种情况 —— ① 测试注入点（`ifind` 传内存替身，缺省就是真实传输）；
 * ② 有默认值的调优项（`ifindTimeoutMs`）；
 * ③ **本部署确实没有的能力**（`screenshot`）：缺省 = 没有截图能力 → 每个候选案例显式写
 *    `screenshot_missing` 并记能力缺口，而不是伪造截图。宿主提供已验证的截图通道时在这里接上。
 * 新增的可选依赖如果不属于这三类，就必须在 `apply()` 里接上，否则上面那行类型会直接编译不过。
 */
// `screenshot` 从 InjectionOnly 里**移出**（2026-10-14）：方法要求页面截图留证，
// 它必须是生产装配的一部分 —— 缺省不装会让每个候选案例都写 `screenshot_missing`，
// 而报告只能到 partial，看起来却像"业务上不需要截图"。
type InjectionOnlyToolDeps = 'ifind' | 'ifindTimeoutMs'

/** 过期快照的兜底清理间隔（面板每次准备也会顺手清一次）。 */
const LOCAL_AUDIT_SWEEP_INTERVAL_MS = 10 * 60_000

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
  /**
   * **讨论会话的受限材料范围**（协议 23）。进程内、不落盘、随插件生命周期释放 ——
   * 报告讨论要能取材料，但它拿到的只该是"登记那一刻从氚云取到的那批附件"，
   * 所以这份白名单必须挂在实例上（模块级会跨插件实例串味，落盘会引出新的暴露面）。
   */
  const discussionScopes = createDiscussionScopeRegistry()
  /**
   * **本地审核的一次性 handoff 与案例 scope**（协议 28）。同样是进程内、随插件生命周期释放：
   * 产品口径是「审核结果只存在于这次对话里」，所以交接记录不落盘、不做历史、重启即失效。
   * 它的案例目录在操作系统临时目录下，普通会话判据覆盖不到，因此必须有自己的注册表。
   */
  const localAudit = createLocalAuditRegistry()
  const localAuditIo = nodeSnapshotIo()
  // 过期 / 用完的快照目录要清掉：临时目录不该无限长。定时器随插件卸载释放；
  // 面板每次调用 `local-audit-start` 也会顺手清一次（见 `operations/core.ts`），所以这里只是兜底。
  const cleanupTimer = setInterval(() => {
    void localAudit.sweep(localAuditIo).catch(() => undefined)
  }, LOCAL_AUDIT_SWEEP_INTERVAL_MS)
  cleanupTimer.unref?.()
  ctx.effect(() => () => { clearInterval(cleanupTimer) }, 'crwu-workbench: local audit sweep')
  // 自研审核链路的全部业务能力都以结构化 Tool 交付（`crwu_*`）。注册进 DSH 的注册表，
  // schema 自动进 system prompt，并走同一条审批/沙箱/取消 pipeline。
  // 估值轮次的状态机与案例 scope（协议 32）：**操作表与 Tool 闭包必须共用同一份实例** ——
  // 两处各造一个的后果是"工具说这一轮在跑、状态页说没有这一轮"。
  const valuationLifecycles = new ValuationLifecycles()
  const valuationScopes = new ValuationScopes()
  // 单执行租约：与 Tool 闭包共用同一份实例（两处各造一个 = 两条链路对"谁在跑"给出不同答案）。
  const valuationLeases = createTaskLeaseStore()
  /**
   * 注册给 Tool 闭包的依赖。
   *
   * 类型是**全字段必需**的视图（`AssembledToolDeps`）：`ToolDeps` 里的可选字段是给
   * 手搭夹具用的（单测可以只给被测那几项），但**真实装配漏一项必须是编译错误**。
   * 为什么不让它悄悄少一项：少一项不会崩 —— 它会退化成"某个功能默默降级"
   *（例如估值工具写不回轮次状态，界面永远停在"正在跑"），而那正是最难发现的一类问题。
   */
  /**
   * **房地产浏览器能力**（协议 35，计划 Task 3）。一处装配一处收尾：
   * 它的 profile 串行队列、登录任务与挑战恢复预算都是**进程内状态**，随插件实例活着、随卸载消失。
   * 估值 Tool 侧复用同一个 runtime 的 `toolClient` / `coordinator`（Task 8），
   * 所以这里存下来而不是只用它的操作表。
   */
  const valuationBrowser = createValuationBrowserRuntime({ ctx, config, access, world })
  const toolDeps: AssembledToolDeps = {
    ctx, config, state, world, form, access, discussionScopes,
    localAudit, localAuditIo,
    valuationScopes,
    valuationLeases,
    // 估值 Tool 也要能写轮次状态（`browser-login-required` 与来源状态是宿主的事实，
    // 面板轮询的是它）—— 所以与操作表共用**同一个**注册表实例。
    valuationLifecycles,
    // 与审核启动、环境自检共用同一个 Python 解析器（同一份缓存）：`crwu_run_python_script`
    // 绝不自己去猜解释器。
    python,
    // 浏览器能力必须在**工具注册之前**造好：`crwu_valuation_browser_recover` 要用它的协调器，
    // 而 `AssembledToolDeps` 是全字段必需视图 —— 漏传是编译错误（不是"某项功能默默降级"）。
    browserRuntime: valuationBrowser,
    // 截图能力与取数共用同一条 profile 队列（`toolClient`）。
    screenshot: valuationBrowser.screenshot,
  }
  ctx.effect(() => registerCrwuTools(ctx, toolDeps), 'crwu-workbench: tools')
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
  /**
   * **钉钉设备流登录**（协议 32）。它握着一条后台 `dws` 进程与一个轮询定时器，必须按插件实例
   * 持有并在卸载时收尾 —— 残留就是「看不见的进程还占着 `~/.dws` 的登录态锁」，
   * 员工下一次登录会莫名其妙失败。
   *
   * （上面这一段的旧版本讲的是协议 21 的两阶段登录；协议 22 把那条链路整体删掉之后，
   * 注释留了下来而代码没有 —— 这次它重新有了对应的东西。）
   */
  const deviceLogin = createDwsDeviceLoginRegistry()
  // loopback 那条路自己不管句柄（它是一次同步调用），但同样要有东西能在卸载时收尾 ——
  // 现场留下过三个占着 `~/.dws` 锁的 `dws auth login` 进程。
  const loginHandles = createLoginHandleHolder()
  ctx.effect(() => () => {
    loginHandles.dispose()
    void deviceLogin.dispose()
    // 浏览器 runtime：中止本插件发起的登录任务、清掉恢复预算与还没开始的排队项。
    // 正在执行的操作由调用者自己的 signal 决定，这里不杀。
    valuationBrowser.dispose()
  }, 'crwu-workbench: dws login sessions')
  const operations = createCoreOperations(
    ctx,
    config,
    state,
    world,
    {
      form, python, access, discussionScopes, localAudit,
      localAuditFs: nodeLocalAuditFs(), localAuditIo, deviceLogin, loginHandles,
    },
    {
      update: update.operations,
      valuation: {
        ...createValuationOperations({
          ctx, state, access, world, config,
          lifecycles: valuationLifecycles, scopes: valuationScopes,
        }),
        // 门禁三操作（preflight / login / login-cancel）只拦房地产正文。
        ...valuationBrowser.operations,
      },
    },
  )
  ctx.effect(() => registerRpcRoute(ctx, operations), 'crwu-workbench: rpc route')
  ctx.logger?.info?.('中瑞世联工作台 Host 半（包形态骨架）已装配 %o', {
    route: WORKBENCH_ROUTE,
    operations: Object.keys(operations).length,
    configSource: config.configSource,
  })
}
