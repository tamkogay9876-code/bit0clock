/**
 * Model commands: /models, /model.
 */

import type { AppState } from '../../app/state.js';
import type { CatalogEntry } from '../../models/catalog.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { formatTokens, shortenId } from '../format.js';

const MAX_LISTED = 40;

export function createModelCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'models',
      category: 'models',
      description: 'Browse, filter, and refresh the model catalog',
      usage: '/models [list|all|provider <id>|refresh [id]|info <model>] [--list]',
      subcommands: [
        { name: 'list', description: 'Interactive model picker (or a list with --list)' },
        { name: 'all', description: 'List cached models across all configured providers' },
        { name: 'provider <id>', description: 'List models of one provider' },
        { name: 'refresh [id]', description: 'Force a model discovery call (network)' },
        { name: 'info <model>', description: 'Show capabilities, limits, and pricing for a model' },
      ],
      examples: [
        '/models',
        '/models all',
        '/models refresh xkiro',
        '/models info xkiro/example-model',
      ],
      handler: async ({ args, flags }): Promise<CommandResult> => {
        const sub = args[0];

        if (sub === 'all') return listAll(app);
        if (sub === 'provider') return listProvider(app, args[1]);
        if (sub === 'refresh') return refreshModels(app, args[1]);
        if (sub === 'info') return modelInfo(app, args[1]);
        if (sub === 'list' || sub === undefined)
          return listInteractive(app, flags['list'] === true);

        return {
          ok: false,
          error: `Unknown subcommand: /models ${sub}. Usage: /models [list|all|provider <id>|refresh [id]|info <model>]`,
        };
      },
    },

    {
      name: 'model',
      category: 'models',
      description: 'Select the active model (provider/model or a unique suffix)',
      usage: '/model <model>',
      examples: ['/model xkiro/vendor/model-name', '/model vendor/model-name'],
      handler: ({ args }): CommandResult => {
        const reference = args.join(' ').trim();
        if (!reference) {
          const active = app.activeModel();
          if (!active) {
            return {
              ok: false,
              error: 'No model selected. Usage: /model <model>. Browse with /models.',
            };
          }
          return { ok: true, output: `Active model: ${active.providerId}/${active.modelId}` };
        }

        const resolution = app.resolveModel(reference);

        if (resolution.kind === 'not-found') {
          return {
            ok: false,
            error:
              `Model not found: ${reference}\n` +
              `Run /models refresh to discover models, or /models all to list what is known.`,
          };
        }

        if (resolution.kind === 'ambiguous') {
          const lines = [`Multiple models match "${reference}" — be more specific:`, ''];
          for (const candidate of resolution.candidates) {
            lines.push(`  ${candidate.providerId}/${candidate.id}`);
          }
          return { ok: false, error: lines.join('\n') };
        }

        app.selectModel(resolution.providerId, resolution.modelId);
        const entry = resolution.entry;
        const notes: string[] = [`Active model: ${resolution.providerId}/${resolution.modelId}`];
        if (entry?.contextLength !== undefined) {
          notes.push(
            `Context window (provider-reported): ${formatTokens(entry.contextLength)} tokens`,
          );
        } else {
          notes.push('Context window: unknown (provider did not report one)');
        }
        if (entry?.capabilitySource === 'manual') {
          notes.push(
            'Note: this model comes from manual configuration and is not verified with a live call.',
          );
        }
        return { ok: true, output: notes.join('\n') };
      },
    },
  ];
}

// ============================================================================
// Handlers
// ============================================================================

function listInteractive(app: AppState, forceList: boolean): CommandResult {
  const output = buildAllList(app);
  if (forceList) return { ok: true, output };

  return {
    ok: true,
    output,
    action: { type: 'open-model-picker' },
  };
}

function listAll(app: AppState): CommandResult {
  return { ok: true, output: buildAllList(app) };
}

async function listProvider(app: AppState, providerId: string | undefined): Promise<CommandResult> {
  if (!providerId) {
    return { ok: false, error: 'Usage: /models provider <id>' };
  }

  const provider = app.getProviderConfig(providerId);
  if (!provider) {
    return {
      ok: false,
      error:
        `Provider not configured: ${providerId}\n` +
        `Configured providers: ${app.config.providers.map((p) => p.id).join(', ') || '(none — run /connect)'}`,
    };
  }

  const result = await app.refreshModels(providerId);
  const lines: string[] = [];
  lines.push(`Models for ${providerId} (${result.models.length}):`);
  lines.push(describeSource(result.fromCache, result.stale, result.fetchedAt));
  if (result.refreshError) lines.push(`Refresh error: ${result.refreshError}`);
  lines.push('');

  for (const model of result.models.slice(0, MAX_LISTED)) {
    lines.push(`  ${formatEntryLine(model)}`);
  }
  if (result.models.length > MAX_LISTED) {
    lines.push(`  … and ${result.models.length - MAX_LISTED} more`);
  }

  return { ok: true, output: lines.join('\n') };
}

async function refreshModels(
  app: AppState,
  providerId: string | undefined,
): Promise<CommandResult> {
  const providers = providerId
    ? app.config.providers.filter((p) => p.id === providerId)
    : app.enabledProviders();

  if (providerId && providers.length === 0) {
    return {
      ok: false,
      error:
        `Provider not configured or disabled: ${providerId}\n` +
        `Configured providers: ${app.config.providers.map((p) => p.id).join(', ') || '(none — run /connect)'}`,
    };
  }
  if (providers.length === 0) {
    return { ok: false, error: 'No enabled providers. Run /connect to add one.' };
  }

  const lines: string[] = ['Model discovery:', ''];
  let failures = 0;

  for (const provider of providers) {
    const result = await app.refreshModels(provider.id, true);
    if (result.refreshError) {
      failures++;
      lines.push(
        `  ${provider.id}: FAILED — ${result.refreshError}` +
          (result.models.length > 0 ? ` (showing ${result.models.length} cached model(s))` : ''),
      );
    } else {
      lines.push(
        `  ${provider.id}: ${result.models.length} model(s) discovered` +
          (result.stale ? ' (marked stale)' : ''),
      );
    }
  }

  if (failures > 0) {
    lines.push('');
    lines.push('Some refreshes failed. Cached data is shown where available.');
  }

  return { ok: failures === 0, output: lines.join('\n') };
}

function modelInfo(app: AppState, reference: string | undefined): CommandResult {
  if (!reference) {
    return { ok: false, error: 'Usage: /models info <model>' };
  }

  const resolution = app.resolveModel(reference);

  if (resolution.kind === 'not-found') {
    return {
      ok: false,
      error: `Model not found: ${reference}\nRun /models refresh to discover models first.`,
    };
  }

  if (resolution.kind === 'ambiguous') {
    const lines = [`Multiple models match "${reference}":`, ''];
    for (const candidate of resolution.candidates) {
      lines.push(`  ${candidate.providerId}/${candidate.id}`);
    }
    return { ok: true, output: lines.join('\n') };
  }

  const { providerId, modelId, entry } = resolution;
  if (!entry) {
    return {
      ok: true,
      output:
        `${providerId}/${modelId}\n` +
        'Not present in the catalog (capabilities unknown). ' +
        'The model can still be selected explicitly; run /models refresh to try discovery.',
    };
  }

  const lines: string[] = [`${entry.providerId}/${entry.id}`, ''];
  lines.push(`  display name      ${entry.displayName}`);
  lines.push(`  capabilities from ${entry.capabilitySource}`);
  lines.push(`  verified          ${entry.verified ? 'yes (live call succeeded)' : 'no'}`);
  lines.push(
    `  context window    ${entry.contextLength !== undefined ? `${entry.contextLength} tokens (${formatTokens(entry.contextLength)})` : 'unknown (not reported)'}`,
  );
  lines.push(
    `  max output        ${entry.maxOutputTokens !== undefined ? `${entry.maxOutputTokens} tokens` : 'unknown'}`,
  );
  lines.push(`  tools / vision    ${flag(entry.tools)} / ${flag(entry.vision)}`);
  lines.push(
    `  reasoning         ${flag(entry.reasoning)}${entry.reasoningLevels ? ` (levels: ${entry.reasoningLevels.join(', ')}${entry.reasoningDefault ? `; default: ${entry.reasoningDefault}` : ''})` : ''}`,
  );
  if (entry.accessTier) lines.push(`  access tier       ${entry.accessTier}`);
  if (entry.discoveredAt) lines.push(`  discovered at     ${entry.discoveredAt}`);
  if (entry.pricing) {
    const p = entry.pricing;
    const parts: string[] = [];
    if (p.inputPerMillion !== undefined) parts.push(`input $${p.inputPerMillion}/M`);
    if (p.outputPerMillion !== undefined) parts.push(`output $${p.outputPerMillion}/M`);
    if (p.cachedInputPerMillion !== undefined)
      parts.push(`cached input $${p.cachedInputPerMillion}/M`);
    lines.push(
      `  pricing           ${parts.length > 0 ? parts.join(', ') : 'unknown'} (${p.currency}, from ${p.source})`,
    );
  } else {
    lines.push('  pricing           unknown (provider did not report pricing)');
  }

  return { ok: true, output: lines.join('\n') };
}

// ============================================================================
// Helpers
// ============================================================================

function flag(value: boolean | undefined): string {
  if (value === undefined) return 'unknown';
  return value ? 'yes' : 'no';
}

function describeSource(fromCache: boolean, stale: boolean, fetchedAt?: string): string {
  if (!fromCache) return `Source: live discovery (${fetchedAt ?? 'just now'})`;
  return `Source: cache from ${fetchedAt ?? 'unknown'}${stale ? ' — STALE, data may be outdated' : ''}`;
}

function formatEntryLine(model: CatalogEntry): string {
  const flags: string[] = [];
  if (model.tools === true) flags.push('tools');
  if (model.vision === true) flags.push('vision');
  if (model.reasoning === true) flags.push('reasoning');
  if (model.accessTier) flags.push(model.accessTier);
  if (model.capabilitySource === 'manual') flags.push('manual');

  const ctx =
    model.contextLength !== undefined ? `ctx ${formatTokens(model.contextLength)}` : 'ctx ?';
  const suffix = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
  return `${model.id.padEnd(46)} ${ctx}${suffix}`;
}

/** Build the multi-provider list used by /models and pickers. */
function buildAllList(app: AppState): string {
  const providers = app.enabledProviders();
  if (providers.length === 0) {
    return (
      'No providers connected.\n' +
      'Run /connect for the interactive wizard, or /connect xkiro --key-env XKIRO_API_KEY.'
    );
  }

  const lines: string[] = [];
  const active = app.activeModel();
  let totalModels = 0;

  for (const provider of providers) {
    const cached = app.catalog.getCached(provider.id, provider.models);
    lines.push(
      `${provider.id} (${provider.type}) — ${
        cached
          ? `${cached.models.length} model(s), fetched ${cached.fetchedAt ?? 'unknown'}${cached.stale ? ' [STALE]' : ''}`
          : 'not discovered yet — run /models refresh ' + provider.id
      }`,
    );

    if (cached) {
      totalModels += cached.models.length;
      for (const model of cached.models.slice(0, MAX_LISTED)) {
        const marker =
          active && active.providerId === provider.id && active.modelId === model.id ? '* ' : '  ';
        lines.push(`${marker}${formatEntryLine(model)}`);
      }
      if (cached.models.length > MAX_LISTED) {
        lines.push(`  … and ${cached.models.length - MAX_LISTED} more`);
      }
    }
    lines.push('');
  }

  if (totalModels > 0) {
    lines.push('* = active model. Select with /model <model>, details with /models info <model>.');
  }
  lines.push(`Session: ${shortenId(app.session.id)} — ${app.session.name}`);

  return lines.join('\n').trimEnd();
}
