/**
 * OpenAI-compatible adapter tests with deterministic mocks
 */

import { describe, it, expect } from 'bun:test';
import { OpenAICompatibleAdapter } from './openai.js';
import { mockFetch, sseResponse, jsonResponse, errorResponse, openaiSSE } from './test-utils.js';
import type { ProviderStreamEvent } from './types.js';
import { collectCompletion } from './collect.js';

function makeAdapter(mock: ReturnType<typeof mockFetch>) {
  return new OpenAICompatibleAdapter({
    id: 'test-openai',
    displayName: 'Test OpenAI',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key-123',
    fetchImpl: mock.fetchImpl,
  });
}

async function collectEvents(gen: AsyncGenerator<ProviderStreamEvent>) {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('OpenAICompatibleAdapter', () => {
  describe('request construction', () => {
    it('builds a streaming body with stream_options', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
          maxOutputTokens: 1000,
          temperature: 0.5,
        },
        true,
      );
      expect(body.model).toBe('gpt-4');
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.max_tokens).toBe(1000);
      expect(body.temperature).toBe(0.5);
    });

    it('converts tools to function schemas', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }],
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            },
          ],
        },
        false,
      );
      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools.length).toBe(1);
      expect(tools[0]!['type']).toBe('function');
      const fn = tools[0]!['function'] as Record<string, unknown>;
      expect(fn['name']).toBe('read_file');
      expect(fn['parameters']).toEqual({
        type: 'object',
        properties: { path: { type: 'string' } },
      });
    });

    it('maps reasoning effort', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        {
          model: 'gpt-4',
          messages: [],
          reasoning: { effort: 'high' },
        },
        false,
      );
      expect(body.reasoning_effort).toBe('high');
    });

    it('maps off and auto efforts', () => {
      const adapter = makeAdapter(mockFetch([]));
      const off = adapter.buildChatBody(
        { model: 'gpt-4', messages: [], reasoning: { effort: 'off' } },
        false,
      );
      expect(off.reasoning_effort).toBe('none');
      const auto = adapter.buildChatBody(
        { model: 'gpt-4', messages: [], reasoning: { effort: 'auto' } },
        false,
      );
      expect(auto.reasoning_effort).toBe('adaptive');
    });

    it('converts assistant tool calls and tool results', () => {
      const adapter = makeAdapter(mockFetch([]));
      const body = adapter.buildChatBody(
        {
          model: 'gpt-4',
          messages: [
            { role: 'user', content: 'read the file' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
            },
            {
              role: 'tool',
              content: '',
              toolResults: [{ toolCallId: 'call_1', content: 'file contents', isError: false }],
            },
          ],
        },
        false,
      );
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages.length).toBe(3);
      const assistant = messages[1]!;
      expect(assistant['tool_calls']).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        },
      ]);
      const tool = messages[2]!;
      expect(tool['role']).toBe('tool');
      expect(tool['tool_call_id']).toBe('call_1');
    });

    it('sets bearer auth header by default', async () => {
      const mock = mockFetch([
        sseResponse(openaiSSE([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])),
      ]);
      const adapter = makeAdapter(mock);
      await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const headers = mock.calls[0]!.init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer test-key-123');
    });

    it('uses x-api-key style when configured', async () => {
      const mock = mockFetch([
        sseResponse(openaiSSE([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])),
      ]);
      const adapter = new OpenAICompatibleAdapter({
        id: 'test',
        displayName: 'Test',
        baseUrl: 'https://api.test.com',
        apiKey: 'secret',
        authStyle: 'x-api-key',
        fetchImpl: mock.fetchImpl,
      });
      await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const headers = mock.calls[0]!.init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('secret');
      expect(headers['authorization']).toBeUndefined();
    });

    it('composes endpoint without duplicating /v1', async () => {
      const mock = mockFetch([
        sseResponse(openaiSSE([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])),
      ]);
      const adapter = makeAdapter(mock);
      await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      expect(mock.calls[0]!.url).toBe('https://api.test.com/v1/chat/completions');
    });
  });

  describe('streaming', () => {
    it('emits text deltas and usage from a streaming response', async () => {
      const mock = mockFetch([
        sseResponse(
          openaiSSE([
            {
              id: 'c1',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            },
            { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
            {
              id: 'c1',
              choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
            },
            { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            {
              id: 'c1',
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
            '[DONE]',
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));

      const types = events.map((e) => e.type);
      expect(types[0]).toBe('response-started');
      expect(types).toContain('text-delta');
      expect(types).toContain('usage-updated');
      expect(types[types.length - 1]).toBe('response-completed');

      const text = events
        .filter(
          (e): e is Extract<ProviderStreamEvent, { type: 'text-delta' }> => e.type === 'text-delta',
        )
        .map((e) => e.data.text)
        .join('');
      expect(text).toBe('Hello world');

      const usage = events.find((e) => e.type === 'usage-updated')!;
      expect(usage.data).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: undefined,
        reasoningTokens: undefined,
      });
    });

    it('reassembles streamed tool call arguments before completing', async () => {
      const mock = mockFetch([
        sseResponse(
          openaiSSE([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_abc',
                        type: 'function',
                        function: { name: 'read_file' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));

      const started = events.find((e) => e.type === 'tool-call-started');
      expect(started).toBeDefined();
      expect((started as any).data.name).toBe('read_file');

      const completed = events.find((e) => e.type === 'tool-call-completed');
      expect(completed).toBeDefined();
      expect((completed as any).data.arguments).toEqual({ path: 'a.ts' });

      const done = events[events.length - 1];
      expect(done.type).toBe('response-completed');
      expect((done as any).data.stopReason).toBe('tool_calls');
      expect((done as any).data.toolCalls.length).toBe(1);
    });

    it('emits tool-call-invalid for malformed JSON arguments', async () => {
      const mock = mockFetch([
        sseResponse(
          openaiSSE([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        function: { name: 'bad_tool', arguments: '{"broken' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
            '[DONE]',
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));

      const invalid = events.find((e) => e.type === 'tool-call-invalid');
      expect(invalid).toBeDefined();
      expect((invalid as any).data.rawArguments).toBe('{"broken');

      // Invalid calls must NOT appear in the completed list
      const done = events[events.length - 1];
      expect(done.type).toBe('response-completed');
      expect((done as any).data.toolCalls.length).toBe(0);
    });

    it('emits reasoning deltas when present', async () => {
      const mock = mockFetch([
        sseResponse(
          openaiSSE([
            {
              choices: [
                { index: 0, delta: { reasoning_content: 'Thinking...' }, finish_reason: null },
              ],
            },
            { choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            '[DONE]',
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'deepseek-r1', messages: [] }));

      const reasoning = events.filter((e) => e.type === 'reasoning-delta');
      expect(reasoning.length).toBe(1);
      expect((reasoning[0] as any).data.text).toBe('Thinking...');
    });

    it('handles mid-stream error frames', async () => {
      const mock = mockFetch([
        sseResponse(
          openaiSSE([
            { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] },
            {
              error: {
                message: 'Upstream provider is unavailable. Please retry.',
                type: 'api_error',
                code: 'upstream_error',
              },
            },
            '[DONE]',
          ]),
        ),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));

      const error = events.find((e) => e.type === 'error');
      expect(error).toBeDefined();
      expect((error as any).data.message).toContain('Upstream provider is unavailable');
    });

    it('survives malformed JSON frames', async () => {
      const mock = mockFetch([
        sseResponse([
          'data: {not json\n\n',
          ...openaiSSE([
            { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
            '[DONE]',
          ]),
        ]),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      expect(events.some((e) => e.type === 'text-delta')).toBe(true);
      expect(events[events.length - 1]!.type).toBe('response-completed');
    });

    it('handles a truncated stream without terminator', async () => {
      const mock = mockFetch([sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'])]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));

      // Partial content followed by a dead connection must not look like success
      const last = events[events.length - 1]!;
      expect(last.type).toBe('error');
      expect((last as any).data.message).toContain('terminator');
    });
  });

  describe('non-streaming', () => {
    it('aggregates a JSON completion into the same event shape', async () => {
      const mock = mockFetch([
        jsonResponse({
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello from JSON',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'do_thing', arguments: '{"x":1}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(
        adapter.chat({ model: 'gpt-4', messages: [], stream: false }),
      );

      const text = events
        .filter(
          (e): e is Extract<ProviderStreamEvent, { type: 'text-delta' }> => e.type === 'text-delta',
        )
        .map((e) => e.data.text)
        .join('');
      expect(text).toBe('Hello from JSON');
      expect(events.some((e) => e.type === 'tool-call-completed')).toBe(true);
      expect(events[events.length - 1]!.type).toBe('response-completed');
    });

    it('collectCompletion helper returns a full result', async () => {
      const mock = mockFetch([
        jsonResponse({
          choices: [{ index: 0, message: { content: 'Result text' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const result = await collectCompletion(adapter, { model: 'gpt-4', messages: [] });
      expect(result.text).toBe('Result text');
      expect(result.stopReason).toBe('stop');
      expect(result.usage.inputTokens).toBe(5);
      expect(result.error).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('maps 401 to authentication error', async () => {
      const mock = mockFetch([
        errorResponse(401, { error: { message: 'Invalid API key', type: 'authentication_error' } }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('authentication');
      expect((error as any).data.retryable).toBe(false);
    });

    it('maps 429 to retryable rate limit', async () => {
      const mock = mockFetch([
        errorResponse(429, { error: { message: 'Slow down', type: 'rate_limit_error' } }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('rate-limit');
      expect((error as any).data.retryable).toBe(true);
    });

    it('maps 402 to insufficient quota (not retryable)', async () => {
      const mock = mockFetch([
        errorResponse(402, {
          error: {
            message: 'Insufficient balance',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('insufficient-quota');
      expect((error as any).data.retryable).toBe(false);
    });

    it('maps 503 to retryable server error', async () => {
      const mock = mockFetch([
        errorResponse(503, { error: { message: 'Service unavailable', type: 'server_error' } }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('server');
      expect((error as any).data.retryable).toBe(true);
    });

    it('maps network failures to retryable network errors', async () => {
      const mock = mockFetch([
        () => {
          throw new TypeError('fetch failed: ECONNREFUSED');
        },
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('network');
      expect((error as any).data.retryable).toBe(true);
    });

    it('recognizes context overflow in 400 responses', async () => {
      const mock = mockFetch([
        errorResponse(400, {
          error: {
            message:
              'Input is ~164970 tokens, which exceeds the safe limit of 160000 tokens for this model.',
            type: 'invalid_request_error',
          },
        }),
      ]);
      const adapter = makeAdapter(mock);
      const events = await collectEvents(adapter.chat({ model: 'gpt-4', messages: [] }));
      const error = events.find((e) => e.type === 'error')!;
      expect((error as any).data.category).toBe('context-overflow');
      expect((error as any).data.retryable).toBe(false);
    });
  });

  describe('listModels', () => {
    it('parses provider-reported metadata without inferring limits', async () => {
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
            {
              id: 'mystery/model-5m-long',
              // No context_length reported: must stay undefined despite the name
            },
          ],
        }),
      ]);
      const adapter = makeAdapter(mock);
      const models = await adapter.listModels();

      expect(models.length).toBe(2);

      const glm = models[0]!;
      expect(glm.id).toBe('z-ai/glm-5.3');
      expect(glm.displayName).toBe('GLM 5.3');
      expect(glm.contextLength).toBe(200000);
      expect(glm.maxOutputTokens).toBe(65536);
      expect(glm.tools).toBe(true);
      expect(glm.reasoning).toBe(true);
      expect(glm.accessTier).toBe('paid');
      expect(glm.pricing?.input).toBe(0.44);
      expect(glm.pricing?.output).toBe(1.86);
      expect(glm.reasoningLevels).toEqual(['low', 'high', 'max']);

      // CRITICAL: never infer a context window from the model name
      const mystery = models[1]!;
      expect(mystery.contextLength).toBeUndefined();
      expect(mystery.maxOutputTokens).toBeUndefined();
    });
  });

  describe('validateCredentials', () => {
    it('reports ok for 200', async () => {
      const mock = mockFetch([jsonResponse({ data: [] })]);
      const adapter = makeAdapter(mock);
      const result = await adapter.validateCredentials();
      expect(result.ok).toBe(true);
    });

    it('reports failure with message for 401', async () => {
      const mock = mockFetch([errorResponse(401, { error: { message: 'Invalid API key' } })]);
      const adapter = makeAdapter(mock);
      const result = await adapter.validateCredentials();
      expect(result.ok).toBe(false);
      expect(result.message).toBe('Invalid API key');
    });
  });
});
