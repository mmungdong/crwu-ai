#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把逐页识别证据合并成**一份按页序的连贯文本**（crwu-ocr 的收尾步骤）。

审核侧读 PDF 时，pypdf 只覆盖有文本层的页；扫描页由页图判读补。若两者各读各的，
审核就会在"第 3 页有字 / 第 4 页只能看记录"之间跳。本脚本把同一来源的全部页按页序
写成一份可顺读的文本：

    ===== 第 N 页 | 来源: 页图判读|文本层|未判读 | sha256: <前12位> | 状态: <...> =====

页内取值优先级：识别记录原文 → 该页文本层原文 → 显式占位（带原因，**绝不写空行**）。
摘要只覆盖正文（不含时间戳行），所以没有新证据时重跑得到同一个 digest。

产物：`ocr/merged/<sourceId>.txt`（`--split-pages N` 时 `…partNN.txt`），并把
`mergedTextPath / mergedDigest / mergedPages / mergedParts` 写回 `ocr/index.json`。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import os
import sys

import ocr_runtime

LABEL_RECOGNISED = "页图判读"
LABEL_TEXT = "文本层"
LABEL_MISSING = "未判读"

MERGED_DIR = "ocr/merged"


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_recognition(case_dir: str, source_id: str) -> dict:
    path = os.path.join(case_dir, "ocr", "recognition", source_id + ".json")
    value = ocr_runtime.read_json(path, {}) or {}
    return value if isinstance(value, dict) else {}


def missing_reason(page: dict) -> str:
    if page.get("renderError"):
        return "render-failed"
    status = page.get("visualStatus")
    if status == "unreadable":
        return "unreadable"
    if status == "pending":
        return "pending"
    return "no-text-layer"


def page_status(page: dict, recognition_page=None) -> str:
    if (recognition_page or {}).get("recognitionStatus") == "conflict":
        return "conflict"
    if page.get("renderError"):
        return "render-failed"
    return page.get("visualStatus") or "unknown"


def page_body(case_dir: str, page: dict, recognition_page) -> tuple:
    """返回 `(正文, 来源标签)`；认不出时正文是显式占位，不是空串。"""
    recorded = (recognition_page or {}).get("text") or ""
    record_sha = (recognition_page or {}).get("imageSha256") or ""
    page_sha = page.get("imageSha256") or ""
    stale = recorded.strip() != "" and record_sha != "" and record_sha != page_sha
    if recorded.strip() and not stale:
        return recorded.strip(), LABEL_RECOGNISED
    if stale:
        return "[第 %s 页 未判读：stale-record]" % page.get("page"), LABEL_MISSING
    if page.get("textStatus") == "ok" and page.get("textPath"):
        try:
            with open(os.path.join(case_dir, *str(page["textPath"]).split("/")),
                      encoding="utf-8") as handle:
                text_layer = handle.read().strip()
        except OSError:
            text_layer = ""
        if text_layer:
            return text_layer, LABEL_TEXT
    return "[第 %s 页 未判读：%s]" % (page.get("page"), missing_reason(page)), LABEL_MISSING


def conflict_line(item: dict) -> str:
    values = " / ".join(str(value) for value in item.get("values") or [])
    return "[冲突：%s %s —— 不得直接引用，须人工确认]" % (item.get("field", ""), values)


def page_section(case_dir: str, page: dict, recognition_page) -> str:
    body, label = page_body(case_dir, page, recognition_page)
    sha = (page.get("imageSha256") or "")[:12]
    reads = len((recognition_page or {}).get("reads") or []) or len(page.get("renders") or []) or 1
    tier = page.get("riskTier") or "unknown"
    orientation = str((recognition_page or {}).get("orientation") or "")
    direction = (" | 方向: %s" % orientation
                 if orientation in ("rotated-90", "rotated-180", "rotated-270") else "")
    lines = ["===== 第 %s 页 | 来源: %s | sha256: %s | 状态: %s | 档位: %s/%d 次%s =====\n%s" % (
        page.get("page"), label, sha, page_status(page, recognition_page), tier, reads, direction, body)]
    for item in (recognition_page or {}).get("conflicts") or []:
        if isinstance(item, dict):
            lines.append(conflict_line(item))
    return "\n".join(lines)


def clear_stale(out_dir: str, source_id: str) -> None:
    """删掉该来源上一版的合并产物。

    单文件与分卷会写不同文件名；不清掉旧的就是**两份正文并存**，而调用方按
    `mergedTextPath`（或 SKILL.md 里的 `<sourceId>.txt`）读，很可能读到上一版的旧文本。
    """
    for name in os.listdir(out_dir):
        if name == source_id + ".txt" or (name.startswith(source_id + ".part")
                                          and name.endswith(".txt")):
            os.remove(os.path.join(out_dir, name))


def merge_source(case_dir: str, source: dict, recognition: dict,
                 split_pages: int = 0) -> dict:
    source_id = source.get("sourceId") or ""
    pages = source.get("pages") or []
    recorded = {}
    for item in recognition.get("pages") or []:
        if isinstance(item, dict) and item.get("page"):
            recorded[int(item["page"])] = item
    sections = [page_section(case_dir, page, recorded.get(int(page.get("page") or 0)))
                for page in pages]
    digest = hashlib.sha256("\n".join(sections).encode("utf-8")).hexdigest()

    out_dir = os.path.join(case_dir, *MERGED_DIR.split("/"))
    os.makedirs(out_dir, exist_ok=True)
    clear_stale(out_dir, source_id)
    head = "# %s · %d 页 · 合并于 %s · 来源 %s" % (
        source.get("relativePath"), len(pages), now(), source_id)

    parts = []
    if split_pages and split_pages > 0:
        chunks = [sections[i:i + split_pages] for i in range(0, len(sections), split_pages)]
        for index, chunk in enumerate(chunks, 1):
            name = "%s.part%02d.txt" % (source_id, index)
            with open(os.path.join(out_dir, name), "w", encoding="utf-8", newline="\n") as handle:
                handle.write(head + "\n" + "\n".join(chunk) + "\n")
            parts.append(MERGED_DIR + "/" + name)
        merged_path = parts[0] if parts else ""
    else:
        name = "%s.txt" % source_id
        with open(os.path.join(out_dir, name), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(head + "\n" + "\n".join(sections) + "\n")
        merged_path = MERGED_DIR + "/" + name

    return {"sourceId": source_id, "mergedTextPath": merged_path, "mergedDigest": digest,
            "mergedPages": len(pages), "mergedParts": parts}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Merge recognised OCR pages into one continuous text")
    parser.add_argument("--case", required=True, help="case directory (absolute path)")
    parser.add_argument("--source", action="append", default=None,
                        help="sourceId to merge (repeatable; default: every indexed source)")
    parser.add_argument("--split-pages", type=int, default=0,
                        help="pages per part file (default 0 = one file)")
    args = parser.parse_args(argv)

    case_dir = os.path.abspath(args.case)
    if not os.path.isdir(case_dir):
        ocr_runtime.emit(ocr_runtime.fail("input", "案例目录不存在：%s" % args.case))
        return ocr_runtime.EXIT_USAGE
    if args.split_pages < 0:
        ocr_runtime.emit(ocr_runtime.fail("input", "--split-pages 只能是非负整数"))
        return ocr_runtime.EXIT_USAGE

    index_path = os.path.join(case_dir, "ocr", "index.json")
    index = ocr_runtime.read_json(index_path, {}) or {}
    sources = [item for item in index.get("sources") or [] if isinstance(item, dict)]
    if not sources:
        ocr_runtime.emit(ocr_runtime.fail(
            "input", "还没有可合并的来源：请先跑 ocr_prepare.py",
            action="先 ocr_prepare.py 转页图并索引，再按页判读记录，最后合并"))
        return ocr_runtime.EXIT_USAGE

    wanted = list(args.source or [])
    known = {item.get("sourceId") for item in sources}
    unknown = [item for item in wanted if item not in known]
    if unknown:
        ocr_runtime.emit(ocr_runtime.fail(
            "input", "索引里没有这些来源：" + "、".join(unknown),
            action="用 ocr/index.json 里的 sourceId，或省略 --source 合并全部"))
        return ocr_runtime.EXIT_USAGE

    targets = [item for item in sources if not wanted or item.get("sourceId") in wanted]
    merged = []
    for source in targets:
        source_id = source.get("sourceId") or ""
        if source_id == "":
            continue    # 读不出来的源没有 sourceId，也没有页可合并
        result = merge_source(case_dir, source, load_recognition(case_dir, source_id),
                              args.split_pages)
        source.update({key: value for key, value in result.items() if key != "sourceId"})
        merged.append(result)

    index["sources"] = sources
    ocr_runtime.write_json_atomic(index_path, index)

    ocr_runtime.emit({
        "ok": True,
        "errorKind": "",
        "error": "",
        "indexPath": "ocr/index.json",
        "merged": merged,
        "action": "" if merged else "没有可合并的来源",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
