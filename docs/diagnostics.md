# Diagnostics

`/doctor` inspects configuration, dependencies, permissions, provider
connectivity, model discovery, MCP health, Skills validity, storage, and
required runtime capabilities.

Statuses: healthy, degraded, unavailable, not configured, not verified,
blocked by permission. A live integration is never labeled healthy from a
cached result alone.

Logs are structured, redacted, rotated by size, with configurable verbosity.
