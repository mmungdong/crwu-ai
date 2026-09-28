/**
 * 自助更新的 Host 操作层：四个同源 RPC + 启动恢复屏障 + 一次后台自动检查。
 *
 * 这一层只做**协调**，不重复任何领域判据：
 * - 政策、缓存、退避与授权在 `check.ts`（Task 2）；
 * - 安装状态机、取消与恢复在 `service.ts`（Task 3）；
 * - 持久化与 Plugin Manager 适配在 `persist.ts` / `manager.ts`。
 *
 * 三条装配纪律：
 * 1. **同步装配**：`createUpdateOperations()` 立刻返回，`apply()` / `boot` 都不 await 它 ——
 *    registry 故障、Plugin Manager 缺失、自动检查挂起都不得挡住插件激活或 RPC 注册。
 * 2. **恢复先行**：四个操作都先等 `ready`（恢复屏障），恢复完成后才在后台起一次自动检查；
 *    `update-install` 因此绝不会在旧的 `installing` / `awaiting-restart` 标记还没判定时动手。
 * 3. **安装目标只能来自 Host**：`update-install` 只接受空参数，目标取自
 *    `checker.installableCandidate()`；出现任何参数一律拒绝，并且 checker / store /
 *    Plugin Manager **零调用**。
 */
import { randomUUID } from 'node:crypto'

import { UPDATE_OPERATION_NAMES } from '../../shared/consts.ts'
import { createUpdateChecker } from './check.ts'
import { createUnavailableManager } from './manager.ts'
import { pluginUpdateStoreFor } from './persist.ts'
import { createUpdateService } from './service.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PluginInstallProgress, PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager'
import type { HostBuildKind } from '../build-info.ts'
import type { Operation, OperationMap } from '../ops/types.ts'
import type { PluginManagerPort, PluginUpdateStore, UpdateDiscoveryFn } from './types.ts'
import type { UpdateInstallState, UpdateOperationPayload } from '../../shared/update/types.ts'

/** 参数拒绝文案：固定串，绝不回显调用方输入（回显就是把输入当消息内容传出去）。 */
export const UPDATE_INSTALL_ARGS_REJECTED = '更新安装不接受任何参数'

/**
 * requestId 的唯一造值点。
 *
 * `PluginInstallRequestId` 是编译期品牌类型（`dsh-brand` 的 `Branded`），运行时就是一个字符串，
 * 所以这里做**一次受控收窄**：不新增对 `@deepseek-ai/dsh-brand` 的直接依赖，也不把 id 写进
 * 状态文件或返回给 Client（它只用来在进程内匹配进度事件与取消请求）。
 */
function defaultRequestId(): PluginInstallRequestId {
  return randomUUID() as PluginInstallRequestId
}

export interface UpdateOpsDeps {
  ctx: Context
  /** 审核占用判据的来源（active 与 starting 都必须算忙）。 */
  state: { activeKey: string; startingKey: string }
  /** 当前运行版本（`PLUGIN_VERSION`）。 */
  version: string
  /** 当前运行形态（`HOST_BUILD_KIND`）：`dev` 不参与自助更新。 */
  buildKind: HostBuildKind
  /** 惰性 home provider：`world.home()` 是异步事实，同步的 `apply()` 不能猜。 */
  home: () => Promise<string>
  now?: () => Date
  newRequestId?: () => PluginInstallRequestId
  /** 测试注入；缺省从 `ctx.get('pluginManager')` 读（可选能力）。 */
  manager?: PluginManagerPort
  /** 测试注入；缺省用 Task 1 的固定两源发现。 */
  discover?: UpdateDiscoveryFn
  /** 测试注入；缺省用执行世界 home 的真实 store。 */
  store?: PluginUpdateStore
}

export interface UpdateOperations {
  /** 恰好四个 `update-*` 操作，直接并进 Host 操作表。 */
  operations: OperationMap
  /** 启动恢复屏障：四个操作都先等它；`apply()` / `boot` 不等。 */
  ready: Promise<UpdateInstallState>
  /** 恢复之后那一次后台自动检查的收敛句柄（生产代码不 await，测试用它做确定性断言）。 */
  autoCheck: Promise<void>
}

export function createUpdateOperations(deps: UpdateOpsDeps): UpdateOperations {
  const now = deps.now ?? (() => new Date())
  // Plugin Manager 是**可选**服务：不在 PLUGIN_INJECT 里，缺失也不影响激活。
  const manager = deps.manager ?? (deps.ctx.get('pluginManager') as PluginManagerPort | undefined)
  const store = deps.store ?? pluginUpdateStoreFor(deps.ctx, deps.home)

  const checker = createUpdateChecker({
    version: deps.version,
    buildKind: deps.buildKind,
    now,
    // 没有服务就没有可确认的 registry 政策 → manager-unavailable（绝不猜公共源）。
    registries: manager === undefined ? undefined : () => manager.registries(),
    discover: deps.discover,
  })
  const service = createUpdateService({
    version: deps.version,
    now,
    newRequestId: deps.newRequestId ?? defaultRequestId,
    checker,
    // 服务缺失时给一个"什么都做不成"的端口：恢复会读不到磁盘事实（unknown），
    // 而安装入口在下面的操作层被直接拦下 —— 两道防线，不互相依赖。
    manager: manager ?? createUnavailableManager(),
    store,
    // 审核**正在创建**（startingKey）时同样不能改 profile，只查 activeKey 会漏掉那个窗口。
    auditBusy: () => deps.state.activeKey !== '' || deps.state.startingKey !== '',
  })

  // 进度事件：只订阅 install-state（`install-log` 是 pnpm 原始日志，绝不订阅、绝不转发）。
  // effect 让监听器随插件生命周期释放；`attempt.registry` 与 requestId 都不进对外状态。
  deps.ctx.effect(
    () =>
      deps.ctx.on('plugin-manager/install-state', (progress: PluginInstallProgress) => {
        service.acceptProgress(progress)
      }),
    'crwu-workbench: update progress',
  )

  /** 四个操作统一的成功信封：动作执行完 + 最新 check/install 快照。 */
  const snapshot = (): UpdateOperationPayload => ({
    ok: true,
    check: checker.status(),
    install: service.status(),
  })

  // 恢复屏障：只做持久化 + 磁盘事实的判定，不打 registry；失败也在服务内部收敛成状态。
  const ready: Promise<UpdateInstallState> = service.recover().catch(() => service.status())

  // 恢复完成后**一次**后台自动检查。显式 catch：不 await、不阻塞激活、不留未处理拒绝。
  const autoCheck: Promise<void> = ready
    .then(() => checker.check())
    .then(() => undefined)
    .catch(() => {
      // 只记一句固定文案：底层错误消息可能带着 registry 地址，不进日志摘要。
      deps.ctx.logger?.warn?.('crwu-workbench: 后台自动更新检查失败（不影响插件运行）')
    })

  // 类型上收窄成"恰好这四个"：少一个处理器就编译不过（无漂移），对外按操作表组合。
  const handlers: Record<(typeof UPDATE_OPERATION_NAMES)[number], Operation> = {
    'update-status': async () => {
      // 只返回恢复后的当前状态：不发起任何 registry 请求。
      await ready
      return snapshot()
    },
    'update-check': async () => {
      // 用户手动「检查更新」：绕过后端成功缓存与失败退避（但绕不过 dev / 私有源限制）。
      await ready
      await checker.check({ force: true })
      return snapshot()
    },
    'update-install': async (args) => {
      // 安装不接受任何调用方控制项：目标由 Host 的授权候选决定。拒绝时不碰任何依赖。
      if (Object.keys(args).length > 0) return { ok: false, error: UPDATE_INSTALL_ARGS_REJECTED }
      await ready
      // 已经在等待重启：磁盘已经改过，重启之前不许再动 profile（设计 §9），保持主导状态。
      if (service.status().status === 'awaiting-restart') return snapshot()
      // 可选能力缺失：绝不进入安装流程（不能只靠"授权候选理论上不会放行"）。
      if (manager === undefined) return snapshot()
      await service.install()
      return snapshot()
    },
    'update-cancel': async () => {
      // 取消只认当前活动 requestId；没有活动安装时服务自己是空操作。
      await ready
      await service.cancel()
      return snapshot()
    },
  }

  const operations = handlers as OperationMap
  return { operations, ready, autoCheck }
}
