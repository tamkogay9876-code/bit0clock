/**
 * Anthropic-compatible adapter tests with deterministic mocks
 */

import { describe, it, expect } from 'bun:test';
import { AnthropicCompatibleAdapter, convertMessages } from './anthropic.js';
import { mockFetch, sseResponse, jsonResponse, errorResponse, anthropicSSE } from './test-utils.js';
import type { ProviderStreamEvent } from './types.js';
import { collectCompletion } from './collect.js';

function makeAdapter(mock: ReturnType<typeof mockFetch>, overrides: Record<string, unknown> = {}) {
  return new AnthropicCompatibleAdapter({
    id: 'test-anthropic',
    displayName: 'Test Anthropic',
    baseUrl: 'https://api.anthropic.test',
    apiKey: 'test-key-123',
    fetchImpl: mock.fetchImpl,
    ...overrides,
  });
}

async function collectEvents(gen: AsyncGenerator<ProviderStreamEvent>) {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('AnthropicCompatibleAdapter', () => {
  describe('request construction', () => {
    it('always includes required max_tokens', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody({ model: 'claude-3', messages: [] }, true);
      expect(typeof body.max_tokens).toBe('number');
    });

    it('sends x-api-key and anthropic-version headers by default', async () => {
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
      const adapter = makeAdapter(mock);
      await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const headers = mock.calls[0]!.init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key-123');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['authorization']).toBeUndefined();
    });

    it('supports bearer auth for gateways', async () => {
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
      const adapter = makeAdapter(mock, { authStyle: 'bearer' });
      await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const headers = mock.calls[0]!.init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer test-key-123');
    });

    it('composes /v1/messages without duplication', async () => {
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
      const adapter = makeAdapter(mock, { baseUrl: 'https://api.anthropic.test/v1' });
      await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      expect(mock.calls[0]!.url).toBe('https://api.anthropic.test/v1/messages');
    });

    it('maps effort levels to thinking budgets', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], reasoning: { effort: 'high' } },
        true,
      );
      const thinking = body.thinking as Record<string, unknown>;
      expect(thinking['type']).toBe('enabled');
      expect(thinking['budget_tokens']).toBe(20000);
      // max_tokens must exceed budget_tokens
      expect(body.max_tokens as number).toBeGreaterThan(thinking['budget_tokens'] as number);
    });

    it('honors explicit budgetTokens', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], reasoning: { effort: 'medium', budgetTokens: 5000 } },
        true,
      );
      const thinking = body.thinking as Record<string, unknown>;
      expect(thinking['budget_tokens']).toBe(5000);
    });

    it('omits thinking for off by default (native Anthropic behavior)', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], reasoning: { effort: 'off' } },
        true,
      );
      expect(body.thinking).toBeUndefined();
    });

    it('sends disabled thinking when gateway supports it', () => {
      const adapter = makeAdapter(mockFetch([]), { sendThinkingDisabled: true });
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], reasoning: { effort: 'off' } },
        true,
      );
      expect(body.thinking).toEqual({ type: 'disabled' });
    });

    it('sends adaptive thinking for auto when gateway supports it', () => {
      const adapter = makeAdapter(mockFetch([]), { supportsAdaptiveThinking: true });
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], reasoning: { effort: 'auto' } },
        true,
      );
      expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('drops temperature when thinking is enabled', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], temperature: 0.7, reasoning: { effort: 'high' } },
        true,
      );
      expect(body.temperature).toBeUndefined();
    });

    it('keeps temperature when thinking is off', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        { model: 'claude-3', messages: [], temperature: 0.7, reasoning: { effort: 'off' } },
        true,
      );
      expect(body.temperature).toBe(0.7);
    });
  });

  describe('message conversion', () => {
    it('hoists system messages to the top-level system field', () => {
      const result = convertMessages({
        model: 'claude-3',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      });
      expect(result.system).toBe('You are helpful.');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!['role']).toBe('user');
    });

    it('merges consecutive tool results into one user message', () => {
      const result = convertMessages({
        model: 'claude-3',
        messages: [
          { role: 'user', content: 'do things' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't1', name: 'a', arguments: {} },
              { id: 't2', name: 'b', arguments: {} },
            ],
          },
          {
            role: 'tool',
            content: '',
            toolResults: [{ toolCallId: 't1', content: 'r1', isError: false }],
          },
          {
            role: 'tool',
            content: '',
            toolResults: [{ toolCallId: 't2', content: 'r2', isError: true }],
          },
        ],
      });

      expect(result.messages.length).toBe(3);
      const userWithResults = result.messages[2]!;
      expect(userWithResults['role']).toBe('user');
      const blocks = userWithResults['content'] as Array<Record<string, unknown>>;
      expect(blocks.length).toBe(2);
      expect(blocks[0]!['type']).toBe('tool_result');
      expect(blocks[0]!['tool_use_id']).toBe('t1');
      expect(blocks[1]!['is_error']).toBe(true);
    });

    it('converts assistant tool calls to tool_use blocks', () => {
      const result = convertMessages({
        model: 'claude-3',
        messages: [
          {
            role: 'assistant',
            content: 'Let me check.',
            toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
        ],
      });
      const blocks = result.messages[0]!['content'] as Array<Record<string, unknown>>;
      expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check.' });
      expect(blocks[1]).toEqual({
        type: 'tool_use',
        id: 't1',
        name: 'read_file',
        input: { path: 'a.ts' },
      });
    });
  });

  describe('streaming', () => {
    it('maps the full named-event lifecycle', async () => {
      const mock = mockFetch([
        sseResponse(
          anthropicSSE([
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 0 } },
              },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hello' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: ' world' },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 17 },
              },
            },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));

      const text = events
        .filter(
          (e): e is Extract<ProviderStreamEvent, { type: 'text-delta' }> => e.type === 'text-delta',
        )
        .map((e) => e.data.text)
        .join('');
      expect(text).toBe('Hello world');

      const usageEvents = events.filter((e) => e.type === 'usage-updated');
      expect(usageEvents.length).toBeGreaterThanOrEqual(2);

      const done = events[events.length - 1]!;
      expect(done.type).toBe('response-completed');
      expect((done as any).data.stopReason).toBe('end_turn');
    });

    it('reassembles streamed tool_use input_json_delta', async () => {
      const mock = mockFetch([
        sseResponse(
          anthropicSSE([
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: { usage: { input_tokens: 5, output_tokens: 0 } },
              },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"pa' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: 'th":"x.ts"}' },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 20 },
              },
            },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));

      const started = events.find((e) => e.type === 'tool-call-started')!;
      expect((started as any).data).toEqual({ id: 'toolu_1', name: 'read_file', index: 0 });

      const completed = events.find((e) => e.type === 'tool-call-completed')!;
      expect((completed as any).data.arguments).toEqual({ path: 'x.ts' });

      const done = events[events.length - 1]!;
      expect((done as any).data.stopReason).toBe('tool_use');
    });

    it('maps thinking deltas to reasoning-delta', async () => {
      const mock = mockFetch([
        sseResponse(
          anthropicSSE([
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: { usage: { input_tokens: 5, output_tokens: 0 } },
              },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Let me think' },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const reasoning = events.filter((e) => e.type === 'reasoning-delta');
      expect(reasoning.length).toBe(1);
      expect((reasoning[0] as any).data.text).toBe('Let me think');
    });

    it('treats a stream without message_stop as an error', async () => {
      const mock = mockFetch([
        sseResponse(
          anthropicSSE([
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: { usage: { input_tokens: 5, output_tokens: 0 } },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'partial' },
              },
            },
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const last = events[events.length - 1]!;
      expect(last.type).toBe('error');
      expect((last as any).data.message).toContain('message_stop');
    });

    it('handles mid-stream error events', async () => {
      const mock = mockFetch([
        sseResponse(
          anthropicSSE([
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: { usage: { input_tokens: 5, output_tokens: 0 } },
              },
            },
            {
              event: 'error',
              data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
            },
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('server');
      expect((error as any).data.retryable).toBe(true);
    });
  });

  describe('non-streaming', () => {
    it('aggregates a JSON messages response', async () => {
      const mock = mockFetch([
        jsonResponse({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello there' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 15 },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const result = await collectCompletion(adapter, { model: 'claude-3', messages: [] });

      expect(result.text).toBe('Hello there');
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0]!.name).toBe('get_weather');
      expect(result.toolCalls[0]!.arguments).toEqual({ city: 'Paris' });
      expect(result.stopReason).toBe('tool_use');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(15);
    });
  });

  describe('countTokens', () => {
    it('calls the count_tokens endpoint with the same body shape', async () => {
      const mock = mockFetch([jsonResponse({ input_tokens: 19 })]);
      const adapter = makeAdapter(mock);
      const count = await adapter.countTokens!({
        model: 'claude-3',
        messages: [{ role: 'user', content: 'Hello there' }],
      });
      expect(count).toBe(19);
      expect(mock.calls[0]!.url).toBe('https://api.anthropic.test/v1/messages/count_tokens');
      const body = JSON.parse(mock.calls[0]!.init.body as string);
      expect(body.model).toBe('claude-3');
      expect(body.messages.length).toBe(1);
    });
  });

  describe('listModels', () => {
    it('paginates while has_more is true', async () => {
      const mock = mockFetch([
        jsonResponse({
          data: [{ id: 'claude-3', display_name: 'Claude 3' }],
          has_more: true,
          last_id: 'claude-3',
        }),
        jsonResponse({
          data: [{ id: 'claude-4', display_name: 'Claude 4' }],
          has_more: false,
        }),
      ]);
      const adapter = makeAdapter(mock);
      const models = await adapter.listModels();
      expect(models.map((m) => m.id)).toEqual(['claude-3', 'claude-4']);
      expect(mock.calls.length).toBe(2);
      expect(mock.calls[1]!.url).toContain('after_id=claude-3');
    });
  });

  describe('errors', () => {
    it('parses the Anthropic error shape', async () => {
      const mock = mockFetch([
        errorResponse(401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid x-api-key' },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('authentication');
      expect((error as any).data.message).toBe('Invalid x-api-key');
    });

    it('maps 529 overloaded to retryable', async () => {
      const mock = mockFetch([
        errorResponse(529, {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'claude-3', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.retryable).toBe(true);
    });
  });
});
