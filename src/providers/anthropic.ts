/**
 * Anthropic-compatible messages adapter.
 *
 * Works with the Anthropic API and compatible gateways (e.g. xKiro's
 * /v1/messages endpoint). Dialect-specific requirements (API version header,
 * required max_tokens, thinking shapes) are handled here, never in the agent.
 */

import type { ProviderMetadata, ReasoningEffort, AppError } from '../types/index.js';
import { normalizeError } from '../errors/index.js';
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
import { composeEndpoint, withQuery } from './url.js';
import { httpErrorFromResponse, parseErrorBody, httpErrorFromStreamError } from './http-errors.js';
import { parseModelList, safeReadText } from './openai.js';

// ============================================================================
// Configuration
// ============================================================================

export interface AnthropicCompatibleConfig {
  id: string;
  displayName: string;
  /** e.g. https://api.anthropic.com — may or may not include /v1 */
  baseUrl: string;
  apiKey?: string;
  /** x-api-key (default, as the Anthropic SDK sends) or bearer */
  authStyle?: 'x-api-key' | 'bearer';
  apiVersion?: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: FetchLike;
  defaultMaxOutputTokens?: number;
  /** Whether the gateway understands extended thinking controls (default true) */
  supportsThinking?: boolean;
  /** Whether `thinking: {type: 'adaptive'}` is accepted (xKiro style) */
  supportsAdaptiveThinking?: boolean;
  /** Whether `thinking: {type: 'disabled'}` is accepted (xKiro style) */
  sendThinkingDisabled?: boolean;
  /** Endpoint paths (overridable) */
  messagesPath?: string;
  modelsPath?: string;
  countTokensPath?: string;
  requestTimeoutMs?: number;
  /**
   * Whether the /models endpoint supports limit/after_id pagination
   * (official Anthropic API: yes; xKiro: plain GET, no query needed)
   */
  supportsPagination?: boolean;
}

// effort level → thinking token budget (xKiro's documented conversion:
// ≤6,000 → low, ≤13,000 → medium, ≤24,000 → high, >24,000 → xhigh)
const EFFORT_BUDGETS: Partial<Record<ReasoningEffort, number>> = {
  low: 4096,
  medium: 10000,
  high: 20000,
  max: 32000,
};

const MIN_THINKING_BUDGET = 1024;

// ============================================================================
// Message conversion
// ============================================================================

function contentToBlocks(
  msg: InternalMessage,
  includeImages: boolean,
): Array<Record<string, unknown>> {
  if (typeof msg.content === 'string') {
    return [{ type: 'text', text: msg.content }];
  }

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of msg.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image' && includeImages) {
      if (part.base64) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.base64 },
        });
      } else if (part.url) {
        blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
      }
    }
  }
  return blocks;
}

export function convertMessages(request: ChatRequest): {
  system?: string;
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  let system = request.system;

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('');
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (msg.role === 'tool') {
      const blocks: Array<Record<string, unknown>> = [];
      for (const result of msg.toolResults ?? []) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      if (blocks.length === 0) continue;

      // Merge consecutive tool results into one user message (API requirement)
      const last = messages[messages.length - 1];
      if (last && last['role'] === 'user' && Array.isArray(last['content'])) {
        (last['content'] as Array<Record<string, unknown>>).push(...blocks);
      } else {
        messages.push({ role: 'user', content: blocks });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = contentToBlocks(msg, false);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    messages.push({ role: 'user', content: contentToBlocks(msg, true) });
  }

  return system !== undefined ? { system, messages } : { messages };
}

function convertTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ============================================================================
// Adapter
// ============================================================================

interface AnthropicStreamState {
  completed: boolean;
  stopReason: string | null;
  toolBlocks: Map<number, { id: string; name: string; buffer: string }>;
  sawMessageStop: boolean;
  usage: UsageEvent;
}

export class AnthropicCompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly metadata: ProviderMetadata;

  private config: AnthropicCompatibleConfig & {
    authStyle: 'x-api-key' | 'bearer';
    apiVersion: string;
    defaultMaxOutputTokens: number;
    supportsThinking: boolean;
    supportsAdaptiveThinking: boolean;
    sendThinkingDisabled: boolean;
    messagesPath: string;
    modelsPath: string;
    countTokensPath: string;
    requestTimeoutMs: number;
  };

  private fetchImpl: FetchLike;

  constructor(config: AnthropicCompatibleConfig) {
    this.id = config.id;
    this.fetchImpl = config.fetchImpl ?? fetch;

    this.config = {
      ...config,
      authStyle: config.authStyle ?? 'x-api-key',
      apiVersion: config.apiVersion ?? '2023-06-01',
      defaultMaxOutputTokens: config.defaultMaxOutputTokens ?? 8192,
      supportsThinking: config.supportsThinking ?? true,
      supportsAdaptiveThinking: config.supportsAdaptiveThinking ?? false,
      sendThinkingDisabled: config.sendThinkingDisabled ?? false,
      messagesPath: config.messagesPath ?? '/v1/messages',
      modelsPath: config.modelsPath ?? '/v1/models',
      countTokensPath: config.countTokensPath ?? '/v1/messages/count_tokens',
      requestTimeoutMs: config.requestTimeoutMs ?? 120_000,
      supportsPagination: config.supportsPagination ?? true,
    };

    this.metadata = {
      id: config.id,
      type: 'anthropic-compatible',
      displayName: config.displayName,
      baseUrl: config.baseUrl,
      protocol: 'anthropic-messages',
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsReasoning: this.config.supportsThinking,
      supportsImageInput: true,
      supportsTokenCounting: true,
      enabled: true,
      verified: false,
    };
  }

  // --------------------------------------------------------------------------
  // Request building
  // --------------------------------------------------------------------------

  buildChatBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = convertMessages(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
    };

    let maxTokens = request.maxOutputTokens ?? this.config.defaultMaxOutputTokens;
    let thinkingEnabled = false;

    if (request.reasoning && this.config.supportsThinking) {
      const { effort, budgetTokens } = request.reasoning;

      if (effort === 'off') {
        if (this.config.sendThinkingDisabled) {
          body.thinking = { type: 'disabled' };
        }
      } else if (effort === 'auto') {
        if (this.config.supportsAdaptiveThinking) {
          body.thinking = { type: 'adaptive' };
          thinkingEnabled = true;
        } else {
          const budget = Math.max(budgetTokens ?? 8192, MIN_THINKING_BUDGET);
          body.thinking = { type: 'enabled', budget_tokens: budget };
          thinkingEnabled = true;
          maxTokens = Math.max(maxTokens, budget + 1024);
        }
      } else {
        const budget = Math.max(
          budgetTokens ?? EFFORT_BUDGETS[effort] ?? 8192,
          MIN_THINKING_BUDGET,
        );
        body.thinking = { type: 'enabled', budget_tokens: budget };
        thinkingEnabled = true;
        // API requirement: max_tokens must be greater than budget_tokens
        maxTokens = Math.max(maxTokens, budget + 1024);
      }
    }

    // max_tokens is required by the Messages API
    body.max_tokens = maxTokens;

    if (system !== undefined) body.system = system;

    // Sampling parameters are rejected while reasoning is active
    if (request.temperature !== undefined && !thinkingEnabled) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = convertTools(request.tools);
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
      'anthropic-version': this.config.apiVersion,
      ...this.config.extraHeaders,
    };

    const apiKey = this.config.apiKey;
    if (apiKey) {
      if (this.config.authStyle === 'bearer') {
        headers['authorization'] = `Bearer ${apiKey}`;
      } else {
        headers['x-api-key'] = apiKey;
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
    const url = composeEndpoint(this.config.baseUrl, this.config.messagesPath);
    const body = this.buildChatBody(request, stream);

    yield event({ type: 'response-started', data: { model: request.model } });

    if (request.reasoning && request.reasoning.effort !== 'off') {
      const thinking = body['thinking'] as Record<string, unknown> | undefined;
      yield event({
        type: 'reasoning-metadata',
        data: {
          effort: request.reasoning.effort,
          budgetTokens:
            typeof thinking?.['budget_tokens'] === 'number'
              ? (thinking['budget_tokens'] as number)
              : undefined,
        },
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

    const state: AnthropicStreamState = {
      completed: false,
      stopReason: null,
      toolBlocks: new Map(),
      sawMessageStop: false,
      usage: {},
    };

    try {
      for await (const raw of parseSSEStream(response.body)) {
        if (signal?.aborted) {
          yield event({ type: 'cancelled', data: { reason: 'aborted' } });
          return;
        }

        const payload = raw.data.trim();
        if (payload === '') continue;

        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue; // malformed frame
        }

        if (ev['type'] === 'error' || ev['error']) {
          const errObj = (ev['error'] ?? ev) as { message?: string; type?: string; code?: string };
          yield event({
            type: 'error',
            data: httpErrorFromStreamError(errObj, this.id, model),
          });
          return;
        }

        yield* this.mapStreamEvent(ev, state);
      }
    } catch (err) {
      yield this.errorEvent(err, model, signal);
      return;
    }

    // Finalize any tool blocks that never received content_block_stop
    for (const [index, block] of [...state.toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      yield* this.finalizeToolBlock(index, block);
    }

    if (!state.sawMessageStop) {
      // Documented: a stream that ends without a terminator is an error
      yield event({
        type: 'error',
        data: normalizeError(new Error('Stream ended without message_stop'), {
          provider: this.id,
          model,
        }).toJSON(),
      });
      return;
    }

    if (!state.completed) {
      state.completed = true;
      yield event({
        type: 'response-completed',
        data: { stopReason: state.stopReason, toolCalls: [] },
      });
    }
  }

  private *mapStreamEvent(
    ev: Record<string, unknown>,
    state: AnthropicStreamState,
  ): Generator<ProviderStreamEvent> {
    const type = ev['type'];

    switch (type) {
      case 'message_start': {
        const message = ev['message'] as Record<string, unknown> | undefined;
        const usage = message?.['usage'] as Record<string, unknown> | undefined;
        if (usage) {
          state.usage = mapAnthropicUsage(usage);
          yield event({ type: 'usage-updated', data: state.usage });
        }
        break;
      }

      case 'content_block_start': {
        const index = typeof ev['index'] === 'number' ? (ev['index'] as number) : 0;
        const block = ev['content_block'] as Record<string, unknown> | undefined;
        if (block?.['type'] === 'tool_use') {
          const id =
            typeof block['id'] === 'string' ? (block['id'] as string) : `tool_use_${index}`;
          const name = typeof block['name'] === 'string' ? (block['name'] as string) : '';
          state.toolBlocks.set(index, { id, name, buffer: '' });
          yield event({ type: 'tool-call-started', data: { id, name, index } });
        }
        break;
      }

      case 'content_block_delta': {
        const index = typeof ev['index'] === 'number' ? (ev['index'] as number) : 0;
        const delta = ev['delta'] as Record<string, unknown> | undefined;
        if (!delta) break;

        const deltaType = delta['type'];
        if (deltaType === 'text_delta' && typeof delta['text'] === 'string') {
          yield event({ type: 'text-delta', data: { text: delta['text'] as string } });
        } else if (deltaType === 'thinking_delta' && typeof delta['thinking'] === 'string') {
          yield event({ type: 'reasoning-delta', data: { text: delta['thinking'] as string } });
        } else if (deltaType === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
          const block = state.toolBlocks.get(index);
          if (block) {
            block.buffer += delta['partial_json'] as string;
            yield event({
              type: 'tool-call-arguments',
              data: { id: block.id, delta: delta['partial_json'] as string },
            });
          }
        }
        break;
      }

      case 'content_block_stop': {
        const index = typeof ev['index'] === 'number' ? (ev['index'] as number) : 0;
        const block = state.toolBlocks.get(index);
        if (block) {
          yield* this.finalizeToolBlock(index, block);
        }
        break;
      }

      case 'message_delta': {
        const delta = ev['delta'] as Record<string, unknown> | undefined;
        if (delta && typeof delta['stop_reason'] === 'string') {
          state.stopReason = delta['stop_reason'] as string;
        }
        const usage = ev['usage'] as Record<string, unknown> | undefined;
        if (usage) {
          const mapped = mapAnthropicUsage(usage);
          state.usage = { ...state.usage, ...mapped };
          yield event({ type: 'usage-updated', data: mapped });
        }
        break;
      }

      case 'message_stop': {
        state.sawMessageStop = true;
        if (!state.completed) {
          state.completed = true;
          yield event({
            type: 'response-completed',
            data: { stopReason: state.stopReason, toolCalls: [] },
          });
        }
        break;
      }

      // 'ping' and unknown events: ignore (parse tolerantly)
      default:
        break;
    }
  }

  private *finalizeToolBlock(
    index: number,
    block: { id: string; name: string; buffer: string },
  ): Generator<ProviderStreamEvent> {
    // Remove so we never finalize twice
    if (!stateTryDelete(this, index)) return;

    const raw = block.buffer.trim();
    if (raw === '') {
      yield event({
        type: 'tool-call-completed',
        data: { id: block.id, name: block.name, arguments: {} },
      });
      return;
    }

    try {
      const args = JSON.parse(raw) as Record<string, unknown>;
      yield event({
        type: 'tool-call-completed',
        data: { id: block.id, name: block.name, arguments: args },
      });
    } catch (err) {
      yield event({
        type: 'tool-call-invalid',
        data: {
          id: block.id,
          name: block.name,
          rawArguments: raw,
          error: `Invalid JSON in tool call arguments: ${(err as Error).message}`,
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

    if (json['type'] === 'error' || json['error']) {
      const errObj = (json['error'] ?? json) as { message?: string; type?: string; code?: string };
      yield event({ type: 'error', data: httpErrorFromStreamError(errObj, this.id, model) });
      return;
    }

    const content = json['content'] as Array<Record<string, unknown>> | undefined;
    const validToolCalls = [];

    if (Array.isArray(content)) {
      let toolIndex = 0;
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          yield event({ type: 'text-delta', data: { text: block['text'] as string } });
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          yield event({ type: 'reasoning-delta', data: { text: block['thinking'] as string } });
        } else if (block['type'] === 'tool_use') {
          const id =
            typeof block['id'] === 'string' ? (block['id'] as string) : `tool_use_${toolIndex}`;
          const name = typeof block['name'] === 'string' ? (block['name'] as string) : '';
          const input =
            block['input'] && typeof block['input'] === 'object'
              ? (block['input'] as Record<string, unknown>)
              : {};
          yield event({ type: 'tool-call-started', data: { id, name, index: toolIndex } });
          yield event({ type: 'tool-call-completed', data: { id, name, arguments: input } });
          validToolCalls.push({ id, name, arguments: input });
          toolIndex++;
        }
      }
    }

    const usage = json['usage'] as Record<string, unknown> | undefined;
    if (usage) {
      yield event({ type: 'usage-updated', data: mapAnthropicUsage(usage) });
    }

    yield event({
      type: 'response-completed',
      data: {
        stopReason:
          typeof json['stop_reason'] === 'string' ? (json['stop_reason'] as string) : null,
        toolCalls: validToolCalls,
      },
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
    const models: DiscoveredModel[] = [];
    let afterId: string | undefined;
    const maxPages = this.config.supportsPagination ? 10 : 1;

    for (let page = 0; page < maxPages; page++) {
      const baseUrl = composeEndpoint(this.config.baseUrl, this.config.modelsPath);
      const url = this.config.supportsPagination
        ? withQuery(baseUrl, { limit: 1000, after_id: afterId })
        : baseUrl;

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
      const pageModels = parseModelList(json);
      models.push(...pageModels);

      const hasMore = json['has_more'] === true;
      const lastId = typeof json['last_id'] === 'string' ? (json['last_id'] as string) : undefined;
      if (!hasMore || !lastId) break;
      afterId = lastId;
    }

    return models;
  }

  // --------------------------------------------------------------------------
  // countTokens()
  // --------------------------------------------------------------------------

  async countTokens(request: ChatRequest, signal?: AbortSignal): Promise<number> {
    const { system, messages } = convertMessages(request);
    const body: Record<string, unknown> = { model: request.model, messages };
    if (system !== undefined) body.system = system;
    if (request.tools && request.tools.length > 0) {
      body.tools = convertTools(request.tools);
    }

    const url = composeEndpoint(this.config.baseUrl, this.config.countTokensPath);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw httpErrorFromResponse(response.status, bodyText, this.id);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const inputTokens = json['input_tokens'];
    if (typeof inputTokens !== 'number') {
      throw new Error('count_tokens response missing input_tokens');
    }
    return inputTokens;
  }

  async validateCredentials(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    try {
      const url = withQuery(composeEndpoint(this.config.baseUrl, this.config.modelsPath), {
        limit: 1,
      });
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal,
      });
      if (response.ok) return { ok: true, message: 'Credentials accepted' };
      const bodyText = await safeReadText(response);
      const parsed = parseErrorBody(bodyText);
      return { ok: false, message: parsed.message ?? `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function mapAnthropicUsage(usage: Record<string, unknown>): UsageEvent {
  const result: UsageEvent = {};
  if (typeof usage['input_tokens'] === 'number')
    result.inputTokens = usage['input_tokens'] as number;
  if (typeof usage['output_tokens'] === 'number')
    result.outputTokens = usage['output_tokens'] as number;

  const cacheRead = usage['cache_read_input_tokens'];
  const cacheWrite = usage['cache_creation_input_tokens'];
  if (typeof cacheRead === 'number' && typeof result.inputTokens === 'number') {
    result.cachedInputTokens = cacheRead as number;
    // Anthropic reports cache reads outside input_tokens; include them so
    // totals match what was actually sent.
    if (typeof cacheWrite === 'number') result.inputTokens += cacheWrite as number;
  }
  return result;
}

/**
 * Finalize-once guard: tracks tool block indexes already finalized
 * across the generator lifetime via a WeakMap keyed by the adapter instance.
 */
const finalizedBlocks = new WeakMap<AnthropicCompatibleAdapter, Set<number>>();

function stateTryDelete(adapter: AnthropicCompatibleAdapter, index: number): boolean {
  let set = finalizedBlocks.get(adapter);
  if (!set) {
    set = new Set();
    finalizedBlocks.set(adapter, set);
  }
  if (set.has(index)) return false;
  set.add(index);
  return true;
}
