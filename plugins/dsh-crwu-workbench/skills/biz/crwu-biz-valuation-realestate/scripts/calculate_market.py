#!/usr/bin/env python3
"""市场法**生产计算入口**：阈值与参数全部来自本轮知识快照。

    python3 scripts/calculate_market.py --input <受控运行manifest> --out <计算轨迹.json>

## 计算口径

连乘、比较、取整与案例判定都在本文件内实现。本文件不自己带任何业务阈值，而是把知识快照里的
结构化规则段解出来再逐条应用。于是"生产运行里有没有隐式默认值"这件事可以被回答：
所有 `limit` 都由知识快照显式传入，缺任何一条必需参数就直接 `ValueError`
（宁可不算，也不按记忆里的数算）。

## 三条口径

1. **综合修正是连乘，不是相加**：`+5%` 与 `+3%` 相加是 `+8%`，连乘是 `1.05 × 1.03 − 1 ≈ 8.15%`。
   案例一多，这个差会放大到能改结论。
2. **十进制用 `Decimal`**：脚本内部不出现二进制浮点误差；输出是**字符串**，
   渲染层不再二次取整。
3. **挂牌价不能直接当可比实例**：`transactionType != '成交'` 的案例只能作为观察，
   把它当成交价算出来的单价是错的（而且看起来完全正常）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_DOWN, ROUND_FLOOR, ROUND_HALF_EVEN, ROUND_HALF_UP
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

SCHEMA_VERSION = "crwu.valuation.calculation.v1"

# 本入口**消费**的规则 ID（技术合同）。缺任何一条 → ValueError（不按记忆补数）。
REQUIRED_RULE_IDS = (
    "market.adjustment.single-limit",
    "market.adjustment.combined-limit",
    "market.price-ratio.limit",
    "market.comparables.min-adopted",
    "market.rounding.result",
)

ROUNDING_MODES = {
    "half-up": ROUND_HALF_UP,
    "half-even": ROUND_HALF_EVEN,
    "floor": ROUND_FLOOR,
    "ceil": ROUND_CEILING,
    "truncate": ROUND_DOWN,
}


def _decimal(value: Any, label: str) -> Decimal:
    """把外部值收成 `Decimal`。空/非数字一律报错 —— **绝不默认成 0**。"""
    if value is None or value == "":
        raise ValueError(f"{label} 缺失：脚本不会把它当成 0")
    if isinstance(value, bool):
        raise ValueError(f"{label} 是布尔值，不是数值")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as error:  # pragma: no cover - 防御性
        raise ValueError(f"{label} 不是合法数值：{value!r}（{error}）") from error


def _quantize(value: Decimal, rounding: Dict[str, Any]) -> Decimal:
    mode = ROUNDING_MODES.get(str(rounding.get("mode", "")))
    if mode is None:
        raise ValueError(f"取整模式不受支持：{rounding.get('mode')!r}")
    digits = int(rounding.get("digits", 0))
    quantum = Decimal(1).scaleb(-digits)
    return value.quantize(quantum, rounding=mode)


def _trim(value: Decimal) -> str:
    """去掉小数尾随零：`1.2100` → `1.21`，`1.0000` → `1`。

    为什么不做固定位数：比值写 `1.21` 比写 `1.2100` 更贴近它的语义（一个系数），
    而且契约里就是 `"1.21"`。金额那一侧仍然按知识给的取整位数输出，不受这里影响。
    """
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def rule_parameters_of(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """解出结构化规则段；缺必需项时**列出缺哪些**，而不是静默用默认值。"""
    section = payload.get("ruleParameters")
    if not isinstance(section, dict) or not section.get("parameters"):
        raise ValueError("缺少结构化规则参数（ruleParameters.parameters）：生产计算必须由知识快照提供阈值，"
                         "不接受代码里的默认业务参数")
    found: Dict[str, Dict[str, Any]] = {}
    for item in section["parameters"]:
        if not isinstance(item, dict):
            continue
        rule_id = str(item.get("ruleId", "")).strip()
        if rule_id:
            found[rule_id] = item
    # 可执行内容一律拒绝：这里只接受数据。
    for key in ("expr", "expression", "script", "command", "url", "selector", "code"):
        if key in section:
            raise ValueError(f"结构化规则段里出现可执行/外部字段 `{key}`：规则段只允许数据声明")
    missing = [rule_id for rule_id in REQUIRED_RULE_IDS if rule_id not in found]
    if missing:
        raise ValueError("知识快照缺少必需的规则参数：" + "、".join(missing))
    return found


def _limit_of(parameters: Dict[str, Dict[str, Any]], rule_id: str) -> Decimal:
    item = parameters[rule_id]
    value = item.get("value")
    if value is None:
        raise ValueError(f"规则参数 {rule_id} 没有取值（不适用与 0 是两件事，缺值不许当 0）")
    unit = str(item.get("unit", ""))
    limit = _decimal(value, f"规则参数 {rule_id}")
    # 知识里写百分比（`20`/`%`）与写比率（`0.2`）都接受，但必须能从 `unit` 看出来。
    if unit in ("%", "percent", "百分比"):
        limit = limit / Decimal(100)
    return limit


def _case_ratio(case: Dict[str, Any]) -> Tuple[Decimal, List[Dict[str, Any]]]:
    """一条案例的因素连乘。返回 `(综合修正系数, 步骤)`。"""
    factors = case.get("factors") or []
    if not factors:
        raise ValueError(f"案例 {case.get('caseId')} 没有任何修正因素：无法计算比准价格")
    ratio = Decimal(1)
    steps: List[Dict[str, Any]] = []
    for factor in factors:
        factor_id = str(factor.get("factorId") or factor.get("factor_id") or "").strip()
        if factor_id == "":
            raise ValueError(f"案例 {case.get('caseId')} 的修正因素缺少 factorId")
        subject = _decimal(factor.get("subjectIndex"), f"因素 {factor_id} 的对象条件指数")
        peer = _decimal(factor.get("caseIndex"), f"因素 {factor_id} 的案例条件指数")
        if peer == 0:
            raise ValueError(f"因素 {factor_id} 的案例条件指数为 0：无法求比值")
        factor_ratio = subject / peer
        ratio *= factor_ratio
        steps.append({
            "factorId": factor_id,
            "subjectIndex": _trim(subject),
            "caseIndex": _trim(peer),
            "ratio": _trim(factor_ratio),
        })
    return ratio, steps


LISTING_REFERENCE_MODE = "listing-reference"
FORMAL_MODES = ("", "formal")
SUPPORTED_AGGREGATIONS = ("arithmetic-mean",)
_TRACKING_QUERY_KEYS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm", "from", "src",
})


def _positive_decimal(value: Any, label: str) -> Decimal:
    """Finite, strictly positive Decimal; bool / NaN / Infinity / zero are all rejected."""
    number = _decimal(value, label)
    if not number.is_finite():
        raise ValueError(f"{label} 不是有限数：{value!r}")
    if number <= 0:
        raise ValueError(f"{label} 必须为正数：{value!r}")
    return number


def _nonempty_text(value: Any, label: str) -> str:
    """A real non-empty string; never coerce objects/numbers into text."""
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"{label} 必须是非空字符串")
    return value.strip()


def _iso_datetime(value: Any, label: str) -> str:
    """Require an actual ISO-8601 datetime string (not just a non-empty string)."""
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"{label} 必须是非空 ISO 时间字符串")
    raw = value.strip()
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} 不是合法的 ISO 时间：{raw!r}（{error}）") from error
    return raw


def _listing_url(value: Any, label: str) -> str:
    raw = str(value or "").strip()
    if raw == "":
        raise ValueError(f"{label} 缺失：挂牌参考必须指回来源")
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"{label} 不是 http(s) 来源地址：{raw!r}")
    if parts.username or parts.password:
        raise ValueError(f"{label} 不能携带用户名/口令")
    return raw


def _canonical_listing_url(raw: str) -> str:
    """Conservative duplicate key: drop fragment/tracking, keep meaningful query (sorted)."""
    parts = urlsplit(raw)
    kept = [(key, item) for key, item in parse_qsl(parts.query, keep_blank_values=True)
            if key.lower() not in _TRACKING_QUERY_KEYS]
    kept.sort()
    netloc = (parts.hostname or "").lower()
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    return urlunsplit((parts.scheme.lower(), netloc, parts.path or "/", urlencode(kept), ""))


def _listing_rounding(policy: Dict[str, Any]) -> Dict[str, Any]:
    rounding = policy.get("rounding")
    if not isinstance(rounding, dict):
        raise ValueError("referencePolicy.rounding 缺失")
    mode = str(rounding.get("mode") or "")
    if mode not in ROUNDING_MODES:
        raise ValueError(f"referencePolicy.rounding.mode 不受支持：{mode!r}")
    digits = rounding.get("digits")
    if isinstance(digits, bool) or not isinstance(digits, int) or not 0 <= digits <= 8:
        raise ValueError(f"referencePolicy.rounding.digits 必须是 0..8 的整数：{digits!r}")
    return {"mode": mode, "digits": digits}


def _listing_cases_of(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    raw_cases = payload.get("cases") or []
    if not isinstance(raw_cases, list):
        raise ValueError("cases 必须是数组")
    cases: Dict[str, Dict[str, Any]] = {}
    canonical_urls: Dict[str, str] = {}
    for item in raw_cases:
        if not isinstance(item, dict):
            raise ValueError("每条挂牌案例必须是对象")
        case_id = str(item.get("caseId") or "").strip()
        if case_id == "":
            raise ValueError("挂牌案例缺少 caseId")
        if case_id in cases:
            raise ValueError(f"挂牌案例 id 重复：{case_id}")
        transaction = str(item.get("transactionType") or "").strip()
        if transaction != "挂牌":
            raise ValueError(f"案例 {case_id} 的交易性质是「{transaction}」：挂牌参考集合只接受「挂牌」")
        price = _positive_decimal(item.get("unitPrice"), f"案例 {case_id} 的挂牌单价")
        if str(item.get("currency") or "").strip() != "CNY":
            raise ValueError(f"案例 {case_id} 的币种必须是 CNY")
        if str(item.get("unitPriceUnit") or "").strip() != "CNY/m2":
            raise ValueError(f"案例 {case_id} 的单价单位必须是 CNY/m2")
        source_url = _listing_url(item.get("sourceUrl"), f"案例 {case_id} 的 sourceUrl")
        canonical = _canonical_listing_url(source_url)
        if canonical in canonical_urls:
            raise ValueError(f"案例 {case_id} 与 {canonical_urls[canonical]} 的来源地址重复：{source_url}")
        canonical_urls[canonical] = case_id
        captured_at = _iso_datetime(item.get("capturedAt"), f"案例 {case_id} 的 capturedAt")
        assessment = item.get("referenceAssessment")
        if not isinstance(assessment, dict):
            raise ValueError(f"案例 {case_id} 缺少 referenceAssessment")
        if str(assessment.get("status") or "").strip() != "qualified":
            raise ValueError(f"案例 {case_id} 的 referenceAssessment.status 不是 qualified")
        reason = _nonempty_text(assessment.get("reason"), f"案例 {case_id} 的 referenceAssessment.reason")
        knowledge_ref = _nonempty_text(assessment.get("knowledgeRef"), f"案例 {case_id} 的 referenceAssessment.knowledgeRef")
        cases[case_id] = {
            "caseId": case_id, "unitPrice": price, "sourceUrl": source_url,
            "capturedAt": captured_at, "reason": reason, "knowledgeRef": knowledge_ref,
        }
    return cases


def _calculate_listing_reference(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Explicit 挂牌参考: arithmetic mean of selected raw listing prices, no adjustment."""
    policy = payload.get("referencePolicy")
    if not isinstance(policy, dict):
        raise ValueError("listing-reference 模式缺少 referencePolicy")
    if str(policy.get("aggregation") or "").strip() not in SUPPORTED_AGGREGATIONS:
        raise ValueError("referencePolicy.aggregation 只支持 arithmetic-mean")
    rounding = _listing_rounding(policy)
    basis = str(policy.get("basis") or "").strip()
    if basis == "":
        raise ValueError("referencePolicy.basis 为空：挂牌参考必须写明比较口径")

    objects = payload.get("objects") or []
    if not isinstance(objects, list) or not objects:
        raise ValueError("没有任何估值对象")
    cases = _listing_cases_of(payload)

    results: List[Dict[str, Any]] = []
    limitations: List[str] = []
    seen_objects: set = set()
    for obj in objects:
        if not isinstance(obj, dict):
            raise ValueError("每个估值对象必须是对象")
        object_id = str(obj.get("objectId") or "").strip()
        if object_id == "":
            raise ValueError("估值对象缺少 objectId")
        if object_id in seen_objects:
            raise ValueError(f"估值对象 id 重复：{object_id}")
        seen_objects.add(object_id)
        area = _positive_decimal(obj.get("buildingArea"), f"{object_id} 的建筑面积")
        if str(obj.get("currency") or "").strip() != "CNY":
            raise ValueError(f"{object_id} 的币种必须是 CNY")
        raw_ref_ids = obj.get("referenceCaseIds")
        if not isinstance(raw_ref_ids, list) or not raw_ref_ids:
            raise ValueError(f"{object_id} 没有 referenceCaseIds：挂牌参考至少需要一条挂牌报价")
        ref_ids: List[str] = []
        for raw_id in raw_ref_ids:
            ref_ids.append(_nonempty_text(raw_id, f"{object_id} 的 referenceCaseIds 项"))
        if len(set(ref_ids)) != len(ref_ids):
            raise ValueError(f"{object_id} 的 referenceCaseIds 有重复")
        selected: List[Dict[str, Any]] = []
        for case_id in ref_ids:
            case = cases.get(case_id)
            if case is None:
                raise ValueError(f"{object_id} 采用了不存在的挂牌案例 {case_id}")
            selected.append(case)
        prices = [item["unitPrice"] for item in selected]
        mean = sum(prices, Decimal(0)) / Decimal(len(prices))
        # Quantize once, independently, from the unrounded mean.
        unit_price = _quantize(mean, rounding)
        total_value = _quantize(mean * area, rounding)
        low, high = min(prices), max(prices)
        count = len(selected)
        provisional_reason = (
            f"挂牌参考：基于 {count} 条挂牌报价的算术平均（未作任何修正或折扣）；"
            f"比较口径：{basis}"
        )
        limitations.append(
            f"{object_id}：挂牌参考估值基于 {count} 条挂牌报价的**原始**算术平均（未作任何修正/折扣），"
            f"价格区间 {_trim(low)}–{_trim(high)}：数量仅供内部参考，不得作为正式结论交付"
        )
        results.append({
            "objectId": object_id,
            "unitPrice": str(unit_price),
            "totalValue": str(total_value),
            "currency": "CNY",
            "provisional": True,
            "provisionalReason": provisional_reason,
            "referenceCaseIds": ref_ids,
            "unitPriceRange": {"min": _trim(low), "max": _trim(high)},
            "sources": [{
                "caseId": item["caseId"], "sourceUrl": item["sourceUrl"],
                "capturedAt": item["capturedAt"], "transactionType": "挂牌",
                "unitPrice": _trim(item["unitPrice"]), "reason": item["reason"],
                "knowledgeRef": item["knowledgeRef"],
            } for item in selected],
            "calculationSteps": [{
                "caseId": item["caseId"], "rawUnitPrice": _trim(item["unitPrice"]),
                "sourceUrl": item["sourceUrl"], "capturedAt": item["capturedAt"],
                "reason": item["reason"], "knowledgeRef": item["knowledgeRef"],
            } for item in selected],
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "valuationMode": LISTING_REFERENCE_MODE,
        "planId": str(payload.get("planId") or ""),
        "objects": results,
        "limitations": limitations,
    }


def calculate_market(payload: Dict[str, Any]) -> Dict[str, Any]:
    """按知识阈值的市场法计算。输入缺阈值 / 缺数值一律 `ValueError`。"""
    if not isinstance(payload, dict):
        raise ValueError("计算输入必须是一个对象")
    mode = str(payload.get("valuationMode") or "").strip()
    if mode == LISTING_REFERENCE_MODE:
        return _calculate_listing_reference(payload)
    if mode not in FORMAL_MODES:
        raise ValueError(f"不支持的 valuationMode：{mode!r}（只支持缺省/formal 正式口径或 listing-reference）")
    parameters = rule_parameters_of(payload)
    single_limit = _limit_of(parameters, "market.adjustment.single-limit")
    combined_limit = _limit_of(parameters, "market.adjustment.combined-limit")
    price_ratio_limit = _limit_of(parameters, "market.price-ratio.limit")
    adopted_min = int(_decimal(parameters["market.comparables.min-adopted"].get("value"),
                               "规则参数 market.comparables.min-adopted"))
    rounding = parameters["market.rounding.result"].get("rounding") or {"mode": "half-up", "digits": 0}
    snapshot_digest = str(payload.get("snapshotDigest") or (payload.get("ruleParameters") or {}).get("snapshotDigest") or "")

    objects = payload.get("objects") or []
    if not objects:
        raise ValueError("没有任何估值对象")
    cases = {str(item.get("caseId")): item for item in (payload.get("cases") or []) if isinstance(item, dict)}

    results: List[Dict[str, Any]] = []
    limitations: List[str] = []
    for obj in objects:
        object_id = str(obj.get("objectId") or "").strip()
        if object_id == "":
            raise ValueError("估值对象缺少 objectId")
        area = _decimal(obj.get("buildingArea"), f"{object_id} 的建筑面积")
        adopted_ids = [str(item) for item in (obj.get("adoptedCaseIds") or [])]
        rule_checks: List[Dict[str, Any]] = []
        calculated: List[Dict[str, Any]] = []

        for case_id in adopted_ids:
            case = cases.get(case_id)
            if case is None:
                raise ValueError(f"{object_id} 采用了不存在的案例 {case_id}")
            transaction = str(case.get("transactionType") or "未知")
            # 挂牌价不是成交价：只能作为观察，不能直接做可比实例。
            if transaction != "成交":
                rule_checks.append({
                    "ruleId": "market.comparable.transaction-type",
                    "passed": False,
                    "detail": f"{case_id} 的交易性质是「{transaction}」：挂牌/询价不能直接作为可比实例",
                })
                continue
            price = _decimal(case.get("unitPrice"), f"案例 {case_id} 的成交单价")
            # 单价必须为正：`0` 既不是"缺失"（缺失由 `_decimal` 拦）也不是一个价格，
            # 放它过去会得到一个 0 元的"比准价格"，而它看起来像个正常的计算中间结果。
            if price <= 0:
                raise ValueError(f"案例 {case_id} 的成交单价是 {price}：必须是正数；拿不到就整条不要采用")
            ratio, steps = _case_ratio(case)
            # Single-factor limit and combined-ratio limit are two distinct checks: do not
            # substitute the case's full ratio for an individual factor (or vice versa).
            factor_dev = max((abs(Decimal(step["ratio"]) - Decimal(1)) for step in steps), default=Decimal(0))
            single_over = factor_dev > single_limit
            rule_checks.append({
                "ruleId": "market.adjustment.single-limit",
                "passed": not single_over,
                "detail": f"{case_id} 单项修正最大 {factor_dev}，阈值 {single_limit}",
            })
            combined_dev = abs(ratio - Decimal(1))
            rule_checks.append({
                "ruleId": "market.adjustment.combined-limit",
                "passed": not (combined_dev > combined_limit),
                "detail": f"{case_id} 综合修正偏离 {combined_dev}，连乘 {ratio}，阈值 {combined_limit}",
            })
            comparable_price = _quantize(price * ratio, rounding)
            calculated.append({
                "caseId": case_id,
                "steps": steps,
                "ratio": _trim(ratio),
                "comparableUnitPrice": str(comparable_price),
                "evidence": str(case.get("evidence") or ""),
            })

        # **一条可用依据都没有**才算"没有结论"（§6.2）：这时不给金额，并写清为什么。
        if not calculated:
            limitations.append(
                f"{object_id}：没有任何可采用案例（挂牌 / 询价不能直接作可比实例，或案例缺少必要依据） —— "
                "不得据此给出单价 / 总价；请补充成交案例后重算，或与用户沟通"
            )
            results.append({
                "objectId": object_id,
                "unitPrice": None,
                "totalValue": None,
                "combinedRatio": None,
                "provisional": False,
                "provisionalReason": "",
                "ruleChecks": rule_checks,
                "calculationSteps": calculated,
            })
            continue

        # **案例少于知识要求**：给**参考结论**，不把金额清空（§6.1）——
        # 有依据就算得出来，数量不足是**限制**（要说清差几条、不得作为正式结论交付），
        # 不是"没有结论"。清空金额会让复核的人看不到任何可比信息，也看不出差多少。
        provisional = len(calculated) < adopted_min
        provisional_reason = ""
        if provisional:
            missing = adopted_min - len(calculated)
            provisional_reason = (
                f"可采用案例 {len(calculated)} 条，少于知识要求的 {adopted_min} 条（缺 {missing} 条）："
                "结论按参考结论处理，不得作为正式结论交付"
            )
            limitations.append(
                f"{object_id}：{provisional_reason} —— 下面给出的单价 / 总价是**参考结论**"
                "（仅供内部复核与沟通），不得作为正式结论交付"
            )
            rule_checks.append({
                "ruleId": "market.comparables.min-adopted",
                "passed": False,
                "detail": f"{object_id}：{provisional_reason}（结论标记为参考）",
            })

        prices = [Decimal(item["comparableUnitPrice"]) for item in calculated]
        ratio_high_low = max(prices) / min(prices) if min(prices) > 0 else None
        if ratio_high_low is not None:
            over = ratio_high_low > price_ratio_limit
            rule_checks.append({
                "ruleId": "market.price-ratio.limit",
                "passed": not over,
                "detail": f"{object_id} 修正后最高/最低价 {ratio_high_low}，阈值 {price_ratio_limit}",
            })
        unit_price = _quantize(sum(prices) / Decimal(len(prices)), rounding)
        total_value = _quantize(unit_price * area, rounding)
        # 综合修正系数（对象级）取各案例连乘系数的算术平均，仅作过程展示。
        combined = sum((Decimal(item["ratio"]) for item in calculated), Decimal(0)) / Decimal(len(calculated))
        results.append({
            "objectId": object_id,
            "unitPrice": str(unit_price),
            "totalValue": str(total_value),
            "combinedRatio": _trim(_quantize(combined, {"mode": "half-up", "digits": 4})),
            "currency": str(obj.get("currency") or "CNY"),
            # 参考结论标记：报告与底稿要能一眼看出"这个数是参考值，不是正式结论"。
            "provisional": provisional,
            "provisionalReason": provisional_reason,
            "ruleChecks": rule_checks,
            "calculationSteps": calculated,
        })

    return {
        "schemaVersion": SCHEMA_VERSION,
        "snapshotDigest": snapshot_digest,
        "objects": results,
        "limitations": limitations,
    }


def summarize_objects(payload: Dict[str, Any]) -> Dict[str, Any]:
    """多对象/多组件汇总。

    **重复计价必须被拒绝**：`land-and-building` 已经包含土地权益，再与 `land-only` 相加
    就是把同一块地算两次。金额只有在币种、基准日、价值范围口径一致时才合计；
    否则只列各项，不给误导性总价。
    """
    objects = payload.get("objects") or []
    if not objects:
        raise ValueError("没有任何对象可汇总")
    scopes = [str(item.get("valueScope") or "") for item in objects]
    if "land-and-building" in scopes and ("land-only" in scopes or "building-only" in scopes):
        raise ValueError("land-and-building 与 land-only/building-only 并存：会把土地权益重复计价，拒绝汇总")
    if len(set(scopes)) != len(scopes) and len(objects) > 1:
        raise ValueError("同一个价值范围出现多次：汇总前请先确认是不是同一个估价对象的重复任务")

    currencies = {str(item.get("currency") or "") for item in objects}
    base_dates = {str(item.get("baseDate") or "") for item in objects}
    rows: List[Dict[str, Any]] = []
    for item in objects:
        total = item.get("totalValue")
        if total in (0, "0", 0.0):
            raise ValueError(f"对象 {item.get('objectId')} 的总价是 0：0 不是「缺失」，不许用它凑合计")
        rows.append({
            "objectId": str(item.get("objectId") or ""),
            "valueScope": str(item.get("valueScope") or ""),
            "totalValue": None if total in (None, "") else str(total),
            "currency": str(item.get("currency") or ""),
            "baseDate": item.get("baseDate") or None,
        })

    can_total = len(currencies) == 1 and "" not in currencies and len(base_dates) == 1 and "" not in base_dates
    total_value: Optional[str] = None
    note = ""
    if can_total and all(row["totalValue"] is not None for row in rows):
        total_value = str(sum((Decimal(row["totalValue"]) for row in rows), Decimal(0)))
    else:
        note = "币种或基准日不一致（或存在缺失值）：只列各项，不给合计总价"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "objects": rows,
        "totalValue": total_value,
        "note": note,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="按知识快照阈值计算市场法（生产入口）")
    parser.add_argument("--input", required=True, help="受控运行 manifest（JSON）")
    parser.add_argument("--out", required=True, help="计算轨迹落盘路径")
    parser.add_argument("--summarize", action="store_true", help="改为执行多对象汇总")
    args = parser.parse_args(argv)
    with open(args.input, encoding="utf-8") as handle:
        payload = json.load(handle)
    result = summarize_objects(payload) if args.summarize else calculate_market(payload)
    tmp = f"{args.out}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, args.out)
    print(f"OK: 已生成 {args.out}（对象 {len(result.get('objects', []))} 个）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
