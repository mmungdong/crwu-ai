import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WORKBENCH_ROUTE } from '../shared/consts.ts'
import type { WorkbenchConfig } from './config/config.ts'
import { registerRpcRoute } from './http/route.ts'
import { createCoreOperations } from './ops/core.ts'
import { createWorkbenchState } from './state/store.ts'

/** 装配 DSH 工作台 Host 插件。 */
export function apply(ctx: Context, config: WorkbenchConfig): void {
  const state = createWorkbenchState(config)
  const operations = createCoreOperations(ctx, config, state)
  ctx.effect(() => registerRpcRoute(ctx, operations), 'crwu-workbench: rpc route')
  ctx.logger?.info?.('中瑞世联工作台 Host 半（包形态骨架）已装配 %o', {
    route: WORKBENCH_ROUTE,
    operations: Object.keys(operations).length,
  })
}
