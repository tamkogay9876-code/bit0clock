/**
 * /compact — conversation compaction with explicit preservation rules (§27).
 *
 * The summary is deterministic and extractive: requirements, constraints,
 * decisions, errors, pending work, modified files, test results, tool
 * outputs, and risks are quoted or taken from real session state. Nothing
 * is invented, and the summary states its own limits.
 *
 * With contextEngine.preserveOriginalHistory (default on), the original
 * messages of each compacted range stay restorable via /compact restore.
 */

import type { AppState } from '../../app/state.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import {
  applyCompaction,
  DEFAULT_KEEP_RECENT_MESSAGES,
  planCompaction,
  restoreLastCompaction,
} from '../../context/compaction.js';
import { formatRelative, formatTokens } from '../format.js';

const MIN_COMPACTABLE = 2;

export function createCompactCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'compact',
      category: 'context',
      description: 'Summarize older conversation with explicit preservation rules',
      usage: '/compact [preview|run|restore|summaries] [--keep=<n>]',
      subcommands: [
        {
          name: 'preview',
          usage: '/compact preview',
          description: 'Show what would be preserved and replaced',
        },
        {
          name: 'run',
          usage: '/compact',
          description: 'Compact older messages into a summary (default)',
        },
        {
          name: 'restore',
          usage: '/compact restore',
          description: 'Restore the last compacted range (when retained)',
        },
        {
          name: 'summaries',
          usage: '/compact summaries',
          description: 'List generated summaries and retention state',
        },
      ],
      examples: [
        '/compact',
        '/compact preview',
        '/compact --keep=24',
        '/compact restore',
        '/compact summaries',
      ],
      handler: ({ args, flags }): CommandResult => {
        const keep = parseKeep(flags['keep']);
        if (keep instanceof Error) return { ok: false, error: keep.message };

        const sub = args[0] ?? 'run';
        switch (sub) {
          case 'run':
            return runCompaction(app, keep);
          case 'preview':
            return previewCompaction(app, keep);
          case 'restore':
            return restoreCompaction(app);
          case 'summaries':
            return listSummaries(app);
          default:
            return {
              ok: false,
              error: `Unknown subcommand: /compact ${sub}. Usage: /compact [preview|run|restore|summaries] [--keep=<n>]`,
            };
        }
      },
    },
  ];
}

/**
 * Shared compaction entry point (also used by /context compact, §13).
 * Runs the default compaction with the standard retention window.
 */
export function runDefaultCompaction(app: AppState): CommandResult {
  return runCompaction(app, undefined);
}

function parseKeep(value: string | true | undefined): number | undefined | Error {
  if (value === undefined) return undefined;
  const raw = value === true ? '' : value;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 2 || parsed > 5000) {
    return new Error(
      '--keep expects a whole number of recent messages between 2 and 5000 — use --keep=<n> (e.g. /compact --keep=24).',
    );
  }
  return parsed;
}

function previewCompaction(app: AppState, keep: number | undefined): CommandResult {
  const plan = planCompaction(app.session, {
    ...(keep !== undefined ? { keepRecentMessages: keep } : {}),
  });

  if (plan.compactable.length < MIN_COMPACTABLE) {
    return {
      ok: true,
      output:
        `Nothing to compact: only ${plan.compactable.length} older message(s) outside the recent window ` +
        `(keep ${keep ?? DEFAULT_KEEP_RECENT_MESSAGES}). The preview changed nothing.`,
    };
  }

  const lines: string[] = ['Compaction preview (nothing changed):', ''];
  lines.push(`  messages to replace  ${plan.compactable.length}`);
  lines.push(`  messages kept        ${plan.kept.length}`);
  lines.push(`  summary level        ${plan.level}`);
  lines.push(
    `  estimated tokens     ${formatTokens(plan.originalTokens)} → ${formatTokens(plan.summaryTokens)}`,
  );
  lines.push('');
  lines.push('Preserved sections:');
  if (plan.sections.length === 0) {
    lines.push(
      '  (none — no requirements, decisions, errors, or recorded state found in this range)',
    );
  }
  for (const section of plan.sections) {
    lines.push(`  ${section.title} [${section.evidence}] — ${section.items.length} item(s)`);
  }
  lines.push('');
  lines.push('Compaction cannot preserve every detail; recent messages stay verbatim and');
  lines.push('original history is restorable when contextEngine.preserveOriginalHistory is on.');
  lines.push('Run /compact to apply, or /compact --keep=<n> to change the kept window.');
  return { ok: true, output: lines.join('\n') };
}

function runCompaction(app: AppState, keep: number | undefined): CommandResult {
  const plan = planCompaction(app.session, {
    ...(keep !== undefined ? { keepRecentMessages: keep } : {}),
  });

  if (plan.compactable.length < MIN_COMPACTABLE) {
    return {
      ok: true,
      output:
        `Nothing to compact: only ${plan.compactable.length} older message(s) outside the recent window ` +
        `(keep ${keep ?? DEFAULT_KEEP_RECENT_MESSAGES}).`,
    };
  }
  if (plan.summaryTokens >= plan.originalTokens) {
    return {
      ok: true,
      output:
        `Compaction skipped: the summary would be ${formatTokens(plan.summaryTokens)} tokens versus ` +
        `${formatTokens(plan.originalTokens)} in the range — no space would be saved. ` +
        'Consider /clear or a smaller kept window (/compact --keep=<n>) with less dense history.',
    };
  }

  const result = applyCompaction(app.session, plan, {
    preserveOriginal: app.config.contextEngine.preserveOriginalHistory,
  });
  app.saveSession();

  const lines: string[] = ['Conversation compacted:', ''];
  lines.push(`  messages replaced  ${result.messagesReplaced}`);
  lines.push(`  summary level      ${result.level}`);
  lines.push(
    `  estimated tokens   ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)}`,
  );
  lines.push(
    `  original history   ${result.payloadRetained ? 'retained — /compact restore can undo this' : 'NOT retained (preserveOriginalHistory is off)'}`,
  );
  lines.push('');
  lines.push(
    'The summary preserves: ' +
      plan.sections.map((s) => s.title.replace(/\s*\(.*\)$/, '')).join(', ') +
      '.',
  );
  lines.push(
    'It cannot preserve every detail; sections marked [inferred] are derived, the rest is quoted or recorded.',
  );
  return { ok: true, output: lines.join('\n') };
}

function restoreCompaction(app: AppState): CommandResult {
  const result = restoreLastCompaction(app.session);
  if (!result.ok) return { ok: false, error: result.message };
  app.saveSession();
  return { ok: true, output: result.message };
}

function listSummaries(app: AppState): CommandResult {
  const summaries = app.session.summaries ?? [];
  if (summaries.length === 0) {
    return {
      ok: true,
      output: 'No compaction summaries in this session yet. Run /compact to create one.',
    };
  }

  const lines: string[] = ['Compaction summaries (newest first):', ''];
  for (const record of [...summaries].reverse()) {
    const chunk = (app.session.compactedChunks ?? []).find((c) => c.id === record.id);
    const retention = chunk
      ? chunk.payloadRetained
        ? 'original messages retained'
        : 'originals no longer retained'
      : 'details unavailable';
    lines.push(
      `  level ${record.level}  ${formatRelative(record.at)}  covers ${record.coversMessages} message(s)  ` +
        `~${formatTokens(record.tokens)} tokens  (${retention})`,
    );
  }
  lines.push('');
  lines.push('Use /compact restore to bring back the most recent retained range.');
  return { ok: true, output: lines.join('\n') };
}
