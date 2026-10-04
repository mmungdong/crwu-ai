# Documentation Governance Design

**Status:** Accepted on 2026-10-04

## Goal

Reduce documentation maintenance cost while making current instructions easy for humans and agents to find and execute.

## Decisions

- Root `AGENTS.md` holds repository-wide constraints. Nested `AGENTS.md` files contain only scoped additions, required verification, and conditional pointers.
- The English and Simplified Chinese READMEs remain structurally equivalent, concise entry points. They do not duplicate plugin versions, Skill totals, command catalogs, or detailed feature inventories.
- Runtime and repository state are facts. `crwu scheme`, package metadata, directory layout, and existing synchronization checks remain authoritative instead of Markdown copies.
- `docs/v0.0.1/` remains the live documentation set for the current CLI version. The CLI manual owns human workflows; `crwu scheme` owns command metadata; the command contract owns catalog requirements.
- Dated plans, specs, audit reports, backlogs, acceptance reports, reviews, and handoffs remain in place when they retain decision value. They receive a visible historical banner and leave active navigation.
- Vendored DWS content, current design contracts, and documents with uncertain current status are excluded from bulk historical marking.
- CI checks relative links in an explicit set of active entry documents and rejects fixed Workbench versions or fixed Skill totals in the root READMEs. It does not access the network or rewrite historical documents.
- Public installation and manual paths remain stable. Internal historical paths do not receive compatibility stubs.

## Historical banner

Each classified historical document starts with a short block stating that it is a historical snapshot, naming the snapshot date or version when known, warning that it is not a current implementation or operating source of truth, and pointing to a current entry when one exists. The original body remains unchanged.

## Verification

- The documentation checker has tests that fail before its implementation and pass afterward.
- All configured active local Markdown links resolve.
- Root READMEs contain neither a fixed Workbench version nor a fixed Skill total.
- Existing Go, plugin, Skill, build, and packaging gates remain green in proportion to the files changed.
- `git diff --check` passes.

