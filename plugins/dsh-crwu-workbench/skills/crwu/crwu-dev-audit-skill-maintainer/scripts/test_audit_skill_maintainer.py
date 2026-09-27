from __future__ import annotations

import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
from typing import NamedTuple
import unittest
from unittest import mock


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


DATACHECK_ENTRY = "crwu-audit-datacheck/SKILL.md"
DATACHECK_REFERENCE = "crwu-audit-datacheck/references/01-runtime-and-check-catalog.md"


def datacheck_contract_text() -> str:
    """datacheck 契约文本 = 入口 `SKILL.md` + `references/01-runtime-and-check-catalog.md`。

    OPT-009B 把运行时工具链、详细执行步骤与 C1–C9 检查目录下沉到 01；凡检查这些**运行时/
    检查细节**的断言都必须读组合文本，否则下沉一次就把契约测试退化成入口体积测试。
    **H0 安全门断言仍只读入口** `SKILL.md`（入口必须直接保留最小铁律），见 `H0SingleSourceTest`。
    """
    entry = skill_path(DATACHECK_ENTRY).read_text(encoding="utf-8")
    reference = skill_path(DATACHECK_REFERENCE).read_text(encoding="utf-8")
    return entry + "\n" + reference


def _source_repo_root(start: Path) -> Path:
    """源仓根：向上找带 `go.mod` + `Makefile` 的那一层（安装副本里找不到就回落一层）。"""
    for candidate in (start, *start.parents):
        if (candidate / "go.mod").is_file() and (candidate / "Makefile").is_file():
            return candidate
    return start.parent


REPO_ROOT = _source_repo_root(Path(__file__).resolve())
SCRIPTS_DIR = Path(__file__).resolve().parent
CHECKER = SCRIPTS_DIR / "check_audit_skill_mappings.py"
MAINTAINER_SKILL = SCRIPTS_DIR.parent

COMPLETE_TREE = """
- 📁 01-业务路线/
  - 📁 01-资产经营/
    - 📁 租赁与租金评估/
      - 📄 01-业务通用审核要点
- 📁 02-资产类型/
  - 📁 01-房地产/
    - 📁 01-共性参考/
      - 📄 02-评估审核条目
    - 📁 02-细分对象/
      - 📁 01-土地使用权/
        - 📄 评估审核条目
""".strip()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")


def _registry(asset_skill: str, business_skill: str) -> str:
    return f"""
    # 多轴技能注册表

    | axis | label | skill | status | load behavior |
    | --- | --- | --- | --- | --- |
    | asset | 房地产 | {asset_skill} | available | load |
    | business | 资产经营 | {business_skill} | available | load |
    """


def _create_leaf(
    repo: Path,
    name: str,
    root: str,
    *,
    subobjects: tuple[str, ...] = (),
    doc_name: str = "评估审核条目",
    container: str = "02-细分对象",
) -> None:
    """最小叶子。`subobjects` 给定时，按二级目录一致性门禁的要求在三个文件里各自索引。"""
    leaf = repo / "skills" / name
    _write(
        leaf / "SKILL.md",
        f"""
        ---
        name: {name}
        description: Use when the matching crwu-audit axis label is selected.
        ---

        # {name}
        """,
    )
    rows, folders, reviews = [], [], []
    for child in subobjects:
        child_root = f"{root}{container}/{child}/" if container else f"{root}{child}/"
        label = re.sub(r"^\d+[-_、.．]\s*", "", child)
        relative = f"{container}/{child}/" if container else f"{child}/"
        rows.append(f"| {label} | `{relative}` | 夹具提示信号 | `{doc_name}` |")
        # 装配维度用**相对**目录（不带一级容器前缀）：既满足二级索引，又不会给
        # `inspect_path_keys` 增加一条小夹具 catalog 里没有的完整路径键。
        folders.append(f"| {label} | `{relative}{doc_name}` |")
        reviews.append(f"### {label}\n\n- 路径：`{relative}{doc_name}`")
    _write(
        leaf / "references" / "00-applicability.md",
        "# Applicability\n" + ("\n| 二级标签 | 相对目录 | 提示信号 | 要点文件 |\n| --- | --- | --- | --- |\n" + "\n".join(rows) + "\n" if rows else ""),
    )
    _write(
        leaf / "references" / "01-kb-assembly.md",
        f"""
        # KB assembly

        | source_key | owner_axis | canonical_label | kb_root | request_kind | recursive | required |
        | --- | --- | --- | --- | --- | --- | --- |
        | ROOT | test | test | `{root}` | directory | true | true |

        | 二级选择 | 相对路径 |
        | --- | --- |
        {chr(10).join(folders)}
        """,
    )
    _write(
        leaf / "references" / "02-review-focus.md",
        "# Review focus\n" + ("\n" + "\n".join(reviews) + "\n" if reviews else ""),
    )


ROUTER_REFERENCES = (
    "00-input-and-route-profile.md",
    "02-scope-classification.md",
    "03-asset-classification.md",
    "04-business-classification.md",
    "05-method-classification.md",
    "06-overlay-classification.md",
    "07-skill-registry.md",
    "08-union-dispatch-rules.md",
    "10-capability-gap-proposal.md",
    "99-maintenance.md",
)


def _create_router(repo: Path) -> None:
    """Minimal router layer, so routing-consistency checks have something to compare."""
    refs = repo / "skills" / "crwu-audit" / "references"
    _write(
        repo / "skills" / "crwu-audit" / "SKILL.md",
        """
        # 总路由

        按 `00-input-and-route-profile.md` 画像，经 `08-union-dispatch-rules.md` 稳定并集加载。
        """,
    )
    for name in ROUTER_REFERENCES:
        target = refs / name
        if target.is_file():
            continue
        _write(target, "# reference\n")
    _write(
        refs / "08-union-dispatch-rules.md",
        """
        # 稳定并集

        skills_to_load = stable_unique(scope_skills, asset_skills, business_skills, method_skills, overlay_skills, public_skills)
        """,
    )


def _declare_download_channel(repo: Path) -> None:
    """夹具声明原生文本下载通道（`drive +download`），否则会被 EXPORT_CHANNEL_UNDECLARED 拦住。"""
    _write(
        repo / "skills" / "crwu-dws" / "SKILL.md",
        "---\nname: crwu-dws\ndescription: fixture\n---\n\n原生文本走 `drive +download`。\n",
    )


def _create_valid_repo(repo: Path) -> None:
    _write(
        repo / "skills" / "crwu-audit" / "references" / "07-skill-registry.md",
        _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
    )
    _write(
        repo / "skills" / "crwu-audit" / "references" / "03-asset-classification.md",
        "| canonical 资产类型 | 主要信号 | 目标技能 |\n| --- | --- | --- |\n| 房地产 | 房建类 | `crwu-audit-asset-realestate` |\n",
    )
    _write(
        repo / "skills" / "crwu-audit" / "references" / "04-business-classification.md",
        "| 一级业务 | 子业务 | 目标技能 |\n| --- | --- | --- |\n| 资产经营 | 租赁与租金评估 | `crwu-audit-biz-asset-operation` |\n",
    )
    _create_router(repo)
    _create_leaf(
        repo,
        "crwu-audit-asset-realestate",
        "02-资产类型/01-房地产/",
        subobjects=("01-土地使用权",),
    )
    _create_leaf(
        repo,
        "crwu-audit-biz-asset-operation",
        "01-业务路线/01-资产经营/",
        subobjects=("租赁与租金评估",),
        doc_name="01-业务通用审核要点",
        container="",
    )



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


# F-015：frontmatter description 的形态级契约。不引入 PyYAML —— 本仓只用两种写法
# （单行标量与 `>-` folded），下面按 YAML 语义自行归一。
_DESCRIPTION_KEY_RE = re.compile(r"^description:\s*(.*)$")
_FOLDED_MARKERS = (">-", ">", "|-", "|")


def _frontmatter_lines(skill_md: Path):
    """返回 SKILL.md frontmatter 的行列表；没有 frontmatter 时返回 None。"""
    lines = skill_md.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return lines[1:index]
    return None


def _normalized_description(frontmatter_lines):
    """取 description 并按 YAML 语义归一：单行标量去首尾空白，`>-` folded 折成空格。

    folded scalar 的语义是「段落内换行折成空格、空行保留为段落分隔」；description 只有一个
    逻辑段落，所以最终再折平一次，与 YAML 读取结果一致。`|` block scalar 按换行保留 —— 本仓
    description 不使用它，真出现时应显式暴露而不是被静默折平。
    """
    for index, line in enumerate(frontmatter_lines):
        match = _DESCRIPTION_KEY_RE.match(line)
        if not match:
            continue
        head = match.group(1).strip()
        if head not in _FOLDED_MARKERS:
            return head
        body = []
        for candidate in frontmatter_lines[index + 1:]:
            if candidate.strip() and not candidate[:1].isspace():
                break  # 下一个顶层键
            body.append(candidate)
        if head.startswith(">"):
            chunks, buffer = [], []
            for candidate in body:
                text = candidate.strip()
                if text:
                    buffer.append(text)
                else:
                    chunks.append(" ".join(buffer))
                    buffer = []
            if buffer:
                chunks.append(" ".join(buffer))
            return re.sub(r"\s+", " ", " ".join(chunk for chunk in chunks if chunk)).strip()
        return "\n".join(candidate.strip() for candidate in body).strip()
    return None


class AuditSkillMaintainerCheckerTest(unittest.TestCase):
    def run_checker(
        self,
        repo: Path,
        catalog: Path,
        *extra: str,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(CHECKER),
                "--repo-root",
                str(repo),
                "--catalog",
                str(catalog),
                "--format",
                "json",
                *extra,
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_markdown_tree_proposes_only_missing_first_level_skills(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(COMPLETE_TREE, encoding="utf-8")

            result = self.run_checker(repo, tree)

            self.assertEqual(0, result.returncode, result.stderr)
            report = json.loads(result.stdout)
            create_proposals = {
                (item["axis"], item["label"])
                for item in report["proposals"]
                if item["action"] == "create_skill"
            }
            self.assertEqual(
                {("asset", "房地产"), ("business", "资产经营")},
                create_proposals,
            )
            proposed_labels = {item["label"] for item in report["proposals"]}
            self.assertNotIn("土地使用权", proposed_labels)
            self.assertNotIn("租赁与租金评估", proposed_labels)
            self.assertTrue(
                all(item["name_review_required"] for item in report["proposals"]),
                report["proposals"],
            )

    def test_valid_parent_skills_and_directory_roots_are_clean(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(COMPLETE_TREE, encoding="utf-8")
            _create_valid_repo(repo)

            result = self.run_checker(repo, tree, "--strict")

            self.assertEqual(0, result.returncode, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual([], report["findings"])
            self.assertEqual([], report["proposals"])

    def test_prototype_income_module_is_tracked_without_runtime_assembly(self):
        tree_with_prototype = """
        - 📁 06-规则库/
          - 📁 M-收益法/
            - 📄 04-模块-收益法
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(textwrap.dedent(tree_with_prototype).strip(), encoding="utf-8")
            _create_valid_repo(repo)

            report = json.loads(self.run_checker(repo, tree, "--strict").stdout)
            tracked = report["calibration"]["method_layer_assembly"]["nonRuntime"]

            self.assertEqual([], report["findings"])
            self.assertEqual(1, len(tracked))
            self.assertEqual("06-规则库/M-收益法/", tracked[0]["prefix"])
            self.assertEqual("prototype/non-runtime", tracked[0]["classification"])
            self.assertFalse(tracked[0]["runtimeAssembled"])
            self.assertIn("正式", tracked[0]["enableWhen"])

            text_result = subprocess.run(
                [
                    sys.executable,
                    str(CHECKER),
                    "--repo-root",
                    str(repo),
                    "--catalog",
                    str(tree),
                    "--format",
                    "text",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, text_result.returncode, text_result.stderr)
            self.assertIn("原型/非运行时模块：1", text_result.stdout)
            self.assertIn("06-规则库/M-收益法/", text_result.stdout)
            self.assertIn("prototype/non-runtime", text_result.stdout)
            self.assertIn("规则依据含待编占位", text_result.stdout)

            calibration = root / "map.md"
            emitted = self.run_checker(repo, tree, "--emit-map", str(calibration))
            self.assertEqual(0, emitted.returncode, emitted.stderr)
            calibration_text = calibration.read_text(encoding="utf-8")
            self.assertIn("## 原型 / 非运行时模块", calibration_text)
            self.assertIn("06-规则库/M-收益法/", calibration_text)

    def test_prototype_income_module_runtime_assembly_is_an_error(self):
        tree_with_prototype = """
        - 📁 06-规则库/
          - 📁 M-收益法/
            - 📄 04-模块-收益法
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(textwrap.dedent(tree_with_prototype).strip(), encoding="utf-8")
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/08-union-dispatch-rules.md",
                """
                # 稳定并集

                skills_to_load = stable_unique(scope_skills, asset_skills, business_skills, method_skills, overlay_skills, public_skills)

                | axis | label | path |
                | --- | --- | --- |
                | method | 收益法 | `06-规则库/M-收益法/` |
                """,
            )

            result = self.run_checker(repo, tree, "--strict")
            report = json.loads(result.stdout)

            self.assertEqual(1, result.returncode)
            findings = _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED")
            self.assertEqual(1, len(findings))
            self.assertEqual("06-规则库/M-收益法/", findings[0]["path"])
            tracked = report["calibration"]["method_layer_assembly"]["nonRuntime"]
            self.assertTrue(tracked[0]["runtimeAssembled"])

    def test_prototype_legal_compliance_module_is_tracked_without_runtime_assembly(self):
        tree_with_prototype = """
        - 📁 06-规则库/
          - 📁 M-法律法规合规/
            - 📄 02-模块-法律法规合规
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(textwrap.dedent(tree_with_prototype).strip(), encoding="utf-8")
            _create_valid_repo(repo)

            report = json.loads(self.run_checker(repo, tree, "--strict").stdout)
            tracked = report["calibration"]["method_layer_assembly"]["nonRuntime"]

            self.assertEqual([], report["findings"])
            self.assertEqual(1, len(tracked))
            self.assertEqual("06-规则库/M-法律法规合规/", tracked[0]["prefix"])
            self.assertEqual("prototype/non-runtime", tracked[0]["classification"])
            self.assertFalse(tracked[0]["runtimeAssembled"])
            self.assertIn("A 级规则", tracked[0]["reason"])
            self.assertIn("正式", tracked[0]["enableWhen"])

    def test_distinguishes_naming_mapping_and_knowledge_content_gaps(self):
        incomplete_tree = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📁 租赁与租金评估/
        - 📁 02-资产类型/
          - 📁 01-房地产/
            - 📁 02-细分对象/
              - 📁 01-土地使用权/
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(textwrap.dedent(incomplete_tree).strip(), encoding="utf-8")
            _write(
                repo / "skills" / "crwu-audit" / "references" / "07-skill-registry.md",
                _registry(
                    "crwu-audit-asset-realestate",
                    "crwu-audit-business-asset-operation",
                ),
            )
            asset = repo / "skills" / "crwu-audit-asset-realestate"
            _write(asset / "SKILL.md", "---\nname: crwu-audit-asset-realestate\ndescription: Use when selected.\n---\n")
            _write(asset / "references" / "00-applicability.md", "# A\n")
            _write(asset / "references" / "02-review-focus.md", "# R\n")
            _write(
                asset / "references" / "01-kb-assembly.md",
                "| source_key | kb_root | request_kind | recursive |\n| --- | --- | --- | --- |\n| OLD | `02-资产类型/01-房地产/01-共性参考/02-评估审核条目` | file | false |\n",
            )
            _create_leaf(
                repo,
                "crwu-audit-business-asset-operation",
                "01-业务路线/01-资产经营/",
            )

            result = self.run_checker(repo, tree)

            self.assertEqual(0, result.returncode, result.stderr)
            codes = {item["code"] for item in json.loads(result.stdout)["findings"]}
            self.assertTrue(
                {
                    "LEGACY_BUSINESS_PREFIX",
                    "ASSEMBLY_FIRST_LEVEL_ROOT_MISSING",
                    "ASSEMBLY_FILE_MAPPING",
                    "ASSET_COMMON_REFERENCE_MISSING",
                    "ASSET_SUBOBJECT_REVIEW_MISSING",
                    "BUSINESS_SUBROUTE_REVIEW_MISSING",
                }.issubset(codes),
                codes,
            )

    def test_snapshot_and_node_index_normalize_to_same_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            _create_valid_repo(repo)
            snapshot = root / "snapshot.json"
            node_index = root / "node-index.json"
            snapshot.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-catalog.snapshot.v1",
                        "generated_at": "2026-09-10T10:59:30+08:00",
                        "stats": {"complete": True},
                        "nodes": [
                            {
                                "nodeId": "business",
                                "name": "01-业务路线",
                                "type": "folder",
                                "children": [
                                    {
                                        "nodeId": "biz-parent",
                                        "name": "01-资产经营",
                                        "type": "folder",
                                        "children": [
                                            {
                                                "nodeId": "biz-child",
                                                "name": "租赁与租金评估",
                                                "type": "folder",
                                                "children": [
                                                    {
                                                        "nodeId": "biz-review",
                                                        "name": "01-业务通用审核要点",
                                                        "type": "adoc",
                                                        "children": [],
                                                    }
                                                ],
                                            }
                                        ],
                                    }
                                ],
                            },
                            {
                                "nodeId": "asset",
                                "name": "02-资产类型",
                                "type": "folder",
                                "children": [
                                    {
                                        "nodeId": "asset-parent",
                                        "name": "01-房地产",
                                        "type": "folder",
                                        "children": [
                                            {
                                                "nodeId": "common",
                                                "name": "01-共性参考",
                                                "type": "folder",
                                                "children": [
                                                    {
                                                        "nodeId": "common-review",
                                                        "name": "02-评估审核条目",
                                                        "type": "adoc",
                                                        "children": [],
                                                    }
                                                ],
                                            },
                                            {
                                                "nodeId": "subobjects",
                                                "name": "02-细分对象",
                                                "type": "folder",
                                                "children": [
                                                    {
                                                        "nodeId": "land",
                                                        "name": "01-土地使用权",
                                                        "type": "folder",
                                                        "children": [
                                                            {
                                                                "nodeId": "land-review",
                                                                "name": "评估审核条目",
                                                                "type": "adoc",
                                                                "children": [],
                                                            }
                                                        ],
                                                    }
                                                ],
                                            },
                                        ],
                                    }
                                ],
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            by_path = {
                "01-业务路线/": ["business"],
                "01-业务路线/01-资产经营/": ["biz-parent"],
                "01-业务路线/01-资产经营/租赁与租金评估/": ["biz-child"],
                "01-业务路线/01-资产经营/租赁与租金评估/01-业务通用审核要点": ["biz-review"],
                "02-资产类型/": ["asset"],
                "02-资产类型/01-房地产/": ["asset-parent"],
                "02-资产类型/01-房地产/01-共性参考/": ["common"],
                "02-资产类型/01-房地产/01-共性参考/02-评估审核条目": ["common-review"],
                "02-资产类型/01-房地产/02-细分对象/": ["subobjects"],
                "02-资产类型/01-房地产/02-细分对象/01-土地使用权/": ["land"],
                "02-资产类型/01-房地产/02-细分对象/01-土地使用权/评估审核条目": ["land-review"],
            }
            node_index.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-dir-cache.nodeindex.v1",
                        "built_from_snapshot_at": "2026-09-10T10:59:30+08:00",
                        "by_path": by_path,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            snapshot_result = self.run_checker(repo, snapshot)
            index_result = self.run_checker(repo, node_index)

            self.assertEqual(0, snapshot_result.returncode, snapshot_result.stderr)
            self.assertEqual(0, index_result.returncode, index_result.stderr)
            snapshot_report = json.loads(snapshot_result.stdout)
            index_report = json.loads(index_result.stdout)
            self.assertEqual(
                snapshot_report["catalog"]["paths"],
                index_report["catalog"]["paths"],
            )

    def test_strict_mode_exits_nonzero_when_errors_exist(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(COMPLETE_TREE, encoding="utf-8")

            result = self.run_checker(repo, tree, "--strict")

            self.assertEqual(1, result.returncode)
            report = json.loads(result.stdout)
            self.assertGreater(report["summary"]["errors"], 0)

    def test_pending_legacy_registry_name_is_replaced_by_biz_proposal(self):
        business_tree = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(textwrap.dedent(business_tree).strip(), encoding="utf-8")
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                """
                | axis | label | skill | status | load behavior |
                | --- | --- | --- | --- | --- |
                | business | 资产经营 | crwu-audit-business-rent | pending | record gap |
                """,
            )

            result = self.run_checker(repo, tree)

            self.assertEqual(0, result.returncode, result.stderr)
            report = json.loads(result.stdout)
            self.assertIn(
                "LEGACY_BUSINESS_PREFIX",
                {item["code"] for item in report["findings"]},
            )
            proposal = next(
                item
                for item in report["proposals"]
                if item["axis"] == "business" and item["label"] == "资产经营"
            )
            self.assertEqual("crwu-audit-biz-asset-operation", proposal["skill_name"])
            self.assertTrue(proposal["name_review_required"])

    def test_markdown_tree_preserves_declared_capture_time(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = root / "tree.md"
            tree.write_text(
                "# 目录树\n- 抓取时间：2026-09-10T10:59:30+08:00\n" + COMPLETE_TREE,
                encoding="utf-8",
            )

            result = self.run_checker(repo, tree)

            self.assertEqual(0, result.returncode, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(
                "2026-09-10T10:59:30+08:00",
                report["catalog"]["generated_at"],
            )

    def _kb_tool(self):
        module_path = SCRIPTS_DIR / "kb_tool.py"
        spec = importlib.util.spec_from_file_location("kb_tool_for_selfcontainment", module_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_repo_reference_lint_flags_repo_directories_in_skill_content(self):
        """技能正文不得引用代码仓库目录：技能以副本安装时这些路径不存在。"""
        cases = [
            ("docs", "参考 `docs/design-crwu-dws.md` 的设计口径。"),
            ("tools", "运行 `tools/kb/kb_tool.py validate`。"),
            ("bin", "用 `./bin/darwin/crwu` 登录。"),
            ("docs", "见 `../docs/x.md`。"),
            ("cmd", "源码在 `cmd/crwu` 下。"),
            ("internal", "实现见 `internal/platform`。"),
            ("Makefile", "构建走 `Makefile`。"),
            ("skills/<skill>/", "调用 `skills/crwu-dws/scripts/x.py`。"),
        ]
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            for index, (_label, body) in enumerate(cases):
                skill = root / f"crwu-demo-{index}"
                _write(skill / "SKILL.md", f"---\nname: crwu-demo-{index}\n---\n\n{body}\n")

            errors, _warnings = module.repo_reference_lint(str(root))

            self.assertEqual(len(cases), len(errors), errors)
            for label, _body in cases:
                self.assertTrue(
                    any(label in error for error in errors),
                    f"{label} 未被 lint 拦下：{errors}",
                )

    def test_repo_reference_lint_ignores_system_paths_and_urls(self):
        """shebang 的 /usr/bin/env 与外部文档 URL 不是仓库目录，不得误报。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            skill = root / "crwu-demo"
            _write(
                skill / "SKILL.md",
                "---\nname: crwu-demo\n---\n\n# demo\n"
                "外部文档：https://www.example.com/docs/cli/skills\n",
            )
            _write(skill / "scripts" / "tool.py", '#!/usr/bin/env python3\nprint("ok")\n')

            errors, _warnings = module.repo_reference_lint(str(root))

            self.assertEqual([], errors)

    def test_repo_reference_lint_flags_links_escaping_the_skill_directory(self):
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            _write(
                root / "crwu-demo/SKILL.md",
                "---\nname: crwu-demo\n---\n\n见 [手册](../../docs/cli-manual.md)。\n",
            )

            errors, _warnings = module.repo_reference_lint(str(root))

            self.assertEqual(1, len(errors), errors)
            self.assertIn("逃出技能目录", errors[0])

    def test_repo_reference_lint_exempts_declared_source_repo_tests(self):
        """声明为源仓契约测试/源仓维护工具的脚本可定位源仓（运行时不需要它们）。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            skill = root / "crwu-demo"
            _write(skill / "SKILL.md", "---\nname: crwu-demo\n---\n\n# demo\n")
            _write(
                skill / "scripts" / "test_contract.py",
                '"""源仓契约测试：只在源仓维护时运行。"""\n'
                'REPO_ROOT = 1\n'
                'DOC = "docs/design-x.md"\n',
            )
            _write(skill / "scripts" / "tool.py", '"""源仓维护工具。"""\nDOC = "docs/x.md"\n')

            errors, _warnings = module.repo_reference_lint(str(root))

            self.assertEqual([], errors)

    def test_repo_reference_lint_skips_skill_root_documents(self):
        """skills 根的 AGENTS.md / README.md 是源仓文档，不是技能。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            _write(root / "README.md", "见 `docs/design-x.md`。\n")
            _write(root / "AGENTS.md", "见 `skills/crwu-demo/SKILL.md`。\n")
            _write(root / "crwu-demo/SKILL.md", "---\nname: crwu-demo\n---\n\n# demo\n")

            errors, _warnings = module.repo_reference_lint(str(root))

            self.assertEqual([], errors)

    # ------------------------------------------------------------------
    # CRWU-SKILL-OPT-001：逃逸链接必须按**规范化后的相对路径**判定，
    # 不能按「`../` 出现次数」判定（旧实现 `\]\((?:\.\./){2,}` 两头都会错）。
    # ------------------------------------------------------------------

    def test_escape_lint_flags_single_level_escape_from_skill_md(self):
        """SKILL.md 里**单层** `../other-skill/file.md` 就逃出了技能目录。

        旧实现只认两个及以上 `../`，因此这一条被漏检 —— 正是 22 处
        `../crwu-audit/references/12-leaf-common-contract.md` 全部报绿灯的原因。
        """
        module = self._kb_tool()
        self.assertTrue(hasattr(module, "escaping_links"), "kb_tool 必须提供按路径规范化判定的逃逸链接检测")
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "skills" / "crwu-demo"
            doc = skill / "SKILL.md"
            doc.parent.mkdir(parents=True, exist_ok=True)
            doc.write_text("---\nname: crwu-demo\n---\n\n见 [x](../other-skill/file.md)。\n", encoding="utf-8")
            self.assertEqual(1, len(module.escaping_links(str(doc), str(skill))))

    def test_escape_lint_allows_parent_link_that_stays_inside_the_skill(self):
        """`references/01.md` → `../SKILL.md` 仍在技能目录内，是合法链接。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "skills" / "crwu-demo"
            doc = skill / "references" / "01-kb-assembly.md"
            doc.parent.mkdir(parents=True, exist_ok=True)
            doc.write_text("见 [根文档](../SKILL.md)。\n", encoding="utf-8")
            self.assertEqual([], module.escaping_links(str(doc), str(skill)))

    def test_escape_lint_allows_deep_parent_link_that_still_resolves_inside(self):
        """`references/sub/deep.md` → `../../SKILL.md` 仍在本 Skill 内。

        旧实现按 `../` 次数判定，这里会**误报**：层级够深但并未逃逸。
        """
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "skills" / "crwu-demo"
            (skill / "references" / "sub").mkdir(parents=True)
            doc = skill / "references" / "sub" / "deep.md"
            doc.write_text("见 [根](../../SKILL.md)。\n", encoding="utf-8")
            self.assertEqual([], module.escaping_links(str(doc), str(skill)))

    def test_escape_lint_flags_real_escape_from_nested_reference(self):
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "skills" / "crwu-demo"
            (skill / "references" / "sub").mkdir(parents=True)
            doc = skill / "references" / "sub" / "deep.md"
            doc.write_text("见 [越界](../../../other-skill/file.md)。\n", encoding="utf-8")
            self.assertEqual(1, len(module.escaping_links(str(doc), str(skill))))

    def test_escape_lint_parses_angle_brackets_fragments_and_ignores_external_uris(self):
        """angle-bracket 目标与 fragment 必须解析；外部 URI/锚点不算本地链接。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "skills" / "crwu-demo"
            doc = skill / "SKILL.md"
            doc.parent.mkdir(parents=True, exist_ok=True)
            doc.write_text(
                "---\nname: crwu-demo\n---\n\n"
                "本 Skill 内：[共同约束](<references/03-common-contract.md#7>)、[锚点](#section)\n"
                "外部：[手册](https://example.com/docs/x.md)、[邮件](mailto:a@b.c)\n",
                encoding="utf-8",
            )
            self.assertEqual([], module.escaping_links(str(doc), str(skill)))
            doc.write_text("---\nname: crwu-demo\n---\n\n见 [越界](<../other/a.md#x>)。\n", encoding="utf-8")
            self.assertEqual(1, len(module.escaping_links(str(doc), str(skill))))

    # ------------------------------------------------------------------
    # CRWU-SKILL-OPT-001：叶子公共契约的确定性同步与漂移门禁
    # ------------------------------------------------------------------

    def _leaf_layer_fixture(self, temp, contract_body="LEAF-COMMON-CONTRACT-BODY\n"):
        """造一个最小技能层：router（含规范源）+ 两个叶子（12 资产/8 业务之外的形状等价）。"""
        root = Path(temp) / "skills"
        _write(root / "crwu-audit" / "SKILL.md", "---\nname: crwu-audit\n---\n\n# router\n")
        contract = root / "crwu-audit" / "references" / "12-leaf-common-contract.md"
        contract.parent.mkdir(parents=True, exist_ok=True)
        contract.write_text(contract_body, encoding="utf-8")
        for leaf in ("crwu-audit-asset-alpha", "crwu-audit-biz-beta"):
            _write(root / leaf / "SKILL.md", f"---\nname: {leaf}\n---\n\n# leaf\n")
        return root

    def test_leaf_contract_check_reports_missing_copies(self):
        module = self._kb_tool()
        self.assertTrue(hasattr(module, "leaf_common_contract_report"), "kb_tool 必须提供叶子公共契约同步检查")
        with tempfile.TemporaryDirectory() as temp:
            root = self._leaf_layer_fixture(temp)
            report = module.leaf_common_contract_report(str(root))
            self.assertEqual("ok", report["status"], report)
            self.assertEqual(
                ["crwu-audit-asset-alpha", "crwu-audit-biz-beta"], sorted(report["missing"]), report
            )

    def test_leaf_contract_sync_writes_byte_exact_copies_and_is_idempotent(self):
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = self._leaf_layer_fixture(temp)
            module.sync_leaf_common_contract(str(root), write=True)
            source_bytes = (root / "crwu-audit" / "references" / "12-leaf-common-contract.md").read_bytes()
            for leaf in ("crwu-audit-asset-alpha", "crwu-audit-biz-beta"):
                target = root / leaf / "references" / "03-common-contract.md"
                self.assertTrue(target.is_file(), target)
                self.assertEqual(source_bytes, target.read_bytes(), "副本必须与规范源逐字节一致")
            clean = module.leaf_common_contract_report(str(root))
            self.assertEqual([], clean["missing"])
            self.assertEqual([], clean["drifted"])
            # 幂等：再写一次不得改变任何字节
            before = {p: p.read_bytes() for p in root.rglob("*.md")}
            module.sync_leaf_common_contract(str(root), write=True)
            after = {p: p.read_bytes() for p in root.rglob("*.md")}
            self.assertEqual(before, after, "重复 --write 必须无 diff")

    def test_leaf_contract_check_reports_drift_after_one_character_change(self):
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = self._leaf_layer_fixture(temp)
            module.sync_leaf_common_contract(str(root), write=True)
            target = root / "crwu-audit-asset-alpha" / "references" / "03-common-contract.md"
            target.write_text(target.read_text(encoding="utf-8").replace("BODY", "BODZ"), encoding="utf-8")
            report = module.leaf_common_contract_report(str(root))
            self.assertIn("crwu-audit-asset-alpha", report["drifted"], report)
            self.assertNotIn("crwu-audit-biz-beta", report["drifted"], report)

    def test_leaf_contract_check_reports_unexpected_target_set_change(self):
        """目标集合变化不得被静默漏同步：带前缀但缺 SKILL.md 的目录若残留副本，必须报出。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = self._leaf_layer_fixture(temp)
            module.sync_leaf_common_contract(str(root), write=True)
            ghost = root / "crwu-audit-asset-ghost" / "references" / "03-common-contract.md"
            ghost.parent.mkdir(parents=True, exist_ok=True)
            ghost.write_text("stale\n", encoding="utf-8")
            report = module.leaf_common_contract_report(str(root))
            self.assertTrue(report["unexpected"], "残留副本必须进入 unexpected，不得静默丢弃")

    def test_leaf_contract_check_skips_cleanly_without_router_or_leaves(self):
        """只安装了 maintainer Skill（缺 router 与叶子集合）时必须显式 skip，不得崩溃。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            _write(
                root / "crwu-dev-audit-skill-maintainer" / "SKILL.md",
                "---\nname: crwu-dev-audit-skill-maintainer\n---\n\n# maintainer\n",
            )
            report = module.leaf_common_contract_report(str(root))
            self.assertEqual("skip", report["status"], report)
            self.assertTrue(report["skip_reason"], report)

    @_requires_skill_tree
    def test_real_layer_leaf_contracts_are_present_and_synced(self):
        """真实技能层回归：每个叶子都必须持有与规范源一致的本地副本。"""
        module = self._kb_tool()
        report = module.leaf_common_contract_report(str(SKILLS_ROOT))
        self.assertEqual("ok", report["status"], report)
        self.assertEqual([], report["missing"], report)
        self.assertEqual([], report["drifted"], report)
        self.assertEqual([], report["unexpected"], report)
        discovered = module.discover_leaf_skills(str(SKILLS_ROOT))
        self.assertEqual(len(discovered), report["leaves"], report)
        self.assertGreaterEqual(len(discovered), 20, "叶子集合意外缩小，扫描规则可能失效")

    @_requires_skill_tree
    def test_real_layer_public_general_standards_has_no_escaping_links(self):
        """`crwu-audit-public-general-standards` 不是资产/业务叶子，但同样必须自包含。

        两个反例来源不同：
        - `SKILL.md:12` 的 `../crwu-audit/...` 从技能根出发 → 规范化后**逃出**技能目录；
        - `references/02-review-focus.md:107` 的同一目标从 `references/` 出发 → 规范化后落在
          `<skill>/crwu-audit/...`（技能内），按路径边界规则**不算逃逸**，但它是技能内不存在的
          坏路径，必须靠文本断言钉住，否则会以"不是逃逸"为由悄悄残留。
        """
        module = self._kb_tool()
        skill = SKILLS_ROOT / "crwu-audit-public-general-standards"
        for relative in ("SKILL.md", "references/02-review-focus.md"):
            document = skill / relative
            self.assertTrue(document.is_file(), document)
            self.assertEqual([], module.escaping_links(str(document), str(skill)), relative)
            self.assertNotIn("../crwu-audit", document.read_text(encoding="utf-8"), relative)

    @_requires_skill_tree
    def test_every_skill_is_self_contained(self):
        """真实仓库回归：每个技能都不得引用代码仓库目录。"""
        module = self._kb_tool()

        errors, _warnings = module.repo_reference_lint(str(SKILLS_ROOT))

        self.assertEqual([], errors)

    @_requires_skill_tree
    def test_maintainer_skill_passes_live_source_protocol_lint(self):
        module_path = SCRIPTS_DIR / "kb_tool.py"
        spec = importlib.util.spec_from_file_location("kb_tool_for_test", module_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        errors, _warnings = module.live_protocol_lint(str(MAINTAINER_SKILL), [])

        self.assertEqual([], errors)

    def test_audit_family_gates_cover_both_prefixes(self):
        """门禁必须同时覆盖 `crwu-audit*` 与 `crwu-dev-audit-*` 两组前缀。

        2026-09-16 先把 `optimize` / `public-general-standards` 移到 `crwu-dev-audit-`；
        2026-09-19 归组调整：`public-general-standards` 回到 `crwu-audit-`，维护器
        `crwu-dev-audit-skill-maintainer` 移入 `crwu-dev-audit-`。若门禁只认 `crwu-audit`，
        dev 前缀下的成员会**静默掉出**"三不写" lint（kb_tool）与装配路径键/frontmatter/
        真实目录解析（映射检查器）的扫描范围——正是"改名反而更难维护"的根因，故用本用例钉住。
        """
        kb_tool = self._kb_tool()
        self.assertIn("crwu-audit", kb_tool.AUDIT_DIR_PREFIXES)
        self.assertIn("crwu-dev-audit", kb_tool.AUDIT_DIR_PREFIXES)

        # 以模块方式载入检查器（dataclass 需要模块先注册进 sys.modules，Py3.9 尤其如此）
        checker_spec = importlib.util.spec_from_file_location("checker_for_prefix_test", CHECKER)
        checker = importlib.util.module_from_spec(checker_spec)
        sys.modules[checker_spec.name] = checker
        try:
            checker_spec.loader.exec_module(checker)
        finally:
            sys.modules.pop(checker_spec.name, None)
        self.assertIn("crwu-audit", tuple(checker.AUDIT_FAMILY_PREFIX))
        self.assertIn("crwu-dev-audit", tuple(checker.AUDIT_FAMILY_PREFIX))
        # 裸名 `crwu-audit`（router）由 ROUTER_SKILL 单独覆盖，token 正则只匹配具体技能名
        for name in ("crwu-audit-public-general-standards", "crwu-dev-audit-optimize",
                     "crwu-dev-audit-skill-maintainer"):
            self.assertIn(name, checker._SKILL_TOKEN_RE.findall("路由点名 `" + name + "`。"),
                          f"{name} 必须被 _SKILL_TOKEN_RE 认出（否则 R4 漏检）")

    def test_live_protocol_lint_covers_dev_prefixed_directories(self):
        """`crwu-dev-audit-*` 目录里的技能正文必须同样受"三不写"lint 约束。"""
        module = self._kb_tool()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write(root / "crwu-dev-audit-canary" / "SKILL.md",
                   '---\nname: crwu-dev-audit-canary\n---\n\nCRWU_KB_ROOT = "/tmp/kb"\n')

            errors, _warnings = module.live_protocol_lint(str(root), [])

            self.assertTrue(any("canary" in e for e in errors),
                            f"dev 前缀目录未被 lint 覆盖：{errors}")

    @_requires_skill_tree
    def test_renamed_dev_prefix_skills_are_on_disk_with_matching_names(self):
        """dev 前缀技能（维护器与优化器）目录与 frontmatter 名必须一致（防止源码/登记再次漂移）。"""
        for name in ("crwu-dev-audit-optimize", "crwu-dev-audit-skill-maintainer"):
            skill_md = SKILLS_ROOT / name / "SKILL.md"
            self.assertTrue(skill_md.is_file(), f"{name}/SKILL.md 不存在")
            front = [line for line in skill_md.read_text(encoding="utf-8").splitlines()
                     if line.startswith("name:")]
            self.assertEqual([f"name: {name}"], front, f"{name} 的 frontmatter name 与目录名不一致")

    def test_current_skill_descriptions_are_concise_trigger_conditions(self):
        """F-015：每个技能的 frontmatter description 必须是**简洁的触发条件**。

        description 是宿主用来决定"什么时候加载这个技能"的索引，不是流程正文 —— 执行流程
        由 SKILL.md 正文与 references 承担。本用例只锁**形态**（非空 / 以 `Use when` 开头 /
        长度上限），不断言任何完整句子或逐字措辞，避免脆弱文本测试。
        """
        skills = sorted(
            child for child in SKILLS_ROOT.iterdir()
            if child.is_dir() and (child / "SKILL.md").is_file()
        )
        self.assertTrue(skills, f"{SKILLS_ROOT} 下没有找到任何技能")

        problems = []
        for skill in skills:
            frontmatter = _frontmatter_lines(skill / "SKILL.md")
            if frontmatter is None:
                problems.append(f"{skill.name}: 长度 n/a — 缺少 frontmatter")
                continue
            description = _normalized_description(frontmatter)
            length = len(description) if description is not None else 0
            if not description:
                problems.append(f"{skill.name}: 长度 {length} — description 缺失或为空")
                continue
            if not description.startswith("Use when"):
                problems.append(
                    f"{skill.name}: 长度 {length} — 未以 `Use when` 开头"
                    f"（实际开头 {description[:20]!r}）")
            if length > 200:
                problems.append(
                    f"{skill.name}: 长度 {length} — 超过上限 200"
                    "（触发条件应精简，执行流程归 SKILL.md 正文与 references）")

        self.assertEqual(
            [], problems,
            "技能 description 形态不合格：\n  " + "\n  ".join(problems))


def _codes(report: dict) -> set[str]:
    return {item["code"] for item in report["findings"]}


def _findings(report: dict, code: str) -> list[dict]:
    return [item for item in report["findings"] if item["code"] == code]


# ---- 真实 crwu-dws 产物（不是探针自造的 fixture） ----
DWS_CACHE_ROOT = Path.home() / ".crwu" / "knowledge" / "dws-dir-cache"
LIVE_CATALOG_FORMS = ("目录快照.json", "node-index.json", "目录树.md")
# 权威计算表口径根（2026-09-26 入库）。
_AUTHORITATIVE_CALC_SHEET_ROOT = "06-规则库/M-计算表审核"
# 本仓在本地 dws 缓存抓取时间**之后**才新增的库内根：只有落在这些根之下的缺失键才允许跳过
# `test_real_repository_library_path_keys_exist`（声明之外的缺失键一律失败）。
_REPO_KEYS_NEWER_THAN_LOCAL_CACHE = ("06-规则库/M-计算表审核/",)
AUDIT_FAMILY_ROOTS = ("01-业务路线/", "02-资产类型/")
# `crwu-dws` declares this as its default target knowledge base; the audit skills deliberately
# never name it, so the identity binding lives here (test-side only) instead of in a skill.
AUDIT_KB_NAME = "中瑞世联评估审核知识库"


def _cache_capture_time(directory: Path) -> str:
    """`last_successful_at` from the cache identity file; empty when unreadable."""
    try:
        meta = json.loads((directory / ".cache-meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    value = meta.get("last_successful_at")
    return value if isinstance(value, str) else ""


def _cache_space_name(directory: Path) -> str:
    """`space.name` from the cache identity file; empty when unreadable."""
    try:
        meta = json.loads((directory / ".cache-meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    space = meta.get("space")
    if not isinstance(space, dict):
        return ""
    name = space.get("name")
    return name if isinstance(name, str) else ""


def _catalog_report(catalog: Path) -> dict:
    """跑 checker 并解析其 JSON 报告；**目录不可解析时显式 skip，不得崩、也不得静默通过**。

    实时缓存是外部产物（crwu-dws M1 写入 `~/.crwu`），可能因**生产侧偏离契约**而无法作为
    `--catalog` 输入（真实失效：`目录快照.json` 写成扁平 `path` 形态、schema 字面
    混成 `crwu.kb-dir-cache.snapshot.v1`）。此时本测试拿不到"库内路径键是否存在"的证据，
    按本文件纪律"内容缺失必须显式 skip"处理，并把 checker 的原始报错写进 skip 消息——
    既不当作技能漂移失败，也不假装通过。
    """
    proc = run_checker(REPO_ROOT, catalog)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        lines = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise unittest.SkipTest(
            f"实时目录缓存不可作为 --catalog 使用（{catalog.name}）："
            + (lines[-1] if lines else "checker 未产出 JSON 报告")
        )


# 缓存来源模式：显式覆盖是"调用者要求验证的精确对象"，自动发现才允许"过期候选续查"。
CACHE_MODE_AUTO = "automatic"
CACHE_MODE_DIR = "explicit-cache-dir"
CACHE_MODE_SNAPSHOT = "explicit-snapshot"


class CacheCandidate(NamedTuple):
    """一个缓存候选：`path` 是目录（auto/dir）或**调用者传入的精确文件**（snapshot）。"""

    path: Path
    source: str
    catalog: Path | None  # 交给 checker `--catalog` 的文件；定位不到时为 None


def _cache_candidate(path: Path, source: str) -> CacheCandidate:
    if source == CACHE_MODE_SNAPSHOT:
        catalog = path if path.is_file() else None
    else:
        catalog = next(
            (path / name for name in LIVE_CATALOG_FORMS if (path / name).is_file()), None
        )
    return CacheCandidate(path=path, source=source, catalog=catalog)


# `~/.crwu` 下带 `.bak-<时间>` 的目录是**回滚用的历史备份**，不是活缓存。自动发现把它们排除
# （显式覆盖不受影响 —— 调用者若指定备份，就按"要验证的精确对象"严格判）。排除动作必须**可见**，
# 由 `_excluded_backup_dirs()` 报告进 skip 消息，不静默。
# 备份命名边界：`<知识库名>.bak-<时间戳>`。**不是**"名字里含 .bak"——
# `….bakery` / `….bak` 都是普通名字，`别的知识库.bak-…` 也不是**本**知识库的备份（2026-09-26 · R4 收紧）。
CACHE_BACKUP_MARK = ".bak-"


def _cache_backup_prefix() -> str:
    return AUDIT_KB_NAME + CACHE_BACKUP_MARK


def _is_backup_cache_dir(entry: Path) -> bool:
    prefix = _cache_backup_prefix()
    return entry.name.startswith(prefix) and len(entry.name) > len(prefix)


def _excluded_backup_dirs() -> list[str]:
    """自动发现排除掉的备份目录（只读目录名，不解析内容）。"""
    if not DWS_CACHE_ROOT.is_dir():
        return []
    return sorted(
        entry.name
        for entry in DWS_CACHE_ROOT.iterdir()
        if entry.is_dir() and _is_backup_cache_dir(entry)
    )


def _cache_candidates() -> tuple[str, list[CacheCandidate]]:
    """缓存候选**按来源模式**返回（不再返回无法辨别来源的 `list[Path]`）。

    - `CRWU_DWS_CACHE_DIR`：显式**目录**，只此一个候选（**不**降级到自动发现）；
    - `CRWU_DWS_SNAPSHOT`：显式**文件**，必须使用**传入的那个文件**
      （旧实现取它的 parent 再固定读 `目录快照.json`，等于偷偷换文件）；
    - 否则自动发现：`~/.crwu/knowledge/dws-dir-cache` 下 `space.name` 匹配的目录，按抓取时间新→旧。
      空间匹配但没有任何可解析产物的目录也会作为候选返回（`catalog=None`），以便在最终消息里可复核。
    """
    override_dir = os.environ.get("CRWU_DWS_CACHE_DIR")
    if override_dir:
        return CACHE_MODE_DIR, [_cache_candidate(Path(override_dir).expanduser(), CACHE_MODE_DIR)]
    override_file = os.environ.get("CRWU_DWS_SNAPSHOT")
    if override_file:
        return CACHE_MODE_SNAPSHOT, [
            _cache_candidate(Path(override_file).expanduser(), CACHE_MODE_SNAPSHOT)
        ]
    if not DWS_CACHE_ROOT.is_dir():
        return CACHE_MODE_AUTO, []
    dirs = [
        entry
        for entry in DWS_CACHE_ROOT.iterdir()
        if entry.is_dir()
        and not _is_backup_cache_dir(entry)
        and _cache_space_name(entry) == AUDIT_KB_NAME
    ]
    dirs.sort(key=_cache_capture_time, reverse=True)
    return CACHE_MODE_AUTO, [_cache_candidate(entry, CACHE_MODE_AUTO) for entry in dirs]


def _cache_directories() -> list[Path]:
    """"同目录多产物一致性"所需的目录视图：snapshot 模式取它的 parent（允许找 sibling 产物）。"""
    _mode, candidates = _cache_candidates()
    dirs: list[Path] = []
    for candidate in candidates:
        directory = (
            candidate.path.parent if candidate.source == CACHE_MODE_SNAPSHOT else candidate.path
        )
        if directory not in dirs:
            dirs.append(directory)
    return dirs


def _try_catalog_report(catalog: Path, repo: Path) -> tuple[dict | None, str]:
    """解析失败的**非抛出**版本：自动模式要能记录并继续下一个候选。"""
    proc = run_checker(repo, catalog)
    try:
        return json.loads(proc.stdout), ""
    except json.JSONDecodeError:
        lines = (proc.stderr or proc.stdout or "").strip().splitlines()
        return None, (lines[-1] if lines else "checker 未产出 JSON 报告")


def evaluate_library_path_keys(
    candidates: list[CacheCandidate],
    mode: str,
    *,
    repo: Path = REPO_ROOT,
    allowed_roots: tuple[str, ...] = _REPO_KEYS_NEWER_THAN_LOCAL_CACHE,
    notes: list[str] | None = None,
) -> dict:
    """逐个评估候选，返回 `{"status": "ok"|"stale"|"fail", "message", "checked"}`。

    自动模式（"选最新可用缓存"，不是审计全部历史缓存）：按抓取时间新→旧逐个评估；过期只**记录**并
    继续；**命中第一个完整有效候选即 ok 并立即停止** —— 更老的历史缓存不再参与本次判定，它们的漂移
    也不得反过来污染已选中的新鲜缓存；全部用尽且都只是允许的过期缺口才 `stale`（由调用方聚合**一次** skip）。
    显式模式：不存在/不可解析/知识库不匹配/缺键/真实漂移一律 `fail`（**不得**以缓存过期为由 skip，
    也**不得**降级到自动发现）。
    **在成功选中完整有效候选之前**，被**实际评估**过的每个候选上的"声明之外缺失键"或"地址键写法
    漂移"都直接 `fail`（措辞修正：不是"任何候选"，成功之后的更老候选不参与判定）。
    """
    explicit = mode != CACHE_MODE_AUTO
    suffix = ("；" + "；".join(notes)) if notes else ""
    checked: list[str] = []
    stale: list[tuple[str, list[str]]] = []
    unusable: list[str] = []

    for candidate in candidates:
        label = str(candidate.path)
        if candidate.catalog is None:
            unusable.append(f"{label}（无可用目录产物：{'/'.join(LIVE_CATALOG_FORMS)}）")
            continue
        report, error = _try_catalog_report(candidate.catalog, repo)
        if report is None:
            unusable.append(f"{label}（不可解析：{error}）")
            continue
        paths = tuple(report["catalog"]["paths"])
        if not _is_audit_family_catalog(paths):
            unusable.append(f"{label}（不是审核族知识库）")
            continue
        checked.append(label)

        syntax = sorted(
            {
                item["code"]
                for item in report["findings"]
                if item["code"]
                in ("KB_PATH_KEY_HAS_EXPORT_SUFFIX", "KB_PATH_KEY_FOLDER_NEEDS_SLASH")
            }
        )
        if syntax:
            return {
                "status": "fail",
                "message": f"{label} 出现地址键写法漂移（与缓存新旧无关）：{syntax}",
                "checked": checked,
            }
        missing = sorted(
            {
                str(item.get("path") or "")
                for item in report["findings"]
                if item["code"] == "KB_PATH_KEY_NOT_IN_CATALOG"
            }
        )
        drift = [key for key in missing if not any(key.startswith(root) for root in allowed_roots)]
        if drift:
            return {
                "status": "fail",
                "message": f"{label} 有声明之外的地址键解析不到（缓存过期不能解释）：{drift}",
                "checked": checked,
            }
        if not missing:
            return {"status": "ok", "message": f"{label} 的全部地址键均成立", "checked": checked}
        stale.append((label, missing))

    summary = "；".join(f"{label} 缺 {keys}" for label, keys in stale)
    if stale and explicit:
        return {
            "status": "fail",
            "message": f"显式缓存覆盖缺少地址键、不得以过期为由跳过：{summary}",
            "checked": checked,
        }
    if stale:
        return {
            "status": "stale",
            "message": (
                f"自动发现的 {len(stale)} 个候选都只是允许的过期缺口（{summary}）；"
                f"已逐个检查 {len(checked)} 个候选"
                + (f"；另有不可用候选：{'，'.join(unusable)}" if unusable else "")
                + suffix
            ),
            "checked": checked,
        }
    return {
        "status": "fail" if explicit else "stale",
        "message": (
            f"没有可用候选（已检查 {len(checked)} 个）："
            + ("，".join(unusable) if unusable else "目录下没有匹配本知识库的缓存")
            + suffix
        ),
        "checked": checked,
    }


def _is_audit_family_catalog(paths: tuple[str, ...]) -> bool:
    """True when the parsed catalog actually carries the audit family's first-level roots."""
    return all(any(path.startswith(root) for path in paths) for root in AUDIT_FAMILY_ROOTS)


def run_checker(repo: Path, catalog: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(CHECKER),
            "--repo-root",
            str(repo),
            "--catalog",
            str(catalog),
            "--format",
            "json",
            *extra,
        ],
        text=True,
        capture_output=True,
        check=False,
    )


class AuditSkillMaintainerFindingCoverageTest(unittest.TestCase):
    """One fixture per detection the maintainer contract requires."""

    def _tree(self, root: Path, text: str = COMPLETE_TREE) -> Path:
        tree = root / "tree.md"
        tree.write_text(textwrap.dedent(text).strip(), encoding="utf-8")
        return tree

    def test_available_registry_skill_directory_missing_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                {"crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"},
                {item["skill"] for item in _findings(report, "AVAILABLE_SKILL_DIRECTORY_MISSING")},
            )

    def test_registry_row_absent_from_catalog_is_still_validated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                """
                | axis | label | skill | status | load behavior |
                | --- | --- | --- | --- | --- |
                | asset | 房地产 | crwu-audit-asset-realestate | available | load |
                | asset | 机器设备 | crwu-audit-asset-equipment | available | load |
                | business | 资产经营 | crwu-audit-biz-asset-operation | available | load |
                """,
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["机器设备"],
                [item["label"] for item in _findings(report, "AVAILABLE_SKILL_DIRECTORY_MISSING")],
            )
            self.assertEqual(
                ["机器设备"],
                [item["label"] for item in _findings(report, "REGISTRY_LABEL_NOT_IN_CATALOG")],
            )

    def test_directory_and_frontmatter_name_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")
            _write(
                repo / "skills/crwu-audit-asset-realestate/SKILL.md",
                "---\nname: crwu-audit-asset-realty\ndescription: Use when selected.\n---\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertIn("crwu-audit-asset-realestate", {i["skill"] for i in _findings(report, "SKILL_NAME_MISMATCH")})

    def test_registry_name_held_by_a_differently_named_directory_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                """
                | axis | label | skill | status | load behavior |
                | --- | --- | --- | --- | --- |
                | asset | 房地产 | crwu-audit-asset-realestate | available | load |
                """,
            )
            # Directory renamed, frontmatter kept: registry name and directory disagree.
            _create_leaf(repo, "crwu-audit-asset-realty", "02-资产类型/01-房地产/")
            _write(
                repo / "skills/crwu-audit-asset-realty/SKILL.md",
                "---\nname: crwu-audit-asset-realestate\ndescription: Use when selected.\n---\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertIn("AVAILABLE_SKILL_DIRECTORY_MISSING", _codes(report))
            self.assertIn(
                "crwu-audit-asset-realestate",
                {i["skill"] for i in _findings(report, "SKILL_NAME_MISMATCH")},
            )
            self.assertIn("crwu-audit-asset-realty", {i["skill"] for i in _findings(report, "ORPHAN_SKILL")})

    def test_missing_required_reference_and_orphan_skill_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")
            (repo / "skills/crwu-audit-asset-realestate/references/02-review-focus.md").unlink()
            _create_leaf(repo, "crwu-audit-asset-unregistered", "02-资产类型/02-未登记资产/")

            report = json.loads(run_checker(repo, tree).stdout)

            missing = _findings(report, "SKILL_REFERENCE_MISSING")
            self.assertEqual(["02-review-focus.md"], [Path(i["path"]).name for i in missing])
            self.assertIn(
                "crwu-audit-asset-unregistered",
                {i["skill"] for i in _findings(report, "ORPHAN_SKILL")},
            )

    def test_duplicate_and_unclassified_labels_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                """
                | axis | label | skill | status | load behavior |
                | --- | --- | --- | --- | --- |
                | asset | 房地产 | crwu-audit-asset-realestate | available | load |
                | asset | 机器设备 | crwu-audit-asset-equipment | available | load |
                | asset | 机器设备 | crwu-audit-asset-equipment | available | load |
                | business | 资产经营 | crwu-audit-biz-asset-operation | available | load |
                """,
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")
            _write(
                repo / "skills/crwu-audit/references/03-asset-classification.md",
                "| canonical 资产类型 | 目标技能 |\n| --- | --- |\n| 存货 | `crwu-audit-asset-inventory` |\n",
            )
            _write(
                repo / "skills/crwu-audit/references/04-business-classification.md",
                "| 一级业务 | 目标技能 |\n| --- | --- |\n| 计税 | `crwu-audit-biz-tax-history` |\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                [("asset", "机器设备")],
                [(i["axis"], i["label"]) for i in _findings(report, "REGISTRY_LABEL_DUPLICATE")],
            )
            self.assertEqual(
                {("asset", "房地产"), ("business", "资产经营")},
                {(i["axis"], i["label"]) for i in _findings(report, "CLASSIFICATION_LABEL_MISSING")},
            )
            # The duplicated row is one claim, so its missing directory is reported once.
            self.assertEqual(
                ["crwu-audit-asset-equipment"],
                [i["skill"] for i in _findings(report, "AVAILABLE_SKILL_DIRECTORY_MISSING")],
            )

    def test_declared_root_absent_from_catalog_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/09-已归档资产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["02-资产类型/09-已归档资产/"],
                [i["path"] for i in _findings(report, "MAPPING_ROOT_NOT_IN_CATALOG")],
            )

    def test_axis_root_and_skill_prefix_mismatches_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                """
                | axis | label | skill | status | load behavior |
                | --- | --- | --- | --- | --- |
                | asset | 房地产 | crwu-audit-asset-realestate | available | load |
                | business | 资产经营 | crwu-audit-asset-asset-operation | available | load |
                """,
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "01-业务路线/01-资产经营/")
            _create_leaf(repo, "crwu-audit-asset-asset-operation", "01-业务路线/01-资产经营/")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["01-业务路线/01-资产经营/"],
                [i["path"] for i in _findings(report, "AXIS_ROOT_MISMATCH")],
            )
            self.assertEqual(
                ["crwu-audit-asset-asset-operation"],
                [i["skill"] for i in _findings(report, "AXIS_PREFIX_MISMATCH")],
            )
            # The business root exists, so it is not reported as a stale mapping.
            self.assertEqual([], _findings(report, "MAPPING_ROOT_NOT_IN_CATALOG"))

    def test_partial_catalog_does_not_claim_roots_were_deleted(self):
        business_only = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root, business_only)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                """
                | axis | label | skill | status | load behavior |
                | --- | --- | --- | --- | --- |
                | asset | 房地产 | crwu-audit-asset-realestate | available | load |
                | business | 资产经营 | crwu-audit-biz-asset-operation | available | load |
                """,
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual([], _findings(report, "MAPPING_ROOT_NOT_IN_CATALOG"))
            self.assertEqual([], _findings(report, "AXIS_ROOT_MISMATCH"))
            self.assertEqual([], _findings(report, "ASSEMBLY_FIRST_LEVEL_ROOT_MISSING"))

    def test_legacy_business_directory_is_reported_as_pending_migration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")
            _create_leaf(repo, "crwu-audit-business-rent", "01-业务路线/02-租赁/")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["crwu-audit-business-rent"],
                [i["skill"] for i in _findings(report, "LEGACY_BUSINESS_PREFIX")],
            )

    def test_catalog_and_repository_paths_agree_across_input_formats(self):
        node_index = {
            "schema": "crwu.kb-dir-cache.nodeindex.v1",
            "by_path": {
                "01-业务路线/": ["b"],
                "01-业务路线/01-资产经营/": ["b1"],
                "01-业务路线/01-资产经营/租赁与租金评估/": ["b2"],
                "01-业务路线/01-资产经营/租赁与租金评估/01-业务通用审核要点": ["b3"],
                "02-资产类型/": ["a"],
                "02-资产类型/01-房地产/": ["a1"],
                "02-资产类型/01-房地产/01-共性参考/": ["a2"],
                "02-资产类型/01-房地产/01-共性参考/02-评估审核条目": ["a3"],
                "02-资产类型/01-房地产/02-细分对象/": ["a4"],
                "02-资产类型/01-房地产/02-细分对象/01-土地使用权/": ["a5"],
                "02-资产类型/01-房地产/02-细分对象/01-土地使用权/评估审核条目": ["a6"],
            },
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            index = root / "node-index.json"
            index.write_text(json.dumps(node_index, ensure_ascii=False), encoding="utf-8")
            _create_valid_repo(repo)

            tree_report = json.loads(run_checker(repo, tree, "--strict").stdout)
            index_report = json.loads(run_checker(repo, index, "--strict").stdout)

            self.assertEqual([], tree_report["findings"])
            self.assertEqual([], index_report["findings"])

    @_requires_skill_tree
    def test_maintainer_documents_treat_the_legacy_prefix_as_migration_only(self):
        offenders = []
        for document in sorted(MAINTAINER_SKILL.rglob("*.md")):
            for lineno, line in enumerate(document.read_text(encoding="utf-8").splitlines(), start=1):
                if "crwu-audit-business-" not in line:
                    continue
                if not any(word in line for word in ("遗留", "待迁移", "legacy", "deprecated")):
                    offenders.append(f"{document.name}:{lineno}")
        self.assertEqual([], offenders, "legacy prefix must only be described as pending migration")


    def test_legacy_combined_skill_directory_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_valid_repo(repo)
            # Legacy combined asset x business skill left over from the pre-axis layout.
            _write(
                repo / "skills/crwu-audit-realestate-rent/SKILL.md",
                "---\nname: crwu-audit-realestate-rent\ndescription: Use when selected.\n---\n",
            )
            # Infrastructure skills are not axis leaves and must stay exempt.
            _write(
                repo / "skills/crwu-audit-datacheck/SKILL.md",
                "---\nname: crwu-audit-datacheck\ndescription: Use when tabular.\n---\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["crwu-audit-realestate-rent"],
                [i["skill"] for i in _findings(report, "LEGACY_COMBINED_SKILL")],
            )
            self.assertNotIn(
                "crwu-audit-datacheck",
                {i["skill"] for i in report["findings"]},
            )

    def test_business_common_review_document_must_be_referenced(self):
        """A first-level business folder's 共同审核点 must be downloaded and referenced."""
        tree_with_common = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 共同审核点.md
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root, tree_with_common)
            _create_valid_repo(repo)

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["资产经营"],
                [i["label"] for i in _findings(report, "BUSINESS_COMMON_REVIEW_NOT_REFERENCED")],
            )

    def test_business_common_review_reference_is_satisfied_by_either_reference(self):
        tree_with_common = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 01-共同审核点.md
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root, tree_with_common)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit-biz-asset-operation/references/02-review-focus.md",
                "# Review focus\n\n一级共用层：`01-业务路线/01-资产经营/共同审核点`。\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual([], _findings(report, "BUSINESS_COMMON_REVIEW_NOT_REFERENCED"))

    def test_absent_business_common_review_document_is_not_a_gap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _create_valid_repo(repo)

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual([], _findings(report, "BUSINESS_COMMON_REVIEW_NOT_REFERENCED"))
            self.assertEqual([], report["findings"])

    def test_negative_common_review_claim_does_not_satisfy_the_reference(self):
        """Naming the document while denying it exists is not a reference.

        Regression for the field bug this check was written against: a leaf that still said
        "一级根未提供 `共同审核点`" mentioned the document, so a plain substring test passed
        while the shared review layer was in fact never referenced.
        """
        tree_with_common = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 共同审核点
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root, tree_with_common)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit-biz-asset-operation/references/02-review-focus.md",
                "# Review focus\n\n## 一级共用层\n\n"
                "- 路径：库内未提供（无此前缀路径）\n"
                "- 状态：一级根未提供 `共同审核点`（条件性约定，**不记缺口**）。\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["资产经营"],
                [
                    i["label"]
                    for i in _findings(report, "BUSINESS_COMMON_REVIEW_NOT_REFERENCED")
                ],
            )

    def test_emitted_calibration_table_does_not_become_drift(self):
        """`--emit-map` writes its diagnostic table into a scanned file: it must stay idempotent.

        The table lists missing keys; backticking them there made the next run report the
        calibration file itself as drifted (and re-attributed another skill's drift to it).
        """
        tree = """
        - 📁 00-总纲/
          - 📁 治理/
            - 📄 标签词典
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 共同审核点
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree_path = self._tree(root, tree)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/00-input-and-route-profile.md",
                "# profile\n\n- 库内没有的键：`00-总纲/治理/术语对照总表`\n",
            )
            calibration = (
                repo
                / "skills/crwu-dev-audit-skill-maintainer/references/07-kb-skill-map.md"
            )

            first = json.loads(
                run_checker(repo, tree_path, "--emit-map", str(calibration)).stdout
            )
            self.assertEqual(
                ["00-总纲/治理/术语对照总表"],
                [i["path"] for i in _findings(first, "KB_PATH_KEY_NOT_IN_CATALOG")],
            )
            self.assertIn("术语对照总表", calibration.read_text(encoding="utf-8"))

            second = json.loads(run_checker(repo, tree_path).stdout)

            self.assertEqual(
                [],
                [
                    i
                    for i in _findings(second, "KB_PATH_KEY_NOT_IN_CATALOG")
                    if str(calibration) in (i["source"] or "")
                ],
                "the emitted calibration table must not report itself as drift",
            )
            self.assertEqual(
                ["00-总纲/治理/术语对照总表"],
                [i["path"] for i in _findings(second, "KB_PATH_KEY_NOT_IN_CATALOG")],
            )

    def test_missing_router_entry_point_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_leaf(repo, "crwu-audit-asset-realestate", "02-资产类型/01-房地产/")
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertIn("ROUTER_FILE_MISSING", _codes(report))

    def test_missing_and_unresolved_router_references_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _create_valid_repo(repo)
            (repo / "skills/crwu-audit/references/05-method-classification.md").unlink()
            _write(
                repo / "skills/crwu-audit/SKILL.md",
                "# 总路由\n\n并集见 `08-union-dispatch-rules.md`，另见 `12-nonexistent.md`。\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["05-method-classification.md"],
                [Path(i["path"]).name for i in _findings(report, "ROUTER_REFERENCE_MISSING")],
            )
            self.assertEqual(
                ["12-nonexistent.md"],
                [Path(i["path"]).name for i in _findings(report, "ROUTER_REFERENCE_UNRESOLVED")],
            )

    def test_axis_present_in_catalog_must_be_dispatched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/08-union-dispatch-rules.md",
                "skills_to_load = stable_unique(asset_skills, method_skills, overlay_skills)\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["business"],
                [i["axis"] for i in _findings(report, "ROUTER_AXIS_UNDISPATCHED")],
            )

    def test_routing_layer_must_not_name_unresolvable_skills(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/08-union-dispatch-rules.md",
                (
                    "# 稳定并集\n\n"
                    "skills_to_load = stable_unique(scope_skills, asset_skills, business_skills, "
                    "method_skills, overlay_skills, public_skills)\n\n"
                    "命中房地产时并入 crwu-audit-asset-realestate；"
                    "清算场景并入 crwu-audit-biz-liquidation。\n"
                    "通配写法 crwu-audit-asset-* 与占位 crwu-audit-<axis>-<label> 不算具体技能名。\n"
                ),
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["crwu-audit-biz-liquidation"],
                [i["skill"] for i in _findings(report, "ROUTER_SKILL_REFERENCE_UNRESOLVED")],
            )

    def test_stale_or_untimed_catalog_is_reported_when_freshness_is_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            _create_valid_repo(repo)
            # Timestamped but old.
            stale = root / "node-index.json"
            stale.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-node-index.v1",
                        "fetchedAt": "2020-01-01T00:00:00+08:00",
                        "nodes": {
                            "a": {"nodeId": "a", "name": "02-资产类型", "type": "folder", "path": "02-资产类型"}
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            # No capture time at all.
            untimed = root / "tree.md"
            untimed.write_text("- 📁 02-资产类型/\n  - 📁 01-房地产/\n", encoding="utf-8")

            fresh_report = json.loads(run_checker(repo, stale, "--max-age-hours", "1").stdout)
            untimed_report = json.loads(run_checker(repo, untimed, "--max-age-hours", "1").stdout)
            unchecked_report = json.loads(run_checker(repo, stale).stdout)

            self.assertIn("CATALOG_STALE", _codes(fresh_report))
            self.assertIn("CATALOG_NOT_LIVE", _codes(untimed_report))
            self.assertEqual([], _findings(unchecked_report, "CATALOG_STALE"))
            self.assertEqual([], _findings(unchecked_report, "CATALOG_NOT_LIVE"))

    @_requires_skill_tree
    def test_real_repository_routing_layer_is_consistent(self):
        """The live repo's router, references, registry and skill dirs must agree."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            catalog = root / "tree.md"
            catalog.write_text(COMPLETE_TREE, encoding="utf-8")

            report = json.loads(run_checker(REPO_ROOT, catalog).stdout)

            routing_codes = sorted(
                {
                    item["code"]
                    for item in report["findings"]
                    if item["code"].startswith("ROUTER_")
                }
            )
            self.assertEqual([], routing_codes)

    def test_emit_map_writes_and_preserves_calibration_document(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            _create_valid_repo(repo)
            out = root / "map.md"

            first = run_checker(repo, tree, "--emit-map", str(out))
            self.assertEqual(0, first.returncode, first.stderr)
            text = out.read_text(encoding="utf-8")
            self.assertIn("知识库 ↔ Skill 映射校准表", text)
            self.assertIn("`02-资产类型/01-房地产/`", text)
            self.assertIn("`crwu-audit-asset-realestate`", text)
            self.assertIn("`01-业务路线/01-资产经营/`", text)
            self.assertIn("`crwu-audit-biz-asset-operation`", text)
            self.assertIn("CALIBRATION-HISTORY:BEGIN", text)

            # Hand-maintained notes must survive a re-run; history must gain exactly one row.
            # The first run's own row is dropped first: identical stamps are deduplicated, so
            # keeping it would make the expected row count depend on whether the two runs happen
            # to land in the same wall-clock second (a real flake this test used to have).
            begin = "<!-- CALIBRATION-HISTORY:BEGIN -->"
            finish = "<!-- CALIBRATION-HISTORY:END -->"
            before, rest = text.split(begin)
            history_block, after = rest.split(finish)
            kept = [l for l in history_block.splitlines() if not l.startswith("| 20")]
            text = before + begin + "\n" + "\n".join(kept).strip("\n") + "\n" + finish + after
            text = text.replace(
                "<!-- CALIBRATION-NOTES:BEGIN -->",
                "<!-- CALIBRATION-NOTES:BEGIN -->\n人工备注：必检项待补。",
            )
            text = text.replace(
                "<!-- CALIBRATION-HISTORY:END -->",
                "| 2020-01-01T00:00:00+08:00 | 2020-01-01T00:00:00+08:00 | 1 | 9 | 9 | 9 |\n<!-- CALIBRATION-HISTORY:END -->",
            )
            out.write_text(text, encoding="utf-8")
            second = run_checker(repo, tree, "--emit-map", str(out))
            self.assertEqual(0, second.returncode, second.stderr)
            refreshed = out.read_text(encoding="utf-8")
            self.assertIn("人工备注：必检项待补。", refreshed)
            history = refreshed.split("CALIBRATION-HISTORY:BEGIN")[1].split("CALIBRATION-HISTORY:END")[0]
            data_rows = [l for l in history.splitlines() if l.startswith("| 20")]
            # Older row preserved, exactly one new row appended, newest shown first.
            self.assertEqual(2, len(data_rows))
            self.assertIn("2020-01-01", data_rows[-1])
            self.assertNotIn("2020-01-01", data_rows[0])

    def test_calibration_flags_missing_common_layer_and_subroute_coverage(self):
        tree = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 共同审核点.md
            - 📁 持有价值管理/
              - 📄 01-业务通用审核要点
            - 📁 空子业务/
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree_path = self._tree(root, tree)
            _write(
                repo / "skills/crwu-audit/references/07-skill-registry.md",
                _registry("crwu-audit-asset-realestate", "crwu-audit-biz-asset-operation"),
            )
            _create_router(repo)
            _create_leaf(repo, "crwu-audit-biz-asset-operation", "01-业务路线/01-资产经营/")
            out = root / "map.md"

            run_checker(repo, tree_path, "--emit-map", str(out))
            text = out.read_text(encoding="utf-8")

            self.assertIn("2（1）", text, text)
            self.assertIn("缺：空子业务", text)
            self.assertIn("有", text)

    def test_library_path_keys_must_match_the_latest_catalog(self):
        """Address keys are checked for the whole audit family, not just first-level roots."""
        tree = """
        - 📁 00-总纲/
          - 📁 治理/
            - 📄 标签词典
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 01-业务通用审核要点
        - 📁 02-资产类型/
          - 📁 01-房地产/
            - 📁 01-共性参考/
              - 📄 02-评估审核条目
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree_path = self._tree(root, tree)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/00-input-and-route-profile.md",
                textwrap.dedent(
                    """
                    # profile

                    - 词表：`00-总纲/治理/标签词典`
                    - 主语料：`01-业务路线/01-资产经营/`
                    - 库内没有的键：`00-总纲/治理/术语对照总表`
                    """
                ).lstrip(),
            )

            report = json.loads(run_checker(repo, tree_path).stdout)

            codes = _codes(report)
            self.assertIn("KB_PATH_KEY_NOT_IN_CATALOG", codes)
            self.assertEqual(
                ["00-总纲/治理/术语对照总表"],
                [i["path"] for i in _findings(report, "KB_PATH_KEY_NOT_IN_CATALOG")],
            )
            self.assertTrue(
                all(
                    i["path"].startswith("00-总纲/")
                    for i in _findings(report, "KB_PATH_KEY_NOT_IN_CATALOG")
                )
            )

    def test_export_suffix_and_folder_slash_drift_is_reported(self):
        tree = """
        - 📁 00-总纲/
          - 📁 治理/
            - 📄 标签词典
        - 📁 02-资产类型/
          - 📁 01-房地产/
            - 📁 01-共性参考/
              - 📄 02-评估审核条目
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree_path = self._tree(root, tree)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/00-input-and-route-profile.md",
                textwrap.dedent(
                    """
                    # profile

                    - 旧库残留后缀：`00-总纲/治理/标签词典.md`
                    - 目录漏尾斜杠：`02-资产类型/01-房地产`
                    - 占位与省略号不算键：`00-总纲/治理/某文件`、`00-总纲/…`
                    """
                ).lstrip(),
            )

            report = json.loads(run_checker(repo, tree_path).stdout)

            self.assertEqual(
                ["00-总纲/治理/标签词典.md"],
                [i["path"] for i in _findings(report, "KB_PATH_KEY_HAS_EXPORT_SUFFIX")],
            )
            self.assertEqual(
                ["02-资产类型/01-房地产"],
                [i["path"] for i in _findings(report, "KB_PATH_KEY_FOLDER_NEEDS_SLASH")],
            )
            self.assertEqual([], _findings(report, "KB_PATH_KEY_NOT_IN_CATALOG"))

    def test_uncaptured_containers_are_not_judged(self):
        """A partial catalog must not make every out-of-scope key look like drift."""
        business_only = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📄 01-业务通用审核要点
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree_path = self._tree(root, business_only)
            _create_valid_repo(repo)
            _write(
                repo / "skills/crwu-audit/references/00-input-and-route-profile.md",
                "- 规则库：`06-规则库/02-通用准则-报告与披露/报告准则-精编条目/报告准则-总则与基本遵循`\n",
            )

            report = json.loads(run_checker(repo, tree_path).stdout)

            self.assertEqual([], _findings(report, "KB_PATH_KEY_NOT_IN_CATALOG"))

    def test_unsupported_catalog_schema_reports_accepted_set_and_remediation(self):
        """无法解析的 catalog schema：报错必须列出可接受集合并给出重建指引，不得只报名字。

        真实失效：实时 `目录快照.json` 被写成扁平 `path` 形态、schema 字面混成
        `crwu.kb-dir-cache.snapshot.v1`（与 `.cache-meta.json` 的 `crwu.kb-dir-cache.meta.v1`
        混合而成），而旧报错只有 `unsupported catalog schema: '…'` —— 看不出该改什么。
        不得为该字面开别名：那等于把漂移固化成契约。

        本测试自足（不依赖同级技能），故不加 `@_requires_skill_tree`：
        单独安装本技能时这条报错契约仍须被锁住。
        """
        with tempfile.TemporaryDirectory() as td:
            catalog = Path(td) / "目录快照.json"
            catalog.write_text(
                json.dumps({"schema": "crwu.kb-dir-cache.snapshot.v1", "nodes": []}),
                encoding="utf-8",
            )
            proc = run_checker(REPO_ROOT, catalog)
            self.assertNotEqual(0, proc.returncode, "不可解析的 catalog 必须非零退出")
            err = proc.stderr + proc.stdout
            for needle in ("accepted:", "crwu.kb-catalog.snapshot.v1",
                           "rebuild it with crwu-dws M1", "nested `children`"):
                self.assertIn(needle, err, err)
            self.assertNotIn("Traceback", err, "须是可读错误信息，不是异常栈")

    def test_mandated_directory_tree_form_is_parseable(self):
        """`crwu-dws/references/00` §4 规定的 `目录树.md` 形态（`├─`/`└─` + `[F]`/extension）
        必须能作为 `--catalog` 读取。

        三种形态历史上互不一致：**规范**是 box-drawing（`├─`/`└─`、folder 标 `[F]`、文档标
        `extension`），**旧产物**是图标树（`- 📁`／`- 📄`），而 checker 只认图标树与 slash 树——
        结果"规定的产物"反而解析不了，`目录树.md` 无法作为目录输入。

        本测试自足（不依赖同级技能），故不加 `@_requires_skill_tree`。
        """
        tree = textwrap.dedent("""\
            # 某知识库 目录树
            > workspaceId: w ｜ spaceType: orgWikiSpace ｜ 扫取: 2026-09-15T00:00:00+08:00 ｜ profile: p
            > 节点 4（folder 2 / 文档 2）/ 深度 2 ｜ complete: true

            ├─ 01-业务路线/                    [F]
            │  ├─ 01-资产经营/                    [F]
            │  │  └─ 共同审核点                    adoc
            └─ 根层文档名                    ext:未提供
            """)
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "目录树.md"
            path.write_text(tree, encoding="utf-8")
            report = json.loads(run_checker(REPO_ROOT, path).stdout)
            self.assertEqual(
                ("01-业务路线/", "01-业务路线/01-资产经营/",
                 "01-业务路线/01-资产经营/共同审核点", "根层文档名"),
                tuple(report["catalog"]["paths"]),
            )

    @_requires_skill_tree
    def test_calibration_history_is_chronological_and_self_healing(self):
        """校准历史必须"新→旧"，并能把已被搅乱的顺序自愈。

        注意**不能**断言"重复 emit 字节不变"：每行第一格是**本次运行时间**，跨秒的两次 emit 会各追加
        一条（append-only 设计；同一秒内重复运行因整行相同才不重复追加）。R1 修的是**顺序** ——
        旧实现每 emit 把已有行整体翻一次，且错乱后不自愈。
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            _create_valid_repo(repo)
            catalog = self._tree(root) if hasattr(self, "_tree") else None
            catalog = root / "catalog.json"
            catalog.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-node-index.v1",
                        "fetched_at": "2026-09-26T13:15:34+08:00",
                        "complete": True,
                        "byPath": {
                            "01-业务路线": {"nodeId": "b", "type": "folder"},
                            "01-业务路线/01-资产经营": {"nodeId": "c", "type": "folder"},
                            "02-资产类型": {"nodeId": "a", "type": "folder"},
                            "02-资产类型/01-房地产": {"nodeId": "d", "type": "folder"},
                        },
                        "byName": {},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            map_path = root / "map.md"
            # 预置一个**被搅乱**的历史块：10 / 20 / 05（既非升序也非降序）
            map_path.write_text(
                "# 校准表\n\n## 校准历史（新→旧，工具追加）\n\n"
                "<!-- CALIBRATION-HISTORY:BEGIN -->\n"
                "| 校准时间 | 目录抓取时间 | 节点数 | error | warning | 建议 |\n"
                "| --- | --- | --- | --- | --- | --- |\n"
                "| 2026-09-10T10:00:00+08:00 | x | 1 | 0 | 0 | 0 |\n"
                "| 2026-09-20T10:00:00+08:00 | x | 1 | 0 | 0 | 0 |\n"
                "| 2026-09-05T10:00:00+08:00 | x | 1 | 0 | 0 | 0 |\n"
                "<!-- CALIBRATION-HISTORY:END -->\n",
                encoding="utf-8",
            )

            run_checker(repo, catalog, "--emit-map", str(map_path))

            block = map_path.read_text(encoding="utf-8")
            block = block.split("CALIBRATION-HISTORY:BEGIN")[1].split("CALIBRATION-HISTORY:END")[0]
            stamps = [
                line.strip().split("|")[1].strip()
                for line in block.splitlines()
                if line.strip().startswith("| 2")
            ]
            self.assertEqual(sorted(stamps, reverse=True), stamps, f"必须自愈为「新→旧」，实际 {stamps}")
            # 旧行不得丢失，本次运行追加一条
            for kept in ("2026-09-05T10:00:00+08:00", "2026-09-10T10:00:00+08:00", "2026-09-20T10:00:00+08:00"):
                self.assertIn(kept, stamps)
            self.assertEqual(4, len(stamps), f"应为 3 条旧记录 + 本次 1 条，实际 {stamps}")

    def test_real_repository_library_path_keys_exist(self):
        """本源仓的审核族地址键必须在**真实 crwu-dws 产物**里成立。

        **缓存选择口径（2026-09-26 · OPT-004-R3 修正）**：

        - **自动发现**：按抓取时间新→旧逐个评估；过期候选只**记录**，继续看下一个；找到完整有效候选
          即通过；全部用尽且都只是允许的过期缺口时，**聚合一次** skip，消息里逐个列出候选与缺失键。
          **成功选中完整有效候选之前**、被实际评估过的候选上出现"声明之外缺失键""后缀/斜杠漂移"
          一律**失败**；一旦命中完整有效候选即成功返回，**更老的历史缓存不再参与判定**。
        - **显式覆盖**（`CRWU_DWS_CACHE_DIR` / `CRWU_DWS_SNAPSHOT`）：调用者指定的就是**要验证的精确
          对象** —— 不存在、不可解析、知识库不匹配、过期、缺键、真实漂移**都是失败**，不 skip、不降级
          到自动发现；`CRWU_DWS_SNAPSHOT` 用**传入的那个文件**，不换成同目录的 `目录快照.json`。
        """
        mode, candidates = _cache_candidates()
        excluded = _excluded_backup_dirs()
        verdict = evaluate_library_path_keys(
            candidates,
            mode,
            notes=(
                [f"自动发现已排除备份目录（回滚用，非活缓存）：{'、'.join(excluded)}"] if excluded else None
            ),
        )
        if verdict["status"] == "fail":
            self.fail(verdict["message"])
        if verdict["status"] == "stale":
            self.skipTest(verdict["message"])
        # ok：至少一个候选（自动）或指定的那个（显式）全部地址键成立

    def test_live_cache_artifact_forms_agree_on_the_same_tree(self):
        """Every artifact crwu-dws writes for one cache must parse to the same path set.

        Regression for the field-shape drift class: `目录快照.json` (flat + `parentFolderId`,
        snake_case capture time, top-level `complete`), `node-index.json` (camelCase `byPath`
        typed per entry) and `目录树.md` (slash/dash indented tree) must all yield one tree.
        """
        for directory in _cache_directories():
            forms = [
                directory / name
                for name in LIVE_CATALOG_FORMS
                if (directory / name).is_file()
            ]
            if len(forms) < 2:
                continue
            parsed: dict[str, tuple[str, ...]] = {}
            for form in forms:
                report = _catalog_report(form)
                parsed[form.name] = tuple(report["catalog"]["paths"])
            if not _is_audit_family_catalog(parsed[forms[0].name]):
                continue

            self.assertEqual(
                1,
                len(set(parsed.values())),
                {name: len(paths) for name, paths in parsed.items()},
            )
            # The mandated freshness gate must also pass on the authoritative snapshot.
            live = forms[0]
            report = _catalog_report(live)
            self.assertNotIn("CATALOG_NOT_LIVE", _codes(report))
            return
        self.skipTest("no live DWS cache with multiple artifact forms is available")

    def test_real_dws_artifact_shapes_normalize_identically(self):
        """The three shapes crwu-dws actually emits must agree on the same knowledge tree."""
        markdown = """
        - 📁 01-业务路线/
          - 📁 01-资产经营/
            - 📁 租赁与租金评估/
              - 📄 01-业务通用审核要点
        - 📁 02-资产类型/
          - 📁 01-房地产/
            - 📁 01-共性参考/
              - 📄 02-评估审核条目
        """
        # Authoritative shape per crwu-dws/references/00-目录快照schema.md:
        # nested `children` + `parentFolderId`, completeness on `stats.complete`.
        # Business/asset names carry no `.md` — that is only the local export suffix.
        snapshot = {
            "schema": "crwu.kb-dir-snapshot.v1",
            "space": {"name": "space", "workspaceId": "ws"},
            "fetchedAt": "2026-09-09T14:54:05+08:00",
            "stats": {"total_nodes": 8, "folders": 6, "docs": 2, "max_depth": 3, "complete": True},
            "failures": [],
            "nodes": [
                {
                    "nodeId": "b", "name": "01-业务路线", "type": "folder",
                    "parentFolderId": None, "depth": 0,
                    "children": [
                        {
                            "nodeId": "b1", "name": "01-资产经营", "type": "folder",
                            "parentFolderId": "b", "depth": 1,
                            "children": [
                                {
                                    "nodeId": "b2", "name": "租赁与租金评估", "type": "folder",
                                    "parentFolderId": "b1", "depth": 2,
                                    "children": [
                                        {"nodeId": "b3", "name": "01-业务通用审核要点", "type": "adoc",
                                         "parentFolderId": "b2", "depth": 3, "children": []}
                                    ],
                                }
                            ],
                        }
                    ],
                },
                {
                    "nodeId": "a", "name": "02-资产类型", "type": "folder",
                    "parentFolderId": None, "depth": 0,
                    "children": [
                        {
                            "nodeId": "a1", "name": "01-房地产", "type": "folder",
                            "parentFolderId": "a", "depth": 1,
                            "children": [
                                {
                                    "nodeId": "a2", "name": "01-共性参考", "type": "folder",
                                    "parentFolderId": "a1", "depth": 2,
                                    "children": [
                                        {"nodeId": "a3", "name": "02-评估审核条目", "type": "adoc",
                                         "parentFolderId": "a2", "depth": 3, "children": []}
                                    ],
                                }
                            ],
                        }
                    ],
                },
            ],
        }
        flat = [("b", "01-业务路线", "folder", None), ("b1", "01-资产经营", "folder", "b"),
                ("b2", "租赁与租金评估", "folder", "b1"), ("b3", "01-业务通用审核要点", "adoc", "b2"),
                ("a", "02-资产类型", "folder", None), ("a1", "01-房地产", "folder", "a"),
                ("a2", "01-共性参考", "folder", "a1"), ("a3", "02-评估审核条目", "adoc", "a2")]
        paths = {
            "b": "01-业务路线",
            "b1": "01-业务路线/01-资产经营",
            "b2": "01-业务路线/01-资产经营/租赁与租金评估",
            "b3": "01-业务路线/01-资产经营/租赁与租金评估/01-业务通用审核要点",
            "a": "02-资产类型",
            "a1": "02-资产类型/01-房地产",
            "a2": "02-资产类型/01-房地产/01-共性参考",
            "a3": "02-资产类型/01-房地产/01-共性参考/02-评估审核条目",
        }
        node_index = {
            "schema": "crwu.kb-node-index.v1",
            "fetchedAt": "2026-09-09T14:54:05+08:00",
            "nodes": {
                nid: {"nodeId": nid, "name": name, "type": kind, "path": paths[nid]}
                for nid, name, kind, _parent in flat
            },
        }

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root, markdown)
            snapshot_file = root / "目录快照.json"
            index_file = root / "node-index.json"
            snapshot_file.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            index_file.write_text(json.dumps(node_index, ensure_ascii=False), encoding="utf-8")
            _create_valid_repo(repo)

            reports = [
                json.loads(run_checker(repo, source, "--strict").stdout)
                for source in (tree, snapshot_file, index_file)
            ]

            self.assertEqual(
                reports[0]["catalog"]["paths"],
                reports[1]["catalog"]["paths"],
            )
            self.assertEqual(
                reports[0]["catalog"]["paths"],
                reports[2]["catalog"]["paths"],
            )
            self.assertEqual(8, len(reports[0]["catalog"]["paths"]))
            for report in reports:
                self.assertEqual([], report["findings"])
            self.assertEqual("crwu.kb-dir-snapshot.v1", reports[1]["catalog"]["source_schema"])
            self.assertEqual("crwu.kb-node-index.v1", reports[2]["catalog"]["source_schema"])
            self.assertIs(True, reports[1]["catalog"]["complete"])

    def test_legacy_flat_snapshot_uses_parent_folder_id_authoritatively(self):
        """The flat legacy form must link on `parentFolderId`, with `parentId` as alias only."""
        flat_nodes = [
            {"nodeId": "a", "name": "02-资产类型", "type": "folder", "parentFolderId": None},
            {"nodeId": "a1", "name": "01-房地产", "type": "folder", "parentFolderId": "a"},
            {"nodeId": "a2", "name": "01-共性参考", "type": "folder", "parentFolderId": "a1"},
            {"nodeId": "a3", "name": "02-评估审核条目", "type": "adoc", "parentFolderId": "a2"},
        ]
        alias_nodes = [
            {**node, "parentId": node["parentFolderId"]} for node in flat_nodes
        ]
        for key in ("parentFolderId",):
            for node in alias_nodes:
                node.pop(key, None)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            _create_valid_repo(repo)
            for name, nodes in (("authoritative.json", flat_nodes), ("alias.json", alias_nodes)):
                catalog = root / name
                catalog.write_text(
                    json.dumps(
                        {
                            "schema": "crwu.kb-dir-snapshot.v1",
                            "fetchedAt": "2026-09-09T14:54:05+08:00",
                            "stats": {"total_nodes": len(nodes), "complete": True},
                            "failures": [],
                            "nodes": nodes,
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                report = json.loads(run_checker(repo, catalog).stdout)
                self.assertEqual(
                    [
                        "02-资产类型/",
                        "02-资产类型/01-房地产/",
                        "02-资产类型/01-房地产/01-共性参考/",
                        "02-资产类型/01-房地产/01-共性参考/02-评估审核条目",
                    ],
                    report["catalog"]["paths"],
                    name,
                )

    def test_incomplete_dws_snapshot_is_reported_as_incomplete(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._tree(root)
            snapshot_file = root / "目录快照.json"
            snapshot_file.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-dir-snapshot.v1",
                        "fetchedAt": "2026-09-09T14:54:05+08:00",
                        "stats": {"total_nodes": 1, "folders": 1, "docs": 0,
                                  "max_depth": 0, "complete": False},
                        "failures": [{"nodeId": "a", "step": "node-list", "error": "timeout"}],
                        "nodes": [{"nodeId": "a", "name": "02-资产类型", "type": "folder",
                                   "parentFolderId": None, "depth": 0, "children": []}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = json.loads(run_checker(repo, snapshot_file).stdout)

            self.assertIs(False, report["catalog"]["complete"])
            self.assertEqual(["02-资产类型/"], report["catalog"]["paths"])


class CrwuDwsArtifactShapeTest(unittest.TestCase):
    """Every shape `crwu-dws` actually writes must load with the same 263-path-equivalent tree.

    Regression: the checker previously read only camelCase capture time (`fetchedAt`), only
    `stats.complete`, and inferred folder-ness from a trailing `/` on node-index keys. Real
    crwu-dws artifacts use `fetched_at` / top-level `complete` / `byPath` entries typed as
    `folder`, so a schema-conformant fixture passed while the live artifact was rejected.
    """

    def setUp(self):
        self.now = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()

    def test_dir_snapshot_snake_case_time_and_top_level_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            catalog = Path(temp) / "目录快照.json"
            catalog.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-dir-snapshot.v1",
                        "fetched_at": self.now,
                        "complete": True,
                        "truncated": False,
                        "stats": {"total": 3, "folders": 2, "docs": 1, "maxDepth": 3},
                        "evidence": {"foldersVisited": 2, "pages": []},
                        "nodes": [
                            {"nodeId": "r", "name": "02-资产类型", "type": "folder", "parentFolderId": None},
                            {"nodeId": "c", "name": "01-房地产", "type": "folder", "parentFolderId": "r"},
                            {
                                "nodeId": "d",
                                "name": "02-评估审核条目",
                                "type": "file",
                                "parentFolderId": "c",
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = json.loads(run_checker(REPO_ROOT, catalog, "--max-age-hours", "1").stdout)

            self.assertEqual(
                ["02-资产类型/", "02-资产类型/01-房地产/", "02-资产类型/01-房地产/02-评估审核条目"],
                report["catalog"]["paths"],
            )
            self.assertIs(True, report["catalog"]["complete"])
            self.assertNotIn("CATALOG_NOT_LIVE", _codes(report))
            self.assertNotIn("CATALOG_STALE", _codes(report))

    def test_truncated_snapshot_is_incomplete(self):
        with tempfile.TemporaryDirectory() as temp:
            catalog = Path(temp) / "目录快照.json"
            catalog.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-dir-snapshot.v1",
                        "fetched_at": self.now,
                        "complete": True,
                        "truncated": True,
                        "nodes": [{"nodeId": "r", "name": "02-资产类型", "type": "folder"}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = json.loads(run_checker(REPO_ROOT, catalog).stdout)

            self.assertIs(False, report["catalog"]["complete"])

    def test_node_index_by_path_uses_entry_type_for_folder_ness(self):
        with tempfile.TemporaryDirectory() as temp:
            catalog = Path(temp) / "node-index.json"
            catalog.write_text(
                json.dumps(
                    {
                        "schema": "crwu.kb-node-index.v1",
                        "fetched_at": self.now,
                        "byNodeId": {},
                        "byPath": {
                            "02-资产类型": {"nodeId": "r", "type": "folder", "depth": 1},
                            "02-资产类型/01-房地产": {"nodeId": "c", "type": "folder", "depth": 2},
                            "02-资产类型/01-房地产/02-评估审核条目": {
                                "nodeId": "d",
                                "type": "file",
                                "depth": 3,
                            },
                        },
                        "byName": {},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = json.loads(run_checker(REPO_ROOT, catalog, "--max-age-hours", "1").stdout)

            self.assertEqual(
                ["02-资产类型/", "02-资产类型/01-房地产/", "02-资产类型/01-房地产/02-评估审核条目"],
                report["catalog"]["paths"],
            )
            self.assertNotIn("CATALOG_NOT_LIVE", _codes(report))
            # A folder key written without a trailing slash must not become a file.
            self.assertEqual([], _findings(report, "KB_PATH_KEY_HAS_EXPORT_SUFFIX"))

    def test_slash_form_directory_tree_is_parsed(self):
        with tempfile.TemporaryDirectory() as temp:
            catalog = Path(temp) / "目录树.md"
            catalog.write_text(
                textwrap.dedent(
                    f"""\
                    # 中瑞世联评估审核知识库 · 目录树

                    - fetched_at: {self.now}
                    - workspaceId: dN0G7aREV8l6MXWY
                    - 节点 3（folder 2 / doc 1）· 最大深度 3

                    / 02-资产类型
                      / 01-房地产
                        - 02-评估审核条目
                    """
                ),
                encoding="utf-8",
            )

            report = json.loads(run_checker(REPO_ROOT, catalog, "--max-age-hours", "1").stdout)

            self.assertEqual(
                ["02-资产类型/", "02-资产类型/01-房地产/", "02-资产类型/01-房地产/02-评估审核条目"],
                report["catalog"]["paths"],
            )
            self.assertNotIn("CATALOG_NOT_LIVE", _codes(report))


PUBLIC_AXIS_TREE = """
- 📁 01-业务路线/
  - 📁 01-资产经营/
    - 📁 租赁与租金评估/
      - 📄 01-业务通用审核要点
- 📁 02-资产类型/
  - 📁 01-房地产/
    - 📁 01-共性参考/
      - 📄 02-评估审核条目
- 📁 06-规则库/
  - 📁 02-通用准则-报告与披露/
    - 📁 报告准则-精编条目/
      - 📄 报告准则-总则与基本遵循
  - 📁 03-通用准则-程序与档案/
    - 📁 程序准则2026-精编条目/
      - 📄 程序准则2026-第一章总则与第二章基本遵循
""".strip()


def _registry_with_public(public_skill: str, public_status: str = "available") -> str:
    return f"""
    # 多轴技能注册表

    | axis | label | skill | status | load behavior |
    | --- | --- | --- | --- | --- |
    | asset | 房地产 | crwu-audit-asset-realestate | available | load |
    | business | 资产经营 | crwu-audit-biz-asset-operation | available | load |
    | public | 通用准则 | {public_skill} | {public_status} | load always |
    """


def _create_public_skill(repo: Path, name: str, roots, *, frontmatter=None) -> None:
    """Public-axis capability fixture: one entry plus the two standard references.

    Kept Python 3.9 compatible on purpose (this module has no `from __future__ import
    annotations`), so no PEP 604 unions in the signature.
    """
    skill = repo / "skills" / name
    _write(
        skill / "SKILL.md",
        f"""
        ---
        name: {frontmatter or name}
        description: Use when crwu-audit selects the public capability.
        ---

        # {name}
        """,
    )
    _write(skill / "references" / "00-applicability.md", "# Applicability\n")
    root_rows = "\n        ".join(
        f"| KEY{i} | public | 通用准则 | `{root}` | directory | true | true |"
        for i, root in enumerate(roots)
    )
    _write(
        skill / "references" / "01-kb-assembly.md",
        f"""
        # KB assembly

        | source_key | owner_axis | canonical_label | kb_root | request_kind | recursive | required |
        | --- | --- | --- | --- | --- | --- | --- |
        {root_rows}
        """,
    )
    _write(skill / "references" / "02-review-focus.md", "# Review focus\n")


class PublicAxisMappingTest(unittest.TestCase):
    """Public-axis capabilities sit outside the asset/business first-level-root model.

    Regression guard: `audit_rows` filters registry rows by `AXIS_ROOTS`, so before this
    coverage existed an `available` public skill could be missing entirely, or ship without
    its references, and no mapping finding would fire.
    """

    PUBLIC_SKILL = "crwu-audit-public-general-standards"
    PUBLIC_ROOTS = ("06-规则库/02-通用准则-报告与披露/", "06-规则库/03-通用准则-程序与档案/")

    def _repo_with_public_row(self, root: Path) -> Path:
        repo = root / "repo"
        _create_valid_repo(repo)
        _write(
            repo / "skills/crwu-audit/references/07-skill-registry.md",
            _registry_with_public(self.PUBLIC_SKILL),
        )
        return repo

    def _tree(self, root: Path) -> Path:
        tree = root / "tree.md"
        tree.write_text(PUBLIC_AXIS_TREE, encoding="utf-8")
        return tree

    def test_available_public_skill_directory_missing_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = self._repo_with_public_row(root)
            tree = self._tree(root)

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                [self.PUBLIC_SKILL],
                [item["skill"] for item in _findings(report, "AVAILABLE_SKILL_DIRECTORY_MISSING")],
            )

    def test_available_public_skill_requires_a_kb_assembly_table(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = self._repo_with_public_row(root)
            tree = self._tree(root)
            skill = repo / "skills" / self.PUBLIC_SKILL
            _write(
                skill / "SKILL.md",
                f"---\nname: {self.PUBLIC_SKILL}\ndescription: public\n---\n\n# entry\n",
            )
            _write(skill / "references" / "00-applicability.md", "# Applicability\n")

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertNotIn("AVAILABLE_SKILL_DIRECTORY_MISSING", _codes(report))
            self.assertEqual(
                [self.PUBLIC_SKILL],
                [item["skill"] for item in _findings(report, "SKILL_REFERENCE_MISSING")],
            )

    def test_public_skill_cross_cutting_assembly_table_name_is_accepted(self):
        """`crwu-audit-datacheck` ships `00-KB装配表.md`; that naming must not be an error."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = self._repo_with_public_row(root)
            tree = self._tree(root)
            skill = repo / "skills" / self.PUBLIC_SKILL
            _write(
                skill / "SKILL.md",
                f"---\nname: {self.PUBLIC_SKILL}\ndescription: public\n---\n\n# entry\n",
            )
            _write(
                skill / "references" / "00-KB装配表.md",
                "| 需要 | 库内层级路径 |\n| --- | --- |\n"
                "| 规则 | `06-规则库/02-通用准则-报告与披露/` |\n",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                set(),
                _codes(report) & {"SKILL_REFERENCE_MISSING", "AVAILABLE_SKILL_DIRECTORY_MISSING"},
            )

    def test_public_skill_frontmatter_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = self._repo_with_public_row(root)
            tree = self._tree(root)
            _create_public_skill(
                repo,
                self.PUBLIC_SKILL,
                self.PUBLIC_ROOTS,
                frontmatter="crwu-audit-public-something-else",
            )

            report = json.loads(run_checker(repo, tree).stdout)

            mismatches = _findings(report, "SKILL_NAME_MISMATCH")
            self.assertEqual([self.PUBLIC_SKILL], [item["skill"] for item in mismatches])

    def test_public_skill_multi_root_assembly_is_not_forced_into_the_axis_root_model(self):
        """Public assembly keys live under `06-规则库/`；no `02-资产类型/`-style root applies."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = self._repo_with_public_row(root)
            tree = self._tree(root)
            _create_public_skill(repo, self.PUBLIC_SKILL, self.PUBLIC_ROOTS)

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                set(),
                _codes(report)
                & {
                    "ASSEMBLY_FIRST_LEVEL_ROOT_MISSING",
                    "ASSEMBLY_FILE_MAPPING",
                    "AXIS_ROOT_MISMATCH",
                    "AXIS_PREFIX_MISMATCH",
                    "MAPPING_ROOT_NOT_IN_CATALOG",
                    "REGISTRY_LABEL_NOT_IN_CATALOG",
                },
            )

    def test_public_skill_path_keys_are_checked_against_the_catalog(self):
        """`inspect_path_keys` walks every audit-family (crwu-audit*/crwu-dev-audit-*) directory, public axis included."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = self._repo_with_public_row(root)
            tree = self._tree(root)
            _create_public_skill(
                repo,
                self.PUBLIC_SKILL,
                self.PUBLIC_ROOTS + ("06-规则库/99-未收录目录/",),
            )

            report = json.loads(run_checker(repo, tree).stdout)

            self.assertEqual(
                ["06-规则库/99-未收录目录/"],
                [
                    item["path"]
                    for item in _findings(report, "KB_PATH_KEY_NOT_IN_CATALOG")
                ],
            )


class SecondLevelIndexGateTest(unittest.TestCase):
    """CRWU-SKILL-OPT-003：知识库二级对象/子业务必须在父叶子里被**分维度**索引。

    旧实现只在二级目录**缺少** `评估审核条目` / `01-业务通用审核要点` 时报 warning，
    从来不看父叶子有没有索引它 —— 所以"知识库有、父 Skill 没索引"这一整类漏装
    （机器设备/债权 的 8 个细分对象、财务报告的商誉减值）在门禁里完全不可见。
    """

    NOW = "2026-09-26T13:15:34+08:00"

    def _catalog(self, root: Path, paths: list[str]) -> Path:
        by_path = {
            path: {
                "nodeId": f"n{index}",
                "type": "folder" if path.endswith("/") else "file",
                "depth": path.rstrip("/").count("/") + 1,
            }
            for index, path in enumerate(paths)
        }
        catalog = root / "node-index.json"
        catalog.write_text(
            json.dumps(
                {
                    "schema": "crwu.kb-node-index.v1",
                    "fetched_at": self.NOW,
                    "complete": True,
                    "byPath": by_path,
                    "byName": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return catalog

    def _leaf_texts(
        self,
        first_level_root: str,
        children: list[str],
        container: str,
        doc_name: str,
        *,
        classify: bool = True,
        assemble: bool = True,
        review: bool = True,
        common_review: bool = False,
        label_in_assembly: bool = False,
    ) -> tuple[str, str, str]:
        classified, assembled, reviewed, index_rows = [], [], [], []
        shared = (
            f"\n- 一级共用层路径：`{first_level_root}共同审核点`（命中任一子业务都执行）\n"
            if common_review
            else ""
        )
        for child in children:
            child_root = (
                f"{first_level_root}{container}/{child}/" if container else f"{first_level_root}{child}/"
            )
            label = re.sub(r"^\d+[-_、.．]\s*", "", child)
            if classify:
                classified.append(
                    f"| {label} | `{container}/{child}/` | 必须由材料原文确认 | `{doc_name}`（存在） |"
                )
            if assemble:
                assembled.append(f"- `{child_root}`")
            if label_in_assembly:
                relative = f"{container}/{child}/" if container else f"{child}/"
                index_rows.append(f"| {label} | `{relative}{doc_name}` |")
            if review:
                reviewed.append(
                    f"### {label}\n\n库内路径：`{child_root}{doc_name}`；文件已提供且非占位。"
                    "\n共用层先执行，细分层后执行。"
                )
        applicability = "# 适用与边界\n\n| 二级标签 | 相对目录 | 提示信号 | 要点文件 |\n| --- | --- | --- | --- |\n" + "\n".join(
            classified
        ) + ("\n" if classified else "")
        if not classify:
            applicability = "# 适用与边界\n\n（本夹具故意不索引任何二级对象）\n"
        assembly = (
            "# KB 装配\n\n`expected_structure`：\n\n"
            + "\n".join(assembled)
            + "\n\n| source_key | owner_axis | canonical_label | kb_root | request_kind | recursive | required |"
            "\n| --- | --- | --- | --- | --- | --- | --- |\n"
            f"| ROOT | test | test | `{first_level_root}` | directory | true | true |\n"
            + (
                "\n| 二级选择 | 相对路径 |\n| --- | --- |\n" + "\n".join(index_rows) + "\n"
                if index_rows
                else ""
            )
        )
        if not assemble:
            assembly = (
                "# KB 装配\n\n本一级根未逐一登记二级条目。\n\n"
                "| source_key | owner_axis | canonical_label | kb_root | request_kind | recursive | required |"
                "\n| --- | --- | --- | --- | --- | --- | --- |\n"
                f"| ROOT | test | test | `{first_level_root}` | directory | true | true |\n"
            )
        review_text = "# 审核关注点\n\n" + (
            "\n\n".join(reviewed) if review else "（本夹具故意不写任何二级小节）"
        ) + shared + "\n"
        return applicability, assembly, review_text

    def _repo(
        self,
        root: Path,
        *,
        asset_objects: list[str],
        business_subroutes: list[str],
        asset_leaf_texts=None,
        business_leaf_texts=None,
        classified_subroutes: list[str] | None = None,
        registry_status: str = "available",
        classification_text: str | None = None,
    ) -> tuple[Path, list[str]]:
        repo = root / "repo"
        asset_root = "02-资产类型/02-机器设备/"
        business_root = "01-业务路线/03-财务报告/"
        paths = [
            "01-业务路线/",
            business_root,
            f"{business_root}共同审核点",
            "02-资产类型/",
            asset_root,
            f"{asset_root}01-共性参考/",
            f"{asset_root}01-共性参考/01-评估审核条目",
            f"{asset_root}02-细分对象/",
        ]
        for child in asset_objects:
            paths += [f"{asset_root}02-细分对象/{child}/", f"{asset_root}02-细分对象/{child}/评估审核条目"]
        for sub in business_subroutes:
            paths += [f"{business_root}{sub}/", f"{business_root}{sub}/01-业务通用审核要点"]

        _write(
            repo / "skills/crwu-audit/references/07-skill-registry.md",
            "| axis | label | skill | status | load behavior |\n| --- | --- | --- | --- | --- |\n"
            f"| asset | 机器设备 | crwu-audit-asset-equipment | {registry_status} | load |\n"
            f"| business | 财务报告 | crwu-audit-biz-financial-reporting | {registry_status} | load |\n",
        )
        classified = business_subroutes if classified_subroutes is None else classified_subroutes
        _write(
            repo / "skills/crwu-audit/references/03-asset-classification.md",
            "| canonical 资产类型 | 主要信号 | 目标技能 |\n| --- | --- | --- |\n"
            "| 机器设备 | 设备类 | `crwu-audit-asset-equipment` |\n",
        )
        _write(
            repo / "skills/crwu-audit/references/04-business-classification.md",
            classification_text
            if classification_text is not None
            else (
                "| 一级业务 | 目标技能 |\n| --- | --- |\n"
                "| 财务报告 | `crwu-audit-biz-financial-reporting` |\n\n"
                "## 子业务识别\n\n| 一级业务 | 子业务 |\n| --- | --- |\n"
                f"| 财务报告 | {'、'.join(classified)} |\n"
            ),
        )
        _create_router(repo)
        _create_leaf(repo, "crwu-audit-asset-equipment", asset_root)
        _create_leaf(repo, "crwu-audit-biz-financial-reporting", business_root)

        applicability, assembly, review_text = (
            asset_leaf_texts
            if asset_leaf_texts is not None
            else self._leaf_texts(asset_root, asset_objects, "02-细分对象", "评估审核条目")
        )
        for name, text in (
            ("00-applicability.md", applicability),
            ("01-kb-assembly.md", assembly),
            ("02-review-focus.md", review_text),
        ):
            _write(repo / "skills/crwu-audit-asset-equipment/references" / name, text)

        applicability, assembly, review_text = (
            business_leaf_texts
            if business_leaf_texts is not None
            else self._leaf_texts(
                business_root, business_subroutes, "", "01-业务通用审核要点", common_review=True
            )
        )
        for name, text in (
            ("00-applicability.md", applicability),
            ("01-kb-assembly.md", assembly),
            ("02-review-focus.md", review_text),
        ):
            _write(repo / "skills/crwu-audit-biz-financial-reporting/references" / name, text)
        return repo, paths

    def _run(self, root: Path, repo: Path, paths: list[str]) -> dict:
        result = run_checker(repo, self._catalog(root, paths))
        return json.loads(result.stdout)

    ASSET_OBJECTS = ["01-通用设备", "02-专用设备", "03-电子设备", "04-闲置及报废设备"]
    # 门禁报告的 second_level 是 canonical 二级标签（去掉排序前缀），不是库内节点名。
    OBJECT_LABELS = ["通用设备", "专用设备", "电子设备", "闲置及报废设备"]
    BUSINESS_SUBROUTES = ["公允价值计量", "合并对价分摊", "商誉减值", "资产入账", "资产减值测试"]

    def test_asset_subobject_gate_reports_unclassified_object(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(
                root, asset_objects=self.ASSET_OBJECTS, business_subroutes=[]
            )
            texts = self._leaf_texts(
                "02-资产类型/02-机器设备/", self.ASSET_OBJECTS, "02-细分对象", "评估审核条目",
                classify=False,
            )
            for name, text in zip(("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md"), texts):
                _write(repo / "skills/crwu-audit-asset-equipment/references" / name, text)
            report = self._run(root, repo, paths)
            findings = _findings(report, "ASSET_SUBOBJECT_NOT_CLASSIFIED")
            self.assertEqual(
                sorted(self.OBJECT_LABELS), sorted(item["second_level"] for item in findings), findings
            )

    def test_asset_subobject_gate_reports_unassembled_object(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(root, asset_objects=self.ASSET_OBJECTS, business_subroutes=[])
            texts = self._leaf_texts(
                "02-资产类型/02-机器设备/", self.ASSET_OBJECTS, "02-细分对象", "评估审核条目",
                assemble=False,
            )
            for name, text in zip(("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md"), texts):
                _write(repo / "skills/crwu-audit-asset-equipment/references" / name, text)
            report = self._run(root, repo, paths)
            findings = _findings(report, "ASSET_SUBOBJECT_NOT_ASSEMBLED")
            self.assertEqual(
                sorted(self.OBJECT_LABELS), sorted(item["second_level"] for item in findings), findings
            )
            self.assertEqual("error", findings[0]["severity"])

    def test_asset_subobject_gate_reports_unreviewed_object(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(root, asset_objects=self.ASSET_OBJECTS, business_subroutes=[])
            texts = self._leaf_texts(
                "02-资产类型/02-机器设备/", self.ASSET_OBJECTS, "02-细分对象", "评估审核条目",
                review=False,
            )
            for name, text in zip(("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md"), texts):
                _write(repo / "skills/crwu-audit-asset-equipment/references" / name, text)
            report = self._run(root, repo, paths)
            findings = _findings(report, "ASSET_SUBOBJECT_NOT_REVIEWED")
            self.assertEqual(
                sorted(self.OBJECT_LABELS), sorted(item["second_level"] for item in findings), findings
            )

    def test_asset_subobject_gate_reports_stale_absence_claim(self):
        """存在二级对象却仍声称"本一级根未提供 02-细分对象" —— 必须报错。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(root, asset_objects=self.ASSET_OBJECTS, business_subroutes=[])
            _write(
                repo / "skills/crwu-audit-asset-equipment/references/01-kb-assembly.md",
                "# KB 装配\n\n本一级根未提供 `02-细分对象/`；细分对象如需补充，作为父级二级索引扩展。\n"
                "| source_key | kb_root |\n| --- | --- |\n| ROOT | `02-资产类型/02-机器设备/` |\n",
            )
            report = self._run(root, repo, paths)
            self.assertEqual(1, len(_findings(report, "ASSET_SUBOBJECT_ABSENT_CLAIM")))

    def test_business_subroute_gate_reports_all_three_dimensions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(
                root, asset_objects=[], business_subroutes=self.BUSINESS_SUBROUTES
            )
            for kwargs, code in (
                ({"classify": False}, "BUSINESS_SUBROUTE_NOT_CLASSIFIED"),
                ({"assemble": False}, "BUSINESS_SUBROUTE_NOT_ASSEMBLED"),
                ({"review": False}, "BUSINESS_SUBROUTE_NOT_REVIEWED"),
            ):
                texts = self._leaf_texts(
                    "01-业务路线/03-财务报告/", self.BUSINESS_SUBROUTES, "", "01-业务通用审核要点", **kwargs
                )
                for name, text in zip(
                    ("00-applicability.md", "01-kb-assembly.md", "02-review-focus.md"), texts
                ):
                    _write(repo / "skills/crwu-audit-biz-financial-reporting/references" / name, text)
                report = self._run(root, repo, paths)
                self.assertEqual(
                    self.BUSINESS_SUBROUTES,
                    sorted(item["second_level"] for item in _findings(report, code)),
                    code,
                )

    def test_goodwill_impairment_subroute_is_required_individually(self):
        """财务报告 5 个子业务里只漏掉"商誉减值"时，必须精确报出它。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            indexed = [s for s in self.BUSINESS_SUBROUTES if s != "商誉减值"]
            repo, paths = self._repo(
                root,
                asset_objects=[],
                business_subroutes=self.BUSINESS_SUBROUTES,
                business_leaf_texts=self._leaf_texts(
                    "01-业务路线/03-财务报告/", indexed, "", "01-业务通用审核要点"
                ),
            )
            report = self._run(root, repo, paths)
            for code in (
                "BUSINESS_SUBROUTE_NOT_CLASSIFIED",
                "BUSINESS_SUBROUTE_NOT_ASSEMBLED",
                "BUSINESS_SUBROUTE_NOT_REVIEWED",
            ):
                self.assertEqual(
                    ["商誉减值"], [item["second_level"] for item in _findings(report, code)], code
                )

    def test_business_subroute_missing_from_router_classification_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            indexed = [s for s in self.BUSINESS_SUBROUTES if s != "商誉减值"]
            repo, paths = self._repo(
                root,
                asset_objects=[],
                business_subroutes=self.BUSINESS_SUBROUTES,
                classified_subroutes=indexed,
            )
            report = self._run(root, repo, paths)
            findings = _findings(report, "BUSINESS_SUBROUTE_NOT_IN_CLASSIFICATION")
            self.assertEqual(["商誉减值"], [item["second_level"] for item in findings], findings)

    def test_every_second_level_object_is_required_not_just_the_first(self):
        """"首次命中即停止"式实现只索引第一个对象时会漏掉其余 —— 本门禁逐个对象要求。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first_only = self.ASSET_OBJECTS[:1]
            texts = self._leaf_texts(
                "02-资产类型/02-机器设备/", first_only, "02-细分对象", "评估审核条目"
            )
            repo, paths = self._repo(
                root,
                asset_objects=self.ASSET_OBJECTS,
                business_subroutes=[],
                asset_leaf_texts=texts,
            )
            report = self._run(root, repo, paths)
            remaining = sorted(label for label in self.OBJECT_LABELS if label != "通用设备")
            for code in (
                "ASSET_SUBOBJECT_NOT_CLASSIFIED",
                "ASSET_SUBOBJECT_NOT_ASSEMBLED",
                "ASSET_SUBOBJECT_NOT_REVIEWED",
            ):
                self.assertEqual(
                    remaining, sorted(item["second_level"] for item in _findings(report, code)), code
                )
            self.assertEqual(9, len([f for f in report["findings"] if f["severity"] == "error"]))

    def test_second_level_gate_ignores_pending_or_unregistered_parents(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(
                root,
                asset_objects=self.ASSET_OBJECTS,
                business_subroutes=self.BUSINESS_SUBROUTES,
                registry_status="pending",
            )
            report = self._run(root, repo, paths)
            self.assertEqual(
                [],
                [
                    item
                    for item in report["findings"]
                    if item["code"].endswith(("_NOT_CLASSIFIED", "_NOT_ASSEMBLED", "_NOT_REVIEWED"))
                ],
            )

    def test_second_level_gate_accepts_a_fully_indexed_parent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, paths = self._repo(
                root,
                asset_objects=self.ASSET_OBJECTS,
                business_subroutes=self.BUSINESS_SUBROUTES,
            )
            report = self._run(root, repo, paths)
            self.assertEqual([], report["findings"], report["findings"])


    def _business_classification(
        self,
        subroute_cell: str | None = None,
        *,
        row_label: str = "财务报告",
        include_row: bool = True,
        third_col: str = "",
        third_header: str = "目标技能",
        signal_cell: str | None = None,
    ) -> str:
        """构造 `04-business-classification.md`：一级业务表 + 「子业务」小节表。"""
        head = ""
        if signal_cell is not None:
            head = f"| 一级业务 | 命中信号 |\n| --- | --- |\n| {row_label} | {signal_cell} |\n\n"
        sub = f"| 一级业务 | 子业务 | {third_header} |\n| --- | --- | --- |\n"
        if include_row:
            sub += f"| {row_label} | {subroute_cell} | {third_col} |\n"
        return head + "## 子业务识别\n\n" + sub

    @staticmethod
    def _indexed_labels(text: str, labels: tuple[str, ...]) -> list[str]:
        """`labels` 中作为**展示名**出现在索引行（表格行/列表项）里的那些（反引号内容不计）。"""
        found = set()
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if not (
                stripped.startswith(("|", "-", "*", "+")) or re.match(r"^\d+[.)、]\s", stripped)
            ):
                continue
            visible = re.sub(r"`[^`\n]*`", " ", line)
            for label in labels:
                if label in visible:
                    found.add(label)
        return sorted(found)

    def test_classification_dimension_reads_only_applicability(self):
        """分类维度只能来自 `00-applicability.md`；`01-kb-assembly.md` 有标签不能替代。

        否则装配表会替分类表说话，三个维度重新退化成两个维度。
        """
        for axis in ("asset", "business"):
            for label_in_assembly in (True, False):
                with self.subTest(axis=axis, label_in_assembly=label_in_assembly):
                    with tempfile.TemporaryDirectory() as temp:
                        root = Path(temp)
                        if axis == "asset":
                            children, code = self.ASSET_OBJECTS, "ASSET_SUBOBJECT_NOT_CLASSIFIED"
                            texts = self._leaf_texts(
                                "02-资产类型/02-机器设备/", children, "02-细分对象", "评估审核条目",
                                classify=False, label_in_assembly=label_in_assembly,
                            )
                            repo, paths = self._repo(
                                root, asset_objects=children, business_subroutes=[],
                                asset_leaf_texts=texts,
                            )
                        else:
                            children, code = self.BUSINESS_SUBROUTES, "BUSINESS_SUBROUTE_NOT_CLASSIFIED"
                            texts = self._leaf_texts(
                                "01-业务路线/03-财务报告/", children, "", "01-业务通用审核要点",
                                classify=False, label_in_assembly=label_in_assembly,
                                common_review=True,
                            )
                            repo, paths = self._repo(
                                root, asset_objects=[], business_subroutes=children,
                                business_leaf_texts=texts,
                            )
                        report = self._run(root, repo, paths)
                        expected = sorted(
                            self.OBJECT_LABELS if axis == "asset" else self.BUSINESS_SUBROUTES
                        )
                        self.assertEqual(
                            expected,
                            sorted(item["second_level"] for item in _findings(report, code)),
                            code,
                        )
                        # 装配与审核入口在两种情况下都成立 → 只有分类这一个维度报错
                        self.assertEqual(
                            [], _findings(report, code.replace("NOT_CLASSIFIED", "NOT_ASSEMBLED"))
                        )
                        self.assertEqual(
                            [], _findings(report, code.replace("NOT_CLASSIFIED", "NOT_REVIEWED"))
                        )

    def test_subroute_membership_is_exact_not_substring(self):
        """`商誉减值测试` 不得满足 `商誉减值` —— 精确成员判断，禁止子串关系。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for cell in ("商誉减值测试", "`商誉减值测试`", "  商誉减值测试  "):
                with self.subTest(cell=cell):
                    repo, paths = self._repo(
                        root,
                        asset_objects=[],
                        business_subroutes=self.BUSINESS_SUBROUTES,
                        classification_text=self._business_classification(cell),
                    )
                    report = self._run(root, repo, paths)
                    reported = sorted(
                        item["second_level"]
                        for item in _findings(report, "BUSINESS_SUBROUTE_NOT_IN_CLASSIFICATION")
                    )
                    self.assertIn("商誉减值", reported, f"{cell!r} 被当成了已登记")
                    self.assertIn("资产减值测试", reported, f"{cell!r} 被当成了已登记")
                    self.assertEqual(sorted(self.BUSINESS_SUBROUTES), reported)

    def test_missing_parent_row_is_not_silently_skipped(self):
        """「子业务」小节整行缺失父业务时，每个实际知识子业务都要报，不得静默跳过。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for include_row in (False, True):
                with self.subTest(include_row=include_row):
                    repo, paths = self._repo(
                        root,
                        asset_objects=[],
                        business_subroutes=self.BUSINESS_SUBROUTES,
                        classification_text=self._business_classification(
                            "" if include_row else None,
                            row_label="财务报告" if include_row else "交易与处置",
                            include_row=include_row,
                        ),
                    )
                    report = self._run(root, repo, paths)
                    self.assertEqual(
                        sorted(self.BUSINESS_SUBROUTES),
                        sorted(
                            item["second_level"]
                            for item in _findings(report, "BUSINESS_SUBROUTE_NOT_IN_CLASSIFICATION")
                        ),
                    )

    def test_subroute_value_set_parsing_is_exact(self):
        """分隔符 / 反引号 / 空格都不得影响精确成员判断。"""
        labels = self.BUSINESS_SUBROUTES
        ok_cells = {
            "、": "、".join(labels),
            "，": "，".join(labels),
            ",": ",".join(labels),
            "backticked": "、".join(f"`{label}`" for label in labels),
            "padded": " ， ".join(f"  `{label}`  " for label in labels),
        }
        for name, cell in ok_cells.items():
            with self.subTest(separator=name):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    repo, paths = self._repo(
                        root,
                        asset_objects=[],
                        business_subroutes=labels,
                        classification_text=self._business_classification(cell),
                    )
                    report = self._run(root, repo, paths)
                    self.assertEqual(
                        [],
                        _findings(report, "BUSINESS_SUBROUTE_NOT_IN_CLASSIFICATION"),
                        f"{name} 分隔形式未被精确解析",
                    )

    def test_other_columns_do_not_leak_into_the_subroute_value_set(self):
        """`商誉减值` 只出现在命中信号列或目标技能列时，不算已登记。"""
        labels = self.BUSINESS_SUBROUTES
        present = [label for label in labels if label != "商誉减值"]
        cases = {
            "signal_column": dict(
                subroute_cell="、".join(present),
                signal_cell="减值测试、商誉减值测试、商誉减值",
            ),
            "third_column": dict(
                subroute_cell="、".join(present),
                third_col="`crwu-audit-biz-financial-reporting` 商誉减值",
            ),
        }
        for name, kwargs in cases.items():
            with self.subTest(case=name):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    repo, paths = self._repo(
                        root,
                        asset_objects=[],
                        business_subroutes=labels,
                        classification_text=self._business_classification(**kwargs),
                    )
                    report = self._run(root, repo, paths)
                    self.assertEqual(
                        ["商誉减值"],
                        [
                            item["second_level"]
                            for item in _findings(report, "BUSINESS_SUBROUTE_NOT_IN_CLASSIFICATION")
                        ],
                        f"{name} 泄漏进了子业务取值域",
                    )

    def test_real_layer_realestate_registers_its_six_subobjects(self):
        """房地产的 6 个细分对象必须进 `00-applicability.md` 的取值域（不能只在 01/02）。"""
        skill = SKILLS_ROOT / "crwu-audit-asset-realestate"
        if not skill.is_dir():
            self.skipTest("未安装 crwu-audit-asset-realestate：跳过其二级索引检查")
        text = (skill / "references" / "00-applicability.md").read_text(encoding="utf-8")
        labels = (
            "土地使用权",
            "房屋建筑物",
            "构筑物及附着物",
            "在建工程",
            "投资性房地产",
            "租赁权及相关权益",
        )
        self.assertEqual(sorted(labels), self._indexed_labels(text, labels))


CALC_SHEET_TREE = """
- 📁 06-规则库/
  - 📁 M-计算表审核/
    - 📄 00-模块边界与证据规则
    - 📄 03-跨表跨文件勾稽审核
    - 📄 04-单位税率精度与符号审核
    - 📄 09-问题分级与人工复核边界
  - 📁 M-收益法/
    - 📄 04-模块-收益法
  - 📁 M-数据对齐-勾稽与一致性/
    - 📄 03-模块-数据校对
    - 📄 05-模块-基准要素一致性
    - 📄 05-模块-基准要素一致性-扩展
""".strip()

CALC_SHEET_ROOT = "06-规则库/M-计算表审核/"
COMPAT_DATA_PROOFREAD = "06-规则库/M-数据对齐-勾稽与一致性/03-模块-数据校对"
PROTOTYPE_BASELINE_ELEMENTS = "06-规则库/M-数据对齐-勾稽与一致性/05-模块-基准要素一致性"


class CalculationSheetAuthorityTest(unittest.TestCase):
    """CRWU-SKILL-OPT-004：计算表审核的权威装配与原型隔离。

    - F-006：`06-规则库/M-计算表审核/` 是唯一权威计算表口径根，必须被递归装配（带 `/` 的目录键）；
      只写 11 个单文件键会让"库里新增第 12 份"静默掉出清单，所以目录键本身也要被门禁要求。
    - F-007：`05-模块-基准要素一致性` 状态=原型、A 级 RULE 待编 → 必须隔离出运行时。
    - 决策 2：`03-模块-数据校对` 是兼容入口，保留在库内供旧引用使用，但不得进入运行时装配。
    """

    def _run(self, root: Path, repo: Path, tree: Path) -> tuple[dict, int]:
        result = run_checker(repo, tree, "--strict")
        return json.loads(result.stdout), result.returncode

    def _catalog(self, root: Path, text: str = CALC_SHEET_TREE) -> Path:
        tree = root / "tree.md"
        tree.write_text(textwrap.dedent(text).strip(), encoding="utf-8")
        return tree

    def _with_dispatch(self, repo: Path, body: str) -> None:
        _write(
            repo / "skills/crwu-audit/references/08-union-dispatch-rules.md",
            "# 稳定并集\n\n"
            "skills_to_load = stable_unique(scope_skills, asset_skills, business_skills, "
            "method_skills, overlay_skills, public_skills)\n\n"
            "| axis | label | 库内层级路径 |\n| --- | --- | --- |\n" + body,
        )

    def test_authoritative_calculation_root_must_be_assembled(self):
        """F-006：权威根在库内却无任何装配键 → 装配缺口。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            report, code = self._run(root, repo, tree)
            findings = _findings(report, "ASSEMBLY_GAP_METHOD_LAYER")
            self.assertEqual([CALC_SHEET_ROOT], [f["path"] for f in findings], report["findings"])
            self.assertEqual(1, code)

    def test_authoritative_calculation_root_must_use_a_recursive_directory_key(self):
        """只列单文件键不算递归装配：库内新增正文时会静默掉出清单。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo,
                "| method | 计算表审核 | `06-规则库/M-计算表审核/04-单位税率精度与符号审核` |\n",
            )
            report, _ = self._run(root, repo, tree)
            self.assertEqual(
                [CALC_SHEET_ROOT],
                [f["path"] for f in _findings(report, "AUTHORITATIVE_ROOT_NOT_RECURSIVE")],
            )
            # 2026-09-26 (R1) 语义修正：子文件键**不再**算覆盖整个受监视目录 ——
            # 缺口与"不够递归"是两个各自独立成立的判断，此时两者都要报。
            self.assertEqual(
                [CALC_SHEET_ROOT],
                [f["path"] for f in _findings(report, "ASSEMBLY_GAP_METHOD_LAYER")],
            )

    def test_recursive_directory_key_satisfies_the_authoritative_root_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(repo, f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n")
            report, _ = self._run(root, repo, tree)
            self.assertEqual([], _findings(report, "ASSEMBLY_GAP_METHOD_LAYER"))
            self.assertEqual([], _findings(report, "AUTHORITATIVE_ROOT_NOT_RECURSIVE"))

    def test_prototype_baseline_elements_module_must_not_be_assembled(self):
        """F-007：原型模块被装进运行时 → error，且在校准表里标记为已装配。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo, f"| business | 基准要素 | `{PROTOTYPE_BASELINE_ELEMENTS}` |\n"
            )
            report, code = self._run(root, repo, tree)
            findings = _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED")
            self.assertEqual([PROTOTYPE_BASELINE_ELEMENTS], [f["path"] for f in findings])
            self.assertEqual(1, code)
            tracked = {
                item["prefix"]: item
                for item in report["calibration"]["method_layer_assembly"]["nonRuntime"]
            }
            self.assertTrue(tracked[PROTOTYPE_BASELINE_ELEMENTS]["runtimeAssembled"])

    def test_prototype_baseline_elements_module_is_isolated_by_default(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            # 先满足 F-006 的权威根装配要求，才能单独观察原型隔离这一条；
            # 装配了原生文本节点就必须声明下载通道，否则夹具自身会带 EXPORT_CHANNEL_UNDECLARED。
            self._with_dispatch(repo, f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n")
            _declare_download_channel(repo)
            report, code = self._run(root, repo, tree)
            tracked = {
                item["prefix"]: item
                for item in report["calibration"]["method_layer_assembly"]["nonRuntime"]
            }
            self.assertIn(PROTOTYPE_BASELINE_ELEMENTS, tracked)
            item = tracked[PROTOTYPE_BASELINE_ELEMENTS]
            self.assertEqual("prototype/non-runtime", item["classification"])
            self.assertFalse(item["runtimeAssembled"])
            self.assertIn("原型", item["reason"])
            self.assertEqual([], _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED"))
            self.assertEqual(0, code, report["findings"])

    def test_compat_data_proofread_module_must_not_be_assembled(self):
        """决策 2：兼容入口保留在库内，但不得进入 CRWU 运行时装配。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(repo, f"| public | 数据校对 | `{COMPAT_DATA_PROOFREAD}` |\n")
            report, code = self._run(root, repo, tree)
            findings = _findings(report, "COMPAT_MODULE_ASSEMBLED")
            self.assertEqual([COMPAT_DATA_PROOFREAD], [f["path"] for f in findings])
            self.assertEqual(1, code)

    def test_compat_data_proofread_module_is_tracked_when_not_assembled(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(repo, f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n")
            report, _ = self._run(root, repo, tree)
            tracked = {
                item["prefix"]: item
                for item in report["calibration"]["method_layer_assembly"]["nonRuntime"]
            }
            self.assertIn(COMPAT_DATA_PROOFREAD, tracked)
            self.assertEqual("compat-only/non-runtime", tracked[COMPAT_DATA_PROOFREAD]["classification"])
            self.assertFalse(tracked[COMPAT_DATA_PROOFREAD]["runtimeAssembled"])
            self.assertEqual([], _findings(report, "COMPAT_MODULE_ASSEMBLED"))

    def test_ancestor_directory_key_exposes_the_isolated_modules(self):
        """父目录递归装配会把禁用模块一起下进本次审核 —— 必须报，不得因"键不等于前缀"漏报。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo,
                f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n"
                "| public | 数据对齐 | `06-规则库/M-数据对齐-勾稽与一致性/` |\n",
            )
            _declare_download_channel(repo)
            report, code = self._run(root, repo, tree)
            self.assertEqual(
                [COMPAT_DATA_PROOFREAD],
                [f["path"] for f in _findings(report, "COMPAT_MODULE_ASSEMBLED")],
            )
            self.assertEqual(
                [PROTOTYPE_BASELINE_ELEMENTS],
                [f["path"] for f in _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED")],
            )
            self.assertEqual(1, code)

    def test_lookalike_sibling_file_does_not_trigger_isolation(self):
        """`…-扩展` 与 `…` 是两个不同节点：普通字符串前缀不得造成假阳性。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo,
                f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n"
                f"| public | 相似名 | `{PROTOTYPE_BASELINE_ELEMENTS}-扩展` |\n",
            )
            _declare_download_channel(repo)
            report, _ = self._run(root, repo, tree)
            self.assertEqual([], _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED"))
            self.assertEqual([], _findings(report, "COMPAT_MODULE_ASSEMBLED"))

    def test_exact_file_key_still_triggers_isolation(self):
        """对照：写的就是原型模块本身（精确文件键）→ 照常报错。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo,
                f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n"
                f"| public | 原型 | `{PROTOTYPE_BASELINE_ELEMENTS}` |\n",
            )
            _declare_download_channel(repo)
            report, _ = self._run(root, repo, tree)
            self.assertEqual(
                [PROTOTYPE_BASELINE_ELEMENTS],
                [f["path"] for f in _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED")],
            )

    def test_child_file_key_does_not_cover_the_watched_directory(self):
        """只装目录内一个子文件 ≠ 覆盖整个受监视目录：缺口与"不够递归"要同时报。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo,
                "| method | 计算表审核 | "
                f"`{CALC_SHEET_ROOT}00-模块边界与证据规则` |\n",
            )
            _declare_download_channel(repo)
            report, _ = self._run(root, repo, tree)
            self.assertEqual(
                [CALC_SHEET_ROOT], [f["path"] for f in _findings(report, "ASSEMBLY_GAP_METHOD_LAYER")]
            )
            self.assertEqual(
                [CALC_SHEET_ROOT],
                [f["path"] for f in _findings(report, "AUTHORITATIVE_ROOT_NOT_RECURSIVE")],
            )

    def test_coarse_ancestor_directory_does_not_satisfy_the_authoritative_root(self):
        """权威根必须有**它自己**的目录键：过粗祖先（`06-规则库/`）不能替代。

        祖先目录确实把内容带进了清单（所以不报装配缺口），但那不等于"本根被显式递归装配"——
        它会顺带把整个规则库（含禁用模块）拖进本次审核，必须报"不够递归"。
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(repo, "| public | 规则库 | `06-规则库/` |\n")
            _declare_download_channel(repo)
            report, code = self._run(root, repo, tree)
            self.assertEqual(
                [CALC_SHEET_ROOT],
                [f["path"] for f in _findings(report, "AUTHORITATIVE_ROOT_NOT_RECURSIVE")],
            )
            # 祖先目录把内容带进了清单 → 内容并非无人装配
            self.assertEqual([], _findings(report, "ASSEMBLY_GAP_METHOD_LAYER"))
            # 而"顺带拖进禁用模块"必须同时报出来（父目录递归）——夹具目录里存在几个就报几个
            isolated = sorted(
                f["path"]
                for f in report["findings"]
                if f["code"] in ("COMPAT_MODULE_ASSEMBLED", "NON_RUNTIME_MODULE_ASSEMBLED")
            )
            self.assertEqual(
                sorted([COMPAT_DATA_PROOFREAD, PROTOTYPE_BASELINE_ELEMENTS, "06-规则库/M-收益法/"]),
                isolated,
                "过粗祖先把禁用模块一并纳入，必须逐个报隔离码",
            )
            self.assertEqual(1, code)

    def test_child_file_of_a_directory_module_is_a_partial_leak(self):
        """目录型 non-runtime 模块：其**任意子文件**进运行时都算部分泄漏。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            tree = self._catalog(root)
            _create_valid_repo(repo)
            self._with_dispatch(
                repo,
                f"| method | 计算表审核 | `{CALC_SHEET_ROOT}` |\n"
                "| method | 收益法模块 | `06-规则库/M-收益法/04-模块-收益法` |\n",
            )
            _declare_download_channel(repo)
            report, _ = self._run(root, repo, tree)
            self.assertEqual(
                ["06-规则库/M-收益法/"],
                [f["path"] for f in _findings(report, "NON_RUNTIME_MODULE_ASSEMBLED")],
            )

    # ---- 真实层回归 ----

    @_requires_skill_tree
    def test_real_layer_datacheck_assembles_the_authoritative_calculation_root(self):
        assembly = skill_path("crwu-audit-datacheck/references/00-KB装配表.md")
        self.assertTrue(assembly.is_file(), assembly)
        text = assembly.read_text(encoding="utf-8")
        self.assertIn(f"`{CALC_SHEET_ROOT}`", text, "datacheck 必须递归装配权威计算表口径根")
        for forbidden in (COMPAT_DATA_PROOFREAD, PROTOTYPE_BASELINE_ELEMENTS):
            self.assertNotIn(forbidden, text, f"{forbidden} 不得进入运行时装配")

    @_requires_skill_tree
    def test_real_layer_datacheck_prose_points_at_the_authoritative_root(self):
        skill = skill_path("crwu-audit-datacheck/SKILL.md")
        self.assertTrue(skill.is_file(), skill)
        text = skill.read_text(encoding="utf-8")
        self.assertIn("M-计算表审核", text)
        # 禁止的是**旧库内路径（寻址键）**被当成口径来源；把"已退出运行时"的短名写进说明句是允许的。
        self.assertNotIn("06-规则库/M-数据对齐-勾稽与一致性", text, "datacheck 正文仍指向旧装配路径")
        self.assertIn("不进入运行时装配", text, "必须显式说明兼容入口/原型模块已退出运行时")

    @_requires_skill_tree
    def test_real_layer_leaf_contract_points_at_the_authoritative_root(self):
        contract = skill_path("crwu-audit/references/12-leaf-common-contract.md")
        self.assertTrue(contract.is_file(), contract)
        text = contract.read_text(encoding="utf-8")
        self.assertIn("M-计算表审核", text, "公共契约的勾稽/符号口径必须指向权威根")
        self.assertNotIn(COMPAT_DATA_PROOFREAD, text, "公共契约不得再把兼容入口当运行时口径来源")



# ---- OPT-004-R3：缓存选择（自动遍历 / 显式覆盖）与 C8/C9 结论边界 ----

_CHECKER_FOR_FIXTURES = None


def _checker_for_fixtures():
    """加载 checker **只为复用它的路径解析器**构造夹具（判定仍由被测的缓存选择逻辑做）。"""
    global _CHECKER_FOR_FIXTURES
    if _CHECKER_FOR_FIXTURES is None:
        spec = importlib.util.spec_from_file_location("checker_for_fixtures", CHECKER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _CHECKER_FOR_FIXTURES = module
    return _CHECKER_FOR_FIXTURES


def _repo_referenced_keys() -> set[str]:
    """本仓文档里**真实出现**的库内寻址键（不含后面为夹具补的顶层容器）。"""
    module = _checker_for_fixtures()
    documents, containers = _repo_documents()
    top = {name: "folder" for name in containers}
    keys: set[str] = set()
    for document in documents:
        keys.update(module._addressing_keys(document.read_text(encoding="utf-8"), top))
    return keys


def _repo_documents():
    documents = []
    token_re = re.compile(r"`([^`\n]+)`")
    containers: set[str] = set()
    for layer in (SKILLS_ROOT, Path(__file__).resolve().parents[4] / "common" / "skills"):
        if not layer.is_dir():
            continue
        for skill in sorted(layer.iterdir()):
            if not skill.is_dir() or not skill.name.startswith("crwu-"):
                continue
            documents.extend(sorted(skill.rglob("*.md")))
    for document in documents:
        for token in token_re.findall(document.read_text(encoding="utf-8")):
            token = token.strip()
            if not token or "/" not in token:
                continue
            head = token.split("/")[0]
            if re.match(r"^\d\d-", head) and " " not in head:
                containers.add(head)
    return documents, containers


def _repo_address_keys() -> set[str]:
    """夹具用的完整键集合（真实引用键 + 顶层容器），**完整由构造保证**。

    做法：先扫出所有"像库内路径"的反引号 token 的**首段**作为顶层容器，再把这些容器交给 checker 的
    `_addressing_keys` 复扫一遍 —— 于是夹具目录恰好等于 checker 会校验的键集合，不会因为夹具缺键而
    把"完整候选"误判成漂移。（正因如此，**"漂移必须失败"由手工构造的独立夹具证明**，见
    `test_key_syntax_drift_in_a_stale_candidate_still_fails`，不依赖这里。）
    """
    module = _checker_for_fixtures()
    documents = []
    for layer in (SKILLS_ROOT, Path(__file__).resolve().parents[4] / "common" / "skills"):
        if not layer.is_dir():
            continue
        for skill in sorted(layer.iterdir()):
            if not skill.is_dir() or not skill.name.startswith("crwu-"):
                continue
            documents.extend(sorted(skill.rglob("*.md")))
    token_re = re.compile(r"`([^`\n]+)`")
    containers: set[str] = set()
    for document in documents:
        for token in token_re.findall(document.read_text(encoding="utf-8")):
            token = token.strip()
            if not token or "/" not in token:
                continue
            head = token.split("/")[0]
            if re.match(r"^\d\d-", head) and " " not in head:
                containers.add(head)
    top = {name: "folder" for name in containers}
    keys: set[str] = set()
    for document in documents:
        keys.update(module._addressing_keys(document.read_text(encoding="utf-8"), top))
    keys.update(f"{name}/" for name in containers)
    return keys


def _write_node_index(path: Path, keys: set[str], *, fetched_at: str = "2026-09-26T13:15:34+08:00") -> Path:
    by_path = {}
    for key in keys:
        node = key.rstrip("/")
        if not node:
            continue
        by_path[node] = {"type": "folder" if key.endswith("/") else "file"}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema": "crwu.kb-node-index.v1",
                "fetched_at": fetched_at,
                "complete": True,
                "byPath": by_path,
                "byName": {},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def _cache_dir(
    root: Path,
    name: str,
    *,
    capture_time: str,
    keys: set[str],
    form: str = "目录快照.json",
    space: str = AUDIT_KB_NAME,
) -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / ".cache-meta.json").write_text(
        json.dumps({"space": {"name": space}, "last_successful_at": capture_time}, ensure_ascii=False),
        encoding="utf-8",
    )
    _write_node_index(directory / form, keys)
    return directory


def _drop_new_root(keys: set[str]) -> set[str]:
    return {key for key in keys if not key.startswith(_AUTHORITATIVE_CALC_SHEET_ROOT)}


class CacheSelectionTest(unittest.TestCase):
    """OPT-004-R3：自动缓存候选必须继续遍历；显式覆盖必须严格失败。"""

    @classmethod
    def setUpClass(cls):
        cls.keys = _repo_address_keys()
        cls.drop_new_root = _drop_new_root(cls.keys)
        cls.referenced = _repo_referenced_keys()
        # 漂移目标必须是**多段**键：删掉 `head/` 这种裸容器会同时让该顶层容器从目录里消失，
        # 于是 checker 按"只判本次目录真正捕获过的容器"跳过它、什么也不报 —— 那不是漂移被掩盖，
        # 而是夹具构造错误。多段键被删后 `head/` 仍在，才能真正触发 KB_PATH_KEY_NOT_IN_CATALOG。
        cls.outside = sorted(
            key
            for key in cls.referenced
            if not key.startswith(_AUTHORITATIVE_CALC_SHEET_ROOT)
            and key.rstrip("/").count("/") >= 1
        )
        assert len(cls.keys) > 10 and len(cls.outside) > 1

    def _candidates(self, root: Path, specs) -> list:
        return [
            _cache_candidate(path=_cache_dir(root, name, capture_time=ts, keys=keys), source=source)
            for name, ts, keys, source in specs
        ]

    # ---- 自动模式 ----

    def test_auto_cache_candidates_are_newest_first_and_continue_past_a_stale_one(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # 按抓取时间新→旧：**过期候选在前**，完整候选在后 —— 才检验"续查"
            _cache_dir(root, "stale-first", capture_time="2026-09-26T13:15:34+08:00", keys=self.drop_new_root)
            _cache_dir(root, "complete-second", capture_time="2026-09-19T22:44:21+08:00", keys=self.keys)
            with mock.patch.object(
                sys.modules[__name__], "DWS_CACHE_ROOT", root
            ):
                mode, candidates = _cache_candidates()
            self.assertEqual(CACHE_MODE_AUTO, mode)
            self.assertEqual(
                ["stale-first", "complete-second"],
                [c.path.name for c in candidates],
                "必须按抓取时间新→旧",
            )

            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("ok", verdict["status"], verdict["message"])
            self.assertEqual(2, len(verdict["checked"]), "第一个过期候选不得提前结束遍历")

    def test_all_stale_auto_candidates_aggregate_into_a_single_skip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _cache_dir(root, "old", capture_time="2026-09-19T22:44:21+08:00", keys=self.drop_new_root)
            _cache_dir(root, "older", capture_time="2026-09-01T10:00:00+08:00", keys=self.drop_new_root)
            with mock.patch.object(sys.modules[__name__], "DWS_CACHE_ROOT", root):
                mode, candidates = _cache_candidates()
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("stale", verdict["status"], verdict["message"])
            self.assertEqual(2, len(verdict["checked"]), "必须在全部候选检查完后才聚合 skip")
            self.assertIn("old", verdict["message"])
            self.assertIn("older", verdict["message"])
            self.assertIn(_AUTHORITATIVE_CALC_SHEET_ROOT, verdict["message"])

    def _stale_and_valid(self, root: Path, *, newer_keys, older_keys, newer="newer", older="older"):
        _cache_dir(root, newer, capture_time="2026-09-26T13:15:34+08:00", keys=newer_keys)
        _cache_dir(root, older, capture_time="2026-09-19T22:44:21+08:00", keys=older_keys)
        with mock.patch.object(sys.modules[__name__], "DWS_CACHE_ROOT", root):
            return _cache_candidates()

    def test_stale_newer_then_valid_older_selects_the_valid_one(self):
        """`stale newer + valid older` → ok，且两个候选都被实际评估过。"""
        with tempfile.TemporaryDirectory() as temp:
            mode, candidates = self._stale_and_valid(
                Path(temp), newer_keys=self.drop_new_root, older_keys=self.keys
            )
            self.assertEqual(CACHE_MODE_AUTO, mode)
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("ok", verdict["status"], verdict["message"])
            self.assertEqual(2, len(verdict["checked"]), "必须先看过期的、再继续到完整的")

    def test_drift_newer_is_not_masked_by_a_valid_older_candidate(self):
        """`drift newer + valid older` → fail：成功选中之前被评估到的漂移不得被后续有效候选掩盖。"""
        with tempfile.TemporaryDirectory() as temp:
            drifted = set(self.keys) - {self.outside[0]}
            mode, candidates = self._stale_and_valid(
                Path(temp), newer_keys=drifted, older_keys=self.keys
            )
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("fail", verdict["status"], verdict["message"])
            self.assertIn(self.outside[0], verdict["message"])

    def test_valid_newer_stops_and_older_drift_does_not_pollute(self):
        """`valid newer + drift older` → ok，且只检查了最新那个：更老的漂移不得污染结果。"""
        with tempfile.TemporaryDirectory() as temp:
            drifted = set(self.keys) - {self.outside[0]}
            mode, candidates = self._stale_and_valid(
                Path(temp), newer_keys=self.keys, older_keys=drifted
            )
            self.assertEqual(["newer", "older"], [c.path.name for c in candidates])
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("ok", verdict["status"], verdict["message"])
            self.assertEqual(1, len(verdict["checked"]), "命中完整有效候选后必须停止，不再看更老的缓存")
            self.assertNotIn(self.outside[0], verdict["message"])

    def test_key_syntax_drift_in_a_stale_candidate_still_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            _create_valid_repo(repo)
            keys = {"01-业务路线/", "02-资产类型/", "02-资产类型/01-房地产/"}
            _write(
                repo / "skills/crwu-audit-asset-realestate/references/01-kb-assembly.md",
                "| source_key | kb_root |\n| --- | --- |\n"
                "| ROOT | `02-资产类型/01-房地产/` |\n"
                "| BAD | `02-资产类型/01-房地产/01-共性参考/评估审核条目.md` |\n",
            )
            keys.add("02-资产类型/01-房地产/01-共性参考/评估审核条目")
            cache = Path(temp) / "cache"
            cache.mkdir()
            _write_node_index(cache / "目录快照.json", keys)
            verdict = evaluate_library_path_keys(
                [_cache_candidate(path=cache, source=CACHE_MODE_DIR)],
                CACHE_MODE_DIR,
                repo=repo,
                allowed_roots=("06-规则库/M-计算表审核/",),
            )
            self.assertEqual("fail", verdict["status"], verdict["message"])
            self.assertIn("KB_PATH_KEY", verdict["message"])

    # ---- 显式缓存目录 ----

    def test_explicit_cache_dir_fresh_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = _cache_dir(Path(temp), "fresh", capture_time="2026-09-26T13:15:34+08:00", keys=self.keys)
            with mock.patch.dict(os.environ, {"CRWU_DWS_CACHE_DIR": str(cache)}, clear=False):
                mode, candidates = _cache_candidates()
            self.assertEqual(CACHE_MODE_DIR, mode)
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("ok", verdict["status"], verdict["message"])

    def test_explicit_cache_dir_stale_fails_without_skipping(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = _cache_dir(Path(temp), "stale", capture_time="2026-09-19T22:44:21+08:00", keys=self.drop_new_root)
            with mock.patch.dict(os.environ, {"CRWU_DWS_CACHE_DIR": str(cache)}, clear=False):
                mode, candidates = _cache_candidates()
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("fail", verdict["status"], "显式覆盖过期必须失败，不得 skip")
            self.assertIn(_AUTHORITATIVE_CALC_SHEET_ROOT, verdict["message"])

    def test_explicit_cache_dir_invalid_fails(self):
        for label, cache in (("missing", None), ("wrong-kb", "wrong"), ("empty", "empty")):
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    if cache is None:
                        target = root / "nope"
                    elif cache == "wrong":
                        target = _cache_dir(root, "wrong", capture_time="2026-09-26T13:15:34+08:00",
                                            keys={"07-其他/", "07-其他/README"}, space="别的知识库")
                    else:
                        target = root / "empty"
                        target.mkdir()
                    with mock.patch.dict(os.environ, {"CRWU_DWS_CACHE_DIR": str(target)}, clear=False):
                        mode, candidates = _cache_candidates()
                    verdict = evaluate_library_path_keys(candidates, mode)
                    self.assertEqual("fail", verdict["status"], verdict["message"])

    # ---- 显式 snapshot 文件 ----

    def test_explicit_snapshot_uses_the_exact_file(self):
        """显式 snapshot 必须用**传入的那个文件**，不得偷偷换成同目录的 `目录快照.json`。"""
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "cache"
            directory.mkdir()
            (directory / ".cache-meta.json").write_text(
                json.dumps({"space": {"name": AUDIT_KB_NAME}, "last_successful_at": "2026-09-19T22:44:21+08:00"}),
                encoding="utf-8",
            )
            # 同目录里放一个**缺新根**的目录快照，和一个**完整**的 node-index
            _write_node_index(directory / "目录快照.json", self.drop_new_root)
            exact = _write_node_index(directory / "node-index.json", self.keys)

            with mock.patch.dict(os.environ, {"CRWU_DWS_SNAPSHOT": str(exact)}, clear=False):
                mode, candidates = _cache_candidates()
            self.assertEqual(CACHE_MODE_SNAPSHOT, mode)
            self.assertEqual([exact], [c.catalog for c in candidates], "必须解析到传入的精确文件")
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("ok", verdict["status"], verdict["message"])

    def test_explicit_snapshot_stale_fails_without_skipping(self):
        with tempfile.TemporaryDirectory() as temp:
            stale = _write_node_index(Path(temp) / "stale.json", self.drop_new_root)
            with mock.patch.dict(os.environ, {"CRWU_DWS_SNAPSHOT": str(stale)}, clear=False):
                mode, candidates = _cache_candidates()
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual("fail", verdict["status"], "显式 snapshot 过期必须失败，不得 skip")

    def test_explicit_snapshot_invalid_fails(self):
        for label in ("missing", "unparsable", "wrong-kb"):
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    if label == "missing":
                        target = root / "nope.json"
                    elif label == "unparsable":
                        target = root / "broken.json"
                        target.write_text("{ this is not json", encoding="utf-8")
                    else:
                        target = _write_node_index(root / "other.json", {"07-其他/", "07-其他/README"})
                    with mock.patch.dict(os.environ, {"CRWU_DWS_SNAPSHOT": str(target)}, clear=False):
                        mode, candidates = _cache_candidates()
                    verdict = evaluate_library_path_keys(candidates, mode)
                    self.assertEqual("fail", verdict["status"], verdict["message"])


class C9SignRegimeTest(unittest.TestCase):
    """OPT-004-R4：C9 必须**先选口径、再套对应公式**，不得把有符号公式当成无条件前置。

    库内原文（只读核对）：C13 的可重算关系列 `增值率 = 增减值 ÷ 账面值`，但其**失败条件**是
    「…或出现『减值时增值率为负』**而报告采用正数表示减值的口径**」——即该公式属**有符号口径**，
    而不是所有口径的前置恒等式；C21 只规定"全表与报告口径一致"。
    """

    @staticmethod
    def _region(text: str, start: str, stop: str) -> str:
        begin = text.find(start)
        assert begin >= 0, f"缺少锚点：{start}"
        finish = text.find(stop, begin)
        return text[begin : finish if finish > begin else len(text)]

    @staticmethod
    def _parts(region: str) -> dict:
        positions = []
        for marker in ("有符号", "正数幅度", "无法确认"):
            found = region.find(marker)
            if found < 0:
                return {}
            positions.append(found)
        if positions != sorted(positions):
            return {}
        a, b, c = positions
        return {"preamble": region[:a], "A": region[a:b], "B": region[b:c], "C": region[c:]}

    def _skill_c9(self) -> dict:
        # OPT-009B：C9 与步骤 4 的正文已下沉到 references/01-runtime-and-check-catalog.md，
        # 段落提取改在组合契约文本上进行（章节锚点在 01 中保持不变）。
        text = datacheck_contract_text()
        region = self._region(text, "C9 增减值", "4. **输出差异清单**")
        return self._parts(region)

    def _contract_c9(self) -> dict:
        text = skill_path("crwu-audit/references/12-leaf-common-contract.md").read_text(
            encoding="utf-8"
        )
        region = self._region(text, "增减值与增值率自洽", "\n\n")
        return self._parts(region)

    def test_signed_formula_lives_only_inside_regime_a(self):
        """`增值率 = 增减值 ÷ 账面价值` 只能出现在口径 A 里，不得作为 A/B/C 之前的无条件公式。"""
        for label, parts in (("SKILL.md", self._skill_c9()), ("12-leaf-common-contract.md", self._contract_c9())):
            with self.subTest(document=label):
                self.assertTrue(parts, "三种口径标记不全")
                self.assertNotIn(
                    "增值率 = 增减值 ÷",
                    parts["preamble"],
                    f"{label}: 有符号公式不得出现在口径分支之前",
                )
                self.assertIn("增值率 = 增减值 ÷", parts["A"])

    def test_positive_amplitude_regime_has_its_own_formula(self):
        """口径 B 用幅度公式，且**不得要求幅度与增减值同号**。"""
        for label, parts in (("SKILL.md", self._skill_c9()), ("12-leaf-common-contract.md", self._contract_c9())):
            with self.subTest(document=label):
                self.assertTrue(parts, "三种口径标记不全")
                self.assertTrue(
                    ("账面价值 − 评估价值" in parts["B"]) or ("abs(" in parts["B"]),
                    f"{label}: 口径 B 必须写自己的幅度公式",
                )
                self.assertIn("不得要求", parts["B"], f"{label}: 口径 B 必须明确不要求同号")
                self.assertIn("同号", parts["B"])

    def test_unconfirmed_regime_draws_no_conclusion(self):
        for label, parts in (("SKILL.md", self._skill_c9()), ("12-leaf-common-contract.md", self._contract_c9())):
            with self.subTest(document=label):
                self.assertIn("capability gap", parts["C"])
                self.assertIn("pending_verification", parts["C"])
                self.assertTrue(
                    any(token in parts["C"] for token in ("不下结论", "不作判断", "不得直接判")),
                    f"{label}: 口径 C 必须写明不下结论",
                )

    def test_preamble_keeps_only_unconditional_rules(self):
        """前置只允许：增减值恒等式、账面价值为 0 不得计算比率、账面价值为负/特殊且无说明转人工。"""
        for label, parts in (("SKILL.md", self._skill_c9()), ("12-leaf-common-contract.md", self._contract_c9())):
            with self.subTest(document=label):
                pre = parts["preamble"]
                self.assertIn("增减值 = 评估价值 − 账面价值", pre)
                self.assertIn("不得计算比率", pre)
                self.assertIn("账面价值为负", pre)
                self.assertIn("pending_verification", pre)

    def test_twenty_copies_carry_the_same_regime_structure(self):
        """20 份本地副本不得保留旧的无条件写法（与规范源逐字节一致，由同步工具保证）。"""
        spec = skill_path("crwu-audit/references/12-leaf-common-contract.md").read_text(encoding="utf-8")
        copies = sorted(SKILLS_ROOT.glob("*/references/03-common-contract.md"))
        self.assertEqual(20, len(copies))
        for copy in copies:
            with self.subTest(copy=copy.parent.parent.name):
                text = copy.read_text(encoding="utf-8")
                self.assertEqual(spec, text, "副本必须与规范源逐字节一致")
                self.assertNotIn('减值不得出现"负增值率"式表述', text)


class BackupBoundaryTest(unittest.TestCase):
    """OPT-004-R4：备份目录判定必须是精确名称前缀，不能因为含 `.bak` 子串就排除。"""

    def _root_with(self, temp: str, names) -> Path:
        root = Path(temp)
        for name in names:
            entry = root / name
            entry.mkdir(parents=True, exist_ok=True)
            (entry / ".cache-meta.json").write_text(
                json.dumps({"space": {"name": AUDIT_KB_NAME}, "last_successful_at": "2026-09-26T13:15:34+08:00"}),
                encoding="utf-8",
            )
        return root

    def test_backup_boundary_is_the_exact_name_prefix(self):
        importlib_module = _checker_for_fixtures()
        names = [
            f"{AUDIT_KB_NAME}.bak-2026-09-18T155832+0800",
            f"{AUDIT_KB_NAME}.bakery",
            f"{AUDIT_KB_NAME}.bak",
            "别的知识库.bak-2026-09-18T155832+0800",
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = self._root_with(temp, names)
            excluded, kept = [], []
            for name in names:
                (excluded if _is_backup_cache_dir(root / name) else kept).append(name)
            self.assertEqual([names[0]], excluded, "只应排除 `<知识库名>.bak-<时间戳>`")
            self.assertEqual(names[1:], kept, ".bakery / .bak / 其它知识库的备份都不得被排除")

            with mock.patch.object(sys.modules[__name__], "DWS_CACHE_ROOT", root):
                reported = _excluded_backup_dirs()
            self.assertEqual([names[0]], reported, "排除消息里不得出现其它知识库的备份")

    def test_backup_dirs_are_not_candidates_but_explicit_stays_strict(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self._root_with(temp, [f"{AUDIT_KB_NAME}.bak-2026-09-18T155832+0800"])
            with mock.patch.object(sys.modules[__name__], "DWS_CACHE_ROOT", root):
                _mode, candidates = _cache_candidates()
            self.assertEqual([], candidates, "备份目录不得进入自动候选")

            backup = root / f"{AUDIT_KB_NAME}.bak-2026-09-18T155832+0800"
            _write_node_index(backup / "目录快照.json", {"07-其他/", "07-其他/README"})
            with mock.patch.dict(os.environ, {"CRWU_DWS_CACHE_DIR": str(backup)}, clear=False):
                mode, candidates = _cache_candidates()
            verdict = evaluate_library_path_keys(candidates, mode)
            self.assertEqual(CACHE_MODE_DIR, mode)
            self.assertEqual("fail", verdict["status"], "显式指向备份仍须严格判失败")


class ConclusionBoundaryTest(unittest.TestCase):
    """OPT-004-R3：C8 无权威口径不得越权下"不符合"；C9 必须条件化符号口径。"""

    @_requires_skill_tree
    def test_c8_has_no_authoritative_criterion_and_stays_observational(self):
        # OPT-009B：C8 细则是运行时/检查细节，已下沉到 01；断言读组合契约文本。
        text = datacheck_contract_text()
        self.assertNotIn(
            "判 `不符合` 须给单元格坐标与在件值",
            text,
            "C8 缺项不得直接判「不符合」",
        )
        start = text.find("C8 表单要素完整性")
        self.assertGreater(start, 0)
        section = text[start : start + 2000]
        self.assertIn("capability gap", section)
        self.assertIn("pending_verification", section)

    @_requires_skill_tree
    def test_c9_states_the_three_sign_regimes(self):
        # OPT-009B：三种符号口径属运行时/检查细节，已下沉到 01；断言读组合契约文本。
        text = datacheck_contract_text()
        self.assertNotIn("负增值率", text.replace("负增值率本身不是错误", ""), "不得无条件把负增值率当错误")
        for token in ("有符号", "正数幅度", "capability gap", "pending_verification"):
            self.assertIn(token, text, f"C9 必须写明 {token} 口径")
        self.assertIn("C21", text)
        self.assertIn("C13", text)

    @_requires_skill_tree
    def test_public_contract_has_conditional_sign_semantics(self):
        contract = skill_path("crwu-audit/references/12-leaf-common-contract.md")
        text = contract.read_text(encoding="utf-8")
        self.assertNotIn(
            '减值不得出现"负增值率"式表述',
            text,
            "公共契约不得保留「负增值率天然错误」的无条件表述",
        )
        self.assertIn("C13", text)
        self.assertIn("C21", text)


class H0SingleSourceTest(unittest.TestCase):
    """OPT-005：H0 规范**唯一权威** = `12-leaf-common-contract.md §7.1`。

    00 只是**机制 owner**（隔离实现），datacheck 只留最小安全铁律，router/维护文档只回指。
    本用例**不**禁止「H0」「隐藏区」这些词 —— 必要安全提醒与实现说明必须允许存在；被禁止的是
    **再定义一份定级/去向规范**（三档表、S3、是否计入 fail、H1 完整授权条件）。
    """

    AUTHORITY = "crwu-audit/references/12-leaf-common-contract.md"
    MECHANISM = "crwu-audit/references/00-input-and-route-profile.md"
    CONSUMERS = (
        "crwu-audit/SKILL.md",
        "crwu-audit/references/00-input-and-route-profile.md",
        "crwu-audit/references/99-maintenance.md",
        "crwu-audit-datacheck/SKILL.md",
        "crwu-audit-datacheck/references/00-KB装配表.md",
        # OPT-009B-R1：datacheck 的运行时/检查目录 reference 同样是 H0 消费者 —— 否则把
        # 隐藏区定级/去向裁定写进 reference 不会变红（回归孔）。它只接受"不得出现第二份
        # S3 定级 / 三档状态表 / 隐藏区自带去向裁定"这套既有判据，不另立判据。
        DATACHECK_REFERENCE,
    )

    def _text(self, rel: str) -> str:
        return skill_path(rel).read_text(encoding="utf-8")

    def test_authority_carries_the_only_grading_norm(self):
        authority = self._text(self.AUTHORITY)
        for token in ("S3（最低等级）", "pending_confirmation", "manualConfirmationItems", "| 情形 |"):
            self.assertIn(token, authority, f"规范源必须保留 {token}")
        for rel in self.CONSUMERS:
            text = self._text(rel)
            self.assertNotIn("S3（最低等级）", text, f"{rel} 不得再独立定义 H0 定级")
            self.assertNotIn("| 定级 |", text, f"{rel} 不得再复制一份三档状态表")
            # 只禁止「隐藏区自带定级/去向裁定」，不禁止字段名本身：`manualConfirmationItems[]`
            # 作为**交付字段名**出现在与隐藏区无关的语境（如"法律适用存疑"）是合法的。
            # 粒度：所有消费方按**行**判；机制 owner（00）另按**段落**判 —— 它的隐藏区规范原本
            # 就是一整段，只按行会漏掉"跨行的去向说明"。
            for line in text.splitlines():
                if "隐藏" not in line:
                    continue
                for token in ("S3", "不计入", "不进意见", "不作为 AI 问题",
                              "review_required=true", "manualConfirmationItems"):
                    self.assertNotIn(token, line, f"{rel}: 隐藏区行不得自带定级/去向裁定")
            if rel == self.MECHANISM:
                for paragraph in re.split(r"\n\s*\n", text):
                    if "隐藏" not in paragraph:
                        continue
                    for token in ("S3", "不计入", "不进意见", "不作为 AI 问题",
                                  "review_required=true", "manualConfirmationItems"):
                        self.assertNotIn(
                            token, paragraph,
                            f"{rel}: 隐藏区段落不得自带定级/去向裁定，应回指 12 §7.1",
                        )

    def test_datacheck_anchors_hidden_region_handling_to_the_authority(self):
        text = self._text("crwu-audit-datacheck/SKILL.md")
        self.assertIn("12-leaf-common-contract.md", text)
        self.assertIn("§7.1", text)

    def test_mechanism_owner_declares_itself_and_points_to_the_authority(self):
        text = self._text(self.MECHANISM)
        self.assertIn("机制 owner", text)
        self.assertIn("12-leaf-common-contract.md", text)
        self.assertIn("§7.1", text)

    def test_router_points_to_both_mechanism_and_authority(self):
        text = self._text("crwu-audit/SKILL.md")
        self.assertIn("00-input-and-route-profile.md", text)
        self.assertIn("12-leaf-common-contract.md", text)
        self.assertIn("§7.1", text)

    def test_maintenance_owner_table_records_the_split(self):
        text = self._text("crwu-audit/references/99-maintenance.md")
        self.assertIn("12-leaf-common-contract.md", text)
        self.assertIn("§7.1", text)
        self.assertIn("规范", text)
        self.assertIn("机制", text)

    def test_datacheck_keeps_only_the_minimal_iron_rule(self):
        text = self._text("crwu-audit-datacheck/SKILL.md")
        self.assertNotIn("| 定级 |", text)
        self.assertNotIn("| 情形 |", text)
        self.assertIn("隐藏区内容不得读取、解析、核对、引用或输出", text)
        self.assertIn("停止该工作簿处理并登记 capability gap", text)

    def test_authority_qualifies_what_may_be_quoted(self):
        """12 §7.1 的「仍须给出原始摘录」必须限定为**可见证据**，不得摘录隐藏区内容。"""
        text = self._text(self.AUTHORITY)
        start = text.find("7.1")
        section = text[start : text.find("### 7.2", start)]
        self.assertIn("原始摘录", section)
        self.assertTrue(
            "只允许摘录可见" in section or "不得摘录隐藏" in section,
            "§7.1 必须把「原始摘录」限定为可见结果/可见公式/其它可见证据",
        )


class DatacheckProgressiveDisclosureTest(unittest.TestCase):
    """OPT-009B：datacheck 入口必须渐进披露——运行时工具链、详细步骤与 C1–C9 检查目录归 01。

    只锁**文件所有权、入口大小与稳定语义标识**，不断言整段逐字文案。
    两条 H0 断言的读取边界不同，别混：
    - **入口自包含**（H0 最小安全门与共享权威指针必须**直接**留在 `SKILL.md`）→ 本类只读入口；
    - **H0 单一权威 consumer 扫描**（不得出现第二份 S3 定级、三档状态表或隐藏区自带去向裁定）
      → 由 `H0SingleSourceTest.CONSUMERS` 同时覆盖入口 `SKILL.md` 与 01 reference。
    """

    ENTRY_MAX_LINES = 100
    ENTRY_MAX_BYTES = 10000
    # 只应出现在 01 的运行时/检查细节标识（入口里出现即说明细节又回流了）。
    DETAIL_TOKENS = (
        "load_workspace_dependencies",
        "soffice --headless",
        "C8 表单要素完整性",
        "口径 A · 有符号增值率",
        "BG8169",
    )
    # 01 必须保留的核心语义标识（含公式与状态值域）。
    REFERENCE_SEMANTIC_TOKENS = (
        "openpyxl",
        "fail closed",
        "capability gap",
        "pending_verification",
        "增值率 = 增减值 ÷ 账面价值",
        "减值幅度",
        "data_diff_count",
    )
    # H0 最小安全门必须**直接**存在于入口。
    ENTRY_H0_TOKENS = (
        "隐藏区内容不得读取、解析、核对、引用或输出",
        "停止该工作簿处理",
        "capability gap",
        "12-leaf-common-contract.md",
        "§7.1",
    )

    @_requires_skill_tree
    def test_datacheck_progressively_discloses_runtime_and_check_catalog(self):
        reference_path = skill_path(DATACHECK_REFERENCE)
        self.assertTrue(reference_path.is_file(), f"missing runtime/check reference: {reference_path}")
        entry = skill_path(DATACHECK_ENTRY).read_text(encoding="utf-8")
        reference = reference_path.read_text(encoding="utf-8")

        # 1) 入口必须显式链接该 reference，并要求执行前读取。
        self.assertIn(
            "references/01-runtime-and-check-catalog.md", entry,
            "datacheck 入口必须链接 references/01-runtime-and-check-catalog.md",
        )
        self.assertIn("执行前必读", entry, "入口必须要求执行前读取运行时/检查目录 reference")

        # 2) 入口体积上限：详细步骤与检查目录不应再占入口。
        line_count = len(entry.splitlines())
        self.assertLessEqual(
            line_count, self.ENTRY_MAX_LINES,
            f"datacheck 入口过长：{line_count} 行（上限 {self.ENTRY_MAX_LINES}）——细节应下沉到 01",
        )
        byte_size = len(entry.encode("utf-8"))
        self.assertLessEqual(
            byte_size, self.ENTRY_MAX_BYTES,
            f"datacheck 入口过大：{byte_size} bytes（上限 {self.ENTRY_MAX_BYTES}）——细节应下沉到 01",
        )

        # 3) 运行时/检查细节只在 01：入口不得再出现，01 必须承载。
        for token in self.DETAIL_TOKENS:
            self.assertNotIn(
                token, entry,
                f"{token} 属运行时/检查细节，应只出现在 {DATACHECK_REFERENCE}，不得留在入口",
            )
            self.assertIn(
                token, reference,
                f"{DATACHECK_REFERENCE} 必须承载运行时/检查细节 {token}",
            )

        # 4) 01 必须保留核心语义标识，且 C1–C9 九个检查编号齐全。
        for token in self.REFERENCE_SEMANTIC_TOKENS:
            self.assertIn(token, reference, f"{DATACHECK_REFERENCE} 必须保留语义标识 {token}")
        for number in range(1, 10):
            self.assertIn(
                f"C{number} ", reference,
                f"{DATACHECK_REFERENCE} 必须保留检查编号 C{number}",
            )

        # 5) H0 最小安全门与共享权威指针必须继续**直接**留在入口。
        for token in self.ENTRY_H0_TOKENS:
            self.assertIn(token, entry, f"入口必须直接保留 H0 安全门/权威指针标识：{token}")

        # 6) 01 不得成为第二个 H0 权威：不得复制分级/状态表或三档标记。
        for forbidden in ("S3（最低等级）", "| 定级 |", "| 情形 |", "pending_confirmation"):
            self.assertNotIn(
                forbidden, reference,
                f"{DATACHECK_REFERENCE} 不得复制 H0 分级/状态表：{forbidden}",
            )


class ExcelDependencyContractTest(unittest.TestCase):
    """OPT-005：openpyxl 是第三方运行时依赖；缺包必须 fail closed，不得降级读值。"""

    LEGACY = (
        "未安装时可用 Python 标准库（zipfile+xml）读值",
        "本会话已用此方式跑通",
        "仅用 openpyxl 标准库",
    )
    DATACHECK = "crwu-audit-datacheck/SKILL.md"

    def _text(self, rel: str) -> str:
        # OPT-009B：openpyxl/LibreOffice/pip/解释器口径等依赖契约已下沉到 01；依赖断言读组合
        # 契约文本。入口的 H0 断言另在 H0SingleSourceTest 中只读 SKILL.md。
        self.assertEqual(self.DATACHECK, rel)
        return datacheck_contract_text()

    def test_legacy_fallback_authorizations_are_gone(self):
        text = self._text(self.DATACHECK)
        for bad in self.LEGACY:
            self.assertNotIn(bad, text, f"删除旧表述：{bad}")

    def test_openpyxl_is_a_third_party_runtime_dependency(self):
        text = self._text(self.DATACHECK)
        self.assertIn("openpyxl", text)
        self.assertIn("第三方", text)

    def test_missing_dependency_is_a_capability_gap_not_a_material_defect(self):
        text = self._text(self.DATACHECK)
        self.assertIn("capability gap", text)
        self.assertTrue("fail closed" in text or "fail-closed" in text)
        self.assertNotIn("zipfile", text)

    def test_no_pip_or_interpreter_switch(self):
        text = self._text(self.DATACHECK)
        self.assertIn("pip", text)
        self.assertIn("系统解释器", text)


# F-019A：**人工维护**的四篇长文各自必须有覆盖全部 H2 的紧凑 `## 导航`。
LONG_HAND_MAINTAINED_DOCS = (
    "crwu-audit/references/00-input-and-route-profile.md",
    "crwu-audit/scripts/README.md",
    "crwu-audit/references/08-union-dispatch-rules.md",
    "crwu-dev-audit-skill-maintainer/references/05-validation-and-delivery.md",
)
# F-019B：由 `--emit-map` **生成**的校准表 —— 导航必须由生成器原生输出（手改会被下一次刷新覆盖）。
LONG_GENERATED_DOC = "crwu-dev-audit-skill-maintainer/references/07-kb-skill-map.md"
# 只有业务轴的最小目录树：用来证明轴计数来自本次目录树，而不是硬编码真实仓的 12 / 8。
_BIZ_ONLY_TREE = """
- 📁 01-业务路线/
  - 📁 01-资产经营/
    - 📄 共同审核点.md
"""
# 正文 H2：只认行首 `## ` 且后面不是 `#`，因此 `###` 子章节与代码注释都不会被误判。
_H2_RE = re.compile(r"(?m)^## (?!#)(.*)$")
_NAV_ITEM_RE = re.compile(r"^- \[(?P<title>[^\]]+)\]\(#(?P<anchor>[^)]+)\)\s*$")
_NAV_HEADING = "## 导航"


def _markdown_anchor(title: str) -> str:
    """把 H2 标题转成可点击的内链锚点（去标点、空白转连字符）。"""
    slug = re.sub(r"[^\w\u4e00-\u9fff\s-]", "", title.strip().lower())
    return re.sub(r"\s+", "-", slug.strip())


def _navigation_block(text: str) -> list:
    """`## 导航` 之后到下一个 H2 之前的原始行；没有导航块时返回 `None`。"""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip() == _NAV_HEADING), None)
    if start is None:
        return None
    block = []
    for line in lines[start + 1:]:
        if line.startswith("## "):
            break
        block.append(line)
    return block


def _navigation_items(text: str) -> list:
    """导航块里**连续的** `(标题, 锚点)` 列表（遇首个非列表行即结束）。

    不取到"下一个 H2"为止：导航块后面可能紧跟目录表（如 `scripts/README.md`），
    那样会把表行误当成导航项。
    """
    items = []
    for line in _navigation_block(text) or []:
        if not line.strip():
            continue
        match = _NAV_ITEM_RE.match(line)
        if match is None:
            break
        items.append((match.group("title").strip(), match.group("anchor").strip()))
    return items


def _navigation_problems(text: str, label: str) -> list:
    """给定文档文本，返回其 `## 导航` 的全部问题。

    F-019A 四篇人工维护长文、`--emit-map` 的首次与刷新输出、checked-in 生成表
    共用这一套判据（不复制第二套正则）。
    """
    headings = [match.group(1).strip() for match in _H2_RE.finditer(text)]
    business = [title for title in headings if title != "导航"]
    found = []
    if headings.count("导航") != 1:
        found.append(f"{label}: `## 导航` 必须恰好出现一次（实际 {headings.count('导航')} 次）")
        return found
    if headings[0] != "导航":
        found.append(f"{label}: `## 导航` 必须在第一个业务 H2「{business[0]}」之前")
    nav_line = next(
        (index for index, line in enumerate(text.splitlines(), 1) if line.strip() == _NAV_HEADING),
        None,
    )
    if nav_line is None or nav_line > 20:
        found.append(f"{label}: `## 导航` 必须位于文件前 20 行内（实际第 {nav_line} 行）")

    first = next((line for line in _navigation_block(text) or [] if line.strip()), None)
    if first is not None and _NAV_ITEM_RE.match(first) is None:
        found.append(f"{label}: 导航项必须都是 `- [标题](#锚点)` 形式，异常项「{first.strip()}」")

    titles = []
    for title, anchor in _navigation_items(text):
        titles.append(title)
        expected = _markdown_anchor(title)
        if anchor != expected:
            found.append(
                f"{label}: 导航锚点不正确 —— 标题「{title}」实际锚点「#{anchor}」，"
                f"预期「#{expected}」"
            )

    if titles != business:
        missing = [title for title in business if title not in titles]
        extra = [title for title in titles if title not in business]
        if missing:
            found.append(f"{label}: 导航漏项 {missing}")
        if extra:
            found.append(f"{label}: 导航多出非 H2 项 {extra}")
        if len(titles) != len(set(titles)):
            found.append(f"{label}: 导航存在重复项")
        if not missing and not extra and titles != business:
            found.append(f"{label}: 导航顺序与正文 H2 顺序不一致")
    return found


class LongDocumentNavigationTest(unittest.TestCase):
    """F-019A/F-019B：人工维护长文与 `--emit-map` 生成表的 `## 导航` 必须覆盖全部 H2 且同序。

    源仓跨技能契约：安装副本缺完整技能树时由 `_requires_skill_tree` 显式 skip。
    """

    @_requires_skill_tree
    def test_hand_maintained_long_documents_have_complete_navigation(self):
        problems = []
        for rel in LONG_HAND_MAINTAINED_DOCS:
            path = skill_path(rel)
            if not path.is_file():
                problems.append(f"{rel}: 文件不存在")
                continue
            problems.extend(_navigation_problems(path.read_text(encoding="utf-8"), rel))
        # 四篇一次报告全部缺口，不因第一篇失败而短路。
        self.assertEqual(
            [], problems,
            "人工维护长文的导航不合格：\n  " + "\n  ".join(problems),
        )

    def test_emit_map_generates_and_refreshes_complete_navigation(self):
        """F-019B：`--emit-map` 必须**原生生成**完整导航，且重复刷新不追加第二份。"""
        problems = []
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            _create_valid_repo(repo)
            out = root / "map.md"

            def emit(tree_text: str, name: str) -> str:
                tree = root / name
                tree.write_text(textwrap.dedent(tree_text).strip(), encoding="utf-8")
                result = run_checker(repo, tree, "--emit-map", str(out))
                self.assertEqual(0, result.returncode, result.stderr)
                return out.read_text(encoding="utf-8")

            first = emit(COMPLETE_TREE, "tree1.md")
            problems.extend(_navigation_problems(first, "临时 --emit-map 首次输出"))

            # 以同一文件为 previous 再刷一次：导航必须仍恰好一份、标题与锚点不变。
            second = emit(COMPLETE_TREE, "tree1.md")
            problems.extend(_navigation_problems(second, "临时 --emit-map 刷新输出"))
            if _navigation_items(first) != _navigation_items(second):
                problems.append(
                    "临时 --emit-map 两次导航块不一致：\n"
                    f"     首次 {_navigation_items(first)}\n     刷新 {_navigation_items(second)}"
                )
            for token in (
                "CALIBRATION-NOTES:BEGIN", "CALIBRATION-NOTES:END",
                "CALIBRATION-HISTORY:BEGIN", "CALIBRATION-HISTORY:END",
            ):
                if token not in second:
                    problems.append(f"临时 --emit-map 刷新后缺少标记块 {token}")

            # 动态标题：轴计数由本次目录树推导，不得硬编码真实仓的 12 / 8。
            for title in ("资产轴（1）", "业务轴（1）"):
                if title not in first:
                    problems.append(f"临时 --emit-map 未按本次 report 输出标题「{title}」")
            if "资产轴（0）" not in emit(_BIZ_ONLY_TREE, "tree2.md"):
                problems.append(
                    "换一份没有资产轴的目录树后，标题未随之变为「资产轴（0）」（疑似硬编码计数）"
                )

        generated = skill_path(LONG_GENERATED_DOC)
        if generated.is_file():
            problems.extend(
                _navigation_problems(generated.read_text(encoding="utf-8"), LONG_GENERATED_DOC)
            )
        else:
            problems.append(f"{LONG_GENERATED_DOC}: 文件不存在")
        # 一次汇总问题，避免首个缺口短路。
        self.assertEqual([], problems, "生成表导航不合格：\n  " + "\n  ".join(problems))

    def test_method_layer_documentation_and_checker_share_legal_assembly_sources(self):
        """F-023：方法层装配的**合法来源**必须在文档与检查器里是同一套（叶子装配表 + 横切装配表 + router 08）。"""
        problems = []
        doc = (MAINTAINER_SKILL / "references" / "06-live-routing-reconciliation.md").read_text(encoding="utf-8")

        # --- 4.1 只解析 §5（不得靠全篇关键词碰巧命中别处的 router 08）---
        lines = doc.splitlines()
        start = next((i for i, l in enumerate(lines) if l.startswith("### 5 方法层")), None)
        end = next((i for i, l in enumerate(lines) if l.startswith("### 6 原型")), None)
        if start is None or end is None or end <= start:
            problems.append("references/06: 未找到 §5（`### 5 方法层`）到 §6（`### 6 原型`）的章节范围")
            section = ""
        else:
            section = "\n".join(lines[start:end])

        if section:
            if not re.search(r"router", section):
                problems.append("references/06 §5: 未说明 router 08 是方法层/覆盖层/财务报告条件映射的合法来源")
            if "pending" not in section or not re.search(r"不等于|不表示|不代表", section):
                problems.append("references/06 §5: 未声明「方法轴 pending 不等于内容可以不装」")
            if not re.search(r"只看键|不看正文|只看.*键集合", section):
                problems.append("references/06 §5: 未声明覆盖判定仍只看路径键、不看正文")

            # 「判定口径」段本身必须列出三类合法来源并说明取并集（不能只在 §5 别处出现）。
            sec_lines = section.splitlines()
            ci = next((i for i, l in enumerate(sec_lines) if l.startswith("判定口径")), None)
            criterion = ""
            if ci is not None:
                block = []
                for line in sec_lines[ci:]:
                    if not line.strip():
                        break
                    block.append(line)
                criterion = "\n".join(block)
            if not criterion:
                problems.append("references/06 §5: 未找到「判定口径」段")
            else:
                for name in ("01-kb-assembly.md", "00-KB装配表.md", "08-union-dispatch-rules.md"):
                    if name not in criterion:
                        problems.append(f"references/06 §5 判定口径未列出合法装配来源「{name}」")
                if "并集" not in criterion:
                    problems.append("references/06 §5 判定口径未说明使用三类来源的路径键**并集**")

            # --- 4.2 §5 表格事实：三行必须指向 router 08，且不再标成缺口 ---
            table = [l for l in section.splitlines() if l.startswith("|")]
            target = [l for l in table
                      if "03-评估方法/02-收益法/" in l or "03-评估方法/03-资产基础法/" in l
                      or "03-评估方法/04-方法选择/" in l]
            if not target:
                problems.append("references/06 §5: 未找到收益法/资产基础法/方法选择那一行")
            for line in target:
                if "08-union-dispatch-rules.md" not in line:
                    problems.append(f"references/06 §5: 收益法/资产基础法/方法选择行未指向 router 08：{line[:60]}")
                for token in ("收益法", "资产基础法", "methods[]"):
                    if token not in line:
                        problems.append(f"references/06 §5: 该行缺少映射条件「{token}」")
                for banned in ("当前未指定", "已知缺口"):
                    if banned in line:
                        problems.append(f"references/06 §5: 该行仍把已映射目录标成「{banned}」：{line[:60]}")
            # 其它既有表格行不得被删
            for kept in ("06-规则库/清单-M-市场法/", "06-规则库/清单-M-成本法/",
                         "评估方法准则2019", "03-评估方法/01-市场法/", "06-规则库/易错点库/"):
                if not any(kept in l for l in table):
                    problems.append(f"references/06 §5: 既有表格行「{kept}」被删除或改义")

        # --- 4.3 检查器：只读 inspect_method_layer_assembly() 函数范围 ---
        checker = (MAINTAINER_SKILL / "scripts" / "check_audit_skill_mappings.py").read_text(encoding="utf-8")
        src_lines = checker.splitlines()
        fstart = next((i for i, l in enumerate(src_lines)
                       if l.startswith("def inspect_method_layer_assembly(")), None)
        if fstart is None:
            problems.append("checker: 未找到 inspect_method_layer_assembly()")
            func = ""
        else:
            fend = next((i for i in range(fstart + 1, len(src_lines))
                         if src_lines[i].startswith("def ")), len(src_lines))
            func = "\n".join(src_lines[fstart:fend])
        if func:
            # 把 docstring 摘掉后再查"实现片段"：否则 docstring 里提到 router 08 会掩盖代码被改。
            first = func.find('"""')
            second = func.find('"""', first + 3) if first >= 0 else -1
            func_code = (func[:first] + func[second + 3:]) if second > first >= 0 else func
            for token in ("01-kb-assembly.md", "00-KB装配表.md", "08-union-dispatch-rules.md",
                          "ROUTER_SKILL", "_addressing_keys", "assembly_keys"):
                if token not in func_code:
                    problems.append(f"checker: inspect_method_layer_assembly() 实现缺少「{token}」")
            if not re.search(r"assembly_keys\.setdefault\(key, str\(router_dispatch", func_code):
                problems.append(
                    "checker: router 08 的寻址键必须仍写入同一个 assembly_keys（覆盖判断基于该并集）"
                )
            doc_text = func[first + 3:second] if second > first >= 0 else ""
            if not re.search(r"router", doc_text):
                problems.append("checker: 函数 docstring 未说明 router 08 也是合法装配来源")
            index = func.find('"ASSEMBLY_GAP_METHOD_LAYER"')
            message = func[index:func.find("path=", index)] if index >= 0 else ""
            if not message:
                problems.append("checker: 未找到 ASSEMBLY_GAP_METHOD_LAYER 的诊断 message")
            else:
                if "no leaf assembly key" in message:
                    problems.append(
                        "checker: ASSEMBLY_GAP_METHOD_LAYER message 仍声称只有 leaf assembly key 才算覆盖"
                    )
                if not re.search(r"router|08-union-dispatch-rules", message):
                    problems.append("checker: ASSEMBLY_GAP_METHOD_LAYER message 未表达 router 08 也是合法来源")
                if "pending" not in message:
                    problems.append("checker: ASSEMBLY_GAP_METHOD_LAYER message 未表达 pending 不构成免检理由")
                if '"error"' not in message and "'error'" not in message:
                    problems.append("checker: ASSEMBLY_GAP_METHOD_LAYER 的 severity 被改动（应为 error）")

        # --- 4.4 sibling router 08 仍真实承载三个方法映射 ---
        router08 = skill_path("crwu-audit/references/08-union-dispatch-rules.md")
        siblings_checked = router08.is_file()
        if siblings_checked:
            router_text = router08.read_text(encoding="utf-8")
            for key in ("03-评估方法/02-收益法/", "03-评估方法/03-资产基础法/", "03-评估方法/04-方法选择/"):
                if key not in router_text:
                    problems.append(f"crwu-audit/references/08-union-dispatch-rules.md: 方法映射缺少「{key}」")

        # 一次汇总全部问题，不因首个问题短路。
        if problems:
            self.fail("方法层合法装配来源口径不合格：\n  " + "\n  ".join(problems))
        if not siblings_checked:
            self.skipTest("安装副本缺少同级 crwu-audit 的 08-union-dispatch-rules.md：显式跳过 sibling 断言")

    def test_calibration_notes_define_current_vs_historical_precedence(self):
        """F-029：校准备注必须由生成器原生给出「现行 / 历史」读取规则，且不吞掉人工备注或历史原文。"""
        problems = []
        notes_begin = "<!-- CALIBRATION-NOTES:BEGIN -->"
        notes_end = "<!-- CALIBRATION-NOTES:END -->"

        def rule_of(text: str) -> str:
            """取「内容级校准备注」小节内、`CALIBRATION-NOTES:BEGIN` **之前**的说明文字。"""
            lines = text.splitlines()
            head = next((i for i, l in enumerate(lines)
                         if l.startswith("## 内容级校准备注")), None)
            begin = next((i for i, l in enumerate(lines) if notes_begin in l), None)
            if head is None or begin is None or begin <= head:
                return ""
            return "\n".join(lines[head + 1:begin])

        def rule_problems(text: str, label: str) -> list:
            found = []
            rule = rule_of(text)
            if not rule.strip():
                found.append(f"{label}: 未找到位于 {notes_begin} **之前**的现行/历史读取规则")
                return found
            if not re.search(r"新到旧|新→旧", rule):
                found.append(f"{label}: 未找到「按新到旧记录」的读取规则声明")
            elif not re.search(r"冲突", rule):
                found.append(f"{label}: 读取规则只写了排序（新→旧），未说明冲突优先级（不得只按日期排列）")
            if not re.search(r"同一事项.{0,6}冲突|冲突.{0,6}同一事项", rule):
                found.append(f"{label}: 读取规则未说明「同一事项发生冲突」")
            if not (re.search(r"较新", rule) and re.search(r"靠前", rule)
                    and re.search(r"优先|只采信", rule)):
                found.append(f"{label}: 读取规则未说明「位置更靠前的较新结论优先」")
            if "历史记录" not in rule:
                found.append(f"{label}: 读取规则未说明较早冲突表述属于历史记录")
            if not re.search(r"不得作为当前事实|不能作为当前事实", rule):
                found.append(f"{label}: 读取规则未禁止把历史表述当作当前事实")
            if rule.count("不得作为当前事实") + rule.count("不能作为当前事实") != 1:
                found.append(f"{label}: 规则区必须恰好出现一份（人工备注内的合法复述不计）")
            return found

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            _create_valid_repo(repo)
            tree = root / "tree.md"
            tree.write_text(textwrap.dedent(COMPLETE_TREE).strip(), encoding="utf-8")
            out = root / "map.md"
            first = run_checker(repo, tree, "--emit-map", str(out))
            self.assertEqual(0, first.returncode, first.stderr)
            emitted = out.read_text(encoding="utf-8")
            problems += rule_problems(emitted, "临时 --emit-map 首次输出")

            # 预置两条**冲突**人工备注 + 一条**合法复述**规则语义的说明后刷新：
            # 人工块内的复述不是第二份规则，规则区仍须恰好一份，人工备注必须逐字保留。
            seeded = ("- 【较新】子业务要点 28/28 齐备，无一处「待补」。\n"
                      "- 【较早】27 个子业务中 5 个仍为「待补」。\n"
                      "- 维护说明：较早冲突表述不得作为当前事实。\n")
            seeded_text = emitted.replace(notes_begin, notes_begin + "\n" + seeded, 1)
            out.write_text(seeded_text, encoding="utf-8")
            second = run_checker(repo, tree, "--emit-map", str(out))
            self.assertEqual(0, second.returncode, second.stderr)
            refreshed = out.read_text(encoding="utf-8")
            problems += rule_problems(refreshed, "临时 --emit-map 刷新输出")
            for line in seeded.strip().splitlines():
                if line not in refreshed:
                    problems.append(f"临时 --emit-map 刷新后人工备注行丢失：{line}")
            before_inner = seeded_text[seeded_text.index(notes_begin) + len(notes_begin):
                                       seeded_text.index(notes_end)]
            after_inner = refreshed[refreshed.index(notes_begin) + len(notes_begin):
                                    refreshed.index(notes_end)]
            if before_inner.strip("\n") != after_inner.strip("\n"):
                problems.append("临时 --emit-map 刷新后人工备注块内容未逐字保留")

        # checked-in 生成表必须含相同语义
        generated = skill_path(LONG_GENERATED_DOC)
        if not generated.is_file():
            problems.append(f"{LONG_GENERATED_DOC}: 文件不存在")
        else:
            checked = generated.read_text(encoding="utf-8")
            problems += rule_problems(checked, LONG_GENERATED_DOC)
            # 新旧冲突结论必须**同时保留**，且较新在前
            newer_marker, older_marker = "28/28 子业务", "27 个子业务"
            for token in (newer_marker, "无一处", "已补齐", older_marker,
                          "22 个有真实必检项", "5 个仍为「待补」"):
                if token not in checked:
                    problems.append(f"{LONG_GENERATED_DOC}: 缺结论「{token}」（不得删除历史原文）")
            if newer_marker in checked and older_marker in checked:
                if checked.index(newer_marker) > checked.index(older_marker):
                    problems.append(
                        f"{LONG_GENERATED_DOC}: 较新结论必须位于历史结论之前（现为历史在前）"
                    )
            # 不新增 H2，既有导航/章节顺序不变
            headings = [l[3:].strip() for l in checked.splitlines()
                        if l.startswith("## ") and not l.startswith("### ")]
            if len(headings) != 8:
                problems.append(f"{LONG_GENERATED_DOC}: H2 数应为 8（不得新增章节），实际 {len(headings)}")
            if headings[:1] != ["导航"] or headings[-2:] != [
                "内容级校准备注（人工维护，工具不覆盖）", "校准历史（新→旧，工具追加）",
            ]:
                problems.append(f"{LONG_GENERATED_DOC}: 首/末 H2 顺序变化：{headings}")
            # F-025 已闭环的事实不得回退
            if "| 目录节点数 | 464 |" not in checked:
                problems.append(f"{LONG_GENERATED_DOC}: 节点数结论（464）被改动")
            if "检查 325 个寻址键" not in checked or "全部命中" not in checked:
                problems.append(f"{LONG_GENERATED_DOC}: 325 个寻址键全部命中的结论被改动")

        # 一次汇总全部问题，不因首个问题短路。
        self.assertEqual([], problems, "校准备注现行/历史口径不合格：\n  " + "\n  ".join(problems))


if __name__ == "__main__":
    unittest.main()
