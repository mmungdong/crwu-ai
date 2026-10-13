#!/usr/bin/env python3
"""校验 `估值结果.json`（以及可选的报告 / 底稿一致性）。

用法：

    python3 scripts/validate_result.py <估值结果.json> [--html 估值报告.html] [--workbook 估值底稿.xlsx]

**为什么要有这一份**：结果 JSON 是估值结论的机器可读面，而它最容易出的不是语法错，
是**口径错** —— 基准日没选却悄悄补了一个、挂牌价被当成成交价、拿不到数字时填 0、
结果里写着"已按规范完成"而知识其实缺了两份。这些都读起来完全正常，只有对着规则逐条比才看得出来。

退出码：0 = 通过；1 = 有不符项（逐条打印）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# 采用结论的方法只能是这三个：`auto` 是用户的输入，由 AI 判定之后必须落到具体方法。
CONCLUSION_METHODS = ("market", "income", "cost")
TRANSACTION_TYPES = ("挂牌", "成交", "询价", "未知")

# 中介联系方式的状态（§7.5）。五种都要能被"如实说清楚"，而不是只有"有 / 没有"两态：
# 页面本身脱敏（masked）与需要登录（login-required）是两件完全不同的事，处置也不同。
CONTACT_STATES = ("public", "not-published", "masked", "login-required", "failed")

# 案例状态与规则 ID（§8）。与 `market_rules.py` 是同一套词，有一条测试比对两边一致。
CASE_STATUS = ("adopted", "not-comparable", "insufficient-evidence",
               "single-rule-failed", "combined-rule-failed", "group-consistency-failed")
RULE_LIMITS = {"R-SINGLE-20": 0.20, "R-COMBINED-30": 0.30, "R-GROUP-1.2": 1.2}
RULE_IDS = ("R-COMPARABILITY", "R-EVIDENCE", "R-SINGLE-20", "R-COMBINED-30", "R-GROUP-1.2")
STATUS_RULE = {
    "not-comparable": "R-COMPARABILITY",
    "insufficient-evidence": "R-EVIDENCE",
    "single-rule-failed": "R-SINGLE-20",
    "combined-rule-failed": "R-COMBINED-30",
    "group-consistency-failed": "R-GROUP-1.2",
}
# 数值型规则的阈值只认知识库口径；记录值与它不一致 = 有人自己放宽了阈值。
RULE_LIMIT_TOLERANCE = 1e-9
KNOWLEDGE_SOURCES = ("dws", "local")
NO_BASE_DATE_ITEM = "本次未指定评估基准日"

problems: list[str] = []
warnings: list[str] = []


def fail(message: str) -> None:
    problems.append(message)


def warn(message: str) -> None:
    warnings.append(message)


def is_number(value: object) -> bool:
    # `bool` 是 `int` 的子类：`true` 不该被当成一个数字结论。
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# 计价单位：全表统一（`references/01` 第 5 条 / `06` 「单位统一」）。别种口径要先换算再写。
CANONICAL_PRICE_UNIT = "元/㎡"


def check_required(payload: dict) -> None:
    required = (
        "valuationId", "method", "methodReason", "baseDate", "unitPrice", "totalValue",
        "pricingArea", "priceUnit",
        "manual_confirmation_items", "capability_gaps", "knowledge_sources", "cases", "artifacts",
    )
    for key in required:
        if key not in payload:
            fail(f"缺少必需字段：{key}")


def check_method(payload: dict) -> None:
    method = payload.get("method")
    if method == "auto":
        fail("method 是 `auto`：那是用户的**输入**，不是结论。请写出实际采用的方法（market/income/cost）")
    elif method not in CONCLUSION_METHODS:
        fail(f"method 非法：{method!r}（只允许 {', '.join(CONCLUSION_METHODS)}）")
    if str(payload.get("methodReason", "")).strip() == "":
        fail("methodReason 为空：必须说明采用理由与未采用方法的排除理由")


def check_base_date(payload: dict) -> None:
    base_date = str(payload.get("baseDate", "")).strip()
    items = payload.get("manual_confirmation_items")
    if not isinstance(items, list):
        fail("manual_confirmation_items 必须是数组")
        return
    if base_date == "" and NO_BASE_DATE_ITEM not in [str(item) for item in items]:
        fail(f"baseDate 为空，但 manual_confirmation_items 里没有「{NO_BASE_DATE_ITEM}」"
             "（未指定基准日必须显式登记，不许从资料里补一个）")
    if base_date != "" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", base_date):
        fail(f"baseDate 形状不是 YYYY-MM-DD：{base_date!r}")


def check_amounts(payload: dict) -> None:
    unit, total = payload.get("unitPrice"), payload.get("totalValue")
    for name, value in (("unitPrice", unit), ("totalValue", total)):
        if value is not None and not is_number(value):
            fail(f"{name} 必须是数字或 null，实际是 {type(value).__name__}")
        if is_number(value) and value <= 0:
            fail(f"{name} 必须为正数；拿不到就写 null，**不许填 0**")
    if unit is None and total is None:
        fail("unitPrice 与 totalValue 都是 null：这不算一个估值结论")
    check_pricing_area(payload, unit, total)


def check_pricing_area(payload: dict, unit, total) -> None:
    """计价面积与计价单位（§9 第 1 条「单价、总价及计价面积、单位」）。

    三条：
    1. `priceUnit` 必须是**统一口径**「元/㎡」——按套内面积 / 按套计价的先换算，不在这里写别种口径；
    2. 有单价就**必须**有正数计价面积：没有面积，总价与单价没法勾稽（那正是"口径不一致"的来源）；
    3. 单价 × 面积 ≈ 总价（允许 1 元的舍入差）：三个数各说一套说明至少有一个是错的。
    """
    area = payload.get("pricingArea")
    price_unit = str(payload.get("priceUnit", "")).strip()
    if price_unit == "":
        fail("priceUnit 为空：计价单位必须写出来（统一「元/㎡」）")
    elif price_unit != CANONICAL_PRICE_UNIT:
        fail(f"priceUnit 必须是「{CANONICAL_PRICE_UNIT}」，实际是 {price_unit!r}："
             "按套内面积或按套计价要先换算，不能在这里换一种口径")
    if area is not None and not is_number(area):
        fail(f"pricingArea 必须是数字或 null，实际是 {type(area).__name__}")
    if is_number(area) and area <= 0:
        fail("pricingArea 必须为正数；拿不到就写 null，**不许填 0**")
    if is_number(unit) and area is None:
        fail("有 unitPrice 却没有 pricingArea：没有计价面积，总价与单价无法勾稽")
    if is_number(unit) and is_number(area) and is_number(total):
        expected = unit * area
        if abs(expected - total) > 1.0:
            fail(f"单价 × 计价面积与总价对不上：{unit} × {area} = {expected:.2f}，"
                 f"但 totalValue 是 {total}（允许 1 元舍入差）")


def check_method_screening(payload: dict, case_dir: str) -> None:
    """方法判断记录（§7.2）：采用的方法及依据 + 其他方法不采用的原因 + 不许静默切换。

    三条硬规则：
    1. `methodScreening` 里**恰好一条** `adopted`，且它就是结论里的 `method` ——
       "用了市场法，筛选记录却说收益法是采用的"这种自相矛盾必须拦住；
    2. 每条（含未采用的）都要写依据：只写一句"不符合要求"是不可复核的；
    3. **用户指定了方法、结论却换了另一个**时必须给出 `methodConflict`（含双方与原因）——
       静默切换是这一条要挡掉的东西：用户选了收益法、结果却按市场法给了数，而界面上没有任何提示。
       反过来：没有冲突时必须为 `null`（不许拿一个空的冲突记录糊过去）。
    """
    screening = payload.get("methodScreening")
    if not isinstance(screening, list) or not screening:
        fail("缺 methodScreening：方法判断必须留下记录（采用哪个、为什么，其他为什么不采用）")
        return
    adopted = []
    for index, item in enumerate(screening):
        at = f"methodScreening[{index}]"
        if not isinstance(item, dict):
            fail(f"{at} 不是对象")
            continue
        method = str(item.get("method", "")).strip()
        verdict = str(item.get("verdict", "")).strip()
        if method not in METHODS:
            fail(f"{at} 的 method 非法：{method!r}（只允许 {'/'.join(METHODS)}）")
            continue
        if verdict not in ("adopted", "not-adopted"):
            fail(f"{at} 的 verdict 非法：{verdict!r}（只允许 adopted/not-adopted）")
        if str(item.get("reason", "")).strip() == "":
            fail(f"{at} 缺 reason：每个方法都要写清采用或不采用的依据")
        if verdict == "adopted":
            adopted.append(method)
    if len(adopted) != 1:
        fail(f"methodScreening 里 adopted 的方法必须**恰好一个**，实际 {len(adopted)} 个")
    elif adopted[0] != str(payload.get("method", "")).strip():
        fail(f"methodScreening 说采用的是 {adopted[0]}，但结论里的 method 是 {payload.get('method')!r}："
             "两处必须一致")

    conflict = payload.get("methodConflict", "__missing__")
    if conflict == "__missing__":
        fail("缺 methodConflict：没有冲突时要显式写 null（不许省略）")
        return
    user_method = user_method_of(case_dir)
    if user_method is None:
        # 没有冻结输入（老案例 / 单跑校验脚本）时不猜用户的指定，只做形状检查。
        if conflict is not None:
            check_conflict_shape(conflict)
        return
    if user_method == "auto":
        if conflict is not None:
            fail("用户选的是「自动判定」（没有指定方法），methodConflict 必须是 null")
        return
    if user_method == str(payload.get("method", "")).strip():
        if conflict is not None:
            fail(f"用户指定的方法与结论一致（都是 {user_method}），methodConflict 必须是 null")
        return
    if conflict is None:
        fail(f"用户指定了 {user_method}，结论却用了 {payload.get('method')!r}，而 methodConflict 是 null："
             "**不许静默切换** —— 要么按用户指定的方法算，要么把冲突与原因写出来")
        return
    check_conflict_shape(conflict)
    if not isinstance(conflict, dict):
        return
    if str(conflict.get("userMethod", "")).strip() != user_method:
        fail(f"methodConflict.userMethod 是 {conflict.get('userMethod')!r}，但冻结输入里用户指定的是 {user_method}")
    if str(conflict.get("adoptedMethod", "")).strip() != str(payload.get("method", "")).strip():
        fail("methodConflict.adoptedMethod 必须与结论里的 method 一致")


def check_conflict_shape(conflict: object) -> None:
    if not isinstance(conflict, dict):
        fail("methodConflict 必须是对象或 null")
        return
    for key in ("userMethod", "adoptedMethod"):
        value = str(conflict.get(key, "")).strip()
        if value not in METHODS:
            fail(f"methodConflict.{key} 非法：{value!r}（只允许 {'/'.join(METHODS)}）")
    if str(conflict.get("reason", "")).strip() == "":
        fail("methodConflict 缺 reason：换了方法就必须说明为什么")


def user_method_of(case_dir: str) -> str | None:
    """从冻结输入里读用户指定的方法；读不到返回 `None`（不猜）。"""
    if case_dir == "":
        return None
    path = os.path.join(case_dir, FROZEN_INPUT)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            frozen = json.load(handle)
    except Exception as error:  # noqa: BLE001 - 读不出来就按"没有冻结输入"处理并提醒
        warn(f"冻结输入读不出来（{FROZEN_INPUT}）：跳过方法冲突核对（{error}）")
        return None
    if not isinstance(frozen, dict):
        return None
    method = str(frozen.get("method", "")).strip()
    return method if method in ("auto",) + METHODS else None


def check_knowledge(payload: dict) -> None:
    sources = payload.get("knowledge_sources")
    if not isinstance(sources, list):
        fail("knowledge_sources 必须是数组")
        return
    if not sources:
        fail("knowledge_sources 为空：无法说明结论建立在哪一版规范上")
    for index, item in enumerate(sources):
        if not isinstance(item, dict):
            fail(f"knowledge_sources[{index}] 不是对象")
            continue
        route = str(item.get("route", "")).strip()
        source = item.get("source")
        digest = str(item.get("digest", "")).strip()
        if route == "":
            fail(f"knowledge_sources[{index}] 缺 route")
        if source not in KNOWLEDGE_SOURCES:
            fail(f"knowledge_sources[{index}] 的 source 非法：{source!r}"
                 "（`missing` 不许出现在来源清单里；缺失只写在 capability_gaps）")
        if digest == "":
            fail(f"knowledge_sources[{index}] 缺 digest：没有指纹就无法核对读的是哪一版")
        if str(item.get("updatedAt", "")) == "":
            warn(f"knowledge_sources[{index}]（{route}）没有 updatedAt：来源端没给时间就是空串，别用本地 mtime 顶替")


def check_case_evidence_files(payload: dict, case_dir: str) -> None:
    """案例引用的证据文件必须**真的在案例目录里**（引用了却不在 = 事后无法复核）。

    只有给出案例目录时才能查（`--case-dir` 或结果文件所在目录）。查的是相对路径，
    越界（`..`、绝对路径）一律判不合格 —— 证据必须在本次案例目录之内。
    """
    if case_dir == "":
        return
    for index, item in enumerate(payload.get("cases") or []):
        if not isinstance(item, dict):
            continue
        evidence = str(item.get("evidence", "")).strip()
        if evidence == "":
            continue
        if os.path.isabs(evidence) or ".." in evidence.replace("\\", "/").split("/"):
            fail(f"cases[{index}] 的 evidence 越出案例目录：{evidence!r}")
            continue
        if not os.path.isfile(os.path.join(case_dir, evidence)):
            fail(f"cases[{index}] 引用的证据文件不存在：{evidence}（在 {case_dir} 下找不到）"
                 " —— 证据丢了却说有，比没有证据更危险")


def check_cases(payload: dict, case_dir: str = "") -> None:
    cases = payload.get("cases")
    if not isinstance(cases, list):
        fail("cases 必须是数组")
        return
    for index, item in enumerate(cases):
        if not isinstance(item, dict):
            fail(f"cases[{index}] 不是对象")
            continue
        where = f"cases[{index}]"
        kind = item.get("transaction_type")
        if kind not in TRANSACTION_TYPES:
            fail(f"{where} 的 transaction_type 非法：{kind!r}（只允许 {'/'.join(TRANSACTION_TYPES)}）")
        if str(item.get("url", "")).strip() == "":
            fail(f"{where} 缺 url：案例必须可追溯")
        if str(item.get("captured_at", "")).strip() == "":
            fail(f"{where} 缺 captured_at：抓取时刻是可追溯的一部分")
        # 证据（§10.3「证据截图或页面快照」/ §16「案例有 URL、抓取时间和证据」）。
        # 允许"确实没留存"的案例留在清单里（它是候选案例，剔除也要留痕），但必须**显式标记** ——
        # 留一个空 `evidence` 分不出是"没留存"还是"忘了赋值"，而这两件事的处置完全不同。
        evidence = str(item.get("evidence", "")).strip()
        missing = item.get("evidence_missing") is True
        if evidence == "" and not missing:
            fail(f"{where} 没有 evidence 也没标 evidence_missing："
                 "要么给出证据文件（相对案例目录），要么显式标出这条案例没有留存证据")
        if evidence == "" and missing and item.get("used_as_comparable") is True:
            fail(f"{where} 没有证据却被标为可直接作可比实例："
                 "没有页面证据的案例不能作为结论的依据")
        if str(item.get("keep_reason", "")).strip() == "" and str(item.get("drop_reason", "")).strip() == "":
            fail(f"{where} 既没有保留理由也没有剔除理由：人工判断必须留痕")
        if item.get("used_as_comparable") is True and kind != "成交":
            fail(f"{where} 被标为可直接作可比实例，但 transaction_type 是 {kind!r}："
                 "挂牌价/询价是卖方要价，不得直接当成交价使用")
        for name in ("building_area", "price", "unit_price"):
            value = item.get(name)
            if value is not None and not is_number(value):
                fail(f"{where} 的 {name} 必须是数字或 null")
            if is_number(value) and value <= 0:
                fail(f"{where} 的 {name} 必须为正数；拿不到就写 null")
        check_contact(item, where)
        check_screenshot(item, where, case_dir)
        check_rule_checks(item, where)
        check_case_status(item, where)


def check_screenshot(item: dict, where: str, case_dir: str) -> None:
    """页面截图字段（§7.4）。

    三条：
    1. `screenshot_missing` 必须**显式**给出 —— 空串分不出"没截"与"忘了赋值"（与 `evidence_missing` 同一条纪律）；
    2. 写了截图路径，文件就必须真的在案例目录里（丢了却说有，比没有更危险）；
    3. 有截图时 `screenshot_missing` 不能说 true（自相矛盾）。
    """
    missing = item.get("screenshot_missing")
    if not isinstance(missing, bool):
        fail(f"{where} 缺 screenshot_missing（布尔）：空截图分不出「没截」与「忘了赋值」")
        return
    shot = str(item.get("screenshot", "")).strip()
    if shot == "":
        if missing is not True:
            fail(f"{where} 没有截图路径，`screenshot_missing` 也不是 true：分不出是没截图还是忘了赋值")
        return
    if missing is True:
        fail(f"{where} 既给了截图（{shot}）又标了 screenshot_missing=true：两处矛盾")
    if ".." in shot or os.path.isabs(shot):
        fail(f"{where} 的截图路径越界：{shot}（必须是案例目录内的相对路径）")
        return
    if case_dir != "" and not os.path.isfile(os.path.join(case_dir, shot)):
        fail(f"{where} 引用的截图文件不存在：{shot}（在 {case_dir} 下找不到）"
             " —— 截图丢了却说有，比没有截图更危险")
    if str(item.get("screenshot_digest", "")).strip() == "":
        fail(f"{where} 有截图却没有 screenshot_digest：取证要能核对文件没被换过")


def check_screenshots_declared(payload: dict) -> None:
    """一条截图都没有时，必须在 `capability_gaps` 里说明（§7.4）。

    为什么单独查：本部署确实没有截图能力，但"没有截图"这件事必须**写出来**。
    不写的话，结果看起来像"证据齐备"，而实际上采用案例一张截图都没有。
    """
    cases = [item for item in (payload.get("cases") or []) if isinstance(item, dict)]
    adopted = [item for item in cases if item.get("used_as_comparable") is True]
    if not adopted:
        return
    if any(str(item.get("screenshot", "")).strip() != "" for item in adopted):
        return
    gaps = payload.get("capability_gaps")
    declared = any("截图" in str(one) for one in gaps) if isinstance(gaps, list) else False
    if not declared:
        fail("采用案例一张截图都没有，capability_gaps 里也没有提到截图："
             "没有截图能力时要把这件事写出来，不能让它看起来像证据齐备")


def check_rule_checks(item: dict, where: str) -> None:
    """规则检查记录（§8）：每条剔除案例都要写清"依据哪条规则、实际值、阈值、为什么"。

    "只有一句符合要求"是这一条要挡掉的东西：复核的人要能自己重算一遍。
    """
    checks = item.get("rule_checks")
    if not isinstance(checks, list):
        fail(f"{where} 缺 rule_checks：每条案例都要有规则检查记录（只写一句「符合要求」不可复核）")
        return
    for index, check in enumerate(checks):
        at = f"{where} 的 rule_checks[{index}]"
        if not isinstance(check, dict):
            fail(f"{at} 不是对象")
            continue
        rule_id = str(check.get("rule_id", "")).strip()
        if rule_id not in RULE_IDS:
            fail(f"{at} 的 rule_id 非法：{rule_id!r}（只允许 {'/'.join(RULE_IDS)}）")
            continue
        verdict = str(check.get("verdict", "")).strip()
        if verdict not in ("pass", "fail", "not-applicable"):
            fail(f"{at} 的 verdict 非法：{verdict!r}（只允许 pass/fail/not-applicable）")
        if str(check.get("reason", "")).strip() == "":
            fail(f"{at} 缺 reason：规则判定必须留痕，不能只给一个结论")
        if rule_id in RULE_LIMITS:
            expected = RULE_LIMITS[rule_id]
            threshold = check.get("threshold")
            if not is_number(threshold):
                fail(f"{at} 的 threshold 必须是数字（{rule_id} 的口径是 {expected}）")
            elif abs(float(threshold) - expected) > RULE_LIMIT_TOLERANCE:
                fail(f"{at} 的 threshold 是 {threshold}，但 {rule_id} 的知识库口径是 {expected}："
                     "阈值不许自行放宽")
            actual = check.get("actual")
            if verdict in ("pass", "fail") and not is_number(actual):
                fail(f"{at} 的 verdict 是 {verdict}，就必须给出 actual（实际值）："
                     "没有实际值的规则判定没法复核")


def check_case_status(item: dict, where: str) -> None:
    """案例状态（§8）：与 `used_as_comparable` 一致，且剔除状态要有对应的规则记录。"""
    status = str(item.get("status", "")).strip()
    if status not in CASE_STATUS:
        fail(f"{where} 的 status 非法：{status!r}（只允许 {'/'.join(CASE_STATUS)}）")
        return
    adopted = item.get("used_as_comparable") is True
    if status == "adopted" and not adopted:
        fail(f"{where} 的 status 是 adopted，但 used_as_comparable 不是 true：两处必须一致")
    if status != "adopted" and adopted:
        fail(f"{where} 的 used_as_comparable 是 true，但 status 是 {status}：两处必须一致")
    if status == "adopted":
        # 采用案例不允许有"没通过"的规则判定 —— 例外只有组内一致性（`R-GROUP-1.2`）：
        # 规范允许"说明处置方式后保留"，那种情况下 `check_group_ratio` 会要求
        # `manual_confirmation_items` 里有说明。其余四条判 fail 就不能是 adopted。
        checks = item.get("rule_checks")
        if isinstance(checks, list):
            for check in checks:
                if not isinstance(check, dict) or str(check.get("verdict", "")) != "fail":
                    continue
                rule_id = str(check.get("rule_id", ""))
                if rule_id != "R-GROUP-1.2":
                    fail(f"{where} 是 adopted，但 {rule_id} 判定为 fail：采用案例不能带着没通过的规则")
        return
    # 剔除状态必须能对上触发它的那条规则，且那条规则真的判了 fail。
    wanted = STATUS_RULE.get(status)
    checks = item.get("rule_checks")
    hits = [check for check in checks if isinstance(check, dict) and str(check.get("rule_id", "")) == wanted] \
        if isinstance(checks, list) else []
    if not hits:
        fail(f"{where} 的 status 是 {status}，却没有 {wanted} 的规则检查记录："
             "剔除必须有规则 ID、实际值、阈值与理由")
    elif not any(str(check.get("verdict", "")) == "fail" for check in hits):
        fail(f"{where} 的 status 是 {status}，但 {wanted} 的判定不是 fail：状态与规则结论矛盾")


# 比较案例的**调整规则**只属于市场法（`references/02` 第 9 节）。
# 收益法与成本法没有"可比实例修正系数"这一层，套过来等于用错了口径。
MARKET_ONLY_RULES = ("R-SINGLE-20", "R-COMBINED-30", "R-GROUP-1.2")


def check_rules_match_method(payload: dict) -> None:
    """比较案例的调整规则**只在市场法里执行**（§8）。

    把 20% / 30% / 1.2 这三条套到收益法或成本法上是真实会发生的错误：那两条方法里根本没有
    "可比实例修正系数积"这个层次，套上去的判定看着像做了校验，实际上是拿错口径在自证。
    """
    method = str(payload.get("method", "")).strip()
    if method == "market":
        return
    offenders = []
    for index, item in enumerate(payload.get("cases") or []):
        if not isinstance(item, dict):
            continue
        for check in (item.get("rule_checks") or []):
            if isinstance(check, dict) and str(check.get("rule_id", "")) in MARKET_ONLY_RULES:
                offenders.append(f"cases[{index}].{check.get('rule_id')}")
    if offenders:
        fail(f"采用的方法是 {method}，却出现了市场法专有的比较案例调整规则"
             f"（{'、'.join(sorted(set(offenders)))}）：这三条只在市场法里执行，不许套到别的方法上")


def check_group_ratio(payload: dict) -> None:
    """组内一致性（§8）：报出来的比值必须能从采用案例算出来，且超 1.2 要说明处置方式。

    为什么单独查：`R-GROUP-1.2` 的 `actual` 是**可以**从 JSON 自己重算的
    （max(比准价)/min(比准价)），所以"写一个好看的比值"在这里挡得住。
    """
    adopted = [item for item in (payload.get("cases") or [])
               if isinstance(item, dict) and item.get("used_as_comparable") is True]
    prices = [float(item["unit_price"]) for item in adopted if is_number(item.get("unit_price"))]
    reported = []
    for item in payload.get("cases") or []:
        if not isinstance(item, dict):
            continue
        for check in (item.get("rule_checks") or []):
            if isinstance(check, dict) and str(check.get("rule_id", "")) == "R-GROUP-1.2":
                reported.append(check)
    if not reported:
        return
    if len(prices) < 2:
        for check in reported:
            if is_number(check.get("actual")) and abs(float(check["actual"]) - 1.0) > 1e-6:
                fail("只有一条采用案例（或拿不到比准价）时组内比值只能是 1.0")
        return
    expected = max(prices) / min(prices)
    for check in reported:
        actual = check.get("actual")
        if is_number(actual) and abs(float(actual) - expected) > 1e-6:
            fail(f"R-GROUP-1.2 的 actual 是 {actual}，但按采用案例比准价算出来是 {expected:.6f}："
                 "比值必须能从案例重算得到")
    # 超 1.2 时必须在结论里说明处置方式（剔除离群 / 改加权 / 说明原因后保留）。
    if expected > 1.2 + RULE_LIMIT_TOLERANCE and not payload.get("manual_confirmation_items"):
        fail("组内比值超过 1.2，却没有任何说明：超限要写清处置方式（不得静默忽略）")


def check_contact(item: dict, where: str) -> None:
    """中介联系方式（§7.5）。

    四条硬规则：
    1. **必须显式给出 state**：拿不到也要说是哪种拿不到（未公开 / 脱敏 / 需要登录 / 获取失败）——
       留一个空对象分不出"页面没有"和"忘了写"；
    2. 公开获取（`public`）必须有取值（机构或联系人称呼）与取得时刻；
    3. **脱敏号码原样保留**：不许猜补成完整号码 —— 那是在编造证据；
    4. 其余状态必须有一句人话原因（`detail`），否则界面只能显示"没拿到"，用户没法处置。
    """
    contact = item.get("contact")
    if not isinstance(contact, dict):
        fail(f"{where} 缺 contact：案例必须说明公开联系方式的状态（拿不到也要说明是哪种拿不到）")
        return
    state = str(contact.get("state", "")).strip()
    if state not in CONTACT_STATES:
        fail(f"{where} 的 contact.state 非法：{state!r}（只允许 {'/'.join(CONTACT_STATES)}）")
        return
    phone = str(contact.get("phone", ""))
    if state == "public":
        if str(contact.get("agency", "")).strip() == "" and str(contact.get("person", "")).strip() == "":
            fail(f"{where} 的 contact 标成 public，却既没有机构也没有联系人：公开获取必须有取值")
        if str(contact.get("captured_at", "")).strip() == "":
            fail(f"{where} 的 contact 缺 captured_at：取得时刻是来源状态的一部分")
        # 公开号码里出现脱敏符 = 标错了状态（那是 masked）。
        if "*" in phone or "＊" in phone:
            fail(f"{where} 的 contact.phone 带脱敏符却标成 public：页面脱敏展示应当是 masked")
    if state == "masked" and phone.strip() == "":
        fail(f"{where} 的 contact 标成 masked，却没有把页面展示的脱敏号码原样留下来")
    if state in ("login-required", "failed") and str(contact.get("detail", "")).strip() == "":
        fail(f"{where} 的 contact 状态是 {state}，必须写一句人话原因（detail）")


def check_artifacts(payload: dict, case_dir: str) -> None:
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, dict):
        fail("artifacts 必须是对象")
        return
    for key in ("html", "xlsx", "json"):
        if key not in artifacts:
            fail(f"artifacts 缺 {key}")
    for key in ("html", "xlsx"):
        relative = str(artifacts.get(key, "")).strip()
        if relative == "":
            fail(f"artifacts.{key} 为空：交付件必须有落点")
            continue
        if os.path.isabs(relative) or ".." in relative:
            fail(f"artifacts.{key} 必须是案例目录内的相对路径：{relative!r}")
            continue
        if case_dir != "" and not os.path.isfile(os.path.join(case_dir, relative)):
            fail(f"artifacts.{key} 指向的文件不存在：{relative}")


def number_forms(value: float) -> list[str]:
    """一个数字在 HTML 里可能出现的写法（原样 / 千分位 / 两位小数）。"""
    forms = set()
    if float(value).is_integer():
        forms.add(str(int(value)))
        forms.add(f"{int(value):,}")
    else:
        forms.add(f"{value:g}")
        forms.add(f"{value:,.2f}")
    return sorted(forms)


def check_html_consistency(payload: dict, html_path: str) -> None:
    try:
        with open(html_path, "r", encoding="utf-8", errors="replace") as handle:
            body = handle.read()
    except OSError as error:
        fail(f"读不到报告 {html_path}：{error}")
        return
    if body.strip() == "":
        fail(f"报告是空文件：{html_path}")
        return
    valuation_id = str(payload.get("valuationId", "")).strip()
    if valuation_id != "" and valuation_id not in body:
        warn(f"报告里没有出现估值 ID（{valuation_id}）：人读件最好能对上号")
    for name in ("unitPrice", "totalValue"):
        value = payload.get(name)
        if not is_number(value):
            continue
        if not any(form in body for form in number_forms(float(value))):
            fail(f"报告里找不到 {name} 的数字（{value}）：报告与结果 JSON 必须一致（不一致时以底稿为准）")


# 结果 JSON 的结论方法 ↔ 底稿汇总表「采用的方法」列的中文名（逐字）。
METHOD_LABEL = {"market": "市场法", "income": "收益法", "cost": "成本法"}
SUMMARY_SHEET = "估值结果汇总"
CASE_SHEET = "案例"
# 案例表里放"截图编号 / 证据留档"的那一行（`build_workbook_template.py` 的案例字段）。
CASE_EVIDENCE_ROW = "案例截图 / 证据留档"
SUMMARY_METHOD_COL = 10


def check_method_agreement(workbook, payload: dict) -> None:
    """**结果 JSON 与底稿必须用同一个方法**（能查的那一半一致性）。

    "HTML、JSON、XLSX 三者结论一致"里的 HTML↔JSON 那一半由 `--html` 严格核对；
    数字层面 XLSX↔JSON 需要**重算后的**底稿值（本机没有重算器，这是已记录的能力缺口）。
    但**方法**这一项不需要重算：汇总表的「采用的方法」是人工逐字填的文本，读得到。

    于是这里查一件真实会出错的事：结果 JSON 说"市场法"，底稿汇总表里却写着"收益法" ——
    或者根本没写这一项。那两个交付件在**口径**上就已经不一致了，比数字不一致更早出问题：
    汇总表按 J 列选单价（`SEARCH("收益法",J)`），J 写错等于结论来自另一个方法。
    """
    label = METHOD_LABEL.get(str(payload.get("method") or ""))
    if label is None or SUMMARY_SHEET not in workbook.sheetnames:
        return
    sheet = workbook[SUMMARY_SHEET]
    methods = []
    for row in range(5, sheet.max_row + 1):
        area = sheet.cell(row=row, column=6).value
        if area is None or str(area).strip() == "" or (isinstance(area, str) and area.startswith("=")):
            continue
        value = sheet.cell(row=row, column=SUMMARY_METHOD_COL).value
        methods.append("" if value is None else str(value).strip())
    if not methods:
        return
    if label not in methods:
        fail(f"结果 JSON 的 method 是 {label}，但底稿「{SUMMARY_SHEET}」的采用方法列里没有它"
             f"（实际写了：{ '、'.join(item or '空' for item in methods) }）："
             "两个交付件的口径必须一致 —— 汇总表按 J 列选单价，写错等于结论来自另一个方法")


KNOWLEDGE_INDEX = os.path.join("知识快照", ".知识来源.json")
# 冻结输入：用户确认那一刻写死的输入（方法 / 基准日 / 补充要求 / 清单指纹）。
FROZEN_INPUT = "估值输入.json"
METHODS = ("market", "income", "cost")


def check_knowledge_traceability(payload: dict, case_dir: str) -> None:
    """结果里的知识来源必须**真的来自本轮取到的快照**（§1「可追溯到知识来源」/ §16）。

    为什么要在结果这一侧再查一遍：`knowledge_sources` 是子会话**自己写进 JSON** 的，
    而本轮实际取到的正文在 `知识快照/.知识来源.json`（由取数工具落盘）。两者不比对的话，
    结果里可以出现一份"根本没取到"的路由（或者 `updatedAt`/`digest` 抄错），
    而格式完全合法 —— 事后复核的人只能去翻文件目录。

    查三件事：① 结果里的每条路由都在快照里；② 指纹一致（同一版正文）；
    ③ 快照里 **dws 来源**的那些路由一条都不能漏（那是"优先用知识库"的可核证据）。
    快照不存在时**不报错**：老案例可能没有这个文件（协议 32 之前的产物）。
    """
    if case_dir == "":
        return
    index_path = os.path.join(case_dir, KNOWLEDGE_INDEX)
    if not os.path.isfile(index_path):
        warn(f"没有知识快照索引（{KNOWLEDGE_INDEX}）：跳过来源追溯核对")
        return
    try:
        with open(index_path, "r", encoding="utf-8") as handle:
            index = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        fail(f"知识快照索引读不出来：{error}")
        return
    snapshot = {
        str(item.get("route", "")).strip(): item
        for item in (index.get("sources") or [])
        if isinstance(item, dict)
    }
    reported = {
        str(item.get("route", "")).strip(): item
        for item in (payload.get("knowledge_sources") or [])
        if isinstance(item, dict)
    }
    for route, item in reported.items():
        if route not in snapshot:
            fail(f"结果里的知识来源「{route}」不在本轮快照里："
                 "来源清单必须只说真的取到过的那几份（否则无法复核结论建立在哪一版正文上）")
            continue
        if str(item.get("digest", "")) != str(snapshot[route].get("digest", "")):
            fail(f"知识来源「{route}」的指纹与快照不一致：结果 {item.get('digest')!r} vs "
                 f"快照 {snapshot[route].get('digest')!r}（同一路由读到了不同版本？）")
    missing = [route for route, item in snapshot.items()
               if str(item.get("source", "")) == "dws" and route not in reported]
    if missing:
        fail(f"快照里的知识库来源没有写进结果：{'、'.join(sorted(missing))}："
             "知识库有正文时必须以它为准，并逐条登记 —— 漏登等于把'用了降级备份'说成'用了知识库'")


# 汇总表里放"已知限制 / 待确认事项"的那一行。
SUMMARY_CONFIRM_ROW = "待确认事项"


def check_confirmation_items_in_workbook(workbook, payload: dict) -> None:
    """`manual_confirmation_items` 必须落进底稿的「待确认事项」行（§8 / §9 三者一致）。

    为什么查：结果 JSON 里写了"未指定基准日""案例数量不足"，底稿上却空着 ——
    那是最容易被忽略的一类不一致：**报告上有限制说明，交出去的底稿上看不出这些限制**。
    """
    items = [str(item).strip() for item in (payload.get("manual_confirmation_items") or [])
             if str(item).strip() != ""]
    if not items:
        return
    names = getattr(workbook, "sheetnames", [])
    if SUMMARY_SHEET not in names:
        return
    sheet = workbook[SUMMARY_SHEET]
    blob = ""
    for row in sheet.iter_rows(min_col=1, max_col=1):
        value = row[0].value
        if isinstance(value, str) and value.strip().startswith(SUMMARY_CONFIRM_ROW):
            blob = "\n".join(
                str(cell.value).strip() for cell in sheet[row[0].row]
                if cell.value is not None and str(cell.value).strip() != ""
            )
            break
    if blob == "":
        # 行不存在由工作簿契约负责报（`check_workbook_contract.py`），这里不重复。
        return
    missing = [item for item in items if item not in blob]
    if missing:
        fail(f"manual_confirmation_items 有 {len(missing)} 条没有写进底稿的「{SUMMARY_CONFIRM_ROW}」行"
             f"（例如「{missing[0][:40]}」）：报告上写了限制、底稿上看不出来")


def check_case_evidence_agreement(workbook, payload: dict) -> None:
    """案例表里的「案例截图 / 证据留档」必须与结果 JSON 对得上（§8「截图编号」/ §9 三者一致）。

    为什么查这一条：结果 JSON 里有 `evidence`，底稿里也有一行"证据留档" ——
    两处各写一份而没人比过，就会出现"报告说留了证据、底稿上却是空的"。
    没有页面证据的采用案例本来就已经判红（§16），所以这里只查"JSON 写了、底稿也该写"。
    """
    if CASE_SHEET not in workbook.sheetnames:
        return
    sheet = workbook[CASE_SHEET]
    # 找那一行字段名，然后把该行右边几列的值全收起来。
    evidence_cells: list[str] = []
    located = False
    for row in sheet.iter_rows(min_col=1, max_col=1):
        value = row[0].value
        if isinstance(value, str) and value.strip().startswith(CASE_EVIDENCE_ROW):
            located = True
            for cell in sheet[row[0].row]:
                if isinstance(cell.value, str) and cell.value.strip() != "":
                    evidence_cells.append(cell.value.strip())
            break
    if not located:
        fail(f"底稿的「{CASE_SHEET}」表里找不到「{CASE_EVIDENCE_ROW}」这一行：案例证据留档无处可填")
        return
    blob = "\n".join(evidence_cells)
    for index, item in enumerate(payload.get("cases") or []):
        if not isinstance(item, dict) or item.get("used_as_comparable") is not True:
            continue
        evidence = str(item.get("evidence", "")).strip()
        if evidence == "":
            continue  # 空证据已经由 §16 那条判红，不在这里重复报。
        basename = evidence.replace("\\", "/").split("/")[-1]
        if evidence not in blob and basename not in blob:
            fail(f"采用案例 cases[{index}] 的 evidence（{evidence}）没有写进底稿的「{CASE_EVIDENCE_ROW}」行："
                 "底稿与结果 JSON 必须一致")


def check_workbook_consistency(workbook_path: str, payload: dict | None = None) -> None:
    """底稿抽查：结构存在性（完整契约由 `check_workbook_contract.py` 负责）+ **方法一致**。"""
    try:
        import openpyxl  # type: ignore
    except ImportError:
        warn("本机没有 openpyxl：跳过底稿抽查（工作簿契约请用 check_workbook_contract.py）")
        return
    try:
        workbook = openpyxl.load_workbook(workbook_path, data_only=False)
    except Exception as error:  # noqa: BLE001 - 打不开就是打不开，如实报
        fail(f"底稿打不开：{workbook_path}（{error}）")
        return
    try:
        hidden = [sheet.title for sheet in workbook.worksheets if sheet.sheet_state != "visible"]
        if hidden:
            fail(f"底稿里有隐藏表：{'、'.join(hidden)}")
        broken = []
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows(values_only=True):
                for cell in row:
                    text = str(cell) if cell is not None else ""
                    for marker in ("#REF!", "#VALUE!", "#DIV/0!"):
                        if marker in text:
                            broken.append(f"{sheet.title}:{marker}")
        if broken:
            fail(f"底稿里有错误值：{'、'.join(sorted(set(broken))[:8])}")
        if payload is not None:
            check_method_agreement(workbook, payload)
            check_case_evidence_agreement(workbook, payload)
            check_confirmation_items_in_workbook(workbook, payload)
    finally:
        workbook.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="校验估值结果契约")
    parser.add_argument("result", help="估值结果.json 路径")
    parser.add_argument("--html", default="", help="估值报告.html（一致性抽查）")
    parser.add_argument("--workbook", default="", help="估值底稿.xlsx（结构抽查）")
    args = parser.parse_args()

    if not os.path.isfile(args.result):
        print(f"FAIL 找不到结果文件：{args.result}")
        return 1
    try:
        with open(args.result, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL 结果不是合法 JSON：{error}")
        return 1
    if not isinstance(payload, dict):
        print("FAIL 结果顶层必须是对象")
        return 1

    case_dir = os.path.dirname(os.path.abspath(args.result))
    check_required(payload)
    check_method(payload)
    check_method_screening(payload, case_dir)
    check_base_date(payload)
    check_amounts(payload)
    check_knowledge(payload)
    check_cases(payload, case_dir)
    check_rules_match_method(payload)
    check_screenshots_declared(payload)
    check_group_ratio(payload)
    check_artifacts(payload, case_dir)
    check_knowledge_traceability(payload, case_dir)
    check_case_evidence_files(payload, case_dir)
    if args.html != "":
        check_html_consistency(payload, args.html)
    if args.workbook != "":
        check_workbook_consistency(args.workbook, payload)

    for message in warnings:
        print(f"WARN {message}")
    if problems:
        for message in problems:
            print(f"FAIL {message}")
        print(f"\n{len(problems)} 处不符合结果契约：{args.result}")
        return 1
    print(f"OK: {args.result} 符合 references/09 输出契约"
          f"（方法 {payload.get('method')} · 案例 {len(payload.get('cases') or [])} 条 ·"
          f" 知识来源 {len(payload.get('knowledge_sources') or [])} 份）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
