#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared runtime for the crwu-ocr skill: dependency loading, hashing, JSON I/O.

The skill is installed as an npm package and uses the DSH workspace Python.
Pure-Python wheels (pypdf) and platform wheels that a signed runtime can load
(pypdfium2 on Windows) ship with the plugin, are verified by sha256, and are
unpacked into a case-local cache. Nothing is installed at audit time and the
DSH Python installation itself is never modified.

On macOS the DSH runtime is hardened-signed, so third-party native libraries
cannot be loaded into it. PDF rendering there uses the operating system's
CoreGraphics framework instead (see ``ocr_quartz``); that needs no download and
works on every macOS install.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import json
import os
import platform as host_platform
import re
import shutil
import sys
import unicodedata
import zipfile

SCHEMA_VERSION = 1

PLATFORM_KEYS = {
    ("darwin", "arm64"): "darwin-arm64",
    ("darwin", "x86_64"): "darwin-x64",
    ("win32", "amd64"): "win32-x64",
    ("win32", "arm64"): "win32-arm64",
}

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CAPABILITY_GAP = 3


def platform_key() -> str:
    machine = host_platform.machine().lower()
    if machine == "amd64":
        machine = "x86_64" if sys.platform != "win32" else "amd64"
    key = PLATFORM_KEYS.get((sys.platform, machine))
    return key or ""


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_digest(value) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def read_json(path: str, fallback=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def write_json_atomic(path: str, value) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")
    os.replace(temp, path)


def emit(value) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fail(error_kind: str, message: str, **extra) -> dict:
    result = {"ok": False, "errorKind": error_kind, "error": message}
    result.update(extra)
    return result


def relpath(case_dir: str, path: str) -> str:
    """Case-relative POSIX path; never leak an absolute host path into records."""
    return os.path.relpath(path, case_dir).replace(os.sep, "/")


def staged_case_problem(case_dir: str, script_file: str) -> str:
    """Refuse a --case that is not the case this staged copy belongs to.

    The scripts are staged to ``<case>/ocr-skill/scripts/``. When that layout is
    present the case is not a caller choice: it is where the copy lives. This is the
    authoritative check — the Host's argument check is a diagnostic, and any spelling
    it misses (an argparse abbreviation, a duplicated --case) still lands here.
    """
    scripts_dir = os.path.dirname(os.path.abspath(script_file))
    if os.path.basename(scripts_dir) != "scripts":
        return ""
    stage_dir = os.path.dirname(scripts_dir)
    if os.path.basename(stage_dir) != "ocr-skill":
        return ""
    expected = os.path.realpath(os.path.dirname(stage_dir))
    actual = os.path.realpath(case_dir)
    if expected != actual:
        return ("案例目录与本轮暂存位置不一致：--case %s，暂存位置 %s；"
                "OCR 脚本只能处理本轮案例" % (actual, expected))
    return ""


def normalize_text(value: str) -> str:
    """NFKC plus whitespace removal: layout changes must not break quote matching."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value or ""))


SESSION_MAX_WIDTH = 1721  # measured 2026-10-21: the session normalizes page images to this width


def resolution_note(max_width: int) -> str:
    """Warn when the largest render exceeds the width the session actually reads."""
    if max_width <= SESSION_MAX_WIDTH:
        return ""
    return ("会话侧有效宽度约 %d px；本次最大页图宽 %d px，超出部分不增加信息量"
            % (SESSION_MAX_WIDTH, max_width))


def quote_in_text(text: str, quote: str) -> bool:
    """True when the quote is a verbatim fragment of the page text (ignoring layout)."""
    normalized = normalize_text(quote)
    if normalized == "":
        return False
    return normalized in normalize_text(text)


def normalize_value(raw: str) -> str:
    """Normalize a figure for comparison; separators and currency symbols never matter."""
    text = unicodedata.normalize("NFKC", raw or "")
    text = re.sub(r"\s+", "", text)
    text = text.replace(",", "")
    for symbol in "￥¥$元":
        text = text.replace(symbol, "")
    return text


def value_in_quote(value: str, quote: str) -> bool:
    """True when the normalized value appears inside the normalized quote."""
    normalized = normalize_value(value)
    return normalized != "" and normalized in normalize_value(quote)


def parse_page_selection(spec: str) -> set[int]:
    """Parse ``1,3-5`` into page numbers; reject empty, zero, reversed or non-numeric parts."""
    raw = (spec or "").strip()
    if raw == "":
        raise ValueError("页号列表为空")
    pages: set[int] = set()
    for chunk in raw.split(","):
        item = chunk.strip()
        if item == "":
            raise ValueError("页号列表含空段：%s" % spec)
        if "-" in item:
            start_text, _, end_text = item.partition("-")
            try:
                start, end = int(start_text), int(end_text)
            except ValueError:
                raise ValueError("页号区间不是数字：%s" % item)
            if start < 1 or end < start:
                raise ValueError("页号区间不合法：%s" % item)
            pages.update(range(start, end + 1))
        else:
            try:
                page = int(item)
            except ValueError:
                raise ValueError("页号不是数字：%s" % item)
            if page < 1:
                raise ValueError("页号必须从 1 开始：%s" % item)
            pages.add(page)
    return pages


def safe_join(root: str, *parts: str) -> str:
    """Join and require the result to stay inside ``root`` (rejects escape)."""
    base = os.path.abspath(root)
    target = os.path.abspath(os.path.join(base, *parts))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError("path escapes the case directory")
    return target


def safe_source_id(relative_path: str) -> str:
    """Stable, filesystem-safe stem for page images."""
    stem = os.path.splitext(os.path.basename(relative_path))[0]
    cleaned = re.sub(r"[\\/:*?\"<>|\s]+", "_", stem).strip("._") or "source"
    return cleaned[:60]


# ------------------------------- dependencies -------------------------------

def _strip_data_layout(name: str) -> str:
    """Map ``<pkg>.data/{purelib,platlib}/x`` to ``x``; skip other data sections."""
    parts = name.split("/")
    if len(parts) >= 3 and parts[0].endswith(".data"):
        section = parts[1]
        if section in ("purelib", "platlib"):
            return "/".join(parts[2:])
        return ""
    return name


def _unpack_wheel(wheel: str, site_dir: str) -> None:
    with zipfile.ZipFile(wheel) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            target_name = _strip_data_layout(info.filename.replace("\\", "/"))
            if target_name == "":
                continue
            parts = target_name.split("/")
            if target_name.startswith("/") or ".." in parts or ":" in parts[0]:
                raise ValueError("unsafe wheel entry: " + info.filename)
            destination = os.path.join(site_dir, *parts)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with archive.open(info) as source, open(destination, "wb") as sink:
                shutil.copyfileobj(source, sink)


def _validate_manifest(manifest, manifest_path: str) -> list:
    if not isinstance(manifest, dict):
        return ["manifest is not an object: " + manifest_path]
    packages = manifest.get("packages")
    if not isinstance(packages, dict) or not packages:
        return ["manifest has no packages: " + manifest_path]
    problems = []
    for name, entry in packages.items():
        if not isinstance(entry, dict):
            problems.append("package entry is not an object: " + str(name))
            continue
        for field in ("module", "version", "wheel", "sha256", "bytes", "platforms"):
            if entry.get(field) in (None, "", []):
                problems.append("package %s missing %s" % (name, field))
        wheel = entry.get("wheel")
        if isinstance(wheel, str) and ("/" in wheel or ".." in wheel):
            problems.append("package %s wheel name is not a plain file" % name)
    return problems


def find_manifest(script_dir: str, explicit: str = "") -> str:
    """Resolve the wheel manifest: ``--deps``, staged ``runtime.json``, installed tree."""
    if explicit:
        candidate = os.path.join(explicit, "manifest.json") if os.path.isdir(explicit) else explicit
        if os.path.isfile(candidate):
            return candidate
    runtime_json = os.path.join(os.path.dirname(os.path.abspath(script_dir)), "runtime.json")
    config = read_json(runtime_json, {}) or {}
    configured_root = config.get("wheelRoot") if isinstance(config, dict) else ""
    if isinstance(configured_root, str) and configured_root:
        candidate = os.path.join(configured_root, "manifest.json")
        if os.path.isfile(candidate):
            return candidate
    skill_root = os.path.dirname(os.path.abspath(script_dir))
    candidate = os.path.join(skill_root, "vendor", "wheels", "manifest.json")
    return candidate if os.path.isfile(candidate) else ""


def _module_version(module_name: str, package_name: str) -> str:
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        module = sys.modules.get(module_name)
        return str(getattr(module, "__version__", "") or "")


def install_dependencies(manifest_path: str, cache_dir: str, key: str) -> dict:
    """Verify and import packaged wheels plus runtime-provided packages."""
    manifest = read_json(manifest_path)
    problems = _validate_manifest(manifest, manifest_path)
    if problems:
        return fail("deps-manifest", "依赖清单不可用：" + "；".join(problems), packages={}, manifestPath=manifest_path)

    packages = manifest["packages"]
    applicable = {}
    skipped = {}
    for name, entry in packages.items():
        platforms = entry.get("platforms") or []
        if "any" in platforms or key in platforms:
            applicable[name] = entry
        else:
            skipped[name] = "not-packaged-for-platform"

    digest = canonical_digest(manifest)
    site_dir = os.path.join(cache_dir, digest[:16])
    marker = os.path.join(site_dir, ".crwu-ocr-deps.json")
    wheel_dir = os.path.dirname(manifest_path)

    to_unpack = []
    for name, entry in applicable.items():
        # Prefer a module the DSH runtime already provides (signed, no shadowing).
        if _importable(entry["module"]):
            continue
        wheel_path = os.path.join(wheel_dir, entry["wheel"])
        if not os.path.isfile(wheel_path):
            return fail("deps-missing", "随包依赖不存在：%s" % entry["wheel"], packages={}, manifestPath=manifest_path)
        actual_bytes = os.path.getsize(wheel_path)
        if actual_bytes != int(entry["bytes"]):
            return fail("deps-integrity", "随包依赖字节数不符：%s（期望 %s，实际 %s）"
                        % (entry["wheel"], entry["bytes"], actual_bytes), packages={}, manifestPath=manifest_path)
        actual_sha = sha256_file(wheel_path)
        if actual_sha != entry["sha256"]:
            return fail("deps-integrity", "随包依赖 sha256 不符：%s" % entry["wheel"],
                        packages={}, manifestPath=manifest_path)
        to_unpack.append((name, wheel_path))

    if to_unpack and not os.path.isfile(marker):
        if os.path.isdir(site_dir):
            shutil.rmtree(site_dir, ignore_errors=True)
        os.makedirs(site_dir, exist_ok=True)
        try:
            for _name, wheel_path in to_unpack:
                _unpack_wheel(wheel_path, site_dir)
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            shutil.rmtree(site_dir, ignore_errors=True)
            return fail("deps-unpack", "随包依赖解包失败：%s" % error, packages={}, manifestPath=manifest_path)
        write_json_atomic(marker, {"schemaVersion": SCHEMA_VERSION, "manifestDigest": digest, "platformKey": key})

    if os.path.isdir(site_dir) and site_dir not in sys.path:
        sys.path.insert(0, site_dir)

    versions = {}
    missing = []
    if os.path.isdir(site_dir):
        importlib.invalidate_caches()
    for name, entry in applicable.items():
        try:
            importlib.import_module(entry["module"])
            versions[name] = _module_version(entry["module"], name)
        except Exception as error:  # noqa: BLE001 - report, never guess
            text = str(error)
            if "code signature" in text or "different Team IDs" in text:
                return fail(
                    "deps-signature",
                    "本机 DSH 自带 Python 是硬化签名运行时，不能加载随包的原生依赖 %s：%s" % (name, text),
                    packages=versions, manifestPath=manifest_path,
                )
            missing.append("%s（%s）" % (name, text))
    if missing:
        return fail("deps-import", "随包依赖已解包但导入失败：" + "；".join(missing),
                    packages=versions, manifestPath=manifest_path, siteDir=site_dir)

    runtime_provided = manifest.get("runtimeProvided") or {}
    for name, entry in runtime_provided.items():
        module_name = entry.get("module", name)
        try:
            importlib.import_module(module_name)
            versions[name] = _module_version(module_name, name)
        except Exception as error:  # noqa: BLE001
            return fail(
                "runtime-package-missing",
                "DSH 自带 Python 缺少运行时提供的包 %s：%s（请让部署方补齐，不要在审核中安装）" % (name, error),
                packages=versions, manifestPath=manifest_path,
            )

    return {
        "ok": True,
        "errorKind": "",
        "error": "",
        "source": "packaged-wheel+runtime" if to_unpack else "runtime+packaged",
        "manifestPath": manifest_path,
        "manifestDigest": digest,
        "siteDir": site_dir if os.path.isdir(site_dir) else "",
        "packages": versions,
        "skipped": skipped,
    }


def _importable(module_name: str) -> bool:
    try:
        importlib.invalidate_caches()
        importlib.import_module(module_name)
        return True
    except Exception:  # noqa: BLE001
        return False


def ensure_dependencies(script_dir: str, case_dir: str, explicit: str = "") -> dict:
    key = platform_key()
    if key == "":
        return fail(
            "capability-gap",
            "本平台（%s/%s）不在随包依赖清单内：请改用 macOS 或 Windows 的插件构建"
            % (sys.platform, host_platform.machine()),
            platformKey="", packages={},
        )
    manifest_path = find_manifest(script_dir, explicit)
    if manifest_path == "":
        return fail(
            "capability-gap",
            "找不到随包 OCR 依赖清单：插件包可能不完整（平台 %s）" % key,
            platformKey=key, packages={},
        )
    cache_dir = safe_join(case_dir, "ocr", ".deps")
    result = install_dependencies(manifest_path, cache_dir, key)
    result["platformKey"] = key
    return result


def dependency_summary(runtime: dict) -> dict:
    return {
        "platformKey": runtime.get("platformKey", platform_key()),
        "source": runtime.get("source", ""),
        "manifestDigest": runtime.get("manifestDigest", ""),
        "packages": runtime.get("packages", {}),
        "python": sys.version.split()[0],
    }
