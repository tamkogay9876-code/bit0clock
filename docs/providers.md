# Providers

mediaXG supports OpenAI-compatible, Anthropic-compatible, and xKiro providers.

## Connecting

```
/connect <provider> --key-env <ENV_VAR>
/connect <provider> --key <secret>   # avoid in terminals that retain command history
```

Credential references resolve from environment variables first, then from
`~/.config/mediaxg/credentials.json`, written with mode `0600` where supported.
The file store is not encrypted, and OS keychain integration is not currently
implemented. Secrets are never logged or written to session files.

## Model discovery

`/models` lists discovered models per provider (with caching and staleness
flags). `/model <id>` selects. mediaXG never infers context limits from model
names; limits come from the provider catalog or are labeled unknown.

## Cost

Costs are always local estimates from the cached pricing snapshot, labeled
"estimated". Unknown components are reported, never zero-costed.
