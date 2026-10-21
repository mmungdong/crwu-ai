# crwu-ocr 实测校准实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec §14.2 的 6 项实测校准落到 `crwu-ocr` 脚本与文档：分辨率上限告警、重渲预算门禁、升级优先级、状态文案、合并页头方向、版本与门禁。

**Architecture:** 全部改动在 `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/` 内，不新增 Host Tool、不新增运行脚本。预算与分辨率判断放在 `ocr_runtime.py` / `ocr_prepare.py`；升级排序在 `ocr_record.py`；文案在 `ocr_status.py`；页头在 `ocr_merge.py`。

**Tech Stack:** Python 3.12（DSH 自带运行时）、unittest、pypdf/pypdfium2 随包依赖、node 版 `make plugin-ocr-check` 门禁。

**Spec:** `docs/superpowers/specs/2026-10-21-crwu-ocr-quality-design.md`（§4.2–§4.5、§5、§6、§9、§14）

## Global Constraints

- 只做“会话视觉”一种识别器；不新增 Tool、不新增 Host 暂存的运行脚本。
- 默认 `--policy auto`；DPI 默认 144，高风险页 200；有效宽度上限 `SESSION_MAX_WIDTH = 1721`。
- `maxDoubleReads = min(10, pagesRequired, max(3, ceil(0.2 × pagesRequired)))`；`--budget` 覆盖且不超过 `pagesRequired`。
- 预算耗尽只停止双读，单次判读结果仍算已读；**预算 ≠ 未核**。
- 冲突页不选值；未核 ≠ 缺失。
- 本仓 `AGENTS.md` 禁止未授权提交：每个任务最后一步是 `git diff --check` + 汇报，**不执行 `git commit`**，除非用户明确授权。
- 所有 Python 命令用 DSH 自带解释器：仓库根 `DSH_PY=$(node scripts/resolve-dsh-python.mjs)`。

## Review Focus

- 旧案例目录（0.0.50 索引，无 `budget` / `renders`）：新脚本读取时不得崩溃，重跑后字段按新口径补齐。
- `--budget 0`（显式禁止双读）：`--re-render` 必须被拒绝，不能静默通过。
- `--re-render` 指向不存在页号：参数错误、退出码 2、索引与页图都不改。
- 旋转页（`orientation=rotated-90`）：合并页头必须带方向，正常页不得出现该字段。
- 重渲后未重读：该页保持 `pending`，合并文本用占位，状态不得写成已核。

---

### Task 1: 分辨率上限与告警

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_runtime.py`（常量与 `resolution_note`，放在 `normalize_text` 附近）
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_prepare.py:838-846`（预算收尾处，写索引前）
- Test: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py`（`OcrFlowTest`，新增 `test_42`）

**Interfaces:**
- Produces: `ocr_runtime.SESSION_MAX_WIDTH: int`（1721）、`ocr_runtime.resolution_note(max_width: int) -> str`（不超过上限返回空串）。
- Produces: 索引 `render.engineNotes[]` 新增一条形如 `会话侧有效宽度约 1721 px；本次最大页图宽 2222 px，超出部分不增加信息量`。

- [ ] **Step 1: 写失败测试**

```python
def test_42_resolution_ceiling_is_reported_not_blocking(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf")
    code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                 "--re-render", "pages:2", "--dpi", "400")
    self.assertEqual(0, code, payload)
    index = load(os.path.join(self.case, "ocr", "index.json"))
    self.assertTrue(any("有效宽度" in note for note in index["render"]["engineNotes"]),
                    index["render"]["engineNotes"])
```

- [ ] **Step 2: 运行并确认失败**

Run: `cd plugins/dsh-crwu-workbench && "$DSH_PY" skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py OcrFlowTest.test_42_resolution_ceiling_is_reported_not_blocking -v`
Expected: FAIL（`engineNotes` 里没有“有效宽度”）。

- [ ] **Step 3: 实现**

`ocr_runtime.py` 增加常量与函数：

```python
SESSION_MAX_WIDTH = 1721  # measured 2026-10-21: read_image normalizes page images to this width

def resolution_note(max_width: int) -> str:
    """Warn when the render exceeds the width the session actually reads."""
```

`ocr_prepare.py` 在 `budget["elapsedMs"] ...` 之前，遍历全部来源页面的 `renders[].width` 取最大值，非空时追加到 `engine_notes`（同一条只加一次）。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: 全量契约测试 + 检查变更**

Run: `make plugin-ocr-check`（仓库根）；`git diff --check`。
Expected: 全部通过；不提交。

---

### Task 2: `--re-render` 预算门禁与 `--force-budget`

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_prepare.py:663-716`（解析参数、读旧索引之后）
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_prepare.py:838-846`（写 `budget.exceededBy`）
- Test: `test_ocr_flow.py`（新增 `test_43`、`test_44`、`test_45`、`test_46`）

**Interfaces:**
- Consumes: `budget_for(required: int, policy: str, override) -> dict`（Task 0 已存在）。
- Produces: CLI `--force-budget`（store_true）。
- Produces: 索引 `budget.exceededBy: int`（仅越权时出现，值为超出的页数）。

- [ ] **Step 1: 写失败测试**

```python
def test_43_re_render_over_budget_is_rejected(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
    before = load(os.path.join(self.case, "ocr", "index.json"))["sources"]
    code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                 "--re-render", "pages:1,2", "--budget", "1")
    self.assertEqual(2, code, payload)
    self.assertEqual("input", payload["errorKind"])
    self.assertIn("--force-budget", payload["error"])
    after = load(os.path.join(self.case, "ocr", "index.json"))["sources"]
    self.assertEqual(before, after)

def test_44_force_budget_records_the_overrun(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
    code, payload = self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:1,2",
                                 "--budget", "1", "--force-budget")
    self.assertEqual(0, code, payload)
    budget = load(os.path.join(self.case, "ocr", "index.json"))["budget"]
    self.assertEqual(1, budget["exceededBy"])

def test_45_budget_zero_rejects_every_re_render(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf", "--budget", "0")
    code, payload = self.prepare("--only", "材料-源/报告.pdf",
                                 "--re-render", "pages:2", "--budget", "0")
    self.assertEqual(2, code, payload)
    self.assertIn("--force-budget", payload["error"])

def test_46_unknown_page_re_render_is_rejected(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf")
    code, payload = self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:9")
    self.assertEqual(2, code, payload)
    self.assertEqual("input", payload["errorKind"])
```

- [ ] **Step 2: 运行并确认失败**

Run: `"$DSH_PY" .../test_ocr_flow.py OcrFlowTest.test_43_re_render_over_budget_is_rejected -v`
Expected: FAIL（当前退出码 0）。

- [ ] **Step 3: 实现**

在读取 `previous` 之后、扫描材料之前计算：`prev_double = Σ max(0, len(renders)-1)`；`prev_required = previous 中 visualRequired 页数`（为 0 时用 `len(re_render_pages)`）；`cap = budget_for(max(prev_required, 1), args.policy, args.budget)["maxDoubleReads"]`。
若 `prev_double + len(re_render_pages) > cap` 且无 `--force-budget`：`ocr_runtime.fail("input", "重渲超出双读预算：已有 X 次，本次 Y 页，上限 Z；如确需超预算请加 --force-budget")`，返回 `EXIT_USAGE`，**不写任何文件**。
越权通过时把差额计入 `budget["exceededBy"]`。

- [ ] **Step 4: 运行并确认通过**

Run: `"$DSH_PY" .../test_ocr_flow.py OcrFlowTest.test_43_... OcrFlowTest.test_44_... OcrFlowTest.test_45_... OcrFlowTest.test_46_... -v`
Expected: PASS。

- [ ] **Step 5: 全量契约测试 + 检查变更**

Run: `make plugin-ocr-check`；`git diff --check`。不提交。

---

### Task 3: 升级优先级与预算内截断

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_record.py:140-161`（`escalate_for` 返回候选项）
- Modify: `ocr_record.py:322-327`（汇总后排序截断）
- Test: `test_ocr_flow.py`（新增 `test_47`）

**Interfaces:**
- Produces: `escalate_for(page: dict, record: dict, index: dict) -> dict | None`，返回 `{"page": int, "mode": "tile"|"dpi-retry", "priority": "table"|"keyValues"|"uncertainty"}`。
- Produces: `select_escalations(candidates: list[dict], remaining: int) -> list[dict]`，按 `table > keyValues > uncertainty`、同级按页号排序，取前 `remaining` 条。

- [ ] **Step 1: 写失败测试**

```python
def test_47_escalation_is_prioritized_and_capped(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf", "--visual", "all", "--budget", "2")
    report = self._source("材料-源/报告.pdf")
    rows = [["科目", "评估值"]] + [["行%d" % i, str(i)] for i in range(11)]
    payload = self._record(report, [
        {"page": 1, "status": "recognized", "text": "表见下", "tables": [{"rows": rows}]},
        {"page": 2, "status": "recognized", "text": "评估值 123 面积 456 日期 789",
         "keyValues": [
             {"label": "评估值", "value": "123", "quote": "评估值 123"},
             {"label": "面积", "value": "456", "quote": "面积 456"},
             {"label": "日期", "value": "789", "quote": "日期 789"}]},
        {"page": 3, "status": "recognized", "text": "页脚", "uncertainties": ["小字模糊"]},
    ])
    self.assertEqual(2, len(payload["escalate"]))
    self.assertEqual(["table", "keyValues"], [item["priority"] for item in payload["escalate"]])
    self.assertEqual([1, 2], [item["page"] for item in payload["escalate"]])
```

- [ ] **Step 2: 运行并确认失败**

Run: `"$DSH_PY" .../test_ocr_flow.py OcrFlowTest.test_47_escalation_is_prioritized_and_capped -v`
Expected: FAIL（当前 `escalate` 含 3 条且无 `priority`）。

- [ ] **Step 3: 实现**

`escalate_for` 去掉逐页预算判断，返回带 `priority` 的候选项；`remaining = max(0, maxDoubleReads - doubleReads)`；汇总后调用 `select_escalations(candidates, remaining)`，空列表时返回 `[]`。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2。Expected: PASS；再跑 `OcrFlowTest.test_25`、`test_26` 确认未回归。

- [ ] **Step 5: 全量契约测试 + 检查变更**

Run: `make plugin-ocr-check`；`git diff --check`。不提交。

---

### Task 4: 状态文案按实际读取次数

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_status.py:100-115`
- Test: `test_ocr_flow.py`（新增 `test_48`、`test_49`）

**Interfaces:**
- Produces: `read_counts(case_dir: str) -> dict`，返回 `{"doubleRead": int, "singleRead": int}`（按 `recognition/*.json` 的 `reads[]` 统计）。
- Produces: `actions[]` 新增文案 `已对 N 页双读，其余 M 页为单次判读（预算已用尽）`。

- [ ] **Step 1: 写失败测试**

```python
def test_48_status_actions_match_actual_reads(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf", "--budget", "1")
    report = self._source("材料-源/报告.pdf")
    self._record(report, [{"page": 1, "status": "recognized", "text": "第一页"},
                          {"page": 2, "status": "recognized", "text": "第二页"}])
    self.prepare("--only", "材料-源/报告.pdf", "--re-render", "pages:2", "--budget", "1")
    code, pending = run(STATUS, ["--case", self.case], self.case)
    self.assertTrue(any(2 in item["pages"] for item in pending["pending"]),
                    "重渲后未重读的页必须仍是 pending")
    report = self._source("材料-源/报告.pdf")
    self._record(report, [{"page": 2, "status": "recognized", "text": "第二页"}])
    code, payload = run(STATUS, ["--case", self.case], self.case)
    self.assertEqual(0, code, payload)
    self.assertTrue(any("1 页双读" in action for action in payload["actions"]), payload["actions"])

def test_49_legacy_index_without_budget_still_works(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf")
    path = os.path.join(self.case, "ocr", "index.json")
    index = load(path); index.pop("budget", None); dump(path, index)
    code, payload = run(STATUS, ["--case", self.case], self.case)
    self.assertEqual(0, code, payload)
```

- [ ] **Step 2: 运行并确认失败**

Run: `"$DSH_PY" .../test_ocr_flow.py OcrFlowTest.test_48_status_actions_match_actual_reads -v`
Expected: FAIL（现有文案是“本次未做双读”）。

- [ ] **Step 3: 实现**

统计 `recognition/*.json` 的 `reads`：`len(reads) >= 2` 计双读，`== 1` 计单读。`budget_exhausted` 为真时：双读 > 0 用新文案，否则保留原文案；旧索引无 `budget` 时按 0 处理。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2 + `test_49`。Expected: PASS。

- [ ] **Step 5: 全量契约测试 + 检查变更**

Run: `make plugin-ocr-check`；`git diff --check`。不提交。

---

### Task 5: 合并页头方向

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/capabilities/crwu-ocr/scripts/ocr_merge.py:95-96`（页头格式化）
- Test: `test_ocr_flow.py`（新增 `test_50`）

**Interfaces:**
- Consumes: 识别记录页级 `orientation`（`normal` / `rotated-90` / `rotated-180` / `rotated-270` / `unknown`）。

- [ ] **Step 1: 写失败测试**

```python
def test_50_merge_header_shows_orientation(self):
    self._clean_ocr()
    self.prepare("--only", "材料-源/报告.pdf")
    report = self._source("材料-源/报告.pdf")
    self._record(report, [{"page": 2, "status": "recognized", "orientation": "rotated-90",
                           "text": "横向页面内容"}])
    self._merge("--source", report["sourceId"])
    merged = self._merged_text(report["sourceId"])
    self.assertIn("方向: rotated-90", merged)
    self.assertNotIn("方向: normal", merged)
```

- [ ] **Step 2: 运行并确认失败**

Run: `"$DSH_PY" .../test_ocr_flow.py OcrFlowTest.test_50_merge_header_shows_orientation -v`
Expected: FAIL（页头无“方向”）。

- [ ] **Step 3: 实现**

页头拼装处读取 `recognition_page.get("orientation")`；非空且不等于 `normal` 时追加 ` | 方向: <值>`。其余字段与顺序不变。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2。Expected: PASS；`OcrFlowTest.test_10` 不回归。

- [ ] **Step 5: 全量契约测试 + 检查变更**

Run: `make plugin-ocr-check`；`git diff --check`。不提交。

---

### Task 6: 文档、Schema、版本与门禁

**Files:**
- Modify: `skills/capabilities/crwu-ocr/SKILL.md`（硬规则：有效分辨率、非必要不重渲）
- Modify: `skills/capabilities/crwu-ocr/references/01-execution-contract.md`（`--force-budget`、重渲预算、`SESSION_MAX_WIDTH`）
- Modify: `skills/capabilities/crwu-ocr/references/03-recognition-record.md`（`escalate[].priority`）
- Modify: `skills/capabilities/crwu-ocr/schemas/ocr-index.schema.json`（`budget.exceededBy`）
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`、`package.json`、`VERSION`、`src/host/consts.ts`（发布号 0.0.43）

**Interfaces:**
- Consumes: Task 1–5 的最终 CLI 与字段名。

- [ ] **Step 1: 升版本**

Run: `make plugin-version-set PLUGIN_RELEASE_VERSION=0.0.43`
Expected: 四处版本一致。

- [ ] **Step 2: 更新文档与 Schema**

写清：`--re-render` 计入预算、`--force-budget` 的越权语义、`SESSION_MAX_WIDTH = 1721` 的来源与复核方式、`escalate[].priority` 三档、`budget.exceededBy`。

- [ ] **Step 3: 补 CHANGELOG 小节**

`## package · 0.0.43 · 2026-10-21 · fix · OCR 实测校准`，逐条对应 §14.2 的 6 项。

- [ ] **Step 4: 运行门禁**

Run: `make docs-check`；`make plugin-ocr-check`；`git diff --check`。
Expected: 全部通过。

- [ ] **Step 5: 汇报，不提交**

列出改动文件与门禁输出；提交留给用户决定（仓库规则）。
