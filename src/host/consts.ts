/** DSH 插件名。 */
export const PLUGIN_NAME = 'crwu-workbench'

/**
 * 包形态实际使用的 DSH 服务（**硬依赖**）。
 *
 * 只放两个：
 * - `webServer`：没有它注册不了同源端点，插件完全没意义；
 * - `shell`：没有它跑不了 `crwu` / `dws` / `ossutil`，而这是插件的全部功能。
 *
 * **故意不声明**的四个，以及理由：
 * - `fs` / `sessions` / `timer`：缺失时要能降级（例如没有 `timer` 就只是不上传看门狗轮询），
 *   声明成硬依赖会让整个插件在最小组合里拒绝激活；
 * - `agents` / `subagents`：只有「发起审核」需要它们，而**环境自检页必须在没有它们时也能渲染** ——
 *   用户正是靠那一页才能发现子代理服务没配好。所以走 `ctx.get`，调用时缺失就回一句明确的
 *   「Host subagents 服务不可用」，而不是让插件一直挂在 waiting 状态。
 *
 * 判据是「缺了它这个插件还该不该起来」：该起来 + 报错 = 可选；起不来 = 硬依赖。
 */
export const PLUGIN_INJECT = ['webServer', 'shell']
