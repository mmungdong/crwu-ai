# crwu-audit-optimize AI—人工差距分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `crwu-audit-optimize` 内增加审核后 AI—人工差距分析、双基线归因、HTML 可视化报告、知识库人工修复单和批准后 Skill 修复 Prompt。

**Architecture:** Skill 入口只增加模式路由和硬边界，详细归因协议放入新的 reference。Python 交付脚本以结构化 GapAnalysis JSON 为单一事实源，先做跨字段语义校验，再将固定 HTML 模板、本地 ECharts 和数据内联为单文件报告；知识库计划只能输出人工操作说明，Skill 计划只有在显式批准后才能进入 AI 执行 Prompt。

**Tech Stack:** Markdown Skill instructions、Python 3 标准库、JSON Schema、HTML/CSS/JavaScript、ECharts 5.x、`unittest`。

---

## 文件结构

- Modify: `skills/crwu-audit-optimize/SKILL.md` — 增加三模式路由、差距分析入口和权限边界。
- Modify: `skills/crwu-audit-optimize/references/00-优化规范与文件落点.md` — 增加差距报告及模板的唯一落点和验收要求。
- Modify: `skills/crwu-audit-optimize/references/01-反馈定位与画像流程.md` — 将人工复核差距分析路由到新 reference。
- Modify: `skills/crwu-audit-optimize/references/02-方案模板与确认门禁.md` — 定义报告计划 ID 的批准语义、知识库人工单和 Skill Prompt 门禁。
- Create: `skills/crwu-audit-optimize/references/03-AI人工差距分析流程.md` — 保存匹配、在件核验、双基线、执行链、根因和追溯协议。
- Create: `skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py` — 校验、渲染和 CLI 入口。
- Create: `skills/crwu-audit-optimize/scripts/gap_analysis.schema.json` — GapAnalysis 基础结构 Schema。
- Create: `skills/crwu-audit-optimize/scripts/examples/gap-analysis.sample.json` — 完整合法样例。
- Create: `skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py` — 语义校验、渲染、权限和离线契约测试。
- Create: `skills/crwu-audit-optimize/template/gap-analysis-report.html` — 固定表格、图表、复制和打印模板。
- Create: `skills/crwu-audit-optimize/template/echarts.min.js` — 固定版本离线 ECharts。
- Create: `skills/crwu-audit-optimize/template/NOTICE.echarts.txt` — ECharts 版本和许可证声明。
- Modify: `skills/README.md` — 更新 optimize 能力摘要和随附资产。
- Modify: `docs/design-crwu-audit-skills.md` — 更新元技能职责和审核后闭环。
- Modify: `docs/CHANGELOG.md` — 登记功能变更。

### Task 1: 先用契约测试锁定权限和追溯不变量

**Files:**
- Create: `skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py`
- Create: `skills/crwu-audit-optimize/scripts/examples/gap-analysis.sample.json`

- [ ] **Step 1: 写最小合法样例与首批失败测试**

样例必须包含两个 `L-open`、一个 `L-resolved`、一个知识库人工计划和一个 Skill AI 计划。首批测试写入：

```json
{
  "schemaVersion": "1.0.0",
  "reportId": "GAP-BG8169-20260915",
  "project": {
    "projectId": "BG8169",
    "auditResult": "审核意见.BG8169.json",
    "reviewFiles": ["人工复核意见.xlsx"],
    "finalMaterials": ["评估报告-最终版.docx", "市场法测算.xlsx"]
  },
  "baselines": {
    "auditSnapshot": {
      "manifest": "knowledge/.crwu-manifest.jsonl",
      "verifiedSameProject": true,
      "exportedAt": "2026-09-15T09:00:00+08:00"
    },
    "currentKbSnapshot": {
      "readOnly": true,
      "checkedAt": "2026-09-15T15:00:00+08:00"
    }
  },
  "summary": {
    "reviewerOnly": 3,
    "actionableMisses": 2,
    "resolved": 1,
    "repairPlans": 2
  },
  "reviewerOnlyItems": [
    {
      "gapId": "L-01",
      "title": "市场比较案例时间修正依据不足",
      "status": "L-open",
      "reviewerEvidence": {"file": "人工复核意见.xlsx", "location": "问题清单!B12"},
      "finalDocumentVerification": {"file": "市场法测算.xlsx", "location": "案例表!H8", "result": "仍存在"},
      "executionTrace": [
        {"stage": "input", "status": "passed", "evidence": "材料清单#2"},
        {"stage": "knowledge", "status": "failed", "evidence": "CHK-MKT-012 内容不足"}
      ],
      "rootCauses": [{"code": "K2", "role": "primary", "evidence": "历史与当前正文均缺判断标准"}],
      "linkedFixIds": ["FIX-KB-01"]
    },
    {
      "gapId": "L-02",
      "title": "土地用途限制条件未核验",
      "status": "L-open",
      "reviewerEvidence": {"file": "人工复核意见.xlsx", "location": "问题清单!B18"},
      "finalDocumentVerification": {"file": "评估报告-最终版.docx", "location": "第45页", "result": "仍存在"},
      "executionTrace": [
        {"stage": "knowledge", "status": "passed", "evidence": "CHK-RE-021 已装载"},
        {"stage": "skill", "status": "failed", "evidence": "未定义四端交叉核验"}
      ],
      "rootCauses": [{"code": "S2", "role": "primary", "evidence": "知识已有但 Skill 未执行"}],
      "linkedFixIds": ["FIX-SKILL-01"]
    },
    {
      "gapId": "L-03",
      "title": "报告未披露土地剩余年限",
      "status": "L-resolved",
      "reviewerEvidence": {"file": "人工复核意见.xlsx", "location": "问题清单!B21"},
      "finalDocumentVerification": {"file": "评估报告-最终版.docx", "location": "第31页", "result": "已整改"},
      "executionTrace": [],
      "rootCauses": [{"code": "H", "role": "primary", "evidence": "最终版已落实"}],
      "linkedFixIds": []
    }
  ],
  "repairPlans": [
    {
      "fixId": "FIX-KB-01",
      "type": "kb_manual",
      "executionMode": "manual_only",
      "approvalState": "pending",
      "sourceGapIds": ["L-01"],
      "target": {"kbPath": "06-规则库/评估方法/市场法/清单-M-市场法", "anchor": "CHK-MKT-012"},
      "changeSpec": {
        "currentGap": "缺少时间修正依据充分性的证据、步骤、标准和例外",
        "method": "扩写现有 CHK-MKT-012",
        "contentOutline": ["适用条件", "必取证据", "检查步骤", "判断标准", "异常输出", "例外"]
      },
      "registrations": ["条目计数变化时更新批次 README"],
      "completionEvidence": "用户确认 FIX-KB-01 已完成并允许只读复核",
      "dependencies": [],
      "validation": ["锚点唯一", "原漏检案例回归"]
    },
    {
      "fixId": "FIX-SKILL-01",
      "type": "skill_ai",
      "executionMode": "ai_after_approval",
      "approvalState": "approved",
      "sourceGapIds": ["L-02"],
      "target": {"skillFile": "crwu-audit-asset-realestate/references/02-review-focus.md", "anchor": "CHK-RE-021"},
      "changeSpec": {
        "currentGap": "未定义权证、规划条件、报告披露、测算假设四端交叉核验",
        "method": "补充执行步骤和证据要求",
        "contentOutline": ["四端取证", "冲突判断", "输出证据"]
      },
      "registrations": ["源仓变更纪要"],
      "completionEvidence": "相关测试和原漏检回归通过",
      "dependencies": [],
      "validation": ["quick_validate", "kb_tool validate", "原漏检案例回归"]
    }
  ],
  "renderPolicy": {"offline": true, "printA4": true}
}
```

保存为 `scripts/examples/gap-analysis.sample.json`，再写测试：

```python
#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import re
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import gap_analysis_delivery as delivery

SAMPLE = SCRIPT_DIR / "examples" / "gap-analysis.sample.json"
TEMPLATE = SCRIPT_DIR.parent / "template" / "gap-analysis-report.html"


def load_sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


class GapAnalysisValidationTest(unittest.TestCase):
    def test_sample_passes(self):
        self.assertEqual([], delivery.validate(load_sample()))

    def test_every_actionable_gap_has_a_fix(self):
        result = load_sample()
        result["reviewerOnlyItems"][0]["linkedFixIds"] = []
        errors = delivery.validate(result)
        self.assertTrue(any("linkedFixIds" in item for item in errors), errors)

    def test_every_fix_points_back_to_a_gap(self):
        result = load_sample()
        result["repairPlans"][0]["sourceGapIds"] = []
        errors = delivery.validate(result)
        self.assertTrue(any("sourceGapIds" in item for item in errors), errors)

    def test_non_actionable_gap_cannot_enter_repair_plan(self):
        result = load_sample()
        result["repairPlans"][0]["sourceGapIds"].append("L-03")
        errors = delivery.validate(result)
        self.assertTrue(any("L-resolved" in item for item in errors), errors)

    def test_kb_plan_is_manual_only(self):
        result = load_sample()
        kb = next(item for item in result["repairPlans"] if item["type"] == "kb_manual")
        kb["executionMode"] = "ai"
        errors = delivery.validate(result)
        self.assertTrue(any("manual_only" in item for item in errors), errors)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py`

Expected: FAIL，包含 `ModuleNotFoundError: No module named 'gap_analysis_delivery'`。

- [ ] **Step 3: 提交测试夹具**

```bash
git add skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py \
  skills/crwu-audit-optimize/scripts/examples/gap-analysis.sample.json
git commit -m "test(crwu-audit-optimize): define gap analysis contracts"
```

### Task 2: 实现 GapAnalysis 结构与跨字段语义校验

**Files:**
- Create: `skills/crwu-audit-optimize/scripts/gap_analysis.schema.json`
- Create: `skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py`
- Modify: `skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py`

- [ ] **Step 1: 写 Schema 基础结构**

Schema 顶层必须固定以下必填字段，并对状态、根因和修复类型使用枚举：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://crwu.local/schema/gap-analysis/1.0.0",
  "title": "GapAnalysis",
  "type": "object",
  "required": [
    "schemaVersion", "reportId", "project", "baselines", "summary",
    "reviewerOnlyItems", "repairPlans", "renderPolicy"
  ],
  "properties": {
    "schemaVersion": {"type": "string", "pattern": "^1\\."},
    "reportId": {"type": "string", "pattern": "^GAP-[A-Za-z0-9_-]+-[0-9]{8}$"},
    "reviewerOnlyItems": {"type": "array", "items": {"type": "object"}},
    "repairPlans": {"type": "array", "items": {"type": "object"}},
    "renderPolicy": {
      "type": "object",
      "required": ["offline", "printA4"],
      "properties": {
        "offline": {"const": true},
        "printA4": {"const": true}
      }
    }
  }
}
```

- [ ] **Step 2: 实现加载、敏感信息扫描和语义校验**

脚本公开接口固定为 `load_result(path) -> dict`、`validate(result) -> list[str]`、`render(result) -> str`、`main(argv=None) -> int`。语义校验核心代码：

```python
ACTIONABLE = {"L-open", "L-unclosed"}
NON_ACTIONABLE = {"L-resolved", "L-uncheckable", "L-questionable"}
CAUSES = {"K1", "K2", "S1", "S2", "R", "I", "E", "O", "H"}
PLAN_TYPES = {"kb_manual", "skill_ai", "maintainer_handoff", "no_action"}
ABSOLUTE_PATH = re.compile(r"(?:^|\s)(?:/Users/|/home/|[A-Za-z]:\\\\)")


def validate(result: dict) -> list[str]:
    errors: list[str] = []
    gaps = result.get("reviewerOnlyItems") or []
    plans = result.get("repairPlans") or []
    gap_by_id = _unique_index(gaps, "gapId", "reviewerOnlyItems", errors)
    plan_by_id = _unique_index(plans, "fixId", "repairPlans", errors)

    for gap_id, gap in gap_by_id.items():
        status = gap.get("status")
        linked = gap.get("linkedFixIds") or []
        if status in ACTIONABLE and not linked:
            errors.append(f"{gap_id}.linkedFixIds：确认漏检必须关联修复计划")
        for fix_id in linked:
            if fix_id not in plan_by_id:
                errors.append(f"{gap_id}.linkedFixIds 引用未知计划 {fix_id}")
            elif gap_id not in (plan_by_id[fix_id].get("sourceGapIds") or []):
                errors.append(f"{gap_id} 与 {fix_id} 双向关系不一致")

    for fix_id, plan in plan_by_id.items():
        sources = plan.get("sourceGapIds") or []
        if not sources:
            errors.append(f"{fix_id}.sourceGapIds 不得为空")
        if plan.get("type") == "kb_manual" and plan.get("executionMode") != "manual_only":
            errors.append(f"{fix_id} 知识库计划必须为 manual_only")
        for gap_id in sources:
            gap = gap_by_id.get(gap_id)
            if not gap:
                errors.append(f"{fix_id}.sourceGapIds 引用未知漏检 {gap_id}")
            elif gap.get("status") in NON_ACTIONABLE:
                errors.append(f"{fix_id} 不得包含 {gap.get('status')} 项 {gap_id}")

    errors.extend(_validate_summary(result, gaps, plans))
    errors.extend(_scan_forbidden_content(result))
    return errors
```

- [ ] **Step 3: 增加失败用例覆盖重复 ID、断链、越权和不可复算摘要**

新增测试方法：`test_duplicate_gap_id_is_rejected`、`test_unknown_fix_id_is_rejected`、`test_summary_is_recomputed`、`test_absolute_paths_are_rejected`、`test_kb_write_command_is_rejected`、`test_skill_ai_requires_explicit_approval_state`。

- [ ] **Step 4: 运行校验测试**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py GapAnalysisValidationTest -v`

Expected: PASS，所有校验测试通过。

- [ ] **Step 5: 提交 Schema 与校验器**

```bash
git add skills/crwu-audit-optimize/scripts/gap_analysis.schema.json \
  skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py \
  skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py
git commit -m "feat(crwu-audit-optimize): validate gap analysis data"
```

### Task 3: 实现自包含 HTML 模板和 ECharts 渲染

**Files:**
- Create: `skills/crwu-audit-optimize/template/gap-analysis-report.html`
- Create: `skills/crwu-audit-optimize/template/echarts.min.js`
- Create: `skills/crwu-audit-optimize/template/NOTICE.echarts.txt`
- Modify: `skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py`
- Modify: `skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py`

- [ ] **Step 1: 写渲染失败测试**

```python
class GapAnalysisRenderTest(unittest.TestCase):
    def setUp(self):
        self.result = load_sample()
        self.document = delivery.render(self.result)

    def test_is_single_file_and_offline(self):
        for token in ("https://", "http://", "<link", "script src", "@import"):
            self.assertNotIn(token, self.document)
        self.assertIn("ECharts", self.document)

    def test_required_sections_exist(self):
        for region in (
            "gap-summary", "gap-charts", "reviewer-only-table", "execution-trace",
            "gap-fix-map", "manual-kb-plans", "skill-repair-prompts", "validation-plan"
        ):
            self.assertIn(f'id="{region}"', self.document)

    def test_a4_and_table_print_contract(self):
        self.assertIn("@page { size: A4", self.document)
        self.assertIn("thead { display: table-header-group; }", self.document)
        self.assertIn("break-inside: avoid", self.document)

    def test_embedded_payload_is_parseable(self):
        match = re.search(
            r'<script id="gap-analysis-data" type="application/json">(.*?)</script>',
            self.document,
            re.S,
        )
        self.assertIsNotNone(match)
        self.assertEqual(self.result["reportId"], json.loads(match.group(1))["reportId"])
```

- [ ] **Step 2: 运行测试并确认因模板与 renderer 尚未实现而失败**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py GapAnalysisRenderTest -v`

Expected: FAIL，指出模板缺失或 `render()` 尚未实现。

- [ ] **Step 3: 创建固定模板**

模板必须使用确定占位符，renderer 只替换这些字段：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{report_title}}</title>
  <style>{{report_css}}</style>
</head>
<body>
  <a class="skip-link" href="#gap-report">跳至差距分析正文</a>
  <main id="gap-report">{{report_content}}</main>
  <script id="gap-analysis-data" type="application/json">{{report_payload}}</script>
  <script>{{echarts_bundle}}</script>
  <script>{{report_javascript}}</script>
</body>
</html>
```

CSS 必须覆盖 960px 以下响应式布局、A4 打印、黑白可辨状态标识、横向表格容器和图表打印固定高度。

- [ ] **Step 4: 保存固定 ECharts 版本和许可证**

从已验证的 Apache ECharts 官方发行文件取得固定版本 `echarts.min.js`，文件头保留版本和 Apache-2.0 声明；`NOTICE.echarts.txt` 写明版本、上游项目地址、许可证和仅用于离线内联报告。不得从仓库其他业务 HTML 截取来源不明的代码。

- [ ] **Step 5: 实现确定性 renderer**

renderer 必须 HTML 转义所有可见文本，使用规范化 JSON 内嵌 payload，并将 ECharts 代码读入模板：

```python
SKILL_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = SKILL_ROOT / "template" / "gap-analysis-report.html"
ECHARTS_PATH = SKILL_ROOT / "template" / "echarts.min.js"


def render(result: dict) -> str:
    errors = validate(result)
    if errors:
        raise ValueError("GapAnalysis 校验失败：\n" + "\n".join(errors))
    payload = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload = payload.replace("<", "\\u003c").replace(">", "\\u003e")
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    values = {
        "{{report_title}}": html.escape(f"AI—人工审核差距分析 · {result['project']['projectId']}") ,
        "{{report_css}}": _report_css(),
        "{{report_content}}": _render_sections(result),
        "{{report_payload}}": payload,
        "{{echarts_bundle}}": ECHARTS_PATH.read_text(encoding="utf-8"),
        "{{report_javascript}}": _report_javascript(),
    }
    for key, value in values.items():
        template = template.replace(key, value)
    if re.search(r"\{\{[a-z_]+\}\}", template):
        raise ValueError("HTML 模板仍有未替换占位符")
    return template
```

- [ ] **Step 6: 实现三张图和主表交互**

JavaScript 只读取内嵌 JSON：生成差距构成横条图、根因环图、`L-* → cause → FIX-*` 桑基图；点击图表或表格行用 `data-gap-id` 聚焦相同 `sourceGapIds`，不修改分析数据。

- [ ] **Step 7: 运行渲染测试**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py GapAnalysisRenderTest -v`

Expected: PASS。

- [ ] **Step 8: 提交模板与 renderer**

```bash
git add skills/crwu-audit-optimize/template \
  skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py \
  skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py
git commit -m "feat(crwu-audit-optimize): render offline gap analysis report"
```

### Task 4: 实现人工修复单、批准选择和安全 Prompt

**Files:**
- Modify: `skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py`
- Modify: `skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py`
- Modify: `skills/crwu-audit-optimize/template/gap-analysis-report.html`

- [ ] **Step 1: 写 Prompt 权限失败测试**

```python
def test_kb_plan_never_appears_in_ai_execution_prompt(self):
    result = load_sample()
    document = delivery.render(result)
    prompt = delivery.build_skill_prompt(result, ["FIX-SKILL-01"])
    self.assertIn("FIX-SKILL-01", prompt)
    self.assertNotIn("修改知识库", prompt)
    self.assertNotIn("FIX-KB-01", prompt.split("批准执行")[1])
    self.assertIn("crwu-dws 只读", prompt)
    self.assertIn("不得对知识库执行任何写操作", prompt)


def test_unapproved_skill_plan_is_rejected(self):
    result = load_sample()
    with self.assertRaisesRegex(ValueError, "未批准"):
        delivery.build_skill_prompt(result, ["FIX-SKILL-UNAPPROVED"])
```

- [ ] **Step 2: 实现两类输出生成器**

```python
def build_manual_kb_instruction(plan: dict) -> str:
    if plan.get("type") != "kb_manual" or plan.get("executionMode") != "manual_only":
        raise ValueError("仅 kb_manual/manual_only 可生成人工修复单")
    target = plan["target"]
    change = plan["changeSpec"]
    return "\n".join([
        f"知识库人工修复单 {plan['fixId']}",
        f"对应人工独有事项：{'、'.join(plan['sourceGapIds'])}",
        f"目标文档：{target['kbPath']}",
        f"定位锚点：{target['anchor']}",
        f"当前缺口：{change['currentGap']}",
        f"修改方式：{change['method']}",
        f"建议内容结构：{'；'.join(change['contentOutline'])}",
        f"联动登记：{'；'.join(plan['registrations'])}",
        f"完成凭证：{plan['completionEvidence']}",
    ])


def build_skill_prompt(result: dict, approved_fix_ids: list[str]) -> str:
    plan_by_id = {item["fixId"]: item for item in result["repairPlans"]}
    selected = [plan_by_id[item] for item in approved_fix_ids if item in plan_by_id]
    if len(selected) != len(approved_fix_ids):
        raise ValueError("包含未知或未批准计划")
    if any(item["type"] != "skill_ai" or item["approvalState"] != "approved" for item in selected):
        raise ValueError("仅已批准 skill_ai 计划可进入执行 Prompt")
    return _compose_skill_prompt(result, selected)
```

- [ ] **Step 3: 模板加入修复计划选择和复制控件**

每个 Skill 计划 checkbox 使用 `data-fix-id`；知识库计划只显示“复制人工修复说明”，不显示批准 checkbox。浏览器端根据已批准计划列表生成 Prompt，且再次拒绝 `kb_manual`。

- [ ] **Step 4: 运行全部交付测试**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py -v`

Expected: PASS。

- [ ] **Step 5: 提交权限和 Prompt 功能**

```bash
git add skills/crwu-audit-optimize/scripts/gap_analysis_delivery.py \
  skills/crwu-audit-optimize/scripts/test_gap_analysis_delivery.py \
  skills/crwu-audit-optimize/template/gap-analysis-report.html
git commit -m "feat(crwu-audit-optimize): add gated repair prompts"
```

### Task 5: 接入 Skill 三模式和差距分析 reference

**Files:**
- Modify: `skills/crwu-audit-optimize/SKILL.md`
- Modify: `skills/crwu-audit-optimize/references/00-优化规范与文件落点.md`
- Modify: `skills/crwu-audit-optimize/references/01-反馈定位与画像流程.md`
- Modify: `skills/crwu-audit-optimize/references/02-方案模板与确认门禁.md`
- Create: `skills/crwu-audit-optimize/references/03-AI人工差距分析流程.md`

- [ ] **Step 1: 写 Skill 内容契约测试**

```python
class SkillIntegrationTest(unittest.TestCase):
    def test_skill_routes_gap_analysis_mode(self):
        skill = (SCRIPT_DIR.parent / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("AI—人工差距分析模式", skill)
        self.assertIn("references/03-AI人工差距分析流程.md", skill)

    def test_skill_keeps_knowledge_base_manual_only(self):
        files = [
            SCRIPT_DIR.parent / "SKILL.md",
            SCRIPT_DIR.parent / "references" / "03-AI人工差距分析流程.md",
        ]
        text = "\n".join(path.read_text(encoding="utf-8") for path in files)
        self.assertIn("manual_only", text)
        self.assertIn("禁止修改知识库", text)
```

- [ ] **Step 2: 运行测试并确认缺少模式与 reference**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py SkillIntegrationTest -v`

Expected: FAIL，指出差距模式或 `references/03` 缺失。

- [ ] **Step 3: 在 SKILL.md 增加三模式路由**

入口必须明确：出现“审核后对比人工复核、仅人工发现、AI 漏检原因、知识库还是 Skill”时进入差距分析；普通规则反馈沿用现有模式；批准计划 ID 后才进入执行模式。

- [ ] **Step 4: 写 references/03 完整协议**

内容按已批准设计固化：输入完整性、A/B/C/L 匹配、五态在件核验、八层执行链、双基线、K/S/R/I/E/O/H 根因、双向追溯、HTML 输出、人工知识库修复单、Skill Prompt 和依赖门禁。

- [ ] **Step 5: 同步 references/00–02**

明确 `template/`、`scripts/` 是差距报告唯一落点；差距报告中的完整修复计划可作为确认门禁方案；知识库计划永远不继承执行授权；B/E 或 R 桶交维护器时仍须独立方案。

- [ ] **Step 6: 运行 Skill 集成测试和行数检查**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py SkillIntegrationTest -v && test "$(wc -l < SKILL.md)" -le 300`

Expected: PASS，`SKILL.md` 不超过 300 行。

- [ ] **Step 7: 提交 Skill 协议**

```bash
git add skills/crwu-audit-optimize/SKILL.md skills/crwu-audit-optimize/references
git commit -m "feat(crwu-audit-optimize): add AI-human gap analysis mode"
```

### Task 6: 文档登记、全量验证和视觉 QA

**Files:**
- Modify: `skills/README.md`
- Modify: `docs/design-crwu-audit-skills.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: 更新三处登记**

`skills/README.md` 写明 optimize 新增差距分析和 HTML 交付；设计文档写清 `crwu-audit → optimize 差距归因 → 人工知识库 / AI Skill 修复 → 回归` 闭环；CHANGELOG 增加本次日期、能力和硬边界。

- [ ] **Step 2: 生成样例 HTML**

Run:

```bash
cd skills/crwu-audit-optimize
python3 scripts/gap_analysis_delivery.py validate scripts/examples/gap-analysis.sample.json
python3 scripts/gap_analysis_delivery.py render scripts/examples/gap-analysis.sample.json \
  --out /tmp/crwu-gap-analysis-sample.html
```

Expected: validate 输出 `OK`；render 输出目标路径且退出码 0。

- [ ] **Step 3: 浏览器视觉检查**

打开 `/tmp/crwu-gap-analysis-sample.html`，检查桌面和窄屏：图表可见、表格不覆盖、`L-* → FIX-*` 点击联动、人工修复单可复制、Skill Prompt 只含批准计划、打印预览为 A4 且表头跨页重复。记录任何失败并在模板或 renderer 中修正。

- [ ] **Step 4: 运行技能自身测试**

Run: `cd skills/crwu-audit-optimize && python3 scripts/test_gap_analysis_delivery.py -v`

Expected: PASS。

- [ ] **Step 5: 运行族级契约和引用卫生校验**

Run:

```bash
python3 skills/crwu-audit/scripts/test_audit_multiaxis_router.py
python3 skills/crwu-dws/scripts/test_dws_source_contract.py
python3 skills/crwu-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py
python3 skills/crwu-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills
git diff --check
```

Expected: 所有测试 PASS；`kb_tool.py` 输出 `error=0`；`git diff --check` 无输出。

- [ ] **Step 6: 回归权限和追溯关键断言**

Run:

```bash
rg -n "manual_only|禁止修改知识库|sourceGapIds|linkedFixIds" \
  skills/crwu-audit-optimize/SKILL.md \
  skills/crwu-audit-optimize/references \
  skills/crwu-audit-optimize/scripts
rg -n "dingtalk-doc.*修改|wiki.*update|知识库写入" \
  skills/crwu-audit-optimize || true
```

Expected: 第一条覆盖入口、协议和校验器；第二条不得发现允许知识库写入的执行指令。

- [ ] **Step 7: 提交登记和最终修正**

```bash
git add skills/README.md docs/design-crwu-audit-skills.md docs/CHANGELOG.md \
  skills/crwu-audit-optimize
git commit -m "docs(crwu-audit-optimize): register gap analysis workflow"
```

- [ ] **Step 8: 最终状态检查**

Run: `git status --short && git log -7 --oneline`

Expected: 仅保留用户原有的无关未跟踪文件；本计划涉及文件无未提交变更，最近提交按 Task 1–6 顺序存在。
