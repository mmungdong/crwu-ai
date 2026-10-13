#!/usr/bin/env python3
"""Check a valuation workbook against the workbook contract.

Contract owner: references/06-workbook-contract.md. Exit code 0 = pass,
1 = contract violation. Usage:

    python3 scripts/check_workbook_contract.py [path/to/workbook.xlsx]
"""

from __future__ import annotations

import os
import re
import sys
import zipfile

from openpyxl import load_workbook

REQUIRED_SHEETS = ["基础信息表", "案例", "价值内涵与税费", "市场法", "收益法", "成本法", "估值结果汇总"]

# 汇总表必须留出的三行（§8「计算表填写」点名要有，而前面各表放不下）：
# 权重/汇总依据（最终单价怎么来的）、已知限制、待确认事项（与结果 JSON 一致）。
# 为什么进契约而不是"记得填"：这三行**存在**才谈得上填；删掉它们等于
# "这份底稿到什么程度为止"和"最终单价怎么汇总的"都没地方写。
REQUIRED_SUMMARY_ROWS = ["权重 / 汇总依据", "已知限制", "待确认事项"]
ERROR_TOKENS = ("#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#N/A", "#NULL!", "#NUM!")
EXTERNAL_REF = re.compile(r"\[\d+\]")
FACTOR_INDEX_SHEET = "市场法"
SUMMARY_SHEET = "估值结果汇总"
# 「采用的方法」列的合法取值（与 `估值结果.json` 的结论方法一致）。
CONCLUSION_METHODS = ("市场法", "收益法", "成本法")
# 汇总表的列：F 建筑面积 / J 采用的方法 / K 采用单价。
SUMMARY_AREA_COL = 6
SUMMARY_METHOD_COL = 10

# 关键公式链：每条给出「必须出现的形态」与「说明」。用正则容忍单元格行号变化。
REQUIRED_FORMULAS = {
    "价值内涵与税费": [
        (r"SUM\(B\d+:B\d+\)", "卖方应负担税费合计必须由税费行求和得出"),
        (r"/\$B\$\d+,-1\)", "单价必须由总价 ÷ 建筑面积取整得出"),
    ],
    "市场法": [
        (r"=ROUND\(PRODUCT\(\$?I\$\d+:\$?I\$\d+\)/PRODUCT\([A-E]\$\d+:[A-E]\$\d+\),4\)", "修正系数积"),
        (r"=ROUND\([A-E]\$\d+\*[A-E]\$\d+,-1\)", "比准价格 = 交易单价 × 修正系数积"),
        (r"=ROUND\(AVERAGE\([A-E]\d+:[A-E]\d+\),-1\)", "评估单价 = 各比准价格算术平均"),
        (r"=ROUND\([A-E]\d+\*[A-E]\d+,-2\)", "评估值 = 评估单价 × 建筑面积"),
        (r"MAX\([A-E]\d+:[A-E]\d+\)/MIN\([A-E]\d+:[A-E]\d+\)>1\.2", "比价合理区间检查（1.2）"),
    ],
    "收益法": [
        (r"=ROUND\([A-E]\d+\*365,2\)", "潜在毛收入 = 日租金 × 365"),
        (r"有效毛收入|=[A-Z]+\d+-[A-Z]+\d+\+[A-Z]+\d+", "有效毛收入 = 潜在 − 空置 + 其他"),
        (r"=ROUND\([A-Z]+\d+\(?-?\$?[A-Z]?\$?\d*", "运营费用必须由公式汇总得出"),
        (r"/\([A-E]\d+-[A-E]\d+\)\*\(1-\(\(1\+[A-E]\d+\)/\(1\+[A-E]\d+\)\)\^[A-E]\d+\)", "等比递增年金公式"),
    ],
    "成本法": [
        (r"=ROUND\(C\d+/C\d+,4\)", "成新率 = 尚可使用年限 / 经济耐用年限"),
        (r"=ROUND\(C\d+\*C\d+,-1\)", "建筑物评估单价 = 重置成本单价 × 成新率"),
        (r"=ROUND\(C\d+\+C\d+,-1\)", "积算单价 = 建筑物评估单价 + 土地单价"),
        (r"=ROUND\(C\d+\*\$B\$4,-2\)", "评估值 = 积算单价 × 建筑面积"),
    ],
    "估值结果汇总": [
        (r"=SUM\([A-O]\d+:[A-O]\d+\)", "合计行必须为 SUM 公式"),
        # 评估价值列可能带 IF 空行守卫（=IF(J5="","",ROUND(J5*F5,0))），采用单价 J / 建筑面积 F 已超出 A-E，
        # 故不锚定 `=ROUND` 前缀、列号放开到 A-Z。
        (r"ROUND\([A-Z]\d+\*[A-Z]\d+,0\)", "评估价值 = 采用单价 × 建筑面积"),
    ],
}


def fail(message: str) -> None:
    print(f"FAIL: {message}")


def check_parts(path: str) -> list[str]:
    problems: list[str] = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if any(name.startswith("xl/externalLinks/") for name in names):
            problems.append("存在外部链接（xl/externalLinks/）：模板不得引用其他工作簿")
        workbook_xml = archive.read("xl/workbook.xml").decode("utf-8")
        # openpyxl 总会写一个空的 `<definedNames/>` 容器；只有 `<definedName name=…>` 才是真实的
        # 具名区域。按开标签匹配，避免把空容器当成"存在具名区域"。
        if re.search(r"<definedName\b", workbook_xml):
            # 具名区域不是缺陷，但打印出来便于人工核对是否有指向外部的名称
            print("INFO: 工作簿包含 definedName，请人工确认未指向外部工作簿")
    return problems


def check_sheets(wb) -> list[str]:
    problems: list[str] = []
    names = wb.sheetnames
    for name in REQUIRED_SHEETS:
        if name not in names:
            problems.append(f"缺少必需表：{name}")
    for name in names:
        state = wb[name].sheet_state
        if state != "visible":
            problems.append(f"表「{name}」状态为 {state}：契约要求 7 张可见表，不含隐藏表")
    if len(names) != len(REQUIRED_SHEETS):
        problems.append(f"表数量为 {len(names)}，契约为 {len(REQUIRED_SHEETS)} 张：{names}")
    if names != REQUIRED_SHEETS:
        problems.append(f"表顺序与契约不一致：{names}")
    return problems


def check_cells(wb) -> list[str]:
    problems: list[str] = []
    for name in REQUIRED_SHEETS:
        if name not in wb.sheetnames:
            continue
        ws = wb[name]
        for row in ws.iter_rows():
            for cell in row:
                value = cell.value
                if not isinstance(value, str):
                    continue
                if not value.startswith("="):
                    continue
                for token in ERROR_TOKENS:
                    if token in value:
                        problems.append(f"{name}!{cell.coordinate} 含错误值 {token}")
                if EXTERNAL_REF.search(value):
                    problems.append(f"{name}!{cell.coordinate} 引用外部工作簿：{value}")
                if "!#REF" in value.upper():
                    problems.append(f"{name}!{cell.coordinate} 存在历史断链：{value}")
    return problems


def check_summary_rows(wb) -> list[str]:
    problems: list[str] = []
    name = "估值结果汇总"
    if name not in wb.sheetnames:
        return problems
    ws = wb[name]
    labels = {str(row[0].value).strip() for row in ws.iter_rows(min_col=1, max_col=1)
              if isinstance(row[0].value, str)}
    for label in REQUIRED_SUMMARY_ROWS:
        if label not in labels:
            problems.append(f"{name} 缺少「{label}」行：§8 要求底稿带上汇总依据与已知限制/待确认事项")
    return problems


def check_formulas(wb) -> list[str]:
    problems: list[str] = []
    for name, patterns in REQUIRED_FORMULAS.items():
        if name not in wb.sheetnames:
            continue
        ws = wb[name]
        formulas = [
            str(cell.value)
            for row in ws.iter_rows()
            for cell in row
            if isinstance(cell.value, str) and cell.value.startswith("=")
        ]
        for pattern, label in patterns:
            if not any(re.search(pattern, formula) for formula in formulas):
                problems.append(f"{name} 缺少关键公式（{label}）：正则 {pattern}")
    return problems


def check_conclusion_method(wb) -> list[str]:
    """汇总表：**填了建筑面积的行必须写明采用的方法**，且只能写三个方法名之一。

    为什么必须查（这不是格式洁癖）：`K` 列的公式是

        =IF(ISNUMBER(SEARCH("收益法",J5)),G5, IF(ISNUMBER(SEARCH("市场法",J5)),H5,
            IF(ISNUMBER(SEARCH("成本法",J5)),I5,"")))

    `J` 为空或写成"市场"这类非逐字名称时，三个 `SEARCH` 全部报错 → `K` **一声不响地回空串**
    → `L`（评估价值）也空。于是：汇总表没有结论，而报告与结果 JSON 里可能写着数字 ——
    两边不一致，却没有任何一处报错。这正是契约该挡的那类失败。
    """
    problems: list[str] = []
    if SUMMARY_SHEET not in wb.sheetnames:
        return ["缺少估值结果汇总表"]
    ws = wb[SUMMARY_SHEET]
    for row in range(5, ws.max_row + 1):
        index = ws.cell(row=row, column=1).value
        area = ws.cell(row=row, column=SUMMARY_AREA_COL).value
        method = ws.cell(row=row, column=SUMMARY_METHOD_COL).value
        if area is None or str(area).strip() == "":
            continue
        # **合计行不是数据行**：它的面积是 `=SUM(F5:F14)`（公式，不是填进去的建筑面积）。
        # 第一版忘了排掉它，于是随包发布的模板自己被判不合格 —— 这条用例也是这么来的。
        if isinstance(area, str) and area.startswith("="):
            continue
        if str(index).strip() in ("", "合计"):
            continue
        text = "" if method is None else str(method).strip()
        if text == "":
            problems.append(
                f"{SUMMARY_SHEET}!J{row} 没写「采用的方法」，但这一行填了建筑面积："
                "K 列的公式会在 J 为空时静默回空串（汇总没有结论，报告里却可能有数字）")
            continue
        if text not in CONCLUSION_METHODS:
            problems.append(
                f"{SUMMARY_SHEET}!J{row} 的「采用的方法」是 {text!r}："
                f"必须逐字写成 {' / '.join(CONCLUSION_METHODS)} 之一（K 列用 SEARCH 匹配这三个词）")
    return problems


def check_income_chain(wb) -> list[str]:
    """收益法：日租金 → 潜在毛收入 → 有效毛收入 → 净收益 → 收益价值 必须成链。"""
    problems: list[str] = []
    if "收益法" not in wb.sheetnames:
        return ["缺少收益法表"]
    ws = wb["收益法"]
    rows = {}
    for row in ws.iter_rows(min_col=1, max_col=2):
        no = row[0].value
        if isinstance(no, str) and re.fullmatch(r"\d+(\.\d+)*", no):
            rows[no] = row[0].row
    for required in ("1.0", "1", "1.1", "1.2", "1.3", "2", "3", "7", "9"):
        if required not in rows:
            problems.append(f"收益法缺序号 {required}")
    if "1.0" in rows and "1.1" in rows:
        daily, potential = rows["1.0"], rows["1.1"]
        if f"C{daily}" not in str(ws.cell(row=potential, column=3).value or ""):
            problems.append(f"潜在毛收入（第{potential}行）未引用日租金（C{daily}）")
    if "3" in rows and "7" in rows and "9" in rows:
        net, value, total = rows["3"], rows["7"], rows["9"]
        if f"C{net}" not in str(ws.cell(row=value, column=3).value or ""):
            problems.append(f"收益价值（第{value}行）未引用净收益（C{net}）")
        if f"C{value}" not in str(ws.cell(row=total, column=3).value or ""):
            problems.append(f"收益价值合计（第{total}行）未引用单价（C{value}）")
    return problems


def main() -> int:
    if len(sys.argv) > 1:
        path = sys.argv[1]
    else:
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "template", "valuation-workbook.xlsx",
        )
    if not os.path.isfile(path):
        fail(f"找不到工作簿：{path}")
        return 1
    problems = check_parts(path)
    wb = load_workbook(path)
    problems += check_sheets(wb)
    problems += check_cells(wb)
    problems += check_formulas(wb)
    problems += check_income_chain(wb)
    problems += check_conclusion_method(wb)
    problems += check_summary_rows(wb)
    if problems:
        for problem in problems:
            fail(problem)
        print(f"\n{len(problems)} 处契约不符：{path}")
        return 1
    print(f"OK: {path} 符合 references/06 计算表契约（{len(REQUIRED_SHEETS)} 张可见表，无外部链接、无断链）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
