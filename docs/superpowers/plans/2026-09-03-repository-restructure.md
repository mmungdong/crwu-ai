# Repository Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a compilable single-module Go repository with one `crwu` CLI binary, a root build Makefile, documented component boundaries, and no protocol/provider coupling.

**Architecture:** `cmd/crwu` is a thin process entry point over a testable CLI transport. Build metadata is isolated in `internal/buildinfo`; future MCP, application, provider integration, configuration, and Python Skill areas are documented without inventing runtime implementations.

**Tech Stack:** Go standard library, GNU Make, Markdown

**Spec:** `docs/superpowers/specs/2026-09-03-repository-restructure-design.md`

## Global Constraints

- Use one root Go module named `github.com/mmungdong/crwu-ai`.
- Build one executable named `crwu` into `bin/crwu`.
- Keep the root Makefile outside all Go package directories.
- Support WorkBuddy configuration only.
- Do not implement MCP, H3Yun, DingTalk, authentication, deployment, or Python Skill behavior.
- Preserve user-authored architectural guidance while replacing the `connectors/h3yun-mcp` skeleton.

---

### Task 1: Minimal Tested CLI Binary

**Files:**
- Create: `go.mod`
- Create: `internal/buildinfo/buildinfo.go`
- Create: `internal/buildinfo/buildinfo_test.go`
- Create: `internal/transport/cli/run.go`
- Create: `internal/transport/cli/run_test.go`
- Create: `cmd/crwu/main.go`

**Interfaces:**
- Produces: `buildinfo.String() string` using linker-set `Version` and `Commit` variables.
- Produces: `cli.Run(args []string, stdout io.Writer, stderr io.Writer) int`.
- Consumes: `cmd/crwu` passes `os.Args[1:]`, `os.Stdout`, and `os.Stderr` to `cli.Run`.

- [x] **Step 1: Add failing build information tests**

```go
func TestString(t *testing.T) {
    oldVersion, oldCommit := Version, Commit
    t.Cleanup(func() { Version, Commit = oldVersion, oldCommit })
    Version, Commit = "1.2.3", "abc123"
    if got, want := String(), "1.2.3 (commit abc123)"; got != want {
        t.Fatalf("String() = %q, want %q", got, want)
    }
}
```

- [x] **Step 2: Run the test and verify it fails because `String` is absent**

Run: `go test ./internal/buildinfo`

Expected: compilation failure identifying the missing build information API.

- [x] **Step 3: Implement minimal build information**

```go
var Version = "dev"
var Commit = "unknown"

func String() string {
    return fmt.Sprintf("%s (commit %s)", Version, Commit)
}
```

- [x] **Step 4: Run the build information test and verify it passes**

Run: `go test ./internal/buildinfo`

Expected: PASS.

- [x] **Step 5: Add failing CLI tests**

Test these externally visible cases through `Run`:

```text
version         -> exit 0 and "crwu <version> (commit <commit>)\n" on stdout
unknown command -> exit 2, no stdout, concise error and usage on stderr
no arguments    -> exit 2, no stdout, usage on stderr
help            -> exit 0, usage on stdout, no stderr
```

- [x] **Step 6: Run the CLI tests and verify they fail because `Run` is absent**

Run: `go test ./internal/transport/cli`

Expected: compilation failure identifying the missing `Run` function.

- [x] **Step 7: Implement the minimal command runner and process entry point**

Use exact commands `version`, `help`, `-h`, and `--help`. Keep all parsing and
messages in `internal/transport/cli`; `main` contains only the `cli.Run` call and
`os.Exit`.

- [x] **Step 8: Run all Go tests**

Run: `go test ./...`

Expected: all packages pass.

### Task 2: Root Build Contract

**Files:**
- Create: `Makefile`
- Create: `.gitignore`

**Interfaces:**
- Consumes: Go package variables `github.com/mmungdong/crwu-ai/internal/buildinfo.Version` and `.Commit` through linker flags.
- Produces: `make build`, `make test`, `make fmt`, and `make clean`.
- Produces: repository-local executable `bin/crwu`.

- [x] **Step 1: Add the root Makefile**

Define overridable `GO`, `VERSION`, and `COMMIT` variables. Keep the output fixed
at `bin/crwu` so cleanup cannot be redirected outside the repository. `build`
creates `bin/` and runs `go build` with linker flags; `test` runs
`go test ./...`; `fmt` runs `go fmt ./...`; `clean` removes exactly `./bin`.

- [x] **Step 2: Ignore generated and private local files**

Ignore `/bin/`, `.env`, `.env.*` while retaining `.env.example`, and local
WorkBuddy JSON configuration while retaining `*.example.json`.

- [x] **Step 3: Exercise the Makefile contract**

Run: `make fmt && make test && make build`

Expected: all commands exit zero and `bin/crwu` exists.

- [x] **Step 4: Verify linker-injected version output**

Run: `./bin/crwu version`

Expected: one line beginning with `crwu dev (commit ` and containing the short
Git commit selected by Make.

### Task 3: Migrate the Directory Skeleton and Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `internal/README.md`
- Create: `internal/app/README.md`
- Create: `internal/transport/mcp/README.md`
- Create: `internal/integrations/README.md`
- Create: `internal/auth/README.md`
- Create: `internal/config/README.md`
- Create: `internal/observability/README.md`
- Create: `skills/README.md`
- Create: `configs/workbuddy/README.md`
- Create: `deployments/README.md`
- Create: `tests/README.md`
- Delete: `connectors/README.md`
- Delete: `connectors/h3yun-mcp/**`

**Interfaces:**
- Produces: one directory vocabulary: `transport`, `app`, `integrations`, and `skills`.
- Consumes: the approved design and current `connectors` README guidance.

- [x] **Step 1: Rewrite repository documentation**

Document purpose, current status, supported WorkBuddy scope, build/test commands,
binary commands, target directory map, and the dependency rule that transports
call application services while integrations remain provider-specific.

- [x] **Step 2: Document future boundaries in their owning directories**

Each README states its directory's responsibility and its forbidden dependencies.
Do not add placeholder Go or Python source files.

- [x] **Step 3: Remove the obsolete connector skeleton**

Delete its empty placeholder files and READMEs only after their useful guidance
has been represented in the new documentation.

- [x] **Step 4: Check terminology and stale paths**

Run: `rg -n 'connectors/h3yun-mcp|src/application|src/domain|src/adapters|DeepSeek' . --glob '!.git/**'`

Expected: no obsolete structure or unsupported-host references outside historical
design documents where explicitly explained.

- [x] **Step 5: Perform final verification**

Run: `make fmt && make test && make clean && make build && ./bin/crwu version && git status --short && git diff --check`

Expected: formatting, tests, clean rebuild, binary execution, and whitespace
checks pass; Git status contains only the intended restructure.
