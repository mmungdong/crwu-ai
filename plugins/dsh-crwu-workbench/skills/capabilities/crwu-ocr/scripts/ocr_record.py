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
    return ""


def minimal_record(entry) -> dict:
    record = {
        "page": entry["page"],
        "status": entry["status"],
        "orientation": entry.get("orientation", "unknown"),
        "text": entry.get("text", ""),
        "tables": entry.get("tables", []),
        "visibleElements": entry.get("visibleElements", []),
        "uncertainties": entry.get("uncertainties", []),
    }
    if entry.get("note"):
        record["note"] = str(entry["note"])
    return record


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
    parser = argparse.ArgumentParser(description="Merge page-image recognition into the OCR index")
    parser.add_argument("--case", required=True)
    parser.add_argument("--input", required=True, help="case-relative JSON with the page results")
    parser.add_argument("--source", default="", help="sourceId or case-relative path")
    args = parser.parse_args(argv)

    case_dir = os.path.abspath(args.case)
    index, index_path, error = load_index(case_dir)
    if index is None:
        ocr_runtime.emit(ocr_runtime.fail("input", error))
        return ocr_runtime.EXIT_USAGE

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
        checked.append(record)

    recognition_path = os.path.join(case_dir, "ocr", "recognition", source["sourceId"] + ".json")
    previous = ocr_runtime.read_json(recognition_path, {}) or {}
    merged = {page.get("page"): page for page in previous.get("pages", []) if isinstance(page, dict)}
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

    status_by_page = {record["page"]: record["status"] for record in checked}
    for page in source.get("pages", []):
        page_no = page.get("page")
        if page_no in status_by_page:
            page["visualStatus"] = "unreadable" if status_by_page[page_no] == "unreadable" else "done"
            page["recognitionStatus"] = status_by_page[page_no]

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
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
