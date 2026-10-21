#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-end tests for prepare / record / status using synthetic fixtures only."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ocr_engines  # noqa: E402
import ocr_prepare  # noqa: E402
import ocr_runtime  # noqa: E402

PREPARE = os.path.join(HERE, "ocr_prepare.py")
RECORD = os.path.join(HERE, "ocr_record.py")
STATUS = os.path.join(HERE, "ocr_status.py")
MERGE = os.path.join(HERE, "ocr_merge.py")
SKILL_ROOT = os.path.dirname(HERE)
WHEEL_DIR = os.path.join(SKILL_ROOT, "vendor", "wheels")


def load(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def run(script, args, case):
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [sys.executable, script] + args, cwd=HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        payload = json.loads(completed.stdout)
    except ValueError:
        payload = {"raw": completed.stdout, "stderr": completed.stderr}
    return completed.returncode, payload


class OcrFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case = tempfile.mkdtemp(prefix="crwu-ocr-test-")
        cls.source_dir = os.path.join(cls.case, "材料-源")
        os.makedirs(cls.source_dir)
        runtime = ocr_runtime.ensure_dependencies(HERE, cls.case)
        if not runtime["ok"]:
            shutil.rmtree(cls.case, ignore_errors=True)
            raise unittest.SkipTest("packaged OCR dependencies unavailable: %s" % runtime.get("error"))
        cls.runtime = runtime
        cls.engine, notes = ocr_engines.select_pdf_engine()
        if cls.engine is None:
            shutil.rmtree(cls.case, ignore_errors=True)
            raise unittest.SkipTest("no PDF renderer available: %s" % "; ".join(notes))
        cls.build_fixtures()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.case, ignore_errors=True)

    @classmethod
    def build_fixtures(cls):
        from PIL import Image, ImageDraw
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

        writer = PdfWriter()

        def add_page(text):
            page = writer.add_blank_page(width=300, height=200)
            font = DictionaryObject()
            font[NameObject("/Type")] = NameObject("/Font")
            font[NameObject("/Subtype")] = NameObject("/Type1")
            font[NameObject("/BaseFont")] = NameObject("/Helvetica")
            resources = DictionaryObject()
            resources[NameObject("/Font")] = DictionaryObject({NameObject("/F1"): writer._add_object(font)})
            page[NameObject("/Resources")] = resources
            if text:
                stream = DecodedStreamObject()
                stream.set_data(("BT /F1 12 Tf 20 100 Td (%s) Tj ET" % text).encode("ascii"))
                page[NameObject("/Contents")] = writer._add_object(stream)

        add_page("Invoice total is 12345 for the first page")
        add_page("")
        add_page("Second page carries the seal and signature")
        writer.pages[2][NameObject("/Rotate")] = NumberObject(90)
        with open(os.path.join(cls.source_dir, "报告.pdf"), "wb") as handle:
            writer.write(handle)

        photograph = Image.new("RGB", (320, 240), (240, 240, 240))
        draw = ImageDraw.Draw(photograph)
        draw.rectangle((10, 10, 120, 80), fill=(200, 0, 0))
        photograph.save(os.path.join(cls.source_dir, "现场照片.jpg"), quality=90)

        frames = [Image.new("RGB", (200, 150), (255, 255, 255)), Image.new("RGB", (200, 150), (210, 210, 210))]
        frames[0].save(os.path.join(cls.source_dir, "扫描件.tif"), save_all=True, append_images=frames[1:])

        with open(os.path.join(cls.source_dir, "损坏.pdf"), "wb") as handle:
            handle.write(b"%PDF-1.7\nthis is not a pdf\n")

    @classmethod
    def prepare(cls, *extra):
        return run(PREPARE, ["--case", cls.case] + list(extra), cls.case)

    def test_01_prepare_indexes_pages_and_text(self):
        code, payload = self.prepare()
        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["ok"], payload)
        sources = {item["relativePath"]: item for item in payload["sources"]}
        self.assertEqual(set(sources), {"材料-源/报告.pdf", "材料-源/现场照片.jpg", "材料-源/扫描件.tif", "材料-源/损坏.pdf"})

        report = sources["材料-源/报告.pdf"]
        self.assertEqual(report["pageCount"], 3)
        self.assertEqual(report["status"], "prepared")
        index = load(os.path.join(self.case, "ocr", "index.json"))
        pdf_source = next(item for item in index["sources"] if item["relativePath"] == "材料-源/报告.pdf")
        self.assertEqual([page["textStatus"] for page in pdf_source["pages"]], ["ok", "empty", "ok"])
        self.assertEqual([page["visualRequired"] for page in pdf_source["pages"]], [False, True, False])
        self.assertIn("no-text-layer", pdf_source["pages"][1]["visualReasons"])
        for page in pdf_source["pages"]:
            self.assertTrue(os.path.isfile(os.path.join(self.case, page["image"])), page["image"])
            self.assertRegex(os.path.basename(page["image"]),
                             r"^报告_page000[1-3](@\d+)?\.png$")
        self.assertEqual(pdf_source["pages"][2]["pageRotation"], 90)
        self.assertEqual((pdf_source["pages"][2]["width"], pdf_source["pages"][2]["height"]), (400, 600),
                         "a /Rotate 90 page must be rendered in its displayed orientation")

        photo = sources["材料-源/现场照片.jpg"]
        self.assertEqual(photo["pageCount"], 1)
        photo_source = next(item for item in index["sources"] if item["relativePath"] == "材料-源/现场照片.jpg")
        self.assertIn("image-source", photo_source["pages"][0]["visualReasons"])
        tiff = sources["材料-源/扫描件.tif"]
        self.assertEqual(tiff["pageCount"], 2, "multi-frame TIFF must keep every frame")
        broken = sources["材料-源/损坏.pdf"]
        self.assertEqual(broken["status"], "failed")
        self.assertTrue(broken["errors"])

        coverage = payload["coverage"]
        self.assertEqual(coverage["pages"], 6)
        self.assertEqual(coverage["pagesWithText"], 2)
        self.assertEqual(coverage["pagesPending"], coverage["pagesVisualRequired"])

    def test_02_second_run_reuses_rendered_pages(self):
        self.prepare()
        index_path = os.path.join(self.case, "ocr", "index.json")
        before = load(index_path)
        stamps = {}
        for source in before["sources"]:
            for page in source["pages"]:
                if page.get("image"):
                    absolute = os.path.join(self.case, page["image"])
                    stamps[absolute] = os.stat(absolute).st_mtime_ns
        code, payload = self.prepare()
        self.assertEqual(code, 0, payload)
        for path, stamp in stamps.items():
            self.assertEqual(os.stat(path).st_mtime_ns, stamp, "unchanged page must not be re-rendered")

    def test_03_visual_pages_selector_marks_requested_pages(self):
        code, payload = self.prepare("--visual", "pages:1")
        self.assertEqual(code, 0, payload)
        index = load(os.path.join(self.case, "ocr", "index.json"))
        pdf_source = next(item for item in index["sources"] if item["relativePath"] == "材料-源/报告.pdf")
        self.assertIn("visual-pages", pdf_source["pages"][0]["visualReasons"])
        self.assertTrue(pdf_source["pages"][0]["visualRequired"])

    def test_04_record_merges_and_rejects_bad_pages(self):
        self.prepare()
        index = load(os.path.join(self.case, "ocr", "index.json"))
        pdf_source = next(item for item in index["sources"] if item["relativePath"] == "材料-源/报告.pdf")
        source_id = pdf_source["sourceId"]
        pages = {page["page"]: page for page in pdf_source["pages"]}

        valid = {
            "sourceId": source_id,
            "pages": [
                {"page": 1, "status": "recognized", "text": "发票合计 12345", "tables": [], "visibleElements": [
                    {"type": "印章", "description": "骑缝章可见"}]},
                {"page": 2, "status": "recognized", "imageSha256": pages[2]["imageSha256"],
                 "text": "", "uncertainties": ["页面为空白，未见正文"]},
            ],
        }
        input_path = os.path.join(self.case, "ocr", "recognition-input.json")
        dump(input_path, valid)
        code, payload = run(RECORD, ["--case", self.case, "--input", "ocr/recognition-input.json"], self.case)
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["recordedPages"], [1, 2])
        self.assertEqual(payload["coverage"]["pagesRecognized"], 2)

        index = load(os.path.join(self.case, "ocr", "index.json"))
        pdf_source = next(item for item in index["sources"] if item["relativePath"] == "材料-源/报告.pdf")
        self.assertEqual(pdf_source["pages"][0]["visualStatus"], "done")
        recognition = load(os.path.join(self.case, "ocr", "recognition", source_id + ".json"))
        self.assertEqual(recognition["pages"][0]["text"], "发票合计 12345")

        stale = {"sourceId": source_id, "pages": [{"page": 1, "status": "recognized", "text": "x", "imageSha256": "deadbeef"}]}
        dump(input_path, stale)
        code, payload = run(RECORD, ["--case", self.case, "--input", "ocr/recognition-input.json"], self.case)
        self.assertEqual(code, 2, payload)
        self.assertEqual(payload["errorKind"], "stale")

        out_of_range = {"sourceId": source_id, "pages": [{"page": 9, "status": "recognized", "text": "x"}]}
        dump(input_path, out_of_range)
        code, payload = run(RECORD, ["--case", self.case, "--input", "ocr/recognition-input.json"], self.case)
        self.assertEqual(code, 2, payload)
        self.assertIn("不在索引里", payload["error"])

    def test_06_second_pass_source_does_not_drop_stage_one(self):
        from PIL import Image

        review_dir = os.path.join(self.case, "复核-人工")
        os.makedirs(review_dir, exist_ok=True)
        Image.new("RGB", (180, 120), (230, 230, 230)).save(os.path.join(review_dir, "复核截图.png"))
        code, payload = self.prepare("--src", "复核-人工")
        self.assertEqual(code, 0, payload)
        index = load(os.path.join(self.case, "ocr", "index.json"))
        paths = {source["relativePath"] for source in index["sources"]}
        self.assertIn("材料-源/报告.pdf", paths, "第二次 --src 不得丢掉阶段一已索引的来源")
        self.assertIn("复核-人工/复核截图.png", paths)
        self.assertEqual(payload["coverage"]["sources"], 5)

        code, payload = self.prepare("--src", "复核-人工", "--reset")
        self.assertEqual(code, 0, payload)
        index = load(os.path.join(self.case, "ocr", "index.json"))
        self.assertEqual([source["relativePath"] for source in index["sources"]], ["复核-人工/复核截图.png"])

    def test_05_status_reports_pending_and_unreadable(self):
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["pending"], "photo/TIFF pages still need image reading")
        self.assertTrue(any(item["relativePath"] == "材料-源/损坏.pdf" for item in payload["failedSources"]))
        self.assertTrue(payload["actions"])

    # ---- 07-09：审核侧只把兜底清单交给 OCR，不许为可读文件白渲染 ----
    def _page_stamps(self):
        index = load(os.path.join(self.case, "ocr", "index.json"))
        stamps = {}
        for source in index["sources"]:
            for page in source["pages"]:
                if page.get("image") and os.path.isfile(os.path.join(self.case, page["image"])):
                    stamps[page["image"]] = os.stat(os.path.join(self.case, page["image"])).st_mtime_ns
        return stamps

    def test_07_only_indexes_listed_files_only(self):
        code, payload = self.prepare()
        self.assertEqual(code, 0, payload)
        before = self._page_stamps()
        self.assertTrue(before, "整目录索引应当已产出页图")

        code, payload = self.prepare("--only", "材料-源/报告.pdf")
        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["ok"], payload)
        index = load(os.path.join(self.case, "ocr", "index.json"))
        paths = {source["relativePath"] for source in index["sources"]}
        self.assertIn("材料-源/报告.pdf", paths)
        self.assertIn("材料-源/现场照片.jpg", paths, "--only 不得丢掉未列出的既有来源")
        after = self._page_stamps()
        for image, stamp in before.items():
            self.assertEqual(after.get(image), stamp, "--only 不得重渲染清单外的页：" + image)

    def test_08_only_rejects_reset_and_src(self):
        code, payload = self.prepare("--only", "材料-源/报告.pdf", "--reset")
        self.assertEqual(code, 2, payload)
        self.assertEqual(payload.get("errorKind"), "input")

        code, payload = self.prepare("--only", "材料-源/报告.pdf", "--src", "材料-源")
        self.assertEqual(code, 2, payload)
        self.assertEqual(payload.get("errorKind"), "input")

    def test_09_only_rejects_missing_or_escaping_paths(self):
        self.prepare()
        index_path = os.path.join(self.case, "ocr", "index.json")
        with open(index_path, "rb") as handle:
            untouched = handle.read()

        for bad in ("../etc/passwd", os.path.join(self.case, "材料-源", "报告.pdf"),
                    "材料-源/不存在.pdf"):
            code, payload = self.prepare("--only", bad)
            self.assertEqual(code, 2, payload)
            self.assertEqual(payload.get("errorKind"), "input")

        with open(index_path, "rb") as handle:
            self.assertEqual(handle.read(), untouched, "参数被拒时不得改写既有索引")

    # ---- 10-14：合并文本按页序连贯，未判读显式占位 ----
    def _source(self, relative):
        index = load(os.path.join(self.case, "ocr", "index.json"))
        return next(item for item in index["sources"] if item["relativePath"] == relative)

    def _record(self, source, pages):
        input_path = os.path.join(self.case, "ocr", "recognition-input.json")
        dump(input_path, {"sourceId": source["sourceId"], "pages": pages})
        code, payload = run(RECORD, ["--case", self.case, "--input", "ocr/recognition-input.json"], self.case)
        self.assertEqual(code, 0, payload)
        return payload

    def _record_raw(self, source, pages):
        """Same as ``_record`` but returns the exit code for rejection tests."""
        input_path = os.path.join(self.case, "ocr", "recognition-input.json")
        dump(input_path, {"sourceId": source["sourceId"], "pages": pages})
        return run(RECORD, ["--case", self.case, "--input", "ocr/recognition-input.json"], self.case)

    def _merge(self, *extra):
        return run(MERGE, ["--case", self.case] + list(extra), self.case)

    def _merged_text(self, source_id):
        with open(os.path.join(self.case, "ocr", "merged", source_id + ".txt"),
                  encoding="utf-8") as handle:
            return handle.read()

    def test_15_merge_clears_stale_outputs_when_switching_mode(self):
        """切换单文件/分卷后，目录里只能有本次产物（不能留上一版的旧正文）。"""
        report = self._source("材料-源/报告.pdf")
        base = report["sourceId"]
        merged_dir = os.path.join(self.case, "ocr", "merged")

        self._merge("--source", base)
        self._merge("--source", base, "--split-pages", "2")
        names = sorted(name for name in os.listdir(merged_dir) if name.startswith(base))
        index = load(os.path.join(self.case, "ocr", "index.json"))
        entry = next(item for item in index["sources"] if item["sourceId"] == base)
        self.assertEqual(sorted(os.path.basename(item) for item in entry["mergedParts"]), names,
                         "分卷模式下不得残留单文件旧正文")
        self.assertNotIn(base + ".txt", names)

        self._merge("--source", base)
        names = sorted(name for name in os.listdir(merged_dir) if name.startswith(base))
        self.assertEqual([base + ".txt"], names, "回到单文件时不得残留 part 分卷")

    def test_16_merge_digest_is_recomputable_from_file_bytes(self):
        """mergedDigest 能直接从文件字节重算（换行不随平台翻译）。"""
        report = self._source("材料-源/报告.pdf")
        _code, payload = self._merge("--source", report["sourceId"])
        digest = payload["merged"][0]["mergedDigest"]
        path = os.path.join(self.case, "ocr", "merged", report["sourceId"] + ".txt")
        with open(path, "rb") as handle:
            data = handle.read()
        body = data.split(b"\n", 1)[1]
        self.assertTrue(body.endswith(b"\n"), "正文必须以单个 LF 结尾")
        self.assertNotIn(b"\r\n", data, "换行不得被平台翻译成 CRLF")
        self.assertEqual(hashlib.sha256(body[:-1]).hexdigest(), digest)

    def test_10_merge_orders_pages_and_labels_sources(self):
        self.prepare()
        report = self._source("材料-源/报告.pdf")
        scanned_page = report["pages"][1]
        self._record(report, [{"page": 2, "status": "recognized",
                               "text": "第二页正文（扫描页）",
                               "imageSha256": scanned_page["imageSha256"]}])

        code, payload = self._merge("--source", report["sourceId"])
        self.assertEqual(code, 0, payload)
        text = self._merged_text(report["sourceId"])
        positions = [text.index("第 %d 页" % n) for n in (1, 2, 3)]
        self.assertEqual(positions, sorted(positions), "页序必须严格递增")
        self.assertIn("来源: 页图判读", text)
        self.assertIn("来源: 文本层", text)
        self.assertIn("sha256: " + scanned_page["imageSha256"][:12], text)
        self.assertIn("第二页正文（扫描页）", text)

        index = load(os.path.join(self.case, "ocr", "index.json"))
        merged = next(item for item in index["sources"] if item["sourceId"] == report["sourceId"])
        self.assertEqual(merged["mergedTextPath"],
                         "ocr/merged/%s.txt" % report["sourceId"])
        self.assertEqual(3, merged["mergedPages"])

    def test_11_merge_placeholder_for_pending_page(self):
        photo = self._source("材料-源/现场照片.jpg")
        code, payload = self._merge("--source", photo["sourceId"])
        self.assertEqual(code, 0, payload)
        text = self._merged_text(photo["sourceId"])
        self.assertIn("[第 1 页 未判读：pending]", text)
        self.assertNotIn("===== 第 1 页 | 来源: 未判读 | sha256:  |", text)

    def test_12_merge_falls_back_to_text_layer_when_recognition_unreadable(self):
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 3, "status": "unreadable"}])
        code, payload = self._merge("--source", report["sourceId"])
        self.assertEqual(code, 0, payload)
        text = self._merged_text(report["sourceId"])
        page3 = text.split("第 3 页", 1)[1]
        self.assertIn("来源: 文本层", page3)
        self.assertNotIn("未判读", page3, "有文本层的页不该因判读失败被写成占位")

    def test_13_merge_split_pages_writes_contiguous_parts(self):
        report = self._source("材料-源/报告.pdf")
        code, payload = self._merge("--source", report["sourceId"], "--split-pages", "1")
        self.assertEqual(code, 0, payload)
        merged_dir = os.path.join(self.case, "ocr", "merged")
        parts = sorted(name for name in os.listdir(merged_dir)
                       if name.startswith(report["sourceId"] + ".part"))
        self.assertEqual(3, len(parts), parts)
        index = load(os.path.join(self.case, "ocr", "index.json"))
        entry = next(item for item in index["sources"] if item["sourceId"] == report["sourceId"])
        self.assertEqual(3, len(entry["mergedParts"]))
        self.assertEqual(entry["mergedParts"][0], "ocr/merged/" + parts[0])
        seen = []
        for name in parts:
            with open(os.path.join(merged_dir, name), encoding="utf-8") as handle:
                first = handle.read().splitlines()[1]
            seen.append(int(first.split("第 ")[1].split(" 页")[0]))
        self.assertEqual([1, 2, 3], seen, "分卷必须按页序连续")

    def test_14_merge_digest_covers_body_only(self):
        report = self._source("材料-源/报告.pdf")
        _code, first = self._merge("--source", report["sourceId"])
        _code, second = self._merge("--source", report["sourceId"])
        self.assertEqual(first["merged"][0]["mergedDigest"], second["merged"][0]["mergedDigest"],
                         "无新证据时重跑必须得到同一摘要")

        self._record(report, [{"page": 1, "status": "recognized", "text": "第一页补记的新正文"}])
        _code, third = self._merge("--source", report["sourceId"])
        self.assertNotEqual(first["merged"][0]["mergedDigest"], third["merged"][0]["mergedDigest"])
        self.assertIn("第一页补记的新正文", self._merged_text(report["sourceId"]))

    # ---- 17-22：分级、策略、渲染变体、tile 与预算 ----
    def _clean_ocr(self):
        shutil.rmtree(os.path.join(self.case, "ocr"), ignore_errors=True)

    def _index_source(self, relative):
        index = load(os.path.join(self.case, "ocr", "index.json"))
        return next(item for item in index["sources"] if item["relativePath"] == relative)

    def test_17_policy_fast_keeps_base_dpi_and_no_double_read(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--policy", "fast")
        pages = self._index_source("材料-源/报告.pdf")["pages"]
        self.assertEqual([144] * 3, [page["policy"]["dpi"] for page in pages])
        self.assertEqual(["none"] * 3, [page["policy"]["mode"] for page in pages])
        self.assertEqual([False] * 3, [page["policy"]["doubleRead"] for page in pages])

    def test_18_auto_marks_scan_and_empty_pages_high(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--only", "材料-源/现场照片.jpg")
        report = self._index_source("材料-源/报告.pdf")["pages"]
        self.assertEqual("high", report[1]["riskTier"])
        self.assertEqual(200, report[1]["policy"]["dpi"])
        self.assertEqual("normal", report[0]["riskTier"])
        photo = self._index_source("材料-源/现场照片.jpg")["pages"][0]
        self.assertEqual(("image", "high", 200),
                         (photo["pageClass"], photo["riskTier"], photo["policy"]["dpi"]))

    def test_19_tile_render_writes_full_page_and_four_crops(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2",
                     "--dpi", "200", "--mode", "tile")
        page = self._index_source("材料-源/报告.pdf")["pages"][1]
        render = page["renders"][1]
        self.assertEqual("tile", render["mode"])
        self.assertEqual(4, len(render["tiles"]))
        self.assertTrue(render["image"].endswith("@200.png"))
        self.assertTrue(os.path.isfile(os.path.join(self.case, *render["image"].split("/"))))
        for tile in render["tiles"]:
            self.assertTrue(os.path.isfile(os.path.join(self.case, *tile["image"].split("/"))))
        self.assertGreater(render["tiles"][0]["height"], page["height"] // 2,
                           "裁切必须带重叠，高度应超过整页的一半")
        self.assertEqual("tile", page["policy"]["mode"])
        self.assertEqual(200, page["policy"]["dpi"])

    def test_20_re_render_adds_variant_without_touching_other_pages(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        before = self._index_source("材料-源/报告.pdf")["pages"]
        stamps = {page["page"]: page["renders"][0]["imageSha256"] for page in before}
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "300")
        after = self._index_source("材料-源/报告.pdf")["pages"]
        self.assertEqual(2, len(after[1]["renders"]))
        self.assertTrue(after[1]["renders"][1]["image"].endswith("@300.png"))
        self.assertEqual(stamps[1], after[0]["renders"][0]["imageSha256"])
        self.assertEqual(stamps[3], after[2]["renders"][0]["imageSha256"])
        index = load(os.path.join(self.case, "ocr", "index.json"))
        self.assertEqual(1, index["budget"]["doubleReads"])

    def test_21_re_render_is_idempotent(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                     "--re-render", "pages:2", "--dpi", "300")
        self.assertEqual(0, code, payload)
        first = self._index_source("材料-源/报告.pdf")["pages"][1]["renders"][1]["imageSha256"]
        code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                     "--re-render", "pages:2", "--dpi", "300")
        self.assertEqual(0, code, msg=str(payload))
        page = self._index_source("材料-源/报告.pdf")["pages"][1]
        self.assertEqual(2, len(page["renders"]))
        self.assertEqual(first, page["renders"][1]["imageSha256"])
        self.assertEqual(1, load(os.path.join(self.case, "ocr", "index.json"))["budget"]["doubleReads"])

    def test_22_risk_rules_and_budget_formula(self):
        self.assertEqual(144, ocr_prepare.initial_dpi("auto", "high", 120, 144))
        self.assertEqual(200, ocr_prepare.initial_dpi("quality", "high", 120, 144))
        self.assertEqual(300, ocr_prepare.initial_dpi("auto", "high", 3, 300))
        self.assertEqual("scan", ocr_prepare.page_class("pdf", "garbled"))
        self.assertEqual("high", ocr_prepare.initial_risk("pdf", "garbled", ["text-garbled"]))
        self.assertIn("text-garbled",
                      ocr_prepare.visual_reasons("pdf", "garbled", "乱码", "auto", set(), 1))
        self.assertEqual({"pagesRequired": 42, "maxDoubleReads": 9, "doubleReads": 0,
                          "imageCalls": 0, "elapsedMs": 0, "exhausted": False},
                         ocr_prepare.budget_for(42, "auto", None))
        self.assertEqual(1, ocr_prepare.budget_for(1, "auto", None)["maxDoubleReads"])
        self.assertEqual(5, ocr_prepare.budget_for(42, "auto", 5)["maxDoubleReads"])
        self.assertEqual(0, ocr_prepare.budget_for(42, "auto", 0)["maxDoubleReads"])


    # ---- 23-28：关键字段校验、双读冲突、升级与视觉缺失 ----
    def test_23_quote_must_be_in_page_text(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        code, payload = self._record_raw(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,678.00 元",
            "keyValues": [{"label": "评估值", "value": "12345678.00",
                           "quote": "评估值：人民币 12,345,687.00 元"}],
        }])
        self.assertEqual(2, code)
        self.assertEqual("input", payload["errorKind"])
        self.assertIn("quote", payload["error"])

    def test_24_two_reads_with_different_values_mark_conflict(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,678.00 元",
            "keyValues": [{"label": "评估值", "value": "12345678.00",
                           "quote": "评估值：人民币 12,345,678.00 元"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        payload = self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,687.00 元",
            "keyValues": [{"label": "评估值", "value": "12345687.00",
                           "quote": "评估值：人民币 12,345,687.00 元"}],
            "uncertainties": ["第二次判读"]}])
        self.assertTrue(payload["ok"], payload)
        recognition = load(os.path.join(self.case, "ocr", "recognition", report["sourceId"] + ".json"))
        page = recognition["pages"][0]
        self.assertEqual("conflict", page["recognitionStatus"])
        self.assertEqual([{"field": "评估值", "values": ["12345678.00", "12345687.00"], "reads": [1, 2]}],
                         page["conflicts"])
        self.assertEqual([1, 2], [read["n"] for read in page["reads"]])

    def test_25_dense_table_escalates_to_tile(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        rows = [["科目", "评估值"]] + [["行%d" % i, str(i)] for i in range(11)]
        payload = self._record(report, [{
            "page": 3, "status": "recognized", "text": "表格见下",
            "tables": [{"title": "评估结果", "rows": rows}]}])
        self.assertEqual([{"page": 3, "mode": "tile", "priority": "table"}], payload["escalate"])

    def test_26_escalation_stops_when_budget_is_spent(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "0")
        report = self._source("材料-源/报告.pdf")
        rows = [["科目", "评估值"]] + [["行%d" % i, str(i)] for i in range(11)]
        payload = self._record(report, [{
            "page": 3, "status": "recognized", "text": "表格见下",
            "tables": [{"title": "评估结果", "rows": rows}]}])
        self.assertEqual([], payload["escalate"])

    def test_27_vision_unavailable_marks_pending_without_guessing(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        code, payload = run(RECORD, ["--case", self.case, "--vision-unavailable"], self.case)
        self.assertEqual(3, code)
        self.assertEqual("capability-gap", payload["errorKind"])
        source = self._index_source("材料-源/报告.pdf")
        pending = [page for page in source["pages"] if page["visualStatus"] == "pending"]
        self.assertTrue(pending)
        self.assertTrue(all(page["pendingReason"] == "vision-unavailable" for page in pending))

    def test_28_re_rendered_page_rejects_old_record(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        old_sha = self._index_source("材料-源/报告.pdf")["pages"][1]["imageSha256"]
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "300")
        code, payload = self._record_raw(report, [{
            "page": 2, "status": "recognized", "text": "旧图上的判读", "imageSha256": old_sha}])
        self.assertEqual(2, code)
        self.assertEqual("stale", payload["errorKind"])


    def test_29_status_reports_conflict_and_pending(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,678.00 元",
            "keyValues": [{"label": "评估值", "value": "12345678.00",
                           "quote": "评估值：人民币 12,345,678.00 元"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,687.00 元",
            "keyValues": [{"label": "评估值", "value": "12345687.00",
                           "quote": "评估值：人民币 12,345,687.00 元"}]}])
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(0, code, payload)
        self.assertEqual([{"sourceId": report["sourceId"], "relativePath": "材料-源/报告.pdf",
                           "page": 1, "fields": ["评估值"]}], payload["conflictPages"])
        reasons = {item["page"]: item["reason"] for item in payload["notVerified"]}
        self.assertEqual("conflict", reasons[1])
        self.assertEqual("pending", reasons[2])

    def test_30_budget_exhaustion_is_not_unread(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "0")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 2, "status": "recognized", "text": "第二页正文"}])
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(0, code, payload)
        self.assertTrue(payload["budgetExhausted"])
        self.assertNotIn(2, {item["page"] for item in payload["notVerified"]},
                         "预算耗尽只停止双读，不得把已读页记成未核")


    def test_31_merge_marks_conflict_page(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,678.00 元",
            "keyValues": [{"label": "评估值", "value": "12345678.00",
                           "quote": "评估值：人民币 12,345,678.00 元"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,687.00 元",
            "keyValues": [{"label": "评估值", "value": "12345687.00",
                           "quote": "评估值：人民币 12,345,687.00 元"}]}])
        self._merge("--source", report["sourceId"])
        text = self._merged_text(report["sourceId"])
        self.assertIn("状态: conflict", text)
        self.assertIn("[冲突：评估值 12345678.00 / 12345687.00", text)
        self.assertIn("档位: normal/2 次", text, "第 1 页有文本层，档位应为 normal")

    def test_32_merge_accepts_legacy_recognition(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        legacy = {"schemaVersion": 1, "sourceId": report["sourceId"],
                  "pages": [{"page": 1, "status": "recognized", "text": "旧格式正文"}]}
        recognition_dir = os.path.join(self.case, "ocr", "recognition")
        os.makedirs(recognition_dir, exist_ok=True)
        dump(os.path.join(recognition_dir, report["sourceId"] + ".json"), legacy)
        code, payload = self._merge("--source", report["sourceId"])
        self.assertEqual(0, code, payload)
        self.assertIn("旧格式正文", self._merged_text(report["sourceId"]))


    # ---- 33-41：复核修复（force / 重渲语义 / 冲突 / 预算 / 未核原因）----
    def test_33_force_rerenders_even_when_cache_matches(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
        code, payload = self.prepare("--only", "材料-源/报告.pdf", "--force", "--force-budget", "--budget", "1")
        self.assertEqual(0, code, payload)
        page = self._index_source("材料-源/报告.pdf")["pages"][0]
        self.assertEqual(2, len(page["renders"]))
        self.assertEqual([1, 2], [item["n"] for item in page["renders"]])
        self.assertGreater(load(os.path.join(self.case, "ocr", "index.json"))["budget"]["exceededBy"], 0)

    def test_34_re_rendered_text_page_stays_pending(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        page = self._index_source("材料-源/报告.pdf")["pages"][0]
        self.assertEqual("pending", page["visualStatus"])
        self.assertIn("render-escalated", page["visualReasons"])

    def test_35_re_render_does_not_touch_unlisted_pages_under_other_policy(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--policy", "fast")
        before = {page["page"]: page["imageSha256"]
                  for page in self._index_source("材料-源/报告.pdf")["pages"]}
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "300")
        pages = {page["page"]: page for page in self._index_source("材料-源/报告.pdf")["pages"]}
        self.assertEqual(before[1], pages[1]["imageSha256"])
        self.assertEqual(before[3], pages[3]["imageSha256"])
        self.assertEqual(1, len(pages[1]["renders"]))
        self.assertEqual(1, len(pages[3]["renders"]))

    def test_36_merge_does_not_print_stale_record_under_new_sha(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 1, "status": "recognized", "text": "旧图上的正文"}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        self._merge("--source", report["sourceId"])
        text = self._merged_text(report["sourceId"])
        self.assertNotIn("旧图上的正文", text)
        self.assertIn("[第 1 页 未判读：stale-record]", text)

    def test_37_a_label_missing_from_the_second_read_is_a_conflict(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        text = "评估值：人民币 12,345,678.00 元 面积：100 平方米"
        self._record(report, [{
            "page": 1, "status": "recognized", "text": text,
            "keyValues": [
                {"label": "评估值", "value": "12345678.00", "quote": "评估值：人民币 12,345,678.00 元"},
                {"label": "面积", "value": "100", "quote": "面积：100 平方米"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        self._record(report, [{
            "page": 1, "status": "recognized", "text": "评估值：人民币 12,345,678.00 元",
            "keyValues": [
                {"label": "评估值", "value": "12345678.00", "quote": "评估值：人民币 12,345,678.00 元"}]}])
        recognition = load(os.path.join(self.case, "ocr", "recognition", report["sourceId"] + ".json"))
        conflicts = recognition["pages"][0]["conflicts"]
        self.assertIn({"field": "面积", "values": ["100", None], "reads": [1, 2]}, conflicts)

    def test_38_pages_read_survives_a_prepare_rerun(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 2, "status": "recognized", "text": "第二页正文"}])
        self.prepare("--only", "材料-源/报告.pdf")
        index = load(os.path.join(self.case, "ocr", "index.json"))
        self.assertEqual(1, index["budget"]["pagesRead"])

    def test_39_pending_reason_survives_a_prepare_rerun(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        run(RECORD, ["--case", self.case, "--vision-unavailable"], self.case)
        self.prepare("--only", "材料-源/报告.pdf")
        page = self._index_source("材料-源/报告.pdf")["pages"][1]
        self.assertEqual("vision-unavailable", page["pendingReason"])

    def test_40_re_render_without_dpi_uses_at_least_high_dpi(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        # page 2 is already a 200-DPI high-risk page, so the default variant steps up to 300
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2")
        render = self._index_source("材料-源/报告.pdf")["pages"][1]["renders"][1]
        self.assertGreaterEqual(render["dpi"], 200)

    def test_41_recognizer_is_restricted_to_session_vision(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        dump(os.path.join(self.case, "ocr", "recognition-input.json"), {
            "sourceId": report["sourceId"],
            "pages": [{"page": 1, "status": "recognized", "text": "正文"}]})
        code, payload = run(RECORD, ["--case", self.case, "--input", "ocr/recognition-input.json",
                                     "--recognizer", "external:fake@1"], self.case)
        self.assertEqual(2, code)
        self.assertEqual("input", payload["errorKind"])


    def test_42_resolution_ceiling_is_reported_not_blocking(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                     "--re-render", "pages:2", "--dpi", "600")
        self.assertEqual(0, code, payload)
        index = load(os.path.join(self.case, "ocr", "index.json"))
        self.assertTrue(any("有效宽度" in note for note in index["render"]["engineNotes"]),
                        index["render"]["engineNotes"])


    def test_43_re_render_over_budget_is_rejected(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
        before = load(os.path.join(self.case, "ocr", "index.json"))["sources"]
        code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                     "--re-render", "pages:1,2", "--budget", "1")
        self.assertEqual(2, code, payload)
        self.assertEqual("input", payload["errorKind"])
        self.assertIn("--force-budget", payload["error"])
        after = load(os.path.join(self.case, "ocr", "index.json"))["sources"]
        self.assertEqual(before, after)

    def test_44_force_budget_records_the_overrun(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
        code, payload = self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1,2",
                                     "--budget", "1", "--force-budget")
        self.assertEqual(0, code, payload)
        budget = load(os.path.join(self.case, "ocr", "index.json"))["budget"]
        self.assertEqual(1, budget["exceededBy"])

    def test_45_budget_zero_rejects_every_re_render(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "0")
        code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                     "--re-render", "pages:2", "--budget", "0")
        self.assertEqual(2, code, payload)
        self.assertIn("--force-budget", payload["error"])

    def test_46_unknown_page_re_render_is_rejected(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        code, payload = self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:9")
        self.assertEqual(2, code, payload)
        self.assertEqual("input", payload["errorKind"])

    def test_47_escalation_is_prioritized_and_capped(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--visual", "all", "--budget", "2")
        report = self._source("材料-源/报告.pdf")
        rows = [["科目", "评估值"]] + [["行%d" % i, str(i)] for i in range(11)]
        payload = self._record(report, [
            {"page": 1, "status": "recognized", "text": "表见下", "tables": [{"rows": rows}]},
            {"page": 2, "status": "recognized", "text": "评估值 123 面积 456 日期 789",
             "keyValues": [
                 {"label": "评估值", "value": "123", "quote": "评估值 123"},
                 {"label": "面积", "value": "456", "quote": "面积 456"},
                 {"label": "日期", "value": "789", "quote": "日期 789"}]},
            {"page": 3, "status": "recognized", "text": "页脚", "uncertainties": ["小字模糊"]},
        ])
        self.assertEqual(2, len(payload["escalate"]))
        self.assertEqual(["table", "keyValues"], [item["priority"] for item in payload["escalate"]])
        self.assertEqual([1, 2], [item["page"] for item in payload["escalate"]])

    def test_48_status_actions_match_actual_reads(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 1, "status": "recognized", "text": "第一页"},
                              {"page": 2, "status": "recognized", "text": "第二页"}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--budget", "1")
        code, pending = run(STATUS, ["--case", self.case], self.case)
        self.assertTrue(any(2 in item["pages"] for item in pending["pending"]),
                        "重渲后未重读的页必须仍是 pending")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 2, "status": "recognized", "text": "第二页"}])
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(0, code, payload)
        self.assertTrue(any("1 页双读" in action for action in payload["actions"]), payload["actions"])

    def test_49_legacy_index_without_budget_still_works(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        path = os.path.join(self.case, "ocr", "index.json")
        index = load(path); index.pop("budget", None); dump(path, index)
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(0, code, payload)

    def test_50_merge_header_shows_orientation(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 2, "status": "recognized", "orientation": "unknown",
                               "text": "未声明方向的页面"}])
        self._merge("--source", report["sourceId"])
        merged = self._merged_text(report["sourceId"])
        self.assertNotIn("方向:", merged, "unknown orientation must not print a direction")
        self._record(report, [{"page": 2, "status": "recognized", "orientation": "rotated-90",
                               "text": "横向页面内容"}])
        self._merge("--source", report["sourceId"])
        merged = self._merged_text(report["sourceId"])
        self.assertIn("方向: rotated-90", merged)

    def test_51_force_without_force_budget_is_rejected(self):
        self._clean_ocr()
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
        before = load(os.path.join(self.case, "ocr", "index.json"))["sources"]
        code, payload = self.prepare("--only", "材料-源/报告.pdf", "--force", "--budget", "1")
        self.assertEqual(2, code, payload)
        self.assertIn("--force-budget", payload["error"])
        after = load(os.path.join(self.case, "ocr", "index.json"))["sources"]
        self.assertEqual(before, after)

    def test_52_re_render_needs_an_index_and_writes_nothing_when_rejected(self):
        self._clean_ocr()
        code, payload = self.prepare("--re-render", "pages:9")
        self.assertEqual(2, code, payload)
        self.assertFalse(os.path.exists(os.path.join(self.case, "ocr", "pages")),
                         "a rejected re-render must not write page images")

if __name__ == "__main__":
    unittest.main(verbosity=2)
