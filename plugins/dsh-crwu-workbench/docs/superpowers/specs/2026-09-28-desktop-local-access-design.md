# Desktop Local Access and Audit Sandbox Design

**Status:** Review draft

**Date:** 2026-09-29

**Target release:** `dsh-crwu-workbench@0.0.15`

**Current baseline:** branch `feat/adapt_for_win`, commits through `c55ee1c`

## 1. Objective

Make the installed workbench operate on clean Windows and macOS machines running DSH in their default
`workspace-write` mode without requiring an administrator shell, `sudo`, a profile-wide
`danger-full-access` setting, or interactive privilege escalation from an audit child agent.

The implementation must satisfy all of the following:

1. The user gives one versioned, explicit consent before the workbench accesses local credentials
   or credential-bearing files.
2. Only fixed Host operations may cross the workspace boundary, and each such operation declares
   `danger-full-access` for that one call.
3. Audit root and child sessions always remain `workspace-write`; audit children never log in and
   never request approval.
4. The UI distinguishes missing consent, sandbox denial, sandbox downgrade, OS filesystem
   permission failure, OS credential-store failure, file lock, infrastructure failure, and genuine
   authentication failure.
5. The release is tested as an installed package on Windows and macOS, not only from the source
   checkout.

## 2. Evidence and root-cause split

The reported errors have three different execution histories and must not be collapsed into one
generic permission error.

| Symptom | Current evidence | Required conclusion |
| --- | --- | --- |
| Writing `%USERPROFILE%\.ossutilconfig` reports `file access denied under workspace-write mode` | `v0.0.14` predates commit `e7b3798`, which added an explicit filesystem policy to this write | Installed package lacks the fix; this is a confirmed DSH sandbox denial |
| H3Yun reports `secret not found in keyring` | `v0.0.14` did not escalate all `h3yun session` reads and probed before consent | This result is not proof that the user is logged out |
| DWS cannot open `%USERPROFILE%\.dws\.data.lock` | The panel login path already requested escalation in `v0.0.14`; an Agent or vendored skill can still invoke DWS directly; an actual ACL or lock can produce the same text | Classification requires requested/resolved/actual sandbox facts before remediation |
| macOS reports `sandbox-exec: sandbox_apply: Operation not permitted` | A confined app can fail while trying to start another sandbox runner | This is sandbox infrastructure failure, not a missing CLI or bad credential |
| macOS cannot read Keychain or reports interaction is not allowed | Even an unsandboxed process can be subject to macOS Keychain ACL and interaction policy | Confirm actual DFA first, then distinguish missing secret from OS credential-store denial |
| macOS credential files remain broader than mode `0600` | POSIX mode tightening may fail or be ineffective and must be read back | Saving a credential is not successful completion until its permission result is reported accurately |

Commits `e7b3798` and `c55ee1c` are after tag `v0.0.14`. The repository package version is still
`0.0.14`; therefore a new package version is mandatory.

## 3. Non-negotiable decisions

### 3.1 No global full access

The implementation must not set the whole profile, current chat, audit root, or audit child to
`danger-full-access`.

DSH approval is operation-scoped and turn-scoped. A workbench consent screen is a product
authorization record; it is not a DSH-wide permission token. The Host uses that record to decide
whether its own fixed operation may attach an explicit per-call sandbox policy.

### 3.2 No interactive consent inside audit children

DSH delegation captures the parent's explicit sandbox override and pins child approval policy to
`never`. The audit path must therefore be designed so that no child action requires an approval
prompt. Local credentials are accessed only inside registered CRWU tools whose Host implementation
already has a fixed operation identity.

### 3.3 No modal over the whole application

The existing product contract requires the authorization control to live in the environment
workflow rather than an application-wide modal. First open must select the account step and render
a blocking consent card before credential checks. Other configuration content can remain visible,
but credential-dependent actions stay disabled.

### 3.4 No automatic OS permission mutation

Consent to workbench operations does not authorize arbitrary `icacls`, `chmod`, `chown`, lock
deletion, process termination, ownership changes, or Keychain ACL changes. Filesystem permission
repair is a separate, explicit, second-confirmation action shown only after the sandbox has been
ruled out. The plugin never changes macOS Keychain ACLs and never invokes `sudo`.

## 4. Delivery decomposition

The change is split into five subprojects. Each subproject has its own review gate and can be
rejected without invalidating already accepted work.

| Order | Subproject | Deliverable | Depends on |
| --- | --- | --- | --- |
| A | Consent protocol and safe environment bootstrap | Versioned consent state, first-open gate, pre-consent checks with zero credential side effects | Current branch baseline |
| B | Local Access Broker and integration migration | One policy owner for all out-of-workspace Host operations; OSS, H3Yun, DWS, iFinD and state paths migrated | A |
| C | Audit session confinement | Explicit `workspace-write` audit root, deterministic `never` approval, child verification and pre-spawn readiness gate | A, B |
| D | Desktop attribution and repair guidance | Structured diagnostics, sandbox/filesystem/credential-store/lock classification, platform-scoped repair | B |
| E | Package, compatibility and release acceptance | Protocol 18, version 0.0.15, installed-tarball Windows and macOS matrices | A-D |

No subproject may silently broaden the scope of another one. In particular, Subproject C does not
grant broader rights to compensate for an incomplete Subproject B.

## 5. Shared wire contract

### 5.1 Protocol version

Increment `WORKBENCH_PROTOCOL` from 17 to 18. Protocol 18 changes consent semantics, environment
behavior, and diagnostics. A new client connected to an old Host must stop before any credential
operation and ask the user to fully restart DSH.

### 5.2 Consent types

Add these types to `src/shared/access/types.ts` and re-export only the wire-safe views from
`src/shared/types.ts`:

```ts
export const LOCAL_ACCESS_SCHEMA_VERSION = 1 as const

export type LocalAccessCapability =
  | 'h3yun-credential-store'
  | 'dws-profile'
  | 'oss-config'
  | 'ifind-credential'
  | 'system-integration'

export interface LocalAccessConsentRecord {
  schemaVersion: typeof LOCAL_ACCESS_SCHEMA_VERSION
  grantedAt: string
  capabilities: LocalAccessCapability[]
}

export interface LocalAccessConsentView {
  state: 'missing' | 'outdated' | 'granted' | 'revoked' | 'persist-failed'
  schemaVersion: number
  requiredSchemaVersion: typeof LOCAL_ACCESS_SCHEMA_VERSION
  grantedAt: string
  capabilities: LocalAccessCapability[]
  reason: string
}
```

`capabilities` is serialized in the canonical order shown above. Unknown values are ignored when
reading but make the record `outdated`; they are never treated as a grant.

### 5.3 Persistent representation

Store the record under the `localAccessConsent` key in the existing platform-derived workbench
state file: `%USERPROFILE%\.dsh\crwu-workbench.json` on Windows and
`$HOME/.dsh/crwu-workbench.json` on macOS. Callers must use the shared local-path helper rather than
concatenating either spelling:

```json
{
  "localAccessConsent": {
    "schemaVersion": 1,
    "grantedAt": "2026-09-28T00:00:00.000Z",
    "capabilities": [
      "h3yun-credential-store",
      "dws-profile",
      "oss-config",
      "ifind-credential",
      "system-integration"
    ]
  }
}
```

The old `trustCredentials: true` is not an implicit grant for the expanded scope. It maps to
`outdated` and causes the new consent card to appear. Once the new record is saved, new code stops
writing `trustCredentials`; the legacy key may remain on disk until another state migration rewrites
the file.

### 5.4 RPC operations

Replace client use of `trust` with two explicit operations:

```ts
type LocalAccessGrantArgs = {
  schemaVersion: 1
  capabilities: LocalAccessCapability[]
}

type LocalAccessGrantResult = {
  ok: boolean
  error: string
  consent: LocalAccessConsentView
  verification: LocalAccessVerificationView
}

type LocalAccessRevokeResult = {
  ok: boolean
  error: string
  consent: LocalAccessConsentView
}
```

Operation names:

- `local-access-grant`
- `local-access-revoke`

Keep the old `trust` handler for one protocol generation only. It must return a protocol-mismatch
failure and must not grant access. This prevents an old client from silently granting the new,
broader capability set.

Both operations must be added to:

- the Host operation table;
- `boot.ported.done`;
- `tests/helpers/frozen-inventory.mjs`;
- the client RPC facade and `OPERATION_OF`;
- operation inventory tests.

### 5.5 Boot and environment fields

Add to `boot`:

```ts
permissionSchemaVersion: 1
localAccess: LocalAccessConsentView
```

Replace `env.trust.credentials` with:

```ts
localAccess: LocalAccessConsentView
```

The unified environment model keeps a `credentialsConsent` item, but its state derives only from
`localAccess.state === 'granted'`.

## 6. Subproject A: consent protocol and safe bootstrap

### A1. Consent parsing and state transitions

**Create**

- `src/host/access/consent.ts`: parse, validate, grant and revoke the persisted record.
- `src/shared/access/types.ts`: wire-safe access types and constants.
- `tests/unit/host-access-consent.test.mjs`: pure and persistence transition tests.

**Modify**

- `src/host/state/types.ts`: replace `trustCredentials` with `localAccess` runtime state.
- `src/host/state/store.ts`: initialize the missing view.
- `src/host/state/persist.ts`: preserve unrelated fields and expose the read result needed by the
  consent service.
- `src/host/ops/core.ts`: register grant and revoke operations.

**Required transitions**

| Starting state | Action | Persisted result | In-memory result |
| --- | --- | --- | --- |
| missing/outdated/revoked | grant, write succeeds | valid record | granted |
| missing/outdated/revoked | grant, write fails | unchanged old data | not granted, RPC `ok:false` |
| granted | revoke, write succeeds | explicit revoked tombstone or removed record | revoked |
| granted | revoke, write fails | old grant may remain on disk | immediately revoked for current process, RPC `ok:false`, state `persist-failed` |

The consent service may use a narrow bootstrap exception to write the workbench's own state file.
That exception is fixed to `workbenchConfigPath(home)` and cannot be selected by an RPC argument or
Agent tool argument.

### A2. Pre-consent environment split

**Modify**

- `src/host/environment/ops.ts`: divide safe core checks from local-access checks.
- `src/host/environment/state.ts`: represent `missing`, `outdated`, `revoked`, and `persist-failed`
  as distinct user issues.
- `src/host/environment/gate.ts`: fail closed for credential-dependent capabilities.
- `tests/unit/host-environment-env.test.mjs`: assert which calls occurred, not just the final text.
- `tests/unit/client-env-model.test.mjs`: assert capability and issue derivation.

Before consent, `loadEnvironment()` must not call:

- `runCrwu()` for H3Yun session or records;
- DWS auth or identity commands;
- `readOssCred()` or `probeOss()`;
- `ifindEnvCheck()` or any iFinD credential reader;
- login operations.

It may still check package integrity, DSH Runtime, platform, tool visibility and workspace state.

The returned credential-dependent items use state `unconfigured` with reason “需要先允许工作台访问本机账号和配置”.
They must not use `invalid`, `未登录`, `密钥错误`, or `not found` before a real post-consent probe.

### A3. First-open client state

**Create**

- `src/client/features/environment/LocalAccessConsentCard.tsx`: consent disclosure and actions.
- `src/client/features/environment/local-access.ts`: pure view-state helpers.
- `tests/unit/client-local-access.test.mjs`: injected render and state tests.

**Modify**

- `src/client/features/environment/EnvironmentPane.tsx`: render the new card in the account step.
- `src/client/features/workbench/WorkbenchPanel.tsx`: select the account step on missing/outdated
  consent and prevent credential actions while granting.
- `src/client/features/report-audit/api.ts`: typed grant/revoke methods.
- `src/client/locales/zh-CN.ts`: exact disclosure, decline, retry and persistence failure copy.
- `install/browser-check.mjs`: first-open behavior and absence of credential RPC side effects.

The card displays the five capability groups from Section 5.2, not the phrase “all permissions”.
The primary button sends the exact schema version and exact canonical capability list. The Host
rejects missing, extra, duplicate or reordered capabilities so a modified client cannot grant a
different scope.

### A acceptance

- **A-01:** old `trustCredentials:true` produces `outdated`, not `granted`.
- **A-02:** grant persistence failure leaves privileged operations unavailable.
- **A-03:** no credential-bearing dependency is called before consent.
- **A-04:** decline performs no Host mutation.
- **A-05:** revoke blocks the current process even when persistence fails.
- **A-06:** client and Host disagreeing on permission schema fail closed.

## 7. Subproject B: Local Access Broker

### B1. Operation vocabulary

**Create**

- `src/host/access/operations.ts`: closed operation and capability mapping.
- `src/host/access/broker.ts`: authorization decision plus shell/filesystem execution wrappers.
- `src/host/access/diagnostics.ts`: normalized, redacted execution facts.
- `tests/unit/host-access-broker.test.mjs`: policy, target and source tests.

Use this closed operation union:

```ts
export type LocalAccessOperation =
  | 'workbench.state.write'
  | 'ifind.credential.read'
  | 'ifind.credential.write'
  | 'ifind.credential.clear'
  | 'h3yun.session.status'
  | 'h3yun.session.login'
  | 'h3yun.session.bind'
  | 'h3yun.forms.read'
  | 'h3yun.records.read'
  | 'h3yun.files.read'
  | 'dws.auth.status'
  | 'dws.auth.login'
  | 'dws.profile.read'
  | 'dws.knowledge.read'
  | 'dws.drive.read'
  | 'dws.drive.write'
  | 'dws.contact.read'
  | 'dws.message.write'
  | 'oss.config.read'
  | 'oss.config.write'
  | 'oss.remote.read'
  | 'oss.remote.write'
  | 'system.browser.open'
  | 'system.clipboard.write'
  | 'system.case-file.open'
```

Every union member has one descriptor:

```ts
interface LocalAccessDescriptor {
  capability: LocalAccessCapability | 'host-owned-state'
  transport: 'shell' | 'filesystem'
  privileged: boolean
  allowedSources: Array<'panel' | 'audit-tool' | 'host-background'>
}
```

`host-owned-state` is not a user-granted capability. It is limited to the exact workbench state
path and exists so the plugin can persist grant/revoke and workspace state. It cannot execute a
shell command.

### B2. Broker interfaces

The broker is constructed once in `src/host/apply.ts` and passed through dependency objects. It
does not use module-level mutable state.

```ts
export interface LocalAccessCall {
  operation: LocalAccessOperation
  source: 'panel' | 'audit-tool' | 'host-background'
  workdir: string
  signal?: AbortSignal
}

export interface LocalAccessDecision {
  ok: boolean
  error: string
  errorKind: '' | 'not-authorized' | 'invalid-source' | 'invalid-workdir'
  sandboxPolicy?: { mode: 'danger-full-access'; workspaceRoot: string }
}

export interface LocalAccessBroker {
  authorize(call: LocalAccessCall): LocalAccessDecision
  runShell(call: LocalAccessCall, command: string, options: BrokerShellOptions): Promise<ShellResult>
  writeText(call: LocalAccessCall, target: FsTarget, content: string): Promise<BrokerFsResult>
}
```

The broker is not a general command executor. Callers may reach `runShell` only after their domain
executor has independently validated a fixed command shape:

- `runCrwu` maps a validated CRWU argv to one H3Yun operation;
- `runDws` maps a matched `DWS_ALLOWED_PREFIXES` entry to one DWS operation;
- OSS functions construct a fixed `ossutil` command and validate configured bucket/prefix;
- system operations construct commands in `platform/shell.ts` and validate case containment.

No client or Tool schema gains an operation, command, binary, path-to-binary, sandbox, policy, or
escalation parameter.

### B3. Shell facts

Extend the broker result with:

```ts
export interface AccessDiagnostic {
  operation: LocalAccessOperation
  source: 'panel' | 'audit-tool' | 'host-background'
  requestedMode: string
  resolvedMode: string
  ranMode: string
  sandboxDenied: boolean
  runnerFailed: boolean
  errorClass:
    | ''
    | 'not-authorized'
    | 'sandbox-denied'
    | 'sandbox-downgraded'
    | 'approval-denied'
    | 'os-filesystem-permission'
    | 'os-credential-store'
    | 'file-lock'
    | 'cli'
    | 'infrastructure'
}
```

The diagnostic is returned only to the developer diagnostics view. User-facing results receive a
short remediation message. Logs may contain operation names and modes but no credentials, signed
URLs, file contents, or unredacted argv values.

### B4. Migration order

Migrate integrations in this exact order so every commit remains reviewable:

1. `src/host/state/persist.ts` and `src/host/ifind/store.ts` filesystem writes.
2. `src/host/oss/cred.ts` and `src/host/oss/ops.ts` config read/write plus every `ossutil` invocation.
3. `src/host/crwu/run.ts` H3Yun command mapping.
4. `src/host/dws/run.ts`, `src/host/system/identity.ts`, and DWS environment/login operations.
5. `src/host/system/ops.ts` browser, clipboard and case-file open.
6. `src/host/tools/*` callers, replacing `trusted` and `credentialOperation` booleans with explicit
   source and operation identities.
7. `src/host/ops/core.ts` dependencies and removal of the public `crwu` operation's `escalate`
   argument.

The public `crwu` RPC must not accept `escalate` in protocol 18. If retained for diagnostics, it may
run only non-privileged allowlisted operations; all credential-bearing actions use dedicated Host
operations or CRWU tools.

### B5. Integration-specific rules

#### H3Yun

- All `h3yun session`, forms, records and file operations require the H3Yun capability because the
  CLI may access or refresh the OS credential store.
- Pre-consent calls return `not-authorized` without spawning the CLI.
- `secret not found in keyring` is authentication failure only when execution facts prove the
  privileged request was neither downgraded nor denied.

#### DWS

- All entries in `DWS_ALLOWED_PREFIXES` map to a named DWS operation and use the Broker after
  consent.
- `runDws` keeps command-prefix validation; the Broker does not replace it.
- Panel login uses source `panel`; audit knowledge/archive/notify uses `audit-tool`.
- Audit tools never expose `auth login`.

#### OSS

- Config read/write uses the exact `ossConfigPath(home)` target.
- Every `ossutil` call uses the Broker because it reads `.ossutilconfig` even when the remote action
  itself is read-only.
- Existing bucket, endpoint and prefix containment remains mandatory and separate from local access.

#### iFinD

- Credential file fallback uses exact paths under `.dsh/crwu-workbench`.
- DSH credential-service storage keeps mechanism `host-store`; file fallback keeps POSIX/Windows
  permission reporting.
- Agent tools receive only query results; they never receive the secret or credential path.

### B acceptance

- **B-01:** every out-of-workspace shell call has a named broker operation.
- **B-02:** every out-of-workspace filesystem write has a named broker operation.
- **B-03:** no model/client schema contains escalation or generic command fields.
- **B-04:** ungranted capability prevents provider invocation entirely.
- **B-05:** explicit privileged request survives `resolve()` as `danger-full-access`, or is reported as
  `sandbox-downgraded`.
- **B-06:** OSS config and every `ossutil` path are covered.
- **B-07:** H3Yun keyring false negatives are not shown as logged-out state.
- **B-08:** DWS operations preserve prefix allowlisting and cancellation.
- **B-09:** source scan finds no direct business CLI execution outside the approved executors.

## 8. Subproject C: audit session confinement

### C1. Dependencies

Add matching peer and development dependencies for the supported DSH lines:

- `@deepseek-ai/dsh-sandbox-policy`
- `@deepseek-ai/dsh-user-approval`

The version range must match the repository's existing DSH peer policy:

```text
^0.1.7-rc.2 || ^0.2.0-rc.1
```

Compatibility checks must compare the exported `setSandboxMode`, `setApprovalPolicy`,
`SandboxPolicyService.resolve`, and approval `effectivePolicy` contracts on both supported lines.

### C2. Root policy service

**Create**

- `src/host/audit/policy.ts`: apply and verify the audit root policy.
- `tests/unit/host-audit-policy.test.mjs`: session event and service-resolution tests.

Interface:

```ts
export interface AuditPolicyView {
  ok: boolean
  error: string
  sandboxMode: string
  workspaceRoot: string
  approvalPolicy: string
  permissionPreset: string
}

export function applyAuditRootPolicy(
  ctx: Context,
  agent: Agent,
  workspacePath: string,
): AuditPolicyView
```

Required behavior:

1. Append `sandbox/mode=workspace-write` to the root session.
2. Append `approval/policy=never` to the root session.
3. Resolve the effective sandbox policy and require an exact workspace-root match.
4. Resolve the effective approval policy and require `never` when the service is available.
5. Inspect `permissionPresets.current(session)` when available. `auto` or
   `danger-full-access` makes the root unusable; do not delegate from it.
6. Return a structured failure instead of creating a child when any fact is wrong or unavailable.

### C3. Root lifecycle changes

**Modify**

- `src/host/audit/root.ts`: apply policy immediately after `agents.create` and before hello preflight;
  include policy in root usability.
- `src/host/audit/spawn.ts`: capture child facts after publication for diagnostics.
- `src/host/audit/preflight.ts`: require environment readiness and Broker-backed capabilities before
  starting a child.
- `src/host/audit/ops.ts`: maintain the ordering below.
- `tests/unit/host-audit-root.test.mjs`, `host-audit-spawn.test.mjs`, and
  `host-audit-lifecycle.test.mjs`.

Mandatory start order:

```text
resolve/create root
→ apply and verify root policy
→ verify required CRWU tools on root scope
→ call zero-side-effect capabilities tool
→ resolve H3Yun form
→ bootstrap current input snapshot through root-scoped Tool
→ resolve DSH Python
→ verify post-consent environment capabilities
→ start child
→ inspect published child policy/tool visibility
```

The post-publication check is diagnostic because the child may already have accepted its prompt.
Safety comes from setting and verifying the root policy before `subagents.start()` captures it.

### C4. Agent execution rules

- Audit prompt continues to prohibit bare `crwu`, `dws`, and `ossutil`.
- Audit child may write only the selected case directory through workspace-confined shell/fs tools.
- H3Yun, DWS, OSS and iFinD actions use registered CRWU tools.
- Missing login or revoked consent stops the audit; it never launches an interactive login.
- Direct DWS login instructions in vendored skills are not edited manually. The DSH adaptation must
  be maintained in the upstream sync source or a deterministic sync overlay with provenance.
- Add a static guard proving that the audit prompt and self-authored skills do not instruct agents
  to authenticate with a bare CLI.

### C acceptance

- **C-01:** a fresh audit root resolves to `workspace-write` for the selected workspace.
- **C-02:** reused roots with unsafe presets are rejected.
- **C-03:** child delegation receives `workspace-write` and `approval=never`.
- **C-04:** the child can create/modify files inside its case directory.
- **C-05:** the child cannot write outside the selected workspace, including `%USERPROFILE%` on
  Windows and `$HOME` on macOS, with shell or filesystem tools.
- **C-06:** the same child can use Broker-backed CRWU tools after human consent.
- **C-07:** missing consent/login stops before `subagents.start()`.
- **C-08:** no audit path invokes an interactive login.

## 9. Subproject D: desktop attribution and repair guidance

### D1. Classifier

**Create**

- `src/host/access/classify.ts`: pure classification from execution facts and sanitized text.
- `tests/unit/host-access-classify.test.mjs`: exact reported Windows samples, macOS Keychain and
  `sandbox-exec` samples, plus negative controls.

Classification precedence:

1. `runnerFailed=true` → `infrastructure`.
2. requested `danger-full-access`, resolved to another mode → `sandbox-downgraded`.
3. `sandboxDenied=true` → `sandbox-denied`.
4. approval rejection before process creation → `approval-denied`.
5. actual `danger-full-access`, `sandboxDenied=false`, and a macOS credential-store denial such as
   `errSecInteractionNotAllowed`, status `-25308`, “User interaction is not allowed”, or an explicit
   Keychain access denial → `os-credential-store`.
6. actual `danger-full-access`, `sandboxDenied=false`, DWS lock text plus a positive lock probe →
   `file-lock`.
7. actual `danger-full-access`, `sandboxDenied=false`, and a platform-native access check denies the
   current account → `os-filesystem-permission`.
8. process exited non-zero → `cli`.
9. process never started → `infrastructure`.

Text matching is a fallback only when structured facts are absent. Once structured facts are
present, text must not override them.

### D2. Read-only DWS doctor

Add Host operation `dws-local-doctor`. It accepts no path and derives the DWS directory from trusted
world facts: `%USERPROFILE%\.dws` on Windows and `$HOME/.dws` on macOS. It returns only:

```ts
interface DwsLocalDoctorView {
  ok: boolean
  error: string
  platform: string
  permissionMechanism: 'windows-acl' | 'posix-mode' | 'unknown'
  directoryExists: boolean
  lockExists: boolean
  ownerMatchesCurrentUser: boolean | null
  currentUserCanModify: boolean | null
  directoryMode: string
  lockMode: string
  credentialStoreState:
    | 'unknown'
    | 'available'
    | 'missing-secret'
    | 'interaction-denied'
    | 'access-denied'
  dwsDoctorState: string
  classification: AccessDiagnostic['errorClass']
}
```

It must not return ACL entries, usernames, SIDs, tokens, DWS profiles, Keychain item names or raw
`dws doctor` output. `directoryMode` and `lockMode` contain only normalized octal mode strings on
POSIX and are empty on Windows.

The operation runs only after consent and only after a DWS failure whose structured facts rule out
sandbox denial.

### D3. Optional filesystem permission repair

Add Host operation `dws-local-permission-repair` only if the read-only doctor proves
`os-filesystem-permission`.

Requirements:

- RPC requires `{ confirm: true }` and rejects every other shape.
- Target is derived internally and fixed to the current user's DWS directory.
- Windows: grant only the current account the minimum Modify rights required to create, update,
  rename and delete DWS files; preserve SYSTEM, Administrators and inherited ACL entries.
- macOS: only when the current user already owns the paths, set the DWS directory to `0700` and the
  regular DWS state/lock files that failed diagnosis to `0600`; reject symlinks and never traverse
  outside `$HOME/.dws`.
- Do not take ownership of any path and do not execute `chown` or `sudo`. Wrong-owner cases are
  reported for manual administrator repair.
- Do not delete `.data.lock`.
- Do not terminate processes.
- Re-run the read-only doctor and DWS auth status after repair.
- Linux and unsupported platforms return a capability-gap response without executing a command in
  this release.

The UI uses a second confirmation distinct from local-access consent. The button is not rendered
for sandbox denial, sandbox downgrade, credential-store denial, authentication failure, wrong
owner, or file lock.

### D4. macOS Keychain handling

The plugin must not attempt to repair or rewrite macOS Keychain ACLs. After a privileged call has
been proven to run outside the DSH sandbox:

- a genuine missing item is shown as “not logged in” and may offer the normal panel login;
- interaction/access denial is shown as an operating-system credential-store problem;
- if macOS presents its own Keychain confirmation, the Host waits for the fixed command timeout and
  reports cancellation separately from denial;
- remediation tells the user to complete the macOS prompt or inspect the relevant item in Keychain
  Access; no secret name, account name or token is returned to the client.

### D5. macOS nested-sandbox handling

`sandbox-exec: sandbox_apply: Operation not permitted` and a structured `runnerFailed=true` are
classified as sandbox infrastructure failure. They must never be translated to “command missing”,
“not logged in”, or “credential invalid”. A Broker call that resolved to `danger-full-access`
should bypass the sandbox runner; observing a runner attempt in that state is a contract failure and
must include requested/resolved/actual facts in developer diagnostics.

### D acceptance

- **D-01:** the three reported Windows messages and the macOS Keychain/sandbox-runner samples
  classify correctly with and without structured facts.
- **D-02:** actual DFA plus `denied=false` is never described as a sandbox denial.
- **D-03:** doctor derives its target and accepts no arbitrary path.
- **D-04:** repair cannot run without both a platform filesystem-permission diagnosis and explicit
  confirmation.
- **D-05:** repair never changes a parent directory or deletes a lock.
- **D-06:** all doctor and repair responses are credential- and identity-redacted.
- **D-07:** macOS repair rejects wrong-owner paths and symlinks without invoking `sudo` or `chown`.
- **D-08:** macOS credential-store failures never trigger filesystem repair.

## 10. Subproject E: packaging and release acceptance

### E1. Version and protocol

- Set package, lockfile root, `VERSION`, Host constants and CHANGELOG to `0.0.15`.
- Set `WORKBENCH_PROTOCOL` to 18 and document the consent/broker semantic break.
- Add the two DSH peer/dev dependencies from C1.
- Ensure tag `plugin-v0.0.15` points to a commit containing `e7b3798`, `c55ee1c`, and all A-D work.
- Do not create or push the tag until the user has tested and reviewed the installed package.

### E2. Automated suites

Required commands:

```text
npm run version:check
npm run config:check
npm run skills:check
npm run skills:cli-guard
npm run dws:check
npm run typecheck
npm test
npm run build
npm run smoke:built
npm run pack:assert
npm run pack:assert:strict
npm run bin:check
npm run compat:dsh
git diff --check
```

Every new test must be defect-proven: temporarily inject the targeted failure, observe the named
test fail, restore from a temporary backup rather than `git checkout`, and rerun it green.

### E3. Installed-package common desktop matrix

Test the packed tarball, not the source checkout, twice: once on a clean, non-administrator Windows
account and once on a clean, non-administrator macOS account. DSH must begin in its default
`workspace-write` mode on both machines. Record the same common ID with a platform prefix, for
example `WIN-P-01` and `MAC-P-01`; passing on one platform does not satisfy the other.

| ID | Scenario | Expected evidence |
| --- | --- | --- |
| P-01 | Install tarball and fully quit/restart DSH | `boot.version=0.0.15`, protocol 18, installed build kind and current `builtAt` |
| P-02 | First open without consent | Consent card visible; no H3Yun/DWS/OSS/iFinD process or credential-file read occurs |
| P-03 | Decline | No persistent grant, no credential probe and audit remains blocked |
| P-04 | Grant | Versioned receipt persists first; only then does post-consent verification start |
| P-05 | Existing H3Yun login | Status uses a Broker DFA call; a real session is not reported as keyring-not-found |
| P-06 | H3Yun fresh login | Normal browser/device flow completes and subsequent status succeeds |
| P-07 | DWS login | `<HOME>/.dws/.data.lock` can be safely created/updated and auth status succeeds |
| P-08 | OSS save | `<HOME>/.ossutilconfig` is written, permission postcondition passes and a real prefix-scoped probe succeeds |
| P-09 | iFinD save | Credential persists, permission postcondition passes and a real safe data probe succeeds |
| P-10 | Full application restart | Consent and configuration restore without another prompt or pre-consent probe |
| P-11 | Revoke | All credential-bearing Host and Tool operations fail closed immediately and after restart |
| P-12 | Audit start | Root and child facts show `workspace-write`/`never`; child writes its case directory |
| P-13 | Child escape attempt | Direct shell and filesystem writes outside the selected workspace are denied |
| P-14 | Child structured operations | H3Yun/DWS/OSS/iFinD registered tools work through the Broker without child approval prompts |
| P-15 | Forced sandbox downgrade | UI reports requested/resolved/actual modes and does not suggest OS permission repair |
| P-16 | Forced filesystem denial | DFA is confirmed; doctor reports the native permission mechanism; repair needs a second confirmation |
| P-17 | Forced file lock | UI asks the user to close the competing process; it does not delete the lock or kill a process |
| P-18 | Client/Host mismatch | New credential activity is blocked with a full-application-restart instruction |

### E4. Windows-native matrix

Run these in addition to the common matrix on Windows x64 using Windows PowerShell 5.1 and the
supported PowerShell Core version where CI provides it.

| ID | Scenario | Expected evidence |
| --- | --- | --- |
| W-01 | Paths contain a drive root, spaces and non-ASCII characters | All Host targets resolve below the intended root; no POSIX separators reach native commands |
| W-02 | OSS and DWS operations from `workspace-write` | Per-call Broker facts show requested/resolved/actual `danger-full-access`; no profile-wide mode changes |
| W-03 | `.dws` denies the current account Modify rights | Doctor reports `windows-acl`; second-confirmed repair changes only current-user Modify access and preserves inherited/SYSTEM/Administrators entries |
| W-04 | `.dws` has a different owner or repair command fails | No ownership takeover is attempted; the UI reports manual administrator remediation and verification remains failed |
| W-05 | Native lock holder keeps `.data.lock` open | Classified as `file-lock`, not ACL or authentication; no automatic deletion or process termination |
| W-06 | Child writes `%USERPROFILE%` directly | Both shell and filesystem attempts fail while Broker-backed registered tools still pass |
| W-07 | Package compatibility jobs | `windows-powershell`, `windows-binary-smoke` and both supported DSH type/runtime lines pass for the packed artifact |

### E5. macOS-native matrix

Run these in addition to the common matrix on a clean standard macOS account. The release evidence
must name the tested architecture (`darwin-arm64` for the currently shipped binary) and macOS
version.

| ID | Scenario | Expected evidence |
| --- | --- | --- |
| M-01 | H3Yun/DWS reads an existing Keychain-backed session | Broker facts prove actual DFA before interpretation; a valid secret is read without exposing item/account names |
| M-02 | Keychain item is genuinely absent | Classified as `missing-secret`; the normal panel login is offered only after consent |
| M-03 | Keychain interaction is cancelled or denied | Classified as `os-credential-store`; no login-state false negative and no filesystem repair is offered |
| M-04 | Credential file is saved | Parent directory is private as required; the exact regular file reads back as mode `0600` before success is reported |
| M-05 | `.dws` has overly broad modes and is owned by the current user | Doctor reports `posix-mode`; second-confirmed repair sets directory `0700` and only diagnosed regular files `0600` |
| M-06 | `.dws` target is a symlink or owned by another account | Repair refuses before mutation; it never follows the link, invokes `sudo`, or invokes `chown` |
| M-07 | A nested sandbox runner is forced to fail | `sandbox-exec: sandbox_apply: Operation not permitted` is classified as infrastructure/runner failure, never missing CLI or bad credentials |
| M-08 | Child writes `$HOME` directly | Both shell and filesystem attempts fail while Broker-backed registered tools still pass |
| M-09 | Upgrade from installed `0.0.14` | Legacy trust becomes `outdated`; full Command-Q/relaunch loads `0.0.15` and asks for versioned consent once |
| M-10 | Packaged binary and compatibility | `darwin-arm64` binary hash/inventory checks and both supported DSH type/runtime lines pass for the packed artifact |

Logs retained for every desktop acceptance row must be redacted and contain only package/build,
operation, source, requested/resolved/actual mode, process-started, `sandboxDenied`, `runnerFailed`
and normalized error-class facts.

## 11. Verification matrix

This table is the review contract. A reviewer may not accept a requirement from prose alone.

| Requirement | Primary automated evidence | Required real evidence |
| --- | --- | --- |
| A-01..A-06 | `host-access-consent`, `host-environment-env`, `client-local-access`, browser check | WIN/MAC P-02..P-04, P-10..P-11; M-09 |
| B-01..B-09 | `host-access-broker`, existing Host integration tests, source guards | WIN/MAC P-05..P-09, P-14..P-15; W-02; M-01..M-04 |
| C-01..C-08 | `host-audit-policy`, root/spawn/lifecycle/prompt tests | WIN/MAC P-12..P-14; W-06; M-08 |
| D-01..D-08 | classifier, doctor and operation contract tests | WIN/MAC P-15..P-17; W-03..W-05; M-03, M-05..M-07 |
| E package contract | package, compatibility, CI workflow and pack assertions | WIN/MAC P-01, P-18; W-07; M-09..M-10 |

For every failed row, the implementation report must include:

- failing acceptance ID;
- exact installed package version and Host `builtAt`;
- operation name and source;
- requested/resolved/actual sandbox modes;
- `sandboxDenied` and `runnerFailed`;
- redacted error class and message;
- whether the failure occurred before or after process creation.

## 12. Explicit non-goals

- No profile-wide full-access switch.
- No general-purpose privileged shell RPC or Tool.
- No credentials exposed to model context.
- No automatic process termination or lock deletion.
- No manual edits to synchronized vendored skill files.
- No support for arbitrary user-supplied credential paths.
- No administrator requirement for normal operation.
- No release from the existing `v0.0.14` tag.

## 13. Completion definition

The feature is complete only when:

1. Subprojects A-D each pass their automated acceptance IDs.
2. The common installed-package matrix P-01 through P-18 is recorded as passed independently on
   Windows and macOS.
3. The Windows-native matrix W-01 through W-07 and macOS-native matrix M-01 through M-10 are
   recorded as passed.
4. The user has tested the installed builds and reviewed the source changes.
5. Full repository gates pass after the user test.
6. A final review finds no out-of-workspace integration that bypasses the Broker.
7. Only then is the release commit, push and `plugin-v0.0.15` tag authorized.


---

# Addendum · 2026-09-29 · 协议 19：审核 scope 绑定（第二轮复查）

> 本节由实现方追加，**不改动上文原文**。上文把沙箱边界写成"选定工作空间"，
> 第二轮复查确认那**不够**：一个工作空间里通常有很多案例目录，工作空间级边界让
> S1 的子会话可以读写 `<工作空间>/S2`（把别的案例的交付件传上 OSS、或往别的案例里写），
> 而氚云的 `objectId` / `fileId` 也完全由模型提交、Host 没有绑到本轮审核上。

## 收紧后的口径

1. **信任域是"本轮案例目录"，不是"工作空间"**。案例内 Tool 的判据从"包含于工作空间"
   改成"与 Host 记录的 `casePath` **规范解析后精确相等**"（`resolve` 后的规范目标；
   Windows 盘符/UNC 按风格大小写不敏感，POSIX 大小写敏感）。工作空间根、兄弟案例、
   案例目录的子目录一律拒绝；`seqNo` / `objectId` 必须与本轮记录一致；调用者没有 Agent 身份、
   不在进行中的审核里、记录已结束、或 scope 字段不完整，一律 fail closed。
2. **scope 由 Host 在创建记录时写死并落盘**：`casePath`（`<工作空间>/<流水号>`）、`attemptId`、
   `allowedAttachmentIds`（来自可信输入快照）。调用方之后**使用 Host 返回的路径**，
   不再使用模型提交的字符串。
3. **氚云标识不再是模型可自由指定的输入**：`crwu_h3yun_record_get` / `files_list` 移出
   审核子会话的能力集（本轮记录已由 `crwu_audit_case_bootstrap` 取进快照），审核子会话调用即拒绝
   且零进程；`crwu_h3yun_file_get` 只接受快照里登记的 `fileId`。
4. **真正的写边界是案例目录**：审核根的 `meta.cwd` 与 `workspace-write.workspaceRoot`
   **都是**本轮案例目录，且回读核对；一条根只服务一个案例目录，工作空间级旧根判过期、不复用。
   顺序是硬要求：先建案例目录 → 再建根（占用门禁排在最前，被拒的发起零副作用）。
5. **协议 18 → 19**：这是跨进程权限语义变化，旧宿主仍按工作空间级边界跑审核，
   必须靠协议号把"界面新、宿主旧"拦下来。

## 对验收矩阵的影响

- **P-12**：⑧ 上显示的边界与 cwd 必须是本轮案例目录。
- **P-13**：越界写要验**两种** —— 工作空间之外，以及**同工作空间的兄弟案例**。
- **C-05**：兄弟案例那一条只能真机证明（单元测试只证得了判据与设置）。

## 未由本改动解决

- 通用 shell / fs 的**读**范围仍由 DSH 沙箱决定；本次只把**写**边界收到案例目录。
- 同一条报告的重启语义、OSS 前缀与钉钉归档目标未变。
