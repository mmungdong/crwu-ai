#!/usr/bin/env python3
"""多类型估值资料的提取脚本（报告评估）。

契约（Host 的 `crwu_valuation_file_extract` 按它解析）：

    python3 extract_files.py <输入文件绝对路径> <输出 JSON 绝对路径>

**永远写出一个合法 JSON**，形状固定：

    { "ok": bool, "error": str, "fileName": str, "fileType": str,
      "text": str, "tables": [{"name": str, "rows": [[str, ...], ...]}],
      "images": [{"path": str, "description": str}],
      "extractedFields": {str: str}, "warnings": [str], "capabilityGaps": [str] }

三条硬口径（都是"宁可说读不出来，也不许编"）：

1. **缺库就说缺库**。这台运行时装了 python-docx / openpyxl / Pillow，但**没有** PDF 文本库；
   于是 .pdf 只能如实进 `capabilityGaps`，绝不自己解析内容流去猜字形 ——
   猜错一个字号或编码，坐落与面积就跟着错，而那会一路进计算。
2. **旧版二进制 Office（.doc / .xls）同样报缺口**：没有 antiword / xlrd 就直说。
3. **字段只做"标签锚定"提取**：只有在正文里真的出现 `坐落：…` 这种带标签的行时才记录，
   不做任何推断（不认识就不出现，缺失由上层表达）。`extractedFields` 里的值一律是**原文**。

扫描件（图片 / 无文本层 PDF）进入"待识别"状态：记 `capabilityGaps`，不编造字段。
"""

from __future__ import annotations

import json
import os
import re
import sys
import traceback

# 单份文件的正文上限：再多也不会全进模型上下文，而超长正文会让 JSON 变得难传输。
TEXT_MAX = 200_000
# 单张表的行/列上限：估值只关心前若干行（明细表往往几千行）。
TABLE_MAX_ROWS = 500
TABLE_MAX_COLS = 64
# 单个字段值的长带上限（超过基本是抓错了行）。
FIELD_MAX = 200

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


def empty_result(file_name: str, file_type: str) -> dict:
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
    }


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
    result["capabilityGaps"].append("图片内容未识别（本机没有可用的 OCR）：请人工核对图片中的坐落、面积与权属信息")


def extract_pdf(path: str, result: dict) -> None:
    """PDF：只走**真实存在的文本层库**；没有就如实报缺口。

    刻意不自己解析 PDF 内容流：字形编码（CID / ToUnicode CMap）读错会产出**看起来像正文的
    乱码**，而乱码会被下游的标签提取当成坐落与面积 —— 那比"读不出来"危险得多。
    """
    reader = None
    for module_name in ("pypdf", "PyPDF2", "pdfminer.high_level"):
        try:
            if module_name == "pdfminer.high_level":
                from pdfminer.high_level import extract_text  # type: ignore
                result["text"] = clamp(extract_text(path) or "", TEXT_MAX)
                reader = module_name
            else:
                module = __import__(module_name)
                pages = module.PdfReader(path).pages
                chunks = []
                for page in pages[:200]:
                    chunks.append(clamp(page.extract_text() or "", TEXT_MAX))
                result["text"] = clamp("\n".join(chunks), TEXT_MAX)
                reader = module_name
            break
        except ImportError:
            continue
        except Exception as error:  # noqa: BLE001 - 读失败就是这一份读不出来
            result["capabilityGaps"].append(f"PDF 文本层读取失败：{error}")
            return
    if reader is None:
        result["capabilityGaps"].append(
            "本机 Python 没有可用的 PDF 文本读取库（pypdf / PyPDF2 / pdfminer 都没有）："
            "这一份 PDF 未解析。请人工提供关键页的文字，或换用 Word / Excel 资料。"
        )
        return
    if result["text"].strip() == "":
        result["capabilityGaps"].append("PDF 无文本层，需要 OCR")


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


def run(input_path: str, file_name: str) -> dict:
    kind = kind_of(file_name)
    result = empty_result(file_name, kind)

    if not os.path.isfile(input_path):
        result["error"] = f"输入文件不存在：{file_name}"
        return result
    if os.path.getsize(input_path) == 0:
        result["error"] = "输入文件是空文件（0 字节）"
        return result

    if kind == "pdf":
        extract_pdf(input_path, result)
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
    if not result["ok"] and result["error"] == "" and not result["capabilityGaps"]:
        result["capabilityGaps"].append("没有读到任何正文、表格或图片信息")
    return result


def main(argv: list) -> int:
    if len(argv) < 3:
        sys.stderr.write("用法：extract_files.py <输入文件> <输出 JSON>\n")
        return 2
    input_path, output_path = argv[1], argv[2]
    file_name = os.path.basename(input_path)
    try:
        result = run(input_path, file_name)
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
