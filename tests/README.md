# Cross-package tests

Use this directory for black-box tests that cross Go package boundaries:

- `contract/` verifies stable MCP tool names and schemas.
- `integration/` verifies configured external-system adapters.

Ordinary Go unit tests remain beside the packages they exercise. Contract and
integration directories will be created with their first runnable tests.
