/**
 * Session data model — versioned, persistable, resumable.
 *
 * Messages store the vendor-neutral internal representation so adapters
 * can always convert them. Never stores secrets.
 */

import type {
  AgentMode,
  Plan,
  ReasoningEffort,
  ResponseStyle,
  ToolCallRecord,
} from '../types/index.js';
import type {
  InternalContentPart,
  InternalToolCall,
  InternalToolResult,
} from '../providers/types.js';
import type { ChangeRecord } from '../tools/ledger.js';
import type { PermissionAuditEntry } from '../permissions/types.js';

export const SESSION_SCHEMA_VERSION = 2;

export interface StoredMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | InternalContentPart[];
  /** Assistant messages: tool calls requested by the model */
  toolCalls?: InternalToolCall[];
  /** Tool messages: results for requested tool calls */
  toolResults?: InternalToolResult[];
  /** Provider/model that produced this message (assistant only) */
  providerId?: string;
  modelId?: string;
  usage?: StoredUsage;
  error?: string;
  timestamp: string;
  /** Set on compaction summary messages (§27) */
  summaryMeta?: { level: number; covers: number; chunkId: string };
}

export interface StoredUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** Locally estimated from the pricing snapshot; never the provider's invoice */
  estimatedCost?: number;
  currency?: string;
}

export interface SessionUsageAggregate {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** Sum of local estimates; labeled estimated everywhere it is shown */
  estimatedCost: number;
  /** Sum of preflight input estimates for requests that were actually sent */
  estimatedInputTokens: number;
  currency: string;
  /** Number of completed requests contributing to this aggregate */
  requests: number;
}

/** One generated compaction summary (§27). */
export interface SummaryRecord {
  id: string;
  level: number;
  /** ISO timestamp */
  at: string;
  /** How many original messages this summary covers */
  coversMessages: number;
  /** Estimated tokens of the summary text */
  tokens: number;
  summaryMessageId: string;
}

/** Original messages of a compacted range, when preservation is enabled. */
export interface CompactionChunk {
  id: string;
  at: string;
  level: number;
  summaryMessageId: string;
  /** True while the original messages are retained and restorable */
  payloadRetained: boolean;
  messages: StoredMessage[];
}

/** One assembled context item, persisted for /context inspect (§31). */
export interface ContextReportItem {
  type: string;
  label: string;
  provenance: string;
  priority: number;
  tokens: number;
  included: boolean;
  reason: string;
}

/** Bounded record of the most recent context assembly, persisted per session. */
export interface ContextReportSummary {
  at: string;
  estimatedInputTokens: number;
  estimateSource: string;
  estimateNote?: string;
  requestedTokens: number;
  requestOrigin: 'profile' | 'custom' | 'auto';
  modelContextLimit?: number;
  providerInputLimit?: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  effectiveBudget: number;
  remainingHeadroom: number;
  capabilitySource: string;
  capabilityVerified: boolean;
  items: ContextReportItem[];
  omittedMessages: number;
  compactedMessages: number;
  retrievalFiles: string[];
  gateAction: 'allow' | 'confirm' | 'block';
  notes: string[];
}

export interface SessionReasoningState {
  effort: ReasoningEffort;
  budgetTokens?: number;
}

export interface SessionData {
  version: typeof SESSION_SCHEMA_VERSION;
  id: string;
  name: string;
  messages: StoredMessage[];
  providerId?: string;
  modelId?: string;
  mode: AgentMode;
  reasoning: SessionReasoningState;
  responseStyle: ResponseStyle;
  temperature?: number;
  outputLimit?: number;
  contextProfile: string;
  /** User-requested context budget in tokens (overrides the profile) */
  requestedContext?: number;
  usage: SessionUsageAggregate;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  /** True when the app closed while a request was in flight */
  interrupted?: boolean;
  // ---------------------------------------------------------------------
  // v2 fields (added in Phase D)
  // ---------------------------------------------------------------------
  /** Structured plan recorded via the update_plan tool (§45) */
  plan?: Plan | null;
  /** Undo journal for agent-made file changes (§43) */
  changeLedger?: ChangeRecord[];
  /** Bounded history of executed tool calls (inspectability) */
  toolHistory?: ToolCallRecord[];
  /** Permission decisions made during this session (§52) */
  permissionAudit?: PermissionAuditEntry[];
  // ---------------------------------------------------------------------
  // v2 fields (added in Phase E — all optional, additive)
  // ---------------------------------------------------------------------
  /** Session override for repository retrieval (§26); config is the default */
  retrievalEnabled?: boolean;
  /** Generated compaction summaries (§27) */
  summaries?: SummaryRecord[];
  /** Original messages of compacted ranges (when preservation is enabled) */
  compactedChunks?: CompactionChunk[];
  /** Most recent context assembly report for /context inspect (§31) */
  lastContextReport?: ContextReportSummary;
  /** Workspace-relative files the user pinned into every request (§25 priority 9) */
  pinnedPaths?: string[];
}

export interface SessionSummary {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
  providerId?: string;
  modelId?: string;
  mode: AgentMode;
  estimatedCost: number;
  currency: string;
  projectPath: string;
}

export function emptyUsage(currency = 'USD'): SessionUsageAggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    estimatedCost: 0,
    estimatedInputTokens: 0,
    currency,
    requests: 0,
  };
}

export function addUsage(
  aggregate: SessionUsageAggregate,
  delta: StoredUsage,
): SessionUsageAggregate {
  return {
    inputTokens: aggregate.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: aggregate.outputTokens + (delta.outputTokens ?? 0),
    cachedInputTokens: aggregate.cachedInputTokens + (delta.cachedInputTokens ?? 0),
    reasoningTokens: aggregate.reasoningTokens + (delta.reasoningTokens ?? 0),
    estimatedCost: aggregate.estimatedCost + (delta.estimatedCost ?? 0),
    estimatedInputTokens: aggregate.estimatedInputTokens ?? 0,
    currency: delta.currency ?? aggregate.currency,
    requests: aggregate.requests + 1,
  };
}

export function summarize(session: SessionData): SessionSummary {
  const summary: SessionSummary = {
    id: session.id,
    name: session.name,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messageCount: session.messages.filter((m) => m.role !== 'system').length,
    mode: session.mode,
    estimatedCost: session.usage.estimatedCost,
    currency: session.usage.currency,
    projectPath: session.projectPath,
  };
  if (session.providerId) summary.providerId = session.providerId;
  if (session.modelId) summary.modelId = session.modelId;
  return summary;
}
