#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""crwu 审核技能校验工具（kb_tool）v0.2 —— 只读引用与实时协议校验

知识正文的唯一来源是钉钉知识库，由 `crwu-dws` 按本次审核清单**实时下载**。
本仓不再维护本地知识库根（`CRWU_KB_ROOT` / `~/.crwu/knowledge/knowledge-base`）：
技能侧只写 RULE/CHK 编号与库内层级路径寻址键，正文一律运行时获取。

因此本工具只保留两类**不依赖本地知识库**的检查：

1. 技能引用卫生（`--skill-root`）
   - 旧树残留标记（`01-规则库`、`02-审核清单库`、`06-素材库` 等漂移名）；
   - `KB/…` 省略号（不可解析引用）；
   - 已废止的本地根相对引用 `KB/<rel>`；
   - 已废止的本地知识库根常量与本地根路径字面（`~/.crwu/...`，目录缓存除外）。
2. 实时引用协议 lint（`--skill-root`，作用于 `crwu-audit*` 与 `crwu-dev-audit-*` 族目录）
   - 禁止本地知识库根字面、禁止硬编码 nodeId 赋值；
   - `--forbid-literal` 追加禁止知识库名称等字面。
   纪律文本（含"禁止/不写…字面"的说明行）自动豁免。

装配清单不再由本工具生成：下载清单 = 命中资产/业务子技能的 `01-kb-assembly.md`
（一级目录根或单文件路径）＋ 执行契约路径并集，由 `crwu-dws` M2 实时下载。

叶子公共契约（2026-09-25 架构裁定）：公共规则一个规范源
（`crwu-audit/references/12-leaf-common-contract.md`），由 `sync-leaf-common-contract --write`
确定性同步为各资产/业务叶子的本地副本 `references/03-common-contract.md`；运行时只读本 Skill 内副本。
`validate` 自动执行同等检查（缺失/漂移/目标集合变化 → error；非完整源仓技能层 → skip 且不阻断）。

子命令：validate | sync-leaf-common-contract
用法示例见同目录 README.md。
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from urllib.parse import unquote

TOOL_VERSION = "0.2.0"

# 残留旧树标记（技能/治理文档中的漂移源；validate --skill-root 时告警）
LEGACY_MARKERS = [
    "01-规则库", "02-审核清单库", "执业准则-对象类", "执业准则-评估方法",
    "不动产准则2017-精编条目", "06-素材库", "KB 06/07", "KB 08", "现路径", "迁后",
]

_LEGACY_RE = re.compile("|".join(re.escape(m) for m in LEGACY_MARKERS))

# KB/… 省略号（不可解析引用）
_ELLIPSIS_KB_RE = re.compile(r"KB/…")
# 本地知识库根路径字面（目录缓存 dws-dir-cache 例外）
_KB_LITERAL_RE = re.compile(r"`?~/.crwu/knowledge[^`\s（）()，。;]*")
# 已废止的"本地根相对"引用：KB/<rel>
_KB_REL_RE = re.compile(r"`?KB/[^`\s（）()，。;]*")
# 已废止的本地知识库根常量
_RETIRED_ROOT_RE = re.compile(r"CRWU_KB_ROOT")


# ---------------- 引用卫生 ----------------

def _is_meta_ellipsis_line(line: str) -> bool:
    """说明性文字里的 'KB/…'（如 '下文 KB/… 均相对该根'）不是引用，跳过告警。"""
    return "KB/…" in line and any(
        w in line for w in ("均相对", "均为该根", "一律相对", "相对该根", "禁止省略", "省略号", "省略", "禁止", "废弃", "弃用"))


def _is_forbidden_marker_line(line: str) -> bool:
    """红线/规范里"禁止出现旧名"的列举行：故意含旧树字面量，不作残留告警。"""
    return bool(_LEGACY_RE.search(line)) and any(
        w in line for w in ("禁止出现", "一律禁止", "不允许出现", "不作残留"))


# 纪律/说明行自身会提到被废止的字面（"已废止的 KB/<rel>"、"不再使用 CRWU_KB_ROOT"…）
_RETIREMENT_NOTE_WORDS = (
    "废止", "弃用", "废弃", "不再", "禁止", "不得", "红线", "三不写",
    "字面", "lint", "协议", "硬编码", "旧树", "retired", "deprecated",
)


def _is_retirement_note(line: str) -> bool:
    """说明性的"某写法已废止/禁止"行本身含被禁字面，跳过误报。"""
    return any(word in line for word in _RETIREMENT_NOTE_WORDS)


def skill_path_problems(skill_root: str):
    """扫描技能/文档内的引用卫生问题：旧树标记、省略号、废止的本地根引用与字面。"""
    errors, warns = [], []
    for dirpath, _dirnames, filenames in os.walk(skill_root):
        for fn in sorted(filenames):
            if not fn.endswith(".md"):
                continue
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, skill_root)
            with open(p, encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, start=1):
                    line = line.rstrip("\n")
                    if _is_prohibition_note(line):
                        continue
                    if _ELLIPSIS_KB_RE.search(line) and not _is_meta_ellipsis_line(line):
                        warns.append(f"{rel}:{lineno} KB/… 省略号引用（不可解析）")
                    if _LEGACY_RE.search(line) and not _is_forbidden_marker_line(line):
                        warns.append(f"{rel}:{lineno} 旧树残留标记")
                    if _RETIRED_ROOT_RE.search(line) and not _is_retirement_note(line):
                        errors.append(
                            f"{rel}:{lineno} 已废止的本地知识库根常量（正文唯一来源为钉钉，经 crwu-dws 实时下载）")
                    for lit in _KB_LITERAL_RE.findall(line):
                        t = lit.lstrip("`")
                        if not t.startswith("~"):
                            continue
                        if "dws-dir-cache" in t:
                            # crwu-dws 目录缓存层：运行时 M1/M3 才生成，未生成不算引用缺失
                            continue
                        if not os.path.exists(os.path.abspath(os.path.expanduser(t))):
                            errors.append(f"{rel}:{lineno} 路径不存在 {t}")
                    for relref in _KB_REL_RE.findall(line):
                        t = relref.lstrip("`")
                        if not t.startswith("KB/"):
                            continue
                        seg = t[3:].split(" ")[0]
                        if not seg or seg.startswith("…"):
                            continue
                        if "省略" in seg or "『" in line or "』" in seg:
                            # 实时协议元说明（"禁止「KB/…」式前缀省略"、"『KB/知识库』=…"释义等），非引用
                            continue
                        if _is_retirement_note(line):
                            continue
                        errors.append(
                            f"{rel}:{lineno} 已废止的本地根相对引用 {t}"
                            "（改用库内层级路径，由 crwu-dws 按清单实时下载）")
    return errors, warns


# ---------------- 实时引用协议 lint（2026-09-08，crwu-dws × crwu-audit 实时引用改造） ----------------

# 只对审核族目录做"三不写"严格 lint（crwu-dws 等允许按需引用部署常量/默认库名）。
# 两组前缀都要覆盖：`crwu-audit*`（审核族）与 `crwu-dev-audit-*`（开发/维护侧成员，
# 如 crwu-dev-audit-optimize、crwu-dev-audit-skill-maintainer）——只认前者会让
# 改到 dev 前缀的技能**静默掉出 lint 范围**（2026-09-16 引入，2026-09-19 归组调整后仍适用）。
AUDIT_DIR_PREFIXES = ("crwu-audit", "crwu-dev-audit")
# ① 本地知识库根常量赋值 / 根路径字面 / 内容副本目录字面（推理引用实时化后一律禁止写死在技能内）
_LIVE_NO_ROOT_RES = [
    re.compile(r"CRWU_KB_ROOT\s*="),
    re.compile(r"~/?\.crwu/"),
    re.compile(r"knowledge-base"),
]
# ② 硬编码 nodeId（nodeId 一律由 crwu-dws 运行时解析；技能内只允许描述性提及，不允许赋值）
_LIVE_NODEID_ASSIGN_RE = re.compile(r"nodeId\s*[:=]\s*\S")


def _is_prohibition_note(line: str) -> bool:
    """纪律文本（"禁止…字面/三不写"等）自身可含被禁字面，跳过误报。"""
    return ("禁止" in line or "不写" in line) and any(
        w in line for w in ("字面", "三不写", "lint", "红线", "协议", "硬编码"))


def live_protocol_lint(skill_root: str, forbid_literals):
    """实时引用协议 lint：crwu-audit 族技能内不得出现 ①本地 KB 根路径/根常量字面
    （CRWU_KB_ROOT=、~/.crwu/、knowledge-base）②nodeId 硬编码赋值 ③--forbid-literal 指定的
    知识库名称字面。返回 (errors, warns)。"""
    errors, warns = [], []
    targets = []
    if os.path.isdir(skill_root):
        for d in sorted(os.listdir(skill_root)):
            if d.startswith(AUDIT_DIR_PREFIXES):
                targets.append(os.path.join(skill_root, d))
        if not targets and os.path.basename(skill_root).startswith(AUDIT_DIR_PREFIXES):
            targets.append(skill_root)
    elif os.path.basename(skill_root).startswith(AUDIT_DIR_PREFIXES):
        targets.append(skill_root)
    for root in targets:
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in sorted(filenames):
                if not fn.endswith(".md"):
                    continue
                p = os.path.join(dirpath, fn)
                rel = os.path.relpath(p, skill_root)
                with open(p, encoding="utf-8") as fh:
                    for lineno, line in enumerate(fh, start=1):
                        line = line.rstrip("\n")
                        if _is_prohibition_note(line):
                            continue
                        for rx in _LIVE_NO_ROOT_RES:
                            if rx.search(line):
                                errors.append(
                                    f"{rel}:{lineno} 实时协议禁止本地 KB 根字面：{rx.pattern}")
                                break
                        if _LIVE_NODEID_ASSIGN_RE.search(line):
                            errors.append(f"{rel}:{lineno} 禁止硬编码 nodeId（由 crwu-dws 运行时解析）")
                        for lit in forbid_literals or []:
                            if lit and lit in line:
                                errors.append(f"{rel}:{lineno} 禁止知识库名称字面：{lit}")
    return errors, warns


# ---------------- 技能自洽性 lint（2026-09-10：技能不得引用代码仓库目录） ----------------

# 技能以副本安装（各技能同级放于 agent skills 根下）时必须能独立工作：
# 运行时内容里出现仓库目录/仓根文件引用 → 安装后一律不存在。
# 注意：路径名在此按"目录名 + 分隔符"拼装，避免本段定义被自身规则匹配。
_REPO_DIR_NAMES = ["docs", "tools", "cmd", "internal", "bin"]
_REPO_ROOT_FILES = ["Makefile", "go.mod"]  # lint-self: 规则定义本身，非技能内容
# 允许 `./`、`../` 前缀（相对写法同样要拦）；先剔除系统路径与 URL 再匹配，避免误报。
_REPO_PREFIX = r"(?<![\w/-])(?:\.{1,2}/)*"  # lint-self: 规则定义本身
# shebang 等系统路径、文档链接里的 URL 不是仓库目录
_SAFE_BEFORE_MATCH = (
    (re.compile(r"https?://\S+"), " "),
    (re.compile(r"/usr/(?:local/)?bin/"), " "),  # lint-self: 规则定义本身
)
_REPO_REF_PATTERNS = [(name, re.compile(_REPO_PREFIX + re.escape(name) + r"/"))
                      for name in _REPO_DIR_NAMES] + \
                     [(name, re.compile(_REPO_PREFIX + re.escape(name) + r"(?![\w.-])"))
                      for name in _REPO_ROOT_FILES] + \
                     [("skills/<层>/", re.compile(_REPO_PREFIX + r"skills/(?:crwu|dws)/")),
                      ("skills/<skill>/", re.compile(_REPO_PREFIX + r"skills/crwu-[a-z0-9]+[a-z0-9-]*/"))]
# 逃出技能目录的本地 Markdown 链接：按**规范化后的相对路径**判定（见 `escaping_links`）。
# 不能按「`../` 出现次数」判定：`references/sub/deep.md → ../../SKILL.md` 有 2 个 `../` 却仍在技能内，
# 而 `SKILL.md → ../sibling/x.md` 只有 1 个 `../` 却已逃逸。两条都是真实反例。
# 本地链接：`[text](target)` / `![alt](target)`；target 可被 `<>` 包裹，可带 fragment/query。  # lint-self: 规则定义本身
_MD_LINK_RE = re.compile(r"!?\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)")  # lint-self: 规则定义本身
# 外部 URI / 协议相对 URL / 纯锚点：不是本地相对路径。  # lint-self: 规则定义本身
_EXTERNAL_URI_RE = re.compile(r"^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|//|#)")  # lint-self: 规则定义本身
# 源仓契约测试：只在源仓维护时运行，允许定位源仓；文件头 30 行内声明即可豁免。
_SOURCE_REPO_TEST_MARKERS = ("源仓契约测试", "源仓维护工具")


def _local_link_target(raw: str):
    """从 Markdown 链接目标里取出本地相对路径；外部 URI / 锚点 / 绝对路径返回 None。"""
    target = raw.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1].strip()
    if not target or _EXTERNAL_URI_RE.match(target):
        return None
    if target.startswith(("/", "\\")):
        return None  # 绝对路径由仓库引用 lint 负责，不计入"逃出技能目录"
    for separator in ("#", "?"):
        cut = target.find(separator)
        if cut != -1:
            target = target[:cut]
    target = unquote(target.strip())
    return target or None


def escaping_links(document: str, skill_dir: str):
    """返回 `document` 中所有**逃出 `skill_dir`** 的本地 Markdown 链接。

    判定算法（只依赖路径边界，**不依赖目标文件当前是否存在**）：
    1. 逐行解析 Markdown 本地链接目标（含 `<>` 包裹与 fragment/query）；
    2. 跳过外部 URI（`http:`/`https:`/`mailto:`/其它 scheme、`//`）与纯 `#anchor`、绝对路径；
    3. 去 fragment/query、URL 解码后，相对**当前文件所在目录**解析并 `normpath`；
    4. 规范化结果必须仍位于 `skill_dir` 之内，否则即逃逸。

    这样 `references/01.md → ../SKILL.md`（在内）与 `SKILL.md → ../sibling/x.md`（逃逸）
    都能得到正确结论。
    """
    escapes = []
    skill_root = os.path.abspath(skill_dir)
    document = os.path.abspath(document)
    base = os.path.dirname(document)
    try:
        with open(document, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return escapes
    for lineno, line in enumerate(lines, start=1):
        if "# lint-self:" in line:
            continue
        for match in _MD_LINK_RE.finditer(line):
            target = _local_link_target(match.group(1))
            if target is None:
                continue
            resolved = os.path.normpath(os.path.join(base, target))
            if resolved == skill_root or resolved.startswith(skill_root + os.sep):
                continue
            escapes.append({
                "line": lineno,
                "target": match.group(1),
                "resolved": resolved,
                "skill_root": skill_root,
            })
    return escapes


def _is_source_repo_test(lines) -> bool:
    return any(marker in line for line in lines[:30] for marker in _SOURCE_REPO_TEST_MARKERS)


def repo_reference_lint(skill_root: str):
    """技能自洽性 lint：技能目录内的 .md 与 .py 不得引用代码仓库目录/仓根文件。

    豁免：文件头 30 行内声明「源仓契约测试」或「源仓维护工具」的 .py（只在源仓维护时运行，
    运行时不需要）；含「禁止/不写…字面」等纪律词或"已废止"说明的行；以及带 `# lint-self:`
    标记的行（规则定义本身）。
    返回 (errors, warns)。
    """
    errors, warns = [], []
    root = os.path.abspath(skill_root)
    if not os.path.isdir(root):
        return errors, warns
    # 只审"技能"：skills 根本身与其下的源仓级文档（AGENTS.md / README.md）不是技能。
    if os.path.isfile(os.path.join(root, "SKILL.md")):
        skill_dirs = [root]
    else:
        skill_dirs = [
            os.path.join(root, name)
            for name in sorted(os.listdir(root))
            if os.path.isfile(os.path.join(root, name, "SKILL.md"))
        ]
    for skill_dir in skill_dirs:
      for dirpath, _dirnames, filenames in os.walk(skill_dir):
        for fn in sorted(filenames):
            if not (fn.endswith(".md") or fn.endswith(".py")):
                continue
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, root)
            with open(p, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            if fn.endswith(".py") and _is_source_repo_test(lines):
                continue
            # 逃逸判定按规范化路径逐文件算一次（行级正则做不到：是否逃逸取决于文件位置 + 目标）。
            escape_by_line = {}
            if fn.endswith(".md"):
                for escape in escaping_links(p, skill_dir):
                    escape_by_line.setdefault(escape["line"], escape)
            for lineno, line in enumerate(lines, start=1):
                if "# lint-self:" in line:
                    continue
                if _is_prohibition_note(line) or _is_retirement_note(line):
                    continue
                scrubbed = line
                for safe_rx, replacement in _SAFE_BEFORE_MATCH:
                    scrubbed = safe_rx.sub(replacement, scrubbed)
                escape = escape_by_line.get(lineno)
                if escape is not None:
                    errors.append(
                        f"{rel}:{lineno} 技能内不得出现逃出技能目录的链接：{escape['target']}"
                        "（技能以副本安装时该目标不存在；改为本 Skill 内 references/ 的相对路径）")
                    continue
                for label, rx in _REPO_REF_PATTERNS:
                    if rx.search(scrubbed):
                        errors.append(
                            f"{rel}:{lineno} 技能不得引用代码仓库目录/文件：{label}"
                            "（技能以副本安装时不存在；改用技能内 references、同技能 scripts/，"
                            "或 $SKILLS_ROOT/<技能>/scripts/… 形式的跨技能引用）")
    return errors, warns


# ---------------- 叶子公共契约：规范源 → 各叶子本地副本（源仓维护） ----------------
#
# 口径（2026-09-25 架构裁定「方案 A 的受控版本」）：公共规则维护**一个规范源**，
# 通过确定性工具同步为各叶子的**本地副本**；运行时只读取本 Skill 内副本，源码门禁阻止漂移。
# 规范源与各副本逐字节相同 —— 它们是同一内容的多个副本，**不是多个独立事实源**。
#
# 规范源、目标相对路径与目标选择规则**只在这里定义一次**，避免多处各写一份。

LEAF_COMMON_CONTRACT = {
    "source_skill": "crwu-audit",
    "source": "crwu-audit/references/12-leaf-common-contract.md",
    "target": "references/03-common-contract.md",
    "leaf_prefixes": ("crwu-audit-asset-", "crwu-audit-biz-"),
    "skip_note": "未发现 router 技能或资产/业务叶子集合；按「只安装了技能族子集」处理，跳过源码维护检查",
}


def discover_leaf_skills(skill_root: str):
    """按目录发现资产/业务叶子：前缀匹配 **且** 实际存在 `SKILL.md`。

    数量不是事实源 —— 目录即名单，新增/改名的叶子会被自动收进同步集合。
    """
    root = os.path.abspath(skill_root)
    if not os.path.isdir(root):
        return []
    prefixes = LEAF_COMMON_CONTRACT["leaf_prefixes"]
    return sorted(
        name for name in os.listdir(root)
        if name.startswith(prefixes) and os.path.isfile(os.path.join(root, name, "SKILL.md"))
    )


def leaf_common_contract_report(skill_root: str):
    """叶子公共契约的缺失 / 漂移 / 目标集合变化报告（**只读**）。

    返回 dict：
      - `status`：`ok`（已检查）或 `skip`（非完整源仓技能层，不报错）；
      - `skip_reason` / `source` / `target` / `leaves`；
      - `missing`：缺本地副本的叶子（规范源本身缺失时为 `["__source__"]`）；
      - `drifted`：副本与规范源不一致的叶子；
      - `unexpected`：目标集合**以外**却持有该副本的目录（改名/删除留下的残留，不得静默漏同步）。
    """
    root = os.path.abspath(skill_root)
    cfg = LEAF_COMMON_CONTRACT
    report = {
        "status": "ok",
        "skip_reason": "",
        "skill_root": root,
        "source": os.path.join(root, cfg["source"]),
        "target": cfg["target"],
        "leaves": 0,
        "missing": [],
        "drifted": [],
        "unexpected": [],
    }
    router_entry = os.path.join(root, cfg["source_skill"], "SKILL.md")
    leaves = discover_leaf_skills(root)
    if not os.path.isfile(router_entry) or not leaves:
        report["status"] = "skip"
        report["skip_reason"] = cfg["skip_note"]
        return report
    report["leaves"] = len(leaves)
    if not os.path.isfile(report["source"]):
        report["missing"].append("__source__")
        return report
    with open(report["source"], "rb") as fh:
        source_bytes = fh.read()
    for leaf in leaves:
        target = os.path.join(root, leaf, cfg["target"])
        if not os.path.isfile(target):
            report["missing"].append(leaf)
            continue
        with open(target, "rb") as fh:
            if fh.read() != source_bytes:
                report["drifted"].append(leaf)
    leaf_set = set(leaves)
    for name in sorted(os.listdir(root)):
        skill_dir = os.path.join(root, name)
        if not os.path.isfile(os.path.join(skill_dir, "SKILL.md")):
            # 带叶子前缀但已不是技能目录（缺 SKILL.md），却残留副本 → 目标集合变化
            if name.startswith(cfg["leaf_prefixes"]) and os.path.isfile(os.path.join(skill_dir, cfg["target"])):
                report["unexpected"].append(f"{name}（缺 SKILL.md，副本应删除或恢复技能目录）")
            continue
        if name in leaf_set:
            continue
        # 非资产/业务叶子（router / 横切能力 / 元技能）不得持有叶子公共契约副本
        if os.path.isfile(os.path.join(skill_dir, cfg["target"])):
            report["unexpected"].append(f"{name}（非资产/业务叶子，不应持有叶子契约副本）")
    return report


def sync_leaf_common_contract(skill_root: str, write: bool = False):
    """确定性同步叶子公共契约副本。

    - `write=True`：只为**缺失或漂移**的叶子写入规范源的逐字节副本（已一致的文件不触碰 → 幂等）；
    - `write=False`：等价 `--check`，只报告。

    返回 `leaf_common_contract_report` 的结果，另带 `written[]`（本次实际写入的叶子）。
    """
    before = leaf_common_contract_report(skill_root)
    written = []
    if write and before["status"] == "ok" and before["missing"] != ["__source__"]:
        with open(before["source"], "rb") as fh:
            source_bytes = fh.read()
        for leaf in before["missing"] + before["drifted"]:
            target = os.path.join(before["skill_root"], leaf, LEAF_COMMON_CONTRACT["target"])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(source_bytes)
            written.append(leaf)
    report = leaf_common_contract_report(skill_root) if write else before
    report["written"] = sorted(written)
    return report


def leaf_common_contract_lint(skill_root: str):
    """把叶子公共契约检查接入 `validate`（返回 (errors, warns)）。

    缺失 / 漂移 / 目标集合变化 → error；非完整源仓技能层 → warn（skip，不阻断安装子集）。
    """
    errors, warns = [], []
    report = leaf_common_contract_report(skill_root)
    if report["status"] == "skip":
        warns.append(f"叶子公共契约同步检查：skip（{report['skip_reason']}）")
        return errors, warns
    if report["missing"] == ["__source__"]:
        errors.append(
            f"叶子公共契约规范源缺失：{report['source']}"
            "（先恢复规范源，再跑 kb_tool.py sync-leaf-common-contract --write）")
        return errors, warns
    for leaf in report["missing"]:
        errors.append(
            f"{leaf}: 缺少本地公共契约副本 {report['target']}"
            "（运行 kb_tool.py sync-leaf-common-contract --write 生成）")
    for leaf in report["drifted"]:
        errors.append(
            f"{leaf}: 本地公共契约副本与规范源漂移"
            "（重新运行 kb_tool.py sync-leaf-common-contract --write）")
    for name in report["unexpected"]:
        errors.append(f"{name}: 叶子公共契约副本出现在目标集合之外（不得静默保留）")
    return errors, warns


# ---------------- CLI ----------------

def cmd_validate(args):
    errors, warns = [], []
    for sr in args.skill_root or []:
        root = os.path.abspath(sr)
        if not os.path.isdir(root):
            errors.append(f"技能根不存在：{root}")
            continue
        e2, w2 = skill_path_problems(root)
        errors += e2
        warns += w2
        e3, w3 = live_protocol_lint(root, args.forbid_literal)
        errors += e3
        warns += w3
        e4, w4 = repo_reference_lint(root)
        errors += e4
        warns += w4
        e5, w5 = leaf_common_contract_lint(root)
        errors += e5
        warns += w5
    print("== validate 结果 ==")
    for w in warns:
        print("  [warn ] " + w)
    for e_ in errors:
        print("  [error] " + e_)
    print(f"warn={len(warns)} error={len(errors)}")
    return 1 if errors else 0


def cmd_sync_leaf_common_contract(args):
    report = sync_leaf_common_contract(args.skill_root, write=bool(args.write))
    print("== 叶子公共契约 %s ==" % ("同步（--write）" if args.write else "检查（--check）"))
    print(f"  技能层：{report['skill_root']}")
    print(f"  规范源：{report['source']}")
    print(f"  目标副本：{report['target']}")
    if report["status"] == "skip":
        print(f"  [skip ] {report['skip_reason']}")
        return 0
    print(f"  叶子集合：{report['leaves']} 个（目录发现，不写死）")
    for leaf in report["missing"]:
        print(f"  [missing]    {leaf}")
    for leaf in report["drifted"]:
        print(f"  [drifted]    {leaf}")
    for name in report["unexpected"]:
        print(f"  [unexpected] {name}")
    for leaf in report.get("written", []):
        print(f"  [written]    {leaf}")
    print(
        f"missing={len(report['missing'])} drifted={len(report['drifted'])} "
        f"unexpected={len(report['unexpected'])} written={len(report.get('written', []))}"
    )
    problems = len(report["missing"]) + len(report["drifted"]) + len(report["unexpected"])
    return 1 if problems else 0


def main():
    ap = argparse.ArgumentParser(
        description="crwu 审核技能校验（只读引用卫生 + 实时引用协议 lint；知识正文唯一来源为钉钉）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_v = sub.add_parser("validate", help="技能引用卫生（旧树标记/省略号/废止的本地根引用）与实时协议 lint")
    p_v.add_argument("--skill-root", action="append", help="扫描的技能目录（如 plugins/dsh-crwu-workbench/skills/crwu），可多次")
    p_v.add_argument("--forbid-literal", action="append", default=[], metavar="字面",
                     help="实时协议 lint：禁止出现的知识库名称等字面（可多次；根路径/nodeId 检查默认只对 crwu-audit*/crwu-dev-audit-* 目录生效）")
    p_v.set_defaults(fn=cmd_validate)

    p_s = sub.add_parser(
        "sync-leaf-common-contract",
        help="叶子公共契约：规范源 → 各叶子 references/03-common-contract.md（缺失/漂移/目标集合变化）")
    p_s.add_argument("--skill-root", required=True,
                     help="技能层目录（如 plugins/dsh-crwu-workbench/skills/crwu）")
    mode = p_s.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="确定性生成/修复所有叶子副本（已一致的文件不触碰）")
    mode.add_argument("--check", action="store_true", help="只报告 missing/drifted/unexpected，不写文件（默认）")
    p_s.set_defaults(fn=cmd_sync_leaf_common_contract)

    args = ap.parse_args()
    try:
        code = args.fn(args)
    except BrokenPipeError:
        code = 0
    sys.exit(code if isinstance(code, int) else 0)


if __name__ == "__main__":
    main()
