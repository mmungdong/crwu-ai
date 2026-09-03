# Runtime configuration

This directory will own loading and validation of typed runtime configuration.
It may supply validated settings to transports and integrations, but it must not
contain business workflows or provider API clients.

Committed configuration is limited to non-secret examples under `configs/`.
