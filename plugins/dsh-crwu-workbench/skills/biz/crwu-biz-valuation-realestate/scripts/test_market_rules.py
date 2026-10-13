"""市场法规则模块的契约测试（`market_rules.py`）。

重点在**边界**与**口径**，不在"函数能跑"：

- 20% / 30% / 1.2 的**等于、略低、略高**三档；
- "不宜"是软约束 —— 超限返回 `over`（要说明处置），不是抛错、也不是静默通过；
- 综合修正是**连乘**而不是把百分比相加；
- 取整用 Excel 口径（ROUND_HALF_UP），不是 Python 的银行家舍入。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import market_rules as rules  # noqa: E402


class AdjustmentRatioTest(unittest.TestCase):
    def test_ratio_direction(self):
        # 案例比对象优（案例指数更大）→ 系数 < 1 → 把案例价格调低。方向搞反是这类计算最常见的错。
        self.assertAlmostEqual(rules.adjustment_ratio(100, 105), 100 / 105)
        self.assertGreater(rules.adjustment_ratio(105, 100), 1.0)

    def test_rejects_degenerate_indices(self):
        for subject, case in ((0, 100), (100, 0), (-1, 100)):
            with self.assertRaises(ValueError):
                rules.adjustment_ratio(subject, case)

    def test_combined_is_a_product_not_a_sum(self):
        # 两项各 +10%：连乘是 1.1×1.1−1 = 21%，相加是 20% —— 差一个百分点。
        # 案例一多这个差会放大到能改结论，所以"把百分比相加"是必须被钉住的一种错。
        ratio = rules.combined_ratio([110, 110], [100, 100])
        self.assertAlmostEqual(rules.adjustment_magnitude(ratio), 0.21, places=6)
        self.assertNotAlmostEqual(rules.adjustment_magnitude(ratio), 0.20, places=4)
        # 一升一降：系数是 1.05 与 100/103（**不是** 0.97）。
        # 这正是"指数口径"与"百分比口径"要分清的地方：想让某一项恰好 −3%，
        # 案例指数得是 100/0.97 ≈ 103.09，而不是 103。
        ratio = rules.combined_ratio([105, 100], [100, 103])
        self.assertAlmostEqual(ratio, 1.05 * (100 / 103), places=9)
        self.assertAlmostEqual(rules.adjustment_magnitude(ratio), 0.0194174757, places=9)

    def test_combined_needs_matching_factor_counts(self):
        with self.assertRaises(ValueError):
            rules.combined_ratio([100, 100], [100])


class LimitBoundaryTest(unittest.TestCase):
    """三条阈值的等于 / 略低 / 略高。"""

    def test_single_factor_20_percent(self):
        self.assertEqual(rules.check_single(1.199), "within")
        self.assertEqual(rules.check_single(1.20), "at-limit", "等于 20% 算到限，不算超")
        self.assertEqual(rules.check_single(0.80), "at-limit", "负方向同样按幅度算")
        self.assertEqual(rules.check_single(1.201), "over")

    def test_single_factor_negative_direction(self):
        self.assertEqual(rules.check_single(0.799), "over", "下调 20.1% 也超限")

    def test_combined_30_percent(self):
        self.assertEqual(rules.check_combined(1.299), "within")
        self.assertEqual(rules.check_combined(1.30), "at-limit")
        self.assertEqual(rules.check_combined(1.301), "over")

    def test_price_ratio_12(self):
        self.assertEqual(rules.check_price_ratio([100.0, 119.9])[3], "within")
        self.assertEqual(rules.check_price_ratio([100.0, 120.0])[3], "at-limit", "等于 1.2 不算大于")
        self.assertEqual(rules.check_price_ratio([100.0, 120.1])[3], "over")

    def test_floating_point_at_the_boundary_is_not_misjudged(self):
        # 1.05 × 1.05 = 1.1025；用整数指数的写法让浮点偏差出现在比较点上。
        self.assertEqual(rules.check_single(1 / 1.2 * 1.2), "within")
        # 1.2 在二进制里是 1.1999999999999999556…：不能因为表示误差判成 within。
        self.assertEqual(rules.check_price_ratio([1000.0, 1200.0])[3], "at-limit")

    def test_price_ratio_returns_the_extremes(self):
        highest, lowest, ratio, verdict = rules.check_price_ratio([102.0, 98.0, 100.0])
        self.assertEqual((highest, lowest), (102.0, 98.0))
        self.assertAlmostEqual(ratio, 102 / 98)
        self.assertEqual(verdict, "within")

    def test_single_price_has_no_group_inconsistency(self):
        # 单案例谈不上"组内不一致"；案例数量不足是另一条规则的事。
        self.assertEqual(rules.check_price_ratio([100.0])[3], "within")

    def test_prices_must_be_positive(self):
        for prices in ([], [0.0], [-1.0]):
            with self.assertRaises(ValueError):
                rules.check_price_ratio(prices)


class RoundingTest(unittest.TestCase):
    def test_uses_excel_half_up_not_bankers_rounding(self):
        # Python 的 round(2.5) == 2（银行家舍入），Excel 的 ROUND(2.5,0) == 3。
        self.assertEqual(rules.round_half_up(2.5, 0), 3.0)
        self.assertEqual(rules.round_half_up(0.5, 0), 1.0)
        self.assertEqual(rules.round_half_up(1.005, 2), 1.01)

    def test_reference_rounding_positions(self):
        # references/02 §9：比准价格与评估单价保留到十位、评估值保留到百位。
        self.assertEqual(rules.comparable_unit_price(38200.0, 1.0), 38200.0)
        self.assertEqual(rules.comparable_unit_price(38165.0, 1.0), 38170.0)
        self.assertEqual(rules.appraised_unit_price([38170.0, 38200.0, 38300.0]), 38220.0)
        # 38220 × 120.5 = 4,605,510 → 保留到百位 = 4,605,500（不是 4,605,510）。
        self.assertEqual(rules.appraised_total(38220.0, 120.5), 4605500.0)

    def test_total_needs_a_positive_area(self):
        with self.assertRaises(ValueError):
            rules.appraised_total(38000.0, 0.0)


class ThresholdSourceTest(unittest.TestCase):
    """阈值必须和知识库参考资料逐字一致（不能悄悄改数字）。"""

    def test_thresholds_match_the_reference_document(self):
        reference = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "references", "02-market-method.md",
        )
        with open(reference, "r", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("不宜超过 20%", text)
        self.assertIn("不宜超过 30%", text)
        self.assertIn("不宜大于 1.2", text)
        self.assertEqual(rules.SINGLE_FACTOR_LIMIT, 0.20)
        self.assertEqual(rules.COMBINED_FACTOR_LIMIT, 0.30)
        self.assertEqual(rules.PRICE_RATIO_LIMIT, 1.2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
