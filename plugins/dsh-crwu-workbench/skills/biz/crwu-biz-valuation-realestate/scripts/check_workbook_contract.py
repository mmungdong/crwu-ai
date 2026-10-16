#!/usr/bin/env python3
"""Check a workbook against **its own filled-in instructions** (generic channel only).

Contract owner: the template's own descriptor —— `--contract <descriptor.json>` or the adjacent
sidecar `<workbook>.contract.json`. There is **no bundled profile fallback**: without a descriptor
the checker refuses instead of guessing sheet count, order or business formulas.

The generic check only covers genuinely generic correctness: visible sheets, no external links,
formula sheets really contain formulas, input cells are not formulas, result cells hold a formula or
value, empty-allowed cells are not 0, units agree, and the declared byte digest matches.

Exit code 0 = pass, 1 = mismatch. Usage:

    python3 scripts/check_workbook_contract.py path/to/workbook.xlsx [--contract path.json]
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import zipfile

from openpyxl import load_workbook

import evidence_index

VALID_ROLES = ("input", "formula", "result")
DEFAULT_CONTRACT_SUFFIX = ".contract.json"
ERROR_TOKENS = ("#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#N/A", "#NULL!", "#NUM!")
EXTERNAL_REF = re.compile(r"\[\d+\]")


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
        if "<definedName" in workbook_xml:
            print("INFO: 工作簿包含 definedName，请人工确认未指向外部工作簿")
    return problems


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def contract_path_for(path: str) -> str:
    """工作簿旁边的同名描述文件（`<xlsx>.contract.json`）。"""
    return path + DEFAULT_CONTRACT_SUFFIX


def load_contract(path: str) -> tuple[dict | None, list[str]]:
    problems: list[str] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except Exception as error:  # noqa: BLE001 - 描述文件读不出来就是契约不可用
        return None, [f"模板契约读不出来（{path}）：{error}"]
    if not isinstance(value, dict):
        return None, [f"模板契约必须是对象（{path}）"]
    sheets = value.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        problems.append("模板契约缺少 sheets：至少要声明一张表")
        return None, problems
    for index, item in enumerate(sheets):
        if not isinstance(item, dict) or str(item.get("name", "")).strip() == "":
            problems.append(f"模板契约 sheets[{index}] 缺少 name")
            continue
        role = str(item.get("role", "formula")).strip() or "formula"
        if role not in VALID_ROLES:
            problems.append(f"模板契约 sheets[{index}] 的 role 非法：{role!r}（只允许 {'/'.join(VALID_ROLES)}）")
    if problems:
        return None, problems
    return value, []


def split_ref(reference: str) -> tuple[str, str]:
    """`表名!B2` 或 `B2` → (表名或空串, 坐标)。"""
    raw = str(reference).strip()
    if "!" in raw:
        sheet, _, cell = raw.rpartition("!")
        return sheet.strip("'"), cell.strip()
    return "", raw


def sheet_of(wb, name: str):
    return wb[name] if name in wb.sheetnames else None


def check_generic(path: str, contract: dict) -> list[str]:
    """按模板自己的填写说明校验（不假定表数量、顺序、业务公式或阈值）。"""
    problems: list[str] = []

    digest = str(contract.get("templateSha256", "")).strip()
    if digest != "" and digest != sha256_of(path):
        problems.append(f"模板字节指纹与契约声明不一致：契约 {digest}，实际 {sha256_of(path)}")

    wb = load_workbook(path)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                value = cell.value
                if not isinstance(value, str):
                    continue
                for token in ERROR_TOKENS:
                    if token in value:
                        problems.append(f"{ws.title}!{cell.coordinate} 含错误值 {token}")
                if value.startswith("="):
                    if EXTERNAL_REF.search(value):
                        problems.append(f"{ws.title}!{cell.coordinate} 引用外部工作簿：{value}")
                    if "!#REF" in value.upper():
                        problems.append(f"{ws.title}!{cell.coordinate} 存在历史断链：{value}")
    declared = {str(item["name"]).strip(): str(item.get("role", "formula")).strip() or "formula"
                for item in contract["sheets"]}
    allow_hidden = contract.get("allowHiddenSheets") is True

    for name in wb.sheetnames:
        if wb[name].sheet_state != "visible" and not allow_hidden:
            problems.append(f"表「{name}」不是可见表（{wb[name].sheet_state}）：模板不得带隐藏表")
    for name, item in declared.items():
        if name not in wb.sheetnames:
            if item and contract["sheets"][[str(x["name"]).strip() for x in contract["sheets"]].index(name)].get("required") is not False:
                problems.append(f"缺少契约声明的表：{name}")
    if contract.get("orderMatters") is True:
        expected = [str(item["name"]).strip() for item in contract["sheets"]
                    if str(item["name"]).strip() in wb.sheetnames]
        actual = [name for name in wb.sheetnames if name in declared]
        if actual != expected:
            problems.append(f"表顺序与契约不一致（契约声明顺序有意义）：{actual} != {expected}")

    def cells(references) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        for item in references or []:
            sheet, cell = split_ref(item)
            out.append((sheet, cell))
        return out

    # ① 受控写入：输入位必须是**空的或值**，不许是公式（写公式进去就是覆盖模板的输入契约）。
    for sheet, cell in cells(contract.get("inputCells")):
        target = sheet_of(wb, sheet) if sheet else None
        if sheet and target is None:
            problems.append(f"契约里的输入位指向不存在的表：{sheet}!{cell}")
            continue
        candidates = [target] if target is not None else [wb[name] for name in declared if declared[name] == "input"] or [wb[wb.sheetnames[0]]]
        for ws in candidates:
            value = ws[cell].value
            if isinstance(value, str) and value.startswith("="):
                problems.append(f"{ws.title}!{cell} 是输入位却写着公式（{value}）：输入区只接受填进去的值")

    # ② 结果位必须是公式或数值 —— 空着就是"没有结论"，那是必须被看见的缺口。
    for sheet, cell in cells(contract.get("resultCells")):
        ws = sheet_of(wb, sheet) if sheet else None
        if ws is None:
            problems.append(f"契约里的结果位指向不存在的表：{sheet}!{cell}" if sheet else f"契约里的结果位 {cell} 没有表名前缀")
            continue
        value = ws[cell].value
        if value is None or (isinstance(value, str) and value.strip() == ""):
            problems.append(f"{ws.title}!{cell} 是结果位却是空的：结果区必须有公式或数值（缺口要能被看见）")
        elif isinstance(value, str) and not value.startswith("="):
            problems.append(f"{ws.title}!{cell} 是结果位却不是公式也不是数值：{value!r}")

    # ③ 公式区必须真的有公式：声明成 formula 却没有公式 = "模板看起来还在，其实已经退化成空壳"。
    for name, role in declared.items():
        ws = sheet_of(wb, name)
        if ws is None or role != "formula":
            continue
        has_formula = any(
            isinstance(cell.value, str) and cell.value.startswith("=")
            for row in ws.iter_rows() for cell in row
        )
        if not has_formula:
            problems.append(f"表「{name}」声明为公式区，却一个公式都没有")

    # ④ 空值不填 0：契约点名允许为空的格子里，0 不是"空"。
    for sheet, cell in cells(contract.get("emptyAllowedCells")):
        ws = sheet_of(wb, sheet) if sheet else None
        if ws is None:
            continue
        value = ws[cell].value
        if isinstance(value, (int, float)) and value == 0:
            problems.append(f"{ws.title}!{cell} 声明为允许为空，却填了 0：空值不等于 0")

    # ⑤ 单位一致：同一批单位格里写出来的单位文本必须一致（避免一处填元、一处填万元）。
    units: list[tuple[str, str]] = []
    for sheet, cell in cells(contract.get("unitCells")):
        ws = sheet_of(wb, sheet) if sheet else None
        if ws is None:
            continue
        value = ws[cell].value
        if value is None:
            continue
        units.append((f"{ws.title}!{cell}", str(value).strip()))
    distinct = {text for _, text in units if text != ""}
    if len(distinct) > 1:
        described = "；".join(f"{where}={text}" for where, text in units)
        problems.append(f"单位不一致（{described}）：同一份底稿的单位必须统一")

    wb.close()
    return problems


def resolve_case_root(path: str, sidecar: dict, case_root_arg: str) -> str:
    """Authoritative case root: explicit --case-root, else portable sidecar caseRootRelative."""
    if case_root_arg.strip() != "":
        return os.path.abspath(case_root_arg.strip())
    relative = str(sidecar.get("caseRootRelative", "")).strip().replace("\\", "/")
    if relative != "":
        if os.path.isabs(relative) or re.match(r"^[A-Za-z]:", relative):
            return ""
        return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(path)), relative))
    return os.path.dirname(os.path.abspath(path))


def load_case_evidence(path: str, sidecar: dict, case_root_arg: str) -> tuple[list[dict], str, list[str]]:
    """Validate the sidecar caseEvidence through the shared helper; returns (entries, root, problems)."""
    raw = sidecar.get("caseEvidence")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        return [], "", ["sidecar caseEvidence 必须是数组"]
    root = resolve_case_root(path, sidecar, case_root_arg)
    if root == "":
        return [], "", ["sidecar caseRootRelative 不许是绝对路径（不得把开发者本机路径写进交付件）"]
    try:
        entries = evidence_index.normalise_entries(raw, root)
    except evidence_index.EvidenceError as error:
        return [], root, [f"案例证据索引不可追溯：{error}"]
    return entries, root, []


def check_case_evidence_sheet(path: str, root: str, entries: list[dict]) -> list[str]:
    """Compare the visible 案例证据 sheet against the validated sidecar entries, cell by cell."""
    problems: list[str] = []
    workbook = load_workbook(path)
    try:
        if evidence_index.EVIDENCE_SHEET not in workbook.sheetnames:
            if entries:
                problems.append(
                    f"sidecar 声明了 caseEvidence，但工作簿里没有「{evidence_index.EVIDENCE_SHEET}」表")
            return problems
        sheet = workbook[evidence_index.EVIDENCE_SHEET]
        header = [str(sheet.cell(row=1, column=col).value or "").strip()
                  for col in range(1, len(evidence_index.SHEET_COLUMNS) + 1)]
        if header != list(evidence_index.SHEET_COLUMNS):
            problems.append(f"「{evidence_index.EVIDENCE_SHEET}」表头不符：{header}")
        rows: dict[str, int] = {}
        column_count = len(evidence_index.SHEET_COLUMNS)
        for row in range(2, sheet.max_row + 1):
            values = [str(sheet.cell(row=row, column=col).value or "").strip()
                      for col in range(1, column_count + 1)]
            case_id = values[0]
            if case_id == "":
                if any(value != "" for value in values):
                    problems.append(f"「{evidence_index.EVIDENCE_SHEET}」第 {row} 行缺少 caseId")
                continue
            if case_id in rows:
                problems.append(
                    f"「{evidence_index.EVIDENCE_SHEET}」caseId 重复：{case_id}"
                    f"（行 {rows[case_id]} 与 {row}）")
                continue
            rows[case_id] = row
        by_id = {entry["caseId"]: entry for entry in entries}
        for case_id, entry in by_id.items():
            row = rows.get(case_id)
            if row is None:
                problems.append(
                    f"sidecar 的 caseId {case_id} 在「{evidence_index.EVIDENCE_SHEET}」表里没有对应行")
                continue
            expected = [entry["caseId"], entry["displayName"], entry["provider"], entry["sourceUrl"],
                        entry["relativePath"], entry["digest"], entry["capturedAt"], entry["evidenceType"]]
            for col, want in enumerate(expected, start=1):
                cell = sheet.cell(row=row, column=col)
                if cell.data_type == "f":
                    problems.append(
                        f"「{evidence_index.EVIDENCE_SHEET}」{case_id} 第 {col} 列是公式："
                        "证据元数据必须是字面文本")
                actual = str(cell.value or "").strip()
                if actual != want:
                    problems.append(
                        f"「{evidence_index.EVIDENCE_SHEET}」{case_id} 第 {col} 列不符：{actual!r} != {want!r}")
            url_cell = sheet.cell(row=row, column=4)
            url_target = url_cell.hyperlink.target if url_cell.hyperlink is not None else None
            if str(url_target or "") != entry["sourceUrl"]:
                problems.append(
                    f"「{evidence_index.EVIDENCE_SHEET}」{case_id} 的详情 URL 超链接不符：{url_target!r}")
            image_cell = sheet.cell(row=row, column=5)
            image_target = image_cell.hyperlink.target if image_cell.hyperlink is not None else None
            want_target = evidence_index.hyperlink_target(path, root, entry["relativePath"])
            if str(image_target or "") != want_target:
                problems.append(
                    f"「{evidence_index.EVIDENCE_SHEET}」{case_id} 的图片超链接不符：{image_target!r} != {want_target!r}")
        for case_id in rows:
            if case_id not in by_id:
                problems.append(
                    f"「{evidence_index.EVIDENCE_SHEET}」表里的 {case_id} 不在 sidecar caseEvidence 里")
    finally:
        workbook.close()
    return problems


def check_report_data(report_path: str, entries: list[dict], problems: list[str]) -> None:
    """Every report comparable marked used must have a matching validated workbook index row."""
    try:
        with open(report_path, "r", encoding="utf-8") as handle:
            report = json.load(handle)
    except Exception as error:  # noqa: BLE001 - 报告数据读不出来就无法核对采用案例
        problems.append(f"报告数据读不出来（{report_path}）：{error}")
        return
    if not isinstance(report, dict) or not isinstance(report.get("comparables"), list):
        problems.append("报告数据缺少 comparables 列表：无法核对已采用案例的证据索引")
        return
    by_id = {str(entry.get("caseId")): entry for entry in entries}
    for index, item in enumerate(report["comparables"]):
        if not isinstance(item, dict):
            problems.append(f"报告 comparables[{index}] 不是对象")
            continue
        if item.get("used") is not True:
            continue
        case_id = str(item.get("caseId") or "").strip()
        entry = by_id.get(case_id)
        if entry is None:
            problems.append(f"报告采用案例 {case_id} 在底稿案例证据索引里没有对应行")
            continue
        source_url = str(item.get("sourceUrl") or "").strip()
        if source_url != "" and source_url != str(entry.get("sourceUrl") or "").strip():
            problems.append(f"报告采用案例 {case_id} 的 sourceUrl 与索引不符：{source_url}")
        shots = item.get("screenshots")
        if isinstance(shots, list):
            valid_shots = [
                shot for shot in shots
                if isinstance(shot, dict) and shot.get("validity") == "valid"
                and str(shot.get("relativePath") or "").strip() != ""
            ]
            index_relative = str(entry.get("relativePath") or "").strip()
            index_digest = str(entry.get("digest") or "").strip()
            # A case may keep several valid images; the workbook index records one selected
            # image, so require the index row to match at least one valid report image.
            typed_detail = [shot for shot in valid_shots if shot.get("evidenceType") == "detail-screenshot"]
            candidates = typed_detail if typed_detail else valid_shots
            if candidates:
                matched = any(
                    str(shot.get("relativePath") or "").strip() == index_relative
                    and (str(shot.get("digest") or "").strip() == ""
                         or str(shot.get("digest") or "").strip() == index_digest)
                    for shot in candidates
                )
                if not matched:
                    problems.append(
                        f"报告采用案例 {case_id} 的选定截图与索引不一致：索引 {index_relative} / {index_digest}")


def _take(argv: list[str], flag: str) -> tuple[list[str], str]:
    if flag not in argv:
        return argv, ""
    index = argv.index(flag)
    value = argv[index + 1] if index + 1 < len(argv) else ""
    return argv[:index] + argv[index + 2:], value


def main() -> int:
    argv, contract_arg = _take([item for item in sys.argv[1:]], "--contract")
    argv, case_root_arg = _take(argv, "--case-root")
    argv, report_arg = _take(argv, "--report-data")
    if not argv:
        fail("缺少工作簿路径：通用校验要求显式给出工作簿，不再有随包默认")
        return 1
    path = argv[0]
    if not os.path.isfile(path):
        fail(f"找不到工作簿：{path}")
        return 1

    descriptor = contract_arg or (contract_path_for(path) if os.path.isfile(contract_path_for(path)) else "")
    if descriptor == "":
        fail(f"没有模板契约描述（--contract 或 {contract_path_for(path)}）：通用校验不猜内置 profile")
        return 1

    contract, problems = load_contract(descriptor)
    if contract is None:
        for problem in problems:
            fail(problem)
        return 1
    problems = check_parts(path) + check_generic(path, contract)
    evidence_entries, evidence_root, evidence_problems = load_case_evidence(path, contract, case_root_arg)
    problems = problems + evidence_problems
    if not evidence_problems:
        problems = problems + check_case_evidence_sheet(path, evidence_root, evidence_entries)
        if report_arg != "":
            if not os.path.isfile(report_arg):
                problems.append(f"找不到报告数据：{report_arg}")
            else:
                check_report_data(report_arg, evidence_entries, problems)
    if problems:
        for problem in problems:
            fail(problem)
        print(f"\n{len(problems)} 处不符（按模板契约 {descriptor}）：{path}")
        return 1
    names = [str(item["name"]) for item in contract["sheets"]]
    print(f"OK: {path} 符合模板契约（{descriptor}：{len(names)} 张表，无外部链接、无断链、"
          f"输入/公式/结果区与单位一致）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
