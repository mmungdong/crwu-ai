# Design: crwu h3yun CLI (employee-route, dual-channel)

Status: Accepted · 2026-09-03

## Context

Follows `docs/design-h3yun-auth.md` (per-employee identity) and
`docs/design-h3yun-connector.md` (one core, CLI/MCP transports). Reality found
during milestone 3:

- H3Yun's **Agent MCP** channel (`/v1/agent/mcp`, personal token `h3pat_*`)
  authenticates and lists tools, but every `tools/call` fails with
  `h3yun.read.upstream_error` — the Agent data plane is not provisioned for
  this tenant (H3Yun's own WorkBuddy connector reproduces it).
- H3Yun's **web console REST** (`/v1/...`, `Authorization: Bearer <session
  JWT>` + `EngineCode` header) works for reads. Employees obtain the 48-hour
  session JWT by scanning a QR with DingTalk at `h3yun.com` (no password
  needed). Verified live: `user/info`, `engine/info`, `functionnode/app/list`.
- The two bearer credentials are **not interchangeable** (verified both
  directions: session JWT → MCP = 401 `invalid_token`; `h3pat` → `/v1` = 401).
  They resolve to the same employee underneath (engine + user + shard), but each
  gateway only accepts its own token type.

## Decision

1. **One command tree, channel-aware verbs.** `crwu h3yun …` stays stable;
   each verb is implemented per channel. Unsupported combinations fail with a
   clear message instead of pretending.

2. **Channels and their tokens**
   - `session` channel: web `/v1` REST with the employee session JWT (48 h,
     refreshable). Default today (works).
   - `agent` channel: `/v1/agent/mcp` with the `h3pat_*` personal token. Default
     once the Agent data plane is enabled and pings green.
   - Default resolution: agent when bound and healthy, else session. Explicit
     `--channel session|agent` overrides.

3. **Local credential storage (approved by maintainer).** Until `crwu-server`
   hosts a credential vault, the CLI stores H3Yun credentials in the OS
   credential store (keyring) under a `crwu-h3yun` service. Documented as a
   temporary deviation from AGENTS.md ("server holds H3Yun credentials"); the
   vault is the terminal state and the storage seam is kept swappable.

4. **Session lifecycle commands**
   - `crwu h3yun session bind` — employee pastes the JWT obtained by QR
     scanning at h3yun.com; CLI decodes claims (`enginecode`, `userid`, shard,
     exp) and stores it.
   - `status` — show bound identity, engine, remaining TTL.
   - `refresh` — call `GET /v1/token/refresh`, re-store.
   - `clear` — remove the stored session.

5. **Read verbs on the session channel** (this milestone): `apps list`
   (full list with optional local keyword filter), plus `whoami` via session
   status. Forms/schema/records verbs follow after live validation of their web
   endpoints (they are next milestone).

## Command table

| Command | session channel (today) | agent channel (when enabled) |
| --- | --- | --- |
| `h3yun session bind/status/refresh/clear` | keyring-stored session JWT | (later: `token bind` for `h3pat_*`) |
| `h3yun ping` | — (agent) | MCP initialize |
| `h3yun apps list [--keyword]` | `GET /v1/functionnode/app/list` (+filter) | (later: `h3yun_search_apps`) |
| `h3yun apps search` | (next) | MCP tool (kept) |
| `h3yun records query --sql` | unsupported (SQL) | MCP tool (kept) |

## Output & errors

- JSON envelope `{ "ok": true, "data": … }` to stdout; human errors to stderr;
  exit 2 = usage, 1 = runtime.
- Tokens never printed; bind input is hidden.
- `crwu scheme` advertises every command (AI discovery).

## Milestones

- ✅ M1: rename + auth/connector/cli design docs.
- ✅ M2 (this slice): creds store, web REST client, session bind/status/refresh/clear,
  `apps list` (implemented + unit tested; live validation pending user token).
- ⏳ M3: session forms/schema/records verbs (validate web endpoints live).
- ⏳ M4: agent channel activation when H3Yun enables the data plane.
- ⏳ M5: `crwu mcp h3yun` stdio server; WorkBuddy connector shell.
