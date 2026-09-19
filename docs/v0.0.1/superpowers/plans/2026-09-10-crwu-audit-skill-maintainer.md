# crwu-audit-skill-maintainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-repo maintenance skill that inventories a supplied DingTalk knowledge-base tree, identifies missing or invalid first-level asset/business skills and mappings, and safely creates, repairs, or remaps those skills after approval.

**Architecture:** A concise `SKILL.md` routes four maintenance modes to focused references. A stdlib-only Python checker parses DWS snapshot/node-index JSON or the pasted Markdown tree, compares first-level knowledge-base folders with `crwu-audit` classification/registry and source skill directories, then emits deterministic JSON/text findings without modifying files. Asset subobjects and business subroutes remain internal indexes of their first-level parent skills.

**Tech Stack:** Markdown Skill contracts, Python 3 standard library, `unittest`, existing `crwu-dws` schemas and repository validators.

**Spec:** `docs/superpowers/specs/2026-09-10-crwu-audit-skill-maintainer-design.md`

## Global Constraints

- Modify source repo only; never write or install runtime skill directories.
- Preserve all pre-existing dirty worktree changes and patch overlapping files locally.
- Asset skills use `crwu-audit-asset-*`; business skills use `crwu-audit-biz-*`.
- One skill maps one first-level asset or business directory with `request_kind=directory` and recursive download enabled.
- Subobjects and subroutes never become separate registry skills.
- Do not store the knowledge-base name, local absolute paths, nodeId constants, downloaded bodies, or credentials in skill source.
- The checker is read-only; source mutations require a prior human-approved per-file maintenance proposal.

---

### Task 1: Inventory checker contract

**Files:**
- Create: `tools/kb/test_audit_skill_maintainer.py`
- Create: `skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py`

**Interfaces:**
- Consumes: `--repo-root PATH`, `--catalog PATH`, `--format text|json`, optional `--strict`.
- Produces: schema `crwu.audit-skill-maintainer.report.v1`, catalog roots, `findings[]`, `proposals[]`, and summary counts; strict mode exits nonzero when error findings exist.

- [ ] **Step 1: Write failing behavioral tests**

Create `unittest` fixtures that invoke the checker as a subprocess and assert these observable outcomes:

1. A pasted Markdown tree containing `房地产/土地使用权` and `资产经营/租赁与租金评估` proposes only the missing first-level parents.
2. A valid first-level asset and business mapping produces no missing-skill or root-mapping finding.
3. A legacy `crwu-audit-business-*` name, a per-file-only assembly, a missing asset common reference, a missing subobject review item, and a missing child-business review file produce distinct findings.
4. DWS snapshot and node-index inputs resolve to the same normalized knowledge paths as the Markdown tree.
5. JSON output is stable and strict exit behavior distinguishes detected errors from a clean inventory.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
python3 tools/kb/test_audit_skill_maintainer.py
```

Expected: failure because the checker entry point does not yet exist.

- [ ] **Step 3: Implement the minimal checker**

Implement:

```python
def load_catalog(path: Path) -> Catalog: ...
def inspect_repository(repo_root: Path, catalog: Catalog) -> dict[str, object]: ...
def render_text(report: dict[str, object]) -> str: ...
def main(argv: Sequence[str] | None = None) -> int: ...
```

The checker must normalize numeric folder prefixes for label comparison while preserving exact knowledge paths in evidence. It must exclude top-level `TODO` folders, validate the parent-skill rule, and never mutate the repository or catalog.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
python3 tools/kb/test_audit_skill_maintainer.py
```

Expected: all checker behavior tests pass.

### Task 2: Maintenance skill instructions

**Files:**
- Create: `skills/crwu-audit-skill-maintainer/SKILL.md`
- Create: `skills/crwu-audit-skill-maintainer/references/00-responsibility-and-modes.md`
- Create: `skills/crwu-audit-skill-maintainer/references/01-kb-source-discovery.md`
- Create: `skills/crwu-audit-skill-maintainer/references/02-child-skill-contract.md`
- Create: `skills/crwu-audit-skill-maintainer/references/03-review-item-execution-contract.md`
- Create: `skills/crwu-audit-skill-maintainer/references/04-registry-and-mapping-update.md`
- Create: `skills/crwu-audit-skill-maintainer/references/05-validation-and-delivery.md`

**Interfaces:**
- Consumes: knowledge tree or live DWS space, source repo, optional mode/axis/label/target skill.
- Produces: read-only inventory report or approved source change set; never an assessment-report audit opinion.

- [ ] **Step 1: Add the minimal discoverable entry point**

Use frontmatter name `crwu-audit-skill-maintainer` and a `Use when...` description that triggers on creating, repairing, remapping, or inventorying `crwu-audit` asset/business skills. Route `inventory`, `create`, `repair`, and `remap` to the relevant references.

- [ ] **Step 2: Define knowledge discovery and parent/child rules**

Specify that the supplied tree provides structural candidates, while definitive mappings require a fresh DWS directory refresh and recursive body download. First-level asset/business folders propose skills; fine objects and child businesses only extend the parent skill's applicability and review selection.

- [ ] **Step 3: Define child skill and review-item contracts**

Specify the three-reference leaf structure, first-level directory root row, second-level classification return, mandatory-check statuses, historical-issue statuses, standards precedence, and capability-gap behavior for missing or placeholder knowledge.

- [ ] **Step 4: Define mutation gate and delivery**

Inventory stays read-only. Create/repair/remap records git baseline and target hashes, emits a per-file proposal, waits for user approval, rechecks hashes, modifies only approved source files, and reports exact verification results.

### Task 3: Repository integration

**Files:**
- Modify: `skills/AGENTS.md`
- Modify: `skills/README.md`
- Modify: `skills/crwu-audit-optimize/SKILL.md`
- Modify: `docs/design-crwu-audit-skills.md`
- Modify: `docs/CHANGELOG.md`

**Interfaces:**
- Consumes: canonical naming and lifecycle from Tasks 1–2.
- Produces: consistent maintainer discovery, handoff, and repository policy.

- [ ] **Step 1: Update repository policy**

Replace the business leaf prefix contract with `crwu-audit-biz-*`, add first-level directory root mapping and recursive DWS download rules, and state that fine objects/subroutes remain parent-skill indexes.

- [ ] **Step 2: Register the maintainer without overwriting dirty edits**

Append a focused entry to the current `skills/README.md`, add a maintainer handoff to `crwu-audit-optimize`, and add concise architecture/changelog notes. Before each overlapping edit, compare the current file with the recorded baseline and patch only the intended block.

- [ ] **Step 3: Review the resulting diff**

Confirm no downloaded bodies, runtime paths, knowledge-base name constants, nodeId values, credentials, or unrelated worktree changes entered the implementation diff.

### Task 4: Validation and delivery

**Files:**
- Modify if required by observed failures: files created or modified in Tasks 1–3 only.

**Interfaces:**
- Consumes: completed implementation.
- Produces: verified source change set and honest report of unrelated migration failures.

- [ ] **Step 1: Validate the new skill and checker**

Run:

```bash
python3 tools/kb/test_audit_skill_maintainer.py
python3 /Users/mungdong/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/crwu-audit-skill-maintainer
```

Expected: checker tests pass and quick validation succeeds.

- [ ] **Step 2: Run repository contract checks**

Run:

```bash
python3 tools/kb/test_audit_multiaxis_router.py
python3 tools/kb/test_dws_source_contract.py
python3 tools/kb/kb_tool.py validate --skill-root skills
git diff --check
```

Record actual results. Existing migration failures must remain visible and must not be repaired outside the approved scope merely to make the suite green.

- [ ] **Step 3: Exercise the user's directory-tree scenario**

Run the checker against the supplied 263-node pasted tree in JSON and text modes. Confirm it proposes first-level skills/mappings and separately reports missing review content, without proposing skills for `土地使用权` or `租赁与租金评估`.

- [ ] **Step 4: Commit only authorized implementation files**

Use an explicit path list so pre-existing staged or unstaged migration changes remain uncommitted. Report the commit, tests, identified current gaps, and files changed.
