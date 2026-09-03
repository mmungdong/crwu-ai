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
- Treat MCP and CLI as transports, integrations (H3Yun web session, H3Yun agent MCP) as providers, and application services as their shared orchestration boundary. No provider integration imports another.
- Use descriptive, consistent names for directories, commands, tools, and configuration fields.
- Document installation, configuration, required environment variables, and usage alongside each tool.
- Never commit credentials, tokens, private endpoints, or other secrets.
- H3Yun credentials (web session tokens, personal access tokens) are stored in the local OS credential store (`internal/platform/h3yuncreds`), an approved maintainer decision; never write them to files, logs, scheme output, or chat.
- Each H3Yun credential belongs to one explicit employee. Never treat a service credential, administrator credential, or H3Yun engine credential as the employee identity.
- Never authorize an H3Yun operation for an employee whose stored credential cannot be validated; never silently fall back to a system or engine-wide user.
- Avoid dependencies that are not necessary for the tool's core behavior.
- Preserve backward compatibility for existing WorkBuddy integrations unless a breaking change is explicitly approved.

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
