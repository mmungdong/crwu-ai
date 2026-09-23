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
| 只有某一层技能全不见（如 `dws` 层），日志干净 | 补丁只注册了上层 `skills/`，而 DSH 对每个根只扫一层 | 一层一个 `customSkillDirs` 条目（§3）；`host-skills-patch.test.mjs` 会红 |
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
| 悬停操作列的「AI 审核 / 重新审核」时整个按钮**全黑** | 选择器特异性 + 顺序：基础 `.crwu-audit-btn` 是 (0,1,0)，§20 迁移覆盖层把它写在样式表**最后**；单类变体 `.crwu-audit-btn-primary` 也是 (0,1,0) → 变体底色与字色被基础规则吃掉（主按钮看起来就是普通按钮），而变体那条 `:hover` (0,3,0) 反倒生效 —— 深底 + 深字 | 变体改用**双类** `.crwu-audit-btn.crwu-audit-btn-primary`（(0,2,0)）把顺序依赖去掉；hover 的选择器组里带上基础按钮的 `:hover:not(:disabled)`；hover 里**不要**写 `opacity`（会盖掉 `:disabled` 的 0.45）。分辨"是色值不对还是规则没生效"直接用 CSSOM：遍历 `document.styleSheets` + `element.matches(sel)`，按顺序打印所有命中该元素的 `background/color` 声明（`getComputedStyle` 只看结果，看不出谁赢了） |
| 改了 `~/.dsh/settings.yaml` 的 `ui-theme.preference` 来验另一套主题，之后文件被改回去/改不回来 | 正在跑的 profile 进程会把内存里的主题偏好**回写**这个文档；两个实例（用户 `web` + 自测 profile）同时活着时更乱 | 验主题时**先停掉会回写的实例**再改文件；验完按备份逐字还原（`diff` 确认），最后重启一个实例读回用户原值。主题是 Host 侧设置（`~/.dsh/settings.yaml` 的 `ui-theme`），**不是**浏览器 localStorage，也不是 `prefers-color-scheme` |
| 往页面里注入探针按钮量颜色，量出来全是 `rgba(0,0,0,0)` + 继承色 | 探针挂在 `document.body` 上，而 `--crwu-*` token 定义在**面板子树**（`.crwu-audit-root` / `.crwu-audit-surface`）里；token 取不到 → 每条 `var()` 声明都失效、退化成透明/继承（几何类声明照旧生效，所以"看起来像样式没加载"） | 探针必须挂进**真实的面板节点内部**（如 `.crwu-audit-td-action .crwu-audit-row-actions`），要浮在角落再给 `position: fixed`（自定义属性按 DOM 继承，与布局无关）；量颜色时把**邻近的真实按钮一起读**，能立刻发现"三个按钮全透明"这种整体失效 |
| 深色主题下工作台还是浅色（或反之） | 拿 `@media (prefers-color-scheme: dark)` 当判据 —— 那跟的是**操作系统**，不是用户在 Harness 里选的偏好 | DSH 的主题插件把解析后的明暗写到 **`body[data-ds-dark-theme]`**；在 §19 里用 `body[data-ds-dark-theme] .crwu-audit-root { --crwu-…: … }` 覆盖同名 token，规则与组件一份都不用改 |
| 「样式里出现硬编码颜色」的红条报在一个根本没写颜色的地方 | 单测是**先把 §19「工作台 Design Token」整块剔除**再扫 `#hex` / `rgb(` / `hsl(`；那块靠 `/* ═` 分隔线结束 | 新的字面量色值只能加进 §19 那一块；别在别处补 `#hex`，也别动 §19 的标题文字（正则按它定位） |
| 新加的类名没有样式，页面看起来"少了一块" | `WORKBENCH_CLASSES` 里加了键但样式表里没有 `.<类名>` 规则 | 有一条单测断言"每个类名常量都有一条规则"（`client-package.test.mjs`），补规则即可；新写的断言记得**注入缺陷证伪一次** |
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
