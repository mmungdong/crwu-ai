# CLI Command Contract

This contract applies to every top-level `crwu` subcommand. Its primary consumer
is an AI client discovering and invoking the CLI through `crwu scheme`.

## Required command metadata

Every subcommand must be registered in the canonical command catalog and must
define all of these fields:

- `name`: the exact lowercase command name used after `crwu`.
- `description`: a specific English sentence describing the observable result.
- `usage`: the exact supported invocation beginning with `crwu <name>`.
- `examples`: one or more accurate invocations, each paired with a specific
  English description.

Descriptions such as "manage resources" or "perform an operation" are not
specific enough. State the object and observable action. Examples must match the
implemented parser and must not contain credentials, tokens, private endpoints,
or real organizational data.

A command is incomplete if any required field is absent, empty, inaccurate, or
not written in English.

## Scheme behavior

`crwu scheme` prints one JSON document to standard output:

```json
{
  "version": "0.0.1",
  "commands": [
    {
      "name": "version",
      "description": "Show the CLI version and build commit.",
      "usage": "crwu version",
      "examples": [
        {
          "description": "Show the installed crwu version.",
          "command": "crwu version"
        }
      ]
    }
  ]
}
```

The command catalog is the source of truth for both command discovery and help
generation. Do not maintain a second hard-coded command list.

Successful scheme output contains JSON only. Diagnostics go to standard error,
and failures return a non-zero exit status.

## Version

The current CLI version is `0.0.1`. Direct Go builds use this version by default.
The root Makefile may inject a different release version through its `VERSION`
variable, and `crwu version` and `crwu scheme` must report the injected value.

## Change checklist

When adding or changing a subcommand:

1. Register its name, English description, exact usage, and examples together.
2. Implement the command handler without provider logic in the CLI transport.
3. Test its observable output, error behavior, and exit status.
4. Run the scheme tests to confirm every command remains documented.
5. Run `make test` and inspect `crwu scheme` before release.
