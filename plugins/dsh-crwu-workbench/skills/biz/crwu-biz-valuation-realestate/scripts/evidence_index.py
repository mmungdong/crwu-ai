#!/usr/bin/env python3
"""Case-evidence index helpers for the generated workbook (`values.caseEvidence`)."""

from __future__ import annotations

import hashlib
import os
import re
from urllib.parse import urlsplit

IMAGE_DIR = "推理结果/图片"
EVIDENCE_SHEET = "案例证据"
SHEET_COLUMNS = ["caseId", "显示名称", "来源", "详情 URL", "图片相对路径", "指纹", "抓取时间", "证据类型"]
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class EvidenceError(Exception):
    """A caseEvidence entry cannot be traced (unsafe / missing / digest mismatch)."""


def _text(value: object) -> str:
    return "" if value is None else str(value).strip()


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def _within(root: str, target: str) -> bool:
    """True when `target` is `root` or a descendant of it (native path semantics)."""
    try:
        return os.path.commonpath([root, target]) == root
    except ValueError:
        # Different Windows drives (or mixed absolute/relative): never contained.
        return False


def normalise_entries(raw: object, case_root: str) -> list[dict]:
    """Validate and normalise `caseEvidence`; raises EvidenceError on anything untraceable."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise EvidenceError("caseEvidence 必须是数组")
    root = os.path.abspath(case_root)
    real_root = os.path.realpath(root)
    rows: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        where = f"caseEvidence[{index}]"
        if not isinstance(item, dict):
            raise EvidenceError(f"{where}: 必须是对象")
        case_id = _text(item.get("caseId"))
        if case_id == "":
            raise EvidenceError(f"{where}: 缺少 caseId")
        if case_id in seen:
            raise EvidenceError(f"{where}: caseId 重复：{case_id}")
        seen.add(case_id)
        source_url = _text(item.get("sourceUrl"))
        parts = urlsplit(source_url)
        if parts.scheme not in ("http", "https") or parts.hostname in (None, ""):
            raise EvidenceError(f"{where}: sourceUrl 必须是带主机名的 http/https 绝对地址")
        relative = _text(item.get("relativePath")).replace("\\", "/")
        if relative == "" or os.path.isabs(relative) or re.match(r"^[A-Za-z]:", relative):
            raise EvidenceError(f"{where}: relativePath 必须是案例目录内的相对路径")
        if ".." in [segment for segment in relative.split("/") if segment not in ("", ".")]:
            raise EvidenceError(f"{where}: relativePath 不许包含 ..（不能借道离开 {IMAGE_DIR}/）")
        if not relative.startswith(IMAGE_DIR + "/") or not relative.lower().endswith(".png"):
            raise EvidenceError(f"{where}: 图片必须落在 {IMAGE_DIR}/ 下的 .png")
        target = os.path.normpath(os.path.join(root, relative))
        if target != root and not target.startswith(root + os.sep):
            raise EvidenceError(f"{where}: 图片路径越界")
        real_image_root = os.path.realpath(os.path.join(root, IMAGE_DIR))
        # The image directory itself must stay inside the case root: a symlinked
        # 推理结果/图片 can point the whole evidence tree at a sibling outside the case.
        if not _within(real_root, real_image_root):
            raise EvidenceError(
                f"{where}: {IMAGE_DIR}/ 的真实路径越出案例根（{real_image_root} 不在 {real_root} 内）")
        real_target = os.path.realpath(target)
        if not _within(real_root, real_target):
            raise EvidenceError(f"{where}: 图片真实路径越出案例根")
        if real_target != real_image_root and not real_target.startswith(real_image_root + os.sep):
            raise EvidenceError(f"{where}: 图片真实路径必须落在 {IMAGE_DIR}/ 内")
        if not os.path.isfile(real_target):
            raise EvidenceError(f"{where}: 图片不存在：{relative}")
        with open(real_target, "rb") as handle:
            if handle.read(8) != _PNG_SIGNATURE:
                raise EvidenceError(f"{where}: 不是有效 PNG（魔数不符）：{relative}")
        digest = _text(item.get("digest"))
        actual = _sha256(real_target)
        recorded = digest.lower().removeprefix("sha256:").removeprefix("sha256-")
        if recorded == "" or recorded != actual.removeprefix("sha256:"):
            raise EvidenceError(f"{where}: 图片指纹不符（记录 {digest or '(空)'}，实际 {actual}）")
        evidence_type = _text(item.get("evidenceType"))
        if evidence_type == "":
            page_type = _text(item.get("pageType"))
            evidence_type = {"detail": "detail-screenshot", "list": "page-screenshot"}.get(page_type, "")
        if evidence_type not in ("page-screenshot", "detail-screenshot", "alternative-evidence"):
            raise EvidenceError(f"{where}: evidenceType 必须显式给出（不许默认成 detail）")
        rows.append({
            "caseId": case_id,
            "displayName": _text(item.get("displayName")) or case_id,
            "provider": _text(item.get("provider")),
            "sourceUrl": source_url,
            "relativePath": relative,
            "digest": digest or actual,
            "capturedAt": _text(item.get("capturedAt")),
            "evidenceType": evidence_type,
        })
    return rows


def hyperlink_target(workbook_path: str, case_root: str, relative: str) -> str:
    """Relative href from the workbook's own directory to the image (survives tree moves)."""
    target = os.path.normpath(os.path.join(case_root, relative))
    base = os.path.dirname(os.path.abspath(workbook_path))
    return os.path.relpath(target, base).replace(os.sep, "/")
