/**
 * OpenAI-compatible chat completions adapter.
 *
 * Works with OpenAI and any compatible gateway (xKiro, Azure-style proxies,
 * local servers, etc.). Compatibility options are explicit:
 *  - base URL, auth header style, extra headers
 *  - stream_options support (usage frames)
 *  - reasoning_effort forwarding
 */

import type { ProviderMetadata, ReasoningEffort, AppError } from '../types/index.js';
import { normalizeError, toolValidationError } from '../errors/index.js';
import type {
  ChatRequest,
  DiscoveredModel,
  FetchLike,
  InternalMessage,
  ProviderAdapter,
  ProviderStreamEvent,
  ToolSchema,
  UsageEvent,
} from './types.js';
import { event } from './types.js';
import { parseSSEStream } from './sse.js';
import { composeEndpoint } from './url.js';
import { httpErrorFromResponse, httpErrorFromStreamError, parseErrorBody } from './http-errors.js';

// ============================================================================
// Configuration
// ============================================================================

export interface OpenAICompatibleConfig {
  id: string;
  displayName: string;
  /** e.g. https://api.openai.com/v1 — may or may not include /v1 */
  baseUrl: string;
  apiKey?: string;
  /**
   * Auth header style:
   *  - 'bearer'    → Authorization: Bearer <key>
   *  - 'x-api-key' → configurable header (default x-api-key)
   */
  authStyle?: 'bearer' | 'x-api-key';
  authHeaderName?: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: FetchLike;
  /** Default max output tokens when the caller does not set one */
  defaultMaxOutputTokens?: number;
  /** Send reasoning_effort when reasoning options are present (default true) */
  supportsReasoningEffort?: boolean;
  /** Send stream_options: {include_usage: true} (default true) */
  supportsStreamOptions?: boolean;
  /** Endpoint paths (overridable for non-standard gateways) */
  chatPath?: string;
  modelsPath?: string;
  /** Request timeout for non-streaming calls, ms */
  requestTimeoutMs?: number;
}

// ============================================================================
// Helpers
// ============================================================================

const EFFORT_PASSTHROUGH: Partial<Record<ReasoningEffort, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

function mapReasoningEffort(effort: ReasoningEffort): string | null {
  if (effort === 'off') return 'none';
  if (effort === 'auto') return 'adaptive';
  return EFFORT_PASSTHROUGH[effort] ?? null;
}

interface OpenAIToolCallPiece {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}

interface OpenAIChunkChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: OpenAIToolCallPiece[];
  };
  finish_reason?: string | null;
}

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
}

/** Accumulated state for one tool call while streaming */
interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsBuffer: string;
  started: boolean;
  index: number;
}

function convertMessages(request: ChatRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  if (request.system) {
    out.push({ role: 'system', content: request.system });
  }

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: contentToText(msg) });
      continue;
    }

    if (msg.role === 'tool') {
      for (const result of msg.toolResults ?? []) {
        out.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.content,
        });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' };
      const text = contentToText(msg);
      entry.content = text.length > 0 ? text : null;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      out.push(entry);
      continue;
    }

    // user message: string or multimodal parts
    if (Array.isArray(msg.content)) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          const url = part.base64 ? `data:${part.mediaType};base64,${part.base64}` : part.url;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
      }
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: 'user', content: msg.content });
    }
  }

  return out;
}

function contentToText(msg: InternalMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function convertTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ============================================================================
// Adapter
// ============================================================================

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly metadata: ProviderMetadata;

  private config: Required<
    Pick<
      OpenAICompatibleConfig,
      | 'baseUrl'
      | 'authStyle'
      | 'supportsReasoningEffort'
      | 'supportsStreamOptions'
      | 'chatPath'
      | 'modelsPath'
      | 'defaultMaxOutputTokens'
      | 'requestTimeoutMs'
    >
  > &
    Omit<
      OpenAICompatibleConfig,
      | 'baseUrl'
      | 'authStyle'
      | 'supportsReasoningEffort'
      | 'supportsStreamOptions'
      | 'chatPath'
      | 'modelsPath'
      | 'defaultMaxOutputTokens'
      | 'requestTimeoutMs'
    >;

  private fetchImpl: FetchLike;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.fetchImpl = config.fetchImpl ?? fetch;

    this.config = {
      ...config,
      baseUrl: config.baseUrl,
      authStyle: config.authStyle ?? 'bearer',
      supportsReasoningEffort: config.supportsReasoningEffort ?? true,
      supportsStreamOptions: config.supportsStreamOptions ?? true,
      chatPath: config.chatPath ?? '/v1/chat/completions',
      modelsPath: config.modelsPath ?? '/v1/models',
      defaultMaxOutputTokens: config.defaultMaxOutputTokens ?? 8192,
      requestTimeoutMs: config.requestTimeoutMs ?? 120_000,
    };

    this.metadata = {
      id: config.id,
      type: 'openai-compatible',
      displayName: config.displayName,
      baseUrl: config.baseUrl,
      protocol: 'openai-chat',
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsReasoning: true,
      supportsImageInput: true,
      supportsTokenCounting: false,
      credentialRef: config.apiKey ? undefined : undefined,
      enabled: true,
      verified: false,
    };
  }

  // --------------------------------------------------------------------------
  // Request building (exported for tests via buildChatBody)
  // --------------------------------------------------------------------------

  buildChatBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: convertMessages(request),
      stream,
    };

    if (stream && this.config.supportsStreamOptions) {
      body.stream_options = { include_usage: true };
    }

    const maxTokens = request.maxOutputTokens ?? this.config.defaultMaxOutputTokens;
    if (maxTokens > 0) body.max_tokens = maxTokens;

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = convertTools(request.tools);
    }

    if (request.reasoning && this.config.supportsReasoningEffort) {
      const effort = mapReasoningEffort(request.reasoning.effort);
      if (effort) body.reasoning_effort = effort;
    }

    if (request.extraBody) {
      Object.assign(body, request.extraBody);
    }

    return body;
  }

  private buildHeaders(request?: ChatRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...this.config.extraHeaders,
    };

    const apiKey = this.config.apiKey;
    if (apiKey) {
      if (this.config.authStyle === 'x-api-key') {
        headers[this.config.authHeaderName ?? 'x-api-key'] = apiKey;
      } else {
        headers['authorization'] = `Bearer ${apiKey}`;
      }
    }

    if (request?.extraHeaders) {
      Object.assign(headers, request.extraHeaders);
    }

    return headers;
  }

  // --------------------------------------------------------------------------
  // chat()
  // --------------------------------------------------------------------------

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const stream = request.stream !== false;
    const url = composeEndpoint(this.config.baseUrl, this.config.chatPath);
    const body = this.buildChatBody(request, stream);

    yield event({ type: 'response-started', data: { model: request.model } });

    if (
      request.reasoning &&
      request.reasoning.effort !== 'off' &&
      request.reasoning.effort !== 'auto'
    ) {
      yield event({
        type: 'reasoning-metadata',
        data: { effort: request.reasoning.effort, budgetTokens: request.reasoning.budgetTokens },
      });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(request),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield this.errorEvent(err, request.model, signal);
      return;
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      yield event({
        type: 'error',
        data: httpErrorFromResponse(response.status, bodyText, this.id, request.model).toJSON(),
      });
      return;
    }

    if (stream) {
      yield* this.streamResponse(response, request.model, signal);
    } else {
      yield* this.aggregateResponse(response, request.model);
    }
  }

  private async *streamResponse(
    response: Response,
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    if (!response.body) {
      yield event({
        type: 'error',
        data: normalizeError(new Error('Response body missing'), {
          provider: this.id,
          model,
        }).toJSON(),
      });
      return;
    }

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let stopReason: string | null = null;
    let completed = false;
    let sawTerminator = false;

    try {
      for await (const raw of parseSSEStream(response.body)) {
        if (signal?.aborted) {
          yield event({ type: 'cancelled', data: { reason: 'aborted' } });
          return;
        }

        const payload = raw.data.trim();
        if (payload === '') continue;
        if (payload === '[DONE]') {
          sawTerminator = true;
          break;
        }

        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIChunk;
        } catch {
          continue; // malformed frame: skip, do not crash the stream
        }

        // Mid-stream error frame: {"error": {...}}
        if (chunk.error) {
          yield event({
            type: 'error',
            data: httpErrorFromStreamError(chunk.error, this.id, model),
          });
          return;
        }

        const choice = chunk.choices?.[0];

        if (choice?.delta) {
          const delta = choice.delta;

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            yield event({ type: 'reasoning-delta', data: { text: delta.reasoning_content } });
          } else if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
            yield event({ type: 'reasoning-delta', data: { text: delta.reasoning } });
          }

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield event({ type: 'text-delta', data: { text: delta.content } });
          }

          if (delta.tool_calls) {
            for (const piece of delta.tool_calls) {
              const index = piece.index ?? 0;
              let acc = toolCalls.get(index);
              if (!acc) {
                acc = {
                  id: piece.id ?? `tool_call_${index}`,
                  name: piece.function?.name ?? '',
                  argumentsBuffer: '',
                  started: false,
                  index,
                };
                toolCalls.set(index, acc);
              }
              if (piece.id) acc.id = piece.id;
              if (piece.function?.name && !acc.name) {
                acc.name = piece.function.name;
              }

              if (!acc.started && acc.name) {
                acc.started = true;
                yield event({
                  type: 'tool-call-started',
                  data: { id: acc.id, name: acc.name, index },
                });
              }

              if (piece.function?.arguments) {
                acc.argumentsBuffer += piece.function.arguments;
                yield event({
                  type: 'tool-call-arguments',
                  data: { id: acc.id, delta: piece.function.arguments },
                });
              }
            }
          }
        }

        if (choice?.finish_reason) {
          stopReason = choice.finish_reason;
        }

        // Usage arrives on its own frame with an empty choices array
        if (chunk.usage) {
          yield event({ type: 'usage-updated', data: mapOpenAIUsage(chunk.usage) });
        }
      }
    } catch (err) {
      yield this.errorEvent(err, model, signal);
      return;
    }

    // Finalize tool calls (only fully received arguments are emitted)
    const validToolCalls = [];
    for (const acc of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
      const finalizeEvents = finalizeToolCall(acc);
      for (const ev of finalizeEvents) yield ev;
      if (
        finalizeEvents.length > 0 &&
        finalizeEvents[finalizeEvents.length - 1]!.type === 'tool-call-completed'
      ) {
        const completedEvent = finalizeEvents[finalizeEvents.length - 1] as Extract<
          ProviderStreamEvent,
          { type: 'tool-call-completed' }
        >;
        validToolCalls.push({
          id: completedEvent.data.id,
          name: completedEvent.data.name,
          arguments: completedEvent.data.arguments,
        });
      }
    }

    // A stream that ends without a terminator after partial content is an
    // incomplete stream: report it rather than pretending success.
    if (!completed) {
      completed = true;
      if (!sawTerminator && stopReason === null && toolCalls.size === 0) {
        yield event({
          type: 'error',
          data: normalizeError(new Error('Stream ended without terminator'), {
            provider: this.id,
            model,
          }).toJSON(),
        });
        return;
      }
      yield event({
        type: 'response-completed',
        data: {
          stopReason: stopReason ?? (toolCalls.size > 0 ? 'tool_calls' : null),
          toolCalls: validToolCalls,
        },
      });
    }
  }

  private async *aggregateResponse(
    response: Response,
    model: string,
  ): AsyncGenerator<ProviderStreamEvent> {
    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      yield this.errorEvent(err, model);
      return;
    }

    if (json['error']) {
      yield event({
        type: 'error',
        data: httpErrorFromStreamError(
          json['error'] as { message?: string; type?: string; code?: string },
          this.id,
          model,
        ),
      });
      return;
    }

    const choices = json['choices'] as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.['message'] as Record<string, unknown> | undefined;

    if (message) {
      const reasoning = message['reasoning_content'] ?? message['reasoning'];
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield event({ type: 'reasoning-delta', data: { text: reasoning } });
      }

      const content = message['content'];
      if (typeof content === 'string' && content.length > 0) {
        yield event({ type: 'text-delta', data: { text: content } });
      }

      const toolCalls = message['tool_calls'] as OpenAIToolCallPiece[] | undefined;
      const validToolCalls = [];
      if (Array.isArray(toolCalls)) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          const id = tc.id ?? `tool_call_${i}`;
          const name = tc.function?.name ?? '';
          const rawArgs = tc.function?.arguments ?? '';
          yield event({ type: 'tool-call-started', data: { id, name, index: i } });
          try {
            const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
            yield event({ type: 'tool-call-completed', data: { id, name, arguments: args } });
            validToolCalls.push({ id, name, arguments: args });
          } catch (err) {
            const validationError = toolValidationError(
              `Invalid tool call arguments for ${name}: ${(err as Error).message}`,
              { id, name, rawArguments: rawArgs },
            );
            yield event({
              type: 'tool-call-invalid',
              data: { id, name, rawArguments: rawArgs, error: validationError.message },
            });
          }
        }
      }

      const usage = json['usage'] as OpenAIChunk['usage'];
      if (usage) {
        yield event({ type: 'usage-updated', data: mapOpenAIUsage(usage) });
      }

      yield event({
        type: 'response-completed',
        data: {
          stopReason: (choice?.['finish_reason'] as string | null) ?? null,
          toolCalls: validToolCalls,
        },
      });
      return;
    }

    yield event({
      type: 'response-completed',
      data: { stopReason: null, toolCalls: [] },
    });
  }

  private errorEvent(err: unknown, model: string, signal?: AbortSignal): ProviderStreamEvent {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return event({ type: 'cancelled', data: { reason: 'aborted' } });
    }
    return event({
      type: 'error',
      data: normalizeError(err, { provider: this.id, model }).toJSON(),
    });
  }

  // --------------------------------------------------------------------------
  // listModels()
  // --------------------------------------------------------------------------

  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const url = composeEndpoint(this.config.baseUrl, this.config.modelsPath);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal,
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw httpErrorFromResponse(response.status, bodyText, this.id);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return parseModelList(json);
  }

  async validateCredentials(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    try {
      const url = composeEndpoint(this.config.baseUrl, this.config.modelsPath);
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal,
      });
      if (response.ok) return { ok: true, message: 'Credentials accepted' };
      const bodyText = await safeReadText(response);
      const parsed = parseErrorBody(bodyText);
      return {
        ok: false,
        message: parsed.message ?? `HTTP ${response.status}`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

// ============================================================================
// Shared parsing helpers (also used by xKiro)
// ============================================================================

export function mapOpenAIUsage(usage: NonNullable<OpenAIChunk['usage']>): UsageEvent {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

function finalizeToolCall(acc: ToolCallAccumulator): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];

  if (!acc.started) {
    // Tool call never had a name; still surface it
    if (acc.name) {
      events.push(
        event({
          type: 'tool-call-started',
          data: { id: acc.id, name: acc.name, index: acc.index },
        }),
      );
    } else {
      return events;
    }
  }

  const raw = acc.argumentsBuffer.trim();
  if (raw === '') {
    events.push(
      event({
        type: 'tool-call-completed',
        data: { id: acc.id, name: acc.name, arguments: {} },
      }),
    );
    return events;
  }

  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    events.push(
      event({
        type: 'tool-call-completed',
        data: { id: acc.id, name: acc.name, arguments: args },
      }),
    );
  } catch (err) {
    // Never execute partially received / invalid arguments
    events.push(
      event({
        type: 'tool-call-invalid',
        data: {
          id: acc.id,
          name: acc.name,
          rawArguments: raw,
          error: `Invalid JSON in tool call arguments: ${(err as Error).message}`,
        },
      }),
    );
  }

  return events;
}

export function parseModelList(json: Record<string, unknown>): DiscoveredModel[] {
  const data = json['data'];
  if (!Array.isArray(data)) return [];

  const models: DiscoveredModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    const id =
      typeof m['id'] === 'string' ? m['id'] : typeof m['name'] === 'string' ? m['name'] : undefined;
    if (!id) continue;

    const model: DiscoveredModel = { id };

    if (typeof m['display_name'] === 'string') model.displayName = m['display_name'];
    if (typeof m['owned_by'] === 'string') model.ownedBy = m['owned_by'];
    if (typeof m['created'] === 'number')
      model.createdAt = new Date(m['created'] * 1000).toISOString();
    if (typeof m['created_at'] === 'string') model.createdAt = m['created_at'];

    // Provider-reported limits only. Never inferred from the model name.
    if (typeof m['context_length'] === 'number') model.contextLength = m['context_length'];
    if (typeof m['max_output_tokens'] === 'number') model.maxOutputTokens = m['max_output_tokens'];

    const caps = m['capabilities'];
    if (caps && typeof caps === 'object') {
      const c = caps as Record<string, unknown>;
      if (typeof c['tools'] === 'boolean') model.tools = c['tools'];
      if (typeof c['vision'] === 'boolean') model.vision = c['vision'];
      if (typeof c['reasoning'] === 'boolean') model.reasoning = c['reasoning'];
    }

    const efforts = m['reasoning_efforts'];
    if (efforts && typeof efforts === 'object') {
      const e = efforts as Record<string, unknown>;
      if (Array.isArray(e['levels'])) {
        model.reasoningLevels = e['levels'].filter((l): l is string => typeof l === 'string');
      }
      if (typeof e['default'] === 'string') model.reasoningDefault = e['default'];
    }

    if (typeof m['access_tier'] === 'string') model.accessTier = m['access_tier'];

    const pricing = m['pricing'];
    if (pricing && typeof pricing === 'object') {
      const p = pricing as Record<string, unknown>;
      const currency = typeof p['currency'] === 'string' ? p['currency'] : 'USD';
      model.pricing = {
        input: typeof p['input'] === 'number' ? p['input'] : undefined,
        output: typeof p['output'] === 'number' ? p['output'] : undefined,
        cacheRead: typeof p['cache_read'] === 'number' ? p['cache_read'] : undefined,
        cacheWrite: typeof p['cache_write'] === 'number' ? p['cache_write'] : undefined,
        currency,
      };
    }

    model.raw = m;
    models.push(model);
  }

  return models;
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
