# Documentation Governance Implementation Plan

> [!NOTE]
> **Status: historical snapshot (completed 2026-10-04).** This plan records the implementation and verification
> sequence. Current operating rules live in the scoped `AGENTS.md` files and linked active documentation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repository instructions and active documentation concise, current, and protected by a small deterministic CI gate.

**Architecture:** Treat code, package metadata, command catalogs, and directory layout as facts; keep Markdown as concise guidance and conditional navigation. A dependency-free Node checker validates only declared active entry documents, while historical records remain immutable apart from a uniform status banner.

**Tech Stack:** Markdown, Node.js ESM with `node:test`, GitHub Actions, GNU Make

**Spec:** `docs/superpowers/specs/2026-10-04-documentation-governance-design.md`

## Global Constraints

- Preserve public installation and CLI manual paths.
- Keep English and Simplified Chinese READMEs structurally equivalent.
- Do not modify vendored DWS content or rewrite historical bodies.
- Do not add external dependencies or network checks.
- Do not commit or push.

## Review Focus

- Markdown destinations containing fragments, URL encoding, or angle brackets resolve correctly.
- External URLs, mail links, and same-page anchors are not treated as local files.
- Historical CHANGELOG bodies do not force repairs to old paths while their active header navigation stays checked.
- README guards reject fixed Workbench semver and numeric Skill totals without rejecting ordinary prose.
- Nested `AGENTS.md` files retain security, lifecycle, packaging, and verification boundaries after pruning.

---

### Task 1: Documentation gate

**Files:**
- Create: `scripts/check-docs.test.mjs`
- Create: `scripts/check-docs.mjs`
- Modify: `Makefile`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the explicit active-document list and repository filesystem.
- Produces: `node scripts/check-docs.mjs`, a zero-dependency exit-code gate with actionable diagnostics.

- [x] Write tests for local-link resolution, ignored URL classes, scoped CHANGELOG checking, and README dynamic-fact rejection.
- [x] Run `node --test scripts/check-docs.test.mjs` and confirm failure because the checker does not exist.
- [x] Implement the minimal parser and validators.
- [x] Run the focused test and confirm it passes.
- [x] Add `make docs-check` and one Linux CI step, then run the command against the repository.

### Task 2: Active instructions and entry documents

**Files:**
- Modify: `AGENTS.md`
- Modify: `plugins/AGENTS.md`
- Modify: `plugins/dsh-crwu-workbench/AGENTS.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/skills.md`
- Modify: `docs/v0.0.1/cli-manual.md`
- Modify: `docs/v0.0.1/CHANGELOG.md`

**Interfaces:**
- Consumes: current source layout, package scripts, `crwu scheme`, and existing focused maintainer docs.
- Produces: scoped instructions and concise navigation without duplicated dynamic facts.

- [x] Reduce each `AGENTS.md` to enforceable scoped rules, verification, and conditional pointers.
- [x] Rewrite both root READMEs with matching structure and no fixed Workbench version or Skill total.
- [x] Convert `docs/skills.md` from an inventory cache into a layer and maintenance guide.
- [x] Clarify CLI documentation ownership and repair the two active header links.
- [x] Run the documentation gate and inspect the bilingual diff together.

### Task 3: Historical status markers

**Files:**
- Modify: the 23 approved historical documents under `docs/`, `docs/v0.0.1/superpowers/`, and `plugins/dsh-crwu-workbench/docs/`.

**Interfaces:**
- Consumes: each document's date or release scope.
- Produces: a consistent status banner without modifying historical body text.

- [x] Add the banner to the two audit/backlog records.
- [x] Add the banner to the 17 dated plans/specs.
- [x] Add the banner to the four versioned Workbench acceptance/review/handoff records.
- [x] Verify the approved count is exactly 23 and vendored/current/ambiguous documents are untouched.

### Task 4: Verification and handoff

**Files:**
- Modify: this plan's status only after every verification succeeds.

**Interfaces:**
- Consumes: all changes from Tasks 1–3.
- Produces: evidence that the repository is consistent, or an explicit report of remaining failures.

- [x] Run `node --test scripts/check-docs.test.mjs` and `make docs-check`.
- [x] Run `go test ./...`.
- [x] Run the existing plugin version, Skill, type, test, build, smoke, and pack checks relevant to documentation and CI changes.
- [x] Run `git diff --check` and inspect `git status --short`.
- [x] Mark this plan historical only when all required checks pass; do not commit or push.
