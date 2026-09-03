# H3Yun DingTalk Login Implementation Plan

**Goal:** Deliver the smallest end-to-end `crwu h3y login` flow that authenticates
an employee through DingTalk, returns an explicit employee identity, and stores
only a CRWU session in the operating system credential store.

## Boundaries

- DingTalk is the only employee login provider.
- The CLI never receives or stores the DingTalk application secret, DingTalk
  access token, H3Yun EngineSecret, or any other provider credential.
- A successful login identifies the employee by DingTalk `corpId`, `unionId`,
  and `openId`. Exact H3Yun user mapping is the next authorization step and is
  not silently replaced with a system identity.
- WorkBuddy and DeepSeek Harness remain outer adapters. The login application
  service and HTTP protocol do not depend on either host.

## Minimal vertical slice

1. Add a canonical `h3y login` command with English scheme metadata and
   machine-readable JSON output support.
2. Add a host-neutral login application service that starts a server flow,
   opens the authorization URL, polls for completion, and saves the returned
   CRWU session through an interface.
3. Add a CRWU auth HTTP client used by the CLI.
4. Add a DingTalk OAuth client that builds the authorization URL, exchanges the
   one-time code, and fetches the authenticated employee profile.
5. Add `crwu-server` with in-memory flow/session storage for the first live
   test. It validates one-time state, limits flow lifetime, and never returns a
   DingTalk token to the CLI.
6. Store the opaque CRWU session using macOS Keychain, Windows Credential
   Manager, or the Linux Secret Service through the OS keyring adapter.
7. Document the environment variables and exact live-test procedure.

## Verification

- Unit-test login orchestration, OAuth request/response handling, callback state
  validation, session persistence, CLI output, and scheme metadata.
- Run `go test ./...`, build both binaries, inspect `crwu scheme`, and exercise
  the local HTTP flow with a fake DingTalk endpoint.
- A real DingTalk login requires a DingTalk internal application, its callback
  URL, Client ID, Client Secret, and Corp ID configured only on `crwu-server`.
