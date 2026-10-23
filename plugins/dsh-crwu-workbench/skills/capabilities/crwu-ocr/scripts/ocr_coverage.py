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
# 本地审核的一次性交接清单：它的存在是本轮属于**本地审核**的稳定事实，
# 不是模型能提交的参数。本地审核的产物不回传，交付口径是"带未核、如实披露"。
LOCAL_AUDIT_MARKER = "本地审核清单.json"

POLICY_STRICT = "strict"
POLICY_DISCLOSE = "disclose"


def resolve_pending_policy(case_dir: str, requested: str = "auto"):
    """返回 `(policy, reason)`：托管审核严格阻断，本地审核只披露。

    契约：**能不能交付**由"这是什么审核"决定，不由模型声明决定。
    所以 `auto` 只看案例里有没有本地审核交接清单；`--pending-policy` 只留给
    维护与测试，不进审核提示词。
    """
    if requested in (POLICY_STRICT, POLICY_DISCLOSE):
        return requested, "explicit"
    if os.path.isfile(os.path.join(case_dir, LOCAL_AUDIT_MARKER)):
        return POLICY_DISCLOSE, "local-audit"
    return POLICY_STRICT, "managed"


def ocr_dir(case_dir: str) -> str:
    return os.path.join(case_dir, "ocr")


def index_path(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), "index.json")


def coverage_path(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), "coverage.json")


def recognition_dir(case_dir: str) -> str:
    return os.path.join(ocr_dir(case_dir), "recognition")


def load_recorded_statuses(case_dir: str) -> dict:
    """`sourceId -> {页号: 状态}`，取自 `ocr/recognition/*.json`（已判读的**事实源**）。

    为什么需要它：`ocr_record.py` 把状态写回 `ocr/index.json` 是"读整个索引 → 改几页 →
    整份写回"。两个子代理并行记录**不同来源**时，后写的会覆盖前一个写回的 `recognitionStatus`
    —— 记录文件逐来源独立、原子写，不受这个竞态影响。只按 index 折算会把"其实读完了"
    判成 `pending`，进而阻断交付、逼调用方重读。

    记录里的状态字段是 `recognitionStatus`，旧记录只有 `status`，两个都认。
    """
    out = {}
    if not case_dir:
        return out
    directory = recognition_dir(case_dir)
    if not os.path.isdir(directory):
        return out
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        record = ocr_runtime.read_json(os.path.join(directory, name)) or {}
        if not isinstance(record, dict):
            continue
        source_id = str(record.get("sourceId") or "")
        if source_id == "":
            continue
        pages = {}
        for page in record.get("pages") or []:
            if not isinstance(page, dict):
                continue
            status = str(page.get("recognitionStatus") or page.get("status") or "")
            if not status:
                continue
            # 连页图指纹一起带上：页图被重渲过（`--re-render`）时，旧记录不能算"已判读"。
            pages[page.get("page")] = {"status": status,
                                       "imageSha256": str(page.get("imageSha256") or "")}
        if pages:
            out[source_id] = pages
    return out


def page_state(page: dict, recorded: dict = None) -> str:
    """单页状态：`recognized` / `unreadable` / `pending` / `not-required`。

    判据优先看**记录**写回 index 的事实（`recognitionStatus` / `visualStatus`）；
    index 说 `pending` 而记录文件里有状态时以记录为准（并发写回会丢 index 的更新，
    见 `load_recorded_statuses`）。
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
    fallback = (recorded or {}).get(page.get("page")) or {}
    if isinstance(fallback, dict):
        page_sha = str(page.get("imageSha256") or "")
        record_sha = str(fallback.get("imageSha256") or "")
        # 记录绑的页图与当前页图不一致 ⇒ 记录已过期，不能当作"已判读"。
        if record_sha and page_sha and record_sha != page_sha:
            return "pending"
        state = str(fallback.get("status") or "")
        if state == "unreadable":
            return "unreadable"
        if state in RECOGNIZED_STATUSES:
            return "recognized"
    return "pending"


def source_entry(source: dict, recorded: dict = None) -> dict:
    """一份来源的逐页折算结果。"""
    counts = {"required": 0, "recognized": 0, "unreadable": 0, "pending": 0}
    pending_pages = []
    for page in source.get("pages") or []:
        if not isinstance(page, dict):
            continue
        state = page_state(page, recorded)
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
    if verdict == VERDICT_SKIPPED:
        # 整批拒绝的来源不是"待判读"：页数已由拒绝声明承担，不再计入 pending 预算，
        # 否则"还有待判读页就阻断"会把被明确拒绝的页重复罚一次。
        counts["pending"] = 0
        pending_pages = []
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


def _inventory_entries(case_dir: str) -> list:
    """`材料盘点.json.ocrRequired[]` 的逐条事实（路径 + 页数）。

    盘点是"本轮必须判读哪些文件"的唯一来源。**从未进过 `ocr_prepare` 的来源不在
    `ocr/index.json` 里**，只按索引算比例会得到 0% —— 2026-10-22 事故里 1171 页扫描件
    正是这样从分母里消失的（不 prepare 就没有 pending，比值永远漂亮）。
    """
    data = ocr_runtime.read_json(os.path.join(case_dir, INVENTORY_FILE), {}) or {}
    out = []
    if not isinstance(data, dict):
        return out
    for item in data.get("ocrRequired") or []:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        try:
            pages = int(item.get("pageCount") or 0)
        except (TypeError, ValueError):
            pages = 0
        out.append({"relativePath": _norm_rel(item["path"]), "pages": max(0, pages),
                    "kind": str(item.get("kind") or "")})
    return out


def _inventory_page_counts(case_dir: str) -> dict:
    """`ocrRequired[]` → {归一化路径: pageCount}。

    拒绝条目的页数**只认盘点**：模型声明的 `pages` 是它可以随手写的数字，
    拿它判"批次是否超预算"等于把放行开关交给被约束的一方
    （2026-10-23 实测：1086 页的件声明 6000 页，门禁直接 pass）。
    """
    return {item["relativePath"]: item["pages"] for item in _inventory_entries(case_dir)}


def _load_refusals(case_dir: str, index: dict, required_total: int,
                   max_visual_pages: int):
    """读 `ocr/refusal.json`，返回 `(honoured, problems)`。

    拒绝只在**批次确实超预算**时生效：否则模型可以拿它绕开"必须读完"。
    不在索引里的来源，页数**必须与 `材料盘点.json` 的 `pageCount` 一致**；
    声明值与盘点不符即阻断（虚报是最省力的绕过方式）。
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
    inventory = _inventory_page_counts(case_dir)
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
            inventory_pages = int(inventory.get(rel) or 0)
            if inventory_pages <= 0:
                problems.append({"kind": "refusal-pages-missing", "relativePath": rel,
                                 "reason": "盘点里没有该件的真实页数：先补跑 prepare_materials.py"
                                           "（旧盘点缺 pypdf 时 pageCount 为 0），不得自行声明页数"})
                continue
            declared = int(raw.get("pages") or 0)
            if declared and declared != inventory_pages:
                problems.append({"kind": "refusal-pages-mismatch", "relativePath": rel,
                                 "declaredPages": declared, "inventoryPages": inventory_pages,
                                 "reason": "拒绝声明的页数与材料盘点不一致：页数以盘点为准，"
                                           "虚报以触发整批拒绝会被阻断"})
                continue
            pages = inventory_pages
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


def compute(index: dict, case_dir: str, max_visual_pages: int = DEFAULT_MAX_VISUAL_PAGES,
            pending_policy: str = POLICY_STRICT) -> dict:
    """折算入口。

    `index` 是已读取的 `ocr/index.json`；`case_dir` 用于读四样东西：
    `ocr/recognition/`（过期记录）、`ocr/refusal.json`（整批拒绝）、
    `材料盘点.json`（可拒绝的范围，以及**没进索引的必判读页**）。
    所以本函数**不是**纯函数 —— 它同一个 `index` 在不同案例状态下可以得出不同结论。

    阻断口径（2026-10-23 收紧）：
    **只要本轮还有待判读页就阻断交付**——5000 页以内必须读完全部必判读页，读完或把
    读不出的页登记 `unreadable` 才放行。分母包含"从未进过 `ocr_prepare` 的盘点件"，
    不 prepare 不会让结论变好，只会换成 `index-missing` / `inventory-page-count-missing`。
    唯一的放行通道是异常量级（> `max_visual_pages`）下的整批拒绝 `ocr/refusal.json`。
    """
    recorded = load_recorded_statuses(case_dir)
    entries = [source_entry(source, recorded.get(str(source.get("sourceId") or "")))
               for source in index.get("sources") or [] if isinstance(source, dict)]
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

    # 盘点里"要求 OCR 但从未进索引"的来源：它们同样是本轮待判读页，必须进分母。
    # 直接合成逐来源条目（verdict=pending），这样它们会出现在 disclosures 里，
    # 模型读 coverage.json 就能看到"哪些件还没开始读"，而不是只从交付门禁的报错里反推。
    unprepared = []
    unprepared_problems = []
    for item in _inventory_entries(case_dir):
        rel = item["relativePath"]
        if not rel or rel in by_rel:
            continue
        if item["pages"] <= 0:
            unprepared_problems.append({
                "kind": "inventory-page-count-missing",
                "relativePath": rel,
                "requiredAction": "该件在盘点里没有真实页数（旧盘点缺 pypdf）："
                                  "补跑 prepare_materials.py 后重跑 ocr_coverage.py",
            })
            continue
        unprepared.append(item)
        entry = {
            "sourceId": "", "relativePath": rel, "kind": item["kind"],
            "pageCount": item["pages"], "required": item["pages"],
            "recognized": 0, "unreadable": 0, "pending": item["pages"],
            "verdict": VERDICT_PENDING, "reasonCode": "pages-pending",
            "pendingPages": list(range(1, min(item["pages"], 50) + 1)),
        }
        if item["pages"] > 50:
            entry["pendingPagesTruncated"] = True
        entries.append(entry)
        by_rel[rel] = entry
    unprepared_pages = sum(item["pages"] for item in unprepared)

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
        # 已读到内容但还没读完的来源：只用于汇报，阻断由"还有待判读页"统一负责。
        "sourcesPartialRead": sum(1 for item in entries
                                  if item["recognized"] > 0 and item["pending"] > 0),
    }
    # 未进索引的盘点件已合成进 entries，所以 totals 本身就是"含未开始读的件"的口径。
    pending_eff = totals["pending"]
    required_eff = totals["required"]
    ratio = (pending_eff / required_eff) if required_eff else 0.0
    # 预算量的是"本轮还要读多少页"：全部读完的 5001 页不该被阻断，被拒绝的页也不该算进去。
    budget = {
        "maxVisualPages": int(max_visual_pages),
        "used": pending_eff,
        "requiredPages": totals["required"],
        "requiredPagesIncludingUnprepared": required_eff,
        "exceeded": pending_eff > int(max_visual_pages),
        # 只作汇报，不是判据：判据是"有没有待判读页"。
        "pendingRatio": round(ratio, 4),
        "pendingPages": pending_eff,
        "unpreparedSources": len(unprepared),
        "unpreparedPages": unprepared_pages,
    }
    blocks = []
    if budget["exceeded"]:
        blocks.append({
            "kind": "budget-exceeded",
            "pendingPages": pending_eff,
            "maxVisualPages": budget["maxVisualPages"],
            "requiredAction": "分批送审或提供文本版，不要把「页多」写成「材料缺失」；"
                              "确属整批拒绝时写 ocr/refusal.json",
        })
    # 5000 页以内**必须读完**：只要还有一页待判读就阻断，没有比例容忍。
    if pending_eff > 0:
        unfinished = [
            {
                "relativePath": item["relativePath"],
                "verdict": item["verdict"],
                "recognized": item["recognized"],
                "pending": item["pending"],
                "pendingPages": (item.get("pendingPages") or [])[:20],
            }
            for item in entries if item["pending"] > 0
        ]
        blocks.append({
            "kind": "pending-pages",
            "pendingPages": pending_eff,
            "requiredPages": required_eff,
            "sources": unfinished[:20],
            "sourcesTruncated": len(unfinished) > 20,
            "requiredAction": "5000 页以内必须读完：把剩余页逐页判读并 ocr_record 落盘，"
                              "读不出的页登记 unreadable；读完再重跑 ocr_coverage.py。"
                              "只有必须判读页数 > 5000（异常量级）才允许写 ocr/refusal.json 整批拒绝",
        })
    blocks.extend(unprepared_problems)
    blocks.extend(refusal_problems)
    for item in _stale_records(case_dir, index):
        blocks.append({
            "kind": "stale-recognition",
            "relativePath": item["relativePath"],
            "reason": item["reason"],
            "requiredAction": "重跑 ocr_prepare 让索引覆盖这些页，或作废对应识别记录",
        })
    # 每个未判读来源都要逐条披露（员工动作按 reasonCode 给），交付侧按这个清单对账。
    # 注意：能否交付是另一回事 —— "还有待判读页"已经在上面进了 blocks。
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
        "gate": _gate(pending_policy, blocks, disclosures),
    }


# 只有"还没读完"这一类的阻断可以被本地审核降级为披露；数据完整性问题照旧阻断。
ADVISORY_BLOCK_KINDS = ("pending-pages", "budget-exceeded", "index-missing")


def _gate(policy: str, blocks: list, disclosures: list) -> dict:
    """严格视图与生效视图分开：`blocks` 永远是事实，`effectiveStatus` 才决定能不能交付。

    `disclose`（本地审核）：**只有"未读完"这一类**不阻断交付，但要进 `warnings` 与
    `disclosures`，交付件必须逐条写明；`refusal-*`、`stale-recognition`、
    `inventory-page-count-missing` 这类**数据完整性**问题在两种 policy 下都阻断——
    本地审核允许"没读"，不允许"说假话/用过期记录"。
    """
    strict = POLICY_DISCLOSE if policy == POLICY_DISCLOSE else POLICY_STRICT
    status = "blocked" if blocks else "pass"
    advisory, blocking = [], []
    for block in blocks:
        kind = str(block.get("kind") or "") if isinstance(block, dict) else ""
        (advisory if kind in ADVISORY_BLOCK_KINDS else blocking).append(block)
    effective = status
    if strict == POLICY_DISCLOSE and not blocking:
        effective = "pass"
    return {
        "policy": strict,
        "status": status,
        "effectiveStatus": effective,
        "blocks": blocks,
        "warnings": advisory if strict == POLICY_DISCLOSE else [],
        "disclosures": disclosures,
    }


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty_totals() -> dict:
    return {"required": 0, "recognized": 0, "unreadable": 0, "pending": 0,
            "skippedPages": 0, "sourcesComplete": 0, "sourcesPartial": 0,
            "sourcesPending": 0, "sourcesSkippedBudget": 0, "sourcesPartialRead": 0}


def build(case_dir: str, max_visual_pages: int = DEFAULT_MAX_VISUAL_PAGES,
          pending_policy: str = POLICY_STRICT) -> dict:
    """读盘 → 折算 → 写 `ocr/coverage.json`。

    没有 OCR 目录时：盘点里也没有 `ocrRequired[]` 才是 `not-required`（真的不需要判读）；
    盘点要求 OCR 却没有索引，是**未完成**，必须阻断并指向 `ocr_prepare.py`，
    不能产出一份自称 `pass` 的快照让交付侧误以为没事（2026-10-23 复查发现）。
    """
    case = os.path.abspath(case_dir)
    path = index_path(case)
    if not os.path.isfile(path):
        inventory = _inventory_entries(case)
        if inventory:
            inventory_pages = sum(i["pages"] for i in inventory)
            totals = _empty_totals()
            totals.update({"required": inventory_pages, "pending": inventory_pages,
                           "sourcesPending": len(inventory)})
            return {
                "schemaVersion": SCHEMA_VERSION,
                "generatedAt": _now(),
                "status": "index-missing",
                "indexDigest": "",
                "budget": {"maxVisualPages": int(max_visual_pages), "used": inventory_pages,
                           "requiredPages": inventory_pages,
                           "requiredPagesIncludingUnprepared": inventory_pages,
                           "exceeded": inventory_pages > int(max_visual_pages),
                           "pendingRatio": 1.0,
                           "pendingPages": inventory_pages,
                           "unpreparedSources": len(inventory),
                           "unpreparedPages": inventory_pages},
                "sources": [],
                "totals": totals,
                "gate": _gate(pending_policy, [{
                        "kind": "index-missing",
                        "inventorySources": len(inventory),
                        "requiredAction": "材料盘点里有 %d 件要求 OCR，但 ocr/index.json 不存在："
                                          "先跑 ocr_prepare.py --only <清单路径> 再重跑本脚本"
                                          % len(inventory),
                    }], [
                        {"relativePath": item["relativePath"],
                         "verdict": VERDICT_PENDING, "reasonCode": "pages-pending",
                         "pending": item["pages"],
                         "requiredAction": _action_for("pages-pending")}
                        for item in inventory
                    ]),
            }
        return {
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": _now(),
            "status": "not-required",
            "indexDigest": "",
            "budget": {"maxVisualPages": int(max_visual_pages), "used": 0, "exceeded": False,
                       "pendingRatio": 0.0, "pendingPages": 0,
                       "requiredPagesIncludingUnprepared": 0,
                       "unpreparedSources": 0, "unpreparedPages": 0},
            "sources": [],
            "totals": _empty_totals(),
            "gate": _gate(pending_policy, [], []),
        }
    index = ocr_runtime.read_json(path) or {}
    if not isinstance(index, dict):
        raise ValueError("ocr/index.json 不是对象：%s" % path)
    coverage = compute(index, case, max_visual_pages, pending_policy)
    coverage["status"] = "computed"
    return coverage


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="OCR 覆盖率快照：把 index.json 与识别记录折算成逐来源 verdict")
    parser.add_argument("--case", required=True, help="案例目录（脚本写 <案例>/ocr/coverage.json）")
    parser.add_argument("--max-visual-pages", type=int, default=DEFAULT_MAX_VISUAL_PAGES,
                        help="视觉判读页数上限（默认 %d，超过即整批拒绝）" % DEFAULT_MAX_VISUAL_PAGES)
    parser.add_argument("--pending-policy", choices=("auto", POLICY_STRICT, POLICY_DISCLOSE),
                        default="auto",
                        help="待判读页是否阻断交付：auto（本地审核只披露、托管审核阻断）"
                             "／strict／disclose；审核提示词不提交这个参数")
    args = parser.parse_args(argv)

    case = os.path.abspath(args.case)
    if not os.path.isdir(case):
        ocr_runtime.emit(ocr_runtime.fail("input", "案例目录不存在：%s" % case))
        return ocr_runtime.EXIT_USAGE
    if args.max_visual_pages <= 0:
        ocr_runtime.emit(ocr_runtime.fail("input", "--max-visual-pages 必须是正整数"))
        return ocr_runtime.EXIT_USAGE

    try:
        policy, policy_reason = resolve_pending_policy(case, args.pending_policy)
        coverage = build(case, args.max_visual_pages, policy)
    except ValueError as error:
        ocr_runtime.emit(ocr_runtime.fail("input", str(error)))
        return ocr_runtime.EXIT_USAGE

    coverage["gate"]["policyReason"] = policy_reason
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
        "effectiveStatus": coverage["gate"]["effectiveStatus"],
        "policy": coverage["gate"]["policy"],
        "policyReason": coverage["gate"].get("policyReason", ""),
        "blocks": coverage["gate"]["blocks"],
        "disclosures": coverage["gate"]["disclosures"],
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
