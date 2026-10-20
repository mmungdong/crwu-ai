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

# Version pins are part of the shipped artifact: bump them together with the
# manifest and the changelog entry.
PACKAGES = (
    {"name": "pypdf", "version": "6.21.1", "module": "pypdf", "platforms": ["any"], "target": "any"},
    {"name": "pypdfium2", "version": "5.14.0", "module": "pypdfium2",
     "platforms": ["win32-x64"], "target": "win_amd64"},
)

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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and register packaged OCR wheels")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    os.makedirs(WHEEL_DIR, exist_ok=True)
    if args.dry_run:
        for package in PACKAGES:
            print("%s==%s -> %s" % (package["name"], package["version"], ",".join(package["platforms"])))
        return 0

    staged = {}
    for package in PACKAGES:
        workdir = tempfile.mkdtemp(prefix="crwu-ocr-wheel-")
        try:
            wheel = download(package, workdir)
            target = os.path.join(WHEEL_DIR, os.path.basename(wheel))
            shutil.copyfile(wheel, target)
            staged[package["name"]] = (target, package)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # Drop stale wheels that are no longer registered.
    keep = {os.path.basename(path) for path, _ in staged.values()}
    for name in os.listdir(WHEEL_DIR):
        if name.endswith(".whl") and name not in keep:
            os.remove(os.path.join(WHEEL_DIR, name))

    manifest = {"schemaVersion": 1, "python": "3.12", "packages": {}, "runtimeProvided": RUNTIME_PROVIDED}
    for name, (path, package) in staged.items():
        manifest["packages"][name] = {
            "module": package["module"],
            "version": package["version"],
            "wheel": os.path.basename(path),
            "sha256": sha256(path),
            "bytes": os.path.getsize(path),
            "platforms": package["platforms"],
        }
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("[fetch] wrote %s" % MANIFEST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
