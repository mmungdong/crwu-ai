# legacy → 包 的移植清单

`legacy/host.js`（2317 行）与 `legacy/client.js`（1446 行）是**逐字源码**，本文件是把它搬进
`src/` 的施工图。行号都指 `legacy/host.js`，改版本后行号会漂，用 op 名搜更稳。

## 已经做完的（构造函数 + 证明链路）

| op | legacy 行 | 说明 |
|---|---|---|
| — | — | `Config` / `inject` / `ctx.webServer.register` 路由分发 / 同源 + 跨域检查 / 错误信封 |
| `ping` | — | 链路自检 |
| `boot` | 1518 | 简化版：工作空间视图 + 已移植清单 |
| `workspace` | 1546 | 选定案例根目录 |
| `workspace-auto` | 1562 | 恢复自动识别 |
| `trust` | 1573 | 氚云授权开关 |
| `bind-session` | 1579 | **含顶层会话门禁**（子代理拒绝） |
| `install-prompt` | 1618 | 安装提示词骨架 |
| `audit-release` | 1745 | 释放占用 |

## 待移植（按依赖顺序，建议一次做一层）

### 第 1 层：跑命令与读文件（纯搬运，改动最小）

| op / 函数 | legacy 行 | 要点 |
|---|---|---|
| `runShell` | ~256 | 原样搬，但要用 `ctx.shell.resolve/run`（**不要换成 `node:child_process`**：那会绕过 DSH 的沙箱与审批，用户点不到授权，违反「不做静默提权」） |
| `homeDir` | ~336 | 包形态可直接 `node:os.homedir()`，不必再探测 |
| `sessionRoot` | ~246 | 用 `ctx.fs.resolve('.')` |
| `detectPlatform` | ~394 | 依赖 `runShell` |
| `resolvePath` / `dirExists` | ~451 / ~1367 | 用 `ctx.fs.resolve/stat` |

### 第 2 层：环境自检（面板的门禁，先做这个用户才看得到东西）

| op / 函数 | legacy 行 | 要点 |
|---|---|---|
| `normalizeManifest` | 612 | 内置默认清单 + 远程覆盖；`manifestUrl` 从 `config` 取 |
| `loadManifest` | 652 | `curl -fsSL` 拉远程清单，失败回退内置 |
| `probeEnv` | 740 | 二进制存在性 + 版本比对（`satisfies`） |
| `probeOss` | 784 | `ossutil ls --limited-num 1` 探测 AK |
| `resolveOssutil` | 721 | `command -v` 优先，再落到 `~/bin/ossutil` |
| `probeIfindKey` | ~300 | 读技能配置文件里的 `auth_token`（只回长度，不回显） |
| **`env`** | **2139** | 聚合上面全部 + `crwu h3yun session status` + `dws auth status`，产出 `checks/services/blocked/allOk` |

> `env` 是所有后续页面的前置：`blocked.length > 0` 时客户端只渲染环境自检页。

### 第 3 层：氚云列表

| op / 函数 | legacy 行 | 要点 |
|---|---|---|
| `runCrwu` | 564 | 只允许 `crwu` 且白名单子命令；`--filter "SeqNo Equal '<全号>'"` / `Contains` |
| `buildQueryFilter` | ~816 | 完整流水号精确匹配、片段模糊匹配 |
| `rowsFromEnvelope` / `rowToTask` | ~796 / ~829 | 氚云返回包裹层的字段映射（`F0000049` 项目名等） |
| `discoverForm` | ~858 | 首次自动定位「报告审核」表单，拿 `code` |
| **`pending`** | **2276** | 分页 + 检索；`stdoutMaxBytes: 4MB`（20 条记录 233KB，默认 64KB 会被截断） |

### 第 4 层：审核生命周期（核心，也是最容易踩坑的一段）

| op / 函数 | legacy 行 | 要点 |
|---|---|---|
| `makeAbortableSignal` | 953 | 包形态有真 `AbortController`，**整段可以删掉** |
| `startChild` | 1175 | `subagents.start(provider, { label, prompt, parent, signal })`；`inject` 要加 `subagents`/`agents` |
| `auditLabel` / `seqNoFromLabel` | ~1450 / ~1456 | label = `审核 <流水号> · HH:MM:SS`，流水号始终是第一个 token |
| `describEndReason` | ~1030 | `SubagentStopReason` 四值：completed/aborted/error/max-tokens |
| `auditPrompt` | 875 | 审核指令全文（含 `--case` 绝对路径、重审段、OSS 上传段）——**整段照抄，不要改写措辞** |
| `stopChild` | 1838 | abort → 再 dispose；无句柄时 `agents.get(id).cancel({ kind:'parent' })` |
| `sessionDelegation` | 1493 | 已移植（顶层会话门禁） |
| **`audit-start`** | **1722** | 父级必须是顶层会话；同报告已有子会话则**停掉旧的 + 带时间戳重启 + 走重审提示词** |
| **`audit-stop`** | **1891** | 标记 stopped/ended + 释放占用 |
| **`audit-status`** | **1913** | 存活 = `agents.get(childId).status === 'running'`（**与父会话无关**，这是修「状态跟丢」的关键）；按每条记录自己的 `parentSessionId` 聚合查询；占用锁自愈 |
| 事件订阅 | ~1000 | `ctx.on('agent/status')` / `ctx.on('subagent/end')` —— 包形态直接可用 |

### 第 5 层：交付件上云

| op / 函数 | legacy 行 | 要点 |
|---|---|---|
| `inspectCase` | 465 | 扫案例目录，认 `审核意见.*.html`（canonical 优先）/ `审核结果.*.json` |
| `uploadArtifacts` | 1076 | `ossutil cp -f` → key = `<prefix>/<流水号>/<文件名>`（**不带年/月**） |
| `maybeAutoUpload` + 上传看门狗 | 1044 / ~1005 | `ctx.timer.interval` 轮询，出结果就传 |
| `joinUrl` / `parseSignUrl` / `parseLsObjects` | ~1030 / ~700 / ~680 | 签名 URL、列举解析 |
| **`oss-index`** | **2110** | 报告页首次进入或显式刷新时只执行一次 `ossutil ls`；检索、翻页、标签切换不得重复列举 |
| **`oss-result`** | **2142** | 用户点击“审核信息”后才按精确 Key `ossutil cat` 一个 JSON；先校验 Bucket 前缀与 `.json` 后缀，再输出精简摘要，不把完整证据链塞进列表接口 |
| **`oss-link`** | **2169** | 先校验对象属于配置前缀；默认签名 URL 1 小时；`http://` 升级 `https://`；然后调系统 `open` |
| **`oss-upload`** | **2345** | 手动重传 |
| `oss-cred-save` | 1696 | 写 `~/.ossutilconfig`（600），密钥不回显 |
| `open-path` | 2211 | 系统默认程序打开案例内文件（`fs.contains` 做根目录包含检查） |
| `relogin` / `dws-login` | 2334 / 2321 | 氚云扫码 / 钉钉登录 |

### 第 6 层：客户端半（**基本重写**）

`legacy/client.js` 是「函数体 + 注入 React/host/styles/slots」，包形态是 tsdown 打出的浏览器模块。
可以照搬的：面板结构、表格/徽章/提示条的 JSX、主题 token、`slots.inject` 的槽位名。
必须重写的：打包方式、`host.call` → `rpc`、`styles.insert` → 包内样式模块、`ctx.interval` → 客户端定时器。

当前 `src/` 已完成入口、Host 路由、状态与 Client 骨架的目录拆分，证明 DSH 并不要求 TypeScript
单文件。正式页面尚未从 `legacy/client.js` 搬完；在接入 DSH 官方 CSS Module 构建预设前，骨架样式
以 `features/workbench/consts.ts` 中的自包含样式文本随 `lib/client.js` 交付，避免生成未发布的独立 CSS。

报告页的目标交互已经在 legacy 落地：待审核报告与 AI 审核结果使用页内标签；氚云每页记录与一次
OSS 对象清单在内存合并；只有点击某条“审核信息”时才读取该条 JSON。不要恢复每分钟 OSS 轮询。

槽位归属（已实测确认，写进 `package.json` 的 `dsh.client.inject`）：

| 槽位 | 归属包 |
|---|---|
| `main` | `@deepseek-ai/dsh-client-ui-layout` |
| `sidebar.panellist` | `@deepseek-ai/dsh-client-ui-sidebar` |
| `tool.view.cordis` | `@deepseek-ai/dsh-client-ui-cordis` |
| `conversation.session.header.utilities` | `@deepseek-ai/dsh-client-ui-conversation` |

## 移植后要做的验证

1. `pnpm i`（或 `npm i`）后 `npm run build` —— 确认 tsdown 产出 `lib/index.js` + `lib/client.js`。
2. `npx tsc --noEmit` —— 类型过关。
3. 挂载校验：用 `agentPresets.standingKeyFor`（或直接 `dsh plugin --profile web add link:.` + 重启）确认行能激活。
   报 `waiting for <service>` = `inject` 少了服务；报 `published process-global service(s)` = 多提供/放错域。
4. 面板端到端：环境自检 → 拉氚云 → 发起一条 → 停止 → 重启 → 云端审核意见。

## 待确认（不要凭猜写死）

- `peerDependencies` 里 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-ui-slots`
  在本机 dsh 安装里**找不到实体包目录**（`dsh-file-upload-ocr-plugin` 却把它们列为 peerDeps）。
  上架前用 `dsh plugin --profile web list` 和目标部署实际安装的版本核对一遍。
- 持久状态现在放在进程内存（`state.audits`）。动态形态是手写 `~/.dsh/crwu-workbench.json`；
  包形态更该用 `ctx.storage` / `ctx.storageDomain`（见 Service 目录里的 `storage`、`storageDomain`）
  做**带 schema 的域持久化**，既有跨重启恢复，也不用自己维护文件格式。
