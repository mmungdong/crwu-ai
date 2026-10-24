#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""源仓维护工具：下载、校验并登记随插件发布的 OCR wheel。

只由维护者在能访问 PyPI 的开发机运行；审核链路与员工机器从不调用它。
下载后按真实字节重算 sha256 与字节数写入 manifest.json，不手工改哈希。

    python3 scripts/fetch_wheels.py --dry-run
    python3 scripts/fetch_wheels.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WHEEL_DIR = os.path.join(os.path.dirname(HERE), "vendor", "wheels")
MANIFEST = os.path.join(WHEEL_DIR, "manifest.json")

# 版本号属于随包发布的产物：改它要同批改 manifest、`vendor:check` 与 changelog。
# 目录是**跨技能共用的登记表**：本脚本默认服务 crwu-ocr，`--vendor-dir` 可指向别的技能
# （例如 `crwu-audit` 需要 pypdf + xlrd）。登记表里放全部候选包，实际下载哪些由 `--only` 决定。
CATALOG = {
    "pypdf": {"name": "pypdf", "version": "6.21.1", "module": "pypdf",
              "platforms": ["any"], "target": "any"},
    "pypdfium2": {"name": "pypdfium2", "version": "5.14.0", "module": "pypdfium2",
                  "platforms": ["win32-x64"], "target": "win_amd64"},
    "xlrd": {"name": "xlrd", "version": "2.0.2", "module": "xlrd",
             "platforms": ["any"], "target": "any"},
}
# crwu-ocr 自己的那份（页面渲染 + 文本层）。
OCR_PACKAGES = ("pypdf", "pypdfium2")

RUNTIME_PROVIDED = {"Pillow": {"module": "PIL", "version": "runtime"}}


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(package, destination: str) -> str:
    command = [
        sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:",
        "--python-version", "3.12", "-d", destination,
        "%s==%s" % (package["name"], package["version"]),
    ]
    if package["target"] != "any":
        command[4:4] = ["--platform", package["target"], "--implementation", "cp", "--abi", "cp312"]
    print("[fetch] " + " ".join(command))
    subprocess.run(command, check=True)
    wheels = [name for name in os.listdir(destination) if name.endswith(".whl")]
    if len(wheels) != 1:
        raise SystemExit("期望下载 1 个 wheel，实际 %s 个：%s" % (len(wheels), wheels))
    return os.path.join(destination, wheels[0])


def resolve_packages(vendor_dir: str, only: str) -> tuple:
    """→ 要下载的包登记项。换目录时必须显式给 `--only`，避免把别的技能的 manifest 覆盖错。"""
    if only:
        names = tuple(item.strip() for item in only.split(",") if item.strip())
    elif os.path.abspath(vendor_dir) == os.path.abspath(WHEEL_DIR):
        names = OCR_PACKAGES
    else:
        raise SystemExit("--vendor-dir 指向别的技能时必须用 --only 指定要下载的包")
    unknown = [name for name in names if name not in CATALOG]
    if unknown:
        raise SystemExit("登记表里没有这些包：%s" % unknown)
    return tuple(CATALOG[name] for name in names)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and register packaged skill wheels")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--vendor-dir", default=WHEEL_DIR,
                        help="目标技能的 vendor/wheels 目录（默认 crwu-ocr 自己的）")
    parser.add_argument("--only", default="",
                        help="要下载的包名，逗号分隔；换目录时必填（如 pypdf,xlrd）")
    args = parser.parse_args(argv)

    vendor_dir = os.path.abspath(args.vendor_dir)
    manifest_path = os.path.join(vendor_dir, "manifest.json")
    packages = resolve_packages(vendor_dir, args.only)
    os.makedirs(vendor_dir, exist_ok=True)
    if args.dry_run:
        for package in packages:
            print("%s==%s -> %s" % (package["name"], package["version"], ",".join(package["platforms"])))
        return 0

    staged = {}
    for package in packages:
        workdir = tempfile.mkdtemp(prefix="crwu-ocr-wheel-")
        try:
            wheel = download(package, workdir)
            target = os.path.join(vendor_dir, os.path.basename(wheel))
            shutil.copyfile(wheel, target)
            staged[package["name"]] = (target, package)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # Drop stale wheels that are no longer registered.
    keep = {os.path.basename(path) for path, _ in staged.values()}
    for name in os.listdir(vendor_dir):
        if name.endswith(".whl") and name not in keep:
            os.remove(os.path.join(vendor_dir, name))

    # 保留既有 manifest 的说明字段（`note`）：它是人写的，脚本不该抹掉。
    existing = {}
    if os.path.isfile(manifest_path):
        try:
            existing = json.loads(open(manifest_path, encoding="utf-8").read())
        except ValueError:
            existing = {}
    manifest = {"schemaVersion": 1, "python": "3.12", "packages": {}, "runtimeProvided": RUNTIME_PROVIDED}
    if isinstance(existing, dict) and existing.get("note"):
        manifest["note"] = existing["note"]
    for name, (path, package) in staged.items():
        manifest["packages"][name] = {
            "module": package["module"],
            "version": package["version"],
            "wheel": os.path.basename(path),
            "sha256": sha256(path),
            "bytes": os.path.getsize(path),
            "platforms": package["platforms"],
        }
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("[fetch] wrote %s" % manifest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
