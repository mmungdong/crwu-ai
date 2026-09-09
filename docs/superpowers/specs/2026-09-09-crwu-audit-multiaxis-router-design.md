# crwu-audit 多维并集路由重构设计

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-09 |
| 状态 | 已确认，待实施计划 |
| 范围 | `skills/crwu-audit*` 路由、技能命名、references 与配套文档 |
| 变更性质 | 破坏性重构，不保留旧组合技能兼容入口 |

## 1. 背景

现有审核能力族使用 `L0 总路由 → L1 资产大方向 → L2 资产×场景组合技能` 的树形模型。例如，房地产租赁由 `crwu-audit-realestate-rent` 承载。随着清算、处置、拍卖、抵押等业务能力增加，该模型会产生大量“资产类型×业务类型”组合技能，造成规则重复、命名混乱和漏装检查能力。

本次重构把路由改为多个正交维度独立识别、分别映射技能、最终取并集同时加载。资产专业判断与业务场景判断由不同技能承担，不再选择单一组合技能。

## 2. 目标与非目标

### 2.1 目标

- 将评估范围、资产类型、业务类型、评估方法和监管覆盖层拆成独立画像维度。
- 资产类型和业务类型均支持多标签，不采用“首次命中即停止”。
- 各维度分别映射为技能集合，去重后同时加载。
- 企业价值项目加载范围技能，并叠加所有实际参与估值的资产技能。
- 主路由 `SKILL.md` 保持精简；字段、分类、注册表和并集规则下沉到 `references/`。
- 每个叶子技能的 `SKILL.md` 只保留职责、调用前置和 reference 指针。
- 保留命中依据、来源、置信度和人工复核状态，保证路由可解释。
- 删除 `crwu-audit-realestate-rent`，不保留兼容入口。

### 2.2 非目标

- 本次不复制钉钉知识库正文到技能仓库。
- 本次不改变 `crwu-dws` 的实时下载和引用协议。
- 本次不把 A/B/C 审核风险等级作为业务类型。
- 本次不为每个报告流水号创建静态 reference 文件。
- 本次不减少公共审核、数据勾稽、方法或监管检查点。

## 3. 核心领域模型

### 3.1 正交维度

| 维度 | 字段 | 示例 | 是否多标签 | 技能前缀 |
| --- | --- | --- | --- | --- |
| 报告范围 | `scope_types[]` | 单项资产、资产组合、企业价值 | 是 | `crwu-audit-scope-*` |
| 资产类型 | `asset_types[]` | 房地产、设备、无形资产、存货、债权 | 是 | `crwu-audit-asset-*` |
| 业务类型 | `business_types[]` | 租赁、清算、资产处置、拍卖、抵押 | 是 | `crwu-audit-business-*` |
| 评估方法 | `methods[]` | 市场法、收益法、成本法、资产基础法 | 是 | `crwu-audit-method-*` |
| 监管覆盖层 | `overlays[]` | 国资、证券、司法、金融 | 是 | `crwu-audit-overlay-*` |

`单项资产` 是报告范围，不等于资产类型。`企业价值` 是整体估值范围，不作为底层资产类型。

### 3.2 审核风险分类

现有 `business_risk_class` 表示机构 A/B/C 审核风险等级，不是租赁、清算等业务场景。重构后改名为 `review_risk_class`，继续只用于审核严谨度参考、首页标注和字段一致性校验，不参与技能裁剪。

### 3.3 命中记录

每个分类标签必须保留完整解释信息：

```jsonc
{
  "type": "清算",
  "skill": "crwu-audit-business-liquidation",
  "sources": ["F0000064", "报告目的原文"],
  "evidence": ["企业清算", "为破产清算提供价值参考"],
  "confidence": "high",
  "review_required": false
}
```

字段直读或真实报告原文命中为高置信度；报告名称推断为中或低置信度；来源冲突或仅弱信号命中时标记人工复核。不得根据经验补写不存在的报告原文或定位信息。

## 4. 报告标识解析

主路由接受两种输入：

- `SeqNo`：用户可见的报告流水号；先查询并解析为唯一 `ObjectId`。
- `ObjectId`：氚云记录 ID；直接读取记录。

处理规则：

1. 判断输入标识类型。
2. `SeqNo` 通过报告审核表查询，返回唯一结果后取得 `ObjectId`。
3. 无结果、多个结果或字段冲突时停止路由并要求人工确认。
4. `ObjectId` 必须来自用户输入或真实查询结果，禁止猜测。
5. 主路由只读取一次记录并形成统一 `route_profile`；叶子技能接收画像与已准备的材料路径，不重复查询报告记录。

## 5. 分类与分发流程

```text
SeqNo/ObjectId
      ↓
解析唯一 ObjectId 并读取报告记录
      ↓
读取报告字段、报告名称及已真实读取的材料证据
      ↓
分别计算 scope_types[] / asset_types[] / business_types[]
methods[] / overlays[] / review_risk_class
      ↓
各标签独立查询 skill registry
      ↓
skills_to_load = scope ∪ asset ∪ business ∪ method ∪ overlay ∪ public
      ↓
去重后同时加载、执行
      ↓
按检查点及证据去重汇总，保留 source_skill[]
```

分类不使用 `else-if` 排他链。某个业务标签命中后继续检查剩余业务标签；某个资产类型命中后继续识别其余实际参与估值的资产类型。

### 5.1 资产类型识别

资产类型主要依据对象大类、评估范围、报告名称中的评估对象描述和真实材料中的对象范围识别。`房建类` 标准化为“房地产及房屋建（构）筑物”，对外简写可为“房地产”，但必须保留构筑物、场地、井等边界说明。

### 5.2 业务类型识别

业务类型主要依据评估目的和业务大类，并用报告名称及真实读取的评估目的原文补充或校验。业务类型是多标签集合，例如：

- “破产清算后拍卖处置”同时命中清算、资产处置和拍卖。
- “抵债后拟转让”同时命中抵债、债务处置和资产转让。
- “投资性房地产公允价值后续计量”命中财务报告、公允价值计量，资产类型命中房地产。

### 5.3 企业价值与多资产

企业价值项目加载 `crwu-audit-scope-enterprise-value`，并从评估范围、资产基础法明细和报告说明中识别实际参与估值的底层资产类型：

- 单独评估或对结论有实质影响的资产类型加载对应资产技能，并标记 `materiality=key`。
- 仅按账面值列示、未单独评估的资产仍保留标签并标记 `materiality=non-key`，在路由说明中披露，但不得主导审核输出。
- 无法确认是否参与估值时标记 `review_required=true`，不得静默排除。

## 6. 并集加载和汇总规则

### 6.1 技能集合

```jsonc
{
  "dispatch": {
    "scope_skills": ["crwu-audit-scope-enterprise-value"],
    "asset_skills": [
      "crwu-audit-asset-realestate",
      "crwu-audit-asset-equipment",
      "crwu-audit-asset-intangible"
    ],
    "business_skills": [
      "crwu-audit-business-liquidation",
      "crwu-audit-business-disposal",
      "crwu-audit-business-auction"
    ],
    "method_skills": ["crwu-audit-method-asset-approach"],
    "overlay_skills": ["crwu-audit-overlay-state-owned"],
    "public_skills": ["crwu-audit-datacheck"],
    "skills_to_load": []
  }
}
```

`skills_to_load` 是以上集合按稳定顺序取并集后的结果。顺序只用于可复现的执行和展示，不表示后加载技能覆盖先加载技能。

### 6.2 意见汇总

- 所有已命中且可用的技能都必须执行，不因已有技能给出结论而跳过其他技能。
- 相同检查点或相同事实问题合并为一条意见，`source_skills[]` 保留全部来源技能。
- 严重度不一致时保留较高严重度，同时列出冲突来源和依据，禁止静默覆盖。
- 技能不可用时，只对该标签输出能力缺口；其他已命中技能继续执行。
- 画像歧义与材料事实冲突仍按现有 ROUTE 冲突机制暂停受影响维度，不阻断无冲突的独立维度。

## 7. 技能命名与职责

### 7.1 命名规范

```text
crwu-audit                         总路由
crwu-audit-scope-*                 报告范围与整体估值结构
crwu-audit-asset-*                 资产类型专业审核
crwu-audit-business-*              业务场景审核
crwu-audit-method-*                评估方法审核
crwu-audit-overlay-*               监管覆盖层
crwu-audit-datacheck               跨维度公共能力
```

资产统一使用 `asset-` 前缀，不使用 `property-`。`property` 容易被理解为房地产，不能准确覆盖设备、无形资产等类型。

### 7.2 首批迁移

| 现有技能 | 目标 | 处理 |
| --- | --- | --- |
| `crwu-audit-realestate` | `crwu-audit-asset-realestate` | 重命名并收敛为房地产资产专业逻辑 |
| `crwu-audit-realestate-rent` | 无 | 直接删除，不保留兼容入口 |
| 现有租赁专项内容 | `crwu-audit-business-rent` | 提取通用租赁业务逻辑；房地产对象逻辑留在资产技能 |
| `crwu-audit-datacheck` | 原名 | 保持跨维度公共能力定位 |

房地产租赁的资产×业务交叉规则不再通过组合技能实现。路由同时加载房地产和租赁技能，知识装配使用同一个多维 `route_profile` 选择适用检查点。

## 8. references 结构

### 8.1 总路由

```text
skills/crwu-audit/
├── SKILL.md
└── references/
    ├── 00-input-and-route-profile.md
    ├── 01-report-id-resolution.md
    ├── 02-scope-classification.md
    ├── 03-asset-classification.md
    ├── 04-business-classification.md
    ├── 05-method-classification.md
    ├── 06-overlay-classification.md
    ├── 07-skill-registry.md
    ├── 08-union-dispatch-rules.md
    ├── 09-review-risk-classification.md
    └── 99-maintenance.md
```

主 `SKILL.md` 仅保留触发边界、输入、执行顺序、强制 reference 指针、分发与汇总门禁。不得再次内嵌完整字段表、分类词表或技能注册表。

### 8.2 叶子技能

```text
skills/crwu-audit-asset-realestate/
├── SKILL.md
└── references/
    ├── 00-applicability.md
    ├── 01-kb-assembly.md
    └── 02-review-focus.md
```

- `SKILL.md`：技能简介、职责、调用前置、必读 reference 和输出责任。
- `00-applicability.md`：该维度标签的定义、命中边界、排除项和冲突处理。
- `01-kb-assembly.md`：RULE/CHK 编号和知识库层级路径装配键，不复制知识正文。
- `02-review-focus.md`：该资产、业务、方法或覆盖层的审核关注方向。

简单技能可以合并 reference，但不得把大量分类或清单重新塞回 `SKILL.md`。

## 9. 新 route_profile

```jsonc
{
  "route_profile": {
    "identity": {
      "input": "2026-302495-LX10012-BG8617",
      "input_type": "SeqNo",
      "object_id": "真实查询所得 ObjectId"
    },
    "report_form": "资产评估业务",
    "scope_types": [
      {"type": "单项资产", "source": "F0000066", "confidence": "high"}
    ],
    "asset_types": [
      {"type": "房地产", "source": "F0000119+对象原文", "confidence": "high"}
    ],
    "business_types": [
      {"type": "清算", "source": "F0000064+目的原文", "confidence": "high"},
      {"type": "资产处置", "source": "报告名称", "confidence": "medium"},
      {"type": "拍卖", "source": "目的原文", "confidence": "high"}
    ],
    "methods": [],
    "overlays": [],
    "review_risk_class": {},
    "material_gaps": [],
    "conflicts": []
  },
  "dispatch": {
    "scope_skills": [],
    "asset_skills": ["crwu-audit-asset-realestate"],
    "business_skills": [
      "crwu-audit-business-liquidation",
      "crwu-audit-business-disposal",
      "crwu-audit-business-auction"
    ],
    "method_skills": [],
    "overlay_skills": [],
    "public_skills": [],
    "skills_to_load": [
      "crwu-audit-asset-realestate",
      "crwu-audit-business-liquidation",
      "crwu-audit-business-disposal",
      "crwu-audit-business-auction"
    ]
  }
}
```

## 10. 失败和降级处理

- 流水号无法唯一解析：停止，列出候选记录并要求人工确认。
- 分类 reference 缺失或标签未注册：保留标签，记录 `unregistered_skill`，生成能力缺口，不猜测技能名执行。
- 某维度证据冲突：暂停该维度的受影响标签，其他独立维度继续路由。
- 某技能待实现：记录缺口并继续执行其余技能，不将整个项目降级为单一兜底。
- 规则正文下载失败：按现有 crwu-dws 协议报告路径和原因，不缓存、不编造。
- 所有维度均未可靠命中：输出画像歧义，不执行专业审核结论。

## 11. 实施影响面

至少涉及：

- 重写 `skills/crwu-audit/SKILL.md` 与 references。
- 重命名 `skills/crwu-audit-realestate`。
- 删除 `skills/crwu-audit-realestate-rent`。
- 新建 `skills/crwu-audit-business-rent`，并迁移租赁业务关注点与 KB 装配映射。
- 更新 `skills/README.md`、`docs/design-crwu-audit-skills.md` 和 `docs/CHANGELOG.md`。
- 更新待建子技能提案中的命名和注册规范。
- 更新所有指向旧技能名、L1/L2 父子降级模型和单一 `dispatch.L1/L2` 的引用。
- 不直接修改运行时技能目录；部署仍由用户技能管理机制负责。

## 12. 验收标准

### 12.1 路由行为

- 房地产租赁：同时加载 `asset-realestate + business-rent`。
- 房地产清算拍卖处置：同时加载 `asset-realestate + business-liquidation + business-disposal + business-auction`。
- 设备抵押：同时加载 `asset-equipment + business-mortgage`。
- 企业价值清算且包含房地产、设备、无形资产：加载 `scope-enterprise-value`、三个资产技能和清算技能；非重点资产有明确标注。
- 多业务、多资产、多方法和多覆盖层均不发生首次命中短路。
- 删除后仓库内不存在对 `crwu-audit-realestate-rent` 的有效调用或注册。

### 12.2 结构与质量

- 主路由 `SKILL.md` 保持精简，并通过 skill 校验。
- 分类定义和注册表在 references 中只有一个事实源。
- 每个标签都有来源、证据、置信度和复核状态。
- 技能集合稳定排序、去重，执行结果保留全部来源技能。
- 原有实时知识下载、防幻觉、隐藏数据隔离、数据勾稽和审核风险严谨度规则不劣化。
- 相关设计、README 和 CHANGELOG 同步完成。

## 13. 已确认决策

- 资产类型和业务类型均允许多标签。
- 业务技能按并集同时加载，例如清算、处置和拍卖同时执行。
- 企业价值叠加所有实际参与估值的资产技能；非重点资产保留标签并说明。
- 资产技能统一使用 `asset-*` 前缀。
- 企业价值使用 `scope-*` 前缀。
- 分类、注册和装配参考信息下沉到 `references/`。
- `SKILL.md` 保持入口化和指针化。
- `crwu-audit-realestate-rent` 直接删除，不提供兼容入口。
