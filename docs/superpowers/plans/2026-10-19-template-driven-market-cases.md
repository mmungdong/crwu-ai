# Template-driven Market Case Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Preserve the existing local DSH implementation worker and supervisor-owned tests/review through dsh-orchestrator. Steps use checkbox (`- [ ]`) syntax for tracking. No commits without explicit user instruction.

**Goal:** 让明确指定的房地产市场法按所选模板与方法知识形成案例需求，取得、补读、筛选并交付可核对的案例组与缺口。

**Architecture:** 保留宿主无关的领域层，将模板字节检查、脚本和网页读取放在外层适配器。新增有独立判别字段的案例采集方案，不放宽现有计算方案验真；候选池保留缺字段记录，只有满足计算输入要求的采用集合才能进入计算。已有挂牌参考算法保持明确身份，不能自动顶替原模板市场法。

**Tech Stack:** TypeScript、Node内置测试、既有DSH推理/Tool/Broker、DSH配置的Python与既有openpyxl；不新增安装依赖。

**Spec:** [已获方向批准的设计草案](../specs/2026-10-19-template-driven-market-cases-design.md)。2026-10-19用户回复“按此方向改造”；本计划尚待审阅。

## Global Constraints

- 资产类型和方法仍由用户明确指定，不恢复任何自动方法选取。
- 网页可取得事实、共享社区事实、专业判断、衍生计算、机构参数分开存储。
- 所有真实业务I/O继续经过既有作用域与Broker。
- 不复制线上原始业务材料作为仓库测试fixture，不读取凭据，不直接操作用户活动环境。
- 原模板只读保留。未通过独立计算及目标引擎重算验收前，不声明可以自动出具最终估值。
- 不新增外部命令依赖；Python及openpyxl首次使用前探测，缺失或失败须给出结构化原因。
- Host/Client字段变化增加协议号，保留旧任务的真实未知状态；不静默填默认值。
- 沿用当前脏工作区及用户已暂停其他写入会话的约定，不创建丢失既有改动的替代checkout；不提交、推送、发布。
- 测试夹具全部合成。最终实机重启与业务确认由用户执行；本机只能声称macOS已验证，Windows未实际执行时明确注明。

## Review Focus

- 原文件在解读后被替换：Task 1与Task 5验证摘要改变后映射及批准失效。
- 模板列多于三个、字段重名、合并标签或缺页：Task 1与Task 2验证歧义可见且不套固定住宅映射。
- 列表无单价但有价格/面积或详情链接：Task 3验证保留待补候选，不在详情读取前丢弃。
- 首条可用而后续来源失败、取消或重启：Task 3与Task 4验证已有记录保留，预算和恢复任务不丢失。
- 原模板公式不可执行、挂牌/成交混合、日期原义不同：Task 2与Task 5验证可采集与可计算分开，不能自动降为均价并完成。

---

## 文件与共享接口

新领域类型放在 `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/case-collection.ts`；跨进程投影类型放在现有 `src/shared/contracts/valuation-workflow.ts`，不让领域层依赖DSH或Python。

统一接口名称：

- `TemplateProfile`：`templateId`、`digest`、`relativePath`、`sheets`、`cells`、`definedNames`、`coverage`；单元格带`sheet/cell/value/formula`，覆盖不足须显式登记。
- `TemplateRequirement`：`fieldId`、`label`、`labelRef`、`targetRefs`、`category`、`applicability`、`criticalFor`、`basis`。`category`为`source-fact/shared-fact/judgment/derived/calculation`；`criticalFor`区分`eligibility/calculation`。
- `TemplateRequirements`：模板身份/摘要、版本、逐项需求及未决问题；字段与目标位置只能取自已验真的`TemplateProfile`。
- `CaseFieldFact`：`value`（字符串/数值/布尔/null）、`status`（`verified/missing/conflict/not-applicable`）、`evidenceRefs`；不适用需有依据，不能把缺失改为不适用。
- `CaseCandidate`：`caseId`、`providerId`、`sourceUrl`、`fields`、`evidence`、`duplicates`、`status`（`pending/eligible/nearby/rejected`）、`missingFields`、`reason`。
- `CollectionPlanContent`：`kind: 'case-collection'`、对象/用途/价格性质/地域范围、`templateRequirements`、知识依据、渠道与业务预算/停止规则。没有计算金额或已执行公式声明。
- `CollectionReceipt`：`candidates`、`attempts`、`coverage`、`stopReason`、`nextAction`、`resumeTasks`；明确`enough/no-more-pages/budget/access-gap/waiting-user/cancelled`等终止或暂停事实。

以上结构均严格验证、不接受任意额外策略代码。证据引用包含实际来源身份、摘要和可校验位置；没有证据的模型判断不能成为`verified`事实。

### Task 1: 只读模板解读与需求绑定

**Files:**
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/inspect_template.py`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_template_inspection.py`
- Create: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/services/template-inspection.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/case-collection.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/ports.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/inference.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-template-requirements.test.mjs`

**Interfaces:**
- Produces: `inspectWorkflowTemplate(input, deps, principal): Promise<{ok, profile?, errorKind?, error?}>`；input只有登记的模板身份与本轮planId，模型不能提交任意绝对路径。
- Produces: `bindTemplateRequirements(candidate, profile, knowledge): {ok, requirements?, gaps}`；验证模板摘要、单元格存在、标签原文和逐项知识依据。
- Consumes: 既有`stagedValuationScript`、`requireBoundValuationActor`、配置Python探测、`deps.access.runShell`、已登记上传件或`templateMaterialize`回执。
- 新增隔离推理operation `template-analysis`，通过现有推理接口提供profile与已验真方法知识；严格结构化输出，禁止调用业务工具。

- [ ] **Step 1: 写合成工作簿与绑定红测。** 两个模板的字段不同、列数不同，需求应随文件变化；包含合并标签、重名标签、损坏ZIP、摘要替换、无来源位置和覆盖截断。核心断言：`assert.equal(bindTemplateRequirements(forged, profile, knowledge).ok, false)`。
- [ ] **Step 2: 运行红测。** `node --test plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-template-requirements.test.mjs`；Python用已探测的解释器执行新测试。必须因缺实现或错误绑定失败。
- [ ] **Step 3: 实现只读脚本和受控服务。** 使用openpyxl读取结构、标签、公式与定义名称，不保存工作簿、不重算、不自动修复；限制工作表/单元格/文本覆盖并显式回报截断。脚本按固定包路径暂存，经Broker运行，输出JSON且无敏感诊断。读取前后验证摘要。
- [ ] **Step 4: 实现隔离分析与领域绑定。** 模型只提出需求与分类；缺少可验证标签、范围或方法依据时返回具体未决问题，不能套内置七表/住宅字段。公式可执行性独立记录，不能阻止只读登记采集需求。
- [ ] **Step 5: 运行绿测与类型检查，检查原模板字节未变。** `npm --prefix plugins/dsh-crwu-workbench run typecheck`；新脚本随所属Skill自足性门禁一起验证。

### Task 2: 将采集方案与计算方案分开验真

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/shared/contracts/valuation-workflow.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/case-collection.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/plan.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/production/planning.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/market.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/inference.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-collection-plan.test.mjs`

**Interfaces:**
- Consumes: Task 1的`TemplateProfile/TemplateRequirements`。
- Produces: `validateCollectionPlan(candidate, context): {ok, plan?, gaps}`与`CollectionPlanContent`；采用有判别字段的方案联合类型，已有计算方案校验不放宽。
- 采集方案摘要纳入模板摘要、需求、对象与当前修订、知识、范围、价格性质、渠道、预算和停止规则。确认仍绑定`expectedRevision/planDigest`。

- [ ] **Step 1: 写红测。** `assert.equal(validateCollectionPlan(validCollectionWithZeroCases, context).ok, true)`，同时已有无数字来源的计算方案仍失败。断言模板解读先于任何搜索；仅登记文件路径不等于模板可用；假渠道、无知识依据的数量/范围、挂牌偷换成交均拒绝。
- [ ] **Step 2: 执行红测。** `node --test plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-collection-plan.test.mjs plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-plan-approval.test.mjs`。
- [ ] **Step 3: 实现方案编排。** 从现有来源清单选定登记模板后立即解读，再生成采集需求及方案；选路径时不把“尚未检查公式”当成永久不可读取。来源预检只报告实际能力与恢复事实，不要求先取得合格案例组；正式采集放到证据节点。
- [ ] **Step 4: 实现严格校验与确认身份。** 业务数量和阈值必须有本轮知识/明确用户输入支撑。模板三个版面槽位不构成硬上限；挂牌参考只在明确采纳该路线时成立。计算算法尚未具备时保留能力缺口，不先阻断可进行的资料采集，也不声明已能计算。
- [ ] **Step 5: 绿测与类型检查。** 保留所有原方案伪造/陈旧确认/摘要不匹配的负面测试。

### Task 3: 候选池、必要详情与有界补搜

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/production/case-collection.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/services/market-detail-reading.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/case-collection.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/production/evidence.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/valuation-workflow/inference.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/ports.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-template-case-collection.test.mjs`

**Interfaces:**
- Consumes: 已批准且摘要匹配的`CollectionPlanContent`，调用既有`marketSearch/marketCapture`注册工具。
- Produces: `collectTemplateCases(request, options): Promise<CollectionReceipt>`；候选中价格/面积允许缺失，不能强塞进要求正数单价的旧`ValuationObservedSample`。
- Produces: `readMarketDetail(input, deps, principal)`；只读已取证的案例内HTML/截图，验证字节摘要、最终URL与来源；先固定解析，必要时新增无工具隔离operation `market-detail-reading`，逐字段输出必须绑定实际原文或已接纳图像。
- Produces: `bindCandidateAssessment(output, candidate, requirements, knowledge): {ok, assessment?, gaps}`；隔离operation `case-assessment`提出判断，领域函数校验状态、实际字段与方法依据。事实校验与可比性判断分离，采用理由不冒充网页原文。

- [ ] **Step 1: 写红测。** 缺单价但有详情链接的列表项进入待补池；补读后字段覆盖改变，保留原始证据。`assert.equal(receipt.candidates[0].status, 'pending')`适用于必要事实仍未齐；没有依据不能变为`eligible`。同时覆盖详情改址、假引文、价格/面积单位冲突、日期原义、未知字段及跨站重复。
- [ ] **Step 2: 执行红测。** `node --test plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-template-case-collection.test.mjs`。
- [ ] **Step 3: 实现需求驱动采集。** 先列表筛除明确不符项，保留待补候选；只对拟采用且缺关键项的记录补详情。逐字段记录值、单位、来源和状态，不默认用途相同、日期相同、系数1或指数100。社区共性事实可以有据共享，不能冒充每户权益事实。
- [ ] **Step 4: 实现继续与停止。** 使用原取数预算和分页任务，不靠重复请求重置累计账；不足时按方案调用替代来源与下一有效页。10页/20条等本轮业务值由已验真知识提供，技术熔断另记原因。保留已取得候选；末页、预算、访问故障、待人处理及取消分别记录。1—2案只能在有依据且认可的受限路线内交出，不能补造第三案。
- [ ] **Step 5: 绿测与现有证据测试。** 原挂牌参考复用、未知来源、取消、详情尝试上限、合格预算及缓存守卫继续通过。

### Task 4: 节点状态、持久化与页面投影

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/service.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/persistence.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/workflow/views.ts`
- Modify: `plugins/dsh-crwu-workbench/src/shared/contracts/valuation-workflow.ts`
- Modify: `plugins/dsh-crwu-workbench/src/shared/consts.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/workflow/PlanPanel.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-collection-restore.test.mjs`
- Test: `plugins/dsh-crwu-workbench/tests/unit/client/client-workflow-collection.test.mjs`

**Interfaces:**
- DTO增加明确的采集方案、候选池和`CollectionReceipt`投影；方案确认继续精确绑定版本与摘要。
- `pending`事实保留为未知；陈旧模板/需求/对象/范围/价格性质会使相应采集批准和计算资格失效。
- 旧任务无候选字段时如实恢复为空/未知，不按旧参考样本反推已经填齐的模板字段。

- [ ] **Step 1: 写红测。** 候选与逐字段证据冷恢复保持一致；预算/待恢复页面不丢失；模板替换后批准失效。确认、取消、修订并发不能重复执行采集。初始输入快照不变。页面能区分“采集完成但有待补”与“可计算”。
- [ ] **Step 2: 执行红测。** `node --test plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-collection-restore.test.mjs plugins/dsh-crwu-workbench/tests/unit/client/client-workflow-collection.test.mjs`。
- [ ] **Step 3: 接线与恢复。** 证据节点消费批准的采集方案并登记真实回执；计算节点只消费经过需求校验的采用集合。待人动作明确字段/候选/来源任务，平台适配缺口不伪装成用户缺资料。
- [ ] **Step 4: 更新协议与投影。** 从执行时当前协议值加一，更新所属兼容与历史恢复守卫；沿用现有组件显示案例覆盖、逐案理由和停止/恢复动作。领域类型不引用Client，Client不读取本地文件或凭据。
- [ ] **Step 5: 绿测与旧任务回归。** 继续验证所有初始输入、确认回执、修订下游失效、旧协议拒绝及工作空间归属边界。

### Task 5: 组合回归、文档与实机交接

**Files:**
- Create: `plugins/dsh-crwu-workbench/tests/unit/host/host-workflow-template-cases-integration.test.mjs`
- Modify: `plugins/dsh-crwu-workbench/docs/valuation-workflow.md`
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`
- Update: 本计划勾选状态与私有运行目录`supervisor-notes.md`中的实际证据

**Interfaces:** 消费Tasks 1—4真实组合边界；不增加另一套模拟业务实现。

- [ ] **Step 1: 写组合红测。** 合成模板→需求→确认采集方案→两渠道列表→部分详情→去重选组→计算输入门禁；断言模板影响需求和补读，首条案例不提前结束整组采集，缺比较因素/价格还原依据的三案不能出正式结果。
- [ ] **Step 2: 增加恢复与失败组合。** 模板变更、来源A失败/B可用、取消后冷恢复、详情内容冲突、原模板含循环或无定义名称、挂牌与成交混合；断言候选不丢失、不虚增数量、不默默改算法。
- [ ] **Step 3: 运行定向绿测，核对可追溯清单。** 没有通过的场景逐项登记，不能用“工具可调用”代替案例字段取得成功。
- [ ] **Step 4: 执行完整门禁。** `make plugin-check`、`make docs-check`、`git diff --check`；检查最终diff中的作用域、生成文件与无关改动。按所属层验证Skill自足性。Windows未实际运行则明确标注仅macOS验证。
- [ ] **Step 5: 用户实机验收。** 用户重启活动DSH，沿用实际任务按已展示的新采集方案确认继续；核对真实模板摘要、实际候选字段/证据、补读和停止理由。不能为了测试绕过注册工具、手工改工作流数据库或把缺项补成默认值。

## 自检与不包含项

- 需求/来源/比较事实/预算/恢复/旧输入保留分别由Tasks 1—4落实，Task 5检验组合路径；五类Review Focus均有对应测试。
- 所有原始工作簿保持只读；本计划不修订税费规则，不制定机构系数，不承诺修复原模板所有公式，不实现收益法或成本法。
- 采集完成与市场法可计算分别验收。完整市场法计算和原生工作簿重算须后续具备相应能力并另行验证，不能由本计划的采集测试替代。
- 实施默认沿用本会话的本地DSH实现、监督方测试与验收方式；不启用额外GPT子代理，不自动提交。
