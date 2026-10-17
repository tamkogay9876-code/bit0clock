/**
 * Core type definitions for mediaXG
 */

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType = 'openai-compatible' | 'anthropic-compatible' | 'xkiro';

export type ApiProtocol = 'openai-chat' | 'anthropic-messages';

export interface ProviderMetadata {
  id: string;
  type: ProviderType;
  displayName: string;
  baseUrl: string;
  protocol: ApiProtocol;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsReasoning: boolean;
  supportsImageInput: boolean;
  supportsTokenCounting: boolean;
  maxOutputTokens?: number;
  defaultHeaders?: Record<string, string>;
  credentialRef?: string;
  enabled: boolean;
  verified: boolean;
  lastVerifiedAt?: string;
}

export interface ModelCapability {
  id: string;
  providerId: string;
  displayName: string;
  protocol: ApiProtocol;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsToolCalls: boolean;
  supportsStreaming: boolean;
  supportsReasoning: boolean;
  supportsImageInput: boolean;
  inputModalities: string[];
  outputModalities: string[];
  pricing?: ModelPricing;
  discoverySource: 'provider-api' | 'documented' | 'manual' | 'cached' | 'inferred';
  discoveredAt?: string;
  verified: boolean;
}

export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  reasoningPerMillion?: number;
  currency: string;
  source: string;
  updatedAt: string;
  confidence: 'high' | 'medium' | 'low';
}

// ============================================================================
// Agent Modes, Reasoning, Tool Records
// ============================================================================

export type AgentMode = 'plan' | 'build' | 'review';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max' | 'auto';

export type ResponseStyle = 'concise' | 'balanced' | 'detailed';

/** Summary record of one executed tool call (used by plans and diagnostics). */
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError: boolean;
  durationMs: number;
  executedAt: string;
}

export interface Plan {
  id: string;
  goal: string;
  constraints: string[];
  relevantFiles: string[];
  proposedSteps: PlanStep[];
  risks: string[];
  requiredPermissions: string[];
  verificationPlan: string;
  currentStepIndex: number;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'blocked' | 'skipped';
  toolCalls: ToolCallRecord[];
  result?: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================================================
// Context Types
// ============================================================================

export interface ContextBudget {
  requestedTokens: number;
  modelContextLimit?: number;
  providerInputLimit?: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  estimatedInputTokens: number;
  effectiveBudget: number;
  remainingHeadroom: number;
  source: string;
  timestamp: string;
}

export interface ContextProfile {
  id: string;
  name: string;
  description: string;
  maxTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  isDefault: boolean;
}

export interface ContextItem {
  id: string;
  type:
    | 'system'
    | 'user-instruction'
    | 'project-instruction'
    | 'task'
    | 'skill'
    | 'conversation'
    | 'summary'
    | 'source'
    | 'pinned'
    | 'tool-output'
    | 'evidence';
  content: string;
  priority: number;
  source: string;
  provenance: string;
  tokenEstimate: number;
  included: boolean;
  reason?: string;
}

export interface CompactionResult {
  originalMessageCount: number;
  compactedMessageCount: number;
  preservedItems: string[];
  summary: string;
  timestamp: string;
}

// ============================================================================
// Tool Types
// ============================================================================

export type PermissionClass = 'read' | 'write' | 'execute' | 'network' | 'mcp' | 'config' | 'git';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  permissionClass: PermissionClass;
  timeoutMs: number;
  outputBudgetBytes: number;
  handler: ToolHandler;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  mode: AgentMode;
  permissions: PermissionSet;
  signal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionSet {
  allowed: PermissionClass[];
  denied: PermissionClass[];
  rules: PermissionRule[];
}

export interface PermissionRule {
  id: string;
  action: string;
  pattern: string;
  effect: 'allow' | 'deny';
  scope: 'global' | 'project' | 'session';
}

// ============================================================================
// MCP Types
// ============================================================================

export interface MCPServerConfig {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  auth?: MCPAuthConfig;
  timeoutMs: number;
  outputLimitBytes: number;
  /** Tools explicitly disabled by the user (/mcp permissions <server> <tool> off) */
  disabledTools?: string[];
}

export interface MCPAuthConfig {
  type: 'bearer' | 'api-key' | 'oauth';
  credentialRef: string;
  headerName?: string;
}

export interface MCPTool {
  serverName: string;
  name: string;
  /** Human title advertised by the server, when present */
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  lastError?: string;
  lastConnectedAt?: string;
  /** Effective per-call timeout (server config bounded by policy) */
  timeoutMs?: number;
  /** Effective per-call output cap in characters */
  outputBudget?: number;
}

export interface MCPResource {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  serverName: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type MCPServerStatus = 'idle' | 'connecting' | 'ready' | 'error';

/**
 * Live state of one configured MCP server (§37): connection, discovered
 * capabilities, and the most recent failure. Never claims capabilities that
 * were not actually discovered over a connection.
 */
export interface MCPServerState {
  name: string;
  transport: 'http' | 'stdio';
  enabled: boolean;
  status: MCPServerStatus;
  /** Server implementation name/version from the MCP initialize handshake */
  serverName?: string;
  serverVersion?: string;
  /** Optional description advertised by the server during initialize */
  instructions?: string;
  lastConnectedAt?: string;
  lastError?: string;
  /** Capabilities advertised during initialize (what the server actually offers) */
  capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

export interface MCPLogEntry {
  at: string;
  server: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// ============================================================================
// Skill Types
// ============================================================================

export interface Skill {
  name: string;
  description: string;
  path: string;
  instructions: string;
  references: SkillReference[];
  assets: SkillAsset[];
  activated: boolean;
  scope: 'global' | 'project' | 'user';
  trustLevel: 'trusted' | 'untrusted';
  validated: boolean;
  validationErrors: string[];
  /** Optional scalar frontmatter fields kept verbatim (compatibility) */
  metadata?: Record<string, string>;
  /** Absolute directory containing SKILL.md */
  skillDir?: string;
  /** Absolute path of the SKILL.md file */
  filePath?: string;
  /** Modification stamp of SKILL.md at the last scan */
  mtimeMs?: number;
  sizeBytes?: number;
  /** Instructions were capped at the configured limit */
  truncated?: boolean;
  /** Other scopes that defined the same skill name (shadowed, lower precedence) */
  conflicts?: string[];
}

export interface SkillReference {
  path: string;
  content?: string;
  loaded: boolean;
}

export interface SkillAsset {
  path: string;
  type: string;
  size: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

/** Context engine behavior (§23–§28). All values are conservative defaults. */
export interface ContextEngineConfig {
  /**
   * Conservative context limit used when neither the model nor the provider
   * reports a reliable limit. Labeled unverified wherever it is shown.
   */
  fallbackLimit: number;
  /** Compact the oldest messages automatically when a request would overflow. */
  autoCompact: boolean;
  /** Keep original messages of compacted ranges restorable with /compact restore. */
  preserveOriginalHistory: boolean;
  /** Incremental repository retrieval (§26). Off by default. */
  retrieval: {
    enabled: boolean;
    /** Maximum files included per request */
    maxFiles: number;
    /** Maximum estimated tokens per included snippet */
    maxSnippetTokens: number;
    /** Maximum files indexed per workspace scan */
    maxFilesScanned: number;
  };
  /** When to call a provider token-count endpoint during preflight (§28). */
  countTokensEndpoint: 'off' | 'pressure' | 'always';
}

export interface AppConfig {
  version: number;
  defaultProvider?: string;
  defaultModel?: string;
  providers: ProviderConfig[];
  contextProfiles: ContextProfile[];
  defaultContextProfile: string;
  contextEngine: ContextEngineConfig;
  reasoningDefaults: ReasoningDefaults;
  spendingLimits: SpendingLimits;
  permissionRules: PermissionRule[];
  mcpServers: MCPServerConfig[];
  skillsPaths: string[];
  /** Skill discovery/trust settings (§32–§34) */
  skillsSettings: SkillsSettings;
  agentLoopLimits: AgentLoopLimits;
  logging: LoggingConfig;
  sessionStorage: SessionStorageConfig;
  outputRendering: OutputRenderingConfig;
  featureFlags: Record<string, boolean>;
}

export interface SkillsSettings {
  /** Toggle skill discovery entirely */
  enabled: boolean;
  /** Path prefixes whose skills are classified as trusted (still never permissions) */
  trustedPaths: string[];
  /** Maximum SKILL.md files scanned per discovery */
  maxFiles: number;
}

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  baseUrl: string;
  credentialRef?: string;
  defaultHeaders?: Record<string, string>;
  enabled: boolean;
  /** xKiro: which documented protocol to use for generation */
  protocol?: ApiProtocol;
  /** Auth header style preference */
  authStyle?: 'bearer' | 'x-api-key';
  /**
   * Provider-specific input limit in tokens, when the provider documents one
   * that is stricter than the model context window. Never guessed.
   */
  inputLimit?: number;
  models?: ManualModelConfig[];
}

export interface ManualModelConfig {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsToolCalls: boolean;
  supportsStreaming: boolean;
  supportsReasoning: boolean;
}

export interface ReasoningDefaults {
  effort: ReasoningEffort;
  budget?: number;
  responseStyle: 'concise' | 'balanced' | 'detailed';
  temperature?: number;
  outputLimit?: number;
}

export interface SpendingLimits {
  maxPerRequest?: number;
  maxDaily?: number;
  maxMonthly?: number;
  maxPerSession?: number;
  largeContextConfirmationThreshold?: number;
  minimumBalance?: number;
  unknownBalancePolicy: 'allow' | 'block' | 'confirm';
  currency: string;
}

export interface AgentLoopLimits {
  maxIterations: number;
  maxToolCallsPerIteration: number;
  maxConcurrentToolCalls: number;
  toolTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
  maxSizeMb: number;
  maxFiles: number;
  redactSecrets: boolean;
}

export interface SessionStorageConfig {
  path: string;
  autoSaveIntervalMs: number;
  maxSessions: number;
  maxMessagesPerSession: number;
}

export interface OutputRenderingConfig {
  colorEnabled: boolean;
  unicodeEnabled: boolean;
  maxLineLength: number;
  streamingChunkSize: number;
}

// ============================================================================
// Error Types
// ============================================================================

export type ErrorCategory =
  | 'authentication'
  | 'invalid-model'
  | 'missing-capability'
  | 'insufficient-quota'
  | 'rate-limit'
  | 'context-overflow'
  | 'output-limit'
  | 'network'
  | 'server'
  | 'tool-validation'
  | 'timeout'
  | 'cancellation'
  | 'permission-denied'
  | 'path-traversal'
  | 'credential-not-found'
  | 'config-invalid'
  | 'storage-error'
  | 'unknown';

export interface AppError {
  category: ErrorCategory;
  message: string;
  provider?: string;
  model?: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

// ============================================================================
// Streaming Types
// ============================================================================

export type StreamEventType =
  | 'response-started'
  | 'text-delta'
  | 'reasoning-metadata'
  | 'tool-call-started'
  | 'tool-call-arguments'
  | 'tool-call-completed'
  | 'usage-updated'
  | 'response-completed'
  | 'error'
  | 'cancelled';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  timestamp: string;
}

export interface TextDeltaEvent {
  text: string;
  messageId: string;
}

export interface ReasoningMetadataEvent {
  effort: ReasoningEffort;
  budget?: number;
  tokensUsed?: number;
}

export interface ToolCallStartedEvent {
  id: string;
  name: string;
  messageId: string;
}

export interface ToolCallArgumentsEvent {
  id: string;
  arguments: string;
}

export interface ToolCallCompletedEvent {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UsageUpdatedEvent {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

// ============================================================================
// Budget Types
// ============================================================================

export interface BudgetStatus {
  sessionSpend: number;
  dailySpend: number;
  monthlySpend: number;
  perRequestEstimate?: number;
  currency: string;
  limits: SpendingLimits;
  canAfford: boolean;
  warnings: string[];
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  currency: string;
  pricingSource: string;
  confidence: 'high' | 'medium' | 'low';
  isApproximate: boolean;
}

// ============================================================================
// Diagnostic Types
// ============================================================================

export type DiagnosticStatus =
  'healthy' | 'degraded' | 'unavailable' | 'not-configured' | 'not-verified' | 'blocked';

export interface DiagnosticResult {
  name: string;
  status: DiagnosticStatus;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface DoctorReport {
  overall: DiagnosticStatus;
  checks: DiagnosticResult[];
  timestamp: string;
}
