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

## Changes and Verification

- Limit changes to the requested feature or tool; avoid unrelated refactoring.
- Add or update tests when behavior changes.
- Run the relevant tests, formatting checks, and lint checks before considering work complete.
- If automated verification is unavailable, document the manual verification performed.
- Update affected documentation whenever setup, configuration, commands, or behavior changes.
