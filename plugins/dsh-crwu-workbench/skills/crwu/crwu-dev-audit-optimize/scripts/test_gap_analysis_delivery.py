#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import gap_analysis_delivery as delivery

SAMPLE = SCRIPT_DIR / "examples" / "gap-analysis.sample.json"
TEMPLATE = SCRIPT_DIR.parent / "template" / "gap-analysis-report.html"

# 源仓契约测试：据本文件位置上溯定位**技能层**，只读核对同级 maintainer 技能的权威正文（不硬编码仓库布局）。
# 运行时不需要本测试；已安装副本内缺少同级技能时显式 skip（不静默通过）。
SKILLS_LAYER = SCRIPT_DIR.parents[1]                       # skills/<层>/
MAINTAINER_SKILL = SKILLS_LAYER / "crwu-dev-audit-skill-maintainer"
MAINTAINER_SKILL_NAME = "crwu-dev-audit-skill-maintainer"
GATE_OWNER_FILE = "04-registry-and-mapping-update.md"
VALIDATION_OWNER_FILE = "05-validation-and-delivery.md"
# F-021：一级资产/业务 classification 与 registry 的三份 owner 文件（唯一 owner = maintainer）。
CLASSIFICATION_FILES = (
    "03-asset-classification.md",
    "04-business-classification.md",
    "07-skill-registry.md",
)
# optimize 侧四个文档：共享门禁/校验口径一律按名回指，不得各自再定义一份。
OPTIMIZE_CONTRACT_DOCS = (
    "SKILL.md",
    "references/00-优化规范与文件落点.md",
    "references/01-反馈定位与画像流程.md",
    "references/02-方案模板与确认门禁.md",
)
# 共享校验命令的**命令行形态**（只禁活跃命令，不禁 `validate` 单词与普通回指）。
_SHARED_COMMAND_RE = re.compile(r"^(?:\$ )?python3\b")
_SHARED_TOOL_RE = re.compile(r"kb_tool\.py|check_audit_skill_mappings\.py")
_SHARED_PATH_RE = re.compile(r"\$SKILLS_ROOT[^\s`]*/(?:kb_tool\.py|check_audit_skill_mappings\.py)")
# maintainer 侧短名（`references/04` / `references/05`，后面不接 `-`）—— 完整文件名不算。
_SHORT_OWNER_RE = re.compile(r"references/0[45](?!-)")


def _fenced_template(text: str, heading_prefix: str) -> str:
    """取 `heading_prefix` 之后第一个 fenced 代码块的正文。

    模板里本身含 `## 1. …` 这类子标题，所以**不能**按"下一个 H2"截断，必须按围栏取。
    """
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(heading_prefix)), None)
    if start is None:
        return ""
    fence = next((i for i in range(start, len(lines)) if lines[i].startswith("```")), None)
    if fence is None:
        return ""
    end = next((i for i in range(fence + 1, len(lines)) if lines[i].startswith("```")), None)
    return "\n".join(lines[fence + 1:end if end is not None else len(lines)])

# F-016/F-018：入口只留边界、模式、门禁与导航；详细流程按**完整文件名**回指四个 reference。
ENTRY_REFERENCE_NAMES = (
    "00-优化规范与文件落点.md",
    "01-反馈定位与画像流程.md",
    "02-方案模板与确认门禁.md",
    "03-AI人工差距分析流程.md",
)
# 详细实现标识 → 唯一详细落点（不得留在入口，必须存在于该 reference）。
DETAIL_TOKEN_OWNERS = (
    ("sourceGapIds[]", "03-AI人工差距分析流程.md"),
    ("python3 scripts/gap_analysis_delivery.py validate", "03-AI人工差距分析流程.md"),
    ("BG8169 / 300673", "00-优化规范与文件落点.md"),
    ("两跑导出", "00-优化规范与文件落点.md"),
    ("八层追踪", "03-AI人工差距分析流程.md"),
    ("画像五维提取", "01-反馈定位与画像流程.md"),
)
# 安全与授权门禁必须**直接**留在入口。
ENTRY_GATE_TOKENS = (
    "不产出任何审核意见",
    "先方案、后动文件",
    "用户明确确认",
    "知识库只读",
    "manual_only",
    "禁止修改知识库",
    "FIX-*",
    "crwu-dev-audit-skill-maintainer",
    "AI—人工差距分析模式",
    "常规反馈优化模式",
    "受控执行模式",
    # OPT-012（F-031）：Python 运行时口径已收归 maintainer SKILL.md 单一 owner，入口改为按名回指；
    # `load_workspace_dependencies` / 裸 `python3` / 静默降级到系统解释器 三条不再要求出现在**入口**，
    # 改由 test_p3_document_debt_is_closed_and_python_runtime_has_one_owner 对 **owner 正文**逐条严格断言。
)
# A–E 五桶及执行归属必须仍可从入口识别。
ENTRY_BUCKET_TOKENS = (
    "A 规则/清单内容",
    "B 覆盖缺失",
    "C 词表/画像取值",
    "D 技能算法与流程",
    "E 路径/装配/指针漂移",
    "知识库人工修复",
    "知识库部分人工修复",
    "交接 maintainer",
)
# OPT-012（F-031）：Python 运行时的**专属语义**。同一份 token 集同时用作
# 「owner 必须逐条具备」与「consumer 必须逐条不出现」，避免只禁少数短语时被**部分复述**绕过。
PYTHON_RUNTIME_OWNER_TOKENS = (
    "DSH 自带的 Python",
    "load_workspace_dependencies",
    "`python` 字段",
    "调用**一次**并在同一次会话内复用",
    "裸 `python3`",
    "任何解释器查找",
    "静默降级到系统解释器",
    "不安装 Python",
    "不执行 pip",
    "`python3 scripts/<文件>`",
)
# consumer 侧必须**显式具备**的指针与失败门禁语义（缺一即失败）。
PYTHON_RUNTIME_CONSUMER_REQUIRED = (
    "按名回指",
    "不复述",
    "capability gap",
    "停止",
)
PYTHON_RUNTIME_CONSUMER_UNIQUE_RE = re.compile(r"唯一维护|唯一 owner|唯一事实源")


def load_sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


class GapAnalysisValidationTest(unittest.TestCase):
    def test_sample_passes(self):
        self.assertEqual([], delivery.validate(load_sample()))

    def test_every_actionable_gap_has_a_fix(self):
        result = load_sample()
        result["reviewerOnlyItems"][0]["linkedFixIds"] = []
        errors = delivery.validate(result)
        self.assertTrue(any("linkedFixIds" in item for item in errors), errors)

    def test_every_fix_points_back_to_a_gap(self):
        result = load_sample()
        result["repairPlans"][0]["sourceGapIds"] = []
        errors = delivery.validate(result)
        self.assertTrue(any("sourceGapIds" in item for item in errors), errors)

    def test_non_actionable_gap_cannot_enter_repair_plan(self):
        result = load_sample()
        result["repairPlans"][0]["sourceGapIds"].append("L-03")
        errors = delivery.validate(result)
        self.assertTrue(any("L-resolved" in item for item in errors), errors)

    def test_kb_plan_is_manual_only(self):
        result = load_sample()
        kb = next(item for item in result["repairPlans"] if item["type"] == "kb_manual")
        kb["executionMode"] = "ai"
        errors = delivery.validate(result)
        self.assertTrue(any("manual_only" in item for item in errors), errors)

    def test_duplicate_gap_id_is_rejected(self):
        result = load_sample()
        result["reviewerOnlyItems"].append(copy.deepcopy(result["reviewerOnlyItems"][0]))
        result["summary"]["reviewerOnly"] += 1
        result["summary"]["actionableMisses"] += 1
        errors = delivery.validate(result)
        self.assertTrue(any("重复" in item for item in errors), errors)

    def test_absolute_paths_are_rejected(self):
        result = load_sample()
        result["project"]["auditResult"] = "/Users/example/审核意见.json"
        errors = delivery.validate(result)
        self.assertTrue(any("绝对路径" in item for item in errors), errors)


class GapAnalysisRenderTest(unittest.TestCase):
    def setUp(self):
        self.result = load_sample()

    def test_is_single_file_and_offline(self):
        document = delivery.render(self.result)
        for token in ("<link", "script src", "@import"):
            self.assertNotIn(token, document)
        self.assertIn("echarts.init", document)

    def test_required_sections_exist(self):
        document = delivery.render(self.result)
        for region in (
            "gap-summary",
            "gap-charts",
            "reviewer-only-table",
            "execution-trace",
            "gap-fix-map",
            "manual-kb-plans",
            "skill-repair-prompts",
            "validation-plan",
        ):
            self.assertIn(f'id="{region}"', document)

    def test_a4_and_table_print_contract(self):
        document = delivery.render(self.result)
        self.assertIn("@page { size: A4", document)
        self.assertIn("thead { display: table-header-group; }", document)
        self.assertIn("break-inside: avoid", document)

    def test_embedded_payload_is_parseable(self):
        document = delivery.render(self.result)
        match = re.search(
            r'<script id="gap-analysis-data" type="application/json">(.*?)</script>',
            document,
            re.S,
        )
        self.assertIsNotNone(match)
        self.assertEqual(self.result["reportId"], json.loads(match.group(1))["reportId"])

    def test_manual_and_skill_outputs_are_separated(self):
        kb = next(item for item in self.result["repairPlans"] if item["type"] == "kb_manual")
        manual = delivery.build_manual_kb_instruction(kb)
        prompt = delivery.build_skill_prompt(self.result, ["FIX-SKILL-01"])
        self.assertIn("FIX-KB-01", manual)
        self.assertIn("仅人工", manual)
        self.assertIn("FIX-SKILL-01", prompt)
        self.assertIn("crwu-dws 只读", prompt)
        self.assertIn("不得对知识库执行任何写操作", prompt)
        self.assertNotIn("修改知识库", prompt)

    def test_unapproved_skill_plan_is_rejected(self):
        self.result["repairPlans"][1]["approvalState"] = "pending"
        with self.assertRaisesRegex(ValueError, "未批准"):
            delivery.build_skill_prompt(self.result, ["FIX-SKILL-01"])

    def test_root_cause_chart_excludes_non_actionable_items(self):
        self.assertEqual({"K2": 1, "S2": 1}, delivery.actionable_cause_counts(self.result))

    def test_documented_cli_flags_validate_and_render(self):
        self.assertEqual(0, delivery.main(["validate", "--input", str(SAMPLE)]))
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "report.html"
            self.assertEqual(
                0,
                delivery.main(
                    ["render", "--input", str(SAMPLE), "--output", str(output)]
                ),
            )
            self.assertIn("AI—人工审核差距分析", output.read_text(encoding="utf-8"))


class SkillIntegrationTest(unittest.TestCase):
    def test_skill_is_a_concise_progressive_disclosure_entry(self):
        """F-016/F-018：入口只留边界、模式、门禁与导航；详细流程按完整文件名回指四个 reference。"""
        skill_dir = SCRIPT_DIR.parent
        entry = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        references_root = skill_dir / "references"

        # 1) 入口尺寸上限。
        line_count = len(entry.splitlines())
        self.assertLessEqual(line_count, 100, f"入口过长：{line_count} 行（上限 100）")
        byte_size = len(entry.encode("utf-8"))
        self.assertLessEqual(byte_size, 10000, f"入口过大：{byte_size} bytes（上限 10000）")

        # 2) 四个完整文件名必须逐字出现（短名导航不可发现）。
        for name in ENTRY_REFERENCE_NAMES:
            self.assertIn(f"references/{name}", entry, f"入口必须逐字链接 references/{name}")

        # 3) reference 集合必须恰为四者：无新增、无缺失。
        actual = {path.name for path in references_root.glob("*.md")}
        self.assertEqual(set(ENTRY_REFERENCE_NAMES), actual, f"reference 集合不符：{sorted(actual)}")

        # 4) 详细实现标识只在指定 reference。
        for token, reference_name in DETAIL_TOKEN_OWNERS:
            self.assertNotIn(token, entry, f"{token} 属详细流程，应只出现在 references/{reference_name}")
            self.assertIn(
                token, (references_root / reference_name).read_text(encoding="utf-8"),
                f"references/{reference_name} 必须承载 {token}",
            )

        # 5) 安全与授权门禁必须直接留在入口。
        for token in ENTRY_GATE_TOKENS:
            self.assertIn(token, entry, f"入口必须直接保留门禁标识：{token}")

        # 6) A–E 五桶及执行归属必须仍可从入口识别。
        for token in ENTRY_BUCKET_TOKENS:
            self.assertIn(token, entry, f"入口必须保留根因桶/归属标识：{token}")

    def test_skill_routes_gap_analysis_mode(self):
        skill = (SCRIPT_DIR.parent / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("AI—人工差距分析模式", skill)
        self.assertIn("references/03-AI人工差距分析流程.md", skill)

    def test_skill_keeps_knowledge_base_manual_only(self):
        files = [
            SCRIPT_DIR.parent / "SKILL.md",
            SCRIPT_DIR.parent / "references" / "03-AI人工差距分析流程.md",
        ]
        text = "\n".join(path.read_text(encoding="utf-8") for path in files if path.is_file())
        self.assertIn("manual_only", text)
        self.assertIn("禁止修改知识库", text)

    def test_gap_reference_defines_bidirectional_traceability(self):
        reference = SCRIPT_DIR.parent / "references" / "03-AI人工差距分析流程.md"
        text = reference.read_text(encoding="utf-8")
        self.assertIn("sourceGapIds", text)
        self.assertIn("linkedFixIds", text)
        self.assertIn("L-open", text)
        self.assertIn("L-resolved", text)

    def test_optimize_defers_shared_gate_and_validation_contracts_to_maintainer(self):
        """F-020：共享门禁与校验口径只在 maintainer `04`/`05` 定义一次；optimize 只按完整文件名回指。"""
        docs = {
            name: (SCRIPT_DIR.parent / name).read_text(encoding="utf-8")
            for name in OPTIMIZE_CONTRACT_DOCS
        }
        problems = []

        # 1) 入口必须写出两个完整 owner 文件名（技能名 + 完整文件名，不用短名）。
        for token in (GATE_OWNER_FILE, VALIDATION_OWNER_FILE):
            if token not in docs["SKILL.md"]:
                problems.append(f"SKILL.md: 缺少完整 owner 文件名「{token}」")
        # 2) references/00 同样必须写出两个完整文件名。
        for token in (GATE_OWNER_FILE, VALIDATION_OWNER_FILE):
            if token not in docs["references/00-优化规范与文件落点.md"]:
                problems.append(f"references/00: 缺少完整 owner 文件名「{token}」")
        # 3) references/01 必须回指 05，并声明命令签名不在本文件重复。
        locate = "references/01-反馈定位与画像流程.md"
        if VALIDATION_OWNER_FILE not in docs[locate]:
            problems.append(f"{locate}: 缺少完整 owner 文件名「{VALIDATION_OWNER_FILE}」")
        for token in ("不复制", "命令"):
            if token not in docs[locate]:
                problems.append(f"{locate}: 必须声明命令签名不在本文件重复（缺「{token}」）")
        # 4) references/02 必须写出两个完整文件名，且不得只写短名。
        template = "references/02-方案模板与确认门禁.md"
        for token in (GATE_OWNER_FILE, VALIDATION_OWNER_FILE):
            if token not in docs[template]:
                problems.append(f"{template}: 缺少完整 owner 文件名「{token}」")
        for match in _SHORT_OWNER_RE.finditer(docs[template]):
            problems.append(
                f"{template}: 仍用短名回指「{match.group(0)}」——必须写完整 owner 文件名"
            )
        # 技能名必须与 owner 文件名同时出现，回指才无歧义。
        for name, text in docs.items():
            if MAINTAINER_SKILL_NAME not in text:
                problems.append(f"{name}: 回指未写明 owner 技能名「{MAINTAINER_SKILL_NAME}」")

        # 5) 不得保留活跃的共享校验命令行（按命令行形态判定，不禁 `validate` 单词）。
        for name, text in docs.items():
            for line_no, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                active = (
                    _SHARED_COMMAND_RE.match(stripped) and _SHARED_TOOL_RE.search(line)
                ) or _SHARED_PATH_RE.search(line)
                if active:
                    problems.append(
                        f"{name}:{line_no}: 仍有活跃的共享校验命令/签名（应只回指 {VALIDATION_OWNER_FILE}）："
                        f"{stripped[:88]}"
                    )

        # 6) references/00 不得继续定义第二份验收基线与通过判据。
        spec = "references/00-优化规范与文件落点.md"
        for token, why in (
            ("## 4. 验收基线", "共享验收基线章节"),
            ("通过判据：", "第二份通过判据"),
        ):
            if token in docs[spec]:
                problems.append(f"{spec}: 不得继续维护{why}「{token}」")
        # 7) references/02 不得保留共享 owner 形态的章节。
        for token in ("## 2. 确认门禁", "## 3. 执行后核对清单"):
            if token in docs[template]:
                problems.append(f"{template}: 不得保留共享 owner 形态章节「{token}」")

        # 8) optimize 特有安全语义不得被去重误删。
        combined = "\n".join(docs.values())
        for token in (
            "FIX-*", "manual_only", "kb_manual", "skill_ai",
            "L-*.linkedFixIds[]", "FIX-*.sourceGapIds[]",
            "禁止修改知识库", "未确认不动",
        ):
            if token not in combined:
                problems.append(f"optimize 文档整体缺少特有授权语义「{token}」")

        # 9) maintainer 权威正文（源仓存在时必须仍承载；安装副本缺 sibling 时显式 skip）。
        gate_path = MAINTAINER_SKILL / "references" / GATE_OWNER_FILE
        validation_path = MAINTAINER_SKILL / "references" / VALIDATION_OWNER_FILE
        siblings_checked = gate_path.is_file() and validation_path.is_file()
        if siblings_checked:
            gate = gate_path.read_text(encoding="utf-8")
            validation = validation_path.read_text(encoding="utf-8")
            for token in ("两阶段修改门禁", "阶段一：只读方案", "阶段二：确认后执行"):
                if token not in gate:
                    problems.append(f"{MAINTAINER_SKILL_NAME}/{GATE_OWNER_FILE}: 权威正文缺少「{token}」")
            for token in ("kb_tool.py validate", "测试", "git diff --check"):
                if token not in validation:
                    problems.append(
                        f"{MAINTAINER_SKILL_NAME}/{VALIDATION_OWNER_FILE}: 权威正文缺少「{token}」"
                    )
            # 从 optimize 迁出的**条件验证判据**必须真正落到 owner 里 —— 只证明文件存在不够，
            # 否则"删掉条件、只留回指"仍会全绿（OPT-010A-R1 的 P1）。
            for token in ("受影响装配", "两跑", "BG8169", "300673", "不劣化"):
                if token not in validation:
                    problems.append(
                        f"{MAINTAINER_SKILL_NAME}/{VALIDATION_OWNER_FILE}: owner 未承载被迁移的"
                        f"验收判据「{token}」（optimize 已回指此处，条件不得只删不迁）"
                    )

        # 一次汇总全部问题，不因首个问题短路。
        if problems:
            self.fail("optimize 共享门禁/校验口径归口不合格：\n  " + "\n  ".join(problems))
        if not siblings_checked:
            self.skipTest(
                f"安装副本缺少同级 {MAINTAINER_SKILL_NAME} 的 {GATE_OWNER_FILE} / "
                f"{VALIDATION_OWNER_FILE}：显式跳过 sibling 权威正文断言"
            )

    def test_first_level_classification_and_registry_are_maintainer_owned(self):
        """F-021：一级资产/业务 classification 与 registry 的唯一 owner 是 maintainer；optimize 只诊断与交接。"""
        skill_root = SCRIPT_DIR.parent
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        routes = (skill_root / "references" / "00-优化规范与文件落点.md").read_text(encoding="utf-8")
        problems = []

        # 5.1 入口：三个完整文件名 + owner 技能名 + 排他表达，必须在**同一个归口块**内
        #     （按空行切块；分别散落在全篇不算）。
        owner_blocks = [
            block for block in re.split(r"\n\s*\n", skill)
            if all(name in block for name in CLASSIFICATION_FILES)
        ]
        if not owner_blocks:
            problems.append(
                "SKILL.md: 缺少在**同一块**内列出三份 classification/registry 完整文件名的归口声明"
                f"（{'、'.join(CLASSIFICATION_FILES)}）"
            )
        elif len(owner_blocks) > 1:
            # 「唯一 owner」要求入口也只有一块归口声明；允许多块就等于允许一份冲突归口。
            problems.append(
                f"SKILL.md: 存在 {len(owner_blocks)} 个列出三份 classification/registry 完整文件名的"
                f"归口块，唯一 owner 要求**恰好 1 块**（重复 / 冲突归口）"
            )
            for extra in owner_blocks[1:]:
                declared = (
                    MAINTAINER_SKILL_NAME if MAINTAINER_SKILL_NAME in extra
                    else "crwu-dev-audit-optimize（optimize 自执行，冲突）"
                    if "crwu-dev-audit-optimize" in extra else "未声明 owner"
                )
                problems.append(
                    f"SKILL.md: 多余归口块的 owner/执行声明 = {declared}；"
                    f"片段：{extra.strip()[:56]}…"
                )
        else:
            block = owner_blocks[0]
            if MAINTAINER_SKILL_NAME not in block:
                problems.append(
                    f"SKILL.md: classification/registry 归口块未写明 owner 技能名「{MAINTAINER_SKILL_NAME}」"
                )
            if not re.search(r"一律交接|一律由|只能由|不得自行修改", block):
                problems.append(
                    "SKILL.md: classification/registry 归口块缺少排他性表达（一律交接 / 不得自行修改）"
                )
            # 5.4 同一块必须保留 router 运行时算法仍由本技能（批准后）执行的边界
            for token in ("scope", "method", "overlay", "并集", "运行时算法", "本技能"):
                if token not in block:
                    problems.append(
                        f"SKILL.md: 归口块未保留 router 运行时算法的本技能执行边界「{token}」"
                    )

        # 5.2 解析 references/00 的「改动类型 | 唯一落点 | 联动 / 红线」表（只取该表）
        lines = routes.splitlines()
        start = next((i for i, l in enumerate(lines) if l.startswith("| 改动类型 | 唯一落点")), None)
        if start is None:
            problems.append("references/00: 未找到「改动类型 → 唯一落点」表")
            rows = []
        else:
            rows = []
            for line in lines[start + 2:]:
                if not line.startswith("|"):
                    break
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                if len(cells) >= 2:
                    rows.append(cells)

        # router 运行时算法行：不得混入 classification/registry
        router_rows = [
            row for row in rows
            if any(k in row[0] for k in ("路由", "分发", "降级", "覆盖层"))
            or re.search(r"router", row[0], re.I)
        ]
        if not router_rows:
            problems.append("references/00: 缺 router 运行时算法的独立落点行")
        for row in router_rows:
            row_text = "|".join(row)
            # 紧凑写法 `` `references/02`/`03`/`04`/`07` `` 既不是 `references/03` 子串、也断开在反引号上，
            # 所以先去掉反引号再做引用编号检查。
            plain = row_text.replace("`", "")
            for token in ("业务分类判定", "references/03", "references/04", "references/07",
                          "03-asset-classification", "04-business-classification", "07-skill-registry"):
                if token in plain:
                    problems.append(
                        f"references/00: router 运行时算法行混入 classification/registry「{token}」"
                        f"（改动类型：{row[0][:36]}）"
                    )
            for number in ("03", "04", "07"):
                if re.search(rf"references/(?:\d\d/)*{number}(?![0-9])", plain):
                    problems.append(
                        f"references/00: router 运行时算法行仍引用 references/{number}"
                        f"（含 `references/02/03/04/07` 这类紧凑写法；改动类型：{row[0][:36]}）"
                    )

        # 独立 classification/registry 行：必须由 maintainer **独占且恰好一条**
        owner_rows = [
            row for row in rows
            if re.search(r"classification", row[0], re.I) and re.search(r"registry", row[0], re.I)
        ]
        if not owner_rows:
            problems.append(
                "references/00: 缺独立的「一级资产/业务 classification 与 registry」落点行"
            )
        else:
            # 「唯一 owner」是机器判据：允许多条就等于没有唯一事实源（OPT-010B-R1 堵的绕过孔）。
            if len(owner_rows) > 1:
                problems.append(
                    f"references/00: 存在 {len(owner_rows)} 条 classification / registry owner 行，"
                    f"唯一事实源要求**恰好 1 条**（第 2 条起为重复 / 冲突归口）"
                )
                for extra in owner_rows[1:]:
                    extra_text = "|".join(extra)
                    if MAINTAINER_SKILL_NAME in extra_text:
                        declared = MAINTAINER_SKILL_NAME
                    elif "crwu-dev-audit-optimize" in extra_text:
                        declared = "crwu-dev-audit-optimize（optimize 自执行，冲突）"
                    else:
                        declared = "未声明 owner"
                    problems.append(
                        f"references/00: 多余 owner 行的 owner/执行声明 = {declared}；"
                        f"改动类型：{extra[0][:36]}"
                    )
            row_text = "|".join(owner_rows[0])
            for token in CLASSIFICATION_FILES:
                if token not in row_text:
                    problems.append(
                        f"references/00: classification/registry 行缺完整文件名「{token}」"
                    )
            if MAINTAINER_SKILL_NAME not in row_text:
                problems.append(
                    f"references/00: classification/registry 行未写明 owner「{MAINTAINER_SKILL_NAME}」"
                )
            if not re.search(r"只诊断|只做诊断|交接", row_text):
                problems.append("references/00: classification/registry 行未声明 optimize 只诊断/交接")
            if not re.search(r"不自行修改|不得自行修改|不执行|不得执行", row_text):
                problems.append("references/00: classification/registry 行未声明 optimize 不得自行修改")

        # 散落绕过：三份文件名不得出现在该表的**其它**行。
        # 只豁免**唯一那条** canonical owner 行（按下标定位，连内容相同的重复行也不放过）。
        canonical_index = rows.index(owner_rows[0]) if owner_rows else None
        for position, row in enumerate(rows):
            if position == canonical_index:
                continue
            row_text = "|".join(row)
            for token in CLASSIFICATION_FILES:
                if token in row_text:
                    problems.append(
                        f"references/00: 「{token}」散落在非归口行「{row[0][:28]}」——"
                        f"必须由 classification/registry 行一处声明"
                    )

        # 5.4 不得误伤 optimize 的合法职责（A 桶 / D 桶 / 交接不继承授权）
        buckets = {}
        for line in skill.splitlines():
            if not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            match = re.match(r"\*\*([A-E])[ 　]", cells[0]) if cells else None
            if match:
                buckets[match.group(1)] = "|".join(cells)
        if "知识库" not in buckets.get("A", "") or "人工" not in buckets.get("A", ""):
            problems.append("SKILL.md: A 桶必须仍是知识库人工修复（不得因归口调整被改写）")
        if "本技能执行" not in buckets.get("D", ""):
            problems.append("SKILL.md: D 桶叶子算法与流程必须仍由本技能在批准后执行")
        if not re.search(r"一律交接|交接 maintainer|不得自行修改", buckets.get("C", "")):
            problems.append(
                "SKILL.md: C 桶执行声明未排除 classification / registry"
                "（须写明目标含三份 owner 文件时一律交接 maintainer）"
            )
        if "不继承修改授权" not in skill:
            problems.append("SKILL.md: 必须保留「交接不继承修改授权」")

        # 5.3 只读 owner 仍真实承载（源仓 sibling 缺失时显式 skip）
        gate_path = MAINTAINER_SKILL / "references" / GATE_OWNER_FILE
        modes_path = MAINTAINER_SKILL / "references" / "00-responsibility-and-modes.md"
        maintainer_skill = MAINTAINER_SKILL / "SKILL.md"
        plugins_agents = SKILLS_LAYER.parents[2] / "AGENTS.md"
        sources = (gate_path, modes_path, maintainer_skill, plugins_agents)
        siblings_checked = all(path.is_file() for path in sources)
        if siblings_checked:
            maintainer_skill_text = maintainer_skill.read_text(encoding="utf-8")
            if not ("分类" in maintainer_skill_text and "registry" in maintainer_skill_text):
                problems.append(
                    f"{MAINTAINER_SKILL_NAME}/SKILL.md: 未声明「分类、registry」职责"
                )
            gate_text = gate_path.read_text(encoding="utf-8")
            for name in CLASSIFICATION_FILES:
                if name not in gate_text:
                    problems.append(f"{MAINTAINER_SKILL_NAME}/{GATE_OWNER_FILE}: 缺「{name}」")
            modes_text = modes_path.read_text(encoding="utf-8")
            if not all(t in modes_text for t in ("audit", "repair", "classification", "registry")):
                problems.append(
                    f"{MAINTAINER_SKILL_NAME}/references/00-responsibility-and-modes.md: "
                    "audit/repair 语义未覆盖 classification / registry 不一致"
                )
            agents_text = plugins_agents.read_text(encoding="utf-8")
            if not all(t in agents_text for t in ("一级 Skill", "registry", "classification",
                                                  MAINTAINER_SKILL_NAME)):
                problems.append(
                    "plugins/AGENTS.md: 未把一级 Skill / 一级根 / registry / classification 归 maintainer"
                )

        # 一次汇总全部问题，不因首个问题短路。
        if problems:
            self.fail("classification / registry 归口不合格：\n  " + "\n  ".join(problems))
        if not siblings_checked:
            self.skipTest(
                f"安装副本缺少同级 {MAINTAINER_SKILL_NAME} 的权威正文或 plugins/AGENTS.md："
                "显式跳过 sibling 归口断言"
            )

    def test_plan_and_completion_report_use_source_paths_without_runtime_paths(self):
        """F-022：方案表与完成汇报只列源仓路径；运行时只报部署状态，不留运行时真身路径。"""
        skill_root = SCRIPT_DIR.parent
        ref02 = (skill_root / "references" / "02-方案模板与确认门禁.md").read_text(encoding="utf-8")
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        problems = []

        # 4.1 §1 方案必答项：拟改文件表必须是「文件（源仓路径） | 部署说明」分列
        plan = _fenced_template(ref02, "## 1. 方案必答项")
        if not plan:
            problems.append("references/02: 未找到 §1「方案必答项」的 fenced 模板")
        else:
            header = next(
                (line for line in plan.splitlines()
                 if line.startswith("|") and "文件" in line and "部署" in line),
                None,
            )
            if header is None:
                problems.append("references/02: §1 拟改文件表缺少「文件 / 部署说明」列头")
            else:
                cells = [c.strip() for c in header.strip().strip("|").split("|")]
                file_cells = [c for c in cells if "文件" in c]
                deploy_cells = [c for c in cells if "部署说明" in c]
                if len(file_cells) != 1:
                    problems.append(
                        f"references/02: §1 拟改文件表必须恰好一个「文件」列（实际 {len(file_cells)}）"
                    )
                else:
                    if "源仓路径" not in file_cells[0]:
                        problems.append(
                            f"references/02: §1 文件列必须写明「文件（源仓路径）」，实际「{file_cells[0]}」"
                        )
                    if "运行时" in file_cells[0]:
                        problems.append(
                            f"references/02: §1 文件列不得把源仓路径与运行时路径并列：「{file_cells[0]}」"
                        )
                if len(deploy_cells) != 1:
                    problems.append(
                        f"references/02: §1 必须有一个独立的「部署说明」列（实际 {len(deploy_cells)}）"
                    )
                else:
                    for token in ("运行时由用户 skills 管理机制负责", "本列不再列运行时路径"):
                        if token not in deploy_cells[0]:
                            problems.append(f"references/02: §1 部署说明列缺「{token}」")
            if "库内层级路径寻址键" not in plan:
                problems.append(
                    "references/02: §1 知识库人工项必须继续用库内层级路径寻址键"
                    "（不得改成源仓或运行时路径）"
                )

        # 4.2 §4 汇报模板：源仓文件与运行时部署状态必须是两条独立项
        report = _fenced_template(ref02, "## 4. 汇报模板")
        if not report:
            problems.append("references/02: 未找到 §4「汇报模板」的 fenced 模板")
        else:
            items = [line.strip() for line in report.splitlines() if line.strip().startswith("- ")]
            changed = [line for line in items if "已改文件" in line]
            deployed = [line for line in items if "运行时部署" in line or "部署状态" in line]
            if len(changed) != 1:
                problems.append(
                    f"references/02: §4 汇报模板必须恰好一条「已改文件」项（实际 {len(changed)}）"
                )
            else:
                for token in ("逐文件", "源仓路径"):
                    if token not in changed[0]:
                        problems.append(f"references/02: §4「已改文件」项缺「{token}」")
                if "运行时" in changed[0]:
                    problems.append(
                        f"references/02: §4「已改文件」项不得同时含源仓与运行时（混合路径列）：{changed[0]}"
                    )
            if len(deployed) != 1:
                problems.append(
                    f"references/02: §4 汇报模板必须恰好一条独立「运行时部署状态」项（实际 {len(deployed)}）"
                )
            else:
                for token in ("用户 skills 管理机制", "未直接写运行时"):
                    if token not in deployed[0]:
                        problems.append(f"references/02: §4「运行时部署状态」项缺「{token}」")
            # 旧形态：源仓/运行时混合列 或 要求填写运行时真身路径
            for banned in ("源仓/运行时各列", "源仓／运行时各列", "源仓 + 运行时", "源仓+运行时",
                           "运行时真身路径"):
                if banned in report:
                    problems.append(
                        f"references/02: §4 汇报模板不得出现「{banned}」（源仓/运行时混合或要求运行时路径）"
                    )
            # 不得要求填写运行时路径；方案表里的否定式「本列不再列运行时路径」是正确契约，故按行判定。
            for line in report.splitlines():
                if "运行时路径" in line and not re.search(r"不列|不再列|不得|禁止|未直接", line):
                    problems.append(
                        f"references/02: §4 汇报模板要求填写运行时路径：{line.strip()}"
                    )

        # 4.3 入口级部署边界（只读）
        for token in ("不得写运行时技能目录", "运行时部署由用户 skills 管理机制负责"):
            if token not in skill:
                problems.append(f"SKILL.md: 入口级部署边界缺「{token}」")
        if not re.search(r"唯一落点", skill):
            problems.append("SKILL.md: 缺源仓唯一落点语义")
        for banned in ("源仓/运行时各列", "运行时真身路径"):
            if banned in skill:
                problems.append(f"SKILL.md: 入口不得出现「{banned}」")

        # 一次汇总全部问题，不因首个问题短路。
        self.assertEqual([], problems, "源仓/运行时口径不合格：\n  " + "\n  ".join(problems))

    def test_p3_document_debt_is_closed_and_python_runtime_has_one_owner(self):
        """OPT-012：F-027/028/030 文档事实收口，F-031 Python 运行时单一 owner（optimize 只按名回指）。"""
        skill_root = SCRIPT_DIR.parent
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        spec = (skill_root / "references" / "00-优化规范与文件落点.md").read_text(encoding="utf-8")
        problems = []

        GOVERNANCE = (
            "RULE 编号与引用完整性规范.md", "同义术语表.md", "回测报告-真实案例覆盖.md",
            "审核模块注册表.md", "时效核查日历.md", "标签词典.md", "校准案例记录.md",
            "知识库规则分层与引用规范.md", "规则时效与适用日期规范.md",
        )
        CONTRACTS = (
            "01-调度器-SKILL总纲.md", "02-防幻觉协议执行细则.md",
            "03-审核统计与台账规范.md", "04-复核规定动作清单.md",
        )

        # 4.1 F-027：不存在的维护说明文件名不得残留，两处都要改成真实名
        for label, text in (("SKILL.md", skill), ("references/00", spec)):
            if "99-维护说明.md" in text:
                problems.append(f"{label}: 仍引用不存在的 `99-维护说明.md`（F-027）")
        fixed = spec.count("crwu-audit/references/99-maintenance.md")
        if fixed < 2:
            problems.append(
                "references/00: 两处引用都必须改为真实名"
                f"`crwu-audit/references/99-maintenance.md`（当前 {fixed} 处）"
            )

        # 4.2 F-028：治理目录 9 项 / 执行契约 4 项，并澄清 04 是什么
        if "无 04" in spec:
            problems.append("references/00: 不得再声称执行契约「无 04」（F-028）")
        for name in GOVERNANCE:
            if name not in spec:
                problems.append(f"references/00: 治理目录缺真实文档「{name}」")
        for name in CONTRACTS:
            if name not in spec:
                problems.append(f"references/00: 执行契约缺真实文档「{name}」")
        if not re.search(r"治理[^\n]{0,40}9 个", spec):
            problems.append("references/00: 必须明确治理目录当前为 9 个文档")
        if not re.search(r"执行契约[^\n]{0,40}4 个", spec):
            problems.append("references/00: 必须明确执行契约当前为 4 个文档")
        if "复核规定动作清单" not in spec:
            problems.append("references/00: 必须澄清 04 是《复核规定动作清单》")
        if "03-审核统计与台账规范.md" not in spec:
            problems.append("references/00: 必须澄清统计台账规范仍是 03")
        for line in spec.splitlines():
            if "04-审核统计与台账规范" in line and not re.search(r"不存在|无此|并非|不是", line):
                problems.append(
                    f"references/00: 不得声称 `04-审核统计与台账规范` 存在：{line.strip()[:64]}"
                )

        # 4.3 F-030：NOTICE 必须存在，并在交付资产表里有独立入口
        if not (skill_root / "template" / "NOTICE.echarts.txt").is_file():
            problems.append("template/NOTICE.echarts.txt 不存在（F-030）")
        assets = spec
        if "## 3.1" in assets:
            assets = assets[assets.index("## 3.1"):]
        if "## 4." in assets:
            assets = assets[:assets.index("## 4.")]
        for token in ("template/echarts.min.js", "template/NOTICE.echarts.txt"):
            if token not in assets:
                problems.append(f"references/00 交付资产表: 未登记「{token}」")
        notice_rows = [l for l in assets.splitlines()
                       if l.startswith("|") and "NOTICE.echarts.txt" in l]
        if not notice_rows:
            problems.append("references/00 交付资产表: NOTICE 未作为独立表格行登记")
        else:
            row = notice_rows[0]
            if not re.search(r"许可|NOTICE|第三方", row):
                problems.append(f"references/00: NOTICE 行未说明第三方许可/NOTICE：{row[:72]}")
            if not re.search(r"同包|随.{0,6}分发|一并分发", row):
                problems.append(f"references/00: NOTICE 行未说明与 echarts.min.js 同包分发：{row[:72]}")

        # 4.4 F-031：Python 运行时唯一 owner = maintainer SKILL.md；optimize 只按名回指
        def python_section(text: str) -> str:
            lines = text.splitlines()
            start = next((i for i, l in enumerate(lines)
                          if l.startswith("## 脚本运行时（Python）")), None)
            if start is None:
                return ""
            end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
                       len(lines))
            return "\n".join(lines[start:end])

        consumer = python_section(skill)
        if not consumer:
            problems.append("SKILL.md: 未找到「## 脚本运行时（Python）」章节")
        else:
            if f"{MAINTAINER_SKILL_NAME}/SKILL.md" not in consumer:
                problems.append("SKILL.md: 运行时段落未写明 owner 技能名（F-031）")
            if not PYTHON_RUNTIME_CONSUMER_UNIQUE_RE.search(consumer):
                problems.append("SKILL.md: 运行时段落未声明「唯一维护」/等价唯一 owner 声明")
            for token in PYTHON_RUNTIME_CONSUMER_REQUIRED:
                if token not in consumer:
                    problems.append(f"SKILL.md: 运行时段落缺少指针/门禁语义「{token}」")
            # 与 owner 同一份专属 token 集：consumer **一条都不能含**（部分复述同样被拒）。
            for token in PYTHON_RUNTIME_OWNER_TOKENS:
                if token in consumer:
                    problems.append(
                        f"SKILL.md: 运行时段落仍复述 owner 专属语义「{token}」（应只留指针与最小失败门禁）"
                    )

        owner_path = MAINTAINER_SKILL / "SKILL.md"
        siblings_checked = owner_path.is_file()
        if siblings_checked:
            owner = python_section(owner_path.read_text(encoding="utf-8"))
            if not owner:
                problems.append(f"{MAINTAINER_SKILL_NAME}/SKILL.md: 未找到运行时段落（owner 缺失）")
            for token in PYTHON_RUNTIME_OWNER_TOKENS:
                if token not in owner:
                    problems.append(
                        f"owner（{MAINTAINER_SKILL_NAME}/SKILL.md）运行时段落缺语义「{token}」"
                    )

        # 一次汇总全部问题，不因首个问题短路。
        if problems:
            self.fail("P3 文档债务未收口：\n  " + "\n  ".join(problems))
        if not siblings_checked:
            self.skipTest(
                f"安装副本缺少同级 {MAINTAINER_SKILL_NAME}/SKILL.md：显式跳过 owner 段落断言"
            )


if __name__ == "__main__":
    unittest.main()
