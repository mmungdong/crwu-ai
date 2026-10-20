# 审核链路 OCR 兜底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让审核链路上 pypdf 读不到的 PDF 页与独立图片由 `crwu-ocr` 兜底，并把兜底结果按页序合并成一份可顺读的文本；pypdf 能读的一切保持逐字节不变。

**Architecture:** `prepare_materials.py` 只多算“哪些页 pypdf 读不到”并写 `ocrRequired[]`（兜底清单）；`crwu-ocr` 新增 `--only` 限定索引范围、新增 `ocr_merge.py` 产出 `ocr/merged/<sourceId>.txt`；审核按“pypdf 优先 → OCR 兜底 → 合并文本顺读”消费，覆盖由 `ocr_status.py` 判定。

**Tech Stack:** Python 3（DSH 自带解释器）、pypdf、Pillow、pypdfium2/CoreGraphics（随 `crwu-ocr` 包）、unittest、Node/TypeScript（仅提示词文案）。

**Spec:** `docs/superpowers/specs/2026-10-20-audit-ocr-fallback-design.md`

## Global Constraints

- **pypdf 优先**：`提取/<文件>.txt` 的文件名、内容、页分隔符、写入时机**逐字节不变**；OCR 只在 pypdf 读不到时介入。
- **兜底按页**：整份 PDF 不因个别空页而重做；`ocrRequired` 必须精确到页号。
- **默认不分卷**：`ocr_merge.py` 单文件输出；`--split-pages N` 是显式选项。
- **未核 ≠ 缺失**：`pending` / `unreadable` 只能进 `notCheckedItems`；合并文本里的占位是显式事实，不得当作“本页为空”。
- **不装依赖**：只用 DSH 自带 Python 与随包 wheel；缺依赖是能力缺口，不是 `pip install` 的理由。
- **测试干净**：所有 Python 测试与脚本调用带 `PYTHONDONTWRITEBYTECODE=1`（残留 `__pycache__` 会让 `pack:assert` 判脏）。
- **提交受控**：本仓库规则是“未经用户明确要求不提交”。下面每个 Commit 步骤都需要用户在本轮开始时一次性授权；未授权就跳过并留待用户提交。

## Review Focus

最可能被忽略、但用户一定会遇到的输入/状态（每条都在对应任务里钉了测试）：

1. **加密 PDF**：期望“进兜底清单、盘点不中断”，不是整个盘点崩掉 → Task 1 `test_encrypted_pdf_is_flagged_not_fatal`。
2. **只有空白字符的页**（`"  \n "`）：期望判为 `empty` 页并进清单，不是 `withText` → Task 1 `test_whitespace_only_page_counts_as_empty`。
3. **`--only` 给了不存在的文件 / 绝对路径 / 含 `..`**：期望退出码 2 且不写坏既有索引 → Task 2 `test_09_only_rejects_missing_or_escaping_paths`。
4. **某页判读失败但该页有文本层**：期望合并文本仍用文本层原文，不写占位（判读失败不该覆盖已有文字）→ Task 3 `test_merge_falls_back_to_text_layer_when_recognition_unreadable`。
5. **分卷模式**：期望 `mergedParts` 与磁盘文件一一对应、页号连续不重复 → Task 3 `test_merge_split_pages_writes_contiguous_parts`。

---

### Task 1: 兜底清单（`prepare_materials.py`）

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/scripts/prepare_materials.py`（`pdf_to_text` 约 397 行；PDF 分支约 982 行；`payload` 约 1163 行；`prepare()` 返回值约 1185 行）
- Test: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/scripts/test_prepare_materials.py`
- Modify: `Makefile:136` 附近（把这份契约测试接进 `plugin-check`）

**Interfaces:**
- Produces（后续任务与文档依赖的精确形状）：
  - `pdf_pages_and_text(path: str) -> tuple[list[str], str]`（逐页原文、整份拼接文本）
  - `_join_pages(pages: list[str]) -> str`（复刻旧格式：首行前导 `\n`，页间双换行）
  - `pdf_to_text(path: str) -> tuple[str, str | None]`（签名不变；`< 50` 字时返回旧提示语）
  - `pdf_page_stats(pages: list[str]) -> dict`（`{total, withText, empty, emptyPages}`，`empty` 判据为 `page.strip() == ""`）
  - 材料记录新增 `textPages: {total, withText, empty, emptyPages: list[int]}`、`textSource: "pypdf" | "ocr-required" | "none"`
  - `材料盘点.json` 新增顶层 `ocrRequired: list[{path, stage, kind, reason, emptyPages, pageCount}]`，`reason ∈ {"no-text-layer","empty-pages","pypdf-error","encrypted","image-source"}`
  - `prepare()` 返回值新增 `ocrRequiredCount: int`

- [ ] **Step 1: 写失败测试（7 条，追加到 `PrepareMaterialsContractTest`）**

用 `pypdf.PdfWriter` 造夹具（与 `crwu-ocr/scripts/test_ocr_flow.py` 的 `build_fixtures` 同法：`add_blank_page` + `Helvetica` 内容流），逐条断言：

```python
def test_text_pdf_is_not_flagged_for_ocr(self):
    # 2 页有字 → ocrRequired == []
    # item["textSource"] == "pypdf"
    # item["textPages"] == {"total": 2, "withText": 2, "empty": 0, "emptyPages": []}

def test_pdf_with_blank_page_is_flagged_with_exact_pages(self):
    # 3 页，第 2 页空白 → ocrRequired[0]["reason"] == "empty-pages"
    # ocrRequired[0]["emptyPages"] == [2]；item["textSource"] == "ocr-required"

def test_whitespace_only_page_counts_as_empty(self):
    # 第 2 页内容流写 "   " → emptyPages == [2]（空白不算有字）

def test_pdf_without_text_layer_is_flagged(self):
    # 2 页全空白 → reason == "no-text-layer"；pageCount == 2

def test_pdf_error_is_flagged_not_fatal(self):
    # 写 b"%PDF-1.7\nnot a pdf" → prepare() 不抛异常
    # ocrRequired[0]["reason"] == "pypdf-error"；item["readable"] is False

def test_encrypted_pdf_is_flagged_not_fatal(self):
    # writer.encrypt("pw") → reason == "encrypted"，prepare() 不抛异常

def test_standalone_image_is_flagged(self):
    # 一张 jpg → kind == "image"，reason == "image-source"，textSource == "ocr-required"

def test_extracted_text_is_byte_identical(self):
    # 2 页 PDF → (case/"提取/报告.pdf.txt").read_text(encoding="utf-8") ==
    # "\n===== 第 1 页 =====\n<page1>\n\n===== 第 2 页 =====\n<page2>"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-audit/scripts/test_prepare_materials.py
```

Expected: 新增用例 FAIL（`KeyError: 'ocrRequired'` / `AttributeError`），既有用例仍 PASS。

- [ ] **Step 3: 实现逐页抽取与统计**

在 `pdf_to_text` 旁新增：

```python
def pdf_pages_and_text(p: str) -> tuple[list[str], str]:
    """逐页原文 + 旧格式拼接文本；加密文件不抛异常，由调用方登记 reason。"""
```

- `PdfReader` 打开后若 `reader.is_encrypted` → 抛 `ValueError("encrypted")`（调用方捕获并记 `encrypted`）；
- 逐页 `page.extract_text() or ""`；
- `txt = _join_pages(pages)`，`_join_pages` 用 `"\n".join(f"\n===== 第 {i} 页 =====\n{t}" for i, t in enumerate(pages, 1))`；
- `pdf_to_text` 改为调用它，`len(txt.strip()) < 50` 时返回原提示语 `"PDF 无文本层或内容极少（疑扫描件）"`。

新增 `pdf_page_stats(pages) -> dict`：`empty` 判定为 `page.strip() == ""`，`emptyPages` 为 1 起页号。

- [ ] **Step 4: 接进 PDF 分支与盘点**

- `process()` 的 `.pdf` 分支：先取 `(pages, txt)`，写 `提取/`（内容与旧逻辑一致），再写
  `rec["textPages"] = pdf_page_stats(pages)`、`rec["textSource"]`；捕获 `encrypted` / 其它异常时
  `rec["textSource"] = "ocr-required"` 并把条目追加进新增的 `ocr_required` 列表（在 `prepare()` 里与
  `archives` / `sheet_anomalies` 并列初始化）；
- `reason` 判定顺序：`encrypted` → `pypdf-error` → 整份 `< 50` 字 → `no-text-layer` → 有空页 → `empty-pages`；
- 图片分支：`rec["textSource"] = "ocr-required"`，追加 `{kind: "image", reason: "image-source", emptyPages: [], pageCount: 1}`；
- 其它格式：`rec["textSource"] = "none"`；
- `payload["ocrRequired"] = ocr_required`；`prepare()` 返回值加 `"ocrRequiredCount": len(ocr_required)`。

- [ ] **Step 5: 跑全部用例确认通过**

```bash
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-audit/scripts/test_prepare_materials.py
```

Expected: ALL PASS（含既有 30+ 用例），`test_extracted_text_is_byte_identical` PASS 证明旧文本未变。

- [ ] **Step 6: 把这份契约测试接进门禁**

`Makefile` 在 `test_audit_multiaxis_router.py` 那行之后追加：

```make
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-audit/scripts/test_prepare_materials.py
```

- [ ] **Step 7: Commit（需用户授权）**

```bash
git add plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/scripts/prepare_materials.py \
        plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/scripts/test_prepare_materials.py Makefile
git commit -m "feat(audit): flag pages pypdf cannot read for OCR fallback"
```

---

### Task 2: `ocr_prepare.py --only`

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_prepare.py`（`scan_materials` 约 366 行、`main` 约 385 行）
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`

**Interfaces:**
- Produces：`scan_materials(case_dir: str, src_dirs: list[str], only: list[str] | None = None) -> tuple[list[str], list[dict]]`；CLI `--only <案例内相对路径>`（可重复）。
- Consumes：Task 1 产出的 `ocrRequired[].path`（案例内相对路径，如 `材料-源/报告.pdf`）。

- [ ] **Step 1: 写失败测试**

```python
def test_07_only_indexes_listed_files_only(self):
    # 先整目录 prepare 一次，记下 报告.pdf / 现场照片.jpg / 扫描件.tif 的 page 指纹
    # 再 --only 材料-源/报告.pdf 重跑 → index.sources 只含该来源
    # 其余来源的页图 sha256 与识别记录不变（未被重渲染、未被丢弃）

def test_08_only_rejects_reset_and_src(self):
    # --only X --reset → returncode 2, errorKind "input"
    # --only X --src 材料-源 → returncode 2, errorKind "input"

def test_09_only_rejects_missing_or_escaping_paths(self):
    # --only ../etc/passwd → 2
    # --only /abs/report.pdf → 2
    # --only 材料-源/不存在.pdf → 2，且 index.json 未被改写
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
```

Expected: 3 条新用例 FAIL（`--only` 未定义 → 退出码 2 但错误文案不符 / 索引未按清单收敛）。

- [ ] **Step 3: 实现**

- `main`：`parser.add_argument("--only", action="append", default=None)`；
- 校验顺序：`--only` 与 `--reset` 同用 / 与 `--src` 同用 → `input` 错误、`EXIT_USAGE`；
  每个 `--only` 值：`os.path.isabs` 或含 `..` 或扩展名不在 `PDF_EXTS + IMAGE_EXTS` 或文件不存在
  → `input` 错误（一次列出全部问题路径），**不写入 index**；
- `scan_materials(case_dir, src_dirs, only=None)`：`only` 非空时直接返回 `(sorted(only), [])`；
- 保留既有 `--reset` 语义：`--only` 模式下不触发 `--reset` 分支（已被上一步拒绝）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
```

Expected: ALL PASS（含既有 01–06）。

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_prepare.py \
        plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
git commit -m "feat(ocr): limit indexing to an explicit fallback list with --only"
```

---

### Task 3: `ocr_merge.py`（页序合并文本）

**Files:**
- Create: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_merge.py`
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`

**Interfaces:**
- Consumes：`ocr/index.json` 的 `sources[].pages[]`（`page`、`image`、`imageSha256`、`textPath`、`textStatus`、`visualStatus`、`renderError`）；`ocr/recognition/<sourceId>.json` 的 `pages[]`（`page`、`status`、`text`）。
- Produces：
  - `merge_source(case_dir: str, source: dict, recognition: dict, split_pages: int = 0) -> dict`
    返回 `{sourceId, mergedTextPath, mergedDigest, mergedPages, mergedParts}`
  - 文件 `ocr/merged/<sourceId>.txt` 或 `ocr/merged/<sourceId>.partNN.txt`
  - `index.json` 每个来源新增 `mergedTextPath` / `mergedDigest` / `mergedPages` / `mergedParts`
  - CLI：`--case`、`--source`（可重复，缺省全部）、`--split-pages N`

- [ ] **Step 1: 写失败测试**

```python
def test_10_merge_orders_pages_and_labels_sources(self):
    # 报告.pdf 第 1 页有文本层、第 2 页空白（判读后写入记录）、第 3 页有文本层
    # merged 文件按 1,2,3 顺序；页头含 "来源: 文本层" / "来源: 页图判读"；含 "sha256: " + sha[:12]

def test_11_merge_placeholder_for_pending_page(self):
    # 一页 visualStatus=pending 且 textStatus=empty
    # → 该页正文为 "[第 N 页 未判读：pending]"，不是空行

def test_12_merge_falls_back_to_text_layer_when_recognition_unreadable(self):
    # 该页 visualStatus=unreadable 但 textStatus=ok → 用文本层原文，不出现 "未判读"

def test_13_merge_split_pages_writes_contiguous_parts(self):
    # --split-pages 1（3 页）→ 3 个 part 文件；mergedParts 数量一致；
    # 各卷首行页码连续、无重复；mergedTextPath 指向 part01

def test_14_merge_digest_covers_body_only(self):
    # 连续两次 merge（无新记录）→ mergedDigest 相同
    # 补记一页后重跑 → mergedDigest 变化且该页正文更新
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
```

Expected: 5 条新用例 FAIL（脚本不存在）。

- [ ] **Step 3: 实现 `ocr_merge.py`**

固定格式（测试与文档都以此为准）：

```text
# {relativePath} · {pageCount} 页 · 合并于 {ISO8601} · 来源 {sourceId}
===== 第 {n} 页 | 来源: {页图判读|文本层|未判读} | sha256: {imageSha256[:12]} | 状态: {status} =====
{正文}
```

- 正文取值：识别记录 `text.strip()` 非空 → 用它（`来源: 页图判读`）；否则 `textStatus == "ok"` → 读 `textPath`
  （`来源: 文本层`）；否则 `[第 {n} 页 未判读：{no-text-layer|pending|unreadable|render-failed}]`；
- `status` 取 `visualStatus`（`renderError` 非空时用 `render-failed`）；
- `mergedDigest = sha256(正文部分)`，**不含首行时间戳**，保证幂等重跑不变；
- `--split-pages N`：按 N 页切卷，每卷自带首行头（时间戳同一时刻）+ 该卷页段；`mergedPages` 为总页数；
- 写盘前 `os.makedirs(ocr/merged, exist_ok=True)`；只更新 `index.json` 中本次合并的来源，其它字段原样保留。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
```

Expected: ALL PASS（含 01–09）。

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_merge.py \
        plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
git commit -m "feat(ocr): merge recognised pages into one continuous per-source text"
```

---

### Task 4: 文档、提示词、变更日志与版本

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/references/00-input-and-route-profile.md`（§「媒体锚点隔离」/「读不到 ≠ 材料缺失」两段：产物清单加 `ocrRequired`、实施段加兜底链）
- Modify: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/references/14-orchestration-workflow.md`（步骤 11 与 12：先看 `ocrRequired`，再 `--only` 索引，最后 `ocr_merge` 顺读）
- Modify: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/scripts/README.md`（产物清单与命令示例）
- Modify: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/SKILL.md`（若列出脚本产物，同步加 `ocrRequired` 与 `ocr/merged/`）
- Modify: `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit-datacheck/references/01-runtime-and-check-catalog.md`（兜底链一句话，避免各写一套）
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-audit/prompt.ts:255-272`（`ocrSection()`：加“pypdf 读不到才兜底”“`--only`”“`ocr_merge.py`”三步）
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/local-audit/prompt.ts:84`（同口径）
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/SKILL.md`（执行步骤加第 4.5 步合并；依赖/产物表加 `ocr/merged/`）
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/references/01-execution-contract.md`（`--only` 契约、`ocr_merge.py` 契约与退出码）
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/README.md`（脚本清单加 `ocr_merge.py`）
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`、`VERSION`、`package.json`（`make plugin-version-set`）

**Interfaces:**
- Consumes：Task 1 的 `ocrRequired[]`、Task 2 的 `--only`、Task 3 的 `ocr_merge.py`（文档只描述已实现的行为，不预告）。

- [ ] **Step 1: 先改 `crwu-ocr` 侧文档**

`SKILL.md` 执行步骤插入：“4.5 全部页记录完毕后跑 `ocr-skill/scripts/ocr_merge.py --case <案例目录>`，
产出 `ocr/merged/<sourceId>.txt`（页序、页头含来源与 sha 前 12 位、未判读页显式占位）；页数多时可
`--split-pages N` 分卷，默认单文件。”产物表加一行 `ocr/merged/<sourceId>.txt`。
`01-execution-contract.md` 增“§4.5 `ocr_prepare.py --only`”与“§4.6 `ocr_merge.py`”两小节，写清退出码
（`0` 成功 / `2` 参数错误）与 `--only` 与 `--reset`、`--src` 互斥。

- [ ] **Step 2: 再改 `crwu-audit` 侧文档**

`00-input-and-route-profile.md` 的产物清单改为：“`prepare_materials.py` 产出 `工作版/`、`提取/`、
`材料盘点.json`（含 `ocrRequired[]`）、`媒体证据/` + `媒体索引.json`”；同段加一句：
“`提取/*.txt` 是 pypdf 文本（不变）；`ocrRequired[]` 里的文件与页由 `crwu-ocr` 兜底，读
`ocr/merged/<sourceId>.txt` 顺读，覆盖以 `ocr_status.py` 为准。”
`14-orchestration-workflow.md` 步骤 11 插三步：`ocrRequired` 非空 → `ocr_prepare.py --only …` →
判读记录 → `ocr_merge.py`；步骤 12 复核件同法（`--src 复核-人工` + `--only`）。

- [ ] **Step 3: 改两只提示词**

`report-audit/prompt.ts` 的 `ocrSection()` 第 1 步改为：“先看 `材料盘点.json` 的 `ocrRequired[]`；
非空时用 `--only` 只索引清单内文件，**不要**为可读 PDF 白渲染”；末尾加第 5 步：“全部记录后跑
`ocr_merge.py`，按 `ocr/merged/<sourceId>.txt` 页序顺读；占位页只能记未核。”
`local-audit/prompt.ts:84` 同步同样三句（保持本地审核无 `材料盘点` 时改为“清单来自盘点或人工指定”）。

- [ ] **Step 4: 变更日志与版本**

```bash
cd plugins/dsh-crwu-workbench
make -C ../.. plugin-version
make -C ../.. plugin-version-set PLUGIN_RELEASE_VERSION=<下一补丁版>
```

然后在 `CHANGELOG.md` 顶部补一节：`feat · 审核 PDF 文字 OCR 兜底与连贯合并文本`，写清
`ocrRequired`、`--only`、`ocr/merged/` 三件事与“`提取/*.txt` 不变”的口径。

- [ ] **Step 5: 跑文档与包门禁**

```bash
make docs-check
make plugin-check
cd plugins/dsh-crwu-workbench && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/capabilities
```

Expected: 全部通过；`skills:check` 不应报技能清单不一致。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add plugins/dsh-crwu-workbench/skills plugins/dsh-crwu-workbench/src/host/domains \
        plugins/dsh-crwu-workbench/CHANGELOG.md plugins/dsh-crwu-workbench/VERSION \
        plugins/dsh-crwu-workbench/package.json docs/superpowers
git commit -m "docs(audit): document OCR fallback chain and merged text"
```

---

## 验收（对应 spec §9）

1. “正文可读 + 2 页扫描件”的 PDF：`提取/<文件>.pdf.txt` 与改造前逐字节一致；`ocrRequired` 命中且 `emptyPages` 为那 2 页。
2. 跑完五步后 `ocr/merged/<sourceId>.txt` 可按页顺读，扫描页来源标 `页图判读`。
3. 未判读页是显式占位，`ocr_status.py` 报 `pending`，审核只能记 `notCheckedItems`。
4. 纯文本 PDF 不产生页图、不进清单，审核行为与今天一致。
5. 无渲染引擎平台上兜底整类停止并给出员工可执行动作，不出现“材料缺失/为空”。
