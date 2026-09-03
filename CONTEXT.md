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

## Employee Session

The explicit employee on whose behalf CRWU acts. The session is the H3Yun web
session token the employee obtained by QR scanning at h3yun.com (or a H3Yun
personal access token for the agent channel), bound per machine in the local OS
credential store. An application credential or H3Yun engine credential is never
an employee identity.

## Credential Binding

The stored employee credential (see docs/design-h3yun-cli.md). It carries the
H3Yun engine, the H3Yun user id from the session claims, and the expiry. Every
H3Yun operation runs under the bound employee's permissions only.
