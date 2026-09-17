# CRWU Audit Report Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audit report immediately actionable for employees while preserving a JSON-first validation gate and exact JSON/HTML consistency for monitoring.

**Architecture:** Keep AuditResult JSON as the only business fact source. Strengthen JSON validation first, then render a compact action digest, linked KPI cards, prominent material locations, and reordered sections from existing fields; a successful render emits both the finalized JSON and HTML containing the same AuditResult object.

**Tech Stack:** Python 3 standard library, `unittest`, JSON Schema, deterministic server-side HTML rendering, standalone HTML/CSS.

---

## File map

- Modify `skills/crwu-audit/scripts/test_audit_delivery.py`: add all regression, rendering, ordering, accessibility, and paired-output tests first.
- Modify `skills/crwu-audit/scripts/audit_delivery.py`: enforce the JSON gate, render the compact summary and problem locations, reorder sections, and emit paired JSON/HTML.
- Modify `skills/crwu-audit/template/audit-report.html`: reorder sidebar links and style linked KPIs, action digest, location panels, responsive states, focus, and print.
- Modify `skills/crwu-audit/scripts/audit_result.schema.json`: synchronize field descriptions and v1.4 delivery constraints without adding business fields.
- Modify `skills/crwu-audit/scripts/examples/audit-result.sample.json`: update renderer metadata and keep the sample valid under the tightened JSON gate.
- Modify `skills/crwu-audit/references/11-html-delivery-spec.md`: specify v1.4 layout, JSON-first rejection, fixed JSON-to-HTML mappings, and paired artifacts.
- Modify `skills/crwu-audit/scripts/README.md`: document `--json-out`, the two-stage gate, output pair, and rendering behavior.
- Modify `skills/crwu-audit/SKILL.md`: require validate-before-render and paired internal JSON/HTML generation.
- Modify `skills/README.md`: update the `crwu-audit` catalog description to v1.4.
- Modify `docs/CHANGELOG.md`: revise the active 2026-09-17 entry to describe the complete readability and paired-output change.

### Task 1: Close the existing problem-description validation gap

**Files:**
- Modify: `skills/crwu-audit/scripts/test_audit_delivery.py`
- Modify: `skills/crwu-audit/scripts/audit_delivery.py`

- [ ] **Step 1: Write a failing test for the declared two-line minimum**

Add this method to `AuditResultValidationTest`:

```python
def test_problem_description_requires_at_least_two_detail_lines(self):
    result = load_sample()
    issue = result["issues"][0]
    issue["problemDescription"] = (
        "三个可比案例均未进行时间修正。\n"
        "请打开 市场法测算表.xlsx 的「市场法」表 F18:F22 核对。"
    )
    errors = delivery.validate(result)
    self.assertTrue(
        any("明细 1 行，少于 2 行下限" in error for error in errors),
        errors,
    )
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest scripts.test_audit_delivery.AuditResultValidationTest.test_problem_description_requires_at_least_two_detail_lines -v
```

Expected: FAIL because the current validator accepts one detail line.

- [ ] **Step 3: Implement the minimum-line check**

In `validate_problem_description`, replace the zero-detail special case with a count-based check that still allows the remaining validators to report useful errors:

```python
if len(details) < PROBLEM_DETAIL_MIN_LINES:
    errors.append(
        "{0}.problemDescription 明细 {1} 行，少于 {2} 行下限".format(
            where, len(details), PROBLEM_DETAIL_MIN_LINES
        )
    )
if len(details) > PROBLEM_DETAIL_MAX_LINES:
    errors.append(
        "{0}.problemDescription 明细 {1} 行，超过 {2} 行上限".format(
            where, len(details), PROBLEM_DETAIL_MAX_LINES
        )
    )
```

Keep the missing-headline early return, but remove the current `if not details: ... return errors` branch so the lower-bound constant is the single source of truth.

- [ ] **Step 4: Run the focused test and validation suite**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest scripts.test_audit_delivery.AuditResultValidationTest.test_problem_description_requires_at_least_two_detail_lines -v
python3 scripts/test_audit_delivery.py
```

Expected: the focused test passes and the existing 96-test suite remains green.

- [ ] **Step 5: Commit the validation fix**

```bash
git add skills/crwu-audit/scripts/audit_delivery.py skills/crwu-audit/scripts/test_audit_delivery.py
git commit -m "fix(crwu-audit): enforce problem detail line minimum"
```

### Task 2: Replace the long first-screen paragraph with a JSON-derived action digest and jump links

**Files:**
- Modify: `skills/crwu-audit/scripts/test_audit_delivery.py`
- Modify: `skills/crwu-audit/scripts/audit_delivery.py`
- Modify: `skills/crwu-audit/template/audit-report.html`

- [ ] **Step 1: Write failing rendering tests**

Add these methods to `AuditResultRenderTest`:

```python
def test_summary_narrative_is_folded_and_action_digest_uses_json_facts(self):
    document = delivery.render(load_sample())
    summary_start = document.find('id="summary"')
    summary_end = document.find('</section>', summary_start)
    summary = document[summary_start:summary_end]
    narrative = load_sample()["summary"]["narrative"]
    self.assertIn('class="summary-action-digest"', summary)
    self.assertIn("优先处理", summary)
    self.assertIn("继续核对", summary)
    self.assertIn("人工确认", summary)
    self.assertIn(load_sample()["issues"][0]["title"], summary)
    self.assertIn(load_sample()["manualConfirmationItems"][0]["title"], summary)
    self.assertRegex(
        summary,
        re.compile(
            r'<details class="summary-narrative-details"><summary>查看完整 AI 审核说明</summary>.*?'
            + re.escape(narrative),
            re.S,
        ),
    )

def test_action_kpis_link_to_their_json_backed_sections(self):
    document = delivery.render(load_sample())
    for href, label, value in (
        ("#actionable-issues", "AI 检出问题", 2),
        ("#manual-confirmation-items", "待人工确认", 1),
        ("#not-checked-items", "未检查项", 1),
    ):
        self.assertIn(
            '<a class="metric-card metric-link',
            document,
        )
        self.assertRegex(
            document,
            re.compile(
                r'<a class="metric-card metric-link[^"]*" href="{0}">.*?'
                r'<span>{1}</span><strong>{2}</strong>'.format(
                    re.escape(href), re.escape(label), value
                ),
                re.S,
            ),
        )
```

Extend `test_renderer_does_not_author_business_text` to allow only controlled action-digest labels and deterministic `另 N 项` text:

```python
if re.fullmatch(r"另 [0-9]+ 项", node):
    continue
```

- [ ] **Step 2: Run the two focused tests and verify RED**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditResultRenderTest.test_summary_narrative_is_folded_and_action_digest_uses_json_facts \
  scripts.test_audit_delivery.AuditResultRenderTest.test_action_kpis_link_to_their_json_backed_sections -v
```

Expected: FAIL because the narrative is a direct paragraph, there is no digest, and the metrics are non-link `<div>` elements.

- [ ] **Step 3: Add deterministic summary helpers**

Add helpers near `_summary_breakdown_section`:

```python
SUMMARY_DIGEST_ITEM_LIMIT = 3


def _summary_digest_group(label: str, items: list, css_class: str) -> str:
    visible = items[:SUMMARY_DIGEST_ITEM_LIMIT]
    parts = ['<article class="summary-action-group {0}">'.format(css_class)]
    parts.append('<h3>{0}<strong>{1}</strong></h3>'.format(_text(label), _text(len(items))))
    if visible:
        parts.append("<ul>")
        parts.extend("<li>{0}</li>".format(_text(item.get("title"))) for item in visible)
        if len(items) > SUMMARY_DIGEST_ITEM_LIMIT:
            parts.append("<li>{0}</li>".format(_text("另 {0} 项".format(len(items) - SUMMARY_DIGEST_ITEM_LIMIT))))
        parts.append("</ul>")
    else:
        parts.append('<p class="empty">{0}</p>'.format(_text(EMPTY_TEXT)))
    parts.append("</article>")
    return "".join(parts)


def _summary_action_digest(issues: list, manual_items: list) -> str:
    high = [item for item in issues if item.get("severity") == "high"]
    other = [item for item in issues if item.get("severity") != "high"]
    return '<div class="summary-action-digest">{0}{1}{2}</div>'.format(
        _summary_digest_group("优先处理", high, "priority"),
        _summary_digest_group("继续核对", other, "follow-up"),
        _summary_digest_group("人工确认", manual_items, "manual"),
    )
```

The helper uses only JSON item titles and counts plus controlled labels.

- [ ] **Step 4: Render linked KPIs and fold the narrative**

In `render`, replace the direct narrative paragraph with:

```python
parts.append(_summary_action_digest(sorted_issues, manual_items))
parts.append(
    '<details class="summary-narrative-details"><summary>{0}</summary><p>{1}</p></details>'.format(
        _text("查看完整 AI 审核说明"), _span("narrative", summary.get("narrative"))
    )
)
```

Render the first three metrics as real links and keep the remaining metrics as non-link cards:

```python
metric_rows = (
    ("AI 检出问题", counts.get("issuesTotal"), "danger", "#actionable-issues"),
    ("待人工确认", counts.get("pendingConfirmation"), "warning", "#manual-confirmation-items"),
    ("未检查项", counts.get("notChecked"), "neutral", "#not-checked-items"),
    ("命中率", _format_rate(review_metrics["hitRate"]) if review_items else "数据不足", "primary", None),
    ("实际未落实", unresolved_claims, "danger", None),
)
for label, value, cls, href in metric_rows:
    if href:
        parts.append(
            '<a class="metric-card metric-link {0}" href="{1}"><span>{2}</span><strong>{3}</strong></a>'.format(
                cls, href, _text(label), _text(value)
            )
        )
    else:
        parts.append(
            '<div class="metric-card {0}"><span>{1}</span><strong>{2}</strong></div>'.format(
                cls, _text(label), _text(value)
            )
        )
```

- [ ] **Step 5: Add template styles for summary hierarchy and link affordance**

Add CSS using the existing report variables:

```css
.metric-link { color: inherit; text-decoration: none; transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease; }
.metric-link:hover { transform: translateY(-2px); border-color: var(--brand); box-shadow: 0 7px 18px rgba(23, 75, 114, 0.12); }
.metric-link:focus-visible { outline: 3px solid rgba(36, 74, 117, 0.35); outline-offset: 3px; }
.summary-action-digest { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
.summary-action-group { padding: 13px 14px; background: #fff; border: 1px solid var(--line); border-top: 3px solid var(--line-strong); border-radius: 9px; }
.summary-action-group.priority { border-top-color: var(--high); }
.summary-action-group.manual { border-top-color: var(--medium); }
.summary-action-group h3 { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
.summary-action-group h3 strong { font-size: 19px; font-variant-numeric: tabular-nums; }
.summary-action-group ul { margin-bottom: 0; }
.summary-action-group li { font-size: 13px; }
.summary-narrative-details { margin: 12px 0 0; }
```

In the existing `max-width: 960px` media rule, add:

```css
.summary-action-digest { grid-template-columns: 1fr; }
```

In print CSS, add:

```css
.metric-link { color: #000; text-decoration: none; box-shadow: none; }
.summary-action-digest { grid-template-columns: repeat(3, 1fr); }
```

- [ ] **Step 6: Run focused tests and the whole file**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditResultRenderTest.test_summary_narrative_is_folded_and_action_digest_uses_json_facts \
  scripts.test_audit_delivery.AuditResultRenderTest.test_action_kpis_link_to_their_json_backed_sections -v
python3 scripts/test_audit_delivery.py
```

Expected: both focused tests pass and the full suite has zero failures.

- [ ] **Step 7: Commit the summary improvement**

```bash
git add skills/crwu-audit/scripts/audit_delivery.py skills/crwu-audit/scripts/test_audit_delivery.py skills/crwu-audit/template/audit-report.html
git commit -m "feat(crwu-audit): add actionable audit summary"
```

### Task 3: Promote problem locations into a dedicated evidence-backed panel

**Files:**
- Modify: `skills/crwu-audit/scripts/test_audit_delivery.py`
- Modify: `skills/crwu-audit/scripts/audit_delivery.py`
- Modify: `skills/crwu-audit/template/audit-report.html`

- [ ] **Step 1: Write failing location-panel tests**

Add to `AuditResultRenderTest`:

```python
def test_issue_location_panel_shows_summary_and_deduplicated_material_locations(self):
    result = load_sample()
    duplicate = copy.deepcopy(result["issues"][0]["materialEvidence"][0])
    result["issues"][0]["materialEvidence"].append(duplicate)
    document = delivery.render(result)
    first_card_start = document.find('class="issue-card')
    second_card_start = document.find('class="issue-card', first_card_start + 1)
    first_card = document[first_card_start:second_card_start]
    issue = result["issues"][0]
    self.assertIn('class="issue-location-panel"', first_card)
    self.assertIn(issue["locationSummary"], first_card)
    evidence = issue["materialEvidence"][0]
    expected = "{0}</span><span class=\"location-arrow\" aria-hidden=\"true\">→</span><span class=\"location-locator\">{1}".format(
        evidence["displayName"], evidence["locator"]
    )
    self.assertEqual(1, first_card.count(expected))

def test_issue_location_panel_escapes_file_and_locator(self):
    result = load_sample()
    result["issues"][0]["materialEvidence"][0]["displayName"] = "<b>报告.docx</b>"
    result["issues"][0]["materialEvidence"][0]["locator"] = "<script>bad()</script>"
    document = delivery.render(result)
    self.assertIn("&lt;b&gt;报告.docx&lt;/b&gt;", document)
    self.assertIn("&lt;script&gt;bad()&lt;/script&gt;", document)
    self.assertNotIn("<script>bad()</script>", document)
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditResultRenderTest.test_issue_location_panel_shows_summary_and_deduplicated_material_locations \
  scripts.test_audit_delivery.AuditResultRenderTest.test_issue_location_panel_escapes_file_and_locator -v
```

Expected: FAIL because only the muted `locationSummary` paragraph exists.

- [ ] **Step 3: Add a location renderer that only uses material evidence**

Add near `_problem_block`:

```python
def _issue_location_block(issue: dict) -> str:
    seen = set()
    locations = []
    for evidence in issue.get("materialEvidence") or []:
        file_name = str(evidence.get("displayName") or "").strip()
        locator = str(evidence.get("locator") or "").strip()
        key = (file_name, locator)
        if not file_name or not locator or key in seen:
            continue
        seen.add(key)
        locations.append(key)
    parts = ['<section class="issue-location-panel" aria-label="问题位置">']
    parts.append('<p class="issue-location-heading">{0}</p>'.format(_text("问题位置 · 请到以下位置核对")))
    parts.append('<p class="issue-location-summary">{0}</p>'.format(_text(issue.get("locationSummary"))))
    if locations:
        parts.append('<ul class="issue-location-list">')
        for file_name, locator in locations:
            parts.append(
                '<li><span class="location-file">{0}</span>'
                '<span class="location-arrow" aria-hidden="true">→</span>'
                '<span class="location-locator">{1}</span></li>'.format(
                    _text(file_name), _text(locator)
                )
            )
        parts.append("</ul>")
    parts.append("</section>")
    return "".join(parts)
```

In `_issue_card`, remove the old `<p class="issue-location">` append and insert this immediately after `</header>`:

```python
cards.append(_issue_location_block(issue))
cards.append(_problem_block(issue.get("problemDescription")))
```

- [ ] **Step 4: Style the location panel for scanability, narrow screens, and print**

Add:

```css
.issue-location-panel { margin: 11px 0 0; padding: 12px 13px; background: var(--brand-soft); border: 1px solid #b9cde1; border-left: 4px solid var(--brand); border-radius: 8px; }
.issue-location-heading { margin: 0; color: var(--brand-strong); font-size: 13px; font-weight: 700; }
.issue-location-summary { margin: 5px 0 0; color: #243b53; font-weight: 700; }
.issue-location-list { margin: 8px 0 0; padding: 0; list-style: none; }
.issue-location-list li { display: grid; grid-template-columns: minmax(0, .8fr) auto minmax(0, 1.2fr); gap: 8px; align-items: baseline; padding: 5px 0; border-top: 1px solid rgba(23, 75, 114, 0.16); }
.location-file { color: var(--brand-strong); font-weight: 700; }
.location-arrow { color: var(--muted); }
.location-locator { overflow-wrap: anywhere; }
```

Under `max-width: 600px` add:

```css
.issue-location-list li { grid-template-columns: 1fr; gap: 2px; }
.location-arrow { display: none; }
```

Under print add:

```css
.issue-location-panel { background: #fff; border-color: #777; break-inside: avoid; }
```

- [ ] **Step 5: Run focused and complete tests**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditResultRenderTest.test_issue_location_panel_shows_summary_and_deduplicated_material_locations \
  scripts.test_audit_delivery.AuditResultRenderTest.test_issue_location_panel_escapes_file_and_locator -v
python3 scripts/test_audit_delivery.py
```

Expected: all tests pass.

- [ ] **Step 6: Commit the location panel**

```bash
git add skills/crwu-audit/scripts/audit_delivery.py skills/crwu-audit/scripts/test_audit_delivery.py skills/crwu-audit/template/audit-report.html
git commit -m "feat(crwu-audit): highlight problem locations"
```

### Task 4: Put manual confirmations directly after AI issues in content and navigation

**Files:**
- Modify: `skills/crwu-audit/scripts/test_audit_delivery.py`
- Modify: `skills/crwu-audit/scripts/audit_delivery.py`
- Modify: `skills/crwu-audit/template/audit-report.html`

- [ ] **Step 1: Update the expected order and add a direct adjacency test**

Change `REGION_ORDER` to:

```python
REGION_ORDER = [
    "project-info",
    "summary",
    "actionable-issues",
    "manual-confirmation-items",
    "external-data-verification",
    "review-comparison",
    "ai-scorecard",
    "audit-basis",
    "scope-and-not-checked",
    "professional-trail",
    "file-trace",
]
```

Add:

```python
def test_manual_confirmation_directly_follows_ai_issues_in_body_and_catalog(self):
    document = delivery.render(load_sample())
    body = re.search(r'<main id="audit-report">(.*?)</main>', document, re.S).group(1)
    self.assertRegex(
        body,
        re.compile(
            r'<section id="actionable-issues">.*?</section>\s*'
            r'<section id="manual-confirmation-items">',
            re.S,
        ),
    )
    catalog = re.search(r'<nav class="report-catalog".*?</nav>', document, re.S).group(0)
    self.assertLess(
        catalog.find('href="#actionable-issues"'),
        catalog.find('href="#manual-confirmation-items"'),
    )
    self.assertLess(
        catalog.find('href="#manual-confirmation-items"'),
        catalog.find('href="#external-data-verification"'),
    )
```

- [ ] **Step 2: Run the focused order test and verify RED**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest scripts.test_audit_delivery.AuditResultRenderTest.test_manual_confirmation_directly_follows_ai_issues_in_body_and_catalog -v
```

Expected: FAIL because manual confirmations currently follow the scorecard.

- [ ] **Step 3: Move the body section and sidebar link**

In `render`, move the complete `manual-confirmation-items` section block so it immediately follows `</section>` for `actionable-issues`, before `_external_data_section(...)`.

In `template/audit-report.html`, move:

```html
<li><a href="#manual-confirmation-items">人工确认事项</a></li>
```

so it immediately follows the `#actionable-issues` item and precedes `#external-data-verification`.

Wrap the existing not-checked heading, table/empty state, and associated list in:

```python
parts.append('<div id="not-checked-items">')
parts.append("<h4>{0}</h4>".format(_text("未检查项")))
# existing not_checked rendering
parts.append("</div>")
```

This supplies the KPI card target without changing the top-level region list.

- [ ] **Step 4: Run order, catalog, and full tests**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditResultRenderTest.test_manual_confirmation_directly_follows_ai_issues_in_body_and_catalog \
  scripts.test_audit_delivery.AuditResultRenderTest.test_sections_in_required_order \
  scripts.test_audit_delivery.AuditResultRenderTest.test_renderer_uses_standalone_template_with_sidebar_catalog -v
python3 scripts/test_audit_delivery.py
```

Expected: all tests pass.

- [ ] **Step 5: Commit the section order**

```bash
git add skills/crwu-audit/scripts/audit_delivery.py skills/crwu-audit/scripts/test_audit_delivery.py skills/crwu-audit/template/audit-report.html
git commit -m "feat(crwu-audit): group employee action sections"
```

### Task 5: Enforce JSON-first rejection and emit a matching finalized JSON/HTML pair

**Files:**
- Modify: `skills/crwu-audit/scripts/test_audit_delivery.py`
- Modify: `skills/crwu-audit/scripts/audit_delivery.py`

- [ ] **Step 1: Add failing CLI tests for the two-stage gate and paired output**

In `AuditDeliveryCliTest`, add:

```python
def test_render_writes_json_matching_html_embedded_result(self):
    with tempfile.TemporaryDirectory() as temp_dir:
        html_path = Path(temp_dir) / "审核意见.PRJ-2026-0001.html"
        json_path = Path(temp_dir) / "审核结果.PRJ-2026-0001.json"
        exit_code = delivery.main([
            "render", str(SAMPLE_PATH),
            "--out", str(html_path),
            "--json-out", str(json_path),
        ])
        self.assertEqual(0, exit_code)
        archived = json.loads(json_path.read_text(encoding="utf-8"))
        document = html_path.read_text(encoding="utf-8")
        embedded = json.loads(re.search(
            r'<script id="audit-result" type="application/json">(.*?)</script>',
            document,
            re.S,
        ).group(1))
        self.assertEqual(archived, embedded)
        self.assertEqual(delivery.RENDERER_VERSION, archived["fileTrace"]["rendererVersion"])

def test_invalid_json_gate_writes_neither_output(self):
    result = load_sample()
    result["issues"][0]["problemDescription"] = "只有一段，不合规。"
    with tempfile.TemporaryDirectory() as temp_dir:
        source = Path(temp_dir) / "invalid.json"
        source.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        html_path = Path(temp_dir) / "result.html"
        json_path = Path(temp_dir) / "result.json"
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            exit_code = delivery.main([
                "render", str(source),
                "--out", str(html_path),
                "--json-out", str(json_path),
            ])
        self.assertEqual(1, exit_code)
        self.assertIn("issues[0].problemDescription", stderr.getvalue())
        self.assertFalse(html_path.exists())
        self.assertFalse(json_path.exists())
```

Update all existing `delivery.main(["render", ...])` calls to pass an isolated `--json-out` path.

- [ ] **Step 2: Run the new CLI tests and verify RED**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditDeliveryCliTest.test_render_writes_json_matching_html_embedded_result \
  scripts.test_audit_delivery.AuditDeliveryCliTest.test_invalid_json_gate_writes_neither_output -v
```

Expected: FAIL because `--json-out` is not accepted and no paired JSON is written.

- [ ] **Step 3: Add canonical embedded-result extraction and delayed pair writes**

Add:

```python
def embedded_result_from_document(document: str) -> dict:
    match = re.search(
        r'<script id="audit-result" type="application/json">(.*?)</script>',
        document,
        re.S,
    )
    if not match:
        raise ValueError("HTML 缺少内嵌 AuditResult")
    return json.loads(match.group(1))


def _write_render_pair(html_path: Path, json_path: Path, document: str, rendered: dict) -> None:
    html_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    html_temp = html_path.with_name(html_path.name + ".tmp")
    json_temp = json_path.with_name(json_path.name + ".tmp")
    try:
        html_temp.write_text(document, encoding="utf-8")
        json_temp.write_text(canonical_json(rendered) + "\n", encoding="utf-8")
        json_temp.replace(json_path)
        html_temp.replace(html_path)
    finally:
        for path in (html_temp, json_temp):
            if path.exists():
                path.unlink()
```

Change `_cmd_render` so every business validation and post-render validation happens before `_write_render_pair`:

```python
def _cmd_render(args) -> int:
    result = load_result(Path(args.path))
    errors = validate(result, rendered=False)
    if errors:
        for error in errors:
            print("ERROR: {0}".format(error), file=sys.stderr)
        print("JSON 校验失败，已退回修正，未生成 HTML：{0} 项".format(len(errors)), file=sys.stderr)
        return 1
    document = render(result)
    rendered = embedded_result_from_document(document)
    post_errors = validate(rendered, rendered=True, expect_renderer=True)
    if post_errors:
        for error in post_errors:
            print("ERROR: {0}".format(error), file=sys.stderr)
        print("渲染后自检失败，未写出交付文件：{0} 项".format(len(post_errors)), file=sys.stderr)
        return 1
    _write_render_pair(Path(args.out), Path(args.json_out), document, rendered)
    print("已渲染：{0}".format(args.out))
    print("已归档：{0}".format(args.json_out))
    return 0
```

Add the required argument:

```python
render_parser.add_argument("--json-out", required=True, help="输出与 HTML 内嵌对象完全一致的 AuditResult JSON")
```

- [ ] **Step 4: Run focused CLI tests and the complete suite**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest \
  scripts.test_audit_delivery.AuditDeliveryCliTest.test_render_writes_json_matching_html_embedded_result \
  scripts.test_audit_delivery.AuditDeliveryCliTest.test_invalid_json_gate_writes_neither_output -v
python3 scripts/test_audit_delivery.py
```

Expected: invalid JSON produces exit code 1 and no outputs; valid JSON produces two files whose parsed objects match; all tests pass.

- [ ] **Step 5: Commit the JSON-first output contract**

```bash
git add skills/crwu-audit/scripts/audit_delivery.py skills/crwu-audit/scripts/test_audit_delivery.py
git commit -m "feat(crwu-audit): emit matched JSON and HTML artifacts"
```

### Task 6: Synchronize versioned contracts, schema descriptions, sample, and maintenance docs

**Files:**
- Modify: `skills/crwu-audit/scripts/audit_delivery.py`
- Modify: `skills/crwu-audit/scripts/audit_result.schema.json`
- Modify: `skills/crwu-audit/scripts/examples/audit-result.sample.json`
- Modify: `skills/crwu-audit/references/11-html-delivery-spec.md`
- Modify: `skills/crwu-audit/scripts/README.md`
- Modify: `skills/crwu-audit/SKILL.md`
- Modify: `skills/README.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `skills/crwu-audit/scripts/test_audit_delivery.py`

- [ ] **Step 1: Add a failing version-and-documentation contract test**

Add to `AuditResultRenderTest`:

```python
def test_v14_contract_versions_and_json_first_terms_are_synchronized(self):
    skill_root = Path(__file__).resolve().parent.parent
    spec = (skill_root / "references" / "11-html-delivery-spec.md").read_text(encoding="utf-8")
    readme = (skill_root / "scripts" / "README.md").read_text(encoding="utf-8")
    skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
    self.assertEqual("renderer/1.2.4", delivery.RENDERER_VERSION)
    for content in (spec, readme, skill):
        self.assertIn("v1.4", content)
    for content in (spec, readme):
        self.assertIn("--json-out", content)
        self.assertIn("JSON", content)
        self.assertIn("HTML", content)
```

- [ ] **Step 2: Run the version test and verify RED**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest scripts.test_audit_delivery.AuditResultRenderTest.test_v14_contract_versions_and_json_first_terms_are_synchronized -v
```

Expected: FAIL because the current work-in-progress versions are v1.3 and renderer/1.2.3.

- [ ] **Step 3: Update code and sample metadata**

Set:

```python
RENDERER_VERSION = "renderer/1.2.4"
```

Update the module docstring and CLI description from v1.3 to v1.4. In the sample JSON, set `fileTrace.rendererVersion` to `renderer/1.2.4`; keep `sourceDigest` and `embeddedJsonDigest` empty before rendering.

- [ ] **Step 4: Update the JSON Schema descriptions without adding duplicate summary fields**

Keep `schemaVersion` at `1.1.0`. Update descriptions so:

- `summary.counts` states that KPI values and monitoring statistics must be recomputable from `issues`, `manualConfirmationItems`, and `scope.notCheckedItems`.
- `locationSummary` states that HTML locations are rendered with `materialEvidence[].displayName/locator` and cannot be invented by the renderer.
- `problemDescription` states the 2–4 detail-line requirement.
- `fileTrace` states that the rendered paired JSON and HTML embedded object must match.

- [ ] **Step 5: Update the v1.4 delivery spec and runtime instructions**

In `references/11-html-delivery-spec.md`:

- update the document version to v1.4;
- put “需要人工确认事项” directly after “AI 检出的问题项” in the required order table;
- add the linked KPI anchors and action digest rules;
- add the problem-location panel mapping;
- state JSON validation failure returns to AI and blocks all rendering;
- document `render INPUT --out HTML --json-out JSON` and the parsed-object equality requirement;
- state external delivery may remain HTML-only while internal monitoring consumes the paired JSON.

In `scripts/README.md`, document exact commands:

```bash
python3 scripts/audit_delivery.py validate audit-result.json
python3 scripts/audit_delivery.py render audit-result.json \
  --out 审核意见.PRJ-2026-0001.html \
  --json-out 审核结果.PRJ-2026-0001.json
```

In `SKILL.md`, make validate-before-render and `--json-out` mandatory. Update `skills/README.md` and the current `docs/CHANGELOG.md` entry to v1.4 / renderer 1.2.4 and list all four user-facing improvements.

- [ ] **Step 6: Run documentation/version test and full delivery tests**

Run:

```bash
cd skills/crwu-audit
python3 -m unittest scripts.test_audit_delivery.AuditResultRenderTest.test_v14_contract_versions_and_json_first_terms_are_synchronized -v
python3 scripts/test_audit_delivery.py
```

Expected: all tests pass.

- [ ] **Step 7: Commit synchronized contracts**

```bash
git add \
  docs/CHANGELOG.md \
  skills/README.md \
  skills/crwu-audit/SKILL.md \
  skills/crwu-audit/references/11-html-delivery-spec.md \
  skills/crwu-audit/scripts/README.md \
  skills/crwu-audit/scripts/audit_delivery.py \
  skills/crwu-audit/scripts/audit_result.schema.json \
  skills/crwu-audit/scripts/examples/audit-result.sample.json \
  skills/crwu-audit/scripts/test_audit_delivery.py
git commit -m "docs(crwu-audit): synchronize delivery spec v1.4"
```

### Task 7: Run full verification and visually inspect the rendered sample

**Files:**
- Inspect: all files modified above
- Do not add: `tmp-render-preview/` or `.superpowers/`

- [ ] **Step 1: Validate and render the sample through the real JSON-first CLI**

Run:

```bash
cd skills/crwu-audit
preview_dir="$(mktemp -d)"
python3 scripts/audit_delivery.py validate scripts/examples/audit-result.sample.json
python3 scripts/audit_delivery.py render scripts/examples/audit-result.sample.json \
  --out "$preview_dir/审核意见.PRJ-2026-0001.html" \
  --json-out "$preview_dir/审核结果.PRJ-2026-0001.json"
```

Expected: validation succeeds and both output paths are reported.

- [ ] **Step 2: Verify paired JSON equality independently**

Run:

```bash
python3 - "$preview_dir/审核意见.PRJ-2026-0001.html" "$preview_dir/审核结果.PRJ-2026-0001.json" <<'PY'
import json, re, sys
from pathlib import Path
document = Path(sys.argv[1]).read_text(encoding="utf-8")
embedded = json.loads(re.search(r'<script id="audit-result" type="application/json">(.*?)</script>', document, re.S).group(1))
archived = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
assert embedded == archived
print("paired AuditResult objects match")
PY
```

Expected: `paired AuditResult objects match`.

- [ ] **Step 3: Run all relevant automated gates**

From the repository root run:

```bash
python3 skills/crwu-audit/scripts/test_audit_delivery.py
python3 skills/crwu-audit/scripts/test_audit_multiaxis_router.py
python3 skills/crwu-dws/scripts/test_dws_source_contract.py
python3 skills/crwu-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py
python3 skills/crwu-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills
git diff --check
```

Expected: every test suite reports zero failures, `kb_tool` reports `error=0`, and `git diff --check` prints nothing.

- [ ] **Step 4: Inspect the actual rendered HTML at desktop and narrow width**

Open the rendered HTML and verify:

- the long narrative is collapsed by default;
- the three action groups use only JSON titles and counts;
- the first three KPI cards jump to the correct anchors;
- every issue location panel shows the location summary and material file/locator rows;
- manual confirmations immediately follow AI issues;
- at narrow width the location rows and action digest stack without horizontal clipping;
- print preview expands details and keeps problem/location blocks readable.

- [ ] **Step 5: Review final scope and commit status**

Run:

```bash
git status --short
git diff --stat HEAD~4..HEAD
git log -7 --oneline
```

Expected: only authorized report-delivery files and the already committed design/plan documents are included; `tmp-render-preview/` and `.superpowers/` remain untracked or ignored and are not committed.
