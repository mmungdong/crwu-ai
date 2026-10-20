# Workflow workspace implementation plan

> Execution record for the five-part design approved in chat on 2026-10-19. Use superpowers:executing-plans inline. This dated plan is a historical snapshot, not an operating instruction.

**Goal:** Make valuation workflows restartable and reusable, with visible execution feedback, focused node drawers, structured decisions and editable global inputs.

**Architecture:** Host remains authoritative for graphs, allowed edits, revisions and execution. A business-neutral Client workspace renders registered graph descriptors and drawer content; the valuation adapter supplies its business panels and commands. Preserve the existing asset graph registry.

**Constraints:** Simplified Chinese UI; existing DSH theme tokens and SideDrawer; no new dependencies; no commits or runtime-profile changes; preserve pre-existing uncommitted work. Never clear an occupied task before confirmed quiescence. New wire fields require a protocol increment.

## Review focus

- Clear failures retain the current identity and draft; late responses cannot resurrect a cleared run.
- Missing node receipts show loading without claiming fabricated execution progress.
- Selection changes cannot display or submit another node's stale details.
- Question options and complete required answers are checked by Host as well as Client.
- Global changes retain provenance, invalidate downstream results and survive durable restore.

## Task 1: Clear and fresh entry

Files: workflow-controller.ts, AssetAssessmentWorkflow.tsx, workflow Host lifecycle and focused Client/Host tests.

- [ ] Write and run failing tests for clear visibility, successful navigation/reset and failed clear preservation.
- [ ] Implement explicit clear lifecycle, stop-before-clear, and fresh intake after return to overview.
- [ ] Run focused controller/entry and Host lifecycle tests.

## Task 2: Shared workspace and node drawer

Files: new Client ui/workflow workspace and structured-value components; valuation adapter, WorkflowGraph.tsx, NodeInspector.tsx, workflow styles and focused rendering tests.

- [ ] Write and run failing tests for a custom asset graph, immediate detail loading, drawer content order and structured multiline values.
- [ ] Extract business-neutral workspace; reuse SideDrawer with glass backdrop, keyboard/focus behavior and exit animation.
- [ ] Render distinct node states, connectors, loading and reduced-motion behavior.
- [ ] Run focused Client tests and typecheck.

## Task 3: Decisions and global edits

Files: shared valuation-workflow contract, Host views/service/persistence, ClarificationPanel.tsx, new global-input panel and focused Host/Client tests.

- [ ] Write and run failing tests for typed questions, required answers and global edits with stale/invalid rejection.
- [ ] Add structured choices, global input projection and validated revision-based reruns; keep audit provenance internally.
- [ ] Increment wire protocol and verify durable restore plus affected-node invalidation.

## Task 4: Acceptance and delivery

Files: browser fixture/check, workflow documentation and changelog.

- [ ] Verify actual browser layout, node drawer open/close, focus, glass, running animation, decisions and clear/new-intake flow.
- [ ] Run typecheck, full tests, build/smoke and repository documentation/plugin gates.
- [ ] Inspect final diff and disclose baseline failures and platform verification limits.
