# AGENTS.md

## Repository Purpose

This repository contains AI-related tools, including Skills and MCP servers.

## Current Scope

- Support WorkBuddy only.
- Do not add compatibility layers, configuration, or documentation for other AI hosts unless explicitly requested.
- Keep MCP protocol code host-neutral while testing and documenting WorkBuddy as the only supported host.

## Development Guidelines

- Prefer small, focused tools with a single clear responsibility.
- Keep Skills, MCP servers, and their supporting files in clearly separated directories.
- Treat MCP and CLI as transports, H3Yun and DingTalk as sibling integrations, and application services as their shared orchestration boundary.
- Do not make one provider integration import another; coordinate cross-provider workflows in the application layer.
- Use descriptive, consistent names for directories, commands, tools, and configuration fields.
- Document installation, configuration, required environment variables, and usage alongside each tool.
- Never commit credentials, tokens, private endpoints, or other secrets.
- Avoid dependencies that are not necessary for the tool's core behavior.
- Preserve backward compatibility for existing WorkBuddy integrations unless a breaking change is explicitly approved.

## CLI Command Contract

- Follow `docs/cli-command-contract.md` for every new or changed `crwu` command.
- Register every top-level subcommand in the canonical CLI command catalog.
- Give every subcommand a specific English description, exact usage, and at least one accurate example with an English description.
- Keep `crwu scheme` as stable JSON intended for AI command discovery; write no human-oriented logs to its standard output.
- Treat a command missing its description, usage, or example as incomplete.
- Add or update tests that exercise command behavior and the generated scheme whenever a command changes.
- Keep the default application version synchronized between `internal/buildinfo` and the root `Makefile`; the current version is `0.0.1`.

## Changes and Verification

- Limit changes to the requested feature or tool; avoid unrelated refactoring.
- Add or update tests when behavior changes.
- Run the relevant tests, formatting checks, and lint checks before considering work complete.
- If automated verification is unavailable, document the manual verification performed.
- Update affected documentation whenever setup, configuration, commands, or behavior changes.
- When updating README documentation, synchronize all supported language versions.
