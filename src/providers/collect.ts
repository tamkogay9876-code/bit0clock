/**
 * Collect a full chat response from the stream event interface.
 * Useful for non-interactive execution and testing.
 */

import type { AppError } from '../types/index.js';
import type { ChatRequest, InternalToolCall, ProviderAdapter, UsageEvent } from './types.js';

export interface CompletionResult {
  text: string;
  reasoning: string;
  toolCalls: InternalToolCall[];
  invalidToolCalls: Array<{ id: string; name: string; rawArguments: string; error: string }>;
  usage: UsageEvent;
  stopReason: string | null;
  error?: AppError;
  cancelled: boolean;
}

export async function collectCompletion(
  adapter: ProviderAdapter,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const result: CompletionResult = {
    text: '',
    reasoning: '',
    toolCalls: [],
    invalidToolCalls: [],
    usage: {},
    stopReason: null,
    cancelled: false,
  };

  for await (const ev of adapter.chat({ ...request, stream: request.stream ?? false }, signal)) {
    switch (ev.type) {
      case 'text-delta':
        result.text += ev.data.text;
        break;
      case 'reasoning-delta':
        result.reasoning += ev.data.text;
        break;
      case 'tool-call-completed':
        result.toolCalls.push({
          id: ev.data.id,
          name: ev.data.name,
          arguments: ev.data.arguments,
        });
        break;
      case 'tool-call-invalid':
        result.invalidToolCalls.push({
          id: ev.data.id,
          name: ev.data.name,
          rawArguments: ev.data.rawArguments,
          error: ev.data.error,
        });
        break;
      case 'usage-updated':
        result.usage = { ...result.usage, ...ev.data };
        break;
      case 'response-completed':
        result.stopReason = ev.data.stopReason;
        break;
      case 'error':
        result.error = ev.data;
        break;
      case 'cancelled':
        result.cancelled = true;
        break;
      default:
        break;
    }
  }

  return result;
}
