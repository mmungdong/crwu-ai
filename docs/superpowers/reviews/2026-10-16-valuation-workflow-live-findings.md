# 房地产估值工作流：2026-10-16 实时知识库实读发现（历史快照）

> **历史实读快照**：本文记录 2026-10-16（Asia/Shanghai）对「中瑞世联业务知识库」的一次**真实在线实读**，
> 以及它与本技能现行正文、旧诊断报告
> [`2026-10-16-valuation-workflow-diagnosis.md`](2026-10-16-valuation-workflow-diagnosis.md) 的对照。
> 本文**不是**现行操作指令：现行流程以 `SKILL.md`、`references/workflow.md` 与技术合同为准；
> 本文只作为历史证据与更正记录保留。
>
> 证据标注：
> - **[在线]**：本轮 `dws` 真实返回；
> - **[源码]**：工作区源码 / 技能正文；
> - **[验收]**：supervisor 已实际跑过的门禁或探针证据。

## 0. 方法与边界

- 只用随包 `dws`：`wiki +space-list --type orgWikiSpace`（业务空间唯一，`autoPageComplete=true`）→
  有界 `wiki +node-list` → `doc +export --export-format markdown`。**全程只读**：没有登录、没有远程写入，
  没有改动 profile / 缓存 / 凭据。
- 出口只保留业务节点**标题**与正文 `sha256`；不记录 node id、空间 id、私有端点或凭据面事实。
- 本轮**不**验证真实房源站点在线取数，也**不**验证 Windows 运行时。本文只写实际执行过的命令与结果。

## 1. 实读到的八份正文（标题 + sha256）[在线]

| # | 标题 | 正文 sha256 |
| --- | --- | --- |
| 1 | 房地产估值 Wiki（入口） | `175290cd5338cb7e61d145e0bb229784c7db20cbc1aefd42fbd4e0fb38689e8b` |
| 2 | 02 市场法 | `7638cbbc6ff9321b2c02e2924b4b80e005680f6d1a4087a3ffb1e7623dad42d3` |
| 3 | 01 渠道与降级策略 | `bb1c6d33a70f5a6f9cada797822e091d88e2d3de200c92b454b2b5b7f8918564` |
| 4 | 02 候选筛选与相近案例 | `4cc261118a4f6f44e2b1bbf301d173785f18e2972edcce8d7df4021044e95539` |
| 5 | 03 证据与跨站去重 | `eb4bd51dd6e02fddbb843d860e0026e3ff18bf028f9161bf879ed3f00ab75c6c` |
| 6 | 01 参数来源与适用范围 | `3cacad7a439b45909a309ff1a78ea7aa5f7fa48b3c7487de9fb1dc84c6a676b5` |
| 7 | 02 地区税费与时点说明 | `e64d62f18813e43e374de0de519b946c7805cbda0bc313c802f0fb5b22708507` |
| 8 | 00-模板使用目录说明 | `89aca489a0de631ce1e6ae7bb147ff0dfe1fbf8172e7092e92f1290fe956a7e4` |

这些哈希只用于证明"当时读的是哪一版"，不是业务规则正文的替代品。

## 2. 实际端到端流程 [在线] + [源码]

1. **[在线]** `wiki +space-list --type orgWikiSpace` 得到唯一业务库；`autoPageComplete=true` 才继续。
2. **[在线]** 有界 `wiki +node-list` 列出入口与方法 / 案例 / 参数 / 模板说明节点。
3. **[在线]** `doc +export --export-format markdown` 逐篇取正文；入口正文里的**库内相对链接**决定下一跳。
4. **[在线] 扩展名事实**：入口节点的**真实扩展名是 `.adoc`**；导出的 markdown 里，指向各方法 / 案例 /
   参数 / 模板说明正文的相对链接写的是 **`.md`**。即"节点真实扩展名"与"导出正文里的链接名"不是一回事，
   不能从链接后缀反推节点类型。
5. **[源码]** 会话侧的取数只经结构化工具 `crwu_valuation_knowledge_materialize`：`wikiPaths` 是主通道
   （逐字传入入口或上一轮 `links[].target` 解析出的库内路径），`routeIds` 是遗留 manifest 槽位，
   `stage` **当前只接受 `parameters`**（在已验真的已落盘正文上解析结构化规则段）。在线 `dws` 调用发生在
   该 Host 工具内部，会话不需要浏览器下载、额外授权或 shell。
6. **[源码]** 详情取证：`crwu_valuation_market_capture` 接收已选定的稳定 `caseId`，保存回读到的
   **实际详情 URL** 与不可变 PNG，并写 `推理结果/图片/图片清单.json`
   （`crwu.valuation.screenshot-manifest.v1`，按 `planId` 隔离、回读校验）；列表页图片只作**页面证据**。
   `values.caseEvidence` 再把 `caseId / 显示名称 / 来源 / 详情 URL / 图片相对路径 / 指纹 / 抓取时间 /
   证据类型` 写进底稿可见的 `案例证据` 表（含 native 超链接与相对图片路径），HTML 报告用本地图片链接展示。

### 2.1 业务阶段（文档同步后的现状）[源码]

| 阶段 | 现状 |
| --- | --- |
| 材料提取 | `crwu_valuation_file_extract` 逐份读入，逐页报文本层与能力探测；读不出来的进 `capabilityGaps`，不回退本机副本 |
| 对象与方案 | `crwu_valuation_project_prepare` 先识别对象、按同一口径分组、再判方法；分组冲突 / 价值范围重叠 / 土地能力缺失当场阻断 |
| 活知识读取 | 入口 Wiki + `wikiPaths` 逐步读（见上）；`stage=parameters` 只解析围栏 JSON 规则段，缺段是适配器契约缺口 |
| 完整候选评估 | `market_search` 列表快照 + 完整候选池；`assessments` 评估门禁（qualified / near-miss / excluded），near-miss 不计合格预算；身份只认 canonical URL |
| 详情取证 | `market_capture`（稳定 caseId）保存实际详情 URL + 不可变 PNG + 图片清单；列表页图只作页面证据 |
| 计算（含缺口） | 脚本按本轮知识快照取阈值；缺关键参数挂起相关计算；模板与数值自动执行有当前限制（见 §5） |
| Excel / HTML | `values.caseEvidence` 生成 `案例证据` 表（完整 URL + native 超链接 + 相对图片路径）；HTML 用本地图片链接；底稿重算后回读 |
| finalize | Host 用真实文件逐项核对并判定 `completed` / `partial` / `blocked` / `failed`；无落盘重算记录时上限 `partial` |

## 3. 源码 vs 实读：需要更正的声明

| 声明 | 旧口径 | 实读 / 现行事实 |
| --- | --- | --- |
| 入口路径 | 技能正文与部署配置默认原先都写库内 `…/wiki.md` | **[在线]** 入口节点真实扩展名是 `.adoc`；技能侧只在 `references/knowledge-routing.md` 声明一次，`SKILL.md` 只引用；部署默认（`DEFAULT_VALUATION_KNOWLEDGE.wikiPath` 与随包 `crwu-workbench.yml`）已对齐为 `…/wiki.adoc`，显式覆盖仍允许 `.md` 文本（导出链接的 textual alias 保留） |
| 知识工具入参 | 文档写 `stage` / `routeIds` / `method`，并把 `common` / `method-selection` / `method.market` / `case-selection` / `template` 当参数 | **[源码]** 真实入参是 `wikiPaths`（主）/ `routeIds`（遗留）/ `planId` / `stage`（**只接受 `parameters`**）/ `spaceName`；其余是**阅读顺序**，不是工具取值 |
| 兜底顺序 | manifest 优先 / 本地 `references` 兜底 | **[源码]** 入口 Wiki 是唯一业务入口；没有 `local` 来源档；`_manifest.json` 与旧内置正文不作为入口或兜底 |
| 方法可用性 | 文档写死"某方法可用 / 未就绪" | **[源码]** 以入口 Wiki 与本轮取到的正文为准，技能不内置方法可用性清单 |
| 来源 | 业务库来源策略可能点名 58 | **[源码]** 当前 Provider 注册表只实现 `fang` / `anjuke` / `lianjia`；策略里出现 58 是**适配器缺口**，不静默降级、不改业务来源优先级 |

## 4. 旧诊断报告中被本文取代的部分

- 旧报告 §7 记录"在线受限：私有下载目录被沙箱拒绝、`dws` 读不到凭据，无法确认入口是 `wiki.md` 还是
  `wiki.adoc`"。**本文实读确认入口是 `.adoc`**，该"在线受限"一条由本文取代。
- 旧报告基于源码的流程表与工具契约仍有效；只有"在线部分无法确认"这一条被取代。
- 旧报告的推荐项中，`--background` / 复用自有窗口、列表快照复用、案例评估语义等已落到现行实现，
  以现行 `workflow.md` 与 `SKILL.md` 为准。

## 5. 当前仍存在的真实限制（不许当成"已就绪"）

- **模板**：模板索引里的住宅工作簿当前只作**结构参考**，待修复与重算验收，**不能据此自动计价**；
  收益法 / 成本法没有单独验收过的模板。该限制要进 `manual_confirmation_items[]` 与报告 `limitations[]`。
- **通用 checker**：没有随包七表 profile；`references/06-workbook-contract.md` 的七表清单是**历史结构参考**，
  不是当前默认契约。
- **数值规则自动执行**：解析器目前只认围栏 JSON 段（`stage=parameters`）。正文只有普通表格 / 行文、
  没有该段时，记为**适配器契约缺口**，**不等于**"知识不存在"，也不是要求业务维护者必须补 JSON；
  普通阅读与引用照常，只是"自动执行数值"这一档未就绪。
- **来源适配器**：注册表只有 `fang` / `anjuke` / `lianjia`；业务库来源策略若点名 58 等，属于未实现缺口。
- **平台**：真实业务站点在线验收与 Windows 运行时**未验证**；Safari / Firefox 无法用 CDP 驱动。
- **截图**：macOS 实测把自有窗口**最小化**会让 `Page.captureScreenshot` 超时；后台取数因此用**正常态、
  不主动抢焦点**的自有窗口，而不是最小化窗口，也**不承诺**操作系统层面完全不可见。

## 6. 已验收事实 [验收]

### 6.1 浏览器背景口径

- `crwu browser fetch/shot` 默认 `--background=true`：复用同一个**自有后台窗口**，普通页面不 focus；
  只有人工验证 / `login` / `open` 才把该自有窗口带到前台。`--background=false` 显示**同一个**自有窗口，
  不是另起浏览器。
- **macOS 实测（Edge 155，隔离探针）**：正常态后台窗口连续 3 次截图 + 同目标复用成功；
  生产 `Screenshot(ctx, true)` 隔离抓取成功（PNG 15780 bytes，没有用 `Page.enable` / emulation / 额外 flag）。
- supervisor 已跑过的聚焦证据：Go CLI 新增聚焦用例、`browser` 全量套件、Host BrowserClient + capture 的
  Node 用例、TypeScript、`docs-check`（36 个入口）、`git diff --check` 通过。

### 6.2 构建与门禁（supervisor 实际执行）

- `make test`：全部 Go 用例通过（CLI 段约 3.402s）。
- `make plugin-bin`：macOS arm64 与 Windows amd64 构建通过，6 个二进制的装配检查通过。
- 构建出的 `crwu scheme`：JSON 输出、退出码 0、stderr 为空；示例含 `--background`。
- Windows `browser` 测试**交叉编译通过**（只编译，未在 Windows 上运行）。
- **最终 `make plugin-check` 尚未运行**；上述聚焦 / 编译结果不能外推为真实房源站点或 Windows 运行时通过。

### 6.3 后续验收补记（本次中断会话复盘开始前）

上节保留当时记录。随后 supervisor 实际完成 `make plugin-check`，退出码 0：Node 2,590 项，
2,589 通过、0 失败、1 跳过（macOS 没有 PowerShell，Windows 专属运行项未执行）；构建、
内建 smoke、普通与严格打包断言、各非 vendored Skill 层校验及 Python 套件均通过。
`make docs-check` 与 `git diff --check` 同样通过。

该结果属于 0.0.48／协议 42 的上述变更。后续
[中断会话复盘](2026-10-16-valuation-interruption-review.md) 引入的修复需要重新验收，不能沿用本次通过
作为新修复的完成证明。真实房源站点与 Windows 运行时的未验证边界保持有效。
