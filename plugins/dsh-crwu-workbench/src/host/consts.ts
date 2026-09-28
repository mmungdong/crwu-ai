/** DSH 插件名。 */
export const PLUGIN_NAME = 'crwu-workbench'

/**
 * 包形态实际使用的 DSH 服务（**硬依赖**）。
 *
 * 只放三个：
 * - `webServer`：没有它注册不了同源端点，插件完全没意义；
 * - `shell`：没有它跑不了 `crwu` / `dws` / `ossutil`，而这是插件的全部功能；
 * - `tools`：CRWU 自研审核链路只通过结构化 Tool 交付业务能力，审核子代理看到的
 *   `crwu_*` 工具全部在 `apply()` 里 `ctx.tools.register()`。没有工具注册表，审核链就没有
 *   合规的执行入口 —— 与其静默退回裸命令，不如让插件拒绝激活。
 *   DSH 的 base bundle 已经以稳定 id `tools` 挂载了 `@deepseek-ai/dsh-tools`，所以这里
 *   只声明依赖，**不重复插入第二个实例**。
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
export const PLUGIN_INJECT = ['webServer', 'shell', 'tools']

/**
 * 包版本（与 `package.json` / `VERSION` 三处一致）。
 *
 * 为什么在代码里再放一份而不是现读 `package.json`：它是模块加载时就要定下来的常量
 * （理由同下面的 `PLUGIN_REV`），而 `import ... with { type: 'json' }` 会把整份清单塞进产物、
 * 还会让打包器的 JSON 插件成为隐式依赖。代价是升版本时要同时改这里 ——
 * `tests/unit/host-package.test.mjs` 有一条断言盯着它必须等于 `package.json` 的 version。
 */
export const PLUGIN_VERSION = '0.0.14'

/**
 * `ping` / `boot` 应答里的版本指纹，形如 `pkg-0.0.5`。
 *
 * 为什么是常量而不是现读 `package.json`：它是「我装到的是哪一版」的唯一口头依据，
 * 必须在**模块加载时**就定下来（现读文件会让「重新 build 但没重启」看起来已生效，
 * 见 AGENTS.md §7.2）。它由 `PLUGIN_VERSION` 推导，所以两处不会漂移。
 */
export const PLUGIN_REV = `pkg-${PLUGIN_VERSION}`
