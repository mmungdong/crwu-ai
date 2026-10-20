#!/usr/bin/env python3
"""把「估值报告数据.json」渲染成**人读的 HTML 报告**（固定模板 + 受约束数据）。

    python3 scripts/build_report.py --data <估值报告数据.json> --out <估值报告.html> \
        [--case-root <案例目录>] [--template …] [--force]

## 三条硬约束

1. **模型不写 HTML**：页面只能由 `估值报告数据.json` + `template/valuation-report.html`
   渲染；数据没通过 Schema 校验就直接失败，不产半成品。
2. **渲染器不做第二套算术**：金额 / 单价 / 面积按报告数据里的十进制字符串**逐字**呈现，
   不取整、不加千分位；单位与金额格式只在 `amount()` 一处生成。
3. **图片是证据，不是装饰**：采用案例的缩略图来自 `screenshots[].relativePath`，
   `completed` 报告里任何一条图片证据路径越界、文件不存在或指纹不符，都**拒绝渲染**
   （返回问题，不静默跳过）。通过校验的图片在渲染阶段读成 data URI 内嵌，单个 HTML
   转发不丢图；原始相对路径与指纹仍写在页面上可查。

## 状态控制展示

`completed` 显示正式结论；`partial` 只显示"暂算 / 未定稿"，不给正式结论；`blocked` 报告
没有金额、没有方法也能渲染，如实列出缺什么、查过哪、为什么、怎么补；`failed` / `cancelled`
只列阶段与已有文件，不写成"已估值完成"。唯一输入是 `build_report_data.py` 产出的
`估值报告数据.json`（report-data.v2）。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
import sys
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from build_report_data import validate_report_data  # noqa: E402

SKILL_DIR = os.path.dirname(HERE)
DEFAULT_TEMPLATE = os.path.join(SKILL_DIR, "template", "valuation-report.html")

UNKNOWN = "—"
# Closed verified-workflow snapshot ref format; only real identity/path/library/digest exist.
WORKFLOW_KNOWLEDGE_REF_FORMAT = "crwu.valuation.knowledge-ref.v1"
IMAGE_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
              "webp": "image/webp", "gif": "image/gif"}

METHOD_LABELS = {"market": "市场法", "income": "收益法", "cost": "成本法", None: "未判定"}
METHOD_REQUEST_LABELS = {"auto": "自动判定", "market": "市场法", "income": "收益法", "cost": "成本法"}
VALUE_SCOPE_LABELS = {"land-only": "仅土地", "building-only": "仅建筑物",
                      "land-and-building": "房地合一（含土地权益）"}
PROPERTY_TYPE_LABELS = {"residential": "住宅", "commercial": "商业", "office": "办公",
                        "industrial": "工业", "other": "其他"}
STAGE_LABELS = {
    "intake": "资料接收", "extract": "资料提取", "grouping": "对象识别与方案分组",
    "knowledge": "知识获取", "method-selection": "方法判定", "retrieval": "案例取数",
    "parameters": "参数取值", "template": "计算表模板", "calculation": "计算",
    "delivery": "交付",
}
BLOCKER_KIND_LABELS = {
    "input-invalid": "输入不合法", "property-unsupported": "物业类型未支持",
    "method-unsupported": "方法未支持", "valuation-path-unsupported": "评估路径未支持",
    "valuation-path-unresolved": "评估路径待确认", "capability-missing": "能力缺失",
    "knowledge-missing": "知识缺失", "template-missing": "模板缺失",
    "evidence-missing": "证据缺失", "recalculation-unavailable": "重算能力缺失",
}
RETRIEVAL_OUTCOME_LABELS = {
    "ok": "成功", "blocked": "被阻断", "challenge-recovered": "验证恢复后成功",
    "waiting-user": "等待人工完成验证", "unsupported": "不支持", "failed": "失败",
}
LOOKUP_CHANNEL_LABELS = {"exact-route": "精确路径", "same-name": "同目录同名", "alias": "别名",
                         "mirror": "已验证镜像", "dws-tree": "目录树"}
LOOKUP_OUTCOME_LABELS = {
    "found": "命中", "missing": "缺失", "empty": "空文档", "ambiguous": "多命中（不选第一份）",
    "unreadable": "不可读", "rejected-identity": "身份不符，拒绝", "rejected-digest": "指纹不符，拒绝",
}
PARAMETER_STATE_LABELS = {"provided": "已取值", "missing": "缺失", "not-applicable": "不适用"}
ARTIFACT_KIND_LABELS = {"html": "报告 HTML", "workbook": "计算表", "data": "数据 JSON",
                        "screenshot": "截图"}
VALIDITY_LABELS = {"valid": "有效", "missing": "缺失", "invalid": "无效",
                   "not-required": "规则未要求截图"}


class ReportRenderError(ValueError):
    """渲染失败：`problems` 是逐条问题（例如图片证据不成立）。"""

    def __init__(self, message: str, problems: list | None = None) -> None:
        super().__init__(message)
        self.problems = list(problems or [])


# ---------------------------------------------------------------------------
# 一处生成的文本格式（金额只在这里排版）
# ---------------------------------------------------------------------------

def esc(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def amount(value: object) -> str:
    """金额 / 单价 / 面积逐字呈现：不取整、不加千分位、缺失写 `—`。"""
    if value is None:
        return UNKNOWN
    text = str(value).strip()
    return esc(text) if text != "" else UNKNOWN


def text_of(value: object) -> str:
    text = "" if value is None else str(value).strip()
    return esc(text) if text != "" else UNKNOWN


def label_of(table: dict, key: object) -> str:
    if key is None:
        return esc(str(table.get(None, UNKNOWN)))
    return esc(str(table.get(str(key), key)))


def mono(value: object) -> str:
    return f'<span class="mono">{esc(value)}</span>'


def yes_no(value: object) -> str:
    return '<span class="ok-text">是</span>' if value else '<span class="bad-text">否</span>'


def passed_text(value: object) -> str:
    return '<span class="ok-text">通过</span>' if value else '<span class="bad-text">未通过</span>'


def link_or_text(url: object, label: object) -> str:
    """只把 http/https 渲染成可点链接；`javascript:` 之类不给可点入口。"""
    raw = "" if url is None else str(url).strip()
    shown = esc("" if label is None else str(label))
    if raw.startswith(("http://", "https://")):
        return f'<a href="{esc(raw)}" rel="noreferrer noopener">{shown}</a>'
    return shown


def local_evidence_link(relative: object, case_root: str = "", output_dir: str = "") -> str:
    """Clickable relative link to a local evidence image; percent-encoded, never absolute."""
    raw = "" if relative is None else str(relative).strip()
    if raw == "":
        return UNKNOWN
    if os.path.isabs(raw) or re.match(r"^[A-Za-z]:", raw):
        return esc(raw)
    # The raw case-relative path must never traverse upward; computed hrefs may still contain
    # legitimate '..' segments derived from a validated target and the HTML output parent.
    if ".." in [segment for segment in raw.replace("\\", "/").split("/") if segment not in ("", ".")]:
        return esc(raw)
    href = raw
    if case_root and output_dir:
        # Resolve from the actual output directory so nested CLI output stays clickable.
        try:
            target = os.path.normpath(os.path.join(os.path.abspath(case_root), raw))
            href = os.path.relpath(target, output_dir).replace(os.sep, "/")
        except ValueError:
            return esc(raw)
    return f'<a href="{esc(quote(href, safe="/"))}" rel="noreferrer noopener">{esc(raw)}</a>'


def knowledge_ref_text(ref: object) -> str:
    if not isinstance(ref, dict) or not ref:
        return UNKNOWN
    parts = [str(ref.get("routeId", UNKNOWN)), str(ref.get("snapshotDigest", UNKNOWN))]
    for key in ("sectionId", "ruleId"):
        if ref.get(key):
            parts.append(str(ref[key]))
    return esc("@".join(parts))


def knowledge_refs_text(refs: object) -> str:
    if not isinstance(refs, list) or not refs:
        return UNKNOWN
    return "<br>".join(knowledge_ref_text(ref) for ref in refs)


def items_html(values: object, empty: str = "") -> str:
    rows = [item for item in values if str(item).strip() != ""] if isinstance(values, list) else []
    if not rows:
        return f'<li class="muted">{esc(empty)}</li>' if empty else ""
    return "".join(f"<li>{esc(item)}</li>" for item in rows)


def row(cells: list) -> str:
    return "<tr>" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"


# ---------------------------------------------------------------------------
# 图片证据：路径 / 指纹 / 命名校验 + data URI 内嵌
# ---------------------------------------------------------------------------

def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _digest_matches(recorded: object, actual: str) -> bool:
    left = str(recorded or "").strip().lower()
    right = actual.strip().lower()
    for prefix in ("sha256:", "sha256-"):
        if left.startswith(prefix):
            left = left[len(prefix):]
        if right.startswith(prefix):
            right = right[len(prefix):]
    return left != "" and left == right


def resolve_screenshot(shot: object, case_root: str) -> dict:
    """校验一条截图证据。返回 {available, src, reason, problem, location}。

    - `problem` 非空 = 这条证据不成立（completed 报告必须拒绝渲染）。
    - 路径越界 / 符号链接逃逸时**不读取**目标文件。
    """
    invalid = {"available": False, "src": "", "reason": "", "problem": "", "location": ""}
    if not isinstance(shot, dict):
        return {**invalid, "problem": "截图证据必须是对象", "reason": "证据格式不对"}
    relative = str(shot.get("relativePath") or "").strip()
    digest = str(shot.get("digest") or "").strip()
    validity = str(shot.get("validity") or "")
    case_id = str(shot.get("caseId") or "").strip()
    location = f"{relative or '(空路径)'}｜{digest or '(空指纹)'}"

    if validity == "not-required":
        return {**invalid, "reason": "规则未要求截图", "location": location}
    if relative == "":
        return {**invalid, "problem": "evidence.relativePath 为空", "reason": "截图路径为空",
                "location": location}
    if os.path.isabs(relative) or re.match(r"^[A-Za-z]:", relative):
        return {**invalid, "problem": f"{relative}: 必须是案例目录内的相对路径",
                "reason": "绝对路径已拒绝", "location": location}
    if not case_root:
        return {**invalid, "problem": f"{relative}: 没有给出案例目录，无法校验图片",
                "reason": "缺少案例目录", "location": location}

    root = os.path.abspath(case_root)
    target = os.path.normpath(os.path.join(root, relative))
    if target != root and not target.startswith(root + os.sep):
        return {**invalid, "problem": f"{relative}: 路径越界（必须落在案例目录内）",
                "reason": "路径越界已拒绝读取", "location": location}
    real_root = os.path.realpath(root)
    real_target = os.path.realpath(target)
    if real_target != real_root and not real_target.startswith(real_root + os.sep):
        return {**invalid, "problem": f"{relative}: 符号链接逃逸（真实路径在案例目录之外）",
                "reason": "符号链接逃逸已拒绝读取", "location": location}
    if validity != "valid":
        return {**invalid, "problem": f"{relative}: validity={validity or '(空)'}，不是 valid",
                "reason": f"截图状态：{VALIDITY_LABELS.get(validity, validity or '未知')}",
                "location": location}
    if not os.path.isfile(real_target):
        return {**invalid, "problem": f"{relative}: 截图文件不存在",
                "reason": "截图文件不存在", "location": location}
    try:
        actual = _sha256_file(real_target)
    except OSError as error:
        return {**invalid, "problem": f"{relative}: 读不到截图（{error}）",
                "reason": "截图不可读", "location": location}
    if not _digest_matches(digest, actual):
        return {**invalid, "problem": f"{relative}: digest 不符（记录 {digest or '(空)'}，实际 {actual}）",
                "reason": f"指纹不符（记录 {digest or '(空)'}，实际 {actual}）", "location": location}

    parent = os.path.basename(os.path.dirname(target))
    if case_id == "" or not (parent == case_id or parent.startswith(case_id + "-")):
        return {**invalid,
                "problem": f"{relative}: 目录名 {parent!r} 与 caseId {case_id!r} 不一致"
                           "（证据目录必须是 <caseId-名称>）",
                "reason": f"目录名与 caseId 不一致（{parent} / {case_id or '(空)'}）",
                "location": location}

    extension = os.path.splitext(real_target)[1].lower().lstrip(".")
    mime = IMAGE_MIME.get(extension)
    if mime is None:
        return {**invalid, "problem": f"{relative}: 不支持的图片扩展名 .{extension}",
                "reason": f"不支持的图片格式 .{extension}", "location": location}
    try:
        with open(real_target, "rb") as handle:
            payload = handle.read()
    except OSError as error:
        return {**invalid, "problem": f"{relative}: 读不到截图（{error}）",
                "reason": "截图不可读", "location": location}
    return {"available": True, "src": f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}",
            "reason": "", "problem": "", "location": location}


def _screenshot_entries(data: dict) -> list:
    """页面要展示的全部截图证据：`[(key, shot)]`，key 与页面上取用的位置一一对应。

    key 形如 `("evidence", i)` 或 `("comparable", i, j)`；顶层 evidence 与每条候选案例的
    screenshots 都要走同一套路径 / 指纹校验。
    """
    entries = []
    for index, item in enumerate(data.get("evidence") or []):
        entries.append((("evidence", index), item))
    for index, comparable in enumerate(data.get("comparables") or []):
        if not isinstance(comparable, dict):
            continue
        for shot_index, item in enumerate(comparable.get("screenshots") or []):
            entries.append((("comparable", index, shot_index), item))
    return entries


def _thumbnail(shot: dict, resolved: dict, caption: str) -> str:
    if resolved.get("available"):
        return (
            f'<button type="button" class="thumb" data-preview-source '
            f'data-preview-caption="{esc(caption)}" aria-label="查看原图：{esc(caption)}">'
            f'<img src="{esc(resolved["src"])}" alt="{esc(caption)}" loading="lazy" '
            f'data-relative-path="{esc(shot.get("relativePath"))}" '
            f'data-digest="{esc(shot.get("digest"))}"></button>'
        )
    reason = resolved.get("reason") or "不可用"
    return (f'<span class="thumb-missing">图片未内嵌：{esc(reason)}<br>'
            f'{esc(resolved.get("location"))}</span>')


# ---------------------------------------------------------------------------
# 各节片段（文案在模板里，这里只排版数据）
# ---------------------------------------------------------------------------

def _conclusion_rows(data: dict) -> str:
    names = {item.get("objectId"): item.get("displayName")
             for item in data.get("objects") or [] if isinstance(item, dict)}
    rows = []
    for item in data.get("conclusions") or []:
        display = item.get("displayName") or names.get(item.get("objectId")) or ""
        rows.append(row([
            f'{esc(item.get("objectId"))}<br><span class="muted">{esc(display)}</span>',
            label_of(VALUE_SCOPE_LABELS, item.get("valueScope")),
            label_of(METHOD_LABELS, item.get("method")),
            amount(item.get("unitPrice")),
            amount(item.get("totalValue")),
            text_of(item.get("currency")),
            knowledge_refs_text(item.get("basisRefs")),
            text_of(item.get("calculationRef")),
        ]))
    return "".join(rows)


def _object_result_rows(items: object) -> str:
    rows = []
    for item in items if isinstance(items, list) else []:
        rows.append(row([
            f'{esc(item.get("objectId"))}<br><span class="muted">{esc(item.get("displayName") or "")}</span>',
            label_of(VALUE_SCOPE_LABELS, item.get("valueScope")),
            label_of(METHOD_LABELS, item.get("method")),
            amount(item.get("unitPrice")),
            amount(item.get("totalValue")),
            text_of(item.get("currency")),
            text_of(item.get("calculationRef")),
        ]))
    return "".join(rows)


def _material_rows(data: dict) -> str:
    rows = []
    for item in data.get("materials") or []:
        rows.append(row([
            mono(item.get("fileId")),
            text_of(item.get("fileName")),
            text_of(item.get("archiveRelativePath")),
            text_of(item.get("kind")),
            text_of(item.get("sizeBytes")),
            mono(item.get("sha256")),
            text_of(item.get("createdAt")),
            text_of(item.get("modifiedAt")),
            yes_no(item.get("readable")),
            text_of(item.get("duplicateOf")),
        ]))
    return "".join(rows)


def _method_result_rows(data: dict) -> str:
    """逐方法结果表（协议 39）：每个实际采用的方法各自的依据 / 单价 / 总价 / 模板。

    多方法时这张表就是"每个方法分别记录"的落点 —— 报告读者据此看到每个方法的结论，
    而不是只看到一个合成后的数（那会让人以为多方法被加权或相加了）。
    """
    rows = []
    for item in data.get("methodResults") or []:
        if not isinstance(item, dict):
            continue
        rows.append(row([
            label_of(METHOD_LABELS, item.get("method")),
            amount(item.get("unitPrice")),
            amount(item.get("totalValue")),
            text_of(item.get("basis")),
            mono(item.get("template")),
        ]))
    return "".join(rows)


def _assessment_rows(data: dict) -> str:
    assessment = data.get("methodAssessment")
    rows = []
    for item in (assessment or {}).get("assessments") or []:
        rows.append(row([
            label_of(METHOD_LABELS, item.get("method")),
            yes_no(item.get("applicable")),
            yes_no(item.get("implemented")),
            yes_no(item.get("selected")),
            text_of(item.get("reason")),
            knowledge_refs_text(item.get("ruleRefs")),
            text_of("；".join(item.get("conflicts") or [])),
        ]))
    return "".join(rows)


def _workflow_knowledge_row(item: dict) -> str:
    """Verified-workflow snapshot ref: real sourceId / path / library / digest only.

    The legacy table headers describe a full materialized manifest, so this ref is shown
    as one labelled row that names the actual fields instead of mislabelling them.
    """
    parts = [f'来源 {mono(item.get("sourceId"))}', f'路径 {text_of(item.get("path"))}']
    if str(item.get("spaceName") or "").strip() != "":
        parts.append(f'知识库 {text_of(item.get("spaceName"))}')
    parts.append(f'正文指纹 {mono(item.get("digest"))}')
    for label, key in (("节", "section"), ("原文", "quote")):
        if str(item.get(key) or "").strip() != "":
            parts.append(f'{label} {text_of(item.get(key))}')
    return ('<tr><td colspan="10" class="muted">workflow 核验快照：'
            + "｜".join(parts) + "</td></tr>")


def _knowledge_rows(data: dict) -> str:
    rows = []
    for item in data.get("knowledgeSources") or []:
        if isinstance(item, dict) and \
                str(item.get("format") or "") == WORKFLOW_KNOWLEDGE_REF_FORMAT:
            rows.append(_workflow_knowledge_row(item))
            continue
        rows.append(row([
            mono(item.get("routeId")),
            text_of(item.get("nodeName")),
            text_of(item.get("resolvedPath")),
            text_of(item.get("source")),
            text_of(item.get("spaceName")),
            text_of(item.get("updatedAt")),
            mono(item.get("digest")),
            text_of(item.get("snapshotFile")),
            text_of("、".join(item.get("sectionIds") or [])),
            text_of("、".join(item.get("ruleIds") or [])),
        ]))
    return "".join(rows)


def _retrieval_rows(data: dict) -> str:
    rows = []
    for item in data.get("retrievalAttempts") or []:
        rows.append(row([
            mono(item.get("taskId")),
            mono(item.get("caseId")),
            text_of(item.get("providerId")),
            text_of(item.get("stage")),
            label_of(RETRIEVAL_OUTCOME_LABELS, item.get("outcome")),
            link_or_text(item.get("finalUrl"), item.get("finalUrl")),
            text_of(item.get("reasonCode")),
            text_of(item.get("recoveryStrategy")),
            text_of(item.get("recoveryAttempts")),
        ]))
    return "".join(rows)


def _lookup_rows(data: dict) -> str:
    rows = []
    for item in data.get("lookupAttempts") or []:
        rows.append(row([
            mono(item.get("routeId")),
            label_of(LOOKUP_CHANNEL_LABELS, item.get("channel")),
            text_of(item.get("target")),
            label_of(LOOKUP_OUTCOME_LABELS, item.get("outcome")),
            text_of(item.get("detail")),
        ]))
    return "".join(rows)


def _comparable_rows(data: dict, resolved: dict, case_root: str = "", output_dir: str = "") -> str:
    rows = []
    for index, item in enumerate(data.get("comparables") or []):
        shots = []
        for shot_index, shot in enumerate(item.get("screenshots") or []):
            outcome = resolved.get(("comparable", index, shot_index), {})
            caption = (f'{item.get("caseId")} · {shot.get("provider") or ""} · '
                       f'{shot.get("capturedAt") or ""}')
            source = shot.get("sourceUrl")
            local = (local_evidence_link(shot.get("relativePath"), case_root, output_dir)
                     if outcome.get("available") is True
                     else f'<span class="muted">{esc(outcome.get("location") or shot.get("relativePath") or "")}</span>')
            shots.append(
                _thumbnail(shot, outcome, caption)
                + (f'<div class="muted">截图页 URL：{link_or_text(source, source)}</div>' if source else "")
                + f'<div class="muted">本地图片：{local}</div>'
            )
        rows.append(row([
            mono(item.get("caseId")),
            link_or_text(item.get("sourceUrl"), item.get("sourceUrl")),
            text_of(item.get("provider")),
            text_of(item.get("transactionType")),
            text_of(item.get("publishedAt")),
            amount(item.get("unitPrice")),
            amount(item.get("buildingArea")),
            yes_no(item.get("used")),
            text_of(item.get("keepReason")),
            text_of(item.get("dropReason")),
            "".join(shots) if shots else '<span class="muted">没有登记截图</span>',
        ]))
    return "".join(rows)


def _evidence_rows(data: dict, resolved: dict, case_root: str = "", output_dir: str = "") -> str:
    rows = []
    for index, item in enumerate(data.get("evidence") or []):
        outcome = resolved.get(("evidence", index), {})
        caption = f'{item.get("caseId")} · {item.get("provider") or ""} · {item.get("capturedAt") or ""}'
        local = (local_evidence_link(item.get("relativePath"), case_root, output_dir)
                 if outcome.get("available") is True
                 else f'<span class="muted">{esc(outcome.get("location") or item.get("relativePath") or "")}</span>')
        rows.append(row([
            mono(item.get("caseId")),
            text_of(item.get("displayName")),
            text_of(item.get("provider")),
            link_or_text(item.get("sourceUrl"), item.get("sourceUrl")),
            text_of(item.get("capturedAt")),
            label_of(VALIDITY_LABELS, item.get("validity")),
            local,
            mono(item.get("digest")),
            _thumbnail(item, outcome, caption),
        ]))
    return "".join(rows)


def _parameter_rows(data: dict) -> str:
    rows = []
    for item in data.get("parameters") or []:
        rows.append(row([
            mono(item.get("parameterId")),
            text_of(item.get("label")),
            amount(item.get("value")),
            text_of(item.get("unit")),
            text_of(item.get("valueDate")),
            text_of(item.get("region")),
            text_of(item.get("sourceRef")),
            knowledge_ref_text(item.get("ruleRef")),
            label_of(PARAMETER_STATE_LABELS, item.get("state")),
        ]))
    return "".join(rows)


def _calculation_rows(data: dict) -> str:
    rows = []
    for item in data.get("calculationSteps") or []:
        operands = []
        for operand in item.get("operands") or []:
            operands.append(
                f'{esc(operand.get("name"))} = {amount(operand.get("value"))} '
                f'{text_of(operand.get("unit"))}｜{text_of(operand.get("provenance"))}')
        rows.append(row([
            mono(item.get("stepId")),
            mono(item.get("formulaId")),
            text_of(item.get("label")),
            text_of(item.get("expression")),
            "<br>".join(operands) if operands else UNKNOWN,
            amount(item.get("value")),
            text_of(item.get("unit")),
            knowledge_ref_text(item.get("ruleRef")),
        ]))
    return "".join(rows)


def _rule_check_rows(data: dict) -> str:
    rows = []
    for item in data.get("ruleChecks") or []:
        rows.append(row([
            mono(item.get("ruleId")),
            text_of(item.get("label")),
            passed_text(item.get("passed")),
            text_of(item.get("detail")),
            knowledge_ref_text(item.get("ruleRef")),
        ]))
    return "".join(rows)


def _blocker_rows(data: dict) -> str:
    rows = []
    for item in data.get("blockers") or []:
        rows.append(row([
            label_of(BLOCKER_KIND_LABELS, item.get("kind")),
            label_of(STAGE_LABELS, item.get("stage")),
            text_of("；".join(item.get("missing") or [])),
            text_of("；".join(item.get("checked") or [])),
            text_of(item.get("reason")),
            text_of(item.get("remediation")),
        ]))
    return "".join(rows)


def _artifact_rows(data: dict) -> str:
    rows = []
    for item in data.get("artifacts") or []:
        rows.append(row([
            mono(item.get("artifactId")),
            label_of(ARTIFACT_KIND_LABELS, item.get("kind")),
            text_of(item.get("relativePath")),
            mono(item.get("digest")),
            yes_no(item.get("present")),
        ]))
    return "".join(rows)


def _workbook_rows(data: dict) -> str:
    rows = []
    for item in data.get("workbooks") or []:
        recalculated = item.get("recalculated")
        rows.append(row([
            mono(item.get("workbookId")),
            text_of(item.get("relativePath")),
            text_of(item.get("templateId")),
            mono(item.get("templateDigest")),
            text_of("、".join(item.get("objectIds") or [])),
            yes_no(recalculated) if recalculated else
            '<span class="bad-text">待重算</span>',
            text_of(item.get("recalculationNote")),
        ]))
    return "".join(rows)


def _validation_rows(data: dict) -> str:
    receipt = data.get("validation")
    if not isinstance(receipt, dict):
        return ""
    checks = [
        ("冻结输入归属", "inputDigest", receipt.get("inputDigest")),
        ("知识正文与节 / 规则", "knowledgeVerified", receipt.get("knowledgeVerified")),
        ("计算表模板指纹", "templateVerified", receipt.get("templateVerified")),
        ("案例证据（截图 / 页面）", "evidenceVerified", receipt.get("evidenceVerified")),
        ("脚本计算与中间值", "calculationVerified", receipt.get("calculationVerified")),
        ("工作簿重算", "workbookRecalculated", receipt.get("workbookRecalculated")),
        ("报告渲染", "reportRendered", receipt.get("reportRendered")),
    ]
    rows = []
    for label, key, value in checks:
        if key == "reportRendered" and value is False:
            # 回执生成时通常还没渲染，而本页正是那次渲染：写成"未通过"会误导读者。
            rows.append(row([esc(label),
                             '<span class="muted">本轮渲染（回执生成时尚未渲染）</span>',
                             mono(key)]))
        elif isinstance(value, bool):
            rows.append(row([esc(label), passed_text(value) if value else
                             '<span class="bad-text">未通过</span>', mono(key)]))
        else:
            rows.append(row([esc(label), mono(value), mono(key)]))
    for note in receipt.get("notes") or []:
        rows.append(row(["回执备注", text_of(note), ""]))
    rows.append(row(["校验时间", text_of(receipt.get("verifiedAt")), "verifiedAt"]))
    rows.append(row(["方案 / 项目", f'{esc(receipt.get("planId"))} / {esc(receipt.get("projectId"))}',
                     "planId / projectId"]))
    return "".join(rows)


# ---------------------------------------------------------------------------
# 模板引擎：状态条件块 + 数据槽
# ---------------------------------------------------------------------------

_ENDIF = "<!--ENDIF-->"
_TOKEN_RE = re.compile(r"<!--IF\s+(!?)([A-Za-z0-9_.:=\-]+)\s*-->|<!--ENDIF-->")
_SLOT_RE = re.compile(r"\{\{[^}]*\}\}")


def _condition_true(negate: str, token: str, conditions: dict) -> bool:
    if token.startswith("flag:"):
        value = bool(conditions.get(token[5:], False))
    elif "=" in token:
        key, _, expected = token.partition("=")
        value = str(conditions.get(key.strip(), "")) == expected
    else:
        value = bool(conditions.get(token, False))
    return (not value) if negate else value


def apply_conditionals(template_text: str, conditions: dict) -> str:
    """按 `<!--IF ...-->` / `<!--ENDIF-->` 保留或丢弃片段（记号可以写在行内，可嵌套）。"""
    kept: list = []
    stack: list = []
    position = 0
    for match in _TOKEN_RE.finditer(template_text):
        if all(stack):
            kept.append(template_text[position:match.start()])
        position = match.end()
        if match.group(0) == _ENDIF:
            if not stack:
                raise ReportRenderError("模板里的 ENDIF 没有对应的 IF")
            stack.pop()
            continue
        stack.append(_condition_true(match.group(1) or "", match.group(2) or "", conditions))
    if stack:
        raise ReportRenderError("模板里有没闭合的条件块")
    if all(stack):
        kept.append(template_text[position:])
    return "".join(kept)


def render_template(template_text: str, slots: dict, conditions: dict, data_json: str) -> str:
    body = apply_conditionals(template_text, conditions)
    if "<!--IF" in body or _ENDIF in body:
        raise ReportRenderError(
            "模板里的条件标记必须单独占一行（IF / ENDIF）；行内标记会被当成普通注释漏出去")
    for name, value in slots.items():
        body = body.replace("{{" + name + "}}", value)
    leftovers = sorted(set(_SLOT_RE.findall(body)))
    if leftovers != ["{{dataJson}}"]:
        raise ReportRenderError(
            "模板与渲染脚本不同步：未被替换的数据槽 " + ", ".join(leftovers or ["(无 dataJson)"])
            + "；请同步 template/valuation-report.html 与 scripts/build_report.py")
    return body.replace("{{dataJson}}", data_json)


def safe_json(value: object) -> str:
    """内嵌 JSON 的安全化。

    `<` 只可能出现在 JSON 的字符串值里，所以：
    1. 除了 `</` 之外的 `<` 一律转成 `\\u003c` —— 外部标题/小区名里的 `<script>`、`<img onerror>`
       在整份 HTML 里都不会以原始标记形态出现（不是只靠"它不是 JS 所以没事"）；
    2. `</` 保持可读的 `\\/` 转义，`</script>` 变成 `<\\/script>`，不会提前闭合 script 元素。
    两种转义都是合法 JSON，解析后与原文逐字一致。
    """
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = re.sub(r"<(?!/)", lambda _match: "\\u003c", text)
    return text.replace("</", "<\\/")


def _reference_source_items(reference: dict) -> str:
    """Selected listing sources as visible, clickable full URLs (reference nature kept).

    URL values stay raw here: `link_or_text` escapes exactly once, so query strings such as
    `?a=1&b=2` survive as `a=1&amp;b=2` in the href (an HTML-aware parser recovers the original).
    """
    rows = reference.get("sources") if isinstance(reference.get("sources"), list) else []
    by_case = {}
    for source in rows:
        if isinstance(source, dict):
            by_case[str(source.get("caseId") or "").strip()] = source
    items = []
    for case_id in [str(item).strip() for item in reference.get("caseIds") or [] if str(item).strip()]:
        source = by_case.get(case_id)
        url = "" if source is None else str(source.get("sourceUrl") or "").strip()
        link = link_or_text(url, url) if url != "" else esc("来源见案例目录")
        items.append(f"<li>案例 {esc(case_id)}（挂牌）：{link}</li>")
    return "".join(items)


def build_slots(data: dict, resolved: dict, case_root: str, output_dir: str = "") -> tuple:
    """返回 (slots, flags)。文案留在模板里，这里只把数据排版成片段。"""
    assessment = data.get("methodAssessment") if isinstance(data.get("methodAssessment"), dict) else {}
    receipt = data.get("validation") if isinstance(data.get("validation"), dict) else {}
    knowledge = data.get("knowledgeSources") or []
    reference = data.get("referenceSummary") if isinstance(data.get("referenceSummary"), dict) else {}

    slots = {
        "projectId": esc(data.get("projectId")),
        "planId": esc(data.get("planId")),
        "reportStatus": esc(data.get("status")),
        "generatedAtText": text_of(data.get("generatedAt")),
        "inputDigest": esc(data.get("inputDigest")),
        "methodRequestLabel": label_of(METHOD_REQUEST_LABELS, data.get("methodRequest")),
        "baseDateText": text_of(data.get("baseDate")),
        "supplementalPrompt": esc(data.get("supplementalPrompt")),
        "caseRootText": text_of(case_root),
        # P16：评估目的与价值类型是结论前提，逐字落进人读报告；未指定就写明"未指定"。
        "purposeText": text_of(data.get("purpose")),
        "valueTypeText": text_of(data.get("valueType")),
        "stageLabel": label_of(STAGE_LABELS, data.get("stage")),
        "errorText": text_of(data.get("error")),
        "conclusionRows": _conclusion_rows(data),
        "provisionalRows": _object_result_rows(data.get("provisionalResults")),
        "partialObjectRows": _object_result_rows(data.get("partialObjectResults")),
        "completedWorkItems": items_html(data.get("completedWork")),
        "outstandingItems": items_html(data.get("outstanding")),
        "availableArtifactItems": items_html(data.get("availableArtifacts")),
        "blockerRows": _blocker_rows(data),
        "materialRows": _material_rows(data),
        "assessmentPlanId": esc(assessment.get("planId")),
        "primaryMethodText": label_of(METHOD_LABELS, assessment.get("primaryMethod")),
        "selectedMethodsText": text_of(
            "、".join(METHOD_LABELS.get(str(item), str(item)) for item in assessment.get("selectedMethods") or [])
        ),
        "requestedMethodHonoredText": yes_no(assessment.get("requestedMethodHonored")),
        "decidedAtText": text_of(assessment.get("decidedAt")),
        "assessmentRows": _assessment_rows(data),
        "adoptedMethodsText": text_of(
            "、".join(METHOD_LABELS.get(str(item), str(item)) for item in data.get("methods") or [])
        ),
        "methodResultRows": _method_result_rows(data),
        "assessmentNoteItems": items_html(assessment.get("notes")),
        "knowledgeRows": _knowledge_rows(data),
        "retrievalRows": _retrieval_rows(data),
        "lookupRows": _lookup_rows(data),
        "comparableRows": _comparable_rows(data, resolved, case_root, output_dir),
        "evidenceRows": _evidence_rows(data, resolved, case_root, output_dir),
        "parameterRows": _parameter_rows(data),
        "calculationRows": _calculation_rows(data),
        "ruleCheckRows": _rule_check_rows(data),
        "limitationItems": items_html(data.get("limitations")),
        "artifactRows": _artifact_rows(data),
        "workbookRows": _workbook_rows(data),
        "validationRows": _validation_rows(data),
        # Listing reference label/basis/sources, rendered visibly next to the amounts.
        "referenceLabel": esc(reference.get("label")),
        "referenceBasis": esc(reference.get("basis")),
        "referenceSourceItems": _reference_source_items(reference),
    }
    flags = {
        "baseDateSpecified": bool(data.get("baseDateSpecified")),
        "purposeSpecified": str(data.get("purpose") or "").strip() != "",
        "valueTypeSpecified": str(data.get("valueType") or "").strip() != "",
        "hasSupplementalPrompt": str(data.get("supplementalPrompt") or "").strip() != "",
        "hasMaterials": bool(data.get("materials")),
        "hasConclusions": bool(data.get("conclusions")),
        "hasCompletedWork": bool(data.get("completedWork")),
        "hasOutstanding": bool(data.get("outstanding")),
        "hasProvisional": bool(data.get("provisionalResults")),
        "hasPartialObjectResults": bool(data.get("partialObjectResults")),
        "hasBlockers": bool(data.get("blockers")),
        "hasAssessment": bool(assessment),
        "hasAssessments": bool(assessment.get("assessments")),
        "hasAssessmentNotes": bool(assessment.get("notes")),
        "hasMethodResults": bool(data.get("methodResults")),
        "hasMultipleMethods": len(data.get("methods") or []) > 1,
        "hasKnowledge": bool(knowledge),
        "hasRetrieval": bool(data.get("retrievalAttempts")),
        "hasRecovery": any(str(item.get("recoveryStrategy") or "").strip() != ""
                           for item in data.get("retrievalAttempts") or []),
        "hasLookups": bool(data.get("lookupAttempts")),
        "hasComparables": bool(data.get("comparables")),
        "hasEvidence": bool(data.get("evidence")),
        "hasParameters": bool(data.get("parameters")),
        "hasCalculations": bool(data.get("calculationSteps")),
        "hasRuleChecks": bool(data.get("ruleChecks")),
        "hasLimitations": bool(data.get("limitations")),
        "hasArtifacts": bool(data.get("artifacts")),
        "hasWorkbooks": bool(data.get("workbooks")),
        "hasValidation": bool(receipt),
        "hasAvailableArtifacts": bool(data.get("availableArtifacts")),
        "hasReferenceSummary": bool(reference.get("label")),
    }
    return slots, flags


def render_report(data: dict, template_path: str, case_root: str, output_dir: str = "") -> str:
    """渲染报告 HTML。数据不过 Schema 或图片证据不成立时抛 ReportRenderError。"""
    problems = validate_report_data(data)
    if problems:
        raise ReportRenderError(
            "报告数据未通过 Schema 校验：\n- " + "\n- ".join(problems), problems)
    if not os.path.isfile(template_path):
        raise ReportRenderError(f"找不到报告模板：{template_path}")

    status = str(data.get("status") or "")
    root = os.path.abspath(case_root) if case_root else ""
    if root and not os.path.isdir(root):
        raise ReportRenderError(f"案例目录不存在：{root}")

    entries = _screenshot_entries(data)
    resolved: dict = {}
    for key, shot in entries:
        resolved[key] = resolve_screenshot(shot, root)
    strict_problems = [str(outcome["problem"]) for outcome in resolved.values()
                       if outcome.get("problem")]

    if status == "completed" and strict_problems:
        raise ReportRenderError(
            "completed 报告的图片证据未通过校验，拒绝渲染（不静默跳过）：\n- "
            + "\n- ".join(strict_problems), strict_problems)

    with open(template_path, "r", encoding="utf-8") as handle:
        template_text = handle.read()
    slots, flags = build_slots(data, resolved, root, output_dir)
    conditions = {"status": status, **flags}
    return render_template(template_text, slots, conditions, safe_json(data))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _atomic_write(out_path: str, body: str) -> None:
    directory = os.path.dirname(os.path.abspath(out_path)) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = f"{out_path}.tmp-{os.getpid()}"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        # 原子落盘：读者看到的要么是旧的完整报告，要么是新的完整报告。
        os.replace(temporary, out_path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description="把估值报告数据渲染成 HTML 报告")
    parser.add_argument("--data", required=True, help="估值报告数据.json（v2 合同，唯一入口）")
    parser.add_argument("--out", required=True, help="目标 HTML（案例目录内）")
    parser.add_argument("--template", default=DEFAULT_TEMPLATE, help="报告模板（只读）")
    parser.add_argument("--case-root", default="", help="案例目录（图片相对路径的根，默认 --out 所在目录）")
    parser.add_argument("--force", action="store_true", help="目标已存在时覆盖（默认拒绝）")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.template):
        print(f"FAIL 找不到报告模板：{args.template}")
        return 1
    if os.path.abspath(args.out) == os.path.abspath(args.template):
        print("FAIL 目标路径就是模板本身：产物必须写进估值案例目录，模板只读")
        return 1
    if os.path.exists(args.out) and not args.force:
        print(f"FAIL 目标已存在：{args.out}（要覆盖请加 --force）")
        return 1

    case_root = args.case_root or os.path.dirname(os.path.abspath(args.out))
    if not args.case_root:
        # 默认案例目录由 --out 派生：产物要写进去，所以这里先把目录准备好。
        # 显式给的 --case-root 不代建 —— 指错路径时必须报错，不能被"顺手建出来"掩盖。
        os.makedirs(case_root, exist_ok=True)
    try:
        if not os.path.isfile(args.data):
            print(f"FAIL 找不到报告数据：{args.data}")
            return 1
        with open(args.data, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            print("FAIL 报告数据顶层必须是对象")
            return 1
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL 读不到合法的 JSON 输入：{error}")
        return 1

    try:
        body = render_report(data, args.template, case_root, os.path.dirname(os.path.abspath(args.out)))
    except ReportRenderError as error:
        print(f"FAIL {error}")
        return 1

    _atomic_write(args.out, body)
    print(f"OK: 已生成 {args.out}（status={data.get('status')} / "
          f"对象 {len(data.get('objects') or [])} 个 / 案例 {len(data.get('comparables') or [])} 条 / "
          f"计算步骤 {len(data.get('calculationSteps') or [])} 步 / "
          f"阻断 {len(data.get('blockers') or [])} 项 / 图片证据 {len(_screenshot_entries(data))} 条）")
    print("提醒：报告数字按报告数据的十进制字符串逐字排版，不取整；以计算表重算结果为准。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
