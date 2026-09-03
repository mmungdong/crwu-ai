# MCP transport

This directory will contain the MCP server bootstrap, tool definitions,
input/output schemas, and protocol error mapping.

MCP handlers call application services. They must not implement H3Yun or
DingTalk authentication, HTTP requests, or provider-specific persistence.
WorkBuddy is the only supported host, while the MCP protocol implementation
should avoid WorkBuddy-private coupling.
