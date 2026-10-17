# Configuration

Configuration is JSON, validated with Zod. Two scopes:

- Project: `.mediaxg/config.json`
- User: `~/.config/mediaxg/config.json`

Project overrides user key-by-key for known sections; defaults fill the rest.
A malformed file is rejected as a whole with a warning — defaults are used and
nothing is silently half-applied.

## Sections

- `defaultProvider`, `defaultModel`
- `providers` (endpoints, credential references)
- `contextProfiles`, `contextEngine`
- `reasoningDefaults`
- `spendingLimits`
- `permissionRules`
- `mcpServers`
- `skillsPaths`, `skillsSettings` (enabled, trustedPaths, maxFiles)
- `agentLoopLimits`
- `logging`
- `sessionStorage`
- `outputRendering`
- `featureFlags`

## Partial files

User/project files may contain only the keys to change. They are validated
against a deep-partial schema, merged, then re-validated against the full
schema. See `mergeConfigSources` in `src/config/schema.ts`.

## Migration

Config has a `version` field; `ConfigManager.migrate()` upgrades older
versions without destroying user configuration.
