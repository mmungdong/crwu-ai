#!/usr/bin/env python3
"""把 `估值结果.json` 渲染成**人读的 HTML 报告**。

    python3 scripts/build_report.py --result <案例目录>/估值结果.json \
        --out <案例目录>/估值报告.html [--template …] [--force]

## 为什么报告必须从结果 JSON 渲染

报告与结果 JSON、计算底稿三者说的是同一件事。若报告单独誊一遍数字，三者迟早不一致，
而且不一致的时候没有任何东西会报错。所以这里**只读结果 JSON**，一个数都不许自己算 ——
连"万元换算"都不做：换算会引入第二套取整口径。

## 三条硬约束

1. **全部转义**：案例标题与小区名来自外部网页，直接拼进 HTML 就是一个注入点。
2. **数字逐字出现**：`unitPrice` / `totalValue` 按结果 JSON 里的值渲染（含千分位形态），
   `validate_result.py --html` 会核对报告里能不能找到这两个数。
3. **缺口不隐藏**：`capability_gaps` 与 `manual_confirmation_items` 为空时也**照实**写
   "无" —— 报告里缺一段，读的人会以为是漏印，而不是"确实没有"。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
DEFAULT_TEMPLATE = os.path.join(SKILL, "template", "valuation-report.html")

METHOD_LABELS = {"market": "市场法", "income": "收益法", "cost": "成本法"}
TRANSACTION_LABELS = {"挂牌": "挂牌", "成交": "成交", "询价": "询价", "未知": "未知"}
UNKNOWN = "—"
OBJECT_FIELDS = [
    ("坐落", "坐落"),
    ("房屋性质", "房屋性质"),
    ("用途", "用途"),
    ("建筑面积", "建筑面积（㎡）"),
    ("楼层", "楼层"),
    ("总楼层", "总楼层"),
    ("建筑结构", "建筑结构"),
    ("建成年代", "建成年代"),
]
# 报告里要列出的参数（未在结果里给出的不编造，标注为"未登记"）。
PARAMETER_LABELS = [
    ("增值税率", "增值税率"),
    ("土地增值税率", "土地增值税率"),
    ("契税率", "契税率"),
    ("报酬率", "报酬率"),
    ("空置率", "空置率"),
    ("收益年限", "收益年限"),
    ("重置成本单价", "建筑重置成本单价（元/㎡）"),
    ("成新率", "成新率"),
    ("土地单价", "土地单价（元/㎡）"),
]


def esc(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def money(value: object) -> str:
    if value is None or isinstance(value, bool):
        return UNKNOWN
    if not isinstance(value, (int, float)):
        return esc(value)
    return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.2f}"


def text_of(value: object) -> str:
    item = "" if value is None else str(value).strip()
    return item if item != "" else UNKNOWN


def list_block(items: object, empty_text: str, css: str) -> str:
    values = [str(item).strip() for item in items] if isinstance(items, list) else []
    values = [item for item in values if item != ""]
    if not values:
        return f'<p class="{css}">{esc(empty_text)}</p>'
    body = "".join(f"<li>{esc(item)}</li>" for item in values)
    return f'<div class="{css}"><ul>{body}</ul></div>'


def case_table(title: str, cases: list[dict], want_comparable: bool) -> str:
    rows = [case for case in cases if bool(case.get("used_as_comparable")) is want_comparable]
    if not rows:
        return f"<h3>{esc(title)}</h3><p class=\"muted\">没有这一类的案例。</p>"
    body = []
    for case in rows:
        reason = case.get("keep_reason") or case.get("drop_reason") or UNKNOWN
        link = case.get("url") or ""
        label = case.get("title") or case.get("community") or link or UNKNOWN
        # 只把 http/https 渲染成链接：`javascript:` 之类的伪协议不给出可点入口。
        title_html = (f'<a href="{esc(link)}" rel="noreferrer noopener">{esc(label)}</a>'
                      if str(link).startswith(("http://", "https://")) else esc(label))
        body.append(
            "<tr>"
            f"<td>{title_html}</td>"
            f"<td>{esc(case.get('community') or UNKNOWN)}</td>"
            f"<td>{esc(TRANSACTION_LABELS.get(str(case.get('transaction_type')), text_of(case.get('transaction_type'))))}</td>"
            f"<td>{money(case.get('building_area'))}</td>"
            f"<td>{money(case.get('unit_price'))}</td>"
            f"<td>{esc(case.get('captured_at') or UNKNOWN)}</td>"
            f"<td>{esc(reason)}</td>"
            "</tr>")
    return (f"<h3>{esc(title)}</h3>"
            "<table><thead><tr><th>案例</th><th>小区/地址</th><th>交易性质</th>"
            "<th>建筑面积</th><th>单价（元/㎡）</th><th>抓取时间</th><th>保留 / 剔除理由</th></tr></thead>"
            f"<tbody>{''.join(body)}</tbody></table>")


def main() -> int:
    parser = argparse.ArgumentParser(description="把估值结果渲染成 HTML 报告")
    parser.add_argument("--result", required=True, help="估值结果.json")
    parser.add_argument("--out", required=True, help="目标 HTML（案例目录内）")
    parser.add_argument("--template", default=DEFAULT_TEMPLATE, help="报告模板（只读）")
    parser.add_argument("--force", action="store_true", help="目标已存在时覆盖（默认拒绝）")
    args = parser.parse_args()

    if not os.path.isfile(args.template):
        print(f"FAIL 找不到报告模板：{args.template}")
        return 1
    if not os.path.isfile(args.result):
        print(f"FAIL 找不到结果文件：{args.result}")
        return 1
    if os.path.abspath(args.out) == os.path.abspath(args.template):
        print("FAIL 目标路径就是模板本身：产物必须写进估值案例目录，模板只读")
        return 1
    if os.path.exists(args.out) and not args.force:
        print(f"FAIL 目标已存在：{args.out}（要覆盖请加 --force）")
        return 1
    try:
        with open(args.result, "r", encoding="utf-8") as handle:
            result = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL 结果不是合法 JSON：{error}")
        return 1
    if not isinstance(result, dict):
        print("FAIL 结果顶层必须是对象")
        return 1

    method = str(result.get("method") or "")
    if method not in METHOD_LABELS:
        print(f"FAIL method 不是结论方法（market/income/cost）：{method!r}"
              "（`auto` 是用户输入，渲染报告前必须已经判定）")
        return 1

    artifacts = result.get("artifacts") if isinstance(result.get("artifacts"), dict) else {}
    cases = [case for case in result.get("cases", []) if isinstance(case, dict)] \
        if isinstance(result.get("cases"), list) else []
    knowledge = [item for item in result.get("knowledge_sources", []) if isinstance(item, dict)] \
        if isinstance(result.get("knowledge_sources"), list) else []
    base_date = str(result.get("baseDate") or "").strip()

    object_rows = []
    fields = result.get("object_fields") if isinstance(result.get("object_fields"), dict) else {}
    for key, label in OBJECT_FIELDS:
        object_rows.append(f"  <dt>{esc(label)}</dt><dd>{esc(text_of(fields.get(key)))}</dd>")
    parameter_rows = []
    parameters = result.get("parameters") if isinstance(result.get("parameters"), dict) else {}
    for key, label in PARAMETER_LABELS:
        entry = parameters.get(key)
        if isinstance(entry, dict):
            value = text_of(entry.get("value"))
            basis = text_of(entry.get("basis"))
        else:
            value, basis = text_of(entry), UNKNOWN
        parameter_rows.append(f"    <tr><td>{esc(label)}</td><td>{esc(value)}</td><td>{esc(basis)}</td></tr>")
    knowledge_rows = "".join(
        f"    <tr><td>{esc(item.get('route'))}</td><td>{esc(item.get('source'))}</td>"
        f"<td>{esc(item.get('updatedAt') or UNKNOWN)}</td><td>{esc(item.get('digest'))}</td></tr>"
        for item in knowledge) or '    <tr><td colspan="4" class="muted">没有登记知识来源。</td></tr>'

    replacements = {
        "{{valuationId}}": esc(text_of(result.get("valuationId"))),
        "{{generatedAt}}": esc(text_of(result.get("generatedAt"))),
        "{{method}}": esc(method),
        "{{methodLabel}}": esc(METHOD_LABELS[method]),
        "{{methodReason}}": esc(text_of(result.get("methodReason"))),
        "{{baseDate}}": esc(base_date if base_date != "" else "本次未指定评估基准日"),
        "{{unitPrice}}": esc(money(result.get("unitPrice"))),
        "{{totalValue}}": esc(money(result.get("totalValue"))),
        "{{objectRows}}": "\n".join(object_rows),
        "{{parameterRows}}": "\n".join(parameter_rows) or '    <tr><td colspan="3" class="muted">没有登记参数。</td></tr>',
        "{{caseTables}}": "\n".join([
            case_table("可直接作可比实例（成交）", cases, True),
            case_table("挂牌 / 询价 / 未知（需修正）", cases, False),
        ]),
        "{{knowledgeRows}}": knowledge_rows,
        "{{manualItems}}": list_block(
            result.get("manual_confirmation_items"),
            "没有待确认事项。", "note"),
        "{{capabilityGaps}}": list_block(
            result.get("capability_gaps"), "没有登记能力缺口。", "gap"),
        "{{artifactXlsx}}": esc(text_of(artifacts.get("xlsx"))),
        "{{artifactJson}}": esc(text_of(artifacts.get("json"))),
        "{{artifactHtml}}": esc(text_of(artifacts.get("html"))),
    }

    with open(args.template, "r", encoding="utf-8") as handle:
        body = handle.read()
    for key, value in replacements.items():
        body = body.replace(key, value)
    leftovers = [token for token in ("{{", "}}") if token in body]
    if leftovers:
        print("FAIL 模板里还有没被替换的占位符：请同步 template/valuation-report.html 与本脚本")
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(body)
    print(f"OK: 已生成 {args.out}（{len(cases)} 条案例 / {len(knowledge)} 份知识来源 / "
          f"待确认 {len(result.get('manual_confirmation_items') or [])} 项 / "
          f"缺口 {len(result.get('capability_gaps') or [])} 项）")
    print("提醒：报告数字必须与计算底稿重算结果一致；以底稿为准（不一致时改报告，不改底稿）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
