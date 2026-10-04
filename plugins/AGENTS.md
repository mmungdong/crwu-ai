# Plugin and Skill Development Rules

This file applies under `plugins/`. Follow the repository root `AGENTS.md` first and the Workbench-specific `AGENTS.md` when working under `plugins/dsh-crwu-workbench/`.

## Source and runtime boundaries

- Modify source-repository files only. Runtime Skill directories, employee profiles, credentials, caches, and installed bundles are not source files.
- Keep plugin source, generated output, deployment configuration, packaged assets, and runtime data distinct.
- `src/` is source. `lib/`, tarballs, packaged binaries, and synchronized package copies are generated outputs; regenerate them through their owning scripts.
- Keep Host, Client, and shared wire contracts separate. Entrypoints perform exports and assembly, not domain logic.
- Organize code by runtime boundary and business domain. Shared modules contain only wire types, protocol constants, or environment-neutral pure functions used by more than one domain.

## Skill layers

DSH scans one level below each registered Skill root. Every layer is therefore registered as its own root.

| Layer | Ownership | Change path |
| --- | --- | --- |
| `dsh-crwu-workbench/skills/crwu/` | Repository-owned audit and maintenance Skills | Edit in place; run self-containment and audit contract gates. |
| `dsh-crwu-workbench/skills/dws/` | Vendored `dingtalk-workspace-cli` content | Change only through `npm run dws:sync`; verify provenance with `npm run dws:check`. |
| `common/skills/` | Repository-owned shared Skills | Edit the source layer; synchronize the package copy with `npm run skills:sync`. |
| `dsh-crwu-workbench/common/skills/` | Generated package copy | Never edit directly. |

Adding a layer requires coordinated changes to plugin registration, `package.json.files`, tarball assertions, layer tests, and focused documentation. Adding a Skill to an existing layer relies on directory discovery; do not introduce a second inventory manifest.

## Skill content

- Keep `SKILL.md` as an entry point: responsibility, inputs, required local references, execution steps, and completion gates.
- Put rationale and detailed rules in that Skill's own `references/`; keep scripts and their tests beside one another in `scripts/`.
- Non-vendored Skill instructions and scripts must not drive `crwu`, `dws`, or `ossutil` through shell/subprocess escape paths. Use registered structured Tools in DSH. Compatibility sections for other hosts must use the existing narrow guard markers.
- Knowledge-driven audit Skills store routing keys and RULE/CHK identifiers, not copied knowledge text, local knowledge paths, or hard-coded node IDs.
- Leaf Skills load the synchronized local common contract. Public cross-cutting Skills keep their own focused execution contract.
- `available` means the registry, classification, Skill entry, local references, mappings, tests, and validators agree. Use `pending` or record a capability gap when evidence is incomplete.

For changes to the audit family, read the current contracts before editing:

- [`docs/v0.0.1/design-crwu-audit-skills.md`](../docs/v0.0.1/design-crwu-audit-skills.md) for routing and capability boundaries.
- [`docs/v0.0.1/design-audit-live-kb-protocol.md`](../docs/v0.0.1/design-audit-live-kb-protocol.md) for live-knowledge evidence rules.
- [`docs/v0.0.1/design-crwu-dws.md`](../docs/v0.0.1/design-crwu-dws.md) for DWS lookup, cache, and download contracts.
- [`docs/skills.md`](../docs/skills.md) for layer maintenance and installation workflows.

## Workbench package and configuration

- The npm package name in `dsh-crwu-workbench/package.json` is the package-name source of truth.
- `dsh-crwu-workbench/config/crwu-workbench.yml` is the deployment-configuration source. Do not duplicate configurable addresses or behavior in TypeScript defaults, Make targets, or bundle patches.
- The package uses npm distribution. Keep the removed public/read-only OSS distribution path removed; OSS configuration is for private audit delivery.
- Package configuration and tarballs never contain AK/SK values, STS tokens, signed URLs, or employee credentials.
- Preserve installed-package behavior: package paths resolve from the package name, packaged configuration is present, and `prepare` skips rebuilding when source files are absent.
- Changing configuration schema or delivery shape requires synchronized parser/schema, package assertions, tests, plugin README, plugin changelog, and version updates.

Read focused Workbench documents only when their branch applies:

| Trigger | Document |
| --- | --- |
| UI, layout, styles, or interaction | [`dsh-crwu-workbench/docs/ui-design-guidelines.md`](dsh-crwu-workbench/docs/ui-design-guidelines.md) |
| Host/Client loading, lifecycle, protocol, sandbox, or operation changes | [`dsh-crwu-workbench/docs/development-notes.md`](dsh-crwu-workbench/docs/development-notes.md) |
| Sidebar modules or Workbench product behavior | [`dsh-crwu-workbench/docs/PRD-workbench-sidebar-modules.md`](dsh-crwu-workbench/docs/PRD-workbench-sidebar-modules.md) |
| Versioning or npm release work | [`dsh-crwu-workbench/docs/releasing.md`](dsh-crwu-workbench/docs/releasing.md) |

These documents provide rationale and workflows. Source, tests, schemas, and current `AGENTS.md` rules decide behavior when prose has drifted.

## Verification

Run from the repository root unless noted:

```bash
make docs-check
make plugin-check
git diff --check
```

For focused Skill work, also run the validator and contract test that own the changed layer or audit behavior. The standard Workbench gate already covers version/config consistency, synchronized Skills, CLI guards, TypeScript, tests, build, smoke loading, and package assertions.

Do not manually modify or publish generated output. Publishing remains a user-authorized action; see the Workbench-specific instructions and release guide.
