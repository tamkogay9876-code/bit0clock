/**
 * mediaXG - Premium AI Coding Agent
 *
 * Main exports for programmatic usage
 */

// Types
export * from './types/index.js';

// Config
export { getConfigManager, type ConfigLoadResult } from './config/manager.js';
export {
  validateConfig,
  mergeWithDefaults,
  defaultConfig,
  appConfigSchema,
} from './config/schema.js';

// Logger
export { getLogger, initializeLogger, type Logger, type LogEntry } from './logger/index.js';

// Errors
export {
  MediaXGError,
  authError,
  invalidModelError,
  missingCapabilityError,
  insufficientQuotaError,
  rateLimitError,
  contextOverflowError,
  outputLimitError,
  networkError,
  serverError,
  toolValidationError,
  timeoutError,
  cancellationError,
  permissionDeniedError,
  pathTraversalError,
  credentialNotFoundError,
  configInvalidError,
  storageError,
  isRetryable,
  getRetryAfter,
  normalizeError,
  formatError,
} from './errors/index.js';

// Utils
export {
  generateId,
  generateShortId,
  normalizePath,
  resolvePath,
  isPathSafe,
  ensureWithinWorkspace,
  estimateTokens,
  estimateMessagesTokens,
  truncate,
  truncateMiddle,
  formatBytes,
  formatDuration,
  formatCost,
  now,
  timestamp,
  isBinaryFile,
  getFileSize,
  chunk,
  unique,
  groupBy,
  sleep,
  withTimeout,
  retry,
  parseModelIdentifier,
  parseContextValue,
  isValidIdentifier,
  sanitizeFilename,
} from './utils/index.js';

// Diagnostics
export { runDoctor } from './diagnostics/index.js';

// Providers
export type {
  ProviderAdapter,
  ChatRequest,
  ProviderStreamEvent,
  InternalMessage,
  InternalToolCall,
  ToolSchema,
  DiscoveredModel,
  FetchLike,
  UsageEvent,
  ReasoningOptions,
} from './providers/types.js';
export { event as streamEvent, nowIso } from './providers/types.js';
export { parseSSEStream, type RawSSEEvent } from './providers/sse.js';
export { composeEndpoint, withQuery } from './providers/url.js';
export { httpErrorFromResponse, parseErrorBody } from './providers/http-errors.js';
export { OpenAICompatibleAdapter, type OpenAICompatibleConfig } from './providers/openai.js';
export {
  AnthropicCompatibleAdapter,
  type AnthropicCompatibleConfig,
} from './providers/anthropic.js';
export {
  createXKiroAdapter,
  xkiroMetadata,
  XKIRO_DEFAULT_BASE_URL,
  XKIRO_ENDPOINTS,
  XKIRO_WEB_MCP_URL,
  type XKiroProviderConfig,
} from './providers/xkiro.js';
export { createAdapterForProvider, type AdapterBuildContext } from './providers/registry.js';
export { chatWithRetry, type RetryPolicy } from './providers/retry.js';
export { collectCompletion, type CompletionResult } from './providers/collect.js';

// Models
export {
  ModelCatalog,
  type CatalogEntry,
  type ListModelsResult,
  type ModelCatalogOptions,
  type CapabilitySource,
} from './models/catalog.js';

// Credentials
export {
  EnvCredentialStore,
  FileCredentialStore,
  ChainCredentialStore,
  createDefaultCredentialStore,
  getCredentialStore,
  maskSecret,
  describeCredential,
  type CredentialStore,
} from './credentials/index.js';

// Sessions
export { SessionManager, type SessionManagerOptions } from './session/manager.js';
export {
  SESSION_SCHEMA_VERSION,
  emptyUsage,
  addUsage,
  summarize,
  type SessionData,
  type SessionSummary,
  type SessionUsageAggregate,
  type StoredMessage,
  type StoredUsage,
} from './session/types.js';

// Modes
export { MODES, isMode, modeLabel, type ModeDescriptor } from './modes/index.js';

// Application state
export { AppState, createDefaultAppState, type AppStateOptions } from './app/state.js';
export {
  connectProvider,
  disconnectProvider,
  buildProviderConfig,
  credentialRefFor,
  defaultProviderId,
  defaultBaseUrl,
  defaultProtocol,
  type ConnectRequest,
  type ConnectResult,
  type DisconnectOptions,
} from './app/connect.js';

// Commands
export { CommandRegistry } from './commands/registry.js';
export { parseInput, parseCommandTail, editDistance } from './commands/parser.js';
export {
  formatTokens,
  formatMoney,
  parseTokenCount,
  formatRelative,
  shortenId,
} from './commands/format.js';
export { registerBuiltinCommands } from './commands/builtin/index.js';
export type {
  CommandDefinition,
  CommandContext,
  CommandResult,
  CommandAction,
  CommandCategory,
  ParsedInput,
  CommandMatch,
} from './commands/types.js';

// Agent
export {
  sendChatMessage,
  buildChatRequest,
  buildSystemPrompt,
  toInternalMessages,
  type SendChatOptions,
  type SendChatResult,
} from './agent/chat.js';

// Non-interactive execution
export {
  runNonInteractive,
  createAppRegistry,
  type NonInteractiveIO,
} from './run/non-interactive.js';

// Agent loop
export {
  runAgentTurn,
  type AgentEvent,
  type AgentTurnOptions,
  type AgentTurnResult,
} from './agent/loop.js';

// Context engine (§23–§31)
export {
  CalibrationStore,
  CHARS_PER_TOKEN,
  estimateMessageTokens,
  estimateRequestInputTokens,
  estimateTextTokens,
  estimateToolSchemaTokens,
  providerCountEstimate,
  type CalibrationFactor,
  type CalibrationSample,
  type CalibrationStoreOptions,
  type TokenEstimate,
} from './context/tokens.js';
export {
  ARCHITECTURAL_MAX_CONTEXT,
  DEFAULT_AUTO_OUTPUT_RESERVE,
  budgetReport,
  computeEffectiveBudget,
  type CapabilityInfo,
  type EffectiveBudget,
} from './context/budget.js';
export {
  AUTO_TIERS,
  resolveAutoBudget,
  resolveContextTarget,
  type AutoBudgetInput,
  type AutoBudgetResult,
  type ContextTarget,
  type ResolveContextTargetInput,
} from './context/profiles.js';
export {
  CONTEXT_PRECEDENCE_RULES,
  CONTEXT_PRIORITY,
  CONTEXT_PRIORITY_LABELS,
  assembleContext,
  describeAssembly,
  includedItems,
  type AssembledItem,
  type ContextAssembly,
  type ContextAssemblyOptions,
  type ContextCandidate,
  type ContextItemType,
  type ContextTrust,
} from './context/assembly.js';
export {
  RepoIndex,
  isIndexableName,
  isSensitiveFile,
  looksBinary,
  tokenizeQuery,
  type RepoExtraction,
  type RepoFileEntry,
  type RepoIndexOptions,
  type RepoIndexStats,
  type RepoSearchOptions,
  type RepoSearchResult,
} from './context/retrieval.js';
export {
  DEFAULT_KEEP_RECENT_MESSAGES,
  MAX_COMPACTION_CHUNKS,
  MAX_SUMMARY_RECORDS,
  applyCompaction,
  planCompaction,
  restoreLastCompaction,
  type ApplyCompactionOptions,
  type ApplyCompactionResult,
  type CompactionPlan,
  type RestoreResult,
} from './context/compaction.js';
export { discoverInstructions, type InstructionBundle } from './context/instructions.js';
export {
  BudgetExceededError,
  BudgetGateError,
  fitConversationToBudget,
  prepareContextRequest,
  previewContextBudget,
  type ContextPreview,
  type PrepareContextOptions,
  type PreparedContextRequest,
} from './context/pipeline.js';

// Budget, pricing, gate (§29–§30)
export {
  evaluateBudgetGate,
  formatGateDecision,
  gateBlockedMessage,
  type BudgetGateCheck,
  type BudgetGateDecision,
  type BudgetGateInput,
  type GateAction,
} from './budget/gate.js';
export {
  describePricing,
  estimateRequestCost,
  estimateUsageCost,
  type CostEstimate,
  type UsageForCost,
} from './budget/pricing.js';
export {
  buildUsageAccount,
  localSpend,
  usageDeltaWithCost,
  type LocalSpendWindow,
  type UsageAccount,
} from './budget/accounting.js';

// Skills (§32–§34)
export {
  MAX_INSTRUCTION_CHARS,
  MAX_LISTED_FILES,
  MAX_REFERENCE_BYTES,
  MAX_SKILL_FILE_BYTES,
  SkillManager,
  type LoadedReference,
  type SkillDiagnostic,
  type SkillManagerOptions,
  type SkillManagerStats,
  type SkillPromptItem,
  type SkillReloadSummary,
  type SkillRoot,
  type SkillScope,
} from './skills/manager.js';
export { parseSkillFrontmatter, type SkillFrontmatter } from './skills/frontmatter.js';
export { createSkillTools, READ_SKILL_REFERENCE_TOOL } from './skills/tools.js';

// MCP (§35–§39)
export { MCPManager, mcpToolName, type McpManagerOptions } from './mcp/manager.js';
export {
  assertNoSecretsInUrl,
  createMcpClient,
  type CreateMcpClientOptions,
} from './mcp/client.js';
export type {
  McpAuthHeader,
  McpCallOptions,
  McpCallOutcome,
  McpClientFactory,
  McpClientLike,
  McpPromptInfo,
  McpResourceInfo,
  McpToolInfo,
} from './mcp/types.js';
export {
  loadPinnedFiles,
  PIN_MAX_BYTES,
  PIN_MAX_FILES,
  renderPinnedBlock,
  renderSkillsBlock,
  type PinnedFileContent,
} from './context/pipeline.js';
export {
  DEFAULT_MCP_OUTPUT_BYTES,
  DEFAULT_MCP_TIMEOUT_MS,
  defaultCredentialRef,
} from './commands/builtin/mcp.js';
