# 房地产估值工作流与缺陷定位（2026-10-16 诊断快照）

> **历史诊断快照**：本文记录 2026-10-16 对当前实现与知识库入口声明的核对结果，
> 不是现行操作指令。正文按当时源码行号与当时的结构化 Tool 契约书写；后续实现变化时
> 不要用它替代 `SKILL.md`、`workflow.md` 或源码。
>
> 结论分三类，逐条标注：
> - **[源码]**：来自工作区源码 / 技能正文，可复核；
> - **[在线]**：来自本轮真实 `dws` 调用返回；
> - **[在线受限]**：尝试在线核对，被能力边界挡住，只记录边界与命令，没有正文。

## 0. 范围、方法与证据边界

### 0.1 已读输入（派工命名与仓库实际路径的对应）

派工里写的 `lifecycle/handoff.ts` 在仓库中**不存在**同名文件；对应实现是：

- 交接事务入口：`plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/handoff.ts`
- 交接持久化状态机：`.../src/host/domains/report-evaluation/execution/handoff-store.ts`
- 生命周期状态机：`.../src/host/domains/report-evaluation/lifecycle/{state,registry,resume}.ts`

派工里的 `tools knowledge/market/select/browser` 对应：

- `.../src/host/tools/report-evaluation/knowledge.ts`、`.../market-search.ts`
- `.../src/host/domains/report-evaluation/market/{select,candidates,budget,normalize}.ts`
- `.../src/host/domains/report-evaluation/browser/*`
- 目录树读取：`.../src/host/tools/report-audit/knowledge.ts`、`.../src/host/integrations/dws/knowledge-tree.ts`

**这是一处需要澄清的入口命名不一致**：按派工给的 `lifecycle/handoff.ts` 无法直接定位；
本文按上述真实文件写入证据。AGENTS 已读：仓库根 `AGENTS.md`、`plugins/AGENTS.md`、
`plugins/dsh-crwu-workbench/AGENTS.md`（后者作为工作区指令注入）。

### 0.2 结构化 Tool 的“可见性”发现 [源码]

- 估值链路可见工具名单：`tools/report-evaluation/consts.ts:32-49`（16 条 `VALUATION_CHILD_TOOLS`）。
- 启动前预检：`tools/report-evaluation/visibility.ts:33-35`（`missingValuationTools` →
  复用 `missingAuditTools`），`operations/report-evaluation/handoff.ts:99-100` 注入 `missingTools`。
- 关键事实：估值会话是统一会话服务建的**顶层会话**，**没有** DSH `toolFilter`；所以
  “可见性”只是**启动前预检**，不是运行期收窄（`visibility.ts:6-30` 的design注释明确写了这一点）。
- 派工要求“不递归调用 orchestrator”，因此本轮**没有**运行 `dsh headless`（`dsh` 位于
  `/usr/local/bin/dsh`）。这里只报告源码可见性契约；`dsh headless` 的实际工具面未由本轮验证。

### 0.3 在线知识核对：能力边界（唯一允许的下载目录 + dws 凭据）[在线受限]

按派工要求，在线发现/下载**只允许**落在私有目录
`/Users/mungdong/.local/state/dsh-orchestrator/valuation-flow-20261016/wiki`，且只用包内
`plugins/dsh-crwu-workbench/bin/darwin-arm64/dws`。实际结果：

1. **私有目录无法创建**：`mkdir -p <私有目录>` 返回 `Operation not permitted`（DSH 文件沙箱，
   工作区外写入被拒）。该目录当前不存在。
   一次性放宽到 `danger-full-access` 的申请被拒：`requires approval, but no approval channel is available`。
   因此**没有任何文件落盘**，也就没有下载文件可核对。
2. **`dws` 可执行但读不到凭据**：`.../dws --version` → `dws version v1.0.61 (50eb73a0, 2026-08-31T14:46:17Z)`。
   执行（只读，不登录、不改配置）：
   - `dws wiki +space-list --type orgWikiSpace --limit 50 --page-all --format json`
   - `dws wiki +space-list --type myWikiSpace --limit 50 --page-all --format json`

   两次都返回 `ok:false`，进程退出码 `5`；`error` 长度 344、内容同时命中 `token` 与
   `operation not permitted`（为不泄露路径/凭据，仅记录分类与 sha256 前 8 位 `201b5c9b`）。
   命令**未改动**任何 profile / 缓存 / 凭据，也**未登录**。

**结论**：本轮**没有**获得任何「中瑞世联业务知识库」的实时正文、节点标题、节点 ID 或正文指纹。
S2 的在线证据部分为 **blocked（能力边界）**；下文的矛盾判定全部是 **[源码]** 之间的对照。
AC2 允许用“已记录的能力边界”替代在线正文，本文按此执行。

## 1. 实际端到端流程（谁 / 工具 / 产物）[源码]

依据：`workflow.md`、`prompt.ts:220-309`、`operations/report-evaluation/handoff.ts:46-62`、
`tools/report-evaluation/*`、`execution/handoff-store.ts`。

| # | 阶段 | 归属 | 结构化 Tool / 动作 | 产物（案例目录内） |
| --- | --- | --- | --- | --- |
| ① | 面版整理资料、冻结预览 | 面板 / Host | `intake/*`，冻结 `估值输入.json` | 预览与输入摘要 |
| ② | 幂等交接父会话（六步事务） | Host 操作 | `operations/report-evaluation/handoff.ts`：回读归档副本→重算 sha256→`pending`→建父会话→绑 scope→写输入与清单→`dispatchReceipt` | `估值输入.json`、`交接清单.json`、`交接记录.json`（状态 `pending→created→dispatched`） |
| ③ | 知识读取（按阶段） | 估值子会话 | `crwu_valuation_knowledge_materialize`（`wikiPaths` 主通道 / `routeIds` 遗留通道 / `stage=parameters`） | `知识快照/<routeId>/…`、`知识快照/知识来源/<routeId>.json`、`知识快照/.知识来源.json`、`知识快照/.知识目录.md`、`知识快照/规则参数.json` |
| ④ | 模板取回（二进制） | 估值子会话 | `crwu_valuation_template_materialize` | 已验真模板 + 落点 |
| ⑤ | 对象/方案/方法固定 | 估值子会话 | `crwu_valuation_project_prepare` | `项目估值方案索引.json` |
| ⑥ | 调度 | 估值子会话 | `crwu_valuation_execution_dispatch` / `_join`（有界并行 ≤2 或本会话顺序） | 任务图与结算 |
| ⑦ | 案例取数 | 估值子会话 | `crwu_valuation_market_search`（浏览器 `crwu browser fetch` 或退化 `fetchTransport`） | `方案/<planId>/估值案例.json`、`来源证据/页面/*`、截图、`取数预算.json` |
| ⑧ | 逐条证据 | 估值子会话 | `crwu_valuation_market_capture` | `来源证据/*` + 指纹 |
| ⑨ | 候选编号册 / 复算修订 | 估值子会话 | `crwu_valuation_revision`（`candidates`/`list`/`recompute`/`promote`） | `方案/<planId>/候选案例.json`、修订索引、版本目录 |
| ⑩ | 测算 | 估值子会话脚本 | `crwu_run_python_script`（`calculate_market.py`、`build_workbook.py`） | `方案/<planId>/估值底稿.xlsx` |
| ⑪ | 报告 | 脚本 | `build_report_data.py --input/--out`、`build_report.py --data/--out` | `估值报告数据.json`、`估值报告.html` |
| ⑫ | 重算 | 估值子会话 | `crwu_valuation_recalculate` | `重算结论.json`（Host 写） |
| ⑬ | 完成判定 | Host | `crwu_valuation_finalize`（带 `planId`） | `completed / partial / blocked / failed` + 逐条问题 |

流程要点：只有**一个父会话**；完成状态不靠“页面还开着”，由 finalize 显式判定
（`workflow.md:15-16,114-121`）。`取数预算`与`候选案例.json`是两个不同持久化：
前者由 `market_search` 直接写，后者只由 `revision op=candidates` 写（见 §3）。

## 2. 源码 vs Wiki 入口声明矛盾（已证实的 [源码] 矛盾）

“唯一业务入口”在同一仓库里出现**两种写法**：

| 位置 | 写的入口 | 行号 |
| --- | --- | --- |
| 技能正文 `SKILL.md`（Agent 唯一会读到的入口） | `01 估值与测算/01 房地产/wiki.md` | `SKILL.md:52` |
| 知识路由技术合同 `knowledge-routing.md` | `01 估值与测算/01 房地产/wiki.adoc` | `knowledge-routing.md:12` |
| 部署配置 `config/crwu-workbench.yml` | `wiki.md` | `crwu-workbench.yml:58` |
| 源码默认值 `config.ts` | `wiki.md`，注释却写“与 knowledge-routing.md 逐字一致” | `config.ts:113-115` |
| 插件 CHANGELOG | `wiki.md`，同样声称“与 knowledge-routing.md 逐字一致” | `CHANGELOG.md:135-137` |

也就是说：**SKILL.md / 配置 / 代码 / CHANGELOG 说 `.md`，被它们声称“逐字一致”的
`knowledge-routing.md` 说 `.adoc`**。CHANGELOG 与 `config.ts:113` 的“逐字一致”是不成立的。

派工上下文里“SKILL and workflow may be stale”与此一致：派工给的 knowledge_entry 记录为
`wiki.adoc`，而技能正文写 `wiki.md`。哪个是真实节点，因 §0.3 的能力边界本轮**未能在线上确认**；
但无论真实节点是哪个，下面的源码解析路径都**只会命中其中一种后缀**（见 §3.1），所以两种写法并存
本身就是可复现的缺陷。

## 3. 请求缺陷的根因表

### 3.1 入口不匹配 → 入口可能永远取不到（高）

| 项 | 证据 |
| --- | --- |
| `wikiRouteFromPath` 把允许后缀**钉死为声明后缀**：`extensions: [extension]` | `knowledge/resolve.ts:529-545`（尤其 `543`） |
| `resolveRoute` ② 级“同目录同名（后缀可不同）”再按 `allowedExtension` 过滤 | `knowledge/resolve.ts:351-364` + `195-200` |
| `allowedExtension` 先看**服务端 `extension`**，不是落盘名后缀 | `knowledge/resolve.ts:195-200` |
| 目录树把 `adoc` 节点**改名为 `.md`**（`adoc→md`），但 `extension` 字段仍是 `adoc` | `catalog.ts:31-37,139-162` |

后果（纯源码推演，两种写法各错一边）：

- Agent 按 `SKILL.md`/配置传 `.../wiki.md`，真实节点 `adoc`：`spec.extensions === ['md']`，
  `file.extension === 'adoc'` → ① 级 `byKey` 过滤后为空，② 级同名也被过滤 → `missing`。
- Agent 按 `knowledge-routing.md` 传 `.../wiki.adoc`，真实节点 `md`：同理 `missing`。
- 更隐蔽：`catalogFromTree` 会把 adoc 节点路径显示成 `wiki.md`，而 `allowedExtension` 用的是
  `adoc`；即“清单里看到的路径”和“能否命中”用了两套标准，人按 `resolvedPath` 核对会得出错误结论。

即：manifest 槽位通道享有 `TEXT_EXTENSIONS = ['md','adoc','txt']` 的同名跨后缀恢复
（`route.ts:45,50-52`），**Wiki 路径通道被显式收窄成单后缀**，恰好把唯一入口卡死。

由于 §0.3 无法在线确认，这里给**两种分支**都算作缺陷：任选其一，另一侧的声明必然取不到。

### 3.2 重复取页 / 列表快照不复用（高）

**(a) 知识目录树每次调用全量重读，且不落盘、不复用** [源码]

- `knowledge_materialize` 每次 execute 都调 `loadKnowledgeCatalog`：`tools/report-evaluation/knowledge.ts:434-436`。
- `loadKnowledgeCatalog` 每次先对 `orgWikiSpace`、`myWikiSpace` 各发一次
  `wiki +space-list … --page-all`，再对每个命中的空间递归 `readTree`：`catalog.ts:170-207`。
- `readTree` 逐目录 `wiki +node-list --page-all --page-limit 200`，串行、无缓存：`tools/report-audit/knowledge.ts:91-135`。
- 结果只存在于本次 `KnowledgeCatalog` 内存对象；**不写任何目录快照**，下一次按 `stage` 读取
  （`common`→`method.*`→`case-selection`→`parameters`…，`SKILL.md:59-68`）把整棵树**从头再取一遍**。
- 返回/遍历截断：`MAX_NODES = 10_000`、`MAX_DEPTH = 20`（`tools/report-audit/knowledge.ts:63-65`），
  触顶只 `truncated = true` 并追加一条模糊失败（`catalog.ts:204`）。
  `resolveRoute` 只有在“① ② 都没命中”时才把 failure 视为 `unreadable`（`resolve.ts:367-374`），
  于是**被截断漏掉的节点会被报成 `missing`**（假阴性），而调用方无从区分“不存在”与“没读完”。

**(b) 市场候选列表每次覆盖写，跨调用不合并** [源码]

- 每页取完后 `budget` 逐页落盘 `取数预算.json`：`market-search.ts:943-951`。
- 但 `估值案例.json` 只在全部来源跑完后写**一次**，内容是**本次调用内存里的 `merged`**：
  `market-search.ts:1082-1096`（`cases: merged.map(caseToJson)`）。
- 全仓库没有任何地方把上一次的 `估值案例.json` 读回来合并（`grep` 仅见写入与展示，
  见 `consts.ts:14`、`prompt.ts:129`、`artifacts.ts`）。
- 完整的候选册是**另一个文件**`候选案例.json`，只由 `revision op=candidates` 写：
  `revision.ts:220-239,273-299`；`market_search` 既不读也不写它。
- 后果：默认 `maxPages=1`（`market-search.ts:663-667`），Agent 需要多次调用翻页；第二次调用
  只返回第二页案例并**覆盖**第一次的 `估值案例.json`，先前抓到的候选在案例清单里丢失
  （只有 `取数预算.json` 的 `seen[]` 还记着指纹）。这就是“列表持久化/返回截断”的核心：
  **预算累计，但候选列表不累计**。

### 3.3 合规案例筛选（高）

| 项 | 证据 |
| --- | --- |
| 硬性排除只看“非空且非成交”与“证据为空” | `market/select.ts:125-134` |
| `transactionType === ''`（未知）既不等于 `''` 跳过条件、也不等于 `成交` | 同上，`125-129` |
| 筛选只在给了 `args.selection` 时才执行 | `market-search.ts:1065-1080` |
| 筛选输入是**本次调用**的 `merged`，不是完整候选册 | `market-search.ts:1053-1070` |
| 提示词却要求“对**全部候选**做一次批量筛选” | `prompt.ts:259-266` |

后果：
- 交易性质**未知**的房源会被当作可用案例进入 `adopted`（`selectCandidates` 的 `usable`），
  与“挂牌/询价不能直接作可比实例、必须是有成交依据的案例”这一业务合同相冲突；
  未知不等于成交，当前实现把它当成成交处理。
- 多轮翻页时 `selection` 只筛到最后一轮的一小批，`adopted` 可能遗漏前面已取得且合规的候选；
  筛选结果写进 `估值案例.json` 的 `selection` 视图（`1091-1092`），事后看像是“全部候选已筛过”。
- 不给 `selection` 时，硬性排除**完全不发生、也不报告**；合规性依赖调用方自觉。

### 3.4 事务语义（中高）

| 项 | 证据 |
| --- | --- |
| 预算逐页提交 | `market-search.ts:943-951`（每页 `writeCaseText(budgetPath)`） |
| 候选列表调用末才提交 | `market-search.ts:1082-1096` |
| `selection` 校验/执行在所有网络取数与预算消费**之后** | `market-search.ts:1065-1080` |
| 非法 `selection` 直接 `return failure('input', …)`（此时预算已记、案例未写） | `market-search.ts:1066-1069` |
| 案例清单写失败也只回 `infrastructure`，预算不回滚 | `market-search.ts:1096` |
| 交接事务的“原子性上限”已被诚实记录（无 rename，整份写 + 回读） | `execution/handoff-store.ts:29-34` |

后果：预算与候选列表不是同一个提交单元。一次调用可能“花了配额却没留下候选”，
下一次调用读到已推进的预算，于是**在更少的剩余配额上重取**；`selection` 规则写错也会先花掉配额。

### 3.5 浏览器启动/附着/前台（中）

| 项 | 证据 |
| --- | --- |
| `fetch` / `shot` 取会话时用**空 `AcquireOptions`**（即 `Headless:false`） | `internal/transport/cli/browser.go:440` |
| 无凭据读（`status`）才 `Headless: !verifyPage` | `browser.go:327-359` |
| 附着优先：有活调试端口就复用，忽略 launch 选项 | `internal/platform/browser/acquire.go:257-282` |
| 启动参数固定 `--window-size`，无 `--window-position`/前台控制 | `internal/platform/browser/launch.go:52-69` |
| 站点指纹会拒绝 headless，故可见窗口是默认（作者注释） | `launch.go:25-27,46-51` |
| Host 侧 fetch/shot 不传任何“后台/前台”模式 | `browser/cli-client.ts:461-478` |
| 同一 profile 严格串行，避免 A 的截图拍到 B 的页面 | `browser/profile-queue.ts:1-22` |

后果：**没有运行中的浏览器实例时，普通取数（`fetch`/`shot`）会启动一个可见窗口**，
即常规取数也是前台；只有 `login`/`open`/`recover` + `--verify-page` 才是“本来就需要人看”的路径。
若员工已开着登录窗口，`fetch` 会附着复用它（好），但那仍是同一个可见窗口。
当前 CLI 没有“后台运行/不抢焦点/仅在人工验证时前置”的开关，Host 也没有把
“人工验证”与“常规取数”区分为两种启动模式。详见 §6 的取舍。

### 3.6 次要发现（证据不一致）

- `market_capture` 成功返回里**硬编码** `capabilityGaps: [SCREENSHOT_GAP]`
  （`market-search.ts:1226`），即使 `deps.screenshot` 已装配也不会消失；与同函数 `empty`
  分支按 `deps.screenshot === undefined` 判断（`1168`）自相矛盾，会让报告的“能力缺口”与事实不符。
- 工具描述说 `wikiPaths` “路径逐字匹配，不做大小写 / 全半角折叠”（`knowledge.ts:232-234`），
  但 `resolveRoute` 实际走 `knowledgeIdentityKey` 做连字符/空格/全半角折叠
  （`resolve.ts:121-139,304-341`）。描述与实现不一致（行为本身更宽容，但描述会让调用方
  按“逐字”去猜路径，从而更容易传错后缀）。
- 浏览器页面字节超过 4 MiB 会被**静默截断**并记一条 note（`browser-transport.ts:169-174`），
  解析可能不完整；该截断只体现在 note，不体现在“解析结果可能不完整”的结构化字段里。

## 4. 推荐的有界修改（建议，不在本轮实施）

> 全部为**普通有界行为**，不涉及 stealth、UA/指纹伪装、验证码破解、代理轮换或绕过。

1. **入口单一真相 + 后缀自动恢复（3.1）**
   - 让 `knowledge-routing.md`、`SKILL.md`、`config/crwu-workbench.yml`、`config.ts` 默认值、
     CHANGELOG 只保留一处入口写法；其余引用改为指针，不再复制路径。
   - 把 `wikiRouteFromPath` 的 `extensions` 从“钉死声明后缀”改为按形态给集合
     （文档类用 `TEXT_EXTENSIONS`，模板类用 `BINARY_EXTENSIONS`），并在 `routes[]` /
     `lookupAttempts[]` 里如实记录“声明 `.md` → 实际 `.adoc`”。这样两种声明都能命中同一节点。
   - 让 `catalogFromTree` 不再改写 `path` 后缀，或在返回里同时给“库内原名”和“落盘名”，
     避免 `resolvedPath` 与 `extension` 两套标准。
   - `knowledge_materialize` 入口由 Host 用配置的 `wikiPath` 兜底：`wikiPaths` 为空时，
     Host 至少把配置入口放进本次请求（现在只把 `entryWikiPath` 回显，`knowledge.ts:509`）。

2. **目录树快照一次、跨阶段复用（3.2a）**
   - 在案例目录写一份可复用的目录快照（含 `spaceName`、`verified`、文件/目录、每个节点的
     `updatedAt`、`truncated`），本次后续 `stage` 直接读快照；只有快照缺失或显式要求刷新时才重取。
   - 把 `readTree` 的 `truncated` 提升为结构化事实并进入 catalog；`resolveRoute` 在
     `truncated === true` 且未命中时返回 `unreadable`（而不是 `missing`），消除假阴性。

3. **候选列表累计 + 幂等合并（3.2b / 3.4）**
   - `market_search` 写 `估值案例.json` 前先读回并合并上一次结果（按 `crossSiteKey` 去重），
     或直接让 `market_search` 自动并入 `候选案例.json`（复用 `mergeCandidates`），
     使“预算累计”与“列表累计”一致。
   - 预算与案例列表按同一次提交落盘：先算完整结果，再一次性写预算 + 案例；失败时两者都不推进，
     或明确记录“预算已消费、列表未落盘”的结构化警告。

4. **筛选前置并按完整列表执行（3.3 / 3.4）**
   - `selection` 规则在**任何网络请求之前**校验；非法规则直接 `input` 失败、不消耗预算。
   - 筛选对象改为**完整候选列表**（持久化的 `候选案例.json` / 合并后的 `估值案例.json`），
     而不是本次 `merged`。
   - `hardExclusionOf` 对 `transactionType` **未知**给出明确处置（例如：不得进入 `adopted`，
     归入 `unreviewed`/`near-miss` 并写明“交易性质未确认”），与“挂牌/询价不能直接作可比实例”一致。

5. **浏览器：后台复用为主、前台显式化（3.5）**
   - 给 `crwu browser fetch/shot` 增加一个受限的启动模式（如 `--background` / `--reuse-only`），
     由 Host 在常规取数时显式传入；`login`/`open`/`recover` 才允许把窗口带到前台。
   - 不引入随机 UA、指纹伪装、代理轮换或验证码破解；只做“复用同一 profile、后台运行、
     必要时人工前置”。见 §6。

6. **报告一致性（3.6）**
   - `market_capture` 的 `capabilityGaps` 按 `deps.screenshot` 与本次实际结果决定，不硬编码；
   - 把 `wikiPaths` 的工具描述与 `knowledgeIdentityKey` 实际行为对齐；
   - 页面字节截断进入结构化字段（如 `bodyTruncated: true`）。

## 5. 红测场景（具体、可失败）

> 下列断言都应在**不改业务默认值**的前提下能失败/通过；属于“红测”目标，不是已通过的检查。

1. **入口后缀恢复**
   - 构造 catalog：子目录下只有 `wiki.adoc`（`extension: 'adoc'`）。
   - 断言：`materializeKnowledge({ wikiPaths: ['…/wiki.md'] })` 返回该节点 `found`，
     且 `entries[0].resolvedPath` 指向真实节点、`source === 'dws'`。
   - 反向：只有 `wiki.md` 时传 `wiki.adoc` 亦应 `found` 或明确报“实际节点是 wiki.md”，
     而不是无提示的 `missing`。
2. **目录树只取一次**
   - 注入计数替身 `loadCatalog`；连续调用 `stage=common` 与 `stage=method.market`。
   - 断言：`space-list` 与 `node-list` 的调用次数不随 stage 数线性增长（复用快照）。
3. **截断不产生假阴性**
   - catalog 设置 `truncated: true`，请求一个不在已知集合里的路径。
   - 断言：状态是 `unreadable`（“结果可能不完整”），不是 `missing`。
4. **候选列表累计**
   - 第一次 `market_search`（1 页，2 条），第二次换关键字/翻页返回另 2 条。
   - 断言：第二次落盘的 `估值案例.json` 含全部 4 条（按跨站指纹去重后的并集），
     且 `取数预算.json` 的 `candidates` 与列表条数一致。
5. **筛选前置且不浪费预算**
   - 传非法 `selection`（缺 `maxAdopted`）。
   - 断言：返回 `input` 失败；`取数预算.json` 的 `pagesUsed`/`candidatesUsed` 不变；
     没有任何页面请求发出。
6. **合规筛查的未知交易性质**
   - 构造一条 `transaction_type: ''`、`evidence` 非空的候选，规则 `maxAdopted: 1`。
   - 断言：该条不进入 `adopted`，并给出“交易性质未确认”的落选理由。
7. **预算与列表同提交**
   - 让案例清单写入失败（注入只读落点）。
   - 断言：本次不推进预算，或结果里明确出现“预算已消费、列表未落盘”的结构化告警。
8. **浏览器启动模式**
   - 以“无运行实例”启动 `fetch`。
   - 断言：Host 传的是后台/复用模式；`login`/`open` 才允许前台。以源码契约/替身断言，
     不在真实站点上做验收（本轮不做真机验收）。

## 6. 后台可见 Chrome 复用 vs 无头：基于当前实现的取舍

**当前事实** [源码]：

- `fetch`/`shot` 无运行实例时启动**可见** Chromium（`browser.go:440` + `launch.go:52-69`）。
- 有活调试端口时**附着复用**，且附着忽略 launch 选项（`acquire.go:269-282`）——
  这保证“员工已登录的窗口”不会被重启、登录态不丢。
- `status` 的凭据读取用 headless（`--headless=new`），不加载页面、不产生指纹面
  （`browser.go:358-359`、`launch.go:46-51`）。
- 作者注释明确：受保护页会被 headless 指纹识别并拒绝，所以可见窗口是加载页面时的默认
  （`launch.go:48-51`）。

**取舍**：

| 方案 | 优点 | 风险 / 成本 | 是否推荐 |
| --- | --- | --- | --- |
| 常规取数复用**可见但后台**的同一实例 | 登录态稳定、不触发“无头指纹”拒访、串行队列可保证截图与页面同源 | 当前无“后台/不抢焦点”开关；窗口弹出会打断员工 | 推荐作为常规取数默认，需新增受限模式参数（§4.5） |
| 常规取数改用 **headless** | 不弹窗、对员工无干扰 | 当前实现与注释均表明站点会识别并拒绝 headless；会制造更难解释的失败 | 不推荐作为加载真实页面的默认；仅限无页面加载的凭据读取（现状） |
| 登录 / 人工过验证用**前台可见** | 唯一能让员工完成验证的方式；验证结果只由下一次 `status` 回答（`cli-client.ts:160-189`） | 必须由员工操作，不能自动循环 | 推荐：仅 `login`/`open`/`recover` + `--verify-page` 前台 |

因此建议“后台可见复用为主、前台仅在登录/人工验证时显式发生”，
且**不**通过 UA/指纹伪装、代理或验证码自动破解去规避站点对 headless 的识别；
遇到访问失败按 §3.5 的结构化类别处置（登录墙才引导登录、验证码交人工、网络/站点错误按类处置）。

## 7. 在线验证状态与限制（如实清单）

- **在线取到**：无知识正文。仅确认包内 `dws` 可执行、版本 `v1.0.61`。
- **在线受限**：
  - 私有下载目录无法创建（沙箱拒绝，且无审批通道）→ 无文件、无指纹可核对；
  - `dws wiki +space-list` 因凭据读取 `operation not permitted` 返回 `ok:false`/退出码 5
    → 无法确认真实入口是 `wiki.md` 还是 `wiki.adoc`，也无法核对任何方法/案例/渠道正文。
- **未做**：未登录、未改 profile/缓存/凭据、未远程写入、未真机跑真实站点验收。
- **因此**：§2 的“两种写法并存”是 [源码] 事实；§3.1 的“只有一种后缀能命中”是 [源码] 推演；
  线上究竟命中哪一支，需要具备凭据与可写下载目录的环境再验一次。
- **未运行**：测试、lint、构建、验收（按派工由 supervisor 负责）。

## 8. 变更范围

本诊断唯一写入的仓库文件：`docs/superpowers/reviews/2026-10-16-valuation-workflow-diagnosis.md`。
未修改任何源码、技能、配置或测试；未提交、未推送、未安装依赖。
