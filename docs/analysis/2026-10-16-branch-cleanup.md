# 分支清理历史台账（2026-10-16）

> **历史快照，不是操作指令。** 本文记录 `feat/valuation_1012` 工作树一次清理行动删除/迁移了什么、
> 为什么保留某些契约文件，以及当时尚未修复的估值工作流发现（F1–F9）。行号、文件名与结论只对
> 2026-10-16 当次工作树成立；当前行为以源码、测试与活动文档为准。同批后续对清理回归的修正
> （Select 数据钩子、CSS 注释语法、CLI 守卫保留原始口径 / 启发式实验回退、挂牌 generatedAt /
> 工作簿路径）以及挂牌参考 Host Tool、finalize 参考档与适配修正（见 §4.1）、未使用绑定的
> 中性清理（见 §3.1）均已落地；F1–F9 仍未修复（见 §4）。
>
> 本文的“历史存档”附录逐字保留被移出活动文件的旧正文，便于事后追溯；**附录里的七表
> 住宅默认 profile 不是当前操作契约**，当前计算表契约见 `references/06-workbook-contract.md`。

## 1. 移除的文件与理由

只列本次清理移除的路径。工作树里本分支更早的删除（旧 `references/01-08`、旧 schema /
样例、`validate_result.py`、随包住宅模板等）由更早的改动产生，**不在本次台账范围**，清理没有改动它们。

| 路径 | 理由 |
| --- | --- |
| `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/market_rules.py` | 无生产调用：`calculate_market.py` 只有空 `import market_rules`，真实计算在本地用 `Decimal` 实现；该模块还把**已删除**的 `references/02-market-method.md` 第 9 节声明为阈值唯一出处，Skill 单独拷贝后指不到实处。 |
| `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_market_rules.py` | 仅测上述死模块；有价值的边界与取整断言已迁入 `test_calculate_market.py`（见 §2）。 |
| `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/assets/fonts/.gitkeep`、`assets/icons/.gitkeep`、`assets/logo/.gitkeep` | 空占位目录，无生产读取；`assets/README.md` 已同步改写。 |
| `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/.DS_Store` | Finder 元数据，`.gitignore` 已忽略，不属于交付内容。 |
| `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/SingleSelect.tsx` | 仅测试消费的兼容包装；生产渲染路径是 `src/client/ui/components/Select.tsx`。测试迁到生产组件后删除。 |
| `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/index.ts` | 测试专用 barrel，无生产入边；测试改读 owning modules 后删除。 |
| `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/intake/index.ts` | 同上。 |
| `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/index.ts` | 同上。 |

`Makefile` 同步移除 `test_market_rules.py` 配方行；`calculate_market.py` 去掉空 import 并把文档串
改为“本文件内实现连乘/比较/取整”；`SKILL.md` 删除“用 `market_rules.py` 原语算”的指引，改述
`calculate_market.py` 的 `rule_checks`。

## 2. 迁移的测试覆盖

| 原覆盖 | 迁移目标 | 保留的断言 |
| --- | --- | --- |
| `test_market_rules.py` | `scripts/test_calculate_market.py`（新增用例） | 单项 20% 的等于/略超边界、负方向幅度口径、共同 30% 的等于边界、组内比值 1.2 的等于/略超、HALF-UP（非银行家舍入）取整、`digits` 来自知识快照、案例条件指数为 0 拒绝。 |
| `client-valuation-select.test.mjs`（`SingleSelect`） | 生产 `src/client/ui/components/Select.tsx` + 共享 `select-model.ts` / `popover-model.ts` | 几何定位/翻转/夹取、键盘意图、typeahead、单开注册表、combobox/listbox/option 语义、关闭动画与监听清理。数据钩子改为生产 `data-crwu-*`；`aria-labelledby` 按生产实例 id 对账；注册键改为生产实例 id。 |
| `client-valuation-pane.test.mjs`（`SingleSelect`） | 生产 `Select` | 方法选项清单与页面锚点（`data-valuation-option`），并按生产装配方式传入 `dataAttributes` / `optionAttributes`。 |
| `host-valuation-site-parsers.test.mjs` | `browser/providers.ts` | `PROVIDER_SITES` / `expandTemplate` / `siteOf`。 |
| `host-valuation-market.test.mjs` | `browser/retry.ts`、`browser/login-state.ts`、`browser/provider.ts`、`market/normalize.ts`、`market/jsonld.ts` | 尝试策略、登录阶段、来源白名单、字段标准化、JSON-LD。原“两个入口各司其职”用例改为对真实 owning modules 断言。 |
| `host-valuation-intake.test.mjs` | `intake/classify.ts`、`intake/manifest.ts`、`intake/extract.ts`、`intake/types.ts` | 类型判定、manifest、提取、去重。 |
| 估值操作清单对账（原 `report-audit/api.ts` 的 8 个包装） | `modules/report-evaluation/api.ts` 的 `valuationApi` + `VALUATION_OPERATION_OF` | `client-rpc-facade` / `host-operations` / `host-package` 三处把两份清单合并后与冻结操作清单双向对账；`client-rpc-facade` 新增逐方法发出操作名断言。 |

## 3. 保留的契约与运行时文件

- `schemas/valuation-object.schema.json`、`schemas/valuation-project.schema.json`、
  `schemas/valuation-report-data.schema.json` 等：不改动；旧单对象合同的外部承诺未定，不能按“运行期零读取”删除。
- `src/shared/wire/**` 与 wire contract guards：契约类型/守卫，不是生产 import 入口，保留。
- Skill 运行时脚本、`evidence_index.py`、报告/底稿模板及其测试：由 Agent、结构化 Python Tool
  或文件路径调用，TS import 看不到，保留。
- `test_listing_reference.py` 既有失败用例、missing listing Tool/finalize 测试：**保留未改**，
  作为下一阶段的红基线。
- 本分支更早删除的旧文件、vendored `skills/dws/**`、生成的 `common/skills/**`：不在本次清理范围。

### 3.1 行为中性的未使用绑定清理（最终落地）

以下六处只有诊断噪音（`noUnusedLocals` / `noUnusedParameters`），且不影响状态、签名、参数类型或
调用点；按“有意保留的位置参数”处理，而不是加 `void` 抑制或删除状态：

- `ReportPane.tsx` 的 `aiError`：值从未被读，但 setter 有 18 处调用；改为
  `const [, setAiError] = React.useState('')` —— hook 仍在、状态与重渲染不变，只丢掉未读的名字。
- 公共导出签名保持参数数量与类型不变，只把未读的具名参数改成 `_` 前缀：
  `describeLoginAdvice(_kind, advice, original)`、`dwsLogin(deps, _args, _home, options)`、
  `relogin(deps, _home)`。
- 局部回调同样只改未读参数名：`preflight: (_input, options)`、
  `onLoadAuditInfo={async (_key, cloud) => …}`。
- `plugins/dsh-crwu-workbench/docs/PRD-workbench-sidebar-modules.md:1047` 一度仍提到已删除的
  `ui/SingleSelect.tsx`；同批后续已更正为 `src/client/ui/components/Select.tsx`（见 §4.1）。

## 4. 仍未修复的估值工作流发现（F1–F9，未声称已修）

以下来自 2026-10-16 只读评审，行号只对当次快照成立；本次清理**没有**修复它们。

- **F1 [P1]** `revision.ts` 的 `op=promote` 固定传 `frozenInputDigest:''` 与
  `screenshotRequired:false`，可绕过冻结输入与截图门禁；与普通 `finalize` 对同一交付件结论相反。
- **F2 [P1]** `calculate_market.py` 不拒绝非正条件指数：负指数可进入交付，且最高/最低比价检查在
  `min(prices) <= 0` 时被整段跳过而不留“未判定”。
- **F3 [P1]** `execution.ts` 的 `dispatch` 启动子会话后没有登记该 child 的估值 scope，
  `scopeOf` 不继承父 scope，knowledge/template 等工具会拒绝子会话。
- **F4 [P1]** `core/workspace-session/create.ts` 创建后校验失败只回失败信封、丢 `sessionId`，
  `handoff.ts` 据此记 `not-created`，重试可能再建第二条父会话。
- **F5 [P1]** `internal/platform/browser/page.go` 的 `Navigate` 不检查 `Page.navigate` 的
  `errorText`，旧页面可被当作新 URL 的抓取成果。
- **F6 [P2]** `report-evaluation/controller.ts` 的扫描与来源检查共享取消令牌/generation，
  被 superseded 后状态可能停在 `scanning` / `checking`。
- **F7 [P2]** 交接的超时兜底会被页面清理取消，切页再回来可能一直停在 `creating-session`。
- **F8 [P2]** `browser/acquire.go` 的 `Release` 丢弃关闭错误、不做 Kill/Wait；恢复窗口不是总预算；
  `Facts` 基础设施错误被映射成 `site-blocked`。
- **F9 [P2，指定多 profile 时]** `DebugPortFile` 用 profile 父目录 + 固定文件名，
  `/x/a` 与 `/x/b` 共用 debug-port 且 `RunningPort` 不核验归属。

### 4.1 清理后修正（同批后续）

第一次清理暴露的问题已在同批后续修正，不再是红门禁；行为实现仍只限清理回归，未做业务重设计：

- **Select 测试数据钩子**：迁移测试误用了 `data-crwU-*`（大小写错误）。生产 Select 实际导出
  `data-crwu-select` / `data-crwu-select-state` / `data-crwu-option` / `data-crwu-select-instance`
  （实例 id 由 `useInstanceId('crwu-select')` 生成）；测试已改为逐字一致，动画、监听清理、几何、
  ARIA 与键盘断言全部保留。
- **CSS 模板字面量语法**：`styles/pane.ts` 导出的 template literal 注释里出现反引号会被截断
  （TS1005）；已改成不含反引号的英文注释，并更正包含块说明 —— `container-type` 本身不建立
  `popover-model` 认的固定定位包含块，那要 `transform` / `filter` / `backdrop-filter` /
  `contain: layout`。
- **CLI 静态守卫（收缩范围）**：最终**保留初始的原始守卫**（`exec-cli-literal`：执行原语 + 任何
  CLI 可执行字面量同文件出现即 fail closed），并原样回退了本轮尝试的「别名 / 执行目标解析」
  启发式实验 —— 补充探针发现它在变量重赋值、条件表达式等形态上出现**漏报**，说明继续迭代解析器
  不可靠。纯业务知识元数据改放 `scripts/fixtures/listing-knowledge-source.json`：夹具随技能分发、
  只作测试数据，`test_listing_reference.py` 不再内联 CLI 字面量，因此原始守卫对真实技能语料零误报。
  没有新增解析器、文件/目录/类型级豁免或运行时依赖。
- **挂牌参考工作簿校验**：`validate` 已把**最终 xlsx 路径**（`<out>/估值底稿.xlsx`）传给
  `_validate_workbook_semantics`，与 `build` 一致；此前传输出目录会让图片 native 超链接少一级。
- **挂牌参考生成时间**：输入省略 `generatedAt` 时，`build` 只取一次时钟，把有效时间写进收据
  （`generatedAt`，同时保留 `checkedAt`）；`validate` 与复用路径读收据里的冻结值，不再重取
  `now()`。`inputDigest` 仍只基于原始输入：同一份未带时间戳的输入可复用，业务输入变化仍拒绝，
  `--validate` 仍只读，修订目录图片超链接与产物不被重写。
- **挂牌参考 Host Tool**：新增 `crwu_valuation_listing_reference`
  （`src/host/tools/report-evaluation/listing-reference.ts`，注册面 / 估值子工具名单 / `Makefile`
  Python 门禁同步）。参数面只有 `caseDir / planId / revision`；固定输入与输出目录由 Host 从已登记
  方案派生，输入 `valuationMode / projectId / planId` 在执行前与 scope 核对；经 Broker
  `python.script.run` 跑一次打包脚本，四件产物逐个按真实存在与非空核验，状态只回 `partial`。
- **挂牌参考适配修正**：运行时解析带 `{agent: exec.agent}` 且发生在任何落盘之前；缺解析器 /
  运行时不可用仍是 `capability-gap`。成功时 `reused` 只认脚本 stdout 里 `reused === true`
  （缺省 false），产物仍独立逐个核验。模型可见错误不再回显 JSON 解析原文、`runtime.error` 或
  `reasonOf(run)`：改为固定帮助文案 + 安全分类 / 退出码 + 可执行的下一步动作。
- **挂牌参考 finalize**：`PlanFinalizeFacts` 增加可选 `valuationMode` + `reference`；已验证参考
  覆盖方案对象且无参考问题时上限 `partial`（`validation: null`，不适用正式模板 / 底稿 / 重算），
  未验证 / 带问题 / 对象不一致 → `blocked`；输入、知识、阻断、价值范围、证据、计算、报告与产物
  清单照旧。`reference` 由 `collectPlanFinalizeFacts` 从报告数据复核得出，不读模型自报。
  该收集器只做**结构事实**核对（`valuationMode` / `referenceSummary` 形状 / `status=partial` /
  逐对象 `provisionalResults` 存在 + Schema 问题清单）；**数值与产物语义由生成脚本
  `build_listing_reference.py` / `build_report_data.py` 负责**，finalize 不重复算价。

### 4.2 仍未完成

- **F1–F9**：见 §4，全部仍未修复。本轮只补 CLI 守卫、挂牌参考交付 Tool、finalize 参考档与
  上述适配修正；这些是**清理回归**，不等于已经解决全部既有估值工作流风险 —— §4 记录的 F1–F9
  仍留作后续**流程重构**工作。

## 5. 历史存档：`references/06-workbook-contract.md` 旧正文（逐字，含住宅默认 profile）

下列内容在 2026-10-16 清理中从活动参考文件移出并原文存档。活动文件只保留描述文件通道、
案例证据与报告数据对账等当前技术合同；下表内的七表清单、固定公式链、默认 profile 均为**历史结构参考**。

````text
# 06 计算表模板契约

> ⚠️ **数值的权威来源是本轮知识快照，本文只描述"结构"。**
> 单因素修正上限、共同修正上限、组内比值上限、面积段放宽范围、税率与空置率区间等业务数值，
> **唯一权威来源是本轮知识快照**（`04-参数与税费` 的受限参数段）。
> 快照里的取值与本文不同时**以快照为准**；本文说明的是这些值在流程与底稿里的**位置与用法**。
> 技能与脚本里不内置业务阈值（`scripts/market_rules.py` 已无默认值），缺参数就如实报缺口。

## 0. 当前生效契约（通用描述文件通道）

`build_workbook.py` / `check_workbook_contract.py` 只认**工作簿自己的描述文件**
（`--contract <descriptor.json>` 或模板旁边的 `<模板>.contract.json`）：表数量、表序、角色
（input/formula/result）、输入/结果/空值/单位格都由描述文件声明。**没有随包默认模板，也没有内置七表
profile**；没有描述文件就直接拒绝。

- 生成：`build_workbook.py --values <填入值.json> --out <底稿.xlsx> --template <模板.xlsx> [--contract …] [--case-root …]`
- 校验：`check_workbook_contract.py <workbook.xlsx> [--contract …] [--case-root …] [--report-data …]`
  - `--case-root` 是图片路径的基准目录（Host 传**基础方案根**，不是修订目录）。缺省回退 sidecar 里的
    `caseRootRelative`（相对工作簿目录的解释），再缺省为工作簿所在目录；交付件里**不写**本机绝对路径。
  - 当填入值带 `caseEvidence` 时，产物追加可见的 `案例证据` 表，并在 sidecar 记录同一批条目。校验会
    逐行核对 caseId / 详情 URL / 图片相对路径 / 指纹 / 抓取时间 / 证据类型文本与 native 超链接，并用共享
    `evidence_index.py` 复算图片真实路径、PNG 魔数与 sha256；删除、篡改或与 sidecar 不一致即失败。
  - `--report-data` 可选：报告里 `comparables[].used === true` 的案例必须在本底稿案例证据索引里有同 caseId、
    同 sourceUrl 的行，且报告里 `validity: valid` 的截图 relativePath/digest 与索引一致；报告结构不认识时 fail closed。
- 底稿结构、业务阈值与公式链以**本轮知识快照 + 用户实际模板**为准。下面第 1 节的七表清单是**历史结构参考**，
  不是当前默认 profile。


- **来源**：力鸿花园投资性房地产公允价值测算底稿的表结构与公式链（`基础信息表` / `案例` /
  `J统一价值内涵、及税费正常负担的测算` / `J住宅市场法表` / `收益法` / `投资性房地产-房屋公允模式`）。
- **适用范围**：房地产估值标准计算表（第一期通用模板）的字段、区域划分与勾稽规则；住宅、商业、办公、
  投资性房地产共用同一套契约。
- **更新时间**：2026-10-12。

## 1. 工作簿结构（历史结构参考；当前契约以描述文件为准）

标准计算表固定为 **7 张可见表**，一张表一类职责，顺序固定：

| 序号 | 表名 | 职责 | 主要填写方 |
| --- | --- | --- | --- |
| 1 | `基础信息表` | 项目输入 + 参数与税率集中登记 | 项目输入 |
| 2 | `案例` | 案例来源、链接、截图与可比性留痕 | 估值人员 |
| 3 | `价值内涵与税费` | 价值口径统一 + 税费正常负担还原 | 估值人员 |
| 4 | `市场法` | 因素条件/指数/修正系数 + 比准价格 | 估值人员 |
| 5 | `收益法` | 租金 → 有效毛收入 → 运营费用 → 净收益 → 收益价值 | 估值人员 |
| 6 | `成本法` | 重置成本 → 成新率 → 建筑物 + 土地 → 积算价 | 估值人员 |
| 7 | `估值结果汇总` | 最终结论汇总（投资性房地产-房屋公允模式） | 自动 |

**不纳入模板**：

- **隐藏表**：说明页、废表、过渡计算表一律不进模板。需要保留的说明改为结论页正文，不靠隐藏表承载口径。
- **旧外部链接**：模板不得引用任何其他工作簿（历史底稿大量 `[21]封面!D9` 这类跨簿引用，
  源簿一旦移动或删除即全表失效）。
- **历史断链**：模板内不得保留指向已删除表的引用（历史底稿中存在
  `=基础信息表!#REF!` 这类断链，会让含税单价整块失效）。

模板文件不承载隐藏数据，也不依赖任何工作簿外文件。

### 用哪一份模板（§7.1）

**用知识库里的用户实际模板**，不要自行造一个外观类似、结构不同的替代品：

```bash
python3 scripts/build_workbook.py --values 填入值.json \
    --out <案例目录>/估值底稿.xlsx --template <知识库下载的模板.xlsx>
```

- 脚本会在动手**之前**拿本契约验一遍模板本身（表名、表序、公式链、勾稽行、汇总依据三行）：
  不合格就拒绝生成并列出问题 —— 结构不对的模板填完一轮才发现，整轮白做；
- 加 `--template` 就**必须**用它：脚本不会在模板缺失时回退到随包模板（打错字会直接报错）；
- 生成结果里会打印实际用的模板路径与 `sha256` 指纹：事后要能分辨底稿出自随包模板还是用户模板；
- 下载的模板与填好的底稿都留在**任务案例目录**里，不写回技能安装目录（`build_workbook.py`
  拒绝把产物写到模板本身）。

## 2. 区域与填写规则

每张业务表按四个区纵向排布，用颜色区分：

| 区域 | 颜色 | 规则 |
| --- | --- | --- |
| 输入区 | 浅绿 | 人工填写；空值即为"未填"，不得留 0 冒充已填 |
| 公式区 | 浅黄 | **保留模板公式**，禁止用硬编码数值覆盖 |
| 输出区 | 无填充（加粗） | 结论字段，由公式产生，不得手工改 |
| 勾稽区 | 浅灰 | 检查项与阈值；出现 `超限` 时必须写明处置方式 |

补充规则：

- **公式链不得断开**：所有输出必须能一路回溯到输入区；跨表引用统一用整列或具名单元格。
- **取整规则统一**：单价 `ROUND(..., -1)` 到十位；总价 `ROUND(..., -2)` 到百位；
  修正系数积 `ROUND(..., 4)` 四位小数；中间量 `ROUND(..., 2)`。禁止各处自定小数位。
- **单位统一**：单价一律元/㎡；汇总表金额单位人民币元，另有说明时在表头写明"金额单位：元/万元"。
- **无 `#REF!`、无 `#VALUE!`、无 `#DIV/0!`**：交付前全表重算检查，任一错误必须修掉而不是用 0 覆盖。
- **汇总表的三行必须填**（`估值结果汇总` 的「三、汇总依据与限制」）：`权重 / 汇总依据`（多方法或多案例
  怎么汇总到最终采用单价）、`已知限制`（资料、口径、能力上的限制）、`待确认事项`
  （必须与 `估值报告数据.json` 的限制 / 待确认项一致；模板的填写说明可把这三行声明为必填，
  通用工作簿校验按该声明核对）。**这三行整行删掉也算不合格**（工作簿契约会报"缺少该行"）。
  为什么单列：报告上写了限制、交出去的底稿上看不出来，是复核时最难发现的一类不一致。
- **案例截图 / 证据留档必须真的填**（`案例` 表的「案例截图 / 证据留档（文件名或留档路径）」一行）：
  每个采用案例的 `evidence`（报告数据里的相对路径）都要出现在这一行里 ——
  两处各写一份而没人比过，就会出现"报告说留了证据、底稿上却是空的"。**这一行整行删掉也算不合格**
  （不是"找不到就跳过"）。
- **汇总表的「采用的方法」必须逐字写**（`估值结果汇总` 的 J 列）：填了建筑面积的行没写方法时，
  K 列的 `=IF(ISNUMBER(SEARCH("收益法",J5)),G5, …)` 三个分支全部落空，**一声不响地回空串** ——
  于是汇总表没有结论，而报告与结果 JSON 里可能写着数字。所以只允许 `市场法` / `收益法` / `成本法`
  三个逐字名称（写"市场"匹配不到）。合计行不是数据行（它的面积是 `=SUM(…)`），不参与这条检查。
- **年份/日期**：基准日、成交日期用真实日期值，不用文本；修订系数按日期算收益年限时不得手工折年。

## 3. 逐表字段契约

### 3.1 `基础信息表`

**项目输入区**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| 被评估单位 | 文本 | 是 | 与委托合同一致 |
| 评估目的 | 文本 | 是 | 决定价值类型 |
| 价值类型 | 枚举 | 是 | 市场价值 / 公允价值 / 投资价值 / 清算价值 |
| 评估基准日 | 日期 | 是 | 全表口径起点 |
| 现场勘察日 | 日期 | 是 | 反映实物状况 |
| 现场勘察人 | 文本 | 是 | |
| 价值内涵 | 文本 | 是 | 按 `01` 第 4 节六项，逐项写明 |
| 采用结论的方法 | 枚举 | 是 | 市场法 / 收益法 |

**参数与税率区**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| 参数名 / 取值 / 依据来源 / 时点 / 备注 | 表格 | 是 | 按 `05` 第 4 节五项登记；市场法与收益法共用 |

### 3.2 `案例`

按 `05-案例选取` 第 2 节的三组字段登记：基本信息、价格与交易、判断与留痕。
表尾固定放一行**案例数量与可比性汇总**（候选数 / 保留数 / 剔除数 / 是否满足 ≥ 3）。

### 3.3 `价值内涵与税费`

| 区 | 内容 |
| --- | --- |
| 案例概况 | 实例名称、案例来源、交易价格、价格内涵、面积内涵、交易时间、交易情况、坐落、用途 |
| 统一价值内涵 | 财产范围 / 付款方式 / 融资条件 / 税费负担 / 计价单位 / 含税与否（六项逐项给"设定值 + 修正系数"） |
| 税费正常负担修正 | 逐案例逐税种：增值税、土地增值税、附加税、个税或所得税；免征的写免征依据 |
| 单价还原 | 不含税卖方净得价 → + 卖方税费 → 税费正常负担下含税价 → 含税单价 → 不含税单价 |

**关键公式（不得改写形态）**

```text
税费正常负担下含税价 = 卖方净得价 + 卖方应负担税费合计 + 买方应负担税费合计
含税单价   = ROUND(含税价 / 建筑面积, -1)
不含税价   = 含税价 − 增值税
不含税单价 = ROUND(不含税价 / 建筑面积, -1)
```

### 3.4 `市场法`

三张子表并列，行结构必须一一对应（同一套因素行）：

| 子表 | 内容 |
| --- | --- |
| 比较因素条件说明表 | 估价对象与各案例的**文字描述 + 档次** |
| 比较因素条件指数表 | 估价对象 = 100，各案例逐因素打分 |
| 比较因素修正系数表 | `修正系数 = 100 / 案例指数`（显示为 `100/105` 形式） |

因素行分组固定：交易单价 → 交易情况 → 交易时间 → 区位状况 → 实物状况 → 权益状况。
因素明细与幅度见 `02-市场法` 第 6–8 节。

**输出与勾稽**

```text
修正系数积 = ROUND(PRODUCT(估价对象因素指数) / PRODUCT(案例因素指数), 4)
比准价格   = ROUND(案例交易单价 × 修正系数积, -1)
评估单价   = ROUND(AVERAGE(各比准价格), -1)
评估值     = ROUND(评估单价 × 建筑面积, -2)
含税单价   = ROUND(评估单价 × (1 + 增值税率), -1)
增值税     = 含税单价 − 评估单价
```

| 勾稽项 | 阈值 | 超限处置 |
| --- | --- | --- |
| 单因素修正幅度 | ≤ 本轮快照的单项上限（示例 20%） | 说明理由或重选案例 |
| 全部因素共同修正幅度 | ≤ 本轮快照的共同上限（示例 30%） | 说明理由或重选案例 |
| `MAX(比准价格) / MIN(比准价格)` | ≤ 本轮快照的组内比值上限（示例 1.2） | 剔除离群 / 改用加权平均 / 写明原因后保留 |

### 3.5 `收益法`

行结构固定（序号 → 测算项目 → 取值 → 后台费率 → 后台公式 → 测算说明）：

```text
1   年房地产有效毛收入 = 年潜在毛收入 − 空置造成的租金损失 + 其他收入
1.1 年房地产潜在毛收入 = 日租金 × 365
1.2 空置造成的租金损失 = 空置率 × 潜在毛收入
1.3 其他收入（押金利息）= 保证金 × 一年期存款利率 × (1 − 空置率)
2   年运营费用 = 2.1 增值税及附加 + 2.2 管理费 + 2.3 房产税 + 2.4 城镇土地使用税
                + 2.5 印花税 + 2.6 维修费 + 2.7 保险费
3   年净收益 A = 1 − 2
4   报酬率 Y
5   净收益逐年递增比率 g
6   可获收益年限 n = ROUND((终止日 − 起始日) / 365, 2)
7   租金收益价值（单价）= ROUND(A / (Y − g) × (1 − ((1+g)/(1+Y))^n), 0)
8   剩余建筑物价值折现（单价 V′）
9   收益价值 = 单价（V）与总价（万元 = 单价 × 可收益建筑面积 / 10000）
```

**勾稽项**

| 勾稽项 | 要求 |
| --- | --- |
| 日租金回溯 | 必须能由租金案例（月租金、面积）复算得出 |
| 收益年限 | 起点 = 基准日；终点 = min(土地终止日, 建筑物终止日)，且 `n ≥ 1` |
| `Y > g` | 不满足时该公式不成立，必须改装模型并写明 |
| 税费互引 | 附加税引用增值税；保险费与维修费引用同一重置成本单元格 |
| 单价 × 面积 | 总价与汇总表评估值一致（尾差 ≤ 取整误差） |

### 3.6 `成本法`

行结构固定（序号 → 测算项目 → 取值 → 测算说明），单位元/㎡，最后乘建筑面积得评估值：

```text
1   建筑重置成本单价（元/㎡）   = 基础信息表「建筑重置成本」或分项构成（建安造价 × 综合费率）
2   已使用年限（年）            = 竣工/建成至基准日
3   经济耐用年限（年）          = 按结构取（见 07 第 5 节）
4   尚可使用年限（年）          = 经济耐用年限 − 已使用年限（结合现场勘察调整）
5   成新率                    = ROUND(尚可使用年限 / 经济耐用年限, 4)
6   建筑物评估单价（元/㎡）     = ROUND(建筑重置成本单价 × 成新率, -1)
7   土地单价（元/㎡）           = 成本逼近法 / 基准地价系数修正法 / 市场法
8   房地产积算单价（元/㎡）     = ROUND(建筑物评估单价 + 土地单价, -1)
9   房地产评估值（元）         = ROUND(房地产积算单价 × 建筑面积, -2)
```

**勾稽项**

| 勾稽项 | 要求 |
| --- | --- |
| 成新率区间 | `0 < 成新率 ≤ 100%`，超限须说明 |
| 重置成本 | `> 0`，来源与基准日须写明 |
| 土地单价 | `≥ 0`；房屋与土地成对处理，不重复计入重置成本 |
| 单价 × 面积 | 评估值与汇总表一致（尾差 ≤ 取整误差） |

### 3.7 `估值结果汇总`

逐对象一行，字段与勾稽：

| 字段 | 来源 |
| --- | --- |
| 序号 | 全局唯一，不得重复 |
| 权证编号 / 房屋名称 / 坐落 | 项目资料 |
| 权证用途 / 建筑面积 | 项目资料（面积与计算表一致） |
| 收益法单价 | `收益法` 第 9 行单价 |
| 市场法单价 | `市场法` 评估单价 |
| 成本法单价 | `成本法` 第 8 行单价 |
| 采用的方法 | `基础信息表` 的"采用结论的方法" |
| 采用单价 | 按采用方法取对应单价 |
| 评估价值 | `ROUND(采用单价 × 建筑面积, 0)` |
| 账面价值 / 增减值 / 增值率 | 账面数据；增减值 = 评估价值 − 账面价值；增值率 = 增减值 / ABS(账面价值) × 100% |
| 备注 | 假设、限制、待确认事项 |

**汇总勾稽**

| 勾稽项 | 要求 |
| --- | --- |
| 合计行 | 建筑面积、评估价值、增减值、增值率由 `SUM` 得出，**不得手工填** |
| 面积一致 | 汇总表面积 = 市场法/收益法所用建筑面积 |
| 单价一致 | 汇总表采用单价 = 对应方法输出单价 |
| 无重复序号 | 序号唯一性检查 |
| 方法标注 | 未采用方法的测算过程仍保留，但结论只取采用的方法 |

## 3.8 别的模板：契约由**模板自己的填写说明**声明（协议 39）

上面 1～3 节描述的是**随包发布的住宅模板**（七表、固定顺序、固定公式链）。
**换一份模板不该意味着改脚本**，所以 `check_workbook_contract.py` 支持第二条通道：

```bash
python3 scripts/check_workbook_contract.py <workbook.xlsx> --contract <contract.json>
# 或者把描述文件写成 <workbook.xlsx>.contract.json，脚本会自己发现（不必带 --contract）
```

描述文件的形状（写在你那份模板的填写说明旁边）：

```json
{
  "templateId": "模板标识（进报告与留痕）",
  "templateSha256": "sha256:…",
  "sheets": [
    {"name": "输入", "role": "input", "required": true},
    {"name": "测算", "role": "formula"},
    {"name": "结果", "role": "result"}
  ],
  "orderMatters": false,
  "inputCells": ["输入!B2", "输入!B3"],
  "resultCells": ["结果!B5"],
  "unitCells": ["输入!B1", "测算!B1"],
  "emptyAllowedCells": ["输入!B4"],
  "allowHiddenSheets": false
}
```

通用通道只查**真正通用的正确性**，逐条对应上面各节的硬规则：

| 通用校验 | 对应本文的哪条要求 |
| --- | --- |
| 表都是可见表（`allowHiddenSheets` 默认 false） | §4 第 1 条（无隐藏表） |
| 无外部链接、无 `#REF!` / `#VALUE!` 等错误值、无历史断链 | §4 第 1 条 |
| `inputCells` 存在且**不是公式**（受控写入） | §4 第 2 条（输出无手工覆盖公式） |
| `resultCells` 必须有公式或数值 —— 空着就是缺口 | §4 第 9 条（汇总必须有结论） |
| `formula` 角色的表必须真的有公式 | §4 第 2 条（公式区不能退化成常量） |
| `emptyAllowedCells` 里不许填 `0` | §2（空值不填零） |
| `unitCells` 写出的单位必须一致 | §2（单位与数量级一致） |
| `templateSha256` 与**实际字节**一致 | §4 第 10 条（写明本次依据的版本） |

它**不**假定表数量、表顺序、业务公式或任何业务阈值 —— 那些属于**你那份模板的填写说明**。
没写描述文件时按本文的住宅 profile 校验（只对随包模板成立），并在输出里说明走的是哪条通道。

## 4. 交付前检查清单

交付计算表前逐项确认，任一项不通过不得交付：

1. 只有 7 张可见表，无隐藏表、无跨簿引用、无 `#REF!`；
2. 输入区（浅绿）与公式区（浅黄）分色正确，输出无手工覆盖公式；
3. 价值内涵六项在「价值内涵与税费」中逐项写明；
4. 每个参数在「基础信息表」参数区有依据、时点与备注；
5. 案例数量 ≥ 3 或已写明不足的处置方式，剔除案例留痕，来源链接与截图留档齐备；
6. 市场法三项勾稽（20% / 30% / 1.2）已计算，超限已说明；
7. 收益法 `Y > g`、收益年限起止日期、税费互引正确；
8. 成本法成新率区间、重置成本与土地单价口径正确，单价与面积勾稽一致；
9. 汇总表合计行为公式，面积与单价与分表一致；
10. 交付中写明本次读到的知识正文版本（含更新时间）。

````
