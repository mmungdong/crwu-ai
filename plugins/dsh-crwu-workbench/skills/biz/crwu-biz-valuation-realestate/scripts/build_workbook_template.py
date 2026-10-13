#!/usr/bin/env python3
"""Generate the generic real-estate valuation workbook template.

Contract: references/06-workbook-contract.md (7 visible sheets, no hidden sheet,
no cross-workbook reference, no #REF!). Run from the skill directory:

    python3 scripts/build_workbook_template.py
"""

from __future__ import annotations

import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

INPUT_FILL = PatternFill("solid", fgColor="E2EFDA")
FORMULA_FILL = PatternFill("solid", fgColor="FFF2CC")
CHECK_FILL = PatternFill("solid", fgColor="F2F2F2")
HEAD_FILL = PatternFill("solid", fgColor="D9E1F2")
TITLE_FONT = Font(name="等线", size=14, bold=True)
HEAD_FONT = Font(name="等线", size=10, bold=True)
BODY_FONT = Font(name="等线", size=10)
NOTE_FONT = Font(name="等线", size=9, color="808080")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="center")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)

TITLE = "房地产估值标准计算表（通用模板）"
HEADERS = ["项目", "评估对象", "可比实例A", "可比实例B", "可比实例C", "备注"]


def put(ws, row, col, value, *, fill=None, font=None, align=None, border=True, fmt=None):
    cell = ws.cell(row=row, column=col, value=value)
    if fill is not None:
        cell.fill = fill
    if font is not None:
        cell.font = font
    if align is not None:
        cell.alignment = align
    if border:
        cell.border = BORDER
    if fmt is not None:
        cell.number_format = fmt
    return cell


def title_block(ws, last_col, title, subtitle):
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
    put(ws, 1, 1, title, font=TITLE_FONT, align=CENTER)
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last_col)
    put(ws, 2, 1, subtitle, font=NOTE_FONT, align=Alignment(vertical="center"))


def header_row(ws, row, values, last_col=None):
    for index, value in enumerate(values, start=1):
        put(ws, row, index, value, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    if last_col is not None:
        for col in range(len(values) + 1, last_col + 1):
            put(ws, row, col, None, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)


def field_block(ws, row, label, values, *, fill, fmt=None, note=None):
    put(ws, row, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    for offset, value in enumerate(values):
        put(ws, row, 2 + offset, value, fill=fill, font=BODY_FONT, align=WRAP, fmt=fmt)
    put(ws, row, 6, note, font=NOTE_FONT, align=WRAP)


def build_base_info(wb):
    ws = wb.create_sheet("基础信息表")
    title_block(ws, 6, "基础信息表", "浅绿=输入区；浅黄=公式区；灰色=勾稽区。公式区请勿用数值覆盖。")
    row = 4
    put(ws, row, 1, "一、项目输入", fill=HEAD_FILL, font=HEAD_FONT)
    row += 1
    fields = [
        ("被评估单位", "评估目的", "价值类型（市场价值/公允价值/投资价值/清算价值）"),
        ("评估基准日", "现场勘察日", "现场勘察人"),
        ("价值内涵", "财产范围/付款方式/融资条件/税费负担/计价单位/含税与否", "按 references/01 第4节六项逐项写明"),
        ("采用结论的方法", "市场法 / 收益法 / 成本法", "选定后在「估值结果汇总」标注"),
    ]
    for left, mid, right in fields:
        put(ws, row, 1, left, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        put(ws, row, 2, None, fill=INPUT_FILL, align=WRAP)
        ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=5)
        put(ws, row, 3, mid, font=NOTE_FONT, align=WRAP)
        put(ws, row, 6, right, font=NOTE_FONT, align=WRAP)
        row += 1
    row += 1
    put(ws, row, 1, "二、参数与税率登记（市场法与收益法共用）", fill=HEAD_FILL, font=HEAD_FONT)
    row += 1
    header_row(ws, row, ["参数名", "取值", "依据 / 来源", "时点 / 有效期", "取数人 / 待确认", "备注"])
    row += 1
    default_params = [
        ("增值税率（处置不动产）", 0.09, "现行增值税规定；以基准日有效正文为准"),
        ("增值税率（个人出租住房）", 0.015, "同上；出租主体为个人住房"),
        ("城建税率", 0.07, "按项目所在地：市区7%/县镇5%/其他1%"),
        ("教育费附加", 0.03, "现行规定"),
        ("地方教育附加", 0.02, "按项目所在地"),
        ("土地增值税（核定）", 0.05, "非住宅企业转让核定征收率；以当地税务机关口径为准"),
        ("个人所得税（核定）", 0.01, "个人转让住房核定征收率；满五唯一免征"),
        ("契税率", 0.01, "买方负担，按当地套数/面积档"),
        ("房产税率", 0.12, "企业从租计征12%；个人出租住房常为4%"),
        ("城镇土地使用税（元/㎡·年）", 24, "当地地段等级标准"),
        ("容积率", 1, "项目规划指标"),
        ("印花税率", 0.001, "财产租赁合同"),
        ("空置率", 0.1, "当地同类物业调查 / 项目历史出租率"),
        ("报酬率 Y", 0.06, "安全利率 + 风险调整值，分项写明"),
        ("增长率 g", 0.02, "区域租售调查与预测"),
        ("一年期存款利率", 0.0095, "评估基准日人行公布值"),
        ("押金月数", 1, "租约或市场惯例"),
        ("管理费率", 0.02, "项目实际或行业惯例"),
        ("维修费率", 0.02, "房屋状况与行业惯例"),
        ("保险费率", 0.001, "保险公司报价"),
        ("建筑重置成本（元/㎡）", None, "造价 / 决算 / 类比来源"),
        ("建安综合造价（元/㎡）", None, "成本法分项构成口径：建安造价（不含前期/管理/资金/利润）"),
        ("前期及其他费用率", None, "成本法分项构成口径，取值与来源"),
        ("资金成本率", None, "成本法分项构成口径，取值与来源"),
        ("开发利润率", None, "成本法分项构成口径，取值与来源"),
        ("经济耐用年限（年）", None, "按结构取（见 references/07 第5节）"),
        ("已使用年限（年）", None, "竣工/建成至基准日"),
        ("土地单价（元/㎡）", None, "成本逼近法/基准地价系数修正法/市场法"),
        ("土地终止年限", None, "权证记载"),
        ("建筑终止年限", None, "剩余经济寿命测算"),
    ]
    for name, value, source in default_params:
        put(ws, row, 1, name, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
        put(ws, row, 2, value, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
        put(ws, row, 3, source, font=NOTE_FONT, align=WRAP)
        put(ws, row, 4, None, fill=INPUT_FILL, font=BODY_FONT)
        put(ws, row, 5, None, fill=INPUT_FILL, font=BODY_FONT)
        put(ws, row, 6, None, fill=INPUT_FILL, font=BODY_FONT)
        row += 1
    for col, width in zip("ABCDEF", (30, 20, 46, 18, 18, 24)):
        ws.column_dimensions[col].width = width


def build_case(wb):
    ws = wb.create_sheet("案例")
    title_block(ws, 6, "案例", "登记字段与可比性留痕见 references/04；剔除的案例保留记录并写明理由。")
    row = 4
    header_row(ws, row, ["字段", "可比实例A", "可比实例B", "可比实例C", "备注", ""])
    row += 1
    groups = [
        ("一、基本信息", [
            "实例名称 / 房号", "案例来源（类型+取得方式）", "案例链接（URL）",
            "案例截图 / 证据留档（文件名或留档路径）", "取得日期 / 取得人", "房屋坐落",
            "房屋用途", "所在楼层 / 总楼层", "结构", "建成年代", "装修状况·公共区域",
            "装修状况·室内", "配套设施",
        ]),
        ("二、价格与交易", [
            "交易价格（万元）", "价格内涵（面积口径/含税口径/是否挂牌）", "面积内涵",
            "建筑面积（㎡）", "交易时间", "交易情况", "税费负担与税收优惠档",
            "交易单价（元/㎡）",
        ]),
        ("三、区位状况", [
            "住宅集聚度", "距商业中心距离", "公交便捷程度", "通达性", "接近性",
            "景观", "周边环境状况", "面积与配套车位数量比", "公共配套设施", "教育配套设施",
        ]),
        ("四、实物状况", [
            "住宅类型", "小区内具体位置", "外观形象", "装修·公共区域档次", "装修·室内档次",
            "面积大小", "配套设备设施", "土地红线内基础设施", "物业管理水平",
            "是否有学区资格", "成新及维护保养状况", "建筑结构",
        ]),
        ("五、权益状况", ["租赁权", "抵押权", "土地剩余经济年限", "其他权利限制"]),
        ("六、判断与留痕", [
            "可比性判断（相似/部分相似/不相似）", "保留 / 剔除", "保留或剔除理由", "待确认事项",
        ]),
    ]
    for group, items in groups:
        put(ws, row, 1, group, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        for col in range(2, 7):
            put(ws, row, col, None, fill=HEAD_FILL)
        row += 1
        for item in items:
            put(ws, row, 1, item, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
            for col in range(2, 5):
                put(ws, row, col, None, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
            put(ws, row, 5, None, font=NOTE_FONT, align=WRAP)
            put(ws, row, 6, None, fill=INPUT_FILL, font=BODY_FONT)
            row += 1
    row += 1
    put(ws, row, 1, "案例数量与可比性汇总", fill=HEAD_FILL, font=HEAD_FONT)
    put(ws, row, 2, "候选数", fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
    put(ws, row, 3, "保留数", fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
    put(ws, row, 4, "剔除数", fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
    put(ws, row, 5, "=IF(保留数>=3,\"满足\",\"不足3个，须写明处置\")", fill=CHECK_FILL, font=BODY_FONT, align=WRAP)
    put(ws, row, 6, "见 references/04 第5节", font=NOTE_FONT, align=WRAP)
    for col, width in zip("ABCDEF", (34, 26, 26, 26, 30, 20)):
        ws.column_dimensions[col].width = width


def build_normalization(wb):
    ws = wb.create_sheet("价值内涵与税费")
    title_block(ws, 6, "价值内涵与税费", "先把三个案例统一到同一价值内涵，再做税费正常负担还原；口径见 references/01 第4节、references/05。")
    row = 4
    put(ws, row, 1, "一、案例概况与统一价值内涵", fill=HEAD_FILL, font=HEAD_FONT)
    row += 1
    header_row(ws, row, HEADERS)
    row += 1
    simple_rows = [
        "实例名称", "案例来源", "交易价格（万元）", "价格内涵", "面积内涵",
        "建筑面积（㎡）", "交易日期", "交易情况", "房屋坐落", "房屋用途",
        "所在楼层/总楼层", "建成年代", "装修状况（公共/室内）",
    ]
    for label in simple_rows:
        put(ws, row, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        for col in range(2, 6):
            put(ws, row, col, None, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
        put(ws, row, 6, None, font=NOTE_FONT, align=WRAP)
        row += 1

    unified = [
        ("统一财产范围", "设定为“纯粹”“干净”房地产", "1"),
        ("统一付款方式", "成交日一次性付清", "1"),
        ("统一融资条件", "常规融资条件", "1"),
        ("统一税费负担", "交易双方各自负担法定税费", "1"),
        ("统一计价单位", "人民币元/建筑平方米", "1"),
        ("含税与否", "与评估对象同一口径", "1"),
    ]
    for label, setting, coef in unified:
        put(ws, row, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        put(ws, row, 2, setting, font=NOTE_FONT, align=WRAP)
        for col in range(3, 6):
            put(ws, row, col, coef, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
        put(ws, row, 6, "修正系数：1=无需修正", font=NOTE_FONT, align=WRAP)
        row += 1

    row += 1
    put(ws, row, 1, "二、税费正常负担还原（逐案例；免征必须写明免征依据）", fill=HEAD_FILL, font=HEAD_FONT)
    row += 1
    header_row(ws, row, HEADERS)
    row += 1
    start = row
    tax_rows = [
        ("不含税卖方净得价（元）", None, "=交易价格*10000", None),
        ("增值税", None, "免征税种填“免征”并写明依据", None),
        ("土地增值税", None, "=不含税卖方净得价*核定征收率（或写免征依据）", None),
        ("附加税", None, "=增值税*(城建税率+教育费附加+地方教育附加)；增值税免征则免征", None),
        ("个税或所得税", None, "=不含税卖方净得价*核定征收率；免征写依据", None),
        ("卖方应负担税费合计（元）", None, "=SUM(增值税:个税或所得税)", None),
        ("买方应负担税费合计（元）", None, "=含税价*契税率（按当地档）", None),
        ("税费正常负担下的含税价（元）", None, "=不含税卖方净得价+卖方合计+买方合计", None),
        ("含税单价（元/㎡）", None, "=ROUND(含税价/建筑面积,-1)", None),
        ("税费正常负担下的不含税价（元）", None, "=含税价-增值税", None),
        ("不含税单价（元/㎡）", None, "=ROUND(不含税价/建筑面积,-1)", None),
    ]
    for index, (label, _, note, _) in enumerate(tax_rows):
        current = start + index
        put(ws, current, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        for col in range(2, 6):
            put(ws, current, col, None, fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 6, note, font=NOTE_FONT, align=WRAP)
        if label == "卖方应负担税费合计（元）":
            for col in range(2, 6):
                letter = get_column_letter(col)
                ws.cell(row=current, column=col).value = (
                    f"=SUM({letter}{start+1}:{letter}{current-1})"
                )
        if label == "买方应负担税费合计（元）":
            for col in range(2, 6):
                letter = get_column_letter(col)
                ws.cell(row=current, column=col).value = f"={letter}{current+1}"
        if label == "税费正常负担下的含税价（元）":
            for col in range(2, 6):
                letter = get_column_letter(col)
                ws.cell(row=current, column=col).value = (
                    f"={letter}{start}+{letter}{start+5}+{letter}{start+6}"
                )
        if label == "含税单价（元/㎡）":
            for col in range(2, 6):
                letter = get_column_letter(col)
                ws.cell(row=current, column=col).value = (
                    f"=ROUND({letter}{current-1}/$B${start+5},-1)"
                )
        if label == "税费正常负担下的不含税价（元）":
            for col in range(2, 6):
                letter = get_column_letter(col)
                ws.cell(row=current, column=col).value = f"={letter}{current-1}-{letter}{start+1}"
        if label == "不含税单价（元/㎡）":
            for col in range(2, 6):
                letter = get_column_letter(col)
                ws.cell(row=current, column=col).value = (
                    f"=ROUND({letter}{current-1}/$B${start+5},-1)"
                )
    row = start + len(tax_rows)
    for col, width in zip("ABCDEF", (30, 22, 22, 22, 22, 40)):
        ws.column_dimensions[col].width = width


FACTOR_ROWS = [
    ("交易单价（元/㎡）", "交易单价"),
    ("交易情况", "交易情况"),
    ("交易时间", "交易时间"),
    ("区位状况·住宅集聚度", "区位状况"),
    ("区位状况·距商业中心距离", "区位状况"),
    ("区位状况·公交便捷程度", "区位状况"),
    ("区位状况·通达性", "区位状况"),
    ("区位状况·接近性", "区位状况"),
    ("区位状况·景观", "区位状况"),
    ("区位状况·周边环境状况", "区位状况"),
    ("区位状况·面积与配套车位数量比", "区位状况"),
    ("区位状况·公共配套设施", "区位状况"),
    ("区位状况·教育配套设施", "区位状况"),
    ("实物状况·住宅类型", "实物状况"),
    ("实物状况·小区内具体位置", "实物状况"),
    ("实物状况·外观形象", "实物状况"),
    ("实物状况·装修·公共区域", "实物状况"),
    ("实物状况·装修·室内", "实物状况"),
    ("实物状况·面积大小", "实物状况"),
    ("实物状况·配套设备设施", "实物状况"),
    ("实物状况·土地红线内基础设施", "实物状况"),
    ("实物状况·物业管理水平", "实物状况"),
    ("实物状况·是否有学区资格", "实物状况"),
    ("实物状况·成新及维护保养状况", "实物状况"),
    ("实物状况·建筑结构", "实物状况"),
    ("权益状况·租赁权", "权益状况"),
    ("权益状况·抵押权", "权益状况"),
    ("权益状况·土地剩余经济年限", "权益状况"),
    ("权益状况·其他权利限制", "权益状况"),
]


def build_market_method(wb):
    ws = wb.create_sheet("市场法")
    title_block(ws, 16, "市场法",
                "左：比较因素条件说明（文字+档次）；中：条件指数（评估对象=100）；右：修正系数（100/案例指数）。幅度见 references/02 第6-8节。")
    row = 4
    put(ws, row, 1, "一、比较因素条件说明表", fill=HEAD_FILL, font=HEAD_FONT)
    put(ws, row, 9, "二、比较因素条件指数表", fill=HEAD_FILL, font=HEAD_FONT)
    put(ws, row, 14, "三、比较因素修正系数表", fill=HEAD_FILL, font=HEAD_FONT)
    row += 1
    head = ["项目", "评估对象", "可比实例A", "可比实例B", "可比实例C", "备注"]
    for col, value in enumerate(head, start=1):
        put(ws, row, col, value, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    for col, value in enumerate(head, start=8):
        put(ws, row, col, value, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    for col, value in enumerate(["项目", "待估/例A", "待估/例B", "待估/例C", "备注"], start=13):
        put(ws, row, col, value, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    data_start = row + 1
    price_row = data_start
    first_index_row = data_start + 1
    last_index_row = data_start + len(FACTOR_ROWS) - 2
    utm = "='基础信息表'!$B$10"  # 参数与税率区首行：增值税率（处置不动产），见 build_base_info
    for offset, (label, _group) in enumerate(FACTOR_ROWS):
        current = data_start + offset
        put(ws, current, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        for col in range(2, 6):
            put(ws, current, col, None, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
        put(ws, current, 6, None, font=NOTE_FONT, align=WRAP)
        put(ws, current, 8, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        if offset == 0:
            put(ws, current, 9, None, fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0.00")
            for col in range(10, 13):
                letter = get_column_letter(col - 7)
                put(ws, current, col, f"={letter}{current}", fill=FORMULA_FILL, font=BODY_FONT,
                    align=CENTER, fmt="#,##0.00")
        else:
            put(ws, current, 9, 100, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
            for col in range(10, 13):
                put(ws, current, col, 100, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
        put(ws, current, 13, None, font=NOTE_FONT, align=WRAP)
        put(ws, current, 13, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        for col in range(14, 17):
            letter = get_column_letter(col - 10)
            put(ws, current, col, f"=CONCATENATE(100,\"/\",{letter}{current})",
                fill=FORMULA_FILL, font=BODY_FONT, align=CENTER)
        put(ws, current, 17, None, font=NOTE_FONT, align=WRAP)
    last = data_start + len(FACTOR_ROWS) - 1

    row = last + 2
    put(ws, row, 1, "四、比准价格与评估单价", fill=HEAD_FILL, font=HEAD_FONT)
    row += 1
    summary = [
        ("修正系数积", "四位小数；= Π(评估对象指数) / Π(案例指数)"),
        ("比准价格（元/㎡）", "交易单价 × 修正系数积"),
        ("评估单价（元/㎡）", "各比准价格算术平均"),
        ("建筑面积（㎡）", "与汇总表一致（输入区）"),
        ("评估值（元）", "评估单价 × 建筑面积"),
        ("增值税率", "取自「基础信息表」参数与税率区（企业处置不动产）"),
        ("含税单价（元/㎡）", "不含税单价 ×(1+增值税率)"),
        ("增值税（元/㎡）", "含税单价 − 不含税单价"),
        ("单因素修正幅度上限检查", "规范：单项修正不宜超 20%"),
        ("整体修正幅度检查", "规范：共同修正不宜超 30%"),
        ("比价合理区间检查", "规范：最高价/最低价不宜大于 1.2"),
    ]
    first_summary = row
    for index, (label, note) in enumerate(summary):
        current = first_summary + index
        put(ws, current, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        for col in range(2, 6):
            put(ws, current, col, None, fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0.00")
        put(ws, current, 6, note, font=NOTE_FONT, align=WRAP)
    coef_row = first_summary
    price_row_out = first_summary + 1
    unit_row = first_summary + 2
    area_row = first_summary + 3
    value_row = first_summary + 4
    vat_row = first_summary + 5
    incl_row = first_summary + 6
    vat_amount_row = first_summary + 7
    for col in range(2, 6):
        letter = get_column_letter(col)
        ws.cell(row=coef_row, column=col).value = (
            f"=ROUND(PRODUCT($I${first_index_row}:$I${last_index_row})"
            f"/PRODUCT({letter}${first_index_row}:{letter}${last_index_row}),4)"
        )
        ws.cell(row=price_row_out, column=col).value = f"=ROUND({letter}${price_row}*{letter}${coef_row},-1)"
        ws.cell(row=area_row, column=col).value = None
    ws.cell(row=unit_row, column=2).value = f"=ROUND(AVERAGE(B{price_row_out}:E{price_row_out}),-1)"
    ws.cell(row=value_row, column=2).value = f"=ROUND(B{unit_row}*B{area_row},-2)"
    ws.cell(row=vat_row, column=2).value = utm
    ws.cell(row=incl_row, column=2).value = f"=ROUND(B{unit_row}*(1+B{vat_row}),-1)"
    ws.cell(row=vat_amount_row, column=2).value = f"=B{incl_row}-B{unit_row}"
    ws.cell(row=first_summary + 8, column=2).value = (
        f"=IF(MAX(ABS(100-B{first_index_row}:E{last_index_row}))>20,\"需说明\",\"≤20% OK\")"
    )
    ws.cell(row=first_summary + 9, column=2).value = (
        f"=IF(MAX(ABS(1-B{coef_row}:E{coef_row}))>0.3,\"需说明\",\"≤30% OK\")"
    )
    ws.cell(row=first_summary + 10, column=2).value = (
        f"=IF(MAX(B{price_row_out}:E{price_row_out})/MIN(B{price_row_out}:E{price_row_out})>1.2,\"超限\",\"≤1.2 OK\")"
    )
    for col, width in zip("ABCDEFGHIJKLMNOPQ",
                          (28, 22, 22, 22, 22, 22, 3, 28, 20, 20, 20, 20, 28, 16, 16, 16, 16)):
        ws.column_dimensions[col].width = width
    return {"unit_row": unit_row, "value_row": value_row, "incl_row": incl_row, "coef_row": coef_row}


def build_income(wb):
    """收益法表：行结构固定，公式区引用同一行的取值列（C）。"""
    ws = wb.create_sheet("收益法")
    title_block(ws, 7, "收益法", "单位：元/㎡（第9行总价单位为万元）。参数与依据见 references/03、references/05。")
    put(ws, 4, 1, "起始年期（=评估基准日）", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, 4, 2, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER, fmt="yyyy-mm-dd")
    put(ws, 4, 3, "土地终止年限", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, 4, 4, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER, fmt="yyyy-mm-dd")
    put(ws, 4, 5, "建筑终止年限", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, 4, 6, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER, fmt="yyyy-mm-dd")
    put(ws, 4, 7, "孰短原则：终点取土地与建筑终止年限较早者", font=NOTE_FONT, align=WRAP)
    put(ws, 5, 1, "可收益建筑面积（㎡）", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, 5, 2, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
    put(ws, 5, 3, "与「估值结果汇总」一致", font=NOTE_FONT, align=WRAP)

    header_row(ws, 7, ["序号", "测算项目", "取值", "后台费率", "后台公式 / 计算说明", "测算说明", ""])
    data_start = 9  # 第 8 行留给「日租金」（潜在毛收入的输入来源）
    # (序号, 项目, 取值形态 input|formula|text, 费率?, 计算说明, 测算说明)
    lines = [
        ("1.0", "日租金（元/㎡·天）", "input", None, "= 月含税租金 × 12 / 建筑面积 / 365", "租金案例来源须写明"),
        ("1", "年房地产有效毛收入", "formula", None, "1 = 潜在毛收入 − 空置损失 + 其他收入", "按 365 天/年测算"),
        ("1.1", "年房地产潜在毛收入", "formula", None, "= 日租金 × 365", "日租金由租金案例反算"),
        ("1.2", "空置造成的租金损失", "formula", None, "= 空置率 × 潜在毛收入", "空置率依据见基础信息表"),
        ("1.3", "其他收入（押金利息）", "formula", None, "= 保证金 × 一年期存款利率 ×(1 − 空置率)", "保证金 = 日租金 × 押金天数"),
        ("2", "年运营费用", "formula", None, "2 = 2.1 + 2.2 + 2.3 + 2.4 + 2.5 + 2.6 + 2.7", "出租主体决定税率"),
        ("2.1", "增值税及附加", "formula", None, "= 增值税 + 城建税 + 教育附加 + 地方教育附加", "增值税免征则附加免征"),
        ("2.1.1", "增值税", "formula", "rate", "= (有效毛收入 − 其他收入)/(1+税率) × 税率", "企业 9% / 个人出租住房 1.5%"),
        ("2.1.2", "城建税", "formula", "rate", "= 增值税 × 城建税率", "市区 7%"),
        ("2.1.3", "教育附加", "formula", "rate", "= 增值税 × 3%", None),
        ("2.1.4", "地方教育附加", "formula", "rate", "= 增值税 × 2%", "按项目所在地"),
        ("2.2", "管理费", "formula", "rate", "= 有效毛收入 × 费率", "费率依据见基础信息表"),
        ("2.3", "房产税", "formula", "rate", "= (有效毛收入 − 其他收入 − 增值税) × 税率", "企业 12% / 个人出租住房 4%"),
        ("2.4", "城镇土地使用税", "formula", "base", "= 年税额（元/㎡·年）", "按当地地段标准，已含容积率口径"),
        ("2.5", "印花税", "formula", "rate", "= (有效毛收入 − 其他收入 − 增值税) × 1‰", "个人出租住房常免征"),
        ("2.6", "维修费", "formula", "base", "= 建筑重置成本 × 2%", "重置成本来源须写明"),
        ("2.7", "保险费", "formula", "base", "= 建筑重置成本 × 1‰", "与维修费共用同一基数"),
        ("3", "年净收益（A）", "formula", None, "3 = 1 − 2", None),
        ("4", "报酬率（Y）", "input", "rate", "= 安全利率 + 风险调整值（分项写明）；Y 必须大于 g", None),
        ("5", "净收益逐年递增比率（g）", "input", None, "区域租售调查与预测；长期模型 g 宜低于 Y", None),
        ("6", "可获收益年限（n）", "formula", None, "= (min(土地终止, 建筑终止) − 起始)/365", "孰短原则，单位：年"),
        ("7", "租金收益价值（单价）", "formula", None, "= A/(Y−g) ×(1 − ((1+g)/(1+Y))^n)", "取整"),
        ("8", "剩余建筑物价值折现（单价 V′）", "input", None, "有残值填正数，无残值填 0 并写明依据", "钢混无残值填 0"),
        ("9", "收益价值", "formula", None, "单价（V）= 第7行 + 第8行；总价（万元）= ROUND(单价 × 面积/10000, 2)", "单价 + 残值折现"),
    ]
    for offset, (no, label, _kind, _rate, formula, note) in enumerate(lines):
        current = data_start + offset
        put(ws, current, 1, no, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
        put(ws, current, 2, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        put(ws, current, 3, None, fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0.00")
        put(ws, current, 4, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
        put(ws, current, 5, formula, font=NOTE_FONT, align=WRAP)
        put(ws, current, 6, note, font=NOTE_FONT, align=WRAP)

    at = {row[0]: data_start + offset for offset, row in enumerate(lines)}
    d0, r0, r1, r2, r3 = at["1.0"], at["1.1"], at["1"], at["1.2"], at["1.3"]
    a0, a1, a2, a3, a4 = at["2"], at["2.1"], at["2.1.1"], at["2.1.2"], at["2.1.3"]
    a5, a6, a7, a8, a9 = at["2.1.4"], at["2.2"], at["2.3"], at["2.4"], at["2.5"]
    a10, a11 = at["2.6"], at["2.7"]
    n0, n1, n2, n3, n4 = at["3"], at["4"], at["5"], at["6"], at["7"]
    n5, n6 = at["8"], at["9"]

    def set_c(row, formula, fmt="#,##0.00"):
        cell = ws.cell(row=row, column=3)
        cell.value = formula
        cell.fill = FORMULA_FILL
        cell.font = BODY_FONT
        cell.alignment = CENTER
        cell.number_format = fmt

    def make_input(row, fmt="#,##0.00"):
        cell = ws.cell(row=row, column=3)
        cell.value = None
        cell.fill = INPUT_FILL
        cell.font = BODY_FONT
        cell.alignment = CENTER
        cell.number_format = fmt

    make_input(d0)  # 日租金：输入区，唯一入口，潜在毛收入由它派生
    set_c(r0, f"=ROUND(C{d0}*365,2)")
    set_c(r1, f"=ROUND(C{r0}-C{r2}+C{r3},2)")
    set_c(r2, f"=ROUND(D{r0}*C{r0}*365,2)")
    set_c(r3, f"=ROUND(D{d0}*D{d0}*F{d0}*(1-D{d0}),2)")
    set_c(a0, f"=ROUND(SUM(C{a1}:C{a5})+C{a6}+C{a7}+C{a8}+C{a9}+C{a10}+C{a11},2)")
    set_c(a1, f"=SUM(C{a2}:C{a5})")
    set_c(a2, f"=ROUND((C{r1}-C{r3})/(1+D{a2})*D{a2},2)")
    set_c(a3, f"=ROUND($C${a2}*D{a3},2)")
    set_c(a4, f"=ROUND($C${a2}*D{a4},2)")
    set_c(a5, f"=ROUND($C${a2}*D{a5},2)")
    set_c(a6, f"=ROUND(C{r1}*$D${a6},2)")
    set_c(a7, f"=ROUND((C{r1}-C{r3}-C{a2})*D{a7},2)")
    set_c(a8, f"=ROUND(D{a8},2)")
    set_c(a9, f"=ROUND((C{r1}-C{r3}-C{a2})*$D${a9},2)")
    set_c(a10, f"=ROUND(D{a10}*F{a10},2)")
    set_c(a11, f"=ROUND(D{a11}*F{a11},2)")
    set_c(n0, f"=ROUND(C{r1}-C{a0},2)")
    make_input(n1, "0.00%")
    make_input(n2, "0.00%")
    set_c(n3, "=ROUND((MIN($E$4,$G$4)-$C$4)/365,2)")
    set_c(n4, f"=ROUND(C{n0}/(C{n1}-C{n2})*(1-((1+C{n2})/(1+C{n1}))^C{n3}),0)")
    make_input(n5)
    set_c(n6, f"=C{n4}+C{n5}")
    # 总价（万元）与 Y>g 检查
    total_row = n6 + 1
    put(ws, total_row, 2, "收益价值总价（万元）", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, total_row, 3, f"=ROUND(C{n6}*$C$5/10000,2)", fill=FORMULA_FILL, font=BODY_FONT,
        align=CENTER, fmt="#,##0.00")
    put(ws, total_row, 5, "= ROUND(单价 × 可收益建筑面积 / 10000, 2)", font=NOTE_FONT, align=WRAP)
    put(ws, total_row, 6, "与「估值结果汇总」一致", font=NOTE_FONT, align=WRAP)
    check_row = total_row + 1
    put(ws, check_row, 2, "勾稽：Y > g", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, check_row, 3, f'=IF(C{n1}>C{n2},"OK","不成立：该公式失效，须改装模型")',
        fill=CHECK_FILL, font=BODY_FONT, align=WRAP)
    put(ws, check_row, 5, "Y ≤ g 时等比递增年金公式不成立", font=NOTE_FONT, align=WRAP)
    check_row2 = check_row + 1
    put(ws, check_row2, 2, "勾稽：收益年限 ≥ 1", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, check_row2, 3, f'=IF(C{n3}>=1,"OK","过短：须核对终止年限")',
        fill=CHECK_FILL, font=BODY_FONT, align=WRAP)
    put(ws, check_row2, 5, "起点 = 评估基准日", font=NOTE_FONT, align=WRAP)

    for col, width in zip("ABCDEFG", (8, 30, 16, 16, 52, 40, 4)):
        ws.column_dimensions[col].width = width
    return {"unit_row": n4, "value_row": n6, "total_row": total_row}



def build_cost_method(wb):
    """成本法表：积算路径，最后乘建筑面积得评估值（单位：元/㎡）。"""
    ws = wb.create_sheet("成本法")
    title_block(ws, 6, "成本法", "单位：元/㎡，最后乘建筑面积得评估值；口径见 references/07。")
    put(ws, 4, 1, "建筑面积（㎡）", fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
    put(ws, 4, 2, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0.00")
    put(ws, 4, 3, "与「估值结果汇总」一致", font=NOTE_FONT, align=WRAP)

    header_row(ws, 6, ["序号", "测算项目", "取值", "取值说明 / 公式", "测算说明", ""])
    data_start = 7
    lines = [
        ("1", "建筑重置成本单价（元/㎡）", "input", "= 基础信息表「建筑重置成本」或分项构成（建安造价 × 综合费率）", "更新重置成本，不含土地"),
        ("2", "已使用年限（年）", "input", "= 竣工/建成至基准日", None),
        ("3", "经济耐用年限（年）", "input", "= 按结构取（见 references/07 第5节）", "钢60-80 / 钢混50-60 / 砖混40-50 / 砖木30-40"),
        ("4", "尚可使用年限（年）", "input", "默认 = 经济耐用年限 − 已使用年限，结合现场勘察调整", "不得简单相减而不勘察"),
        ("5", "成新率", "formula", "= ROUND(尚可使用年限 / 经济耐用年限, 4)", "0 < 成新率 ≤ 100%"),
        ("6", "建筑物评估单价（元/㎡）", "formula", "= ROUND(建筑重置成本单价 × 成新率, -1)", None),
        ("7", "土地单价（元/㎡）", "input", "= 成本逼近法 / 基准地价系数修正法 / 市场法", "与建筑物同一基准日与内涵"),
        ("8", "房地产积算单价（元/㎡）", "formula", "= ROUND(建筑物评估单价 + 土地单价, -1)", None),
        ("9", "房地产评估值（元）", "formula", "= ROUND(房地产积算单价 × 建筑面积, -2)", None),
    ]
    for offset, (no, label, kind, formula, note) in enumerate(lines):
        current = data_start + offset
        put(ws, current, 1, no, fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
        put(ws, current, 2, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        fill = INPUT_FILL if kind == "input" else FORMULA_FILL
        put(ws, current, 3, None, fill=fill, font=BODY_FONT, align=CENTER, fmt="#,##0.00")
        put(ws, current, 4, formula, font=NOTE_FONT, align=WRAP)
        put(ws, current, 5, note, font=NOTE_FONT, align=WRAP)
        put(ws, current, 6, None, font=NOTE_FONT, align=WRAP)

    def set_formula(row, value, fmt="#,##0.00"):
        cell = ws.cell(row=row, column=3)
        cell.value = value
        cell.fill = FORMULA_FILL
        cell.font = BODY_FONT
        cell.alignment = CENTER
        cell.number_format = fmt

    r1, r2, r3, r4, r5 = data_start, data_start + 1, data_start + 2, data_start + 3, data_start + 4
    r6, r7, r8, r9 = data_start + 5, data_start + 6, data_start + 7, data_start + 8
    set_formula(r5, f"=ROUND(C{r4}/C{r3},4)", "0.00%")
    set_formula(r6, f"=ROUND(C{r1}*C{r5},-1)")
    set_formula(r8, f"=ROUND(C{r6}+C{r7},-1)")
    set_formula(r9, f"=ROUND(C{r8}*$B$4,-2)")

    check = r9 + 2
    checks = [
        ("重置成本 > 0", f'=IF(C{r1}>0,"OK","须填写重置成本")'),
        ("成新率区间 0–100%", f'=IF(AND(C{r5}>0,C{r5}<=1),"OK","超限：须说明")'),
        ("土地单价 ≥ 0", f'=IF(C{r7}>=0,"OK","须核对")'),
    ]
    for offset, (label, formula) in enumerate(checks):
        current = check + offset
        put(ws, current, 1, "勾稽", fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
        put(ws, current, 2, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        put(ws, current, 3, formula, fill=CHECK_FILL, font=BODY_FONT, align=WRAP)
        put(ws, current, 5, "见 references/07 第7节", font=NOTE_FONT, align=WRAP)

    for col, width in zip("ABCDEF", (8, 30, 18, 48, 44, 4)):
        ws.column_dimensions[col].width = width
    return {"unit_row": r8, "value_row": r9}


def build_result(wb, income_rows, market_rows, cost_rows):
    ws = wb.create_sheet("估值结果汇总")
    title_block(ws, 16, "估值结果汇总", "投资性房地产-房屋公允模式口径；序号唯一，合计行必须为公式。")
    header_row(ws, 4, [
        "序号", "权证编号", "房屋名称", "坐落", "权证用途", "建筑面积(㎡)",
        "收益法单价", "市场法单价", "成本法单价", "采用的方法", "采用单价(元/㎡)",
        "评估价值(元)", "账面价值(元)", "增减值(元)", "增值率%", "备注",
    ])
    first = 5
    last = first + 9
    unit_ref = f"'收益法'!C{income_rows['unit_row']}"
    market_ref = f"'市场法'!B{market_rows['unit_row']}"
    cost_ref = f"'成本法'!C{cost_rows['unit_row']}"
    for offset in range(10):
        current = first + offset
        put(ws, current, 1, offset + 1 if offset < 3 else None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
        for col in range(2, 7):
            put(ws, current, col, None, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
        put(ws, current, 7, f"={unit_ref}" if offset == 0 else None,
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 8, f"={market_ref}" if offset == 0 else None,
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 9, f"={cost_ref}" if offset == 0 else None,
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 10, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER)
        put(ws, current, 11,
            f'=IF(ISNUMBER(SEARCH("收益法",J{current})),G{current},'
            f'IF(ISNUMBER(SEARCH("市场法",J{current})),H{current},'
            f'IF(ISNUMBER(SEARCH("成本法",J{current})),I{current},"")))',
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 12, f'=IF(K{current}="","",ROUND(K{current}*F{current},0))',
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 13, None, fill=INPUT_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 14, f'=IF(OR(L{current}="",M{current}=""),"",L{current}-M{current})',
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0")
        put(ws, current, 15, f'=IFERROR(N{current}/ABS(M{current})*100,"")',
            fill=FORMULA_FILL, font=BODY_FONT, align=CENTER, fmt="#,##0.00")
        put(ws, current, 16, None, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
    total = last + 1
    put(ws, total, 1, "合计", fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    for col in range(2, 7):
        put(ws, total, col, None, fill=HEAD_FILL)
    for col in (6, 12, 13, 14):
        letter = get_column_letter(col)
        put(ws, total, col, f"=SUM({letter}{first}:{letter}{last})", fill=FORMULA_FILL,
            font=HEAD_FONT, align=CENTER, fmt="#,##0.00")
    put(ws, total, 15, f'=IFERROR(N{total}/ABS(M{total})*100,"")', fill=FORMULA_FILL,
        font=HEAD_FONT, align=CENTER, fmt="#,##0.00")
    for col in (7, 8, 9, 10, 11, 16):
        put(ws, total, col, None, fill=HEAD_FILL)
    check = total + 2
    checks = [
        ("序号唯一性", f'=IF(SUMPRODUCT(--((A{first}:A{last}<>"")/COUNTIF(A{first}:A{last},A{first}:A{last}&"")))'
                    f'=COUNTA(A{first}:A{last}),"唯一 OK","序号重复")'),
        ("汇总面积 = SUM 明细", f'=IF(F{total}=SUM(F{first}:F{last}),"一致 OK","需核对")'),
        ("采用单价非空", f'=IF(COUNT(K{first}:K{last})=COUNTA(A{first}:A{last}),"已填 OK","有未填行")'),
        ("评估价值与单价×面积尾差", f'=IF(ABS(L{total}-SUM(ROUND(K{first}:K{last}*F{first}:F{last},0)))<1,"尾差 OK","需核对")'),
    ]
    put(ws, check, 1, "勾稽检查", fill=HEAD_FILL, font=HEAD_FONT)
    put(ws, check, 2, "检查项", fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    put(ws, check, 3, "结果", fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    put(ws, check, 4, "说明", fill=HEAD_FILL, font=HEAD_FONT, align=CENTER)
    for offset, (label, formula) in enumerate(checks):
        current = check + 1 + offset
        put(ws, current, 2, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        put(ws, current, 3, formula, fill=CHECK_FILL, font=BODY_FONT, align=WRAP)
        put(ws, current, 4, "见 references/06 第4节", font=NOTE_FONT, align=WRAP)
    # 三、汇总依据与限制（§8「计算表填写」里点名要有、而前面各表放不下的三项）
    #
    # 为什么单独起一段：权重/汇总依据是"最终单价怎么来的"（几个方法之间怎么取舍、
    # 案例之间怎么加权），已知限制与待确认事项是"这份底稿到什么程度为止"。
    # 前两表只有逐案例的字段，放不下"整体怎么汇总"与"整体有什么没定"。
    notes = check + len(checks) + 2
    put(ws, notes, 1, "三、汇总依据与限制", fill=HEAD_FILL, font=HEAD_FONT)
    header_row(ws, notes + 1, ["项目", "内容", "依据 / 来源"])
    limits = [
        ("权重 / 汇总依据", "多方法或多案例如何汇总到最终采用单价（权重、取舍规则），须可复核"),
        ("已知限制", "资料、口径、能力上的限制（例如没有重算能力、案例数量不足）"),
        ("待确认事项", "与「估值结果.json」的 manual_confirmation_items 一致，逐条一行"),
    ]
    for offset, (label, hint) in enumerate(limits):
        current = notes + 2 + offset
        put(ws, current, 1, label, fill=HEAD_FILL, font=HEAD_FONT, align=WRAP)
        put(ws, current, 2, None, fill=INPUT_FILL, font=BODY_FONT, align=WRAP)
        put(ws, current, 3, hint, font=NOTE_FONT, align=WRAP)

    for col, width in zip("ABCDEFGHIJKLMNOP",
                          (6, 22, 20, 26, 12, 14, 14, 14, 14, 16, 16, 16, 16, 14, 12, 26)):
        ws.column_dimensions[col].width = width



def main():
    wb = Workbook()
    wb.remove(wb.active)
    build_base_info(wb)
    build_case(wb)
    build_normalization(wb)
    market_rows = build_market_method(wb)
    income_rows = build_income(wb)
    cost_rows = build_cost_method(wb)
    build_result(wb, income_rows, market_rows, cost_rows)
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "template")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "valuation-workbook.xlsx")
    wb.save(out)
    print(f"wrote {out}")
    print("sheets:", wb.sheetnames)
    print("market rows:", market_rows)
    print("income rows:", income_rows)
    print("cost rows:", cost_rows)


if __name__ == "__main__":
    main()
