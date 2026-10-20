"""Contract tests for the portable crwu-h3yun bundle builder.

Run with ``make h3yun-bundle-check`` or ``python3 scripts/test_build_h3yun_bundle.py``.
"""

from __future__ import annotations

import struct
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from build_h3yun_bundle import BUNDLE_DIR, BundleError, build_bundle

GENERATED_AT = datetime(2026, 10, 20, 8, 0, 0, tzinfo=timezone.utc)
DOCS_DIR = Path(__file__).resolve().parent / "h3yun-bundle"


def macho_arm64(size: int = 256) -> bytes:
    return b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x0100000C) + b"\x00" * (size - 8)


def pe_amd64(size: int = 512) -> bytes:
    data = bytearray(b"\x00" * size)
    data[0:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\x00\x00"
    struct.pack_into("<H", data, 0x84, 0x8664)
    return bytes(data)


def write_fixture(root: Path, *, macho: bytes | None = None, pe: bytes | None = None) -> dict:
    bin_dir = root / "bin"
    (bin_dir / "darwin").mkdir(parents=True)
    (bin_dir / "windows").mkdir(parents=True)
    (bin_dir / "darwin" / "crwu").write_bytes(macho or macho_arm64())
    (bin_dir / "windows" / "crwu.exe").write_bytes(pe or pe_amd64())

    skills_root = root / "skills"
    login = skills_root / "crwu-h3yun-login"
    query = skills_root / "crwu-h3yun-query"
    (login / "references").mkdir(parents=True)
    query.mkdir(parents=True)
    (login / "SKILL.md").write_text("login skill\n", encoding="utf-8")
    (login / "references" / "notes.md").write_text("login notes\n", encoding="utf-8")
    (query / "SKILL.md").write_text("query skill\n", encoding="utf-8")

    return {
        "repo_root": root,
        "bin_dir": bin_dir,
        "skills_root": skills_root,
        "docs_dir": DOCS_DIR,
        "out": root / "dist" / "bundle.zip",
    }


def build(fixture: dict, **overrides) -> dict:
    options = {
        "repo_root": fixture["repo_root"],
        "bin_dir": fixture["bin_dir"],
        "skills_root": fixture["skills_root"],
        "docs_dir": fixture["docs_dir"],
        "out_path": fixture["out"],
        "version": "9.9.9",
        "commit": "abc1234",
        "generated_at": GENERATED_AT,
    }
    options.update(overrides)
    return build_bundle(**options)


class BundleLayoutTest(unittest.TestCase):
    def test_builds_exact_layout_with_modes_and_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            result = build(fixture)

            expected = [
                f"{BUNDLE_DIR}/VERSION.txt",
                f"{BUNDLE_DIR}/AGENTS.md",
                f"{BUNDLE_DIR}/README.md",
                f"{BUNDLE_DIR}/PROMPT.md",
                f"{BUNDLE_DIR}/bin/darwin-arm64/crwu",
                f"{BUNDLE_DIR}/bin/win32-x64/crwu.exe",
                f"{BUNDLE_DIR}/skills/crwu-h3yun-login/SKILL.md",
                f"{BUNDLE_DIR}/skills/crwu-h3yun-login/references/notes.md",
                f"{BUNDLE_DIR}/skills/crwu-h3yun-query/SKILL.md",
            ]
            self.assertEqual(result["names"], expected)

            with zipfile.ZipFile(fixture["out"]) as archive:
                modes = {
                    info.filename: (info.external_attr >> 16) & 0o777
                    for info in archive.infolist()
                }
                self.assertEqual(modes[f"{BUNDLE_DIR}/bin/darwin-arm64/crwu"], 0o755)
                self.assertEqual(modes[f"{BUNDLE_DIR}/bin/win32-x64/crwu.exe"], 0o644)
                self.assertEqual(modes[f"{BUNDLE_DIR}/AGENTS.md"], 0o644)
                self.assertEqual(archive.read(f"{BUNDLE_DIR}/skills/crwu-h3yun-query/SKILL.md"),
                                 b"query skill\n")

                version_text = archive.read(f"{BUNDLE_DIR}/VERSION.txt").decode("utf-8")
                self.assertIn("version: 9.9.9", version_text)
                self.assertIn("commit: abc1234", version_text)
                self.assertIn("generatedAt: 2026-10-20T08:00:00Z", version_text)
                self.assertIn(f"{BUNDLE_DIR}/bin/darwin-arm64/crwu".replace(f"{BUNDLE_DIR}/", ""),
                              version_text)
                for info in archive.infolist():
                    self.assertTrue(info.filename.isascii(), info.filename)

    def test_version_file_hashes_every_entry_except_itself(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            build(fixture)
            with zipfile.ZipFile(fixture["out"]) as archive:
                version_text = archive.read(f"{BUNDLE_DIR}/VERSION.txt").decode("utf-8")
            listed = {
                line.split("  ", 1)[1]
                for line in version_text.splitlines()
                if "  " in line and not line.startswith("#")
            }
            self.assertEqual(listed, {
                "AGENTS.md",
                "README.md",
                "PROMPT.md",
                "bin/darwin-arm64/crwu",
                "bin/win32-x64/crwu.exe",
                "skills/crwu-h3yun-login/SKILL.md",
                "skills/crwu-h3yun-login/references/notes.md",
                "skills/crwu-h3yun-query/SKILL.md",
            })

    def test_bundle_carries_absolute_path_contract_not_install(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            build(fixture)
            with zipfile.ZipFile(fixture["out"]) as archive:
                agents = archive.read(f"{BUNDLE_DIR}/AGENTS.md").decode("utf-8")
                prompt = archive.read(f"{BUNDLE_DIR}/PROMPT.md").decode("utf-8")
                readme = archive.read(f"{BUNDLE_DIR}/README.md").decode("utf-8")
            for text in (agents, prompt, readme):
                self.assertIn("不要安装", text)
            self.assertIn("bin/darwin-arm64/crwu", agents)
            self.assertIn("CRWU_BROWSER_PROFILE", agents)
            self.assertIn("xattr -dr com.apple.quarantine", agents)
            self.assertIn("提示词 ②", prompt)
            self.assertIn("VERSION.txt", readme)

    def test_skips_ds_store_and_pycache(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            skill = fixture["skills_root"] / "crwu-h3yun-query"
            (skill / ".DS_Store").write_bytes(b"junk")
            (skill / "__pycache__").mkdir()
            (skill / "__pycache__" / "x.pyc").write_bytes(b"junk")
            result = build(fixture)
            self.assertNotIn(f"{BUNDLE_DIR}/skills/crwu-h3yun-query/.DS_Store", result["names"])
            self.assertNotIn(f"{BUNDLE_DIR}/skills/crwu-h3yun-query/__pycache__/x.pyc",
                             result["names"])


class BundleRejectionTest(unittest.TestCase):
    def assert_rejected(self, fixture: dict, pattern: str, **overrides) -> None:
        with self.assertRaisesRegex(BundleError, pattern):
            build(fixture, **overrides)

    def test_rejects_non_arm64_macho(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            bad = b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x01000007) + b"\x00" * 64
            (fixture["bin_dir"] / "darwin" / "crwu").write_bytes(bad)
            self.assert_rejected(fixture, "not arm64")

    def test_rejects_non_amd64_pe(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            bad = bytearray(pe_amd64())
            struct.pack_into("<H", bad, 0x84, 0xAA64)
            (fixture["bin_dir"] / "windows" / "crwu.exe").write_bytes(bytes(bad))
            self.assert_rejected(fixture, "not x86-64")

    def test_rejects_unknown_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            (fixture["bin_dir"] / "darwin" / "crwu").write_bytes(b"not a binary")
            self.assert_rejected(fixture, "not a 64-bit")

    def test_rejects_missing_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            (fixture["bin_dir"] / "windows" / "crwu.exe").unlink()
            self.assert_rejected(fixture, "missing binary")

    def test_rejects_skill_without_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            (fixture["skills_root"] / "crwu-h3yun-login" / "SKILL.md").unlink()
            self.assert_rejected(fixture, "missing skill entry")

    def test_rejects_non_ascii_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            (fixture["skills_root"] / "crwu-h3yun-query" / "说明.md").write_text(
                "中文文件名\n", encoding="utf-8")
            self.assert_rejected(fixture, "ASCII-only")

    def test_rejects_missing_document(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = write_fixture(Path(temp))
            empty_docs = Path(temp) / "docs"
            empty_docs.mkdir()
            self.assert_rejected(fixture, "missing entry document", docs_dir=empty_docs)


if __name__ == "__main__":
    unittest.main()
