# MCP

MCP servers are managed behind an internal interface (`McpClientLike`); the
SDK is imported only in `src/mcp/client.ts`.

## Transports

- Streamable HTTP
- stdio (env = SDK default environment + config env; stderr consumed
  line-by-line)

## Configuration

Servers are added disabled by default:

```
/mcp add context7 https://mcp.context7.com/mcp
/mcp add xkiro-web https://api.xkiro.com/mcp/web --auth=bearer --credential=XKIRO_API_KEY
```

Secrets never live in the config file — only credential references. Store
secrets with `/mcp auth <name> <secret>`.

## Security

- URLs with secret-looking query parameters or userinfo are rejected.
- `oauth` auth type is not implemented (honest error).
- Tool arguments validated with ajv before any call.
- Timeouts and output caps (100k chars) enforced.
- Tool output wrapped as untrusted data.
- Permission class `mcp`, `mutating: true`: plan/review modes never see MCP
  tools; every call passes the permission engine.
- `/mcp remove` requires `--yes`.

## Commands

`/mcp list|add|show|test|enable|disable|remove|tools|resources|prompts|permissions|auth|logs`
