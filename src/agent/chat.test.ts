/**
 * Chat service tests: request building, streaming persistence, usage,
 * error and cancellation paths.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildChatRequest,
  buildSystemPrompt,
  sendChatMessage,
  toInternalMessages,
} from './chat.js';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import {
  errorResponse,
  jsonResponse,
  mockFetch,
  openaiSSE,
  sseResponse,
} from '../providers/test-utils.js';

function makeChatApp(fetchImpl: typeof fetch, seed = true) {
  return createTestApp({
    providers: [testProvider()],
    ...(seed ? { catalog: { test: seedModels() } } : {}),
    fetchImpl,
  });
}

function textChunks(text: string): string[] {
  return openaiSSE([
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    '[DONE]',
  ]);
}

describe('request building', () => {
  it('builds a mode-aware system prompt', () => {
    const { app } = createTestApp();
    app.session.mode = 'plan';
    const prompt = buildSystemPrompt(app.session);
    expect(prompt).toContain('PLAN mode');
    expect(prompt).toContain(app.session.projectPath);
    expect(prompt).toContain('Never claim');
  });

  it('converts stored messages, skipping system roles', () => {
    const messages = [
      {
        id: '1',
        role: 'system' as const,
        content: 'ignored',
        timestamp: new Date().toISOString(),
      },
      {
        id: '2',
        role: 'user' as const,
        content: 'hello',
        timestamp: new Date().toISOString(),
      },
      {
        id: '3',
        role: 'assistant' as const,
        content: 'hi',
        toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'x' } }],
        timestamp: new Date().toISOString(),
      },
    ];

    const internal = toInternalMessages(messages);
    expect(internal).toHaveLength(2);
    expect(internal[0]).toEqual({ role: 'user', content: 'hello' });
    expect(internal[1]?.toolCalls).toHaveLength(1);
  });

  it('refuses to build a request without a selected model', () => {
    const { app } = createTestApp();
    expect(() => buildChatRequest(app, [])).toThrow(/No model selected/);
  });

  it('maps session settings onto the request', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.reasoning = { effort: 'high', budgetTokens: 8192 };
    app.session.temperature = 0.4;
    app.session.outputLimit = 4096;

    const request = buildChatRequest(app, []);
    expect(request.model).toBe('vendor/alpha-model');
    expect(request.stream).toBe(true);
    expect(request.reasoning).toEqual({ effort: 'high', budgetTokens: 8192 });
    expect(request.temperature).toBe(0.4);
    expect(request.maxOutputTokens).toBe(4096);
    expect(request.system).toContain('BUILD mode');
  });
});

describe('sendChatMessage', () => {
  it('streams a response, persists messages, and records usage', async () => {
    const { fetchImpl } = mockFetch([sseResponse(textChunks('Hello world'))]);
    const { app, credentials, sessionManager } = makeChatApp(fetchImpl);
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const events: string[] = [];
    const result = await sendChatMessage(app, 'Say hello', {
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(result.text).toBe('Hello world');
    expect(result.stopReason).toBe('stop');
    expect(result.error).toBeUndefined();
    expect(events).toContain('text-delta');
    expect(events).toContain('usage-updated');
    expect(events).toContain('response-completed');

    // Messages persisted
    expect(app.session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = app.session.messages[1]!;
    expect(assistant.content).toBe('Hello world');
    expect(assistant.providerId).toBe('test');
    expect(assistant.modelId).toBe('vendor/alpha-model');
    expect(assistant.usage?.inputTokens).toBe(120);
    expect(assistant.usage?.outputTokens).toBe(30);

    // Usage aggregate + estimated cost from seeded pricing
    expect(app.session.usage.requests).toBe(1);
    expect(app.session.usage.inputTokens).toBe(120);
    expect(app.session.usage.estimatedCost).toBeGreaterThan(0);

    // Interrupted flag cleared
    expect(sessionManager.load(app.session.id)?.interrupted).toBe(false);

    // Request body honors the session and streams
    const reloaded = sessionManager.load(app.session.id);
    expect(reloaded?.messages).toHaveLength(2);
  });

  it('sends the expected wire request', async () => {
    const { fetchImpl, calls } = mockFetch([sseResponse(textChunks('ok'))]);
    const { app, credentials } = makeChatApp(fetchImpl);
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    await sendChatMessage(app, 'ping');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://test.example.com/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('vendor/alpha-model');
    expect(body['stream']).toBe(true);
    expect(body['reasoning_effort']).toBe('medium');
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'ping' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer key');
  });

  it('persists the error for failed requests without pretending success', async () => {
    const { fetchImpl } = mockFetch([
      errorResponse(401, { error: { message: 'Invalid key', type: 'auth_error' } }),
    ]);
    const { app, credentials } = makeChatApp(fetchImpl);
    await credentials.set('TEST_API_KEY', 'bad');
    app.selectModel('test', 'vendor/alpha-model');

    const result = await sendChatMessage(app, 'hello');

    expect(result.error).toBeDefined();
    expect(result.text).toBe('');
    const assistant = app.session.messages[1]!;
    expect(assistant.error).toContain('Invalid key');
    expect(app.session.usage.requests).toBe(0);
  });

  it('keeps partial output and marks cancellation', async () => {
    // Stream that yields one delta, then aborts when the signal fires
    const encoder = new TextEncoder();
    let abortHook: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
          ),
        );

        // Mimic real fetch: aborting the signal tears down the body stream
        abortHook = () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          try {
            controller.error(error);
          } catch {
            // already closed
          }
        };
      },
    });

    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => abortHook?.());
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const { app, credentials } = makeChatApp(fetchImpl);
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const controller = new AbortController();
    const result = await sendChatMessage(app, 'long task', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text-delta') controller.abort();
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.text).toBe('partial');
    const assistant = app.session.messages[1]!;
    expect(assistant.content).toBe('partial');
    expect(assistant.error).toBe('Cancelled by the user');
  });

  it('throws before appending anything when no model is selected', async () => {
    const { fetchImpl } = mockFetch([]);
    const { app } = createTestApp({ fetchImpl });

    await expect(sendChatMessage(app, 'hi')).rejects.toThrow(/No model selected/);
    expect(app.session.messages).toHaveLength(0);
  });

  it('surfaces missing credentials as an error without corrupting the session', async () => {
    const { fetchImpl } = mockFetch([]);
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    app.selectModel('test', 'vendor/alpha-model');

    await expect(sendChatMessage(app, 'hi')).rejects.toThrow(/TEST_API_KEY/);
  });
});
