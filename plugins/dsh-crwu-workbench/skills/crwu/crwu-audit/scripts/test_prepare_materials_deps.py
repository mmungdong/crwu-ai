#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`prepare_materials.py` 的**随包依赖通道**契约。

为什么单独一个文件：DSH 自带 Python **没有 pypdf**（2026-10-22 现场），而开发机上的系统
`python3` 恰好有 —— 于是"缺 pypdf"这条路径长期只在模拟里成立。这个文件的所有用例都
只依赖随包 wheel，因此在"有 pypdf"和"没有 pypdf"两种解释器上都能跑出同一结论：

1. 没有 `--vendor`／`runtime.json` 时**不得**凭空拿到 pypdf（不猜技能目录）；
2. 给了随包 wheel 就必须能用：文本通道恢复，PDF 走 `textSource=pypdf`，不再进 `ocrRequired`；
3. wheel 被篡改时拒绝加载，退回"缺依赖"的如实记账，绝不加载可疑字节。

由 `make plugin-check` 用 `python3` 与 `$(DSH_PYTHON)` **各跑一次**。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS_DIR.parent
VENDOR = SKILL_DIR / "vendor" / "wheels"
PREPARE = SCRIPTS_DIR / "prepare_materials.py"

# 一行 ≥50 字符，避免被当成"无文本层（疑扫描件）"。
LINE = "评估结论：房屋建筑物账面净值 1,286,762.11 元，评估净值 3,945,302.00 元，增值率 206.00%。"


def _make_pdf(path: Path) -> None:
    """用**随包 pypdf** 造一份带文本层的两页 PDF（不依赖解释器已装 pypdf）。"""
    wheel = next(VENDOR.glob("pypdf-*.whl"))
    if str(wheel) not in sys.path:
        sys.path.insert(0, str(wheel))
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    for _ in range(2):
        page = writer.add_blank_page(width=595, height=842)
        font = DictionaryObject()
        font[NameObject("/Type")] = NameObject("/Font")
        font[NameObject("/Subtype")] = NameObject("/Type1")
        font[NameObject("/BaseFont")] = NameObject("/Helvetica")
        resources = DictionaryObject()
        resources[NameObject("/Font")] = DictionaryObject(
            {NameObject("/F1"): writer._add_object(font)})
        page[NameObject("/Resources")] = resources
        stream = DecodedStreamObject()
        escaped = LINE.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream.set_data(f"BT /F1 12 Tf 40 780 Td ({escaped}) Tj ET".encode("latin-1", "replace"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    with open(path, "wb") as handle:
        writer.write(handle)


def _run(case: Path, extra: list) -> dict:
    """在**子进程**里跑一次盘点，返回材料盘点 JSON。"""
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.run(
        [sys.executable, str(PREPARE), "--case", str(case), *extra],
        capture_output=True, text=True, env=env, cwd=str(case),
    )
    if proc.returncode != 0:
        raise AssertionError(f"prepare_materials 失败：{proc.stderr[-800:]}")
    return json.loads((case / "材料盘点.json").read_text(encoding="utf-8"))


class VendorChannelTest(unittest.TestCase):
    def _case(self) -> Path:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        case = Path(temp.name)
        (case / "材料-源").mkdir()
        _make_pdf(case / "材料-源" / "报告.pdf")
        return case

    @staticmethod
    def _item(payload: dict, name: str) -> dict:
        return next(item for item in payload["items"] if item["name"] == name)

    def test_without_vendor_it_does_not_invent_pypdf(self):
        case = self._case()
        payload = _run(case, [])
        vendored = payload.get("vendoredPython") or {}
        self.assertFalse(vendored.get("activated"), f"没有 --vendor 不得激活随包依赖：{vendored}")
        item = self._item(payload, "报告.pdf")
        # 判据必须问**子进程用的那个解释器**：本进程刚才为了造 PDF 把 wheel 插进了 sys.path。
        has_pypdf = subprocess.run(
            [sys.executable, "-c", "import pypdf"], capture_output=True).returncode == 0
        if has_pypdf:
            self.assertEqual("pypdf", item.get("textSource"), item)
        else:
            self.assertEqual("ocr-required", item.get("textSource"), item)
            gap = (item.get("dependencyGaps") or [{}])[0]
            self.assertEqual("pypdf", gap.get("dependency"), item)
            self.assertEqual("missing", gap.get("state"), item)
            reasons = [entry.get("reason") for entry in payload.get("ocrRequired") or []]
            self.assertIn("pypdf-error", reasons, f"缺 pypdf 的 PDF 必须进 OCR 兜底清单：{reasons}")

    def test_vendor_wheel_restores_the_text_channel(self):
        case = self._case()
        payload = _run(case, ["--vendor", str(VENDOR)])
        vendored = payload.get("vendoredPython") or {}
        self.assertTrue(vendored.get("activated"), f"随包 wheel 必须生效：{vendored}")
        self.assertIn("pypdf", (vendored.get("packages") or {}), vendored)
        self.assertIn("xlrd", (vendored.get("packages") or {}), vendored)
        item = self._item(payload, "报告.pdf")
        self.assertEqual("pypdf", item.get("textSource"), item)
        self.assertIs(True, item.get("readable"), item)
        self.assertGreater(item.get("chars", 0), 50, item)
        reasons = [entry.get("reason") for entry in payload.get("ocrRequired") or []]
        self.assertNotIn("pypdf-error", reasons, f"有文本层就不该进 OCR 兜底：{reasons}")
        self.assertEqual(2, (item.get("textPages") or {}).get("total"), "页数必须真实（不是 0）")

    def test_vendored_xls_channel_is_importable(self):
        """`xlrd` 是 `.xls` 的硬依赖：随包激活后必须真的能 import。

        与 pypdf 同理，判据必须落在**子进程**（干净 sys.path）里：本进程造样例时可能
        已经把 wheel 插进了 sys.path，在这里 import 成功证明不了激活通道有用。
        """
        code = (
            "import json, sys;"
            "sys.path.insert(0, %r);"
            "import prepare_materials as m;"
            "d = m.activate_vendored_python(%r, %r);"
            "import importlib.util;"
            "print(json.dumps({'activated': d['activated'],"
            " 'packages': sorted(d.get('packages') or {}),"
            " 'xlrd': importlib.util.find_spec('xlrd') is not None,"
            " 'pypdf': importlib.util.find_spec('pypdf') is not None,"
            " 'xlsApi': hasattr(__import__('xlrd'), 'open_workbook')}))"
        ) % (str(SCRIPTS_DIR), str(SCRIPTS_DIR), str(VENDOR))
        proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(0, proc.returncode, proc.stderr[-600:])
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["activated"], payload)
        self.assertEqual(["pypdf", "xlrd"], payload["packages"], payload)
        self.assertTrue(payload["xlrd"], "xlrd 必须在激活后可导入")
        self.assertTrue(payload["pypdf"], "pypdf 必须在激活后可导入")
        self.assertTrue(payload["xlsApi"], "xlrd 必须提供 open_workbook（.xls 读取入口）")

    def test_tampered_wheel_is_refused(self):
        case = self._case()
        with tempfile.TemporaryDirectory() as tmp:
            tampered = Path(tmp)
            wheel = tampered / "pypdf-6.21.1-py3-none-any.whl"
            wheel.write_bytes(b"not-a-wheel")
            (tampered / "manifest.json").write_text(json.dumps({
                "schemaVersion": 1,
                "packages": {"pypdf": {
                    "version": "6.21.1", "wheel": wheel.name,
                    "sha256": "0" * 64, "bytes": wheel.stat().st_size,
                }},
            }), encoding="utf-8")
            payload = _run(case, ["--vendor", str(tampered)])
        vendored = payload.get("vendoredPython") or {}
        self.assertFalse(vendored.get("activated"), vendored)
        self.assertIn("sha256", str(vendored.get("reason")), vendored)


if __name__ == "__main__":
    unittest.main(verbosity=2)
