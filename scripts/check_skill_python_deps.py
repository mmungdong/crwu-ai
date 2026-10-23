#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**技能脚本的 Python 依赖覆盖门禁**（源仓契约测试）。

## 为什么需要它

2026-10-22 的审核事故里，DSH 自带 Python 没有 `pypdf`，`prepare_materials.py` 把 28 个 PDF
全部记成 `pypdf-error`；同一类问题后来又发生在 `xlrd`（`.xls` 根本读不出）上。两次都不是
写错代码，而是**没有任何检查回答"这个 import 在用户环境里由谁提供"**：

- `assert-pack` 只断言"文件在包里"；
- `vendor:check` 只断言"两份 wheel 副本一致"；
- 没有任何一条断言"脚本的每个非标准库 import 都被随包 wheel 或运行时装满足"。

本门禁把这个问题变成一条可执行的检查：遍历各技能层的运行时脚本，按 AST 取 import，逐个判定
来源；判定不了就失败并列出 `模块 ← 文件`。

## 判定口径

每个非标准库模块必须属于下面之一，否则**失败**：

1. `local`    —— 同目录的 `.py`（技能脚本之间互相 import，随技能一起安装）；
2. `vendored` —— 该技能 `vendor/wheels/manifest.json` 里声明了、且 wheel 文件真的存在；
3. `runtime`  —— 显式白名单：**DSH 自带解释器**提供的包（附用途说明，升级 DSH 时需复核）。

`try` / `if` 里嵌套的 import 视为**可选**（脚本自己有降级/能力缺口分支）：不判失败，单独列出。
测试脚本（`test_*.py`）不参与判定 —— 它们不随运行时装。

用法：

    python3 scripts/check_skill_python_deps.py [--plugin <插件目录>] [--verbose]
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import sys

# 技能层：每层都是 DSH 独立注册的 Skill root。
SKILL_ROOTS = ("skills/crwu", "skills/biz", "skills/capabilities", "skills/dws", "common/skills")

# **DSH 自带解释器**提供的包。这里不是"反正装得上"的借口：加一项就要写明用途，
# 并意识到它随 DSH 版本变化（升级后必须复核）。
RUNTIME_PROVIDED = {
    "openpyxl": "DSH 自带；.xlsx 读写与工作版重建",
    "docx": "DSH 自带 python-docx；.docx 正文与内嵌媒体",
    "PIL": "DSH 自带 Pillow；页图缩放/裁剪",
    "pandas": "DSH 自带；表格数据处理",
    "numpy": "DSH 自带；数值计算",
    "lxml": "DSH 自带；XML 解析",
}

# Python 3.9 没有 `sys.stdlib_module_names`：退回一份足够用的静态清单（只在老解释器上使用）。
FALLBACK_STDLIB = set("""
__future__ abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cmath cmd
codecs collections colorsys configparser contextlib copy csv ctypes dataclasses datetime decimal
difflib dis email enum errno faulthandler filecmp fileinput fnmatch fractions ftplib functools gc
getopt getpass gettext glob gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress
itertools json keyword linecache locale logging lzma mailbox math mimetypes mmap multiprocessing
numbers operator os pathlib pickle pkgutil platform plistlib poplib posixpath pprint pty queue
quopri random re reprlib runpy sched secrets select shelve shlex shutil signal smtplib socket
sqlite3 ssl stat statistics string stringprep struct subprocess sys tarfile tempfile textwrap
threading time timeit token tokenize traceback tracemalloc types typing unicodedata unittest urllib
uuid venv warnings wave weakref webbrowser xml xmlrpc zipfile zipimport zlib zoneinfo
""".split())


def stdlib_names() -> set:
    names = getattr(sys, "stdlib_module_names", None)
    return set(names) if names is not None else set(FALLBACK_STDLIB)


def iter_scripts(plugin: str):
    """遍历各技能层的运行时脚本（跳过 vendor / __pycache__ / test_*.py）。"""
    for root in SKILL_ROOTS:
        base = os.path.join(plugin, *root.split("/"))
        if not os.path.isdir(base):
            continue
        for current, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in ("vendor", "__pycache__")]
            for name in sorted(files):
                if not name.endswith(".py") or name.startswith("test_"):
                    continue
                yield os.path.join(current, name)


def collect_imports(path: str):
    """→ `(hard, optional)`：顶层/普通函数体里的 import 是硬依赖，`try`/`if` 里的是可选。"""
    with open(path, "r", encoding="utf-8") as handle:
        tree = ast.parse(handle.read())
    hard, optional = set(), set()

    def walk(node, guarded: bool) -> None:
        for child in ast.iter_child_nodes(node):
            g = guarded or isinstance(child, (ast.Try, ast.If))
            if isinstance(child, ast.Import):
                for alias in child.names:
                    (optional if g else hard).add(alias.name.split(".")[0])
            elif isinstance(child, ast.ImportFrom) and child.level == 0 and child.module:
                (optional if g else hard).add(child.module.split(".")[0])
            walk(child, g)

    walk(tree, False)
    return hard, optional


def local_modules(directory: str) -> set:
    """同目录、或同技能 `scripts/` 下的模块名（技能内互相 import）。"""
    names = set()
    for name in os.listdir(directory):
        if name.endswith(".py"):
            names.add(name[:-3])
    return names


def vendored_modules(skill_dir: str) -> dict:
    """该技能随包 wheel 声明的模块名 → 信息；manifest 或 wheel 缺失时记问题。"""
    manifest_path = os.path.join(skill_dir, "vendor", "wheels", "manifest.json")
    if not os.path.isfile(manifest_path):
        return {}
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    out = {}
    for name, entry in (manifest.get("packages") or {}).items():
        if not isinstance(entry, dict):
            continue
        wheel = os.path.join(skill_dir, "vendor", "wheels", str(entry.get("wheel") or ""))
        out[str(entry.get("module") or name)] = {
            "package": name,
            "version": entry.get("version", ""),
            "wheel": wheel,
            "present": os.path.isfile(wheel),
        }
    return out


def skill_dir_of(script: str) -> str:
    """`<skill>/scripts/x.py` → `<skill>`（脚本都放在技能自己的 scripts/ 下）。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(script)))


def check(plugin: str, verbose: bool = False) -> list:
    std = stdlib_names()
    problems = []
    optional_seen = []
    for script in iter_scripts(plugin):
        directory = os.path.dirname(script)
        locals_ = local_modules(directory)
        skill = skill_dir_of(script)
        vendored = vendored_modules(skill)
        hard, optional = collect_imports(script)
        for module in sorted(hard):
            if module in std or module in locals_:
                continue
            info = vendored.get(module)
            if info is not None:
                if not info["present"]:
                    problems.append(
                        f"{module} ← {script}：随包 wheel 缺失（{info['wheel']}）")
                continue
            if module in RUNTIME_PROVIDED:
                continue
            problems.append(
                f"{module} ← {script}：既不在该技能 vendor/wheels，也不在 DSH 运行时白名单")
        for module in sorted(optional - hard):
            if module in std or module in locals_ or module in vendored or module in RUNTIME_PROVIDED:
                continue
            optional_seen.append(f"{module} ← {script}")
    if verbose and optional_seen:
        print("可选/降级 import（try|if 内，不判失败）：")
        for item in optional_seen:
            print(f"  - {item}")
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="技能脚本 Python 依赖覆盖门禁")
    parser.add_argument("--plugin", default=os.path.join("plugins", "dsh-crwu-workbench"),
                        help="插件根目录（默认 plugins/dsh-crwu-workbench）")
    parser.add_argument("--verbose", action="store_true", help="同时列出可选/降级 import")
    args = parser.parse_args(argv)

    plugin = os.path.abspath(args.plugin)
    if not os.path.isdir(plugin):
        print(f"插件目录不存在：{plugin}", file=sys.stderr)
        return 2
    problems = check(plugin, verbose=args.verbose)
    if problems:
        for problem in problems:
            print(f"✗ {problem}", file=sys.stderr)
        print(
            f"\nPython 依赖门禁失败（{len(problems)} 项）："
            "每个非标准库 import 都必须由随包 wheel 或 DSH 运行时满足；"
            "缺的那一项要么随包（vendor/wheels + manifest），要么写进 RUNTIME_PROVIDED 并说明用途。",
            file=sys.stderr,
        )
        return 1
    print("Python 依赖门禁通过：技能脚本的每个非标准库 import 都有来源")
    return 0


if __name__ == "__main__":
    sys.exit(main())
