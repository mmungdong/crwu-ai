#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段一材料准备：可读性核查 + 隐藏数据隔离 + 「工作版」重建（crwu-audit 编排层专用）。

归属：`crwu-audit` 技能自带脚本（随技能安装）。执行契约见本技能
`references/00-input-and-route-profile.md` § Excel 隐藏数据隔离。

纪律（每条都对应一次真实失效，不得回退）：

H0 人工隐藏区**整体排除审核范围**：sheet / 行 / 列 / 折叠分组是**员工手动隐藏**的，
表示其已明确不纳入审核。隐藏区**禁读禁报**——不读取、不引用、不输出任何内容值，
不产生差异或意见；只允许读「哪些行/列被隐藏了」这类结构元数据，用于剔除。

1. **缓存值优先**：重建时单元格有缓存值（`data_only=True`）就写缓存值，**仅当无缓存值**
   才写公式串。重建簿不会被 Excel 重算，写公式串会让后续 `data_only=True` 读回 `None`，
   把"公式未重算"误读成"数据缺失"（曾据此误报"评估结果列全空"）。
2. **「值不可得」≠「数据缺失」**：无缓存值且为公式/外部引用（或两者皆无但有样式）的格，
   登记为「值不可得」元数据（按表计数，不含内容值），供后续**如实声明**该格取不到值；
   **禁止**据此判"空白/缺失/未填"。
3. **输出名唯一 + 来源可追溯**：同名不同版本（如定稿/送审稿同名）必须消歧（追加来源目录
   后缀），并在盘点中记录来源子目录（`stage`）与工作版路径一一对应，**禁止静默覆盖**
   （曾因送审稿覆盖定稿，误判"使用状况=自用"）。
4. **不得改变格式语义**：逐格复制 `number_format`，重建后数值/日期语义与原件一致；
   对"疑似被日期化的数值列"，结论前须回 raw 原件核对格式。
5. 只读源材料：源目录**不写入任何派生文件**（`textutil` 等中间产物落系统临时目录）。

产出：`材料盘点.json`、`提取/<文件>.txt`、`工作版/<文件>.xlsx`。

用法：
    python3 scripts/prepare_materials.py --case <案例目录> [--src 材料-源] [--work 工作版]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile

HIDDEN_SHEET = "[隐藏]"


OPTIONAL_DEPS = {"openpyxl": ".xlsx", "docx": ".docx", "pypdf": ".pdf", "xlrd": ".xls"}


def missing_deps() -> list:
    """缺哪些可选依赖（缺了会让对应格式读不到，必须显式告知，不得静默）。"""
    import importlib.util as iu
    return [f"{mod}({ext})" for mod, ext in OPTIONAL_DEPS.items() if iu.find_spec(mod) is None]


def magic(p: str) -> str:
    with open(p, "rb") as f:
        h = f.read(8)
    if h[:4] == b"PK\x03\x04":
        return "zip-ooxml"
    if h[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "ole"
    if h[:5] == b"%PDF-":
        return "pdf"
    if h[:4] == b"\x89PNG":
        return "png"
    return "other"


def doc_to_text(p: str):
    """OLE .doc：textutil 转换。

    中间产物必须落系统临时目录：否则会在源材料目录里落下 `.doc.txt` 派生文件，
    污染源目录并被后续盘点重复计入（曾真实发生）。
    """
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "out.txt")
        r = subprocess.run(["textutil", "-convert", "txt", "-output", out, p],
                           capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(out):
            return None, f"textutil 失败：{r.stderr.strip()[:120]}"
        with open(out, encoding="utf-8", errors="replace") as fh:
            return fh.read(), None


def docx_to_text(p: str):
    """`.docx` 文本抽取：python-docx 优先（保留表格结构），缺失则回退 textutil。

    不得因为缺依赖就静默读不到：评估说明/报告正文多为 .docx，读不到会直接改变审核结论。
    """
    try:
        import docx
        d = docx.Document(p)
        buf = [para.text for para in d.paragraphs]
        for ti, t in enumerate(d.tables):
            buf.append(f"\n[表 {ti + 1}]")
            for row in t.rows:
                buf.append(" | ".join(c.text.replace("\n", " ") for c in row.cells))
        return "\n".join(buf), None
    except ImportError:
        txt, err = doc_to_text(p)          # textutil 同样能吃 .docx
        if txt is not None:
            return txt, "python-docx 缺失，已用 textutil 回退（表格结构可能丢失）"
        return None, f"python-docx 缺失且 textutil 回退失败：{err}"


def pdf_to_text(p: str):
    from pypdf import PdfReader
    r = PdfReader(p)
    out = []
    for i, page in enumerate(r.pages, 1):
        out.append(f"\n===== 第 {i} 页 =====")
        out.append(page.extract_text() or "")
    txt = "\n".join(out)
    if len(txt.strip()) < 50:
        return txt, "PDF 无文本层或内容极少（疑扫描件）"
    return txt, None


def xls_dump(p: str):
    import xlrd
    bk = xlrd.open_workbook(p, formatting_info=False)
    buf = []
    for sh in bk.sheets():
        tag = "[隐藏]" if getattr(sh, "visibility", 0) != 0 else ""
        buf.append(f"\n===== sheet: {sh.name}{tag} ({sh.nrows}行 × {sh.ncols}列) =====")
        if tag:
            continue  # H0：隐藏 sheet 只记名字，不取其单元格
        for r in range(sh.nrows):
            vals = [str(sh.cell_value(r, c)) for c in range(sh.ncols)]
            if any(v.strip() and v != "0.0" for v in vals):
                buf.append(f"r{r + 1}: " + " | ".join(vals))
    return "\n".join(buf), "xlrd 只读值：公式串不可得且无 soffice 可重算"


def _collapsed_outline_rows(ws) -> set:
    """折叠分组内的行视同隐藏（Excel 折叠后这些行对人不展示）。"""
    levels = {r: (getattr(d, "outlineLevel", 0) or 0) for r, d in ws.row_dimensions.items()}
    if not any(lv > 0 for lv in levels.values()):
        return set()
    summary_below = True
    try:
        pr = ws.sheet_properties.outlinePr
        if pr is not None and pr.summaryBelow is not None:
            summary_below = bool(pr.summaryBelow)
    except Exception:
        pass
    collapsed = {r for r, d in ws.row_dimensions.items() if getattr(d, "collapsed", False)}
    if not collapsed:
        return set()
    out, max_r = set(), ws.max_row
    for r in range(1, max_r + 1):
        lv = levels.get(r, 0)
        if lv <= 0:
            continue
        s = r
        if summary_below:
            while s <= max_r and levels.get(s, 0) >= lv:
                s += 1
        else:
            while s >= 1 and levels.get(s, 0) >= lv:
                s -= 1
        if s in collapsed:
            out.add(r)
    return out


def _collapsed_outline_cols(ws) -> set:
    """折叠分组内的列视同隐藏（列方向同理）。"""
    from openpyxl.utils import column_index_from_string, get_column_letter
    levels = {c: (getattr(d, "outlineLevel", 0) or 0) for c, d in ws.column_dimensions.items()}
    if not any(lv > 0 for lv in levels.values()):
        return set()
    summary_right = True
    try:
        pr = ws.sheet_properties.outlinePr
        if pr is not None and pr.summaryRight is not None:
            summary_right = bool(pr.summaryRight)
    except Exception:
        pass
    collapsed = {c for c, d in ws.column_dimensions.items() if getattr(d, "collapsed", False)}
    if not collapsed:
        return set()
    out = set()
    for c in range(1, ws.max_column + 1):
        letter = get_column_letter(c)
        lv = levels.get(letter, 0)
        if lv <= 0:
            continue
        i = c
        if summary_right:
            while i <= ws.max_column and levels.get(get_column_letter(i), 0) >= lv:
                i += 1
            s = get_column_letter(i)
        else:
            while i >= 1 and levels.get(get_column_letter(i), 0) >= lv:
                i -= 1
            s = get_column_letter(i)
        if s in collapsed:
            out.add(letter)
    return out


def _hidden_metadata(wb_value, wb_formula) -> dict:
    """只读结构元数据以识别隐藏区；隐藏 sheet 只记名字，不枚举其行列。"""
    hidden = {"hiddenSheets": [], "hiddenRows": {}, "hiddenCols": {}}
    for ws in wb_value.worksheets:
        if ws.sheet_state != "visible":
            hidden["hiddenSheets"].append(ws.title)
            continue
        rows = {r for r, d in ws.row_dimensions.items() if d.hidden} | _collapsed_outline_rows(ws)
        cols = {c for c, d in ws.column_dimensions.items() if d.hidden} | _collapsed_outline_cols(ws)
        if rows:
            hidden["hiddenRows"][ws.title] = sorted(rows)
        if cols:
            hidden["hiddenCols"][ws.title] = sorted(cols)
    return hidden


# ---- 隐藏区引用审计（H0 内合法动作：只读「可见区公式的坐标」，绝不读隐藏区内容） ----
_CELL_RE = r"\$?[A-Z]{1,3}\$?\d{1,7}"
_REF_RE = re.compile(
    r"(?:(?:'(?P<q>[^']+)'|(?P<s>[A-Za-z\u4e00-\u9fff_][^!:'\[\]]*))!)?"
    r"(?P<a>" + _CELL_RE + r")(?::(?P<b>" + _CELL_RE + r"))?(?!\s*\()"
)


def _coord(ref: str):
    from openpyxl.utils import column_index_from_string
    ref = ref.replace("$", "")
    i = 0
    while i < len(ref) and not ref[i].isdigit():
        i += 1
    return int(ref[i:]), column_index_from_string(ref[:i])


def _span(a: str, b: str):
    """范围涉及的 (行集合, 列集合)；无 b 时即单格。"""
    r1, c1 = _coord(a)
    r2, c2 = _coord(b) if b else (r1, c1)
    return set(range(min(r1, r2), max(r1, r2) + 1)), set(range(min(c1, c2), max(c1, c2) + 1))


def audit_hidden_references(wbf, hidden: dict):
    """逐「可见格公式」解析其引用坐标，判定是否指向隐藏行/列/隐藏工作表。

    只读可见格的公式串；隐藏行/列/隐藏 sheet 的单元格**一律不读**（H0）。
    用途：判定"可见结果是否依赖不可见的计算输入" → 计算链不可复核。
    """
    from openpyxl.utils import column_index_from_string, get_column_letter
    hidden_sheets = set(hidden.get("hiddenSheets", []))
    hid_rows = {s: set(v) for s, v in hidden.get("hiddenRows", {}).items()}
    # 忽略清单里列用字母（给人看），比对时必须换算成列序号
    hid_cols = {s: {column_index_from_string(c) for c in v}
                for s, v in hidden.get("hiddenCols", {}).items()}
    hits, seen = [], set()
    for ws in wbf.worksheets:
        if ws.sheet_state != "visible":
            continue                      # H0：隐藏 sheet 整体不读
        rows_h = hid_rows.get(ws.title, set())
        cols_h = hid_cols.get(ws.title, set())          # 列序号集合
        for row in ws.iter_rows():
            for c in row:
                if c.row in rows_h or c.column in cols_h:
                    continue              # H0：隐藏格不读
                f = c.value
                if not isinstance(f, str) or not f.startswith("="):
                    continue
                for m in _REF_RE.finditer(f):
                    sheet = (m.group("q") or m.group("s") or ws.title).strip()
                    kind = None
                    if sheet in hidden_sheets:
                        kind = "引用隐藏工作表"
                    elif sheet == ws.title:
                        rows, cols = _span(m.group("a"), m.group("b"))
                        if rows & rows_h:
                            kind = "引用隐藏行"
                        elif cols & cols_h:
                            kind = "引用隐藏列"
                    if kind:
                        key = (ws.title, c.coordinate, m.group(0))
                        if key in seen:
                            continue
                        seen.add(key)
                        hits.append({"sheet": ws.title, "cell": c.coordinate,
                                     "kind": kind, "ref": m.group(0)})
    return hits


def xlsx_visible(p: str, outdir: str, out_name: str):
    """重建法：新建簿，只复制「可见 sheet × 可见行 × 可见列」的值（缓存值优先）与格式。

    禁止用 delete_rows/delete_cols 逐行列删除（会残留维度元数据）。
    """
    import openpyxl
    from openpyxl.utils import get_column_letter

    src = openpyxl.load_workbook(p, data_only=True)      # 缓存值
    srcf = openpyxl.load_workbook(p, data_only=False)    # 公式串
    hidden = _hidden_metadata(src, srcf)

    dst = openpyxl.Workbook()
    dst.remove(dst.active)
    stats, unavailable = [], []
    for ws in src.worksheets:
        if ws.sheet_state != "visible":
            continue  # H0：隐藏 sheet 整体跳过，不读其任何单元格
        wsf = srcf[ws.title]
        hidden_rows = set(hidden["hiddenRows"].get(ws.title, []))
        hidden_cols = set(hidden["hiddenCols"].get(ws.title, []))
        o = dst.create_sheet(ws.title[:31])
        vis_rows = [r for r in range(1, ws.max_row + 1) if r not in hidden_rows]
        used = no_cached = 0
        for ri, r in enumerate(vis_rows, 1):
            for c in range(1, ws.max_column + 1):
                if get_column_letter(c) in hidden_cols:
                    continue  # H0：隐藏列不读
                v = ws.cell(r, c).value
                f = wsf.cell(r, c).value
                if v is None and f is None:
                    continue
                cell = o.cell(ri, c)
                if v is not None:
                    cell.value = v                      # 缓存值优先
                    if f is not None:
                        cell.number_format = wsf.cell(r, c).number_format
                elif isinstance(f, str) and f.startswith("="):
                    cell.value = f                      # 仅当无缓存值时保留公式串
                    cell.number_format = wsf.cell(r, c).number_format
                    no_cached += 1
                used += 1
        if no_cached:
            unavailable.append({"sheet": ws.title, "cells": no_cached})
        stats.append({"sheet": ws.title, "visibleRows": len(vis_rows), "cells": used,
                      "maxRow": ws.max_row, "maxCol": ws.max_column,
                      "valueUnavailable": no_cached})
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, out_name)
    dst.save(out)

    chk = openpyxl.load_workbook(out)
    resid = sum(1 for ws in chk.worksheets if ws.sheet_state != "visible")
    refs = audit_hidden_references(srcf, hidden)
    return out, hidden, stats, resid, unavailable, refs


def prepare(case: str, src_dir: str, txt_dir: str, work_dir: str) -> dict:
    os.makedirs(txt_dir, exist_ok=True)
    os.makedirs(work_dir, exist_ok=True)
    inv = []
    seen_xlsx: set = set()
    files = []
    for root, _, fs in os.walk(src_dir):
        for f in sorted(fs):
            if f.startswith(".") or f.endswith(".part"):
                continue
            files.append(os.path.join(root, f))

    for p in sorted(files):
        rel = os.path.relpath(p, case)
        ext = os.path.splitext(p)[1].lower()
        kind = magic(p)
        rec = {"path": rel, "name": os.path.basename(p),
               "stage": os.path.basename(os.path.dirname(p)),
               "ext": ext, "magic": kind, "size": os.path.getsize(p)}
        try:
            if ext == ".doc" and kind == "ole":
                txt, err = doc_to_text(p)
                rec["readable"] = txt is not None
                if txt:
                    with open(os.path.join(txt_dir, os.path.basename(p) + ".txt"), "w",
                              encoding="utf-8") as fh:
                        fh.write(txt)
                    rec["chars"] = len(txt)
                if err:
                    rec["note"] = err
            elif ext == ".docx":
                txt, err = docx_to_text(p)
                rec["readable"] = txt is not None
                if txt is not None:
                    with open(os.path.join(txt_dir, os.path.basename(p) + ".txt"), "w",
                              encoding="utf-8") as fh:
                        fh.write(txt)
                    rec["chars"] = len(txt)
                if err:
                    rec["note"] = err
            elif ext == ".pdf":
                txt, err = pdf_to_text(p)
                rec["readable"] = not err
                with open(os.path.join(txt_dir, os.path.basename(p) + ".txt"), "w",
                          encoding="utf-8") as fh:
                    fh.write(txt)
                rec["chars"] = len(txt)
                if err:
                    rec["note"] = err
            elif ext == ".xlsx":
                # 同名不同版本（定稿/送审稿）必须消歧，否则后落盘者静默覆盖前者
                out_name = os.path.basename(p)
                if out_name in seen_xlsx:
                    stem, se = os.path.splitext(out_name)
                    out_name = f"{stem}__{os.path.basename(os.path.dirname(p))}{se}"
                    rec["nameCollision"] = True
                seen_xlsx.add(out_name)
                out, hidden, stats, resid, unavailable, refs = xlsx_visible(p, work_dir, out_name)
                rec["readable"] = True
                rec["workbook"] = {"workVersion": os.path.relpath(out, case),
                                   "sheets": stats, "hiddenResidual": resid,
                                   "hiddenMeta": hidden,
                                   "valueUnavailable": unavailable,
                                   "hiddenRefs": refs[:50],
                                   "hiddenRefsCount": len(refs),
                                   "calcChainNotReproducible": sorted(
                                       {f"{h['sheet']}!{h['cell']}" for h in refs}),
                                   }
                if resid:
                    rec["note"] = f"隐藏区残留 {resid}：需按重建法重做，仍残留则挂起"
                with open(os.path.join(txt_dir, os.path.basename(p) + ".sheets.json"), "w",
                          encoding="utf-8") as fh:
                    fh.write(json.dumps(stats, ensure_ascii=False, indent=1))
            elif ext == ".xls" and kind == "ole":
                txt, note = xls_dump(p)
                rec["readable"] = True
                rec["note"] = note
                with open(os.path.join(txt_dir, os.path.basename(p) + ".txt"), "w",
                          encoding="utf-8") as fh:
                    fh.write(txt)
            elif kind == "zip-ooxml" or ext == ".zip":
                rec["readable"] = False
                rec["note"] = "压缩包：未解压审核"
            elif kind == "png":
                rec["readable"] = False
                rec["note"] = "图片：无 OCR"
            else:
                rec["readable"] = False
                rec["note"] = f"未支持格式 magic={kind}"
        except Exception as e:
            rec["readable"] = False
            rec["note"] = f"{type(e).__name__}: {e}"
        inv.append(rec)
        print(f"[{'OK ' if rec.get('readable') else 'NG '}] {rel}  {rec.get('note', '')}",
              flush=True)

    inv_path = os.path.join(case, "材料盘点.json")
    with open(inv_path, "w", encoding="utf-8") as fh:
        json.dump(inv, fh, ensure_ascii=False, indent=1)
    return {"inventory": inv_path, "items": len(inv),
            "readable": sum(1 for r in inv if r.get("readable"))}


def main() -> int:
    ap = argparse.ArgumentParser(description="阶段一材料准备：可读性核查 + 隐藏数据隔离 + 工作版重建")
    ap.add_argument("--case", default=os.getcwd(), help="案例目录（默认当前目录）")
    ap.add_argument("--src", default=None, help="源材料目录（默认 <案例>/材料-源）")
    ap.add_argument("--txt", default=None, help="文本提取目录（默认 <案例>/提取）")
    ap.add_argument("--work", default=None, help="工作版目录（默认 <案例>/工作版）")
    args = ap.parse_args()

    case = os.path.abspath(args.case)
    src_dir = os.path.abspath(args.src or os.path.join(case, "材料-源"))
    if not os.path.isdir(src_dir):
        print(f"error: 源材料目录不存在：{src_dir}")
        return 2
    result = prepare(case, src_dir,
                     os.path.abspath(args.txt or os.path.join(case, "提取")),
                     os.path.abspath(args.work or os.path.join(case, "工作版")))
    print(f"\n盘点 {result['items']} 件；可读 {result['readable']} / "
          f"不可读 {result['items'] - result['readable']}；盘点表 {result['inventory']}")
    missing = missing_deps()
    if missing:
        print(f"提示：缺少可选依赖 {', '.join(missing)}——对应格式可能读不到，"
              f"不读到的部分必须在审核结论中如实声明（不得当作\"材料缺失\"）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
