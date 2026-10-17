# Limitations

- xKiro is not verified without a real successful test; `/budget balance`
  reports unknown shapes without inventing values.
- No claim of perfect sandboxing: the workspace guard and permission engine
  reduce risk but are not a kernel-level sandbox.
- OS credential storage is used when available; the fallback is documented
  and not claimed secure.
- SQLite session storage is not implemented (JSON store with migrations and
  corruption handling is used).
- Plugin marketplace is not implemented; extension points exist but are
  internal.
- Image inputs are not supported.
- Windows is unverified.
- `oauth` MCP auth is not implemented.
- Skills `allowed-tools` is never honored as pre-approval.
- Prettier formatting is enforced; 93 pre-existing style issues were
  resolved in Phase H.
