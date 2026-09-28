# dsh-crwu-workbench · 中瑞世联工作台

[![ci](https://github.com/mmungdong/crwu-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mmungdong/crwu-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-internal-lightgrey.svg)](LICENSE)

[English](README.en.md) | 中文

DeepSeek Harness（DSH）里的**审核工作台**：环境自检 → 从氚云拉「报告审核」待办 → 一次只发起一条
AI 审核子会话 → 盯住它的运行状态、可随时停止/重启 → 交付件自动上阿里云 OSS → 直接打开云端审核意见。

审核流程本体不在本仓：它由 `crwu-audit` 技能族执行（见「依赖」）。本仓只负责**发起、盯状态、交付件回传**。

源码在 `src/`，构建产物是 `lib/index.js` + `lib/client.js`，按 **DSH 包插件**（npm）分发安装。
维护规范见 [`AGENTS.md`](AGENTS.md)，完整发版步骤见
[`docs/releasing.md`](https://github.com/mmungdong/crwu-ai/blob/main/plugins/dsh-crwu-workbench/docs/releasing.md)，
迁移历史与逐项记录见 [`PORTING.md`](PORTING.md)，安全模型见 [`SECURITY.md`](SECURITY.md)。

> 本仓为**内部使用**软件，见 [`LICENSE`](LICENSE)；发现安全问题请按 [`SECURITY.md`](SECURITY.md) 私下联系维护者，不要开公开 issue。

---

## 一、只有一条形态：`src/` → `lib/` 包插件

| | |
|---|---|
| 怎么活 | `dsh plugin --profile <p> add …` 装进 profile，随 profile 启动而加载 |
| 版本号 | semver（`package.json` / `package-lock.json` / `VERSION` / `src/host/consts.ts` 同步，`CHANGELOG.md` 有对应小节，`npm run version:check` 强制） |
| 重启 DSH 后 | **还在**（这是它相对于旧动态形态的主要好处） |
| 谁能改 | 任何能跑 `dsh` CLI 的人/agent 都能独立闭环；源码改动由 CI 与 `npm run check` 把关 |
| 分发 | npm（tag → release workflow）；也支持 git 安装与 tarball |

**2026-09-20 收尾**：原先并存的动态 Cordis 形态（`legacy/`，在会话里由 agent `cordis_define` +
`cordis_run` 装配）已**随本轮删除** —— 24 个 RPC 与整个客户端面板都已移植进 `src/` 并逐项验证过，
迁移账见 [`PORTING.md`](PORTING.md)。

> 动态形态**不能**由 `lib/` 产物代替：`lib/index.js` 是 ESM 具名导出、`lib/client.js` 是
> `window.__ModuleLoader__` 工厂，都不是 DSH 动态插件需要的沙箱函数体；两者还在注册方式
> （`harness.handle` vs 同源路由）、客户端传输（`host.call` vs `fetch`）与 React 来源上不同。
> 这是**有意的**取舍：只维护一条形态，不为一条没有在用的投递路径加第二个构建目标。

### 包形态的验证清单（切换前必须跑完）

第 1~4e 条是**静态 / 本机**检查（1~3 由 `npm run pack:assert`，4 由 `tests/unit/` 下的测试，
4b 由 `npm run smoke:built`，4d / 4e 需要装一次后取页面清单或验 tarball）；第 5~7 条在真实 DSH 里做：

| # | 检查 | 怎么验 | 状态 |
|---|---|---|---|
| 1 | 客户端产物是 `window.__ModuleLoader__.load({ id, factory })` 且 id 等于包名 | `npm run pack:assert` | ✅ |
| 2 | 客户端产物只 require `react` / `react/jsx-runtime`（DSH 模块表只保证这两个） | `npm run pack:assert` | ✅ |
| 3 | Host 产物是 ESM 且导出 `apply` / `name` / `inject` | `npm run pack:assert` | ✅ |
| 4 | 25 个操作仍在注册表里（冻结清单：旧形态 24 个 + `ping`），且门面发出的操作都已登记为 ported | `tests/unit/host-package.test.mjs` | ✅ |
| 4b | **构建产物**能被加载：`lib/index.js` 真的应答 RPC、`lib/client.js` 过 `__ModuleLoader__` 并注册四个槽位 | `npm run smoke:built`（已含在 `npm run check`） | ✅ |
| 4c | 迁移等价性（旧形态的每个组件 / 槽位 / RPC 调用都有 `src` 落点） | 该测试已随旧形态退休；收尾前它一直是绿的，逐项账见 `PORTING.md` | ✅ 已退休 |
| 4d | 客户端产物**真的被 DSH 服务并登记进 web 启动清单**（`id` / `url` / `rev` / `inject`） | 装一次后取页面里的 `__DSH_BOOT__` | ✅ |
| 4e | **npm 分发路径**也能用：把 `npm pack` 的 tarball 装进干净 profile，Host 能应答、客户端产物被登记并服务 | `dsh plugin --profile tgz add ./dsh-crwu-workbench-<ver>.tgz` 后照 4d 验一遍 | ✅ |
| 5 | 面板在侧栏出现，且标签显示「中瑞世联工作台」 | `node install/browser-check.mjs --url …`（真实浏览器，见下） | ✅ |
| 6 | 环境信息页能真的探测到平台 / 包内组件 / DSH 运行时 / OSS / 氚云会话 / iFinD | `env` 操作 + 同一脚本在页面上核对 | ✅ |
| 7a | 报告页能拉到氚云待办 | `pending` 操作 + 同一脚本在页面上核对 | ✅ |
| 7b | **真的**发起一次审核能起子会话 | 在**顶层会话**里点「AI 审核」 | ⏳ 需人点 |

第 5~7 条需要装一次（下面这套已经在本机跑过，记录见下一节）：

```bash
dsh plugin --profile smoke add .     # 独立 profile，不碰 web profile
DSH_PERMISSION_MODE=danger-full-access dsh --profile smoke --port 3099 --no-open

# 第 5 / 6 / 7a 条用真实浏览器自动核对（不用下载 Chromium，用系统里的 Edge）：
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
node <仓库>/install/browser-check.mjs \
  --url 'http://127.0.0.1:3099/?token=<起 profile 时打印的 token>' \
  --playwright /tmp/pw/node_modules
```

### 真实 DSH 上验到了什么（2026-09-20，本机）

装进独立 `smoke` profile 后，经该实例的同源接口取到的真实应答（应答原文可复现）：

| 操作 | 观察到的结果 |
|---|---|
| `ping` | `{"ok":true,"rev":"pkg-0.0.1"}` —— 说明 `apply()` 在真实 DSH 里跑完并注册了同源路由 |
| `boot` | `platform=darwin-arm64`、`caseRoot=/Users/mungdong/中瑞世联工作空间`、`source=manifest-workspace` —— 真实 fs 与清单解析 |
| `env` | 事实分区照旧（`packageIntegrity` / `runtime` / `services` / `delivery` / `external`），**新增 `state`（统一环境模型）**：状态、阻塞项归属（user / admin / system）、通过率（只统计必需项）与能力开关。裸 `python3` 仍不是检查项；**iFinD 是必需项**（`required=true`，未通过即阻塞） |
| `pending` | `total: 8608`，返回真实氚云待办（项目名、复核级次、当前节点） |
| `oss-index` | 真实列举 bucket `crwu-workspace` 的 `crwu/audit` 前缀：8 个案例，每个都带 `审核意见.*.html` + `审核结果.*.json`，`truncated: false` |
| `oss-result` | 读一个真实对象（97KB）并只回摘要（2716 字节）：`projectId` / `schemaVersion 1.6` / `stage` / `summary.counts`（13 条问题）全部正确 |
| `audit-status` | 聚合到真实历史审核记录（`ended` / `endReason` 来自状态文件） |
| `oss-link` | 对真实对象签名：`https`、host 与对象路径正确（中文名按 URL 编码）、带 `OSSAccessKeyId`/`Expires`/`Signature`；越界 key 被拒。**签名 URL 本体按仓库规则不回显、不落日志** |
| `audit-stop` / `audit-release` | 没有进行中的审核时：前者明确拒绝（「当前没有正在运行的审核子会话。」），后者是空操作（`released: ""`） |
| 页面 `__DSH_BOOT__` | 含 `{"id":"dsh-crwu-workbench","url":"/plugins/??dsh-crwu-workbench/client.js&rev=…","inject":[…]}` |
| 该 bundle | 与仓库 `lib/client.js` **逐字一致**（DSH 只在末尾追加一个 `;`），`id` 正确，只 require `react` / `react/jsx-runtime`，四个槽位名都在 |

### 第 5 / 6 / 7a 条：真实浏览器自动核对

`install/browser-check.mjs` 用**真实浏览器**（系统里的 Edge，经 `playwright-core` 的 channel，
不下载 Chromium）打开装了插件的页面，点进面板逐页核对。本机实测**全过、控制台零报错**（条数以脚本输出为准）：

| 核对项 | 观察到的结果 |
|---|---|
| 侧栏分组卡 | **一张 Apple 式分组卡**常驻在**左侧栏下方、设置上方**（脚本按几何位置断言：左列 + 下半屏），工作区仍在它上方：卡头是**品牌标记 + 「中瑞世联工作台」+ 版本标签**，卡身是**三行子项** —— 报告评估（标「开发中」）/ 报告审核 / 环境信息，顺序固定。脚本按 `boundingBox` 断言**三行都落在同一张卡的范围内、自上而下排列**（这是「看起来像一个模块」的可观察判据）|
| 品牌标记 | 侧栏入口与面板头部画的是**用户给的原图描出来的矢量版**（四个色块：三块品牌红 + 一块品牌金），16px 与 22px 都清晰 |
| 版本标签 | 名字后面标出**跑的是哪一份**：`dev`（本地源码检出，琥珀色）或 `v0.0.4`（装好的包）；悬停给形态与构建时间 |
| 点进面板 | 自检期间是 loading，出结论后**通过就直接落在报告审核**；不通过停在环境信息 |
| 入口上的环境标记 | 通过 = **绿色对勾**、不通过 = 红点，颜色与自检结论一致，悬停文案给出结论 |
| 侧栏子项切换模块 | 点卡上的「报告评估」进占位说明、点「环境信息」进环境信息页；点过的子项变成选中态（浅底 + 左侧 3px 强调条）。面板里的**底部模块条已经撤掉**：全页 `.crwu-audit-module` 只有卡上那三行（脚本数出来的），面板与侧栏共用同一份模块状态 |
| 环境信息页 | 按**"是谁的事"**分四组：顶部紧凑状态卡（结论 + 通过率 + 最近检查时间 + **唯一**主动作）→ **账号连接**（一次性授权 + 氚云扫码 + 钉钉登录 / 设备码）→ **交付与外部数据**（阿里云 AK 表单 + 同花顺 iFinD **API-Key** 表单）→ **工作空间**（就绪时压成一行摘要）→ **开发者诊断**（默认收起，展开为一个可完整复制的信息面板）。员工视野里**不出现**「安装 crwu / dws / ossutil」「装 Python」「改 PATH」这些话；包内路径、清单、sha256、运行时路径、审核根会话只在开发者诊断里 |
| **未授权** | 授权是「账号连接」里的**第一行**（「同意并继续」），**不再用模态层遮住整页**；未授权时进不去报告审核（Host 侧同样拒绝），但环境页始终可进 |
| 全局环境门禁 | 所有入口（侧栏子项 / 报告页内跳转 / 环境页「进入报告审核」）走同一个 `navigateModule`：环境不通过时不进入目标页、落到环境页并显示「进入【目标页】前，请先完成环境配置」；检查通过后**只恢复最近一次被拦的目标**，用户中途改去别处就不恢复 |
| **iFinD API-Key 未通过** | **阻塞项**（2026-09-26 产品口径：iFinD 从可选能力改为必检、必通过项）。没填 / 无效 → 员工重填；无数据权益 → 找管理员；网络超时 → 稍后重试。未通过时 `global` / `auditCore` / `externalData` 三项能力一起关闭，统一导航把受保护页面拦回环境页，提示「进入【报告审核】前，请先完成 iFinD API-Key 验证」 |
| 全页面没有 `audit-start` | 除了人自己点「AI 审核」，验收脚本全程不发这个操作 |
| ① 案例根目录 | **只讲插件选定的那个目录**，不拿"当前会话"说事 —— 从哪个工作空间的会话点进来都一样（会话事实在 ⑧ 里如实展示） |
| 待审核报告页 | 画出真实氚云待办：`共 8610 条`、六列（报告名 / 流水号 / **风险等级** / 人工复核 / 氚云更新时间 / 操作）、真实项目名与流水号、**风险等级徽章 A/B/C**（A 红、B 黄）、复核级次「初审」、行内「已停止 / 已完成·已上云」徽章与「查看会话 / 审核信息 / 本机 HTML」入口；窄列不换行、整表无横向溢出 |
| AI审核结果页 | 画出 4 个真实云端案例及其 `审核意见.*.html` + `审核结果.*.json` 交付件；**这一页自己的工具条**可以按流水号查交付件（输入 → 「查找」→ 只列那一个流水号；没命中就说「OSS 上没有这个流水号的交付件」；「清空」回到全量且不重新列举 OSS；输入过程不发任何请求）|
| **「审核信息」右侧抽屉** | 点开一条真实记录：抽屉从右侧滑出（固定贴视口右边、占满高度、带遮罩），渲染出 `项目编号` / `审核时间` / `引擎版本` / `报告版本` / `阶段` / `结论` / `问题总数 13`（高 2 中 9 低 2 待确认 2 未检查 3）/ `复核状态` / `命中率` / `复核计数` / `生成时间`，**不再报「审核结果不是合法 JSON」**（第 26 轮修掉的那个缺陷，这条断言已拿还原后的旧代码证伪）；关闭后遮罩一起收掉、列表还在原处 |
| **加载态** | 翻页与「重新自检」都会出现进度条 + 正文压暗（脚本把这一次请求人为拖慢 3 秒来断言，请求回来后加载态必须收掉） |
| **翻页不重复列举 OSS** | 点「下一页」：`pending` 真的重取（第 2 页），`oss-index` 次数不变（AGENTS.md §4.4 的硬要求） |
| **切标签不重复列举 OSS** | 在「待审核报告 / AI审核结果」之间来回切 3 轮，`oss-index` 调用次数 **1 → 1**（AGENTS.md §4.4 的硬要求） |
| 切回环境信息 | 点侧栏卡上的「环境信息」仍然正常渲染，说明来回切换没有把状态弄坏 |
| 面板滚动 | 面板自己拥有滚动（正文区 `overflow:auto`，头部不随滚动）：环境信息与报告审核两页的长内容都能滚到底，横向零溢出 |
| 浏览器控制台 | **零报错** |
| 只读保证 | 全程只发出 `boot env audit-status pending oss-index`（及新增的 iFinD 只读探测 `ifind-probe`），**没有 `audit-start`** |

这个脚本本身也**证伪过**：拿它去跑一个**没装插件**的 profile，它报出唯一一条 FAIL
（「侧栏出现…入口」超时）、跳过后续依赖阶段、退出码 1，而不是崩掉 —— 所以它不是「跑起来就算过」。

**只剩第 7b 条要人点**：点下去会在**真实案例**上跑一次真实审核、往真实工作空间写产物、
并可能自动传上真实 OSS。这不是该由我替你点的事，脚本也刻意不去点它。

### 拿真实数据才看得见的两个缺陷（已修）

真实验证的价值就这两条 —— 静态检查和假数据都发现不了：

1. **「审核信息」在读真实对象时必失败**：`ossutil` v1.7.19 把 `<n>(s) elapsed` 无条件写到 **stdout**
   （没有开关能关掉，它连错误也写 stdout），而代码对 `ossutil cat` 的输出直接 `JSON.parse`，
   于是**每一个**真实案例打开「审核信息」都报「审核结果不是合法 JSON」。旧动态形态也一样中招，
   属于存量缺陷。现在用 `src/shared/utils/json.ts` 的 `parseJsonLoose`：先严格解析，失败再取
   第一个配对完整的 JSON 文档（正确处理字符串里的括号与转义，垃圾输入仍然返回 null）。
2. **「命令跑不起来」被说成「没装」**：见下面「沙箱模式」。

### 权限：不需要任何启动参数，但**首次必须授权一次**

员工侧**不需要**改启动参数（不需要 `DSH_PERMISSION_MODE`，也不需要动 profile 里的
`dsh-sandbox-policy`）。但插件要读本机凭据（氚云会话、钉钉登录态），这需要员工**点一次授权**：

> 环境信息页「账号连接」里的「同意并继续」—— 授权前进不去报告审核，插件也不可用
> （**不再用模态层遮住整页**）。

- **这是一次性授权、长期有效**：写进工作台状态文件 `~/.dsh/crwu-workbench.json` 的
  `trustCredentials`，重启 profile 后仍然生效。
- **不授权 = 插件不可用**：环境自检把它算作阻塞项（「进入报告审核」被门禁挡住），
  并且**不会**谎报「钉钉没登录」——那正是没授权时沙箱读不到钥匙串的假象。
- **授权之后才谈真假**：凭据类命令才带 `sandboxPolicy: { mode: 'danger-full-access', workspaceRoot }`
  去拿真结论（已登录 / 未登录 / 未绑定 / 已过期）。
- **最小权限**：只有确实读本机凭据的命令提权；插件包完整性核对（只 stat 包内文件）、
  `ossutil` 上传/列举、写案例目录、开浏览器等一律走 profile 的默认沙箱。
- 授权被部署的审批策略拒绝时，界面如实报「本机凭据读取被拦住」，并指回那个开关。

`DSH_PERMISSION_MODE=danger-full-access` 只在**开发自测**（§「真实验证」里那个临时 profile）才需要。

### 不需要任何 PATH 配置（2026-09-25 起，且**不要再加回来**）

`crwu` / `dws` / `ossutil` 随插件发布在包内 `bin/<平台>/`，插件用**包内绝对路径**经 `ctx.shell`
启动它们；审核子代理只调结构化 Tool，从不自己拼命令行。因此：

- **不要**把插件的 `bin/<平台>/` 目录 export 进 shell 的 PATH，**不要**往 `~/bin` 或系统目录放副本 ——
  那只会制造「模型手工拼命令行看起来可用」的假象（绕开沙箱与审批），并在插件升级后指向不存在的路径；
- **登录也由面板发起**：环境信息页「账号连接」里的「氚云登录」/「钉钉登录」按钮（首次先点
  「同意并继续」完成插件授权）。插件**不再有**「复制安装提示词」入口（2026-09-26 删除）：
  二进制随包发布、登录与密钥都在界面上填完之后，那段提示词没有运行时用途，只会把员工指去绕路。
- **iFinD 的 API-Key 也由插件 Host 自己保管**（2026-09-26；界面上一律叫 API-Key，不再叫 SK）：
  早先要求员工把 `auth_token` 写进
  `~/.agents/skills/ifind-finance-data/mcp_config.json` —— 那是**上游技能**的私有文件，既让运行时
  依赖一个随时会被改写的第三方文件，也把"交给 Agent 代填"变成唯一路径。现在 API-Key 保存在
  插件状态目录（`<home>/.dsh/crwu-workbench/ifind-credential.json`，0600），员工只在
  「交付与外部数据」里填一次（界面上叫 **API-Key**）。**每次环境校验都真的取一次 iFinD 数据**
  （`initialize` → `tools/list` → `tools/call`），取到数据才显示「已认证」；认证通过但没取到数据时
  会明确说「认证通过，但这次没有取到数据」并区分**权益 / 凭据 / 服务不可达**三种原因
  （分别对应"找管理员 / 重填 / 稍后重试"）。`describe_tool` 可以取到
  单个工具的脱敏参数 schema；MCP `protocolVersion` 跟随官方 1.4.0 客户端的 `2025-03-26` 并做显式协商。
  上游指引里的「把密钥发给 Agent」「SSL 失败用 `curl -k`」「跑 `call.py` / `call-node.js`」
  **一律不采用**。
- **环境自检也不再碰 PATH**：旧的探针（`command -v crwu|dws|python3|ossutil` + 跑 `--version`）整组删掉，
  所以「主机 PATH 里有没有这些命令」不再影响自检结论；③ 的运行时只认 **DSH 自带 Python**，
  系统 `python3` 既不是依赖也不参与判断。
- 实测（PATH 清成 `/usr/bin:/bin`，三个命令一个都查不到）：`./bin/darwin-arm64/crwu version` 与
  `./bin/darwin-arm64/ossutil --version` 照常可用；插件侧的严格解析器（`requireBundledCommand`）、
  面板用的宽松解析器（`resolveBundledCommand`）与 `resolveOssutil` 都把命令解析到包内绝对路径
  （`resolveOssutil` 已**删掉** PATH 回退，缺失时只说「插件包不完整 / 平台不受支持」）。

静态检查能挡住的是「产物形状不对」；挡不住的是「DSH 到底把 `shell` / `fs` / `subagents`
交给我了没有」—— 那是只有装一次才知道的事。

---

## 二、安装

前提：机器上有 DSH（版本对应的 `@deepseek-ai/dsh-*` 见「版本兼容」）。

```bash
dsh plugin --profile web add dsh-crwu-workbench   # 从 npm 取预构建产物，无需接收方构建授权
# 或：dsh plugin --profile web add ./dsh-crwu-workbench-<version>.tgz
# 或：dsh plugin --profile web add github:<owner>/<repo>   # 拉源码，靠 prepare 构建，pnpm ≥10 需 allowBuilds
```

自己打包（在 `crwu-ai` 仓里）：`make plugin-pack` → `dist/dsh-crwu-workbench-<version>.tgz`；
发布走 tag 触发的 npm 流程（`git tag plugin-v<version>`）。插件**从 npm 安装**
（`dsh plugin add dsh-crwu-workbench@<version>`）—— 不再往 OSS 传分发包，那个地址谁都能换。

装完**重启该 profile**（插件随 profile 启动加载）。然后：

1. 点**左侧栏底部**（设置上方）常驻的「中瑞世联工作台」；
2. 若这一页停在「环境信息」，就把上面那几项配齐：先点「同意并继续」完成插件授权，
   再在「账号连接」里点「氚云登录」（扫码）与「钉钉登录」（浏览器打不开时用设备码），
   然后到「交付与外部数据」里填**向管理员获取**的阿里云 AccessKey（iFinD API-Key 同页填写，
   是必需项，未通过会拦住受保护页面）—— `crwu` / `dws` / `ossutil` 三个命令**随插件自带**，
   不需要安装；**密钥只在这个页面上填**，不要贴进对话、也不要让 Agent 代填；
3. 要发起审核，先在**顶层会话**的会话头点「登记为子会话父级」——审核只允许挂在顶层会话下
   （只挂一层，嵌套会导致状态跟丢）。

> **技能随包发布，按层组织**：包里带三层技能 —— `skills/crwu/`（本仓自研 27 个）、
> `skills/dws/`（上游 `dingtalk-workspace-cli` vendored 的 14 个钉钉技能）、`common/skills/`
> （公共技能 `crwu-dws` / `crwu-h3yun-*`）。`cordis.patch.yml` 的 `crwu-workbench-skills` 行把
> **每一层各注册成一个技能根**（DSH 对每个根只扫一层，一层一个根）—— 装完插件就有全部技能，
> **不需要**再往 `~/.dsh/skills/` 里拷。旧的用户目录副本建议删掉：
> 插件目录的 rank 比用户目录高，留着只会造成两处漂移（`make skills-install AGENT_DIR=…` 是给
> 非 DSH 宿主用的）。分层口径与 `dws` 层的升级方式见 [`skills/README.md`](skills/README.md)。

> **权限**：不需要任何启动参数；但**首次必须授权一次**（环境信息页「账号连接」里的
> 「同意并继续」），否则插件读不到氚云会话与钉钉登录态、环境门禁会拦住它。
> 授权一次长期有效（存在本机状态文件里）。
> 详见「权限」一节。

### 更新版本

```bash
dsh plugin --profile web add dsh-crwu-workbench@<version>
```

再重启该 profile。安装目录里是预构建产物，更新就是换一份 `lib/` 与 `skills/`（含 `skills/dws/` 那一层）。

> **版本号只发一次**：分发走 npm，已发布的版本号不能覆盖 —— 改了内容就要**升版本号**再发，
> 否则早装和重装的员工会拿到「同一个版本、两份内容」。

### 更新 CRWU（自助更新，0.0.12 起）

**在哪看、怎么查**：侧栏底部工作台卡头右侧与面板头部都有那枚**版本徽标**（`dev` / `v0.0.12`）；
它本身就是更新入口。插件装载后会**静默**做一次后台检查，发现新版本时徽标变成
`v0.0.12 · 有更新`。点徽标打开更新面板，「检查更新」可以立刻再查一次（绕过缓存）。

**怎么装**：面板里点「安装更新」。安装由 DSH 的 Plugin Manager 执行，本插件不自己下载或覆盖插件目录。
安装期间面板显示**诚实的离散阶段**（正在连接更新源 / 正在下载安装包 / 正在写入插件目录 / 正在取消…），
**不显示百分比**；可以随时「取消安装」。**审核任务正在启动或运行时禁止安装**（不动 profile），
但**不禁止检查更新**。

**装完必须手动重启**：安装完成后界面会说

> CRWU v0.0.12 已安装。请完全退出并重新打开 DeepSeek Harness，使新版生效。

**macOS 注意**：关闭窗口**不等于**退出应用，请从应用菜单选择「退出」，或按 **Command-Q**；
刷新页面同样不等于重启。本插件**不会**修改、也不会替你重启 DeepSeek Harness 桌面端
（没有"立即重启"按钮，也没有静默更新）。

**0.0.10 / 0.0.11 用户（重要）**：那两个版本里**没有**这段自更新代码，所以它们**不会**自动发现
0.0.12。请先按下面这条手动装一次，之后（0.0.12 起）的稳定版本才能在界面内检查与安装：

```bash
# <profile> 换成你实际在用的 DeepSeek Harness profile 名（不要照抄）
dsh plugin --profile <profile> add dsh-crwu-workbench@0.0.12
```

装完**完全退出并重新打开** DeepSeek Harness。

**国内网络策略**：检查更新会**同时**查询 npm 官方 registry 与 npmmirror，取合法的更高稳定版本；
两个源同版本时优先展示 npmmirror（国内更可能装得上）。安装优先使用 `https://registry.npmmirror.com/`，
**镜像失败与回退由 Plugin Manager 负责**。镜像与官方 npm 之间**可能存在同步延迟** ——
这不是"没有新版本"，稍后重新检查即可；官方源已经出现更高版本时，即使镜像暂时落后也能被发现。
企业 / 私有 registry 策略照旧生效，本插件**不会**绕过它。

### 卸载

```bash
dsh plugin --profile web remove dsh-crwu-workbench
```

（旧动态形态的卸载方式 `cordis_undefine` 已随该形态退休；它本来就活不过一次 DSH 重启。）

## 三、统一 YAML 配置

[`config/crwu-workbench.yml`](config/crwu-workbench.yml) 是开发、打包与员工 TGZ 运行时的唯一配置源：

- `oss.protected` 是审核产物的私有 Bucket，匿名访问应返回 403，上传继续使用员工机器上的 OSS
  凭据，查看链接默认由 `ossutil` 生成签名 URL；
- YAML 只保存地址和行为参数，不保存 AccessKey、API-Key 或 STS Token。

> **没有 `oss.readonly`**：2026-09-25 起那个匿名只读分发桶整体下掉了（原来装环境清单、安装说明和
> 插件 TGZ）。现在二进制随插件发布在包内 `bin/<平台>/`，环境清单只有内置一份，插件从 npm 安装 ——
> 少一个远端数据源就少一条「别人能远程改你机器上的解释权」的通道。

源码开发时 Host 直接读取这份 YAML。要临时验证另一份配置，可在启动 DSH profile 前设置
`CRWU_CONFIG_FILE=/绝对路径/crwu-workbench.yml`，也可以只在开发用的 Cordis 配置里设置
`configFile`。不指定时自动寻找插件目录里的 `config/crwu-workbench.yml`。

`make plugin-pack` / `npm pack` 会先运行 `npm run config:check`，然后把同一份 YAML 原样放进 TGZ；
员工安装后 Host 自动读取包内配置。分发不再需要任何 Bucket 常量 —— 插件从 npm 装。

`workspace.caseRoot` 默认留空是有意的：由面板中选定的工作空间决定，而“必须先选工作空间”仍是
审核硬门禁。

### 审核子代理挂在哪（审核根会话）

报告审核的子会话不再挂在「你点开面板的那个会话」下面，而是统一挂到一个**审核根会话**上：

- 它建在插件选定的**工作空间**里（`cwd = 案例根目录`），是个普通顶层会话，侧栏里归在该工作空间下；
- 命名 `审核子代理根节点 · MM-DD HH:mm`，见名知义；所有审核子代理都挂在它下面，形成一棵树；
- 建的时候先跑一句 hello 预检（模型链路 + **当前平台的 shell** + 沙箱 + cwd），跑不通就不发起审核；
- 稳定优先：能用就复用；不能用（进程重启 / 换工作空间）就新建一个，旧的树留着；
- 界面位置：⑧ 运行环境信息里的「审核根会话」。

### ① 案例根目录的三条硬规则

1. **选定后就不动**：用户手动选过的路径（连同 title / id / source）整份落盘、整份恢复。
   只恢复 `workspacePath` 会让标签从「手动选择」变成「上次选择」、`canAuto` 变 false ——
   「恢复自动识别」按钮会凭空消失（用户报的「每次进来都变」就是这个）。
2. **选过的目录不在了就报错，绝不静默换一个**：`env` 的阻塞项与 `audit-start` 的门禁都会说清
   是哪一个路径没了，界面给出重选 / 恢复自动识别的出口。静默回落到清单偏好 = 产物写进别的目录。
3. **不拿当前会话说事**：卡片只读 `workspacePath` 那一个对象，不看父会话 cwd。
   会话事实（会话 cwd / 会话所属工作空间）在 ⑧ 运行环境信息里展示。
4. 写盘是读-改-写，而**读失败时一律不写**：否则一次 transient 的 stat 失败就会用只有本次补丁的
   对象覆盖别人的字段（实测把 `workspacePath` 抹掉过）。

## 四、开发工作流

### 四条命令

> 本机怎么开发、怎么在真实 DSH 上验见 [`AGENTS.md`](AGENTS.md) 第七节；完整发版流程见
> [`docs/releasing.md`](https://github.com/mmungdong/crwu-ai/blob/main/plugins/dsh-crwu-workbench/docs/releasing.md)；
> 下面只是命令速查。

| 命令 | 作用 |
|---|---|
| `npm test` | 全部测试：`tests/unit/`（配置、路由、操作表、包清单、Host 与 **Client 半**含 `.tsx`） |
| `npm run config:check` | 校验唯一 YAML 配置及两个 OSS 边界 |
| `npm run typecheck` | `tsc --noEmit`（仅 `src/`） |
| `npm run build` | tsdown 双端打包出 `lib/index.js` + `lib/client.js`（`prepare` 也走它） |
| `npm run smoke:built` | 用**真的** `lib/index.js` 走一遍同源路由、用真的 `lib/client.js` 过一遍 `__ModuleLoader__` |
| `npm run check` | 上面几条按顺序跑一遍（`version:check` → `typecheck` → `test` → `build` → `smoke:built`）—— **交付/提 PR 前跑这个** |
| `npm run version:set 0.0.2` | 同步版本号（`package.json` + `package-lock.json` 根版本 + `VERSION` + `src/host/consts.ts`） |
| `npm run version:check` | 校验版本文件、Host 版本常量与 `CHANGELOG.md` 小节一致 |
| `npm run pack:assert` | 核对 `npm pack` 真正打进去的文件清单 + 三条加载契约（发布前必跑；CI 也跑这条） |
| `npm run pack:assert:strict` | **发布严格模式**：真打一份 tarball、解包后按 `bin/manifest.json` 逐个重算两个平台六个二进制的 size/sha256 |
| `npm run bin:check` | 装配过 `bin/` 时：按清单重算**最终文件**哈希（内容变了就红，不看大小） |
| `npm run skills:cli-guard` | 非 vendored 技能的活跃指令里不许出现裸 `crwu`/`dws`/`ossutil`、`which`、`command -v`、`export PATH=`、包内 bin 路径 |

CI（`.github/workflows/ci.yml`）在 Ubuntu + Windows × Node 22/24 上跑同一组门禁 ——
`npm ci` → `version:check` → `typecheck` → `test` → `build` → `pack:assert` → `smoke:built` →
断言 `lib/` 两个入口存在且 `lib/client.js` 带 ModuleLoader 包装 ——
所以本地漏跑会被挡住。（`version:check` 与 `pack:assert` 是第 30 轮补进 CI 的：此前本地门禁有、CI 没有，「漏跑会被挡住」对这两条并不成立。）

- **改代码**：改 `src/`，跑 `npm run check`。任何编辑器 / 任何 agent 都能独立闭环。
- **让改动生效**：本机调试用 `dsh plugin --profile web add .`（改完要重启 profile）；
  正式分发走 npm（见第五节）。三条分发路径的差别只在「接收方要不要构建授权」：
  npm 装的是预构建产物、不需要；`github:` 与 tarball 走 `prepare` 构建，pnpm ≥10 需要 `allowBuilds`。

### 铁律（踩过的坑）

1. **操作名必须成对**：客户端门面调 `workbench:<op>`，Host 操作表里就必须有 `<op>`。
   `tests/unit/client-rpc-facade.test.mjs` 会**双向**核对门面与操作表；少一个的表现是点下去 404，
   而界面只显示「未知 op」，很难反查。
2. **`ported.done` / `ported.todo` 必须跟着实现走**：`boot` 返回的这两个列表就是面板的自我描述，
   曾经把没实现的 `clipboard` 列进 `done`，点「复制提示词」直接 404。测试会挡住这种漂移，
   收尾完成后 `todo` 必须为空。
3. **槽位注册不要包 `ctx.effect`**：`ctx.slots.inject(name, () => ctx.slots.register(...))` 必须直接调用。
   Cordis 的 `effect` 只接受「函数 / null / undefined」作为回调返回值，包错一层会让 `apply()` 在
   **激活阶段**抛 `Invalid effect`，表现为「插件装上了但面板不出现」。见 `AGENTS.md` §4.1.2。
4. **shell 必须走 `ctx.shell`**：不许 `node:child_process` 绕过 DSH 的沙箱与审批。
   另外「命令**没跑起来**」（沙箱后端不可用等）与「命令跑完了但结果如此」必须分开报 ——
   把前者当成「没装」，会让环境自检对一台装好了 Node/Python 的机器报「未安装」。
5. **用户可见文案逐条钉住，不许「意思差不多」地重写**：曾经手写改写安装提示词，丢掉了
   「不要试探连通性」「以清单为硬性约束」两条安全相关指令。现在由逐条断言守着。
6. **自研审核链路只走结构化 Tool**（2026-09-25 口径）：审核子代理收到的提示词里
   **不再有**插件二进制目录、`export PATH`、裸 `crwu`/`dws`/`ossutil` 命令；它只调用
   `crwu_*` 工具，由插件用**包内绝对路径**经 `ctx.shell` 执行。Tool 不可见或二进制缺失时
   在创建子代理**之前**就以 `capability gap` 失败 —— 绝不降级成「去 shell 里找命令」。
   技能侧由 `npm run skills:cli-guard` 守；`skills/dws/**` 是 vendored 兼容层，**不参与**这条链路。
7. **自带二进制按内容校验**：只检查「文件在不在、非不空」证明不了员工装到的那份是对的 ——
   解包、chmod、拷贝任何一步出错都发现不了。`bin/manifest.json` 记最终文件 size + sha256，
   `bin:check` 与 `pack:assert:strict` 都按它重算。
10. **报告由 Host 定位，模型不提交 `schemaCode`**（2026-09-25）：自动审核启动前，Host 先解析表单
    code（`H3yunFormResolver`，只发现一次、并发共享）、再用 `crwu_audit_case_bootstrap` 按精确
    `objectId` 取一次记录与附件元数据，落成 `<案例目录>/输入快照/`，把路径与 digest 写进指令。
    子代理因此**不必也不许**重新定位、列记录或翻案例目录；记录类 Tool 的参数里没有 `schemaCode`。
11. **Python 只用 DSH 自带的运行时**（2026-09-25）：技能脚本的解释器路径来自
    `load_workspace_dependencies`（实例级解析、只缓存成功、失败可在「重新自检」时重试）；
    自动审核启动前解析不出来就不创建子代理；技能正文禁止裸 `python3`、解释器查找与静默降级。
    不复制 Python 进包、不改 PATH、不做 pip 自动安装。
9. **讨论会话只吃远端资料，而且只有一条本机路径**（2026-09-25）：两条「与 DeepSeek 讨论」会话
   都在首轮注入同一段取数规则 —— 唯一的案例目录（`<工作空间>/<流水号>`，与审核链路同一个约定）、
   用 `crwu_h3yun_file_get` 逐件从远端下载、**每次新建对话都重新下载**、**禁止** `ls`/`find`/`grep`
   扫本机、不要自己建目录树。不写这段时实测模型会 `ls` + `find` 去猜目录，并把材料下到
   `cases/<流水号>`（错的）。案例目录的拼接只有一份（`shared/utils/case-dir.ts`）。
8. **跳到会话只有 `uiWorkspace.openSession` 一条路**（2026-09-25 修「点讨论/复核跳不过去」）：
   客户端 `sessions` 服务上**没有** `open()`，`sessions?.open?.(id)` 是静默 no-op；
   而会话 face（改名 / 发问）必须经 `sessions.using(id, {source}, op)`（retain）借 ——
   `binding(id)` 对「刚 `create()` 出来、还没被 retain」的会话返回 `undefined`，
   于是名字没写上、开场也没发出去（表现就是「建不出新对话」）。三条断言由
   `client-assistant.test.mjs` + `client-package.test.mjs` 守着。

---

## 五、npm 发布（包形态的正式分发）

包形态是长期维护的那一半，按 npm 包分发。仓库已配好发布链路，**不要手工 `npm publish`**：

```bash
npm run version:set 0.0.2     # 改 package.json + VERSION（并同步 lockfile 根版本）
# 在 CHANGELOG.md 加一节 `## package · 0.0.2 · <日期>`
npm run check                 # 本地门禁：version:check + typecheck + test + build + smoke:built
npm run pack:assert           # 核对真正打进 tarball 的文件清单
git commit -am "release(dsh-crwu-workbench): 0.0.2" && git push
git tag plugin-v0.0.2 && git push origin plugin-v0.0.2
```

`plugin-v*` tag 会触发仓根的 [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
（`v*` 留给仓里的 Go CLI，两条发布线分开）：先断言
**tag 与 `package.json` / `VERSION` 一致**，再跑完整门禁与产物自检，最后发布。

**当前发布方式（0.0.12 及以后）：只走 tag → GitHub Actions → CI 发布，禁止在本机手工 `npm publish`。**
推 `plugin-v0.0.12` 这类 tag 时，`release.yml` 会校验 tag 与 `package.json` / `VERSION` 一致，
再由 CI 用仓库 Secret `NPM_TOKEN` 执行 `npm publish --provenance`（provenance 来自 GitHub Actions OIDC）；
**Trusted Publishing 尚未启用**，它只是 `docs/releasing.md` §3.3 记录的未来迁移方案。
本机只允许 `npm publish --dry-run`（dry-run 不是发布）。

下面这段是 **0.0.10 初次建包时的历史记录**，只用于解释 provenance 的本机限制，
**不得**照它去发 0.0.12 或任何后续版本（那时包还不存在，才必须在本机建包）：

**首次发布（引导）必须在本机做，而且不能带 `--provenance`**（2026-09-28 实测）：
`--provenance` 只在受支持的 CI（GitHub Actions 的 OIDC）里成立，本机 provider 是 `null`，
npm 会直接以 `EUSAGE: Automatic provenance generation not supported for provider: null` 拒绝发布。
所以 `publishConfig` 里**不要**写 `provenance: true`（有测试钉住这一点），本机首发用：

```bash
npm login --registry=https://registry.npmjs.org
npm run build && npm run check && npm run pack:assert:strict
npm publish                      # 不带 --provenance
```

**当前真实工作流（0.0.12 仍在用）**：`.github/workflows/release.yml` 读 GitHub Secret
`NPM_TOKEN`（`NODE_AUTH_TOKEN`），在 tag `plugin-v<版本>` 上执行 `npm publish --provenance` ——
provenance（构建来源证明）由 GitHub Actions 的 OIDC 在 CI 里产生，**不是**本机发布。
**Trusted Publishing 目前没有启用**：它只是 `docs/releasing.md` §3.3 记录的**未来可迁移方案**，
在真的改完工作流之前，不要把"已采用无 token 发布"当成当前事实。

未来若迁移到 Trusted Publisher（npm 网页给这个包配 repo `mmungdong/crwu-ai`
+ workflow `release.yml`）；之后的版本由 CI 用 **OIDC** 发布 —— 不需要任何长期 token，
npm 会**自动**附带 provenance attestation，`NPM_TOKEN` secret 也可以删掉。
也可以在 Actions 里用 `workflow_dispatch` 跑一次 dry-run：只打包与校验，不发。

**`prepublishOnly` 会挡住不该发的包**：先 `pack:assert`（缺入口、误打 `tests/`/`install/`
一律失败），再 `check`。所以哪怕有人绕过 tag 手工发布，也过不了这两道。

**发布目标钉在官方 registry**：`publishConfig.registry = https://registry.npmjs.org`，与 CI 里
`setup-node` 的 `registry-url` 一致（`tests/unit/host-package.test.mjs` 会核对两者相同）。
不钉的话，本机 `~/.npmrc` 若指向镜像（国内开发机常见），手工 `npm publish` 会往镜像上发，
而 `--provenance` 在镜像上根本不成立 —— 一条命令同时踩两个坑。装依赖仍然走你的镜像，不受影响。

发之前可以先空跑一次，它会真的跑完 `prepublishOnly` 并打印将要发布的清单（不会上传）：

```bash
npm publish --dry-run    # 期望看到：Publishing to https://registry.npmjs.org …（dry-run）
```

### npm 分发路径也实测过

不只是「本地能装」——把 `npm pack` 出的 tarball 装进一个干净 profile，DSH 能真正加载它：

```bash
npm pack
dsh plugin --profile tgz add ./dsh-crwu-workbench-0.0.1.tgz   # 真实接收方路径：装的是 tarball，不是 link:
DSH_PERMISSION_MODE=danger-full-access dsh --profile tgz --port 3098 --no-open
```

实测结果：profile 的 `node_modules/dsh-crwu-workbench` 是一份**拷贝**（不是符号链接），
`lib/index.js` / `lib/client.js` 与仓库构建产物**逐字一致**，包里**没有 `src/`**；
`ping` → `pkg-0.0.1`、`env` → `allOk:true`、`oss-result` 读真实对象成功；
客户端产物被登记进该 profile 的 web 启动清单（`{"id":"dsh-crwu-workbench","url":"/plugins/??…"}`）
并且服务出来的字节与 `lib/client.js` 一致；随包发布的 `scripts/prepare.mjs` 在无 `src/` 时
按设计跳过构建并退出 0。

### 一个必须知道的坑：`prepare` 在 npm 安装时也会跑

npm 安装**已发布的 tarball** 时也会执行 `prepare`，而 tarball 里只有 `lib/` + 补丁 + 文档
（没有 `src/`、`tsconfig.json`、`tsdown.config.ts`）。所以：

- `prepare` 不能直接写 `tsdown`，也不能指向不随包发布的脚本；
- 构建入口是 `scripts/prepare.mjs`，它**在 `files` 里**（必须随包发布），逻辑是
  「源码在 → 构建；源码不在 → 跳过并说明」；
- 发布路径由 `prepack` → `build:lib --force` 保证真的构建，源码缺失即失败 ——
  不会发出一个没有 `lib/` 的包。

`tests/unit/host-package.test.mjs` 里有一条**真跑 `npm pack` + `npm install` + 导入**的回归测试，
专门钉这条路径：上面两个坑都是本地门禁看不出来、只有接收方装包才会炸的。

### 收件人怎么装

三条分发路径（npm / tarball / git）与安装后的操作见 **第二节「安装」**。

### 版本兼容

### 支持矩阵

| 维度 | 支持 | 说明 |
| --- | --- | --- |
| Windows | **10 / 11 x64** | DSH 在 Windows 上把整条命令作为一个 argv 元素交给 `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`；插件按 PowerShell 语义拼命令（`&` 调用运算符、单引号字面量），**不假定 `cmd.exe` 或 Git Bash**。需要 PowerShell 7（`pwsh`）。 |
| macOS / Linux | darwin-arm64 / linux-x64 | POSIX 方言；随包二进制只有 `darwin-arm64`。 |
| CPU | `win32-x64` / `darwin-arm64` | **`win32-arm64` 明确不支持**：插件如实回 capability gap，不会静默用 x64 顶上。 |
| Node.js | `^22.19.0 \|\| >=24` | CI 在 Linux / Windows 上各跑 22 与 24。 |
| DSH | `0.1.7-rc.2` 线、`0.2.0-rc.1` 线 | `npm run compat:dsh` 会**真的**在干净工程里装这两条线的完整 peer 集并调用 DSH 自己的兼容判定；`0.3.x` 不在声明范围内。 |
| 本地路径 | 盘符绝对路径、空格、中文、单引号 | 例：`C:\Users\张三\Case's Work`。 |
| UNC | `\\server\share\…` | **交给底层 DSH `fs` 解析**；解析不了时返回可读的「案例目录不可解析：…（原因）」，不生成损坏路径。尚未在真实共享上做端到端验收。 |

### Windows 故障排查

| 症状 | 先查什么 | 处置 |
| --- | --- | --- |
| 插件装上了、界面里什么都没有，启动日志干净 | 是否被 DSH 判为**不兼容**（`skippedBundles` / 插件管理器标「与 DSH `<版本>` 不兼容」并禁用） | 判据是 `peerDependencies`（**不是** `engines.dsh`）：本包写 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`。升级 DSH 后出现就先升插件；应急用 profile 的 `compatibility.json` 精确豁免。跑 `npm run compat:dsh` 复现判定 |
| 报 `表达式或语句中包含意外的标记` / `ParserError` / `UnexpectedToken` | 命令是不是以引号包住的路径开头（PowerShell 里那是字符串表达式，不是命令调用） | 升级到 0.0.14+：所有命令都由 `src/host/platform/shell.ts` 生成（Windows 上带 `&`）。若仍出现，说明有调用点绕过了适配器 —— `host-platform-shell.test.mjs` 的静态门禁会先红 |
| 报「参数名不明确」/ `mkdir` 不是内部或外部命令 | 有没有混用 POSIX 写法（`mkdir -p`、`chmod`、`rm -f`、`cmd /c …`） | 同上：这些字面量只允许出现在适配器里；静态门禁会在 PR 阶段拦住 |
| 命令「成功」了但文件其实没动 | 是否被 `-ErrorAction SilentlyContinue` 之类吞掉 | 0.0.14+ 已去掉；`case-files.ts` 还会用 `ctx.fs.stat` 回读后置条件 |
| 路径被截断、目录名变成一长串 | 是不是按 POSIX 规则拼/取本地路径 | 0.0.14+ 统一走 `shared/utils/local-path.ts`；安全判定走 `ctx.fs.check` 之外的 `fs.contains`，不用字符串前缀 |
| 二进制启动报「不是有效的 Win32 应用程序」/ 缺 DLL | 发布形态的架构是否匹配（`win32-x64` vs `win32-arm64`） | `win32-arm64` 不支持（设计如此）；`npm run bin:smoke` 会在 Windows runner 上真的启动一次发布二进制 |
| 凭据文件权限看不到「600」 | Windows 没有 POSIX 权限位、也没有 `chmod` | 界面会明说「使用当前 Windows 账户 ACL；POSIX 0600 不适用」（协议 17 的 `permission.status = inherited`）——这不是失败，也不是「已验证」 |
| 安装/`prepare` 报找不到 `tsdown` 或路径被拆坏 | 构建命令是否经过 shell | 0.0.14+ 用 `process.execPath` 直接执行 tsdown 的 JS 入口（`scripts/lib/cli-entry.mjs`），**不经过 shell**，所以路径里的空格与单引号不会被改写 |


`peerDependencies` 覆盖**两条 DSH 线**：`@deepseek-ai/dsh-*@^0.1.7-rc.2 || ^0.2.0-rc.1`（cordis `^4.0.4`）。
一条线一个 `^` 区间并列，而不是 `>=… <…` 一把梭 —— 后者会顺带放行还没验证过的 0.3 线。
DSH API 仍是 developer preview，**加一条线之前**必须把两条线的 `@deepseek-ai/dsh-*` 逐包比对过、
重新跑门禁，并在 `CHANGELOG.md` 里写明兼容到哪个 DSH 版本。

> **0.1.7 起这条是硬门禁**：DSH 会拿运行时版本与每个 `@deepseek-ai/dsh*` peer 范围比对，
> 不匹配的 bundle 会被**整包跳过**（记进 `skippedBundles`）—— 症状是「插件装上了、界面里什么都没有」，
> 而启动日志没有任何报错；插件管理器还会把这一行标成「与 DSH \<版本\> 不兼容」并禁用。
> 判据是 `peerDependencies`，不是 `engines.dsh`。注意 `^0.1.7-rc.2` = `>=0.1.7-rc.2 <0.2.0-0`，
> **不含** `0.2.0-rc.1`。

---

## 六、依赖（不在本仓）

- **技能族**：`crwu-audit` 及其资产/业务/公共子技能、`crwu-dws`、`crwu-h3yun-login` 随本插件包发布；
  `dingtalk-*`（`skills/dws/` 层）是随包 vendored 的上游技能。`ifind-finance-data`（上游技能）
  **不是本插件运行时依赖**：iFinD 取数走结构化 Tool `crwu_audit_ifind_query`，API-Key 由插件 Host
  自己保管在插件状态目录（不读技能目录里的 `mcp_config.json`）。
- **CLI**：`crwu`（审核编排）、`dws`（钉钉）、`ossutil`（OSS 上传）。
- **账号**：氚云员工会话（钉钉扫码）、钉钉认证、阿里云 OSS AccessKey、iFinD **API-Key**
  （每次环境校验都会真的取一次 iFinD 数据，取到数据才算验证通过）。
  凭据分别落在 `~/.dsh/crwu-workbench.json`、`~/.ossutilconfig`（权限 600）与
  `~/.dsh/crwu-workbench/ifind-credential.json`（权限 600），**都不进本仓**；
  它们只在环境信息页上填写，**不进对话、不由 Agent 代填**。

---

## 七、目录

```
AGENTS.md          DSH 插件架构、目录、代码风格与测试规范
SECURITY.md        安全模型：插件能碰到什么、凭据在哪、漏洞怎么报
LICENSE            内部使用授权（不对外分发）
install/INSTALL-PROMPT.md  「装插件」提示词（把插件装进别人 DSH 时发给对方 agent）
install/browser-check.mjs  真实浏览器验收（第 5 / 6 / 7a 条判据，见第一节）
scripts/sync-version.mjs   版本号一致性（npm run version:set / version:check）
scripts/assert-pack.mjs    发布产物自检（npm run pack:assert / pack:assert:strict）
scripts/sync-binaries.mjs  装配包内二进制并写 bin/manifest.json（npm run bin:check）
scripts/bin-manifest.mjs   构建产物清单的读写与哈希判据（装配与发布自检共用）
scripts/check-skill-cli-guard.mjs  非 vendored 技能的裸 CLI 静态守卫（npm run skills:cli-guard）
scripts/prepare.mjs        构建入口（prepare / prepack 用；**随包发布**，见第五节）
src/index.ts       Host 轻入口（只做导出与装配）
src/host/          Host 配置、同源路由、操作与领域模块
src/client/        Client 装配、API、组件与 feature 模块
src/shared/        Host / Client 共享的协议常量与纯工具
tests/unit/        配置、路由、操作表、包清单，以及 **Client 半**（含 .tsx）单元测试
tests/helpers/     TSX 加载器 + 注入式 React 渲染器
cordis.patch.yml   装配补丁
PORTING.md         从旧动态形态迁移过来的逐项记录（含验证账）
.github/workflows/ci.yml       push/PR 门禁：Ubuntu + Windows × Node 22/24
(仓根) .github/workflows/     ci.yml（Go + 插件）· release.yml（plugin-v* tag → 校验 + 发布 npm）
```

`npm pack` 带 `lib/` + 补丁 + 文档 + 三层技能（`skills/crwu/`、`skills/dws/`、`common/skills/`，
解包约 5.5MB（450 个文件），技能正文是大头）；`install/`、`tests/`、`scripts/`、`src/` 是仓库内部件，
不进包 —— `npm run pack:assert` 会核对这一点。

**装配过自带二进制时**（`make plugin-bin`）包里还会多 `bin/darwin-arm64/{crwu,dws,ossutil}`、
`bin/win32-x64/{crwu.exe,dws.exe,ossutil.exe}` 与 `bin/manifest.json`，形态是 **457 个文件 / 约 106MB**。
发布链路必须用 `npm run pack:assert:strict`：它会把真实 tarball 解包，按清单逐个重算六个二进制的
size 与 sha256，并拒绝 `bin/` 下任何未声明的运行残留。

DSH 不要求 TypeScript 源码集中在单个文件。`src/` 按领域拆分，构建后只暴露
`lib/index.js` 与 `lib/client.js` 两个入口。

## 许可

内部使用，**不对外分发**，见 [`LICENSE`](LICENSE)。审核意见属内部材料：云端链接默认走**签名 URL**
（带 bearer 签名，1 小时），不要改成公开读。
