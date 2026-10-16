#!/usr/bin/env python3
"""`build_report.py` 渲染层的契约测试：数据驱动、转义、图片证据与离线可用。

钉住的是"报告看起来对、其实在骗人"的几种失效模式：

- 中断 / 未定稿报告却显示了正式结论或金额；
- 外部标题、小区名、来源 URL 直接拼进 HTML（注入点）；
- 案例截图文件不存在或指纹不符，报告照样"完成"；
- 图片相对路径用 `../` 或符号链接逃到案例目录之外；
- 内嵌 JSON 提前闭合 `script`；
- 引了 CDN，离线打开就白屏；
- 渲染器又做了一次四舍五入。

夹具（PNG、各状态 manifest）来自同目录的 `test_report_data.py`；不读用户文件、不联网。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import unittest
from urllib.parse import quote, unquote

import build_report as renderer
import test_report_data as fixtures
from build_report import ReportRenderError, render_report
from build_report_data import build_report_data

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
TEMPLATE = os.path.join(SKILL_DIR, "template", "valuation-report.html")

RELATIVE_SHOT = "推理结果/图片/case-001-阳光小区/链家-详情.png"


class RenderReportTest(unittest.TestCase):

    def setUp(self):
        self.case_root = tempfile.mkdtemp(prefix="crwu-report-case-")
        self.digest = fixtures.write_shot(self.case_root, RELATIVE_SHOT)

    def tearDown(self):
        shutil.rmtree(self.case_root, ignore_errors=True)

    # -- 夹具 ---------------------------------------------------------------

    def completed_with_shot(self, relative: str = RELATIVE_SHOT, digest: str | None = None,
                            validity: str = "valid", case_id: str = "case-001", **overrides):
        shot = fixtures.screenshot(case_id=case_id, relative=relative,
                                   digest=digest if digest is not None else self.digest,
                                   validity=validity)
        comparables = overrides.pop("comparables", None)
        if comparables is None:
            comparables = fixtures.completed_manifest()["comparables"]
        comparables = json.loads(json.dumps(comparables))
        comparables[0]["screenshots"] = [dict(shot)]
        manifest = fixtures.completed_manifest(evidence=[dict(shot)], comparables=comparables,
                                               **overrides)
        return build_report_data(manifest)

    def render(self, data, case_root: str | None = None) -> str:
        return render_report(data, TEMPLATE, self.case_root if case_root is None else case_root)

    # -- 计划指定的三条关键断言 ---------------------------------------------

    def test_blocked_report_says_it_is_unfinished(self):
        data = build_report_data(fixtures.blocked_manifest())
        body = self.render(data)
        self.assertIn("本次估值未完成", body)

    def test_an_external_title_cannot_inject_a_script(self):
        data = self.completed_with_shot()
        data["objects"][0]["displayName"] = "<script>alert(1)</script>"
        data["comparables"][0]["displayName"] = '<img src=x onerror=alert(1)>'
        body = self.render(data)
        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertNotIn("<img src=x", body)
        self.assertIn("&lt;script&gt;", body)

    def test_a_verified_screenshot_is_embedded_as_a_data_uri(self):
        body = self.render(self.completed_with_shot())
        self.assertIn("data:image/png;base64,", body)

    # -- 状态控制展示 -------------------------------------------------------

    def test_blocked_renders_without_method_template_or_amounts(self):
        data = build_report_data(fixtures.blocked_manifest())
        self.assertIsNone(data["method"])
        body = self.render(data)
        self.assertIn("本次估值未完成", body)
        self.assertIn("知识缺失", body)
        self.assertNotIn('data-conclusion="final"', body)
        self.assertNotIn("评估总价", body, "中断报告不该有任何结论表")
        self.assertNotIn("暂算", body)
        self.assertIn("data-report-status=\"blocked\"", body)

    def test_blocked_process_material_is_shown_as_not_a_conclusion(self):
        manifest = fixtures.blocked_manifest(partialObjectResults=[{
            "objectId": "object-001", "displayName": "阳光小区 3 号楼 601",
            "valueScope": "land-and-building", "method": "market", "unitPrice": "61200.00",
            "totalValue": "5477400.00", "currency": "CNY", "calculationRef": "step-2",
        }])
        body = self.render(build_report_data(manifest))
        self.assertIn("过程值，不是结论", body)
        self.assertIn("5477400.00", body)
        self.assertNotIn('data-conclusion="final"', body)

    def test_partial_shows_provisional_amounts_never_a_final_conclusion(self):
        data = build_report_data(fixtures.partial_manifest())
        body = self.render(data)
        self.assertIn('data-conclusion="provisional"', body)
        self.assertNotIn('data-conclusion="final"', body)
        self.assertIn("暂算", body)
        self.assertIn("未定稿", body)
        self.assertIn("5477400.00", body)
        self.assertIn("重算能力缺失", body)

    def test_failed_and_cancelled_list_the_stage_and_never_claim_completion(self):
        cases = [
            (fixtures.failed_manifest(), "本次估值未能完成", "案例取数"),
            (fixtures.cancelled_manifest(), "本次估值已取消", "案例取数"),
        ]
        for manifest, headline, stage in cases:
            with self.subTest(status=manifest["status"]):
                data = build_report_data(manifest)
                body = self.render(data)
                self.assertIn(headline, body)
                self.assertIn(stage, body)
                self.assertNotIn("本轮估值已完成", body)
                self.assertNotIn('data-conclusion="final"', body)
                self.assertIn("方案/plan-004/估值状态.json", body)

    # -- 完整可复核过程 -----------------------------------------------------

    def test_the_page_carries_the_whole_reviewable_chain(self):
        body = self.render(self.completed_with_shot())
        for needle in (
            "事实来源与输入", "资料清单", "适用规则与方法理由", "正文指纹", "节 ID", "规则 ID",
            "取数轨迹", "挑战恢复摘要", "案例筛选", "保留理由", "剔除理由", "参数依据",
            "公式与中间值", "代入值", "规则校验", "限制与缺口", "交付件与校验回执",
            "finalize 校验回执", "阻断项与补齐动作",
        ):
            self.assertIn(needle, body, f"报告缺少可复核要素：{needle}")
        # 数据本身也要出现：知识 routeId + digest、公式 ID、来源 URL。
        self.assertIn("realestate.common", body)
        self.assertIn(fixtures.DIGEST_C, body)
        self.assertIn("F-2", body)
        self.assertIn("https://example.invalid/detail/1", body)
        self.assertIn("cooldown-renavigate", body)

    def test_the_page_shows_a_per_method_result_table(self):
        """协议 39：报告要能让读者看到**每个方法各自的结论**，而不是只看到一个合成数。

        组合方法时如果只渲染一个数，读者会以为多方法被加权或相加了 —— 那正是这一版要挡掉的口径。
        """
        manifest = self.completed_with_shot()
        manifest["methods"] = ["market", "income"]
        manifest["methodResults"] = [
            {"method": "market", "basis": "同小区 3 条可核成交案例",
             "unitPrice": "60000.00", "totalValue": "5370000.00", "template": "template/valuation-workbook.xlsx"},
            {"method": "income", "basis": "租赁合同与完整租金序列",
             "unitPrice": "58800.00", "totalValue": "5262600.00", "template": "template/valuation-workbook.xlsx"},
        ]
        body = self.render(manifest)
        self.assertIn("逐方法结果", body)
        self.assertIn("不相加、不默认平均", body)
        self.assertIn("市场法", body)
        self.assertIn("收益法", body)
        # 两个方法各自的数字都要逐字出现（不取整、不相加）。
        self.assertIn("60000.00", body)
        self.assertIn("58800.00", body)
        self.assertNotIn("10632600", body)  # 5,370,000 + 5,262,600 —— 相加就是重复计价

    def test_the_validation_receipt_is_shown_without_misreading_this_render(self):
        body = self.render(self.completed_with_shot())
        self.assertIn("finalize 校验回执", body)
        self.assertIn("本轮渲染（回执生成时尚未渲染）", body)
        self.assertIn("knowledgeVerified", body)
        self.assertIn("截图与来源页面指纹一致", body)

    def test_amounts_are_never_rounded_or_thousands_separated(self):
        data = self.completed_with_shot()
        body = self.render(data)
        self.assertIn("5477400.00", body)
        self.assertNotIn("5,477,400", body)
        self.assertIn("61200.00", body)

    # -- 转义与安全 ---------------------------------------------------------

    def test_embedded_json_cannot_close_the_script_tag(self):
        data = self.completed_with_shot()
        data["objects"][0]["displayName"] = "</script><script>alert(2)</script>"
        body = self.render(data)
        self.assertNotIn("</script><script>alert(2)", body)
        self.assertIn("<\\/script>", body)

    def test_embedded_json_round_trips(self):
        data = self.completed_with_shot()
        body = self.render(data)
        match = re.search(
            r'<script type="application/json" id="crwu-report-data">(.*?)</script>', body, re.S)
        self.assertIsNotNone(match, "报告必须内嵌可解析的报告数据 JSON")
        embedded = json.loads(match.group(1))
        self.assertEqual(embedded, data)

    def test_links_are_limited_to_http_and_https(self):
        data = self.completed_with_shot()
        data["comparables"][0]["sourceUrl"] = "javascript:alert(1)"
        body = self.render(data)
        self.assertNotIn('href="javascript:', body)

    # -- 图片证据 -----------------------------------------------------------

    def test_the_page_keeps_the_relative_path_and_digest_for_every_image(self):
        body = self.render(self.completed_with_shot())
        self.assertIn(RELATIVE_SHOT, body)
        self.assertIn(self.digest, body)
        self.assertIn("data-preview-source", body)

    def test_a_missing_image_refuses_to_render_a_completed_report(self):
        data = self.completed_with_shot(relative="推理结果/图片/case-001-阳光小区/不存在.png")
        with self.assertRaises(ReportRenderError) as caught:
            self.render(data)
        self.assertIn("不存在", str(caught.exception))

    def test_a_wrong_digest_refuses_to_render_a_completed_report(self):
        data = self.completed_with_shot(digest="sha256:" + "0" * 64)
        with self.assertRaises(ReportRenderError) as caught:
            self.render(data)
        self.assertIn("digest 不符", str(caught.exception))

    def test_an_invalid_validity_refuses_to_render_a_completed_report(self):
        data = self.completed_with_shot(validity="missing")
        with self.assertRaises(ReportRenderError) as caught:
            self.render(data)
        self.assertIn("validity=missing", str(caught.exception))

    def test_a_not_required_screenshot_does_not_block_completed(self):
        manifest = fixtures.completed_manifest()
        # `validity=not-required` 表示规则未要求截图：没有图片要读，也就不该阻断完成报告。
        shot = fixtures.screenshot(relative="推理结果/图片/case-001-阳光小区/未要求.png",
                                   digest=fixtures.DIGEST_B, validity="not-required")
        manifest["evidence"] = [shot]
        body = self.render(build_report_data(manifest))
        self.assertIn("规则未要求截图", body)
        self.assertNotIn("data:image/png;base64,", body)


    def test_parent_directory_escape_is_refused(self):
        outside = os.path.join(self.case_root, "..", "outside-crwu", "偷跑.png")
        data = self.completed_with_shot(relative="../../outside-crwu/偷跑.png")
        with self.assertRaises(ReportRenderError) as caught:
            self.render(data)
        self.assertIn("越界", str(caught.exception))
        self.assertFalse(os.path.exists(outside))

    def test_a_symlink_escape_is_refused(self):
        outside_dir = tempfile.mkdtemp(prefix="crwu-outside-")
        try:
            outside = os.path.join(outside_dir, "外部.png")
            with open(outside, "wb") as handle:
                handle.write(fixtures.png_bytes())
            link_relative = "推理结果/图片/case-001-阳光小区/链家-详情.png"
            link = os.path.join(self.case_root, link_relative)
            os.makedirs(os.path.dirname(link), exist_ok=True)
            if os.path.lexists(link):
                os.remove(link)
            try:
                os.symlink(outside, link)
            except (OSError, NotImplementedError) as error:  # pragma: no cover - 平台差异
                self.skipTest(f"本机不支持创建符号链接：{error}")
            data = self.completed_with_shot(relative=link_relative)
            with self.assertRaises(ReportRenderError) as caught:
                self.render(data)
            self.assertIn("符号链接逃逸", str(caught.exception))
        finally:
            shutil.rmtree(outside_dir, ignore_errors=True)

    def test_the_evidence_directory_must_match_the_case_id(self):
        relative = "推理结果/图片/case-999-别的案例/链家-详情.png"
        digest = fixtures.write_shot(self.case_root, relative)
        data = self.completed_with_shot(relative=relative, digest=digest)
        with self.assertRaises(ReportRenderError) as caught:
            self.render(data)
        self.assertIn("caseId", str(caught.exception))

    def test_a_non_completed_report_shows_the_missing_image_instead_of_reading_it(self):
        data = build_report_data(fixtures.partial_manifest())
        data["comparables"] = [{
            "caseId": "case-001", "displayName": "阳光小区 3室2厅", "provider": "链家",
            "sourceUrl": "https://example.invalid/detail/1", "transactionType": "挂牌",
            "publishedAt": "2026-09-01", "unitPrice": "60000.00", "buildingArea": "90.0",
            "used": False, "keepReason": "", "dropReason": "暂未采用",
            "screenshots": [fixtures.screenshot(relative="../../越界/图.png", digest="sha256:x",
                                                validity="missing")],
        }]
        body = self.render(data)
        self.assertIn("图片未内嵌", body)
        self.assertIn("越界", body)
        self.assertNotIn("data:image/png;base64,", body)
        self.assertNotIn('href="' + quote("../../越界/图.png", safe="/") + '"', body,
                         "未核或越界的图片只能显示位置，不能提供可点击入口")

    def test_a_missing_case_root_is_refused(self):
        data = self.completed_with_shot()
        with self.assertRaises(ReportRenderError) as caught:
            render_report(data, TEMPLATE, os.path.join(self.case_root, "没有这个目录"))
        self.assertIn("案例目录不存在", str(caught.exception))

    # -- 离线、主题、打印、键盘 ---------------------------------------------

    def test_the_page_is_offline_capable_and_does_not_reference_a_cdn(self):
        body = self.render(self.completed_with_shot())
        self.assertNotIn("<link", body)
        self.assertNotIn("<script src=", body)
        self.assertNotIn("@import", body)
        self.assertIsNone(re.search(r'src\s*=\s*"https?://', body), "图片与脚本都不许引外部地址")
        self.assertNotIn("cdn.", body.lower())
        self.assertIn("data:image/png;base64,", body, "图片必须内嵌，转发单个 HTML 不丢图")

    def test_dark_theme_print_and_keyboard_hooks_are_present(self):
        body = self.render(self.completed_with_shot())
        self.assertIn("data-ds-dark-theme", body)
        self.assertIn("@media (prefers-color-scheme: dark)", body)
        self.assertIn(':not([data-ds-theme="light"])', body,
                      "系统深色回退不许覆盖显式主题")
        self.assertIn("@media print", body)
        self.assertIn("page-break-inside:avoid", body)
        self.assertIn("page-break-inside:auto", body)
        self.assertIn("beforeprint", body, "打印前要自动展开折叠的长过程")
        self.assertIn("Escape", body)
        self.assertIn("showModal", body)

    # -- 模板与数据的契约 ---------------------------------------------------

    def test_an_unknown_slot_in_the_template_fails_instead_of_leaking(self):
        with tempfile.TemporaryDirectory(prefix="crwu-template-") as directory:
            path = os.path.join(directory, "broken.html")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("<html><body>{{notASlot}}{{dataJson}}</body></html>")
            data = self.completed_with_shot()
            with self.assertRaises(ReportRenderError) as caught:
                render_report(data, path, self.case_root)
            self.assertIn("数据槽", str(caught.exception))

    def test_a_template_without_the_data_slot_fails(self):
        with tempfile.TemporaryDirectory(prefix="crwu-template-") as directory:
            path = os.path.join(directory, "no-json.html")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("<html><body>没有数据槽</body></html>")
            with self.assertRaises(ReportRenderError) as caught:
                render_report(self.completed_with_shot(), path, self.case_root)
            self.assertIn("dataJson", str(caught.exception))

    def test_an_unclosed_conditional_block_fails(self):
        with tempfile.TemporaryDirectory(prefix="crwu-template-") as directory:
            path = os.path.join(directory, "unclosed.html")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("<html><!--IF status=completed--><p>x</p>{{dataJson}}</html>")
            with self.assertRaises(ReportRenderError):
                render_report(self.completed_with_shot(), path, self.case_root)

    def test_a_schema_invalid_report_is_refused_before_rendering(self):
        data = self.completed_with_shot()
        data.pop("workbooks")
        with self.assertRaises(ReportRenderError) as caught:
            self.render(data)
        self.assertIn("workbooks", str(caught.exception))

    def test_renderer_never_uses_eval(self):
        with open(renderer.__file__, encoding="utf-8") as handle:
            source = handle.read()
        for token in ("eval(", "exec("):
            self.assertNotIn(token, source, f"渲染脚本里不允许出现 {token}")

    # -- 详情证据：真实详情 URL + 可点击的相对图片 -----------------------------

    def test_the_detail_url_is_full_clickable_text_not_just_a_case_name(self):
        url = "https://example.invalid/detail/阳光 小区?id=7"
        data = self.completed_with_shot()
        data["comparables"][0]["sourceUrl"] = url
        body = self.render(data)
        self.assertIn(f">{url}<", body, "读者必须能看到完整详情 URL 文本")
        self.assertRegex(body, r'<a[^>]+href="https://example\.invalid/detail/[^"]*"',
                         "详情 URL 必须是可点击链接")

    def test_the_local_screenshot_is_a_clickable_relative_link(self):
        body = self.render(self.completed_with_shot())
        candidates = {f'href="{RELATIVE_SHOT}"', f'href="{quote(RELATIVE_SHOT, safe="/")}"'}
        self.assertTrue(any(candidate in body for candidate in candidates),
                        "本地截图路径必须渲染成可点击的相对链接")
        self.assertNotRegex(body, r'href="(/|[A-Za-z]:)', "不能出现绝对路径或盘符链接")

    def test_a_relative_image_link_with_unicode_and_space_stays_relative(self):
        relative = "推理结果/图片/case-001-阳光 小区/详情 图.png"
        digest = fixtures.write_shot(self.case_root, relative)
        body = self.render(self.completed_with_shot(relative=relative, digest=digest))
        candidates = {f'href="{relative}"', f'href="{quote(relative)}"', f'href="{quote(relative, safe="/")}"'}
        self.assertTrue(any(candidate in body for candidate in candidates),
                        "含 unicode / 空格的相对图片路径必须可点击且保持相对")
        self.assertNotRegex(body, r'href="(/|[A-Za-z]:)', "不能出现绝对路径或盘符链接")

    def test_a_list_page_url_is_shown_verbatim_not_as_detail(self):
        list_url = "https://bj.lianjia.com/ershoufang/pg1/"
        data = self.completed_with_shot()
        data["comparables"][0]["screenshots"][0]["sourceUrl"] = list_url
        body = self.render(data)
        self.assertIn(list_url, body, "列表页截图的 URL 必须原样显示，不能被当成详情页 URL")
        detail_links = re.findall(r'href="(https://example\.invalid/detail/[^"]*)"', body)
        self.assertNotIn(list_url, detail_links, "列表页 URL 不得被改写成详情页链接")


class RenderReportCliTest(unittest.TestCase):

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="crwu-report-cli-")
        self.data_path = os.path.join(self.directory, "估值报告数据.json")
        self.out = os.path.join(self.directory, "估值报告.html")
        digest = fixtures.write_shot(self.directory, RELATIVE_SHOT)
        shot = fixtures.screenshot(relative=RELATIVE_SHOT, digest=digest)
        manifest = fixtures.completed_manifest(evidence=[shot])
        manifest["comparables"][0]["screenshots"] = [dict(shot)]
        self.data = build_report_data(manifest)
        with open(self.data_path, "w", encoding="utf-8") as handle:
            json.dump(self.data, handle, ensure_ascii=False)

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_cli_renders_atomically_and_refuses_to_clobber(self):
        self.assertEqual(renderer.main(["--data", self.data_path, "--out", self.out,
                                        "--case-root", self.directory]), 0)
        self.assertTrue(os.path.isfile(self.out))
        leftovers = [name for name in os.listdir(self.directory) if ".tmp-" in name]
        self.assertEqual(leftovers, [], "原子落盘不该留下临时文件")
        self.assertEqual(renderer.main(["--data", self.data_path, "--out", self.out]), 1,
                         "默认不许覆盖人读件")
        self.assertEqual(renderer.main(["--data", self.data_path, "--out", self.out,
                                        "--force", "--case-root", self.directory]), 0)

    def test_cli_derives_a_case_root_from_a_not_yet_existing_output_directory(self):
        manifest = fixtures.completed_manifest()
        data_path = os.path.join(self.directory, "无图报告数据.json")
        with open(data_path, "w", encoding="utf-8") as handle:
            json.dump(build_report_data(manifest), handle, ensure_ascii=False)
        out = os.path.join(self.directory, "方案", "plan-001", "估值报告.html")
        self.assertEqual(renderer.main(["--data", data_path, "--out", out]), 0)
        self.assertTrue(os.path.isfile(out))

    def test_cli_refuses_to_write_into_the_template(self):
        self.assertEqual(renderer.main(["--data", self.data_path, "--out", TEMPLATE]), 1)

    def test_cli_refuses_an_unknown_legacy_result_flag(self):
        # The v1 `--result` entry is retired; the CLI only accepts report-data.v2 via `--data`.
        with self.assertRaises(SystemExit) as caught:
            renderer.main(["--result", self.data_path, "--out", self.out])
        self.assertEqual(caught.exception.code, 2)

    def test_cli_nested_output_keeps_relative_image_links_resolvable(self):
        case_root = os.path.join(self.directory, "案例-根")
        relative = "推理结果/图片/case-001-阳光 小区/详情 图.png"
        digest = fixtures.write_shot(case_root, relative)
        shot = fixtures.screenshot(relative=relative, digest=digest)
        manifest = fixtures.completed_manifest(evidence=[shot])
        manifest["comparables"][0]["screenshots"] = [dict(shot)]
        data_path = os.path.join(self.directory, "嵌套数据.json")
        with open(data_path, "w", encoding="utf-8") as handle:
            json.dump(build_report_data(manifest), handle, ensure_ascii=False)
        out = os.path.join(case_root, "方案", "plan-001", "估值报告.html")
        self.assertEqual(renderer.main(["--data", data_path, "--out", out,
                                        "--case-root", case_root]), 0)
        with open(out, encoding="utf-8") as handle:
            body = handle.read()
        hrefs = re.findall(r'href="([^"]+\.png)"', body)
        self.assertTrue(hrefs, "HTML 要渲染可点击的本地图片相对链接")
        actual = os.path.normpath(os.path.join(case_root, relative))
        resolved = [os.path.normpath(os.path.join(os.path.dirname(out), unquote(href))) for href in hrefs]
        self.assertIn(actual, resolved, "本地图片链接必须从 HTML 父目录解析到真实图片")
        for href in hrefs:
            self.assertFalse(href.startswith(("/", "file:")), f"不许绝对路径：{href}")


def listing_reference_manifest(source_url="https://example.invalid/listing/l1"):
    return fixtures.partial_manifest(
        valuationMode="listing-reference",
        referenceSummary={
            "label": "挂牌参考估值",
            "aggregation": "arithmetic-mean",
            "basis": "规划用途公寓的在售挂牌报价参考（不改变挂牌性质）",
            "priceNature": "挂牌",
            "unitPriceUnit": "CNY/m2",
            "caseIds": ["L1"],
            "sources": [{"caseId": "L1", "sourceUrl": source_url}],
        },
        comparables=[{
            "caseId": "L1", "displayName": "公寓A", "provider": "lianjia",
            "transactionType": "挂牌", "sourceUrl": source_url, "unitPrice": "40000", "used": False,
        }],
    )


class ListingReferenceRenderTest(unittest.TestCase):
    """The listing-reference label and source links are visible, not buried in JSON."""

    def setUp(self):
        self.case_root = tempfile.mkdtemp(prefix="crwu-listing-render-")

    def tearDown(self):
        shutil.rmtree(self.case_root, ignore_errors=True)

    def test_listing_reference_label_is_visible_next_to_the_amounts(self):
        data = build_report_data(listing_reference_manifest())
        html = render_report(data, TEMPLATE, self.case_root)
        visible = re.sub(r"<script[\s\S]*?</script>", "", html, flags=re.IGNORECASE)
        self.assertIn("挂牌参考估值", visible)

    def test_listing_reference_source_url_survives_as_a_link(self):
        source_url = "https://example.invalid/listing/l1"
        data = build_report_data(listing_reference_manifest(source_url=source_url))
        html = render_report(data, TEMPLATE, self.case_root)
        self.assertIn(source_url, html)
        self.assertIn(f'href="{source_url}"', html)

    def test_source_url_query_string_survives_one_unescape(self):
        from html import unescape
        source_url = "https://example.invalid/listing?a=1&b=2"
        data = build_report_data(listing_reference_manifest(source_url=source_url))
        html = render_report(data, TEMPLATE, self.case_root)
        hrefs = re.findall(r'href="([^"]+)"', html)
        self.assertIn(source_url, [unescape(href) for href in hrefs],
                      "href 必须与原始 URL 逐字一致（只转义一次，不得出现 &amp;amp;）")
        self.assertNotIn("&amp;amp;", html, "不得对已转义文本再次转义")


if __name__ == "__main__":
    unittest.main(verbosity=2)
