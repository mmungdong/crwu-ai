#!/usr/bin/env python3
"""把估值数据填进**计算底稿**（从模板复制而来）。

    python3 scripts/build_workbook.py --values 填入值.json --out <案例目录>/估值底稿.xlsx \
        --template <模板.xlsx> [--contract <描述.json>] [--force]

`填入值.json`：

    { "cells": { "输入!B5": "某公司", "输入!B6": 120.5 } }

## 规则

1. **模板与契约都是显式的**：没有随包默认模板，也没有内置七表 profile。`--template` 必填；
   契约取 `--contract`，或模板旁边同名 `<模板>.contract.json`。两样都缺 → 拒绝，不产出。
2. **只填契约声明的输入区**。写结果位、公式位或未声明的格子 → 拒绝；输入区写公式 → 拒绝。
3. **生成前清空全部声明的输入位**，未提供的模板样例值不许泄漏进产物。
4. **空就是空**：缺值写空单元格，不写 0。
5. 源模板只读：字节与公式一个都不动；产物旁边写自己的 sidecar，仅记录来源模板指纹。

写完还会核对：没有隐藏表、没有跨工作簿链接、没有 `#REF!`/`#VALUE!`/`#DIV/0!`。
**重算由 Excel/LibreOffice 负责**：本脚本不动公式、不动缓存值。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil

from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter

import evidence_index

HERE = os.path.dirname(os.path.abspath(__file__))
ERROR_TOKENS = ("#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#N/A", "#NULL!", "#NUM!")
EXTERNAL_REF = re.compile(r"\[\d+\]")


def _load_checker():
    checker = os.path.join(HERE, "check_workbook_contract.py")
    if not os.path.isfile(checker):
        return None, "找不到 check_workbook_contract.py：无法按契约核对输入区"
    spec = importlib.util.spec_from_file_location("crwu_workbook_contract", checker)
    if spec is None or spec.loader is None:
        return None, "check_workbook_contract.py 加载失败"
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001
        return None, f"check_workbook_contract.py 加载失败：{error}"
    return module, ""


def template_digest(path: str) -> str:
    """模板指纹（sha256）：底稿要能追溯到"用的是哪一份模板"。"""
    import hashlib

    try:
        with open(path, "rb") as handle:
            return "sha256:" + hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return ""


def parse_ref(reference: str, sheet_names: list[str]) -> tuple[str, str]:
    """把 `表名!B5` 拆成 (表名, 坐标)；也接受 `表名!B5:C6`（取左上角并拒绝多格）。"""
    if "!" not in reference:
        raise ValueError(f"要写成 「表名!单元格」，例如 输入!B5：{reference}")
    sheet, coord = reference.split("!", 1)
    if sheet not in sheet_names:
        raise ValueError(f"没有这张表：{sheet}（现有：{'、'.join(sheet_names)}）")
    if ":" in coord:
        raise ValueError(f"一次只能填一个单元格（不支持区域）：{reference}")
    return sheet, coord.strip().upper()


def _declared_pairs(module, wb, contract: dict, key: str, role_sheets: list[str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for item in contract.get(key) or []:
        sheet, coord = module.split_ref(str(item))
        if sheet == "":
            if len(role_sheets) != 1:
                raise ValueError(f"契约里的 {key} 条目 {item!r} 没有表名前缀，且输入/公式表不止一张")
            sheet = role_sheets[0]
        if sheet not in wb.sheetnames:
            raise ValueError(f"契约里的 {key} 指向不存在的表：{sheet}!{coord}")
        pairs.append((sheet, coord.upper()))
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser(description="把估值数据填进计算底稿（显式模板 + 契约）")
    parser.add_argument("--values", required=True, help="填入值.json（{\"cells\": {...}}）")
    parser.add_argument("--out", required=True, help="目标底稿路径")
    parser.add_argument("--template", required=True, help="模板路径（只读；没有随包默认）")
    parser.add_argument("--force", action="store_true", help="目标已存在时覆盖（默认拒绝）")
    parser.add_argument("--contract", default="",
                        help="模板契约描述；缺省时自动发现 <模板>.contract.json")
    parser.add_argument("--case-root", default="",
                        help="caseEvidence 相对路径的基准目录；缺省=输出文件所在目录")
    args = parser.parse_args()

    if not os.path.isfile(args.template):
        print(f"FAIL 找不到模板：{args.template}")
        return 1
    descriptor = args.contract or (
        args.template + ".contract.json" if os.path.isfile(args.template + ".contract.json") else "")
    if descriptor == "":
        print("FAIL 没有模板契约描述（--contract 或 <模板>.contract.json）：通用填表不猜输入区")
        return 1
    module, load_error = _load_checker()
    if module is None:
        print(f"FAIL {load_error}")
        return 1
    contract, contract_problems = module.load_contract(descriptor)
    if contract is None:
        for message in contract_problems:
            print(f"FAIL {message}")
        print("底稿未生成：模板契约读不出来时**不猜**输入区。")
        return 1

    # **模板必须过它自己的契约**：源模板的字节指纹在这里对来源核对，不是对填充后的产物。
    source_digest = template_digest(args.template)
    template_problems = module.check_parts(args.template) + module.check_generic(args.template, contract)
    if template_problems:
        for message in template_problems:
            print(f"FAIL 模板不符合工作簿契约：{message}")
        print(f"\n{len(template_problems)} 处模板问题：底稿未生成。请核对模板是否符合它自己的填写说明。")
        return 1

    if not os.path.isfile(args.values):
        print(f"FAIL 找不到填入值文件：{args.values}")
        return 1
    if os.path.abspath(args.out) == os.path.abspath(args.template):
        print("FAIL 目标路径就是模板本身：产物必须写进估值案例目录，模板只读")
        return 1
    if os.path.exists(args.out) and not args.force:
        print(f"FAIL 目标已存在：{args.out}（要覆盖请加 --force；覆盖前请确认上一版已核对）")
        return 1

    try:
        with open(args.values, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL 填入值不是合法 JSON：{error}")
        return 1
    cells = payload.get("cells") if isinstance(payload, dict) else None
    if not isinstance(cells, dict) or not cells:
        print("FAIL 填入值里没有 cells（形如 {\"cells\": {\"输入!B5\": \"…\"}}）")
        return 1

    case_root = args.case_root or os.path.dirname(os.path.abspath(args.out))
    try:
        evidence_rows = evidence_index.normalise_entries(payload.get("caseEvidence"), case_root)
    except evidence_index.EvidenceError as error:
        print(f"FAIL caseEvidence 不可追溯：{error}")
        print("底稿未生成：证据索引无法核对时**不许**假装成功。")
        return 1

    # 输入/公式/结果区域由模板自己的填写说明声明，声明缺失一律拒绝。
    input_sheets = [str(item["name"]).strip() for item in contract["sheets"]
                    if (str(item.get("role", "formula")).strip() or "formula") == "input"]
    template_wb = module.load_workbook(args.template, data_only=False)
    try:
        declared_inputs = _declared_pairs(module, template_wb, contract, "inputCells", input_sheets)
        declared_results = _declared_pairs(module, template_wb, contract, "resultCells", input_sheets)
    except ValueError as error:
        template_wb.close()
        print(f"FAIL {error}")
        return 1
    template_wb.close()
    if not declared_inputs:
        print(f"FAIL 模板契约没有声明 inputCells（{descriptor}）：无法判断哪些格子可以填。")
        return 1
    conflict = set(declared_inputs) & set(declared_results)
    if conflict:
        where = "、".join(f"{sheet}!{coord}" for sheet, coord in sorted(conflict))
        print(f"FAIL 模板契约把同一批格子同时声明成输入位与结果位：{where}（声明自相矛盾）")
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    shutil.copyfile(args.template, args.out)
    workbook = module.load_workbook(args.out)
    sheet_names = list(workbook.sheetnames)

    problems: list[str] = []
    filled: list[str] = []
    blanked: list[str] = []

    def protected(sheet: str, coord: str) -> bool:
        if (sheet, coord) in declared_results:
            return True
        value = workbook[sheet][coord].value
        return isinstance(value, str) and value.startswith("=")

    # **清空全部声明的输入位**：模板里的业务样例值不能随产物泄漏。
    for sheet, coord in declared_inputs:
        target = workbook[sheet][coord]
        if protected(sheet, coord):
            problems.append(
                f"{sheet}!{coord} 是**公式区 / 结果位**（模板公式：{str(target.value)[:40]}）："
                "输入位不许同时是公式 / 结果位")
            continue
        target.value = None

    for reference, value in sorted(cells.items()):
        try:
            sheet, coord = parse_ref(str(reference), sheet_names)
        except ValueError as error:
            problems.append(str(error))
            continue
        if (sheet, coord) not in declared_inputs:
            problems.append(f"{sheet}!{coord} 不在**输入区**（模板契约声明的 inputCells 里没有它）")
            continue
        if protected(sheet, coord):
            problems.append(
                f"{sheet}!{coord} 是**公式区 / 结果位**：公式区禁止用数值覆盖")
            continue
        if isinstance(value, str) and value.startswith("="):
            problems.append(f"{sheet}!{coord} 的值以 = 开头：输入区不许写公式（那是把结论硬编码进输入）")
            continue
        if isinstance(value, bool):
            problems.append(f"{sheet}!{coord} 的值是布尔：模板用文本或数值表达")
            continue
        if value is None or (isinstance(value, str) and value.strip() == ""):
            workbook[sheet][coord].value = None
            blanked.append(f"{sheet}!{coord}")
            continue
        workbook[sheet][coord].value = value
        filled.append(f"{sheet}!{coord}")

    if problems:
        workbook.close()
        try:
            os.remove(args.out)
        except OSError:
            pass
        for message in problems:
            print(f"FAIL {message}")
        print(f"\n{len(problems)} 处不符合工作簿契约：底稿未生成（半填的底稿比没有更危险）")
        return 1

    if evidence_rows:
        sheet = workbook.create_sheet(evidence_index.EVIDENCE_SHEET)
        sheet.append(list(evidence_index.SHEET_COLUMNS))
        for column, width in enumerate([18, 24, 12, 48, 40, 34, 24, 16], start=1):
            sheet.column_dimensions[get_column_letter(column)].width = width
        for entry in evidence_rows:
            sheet.append([
                entry["caseId"], entry["displayName"], entry["provider"], entry["sourceUrl"],
                entry["relativePath"], entry["digest"], entry["capturedAt"], entry["evidenceType"],
            ])
            line = sheet.max_row
            # Metadata is literal text even when it begins with '='; never a formula.
            for column in range(1, len(evidence_index.SHEET_COLUMNS) + 1):
                cell = sheet.cell(row=line, column=column)
                cell.data_type = "s"
                cell.alignment = Alignment(wrap_text=True, vertical="top")
            sheet.cell(row=line, column=4).hyperlink = entry["sourceUrl"]
            sheet.cell(row=line, column=5).hyperlink = evidence_index.hyperlink_target(
                args.out, case_root, entry["relativePath"])
        sheet.freeze_panes = "A2"

    workbook.save(args.out)
    workbook.close()

    # 后置条件：保存后再读一遍，核对结构与错误值。
    verify = module.load_workbook(args.out, data_only=False)
    post: list[str] = []
    hidden = [sheet.title for sheet in verify.worksheets if sheet.sheet_state != "visible"]
    if hidden:
        post.append(f"底稿里有隐藏表：{'、'.join(hidden)}")
    broken: list[str] = []
    for worksheet in verify.worksheets:
        for row in worksheet.iter_rows(values_only=True):
            for cell in row:
                text = str(cell) if cell is not None else ""
                for marker in ERROR_TOKENS:
                    if marker in text:
                        broken.append(f"{worksheet.title}:{marker}")
                if EXTERNAL_REF.search(text):
                    broken.append(f"{worksheet.title}:跨工作簿引用")
    if broken:
        post.append(f"底稿里有错误值或外部引用：{'、'.join(sorted(set(broken))[:8])}")
    sheet_count = len(verify.sheetnames)
    verify.close()
    if post:
        for message in post:
            print(f"FAIL {message}")
        return 1

    # Recalculation changes output bytes; retain only source provenance in the sidecar.
    sidecar = dict(contract)
    sidecar.pop("templateSha256", None)
    sidecar["sourceTemplateSha256"] = source_digest
    if evidence_rows:
        sidecar["caseEvidence"] = evidence_rows
        relative_root = os.path.relpath(
            os.path.abspath(case_root), os.path.dirname(os.path.abspath(args.out)))
        if relative_root not in (".", ""):
            # Portable relative metadata only: never store an absolute developer path.
            sidecar["caseRootRelative"] = relative_root.replace(os.sep, "/")
    with open(args.out + ".contract.json", "w", encoding="utf-8") as handle:
        json.dump(sidecar, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    blank_note = f" / {len(blanked)} 处按未填置空" if blanked else ""
    print(f"OK: 已生成 {args.out}（{sheet_count} 张表 / 填入 {len(filled)} 个输入单元格{blank_note}）")
    print(f"模板：{args.template}（sha256:{source_digest.removeprefix('sha256:')[:16]}）")
    print("提醒：公式重算由 Excel 或 LibreOffice 负责，交付前请打开重算一次再核对勾稽。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
