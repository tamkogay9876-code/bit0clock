/**
 * Reasoning and response-shaping commands:
 *   /think (aliases /thinking, /thinks), /response, /temperature, /output-limit.
 *
 * Configuration intent is always retained. When the active model cannot
 * honor a control, the command says so — it never silently pretends the
 * setting is active.
 */

import type { AppState } from '../../app/state.js';
import type { CatalogEntry } from '../../models/catalog.js';
import type { ReasoningEffort, ResponseStyle } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { parseTokenCount } from '../format.js';

const EFFORT_LEVELS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max', 'auto'];
const RESPONSE_STYLES: ResponseStyle[] = ['concise', 'balanced', 'detailed'];

export function createReasoningCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'think',
      aliases: ['thinking', 'thinks'],
      category: 'reasoning',
      description: 'Control reasoning effort (and optional token budget)',
      usage: '/think [off|low|medium|high|max|auto] | /think budget <tokens|off>',
      subcommands: [
        {
          name: 'budget',
          usage: '/think budget <tokens|off>',
          description: 'Set or clear the explicit reasoning token budget',
        },
        {
          name: 'level',
          usage: '/think <off|low|medium|high|max|auto>',
          description: 'Set the reasoning effort level',
        },
      ],
      examples: ['/think', '/think high', '/think budget 8192', '/think auto'],
      handler: ({ args }): CommandResult => {
        const sub = args[0];

        if (!sub) {
          return showReasoning(app);
        }

        if (sub === 'budget') {
          const raw = args[1];
          if (!raw) {
            return { ok: false, error: 'Usage: /think budget <tokens> | /think budget off' };
          }
          if (raw === 'off') {
            delete app.session.reasoning.budgetTokens;
            app.saveSession();
            return {
              ok: true,
              output: 'Reasoning budget removed (provider default will be used).',
            };
          }
          const tokens = parseTokenCount(raw);
          if (tokens === null || tokens < 128) {
            return {
              ok: false,
              error: `Invalid budget: ${raw}. Provide a token count (e.g. 4096, 32k) of at least 128.`,
            };
          }
          app.session.reasoning.budgetTokens = tokens;
          app.saveSession();
          return {
            ok: true,
            output:
              `Reasoning budget: ${tokens} tokens (applies to Anthropic-dialect thinking; ` +
              `other dialects may ignore it).`,
          };
        }

        if (!EFFORT_LEVELS.includes(sub as ReasoningEffort)) {
          return {
            ok: false,
            error: `Unknown reasoning level: ${sub}. Choose one of: ${EFFORT_LEVELS.join(', ')}.`,
          };
        }

        const level = sub as ReasoningEffort;
        app.session.reasoning.effort = level;
        app.saveSession();

        const notes: string[] = [`Reasoning effort: ${level}`];
        notes.push(...modelReasoningNotes(app, level));
        return { ok: true, output: notes.join('\n') };
      },
    },

    {
      name: 'response',
      category: 'reasoning',
      description: 'Set the response style (concise, balanced, detailed)',
      usage: '/response [concise|balanced|detailed]',
      examples: ['/response', '/response concise'],
      handler: ({ args }): CommandResult => {
        const style = args[0];
        if (!style) {
          return {
            ok: true,
            output:
              `Response style: ${app.session.responseStyle}\n` +
              `Choose one of: ${RESPONSE_STYLES.join(', ')}.`,
          };
        }
        if (!RESPONSE_STYLES.includes(style as ResponseStyle)) {
          return {
            ok: false,
            error: `Unknown response style: ${style}. Choose one of: ${RESPONSE_STYLES.join(', ')}.`,
          };
        }
        app.session.responseStyle = style as ResponseStyle;
        app.saveSession();
        return { ok: true, output: `Response style: ${style}` };
      },
    },

    {
      name: 'temperature',
      category: 'reasoning',
      description: 'Set the sampling temperature (0–2), or "default" to unset',
      usage: '/temperature [0..2|default]',
      examples: ['/temperature 0.2', '/temperature default'],
      handler: ({ args }): CommandResult => {
        const raw = args[0];
        if (!raw) {
          return {
            ok: true,
            output: `Temperature: ${app.session.temperature !== undefined ? app.session.temperature : 'provider default'}`,
          };
        }
        if (raw === 'default' || raw === 'unset') {
          delete app.session.temperature;
          app.saveSession();
          return { ok: true, output: 'Temperature: provider default' };
        }

        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 2) {
          return {
            ok: false,
            error: `Invalid temperature: ${raw}. Provide a number between 0 and 2, or "default".`,
          };
        }

        app.session.temperature = value;
        app.saveSession();

        const notes: string[] = [`Temperature: ${value}`];
        const providerType = activeProviderType(app);
        if (providerType === 'anthropic-compatible' || providerType === 'xkiro') {
          if (app.session.reasoning.effort !== 'off') {
            notes.push(
              'Note: Anthropic-dialect providers require temperature 1 while extended thinking is enabled — ' +
                'the value is kept but may be ignored for this request.',
            );
          }
        }
        return { ok: true, output: notes.join('\n') };
      },
    },

    {
      name: 'output-limit',
      category: 'reasoning',
      description: 'Set the maximum output tokens per response, or "default" to unset',
      usage: '/output-limit [tokens|default]',
      examples: ['/output-limit 8192', '/output-limit default'],
      handler: ({ args }): CommandResult => {
        const raw = args[0];
        if (!raw) {
          return {
            ok: true,
            output: `Output limit: ${app.session.outputLimit !== undefined ? `${app.session.outputLimit} tokens` : 'provider default'}`,
          };
        }
        if (raw === 'default' || raw === 'unset') {
          delete app.session.outputLimit;
          app.saveSession();
          return { ok: true, output: 'Output limit: provider default' };
        }

        const tokens = parseTokenCount(raw);
        if (tokens === null || tokens < 16) {
          return {
            ok: false,
            error: `Invalid output limit: ${raw}. Provide a token count (e.g. 4096, 32k).`,
          };
        }

        app.session.outputLimit = tokens;
        app.saveSession();

        const notes: string[] = [`Output limit: ${tokens} tokens`];
        const entry = activeCatalogEntry(app);
        if (entry?.maxOutputTokens !== undefined && tokens > entry.maxOutputTokens) {
          notes.push(
            `Warning: ${entry.id} reports a maximum output of ${entry.maxOutputTokens} tokens; ` +
              `the effective limit will be capped by the provider.`,
          );
        }
        return { ok: true, output: notes.join('\n') };
      },
    },
  ];
}

// ============================================================================
// Helpers
// ============================================================================

function activeCatalogEntry(app: AppState): CatalogEntry | undefined {
  const active = app.activeModel();
  if (!active) return undefined;
  return app.catalog.findModel(active.modelId, [active.providerId]);
}

function activeProviderType(app: AppState): string | undefined {
  const active = app.activeModel();
  if (!active) return undefined;
  return app.getProviderConfig(active.providerId)?.type;
}

function showReasoning(app: AppState): CommandResult {
  const reasoning = app.session.reasoning;
  const lines: string[] = [
    `Reasoning effort: ${reasoning.effort}` +
      (reasoning.budgetTokens !== undefined ? ` (budget ${reasoning.budgetTokens} tokens)` : ''),
  ];
  lines.push(...modelReasoningNotes(app, reasoning.effort));
  lines.push(`Levels: ${EFFORT_LEVELS.join(', ')}. Budget: /think budget <tokens>.`);
  return { ok: true, output: lines.join('\n') };
}

/**
 * Honest notes about whether the active model honors the requested level.
 * Intent is retained; the note explains the discrepancy.
 */
function modelReasoningNotes(app: AppState, level: ReasoningEffort): string[] {
  const active = app.activeModel();
  if (!active) {
    return ['No model selected — setting saved and will apply once a model is chosen.'];
  }

  const entry = activeCatalogEntry(app);
  if (!entry) {
    return [
      'Capabilities unknown for the active model — the provider will apply its default handling.',
    ];
  }

  const notes: string[] = [];

  if (entry.reasoning === false) {
    notes.push(
      `Note: ${entry.id} is not reported as a reasoning model — the setting is kept but inactive.`,
    );
    return notes;
  }

  if (entry.reasoningLevels && entry.reasoningLevels.length > 0) {
    if (level !== 'auto' && !entry.reasoningLevels.includes(level)) {
      notes.push(
        `Note: ${entry.id} reports levels [${entry.reasoningLevels.join(', ')}]; ` +
          `"${level}" may be adjusted by the gateway.`,
      );
    }
    if (entry.reasoningDefault && level === 'auto') {
      notes.push(`Model default level: ${entry.reasoningDefault}.`);
    }
  }

  return notes;
}
