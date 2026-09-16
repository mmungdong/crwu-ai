# README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outdated CLI-only repository landing page with a polished, accurate, bilingual overview of the current CRWU CLI, Skills ecosystem, audit workflow, enterprise integrations, and maintainer entry points.

**Architecture:** Keep `README.md` as the English canonical landing page and synchronize `README.zh-CN.md` section-for-section in Chinese. Use GitHub-native Markdown, compact tables, Mermaid diagrams, callouts, and collapsible details; link deep operational material instead of duplicating it.

**Tech Stack:** GitHub Flavored Markdown, Mermaid, Shields.io badges, Go CLI metadata from `crwu scheme`.

**Spec:** `docs/superpowers/plans/2026-09-16-readme-redesign.md` (the approved design and exact constraints are recorded below).

## Global Constraints

- Keep English as the primary GitHub landing page in `README.md`.
- Maintain a fully synchronized Chinese version in `README.zh-CN.md`.
- Describe only capabilities verified in the repository, `crwu scheme`, `skills/README.md`, or `docs/CHANGELOG.md`.
- Present the project as a combined CLI and AI Skills toolkit, not an H3Yun-only CLI.
- Keep operational detail in the dedicated manuals and use links from the README.
- Do not introduce external image assets or change application code.
- Preserve the employee-scoped H3Yun credential and read-only safety boundaries.
- Treat MCP as a boundary or optional provider channel where appropriate; do not imply that a standalone CRWU MCP transport is already shipped.

---

### Task 1: Rewrite the English landing page

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `crwu scheme`, `skills/README.md`, `docs/cli-manual.md`, and `docs/CHANGELOG.md`.
- Produces: the canonical information architecture and terminology mirrored by the Chinese README.

- [x] **Step 1: Replace the hero and positioning**

  Add a centered hero, language switch, restrained status badges, a current one-line value proposition, and four capability cards.

- [x] **Step 2: Add task-oriented navigation and quick starts**

  Add role-based paths for audit users, employees, agent users, and maintainers, followed by build, H3Yun login, and Skills installation entry points.

- [x] **Step 3: Document the current capability model**

  Add an accurate audit workflow, Skills taxonomy, CLI summary, architecture, security boundaries, repository map, and documentation index.

- [x] **Step 4: Run English README structural checks**

  Run:

  ```bash
  rg -n '^## ' README.md
  rg -n 'roadmap|planned|Python Skills' README.md
  ```

  Expected: ordered sections are present and obsolete claims that Skills are only planned are absent.

### Task 2: Synchronize the Chinese landing page

**Files:**
- Modify: `README.zh-CN.md`

**Interfaces:**
- Consumes: the final heading order, tables, diagrams, links, and factual claims in `README.md`.
- Produces: a natural Chinese version with the same scope and navigation.

- [x] **Step 1: Mirror the complete English structure**

  Translate the hero, capability overview, role paths, quick starts, workflows, architecture, safety guidance, repository map, and document index without dropping sections.

- [x] **Step 2: Preserve technical tokens exactly**

  Keep command names, paths, skill identifiers, environment variables, versions, URLs, and Mermaid node relationships identical to the English source.

- [x] **Step 3: Compare heading parity**

  Run:

  ```bash
  python3 - <<'PY'
  from pathlib import Path
  for name in ("README.md", "README.zh-CN.md"):
      headings = [line for line in Path(name).read_text().splitlines() if line.startswith("## ")]
      print(name, len(headings))
      print("\n".join(headings))
  PY
  ```

  Expected: both files have the same number of level-two sections in the same conceptual order.

### Task 3: Verify links, commands, formatting, and repository health

**Files:**
- Verify: `README.md`
- Verify: `README.zh-CN.md`
- Verify: `docs/superpowers/plans/2026-09-16-readme-redesign.md`

**Interfaces:**
- Consumes: both completed README variants.
- Produces: verification evidence suitable for handoff.

- [x] **Step 1: Validate local Markdown links**

  Run a Python script that extracts relative Markdown links from both READMEs, removes anchors, and fails if any target is missing.

- [x] **Step 2: Validate CLI command claims**

  Run `go run ./cmd/crwu scheme` and compare the README command list against the emitted catalog.

- [x] **Step 3: Run formatting and repository checks**

  Run:

  ```bash
  git diff --check
  go test ./...
  ```

  Expected: no whitespace errors and all Go packages pass.

- [x] **Step 4: Review the complete diff**

  Run `git diff -- README.md README.zh-CN.md docs/superpowers/plans/2026-09-16-readme-redesign.md` and verify every approved requirement is represented in both languages.
