import type { Context } from '@deepseek-ai/cordis'
import type { OperationMap } from './types.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkbenchState } from '../core/state/types.ts'
import type { WorldFacts } from '../core/platform/world.ts'
import type { LocalAccessSource } from '../core/access/operations.ts'
import type { OssDeps } from '../integrations/oss/ops.ts'
import type { IfindOpsDeps } from '../tools/integrations/ifind-ops.ts'
import type { LocalAuditDeps } from '../domains/local-audit/ops.ts'
import type { CoreDeps, HostResolvers } from './types-export.ts'
import { createOssBatchQueue } from '../integrations/oss/batch.ts'
import { createUploadWatch } from '../integrations/oss/watch.ts'
import { createCapabilityGate, guardOperation } from '../core/environment/gate.ts'
import { dwsSelf, type WhoamiResult } from '../core/system/identity.ts'
import { loadEnvironment } from '../core/environment/ops.ts'
import { missingAuditTools } from '../tools/register.ts'

/**
 * **操作表共享的依赖与闭包**（协议 32 · Task 3）。
 *
 * 拆分的动机不是"文件太长"，而是**这些闭包被三个域共用**：能力门禁快照（`gate`）、
 * OSS 依赖与批量队列、上传看门狗、身份缓存、环境自检入口。它们必须只有一份 ——
 * 每个域各建一份的后果是"授权之后只有环境页看到新事实、审核页还在用旧快照"，
 * 而那种不一致在任何地方都不会报错。
 *
 * 所以：本文件**构造一次**，三个域的操作表接收它（`OperationHost`）并按需取用。
 * 域文件里看不到 `create*` 调用，只看到 `host.gate` / `host.ossDeps` 这样的引用。
 */
export interface OperationHost {
  ctx: Context
  config: WorkbenchConfig
  state: WorkbenchState
  world: WorldFacts
  resolvers: HostResolvers
  extra: CoreDeps
  ossDeps: (source?: LocalAccessSource) => Promise<OssDeps>
  watch: ReturnType<typeof createUploadWatch>
  ossBatch: ReturnType<typeof createOssBatchQueue>
  identity: () => Promise<WhoamiResult>
  loadEnv: (options: { refresh: boolean }) => Promise<Record<string, unknown>>
  gate: ReturnType<typeof createCapabilityGate>
  guard: (operation: string) => Promise<Record<string, unknown> | null>
  ifindDeps: IfindOpsDeps
  localAuditDeps: () => LocalAuditDeps | null
  localAuditUnwired: { ok: boolean; error: string; errorKind: string }
  updateOperations: OperationMap
  valuationOperations: OperationMap
}

export function createOperationHost(
  ctx: Context,
  config: WorkbenchConfig,
  state: WorkbenchState,
  world: WorldFacts,
  resolvers: HostResolvers,
  extra: CoreDeps = {},
): OperationHost {
  /**
   * OSS 操作的依赖。
   *
   * 必须每次调用时重新构造：清单是环境自检拉来的，平台是探测出来的，
   * 都可能在这之后才就绪。构造时抓一次快照会让第一次调用永远拿到内置默认清单。
   */
  /** 估值操作表：缺省为空对象（只关心审核链路的测试夹具不必造它）。 */
  const valuationOperations = extra.valuation ?? {}

  const ossDeps = async (source: LocalAccessSource = 'panel'): Promise<OssDeps> => ({
    ctx,
    manifest: state.manifest,
    // **来源必须逐次给**：面板 RPC 是 `panel`，审核 Tool 与自动上传是 `audit-tool`。
    // 少了它就等于让"谁发起的"这件事由默认值决定 —— 那正是本次改造要消灭的东西。
    source,
    platform: await world.platform(),
    home: await world.home(),
    workdir: () => world.workdir(),
    access: resolvers.access,
  })
  // 上传看门狗：审核跑完不会回调，只能轮询「有结果就传」。句柄挂在插件实例上。
  const watch = createUploadWatch(ctx, state, ossDeps)
  const ossBatch = createOssBatchQueue(ossDeps)
  ctx.effect(() => ossBatch.dispose, 'crwu-workbench: OSS query queue')
  /**
   * 「我是谁」的进程内缓存（面板头部那句问候的姓名）。
   *
   * 它挂在**环境自检**上（用户口径：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面
   * 都去调」），所以这里要挡住的是"反复自检"：姓名在一次登录周期里不会变，缓存住就不再跑
   * `dws` 冷启动。**只缓存成功的结果** —— 失败（没登录 / 命令没跑起来）不缓存，
   * 员工登录之后刷一下自检就能拿到，不用重启 profile。
   */
  let meCache: WhoamiResult | null = null
  const identity = async (): Promise<WhoamiResult> => {
    if (meCache !== null) return meCache
    const me = await dwsSelf({ ctx, access: resolvers.access, workdir: () => world.workdir(), platform: await world.platform() })
    if (me.name !== '') meCache = me
    return me
  }
  // 定时器必须随插件生命周期释放；这里只登记释放动作，启动由 audit-start 触发。
  ctx.effect(() => watch.stop, 'crwu-workbench: upload watch')

  /**
   * 环境自检的唯一入口（`env` 操作与能力门禁共用）。
   *
   * 共用是刻意的：门禁必须与界面看到的是**同一份事实**；各跑一套的结果是
   * 「界面说没配好、Host 放行」或者反过来（见 `environment/gate.ts`）。
   */
  const loadEnv = async (options: { refresh: boolean }): Promise<Record<string, unknown>> => {
    const [platform, home] = [await world.platform(), await world.home()]
    return await loadEnvironment(
      // 「我是谁」跟着自检一起拿（见 identity 的注释）：自检本来就要问一次钉钉登录态。
      {
        ctx, config, state, home, platform,
        access: resolvers.access,
        sessionRoot: () => world.workdir(),
        identity,
        // DSH 自带 Python 由实例级解析器给（成功缓存、失败可显式刷新）。
        // **带上面板绑定的父会话 agent**：`load_workspace_dependencies` 需要 agent 作用域，
        // 而自检本身没有会话上下文 —— 不带 agent 调它只会拿到工具报错，运行时永远解析不出来
        // （2026-09-29 员工 Windows 实测：会话里调同一个工具返回完整载荷）。
        // 没绑定会话时退回不带 agent 的调用：那种情况环境页只报「待复核」，不判缺失。
        // 必需 Tool 的可见性：默认按根 Agent 查一次；宿主可注入替身用于测试收窄场景。
        ...(extra.auditTools === undefined
          ? { auditTools: async () => ({ missing: missingAuditTools(ctx, undefined), checked: true }) }
          : { auditTools: extra.auditTools }),
      },
      {
        ...(options.refresh ? { refresh: true } : {}),
      },
    ) as unknown as Record<string, unknown>
  }
  /**
   * 能力门禁：**带失效策略的快照**（默认 60s），敏感操作复用它而不是各自重跑一遍自检。
   * 会改变环境事实的操作（授权、选工作空间、保存凭据、登录）之后调 `invalidate()`。
   */
  const gate = createCapabilityGate(async (options) => {
    const result = await loadEnv(options)
    const state = result.state as import('../../shared/environment/model.ts').EnvironmentStateView | undefined
    return state ?? null
  })
  const ifindDeps: IfindOpsDeps = {
    ctx,
    access: resolvers.access,
    home: () => world.home(),
    platform: () => world.platform(),
    ...(extra.ifindTransport === undefined ? {} : { transport: extra.ifindTransport }),
    ...(extra.ifindTimeoutMs === undefined ? {} : { timeoutMs: extra.ifindTimeoutMs }),
  }

  /**
   * 敏感操作的 Host 侧门禁：被拒绝时返回失败信封，放行返回 null。
   *
   * 判据是**同一份环境快照**（`gate`），所以不会为每个操作重跑一遍昂贵自检；
   * 拿不到快照或自检失败一律 fail closed。
   */
  const guard = async (operation: string): Promise<Record<string, unknown> | null> =>
    await guardOperation(gate, operation)

  // 四个 update 操作（Task 4）：名字从**真实注入的操作表**推导，声明与实现不会各写一份。
  const updateOperations = extra.update ?? {}

  /**
   * 本地审核操作的依赖（逐次构造）。
   *
   * **不抓快照**：`ctx` / `world` 都是活的服务句柄，构造一次就固化的东西在这里没有意义 ——
   * 与上面 `ossDeps` 同一条理由。
   *
   * 三件依赖缺任何一件时返回 `null`（而不是抛 TypeError）：TS 调用方必须传，
   * 但 JS / 旧调用点漏传时**失败关闭并说人话**，而不是把一个 `undefined.sweep` 抛到路由层。
   */
  const localAuditDeps = (): LocalAuditDeps | null => {
    const registry = resolvers.localAudit
    const fs = resolvers.localAuditFs
    const io = resolvers.localAuditIo
    if (registry === undefined || fs === undefined || io === undefined) return null
    return { ctx, access: resolvers.access, state, world, registry, fs, io }
  }
  /** 没装配时的失败信封（形状与 `LocalAuditStartView` 兼容，界面按普通错误显示）。 */
  const localAuditUnwired = {
    ok: false, error: '本地审核没有装配：本插件实例不能准备本地审核文件', errorKind: 'capability-gap',
  }

  return {
    ctx, config, state, world, resolvers, extra,
    ossDeps, watch, ossBatch, identity, loadEnv, gate, guard, ifindDeps,
    localAuditDeps, localAuditUnwired, updateOperations, valuationOperations,
  }
}
