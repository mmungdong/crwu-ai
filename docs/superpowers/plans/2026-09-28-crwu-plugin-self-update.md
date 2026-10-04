# CRWU Plugin Self-Update Implementation Plan

> [!NOTE]
> **Status: historical snapshot (2026-09-28).** This plan preserves implementation context from that date;
> it is not current operating guidance. Start from [`README.md`](../../../README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let installed `dsh-crwu-workbench` users discover a newer stable npm release, install the Host-approved exact version through DSH Plugin Manager, and receive a clear prompt to fully quit and reopen DeepSeek Harness.

**Architecture:** CRWU Client only renders a typed update state and sends intent-only RPCs. A new CRWU Host update domain owns registry discovery, cache/backoff, single-flight installation, persisted recovery, and the optional DSH Plugin Manager adapter. Public package discovery prefers npmmirror and validates bounded registry metadata; profile mutation remains entirely inside DSH Plugin Manager. Development installs and enterprise registries are never overwritten. DeepSeek Harness Desktop is not modified and restart remains manual.

**Tech Stack:** TypeScript 6, React 18, Node.js 22/24, `node:test`, `semver`, Cordis, DSH Plugin Manager, npm package registry metadata.

**Authoritative design:** `docs/superpowers/specs/2026-09-28-crwu-plugin-self-update-design.md`

**Hard scope boundary:** Only modify this repository, primarily `plugins/dsh-crwu-workbench`. Do not modify `deepseek-harness`, do not spawn or kill desktop processes, do not shell out to `dsh`, `npm`, or `pnpm` at runtime, and do not publish, tag, or push.

---

## Target file map

```text
plugins/dsh-crwu-workbench/
├── src/
│   ├── shared/update/
│   │   ├── consts.ts              # fixed package name, source IDs, cache/timeout/body limits
│   │   └── types.ts               # closed Host/Client update protocol unions
│   ├── host/update/
│   │   ├── registry.ts            # bounded metadata fetch + strict parsing
│   │   ├── check.ts               # source policy, SemVer merge, cache and backoff
│   │   ├── persist.ts             # pluginUpdate parse/merge-write helpers
│   │   ├── manager.ts             # optional DSH Plugin Manager adapter and error mapping
│   │   ├── service.ts             # update state machine, single flight, recovery, cancellation
│   │   └── types.ts               # Host-only ports and internal state
│   ├── client/features/update/
│   │   ├── api.ts                 # four typed RPC methods, or a focused re-export from the main facade
│   │   ├── update-store.ts        # one shared client store per plugin instance
│   │   ├── view-model.ts          # pure UI decisions/copy keys
│   │   └── UpdateDialog.tsx       # update details, actions, restart instructions
│   ├── host/apply.ts              # updater construction/lifecycle wiring only
│   ├── host/ops/core.ts           # compose updater operations; no registry/install implementation
│   ├── client/apply.ts            # create and pass one update store
│   └── client/features/workbench/ # badge/dialog mounting only
└── tests/unit/
    ├── host-update-registry.test.mjs
    ├── host-update-check.test.mjs
    ├── host-update-service.test.mjs
    ├── host-update-operations.test.mjs
    └── client-update.test.mjs
```

Files may be combined only when they still have one clear responsibility. Do not put network, installation, persistence, and React rendering into one module. Do not hand-edit `lib/`.

---

### Task 1: Shared protocol and bounded registry discovery

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/shared/update/consts.ts`
- Create: `plugins/dsh-crwu-workbench/src/shared/update/types.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/update/registry.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/update/types.ts`
- Create: `plugins/dsh-crwu-workbench/tests/unit/host-update-registry.test.mjs`
- Modify: `plugins/dsh-crwu-workbench/package.json`
- Modify: `plugins/dsh-crwu-workbench/package-lock.json`

- [ ] Read the authoritative design plus all applicable `AGENTS.md` files before editing. Inspect the installed/public DSH Plugin Manager declarations, but do not modify that package or another repository.
- [ ] Add `semver` as a runtime dependency and `@types/semver` as a dev dependency. Add `@deepseek-ai/dsh-plugin-manager` `^0.1.7-rc.2` to both peer and dev dependencies so runtime usage remains a type-only optional service.
- [ ] Define the closed wire types up front. At minimum they must cover:

```ts
export type UpdateSourceKind = 'npmmirror' | 'npm'

export interface UpdateCandidate {
  currentVersion: string
  targetVersion: string
  sourceKind: UpdateSourceKind
  publishedAt?: string
  checkedAt: string
  expiresAt: string
}

export type UpdateUnsupportedReason =
  | 'development-install'
  | 'manager-unavailable'
  | 'enterprise-registry'

export type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking'; cached?: UpdateCandidate }
  | { status: 'up-to-date'; checkedAt: string }
  | { status: 'available'; candidate: UpdateCandidate; checkedAt: string }
  | { status: 'unsupported'; reason: UpdateUnsupportedReason }
  | { status: 'error'; kind: UpdateCheckErrorKind; checkedAt: string }
```

  Also define the install/recovery status needed by later tasks as closed unions. Do not place raw registry metadata, URLs, auth data, package-manager logs, commands, or user-selected versions in the wire contract.
- [ ] Put these fixed constants in `shared/update/consts.ts`: package name `dsh-crwu-workbench`, npmmirror and npm source descriptors, 3 s/5 s request timeouts, 1 MiB maximum response size, 6 h success TTL, and 10 min automatic failure backoff.
- [ ] First write failing tests for a registry parser/fetcher with injected `fetch` and clock. Required cases:
  - valid `dist-tags.latest` and optional `time[version]`;
  - package name mismatch;
  - missing/invalid `latest`;
  - prerelease `latest` rejected;
  - invalid JSON, 404/non-2xx, timeout, and response over 1 MiB;
  - two valid public-source results merge to the higher SemVer, never by string comparison;
  - equal/older versions become no-update, never downgrade;
  - only safe normalized fields survive parsing.
- [ ] Run and record the RED command:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/host-update-registry.test.mjs
```

  The expected failure must be caused by the missing implementation, not a broken test harness.
- [ ] Implement `registry.ts` with dependency injection. It must use `AbortController`, enforce the byte limit while reading the body rather than only trusting `content-length`, validate `name === dsh-crwu-workbench`, accept only a stable valid SemVer from `dist-tags.latest`, and return a small internal result.
- [ ] Keep source fallback/merge deterministic: a source failure does not erase another successful source; if both succeed choose the higher version; if equal prefer npmmirror as the displayed source.
- [ ] Run the focused test, typecheck, and diff check:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/host-update-registry.test.mjs
npm run typecheck
git diff --check
```

- [ ] Commit only this task:

```bash
git add plugins/dsh-crwu-workbench/package.json \
  plugins/dsh-crwu-workbench/package-lock.json \
  plugins/dsh-crwu-workbench/src/shared/update \
  plugins/dsh-crwu-workbench/src/host/update \
  plugins/dsh-crwu-workbench/tests/unit/host-update-registry.test.mjs
git commit -m "feat(plugin): add bounded update discovery"
```

---

### Task 2: Check policy, cache, and automatic backoff

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/update/check.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/update/types.ts`
- Create: `plugins/dsh-crwu-workbench/tests/unit/host-update-check.test.mjs`

- [ ] Write failing tests around an injected clock, registry fetcher, current version/build kind, and registry-profile reader. Required cases:
  - `buildKind=dev` immediately returns `unsupported/development-install` and never fetches;
  - missing Plugin Manager returns `unsupported/manager-unavailable`;
  - explicit enterprise/private registry returns `unsupported/enterprise-registry`, never contacts public sources, and never exposes its URL;
  - public npm/npmmirror profiles permit the two fixed public discovery sources;
  - concurrent checks share one promise;
  - automatic checks reuse a valid 6 h result;
  - manual `force` bypasses success cache and failure backoff;
  - automatic failures back off for 10 min;
  - a failed background refresh retains a prior successful candidate but never refreshes its expiry;
  - no successful check never becomes `up-to-date` after a failure.
- [ ] Run the focused test and verify RED.
- [ ] Implement the checker as instance state created per Host plugin instance. No module-level mutable state and no timer is required: compare injected `now()` at request time.
- [ ] Treat cached candidate expiry as authorization: stale data can be returned only as historical display context and cannot be installed later.
- [ ] Run:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/host-update-registry.test.mjs tests/unit/host-update-check.test.mjs
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add plugins/dsh-crwu-workbench/src/host/update plugins/dsh-crwu-workbench/tests/unit/host-update-check.test.mjs
git commit -m "feat(plugin): add update check policy"
```

---

### Task 3: Persisted install state and Plugin Manager service

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/update/persist.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/update/manager.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/update/service.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/update/types.ts`
- Create: `plugins/dsh-crwu-workbench/tests/unit/host-update-service.test.mjs`
- Modify when needed: `plugins/dsh-crwu-workbench/tests/unit/host-state-workspace.test.mjs`

- [ ] Inspect the exact installed `@deepseek-ai/dsh-plugin-manager` public declarations for `registries`, `listBundles`, `installBundle`, `waitForInstall`, `cancelInstall`, install events, request IDs, result applications, and failure kinds. Code against those declarations; do not copy private implementation or invent a second package manager.
- [ ] Write failing persistence tests proving `pluginUpdate` parsing rejects malformed/stale shapes and merge-writing preserves workspace, trust, audit, and unknown sibling fields in `~/.dsh/crwu-workbench.json`.
- [ ] Write failing service tests for:
  - Host constructs only `dsh-crwu-workbench@<checked target>`; no Client package/version/registry input exists;
  - valid, unexpired, higher candidate required;
  - active/starting CRWU audit rejects installation;
  - one install per Host; repeat click returns the existing task;
  - state is written as `installing` before profile mutation;
  - manager events map only to honest discrete stages (`connecting`, `downloading`, `installing`, `cancelling`), never fake percentages;
  - `restart-required`/successful existing-bundle replacement persists `awaiting-restart`;
  - failure/cancel do not persist `awaiting-restart` and are mapped to the design's stable user error categories;
  - cancellation uses only the active request ID;
  - private URLs, tokens, auth headers, commands, and full pnpm output never reach the public state or persisted JSON;
  - recovery rules for interrupted `installing` and `awaiting-restart`, including current version equal/higher, disk target present, old disk version, and unknown disk state;
  - a completed recovery produces one in-process `updated` notice and clears the disk marker.
- [ ] Run focused tests and verify RED.
- [ ] Implement `persist.ts` on top of the existing `readWorkbenchConfigResult`/`writeWorkbenchConfig` merge-write path. Persist only:

```ts
interface PersistedPluginUpdate {
  phase: 'installing' | 'awaiting-restart'
  fromVersion: string
  targetVersion: string
  startedAt: string
  installedAt?: string
}
```

- [ ] Implement a thin optional Plugin Manager adapter obtained from `ctx.get('pluginManager')`; runtime imports must remain type-only. Let DSH own the desktop profile, bundled pnpm, locking, compatibility validation, registry plan, rollback, and logs.
- [ ] Implement the update service with injected ports and a single internal state transition path. Dispose event listeners through Cordis/adapter lifecycle; never leave module-level listeners or mutable state.
- [ ] Run:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/host-update-service.test.mjs tests/unit/host-state-workspace.test.mjs
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add plugins/dsh-crwu-workbench/src/host/update \
  plugins/dsh-crwu-workbench/tests/unit/host-update-service.test.mjs \
  plugins/dsh-crwu-workbench/tests/unit/host-state-workspace.test.mjs
git commit -m "feat(plugin): install updates through plugin manager"
```

---

### Task 4: Host lifecycle, RPC operations, and protocol 16

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/apply.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/ops/core.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/update/ops.ts`
- Modify: `plugins/dsh-crwu-workbench/src/shared/consts.ts`
- Modify: `plugins/dsh-crwu-workbench/tests/helpers/frozen-inventory.mjs`
- Create: `plugins/dsh-crwu-workbench/tests/unit/host-update-operations.test.mjs`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/host-operations.test.mjs`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/host-package.test.mjs`

- [ ] First write failing Host operation tests for `update-status`, `update-check`, `update-install`, and `update-cancel`. Every operation uses the existing same-origin POST route. `update-install` accepts no package/version/registry/profile fields; unexpected authorization-shaping fields must be ignored or rejected at the Host boundary.
- [ ] Add the four names to the frozen operation inventory. Keep `ping` and `audit-release` as the only intentional Host-only operations after the Client facade lands.
- [ ] Bump `WORKBENCH_PROTOCOL` from 15 to 16 and add a dated changelog comment beside the constant explaining the four operations/update wire contract and the restart mismatch gate.
- [ ] Construct one updater service inside Host `apply()`, pass it into operation composition, and bind event/listener disposal to the plugin lifecycle. Keep `apply.ts` and `ops/core.ts` as wiring/composition only.
- [ ] On activation, recover persisted install state before authorizing a new install, then start a non-blocking automatic check. A registry outage must never prevent Host activation or `boot`.
- [ ] Ensure `update-status` can return the in-process one-time updated notice after restart, while `awaiting-restart` remains dominant until the running Host version changes.
- [ ] Run:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/host-update-operations.test.mjs tests/unit/host-operations.test.mjs tests/unit/host-package.test.mjs
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add plugins/dsh-crwu-workbench/src/host/apply.ts \
  plugins/dsh-crwu-workbench/src/host/ops/core.ts \
  plugins/dsh-crwu-workbench/src/host/update/ops.ts \
  plugins/dsh-crwu-workbench/src/shared/consts.ts \
  plugins/dsh-crwu-workbench/tests/helpers/frozen-inventory.mjs \
  plugins/dsh-crwu-workbench/tests/unit/host-update-operations.test.mjs \
  plugins/dsh-crwu-workbench/tests/unit/host-operations.test.mjs \
  plugins/dsh-crwu-workbench/tests/unit/host-package.test.mjs
git commit -m "feat(plugin): expose self-update operations"
```

---

### Task 5: Typed Client facade, store, and view model

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/client/features/update/api.ts`
- Create: `plugins/dsh-crwu-workbench/src/client/features/update/update-store.ts`
- Create: `plugins/dsh-crwu-workbench/src/client/features/update/view-model.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/features/report-audit/api.ts`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/client-rpc-facade.test.mjs`
- Create: `plugins/dsh-crwu-workbench/tests/unit/client-update.test.mjs`

- [ ] Write failing tests proving the four facade methods emit the exact operation names and never send package name, version, registry, profile, command, or arbitrary install spec.
- [ ] Update `OPERATION_OF` so the bidirectional Host/Client inventory tests remain exact. Prefer a focused update API module but retain one exported operation inventory as the source of truth.
- [ ] Write failing store tests for shared initial load, one automatic status/check path, manual force check, install/cancel concurrency, retained last-known state on transport failure, and no duplicate request caused by two UI consumers.
- [ ] Write failing pure view-model tests for badge text/tone, disabled reasons, background-vs-manual errors, dev/enterprise/manager-unavailable states, active-audit blocking, awaiting-restart priority, and updated success notice.
- [ ] Implement the store per plugin instance, with no module-level singleton and no Node imports. All untrusted Host response fields must be narrowed before entering UI state.
- [ ] Run:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/client-rpc-facade.test.mjs tests/unit/client-update.test.mjs tests/unit/host-operations.test.mjs
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add plugins/dsh-crwu-workbench/src/client/features/update \
  plugins/dsh-crwu-workbench/src/client/features/report-audit/api.ts \
  plugins/dsh-crwu-workbench/tests/unit/client-rpc-facade.test.mjs \
  plugins/dsh-crwu-workbench/tests/unit/client-update.test.mjs
git commit -m "feat(plugin): add update client state"
```

---

### Task 6: Version badge, update dialog, and manual restart UX

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/client/features/update/UpdateDialog.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/client/apply.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/features/workbench/WorkbenchPanel.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/client/features/workbench/WorkbenchSidebarEntry.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/client/features/workbench/consts.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/features/workbench/styles.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/locales/zh-CN.ts`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/client-package.test.mjs`
- Modify: `plugins/dsh-crwu-workbench/tests/unit/client-update.test.mjs`

- [ ] Read `docs/ui-design-guidelines.md` before changing React/CSS.
- [ ] Write failing renderer tests for:
  - silent startup (no unsolicited modal);
  - installed badge changes from `vX` to `vX · 有更新` and opens the dialog;
  - dialog shows current/target versions, optional publish time, public source kind, and honest discrete install stage;
  - development/enterprise/manager-unavailable/candidate-expired/audit-active/install-active disabled states;
  - manual check failures are visible while background failures do not interrupt work;
  - install completion says exactly that CRWU is installed and the user must fully quit/reopen DeepSeek Harness;
  - macOS instruction mentions application Quit/`Command-Q`, not closing the window;
  - no “restart now” action and no claim that CRWU restarted the desktop app;
  - protocol mismatch blocks new audit work and leads with the full quit/reopen instruction;
  - `awaiting-restart` outranks another available update.
- [ ] Create exactly one update store in Client `apply()` and pass it to both sidebar badge and main panel; do not let each component call status/check independently.
- [ ] Put all user-facing Chinese in `zh-CN.ts`. Add class constants before selectors, use only the `crwu-audit-` prefix and existing allowed DSH theme tokens, and keep overlay/scroll geometry within the current panel shell.
- [ ] Add accessible dialog semantics, keyboard close behavior when safe, disabled/button labels, and a non-sensitive diagnostic summary. Do not render registry URLs, auth data, full pnpm logs, or arbitrary Host strings.
- [ ] Run:

```bash
cd plugins/dsh-crwu-workbench
node --test tests/unit/client-update.test.mjs tests/unit/client-package.test.mjs
npm run typecheck
npm run build
npm run smoke:built
git diff --check
```

- [ ] Commit:

```bash
git add plugins/dsh-crwu-workbench/src/client \
  plugins/dsh-crwu-workbench/tests/unit/client-update.test.mjs \
  plugins/dsh-crwu-workbench/tests/unit/client-package.test.mjs
git commit -m "feat(plugin): add self-update interface"
```

---

### Task 7: First-updater release documentation, version 0.0.11, and gates

**Files:**
- Modify: `plugins/dsh-crwu-workbench/README.md`
- Modify: `plugins/dsh-crwu-workbench/README.en.md`
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`
- Modify: `plugins/dsh-crwu-workbench/docs/releasing.md`
- Modify via script: `plugins/dsh-crwu-workbench/package.json`
- Modify via script: `plugins/dsh-crwu-workbench/package-lock.json`
- Modify via script: `plugins/dsh-crwu-workbench/VERSION`
- Modify via script: `plugins/dsh-crwu-workbench/src/host/consts.ts`
- Modify if contract details changed: `docs/superpowers/specs/2026-09-28-crwu-plugin-self-update-design.md`

- [ ] Document the actual behavior and limits: public source preference, Plugin Manager ownership, manual full app restart, dev/enterprise exclusions, failure recovery, and no desktop modification.
- [ ] State the bootstrap fact prominently: `0.0.10` has no updater, so existing `0.0.10` users must manually update once to `0.0.11`; automatic checks start with releases after the updater is installed.
- [ ] Update the release runbook with the operator flow for future versions, including publishing to official npm, verifying npm and npmmirror visibility, waiting for mirror synchronization without overwriting the same version, and never treating a mirror delay as a reason to republish an immutable version.
- [ ] Bump only through the repository script:

```bash
cd plugins/dsh-crwu-workbench
npm run version:set -- 0.0.11
```

- [ ] Add a `## package · 0.0.11 · 2026-09-28` changelog section before running version checks.
- [ ] Run the complete plugin gates:

```bash
cd plugins/dsh-crwu-workbench
npm run check
npm run pack:assert
npm pack --dry-run
git diff --check
git status --short
```

- [ ] Inspect the dry-run file list: required runtime dependencies and built entrypoints are present; `src/`, tests, credentials, local state, caches, and generated `.tgz` files are absent.
- [ ] Do not run `npm publish`, create a tag, push, or modify DeepSeek Harness Desktop.
- [ ] Commit:

```bash
git add docs/superpowers/specs/2026-09-28-crwu-plugin-self-update-design.md \
  plugins/dsh-crwu-workbench/README.md \
  plugins/dsh-crwu-workbench/README.en.md \
  plugins/dsh-crwu-workbench/CHANGELOG.md \
  plugins/dsh-crwu-workbench/docs/releasing.md \
  plugins/dsh-crwu-workbench/package.json \
  plugins/dsh-crwu-workbench/package-lock.json \
  plugins/dsh-crwu-workbench/VERSION \
  plugins/dsh-crwu-workbench/src/host/consts.ts
git commit -m "docs(plugin): prepare 0.0.11 updater release"
```

---

## Final independent acceptance (performed by the coordinating reviewer)

After all delegated tasks are complete, the coordinating reviewer must not rely only on worker summaries. Review every commit and run an independent acceptance pass:

- inspect `git diff 032fb68..HEAD` and every task commit for scope, architecture, and unrelated changes;
- prove Client has no `node:*`, shell, package-manager, registry, filesystem, or secret access;
- prove runtime code never uses `child_process`, `ctx.shell`, global `npm`/`pnpm`, arbitrary package/version/registry, or desktop restart APIs;
- prove the optional manager cannot block plugin activation;
- prove registry bodies are bounded and SemVer/stable-only rules hold;
- prove enterprise/private registry policy cannot leak or bypass its URL;
- prove candidate expiry, audit-active lock, single-flight, rollback result mapping, cancellation, persistence merge safety, and restart recovery;
- prove protocol 16, four operation names, facade coverage, localized strings, class/style inventories, and full-restart copy;
- run `npm run check`, `npm run pack:assert`, `npm pack --dry-run`, and `git diff --check` independently;
- inspect the actual packed tarball/file list and ensure no publish/tag/push occurred.

Any failed proof returns to the responsible task as a narrowly scoped correction prompt. Only after all checks pass is the implementation accepted as ready for the user's separate release decision.
