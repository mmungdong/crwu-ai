#!/usr/bin/env python3
"""把估值数据填进**计算底稿**（从模板复制而来）。

    python3 scripts/build_workbook.py --values 填入值.json --out <案例目录>/估值底稿.xlsx [--template …] [--force]

`填入值.json`：

    { "cells": { "基础信息表!B5": "某公司", "案例!B6": "某小区 1-2-301" } }

## 三条不许违反的规则

1. **只填输入区**。模板自己用**填充色**声明区域（浅绿 = 输入区，浅黄 = 公式区；
   见 `references/06` 第 2 节与工作簿第二行的图例）。写到公式区 → 拒绝；
   写到没被声明为输入区的单元格 → 拒绝。这条是"公式区不被覆盖"的**可执行**版本：
   靠"记得别覆盖"是记不住的。
2. **输入区不许写公式**。以 `=` 开头的值一律拒绝 —— 输入区是人工数据，
   在输入区写公式就是把结论硬编码进输入，正是要防的那件事。
3. **空就是空**。缺值写**空单元格**，不写 0：0 是一个结论（"值零"），
   而"没填"是另一件事，混同会误导复核。

写完还会核对：没有隐藏表、没有跨工作簿链接、没有 `#REF!`/`#VALUE!`/`#DIV/0!`。
**重算由 Excel/LibreOffice 负责**：本脚本不动公式、不动缓存值，所以它写出的底稿必须
被真正打开重算一次才算数（`references/09` 的口径）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys

from openpyxl import load_workbook
from openpyxl.utils import range_boundaries

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
DEFAULT_TEMPLATE = os.path.join(SKILL, "template", "valuation-workbook.xlsx")

# 模板的图例：浅绿 = 输入区，浅黄 = 公式区（references/06 第 2 节）。
INPUT_FILL = "00E2EFDA"
FORMULA_FILL = "00FFF2CC"
ERROR_TOKENS = ("#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#N/A", "#NULL!", "#NUM!")
EXTERNAL_REF = re.compile(r"\[\d+\]")


def norm_fill(cell) -> str:
    fill = cell.fill
    if fill is None or fill.fill_type is None:
        return ""
    value = fill.start_color
    # 主题色 / 索引色也会出现在这里：只有显式 ARGB 才能与图例比对。
    return str(getattr(value, "rgb", "") or "")


def is_input_cell(cell) -> bool:
    return norm_fill(cell) == INPUT_FILL


def is_formula_cell(cell) -> bool:
    if norm_fill(cell) == FORMULA_FILL:
        return True
    value = cell.value
    return isinstance(value, str) and value.startswith("=")


def parse_ref(reference: str, sheet_names: list[str]) -> tuple[str, str]:
    """把 `表名!B5` 拆成 (表名, 坐标)；也接受 `表名!B5:C6`（取左上角并拒绝多格）。"""
    if "!" not in reference:
        raise ValueError(f"要写成 「表名!单元格」，例如 基础信息表!B5：{reference}")
    sheet, coord = reference.split("!", 1)
    if sheet not in sheet_names:
        raise ValueError(f"没有这张表：{sheet}（现有：{'、'.join(sheet_names)}）")
    if ":" in coord:
        raise ValueError(f"一次只能填一个单元格（不支持区域）：{reference}")
    return sheet, coord.strip().upper()


def template_digest(path: str) -> str:
    """模板指纹（sha256 前 16 位）：底稿要能追溯到"用的是哪一份模板"。"""
    import hashlib
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()[:16]
    except OSError:
        return ""


def check_template_contract(path: str) -> list[str]:
    """拿工作簿契约验**模板本身**（认不出来就返回一条"无法核对"，不当成通过）。"""
    import importlib.util
    checker = os.path.join(HERE, "check_workbook_contract.py")
    if not os.path.isfile(checker):
        return ["找不到 check_workbook_contract.py：无法核对模板是否符合契约"]
    spec = importlib.util.spec_from_file_location("crwu_workbook_contract", checker)
    if spec is None or spec.loader is None:
        return ["check_workbook_contract.py 加载失败：无法核对模板"]
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        workbook = module.load_workbook(path, data_only=False)
    except Exception as error:  # noqa: BLE001 - 打不开/不是工作簿就是不合格
        return [f"模板打不开或不是工作簿：{error}"]
    try:
        problems = module.check_sheets(workbook)
        problems += module.check_cells(workbook)
        problems += module.check_formulas(workbook)
        problems += module.check_income_chain(workbook)
        problems += module.check_conclusion_method(workbook)
        problems += module.check_summary_rows(workbook)
    finally:
        workbook.close()
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="把估值数据填进计算底稿")
    parser.add_argument("--values", required=True, help="填入值.json（{\"cells\": {...}}）")
    parser.add_argument("--out", required=True, help="目标底稿路径（必须落在估值案例目录内）")
    parser.add_argument("--template", default=DEFAULT_TEMPLATE, help="模板路径（只读）")
    parser.add_argument("--force", action="store_true", help="目标已存在时覆盖（默认拒绝）")
    args = parser.parse_args()

    if not os.path.isfile(args.template):
        print(f"FAIL 找不到模板：{args.template}")
        return 1
    # **模板必须过工作簿契约**（§7.1：用用户实际模板，但不能是"外观类似、结构不同"的替代品）。
    # 只在产物生成后检查不够：那时已经填了一轮值，而结构不对的模板会让整轮填报白做。
    # 这里在动手之前先验一遍模板本身 —— 拿知识库/用户模板时最常见的问题就是表名或公式链不同。
    contract = check_template_contract(args.template)
    if contract:
        for message in contract:
            print(f"FAIL 模板不符合工作簿契约：{message}")
        print(f"\n{len(contract)} 处模板问题：底稿未生成。"
              "请使用知识库里的标准计算表模板（表名、表序与公式链见 references/06），不要自行造一个外观类似的表。")
        return 1
    if not os.path.isfile(args.values):
        print(f"FAIL 找不到填入值文件：{args.values}")
        return 1
    # 绝不允许把产物写回技能模板目录：那是"生成件覆盖母版"的经典事故。
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
        print("FAIL 填入值里没有 cells（形如 {\"cells\": {\"基础信息表!B5\": \"…\"}}）")
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    shutil.copyfile(args.template, args.out)
    workbook = load_workbook(args.out)
    sheet_names = list(workbook.sheetnames)

    problems: list[str] = []
    filled: list[str] = []
    # **置空**的单元格单独记：`None` 是合法输入（"这一项未知"），但它并没有"填入"任何值。
    # 混在一起数会把"2 个输入单元格"说成已经填了 2 项 —— 而复核的人正是照着这句话判断
    # "该填的都填了"。计数也是一种断言。
    blanked: list[str] = []
    for reference, value in sorted(cells.items()):
        try:
            sheet, coord = parse_ref(str(reference), sheet_names)
        except ValueError as error:
            problems.append(str(error))
            continue
        worksheet = workbook[sheet]
        target = worksheet[coord]
        if is_formula_cell(target):
            problems.append(
                f"{sheet}!{coord} 是**公式区**（模板公式：{str(target.value)[:40]}）："
                "公式区禁止用数值覆盖")
            continue
        if not is_input_cell(target):
            problems.append(
                f"{sheet}!{coord} 不在**输入区**（模板用填充色声明区域，浅绿才是输入区）："
                "要填这里请先确认模板的区域声明，或改填正确的输入单元格")
            continue
        if isinstance(value, str) and value.startswith("="):
            problems.append(f"{sheet}!{coord} 的值以 = 开头：输入区不许写公式（那是把结论硬编码进输入）")
            continue
        # 空 / None 一律写空单元格：**不写 0**（0 是结论，未填是另一件事）。
        if value is None or (isinstance(value, str) and value.strip() == ""):
            target.value = None
            blanked.append(f"{sheet}!{coord}")
            continue
        elif isinstance(value, bool):
            problems.append(f"{sheet}!{coord} 的值是布尔：模板用文本或数值表达")
            continue
        else:
            target.value = value
        filled.append(f"{sheet}!{coord}")

    if problems:
        workbook.close()
        # 一个都没写成功时删掉半成品；部分成功也删 —— 半填的底稿比没有更危险
        #（看上去有数据，实际口径不完整，而公式会算出看起来正常的数）。
        try:
            os.remove(args.out)
        except OSError:
            pass
        for message in problems:
            print(f"FAIL {message}")
        print(f"\n{len(problems)} 处不符合工作簿契约：底稿未生成（半填的底稿比没有更危险）")
        return 1

    workbook.save(args.out)

    # 后置条件：保存后再读一遍，核对结构与错误值。
    verify = load_workbook(args.out, data_only=False)
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

    blank_note = f" / {len(blanked)} 处按未填置空" if blanked else ""
    print(f"OK: 已生成 {args.out}（{sheet_count} 张表 / 填入 {len(filled)} 个输入单元格{blank_note}）")
    # **用的是哪一份模板**要写出来：用户模板与随包模板长得很像，事后要靠指纹分辨（§7.1）。
    default = os.path.abspath(args.template) == os.path.abspath(DEFAULT_TEMPLATE)
    print(f"模板：{args.template}（{'随包模板' if default else '用户/知识库模板'} "
          f"sha256:{template_digest(args.template)}）")
    print("提醒：公式重算由 Excel 或 LibreOffice 负责，交付前请打开重算一次再核对勾稽。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
