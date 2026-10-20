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
            self.assertRegex(os.path.basename(page["image"]), r"^报告_page000[1-3]\.png$")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
