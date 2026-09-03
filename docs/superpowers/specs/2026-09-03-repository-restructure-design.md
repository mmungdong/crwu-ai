# Repository Restructure Design

## Goal

Restructure `crwu-ai` into a single Go module that can grow into one enterprise
MCP server and CLI, while keeping H3Yun and DingTalk integrations independent
and keeping Python Skills outside the Go runtime and build.

## Scope

This change establishes a compilable project skeleton. It does not implement
MCP tools, H3Yun APIs, DingTalk APIs, authentication, or Python Skills.

The first executable is a single `crwu` binary. The same binary will eventually
expose MCP server and direct CLI subcommands so both entry points can reuse the
same application services.

## Repository Structure

```text
crwu-ai/
├── cmd/
│   └── crwu/
│       └── main.go
├── internal/
│   ├── app/
│   ├── transport/
│   │   ├── cli/
│   │   └── mcp/
│   ├── integrations/
│   │   ├── h3yun/
│   │   └── dingtalk/
│   ├── auth/
│   ├── config/
│   └── observability/
├── skills/
├── configs/
│   └── workbuddy/
├── deployments/
├── docs/
├── tests/
│   ├── contract/
│   └── integration/
├── go.mod
└── Makefile
```

Directories without executable behavior are documented but are not populated
with empty Go packages. Packages will be created when the first use case needs
them.

## Component Boundaries

- `cmd/crwu` owns process startup and dependency assembly only.
- `internal/transport/mcp` owns MCP protocol handling, tool schemas, and MCP
  error mapping.
- `internal/transport/cli` owns command parsing and terminal presentation.
- `internal/app` owns host-neutral use cases shared by MCP and CLI.
- `internal/integrations/h3yun` owns H3Yun clients, authentication details,
  provider DTOs, and provider error translation.
- `internal/integrations/dingtalk` owns DingTalk clients, authentication
  details, provider DTOs, and provider error translation.
- H3Yun packages do not import DingTalk packages. Cross-provider login or
  session workflows are coordinated by the application layer through narrow
  interfaces.
- `skills` contains separately packaged Python Skills. Python dependencies are
  not part of the Go binary or the root Go build.

## Initial Binary Contract

The first `crwu` binary provides a minimal, testable command surface:

- `crwu version` prints build version metadata.
- No MCP or connector command is advertised until it is implemented.
- Unknown commands return a non-zero exit status and a concise usage message.

Command behavior is implemented in `internal/transport/cli`; `main.go` only
passes standard input/output streams and exits with the returned status.

## Build Contract

The repository-root `Makefile` is external to all Go packages and is the
canonical developer build entry point.

- `make build` creates `bin/crwu` for the current platform.
- `make test` runs all Go tests.
- `make fmt` checks or applies standard Go formatting.
- `make clean` removes only the repository-local `bin` output directory.
- Version and commit values are injected through Go linker flags. Direct builds
  use the current release version and `unknown` commit as safe defaults.
- Cross-platform release targets are deferred until release packaging is
  requested.

## Configuration and Host Support

Current supported host scope remains WorkBuddy. MCP implementation should stay
protocol-oriented, but only WorkBuddy configuration examples and compatibility
claims are maintained. Example configuration lives under
`configs/workbuddy/`; credentials, tokens, sessions, and private endpoints must
not be committed.

## Testing

- CLI behavior is unit-tested by invoking the command runner with in-memory
  input/output streams.
- `make test` verifies all Go packages.
- `make build` proves the configured binary can be produced at `bin/crwu`.
- MCP contract and external integration tests will be added with their first
  implemented behaviors, under `tests/contract` and `tests/integration` when a
  black-box boundary is required.

## Migration

1. Add root Go module, build file, ignore rules, and minimal CLI tests.
2. Implement the smallest CLI runner needed to make the tests pass.
3. Remove the empty `connectors/h3yun-mcp` skeleton after its architectural
   guidance has been captured here and in the root documentation.
4. Add short boundary documentation for the future integration, transport,
   configuration, deployment, and Skills directories without creating empty
   implementation packages.
5. Rewrite the root README with the repository purpose, current status, build
   commands, and directory map.
6. Run formatting, unit tests, build verification, and inspect the final Git
   diff.

## Non-Goals

- Multiple Go modules or a `go.work` workspace.
- Separate `h3yun-mcp` and `dingtalk-mcp` executables.
- A public `pkg` directory before an external Go consumer exists.
- Docker, systemd, release archives, or cross-compilation targets.
- MCP SDK selection or connector implementation.
