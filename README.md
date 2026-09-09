<div align="center">

# 🤖 CRWU Agent Harness

**Connect AI hosts to your enterprise systems through one stable command surface — safely acting as the right employee.**

[**简体中文**](README.zh-CN.md)

<br>

![Go](https://img.shields.io/badge/Go-1.24%2B-00add8?logo=go&logoColor=white)
![Version](https://img.shields.io/badge/version-0.0.1-3b82f6)
![Make](https://img.shields.io/badge/build-GNU%20Make-1f2937?logo=gnu&logoColor=white)
![Session](https://img.shields.io/badge/H3Yun_session_✅-available-22c55e)
![MCP](https://img.shields.io/badge/MCP-planned-64748b)

*CLI-first · H3Yun employee-scope reads · no server to operate*

</div>

---

## 🌟 What it is

CRWU is a **Go command-line harness** that gives AI hosts — WorkBuddy,
DeepSeek Harness, operator terminals — a stable, auditable way to reach
enterprise systems. One executable (`crwu`), one machine-readable command
catalog (`crwu scheme`) that agents can discover on their own.

The first production vertical is **H3Yun (氚云) employee-scope data access**:

- 🔐 H3Yun lives inside your DingTalk; employees have **no H3Yun password**.
- 📱 Each employee scans a QR at `h3yun.com` with DingTalk and binds the
  resulting **web session** to this machine once (48 h, refreshable).
- 🛡️ Every command afterwards runs **under that employee's permissions** —
  apps, forms, records and attachments exactly as they see them. No passwords,
  no cross-employee data, no server to operate.

> ✅ **Working today:** session binding · app / form / record browsing ·
> attachment downloads — under the employee's own permissions.
> ⏳ **On the roadmap:** agent-gateway (`h3pat`) tools, the MCP transport and
> Python Skills (see [🔀 Channels](#-channels--two-ways-in)).

## 🚀 Quick start

```bash
# Prerequisites: Go 1.24+, GNU Make
make build          # writes macOS ./bin/darwin/crwu and Windows ./bin/windows/crwu.exe
./bin/darwin/crwu version
make test
```

`make build` produces both a macOS and a Windows binary, one per platform
subdirectory under `bin/` (`make clean` removes them); `make build-mac` and
`make build-win` build a single platform. No configuration
file is required; optional `H3YUN_BASE_URL` overrides the H3Yun console origin
for testing.

## 🔑 Employee workflow

**1 · Let the employee log in themselves — no DevTools needed**

```bash
./bin/darwin/crwu h3yun session login       # opens a browser; employee scans with DingTalk
./bin/darwin/crwu h3yun session status      # who, which engine, time-to-expiry
```

`crwu` reads the session token straight from the browser into the local
keyring — it is never printed or shared with the AI host. A DevTools-based
`session bind --token <jwt>` fallback exists for trusted binders.

**2 · Browse the workspace as that employee**

```bash
./bin/darwin/crwu h3yun apps list
./bin/darwin/crwu h3yun apps children --app <appCode>
./bin/darwin/crwu h3yun forms search --keyword <name>
```

**3 · Read records and pull attachments**

```bash
./bin/darwin/crwu h3yun records list   --schema <schemaCode> [--keyword <kw>] [--filter "Status = 1 and Name Contains '测试'"]
./bin/darwin/crwu h3yun records get    --schema <schemaCode> --id <recordId>
./bin/darwin/crwu h3yun files list     --schema <schemaCode> --id <recordId>
./bin/darwin/crwu h3yun file download  --schema <schemaCode> --id <recordId> --out ./files
```

> 🔒 **Where do credentials live?** Only in the OS credential store
> (`internal/platform/h3yuncreds`) — never in files, logs, scheme output or
> chat. Sessions expire after 48 h; renew with `session refresh` or re-bind.

## 🧭 Command reference

### 💻 Basics

| Command | Purpose |
| --- | --- |
| `crwu help` | Show available commands and usage |
| `crwu scheme` | Print the machine-readable command catalog for AI clients |
| `crwu version` | Show the CLI version and build commit |

### 🔐 Session (employee binding)

| Command | Purpose |
| --- | --- |
| `crwu h3yun session login` | Employee self-service login: open a browser, QR-scan, and bind locally (token never reaches the conversation) |
| `crwu h3yun session bind --token <jwt>` | Bind the employee's H3Yun web session to this machine (fallback / trusted path) |
| `crwu h3yun session status` | Show the bound identity, engine and expiry |
| `crwu h3yun session refresh` | Renew the bound session token |
| `crwu h3yun session clear` | Remove the bound session |

### 📦 Apps & forms

| Command | Purpose |
| --- | --- |
| `crwu h3yun apps list [--keyword <name>]` | List applications the employee can access |
| `crwu h3yun apps children --app <code>` | List the forms inside one application |
| `crwu h3yun apps search --keyword <name>` | Search applications *(agent channel)* |
| `crwu h3yun forms search --keyword <name>` | Search forms by name *(web session)* |

### 📋 Records

| Command | Purpose |
| --- | --- |
| `crwu h3yun records list --schema <code> [--page] [--size] [--keyword] [--filter <cond>]` | Page through a form's records (field conditions via `--filter`) |
| `crwu h3yun records get --schema <code> --id <id>` | Load one record with its fields |
| `crwu h3yun records query --schema <code> --sql <select>` | Read-only SQL query *(agent channel)* |

### 📎 Attachments

| Command | Purpose |
| --- | --- |
| `crwu h3yun files list --schema <code> --id <id>` | List the record's attachment files |
| `crwu h3yun file download --schema <code> --id <id> --out <dir>` | Download all attachments — deduplicated, original names |

### ⚡ Agent gateway (`h3pat`)

| Command | Purpose |
| --- | --- |
| `crwu h3yun ping` | Handshake with the H3Yun agent gateway |
| `crwu h3yun tools` | List the gateway tools visible to the current token |

## 🧠 AI command discovery

`crwu scheme` writes **only JSON** to standard output — version, descriptions,
usages and examples in one catalog — so AI clients parse it without stripping
log noise; diagnostics go to stderr with a non-zero exit code.

Read [`docs/cli-command-contract.md`](docs/cli-command-contract.md) before
adding or changing a command.

## 🔀 Channels — two ways in

| Channel | Credential | Endpoint | Status |
| --- | --- | --- | --- |
| 🌐 **Session** (web console) | Employee QR-scan session JWT | `www.h3yun.com/v1/...` | ✅ Working |
| ⚡ **Agent** (MCP gateway) | Personal access token `h3pat_*` | `www.h3yun.com/v1/agent/mcp` | ⏳ Needs H3Yun data-plane enablement |

📚 Design records: [`design-h3yun-auth.md`](docs/design-h3yun-auth.md) ·
[`design-h3yun-cli.md`](docs/design-h3yun-cli.md) ·
[`design-h3yun-connector.md`](docs/design-h3yun-connector.md)

## 🏗️ Architecture

```mermaid
flowchart LR
    WorkBuddy -->|MCP (planned)| MCP_TRANSPORT[MCP transport]
    DeepSeek[DeepSeek Harness] -->|CLI adapter| CLI_TRANSPORT[CLI transport]
    Operator -->|CLI| CLI_TRANSPORT
    CLI_TRANSPORT --> APP[Application services]
    MCP_TRANSPORT --> APP
    APP --> H3Yun[H3Yun integrations]
    H3Yun --> S[web-session REST]
    H3Yun --> A[agent-gateway MCP]
```

- 🚏 **Transports** own parsing & presentation (CLI now, MCP later).
- 🧩 **Application services** orchestrate host-neutral use cases
  (`internal/app/h3yunops`, `internal/app/h3yunweb`).
- 🔌 **Integrations** own provider protocols only — H3Yun web REST and agent
  MCP clients live under `internal/integrations/h3yun`, never importing
  another provider.
- 🔑 **Credentials** are bound per machine
  (`internal/platform/h3yuncreds`) — there is no server to operate.

## 📂 Repository layout

```text
cmd/crwu/                        process entry point
internal/
  app/h3yunops/                 agent-gateway application service
  app/h3yunweb/                 web-session service (bind/refresh/reads/files)
  buildinfo/                    linker-injected build metadata
  integrations/h3yun/           H3Yun web REST + agent MCP clients
  platform/h3yuncreds/          local OS-credential-store persistence
  transport/cli/                command behavior
  transport/mcp/                future MCP protocol boundary
docs/                           design records (auth / cli / connector)
tests/                          cross-package tests
```

## 🛠️ Development

```bash
make fmt     # gofmt
make build   # writes ./bin/darwin/crwu (macOS) and ./bin/windows/crwu.exe (Windows)
make test
```

Keep the default version synchronized between `internal/buildinfo` and the
root `Makefile`.

## 📚 Documentation

- [`docs/cli-manual.md`](docs/cli-manual.md) — **CLI user manual** (the one doc agents need)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — CLI change log
- [`docs/cli-command-contract.md`](docs/cli-command-contract.md) — rules every `crwu` subcommand must follow
- [`AGENTS.md`](AGENTS.md) — agent-facing development guidelines
- [`CONTEXT.md`](CONTEXT.md) — domain glossary

---

<div align="center">

**[简体中文](README.zh-CN.md)**

</div>
