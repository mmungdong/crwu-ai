#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OCR 覆盖率快照：把 `ocr/index.json` 与识别记录折算成**可交付的 verdict**。

为什么要有这个脚本：覆盖率一度是每个会话在交付脚本里**即席实现**的
（2026-10-22 现场：父会话自己写了一个 `done >= total` 的折算，26 页里 1 页不可读就把
整份判成未核，把子代理已读完的 45 页一并作废）。同一份 `ocr/` 目录，不同会话给出不同结论，
交付里的"已审核 N/M"就不可复现。这里把折算固化成纯函数：模型只消费事实，不自拟规则。

判定口径（唯一口径）：

| verdict | 条件 | 交付口径 |
| --- | --- | --- |
| `complete` | 全部需要判读的页都已判读 | 已审核 |
| `partial` | 已判读 + 不可读 = 需要判读，且没有待判读页 | 已审核（逐页登记不可读） |
| `pending` | 还有待判读页 | 未核，必须进 `notCheckedItems` |
| `skippedBudget` | 超出视觉预算，整份未判读 | 未核，必须进 `notCheckedItems` 并给动作 |

`unreadable` 页计入"已判读但不可读"，不进 `complete`；一份来源只要还有待判读页，整份即
`pending`（**不按比例折算**）。页图存在不算已判读——`visualStatus` 只由 `ocr_record.py` 写入。
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import sys

import ocr_runtime

SCHEMA_VERSION = 1

# 只有本轮必须判读的页数超过这个量级才允许整批拒绝（异常量级判据，不是"读不完"的挡箭牌）。
DEFAULT_MAX_VISUAL_PAGES = 5000

# `ocr_record.py` 写进 index 的已判读状态；`conflict` 是"读过但两值不一致"，
# 属于已判读（它有自己的处置口径），不在这里重复定性。
RECOGNIZED_STATUSES = ("recognized", "partial", "conflict")

VERDICT_COMPLETE = "complete"
VERDICT_PARTIAL = "partial"
VERDICT_PENDING = "pending"
VERDICT_SKIPPED = "skippedBudget"

_VERDICT_REASON = {
    VERDICT_COMPLETE: "",
    VERDICT_PARTIAL: "page-unreadable",
    VERDICT_PENDING: "pages-pending",
    VERDICT_SKIPPED: "budget-refused",
}

# 员工动作按**原因**给，不按 verdict 给：加密件要口令、坏件要重送、待判读要读图。
_ACTION_BY_REASON = {
    "pdf-password-required": "提供 PDF 口令或解密版后重送本件",
    "source-failed": "重新提供可读电子件（或另存为 PDF 后重送）",
    "pages-pending": "按页图逐页判读后落盘；无法判读的登记为不可读并给员工动作",
    "page-unreadable": "人工核对不可读页（印章/签名/手写页请提供清晰件）",
    "budget-refused": "超出视觉预算：分批送审或提供文本版",
}

# 整批拒绝的声明文件（案例内 `ocr/refusal.json`）。只有批次确实超预算时才生效。
REFUSAL_FILE = "refusal.json"
INVENTORY_FILE = "材料盘点.json"


def ocr_dir(case_dir: str) -> str:
    return os.path.join(case_dir, "ocr")


def index_path(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), "index.json")


def coverage_path(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), "coverage.json")


def recognition_dir(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), "recognition")


def page_state(page: dict) -> str:
    """单页状态：`recognized` / `unreadable` / `pending` / `not-required`。

    判据只看**记录**写回 index 的事实（`recognitionStatus` / `visualStatus`）。
    `renderError` 是渲染失败：这一页连图都没有，按不可读处理，但绝不等于"本页为空"。
    """
    if not page.get("visualRequired"):
        return "not-required"
    if page.get("renderError"):
        return "unreadable"
    status = str(page.get("recognitionStatus") or "")
    visual = str(page.get("visualStatus") or "")
    if status == "unreadable" or visual == "unreadable":
        return "unreadable"
    if status in RECOGNIZED_STATUSES or visual == "done":
        return "recognized"
    return "pending"


def source_entry(source: dict) -> dict:
    """一份来源的逐页折算结果。"""
    counts = {"required": 0, "recognized": 0, "unreadable": 0, "pending": 0}
    pending_pages = []
    for page in source.get("pages") or []:
        if not isinstance(page, dict):
            continue
        state = page_state(page)
        if state == "not-required":
            continue
        counts["required"] += 1
        if state == "recognized":
            counts["recognized"] += 1
        elif state == "unreadable":
            counts["unreadable"] += 1
        else:
            counts["pending"] += 1
            pending_pages.append(page.get("page"))

    verdict = _verdict(source, counts)
    entry = {
        "sourceId": source.get("sourceId", ""),
        "relativePath": source.get("relativePath", ""),
        "kind": source.get("kind", ""),
        "pageCount": int(source.get("pageCount") or 0),
        "required": counts["required"],
        "recognized": counts["recognized"],
        "unreadable": counts["unreadable"],
        "pending": counts["pending"],
        "verdict": verdict,
        "reasonCode": _reason_code(source, verdict),
    }
    if pending_pages:
        # 页号只列前 50 个：快照要可读，明细仍在 index.json 里。
        entry["pendingPages"] = pending_pages[:50]
        entry["pendingPagesTruncated"] = len(pending_pages) > 50
    if verdict == VERDICT_SKIPPED:
        entry["reasonCode"] = str(source.get("skippedReason") or "budget-refused")
    return entry


def _verdict(source: dict, counts: dict) -> str:
    status = str(source.get("status") or "")
    # 整份打不开 / 需要口令：`pages` 是空的，但它是**未核**，不是"没有需要判读的页"。
    # 不先拦这两个状态，required == 0 会把加密件洗成 complete，交付侧还会要求
    # `readable=true` —— 正是这次要消灭的"假通过"。
    if status in ("needs-password", "failed"):
        return VERDICT_PENDING
    if status == "budget-refused":
        return VERDICT_SKIPPED
    if counts["required"] == 0:
        # 没有需要判读的页：文本层可读的 PDF 就是这一类，不该因为"没渲染"被判未核。
        return VERDICT_COMPLETE
    if counts["pending"] > 0:
        return VERDICT_PENDING
    if counts["recognized"] >= counts["required"]:
        return VERDICT_COMPLETE
    return VERDICT_PARTIAL


def _reason_code(source: dict, verdict: str) -> str:
    status = str(source.get("status") or "")
    if status == "needs-password":
        return "pdf-password-required"
    if status == "failed":
        return "source-failed"
    if verdict == VERDICT_SKIPPED:
        return str(source.get("skippedReason") or "budget-refused")
    return _VERDICT_REASON[verdict]


def _action_for(reason_code: str) -> str:
    return _ACTION_BY_REASON.get(reason_code, "人工核对后重送该件")


def _stale_records(case_dir: str, index: dict) -> list:
    """识别记录里出现、但 index 里没有的页 —— 覆盖率不能建立在过期记录上。"""
    directory = recognition_dir(case_dir)
    if not os.path.isdir(directory):
        return []
    known = {}
    for source in index.get("sources") or []:
        pages = {page.get("page") for page in source.get("pages") or [] if isinstance(page, dict)}
        known[str(source.get("sourceId") or "")] = pages
    stale = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        record = ocr_runtime.read_json(os.path.join(directory, name)) or {}
        if not isinstance(record, dict):
            continue
        source_id = str(record.get("sourceId") or "")
        if source_id not in known:
            stale.append({"sourceId": source_id, "relativePath": record.get("relativePath", ""),
                          "reason": "来源已不在索引里"})
            continue
        missing = sorted({page.get("page") for page in record.get("pages") or []
                          if isinstance(page, dict) and page.get("page") not in known[source_id]})
        if missing:
            stale.append({"sourceId": source_id, "relativePath": record.get("relativePath", ""),
                          "reason": "记录里的页不在索引里：%s" % missing[:20]})
    return stale


def _norm_rel(value) -> str:
    """案例内相对路径的统一形状：反斜杠归一、去 `./`（不做大小写折叠，路径由 Host 给）。"""
    raw = str(value or "").strip().replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    return raw


def refusal_path(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), REFUSAL_FILE)


def _inventory_paths(case_dir: str) -> set:
    """`材料盘点.json.ocrRequired[].path`：允许对"还没进索引"的来源声明拒绝。"""
    data = ocr_runtime.read_json(os.path.join(case_dir, INVENTORY_FILE), {}) or {}
    out = set()
    if isinstance(data, dict):
        for item in data.get("ocrRequired") or []:
            if isinstance(item, dict) and item.get("path"):
                out.add(_norm_rel(item["path"]))
    return out


def _load_refusals(case_dir: str, index: dict, required_total: int,
                   max_visual_pages: int):
    """读 `ocr/refusal.json`，返回 `(honoured, problems)`。

    拒绝只在**批次确实超预算**时生效：否则模型可以拿它绕开"必须读完"。
    不在索引里的来源必须自己声明 `pages`（没有别的依据可以证明它确实很大）。
    """
    if not case_dir:
        return [], []
    path = refusal_path(case_dir)
    if not os.path.isfile(path):
        return [], []
    data = ocr_runtime.read_json(path, {}) or {}
    entries = data.get("sources") if isinstance(data, dict) else None
    if not isinstance(entries, list) or not entries:
        return [], [{"kind": "refusal-invalid",
                     "reason": "ocr/refusal.json 的 sources 必须是非空数组"}]
    by_rel = {_norm_rel(item.get("relativePath")): item
              for item in index.get("sources") or [] if isinstance(item, dict)}
    inventory = _inventory_paths(case_dir)
    parsed, problems = [], []
    for raw in entries:
        if not isinstance(raw, dict):
            problems.append({"kind": "refusal-invalid", "reason": "拒绝条目必须是对象"})
            continue
        rel = _norm_rel(raw.get("relativePath"))
        reason = str(raw.get("reason") or "").strip()
        if (not rel or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel)
                or ".." in rel.split("/")):
            problems.append({"kind": "refusal-invalid-path",
                             "relativePath": rel or "（空）",
                             "reason": "必须是案例内相对路径"})
            continue
        if not reason:
            problems.append({"kind": "refusal-invalid", "relativePath": rel,
                             "reason": "必须写明拒绝理由"})
            continue
        if rel not in by_rel and rel not in inventory:
            problems.append({"kind": "refusal-unknown-source", "relativePath": rel,
                             "reason": "既不在 ocr/index.json，也不在 材料盘点.json 的 ocrRequired[]"})
            continue
        source = by_rel.get(rel)
        if source is not None:
            pages = sum(1 for page in source.get("pages") or []
                        if isinstance(page, dict) and page.get("visualRequired"))
        else:
            pages = int(raw.get("pages") or 0)
            if pages <= 0:
                problems.append({"kind": "refusal-pages-missing", "relativePath": rel,
                                 "reason": "不在 ocr/index.json 的来源必须给 pages"})
                continue
        parsed.append({"relativePath": rel, "reason": reason, "pages": pages,
                       "inIndex": source is not None})
    if problems:
        return [], problems
    batch = int(required_total) + sum(item["pages"] for item in parsed if not item["inIndex"])
    if batch <= int(max_visual_pages):
        return [], [{
            "kind": "refusal-not-justified",
            "batchPages": batch,
            "maxVisualPages": int(max_visual_pages),
            "requiredAction": "批次未超预算，必须读完；不得用 ocr/refusal.json 绕过",
        }]
    return parsed, []


def compute(index: dict, case_dir: str, max_visual_pages: int = DEFAULT_MAX_VISUAL_PAGES) -> dict:
    """折算入口。

    `index` 是已读取的 `ocr/index.json`；`case_dir` 用于读三样东西：
    `ocr/recognition/`（过期记录）、`ocr/refusal.json`（整批拒绝）、`材料盘点.json`（可拒绝的范围）。
    所以本函数**不是**纯函数 —— 它同一个 `index` 在不同案例状态下可以得出不同结论（拒绝生效与否）。
    """
    entries = [source_entry(source) for source in index.get("sources") or []
               if isinstance(source, dict)]
    by_rel = {_norm_rel(item["relativePath"]): item for item in entries}
    required_total = sum(item["required"] for item in entries)

    honoured, refusal_problems = _load_refusals(
        case_dir, index, required_total, max_visual_pages)
    for item in honoured:
        entry = by_rel.get(item["relativePath"])
        if entry is None:
            # 从未进入 ocr_prepare 的来源：按声明的页数合成一条，交付侧必须披露它。
            entry = {"sourceId": "", "relativePath": item["relativePath"], "kind": "",
                     "pageCount": item["pages"], "required": item["pages"],
                     "recognized": 0, "unreadable": 0, "pending": 0}
            entries.append(entry)
            by_rel[item["relativePath"]] = entry
        entry["verdict"] = VERDICT_SKIPPED
        entry["reasonCode"] = "budget-refused"
        entry["refusalReason"] = item["reason"]
        entry["pending"] = 0
        entry.pop("pendingPages", None)
        entry.pop("pendingPagesTruncated", None)

    totals = {
        "required": sum(item["required"] for item in entries),
        "recognized": sum(item["recognized"] for item in entries),
        "unreadable": sum(item["unreadable"] for item in entries),
        "pending": sum(item["pending"] for item in entries),
        "skippedPages": sum(item["pageCount"] for item in entries
                            if item["verdict"] == VERDICT_SKIPPED),
        "sourcesComplete": sum(1 for item in entries if item["verdict"] == VERDICT_COMPLETE),
        "sourcesPartial": sum(1 for item in entries if item["verdict"] == VERDICT_PARTIAL),
        "sourcesPending": sum(1 for item in entries if item["verdict"] == VERDICT_PENDING),
        "sourcesSkippedBudget": sum(1 for item in entries if item["verdict"] == VERDICT_SKIPPED),
    }
    # 预算量的是"本轮还要读多少页"：全部读完的 5001 页不该被阻断，被拒绝的页也不该算进去。
    budget = {
        "maxVisualPages": int(max_visual_pages),
        "used": totals["pending"],
        "requiredPages": totals["required"],
        "exceeded": totals["pending"] > int(max_visual_pages),
    }
    blocks = []
    if budget["exceeded"]:
        blocks.append({
            "kind": "budget-exceeded",
            "pendingPages": totals["pending"],
            "maxVisualPages": budget["maxVisualPages"],
            "requiredAction": "分批送审或提供文本版，不要把「页多」写成「材料缺失」；"
                              "确属整批拒绝时写 ocr/refusal.json",
        })
    blocks.extend(refusal_problems)
    for item in _stale_records(case_dir, index):
        blocks.append({
            "kind": "stale-recognition",
            "relativePath": item["relativePath"],
            "reason": item["reason"],
            "requiredAction": "重跑 ocr_prepare 让索引覆盖这些页，或作废对应识别记录",
        })
    # 未判读不是阻断理由（未核 ≠ 缺失），但必须逐条披露，交付侧按这个清单对账。
    disclosures = [
        {
            "relativePath": item["relativePath"],
            "verdict": item["verdict"],
            "reasonCode": item["reasonCode"],
            "pending": item["pending"],
            "requiredAction": _action_for(item["reasonCode"]),
        }
        for item in entries if item["verdict"] in (VERDICT_PENDING, VERDICT_SKIPPED)
    ]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": _now(),
        "indexDigest": ocr_runtime.canonical_digest(index),
        "budget": budget,
        "sources": entries,
        "totals": totals,
        "gate": {
            "status": "blocked" if blocks else "pass",
            "blocks": blocks,
            "disclosures": disclosures,
        },
    }


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build(case_dir: str, max_visual_pages: int = DEFAULT_MAX_VISUAL_PAGES) -> dict:
    """读盘 → 折算 → 写 `ocr/coverage.json`。没有 OCR 目录时产出 `not-required` 快照。"""
    case = os.path.abspath(case_dir)
    path = index_path(case)
    if not os.path.isfile(path):
        return {
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": _now(),
            "status": "not-required",
            "indexDigest": "",
            "budget": {"maxVisualPages": int(max_visual_pages), "used": 0, "exceeded": False},
            "sources": [],
            "totals": {"required": 0, "recognized": 0, "unreadable": 0, "pending": 0,
                       "sourcesComplete": 0, "sourcesPartial": 0,
                       "sourcesPending": 0, "sourcesSkippedBudget": 0},
            "gate": {"status": "pass", "blocks": [], "disclosures": []},
        }
    index = ocr_runtime.read_json(path) or {}
    if not isinstance(index, dict):
        raise ValueError("ocr/index.json 不是对象：%s" % path)
    coverage = compute(index, case, max_visual_pages)
    coverage["status"] = "computed"
    return coverage


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="OCR 覆盖率快照：把 index.json 与识别记录折算成逐来源 verdict")
    parser.add_argument("--case", required=True, help="案例目录（脚本写 <案例>/ocr/coverage.json）")
    parser.add_argument("--max-visual-pages", type=int, default=DEFAULT_MAX_VISUAL_PAGES,
                        help="视觉判读页数上限（默认 %d，超过即整批拒绝）" % DEFAULT_MAX_VISUAL_PAGES)
    args = parser.parse_args(argv)

    case = os.path.abspath(args.case)
    if not os.path.isdir(case):
        ocr_runtime.emit(ocr_runtime.fail("input", "案例目录不存在：%s" % case))
        return ocr_runtime.EXIT_USAGE
    if args.max_visual_pages <= 0:
        ocr_runtime.emit(ocr_runtime.fail("input", "--max-visual-pages 必须是正整数"))
        return ocr_runtime.EXIT_USAGE

    try:
        coverage = build(case, args.max_visual_pages)
    except ValueError as error:
        ocr_runtime.emit(ocr_runtime.fail("input", str(error)))
        return ocr_runtime.EXIT_USAGE

    out = coverage_path(case)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ocr_runtime.write_json_atomic(out, coverage)
    ocr_runtime.emit({
        "ok": True,
        "errorKind": "",
        "coveragePath": ocr_runtime.relpath(case, out),
        "status": coverage["status"],
        "indexDigest": coverage["indexDigest"],
        "totals": coverage["totals"],
        "gate": coverage["gate"]["status"],
        "blocks": coverage["gate"]["blocks"],
        "disclosures": coverage["gate"]["disclosures"],
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
