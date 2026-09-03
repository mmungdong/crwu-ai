# Internal Go packages

All non-public Go implementation belongs under `internal/`. Package boundaries
follow dependency direction rather than provider deployment names:

```text
transport -> app -> integrations
```

Transport packages must not call provider HTTP clients directly. Integration
packages must not import transports or sibling provider integrations.

Directories are populated only when working behavior needs them; their READMEs
record the agreed boundary without creating placeholder Go packages.
