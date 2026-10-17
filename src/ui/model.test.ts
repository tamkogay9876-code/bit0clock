/**
 * UI logic tests: transcript helpers, suggestions, picker item builders.
 */

import { describe, expect, it } from 'bun:test';
import {
  appendDelta,
  applySuggestion,
  buildModelPickerItems,
  buildSessionPickerItems,
  computeSuggestions,
  contextUsedTokens,
  finalizeEntry,
  hydrateTranscript,
  isCredentialCommand,
  permissionKeyDecision,
  pushEntry,
  statusParts,
  updateToolEntry,
  type TranscriptEntry,
} from './model.js';
import { CommandRegistry } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtin/index.js';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import type { SessionData } from '../session/types.js';

function makeSession(): SessionData {
  return {
    version: 1,
    id: 'session-1',
    name: 'Test session',
    messages: [],
    mode: 'build',
    reasoning: { effort: 'medium' },
    responseStyle: 'balanced',
    contextProfile: 'standard',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      estimatedCost: 0,
      currency: 'USD',
      requests: 0,
    },
    projectPath: '/tmp/project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('transcript helpers', () => {
  it('hydrates user, assistant, and error entries from a session', () => {
    const session = makeSession();
    session.messages = [
      { id: '1', role: 'user', content: 'hello', timestamp: 't' },
      { id: '2', role: 'assistant', content: 'hi there', timestamp: 't' },
      { id: '3', role: 'assistant', content: '', error: 'Cancelled by the user', timestamp: 't' },
      { id: '4', role: 'assistant', content: 'done', error: 'boom', timestamp: 't' },
    ];

    const entries = hydrateTranscript(session);
    expect(entries.map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'error',
      'assistant',
      'error',
    ]);
    expect(entries[3]?.content).toBe('Cancelled.');
    expect(entries[5]?.content).toBe('boom');
  });

  it('applies deltas immutably', () => {
    const entries: TranscriptEntry[] = [{ id: 'a', role: 'assistant', content: 'Hello' }];
    const next = appendDelta(entries, 'a', 'text', ' world');
    expect(next[0]?.content).toBe('Hello world');
    expect(entries[0]?.content).toBe('Hello'); // original untouched

    const withReasoning = appendDelta(next, 'a', 'reasoning', 'thinking…');
    expect(withReasoning[0]?.reasoning).toBe('thinking…');
  });

  it('finalizes streaming entries', () => {
    const entries: TranscriptEntry[] = [
      { id: 'a', role: 'assistant', content: 'x', streaming: true },
    ];
    const done = finalizeEntry(entries, 'a', { content: 'final' });
    expect(done[0]?.streaming).toBe(false);
    expect(done[0]?.content).toBe('final');
  });

  it('pushes new entries with generated ids', () => {
    const entries = pushEntry([], { role: 'system', content: 'note' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBeTruthy();
  });

  it('reads context usage from the last assistant message', () => {
    const session = makeSession();
    session.messages = [
      { id: '1', role: 'assistant', content: 'a', usage: { inputTokens: 100 }, timestamp: 't' },
      { id: '2', role: 'user', content: 'b', timestamp: 't' },
      { id: '3', role: 'assistant', content: 'c', usage: { inputTokens: 250 }, timestamp: 't' },
    ];
    expect(contextUsedTokens(session)).toBe(250);
  });

  it('returns undefined when no usage was reported', () => {
    expect(contextUsedTokens(makeSession())).toBeUndefined();
  });
});

describe('status parts', () => {
  it('describes an unconfigured state honestly', () => {
    const { app } = createTestApp();
    const status = statusParts(app);
    expect(status.model).toContain('no model');
    expect(status.provider).toBe('no provider');
    expect(status.think).toContain('THINK medium');
    expect(status.auto).toBe('AUTO off');

    app.setAutoApprove(true);
    expect(statusParts(app).auto).toBe('AUTO ON');
  });

  it('shows model, context, and estimated cost once configured', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push({
      id: 'm1',
      role: 'assistant',
      content: 'x',
      usage: { inputTokens: 1200 },
      timestamp: 't',
    });

    const status = statusParts(app);
    expect(status.model).toBe('vendor/alpha-model');
    expect(status.context).toBe('CTX 1.2k/128k');
    expect(status.cost).toContain('est.');
  });
});

describe('input suggestions', () => {
  function makeRegistry() {
    const { app } = createTestApp();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry, app);
    return registry;
  }

  it('returns nothing for plain text', () => {
    expect(computeSuggestions(makeRegistry(), 'hello')).toEqual([]);
  });

  it('suggests command names by prefix, prefix matches first', () => {
    const suggestions = computeSuggestions(makeRegistry(), '/th');
    const names = suggestions.map((s) => s.display);
    expect(names).toContain('/think');
    expect(names[0]).toBe('/think');
  });

  it('suggests subcommands after a space', () => {
    const suggestions = computeSuggestions(makeRegistry(), '/think b');
    expect(suggestions.map((s) => s.display)).toEqual(['budget']);
    expect(suggestions[0]?.insert).toBe('/think budget');
  });

  it('suggests session subcommands', () => {
    const suggestions = computeSuggestions(makeRegistry(), '/session re');
    const names = suggestions.map((s) => s.display);
    expect(names).toContain('rename');
  });

  it('returns no subcommand suggestions for unknown commands', () => {
    expect(computeSuggestions(makeRegistry(), '/nope x')).toEqual([]);
  });

  it('applies a command suggestion', () => {
    const registry = makeRegistry();
    const [suggestion] = computeSuggestions(registry, '/thi');
    const applied = applySuggestion('/thi', suggestion!);
    expect(applied.startsWith('/think')).toBe(true);
  });

  it('applies a subcommand suggestion, replacing the partial token', () => {
    const registry = makeRegistry();
    const [suggestion] = computeSuggestions(registry, '/think b');
    expect(applySuggestion('/think b', suggestion!)).toBe('/think budget');
  });
});

describe('credential input history', () => {
  it('identifies MCP auth commands so their arguments are not retained in history', () => {
    expect(isCredentialCommand('/mcp auth server secret-value')).toBe(true);
    expect(isCredentialCommand('/mcp auth server --key-env=SERVER_KEY')).toBe(true);
    expect(isCredentialCommand('/mcp list')).toBe(false);
  });
});

describe('picker item builders', () => {
  it('builds model items across providers with the active one marked', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');

    const items = buildModelPickerItems(app, '');
    expect(items).toHaveLength(2);
    const active = items.find((i) => i.active);
    expect(active?.key).toBe('test/vendor/alpha-model');
    expect(items[0]?.detail).toContain('ctx 128k');
  });

  it('filters model items case-insensitively', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    expect(buildModelPickerItems(app, 'BETA')).toHaveLength(1);
    expect(buildModelPickerItems(app, 'zzz')).toHaveLength(0);
  });

  it('builds session items with the current session marked', async () => {
    const { app } = createTestApp();
    const first = app.session.id;
    app.sessionManager.create({ name: 'Another one' });

    const items = buildSessionPickerItems(app);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.find((i) => i.active)?.key).toBe(first);
  });
});

describe('tool transcript entries', () => {
  it('hydrates tool entries with names resolved from the assistant tool calls', () => {
    const session = makeSession();
    session.messages = [
      { id: '1', role: 'user', content: 'read it', timestamp: 't' },
      {
        id: '2',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
        timestamp: 't',
      },
      {
        id: '3',
        role: 'tool',
        content: 'file body',
        toolResults: [{ toolCallId: 'call_1', content: 'file body', isError: false }],
        timestamp: 't',
      },
      { id: '4', role: 'assistant', content: 'done', timestamp: 't' },
    ];

    const entries = hydrateTranscript(session);
    expect(entries.map((e) => e.role)).toEqual(['user', 'tool', 'assistant']);
    expect(entries[1]?.tool?.name).toBe('read_file');
    expect(entries[1]?.tool?.status).toBe('ok');
    expect(entries[1]?.content).toBe('file body');
  });

  it('marks error results and keeps assistant text next to tool calls', () => {
    const session = makeSession();
    session.messages = [
      {
        id: '1',
        role: 'assistant',
        content: 'trying something',
        toolCalls: [{ id: 'c1', name: 'run_command', arguments: {} }],
        timestamp: 't',
      },
      {
        id: '2',
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'c1', content: 'denied', isError: true }],
        timestamp: 't',
      },
    ];

    const entries = hydrateTranscript(session);
    expect(entries.map((e) => e.role)).toEqual(['assistant', 'tool']);
    expect(entries[1]?.tool?.status).toBe('error');
  });

  it('updates tool entries immutably', () => {
    const entries: TranscriptEntry[] = [
      { id: 't1', role: 'tool', content: '', tool: { name: 'read_file', status: 'running' } },
    ];
    const next = updateToolEntry(entries, 't1', {
      content: 'result',
      tool: { status: 'ok', durationMs: 12 },
    });

    expect(next[0]?.content).toBe('result');
    expect(next[0]?.tool).toEqual({ name: 'read_file', status: 'ok', durationMs: 12 });
    expect(entries[0]?.tool?.status).toBe('running'); // original untouched
  });

  it('ignores updates for unknown entries', () => {
    const entries: TranscriptEntry[] = [
      { id: 't1', role: 'tool', content: '', tool: { name: 'read_file', status: 'running' } },
    ];
    const next = updateToolEntry(entries, 'nope', { content: 'x' });
    expect(next[0]?.content).toBe('');
  });
});

describe('permissionKeyDecision', () => {
  it('maps y/a/n and Escape to decisions', () => {
    expect(permissionKeyDecision('y', {})).toBe('allow');
    expect(permissionKeyDecision('Y', {})).toBe('allow');
    expect(permissionKeyDecision('a', {})).toBe('allow-session');
    expect(permissionKeyDecision('n', {})).toBe('deny');
    expect(permissionKeyDecision('', { escape: true })).toBe('deny');
  });

  it('ignores unrelated keys', () => {
    expect(permissionKeyDecision('x', {})).toBeNull();
    expect(permissionKeyDecision('', {})).toBeNull();
    expect(permissionKeyDecision('enter', {})).toBeNull();
  });
});
