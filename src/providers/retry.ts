/**
 * Bounded retry for provider chat streams.
 *
 * Safety rule: a request is retried only when *nothing* has been received yet
 * (no response-started, no deltas, no tool calls). Once the server has begun
 * producing a response, a retry could duplicate charges or duplicate side
 * effects, so the error is surfaced instead.
 */

import type { AppError } from '../types/index.js';
import { sleep } from '../utils/index.js';
import type { ChatRequest, ProviderAdapter, ProviderStreamEvent } from './types.js';

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each retry (diagnostics) */
  onRetry?: (info: { attempt: number; delayMs: number; error: AppError }) => void;
}

const DEFAULT_POLICY: Required<Pick<RetryPolicy, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
};

/**
 * Wrap an adapter's chat() with bounded retries.
 *
 * Retry eligibility:
 *  - error arrived before any response data → eligible if error.retryable
 *  - error arrived after data started        → never retried
 *  - provider-reported retryAfterMs honored, else exponential backoff
 */
export async function* chatWithRetry(
  adapter: ProviderAdapter,
  request: ChatRequest,
  signal?: AbortSignal,
  policy: RetryPolicy = {},
): AsyncGenerator<ProviderStreamEvent> {
  const maxAttempts = policy.maxAttempts ?? DEFAULT_POLICY.maxAttempts;
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_POLICY.baseDelayMs;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_POLICY.maxDelayMs;

  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    let receivedData = false;
    let terminal = false;
    let errorEvent: Extract<ProviderStreamEvent, { type: 'error' }> | null = null;

    try {
      for await (const ev of adapter.chat(request, signal)) {
        if (ev.type === 'error') {
          errorEvent = ev;
          break;
        }

        if (ev.type === 'cancelled') {
          yield ev;
          return;
        }

        // Any event after response-started counts as data received
        if (ev.type !== 'response-started') {
          receivedData = true;
        } else {
          // response-started alone means the request was accepted; treat a
          // subsequent *immediate* failure as retryable only if no deltas.
          receivedData = false;
        }

        if (ev.type === 'response-completed') terminal = true;

        yield ev;

        if (terminal) return;
      }
    } catch (err) {
      errorEvent = {
        type: 'error',
        data: {
          category: 'unknown',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
        timestamp: new Date().toISOString(),
      };
    }

    if (!errorEvent) return; // stream ended cleanly without terminal event; nothing to retry

    const error = errorEvent.data;

    const eligible = !receivedData && error.retryable && attempt < maxAttempts;
    if (!eligible) {
      yield errorEvent;
      return;
    }

    const delayMs = Math.min(error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

    policy.onRetry?.({ attempt, delayMs, error });

    if (signal?.aborted) {
      yield { type: 'cancelled', data: { reason: 'aborted' }, timestamp: new Date().toISOString() };
      return;
    }

    await sleep(delayMs);

    if (signal?.aborted) {
      yield { type: 'cancelled', data: { reason: 'aborted' }, timestamp: new Date().toISOString() };
      return;
    }
  }
}
