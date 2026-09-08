from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]

ACTIVE_CONTRACT_FILES = [
    "skills/README.md",
    "skills/crwu-dws/SKILL.md",
    "skills/crwu-dws/references/00-目录快照schema.md",
    "skills/crwu-dws/references/01-审核下载与manifest规范.md",
    "skills/crwu-dws/references/02-缓存与兜底查找规范.md",
    "skills/crwu-audit/SKILL.md",
    "skills/crwu-audit/references/04-待建子技能提案.md",
    "skills/crwu-audit/references/99-维护说明.md",
    "skills/crwu-audit-realestate/SKILL.md",
    "skills/crwu-audit-realestate/references/00-KB装配表.md",
    "skills/crwu-audit-realestate-rent/SKILL.md",
    "skills/crwu-audit-realestate-rent/references/00-KB装配表.md",
    "skills/crwu-audit-datacheck/SKILL.md",
    "skills/crwu-audit-datacheck/references/00-KB装配表.md",
    "skills/crwu-audit-optimize/SKILL.md",
    "skills/crwu-audit-optimize/references/00-优化规范与文件落点.md",
    "skills/crwu-audit-optimize/references/01-反馈定位与画像流程.md",
    "docs/design-audit-live-kb-protocol.md",
    "docs/design-crwu-dws.md",
]


class DwsSourceContractTest(unittest.TestCase):
    def test_active_contracts_do_not_offer_local_or_full_mirror_bodies(self):
        forbidden_terms = [
            "CRWU_KB_ROOT",
            "M2-B",
            "全量镜像",
            "本地静态副本",
            "本地静态根",
            "维护/离线归档",
        ]
        violations = []

        for relative_path in ACTIVE_CONTRACT_FILES:
            text = (REPO_ROOT / relative_path).read_text(encoding="utf-8")
            for term in forbidden_terms:
                if term in text:
                    violations.append(f"{relative_path}: {term}")

        self.assertEqual([], violations, "\n".join(violations))

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


if __name__ == "__main__":
    unittest.main()
