/**
 * Provider adapter types - vendor-neutral internal representation.
 *
 * Provider adapters translate between these internal types and
 * vendor-specific wire formats. The agent loop never sees vendor schemas.
 */

import type { ProviderMetadata, ReasoningEffort, AppError } from '../types/index.js';

// ============================================================================
// Internal message model (vendor-neutral)
// ============================================================================

export interface InternalTextPart {
  type: 'text';
  text: string;
}

export interface InternalImagePart {
  type: 'image';
  mediaType: string;
  /** Base64-encoded data (preferred) */
  base64?: string;
  /** Remote URL when the provider supports URL sources */
  url?: string;
}

export type InternalContentPart = InternalTextPart | InternalImagePart;

export interface InternalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface InternalToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | InternalContentPart[];
  /** Assistant messages: tool calls the model requested */
  toolCalls?: InternalToolCall[];
  /** Tool messages: results for previously requested tool calls */
  toolResults?: InternalToolResult[];
}

// ============================================================================
// Tool schemas
// ============================================================================

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ============================================================================
// Request
// ============================================================================

export interface ReasoningOptions {
  effort: ReasoningEffort;
  /** Explicit token budget when the caller wants one (Anthropic dialect) */
  budgetTokens?: number;
}

export interface ChatRequest {
  model: string;
  /** Top-level system instruction */
  system?: string;
  messages: InternalMessage[];
  tools?: ToolSchema[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: ReasoningOptions;
  /** Defaults to true. Non-streaming requests aggregate into the same event shape. */
  stream?: boolean;
  /** Escape hatch: extra body fields merged into the provider request */
  extraBody?: Record<string, unknown>;
  /** Escape hatch: extra headers for this request only */
  extraHeaders?: Record<string, string>;
}

// ============================================================================
// Stream events
// ============================================================================

export interface UsageEvent {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type ProviderStreamEvent =
  | { type: 'response-started'; data: { model: string }; timestamp: string }
  | { type: 'text-delta'; data: { text: string }; timestamp: string }
  | { type: 'reasoning-delta'; data: { text: string }; timestamp: string }
  | {
      type: 'reasoning-metadata';
      data: { effort: ReasoningEffort; budgetTokens?: number };
      timestamp: string;
    }
  | {
      type: 'tool-call-started';
      data: { id: string; name: string; index: number };
      timestamp: string;
    }
  | { type: 'tool-call-arguments'; data: { id: string; delta: string }; timestamp: string }
  | {
      type: 'tool-call-completed';
      data: { id: string; name: string; arguments: Record<string, unknown> };
      timestamp: string;
    }
  | {
      type: 'tool-call-invalid';
      data: { id: string; name: string; rawArguments: string; error: string };
      timestamp: string;
    }
  | { type: 'usage-updated'; data: UsageEvent; timestamp: string }
  | {
      type: 'response-completed';
      data: { stopReason: string | null; toolCalls: InternalToolCall[] };
      timestamp: string;
    }
  | { type: 'error'; data: AppError; timestamp: string }
  | { type: 'cancelled'; data: { reason: string }; timestamp: string };

export type ProviderStreamEventType = ProviderStreamEvent['type'];

// ============================================================================
// Model discovery
// ============================================================================

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  createdAt?: string;
  ownedBy?: string;
  /** Provider-reported context window (never inferred from name!) */
  contextLength?: number;
  maxOutputTokens?: number;
  /** Capability flags as reported by the provider */
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  /** Reasoning effort levels the provider reports for this model */
  reasoningLevels?: string[];
  reasoningDefault?: string;
  /** Access tier where providers classify it (e.g. xKiro free/paid/premium) */
  accessTier?: string;
  /** Pricing as reported by the provider */
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    currency: string;
  };
  /** Raw provider payload for diagnostics */
  raw?: Record<string, unknown>;
}

// ============================================================================
// Adapter interface
// ============================================================================

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Provider-reported account usage/balance, returned only from documented
 * endpoints. When the endpoint shape is not recognized, `available` stays
 * false and no values are invented.
 */
export interface ProviderAccountUsage {
  available: boolean;
  message: string;
  /** Provider-reported values, formatted for display */
  values?: Array<{ label: string; value: string }>;
  /** Raw payload for diagnostics (never displayed as balance) */
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly metadata: ProviderMetadata;
  /** Stream chat events. Errors are yielded as `error` events, not thrown. */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent>;
  /** Discover models from the provider API. */
  listModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  /** Count input tokens when the provider supports it. */
  countTokens?(request: ChatRequest, signal?: AbortSignal): Promise<number>;
  /** Verify credentials with a cheap call. */
  validateCredentials?(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  /**
   * Query the provider's documented usage/balance endpoint when one exists.
   * Absent when the provider exposes no such interface — callers must show
   * the balance as unknown, never estimated as official.
   */
  getAccountUsage?(signal?: AbortSignal): Promise<ProviderAccountUsage>;
}

// ============================================================================
// Helpers
// ============================================================================

export function nowIso(): string {
  return new Date().toISOString();
}

export function event<T extends ProviderStreamEvent>(ev: Omit<T, 'timestamp'>): T {
  return { ...ev, timestamp: nowIso() } as T;
}
