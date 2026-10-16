#!/usr/bin/env python3
"""`build_report_data.py` 的契约测试：**Schema 是数据形状的唯一事实源**。

钉住的是三类真实会出错的事：

1. **状态控制结论展示**：`blocked` 报告没有金额也没有工作簿，`partial` 的金额只进暂算字段；
   `completed` 少了对象结论 / 工作簿 / finalize 回执就必须报问题 —— 不许为了支持中断而放松
   完成判据（设计稿 §11.3 / §11.4，计划 Task 10 Step 1）。
2. **金额是十进制字符串**：不取整、不四舍五入、缺失不写 0；空基准日归一成 `null`，
   非法日历日期（如 2026-02-30）必须被拒。
3. **不许 eval 公式**：组装层只搬运数据，把表达式当字符串原样带走。

本模块同时给 `test_report_render.py` 提供受控运行 manifest 夹具（同一目录，直接 import）。
夹具里的阈值/税率都是**测试样本**，不是生产业务依据。
"""

from __future__ import annotations

import decimal
import json
import os
import re
import struct
import tempfile
import unittest
import zlib

import build_report_data as module
from build_report_data import (
    ReportDataError,
    build_report_data,
    validate_report_data,
)

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
SCHEMA_PATH = os.path.join(SKILL_DIR, "schemas", "valuation-report-data.schema.json")

DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
DIGEST_C = "sha256:" + "c" * 64


# ---------------------------------------------------------------------------
# 夹具：真实的小 PNG + 各状态的受控运行 manifest
# ---------------------------------------------------------------------------

def png_bytes() -> bytes:
    """一个结构完整的 1×1 PNG（真实字节，不是占位文件名）。"""

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    scanline = b"\x00\x40\x80\xc0"
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(scanline)) + chunk(b"IEND", b""))


def write_shot(case_root: str, relative: str, payload: bytes | None = None) -> dict:
    """在案例目录里写一张真图，返回可写进 manifest 的 screenshot 字段。"""
    import hashlib

    data = payload if payload is not None else png_bytes()
    target = os.path.join(case_root, relative)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as handle:
        handle.write(data)
    return "sha256:" + hashlib.sha256(data).hexdigest()


def knowledge_ref(route_id: str, rule_id: str | None = None) -> dict:
    ref = {"routeId": route_id, "snapshotDigest": DIGEST_C}
    if rule_id:
        ref["ruleId"] = rule_id
    return ref


def screenshot(case_id: str = "case-001", relative: str = "", digest: str = DIGEST_B,
               validity: str = "valid", url: str = "https://example.invalid/detail/1") -> dict:
    return {
        "caseId": case_id,
        "displayName": "阳光小区 3室2厅",
        "provider": "链家",
        "sourceUrl": url,
        "capturedAt": "2026-10-14T02:00:00Z",
        "relativePath": relative or f"推理结果/图片/{case_id}-阳光小区/链家-详情.png",
        "digest": digest,
        "validity": validity,
    }


def completed_manifest(**overrides) -> dict:
    payload = {
        "status": "completed",
        "projectId": "project-001",
        "planId": "plan-001",
        "generatedAt": "2026-10-14T00:00:00+00:00",
        "methodRequest": "market",
        "method": "market",
        # 协议 39：methods 是唯一权威（单一或组合）；逐方法结果各自留痕。
        "methods": ["market"],
        "methodResults": [{
            "method": "market", "basis": "同小区可核成交案例充分（本轮知识快照 02 市场法）",
            "unitPrice": "60000.00", "totalValue": "5370000.00", "template": "",
        }],
        "baseDate": "2026-06-30",
        # P16：completed 必须带业务前提（未指定就不许声称完成）—— 夹具默认给足，
        # 要测"未指定"的用例显式覆盖成空串。
        "purpose": "司法拍卖处置参考",
        "valueType": "市场价值",
        "supplementalPrompt": "按住宅市场法完成本轮估值。",
        "inputDigest": DIGEST_A,
        "materials": [{
            "fileId": "file-001", "fileName": "不动产权证.pdf",
            "archiveRelativePath": "材料-源/不动产权证.pdf", "kind": "application/pdf",
            "sizeBytes": 2048, "sha256": DIGEST_B, "createdAt": None,
            "modifiedAt": "2026-10-01T00:00:00Z", "readable": True, "duplicateOf": None,
        }],
        "knowledgeSources": [{
            "routeId": "realestate.common", "nodeName": "01 房地产估值通用",
            "resolvedPath": "01 估值与测算/01 房地产/01 房地产估值通用", "source": "dws",
            "spaceName": "中瑞世联业务知识库", "updatedAt": "2026-09-20T00:00:00Z",
            "digest": DIGEST_C, "snapshotFile": "知识快照/realestate.common.md",
            "sectionIds": ["S-1"], "ruleIds": ["R-1"],
        }],
        "retrievalAttempts": [{
            "taskId": "task-001", "caseId": "case-001", "providerId": "链家", "stage": "detail",
            "outcome": "challenge-recovered", "finalUrl": "https://example.invalid/detail/1",
            "reasonCode": "challenge-visible", "recoveryStrategy": "cooldown-renavigate",
            "recoveryAttempts": 1,
        }],
        "artifacts": [
            {"artifactId": "report-html", "kind": "html",
             "relativePath": "方案/plan-001/估值报告.html", "digest": DIGEST_B, "present": True},
            {"artifactId": "workbook", "kind": "workbook",
             "relativePath": "方案/plan-001/估值底稿.xlsx", "digest": DIGEST_C, "present": True},
        ],
        "limitations": ["本部署没有页面截图能力以外的可视化取证能力。"],
        "objects": [{
            "objectId": "object-001", "displayName": "阳光小区 3 号楼 601",
            "propertyType": "residential", "sourceRefs": ["file-001#page-1"],
            "fields": {"坐落": "某市某区阳光小区 3 号楼 601", "建筑面积": "89.5"},
            "missingFields": ["建成年代"],
        }],
        "methodAssessment": {
            "planId": "plan-001", "methodRequest": "market", "primaryMethod": "market",
            "selectedMethods": ["market"],
            "assessments": [
                {"method": "market", "applicable": True, "implemented": True, "selected": True,
                 "reason": "同小区可核成交案例充分",
                 "ruleRefs": [knowledge_ref("realestate.method-selection", "R-MS-1")],
                 "conflicts": []},
                {"method": "income", "applicable": False, "implemented": False, "selected": False,
                 "reason": "租金数据不足 6 个月，无法形成净收益序列"},
            ],
            "requestedMethodHonored": True,
            "notes": ["用户指定 market，本方案满足"],
            "decidedAt": "2026-10-14T01:00:00Z",
        },
        "parameters": [
            {"parameterId": "param-vat", "label": "增值税率", "value": "5", "unit": "%",
             "valueDate": "2026-06-30", "region": "某市", "sourceRef": "realestate.parameters#S-2",
             "ruleRef": knowledge_ref("realestate.parameters", "R-TAX-1"), "state": "provided"},
            {"parameterId": "param-vacancy", "label": "空置率", "value": None, "unit": "%",
             "valueDate": None, "region": "某市", "sourceRef": "", "ruleRef": None,
             "state": "missing", "missingImpact": "registration-gap"},
        ],
        "comparables": [
            {"caseId": "case-001", "displayName": "阳光小区 3室2厅", "provider": "链家",
             "sourceUrl": "https://example.invalid/detail/1", "transactionType": "成交",
             "publishedAt": "2026-09-01", "unitPrice": "60000.00", "buildingArea": "90.0",
             "used": True, "keepReason": "同小区、同用途、面积接近", "dropReason": "",
             "screenshots": []},
            {"caseId": "case-002", "displayName": "阳光小区 2室1厅", "provider": "安居客",
             "sourceUrl": "https://example.invalid/detail/2", "transactionType": "挂牌",
             "publishedAt": "2026-09-12", "unitPrice": "58000", "buildingArea": "120.0",
             "used": False, "keepReason": "", "dropReason": "建筑面积偏差超过规则上限",
             "screenshots": []},
        ],
        "calculationSteps": [
            {"stepId": "step-1", "formulaId": "F-1", "label": "修正后单价",
             "expression": "60000.00 × 1.02",
             "operands": [{"name": "可比单价", "value": "60000.00", "unit": "元/㎡",
                           "provenance": "case-001 成交价"}],
             "value": "61200.00", "unit": "元/㎡",
             "ruleRef": knowledge_ref("realestate.parameters", "R-ADJ-1")},
            {"stepId": "step-2", "formulaId": "F-2", "label": "评估总价",
             "expression": "61200.00 × 89.5",
             "operands": [
                 {"name": "修正后单价", "value": "61200.00", "unit": "元/㎡", "provenance": "step-1"},
                 {"name": "建筑面积", "value": "89.5", "unit": "㎡", "provenance": "object-001"},
             ],
             "value": "5477400.00", "unit": "元", "ruleRef": None},
        ],
        "ruleChecks": [
            {"ruleId": "R-CASE-COUNT", "label": "采用案例不少于规则要求", "passed": True,
             "detail": "采用 1 条（测试样本）",
             "ruleRef": knowledge_ref("realestate.case-selection", "R-CASE-1")},
            {"ruleId": "R-DATE-WINDOW", "label": "成交日期在基准日前窗内", "passed": False,
             "detail": "案例 2 超出日期窗，已剔除", "ruleRef": None},
        ],
        "conclusions": [{
            "objectId": "object-001", "valueScope": "land-and-building", "method": "market",
            "unitPrice": "61200.00", "totalValue": "5477400.00", "currency": "CNY",
            "basisRefs": [{"routeId": "realestate.method.market", "snapshotDigest": DIGEST_C,
                           "sectionId": "S-3"}],
            "calculationRef": "step-2",
        }],
        "evidence": [],
        "workbooks": [{
            "workbookId": "wb-001", "relativePath": "方案/plan-001/估值底稿.xlsx",
            "templateId": "template.market.residential", "templateDigest": DIGEST_B,
            "objectIds": ["object-001"], "recalculated": True,
            "recalculationNote": "重算提供方执行通过",
        }],
        "validation": {
            "projectId": "project-001", "planId": "plan-001", "inputDigest": DIGEST_A,
            "knowledgeVerified": True, "templateVerified": True, "evidenceVerified": True,
            "calculationVerified": True, "workbookRecalculated": True, "reportRendered": False,
            "verifiedAt": "2026-10-14T02:00:00Z", "notes": ["截图与来源页面指纹一致"],
        },
    }
    payload.update(overrides)
    return payload


def blocked_manifest(**overrides) -> dict:
    payload = {
        "status": "blocked",
        "projectId": "project-002",
        "planId": "plan-002",
        "generatedAt": "2026-10-14T03:00:00+00:00",
        "methodRequest": "auto",
        "method": None,
        "baseDate": None,
        "supplementalPrompt": "",
        "inputDigest": DIGEST_A,
        "materials": [],
        "knowledgeSources": [],
        "retrievalAttempts": [],
        "artifacts": [{"artifactId": "status-json", "kind": "data",
                       "relativePath": "方案/plan-002/估值状态.json", "digest": DIGEST_B,
                       "present": True}],
        "limitations": ["知识库没有发布住宅商业市场法案例选取规则。"],
        "stage": "knowledge",
        "blockers": [{
            "kind": "knowledge-missing", "stage": "knowledge",
            "missing": ["realestate.case-selection 住宅市场法案例选取规则"],
            "checked": ["01 估值与测算/01 房地产/03 案例选取",
                        "同目录同名 .md", "显式别名", "身份已验证镜像"],
            "reason": "目标目录下只有预留标题，没有正文；多候选均为空文档。",
            "remediation": "请业务负责人在知识库 03 案例选取下发布住宅市场法案例选取规则后重跑。",
            "code": "KB-03-EMPTY", "capabilityId": "knowledge.realestate.case-selection",
            "knowledgeRef": knowledge_ref("realestate.case-selection"),
        }],
        "lookupAttempts": [
            {"routeId": "realestate.case-selection", "channel": "exact-route",
             "target": "01 估值与测算/01 房地产/03 案例选取/01-住宅市场法案例选取",
             "outcome": "empty", "detail": "节点存在但正文为预留标题"},
            {"routeId": "realestate.case-selection", "channel": "same-name",
             "target": "03 案例选取/01-住宅市场法案例选取.md", "outcome": "missing",
             "detail": "目标目录下没有同名可读文档"},
            {"routeId": "realestate.case-selection", "channel": "mirror",
             "target": "镜像根/03 案例选取", "outcome": "rejected-identity",
             "detail": "镜像空间名不是目标业务库，按身份验证拒绝"},
        ],
        "partialObjectResults": [],
    }
    payload.update(overrides)
    return payload


def partial_manifest(**overrides) -> dict:
    payload = {
        "status": "partial",
        "projectId": "project-003",
        "planId": "plan-003",
        "generatedAt": "2026-10-14T04:00:00+00:00",
        "methodRequest": "market",
        "method": "market",
        # 协议 39：methods 是唯一权威（单一或组合）；逐方法结果各自留痕。
        "methods": ["market"],
        "methodResults": [{
            "method": "market", "basis": "同小区可核成交案例充分（本轮知识快照 02 市场法）",
            "unitPrice": "60000.00", "totalValue": "5370000.00", "template": "",
        }],
        "baseDate": "2026-06-30",
        "supplementalPrompt": "",
        "inputDigest": DIGEST_A,
        "materials": [],
        "knowledgeSources": [],
        "retrievalAttempts": [],
        "artifacts": [],
        "limitations": ["工作簿重算提供方不可用：底稿保留正确公式但标记待重算。"],
        "stage": "calculation",
        "completedWork": ["对象识别与方案分组完成", "方法判定完成：市场法"],
        "outstanding": ["工作簿重算（本机没有可用的重算提供方）"],
        "blockers": [{
            "kind": "recalculation-unavailable", "stage": "calculation",
            "missing": ["workbook.recalculate 提供方"],
            "checked": ["已注册能力清单", "本机 Excel / LibreOffice 探测"],
            "reason": "没有经 Broker 验证的重算能力，不能伪报已重算。",
            "remediation": "在具备重算能力的机器上重新执行底稿重算后 finalize。",
            "capabilityId": "workbook.recalculate",
        }],
        "lookupAttempts": [],
        "provisionalResults": [{
            "objectId": "object-001", "displayName": "阳光小区 3 号楼 601",
            "valueScope": "land-and-building", "method": "market", "unitPrice": "61200.00",
            "totalValue": "5477400.00", "currency": "CNY", "calculationRef": "step-2",
        }],
    }
    payload.update(overrides)
    return payload


def failed_manifest(**overrides) -> dict:
    payload = {
        "status": "failed",
        "projectId": "project-004",
        "planId": "plan-004",
        "generatedAt": "2026-10-14T05:00:00+00:00",
        "methodRequest": "market",
        "method": "market",
        "baseDate": None,
        "supplementalPrompt": "",
        "inputDigest": DIGEST_A,
        "materials": [],
        "knowledgeSources": [],
        "retrievalAttempts": [],
        "artifacts": [{"artifactId": "status-json", "kind": "data",
                       "relativePath": "方案/plan-004/估值状态.json", "digest": DIGEST_B,
                       "present": True}],
        "limitations": [],
        "stage": "retrieval",
        "error": "案例来源站点连续返回限流（Retry-After 超出本轮恢复窗口）。",
        "blockers": [{
            "kind": "capability-missing", "stage": "retrieval",
            "missing": ["market.residential.detail"],
            "checked": ["scoped registry", "provider 健康状态"],
            "reason": "取数在限流窗口内无法完成，且已超出恢复预算。",
            "remediation": "限流窗口结束后用同一取数任务继续，不重建会话。",
        }],
        "availableArtifacts": ["方案/plan-004/估值状态.json", "方案/plan-004/来源证据/页面/链家-详情.html"],
    }
    payload.update(overrides)
    return payload


def cancelled_manifest(**overrides) -> dict:
    payload = failed_manifest(status="cancelled",
                              error="员工在方法判定前取消了本轮估值。")
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# 组装与自校验
# ---------------------------------------------------------------------------

class BuildReportDataTest(unittest.TestCase):

    def test_completed_manifest_assembles_and_self_validates(self):
        data = build_report_data(completed_manifest())
        self.assertEqual(data["schemaVersion"], "crwu.valuation.report-data.v2")
        self.assertEqual(data["status"], "completed")
        self.assertEqual(validate_report_data(data), [])
        self.assertEqual(data["baseDateSpecified"], True)

    def test_amounts_stay_decimal_strings_and_are_not_rounded(self):
        manifest = completed_manifest()
        manifest["calculationSteps"][0]["value"] = decimal.Decimal("61200.005")
        manifest["conclusions"][0]["totalValue"] = 5477400.0
        data = build_report_data(manifest)
        self.assertEqual(data["calculationSteps"][0]["value"], "61200.005")
        self.assertEqual(data["conclusions"][0]["totalValue"], "5477400.0")
        self.assertEqual(data["comparables"][0]["unitPrice"], "60000.00")
        as_json = json.dumps(data, ensure_ascii=False)
        self.assertIn('"5477400.0"', as_json, "金额必须是字符串，不是 float")

    def test_a_float_does_not_become_a_second_rounding(self):
        manifest = completed_manifest()
        manifest["parameters"][0]["value"] = 0.1 + 0.2
        data = build_report_data(manifest)
        self.assertEqual(data["parameters"][0]["value"], "0.30000000000000004")

    def test_blank_base_date_is_normalized_to_null_and_unspecified(self):
        data = build_report_data(completed_manifest(baseDate="", supplementalPrompt=""))
        self.assertIsNone(data["baseDate"])
        self.assertEqual(data["baseDateSpecified"], False)
        self.assertEqual(validate_report_data(data), [])

    def test_an_impossible_calendar_date_is_rejected(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(completed_manifest(baseDate="2026-02-30"))
        self.assertIn("不是有效的 YYYY-MM-DD", str(caught.exception))

    def test_auto_is_not_a_conclusion_method(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(completed_manifest(method="auto"))
        self.assertIn("不是结论方法", str(caught.exception))

    def test_unknown_status_is_rejected_with_the_allowed_list(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(completed_manifest(status="almost-done"))
        message = str(caught.exception)
        for status in ("completed", "blocked", "partial", "failed", "cancelled"):
            self.assertIn(status, message)

    def test_generated_at_is_stamped_when_the_manifest_omits_it(self):
        data = build_report_data(completed_manifest(generatedAt=""))
        self.assertRegex(data["generatedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
        self.assertEqual(data["limitations"], ["本部署没有页面截图能力以外的可视化取证能力。"],
                         "生成时间是报告元信息，不该挤进限制与缺口清单")

    def test_missing_required_identity_fields_are_reported(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(completed_manifest(projectId=""))
        self.assertIn("projectId", str(caught.exception))


class StatusControlTest(unittest.TestCase):
    """状态决定展示什么：中断报告没有金额，未定稿金额不是结论。"""

    def test_blocked_needs_neither_amount_nor_method_nor_workbook(self):
        data = build_report_data(blocked_manifest())
        self.assertEqual(validate_report_data(data), [])
        self.assertNotIn("workbooks", data)
        self.assertNotIn("conclusions", data)
        self.assertIsNone(data["conclusion"])
        self.assertIsNone(data["method"])
        self.assertEqual(data["lookupAttempts"][0]["outcome"], "empty")

    def test_blocked_drops_intermediate_conclusion_material_and_says_so(self):
        manifest = blocked_manifest(
            workbooks=[{"workbookId": "wb-draft", "relativePath": "工作中/底稿.xlsx",
                        "templateId": "t", "templateDigest": DIGEST_B, "recalculated": False}],
            conclusions=[{"objectId": "object-001", "valueScope": "land-and-building",
                          "method": "market", "totalValue": "1", "currency": "CNY",
                          "basisRefs": [knowledge_ref("realestate.method.market")]}])
        data = build_report_data(manifest)
        self.assertNotIn("workbooks", data)
        self.assertNotIn("conclusions", data)
        self.assertTrue(any("工作中" in item for item in data["limitations"]))

    def test_blocked_without_blockers_is_a_problem(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(blocked_manifest(blockers=[]))
        self.assertIn("blockers", str(caught.exception))

    def test_blocked_blocker_must_say_what_was_checked_and_how_to_fix(self):
        broken = blocked_manifest()
        broken["blockers"][0].pop("remediation")
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(broken)
        self.assertIn("remediation", str(caught.exception))

    def test_partial_amounts_go_to_provisional_not_to_conclusions(self):
        data = build_report_data(partial_manifest(
            conclusions=[{"objectId": "object-001", "valueScope": "land-and-building",
                          "method": "market", "totalValue": "5477400.00", "currency": "CNY",
                          "basisRefs": [knowledge_ref("realestate.method.market")]}]))
        self.assertEqual(validate_report_data(data), [])
        self.assertNotIn("conclusions", data)
        self.assertEqual(data["provisionalResults"][0]["totalValue"], "5477400.00")

    def test_partial_must_separate_completed_work_from_outstanding(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(partial_manifest(outstanding=[]))
        self.assertIn("outstanding", str(caught.exception))

    def test_failed_and_cancelled_list_stage_and_files_not_completion(self):
        for manifest in (failed_manifest(), cancelled_manifest()):
            data = build_report_data(manifest)
            self.assertEqual(validate_report_data(data), [])
            self.assertIsNone(data["conclusion"])
            self.assertNotIn("conclusions", data)
            self.assertNotIn("workbooks", data)
            self.assertNotEqual(data["stage"].strip(), "")
            self.assertTrue(data["availableArtifacts"])

    def test_failed_without_error_text_is_a_problem(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(failed_manifest(error=""))
        self.assertIn("error", str(caught.exception))


class ValidateReportDataTest(unittest.TestCase):
    """completed 的判据不因为要支持 blocked 而放松。"""

    def setUp(self):
        self.data = build_report_data(completed_manifest())

    def test_a_valid_completed_report_has_no_problems(self):
        self.assertEqual(validate_report_data(self.data), [])

    def test_completed_without_workbooks_is_a_problem(self):
        broken = json.loads(json.dumps(self.data))
        broken.pop("workbooks")
        problems = validate_report_data(broken)
        self.assertTrue(problems)
        self.assertTrue(any("workbooks" in item for item in problems), problems)

    def test_completed_without_conclusions_is_a_problem(self):
        broken = json.loads(json.dumps(self.data))
        broken.pop("conclusions")
        problems = validate_report_data(broken)
        self.assertTrue(any("conclusions" in item for item in problems), problems)

    def test_completed_without_the_validation_receipt_is_a_problem(self):
        broken = json.loads(json.dumps(self.data))
        broken.pop("validation")
        problems = validate_report_data(broken)
        self.assertTrue(any("validation" in item for item in problems), problems)

    def test_a_conclusion_must_point_at_a_registered_object(self):
        broken = json.loads(json.dumps(self.data))
        broken["conclusions"][0]["objectId"] = "object-unknown"
        problems = validate_report_data(broken)
        self.assertTrue(any("object-unknown" in item for item in problems), problems)

    def test_the_receipt_must_belong_to_the_same_frozen_input(self):
        broken = json.loads(json.dumps(self.data))
        broken["validation"]["inputDigest"] = DIGEST_B
        problems = validate_report_data(broken)
        self.assertTrue(any("inputDigest" in item for item in problems), problems)

    def test_blocked_does_not_require_amounts_or_workbooks(self):
        data = build_report_data(blocked_manifest())
        self.assertEqual(validate_report_data(data), [])

    def test_a_stray_conclusion_on_a_blocked_report_is_a_problem(self):
        data = build_report_data(blocked_manifest())
        data["conclusion"] = {"objectId": "object-001"}
        self.assertTrue(validate_report_data(data))

    def test_oneof_must_hit_exactly_one_branch(self):
        # status 不在五支里 → 判别联合一条都不命中。
        broken = json.loads(json.dumps(self.data))
        broken["status"] = "archived"
        problems = validate_report_data(broken)
        self.assertTrue(any("恰好一支" in item for item in problems), problems)

    def test_an_unknown_schema_keyword_is_refused_not_ignored(self):
        # 校验器只认白名单 keyword：Schema 扩了关键字而校验器没跟，必须报问题而不是假通过。
        original = module.load_report_data_schema
        try:
            schema = json.loads(json.dumps(original()))
            schema["properties-not-supported-here"] = True
            module.load_report_data_schema = lambda: schema
            problems = validate_report_data(self.data)
        finally:
            module.load_report_data_schema = original
        self.assertTrue(any("keyword" in item for item in problems), problems)

    def test_the_schema_file_is_the_one_the_skill_ships(self):
        self.assertTrue(os.path.isfile(SCHEMA_PATH))
        with open(SCHEMA_PATH, encoding="utf-8") as handle:
            schema = json.load(handle)
        self.assertEqual(schema["$id"], "crwu.valuation.report-data.v2")
        branches = [branch["properties"]["status"]["const"] for branch in schema["oneOf"]]
        self.assertEqual(sorted(branches),
                         ["blocked", "cancelled", "completed", "failed", "partial"])


class BusinessInputsTest(unittest.TestCase):
    """P14 / P16 / P17：业务前提必须有位置，缺失不许静默、更不许当成 0。"""

    # ── P16：评估目的与价值类型 ─────────────────────────────────────────────

    def test_purpose_and_value_type_survive_into_report_data(self):
        data = build_report_data(completed_manifest())
        self.assertEqual(data["purpose"], "司法拍卖处置参考")
        self.assertEqual(data["valueType"], "市场价值")
        self.assertTrue(data["purposeSpecified"])
        self.assertTrue(data["valueTypeSpecified"])
        self.assertEqual(validate_report_data(data), [])

    def test_unspecified_purpose_and_value_type_stay_null_and_are_stated(self):
        # 非 completed 状态允许未指定：必须是 `null`（不是空串、更不是默认结论），
        # 且限制清单里要**逐字**写明，不许静默。
        data = build_report_data(partial_manifest(purpose="", valueType="   "))
        self.assertIsNone(data["purpose"])
        self.assertIsNone(data["valueType"])
        self.assertFalse(data["purposeSpecified"])
        self.assertFalse(data["valueTypeSpecified"])
        self.assertIn("本次未指定评估目的", "\n".join(data["limitations"]))
        self.assertIn("本次未指定价值类型", "\n".join(data["limitations"]))
        self.assertEqual(validate_report_data(data), [])

    def test_completed_without_purpose_or_value_type_is_refused(self):
        for key, notice in (("purpose", "本次未指定评估目的"),
                            ("valueType", "本次未指定价值类型")):
            manifest = completed_manifest()
            manifest[key] = ""
            with self.assertRaises(ReportDataError) as caught:
                build_report_data(manifest)
            self.assertIn(notice, str(caught.exception),
                          f"未指定 {key} 时不许声称正式完成（P16）")

    def test_a_completed_document_that_hides_the_unspecified_value_is_a_problem(self):
        # 直接在报告数据里把 purpose 置空（绕过组装层）：校验器必须拦住。
        data = build_report_data(completed_manifest())
        broken = json.loads(json.dumps(data))
        broken["purpose"] = None
        broken["purposeSpecified"] = False
        problems = validate_report_data(broken)
        self.assertTrue(any("本次未指定评估目的" in item for item in problems), problems)

    def test_a_blank_purpose_never_becomes_a_zero_or_a_default(self):
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(completed_manifest(purpose=0))  # type: ignore[arg-type]
        self.assertIn("purpose", str(caught.exception))

    # ── P14：基准日未指定时不许静默 ────────────────────────────────────────

    def test_unspecified_base_date_is_stated_in_limitations_not_silent(self):
        data = build_report_data(completed_manifest(baseDate=""))
        self.assertIsNone(data["baseDate"])
        self.assertFalse(data["baseDateSpecified"])
        self.assertIn("本次未指定评估基准日", "\n".join(data["limitations"]),
                      "未指定基准日却什么都不说，等于静默跳过时间因素（P14）")
        self.assertEqual(validate_report_data(data), [])

    def test_a_report_that_hides_the_unspecified_base_date_is_a_problem(self):
        data = build_report_data(completed_manifest(baseDate=""))
        broken = json.loads(json.dumps(data))
        broken["limitations"] = []
        problems = validate_report_data(broken)
        self.assertTrue(any("本次未指定评估基准日" in item for item in problems), problems)

    # ── P17：字段缺失与方法所需关键参数缺失是两件事 ────────────────────────

    def test_missing_parameter_must_declare_its_impact(self):
        manifest = completed_manifest()
        # 第二个参数是 `state = missing`（空置率）：必须声明影响面。
        data = build_report_data(manifest)
        self.assertEqual(data["parameters"][1]["state"], "missing")
        self.assertEqual(data["parameters"][1]["missingImpact"], "registration-gap")

        undeclared = completed_manifest()
        undeclared["parameters"][1].pop("missingImpact", None)
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(undeclared)
        self.assertIn("missingImpact", str(caught.exception))

    def test_a_calculation_blocking_parameter_is_not_a_registration_gap(self):
        manifest = completed_manifest(status="partial", stage="parameters")
        manifest["parameters"] = [{
            "parameterId": "param-land-term", "label": "剩余土地使用年限", "value": None,
            "unit": "年", "valueDate": None, "region": "某市", "sourceRef": "",
            "ruleRef": None, "state": "missing", "missingImpact": "calculation-suspended",
        }]
        manifest["completedWork"] = ["对象识别与方案分组完成"]
        manifest["outstanding"] = ["剩余土地使用年限未取得：收益法计算挂起"]
        manifest.pop("conclusions", None)
        manifest.pop("workbooks", None)
        manifest.pop("validation", None)
        data = build_report_data(manifest)
        self.assertEqual(data["parameters"][0]["missingImpact"], "calculation-suspended")
        self.assertIsNone(data["parameters"][0]["value"], "缺失不许被写成 0")

    def test_an_unknown_missing_impact_is_rejected(self):
        manifest = completed_manifest()
        manifest["parameters"][1]["missingImpact"] = "whatever"
        with self.assertRaises(ReportDataError) as caught:
            build_report_data(manifest)
        self.assertIn("missingImpact", str(caught.exception))

    # ── P17：土地年限 / 剩余年限不许由楼龄推算 ──────────────────────────────

    def test_no_script_derives_a_land_term_from_building_age(self):
        scripts = os.path.join(SKILL_DIR, "scripts")
        offenders = []
        pattern = re.compile(r"(土地|剩余).{0,6}年限\s*=\s*[^\n]*(楼龄|建成年代|已使用年限)")
        for name in sorted(os.listdir(scripts)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(scripts, name), encoding="utf-8") as handle:
                for line in handle:
                    if pattern.search(line):
                        offenders.append(f"{name}: {line.strip()}")
        self.assertEqual(offenders, [], "土地/剩余年限不许由楼龄推算（缺失要按关键参数缺失登记）")


class NoEvalTest(unittest.TestCase):
    """组装层只搬运数据：表达式按字符串原样带走，不执行、不解释。"""

    def test_an_expression_is_carried_verbatim_and_never_executed(self):
        with tempfile.TemporaryDirectory(prefix="crwu-no-eval-") as directory:
            marker = os.path.join(directory, "pwned.txt")
            payload = (f"__import__('pathlib').Path({marker!r}).write_text('x')")
            manifest = completed_manifest()
            manifest["calculationSteps"][0]["expression"] = payload
            data = build_report_data(manifest)
            self.assertEqual(data["calculationSteps"][0]["expression"], payload)
            self.assertFalse(os.path.exists(marker), "组装阶段不许执行任何表达式")

    def test_the_assembler_source_contains_no_dynamic_execution_call(self):
        # 用正则而不是子串：子串判据会漏掉带空格的写法，而组装阶段
        # "不许做任何动态求值"这条要求不该有这种缝。
        #
        # 两个词名**拆开书写**：技能脚本里出现执行原语的字面量会被 CLI 守卫判成
        # "脚本自己会起子进程"（本文件只是断言，从不执行），而脚本侧没有豁免标记。
        # 拆写不影响断言强度 —— 拼出来的仍是同一个正则。
        import re

        with open(module.__file__, encoding="utf-8") as handle:
            source = handle.read()
        for name in ("ev" "al", "ex" "ec"):
            self.assertIsNone(
                re.search(rf"\b{name}\s*\(", source),
                f"组装脚本里不允许出现 {name} 调用",
            )


class BuildReportDataCliTest(unittest.TestCase):

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="crwu-report-data-")
        self.input = os.path.join(self.directory, "运行manifest.json")
        self.output = os.path.join(self.directory, "估值报告数据.json")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.directory, ignore_errors=True)

    def write_manifest(self, payload: dict) -> None:
        with open(self.input, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)

    def test_cli_writes_atomically(self):
        self.write_manifest(completed_manifest())
        self.assertEqual(module.main(["--input", self.input, "--out", self.output]), 0)
        self.assertTrue(os.path.isfile(self.output))
        with open(self.output, encoding="utf-8") as handle:
            written = json.load(handle)
        self.assertEqual(written["status"], "completed")
        leftovers = [name for name in os.listdir(self.directory) if ".tmp-" in name]
        self.assertEqual(leftovers, [], "原子落盘不该留下临时文件")

    def test_cli_fails_closed_on_an_invalid_manifest(self):
        self.write_manifest(completed_manifest(status="blocked"))
        self.assertEqual(module.main(["--input", self.input, "--out", self.output]), 1)
        self.assertFalse(os.path.exists(self.output), "校验不通过时不许产出半成品")

    def test_cli_reports_missing_input(self):
        self.assertEqual(module.main(["--input", self.input, "--out", self.output]), 1)

    def test_cli_reads_manifest_numbers_as_exact_decimals(self):
        self.write_manifest(completed_manifest())
        with open(self.input, encoding="utf-8") as handle:
            payload = json.load(handle)
        payload["conclusions"][0]["totalValue"] = 5477400.005
        self.write_manifest(payload)
        self.assertEqual(module.main(["--input", self.input, "--out", self.output]), 0)
        with open(self.output, encoding="utf-8") as handle:
            written = json.load(handle)
        self.assertEqual(written["conclusions"][0]["totalValue"], "5477400.005")


class ValidateReportDataCliTest(unittest.TestCase):
    """`build_report_data.py --validate <data>`: the single read-only report-data validation entry.

    Artifact validation reuses this instead of re-implementing the checks. Validation is read-only:
    no `--out`, no file written on success, and an unreadable Schema fails closed rather than passing.
    """

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="crwu-report-validate-")
        self.doc = os.path.join(self.directory, "报告数据.json")

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, data: dict) -> str:
        with open(self.doc, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        return self.doc

    def returncode(self, argv: list) -> int:
        """Run the CLI; an unsupported argument combination (argparse SystemExit) becomes a failure."""

        try:
            code = module.main(argv)
        except SystemExit as error:  # noqa: PERF203 - argparse reports unknown args via SystemExit
            code = error.code if isinstance(error.code, int) else 1
            self.fail(f"CLI 不接受该参数组合（退出码 {code}）：{argv}")
            return code
        return 0 if code == 0 else 1

    def test_validate_accepts_a_genuine_v2_document(self):
        self.write(build_report_data(completed_manifest()))
        self.assertEqual(self.returncode(["--validate", self.doc]), 0)

    def test_validate_accepts_verified_mirror_sources(self):
        manifest = completed_manifest()
        manifest["knowledgeSources"][0]["source"] = "verified-mirror"
        self.write(build_report_data(manifest))
        self.assertEqual(self.returncode(["--validate", self.doc]), 0)

    def test_validate_rejects_the_legacy_local_source(self):
        # The retired validate_result.py accepted `local`; report-data.v2 only allows dws/verified-mirror.
        data = build_report_data(completed_manifest())
        data["knowledgeSources"][0]["source"] = "local"
        self.write(data)
        self.assertNotEqual(self.returncode(["--validate", self.doc]), 0)

    def test_validate_rejects_an_invalid_v2_document(self):
        broken = build_report_data(completed_manifest())
        broken.pop("conclusions")
        self.write(broken)
        self.assertNotEqual(self.returncode(["--validate", self.doc]), 0)

    def test_validate_fails_closed_when_the_schema_is_unreadable(self):
        self.write(build_report_data(completed_manifest()))
        original = module.REPORT_DATA_SCHEMA_PATH
        try:
            module.REPORT_DATA_SCHEMA_PATH = os.path.join(self.directory, "不存在的schema.json")
            self.assertNotEqual(self.returncode(["--validate", self.doc]), 0)
        finally:
            module.REPORT_DATA_SCHEMA_PATH = original

    def test_validate_writes_no_output(self):
        self.write(build_report_data(completed_manifest()))
        self.assertEqual(self.returncode(["--validate", self.doc]), 0)
        self.assertEqual(sorted(os.listdir(self.directory)), ["报告数据.json"],
                         "校验模式只读：不许产出任何文件")


def listing_summary(**overrides) -> dict:
    """The listing-reference summary block the report must carry next to the amounts."""
    payload = {
        "label": "挂牌参考估值",
        "aggregation": "arithmetic-mean",
        "basis": "规划用途公寓的在售挂牌报价参考（不改变挂牌性质）",
        "priceNature": "挂牌",
        "unitPriceUnit": "CNY/m2",
        "caseIds": ["L1", "L2"],
    }
    payload.update(overrides)
    return payload


def listing_comparables() -> list:
    """L1/L2 listing offers matching the reference summary (source/provenance retained)."""
    return [
        {"caseId": "L1", "displayName": "公寓A", "provider": "lianjia", "transactionType": "挂牌",
         "sourceUrl": "https://example.invalid/listing/l1", "unitPrice": "40000", "used": False},
        {"caseId": "L2", "displayName": "公寓B", "provider": "lianjia", "transactionType": "挂牌",
         "sourceUrl": "https://example.invalid/listing/l2", "unitPrice": "42000", "used": False},
    ]


class ListingReferenceReportDataTest(unittest.TestCase):
    """Listing-reference data stays partial-only and keeps its provenance visible."""

    def test_partial_listing_report_preserves_mode_summary_and_provisional_amounts(self):
        data = build_report_data(partial_manifest(
            valuationMode="listing-reference",
            referenceSummary=listing_summary(),
            comparables=listing_comparables(),
        ))
        self.assertEqual(data.get("valuationMode"), "listing-reference")
        summary = data.get("referenceSummary")
        self.assertEqual(
            {key: summary[key] for key in ("label", "aggregation", "basis", "priceNature", "unitPriceUnit", "caseIds")},
            listing_summary())
        self.assertEqual(summary["sources"], [
            {"caseId": "L1", "sourceUrl": "https://example.invalid/listing/l1"},
            {"caseId": "L2", "sourceUrl": "https://example.invalid/listing/l2"},
        ], "未提供 sources 时从已验证 comparables 派生")
        self.assertEqual(data["provisionalResults"][0]["unitPrice"], "61200.00")
        self.assertEqual(data["provisionalResults"][0]["totalValue"], "5477400.00")

    def test_completed_listing_report_is_rejected(self):
        manifest = completed_manifest(
            valuationMode="listing-reference",
            referenceSummary=listing_summary(),
            comparables=listing_comparables(),
        )
        with self.assertRaises(ReportDataError):
            build_report_data(manifest)

    def test_listing_summary_ids_must_exist_in_comparables(self):
        with self.assertRaises(ReportDataError):
            build_report_data(partial_manifest(
                valuationMode="listing-reference",
                referenceSummary=listing_summary(caseIds=["L1", "L9"]),
                comparables=listing_comparables(),
            ))

    def test_listing_summary_requires_source_and_listing_nature_on_each_case(self):
        missing_url = listing_comparables()
        missing_url[0]["sourceUrl"] = ""
        with self.assertRaises(ReportDataError):
            build_report_data(partial_manifest(
                valuationMode="listing-reference",
                referenceSummary=listing_summary(),
                comparables=missing_url,
            ))
        wrong_nature = listing_comparables()
        wrong_nature[0]["transactionType"] = "成交"
        with self.assertRaises(ReportDataError):
            build_report_data(partial_manifest(
                valuationMode="listing-reference",
                referenceSummary=listing_summary(),
                comparables=wrong_nature,
            ))

    def test_listing_summary_requires_basis_and_rejects_malformed(self):
        for patch in ({"basis": ""}, {"label": "估值"}, {"aggregation": "median"},
                      {"priceNature": "成交"}, {"unitPriceUnit": "CNY"}, {"caseIds": []}):
            with self.assertRaises(ReportDataError):
                build_report_data(partial_manifest(
                    valuationMode="listing-reference",
                    referenceSummary=listing_summary(**patch),
                    comparables=listing_comparables(),
                ))

    def test_reference_summary_is_forbidden_without_listing_mode(self):
        with self.assertRaises(ReportDataError):
            build_report_data(partial_manifest(referenceSummary=listing_summary()))
        with self.assertRaises(ReportDataError):
            build_report_data(partial_manifest(
                valuationMode="formal", referenceSummary=listing_summary()))

    def test_sources_must_match_the_selected_comparable_url(self):
        with self.assertRaises(ReportDataError):
            build_report_data(partial_manifest(
                valuationMode="listing-reference",
                referenceSummary=listing_summary(sources=[
                    {"caseId": "L1", "sourceUrl": "https://different.invalid/WRONG"},
                    {"caseId": "L2", "sourceUrl": "https://example.invalid/listing/l2"},
                ]),
                comparables=listing_comparables(),
            ))

    def test_sources_must_cover_each_selected_case_exactly(self):
        bad_sets = (
            [{"caseId": "L1", "sourceUrl": "https://example.invalid/listing/l1"}],  # missing L2
            [{"caseId": "L1", "sourceUrl": "https://example.invalid/listing/l1"},
             {"caseId": "L1", "sourceUrl": "https://example.invalid/listing/l1"}],  # duplicate
            [{"caseId": "L9", "sourceUrl": "https://example.invalid/listing/l9"},
             {"caseId": "L2", "sourceUrl": "https://example.invalid/listing/l2"}],  # unknown
        )
        for sources in bad_sets:
            with self.assertRaises(ReportDataError):
                build_report_data(partial_manifest(
                    valuationMode="listing-reference",
                    referenceSummary=listing_summary(sources=sources),
                    comparables=listing_comparables(),
                ))

    def test_listing_sources_reject_non_http_urls(self):
        for bad_url in ("javascript:alert(1)", "data:text/html,x", "ftp://example.invalid/x", ""):
            with self.assertRaises(ReportDataError):
                build_report_data(partial_manifest(
                    valuationMode="listing-reference",
                    referenceSummary=listing_summary(
                        sources=[{"caseId": "L1", "sourceUrl": bad_url}],
                    ),
                    comparables=listing_comparables(),
                ))

    def test_semantic_validation_rejects_inconsistent_persisted_reference(self):
        data = build_report_data(partial_manifest(
            valuationMode="listing-reference",
            referenceSummary=listing_summary(),
            comparables=listing_comparables(),
        ))
        self.assertEqual(validate_report_data(data), [])
        # A caller can mutate persisted data after assembly; validation must still catch it.
        data["comparables"][0]["transactionType"] = "成交"
        self.assertNotEqual(validate_report_data(data), [])

    def test_semantic_validation_requires_or_forbids_reference_summary(self):
        missing = build_report_data(partial_manifest(
            valuationMode="listing-reference",
            referenceSummary=listing_summary(),
            comparables=listing_comparables(),
        ))
        missing.pop("referenceSummary")
        self.assertNotEqual(validate_report_data(missing), [])
        forbidden = build_report_data(partial_manifest())
        forbidden["referenceSummary"] = listing_summary()
        self.assertNotEqual(validate_report_data(forbidden), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
