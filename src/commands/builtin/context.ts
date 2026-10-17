/**
 * Context commands: /context — profile selection, requested budget,
 * effective budget inspection, assembly provenance, retrieval toggle (§31).
 *
 * The requested budget is session state; the effective budget is computed by
 * the context engine against real model/provider limits and reported with
 * its source. Nothing here claims a verified capability the data does not
 * support.
 */

import type { AppState } from '../../app/state.js';
import type { ContextProfile } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { formatTokens, parseTokenCount } from '../format.js';
import { budgetReport } from '../../context/budget.js';
import { previewContextBudget, PIN_MAX_BYTES, PIN_MAX_FILES } from '../../context/pipeline.js';
import { formatGateDecision } from '../../budget/gate.js';
import { WorkspacePaths } from '../../tools/paths.js';
import { statSync } from 'fs';
import { runDefaultCompaction } from './compact.js';

const MIN_REQUESTED_TOKENS = 1000;

export function createContextCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'context',
      category: 'context',
      description: 'Show or set the context profile / requested token budget',
      usage:
        '/context [profile|<profile-id>|auto|<tokens>|inspect|budget|retrieval|pin|unpin|compact|reset]',
      subcommands: [
        {
          name: 'inspect',
          usage: '/context inspect [full]',
          description: 'Explain the assembled context of the last request',
        },
        {
          name: 'budget',
          usage: '/context budget',
          description: 'Effective budget with all nine values and the gate result',
        },
        {
          name: 'retrieval',
          usage: '/context retrieval [on|off]',
          description: 'Toggle automatic repository retrieval',
        },
        {
          name: 'auto',
          usage: '/context auto',
          description: 'Select the runtime-determined auto profile',
        },
        {
          name: 'pin',
          usage: '/context pin <path>',
          description: 'Always include a workspace file in every request (priority 9)',
        },
        { name: 'unpin', usage: '/context unpin <path>', description: 'Remove a pinned file' },
        {
          name: 'compact',
          usage: '/context compact',
          description: 'Compact older conversation (same as /compact)',
        },
        {
          name: 'profile',
          usage: '/context profile',
          description: 'List available context profiles',
        },
        { name: '<profile-id>', usage: '/context large', description: 'Select a profile by id' },
        {
          name: '<tokens>',
          usage: '/context 128k',
          description: 'Request an explicit token budget',
        },
        {
          name: 'reset',
          usage: '/context reset',
          description: 'Return to the configured default profile',
        },
      ],
      examples: [
        '/context',
        '/context budget',
        '/context inspect',
        '/context retrieval on',
        '/context auto',
        '/context pin docs/DESIGN.md',
        '/context unpin docs/DESIGN.md',
        '/context compact',
        '/context small',
        '/context 256k',
        '/context reset',
      ],
      handler: ({ args }): CommandResult => {
        const sub = args[0];

        if (!sub) return showContext(app);

        if (sub === 'inspect') return inspectContext(app, args[1] === 'full');
        if (sub === 'budget') return showBudget(app);
        if (sub === 'retrieval') return toggleRetrieval(app, args[1]);
        if (sub === 'auto') return selectAutoProfile(app);
        if (sub === 'pin') return pinPath(app, args[1]);
        if (sub === 'unpin') return unpinPath(app, args[1]);
        if (sub === 'compact') return runDefaultCompaction(app);

        if (sub === 'profile') {
          const lines: string[] = ['Context profiles:', ''];
          for (const profile of app.config.contextProfiles) {
            const marker = profile.id === app.session.contextProfile ? '*' : ' ';
            const size =
              profile.maxTokens > 0
                ? `${formatTokens(profile.maxTokens)} tokens`
                : 'auto (runtime-determined)';
            const defaults = profile.isDefault ? ' [config default]' : '';
            lines.push(
              `${marker} ${profile.id.padEnd(10)} ${size.padEnd(26)} ${profile.description}${defaults}`,
            );
          }
          lines.push('');
          lines.push('Select with /context <id>, or request a size with /context <tokens>.');
          lines.push(
            'Profiles are presets: the effective budget is always clamped by the model/provider limits.',
          );
          return { ok: true, output: lines.join('\n') };
        }

        if (sub === 'reset') {
          app.session.contextProfile = app.config.defaultContextProfile;
          delete app.session.requestedContext;
          app.saveSession();
          return {
            ok: true,
            output: `Context profile reset to the configured default: ${app.config.defaultContextProfile}.`,
          };
        }

        // A known profile id?
        const profile = app.config.contextProfiles.find((p) => p.id === sub);
        if (profile) {
          app.session.contextProfile = profile.id;
          delete app.session.requestedContext;
          app.saveSession();

          const notes: string[] = [
            `Context profile: ${profile.id} — ${profile.description}`,
            profile.maxTokens > 0
              ? `Requested budget: ${formatTokens(profile.maxTokens)} tokens (output headroom: ${formatTokens(profile.reservedOutputTokens)}, safety margin: ${formatTokens(profile.safetyMargin)})`
              : 'Budget: determined at runtime from the model and the task (auto never picks the largest tier by default).',
          ];
          notes.push(...sizeWarnings(app, profile.maxTokens > 0 ? profile.maxTokens : undefined));
          notes.push(
            'Run /context budget to see the effective values against the real model limits.',
          );
          return { ok: true, output: notes.join('\n') };
        }

        // An explicit token count?
        const tokens = parseTokenCount(sub);
        if (tokens !== null) {
          if (tokens < MIN_REQUESTED_TOKENS) {
            return {
              ok: false,
              error: `Requested budget too small: ${sub}. The minimum is ${MIN_REQUESTED_TOKENS} tokens.`,
            };
          }
          app.session.requestedContext = tokens;
          app.session.contextProfile = 'custom';
          app.saveSession();

          const notes: string[] = [
            `Requested context budget: ${formatTokens(tokens)} tokens (custom override).`,
          ];
          notes.push(...sizeWarnings(app, tokens));
          notes.push(
            'The effective budget may be lower after model limits and output headroom are applied (/context budget).',
          );
          return { ok: true, output: notes.join('\n') };
        }

        return {
          ok: false,
          error:
            `Unknown context target: ${sub}.\n` +
            `Use /context profile to list profiles, /context <profile-id> to select one, ` +
            `/context <tokens> (e.g. 128k) to request a size, /context budget, /context inspect, or /context reset.`,
        };
      },
    },
  ];
}

// ============================================================================
// Helpers
// ============================================================================

function selectAutoProfile(app: AppState): CommandResult {
  const autoProfile =
    app.config.contextProfiles.find((p) => p.id === 'auto') ??
    app.config.contextProfiles.find((p) => p.maxTokens === 0);

  if (!autoProfile) {
    return {
      ok: false,
      error:
        'No auto profile is configured (a profile with id "auto" or maxTokens: 0). ' +
        'Add one to the config, or use /context <profile-id> / /context <tokens>.',
    };
  }

  app.session.contextProfile = autoProfile.id;
  delete app.session.requestedContext;
  app.saveSession();
  return {
    ok: true,
    output:
      `Context profile: ${autoProfile.id} — ${autoProfile.description}\n` +
      'The budget is determined at runtime: the smallest tier that covers the estimated need ' +
      'with output headroom, clamped by the model/provider limits. It never picks the largest ' +
      'tier by default.\n' +
      'Run /context budget to see the effective values for the current conversation.',
  };
}

function pinPath(app: AppState, raw: string | undefined): CommandResult {
  if (!raw) {
    return { ok: false, error: 'Usage: /context pin <workspace-relative path>' };
  }
  const paths = new WorkspacePaths(app.projectPath);
  let resolved;
  try {
    resolved = paths.resolve(raw, { mustExist: true });
  } catch (err) {
    return {
      ok: false,
      error: `Cannot pin ${raw}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let isFile = false;
  try {
    isFile = statSync(resolved.abs).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return {
      ok: false,
      error: `Only files can be pinned: ${resolved.rel} is a directory (or unreadable).`,
    };
  }

  const pinned = app.session.pinnedPaths ?? [];
  if (pinned.includes(resolved.rel)) {
    return { ok: true, output: `${resolved.rel} is already pinned (included in every request).` };
  }
  if (pinned.length >= PIN_MAX_FILES) {
    return {
      ok: false,
      error:
        `Pin limit reached: ${PIN_MAX_FILES} files.\n` +
        `Unpin one first: ${pinned.slice(0, 5).join(', ')}${pinned.length > 5 ? ', …' : ''}`,
    };
  }

  pinned.push(resolved.rel);
  app.session.pinnedPaths = pinned;
  app.saveSession();

  return {
    ok: true,
    output:
      `Pinned ${resolved.rel} (priority 9 — user-pinned context).\n` +
      `It is re-read from disk for every request, capped at ${formatTokens(Math.round(PIN_MAX_BYTES / 4))} tokens ` +
      `(~${PIN_MAX_BYTES} bytes) per file, and capped at ${PIN_MAX_FILES} pinned files.\n` +
      'Inspect with /context (listing), /context inspect (assembly), or /context budget.',
  };
}

function unpinPath(app: AppState, raw: string | undefined): CommandResult {
  if (!raw) {
    return { ok: false, error: 'Usage: /context unpin <path>' };
  }
  const pinned = app.session.pinnedPaths ?? [];
  if (pinned.length === 0) {
    return { ok: false, error: 'Nothing is pinned in this session.' };
  }

  // Match by exact rel first, then by resolved rel (path may already be gone)
  let candidate = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  try {
    const paths = new WorkspacePaths(app.projectPath);
    candidate = paths.resolve(candidate).rel;
  } catch {
    // keep the raw candidate for the direct match below
  }

  const index = pinned.indexOf(candidate);
  if (index === -1) {
    return {
      ok: false,
      error: `Not pinned: ${raw}\n` + `Pinned files: ${pinned.join(', ')}`,
    };
  }

  pinned.splice(index, 1);
  app.session.pinnedPaths = pinned;
  app.saveSession();
  return {
    ok: true,
    output:
      `Unpinned ${candidate}.` +
      (pinned.length > 0
        ? `\nStill pinned: ${pinned.join(', ')}`
        : '\nNo files are pinned anymore.'),
  };
}

function showContext(app: AppState): CommandResult {
  const session = app.session;
  const profile = app.config.contextProfiles.find((p) => p.id === session.contextProfile);

  const lines: string[] = ['Context configuration:', ''];

  if (session.requestedContext !== undefined) {
    lines.push(
      `  requested      ${formatTokens(session.requestedContext)} tokens (custom override)`,
    );
    lines.push(`  profile        ${profile ? profile.id : '(none — custom override active)'}`);
  } else if (profile) {
    lines.push(`  profile        ${profile.id} — ${profile.description}`);
    lines.push(
      `  requested      ${
        profile.maxTokens > 0
          ? `${formatTokens(profile.maxTokens)} tokens (output headroom: ${formatTokens(profile.reservedOutputTokens)}, safety margin: ${formatTokens(profile.safetyMargin)})`
          : 'auto (runtime-determined)'
      }`,
    );
  } else {
    lines.push(`  profile        ${session.contextProfile} — NOT in the configured profiles!`);
    lines.push('  Fix with /context reset or /context <profile-id>.');
  }

  const active = app.activeModel();
  if (active) {
    const entry = app.catalog.findModel(active.modelId, [active.providerId]);
    if (entry?.contextLength !== undefined) {
      lines.push(
        `  model window   ${formatTokens(entry.contextLength)} tokens (${entry.capabilitySource}${entry.verified ? ', verified' : ', unverified'})`,
      );
    } else {
      lines.push('  model window   unknown (provider did not report one)');
    }
  } else {
    lines.push('  model window   unknown (no model selected)');
  }

  const retrievalDefault = app.config.contextEngine.retrieval.enabled;
  const retrievalActive = app.session.retrievalEnabled ?? retrievalDefault;
  lines.push(
    `  retrieval      ${retrievalActive ? 'on' : 'off'} (session override: ${
      app.session.retrievalEnabled === undefined ? 'none' : String(app.session.retrievalEnabled)
    }; config default: ${retrievalDefault ? 'on' : 'off'})`,
  );

  const report = app.session.lastContextReport;
  if (report) {
    lines.push(
      `  last request   ${formatTokens(report.estimatedInputTokens)} estimated input tokens vs ${formatTokens(report.effectiveBudget)} effective budget (${report.estimateSource}, gate: ${report.gateAction}, ${report.at})`,
    );
  } else {
    lines.push('  last request   no request assembled yet in this session');
  }

  const pinned = session.pinnedPaths ?? [];
  if (pinned.length > 0) {
    const shown = pinned.slice(0, 5).join(', ');
    lines.push(
      `  pinned         ${pinned.length} file(s): ${shown}${pinned.length > 5 ? `, … +${pinned.length - 5}` : ''}`,
    );
  } else {
    lines.push('  pinned         none (/context pin <path> to always include a file)');
  }

  lines.push('');
  lines.push('Effective budgeting per request is applied by the context engine.');
  lines.push('Inspect with /context budget (9 values) and /context inspect (assembly provenance).');
  lines.push('Change with /context <profile-id>, /context <tokens>, or /context profile.');
  return { ok: true, output: lines.join('\n') };
}

function inspectContext(app: AppState, full: boolean): CommandResult {
  const report = app.session.lastContextReport;
  if (!report) {
    return {
      ok: true,
      output:
        'No request has been assembled yet in this session.\n' +
        'Send a message (or run /context budget for a preview of the effective budget) and inspect again.',
    };
  }

  const lines: string[] = ['Last context assembly:', ''];
  lines.push(`  at               ${report.at}`);
  lines.push(
    `  estimated input  ${report.estimatedInputTokens} tokens (${report.estimateSource}${report.estimateNote ? ` — ${report.estimateNote}` : ''})`,
  );
  lines.push(
    `  effective budget ${report.effectiveBudget} tokens (requested ${report.requestOrigin === 'auto' ? 'auto' : report.requestedTokens}; reserve ${report.reservedOutputTokens}; margin ${report.safetyMargin})`,
  );
  lines.push(`  headroom         ${report.remainingHeadroom} tokens`);
  lines.push(`  capability       ${report.capabilitySource}`);
  lines.push(`  gate             ${report.gateAction}`);
  if (report.compactedMessages > 0)
    lines.push(`  compacted        ${report.compactedMessages} older message(s) summarized`);
  if (report.omittedMessages > 0)
    lines.push(
      `  omitted          ${report.omittedMessages} earlier message(s) dropped for budget`,
    );
  if (report.retrievalFiles.length > 0)
    lines.push(`  retrieval        ${report.retrievalFiles.join(', ')}`);
  lines.push('');

  const included = report.items.filter((item) => item.included);
  const excluded = report.items.filter((item) => !item.included);
  lines.push(`Included items (${included.length}):`);
  const shown = full ? included : included.slice(0, 14);
  for (const item of shown) {
    lines.push(
      `  p${String(item.priority).padStart(2)} ${item.type.padEnd(19)} ${item.label} — ${item.tokens} tokens`,
    );
    lines.push(`      why: ${item.reason}`);
    lines.push(`      from: ${item.provenance}`);
  }
  if (!full && included.length > shown.length) {
    lines.push(`  … and ${included.length - shown.length} more (use /context inspect full)`);
  }
  if (excluded.length > 0) {
    lines.push('');
    lines.push(`Excluded items (${excluded.length}):`);
    for (const item of excluded.slice(0, 8)) {
      lines.push(
        `  p${String(item.priority).padStart(2)} ${item.type.padEnd(19)} ${item.label} — ${item.tokens} tokens`,
      );
      lines.push(`      why: ${item.reason}`);
    }
  }
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of report.notes) lines.push(`  • ${note}`);
  }
  return { ok: true, output: lines.join('\n') };
}

function showBudget(app: AppState): CommandResult {
  const active = app.activeModel();
  if (!active) {
    return {
      ok: false,
      error: 'No model selected. Run /models to browse models and /model <model> to select one.',
    };
  }

  const preview = previewContextBudget(app);
  const { pairs, notes } = budgetReport(preview.budget);

  const lines: string[] = ['Effective context budget (computed from current state):', ''];
  for (const [label, value] of pairs) {
    lines.push(`  ${label.padEnd(26)} ${value}`);
  }
  lines.push('');
  lines.push('Token estimate:');
  lines.push(
    `  ${preview.estimate.tokens} tokens (${preview.estimate.source})${preview.estimate.note ? ` — ${preview.estimate.note}` : ''}`,
  );
  lines.push('');
  lines.push(...formatGateDecision(preview.gate));
  if (notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of notes) lines.push(`  • ${note}`);
  }

  const pricingLine = lastRequestPricingLine(app);
  if (pricingLine) {
    lines.push('');
    lines.push(pricingLine);
  }
  return { ok: true, output: lines.join('\n') };
}

function lastRequestPricingLine(app: AppState): string | null {
  const report = app.session.lastContextReport;
  if (!report) return null;
  return (
    `Last request: ${report.estimatedInputTokens} estimated input tokens, gate ${report.gateAction}. ` +
    'Estimated costs and spend: /usage and /budget.'
  );
}

function toggleRetrieval(app: AppState, value: string | undefined): CommandResult {
  const current = app.session.retrievalEnabled ?? app.config.contextEngine.retrieval.enabled;

  if (value === undefined) {
    return {
      ok: true,
      output:
        `Automatic repository retrieval is ${current ? 'ON' : 'OFF'} for this session ` +
        `(config default: ${app.config.contextEngine.retrieval.enabled ? 'on' : 'off'}).\n` +
        'When on, relevant snippets (explicitly mentioned paths first, keyword search second) are ' +
        'added to the request within the effective budget, labeled as data.\n' +
        'Usage: /context retrieval on|off',
    };
  }
  if (value !== 'on' && value !== 'off') {
    return { ok: false, error: `Usage: /context retrieval on|off (got "${value}")` };
  }

  app.session.retrievalEnabled = value === 'on';
  app.saveSession();
  return {
    ok: true,
    output:
      `Automatic repository retrieval ${value === 'on' ? 'enabled' : 'disabled'} for this session ` +
      `(config default: ${app.config.contextEngine.retrieval.enabled ? 'on' : 'off'}).\n` +
      (value === 'on'
        ? 'The first message of each turn may include relevant snippets within the effective budget. ' +
          'The index is built once per run and always re-reads file contents before extraction.'
        : 'No snippets will be injected automatically.'),
  };
}

/**
 * Explain when the requested budget exceeds what the active model reports,
 * and suggest profiles that fit. Never silently clamps — the warning is
 * part of the output, and the intent is kept.
 */
function sizeWarnings(app: AppState, requestedTokens: number | undefined): string[] {
  if (requestedTokens === undefined) return [];

  const active = app.activeModel();
  if (!active) return [];

  const entry = app.catalog.findModel(active.modelId, [active.providerId]);
  if (entry?.contextLength === undefined) return [];

  const modelContextLength: number = entry.contextLength;

  if (requestedTokens <= modelContextLength) return [];

  const fitting = app.config.contextProfiles.filter(
    (p: ContextProfile) => p.maxTokens > 0 && p.maxTokens <= modelContextLength,
  );
  const suggestions = fitting.slice(-2).map((p) => p.id);

  return [
    `Warning: ${entry.displayName} reports a context window of ${formatTokens(modelContextLength)} tokens; ` +
      `the requested ${formatTokens(requestedTokens)} tokens is larger.`,
    suggestions.length > 0
      ? `Profiles that fit: ${suggestions.join(', ')}.`
      : 'No configured profile fits this model exactly — consider a custom /context <tokens> value.',
  ];
}
