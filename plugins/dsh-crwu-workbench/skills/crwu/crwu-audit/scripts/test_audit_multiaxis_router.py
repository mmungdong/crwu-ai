from pathlib import Path
import re
import unittest


# 源仓契约测试：据本文件位置上溯定位技能层与源仓根（不硬编码仓库布局）。
# 运行时不需要本测试；已安装副本内缺少同级技能或源仓文档时显式 skip（不静默通过）。
#
# **技能在源仓按层组织**：DSH 把每个技能**层**注册成一个技能根 ——
# `plugins/<插件>/skills/<层>/<技能>/`（本仓是 crwu / dws 两层）与公共层
# `plugins/common/skills/<技能>/`。所以"同级技能"必须**跨层**查找；只在本技能所在的层里找，
# 会把整个契约测试静默 skip 掉（2026-09 合并仓库时就发生过：8~12 条断言静默消失）。
SKILLS_ROOT = Path(__file__).resolve().parents[2]  # skills/<层>/<技能>/scripts/<file> → 本技能所在的层


def _has_skill_child(directory: Path) -> bool:
    """目录里直接放着技能（`<子目录>/SKILL.md`）—— 按内容判定，不靠目录名约定。"""
    return directory.is_dir() and any(
        (child / "SKILL.md").is_file() for child in directory.iterdir() if child.is_dir()
    )


def _skill_roots(start: Path) -> tuple[Path, ...]:
    """本技能所在的层 + 源仓里其它所有技能层（跨插件、跨层）。

    DSH 运行时把每个层都注册成技能根，所以"同级技能"必须跨层查找（只在本技能所在的层里找，
    整个契约测试会被静默 skip 掉）。安装副本里没有 `plugins/`，只剩本技能所在的层 ——
    那时同级技能本来就不存在，记 skip 是对的。
    """
    roots = [start]
    for candidate in start.parents:
        plugins = candidate / "plugins"
        if not plugins.is_dir():
            continue
        for skills in sorted(plugins.glob("*/skills")):
            if not skills.is_dir():
                continue
            if _has_skill_child(skills):
                roots.append(skills)  # 公共层：技能直接放在 skills/ 下
            else:
                roots.extend(sorted(layer for layer in skills.iterdir() if _has_skill_child(layer)))
        break
    return tuple(dict.fromkeys(root for root in roots if root.is_dir()))


SKILLS_ROOTS = _skill_roots(SKILLS_ROOT)


def has_skill(name: str) -> bool:
    """两个技能根里任一存在该技能目录即为已安装（安装副本只装了单个技能时为 False）。"""
    return any((root / name).is_dir() for root in SKILLS_ROOTS)


def skill_path(rel: str) -> Path:
    """按「技能名/技能内相对路径」在两个技能根里定位文件；都没有时回落到本技能所在的根。"""
    for root in SKILLS_ROOTS:
        candidate = root / rel
        if candidate.exists():
            return candidate
    return SKILLS_ROOT / rel


def skill_root_of(name: str) -> Path:
    """技能 `name` 所属的技能根（安装副本里找不到时回落到本技能所在的根）。"""
    for root in SKILLS_ROOTS:
        if (root / name).is_dir():
            return root
    return SKILLS_ROOT


def _source_repo_root(start: Path) -> Path:
    """源仓根：向上找带 `go.mod` + `Makefile` 的那一层（安装副本里找不到就回落一层）。"""
    for candidate in (start, *start.parents):
        if (candidate / "go.mod").is_file() and (candidate / "Makefile").is_file():
            return candidate
    return start.parent


REPO_ROOT = _source_repo_root(Path(__file__).resolve())
AUDIT_SKILL_ROOT = SKILLS_ROOT / "crwu-audit"

EXPECTED_REFERENCE_FILES = (
    "00-input-and-route-profile.md",
    "01-report-id-resolution.md",
    "02-scope-classification.md",
    "03-asset-classification.md",
    "04-business-classification.md",
    "05-method-classification.md",
    "06-overlay-classification.md",
    "07-skill-registry.md",
    "08-union-dispatch-rules.md",
    "09-review-risk-classification.md",
    "10-capability-gap-proposal.md",
    "11-html-delivery-spec.md",
    "12-leaf-common-contract.md",
    "13-dingtalk-result-publish.md",
    "14-orchestration-workflow.md",
    "15-oss-result-publish.md",
    "99-maintenance.md",
)

# F-016：router 入口必须**渐进披露**——运行时编排细节归 references/14，入口只留指针与门禁。
ORCHESTRATION_REFERENCE = "14-orchestration-workflow.md"
ROUTER_ENTRY_MAX_BYTES = 16000
ROUTER_ENTRY_MAX_LINES = 160
# 只应出现在 14 的运行时细节标识（入口里出现即说明编排正文又回流了）。
ORCHESTRATION_ONLY_TOKENS = (
    "load_workspace_dependencies",
    "crwu_audit_knowledge_materialize",
    "L-resolved",
    "hitExplanation",
    "request_kind=directory",
)
# 14 必须保留的执行语义标识（只锁标识，不锁整段文案）。
ORCHESTRATION_KEPT_TOKENS = (
    "阶段一",
    "阶段二",
    "冻结",
    "复核对照",
    "隔离补审",
    "recursive=true",
    "crwu_audit_dingtalk_archive",
)


def router_entry_text() -> str:
    """router 入口自身的契约文本（只读 SKILL.md）。"""
    return (AUDIT_SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")


def router_orchestration_text() -> str:
    """运行时编排契约文本 = 入口 + references/14。

    入口自身的断言（体积上限、指针、门禁）继续只读 `router_entry_text()`；只有确实检查
    "运行时编排细节"的断言才用组合文本 —— 否则细节一旦合法下沉，契约测试就会退化成
    入口体积测试。
    """
    reference = AUDIT_SKILL_ROOT / "references" / ORCHESTRATION_REFERENCE
    return router_entry_text() + "\n" + reference.read_text(encoding="utf-8")

REQUIRED_ROUTER_TERMS = (
    "SeqNo",
    "ObjectId",
    "scope_types[]",
    "asset_types[]",
    "business_types[]",
    "methods[]",
    "overlays[]",
    "review_risk_class",
    "materiality",
    "skills_to_load",
    "02-scope-classification.md",
    "03-asset-classification.md",
    "04-business-classification.md",
    "05-method-classification.md",
    "06-overlay-classification.md",
    "07-skill-registry.md",
    "08-union-dispatch-rules.md",
    "13-dingtalk-result-publish.md",
)

REGISTRY_HEADER = ("axis", "label", "skill", "status", "load behavior")

# Stable rows only: business-axis names are mid-migration to crwu-audit-biz-* and
# are reported by the skill-maintainer mapping checker instead of being pinned here.
EXPECTED_REGISTRY_ROWS = (
    ("asset", "房地产", "crwu-audit-asset-realestate", "available", "load"),
    ("asset", "机器设备", "crwu-audit-asset-equipment", "available", "load"),
    ("public", "通用准则", "crwu-audit-public-general-standards", "available", "load always"),
    ("public", "审核意见屏蔽", "crwu-audit-output-filter", "available", "load always; postprocess before phase1 freeze"),
)

# Public-axis capabilities are report-shape independent. Every one of them must be
# reachable from the union algorithm without depending on any professional axis label.
UNCONDITIONAL_PUBLIC_SKILLS = (
    "crwu-audit-public-general-standards",
    "crwu-audit-output-filter",
)

# 能力型公共轴技能：有各自的触发条件，不得被写成恒装配。
CONDITIONAL_PUBLIC_SKILLS = ("crwu-audit-datacheck", "crwu-audit-external-data")

DISPATCH_AXES = ("scope", "asset", "business", "method", "overlay", "public")

LEGACY_REGISTRY_SKILL = "crwu-audit-realestate-rent"
LEGACY_BUSINESS_PREFIX = "crwu-audit-business-"

# R3B 宿主入口边界：同花顺 iFinD 的取数入口随宿主而异，下面三份文档必须口径一致。
# `connector_probe.py` 只服务 WorkBuddy；DeepSeek Harness 的入口是宿主的结构化 Tool。
EXTERNAL_DATA_ENTRY_DOCS = (
    "crwu-audit-external-data/SKILL.md",
    "crwu-audit-external-data/references/01-connector-access.md",
    "crwu-audit/references/08-union-dispatch-rules.md",
)
HOST_CONNECTOR_PROBE = "connector_probe.py"
DSH_IFIND_TOOL = "crwu_audit_ifind_query"
LEGACY_DSH_IFIND_SKILL = "ifind-finance-data"
HOST_LABELS = ("WorkBuddy", "DeepSeek Harness")

# OPT-009C：external-data 入口必须**渐进披露**——基准日三档、核验步骤 0–7 与交付字段契约归
# references/02；入口只留调用门禁、输入、单源与宿主安全边界、必读导航。
EXTERNAL_DATA_SKILL = "crwu-audit-external-data"
EXTERNAL_DATA_WORKFLOW_REFERENCE = "crwu-audit-external-data/references/02-verification-workflow.md"
EXTERNAL_DATA_ENTRY_MAX_LINES = 100
EXTERNAL_DATA_ENTRY_MAX_BYTES = 10000
EXTERNAL_DATA_REFERENCE_SET = (
    "00-KB装配表.md",
    "01-connector-access.md",
    "02-verification-workflow.md",
)
# 只应出现在 02 的条件/字段细节（入口里出现即说明核验流程正文又回流了）。
EXTERNAL_DATA_DETAIL_TOKENS = (
    "多候选（ROUTE003 挂起",
    "条件性取数",
    "公司属性事实",
    "deviationAgainst",
    "只要有 `checks`",
)
# 02 必须保留的流程与交付语义。
EXTERNAL_DATA_WORKFLOW_TOKENS = (
    "applicability.status=not_applicable",
    "applicability.status=required",
    "base_date",
    "base_date_status",
    "externalDataVerification",
    "applicability",
    "baseDate",
    "sources[]",
    "checks[]",
    "deviationAgainst",
    "取数时点、口径、单位、参数",
    "口径无法统一时禁止作数值判定",
    "事实型数据",
    "模型型数据",
)
# 入口必须继续**直接**保留的稳定边界。
EXTERNAL_DATA_ENTRY_TOKENS = (
    "`methods[]`",
    "收益法",
    "市场法",
    "仅经 `crwu-audit` router 编排调用，禁止单独调用",
    "同花顺 iFinD",
    "不启用万得",
    "references/01-connector-access.md",
    "connector_probe.py",
    "WorkBuddy",
    "DeepSeek Harness",
    "DeepSeek Harness 不运行 `connector_probe.py`",
    "`crwu_audit_ifind_query`",
    "route_profile",
    "record_context.base_date",
)


def external_data_workflow_text() -> str:
    """external-data 契约文本 = 入口 `SKILL.md` + `references/02-verification-workflow.md`。

    OPT-009C 把基准日三档、核验步骤 0–7 与交付字段契约下沉到 02；凡检查这些**核验流程**的
    断言读组合文本。**宿主边界断言仍只读入口与 `01-connector-access.md`**，见
    `test_external_data_host_entries_are_host_bound`。
    """
    entry = skill_path(f"{EXTERNAL_DATA_SKILL}/SKILL.md").read_text(encoding="utf-8")
    reference = skill_path(EXTERNAL_DATA_WORKFLOW_REFERENCE).read_text(encoding="utf-8")
    return entry + "\n" + reference


def _markdown_cells(line):
    stripped = line.strip()
    if "|" not in stripped:
        return None
    cells = []
    for raw_cell in stripped.strip("|").split("|"):
        cell = raw_cell.strip()
        inline_code = re.fullmatch(r"`([^`]*)`", cell)
        if inline_code:
            cell = inline_code.group(1).strip()
        cells.append(cell.casefold())
    return tuple(cells)


def _is_markdown_separator(cells):
    return all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells)


def _registry_data_rows(text):
    lines = text.splitlines()
    for header_index, line in enumerate(lines):
        if _markdown_cells(line) != REGISTRY_HEADER:
            continue

        rows = []
        for candidate in lines[header_index + 1 :]:
            cells = _markdown_cells(candidate)
            if cells is None:
                if rows:
                    break
                continue
            if len(cells) != len(REGISTRY_HEADER):
                break
            if _is_markdown_separator(cells):
                continue
            rows.append(cells)
        return rows
    return None



# 源仓契约测试所需的完整技能族：安装副本里缺任何一个 → 显式 skip（不失败、不静默通过）。
_REQUIRED_SIBLINGS = (
    "crwu-audit",
    "crwu-audit-asset-realestate",
    "crwu-audit-biz-asset-operation",
    "crwu-audit-public-general-standards",
    "crwu-audit-datacheck",
    "crwu-audit-output-filter",
    "crwu-dev-audit-optimize",
    "crwu-dev-audit-skill-maintainer",
    "crwu-dws",
)


def _requires_skill_tree(test):
    """源仓契约测试前提：同级技能与源仓文档齐备。

    技能以副本安装时这些内容可能不在（例如只装了单个技能）——此时**显式 skip**，
    既不当成失败，也不静默通过。运行时不需要本测试。
    """

    def wrapper(self, *args, **kwargs):
        missing = [name for name in _REQUIRED_SIBLINGS if not has_skill(name)]
        if missing:
            self.skipTest(f"非完整技能树（缺少同级技能 {', '.join(missing)}）：跳过源仓契约测试")
        return test(self, *args, **kwargs)

    return wrapper


class AuditMultiaxisRouterContractTest(unittest.TestCase):
    def test_multiaxis_router_reference_set_exists(self):
        references_root = AUDIT_SKILL_ROOT / "references"
        expected = set(EXPECTED_REFERENCE_FILES)
        actual = {path.name for path in references_root.glob("*.md")}
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)

        self.assertEqual(
            expected,
            actual,
            f"multiaxis router reference set mismatch: missing={missing}, extra={extra}",
        )

    def test_root_router_declares_multiaxis_profile_and_reference_set(self):
        router_path = AUDIT_SKILL_ROOT / "SKILL.md"
        self.assertTrue(router_path.is_file(), f"missing root router: {router_path}")
        router_text = router_path.read_text(encoding="utf-8")

        missing = [term for term in REQUIRED_ROUTER_TERMS if term not in router_text]

        self.assertEqual([], missing, f"root router is missing contract terms: {missing}")

    def test_router_entrypoint_progressively_discloses_orchestration(self):
        """F-016：运行时编排细节沉到 `references/14`，入口只留指针、门禁与体积上限。

        只锁**文件所有权、入口大小与稳定语义标识**，不断言整段逐字文案 —— 文案可以在 14 里
        继续演进，但"细节只在 14 出现一次"这条所有权不得漂回入口。
        """
        entry_path = AUDIT_SKILL_ROOT / "SKILL.md"
        reference_path = AUDIT_SKILL_ROOT / "references" / ORCHESTRATION_REFERENCE
        self.assertTrue(reference_path.is_file(), f"missing orchestration reference: {reference_path}")

        entry = router_entry_text()
        reference = reference_path.read_text(encoding="utf-8")

        # 1) 入口必须显式链接 14（渐进披露的指针）。
        self.assertIn(
            f"references/{ORCHESTRATION_REFERENCE}", entry,
            f"router SKILL.md must link references/{ORCHESTRATION_REFERENCE}",
        )

        # 2) 入口体积上限：编排正文不应再占入口。
        byte_size = len(entry.encode("utf-8"))
        self.assertLessEqual(
            byte_size, ROUTER_ENTRY_MAX_BYTES,
            f"router 入口过大：{byte_size} bytes（上限 {ROUTER_ENTRY_MAX_BYTES}）"
            f"——运行时细节应下沉到 references/{ORCHESTRATION_REFERENCE}",
        )
        line_count = len(entry.splitlines())
        self.assertLessEqual(
            line_count, ROUTER_ENTRY_MAX_LINES,
            f"router 入口过长：{line_count} 行（上限 {ROUTER_ENTRY_MAX_LINES}）"
            f"——运行时细节应下沉到 references/{ORCHESTRATION_REFERENCE}",
        )

        # 3) 运行时细节只在 14：入口不得再出现，14 必须承载。
        for token in ORCHESTRATION_ONLY_TOKENS:
            self.assertNotIn(
                token, entry,
                f"{token} 属运行时编排细节，应只出现在 references/{ORCHESTRATION_REFERENCE}，不得留在入口",
            )
            self.assertIn(
                token, reference,
                f"references/{ORCHESTRATION_REFERENCE} 必须承载运行时细节 {token}",
            )

        # Execution order includes OSS publishing before DingTalk delivery.
        steps = [int(number) for number in re.findall(r"(?m)^(\d+)\.\s", reference)]
        self.assertEqual(
            list(range(1, 17)), steps,
            f"references/{ORCHESTRATION_REFERENCE} 必须按序保留 1–16 全部步骤，实际={steps}",
        )

        # 5) 14 必须保留阶段隔离、Python 运行时与 KB 装配边界的稳定标识。
        for token in ORCHESTRATION_KEPT_TOKENS:
            self.assertIn(
                token, reference,
                f"references/{ORCHESTRATION_REFERENCE} 必须保留执行语义标识 {token}",
            )

    def test_root_router_rejects_legacy_level_routing(self):
        router_path = AUDIT_SKILL_ROOT / "SKILL.md"
        self.assertTrue(router_path.is_file(), f"missing root router: {router_path}")
        # 旧 L1/L2 路由模型属运行时路由细节，F-016 后归 references/14；断言改读组合文本，
        # 否则该契约会随下沉一起被削弱（模型回流到 14 就没人拦）。
        router_text = router_orchestration_text()

        self.assertIsNone(
            re.search(r"\bL[12]\b", router_text, flags=re.IGNORECASE),
            "root router must not retain the active L1/L2 routing model",
        )

    def test_excel_delivery_evidence_must_use_original_coordinates(self):
        profile_path = AUDIT_SKILL_ROOT / "references/00-input-and-route-profile.md"
        profile_text = profile_path.read_text(encoding="utf-8")
        required_terms = (
            "交付物中的 Excel 证据定位",
            "必须使用 raw 原件坐标",
            "工作版坐标仅限审核执行内部使用",
            "映射回原件坐标",
            "无法可靠映射",
            "不得下发该定位",
            "待人工确认事项",
            "capability gap",
        )
        missing = [term for term in required_terms if term not in profile_text]

        self.assertEqual(
            [],
            missing,
            f"Excel delivery coordinate contract is incomplete: missing={missing}",
        )

    def test_union_dispatch_rules_define_stable_unique_algorithm(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        algorithm = re.search(
            r"\bskills_to_load\s*=\s*stable_unique\s*\((?P<arguments>[\s\S]*?)\)",
            rules_text,
        )

        self.assertIsNotNone(
            algorithm,
            "union dispatch rules must define an executable stable_unique load algorithm",
        )
        arguments = algorithm.group("arguments")
        required_inputs = (
            "scope_skills",
            "asset_skills",
            "business_skills",
            "method_skills",
            "overlay_skills",
            "public_skills",
        )
        missing = [
            name
            for name in required_inputs
            if re.search(rf"\b{re.escape(name)}\b", arguments) is None
        ]

        self.assertEqual([], missing, f"stable union algorithm is missing inputs: {missing}")

    def test_cost_method_uses_generic_rule_and_realestate_adds_specialized_checklist(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        cost_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(r"\|\s*method\s*\|\s*`成本法`\s*\|", line)
        ]

        self.assertEqual(
            1,
            len(cost_rows),
            "成本法必须有且只有一条独立装配映射，不能与资产基础法共用映射行",
        )
        cost_row = cost_rows[0]
        self.assertIn(
            "03-评估方法/00-评估方法准则2019-精编/评估方法准则2019-精编条目/04-成本法",
            cost_row,
            "成本法映射必须装配成本法准则条目",
        )
        self.assertNotIn(
            "06-规则库/清单-M-成本法/",
            cost_row,
            "通用成本法映射不得无条件装配房地产专项清单",
        )
        self.assertNotIn(
            "06-规则库/清单-M-资产基础法/",
            cost_row,
            "成本法不得误装资产基础法专项清单",
        )

        realestate_cost_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(
                r"\|\s*method\+asset\s*\|\s*`成本法`\s*∧\s*`房地产`\s*\|",
                line,
            )
        ]
        self.assertEqual(
            1,
            len(realestate_cost_rows),
            "房地产成本法专项清单必须有独立的 method+asset 条件映射",
        )
        self.assertIn(
            "06-规则库/清单-M-成本法/",
            realestate_cost_rows[0],
            "成本法且资产类型为房地产时必须追加不动产成本法专项清单",
        )
        self.assertIn(
            "跨轴专项映射是在单轴共性映射基础上追加，不替代单轴共性资料",
            rules_text,
            "分发规则必须明确跨轴专项清单不会替代成本法共性准则",
        )

    def test_asset_based_method_inherits_cost_principles_and_realestate_adds_checklist(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        classification_path = AUDIT_SKILL_ROOT / "references/05-method-classification.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        self.assertTrue(
            classification_path.is_file(),
            f"missing method classification rules: {classification_path}",
        )
        rules_text = rules_path.read_text(encoding="utf-8")
        classification_text = classification_path.read_text(encoding="utf-8")
        asset_based_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(r"\|\s*method\s*\|\s*`资产基础法`\s*\|", line)
        ]

        self.assertEqual(
            1,
            len(asset_based_rows),
            "资产基础法必须有且只有一条独立装配映射",
        )
        asset_based_row = asset_based_rows[0]
        self.assertIn(
            "03-评估方法/00-评估方法准则2019-精编/评估方法准则2019-精编条目/04-成本法",
            asset_based_row,
            "资产基础法属于成本法项下的成本加和法，必须继承成本法共性准则",
        )
        self.assertIn(
            "03-评估方法/03-资产基础法/",
            asset_based_row,
            "资产基础法必须继续装配自身方法说明",
        )
        self.assertNotIn(
            "06-规则库/清单-M-资产基础法/",
            asset_based_row,
            "通用资产基础法映射不得无条件装配房地产专项清单",
        )
        self.assertNotIn(
            "06-规则库/清单-M-成本法/",
            asset_based_row,
            "继承成本法共性准则不等于装配直接成本法专项清单",
        )

        realestate_asset_based_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(
                r"\|\s*method\+asset\s*\|\s*`资产基础法`\s*∧\s*`房地产`\s*\|",
                line,
            )
        ]
        self.assertEqual(
            1,
            len(realestate_asset_based_rows),
            "房地产资产基础法专项清单必须有独立的 method+asset 条件映射",
        )
        self.assertIn(
            "06-规则库/清单-M-资产基础法/",
            realestate_asset_based_rows[0],
            "资产基础法且资产类型为房地产时必须追加不动产专项清单",
        )

        required_classification_terms = (
            "资产基础法即成本法项下的成本加和法",
            "保留独立 canonical 标签",
            "不得据此新增一个 `成本法` 标签",
            "不得装配 `06-规则库/清单-M-成本法/`",
            "仅在 `asset_types[]` 同时命中 `房地产` 时追加资产基础法不动产专项清单",
        )
        missing = [
            term for term in required_classification_terms if term not in classification_text
        ]
        self.assertEqual(
            [],
            missing,
            f"方法分类缺少资产基础法与成本法的继承/隔离规则: {missing}",
        )

    def test_financial_reporting_coverage_uses_business_trigger(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        financial_business_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(r"\|\s*business\s*\|\s*`财务报告`\s*\|", line)
        ]
        financial_overlay_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(r"\|\s*overlay\s*\|\s*`财务报告`\s*\|", line)
        ]

        self.assertEqual(
            1,
            len(financial_business_rows),
            "财务报告覆盖规则必须由已存在的 business=财务报告 标签装配",
        )
        self.assertIn(
            "04-监管覆盖/财务报告/",
            financial_business_rows[0],
            "财务报告业务映射必须装配财务报告覆盖层规则",
        )
        self.assertEqual(
            [],
            financial_overlay_rows,
            "overlays[] 不会产生财务报告标签，不得保留不可达的 overlay 映射",
        )

        financial_skill_root = SKILLS_ROOT / "crwu-audit-biz-financial-reporting"
        if not financial_skill_root.is_dir():
            self.skipTest("未安装财务报告业务技能：跳过其源仓执行契约检查")
        skill_text = (financial_skill_root / "SKILL.md").read_text(encoding="utf-8")
        review_text = (financial_skill_root / "references/02-review-focus.md").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "RULE-01-02-617~629",
            skill_text,
            "财务报告业务技能必须执行已下载的财务报告覆盖层规则",
        )
        self.assertIn(
            "04-监管覆盖/财务报告/财务报告覆盖层规则",
            review_text,
            "财务报告业务审核关注点必须声明覆盖层规则的实际库内来源",
        )

    def _table_rows_under(self, text: str, heading_keyword: str) -> list[list[str]]:
        """Markdown 表格行（去掉表头与分隔行），只取 `heading_keyword` 小节内的。"""
        rows: list[list[str]] = []
        inside = False
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                if inside:
                    break
                inside = heading_keyword in stripped
                continue
            if not inside or not stripped.startswith("|"):
                continue
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if _is_markdown_separator(cells) or cells[0] in ("一级业务", "canonical 一级业务"):
                continue
            rows.append(cells)
        return rows

    def test_financial_reporting_classification_lists_all_five_subroutes(self):
        """财务报告的子业务取值域必须是 5 项，且含"商誉减值"（快照实况）。"""
        classification = (AUDIT_SKILL_ROOT / "references/04-business-classification.md").read_text(
            encoding="utf-8"
        )
        rows = {
            cells[0]: cells[1]
            for cells in self._table_rows_under(classification, "子业务识别")
            if len(cells) >= 2
        }
        self.assertIn("财务报告", rows, f"子业务表缺少财务报告行：{rows}")
        subroutes = [item for item in re.split(r"[、,，]", rows["财务报告"]) if item]
        self.assertEqual(
            ["公允价值计量", "合并对价分摊", "商誉减值", "资产入账", "资产减值测试"],
            subroutes,
            "财务报告子业务必须为 5 项且含「商誉减值」",
        )

    def test_goodwill_impairment_test_maps_to_goodwill_subroute(self):
        """"商誉减值测试"必须落到子业务"商誉减值"，不得再归并到"资产减值测试"。"""
        classification = (AUDIT_SKILL_ROOT / "references/04-business-classification.md").read_text(
            encoding="utf-8"
        )
        self.assertNotIn(
            "商誉减值测试` 得到 `财务报告`（子业务 `资产减值测试`）",
            classification,
            "旧的错误示例（商誉减值测试 → 资产减值测试）必须已移除",
        )
        self.assertIn("商誉减值测试", classification, "分类表必须保留「商誉减值测试」这个命中信号")
        self.assertRegex(
            classification,
            r"商誉减值测试[^\n]{0,40}商誉减值",
            "命中示例必须把「商誉减值测试」指向子业务「商誉减值」",
        )

    def test_goodwill_impairment_test_keeps_both_axes(self):
        """"商誉减值测试"同时产生资产轴与业务轴结果，任一轴不得替代另一轴。"""
        asset_classification = (AUDIT_SKILL_ROOT / "references/03-asset-classification.md").read_text(
            encoding="utf-8"
        )
        self.assertRegex(
            asset_classification,
            r"资产组-含商誉[^\n]*商誉减值测试[^\n]*crwu-audit-asset-asset-group-goodwill",
            "资产轴必须把「商誉减值测试」映射到 crwu-audit-asset-asset-group-goodwill",
        )
        business_classification = (
            AUDIT_SKILL_ROOT / "references/04-business-classification.md"
        ).read_text(encoding="utf-8")
        self.assertIn("crwu-audit-biz-financial-reporting", business_classification)
        dispatch = (AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("stable_unique", dispatch, "两轴结果必须经稳定并集合并")
        # 08 的现行口径是「禁止首个命中即停止 / 用一个轴覆盖另一个轴」，以及归并时
        # 「不能只留最后写入者」——不得改写成别的说法，否则这条断言失去它守的东西。
        self.assertIn("用一个轴覆盖另一个轴", dispatch, "任一轴不得覆盖另一轴")
        self.assertIn("不能只留最后写入者", dispatch, "跨轴同一事实归并后必须保留全部来源")

    def test_second_level_selection_keeps_all_hits_and_flags_low_confidence(self):
        """二级选择：多命中全部保留、低置信度标记 review_required=true。"""
        for relative in (
            "references/03-asset-classification.md",
            "references/04-business-classification.md",
        ):
            text = (AUDIT_SKILL_ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("首次命中即停止", text, f"{relative} 必须显式禁止首次命中即停止")
            # 字段名两处一致；`=true` 的显式取值写在 04（本次可改范围），03 只登记字段。
            self.assertIn("review_required", text, f"{relative} 必须登记低置信度人工复核字段")
        four = (AUDIT_SKILL_ROOT / "references/04-business-classification.md").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "review_required=true", four, "04 必须显式要求低置信度标记 review_required=true"
        )

    def test_asset_and_business_leaves_no_longer_claim_missing_second_level(self):
        """机器设备/债权不得再声称没有 02-细分对象；财务报告必须索引 5 个子业务。"""
        expectations = {
            "crwu-audit-asset-equipment": ["通用设备", "专用设备", "电子设备", "闲置及报废设备"],
            "crwu-audit-asset-debt": ["不良债权", "应收账款", "其他应收款", "抵债资产"],
        }
        for skill, labels in expectations.items():
            leaf = SKILLS_ROOT / skill
            if not leaf.is_dir():
                self.skipTest(f"未安装 {skill}：跳过其二级索引检查")
            texts = {
                name: (leaf / "references" / name).read_text(encoding="utf-8")
                for name in ("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md")
            }
            joined = "\n".join(texts.values())
            self.assertNotIn("未提供 `02-细分对象", joined, f"{skill} 仍声明没有细分对象")
            for label in labels:
                self.assertIn(label, texts["00-applicability.md"], f"{skill} 分类表缺少 {label}")
                self.assertIn(label, texts["01-kb-assembly.md"], f"{skill} 装配索引缺少 {label}")
                self.assertIn(label, texts["02-review-focus.md"], f"{skill} 审核关注点缺少 {label}")

        financial = SKILLS_ROOT / "crwu-audit-biz-financial-reporting"
        if financial.is_dir():
            joined = "\n".join(
                (financial / "references" / name).read_text(encoding="utf-8")
                for name in ("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md")
            )
            for subroute in ("公允价值计量", "合并对价分摊", "商誉减值", "资产入账", "资产减值测试"):
                self.assertIn(subroute, joined, f"财务报告叶子缺少子业务 {subroute}")

    def test_income_checklist_requires_enterprise_value_asset(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        income_method_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(r"\|\s*method\s*\|\s*`收益法`\s*\|", line)
        ]
        enterprise_income_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(
                r"\|\s*method\+asset\s*\|\s*`收益法`\s*∧\s*`企业价值`\s*\|",
                line,
            )
        ]

        self.assertEqual(
            1,
            len(income_method_rows),
            "收益法必须有且只有一条不区分资产类型的通用方法映射",
        )
        self.assertIn(
            "03-评估方法/02-收益法/",
            income_method_rows[0],
            "所有收益法项目都必须装配通用收益法目录",
        )
        self.assertNotIn(
            "06-规则库/清单-M-收益法/",
            income_method_rows[0],
            "通用收益法映射不得无条件装配企业价值专项清单",
        )
        self.assertEqual(
            1,
            len(enterprise_income_rows),
            "企业价值收益法专项清单必须有独立的 method+asset 条件映射",
        )
        self.assertIn(
            "06-规则库/清单-M-收益法/",
            enterprise_income_rows[0],
            "收益法且资产类型为企业价值时必须装配企业价值收益法专项清单",
        )

    def test_market_method_uses_generic_rules_and_realestate_adds_specialized_checklist(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        market_method_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(r"\|\s*method\s*\|\s*`市场法`\s*\|", line)
        ]
        realestate_market_rows = [
            line
            for line in rules_text.splitlines()
            if re.search(
                r"\|\s*method\+asset\s*\|\s*`市场法`\s*∧\s*`房地产`\s*\|",
                line,
            )
        ]

        self.assertEqual(1, len(market_method_rows), "市场法必须有一条通用方法映射")
        market_row = market_method_rows[0]
        self.assertIn(
            "03-评估方法/00-评估方法准则2019-精编/评估方法准则2019-精编条目/02-市场法",
            market_row,
            "所有市场法项目都必须装配市场法准则条目",
        )
        self.assertIn(
            "03-评估方法/01-市场法/",
            market_row,
            "所有市场法项目都必须装配通用市场法说明",
        )
        self.assertNotIn(
            "06-规则库/清单-M-市场法/",
            market_row,
            "通用市场法映射不得无条件装配房地产专项清单",
        )
        self.assertEqual(
            1,
            len(realestate_market_rows),
            "房地产市场法专项清单必须有独立的 method+asset 条件映射",
        )
        self.assertIn(
            "06-规则库/清单-M-市场法/",
            realestate_market_rows[0],
            "市场法且资产类型为房地产时必须追加不动产市场法专项清单",
        )

        realestate_assembly = (
            SKILLS_ROOT / "crwu-audit-asset-realestate/references/01-kb-assembly.md"
        )
        if not realestate_assembly.is_file():
            self.skipTest("未安装房地产资产技能：跳过方法层所有权检查")
        assembly_text = realestate_assembly.read_text(encoding="utf-8")
        obsolete_keys = (
            "VALUATION_METHOD_INTERFACE",
            "MARKET_METHOD_CHECKLIST",
            "MARKET_METHOD_NOTES",
            "METHOD_DEFECT_LIST",
            "PITFALL_LIBRARY",
        )
        remaining = [key for key in obsolete_keys if f"`{key}`" in assembly_text]
        self.assertEqual(
            [],
            remaining,
            f"房地产资产叶子不得无条件持有方法层或公共层装配键: {remaining}",
        )

    def test_union_dispatch_rules_load_four_skills_for_realestate_liquidation_auction(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        scenario_start = rules_text.find("房地产清算后拍卖处置")

        self.assertGreaterEqual(
            scenario_start,
            0,
            "union dispatch rules must include the realestate liquidation auction scenario",
        )
        scenario_body = rules_text[scenario_start : scenario_start + 1200]
        expected_skills = (
            "crwu-audit-asset-realestate",
            "crwu-audit-biz-judicial-liquidation-compensation",
            "crwu-audit-biz-transaction-disposal",
        )
        missing = [skill for skill in expected_skills if skill not in scenario_body]

        self.assertEqual(
            [],
            missing,
            f"realestate liquidation auction scenario is missing nearby skills: {missing}",
        )

    @_requires_skill_tree
    def test_axis_named_leaf_skills_replace_legacy_combined_skills(self):
        asset_leaf = SKILLS_ROOT / "crwu-audit-asset-realestate/SKILL.md"
        obsolete_skill_dirs = (
            SKILLS_ROOT / "crwu-audit-realestate",
            SKILLS_ROOT / "crwu-audit-realestate-rent",
        )
        remaining = [str(path.relative_to(REPO_ROOT)) for path in obsolete_skill_dirs if path.exists()]

        self.assertTrue(asset_leaf.is_file(), f"missing axis-named asset leaf: {asset_leaf}")
        self.assertEqual([], remaining, f"legacy combined skill directories remain: {remaining}")

    @_requires_skill_tree
    def test_leaf_skill_directories_use_axis_prefixes_only(self):
        approved = ("crwu-audit-asset-", "crwu-audit-biz-")
        offenders = sorted(
            child.name
            for child in SKILLS_ROOT.iterdir()
            if child.is_dir()
            and child.name.startswith("crwu-audit-")
            and not child.name.startswith(approved)
            and child.name
            not in {
                "crwu-audit",
                "crwu-dev-audit-optimize",
                "crwu-dev-audit-skill-maintainer",
                "crwu-audit-datacheck",
                "crwu-audit-external-data",
                "crwu-audit-output-filter",
                "crwu-audit-public-general-standards",
            }
        )

        self.assertEqual([], offenders, f"crwu-audit leaf directories must use axis prefixes: {offenders}")

    def test_unconditional_public_skills_are_not_conditioned_on_professional_axes(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        router_path = AUDIT_SKILL_ROOT / "SKILL.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        self.assertTrue(router_path.is_file(), f"missing router skill entry: {router_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        # 建 public_skills 的**可执行步骤**（F-016 后归 references/14）也必须写明无条件规则，
        # 否则并集算法（08）与可执行步骤会再次漂移 —— 故此处读组合契约文本。
        router_text = router_orchestration_text()

        public_expression = re.search(
            r"public_skills\s*=\s*(?P<expression>[\s\S]*?)\n\n",
            rules_text,
        )

        self.assertIsNotNone(
            public_expression,
            "union dispatch rules must define the public_skills expression",
        )
        expression = public_expression.group("expression")
        for skill in UNCONDITIONAL_PUBLIC_SKILLS:
            self.assertIn(
                skill,
                expression,
                f"public_skills expression must always include {skill}",
            )
            self.assertNotIn(
                f"{skill}] when",
                expression,
                f"{skill} must not be conditioned on materials or professional labels",
            )
        self.assertNotIn(
            "else []",
            expression.split("crwu-audit-public-general-standards", 1)[0],
            "unconditional public skills must be declared before any conditional branch",
        )

        # The router step that builds public_skills must state the unconditional rule too,
        # otherwise the algorithm and the runnable step can drift apart.
        self.assertIn(
            "crwu-audit-public-general-standards",
            router_text,
            "router SKILL.md must name the unconditional public skill in its public-capability step",
        )
        self.assertIn(
            "crwu-audit-output-filter",
            router_text,
            "router SKILL.md must name the unconditional output-filter skill",
        )

    @_requires_skill_tree
    def test_public_skill_directory_and_references_exist(self):
        for skill in UNCONDITIONAL_PUBLIC_SKILLS:
            skill_dir = SKILLS_ROOT / skill
            self.assertTrue(skill_dir.is_dir(), f"missing public-axis skill directory: {skill}")
            skill_entry = skill_dir / "SKILL.md"
            self.assertTrue(skill_entry.is_file(), f"missing public-axis SKILL.md: {skill}")
            entry_text = skill_entry.read_text(encoding="utf-8")
            self.assertIn(
                f"name: {skill}",
                entry_text,
                f"{skill} frontmatter name must match its directory name",
            )
            self.assertIn(
                "仅经 `crwu-audit` router 编排调用，禁止单独调用",
                entry_text,
                f"{skill} must declare the router-only invocation gate",
            )
            for reference in ("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md"):
                reference_path = skill_dir / "references" / reference
                self.assertTrue(
                    reference_path.is_file(),
                    f"{skill} is missing required reference: {reference}",
                )

    @_requires_skill_tree
    def test_output_filter_uses_only_the_runtime_checklist_before_phase1_freeze(self):
        skill_dir = SKILLS_ROOT / "crwu-audit-output-filter"
        entry_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        assembly_text = (skill_dir / "references/01-kb-assembly.md").read_text(encoding="utf-8")
        # "输出过滤发生在阶段一冻结前"是运行时编排顺序，F-016 后由 references/14 承载，
        # 故顺序断言读组合契约文本（技能自身的断言仍只读其 SKILL.md）。
        router_text = router_orchestration_text()

        self.assertIn("06-规则库/04-AI审核意见屏蔽/02-屏蔽清单", assembly_text)
        self.assertNotIn("06-规则库/04-AI审核意见屏蔽/01-维护规则", assembly_text)
        self.assertIn("候选审核意见汇总完成后", entry_text)
        self.assertIn("阶段一冻结前", entry_text)
        self.assertIn("匹配标识", entry_text)
        self.assertIn("不屏蔽例外", entry_text)
        self.assertIn("不进入正式审核结果", entry_text)

        filter_pos = router_text.index("crwu-audit-output-filter")
        freeze_pos = router_text.index("阶段一独立汇总、过滤并冻结")
        self.assertLess(filter_pos, freeze_pos, "output filter must run before the phase-one freeze")

    @_requires_skill_tree
    def test_external_data_skill_is_registered_and_conditionally_dispatched(self):
        """外部数据核验能力：public 轴登记 + 按收益法/市场法条件装配 + 技能自带装配与探测件齐备。"""
        registry_text = (AUDIT_SKILL_ROOT / "references/07-skill-registry.md").read_text(encoding="utf-8")
        rows = _registry_data_rows(registry_text)
        self.assertIsNotNone(rows, "skill registry table must be parseable")
        self.assertIn(
            ("public", "外部数据核验", "crwu-audit-external-data", "available",
             "触发语义见 `08-union-dispatch-rules.md`（`methods[]` 命中 收益法/市场法）；本表不复述"),
            rows,
            "crwu-audit-external-data must be registered on the public axis",
        )

        rules_text = (AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md").read_text(encoding="utf-8")
        expression = re.search(r"public_skills\s*=\s*(?P<expression>[\s\S]*?)\n\n", rules_text)
        self.assertIsNotNone(expression, "union dispatch rules must define the public_skills expression")
        body = expression.group("expression")
        self.assertIn("crwu-audit-external-data", body, "public_skills must include the external-data capability")
        self.assertNotIn(
            "crwu-audit-external-data] when methods",
            body.split("crwu-audit-public-general-standards", 1)[0],
            "conditional public skills must be declared after the unconditional one",
        )

        skill_dir = SKILLS_ROOT / "crwu-audit-external-data"
        self.assertTrue(skill_dir.is_dir(), "missing crwu-audit-external-data skill directory")
        for rel in ("SKILL.md", "references/00-KB装配表.md", "references/01-connector-access.md",
                    "references/02-verification-workflow.md",
                    "scripts/connector_probe.py", "scripts/test_connector_probe.py"):
            self.assertTrue((skill_dir / rel).is_file(), f"crwu-audit-external-data is missing {rel}")
        entry_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("name: crwu-audit-external-data", entry_text)
        self.assertIn("仅经 `crwu-audit` router 编排调用，禁止单独调用", entry_text)
        self.assertIn("06-规则库/M-外部数据核验/01-模块-外部数据核验",
                      (skill_dir / "references/00-KB装配表.md").read_text(encoding="utf-8"),
                      "KB assembly table must address the external-data module by in-KB path")

    @_requires_skill_tree
    def test_external_data_base_date_gate_is_tiered(self):
        """基准日门禁必须是三档，且不得退回"挂起即整线不取数"的一刀切。

        依据 08-union-dispatch-rules.md：ROUTE003 挂起 base_date 及依赖基准日的规则/结论，
        但不按技能身份无差别停载；不依赖冲突字段的检查仍须执行。
        """
        # OPT-009C：基准日三档已下沉到 references/02-verification-workflow.md；断言读组合契约文本。
        workflow_text = external_data_workflow_text()
        for tier in ("唯一确定", "多候选（ROUTE003 挂起", "缺失 / 不可解析"):
            self.assertIn(tier, workflow_text, f"base-date gate must define tier: {tier}")
        self.assertIn("条件性取数", workflow_text, "multi-candidate tier must allow conditional fetch")
        self.assertIn("不自行判定 ROUTE 冲突", workflow_text, "the gate must defer conflict judgement to the router")
        self.assertIn(
            "不依赖冲突字段的规则仍须执行",
            workflow_text,
            "the gate must not stop all checks on a hung base date",
        )
        self.assertNotIn(
            "基准日本身存疑（ROUTE003 挂起）时，本技能不取数",
            workflow_text,
            "the one-size-fits-all kill switch must not come back",
        )

    @_requires_skill_tree
    def test_external_data_host_entries_are_host_bound(self):
        """R3B：取数入口文档必须 host-bound —— 探测脚本只属 WorkBuddy，DSH 入口是结构化 Tool。

        过期文档把 `connector_probe.py` 写成"两宿主通用的可用性预检"，并把 DeepSeek Harness 的
        入口写成第三方技能目录。本测试只锁稳定语义：宿主边界、脚本的宿主归属、DSH 不运行探测脚本、
        以及 DSH 入口的结构化 Tool 名（除 Tool 名外不锁具体措辞）。
        """
        docs = {}
        for rel in EXTERNAL_DATA_ENTRY_DOCS:
            path = skill_path(rel)
            self.assertTrue(path.is_file(), f"缺少宿主入口文档：{rel}")
            docs[rel] = path.read_text(encoding="utf-8")

        # 1) 三份文档都不得再把 DSH 取数入口写成第三方技能。
        for rel, text in docs.items():
            self.assertNotIn(
                LEGACY_DSH_IFIND_SKILL,
                text,
                f"{rel} 仍把 DSH 取数入口写成第三方技能（应为结构化 Tool {DSH_IFIND_TOOL}）",
            )

        skill_md = docs[EXTERNAL_DATA_ENTRY_DOCS[0]]
        access_md = docs[EXTERNAL_DATA_ENTRY_DOCS[1]]
        rules_md = docs[EXTERNAL_DATA_ENTRY_DOCS[2]]

        # 2) 探测脚本只能出现在明确的宿主语境里 —— 不得再作"两宿主通用预检"。
        for rel in EXTERNAL_DATA_ENTRY_DOCS[:2]:
            probe_lines = [line for line in docs[rel].splitlines() if HOST_CONNECTOR_PROBE in line]
            self.assertTrue(probe_lines, f"{rel} 必须保留 WorkBuddy 侧的探测脚本说明")
            for line in probe_lines:
                self.assertTrue(
                    any(label in line for label in HOST_LABELS),
                    f"{rel} 里探测脚本必须写明所属宿主（不得写成通用预检）：{line.strip()!r}",
                )

        # 3) SKILL.md：明确 DeepSeek Harness 不运行该脚本判断可用性。
        self.assertRegex(
            skill_md,
            r"DeepSeek Harness[^\n。]{0,40}不运行[^\n。]{0,40}" + re.escape(HOST_CONNECTOR_PROBE),
            "SKILL.md 必须写明 DeepSeek Harness 不运行探测脚本判断可用性",
        )

        # 4) 01-connector-access.md：DSH 没有 WorkBuddy 的宿主声明探测级（L2）。
        self.assertRegex(
            access_md,
            r"DeepSeek Harness[^\n。]{0,20}无此级",
            "01-connector-access.md 必须写明 DeepSeek Harness 没有宿主声明探测级",
        )

        # 5) 08-union-dispatch-rules.md：DSH 路径写成结构化 Tool。
        self.assertIn(
            DSH_IFIND_TOOL,
            rules_md,
            f"08-union-dispatch-rules.md 必须把 DSH 取数路径写成结构化 Tool {DSH_IFIND_TOOL}",
        )

    @_requires_skill_tree
    def test_current_catalog_and_design_docs_name_the_structured_tool(self):
        """R3C：现行技能目录、架构说明与可执行样例都不得再留旧 DSH 技能路径。

        这三处都是"现行"内容：`docs/skills.md` 是技能目录，设计文档仍承担架构说明职责，
        样例 JSON 会渲染进交付 HTML。源仓文档在安装副本里不存在 → 显式 skip，不静默通过。
        """
        catalog_docs = (
            REPO_ROOT / "docs/skills.md",
            REPO_ROOT / "docs/v0.0.1/design-crwu-audit-skills.md",
        )
        present = [path for path in catalog_docs if path.is_file()]
        if not present:
            self.skipTest("安装副本内没有源仓现行文档：跳过技能目录与架构说明的路径检查")

        sample_rel = "crwu-audit/scripts/examples/audit-result.sample.json"
        targets = [(str(path.relative_to(REPO_ROOT)), path.read_text(encoding="utf-8")) for path in present]
        targets.append((sample_rel, skill_path(sample_rel).read_text(encoding="utf-8")))

        for rel, text in targets:
            self.assertNotIn(
                LEGACY_DSH_IFIND_SKILL,
                text,
                f"{rel} 仍把 DSH 取数入口写成第三方技能（应为结构化 Tool {DSH_IFIND_TOOL}）",
            )
            self.assertIn(
                DSH_IFIND_TOOL,
                text,
                f"{rel} 必须把 DSH 取数入口写成结构化 Tool {DSH_IFIND_TOOL}",
            )

    @_requires_skill_tree
    def test_external_data_progressively_discloses_verification_workflow(self):
        """OPT-009C：external-data 入口必须渐进披露——核验流程与字段契约归 `references/02`。

        只锁**文件所有权、入口大小与稳定语义标识**，不断言整段逐字文案。入口的调用门禁、输入、
        单源声明与宿主安全边界仍必须**直接**留在 `SKILL.md`。
        """
        entry_path = skill_path(f"{EXTERNAL_DATA_SKILL}/SKILL.md")
        reference_path = skill_path(EXTERNAL_DATA_WORKFLOW_REFERENCE)
        self.assertTrue(reference_path.is_file(), f"missing verification workflow reference: {reference_path}")
        entry = entry_path.read_text(encoding="utf-8")
        reference = reference_path.read_text(encoding="utf-8")

        # 1+2) 入口必须显式链接该 reference，并要求执行前读取。
        self.assertIn(
            "references/02-verification-workflow.md", entry,
            "external-data 入口必须链接 references/02-verification-workflow.md",
        )
        self.assertIn("执行前必读", entry, "入口必须要求执行前读取核验流程 reference")

        # 3) 入口体积上限：核验流程正文不应再占入口。
        line_count = len(entry.splitlines())
        self.assertLessEqual(
            line_count, EXTERNAL_DATA_ENTRY_MAX_LINES,
            f"external-data 入口过长：{line_count} 行（上限 {EXTERNAL_DATA_ENTRY_MAX_LINES}）",
        )
        byte_size = len(entry.encode("utf-8"))
        self.assertLessEqual(
            byte_size, EXTERNAL_DATA_ENTRY_MAX_BYTES,
            f"external-data 入口过大：{byte_size} bytes（上限 {EXTERNAL_DATA_ENTRY_MAX_BYTES}）",
        )

        # 4) 条件/字段细节只在 02：入口不得再出现，02 必须承载。
        for token in EXTERNAL_DATA_DETAIL_TOKENS:
            self.assertNotIn(
                token, entry,
                f"{token} 属核验流程/交付字段细节，应只出现在 {EXTERNAL_DATA_WORKFLOW_REFERENCE}",
            )
            self.assertIn(
                token, reference,
                f"{EXTERNAL_DATA_WORKFLOW_REFERENCE} 必须承载 {token}",
            )

        # 5) 基准日三档必须完整保留在 02。
        for tier in ("唯一确定", "多候选（ROUTE003 挂起", "缺失 / 不可解析"):
            self.assertIn(tier, reference, f"02 必须保留基准日档位：{tier}")

        # 6) 02 必须保留流程与交付语义标识。
        for token in EXTERNAL_DATA_WORKFLOW_TOKENS:
            self.assertIn(token, reference, f"{EXTERNAL_DATA_WORKFLOW_REFERENCE} 必须保留 {token}")

        # 7) 02 中核验步骤 0–7 必须完整且有序（步骤行形如 `N. **...**`）。
        steps = [int(number) for number in re.findall(r"(?m)^(\d+)\.\s\*\*", reference)]
        self.assertEqual(
            list(range(8)), steps,
            f"{EXTERNAL_DATA_WORKFLOW_REFERENCE} 必须按序保留核验步骤 0–7，实际={steps}",
        )

        # 8) 入口必须继续直接保留稳定边界。
        for token in EXTERNAL_DATA_ENTRY_TOKENS:
            self.assertIn(token, entry, f"入口必须直接保留稳定边界标识：{token}")

        # 9) references 集合必须恰为三者（无缺失、无意外额外文件）。
        references_root = entry_path.parent / "references"
        actual = {path.name for path in references_root.glob("*.md")}
        self.assertEqual(
            set(EXTERNAL_DATA_REFERENCE_SET), actual,
            f"external-data reference 集合不符：{sorted(actual)}",
        )

    @_requires_skill_tree
    def test_conditional_public_skills_are_not_unconditional(self):
        rules_text = (AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md").read_text(encoding="utf-8")
        expression = re.search(r"public_skills\s*=\s*(?P<expression>[\s\S]*?)\n\n", rules_text)
        self.assertIsNotNone(expression, "union dispatch rules must define the public_skills expression")
        body = expression.group("expression")
        for skill in CONDITIONAL_PUBLIC_SKILLS:
            self.assertIn(skill, body, f"public_skills must declare the condition for {skill}")
            self.assertRegex(
                body,
                re.compile(re.escape(skill) + r"\]\s*when\b"),
                f"{skill} must carry an explicit trigger condition",
            )

    @_requires_skill_tree
    def test_active_contracts_do_not_reference_deleted_combined_skill(self):
        active_paths = (
            REPO_ROOT / "docs/skills.md",
            AUDIT_SKILL_ROOT / "SKILL.md",
            SKILLS_ROOT / "crwu-audit-asset-realestate/SKILL.md",
            SKILLS_ROOT / "crwu-dev-audit-skill-maintainer/SKILL.md",
        )
        forbidden_skill = "crwu-audit-realestate-rent"
        violations = [
            str(path.relative_to(REPO_ROOT))
            for path in active_paths
            if path.is_file() and forbidden_skill in path.read_text(encoding="utf-8")
        ]

        self.assertEqual(
            [],
            violations,
            f"active contracts still reference {forbidden_skill}: {violations}",
        )

    def test_skill_registry_names_every_dispatch_axis(self):
        registry_path = AUDIT_SKILL_ROOT / "references/07-skill-registry.md"
        self.assertTrue(registry_path.is_file(), f"missing skill registry: {registry_path}")
        registry_text = registry_path.read_text(encoding="utf-8")
        registry_rows = _registry_data_rows(registry_text)

        self.assertIsNotNone(
            registry_rows,
            f"registry must contain the Markdown header: {' | '.join(REGISTRY_HEADER)}",
        )
        missing = [row for row in EXPECTED_REGISTRY_ROWS if row not in registry_rows]
        registered_skills = {row[2] for row in registry_rows}

        self.assertEqual([], missing, f"skill registry is missing required relationship rows: {missing}")
        self.assertNotIn(
            LEGACY_REGISTRY_SKILL,
            registered_skills,
            f"legacy combined skill remains registered: {LEGACY_REGISTRY_SKILL}",
        )
        axes = {row[0] for row in registry_rows}
        absent = [axis for axis in DISPATCH_AXES if axis not in axes]
        self.assertEqual([], absent, f"registry does not name every dispatch axis: {absent}")
        # Registry<->reality hygiene (a retired-prefix row still marked `available`, or an
        # available row whose skill directory does not exist) is owned by the skill
        # maintainer mapping checker, which reports it with per-row evidence:
        #   python3 <skills 根>/crwu-dev-audit-skill-maintainer/scripts/check_audit_skill_mappings.py
        #   -> LEGACY_BUSINESS_PREFIX / AVAILABLE_SKILL_DIRECTORY_MISSING / REGISTRY_LABEL_NOT_IN_CATALOG
        # It is deliberately not duplicated here, so the in-flight migration has one owner.


if __name__ == "__main__":
    unittest.main()
