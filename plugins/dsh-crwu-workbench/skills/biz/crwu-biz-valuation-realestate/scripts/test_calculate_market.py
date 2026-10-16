#!/usr/bin/env python3
"""`calculate_market.py` 的契约测试（计划 Task 9）。

这一层的判据是"错了会静默算出错数"：

1. **没有知识阈值就不许运行** —— 按记忆里的 20%/30%/1.2 算出来的数看起来完全正常；
2. **综合修正是连乘不是相加** —— 相加的误差会随案例数放大到能改结论；
3. **挂牌价不能直接当可比实例** —— 它是卖方要价；
4. **缺失不许当 0** —— `0` 与"不知道"混同是估值里最贵的一类错；
5. **重复计价必须被拒绝** —— `land-and-building` 再加 `land-only` 就是把同一块地算两次。
"""

from __future__ import annotations

import os
import sys
import unittest
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from calculate_market import calculate_market, summarize_objects  # noqa: E402


def rule_parameters(**overrides):
    """一份完整的结构化规则段（值都是**测试样本**，不是业务发布值）。"""
    parameters = {
        "market.adjustment.single-limit": {"ruleId": "market.adjustment.single-limit", "value": "0.20", "unit": "ratio"},
        "market.adjustment.combined-limit": {"ruleId": "market.adjustment.combined-limit", "value": "0.30", "unit": "ratio"},
        "market.price-ratio.limit": {"ruleId": "market.price-ratio.limit", "value": "1.2", "unit": "ratio"},
        "market.comparables.min-adopted": {"ruleId": "market.comparables.min-adopted", "value": 3, "unit": "count"},
        "market.rounding.result": {
            "ruleId": "market.rounding.result",
            "value": "half-up", "unit": "",
            "rounding": {"mode": "half-up", "digits": 0},
        },
    }
    for rule_id, patch in overrides.items():
        parameters[rule_id] = {**parameters[rule_id], **patch}
    return {
        "ruleSetVersion": "crwu.valuation.rule-parameters.v1",
        "routeId": "realestate.parameters",
        "snapshotDigest": "sha256:snap",
        "parameters": list(parameters.values()),
    }


def case(case_id, unit_price, transaction="成交", factors=None):
    return {
        "caseId": case_id,
        "transactionType": transaction,
        "unitPrice": unit_price,
        "evidence": f"来源证据/页面/{case_id}.html",
        "factors": factors if factors is not None else [
            {"factorId": "F-TRADE", "subjectIndex": 100, "caseIndex": 100},
        ],
    }


def payload(**overrides):
    base = {
        "planId": "plan-001",
        "snapshotDigest": "sha256:snap",
        "ruleParameters": rule_parameters(),
        "objects": [{
            "objectId": "object-001", "buildingArea": "89.28", "currency": "CNY",
            "adoptedCaseIds": ["C1", "C2", "C3"],
        }],
        "cases": [
            case("C1", "40000"),
            case("C2", "41000"),
            case("C3", "42000"),
        ],
    }
    base.update(overrides)
    return base


class RuleParametersTest(unittest.TestCase):
    def test_missing_rule_parameters_is_rejected(self):
        without = payload()
        without.pop("ruleParameters")
        self.assertRaises(ValueError, calculate_market, without)

    def test_missing_one_required_parameter_is_rejected_and_named(self):
        section = rule_parameters()
        section["parameters"] = [
            item for item in section["parameters"] if item["ruleId"] != "market.price-ratio.limit"
        ]
        with self.assertRaises(ValueError) as caught:
            calculate_market(payload(ruleParameters=section))
        self.assertIn("market.price-ratio.limit", str(caught.exception))

    def test_executable_fields_are_rejected(self):
        section = rule_parameters()
        section["script"] = "print(1)"
        self.assertRaises(ValueError, calculate_market, payload(ruleParameters=section))

    def test_parameter_without_value_is_not_zero(self):
        section = rule_parameters(**{"market.adjustment.single-limit": {"value": None}})
        # 该条被整体覆盖成 value=None（见 helper：patch 覆盖同键）。
        section["parameters"] = [
            {**item, "value": None} if item["ruleId"] == "market.adjustment.single-limit" else item
            for item in section["parameters"]
        ]
        self.assertRaises(ValueError, calculate_market, payload(ruleParameters=section))


class MultiplicativeTest(unittest.TestCase):
    def test_combined_is_a_product_not_a_sum(self):
        # 两个 1.1 的因素：连乘 = 1.21；相加会得到 1.20（差 1 个百分点，案例一多会放大）。
        fixture = payload(cases=[
            case("C1", "40000", factors=[
                {"factorId": "F-A", "subjectIndex": 110, "caseIndex": 100},
                {"factorId": "F-B", "subjectIndex": 110, "caseIndex": 100},
            ]),
            case("C2", "40000", factors=[
                {"factorId": "F-A", "subjectIndex": 110, "caseIndex": 100},
                {"factorId": "F-B", "subjectIndex": 110, "caseIndex": 100},
            ]),
            case("C3", "40000", factors=[
                {"factorId": "F-A", "subjectIndex": 110, "caseIndex": 100},
                {"factorId": "F-B", "subjectIndex": 110, "caseIndex": 100},
            ]),
        ])
        result = calculate_market(fixture)
        # 计划指定的口径：连乘的结果是 `"1.21"`（相加会得到 1.20，差 1 个百分点）。
        self.assertEqual(result["objects"][0]["combinedRatio"], "1.21")
        # 每条案例的比准价格 = 40000 × 1.21 = 48400。
        for item in result["objects"][0]["calculationSteps"]:
            self.assertEqual(item["ratio"], "1.21")
            self.assertEqual(item["comparableUnitPrice"], "48400")

    def test_decimal_output_is_string_and_not_rounded_twice(self):
        result = calculate_market(payload())
        obj = result["objects"][0]
        self.assertIsInstance(obj["unitPrice"], str)
        self.assertIsInstance(obj["totalValue"], str)
        # 41000 × 89.28 = 3660480
        self.assertEqual(obj["unitPrice"], "41000")
        self.assertEqual(obj["totalValue"], "3660480")


class ComparableRulesTest(unittest.TestCase):
    def test_listing_price_cannot_be_a_comparable_case(self):
        """挂牌价不能直接作可比实例：它被排除出计算，但**不因此清空金额**（§6.1）。"""
        fixture = payload(cases=[
            case("C1", "40000"),
            case("C2", "41000"),
            case("C3", "50000", transaction="挂牌"),
        ])
        result = calculate_market(fixture)
        obj = result["objects"][0]
        # 挂牌那条进了 ruleChecks 的失败项，但没有进 calculationSteps。
        self.assertEqual([step["caseId"] for step in obj["calculationSteps"]], ["C1", "C2"])
        rejected = [item for item in obj["ruleChecks"] if item["ruleId"] == "market.comparable.transaction-type"]
        self.assertEqual(len(rejected), 1)
        self.assertFalse(rejected[0]["passed"])
        # 两条成交案例仍然算得出数（40500），并标成参考结论。
        self.assertEqual(obj["unitPrice"], "40500")
        self.assertEqual(obj["provisional"], True)
        self.assertIn("参考结论", obj["provisionalReason"])

    def test_too_few_adopted_cases_still_gives_a_reference_number(self):
        """1~2 条可核案例 + 有计算依据 → 照常给**参考结论**，不因数量少把金额清空。

        口径（设计稿 §6.1）：数量不足要写成**具体限制**并标明它是参考结论；
        只有**一条可用依据都没有**时才不给金额。
        """
        fixture = payload(objects=[{
            "objectId": "object-001", "buildingArea": "89.28", "currency": "CNY",
            "adoptedCaseIds": ["C1", "C2"],
        }])
        result = calculate_market(fixture)
        row = result["objects"][0]
        # 两条案例的比准价格平均 → 有数字（而不是 None）。
        self.assertIsNotNone(row["unitPrice"], result["limitations"])
        self.assertIsNotNone(row["totalValue"])
        self.assertEqual(row["provisional"], True, "少于知识要求时必须显式标成参考结论")
        self.assertIn("参考", row["provisionalReason"])
        self.assertIn("2", row["provisionalReason"])
        self.assertIn("3", row["provisionalReason"])
        # 具体限制：说清差几条、以及"不得作为正式结论交付"。
        limits = "；".join(result["limitations"])
        self.assertIn("少于知识要求的 3 条", limits)
        self.assertIn("参考结论", limits)
        self.assertIn("不得作为正式结论交付", limits)
        # 缺额也要进 ruleChecks（复核的人要能在规则层看到它没过）。
        shortfall = [item for item in row["ruleChecks"] if item["ruleId"] == "market.comparables.min-adopted"]
        self.assertEqual(len(shortfall), 1)
        self.assertFalse(shortfall[0]["passed"])

    def test_no_usable_case_at_all_gives_no_number(self):
        """一条可用依据都没有（挂牌 / 询价）→ 不给金额，并写清为什么。"""
        fixture = payload(
            objects=[{
                "objectId": "object-001", "buildingArea": "89.28", "currency": "CNY",
                "adoptedCaseIds": ["C1", "C2"],
            }],
            cases=[case("C1", "40000", transaction="挂牌"), case("C2", "41000", transaction="询价"), case("C3", "42000")],
        )
        result = calculate_market(fixture)
        row = result["objects"][0]
        self.assertIsNone(row["unitPrice"], "一条可用依据都没有时不许给数字")
        self.assertIsNone(row["totalValue"])
        self.assertEqual(row["provisional"], False)
        self.assertIn("没有任何可采用案例", "；".join(result["limitations"]))

    def test_enough_cases_is_not_provisional(self):
        result = calculate_market(payload())
        row = result["objects"][0]
        self.assertEqual(row["provisional"], False)
        self.assertEqual(row["provisionalReason"], "")


class SummarizeTest(unittest.TestCase):
    def test_missing_or_non_positive_case_price_is_rejected(self):
        """案例缺单价 / 单价为 0 → 拒绝（**缺失不许当 0**，0 也不是"缺失"）。"""
        for price in (None, "", 0, "0"):
            fixture = payload(objects=[{
                "objectId": "object-001", "buildingArea": "89.28", "currency": "CNY",
                "adoptedCaseIds": ["C1", "C2", "C3"],
            }], cases=[case("C1", price), case("C2", "41000"), case("C3", "42000")])
            self.assertRaises(ValueError, calculate_market, fixture)

    def test_adopted_case_that_does_not_exist_is_rejected(self):
        """采用了不存在的案例 → 拒绝（不能静默少算一条就出结论）。"""
        fixture = payload(objects=[{
            "objectId": "object-001", "buildingArea": "89.28", "currency": "CNY",
            "adoptedCaseIds": ["C1", "C2", "不存在的案例"],
        }])
        self.assertRaises(ValueError, calculate_market, fixture)

    def test_missing_building_area_is_rejected(self):
        """对象缺建筑面积 → 拒绝：总价算不出来，而"算不出来"与"面积为 0"是两件事。"""
        fixture = payload(objects=[{
            "objectId": "object-001", "currency": "CNY", "adoptedCaseIds": ["C1", "C2", "C3"],
        }])
        self.assertRaises(ValueError, calculate_market, fixture)

    def test_overlapping_value_scopes_are_rejected(self):
        overlapping = {
            "objects": [
                {"objectId": "object-001", "valueScope": "land-and-building", "totalValue": "100", "currency": "CNY", "baseDate": "2026-09-30"},
                {"objectId": "object-001-land", "valueScope": "land-only", "totalValue": "30", "currency": "CNY", "baseDate": "2026-09-30"},
            ],
        }
        self.assertRaises(ValueError, summarize_objects, overlapping)

    def test_land_only_plus_building_only_is_allowed(self):
        payload_ = {
            "objects": [
                {"objectId": "land", "valueScope": "land-only", "totalValue": "30", "currency": "CNY", "baseDate": "2026-09-30"},
                {"objectId": "building", "valueScope": "building-only", "totalValue": "70", "currency": "CNY", "baseDate": "2026-09-30"},
            ],
        }
        result = summarize_objects(payload_)
        self.assertEqual(result["totalValue"], "100")

    def test_inconsistent_currency_or_base_date_gives_no_total(self):
        payload_ = {
            "objects": [
                {"objectId": "a", "valueScope": "land-and-building", "totalValue": "100", "currency": "CNY", "baseDate": "2026-09-30"},
            ],
        }
        # 单个对象可以合计；两个不同基准日就不行。
        self.assertEqual(summarize_objects(payload_)["totalValue"], "100")
        payload_["objects"].append(
            {"objectId": "b", "valueScope": "land-and-building", "totalValue": "200", "currency": "CNY", "baseDate": "2026-06-30"})
        # 注意：两条 land-and-building 会先被"重复范围"拦下 —— 这本身就是正确的保守行为。
        self.assertRaises(ValueError, summarize_objects, payload_)

    def test_zero_total_is_rejected(self):
        payload_ = {
            "objects": [
                {"objectId": "a", "valueScope": "land-and-building", "totalValue": "0", "currency": "CNY", "baseDate": "2026-09-30"},
            ],
        }
        self.assertRaises(ValueError, summarize_objects, payload_)


def listing_case(case_id, unit_price, source_url, **overrides):
    """A qualified listing offer: authorization is the explicit 挂牌 reference channel, not a sale."""
    payload = {
        "caseId": case_id,
        "transactionType": "挂牌",
        "unitPrice": unit_price,
        "currency": "CNY",
        "unitPriceUnit": "CNY/m2",
        "sourceUrl": source_url,
        "capturedAt": "2026-10-14T00:00:00+00:00",
        "referenceAssessment": {
            "status": "qualified",
            "reason": "同一规划用途（公寓）的在售挂牌报价，用途与对象一致",
            "knowledgeRef": "wiki:01 估值与测算/01 房地产/wiki.md#listing",
        },
    }
    payload.update(overrides)
    return payload


def listing_payload(**overrides):
    base = {
        "valuationMode": "listing-reference",
        "planId": "plan-001",
        "referencePolicy": {
            "aggregation": "arithmetic-mean",
            "rounding": {"mode": "half-up", "digits": 2},
            "basis": "规划用途公寓的挂牌报价参考（不改变挂牌性质）",
        },
        "objects": [{
            "objectId": "object-001",
            "buildingArea": "100",
            "currency": "CNY",
            "referenceCaseIds": ["L1", "L2"],
        }],
        "cases": [
            listing_case("L1", "40000", "https://example.invalid/listing/l1"),
            listing_case("L2", "42000", "https://example.invalid/listing/l2"),
        ],
    }
    base.update(overrides)
    return base


class ListingReferenceTest(unittest.TestCase):
    """Explicit 挂牌参考 mode: no formal rules required, listing nature retained, no discounts."""

    def test_default_listing_reference_works_without_formal_rule_parameters(self):
        # No ruleParameters on purpose: the authorized default is the listing reference itself.
        result = calculate_market(listing_payload())
        self.assertEqual(result["valuationMode"], "listing-reference")
        row = result["objects"][0]
        self.assertEqual(row["unitPrice"], "41000.00")
        self.assertEqual(row["totalValue"], "4100000.00")
        self.assertEqual(row["provisional"], True)
        self.assertEqual(row["currency"], "CNY")
        # The raw listing facts survive alongside the amount, with the exact selected ids.
        self.assertEqual(row["referenceCaseIds"], ["L1", "L2"])
        self.assertEqual(row["unitPriceRange"], {"min": "40000", "max": "42000"})
        self.assertEqual([item["caseId"] for item in row["sources"]], ["L1", "L2"])
        self.assertEqual(row["sources"][0]["sourceUrl"], "https://example.invalid/listing/l1")
        self.assertEqual(row["sources"][0]["transactionType"], "挂牌")
        self.assertEqual(row["sources"][0]["unitPrice"], "40000")
        self.assertTrue(row["sources"][0]["reason"])
        self.assertTrue(row["sources"][0]["knowledgeRef"])
        self.assertEqual([item["rawUnitPrice"] for item in row["calculationSteps"]], ["40000", "42000"])
        limits = "；".join(result["limitations"])
        for keyword in ("原始", "未作任何修正", "2 条", "不得作为正式结论"):
            self.assertIn(keyword, limits)
        # No inferred discount / 1/100 factor was applied: the mean is exactly the raw mean.
        self.assertEqual(row["unitPrice"], "41000.00")

    def test_single_listing_case_still_gives_an_amount(self):
        result = calculate_market(listing_payload(
            objects=[{
                "objectId": "object-001", "buildingArea": "80", "currency": "CNY",
                "referenceCaseIds": ["L1"],
            }],
            cases=[listing_case("L1", "42000", "https://example.invalid/listing/l1")],
        ))
        self.assertEqual(result["objects"][0]["totalValue"], "3360000.00")
        self.assertEqual(result["objects"][0]["provisional"], True)

    def test_listing_rejects_unknown_mode(self):
        self.assertRaises(ValueError, calculate_market, listing_payload(valuationMode="automatic"))

    def test_listing_rejects_non_positive_or_non_finite_price_and_area(self):
        for bad in ("0", "-1", "NaN", "Infinity", "-Infinity", "not-a-number", True, None):
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(cases=[
                    listing_case("L1", bad, "https://example.invalid/listing/l1"),
                    listing_case("L2", "42000", "https://example.invalid/listing/l2"),
                ]))
        for bad_area in ("0", "-5", "NaN", "Infinity", "-Infinity", "not-a-number", True, None):
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(objects=[{
                    "objectId": "object-001", "buildingArea": bad_area, "currency": "CNY",
                    "referenceCaseIds": ["L1", "L2"],
                }]))

    def test_listing_rejects_userinfo_urls_and_credential_bearing_sources(self):
        for bad_url in ("https://user:secret@example.invalid/listing/l1", "ftp://example.invalid/a", "not-a-url", ""):
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(cases=[
                    listing_case("L1", "40000", bad_url),
                    listing_case("L2", "42000", "https://example.invalid/listing/l2"),
                ]))

    def test_listing_duplicate_url_normalizes_tracking_but_keeps_meaningful_query(self):
        # Same host/path, only tracking differs -> duplicate.
        with self.assertRaises(ValueError):
            calculate_market(listing_payload(cases=[
                listing_case("L1", "40000", "https://example.invalid/listing/l1?utm_source=a"),
                listing_case("L2", "42000", "https://example.invalid/listing/l1?utm_source=b"),
            ]))
        # A meaningful query difference is a different listing, not a duplicate.
        result = calculate_market(listing_payload(cases=[
            listing_case("L1", "40000", "https://example.invalid/listing/l1?floor=6"),
            listing_case("L2", "42000", "https://example.invalid/listing/l1?floor=9"),
        ]))
        self.assertEqual(result["objects"][0]["unitPrice"], "41000.00")

    def test_listing_rejects_duplicate_ids_and_duplicate_source_urls(self):
        with self.assertRaises(ValueError):
            calculate_market(listing_payload(cases=[
                listing_case("L1", "40000", "https://example.invalid/listing/l1"),
                listing_case("L1", "42000", "https://example.invalid/listing/l2"),
            ]))
        with self.assertRaises(ValueError):
            calculate_market(listing_payload(cases=[
                listing_case("L1", "40000", "https://example.invalid/listing/same"),
                listing_case("L2", "42000", "https://example.invalid/listing/same"),
            ]))

    def test_listing_rejects_missing_provenance_or_assessment_or_basis(self):
        broken = listing_case("L1", "40000", "https://example.invalid/listing/l1")
        broken["sourceUrl"] = ""
        with self.assertRaises(ValueError):
            calculate_market(listing_payload(cases=[broken, listing_case("L2", "42000", "https://example.invalid/listing/l2")]))
        no_assessment = listing_case("L1", "40000", "https://example.invalid/listing/l1")
        no_assessment["referenceAssessment"] = {"status": "qualified", "reason": "", "knowledgeRef": ""}
        with self.assertRaises(ValueError):
            calculate_market(listing_payload(cases=[no_assessment, listing_case("L2", "42000", "https://example.invalid/listing/l2")]))
        no_basis = listing_payload()
        no_basis["referencePolicy"] = {**no_basis["referencePolicy"], "basis": ""}
        self.assertRaises(ValueError, calculate_market, no_basis)

    def test_listing_rejects_sale_or_unknown_case_mixed_into_listing_set(self):
        for transaction in ("成交", "询价", "未知"):
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(cases=[
                    listing_case("L1", "40000", "https://example.invalid/listing/l1", transactionType=transaction),
                    listing_case("L2", "42000", "https://example.invalid/listing/l2"),
                ]))

    def test_listing_rounds_once_after_the_exact_mean(self):
        result = calculate_market(listing_payload(
            objects=[{
                "objectId": "object-001", "buildingArea": "100", "currency": "CNY",
                "referenceCaseIds": ["L1", "L2"],
            }],
            cases=[
                listing_case("L1", "40000", "https://example.invalid/listing/l1"),
                listing_case("L2", "41001", "https://example.invalid/listing/l2"),
            ],
        ))
        # mean 40500.5, half-up at 2 digits -> 40500.50; total 4050050.00
        self.assertEqual(result["objects"][0]["unitPrice"], "40500.50")
        self.assertEqual(result["objects"][0]["totalValue"], "4050050.00")

    def test_reference_case_ids_must_be_a_list_of_nonempty_strings(self):
        # A plain string must NOT be iterated character by character.
        for bad_ids in ("L1", ["L1", ""], ["L1", 123], ["L1", {"id": "L2"}], [], None):
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(objects=[{
                    "objectId": "object-001", "buildingArea": "100", "currency": "CNY",
                    "referenceCaseIds": bad_ids,
                }]))

    def test_captured_at_must_be_an_actual_iso_datetime(self):
        for bad_time in ("yesterday", "2026-13-40T00:00:00+00:00", 20261014, {"at": "now"}, ""):
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(cases=[
                    listing_case("L1", "40000", "https://example.invalid/listing/l1", capturedAt=bad_time),
                    listing_case("L2", "42000", "https://example.invalid/listing/l2"),
                ]))

    def test_reference_assessment_texts_must_be_real_strings(self):
        for field in ("reason", "knowledgeRef"):
            broken = listing_case("L1", "40000", "https://example.invalid/listing/l1")
            broken["referenceAssessment"] = {
                "status": "qualified", "reason": "规划用途一致", "knowledgeRef": "wiki:x",
            }
            broken["referenceAssessment"][field] = {"text": "not a string"}
            with self.assertRaises(ValueError):
                calculate_market(listing_payload(cases=[
                    broken, listing_case("L2", "42000", "https://example.invalid/listing/l2"),
                ]))


class FormalAdjustmentLimitTest(unittest.TestCase):
    """Single-factor and combined-ratio limits are two distinct checks (no business defaults)."""

    def checks_of(self, factors):
        fixture = payload(cases=[
            case("C1", "40000", factors=factors),
            case("C2", "40000", factors=factors),
            case("C3", "40000", factors=factors),
        ])
        result = calculate_market(fixture)
        return {item["ruleId"]: item for item in result["objects"][0]["ruleChecks"]}

    def test_each_factor_under_single_limit_but_combined_over_combined_limit(self):
        checks = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 115, "caseIndex": 100},
            {"factorId": "F-B", "subjectIndex": 115, "caseIndex": 100},
        ])
        self.assertTrue(checks["market.adjustment.single-limit"]["passed"], "1.15 单项未超过 20%")
        self.assertIn("market.adjustment.combined-limit", checks, "综合修正必须单独成一条检查")
        self.assertFalse(checks["market.adjustment.combined-limit"]["passed"], "1.3225 超过 30%")

    def test_single_factor_over_limit_with_combined_at_par(self):
        checks = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 125, "caseIndex": 100},
            {"factorId": "F-B", "subjectIndex": 80, "caseIndex": 100},
        ])
        self.assertFalse(checks["market.adjustment.single-limit"]["passed"], "1.25 单项超过 20%")
        self.assertIn("market.adjustment.combined-limit", checks)
        self.assertTrue(checks["market.adjustment.combined-limit"]["passed"], "1.25×0.8=1 未超过 30%")

    def test_single_factor_20_percent(self):
        """1.199 / 1.20 / 1.201: equal to the 20% limit passes, just over fails."""
        within = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 1199, "caseIndex": 1000},
        ])
        self.assertTrue(within["market.adjustment.single-limit"]["passed"], "1.199 未超过 20%")
        at_limit = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 120, "caseIndex": 100},
        ])
        self.assertTrue(at_limit["market.adjustment.single-limit"]["passed"], "1.2 等于 20% 算到限，不算超")
        over = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 1201, "caseIndex": 1000},
        ])
        self.assertFalse(over["market.adjustment.single-limit"]["passed"], "1.201 超过 20%")

    def test_single_limit_just_over_is_rejected(self):
        checks = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 121, "caseIndex": 100},
        ])
        self.assertFalse(checks["market.adjustment.single-limit"]["passed"], "1.21 超过 20%")

    def test_negative_direction_uses_magnitude(self):
        at_limit = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 100, "caseIndex": 125},
        ])
        self.assertTrue(at_limit["market.adjustment.single-limit"]["passed"], "下调 20% 等于到限")
        over = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 100, "caseIndex": 126},
        ])
        self.assertFalse(over["market.adjustment.single-limit"]["passed"], "下调超过 20% 也算超")

    def test_combined_30_percent(self):
        """1.299 / 1.30 / 1.301 on the combined ratio: equal to 30% is not over."""
        within = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 1299, "caseIndex": 1000},
        ])
        self.assertTrue(within["market.adjustment.combined-limit"]["passed"], "1.299 未超过 30%")
        at_limit = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 130, "caseIndex": 100},
        ])
        self.assertFalse(at_limit["market.adjustment.single-limit"]["passed"], "1.3 单项超过 20%")
        self.assertTrue(at_limit["market.adjustment.combined-limit"]["passed"], "1.3 等于 30%，不算超")
        over = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 1301, "caseIndex": 1000},
        ])
        self.assertFalse(over["market.adjustment.combined-limit"]["passed"], "1.301 超过 30%")

    def test_price_ratio_12(self):
        """1.199 / 1.20 / 1.201 on the group ratio: equal to 1.2 is not over."""
        section = rule_parameters(**{
            "market.rounding.result": {"rounding": {"mode": "half-up", "digits": 2}},
        })

        def checks_for(second_price):
            fixture = payload(
                objects=[{
                    "objectId": "object-001", "buildingArea": "89.28", "currency": "CNY",
                    "adoptedCaseIds": ["C1", "C2"],
                }],
                cases=[
                    case("C1", "100"),
                    case("C2", second_price),
                ],
                ruleParameters=section,
            )
            result = calculate_market(fixture)
            return {item["ruleId"]: item for item in result["objects"][0]["ruleChecks"]}

        self.assertTrue(checks_for("119.9")["market.price-ratio.limit"]["passed"], "1.199 未超过 1.2")
        self.assertTrue(checks_for("120")["market.price-ratio.limit"]["passed"], "1.2 等于阈值不算超")
        self.assertFalse(checks_for("120.1")["market.price-ratio.limit"]["passed"], "1.201 超过阈值")

    def test_ratio_direction(self):
        """Object better than case raises the case price; case better than object lowers it."""
        def comparable_of(subject_index, case_index):
            fixture = payload(cases=[
                case("C1", "40000", factors=[
                    {"factorId": "F-A", "subjectIndex": subject_index, "caseIndex": case_index},
                ]),
                case("C2", "40000"),
                case("C3", "40000"),
            ])
            result = calculate_market(fixture)
            return Decimal(result["objects"][0]["calculationSteps"][0]["comparableUnitPrice"])

        self.assertGreater(comparable_of(105, 100), Decimal("40000"), "对象更优时必须上调案例价格")
        self.assertLess(comparable_of(100, 105), Decimal("40000"), "案例更优时必须下调案例价格")

    def test_floating_point_at_the_boundary_is_not_misjudged(self):
        """Production parses indices with Decimal(str(value)), so 1.2 is exactly the limit."""
        checks = self.checks_of([
            {"factorId": "F-A", "subjectIndex": 1.2, "caseIndex": 1.0},
        ])
        self.assertTrue(checks["market.adjustment.single-limit"]["passed"],
                        "1.2 等于 20% 上限：不许因二进制表示判成 over")
        fixture = payload(
            objects=[{
                "objectId": "object-001", "buildingArea": "100", "currency": "CNY",
                "adoptedCaseIds": ["C1", "C2"],
            }],
            cases=[case("C1", "1000"), case("C2", "1200")],
        )
        result = calculate_market(fixture)
        ratio_check = {item["ruleId"]: item for item in result["objects"][0]["ruleChecks"]}["market.price-ratio.limit"]
        self.assertTrue(ratio_check["passed"], "1200/1000 恰为 1.2：不算超")


class RoundingModeTest(unittest.TestCase):
    """取整用 Excel 口径（HALF-UP），不是 Python 的银行家舍入。"""

    def test_uses_excel_half_up_not_bankers_rounding(self):
        # 2.5 / 3.5 / 4.5：HALF-UP → 3 / 4 / 5；银行家舍入会得到 2 / 4 / 4。
        fixture = payload(cases=[
            case("C1", "2.5"),
            case("C2", "3.5"),
            case("C3", "4.5"),
        ])
        result = calculate_market(fixture)
        row = result["objects"][0]
        self.assertEqual([step["comparableUnitPrice"] for step in row["calculationSteps"]], ["3", "4", "5"])
        self.assertEqual(row["unitPrice"], "4")

    def test_rounding_digits_from_knowledge_are_applied(self):
        section = rule_parameters(**{
            "market.rounding.result": {"rounding": {"mode": "half-up", "digits": 2}},
        })
        fixture = payload(
            cases=[case("C1", "1.005"), case("C2", "1.005"), case("C3", "1.005")],
            ruleParameters=section,
        )
        result = calculate_market(fixture)
        self.assertEqual(result["objects"][0]["calculationSteps"][0]["comparableUnitPrice"], "1.01")


class FactorIndexBoundaryTest(unittest.TestCase):
    def test_zero_case_index_is_rejected(self):
        """案例条件指数为 0 无法求比值：必须报错，不能得到 0 / inf。"""
        fixture = payload(cases=[
            case("C1", "40000", factors=[{"factorId": "F-A", "subjectIndex": 100, "caseIndex": 0}]),
            case("C2", "41000"),
            case("C3", "42000"),
        ])
        self.assertRaises(ValueError, calculate_market, fixture)


if __name__ == "__main__":
    unittest.main()
