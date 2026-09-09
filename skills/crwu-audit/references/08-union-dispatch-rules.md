# 多轴并集分发规则

| 版本 | v1.0 | 状态 | 2026-09-09 定稿 | 维护 | 多轴候选合并、去重和执行边界唯一事实源 |
| --- | --- | --- | --- | --- |

## 分发算法

先按 02–06 得到各轴全部标签，再逐项查询 07。`available` 技能加入该轴候选列表；`pending` 或未注册标签按 10 逐标签写 gap；`profile-only` 只保留画像。公共能力由材料条件独立判定。

```text
scope_skills   = available_skills(scope_types[])
asset_skills   = available_skills(asset_types[])
business_skills = available_skills(business_types[])
method_skills  = available_skills(methods[])
overlay_skills = available_skills(overlays[])
public_skills  = [crwu-audit-datacheck] when tabular materials exist, else []

skills_to_load = stable_unique(
  scope_skills +
  asset_skills +
  business_skills +
  method_skills +
  overlay_skills +
  public_skills
)
```

`stable_unique` 按上述轴顺序和每个分类表中的标签顺序保留第一次出现，后续同名技能只去重，不改变先后。所有轴都必须求值后才能形成 `skills_to_load`：禁止“首个命中即停止”、排他 `else-if`、用一个轴覆盖另一个轴，或因某个 pending/失败技能短路其他 available 技能。

## pending、冲突与结果归并

- 每个 pending 或未注册的 `axis+label` 单独产生一个 `material_gaps[]` 项；不得把多个缺失标签压成组合 gap。
- pending 不进入实际执行列表，但不得删除对应 route profile 标签；其他 available 技能照常加载并产出结果。
- ROUTE001–004 只挂起受影响标签，保留不受影响的候选；人工确认后重新计算完整稳定并集。
- 每条 finding 必须带 `source_skills[]`，列出实际产生或共同支持该 finding 的技能。跨技能同一事实可以合并，但合并后保留所有来源技能；不能只留最后写入者。
- 意见按报告、评估说明、测算明细表分区归并。证据相同且结论相同的 finding 去重；结论冲突时不覆盖，保留双方 `source_skills[]`、证据和冲突说明，交人工复核。

```jsonc
{
  "finding_id": "F-001",
  "section": "测算明细表",
  "finding": "租金案例调整依据不足",
  "source_skills": [
    "crwu-audit-asset-realestate",
    "crwu-audit-business-rent"
  ]
}
```

## 示例

### 房地产租赁

画像命中 `asset=房地产`、`business=租赁`。注册表解析为 `crwu-audit-asset-realestate (available)` 与 `crwu-audit-business-rent (available)`，两者均进入 `skills_to_load`；若材料含明细表，再追加 `crwu-audit-datacheck`。不得用租赁技能替代房地产对象技能。

### 房地产清算后拍卖处置

画像命中 `asset=房地产` 以及 `business=清算 + 资产处置 + 拍卖`。逐标签解析得到：

- `crwu-audit-asset-realestate`：available，继续加载；
- `crwu-audit-business-liquidation`：pending，为 `business+清算` 记录独立 gap；
- `crwu-audit-business-disposal`：pending，为 `business+资产处置` 记录独立 gap；
- `crwu-audit-business-auction`：pending，为 `business+拍卖` 记录独立 gap。

最终执行当前 available 并集，三个 pending 候选不得假装已执行，也不得让它们阻断房地产技能。

### 设备抵押

画像命中 `asset=设备`、`business=抵押质押`。分别解析为 `crwu-audit-asset-equipment (pending)` 与 `crwu-audit-business-mortgage (pending)`，因此产生两个独立 gap。如果材料含表格，available 的 `crwu-audit-datacheck` 仍必须加载；不得因为对象和业务技能均 pending 而空返。

### 企业价值多资产清算

画像命中 `scope=企业价值`、`asset=房地产 + 设备 + 无形资产`、`business=清算`。`crwu-audit-scope-enterprise-value`、设备、无形资产和清算候选分别记录 gap；`crwu-audit-asset-realestate` 仍加载。资产标签各自保留 `materiality=key|non-key|unknown`：available 且 `key` 的技能必须加载，`unknown` 保留并人工复核，`non-key` 不得删除标签但不让其主导输出。材料含表格时再并入 `crwu-audit-datacheck`。
