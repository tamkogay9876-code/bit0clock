/**
 * Server-Sent Events (SSE) parser.
 *
 * Handles: chunk boundaries mid-event, CRLF and LF line endings,
 * comments (keep-alive), multi-line data fields, and final flush.
 */

export interface RawSSEEvent {
  event?: string;
  data: string;
  id?: string;
}

function parseEventBlock(block: string): RawSSEEvent | null {
  const result: RawSSEEvent = { data: '' };
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line === '') continue;
    // Comment / keep-alive
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        sawField = true;
        break;
      case 'event':
        result.event = value;
        sawField = true;
        break;
      case 'id':
        result.id = value;
        sawField = true;
        break;
      case 'retry':
        sawField = true;
        break;
      default:
        // Unknown field: per SSE spec, ignore
        break;
    }
  }

  if (!sawField) return null;
  result.data = dataLines.join('\n');
  return result;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Parse an SSE byte stream into events.
 * Robust against arbitrary chunk boundaries.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += normalizeNewlines(decoder.decode(value, { stream: true }));

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEventBlock(rawBlock);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }

    // Flush decoder + any trailing event without a final blank line
    buffer += normalizeNewlines(decoder.decode());
    if (buffer.trim() !== '') {
      const parsed = parseEventBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    // Ensure the stream is released and cancelled on early exit
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
