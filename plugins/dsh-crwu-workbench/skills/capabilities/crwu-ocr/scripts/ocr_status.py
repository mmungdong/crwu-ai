#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Report OCR coverage: what is prepared, what still needs image reading, what is unreadable."""
from __future__ import annotations

import argparse
import os
import sys

import ocr_runtime


def load_conflicts(case_dir: str) -> list:
    """Collect per-page conflicts straight from the recognition records."""
    directory = os.path.join(case_dir, "ocr", "recognition")
    conflicts = []
    if not os.path.isdir(directory):
        return conflicts
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        record = ocr_runtime.read_json(os.path.join(directory, name)) or {}
        if not isinstance(record, dict):
            continue
        for page in record.get("pages") or []:
            if not isinstance(page, dict) or not page.get("conflicts"):
                continue
            fields = sorted({str(item.get("field")) for item in page["conflicts"]
                             if isinstance(item, dict) and item.get("field")})
            conflicts.append({
                "sourceId": record.get("sourceId", ""),
                "relativePath": record.get("relativePath", ""),
                "page": page.get("page"),
                "fields": fields,
            })
    return conflicts


def read_counts(case_dir: str) -> dict:
    """Count pages that were read twice versus once, straight from the records."""
    counts = {"doubleRead": 0, "singleRead": 0}
    directory = os.path.join(case_dir, "ocr", "recognition")
    if not os.path.isdir(directory):
        return counts
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        record = ocr_runtime.read_json(os.path.join(directory, name)) or {}
        if not isinstance(record, dict):
            continue
        for page in record.get("pages") or []:
            if not isinstance(page, dict):
                continue
            reads = page.get("reads") or []
            if len(reads) >= 2:
                counts["doubleRead"] += 1
            elif len(reads) == 1:
                counts["singleRead"] += 1
    return counts


def not_verified_pages(index: dict, conflicts: list) -> list:
    """One reason per page; a conflict outranks unreadable, which outranks pending."""
    conflicted = {(item.get("sourceId"), item.get("page")) for item in conflicts}
    items = []
    for source in index.get("sources", []):
        for page in source.get("pages", []):
            page_no = page.get("page")
            if (source.get("sourceId"), page_no) in conflicted or page.get("recognitionStatus") == "conflict":
                reason = "conflict"
            elif page.get("renderError") or page.get("visualStatus") == "unreadable":
                reason = "unreadable"
            elif page.get("visualStatus") == "pending":
                reason = "pending"
            else:
                continue
            items.append({
                "sourceId": source.get("sourceId", ""),
                "relativePath": source.get("relativePath", ""),
                "page": page_no,
                "reason": reason,
            })
    return items


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Report OCR page coverage and pending work")
    parser.add_argument("--case", required=True)
    args = parser.parse_args(argv)

    case_dir = os.path.abspath(args.case)
    index = ocr_runtime.read_json(os.path.join(case_dir, "ocr", "index.json"))
    if not isinstance(index, dict):
        ocr_runtime.emit(ocr_runtime.fail("input", "ocr/index.json 不存在或不可读：先运行 ocr_prepare.py"))
        return ocr_runtime.EXIT_USAGE

    pending = []
    unreadable = []
    failed_sources = []
    for source in index.get("sources", []):
        waiting = [page["page"] for page in source.get("pages", []) if page.get("visualStatus") == "pending"]
        if waiting:
            pending.append({
                "sourceId": source.get("sourceId", ""),
                "relativePath": source.get("relativePath", ""),
                "pages": waiting,
            })
        for page in source.get("pages", []):
            if page.get("renderError") or page.get("visualStatus") == "unreadable":
                unreadable.append({
                    "sourceId": source.get("sourceId", ""),
                    "relativePath": source.get("relativePath", ""),
                    "page": page.get("page"),
                    "reason": page.get("renderError") or page.get("recognitionStatus") or "unreadable",
                })
        if source.get("status") == "failed":
            failed_sources.append({
                "sourceId": source.get("sourceId", ""),
                "relativePath": source.get("relativePath", ""),
                "errors": source.get("errors", []),
            })

    actions = []
    conflicts = load_conflicts(case_dir)
    not_verified = not_verified_pages(index, conflicts)
    budget_exhausted = bool((index.get("budget") or {}).get("exhausted"))
    if conflicts:
        actions.append("冲突页不得直接引用：人工确认后补记，或登记为「未核」")
    if pending:
        actions.append("用 DSH 图片判读逐页读 pending 里的页面，再用 ocr_record.py 记录")
    if unreadable:
        actions.append("逐条把 unreadable 页面登记为「未核」，不要判成缺失或通过")
    if budget_exhausted:
        counts = read_counts(case_dir)
        if counts["doubleRead"]:
            actions.append("已对 %d 页双读，其余 %d 页为单次判读（预算已用尽）"
                           % (counts["doubleRead"], counts["singleRead"]))
        else:
            actions.append("本次未做双读（预算已用尽）：交付说明写清单次判读，不得写已双读")
    if failed_sources:
        actions.append("整份来源不可读：保持其页面范围为未核，并在报告里写明原因")
    if not actions:
        actions.append("无需继续处理")

    ocr_runtime.emit({
        "ok": True,
        "errorKind": "",
        "indexPath": "ocr/index.json",
        "coverage": index.get("coverage", {}),
        "runtime": index.get("runtime", {}),
        "pending": pending,
        "unreadable": unreadable,
        "failedSources": failed_sources,
        "conflictPages": conflicts,
        "budgetExhausted": budget_exhausted,
        "notVerified": not_verified,
        "actions": actions,
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
