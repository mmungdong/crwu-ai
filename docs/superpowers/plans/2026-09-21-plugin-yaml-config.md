# Plugin YAML Configuration Implementation Plan

> [!NOTE]
> **Status: historical snapshot (2026-09-21).** This plan preserves implementation context from that date;
> it is not current operating guidance. Start from [`README.md`](../../../README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `plugins/dsh-crwu-workbench/config/crwu-workbench.yml` the single configuration source used directly in development and embedded unchanged in the distributable TGZ.

**Architecture:** A shared parser validates and normalizes the YAML into the existing flat `WorkbenchConfig`. The Host loads an explicitly selected YAML in development or the package-local YAML after installation. Packaging validates and includes the YAML, while distribution derives the TGZ OSS write URL and employee HTTPS read URL from its read-only OSS section.

**Tech Stack:** Node.js 22/24, TypeScript, YAML, node:test, npm pack, GNU Make.

---

### Task 1: Configuration contract

**Files:**
- Create: `plugins/dsh-crwu-workbench/config/crwu-workbench.yml`
- Create: `plugins/dsh-crwu-workbench/tests/unit/host-yaml-config.test.mjs`
- Create: `plugins/dsh-crwu-workbench/src/host/config/yaml.ts`
- Modify: `plugins/dsh-crwu-workbench/package.json`
- Modify: `plugins/dsh-crwu-workbench/package-lock.json`

- [x] Write failing tests for parsing the read-only and protected OSS sections, URL derivation, invalid schemas, and external-file precedence.
- [x] Run the focused test and confirm it fails because the YAML loader does not exist.
- [x] Add the YAML dependency, source YAML, strict validation, normalization, and development/package path resolution.
- [x] Run the focused test and confirm it passes.

### Task 2: Host integration

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/config/config.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/apply.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/environment/ops.ts`
- Modify: `plugins/dsh-crwu-workbench/cordis.patch.yml`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/host-package.test.mjs`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/host-environment-env.test.mjs`

- [x] Write failing tests proving Host activation resolves the YAML and protected OSS values override the remote manifest.
- [x] Run the focused tests and confirm the expected failures.
- [x] Load the YAML once during Host activation, remove request-level manifest source overrides, and merge the protected OSS settings into the effective manifest.
- [x] Run the focused tests and confirm they pass.

### Task 3: Packaging and distribution

**Files:**
- Modify: `plugins/dsh-crwu-workbench/package.json`
- Modify: `plugins/dsh-crwu-workbench/scripts/assert-pack.mjs`
- Modify: `scripts/dist-plugin.mjs`
- Modify: `Makefile`
- Create: `plugins/dsh-crwu-workbench/tests/unit/dist-config.test.mjs`

- [x] Write failing tests proving the TGZ contains the YAML and distribution URLs are derived from it.
- [x] Run the focused tests and confirm the expected failures.
- [x] Add prepack validation, package assertions, YAML-driven distribution URL derivation, and the Makefile wiring.
- [x] Run the focused tests and confirm they pass.

### Task 4: Documentation and verification

**Files:**
- Modify: `plugins/dsh-crwu-workbench/README.md`
- Modify: `plugins/dsh-crwu-workbench/README.en.md`

- [x] Document development loading, package embedding, the public/private OSS boundary, and commands.
- [x] Run `npm run check`, `npm run pack:assert`, the Python skill gates, `node ../../scripts/dist-plugin.mjs --self-test`, `go test ./...`, and `git diff --check`.
- [x] Inspect the packed file list and verify the worktree contains only intentional changes.
