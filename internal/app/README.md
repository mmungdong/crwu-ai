# Application services

This directory will contain use cases shared by MCP and CLI transports. An
application service coordinates narrow capabilities supplied by integrations
and returns provider-neutral results.

Application code must not contain MCP schemas, terminal formatting, HTTP
request details, or provider DTOs. Cross-provider workflows such as establishing
an H3Yun session from DingTalk identity belong here behind explicit interfaces.
