/**
 * HTTP error mapping to mediaXG error categories.
 *
 * Follows documented semantics (status + stable error type/code),
 * never relies solely on human-readable message text.
 */

import { MediaXGError } from '../errors/index.js';
import {
  authError,
  rateLimitError,
  serverError,
  timeoutError,
  contextOverflowError,
  outputLimitError,
  invalidModelError,
  insufficientQuotaError,
  permissionDeniedError,
} from '../errors/index.js';
import type { AppError } from '../types/index.js';

interface ParsedErrorBody {
  message?: string;
  /** stable error identifier, e.g. 'invalid_request_error', 'insufficient_quota' */
  type?: string;
  code?: string;
  status?: number;
}

/**
 * Extract message/type/code from both dialect shapes:
 *  OpenAI:    { error: { message, type, code } }
 *  Anthropic: { type: 'error', error: { type, message } }
 */
export function parseErrorBody(bodyText: string): ParsedErrorBody {
  const result: ParsedErrorBody = {};
  try {
    const json = JSON.parse(bodyText) as Record<string, unknown>;
    const err = json['error'];
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      if (typeof e['message'] === 'string') result.message = e['message'];
      if (typeof e['type'] === 'string') result.type = e['type'];
      if (typeof e['code'] === 'string') result.code = e['code'];
    } else if (typeof json['message'] === 'string') {
      result.message = json['message'] as string;
    }
  } catch {
    if (bodyText.trim()) result.message = bodyText.slice(0, 300);
  }
  return result;
}

const CONTEXT_OVERFLOW_PATTERNS = [/context/i, /too many tokens/i, /too long/i, /exceed/i];
const OUTPUT_LIMIT_PATTERNS = [/max_tokens/i, /max output/i, /output limit/i];

/**
 * Map an HTTP error response to a structured MediaXGError.
 *
 * Retryability follows provider documentation:
 *   429, 500, 502, 503 (and 529 overloaded) → retryable
 *   400, 401, 403, 404                        → not retryable
 *   402 (insufficient quota)                  → not retryable (needs top-up)
 */
export function httpErrorFromResponse(
  status: number,
  bodyText: string,
  provider: string,
  model?: string,
): MediaXGError {
  const parsed = parseErrorBody(bodyText);
  const type = parsed.type ?? '';
  const code = parsed.code ?? '';
  const message = parsed.message ?? `HTTP ${status}`;
  const details = {
    status,
    errorType: type || undefined,
    errorCode: code || undefined,
  };

  // Stable identifiers take precedence over status where provided
  if (type === 'insufficient_quota' || code === 'insufficient_quota' || type === 'billing_error') {
    return insufficientQuotaError(message, provider, details);
  }
  if (type === 'rate_limit_error' || code === 'rate_limit_exceeded') {
    return rateLimitError(message, provider);
  }
  if (type === 'overloaded_error' || code === 'overloaded') {
    return new MediaXGError({
      category: 'server',
      message,
      provider,
      retryable: true,
      details,
    });
  }
  if (type === 'not_found_error' || code === 'not_found') {
    return invalidModelError(message, provider, model);
  }

  switch (status) {
    case 400:
    case 422: {
      const combined = `${message}`.toLowerCase();
      const isContext =
        CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(combined)) &&
        /token|context|input/.test(combined);
      if (isContext) return contextOverflowError(message, provider, model, details);
      if (OUTPUT_LIMIT_PATTERNS.some((p) => p.test(combined))) {
        return outputLimitError(message, provider, model);
      }
      return new MediaXGError({
        category: 'unknown',
        message,
        provider,
        model,
        retryable: false,
        details,
      });
    }
    case 401:
      return authError(message, provider, details);
    case 402:
      return insufficientQuotaError(message, provider, details);
    case 403:
      return permissionDeniedError(message, details);
    case 404:
      return invalidModelError(message, provider, model);
    case 408:
      return timeoutError(message, provider);
    case 429:
      return rateLimitError(message, provider);
    case 500:
    case 502:
    case 503:
    case 529:
      return serverError(message, provider, details);
    default:
      if (status >= 500) return serverError(message, provider, details);
      return new MediaXGError({
        category: 'unknown',
        message,
        provider,
        model,
        retryable: false,
        details,
      });
  }
}

/**
 * Map a mid-stream error frame (no HTTP status available) to an AppError.
 * Both dialects deliver these: OpenAI style `{"error": {...}}` frames and
 * Anthropic-style `{"type":"error","error":{...}}` events.
 */
export function httpErrorFromStreamError(
  err: { message?: string; type?: string; code?: string },
  provider: string,
  model?: string,
): AppError {
  const error = httpErrorFromResponse(0, JSON.stringify({ error: err }), provider, model);
  return error.toJSON();
}
