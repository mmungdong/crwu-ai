# crwu-audit-skill-maintainer 设计规范

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-10 |
| 版本 | v0.2 |
| 状态 | 待用户二次审阅 |
| 目标位置 | `skills/crwu-audit-skill-maintainer/` |
| 适用仓库 | `crwu-ai` source repo |

## 1. 背景

`crwu-audit` 已采用资产、业务、方法、监管和公共能力分轴维护、运行时稳定并集加载的架构。钉钉知识库现在又形成了两级业务结构和两级资产结构：一级目录决定加载哪个 Skill，一级目录内部的细分对象或子业务决定使用哪些审核条目。

维护者目前仍需人工完成以下关联工作：

- 判断能力属于哪个一级资产或一级业务目录；
- 核对一级目录内部的共性资料、细分对象和子业务；
- 下载并核验准则、必检项、历史高频复核问题和其他关联文件；
- 创建或修正资产、业务 Skill；
- 同步分类表、registry、知识装配、README、设计文档和变更记录；
- 检查知识库目录改名、Skill 改名和映射漂移。

需要一个专门的维护编排 Skill 统一处理上述生命周期，避免员工逐个判断“哪个 Skill 应该引用哪份文件”。

## 2. 目标

新建 `crwu-audit-skill-maintainer`，用于：

1. 创建新的 `crwu-audit-asset-*` 或 `crwu-audit-biz-*` 子 Skill。
2. 修正现有资产或业务 Skill 的结构、名称、适用边界和知识库映射。
3. 根据钉钉知识库最新目录，为每个 Skill 建立“一级目录根映射”。
4. 维护一级目录与细分对象、子业务之间的二级选择规则。
5. 检查资产、业务 Skill 与分类表、registry、知识库路径之间的一致性。
6. 在用户确认变更方案后，同步更新 source repo 中的分类、registry 和映射文件。

核心结果是：维护者只需提供目标资产、业务或 Skill，本 Skill 主动发现其一级目录、目录内全部审核资料和二级分类关系，并完成来源核验、映射设计、代码修改和验证。

## 3. 核心模型

### 3.1 一级目录决定 Skill

- 一个资产 Skill 对应 `02-资产类型/` 下一个一级资产目录。例如，房地产 Skill 只映射 `02-资产类型/01-房地产/`。
- 一个业务 Skill 对应 `01-业务路线/` 下一个一级业务目录。例如，资产经营 Skill 只映射 `01-业务路线/01-资产经营/`。
- 资产 Skill 使用 `crwu-audit-asset-*` 前缀。
- 业务 Skill 统一使用 `crwu-audit-biz-*` 前缀，不再使用 `crwu-audit-business-*`。
- registry 只登记一级资产 Skill 和一级业务 Skill，不为每个细分对象或子业务创建独立 Skill。
- 不创建 `资产 × 业务` 组合 Skill。

### 3.2 一级目录全量下载

正式审核命中某个一级资产或一级业务 Skill 后，通过 `crwu-dws` 递归下载该 Skill 映射根目录下全部可读文档，不在装配表中人工挑选单个文件。

- 房地产 Skill 命中后，递归下载 `02-资产类型/01-房地产/` 下全部可读文档。
- 资产经营 Skill 命中后，递归下载 `01-业务路线/01-资产经营/` 下全部可读文档。
- 同一报告命中多个一级资产或一级业务时，各命中根目录均需下载，去重后形成稳定并集。
- 下载失败、空目录或不支持导出的节点必须形成 capability gap，不得静默忽略。
- 下载内容只进入本次任务的临时目录和 manifest，不复制进 Skill source。

“清单外零下载”仍然成立：`01-kb-assembly.md` 明确登记的是一级目录根；该根目录下的递归展开属于已授权装配范围，不允许越过根目录继续抓取无关资产或业务。

### 3.3 二级对象和子业务负责精准选用

一级 Skill 在已下载目录包内执行二级分类，不改变一级路由：

- 资产轴选择 `asset_subobjects[]`，例如土地使用权。
- 业务轴选择 `business_subroutes[]`，例如租赁与租金评估。
- 二级结果必须包含 `parent_label`、`label`、`evidence`、`confidence` 和 `review_required`。
- 二级分类以评估对象、资产明细、权属材料和评估目的等原始证据为准，不得只根据文件名或报告标题判断。
- 同时命中多个细分对象或子业务时全部保留，不使用首个命中即停止的规则。
- 低置信度时标记人工复核，并审阅全部合理候选条目，不得猜测唯一分类。

二级分类结果作为叶子 Skill 的结构化返回项并入审核运行记录，不回写或篡改 `crwu-audit` 已冻结的一级 `route_profile`。

## 4. 非目标

本 Skill 不负责：

- 执行正式评估报告审核或直接产生专业审核意见；
- 替代 `crwu-audit` 的运行时路由；
- 替代 `crwu-dws` 的钉钉查询和下载职责；
- 依据复核反馈判断漏检、误检根因；该职责仍属于 `crwu-audit-optimize`；
- 修改钉钉知识库正文或远端目录；
- 安装或直接修改 `~/.dsh`、`~/.workbuddy`、`~/.skills-manager` 等运行时 Skill；
- 把细分对象或子业务拆成独立 Skill；
- 把历史问题案例当作当前项目事实或准则依据。

## 5. 与现有 Skill 的边界

| Skill | 唯一职责 | 与本 Skill 的关系 |
| --- | --- | --- |
| `crwu-audit` | 正式审核的一级画像、路由、并集加载和结果汇总 | 本 Skill 读取并维护其分类表和 registry，不参与正式审核 |
| `crwu-dws` | 钉钉知识库目录查询、根目录递归下载和正文实时导出 | 本 Skill 调用它取得最新目录和维护所需正文，不复制命令逻辑 |
| `crwu-audit-optimize` | 根据漏检、误检、反馈和回测结果诊断需要修改什么 | 诊断结论涉及创建、修正或重映射 Skill 时，交由本 Skill 执行 |
| `crwu-audit-skill-maintainer` | 审核 Skill 的创建、修正、一级映射、二级选择规则和一致性维护 | 不出审核意见，不经 `crwu-audit` router 分发 |

## 6. Skill 结构

```text
skills/crwu-audit-skill-maintainer/
├── SKILL.md
├── references/
│   ├── 00-responsibility-and-modes.md
│   ├── 01-kb-source-discovery.md
│   ├── 02-child-skill-contract.md
│   ├── 03-review-item-execution-contract.md
│   ├── 04-registry-and-mapping-update.md
│   └── 05-validation-and-delivery.md
└── scripts/
    └── check_audit_skill_mappings.py
```

不创建 README、示例占位目录或下载正文副本。

### 6.1 `SKILL.md`

入口文件保持精简，只包含触发条件、禁止场景、运行模式、输入、reference 路由、总体步骤、修改审批门禁、停止条件和输出要求。

### 6.2 references

- `00-responsibility-and-modes.md`：职责边界、模式选择和输入规范。
- `01-kb-source-discovery.md`：如何解析一级资产/业务目录，并核对目录内共性资料、细分对象和子业务。
- `02-child-skill-contract.md`：资产/业务 Skill 的命名、目录、frontmatter、references 和二级分类合同。
- `03-review-item-execution-contract.md`：准则、必检项、历史高频问题和资料缺口的执行状态。
- `04-registry-and-mapping-update.md`：分类表、registry、装配表、README、设计文档和变更记录的同步规则。
- `05-validation-and-delivery.md`：校验命令、验收条件、失败输出和交付格式。

### 6.3 映射检查脚本

`check_audit_skill_mappings.py` 是只读检查器，不直接修改文件。它读取：

- `crwu-audit/references/03-asset-classification.md`；
- `crwu-audit/references/04-business-classification.md`；
- `crwu-audit/references/07-skill-registry.md`；
- `skills/crwu-audit-asset-*` 和 `skills/crwu-audit-biz-*`；
- 指定的 DWS `node-index.json` 或本次最新目录快照。

它同时识别遗留的 `crwu-audit-business-*`，但只能报为待迁移名称，不能把它当作新的标准命名。

检查器至少检测：

- registry 中 available Skill 目录不存在；
- 目录名、frontmatter `name` 和 registry 名称不一致；
- available Skill 缺少规定 references；
- 一级分类标签未在 registry 中恰好登记一次；
- 资产 Skill 未恰好映射一个 `02-资产类型/<一级资产>/` 根目录；
- 业务 Skill 未恰好映射一个 `01-业务路线/<一级业务>/` 根目录；
- `request kind` 不是 `directory`，或仍逐文件登记本应由根目录覆盖的来源；
- 映射根在最新目录中不存在；
- 资产一级目录缺少 `01-共性参考`，或细分对象缺少 `评估审核条目`；
- 业务一级目录下的子业务缺少 `01-业务通用审核要点`；
- source repo 存在未登记的资产或业务 Skill；
- 装配表保存了知识库名称、本地绝对路径、nodeId 常量或下载正文。

脚本不根据名称相似度自动改路径，只提供候选和证据。

## 7. 运行模式

### 7.1 `create`

用于新增一级资产或一级业务能力。输入至少包括：

- `axis=asset|business`；
- 一级 canonical label；
- 目标 Skill 名称，或允许按标准前缀生成；
- source repo 路径；
- 本次已确认的钉钉知识空间。

它解析一级目录、递归核对全部文档、建立二级分类表，输出方案；用户确认后才创建 Skill、references，并更新 classification 和 registry。

### 7.2 `repair`

用于修正名称、结构、边界、二级分类或知识根映射。先生成当前状态与目标状态差异，再由用户确认修改范围，不借修复目标 Skill 顺带改变其他无关 Skill。

### 7.3 `remap`

用于知识库目录调整、文件改名或装配根失效。以最新 DWS 目录为路径事实，以本次实时导出的正文为内容事实，重新生成一级根映射和二级目录索引。不得仅用旧缓存、历史摘录或名称相似度确认新路径。

### 7.4 `audit`

只读检查全部资产和业务 Skill，不修改文件。输出正常映射、失效路径、缺失 Skill、未注册 Skill、名称不一致、缺失 references、缺失审核条目和待人工确认项。

## 8. 知识来源发现与下载

### 8.1 目录事实与正文事实

- 目录事实来自 `crwu-dws` 本次在线完整遍历。缓存只用于定位加速；`create` 和 `remap` 必须刷新后确认。
- 正文事实来自本次通过 `crwu-dws` 实时导出的 Markdown。
- 下载文件只存于本次临时目录并附 manifest；任务结束后不提交、不复制进 Skill，也不写入目录缓存。
- source 中只保存库内层级根路径、二级相对路径、RULE/CHK 标识及归纳后的审核执行说明。
- 不保存知识库名称、个人绝对路径、nodeId 常量或逐字复制的知识库正文。

### 8.2 资产轴来源规则

资产 Skill 的唯一主映射为 `02-资产类型/<一级资产>/`，运行时递归下载其中全部可读文档。

对房地产类目录，执行顺序为：

1. 始终读取并应用 `01-共性参考/` 下全部文档，包括对象准则、定义分类、共性评估审核条目和相关复核条目。
2. 使用项目原始材料识别一个或多个细分对象。
3. 对每个命中的 `02-细分对象/<对象>/`，读取并执行其 `评估审核条目`。
4. 其他已下载但未命中的细分对象资料保留在 manifest 中，不强行套用；须记录未选用原因。

对象准则及其他现行强制性依据是硬约束：审核程序、推理和结论均不得与其冲突。发现来源之间存在版本或内容冲突时停止形成确定性结论，列明冲突并转人工复核。

资产 Skill 不写入租赁、抵押、转让等具体业务要求。

### 8.3 业务轴来源规则

业务 Skill 的唯一主映射为 `01-业务路线/<一级业务>/`，运行时递归下载其中全部可读文档。

对一级业务目录，执行顺序为：

1. 根据报告正文中的评估目的、经济行为文件、委托合同和相关审批材料识别一个或多个子业务。
2. 对每个命中的子业务，读取并执行其 `01-业务通用审核要点`。
3. 继续读取该子业务目录内的资产专项、方法适用索引、监管适用索引和其他关联文件。
4. 子业务分类不得只依赖报告名称；证据不足时标记 `review_required=true` 并检查所有合理候选。

业务目录中的资产专项只能按 `route_profile.asset_types[]` 和二级对象结果条件使用，不能据此创建组合 Skill。资产对象共性仍由对应资产 Skill 提供。

### 8.4 公共和其他轴来源

- 全局执行契约仍由 `crwu-audit` router 统一装配。
- 方法正文属于方法 Skill；业务和资产 Skill 使用目录中的方法适用索引，但不取代方法轴。
- 监管正文属于 overlay Skill；业务和资产 Skill 使用触发条件和适用索引，但不取代监管轴。
- 一级资产与一级业务根目录是必下来源；方法、监管和全局契约仍按现有多轴路由追加并集。

## 9. 审核条目执行合同

### 9.1 必检项

`必检项` 或 `必检项要点` 中每一项都必须逐项检查，不得静默跳过。每项输出：

| 字段 | 允许值或要求 |
| --- | --- |
| `status` | `符合`、`不符合`、`不适用`、`无法核验` |
| `report_evidence` | 当前报告页码、章节、表格或附件证据 |
| `rule_source` | 对应来源路径及 RULE/CHK 标识 |
| `reason` | `不适用` 或 `无法核验` 时必填 |
| `finding` | `不符合` 时形成的具体问题 |

如果业务文件的必检项部分仍写有“待补”，不得自行补造要求；应登记为知识库内容缺口，并提示该子业务的必检覆盖尚不完整。

### 9.2 历史高频复核问题

对命中审核条目中的每个历史问题或问题簇，必须检查当前项目是否涉及，状态为：

- `涉及`：当前报告存在对应风险迹象，并给出本项目证据；
- `未涉及`：已检查但当前报告未出现；
- `无法核验`：资料不足，并列明缺失资料。

历史次数、旧项目表述和案例只用于提示风险，不能作为现行规则、当前事实或审核结论的唯一依据。发现问题时，审核意见必须回到当前报告证据和适用准则、法规或规则；不得把历史案例原文套入当前项目。

### 9.3 准则与审核条目的优先关系

1. 现行法律法规、执业准则和有效监管规则构成硬约束。
2. 必检项用于确保这些约束和业务要求被完整执行。
3. 历史高频问题用于防止重复发生既往缺陷。
4. 审核经验用于补充检查视角，不得降低或覆盖更高层级要求。
5. 来源冲突、失效或版本不明时，记录 gap 并转人工判断，不得用较低层级经验覆盖准则。

## 10. 子 Skill 合同

资产和业务 Skill 统一采用：

```text
crwu-audit-asset-<一级资产>/
或 crwu-audit-biz-<一级业务>/
├── SKILL.md
└── references/
    ├── 00-applicability.md
    ├── 01-kb-assembly.md
    └── 02-review-focus.md
```

### 10.1 调用边界

每个 Skill 必须声明：

- 仅允许由 `crwu-audit` 编排调用；
- 不重新获取项目记录；
- 不替代其他轴；
- 不创建组合 Skill；
- 规则正文必须来自本次 `crwu-dws` 下载；
- 下载失败时记录 gap，不编造结论；
- 在一级目录包内执行二级对象或子业务分类；
- 必检项和历史高频问题必须按第 9 节形成逐项状态。

### 10.2 `00-applicability.md`

资产 Skill 保存一级资产的适用、排除、冲突和人工复核条件，并登记细分对象识别规则。业务 Skill 保存一级业务的适用边界，并登记子业务识别规则。二级条目只用于目录内选择，不新增 registry Skill。

### 10.3 `01-kb-assembly.md`

每个 Skill 的主映射至少包含：

| 字段 | 含义 |
| --- | --- |
| `source_key` | 稳定的本地映射标识 |
| `owner_axis` | `asset` 或 `business` |
| `canonical_label` | 一级资产或一级业务标签 |
| `kb_root` | 完整的一级目录库内路径 |
| `request_kind` | 必须为 `directory` |
| `recursive` | 必须为 `true` |
| `required` | 一级根必须为 `true` |
| `expected_structure` | 共性参考、细分对象或子业务审核文件的结构断言 |

装配表不再逐一列出根目录下的每份文件。二级相对路径可以作为结构断言和选择索引，但不能替代一级根目录全量下载。

### 10.4 `02-review-focus.md`

保存从真实来源归纳的共性审核关注点、二级选择方式和状态输出要求。每个关注点必须回指 `source_key`、相对路径和 RULE/CHK；不逐字复制正文，也不得把历史问题改写成无来源的强制规则。

## 11. 分类、registry 和映射同步

### 11.1 一级登记、二级索引

- `03-asset-classification.md` 维护一级资产标签、别名、细分对象识别规则和所属关系。
- `04-business-classification.md` 维护一级业务标签、子业务识别规则和所属关系。
- `07-skill-registry.md` 只登记一级 Skill；细分对象和子业务不得各占一个 Skill 行。
- 识别到细分对象或子业务后，仍分发其父级 Skill，再由父级 Skill 在已下载目录包内精准选用审核文件。

例如：

- `房地产` → `crwu-audit-asset-real-estate` → `02-资产类型/01-房地产/`；
- `土地使用权` → 父级仍为 `房地产`，在房地产 Skill 内选用 `02-细分对象/01-土地使用权/评估审核条目`；
- `资产经营` → `crwu-audit-biz-asset-operation` → `01-业务路线/01-资产经营/`；
- `租赁与租金评估` → 父级仍为 `资产经营`，在资产经营 Skill 内选用该子业务的 `01-业务通用审核要点` 和关联文件。

英文目录尾名由仓库既有命名规则生成；上述示例只表示层级关系，创建前仍需检查冲突和现有迁移状态。

### 11.2 创建、修复和改名

新增或修改能力时同步检查：

1. `03-asset-classification.md` 或 `04-business-classification.md`；
2. `07-skill-registry.md`；
3. 目标 Skill 及三份 references；
4. `skills/README.md`；
5. 相关设计文档和 `docs/CHANGELOG.md`；
6. router、测试和其他 references 中的名称引用。

不得出现 registry 已标记 `available`，但真实目录、必备 references、一级根映射或验证尚未完成的状态。

### 11.3 状态规则

- `available`：真实 Skill、三份 reference、一级根、二级索引和全部完成门禁均已通过。
- `pending`：一级分类已识别但能力未完成，只在 registry 记录，不创建空 Skill 目录。
- `profile-only`：仅保留画像，不需要执行 Skill。
- 二级对象或子业务缺少审核文件时，不虚构独立 Skill；在父级 Skill 中记录 capability gap。

## 12. 修改门禁

本 Skill 每次执行分成两个阶段。

### 阶段一：只读分析

1. 记录 git 基线状态和目标文件 hash。
2. 读取 classification、registry、目标 Skill 和 references。
3. 刷新 DWS 目录并锁定一级目录根。
4. 递归下载根目录全部可读正文，核对共性资料、细分对象和子业务结构。
5. 输出《子 Skill 维护方案》，逐文件列出拟新增、修改、移动和删除内容。

阶段一不得修改 source repo。

### 阶段二：确认后修改

用户明确确认方案后：

1. 检查目标文件相对阶段一是否变化；有变化立即停止并重新分析。
2. 只修改方案列出的 source repo 文件。
3. 不改运行时 Skill 目录。
4. 更新 classification、registry、references、README、设计文档和变更记录。
5. 执行完整验证并输出结果。

用户只要求 `audit` 时永不进入阶段二。

## 13. 验证

### 13.1 映射检查器测试

使用临时 fixture 覆盖：

- available Skill 完整存在及目录缺失；
- frontmatter、目录名和 registry 不一致；
- classification 标签重复或漏注册；
- 必备 reference 缺失；
- 一级根存在、不存在、越界或 request kind 错误；
- 仍采用逐文件映射而未登记一级根；
- 资产共性参考、细分对象审核条目缺失；
- 业务子目录的 `01-业务通用审核要点` 缺失；
- orphan Skill、禁止字面和 nodeId 常量；
- `crwu-audit-business-*` 遗留名称；
- asset/biz 轴前缀错误。

### 13.2 仓库门禁

实现后至少运行：

```bash
python3 tools/kb/test_audit_skill_maintainer.py
python3 tools/kb/test_audit_multiaxis_router.py
python3 tools/kb/test_dws_source_contract.py
python3 tools/kb/kb_tool.py validate --skill-root skills
python3 <skill-creator>/scripts/quick_validate.py skills/crwu-audit-skill-maintainer
git diff --check
```

如果验证因本地知识库索引不存在或经批准的迁移中间态失败，必须报告真实失败项，不得宣称完整通过。

### 13.3 验收场景

第一版至少证明：

1. 能发现 registry 指向不存在的 available Skill。
2. 能发现旧 `crwu-audit-realestate-rent` 或 `crwu-audit-business-*` 与新分轴命名不一致。
3. 能发现逐文件房地产映射与“一级目录根映射”不一致。
4. 能为 `房地产` 生成唯一资产根并识别 `土地使用权` 细分对象。
5. 能为 `资产经营` 生成唯一业务根，并根据评估目的准确识别 `租赁与租金评估`。
6. 能检查全部共性文件、命中细分对象审核条目和命中子业务审核要点已进入执行清单。
7. 能逐项输出必检项及历史问题状态，不把历史案例当作当前事实。
8. 能在用户确认后更新映射，同时保留工作区中的无关修改。

## 14. 失败处理

- DWS 在线刷新失败：不创建、不重映射、不把缓存结论标为最新。
- 一级根零命中或多命中：保持 pending，不猜路径。
- 递归下载不完整：记录具体失败节点，本次能力不得标记完整可用。
- 二级分类证据不足：保留全部合理候选并标记人工复核。
- 必检项为“待补”：登记知识库内容缺口，不自行编造。
- RULE/CHK、准则或版本冲突：并列记录冲突和来源，等待专业确认。
- source repo 在方案确认前后变化：停止修改，重新计算差异。
- 工作区存在无关修改：保留且不提交；无法隔离目标文件时停止。
- 验证失败：保持真实状态，不把能力改为 available。

## 15. 交付结果

每次运行输出：

1. 目标 axis、一级 label 和 Skill；
2. 本次 DWS 目录抓取时间与空间身份；
3. 一级根、递归下载 manifest 和失败节点；
4. 二级对象或子业务分类及其证据；
5. 准则、必检项和历史问题的装配覆盖；
6. classification、registry、Skill 和 references 变化；
7. 映射新增、失效和待确认项；
8. 验证命令与真实结果；
9. 未完成项和 capability gap；
10. 本次实际修改的 source repo 文件清单。

下载正文、凭据、运行时 manifest 和临时文件不进入提交。

## 16. 初始实现范围

第一版完成：

- 新建 `crwu-audit-skill-maintainer` 及六份 references；
- 新建只读映射检查脚本及测试；
- 在 `skills/README.md` 登记维护 Skill；
- 在 `crwu-audit-optimize` 中增加经确认后的维护交接说明；
- 更新相关设计文档和变更记录；
- 使用房地产、土地使用权、资产经营和租赁与租金评估验证一级根下载、二级精准选择及审核条目执行合同。

第一版不自动批量修正全部现有资产和业务 Skill。实际修复由本 Skill 先输出逐文件方案，再在用户确认后执行，以免覆盖当前正在进行的迁移工作。
