#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`ocr_coverage.py` 的契约：verdict 表、预算与比例、整批拒绝、过期记录。

2026-10-22 现场：覆盖率由父会话在交付脚本里**即席折算**（`done >= total`），
26 页里 1 页不可读就把整份判成未核，把子代理已读完的 45 页一并作废。
这里钉住唯一口径：`complete` / `partial` / `pending` / `skippedBudget`，
以及 2026-10-23 的两条阻断：待判读页超过 30%，或已读到内容的来源还没读完。
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
        # 5000 页以内必须读完：一页没读也阻断，没有比例豁免（2026-10-23 口径）。
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertEqual("pending-pages", coverage["gate"]["blocks"][0]["kind"])
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
        read = [page(no, "recognized") for no in range(1, 4)]
        at_limit = ocr_coverage.compute(index_of(source("a.pdf", read)), "",
                                        max_visual_pages=3)
        self.assertFalse(at_limit["budget"]["exceeded"])
        self.assertEqual("pass", at_limit["gate"]["status"])

        pending = [page(no) for no in range(1, 4)]
        over = ocr_coverage.compute(index_of(source("a.pdf", pending)), "",
                                    max_visual_pages=2)
        self.assertTrue(over["budget"]["exceeded"])
        self.assertEqual("blocked", over["gate"]["status"])
        kinds = [block["kind"] for block in over["gate"]["blocks"]]
        self.assertIn("budget-exceeded", kinds)


class PendingTest(unittest.TestCase):
    """5000 页以内必须读完：只要还有待判读页就阻断，没有比例容忍。

    2026-10-23 口径（收紧）：删除 30% 上限。100 页里读了 99 页也阻断；
    唯一放行通道是必须判读页数 > 5000 时的整批拒绝（`ocr/refusal.json`）。
    """

    def setUp(self):
        self.case = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.case, True)
        os.makedirs(os.path.join(self.case, "ocr"))

    def _inventory(self, entries):
        path = os.path.join(self.case, "材料盘点.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"items": [], "ocrRequired": entries}, handle, ensure_ascii=False)

    def test_every_page_read_passes(self):
        index = index_of(
            source("已读.pdf", [page(no, "recognized") for no in range(1, 8)], source_id="a"),
        )
        coverage = ocr_coverage.compute(index, self.case)
        self.assertEqual("pass", coverage["gate"]["status"])
        self.assertEqual(0, coverage["budget"]["pendingPages"])

    def test_one_pending_page_blocks(self):
        index = index_of(
            source("已读.pdf", [page(no, "recognized") for no in range(1, 8)], source_id="a"),
            source("差一页.pdf", [page(1, "recognized"), page(2)], source_id="b"),
        )
        coverage = ocr_coverage.compute(index, self.case)
        self.assertEqual("blocked", coverage["gate"]["status"])
        kinds = [block["kind"] for block in coverage["gate"]["blocks"]]
        self.assertIn("pending-pages", kinds)

    def test_pending_block_lists_the_unfinished_sources(self):
        index = index_of(
            source("读到一半.pdf", [page(1, "recognized"), page(2)], source_id="a"),
            source("读完.pdf", [page(1, "recognized"), page(2, "recognized")], source_id="b"),
        )
        coverage = ocr_coverage.compute(index, self.case)
        block = next(item for item in coverage["gate"]["blocks"]
                     if item["kind"] == "pending-pages")
        self.assertEqual(1, len(block["sources"]))
        self.assertEqual("读到一半.pdf", block["sources"][0]["relativePath"])
        self.assertEqual(1, block["sources"][0]["recognized"])
        self.assertEqual(1, block["sources"][0]["pending"])

    def test_unprepared_inventory_pages_block(self):
        """从没进过 ocr_prepare 的件不能因为"不在索引里"而绕过门禁。"""
        index = index_of(source("已读.pdf", [page(no, "recognized") for no in range(1, 11)]))
        self._inventory([{"path": "材料-源\\工商资料\\2003年.pdf", "reason": "no-text-layer",
                          "pageCount": 5}])
        coverage = ocr_coverage.compute(index, self.case)
        self.assertEqual(1, coverage["budget"]["unpreparedSources"])
        self.assertEqual(5, coverage["budget"]["unpreparedPages"])
        self.assertEqual(5, coverage["budget"]["pendingPages"])
        kinds = [block["kind"] for block in coverage["gate"]["blocks"]]
        self.assertIn("pending-pages", kinds)

    def test_unprepared_entry_without_page_count_blocks(self):
        index = index_of(source("已读.pdf", [page(1, "recognized")]))
        self._inventory([{"path": "材料-源\\工商资料\\2003年.pdf", "reason": "pypdf-error",
                          "pageCount": 0}])
        coverage = ocr_coverage.compute(index, self.case)
        kinds = [block["kind"] for block in coverage["gate"]["blocks"]]
        self.assertIn("inventory-page-count-missing", kinds)

    def test_unprepared_source_is_visible_in_sources_and_disclosures(self):
        """没进索引的件要出现在 `sources` 与 `disclosures` 里，而不是只躲在门禁报错中。"""
        index = index_of(source("已读.pdf", [page(1, "recognized")]))
        self._inventory([{"path": "材料-源\\扫描件.pdf", "reason": "no-text-layer",
                          "kind": "pdf", "pageCount": 3}])
        coverage = ocr_coverage.compute(index, self.case)
        entry = next(item for item in coverage["sources"]
                     if item["relativePath"] == "材料-源/扫描件.pdf")
        self.assertEqual("pending", entry["verdict"])
        self.assertEqual(3, entry["pending"])
        self.assertEqual(3, entry["required"])
        disclosed = [item["relativePath"] for item in coverage["gate"]["disclosures"]]
        self.assertIn("材料-源/扫描件.pdf", disclosed)

    def test_refused_source_is_excluded_from_the_ratio(self):
        index = index_of(source("工商.pdf", [page(no) for no in range(1, 101)],
                                status="budget-refused"))
        coverage = ocr_coverage.compute(index, self.case)
        self.assertEqual(0, coverage["budget"]["pendingPages"])
        self.assertEqual("pass", coverage["gate"]["status"])

    def test_build_says_index_missing_instead_of_not_required(self):
        self._inventory([{"path": "材料-源\\扫描件.pdf", "reason": "no-text-layer",
                          "pageCount": 85}])
        coverage = ocr_coverage.build(self.case)
        self.assertEqual("index-missing", coverage["status"])
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertEqual("index-missing", coverage["gate"]["blocks"][0]["kind"])
        self.assertEqual(1, len(coverage["gate"]["disclosures"]))

    def test_build_not_required_only_when_inventory_is_empty(self):
        coverage = ocr_coverage.build(self.case)
        self.assertEqual("not-required", coverage["status"])
        self.assertEqual("pass", coverage["gate"]["status"])


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



class RecordFallbackTest(unittest.TestCase):
    """index 丢状态时以 `ocr/recognition/*.json` 为准。

    2026-10-23 复查：`ocr_record.py` 把状态写回 `ocr/index.json` 是**整份读-改-写**，
    两个子代理并行记录不同来源时，后写的会覆盖前一个写回的状态。记录文件逐来源独立、
    原子写，不受这个竞态影响；只按 index 折算会把已经读完的页判成 pending，进而阻断交付。
    """

    def setUp(self):
        self.case = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.case, True)
        os.makedirs(os.path.join(self.case, "ocr", "recognition"))

    def _write_record(self, source_id, statuses, image_sha=""):
        path = os.path.join(self.case, "ocr", "recognition", source_id + ".json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"sourceId": source_id, "relativePath": "报告.pdf",
                       "pages": [{"page": no, "status": status, "recognitionStatus": status,
                                  "imageSha256": image_sha}
                                 for no, status in statuses.items()]}, handle)

    def test_lost_index_status_falls_back_to_records(self):
        index = index_of(source("报告.pdf", [page(1, "pending"), page(2, "pending")], source_id="s1"))
        self._write_record("s1", {1: "recognized", 2: "recognized"})
        entry = ocr_coverage.compute(index, self.case)["sources"][0]
        self.assertEqual("complete", entry["verdict"], entry)
        self.assertEqual(0, entry["pending"])

    def test_record_unreadable_is_not_counted_as_read(self):
        index = index_of(source("报告.pdf", [page(1, "pending")], source_id="s1"))
        self._write_record("s1", {1: "unreadable"})
        entry = ocr_coverage.compute(index, self.case)["sources"][0]
        self.assertEqual("partial", entry["verdict"], entry)
        self.assertEqual(1, entry["unreadable"])
        self.assertEqual(0, entry["recognized"])

    def test_record_for_a_rendered_away_image_is_not_trusted(self):
        """页图被重渲过：记录绑的是旧图，按未判读处理（不许拿过期记录冒充已读）。"""
        index = index_of(source("报告.pdf", [page(1, "pending")], source_id="s1"))
        index["sources"][0]["pages"][0]["imageSha256"] = "new"
        self._write_record("s1", {1: "recognized"}, image_sha="old")
        entry = ocr_coverage.compute(index, self.case)["sources"][0]
        self.assertEqual("pending", entry["verdict"], entry)

    def test_no_record_keeps_pending(self):
        index = index_of(source("报告.pdf", [page(1, "pending")], source_id="s1"))
        entry = ocr_coverage.compute(index, self.case)["sources"][0]
        self.assertEqual("pending", entry["verdict"], entry)


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

    def test_ratio_flag_is_gone(self):
        proc, _payload = self._run(("--max-pending-ratio", "1.0"))
        self.assertEqual(2, proc.returncode, "比例容忍已删除，宽不了任何批次")

    def test_half_read_reports_block_on_the_cli(self):
        index = index_of(source("报告.pdf", [page(1, "recognized"), page(2)]))
        with open(os.path.join(self.case, "ocr", "index.json"), "w", encoding="utf-8") as handle:
            json.dump(index, handle, ensure_ascii=False)
        proc, payload = self._run()
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual("blocked", payload["gate"])
        self.assertIn("pending-pages", [block["kind"] for block in payload["blocks"]])

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

    def test_refusal_pages_come_from_the_inventory_not_the_claim(self):
        """页数以盘点为准：不声明页数时用盘点值，声明值与盘点不符即阻断（虚报绕过）。"""
        self._inventory([{"path": "材料-源\\未准备.pdf", "reason": "no-text-layer", "pageCount": 80}])
        self._refuse([{"relativePath": "材料-源/未准备.pdf", "reason": "超阈值"}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=10)
        self.assertEqual("pass", coverage["gate"]["status"], "页数取盘点值即可成立")
        skipped = [item for item in coverage["sources"] if item["verdict"] == "skippedBudget"]
        self.assertEqual([80], [item["required"] for item in skipped])

    def test_refusal_without_inventory_pages_is_rejected(self):
        """盘点没有真实页数（旧盘点缺 pypdf）时，不许自己声明一个页数来触发整批拒绝。"""
        self._inventory([{"path": "材料-源\\未准备.pdf", "reason": "no-text-layer", "pageCount": 0}])
        self._refuse([{"relativePath": "材料-源/未准备.pdf", "reason": "超阈值", "pages": 6000}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=10)
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-pages-missing", kinds)
        self.assertEqual("blocked", coverage["gate"]["status"])

    def test_inflated_refusal_pages_are_rejected(self):
        """2026-10-23 实测的绕过：1086 页声明 6000 页即可让门禁 pass。"""
        self._inventory([{"path": "材料-源\\工商.pdf", "reason": "no-text-layer", "pageCount": 1086}])
        self._refuse([{"relativePath": "材料-源/工商.pdf", "reason": "超阈值", "pages": 6000}])
        coverage = ocr_coverage.compute(index_of(), self.case, max_visual_pages=5000)
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-pages-mismatch", kinds)
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertNotIn("skippedBudget",
                         [item["verdict"] for item in coverage["sources"]],
                         "虚报的拒绝不得把来源洗成 skipped")
        mismatch = next(item for item in coverage["gate"]["blocks"]
                        if item["kind"] == "refusal-pages-mismatch")
        self.assertEqual(6000, mismatch["declaredPages"])
        self.assertEqual(1086, mismatch["inventoryPages"])

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


class PendingPolicyTest(unittest.TestCase):
    """待判读页是否阻断交付：托管审核阻断，本地审核只披露（2026-10-23 用户口径）。"""

    def setUp(self):
        self.case = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.case, True)
        os.makedirs(os.path.join(self.case, "ocr"))

    def _index_with_pending(self):
        return index_of(source("材料-源/工商.pdf", pending_pages(3)))

    def test_managed_case_blocks_on_pending_pages(self):
        policy, reason = ocr_coverage.resolve_pending_policy(self.case)
        self.assertEqual("strict", policy)
        self.assertEqual("managed", reason)
        coverage = ocr_coverage.compute(self._index_with_pending(), self.case, 5000, policy)
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertEqual("blocked", coverage["gate"]["effectiveStatus"])
        self.assertEqual([], coverage["gate"]["warnings"])

    def test_local_case_delivers_with_disclosure(self):
        with open(os.path.join(self.case, "本地审核清单.json"), "w", encoding="utf-8") as handle:
            json.dump({"handoffId": "la-1", "files": []}, handle)
        policy, reason = ocr_coverage.resolve_pending_policy(self.case)
        self.assertEqual("disclose", policy)
        self.assertEqual("local-audit", reason)
        coverage = ocr_coverage.compute(self._index_with_pending(), self.case, 5000, policy)
        self.assertEqual("blocked", coverage["gate"]["status"], "严格视图仍如实记 blocked")
        self.assertEqual("pass", coverage["gate"]["effectiveStatus"], "本地审核允许带未核交付")
        kinds = [item["kind"] for item in coverage["gate"]["warnings"]]
        self.assertIn("pending-pages", kinds)
        self.assertEqual("材料-源/工商.pdf",
                         coverage["gate"]["disclosures"][0]["relativePath"])
        self.assertEqual(3, coverage["totals"]["pending"], "披露必须带真实待判读页数")

    def test_local_case_still_blocks_on_integrity_problems(self):
        """本地审核允许"没读"，不允许"说假话"：拒绝页数虚报在 disclose 下仍阻断。"""
        with open(os.path.join(self.case, "本地审核清单.json"), "w", encoding="utf-8") as handle:
            json.dump({"handoffId": "la-1"}, handle)
        with open(os.path.join(self.case, "材料盘点.json"), "w", encoding="utf-8") as handle:
            json.dump({"ocrRequired": [{"path": "材料-源/工商.pdf", "pageCount": 1086}]},
                      handle, ensure_ascii=False)
        with open(os.path.join(self.case, "ocr", "refusal.json"), "w", encoding="utf-8") as handle:
            json.dump({"schemaVersion": 1, "sources": [
                {"relativePath": "材料-源/工商.pdf", "reason": "太多", "pages": 6000}]},
                handle, ensure_ascii=False)
        coverage = ocr_coverage.compute(index_of(), self.case, 5000, "disclose")
        self.assertEqual("blocked", coverage["gate"]["status"])
        self.assertEqual("blocked", coverage["gate"]["effectiveStatus"],
                         "数据完整性问题不能被本地审核降级")
        kinds = [item["kind"] for item in coverage["gate"]["blocks"]]
        self.assertIn("refusal-pages-mismatch", kinds)

    def test_explicit_strict_wins_over_local_marker(self):
        with open(os.path.join(self.case, "本地审核清单.json"), "w", encoding="utf-8") as handle:
            json.dump({"handoffId": "la-1"}, handle)
        policy, reason = ocr_coverage.resolve_pending_policy(self.case, "strict")
        self.assertEqual("strict", policy)
        self.assertEqual("explicit", reason)

    def test_not_required_case_passes_under_both_policies(self):
        for policy in ("strict", "disclose"):
            coverage = ocr_coverage.build(self.case, 5000, policy)
            self.assertEqual("not-required", coverage["status"])
            self.assertEqual("pass", coverage["gate"]["effectiveStatus"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
