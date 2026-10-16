# Unified Workbench UI Implementation Plan

> 历史执行快照：本计划已于 2026-10-16 完成源码实现与隔离验收。下方保留原始计划；当前组件 API 见 [共享 UI 组件](../../../plugins/dsh-crwu-workbench/docs/shared-ui-components.md)，当前规则见 [UI 设计规范](../../../plugins/dsh-crwu-workbench/docs/ui-design-guidelines.md)。

> **For agentic workers:** DSH implements through the explicitly requested `dsh-orchestrator` workflow; the supervisor runs all checks and records acceptance. This execution method takes precedence over the generic implementation choices below.

**Goal:** Deliver shared buttons, form fields, input, select, date picker and popover components with neutral light/dark surfaces and consistent blue actions, then migrate the Workbench pages.

**Architecture:** Keep the component library inside the existing Client package. Reuse the current Select geometry, keyboard handling and lifecycle, remove its valuation coupling, and share the resulting popover mechanism with DatePicker. Business state and Host contracts remain unchanged.

**Tech Stack:** Existing React 18, TypeScript, scoped CSS strings, Node test helpers, tsdown and existing browser tooling. No production dependencies are added.

**Spec:** [Approved UI requirements](../../handoffs/2026-10-15-unified-ui-components-dsh-prompt.md) and the `crwu-unified-controls` design preview reviewed in this conversation.

## Global Constraints

- Preserve the current uncommitted working tree; privately snapshot the starting state and compare changes against that snapshot.
- No commit, push, publication, user-profile restart, credential access or real business execution.
- DSH writes implementation and tests; the supervisor runs red/green checks, build, gates and browser acceptance.
- Client requires only `react` and `react/jsx-runtime`; shared UI contains no business rules or Host imports.
- Tokens remain in `src/client/styles/tokens.ts`, theme follows `body[data-ds-dark-theme]`, and styles retain the existing installer and scope.
- Asset and method remain explicitly required, all four methods remain available, auxiliary login remains optional, and handoff/digest/idempotency behavior is preserved.

## Review Focus

- Two same-named controls in separate mounts need unique IDs and correct label/focus associations.
- Invalid dates, leap days, month ends and timezone changes must not alter a pure date or silently normalize it.
- Nested/near-edge popovers must respect clipping, keyboard focus, drawer ownership and cleanup.
- Existing button consumers must retain disabled/loading actions and descriptions while adopting blue variants.
- Theme changes must reach overlays and menus without leaking CSS into DSH or reducing text/boundary contrast.

## Task 1: Test contracts before implementation

**Files:** New `tests/unit/client/client-shared-controls.test.mjs`, `client-date-value.test.mjs`, `client-shared-date-picker.test.mjs`, `client-ui-theme.test.mjs`; existing helpers only if needed to exercise real component behavior.

**Interfaces:** Public entry `src/client/ui/components/index.ts`; controlled values; pure-date helpers in `date-value.ts`.

- [ ] DSH adds tests for loading/disabled buttons, clear/readonly input, linked field errors, unique Select IDs, keyboard selection and date behavior.
- [ ] DSH adds tests for strict `YYYY-MM-DD`, leap years, month-end clamping and timezone-independent results.
- [ ] Supervisor inspects the tests and runs them against the current source; record intended feature failures.

## Task 2: Shared primitives and neutral/blue theme

**Files:** `src/client/ui/components/`, `ui/styles/`, `ui/primitives.tsx`, `styles/tokens.ts`, `styles/bundle.ts`.

**Interfaces:** `Button` variants primary/secondary/soft/text/danger; `IconButton`; `FormField`; controlled `TextInput` and `TextArea`. Existing primitive Button remains compatible through one implementation.

- [ ] DSH implements the public components and light/dark token pairs from the spec.
- [ ] DSH consolidates old button selectors and preserves current consumers.
- [ ] Supervisor runs the focused component tests and typecheck; request precise corrections if needed.

## Task 3: Shared Select/Popover and DatePicker

**Files:** `ui/components/Select.tsx`, `Popover.tsx`, `DatePicker.tsx`, `date-value.ts`, corresponding shared styles, and the current valuation `SingleSelect.tsx` compatibility entry.

**Interfaces:** `Select` retains the current value/options/change semantics without valuation-specific IDs/styles. DatePicker emits `YYYY-MM-DD` or empty string, supports manual input, calendar selection, month/year navigation, clear and explicit today.

- [ ] DSH extracts and reuses existing popup behavior, adds instance-safe IDs and correct cleanup.
- [ ] DSH implements strict date parsing, valid date navigation, accessible date grid and focus handling.
- [ ] Supervisor runs pure-date and component tests, plus existing Select regressions.

## Task 4: Adopt the library across Workbench

**Files:** Valuation UI/styles, audit UI/styles, environment UI/styles, shell styles, locales and shared drawer as needed. Host and shared wire contracts are outside this UI task.

- [ ] DSH replaces private input/date/select/button implementations and styles with public components.
- [ ] DSH preserves current material operations, confirmation lifecycle, optional capabilities and handoff recovery.
- [ ] DSH migrates relevant audit/environment actions and inputs; narrows compatibility shims to existing callers.
- [ ] Supervisor runs all package tests and inspects the incremental diff for scope drift and duplicated implementations.

## Task 5: Browser fixture, documentation and final acceptance

**Files:** Isolated browser fixture/check under `tests/` or `install/`; current UI design guidelines and development notes, changelog if appropriate.

- [ ] DSH supplies a browser fixture that renders real source components and representative pages without a user profile or provider calls.
- [ ] Supervisor verifies both themes, 375/500/768/1024/1440 available widths, short height, real select/date popups, focus and reduced motion.
- [ ] Supervisor captures screenshots and checks actual computed styles and geometry.
- [ ] Supervisor runs `make plugin-check`, `make docs-check`, `git diff --check`, and records acceptance evidence.

The initial test-only assignment and later implementation assignments are separate DSH turns. Any review correction includes the supervisor's observed failure and expected behavior; worker completion alone does not count as acceptance.
