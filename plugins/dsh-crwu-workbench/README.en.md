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

Conventions: [`AGENTS.md`](AGENTS.md). Security model: [`SECURITY.md`](SECURITY.md).
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
`dist/dsh-crwu-workbench-<version>.tgz`; `make plugin-dist` uploads it to OSS and prints the
employee-side install command.

**Restart that profile afterwards** — plugins load with the profile. Then:

1. Click the persistent **中瑞世联工作台** entry at the **bottom of the left sidebar** (above Settings).
   It is one grouped card: the header carries the brand mark plus a small tag saying whether this is `dev`
   (a source checkout) or the installed version (`v0.0.4`), and the body holds three sub-items —
   Report Evaluation (marked "in development"), Report Audit, and Environment. Clicking a sub-item
   switches the panel to that module and opens it; the panel itself no longer has a module bar.
2. If the panel opens on the Environment module, get the environment in place first: use "copy prompt" to
   hand the install manifest to the agent, then install `crwu` / `dws` / `ossutil`, the iFinD key, and
   the H3Yun + DingTalk logins.
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

### Updating and removing

```bash
dsh plugin --profile web add dsh-crwu-workbench@<version>   # then restart the profile
dsh plugin --profile web remove dsh-crwu-workbench
```

> **A version is published once.** `make plugin-dist` refuses to overwrite an existing tarball of the
> same version when its content differs, so any change means bumping the version first — otherwise
> employees who installed early and those who reinstall end up on different code under one version.

## One YAML configuration

[`config/crwu-workbench.yml`](config/crwu-workbench.yml) is the single configuration source for source
development, packaging, and the installed employee tarball. `oss.readonly` names the anonymously readable
bucket that carries the environment manifest, install instructions, and plugin tarballs. `oss.protected`
names the private audit-deliverable bucket; credentials stay on the employee machine and object links use
signed URLs by default.

The Host reads this YAML directly in source development. Set `CRWU_CONFIG_FILE=/absolute/path/config.yml`
before starting the DSH profile to test another file. `npm pack` validates and embeds the package-local YAML,
and the installed Host automatically reads that packaged copy. `make plugin-dist` derives both its OSS write
target and the employee HTTPS install URL from the same `oss.readonly` section.

## Releasing

Never run `npm publish` by hand. The release path is tag-driven and gated:

```bash
npm run version:set 0.1.3          # package.json + VERSION + lockfile root
# add a `## package · 0.1.3 · <date>` section to CHANGELOG.md
npm run check && npm run pack:assert
git commit -am "release: 0.1.3" && git push
git tag plugin-v0.1.3 && git push origin plugin-v0.1.3
```

A `plugin-v*` tag triggers the repository-root [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
(`v*` is reserved for the Go CLI in the same repository, keeping the two release lines apart); it asserts the
tag matches `package.json` / `VERSION`, runs the full gate and the packed-artifact check, then publishes
with `--provenance` (needs an `NPM_TOKEN` repository secret). `workflow_dispatch` runs the same pipeline
as a dry run. `prepublishOnly` re-runs the artifact check and the gate, so a manual publish cannot skip them.

### One trap worth knowing: npm runs `prepare` on install too

Installing the **published tarball** also runs `prepare`, but the tarball only contains `lib/`, the package
configuration, the patch, Skills and docs — no `src/`, `tsconfig.json`, or `tsdown.config.ts`. So `prepare` cannot be `tsdown`, and it cannot
point at a script that is not shipped. The build entry is `scripts/prepare.mjs`, which **is** in `files`:
it builds when the sources are present and skips with an explanation when they are not. The release path is
`prepack` → `build:lib --force`, which fails rather than shipping a package without `lib/`.

`tests/unit/host-package.test.mjs` pins this with a real `npm pack` + `npm install` + import regression —
both failure modes were invisible to local gates and only surfaced for the person installing the package.

`peerDependencies` currently pin the `@deepseek-ai/dsh-*@0.1.5-rc.2` line, matching the installed DSH.
The DSH plugin API is a developer preview: when you upgrade DSH, re-check those peers, re-run the gate, and
record the supported DSH version in `CHANGELOG.md`.

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
| `npm run pack:assert` | Verify what `npm pack` actually ships (required before publishing) |
| `npm run build:lib` | Build `lib/` for release (`prepack` uses it; fails if sources are missing) |

CI runs the same gates on Ubuntu + Windows across Node 22 and 24, so a skipped gate cannot slip through.

The package's **Client half is tested directly** in `tests/unit/client-package.test.mjs`.
`tests/helpers/tsx-loader.mjs` registers an in-process Node loader that strips types and transforms JSX
(via the already-present `typescript` devDependency), and a small React stand-in resolves the element tree.
That keeps the test run to `node --test` with no vitest, jsdom, or react-dom — while still asserting what the
panel renders in its loading / loaded / failed / unmounted states, what `apply` registers into which slot
inside which lifecycle effect, and that the stylesheet uses DSH theme tokens instead of hard-coded colors.
The panel's *visual* behaviour (does it render, does the sidebar grouped card hold its three sub-items
inside one card, does switching modules re-list OSS) is checked in a real browser by `install/browser-check.mjs` — see the
verification checklist in the Chinese README.
