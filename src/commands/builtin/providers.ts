/**
 * Provider commands: /provider, /connect, /disconnect, /auth.
 */

import type { AppState } from '../../app/state.js';
import {
  connectProvider,
  credentialRefFor,
  disconnectProvider,
  type ConnectResult,
} from '../../app/connect.js';
import { describeCredential } from '../../credentials/index.js';
import type { ProviderType } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { formatPairs } from '../format.js';

const PROVIDER_TYPES: ProviderType[] = ['xkiro', 'openai-compatible', 'anthropic-compatible'];

export function createProviderCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'provider',
      category: 'providers',
      description: 'Show the active provider and configured providers',
      usage: '/provider [list|status]',
      subcommands: [
        { name: 'list', description: 'List configured providers with credential status' },
        { name: 'status', description: 'Validate credentials with a live call (network)' },
      ],
      examples: ['/provider', '/provider list', '/provider status'],
      availableDuringGeneration: true,
      handler: async ({ args }): Promise<CommandResult> => {
        const sub = args[0];

        if (sub === 'status') {
          return providerStatus(app);
        }

        if (sub === 'list' || sub === undefined) {
          return providerList(app);
        }

        return {
          ok: false,
          error: `Unknown subcommand: /provider ${sub}. Usage: /provider [list|status]`,
        };
      },
    },

    {
      name: 'connect',
      category: 'providers',
      description: 'Connect a provider (validates credentials before saving)',
      usage:
        '/connect [xkiro|openai-compatible|anthropic-compatible|provider-id] [--key-env VAR] [--api-key KEY] [--base-url URL] [--id ID] [--protocol openai-chat|anthropic-messages]',
      examples: [
        '/connect',
        '/connect xkiro --key-env XKIRO_API_KEY',
        '/connect openai-compatible --id local --base-url http://localhost:8080/v1',
      ],
      handler: async ({ args, flags }): Promise<CommandResult> => {
        const target = args[0];

        // No target: interactive wizard (TUI) — the wizard collects the details
        if (!target) {
          return {
            ok: true,
            action: { type: 'open-connect-wizard' },
            output: 'Opening the connection wizard…',
          };
        }

        // Existing provider id (enabled or disabled): re-enable with validation
        const existing = app.getProviderConfig(target);
        if (existing) {
          if (existing.enabled) {
            return {
              ok: true,
              output:
                `Provider "${target}" is already connected and enabled.\n` +
                `Use /models refresh ${target} to refresh its model list, or /disconnect ${target} to disable it.`,
            };
          }

          const result = await connectProvider(app, {
            providerType: existing.type,
            id: existing.id,
            baseUrl: existing.baseUrl,
            protocol: existing.protocol,
            authStyle: existing.authStyle,
            skipValidation: flags['no-validate'] === true,
          });

          // connectProvider rebuilds the config entry; restore credentialRef if it resolved from env
          return connectResultToCommandResult(result);
        }

        // Provider type: non-interactive connect using defaults + environment
        if (!PROVIDER_TYPES.includes(target as ProviderType)) {
          return {
            ok: false,
            error:
              `Unknown provider: "${target}".\n` +
              `Known providers: ${app.config.providers.map((p) => p.id).join(', ') || '(none configured)'}\n` +
              `Provider types: ${PROVIDER_TYPES.join(', ')}\n` +
              `Run /connect without arguments for the interactive wizard.`,
          };
        }

        const providerType = target as ProviderType;
        const request: Parameters<typeof connectProvider>[1] = { providerType };

        // Support both `--key=value` and `--key value` forms. Space-separated
        // values arrive as positionals after the target and are consumed in order.
        const extras = args.slice(1);
        let extraIndex = 0;
        const flagValue = (name: string): string | undefined => {
          const value = flags[name];
          if (typeof value === 'string') return value;
          if (value === true && extraIndex < extras.length) return extras[extraIndex++];
          return undefined;
        };

        const idFlag = flagValue('id');
        if (idFlag !== undefined) request.id = idFlag;
        const baseUrlFlag = flagValue('base-url');
        if (baseUrlFlag !== undefined) request.baseUrl = baseUrlFlag;
        const keyEnvFlag = flagValue('key-env');
        if (keyEnvFlag !== undefined) request.apiKeyEnv = keyEnvFlag;
        const apiKeyFlag = flagValue('api-key');
        if (apiKeyFlag !== undefined) request.apiKey = apiKeyFlag;
        const protocolFlag = flagValue('protocol');
        if (protocolFlag === 'openai-chat' || protocolFlag === 'anthropic-messages') {
          request.protocol = protocolFlag;
        } else if (protocolFlag !== undefined) {
          return {
            ok: false,
            error: `Invalid --protocol value: ${protocolFlag}. Use openai-chat or anthropic-messages.`,
          };
        }
        if (flags['no-validate'] === true) request.skipValidation = true;

        return connectResultToCommandResult(await connectProvider(app, request));
      },
    },

    {
      name: 'disconnect',
      category: 'providers',
      description: 'Disable a provider (or remove it entirely with --forget)',
      usage: '/disconnect <provider-id> [--forget] [--yes]',
      examples: ['/disconnect xkiro', '/disconnect xkiro --forget --yes'],
      handler: async ({ args, flags }): Promise<CommandResult> => {
        const providerId = args[0];
        if (!providerId) {
          return { ok: false, error: 'Usage: /disconnect <provider-id> [--forget] [--yes]' };
        }

        const provider = app.getProviderConfig(providerId);
        if (!provider) {
          return {
            ok: false,
            error:
              `Provider not configured: ${providerId}\n` +
              `Configured providers: ${app.config.providers.map((p) => p.id).join(', ') || '(none)'}`,
          };
        }

        const forget = flags['forget'] === true;
        if (forget && flags['yes'] !== true) {
          // Two-step confirmation before a destructive removal
          return {
            ok: true,
            output:
              `This removes the configuration for "${providerId}"` +
              (provider.credentialRef
                ? ` and its stored credential ("${provider.credentialRef}")`
                : '') +
              `.\nRe-run to confirm: /disconnect ${providerId} --forget --yes`,
          };
        }

        return connectResultToCommandResult(await disconnectProvider(app, providerId, { forget }));
      },
    },

    {
      name: 'auth',
      category: 'providers',
      description: 'Show credential status for each provider (never shows secrets)',
      usage: '/auth',
      availableDuringGeneration: true,
      handler: async (): Promise<CommandResult> => {
        if (app.config.providers.length === 0) {
          return { ok: true, output: 'No providers configured. Run /connect to add one.' };
        }

        const lines: string[] = ['Credential status (values are never displayed):', ''];

        for (const provider of app.config.providers) {
          const ref = provider.credentialRef ?? credentialRefFor(provider.id);
          const fromEnv = process.env[ref] !== undefined && process.env[ref] !== '';
          const value = await app.credentials.get(ref);
          const source = fromEnv
            ? 'environment variable'
            : value !== undefined
              ? 'file store (0600)'
              : 'none';

          lines.push(`${provider.id} (${provider.type})${provider.enabled ? '' : ' [disabled]'}`);
          lines.push(
            formatPairs([
              ['credential ref', ref],
              ['status', describeCredential(value)],
              ['source', source],
            ]),
          );
          lines.push('');
        }

        lines.push(
          'Note: the file store is a documented fallback, not secure storage. See README.',
        );
        return { ok: true, output: lines.join('\n').trimEnd() };
      },
    },
  ];
}

// ============================================================================
// Helpers
// ============================================================================

function connectResultToCommandResult(result: ConnectResult): CommandResult {
  const body = [result.message, ...result.warnings.map((w) => `Warning: ${w}`)].join('\n');
  return result.ok ? { ok: true, output: body } : { ok: false, error: body };
}

async function providerList(app: AppState): Promise<CommandResult> {
  if (app.config.providers.length === 0) {
    return {
      ok: true,
      output:
        'No providers configured.\nRun /connect for the interactive wizard, or /connect xkiro --key-env XKIRO_API_KEY.',
    };
  }

  const active = app.session.providerId;
  const lines: string[] = ['Configured providers:', ''];

  for (const provider of app.config.providers) {
    const ref = provider.credentialRef;
    const value = ref ? await app.credentials.get(ref) : undefined;
    const fromEnv = ref ? (process.env[ref] ?? '') !== '' : false;

    const markers: string[] = [];
    if (provider.id === active) markers.push('active');
    if (!provider.enabled) markers.push('disabled');

    lines.push(`  ${provider.id}${markers.length > 0 ? ` [${markers.join(', ')}]` : ''}`);
    lines.push(
      formatPairs(
        [
          ['type', provider.type],
          ['base url', provider.baseUrl],
          ['protocol', provider.protocol ?? 'default'],
          ['credential ref', ref ?? '(none — no key required)'],
          [
            'credential',
            value === undefined
              ? 'not set'
              : fromEnv
                ? `set via environment (${ref})`
                : 'set via file store',
          ],
        ],
        '      ',
      ),
    );
    lines.push('');
  }

  return {
    ok: true,
    output: lines.join('\n').trimEnd(),
  };
}

async function providerStatus(app: AppState): Promise<CommandResult> {
  const providers = app.config.providers;
  if (providers.length === 0) {
    return { ok: false, error: 'No providers configured. Run /connect first.' };
  }

  const lines: string[] = ['Provider status (live checks):', ''];
  let anyFailures = false;

  for (const provider of providers) {
    if (!provider.enabled) {
      lines.push(`  ${provider.id}: disabled — skipped`);
      continue;
    }

    try {
      const adapter = await app.getAdapter(provider.id);

      if (adapter.validateCredentials) {
        const result = await adapter.validateCredentials();
        if (result.ok) {
          lines.push(`  ${provider.id}: healthy — ${result.message}`);
        } else {
          anyFailures = true;
          lines.push(`  ${provider.id}: unavailable — ${result.message}`);
        }
      } else {
        lines.push(
          `  ${provider.id}: not verified — provider has no credential validation endpoint`,
        );
      }

      // Model discovery status (uses cache; a refresh is explicit via /models refresh)
      const cached = app.catalog.getCached(provider.id, provider.models);
      if (cached) {
        lines.push(
          `      models: ${cached.models.length} known, fetched ${cached.fetchedAt ?? 'unknown'}` +
            (cached.stale ? ' (STALE)' : ''),
        );
      } else {
        lines.push('      models: none cached — run /models refresh ' + provider.id);
      }
    } catch (err) {
      anyFailures = true;
      lines.push(`  ${provider.id}: unavailable — ${(err as Error).message}`);
    }
  }

  return { ok: !anyFailures, output: lines.join('\n') };
}
