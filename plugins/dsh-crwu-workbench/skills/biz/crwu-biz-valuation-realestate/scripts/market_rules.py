"""市场法比较案例的**修正与筛选规则**（确定性、可测试、无第三方依赖）。

这些阈值来自业务知识库的房地产估值规范（本 Skill 的
`references/02-market-method.md` 第 9 节「计算与约束」），**不是**本文件的作者拍的：

1. 单项因素对可比实例成交价格的修正或调整幅度**不宜超过 20%**；
2. 全部因素共同对可比实例成交价格的修正和调整幅度**不宜超过 30%**；
3. 经修正调整后各可比实例价格中，**最高价与最低价的比值不宜大于 1.2**。

## 三条口径（都是"会做错"的地方）

- **"不宜"是软约束，不是硬拒绝**：超限必须在底稿里说明理由或重选案例（`references/02` §9）。
  所以本模块的判定结果是 `within` / `at-limit` / `over`，**不是**布尔量的"合格 / 不合格" ——
  调用方据此要求"说明处置方式"，而不是把案例直接删掉。
- **边界是"不超过"，即等于阈值算 `at-limit`**（通过但要标注）。浮点比较带一个很小的相对
  容差，否则 `1.2` 会因为二进制表示变成 `1.2000000000000002` 而被误判成超限。
- **综合修正不是"把各项百分比相加"**：它是各因素修正系数的**连乘**。把 +5% 与 +3% 加成 +8%
  在数学上就是错的（正确的和是 1.05 × 1.03 − 1 ≈ 8.15%），案例一多误差会放大到能改结论。
"""

from __future__ import annotations

# 阈值的**唯一**出处：`references/02-market-method.md` 第 9 节。
SINGLE_FACTOR_LIMIT = 0.20
COMBINED_FACTOR_LIMIT = 0.30
PRICE_RATIO_LIMIT = 1.2

# 规则 ID：`估值结果.json` 的 `cases[].rule_checks[].rule_id` 只能取这几个值。
# 每条剔除的案例都要写清"依据哪条规则、实际值多少、阈值多少、为什么" ——
# 只写一句"符合要求"或"不符合要求"是不可复核的（§8）。
RULE_COMPARABILITY = "R-COMPARABILITY"        # 条件不匹配（用途/结构/供需圈/成交日期不满足）
RULE_EVIDENCE = "R-EVIDENCE"                  # 资料或证据不足
RULE_SINGLE_20 = "R-SINGLE-20"                # 单项修正幅度 > 20%
RULE_COMBINED_30 = "R-COMBINED-30"            # 共同修正幅度 > 30%
RULE_GROUP_RATIO_12 = "R-GROUP-1.2"           # 修正后最高价/最低价 > 1.2

RULE_IDS = (
    RULE_COMPARABILITY,
    RULE_EVIDENCE,
    RULE_SINGLE_20,
    RULE_COMBINED_30,
    RULE_GROUP_RATIO_12,
)

# 规则 ID → 阈值（数值型规则才有；条件/证据类没有数值阈值）。
RULE_LIMITS = {
    RULE_SINGLE_20: SINGLE_FACTOR_LIMIT,
    RULE_COMBINED_30: COMBINED_FACTOR_LIMIT,
    RULE_GROUP_RATIO_12: PRICE_RATIO_LIMIT,
}

# 案例状态（§8）：六个状态各自对应"为什么没被采用"。
CASE_STATUS = (
    "adopted",                    # 最终采用
    "not-comparable",             # 条件不匹配
    "insufficient-evidence",      # 资料或证据不足
    "single-rule-failed",         # 单项规则未通过
    "combined-rule-failed",       # 综合规则未通过
    "group-consistency-failed",   # 组内一致性未通过
)

# 状态 → 触发它的规则 ID（界面与校验据此判断"这个状态有没有对应的规则记录"）。
STATUS_RULE = {
    "not-comparable": RULE_COMPARABILITY,
    "insufficient-evidence": RULE_EVIDENCE,
    "single-rule-failed": RULE_SINGLE_20,
    "combined-rule-failed": RULE_COMBINED_30,
    "group-consistency-failed": RULE_GROUP_RATIO_12,
}

# 浮点容差：相对值，只用来吸收二进制表示误差（不是"放宽阈值"）。
_EPS = 1e-9


def _over(value: float, limit: float) -> bool:
    """`value` 是否**真的**超过 `limit`（等于不算超，见模块说明）。"""
    return value - limit > _EPS * max(1.0, abs(limit))


def adjustment_ratio(subject_index: float, case_index: float) -> float:
    """单项因素的修正系数 = 评估对象指数 / 案例指数。

    方向：指数越大表示越优。案例比对象优时系数小于 1（把案例价格**调低**），反之调高 ——
    方向搞反是这类计算最常见的错误，所以这里把它固定成一条公式。
    """
    if case_index == 0:
        raise ValueError("案例因素指数不能为 0（除零会让整条链变成 inf/nan）")
    if subject_index <= 0 or case_index <= 0:
        raise ValueError("因素指数必须为正数")
    return subject_index / case_index


def combined_ratio(subject_indices, case_indices) -> float:
    """全部因素的**综合修正系数** = Π(对象指数) / Π(案例指数)。

    逐项相乘再相除，等价于把各单项系数连乘 —— 这就是"综合修正不能把百分比相加"的实现。
    """
    subjects = list(subject_indices)
    cases = list(case_indices)
    if len(subjects) != len(cases):
        raise ValueError("评估对象与案例的因素个数必须一致（否则比较的不是同一组因素）")
    if not subjects:
        raise ValueError("至少要有一个因素")
    ratio = 1.0
    for subject, case in zip(subjects, cases):
        ratio *= adjustment_ratio(subject, case)
    return ratio


def adjustment_magnitude(ratio: float) -> float:
    """修正幅度（正数，百分比口径）：`|系数 − 1|`。

    `ratio = 1.05` → `0.05`（+5%）；`ratio = 0.97` → `0.03`（−3%）。
    取绝对值是有意的：调整方向对幅度没有影响，20% / 30% 约束管的是幅度大小。
    """
    return abs(ratio - 1.0)


def check_single(ratio: float, limit: float = SINGLE_FACTOR_LIMIT) -> str:
    """单项修正幅度判定：`within` / `at-limit` / `over`。"""
    magnitude = adjustment_magnitude(ratio)
    if _over(magnitude, limit):
        return "over"
    return "at-limit" if abs(magnitude - limit) <= _EPS * max(1.0, limit) else "within"


def check_combined(ratio: float, limit: float = COMBINED_FACTOR_LIMIT) -> str:
    """综合修正幅度判定：`within` / `at-limit` / `over`。"""
    return check_single(ratio, limit)


def check_price_ratio(prices, limit: float = PRICE_RATIO_LIMIT):
    """修正后价格的组内一致性：返回 `(最高, 最低, 比值, 判定)`。

    只有一个价格时比值是 1.0（`within`）：单案例谈不上"组内不一致"，
    但案例数量不足是另一条规则的事（`references/02` 要求至少三个可比实例）。
    """
    values = [float(price) for price in prices]
    if not values:
        raise ValueError("没有价格可比：至少要有一个比准价格")
    if any(price <= 0 for price in values):
        raise ValueError("比准价格必须为正数；拿不到就说明拿不到，不能填 0")
    highest, lowest = max(values), min(values)
    ratio = highest / lowest
    verdict = "over" if _over(ratio, limit) else (
        "at-limit" if abs(ratio - limit) <= _EPS * max(1.0, limit) else "within"
    )
    return highest, lowest, ratio, verdict


def round_half_up(value: float, digits: int) -> float:
    """按规范的口径取整（Excel 的 ROUND 是"四舍五入、远离零"，不是 Python 的银行家舍入）。

    `references/02` §9 的取整口径：比准价格与评估单价保留到十位（`digits=-1`），
    评估值保留到百位（`digits=-2`）。Python 内置 `round(0.5)` 会得到 0（银行家舍入），
    与底稿里的 Excel 公式对不上 —— 那正是"底稿与 JSON 数字不一致"的一个隐蔽来源。
    """
    from decimal import Decimal, ROUND_HALF_UP

    quantum = Decimal(1).scaleb(-digits)
    return float(Decimal(repr(float(value))).quantize(quantum, rounding=ROUND_HALF_UP))


def comparable_unit_price(case_unit_price: float, ratio: float) -> float:
    """比准价格 = 案例交易单价 × 修正系数积，保留到十位。"""
    if case_unit_price <= 0:
        raise ValueError("案例交易单价必须为正数")
    return round_half_up(case_unit_price * ratio, -1)


def appraised_unit_price(unit_prices) -> float:
    """评估单价 = 各比准价格的算术平均，保留到十位。"""
    values = [float(price) for price in unit_prices]
    if not values:
        raise ValueError("没有比准价格平均不了")
    return round_half_up(sum(values) / len(values), -1)


def appraised_total(unit_price: float, building_area: float) -> float:
    """评估值 = 评估单价 × 建筑面积，保留到百位。"""
    if building_area <= 0:
        raise ValueError("计价面积必须为正数")
    return round_half_up(unit_price * building_area, -2)
