/**
 * Session commands: /session, /resume, /search, /usage, /budget.
 */

import { resolve } from 'path';
import type { AppState } from '../../app/state.js';
import { MODES } from '../../modes/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { formatMoney, formatRelative, formatTokens, shortenId } from '../format.js';
import { truncate } from '../../utils/index.js';
import { buildUsageAccount } from '../../budget/accounting.js';
import { describePricing } from '../../budget/pricing.js';

const MAX_SESSIONS_LISTED = 15;

export function createSessionCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'session',
      category: 'sessions',
      description: 'Manage sessions: list, create, rename, switch, export, delete',
      usage:
        '/session [list|new [name]|rename <name>|switch <id>|export <path>|delete <id> [--yes]]',
      subcommands: [
        { name: 'list', usage: '/session list', description: 'List recent sessions' },
        { name: 'new', usage: '/session new [name]', description: 'Start a new session' },
        {
          name: 'rename',
          usage: '/session rename <name>',
          description: 'Rename the current session',
        },
        {
          name: 'switch',
          usage: '/session switch <id>',
          description: 'Switch to a session by id (prefix ok)',
        },
        {
          name: 'export',
          usage: '/session export <path>',
          description: 'Export the session as JSON',
        },
        {
          name: 'delete',
          usage: '/session delete <id> --yes',
          description: 'Delete a session (two-step confirm)',
        },
      ],
      examples: ['/session', '/session list', '/session new refactor-provider', '/resume'],
      handler: async ({ args, flags }): Promise<CommandResult> => {
        const sub = args[0] ?? '';

        switch (sub) {
          case '':
            return showCurrent(app);
          case 'list':
            return listSessions(app);
          case 'new':
            return newSession(app, args.slice(1).join(' ').trim() || undefined);
          case 'rename':
            return renameSession(app, args.slice(1).join(' ').trim());
          case 'switch':
            return switchSession(app, args[1]);
          case 'export':
            return exportSession(app, args[1]);
          case 'delete':
            return deleteSession(app, args[1], flags['yes'] === true);
          default:
            return {
              ok: false,
              error:
                `Unknown subcommand: /session ${sub}.\n` +
                `Usage: /session [list|new [name]|rename <name>|switch <id>|export <path>|delete <id> [--yes]]`,
            };
        }
      },
    },

    {
      name: 'resume',
      category: 'sessions',
      description: 'Resume a previous session (picker, or by id)',
      usage: '/resume [id]',
      examples: ['/resume', '/resume 3f8a2c1d'],
      handler: ({ args }): CommandResult => {
        if (args[0]) {
          return switchSession(app, args[0]);
        }

        const output = listSessions(app).output;
        const result: CommandResult = { ok: true, action: { type: 'open-session-picker' } };
        if (output) result.output = output;
        return result;
      },
    },

    {
      name: 'search',
      category: 'sessions',
      description: 'Search saved sessions by name and message content',
      usage: '/search <query>',
      examples: ['/search provider adapter'],
      availableDuringGeneration: true,
      handler: ({ args }): CommandResult => {
        const query = args.join(' ').trim();
        if (!query) return { ok: false, error: 'Usage: /search <query>' };

        const results = app.sessionManager.search(query);
        if (results.length === 0) {
          return { ok: true, output: `No sessions match "${query}".` };
        }

        const lines: string[] = [`${results.length} session(s) match "${query}":`, ''];
        for (const { session, matchContext } of results.slice(0, MAX_SESSIONS_LISTED)) {
          lines.push(
            `  ${shortenId(session.id)}  ${truncate(session.name, 48)}  (${formatRelative(session.updatedAt)})`,
          );
          lines.push(`            ${truncate(matchContext, 100)}`);
        }
        if (results.length > MAX_SESSIONS_LISTED) {
          lines.push(`  … and ${results.length - MAX_SESSIONS_LISTED} more`);
        }
        lines.push('');
        lines.push('Resume with /resume <id>.');
        return { ok: true, output: lines.join('\n') };
      },
    },

    {
      name: 'usage',
      category: 'sessions',
      description: 'Show token usage and estimated cost for the current session',
      usage: '/usage',
      availableDuringGeneration: true,
      handler: (): CommandResult => {
        const account = buildUsageAccount(app);
        const usage = account.session;
        const lines: string[] = ['Session usage:', ''];
        lines.push(`  requests          ${usage.requests}`);
        lines.push(`  input reported    ${usage.inputTokens} (${formatTokens(usage.inputTokens)})`);
        lines.push(
          `  input estimated   ${usage.estimatedInputTokens} (${formatTokens(usage.estimatedInputTokens)}) — preflight estimates of sent requests`,
        );
        lines.push(
          `  output            ${usage.outputTokens} (${formatTokens(usage.outputTokens)})`,
        );
        if (usage.cachedInputTokens > 0) {
          lines.push(`  cached input      ${usage.cachedInputTokens}`);
        }
        if (usage.reasoningTokens > 0) {
          lines.push(`  reasoning         ${usage.reasoningTokens}`);
        }
        lines.push(`  estimated cost    ${formatMoney(usage.estimatedCost, usage.currency)}`);
        lines.push('');
        if (account.lastRequest) {
          lines.push(
            `Last request: ${account.lastRequest.estimatedInputTokens} estimated input tokens vs ` +
              `${account.lastRequest.effectiveBudget} effective budget (${account.lastRequest.estimateSource}, ${account.lastRequest.at})`,
          );
          lines.push('');
        }
        lines.push(...describePricing(account.pricing));
        lines.push('');
        lines.push('The cost is a LOCAL ESTIMATE computed from the cached pricing snapshot —');
        lines.push('it is not an invoice and may differ from provider billing.');
        lines.push(
          'Budget limits: /budget. Official balance: /budget balance (documented endpoints only).',
        );
        return { ok: true, output: lines.join('\n') };
      },
    },

    {
      name: 'budget',
      category: 'sessions',
      description: 'Show spending limits, local estimates, and query documented provider balance',
      usage: '/budget [balance]',
      subcommands: [
        {
          name: 'balance',
          usage: '/budget balance',
          description: 'Query the provider balance via documented interfaces (xKiro)',
        },
      ],
      availableDuringGeneration: true,
      handler: async ({ args }): Promise<CommandResult> => {
        if (args[0] === 'balance') return queryProviderBalance(app);
        if (args[0]) {
          return {
            ok: false,
            error: `Unknown subcommand: /budget ${args[0]}. Usage: /budget [balance]`,
          };
        }

        const limits = app.config.spendingLimits;
        const currency = limits.currency;
        const account = buildUsageAccount(app);

        const lines: string[] = ['Budget (local estimates from session records):', ''];

        lines.push('  Limits:');
        lines.push(
          `    per request     ${limits.maxPerRequest !== undefined ? formatMoney(limits.maxPerRequest, currency) : 'not set'}`,
        );
        lines.push(
          `    per session     ${limits.maxPerSession !== undefined ? formatMoney(limits.maxPerSession, currency) : 'not set'}`,
        );
        lines.push(
          `    daily           ${limits.maxDaily !== undefined ? formatMoney(limits.maxDaily, currency) : 'not set'}`,
        );
        lines.push(
          `    monthly         ${limits.maxMonthly !== undefined ? formatMoney(limits.maxMonthly, currency) : 'not set'}`,
        );
        lines.push(
          `    large-context confirmation threshold  ${limits.largeContextConfirmationThreshold !== undefined ? `${limits.largeContextConfirmationThreshold} tokens` : 'not set'}`,
        );
        lines.push(
          `    minimum verified balance  ${limits.minimumBalance !== undefined ? formatMoney(limits.minimumBalance, currency) : 'not required'}`,
        );
        lines.push(
          `    unknown-balance policy    ${limits.unknownBalancePolicy}${limits.minimumBalance === undefined ? ' (inactive until a minimum balance is configured)' : ''}`,
        );
        lines.push(`    currency                  ${currency}`);
        lines.push('');

        lines.push('  Local spend (estimated):');
        lines.push(
          `    today           ${formatMoney(account.today.total, account.today.currency)} across ${account.today.sessionCount} session(s)`,
        );
        lines.push(
          `    this month      ${formatMoney(account.month.total, account.month.currency)} across ${account.month.sessionCount} session(s)`,
        );
        lines.push(
          `    this session    ${formatMoney(account.session.estimatedCost, account.session.currency)}`,
        );
        lines.push('');

        if (limits.maxDaily !== undefined) {
          const remaining = limits.maxDaily - account.today.total;
          lines.push(
            `  Remaining today (estimated): ${remaining > 0 ? formatMoney(remaining, currency) : 'EXCEEDED'}`,
          );
        }
        if (limits.maxMonthly !== undefined) {
          const remaining = limits.maxMonthly - account.month.total;
          lines.push(
            `  Remaining this month (estimated): ${remaining > 0 ? formatMoney(remaining, currency) : 'EXCEEDED'}`,
          );
        }

        if (account.lastRequest) {
          lines.push('');
          lines.push(
            `  Last request: ${account.lastRequest.estimatedInputTokens} estimated input tokens vs ` +
              `${account.lastRequest.effectiveBudget} effective budget (gate result: ${app.session.lastContextReport?.gateAction ?? 'unknown'})`,
          );
        }

        lines.push('');
        lines.push('  Provider balance: unknown from local state.');
        lines.push(
          '    /budget balance queries a documented provider endpoint (xKiro GET /v1/usage).',
        );
        lines.push("    Local estimates are never presented as the provider's official balance.");
        lines.push('');
        lines.push('These numbers come from locally recorded estimates, not provider billing.');
        return { ok: true, output: lines.join('\n') };
      },
    },
  ];
}

// ============================================================================
// Handlers
// ============================================================================

async function queryProviderBalance(app: AppState): Promise<CommandResult> {
  const active = app.activeModel();
  if (!active) {
    return {
      ok: false,
      error: 'No model selected, so no provider is active. Use /model <model> first.',
    };
  }

  let adapter;
  try {
    adapter = await app.getAdapter(active.providerId);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot query provider ${active.providerId}: ${(err as Error).message}`,
    };
  }

  if (!adapter.getAccountUsage) {
    return {
      ok: true,
      output:
        `Provider "${active.providerId}" exposes no documented balance/usage interface to mediaXG.\n` +
        'The balance is therefore unknown — check the provider dashboard.\n' +
        'mediaXG never estimates official account balances from local data.',
    };
  }

  let result;
  try {
    result = await adapter.getAccountUsage();
  } catch (err) {
    return { ok: false, error: `Balance query failed: ${(err as Error).message}` };
  }

  if (!result.available || !result.values || result.values.length === 0) {
    return { ok: true, output: `Provider balance NOT available.\n${result.message}` };
  }

  const lines: string[] = [`Provider balance (${active.providerId}) — ${result.message}:`, ''];
  for (const item of result.values) {
    lines.push(`  ${item.label.padEnd(20)} ${item.value}`);
  }
  lines.push('');
  lines.push(
    "These values were returned by the provider's documented endpoint, not estimated locally.",
  );
  lines.push(
    'Values are only shown when the response shape was recognized; unknown shapes are not parsed.',
  );
  return { ok: true, output: lines.join('\n') };
}

function showCurrent(app: AppState): CommandResult {
  const session = app.session;
  const lines: string[] = ['Current session:', ''];
  lines.push(`  id            ${session.id}`);
  lines.push(`  name          ${session.name}`);
  lines.push(`  mode          ${MODES[session.mode].label}`);
  lines.push(`  messages      ${session.messages.length}`);
  lines.push(`  provider      ${session.providerId ?? 'not selected'}`);
  lines.push(`  model         ${session.modelId ?? 'not selected'}`);
  lines.push(
    `  cost          ${formatMoney(session.usage.estimatedCost, session.usage.currency)} (local estimate)`,
  );
  lines.push(`  updated       ${formatRelative(session.updatedAt)}`);
  lines.push(`  project       ${session.projectPath}`);
  if (session.interrupted) {
    lines.push('  interrupted   previous run ended mid-request');
  }
  lines.push('');
  lines.push(`Sessions directory: ${app.sessionManager.directory}`);
  return { ok: true, output: lines.join('\n') };
}

function listSessions(app: AppState): CommandResult {
  const sessions = app.sessionManager.list();
  if (sessions.length === 0) {
    return { ok: true, output: 'No saved sessions yet.' };
  }

  const lines: string[] = ['Saved sessions (most recent first):', ''];
  for (const summary of sessions.slice(0, MAX_SESSIONS_LISTED)) {
    const marker = summary.id === app.session.id ? '*' : ' ';
    const modelPart = summary.modelId ? ` — ${summary.providerId}/${summary.modelId}` : '';
    lines.push(
      `${marker} ${shortenId(summary.id)}  ${truncate(summary.name, 44).padEnd(44)}  ` +
        `${summary.messageCount} msg  ${formatMoney(summary.estimatedCost, summary.currency)}  ${formatRelative(summary.updatedAt)}${modelPart}`,
    );
  }
  if (sessions.length > MAX_SESSIONS_LISTED) {
    lines.push(`  … and ${sessions.length - MAX_SESSIONS_LISTED} more`);
  }
  lines.push('');
  lines.push('* = current. Switch with /resume <id> or /session switch <id>.');
  return { ok: true, output: lines.join('\n') };
}

function newSession(app: AppState, name: string | undefined): CommandResult {
  const previous = app.session;
  const sessionOptions: Parameters<typeof app.sessionManager.create>[0] = {
    mode: previous.mode,
    contextProfile: previous.contextProfile,
  };
  if (name) sessionOptions.name = name;

  const session = app.sessionManager.create(sessionOptions);
  session.reasoning = { ...previous.reasoning };
  session.responseStyle = previous.responseStyle;
  if (previous.temperature !== undefined) session.temperature = previous.temperature;
  if (previous.outputLimit !== undefined) session.outputLimit = previous.outputLimit;
  session.providerId = previous.providerId;
  session.modelId = previous.modelId;
  app.sessionManager.save(session);
  app.switchSession(session);

  return {
    ok: true,
    output:
      `New session started: ${session.id}\n` +
      `  name  ${session.name}\n` +
      `  (previous session "${truncate(previous.name, 40)}" is saved and can be resumed with /resume ${shortenId(previous.id)})`,
  };
}

function renameSession(app: AppState, name: string): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /session rename <name>' };
  app.session.name = name;
  app.saveSession();
  return { ok: true, output: `Session renamed: ${name}` };
}

function switchSession(app: AppState, id: string | undefined): CommandResult {
  if (!id) return { ok: false, error: 'Usage: /session switch <id> (or /resume for the picker)' };

  const session = app.sessionManager.loadByPrefix(id);
  if (!session) {
    const candidates = app.sessionManager
      .list()
      .filter((s) => s.id.startsWith(id))
      .slice(0, 5);
    if (candidates.length > 1) {
      const lines = [`Session id "${id}" is ambiguous:`, ''];
      for (const candidate of candidates) {
        lines.push(`  ${candidate.id}  ${candidate.name}`);
      }
      return { ok: false, error: lines.join('\n') };
    }
    return {
      ok: false,
      error: `Session not found: ${id}\nRun /session list to see saved sessions.`,
    };
  }

  app.switchSession(session);

  const lines = [
    `Resumed session: ${session.name}`,
    `  id        ${session.id}`,
    `  messages  ${session.messages.length}`,
    `  mode      ${MODES[session.mode].label}`,
  ];
  if (session.interrupted) {
    lines.push(
      '  note      the previous run ended mid-request; the last response may be incomplete',
    );
  }
  return { ok: true, output: lines.join('\n'), action: { type: 'clear-conversation' } };
}

function exportSession(app: AppState, destination: string | undefined): CommandResult {
  if (!destination) {
    return { ok: false, error: 'Usage: /session export <path>' };
  }
  const target = resolve(destination);
  const result = app.sessionManager.export(app.session.id, target);
  return result.ok
    ? {
        ok: true,
        output: `${result.message}\nExports contain conversation and metadata only — never credentials.`,
      }
    : { ok: false, error: result.message };
}

function deleteSession(app: AppState, id: string | undefined, confirmed: boolean): CommandResult {
  if (!id) return { ok: false, error: 'Usage: /session delete <id> [--yes]' };

  const session = app.sessionManager.loadByPrefix(id);
  if (!session) {
    return { ok: false, error: `Session not found: ${id}` };
  }

  if (session.id === app.session.id) {
    return {
      ok: false,
      error:
        'Cannot delete the active session. Switch to another session first ' +
        '(/session new or /resume), then delete this one.',
    };
  }

  if (!confirmed) {
    return {
      ok: true,
      output:
        `This deletes "${session.name}" (${session.messages.length} messages) permanently.\n` +
        `Re-run to confirm: /session delete ${shortenId(session.id)} --yes`,
    };
  }

  const deleted = app.sessionManager.delete(session.id);
  return deleted
    ? { ok: true, output: `Deleted session "${session.name}".` }
    : { ok: false, error: `Failed to delete session ${session.id}.` };
}
