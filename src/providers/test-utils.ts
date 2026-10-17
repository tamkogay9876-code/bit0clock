/**
 * Deterministic test helpers for provider adapters.
 * Not part of the runtime surface (imported only from tests).
 */

import type { FetchLike } from './types.js';

/** Build an SSE Response from raw chunk strings (chunk boundaries preserved). */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** Build a JSON Response. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Build an error Response. */
export function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface MockCall {
  url: string;
  init: RequestInit;
}

export interface MockFetch {
  fetchImpl: FetchLike;
  calls: MockCall[];
}

/**
 * Create a mock fetch that returns scripted responses in order.
 * Each entry may be a Response or a function producing one.
 */
export function mockFetch(
  responses: Array<Response | ((url: string, init: RequestInit) => Response | Promise<Response>)>,
): MockFetch {
  const calls: MockCall[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    const urlStr = String(url);
    const initObj = init ?? {};
    calls.push({ url: urlStr, init: initObj });

    if (index >= responses.length) {
      throw new Error(`mockFetch: no scripted response for call #${index + 1} to ${urlStr}`);
    }
    const entry = responses[index++]!;
    return typeof entry === 'function' ? await entry(urlStr, initObj) : entry;
  };

  return { fetchImpl, calls };
}

/** Helper to build a sequence of OpenAI SSE data lines. */
export function openaiSSE(payloads: Array<Record<string, unknown> | '[DONE]'>): string[] {
  return payloads.map((p) => {
    if (p === '[DONE]') return 'data: [DONE]\n\n';
    return `data: ${JSON.stringify(p)}\n\n`;
  });
}

/** Helper to build Anthropic named SSE events. */
export function anthropicSSE(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): string[] {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}
