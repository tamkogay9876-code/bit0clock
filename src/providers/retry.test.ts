/**
 * Retry safety tests.
 *
 * The critical guarantee: retries happen ONLY when nothing has been received,
 * so a retried request can never duplicate charged output or side effects.
 */

import { describe, it, expect } from 'bun:test';
import { chatWithRetry } from './retry.js';
import type { ChatRequest, ProviderAdapter, ProviderStreamEvent } from './types.js';
import type { ProviderMetadata } from '../types/index.js';

function makeScriptedAdapter(scripts: Array<ProviderStreamEvent[]>): {
  adapter: ProviderAdapter;
  attempts: () => number;
} {
  let attempt = 0;
  const adapter: ProviderAdapter = {
    id: 'scripted',
    metadata: {
      id: 'scripted',
      type: 'openai-compatible',
      displayName: 'Scripted',
      baseUrl: 'https://x',
      protocol: 'openai-chat',
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsReasoning: false,
      supportsImageInput: false,
      supportsTokenCounting: false,
      enabled: true,
      verified: false,
    } as ProviderMetadata,
    async *chat(): AsyncGenerator<ProviderStreamEvent> {
      const script = scripts[Math.min(attempt, scripts.length - 1)]!;
      attempt++;
      for (const ev of script) yield ev;
    },
    async listModels() {
      return [];
    },
  };
  return { adapter, attempts: () => attempt };
}

function ev<T extends ProviderStreamEvent['type']>(type: T, data: unknown): ProviderStreamEvent {
  return { type, data, timestamp: new Date().toISOString() } as ProviderStreamEvent;
}

const request: ChatRequest = { model: 'test', messages: [] };

async function collect(gen: AsyncGenerator<ProviderStreamEvent>) {
  const events: ProviderStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('chatWithRetry', () => {
  it('retries a retryable error that arrives before any data', async () => {
    const { adapter, attempts } = makeScriptedAdapter([
      [
        ev('response-started', { model: 'test' }),
        ev('error', {
          category: 'rate-limit',
          message: 'slow down',
          retryable: true,
          retryAfterMs: 1,
        }),
      ],
      [
        ev('response-started', { model: 'test' }),
        ev('text-delta', { text: 'ok' }),
        ev('response-completed', { stopReason: 'stop', toolCalls: [] }),
      ],
    ]);

    const events = await collect(
      chatWithRetry(adapter, request, undefined, { baseDelayMs: 1, maxDelayMs: 5 }),
    );

    expect(attempts()).toBe(2);
    const text = events
      .filter(
        (e): e is Extract<ProviderStreamEvent, { type: 'text-delta' }> => e.type === 'text-delta',
      )
      .map((e) => e.data.text)
      .join('');
    expect(text).toBe('ok');
    // No error event should surface when the retry succeeded
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('does NOT retry once data has been received (no duplicate charges)', async () => {
    const { adapter, attempts } = makeScriptedAdapter([
      [
        ev('response-started', { model: 'test' }),
        ev('text-delta', { text: 'partial output' }),
        ev('error', {
          category: 'server',
          message: 'upstream died',
          retryable: true,
        }),
      ],
      [
        ev('response-started', { model: 'test' }),
        ev('text-delta', { text: 'second try' }),
        ev('response-completed', { stopReason: 'stop', toolCalls: [] }),
      ],
    ]);

    const events = await collect(
      chatWithRetry(adapter, request, undefined, { baseDelayMs: 1, maxDelayMs: 5 }),
    );

    expect(attempts()).toBe(1);
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
  });

  it('does not retry non-retryable errors', async () => {
    const { adapter, attempts } = makeScriptedAdapter([
      [
        ev('response-started', { model: 'test' }),
        ev('error', { category: 'authentication', message: 'bad key', retryable: false }),
      ],
      [
        ev('response-started', { model: 'test' }),
        ev('text-delta', { text: 'should not happen' }),
        ev('response-completed', { stopReason: 'stop', toolCalls: [] }),
      ],
    ]);

    const events = await collect(
      chatWithRetry(adapter, request, undefined, { baseDelayMs: 1, maxDelayMs: 5 }),
    );

    expect(attempts()).toBe(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('stops retrying after maxAttempts', async () => {
    const errorScript: ProviderStreamEvent[] = [
      ev('response-started', { model: 'test' }),
      ev('error', {
        category: 'rate-limit',
        message: 'always busy',
        retryable: true,
        retryAfterMs: 1,
      }),
    ];
    const { adapter, attempts } = makeScriptedAdapter([errorScript]);

    const events = await collect(
      chatWithRetry(adapter, request, undefined, { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 3 }),
    );

    expect(attempts()).toBe(3);
    expect(events[events.length - 1]!.type).toBe('error');
  });

  it('propagates cancellation immediately without retrying', async () => {
    const controller = new AbortController();
    const { adapter, attempts } = makeScriptedAdapter([
      [ev('response-started', { model: 'test' }), ev('cancelled', { reason: 'aborted' })],
      [ev('text-delta', { text: 'nope' })],
    ]);

    controller.abort();
    const events = await collect(
      chatWithRetry(adapter, request, controller.signal, { baseDelayMs: 1 }),
    );

    expect(attempts()).toBe(1);
    expect(events.some((e) => e.type === 'cancelled')).toBe(true);
  });

  it('reports retries through onRetry diagnostics', async () => {
    const retries: number[] = [];
    const { adapter } = makeScriptedAdapter([
      [
        ev('response-started', { model: 'test' }),
        ev('error', {
          category: 'network',
          message: 'econnrefused',
          retryable: true,
          retryAfterMs: 1,
        }),
      ],
      [
        ev('response-started', { model: 'test' }),
        ev('response-completed', { stopReason: 'stop', toolCalls: [] }),
      ],
    ]);

    await collect(
      chatWithRetry(adapter, request, undefined, {
        baseDelayMs: 1,
        maxDelayMs: 5,
        onRetry: ({ attempt }) => retries.push(attempt),
      }),
    );

    expect(retries).toEqual([1]);
  });
});
