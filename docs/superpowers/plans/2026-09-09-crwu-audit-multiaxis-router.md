# crwu-audit Multi-Axis Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the L1/L2 asset-scenario routing tree with an evidence-backed multi-label router that loads the union of scope, asset, business, method, overlay, and public audit skills.

**Architecture:** `crwu-audit/SKILL.md` becomes a short orchestrator that resolves a report `SeqNo` or `ObjectId`, builds a multidimensional `route_profile` from reference-defined rules, looks up each label independently, and loads a stable deduplicated union of skills. Classification rules and the registry live under `skills/crwu-audit/references/`; asset and business skills remain orthogonal, so real-estate rent loads both `asset-realestate` and `business-rent` rather than a combined leaf.

**Tech Stack:** Markdown Agent Skills, Python `unittest` contract checks, repository `tools/kb/kb_tool.py`, skill-creator `quick_validate.py`, Git.

---

## File map

### Router

- Modify: `skills/crwu-audit/SKILL.md` — concise orchestration entrypoint only.
- Replace: `skills/crwu-audit/references/00-route-profile-schema.md` with `00-input-and-route-profile.md`.
- Create: `skills/crwu-audit/references/01-report-id-resolution.md` — `SeqNo`/`ObjectId` resolution.
- Replace: `skills/crwu-audit/references/01-audit-angles-catalog.md` with separate scope, asset, and business classifications.
- Create: `skills/crwu-audit/references/02-scope-classification.md`.
- Create: `skills/crwu-audit/references/03-asset-classification.md`.
- Create: `skills/crwu-audit/references/04-business-classification.md`.
- Create: `skills/crwu-audit/references/05-method-classification.md`.
- Replace: `skills/crwu-audit/references/02-overlay-rules.md` with `06-overlay-classification.md`.
- Create: `skills/crwu-audit/references/07-skill-registry.md`.
- Create: `skills/crwu-audit/references/08-union-dispatch-rules.md`.
- Replace: `skills/crwu-audit/references/03-业务风险分类判定.md` with `09-review-risk-classification.md`.
- Replace: `skills/crwu-audit/references/04-待建子技能提案.md` with `10-capability-gap-proposal.md`.
- Replace: `skills/crwu-audit/references/99-维护说明.md` with `99-maintenance.md`.

### Leaf skills

- Rename: `skills/crwu-audit-realestate/` to `skills/crwu-audit-asset-realestate/`.
- Modify: `skills/crwu-audit-asset-realestate/SKILL.md` — concise asset-only entrypoint.
- Create: `skills/crwu-audit-asset-realestate/references/00-applicability.md`.
- Rename and modify: `skills/crwu-audit-asset-realestate/references/00-KB装配表.md` to `01-kb-assembly.md`.
- Create: `skills/crwu-audit-asset-realestate/references/02-review-focus.md`.
- Delete: `skills/crwu-audit-realestate-rent/`.
- Create: `skills/crwu-audit-business-rent/SKILL.md`.
- Create: `skills/crwu-audit-business-rent/references/00-applicability.md`.
- Create: `skills/crwu-audit-business-rent/references/01-kb-assembly.md`.
- Create: `skills/crwu-audit-business-rent/references/02-review-focus.md`.

### Tests and documentation

- Create: `tools/kb/test_audit_multiaxis_router.py` — executable structural and routing-contract tests.
- Modify: `tools/kb/test_dws_source_contract.py` — active path list after rename/deletion.
- Modify: `skills/crwu-audit-optimize/SKILL.md` and relevant references — new axis names and reference paths.
- Modify: `skills/README.md` — new capability model and skill inventory.
- Modify: `docs/design-crwu-audit-skills.md` — replace the L1/L2 tree with union routing.
- Modify: `docs/CHANGELOG.md` — record the breaking skill refactor.
- Preserve: `docs/superpowers/specs/2026-09-09-crwu-audit-multiaxis-router-design.md` as the approved design source.

---

### Task 1: Add failing multi-axis router contract tests

**Files:**
- Create: `tools/kb/test_audit_multiaxis_router.py`

- [ ] **Step 1: Write the failing structural contract test**

Create the test with these concrete invariants:

```python
from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = REPO_ROOT / "skills"
ROUTER_ROOT = SKILLS_ROOT / "crwu-audit"


class AuditMultiaxisRouterContractTest(unittest.TestCase):
    def test_router_uses_reference_backed_union_dispatch(self):
        router = (ROUTER_ROOT / "SKILL.md").read_text(encoding="utf-8")
        required = [
            "scope_types[]",
            "asset_types[]",
            "business_types[]",
            "methods[]",
            "overlays[]",
            "skills_to_load",
            "08-union-dispatch-rules.md",
        ]
        for term in required:
            with self.subTest(term=term):
                self.assertIn(term, router)
        self.assertNotRegex(router, re.compile(r"\bL1\b|\bL2\b"))

    def test_router_reference_set_is_complete(self):
        required = {
            "00-input-and-route-profile.md",
            "01-report-id-resolution.md",
            "02-scope-classification.md",
            "03-asset-classification.md",
            "04-business-classification.md",
            "05-method-classification.md",
            "06-overlay-classification.md",
            "07-skill-registry.md",
            "08-union-dispatch-rules.md",
            "09-review-risk-classification.md",
            "10-capability-gap-proposal.md",
            "99-maintenance.md",
        }
        actual = {path.name for path in (ROUTER_ROOT / "references").glob("*.md")}
        self.assertEqual(required, actual)

    def test_asset_and_business_skills_are_orthogonal(self):
        self.assertTrue((SKILLS_ROOT / "crwu-audit-asset-realestate/SKILL.md").is_file())
        self.assertTrue((SKILLS_ROOT / "crwu-audit-business-rent/SKILL.md").is_file())
        self.assertFalse((SKILLS_ROOT / "crwu-audit-realestate-rent").exists())
        self.assertFalse((SKILLS_ROOT / "crwu-audit-realestate").exists())

    def test_realestate_liquidation_disposal_auction_loads_union(self):
        dispatch = (ROUTER_ROOT / "references/08-union-dispatch-rules.md").read_text(
            encoding="utf-8"
        )
        expected = [
            "crwu-audit-asset-realestate",
            "crwu-audit-business-liquidation",
            "crwu-audit-business-disposal",
            "crwu-audit-business-auction",
        ]
        scenario_start = dispatch.index("房地产清算后拍卖处置")
        scenario = dispatch[scenario_start : scenario_start + 1200]
        for skill in expected:
            with self.subTest(skill=skill):
                self.assertIn(skill, scenario)

    def test_registry_uses_axis_prefixes_and_marks_unbuilt_skills(self):
        registry = (ROUTER_ROOT / "references/07-skill-registry.md").read_text(
            encoding="utf-8"
        )
        required = [
            "crwu-audit-asset-realestate",
            "crwu-audit-asset-equipment",
            "crwu-audit-asset-intangible",
            "crwu-audit-business-rent",
            "crwu-audit-business-liquidation",
            "crwu-audit-scope-enterprise-value",
            "available",
            "pending",
        ]
        for term in required:
            with self.subTest(term=term):
                self.assertIn(term, registry)
        self.assertNotIn("crwu-audit-realestate-rent", registry)

    def test_active_skill_contracts_do_not_reference_deleted_skill(self):
        active_paths = [
            SKILLS_ROOT / "README.md",
            ROUTER_ROOT / "SKILL.md",
            SKILLS_ROOT / "crwu-audit-asset-realestate/SKILL.md",
            SKILLS_ROOT / "crwu-audit-business-rent/SKILL.md",
        ]
        violations = []
        for path in active_paths:
            text = path.read_text(encoding="utf-8")
            if "crwu-audit-realestate-rent" in text:
                violations.append(str(path.relative_to(REPO_ROOT)))
        self.assertEqual([], violations, "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 tools/kb/test_audit_multiaxis_router.py
```

Expected: FAIL because the router still uses L1/L2, the new references and skill directories do not exist, and the old combination skill still exists.

- [ ] **Step 3: Record the behavioral baseline with an independent evaluation agent**

Give a fresh agent the current `crwu-audit` skill and this scenario without the intended answer:

```text
使用当前 crwu-audit 为“房地产破产清算后拟拍卖处置”生成路由画像和技能调用链。对象为房建类、范围为单项资产，评估目的原文同时出现破产清算、资产处置和公开拍卖。
```

Expected baseline failure: the current model selects or falls back through the L1/L2 path and does not produce four independent asset/business skills. Save the observed routing path in the implementation notes; do not add the output to the repository.

- [ ] **Step 4: Commit the RED contract**

```bash
git add tools/kb/test_audit_multiaxis_router.py
git commit -m "test(skills): define multiaxis audit routing contract"
```

---

### Task 2: Split router classification and dispatch references

**Files:**
- Replace/create all files under `skills/crwu-audit/references/` listed in the file map.

- [ ] **Step 1: Replace the route profile reference**

Create `00-input-and-route-profile.md` with these required sections and fields:

```markdown
# 输入与 route_profile

## 输入字段
记录 `SeqNo`、`ObjectId`、F0000049、F0000056、F0000065、F0000064、
F0000066、F0000119、F0000072、F0000051、F0000067、F0000092、
F0000082、F0000124、F0000126、F0000127 及附件字段。

## route_profile
- identity: input, input_type, seq_no, object_id
- report_form
- scope_types[]
- asset_types[]
- business_types[]
- methods[] and conclusion_method
- overlays[]
- review_risk_class
- material_gaps[] and conflicts[]
- confidence

每个分类标签必须包含 type、source、evidence、confidence、review_required；
企业价值底层资产另含 materiality=key|non-key|unknown。
```

Retain the existing file-reading provenance rules, method roles, hidden-data isolation rules, and anti-fabrication rules from the old schema reference. Remove the single `main_angle`, `scenario`, and `dispatch.L1/L2` model.

- [ ] **Step 2: Add deterministic report identifier resolution**

Create `01-report-id-resolution.md` with the exact rules:

```markdown
# 报告标识解析

1. `ObjectId` may be used only when supplied by the user or returned by a real query.
2. For `SeqNo`, query the report-audit schema by exact `SeqNo` and resolve one result.
3. Zero matches: stop with “未找到该报告流水号”.
4. Multiple matches: list candidates and stop for human confirmation.
5. Never guess schema codes, ObjectId values, or substitute fuzzy title matches for an exact SeqNo.
6. Fetch the record once in the router; leaf skills consume the resulting route_profile and prepared material paths.
```

- [ ] **Step 3: Create scope and asset classifications**

Create `02-scope-classification.md` with canonical values `单项资产`, `资产组合`, `企业价值`, and `其他范围`. Define `单项资产` as a profile-only scope with no required skill, `企业价值` as mapping to pending `crwu-audit-scope-enterprise-value`, and materiality rules for underlying assets.

Create `03-asset-classification.md` with this canonical mapping:

| Canonical asset type | Primary signals | Target skill |
| --- | --- | --- |
| 房地产 | `对象大类=房建类`; report/object text for 房地产、房屋、建筑物、构筑物、场地 | `crwu-audit-asset-realestate` |
| 设备 | `对象大类=设备类`; 机器、设备、车辆、生产线 | `crwu-audit-asset-equipment` |
| 无形资产 | 无形资产范围 or 专利、商标、著作权、专有技术、特许经营权 | `crwu-audit-asset-intangible` |
| 存货 | `对象大类=存货类` | `crwu-audit-asset-inventory` |
| 债权 | `对象大类=债权类` | `crwu-audit-asset-debt` |
| 矿业权 | 采矿权、探矿权或矿业权报告形态 | `crwu-audit-asset-mining-right` |
| 数据资产 | 数据资产、数据使用权、数据经营权 | `crwu-audit-asset-data` |
| 森林资源 | 森林资源、林木、林地组合 | `crwu-audit-asset-forest` |

State that all matching asset labels are retained. `房建类` may be displayed as 房地产, but the definition must say “含房屋建筑物、构筑物、场地及附着物” and retain the original field value.

- [ ] **Step 4: Create the multi-label business classification**

Create `04-business-classification.md`. Require continuing evaluation after every match and define these canonical labels:

| Business label | Signals |
| --- | --- |
| 租赁 | 资产租赁、租金、承租、出租 |
| 清算 | 企业清算、清算价值、清算处置 |
| 破产 | 企业破产、破产重整、破产清算 |
| 资产处置 | 资产处置、报废处置 |
| 资产转让 | 资产转让、产权转让 |
| 拍卖 | 资产拍卖、公开拍卖、司法拍卖 |
| 资产收购 | 资产收购 |
| 资产置换 | 资产置换、置入、置出 |
| 抵押质押 | 资产抵押、资产质押、融资担保 |
| 抵债偿债 | 接受抵债资产、资产偿债、以物抵债 |
| 债务重组 | 债务重组、债转股 |
| 财务报告 | 财务会计报告目的、财务报告目的 |
| 公允价值计量 | 投资性房地产、其他资产或金融资产公允价值计量、合并对价分摊 |
| 减值测试 | 商誉、资产或资产组减值测试、可回收金额 |
| 投资出资 | 对外投资、接受投资、资产出资、增资 |
| 股权变动 | 股东股权比例变动、股权转让 |
| 计税 | 计税价格评估 |
| 追溯评估 | 追溯评估 |
| 司法涉诉 | 司法委托、资产涉诉、执行 |
| 补偿 | 资产补偿、损失补偿、征收补偿 |
| 复核 | 复核报告、审核报告 |
| 价值咨询 | 了解价值、咨询意见书 |

Explicit examples must show that `破产清算后拍卖处置` yields `破产 + 清算 + 资产处置 + 拍卖`, and that field evidence and verified report-purpose text outrank title inference without suppressing additional non-conflicting tags.

- [ ] **Step 5: Move method, overlay, risk, and capability-gap rules**

Create `05-method-classification.md` by extracting method identification, method roles, conclusion-method rules, and source-location requirements from the old router/schema. Define method labels independently and allow multiple methods.

Move the complete active overlay rules to `06-overlay-classification.md`, preserving multi-overlay union behavior and ROUTE conflict checks.

Move the complete A/B/C institution rules to `09-review-risk-classification.md`, rename the profile output to `review_risk_class`, and state that it never selects or removes business skills.

Move the capability-gap proposal to `10-capability-gap-proposal.md`. Replace L1/L2 naming with axis plus label, and require one gap item per missing label while available skills continue.

- [ ] **Step 6: Create the skill registry**

Create `07-skill-registry.md` with columns `axis | label | skill | status | load behavior`. Register at minimum:

```text
scope | 单项资产 | — | profile-only | no skill
scope | 企业价值 | crwu-audit-scope-enterprise-value | pending | record gap
asset | 房地产 | crwu-audit-asset-realestate | available | load
asset | 设备 | crwu-audit-asset-equipment | pending | record gap
asset | 无形资产 | crwu-audit-asset-intangible | pending | record gap
asset | 存货 | crwu-audit-asset-inventory | pending | record gap
asset | 债权 | crwu-audit-asset-debt | pending | record gap
asset | 矿业权 | crwu-audit-asset-mining-right | pending | record gap
business | 租赁 | crwu-audit-business-rent | available | load
business | 清算 | crwu-audit-business-liquidation | pending | record gap
business | 资产处置 | crwu-audit-business-disposal | pending | record gap
business | 拍卖 | crwu-audit-business-auction | pending | record gap
business | 抵押质押 | crwu-audit-business-mortgage | pending | record gap
public | 表格勾稽 | crwu-audit-datacheck | available | load when tabular materials exist
```

Register the remaining labels from `03-asset-classification.md` and `04-business-classification.md` with explicit `pending` status rather than inventing empty skill directories.

- [ ] **Step 7: Define stable union dispatch**

Create `08-union-dispatch-rules.md` with this algorithm:

```text
skills_to_load = stable_unique(
  scope_skills
  + asset_skills
  + business_skills
  + method_skills
  + overlay_skills
  + public_skills
)
```

Require no short-circuiting, no later-skill override, per-label gaps for pending skills, and merged findings with `source_skills[]`. Include complete examples for real-estate rent, real-estate liquidation/disposal/auction, equipment mortgage, and multi-asset enterprise-value liquidation.

- [ ] **Step 8: Rewrite maintenance ownership**

Create `99-maintenance.md` with one owner per concern: schema `00`, ID resolution `01`, scope `02`, asset `03`, business `04`, method `05`, overlay `06`, registry `07`, union/conflicts `08`, review risk `09`, gaps `10`, and router workflow `SKILL.md`. Preserve the existing DWS live-reference, anti-fabrication, hidden-data, source-only repository, documentation synchronization, and validation rules.

- [ ] **Step 9: Remove superseded reference files**

Delete these exact files after their active content has been moved:

```text
skills/crwu-audit/references/00-route-profile-schema.md
skills/crwu-audit/references/01-audit-angles-catalog.md
skills/crwu-audit/references/02-overlay-rules.md
skills/crwu-audit/references/03-业务风险分类判定.md
skills/crwu-audit/references/04-待建子技能提案.md
skills/crwu-audit/references/99-维护说明.md
```

- [ ] **Step 10: Run the reference-set portion of the RED test**

Run:

```bash
python3 tools/kb/test_audit_multiaxis_router.py
```

Expected: reference-set test passes; router and leaf-skill tests still fail.

- [ ] **Step 11: Commit router references**

```bash
git add skills/crwu-audit/references tools/kb/test_audit_multiaxis_router.py
git commit -m "refactor(skills): split audit routing references by axis"
```

---

### Task 3: Rewrite the root router as a concise union orchestrator

**Files:**
- Modify: `skills/crwu-audit/SKILL.md`

- [ ] **Step 1: Replace frontmatter and entry flow**

Use a trigger-only description and keep the body below 300 lines. The body must contain these sections:

```markdown
# crwu-audit 多维并集路由

## 职责与边界
只负责定位报告、生成画像、并集分发和汇总；不产出具体专业审核判断。

## 必读 references
按执行顺序列出 00、01、02–06、07、08、09、10、99，并说明何时读取。

## 输入
接受报告材料包、SeqNo 或 ObjectId；标识解析只按 01。

## 路由流程
取记录一次 → 构建 scope/asset/business/method/overlay 多标签画像 →
查 registry → stable union → 同时加载 → 汇总 source_skills。

## 失败与冲突
唯一 ID 失败、分类冲突、pending skill、知识下载失败和全维度歧义的处理。

## 输出
route_profile、dispatch 分组数组、skills_to_load、能力缺口、依据快照。
```

The frontmatter description must start with `Use when` and identify report audit/routing triggers without summarizing the full workflow.

- [ ] **Step 2: Remove hierarchical dispatch language**

Remove all active use of `L1`, `L2`, parent-child fallback, “细分未命中降级父级”, and the in-file registry. Point registry ownership to `references/07-skill-registry.md` and union semantics to `references/08-union-dispatch-rules.md`.

- [ ] **Step 3: Run the router test**

```bash
python3 tools/kb/test_audit_multiaxis_router.py
```

Expected: router union-contract test passes; leaf directory tests still fail.

- [ ] **Step 4: Validate the root skill**

```bash
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit
```

Expected: validation succeeds with no frontmatter, naming, or unfinished-scaffold errors.

- [ ] **Step 5: Commit the router entrypoint**

```bash
git add skills/crwu-audit/SKILL.md
git commit -m "refactor(skills): make audit router load skill unions"
```

---

### Task 4: Convert real estate into an asset-only skill

**Files:**
- Rename and modify: `skills/crwu-audit-realestate/` → `skills/crwu-audit-asset-realestate/`.

- [ ] **Step 1: Rename the directory and KB assembly reference**

```bash
git mv skills/crwu-audit-realestate skills/crwu-audit-asset-realestate
git mv skills/crwu-audit-asset-realestate/references/00-KB装配表.md skills/crwu-audit-asset-realestate/references/01-kb-assembly.md
```

- [ ] **Step 2: Rewrite the asset skill entrypoint**

Set the skill name to `crwu-audit-asset-realestate`. Its description must trigger only for router-selected real-estate/房建类 audit work. Keep the body concise and require reading:

```markdown
- references/00-applicability.md — 房地产及房屋建（构）筑物边界
- references/01-kb-assembly.md — 本次 KB 路径装配
- references/02-review-focus.md — 房地产资产专业关注点
```

State explicitly that the skill does not decide whether the engagement is rent, liquidation, disposal, auction, mortgage, or financial reporting; those concerns come from independently loaded business skills.

- [ ] **Step 3: Create asset applicability and review-focus references**

`00-applicability.md` must define:

- canonical label `房地产`;
- source mapping from `房建类`;
- included objects: 房屋、建筑物、构筑物、场地、附着物 and related property interests;
- boundary note for wells and other structures;
- multi-asset behavior and `materiality`;
- exclusions delegated to equipment, intangible, inventory, and mining-right skills.

`02-review-focus.md` must move the existing object-specific content into these headings without copying KB rule bodies:

```text
对象边界与权属
实体、权益与区位状况
用途管制与最优利用
土地、建筑物、设备界面防重防漏
房地产方法适用性接口
报告、说明、明细表一致性
```

- [ ] **Step 4: Refocus KB assembly**

Update `01-kb-assembly.md` so it owns real-estate object and method path keys, not the rent business decision. Keep the existing DWS live-download contract and directory-level download semantics. Move rent-only CHK path selection to the business-rent skill in Task 5.

- [ ] **Step 5: Validate the asset skill**

```bash
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit-asset-realestate
```

Expected: validation succeeds.

- [ ] **Step 6: Commit the asset rename**

```bash
git add -A skills/crwu-audit-realestate skills/crwu-audit-asset-realestate
git commit -m "refactor(skills): rename realestate audit as asset skill"
```

---

### Task 5: Replace the real-estate-rent combination with a business-rent skill

**Files:**
- Delete: `skills/crwu-audit-realestate-rent/`.
- Create: `skills/crwu-audit-business-rent/` and its references.

- [ ] **Step 1: Create the business-rent skill entrypoint**

Create `skills/crwu-audit-business-rent/SKILL.md` with name `crwu-audit-business-rent`. Its description triggers for router-selected rent, lease, lessor, lessee, or market-rent audit scenarios across asset types. Require router orchestration and the three local references.

The body must state:

```text
This skill owns rental-purpose and lease-scenario review concerns.
It does not own real-estate, equipment, or intangible object rules.
The router must load every matching asset skill alongside this skill.
```

- [ ] **Step 2: Create rent applicability**

`references/00-applicability.md` must define rent signals from `F0000065`, `F0000064`, report name, and verified purpose text. It must retain both rent and any simultaneous disposal, liquidation, mortgage, or financial-report tags rather than suppressing them.

- [ ] **Step 3: Migrate rent KB assembly**

Create `references/01-kb-assembly.md` from the current combination skill's assembly table. Preserve the real-estate rent CHK-MKT/CHK-CST paths as conditional entries with `asset_type=房地产` and `business_type=租赁`. Mark equipment or other asset rent checklists as unavailable when no KB path exists; do not invent paths or rules.

- [ ] **Step 4: Create rent review focus**

`references/02-review-focus.md` must retain only business-scenario concerns:

```text
租赁目的与租赁范围
出租人、承租人和租赁权利边界
租期、续租、免租期及租约限制
合同租金与市场租金口径
税费、物业费及其他收支口径
空置、优惠和租赁状态
基准日与租赁条件一致性
与资产、方法及财务报告 skill 的交叉接口
```

Object-specific权属、区位、最优利用、建筑状况 and土地/建筑/设备界面 remain in `asset-realestate`.

- [ ] **Step 5: Delete the old combination skill**

```bash
git rm -r skills/crwu-audit-realestate-rent
```

Do not add a redirect, alias, compatibility description, or duplicate checklist.

- [ ] **Step 6: Run the structural tests and skill validation**

```bash
python3 tools/kb/test_audit_multiaxis_router.py
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit-business-rent
```

Expected: asset/business orthogonality and deleted-skill tests pass; documentation-path tests may still fail until Task 6.

- [ ] **Step 7: Commit the business skill migration**

```bash
git add -A skills/crwu-audit-realestate-rent skills/crwu-audit-business-rent
git commit -m "refactor(skills): split rent into a business audit skill"
```

---

### Task 6: Update active contracts, optimizer references, and documentation

**Files:**
- Modify: `tools/kb/test_dws_source_contract.py`.
- Modify: `skills/crwu-audit-optimize/SKILL.md`.
- Modify: `skills/crwu-audit-optimize/references/00-优化规范与文件落点.md`.
- Modify: `skills/crwu-audit-optimize/references/01-反馈定位与画像流程.md`.
- Modify: `skills/crwu-audit-optimize/references/02-方案模板与确认门禁.md` if it contains L1/L2 or old names.
- Modify: `skills/README.md`.
- Modify: `docs/design-crwu-audit-skills.md`.
- Modify: `docs/CHANGELOG.md`.

- [ ] **Step 1: Update DWS contract paths**

Replace old active paths in `ACTIVE_CONTRACT_FILES` with:

```python
"skills/crwu-audit/references/10-capability-gap-proposal.md",
"skills/crwu-audit/references/99-maintenance.md",
"skills/crwu-audit-asset-realestate/SKILL.md",
"skills/crwu-audit-asset-realestate/references/01-kb-assembly.md",
"skills/crwu-audit-business-rent/SKILL.md",
"skills/crwu-audit-business-rent/references/01-kb-assembly.md",
```

Keep the existing DWS and datacheck paths unchanged.

- [ ] **Step 2: Update optimizer ownership language**

Replace every active L1/L2 or parent-child proposal model with axis-aware ownership:

```text
scope / asset / business / method / overlay / public
```

Capability proposals must name one missing axis label and its proposed `crwu-audit-<axis>-*` skill. Optimizer flows must read `99-maintenance.md`, update `07-skill-registry.md`, and avoid creating asset×business combination skills.

- [ ] **Step 3: Rewrite the skills README capability model**

Replace the three-layer tree explanation with the union equation and list:

```text
crwu-audit
crwu-audit-asset-realestate
crwu-audit-business-rent
crwu-audit-datacheck
```

Remove the active listing for `crwu-audit-realestate-rent`. Explain that pending labels live in the registry without empty skill folders.

- [ ] **Step 4: Update the audit architecture design**

In `docs/design-crwu-audit-skills.md`, replace L1/L2 diagrams, tables, route examples, and fallback language with:

```text
scope skills ∪ asset skills ∪ business skills ∪ method skills ∪ overlay skills ∪ public skills
```

Retain current DWS live-reference and audit-output contracts. Link to the approved 2026-09-09 design specification for the full route schema.

- [ ] **Step 5: Append the changelog entry**

Add a `2026-09-09 · refactor · crwu-audit 改为多维并集技能路由` entry stating:

- breaking deletion of `crwu-audit-realestate-rent`;
- rename to `crwu-audit-asset-realestate`;
- new `crwu-audit-business-rent`;
- classification/registry/union rules moved to references;
- `business_risk_class` renamed to `review_risk_class`;
- no CLI command changes and no runtime-directory deployment performed.

- [ ] **Step 6: Scan active files for stale hierarchy references**

Run:

```bash
rg -n "crwu-audit-realestate-rent|crwu-audit-realestate\b|dispatch\.L1|dispatch\.L2|细分未命中.*降级|父大方向" skills tools/kb/test_dws_source_contract.py docs/design-crwu-audit-skills.md
```

Expected: no active stale references. Historical entries in `docs/CHANGELOG.md` and the approved migration design may retain old names as history.

- [ ] **Step 7: Run contract tests**

```bash
python3 tools/kb/test_audit_multiaxis_router.py
python3 tools/kb/test_dws_source_contract.py
```

Expected: all tests pass.

- [ ] **Step 8: Commit contract and documentation updates**

```bash
git add tools/kb/test_dws_source_contract.py skills/crwu-audit-optimize skills/README.md docs/design-crwu-audit-skills.md docs/CHANGELOG.md
git commit -m "docs(skills): align audit family with union routing"
```

---

### Task 7: Validate routing behavior and repository integrity

**Files:**
- Modify only files found defective by the checks below, keeping fixes in scope.

- [ ] **Step 1: Run all deterministic skill contract tests**

```bash
python3 tools/kb/test_audit_multiaxis_router.py
python3 tools/kb/test_dws_source_contract.py
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Validate each changed skill package**

```bash
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit-asset-realestate
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit-business-rent
```

Expected: all three validations succeed.

- [ ] **Step 3: Run KB skill-reference validation**

```bash
python3 tools/kb/kb_tool.py validate --skill-root skills
```

Expected: zero validation errors. Investigate warnings caused by this change; report unrelated pre-existing warnings without altering unrelated files.

- [ ] **Step 4: Run repository tests**

```bash
go test ./...
```

Expected: all packages pass.

- [ ] **Step 5: Forward-test the skill with an independent evaluation agent**

Run the same scenario used in Task 1, now with the refactored router and references. Expected `skills_to_load` includes:

```text
crwu-audit-asset-realestate
crwu-audit-business-liquidation
crwu-audit-business-disposal
crwu-audit-business-auction
```

The three pending business skills must be recorded as per-label capability gaps rather than silently omitted or replaced by the rent skill.

Run a second scenario:

```text
企业价值评估，评估目的同时包含破产清算和资产处置；资产基础法明细中房地产和设备单独评估，无形资产仅按账面值列示。
```

Expected profile:

```text
scope_types: 企业价值
asset_types: 房地产(key), 设备(key), 无形资产(non-key)
business_types: 破产, 清算, 资产处置
```

Expected dispatch records the pending enterprise-value and missing business/asset skills individually while loading every available matching skill.

- [ ] **Step 6: Verify no unintended working-tree changes**

```bash
git status --short
git diff --check
git diff --stat HEAD~5..HEAD
```

Expected: only planned skill, reference, test, and documentation files changed; no runtime skill directories or credentials appear.

- [ ] **Step 7: Commit any verification fixes**

If the checks required in-scope corrections:

```bash
git add skills tools/kb docs
git commit -m "fix(skills): close multiaxis routing validation gaps"
```

If no corrections were needed, do not create an empty commit.

---

## Completion checklist

- [ ] Old combination skill directory is deleted.
- [ ] Real estate is named and scoped as `crwu-audit-asset-realestate`.
- [ ] Rent is implemented as `crwu-audit-business-rent`.
- [ ] Scope, asset, business, method, and overlay labels are independently multi-valued.
- [ ] Registry status distinguishes available, pending, and profile-only labels.
- [ ] `skills_to_load` is a stable union with no first-match short circuit.
- [ ] Enterprise-value routes include key and non-key underlying assets with explanation.
- [ ] Main and leaf `SKILL.md` files are concise; detailed rules live under references.
- [ ] `review_risk_class` is distinct from `business_types[]`.
- [ ] DWS live-reference, anti-fabrication, hidden-data, datacheck, and output contracts remain intact.
- [ ] Static tests, skill validation, KB validation, Go tests, and independent behavioral tests pass.
- [ ] README, architecture design, and CHANGELOG match the new model.
