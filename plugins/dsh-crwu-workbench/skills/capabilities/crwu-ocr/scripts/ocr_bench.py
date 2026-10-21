#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Maintenance benchmark: compare OCR results against a human truth file.

Read-only. It is not staged into audit cases and is not a runtime script; the
skill's SKILL.md never asks the model to run it. Maintainers use it to compare
policies (fast / auto / quality) on the same fixed sample.

Metrics:
  keyValueAccuracy   exact match after normalisation / all truth key values
  silentErrorRate    wrong value that no conflict or uncertainty flagged
  tableCellAccuracy  per-cell comparison, missing cells count as wrong
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import ocr_runtime


def _recognition_page(recognition: dict, page_no: int):
    for record in recognition.values():
        if not isinstance(record, dict):
            continue
        for page in record.get("pages") or []:
            if isinstance(page, dict) and page.get("page") == page_no:
                return page
    return {}


def _value_of(item) -> str:
    return ocr_runtime.normalize_value(str((item or {}).get("value") or ""))


def compute_metrics(index: dict, recognition: dict, truth: dict) -> dict:
    key_total = key_correct = wrong = silent = 0
    cell_total = cell_correct = 0

    for page_truth in truth.get("pages") or []:
        page_no = page_truth.get("page")
        record = _recognition_page(recognition, page_no)
        values = {}
        for item in record.get("keyValues") or []:
            if isinstance(item, dict) and item.get("label"):
                values[str(item["label"])] = item.get("value")
        conflicts = record.get("conflicts") or []
        uncertainties = " ".join(str(item) for item in record.get("uncertainties") or [])

        for item in page_truth.get("keyValues") or []:
            label = str((item or {}).get("label") or "")
            expected = _value_of(item)
            key_total += 1
            actual = values.get(label)
            if actual is not None and ocr_runtime.normalize_value(str(actual)) == expected:
                key_correct += 1
                continue
            wrong += 1
            flagged = bool(conflicts) or label in uncertainties or (
                actual is not None and str(actual) in uncertainties)
            if not flagged:
                silent += 1

        tables_truth = page_truth.get("tables") or []
        tables_record = record.get("tables") or []
        for table_index, table in enumerate(tables_truth):
            rows_truth = (table or {}).get("rows") or []
            rows_record = []
            if table_index < len(tables_record) and isinstance(tables_record[table_index], dict):
                rows_record = tables_record[table_index].get("rows") or []
            for row_index, row in enumerate(rows_truth):
                for cell_index, cell in enumerate(row):
                    cell_total += 1
                    try:
                        got = rows_record[row_index][cell_index]
                    except (IndexError, TypeError):
                        got = None
                    if got is not None and ocr_runtime.normalize_value(str(got)) == ocr_runtime.normalize_value(str(cell)):
                        cell_correct += 1

    image_calls = sum(len(page.get("renders") or [])
                      for source in index.get("sources") or []
                      for page in source.get("pages") or [])
    return {
        "keyValueAccuracy": round(key_correct / key_total, 4) if key_total else 0.0,
        "silentErrorRate": round(silent / key_total, 4) if key_total else 0.0,
        "tableCellAccuracy": round(cell_correct / cell_total, 4) if cell_total else 0.0,
        "cost": {"keyValues": key_total, "wrong": wrong, "silent": silent,
                 "cells": cell_total, "imageCalls": image_calls},
    }


def load_recognition(case_dir: str) -> dict:
    directory = os.path.join(case_dir, "ocr", "recognition")
    records = {}
    if not os.path.isdir(directory):
        return records
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        record = ocr_runtime.read_json(os.path.join(directory, name)) or {}
        if isinstance(record, dict) and record.get("sourceId"):
            records[record["sourceId"]] = record
    return records


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Compare OCR results with a human truth file")
    parser.add_argument("--case", required=True, help="case directory (absolute path)")
    parser.add_argument("--truth", required=True, help="case-relative truth JSON path")
    args = parser.parse_args(argv)

    case_dir = os.path.abspath(args.case)
    index = ocr_runtime.read_json(os.path.join(case_dir, "ocr", "index.json"))
    if not isinstance(index, dict):
        ocr_runtime.emit(ocr_runtime.fail("input", "ocr/index.json 不存在或不可读：先运行 ocr_prepare.py"))
        return ocr_runtime.EXIT_USAGE
    raw = args.truth.strip()
    if raw == "" or os.path.isabs(raw) or ".." in raw.replace("\\", "/").split("/"):
        ocr_runtime.emit(ocr_runtime.fail("input", "--truth 必须是案例目录内的相对路径"))
        return ocr_runtime.EXIT_USAGE
    truth = ocr_runtime.read_json(ocr_runtime.safe_join(case_dir, raw))
    if not isinstance(truth, dict) or not isinstance(truth.get("pages"), list):
        ocr_runtime.emit(ocr_runtime.fail("input", "--truth 里没有 pages"))
        return ocr_runtime.EXIT_USAGE

    metrics = compute_metrics(index, load_recognition(case_dir), truth)
    ocr_runtime.emit({"ok": True, "errorKind": "", "metrics": metrics})
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
