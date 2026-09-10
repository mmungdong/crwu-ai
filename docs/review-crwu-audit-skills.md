# crwu-audit 技能族评审（源仓口径）

| 版本 | v1.0 | 日期 | 2026-09-10 | 状态 | 评审报告（只读盘点；不修改技能） |
| --- | --- | --- | --- | --- | --- |
| 评审范围 | 源仓 `skills/` 下的 crwu-audit 技能族设计、划分、协作与内容支撑度 |
| 评审基线 | `skills/` 工作区快照（分轴改版已提交于 `d9cf150`，评审即对该提交内容；**治理文件 `skills/AGENTS.md` 在评审期间仍在修订，本报告以评审时工作区版本为准**，涉治理条款处已标注）；知识库目录快照 `中瑞世联评估审核知识库` `fetched_at=2026-09-10T14:18:56+08:00`（263 节点 / folder 102 / doc 161 / 深度 6）；业务轴正文抽样自 `2026-09-10T14:15:54+08:00` 的本次下载物 |
| 关联文档 | [`design-crwu-audit-skills.md`](design-crwu-audit-skills.md)、[`design-audit-live-kb-protocol.md`](design-audit-live-kb-protocol.md)、[`design-crwu-dws.md`](design-crwu-dws.md)、[`../skills/AGENTS.md`](../skills/AGENTS.md) |

> 本报告为**源仓口径**评审：只评判 `skills/` 中技能自身的架构、划分、协作、内容支撑与门禁设计。
> 运行态与部署侧问题（已安装技能版本滞后、`tools/` 未随技能分发、外部 `dws` CLI 与认证前提等）
> 不在本报告范围内，由部署方另行处理；本报告不作部署结论，也不据此评价目标 agent 仓。

---

## 0. 结论

**架构选型正确、引用纪律干净、技术链路自洽；真正的短板在「内容认领」与「覆盖分层」，不在代码。**

三个必须在源仓内解决的问题：

1. **通用兜底层缺失** —— 「报告准则通用披露」只登记在 `crwu-audit-asset-realestate` 一个具体叶子里，
   `public` 轴只有 `crwu-audit-datacheck`。对象非房地产时，**通用披露层没有任何技能会装配**，
   设备 / 企业价值 / 无形资产等场景结构性出不了专业结论。
2. **业务轴：粒度偏重、真实内容未被计入技能** —— 8 个业务叶子按治理要求同构（属有意基线），
   但差异化内容约 15 行/技能；知识库中 **24 个文件 / 258 KB / 560 条**真实量化历史问题
   （每条带次数·项目数·分类标签）实际可用，现有叶子只保留了「分类标签」，
   **丢弃了最有价值的频次/项目数分诊与排序信号**，审核执行时无法据以排优先级。
   （叶子对「必检项待补」记 gap 已符合现行治理规则，见 §4。）
3. **旗舰清单孤儿** —— `06-规则库/清单-M-市场法`（CHK-MKT-001~014）与
   `06-规则库/清单-M-成本法`（CHK-CST-001~012）仍在知识库中，`crwu-audit-realestate-rent`
   下架后无人引用，商铺租金场景的专项检查点归零。

### 评级

| 维度 | 评级 | 依据 |
| --- | --- | --- |
| 架构选型 | **B+** | 分轴并集 + 唯一注册表 + 公共契约单份；禁组合技能彻底消灭组合爆炸 |
| 引用纪律 | **A-** | 9 叶子 + router 无知识库名 / 绝对路径 / 字面正文 / `nodeId` 常量；56 条库内路径 100% 命中 |
| 实施完整度 | **B-** | 契约 12 条中多条未在叶子落地（见 §5） |
| 内容支撑度 | **C** | 房地产对象层真实；业务 / 方法 / 监管三轴实质空缺；旗舰场景清单被下架 |
| 门禁可信度 | **D** | 治理已把「映射检查器 error=0」列为硬门禁，但该检查器对真实知识库快照误报 error 105 / warning 9（9 个一级根全判「已不存在」）→ **门禁当前不可通过**；校准表亦系对代理快照生成（见 §6） |

---

## 1. 技能配合链路：逐环节自洽性

| 环节 | 载体 | 判定 |
| --- | --- | --- |
| 记录定位 | [`01-report-id-resolution.md`](../skills/crwu-audit/references/01-report-id-resolution.md) | ✅ 精确 `SeqNo` 查询、0/多条即停，不猜 schema code |
| 画像 schema | [`00-input-and-route-profile.md`](../skills/crwu-audit/references/00-input-and-route-profile.md) | ✅ `source/evidence/location` 数组三元组定义清晰；「未抽验（文件未读取）」硬约束到位 |
| 五轴分类 | `02`–`06` | ✅ 多标签、禁 first-match、禁排他链；A/B/C 只影响严谨度、不裁剪审核角度 |
| 注册表解析 | [`07-skill-registry.md`](../skills/crwu-audit/references/07-skill-registry.md) | ✅ `04` 的 8 个一级业务标签 ↔ `07` 恰好一对一；26 个子业务与 `04` 及各叶子 `00-applicability.md` 顺序一致（已逐条核对） |
| 稳定并集 | [`08-union-dispatch-rules.md`](../skills/crwu-audit/references/08-union-dispatch-rules.md) | ✅ `stable_unique` 轴序固定、六数组全求值、禁短路；4 个示例场景与叶子能力对得上 |
| 叶子共同约束 | [`12-leaf-common-contract.md`](../skills/crwu-audit/references/12-leaf-common-contract.md) | ✅ 130 行承载轴边界 / 输入 / 一级根 / 二级选择 / 执行顺序 / 条目状态 / 来源优先级 / 证据 / gap，公共规则只写一份 |
| 装配清单 | 各叶子 `references/01-kb-assembly.md` | ✅ 9 个叶子**每个恰好一个一级根**（`directory` / `recursive=true` / `required=true`）；56 条库内路径全部命中真实库 |
| 两阶段门禁与交付 | [`11-html-delivery-spec.md`](../skills/crwu-audit/references/11-html-delivery-spec.md)（38 KB） | ✅ 规范完整，与 `tools/audit/` 实现（24 项契约测试）一致 |
| 元技能分工 | [`crwu-audit-optimize`](../skills/crwu-audit-optimize/SKILL.md) / [`crwu-audit-skill-maintainer`](../skills/crwu-audit-skill-maintainer/SKILL.md) | ✅ 分桶表（A/C/D 归 optimize，B/E 归 maintainer）+ 交接内容 + 「不继承修改授权」，是本族设计最成熟的一块 |

**链路无循环依赖、无排他链、无轴间互替。** 问题集中在「末端由谁装配什么」。

---

## 2. 划分评价

### 2.1 做对的地方

- **禁「资产 × 业务」组合技能 + 稳定并集**：消灭组合爆炸，registry 是唯一维护点。
- **技能粒度 = 知识库一级目录**：`02-资产类型/01-房地产/` 与 8 个 `01-业务路线/0N-*/` 全部一一对应，
  与 [`skills/AGENTS.md`](../skills/AGENTS.md) 的粒度约束完全一致；细分对象 / 子业务下沉为二级索引，
  不为它们建空技能。
- **公共约束只写一份**：轴边界、执行顺序、条目状态等收敛到 `12-leaf-common-contract.md`。

### 2.2 结构性问题

#### 问题 1：通用兜底层没有归属（P0）

契约 §3 规定资产轴只管对象、业务轴只管场景，method / overlay / public 各管一摊。但
`REPORT_DISCLOSURE_GENERAL`（`06-规则库/02-通用准则-报告与披露/报告准则-精编条目/…`）
**只登记在 [`crwu-audit-asset-realestate/references/01-kb-assembly.md:42`](../skills/crwu-audit-asset-realestate/references/01-kb-assembly.md)**，
全仓仅此一处。后果：

- 对象不是房地产 → 无叶子命中 → 通用披露层无人装配；
- `07` 的 `public` 轴只有 `crwu-audit-datacheck`（表格勾稽），**没有「通用报告 / 披露准则」能力**。

router 步骤 9 的「执行契约路径并集」不覆盖报告准则，掩盖不了该缺口。

#### 问题 2：asset 叶子越轴登记（P0）

[`crwu-audit-asset-realestate/references/01-kb-assembly.md:41-44`](../skills/crwu-audit-asset-realestate/references/01-kb-assembly.md)
在「其他轴共享依赖」名义下登记了 4 个 method / public 键：
`VALUATION_METHOD_INTERFACE`、`REPORT_DISCLOSURE_GENERAL`、`EXECUTION_CONTRACT`、`CALIBRATION_BACKTEST`
——**全仓只出现在这一个文件里**。

契约 §4 明写「全局执行契约、方法正文、监管正文由 router 的其他轴装配，**不复制进本轴的根映射**」。
而 method / overlay 轴技能全 `pending`，这些内容**实际只能靠这条共享依赖捎带**，
属 pending 轴的隐性替代；method 轴落地时必然冲突。

#### 问题 3：method / overlay 轴的 registry 标签与知识库目录语义不对齐（P1）

| registry 标签（`07`） | `03-评估方法/` 实际目录 |
| --- | --- |
| 市场法 / 收益法 / 资产基础法 | ✅ `01-市场法` / `02-收益法` / `03-资产基础法` |
| **成本法 / 假设开发法 / 基准地价系数修正法 / 路线价法** | ❌ **无对应目录** |
| （无标签） | ⚠️ `04-方法选择` / `05-审核要点` 有目录无标签 |

`04-监管覆盖/` 同理：registry 标签「金融/银行」→ 目录实为「**金融国资**」；
知识库有「财务报告」目录但 registry 无对应 overlay 标签。

按 `skills/AGENTS.md`「一个 Skill 恰好映射一个一级业务/资产目录」的规则，
method 轴有 4 个标签建不出技能、2 个目录无标签认领——**将来建技能会卡住或建错**。

#### 问题 4：业务轴粒度偏重 + 叶子复述共同规则（P1，已由治理修订部分吸收）

实测：8 个 `SKILL.md` **各 38 行，任意两个 `diff` 只差 6 行**；18 行逐字节相同。
`00-applicability.md` 13 行相同、`01-kb-assembly.md` 12 行相同、`02-review-focus.md` 10 行相同。
业务轴合计 1132 行，**差异化内容约 15 行/技能**（root 行 + 子业务清单 + 历史条数）。

需要区分两件事：

- **同构本身不是问题**。现行 `skills/AGENTS.md` 明确「新建叶子时以任一 `crwu-audit-biz-*` 的四件套为版式基线」
  ——即模板化是治理要求。真正的问题是**粒度**：`design-crwu-audit-skills.md` §2 自定的拆分裂据是
  「凡需要**不同清单 / 不同关注点**的即拆细分能力」，而这 8 个技能彼此**没有不同清单**
  （§一必检项全为「待补」，§二历史问题来自同一套数据驱动生成），
  8× 维护成本当前换 0 增量能力。是否合并取决于「一业务一技能」这条治理规则是否保留，
  属需用户决策的结构改动，本报告不擅自建议执行。
- **叶子的确复述了共同规则**。现行 `skills/AGENTS.md` 要求「叶子 `SKILL.md` 用相对路径引用
  `12-leaf-common-contract.md`，**只写本轴/本标签特有内容，不得复述共同规则**」，
  但每个 biz 叶子仍逐字重复了三处共同规则：① 轴边界声明句（`SKILL.md:14`，8 个文件逐字相同）；
  ② 一级共用层的执行顺序句（`02-review-focus.md`，含共用层「不存在」的叶子也照抄「共用层先于子业务执行」）；
  ③ 契约 §7 状态字段表（`02-review-focus.md`「## 输出要求」，先写「见共同约束 §7」再复述其内容）。

---

## 3. 知识库资产认领盘点

对 9 个叶子 + router **不可达**的知识库节点：**137 / 256（约 54%）**。

| 未被认领的库内容 | 节点数 | 归属状态 |
| --- | --- | --- |
| `04-监管覆盖/{证券,司法,国资,财务报告,金融国资}` | 11 | overlay 4 技能全 `pending`；且**每目录只有一个 README，无审核文件** |
| `03-评估方法/01-市场法 … 05-审核要点`（有真实内容） | ~20 | method 7 技能全 `pending`；仅 `00-评估方法准则2019-精编` 被 asset 叶子捎带 |
| **`06-规则库/清单-M-市场法/不动产-房产-市场法租金比较-报告审核`**<br>**`06-规则库/清单-M-成本法/不动产-房产-成本法-报告审核`** | 4 | ⚠️ `crwu-audit-realestate-rent` 下架后无人认领（CHK-MKT-001~014 / CHK-CST-001~012） |
| `06-规则库/00-法律法规`(8)、`01-监管规则与口径`(3)、`03-通用准则-程序与档案`(18)、`M-收益法`(1)、`M-法律法规合规`(1)、`模板库`(2)、`易错点库`(1)、`素材-官方原文`(13) | 51 | 无任何技能引用 |
| `05-风险案例` | 2 | README only |
| `02-资产类型/TODO`(23)、`01-业务路线/TODO`(8) | 31 | 库侧待办，无技能对应 |
| `00-总纲/执行契约/01-调度器-SKILL总纲`、`00-总纲/README`、`00-总纲/目录地图` | 3 | 仅维护侧引用 |

其中**只有「清单-M-市场法 / 清单-M-成本法」属「库里已有、技能不要」**，其余多为库侧本身尚无内容。

---

## 4. 业务轴的**真实**内容状况

叶子自述的下载时刻为 `2026-09-10T14:15:54+08:00`；核对该次下载物：

| 文件 | 实际内容 |
| --- | --- |
| `01-业务路线/01-资产经营/共同审核点` | **5 字节 `TODO`** → 叶子判断正确 ✅ |
| `…/租赁与租金评估/02-方法适用索引`、`03-监管适用索引` | **0 字节** → 叶子判断正确 ✅ |
| `…/租赁与租金评估/01-业务通用审核要点` | **12,650 B / 95 行**：§一 必检项 = `（待补：行为级必捡项要点…）`；**§二 历史高频复核问题 30 条**，每条带 `1173 次 · 651 个项目 · 参数与测算过程/明细表与勾稽` 与真实项目号示例 |

**24 个子业务要点文件合计 258 KB / 560 条历史高频复核问题**
（最大 `计税价格` 19,932 B，最小 `股权转让` 1,386 B）；该次下载清单 metadata 中
这批文件的 `placeholder` 字段为 **`false`**，仅 `共同审核点` 为 `true`
——即「placeholder」这个机器判据本身就把这批文件判为**非占位**。

### 4.1 先厘清：叶子对「待补」记 gap 是**合规的**

现行 `skills/AGENTS.md` 已明确区分两种处置：

> **部分内容待补但其余可真实归纳**（例：审核要点文件存在且「历史高频复核问题」有真实数据，
> 仅「必检项要点」写「待补」）→ 可以标 `available`，但必须在该叶子对应位置明确声明覆盖不完整并记 gap；
> 不得用"已 available"掩盖内容缺口，也不得补造缺失部分。

对照该规则，8 个业务叶子的做法（标 `available` + 在 `02-review-focus.md` 声明
「必检项要点…内容为「待补」→ 知识库内容缺口…本次声明该子业务必检覆盖不完整」）**符合治理要求**，
本报告不将其列为缺陷。叶子也如实登记了 §二 的条数（`历史高频复核问题：30 条（数据驱动）`）与执行方式
（`逐条输出 涉及／未涉及／无法核验`），并非隐瞒。

### 4.2 残留问题：最有价值的信号没进技能

`§二 历史高频复核问题` 每条正文的实际形态是：

```
**本次审核是否涉及调整评估值，如涉及请说明是否认真核对计算过程、链接及报告说明的同步完善**
`1173 次 · 651 个项目 · 参数与测算过程/明细表与勾稽`
    - 例：…（2024-300134-LX0348-BG2757 / 三级复核意见）
```

即每条自带 **出现次数、涉及项目数、问题分类标签** 三个量化字段。而叶子在
`02-review-focus.md` 里只保留了最后一项：

> 覆盖的检查维度（源自问题分类标签，按需求在正文内逐条枚举）：明细表与勾稽、工作底稿与程序、
> 参数与测算过程、报告披露与表述、签字盖章与格式、评估目的与经济行为。

**频次与项目数被丢弃**。这是 560 条问题里唯一可用于
**排序与分诊**（先查 1173 次的、后查 2 次的）的信号；缺了它，执行 agent 只能等权对待全部条目，
审核深度与复核命中率都不可控。建议在叶子中保留「高频 TOP-N + 次数」的摘要层
（属内容层改动，归口 `crwu-audit-optimize`）。

### 4.3 次要表述建议

叶子的标题层未把「§一 缺口」与「§二 可用」分开（同一段并列），易被执行 agent 读成整体缺口。
现行规则已要求「在该叶子对应位置明确声明覆盖不完整」，若进一步把该声明限定在 §一，
并显式写出「§二 有 N 条可用历史问题」，可消歧义。属表述层建议，非缺陷。

---

## 5. 契约实现缺口清单（叶子侧）

| 契约条款（`12-leaf-common-contract.md`） | `crwu-audit-asset-realestate` | 8 个 `crwu-audit-biz-*` |
| --- | --- | --- |
| §1 仅经 router 调用门禁 | ✅ | ✅（8/8） |
| §4 恰好 1 个一级根 | ✅ | ✅（8/8） |
| §4 不复制其他轴根映射 | ❌ 4 个 method/public 键 | ✅（显式拒绝） |
| §5 `asset_subobjects[]` / `business_subroutes[]` | ✅ | ✅ |
| §5 **`selected_relative_paths`** | ❌ | ❌ **9 个叶子 0 命中** |
| §6 一级共用层先行 | ❌ `SKILL.md` / `02-review-focus.md` 均无该步骤 | ✅ |
| §6 「未选用及原因」登记 | ❌ | ❌（全仓 0 命中） |
| §7 条目状态 | ❌ 未引用 | ✅ |
| §9 RULE/CHK 编号 | ⚠️ 有 RULE、**0 个 CHK** | ❌ **8 个文件全 0** |
| §9 库内层级路径 | ❌ 悬空键 `REAL_ESTATE_OBJECT`（12 次，`01-kb-assembly.md` 未登记）；`02-review-focus.md` **无任何字面路径** | ✅ |
| §10 gap 字段完整性 / §10 引用 | 部分 | 部分 |
| §11 输出自检 | ❌ | ❌ **9 个叶子 0 命中** |
| §11 分区（报告 / 评估说明 / 测算明细表） | ✅ | ❌ 无分区概念 |

### 5.1 跨层缺失：叶子 → AuditResult 无字段映射

三处字段名互不相同，交付校验器的必填项只能由 router 现场编：

- 契约 §7 叶子输出：`status` / `report_evidence` / `rule_source` / `reason` / `finding`；
- `tools/audit/audit_result.schema.json` 要求：`issueId` / `decision` / `issueType` / `severity` /
  `ruleEvidence[]` / `materialEvidence[]` / `gapAnalysis{ruleEvidence, materialEvidence, difference, finalJudgment}` / `recommendedEdits[]` …；
- [`11-html-delivery-spec.md`](../skills/crwu-audit/references/11-html-delivery-spec.md) §13.1 又写
  `findings` / `ruleEvidence` / `materialEvidence` / `adjudications` / `checkRecords`。

### 5.2 契约字段无接口对端

叶子全员使用 `request_kind` / `recursive` / `required`；`crwu-dws` 全程不用这三个字段名
（只用「路径尾随 `/`」约定），其 manifest 只有 `requestKind`，无 `recursive` / `required`。

### 5.3 asset 叶子收尾问题

现行 `skills/AGENTS.md` 已把两条写法规则显式化：「**一级根逐字使用库内精确路径**（含 `01-` 等数字排序前缀）；
带前缀与省略前缀是两条不同路径，不得按显示名简写」与「**寻址键写法**：逐字使用库内节点名…
单文件项**不得带 `.md`**；目录项必须以 `/` 结尾」。据此：

- [`01-kb-assembly.md:3`](../skills/crwu-audit-asset-realestate/references/01-kb-assembly.md)
  自己已声明「逐字使用库内节点名」，但 `:17` 的 `expected_structure` 写成
  `（总则与基本遵循 / 评估方法 / 操作要求 / 企业价值中不动产与披露附则 / README）`，
  省略了 `不动产准则-` 前缀——真实节点为
  `不动产准则-总则与基本遵循` / `不动产准则-评估方法` / `不动产准则-操作要求` /
  `不动产准则-企业价值中不动产与披露附则`。**当前不符合治理明文要求**（不影响一级根递归下载，
  但影响人工与机器按名核对）。
- 一级根本身 `02-资产类型/01-房地产/` 与 8 个业务根 `01-业务路线/0N-*/` **均带数字前缀、逐字正确** ✅。

---

## 6. 机器门禁可信度

现行 `skills/AGENTS.md` 已把「**映射检查器对本次最新目录 error=0**」列为
`available` 能力的**强制完成门禁**，并要求同时刷新校准表
`--emit-map skills/crwu-audit-skill-maintainer/references/07-kb-skill-map.md`。

### 6.1 主体缺陷：本轮评审发现并经修复（已可跑通）

评审发现：该检查器**对真实 `crwu-dws` 快照严重误报**：

```
crwu-audit Skill 映射盘点
一级资产 0 / 一级业务 0 / 错误 105 / 警告 9 / 建议 0

[error] MAPPING_ROOT_NOT_IN_CATALOG · ×9    （房地产 / 资产经营 / 交易与处置 / 财务报告 / 融资与债务 /
                                              投资与资本运作 / 税务与历史确认 / 司法清算与补偿 / 咨询复核与其他
                                              —— 全部 9 个一级根被判「已不存在」）
[error] KB_PATH_KEY_NOT_IN_CATALOG · ×96    （含 router 与各叶子的库内路径键）
[warning] REGISTRY_LABEL_NOT_IN_CATALOG · ×9（9 个 available 标签被判「最新目录中无一级目录」）
```

即：**9 个一级根本全部存在**（已用 `node-index.json` 的 `byPath` 键与 `目录树.md` 独立核对），
检查器却报「一级资产 0 / 一级业务 0」，并把解析出的 catalog 路径压缩到 188 条（实际 263 节点）。

**根因**：`_paths_from_flat_nodes` 用 `cursor.get("parentId")` 回溯父链，
真实快照字段为 **`parentFolderId`** → 所有节点塌成根路径。

**修复状态（评审期间已修，工作区未提交）**：`_parent_link()` 同时接受
`parentFolderId` 与遗留别名 `parentId`；新增 `_paths_from_snapshot_nodes()` 在
`children` 嵌套形态与扁平形态间自适应；`_snapshot_is_complete()` 增加 `stats.complete` 分支。
**复验（同一真实快照）**：

```
crwu-audit Skill 映射盘点
一级资产 1 / 一级业务 8 / 错误 0 / 警告 2 / 建议 0     ← catalog paths: 263 ✅
```

warning 2 = `股权比例变动`、`其他目的` 两个空目录的 `BUSINESS_SUBROUTE_REVIEW_MISSING`（真实缺口）。

### 6.2 残余缺陷：`--max-age-hours` 新鲜度门禁仍不可通过（**待修**）

`skills/AGENTS.md` 给出的门禁命令带 `--max-age-hours <H>`，实测**报 error**：

```
$ ... --catalog <真实快照> --max-age-hours 2
一级资产 1 / 一级业务 8 / 错误 1 / 警告 2 / 建议 0
[error] CATALOG_NOT_LIVE · catalog carries no readable capture time;
        refresh the directory through crwu-dws before drawing routing conclusions
```

**根因（同一类字段漂移，修复时漏掉）**：`load_catalog` 两处分支都读 `data.get("fetchedAt")`
（脚本 `:272`、`:280`），而真实落盘字段是 **`fetched_at`**：

| 文件 | schema | 时间字段 |
| --- | --- | --- |
| 真实 `目录快照.json` | `crwu.kb-dir-snapshot.v1` | **`fetched_at`** = `2026-09-10T14:18:56+08:00` |
| 真实 `node-index.json` | `crwu.kb-node-index.v1` | **`fetched_at`** = `2026-09-10T14:18:56+08:00` |
| 代理快照 `/tmp/audit-live/目录快照.json` | `crwu.kb-dir-snapshot.v1` | `fetchedAt` = `2026-09-10T14:06:27+08:00` |

→ 检查器只能读到代理快照的时间，**读不到真实快照的抓取时间**，新鲜度判定必然落空。
修法同 `_parent_link`：加一个 `_capture_time()` 兼容 `fetchedAt` / `fetched_at` / `generated_at` /
`built_from_snapshot_at`。**在修好之前，AGENTS.md 那条门禁命令仍不可通过。**

### 6.3 校准表仍是代理快照产物（需重跑刷新）

`skills/crwu-audit-skill-maintainer/references/07-kb-skill-map.md`（治理要求随门禁刷新的校准表）记录：

| 校准项 | 值 |
| --- | --- |
| 校准时间 | `2026-09-10T14:34:48+08:00` |
| **知识库目录抓取时间** | **`2026-09-10T14:06:27+08:00`** |
| 目录输入形态 | `crwu.kb-dir-snapshot.v1` |
| 目录节点数 / 完整性 | 263 / complete=true |
| 本次 error / warning / 建议 | **0 / 2 / 0** |
| 库内路径键健康 | 「检查 81 个寻址键…**全部命中本次目录**」 |

`14:06:27` 正是**代理快照**（手写探针 `fetch.py`/`traverse.py`/`gen.py` 生成）的 `fetchedAt`，
真实 `crwu-dws` 刷新是 **`14:18:56`**（晚 12 分钟，字段为 `parentFolderId`）。
即：**校准表是对代理快照生成的**，其 `error 0` 与「全部命中」两个结论在真实快照上当时都不成立。
主体缺陷修复后，真实快照已可产出同样结论（error 0 / warning 2），
但**校准表本身尚未按真实快照重跑刷新**，其「目录抓取时间」应更新为真实时间戳。

### 6.4 仍需保留的回归要求

- `tools/kb/test_audit_skill_maintainer.py` 的真实快照回归此前**硬编码 `/tmp/audit-live/目录快照.json`**
  （代理文件）——这正是主体缺陷长期未被发现的原因。修复后测试增至 39 项，
  但**建议改为可配置/可自动发现真实缓存路径**，避免再次只在代理 schema 上验证。
- `tools/kb/test_dws_source_contract.py` 的 `ACTIVE_CONTRACT_FILES` 共 23 项，
  其中叶子文件仅 **4 项**（asset-realestate 的 `SKILL.md` 与 `01-kb-assembly.md`、
  biz-asset-operation 的 `SKILL.md` 与 `02-review-focus.md`），而叶子文件总数为 **36**
  （9 个 `SKILL.md` + 27 个 reference）。一级根断言只是 `"directory" in text and "true" in text`
  的子串检查，asset 叶子多登记 4 个跨轴键照样通过。

---
即：**9 个一级根本全部存在**（已用 `node-index.json` 的 `byPath` 键与 `目录树.md` 独立核对），
检查器却报「一级资产 0 / 一级业务 0」，并把解析出的 catalog 路径压缩到 188 条（实际 263 节点）。
**后果：按新治理，任何新能力都过不了这道硬门禁**——要么门禁被绕过，要么继续用代理快照（见下）。

**根因**：`_paths_from_flat_nodes` 用 `cursor.get("parentId")` 回溯父链，
真实快照字段为 **`parentFolderId`** → 所有节点塌成根路径。

**验证**：复制快照并仅补 `n['parentId'] = n.get('parentFolderId')` 后重跑，
结果立即变为：

```
一级资产 1 / 一级业务 8 / 错误 0 / 警告 2 / 建议 0
```

warning 2 正是 `股权比例变动`、`其他目的` 两个空目录的 `BUSINESS_SUBROUTE_REVIEW_MISSING`
——与 `docs/CHANGELOG.md` 记录的「error 30 → 0、warning 2」形态吻合（该记录的数字对应加入业务轴
8 个叶子之前的状态），证明这是**字段漂移导致的假阳性**，而非技能真的漂移。

附带症状（修复后仅剩时间字段一项未处理）：`fetchedAt` 与实际的 `fetched_at` 不一致（见 §6.2）、
`evidence` 期望「回执数组」而实际是对象（`_snapshot_is_complete` 恒返回 `None`）、
`complete` 实际在顶层而不在 `stats.complete`（后两项已随修复处理）。

---

## 7. 端到端跑通判定

> 前提：技能与 `tools/` 均已按设计部署、知识库可经 crwu-dws 实时下载、材料包已确认隔离。

### 场景 A：商铺租金市场价值评估（市场法 / 国资 / 含测算表）

画像 → `asset=房地产`(available) + `business=资产经营`(available) + `methods=[市场法]`(pending)
+ `overlays=[国资]`(pending) + `public=datacheck`

| 层 | 产出 |
| --- | --- |
| 对象层 | ✅ 真实：权属 / 实物·权益·区位 / 用途管制 / 最优利用 / 房地设备界面 / 方法适用性接口 / 三区一致性（`RULE-01-02-543~578`） |
| 通用披露 | ✅ 真实（`RULE-01-02-251~279`，目前经 asset 叶子捎带） |
| 方法 | ⚠️ 仅准则层（`RULE-01-02-281~305`），**无市场法专项清单** |
| 业务 | ❌ §一 待补；可用的是 §二 30 条历史问题（需先改口径才用得上） |
| 监管 | ❌ pending，且库内该目录只有 README |
| 表格 | ✅ datacheck C1–C6 + H0 完整 |

→ **能跑通**，产出「对象层 + 通用披露 + 方法准则 + 表格勾稽」；
但专项深度低于旧系统（CHK-MKT-001~014 不再生效）。

### 场景 B：设备类报废物资残余价值评估（国资）

`asset=设备` pending（`02-资产类型/TODO/机器设备` 只有 README）+ `business=交易与处置` available
+ `overlay=国资` pending

→ **通用披露层无人装配**（只挂在 asset-realestate），实际只剩 `datacheck` + 画像 + gap 清单。
→ **出不了专业结论**，且这是**设计缺口，不是部署问题**。

### 场景 C：企业价值（股权转让，多资产）

`scope=企业价值` pending + `asset=房地产` available + 设备 / 无形资产 pending
+ `business=投资与资本运作` available（§一 待补）→ 仍主要靠 asset-realestate，其余各轴只出 gap。

### 判定汇总

| 维度 | 判定 |
| --- | --- |
| 技术链路（画像 → 并集 → 装配 → 执行 → 汇总 → 冻结 → 两阶段 → 交付） | ✅ 能跑通，规范齐全 |
| 房地产对象层 | ✅ 唯一有真实对象层内容的资产类型（`02-资产类型/` 下只有 `01-房地产`） |
| 业务轴 | ⚠️ 必检项层（§一）全为「待补」→ 无强制检查清单；可用的是 §二 的 560 条历史问题，但频次信号未进技能，只能等权对待 |
| 方法轴 / 监管轴 | ❌ 全 `pending`；且 registry 标签与库目录语义不对齐 |
| **非房地产对象** | ❌ **结构性不可用**（通用兜底层缺失 + 资产轴 7/8 `pending`） |

---

## 8. 问题索引与建议

### P0（源仓内必须解决）

| 编号 | 问题 | 落点 |
| --- | --- | --- |
| P0-1 | **硬门禁不可通过**：治理已要求「映射检查器对本次最新目录 error=0」，但该检查器对真实 `crwu-dws` 快照报 error 105；测试与校准表均系代理快照产物 | `skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py`（`_paths_from_flat_nodes` 等快照字段解析）、`tools/kb/test_audit_skill_maintainer.py:1211`、`references/07-kb-skill-map.md` |
| P0-2 | 通用披露层无归属 | `crwu-audit/references/07-skill-registry.md`（`public` 轴）、router 步骤 9、`crwu-audit-asset-realestate/references/01-kb-assembly.md:41-44` |
| P0-3 | CHK-MKT-001~014 / CHK-CST-001~012 清单孤儿 | `06-规则库/清单-M-市场法/`、`清单-M-成本法/` 重新认领 |

> P0-1 排在最前：门禁不可通过时，其余修复都无法按治理要求被验证与标 `available`。

### P1

| 编号 | 问题 | 落点 |
| --- | --- | --- |
| P1-4 | 业务轴真实信号的**频次/项目数未进技能**（560 条历史问题等权对待，无法排序分诊） | 8 个 `crwu-audit-biz-*/references/02-review-focus.md`（内容层改动，归口 `crwu-audit-optimize`） |
| P1-5 | 业务轴粒度：8 个技能彼此无不同清单，8× 维护成本换 0 增量能力（是否合并属治理决策） | `skills/AGENTS.md`、8 个 `crwu-audit-biz-*`、registry、映射检查器 |
| P1-6 | method / overlay 轴 registry 标签与库目录语义不对齐 | `07-skill-registry.md`、`04-business-classification.md`、`03-asset-classification.md` |
| P1-7 | 叶子契约缺口：`selected_relative_paths`、输出自检、三分区、asset 叶子共用层先行、悬空键 `REAL_ESTATE_OBJECT`、`expected_structure` 非字面节点名（违反治理明文「一级根/寻址键逐字」）、叶子复述共同规则 | 9 个叶子 `SKILL.md` + `references/` |
| P1-8 | 叶子 → AuditResult 字段映射缺失 | `11-html-delivery-spec.md` §13.1 |
| P1-9 | 契约字段无接口对端（`request_kind`/`recursive`/`required`） | 9 个叶子 `01-kb-assembly.md` 与 `crwu-dws` manifest 规范 |
| P1-10 | 契约测试覆盖不足（36 个叶子文件仅 4 个在禁词扫描内；一级根断言为子串检查） | `tools/kb/test_dws_source_contract.py` |

### P2（杂项）

| 编号 | 问题 | 落点 |
| --- | --- | --- |
| P2-11 | 已下架技能 `rent` 残留 3 处 | `crwu-audit-datacheck/SKILL.md:36`、`:83`、`references/00-KB装配表.md:20` |
| P2-12 | 历史项目名 `泰和里` 写入「检查维度」 | `crwu-audit-biz-financing-debt/references/02-review-focus.md:18` |
| P2-13 | 契约编号漂移（写「契约 04」，实际为 `03-审核统计与台账规范`） | `crwu-audit/SKILL.md:60` |
| P2-14 | `crwu-audit-optimize` 仍用旧画像词（`object_type` / `scenario` / `stage` / `report_type` / `dims` / `角度`），词表落点仍指向 `crwu-audit references/00、01`（`01-audit-angles-catalog.md` 已不存在） | `crwu-audit-optimize/SKILL.md:79`、`references/00`、`references/01` |
| P2-15 | 引用了不存在的 `docs/design-crwu-dws.md §10 决策点 D8–D12`（该文档 §10 为「验收用例」） | `crwu-dws/SKILL.md:29`、`references/00:5`、`references/02:5` |
| P2-16 | 业务叶子历史条数（30 / 26 / 15 / 3 / 2 / 14）声称「数据驱动」但无来源、不可复现 | 8 个 `crwu-audit-biz-*/references/02-review-focus.md` |
| P2-17 | `docs/CHANGELOG.md:111` 写 `02-资产类型/房地产/`，叶子与实库为 `02-资产类型/01-房地产/` | `docs/CHANGELOG.md` |
| P2-18 | `crwu-audit-datacheck` 的 references 文件名为 `00-KB装配表.md`，与治理推荐的 `01-kb-assembly.md` 命名不一致（其不属 asset/biz 叶子，可豁免，但 router 步骤 9 需同时收两种命名） | `crwu-audit-datacheck/references/` |
| P2-19 | 叶子标题层未把「§一 缺口」与「§二 可用」分开陈述 | 8 个 `crwu-audit-biz-*/references/02-review-focus.md` |

---

## 9. 证据与可复现命令

```bash
# 引用卫生 / 实时协议 lint（当前基线：warn=0 error=0）
python3 tools/kb/kb_tool.py validate --skill-root skills

# 路由契约与 DWS source 契约测试
python3 tools/kb/test_audit_multiaxis_router.py        # 9 tests OK
python3 tools/kb/test_dws_source_contract.py           # 6 tests OK
python3 tools/kb/test_audit_skill_maintainer.py        # 38 tests OK
python3 tools/audit/test_audit_delivery.py             # 24 tests OK

# 库内路径解析：56 条路径逐条对照 node-index 的 byPath 键
# 快照：~/.crwu/knowledge/dws-dir-cache/中瑞世联评估审核知识库/{目录快照.json,node-index.json}

# 映射检查器对真实快照（当前误报 error 105 / warning 9）
python3 skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py \
  --repo-root . --catalog "<快照目录>/目录快照.json" --format text

# 证明为字段漂移：复制快照并补 parentId 别名后重跑 → 错误 0 / 警告 2
```

**统计口径**：一级根 9 个；叶子文件 36 个（9 `SKILL.md` + 27 reference）；
库内路径键 56 条（100% 命中）；业务轴正文 24 个文件 / 258 KB / 560 条历史问题；
`待补` / `TODO` / `占位` 命中 43 行（全部集中在业务轴 8 个叶子，asset 叶子 0 行）。

**门禁/校准证据**：`07-kb-skill-map.md` 记录校准时间 `14:34:48`、目录抓取时间 `14:06:27`、
`error/warning = 0/2`、「检查 81 个寻址键…全部命中」；该抓取时间对应代理快照
（`/tmp/audit-live/目录快照.json`），真实 `crwu-dws` 刷新为 `14:18:56`。

---

## 10. 范围外事项

以下内容**不在本报告范围**，由部署方另行处理，本报告不作结论：

- 运行态已安装技能的版本与源仓的差异、已下架技能的残留；
- `tools/`（`tools/kb/`、`tools/audit/`）是否随技能分发到目标 agent 仓；
- 外部 `dws` CLI 与钉钉认证前提、以及 `crwu` CLI 附件下载能力（如按附件白名单下载）的可用性；
- 目标 agent 仓的 skills 安装 / 更新机制。

---

## 11. 附：本次评审的方法与限制

- **方法**：逐文件通读 router 的 14 份 references、9 个叶子的 36 个文件、2 个元技能及其 references、
  `tools/kb/` 与 `tools/audit/` 实现与测试；用真实知识库目录快照做路径存在性与认领关系比对；
  用本次下载物核对叶子的内容判断；对映射检查器做最小化复现以定位根因。
- **限制 1**：知识库**正文**未在本地全量留存，本报告只能核对**路径存在性**与已抽样下载的正文；
  未抽样文件的规则内容未逐条核验（业务轴已抽样 35 份；`02-资产类型/` 与 `03-评估方法/` 正文未抽样）。
- **限制 2**：RULE 编号（`RULE-01-02-543~578` / `-251~279` / `-281~305`）无仓内注册表可比对，
  其正确性未在本报告中验证。
- **限制 3**：业务叶子声称的「数据驱动」历史条数无法从仓内复现，本报告只作一致性标注。
- **限制 4**：治理文件 `skills/AGENTS.md` 在评审期间处于修订中（工作区有未提交改动），
  本报告中凡引用治理条款处，均以评审时工作区版本为准；若该文件后续再调整，
  §2.2、§4.1、§5.3、§6 的相关判定需重新对照。
