# Report List and Paginated OSS Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.
> Design snapshot dated 2026-10-09; implementation progress is recorded below, not a current operating guide.

**Goal:** Replace the two audit views with one report list that batches only the current page's serial numbers through Host.

**Architecture:** Keep H3Yun pagination authoritative. Extend `oss-index` with a validated batch mode and an instance-wide queue of three directory reads. Client owns request generations and cancellation; Host owns credentials, filesystem, Shell and OSS.

**Tech Stack:** TypeScript, React, Cordis/DSH, Node built-in tests and existing TSX loader, bundled ossutil 1.7.19.

**Spec:** [Approved design](../specs/2026-10-09-workbench-report-list-oss-design.md).

## Global Constraints

- Current-page serial numbers only; maximum batch input 100; shared `isSafeSeqNo`; empty batch performs zero I/O.
- Instance-wide concurrency 3 and batch deadline 90 seconds including queued time.
- Preserve metadata and exact serial-directory isolation; errors and truncation never mean absent results.
- Reuse named access Broker operations and packaged binaries; no new dependencies or model-visible Tools.
- Simplified Chinese UI, English concise code comments, existing theme tokens.
- Do not modify unrelated existing changes, commit, push, install a live profile or publish.
- User requested implementation in this chat; execute here on the existing feature branch. Plan review is covered by the approved spec and explicit instruction to start implementation.

## Review Focus

- A JSON-only result is audit history and requires confirmation before replacement.
- A late page or row response must never overwrite a newer page or upload result.
- Multiple simultaneous batches must share the concurrency ceiling.
- Response disconnect must cancel work, while normal request completion must not.
- A truncated/unparseable list must never enable a first-audit action.

### Task 1: OSS batch execution

**Files:** `src/shared/types.ts`, `src/shared/wire-contract.ts`, `src/host/oss/batch.ts`, `src/host/oss/ops.ts`, `tests/unit/host-oss-batch.test.mjs` under the plugin.

**Interfaces:** Produce `OssBatchIndexResult` / `OssBatchItemResult`, `createOssBatchQueue()` and a batch query accepting `{ seqNos }` plus optional `AbortSignal`. Reuse a single-directory read from OSS operations.

- [x] Add assertions for illegal input zero I/O, empty/duplicate input, exact keys, metadata, partial failure, truncated/invalid output and wrong serial keys.
- [x] Run `node --test tests/unit/host-oss-batch.test.mjs`; verify the new feature fails before implementation.
- [x] Implement shared types, focused queue and single-directory executor, with concurrency 3, deadline 90 seconds and disposal/cancellation.
- [x] Add concurrent-batch and deadline/cancellation assertions, run batch and existing OSS operation tests until passing.

### Task 2: RPC lifecycle and integration

**Files:** `src/host/ops/types.ts`, `src/host/ops/core.ts`, `src/host/http/route.ts`, `src/client/api/client.ts`, `src/client/features/report-audit/api.ts`, `src/shared/consts.ts`; Host HTTP and Client facade tests.

**Interfaces:** Consume Task 1 batch types. Produce `ossBatchIndex({ seqNos }, { signal? })`; add optional `OperationContext.signal` and Client RPC signal options, preserving existing operation names.

- [x] Add failing tests for signal forwarding, batch dispatch before dependency resolution, normal route completion versus disconnect, and facade mapping.
- [x] Run the narrow tests and confirm expected failures.
- [x] Wire batch mode through the existing operation, attach queue cleanup to Host lifecycle and propagate request cancellation.
- [x] Increment protocol and verify facade, operation inventory and HTTP lifecycle tests.

### Task 3: Paginated Client orchestration

**Files:** focused `src/client/features/report-audit/page-loader.ts`, `WorkbenchPanel.tsx`, shared Client state definitions; `tests/unit/client-report-page.test.mjs` and panel tests.

**Interfaces:** Consume `pending` and `ossBatchIndex`. Produce current-page state and per-serial `loading | ready | failed | invalid` results, request generations, targeted refresh and cancellation.

- [x] Add failing tests for pending-before-batch, only page serials, empty/failed page zero OSS, stale response rejection, same-page refresh, row retries and upload-result races.
- [x] Run tests and confirm the intended failures.
- [x] Implement a focused page loader, replace full-cloud/search state with page-scoped state, preserve submitted query/page/size and independently poll audit status.
- [x] Refresh only current-page uploaded records once per upload fact change; verify page and panel tests.

### Task 4: Single-list UI and audit actions

**Files:** `ReportPane.tsx`, `row.ts`, `types.ts`, `zh-CN.ts`, workbench styles, Client render/rule tests and `install/browser-check.mjs`.

**Interfaces:** Consume Task 3 row query states and existing discussion/analysis handlers. Produce one seven-column report list with merged menus and observable remote failures.

- [x] Add failing assertions for no tabs, AI column states, JSON-only history and confirmation, unknown-result gate, result analysis routing and preserved discussion access.
- [x] Run rules and render tests to confirm failure.
- [x] Remove results view and cloud search, merge result actions into report rows, keep analysis preflight and add targeted retry and accessible status copy.
- [x] Update outdated dual-view tests while retaining meaningful discussion, analysis, stop and artifact regression assertions; update browser-check selectors and assertions.
- [x] Verify Client render, rules, page, API and style tests.

### Task 5: Documentation and final gates

**Files:** plugin `README.md`, `README.en.md`, `CHANGELOG.md`, `docs/ui-design-guidelines.md`, protocol documentation, this plan.

- [x] Update current operating descriptions for one list, page-scoped OSS reads and partial failure.
- [x] Preserve the working tree's existing package version changes; append this behavior change to its current unreleased entry.
- [x] Run `make plugin-check`, `make docs-check`, `git diff --check`; investigate failures by boundary.
- [x] Review the final diff against the approved spec, including an independent final reviewer as required by executing-plans.
- [x] Report verified results and the user-owned live profile restart/acceptance step; leave work uncommitted.

## Execution Ledger

- Baseline: existing branch `feat/v0.0.41`; unrelated version/Skill/document changes retained.
- Ruling: work in the user-provided feature checkout without creating a worktree or re-requesting implementation approval; the user explicitly requested execution here. No Git history mutation is authorized.
- Pre-flight: Tasks 1–3 share batch response and signal types; Task 4 consumes Task 3's row state. Shared declarations are defined once and checked by typecheck.
- Implementation: Tasks 1–4 are implemented in the listed boundaries. The Host batch requires an OSS object count and exact prefix/serial validation; the Client loader keeps page generations, row generations, cancellation, and upload refresh coalescing.
- Validation: `npm run typecheck`, focused Host/Client tests, `make plugin-check`, `make docs-check`, and `git diff --check` passed. The plugin gate produced only its existing common-skill subset warning (`warn=1`, `error=0`) and no test/build/pack failure.
- Independent review: `/root/final_review` completed read-only review after the final count-validation patch; no Critical, Important, or Minor findings remain. Real OSS/browser/production-profile acceptance was intentionally not run.
- Delivery boundary: no commit, push, install, profile restart, or publish was performed. The user must restart the active profile and perform live acceptance after reviewing the uncommitted diff.

### Continuation 2026-10-10 (latest UI steering)

- Ruling: the top "报告列表" title/Tab is removed for good, so `zhCN.tabPending` is no longer a page proxy. `tests/unit/client-package.test.mjs` now asserts the report page structurally (`onReportPage` → `.crwu-audit-page-head`) and the delivery details through the floating tooltip; no title or Tab was restored. Cost if wrong: a future intentional re-introduction of a list title must update that helper.
- Ruling: the dead in-cell CSS tooltip (`.crwu-audit-result-tooltip`) and its class key were deleted, because the shipped overlay is the global `.crwu-audit-float-tip`; keeping two mechanisms invites drift. `git diff` shows no other reference. Cost if wrong: one re-add if the in-cell variant is ever wanted.
- Ruling: `install/browser-check.mjs` filtered result rows by the deleted dual-view copy (`审核报告与数据齐全`), so two phases silently skipped once the AI list was removed. The filters now use the shipped `/个交付件/` marker, the drawer phase walks rows until it finds the JSON-summary menu item, and the AI column/hover assertions were added. Not executed live here.
- Coverage: added hover/focus/click plus `aria-describedby` assertions for the delivery bubble, and falsified them by removing `onFocus` and then `aria-describedby` (each run went red) before restoring the source.
- Independent review (2026-10-10, read-only, fresh context): no Critical. Three Important findings, all fixed with RED→GREEN tests: (a) `view.badges` / `view.notes` had lost their only render site, so an auto-upload failure (`host/oss/auto.ts` writes `uploadError`) and every disabled-action reason were invisible — restored in the 人工复核 cell; (b) the whale passed `task.seqNo` where the row key is required, so a record with an empty SeqNo and a serial-shaped Name looped in a 「远端资料一项都取不到」 dialog — now `rowKeyOf(task)` end-to-end (`factsOf` resolves by row key too); (c) `install/browser-check.mjs` still read the deleted `.crwu-audit-seq` cell, so 「批量流水号与当前页业务行一致」 would false-red and detect nothing — now `td:nth-child(2) .crwu-audit-mono` (not run live here). Restoring the notes also surfaced a wrong gate note for unqueryable serials, now dispatched by state (loading / failed / invalid) and falsified by reverting it.
- Validation after this continuation: `npm test` (plugin) 1422 pass / 0 fail / 1 skipped (`pwsh` absent), `npm run typecheck`, `make docs-check` (35 entry points), `git diff --check`; `make plugin-check` re-run on the final tree (see the session report).
- Deferred minors (not fixed, per the review gate): the transport-exception path in `page-loader.ts` leaves `ossError` empty so each row repeats the same failure sub-line instead of one public error; an auxiliary-only directory is labelled 「N 个交付件」 while the tooltip says 「N 个辅助文件」; `resultItems` / `remoteQueryText`'s ready branches are now unused by production code.
- Delivery boundary unchanged: still uncommitted, not installed, not published; live profile restart and browser acceptance remain the user's step.
