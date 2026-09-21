import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WORKBENCH_ROUTE } from '../shared/consts.ts'
import type { WorkbenchConfig } from './config/config.ts'
import { registerRpcRoute } from './http/route.ts'
import { subscribeAuditEvents } from './audit/events.ts'
import { createCoreOperations } from './ops/core.ts'
import { createWorldFacts } from './platform/world.ts'
import { createWorkbenchState } from './state/store.ts'

/** 装配 DSH 工作台 Host 插件。 */
export function apply(ctx: Context, config: WorkbenchConfig): void {
  const state = createWorkbenchState(config)
  // 执行世界的事实（平台/主目录/会话根）按插件实例缓存：探测各要跑子进程，逐次重探太贵。
  const world = createWorldFacts(ctx)
  // 子代理事件是 ended / endReason 的唯一来源；没有它「已中断」永不出现、自动上传永不触发。
  subscribeAuditEvents(ctx, state)
  const operations = createCoreOperations(ctx, config, state, world)
  ctx.effect(() => registerRpcRoute(ctx, operations), 'crwu-workbench: rpc route')
  ctx.logger?.info?.('中瑞世联工作台 Host 半（包形态骨架）已装配 %o', {
    route: WORKBENCH_ROUTE,
    operations: Object.keys(operations).length,
  })
}
