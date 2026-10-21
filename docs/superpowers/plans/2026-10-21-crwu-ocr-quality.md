# crwu-ocr 识别质量与规模自适应 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `crwu-ocr` 上增加"关键字段可回指 + 高风险页双读 + 预算自适应"，让识别错误可见、可度量，同时不改变 pypdf 优先的兜底链。

**Architecture:** 判读档位、风险等级、预算全部由 Python 脚本按规则计算；模型只负责读页图并按契约写记录。关键字段以"本页原文的逐字片段"为锚做校验，双读结果不一致标冲突而不选值。新增字段全部可选，旧索引与旧记录继续可读。

**Tech Stack:** Python 3.12（DSH 自带运行时，含 Pillow；pypdf 随包）、unittest、JSON Schema、TypeScript 提示词（仅文案）。

**Spec:** `docs/superpowers/specs/2026-10-21-crwu-ocr-quality-design.md`

## Global Constraints

- **不自动提交**：仓库 `AGENTS.md` 规定未经用户明确要求不得 commit/push；本计划的每个任务以"验证点"结束，不写 commit 步骤。
- **不新增 Host 暂存的运行脚本**：`OCR_RUNTIME_FILES` 与 `ocr-skill/scripts/...` 白名单保持四个脚本不变；`ocr_bench.py` 只是维护期脚本。
- **不改既有语义**：`提取/*.txt`、`材料盘点.json` 的 `ocrRequired[]`、`pending/unreadable` 的含义一律不动。
- **解释器**：所有 Python 测试用 `PY="$(node scripts/resolve-dsh-python.mjs)"` 解析出的 DSH 自带 Python 运行，不用系统 `python3`。
- **平台**：macOS 与 Windows 都必须能做同样的断言；测试不得依赖 `textutil`、`pdftoppm` 等单一平台命令。
- **`--budget` 语义**：缺省 `None` = 按公式；显式 `0` = 禁止双读；`budget.exhausted = doubleReads >= maxDoubleReads`（仅用于说明"未做双读"）。
- **字段名与枚举**：严格按 spec §3 拼写（`pageClass`、`riskTier`、`policy`、`renders`、`pendingReason`、`budget`、`keyValues`、`conflicts`、`reads`、`recognizer`、`recognitionStatus`、`notVerified`）。
- **注释语言**：代码注释用英文；文档与用户可见文案用简体中文。

## File Structure

| 文件 | 职责 |
|---|---|
| `skills/capabilities/crwu-ocr/scripts/ocr_runtime.py` | 新增纯函数：文本/数值规范化、quote 校验、页号选择解析 |
| `skills/capabilities/crwu-ocr/scripts/ocr_prepare.py` | 分级、策略、按页渲染变体、预算、`--re-render` |
| `skills/capabilities/crwu-ocr/scripts/ocr_record.py` | keyValues 校验、reads、冲突、escalate、recognizer |
| `skills/capabilities/crwu-ocr/scripts/ocr_status.py` | conflict / budget / notVerified 汇总 |
| `skills/capabilities/crwu-ocr/scripts/ocr_merge.py` | 页头档位与次数、冲突说明行 |
| `skills/capabilities/crwu-ocr/scripts/ocr_bench.py` | **新建**：维护期指标计算 |
| `skills/capabilities/crwu-ocr/scripts/test_ocr_runtime.py` | 纯函数测试 |
| `skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py` | 端到端测试（新增用例） |
| `skills/capabilities/crwu-ocr/scripts/test_ocr_bench.py` | **新建**：指标测试 |
| `skills/capabilities/crwu-ocr/schemas/*.json` | 契约字段 |
| `skills/capabilities/crwu-ocr/SKILL.md`、`references/01`、`references/03` | 使用与契约文档 |
| `src/host/domains/report-audit/prompt.ts`、`src/host/domains/local-audit/prompt.ts` | 提示词文案（关键字段/冲突/预算） |
| `scripts/assert-pack.mjs` | 打包断言补齐 |

## Review Focus

1. **有文本层但乱码的页**：`textStatus=garbled` 时不得被当成"可读"直接引用，必须进判读并可能升级（Task 2 `test_22` 断言 `visual_reasons` 含 `text-garbled`、风险为 high）。
2. **跨行/带空格的原文**：`quote` 校验按"去空白后子串"比较，跨行、全角空格都要通过；改一个字必须失败（Task 1 `NormalizeTest`、Task 3 `test_23`）。
3. **混合件只动该页**：一份 PDF 只有一页是扫描件时，`--re-render pages:N` 不得重渲其它页、不得改它们的渲染记录（Task 2 `test_20`）。
4. **重渲后的旧记录**：页图重渲会让旧 `imageSha256` 失效；旧识别记录不得被挂到新图上，必须报 `stale`（Task 3 `test_28`）。
5. **预算耗尽的中途状态**：预算只停止双读，已读页保持已读、单次判读不得被说成双读，未读页不得被说成已核（Task 4 `test_30`、Task 3 `test_26`）。

---

### Task 1: 规范化与抽取纯函数

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_runtime.py`
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_runtime.py`

**Interfaces:**
- Consumes: 标准库 `unicodedata`、`re`。
- Produces（后续任务按这些签名调用）：
  - `normalize_text(value: str) -> str` —— NFKC 后去掉全部空白。
  - `quote_in_text(text: str, quote: str) -> bool` —— 两侧 `normalize_text` 后做子串判断；空 quote 返回 `False`。
  - `normalize_value(raw: str) -> str` —— NFKC、去空白、去 `,`/`，`/`¥`/`￥`/`$`/`元`、`．`→`.`、全角数字转半角；非数值内容只做 NFKC 与去空白。
  - `value_in_quote(value: str, quote: str) -> bool` —— `normalize_value(value)` 非空且是 `normalize_value(quote)` 的子串。
  - `parse_page_selection(spec: str) -> set[int]` —— 解析 `1,3-5`；空串、`0`、倒序区间、非数字抛 `ValueError`。

- [ ] **Step 1: 写失败测试**

在 `test_ocr_runtime.py` 末尾追加（沿用该文件已有的 `import ocr_runtime`）：

```python
class NormalizeTest(unittest.TestCase):
    def test_quote_matches_across_line_breaks(self):
        text = "评估值：人民币\n12,345,678.00 元"
        self.assertTrue(ocr_runtime.quote_in_text(text, "评估值：人民币 12,345,678.00 元"))

    def test_quote_rejects_single_character_change(self):
        text = "评估值：人民币 12,345,678.00 元"
        self.assertFalse(ocr_runtime.quote_in_text(text, "评估值：人民币 12,345,687.00 元"))

    def test_value_normalization_ignores_separators(self):
        self.assertEqual("12345678.00", ocr_runtime.normalize_value(" ￥12,345,678.00 元 "))

    def test_value_in_quote(self):
        quote = "评估值：人民币 12,345,678.00 元"
        self.assertTrue(ocr_runtime.value_in_quote("12345678.00", quote))
        self.assertFalse(ocr_runtime.value_in_quote("12345687.00", quote))

    def test_parse_page_selection(self):
        self.assertEqual({1, 3, 4, 5}, ocr_runtime.parse_page_selection("1,3-5"))
        for bad in ("", "0", "5-3", "x", "1,,2"):
            with self.assertRaises(ValueError):
                ocr_runtime.parse_page_selection(bad)
```

- [ ] **Step 2: 运行确认失败**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_runtime.py NormalizeTest -v`
Expected: FAIL / ERROR，`AttributeError: module 'ocr_runtime' has no attribute 'quote_in_text'`

- [ ] **Step 3: 实现四个函数**

在 `ocr_runtime.py` 的 `safe_join` 之前加入实现；`normalize_value` 用 `str.translate` 处理全角数字，`parse_page_selection` 逐段判断，错误信息里带上非法片段（供 `ocr_record` 直接转成 `input` 错误）。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2。
Expected: `Ran 5 tests ... OK`

- [ ] **Step 5: 验证点（不提交）**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_runtime.py -v`
Expected: 原 9 项 + 新 5 项全部 OK。

---

### Task 2: 分级、策略、按页渲染变体与预算

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_prepare.py`
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`

**Interfaces:**
- Consumes: Task 1 的 `parse_page_selection`。
- Produces：
  - `page_class(kind: str, text_status: str) -> str` → `text|scan|image`。
  - `initial_risk(kind: str, text_status: str, reasons: list[str]) -> str` → `high|normal|low`。
  - `initial_dpi(policy: str, risk: str, page_count: int, base_dpi: int) -> int`。
  - `budget_for(required: int, policy: str, override: int | None) -> dict` → `{pagesRequired, maxDoubleReads, doubleReads: 0, imageCalls: 0, elapsedMs: 0, exhausted: False}`；`override is None` 时用公式 `min(10, required, max(3, ceil(0.2*required)))`（`required<=0` 全 0），否则用 `min(override, required)`。**`--budget 0` 表示显式零双读，不是"未设置"**。
  - `render_rel_path(source_id: str, stem: str, page_no: int, dpi: int, base_dpi: int) -> str` —— `dpi==base_dpi` 用无后缀旧路径，否则 `_pageNNNN@<dpi>.png`。
  - `tile_images(image, out_base: str, overlap: float = 0.10) -> list[dict]` —— 2×2 裁切，返回 `[{index, image, imageSha256, width, height}]`，文件名 `<out_base>_t1.png`…`_t4.png`；重叠按短边 10% 计算。
  - 新 CLI：`--policy {fast,auto,quality}`（默认 `auto`）、`--budget N`（默认 `None`）、`--re-render "pages:3,7-9"`、`--mode {dpi-retry,tile}`（默认 `dpi-retry`，仅与 `--re-render` 同用）。

**行为约束：**
- `fast`：全部页 `policy={dpi: base, doubleRead: False, mode: "none"}`。
- `auto`：按 spec §4.1；整份无文本层且 `pageCount > 50` 时首轮用 base DPI。
- `quality`：所有 `high` 页首次即 200，越过大页数保护。
- 每页 `renders[]` 至少一条；首条 `n=1`；同 DPI 且文件 sha 与记录一致则复用。
- `--re-render ... --mode tile`：整页图照常渲染并写入 `renders[].image`，四张裁切写入 `tiles[]`，`renders[].mode="tile"`；`--mode dpi-retry` 时 `tiles=[]`、`mode="page"`。
- `--re-render` 只处理列出的页：追加 `n=len+1` 的渲染、更新页级 `image/imageSha256`，其它页渲染记录字节不变；每次追加把顶层 `budget.doubleReads` 加一。
- 带 `garbled` 文本层的页按 `scan` 分类、`high` 风险处理（见 Task 1 的 `text_quality`）。
- `--re-render` 与 `--reset` 可同用（语义不冲突）；在 `--only` 模式下只允许命中被索引的来源。

- [ ] **Step 1: 写失败测试**

在 `test_ocr_flow.py` 的 `OcrFlowTest` 里追加（helper 已存在：`self.prepare(*extra)`、`self._source(rel)`；`load/dump` 已在文件顶部导入）：

```python
    def _index_source(self, relative):
        index = load(os.path.join(self.case, "ocr", "index.json"))
        return next(item for item in index["sources"] if item["relativePath"] == relative)

    def test_17_policy_fast_keeps_base_dpi_and_no_double_read(self):
        self.prepare("--only", "材料-源/报告.pdf", "--policy", "fast")
        pages = self._index_source("材料-源/报告.pdf")["pages"]
        self.assertEqual([144] * 3, [page["policy"]["dpi"] for page in pages])
        self.assertEqual(["none"] * 3, [page["policy"]["mode"] for page in pages])
        self.assertEqual([False] * 3, [page["policy"]["doubleRead"] for page in pages])

    def test_18_auto_marks_scan_and_empty_pages_high(self):
        self.prepare("--only", "材料-源/报告.pdf", "--only", "材料-源/现场照片.jpg")
        report = self._index_source("材料-源/报告.pdf")["pages"]
        self.assertEqual("high", report[1]["riskTier"])
        self.assertEqual(200, report[1]["policy"]["dpi"])
        self.assertEqual("normal", report[0]["riskTier"])
        photo = self._index_source("材料-源/现场照片.jpg")["pages"][0]
        self.assertEqual(("image", "high", 200),
                         (photo["pageClass"], photo["riskTier"], photo["policy"]["dpi"]))

    def test_19_tile_render_writes_full_page_and_four_crops(self):
        self.prepare("--only", "材料-源/报告.pdf")
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2",
                     "--dpi", "200", "--mode", "tile")
        page = self._index_source("材料-源/报告.pdf")["pages"][1]
        render = page["renders"][1]
        self.assertEqual("tile", render["mode"])
        self.assertEqual(4, len(render["tiles"]))
        self.assertTrue(render["image"].endswith("@200.png"))
        self.assertTrue(os.path.isfile(os.path.join(self.case, *render["image"].split("/"))))
        for tile in render["tiles"]:
            self.assertTrue(os.path.isfile(os.path.join(self.case, *tile["image"].split("/"))))
        self.assertGreater(render["tiles"][0]["height"], page["height"] // 2,
                           "裁切必须带重叠，高度应超过整页的一半")

    def test_20_re_render_adds_variant_without_touching_other_pages(self):
        self.prepare("--only", "材料-源/报告.pdf")
        before = self._index_source("材料-源/报告.pdf")["pages"]
        stamps = {page["page"]: page["renders"][0]["imageSha256"] for page in before}
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "300")
        after = self._index_source("材料-源/报告.pdf")["pages"]
        self.assertEqual(2, len(after[1]["renders"]))
        self.assertTrue(after[1]["renders"][1]["image"].endswith("@300.png"))
        self.assertEqual(stamps[1], after[0]["renders"][0]["imageSha256"])
        self.assertEqual(stamps[3], after[2]["renders"][0]["imageSha256"])
        index = load(os.path.join(self.case, "ocr", "index.json"))
        self.assertEqual(1, index["budget"]["doubleReads"])

    def test_21_re_render_is_idempotent(self):
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "300")
        first = self._index_source("材料-源/报告.pdf")["pages"][1]["renders"][1]["imageSha256"]
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "300")
        page = self._index_source("材料-源/报告.pdf")["pages"][1]
        self.assertEqual(2, len(page["renders"]))
        self.assertEqual(first, page["renders"][1]["imageSha256"])

    def test_22_risk_rules_and_budget_formula(self):
        self.assertEqual(144, ocr_prepare.initial_dpi("auto", "high", 120, 144))
        self.assertEqual(200, ocr_prepare.initial_dpi("quality", "high", 120, 144))
        self.assertEqual("scan", ocr_prepare.page_class("pdf", "garbled"))
        self.assertEqual("high", ocr_prepare.initial_risk("pdf", "garbled", ["text-garbled"]))
        self.assertIn("text-garbled",
                      ocr_prepare.visual_reasons("pdf", "garbled", "乱码", "auto", set(), 1))
        self.assertEqual({"pagesRequired": 42, "maxDoubleReads": 9, "doubleReads": 0,
                          "imageCalls": 0, "elapsedMs": 0, "exhausted": False},
                         ocr_prepare.budget_for(42, "auto", None))
        self.assertEqual(1, ocr_prepare.budget_for(1, "auto", None)["maxDoubleReads"])
        self.assertEqual(5, ocr_prepare.budget_for(42, "auto", 5)["maxDoubleReads"])
        self.assertEqual(0, ocr_prepare.budget_for(42, "auto", 0)["maxDoubleReads"])
```

`test_ocr_flow.py` 顶部需补 `import ocr_prepare`（与已有 `import ocr_engines` 同处）。

- [ ] **Step 2: 运行确认失败**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py OcrFlowTest.test_17_policy_fast_keeps_base_dpi_and_no_double_read -v`
Expected: FAIL，`AttributeError: module 'ocr_prepare' has no attribute 'initial_dpi'` 或 `KeyError: 'policy'`

- [ ] **Step 3: 实现策略与变体渲染**

改 `prepare_pdf` / `prepare_image`：把当前的单一 `args.dpi` 渲染块替换为"对目标 DPI 列表逐个调用 `ensure_render()`"；`ensure_render(case_dir, source_id, stem, page_no, dpi, base_dpi, engine, document, force, mode) -> dict` 返回 `{n, dpi, mode, image, imageSha256, imageBytes, width, height, engine, createdAt, tiles: []}`，命中缓存时复用旧记录。`mode="tile"` 时用 `tile_images()` 生成四张裁切并填入 `tiles`。`main` 里先解析 `--policy/--budget/--re-render/--mode`，参数非法按 `input` 退出码 2；汇总后写顶层 `budget`。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2；再跑 `OcrFlowTest.test_18_...`、`test_19_...` 与 `test_22_...`。
Expected: 四项均 PASS。

- [ ] **Step 5: 验证点（不提交）**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py -v`
Expected: 原 16 项 + 新 6 项全部 OK。

---

### Task 3: 关键字段校验、reads、冲突与升级建议

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_record.py`
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`

**Interfaces:**
- Consumes: Task 1 的 `quote_in_text` / `value_in_quote` / `normalize_value`；Task 2 写入的 `page["renders"]` 与 `index["budget"]`。
- Produces：
  - `validate_key_values(entry: dict, text: str) -> str` —— 返回问题描述或 `""`。
  - `merge_conflicts(previous_page: dict, new_records: list[dict]) -> list[dict]`。
  - `escalate_for(page: dict, record: dict, index: dict) -> list[dict]` —— `[{page, mode}]`，`mode` 取 `tile`（表格行数 ≥10）或 `dpi-retry`（`keyValues` ≥3 / 关键词）。
  - 新 CLI：`--recognizer`，默认 `"session-vision"`；写进识别记录顶层。
  - 新 CLI：`--vision-unavailable` —— 不需要 `--input`；把该来源所有 `pending` 页写 `pendingReason="vision-unavailable"`，输出 `errorKind="capability-gap"`，退出码 3。
  - 记录页新增 `keyValues`、`conflicts`、`reads`、`recognitionStatus`。

**行为约束：**
- `quote` 去空白后必须是本页 `text` 的子串，否则整页拒绝（`errorKind=input`，错误里含 `quote-not-found`），不落盘半成品。
- `value` 必须能在 `quote` 里找到（规范化后），否则拒绝。
- 同页第二次记录时：`reads` 追加 `{n: 旧长度+1, renderN: 当前 renders 长度, status, recordedAt}`；同一 `label` 与上一次值不等 → `conflicts[]` 追加 `{field, values: [旧, 新], reads: [旧n, 新n]}`，页 `recognitionStatus="conflict"`，`visualStatus` 仍为 `done`。
- `escalate` 只在 `recognitionStatus != conflict`、`len(renders) < 2`、且 `budget.doubleReads < budget.maxDoubleReads` 时给出。
- 无视觉/无渲染时沿用既有 `unreadable` 路径。

- [ ] **Step 1: 写失败测试**

```python
    def test_23_quote_must_be_in_page_text(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        code, payload = self._record(report, [{
            "page": 1, "status": "recognized",
            "text": "评估值：人民币 12,345,678.00 元",
            "keyValues": [{"label": "评估值", "value": "12345678.00",
                           "quote": "评估值：人民币 12,345,687.00 元"}],
        }])
        self.assertEqual(2, code)
        self.assertEqual("input", payload["errorKind"])
        self.assertIn("quote", payload["error"])

    def test_24_two_reads_with_different_values_mark_conflict(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        base = {"page": 1, "status": "recognized",
                "text": "评估值：人民币 12,345,678.00 元"}
        self._record(report, [{**base, "keyValues": [
            {"label": "评估值", "value": "12345678.00",
             "quote": "评估值：人民币 12,345,678.00 元"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        code, payload = self._record(report, [{**base, "keyValues": [
            {"label": "评估值", "value": "12345687.00",
             "quote": "评估值：人民币 12,345,687.00 元"}], "uncertainties": ["第二次判读"]}])
        self.assertEqual(0, code, payload)
        recognition = load(os.path.join(self.case, "ocr", "recognition", report["sourceId"] + ".json"))
        page = recognition["pages"][0]
        self.assertEqual("conflict", page["recognitionStatus"])
        self.assertEqual([{"field": "评估值", "values": ["12345678.00", "12345687.00"], "reads": [1, 2]}],
                         page["conflicts"])
        self.assertEqual([1, 2], [read["n"] for read in page["reads"]])

    def test_25_dense_table_escalates_to_tile(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        rows = [["科目", "评估值"]] + [["行%d" % i, str(i)] for i in range(11)]
        code, payload = self._record(report, [{
            "page": 3, "status": "recognized", "text": "表格见下",
            "tables": [{"title": "评估结果", "rows": rows}]}])
        self.assertEqual(0, code, payload)
        self.assertEqual([{"page": 3, "mode": "tile"}], payload["escalate"])

    def test_26_escalation_stops_when_budget_is_spent(self):
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "0")
        report = self._source("材料-源/报告.pdf")
        rows = [["科目", "评估值"]] + [["行%d" % i, str(i)] for i in range(11)]
        code, payload = self._record(report, [{
            "page": 3, "status": "recognized", "text": "表格见下",
            "tables": [{"title": "评估结果", "rows": rows}]}])
        self.assertEqual(0, code, payload)
        self.assertEqual([], payload["escalate"])

    def test_27_vision_unavailable_marks_pending_without_guessing(self):
        self.prepare("--only", "材料-源/报告.pdf")
        code, payload = run(RECORD, ["--case", self.case, "--vision-unavailable"], self.case)
        self.assertEqual(3, code)
        self.assertEqual("capability-gap", payload["errorKind"])
        source = self._index_source("材料-源/报告.pdf")
        pending = [page for page in source["pages"] if page["visualStatus"] == "pending"]
        self.assertTrue(pending)
        self.assertTrue(all(page["pendingReason"] == "vision-unavailable" for page in pending))

    def test_28_re_rendered_page_rejects_old_record(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        old_sha = self._index_source("材料-源/报告.pdf")["pages"][1]["imageSha256"]
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--dpi", "200")
        code, payload = self._record(report, [{
            "page": 2, "status": "recognized", "text": "旧图上的判读", "imageSha256": old_sha}])
        self.assertEqual(2, code)
        self.assertEqual("stale", payload["errorKind"])
```

- [ ] **Step 2: 运行确认失败**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py OcrFlowTest.test_23_quote_must_be_in_page_text -v`
Expected: FAIL，`KeyError: 'escalate'` 或 `validate_page` 未拒绝（返回 0）。

- [ ] **Step 3: 实现校验与记录合并**

在 `validate_page` 之后加 `validate_key_values`；在 `minimal_record` 里带上 `keyValues`；在 `main` 的记录循环里调用校验、构造 `reads`、读写 `recognitionStatus`；在返回 payload 里加 `escalate`。冲突比较只针对本次提交页与上一次已存记录。`--vision-unavailable` 分支在读取 `--input` 之前处理。

- [ ] **Step 4: 运行确认通过**

Run: Step 2 的用例 + `test_24`/`test_25`/`test_26`/`test_27`/`test_28`。
Expected: 全部 PASS。

- [ ] **Step 5: 验证点（不提交）**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py -v`
Expected: 原 22 项 + 新 6 项全部 OK。

---

### Task 4: status 的冲突、预算与未核清单

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_status.py`
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`

**Interfaces:**
- Consumes: 索引页的 `pendingReason`、`recognitionStatus`；顶层 `budget`；`ocr/recognition/*.json` 的 `conflicts`。
- Produces：输出新增 `conflictPages`（`[{sourceId, relativePath, page, fields}]`）、`budgetExhausted`（bool）、`notVerified`（`[{sourceId, relativePath, page, reason}]`，每页一条，优先级 `conflict > unreadable > pending`）。

- [ ] **Step 1: 写失败测试**

```python
    def test_29_status_reports_conflict_and_pending(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        base = {"page": 1, "status": "recognized",
                "text": "评估值：人民币 12,345,678.00 元"}
        self._record(report, [{**base, "keyValues": [
            {"label": "评估值", "value": "12345678.00",
             "quote": "评估值：人民币 12,345,678.00 元"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        self._record(report, [{**base, "keyValues": [
            {"label": "评估值", "value": "12345687.00",
             "quote": "评估值：人民币 12,345,687.00 元"}]}])
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(0, code, payload)
        self.assertEqual([{"sourceId": report["sourceId"], "relativePath": "材料-源/报告.pdf",
                           "page": 1, "fields": ["评估值"]}], payload["conflictPages"])
        reasons = {item["page"]: item["reason"] for item in payload["notVerified"]}
        self.assertEqual("conflict", reasons[1])
        self.assertEqual("pending", reasons[2])

    def test_30_budget_exhaustion_is_not_unread(self):
        self.prepare("--only", "材料-源/报告.pdf", "--budget", "0")
        report = self._source("材料-源/报告.pdf")
        self._record(report, [{"page": 2, "status": "recognized", "text": "第二页正文"}])
        code, payload = run(STATUS, ["--case", self.case], self.case)
        self.assertEqual(0, code, payload)
        self.assertTrue(payload["budgetExhausted"])
        self.assertNotIn(2, {item["page"] for item in payload["notVerified"]},
                         "预算耗尽只停止双读，不得把已读页记成未核")
```

- [ ] **Step 2: 运行确认失败**

Run: `.../test_ocr_flow.py OcrFlowTest.test_29_status_reports_conflict_and_pending -v`
Expected: FAIL，`KeyError: 'notVerified'`

- [ ] **Step 3: 实现汇总**

遍历 `index["sources"]`，对每页按优先级挑一个 reason；`conflictPages` 从 `recognition/*.json` 逐页读取 `conflicts`（没有冲突文件时为空）。`budgetExhausted` 取 `index["budget"]["exhausted"]`（缺省 `False`）。`actions` 里为冲突页补一句"人工确认或登记未核"。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2；再跑 `OcrFlowTest.test_30_budget_exhaustion_is_not_unread -v`。
Expected: 两项 PASS。

- [ ] **Step 5: 验证点（不提交）**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py OcrFlowTest.test_29_status_reports_conflict_and_pending OcrFlowTest.test_30_budget_exhaustion_is_not_unread -v`
Expected: PASS。

---

### Task 5: merge 的档位与冲突标注

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_merge.py`
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`

**Interfaces:**
- Consumes: `index` 页的 `riskTier`、`renders` 长度；`recognition` 页的 `recognitionStatus`、`conflicts`。
- Produces：`page_section(case_dir, page, recognition_page) -> str` 页头追加 `档位: <tier>/<reads> 次`；冲突页正文后追加 `[冲突：<field> <v1> / <v2> —— 不得直接引用，须人工确认]`。

- [ ] **Step 1: 写失败测试**

```python
    def test_31_merge_marks_conflict_page(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        base = {"page": 1, "status": "recognized",
                "text": "评估值：人民币 12,345,678.00 元"}
        self._record(report, [{**base, "keyValues": [
            {"label": "评估值", "value": "12345678.00",
             "quote": "评估值：人民币 12,345,678.00 元"}]}])
        self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1", "--dpi", "200")
        self._record(report, [{**base, "keyValues": [
            {"label": "评估值", "value": "12345687.00",
             "quote": "评估值：人民币 12,345,687.00 元"}]}])
        self._merge("--source", report["sourceId"])
        text = self._merged_text(report["sourceId"])
        self.assertIn("状态: conflict", text)
        self.assertIn("[冲突：评估值 12345678.00 / 12345687.00", text)
        self.assertIn("档位: normal/2 次", text, "第 1 页有文本层，档位应为 normal")

    def test_32_merge_accepts_legacy_recognition(self):
        self.prepare("--only", "材料-源/报告.pdf")
        report = self._source("材料-源/报告.pdf")
        legacy = {"schemaVersion": 1, "sourceId": report["sourceId"],
                  "pages": [{"page": 1, "status": "recognized", "text": "旧格式正文"}]}
        recognition_dir = os.path.join(self.case, "ocr", "recognition")
        os.makedirs(recognition_dir, exist_ok=True)
        dump(os.path.join(recognition_dir, report["sourceId"] + ".json"), legacy)
        code, payload = self._merge("--source", report["sourceId"])
        self.assertEqual(0, code, payload)
        self.assertIn("旧格式正文", self._merged_text(report["sourceId"]))
```

- [ ] **Step 2: 运行确认失败**

Run: `.../test_ocr_flow.py OcrFlowTest.test_31_merge_marks_conflict_page -v`
Expected: FAIL，`AssertionError`（合并文本没有冲突标记或档位）。

- [ ] **Step 3: 实现页头与冲突行**

`page_section` 接收页与识别页后拼出三段：页头（含 `riskTier` 与读取次数）、正文、冲突行。读取次数取 `len(recognition_page["reads"])`，旧记录没有 `reads` 时退回 `len(page["renders"])`，再退回 `1`。`page_status` 在读 `recognitionStatus=="conflict"` 时返回 `conflict`。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2；再跑 `OcrFlowTest.test_32_merge_accepts_legacy_recognition` 与 `OcrFlowTest.test_14_merge_digest_covers_body_only`。
Expected: 三项 PASS，`mergedDigest` 仍只覆盖正文段（冲突行属于正文，允许其改变摘要）。

- [ ] **Step 5: 验证点（不提交）**

Run: 完整 `test_ocr_flow.py`。
Expected: 原 30 项 + 新 2 项全部 OK。

---

### Task 6: schema、技能文档、提示词与打包断言

**Files:**
- Modify: `skills/capabilities/crwu-ocr/schemas/ocr-index.schema.json`、`schemas/ocr-recognition.schema.json`
- Modify: `skills/capabilities/crwu-ocr/SKILL.md`、`references/01-execution-contract.md`、`references/03-recognition-record.md`
- Modify: `src/host/domains/report-audit/prompt.ts`、`src/host/domains/local-audit/prompt.ts`
- Modify: `scripts/assert-pack.mjs`

**Interfaces:**
- Consumes: Task 2–5 的字段与行为。
- Produces: 无代码接口；文档与契约必须与实现逐字一致。

- [ ] **Step 1: 更新 schema**

`ocr-index.schema.json`：页对象增加 `pageClass`、`riskTier`、`policy`、`renders`、`pendingReason`；顶层增加 `budget`。`ocr-recognition.schema.json`：页对象增加 `keyValues`、`conflicts`、`reads`、`recognizer`；`recognitionStatus` 枚举加 `conflict`。全部 `additionalProperties: true` 保持兼容。

- [ ] **Step 2: 更新文档**

`01-execution-contract.md`：`--policy/--budget/--re-render` 参数、`renders`/`budget` 字段、`reads`/`conflicts` 语义；`03-recognition-record.md`：`keyValues` 的 quote 规则、冲突处理、`--recognizer`、升级建议；`SKILL.md`：执行步骤里加"读不到就升级/双读/冲突不选值"。

- [ ] **Step 3: 更新提示词（只改文案）**

两处 `prompt.ts` 的 OCR 段：要求记录 `keyValues`（含逐字 quote）；收到 `escalate[]` 时按建议重渲再读；`conflict` 页只能登记未核或人工确认，不得选值。

- [ ] **Step 4: 补打包断言**

`scripts/assert-pack.mjs` 的 OCR 清单补 `scripts/ocr_runtime.py`、`scripts/ocr_merge.py`、`scripts/ocr_bench.py`、`schemas/ocr-index.schema.json`、`schemas/ocr-recognition.schema.json`。

- [ ] **Step 5: 验证点（不提交）**

Run: `make docs-check`
Run: `npm --prefix plugins/dsh-crwu-workbench run pack:assert`
Expected: 两条命令均通过；`pack:assert` 在补齐前会先失败，用于确认断言真的生效。

---

### Task 7: 维护期评测脚本

**Files:**
- Create: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_bench.py`
- Create: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_bench.py`

**Interfaces:**
- Consumes: 案例目录的 `ocr/index.json` 与 `ocr/recognition/*.json`；基准 `bench/truth.json`（shape 见 spec §7.2）。
- Produces：`compute_metrics(index: dict, recognition: dict, truth: dict) -> dict`，返回 `{keyValueAccuracy, silentErrorRate, tableCellAccuracy, cost: {keyValues, wrong, silent, cells, imageCalls}}`。

**行为约束：**
- `keyValueAccuracy` 分母为基准 `keyValues` 总数；`silentErrorRate` 分子为"值错误且该页未标 `conflicts`、该条未出现在 `uncertainties`"的条数。
- 表格按"基准页 → 识别页"逐格比较，行/列缺失记错，不抛异常。
- 脚本只读，不写案例目录。

- [ ] **Step 1: 写失败测试**

```python
class BenchTest(unittest.TestCase):
    def test_silent_error_excludes_flagged_pages(self):
        index = {"sources": [{"sourceId": "s1", "pages": [{"page": 1}]}]}
        recognition = {"s1": {"pages": [{"page": 1, "conflicts": [],
                                          "keyValues": [{"label": "评估值", "value": "100"}]}]}}
        truth = {"pages": [{"page": 1, "keyValues": [{"label": "评估值", "value": "200"}]}]}
        metrics = ocr_bench.compute_metrics(index, recognition, truth)
        self.assertEqual(0.0, metrics["keyValueAccuracy"])
        self.assertEqual(1.0, metrics["silentErrorRate"])

    def test_conflict_page_is_not_silent(self):
        recognition = {"s1": {"pages": [{"page": 1, "conflicts": [{"field": "评估值"}],
                                          "keyValues": [{"label": "评估值", "value": "100"}]}]}}
        metrics = ocr_bench.compute_metrics(index, recognition, truth)
        self.assertEqual(0.0, metrics["silentErrorRate"])

    def test_table_cell_accuracy_counts_missing_cells_as_wrong(self):
        truth = {"pages": [{"page": 1, "tables": [{"rows": [["a", "b"], ["1", "2"]]}]}]}
        recognition = {"s1": {"pages": [{"page": 1, "tables": [{"rows": [["a", "b"], ["1", "3"]]}]}]}}
        metrics = ocr_bench.compute_metrics(index, recognition, truth)
        self.assertEqual(0.75, metrics["tableCellAccuracy"])
```

- [ ] **Step 2: 运行确认失败**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_bench.py -v`
Expected: FAIL，`ModuleNotFoundError: ocr_bench`

- [ ] **Step 3: 实现脚本**

CLI：`--case`、`--truth`（案例内相对路径）、`--json`；stdout 只输出一段 JSON；不写入案例目录。表格单元格比较按行列下标逐格。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2。
Expected: `Ran 3 tests ... OK`

- [ ] **Step 5: 验证点（不提交）**

Run: `PY="$(node scripts/resolve-dsh-python.mjs)"; "$PY" plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_bench.py -v`
Expected: PASS。

---

### Task 8: 版本、变更记录与整体门禁

**Files:**
- Modify: `plugins/dsh-crwu-workbench/package.json`、`VERSION`、`CHANGELOG.md`（以及 Host 版本常量，由 `make plugin-version-set` 一并写）

**Interfaces:**
- Consumes: 前七个任务的产物。
- Produces: 可发布状态（是否发布由用户决定）。

- [ ] **Step 1: 升版**

Run: `make plugin-version-set PLUGIN_RELEASE_VERSION=0.0.51`
Expected: `package.json` / `VERSION` / Host 常量 / lockfile 同步为 `0.0.51`。

- [ ] **Step 2: 写 CHANGELOG**

在 `CHANGELOG.md` 顶部加 `0.0.51` 小节：关键字段回指、双读与冲突、预算与自适应、bench 指标、打包断言补齐。

- [ ] **Step 3: 跑完整 OCR 门禁**

Run: `make plugin-ocr-check`
Expected: `test_ocr_runtime.py`、`test_ocr_flow.py`、`test_ocr_bench.py` 全部 OK。

- [ ] **Step 4: 跑仓库门禁**

Run: `make plugin-check`
Expected: 通过；若失败，逐条修到通过（不得跳过）。

Run: `make docs-check`
Expected: 通过。

Run: `git diff --check`
Expected: 无输出。

- [ ] **Step 5: 交付前人工核对**

- `git status` 只包含本计划涉及的文件与用户既有改动；
- 用一份真实案例的两次判读产物（`fast` 与 `quality` 各跑一遍 prepare + record），分别跑 `ocr_bench.py`，对比 `silentErrorRate`；
- 在交付说明里写明"仅在 macOS 验证 / Windows 需补跑"的实际状态，不得笼统写"双平台可用"。
