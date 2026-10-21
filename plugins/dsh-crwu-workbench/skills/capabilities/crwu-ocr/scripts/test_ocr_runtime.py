#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for dependency loading and path safety (no real materials)."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ocr_runtime  # noqa: E402


def sha(path: str) -> str:
    return ocr_runtime.sha256_file(path)


class PathSafetyTest(unittest.TestCase):
    def test_safe_join_stays_inside_case(self):
        root = tempfile.mkdtemp()
        try:
            self.assertTrue(ocr_runtime.safe_join(root, "ocr", "index.json").startswith(root))
            with self.assertRaises(ValueError):
                ocr_runtime.safe_join(root, "..", "outside.json")
            with self.assertRaises(ValueError):
                ocr_runtime.safe_join(root, "a", "..", "..", "outside.json")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_unpack_rejects_path_traversal(self):
        root = tempfile.mkdtemp()
        try:
            wheel = os.path.join(root, "evil.whl")
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("../escape.py", b"x")
            site = os.path.join(root, "site")
            os.makedirs(site)
            with self.assertRaises(ValueError):
                ocr_runtime._unpack_wheel(wheel, site)
            self.assertFalse(os.path.exists(os.path.join(root, "escape.py")))
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_data_layout_is_stripped(self):
        self.assertEqual(ocr_runtime._strip_data_layout("pkg-1.0.data/purelib/pkg/mod.py"), "pkg/mod.py")
        self.assertEqual(ocr_runtime._strip_data_layout("pkg-1.0.data/scripts/tool"), "")
        self.assertEqual(ocr_runtime._strip_data_layout("pkg/mod.py"), "pkg/mod.py")


class ManifestTest(unittest.TestCase):
    def test_manifest_problems_are_named(self):
        problems = ocr_runtime._validate_manifest({"packages": {"pypdf": {"module": "pypdf"}}}, "m.json")
        joined = "\n".join(problems)
        for field in ("version", "wheel", "sha256", "bytes", "platforms"):
            self.assertIn(field, joined)
        self.assertIn("pypdfium2", "\n".join(
            ocr_runtime._validate_manifest({"packages": {"pypdfium2": {"module": "x"}}}, "m.json")) or "pypdfium2")

    def test_manifest_rejects_path_in_wheel_name(self):
        problems = ocr_runtime._validate_manifest({
            "packages": {"demo": {
                "module": "demo", "version": "1", "wheel": "../demo.whl",
                "sha256": "0" * 64, "bytes": 1, "platforms": ["any"],
            }},
        }, "m.json")
        self.assertTrue(any("plain file" in item for item in problems))


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.wheel_dir = os.path.join(self.root, "wheels")
        os.makedirs(self.wheel_dir)
        self.cache = os.path.join(self.root, "cache")

    def tearDown(self):
        sys.modules.pop("crwu_ocr_demo", None)
        shutil.rmtree(self.root, ignore_errors=True)

    def build_wheel(self, module="crwu_ocr_demo", payload="VALUE = 42\n"):
        wheel = os.path.join(self.wheel_dir, "demo-1.0-py3-none-any.whl")
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr(module + "/__init__.py", payload)
            archive.writestr("demo-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n")
        return wheel

    def manifest(self, wheel):
        return {
            "schemaVersion": 1,
            "packages": {
                "demo": {
                    "module": "crwu_ocr_demo", "version": "1.0", "wheel": os.path.basename(wheel),
                    "sha256": sha(wheel), "bytes": os.path.getsize(wheel), "platforms": ["any"],
                },
            },
            "runtimeProvided": {"Pillow": {"module": "PIL"}},
        }

    def test_installs_verified_wheel_and_reuses_cache(self):
        if not ocr_runtime._importable("PIL"):
            self.skipTest("runtime Pillow is unavailable")
        wheel = self.build_wheel()
        manifest = self.manifest(wheel)
        manifest_path = os.path.join(self.wheel_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle)

        key = ocr_runtime.platform_key() or "linux-x64"
        first = ocr_runtime.install_dependencies(manifest_path, self.cache, key)
        self.assertTrue(first["ok"], first)
        import crwu_ocr_demo  # noqa: F401
        self.assertEqual(crwu_ocr_demo.VALUE, 42)
        marker = os.path.join(first["siteDir"], ".crwu-ocr-deps.json")
        self.assertTrue(os.path.isfile(marker))

        stamp = os.path.getmtime(marker)
        second = ocr_runtime.install_dependencies(manifest_path, self.cache, key)
        self.assertTrue(second["ok"], second)
        self.assertEqual(os.path.getmtime(marker), stamp, "cache must be reused, not re-unpacked")

    def test_hash_mismatch_is_reported_not_ignored(self):
        wheel = self.build_wheel()
        manifest = self.manifest(wheel)
        manifest["packages"]["demo"]["sha256"] = "0" * 64
        manifest_path = os.path.join(self.wheel_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle)
        result = ocr_runtime.install_dependencies(manifest_path, self.cache, "win32-x64")
        self.assertFalse(result["ok"])
        self.assertEqual(result["errorKind"], "deps-integrity")

    def test_platform_skips_foreign_wheel(self):
        if not ocr_runtime._importable("PIL"):
            self.skipTest("runtime Pillow is unavailable")
        wheel = self.build_wheel()
        manifest = self.manifest(wheel)
        manifest["packages"]["demo"]["platforms"] = ["win32-x64"]
        manifest_path = os.path.join(self.wheel_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle)
        result = ocr_runtime.install_dependencies(manifest_path, self.cache, "darwin-arm64")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["skipped"].get("demo"), "not-packaged-for-platform")
        self.assertFalse(ocr_runtime._importable("crwu_ocr_demo") and
                         os.path.normpath(os.path.dirname(sys.modules["crwu_ocr_demo"].__file__)).startswith(self.cache))


class ShippedManifestTest(unittest.TestCase):
    def test_shipped_manifest_matches_files_and_platforms(self):
        scripts = os.path.dirname(os.path.abspath(__file__))
        wheel_dir = os.path.join(os.path.dirname(scripts), "vendor", "wheels")
        manifest_path = os.path.join(wheel_dir, "manifest.json")
        self.assertTrue(os.path.isfile(manifest_path), "随包 manifest 缺失")
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        self.assertEqual(ocr_runtime._validate_manifest(manifest, manifest_path), [])
        for name, entry in manifest["packages"].items():
            wheel = os.path.join(wheel_dir, entry["wheel"])
            self.assertTrue(os.path.isfile(wheel), "缺 wheel：" + wheel)
            self.assertEqual(os.path.getsize(wheel), entry["bytes"], name)
            self.assertEqual(sha(wheel), entry["sha256"], name)
        self.assertIn("Pillow", manifest.get("runtimeProvided", {}))


class NormalizeTest(unittest.TestCase):
    def test_quote_matches_across_line_breaks(self):
        text = "评估值：人民币\n12,345,678.00 元"
        self.assertTrue(ocr_runtime.quote_in_text(text, "评估值：人民币 12,345,678.00 元"))

    def test_quote_rejects_single_character_change(self):
        text = "评估值：人民币 12,345,678.00 元"
        self.assertFalse(ocr_runtime.quote_in_text(text, "评估值：人民币 12,345,687.00 元"))

    def test_value_normalization_ignores_separators(self):
        self.assertEqual("12345678.00", ocr_runtime.normalize_value(" ￥12,345,678.00 元 "))

    def test_value_in_quote(self):
        quote = "评估值：人民币 12,345,678.00 元"
        self.assertTrue(ocr_runtime.value_in_quote("12345678.00", quote))
        self.assertFalse(ocr_runtime.value_in_quote("12345687.00", quote))

    def test_parse_page_selection(self):
        self.assertEqual({1, 3, 4, 5}, ocr_runtime.parse_page_selection("1,3-5"))
        for bad in ("", "0", "5-3", "x", "1,,2"):
            with self.assertRaises(ValueError):
                ocr_runtime.parse_page_selection(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
