/**
 * xKiro provider tests.
 *
 * Verifies documented behavior:
 *  - base URL https://api.xkiro.com
 *  - POST /v1/chat/completions and POST /v1/messages endpoints
 *  - Bearer or x-api-key authentication
 *  - no /v1 duplication when the configured base URL includes /v1
 */

import { describe, it, expect } from 'bun:test';
import {
  createXKiroAdapter,
  extractXKiroUsageValues,
  XKIRO_DEFAULT_BASE_URL,
  XKIRO_ENDPOINTS,
  xkiroMetadata,
} from './xkiro.js';
import { mockFetch, jsonResponse, sseResponse, openaiSSE, anthropicSSE } from './test-utils.js';
import type { ProviderStreamEvent } from './types.js';

async function collectEvents(gen: AsyncGenerator<ProviderStreamEvent>) {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('xKiro provider', () => {
  it('defaults to the documented host and messages protocol', () => {
    const mock = mockFetch([]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    expect(adapter.metadata.baseUrl).toBe(XKIRO_DEFAULT_BASE_URL);
    expect(adapter.metadata.protocol).toBe('anthropic-messages');
  });

  it('exposes documented endpoint paths', () => {
    expect(XKIRO_ENDPOINTS.chatCompletions).toBe('/v1/chat/completions');
    expect(XKIRO_ENDPOINTS.messages).toBe('/v1/messages');
    expect(XKIRO_ENDPOINTS.countTokens).toBe('/v1/messages/count_tokens');
    expect(XKIRO_ENDPOINTS.models).toBe('/v1/models');
  });

  it('calls POST /v1/chat/completions on the openai-chat protocol', async () => {
    const mock = mockFetch([
      sseResponse(
        openaiSSE([
          { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] },
          '[DONE]',
        ]),
      ),
    ]);
    const adapter = createXKiroAdapter({
      apiKey: 'key1',
      protocol: 'openai-chat',
      fetchImpl: mock.fetchImpl,
    });
    await collectEvents(adapter.chat({ model: 'openai/gpt-5.6-sol', messages: [] }));

    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/chat/completions');
    const headers = mock.calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer key1');
  });

  it('calls POST /v1/messages on the anthropic-messages protocol with x-api-key', async () => {
    const mock = mockFetch([
      sseResponse(
        anthropicSSE([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: { usage: { input_tokens: 1, output_tokens: 0 } },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    ]);
    const adapter = createXKiroAdapter({
      apiKey: 'key2',
      protocol: 'anthropic-messages',
      fetchImpl: mock.fetchImpl,
    });
    await collectEvents(adapter.chat({ model: 'anthropic/claude-opus-5', messages: [] }));

    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/messages');
    const headers = mock.calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('key2');
    expect(headers['anthropic-version']).toBeDefined();
  });

  it('does not duplicate /v1 when base URL is written with /v1', async () => {
    const mock = mockFetch([
      sseResponse(
        anthropicSSE([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: { usage: { input_tokens: 1, output_tokens: 0 } },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    ]);
    const adapter = createXKiroAdapter({
      apiKey: 'k',
      baseUrl: 'https://api.xkiro.com/v1',
      fetchImpl: mock.fetchImpl,
    });
    await collectEvents(adapter.chat({ model: 'z-ai/glm-5.3', messages: [] }));
    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/messages');
  });

  it('discovers models from GET /v1/models with full vendor/model IDs preserved', async () => {
    const mock = mockFetch([
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'z-ai/glm-5.3',
            object: 'model',
            display_name: 'GLM 5.3',
            owned_by: 'z-ai',
            access_tier: 'paid',
            context_length: 200000,
            max_output_tokens: 65536,
            pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0.44, output: 1.86 },
            capabilities: { vision: false, tools: true, reasoning: true },
            reasoning_efforts: { levels: ['low', 'high', 'max'], default: 'high' },
          },
        ],
      }),
    ]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    const models = await adapter.listModels();

    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/models');
    expect(models[0]!.id).toBe('z-ai/glm-5.3');
    expect(models[0]!.accessTier).toBe('paid');
    expect(models[0]!.pricing).toEqual({
      input: 0.44,
      output: 1.86,
      cacheRead: undefined,
      cacheWrite: undefined,
      currency: 'USD',
    });
  });

  it('counts tokens through POST /v1/messages/count_tokens', async () => {
    const mock = mockFetch([jsonResponse({ input_tokens: 19 })]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    const count = await adapter.countTokens!({
      model: 'anthropic/claude-opus-5',
      system: 'You are a concise assistant.',
      messages: [{ role: 'user', content: 'Hello there' }],
    });
    expect(count).toBe(19);
    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/messages/count_tokens');
  });

  it('maps the documented retryable statuses (429/500/502/503)', async () => {
    for (const status of [429, 500, 502, 503]) {
      const mock = mockFetch([
        new Response(
          JSON.stringify({ error: { message: `err ${status}`, type: 'server_error' } }),
          { status },
        ),
      ]);
      const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
      const events = await collectEvents(adapter.chat({ model: 'x/y', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.retryable).toBe(true);
    }
  });

  it('maps 402 insufficient_quota as not retryable', async () => {
    const mock = mockFetch([
      new Response(
        JSON.stringify({
          error: {
            message: 'Insufficient balance. Top up your wallet to continue.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
        { status: 402 },
      ),
    ]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    const events = await collectEvents(adapter.chat({ model: 'x/y', messages: [] }));
    const error = events.find((e) => e.type === 'error')!;
    expect((error as any).data.category).toBe('insufficient-quota');
    expect((error as any).data.retryable).toBe(false);
  });

  it('maps 403 permission_error for access-tier gating', async () => {
    const mock = mockFetch([
      new Response(
        JSON.stringify({
          error: {
            message: 'Not entitled to this model',
            type: 'permission_error',
            code: 'permission_denied',
          },
        }),
        { status: 403 },
      ),
    ]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    const events = await collectEvents(adapter.chat({ model: 'premium/model', messages: [] }));
    const error = events.find((e) => e.type === 'error')!;
    expect((error as any).data.category).toBe('permission-denied');
    expect((error as any).data.retryable).toBe(false);
  });

  it('metadata starts unverified (never claims verification without a live call)', () => {
    const meta = xkiroMetadata();
    expect(meta.verified).toBe(false);
    expect(meta.supportsTokenCounting).toBe(true);
  });
});

describe('xKiro getAccountUsage (GET /v1/usage)', () => {
  it('returns recognized balance fields as provider-reported values', async () => {
    const mock = mockFetch([jsonResponse({ balance: 12.5, currency: 'USD' })]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });

    const result = await adapter.getAccountUsage!();
    expect(result.available).toBe(true);
    expect(result.message).toContain('/v1/usage');
    expect(result.values).toEqual([{ label: 'balance', value: '12.5000 USD' }]);
    expect(result.raw).toEqual({ balance: 12.5, currency: 'USD' });
    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/usage');
    expect(mock.calls[0]!.init.method).toBe('GET');
  });

  it('reads nested data envelopes and integer fields', async () => {
    const mock = mockFetch([jsonResponse({ data: { credits_remaining: 250, currency: 'EUR' } })]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    const result = await adapter.getAccountUsage!();
    expect(result.available).toBe(true);
    expect(result.values).toEqual([{ label: 'credits remaining', value: '250 EUR' }]);
  });

  it('never invents values for unrecognized shapes', async () => {
    const mock = mockFetch([jsonResponse({ weird: { nested: 'yes' }, balance: 'lots' })]);
    const adapter = createXKiroAdapter({ apiKey: 'k', fetchImpl: mock.fetchImpl });
    const result = await adapter.getAccountUsage!();
    expect(result.available).toBe(false);
    expect(result.values ?? []).toHaveLength(0);
    expect(result.message).toContain('no values are invented');
  });

  it('reports HTTP failures and non-JSON bodies without values', async () => {
    const httpMock = mockFetch([
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }),
    ]);
    const httpResult = await createXKiroAdapter({
      apiKey: 'bad',
      fetchImpl: httpMock.fetchImpl,
    }).getAccountUsage!();
    expect(httpResult.available).toBe(false);
    expect(httpResult.values ?? []).toHaveLength(0);

    const htmlMock = mockFetch([new Response('<html>maintenance</html>', { status: 200 })]);
    const htmlResult = await createXKiroAdapter({
      apiKey: 'k',
      fetchImpl: htmlMock.fetchImpl,
    }).getAccountUsage!();
    expect(htmlResult.available).toBe(false);
    expect(htmlResult.message).toContain('not JSON');
  });

  it('reports unreachable providers instead of throwing', async () => {
    const mock = mockFetch([
      () => {
        throw new Error('network down');
      },
    ]);
    const result = await createXKiroAdapter({
      apiKey: 'k',
      fetchImpl: mock.fetchImpl,
    }).getAccountUsage!();
    expect(result.available).toBe(false);
    expect(result.message).toContain('Cannot reach xKiro');
  });
});

describe('extractXKiroUsageValues', () => {
  it('returns no values for non-object payloads', () => {
    expect(extractXKiroUsageValues(null).values).toEqual([]);
    expect(extractXKiroUsageValues('balance: 5').values).toEqual([]);
    expect(extractXKiroUsageValues(42).values).toEqual([]);
  });

  it('ignores non-numeric fields and formats floats to four decimals', () => {
    const { values } = extractXKiroUsageValues({
      balance: '10',
      used: 1.23456,
      quota: Number.NaN,
      limit: Number.POSITIVE_INFINITY,
    });
    expect(values).toEqual([{ label: 'used', value: '1.2346' }]);
  });

  it('de-duplicates labels sharing the same meaning', () => {
    const { values } = extractXKiroUsageValues({
      credits_remaining: 5,
      credit_remaining: 7,
      remaining_credits: 9,
    });
    expect(values).toEqual([{ label: 'credits remaining', value: '5' }]);
  });
});
