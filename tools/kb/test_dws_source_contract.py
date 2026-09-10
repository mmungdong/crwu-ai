from pathlib import Path
import glob
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]

# Active contracts that must never re-introduce a local knowledge-base root,
# a downloaded-body mirror, or a "publish gate" style local fallback.
ACTIVE_CONTRACT_FILES = [
    "skills/README.md",
    "skills/crwu-dws/SKILL.md",
    "skills/crwu-dws/references/00-目录快照schema.md",
    "skills/crwu-dws/references/01-审核下载与manifest规范.md",
    "skills/crwu-dws/references/02-缓存与兜底查找规范.md",
    "skills/crwu-audit/SKILL.md",
    "skills/crwu-audit/references/10-capability-gap-proposal.md",
    "skills/crwu-audit/references/99-maintenance.md",
    "skills/crwu-audit/references/04-business-classification.md",
    "skills/crwu-audit/references/12-leaf-common-contract.md",
    "skills/crwu-audit-asset-realestate/SKILL.md",
    "skills/crwu-audit-asset-realestate/references/01-kb-assembly.md",
    "skills/crwu-audit-biz-asset-operation/SKILL.md",
    "skills/crwu-audit-biz-asset-operation/references/02-review-focus.md",
    "skills/crwu-audit-datacheck/SKILL.md",
    "skills/crwu-audit-optimize/SKILL.md",
    "skills/crwu-audit-optimize/references/00-优化规范与文件落点.md",
    "skills/crwu-audit-optimize/references/01-反馈定位与画像流程.md",
    "skills/crwu-audit-skill-maintainer/SKILL.md",
    "skills/crwu-audit-skill-maintainer/references/01-kb-source-discovery.md",
    "skills/crwu-audit-skill-maintainer/references/02-child-skill-contract.md",
    "docs/design-audit-live-kb-protocol.md",
    "docs/design-crwu-dws.md",
]

FORBIDDEN_TERMS = [
    "CRWU_KB_ROOT",
    "M2-B",
    "全量镜像",
    "本地静态副本",
    "本地静态根",
    "维护/离线归档",
]

# A contract still has to be able to *document* a retirement ("CRWU_KB_ROOT 已废止").
# Only lines that present the term as a usable source are violations.
RETIREMENT_NOTE_WORDS = (
    "废止", "弃用", "废弃", "不再", "禁止", "不得", "红线", "三不写",
    "字面", "lint", "协议", "硬编码", "旧树", "retired", "deprecated",
)


def _is_retirement_note(line):
    return any(word in line for word in RETIREMENT_NOTE_WORDS)


class DwsSourceContractTest(unittest.TestCase):
    def test_every_active_contract_file_exists(self):
        missing = [path for path in ACTIVE_CONTRACT_FILES if not (REPO_ROOT / path).is_file()]

        self.assertEqual([], missing, f"active contract list points at missing files: {missing}")

    def test_active_contracts_do_not_offer_local_or_full_mirror_bodies(self):
        violations = []

        for relative_path in ACTIVE_CONTRACT_FILES:
            text = (REPO_ROOT / relative_path).read_text(encoding="utf-8")
            for lineno, line in enumerate(text.splitlines(), start=1):
                for term in FORBIDDEN_TERMS:
                    if term not in line:
                        continue
                    if _is_retirement_note(line):
                        continue
                    violations.append(f"{relative_path}:{lineno}: {term}")

        self.assertEqual([], violations, "\n".join(violations))

    def test_active_contracts_do_not_reference_a_local_kb_root_relative_path(self):
        """`KB/<rel>` addressed the retired local root; kb_tool owns the precise rule.

        `kb_tool.py validate --skill-root skills` distinguishes real `KB/<rel>` references
        from prose such as 『KB/知识库』 and from prohibition notes. Re-implementing a cruder
        text match here only produced false positives, so this test asserts the tool's
        verdict on the repository instead of scanning the text itself.
        """
        import subprocess
        import sys

        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "tools/kb/kb_tool.py"),
                "validate",
                "--skill-root",
                str(REPO_ROOT / "skills"),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(
            0,
            result.returncode,
            f"kb_tool validate reported reference violations:\n{result.stdout}{result.stderr}",
        )

    def test_m2_supports_file_directory_and_mixed_manifest_entries(self):
        text = (REPO_ROOT / "skills/crwu-dws/SKILL.md").read_text(encoding="utf-8")
        required_terms = [
            "单文件路径",
            "只下载该文件",
            "目录路径",
            "递归下载",
            "同一清单",
            "清单外零下载",
        ]

        for term in required_terms:
            with self.subTest(term=term):
                self.assertIn(term, text)

    def test_asset_and_business_leaves_declare_a_first_level_directory_root(self):
        """Every crwu-audit asset/biz leaf must map one recursive first-level root."""
        leaves = sorted(
            glob.glob(str(REPO_ROOT / "skills/crwu-audit-asset-*"))
            + glob.glob(str(REPO_ROOT / "skills/crwu-audit-biz-*"))
        )
        self.assertNotEqual([], leaves, "expected at least one asset leaf skill")

        missing = []
        for leaf in leaves:
            assembly = Path(leaf) / "references" / "01-kb-assembly.md"
            if not assembly.is_file():
                missing.append(f"{Path(leaf).name}: no 01-kb-assembly.md")
                continue
            text = assembly.read_text(encoding="utf-8")
            if "01-业务路线/" not in text and "02-资产类型/" not in text:
                missing.append(f"{Path(leaf).name}: no first-level library root")
            if "directory" not in text or "true" not in text:
                missing.append(f"{Path(leaf).name}: no directory/recursive contract")

        self.assertEqual([], missing, "\n".join(missing))

    def test_legacy_combined_and_business_prefixed_skills_are_gone(self):
        offenders = sorted(
            path.name
            for pattern in ("crwu-audit-business-*",)
            for path in (REPO_ROOT / "skills").glob(pattern)
            if path.is_dir()
        )
        self.assertEqual(
            [],
            offenders,
            f"legacy business-prefixed skill directories remain: {offenders}",
        )
        self.assertFalse(
            (REPO_ROOT / "skills/crwu-audit-realestate-rent").exists(),
            "legacy combined skill crwu-audit-realestate-rent must stay deleted",
        )


if __name__ == "__main__":
    unittest.main()
