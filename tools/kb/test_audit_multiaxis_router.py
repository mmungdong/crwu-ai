from pathlib import Path
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
    "scope_types",
    "asset_types",
    "business_types",
    "method_types",
    "overlay_types",
    "review_risk_class",
    "materiality",
    "asset-realestate",
    "business-rent",
    "并集",
)

REQUIRED_REGISTRY_PREFIXES = (
    "scope-",
    "asset-",
    "business-",
    "method-",
    "overlay-",
)


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

    def test_root_router_declares_multiaxis_profile_and_union_dispatch(self):
        router_path = AUDIT_SKILL_ROOT / "SKILL.md"
        self.assertTrue(router_path.is_file(), f"missing root router: {router_path}")
        router_text = router_path.read_text(encoding="utf-8")

        missing = [term for term in REQUIRED_ROUTER_TERMS if term not in router_text]

        self.assertEqual([], missing, f"root router is missing contract terms: {missing}")

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

        missing = [prefix for prefix in REQUIRED_REGISTRY_PREFIXES if prefix not in registry_text]

        self.assertEqual([], missing, f"skill registry is missing axis prefixes: {missing}")


if __name__ == "__main__":
    unittest.main()
