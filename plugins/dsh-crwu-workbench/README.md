# dsh-crwu-workbench · 中瑞世联工作台

[![ci](https://github.com/mmungdong/crwu-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mmungdong/crwu-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-internal-lightgrey.svg)](LICENSE)

[English](README.en.md) | 中文

DeepSeek Harness（DSH）里的**审核工作台**：环境自检 → 从氚云拉「报告审核」待办 → 一次只发起一条
AI 审核子会话 → 盯住它的运行状态、可随时停止/重启 → 交付件自动上阿里云 OSS → 直接打开云端审核意见。

审核流程本体不在本仓：它由 `crwu-audit` 技能族执行（见「依赖」）。本仓只负责**发起、盯状态、交付件回传**。

源码在 `src/`，构建产物是 `lib/index.js` + `lib/client.js`，按 **DSH 包插件**（npm）分发安装。
维护规范见 [`AGENTS.md`](AGENTS.md)，迁移历史与逐项记录见 [`PORTING.md`](PORTING.md)，安全模型见 [`SECURITY.md`](SECURITY.md)。

> 本仓为**内部使用**软件，见 [`LICENSE`](LICENSE)；发现安全问题请按 [`SECURITY.md`](SECURITY.md) 私下联系维护者，不要开公开 issue。

---

## 一、只有一条形态：`src/` → `lib/` 包插件

| | |
|---|---|
| 怎么活 | `dsh plugin --profile <p> add …` 装进 profile，随 profile 启动而加载 |
| 版本号 | semver（`package.json` / `VERSION` / `CHANGELOG.md` 三处一致，`npm run version:check` 强制） |
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
| 6 | 环境自检页能真的探测到平台/二进制/OSS/氚云会话 | `env` 操作 + 同一脚本在页面上核对 | ✅ |
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
| `env` | `allOk: true`：`crwu` / `dws` / `python3` / `ossutil` 都定位到真实路径；氚云 `正常`（真实 userId 与到期时间）；钉钉 `已登录`；OSS `AK 正常`（真实 bucket 可列） |
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
不下载 Chromium）打开装了插件的页面，点进面板逐页核对。本机实测 **40 条全过、控制台零报错**：

| 核对项 | 观察到的结果 |
|---|---|
| 侧栏入口 | 「中瑞世联工作台」出现 |
| 点进面板 | 面板右上角渲染出环境指示灯；自检期间是 loading，出结论后**通过就直接落在待审核报告页** |
| 右上角指示灯 | 绿 / 红与自检结论一致，悬停文案含结论与「还差什么」 |
| 环境自检页 | 平台 `darwin-arm64`；`crwu` / `dws` / `python3` / `ossutil` 四条**通过**、带真实路径；氚云 `正常`、钉钉 `已登录`；iFinD 密钥 `已配置`（只显示长度 930）；通过率 `10/10`、OSS 回传与运行环境信息齐全 |
| ① 案例根目录 | **只讲插件选定的那个目录**，不拿"当前会话"说事 —— 从哪个工作空间的会话点进来都一样（会话事实在 ⑧ 里如实展示） |
| 待审核报告页 | 画出真实氚云待办：`共 8610 条`、六列（报告名 / 流水号 / **风险等级** / 人工复核 / 氚云更新时间 / 操作）、真实项目名与流水号、**风险等级徽章 A/B/C**（A 红、B 黄）、复核级次「初审」、行内「已停止 / 已完成·已上云」徽章与「查看会话 / 审核信息 / 本机 HTML」入口；窄列不换行、整表无横向溢出 |
| AI审核结果页 | 画出 4 个真实云端案例及其 `审核意见.*.html` + `审核结果.*.json` 交付件 |
| **「审核信息」右侧抽屉** | 点开一条真实记录：抽屉从右侧滑出（固定贴视口右边、占满高度、带遮罩），渲染出 `项目编号` / `审核时间` / `引擎版本` / `报告版本` / `阶段` / `结论` / `问题总数 13`（高 2 中 9 低 2 待确认 2 未检查 3）/ `复核状态` / `命中率` / `复核计数` / `生成时间`，**不再报「审核结果不是合法 JSON」**（第 26 轮修掉的那个缺陷，这条断言已拿还原后的旧代码证伪）；关闭后遮罩一起收掉、列表还在原处 |
| **加载态** | 翻页与「重新自检」都会出现进度条 + 正文压暗（脚本把这一次请求人为拖慢 3 秒来断言，请求回来后加载态必须收掉） |
| **翻页不重复列举 OSS** | 点「下一页」：`pending` 真的重取（第 2 页），`oss-index` 次数不变（AGENTS.md §4.4 的硬要求） |
| **切标签不重复列举 OSS** | 在「待审核报告 / AI审核结果」之间来回切 3 轮，`oss-index` 调用次数 **1 → 1**（AGENTS.md §4.4 的硬要求） |
| 切回环境自检 | 点右上角那颗灯仍然正常渲染，说明来回切换没有把状态弄坏 |
| 面板滚动 | 面板自己是滚动容器（`overflow:auto` + `height:100%`）：环境页 2628px / 报告页 2303px 的内容都能滚到底，横向零溢出 |
| 浏览器控制台 | **零报错** |
| 只读保证 | 全程只发出 `boot env install-prompt audit-status pending oss-index`，**没有 `audit-start`** |

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

### 沙箱模式：装完必须确认这一条

包形态的 shell 调用走 DSH 注入的 `ctx.shell`，**不带显式沙箱模式**，因此用的是 profile 的默认值
（`dsh-sandbox-policy` 的 `mode`，默认取环境变量 `DSH_PERMISSION_MODE`，缺省 `workspace-write`）。

在**本机**（进程本身已在沙箱内，`sandbox-exec` 无法套娃）受限模式**没有可用后端**，DSH 会按契约拒绝执行：

```text
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined. … otherwise switch the consumer to danger-full-access.
```

所以：环境自检把「命令跑不起来」如实报成 `无法探测` / `探测失败`（**不会**谎报「未安装」）；
要让工作台真的能干活，按 DSH 自己的提示把模式切到 `danger-full-access`
（`DSH_PERMISSION_MODE=danger-full-access`，或改 profile 里 `dsh-sandbox-policy` 的 `mode`）。
插件**不会**自己去申请无沙箱执行 —— 那是用户的决定，不是插件的。

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
`make plugin-dist` 会把它上传到 OSS 并打印员工侧的安装命令。

装完**重启该 profile**（插件随 profile 启动加载）。然后：

1. 打开侧栏的「中瑞世联工作台」；
2. 若这一页只显示「环境自检」，先把环境装齐：点「复制提示词」把安装清单交给 agent，
   装完 `crwu` / `dws` / `ossutil` / iFinD 密钥 / 氚云 + 钉钉登录后再回来；
3. 要发起审核，先在**顶层会话**的会话头点「登记为子会话父级」——审核只允许挂在顶层会话下
   （只挂一层，嵌套会导致状态跟丢）。

> **技能随包发布**：包里带 `skills/`（插件专属 27 个）与 `common/skills/`（公共技能 `crwu-dws` /
> `crwu-h3yun-*`），`cordis.patch.yml` 的 `crwu-workbench-skills` 行把两个目录注册成技能根 ——
> 装完插件就有全部技能，**不需要**再往 `~/.dsh/skills/` 里拷。旧的用户目录副本建议删掉：
> 插件目录的 rank 比用户目录高，留着只会造成两处漂移（`make skills-install AGENT_DIR=…` 是给
> 非 DSH 宿主用的）。

> **沙箱模式**：本机的受限模式若没有可用沙箱后端（macOS 上 `sandbox-exec` 无法套娃），
> 插件发出的所有 shell 调用都会被 DSH 按契约拒绝。这时按 DSH 的提示把模式切到
> `danger-full-access`（`DSH_PERMISSION_MODE=danger-full-access`，或改 profile 里
> `dsh-sandbox-policy` 的 `mode`）。插件**不会**自己去申请无沙箱执行 —— 那是用户的决定。
> 详见「真实验证」一节。

### 更新版本

```bash
dsh plugin --profile web add dsh-crwu-workbench@<version>
```

再重启该 profile。安装目录里是预构建产物，更新就是换一份 `lib/` 与 `skills/`。

> **版本号只发一次**：同一个版本的 tarball 不会被覆盖（`make plugin-dist` 会拒绝内容不同的同版本
> 重发），所以改了内容要**升版本号**再发 —— 否则早装和重装的员工会拿到「同一个版本、两份内容」。

### 卸载

```bash
dsh plugin --profile web remove dsh-crwu-workbench
```

（旧动态形态的卸载方式 `cordis_undefine` 已随该形态退休；它本来就活不过一次 DSH 重启。）

## 三、统一 YAML 配置

[`config/crwu-workbench.yml`](config/crwu-workbench.yml) 是开发、打包与员工 TGZ 运行时的唯一配置源：

- `oss.readonly` 是匿名只读 Bucket，保存环境清单、安装说明和员工下载的插件 TGZ；
- `oss.protected` 是审核产物的私有 Bucket，匿名访问应返回 403，上传继续使用员工机器上的 OSS
  凭据，查看链接默认由 `ossutil` 生成签名 URL；
- YAML 只保存地址和行为参数，不保存 AK、SK 或 STS Token。

源码开发时 Host 直接读取这份 YAML。要临时验证另一份配置，可在启动 DSH profile 前设置
`CRWU_CONFIG_FILE=/绝对路径/crwu-workbench.yml`，也可以只在开发用的 Cordis 配置里设置
`configFile`。不指定时自动寻找插件目录里的 `config/crwu-workbench.yml`。

`make plugin-pack` / `npm pack` 会先运行 `npm run config:check`，然后把同一份 YAML 原样放进 TGZ；
员工安装后 Host 自动读取包内配置。`make plugin-dist` 也从 `oss.readonly` 推导 `oss://` 上传目标和
员工侧 HTTPS 安装地址，Makefile 不再维护另一套 Bucket 常量。

`workspace.caseRoot` 默认留空是有意的：由面板中选定的工作空间决定，而“必须先选工作空间”仍是
审核硬门禁。

### 审核子代理挂在哪（审核根会话）

报告审核的子会话不再挂在「你点开面板的那个会话」下面，而是统一挂到一个**审核根会话**上：

- 它建在插件选定的**工作空间**里（`cwd = 案例根目录`），是个普通顶层会话，侧栏里归在该工作空间下；
- 命名 `审核子代理根节点 · MM-DD HH:mm`，见名知义；所有审核子代理都挂在它下面，形成一棵树；
- 建的时候先跑一句 hello 预检（模型链路 + bash + 沙箱 + cwd），跑不通就不发起审核；
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

> 本机怎么开发、怎么在真实 DSH 上验、怎么发版，逐步步骤都在 [`AGENTS.md`](AGENTS.md) 第七、八节；
> 下面只是命令速查。

| 命令 | 作用 |
|---|---|
| `npm test` | 全部测试：`tests/unit/`（配置、路由、操作表、包清单、Host 与 **Client 半**含 `.tsx`） |
| `npm run config:check` | 校验唯一 YAML 配置及两个 OSS 边界 |
| `npm run typecheck` | `tsc --noEmit`（仅 `src/`） |
| `npm run build` | tsdown 双端打包出 `lib/index.js` + `lib/client.js`（`prepare` 也走它） |
| `npm run smoke:built` | 用**真的** `lib/index.js` 走一遍同源路由、用真的 `lib/client.js` 过一遍 `__ModuleLoader__` |
| `npm run check` | 上面几条按顺序跑一遍（`version:check` → `typecheck` → `test` → `build` → `smoke:built`）—— **交付/提 PR 前跑这个** |
| `npm run version:set 0.0.2` | 改版本号（`package.json` + `VERSION` + lockfile 根版本） |
| `npm run version:check` | 校验 `package.json` / `VERSION` / `CHANGELOG.md` 版本一致 |
| `npm run pack:assert` | 核对 `npm pack` 真正打进去的文件清单 + 三条加载契约（发布前必跑；CI 也跑这条） |

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
**tag 与 `package.json` / `VERSION` 一致**，再跑完整门禁与产物自检，最后
`npm publish --provenance`（需要仓库 secret `NPM_TOKEN`，并附构建来源证明）。
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

`peerDependencies` 当前锁在 `@deepseek-ai/dsh-*@0.1.5-rc.2`（与已安装的 DSH 一致）。
DSH API 仍是 developer preview，升级 DSH 时**必须**同步核对这几个包、重新跑门禁，
并在 `CHANGELOG.md` 里写明兼容到哪个 DSH 版本。

---

## 六、依赖（不在本仓）

- **技能族**：`crwu-audit` 及其资产/业务/公共子技能、`crwu-dws`、`crwu-h3yun-login`、
  `dingtalk-*`、`ifind-finance-data`。由安装清单负责安装。
- **CLI**：`crwu`（审核编排）、`dws`（钉钉）、`ossutil`（OSS 上传）。
- **账号**：氚云员工会话（钉钉扫码）、钉钉认证、阿里云 OSS AccessKey、iFinD 密钥。
  凭据分别落在 `~/.dsh/…`、`~/.ossutilconfig`（权限 600）、技能自己的配置里，**都不进本仓**。

---

## 七、目录

```
AGENTS.md          DSH 插件架构、目录、代码风格与测试规范
SECURITY.md        安全模型：插件能碰到什么、凭据在哪、漏洞怎么报
LICENSE            内部使用授权（不对外分发）
install/INSTALL-PROMPT.md  安装提示词（把插件装进别人 DSH 时发给对方 agent）
install/browser-check.mjs  真实浏览器验收（第 5 / 6 / 7a 条判据，见第一节）
scripts/sync-version.mjs   版本号一致性（npm run version:set / version:check）
scripts/assert-pack.mjs    发布产物自检（npm run pack:assert）
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

`npm pack` 带 `lib/` + 补丁 + 文档 + `skills/` + `common/skills/`（172 个文件、解包约 2.9MB，
技能正文是大头）；`install/`、`tests/`、`scripts/`、`src/` 是仓库内部件，不进包 —— `npm run pack:assert` 会核对这一点。

DSH 不要求 TypeScript 源码集中在单个文件。`src/` 按领域拆分，构建后只暴露
`lib/index.js` 与 `lib/client.js` 两个入口。

## 许可

内部使用，**不对外分发**，见 [`LICENSE`](LICENSE)。审核意见属内部材料：云端链接默认走**签名 URL**
（带 bearer 签名，1 小时），不要改成公开读。
