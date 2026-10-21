#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Merge image-reading results into the OCR index.

The model reads indexed page images through DSH image reading and writes back
what it can actually see. This script binds every result to the exact page
image (sha256) so a re-rendered page can never inherit an older recognition,
and it refuses page numbers the index does not contain.
"""
from __future__ import annotations

import argparse
import datetime
import os
import sys

import ocr_runtime

STATUSES = ("recognized", "partial", "unreadable")
ORIENTATIONS = ("normal", "rotated-90", "rotated-180", "rotated-270", "unknown")


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_index(case_dir: str):
    index_path = os.path.join(case_dir, "ocr", "index.json")
    index = ocr_runtime.read_json(index_path)
    if not isinstance(index, dict) or not isinstance(index.get("sources"), list):
        return None, index_path, "ocr/index.json 不存在或不可读：先运行 ocr_prepare.py"
    return index, index_path, ""


def find_source(index, source_id: str, relative_path: str):
    for source in index.get("sources", []):
        if not isinstance(source, dict):
            continue
        if source_id and source.get("sourceId") == source_id:
            return source
        if relative_path and source.get("relativePath") == relative_path:
            return source
    return None


def normalise_pages(payload) -> list:
    if isinstance(payload, dict) and isinstance(payload.get("pages"), list):
        return payload["pages"]
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and "page" in payload:
        return [payload]
    return []


def validate_key_values(entry, text: str) -> str:
    """Every key value must point at a verbatim fragment of this page's own text."""
    page = entry.get("page")
    values = entry.get("keyValues")
    if values is None:
        return ""
    if not isinstance(values, list):
        return "第 %s 页 keyValues 必须是数组" % page
    for index, item in enumerate(values):
        if not isinstance(item, dict):
            return "第 %s 页 keyValues[%d] 必须是对象" % (page, index)
        for field in ("label", "value", "quote"):
            if not isinstance(item.get(field), str) or item.get(field).strip() == "":
                return "第 %s 页 keyValues[%d].%s 必须是非空字符串" % (page, index, field)
        if not ocr_runtime.quote_in_text(text, item["quote"]):
            return ("第 %s 页 keyValues[%d] quote-not-found：quote 不是本页 text 的逐字片段"
                    % (page, index))
        if not ocr_runtime.value_in_quote(item["value"], item["quote"]):
            return ("第 %s 页 keyValues[%d] value-not-in-quote：value 未在 quote 中出现"
                    % (page, index))
    return ""


def validate_page(entry) -> str:
    if not isinstance(entry, dict):
        return "识别记录不是对象"
    page = entry.get("page")
    if not isinstance(page, int) or page < 1:
        return "page 必须是正整数"
    if entry.get("status") not in STATUSES:
        return "第 %s 页 status 必须是 %s" % (page, "/".join(STATUSES))
    for field in ("text", "excerpt"):
        if field in entry and not isinstance(entry[field], str):
            return "第 %s 页 %s 必须是字符串" % (page, field)
    for field in ("tables", "visibleElements", "uncertainties"):
        if field in entry and not isinstance(entry[field], list):
            return "第 %s 页 %s 必须是数组" % (page, field)
    orientation = entry.get("orientation", "unknown")
    if orientation not in ORIENTATIONS:
        return "第 %s 页 orientation 必须是 %s" % (page, "/".join(ORIENTATIONS))
    return validate_key_values(entry, entry.get("text", ""))


def minimal_record(entry) -> dict:
    record = {
        "page": entry["page"],
        "status": entry["status"],
        "orientation": entry.get("orientation", "unknown"),
        "text": entry.get("text", ""),
        "tables": entry.get("tables", []),
        "visibleElements": entry.get("visibleElements", []),
        "uncertainties": entry.get("uncertainties", []),
        "keyValues": entry.get("keyValues", []),
    }
    if entry.get("note"):
        record["note"] = str(entry["note"])
    return record


def merge_conflicts(previous_page, record) -> list:
    """Keep every disagreement between reads; never pick one value for the reader."""
    conflicts = list((previous_page or {}).get("conflicts") or [])
    prior = {item.get("label"): item.get("value")
             for item in (previous_page or {}).get("keyValues") or [] if isinstance(item, dict)}
    current = {item.get("label"): item.get("value")
               for item in record.get("keyValues") or [] if isinstance(item, dict)}
    if not (previous_page or {}).get("reads"):
        # First read of this page: nothing to disagree with yet.
        return conflicts
    prior_read = max(1, len((previous_page or {}).get("reads") or []))
    current_read = max(1, len(record.get("reads") or []))
    for label in sorted(set(prior) | set(current)):
        if label not in prior or label not in current:
            values = [prior.get(label), current.get(label)]
        elif ocr_runtime.normalize_value(str(prior[label])) == ocr_runtime.normalize_value(str(current[label])):
            continue
        else:
            values = [prior[label], current[label]]
        conflict = {"field": label, "values": values, "reads": [prior_read, current_read]}
        if conflict not in conflicts:
            conflicts.append(conflict)
    return conflicts


ESCALATION_PRIORITY = {"table": 0, "keyValues": 1, "uncertainty": 2}


def escalate_for(page, record, index):
    """Return one prioritized second-pass candidate, or None when it already had two reads."""
    if record.get("recognitionStatus") != "recognized":
        return None
    if len(page.get("renders") or []) >= 2:
        return None
    rows = 0
    for table in record.get("tables") or []:
        if isinstance(table, dict):
            rows = max(rows, len(table.get("rows") or []))
    if rows >= 10:
        return {"page": page.get("page"), "mode": "tile", "priority": "table"}
    values = len(record.get("keyValues") or [])
    keywords = ("小字", "模糊", "折痕", "遮挡", "反光")
    uncertain = any(word in str(item) for item in record.get("uncertainties") or []
                    for word in keywords)
    if values >= 3:
        return {"page": page.get("page"), "mode": "dpi-retry", "priority": "keyValues"}
    if uncertain:
        return {"page": page.get("page"), "mode": "dpi-retry", "priority": "uncertainty"}
    return None


def select_escalations(candidates, remaining: int) -> list:
    """Order by evidence class (table > keyValues > uncertainty), then page, and cap."""
    ordered = sorted(candidates,
                     key=lambda item: (ESCALATION_PRIORITY.get(item.get("priority"), 99),
                                       int(item.get("page") or 0)))
    return ordered[:max(0, int(remaining))]


def recompute(index) -> dict:
    coverage = {
        "sources": len(index.get("sources", [])),
        "pages": 0,
        "pagesWithText": 0,
        "pagesWithoutText": 0,
        "pagesVisualRequired": 0,
        "pagesRecognized": 0,
        "pagesUnreadable": 0,
        "pagesPending": 0,
    }
    for source in index.get("sources", []):
        for page in source.get("pages", []):
            coverage["pages"] += 1
            if page.get("textStatus") == "ok":
                coverage["pagesWithText"] += 1
            else:
                coverage["pagesWithoutText"] += 1
            if page.get("visualRequired"):
                coverage["pagesVisualRequired"] += 1
            status = page.get("visualStatus")
            if status == "done":
                coverage["pagesRecognized"] += 1
            elif status == "unreadable":
                coverage["pagesUnreadable"] += 1
            elif status == "pending":
                coverage["pagesPending"] += 1
    index["coverage"] = coverage
    return coverage


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False, description="Merge page-image recognition into the OCR index")
    parser.add_argument("--case", required=True)
    parser.add_argument("--input", default="", help="case-relative JSON with the page results")
    parser.add_argument("--source", default="", help="sourceId or case-relative path")
    parser.add_argument("--recognizer", default="session-vision",
                        help="recognizer identity written into the record (not model-supplied)")
    parser.add_argument("--vision-unavailable", action="store_true",
                        help="mark every pending page as not readable by the host; no --input needed")
    args = parser.parse_args(argv)
    recognizer = args.recognizer.strip() or "session-vision"
    if recognizer != "session-vision":
        ocr_runtime.emit(ocr_runtime.fail(
            "input", "--recognizer 本期只接受 session-vision：专用识别引擎接入后再开放"))
        return ocr_runtime.EXIT_USAGE

    case_dir = os.path.abspath(args.case)
    staged_problem = ocr_runtime.staged_case_problem(case_dir, __file__)
    if staged_problem:
        ocr_runtime.emit(ocr_runtime.fail("input", staged_problem))
        return ocr_runtime.EXIT_USAGE
    index, index_path, error = load_index(case_dir)
    if index is None:
        ocr_runtime.emit(ocr_runtime.fail("input", error))
        return ocr_runtime.EXIT_USAGE

    if args.vision_unavailable:
        marked = []
        for item in index.get("sources", []):
            for page in item.get("pages", []):
                page.setdefault("pendingReason", "")
                if page.get("visualStatus") == "pending":
                    page["pendingReason"] = "vision-unavailable"
                    marked.append({"sourceId": item.get("sourceId", ""),
                                   "relativePath": item.get("relativePath", ""),
                                   "page": page.get("page")})
        index["recognitionUpdatedAt"] = now()
        ocr_runtime.write_json_atomic(index_path, index)
        ocr_runtime.emit({**ocr_runtime.fail(
            "capability-gap",
            "宿主无法读取页图：%d 页已标记为未判读，请人工补读或登记未核" % len(marked),
            action="换用具备图片判读能力的会话，或让员工按页图人工核对后登记未核"),
            "marked": marked})
        return ocr_runtime.EXIT_CAPABILITY_GAP

    raw = args.input.strip()
    if raw == "" or os.path.isabs(raw) or ".." in raw.replace("\\", "/").split("/"):
        ocr_runtime.emit(ocr_runtime.fail("input", "--input 必须是案例目录内的相对路径"))
        return ocr_runtime.EXIT_USAGE
    input_path = ocr_runtime.safe_join(case_dir, raw)
    payload = ocr_runtime.read_json(input_path)
    if payload is None:
        ocr_runtime.emit(ocr_runtime.fail("input", "识别结果读不出来：%s" % raw))
        return ocr_runtime.EXIT_USAGE

    declared_source = payload.get("sourceId", "") if isinstance(payload, dict) else ""
    selector = args.source or declared_source
    source = find_source(index, selector, selector) if selector else None
    if source is None and len(index.get("sources", [])) == 1:
        source = index["sources"][0]
    if source is None:
        ocr_runtime.emit(ocr_runtime.fail("input", "无法确定识别结果属于哪一份来源：请给出 --source（sourceId 或相对路径）"))
        return ocr_runtime.EXIT_USAGE

    pages = {page["page"]: page for page in source.get("pages", []) if isinstance(page, dict)}
    recognition_path = os.path.join(case_dir, "ocr", "recognition", source["sourceId"] + ".json")
    previous = ocr_runtime.read_json(recognition_path, {}) or {}
    merged = {page.get("page"): page for page in previous.get("pages", []) if isinstance(page, dict)}
    entries = normalise_pages(payload)
    if not entries:
        ocr_runtime.emit(ocr_runtime.fail("input", "识别结果里没有 pages"))
        return ocr_runtime.EXIT_USAGE

    checked = []
    for entry in entries:
        problem = validate_page(entry)
        if problem:
            ocr_runtime.emit(ocr_runtime.fail("input", problem))
            return ocr_runtime.EXIT_USAGE
        page_no = entry["page"]
        target = pages.get(page_no)
        if target is None:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "第 %s 页不在索引里（该来源共 %s 页）" % (page_no, source.get("pageCount"))))
            return ocr_runtime.EXIT_USAGE
        claimed = entry.get("imageSha256")
        actual = target.get("imageSha256", "")
        if claimed and claimed != actual:
            ocr_runtime.emit(ocr_runtime.fail(
                "stale", "第 %s 页的图已经重新渲染（记录的 imageSha256 与索引不一致），请重新读取该页后再记录" % page_no))
            return ocr_runtime.EXIT_USAGE
        if actual == "" and entry["status"] != "unreadable":
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "第 %s 页没有可用页面图，只能记为 unreadable" % page_no))
            return ocr_runtime.EXIT_USAGE
        record = minimal_record(entry)
        record["imageSha256"] = actual
        record["inputPath"] = raw
        record["recordedAt"] = now()
        prior = merged.get(page_no) or {}
        reads = list(prior.get("reads") or [])
        reads.append({"n": len(reads) + 1,
                      "renderN": len(target.get("renders") or []) or 1,
                      "status": entry["status"],
                      "recordedAt": record["recordedAt"]})
        record["reads"] = reads
        record["recognizer"] = recognizer
        record["conflicts"] = merge_conflicts(prior, record)
        record["recognitionStatus"] = "conflict" if record["conflicts"] else entry["status"]
        checked.append(record)

    for record in checked:
        merged[record["page"]] = record
    recognition = {
        "schemaVersion": ocr_runtime.SCHEMA_VERSION,
        "sourceId": source["sourceId"],
        "relativePath": source["relativePath"],
        "updatedAt": now(),
        "pages": [merged[key] for key in sorted(merged)],
    }
    ocr_runtime.write_json_atomic(recognition_path, recognition)

    status_by_page = {record["page"]: record["recognitionStatus"] for record in checked}
    for page in source.get("pages", []):
        page_no = page.get("page")
        if page_no in status_by_page:
            status = status_by_page[page_no]
            page["visualStatus"] = "unreadable" if status == "unreadable" else "done"
            page["recognitionStatus"] = status
            page["pendingReason"] = ""

    budget = index.get("budget") or {}
    remaining = max(0, int(budget.get("maxDoubleReads") or 0) - int(budget.get("doubleReads") or 0))
    candidates = []
    for record in checked:
        page = pages.get(record["page"])
        if page is not None:
            item = escalate_for(page, record, index)
            if item is not None:
                candidates.append(item)
    escalate = select_escalations(candidates, remaining)

    coverage = recompute(index)
    index["generatedAt"] = index.get("generatedAt") or now()
    index["recognitionUpdatedAt"] = now()
    ocr_runtime.write_json_atomic(index_path, index)

    pending = [
        {"sourceId": item["sourceId"], "relativePath": item["relativePath"],
         "pages": [page["page"] for page in item.get("pages", []) if page.get("visualStatus") == "pending"]}
        for item in index.get("sources", [])
    ]
    pending = [item for item in pending if item["pages"]]
    ocr_runtime.emit({
        "ok": True,
        "errorKind": "",
        "sourceId": source["sourceId"],
        "recordedPages": sorted(status_by_page),
        "recognitionPath": ocr_runtime.relpath(case_dir, recognition_path),
        "coverage": coverage,
        "pending": pending,
        "escalate": escalate,
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
