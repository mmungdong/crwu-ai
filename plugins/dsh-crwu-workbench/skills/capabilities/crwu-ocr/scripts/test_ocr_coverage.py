#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`ocr_coverage.py` 的契约：verdict 表、预算边界、过期记录。

2026-10-22 现场：覆盖率由父会话在交付脚本里**即席折算**（`done >= total`），
26 页里 1 页不可读就把整份判成未核，把子代理已读完的 45 页一并作废。
这里钉住唯一口径：`complete` / `partial` / `pending` / `skippedBudget`，
以及"未判读不是阻断理由、但必须逐条披露"。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ocr_coverage  # noqa: E402
import ocr_runtime  # noqa: E402

COVERAGE = os.path.join(HERE, "ocr_coverage.py")


def page(no, state="pending", required=True):
    """按 `ocr_record.py` 写回 index 的形状造页。"""
    entry = {"page": no, "visualRequired": required, "visualStatus": state}
    if state == "recognized":
        entry["recognitionStatus"] = "recognized"
    elif state == "partial":
        entry["recognitionStatus"] = "partial"
    elif state == "unreadable":
        entry["recognitionStatus"] = "unreadable"
    elif state == "done":
        entry["recognitionStatus"] = "recognized"
    return entry


def source(relative_path, pages, status="prepared", source_id="s1"):
    return {
        "sourceId": source_id,
        "kind": "pdf",
        "relativePath": relative_path,
        "pageCount": len(pages),
        "status": status,
        "pages": pages,
    }


def index_of(*sources):
    return {"schemaVersion": 1, "sources": list(sources), "skipped": []}


class CountsTest(unittest.TestCase):
    def test_complete_when_every_required_page_is_read(self):
        coverage = ocr_coverage.compute(index_of(source("报告.pdf", [page(1, "recognized"), page(2, "partial")])), "")
        entry = coverage["sources"][0]
        self.assertEqual("complete", entry["verdict"])
        self.assertEqual(0, entry["pending"])
        self.assertEqual("pass", coverage["gate"]["status"])

    def test_partial_when_read_but_one_page_unreadable(self):
        # 显式口径：26 页里 1 页不可读 → partial（已审核 + 逐页登记不可读），不是 pending。
        pages = [page(no, "recognized") for no in range(1, 26)] + [page(26, "unreadable")]
        coverage = ocr_coverage.compute(index_of(source("13张车行驶证扫描件.pdf", pages)), "")
        entry = coverage["sources"][0]
        self.assertEqual("partial", entry["verdict"])
        self.assertEqual(26, entry["required"])
        self.assertEqual(25, entry["recognized"])
        self.assertEqual(1, entry["unreadable"])
        self.assertEqual(0, entry["pending"])
        self.assertEqual("page-unreadable", entry["reasonCode"])
        # partial 仍然算已审核，不阻断交付。
        self.assertEqual("pass", coverage["gate"]["status"])
        self.assertEqual([], coverage["gate"]["disclosures"])

    def test_pending_source_is_whole_source_not_a_ratio(self):
        pages = [page(1, "recognized")] * 9 + [page(10, "pending")]
        coverage = ocr_coverage.compute(index_of(source("合同.pdf", pages)), "")
        entry = coverage["sources"][0]
        self.assertEqual("pending", entry["verdict"], "一份来源只要还有待判读页，整份即 pending")
        self.assertEqual([10], entry["pendingPages"])
        self.assertEqual("pages-pending", entry["reasonCode"])
        self.assertEqual("pass", coverage["gate"]["status"], "未判读不是阻断理由")
        self.assertEqual("合同.pdf", coverage["gate"]["disclosures"][0]["relativePath"])

    def test_pages_without_text_layer_are_not_required(self):
        # 有文本层、不需要看图：不进分母，也不会因为"没渲染"被判未核。
        coverage = ocr_coverage.compute(index_of(source("说明.pdf", [page(1, "pending", required=False)])), "")
        entry = coverage["sources"][0]
        self.assertEqual(0, entry["required"])
        self.assertEqual("complete", entry["verdict"])

    def test_render_error_counts_as_unreadable(self):
        broken = page(1, "pending")
        broken["renderError"] = "渲染失败"
        coverage = ocr_coverage.compute(index_of(source("坏页.pdf", [broken])), "")
        self.assertEqual("partial", coverage["sources"][0]["verdict"])
        self.assertEqual(1, coverage["sources"][0]["unreadable"])

    def test_budget_refused_source_is_skipped_not_pending(self):
        coverage = ocr_coverage.compute(
            index_of(source("工商资料.pdf", [page(1), page(2)], status="budget-refused")), "")
        entry = coverage["sources"][0]
        self.assertEqual("skippedBudget", entry["verdict"])
        self.assertEqual("budget-refused", entry["reasonCode"])
        self.assertEqual("skippedBudget", coverage["gate"]["disclosures"][0]["verdict"])


class BudgetTest(unittest.TestCase):
    def test_budget_boundary_is_inclusive(self):
        pages = [page(no) for no in range(1, 4)]
        at_limit = ocr_coverage.compute(index_of(source("a.pdf", pages)), "", max_visual_pages=3)
        self.assertFalse(at_limit["budget"]["exceeded"])
        self.assertEqual("pass", at_limit["gate"]["status"])

        over = ocr_coverage.compute(index_of(source("a.pdf", pages)), "", max_visual_pages=2)
        self.assertTrue(over["budget"]["exceeded"])
        self.assertEqual("blocked", over["gate"]["status"])
        self.assertEqual("budget-exceeded", over["gate"]["blocks"][0]["kind"])


class StaleTest(unittest.TestCase):
    def setUp(self):
        self.case = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.case, True)
        os.makedirs(os.path.join(self.case, "ocr", "recognition"))

    def _write_record(self, source_id, pages):
        path = os.path.join(self.case, "ocr", "recognition", source_id + ".json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"sourceId": source_id, "relativePath": "报告.pdf",
                       "pages": [{"page": no, "status": "recognized"} for no in pages]}, handle)

    def test_record_for_unknown_source_blocks(self):
        self._write_record("gone", [1])
        coverage = ocr_coverage.compute(index_of(source("报告.pdf", [page(1, "recognized")])), self.case)
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertEqual("stale-recognition", coverage["gate"]["blocks"][0]["kind"])

    def test_record_page_outside_index_blocks(self):
        self._write_record("s1", [1, 9])
        coverage = ocr_coverage.compute(index_of(source("报告.pdf", [page(1, "recognized")])), self.case)
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertIn("9", coverage["gate"]["blocks"][0]["reason"])

    def test_matching_records_do_not_block(self):
        self._write_record("s1", [1])
        coverage = ocr_coverage.compute(index_of(source("报告.pdf", [page(1, "recognized")])), self.case)
        self.assertEqual("pass", coverage["gate"]["status"])


class DigestTest(unittest.TestCase):
    def test_digest_is_stable_and_matches_ocr_runtime(self):
        index = index_of(source("报告.pdf", [page(1, "recognized")]))
        first = ocr_coverage.compute(index, "")["indexDigest"]
        second = ocr_coverage.compute(index, "")["indexDigest"]
        self.assertEqual(first, second)
        self.assertEqual(ocr_runtime.canonical_digest(index), first, "交付侧用同一口径复核")

    def test_digest_changes_when_index_changes(self):
        base = index_of(source("报告.pdf", [page(1, "recognized")]))
        changed = index_of(source("报告.pdf", [page(1, "recognized"), page(2, "pending")]))
        self.assertNotEqual(ocr_coverage.compute(base, "")["indexDigest"],
                            ocr_coverage.compute(changed, "")["indexDigest"])


class CliTest(unittest.TestCase):
    def setUp(self):
        self.case = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.case, True)
        os.makedirs(os.path.join(self.case, "ocr"))
        index = index_of(source("报告.pdf", [page(1, "recognized")]))
        with open(os.path.join(self.case, "ocr", "index.json"), "w", encoding="utf-8") as handle:
            json.dump(index, handle, ensure_ascii=False)

    def _run(self, extra=()):
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        proc = subprocess.run([sys.executable, COVERAGE, "--case", self.case, *extra],
                              cwd=HERE, env=env, capture_output=True, text=True)
        return proc, json.loads(proc.stdout) if proc.stdout.strip() else {}

    def test_writes_coverage_json(self):
        proc, payload = self._run()
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertTrue(payload["ok"])
        written = os.path.join(self.case, "ocr", "coverage.json")
        self.assertTrue(os.path.isfile(written))
        with open(written, encoding="utf-8") as handle:
            coverage = json.load(handle)
        self.assertEqual("computed", coverage["status"])
        self.assertEqual(payload["indexDigest"], coverage["indexDigest"])

    def test_custom_budget_argument(self):
        proc, payload = self._run(("--max-visual-pages", "0"))
        self.assertEqual(2, proc.returncode, "0 页上限是非法输入")
        self.assertFalse(payload["ok"])

    def test_missing_index_yields_not_required(self):
        os.remove(os.path.join(self.case, "ocr", "index.json"))
        proc, payload = self._run()
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual("not-required", payload["status"])
        self.assertEqual("pass", payload["gate"])


class SourceStatusTest(unittest.TestCase):
    """整份打不开 / 需要口令：必须落"未核"，不能被 required == 0 洗成已审核。"""

    def test_needs_password_is_pending_with_its_own_reason(self):
        coverage = ocr_coverage.compute(
            index_of(source("材料-源/加密.pdf", [], status="needs-password")), "")
        entry = coverage["sources"][0]
        self.assertEqual("pending", entry["verdict"], "加密件不能被洗成「已审核」")
        self.assertEqual("pdf-password-required", entry["reasonCode"])
        self.assertEqual(0, entry["required"], "没有可判读的页，但它仍然整份未核")
        disclosure = coverage["gate"]["disclosures"][0]
        self.assertIn("口令", disclosure["requiredAction"])
        self.assertEqual("pass", coverage["gate"]["status"], "未核不阻断，但要披露")

    def test_failed_source_is_pending_with_its_own_reason(self):
        coverage = ocr_coverage.compute(
            index_of(source("材料-源/坏.pdf", [], status="failed")), "")
        entry = coverage["sources"][0]
        self.assertEqual("pending", entry["verdict"])
        self.assertEqual("source-failed", entry["reasonCode"])
        self.assertIn("重新提供", coverage["gate"]["disclosures"][0]["requiredAction"])


def recognized_pages(count):
    return [{"page": no, "visualRequired": True, "visualStatus": "done",
             "recognitionStatus": "recognized"} for no in range(1, count + 1)]


def pending_pages(count):
    return [{"page": no, "visualRequired": True, "visualStatus": "pending"}
            for no in range(1, count + 1)]


class BudgetUsesPendingTest(unittest.TestCase):
    """预算量的是"本轮还要读多少页"，不是"总共有多少必读页"。"""

    def test_already_read_batch_is_not_over_budget(self):
        coverage = ocr_coverage.compute(
            index_of(source("材料-源/大.pdf", recognized_pages(5001))), "", max_visual_pages=5000)
        self.assertEqual(0, coverage["budget"]["used"])
        self.assertFalse(coverage["budget"]["exceeded"])
        self.assertEqual("pass", coverage["gate"]["status"], "全部读完的 5001 页不该被阻断")

    def test_pending_over_budget_blocks(self):
        coverage = ocr_coverage.compute(
            index_of(source("材料-源/大.pdf", pending_pages(5001))), "", max_visual_pages=5000)
        self.assertEqual(5001, coverage["budget"]["used"])
        self.assertTrue(coverage["budget"]["exceeded"])
        self.assertEqual("blocked", coverage["gate"]["status"])


class RefusalTest(unittest.TestCase):
    """整批拒绝：只在批次确实超预算时生效，且必须逐条披露。"""

    def setUp(self):
        self.case = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.case, True)
        os.makedirs(os.path.join(self.case, "ocr"))

    def _refuse(self, entries):
        with open(os.path.join(self.case, "ocr", "refusal.json"), "w", encoding="utf-8") as handle:
            json.dump({"schemaVersion": 1, "sources": entries}, handle, ensure_ascii=False)

    def _inventory(self, required):
        with open(os.path.join(self.case, "材料盘点.json"), "w", encoding="utf-8") as handle:
            json.dump({"ocrRequired": required}, handle, ensure_ascii=False)

    def test_refusal_is_honoured_and_unblocks_the_batch(self):
        index = index_of(source("材料-源/工商.pdf", pending_pages(11)))
        self._refuse([{"relativePath": "材料-源/工商.pdf", "reason": "超阈值", "pages": 11}])
        coverage = ocr_coverage.compute(index, self.case, max_visual_pages=10)
        entry = coverage["sources"][0]
        self.assertEqual("skippedBudget", entry["verdict"])
        self.assertEqual("budget-refused", entry["reasonCode"])
        self.assertEqual(0, coverage["budget"]["used"], "被拒绝的页不再计预算")
        self.assertEqual("pass", coverage["gate"]["status"], "显式拒绝是可交付的")
        self.assertEqual("材料-源/工商.pdf", coverage["gate"]["disclosures"][0]["relativePath"])

    def test_refusal_below_budget_is_rejected(self):
        index = index_of(source("材料-源/小.pdf", pending_pages(3)))
        self._refuse([{"relativePath": "材料-源/小.pdf", "reason": "懒得看", "pages": 3}])
        coverage = ocr_coverage.compute(index, self.case, max_visual_pages=10)
        self.assertEqual("blocked", coverage["gate"]["status"])
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-not-justified", kinds)
        self.assertEqual("pending", coverage["sources"][0]["verdict"], "不成立的拒绝不改变判定")

    def test_refusal_of_source_outside_index_must_declare_pages(self):
        self._inventory([{"path": "材料-源\\未准备.pdf", "reason": "no-text-layer", "pageCount": 80}])
        self._refuse([{"relativePath": "材料-源/未准备.pdf", "reason": "超阈值"}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=10)
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-pages-missing", kinds)

    def test_refusal_of_unknown_source_is_rejected(self):
        self._refuse([{"relativePath": "材料-源/不存在.pdf", "reason": "超阈值", "pages": 99}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=10)
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-unknown-source", kinds)

    def test_refusal_path_escape_is_rejected(self):
        self._refuse([{"relativePath": "../外面.pdf", "reason": "超阈值", "pages": 99}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=10)
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-invalid-path", kinds)

    def test_refusal_of_out_of_index_source_appears_as_skipped(self):
        self._inventory([{"path": "材料-源\\工商.pdf", "reason": "no-text-layer", "pageCount": 80}])
        self._refuse([{"relativePath": "材料-源/工商.pdf", "reason": "超阈值", "pages": 80}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=10)
        self.assertEqual("pass", coverage["gate"]["status"])
        skipped = [item for item in coverage["sources"] if item["verdict"] == "skippedBudget"]
        self.assertEqual(["材料-源/工商.pdf"], [item["relativePath"] for item in skipped])
        self.assertEqual(80, coverage["totals"]["skippedPages"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
