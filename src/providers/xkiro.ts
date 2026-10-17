/**
 * xKiro first-class provider.
 *
 * Verified against the official documentation (https://docs.xkiro.com/api/overview/):
 *  - OpenAI-compatible chat completions: POST /v1/chat/completions
 *  - Anthropic-compatible messages:      POST /v1/messages
 *  - Anthropic-compatible token count:   POST /v1/messages/count_tokens
 *  - Model discovery:                    GET  /v1/models  (public)
 *  - Host: https://api.xkiro.com
 *  - Auth: `Authorization: Bearer <key>` or `x-api-key: <key>` (equivalent)
 *  - Model IDs are always `vendor/model`
 *  - Blocking requests are cut off at 95s; stream for long generations
 *  - Retryable statuses: 429, 500, 502, 503. 402 is not retryable.
 *
 * The inference provider and xKiro's hosted web MCP server
 * (https://api.xkiro.com/mcp/web) are separate integrations; the MCP side
 * lives in src/mcp/ (Phase F).
 */

import type { ApiProtocol, ProviderMetadata } from '../types/index.js';
import type { FetchLike, ProviderAccountUsage, ProviderAdapter } from './types.js';
import { OpenAICompatibleAdapter } from './openai.js';
import { AnthropicCompatibleAdapter } from './anthropic.js';
import { composeEndpoint } from './url.js';
import { parseErrorBody } from './http-errors.js';

export const XKIRO_DEFAULT_BASE_URL = 'https://api.xkiro.com';

/** Documented endpoints (paths are relative to the host). */
export const XKIRO_ENDPOINTS = {
  chatCompletions: '/v1/chat/completions',
  messages: '/v1/messages',
  countTokens: '/v1/messages/count_tokens',
  models: '/v1/models',
  usage: '/v1/usage',
} as const;

/** Hosted web MCP endpoint (separate integration, used in Phase F). */
export const XKIRO_WEB_MCP_URL = 'https://api.xkiro.com/mcp/web';

export interface XKiroProviderConfig {
  /** Which documented protocol to use for generation. Default: anthropic-messages */
  protocol?: ApiProtocol;
  apiKey?: string;
  /** Bearer (default for openai-chat) or x-api-key (default for anthropic-messages) */
  authStyle?: 'bearer' | 'x-api-key';
  /** Override only for testing/proxies. Defaults to the documented host. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createXKiroAdapter(config: XKiroProviderConfig): ProviderAdapter {
  const protocol = config.protocol ?? 'anthropic-messages';
  const baseUrl = (config.baseUrl ?? XKIRO_DEFAULT_BASE_URL).trim();
  const authStyle = config.authStyle ?? (protocol === 'openai-chat' ? 'bearer' : 'x-api-key');

  let inner: ProviderAdapter;

  if (protocol === 'openai-chat') {
    inner = new OpenAICompatibleAdapter({
      id: 'xkiro',
      displayName: 'xKiro',
      baseUrl,
      apiKey: config.apiKey,
      // Docs: Bearer and x-api-key are equivalent; Bearer is the OpenAI-SDK default
      authStyle,
      chatPath: XKIRO_ENDPOINTS.chatCompletions,
      modelsPath: XKIRO_ENDPOINTS.models,
      fetchImpl: config.fetchImpl,
      // Docs: `reasoning_effort` — levels vary per model; values a model
      // does not have are adjusted by the gateway, never rejected.
      supportsReasoningEffort: true,
      supportsStreamOptions: true,
    });
  } else {
    // Anthropic dialect: extended thinking with the three documented shapes
    inner = new AnthropicCompatibleAdapter({
      id: 'xkiro',
      displayName: 'xKiro',
      baseUrl,
      apiKey: config.apiKey,
      authStyle,
      messagesPath: XKIRO_ENDPOINTS.messages,
      modelsPath: XKIRO_ENDPOINTS.models,
      countTokensPath: XKIRO_ENDPOINTS.countTokens,
      fetchImpl: config.fetchImpl,
      // xKiro documents adaptive/disabled shapes on the Messages dialect
      supportsAdaptiveThinking: true,
      sendThinkingDisabled: true,
      // GET /v1/models is a plain catalog call (no pagination params documented)
      supportsPagination: false,
    });
  }

  return new XKiroAdapter(inner, {
    baseUrl,
    apiKey: config.apiKey,
    authStyle,
    fetchImpl: config.fetchImpl,
  });
}

/**
 * Thin wrapper that overrides credential validation for xKiro.
 *
 * GET /v1/models is public (it validates connectivity, not the key), so
 * credential checking uses GET /v1/usage instead — documented as
 * "key required" and "free to call".
 */
class XKiroAdapter implements ProviderAdapter {
  constructor(
    private inner: ProviderAdapter,
    private options: {
      baseUrl: string;
      apiKey?: string;
      authStyle: 'bearer' | 'x-api-key';
      fetchImpl?: FetchLike;
    },
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get metadata(): ProviderMetadata {
    return this.inner.metadata;
  }

  chat = (request: Parameters<ProviderAdapter['chat']>[0], signal?: AbortSignal) =>
    this.inner.chat(request, signal);

  listModels = (signal?: AbortSignal) => this.inner.listModels(signal);

  countTokens = (
    request: Parameters<NonNullable<ProviderAdapter['countTokens']>>[0],
    signal?: AbortSignal,
  ) => {
    if (!this.inner.countTokens) {
      return Promise.reject(new Error('countTokens not supported'));
    }
    return this.inner.countTokens(request, signal);
  };

  async validateCredentials(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = composeEndpoint(this.options.baseUrl, XKIRO_ENDPOINTS.usage);

    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (this.options.apiKey) {
      if (this.options.authStyle === 'bearer') {
        headers['authorization'] = `Bearer ${this.options.apiKey}`;
      } else {
        headers['x-api-key'] = this.options.apiKey;
      }
    }

    try {
      const response = await fetchImpl(url, { method: 'GET', headers, signal });
      if (response.ok) {
        return { ok: true, message: 'Credentials accepted (verified via /v1/usage)' };
      }
      const bodyText = await response.text().catch(() => '');
      const parsed = parseErrorBody(bodyText);
      return {
        ok: false,
        message: parsed.message ?? `HTTP ${response.status}`,
      };
    } catch (err) {
      return { ok: false, message: `Cannot reach xKiro: ${(err as Error).message}` };
    }
  }

  /**
   * Account usage via the documented GET /v1/usage endpoint.
   *
   * The endpoint's response shape is parsed defensively: only recognized
   * numeric fields are surfaced, labeled as provider-reported. When the shape
   * is not recognized, no balance is displayed — never invented.
   */
  async getAccountUsage(signal?: AbortSignal): Promise<ProviderAccountUsage> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = composeEndpoint(this.options.baseUrl, XKIRO_ENDPOINTS.usage);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.apiKey) {
      if (this.options.authStyle === 'bearer') {
        headers['authorization'] = `Bearer ${this.options.apiKey}`;
      } else {
        headers['x-api-key'] = this.options.apiKey;
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal });
    } catch (err) {
      return { available: false, message: `Cannot reach xKiro: ${(err as Error).message}` };
    }

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      const parsed = parseErrorBody(bodyText);
      return { available: false, message: parsed.message ?? `HTTP ${response.status}` };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return {
        available: false,
        message: 'The /v1/usage endpoint responded but the body was not JSON; no values are shown.',
      };
    }

    const recognized = extractXKiroUsageValues(payload);
    if (recognized.values.length === 0) {
      return {
        available: false,
        message:
          'The /v1/usage endpoint responded, but no recognized balance/credit fields were found; ' +
          'no values are invented. Check the provider dashboard for the official balance.',
        raw: payload,
      };
    }
    const result: ProviderAccountUsage = {
      available: true,
      message: 'Provider-reported via GET /v1/usage',
      values: recognized.values,
      raw: payload,
    };
    return result;
  }
}

/**
 * Conservative field extraction for xKiro's /v1/usage payload.
 * Only numeric values of known balance/credit/usage field names are surfaced.
 */
export function extractXKiroUsageValues(payload: unknown): {
  values: Array<{ label: string; value: string }>;
} {
  if (typeof payload !== 'object' || payload === null) return { values: [] };
  const root = payload as Record<string, unknown>;
  const scope: Record<string, unknown> =
    typeof root['data'] === 'object' && root['data'] !== null
      ? { ...root, ...(root['data'] as Record<string, unknown>) }
      : root;

  const currency =
    typeof scope['currency'] === 'string'
      ? scope['currency']
      : typeof root['currency'] === 'string'
        ? (root['currency'] as string)
        : undefined;

  const knownFields: Array<{ key: string; label: string }> = [
    { key: 'balance', label: 'balance' },
    { key: 'credit_balance', label: 'credit balance' },
    { key: 'credits_remaining', label: 'credits remaining' },
    { key: 'credit_remaining', label: 'credits remaining' },
    { key: 'remaining_credits', label: 'credits remaining' },
    { key: 'remaining', label: 'remaining' },
    { key: 'quota', label: 'quota' },
    { key: 'quota_remaining', label: 'quota remaining' },
    { key: 'limit', label: 'limit' },
    { key: 'used', label: 'used' },
    { key: 'usage', label: 'usage' },
    { key: 'spent', label: 'spent' },
  ];

  const values: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (const { key, label } of knownFields) {
    const raw = scope[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    const formatted = Number.isInteger(raw) ? String(raw) : raw.toFixed(4);
    values.push({ label, value: currency ? `${formatted} ${currency}` : formatted });
  }
  return { values };
}

/**
 * xKiro metadata for the model catalog / pickers.
 * `verified` stays false until a real successful call has been made;
 * the setup flow is responsible for setting it after validation.
 */
export function xkiroMetadata(baseUrl?: string): ProviderMetadata {
  return {
    id: 'xkiro',
    type: 'xkiro',
    displayName: 'xKiro',
    baseUrl: baseUrl ?? XKIRO_DEFAULT_BASE_URL,
    protocol: 'anthropic-messages',
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    supportsImageInput: true,
    supportsTokenCounting: true,
    enabled: true,
    verified: false,
  };
}
