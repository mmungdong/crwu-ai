#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Report OCR coverage: what is prepared, what still needs image reading, what is unreadable."""
from __future__ import annotations

import argparse
import os
import sys

import ocr_runtime


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
    if pending:
        actions.append("用 DSH 图片判读逐页读 pending 里的页面，再用 ocr_record.py 记录")
    if unreadable:
        actions.append("逐条把 unreadable 页面登记为「未核」，不要判成缺失或通过")
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
        "actions": actions,
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
