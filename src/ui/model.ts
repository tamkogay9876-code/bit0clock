/**
 * Pure UI logic: transcript model, suggestions, picker item building.
 *
 * Kept free of React so it can be tested with plain unit tests.
 */

import type { AppState } from '../app/state.js';
import type { CommandRegistry } from '../commands/registry.js';
import { parseInput } from '../commands/parser.js';
import type { SessionData } from '../session/types.js';
import { MODES } from '../modes/index.js';
import { formatMoney, formatRelative, formatTokens, shortenId } from '../commands/format.js';

// ============================================================================
// Transcript
// ============================================================================

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'error' | 'tool';

export type ToolEntryStatus = 'running' | 'ok' | 'error';

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
  /** True while deltas are still arriving */
  streaming?: boolean;
  /** Reasoning summary streamed alongside the response (dimmed) */
  reasoning?: string;
  /** Tool call rendering (role 'tool') */
  tool?: {
    name: string;
    status: ToolEntryStatus;
    durationMs?: number;
  };
}

let entryCounter = 0;
export function nextEntryId(prefix = 'e'): string {
  entryCounter++;
  return `${prefix}-${Date.now().toString(36)}-${entryCounter}`;
}

/** Build the initial transcript from a persisted session (used on resume). */
export function hydrateTranscript(session: SessionData): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();

  for (const message of session.messages) {
    if (message.role === 'user') {
      entries.push({
        id: nextEntryId('h'),
        role: 'user',
        content: typeof message.content === 'string' ? message.content : '[non-text message]',
      });
      continue;
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.name);
      }
      const content = typeof message.content === 'string' ? message.content : '[non-text message]';
      if (content !== '' || (message.toolCalls ?? []).length === 0) {
        entries.push({ id: nextEntryId('h'), role: 'assistant', content });
      }
      if (message.error) {
        entries.push({
          id: nextEntryId('h'),
          role: 'error',
          content: message.error === 'Cancelled by the user' ? 'Cancelled.' : message.error,
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      for (const result of message.toolResults ?? []) {
        entries.push({
          id: nextEntryId('h'),
          role: 'tool',
          content: typeof result.content === 'string' ? result.content : '',
          tool: {
            name: toolNames.get(result.toolCallId) ?? 'tool',
            status: result.isError ? 'error' : 'ok',
          },
        });
      }
    }
  }
  return entries;
}

/** Apply a streamed delta to an entry (immutably). */
export function appendDelta(
  entries: TranscriptEntry[],
  id: string,
  kind: 'text' | 'reasoning',
  chunk: string,
): TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.id !== id) return entry;
    if (kind === 'text') {
      return { ...entry, content: entry.content + chunk };
    }
    return { ...entry, reasoning: (entry.reasoning ?? '') + chunk };
  });
}

export function finalizeEntry(
  entries: TranscriptEntry[],
  id: string,
  patch: Partial<TranscriptEntry> = {},
): TranscriptEntry[] {
  return entries.map((entry) =>
    entry.id === id ? { ...entry, ...patch, streaming: false } : entry,
  );
}

export function pushEntry(
  entries: TranscriptEntry[],
  entry: Omit<TranscriptEntry, 'id'> & { id?: string },
): TranscriptEntry[] {
  return [...entries, { id: entry.id ?? nextEntryId(), ...entry }];
}

/** Last request's input tokens — the closest local view of current context use. */
export function contextUsedTokens(session: SessionData): number | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (message.role === 'assistant' && message.usage?.inputTokens !== undefined) {
      return message.usage.inputTokens;
    }
  }
  return undefined;
}

/** Patch a tool transcript entry (status transition, duration). */
export function updateToolEntry(
  entries: TranscriptEntry[],
  id: string,
  patch: { content?: string; tool?: Partial<NonNullable<TranscriptEntry['tool']>> },
): TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.id !== id) return entry;
    const next: TranscriptEntry = { ...entry };
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.tool !== undefined && entry.tool) next.tool = { ...entry.tool, ...patch.tool };
    return next;
  });
}

// ============================================================================
// Permission prompt keys
// ============================================================================

export type PermissionPromptDecision = 'allow' | 'allow-session' | 'deny';

/**
 * Map a keypress in the permission overlay to a decision.
 * y = allow once, a = always allow in this session, n/Esc = deny.
 * Returns null for keys that should be ignored.
 */
export function permissionKeyDecision(
  input: string,
  key: { escape?: boolean },
): PermissionPromptDecision | null {
  if (key.escape) return 'deny';
  switch (input.toLowerCase()) {
    case 'y':
      return 'allow';
    case 'a':
      return 'allow-session';
    case 'n':
      return 'deny';
    default:
      return null;
  }
}

// ============================================================================
// Status line
// ============================================================================

export interface StatusParts {
  provider: string;
  model: string;
  mode: string;
  auto: string;
  think: string;
  context: string;
  cost: string;
  session: string;
}

export function statusParts(app: AppState): StatusParts {
  const active = app.activeModel();
  const mode = MODES[app.session.mode].label;
  const effort = app.session.reasoning.effort;

  let context = 'CTX ?';
  const used = contextUsedTokens(app.session);
  if (used !== undefined) {
    const entry = active ? app.catalog.findModel(active.modelId, [active.providerId]) : undefined;
    const limit = entry?.contextLength;
    context =
      limit !== undefined
        ? `CTX ${formatTokens(used)}/${formatTokens(limit)}`
        : `CTX ${formatTokens(used)}/?`;
  }

  return {
    provider: active?.providerId ?? 'no provider',
    model: active?.modelId ?? 'no model — /models',
    mode,
    auto: app.autoApprove ? 'AUTO ON' : 'AUTO off',
    think: `THINK ${effort}${app.session.reasoning.budgetTokens !== undefined ? '•' : ''}`,
    context,
    cost: `${formatMoney(app.session.usage.estimatedCost, app.session.usage.currency)} (est.)`,
    session: shortenId(app.session.id),
  };
}

// ============================================================================
// Input suggestions
// ============================================================================

export interface SuggestionItem {
  /** Text that replaces the active token when accepted */
  insert: string;
  /** Display name including leading slash for commands */
  display: string;
  description: string;
  usage?: string;
}

const MAX_SUGGESTIONS = 7;

/**
 * Compute input suggestions for the current input value.
 *  - first token: matching command names
 *  - second token: subcommands of the matched command
 */
export function computeSuggestions(registry: CommandRegistry, input: string): SuggestionItem[] {
  if (!input.startsWith('/')) return [];
  const trimmed = input.slice(1);

  const spaceIndex = trimmed.search(/\s/);
  if (spaceIndex === -1) {
    const prefix = trimmed.toLowerCase();
    const names = registry.completions(prefix);
    return names.slice(0, MAX_SUGGESTIONS).map((name) => {
      const match = registry.find(name);
      const def = match?.definition;
      const item: SuggestionItem = {
        insert: `/${name}`,
        display: `/${name}`,
        description: def?.description ?? '',
      };
      if (def?.usage) item.usage = def.usage;
      return item;
    });
  }

  // Subcommand position
  const commandName = trimmed.slice(0, spaceIndex).toLowerCase();
  const match = registry.find(commandName);
  if (!match) return [];

  const rest = trimmed.slice(spaceIndex + 1);
  if (rest.includes(' ')) return []; // already past the subcommand token

  const def = match.definition;
  if (!def.subcommands || def.subcommands.length === 0) return [];

  const prefix = rest.toLowerCase();
  return def.subcommands
    .filter((sub) => sub.name.toLowerCase().startsWith(prefix))
    .slice(0, MAX_SUGGESTIONS)
    .map((sub) => {
      const item: SuggestionItem = {
        insert: `/${def.name} ${sub.name}`.trimEnd(),
        display: sub.name,
        description: sub.description,
      };
      if (sub.usage) item.usage = sub.usage;
      return item;
    });
}

/** Insert a suggestion, replacing only the token being typed. */
export function applySuggestion(input: string, suggestion: SuggestionItem): string {
  const trimmed = input.slice(1);
  const spaceIndex = trimmed.search(/\s/);
  if (spaceIndex === -1) {
    // Replace the command token
    const insert = suggestion.insert.split(' ')[0]!;
    return `${insert} `;
  }
  // Replace the subcommand token
  const commandName = trimmed.slice(0, spaceIndex);
  const parts = suggestion.insert.split(' ');
  const sub = parts.slice(1).join(' ');
  return `/${commandName} ${sub}`;
}

export function isCredentialCommand(input: string): boolean {
  const parsed = parseInput(input);
  return parsed.kind === 'command' && parsed.command === 'mcp' && parsed.args?.[0] === 'auth';
}

// ============================================================================
// Pickers
// ============================================================================

export interface PickerItem {
  key: string;
  label: string;
  detail: string;
  active: boolean;
}

export function buildModelPickerItems(app: AppState, filter: string): PickerItem[] {
  const items: PickerItem[] = [];
  const active = app.activeModel();
  const query = filter.toLowerCase();

  for (const provider of app.enabledProviders()) {
    const cached = app.catalog.getCached(provider.id, provider.models);
    const models = cached?.models ?? [];
    for (const model of models) {
      if (
        query &&
        !model.id.toLowerCase().includes(query) &&
        !model.displayName.toLowerCase().includes(query)
      ) {
        continue;
      }
      const flags: string[] = [];
      if (model.tools === true) flags.push('tools');
      if (model.reasoning === true) flags.push('reason');
      if (model.accessTier) flags.push(model.accessTier);
      if (model.capabilitySource === 'manual') flags.push('manual');
      items.push({
        key: `${provider.id}/${model.id}`,
        label: `${provider.id}/${model.id}`,
        detail:
          (model.contextLength !== undefined
            ? `ctx ${formatTokens(model.contextLength)}`
            : 'ctx ?') + (flags.length > 0 ? `  [${flags.join(', ')}]` : ''),
        active: active !== null && active.providerId === provider.id && active.modelId === model.id,
      });
    }
  }

  return items;
}

export function buildSessionPickerItems(app: AppState): PickerItem[] {
  return app.sessionManager.list().map((summary) => ({
    key: summary.id,
    label: `${shortenId(summary.id)}  ${summary.name}`,
    detail:
      `${summary.messageCount} msg  ${formatMoney(summary.estimatedCost, summary.currency)}  ` +
      `${formatRelative(summary.updatedAt)}${summary.modelId ? `  ${summary.providerId}/${summary.modelId}` : ''}`,
    active: summary.id === app.session.id,
  }));
}
