# dsh-crwu-workbench

[![ci](https://github.com/mmungdong/crwu-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mmungdong/crwu-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-internal-lightgrey.svg)](LICENSE)

English | [中文](README.md)

The **audit workbench** for DeepSeek Harness (DSH): self-check the environment → pull pending
"报告审核" tasks from H3Yun → dispatch exactly one AI audit subagent → watch it, stop it, restart it →
auto-upload deliverables to Aliyun OSS → open the cloud-hosted audit opinion.

The audit process itself is **not** in this repository; the `crwu-audit` skill family runs it.
This repository only *dispatches, watches, and ships back*.

One form only: `src/` is the single source, bundled by tsdown into `lib/index.js` (Host) and
`lib/client.js` (Client), distributed as a DSH **package** plugin (npm / tarball / git).
Migration history: [`PORTING.md`](PORTING.md).

> A dynamic Cordis form (evaluated in a sandbox from two self-contained source strings) used to live in
> `legacy/` and was **removed** in the 2026-09-20 cutover. The built `lib/` artifacts cannot replace it:
> they are an ESM module and a `window.__ModuleLoader__` factory, not sandbox function bodies, and the
> two forms differ in RPC registration, client transport and React provisioning. That trade-off is
> deliberate — one form, not two.

Conventions: [`AGENTS.md`](AGENTS.md). Complete release runbook:
[`docs/releasing.md`](https://github.com/mmungdong/crwu-ai/blob/main/plugins/dsh-crwu-workbench/docs/releasing.md).
Security model: [`SECURITY.md`](SECURITY.md).
Licensed for internal use only: [`LICENSE`](LICENSE) — do not redistribute.

## Install

```bash
# recipients — prebuilt, no build authorization needed
dsh plugin --profile web add dsh-crwu-workbench

# or from a tarball / from git (these fetch sources and build via prepare; pnpm >= 10 needs allowBuilds)
dsh plugin --profile web add ./dsh-crwu-workbench-<version>.tgz
dsh plugin --profile web add github:<owner>/<repo>

# local development
npm ci && dsh plugin --profile web add .
```

Building the tarball yourself (from the `crwu-ai` repository): `make plugin-pack` →
`dist/dsh-crwu-workbench-<version>.tgz`; releasing goes through the tag-driven npm flow
(`git tag plugin-v<version>`). The plugin is **installed from npm** —
`dsh plugin add dsh-crwu-workbench@<version>` — not from OSS, because that address was replaceable by anyone.

**Restart that profile afterwards** — plugins load with the profile. Then:

1. Click the persistent **中瑞世联工作台** entry at the **bottom of the left sidebar** (above Settings).
   It is one grouped card: the header carries the brand mark plus a small tag saying whether this is `dev`
   (a source checkout) or the installed version (`v0.0.4`), and the body holds three sub-items —
   Report Evaluation (marked "in development"), Report Audit, and Environment. Clicking a sub-item
   switches the panel to that module and opens it; the panel itself no longer has a module bar.
2. If the panel opens on the Environment module, configure it there. The page is a **compact status
   summary plus a guided configuration workspace** with four steps on the left — **Accounts** (one-time
   credential consent, H3Yun sign-in, DingTalk sign-in), **Aliyun OSS** (enter the AccessKey your
   administrator gave you), **iFinD** (paste your own API-Key) and **Workspace** — and the selected
   step on the right. It picks the first unfinished step for you and never moves you off a step you
   chose yourself.
   Secrets are typed only on that page: never paste them into a chat and never let an agent fill them
   in for you. **Both credentials are verified with a real external request** — the OSS AccessKey by a
   read-only `ossutil ls` against the configured delivery prefix, the iFinD API-Key by a real
   `tools/call` data pull. A missing or unverified iFinD API-Key is a **blocking** item (it is a
   required check since 2026-09-26): protected pages are held back until a real data pull succeeds,
   and the notice names the iFinD API-Key explicitly. The environment page itself is always reachable,
   and it no longer carries an "Enter report audit" button — use the left sidebar once the summary says
   the environment is ready.
   `crwu` / `dws` / `ossutil` **ship with the plugin** — there is nothing to install, and section
   **② Bundled components** only ever reports "package incomplete / platform unsupported" if one is missing.
   Section **③ DSH script runtime** reports the **DSH-bundled** Python (with its `openpyxl` and other
   package versions); the system `python3` is not a dependency and is never used as a fallback.
3. To dispatch an audit, register the parent from a **top-level** session header first. Audits may only
   be parented by a top-level session; nesting them is what used to make status tracking lose track of
   a running child.

> **The Skills ship with the package, organized in layers**: the tarball carries `skills/crwu/`
> (27 in-repo Skills), `skills/dws/` (14 vendored `dingtalk-workspace-cli` Skills) and `common/skills/`
> (shared Skills `crwu-dws` / `crwu-h3yun-*`). The `crwu-workbench-skills` row in `cordis.patch.yml`
> registers **each layer as its own skill root** (DSH scans exactly one level per root), so installing
> the plugin is all it takes. Do **not** copy Skills into `~/.dsh/skills/` any more; the package root
> outranks the user root, so a stale copy only creates drift (`make skills-install AGENT_DIR=…` is for
> non-DSH hosts). See [`skills/README.md`](skills/README.md) for the layer contract and how the `dws`
> layer is upgraded.

> **Permissions**: no startup parameters are needed (`DSH_PERMISSION_MODE` stays untouched), but the
> **first run requires one authorization** — the "trust this plugin to read local credentials" switch in
> the login layer. It is written to the workbench state file (`trustCredentials`), so it survives
> restarts. Without it the plugin cannot read the H3Yun session or the DingTalk login state and the
> self-check blocks the gate — and it never reports a false "not logged in". Once authorized, only the
> commands that genuinely read local credentials ask for unconfined execution; everything else stays in
> the profile's default sandbox.

### Updating CRWU (self-update, from 0.0.12)

**Where to look:** the version badge in the sidebar card header and in the panel header (`dev` / `v0.0.12`)
is the update entry point. The plugin runs one **silent** background check after it loads; when a newer
stable version exists the badge becomes `v0.0.12 · 有更新`. Click the badge to open the update panel and use
「检查更新」 to force another check that bypasses the cache.

**How to install:** click 「安装更新」 in the panel. Installation is performed by the DSH Plugin Manager —
this plugin never downloads packages or overwrites its own directory. During installation the panel shows
**honest discrete stages** (connecting / downloading / writing the plugin directory / cancelling) and
**no percentage**; you can cancel at any time. Installation is **disabled while an audit is starting or
running** (it must not touch the profile), but **checking is still allowed**.

**You must restart manually:** when the install finishes the panel says

> CRWU v0.0.12 已安装。请完全退出并重新打开 DeepSeek Harness，使新版生效。

**macOS:** closing the window does **not** quit the app — choose Quit from the application menu or press
**Command-Q**. Reloading the page is not a restart either. This plugin never modifies or restarts the
DeepSeek Harness desktop app (no "restart now" button, no silent updates).

**Users on 0.0.10 / 0.0.11:** those releases do **not** contain the updater, so they cannot discover
0.0.12 by themselves. Install 0.0.12 once by hand, then later stable versions can be checked and installed
from the UI:

```bash
# replace <profile> with the DeepSeek Harness profile you actually use
dsh plugin --profile <profile> add dsh-crwu-workbench@0.0.12
```

Then **fully quit and reopen** DeepSeek Harness.

**Mainland-China network policy:** the check queries **both** the official npm registry and npmmirror and
picks the valid higher stable version; when both report the same version npmmirror is preferred
(it is more likely to be reachable). Installation prefers `https://registry.npmmirror.com/`;
**failures and fallbacks are the Plugin Manager's responsibility**. Mirror sync can lag behind the official
registry — that is not "no new version", just re-check later; once the official registry has a higher
version it will be found even if the mirror lags. Enterprise/private registry policies still apply and are
never bypassed.

### Updating and removing

```bash
dsh plugin --profile web add dsh-crwu-workbench@<version>   # then restart the profile
dsh plugin --profile web remove dsh-crwu-workbench
```

> **A version is published once.** Distribution is npm, whose published versions are immutable, so any
> change means bumping the version first — otherwise employees who installed early and those who
> reinstall end up on different code under one version.

## One YAML configuration

[`config/crwu-workbench.yml`](config/crwu-workbench.yml) is the single configuration source for source
development, packaging, and the installed employee tarball. `oss.protected` names the private
audit-deliverable bucket; credentials stay on the employee machine and object links use signed URLs by
default.

> **There is no `oss.readonly`.** Since 2026-09-25 that anonymously readable distribution bucket is gone.
> Binaries ship inside the package under `bin/<platform>/`, the environment manifest is built in, and the
> plugin is installed from npm — one less remote data source means one less channel through which someone
> else can rewrite the meaning of what runs on an employee machine.
>
> The built-in manifest is **partitioned** (`crwu.env-manifest.v3`): `packaged[]` (crwu / dws / ossutil —
> name, label, note, expected version only; no `command`, no version probing) and `runtime.python`
> (the DSH-bundled interpreter, its version constraint and required packages). There is **no `binaries[]`**
> and no bare `python3` check: the self-check only stats files inside `bin/<platform>/` and compares their
> byte sizes against the packaged `bin/manifest.json` (sha256 is read from that manifest, never recomputed
> during a self-check — 100+ MB is a release-gate concern, not a page-load concern).

The Host reads this YAML directly in source development. Set `CRWU_CONFIG_FILE=/absolute/path/config.yml`
before starting the DSH profile to test another file. `npm pack` validates and embeds the package-local YAML,
and the installed Host automatically reads that packaged copy. Distribution needs no bucket constants at all.

## Releasing

**Current workflow (still used for 0.0.12):** `.github/workflows/release.yml` uses the GitHub secret
`NPM_TOKEN` (as `NODE_AUTH_TOKEN`) and runs `npm publish --provenance` on the `plugin-v<version>` tag —
provenance comes from GitHub Actions OIDC in CI, not from a local publish. **Trusted Publishing is not
enabled today**; it is only a *future migration option* documented in `docs/releasing.md` §3.3.

The complete operator procedure, including authentication setup, failure recovery, and rollback, is in
[`docs/releasing.md`](https://github.com/mmungdong/crwu-ai/blob/main/plugins/dsh-crwu-workbench/docs/releasing.md).
Never run a real `npm publish` by hand. The release path is tag-driven and gated:

```bash
npm run version:set 0.1.3          # package.json + lockfile + VERSION + Host version constant
# add a `## package · 0.1.3 · <date>` section to CHANGELOG.md
cd ../..
make plugin-pack
# review and commit only the release's files, then push the release commit to main
git tag plugin-v0.1.3 && git push origin plugin-v0.1.3
```

A `plugin-v*` tag triggers the repository-root [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
(`v*` is reserved for the Go CLI in the same repository, keeping the two release lines apart); it asserts the
tag matches `package.json` / `VERSION`, builds and stages both platforms' binaries in a separate job,
recomputes every staged hash against `bin/manifest.json`, runs the full gate and the **strict** packed-artifact
check, then publishes on GitHub Actions. The **current** workflow uses `NPM_TOKEN` for registry authentication and
`id-token: write` plus `--provenance` for the build attestation. It is not yet tokenless npm Trusted Publishing;
the runbook documents both the current setup and the recommended OIDC migration. `workflow_dispatch` runs the
same pipeline as a dry run. `prepublishOnly` re-runs the artifact check and the gate.

### One trap worth knowing: npm runs `prepare` on install too

Installing the **published tarball** also runs `prepare`, but the tarball only contains `lib/`, the package
configuration, the patch, Skills and docs — no `src/`, `tsconfig.json`, or `tsdown.config.ts`. So `prepare` cannot be `tsdown`, and it cannot
point at a script that is not shipped. The build entry is `scripts/prepare.mjs`, which **is** in `files`:
it builds when the sources are present and skips with an explanation when they are not. The release path is
`prepack` → `build:lib --force`, which fails rather than shipping a package without `lib/`.

`tests/unit/host-package.test.mjs` pins this with a real `npm pack` + `npm install` + import regression —
both failure modes were invisible to local gates and only surfaced for the person installing the package.

`peerDependencies` cover **two DSH lines**: `@deepseek-ai/dsh-*@^0.1.7-rc.2 || ^0.2.0-rc.1` (cordis `^4.0.4`).
One `^` range per line, joined with `||`, rather than a single `>=… <…` — the latter would also admit the
unverified 0.3 line. The DSH plugin API is a developer preview: **before adding a line**, diff the
`@deepseek-ai/dsh-*` packages of both lines file by file, re-run the gate, and record the supported DSH
version in `CHANGELOG.md`.

> **Since 0.1.7 this is a hard gate.** DSH compares the runtime version against every `@deepseek-ai/dsh*` peer
> range and **skips the whole bundle** on any mismatch (recorded in `skippedBundles`) — the symptom is "the plugin
> is installed but nothing appears", with a clean startup log; the plugin manager also marks the row
> "incompatible with DSH \<version\>" and disables it. The check reads `peerDependencies`, not `engines.dsh`.
> Note that `^0.1.7-rc.2` means `>=0.1.7-rc.2 <0.2.0-0` and therefore **excludes** `0.2.0-rc.1`.

## Development

| Command | Purpose |
|---|---|
| `npm test` | All tests under `tests/unit/`: config, routing, operation table, package manifest, and both Host and **Client** halves |
| `npm run config:check` | Validate the single YAML configuration and its public/private OSS boundary |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run build` | tsdown dual build → `lib/index.js` + `lib/client.js` (`prepare` runs this too) |
| `npm run smoke:built` | Loads the **real** `lib/index.js` through its same-origin route and the real `lib/client.js` through `__ModuleLoader__` |
| `npm run check` | `version:check` → `typecheck` → `test` → `build` → `smoke:built` — run this before delivering or opening a PR |
| `npm run version:set 0.1.3` | Bump the version in `package.json` + `VERSION` + the lockfile root |
| `npm run version:check` | Verify `package.json` / `VERSION` / `CHANGELOG.md` agree |
| `npm run pack:assert` | Verify what `npm pack` actually ships (dry-run file list + the three loading contracts) |
| `npm run pack:assert:strict` | Release shape: extract a **real** tarball and recompute size/sha256 for all six binaries against `bin/manifest.json` |
| `npm run bin:check` | Recompute the staged binaries' final-file hashes from the manifest (size alone is not evidence) |
| `npm run skills:cli-guard` | Static guard over non-vendored Skills: no bare `crwu`/`dws`/`ossutil`, `which`, `command -v`, `export PATH=`, or packaged `bin/<platform>/` paths in active instructions |
| `npm run build:lib` | Build `lib/` for release (`prepack` uses it; fails if sources are missing) |

CI runs the same gates on Ubuntu + Windows across Node 22 and 24, so a skipped gate cannot slip through.

**The CRWU audit chain is Tool-first since 2026-09-25.** The audit subagent's prompt no longer contains the
plugin binary directory, `export PATH`, or any bare `crwu` / `dws` / `ossutil` command; it calls business-level
`crwu_*` tools, and the plugin executes the packaged binaries by absolute path through `ctx.shell`. When a tool
is invisible, or a packaged binary is missing, the plugin fails with an explicit **capability gap** *before*
creating the subagent — it never falls back to searching `PATH`. The vendored `skills/dws/**` layer is an
upstream-compatible CLI layer and deliberately stays outside this chain, so the accurate statement is
"the CRWU audit chain does not depend on `PATH`", not "the plugin is `PATH`-free".

The package's **Client half is tested directly** in `tests/unit/client-package.test.mjs`.
`tests/helpers/tsx-loader.mjs` registers an in-process Node loader that strips types and transforms JSX
(via the already-present `typescript` devDependency), and a small React stand-in resolves the element tree.
That keeps the test run to `node --test` with no vitest, jsdom, or react-dom — while still asserting what the
panel renders in its loading / loaded / failed / unmounted states, what `apply` registers into which slot
inside which lifecycle effect, and that the stylesheet uses DSH theme tokens instead of hard-coded colors.
The panel's *visual* behaviour (does it render, does the sidebar grouped card hold its three sub-items
inside one card, does switching modules re-list OSS) is checked in a real browser by `install/browser-check.mjs` — see the
verification checklist in the Chinese README.
