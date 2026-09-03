# External-system integrations

Provider-specific clients live here as sibling packages:

```text
integrations/
├── h3yun/
└── dingtalk/
```

Each integration owns its HTTP client, provider authentication mechanisms,
wire DTOs, pagination details, and provider error translation. One integration
must not import another. Shared workflows are expressed in `internal/app`
through narrow interfaces.

The provider packages will be created with their first executable use cases;
this directory currently records their boundary only.
