/** DSH Host 入口：只导出插件协议要求的成员。 */

export { Config } from './host/config/config.ts'
export type { PluginConfig, WorkbenchConfig } from './host/config/config.ts'
export { apply } from './host/apply.ts'
export { PLUGIN_INJECT as inject, PLUGIN_NAME as name } from './host/consts.ts'
export { WORKBENCH_ROUTE as ROUTE } from './shared/consts.ts'
