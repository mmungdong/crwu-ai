#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prepare OCR sources: render PDF pages, extract their text layer, index pages.

Outputs live under ``<case>/ocr``:
  index.json                                  source/page index, coverage and state
  pages/<sourceId>/<stem>_pageNNNN.png         full-page images (144 DPI default)
  text/<sourceId>/pageNNNN.txt                 per-page text layer, when present

Image recognition is not performed here. The skill's references tell the model
to read the indexed pages through DSH image reading and write facts back with
``ocr_record.py``. "Rendered" never means "recognised".
"""
from __future__ import annotations

import argparse
import datetime
import math
import os
import re
import sys
import time

import ocr_engines
import ocr_runtime

DEFAULT_SRC = ("材料-源",)
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff")
PDF_EXTS = (".pdf",)
DEFAULT_DPI = 144
HIGH_DPI = 200
MIN_TEXT_CHARS = 20
LARGE_DOC_PAGES = 50
POLICY_CHOICES = ("fast", "auto", "quality")
RENDER_MODES = ("dpi-retry", "tile")


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_visual(spec: str):
    """Parse --visual: auto | all | none | pages:1,3-5."""
    text = (spec or "auto").strip().lower()
    if text in ("auto", "all", "none"):
        return text, set()
    if text.startswith("pages:"):
        pages = set()
        for chunk in text[6:].split(","):
            chunk = chunk.strip()
            if chunk == "":
                continue
            if "-" in chunk:
                start, _sep, end = chunk.partition("-")
                first, last = int(start), int(end)
            else:
                first = last = int(chunk)
            if first < 1 or last < first:
                raise ValueError("--visual 的页码必须从 1 起且区间递增：" + chunk)
            pages.update(range(first, last + 1))
        return "pages", pages
    raise ValueError("--visual 只接受 auto / all / none / pages:1,3-5：" + spec)


def text_quality(text: str) -> str:
    if text.strip() == "":
        return "empty"
    if "\ufffd" in text:
        return "garbled"
    return "ok"


def clean_text(value) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\x00", "").replace("\r\n", "\n").strip()


def flatten_to_rgb(image):
    from PIL import Image

    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        canvas = Image.new("RGB", image.size, (255, 255, 255))
        canvas.paste(image, mask=image.split()[-1])
        return canvas
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text + ("\n" if text else ""))


def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().rstrip("\n")
    except OSError:
        return ""


def source_id_for(relative_path: str, digest: str) -> str:
    stem = ocr_runtime.safe_source_id(relative_path)
    return "%s__%s" % (stem, digest[:8])


def previous_pages(index, relative_path: str):
    for source in index.get("sources", []):
        if isinstance(source, dict) and source.get("relativePath") == relative_path:
            pages = source.get("pages")
            if isinstance(pages, list):
                return {int(page.get("page", 0)): page for page in pages if isinstance(page, dict)}
    return {}


def page_image_path(source_id: str, stem: str, page_no: int) -> str:
    return "ocr/pages/%s/%s_page%04d.png" % (source_id, stem, page_no)


def text_path(source_id: str, page_no: int) -> str:
    return "ocr/text/%s/page%04d.txt" % (source_id, page_no)


def page_class(kind: str, text_status: str) -> str:
    """Classify one page: born-digital text, scan inside a PDF, or a standalone image."""
    if kind == "image":
        return "image"
    if text_status in ("empty", "garbled", "failed"):
        return "scan"
    return "text"


def initial_risk(kind: str, text_status: str, reasons: list) -> str:
    """Prior risk before reading: pages without a trustworthy text layer are high."""
    if kind == "image" or text_status in ("empty", "garbled", "failed"):
        return "high"
    if "text-too-short" in reasons:
        return "high"
    return "normal"


def initial_dpi(policy: str, risk: str, page_count: int, base_dpi: int) -> int:
    """First-pass DPI; high-risk pages never go below 200, and never below an explicit base."""
    if policy == "fast":
        return base_dpi
    if risk != "high":
        return base_dpi
    if policy == "quality" or page_count <= LARGE_DOC_PAGES:
        return max(base_dpi, HIGH_DPI)
    return base_dpi


def budget_for(required: int, policy: str, override):
    """Double-read allowance. ``None`` means the default formula; ``0`` means none."""
    required = max(0, int(required))
    if required == 0:
        cap = 0
    elif override is None:
        cap = min(10, required, max(3, int(math.ceil(required * 0.2))))
    else:
        cap = max(0, min(int(override), required))
    return {"pagesRequired": required, "maxDoubleReads": cap, "doubleReads": 0,
            "imageCalls": 0, "elapsedMs": 0, "exhausted": False}


def render_rel_path(source_id: str, stem: str, page_no: int, dpi: int, base_dpi: int) -> str:
    """Keep the legacy unsuffixed name for the base DPI; suffix every other variant."""
    path = page_image_path(source_id, stem, page_no)
    if dpi == base_dpi:
        return path
    return path[:-len(".png")] + "@%d.png" % dpi


def tile_images(image, case_dir: str, out_base: str, overlap: float = 0.10) -> list:
    """Split one page into four overlapping crops; geometry only, never model boxes."""
    width, height = image.size
    overlap_x = int(round(width * overlap))
    overlap_y = int(round(height * overlap))
    half_x, half_y = width // 2, height // 2
    cols = [(0, min(width, half_x + overlap_x)), (max(0, half_x - overlap_x), width)]
    rows = [(0, min(height, half_y + overlap_y)), (max(0, half_y - overlap_y), height)]
    tiles = []
    index = 0
    for top, bottom in rows:
        for left, right in cols:
            index += 1
            crop = image.crop((left, top, right, bottom))
            rel = "%s_t%d.png" % (out_base, index)
            absolute = os.path.join(case_dir, *rel.split("/"))
            os.makedirs(os.path.dirname(absolute), exist_ok=True)
            crop.save(absolute, format="PNG")
            tiles.append({"index": index, "image": rel,
                          "imageSha256": ocr_runtime.sha256_file(absolute),
                          "width": crop.size[0], "height": crop.size[1]})
    return tiles


def ensure_render(case_dir, source_id, stem, page_no, dpi, base_dpi, engine_label,
                  cached_page, render_fn, mode="page", force=False):
    """Return an existing render at this DPI/mode when the file still matches, else render."""
    rel = render_rel_path(source_id, stem, page_no, dpi, base_dpi)
    absolute = os.path.join(case_dir, *rel.split("/"))
    previous = cached_page.get("renders") if isinstance(cached_page.get("renders"), list) else []
    if not force:
        for item in previous:
            if not isinstance(item, dict) or item.get("dpi") != dpi or item.get("mode") != mode:
                continue
            if item.get("engine") != engine_label:
                continue
            if item.get("image") != rel or not os.path.isfile(absolute):
                continue
            if os.path.getsize(absolute) == 0:
                continue
            if ocr_runtime.sha256_file(absolute) != item.get("imageSha256"):
                continue
            return item
    image, rotation = render_fn(dpi)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    image.save(absolute, format="PNG")
    entry = {
        "n": max([int(item.get("n") or 0) for item in previous] or [0]) + 1,
        "dpi": dpi,
        "mode": mode,
        "image": rel,
        "imageSha256": ocr_runtime.sha256_file(absolute),
        "imageBytes": os.path.getsize(absolute),
        "width": image.size[0],
        "height": image.size[1],
        "pageRotation": rotation,
        "engine": engine_label,
        "createdAt": now(),
        "tiles": [],
    }
    if mode == "tile":
        entry["tiles"] = tile_images(image, case_dir, rel[:-len(".png")])
    return entry


def existing_renders(case_dir, cached_page, base_dpi):
    """Valid previous renders, with legacy single-image pages migrated to ``renders``."""
    renders = []
    for item in cached_page.get("renders") or []:
        if not isinstance(item, dict):
            continue
        image = item.get("image") or ""
        if image and os.path.isfile(os.path.join(case_dir, *image.split("/"))):
            renders.append(dict(item, tiles=list(item.get("tiles") or [])))
    if renders:
        return renders
    legacy = cached_page.get("image") or ""
    if legacy and os.path.isfile(os.path.join(case_dir, *legacy.split("/"))):
        return [{
            "n": 1,
            "dpi": int(cached_page.get("renderDpi") or base_dpi),
            "mode": "page",
            "image": legacy,
            "imageSha256": cached_page.get("imageSha256", ""),
            "imageBytes": int(cached_page.get("imageBytes") or 0),
            "width": int(cached_page.get("width") or 0),
            "height": int(cached_page.get("height") or 0),
            "pageRotation": int(cached_page.get("pageRotation") or 0),
            "engine": cached_page.get("engine", ""),
            "createdAt": "",
            "tiles": [],
        }]
    return []


def count_pages_read(case_dir: str) -> int:
    """Pages with at least one recorded read, taken from the recognition records themselves."""
    directory = os.path.join(case_dir, "ocr", "recognition")
    if not os.path.isdir(directory):
        return 0
    total = 0
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        record = ocr_runtime.read_json(os.path.join(directory, name)) or {}
        if not isinstance(record, dict):
            continue
        total += sum(1 for page in record.get("pages") or []
                     if isinstance(page, dict) and page.get("status"))
    return total


def visual_reasons(kind: str, text_status: str, text: str, spec: str, pages: set, page_no: int) -> list:
    reasons = []
    if kind == "image":
        reasons.append("image-source")
    elif text_status == "empty":
        reasons.append("no-text-layer")
    elif text_status == "failed":
        reasons.append("text-extract-failed")
    elif text_status == "garbled":
        reasons.append("text-garbled")
    elif len(text.strip()) < MIN_TEXT_CHARS:
        reasons.append("text-too-short")
    if spec == "all":
        reasons.append("visual-all")
    elif spec == "pages" and page_no in pages:
        reasons.append("visual-pages")
    return reasons


def prepare_pdf(case_dir, relative_path, source_id, stem, prev, args, engine):
    from pypdf import PdfReader

    abs_path = os.path.join(case_dir, relative_path)
    result = {"pages": [], "pageCount": 0, "status": "prepared", "errors": []}
    reader = None
    try:
        reader = PdfReader(abs_path)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as error:  # noqa: BLE001 - record, do not guess a password
                result["errors"].append("PDF 已加密且无法用空密码打开：%s" % error)
                reader = None
    except Exception as error:  # noqa: BLE001
        result["errors"].append("PDF 打开失败：%s" % error)
        reader = None

    try:
        document = engine.open(abs_path)
    except Exception as error:  # noqa: BLE001
        return {**result, "status": "failed", "errors": result["errors"] + ["PDF 渲染失败：%s" % error]}

    try:
        page_count = document.page_count
        result["pageCount"] = page_count
        if reader is not None and len(reader.pages) != page_count:
            result["errors"].append(
                "文本读取与渲染读到的页数不一致（pypdf %s / %s %s）"
                % (len(reader.pages), engine.name, page_count))

        for page_no in range(1, page_count + 1):
            cached = prev.get(page_no, {})
            render_error = ""

            text_abs = os.path.join(case_dir, text_path(source_id, page_no))
            text_status = cached.get("textStatus") or ""
            text = ""
            text_error = ""
            if cached.get("textStatus") and os.path.isfile(text_abs):
                text = read_text(text_abs)
                text_status = text_quality(text) if text_status == "ok" else text_status
            elif reader is not None:
                try:
                    text = clean_text(reader.pages[page_no - 1].extract_text())
                    text_status = text_quality(text)
                    write_text(text_abs, text)
                except Exception as error:  # noqa: BLE001
                    text_status = "failed"
                    text_error = "第 %s 页文本提取失败：%s" % (page_no, error)
            else:
                text_status = "failed"
                text_error = "文本层不可用（PDF 无法解析）"

            reasons = visual_reasons("pdf", text_status, text, args.visual, args.visual_pages, page_no)
            classified = page_class("pdf", text_status)
            risk = initial_risk("pdf", text_status, reasons)
            target_dpi = initial_dpi(args.policy, risk, page_count, args.base_dpi)
            renders = existing_renders(case_dir, cached, args.base_dpi)
            appended = False

            def render_fn(dpi, page_no=page_no):
                return document.render(page_no, dpi)

            # A re-render run must not touch pages it did not list: their existing
            # renders and shas stay as they are, whatever this call's policy says.
            skip_first_pass = bool(args.re_render_pages) and bool(renders)
            try:
                if not skip_first_pass:
                    first_dpi = args.base_dpi if args.re_render_pages else target_dpi
                    base_render = ensure_render(
                        case_dir, source_id, stem, page_no, first_dpi, args.base_dpi,
                        engine.label, {"renders": renders}, render_fn, "page",
                        force=args.force)
                    if not any(item.get("n") == base_render["n"] for item in renders):
                        renders.append(base_render)
                        appended = True
                    target_dpi = first_dpi
            except Exception as error:  # noqa: BLE001 - one bad page must not stop the rest
                render_error = "第 %s 页渲染失败：%s" % (page_no, error)

            if page_no in args.re_render_pages and not render_error:
                mode = "tile" if args.mode == "tile" else "page"
                extra_dpi = args.dpi
                if not args.re_render_dpi_explicit and renders:
                    extra_dpi = min(600, max(args.dpi, int(renders[-1].get("dpi") or 0) + 100))
                try:
                    extra = ensure_render(
                        case_dir, source_id, stem, page_no, extra_dpi, args.base_dpi,
                        engine.label, {"renders": renders}, render_fn, mode)
                    if not any(item.get("n") == extra["n"] for item in renders):
                        renders.append(extra)
                        appended = True
                except Exception as error:  # noqa: BLE001
                    render_error = "第 %s 页重渲失败：%s" % (page_no, error)

            renders.sort(key=lambda item: int(item.get("n") or 0))
            latest = renders[-1] if renders else {}
            policy_mode = "none"
            if len(renders) > 1:
                policy_mode = "tile" if latest.get("mode") == "tile" else "dpi-retry"
            policy_dpi = int(latest.get("dpi") or target_dpi)
            image_sha = latest.get("imageSha256", "")
            reasons = [] if render_error else reasons
            escalated = appended and len(renders) > 1
            if escalated and "render-escalated" not in reasons:
                reasons = reasons + ["render-escalated"]
            previous_visual = cached.get("visualStatus") or ""
            unchanged = image_sha != "" and image_sha == (cached.get("imageSha256") or "")
            if render_error:
                visual_status = "unreadable"
            elif escalated:
                visual_status = "pending"
            elif args.visual == "none":
                visual_status = "skipped"
            elif unchanged and previous_visual in ("done", "unreadable", "skipped"):
                visual_status = previous_visual
            else:
                visual_status = "pending" if reasons else "not-required"

            result["pages"].append({
                "page": page_no,
                "image": latest.get("image", ""),
                "imageSha256": image_sha,
                "imageBytes": int(latest.get("imageBytes") or 0),
                "width": int(latest.get("width") or 0),
                "height": int(latest.get("height") or 0),
                "pageRotation": int(latest.get("pageRotation") or 0),
                "engine": engine.label,
                "textPath": text_path(source_id, page_no),
                "textChars": len(text),
                "textStatus": text_status,
                "textError": text_error,
                "visualRequired": bool(reasons),
                "visualReasons": reasons,
                "visualStatus": visual_status,
                "renderError": render_error,
                "pageClass": classified,
                "riskTier": risk,
                "policy": {"dpi": policy_dpi,
                           "doubleRead": bool(args.policy == "quality" and risk == "high"
                                             and (args.budget is None or args.budget > 0)),
                           "mode": policy_mode},
                "renders": renders,
                "pendingReason": (cached.get("pendingReason") or "") if visual_status == "pending" else "",
            })
    except Exception as error:  # noqa: BLE001 - one source must not abort the whole run
        result["errors"].append("PDF 处理中断：%s" % error)
    finally:
        document.close()

    result["status"] = derive_status(result["pages"], result["pageCount"])
    return result


def derive_status(pages, page_count: int) -> str:
    if page_count == 0:
        return "failed"
    readable = [page for page in pages if page.get("imageSha256") and not page.get("renderError")]
    if not readable:
        return "failed"
    if len(readable) < page_count:
        return "partial"
    return "prepared"


def prepare_image(case_dir, relative_path, source_id, stem, prev, args):
    from PIL import Image, ImageOps

    abs_path = os.path.join(case_dir, relative_path)
    result = {"pages": [], "pageCount": 0, "status": "prepared", "errors": []}
    try:
        with Image.open(abs_path) as opened:
            frames = getattr(opened, "n_frames", 1)
            result["pageCount"] = frames
            for index in range(frames):
                opened.seek(index)
                page_no = index + 1
                cached = prev.get(page_no, {})
                reasons = visual_reasons("image", "empty", "", args.visual, args.visual_pages, page_no)
                risk = "high"
                target_dpi = initial_dpi(args.policy, risk, frames, args.base_dpi)
                renders = existing_renders(case_dir, cached, args.base_dpi)

                def render_fn(_dpi, index=index):
                    opened.seek(index)
                    return flatten_to_rgb(ImageOps.exif_transpose(opened)), 0

                appended = False
                skip_first_pass = bool(args.re_render_pages) and bool(renders)
                if not skip_first_pass:
                    first_dpi = args.base_dpi if args.re_render_pages else target_dpi
                    base_render = ensure_render(
                        case_dir, source_id, stem, page_no, first_dpi, args.base_dpi,
                        "", {"renders": renders}, render_fn, "page", force=args.force)
                    if not any(item.get("n") == base_render["n"] for item in renders):
                        renders.append(base_render)
                        appended = True
                    target_dpi = first_dpi

                if page_no in args.re_render_pages:
                    mode = "tile" if args.mode == "tile" else "page"
                    extra_dpi = args.dpi
                    if not args.re_render_dpi_explicit and renders:
                        extra_dpi = min(600, max(args.dpi, int(renders[-1].get("dpi") or 0) + 100))
                    extra = ensure_render(
                        case_dir, source_id, stem, page_no, extra_dpi, args.base_dpi,
                        "", {"renders": renders}, render_fn, mode)
                    if not any(item.get("n") == extra["n"] for item in renders):
                        renders.append(extra)
                        appended = True

                renders.sort(key=lambda item: int(item.get("n") or 0))
                latest = renders[-1] if renders else {}
                policy_mode = "none"
                if len(renders) > 1:
                    policy_mode = "tile" if latest.get("mode") == "tile" else "dpi-retry"
                policy_dpi = int(latest.get("dpi") or target_dpi)
                if appended and len(renders) > 1 and "render-escalated" not in reasons:
                    reasons = reasons + ["render-escalated"]
                previous_visual = cached.get("visualStatus") or ""
                unchanged = latest.get("imageSha256") == (cached.get("imageSha256") or "")
                if appended and len(renders) > 1:
                    visual_status = "pending"
                elif args.visual == "none":
                    visual_status = "skipped"
                    reasons = []
                elif unchanged and previous_visual in ("done", "unreadable", "skipped"):
                    reasons = cached.get("visualReasons", reasons)
                    visual_status = previous_visual
                else:
                    visual_status = "pending" if reasons else "not-required"
                result["pages"].append({
                    "page": page_no,
                    "image": latest.get("image", ""),
                    "imageSha256": latest.get("imageSha256", ""),
                    "imageBytes": int(latest.get("imageBytes") or 0),
                    "width": int(latest.get("width") or 0),
                    "height": int(latest.get("height") or 0),
                    "pageRotation": 0,
                    "textPath": "",
                    "textChars": 0,
                    "textStatus": "empty",
                    "textError": "",
                    "visualRequired": bool(reasons),
                    "visualReasons": reasons,
                    "visualStatus": visual_status,
                    "renderError": "",
                    "pageClass": "image",
                    "riskTier": risk,
                    "policy": {"dpi": policy_dpi,
                               "doubleRead": bool(args.policy == "quality"
                                                 and (args.budget is None or args.budget > 0)),
                               "mode": policy_mode},
                    "renders": renders,
                    "pendingReason": (cached.get("pendingReason") or "") if visual_status == "pending" else "",
                })
    except Exception as error:  # noqa: BLE001 - report the source, continue with others
        return {**result, "status": "failed", "errors": result["errors"] + ["图片打开失败：%s" % error]}
    result["status"] = derive_status(result["pages"], result["pageCount"])
    return result


def summarize(index) -> dict:
    coverage = {
        "sources": 0,
        "pages": 0,
        "pagesWithText": 0,
        "pagesWithoutText": 0,
        "pagesVisualRequired": 0,
        "pagesRecognized": 0,
        "pagesUnreadable": 0,
        "pagesPending": 0,
    }
    for source in index.get("sources", []):
        coverage["sources"] += 1
        for page in source.get("pages", []):
            coverage["pages"] += 1
            if page.get("textStatus") == "ok":
                coverage["pagesWithText"] += 1
            else:
                coverage["pagesWithoutText"] += 1
            if page.get("visualRequired"):
                coverage["pagesVisualRequired"] += 1
            if page.get("visualStatus") == "done":
                coverage["pagesRecognized"] += 1
            elif page.get("visualStatus") == "unreadable":
                coverage["pagesUnreadable"] += 1
            elif page.get("visualStatus") == "pending":
                coverage["pagesPending"] += 1
    index["coverage"] = coverage
    return coverage


def scan_materials(case_dir, src_dirs, only=None):
    if only:
        # `--only` 是审核侧兜底清单的入口：只认清单里的文件，不扫目录。
        return sorted(only), []
    found = []
    skipped = []
    for src in src_dirs:
        root = os.path.join(case_dir, src)
        if not os.path.isdir(root):
            continue
        for current, _dirs, files in os.walk(root):
            for name in sorted(files):
                absolute = os.path.join(current, name)
                relative = ocr_runtime.relpath(case_dir, absolute)
                extension = os.path.splitext(name)[1].lower()
                if extension in PDF_EXTS or extension in IMAGE_EXTS:
                    found.append(relative)
                else:
                    skipped.append({"relativePath": relative, "reason": "not-an-ocr-source"})
    return sorted(found), skipped


def resolve_only(case_dir, values):
    """把 `--only` 归一成案例内 POSIX 相对路径；返回 `(paths, problems)`。

    清单来自编排层的 `ocrRequired[].path`，所以只接受案例内相对路径：绝对路径、`..`、
    非 OCR 源扩展名、不存在的文件一律拒绝（**拒绝而不是清洗**——静默清洗会让调用方以为
    处理了它清单里的那条）。
    """
    resolved, problems = [], []
    for raw in values:
        item = (raw or "").strip().replace("\\", "/")
        if item.startswith("./"):
            item = item[2:]
        if item == "":
            problems.append("空路径")
            continue
        if item.startswith("/") or re.match(r"^[A-Za-z]:", item):
            problems.append("不接受绝对路径：%s" % raw)
            continue
        if ".." in item.split("/"):
            problems.append("路径不能含 ..：%s" % raw)
            continue
        extension = os.path.splitext(item)[1].lower()
        if extension not in PDF_EXTS and extension not in IMAGE_EXTS:
            problems.append("不是 OCR 源（只接受 PDF/图片）：%s" % raw)
            continue
        absolute = os.path.join(case_dir, *item.split("/"))
        if not os.path.isfile(absolute):
            problems.append("文件不存在：%s" % raw)
            continue
        resolved.append(item)
    return resolved, problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Render OCR sources and index their pages")
    parser.add_argument("--case", required=True, help="case directory (absolute path)")
    parser.add_argument("--src", action="append", default=None, help="source subdirectory, repeatable")
    parser.add_argument("--dpi", type=int, default=None, help="base DPI for first-pass rendering")
    parser.add_argument("--visual", default="auto", help="auto | all | none | pages:1,3-5")
    parser.add_argument("--deps", default="", help="optional wheel directory override (tests/debug)")
    parser.add_argument("--force", action="store_true", help="re-render pages even when cached")
    parser.add_argument("--reset", action="store_true", help="drop previously indexed sources (default: keep)")
    parser.add_argument("--policy", choices=POLICY_CHOICES, default="auto",
                        help="initial DPI policy: fast | auto | quality")
    parser.add_argument("--budget", type=int, default=None,
                        help="max double reads; 0 disables double reads")
    parser.add_argument("--force-budget", action="store_true",
                        help="allow --re-render to exceed the double-read budget")
    parser.add_argument("--re-render", default="",
                        help='"pages:3,7-9" — render these pages again as a new variant')
    parser.add_argument("--mode", choices=RENDER_MODES, default="dpi-retry",
                        help="re-render mode: dpi-retry | tile")
    parser.add_argument("--only", action="append", default=None,
                        help="case-relative path to index; repeatable (audit fallback list)")
    args = parser.parse_args(argv)
    started_at = time.monotonic()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    case_dir = os.path.abspath(args.case)
    if not os.path.isdir(case_dir):
        ocr_runtime.emit(ocr_runtime.fail("input", "案例目录不存在：%s" % args.case))
        return ocr_runtime.EXIT_USAGE
    try:
        args.visual, args.visual_pages = parse_visual(args.visual)
    except (ValueError, TypeError) as error:
        ocr_runtime.emit(ocr_runtime.fail("input", str(error)))
        return ocr_runtime.EXIT_USAGE
    if args.dpi is not None and (args.dpi < 72 or args.dpi > 600):
        ocr_runtime.emit(ocr_runtime.fail("input", "--dpi 只接受 72–600"))
        return ocr_runtime.EXIT_USAGE
    if args.budget is not None and args.budget < 0:
        ocr_runtime.emit(ocr_runtime.fail("input", "--budget 不能为负"))
        return ocr_runtime.EXIT_USAGE
    args.re_render_pages = set()
    if args.re_render.strip():
        spec = args.re_render.strip()
        if not spec.startswith("pages:"):
            ocr_runtime.emit(ocr_runtime.fail("input", "--re-render 只接受 pages:3,7-9"))
            return ocr_runtime.EXIT_USAGE
        try:
            args.re_render_pages = ocr_runtime.parse_page_selection(spec[len("pages:"):])
        except ValueError as error:
            ocr_runtime.emit(ocr_runtime.fail("input", str(error)))
            return ocr_runtime.EXIT_USAGE
    elif args.mode != "dpi-retry":
        ocr_runtime.emit(ocr_runtime.fail("input", "--mode 只能与 --re-render 同时使用"))
        return ocr_runtime.EXIT_USAGE

    out_index = os.path.join(case_dir, "ocr", "index.json")
    previous = ocr_runtime.read_json(out_index, {}) or {}
    previous_dpi = int((previous.get("render") or {}).get("dpi") or DEFAULT_DPI)
    explicit_dpi = args.dpi is not None
    args.dpi = args.dpi if explicit_dpi else DEFAULT_DPI
    if args.re_render_pages:
        args.base_dpi = previous_dpi
        if not explicit_dpi:
            args.dpi = max(args.base_dpi, HIGH_DPI)
    elif explicit_dpi:
        args.base_dpi = args.dpi
    else:
        args.base_dpi = previous_dpi
    args.re_render_dpi_explicit = explicit_dpi

    previous_sources = previous.get("sources") or []
    prev_double = sum(max(0, len(page.get("renders") or []) - 1)
                      for source in previous_sources for page in source.get("pages") or [])
    prev_required = sum(1 for source in previous_sources
                        for page in source.get("pages") or [] if page.get("visualRequired"))

    only = []
    if args.only:
        # 三种组合都没有"正确解释"：--reset 会丢清单外来源，--src 与案例内路径重叠。
        if args.reset:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "--only 与 --reset 不能同时使用：--reset 会丢弃清单外的既有来源"))
            return ocr_runtime.EXIT_USAGE
        if args.src:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "--only 与 --src 不能同时使用：--only 已按案例内相对路径定位文件"))
            return ocr_runtime.EXIT_USAGE
        only, problems = resolve_only(case_dir, args.only)
        if problems:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "--only 的路径不合法：" + "；".join(problems),
                action="只提交材料盘点 ocrRequired[].path 里的案例内相对路径（PDF/图片）"))
            return ocr_runtime.EXIT_USAGE

    if args.force_budget and not args.re_render_pages and not args.force:
        ocr_runtime.emit(ocr_runtime.fail(
            "input", "--force-budget 只能与 --re-render 或 --force 一起使用"))
        return ocr_runtime.EXIT_USAGE

    indexed_pages = {page.get("page"): page
                     for source in previous_sources for page in source.get("pages") or []}

    def expected_extra_dpi(page):
        if args.re_render_dpi_explicit:
            return args.dpi
        renders = page.get("renders") or []
        if not renders:
            return args.dpi
        return min(600, max(args.dpi, int(renders[-1].get("dpi") or 0) + 100))

    def variant_exists(page, dpi, mode):
        for item in page.get("renders") or []:
            if not isinstance(item, dict) or item.get("dpi") != dpi or item.get("mode") != mode:
                continue
            rel = item.get("image") or ""
            if not rel:
                continue
            absolute = os.path.join(case_dir, *rel.split("/"))
            if (os.path.isfile(absolute) and os.path.getsize(absolute) > 0
                    and ocr_runtime.sha256_file(absolute) == item.get("imageSha256")):
                return True
        return False

    if args.re_render_pages:
        if not indexed_pages:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "--re-render 需要既有索引：先运行一次 ocr_prepare.py 建立索引"))
            return ocr_runtime.EXIT_USAGE
        missing = sorted(args.re_render_pages - set(indexed_pages))
        if missing:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "--re-render 的页号不在索引范围内：%s" % missing))
            return ocr_runtime.EXIT_USAGE
        render_mode = "tile" if args.mode == "tile" else "page"
        new_slots = sum(1 for page_no in args.re_render_pages
                        if not variant_exists(indexed_pages[page_no],
                                              expected_extra_dpi(indexed_pages[page_no]),
                                              render_mode))
        gate_cap = budget_for(max(prev_required, len(args.re_render_pages)),
                              args.policy, args.budget)["maxDoubleReads"]
        if prev_double + new_slots > gate_cap and not args.force_budget:
            ocr_runtime.emit(ocr_runtime.fail(
                "input",
                "重渲超出双读预算：已有 %d 次，本次新增 %d 页，上限 %d；如确需超预算请加 --force-budget"
                % (prev_double, new_slots, gate_cap)))
            return ocr_runtime.EXIT_USAGE

    if args.force and not args.re_render_pages and indexed_pages:
        force_slots = len(indexed_pages)
        force_cap = budget_for(max(prev_required, force_slots),
                               args.policy, args.budget)["maxDoubleReads"]
        if prev_double + force_slots > force_cap and not args.force_budget:
            ocr_runtime.emit(ocr_runtime.fail(
                "input",
                "--force 会重渲全部 %d 页，超出双读预算（已有 %d 次，上限 %d）；如确需超预算请加 --force-budget"
                % (force_slots, prev_double, force_cap)))
            return ocr_runtime.EXIT_USAGE

    runtime = ocr_runtime.ensure_dependencies(script_dir, case_dir, args.deps)
    if not runtime["ok"]:
        ocr_runtime.emit({**runtime, "action": "确认插件包包含双平台 OCR 依赖，或让部署方补齐；不要在审核中临时安装"})
        return ocr_runtime.EXIT_CAPABILITY_GAP
    import PIL
    import pypdf

    engine, engine_notes = ocr_engines.select_pdf_engine()
    materials, skipped = scan_materials(case_dir, args.src or list(DEFAULT_SRC), only)
    has_pdf = any(os.path.splitext(item)[1].lower() in PDF_EXTS for item in materials)
    if has_pdf and engine is None:
        ocr_runtime.emit(ocr_runtime.fail(
            "capability-gap",
            "没有可用的 PDF 页面渲染通道：" + "；".join(engine_notes),
            action="在受支持平台运行，或让部署方随 DSH 运行时提供 pypdfium2；不要在审核中临时安装",
        ))
        return ocr_runtime.EXIT_CAPABILITY_GAP

    index = {
        "schemaVersion": ocr_runtime.SCHEMA_VERSION,
        "generatedAt": now(),
        "render": {
            "dpi": args.base_dpi,
            "scale": round(args.base_dpi / 72.0, 4),
            "format": "png",
            "imageFormat": "PNG",
            "engine": engine.label if engine is not None else "",
            "engineNotes": engine_notes,
        },
        "runtime": ocr_runtime.dependency_summary(runtime),
        "sources": [],
        "skipped": [],
    }
    engine_tag = "%s|pypdf@%s|pillow@%s" % (
        engine.label if engine is not None else "none", pypdf.__version__, PIL.__version__)
    # `--src 复核-人工` is a second pass: keep sources already indexed by the first
    # pass instead of silently dropping stage-one evidence. `--reset` opts out.
    scanned = set(materials)
    previous_sources = [] if args.reset else [
        source for source in previous.get("sources", [])
        if isinstance(source, dict) and source.get("relativePath") not in scanned
    ]
    index["sources"] = [source for source in previous_sources if isinstance(source, dict)]
    previous_skipped = [] if args.reset else [
        item for item in previous.get("skipped", [])
        if isinstance(item, dict) and item.get("relativePath") not in scanned
    ]
    index["skipped"] = previous_skipped + skipped

    for relative in materials:
        absolute = os.path.join(case_dir, relative)
        try:
            digest = ocr_runtime.sha256_file(absolute)
            size_bytes = os.path.getsize(absolute)
        except OSError as error:
            index["sources"].append({
                "sourceId": "", "kind": "pdf" if os.path.splitext(relative)[1].lower() in PDF_EXTS else "image",
                "relativePath": relative, "sha256": "", "bytes": 0, "extension": "",
                "cacheKey": "", "pageCount": 0, "status": "failed",
                "errors": ["源文件读不出来：%s" % error], "pages": [],
            })
            continue
        extension = os.path.splitext(relative)[1].lower()
        kind = "pdf" if extension in PDF_EXTS else "image"
        source_id = source_id_for(relative, digest)
        stem = ocr_runtime.safe_source_id(relative)
        prev = previous_pages(previous, relative)
        page_count_hint = len(prev) if prev else 0
        cache_key = "%s|kind=%s|pages=%s|render=png@%s|engine=%s" % (
            digest, kind, page_count_hint, args.base_dpi, engine_tag)

        if kind == "pdf":
            prepared = prepare_pdf(case_dir, relative, source_id, stem, prev, args, engine)
        else:
            prepared = prepare_image(case_dir, relative, source_id, stem, prev, args)

        entry = {
            "sourceId": source_id,
            "kind": kind,
            "relativePath": relative,
            "sha256": digest,
            "bytes": size_bytes,
            "extension": extension,
            "cacheKey": cache_key.replace("pages=%s" % page_count_hint, "pages=%s" % prepared["pageCount"]),
            "pageCount": prepared["pageCount"],
            "status": prepared["status"],
            "errors": prepared["errors"],
            "pages": prepared["pages"],
        }
        index["sources"].append(entry)

    if args.re_render_pages:
        available = {page.get("page") for source in index["sources"]
                     if source.get("relativePath") in scanned
                     for page in source.get("pages", [])}
        missing = sorted(args.re_render_pages - available)
        if missing:
            ocr_runtime.emit(ocr_runtime.fail(
                "input", "--re-render 的页号不在本次索引范围内：%s" % missing))
            return ocr_runtime.EXIT_USAGE

    required_pages = sum(1 for source in index["sources"]
                         for page in source.get("pages", []) if page.get("visualRequired"))
    budget = budget_for(required_pages, args.policy, args.budget)
    budget["doubleReads"] = sum(max(0, len(page.get("renders") or []) - 1)
                                for source in index["sources"] for page in source.get("pages", []))
    budget["imageCalls"] = sum(len(page.get("renders") or [])
                               for source in index["sources"] for page in source.get("pages", []))
    budget["pagesRead"] = count_pages_read(case_dir)
    budget["exhausted"] = bool(required_pages) and budget["doubleReads"] >= budget["maxDoubleReads"]
    if budget["doubleReads"] > budget["maxDoubleReads"]:
        budget["exceededBy"] = budget["doubleReads"] - budget["maxDoubleReads"]
    max_render_width = max([int(item.get("width") or 0)
                            for source in index["sources"]
                            for page in source.get("pages", [])
                            for item in page.get("renders") or [] if isinstance(item, dict)] or [0])
    note = ocr_runtime.resolution_note(max_render_width)
    if note and note not in engine_notes:
        engine_notes.append(note)
    budget["elapsedMs"] = int((time.monotonic() - started_at) * 1000)
    index["budget"] = budget

    summarize(index)
    ocr_runtime.write_json_atomic(out_index, index)

    ocr_runtime.emit({
        "ok": True,
        "errorKind": "",
        "indexPath": "ocr/index.json",
        "runtime": index["runtime"],
        "coverage": index["coverage"],
        "sources": [
            {
                "sourceId": source["sourceId"],
                "relativePath": source["relativePath"],
                "kind": source["kind"],
                "pageCount": source["pageCount"],
                "status": source["status"],
                "visualRequiredPages": [page["page"] for page in source["pages"] if page.get("visualRequired")],
                "unreadablePages": [page["page"] for page in source["pages"]
                                    if page.get("visualStatus") == "unreadable" or page.get("renderError")],
                "errors": source["errors"],
            }
            for source in index["sources"]
        ],
    })
    return ocr_runtime.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
