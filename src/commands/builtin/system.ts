/**
 * System commands: /help, /status, /doctor, /exit, /clear, /cancel.
 */

import type { AppState } from '../../app/state.js';
import type { CommandRegistry } from '../registry.js';
import { runDoctor } from '../../diagnostics/index.js';
import { MODES } from '../../modes/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { formatMoney, formatRelative, formatTokens, shortenId } from '../format.js';

export function createSystemCommands(
  app: AppState,
  registry: CommandRegistry,
): CommandDefinition[] {
  return [
    {
      name: 'help',
      category: 'general',
      description: 'List commands or show detailed help for one command',
      usage: '/help [command]',
      examples: ['/help', '/help think'],
      availableDuringGeneration: true,
      handler: ({ args }): CommandResult => {
        return { ok: true, output: registry.help(args[0]) };
      },
    },

    {
      name: 'status',
      category: 'diagnostics',
      description: 'Show the current session, model, and usage state',
      usage: '/status',
      availableDuringGeneration: true,
      handler: (): CommandResult => {
        const lines: string[] = [];

        // Session
        lines.push('Session');
        lines.push(`  id            ${app.session.id}`);
        lines.push(`  name          ${app.session.name}`);
        lines.push(
          `  mode          ${MODES[app.session.mode].label} — ${MODES[app.session.mode].description}`,
        );
        lines.push(`  messages      ${app.session.messages.length}`);
        lines.push(`  project       ${app.session.projectPath}`);
        lines.push(`  updated       ${formatRelative(app.session.updatedAt)}`);
        if (app.session.interrupted) {
          lines.push('  interrupted   previous run ended mid-request');
        }
        lines.push('');

        // Model
        lines.push('Model');
        const active = app.activeModel();
        if (!active) {
          lines.push('  not selected — use /models to browse and /model <model> to select');
        } else {
          const provider = app.getProviderConfig(active.providerId);
          const entry = app.catalog.findModel(active.modelId, [active.providerId]);
          lines.push(
            `  provider      ${active.providerId}${provider ? ` (${provider.type})` : ''}`,
          );
          lines.push(`  model         ${active.modelId}`);
          lines.push(
            `  context window ${entry?.contextLength !== undefined ? `${formatTokens(entry.contextLength)} tokens` : 'unknown'}`,
          );
          const cached = provider ? app.catalog.getCached(provider.id, provider.models) : null;
          if (cached) {
            lines.push(
              `  catalog       fetched ${formatRelative(cached.fetchedAt ?? '')}${cached.stale ? ' (STALE)' : ''}`,
            );
          }
        }
        lines.push('');

        // Reasoning / response
        lines.push('Generation');
        const reasoning = app.session.reasoning;
        lines.push(
          `  thinking      ${reasoning.effort}${reasoning.budgetTokens !== undefined ? ` (budget ${reasoning.budgetTokens} tokens)` : ''}`,
        );
        lines.push(`  response      ${app.session.responseStyle}`);
        lines.push(
          `  temperature   ${app.session.temperature !== undefined ? app.session.temperature : 'provider default'}`,
        );
        lines.push(
          `  output limit  ${app.session.outputLimit !== undefined ? `${app.session.outputLimit} tokens` : 'provider default'}`,
        );
        lines.push('');

        // Context
        const profile = app.config.contextProfiles.find((p) => p.id === app.session.contextProfile);
        lines.push('Context');
        lines.push(
          `  profile       ${app.session.contextProfile}${profile ? ` (max ${profile.maxTokens > 0 ? `${formatTokens(profile.maxTokens)} tokens` : 'auto'})` : ' (unknown profile!)'}`,
        );
        if (app.session.requestedContext !== undefined) {
          lines.push(
            `  requested     ${formatTokens(app.session.requestedContext)} tokens (override)`,
          );
        }
        if (app.session.messages.length > 0) {
          lines.push(`  messages      ${app.session.messages.length} in history`);
        }
        lines.push('');

        // Usage
        const usage = app.session.usage;
        lines.push('Usage (this session)');
        lines.push(`  requests      ${usage.requests}`);
        lines.push(`  input         ${formatTokens(usage.inputTokens)} tokens`);
        lines.push(`  output        ${formatTokens(usage.outputTokens)} tokens`);
        if (usage.cachedInputTokens > 0) {
          lines.push(`  cached input  ${formatTokens(usage.cachedInputTokens)} tokens`);
        }
        if (usage.reasoningTokens > 0) {
          lines.push(`  reasoning     ${formatTokens(usage.reasoningTokens)} tokens`);
        }
        lines.push(
          `  cost          ${formatMoney(usage.estimatedCost, usage.currency)} (local estimate, not an invoice)`,
        );

        return { ok: true, output: lines.join('\n') };
      },
    },

    {
      name: 'doctor',
      category: 'diagnostics',
      description: 'Run environment and configuration diagnostics',
      usage: '/doctor',
      availableDuringGeneration: true,
      handler: async (): Promise<CommandResult> => {
        const report = await runDoctor(app.config);
        const lines: string[] = [`Overall: ${report.overall.toUpperCase()}`, ''];

        const labels: Record<string, string> = {
          healthy: 'OK',
          degraded: 'WARN',
          unavailable: 'FAIL',
          'not-configured': 'N/A',
          blocked: 'BLOCK',
        };

        for (const check of report.checks) {
          const label = labels[check.status] ?? check.status.toUpperCase();
          lines.push(`  [${label.padEnd(5)}] ${check.name}: ${check.message}`);
        }

        lines.push('');
        lines.push('Note: provider connectivity is checked with /provider status (live calls).');

        return { ok: true, output: lines.join('\n') };
      },
    },

    {
      name: 'clear',
      category: 'sessions',
      description: 'Clear the visible conversation (saved session metadata is kept)',
      usage: '/clear',
      handler: (): CommandResult => {
        const cleared = app.session.messages.length;
        app.session.messages = [];
        app.saveSession();
        return {
          ok: true,
          output: `Cleared ${cleared} message(s) from the conversation view.`,
          action: { type: 'clear-conversation' },
        };
      },
    },

    {
      name: 'cancel',
      category: 'general',
      description: 'Cancel the active generation',
      usage: '/cancel',
      availableDuringGeneration: true,
      handler: ({ flags }): CommandResult => {
        const result: CommandResult = { ok: true, action: { type: 'cancel-generation' } };
        if (flags['silent'] !== true) result.output = 'Cancelling…';
        return result;
      },
    },

    {
      name: 'exit',
      aliases: ['quit', 'q'],
      category: 'general',
      description: 'Exit mediaXG (sessions are saved)',
      usage: '/exit',
      availableDuringGeneration: true,
      handler: (): CommandResult => {
        return { ok: true, action: { type: 'exit' } };
      },
    },
  ];
}
