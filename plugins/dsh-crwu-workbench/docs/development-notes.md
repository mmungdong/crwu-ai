# 开发要点（dsh-crwu-workbench）

这份文档回答「**改动落在哪一层、为什么这么接、踩过什么坑**」。门禁口径在
`plugins/dsh-crwu-workbench/AGENTS.md`，两者冲突时以那份为准；界面与样式看
`docs/ui-design-guidelines.md`。

---

## 1. 形态与产物

- 源码只有 `src/`，由 tsdown 打成 `lib/index.js`（ESM，Host）与 `lib/client.js`（CJS，Client）。
  **`lib/` 是产物，不要手改**（`npm run build` 覆盖）；
- 交付形状由 `package.json` 的 `exports` / `files` / `dsh.client` 决定，改它们必须跑
  `npm run pack:assert`；产物加载能力由 `npm run smoke:built` 证明；
- 三条静态可查的加载契约（`pack:assert` 强制）：
  1. 客户端产物必须是 `window.__ModuleLoader__.load({ id, factory })`，且 `id` **等于包名**；
  2. 客户端产物的 `require(...)` **只允许** `react` 与 `react/jsx-runtime`；
  3. Host 产物导出 `name` / `inject` / `apply` / `Config`，`apply` 以**位置参数**接收 config。

## 2. Cordis 生命周期归属（照 DSH 自带插件抄）

| 副作用 | 正确写法 |
|---|---|
| 槽位注册 | `ctx.slots.inject(name, () => ctx.slots.register(...))` —— **直接调用，不要再包 `effect`** |
| 同源路由 | `ctx.effect(() => ctx.webServer.register(route), label)` |
| 样式 / 定时器 / 语言包 | `ctx.effect(...)` |

**为什么不能把 `slots.inject` 包进 `effect`**：Cordis 的 `effect` 对回调返回值有类型要求，
`slots.inject` 返回登记对象，会被判成 `TypeError("Invalid effect")` ——
表现是「插件装上了但面板不出现」，而且是在**激活阶段**抛错。
`tests/unit/client-package.test.mjs` 与 `npm run smoke:built` 都断言了「`inject` 必须在 effect 之外」。

## 3. bundle patch 里的 `baseUrl` 是 **profile 目录**

profile 的整棵树是「补丁层挂在 profile 的空根配置上」，所以 `cordis.patch.yml` 里 `!!js` 表达式拿到的
`baseUrl` 锚在 **profile 目录**，**不是本包目录**（`agent.cordis.yml` 里同样写法是好的，因为 preset
按文件加载 —— 两处语义不同，别互相套用）。

- 后果很隐蔽：`new URL('skills/', baseUrl)` 指向 `<profile>/skills/`（不存在），skill provider 照样
  "装配成功"，只是**静默贡献 0 个技能**；
- 本包内的路径一律**按包名解析**：
  `createRequire(baseUrl + 'package.json').resolve('dsh-crwu-workbench/package.json')` → 包目录 →
  再拼 `skills/` / `common/skills/`。link 开发、员工 tarball、别的布局都对；
- `>-` 折叠标量会把换行**折成空格**：多语句必须写分号，漏了就是求值期的 `SyntaxError`；
- 回归测试 `tests/unit/host-skills-patch.test.mjs` 会造一个 profile 形态的目录、把补丁里的表达式
  **真的求值一次**；改回 `new URL('skills/', baseUrl)` 立刻变红。

## 4. Host 与 Client 是**分开加载**的 → 协议号

客户端产物刷新页面就换新，宿主产物**只有重启 profile 才换**。不同代的表现极其费解：
界面是新版、行为是旧版（用户报过「还是挂错位置」，实际是宿主还跑着上一轮 build）。

- `src/shared/consts.ts` 的 `WORKBENCH_PROTOCOL` 是协议代数：**改跨进程契约就 +1**，
  `ping` / `boot` 都会带上它。当前 = **7**（5→6：`boot`/`ping` 多了 `version`/`buildKind`；
  6→7：`env` 多了 `me`）；
- 客户端发现 `boot.protocol !== WORKBENCH_PROTOCOL`：面板上明说「宿主插件是旧构建，请重启 web profile」，
  并把 `canDispatch` 置 false；
- 排查口诀：`env` 应答里缺字段 = 宿主是旧代。`ping.builtAt` 是**模块加载那一刻**的产物写入时间，
  与磁盘 mtime 不同就说明"你还在跑上一份，忘了重启"——它必须是常量，不能每次请求现读文件。

## 5. 沙箱与授权（员工零启动参数）

- 沙箱/审批模式来自**启动环境**：`mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，
  `policy: … === 'danger-full-access' ? 'never' : 'ask'`；
- **产品口径**：员工不改启动方式。插件按 DSH 的请求契约**逐命令声明** `sandboxPolicy`，
  且只在员工授权（`trustCredentials`）之后才提权；
- 读本机凭据的命令（`crwu h3yun …`、`dws auth status`、`dws contact user get-self`）在受限沙箱下
  会**假报"未登录"**（凭据在 macOS 钥匙串里读不到）。同一台机器同一时刻：沙箱里 false、
  带 `sandboxPolicy: danger-full-access` 时 true。所以**未授权时不许猜**，宁可说「需要授权」；
- 提权命令必须有工作目录（DSH 拒绝无工作区的提权执行）；写状态文件
  （`~/.dsh/crwu-workbench.json`）同样要带 `sandboxPolicy`，否则受限沙箱下写不进去 ——
  症状是「授权没能写入磁盘，重启后需要重新授权」。

## 6. 「我是谁」与身份口径

- 姓名来源是钉钉 CLI：`dws contact user get-self --format json` →
  `result[0].orgEmployeeModel.orgUserName` / `orgName` / `userId`（实现：
  `src/host/system/identity.ts` 的 `dwsSelf` / `readSelfDocument`）；
- 它**跟着环境自检一起取**（`env.me`），不单独开操作 —— 用户口径：「这个钉钉 cli 环境监测一遍
  就可以了，不需要每次切换页面都去调，本质就是从环境信息把这个人的信息拿到」；
- 宿主侧**只缓存成功结果**（姓名在一次登录周期里不变），失败不缓存：员工登录后刷一下就有；
- 未授权时不发这条命令（问出来的"没登录"不可信）；拿不到姓名时 `me` 是三个空串，
  界面整句不展示（见 `docs/ui-design-guidelines.md` §6.1）。

## 7. 增删一个 Host 操作的最小清单

最容易漏的是 2~4：

1. `src/host/ops/core.ts` 的操作表加一项；
2. 同一文件 `boot.ported.done` 加名字（漏了 → 「操作表 ↔ ported 声明一一对应」红）；
3. `tests/unit/host-package.test.mjs` 的 `FROZEN` 清单加名字并改数量注释（漏了 → 冻结清单红）；
4. 客户端要调用 → 门面加方法 + `OPERATION_OF`；不打算给客户端用 → 加进
   `client-rpc-facade.test.mjs` 的 `HOST_ONLY`（漏了 → 双向核对红）；
5. 补单元测试；
6. 真机上点一下（依赖 `shell` / `fs` / `subagents` / `slots` / `webServer` 或真实外部行为的，
   替身证明不了）。

当前操作清单 = **25 个**（`ping` / `boot` / `env` / `pending` / 审核生命周期 / OSS / 零碎操作…）。

## 8. 本地开发循环与两道人工关卡

用户指定的循环：**改 `src/` → `npm run build` → 装进他的 web profile → 他亲自测 → 他审代码 → 才提交**。

- 中间两道关卡不许跳过、不许替他判断；
- 提交后**不推送**，除非他明确说「推送 / 发版」；
- 重启他的 profile 会打断当前会话（agent 就跑在那个进程里），所以"重启"这一步由用户做，
  agent 的职责是 build + 确认安装 + 说明这轮改了什么；
- 独立验证用一次性 profile（`dsh --profile <名字> --from-default-profile web`），验完删掉。

## 9. 测试与验收

- 跑在 `node --test` 上：**不引入 vitest / jsdom / react-dom**。`tests/helpers/tsx-loader.mjs`
  剥类型 + 转 JSX，并把 `react` 指向一个极小替身，所以 `.tsx` 也能直接测；
- **每个新断言必须先证伪一次**（临时注入缺陷 → 确认变红 → 还原）。从没红过的断言不算证据。
  证伪脚本的还原清单必须覆盖它改过的**每一个文件**（漏过一个新建组件，就出现过"单测全绿、
  真机少东西"）；
- 反过来，**文本包含式断言**（`源码.includes("'sidebar.panellist'")`）会被同文件里别的同名字面量满足 ——
  要断言"注册发生了"就解析真正的调用实参，要断言"方法存在"就 `import` 真模块查 `typeof`；
- 界面行为只有浏览器能证明：`install/browser-check.mjs` 用系统里已装的 Edge + `playwright-core`
  （不下载 Chromium），逐阶段断言几何、计算样式、真实请求次数；它**不点「AI 审核」**；
- 等真实后端的断言一律用 `waitForFunction`（氚云十几秒、`ossutil` 几十秒都是常态）；
  瞬时加载态用 `page.route` 人为拖慢，把"有没有加载态"变成确定性断言；
- 运行产物（`*.tgz`、截图、临时 profile）不进提交。

## 10. 发版

- `npm run version:set x.y.z` + 手写 CHANGELOG 一节 + `npm run version:check`（三处一致）；
- 走 `plugin-v*` tag 发布（CI 里跑完整门禁 + `npm publish --provenance`），**不要手工 publish**；
- **同一个版本号只发一次**：分发包 URL 就是 `<包名>-<版本>.tgz`，同版本重发 = 覆盖远端对象，
  早装与重装的员工跑的不是同一份。`scripts/dist-plugin.mjs`（`make plugin-dist` 调用）按
  「没有就上传 / 内容一致就跳过 / 内容不同就拒绝」执行，空跑用 `PLUGIN_DIST_DRY_RUN=1`；
- 改了任何东西（代码 / 技能 / 文档 / 配置）→ **升版本号**再发。

## 11. 常见坑速查

| 症状 | 根因 | 处理 |
|---|---|---|
| 插件装上了、面板不出现 | `slots.inject` 被包进 `ctx.effect` → 激活期 `TypeError` | 直接调用 `slots.inject`，把 `effect` 留给自有副作用 |
| 技能表里一个 crwu-* 都没有，日志干净 | 补丁里 `new URL('skills/', baseUrl)` 指向 profile 目录 | 按包名解析包目录（§3） |
| 某个 skill 静默消失 | `SKILL.md` frontmatter 有一行没缩进 | 修缩进；`skills:check` / 契约测试盯着数量 |
| 样式被截断且不报错 | `WORKBENCH_STYLE_TEXT` 注释里出现了反引号 | 模板字符串里不许有反引号（连注释也不行） |
| 卡片没边框、底色透明 | 用了 DSH 里**不存在**的 token | 到 theme 表核对；扫硬编码色值的测试扫不出这个 |
| 长页面被裁一半 / 头部跟着滚 | 滚动容器放错（放 root 或没给 `min-height:0`） | 滚动归 `.crwu-audit-body`（设计规范 §4） |
| 「重启了但还是旧行为」 | 客户端刷新即换新，宿主只有重启才换 | 比对 `ping.builtAt` 与 `lib/index.js` 的 mtime |
| 审核子代理挂在聊天会话下 | 宿主是旧构建（按旧规则挂"当前会话"） | 重启 profile；`audit-start` 的父级必须是审核根会话 |
| 授权重启后丢失 | 状态文件写入被受限沙箱拦住（且错误被吞） | `writeText` 带 `sandboxPolicy`，失败要报出来 |
| browser-check 报「Route is already handled」 | 撤路由撤得太早，拖慢的那次请求还没回来 | 先等被拖慢的请求回来再 `unroute` |
| `getByRole('button', { name })` 取不到侧栏按钮 | 该按钮可访问名拿不到（实测 count=0） | 用 `button:has-text("…")` |
| 真机少了一块界面，单测全绿 | 证伪/还原时漏还原了新建文件 | 还原清单覆盖改过的每个文件；改完在真机复看截图 |
