# Design: H3Yun employee-route authentication for crwu

Status: Accepted · 2026-09-03

## Context

The organization uses H3Yun (氚云) as a **DingTalk-hosted (managed/ISV)
application**: employees open the H3Yun app directly inside DingTalk and are
logged in via DingTalk single sign-on. Employees have **no separate H3Yun
password**, and H3Yun does not auto-associate DingTalk accounts with H3Yun
mobile accounts unless explicitly bound.

CRWU must operate on H3Yun **as an explicit employee** (per-employee row/field
permissions) — never as an enterprise/administrator identity — so that
sensitive data never crosses employee boundaries.

The CLI command is `crwu h3yun login` (DingTalk employee login, already
shipped). This document records how the authenticated DingTalk principal is
mapped to an H3Yun identity and how every subsequent H3Yun operation is
authorized and executed.

## Options investigated

| Option | Identity level | Verdict |
| --- | --- | --- |
| H3Yun OpenAPI `EngineCode` + `EngineSecret` (`POST https://www.h3yun.com/OpenApi/Invoke`) | Enterprise/tenant | Rejected as runtime identity — acts as the engine, not an employee. Sources: [开发前必读](https://help.h3yun.com/239699205/), [系统集成](https://help.h3yun.com/253812358/) |
| DingTalk gateway `/v1.0/h3yun/*` (`api.dingtalk.com`, `x-acs-dingtalk-access-token`) | Enterprise app token + `opUserId` | Rejected for this org — endpoints exist but require the「氚云数据管理权限」scope, which is not grantable to new customer-built apps for hosted (ISV) tenants. |
| H3Yun web-console `/v1` session JWT (`Authorization: Bearer` + `EngineCode`) | Employee session | Rejected as primary — unofficial contract; requires password/session login, which employees do not have. |
| Mirror of `h3yun.com` DingTalk-scan login | Employee session | Rejected — the QR OAuth callback belongs to H3Yun's own DingTalk app; a third-party server cannot capture that session. |
| **H3Yun「用户访问凭证」(personal access token) → official agent MCP** | **Employee** | **Accepted.** Per-employee token; H3Yun enforces the user's scope server-side. See [用户访问凭证](https://help.h3yun.com/280976225/). |

## Decision

1. **Employee identity** stays with the existing DingTalk OAuth flow
   (`crwu h3yun login`): `corpId`, `userId`, `unionId`, `openId`.
2. **H3Yun authorization = one「用户访问凭证」per employee**, obtained by the
   employee inside H3Yun (avatar → 个人信息 → 管理凭证 → 新建凭证) and bound
   to exactly one CRWU principal. Binding is the identity mapping: **fail
   closed** — no H3Yun operation is authorized until a mapping exists.
3. **All H3Yun operations go through the official agent MCP endpoint**:

   ```
   POST https://www.h3yun.com/v1/agent/mcp
   Authorization: Bearer <personal access token>
   Content-Type: application/json
   Accept: application/json, text/event-stream
   ```

   JSON-RPC over Streamable HTTP (SSE). Validated 2026-09-03 with a real
   token: `initialize` → `serverInfo: h3yun-agent-platform-tools v1.0.0`; no
   `Mcp-Session-Id` header observed (stateless); 17 tools listed.
4. **Secrets stay on the server.** The H3Yun personal token is stored only in
   `crwu-server` state keyed by principal (never in the CLI, never in the
   keyring CRWU session, never in logs). The CLI persists only the opaque CRWU
   session.
5. Tool responses use the envelope `{ errorCode, errorMessage, data }`;
   `errorCode == 0` means success.

## Tool catalog (verified per-tenant, 2026-09-03)

| Area | Tools |
| --- | --- |
| Apps / forms | `h3yun_search_apps`, `h3yun_search_form_node` (keyword search, paginated) |
| Schema / ACL | `h3yun_get_bizobject_schema`, `h3yun_get_bizobject_schema_acl` |
| Read | `h3yun_query_bizobject_list` (controlled read-only `SELECT`, single statement, no newlines), `h3yun_get_bizobject`, `h3yun_get_bizobject_ids_by_names`, `h3yun_get_bizobject_names_by_ids` |
| Write | `h3yun_create_bizobject`, `h3yun_update_bizobject`, `h3yun_remove_bizobject` — non-idempotent; **no automatic retry**; destructive/irreversible ops require explicit operator confirmation before calling |
| Org | `h3yun_get_org_id_by_name`, `h3yun_get_org_names_by_ids` |
| To-dos / approval | `h3yun_get_todo_list`, `h3yun_get_todo_count`, `h3yun_approve_todo` (1–10 items, irreversible, may partially succeed) |
| Attachments | `h3yun_transfer_file` (remote HTTPS URL → attachment `fileId`) |

## Architecture

```
Employee (DingTalk) --crwu h3yun login--> Principal (corpId/userId/unionId/openId)
        |  crwu-server
        v
Principal <--mapping--> H3Yun personal token   (fail closed; bind = mapping)
        |  per-request
        v
POST https://www.h3yun.com/v1/agent/mcp  (JSON-RPC tools/call, Bearer token)
        |  H3Yun enforces the employee's app/form/field/data permissions
        v
{ errorCode: 0, data: ... }
```

Layering (per AGENTS.md): a new sibling integration `internal/integrations/h3yun/`
owns the MCP client and never imports DingTalk; the application layer owns the
principal↔token mapping and the fail-closed gate.

## Command surface (next slices)

| Command | H3Yun tools | Gate |
| --- | --- | --- |
| `crwu h3yun apps search` / `forms search` | `h3yun_search_apps`, `h3yun_search_form_node` | read |
| `crwu h3yun schema <code> [--acl]` | `h3yun_get_bizobject_schema(_acl)` | read |
| `crwu h3yun records query/get` | SQL query, `get_bizobject`, name/id helpers | read |
| `crwu h3yun org resolve` | org name/id helpers | read |
| `crwu h3yun todos list|count` | todo list/count | read |
| `crwu h3yun records create/update/remove` | create/update/remove | **confirm before write** |
| `crwu h3yun todos approve` | `h3yun_approve_todo` | **confirm before approve** |

## Credential lifecycle

- **Bind**: `crwu h3yun bind-token` stores the token server-side keyed by the
  authenticated principal (token entered once, never echoed).
- **Rotate / revoke**: employees revoke inside H3Yun (个人信息 → 管理凭证);
  revoked tokens fail the next call with a non-zero error → operator re-binds.
- **Never**: tokens in git, keyring CRWU sessions, logs, scheme output, or chat.

## Open items

- Personal-token TTL, renewal, and revoke semantics are not published by H3Yun;
  assume revocable and treat bindings as replaceable.
- Write/approve tools are non-idempotent; crwu must render "about to execute
  <operation>" and wait for explicit confirmation (mirrors H3Yun's own agent
  skill discipline).
- Confirm whether the agent MCP endpoint enforces rate limits before building
  bulk import/export flows.

## Rejected alternatives (retained knowledge)

- `EngineCode`/`EngineSecret` OpenAPI: keep only for explicitly approved,
  admin-scoped bootstrap tasks; never as an employee identity.
- Personal token against web `/v1/user/info`: verified 401 `UnLogin` — the
  token is not a web-console session credential.
