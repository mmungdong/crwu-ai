#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""crwu 知识库工具（kb_tool）v0.1 —— 只读索引 / 自动校验 / 装配清单

目标：让"技能按编号引用规则 → 命中文件+行号区间+发布状态"全链路可机器校验、可复现；
不引入向量库，不修改知识库内容（索引产物除外）。

约定
----
- KB 根：环境变量 CRWU_KB_ROOT，缺省 ~/.crwu/knowledge/knowledge-base
- 索引产物：<KB>/00-总纲/治理/kb-index.jsonl（首行为 _meta 记录；勿手改，重跑 index 刷新）
- 锚点：md 中以 `### RULE-xxx` / `### CHK-xxx` 开头的标题行 = 一条条目的定义行（唯一性以此为准）
- release 状态：confidence 含"已发布"→published；含"待发布"或等于 A → pending；否则 raw
- 装配匹配语义（deterministic）：候选 = modules 命中或 dims 键命中；
  命中 = 候选且 object_type/method/scenario 任一给定键全部不冲突（空数组=通用=全匹配；
  stage 不作硬过滤，只展示，由叶子按材料分区判）；排除=候选内未命中者+原因。

子命令：index | validate | resolve | query | release | assemble | extract | selftest
用法示例见同目录 README.md。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import sys

KB_DEFAULT = os.path.expanduser("~/.crwu/knowledge/knowledge-base")
INDEX_REL = os.path.join("00-总纲", "治理", "kb-index.jsonl")
TOOL_VERSION = "0.1.0"

# ---------------- 解析 ----------------

ANCHOR_RE = re.compile(r"^\s*#{3,6}\s+(RULE|CHK)-([A-Z0-9]+(?:-[A-Z0-9]+)*)(?:\s+(.*))?$")
HEADING_RE = re.compile(r"^\s*#{1,6}\s")
DIMS_RE = re.compile(r"([a-z_]+)\[([^\]]*)\]")
SEG_RE = re.compile(r"\*\*([^*]+?)\*\*\s*:\s*([^*]*)")
VALUE_SPLIT_RE = re.compile(r"[、,/]")

# 残留旧树标记（技能/治理文档中的漂移源；validate --skill-root 时告警）
LEGACY_MARKERS = [
    "01-规则库", "02-审核清单库", "执业准则-对象类", "执业准则-评估方法",
    "不动产准则2017-精编条目", "06-素材库", "KB 06/07", "KB 08", "现路径", "迁后",
]

_LEGACY_RE = re.compile("|".join(re.escape(m) for m in LEGACY_MARKERS))

# KB/… 省略号（不可解析引用）
_ELLIPSIS_KB_RE = re.compile(r"KB/…")
# 字面路径引用（反引号内或裸写），用于存在性校验
_KB_LITERAL_RE = re.compile(r"`?~/.crwu/knowledge[^`\s（）()，。;]*")
_KB_REL_RE = re.compile(r"`?KB/[^`\s（）()，。;]*")


def _split_values(s: str):
    return [t.strip() for t in VALUE_SPLIT_RE.split(s) if t.strip()]


def parse_dims(text: str):
    out = {}
    for key, val in DIMS_RE.findall(text):
        out[key] = _split_values(val)
    return out


def parse_modules(text: str):
    out = []
    for m in re.finditer(r"\[([^\]]*)\]", text):
        out.extend(_split_values(m.group(1)))
    return sorted(set(out))


def parse_fields(block_text: str):
    """从条目块解析 **key**: value（bullet 内可能用 ｜ 分隔多组）与裸 dims/modules 行。"""
    fields, dims, modules = {}, {}, []
    for raw_line in block_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("- ") and not line.startswith("* "):
            continue
        body = line[2:].strip()
        if "**" not in body:
            continue
        for seg in body.split("｜"):
            m = SEG_RE.match(seg.strip())
            if not m:
                continue
            key, val = m.group(1).strip(), m.group(2).strip()
            if key == "dims":
                dims = parse_dims(val)
            elif key == "modules":
                modules = parse_modules(val)
            else:
                fields[key] = val
    return fields, dims, modules


def release_of(conf: str) -> str:
    c = (conf or "").strip()
    if "已发布" in c:
        return "published"
    if "待发布" in c or c in ("A", "A（内容核验完成）"):
        return "pending"
    if not c:
        return "unknown"
    return "unknown"


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def parse_file(path: str, rel: str):
    """返回 ([entries], file_sha256)。条目不排序（保持文件内顺序）。"""
    with open(path, "r", encoding="utf-8") as fh:
        content = fh.read()
    file_hash = _sha256_bytes(content.encode("utf-8"))
    lines = content.splitlines()
    entries, cur = [], None

    def close(start_line, end_line):
        nonlocal cur
        if cur is None:
            return
        block_lines = lines[cur["_start"] - 1: end_line - 1] if end_line >= cur["_start"] else []
        block = "\n".join(block_lines)
        fields, dims, modules = parse_fields(block)
        conf = fields.get("confidence", "")
        cur.pop("_start", None)
        cur.update({
            "id": cur["id"], "type": cur["type"], "title": cur["title"],
            "file": rel, "start": cur["start"], "end": end_line - 1,
            "fields": fields, "dims": dims, "modules": modules,
            "confidence": conf, "release": release_of(conf),
            "hash": _sha256_bytes(block.encode("utf-8")),
        })
        entries.append(cur)
        cur = None

    for idx, line in enumerate(lines, start=1):
        m = ANCHOR_RE.match(line)
        if m:
            close(idx - 1, idx)
            cur = {
                "_start": idx,
                "type": m.group(1),       # RULE | CHK
                "id": m.group(1) + "-" + m.group(2),
                "title": (m.group(3) or "").strip(),
                "start": idx,
            }
        elif cur is not None and HEADING_RE.match(line):
            close(idx - 1, idx)
    close(len(lines), len(lines) + 1)
    # 条目无 confidence 时回填文件头门禁（清单/批次文件头"待发布/A 内容核验"即该文件全部条目状态）
    head = "\n".join(lines[:16])
    if "待发布" in head or "待人工发布" in head:
        for e in entries:
            if e["release"] == "unknown":
                e["release"] = "pending"
    return entries, file_hash


def kb_root_from_args(args) -> str:
    root = getattr(args, "root", None) or os.environ.get("CRWU_KB_ROOT") or KB_DEFAULT
    return os.path.abspath(os.path.expanduser(root))


def index_path(root: str) -> str:
    return os.path.join(root, INDEX_REL)


def collect_md(root: str):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules",)]
        for fn in sorted(filenames):
            if fn.endswith(".md") and not fn.startswith("."):
                out.append(os.path.join(dirpath, fn))
    return out


def load_index(root: str):
    p = index_path(root)
    if not os.path.exists(p):
        return None, None
    entries, meta = [], None
    with open(p, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("_meta"):
                meta = obj
            else:
                entries.append(obj)
    return entries, meta


def write_index(root: str, out=None) -> str:
    entries = []
    meta_files = {}
    for path in collect_md(root):
        rel = os.path.relpath(path, root)
        es, h = parse_file(path, rel)
        meta_files[rel] = h
        entries.extend(es)
    # 唯一性（定义锚点）
    seen, dups = {}, []
    for e in entries:
        if e["id"] in seen:
            dups.append((e["id"], seen[e["id"]], e["file"]))
        else:
            seen[e["id"]] = e["file"]
    meta = {
        "_meta": True, "schema": 1, "tool": "kb_tool", "tool_version": TOOL_VERSION,
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "kb_root": root, "entry_count": len(entries),
        "files": meta_files,
        "duplicate_ids": [{"id": i, "files": [f, g]} for i, f, g in dups],
    }
    dst = out or index_path(root)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(meta, ensure_ascii=False) + "\n")
        for e in entries:
            slim = {k: e[k] for k in (
                "id", "type", "title", "file", "start", "end", "fields",
                "dims", "modules", "confidence", "release", "hash")}
            fh.write(json.dumps(slim, ensure_ascii=False) + "\n")
    os.replace(tmp, dst)
    return dst


# ---------------- 校验 ----------------

def freshness_check(root: str, meta):
    problems = []
    if meta is None:
        return ["索引缺失：先运行 kb_tool.py index"]
    cur_files = {os.path.relpath(p, root): _sha256_bytes(open(p, "rb").read())
                 for p in collect_md(root)}
    old = meta.get("files", {})
    for rel, h in sorted(cur_files.items()):
        if rel not in old:
            problems.append(f"索引过期：新增文件未入索引 {rel}")
        elif old[rel] != h:
            problems.append(f"索引过期：文件已变更未重跑 index {rel}")
    for rel in sorted(set(old) - set(cur_files)):
        problems.append(f"索引过期：文件已删除仍留在索引 {rel}")
    return problems


def vocab_tokens(root: str):
    """从标签词典粗取各 dims.* / modules 词表（warn 级用，非权威 parser）。"""
    vpath = os.path.join(root, "00-总纲", "治理", "标签词典.md")
    tokens = set()
    if not os.path.exists(vpath):
        return tokens
    with open(vpath, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith("|"):
                if not line.startswith("| 取值") and not line.startswith("| dims.") and not line.startswith("| modules"):
                    cells = [c.strip() for c in line.strip("|").split("|")]
                    if len(cells) >= 2 and cells[0]:
                        first = re.sub(r"（预留）|^dims\.|^modules|^取值[:：]", "", cells[0])
                        for t in _split_values(first):
                            t = t.strip()
                            if t:
                                tokens.add(t)
            else:
                # 行内格式：取值：`承接`（…）、`程序执行`（…）
                m = re.match(r"^取值[:：]\s*(.*)$", line)
                if m:
                    for t in re.findall(r"`([^`]+)`", m.group(1)):
                        t = t.strip()
                        if t:
                            tokens.add(t)
    return tokens


def vocab_problems(entries, tokens):
    warns = []
    for e in entries:
        for key, vals in e.get("dims", {}).items():
            for v in vals:
                if v not in tokens:
                    warns.append(f"词表外取值 dims.{key}[{v}] @ {e['file']}:{e['start']} {e['id']}")
        for m in e.get("modules", []):
            if m not in tokens:
                warns.append(f"词表外取值 modules[{m}] @ {e['file']}:{e['start']} {e['id']}")
    return warns


def _is_meta_ellipsis_line(line: str) -> bool:
    """说明性文字里的 'KB/…'（如 '下文 KB/… 均相对该根'）不是引用，跳过告警。"""
    return "KB/…" in line and any(
        w in line for w in ("均相对", "均为该根", "一律相对", "相对 CRWU_KB_ROOT", "相对该根", "禁止省略", "省略号"))


def _is_forbidden_marker_line(line: str) -> bool:
    """红线/规范里"禁止出现旧名"的列举行：故意含旧树字面量，不作残留告警。"""
    return bool(_LEGACY_RE.search(line)) and any(
        w in line for w in ("禁止出现", "一律禁止", "不允许出现", "不作残留"))


def skill_path_problems(skill_root: str, kb_root: str):
    """扫描技能/文档内 KB 引用：存在性 + 省略号 + 旧树残留标记。"""
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
                    if _ELLIPSIS_KB_RE.search(line) and not _is_meta_ellipsis_line(line):
                        warns.append(f"{rel}:{lineno} KB/… 省略号引用（不可解析）")
                    if _LEGACY_RE.search(line) and not _is_forbidden_marker_line(line):
                        warns.append(f"{rel}:{lineno} 旧树残留标记")
                    for lit in _KB_LITERAL_RE.findall(line):
                        t = lit.lstrip("`")
                        if t.startswith("~"):
                            full = os.path.abspath(os.path.expanduser(t))
                            if not os.path.exists(full):
                                errors.append(f"{rel}:{lineno} 路径不存在 {t}")
                    for relref in _KB_REL_RE.findall(line):
                        t = relref.lstrip("`")
                        if not t.startswith("KB/"):
                            continue
                        seg = t[3:].split(" ")[0]
                        if not seg or seg == "…":
                            continue
                        full = os.path.join(kb_root, seg)
                        # 允许文件或目录存在；"…/xx" 打头的省略写法提示
                        if not os.path.exists(full):
                            errors.append(f"{rel}:{lineno} KB 引用不存在：{t} → {full}")
    return errors, warns


# ---------------- 装配 ----------------

HARD_DIM_KEYS = ["object_type", "method", "scenario"]


def dims_hit(entry_dims: dict, profile_dims: dict) -> str:
    """None=命中；否则返回排除原因。entry 空数组=通用=全匹配。"""
    for key in HARD_DIM_KEYS:
        want = profile_dims.get(key) or []
        have = entry_dims.get(key) or []
        if not want:
            continue
        if have and not (set(have) & set(want)):
            return f"{key} 不命中（{('/'.join(have))} vs {'/'.join(want)}）"
    return None


def _is_candidate(e, profile_dims, profile_modules):
    """候选 = 模块命中 或 条目带非空维度标签命中（通用空标签不参与候选，避免全库命中）。"""
    em = set(e.get("modules") or [])
    if em & set(profile_modules):
        return True
    for key, vals in profile_dims.items():
        if not vals:
            continue
        have = (e.get("dims") or {}).get(key) or []
        if have and (set(have) & set(vals)):
            return True
    return False


def _out_reason(e, profile_dims, profile_modules):
    """未入候选的归因（最具体的一个标签）。"""
    miss = [m for m in (e.get("modules") or []) if m not in set(profile_modules)]
    if miss:
        return "模块未装配：" + "/".join(sorted(set(miss))[:3])
    r = dims_hit(e.get("dims") or {}, profile_dims)
    if r:
        return r
    have_dims = any((e.get("dims") or {}).values())
    if not have_dims and not miss:
        return "画像外（无模块/维度标签的通用条目，需人工确认装配）"
    return "画像外（无命中维度）"


def assemble(root: str, profile: dict):
    entries, meta = load_index(root)
    if entries is None:
        raise SystemExit("索引缺失：先运行 kb_tool.py index")
    pdims = profile.get("dims", {}) or {}
    pmods = profile.get("modules", []) or []
    candidates = [e for e in entries if e["type"] in ("RULE", "CHK")
                  and _is_candidate(e, pdims, pmods)]
    hits, misses = [], []
    for e in sorted(candidates, key=lambda x: (x["file"], x["start"])):
        reason = dims_hit(e.get("dims") or {}, pdims)
        if reason is None:
            hits.append(e)
        else:
            misses.append((e, reason))
    in_ids = {e["id"] for e in candidates}
    out_bucket = {}
    for e in entries:
        if e["id"] not in in_ids and e["type"] in ("RULE", "CHK"):
            label = _out_reason(e, pdims, pmods)
            b = out_bucket.setdefault(label, {"n": 0, "ids": []})
            b["n"] += 1
            if len(b["ids"]) < 5:
                b["ids"].append(e["id"])
    return hits, misses, candidates, meta, out_bucket


# ---------------- CLI ----------------

def fmt_status(e):
    return e["release"]


def cmd_index(args):
    root = kb_root_from_args(args)
    dst = write_index(root)
    entries, meta = load_index(root)
    stat = {}
    for e in entries:
        stat[(e["type"], e["release"])] = stat.get((e["type"], e["release"]), 0) + 1
    print(f"索引已生成：{dst}")
    print(f"条目总数：{meta['entry_count']}（RULE/CHK 定义锚点）")
    for (t, r), n in sorted(stat.items()):
        print(f"  {t:5s} {r:9s} {n}")
    if meta.get("duplicate_ids"):
        for d in meta["duplicate_ids"]:
            print(f"  [重复定义] {d['id']}: {d['files']}")


def cmd_validate(args):
    root = kb_root_from_args(args)
    entries, meta = load_index(root)
    errors, warns = [], []
    errors += freshness_check(root, meta)
    if meta and meta.get("duplicate_ids"):
        for d in meta["duplicate_ids"]:
            errors.append(f"编号重复（定义锚点）：{d['id']} {d['files']}")
    if entries:
        for e in entries:
            if e["release"] == "published":
                f = e.get("fields") or {}
                if not (f.get("curated_by") or "").strip() and not (f.get("reviewed_on") or "").strip():
                    errors.append(f"已发布条目缺 curated_by/reviewed_on：{e['id']} @ {e['file']}:{e['start']}")
        if not getattr(args, "no_vocab", False):
            warns += vocab_problems(entries, vocab_tokens(root))
    if args.skill_root:
        for sr in args.skill_root:
            e2, w2 = skill_path_problems(os.path.abspath(sr), root)
            errors += e2
            warns += w2
    print("== validate 结果 ==")
    for w in warns:
        print("  [warn ] " + w)
    for e_ in errors:
        print("  [error] " + e_)
    print(f"warn={len(warns)} error={len(errors)}")
    return 1 if errors else 0


def cmd_resolve(args):
    root = kb_root_from_args(args)
    entries, meta = load_index(root)
    if entries is None:
        raise SystemExit("索引缺失：先运行 kb_tool.py index")
    byid = {e["id"]: e for e in entries}
    missing = []
    for ident in args.ids:
        e = byid.get(ident)
        if not e:
            missing.append(ident)
            continue
        print(f"{e['id']} | {e['release']} | {e['file']}:{e['start']}-{e['end']} | {e['hash'][:12]} | {e['title']}")
    if missing:
        print("未找到：" + ", ".join(missing), file=sys.stderr)
        return 1
    return 0


def cmd_query(args):
    root = kb_root_from_args(args)
    entries, meta = load_index(root)
    if entries is None:
        raise SystemExit("索引缺失：先运行 kb_tool.py index")
    out = []
    for e in entries:
        if args.type and e["type"] != args.type:
            continue
        if args.release and e["release"] != args.release:
            continue
        if args.module and not (set(e.get("modules") or []) & set(args.module)):
            continue
        ok = True
        for kv in args.dims_key:
            key, _, val = kv.partition("=")
            have = (e.get("dims") or {}).get(key) or []
            if val and val not in have and have:
                ok = False
                break
        if ok:
            out.append(e)
    for e in sorted(out, key=lambda x: (x["file"], x["start"])):
        print(f"{e['id']} | {e['release']} | {e['file']}:{e['start']}-{e['end']} | {e['title']}")
    print(f"共 {len(out)} 条")
    return 0


def cmd_release(args):
    root = kb_root_from_args(args)
    entries, meta = load_index(root)
    if entries is None:
        raise SystemExit("索引缺失：先运行 kb_tool.py index")
    stat = {}
    for e in entries:
        key = (e["type"], e["release"])
        stat[key] = stat.get(key, 0) + 1
    print("== release 状态 ==")
    for (t, r), n in sorted(stat.items()):
        print(f"  {t:5s} {r:9s} {n}")
    if args.list:
        for e in sorted(entries, key=lambda x: (x["release"], x["file"], x["start"])):
            print(f"  {e['release']:9s} {e['id']:20s} {e['file']}:{e['start']}")
    return 0


def cmd_assemble(args):
    root = kb_root_from_args(args)
    with open(args.profile, encoding="utf-8") as fh:
        raw = json.load(fh)
    if isinstance(raw, dict) and "route_profile" in raw and "dims" not in raw:
        rp = raw["route_profile"]
        methods = [m.get("method") for m in (rp.get("methods") or []) if m.get("method")]
        profile = {
            "dims": {
                "object_type": rp.get("object", {}).get("object_class") and [rp["object"]["object_class"]],
                "method": methods,
            },
            "modules": raw.get("kb_modules") or [],
            "_from": "route_profile",
        }
        profile["dims"] = {k: v for k, v in profile["dims"].items() if v}
    else:
        profile = raw
    hits, misses, candidates, meta, out_bucket = assemble(root, profile)
    lines = []
    lines.append("# 装配清单（kb_tool assemble）")
    lines.append("")
    lines.append(f"- 生成于：{datetime.datetime.now().astimezone().isoformat(timespec='seconds')}")
    lines.append(f"- 索引：{meta.get('generated_at', '?')}（kb_root={meta.get('kb_root')}）")
    lines.append(f"- profile：`{json.dumps(profile, ensure_ascii=False)}`")
    pend = [e for e in hits if e["release"] != "published"]
    pub = len(hits) - len(pend)
    lines.append("")
    lines.append("## 1 发布门禁")
    lines.append(f"- 命中 {len(hits)} 条：published {pub} / pending {len(pend)}")
    if pend:
        ids = "、".join(e["id"] for e in pend[:80])
        lines.append(f"- ⚠️ 命中含 {len(pend)} 条待发布依据 → **试点模式**（意见标 `[依据待发布]`）：{ids}{' …' if len(pend) > 80 else ''}")
    lines.append("")
    lines.append("## 2 命中清单")
    lines.append("")
    lines.append("| id | release | 位置 | 标题 |")
    lines.append("| --- | --- | --- | --- |")
    for e in hits:
        lines.append(f"| {e['id']} | {e['release']} | `{e['file']}:{e['start']}-{e['end']}` | {e['title']} |")
    lines.append("")
    lines.append("## 3 排除及原因（候选范围内未命中）")
    lines.append("")
    lines.append("| id | 原因 | 位置 |")
    lines.append("| --- | --- | --- |")
    for e, reason in misses:
        lines.append(f"| {e['id']} | {reason} | `{e['file']}:{e['start']}` |")
    lines.append(f"候选范围共 {len(candidates)} 条（modules 命中或非空 dims 标签命中），命中 {len(hits)} / 排除 {len(misses)}。")
    lines.append("")
    lines.append("## 4 未纳入候选的归因汇总（其余条目）")
    lines.append("")
    lines.append("| 归因 | 条数 | 示例 id（≤5） |")
    lines.append("| --- | --- | --- |")
    for label, b in sorted(out_bucket.items(), key=lambda kv: -kv[1]["n"]):
        lines.append(f"| {label} | {b['n']} | {', '.join(b['ids'])} |")
    lines.append("")
    text = "\n".join(lines) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"装配清单已写入：{args.out}")
    else:
        sys.stdout.write(text)
    return 0


def cmd_extract(args):
    root = kb_root_from_args(args)
    entries, meta = load_index(root)
    if entries is None:
        raise SystemExit("索引缺失：先运行 kb_tool.py index")
    byid = {e["id"]: e for e in entries}
    for ident in args.ids:
        e = byid.get(ident)
        if not e:
            print(f"未找到 {ident}", file=sys.stderr)
            continue
        path = os.path.join(root, e["file"])
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, start=1):
                if e["start"] <= lineno <= e["end"]:
                    print(line.rstrip("\n"))
        print("-" * 40)


def cmd_selftest(args):
    sample = (
        "### RULE-01-02-551 明确用途/对象/范围/目的（第九条）\n"
        "- **type**: 规则条目｜**authority_level**: 准则｜**confidence**: A（待发布确认）\n"
        "- **source**: 中评协〔2017〕38号 / 第九条\n"
        "- **dims**: object_type[不动产评估] method[] scenario[] stage[承接, 程序执行]｜**modules**: [M-基准要素一致性]\n"
        "- **原文**：「执行不动产评估业务，应当要求委托人明确…。」\n"
        "- **判定要点**：基准要素需一致。\n"
    )
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".md", encoding="utf-8", delete=False) as fh:
        fh.write(sample)
        tmp = fh.name
    try:
        es, _h = parse_file(tmp, "t.md")
        assert len(es) == 1, es
        e = es[0]
        assert e["id"] == "RULE-01-02-551"
        assert e["release"] == "pending"
        assert e["dims"] == {"object_type": ["不动产评估"], "method": [], "scenario": [], "stage": ["承接", "程序执行"]}
        assert e["modules"] == ["M-基准要素一致性"]
        assert dims_hit({"method": ["市场法"]}, {"method": ["市场法"], "object_type": ["不动产评估"]}) is None
        r = dims_hit({"method": ["收益法"]}, {"method": ["市场法"]})
        assert r and "收益法" in r, r
        print("selftest OK")
        return 0
    finally:
        os.unlink(tmp)


def main():
    ap = argparse.ArgumentParser(description="crwu 知识库工具（只读索引/校验/装配）")
    ap.add_argument("--root", help=f"KB 根（缺省 $CRWU_KB_ROOT 或 {KB_DEFAULT}）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_index = sub.add_parser("index", help="从 md 生成/刷新 kb-index.jsonl")
    p_index.set_defaults(fn=cmd_index)

    p_v = sub.add_parser("validate", help="索引新鲜度/编号唯一/发布字段/词表/技能引用路径校验")
    p_v.add_argument("--skill-root", action="append", help="额外扫描的引用目录（如 crwu-ai/skills），可多次")
    p_v.add_argument("--no-vocab", action="store_true", help="跳过词表 warn 检查")
    p_v.set_defaults(fn=cmd_validate)

    p_r = sub.add_parser("resolve", help="按 id 定位 文件/行号/状态/hash")
    p_r.add_argument("ids", nargs="+")
    p_r.set_defaults(fn=cmd_resolve)

    p_q = sub.add_parser("query", help="按 type/release/module/dims 查询")
    p_q.add_argument("--type", choices=["RULE", "CHK"])
    p_q.add_argument("--release", choices=["published", "pending", "unknown"])
    p_q.add_argument("--module", action="append")
    p_q.add_argument("--dims-key", dest="dims_key", action="append", default=[], metavar="key=value")
    p_q.set_defaults(fn=cmd_query)

    p_rel = sub.add_parser("release", help="发布状态汇总")
    p_rel.add_argument("--list", action="store_true")
    p_rel.set_defaults(fn=cmd_release)

    p_a = sub.add_parser("assemble", help="route_profile/画像 JSON → 装配清单（命中/排除/门禁）")
    p_a.add_argument("--profile", required=True, help="画像 JSON 文件（见 examples/）")
    p_a.add_argument("--out", help="输出 md 文件（缺省 stdout）")
    p_a.set_defaults(fn=cmd_assemble)

    p_x = sub.add_parser("extract", help="按 id 打印规则段落原文")
    p_x.add_argument("ids", nargs="+")
    p_x.set_defaults(fn=cmd_extract)

    p_s = sub.add_parser("selftest", help="解析/匹配自检")
    p_s.set_defaults(fn=cmd_selftest)

    args = ap.parse_args()
    try:
        code = args.fn(args)
    except BrokenPipeError:
        code = 0
    sys.exit(code if isinstance(code, int) else 0)


if __name__ == "__main__":
    main()
