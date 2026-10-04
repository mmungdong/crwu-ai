# AGENTS.md

## Scope

This repository contains the `crwu` CLI, reusable Skills, and the DeepSeek Harness Workbench plugin. Follow this file for repository-wide rules, then apply the nearest nested `AGENTS.md` for files under `plugins/`.

## Architecture

- Keep application services, authentication, CLI behavior, and MCP protocol code independent of an AI host.
- Treat CLI and MCP as transports, integrations as providers, and application services as their shared orchestration boundary. Provider integrations do not import one another.
- Keep WorkBuddy and DeepSeek Harness integrations as outer adapters. Do not branch core behavior by host.
- Prefer focused modules and existing repository patterns over new abstractions or dependencies.

## Credentials and employee identity

- Every H3Yun credential represents one explicit employee. Never substitute a service, administrator, or engine-wide identity.
- Employees obtain H3Yun access by scanning into H3Yun or by supplying a H3Yun personal token. Never ask for or store an H3Yun password.
- Store H3Yun web sessions and personal tokens only through `internal/platform/h3yuncreds` in the local OS credential store.
- Keep credentials, tokens, signed URLs, private endpoints, and secret-bearing errors out of files, logs, scheme output, tests, and chat.
- Fail closed when a stored employee credential cannot be validated.

## Sources of truth

- `crwu scheme` is the machine-readable source for CLI command names, arguments, descriptions, usage, and examples.
- [`docs/v0.0.1/cli-manual.md`](docs/v0.0.1/cli-manual.md) owns human and agent operating workflows for the current CLI line.
- [`docs/v0.0.1/cli-command-contract.md`](docs/v0.0.1/cli-command-contract.md) owns command-catalog requirements.
- [`docs/v0.0.1/CHANGELOG.md`](docs/v0.0.1/CHANGELOG.md) records functional CLI and audit-system changes.
- Package metadata and `VERSION` files own release versions. Directory layout and `SKILL.md` frontmatter own the Skill inventory.
- Root READMEs are concise entry points. Keep English and Simplified Chinese structurally equivalent, and do not copy dynamic versions, totals, or command catalogs into them.

## Skill self-containment

Every non-vendored Skill must work after its own directory is copied into an agent's skills root.

- Keep runtime scripts, schemas, examples, tests, and references inside the Skill directory.
- Call installed commands from `PATH`; discover CLI contracts through `crwu scheme`.
- Refer to a sibling Skill through `$SKILLS_ROOT/<skill>/...`, never through a repository path.
- Derive repository or skills roots in source-repository maintenance scripts from `__file__`.
- When a Skill depends on a genuinely external tool that this repository does not ship, state that boundary and that the tool is not installed with the Skill.
- Repository-only contract tests may locate the source repository after declaring `源仓契约测试` or `源仓维护工具` in their first 30 lines. They must skip when source-only documents or sibling Skills are absent.
- Vendored DWS Skills are governed by their provenance check and are not rewritten to match repository-owned rules.

Run the self-containment validator once for each non-vendored layer; passing an umbrella `skills/` directory is invalid because discovery is one level deep. Detailed layer and maintenance rules live in [`plugins/AGENTS.md`](plugins/AGENTS.md).

## CLI changes

For every new or changed `crwu` subcommand:

1. Register its English description, exact usage, and at least one accurate example in the canonical catalog.
2. Keep `crwu scheme` JSON-only on stdout; diagnostics go to stderr.
3. Test observable command behavior and generated scheme output.
4. Update the CLI manual and append the changelog when commands, flags, environment variables, output contracts, channel behavior, or workflows change.
5. Keep the CLI default version synchronized between `internal/buildinfo` and the root `Makefile`.

## Documentation lifecycle

- Active instructions describe current behavior and link only to current operating documents.
- Dated plans, specs, reviews, backlogs, acceptance reports, and handoffs are historical snapshots. Keep their original body intact and mark them as historical instead of using them as current instructions.
- Fix links in active navigation. Do not mechanically rewrite historical prose to use today's paths.
- Run `make docs-check` after changing an active Markdown entry point.

## Verification and delivery

- Add or update tests before behavior changes and verify the test can fail for the intended reason.
- Run the narrow test while iterating, then the relevant repository gate before completion.
- Use `make test` for Go behavior, `make docs-check` for active documentation, and `make plugin-check` for Workbench or packaged Skill changes.
- Run `git diff --check` and inspect the final diff for unrelated files and generated artifacts.
- Do not commit, push, tag, or publish unless the user explicitly requests that action.
