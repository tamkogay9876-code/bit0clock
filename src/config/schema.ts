/**
 * Configuration schema validation using Zod
 */

import { z } from 'zod';

// ============================================================================
// Provider Schemas
// ============================================================================

export const providerConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['openai-compatible', 'anthropic-compatible', 'xkiro']),
  baseUrl: z.string().url().or(z.string().min(1)),
  credentialRef: z.string().optional(),
  defaultHeaders: z.record(z.string()).optional(),
  enabled: z.boolean(),
  protocol: z.enum(['openai-chat', 'anthropic-messages']).optional(),
  authStyle: z.enum(['bearer', 'x-api-key']).optional(),
  /** Provider-specific documented input limit (stricter than the model window) */
  inputLimit: z.number().positive().optional(),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        contextWindow: z.number().positive().optional(),
        maxOutputTokens: z.number().positive().optional(),
        supportsToolCalls: z.boolean(),
        supportsStreaming: z.boolean(),
        supportsReasoning: z.boolean(),
      }),
    )
    .optional(),
});

// ============================================================================
// Context Profile Schemas
// ============================================================================

export const contextProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** 0 means the budget is determined at runtime (auto profile) */
  maxTokens: z.number().nonnegative(),
  reservedOutputTokens: z.number().nonnegative(),
  safetyMargin: z.number().nonnegative(),
  isDefault: z.boolean(),
});

// ============================================================================
// Reasoning Defaults Schema
// ============================================================================

export const reasoningDefaultsSchema = z.object({
  effort: z.enum(['off', 'low', 'medium', 'high', 'max', 'auto']),
  budget: z.number().positive().optional(),
  responseStyle: z.enum(['concise', 'balanced', 'detailed']),
  temperature: z.number().min(0).max(2).optional(),
  outputLimit: z.number().positive().optional(),
});

// ============================================================================
// Spending Limits Schema
// ============================================================================

export const spendingLimitsSchema = z.object({
  maxPerRequest: z.number().positive().optional(),
  maxDaily: z.number().positive().optional(),
  maxMonthly: z.number().positive().optional(),
  maxPerSession: z.number().positive().optional(),
  largeContextConfirmationThreshold: z.number().positive().optional(),
  minimumBalance: z.number().nonnegative().optional(),
  unknownBalancePolicy: z.enum(['allow', 'block', 'confirm']),
  currency: z.string().length(3),
});

// ============================================================================
// Permission Rule Schema
// ============================================================================

export const permissionRuleSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  pattern: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['global', 'project', 'session']),
});

// ============================================================================
// MCP Server Config Schema
// ============================================================================

export const mcpAuthConfigSchema = z.object({
  type: z.enum(['bearer', 'api-key', 'oauth']),
  credentialRef: z.string().min(1),
  headerName: z.string().optional(),
});

export const mcpServerConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
      'MCP server names use letters, digits, dot, dash, underscore',
    ),
  transport: z.enum(['http', 'stdio']),
  url: z.string().url().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean(),
  auth: mcpAuthConfigSchema.optional(),
  timeoutMs: z.number().positive(),
  outputLimitBytes: z.number().positive(),
  /** Tools explicitly disabled by the user (/mcp permissions <server> <tool> off) */
  disabledTools: z.array(z.string()).optional(),
});

// ============================================================================
// Skills Settings Schema (§32–§34)
// ============================================================================

export const skillsSettingsSchema = z.object({
  /** Toggle skill discovery entirely */
  enabled: z.boolean(),
  /**
   * Path prefixes whose discovered skills are classified as trusted.
   * Everything else stays untrusted (data, never permissions).
   */
  trustedPaths: z.array(z.string()),
  /** Maximum number of skills scanned (each SKILL.md is at most a few KB) */
  maxFiles: z.number().positive(),
});

// ============================================================================
// Agent Loop Limits Schema
// ============================================================================

export const agentLoopLimitsSchema = z.object({
  maxIterations: z.number().positive(),
  maxToolCallsPerIteration: z.number().positive(),
  maxConcurrentToolCalls: z.number().positive(),
  toolTimeoutMs: z.number().positive(),
  requestTimeoutMs: z.number().positive(),
});

// ============================================================================
// Context Engine Schema
// ============================================================================

export const contextEngineSchema = z.object({
  fallbackLimit: z.number().positive(),
  autoCompact: z.boolean(),
  preserveOriginalHistory: z.boolean(),
  retrieval: z.object({
    enabled: z.boolean(),
    maxFiles: z.number().positive(),
    maxSnippetTokens: z.number().positive(),
    maxFilesScanned: z.number().positive(),
  }),
  countTokensEndpoint: z.enum(['off', 'pressure', 'always']),
});

// ============================================================================
// Logging Config Schema
// ============================================================================

export const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  file: z.string().optional(),
  maxSizeMb: z.number().positive(),
  maxFiles: z.number().positive(),
  redactSecrets: z.boolean(),
});

// ============================================================================
// Session Storage Config Schema
// ============================================================================

export const sessionStorageConfigSchema = z.object({
  path: z.string().min(1),
  autoSaveIntervalMs: z.number().positive(),
  maxSessions: z.number().positive(),
  maxMessagesPerSession: z.number().positive(),
});

// ============================================================================
// Output Rendering Config Schema
// ============================================================================

export const outputRenderingConfigSchema = z.object({
  colorEnabled: z.boolean(),
  unicodeEnabled: z.boolean(),
  maxLineLength: z.number().positive(),
  streamingChunkSize: z.number().positive(),
});

// ============================================================================
// Main Config Schema
// ============================================================================

export const appConfigSchema = z.object({
  version: z.number().int().positive(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  providers: z.array(providerConfigSchema),
  contextProfiles: z.array(contextProfileSchema),
  defaultContextProfile: z.string().min(1),
  contextEngine: contextEngineSchema,
  reasoningDefaults: reasoningDefaultsSchema,
  spendingLimits: spendingLimitsSchema,
  permissionRules: z.array(permissionRuleSchema),
  mcpServers: z.array(mcpServerConfigSchema),
  skillsPaths: z.array(z.string()),
  skillsSettings: skillsSettingsSchema,
  agentLoopLimits: agentLoopLimitsSchema,
  logging: loggingConfigSchema,
  sessionStorage: sessionStorageConfigSchema,
  outputRendering: outputRenderingConfigSchema,
  featureFlags: z.record(z.boolean()),
});

export type AppConfigInput = z.infer<typeof appConfigSchema>;

// ============================================================================
// Default Configuration
// ============================================================================

export const defaultConfig: AppConfigInput = {
  version: 1,
  providers: [],
  contextProfiles: [
    {
      id: 'small',
      name: 'Small',
      description: 'Conservative context for simple tasks',
      maxTokens: 32000,
      reservedOutputTokens: 4000,
      safetyMargin: 2000,
      isDefault: false,
    },
    {
      id: 'standard',
      name: 'Standard',
      description: 'Balanced context for most tasks',
      maxTokens: 128000,
      reservedOutputTokens: 8000,
      safetyMargin: 4000,
      isDefault: true,
    },
    {
      id: 'large',
      name: 'Large',
      description: 'Extended context for complex tasks',
      maxTokens: 500000,
      reservedOutputTokens: 16000,
      safetyMargin: 8000,
      isDefault: false,
    },
    {
      id: 'xlarge',
      name: 'XLarge',
      description: 'Very large context for extensive tasks',
      maxTokens: 2000000,
      reservedOutputTokens: 32000,
      safetyMargin: 16000,
      isDefault: false,
    },
    {
      id: '1m',
      name: '1M',
      description: '1 million token context',
      maxTokens: 1000000,
      reservedOutputTokens: 16000,
      safetyMargin: 8000,
      isDefault: false,
    },
    {
      id: '2m',
      name: '2M',
      description: '2 million token context',
      maxTokens: 2000000,
      reservedOutputTokens: 32000,
      safetyMargin: 16000,
      isDefault: false,
    },
    {
      id: '5m',
      name: '5M',
      description: '5 million token context',
      maxTokens: 5000000,
      reservedOutputTokens: 64000,
      safetyMargin: 32000,
      isDefault: false,
    },
    {
      id: 'auto',
      name: 'Auto',
      description: 'Automatically select based on task and model',
      maxTokens: 0,
      reservedOutputTokens: 0,
      safetyMargin: 0,
      isDefault: false,
    },
  ],
  defaultContextProfile: 'standard',
  contextEngine: {
    fallbackLimit: 32000,
    autoCompact: true,
    preserveOriginalHistory: true,
    retrieval: {
      enabled: false,
      maxFiles: 4,
      maxSnippetTokens: 1500,
      maxFilesScanned: 20000,
    },
    countTokensEndpoint: 'pressure',
  },
  reasoningDefaults: {
    effort: 'medium',
    responseStyle: 'balanced',
  },
  spendingLimits: {
    unknownBalancePolicy: 'confirm',
    currency: 'USD',
  },
  permissionRules: [],
  mcpServers: [],
  skillsPaths: [],
  skillsSettings: {
    enabled: true,
    trustedPaths: [],
    maxFiles: 500,
  },
  agentLoopLimits: {
    maxIterations: 50,
    maxToolCallsPerIteration: 10,
    maxConcurrentToolCalls: 3,
    toolTimeoutMs: 30000,
    requestTimeoutMs: 120000,
  },
  logging: {
    level: 'info',
    maxSizeMb: 10,
    maxFiles: 5,
    redactSecrets: true,
  },
  sessionStorage: {
    path: '~/.config/mediaxg/sessions/',
    autoSaveIntervalMs: 30000,
    maxSessions: 100,
    maxMessagesPerSession: 1000,
  },
  outputRendering: {
    colorEnabled: true,
    unicodeEnabled: true,
    maxLineLength: 120,
    streamingChunkSize: 100,
  },
  featureFlags: {
    skills: true,
    mcp: true,
    compaction: true,
    projectMemory: true,
    gitWorkflows: true,
  },
};

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateConfig(
  input: unknown,
): { success: true; data: AppConfigInput } | { success: false; errors: string[] } {
  const result = appConfigSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  return { success: false, errors };
}

/**
 * User/project config files may be written by hand and contain only the keys
 * the user wants to change. They are validated against this deep-partial
 * schema, merged with defaults, and the merged result is validated again
 * against the full schema before use.
 */
export const partialAppConfigSchema = appConfigSchema.deepPartial();

export function validatePartialConfig(
  input: unknown,
): { success: true; data: Partial<AppConfigInput> } | { success: false; errors: string[] } {
  const result = partialAppConfigSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data as Partial<AppConfigInput> };
  }
  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  return { success: false, errors };
}

/**
 * Merge a project config over a user config section by section, so a project
 * file only overrides the keys it actually sets (a project file that only
 * changes `spendingLimits.maxDaily` must not reset the rest of that section).
 */
export function mergeConfigSources(
  user: Partial<AppConfigInput>,
  project: Partial<AppConfigInput>,
): Partial<AppConfigInput> {
  const merged: Record<string, unknown> = { ...user, ...project };

  const sections = [
    'reasoningDefaults',
    'spendingLimits',
    'agentLoopLimits',
    'logging',
    'sessionStorage',
    'outputRendering',
    'skillsSettings',
    'featureFlags',
  ] as const;
  for (const key of sections) {
    const fromUser = user[key] as Record<string, unknown> | undefined;
    const fromProject = project[key] as Record<string, unknown> | undefined;
    if (fromUser || fromProject) {
      merged[key] = { ...(fromUser ?? {}), ...(fromProject ?? {}) };
    }
  }

  const userEngine = user.contextEngine as Record<string, unknown> | undefined;
  const projectEngine = project.contextEngine as Record<string, unknown> | undefined;
  if (userEngine || projectEngine) {
    merged['contextEngine'] = {
      ...(userEngine ?? {}),
      ...(projectEngine ?? {}),
      retrieval: {
        ...((userEngine?.['retrieval'] as Record<string, unknown>) ?? {}),
        ...((projectEngine?.['retrieval'] as Record<string, unknown>) ?? {}),
      },
    };
  }

  return merged as Partial<AppConfigInput>;
}

export function mergeWithDefaults(input: Partial<AppConfigInput>): AppConfigInput {
  const defaultEngine = defaultConfig.contextEngine;
  const inputEngine = input.contextEngine;
  return {
    ...defaultConfig,
    ...input,
    contextEngine: {
      ...defaultEngine,
      ...inputEngine,
      retrieval: {
        ...defaultEngine.retrieval,
        ...(inputEngine?.retrieval ?? {}),
      },
    },
    reasoningDefaults: { ...defaultConfig.reasoningDefaults, ...input.reasoningDefaults },
    spendingLimits: { ...defaultConfig.spendingLimits, ...input.spendingLimits },
    agentLoopLimits: { ...defaultConfig.agentLoopLimits, ...input.agentLoopLimits },
    logging: { ...defaultConfig.logging, ...input.logging },
    sessionStorage: { ...defaultConfig.sessionStorage, ...input.sessionStorage },
    outputRendering: { ...defaultConfig.outputRendering, ...input.outputRendering },
    skillsSettings: { ...defaultConfig.skillsSettings, ...input.skillsSettings },
    featureFlags: { ...defaultConfig.featureFlags, ...input.featureFlags },
  };
}
