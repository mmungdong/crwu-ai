# Changelog

本仓有两个形态，版本各自独立记录：

- `legacy/` —— 动态插件形态（在 DSH 会话里 `cordis_define` + `cordis_run` 装配），版本号用 DSH 的 `pkg-N`。
- `src/` + `package.json` —— 包形态（`dsh plugin --profile <p> add` 安装），版本号用 semver。

包形态尚未发布（骨架阶段），下面只记录动态形态的真实历史。

## package · 0.1.1 · 2026-09-20（未发布）

- 将包形态骨架拆分为 Host、Client、shared 及领域子目录，入口文件只保留 DSH 装配导出。
- 修正 Client 的 DSH ModuleLoader 包装、Host/Client 独立构建和 `lib/index.js` / `lib/client.js` 固定输出。
- 收紧 `dsh.client.inject` 与 Cordis `inject`，常量、配置、状态、HTTP 和 UI 骨架分别维护。

## legacy · pkg-43 · 2026-09-20

- 报告页增加“待审核报告 / AI审核结果”页内标签，列表直接展示氚云人工复核级次、状态和当前节点。
- 保留原 OSS 对象命名与审核报告 HTML；报告页首次进入只列举一次 OSS，检索、翻页与审核状态轮询不再重复扫 OSS，只有显式刷新或上传成功后才重新列举。
- 已审核项目增加“审核信息”入口；点击后才按精确 Key 读取一份审核结果 JSON，并以精简摘要与当前氚云复核信息并列展示。列表接口不下载逐条 JSON，也不把“氚云更新时间较晚”误称为“报告材料变化”。
- Host 对审核结果 Key 增加 Bucket 前缀和 `.json` 边界校验，限制单次读取大小，并只向 Client 返回摘要字段。
- 云端报告链接同样执行 OSS 前缀校验；对象清单只认 `审核意见.<流水号>.html` 与 `审核结果.<流水号>.json`，避免辅助文件被误当正式交付件。
- OSS 清单失败不再拖垮已成功返回的氚云列表，也不会在后续检索、翻页时自动重试；快速切换审核信息时忽略迟到的旧请求。
- 新增按需读取、完整交付件门禁、OSS 清单缓存/失败隔离、请求竞态、Key 越界拒绝与结果归一化回归测试。
- 新增根目录 `AGENTS.md`；包形态 TypeScript 按 Host / Client / shared 及领域目录拆分，常量归入各目录 `consts.ts`，并修正 Host / Client 双入口构建产物名。

## legacy · pkg-42 · 2026-09-20

- 修复审核创建期间重复点击会并发创建两个子会话的问题：Client 立即显示并禁用「创建中…」，并在创建完成前禁用其它审核入口。
- Host 增加独立的创建中门禁；并发请求在调用 `subagents.start` 前即被拒绝，成功、失败或提前返回都会自动释放门禁。
- 新增 Client 状态传递与 Host 并发请求回归测试。

## legacy · pkg-41 · 2026-09-20

- **审核只允许挂一层子代理。** `bind-session` 拒绝把子代理会话登记成审核父级并保留原来的顶层父级；
  `audit-start` 再兜一道门禁。判据是只有子代理才有的 `origin: 'subagent'` / `delegationDepth`
  （顶层会话为 `delegationDepth: 0`、无 `origin`）。
- **存活判据换成子 Agent 自己的 `AgentStatus`**（`idle` / `running`），不再依赖 `listChildren` 的 `activity`。
  `listChildren` 由会话存储驱动，跑完的一次性子会话**依然在列**，父会话一变（`state.parentSessionId`
  只是「最后看过哪个会话」）就全体查不到，界面表现为「状态跟丢」。新判据与父会话无关。
- `audit-status` 按**每条记录自己的** `parentSessionId` 聚合查询多个父会话，并对历史 depth-2 记录免疫。
- **占用锁自愈**：只要本轮真看到有子会话在 `running`，就把单条审核门禁重新挂回去。
- **「这条任务已经有了」= 带时间戳重启**：先停掉已存在的子会话（记录里的 + 清单里 label 命中同一
  流水号的），再用「重新审核」提示词重启；子会话 label 变为 `审核 <流水号> · HH:MM:SS`，记录里有
  `startedAt` 与第 N 次，界面上显示「启动 10:16:27（第 2 次）」。别的报告在跑时仍然拒绝（单条并发门禁）。

## legacy · pkg-40 · 2026-09-20

- 修 pkg-39 引入的**认领过头**缺陷：认领只收 `agentStatusOf(cid) === 'running'`。
- 认领来的记录（以及落盘时没有 `startedAt` 的记录）永远等不到 `subagent/end`，其生命周期一律以
  Agent 状态判定，一旦不再 running 就置 `ended`、按交付件定状态并释放占用 —— 据此自愈了已被
  误写进 `~/.dsh/crwu-workbench.json` 的三条记录。
- `adopted` 落盘，重启后语义不丢。

## legacy · pkg-39 · 2026-09-20

- 补回 **Client 半**：pkg-38 只带了 Host 半，导致浏览器端停在更早的 `pluginRunId` 上，
  而 `invoke()` 严格按 run 对账，于是每次 `host.call` 都返回 `stale-run` 并被面板里的
  `.catch(function () {})` 静默吞掉 —— 界面表现为「子任务在跑但什么都不显示」。
- 新增按 label「审核 <SeqNo>」认领重装前遗留的审核子会话（pkg-40 收紧了准入条件）。

## legacy · pkg-38 · 2026-09-20

- 审计记录与占用锁落盘到 `~/.dsh/crwu-workbench.json`，插件重装后自动恢复。
- 停止增加无句柄退路：直接对子 Agent 调 `cancel({ kind: 'parent' })`，与驱动 `onAbort` 同一条路径，
  所以重装前起的会话同样停得掉。

> pkg-1 … pkg-37 的历史记录在当时的 DSH 会话里（`~/.dsh/storages/session_projcache/`），
> 未逐条搬进本文件；其中 pkg-34 之后的关键节点见上。
