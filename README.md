# crwu-ai

`crwu-ai` contains enterprise AI tooling for WorkBuddy. The repository uses one
Go module to build the `crwu` command and keeps protocol transports, application
use cases, external-system integrations, and Python Skills in separate areas.

The current implementation is an executable project skeleton. MCP tools,
H3Yun/DingTalk APIs, authentication, and Python Skills have not been implemented
yet.

## Requirements

- Go 1.24 or newer
- GNU Make

## Build and test

```bash
make build
./bin/crwu version
make test
```

If Go is not on `PATH`, pass its location to Make:

```bash
make GO=/path/to/go build
```

Generated binaries are written only to `bin/`. Run `make clean` to remove that
directory.

## Commands

```text
crwu version    print version and commit information
crwu help       show command help
crwu scheme     print the command catalog as JSON for AI clients
```

MCP and provider-specific commands will be introduced with their first working
use cases; the skeleton does not advertise commands that are not implemented.

## AI command discovery

`crwu scheme` is the canonical machine-readable command catalog. Its JSON output
contains the current CLI version and every supported subcommand. Each command
has an English description, exact usage, and at least one example with its own
English description.

```bash
crwu scheme
```

The command writes only JSON to standard output so an AI client can parse it
without removing human-oriented log lines. Diagnostics are written to standard
error with a non-zero exit status.

See [`docs/cli-command-contract.md`](docs/cli-command-contract.md) before adding
or changing a command.

## Architecture

```text
WorkBuddy ──> MCP transport ──┐
                             ├──> application use cases ──> integrations
Operator  ──> CLI transport ─┘                              ├── H3Yun
                                                            └── DingTalk
```

- Transports own protocol schemas, command parsing, and presentation.
- Application services coordinate host-neutral use cases.
- Integrations own provider clients, provider authentication details, DTOs,
  and provider error translation.
- H3Yun and DingTalk integrations are siblings. Neither imports the other.
- Python Skills are packaged independently and are not linked into the Go
  binary.

## Directory map

```text
cmd/crwu/                  process entry point
internal/buildinfo/        linker-injected build metadata
internal/transport/cli/    CLI command behavior
internal/transport/mcp/    future MCP protocol boundary
internal/app/              future shared application use cases
internal/integrations/     future H3Yun and DingTalk adapters
internal/auth/             future cross-cutting identity policy
internal/config/           future typed configuration loading
internal/observability/    future logs, metrics, and tracing
skills/                    independently packaged Python Skills
configs/workbuddy/         WorkBuddy configuration examples
deployments/               deployment assets when introduced
tests/                     cross-package contract and integration tests
docs/                      architecture and implementation records
```

Only WorkBuddy is currently supported and documented as an AI host. Protocol
code should avoid WorkBuddy-private coupling, but compatibility with other
hosts is not claimed or maintained.
