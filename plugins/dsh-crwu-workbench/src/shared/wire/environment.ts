import type { EnvResult } from '../../host/core/environment/ops.ts'
import type { EnvResultView, WorkspaceView } from '../contracts/environment.ts'

/**
 * `env` 的整个信封契约：六块分区少一块、或某块字段漂移，这里就红。
 *
 * 单独一条就够 —— 环境视图的每个零件都在 `common.ts` / `report-audit.ts` 里各有一条，
 * 而这条管的是"组装起来的形状"（最容易漏的正是这一层：零件都对、信封少了半块）。
 */
export const ENV_RESULT_FROM_HOST: (env: EnvResult) => EnvResultView = (env) => env
export const WORKSPACE_VIEW_FROM_HOST: (view: WorkspaceView) => WorkspaceView = (view) => view
