#!/usr/bin/env python3
"""组装并自校验 `估值报告数据.json`（crwu.valuation.report-data.v2）。

    python3 scripts/build_report_data.py --input <受控运行manifest> --out <估值报告数据.json>

## 这一层做什么

把 Host / 会话交来的**受控运行 manifest**（知识、方法、对象、案例、参数、计算、证据、
工作簿、finalize 回执、状态）规范化成 `schemas/valuation-report-data.schema.json` 的形状：

- 金额 / 单价 / 面积一律规范化成**十进制字符串**（`null` 表示"未知"，空串也归一成 `null`），
  不四舍五入、不引入第二套取整口径；渲染器只逐字排版。
- 未指定的基准日（空串 / 缺失）归一成 `null`，并据此写 `baseDateSpecified=false`。
- 状态决定字段：`blocked` 不写结论与工作簿，`partial` 的金额只进 `provisionalResults`
  （暂算），`failed` / `cancelled` 只列阶段与已有文件。**任何情况下都不产生"已估值完成"的
  假结论**：写 `completed` 必须同时具备对象结论、工作簿与 finalize 校验回执，否则组装失败。

## 这一层不做什么

- 不 eval 任何公式，不做任何算术（设计稿 §10.2：任意公式 eval 一律不允许）。
- 不补造缺失字段、不按记忆填业务参数、不把缺失金额写成 0。
- 不校验图片文件是否存在（那是渲染阶段的事，需要 case 目录）；这里只校验数据形状。

## 自校验

`validate_report_data()` 用**同一份 Schema**（不是另写一套判据）逐条校验，再补几条 Schema
表达不了的跨字段一致性。Schema 是数据形状的唯一事实源：Schema 改了，这里跟着改；缺字段、
枚举不对、判别联合命中多支，都会作为问题返回。
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import decimal
import json
import math
import os
import re
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
REPORT_DATA_SCHEMA_PATH = os.path.join(SKILL_DIR, "schemas", "valuation-report-data.schema.json")

SCHEMA_VERSION = "crwu.valuation.report-data.v2"
STATUSES = ("completed", "blocked", "partial", "failed", "cancelled")
CONCLUSION_METHODS = ("market", "income", "cost")
# 已经产生过程材料、但不是结论的字段。非 completed 状态也允许出现在报告数据里
# （Schema 的判别分支没有禁止它们），方便中断报告展示"已经查到哪一步"。
PROCESS_KEYS = (
    "objects",
    "methodAssessment",
    "parameters",
    "comparables",
    "calculationSteps",
    "ruleChecks",
    "evidence",
)
# 只有 completed 才能写的字段：非 completed 状态下会被丢弃并留下说明，
# 绝不让"中间计算表 / 暂算金额"被读成正式结论（设计稿 §11.4）。
CONCLUSION_KEYS = ("conclusions", "workbooks")

# 未指定的业务前提（P14 / P16）：报告里必须**逐字**出现，否则就是静默跳过。
UNSPECIFIED_BASE_DATE_NOTICE = "本次未指定评估基准日"
UNSPECIFIED_PURPOSE_NOTICE = "本次未指定评估目的"
UNSPECIFIED_VALUE_TYPE_NOTICE = "本次未指定价值类型"
MISSING_IMPACTS = ("registration-gap", "calculation-suspended")

REPORT_STATUS_LABELS = {
    "completed": "已完成",
    "blocked": "已中断",
    "partial": "未定稿",
    "failed": "执行失败",
    "cancelled": "已取消",
}


class ReportDataError(ValueError):
    """报告数据组装失败：问题清单在 `problems` 里，不改写业务口径。"""

    def __init__(self, message: str, problems: list | None = None) -> None:
        super().__init__(message)
        self.problems = list(problems or [])


# ---------------------------------------------------------------------------
# 最小 JSON Schema 校验器（draft-07 子集；keyword 白名单，见 _SUPPORTED_KEYWORDS）
# ---------------------------------------------------------------------------

_SUPPORTED_KEYWORDS = {
    "$schema",
    "$id",
    "$ref",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "definitions",
    "items",
    "enum",
    "const",
    "oneOf",
    "allOf",
    "minLength",
    "minItems",
    "minimum",
}

_TYPE_CHECKS = {
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "string": lambda value: isinstance(value, str),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "null": lambda value: value is None,
}


def _type_ok(instance: object, expected: object) -> bool:
    names = expected if isinstance(expected, list) else [expected]
    return any(_TYPE_CHECKS.get(str(name), lambda _value: False)(instance) for name in names)


def _type_name(expected: object) -> str:
    return "|".join(str(item) for item in expected) if isinstance(expected, list) else str(expected)


def load_report_data_schema() -> dict:
    with open(REPORT_DATA_SCHEMA_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _resolve_ref(root: dict, ref: str) -> dict:
    if not ref.startswith("#/"):
        raise ReportDataError(f"只支持文档内 $ref：{ref!r}")
    node: object = root
    for part in ref[2:].split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or key not in node:
            raise ReportDataError(f"$ref 指向不存在的节点：{ref!r}")
        node = node[key]
    if not isinstance(node, dict):
        raise ReportDataError(f"$ref 指向的不是 schema 对象：{ref!r}")
    return node


def _validate_against(instance: object, schema: object, root: dict, path: str) -> list:
    """按 schema 校验 instance，返回问题清单（空 = 通过）。"""
    if not isinstance(schema, dict):
        return [f"{path}: schema 节点必须是对象"]
    unknown = sorted(key for key in schema if key not in _SUPPORTED_KEYWORDS)
    if unknown:
        return [f"{path}: 校验器不支持 schema keyword {unknown}（拒绝静默忽略，请同步扩展校验器）"]

    if "$ref" in schema:
        return _validate_against(instance, _resolve_ref(root, str(schema["$ref"])), root, path)

    if "oneOf" in schema:
        branches = schema["oneOf"]
        if not isinstance(branches, list):
            return [f"{path}: oneOf 必须是数组"]
        hits = [index for index, branch in enumerate(branches)
                if not _validate_against(instance, branch, root, path)]
        if len(hits) != 1:
            detail = f"{path}: 不满足 oneOf 中的恰好一支（命中 {len(hits)} 支）"
            # 判别联合：status 指向哪一支，就把那一支的具体问题带回来。
            # 只报"命中 0 支"会让人不知道到底缺了 `workbooks` 还是 `conclusions`。
            status = instance.get("status") if isinstance(instance, dict) else None
            matched = [branch for branch in branches
                       if ((branch.get("properties") or {}).get("status") or {}).get("const") == status]
            if len(matched) == 1:
                return [detail] + _validate_against(instance, matched[0], root, path)
            return [detail]
        return []

    problems: list = []
    if "allOf" in schema:
        for index, branch in enumerate(schema.get("allOf") or []):
            problems.extend(_validate_against(instance, branch, root, path))

    expected = schema.get("type")
    if expected is not None and not _type_ok(instance, expected):
        problems.append(f"{path}: 类型应为 {_type_name(expected)}，实际 {type(instance).__name__}")
        return problems

    if "const" in schema and instance != schema["const"]:
        problems.append(f"{path}: 必须等于 {schema['const']!r}，实际 {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        problems.append(f"{path}: {instance!r} 不在枚举 {schema['enum']} 中")
    if isinstance(instance, str) and "minLength" in schema and len(instance) < schema["minLength"]:
        problems.append(f"{path}: 长度 {len(instance)} < minLength {schema['minLength']}")
    if (isinstance(instance, (int, float)) and not isinstance(instance, bool)
            and "minimum" in schema and instance < schema["minimum"]):
        problems.append(f"{path}: {instance} < minimum {schema['minimum']}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            problems.append(f"{path}: 元素数 {len(instance)} < minItems {schema['minItems']}")
        if "items" in schema:
            for index, item in enumerate(instance):
                problems.extend(_validate_against(item, schema["items"], root, f"{path}[{index}]"))

    if isinstance(instance, dict):
        for key in schema.get("required") or []:
            if key not in instance:
                problems.append(f"{path}: 缺必需字段 `{key}`")
        properties = schema.get("properties") or {}
        for key, sub in properties.items():
            if key in instance:
                problems.extend(_validate_against(instance[key], sub, root, f"{path}.{key}"))
        extra = schema.get("additionalProperties")
        if extra is False:
            unknown_keys = [key for key in instance if key not in properties]
            if unknown_keys:
                problems.append(f"{path}: 有多余字段 {sorted(unknown_keys)}")
        elif isinstance(extra, dict):
            for key in instance:
                if key not in properties:
                    problems.extend(_validate_against(instance[key], extra, root, f"{path}.{key}"))
    return problems


def _is_iso_date(value: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        _datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _semantic_problems(data: dict) -> list:
    """Schema 表达不了的跨字段一致性。只加**确定性的**判据，不发明业务阈值。"""
    problems: list = []
    status = data.get("status")

    if data.get("valuationMode") == "listing-reference" and status != "partial":
        problems.append(
            "$.valuationMode: listing-reference 报告只能是 partial（挂牌参考不得作为正式结论交付）")

    # Re-run the reference consistency checks on the persisted shape (not only at construction):
    # a caller can mutate `comparables`/`referenceSummary` after assembling the data.
    problems.extend(_reference_consistency_problems(
        data.get("valuationMode"),
        data.get("referenceSummary"),
        data.get("comparables"),
    ))

    method = data.get("method")
    if isinstance(method, str) and method == "auto":
        problems.append(
            "$.method: 'auto' 不是结论方法（只能是 market/income/cost 或 null）；"
            "auto 属于 methodRequest（用户输入）")

    base_date = data.get("baseDate")
    specified = data.get("baseDateSpecified")
    if isinstance(base_date, str) and base_date.strip() != "":
        if not _is_iso_date(base_date.strip()):
            problems.append(f"$.baseDate: {base_date!r} 不是有效的 YYYY-MM-DD 日期")
        if specified is False:
            problems.append("$.baseDateSpecified: 已给出基准日却标成 false（未指定）")
    else:
        if specified is True:
            problems.append("$.baseDateSpecified: 标成 true（已指定）却没有 baseDate")

    # P16：评估目的 / 价值类型的 `null` 与 `*Specified` 必须自洽。
    for key, label in (("purpose", "评估目的"), ("valueType", "价值类型")):
        value = data.get(key)
        flag = data.get(f"{key}Specified")
        if isinstance(value, str) and value.strip() != "":
            if flag is False:
                problems.append(f"$.{key}Specified: 已给出{label}却标成 false（未指定）")
        elif isinstance(value, str) or value is None:
            if flag is True:
                problems.append(f"$.{key}Specified: 标成 true（已指定）却没有{key}")

    # P14 / P16：未指定的前提必须在 `limitations` 里**逐字**出现；否则报告读起来
    # 就像"这一轮有明确前提"，而实际没有 —— 静默跳过时间因素正是这么发生的。
    limitations = data.get("limitations") if isinstance(data.get("limitations"), list) else []
    joined = "\n".join(str(item) for item in limitations)
    for notice, missing in (
        (UNSPECIFIED_BASE_DATE_NOTICE, data.get("baseDate") is None and data.get("baseDateSpecified") is not True),
        (UNSPECIFIED_PURPOSE_NOTICE, not str(data.get("purpose") or "").strip()),
        (UNSPECIFIED_VALUE_TYPE_NOTICE, not str(data.get("valueType") or "").strip()),
    ):
        if missing and notice not in joined:
            problems.append(f"$.limitations: 未指定时必须逐字写明「{notice}」（不许静默跳过业务前提）")

    if status == "completed":
        # P16：未指定评估目的 / 价值类型时不得声称正式完成。
        for key, notice in (("purpose", UNSPECIFIED_PURPOSE_NOTICE),
                            ("valueType", UNSPECIFIED_VALUE_TYPE_NOTICE)):
            if not str(data.get(key) or "").strip():
                problems.append(
                    f"$.{key}: {notice}：不得据此声称正式估值已完成"
                    "（补齐前提后重新冻结，或按 partial / blocked 交付）")

    # P17：`state = missing` 必须声明影响面，且"字段缺失"与"关键参数缺失"不许混成一个值。
    for index, parameter in enumerate(data.get("parameters") or []):
        if not isinstance(parameter, dict):
            continue
        state = parameter.get("state")
        impact = parameter.get("missingImpact")
        if state == "missing" and impact not in MISSING_IMPACTS:
            problems.append(
                f"$.parameters[{index}].missingImpact: state=missing 时必须声明"
                f"（{' / '.join(MISSING_IMPACTS)}）")
        if state == "provided" and impact == "calculation-suspended":
            problems.append(
                f"$.parameters[{index}]: 已取到值却标成 calculation-suspended（挂起计算）")

    if status == "completed":
        objects = data.get("objects") if isinstance(data.get("objects"), list) else []
        object_ids = {item.get("objectId") for item in objects if isinstance(item, dict)}
        for index, conclusion in enumerate(data.get("conclusions") or []):
            if not isinstance(conclusion, dict):
                continue
            if conclusion.get("objectId") not in object_ids:
                problems.append(
                    f"$.conclusions[{index}].objectId: {conclusion.get('objectId')!r} 不在 objects 里"
                    "（结论必须逐对象对应，不能用一条汇总金额代表多个对象）")
        receipt = data.get("validation")
        if isinstance(receipt, dict):
            for key in ("projectId", "planId", "inputDigest"):
                if receipt.get(key) != data.get(key):
                    problems.append(
                        f"$.validation.{key}: 校验回执 {receipt.get(key)!r} 与报告数据 {data.get(key)!r} 不一致"
                        "（回执必须属于同一轮输入冻结）")
    return problems


def validate_report_data(data: object) -> list:
    """返回问题清单（空 = 通过）。completed 的判据不因为要支持 blocked 而放松。"""
    if not isinstance(data, dict):
        return ["$: 报告数据顶层必须是 JSON 对象"]
    try:
        schema = load_report_data_schema()
    except (OSError, json.JSONDecodeError) as error:
        return [f"$: 读不到报告数据 Schema：{error}"]
    problems = _validate_against(data, schema, schema, "$")
    problems.extend(_semantic_problems(data))
    return problems


# ---------------------------------------------------------------------------
# 规范化小工具（只做形状与进制，不做业务判断）
# ---------------------------------------------------------------------------

def _text(value: object) -> str:
    return "" if value is None else str(value).strip()


def _text_or_none(value: object) -> object:
    text = _text(value)
    return text if text != "" else None


def _as_int(value: object, where: str) -> int:
    if isinstance(value, bool) or value is None:
        raise ReportDataError(f"{where}: 必须是整数，实际 {value!r}")
    if isinstance(value, int):
        return value
    if isinstance(value, decimal.Decimal) and value == value.to_integral_value():
        return int(value)
    raise ReportDataError(f"{where}: 必须是整数，实际 {value!r}")


def _decimal_text(value: object, where: str) -> str:
    """十进制字符串，不取整、不四舍五入。空值保留空串（Schema 里是 string）。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        raise ReportDataError(f"{where}: 布尔值不是金额")
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, decimal.Decimal):
        if not value.is_finite():
            raise ReportDataError(f"{where}: 金额必须是有限十进制数，实际 {value!r}")
        return format(value, "f")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ReportDataError(f"{where}: 金额必须是有限十进制数，实际 {value!r}")
        return format(decimal.Decimal(str(value)), "f")
    raise ReportDataError(f"{where}: 金额必须是字符串或数字，实际 {type(value).__name__}")


def _decimal_or_none(value: object, where: str) -> object:
    text = _decimal_text(value, where)
    return text if text != "" else None


def _jsonable(value: object) -> object:
    if isinstance(value, decimal.Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    return value


def _pick(source: dict, keys: tuple) -> dict:
    return {key: _jsonable(source[key]) for key in keys if key in source}


def _knowledge_ref(value: object) -> object:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ReportDataError("knowledgeRef 必须是对象或 null")
    return _pick(value, ("routeId", "snapshotDigest", "sectionId", "ruleId"))


# ---------------------------------------------------------------------------
# 逐段规范化
# ---------------------------------------------------------------------------

def _material_rows(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.materials: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.materials[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("fileId", "fileName", "archiveRelativePath", "kind", "sha256"))
        if "sizeBytes" in item:
            row["sizeBytes"] = _as_int(item["sizeBytes"], f"{where}.sizeBytes")
        for key in ("createdAt", "modifiedAt", "duplicateOf"):
            if key in item:
                row[key] = _text_or_none(item[key])
        if "readable" in item:
            row["readable"] = bool(item["readable"])
        rows.append(row)
    return rows


def _knowledge_rows(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.knowledgeSources: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.knowledgeSources[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("routeId", "nodeName", "resolvedPath", "source", "spaceName",
                           "updatedAt", "digest", "snapshotFile"))
        for key in ("sectionIds", "ruleIds"):
            if key in item and isinstance(item[key], list):
                row[key] = [_text(entry) for entry in item[key] if _text(entry) != ""]
        rows.append(row)
    return rows


def _retrieval_rows(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.retrievalAttempts: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.retrievalAttempts[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("taskId", "caseId", "providerId", "stage", "outcome",
                           "finalUrl", "reasonCode", "recoveryStrategy"))
        if "recoveryAttempts" in item:
            row["recoveryAttempts"] = _as_int(item["recoveryAttempts"], f"{where}.recoveryAttempts")
        rows.append(row)
    return rows


def _artifact_rows(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.artifacts: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.artifacts[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("artifactId", "kind", "relativePath", "digest"))
        if "present" in item:
            row["present"] = bool(item["present"])
        rows.append(row)
    return rows


def _lookup_rows(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.lookupAttempts: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ReportDataError(f"$.lookupAttempts[{index}]: 必须是对象")
        rows.append(_pick(item, ("routeId", "channel", "target", "outcome", "detail")))
    return rows


def _blocker_rows(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.blockers: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.blockers[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("kind", "stage", "reason", "remediation", "code", "capabilityId"))
        for key in ("missing", "checked"):
            entries = item.get(key)
            row[key] = [_text(entry) for entry in entries if _text(entry) != ""] \
                if isinstance(entries, list) else []
        if "knowledgeRef" in item:
            row["knowledgeRef"] = _knowledge_ref(item["knowledgeRef"])
        rows.append(row)
    return rows


def _dedupe(values: list) -> list:
    """按出现顺序去重（限制清单的先后是有意义的：前提声明在最前）。"""
    seen = set()
    out = []
    for value in values:
        item = str(value)
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _string_rows(value: object, where: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError(f"{where}: 必须是字符串数组")
    return [_text(item) for item in value if _text(item) != ""]


def _objects(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.objects: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.objects[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        # P15：原始权证登记用途与业务分类依据是两个字段，分开搬运（不互相倒填）。
        row = _pick(item, ("objectId", "displayName", "propertyType", "registeredUse", "classificationBasis"))
        entries = item.get("sourceRefs")
        row["sourceRefs"] = [_text(entry) for entry in entries] if isinstance(entries, list) else []
        fields = item.get("fields")
        if isinstance(fields, dict):
            row["fields"] = {str(key): _text(entry) for key, entry in fields.items()}
        row["missingFields"] = _string_rows(item.get("missingFields"), f"{where}.missingFields")
        rows.append(row)
    return rows


def _object_results(value: object, where: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError(f"{where}: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        spot = f"{where}[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{spot}: 必须是对象")
        row = _pick(item, ("objectId", "displayName", "valueScope", "method", "currency",
                           "calculationRef"))
        for key in ("unitPrice", "totalValue"):
            if key in item:
                row[key] = _decimal_or_none(item[key], f"{spot}.{key}")
        rows.append(row)
    return rows


def _screenshots(value: object, where: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError(f"{where}: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        spot = f"{where}[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{spot}: 必须是对象")
        rows.append(_pick(item, ("caseId", "displayName", "provider", "sourceUrl", "capturedAt",
                                 "relativePath", "digest", "validity", "evidenceType")))
        if "evidenceType" not in rows[-1]:
            page_type = _text_or_none(item.get("pageType"))
            alias = {"detail": "detail-screenshot", "list": "page-screenshot"}.get(str(page_type), "")
            if alias != "":
                rows[-1]["evidenceType"] = alias
    return rows


def _comparables(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.comparables: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.comparables[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("caseId", "displayName", "provider", "sourceUrl", "transactionType",
                           "used", "keepReason", "dropReason"))
        row["used"] = bool(item.get("used"))
        if "publishedAt" in item:
            row["publishedAt"] = _text_or_none(item["publishedAt"])
        for key in ("unitPrice", "buildingArea"):
            if key in item:
                row[key] = _decimal_or_none(item[key], f"{where}.{key}")
        row["screenshots"] = _screenshots(item.get("screenshots"), f"{where}.screenshots")
        rows.append(row)
    return rows


def _parameters(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.parameters: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.parameters[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("parameterId", "label", "unit", "region", "sourceRef", "state"))
        # P17：missing 的**处置**必须显式声明（字段缺失可继续 / 关键参数缺失挂起计算）。
        state = row.get("state")
        impact = _text(item.get("missingImpact"))
        if state == "missing" and impact == "":
            raise ReportDataError(
                f"{where}.missingImpact: state=missing 时必须声明影响面"
                f"（{' / '.join(MISSING_IMPACTS)}）—— 「少一栏资料」与「这个方法算不下去」是两件事")
        if impact != "" and impact not in MISSING_IMPACTS:
            raise ReportDataError(
                f"{where}.missingImpact: 只允许 {' / '.join(MISSING_IMPACTS)}，实际 {impact!r}")
        if impact != "":
            row["missingImpact"] = impact
        if "value" in item:
            row["value"] = _decimal_or_none(item["value"], f"{where}.value")
        if "valueDate" in item:
            row["valueDate"] = _text_or_none(item["valueDate"])
        if "ruleRef" in item:
            row["ruleRef"] = _knowledge_ref(item["ruleRef"])
        rows.append(row)
    return rows


def _calculation_steps(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.calculationSteps: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.calculationSteps[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("stepId", "formulaId", "label", "expression", "unit"))
        row["value"] = _decimal_text(item.get("value"), f"{where}.value")
        operands = []
        entries = item.get("operands")
        if isinstance(entries, list):
            for operand_index, operand in enumerate(entries):
                spot = f"{where}.operands[{operand_index}]"
                if not isinstance(operand, dict):
                    raise ReportDataError(f"{spot}: 必须是对象")
                operands.append({
                    "name": _text(operand.get("name")),
                    "value": _decimal_text(operand.get("value"), f"{spot}.value"),
                    "unit": _text(operand.get("unit")),
                    "provenance": _text(operand.get("provenance")),
                })
        row["operands"] = operands
        if "ruleRef" in item:
            row["ruleRef"] = _knowledge_ref(item["ruleRef"])
        rows.append(row)
    return rows


def _rule_checks(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.ruleChecks: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.ruleChecks[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("ruleId", "label", "detail"))
        row["passed"] = bool(item.get("passed"))
        if "ruleRef" in item:
            row["ruleRef"] = _knowledge_ref(item["ruleRef"])
        rows.append(row)
    return rows


def _conclusions(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.conclusions: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.conclusions[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("objectId", "valueScope", "method", "currency", "calculationRef"))
        for key in ("unitPrice", "totalValue"):
            if key in item:
                row[key] = _decimal_or_none(item[key], f"{where}.{key}")
        entries = item.get("basisRefs")
        row["basisRefs"] = [_knowledge_ref(entry) for entry in entries] \
            if isinstance(entries, list) else []
        rows.append(row)
    return rows


def _workbooks(value: object) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.workbooks: 必须是数组")
    rows = []
    for index, item in enumerate(value):
        where = f"$.workbooks[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        row = _pick(item, ("workbookId", "relativePath", "templateId", "templateDigest",
                           "recalculationNote"))
        row["recalculated"] = bool(item.get("recalculated"))
        entries = item.get("objectIds")
        if isinstance(entries, list):
            row["objectIds"] = [_text(entry) for entry in entries]
        rows.append(row)
    return rows


def _legacy_method_result(methods: list, primary: str, payload: dict) -> list:
    """旧结果（协议 38 及更早）没有 `methodResults`：从顶层字段合成一条，保持历史可读。

    合成的记录**只搬已有的值**：拿不到的一律 `null`/空串，不猜、不补 0。
    """
    if len(methods) != 1:
        return []
    artifacts = payload.get("artifacts")
    template = ""
    if isinstance(artifacts, dict):
        template = _text(artifacts.get("xlsx"))
    return [{
        "method": primary or methods[0],
        "basis": _text(payload.get("methodReason")),
        "unitPrice": _decimal_or_none(payload.get("unitPrice"), "$.unitPrice"),
        "totalValue": _decimal_or_none(payload.get("totalValue"), "$.totalValue"),
        "template": template,
    }]


def _method_results(value: object) -> list:
    """逐方法结果（协议 39）。缺字段按空列表处理，**不编造**结果。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportDataError("$.methodResults: 必须是数组（每个采用方法一条记录）")
    rows = []
    for index, item in enumerate(value):
        where = f"$.methodResults[{index}]"
        if not isinstance(item, dict):
            raise ReportDataError(f"{where}: 必须是对象")
        rows.append({
            "method": _text(item.get("method")) or "",
            "basis": _text(item.get("basis")),
            # 金额在报告数据里是**十进制逐字文本**（与 objectResult / conclusion 同一口径）。
            "unitPrice": _decimal_or_none(item.get("unitPrice"), f"{where}.unitPrice"),
            "totalValue": _decimal_or_none(item.get("totalValue"), f"{where}.totalValue"),
            "template": _text(item.get("template")),
        })
    return rows


def _method_assessment(value: object) -> object:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ReportDataError("$.methodAssessment: 必须是对象或 null")
    row = _pick(value, ("planId", "methodRequest", "primaryMethod", "selectedMethods",
                        "requestedMethodHonored", "decidedAt"))
    assessments = []
    entries = value.get("assessments")
    if isinstance(entries, list):
        for index, item in enumerate(entries):
            where = f"$.methodAssessment.assessments[{index}]"
            if not isinstance(item, dict):
                raise ReportDataError(f"{where}: 必须是对象")
            entry = _pick(item, ("method", "reason"))
            entry["applicable"] = bool(item.get("applicable"))
            entry["implemented"] = bool(item.get("implemented"))
            entry["selected"] = bool(item.get("selected"))
            refs = item.get("ruleRefs")
            if isinstance(refs, list):
                entry["ruleRefs"] = [_knowledge_ref(ref) for ref in refs]
            entry["conflicts"] = _string_rows(item.get("conflicts"), f"{where}.conflicts")
            assessments.append(entry)
    row["assessments"] = assessments
    row["notes"] = _string_rows(value.get("notes"), "$.methodAssessment.notes")
    return row


def _validation_receipt(value: object) -> object:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ReportDataError("$.validation: 必须是对象或 null")
    row = _pick(value, ("projectId", "planId", "inputDigest", "verifiedAt"))
    for key in ("knowledgeVerified", "templateVerified", "evidenceVerified",
                "calculationVerified", "workbookRecalculated", "reportRendered"):
        row[key] = bool(value.get(key))
    row["notes"] = _string_rows(value.get("notes"), "$.validation.notes")
    return row


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

def _base_date(payload: dict) -> tuple:
    raw = payload.get("baseDate")
    text = _text(raw)
    base_date = text if text != "" else None
    specified = payload.get("baseDateSpecified")
    if isinstance(specified, bool):
        return base_date, specified
    return base_date, base_date is not None


def _business_input(payload: dict, key: str, label: str) -> tuple:
    """评估目的 / 价值类型：空/缺失归一成 `None` + `specified=False`。

    与基准日同一条口径：`null` 是**未指定**，不是空串、更不是某个默认的正式结论。
    显式给了非字符串（例如数字 0）一律拒绝 —— 那多半是模型把字段填错了位。
    """
    raw = payload.get(key)
    if raw is None:
        return None, False
    if not isinstance(raw, str):
        raise ReportDataError(f"$.{key}: {label}必须是字符串或 null，实际 {type(raw).__name__}")
    text = raw.strip()
    if text == "":
        return None, False
    specified = payload.get(f"{key}Specified")
    if specified is False:
        raise ReportDataError(f"$.{key}Specified: 已给出{label}却标成 false（未指定）")
    return text, True


def _unspecified_notices(base_date, base_date_specified, purpose, value_type) -> list:
    """未指定的业务前提 → **逐字**声明（会被写进 limitations）。

    为什么自动补而不是交给调用方：这几句话是"没有静默跳过"的唯一判据。
    让 manifest 自己记得写，就等于允许它忘 —— 而忘了在报告上看不出来。
    """
    notices = []
    if base_date is None and base_date_specified is not True:
        notices.append(f"{UNSPECIFIED_BASE_DATE_NOTICE}：以下按采集时点组织数据，不构成历史时点价值主张")
    if purpose is None:
        notices.append(f"{UNSPECIFIED_PURPOSE_NOTICE}：不得据此声称正式估值已完成")
    if value_type is None:
        notices.append(f"{UNSPECIFIED_VALUE_TYPE_NOTICE}：不得据此声称正式估值已完成")
    return notices


def _generated_at(payload: dict) -> str:
    """`generatedAt` 是**报告生成时间**，不是资料事实。

    manifest 没给就按组装时刻（UTC）写入 —— 它是"这份报告什么时候生成"的记载，
    页面上也会显示，不参与任何业务判断；因此不把它塞进 `limitations`（那会挤掉真正的
    缺口，也会让"没有登记缺口"这句话失真）。
    """
    text = _text(payload.get("generatedAt"))
    if text != "":
        return text
    return _datetime.datetime.now(_datetime.timezone.utc).replace(microsecond=0).isoformat()


def _require_text(payload: dict, key: str) -> str:
    text = _text(payload.get(key))
    if text == "":
        raise ReportDataError(f"manifest 缺必填字段 `{key}`")
    return text


REFERENCE_LABEL = "挂牌参考估值"
REFERENCE_MODES = ("formal", "listing-reference")


def _safe_reference_url(value: object) -> bool:
    """http(s) with a real hostname and no embedded credentials."""
    raw = _text(value)
    if raw == "":
        return False
    parts = urlsplit(raw)
    return (parts.scheme in ("http", "https") and bool(parts.hostname)
            and not parts.username and not parts.password)


def _reference_consistency_problems(mode: object, summary: object, comparables: object) -> list:
    """Cross-field consistency for referenceSummary; used by constructor *and* validator."""
    problems: list = []
    if mode == "listing-reference":
        if not isinstance(summary, dict):
            return ["$.referenceSummary: listing-reference 报告缺少 referenceSummary"]
        if _text(summary.get("label")) != REFERENCE_LABEL:
            problems.append(f"$.referenceSummary.label: 必须是「{REFERENCE_LABEL}」")
        if _text(summary.get("aggregation")) != "arithmetic-mean":
            problems.append("$.referenceSummary.aggregation: 只支持 arithmetic-mean")
        if _text(summary.get("basis")) == "":
            problems.append("$.referenceSummary.basis: 为空：挂牌参考必须写明比较口径")
        if _text(summary.get("priceNature")) != "挂牌":
            problems.append("$.referenceSummary.priceNature: 必须是「挂牌」")
        if _text(summary.get("unitPriceUnit")) != "CNY/m2":
            problems.append("$.referenceSummary.unitPriceUnit: 必须是 CNY/m2")
        raw_ids = summary.get("caseIds")
        if not isinstance(raw_ids, list) or not raw_ids:
            problems.append("$.referenceSummary.caseIds: 必须是非空数组")
            return problems
        case_ids = [_text(item) for item in raw_ids]
        if any(item == "" for item in case_ids) or len(set(case_ids)) != len(case_ids):
            problems.append("$.referenceSummary.caseIds: 不能有空白或重复")
        by_id = {}
        for row in comparables if isinstance(comparables, list) else []:
            if isinstance(row, dict) and _text(row.get("caseId")) != "":
                by_id[_text(row.get("caseId"))] = row
        for case_id in case_ids:
            row = by_id.get(case_id)
            if row is None:
                problems.append(f"$.referenceSummary.caseIds: {case_id} 不在 comparables 中")
                continue
            if _text(row.get("transactionType")) != "挂牌":
                problems.append(f"$.referenceSummary.caseIds: 案例 {case_id} 的交易性质不是「挂牌」")
            if not _safe_reference_url(row.get("sourceUrl")):
                problems.append(f"$.referenceSummary.caseIds: 案例 {case_id} 缺少 http(s) sourceUrl")
        sources = summary.get("sources")
        if sources is not None:
            if not isinstance(sources, list):
                problems.append("$.referenceSummary.sources: 必须是数组")
                return problems
            seen: set = set()
            for source in sources:
                if not isinstance(source, dict):
                    problems.append("$.referenceSummary.sources: 每一项必须是对象")
                    continue
                case_id = _text(source.get("caseId"))
                url = _text(source.get("sourceUrl"))
                if case_id == "" or case_id not in case_ids:
                    problems.append(f"$.referenceSummary.sources: {case_id!r} 不是选中的 caseIds")
                    continue
                if case_id in seen:
                    problems.append(f"$.referenceSummary.sources: 重复出现 {case_id}")
                    continue
                seen.add(case_id)
                comparable = by_id.get(case_id)
                if comparable is None:
                    continue
                if not _safe_reference_url(url):
                    problems.append(f"$.referenceSummary.sources: {case_id} 缺少 http(s) sourceUrl")
                elif _text(comparable.get("sourceUrl")) != url:
                    problems.append(f"$.referenceSummary.sources: {case_id} 与 comparables 来源 URL 不一致")
            missing = [case_id for case_id in case_ids if case_id not in seen]
            if missing:
                problems.append("$.referenceSummary.sources: 缺少选中的 " + "、".join(missing))
    elif summary is not None:
        problems.append("$.referenceSummary: 只在 valuationMode=listing-reference 时允许")
    return problems


def _reference_summary_of(payload: dict) -> dict:
    """Validate the listing-reference summary and derive sources from comparables when omitted."""
    summary = payload.get("referenceSummary")
    comparables = _comparables(payload.get("comparables"))
    problems = _reference_consistency_problems("listing-reference", summary, comparables)
    if problems:
        raise ReportDataError("referenceSummary 不可用：\n- " + "\n- ".join(problems))
    if not isinstance(summary, dict):
        raise ReportDataError("referenceSummary 不可用")
    case_ids = [_text(item) for item in summary["caseIds"]]
    by_id = {_text(row.get("caseId")): row for row in comparables}
    given = summary.get("sources")
    if isinstance(given, list) and given:
        sources = [{"caseId": _text(item.get("caseId")), "sourceUrl": _text(item.get("sourceUrl"))}
                   for item in given if isinstance(item, dict)]
    else:
        # Derive from the verified comparables instead of rendering a weak fallback.
        sources = [{"caseId": case_id, "sourceUrl": _text(by_id[case_id].get("sourceUrl"))}
                   for case_id in case_ids if case_id in by_id]
    return {
        "label": REFERENCE_LABEL,
        "aggregation": "arithmetic-mean",
        "basis": _text(summary.get("basis")),
        "priceNature": "挂牌",
        "unitPriceUnit": "CNY/m2",
        "caseIds": case_ids,
        **({"sources": sources} if sources else {}),
    }


def build_report_data(payload: dict) -> dict:
    """把受控运行 manifest 组装成 report-data 并自校验；不通过就抛 ReportDataError。"""
    if not isinstance(payload, dict):
        raise ReportDataError("运行 manifest 必须是 JSON 对象")

    status = payload.get("status")
    if status not in STATUSES:
        raise ReportDataError(f"manifest 的 status 必须是 {list(STATUSES)} 之一，实际 {status!r}")

    generated_at = _generated_at(payload)
    base_date, base_date_specified = _base_date(payload)
    purpose, purpose_specified = _business_input(payload, "purpose", "评估目的")
    value_type, value_type_specified = _business_input(payload, "valueType", "价值类型")
    notes: list = []
    # P14 / P16：未指定的业务前提**逐字**进限制清单。放在最前面：它是结论前提，
    # 不是附注；`limitations` 里没有这几句就等于报告没有交代前提。
    unspecified = _unspecified_notices(base_date, base_date_specified, purpose, value_type)

    # P16：未指定评估目的 / 价值类型时**不得**声称正式完成。这里直接拒绝组装 completed，
    # 让调用方改成 partial / blocked 并把前提问题登记出来 —— 而不是产出一份"看起来完成了"的报告。
    if status == "completed":
        blocked_by = []
        if purpose is None:
            blocked_by.append(UNSPECIFIED_PURPOSE_NOTICE)
        if value_type is None:
            blocked_by.append(UNSPECIFIED_VALUE_TYPE_NOTICE)
        if blocked_by:
            raise ReportDataError(
                "completed 报告缺少业务前提：" + "、".join(blocked_by)
                + "。请补齐后重新冻结输入，或把这一轮按 partial / blocked 交付"
                  "（不得据此声称正式估值已完成）。")

    data: dict = {
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "projectId": _require_text(payload, "projectId"),
        "planId": _require_text(payload, "planId"),
        "generatedAt": generated_at,
        "methodRequest": _text(payload.get("methodRequest")) or "auto",
        "method": None,
        "baseDate": base_date,
        "baseDateSpecified": base_date_specified,
        "purpose": purpose,
        "purposeSpecified": purpose_specified,
        "valueType": value_type,
        "valueTypeSpecified": value_type_specified,
        "supplementalPrompt": _text(payload.get("supplementalPrompt")),
        "inputDigest": _require_text(payload, "inputDigest"),
        "materials": _material_rows(payload.get("materials")),
        "knowledgeSources": _knowledge_rows(payload.get("knowledgeSources")),
        "retrievalAttempts": _retrieval_rows(payload.get("retrievalAttempts")),
        "artifacts": _artifact_rows(payload.get("artifacts")),
        # 未指定的前提排在最前，且**去重**：manifest 自己写过的同一句不重复出现。
        "limitations": _dedupe(unspecified + _string_rows(payload.get("limitations"), "$.limitations")),
    }

    # Optional listing-reference mode. Absent = formal (unchanged); listing is partial-only.
    if payload.get("valuationMode") is not None:
        mode = _text(payload.get("valuationMode"))
        if mode not in REFERENCE_MODES:
            raise ReportDataError(f"valuationMode 只支持 {list(REFERENCE_MODES)}，实际 {mode!r}")
        data["valuationMode"] = mode
        if mode == "listing-reference":
            if status != "partial":
                raise ReportDataError(
                    "listing-reference 报告只能是 partial：挂牌参考是参考结论，不得作为正式结论交付")
            data["referenceSummary"] = _reference_summary_of(payload)
        elif payload.get("referenceSummary") is not None:
            raise ReportDataError("referenceSummary 只在 valuationMode=listing-reference 时允许")
    elif payload.get("referenceSummary") is not None:
        raise ReportDataError("referenceSummary 只在 valuationMode=listing-reference 时允许")

    method = payload.get("method")
    data["method"] = _text_or_none(method)
    # 协议 39：`methods` 是**实际采用的全部方法**（唯一权威），`method` 只是主方法（methods[0]）。
    # 多方法时不在这里做任何加权或相加 —— 协调结论属于业务结果，报告只如实呈现。
    methods = payload.get("methods")
    if isinstance(methods, list) and methods:
        data["methods"] = [str(item).strip() for item in methods if str(item).strip() != ""]
    else:
        primary = _text_or_none(method)
        data["methods"] = [primary] if primary is not None else []
    data["methodResults"] = _method_results(payload.get("methodResults")) or _legacy_method_result(
        data.get("methods") or [], _text_or_none(method), payload)

    for key in PROCESS_KEYS:
        if key not in payload:
            continue
        if key == "objects":
            data["objects"] = _objects(payload[key])
        elif key == "methodAssessment":
            assessment = _method_assessment(payload[key])
            if assessment is not None:
                data["methodAssessment"] = assessment
        elif key == "parameters":
            data["parameters"] = _parameters(payload[key])
        elif key == "comparables":
            data["comparables"] = _comparables(payload[key])
        elif key == "calculationSteps":
            data["calculationSteps"] = _calculation_steps(payload[key])
        elif key == "ruleChecks":
            data["ruleChecks"] = _rule_checks(payload[key])
        elif key == "evidence":
            data["evidence"] = _screenshots(payload[key], "$.evidence")

    stage = _text_or_none(payload.get("stage"))

    if status == "completed":
        data["objects"] = _objects(payload.get("objects"))
        data["methodAssessment"] = _method_assessment(payload.get("methodAssessment"))
        data["parameters"] = _parameters(payload.get("parameters"))
        data["comparables"] = _comparables(payload.get("comparables"))
        data["calculationSteps"] = _calculation_steps(payload.get("calculationSteps"))
        data["ruleChecks"] = _rule_checks(payload.get("ruleChecks"))
        data["conclusions"] = _conclusions(payload.get("conclusions"))
        data["evidence"] = _screenshots(payload.get("evidence"), "$.evidence")
        data["workbooks"] = _workbooks(payload.get("workbooks"))
        data["validation"] = _validation_receipt(payload.get("validation"))
    else:
        dropped = [key for key in CONCLUSION_KEYS if payload.get(key)]
        if dropped:
            notes.append(
                "manifest 里的 " + " / ".join(dropped) + " 在 "
                f"{status} 状态下不写入报告数据：被阻断或未定稿的方案只产"
                "《估值状态.json》/ 报告数据 / 中断 HTML，不产正式结论与结论 xlsx；"
                "已经生成的中间计算表只按『工作中』材料登记")
        data["stage"] = stage
        data["blockers"] = _blocker_rows(payload.get("blockers"))
        data["lookupAttempts"] = _lookup_rows(payload.get("lookupAttempts"))
        data["conclusion"] = None

    if status == "blocked":
        data["partialObjectResults"] = _object_results(payload.get("partialObjectResults"),
                                                      "$.partialObjectResults")
    elif status == "partial":
        data["completedWork"] = _string_rows(payload.get("completedWork"), "$.completedWork")
        data["outstanding"] = _string_rows(payload.get("outstanding"), "$.outstanding")
        data["provisionalResults"] = _object_results(payload.get("provisionalResults"),
                                                     "$.provisionalResults")
    elif status in ("failed", "cancelled"):
        data["error"] = _text(payload.get("error"))
        data["availableArtifacts"] = _string_rows(payload.get("availableArtifacts"),
                                                  "$.availableArtifacts")

    if notes:
        data["limitations"] = list(data["limitations"]) + notes

    problems = validate_report_data(data)
    if problems:
        raise ReportDataError(
            "报告数据未通过 Schema 校验（Schema 是唯一事实源）：\n- " + "\n- ".join(problems),
            problems)
    return data


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _atomic_write(out_path: str, body: str) -> None:
    directory = os.path.dirname(os.path.abspath(out_path)) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = f"{out_path}.tmp-{os.getpid()}"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        # 原子落盘：要么是旧的完整文件，要么是新的完整文件，不留半截 JSON。
        os.replace(temporary, out_path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _validate_file(path: str) -> int:
    """Read-only validation of an existing report-data document. Never writes output."""
    if not os.path.isfile(path):
        print(f"FAIL 找不到报告数据文件：{path}")
        return 1
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle, parse_float=decimal.Decimal)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL 报告数据不是合法 JSON：{error}")
        return 1
    problems = validate_report_data(data)
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        print(f"\n{len(problems)} 处报告数据问题：{path}")
        return 1
    status = data.get("status") if isinstance(data, dict) else "?"
    print(f"OK: {path} 符合 report-data.v2 契约（status={status}）")
    return 0


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description="组装并自校验估值报告数据（v2 合同）")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--input", help="受控运行 manifest（JSON）；需要同时给出 --out")
    mode.add_argument("--validate", metavar="DATA", help="只校验一份已有的 估值报告数据.json（不产出）")
    parser.add_argument("--out", help="目标 估值报告数据.json（仅 --input 模式）")
    args = parser.parse_args(argv)

    if args.validate is not None:
        return _validate_file(args.validate)

    if not args.input or not args.out:
        parser.error("--input 模式必须同时提供 --input 与 --out")

    if not os.path.isfile(args.input):
        print(f"FAIL 找不到运行 manifest：{args.input}")
        return 1
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            payload = json.load(handle, parse_float=decimal.Decimal)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL 运行 manifest 不是合法 JSON：{error}")
        return 1

    try:
        data = build_report_data(payload)
    except ReportDataError as error:
        print(f"FAIL {error}")
        return 1

    _atomic_write(args.out, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"OK: 已生成 {args.out}（status={data['status']} / "
          f"对象 {len(data.get('objects') or [])} 个 / "
          f"案例 {len(data.get('comparables') or [])} 条 / "
          f"计算步骤 {len(data.get('calculationSteps') or [])} 步 / "
          f"阻断 {len(data.get('blockers') or [])} 项）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
