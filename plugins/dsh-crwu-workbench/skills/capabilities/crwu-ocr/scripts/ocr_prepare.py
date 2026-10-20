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
import os
import re
import sys

import ocr_engines
import ocr_runtime

DEFAULT_SRC = ("材料-源",)
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff")
PDF_EXTS = (".pdf",)
DEFAULT_DPI = 144
MIN_TEXT_CHARS = 20


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
            image_rel = page_image_path(source_id, stem, page_no)
            image_abs = os.path.join(case_dir, image_rel)
            cached = prev.get(page_no, {})
            image_sha = ""
            width = 0
            height = 0
            rotation = int(cached.get("pageRotation") or 0)
            render_error = ""

            reusable = (
                not args.force
                and cached.get("imageSha256")
                and cached.get("engine") == engine.label
                and os.path.isfile(image_abs)
                and os.path.getsize(image_abs) > 0
                and ocr_runtime.sha256_file(image_abs) == cached.get("imageSha256")
            )
            if reusable:
                image_sha = cached["imageSha256"]
                width = int(cached.get("width") or 0)
                height = int(cached.get("height") or 0)
            else:
                try:
                    image, rotation = document.render(page_no, args.dpi)
                    os.makedirs(os.path.dirname(image_abs), exist_ok=True)
                    image.save(image_abs, format="PNG")
                    width, height = image.size
                    image_sha = ocr_runtime.sha256_file(image_abs)
                except Exception as error:  # noqa: BLE001 - one bad page must not stop the rest
                    render_error = "第 %s 页渲染失败：%s" % (page_no, error)
                    if os.path.isfile(image_abs) and os.path.getsize(image_abs) == 0:
                        os.remove(image_abs)

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

            reasons = [] if render_error else visual_reasons(
                "pdf", text_status, text, args.visual, args.visual_pages, page_no)
            previous_visual = cached.get("visualStatus") or ""
            if reusable and previous_visual in ("done", "unreadable", "skipped"):
                visual_status = previous_visual
            elif args.visual == "none":
                visual_status = "skipped"
            else:
                visual_status = "pending" if reasons else "not-required"

            result["pages"].append({
                "page": page_no,
                "image": image_rel if image_sha else "",
                "imageSha256": image_sha,
                "imageBytes": os.path.getsize(image_abs) if image_sha else 0,
                "width": width,
                "height": height,
                "pageRotation": rotation,
                "engine": engine.label,
                "textPath": text_path(source_id, page_no),
                "textChars": len(text),
                "textStatus": text_status,
                "textError": text_error,
                "visualRequired": bool(reasons),
                "visualReasons": reasons,
                "visualStatus": "unreadable" if render_error else visual_status,
                "renderError": render_error,
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
                image_rel = page_image_path(source_id, stem, page_no)
                image_abs = os.path.join(case_dir, image_rel)
                cached = prev.get(page_no, {})
                reusable = (
                    not args.force
                    and cached.get("imageSha256")
                    and os.path.isfile(image_abs)
                    and os.path.getsize(image_abs) > 0
                    and ocr_runtime.sha256_file(image_abs) == cached.get("imageSha256")
                )
                if reusable:
                    image_sha = cached["imageSha256"]
                    width, height = int(cached.get("width") or 0), int(cached.get("height") or 0)
                else:
                    image = flatten_to_rgb(ImageOps.exif_transpose(opened))
                    os.makedirs(os.path.dirname(image_abs), exist_ok=True)
                    image.save(image_abs, format="PNG")
                    image_sha = ocr_runtime.sha256_file(image_abs)
                    width, height = image.size
                previous_visual = cached.get("visualStatus") or ""
                reasons = visual_reasons("image", "empty", "", args.visual, args.visual_pages, page_no)
                if reusable and previous_visual in ("done", "unreadable", "skipped"):
                    reasons = cached.get("visualReasons", reasons)
                    visual_status = previous_visual
                elif args.visual == "none":
                    visual_status = "skipped"
                    reasons = []
                else:
                    visual_status = "pending" if reasons else "not-required"
                result["pages"].append({
                    "page": page_no,
                    "image": image_rel,
                    "imageSha256": image_sha,
                    "imageBytes": os.path.getsize(image_abs),
                    "width": width,
                    "height": height,
                    "textPath": "",
                    "textChars": 0,
                    "textStatus": "empty",
                    "textError": "",
                    "visualRequired": bool(reasons),
                    "visualReasons": reasons,
                    "visualStatus": visual_status,
                    "renderError": "",
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
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument("--visual", default="auto", help="auto | all | none | pages:1,3-5")
    parser.add_argument("--deps", default="", help="optional wheel directory override (tests/debug)")
    parser.add_argument("--force", action="store_true", help="re-render pages even when cached")
    parser.add_argument("--reset", action="store_true", help="drop previously indexed sources (default: keep)")
    parser.add_argument("--only", action="append", default=None,
                        help="case-relative path to index; repeatable (audit fallback list)")
    args = parser.parse_args(argv)

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
    if args.dpi < 72 or args.dpi > 600:
        ocr_runtime.emit(ocr_runtime.fail("input", "--dpi 只接受 72–600"))
        return ocr_runtime.EXIT_USAGE

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

    out_index = os.path.join(case_dir, "ocr", "index.json")
    previous = ocr_runtime.read_json(out_index, {}) or {}
    index = {
        "schemaVersion": ocr_runtime.SCHEMA_VERSION,
        "generatedAt": now(),
        "render": {
            "dpi": args.dpi,
            "scale": round(args.dpi / 72.0, 4),
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
            digest, kind, page_count_hint, args.dpi, engine_tag)

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
