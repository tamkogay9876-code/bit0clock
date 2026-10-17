/**
 * Chat service: the single path that turns a user message into a streamed
 * provider response and persists the result.
 *
 * Used by both the TUI and non-interactive execution so there is exactly
 * one implementation of request building, usage recording, and error
 * persistence. The tool-calling agent loop (Phase D) will layer on top of
 * `sendChatMessage` by consuming its event stream.
 */

import { generateId } from '../utils/index.js';
import { chatWithRetry } from '../providers/retry.js';
import type {
  ChatRequest,
  ProviderStreamEvent,
  ToolSchema,
  UsageEvent,
} from '../providers/types.js';
import type { AppState } from '../app/state.js';
import type { AppError } from '../types/index.js';
import type { StoredMessage, StoredUsage } from '../session/types.js';
import type { InstructionBundle } from '../context/instructions.js';
import type { BuildSystemPromptOptions } from './request.js';
import { buildSystemPrompt, toInternalMessages } from './request.js';

// Re-exported for compatibility; the implementations live in agent/request.ts
export { buildSystemPrompt, toInternalMessages } from './request.js';
export type { BuildSystemPromptOptions } from './request.js';

// ============================================================================
// Request building
// ============================================================================

export interface BuildChatRequestOptions {
  /** Tools to attach (already filtered for the active mode) */
  tools?: ToolSchema[];
  /** Instruction bundle from the workspace (§47) */
  instructions?: InstructionBundle;
  /** Request-only task context added to the system prompt */
  contextPreamble?: string;
  /**
   * Full system prompt override (used by the context pipeline, which adds
   * retrieval blocks, omission notes, and budget information).
   */
  systemOverride?: string;
}

export function buildChatRequest(
  app: AppState,
  messages: StoredMessage[],
  options: BuildChatRequestOptions = {},
): ChatRequest {
  const active = app.activeModel();
  if (!active) {
    throw new Error(
      'No model selected. Run /models to browse models and /model <model> to select one.',
    );
  }

  const systemOptions: BuildSystemPromptOptions = {};
  if (options.instructions) systemOptions.instructions = options.instructions;
  if (options.contextPreamble) systemOptions.contextPreamble = options.contextPreamble;
  if (options.tools && options.tools.length > 0) systemOptions.toolsEnabled = true;

  const request: ChatRequest = {
    model: active.modelId,
    system: options.systemOverride ?? buildSystemPrompt(app.session, systemOptions),
    messages: toInternalMessages(messages),
    stream: true,
    reasoning: {
      effort: app.session.reasoning.effort,
      ...(app.session.reasoning.budgetTokens !== undefined
        ? { budgetTokens: app.session.reasoning.budgetTokens }
        : {}),
    },
  };

  if (options.tools && options.tools.length > 0) request.tools = options.tools;
  if (app.session.temperature !== undefined) request.temperature = app.session.temperature;
  if (app.session.outputLimit !== undefined) request.maxOutputTokens = app.session.outputLimit;

  return request;
}

// ============================================================================
// Sending
// ============================================================================

export interface SendChatOptions {
  /** Streaming callback, awaited in order */
  onEvent?: (event: ProviderStreamEvent) => void | Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: AppError }) => void;
  signal?: AbortSignal;
}

export interface SendChatResult {
  /** The persisted assistant message */
  message: StoredMessage;
  text: string;
  reasoning: string;
  usage: UsageEvent;
  stopReason: string | null;
  error?: AppError;
  cancelled: boolean;
}

/**
 * Append a user message, stream the assistant response, and persist both.
 *
 * Persistence rules:
 *  - the user message is saved before the request starts
 *  - the assistant message is saved even on failure or cancellation,
 *    carrying the partial text and the error — never presented as complete
 */
export async function sendChatMessage(
  app: AppState,
  userText: string,
  options: SendChatOptions = {},
): Promise<SendChatResult> {
  const active = app.activeModel();
  if (!active) {
    throw new Error(
      'No model selected. Run /models to browse models and /model <model> to select one.',
    );
  }

  const userMessage: StoredMessage = {
    id: generateId(),
    role: 'user',
    content: userText,
    timestamp: new Date().toISOString(),
  };
  app.session.messages.push(userMessage);
  app.sessionManager.save(app.session);

  const adapter = await app.getAdapter(active.providerId);
  const request = buildChatRequest(app, app.session.messages);

  app.markRequestStarted();

  let text = '';
  let reasoning = '';
  let usage: UsageEvent = {};
  let stopReason: string | null = null;
  let error: AppError | undefined;
  let cancelled = false;

  try {
    for await (const event of chatWithRetry(adapter, request, options.signal, {
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    })) {
      switch (event.type) {
        case 'text-delta':
          text += event.data.text;
          break;
        case 'reasoning-delta':
          reasoning += event.data.text;
          break;
        case 'usage-updated':
          usage = { ...usage, ...event.data };
          break;
        case 'response-completed':
          stopReason = event.data.stopReason;
          break;
        case 'error':
          error = event.data;
          break;
        case 'cancelled':
          cancelled = true;
          break;
        default:
          break;
      }

      if (options.onEvent) await options.onEvent(event);
    }
  } finally {
    app.markRequestFinished();
  }

  const assistantMessage: StoredMessage = {
    id: generateId(),
    role: 'assistant',
    content: text,
    providerId: active.providerId,
    modelId: active.modelId,
    timestamp: new Date().toISOString(),
  };
  const storedUsage: StoredUsage = {};
  if (usage.inputTokens !== undefined) storedUsage.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) storedUsage.outputTokens = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined)
    storedUsage.cachedInputTokens = usage.cachedInputTokens;
  if (usage.reasoningTokens !== undefined) storedUsage.reasoningTokens = usage.reasoningTokens;
  const hasUsage = Object.keys(storedUsage).length > 0;
  if (hasUsage) assistantMessage.usage = storedUsage;
  if (error) assistantMessage.error = error.message;
  if (cancelled) assistantMessage.error = assistantMessage.error ?? 'Cancelled by the user';

  app.session.messages.push(assistantMessage);

  if (hasUsage) {
    app.recordUsage(active.providerId, active.modelId, storedUsage);
  } else {
    app.sessionManager.save(app.session);
  }

  const result: SendChatResult = {
    message: assistantMessage,
    text,
    reasoning,
    usage,
    stopReason,
    cancelled,
  };
  if (error) result.error = error;
  return result;
}
