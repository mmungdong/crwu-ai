#!/usr/bin/env python3
"""多类型估值资料的提取脚本（报告评估）。

契约（Host 的 `crwu_valuation_file_extract` 按它解析）：

    python3 extract_files.py <输入文件绝对路径> <输出 JSON 绝对路径>

**永远写出一个合法 JSON**，形状固定：

    { "ok": bool, "error": str, "fileName": str, "fileType": str,
      "text": str, "tables": [{"name": str, "rows": [[str, ...], ...]}],
      "images": [{"path": str, "description": str}],
      "extractedFields": {str: str}, "warnings": [str], "capabilityGaps": [str],
      "pages": [{"index": int, "hasTextLayer": bool, "chars": int, "warning"?: str}],
      "pageCount": int, "pagesWithText": int, "pagesWithoutText": int,
      "capabilities": {"pdfText": bool, "pdfRender": bool, "imageOcr": bool,
                       "visionFallback": "none" | "session-images"},
      "capabilityProbe": {str: str} }

三条硬口径（都是"宁可说读不出来，也不许编"）：

1. **缺库就说缺库**。这台运行时装了 python-docx / openpyxl / Pillow，但**没有** PDF 文本库；
   于是 .pdf 只能如实进 `capabilityGaps`，绝不自己解析内容流去猜字形 ——
   猜错一个字号或编码，坐落与面积就跟着错，而那会一路进计算。
2. **旧版二进制 Office（.doc / .xls）同样报缺口**：没有 antiword / xlrd 就直说。
3. **字段只做"标签锚定"提取**：只有在正文里真的出现 `坐落：…` 这种带标签的行时才记录，
   不做任何推断（不认识就不出现，缺失由上层表达）。`extractedFields` 里的值一律是**原文**。

扫描件（图片 / 无文本层 PDF）进入"待识别"状态：记 `capabilityGaps`，不编造字段。

## P1：逐页事实 + 能力声明

"PDF 无文本层"这一句话不够用 —— 会话看不出**哪几页**有文本层，也看不出本部署到底能不能
把页面渲染成图像，于是无法决定"改读页面图像"还是"直接请人工补关键页"。所以：

- `pages` 按页记录 `hasTextLayer` / `chars`（`chars` 是去掉空白后的字符数），`pageCount`
  是文档总页数；无文本层的页**一个字段都不产生**；
- 无文本层的页合成**一条**可执行缺口，写明页码区间与人工动作
  （`第 3–5 页无文本层：…，请人工核对这几页的坐落/面积/权属`）；
- `capabilities` / `capabilityProbe` 是**当场探到**的部署能力（import 与 PATH 探测），
  不是写死的声明：没有渲染器就报 `pdfRender: false`，没有 OCR 引擎就报 `imageOcr: false`；
- 会话仍可读 PDF 的**内嵌**页面图像（扫描件一页通常就是一张位图）：能导出就写进
  `<结果 JSON 同级>/<结果名>-页面图片/` 并登记进 `images`（`path` 相对结果 JSON 所在目录，
  `description` 带 `<文件名>#第<N>页图片#<M>` 定位符，并如实写"内容未识别"）；
  导不出来就说清为什么 —— 两种都不许沉默。
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sys
import traceback

# 单份文件的正文上限：再多也不会全进模型上下文，而超长正文会让 JSON 变得难传输。
TEXT_MAX = 200_000
# 单张表的行/列上限：估值只关心前若干行（明细表往往几千行）。
TABLE_MAX_ROWS = 500
TABLE_MAX_COLS = 64
# 单个字段值的长带上限（超过基本是抓错了行）。
FIELD_MAX = 200
# 逐页文本层探查的页数上限：超过这个量，逐页解析的代价已经不划算。
PAGE_PROBE_MAX = 200
# 内嵌页面图像的导出上限（张数 / 单张字节数）：扫描件一页就是好几 MB。
PAGE_IMAGE_MAX = 20
PAGE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
# 页面图像目录名后缀（落在结果 JSON 的同级目录下）。
PAGE_IMAGE_DIR_SUFFIX = "-页面图片"

# PDF 文本层库：按可靠性排序，取第一个真的 import 得到的。
PDF_TEXT_MODULES = ("pypdf", "PyPDF2", "pdfminer.high_level")
# 能把 PDF 页**渲染成位图**的命令。qpdf 只是结构工具，单有它出不了图，所以不计入。
PDF_RASTERIZER_COMMANDS = ("pdftoppm", "pdftocairo", "mutool", "gs")
# 顺带探测（只为把"探过什么"写进证据，不影响 pdfRender 的结论）。
PDF_RASTERIZER_EXTRA_PROBES = ("qpdf",)
# 能自己栅格化的 Python 库。
PDF_RENDER_MODULES = ("fitz", "pymupdf")
# 能取 PDF 页面**内嵌位图**的库（是渲染之外的退路）。
PDF_IMAGE_MODULES = ("pypdf", "PyPDF2")
# OCR 引擎：pytesseract 只是壳，底层二进制不在 PATH 时它认不出任何字。
OCR_MODULES = ("easyocr", "paddleocr", "tesserocr", "pytesseract")
OCR_REQUIRED_BINARIES = {"pytesseract": ("tesseract",)}


# 标签 → 字段名。**只列明确的业务标签**，不做语义推断。
# 值部分允许空一行内的中英文冒号、或直接跟空格。
FIELD_LABELS = (
    ("坐落", ("坐落", "地址", "坐落地址", "房屋坐落", "土地坐落")),
    ("房屋性质", ("房屋性质", "房产性质")),
    ("用途", ("用途", "规划用途", "实际用途", "房屋用途", "土地用途")),
    ("建筑面积", ("建筑面积", "总建筑面积", "建筑面积（㎡）", "建筑面积(㎡)")),
    ("套内面积", ("套内建筑面积", "套内面积")),
    ("土地面积", ("土地面积", "宗地面积", "土地使用权面积")),
    ("楼层", ("所在楼层", "楼层", "层数")),
    ("总楼层", ("总层数", "总楼层", "建筑总层数")),
    ("建筑结构", ("建筑结构", "结构", "结构类型")),
    ("建成年代", ("建成年代", "建成年份", "竣工日期", "竣工时间", "建成年月")),
    ("权属信息", ("权属", "权属状况", "权属人", "权利人", "产权证号", "不动产权证号")),
    ("租赁信息", ("租赁", "租赁情况", "租约", "租金")),
    ("价格信息", ("价格", "评估价值", "单价", "总价", "挂牌价", "成交价")),
    ("已知案例线索", ("可比案例", "案例", "成交案例", "参照案例")),
)

LABEL_RE = re.compile(
    r"^\s*(?P<label>" + "|".join(
        re.escape(alias) for _, aliases in FIELD_LABELS for alias in aliases
    ) + r")\s*[:：]?\s*(?P<value>.+?)\s*$"
)
ALIAS_TO_FIELD = {alias: field for field, aliases in FIELD_LABELS for alias in aliases}


def _importable(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def probe_capabilities() -> tuple:
    """当场探一次本部署的 PDF / OCR / 视觉能力，返回 `(facts, evidence)`。

    `facts` 是会话可以依赖的结论；`evidence` 是**探到了什么**（库名 / 命令名），
    让"本部署没有渲染能力"这句话可复核，而不是脚本里写死的一句声明。

    只做 import 与 PATH 探测：不渲染、不识别、不写文件、不联网。探测失败时如实记进
    `evidence["probeError"]`，并把结论保守地留在"不能"那一侧 —— 没验过就不许声明能做。
    """
    facts = {"pdfText": False, "pdfRender": False, "imageOcr": False, "visionFallback": "none"}
    evidence = {
        "pdfTextLibrary": "",
        "rasterizer": "",
        "pdfImageExtractor": "",
        "ocrEngine": "",
        "probedRasterizers": "、".join(PDF_RASTERIZER_COMMANDS + PDF_RASTERIZER_EXTRA_PROBES),
        "probe": "importlib.util.find_spec + shutil.which",
        "probeError": "",
    }
    try:
        evidence["pdfTextLibrary"] = next((name for name in PDF_TEXT_MODULES if _importable(name)), "")
        evidence["pdfImageExtractor"] = next((name for name in PDF_IMAGE_MODULES if _importable(name)), "")
        rasterizer = next((name for name in PDF_RASTERIZER_COMMANDS if shutil.which(name)), "")
        if rasterizer == "":
            rasterizer = next((name for name in PDF_RENDER_MODULES if _importable(name)), "")
        evidence["rasterizer"] = rasterizer
        for name in OCR_MODULES:
            if not _importable(name):
                continue
            # pytesseract 自己不带引擎：底层二进制不在就跳过它，别报一个用不了的能力。
            if any(shutil.which(binary) is None for binary in OCR_REQUIRED_BINARIES.get(name, ())):
                continue
            evidence["ocrEngine"] = name
            break
    except Exception as error:  # noqa: BLE001 - 探针不许把整份结果拖垮
        evidence["probeError"] = f"能力探测未完成（结论按「不能」处理）：{error}"
        return facts, evidence
    facts["pdfText"] = evidence["pdfTextLibrary"] != ""
    facts["pdfRender"] = evidence["rasterizer"] != ""
    facts["imageOcr"] = evidence["ocrEngine"] != ""
    return facts, evidence


def empty_result(file_name: str, file_type: str) -> dict:
    facts, evidence = probe_capabilities()
    return {
        "ok": False,
        "error": "",
        "fileName": file_name,
        "fileType": file_type,
        "text": "",
        "tables": [],
        "images": [],
        "extractedFields": {},
        "warnings": [],
        "capabilityGaps": [],
        "pages": [],
        "pageCount": 0,
        "pagesWithText": 0,
        "pagesWithoutText": 0,
        "capabilities": facts,
        "capabilityProbe": evidence,
    }


def meaningful_chars(text: str) -> int:
    """有效字数 = 去掉空白后的字符数（只有空白的页不算"有文本层"）。"""
    return len(re.sub(r"\s+", "", text or ""))


def page_range_text(pages) -> str:
    """`[3, 4, 5, 8]` → `3–5、8`（连续页码压成区间；en dash 与产品文案一致）。"""
    ordered = sorted({int(page) for page in pages})
    if not ordered:
        return ""
    runs = []
    start = previous = ordered[0]
    for page in ordered[1:]:
        if page == previous + 1:
            previous = page
            continue
        runs.append((start, previous))
        start = previous = page
    runs.append((start, previous))
    return "、".join(f"{first}" if first == last else f"{first}–{last}" for first, last in runs)


def no_text_layer_gap(pages, result: dict, image_error: str = "") -> str:
    """无文本层页的**一条**可执行缺口：页码区间 + 为什么读不到 + 人工动作。"""
    prefix = f"第 {page_range_text(pages)} 页无文本层："
    if result["images"]:
        recognition = (
            f"本部署有可用的 OCR 引擎 {result['capabilityProbe']['ocrEngine']}，但本脚本没有接入识别"
            if result["capabilities"]["imageOcr"]
            else "本部署没有 OCR 引擎"
        )
        # 已导出图像时**不许**说"本部署没有视觉能力"：图像就是给会话的视觉通道看的。
        return (
            f"{prefix}已导出内嵌页面图像 {len(result['images'])} 张（见 images）；"
            f"内容未识别（{recognition}），请会话按页判读或人工核对这几页的坐落/面积/权属"
        )
    missing = []
    if not result["capabilities"]["pdfRender"]:
        missing.append("本部署没有 PDF 页面渲染能力")
    else:
        missing.append("本部署有 PDF 页面渲染器，但本脚本未接入页面渲染")
    if image_error:
        missing.append(image_error)
    elif result["capabilityProbe"]["pdfImageExtractor"] == "":
        missing.append("也没有可用的 PDF 内嵌图像提取库")
    reason = "，".join(missing) if missing else "无法把这几页转成可识别的文本"
    return f"{prefix}{reason}，请人工核对这几页的坐落/面积/权属"


def kind_of(file_name: str) -> str:
    ext = os.path.splitext(file_name)[1].lower()
    if ext == ".pdf":
        return "pdf"
    if ext in (".doc", ".docx"):
        return "word"
    if ext in (".xls", ".xlsx", ".xlsm"):
        return "excel"
    if ext in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".heic", ".tif", ".tiff"):
        return "image"
    if ext in (".txt", ".md", ".csv"):
        return "text"
    if ext in (".zip", ".rar", ".7z"):
        return "archive"
    return "unknown"


def clamp(value: object, limit: int) -> str:
    text = "" if value is None else str(value)
    text = text.strip()
    return text[:limit]


def harvest_fields(text: str, fields: dict, warnings: list) -> None:
    """按行做标签锚定提取；同名标签只记**第一次**出现的值（后面的多半是别的段落）。"""
    for line in text.splitlines():
        match = LABEL_RE.match(line)
        if match is None:
            continue
        key = ALIAS_TO_FIELD.get(match.group("label"))
        if key is None or key in fields:
            continue
        value = clamp(match.group("value"), FIELD_MAX)
        # 只有一个标签、没有值（`坐落：`）不算读到东西。
        if value == "":
            continue
        fields[key] = value


def extract_docx(path: str, result: dict) -> None:
    try:
        import docx  # type: ignore
    except Exception as error:  # noqa: BLE001 - 缺库就是能力缺口
        result["capabilityGaps"].append(f"未安装 python-docx，无法读取 Word 正文：{error}")
        return
    document = docx.Document(path)
    paragraphs = [clamp(p.text, TEXT_MAX) for p in document.paragraphs]
    result["text"] = clamp("\n".join(line for line in paragraphs if line), TEXT_MAX)
    for index, table in enumerate(document.tables):
        rows = []
        for row in table.rows[:TABLE_MAX_ROWS]:
            rows.append([clamp(cell.text, 500) for cell in row.cells[:TABLE_MAX_COLS]])
        if rows:
            result["tables"].append({"name": f"表{index + 1}", "rows": rows})


def extract_xlsx(path: str, result: dict) -> None:
    try:
        import openpyxl  # type: ignore
    except Exception as error:  # noqa: BLE001
        result["capabilityGaps"].append(f"未安装 openpyxl，无法读取 Excel 表格：{error}")
        return
    # `data_only=True`：估值要看的是**公式算出来的值**，不是公式文本。
    # 但公式从未被 Excel 重算过时值会是 None —— 这时如实记一条观察。
    workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
    try:
        texts: list[str] = []
        for sheet in workbook.worksheets:
            rows = []
            for row in sheet.iter_rows(max_row=TABLE_MAX_ROWS, max_col=TABLE_MAX_COLS, values_only=True):
                cells = [clamp(cell, 500) for cell in row]
                while cells and cells[-1] == "":
                    cells.pop()
                if cells:
                    rows.append(cells)
            if rows:
                result["tables"].append({"name": clamp(sheet.title, 120) or "Sheet", "rows": rows})
                texts.append(clamp(sheet.title, 120))
                texts.extend(" ".join(r) for r in rows[:50])
            elif sheet.max_row and sheet.max_row > TABLE_MAX_ROWS:
                result["warnings"].append(f"工作表「{sheet.title}」超过 {TABLE_MAX_ROWS} 行，只取了前 {TABLE_MAX_ROWS} 行")
        if texts:
            result["text"] = clamp("\n".join(texts), TEXT_MAX)
        else:
            result["warnings"].append("工作簿里没有读到任何单元格内容（可能是空的，或者公式值从未被重算）")
    finally:
        workbook.close()


def extract_image(path: str, result: dict) -> None:
    try:
        from PIL import Image  # type: ignore
    except Exception as error:  # noqa: BLE001
        result["capabilityGaps"].append(f"未安装 Pillow，无法读取图片信息：{error}")
        return
    with Image.open(path) as image:
        width, height = image.size
        result["images"].append({
            "path": os.path.basename(path),
            "description": f"{image.format or '未知格式'} · {width}×{height}",
        })
        result["warnings"].append(f"图片已登记（{width}×{height}），但内容识别需要人工或 OCR")
    # 图片**没有文本层**：按口径进"待识别"，不编造任何字段。
    # 有没有 OCR 引擎是当场探到的（capabilities），不是写死的一句话。
    if result["capabilities"]["imageOcr"]:
        engine = result["capabilityProbe"]["ocrEngine"]
        result["capabilityGaps"].append(
            f"图片内容未识别（本部署有可用的 OCR 引擎 {engine}，但本脚本没有接入识别）："
            "请人工核对图片中的坐落、面积与权属信息"
        )
        return
    result["capabilityGaps"].append(
        "图片内容未识别（本部署没有可用的 OCR）：请人工核对图片中的坐落、面积与权属信息"
    )


def extract_pdf(path: str, result: dict, page_image_dir: str = "") -> None:
    """PDF：**逐页**探文本层；读不到的页留空，并合成一条带页码区间的缺口。

    刻意不自己解析 PDF 内容流：字形编码（CID / ToUnicode CMap）读错会产出**看起来像正文的
    乱码**，而乱码会被下游的标签提取当成坐落与面积 —— 那比"读不出来"危险得多。
    本脚本尚未接入页面**渲染**；当前的图像退路是提取 PDF 的**内嵌位图**，
    所以能力结论如实写在 capabilities 里，会话据此决定"改读页面图像"还是"请人工补关键页"。
    """
    library = result["capabilityProbe"]["pdfTextLibrary"]
    if library == "":
        result["capabilityGaps"].append(
            "本机 Python 没有可用的 PDF 文本读取库（pypdf / PyPDF2 / pdfminer 都没有）："
            "这一份 PDF 未解析，**逐页文本层事实也无法产生**。"
            "请人工提供关键页的文字，或换用 Word / Excel 资料。"
        )
        return

    try:
        facts, texts, page_count, truncated = _read_pdf_pages(library, path)
    except Exception as error:  # noqa: BLE001 - 读失败就是这一份读不出来
        result["capabilityGaps"].append(f"PDF 文本层读取失败：{error}")
        return

    # 真的 import 成功并读到了页：这是比 find_spec 更强的证据。
    result["capabilities"]["pdfText"] = True
    result["pages"] = facts
    result["pageCount"] = page_count
    result["pagesWithText"] = sum(1 for fact in facts if fact["hasTextLayer"])
    result["pagesWithoutText"] = len(facts) - result["pagesWithText"]
    result["text"] = clamp("\n".join(clamp(raw, TEXT_MAX) for raw in texts), TEXT_MAX)
    for fact in facts:
        # 逐页的读失败也进 warnings：上层只保证转发 warnings，结构化 pages 不保证被转发。
        if fact.get("warning"):
            result["warnings"].append(fact["warning"])
    if truncated:
        result["warnings"].append(
            f"PDF 共 {page_count} 页，只逐页检查了前 {PAGE_PROBE_MAX} 页（其余页本次未核，不进页码缺口）"
        )

    without_text = [fact["index"] for fact in facts if not fact["hasTextLayer"]]
    if without_text:
        image_error = _export_page_images(path, without_text, result, page_image_dir)
        # 已导出图像时缺口走"图像在哪"那一支，通道错误就单独进 warnings，别丢掉。
        if image_error and result["images"]:
            result["warnings"].append(image_error)
        result["capabilityGaps"].append(no_text_layer_gap(without_text, result, image_error))


def _page_fact(index: int, raw: str, warning: str = "") -> dict:
    chars = meaningful_chars(raw)
    fact = {"index": index, "hasTextLayer": chars > 0, "chars": chars}
    if warning:
        fact["warning"] = warning
    return fact


def _read_pdf_pages(library: str, path: str) -> tuple:
    """→ `(page_facts, page_texts, page_count, truncated)`；一页读不出来不影响其余页。"""
    if library == "pdfminer.high_level":
        from pdfminer.high_level import extract_pages  # type: ignore
        return _pages_via_extract_pages(extract_pages, path)
    return _pages_via_pypdf(__import__(library), path)


def _pages_via_pypdf(module, path: str) -> tuple:
    pages = module.PdfReader(path).pages
    facts, texts = [], []
    for index, page in enumerate(pages[:PAGE_PROBE_MAX], 1):
        warning = ""
        try:
            raw = page.extract_text() or ""
        except Exception as error:  # noqa: BLE001 - 这一页读不出来，别的页照读
            raw = ""
            warning = f"第 {index} 页文本读取失败：{error}"
        texts.append(raw)
        facts.append(_page_fact(index, raw, warning))
    return facts, texts, len(pages), len(pages) > len(facts)


def _pages_via_extract_pages(extract_pages, path: str) -> tuple:
    """pdfminer 路线：`extract_pages` 是生成器，页数只能边解析边数。"""
    facts, texts, truncated = [], [], False
    for index, layout in enumerate(extract_pages(path), 1):
        if index > PAGE_PROBE_MAX:
            truncated = True
            break
        warning = ""
        try:
            raw = layout.extract_text() or ""
        except Exception as error:  # noqa: BLE001
            raw = ""
            warning = f"第 {index} 页文本读取失败：{error}"
        texts.append(raw)
        facts.append(_page_fact(index, raw, warning))
    return facts, texts, len(facts), truncated


def _safe_image_name(index: int, order: int, raw_name: str) -> str:
    """页面图像的落盘名：只保留一个可信的扩展名，其余一律 `.bin`（不谎报格式）。"""
    extension = os.path.splitext(os.path.basename(str(raw_name or "")))[1].lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", extension):
        extension = ".bin"
    return f"第{index}页-图{order}{extension}"


def _export_page_images(path: str, page_indexes: list, result: dict, page_image_dir: str) -> str:
    """导出无文本层页的**内嵌位图**（此路径不渲染 PDF 页面）。

    成功返回空串；导不出来时返回"为什么"的一句话（由缺口文案统一带走），
    任何一页失败都不影响其余页。**没有识别**：只登记图像文件与定位符。
    """
    if result["capabilityProbe"]["pdfImageExtractor"] == "":
        return ""
    if page_image_dir == "":
        return "调用方没有给页面图像目录"
    try:
        os.makedirs(page_image_dir, exist_ok=True)
    except OSError as error:
        return f"页面图像目录创建失败：{error}"
    module = __import__(result["capabilityProbe"]["pdfImageExtractor"])
    try:
        pages = module.PdfReader(path).pages
    except Exception as error:  # noqa: BLE001
        return f"重新打开 PDF 以导出内嵌图像失败：{error}"

    directory = os.path.basename(page_image_dir)
    exported = 0
    for index in page_indexes:
        if exported >= PAGE_IMAGE_MAX:
            result["warnings"].append(f"内嵌页面图像只导出了前 {PAGE_IMAGE_MAX} 张，其余未导出")
            break
        try:
            images = list(pages[index - 1].images)
        except Exception as error:  # noqa: BLE001 - 缺 Pillow 之类：整条通道不可用
            return f"PDF 内嵌图像提取不可用：{error}"
        for order, image in enumerate(images, 1):
            if exported >= PAGE_IMAGE_MAX:
                break
            try:
                data = image.data
            except Exception as error:  # noqa: BLE001
                result["warnings"].append(f"第 {index} 页第 {order} 张内嵌图像读取失败：{error}")
                continue
            if not data:
                continue
            if len(data) > PAGE_IMAGE_MAX_BYTES:
                result["warnings"].append(
                    f"第 {index} 页第 {order} 张内嵌图像 {len(data)} 字节，超过单张上限 "
                    f"{PAGE_IMAGE_MAX_BYTES}：未导出"
                )
                continue
            name = _safe_image_name(index, order, getattr(image, "name", ""))
            try:
                with open(os.path.join(page_image_dir, name), "wb") as handle:
                    handle.write(data)
            except OSError as error:
                result["warnings"].append(f"第 {index} 页第 {order} 张内嵌图像写盘失败：{error}")
                continue
            exported += 1
            result["images"].append({
                # path 相对**结果 JSON 所在目录**（Host 把它落成 `<案例目录>/提取结果/…`）。
                "path": os.path.join(directory, name),
                "description": (
                    f"{result['fileName']}#第{index}页图片#{order} · 内嵌位图 · {len(data)} 字节 · "
                    "内容未识别（本脚本未接入 OCR，请会话按页判读或人工核对）"
                ),
            })
    return "" if exported else "未取得可导出的 PDF 内嵌图像"


def extract_text_file(path: str, result: dict) -> None:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
        try:
            with open(path, "r", encoding=encoding) as handle:
                result["text"] = clamp(handle.read(), TEXT_MAX)
            if encoding not in ("utf-8", "utf-8-sig"):
                result["warnings"].append(f"文本按 {encoding} 解码")
            return
        except UnicodeDecodeError:
            continue
        except OSError as error:
            result["capabilityGaps"].append(f"读取文本失败：{error}")
            return
    result["capabilityGaps"].append("文本编码无法识别（utf-8 / gb18030 都试过了）")


def run(input_path: str, file_name: str, page_image_dir: str = "") -> dict:
    kind = kind_of(file_name)
    result = empty_result(file_name, kind)

    if not os.path.isfile(input_path):
        result["error"] = f"输入文件不存在：{file_name}"
        return result
    if os.path.getsize(input_path) == 0:
        result["error"] = "输入文件是空文件（0 字节）"
        return result

    if kind == "pdf":
        extract_pdf(input_path, result, page_image_dir)
    elif kind == "word":
        if file_name.lower().endswith(".doc"):
            result["capabilityGaps"].append("旧版二进制 .doc 需要 antiword 或 LibreOffice 转换：本机没有，未解析")
        else:
            extract_docx(input_path, result)
    elif kind == "excel":
        if not file_name.lower().endswith((".xlsx", ".xlsm")):
            result["capabilityGaps"].append("旧版二进制 .xls 需要 xlrd 或另存为 .xlsx：本机没有，未解析")
        else:
            extract_xlsx(input_path, result)
    elif kind == "image":
        extract_image(input_path, result)
    elif kind == "text":
        extract_text_file(input_path, result)
    elif kind == "archive":
        result["capabilityGaps"].append("压缩包第一版不自动展开：请解压后重新上传其中的资料")
    else:
        result["capabilityGaps"].append(f"不认识的文件类型：{os.path.splitext(file_name)[1] or '（无扩展名）'}")

    harvest_fields(result["text"], result["extractedFields"], result["warnings"])
    for table in result["tables"]:
        for row in table["rows"][:200]:
            harvest_fields("\t".join(row), result["extractedFields"], result["warnings"])

    # `ok` 的含义是"这一次读取本身完成了"：读到了正文 / 表格 / 图片信息就算完成，
    # 缺口（需要 OCR、缺库）如实列在 capabilityGaps 里由上层决定怎么用。
    result["ok"] = bool(result["error"]) is False and (
        bool(result["text"].strip()) or bool(result["tables"]) or bool(result["images"])
    )
    # 视觉退路是**这一份的产物事实**：只有真的导出了会话能打开的图像，才敢说"可以看图像"。
    result["capabilities"]["visionFallback"] = "session-images" if result["images"] else "none"
    if not result["ok"] and result["error"] == "" and not result["capabilityGaps"]:
        result["capabilityGaps"].append("没有读到任何正文、表格或图片信息")
    return result


def main(argv: list) -> int:
    if len(argv) < 3:
        sys.stderr.write("用法：extract_files.py <输入文件> <输出 JSON>\n")
        return 2
    input_path, output_path = argv[1], argv[2]
    file_name = os.path.basename(input_path)
    # 页面图像的落点由**结果文件**决定：与它同级、名称为 `<结果名>-页面图片/`。
    # 这样"产物在哪"只由调用方给的输出路径决定，脚本不猜案例目录。
    page_image_dir = os.path.join(
        os.path.dirname(os.path.abspath(output_path)),
        os.path.splitext(os.path.basename(output_path))[0] + PAGE_IMAGE_DIR_SUFFIX,
    )
    try:
        result = run(input_path, file_name, page_image_dir)
    except Exception:  # noqa: BLE001 - 任何未预期的异常都收敛成"读不出来"，不抛给调用方
        result = empty_result(file_name, kind_of(file_name))
        result["error"] = "提取脚本内部错误：" + traceback.format_exc(limit=3).strip().splitlines()[-1]
    try:
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
    except OSError as error:
        sys.stderr.write(f"写不出结果文件：{error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
