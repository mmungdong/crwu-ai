# dsh-crwu-workbench Agent Rules

This directory is a DeepSeek Harness package plugin, not a standalone website. Follow the repository and `plugins/` instructions first; this file adds Workbench-specific constraints.

## Conditional references

Read only the document needed for the branch you are changing:

| Change | Read |
| --- | --- |
| UI, CSS, layout, empty/loading states, or interaction | [`docs/ui-design-guidelines.md`](docs/ui-design-guidelines.md) |
| Loading shape, Cordis lifecycle, Host operations, protocol, sandbox, or local development | [`docs/development-notes.md`](docs/development-notes.md) |
| Sidebar modules or Workbench product behavior | [`docs/PRD-workbench-sidebar-modules.md`](docs/PRD-workbench-sidebar-modules.md) |
| npm versioning, tags, publication, rollback, or receiving-profile checks | [`docs/releasing.md`](docs/releasing.md) |

Dated acceptance, review, handoff, plan, and spec files are historical evidence, not current implementation instructions.

## Source and package shape

- `src/` is the only implementation source. Never edit `lib/`, tarballs, staged binaries, or synchronized `common/skills/` directly.
- Keep `src/index.ts` and `src/client/index.ts` limited to exports and assembly.
- Preserve ESM Host exports `name`, `inject`, `Config`, and `apply`; `apply` receives config as its second positional argument.
- Preserve package exports `.`, `./client`, and `./package.json`, plus the `dsh.client` declaration.
- Host and Client build separately to `lib/index.js` and `lib/client.js`.
- Client output registers through `window.__ModuleLoader__` with the package name as module ID and may require only `react` and `react/jsx-runtime`.
- Resolve packaged paths from the installed package, never from the profile `baseUrl`. Register one Skill root per layer because DSH discovery is not recursive.
- Deployment-variable values belong in `config/crwu-workbench.yml`; package/version/wire constants belong in their focused source modules.

## Host, Client, and lifecycle

- Host owns filesystem, Shell, credentials, H3Yun, DWS, OSS, subagent, and policy-sensitive operations.
- Client owns browser state, rendering, and user interaction. It does not import `node:*`, read local files, or execute commands.
- Host and Client communicate through validated same-origin operations and types in `src/shared/`.
- Manage routes, listeners, timers, styles, locale registrations, and Tool registrations with the appropriate disposable Cordis/DSH lifecycle API.
- Register slots directly inside `ctx.slots.inject(...)`; do not wrap slot injection in `ctx.effect()`.
- Read optional services lazily through `ctx.get(...)`; do not snapshot an unavailable optional service during `apply()`.
- Increment `WORKBENCH_PROTOCOL` whenever a Host/Client field or cross-process behavior changes. A mismatch blocks dispatch and tells the user to restart the profile.

## Security boundaries

- Local-access consent is a persisted capability receipt. Privileged operations remain disabled until that receipt is valid; revoked, outdated, unreadable, or failed persistence states fail closed.
- Shell work goes through the injected DSH Shell service and the registered operation broker. Do not use `node:child_process`, `ctx.subprocess`, or ad-hoc command assembly for business CLIs.
- Only registered CRWU structured Tools are model-visible for repository-owned audit flows. Tool schemas expose business inputs, never commands, binary paths, sandbox controls, infrastructure IDs, credentials, or arbitrary storage destinations.
- Resolve `crwu`, `dws`, and `ossutil` from packaged binaries. A missing packaged binary is a capability gap; never fall back to a same-named command on `PATH`.
- Construct command arguments inside the owning Tool, quote every argument, pass cancellation signals, and return structured failure kinds rather than throwing ordinary command failures.
- Sanitize stdout, stderr, errors, diagnostics, and model-visible results. Credentials, authorization headers, signed URLs, absolute secret paths, and raw commands never leave Host internals.
- Credential reads and writes pass a named broker operation before touching a provider, filesystem, credential store, or network. UI disablement is not an authorization boundary.
- H3Yun, DingTalk, OSS, and iFinD identities always remain employee-scoped. Login uses the local CLI and system browser; the plugin does not collect passwords, browser cookies, QR credentials, or device codes.

## Audit and workspace boundaries

- The user selects an existing workspace root. Do not create or silently replace it. The plugin may create only the Host-derived case directory beneath that workspace.
- Audit root sessions use the selected workspace as cwd and explicit `workspace-write` plus `approval=never`. Do not rely on deployment defaults.
- Every case-local Tool call validates the calling audit/discussion scope and uses the Host-recorded case path. Workspace roots, sibling cases, nested substitute roots, unknown callers, stale records, and mismatched business identifiers fail closed before I/O.
- Create the case record and scope before publishing a child session; roll back incomplete pending state when child creation fails.
- Child Tool visibility is enforced by the DSH Tool filter, not by a prompt or preflight list alone.
- Audit startup verifies environment capability, Tool visibility, input snapshot, selected form, and DSH workspace Python before creating a child.
- The input snapshot is the audit model's record source. Attachments are fetched only by the current remote manifest; failed remote reads never fall back to unverified local copies.
- Stop is a persisted state machine. Do not release occupancy, discard identity, or start a replacement until the child is confirmed quiescent.
- iFinD is an optional external-data capability. Its failure can degrade external verification but must not block the audit core when required setup is healthy.

## UI and product behavior

- Use DSH theme tokens and the established component/style patterns. User-visible copy is Simplified Chinese.
- Keep environment decisions in the shared environment model and navigation store. Client components render those facts; they do not invent parallel readiness or failure classification.
- Environment UI distinguishes employee action, administrator action, and system failure. Do not tell employees to install packaged tools or repair system-owned failures.
- Keep loading, empty, blocked, and stale-Host states observable and accessible. New visible behavior needs a focused unit assertion and, when layout or real browser behavior matters, a browser-check assertion.
- Discussion and analysis sessions receive only the Host-provided case directory and current remote-material scope. Prompts do not search arbitrary local directories or suggest shell discovery.

## Tests and development loop

- Write a failing test before each behavior change and prove the new assertion fails for the intended reason.
- Tests use Node's built-in test runner and existing TS/TSX loaders. Do not add a browser framework or DOM runtime for behavior already covered by current helpers.
- Choose tests by boundary: pure functions, Host operations, Client state/rendering, wire protocol, package shape, or real browser behavior.
- Tests do not access real H3Yun, OSS, credentials, employee files, or production profiles.
- Never use the user's active profile as a destructive test environment. Back up real plugin state before an explicitly requested live test.
- An agent may build and install a linked development package, but the user restarts the active profile and performs the live acceptance step.
- Do not commit until the user has tested and reviewed the change. Do not push, tag, or publish without explicit authorization.

Focused loop:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:built
npm run pack:assert
git diff --check
```

Run `npm run check` for the full package gate. Use `make plugin-check` from the repository root when packaged binaries, Skills, source-repository contracts, or release shape are in scope.

## Versioning and publication

- `package.json` owns the package name; `npm run version:set <version>` synchronizes package metadata, `VERSION`, Host constants, lockfile, and changelog contract.
- Inspect the local version, npm latest version, and suggested next patch with `make plugin-version`.
- Set a version with `make plugin-version-set PLUGIN_RELEASE_VERSION=x.y.z`.
- Use `make plugin-npm-login` and `make plugin-npm-whoami` for the official registry.
- Prefer the `plugin-v*` tag workflow for normal publication and provenance.
- `make plugin-publish-dry-run` performs the guarded local dry run. Emergency manual publication additionally requires `CONFIRM_PUBLISH=<package>@<version>` and is allowed only from a clean worktree with an authenticated npm user and a version newer than npm latest.
- Published versions are immutable. Any code, configuration, Skill, or packaged documentation change requires a new package version and changelog entry.
