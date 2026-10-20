#!/usr/bin/env python3
"""Build the portable WorkBuddy bundle: crwu binaries + h3yun skills + entry docs.

The bundle is deliberately install-free: nothing lands in PATH, ``~/.workbuddy``
or ``~/.crwu``. Binaries, the browser profile and downloads all stay inside the
extracted directory, so the whole thing can be deleted in one move.

Run through ``make h3yun-bundle``. The script is stdlib-only so it also works on
a maintainer machine that only has Python installed.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import struct
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

BUNDLE_DIR = "crwu-h3yun-bundle"
SKILL_NAMES = ("crwu-h3yun-login", "crwu-h3yun-query")
DOC_SOURCES = (
    ("AGENTS.bundle.md", "AGENTS.md"),
    ("README.md", "README.md"),
    ("PROMPT.md", "PROMPT.md"),
)
# (bundle platform dir, bundle file name, repo-relative path under bin/, mode, binary kind)
BINARIES = (
    ("darwin-arm64", "crwu", Path("darwin") / "crwu", 0o755, "macho-arm64"),
    ("win32-x64", "crwu.exe", Path("windows") / "crwu.exe", 0o644, "pe-amd64"),
)
SKIP_NAMES = {".DS_Store"}
SKIP_DIRS = {"__pycache__"}
MACHO_ARM64_CPUTYPE = 0x0100000C
PE_AMD64_MACHINE = 0x8664
VERSION_PATTERN = re.compile(r'Version\s*=\s*"([^"]+)"')


class BundleError(RuntimeError):
    """Raised when the bundle inputs cannot produce a trustworthy package."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def assert_macho_arm64(data: bytes, label: str) -> None:
    if len(data) < 8 or data[:4] != b"\xcf\xfa\xed\xfe":
        raise BundleError(f"{label}: not a 64-bit little-endian Mach-O binary")
    cputype = struct.unpack_from("<I", data, 4)[0]
    if cputype != MACHO_ARM64_CPUTYPE:
        raise BundleError(
            f"{label}: Mach-O cputype 0x{cputype:08x} is not arm64 "
            "(rebuild with DARWIN_ARCH=arm64)"
        )


def assert_pe_amd64(data: bytes, label: str) -> None:
    if len(data) < 64 or data[:2] != b"MZ":
        raise BundleError(f"{label}: not a PE executable")
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if pe_offset + 6 > len(data) or data[pe_offset : pe_offset + 4] != b"PE\x00\x00":
        raise BundleError(f"{label}: missing PE header")
    machine = struct.unpack_from("<H", data, pe_offset + 4)[0]
    if machine != PE_AMD64_MACHINE:
        raise BundleError(
            f"{label}: PE machine 0x{machine:04x} is not x86-64 "
            "(rebuild with WINDOWS_ARCH=amd64)"
        )


def assert_ascii_relative(arcname: str) -> None:
    if not arcname.isascii():
        raise BundleError(f"bundle path must be ASCII-only: {arcname!r}")
    parts = arcname.split("/")
    if arcname.startswith("/") or "\\" in arcname or any(p in ("", ".", "..") for p in parts):
        raise BundleError(f"bundle path escapes the archive root: {arcname!r}")


def iter_skill_files(skills_root: Path, skill_name: str):
    skill_dir = skills_root / skill_name
    if not (skill_dir / "SKILL.md").is_file():
        raise BundleError(f"missing skill entry: {skill_dir / 'SKILL.md'}")
    for path in sorted(skill_dir.rglob("*")):
        if path.is_dir():
            continue
        relative_parts = path.relative_to(skill_dir).parts
        if path.name in SKIP_NAMES or any(part in SKIP_DIRS for part in relative_parts):
            continue
        yield f"skills/{skill_name}/{Path(*relative_parts).as_posix()}", path


def read_version(repo_root: Path) -> str:
    buildinfo = repo_root / "internal" / "buildinfo" / "buildinfo.go"
    if not buildinfo.is_file():
        raise BundleError(f"missing version source: {buildinfo}")
    match = VERSION_PATTERN.search(buildinfo.read_text(encoding="utf-8"))
    if not match:
        raise BundleError(f"cannot read Version from {buildinfo}")
    return match.group(1)


def read_commit(repo_root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return result.stdout.strip() or "unknown"


def parse_generated_at(value: str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc).replace(microsecond=0)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise BundleError(f"--generated-at is not an RFC3339 timestamp: {value}") from error
    if parsed.tzinfo is None:
        raise BundleError("--generated-at must carry a UTC offset")
    return parsed.astimezone(timezone.utc).replace(microsecond=0)


def collect_entries(bin_dir: Path, skills_root: Path, docs_dir: Path, version: str,
                    commit: str, generated_at: datetime) -> tuple[list[dict], str]:
    entries: list[dict] = []

    for bundle_name, arcname in DOC_SOURCES:
        source = docs_dir / bundle_name
        if not source.is_file():
            raise BundleError(f"missing entry document: {source}")
        entries.append({"arc": arcname, "data": source.read_bytes(), "mode": 0o644})

    for platform, filename, relative, mode, kind in BINARIES:
        source = bin_dir / relative
        if not source.is_file():
            raise BundleError(f"missing binary: {source} (run `make build` first)")
        data = source.read_bytes()
        if not data:
            raise BundleError(f"empty binary: {source}")
        if kind == "macho-arm64":
            assert_macho_arm64(data, str(source))
        else:
            assert_pe_amd64(data, str(source))
        entries.append({"arc": f"bin/{platform}/{filename}", "data": data, "mode": mode})

    for skill_name in SKILL_NAMES:
        for arcname, path in iter_skill_files(skills_root, skill_name):
            data = path.read_bytes()
            executable = bool(path.stat().st_mode & 0o111)
            entries.append({"arc": arcname, "data": data, "mode": 0o755 if executable else 0o644})

    for entry in entries:
        assert_ascii_relative(entry["arc"])
        entry["sha256"] = sha256_bytes(entry["data"])

    lines = [
        f"bundle: {BUNDLE_DIR}",
        f"version: {version}",
        f"commit: {commit}",
        f"generatedAt: {generated_at.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "platforms: darwin-arm64, win32-x64",
        f"skills: {', '.join(SKILL_NAMES)}",
        "",
        "# sha256  <path>",
    ]
    for entry in entries:
        lines.append(f"{entry['sha256']}  {entry['arc']}")
    lines.append("")
    return entries, "\n".join(lines)


def write_zip(out_path: Path, entries: list[dict], version_text: str,
              generated_at: datetime) -> list[str]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    date_time = generated_at.timetuple()[:6]
    stamp = (max(date_time[0], 1980),) + tuple(date_time[1:])

    ordered = [{"arc": "VERSION.txt", "data": version_text.encode("utf-8"), "mode": 0o644}]
    ordered.extend(entries)

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry in ordered:
            info = zipfile.ZipInfo(f"{BUNDLE_DIR}/{entry['arc']}", date_time=stamp)
            info.create_system = 3  # Unix, so the executable bit survives extraction
            info.external_attr = (0o100000 | entry["mode"]) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, entry["data"], compresslevel=9)

    with zipfile.ZipFile(out_path) as archive:
        names = archive.namelist()
        expected = [f"{BUNDLE_DIR}/{entry['arc']}" for entry in ordered]
        if names != expected:
            raise BundleError("written archive does not match the planned file list")
        for name in names:
            assert_ascii_relative(name[len(BUNDLE_DIR) + 1 :] if name.startswith(BUNDLE_DIR + "/") else name)
    return names


def build_bundle(repo_root: Path, bin_dir: Path, skills_root: Path, docs_dir: Path,
                 out_path: Path | None, version: str | None, commit: str | None,
                 generated_at: datetime) -> dict:
    repo_root = repo_root.resolve()
    version = version or read_version(repo_root)
    commit = commit or read_commit(repo_root)
    entries, version_text = collect_entries(bin_dir, skills_root, docs_dir, version, commit, generated_at)

    if out_path is None:
        out_path = repo_root / "dist" / f"{BUNDLE_DIR}-{version}.zip"
    names = write_zip(out_path, entries, version_text, generated_at)
    return {
        "out": out_path,
        "version": version,
        "commit": commit,
        "entries": len(names),
        "size": out_path.stat().st_size,
        "names": names,
        "version_text": version_text,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", type=Path, default=repo_root)
    parser.add_argument("--bin-dir", type=Path, default=None,
                        help="directory holding darwin/crwu and windows/crwu.exe")
    parser.add_argument("--skills-dir", type=Path, default=None,
                        help="source skills layer (default: plugins/common/skills)")
    parser.add_argument("--docs-dir", type=Path, default=None,
                        help="entry document templates (default: scripts/h3yun-bundle)")
    parser.add_argument("--out", type=Path, default=None,
                        help="output zip (default: dist/crwu-h3yun-bundle-<version>.zip)")
    parser.add_argument("--version", default=None)
    parser.add_argument("--commit", default=None)
    parser.add_argument("--generated-at", default=None,
                        help="RFC3339 timestamp; pins archive timestamps for reproducible builds")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.resolve()
    try:
        result = build_bundle(
            repo_root=repo_root,
            bin_dir=args.bin_dir or repo_root / "bin",
            skills_root=args.skills_dir or repo_root / "plugins" / "common" / "skills",
            docs_dir=args.docs_dir or repo_root / "scripts" / "h3yun-bundle",
            out_path=args.out,
            version=args.version,
            commit=args.commit,
            generated_at=parse_generated_at(args.generated_at),
        )
    except BundleError as error:
        print(f"h3yun-bundle: {error}", file=sys.stderr)
        return 1

    print(f"==> {result['out']}")
    print(f"    crwu {result['version']} (commit {result['commit']}), "
          f"{result['entries']} entries, {result['size']} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
