# Design: unified H3Yun capability in crwu-ai (CLI + MCP + connector shells)

Status: Accepted · 2026-09-03

## Context

crwu-ai is the enterprise AI-harness monorepo. H3Yun (氚云) is delivered to the
organization as a DingTalk-hosted app, and employees have no H3Yun password.
The prior decision (`docs/design-h3yun-auth.md`) fixed the auth model: each
employee holds a H3Yun personal access token used against the official agent
gateway `https://www.h3yun.com/v1/agent/mcp`.

This document fixes **how that capability is packaged and exposed**. The
question "connector, or MCP, or CLI tools?" is a false trilemma: those are
different layers, and only the transport surface varies per host.

## Decision

1. **One core.** H3Yun access lives once in crwu-ai:
   - `internal/integrations/h3yun` — minimal stdlib MCP client for the H3Yun
     agent gateway (JSON-RPC over Streamable HTTP/SSE). Discovers tools from
     `tools/list` at startup so the surface can never go stale.
   - `internal/app/h3yunops` — application service (token resolution,
     fail-closed mapping gate later, typed read operations).
2. **Two transports, same core.**
   - **CLI** (`crwu h3yun …`): for agent hosts that execute commands well
     (DeepSeek Harness, coding agents); `crwu scheme` publishes the catalog.
   - **MCP** (`crwu mcp h3yun`, stdio): native tool surface for MCP-capable
     hosts (WorkBuddy).
3. **WorkBuddy gets a thin connector shell only.** The marketplace package
   (`token-schema.json` + `mcp.json`) is just packaging: `mcp.json` points at
   the local command `crwu mcp h3yun` instead of a remote URL, and the bundled
   skill is generated from the live tool catalog at build time.
4. **Host adapters never reimplement logic.** WorkBuddy and DeepSeek Harness
   remain thin outer adapters (AGENTS.md), so there is exactly one source of
   truth for commands, schemas, tests, and docs.

## Why not the alternatives

| Shape | Verdict |
| --- | --- |
| Direct HTTP coding against H3Yun web `/v1` | Rejected — unofficial surface, drifts (fast-h3yun experience). The agent gateway already exists; client it. |
| Official WorkBuddy `h3yun-connector` (remote URL) | Rejected as the product — its bundled SKILL documents 21 stale tool names (`listApps`, `batchApprove`, …) that do not match the live 17 `h3yun_*` tools; remote-URL model has no per-employee token lifecycle. Reusable parts: its operating principles (schema before write, encode-don't-guess, confirm before destructive writes). |
| CLI only | Wrong for WorkBuddy employees who cannot run commands. |
| MCP only | Wrong for agent hosts whose native skill is command execution. |
| Remote (server-hosted) MCP now | Deferred — requires hosting/audit infrastructure; local stdio covers the single-machine employee case first. Revisit when a central multi-employee gateway is needed. |

## Tool normalization (17 gateway tools → business surface)

| CRWU action (proposed) | Gateway tool |
| --- | --- |
| `apps search` | `h3yun_search_apps` |
| `forms search` | `h3yun_search_form_node` |
| `schema get` / `schema acl` | `h3yun_get_bizobject_schema` / `h3yun_get_bizobject_schema_acl` |
| `records query` (read-only SQL) | `h3yun_query_bizobject_list` |
| `records get` / name↔id helpers | `h3yun_get_bizobject`, `h3yun_get_bizobject_*_by_*` |
| `org resolve` | `h3yun_get_org_id_by_name`, `h3yun_get_org_names_by_ids` |
| `todos list/count` | `h3yun_get_todo_list`, `h3yun_get_todo_count` |
| `records create/update/remove` (confirm-gated) | `h3yun_create/update/remove_bizobject` |
| `todos approve` (confirm-gated) | `h3yun_approve_todo` |
| `file transfer` | `h3yun_transfer_file` |

Enterprise-specific tooling (schema cache, export, guided flows) is added at
the `h3yunops` layer on top of these.

## Repo layout (target)

```
internal/integrations/h3yun/   stdlib MCP client (gateway)
internal/app/h3yunops/         application service (token, ops)
internal/transport/cli/        crwu h3yun … commands (read-first)
internal/transport/mcp/        crwu mcp h3yun stdio server (next slice)
connectors/workbuddy/          shell: token-schema.json, mcp.json, generated SKILL
```

## Milestones

1. ✅ `crwu h3yun login` rename (`h3y` → `h3yun`).
2. ✅ Auth + surface decision docs (`design-h3yun-auth.md`, this file).
3. 🔨 Core read slice **code complete**: gateway client
   (`internal/integrations/h3yun`), application service
   (`internal/app/h3yunops`), first read commands (`h3yun ping`,
   `h3yun apps search`, `h3yun records query`). Pending: live verification
   against a real personal token (manual step, user-provided) and capturing
   the exact `tools/call`/`data` shapes.
4. ⏳ Remaining read commands (forms/schema/org/todos) + confirm-gated writes.
5. ⏳ `crwu mcp h3yun` stdio server exposing the same ops.
6. ⏳ WorkBuddy connector shell + skill generation; Harness skill/CLI docs.

## Open items

- Exact `tools/call` response shape (structured content vs text envelope) —
  verified with the user's token during milestone 3.
- Data shapes of each tool's `data` — capture one live sample per tool and then
  type the results instead of raw JSON passthrough.
- Token bind flow (`crwu h3yun bind-token`) wiring the mapping gate from
  `design-h3yun-auth.md`.
