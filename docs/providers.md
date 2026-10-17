# Providers

mediaXG supports OpenAI-compatible, Anthropic-compatible, and xKiro providers.

## Connecting

```
/connect <provider> --key-env <ENV_VAR>
/connect <provider> --key <secret>   # stored in the credential store
```

Credentials are stored in the OS credential store when available, otherwise in
the documented fallback (file with 0600 permissions). Secrets are never logged
or written to session files.

## Model discovery

`/models` lists discovered models per provider (with caching and staleness
flags). `/model <id>` selects. mediaXG never infers context limits from model
names; limits come from the provider catalog or are labeled unknown.

## Cost

Costs are always local estimates from the cached pricing snapshot, labeled
"estimated". Unknown components are reported, never zero-costed.
