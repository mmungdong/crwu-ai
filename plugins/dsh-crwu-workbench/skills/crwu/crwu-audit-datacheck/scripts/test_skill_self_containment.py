#!/usr/bin/env python3
"""Source contract test: this Skill must not depend on sibling Skill internals."""

from pathlib import Path
import re
import unittest


SKILL_ROOT = Path(__file__).resolve().parents[1]
SKILL_NAME = SKILL_ROOT.name

# Match private paths written directly (``name/references/...``) or with a
# short prose bridge (``name 技能的 `scripts/...```) while allowing references
# to this Skill itself.
PRIVATE_SKILL_PATH = re.compile(
    r"(?P<skill>crwu-[a-z0-9-]+)(?:/|[^\n]{0,40}?)"
    r"(?:SKILL\.md|references/|scripts/)"
)


class SkillSelfContainmentTests(unittest.TestCase):
    def test_markdown_does_not_reference_sibling_skill_internals(self):
        violations = []
        for path in sorted(SKILL_ROOT.rglob("*.md")):
            for line_number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                for match in PRIVATE_SKILL_PATH.finditer(line):
                    if match.group("skill") != SKILL_NAME:
                        violations.append(
                            f"{path.relative_to(SKILL_ROOT)}:{line_number}: "
                            f"{match.group(0)}"
                        )

        self.assertEqual(
            [],
            violations,
            "Skill runtime documentation references sibling private files:\n"
            + "\n".join(violations),
        )


if __name__ == "__main__":
    unittest.main()
