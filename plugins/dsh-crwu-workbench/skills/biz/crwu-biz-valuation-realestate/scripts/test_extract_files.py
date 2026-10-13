#!/usr/bin/env python3
"""`extract_files.py` 的契约测试（报告评估多类型资料提取）。

钉住的是**降级语义**，不是"能不能解析某个格式"：

1. 输出必须是固定形状的合法 JSON（上层按字段读，缺字段会一路变成 `undefined`）；
2. 缺库 / 旧版二进制 Office / 无文本层 PDF / 压缩包 —— 一律进 `capabilityGaps`，
   并且**绝不产出 `extractedFields`**（"读不出来"与"读到了空"必须有区别）；
3. `extractedFields` 只做**标签锚定**：没有标签的行不产生字段，值保持原文；
4. 名字与扩展名不认识时也说得出话（不是抛异常）；
5. 单份文件读不出来不影响脚本进程本身（退出码 0 + 结果文件存在）。

图像 / Word / Excel 的具体解析依赖 openpyxl / python-docx / Pillow；缺失时**跳过**那几条
而不是失败 —— 那是运行时的能力差异，不是脚本的缺陷。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract_files.py")


def run_script(source_path: str, workdir: str) -> dict:
    """跑一次脚本，返回解析后的 JSON（结果文件必须存在）。"""
    out_path = os.path.join(workdir, "out.json")
    completed = subprocess.run(
        [sys.executable, SCRIPT, source_path, out_path],
        capture_output=True, text=True, timeout=120, check=False,
    )
    if not os.path.isfile(out_path):
        raise AssertionError(f"脚本没有写出结果文件：stdout={completed.stdout!r} stderr={completed.stderr!r}")
    with open(out_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


SHAPE = ("ok", "error", "fileName", "fileType", "text", "tables", "images",
         "extractedFields", "warnings", "capabilityGaps")


class ExtractContractTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="crwu-extract-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name: str, content: str) -> str:
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path

    def assertShape(self, payload: dict) -> None:
        for key in SHAPE:
            self.assertIn(key, payload, f"结果缺字段 {key}")
        self.assertIsInstance(payload["ok"], bool)
        self.assertIsInstance(payload["tables"], list)
        self.assertIsInstance(payload["images"], list)
        self.assertIsInstance(payload["extractedFields"], dict)
        self.assertIsInstance(payload["warnings"], list)
        self.assertIsInstance(payload["capabilityGaps"], list)
        for key, value in payload["extractedFields"].items():
            self.assertIsInstance(value, str, f"字段 {key} 的值必须是字符串")

    # ── 文本 ────────────────────────────────────────────────────────────────

    def test_text_file_yields_original_text_and_label_anchored_fields(self):
        path = self.write("a.txt", "坐落：某市某区某路 1 号\n用途：住宅\n建筑面积：120.5 ㎡\n")
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["fileType"], "text")
        self.assertIn("某路 1 号", payload["text"])
        self.assertEqual(payload["extractedFields"]["坐落"], "某市某区某路 1 号")
        self.assertEqual(payload["extractedFields"]["用途"], "住宅")
        self.assertEqual(payload["extractedFields"]["建筑面积"], "120.5 ㎡")

    def test_fields_are_only_label_anchored_never_inferred(self):
        # 没有标签的正文一个字段都不许出现（"1 号"不是坐落，"120 平"不是建筑面积）。
        path = self.write("b.txt", "这是一段没有标签的描述：某路 1 号，大约 120 平方米，1998 年建成。\n")
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertEqual(payload["extractedFields"], {}, "不许从无标签正文里推断字段")

    def test_gbk_text_is_decoded_and_reported(self):
        path = os.path.join(self.dir, "c.txt")
        with open(path, "wb") as handle:
            handle.write("坐落：某市老城区 3 号\n".encode("gb18030"))
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["extractedFields"]["坐落"], "某市老城区 3 号")
        self.assertTrue(any("解码" in item for item in payload["warnings"]), payload["warnings"])

    # ── 只报缺口的类型 ──────────────────────────────────────────────────────

    def test_empty_file_is_an_error_not_a_gap(self):
        path = self.write("empty.txt", "")
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertFalse(payload["ok"])
        self.assertIn("空文件", payload["error"])
        self.assertEqual(payload["extractedFields"], {})

    def test_legacy_binary_office_reports_a_gap_without_fields(self):
        for name, hint in (("老报告.doc", "antiword"), ("老表.xls", "xlrd")):
            path = self.write(name, "not really a binary office file")
            payload = run_script(path, self.dir)
            self.assertShape(payload)
            self.assertFalse(payload["ok"], name)
            self.assertEqual(payload["extractedFields"], {}, name)
            self.assertTrue(any(hint in gap for gap in payload["capabilityGaps"]), payload["capabilityGaps"])

    def test_archive_is_not_expanded_in_this_version(self):
        path = self.write("资料.zip", "PK\x03\x04 not really a zip")
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["extractedFields"], {})
        self.assertTrue(any("压缩包" in gap for gap in payload["capabilityGaps"]), payload["capabilityGaps"])

    def test_unknown_extension_says_so_instead_of_raising(self):
        path = self.write("调研纪要.wps", "内容")
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertFalse(payload["ok"])
        self.assertTrue(any("不认识的文件类型" in gap for gap in payload["capabilityGaps"]), payload["capabilityGaps"])

    def test_image_is_registered_but_content_is_a_gap(self):
        try:
            from PIL import Image  # type: ignore
        except ImportError:
            self.skipTest("本机没有 Pillow：图像条目跳过（脚本的缺口分支已由其它用例覆盖）")
        path = os.path.join(self.dir, "现场.png")
        Image.new("RGB", (32, 16), "white").save(path)
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(len(payload["images"]), 1)
        self.assertIn("32×16", payload["images"][0]["description"])
        self.assertEqual(payload["extractedFields"], {}, "图片不许编造字段")
        self.assertTrue(any("OCR" in gap for gap in payload["capabilityGaps"]), payload["capabilityGaps"])

    def test_pdf_without_a_reader_reports_the_missing_library(self):
        # 无论运行时有没有 PDF 库，都不许出现"编出来的字段"：
        # 有库时可能读到空正文（→ 无文本层缺口），没库时直接报缺库。
        path = os.path.join(self.dir, "报告.pdf")
        with open(path, "wb") as handle:
            handle.write(b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
        payload = run_script(path, self.dir)
        self.assertShape(payload)
        self.assertEqual(payload["extractedFields"], {})
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["capabilityGaps"], "必须给出至少一条能力缺口")

    def test_missing_input_file_is_reported(self):
        payload = run_script(os.path.join(self.dir, "不存在.txt"), self.dir)
        self.assertShape(payload)
        self.assertFalse(payload["ok"])
        self.assertIn("不存在", payload["error"])


class ExtractOfficeTest(unittest.TestCase):
    """Word / Excel 的真实解析（缺库时跳过）。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="crwu-extract-office-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_docx_paragraphs_tables_and_fields(self):
        try:
            import docx  # type: ignore
        except ImportError:
            self.skipTest("本机没有 python-docx")
        path = os.path.join(self.dir, "说明.docx")
        document = docx.Document()
        document.add_paragraph("房屋性质：商品房")
        document.add_paragraph("建筑结构：钢筋混凝土")
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "总层数"
        table.cell(0, 1).text = "18"
        document.save(path)

        payload = run_script(path, self.dir)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["fileType"], "word")
        self.assertEqual(payload["extractedFields"]["房屋性质"], "商品房")
        self.assertEqual(payload["extractedFields"]["建筑结构"], "钢筋混凝土")
        self.assertEqual(payload["extractedFields"]["总楼层"], "18", "表格里的标签锚定也要生效")
        self.assertEqual(len(payload["tables"]), 1)

    def test_xlsx_sheets_become_tables_and_fields(self):
        try:
            import openpyxl  # type: ignore
        except ImportError:
            self.skipTest("本机没有 openpyxl")
        path = os.path.join(self.dir, "计算表.xlsx")
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.title = "基础信息表"
        sheet.append(["坐落", "某市某区某路 2 号"])
        sheet.append(["用途", "商业"])
        sheet.append(["建筑面积", 88.0])
        workbook.save(path)

        payload = run_script(path, self.dir)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["fileType"], "excel")
        self.assertEqual(payload["extractedFields"]["坐落"], "某市某区某路 2 号")
        self.assertEqual(payload["extractedFields"]["用途"], "商业")
        self.assertEqual(payload["extractedFields"]["建筑面积"], "88")
        self.assertEqual(payload["tables"][0]["name"], "基础信息表")
        self.assertIn("基础信息表", payload["tables"][0]["name"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
