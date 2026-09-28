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
- **第二种同类失效**：`dsh-skill-filesystem` 对每个技能根只扫一层（不递归）。技能按层组织后
  （`skills/crwu/`、`skills/dws/`、`common/skills/`）必须**一层一个根**；只注册 `skills/` 会让
  `skills/crwu/` 被当成"没有 `SKILL.md` 的技能"跳过，整层静默消失；
- 本包内的路径一律**按包名解析**：
  `createRequire(baseUrl + 'package.json').resolve('dsh-crwu-workbench/package.json')` → 包目录 →
  再拼 `skills/crwu`、`skills/dws`、`common/skills`。link 开发、员工 tarball、别的布局都对；
- `>-` 折叠标量会把换行**折成空格**：多语句必须写分号，漏了就是求值期的 `SyntaxError`；
- 回归测试 `tests/unit/host-skills-patch.test.mjs` 会造一个 profile 形态的目录、把补丁里的表达式
  **真的求值一次**并断言三层都在；改回 `new URL('skills/', baseUrl)` 或漏注册一层都会立刻变红。

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

当前操作清单 = **30 个**（`ping` / `boot` / `env` / `pending` / 审核生命周期 / OSS /
iFinD 凭据四条 / 零碎操作…）。名字与数量只在 `tests/helpers/frozen-inventory.mjs` 写一份 ——
各测试各写一个裸数字的结果是：加进 iFinD 之后"9 个工具"那条断言照样绿过一次。

**协议号当前 = 15**（13：`env` 增加 `state` 统一环境模型、iFinD 凭据改由插件 Host 保管（五态 +
真实探测）、导航门禁上提到统一导航层；14：**删除 `install-prompt` 操作**；15：**iFinD 从可选改为必需项**
—— `ifind.required=true`、未通过即阻塞（双 scope）、`externalData` 不再恒为 true，
OSS 探测结果新增结构化 `errorKind` 与 `target`）。
当前操作清单 = **29 个**，见 §11.3。

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
- **同一个版本号只发一次**：分发走 npm，已发布的版本号不可覆盖，所以改了内容就必须升版本号
  —— 否则早装与重装的员工跑的不是同一份，而版本号也不再能定位问题；
- 改了任何东西（代码 / 技能 / 文档 / 配置）→ **升版本号**再发。

## 11. 常见坑速查

| 症状 | 根因 | 处理 |
|---|---|---|
| 插件装上了、面板不出现 | `slots.inject` 被包进 `ctx.effect` → 激活期 `TypeError` | 直接调用 `slots.inject`，把 `effect` 留给自有副作用 |
| 技能表里一个 crwu-* 都没有，日志干净 | 补丁里 `new URL('skills/', baseUrl)` 指向 profile 目录 | 按包名解析包目录（§3） |
| 只有某一层技能全不见（如 `dws` 层），日志干净 | 补丁只注册了上层 `skills/`，而 DSH 对每个根只扫一层 | 一层一个 `customSkillDirs` 条目（§3）；`host-skills-patch.test.mjs` 会红 |
| **升级 DSH 后插件装上了、界面里什么都没有，启动日志干净** | **0.1.7 起 peer 是硬门禁**：`peerDependencies` 的 `@deepseek-ai/dsh*` 与 `getDshRuntimeVersion()` 不匹配 → 整个 bundle 被当作不可读**跳过**，记进 `skippedBundles` | peer 必须覆盖**每一条我们支持的 DSH 线**，一条线一个 `^` 区间用 `\|\|` 并列（本包写 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`）；**加线之前先把两条线的 `@deepseek-ai/dsh-*` tarball 逐文件 diff 过**，只改区间不做比对等于赌。应急时用 profile 的 `compatibility.json` 精确豁免。判据是 peer，**不是** `engines.dsh` |
| 插件管理器弹「`dsh-crwu-workbench@0.0.13` 与 DSH `0.2.0-rc.1` 不兼容（要求 …），请安装与当前 DSH 兼容的插件版本」，或装上了却被禁用 | `^0.1.7-rc.2` 的语义是 `>=0.1.7-rc.2 <0.2.0-0`，**不含** `0.2.0-rc.1`；而 Windows 那台机器已经升到 DSH 0.2.0-rc.1（本机 macOS 桌面端还是 0.1.7-rc.2，所以本机看不出来） | 与上一条同一个修法（加一条 `\|\| ^0.2.0-rc.1`）。**别用 `>=0.1.7-rc.2 <0.3.0` 图省事** —— 会顺带放行没验证过的 0.3 线。0.1.7-rc.2 → 0.2.0-rc.1 的逐包比对结论：7 个 peer 里 5 个字节相同，`dsh-client-ui-sidebar` 只多 1 行埋点、`dsh-client-ui-layout` 只多一段 Windows 标题栏 CSS |
| 加宽 peer 之后，`npm install`（新鲜解析，没有 lock）在**本仓自己**报 `ERESOLVE`：`peer @deepseek-ai/dsh-fs@0.2.0-rc.1 from @deepseek-ai/dsh-skill-filesystem@0.2.0-rc.1` 撞上 devDep 的 `0.1.7-rc.2` | npm 的 peer 自动安装会为「只有 peer、树里没有具体实例」的包去解析**最新**匹配版本，而新线里有些包把 `peerDependencies` 写成**精确版本** | 把**全部 7 个 peer** 也写进 `devDependencies`（哪怕并不 import）：树里有了实例，npm 就钉在我们开发所对的那条线上。**接收方不受影响** —— profile 的 pnpm 配了 `autoInstallPeers: false`，`@deepseek-ai/dsh-*` 从来不由包管理器安装（DSH 运行时自己提供）。`host-package.test.mjs` 那条真装 tarball 的回归会拦住这个 |
| 所有命令都失败，报 `shell.execute is not a function`（或 `run is not a function`） | 0.1.7 的 shell 契约变更：`ShellExecutor.run(spec)` → `execute(spec)` + 句柄的 `result()` | 改 `src/host/shell/run.ts`；**测试替身也要一起改**，否则单测里每个 shell 调用都会静默变成「执行失败」 |
| 想让员工零安装（把 `crwu`/`dws`/`ossutil` 放进插件 `bin/`，指望 DSH 挂上 PATH） | **DSH 没有这个机制**：`dsh-package-manifest` 不认 `bin` 字段、`dsh-bash-local` 的 `Config` 无 env/PATH、`dsh-shell-env` 只收 `DSH_*` 键（前缀校验抛错）、`.env` 明确拒绝 `PATH` | 插件按平台自己解析包内绝对路径（`src/host/platform/bin-dir.ts`）；**再加一条 export 到 PATH**（见下条） |
| 审核子代理里 `dws: command not found`，而插件自己的调用正常（**2026-09-25 前的旧症状**） | 那时审核子代理要自己拼命令行，而它跑的是 **DSH shell 的 PATH**（实测 `/usr/bin:/bin:/usr/sbin:/sbin`） | **不要再用「给用户 export PATH」这条路**（那等于把执行世界的要求推给员工，还把沙箱/审批绕开了）。现在自研审核链路只走结构化 Tool，命令由插件用**包内绝对路径**经 `ctx.shell` 发出 —— 见 §12 |
| 本机 `bin/` 里明明有二进制，员工装上却没有 | `npm pack` **静默丢弃符号链接**（相对/绝对都不进 tarball，只有真实文件会） | 一律落真实文件；`assert-pack` 在本地装配了 `bin/` 时逐个断言真在 tarball 里 |
| `make plugin-pack` 打出来的包缺自带二进制 | `plugin-bin` 没跑，或并列 prerequisites 在 `make -j` 下并行、门禁跑在了装配之前 | `plugin-pack` 用配方**显式**依次跑 `plugin-bin` → `plugin-check` → `npm pack`；`pack:assert` 会逐个断言 |
| 有人想把只读分发桶加回来（环境清单 / 安装说明 / 插件 TGZ） | 那四个用途都让员工机器的行为依赖一个**地址谁都能换**的远端对象 | 别加。二进制随包自带、清单内置、插件走 npm；`host-yaml-config.test.mjs` 有一条「只读整段不存在」的断言盯着 |
| 包是新的，面板版本徽章还是上一版 | `PLUGIN_VERSION`（`src/host/consts.ts`）没跟着 `version:set` 走 | `version:set` / `version:check` 现在都管这一份；`host-package.test.mjs` 有 `ping.rev === pkg-<version>` 兜底 |
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
| 要在验收脚本里收/放侧栏（量 56px 轨道） | 侧栏不是插件画的，没有自己的类名可用 | 点 DSH 自带的 `button[aria-label="收起侧边栏"]` / `"打开侧边栏"`（来自 DSH 的 zh-CN 语言包），量完必须展开还原 |
| 验收脚本从整页文本里正则捞流水号，捞到了**氚云待审核**的号 | 讨论会话名是「报告讨论 · <流水号>」，左侧会话列表里就带着流水号 | 按**表格行**取（`tbody tr td:first-child`），不要扫整页；同理，命中断言也要看结果行，否则会被那条同名会话满足 |
| 想在插件面板里内嵌 DSH 原生对话 | `main` 槽位只有保留键 `conversation` 有会话绑定；客户端产物只能 `require('react')`，装不进 `ui-chat`；右栏是资源标签页、没有对话类型 | 自绘外壳 + 挂**真实会话**：`services.sessions` 的 `create/open/binding/list`（见下条），对话正文按会话事件流自己渲染 |
| 自绘面板里读会话事件流总是空 | 会话的**事件窗口只对当前会话打开**（stage 语义），而且绑定与历史是**异步**就绪的 | 绑定/发问前调 `sessions.open(id)`（只切会话选中，**不动主面板**）；读一次 + 挂订阅不够 —— 再加一路 1.2s 轮询（引用比较，没变化不重渲染）；`create` 不支持标题，建完要 `rename`，会话名就是复用凭据 |
| 事件映射一条都匹配不上（面板空着，控制台也不报错） | 会话事件是**信封 + data**：`{type, seq, time, data:{…}}`，字段在 `data` 里，不在顶层 | 先取 `event.data` 再读 `content/source/message/name`；**单测样本抄真实事件**（真机探针打印一条即可），想当然的平铺样本会让单测全绿而真机全空 |
| **Windows 上环境页/按钮报 `ParserError`、`意外的标记`，macOS 全绿** | 有调用点**绕过**了中央适配器自己拼命令（模板以 `` `${shellQuote(` `` 开头、`argv.map(…).join(' ')`、`cmd /c …`） | 所有经 `ctx.shell` 的命令只从 `src/host/platform/shell.ts` 生成；`host-platform-shell.test.mjs` 有两条静态门禁盯着（一条历史守卫在 `host-shell-fs.test.mjs`）。新增调用点先看这两处 |
| 命令返回 0，但目录其实没建出来 / 文件其实没删掉 | 只信退出码 | `ensureDirectory` / `removeFileIfExists` 会用 `ctx.fs.stat` **回读后置条件**；只有「目标已是我们要的状态」才算成功。测试替身必须模拟 shell 副作用（`tests/helpers/shell-effects.mjs`），否则替身会造出「命令成功但文件系统没变」的假机器 |
| Windows 上案例名/目录名变成一整条路径 | `path.split('/')`（Windows 分隔符是 `\`） | 用 `shared/utils/local-path.ts` 的 `basenameLocalPath` / `joinLocalPath`；跨端拼接也走它 |
| `C:\` 被裁成 `C:`（盘符相对路径），或 UNC 根被裁坏 | `replace(/[\\/]+$/, '')` | 用 `trimTrailingSeparators`（保留 `/`、`C:\`、`\\server\` 这些根本身） |
| Windows 上说「凭据权限已收紧到 0600」 | `chmodOk: boolean`：Windows 没有 `chmod`，跳过之后只能是 `true` | 协议 17 起用结构化 `permission`（`verified` / `inherited` / `failed` + `mechanism`）；Windows 报 `inherited / windows-acl`，界面文案由 `features/environment/credential-permission.ts` 决定 |
| 装上 tarball 时 `prepare` 报找不到 `tsdown`，或项目路径被拆成两截 | `spawnSync('tsdown', { shell: true })`：一过 shell，路径里的空格与单引号就被第二套规则改写 | 用 `scripts/lib/cli-entry.mjs` 解析 JS 入口 + `process.execPath` 执行，**不传 `shell`**；`host-prepare-script.test.mjs` 会在带空格与单引号的目录里真构建一次 |
| 加了 DSH 兼容线，装到真机上却被禁用 | 只写了「读区间字符串」的单测 | `npm run compat:dsh`：干净工程里真的装两条线的完整 peer 集 + `npm pack` 的 tarball，再调 DSH 自己的 `evaluatePluginCompatibility()` 断言不 skip/disable，并用该版本类型跑 tsc |
| 审核根预检在 Windows 上直接失败，错误里出现 `bash` | 预检提示词写死了「用 bash 执行 `pwd`」 | 预检由 `auditRootProbe(platform)` 按平台生成（Windows `Get-Location` / POSIX `pwd`）；`host-audit-root.test.mjs` 断言两个平台都不出现 bash |
| **发布 job 里「故意跑失败」的断言把整条流水线判红** | GitHub 的 pwsh 壳用脚本末尾的 `$LASTEXITCODE` 当步骤退出码；`Write-Host` 不会把它重置成 0 | 「存退出码 → 断言 → 末尾显式 `exit 0`」；`tests/unit/host-ci-workflows.test.mjs` 用 yaml 解析两个工作流，凡是引用 `$LASTEXITCODE` 的 `run` 块都必须以 `exit` 收尾（已证伪） |
| 权限收紧「成功」但模式没生效 | 只看了 `chmod` 的退出码；部分文件系统（网络盘、虚拟化挂载）会静默忽略 chmod | `enforceCredentialPermission` 收紧后**回读模式位**（`readFileModeCommand`：GNU `stat -c %a` / BSD `stat -f %Lp`），对不上即 `failed`；`verified` 只能由观察到的 `600` 支撑 |
| `Access denied` 被回报成「删除成功 / 目录已建好」 | 把 `fs.stat` 的**异常**折叠成「不存在」 | `case-files.ts` 的 `probePath` 是三态（存在 / 不存在 / 查不出来），「查不出来」按基础设施失败上报；只把 `undefined` 当不存在 |
| 审核子代理「重新定位/搜索报告」：自己发现表单、列记录、翻案例目录 | 交接不完整：启动只给 objectId/seqNo/project，而记录接口要 `schemaCode` | Host 先解析表单 code（实例级 `H3yunFormResolver`，只发现一次、并发共享），再用 `crwu_audit_case_bootstrap` 按精确 objectId 取一次数落成 `输入快照/`；`schemaCode` 不进任何 Tool 参数（`host-tools.test.mjs` 逐字断言） |
| 新报告点「AI 审核」必失败：`输入快照交接失败（input）：案例目录不存在或不是目录：<工作空间>/<流水号>`（审过的报告却好好的） | `<工作空间>/<流水号>` **谁都没建**：案例内每个 Tool 都过 `requireCaseDir`（要求目录已存在），而 bootstrap 又必须在子代理之前落快照 —— 旧形态是子代理自己 `mkdir -p`，结构化 Tool 化之后那条路没了，于是只有目录已存在的（审过的）报告能再发起 | `audit-start` 在 bootstrap **之前**由 Host 建目录（`tools/case-files.ts` 的 `ensureDirectory`，`mkdir -p`，workdir = 工作空间），失败就在创建子代理之前报 `创建案例目录失败：<路径>（原因）`；`host-audit-lifecycle.test.mjs` 用 trace 钉死「mkdir → bootstrap → start」的次序 |
| 技能脚本报缺 `openpyxl` / 结果不可信 | 用了系统 `python3`：它不是审核运行时 | 只用 `load_workspace_dependencies` 返回的 DSH Python（实例级解析、只缓存成功）；审核启动解析不出来就不建子代理；技能正文禁止裸解释器名字与静默降级 |
| 环境自检里 packaged 三件套又「未安装」 | 拿 PATH 当判据（Finder 启动的桌面端 PATH 只有 `/usr/bin:/bin`） | packageIntegrity 只认包内 `bin/<平台>/` 与 `bin/manifest.json`（比对 size），**不** `command -v`、**不**回退 PATH、**不**跑 `dws version`（会生成 `.dws/` 残留）；缺了就说「插件包不完整/平台不受支持」 |
| 自检里出现「未安装 python3」 | 把系统解释器当依赖 | 环境页的 ③ 层是「DSH 脚本运行时」：拿不到就报 capability gap，不检查裸 `python3`、也不接受 `/usr/bin/python3` |
| 讨论会话里模型去 `ls`/`find` 翻本机目录、并把材料下到 `cases/<流水号>`（错的） | 提示词只写了「不得读本地文件」，却**没给唯一允许的目录** → 模型自己猜 | 两条讨论提示词都注入 `fetchRules()`：唯一案例目录（`<工作空间>/<流水号>`，与审核链路共用 `caseDirOf()`）+ 用 `crwu_h3yun_file_get` 逐件重下 + 禁止 `ls`/`find`/`grep` 扫本机；本机路径只允许出现这一条（测试按正则抽出全部路径去重断言） |
| 「讨论会话里工具调不动」的错觉 | 实测工具是通的（`crwu_audit_capabilities` 返回 8 个 available、附件都下回来了），真正在动的是并行的 `bash`/`read` 翻目录 | 先读真实会话记录再动手：`~/.dsh/sessions/<工作空间>/<会话>/session.v4.jsonl.zstd` 是**多帧 zstd**（逐帧 `zstdDecompressSync` 才解得全，`createZstdDecompress` 只给第一帧） |
| 点「与 DeepSeek 讨论报告」/「复核报告」**跳不到对应的会话**（点下去什么都不发生，也不报错） | 客户端 `sessions` 服务上**没有** `open()`（`ClientSessions` 只有 retain/using/binding/create…）= 早先写的 `sessions?.open?.(id)` 被可选链吞成静默 no-op | 跳到会话只有一条路：`uiWorkspace.openSession(id)`（内部 `replaceMain(…, 'reveal')`）；`discussionPortOf` 里**不许**凭空发明服务上没有的方法，`DiscussionPort` 只放真实的四个动词 |
| 讨论会话「建不出新对话」/ 每次都新建一条 | 会话 face 取得不对：`binding(id)` 只对**已被 retain** 的会话有值，刚 `create()` 的还没有 → rename 静默跳过、kickoff prompt 发不出去 | 用 `sessions.using(id, {source}, (ref) => ref.binding.session.rename/prompt)`；`binding` 只作旧宿主退路。改名失败要如实报（`aiRenameFailed`） |
| 客户端适配器把服务方法「取出来再调」后第一个调用就 `TypeError` | `ClientSessions.create/using/binding` 都依赖 `this`（`this.manager` / `this.scopes`） | 适配器里一律 `svc.create(...)` 经接收者调用；也不要 `{ ...sessions }`（方法在原型上，展开只剩字段） |
| 安装提示词还让 agent 手工跑 `crwu h3yun session login` / `dws auth login` | 旧文案把「本机零安装」只做了一半：二进制随包了，但登录仍交给 agent 拼命令行 | 改成在面板 ③ 登录认证 里点按钮（`install-prompt.ts` + `install/INSTALL-PROMPT.md`），`host-install-prompt.test.mjs` 里有一条「不许出现可直接照抄的登录命令」 |
| 想「顺手」把插件 `bin/<平台>/` 挂进用户 shell PATH（或往 `~/bin` 拷副本） | 那会让「手工拼命令行」看起来可用，绕开沙箱/审批；插件升级后该路径还可能失效 | **不要这么做**。插件用包内绝对路径启动；`~/.zshrc` 里那条 PATH 注入已按此口径删除，并留了「为什么不要再加回来」的注释 |
| 审核子代理自己去 `which crwu` / `command -v dws` / `find … ossutil` | 提示词里写着「命令在哪」，或某个 Tool 不可见时它自然去找退路 | 审核链路只给结构化 Tool；插件在**创建子代理之前**做确定性能力门禁（`host/audit/preflight.ts`），缺 Tool 直接失败并点名 |
| 某个 Tool 在根 Agent 可见、在**子代理**却不可见 | 子代理是新的 scope，预设/委托运行时可以再加一层 restriction | 子代理发布后按**它自己的 scope** 复查（`missingAuditTools(ctx, childAgent)`），被收窄就立刻停掉该子会话并失败 |
| `ctx.tools.get(name, agent)` 老是返回 undefined | scope 传错了：DSH 的 scoped 路由 key **就是 agent 对象**（`scopeTarget(base, exec.agent)`），不是 `agent.ctx` | 传 Agent 对象本身；`agent.ctx` 只用于「优先用调用者的 Context 执行 shell」 |
| Tool 的输出 schema 校验总是失败 | `defineTool` 的 schema DSL **没有 `required: [...]` 数组**：必填是**每个属性上的 `required: true`**；也不支持 `type: ['integer','null']` | 见 `src/host/tools/*.ts` 的写法；`type` 只允许单一类型，联合用 `oneOf` |
| shell 取消不生效，`exec.signal` 像是被丢掉 | `runShell` 直到 2026-09-25 才接收 `signal` | Tool 把 `exec.signal` 传进 `runShell` → `ShellExecRequest.signal`；`ShellResult.aborted` 单独一位，别和 `error`（基础设施故障）混用 |
| 审批拒绝被报成「沙箱不可用」 | DSH 的三类失败文案不同：审批是 `approval / rejected / cancelled`，基础设施是 spawn/服务缺失 | `src/host/tools/outcome.ts` 的 `APPROVAL_FAILURE` 一处收口；`classifyRun` 先看 `aborted`，再看审批，最后才是退出码 |
| `assert-pack` 说通过，员工装到的二进制却是坏的 | 旧判据只看「文件在不在、非不空」—— 内容无关 | `bin/manifest.json` 记**最终文件**的 size + sha256，`sync-binaries --check` 与 `assert-pack --strict` 都按清单重算 |
| 干净发布机上打出来的包没有 `bin/` | `bin/` 是 gitignore 的构建产物，发布作业自己没装配 | `release.yml` 先跑 `binaries` job（macOS 交叉编译 + 装配 + 自检），artifact 交给发布 job；发布作业跑 `pack:assert:strict`，缺一个平台/工具/manifest 就红 |
| 悬停操作列的「AI 审核 / 重新审核」时整个按钮**全黑** | 选择器特异性 + 顺序：基础 `.crwu-audit-btn` 是 (0,1,0)，§20 迁移覆盖层把它写在样式表**最后**；单类变体 `.crwu-audit-btn-primary` 也是 (0,1,0) → 变体底色与字色被基础规则吃掉（主按钮看起来就是普通按钮），而变体那条 `:hover` (0,3,0) 反倒生效 —— 深底 + 深字 | 变体改用**双类** `.crwu-audit-btn.crwu-audit-btn-primary`（(0,2,0)）把顺序依赖去掉；hover 的选择器组里带上基础按钮的 `:hover:not(:disabled)`；hover 里**不要**写 `opacity`（会盖掉 `:disabled` 的 0.45）。分辨"是色值不对还是规则没生效"直接用 CSSOM：遍历 `document.styleSheets` + `element.matches(sel)`，按顺序打印所有命中该元素的 `background/color` 声明（`getComputedStyle` 只看结果，看不出谁赢了） |
| 改了 `~/.dsh/settings.yaml` 的 `ui-theme.preference` 来验另一套主题，之后文件被改回去/改不回来 | 正在跑的 profile 进程会把内存里的主题偏好**回写**这个文档；两个实例（用户 `web` + 自测 profile）同时活着时更乱 | 验主题时**先停掉会回写的实例**再改文件；验完按备份逐字还原（`diff` 确认），最后重启一个实例读回用户原值。主题是 Host 侧设置（`~/.dsh/settings.yaml` 的 `ui-theme`），**不是**浏览器 localStorage，也不是 `prefers-color-scheme` |
| 往页面里注入探针按钮量颜色，量出来全是 `rgba(0,0,0,0)` + 继承色 | 探针挂在 `document.body` 上，而 `--crwu-*` token 定义在**面板子树**（`.crwu-audit-root` / `.crwu-audit-surface`）里；token 取不到 → 每条 `var()` 声明都失效、退化成透明/继承（几何类声明照旧生效，所以"看起来像样式没加载"） | 探针必须挂进**真实的面板节点内部**（如 `.crwu-audit-td-action .crwu-audit-row-actions`），要浮在角落再给 `position: fixed`（自定义属性按 DOM 继承，与布局无关）；量颜色时把**邻近的真实按钮一起读**，能立刻发现"三个按钮全透明"这种整体失效 |
| 深色主题下工作台还是浅色（或反之） | 拿 `@media (prefers-color-scheme: dark)` 当判据 —— 那跟的是**操作系统**，不是用户在 Harness 里选的偏好 | DSH 的主题插件把解析后的明暗写到 **`body[data-ds-dark-theme]`**；在 §19 里用 `body[data-ds-dark-theme] .crwu-audit-root { --crwu-…: … }` 覆盖同名 token，规则与组件一份都不用改 |
| 「样式里出现硬编码颜色」的红条报在一个根本没写颜色的地方 | 单测是**先把 §19「工作台 Design Token」整块剔除**再扫 `#hex` / `rgb(` / `hsl(`；那块靠 `/* ═` 分隔线结束 | 新的字面量色值只能加进 §19 那一块；别在别处补 `#hex`，也别动 §19 的标题文字（正则按它定位） |
| 新加的类名没有样式，页面看起来"少了一块" | `WORKBENCH_CLASSES` 里加了键但样式表里没有 `.<类名>` 规则 | 有一条单测断言"每个类名常量都有一条规则"（`client-package.test.mjs`），补规则即可；新写的断言记得**注入缺陷证伪一次** |
| `oss-index` / `report-files` 等测试突然全部报「插件包不完整」 | `resolveOssutil` **删掉了 PATH 回退**（2026-09-25）：只认包内 `bin/<平台>/ossutil`，替身里的 `command -v ossutil` 回应已经不算数 | 测试的 fs 替身要让 `bundledBinaryPath(platform, 'ossutil')` 这个 key `stat` 出 `{type:'file'}`，且 `platform` 必须是 `darwin-arm64`/`win32-x64` 这类规范键（写成 `'darwin'` 会直接判成平台不受支持） |
| 环境自检突然对一台装好 Python 的机器报「未安装」/ 少一项 | 清单曾把 `crwu`/`dws`/`ossutil`（packaged）与 `python3`（runtime）混在一张 `binaries[]` 里统一按 PATH 命令探 | 清单已拆成 `packaged[]` + `runtime.python`（`crwu.env-manifest.v3`）：packaged 只 `stat` 包内文件比字节数（**不跑命令**），runtime 只认 **DSH 自带** Python（缺了报 capability gap，不是「未安装」）；`blocked` 里插件包不完整只算一项 |
| 客户端里点「复制」没反应也不报错 | `navigator.clipboard` 在非安全上下文（老宿主 / 非 https）里是 `undefined`，`writeText` 也可能 reject | `ReportPane.copySeqNo` 先判 `typeof clipboard?.writeText === 'function'`，失败就**静默不改状态**（不假装复制成功），Hover 复制图标只在行悬停/聚焦时出现 |
| 同一行里的次级控件看起来"颜色不一致" | 各自的底色被写成了不同的值（一个填充、一个透明、一个又是 Ghost） | 次级控件（刷新 / 小鲸鱼 / ••• / 复制）**只允许走 `--crwu-control*` 这一对**；单测「次级控件共用同一套中性底」盯着 |
| 鼠标移到某一行时，小鲸鱼 / ••• 的底色"消失" | 中性控件的底与 `--crwu-hover`（行悬停底）取了同一档 | `--crwu-control` 必须与 `--crwu-hover` **分得开**（浅色 `#EFF0F2` vs `#F5F6F7`、深色 `#2E2F34` vs `#222326`），且浅深两套里各写一遍 |
| 业务界面出现「昨天 / 09-20 / 3 天前」 | 有人为了"简洁"写了相对时间格式化 | 审核/复核/交付留痕**一律绝对时间**（`features/report-audit/time.ts`：`YYYY-MM-DD HH:mm`，只有日期给 `YYYY-MM-DD`，完整原值进 title / 技术详情）；只有 DSH 侧栏的会话活跃时间允许相对 |
| 抽屉里要显示「AI 发现了什么」，但客户端根本没有 issues[] | `oss-result` 的摘要只回 counts/metrics/bands，问题清单在完整 JSON 里 | 在 `auditInfoFromResult` 里**追加裁剪过的最小集**（`issues[]` / `reviewItems[]`，逐字段截断 + 封顶），并按规矩把 `WORKBENCH_PROTOCOL` +1；`ruleEvidence` / 知识库路径仍然不进这个接口 |
| 「已提未改」把已经改好的说成没改 | 只看 `overlap > 0`，或只看 `issue.flowStatus`，或只看 `inFileResolution` | 必须 **`linkedIssueIds` 非空 且 `inFileResolution === 'L-open'`**（交付规范 §6.1「复核已提出 · 被审件未落实」）→ 关联 issues → 按 issueId 去重；宁可少显示也不误报 |
| 断言「业务区不含原始 JSON」却一直假通过 | 把若干节点的文本拼起来再 `replace` —— 拼接会引入原串里没有的分隔符，替换直接失败 | 用**子树整段**做减法（`all.split(textOf(fold)).join('')`），或直接断言具体节点文本 |
| | 说"OSS 只能拿到 key，判不了版本" | `oss-index` 给自己加了 `--short-format`（那才只剩 key） | `ossutil ls` **默认就是长格式**：一次列举同时给出对象个数与每个对象的 `Size(B)` / `LastModifiedTime` / **`ETAG`**（`ossutil help ls` 的样本可查）。用 `parseLsEntries()`；**不要**再加 `--short-format` |
| | 报告业务会话里模型去读本机文件 | 上下文里塞了本地路径（案例根目录 / 本地案例目录的文件名） | **远端-only**：`fileLinesOf()` 只列氚云附件 + 云端交付件；本地那份只用于界面显示。远端取不到就**重试**，不许 fallback 本地（用户 2026-09-23 强制规则） |
| 想给某个会话单独限制工具（不给 bash/fs） | 以为 `sessions.create({agentPreset})` 能生效 | **不能**：客户端 `sessions.create()` 会重建 payload，只转发 `{workspaceId|cwd, sessionId}`，多余字段被丢掉（读 `@deepseek-ai/dsh-api-session-controller/lib/client.js` 的 `create()`）。只有宿主侧 `agents.create({meta:{agentPreset}})` + `agentPresets.mount()` 这条路能按 preset 组合建会话（建审核根会话用的就是它），且 preset 必须是磁盘上一个被发现的目录 |
| | 想在会话上挂 `conversationContextType` 之类的元数据 | DSH 的 `sessions.create` 只吃 `{workspaceId, cwd}`，会话行（`SessionSummary`）只有 `updatedAt`、没有 metadata | 用**会话名前缀**当来源标识（本仓既有的"名字即映射"），`ensureDiscussion({kind})` + `sessionsOfKind()`；不要去改会话数据库 |
| 点了 DeepSeek 直接建会话，把半个月前的审核结论当成"当前问题" | 没有做版本检查 | 先 `freshnessOf()`（`digest → version → etag → mtime → 时间退化`）；**纯时间差只给 possibly_stale**，`stale` 必须有 digest/version/etag 证据；缺原始报告要进 Limited 并如实写进上下文 |
| | 抽屉/浮层里的菜单项点了没反应（脚本里 `getByRole('button', { name })` 超时） | 菜单项挂的是 `role="menuitem"`，可访问角色不是 button | 用类名 + 文案定位（`.crwu-audit-float-item` + hasText）；`install/browser-check.mjs` 里已经踩过两次 |
| 用户报「界面颜色不对」，但自己本地看是对的 | 主题是**服务端设置**（`~/.dsh/settings.yaml` 的 `ui-theme.preference`），用户切到 dark 之后整页观感全变（主操作会从深色实心翻成近白实心） | 改配色先在**当前真实主题**下量一遍：读 `~/.dsh/settings.yaml` 或用浏览器会话里 `document.body.hasAttribute('data-ds-dark-theme')` 确认，不要默认浅色 |
| Windows 上环境页「氚云员工会话」「钉钉认证」两行一起红，报 `表达式或语句中包含意外的标记"h3yun"` / `ParserError` / `UnexpectedToken`（macOS 上一切正常） | 拼命令时按 `cmd.exe` 的规矩办事，而 **DSH 在 Windows 挂的执行器是 PowerShell**（`@deepseek-ai/dsh-pwsh-local` 把整条命令当**一个 argv 元素**交给 `pwsh -Command`）。于是在 PowerShell 里「引号包住可执行文件」是**字符串表达式**、不是命令调用，紧随其后的第一个参数就成了意外标记。同一类错还有 `chmod`（Windows 根本没有这个命令）、`rm -f`（`-f` 在 `Remove-Item` 上同时匹配 `-Force` 与 `-Filter`）、`mkdir -p`（靠参数名缩写） | ① 命令位置一律走 `shellInvoke(exe, args, platform)`（`environment/probe.ts`），它只在 Windows 补调用运算符 `&`；**参数位置**用 `shellQuote`，Windows 走 PowerShell 单引号字面量（双引号会插值 `$`）；② 平台方言跟着**同一个 `platform` 键**走，不要读 `process.platform`（否则 Windows CI 上跑 stubbed `darwin-arm64` 的用例也会被加上 `&`）；③ POSIX-only 命令按平台分支（`ifind/store.ts` / `oss/ops.ts` 已有样例）。`host-shell-fs.test.mjs` 有一条静态守卫盯着「模板以 `${shellQuote(` 开头」与「`argv.map(…shellQuote…).join(' ')`」这两种会复发的写法 |

## 11.1 环境领域模型与统一门禁（2026-09-26）

**一句话**：`allOk + blocked[]` 不再承担所有语义 —— 事实（`userSetup` / `systemHealth`）、
解释（`issues[]` 带 owner / blocking / scope / action）、结论（`status` / `capabilities` /
`passed·total`）三层分离，判据只有一份纯函数（`src/shared/environment/model.ts`）。
界面**只读** `env.state`，不再自己算结论。

为什么必须这么改（都是实测出来的自相矛盾）：

- 一个 `blocked[]` 里同时住着「员工该做的」与「员工做不了的」（包不完整 / 无系统 Python /
  改 PATH），界面只能平铺，于是员工被指去装一份插件根本不会用的解释器；
- iFinD 当时是**条件能力**，却与"氚云没登录"长得一模一样 —— 于是 2026-09-26 的产品口径把它
  改成了必需项（见 §11.1 的表格与 §11.2）；
- 顶部说「环境就绪」（`allOk`），旁边的通过率说「7/8 通过」（分母把可选项也算进去了）。

四条判据（改这块前先读，测试逐条盯着）：

| 情形 | 结论 |
| --- | --- |
| iFinD API-Key 未通过 | **阻塞**（2026-09-26 起它是必需项）：owner 按 credential→user / entitlement→admin / infrastructure→system 分派；`global` + `auditCore` + `externalData` 一起关；进必需项分母 |
| 氚云 / 钉钉 / OSS / 工作空间缺失 | 阻塞（`action-required`，owner=user） |
| 包 / 运行时 / 平台 / Tool 故障 | 阻塞（`system-blocked`，owner=system，**不派给员工**） |
| 部署配置缺 bucket | `admin-required`（owner=admin） |
| 通过率 | 只统计必需项，`passed/total` 与 `status` 永远自洽 |

**统一导航门禁**：`features/workbench/modules.ts` 的 `requiresEnvironment` / `requirement` +
`module-store.ts` 的 `navigate(target)` 是**唯一**入口（侧栏子项、报告页内跳转、环境页
「进入报告审核」、以后新增的页）。被拦时不进入目标页 → 记 `pendingTarget` → 落到 `env` →
显示「进入【目标页】前…」；检查通过后**只恢复最近一次**被拦的目标；用户中途改去别处即取消
自动恢复。**踩过的坑**：面板里那条 `envChanged` effect 的依赖一开始写的是解出来的 `env`，
两次刷新之间 `env.state` 的引用不变时它就不跑 —— 表现是「重新检查通过了、人还卡在环境页」。
依赖要用**模型对象的引用**（Host 每次应答都是新对象）。

**Host 侧另有能力门禁**（`src/host/environment/gate.ts`）：界面门禁管体验，Host 门禁管真实性与
绕过防护（同源路由是公开契约）。`audit-start` 判 `auditCore`，判据是**同一份 60s 快照**
（授权 / 换工作空间 / 存凭据 / 登录之后 `invalidate()`），**不为每个操作重跑一遍完整自检**；
拿不到快照或自检失败一律 fail closed。**停止审核与释放占用锁刻意不判门禁** —— 它们是安全出口，
环境刚坏时更要能停能放。

**两个踩过的坑（2026-09-26）**：

1. **拦截理由只能拼一层**。`environmentGate` 已经把整句算好了（iFinD 未通过时是
   「进入【报告审核】前，请先完成 iFinD API-Key 验证。」），而 `navigateModuleIn` 当时又套了一层
   通用模板，结果是「请先完成环境配置。（…请先完成 iFinD API-Key 验证。）」——
   员工第一眼看到的仍然是一句笼统的话，而"指名到项"正是这条需求要的东西。
   现在 `navigateModuleIn` 只在门禁**没给理由**时兜底。
2. **拦截说明要当场出现**。环境页原来只在 `gate === 'blocked'` **且** `gateTarget` 存在时画那条提示，
   而 `gate` 只在面板自己点过「重新检查 / 进入报告审核」之后才会变成 `blocked` ——
   于是"侧栏点子项被拦回来"这条最常走的路径上，页面**什么都不说**。
   现在 `WorkbenchPanel` 把统一导航层的 `blocked` / `pendingTarget` / `gateReason` 直接下发给
   环境页（`gate` 的优先级：界面刚点的动作 > 导航层结论），页面原样显示 `gateReason`。

### 11.2 iFinD 凭据：插件自己的状态文件（2026-09-26）

- 凭据在 `<home>/.dsh/crwu-workbench/ifind-credential.json`（原子写入 + `chmod 600` + 回读核对）；
  优先 DSH 凭据服务（`ctx.get('credentials')` 形状），当前版本没有时落文件，判断只在
  `resolveIfindStore()` 一处。**不再读 `~/.agents/skills/…/mcp_config.json`**。
- 空值 / 占位符 / 首尾空白 / 换行在**写盘之前**拒绝；明文只有 `readIfindSecret` 一个出口且只给
  Host 内部；面向界面与模型的视图**只有长度**。
- 界面上叫 **API-Key**（不是"SK"）。**每次环境校验都真的取一次数据**
  （`initialize` → `tools/list` → `tools/call`）：`ok`（认证）与 `dataVerified`（取数）是两个结论，
  认证过了但没取到数据时状态是 `unverified` + 明确的 `errorKind`，**不许显示成「已认证」**。
  面板反复刷新由 30s TTL 缓存兜住（按凭据指纹作键），「重新检查」传 `force` 绕过缓存。
  试取工具由 `pickProbeTool` 从真实 `inputSchema` 挑（只读、必填 ≤ 1、无开关参数），写/批量类不碰。
- 保存后**立刻真实探测**（同上，含取数）；失败归因**四个阶段一致**（`classifyFailure`）：
  先看 401/403 再看消息指纹。401 → `credential`、
  403 → `entitlement`、网络 / 超时 / 协议 → `infrastructure`，三者不许混。
- `describe_tool` 返回**脱敏、限深、限长**的 `inputSchema`（净化器接在 schema 出口的**每一层**上 ——
  只在最外层净化会漏掉 `properties` 嵌套里的示例值）。
- MCP `protocolVersion` = `2025-03-26`（官方 1.4.0 客户端）并**显式协商**；回不认识的版本按
  协议错误失败，不许静默假设 `2024-11-05` 永远有效。

## 12. 自研审核链路：结构化 Tool 优先（2026-09-25）

**一句话口径**：审核子代理**只**调用业务级 Tool，插件**只**经 `ctx.shell` 执行包内二进制；
链路里没有「让模型自己找命令」这条退路。

### 12.1 谁在哪一层

| 层 | 职责 | 文件 |
| --- | --- | --- |
| Tool 定义 | 模型可见的 schema、输出契约、失败分类 | `src/host/tools/{capabilities,h3yun,knowledge,oss,dingtalk}.ts` |
| 注册与生命周期 | `ctx.tools.register()` + 注销、可见性判据 | `src/host/tools/register.ts` |
| 命令构造 | `dws` argv 白名单、包内绝对路径、`ctx.shell` | `src/host/dws/run.ts`、`src/host/crwu/run.ts` |
| 纯逻辑 | 回传计划、知识库目录树寻址（可单测，不碰 IO） | `src/host/dws/{plan,knowledge-tree}.ts` |
| 门禁 | 案例目录包含、失败分类、能力预检 | `src/host/tools/{case-dir,outcome}.ts`、`src/host/audit/preflight.ts` |

### 12.2 三条不许破的边界

1. **模型不提交基础设施参数**：binary / argv / command / sandbox 模式 / bucket / 组织 / 团队空间 /
   profile / nodeId 都不在 schema 里。审核 Tool 的输入只有业务标识 + `caseDir`。
2. **命令不经模型**：`dws` 走 `runDws`（argv 前缀白名单，表外默认拒绝），`crwu` 走 `runCrwu` 且审核
   Tool 先做严格二进制解析，`ossutil` 只在 `crwu_audit_oss_publish` 里拼。
3. **提权不由模型触发**：只有本机凭据命令 + 已授权（`trustCredentials`）+ `workspaceRoot` 已知，
   插件才在请求里带 `danger-full-access`；其它一律默认沙箱。

### 12.3 怎么验

- `npm test`：`host-tools.test.mjs`（注册/schema/逃生字段/包内路径/signal/沙箱/钉钉/OSS/失败分类）、
  `host-audit-prompt.test.mjs`（提示词里只有 Tool 名，没有路径与裸命令）、
  `host-audit-lifecycle.test.mjs`（缺 Tool 或能力缺失时**不得创建子代理**）、
  `host-bin-manifest.test.mjs`（清单哈希判据）、`host-skills-guard.test.mjs`（技能侧守卫 + 证伪）。
- `npm run skills:cli-guard`：非 vendored 技能的活跃指令里不许出现裸 CLI / `which` / `command -v` /
  `export PATH=` / 包内 `bin/<平台>/`。非 DSH 宿主兼容章节必须用
  `<!-- crwu-cli-guard:legacy-compat-start/end -->` 包起来，且**自动审核主路径不得引用兼容层**。
- `npm run pack:assert:strict`：真实 tarball 里两个平台六个二进制 + `bin/manifest.json`，逐个重算哈希。

### 12.4 vendored 兼容边界（不许含糊）

`skills/dws/**` 是上游 `dingtalk-workspace-cli` 的**原样正文**，本次改造**没有**改它：
它的 `dws …` 命令是给非 DSH 宿主与人工用的，内容一致性由 `npm run dws:check` 按 provenance 守。
所以正确的说法是：**CRWU 自研自动审核链路不依赖 PATH；vendored DWS 技能仍是命令行兼容层。**
不要对外说「整个插件摆脱了 PATH」—— 那不是事实。

## 13. Windows 适配（2026-09-28）

这一节是「为什么这么写」的落点；改命令生成、本地路径、凭据权限或 CI 之前先读它。

### 13.1 三条边界各自只有一份实现

| 关注点 | 唯一实现 | 不许再出现 |
| --- | --- | --- |
| 命令方言（引用、命令位置、建目录/删除/打开/剪贴板/主目录探测/权限命令） | `src/host/platform/shell.ts` | `cmd /c …`、`SilentlyContinue`、`Start-Process`、`New-Item`/`Remove-Item`、`mkdir -p`、`rm -f`、`chmod`、`xdg-open`/`pbcopy`/`xclip`、旧 `quoteArg`（静态门禁逐条钉住） |
| 本地展示路径 | `src/shared/utils/local-path.ts` | `split('/')`、`+ '/'`、`replace(/[\\/]+$/,'')`、`startsWith(parent + '/')` |
| 凭据文件权限结论 | `src/host/platform/credential-permission.ts` | 任何形式的 `chmodOk: boolean` |

`platform` 一律**由调用方注入**（`world.platform()` / 操作参数）：业务函数里回退 `process.platform`
会让单测与真实运行使用不同方言，Windows 分支永远测不到 —— 静态门禁会红。

### 13.2 平台事实从哪来

- 插件**进程所在机器**的下标事实决定随包二进制与方言（`platform/detect.ts`）。
- shell 可能在别的执行世界（SSH / 容器）里跑 —— 那时自带二进制用不上，只能回退到那台机器的
  PATH，而**审核链路不这么干**（它是结构化 Tool + 包内绝对路径）。这一段差异写在
  `platform/bin-dir.ts` 头部。

### 13.3 CI 的三个 Windows 面

| job | 在验什么 | 为什么不能省 |
| --- | --- | --- |
| `plugin` 矩阵（`windows-latest`，job 级 `shell: bash`） | 跨平台单元/集成测试（含 `npm pack` + `install` 回归） | 覆盖依赖安装与打包形状 |
| `windows-powershell`（不设 `shell:`，runner 默认 pwsh） | 静态门禁 + 方言表格 + `tests/windows/powershell-contract.test.mjs`（把生成的命令真的交给 `pwsh -Command`）+ build/smoke + 全量 `npm test` | Git Bash 验证的是 bash 的解析，**不是 DSH 在 Windows 上的语义** |
| `release.yml` 的 `windows-binary-smoke` | 发布二进制在 Windows 上真的启动一次 + `win32-arm64` 明确被拒 | 哈希一致只证明「文件没变」，不证明「能跑」 |

`npm run compat:dsh`（CI 里在 plugin 矩阵的 Node 22 上跑）覆盖的是**安装期**的兼容判定，
与上面三个面互补：它回答「DSH 会不会加载这个包」。

### 13.4 人工验收

机器能验的部分全在 CI；「干净 Windows 用户配置装插件 → 选工作空间 → 建案例 → 跑审核 → 回传」
只能在真实 Windows 上做，清单与脱敏日志模板见
[`windows-acceptance.md`](windows-acceptance.md)。
