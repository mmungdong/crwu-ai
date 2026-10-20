# Persistent Node Questionnaire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve every pre-existing change; no commits.

**Goal:** Keep typed node questions and cumulative editable answers in the task SQLite JSON and render them reliably across rounds.

**Architecture:** A pure questionnaire model owns validation, versions and history. The application service persists it before driving nodes; existing Host transports and Client controller expose draft/save/submit. Node details render durable forms with collapsed IO.

**Tech Stack:** Existing TypeScript, React, Node test runner and SQLite store, without new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-node-questionnaire-design.md`

## Global Constraints

- Source only; preserve the dirty working tree and active user profile. No commits, pushing or publishing.
- Saved questions and all answer history belong to the same current SQLite JSON row; clear deletes that row after confirmation and stop verification.
- Increment Workbench protocol. Maintain legacy DTO compatibility and do not invent missing historical question types.
- Existing tokens, Chinese UI copy, English code comments. No external dependency additions; macOS verification only.

## Review Focus

- A semantic question change must not silently reuse a formerly valid answer.
- An active node may save a draft but cannot accept a second execution.
- Failed inference after successful persistence must leave saved answers available after restart.
- Polling or a second tab must never silently replace local unsubmitted corrections.
- Clear and stale run replacement must not resurrect or delete another task's answers.

## Tasks

### Task 1: Model and durable image

Files: shared `valuation-questionnaire.ts`, workflow contracts; Host `workflow/questionnaire.ts`, `persistence.ts`, `views.ts`; new focused model/durable tests.

Interfaces: `ValuationWorkflowQuestionnaire` holds version, questions, per-node drafts, submissions/notes and legacy records. Service calls `admitQuestions`, `saveQuestionDraft`, `submitQuestionAnswers`, `effectiveQuestionAnswers`, `restoreQuestionnaire`. Actions carry node, graph revision, expected questionnaire version and a complete typed answer map.

- [x] Write model and restore tests proving cumulative answers, correction history, unknowns, validation, semantic changes, inapplicability, stale writes and legacy text preservation; observe intended failures.
- [x] Implement the focused pure model and strict DTO validation, serialize and restore with optional legacy state, project node ownership to real graph IDs.
- [x] Run model/durable tests and typecheck for this boundary.

### Task 2: Application service and model execution

Files: `workflow/service.ts`, inference contracts/ports and stage adapter; focused service/inference tests.

- [x] Write failures for two answer rounds, draft during running, model failure after save, required unknown remaining blocked, cumulative supplemental context and no duplicate automatic loops.
- [x] Integrate saved questionnaires into start/restore/snapshot/stage facts. Add service `saveDraft` and `submitQuestions`; save before driving and preserve answers across downstream invalidation.
- [x] Add strict stage questions output and classify real employee blockers separately from system failures. Admit legacy clarification with node ownership.
- [x] Verify service/inference regression suites.

### Task 3: Host transport and Client interaction

Files: workflow runtime/production action parser/host, Client workflow controller, node inspector and a questionnaire form component, focused tests and browser fixture.

- [x] Prove closed action parsing, correct ownership, optimistic conflicts, active draft acceptance and active submit rejection.
- [x] Wire `questions-draft` to a checked direct runtime service method and `questions-submit` to the existing authenticated queue; maintain protocol compatibility guards.
- [x] Prove complete mandatory submit, restored editable answers, debounce autosave and conflict retention, saved-vs-executing status, supplemental note history and collapsed input/output.
- [x] Render typed forms from the stored projection. Flush draft saves before submit; preserve edits on errors/polling and clear only after Host success.

### Task 4: Integration acceptance and delivery

- [x] Run focused tests, TypeScript, `make plugin-check`, build/smoke/package, `make docs-check`, `git diff --check`; report existing template baseline failures separately.
- [x] Run isolated browser checks for typed form, reload, correction and collapsed IO. Do not modify the active DSH profile.
- [x] Perform fresh independent review and fix actionable findings with red/green evidence.
- [x] Update current workflow documentation and changelog; report actual evidence and platform limits.

## Execution record

User approved the complete design and entering implementation in chat. Work in the existing feature checkout because the required workflow implementation is itself uncommitted here; a clean worktree would omit the implementation being extended. Baseline source/tests/docs/install copied to a task-specific OS temporary directory before edits. Five pre-existing `host-workflow-template-requirements` failures are already recorded in this chat; do not remove or weaken them. Proceed continuously within the approved scope.

## Completion record

Historical implementation snapshot, completed 2026-10-20. All planned checks were run; the full plugin gate remains blocked by the five previously recorded template requirements failures, not a fully passing gate. See [acceptance evidence](../reviews/2026-10-20-node-questionnaire-acceptance.md) for exact counts, independent review fixes and platform limits. No commits, publication or active-profile changes.
