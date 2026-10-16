# Wiki 驱动估值重构 Implementation Plan

> **状态（2026-10-15 交付后回填）**
>
> - **Slice 1（通用入口与输入交接）**：已完成并有回归。估值改为一级页（无房地产二级导航）、
>   资产类型下拉初始为空且未选不能确认、四种方法全部开放、进页面不探测来源、能力区取代门禁屏、
>   `assetType` 进冻结输入（`crwu.valuation.input.v3`）。协议 38 → **39**，清单不变（54）。
> - **Slice 2（链家登录从门禁改为可选能力）**：已完成并有回归。`sites.ts` 删除"空必需集 = 全部必需"、
>   `decidePhase` 三类结论都不阻断、能力状态带 `checkedAt`、配置里链家改为可选、
>   交接指令带**来源策略与原因**（不再固定空数组）。
> - **Slice 3 的一部分（Wiki 受控读取）**：已完成**库内相对链接**这一层。新增
>   `knowledge/wiki-links.ts`（纯函数：基准解析、越界/绝对/外部/锚点分类）与回归，
>   并把它接进 `crwu_valuation_knowledge_materialize` 的正文条目（`entries[].links[]`）；
>   `references/knowledge-routing.md` 重写为**唯一入口 Wiki 声明 + 读取契约**，SKILL.md 同步。
>   **未完成**：退出旧 manifest 链（`knowledge/manifest.ts` + 配置 `manifestPath` 仍是当前取数入口）。
> - **Slice 4.5（多方法与结果协调）**：**已完成并有回归**。`coverage.ts` 删除「仅住宅 + 市场法」
>   覆盖门禁（物业类型归知识判定，方法可执行性改逐方法能力事实）；`methods.ts` 的 `auto` 采用
>   **全部"知识判定适用且当前能跑"的方法**（单一或组合），业务适用但跑不了只记能力缺口、不误伤；
>   `task-graph.ts` 每个采用方法一个任务；结果 Schema 新增 `methods[]` / `methodResults[]` /
>   `methodCoordination`，`validate_result.py` 逐条校验（adopted 集合一致、逐方法留痕、
>   多方法不许 `single`、加权必须有理由、`component-sum` 要点名互斥组件）；
>   报告数据与 HTML 新增逐方法结果表（"不相加、不默认平均"），旧结果仍可渲染。
> - **Slice 3.3（旧 manifest 退出）**：**部分完成**。`valuation.knowledge.wikiPath` 上线
>   （与技能声明的入口逐字一致）、工具结果交出 `entryWikiPath` 并在仍走槽位寻址时给迁移提示；
>   入口正文与库内相对链接都能解析。**未完成**：取数仍由 manifest 槽位驱动，
>   还没有"按 Wiki 链接路径直接取数"的工具入参。
> - **Slice 4.1 / 4.2 / 4.3（来源阶梯、地区解析、检索预算）**：**已完成并有回归**。
>   58 同城（`wuba`）进来源枚举与站点定义，并新增 `ProviderSite.evidence`
>   （`archived-capture` / `public-pattern`）如实登记"有没有归档字节"；`public-pattern` 的来源
>   本轮必须带一条"尚未真机验收"的能力缺口。Host 持久预算（`market/budget.ts` +
>   `取数预算.json`）实现"同组同轮每来源 10 页 / 20 条，任一触顶即停，换词 / 重试 / 恢复都不重置"，
>   同源重复条目按来源内身份去重。城市解析拆成 `resolved` / `not-covered` / `invalid` /
>   `unavailable`：链家城市表不覆盖 = **该来源不覆盖**（跳过它、触发替代来源），
>   不把整个输入判非法，也不擅自换城市。
> - **Slice 4.7（真实重算）**：**执行半未完成**。已完成：`enginePath` 配置 + 只读探测 +
>   finalize 的**可证伪判据**（探测不到引擎时，模型自写的"重算成功"记录判 `failed`，
>   报告只能 `partial`）。**未完成**：真正调用引擎重算并回读数值的受控执行（命名 Broker 操作 +
>   回读脚本）。
> - **Slice 4.8（少案例、候选编号、新版复算）**：**已完成并有回归**。新增候选编号册
>   （`market/candidates.ts`：按身份发号、只增不重用、跨轮次稳定、退休保留编号）与修订索引
>   （`delivery/revision.ts`：父版本 / 变更原因 / 采用编号 / 知识·模板指纹 / 检索轮次 / 规则版本；
>   新版本 `pending` 不动指针、重复提交幂等、失败占号回滚、提升须带**本版**核对回执且上一版转
>   `superseded` 保留），并接成 Tool `crwu_valuation_revision`
>   （`op=candidates|list|recompute|promote`）；`finalize` / `artifact-validate` 新增 `revision` 入参，
>   交付件按 `修订/<n>/` 隔离，提升时对**那一版自己**的交付件跑 Host 完成判定。
>   固定指令新增「少案例与用户复算」一段（按编号选例、默认不重搜、旧版一律保留）。
> - **Slice 4.6（模板按自身填写说明校验）**：**已完成并有回归**。`check_workbook_contract.py`
>   新增**通用通道**（`--contract` / 自动发现 `<workbook>.contract.json`）：契约由模板自己的
>   填写说明声明表与角色、输入位、结果位、单位位、允许为空的格子、是否在意顺序与模板字节指纹；
>   通用校验只查通用正确性（可见表、无外部链接、无错误值、输入位不许是公式、结果位必须有公式或数值、
>   公式区真的有公式、允许为空不许填 0、单位一致、指纹一致），**不**假定表数量 / 顺序 / 业务公式 / 阈值。
>   `build_workbook.py` 的输入区判定同样支持契约，两条通道都保证公式保护、拒写公式、空值不写 0。
>   新增 14 条 Python 回归（含一份三表、无填充色、无业务公式的合成模板）。
> - **Slice 4.7（真实重算 执行半）**：**已完成并有回归**。新增命名 Broker 操作
>   `system.valuation-recalculation.run`（提权 shell，命令由 Host 拼）；`runConfiguredEngine()`
>   用配置的表格程序把底稿**转换一次**（打开即重算，产物落临时目录、原底稿不动），再用
>   技能脚本 `read_workbook_values.py` 以 `data_only=True` **回读缓存值**；新增 Tool
>   `crwu_valuation_recalculate` 由 **Host 自己**跑引擎、回读、比对并写 `重算结论.json`
>   （`producedBy: 'host'`，期望值取自报告数据、位置按模板填写说明由调用方提交）。
>   没有配置引擎时写 `unavailable` + 只能 `partial` —— 模型写不出"重算通过"。
>   新增 10 条 Host 回归 + 5 条 Python 回归。**本机没有安装表格计算程序**，真机验证仍待做。
> - **Slice 3.3（manifest 链路退出主通道）**：**已完成并有回归**。知识工具新增 `wikiPaths`
>   （主通道：入口 Wiki 的库内相对路径 + 正文里的 `links[]` 作为下一跳），`routeIds` 降为遗留通道
>   并在取正文时给出迁移提示；取数层在 `wikiPaths` 存在时**不再要求 manifest 可读**
>   （manifest 读不到只是"没有槽位清单可回报"），新增 `wikiRouteFromPath()` 由路径推路由与形态，
>   绝对路径 / `..` / 未知后缀一律拒绝；落盘段名安全化（路径里的 `/` 不进目录名）。
>   新增 5 条取数层回归 + 1 条工具接线回归。**业务知识库侧仍需发布入口 Wiki 与各正文**。
> - **Slice 4.3（列表先筛 / 跨站去重 / 优选与剔除理由）**：**已完成并有回归**。新增
>   `market/select.ts` 与 `crwu_valuation_market_search` 的 `selection` 入参：名额 / 优先级 /
>   渠道顺序全部来自知识（缺一项即拒绝，没有默认值）；机械地做硬性排除（挂牌 / 无证据）、
>   确定性排序（逐级比较 + URL 兜底）、名额截断（落选理由到名次与名额），且**不改变** `cases`。
>   新增 8 条纯函数回归 + 1 条工具接线回归。
> - **Slice 4.2（各来源独立解析地区）**：**已完成并有回归**。新增 `market/city-sources.ts`
>   逐来源登记城市表（来源页 / 标识进 URL 的方式 / 依据 / 是否已适配），判定改为查表而不是
>   把链家列表当成所有来源的映射：只有**自己那份表已适配**（目前只有链家，有归档字节）才可能
>   得到「该来源不覆盖这个地区」；安居客 / 58 同城 / 房天下如实记**"城市表尚未适配"的能力缺口**
>   并写明**不是**"不覆盖"。逐来源结论新增 `citySourcePage` / `citySourceEvidence`。
>   新增 5 条回归。
> - **少案例口径（设计稿 §6.1 / §6.2）**：**已修正并有回归**。`calculate_market.py` 原先在
>   "可采用案例少于知识要求"时把金额清空，与 §6.1 相抵；现在只有**一条可用依据都没有**时
>   才不给金额，数量不足时照常计算并标 `provisional` + `provisionalReason` + 缺额进 `ruleChecks`。
>   同时补上"案例单价必须为正"的校验（0 元单价会算出 0 元"比准价格"）。
>   `test_calculate_market.py`（生产计算入口 17 条契约）**此前不在门禁里**，已加进 `make plugin-check`。
> - **门禁（协议 39 续）**：`make plugin-check` 在**干净机器**上通过。原先它在
>   `kb_tool.py validate --skill-root common/skills` 处报 `~/.crwu/knowledge` 路径不存在 ——
>   那是 crwu-dws 的**运行时缓存根**（M1/M3 才创建、不随包发布），相邻的 `dws-dir-cache` 早已豁免、
>   父目录漏了。现在豁免覆盖缓存根与已登记的缓存层；未登记层下的本地路径（把正文当本地文件引用）
>   仍然照拦。另把技能维护器的校验目录纳入验收矩阵的"原话逐字存在"语料。
> - **Slice 4 其余**：**代码侧无剩余**。剩下的是**真机验收**与**业务知识库发布**（都不是本机可做的动作），
>   逐项见 `docs/acceptance-0.0.45.md` 末节与 `CHANGELOG.md` 的「未完成」一段。
>   [`plugins/dsh-crwu-workbench/docs/acceptance-0.0.45.md`](../../../plugins/dsh-crwu-workbench/docs/acceptance-0.0.45.md)
>   末节与 0.0.45 变更日志的「未完成」一段（真机验收 + 各来源城市表的实测依据补齐、
>   业务知识库侧的入口 Wiki 与正文发布）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把估值从「固定清单路由 + 二级导航 + 登录门禁」改成「用户确认输入 → 资产 Skill → 唯一 Wiki 入口 → Agent 按条件读正文 → 调用已注册能力执行 → 可复核结论」，并按已确认的产品行为重排来源阶梯、预算、多方法与复算。

**Architecture:** 业务编排归知识库 Wiki（Host 不解析业务决策树）；Skill 只持有资产职责、Wiki 入口、能力说明与技术契约；Host 持有真实工具能力、权限与作用域、来源状态、预算与计算/交付校验。CLI 与 MCP 是传输，provider 彼此不导入。

**Spec:**
- [`2026-10-15-valuation-wiki-driven-workflow-design.md`](../specs/2026-10-15-valuation-wiki-driven-workflow-design.md)
- [`2026-10-15-valuation-wiki-driven-knowledge-plan.md`](../specs/2026-10-15-valuation-wiki-driven-knowledge-plan.md)
- 交付目录：[`docs/knowledge-drafts/2026-10-15-valuation-wiki-delivery/`](../../knowledge-drafts/2026-10-15-valuation-wiki-delivery/README.md)

**取代：** [`2026-10-15-valuation-knowledge-wiki-routing.md`](2026-10-15-valuation-knowledge-wiki-routing.md)
（同日旧版「知识库侧固定 JSON manifest 路由」方向）。旧计划保留为历史，不再作为实施依据。

## Global Constraints

- **`TODO` 与真实能力分开记。** 「Wiki 已经写了」不等于「适配器已经实现」；缺能力一律记能力缺口，不伪造。
- **不读 `_manifest.json`，也不退回旧内置正文或未经验证的本机导出**。正文只来自知识库（`dws`）或身份已验证镜像。
- **保留的正确性不变量**（不得削弱）：数字由脚本算不心算；空栏不填 0；模板只读、公式区不许硬编码；模板字节验真；案例来源不可核要标剔除；案例目录隔离与工具可见性；交付件按方案隔离。
- **业务阈值、来源优先级、方法优先级不进 TS / prompt / Skill**：它们只能来自本轮知识快照。
- 改动 Host/Client 跨进程字段 → 递增 `WORKBENCH_PROTOCOL` 并更新冻结操作清单。
- 提交信息用 Angular 规范英文格式，不加 `Co-Authored-By`。**不自动 commit / push / tag / publish。**

## 现状核查（2026-10-15 工作树）

工作树里有 230 个未提交改动，`npm test` 基线 **2314 通过 / 0 失败**。已实现的是 10-14 那一代设计
（二级导航、登录门禁、manifest 路由）。本计划是**在其之上改判**，不是从零重写。

| 边界 | 现状 | 本次目标 |
| --- | --- | --- |
| 二级导航 | `navigation.ts` 的 `valuation` 有 `valuation.real-estate` 等三个子项 | 估值直接是通用页，无二级导航 |
| 资产类型 | 不存在该字段 | 下拉、初始空、未选不能确认 |
| 方法 | 界面禁用收益/成本；`methodSupported` 只放行 auto/market | 四项全开放 |
| 能力区 | 整页门禁屏（`checking-auth`/`auth-blocked`），进页自动探测链家 | 页下能力区 + 抽屉内独立查询；进页不探测 |
| 登录门禁 | `sites.ts` 空必需回退全部必需；`decidePhase` 整轮 `canProceed:false` | 可选能力，不阻断 |
| 知识入口 | 库侧 JSON manifest（`manifestPath`） | 唯一 Wiki 入口 + 库内相对路径链接 |
| 来源 | 仅 fang/anjuke/lianjia；`providers` 可为空数组 | 真实 58、按来源解析地区、持久预算、来源策略交接 |
| 方法编排 | auto 恒选 `executable[0]`；结果强制恰好一个 adopted | 多方法分别记录 + 按 Wiki 协调 |
| 计算 | `delivery/recalculation.ts` 有接口无生产调用；`finalize-facts` 读模型可写 `verified` | 受控引擎真实重算 + 回读；无引擎如实报未完成 |
| 修订 | 无 | 最小修订记录 + 当前版本指针 |

---

## Slice 1：通用入口与输入交接

### Task 1.1：导航改成一级页（`估值` 直接是页面）

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/client/shell/navigation.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/shell/module-store.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/shell/WorkbenchPanel.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/client/locales/zh-CN.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/client/client-valuation-handoff.test.mjs`

- [ ] **Step 1：写失败测试。** `childNodes('valuation')` 为空数组；`nodeById('valuation').page === 'valuation'`；
  `defaultNodeOfModule('eval').id === 'valuation'`；`parentNodes('eval')[0].id === 'valuation'`；
  断言旧 id `real-estate-valuation` 不再出现在 `NAVIGATION` 里。
- [ ] **Step 2：跑测试确认失败。**
- [ ] **Step 3：实现。** `PageId` 用 `'valuation'` 取代 `'real-estate-valuation'`；`valuation` 一级节点带
  `page` 且 `children: []`；`parentNodes` 允许「有页面的无子项目录」；`firstEnabledChild` 在无子项时
  返回一级节点自身；`landOn` 的 `parentId` 在 `parentOf === null` 时取节点自己；删除
  `valuation.land` / `valuation.equipment`（未实现的资产由资产类型下拉承载，不再占目录）。
- [ ] **Step 4：跑测试确认通过。**

### Task 1.2：资产类型下拉（初始为空）

**Files:**
- Modify: `src/shared/contracts/report-evaluation.ts`、`src/shared/wire/report-evaluation.ts`
- Modify: `src/client/modules/report-evaluation/model/valuation-state.ts`
- Modify: `src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx`
- Modify: `src/host/...`（intake 预览 + 冻结输入）
- Test: `tests/unit/client/client-valuation-pane.test.mjs`、`tests/unit/host/host-valuation-intake.test.mjs`、
  `tests/unit/shared/valuation-field-contract.test.mjs`

- [ ] **Step 1：写失败测试。** 初始 `state.assetType === ''`；未选资产类型时 `startDisabledReason` 非空且
  `canStart === false`；`setAssetType('real-estate')` 之后原因消失；线协议断言
  `ASSET_TYPES` 与 `AssetType` 一致；Host 预览/冻结输入带 `assetType`。
- [ ] **Step 2：跑测试确认失败。**
- [ ] **Step 3：实现。** `AssetType = 'real-estate'`（稳定业务标识，显示文案不承担路由）；
  `initialValuationState().assetType = ''`；`startDisabledReason` 增加资产类型判据；
  `估值输入.json` 增加 `assetType`（进摘要）；`setAssetType` 保留共用输入。
- [ ] **Step 4：跑测试确认通过。**

### Task 1.3：四种方法全部开放

**Files:**
- Modify: `src/client/modules/report-evaluation/model/valuation-state.ts`
- Modify: `src/client/locales/zh-CN.ts`、`ValuationIntakePane.tsx`
- Test: `tests/unit/client/client-valuation-pane.test.mjs`

- [ ] **Step 1：写失败测试。** `valuationMethodOptions().map(o => o.disabled)` 全 `false`；
  `setMethod('income')` / `setMethod('cost')` 被接受；`methodSupported` 四项皆真。
- [ ] **Step 2–4：** 实现并跑通；删除 `valuationMethodDisabledNote` / `valuationScopeNote`
  「当前支持住宅市场法」这类**能力声明文案**（能力事实改由能力区与知识缺口表达）。

### Task 1.4：能力区（页下）+ 进页不探测 + 抽屉内独立查询

**Files:**
- Modify: `src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx`、`controller.ts`、`api.ts`
- Modify: `src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx`
- Modify: `src/client/modules/report-evaluation/model/valuation-state.ts`
- Modify: `src/shared/contracts/report-evaluation.ts`（能力视图带 `checkedAt`）
- Test: `tests/unit/client/client-valuation-scope.test.mjs`、`client-valuation-pane.test.mjs`

- [ ] **Step 1：写失败测试。** 挂载页面**不**调 `valuation-browser-preflight`；打开确认抽屉时调一次；
  `capability.checkedAt` 非空；能力区显示登录/验证入口且**不**出现整页门禁屏。
- [ ] **Step 2–4：** `initialValuationState().phase = 'draft'`；删除 `checking-auth`/`auth-blocked`
  作为**必经**阶段（保留词表以兼容旧宿主回执，但页面不再停在那里）。

## Slice 2：链家登录从门禁改为可选能力

### Task 2.1：`sites.ts` 不再「空必需 = 全部必需」

- [ ] 写失败测试（空 `requiredSiteIds` → `required: []`，不是全部站点）。
- [ ] 实现：删除 `if (required.length === 0) return { required: sites.map(...) }` 回退。
- [ ] 配置 `requiredSiteIds: []`（链家改为可选）。

### Task 2.2：`decidePhase` 不再阻断整轮

- [ ] 写失败测试：`unauthenticated` / `unknown` 时 `canProceed === true`，原因分类保留
  （`needsLogin` / `unconfirmed` / `failed` 各自可读）。
- [ ] 实现：把「暂停等人」降级为「记录来源策略与原因，继续替代来源」。

### Task 2.3：能力视图取代门禁结论

- [ ] 写失败测试：`valuation-browser-preflight` 的应答带 `checkedAt` 与逐站事实，
  **没有** `released` 这一档拦截语义；未登录时页面照常可确认。
- [ ] 实现：`AuthGateView.released` 的拦截语义下线（保留字段兼容旧宿主，但不再参与禁用判据）。

### Task 2.4：来源策略随交接交给父会话

- [ ] 写失败测试：交接指令里出现逐来源的「可用 / 跳过 / 待确认 + 原因」，且**不再**出现
  写死的业务筛选阈值与平台优先级。
- [ ] 实现：`prompt.ts` 的来源段改为「来源策略 + 原因 + 引导读 Wiki 的 `03 案例选取/01 渠道与降级策略`」。

## Slice 3：Wiki 受控读取与旧 manifest 退出

### Task 3.1：库内相对路径链接解析（纯函数）

- [ ] 写失败测试：`<01 房地产估值通用/01 输入与资料解释.md>` 以当前文档库内目录为基准解析；
  `../` 越界、绝对路径、找不到同名节点分别报告；同名歧义列出全部候选且**不选第一份**；
  折叠只做连字符↔空格与全角↔半角。
- [ ] 实现：`src/host/domains/report-evaluation/knowledge/wiki-links.ts`。

### Task 3.2：受控节点/正文/章节读取工具

- [ ] 写失败测试：按路径读正文返回片段摘要 + 读取时刻 + 远端更新时间；列节点；缺权限/空正文/歧义
  分别返回结构化状态，不整体失败。
- [ ] 实现：`tools/report-evaluation/catalog.ts` 增加按路径读取；新 Tool 暴露给模型。

### Task 3.3：退出 manifest 链

- [ ] 写失败测试：旧配置键 `valuation.knowledge.manifestPath` 仍在时给出**迁移提示**且不静默当作
  新入口；manifest 解析不再参与业务取数。
- [ ] 实现：配置迁移 + 工具改造 + Skill `references/wiki-entry.md`。

## Slice 4：来源阶梯、预算、多方法、真实计算、修订

按验收矩阵逐项落地；**未接通真实能力的一律如实记能力缺口**，不得以「Wiki 已写」冒充已实现。

- [ ] 4.1 真实 58 provider + 解析 + 验收夹具。
- [ ] 4.2 各来源独立地区解析；不覆盖 ≠ 输入非法。
- [ ] 4.3 Host 持久预算（同组同轮 10 页 / 20 条，任一触顶即停；换词/恢复不重置）。
- [ ] 4.4 列表先筛、跨站去重、优选 3 条与剔除理由。
- [ ] 4.5 多方法：覆盖矩阵、`auto` 多选、任务图按方法、结果 Schema 去「恰好一个 adopted」。
- [ ] 4.6 模板按自身填写说明校验（不固定七表/固定阈值）。
- [ ] 4.7 接通受控计算引擎 + 结果回读；无引擎时 `partial`。
- [ ] 4.8 候选编号选例 → 新 revision，旧版保留，当前版本指针更新。

## 验证

```bash
cd plugins/dsh-crwu-workbench && npm run check
cd /Users/mungdong/code/github/mungdong/crwu-ai && make plugin-check && make test && make docs-check && git diff --check
```
