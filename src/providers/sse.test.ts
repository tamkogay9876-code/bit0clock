/**
 * SSE parser tests - chunk boundaries, CRLF, comments, multiline data
 */

import { describe, it, expect } from 'bun:test';
import { parseSSEStream } from './sse.js';

async function collect(chunks: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const events = [];
  for await (const ev of parseSSEStream(stream)) events.push(ev);
  return events;
}

describe('SSE parser', () => {
  it('parses simple data events', async () => {
    const events = await collect(['data: hello\n\ndata: world\n\n']);
    expect(events.length).toBe(2);
    expect(events[0]!.data).toBe('hello');
    expect(events[1]!.data).toBe('world');
  });

  it('handles events split across chunk boundaries', async () => {
    const events = await collect(['data: he', 'llo\n', '\ndata: wo', 'rld\n\n']);
    expect(events.length).toBe(2);
    expect(events[0]!.data).toBe('hello');
    expect(events[1]!.data).toBe('world');
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(['data: hello\r\n\r\ndata: world\r\n\r\n']);
    expect(events.length).toBe(2);
    expect(events[0]!.data).toBe('hello');
    expect(events[1]!.data).toBe('world');
  });

  it('ignores comments and keep-alives', async () => {
    const events = await collect([': keep-alive\n\ndata: real\n\n']);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('real');
  });

  it('joins multi-line data fields', async () => {
    const events = await collect(['data: line1\ndata: line2\n\n']);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('line1\nline2');
  });

  it('parses named events', async () => {
    const events = await collect(['event: message_start\ndata: {"type":"message_start"}\n\n']);
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe('message_start');
    expect(JSON.parse(events[0]!.data)).toEqual({ type: 'message_start' });
  });

  it('parses [DONE] sentinel', async () => {
    const events = await collect(['data: {"a":1}\n\ndata: [DONE]\n\n']);
    expect(events.length).toBe(2);
    expect(events[1]!.data).toBe('[DONE]');
  });

  it('flushes trailing event without final blank line', async () => {
    const events = await collect(['data: last']);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('last');
  });

  it('handles empty stream', async () => {
    const events = await collect([]);
    expect(events.length).toBe(0);
  });

  it('skips empty blocks', async () => {
    const events = await collect(['\n\n\n\ndata: real\n\n']);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('real');
  });

  it('strips exactly one leading space from values', async () => {
    const events = await collect(['data:  two-spaces\n\n']);
    expect(events[0]!.data).toBe(' two-spaces');
  });

  it('handles a chunk boundary landing mid-multibyte character', async () => {
    const text = 'xin chào thế giới 🌏';
    const encoded = new TextEncoder().encode(`data: ${text}\n\n`);
    // Split in the middle of the multibyte sequence
    const mid = Math.floor(encoded.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, mid));
        controller.enqueue(encoded.slice(mid));
        controller.close();
      },
    });
    const events = [];
    for await (const ev of parseSSEStream(stream)) events.push(ev);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe(text);
  });
});
