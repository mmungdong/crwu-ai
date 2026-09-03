# Domain Glossary

## Command

A named action supported by the `crwu` CLI. A command has one precise purpose
and a stable invocation.

## Scheme

The authoritative, machine-readable catalog of all supported commands. It tells
an AI client what each command does, how to invoke it, and provides at least one
accurate example.

## Example

An invocation that accurately demonstrates one supported use of a command,
paired with a concise English explanation of its purpose.

## Employee Principal

The explicit human employee on whose behalf CRWU acts. The first supported
principal is established by DingTalk `corpId`, `userId`, `unionId`, and
`openId`. An application credential or H3Yun engine credential is never an
employee principal.

## CRWU Session

A short-lived opaque credential issued by `crwu-server` after DingTalk verifies
an employee. The CLI stores this credential in the operating system credential
store. It contains no DingTalk Client Secret, DingTalk token, H3Yun EngineCode,
or H3Yun EngineSecret.

## H3Yun Identity Mapping

A fail-closed association from one explicit DingTalk employee principal to
exactly one H3Yun user. Authentication may succeed before this mapping exists,
but no H3Yun operation is authorized until the mapping is verified.
