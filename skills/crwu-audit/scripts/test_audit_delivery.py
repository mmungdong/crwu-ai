#!/usr/bin/env python3
"""AuditResult 校验与 HTML 渲染的契约测试（送达规范 v1.0）。

运行：python3 skills/crwu-audit/scripts/test_audit_delivery.py
"""

from __future__ import annotations

import ast
import contextlib
import copy
import html
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import audit_delivery as delivery  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]  # skills/<skill>/scripts/<file>
MODULE_PATH = Path(__file__).resolve().parent / "audit_delivery.py"
SAMPLE_PATH = Path(__file__).resolve().parent / "examples" / "audit-result.sample.json"

REGION_ORDER = [
    "project-info",
    "summary",
    "actionable-issues",
    "manual-confirmation-items",
    "audit-basis",
    "review-comparison",
    "scope-and-not-checked",
    "professional-trail",
    "file-trace",
]


def load_sample() -> dict:
    with SAMPLE_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def module_string_constants() -> set:
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
    values = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            values.add(node.value)
    return values


def strip_css_and_scripts(document: str) -> str:
    document = re.sub(r"<style>.*?</style>", " ", document, flags=re.S)
    document = re.sub(r"<script.*?</script>", " ", document, flags=re.S)
    return document


def text_nodes(document: str):
    body = strip_css_and_scripts(document)
    for raw in re.findall(r">([^<>]+)<", body):
        value = html.unescape(raw).strip()
        if value:
            yield value


class AuditResultValidationTest(unittest.TestCase):
    def test_sample_passes(self):
        self.assertEqual([], delivery.validate(load_sample()))

    def test_missing_material_evidence_is_rejected(self):
        result = load_sample()
        result["issues"][0]["materialEvidence"] = []
        errors = delivery.validate(result)
        self.assertTrue(any("materialEvidence 至少一条" in error for error in errors), errors)

    def test_rule_defect_fail_requires_rule_evidence(self):
        result = load_sample()
        result["issues"][0]["ruleEvidence"] = []
        result["auditBasis"]["rules"][0]["usedByIssueIds"] = []
        result["auditBasis"]["rules"][0]["usageCount"] = 0
        errors = delivery.validate(result)
        self.assertTrue(any("必须同时具备规则证据与材料证据" in error for error in errors), errors)

    def test_counts_must_be_recomputable(self):
        result = load_sample()
        result["summary"]["counts"]["fail"] = 0
        errors = delivery.validate(result)
        self.assertTrue(any("summary.counts.fail" in error for error in errors), errors)

    def test_phase_order_is_enforced(self):
        result = load_sample()
        result["phaseControl"]["reviewAccessedAt"] = "2026-09-09T09:00:00+08:00"
        errors = delivery.validate(result)
        self.assertTrue(any("reviewAccessedAt 必须晚于 phase1FrozenAt" in error for error in errors), errors)

    def test_phase2_requires_review_comparison_per_issue(self):
        result = load_sample()
        result["issues"][0]["reviewComparison"] = {"status": "not_performed"}
        errors = delivery.validate(result)
        self.assertTrue(any("必须具有 reviewComparison" in error for error in errors), errors)

    def test_external_formal_must_not_claim_current_version(self):
        result = load_sample()
        rule = result["auditBasis"]["rules"][0]
        rule["version"] = "现行"
        errors = delivery.validate(result)
        self.assertTrue(any("不得宣称" in error for error in errors), errors)

    def test_usage_count_and_used_by_are_recomputed(self):
        result = load_sample()
        result["auditBasis"]["rules"][0]["usageCount"] = 7
        errors = delivery.validate(result)
        self.assertTrue(any("usageCount 必须可由明细重算" in error for error in errors), errors)

    def test_review_bands_must_match_details(self):
        result = load_sample()
        result["reviewComparison"]["bands"]["overlap"] = 0
        errors = delivery.validate(result)
        self.assertTrue(any("bands.overlap" in error for error in errors), errors)

    def test_kb_relative_path_must_be_relative(self):
        result = load_sample()
        result["auditBasis"]["rules"][0]["kbRelativePath"] = "/Users/example/kb/rule.md"
        errors = delivery.validate(result)
        self.assertTrue(any("kbRelativePath" in error or "绝对路径" in error for error in errors), errors)

    def test_absolute_path_and_node_id_are_forbidden(self):
        result = load_sample()
        result["issues"][0]["problemDescription"] = "见 /Users/example/报告.docx"
        errors = delivery.validate(result)
        self.assertTrue(any("绝对路径" in error for error in errors), errors)

        result = load_sample()
        result["auditTask"]["profile"]["routeProfile"] = {"nodeId": "abc123"}
        errors = delivery.validate(result)
        self.assertTrue(any("nodeId" in error for error in errors), errors)

    def test_not_checked_reason_code_enum(self):
        result = load_sample()
        result["scope"]["notCheckedItems"][0]["reasonCode"] = "whatever"
        errors = delivery.validate(result)
        self.assertTrue(any("reasonCode 取值非法" in error for error in errors), errors)


class AuditResultRenderTest(unittest.TestCase):
    def setUp(self):
        self.result = load_sample()
        self.document = delivery.render(self.result)

    def test_sections_in_required_order(self):
        positions = []
        for region in REGION_ORDER:
            index = self.document.find('id="{0}"'.format(region))
            self.assertNotEqual(-1, index, "缺少区域 {0}".format(region))
            positions.append(index)
        self.assertEqual(sorted(positions), positions, "区域顺序必须符合 §3 交付结构")

    def test_self_contained_and_offline_safe(self):
        for token in ("http://", "https://", "<link", "script src", "@import"):
            self.assertNotIn(token, self.document)
        self.assertIn("<style>", self.document)
        self.assertIn('type="application/json"', self.document)

    def test_a4_print_and_black_white_readability(self):
        self.assertIn("@page { size: A4", self.document)
        self.assertIn("break-inside: avoid", self.document)
        self.assertIn("thead { display: table-header-group; }", self.document)
        for issue in self.result["issues"]:
            label = delivery.SEVERITY_LABEL[issue["severity"]]
            self.assertIn('<span class="severity-label">{0}</span>'.format(label), self.document)
        for severity in delivery.SEVERITY_CLASS.values():
            self.assertIn(severity, self.document)

    def test_professional_trail_folded_by_default(self):
        self.assertIn('<details id="professional-trail">', self.document)

    def test_embedded_json_matches_digests(self):
        match = re.search(
            r'<script id="audit-result" type="application/json">(.*?)</script>', self.document, re.S
        )
        self.assertIsNotNone(match)
        embedded = json.loads(match.group(1).replace("<\\/", "</"))
        file_trace = embedded["fileTrace"]
        self.assertEqual(delivery.RENDERER_VERSION, file_trace["rendererVersion"])
        without_digests = copy.deepcopy(embedded)
        without_digests["fileTrace"]["sourceDigest"] = ""
        without_digests["fileTrace"]["embeddedJsonDigest"] = ""
        self.assertEqual(delivery.sha256_hex(delivery.canonical_json(without_digests)), file_trace["sourceDigest"])
        with_source = copy.deepcopy(embedded)
        with_source["fileTrace"]["embeddedJsonDigest"] = ""
        self.assertEqual(delivery.sha256_hex(delivery.canonical_json(with_source)), file_trace["embeddedJsonDigest"])
        self.assertEqual([], delivery.validate(embedded, rendered=True, expect_renderer=True))

    def test_render_is_deterministic(self):
        self.assertEqual(self.document, delivery.render(load_sample()))

    def test_dynamic_content_is_escaped(self):
        result = load_sample()
        payload = "<script>alert(1)</script>"
        result["issues"][0]["problemDescription"] = payload
        document = delivery.render(result)
        self.assertNotIn(payload, document)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", document)
        # 嵌入 JSON 必须安全转义 <，全文只能有本页面自己的一个结束标签
        self.assertEqual(1, document.count("</script>"))
        self.assertIn("\\u003cscript>alert(1)", document)

    def test_empty_lists_show_explicit_message(self):
        result = load_sample()
        result["manualConfirmationItems"] = []
        result["summary"]["counts"]["pendingConfirmation"] = 0
        result["reviewComparison"]["status"] = "not_performed"
        result["reviewComparison"]["bands"] = {"overlap": 0, "aiOnly": 0, "divergent": 0, "reviewerOnly": 0}
        result["reviewComparison"]["reviewerOnlyItems"] = []
        for issue in result["issues"]:
            issue["reviewComparison"] = {"status": "not_performed"}
        result["scope"]["notCheckedItems"] = []
        result["summary"]["counts"]["notChecked"] = 0
        result["professionalTrail"]["adjudications"] = []
        result["professionalTrail"]["checkRecords"] = []
        self.assertEqual([], delivery.validate(result))
        document = delivery.render(result)
        self.assertIn(delivery.EMPTY_TEXT, document)
        self.assertIn("需要人工确认事项", document)
        self.assertIn("未检查项", document)

    def test_renderer_does_not_author_business_text(self):
        """文本节点只能来自受控标签常量或输入数据，不得拼接出新句子（§12.2 / §10.3）。"""
        allowed = set(module_string_constants())
        for scalar in delivery.iter_all_scalars(self.result):
            allowed.add(scalar)

        def collect(value):
            if isinstance(value, dict):
                for item in value.values():
                    collect(item)
            elif isinstance(value, list):
                allowed.add("、".join(str(item) for item in value))
                for item in value:
                    collect(item)

        collect(self.result)
        for node in text_nodes(self.document):
            if re.fullmatch(r"[0-9a-f]{64}", node):
                continue  # 渲染期计算的来源/嵌入摘要，可由输入确定性重算
            self.assertIn(node, allowed, "渲染器生成了非标签/非数据的文本：{0}".format(node))


class AuditDeliveryCliTest(unittest.TestCase):
    """编排层调用的三个子命令：validate / digest / render。"""

    def test_digest_matches_canonical_sha256(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = delivery.main(["digest", str(SAMPLE_PATH)])
        self.assertEqual(0, code)
        expected = delivery.sha256_hex(delivery.canonical_json(load_sample()))
        self.assertEqual(expected, buffer.getvalue().strip())

    def test_validate_cli_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, delivery.main(["validate", str(SAMPLE_PATH)]))
        broken = load_sample()
        broken["issues"][0]["materialEvidence"] = []
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.json"
            path.write_text(json.dumps(broken, ensure_ascii=False), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(1, delivery.main(["validate", str(path)]))

    def test_render_cli_refuses_invalid_input(self):
        broken = load_sample()
        broken["summary"]["counts"]["fail"] = 99
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.json"
            out = Path(tmp) / "out.html"
            path.write_text(json.dumps(broken, ensure_ascii=False), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(1, delivery.main(["render", str(path), "--out", str(out)]))
            self.assertFalse(out.exists(), "校验失败时不得产出 HTML")


if __name__ == "__main__":
    unittest.main(verbosity=2)
