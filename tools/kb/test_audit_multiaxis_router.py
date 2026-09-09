from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
AUDIT_SKILL_ROOT = REPO_ROOT / "skills/crwu-audit"

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
    "99-maintenance.md",
)

OBSOLETE_REFERENCE_FILES = (
    "03-业务风险分类判定.md",
    "04-待建子技能提案.md",
)

REQUIRED_ROUTER_TERMS = (
    "SeqNo",
    "ObjectId",
    "scope_tags",
    "asset_tags",
    "business_tags",
    "method_tags",
    "overlay_tags",
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
)

REGISTRY_HEADER = ("axis", "skill", "layer", "relationship", "status/load behavior")

EXPECTED_REGISTRY_ROWS = (
    ("scope", "scope-valuation", "scope", "independent", "union"),
    ("asset", "asset-realestate", "asset", "independent", "union"),
    ("business", "business-rent", "business", "asset-realestate", "intersect"),
    ("method", "method-income", "method", "independent", "union"),
    ("overlay", "overlay-state-owned", "overlay", "independent", "union"),
    ("fallback", "fallback-gap", "fallback", "all axes miss", "record gap"),
)

LEGACY_SKILL_NAMES = {"crwu-audit-realestate", "crwu-audit-realestate-rent"}


def _markdown_cells(line):
    stripped = line.strip()
    if "|" not in stripped:
        return None
    return tuple(cell.strip().casefold() for cell in stripped.strip("|").split("|"))


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


class AuditMultiaxisRouterContractTest(unittest.TestCase):
    def test_multiaxis_router_reference_set_exists(self):
        references_root = AUDIT_SKILL_ROOT / "references"
        missing = [
            name for name in EXPECTED_REFERENCE_FILES if not (references_root / name).is_file()
        ]

        self.assertEqual([], missing, f"missing multiaxis router references: {missing}")

    def test_obsolete_combined_references_are_removed(self):
        references_root = AUDIT_SKILL_ROOT / "references"
        remaining = [
            name for name in OBSOLETE_REFERENCE_FILES if (references_root / name).exists()
        ]

        self.assertEqual([], remaining, f"obsolete combined references remain: {remaining}")

    def test_root_router_declares_multiaxis_profile_and_reference_set(self):
        router_path = AUDIT_SKILL_ROOT / "SKILL.md"
        self.assertTrue(router_path.is_file(), f"missing root router: {router_path}")
        router_text = router_path.read_text(encoding="utf-8")

        missing = [term for term in REQUIRED_ROUTER_TERMS if term not in router_text]

        self.assertEqual([], missing, f"root router is missing contract terms: {missing}")

    def test_root_router_rejects_legacy_level_routing(self):
        router_path = AUDIT_SKILL_ROOT / "SKILL.md"
        self.assertTrue(router_path.is_file(), f"missing root router: {router_path}")
        router_text = router_path.read_text(encoding="utf-8")

        self.assertIsNone(
            re.search(r"\bL[12]\b", router_text, flags=re.IGNORECASE),
            "root router must not retain the active L1/L2 routing model",
        )

    def test_union_dispatch_rules_define_stable_unique_algorithm(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")

        self.assertRegex(
            rules_text,
            r"\bskills_to_load\s*=\s*stable_unique\s*\(",
            "union dispatch rules must define an executable stable_unique load algorithm",
        )

    def test_union_dispatch_rules_load_four_skills_for_realestate_liquidation_auction(self):
        rules_path = AUDIT_SKILL_ROOT / "references/08-union-dispatch-rules.md"
        self.assertTrue(rules_path.is_file(), f"missing union dispatch rules: {rules_path}")
        rules_text = rules_path.read_text(encoding="utf-8")
        scenario = re.search(r"房地产清算后拍卖处置(?P<body>[\s\S]{0,800})", rules_text)

        self.assertIsNotNone(
            scenario,
            "union dispatch rules must include the realestate liquidation auction scenario",
        )
        scenario_body = scenario.group("body")
        expected_skills = (
            "asset-realestate",
            "business-liquidation",
            "business-disposal",
            "business-auction",
        )
        missing = [
            skill
            for skill in expected_skills
            if re.search(rf"(?<![\w-]){re.escape(skill)}(?![\w-])", scenario_body) is None
        ]

        self.assertEqual(
            [],
            missing,
            f"realestate liquidation auction scenario is missing nearby skills: {missing}",
        )

    def test_axis_named_leaf_skills_replace_legacy_combined_skills(self):
        required_leaf_files = (
            REPO_ROOT / "skills/crwu-audit-asset-realestate/SKILL.md",
            REPO_ROOT / "skills/crwu-audit-business-rent/SKILL.md",
        )
        obsolete_skill_dirs = (
            REPO_ROOT / "skills/crwu-audit-realestate",
            REPO_ROOT / "skills/crwu-audit-realestate-rent",
        )
        missing = [str(path.relative_to(REPO_ROOT)) for path in required_leaf_files if not path.is_file()]
        remaining = [str(path.relative_to(REPO_ROOT)) for path in obsolete_skill_dirs if path.exists()]

        self.assertEqual([], missing, f"missing axis-named leaf skills: {missing}")
        self.assertEqual([], remaining, f"legacy combined skill directories remain: {remaining}")

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
        registered_skills = {row[1] for row in registry_rows}
        legacy_skills = sorted(LEGACY_SKILL_NAMES.intersection(registered_skills))

        self.assertEqual([], missing, f"skill registry is missing required relationship rows: {missing}")
        self.assertEqual([], legacy_skills, f"legacy combined skills remain registered: {legacy_skills}")


if __name__ == "__main__":
    unittest.main()
