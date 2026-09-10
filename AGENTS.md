# AGENTS.md

## Repository Purpose

This repository contains AI-related tools, including Skills and MCP servers.

## Current Scope

- Keep core application services, authentication, CLI behavior, and MCP protocol code independent of WorkBuddy and DeepSeek Harness.
- Treat WorkBuddy and DeepSeek Harness as thin outer adapters; never branch core behavior by AI host.
- Employee H3Yun access binds a credential that the employee themselves obtained by scanning into H3Yun (or a H3Yun personal token). Never ask for or store H3Yun passwords.

## Development Guidelines

- Prefer small, focused tools with a single clear responsibility.
- Keep Skills, MCP servers, and their supporting files in clearly separated directories.
- Make every Skill self-contained: no Skill may reference anything outside its own directory (see §Skill Self-Containment).
- Treat MCP and CLI as transports, integrations (H3Yun web session, H3Yun agent MCP) as providers, and application services as their shared orchestration boundary. No provider integration imports another.
- Use descriptive, consistent names for directories, commands, tools, and configuration fields.
- Document installation, configuration, required environment variables, and usage alongside each tool.
- Never commit credentials, tokens, private endpoints, or other secrets.
- H3Yun credentials (web session tokens, personal access tokens) are stored in the local OS credential store (`internal/platform/h3yuncreds`), an approved maintainer decision; never write them to files, logs, scheme output, or chat.
- Each H3Yun credential belongs to one explicit employee. Never treat a service credential, administrator credential, or H3Yun engine credential as the employee identity.
- Never authorize an H3Yun operation for an employee whose stored credential cannot be validated; never silently fall back to a system or engine-wide user.
- Avoid dependencies that are not necessary for the tool's core behavior.
- Preserve backward compatibility for existing WorkBuddy integrations unless a breaking change is explicitly approved.

## Skill Self-Containment

Every Skill under `skills/<skill>/` must work when installed as a copy on its own — agents install each Skill into their own skills root, so nothing outside the Skill directory exists at that point. This is a hard rule, enforced by a machine gate.

Never, in `SKILL.md`, `references/*` or the Skill's own `scripts/*`:

- reference a repository directory or repository-root file: `docs/`, `tools/`, `cmd/`, `internal/`, `bin/`, `Makefile`, `go.mod`;
- link out of the Skill directory (`[manual](../../docs/cli-manual.md)`, `../docs/...`);
- write a repo-root-relative cross-Skill path (`skills/<other-skill>/...`);
- rely on a deployment-injected executable path, or point at a repository manual or `./bin/<platform>/crwu` instead of the installed `crwu` command.

Do instead:

- keep every script a Skill runs inside that Skill's own `scripts/`, together with its tests, schemas, examples and README; write commands as `python3 scripts/<file>` (run from the Skill directory);
- refer to a sibling Skill's script as "the `<skill>` Skill's `scripts/<file>`" and run it as `python3 "$SKILLS_ROOT/<skill>/scripts/<file>"`, where `$SKILLS_ROOT` is the skills root this Skill is installed into;
- put explanations, thresholds and design rationale in the Skill's own `references/`; never treat repository design docs as runtime reading;
- take CLI usage, flags and output contracts from `crwu scheme` (runtime command catalog) and call `crwu` from `PATH`;
- derive any skills-root or repository-root constant inside a script from `__file__` (`Path(__file__).resolve().parents[N]`), never from hardcoded repository layout;
- describe source-repository bookkeeping (design docs, skill index, change log) functionally rather than by repository path.

Two exceptions, and only these two:

- **External tools** that genuinely ship outside this repository (for example a deployment-side script): the Skill must state that this repository does not provide them and that they do not install with the Skill.
- **Source-repository contract tests / maintenance tools**: `.py` files that only run while maintaining this repository, that the runtime never needs and that `SKILL.md` never references as a runtime step, may locate the repository after declaring `源仓契约测试` or `源仓维护工具` within their first 30 lines. Any assertion about repository documents must skip explicitly when they are absent, so that an installed copy skips instead of failing.

Machine gate: `python3 <skills root>/crwu-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root <skills root>` must report `error=0`; its self-containment lint enforces the list above over Skill content and Skill-owned scripts (`skills/AGENTS.md` and `skills/README.md` are repository documents, not Skills). The full checklist, the "what to write instead" table and the migration steps are in [`skills/AGENTS.md`](skills/AGENTS.md) §「技能自洽性」.

## CLI Command Contract

- Follow `docs/cli-command-contract.md` for every new or changed `crwu` command.
- Register every invokable subcommand in the canonical CLI command catalog.
- Give every subcommand a specific English description, exact usage, and at least one accurate example with an English description.
- Keep `crwu scheme` as stable JSON intended for AI command discovery; write no human-oriented logs to its standard output.
- Treat a command missing its description, usage, or example as incomplete.
- Add or update tests that exercise command behavior and the generated scheme whenever a command changes.
- Keep the default application version synchronized between `internal/buildinfo` and the root `Makefile`; the current version is `0.0.1`.

## CLI Manual & Changelog

- `docs/cli-manual.md` is the single source of truth for *using* the CLI, so an
  agent can operate `crwu` without reading the whole repository. Update it
  whenever commands, flags, environment variables, output contracts, channel
  behavior, or workflows change.
- Append an entry to `docs/CHANGELOG.md` for every functional CLI change
  (feat / fix / refactor / docs), following that file's format.
- Keep the README command tables in sync with the actual command catalog
  (`crwu scheme`).

## Changes and Verification

- Limit changes to the requested feature or tool; avoid unrelated refactoring.
- Add or update tests when behavior changes.
- Run the relevant tests, formatting checks, and lint checks before considering work complete.
- If automated verification is unavailable, document the manual verification performed.
- Update affected documentation whenever setup, configuration, commands, or behavior changes.
- When updating README documentation, synchronize all supported language versions.
