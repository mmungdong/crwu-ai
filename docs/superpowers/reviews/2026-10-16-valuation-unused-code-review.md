# 当前分支的未使用代码与估值 Skill 清理审查

> 历史审查快照，日期：2026-10-16。分支 `feat/valuation_1012`，HEAD `4c12b85`，包含本轮开始时的未提交和未跟踪源码。比较基线为本地 `origin/main`（`6cec75a`），未访问员工资料、实际知识库或生产 Profile。本轮只新增审查报告，未清理业务源码。

## 审查结论

确认存在应清理的代码和资源，但不能整目录删除。当前问题主要是：旧流程已退出生产入口，相关实现和测试仍保留；新版流程增加后，旧交付校验、本地模板和业务正文仍参与执行，形成互相冲突的契约；另有部分已实现、已测试的能力尚未接入生产流程。

建议先处理下面的 P1，再删除已确认的孤立模块，最后一起收敛 Skill 文档、模板、Schema、测试和打包断言。保留真实执行中的通用脚本；不能以 TypeScript 没有静态 import Python 为理由删除它们。

## 范围与判据

- 分支已跟踪差异：相对基线 488 个文件，另有 168 个未跟踪文件；以上是审查开始时的快照。
- 扫描当前 Workbench 全部 373 个 TS/TSX 文件，从 `src/index.ts` 和 `src/client/index.ts` 核对相对依赖，再逐项检查候选的生产引用、测试引用和包导出。
- 核对房地产 Skill 的脚本调用、脚本间依赖、Skill 指令、引用文档、JSON Schema、模板和打包断言。
- 扫描本分支改动涉及的 Go 函数标识引用，未发现可以仅凭“只有定义”直接删除的候选；这不等于完成全部 Go 行为审查。
- 测试引用、打包存在性断言、注释中的文件名，分别记录，不等同于生产调用。独立 Skill 的命令行入口和编译期类型契约另行判断。

这是一轮依赖和清理专项 CR，不声称逐行审查全部分支行为，也不以“全仓搜索未命中”单独证明文件可以删除。

## 需要先处理的审查发现

### F1 · P1：新版交付流程仍被旧结果 JSON 校验拦截

位置：`plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/artifact-validate.ts:267–272`。

方案子会话的实际指令（`execution.ts:121–124`）要求产出 `估值报告数据.json`、HTML、底稿和产物清单，再调用交付校验；新版 finalize 的 `FINALIZE_PATHS.reportData` 也读取 `估值报告数据.json`。但交付校验仍强制存在 `估值结果.json`，并执行旧 `validate_result.py`。按新指令完整交付仍会被报告“缺少交付件”。

旧脚本同时存在另一处已复现的契约冲突：`validate_result.py:48` 仅接受 `dws/local`，真实调用 `check_knowledge()` 时，`verified-mirror` 被拒绝、`local` 被接受；当前 Skill 和知识物化契约要求 `dws/verified-mirror`。

**建议：迁移后删除旧链路。** 将 artifact validate、handoff/prompt、文件常量与新报告数据统一，再移除 `validate_result.py`、旧结果模板/Schema 和相应兼容分支。不要先删脚本，因为它目前仍被注册 Tool 调用。若确需保留历史结果读取，应做独立只读迁移入口，不能继续作为新交付的必需产物。

### F2 · P1：随包住宅模板仍是默认入口，会静默带入业务参数

位置：`plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/build_workbook.py:42,149,224`。

Skill 的实际操作示例没有传 `--template`，脚本因而复制随包 `valuation-workbook.xlsx`。该文件并非空白输入模板，包含 `B12=0.09`、`B21=24`、`B24=0.1`、`B25=0.06` 等预置值；生成器 `build_workbook_template.py:96–116` 明确写入了这些默认参数。

**真实复现：** 只提供 `{"cells":{"基础信息表!B5":"review-fixture"}}`，运行 `build_workbook.py` 成功输出底稿，上述四个未提供的输入值原样保留。该行为与“参数仅来自本轮知识快照、未知值保持空白”的当前要求冲突。

**建议：收敛到已验真的本轮模板。** 让生产填表显式接受已物化模板及其契约，移除随包业务模板的默认兜底。若旧七表模板仍有回归价值，可与生成器一起移入测试 fixture；同步取消 Skill 和包断言对其生产可用性的承诺。不能把这一组标成“完全没使用”。

### F3 · P2：Skill 中保留了第二套已经失效的业务指令

位置：`plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/template/模板索引.md:3–21`。

这个文件没有生产读取调用或当前入口链接，却自称“唯一索引源”，要求所有模板固定七表、单项目最多两个模板、模板缺失时回落本地基线。当前 `references/knowledge-routing.md` 要求按入口 Wiki 和实际对象/方法取模板，不限制一项目两个；通用工作簿契约也已允许模板自行声明结构。它是可以误导 Agent 的旧指令，不能继续随生产 Skill 发布。

`references/01/02/03/04/05/07` 对应的旧文档也仍保存方法选择、计算、税费和取值等业务正文；其中 `03-income-method.md`、`07-cost-method.md` 甚至未声明其历史身份。当前 Skill 一方面声明“不内置业务正文”，另一方面仍按编号指导读取这些规则，并在执行步骤直接写出固定限值。

**建议：** 从发布 Skill 中删除旧模板索引和旧业务正文；先将必要的字段/技术说明归并到当前技术合同，修正 Skill 的编号引用和内嵌限值。仓库需要历史留档时单独归档并标记历史，避免保留在可执行 Skill 的活动参考目录里。

### F4 · P2：旧 UI 和预检实现脱离生产，却继续被测试维护

以下模块从两个打包入口均不可达，且包未导出这些源码路径：

| 文件（均相对 `plugins/dsh-crwu-workbench/`） | 引用证据 | 建议 |
| --- | --- | --- |
| `src/client/modules/report-evaluation/ui/SingleSelect.tsx` | 仅估值页面/下拉测试引用；真实 `ValuationIntakePane.tsx:539,572` 已使用共享 `Select` | 删除包装层；行为测试迁到实际共享控件或真实页面，避免继续测旧组件 |
| `src/host/domains/report-evaluation/browser/preflight.ts` | `uncheckedProviders/preflightProviders` 没有生产调用；当前预检由 browser runtime 装配 auth operations 与 BrowserClient | 删除旧实现，保留实际来源状态与浏览器队列链路 |
| `src/client/core/workspace-session.ts` | `requireWorkspaceId/createClientWorkspaceSession` 没有生产调用；会话创建已由 Host 工作区会话服务处理 | 删除；不要为了消除“未使用”再接回一条 Client 创建路径 |
| `src/host/core/environment/version.ts` | 仅环境测试直接加载旧版本比较函数，生产代码无调用 | 删除旧实现及只验证它本身的用例 |

估值样式中的 `crwu-valuation-date`、`crwu-valuation-grow` 和五个旧 `crwu-valuation-select-*` 类名也未在当前生产 TS/TSX 的非样式模块中出现。删除旧控件时一起核对这些规则，以及 `model/styles.ts` 中过渡用的 select 别名；必须保留共享控件实际使用的样式。

### F5 · P2：部分“只有测试调用”的代码代表未完成接入，不能只当死代码删掉

| 代码 | 当前事实 | 建议 |
| --- | --- | --- |
| `knowledge/rules.ts:334 parseRuleParameters` | 只有知识层 barrel 导出和测试调用；生产知识 Tool 没有调用它 | 当前合同承诺受控参数段和快照核对，建议接入生产读取与计算输入，不应因未使用而删除约束 |
| `execution/retrieval.ts:108,221 planRetrievalTasks/planEvidenceTasks` | 整个文件无生产导入，只有 capture 测试调用；真实 market Tool 没使用这些生成结果 | 当前执行链路不依赖此规划器，建议删除这一孤立实现和测试；若要强制执行知识中的检索阶梯，应先让真实 Tool 消费它 |
| `delivery/finalize.ts:339 finalizeProject` | 实际 finalize Tool 仅调用 `finalizePlan`；项目汇总函数只有测试调用 | 项目级汇总属于当前多方案需求，应接入项目结束/汇总流程；在接入前不能声称已有项目级完成判定 |
| `intake/manifest.ts:71,127` 的旧 selection/manifest 函数 | `validateIntakeSelection/buildIntakeManifest` 无生产调用；新 intake preview 已负责扫描归档；同文件 `sha256OfBytes` 仍被多处使用 | 删除旧选择/清单 API 与专属用例，保留公共哈希函数和实际被引用类型 |

`crwu_valuation_artifact_validate` 调用旧脚本时也没有传 `--limits`，旧脚本因此明确跳过阈值一致性检查。已有参数解析器的单测通过，并不能证明生产链路实施了这项核对。

## 房地产 Skill 文件处置清单

以下路径均相对 `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/`。

| 文件/文件组 | 结论 | 处理依据 |
| --- | --- | --- |
| `SKILL.md` | 保留并收敛 | 真正的 Agent 入口；去掉旧编号流程、固定业务限值、本地模板默认指引 |
| `references/knowledge-routing.md`、`workflow.md`、`execution-and-land-extension.md` | 保留 | 当前入口明确链接的技术执行合同 |
| `references/06-workbook-contract.md`、`09-output-contract.md` | 保留并裁剪 | 仍约束真实生成/校验流程；先去掉与新流程冲突的旧七表/旧结果必需项 |
| `references/01-realestate-valuation.md`、`02-market-method.md`、`03-income-method.md`、`04-case-selection.md`、`05-parameter-mapping.md`、`07-cost-method.md` | 迁移技术说明后删除 | 本地业务正文与实时 Wiki 并存；不是当前应发布的第二套业务规则 |
| `template/模板索引.md` | 删除 | 未使用、与当前 Wiki/模板流程冲突 |
| `scripts/extract_files.py` | 保留 | Host 的 Python extractor 真实调用 |
| `scripts/read_workbook_values.py` | 保留 | 重算 Tool 和重算引擎真实调用 |
| `scripts/build_workbook.py`、`check_workbook_contract.py` | 保留通用能力并收敛 | 真实填表和 Host 校验入口；剥离旧住宅 profile 默认兜底 |
| `scripts/calculate_market.py`、`market_rules.py` | 保留 | Skill 明确调用计算入口；计算入口真实 import 原语库 |
| `scripts/build_report_data.py`、`build_report.py`、`template/valuation-report.html` | 保留 | 当前报告生成链路，不能因缺少 TS import 而删除；渲染器旧 `--result` 分支另行收敛 |
| `scripts/validate_result.py`、`schemas/valuation-result.schema.json`、`template/valuation-result.json` | 调用点迁移后删除 | 旧结果链仍被 Host、prompt、打包断言和测试持有，见 F1 |
| `scripts/build_workbook_template.py`、`template/valuation-workbook.xlsx` | 退出生产默认；按需移为测试 fixture | 生成器无生产调用，但生成的模板仍是生产默认，见 F2 |
| `schemas/valuation-report-data.schema.json` | 保留 | `build_report_data.py` 真实加载校验 |
| `schemas/valuation-project.schema.json` | 保留 | 当前项目索引的对外结构合同，虽不是运行时加载文件，也不能当普通死代码删除 |
| `schemas/knowledge-source.schema.json`、`rule-parameters.schema.json`、`screenshot-manifest.schema.json` | 保留并核对接入 | 对应当前知识/参数/截图合同；参数解析尚未接入，见 F5 |
| `schemas/valuation-task-graph.schema.json` | 删除候选 | 未发现代码、入口文档或其他 Schema 引用；当前项目 Schema 已内联 tasks 形状，避免维护两份 |
| `schemas/valuation-object.schema.json`、`valuation-case.schema.json` | 随旧输入/结果合同整体迁移 | 旧结果仍 `$ref` case Schema，对象 Schema 有源仓合同测试，不能单独先删依赖 |
| `examples/valuation-result.sample.json` | 迁移后删除或移为历史转换测试 fixture | 只服务旧结果验证和 v1 渲染兼容测试 |
| `examples/valuation-case.sample.json` | 删除或改成当前流程的明确示例 | 未发现生产或当前文档指引；不应保留无入口的旧格式样本 |
| `assets/browser-sites.json`、`assets/README.md` | 保留 | 配置与 Host 站点加载器真实读取站点清单 |
| `assets/fonts/.gitkeep`、`icons/.gitkeep`、`logo/.gitkeep` | 可删除空占位 | 无运行引用；不是功能实现 |
| `scripts/test_*.py` | 跟随实际能力维护 | 保留真实生成、提取、报告的行为测试；删除旧模块专属测试，迁移仍有业务意义的断言 |

## 其他清理边界

静态入口扫描发现 14 个不可达模块，其中 `shared/wire-contract.ts` 和 `shared/wire/` 的 5 个文件是编译期类型兼容检查，仍被 `tsconfig.include=src` 编译；它们不应仅因没有生产运行时 import 就删除。若要精简，可以把编译期断言迁到专用类型检查，不能连约束一起去掉。

其余三个无生产消费者的 barrel（`intake/index.ts`、`browser/index.ts`、`market/index.ts`）可在调用和测试改用实际所有者模块后删除，优先级低于上面的行为冲突。

额外启用 TypeScript 的 `noUnusedLocals/noUnusedParameters` 后，当前得到 59 条诊断，基线得到 38 条。文件路径在本分支大规模迁移，不能把当前全部 59 条归因于本分支新增。可先清理明确的新残留，例如：

- `ValuationIntakePane.tsx` 的 `RequiredMark`；
- `WorkbenchPanel.tsx` 的 `moduleLabel`；
- `module-store.ts` 的 `requirementOf/requiresEnvironment` 导入；
- `execution/dispatch.ts` 的 `admitted`、`prompt.ts` 的 `result/report`；
- `tools/report-evaluation/revision.ts` 的 `toolContext/currentRevisionOf`；
- `operations/report-evaluation.ts` 未使用的 `text` 导入。

其中有副作用的调用即使返回值未使用，也只能移除多余绑定，不能直接删除调用。AST 导出扫描产生的其他候选未逐项证明安全，不列为直接删除结论。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 估值 Host/Client 单测与项目合同测试 | 743/743 通过 |
| 额外 TS 未使用检查 | 当前 59 条，基线 38 条；普通 typecheck 未开启这两项 |
| 真实 `validate_result.check_knowledge()` | `dws` 通过、`verified-mirror` 失败、`local` 通过，复现 F1 |
| 真实 `build_workbook.py` | 仅写一个项目名称仍复制预置业务参数，复现 F2；所有产物写入临时目录 |
| Python Skill 测试发现 | 运行 256 个：3 个失败、1 个错误、2 个跳过，未宣称通过 |
| Workbench `tests/unit/**/*.test.mjs` | 2496 个中 2491 通过、5 个失败，未宣称完整门禁通过 |
| `git diff --check` | 通过 |

Python 的三个失败涉及 PDF 图像/渲染能力和错误文案断言；一个错误来自测试夹具把 `../../etc/passwd` 拼成真实写入路径，沙箱拒绝写入。应修夹具，让非法引用只存在于 JSON，不能为了测试拒绝路径而实际创建越界文件。

Workbench 扩大测试中的三个失败为日期显示和环境图标断言；另外两个打包/安装用例失败涉及受限环境中的 npm 操作和缓存写权限。估值专项通过不覆盖这些问题。

审查期间观察到工作区的环境 UI、估值样式、语言文案及相关测试继续被其他工作修改；上述广泛测试结果仅代表执行时快照，日期/图标断言需在稳定快照复查。另一次 `npm test` 在输出打包失败后长期未退出，已中断，未取得完整汇总；不能据此声称完整仓库门禁通过。

## 建议清理顺序

1. 统一新版交付文件与校验入口，移除旧结果 JSON 的必需地位，同时覆盖真实 Python 调用，避免只用 shell 替身验证。
2. 取消本地模板和预置参数的生产默认；使用本轮已验真模板与明确参数。
3. 删除四个已确认脱离生产的旧 UI/预检/Client 会话/版本模块，迁移必要的真实行为断言。
4. 删除 Skill 的旧业务正文、旧索引、旧结果资源；更新 `scripts/assert-pack.mjs`、`docs/skills.md` 和相关合同测试，不能只让打包断言继续为旧文件提供“使用证据”。
5. 接入仍属于当前承诺的受控参数解析、项目级完成判定；清除孤立检索规划器、旧 intake API、闲置导入和 CSS。
6. 清理完成后再运行 `make plugin-check`、各非 vendored Skill 层自包含检查、必要的 `make docs-check` 和 `git diff --check`。本轮没有修改实现，不把专项测试代替清理后的门禁验收。
