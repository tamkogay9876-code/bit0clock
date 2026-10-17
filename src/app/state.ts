/**
 * Application state: the single composition point for command handlers,
 * the TUI, and non-interactive execution.
 *
 * Holds config, credentials, the model catalog, sessions, and the active
 * session. Adapters are created lazily and cached per provider.
 */

import { resolve } from 'path';
import { homedir } from 'os';
import { getConfigManager, type ConfigManager } from '../config/manager.js';
import {
  createDefaultCredentialStore,
  getCredentialStore,
  type CredentialStore,
} from '../credentials/index.js';
import { ModelCatalog, type CatalogEntry, type ListModelsResult } from '../models/catalog.js';
import { SessionManager } from '../session/manager.js';
import { addUsage, type SessionData, type StoredUsage } from '../session/types.js';
import { createAdapterForProvider } from '../providers/registry.js';
import type { FetchLike, ProviderAdapter } from '../providers/types.js';
import type { AgentMode, AppConfig, ProviderConfig } from '../types/index.js';
import { getLogger } from '../logger/index.js';
import { invalidModelError, credentialNotFoundError } from '../errors/index.js';
import { SkillManager } from '../skills/manager.js';
import { MCPManager } from '../mcp/manager.js';
import { MemoryManager } from '../memory/store.js';
import { createPermissionEngine, type PermissionEngine } from '../permissions/engine.js';
import { CalibrationStore } from '../context/tokens.js';
import { RepoIndex } from '../context/retrieval.js';

export interface AppStateOptions {
  config: AppConfig;
  configManager?: ConfigManager;
  credentialStore?: CredentialStore;
  catalog?: ModelCatalog;
  sessionManager?: SessionManager;
  projectPath?: string;
  fetchImpl?: FetchLike;
  /** Injected permission engine (tests / custom policies) */
  permissionEngine?: PermissionEngine;
  /** Interactive runs may prompt for approval; non-interactive deny by default */
  interactive?: boolean;
  /** --yes: auto-approve actions that would otherwise require confirmation */
  autoApprove?: boolean;
  /** Injected token-calibration store (tests); defaults to the user config dir */
  calibrationStore?: CalibrationStore;
  /** Injected repository index (tests); created lazily otherwise */
  repoIndex?: RepoIndex;
  /** Injected skill manager (tests); created from config otherwise */
  skillManager?: SkillManager;
  /** Injected MCP manager (tests); created from config otherwise */
  mcpManager?: MCPManager;
  memoryManager?: MemoryManager;
}

export class AppState {
  readonly config: AppConfig;
  readonly configManager?: ConfigManager;
  readonly credentials: CredentialStore;
  readonly catalog: ModelCatalog;
  readonly sessionManager: SessionManager;
  readonly projectPath: string;
  /** Central permission engine used by every consequential action (§52) */
  readonly permissions: PermissionEngine;
  /** Observed estimate/actual token ratios per provider/model (§28) */
  readonly calibration: CalibrationStore;
  /** Whether confirmations can be asked interactively */
  readonly interactive: boolean;
  /** --yes: auto-approve confirmations (never bypasses blocks or read-only modes) */
  autoApprove: boolean;
  /** Skill discovery/activation manager (§32–§34) */
  readonly skills: SkillManager;
  /** MCP client manager (§35–§38) */
  readonly mcp: MCPManager;
  /** Persistent project memory (§48) */
  readonly memory: MemoryManager;

  /** The active session (always set; created on demand) */
  session: SessionData;

  private adapterCache = new Map<string, ProviderAdapter>();
  private repoIndex: RepoIndex | null;
  private logger = getLogger();

  /** Injected fetch (tests); undefined means the global fetch is used */
  readonly fetchImpl: FetchLike | undefined;

  constructor(options: AppStateOptions) {
    this.config = options.config;
    this.configManager = options.configManager;
    this.credentials = options.credentialStore ?? getCredentialStore();
    this.catalog = options.catalog ?? new ModelCatalog();
    this.projectPath = options.projectPath ?? process.cwd();
    this.fetchImpl = options.fetchImpl;
    this.interactive = options.interactive ?? false;
    this.autoApprove = options.autoApprove ?? false;
    this.calibration =
      options.calibrationStore ??
      new CalibrationStore({
        path: resolve(homedir(), '.config/mediaxg/token-calibration.json'),
      });
    this.repoIndex = options.repoIndex ?? null;

    this.skills =
      options.skillManager ??
      new SkillManager({
        workspaceRoot: this.projectPath,
        extraPaths: this.config.skillsPaths,
        trustedPaths: this.config.skillsSettings.trustedPaths,
        enabled: this.config.skillsSettings.enabled,
        maxFiles: this.config.skillsSettings.maxFiles,
      });

    this.mcp =
      options.mcpManager ??
      new MCPManager({
        config: this.config,
        credentialStore: this.credentials,
        workspaceRoot: this.projectPath,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

    this.memory = options.memoryManager ?? new MemoryManager({ projectPath: this.projectPath });

    this.sessionManager =
      options.sessionManager ??
      new SessionManager({
        directory: resolve(options.config.sessionStorage.path.replace(/^~/, homedir())),
        projectPath: this.projectPath,
      });

    // Resume the most recent session for this project, or start a new one
    const recent = this.sessionManager.list().find((s) => s.projectPath === this.projectPath);
    const loaded = recent ? this.sessionManager.load(recent.id) : null;
    this.session =
      loaded ??
      this.sessionManager.create({
        mode: 'build',
        contextProfile: options.config.defaultContextProfile,
      });

    if (this.session.interrupted) {
      // A previous run closed mid-request: mark it for the user, do not pretend it finished
      this.session.interrupted = false;
      this.sessionManager.save(this.session);
    }

    this.permissions =
      options.permissionEngine ??
      createPermissionEngine({
        workspaceRoot: this.projectPath,
        mode: this.session.mode,
        globalRules: this.config.permissionRules,
        interactive: options.interactive ?? false,
        autoApprove: options.autoApprove ?? false,
      });
  }

  // --------------------------------------------------------------------------
  // Providers and adapters
  // --------------------------------------------------------------------------

  getProviderConfig(providerId: string): ProviderConfig | undefined {
    return this.config.providers.find((p) => p.id === providerId);
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
    this.permissions.setAutoApprove(enabled);
  }

  enabledProviders(): ProviderConfig[] {
    return this.config.providers.filter((p) => p.enabled);
  }

  /**
   * Build (or reuse) the adapter for a provider with resolved credentials.
   * Throws structured errors for missing/disabled providers.
   */
  async getAdapter(providerId: string): Promise<ProviderAdapter> {
    const cached = this.adapterCache.get(providerId);
    if (cached) return cached;

    const providerConfig = this.getProviderConfig(providerId);
    if (!providerConfig) {
      throw new Error(`Provider not configured: ${providerId}. Use /connect to add it.`);
    }
    if (!providerConfig.enabled) {
      throw new Error(
        `Provider disabled: ${providerId}. Use /connect ${providerId} or /disconnect --forget to remove it.`,
      );
    }

    let apiKey: string | undefined;
    if (providerConfig.credentialRef) {
      apiKey = await this.credentials.get(providerConfig.credentialRef);
      if (!apiKey) {
        throw credentialNotFoundError(providerConfig.credentialRef);
      }
    }

    const adapter = createAdapterForProvider(providerConfig, { apiKey, fetchImpl: this.fetchImpl });
    this.adapterCache.set(providerId, adapter);
    return adapter;
  }

  invalidateAdapter(providerId: string): void {
    this.adapterCache.delete(providerId);
  }

  // --------------------------------------------------------------------------
  // Repository index (§26)
  // --------------------------------------------------------------------------

  /** Lazily built repository index, cached for the app's lifetime. */
  getRepoIndex(): RepoIndex {
    if (!this.repoIndex) {
      this.repoIndex = new RepoIndex({
        workspaceRoot: this.projectPath,
        maxFiles: this.config.contextEngine.retrieval.maxFilesScanned,
      });
    }
    return this.repoIndex;
  }

  invalidateRepoIndex(): void {
    this.repoIndex = null;
  }

  // --------------------------------------------------------------------------
  // Model selection
  // --------------------------------------------------------------------------

  /**
   * Resolve a model reference to a provider.
   * Accepts 'provider/model', full 'vendor/model' ids, or a unique suffix.
   * Returns all candidates when ambiguous — callers open a picker, never guess.
   */
  resolveModel(
    reference: string,
  ):
    | { kind: 'resolved'; providerId: string; modelId: string; entry?: CatalogEntry }
    | { kind: 'ambiguous'; candidates: CatalogEntry[] }
    | { kind: 'not-found' } {
    const providerIds = this.enabledProviders().map((p) => p.id);

    // 'provider/model' where provider matches a configured provider id
    const slash = reference.indexOf('/');
    if (slash > 0) {
      const maybeProvider = reference.slice(0, slash);
      if (this.getProviderConfig(maybeProvider)) {
        const modelId = reference.slice(slash + 1);
        const entry = this.catalog.findModel(modelId, [maybeProvider]);
        return { kind: 'resolved', providerId: maybeProvider, modelId, entry };
      }
    }

    // Search across all providers (exact or unique suffix)
    const exactCandidates: CatalogEntry[] = [];
    for (const pid of providerIds) {
      const cached = this.catalog.getCached(pid);
      if (cached) {
        const match = cached.models.find((m) => m.id === reference);
        if (match) exactCandidates.push(match);
      }
    }
    if (exactCandidates.length === 1) {
      const entry = exactCandidates[0]!;
      return { kind: 'resolved', providerId: entry.providerId, modelId: entry.id, entry };
    }
    if (exactCandidates.length > 1) {
      return { kind: 'ambiguous', candidates: exactCandidates };
    }

    const candidates = this.catalog.findModelsBySuffix(reference, providerIds);
    if (candidates.length === 1) {
      const entry = candidates[0]!;
      return { kind: 'resolved', providerId: entry.providerId, modelId: entry.id, entry };
    }
    if (candidates.length > 1) {
      return { kind: 'ambiguous', candidates };
    }

    // Not in the catalog: allow explicit provider/model even when undiscovered,
    // so manually configured or brand-new models remain usable.
    if (slash > 0) {
      const maybeProvider = reference.slice(0, slash);
      if (this.getProviderConfig(maybeProvider)) {
        return { kind: 'resolved', providerId: maybeProvider, modelId: reference.slice(slash + 1) };
      }
    }

    return { kind: 'not-found' };
  }

  selectModel(providerId: string, modelId: string): void {
    this.session.providerId = providerId;
    this.session.modelId = modelId;
    this.sessionManager.save(this.session);
  }

  activeModel(): { providerId: string; modelId: string } | null {
    if (this.session.providerId && this.session.modelId) {
      return { providerId: this.session.providerId, modelId: this.session.modelId };
    }
    return null;
  }

  async refreshModels(providerId: string, force = false): Promise<ListModelsResult> {
    const provider = this.getProviderConfig(providerId);
    if (!provider) throw new Error(`Provider not configured: ${providerId}`);

    let adapter: ProviderAdapter;
    try {
      adapter = await this.getAdapter(providerId);
    } catch (err) {
      // Without credentials we cannot refresh; surface honestly
      const cached = this.catalog.getCached(providerId, provider.models);
      if (cached) {
        return { ...cached, refreshError: (err as Error).message };
      }
      return {
        models: [],
        fromCache: false,
        stale: false,
        refreshError: (err as Error).message,
      };
    }

    return this.catalog.listModels(providerId, adapter, {
      forceRefresh: force,
      manualModels: provider.models,
    });
  }

  // --------------------------------------------------------------------------
  // Usage and cost
  // --------------------------------------------------------------------------

  /**
   * Estimate cost from the catalog pricing snapshot.
   * Returns fields only when pricing is available — never invents prices.
   */
  estimateCost(
    providerId: string,
    modelId: string,
    usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  ): { estimatedCost?: number; currency: string } {
    const entry = this.catalog.findModel(modelId, [providerId]);
    const pricing = entry?.pricing;
    if (!pricing || pricing.inputPerMillion === undefined) {
      return { currency: 'USD' };
    }

    const inputTokens = usage.inputTokens ?? 0;
    const cachedTokens = usage.cachedInputTokens ?? 0;
    const billableInput = Math.max(0, inputTokens - cachedTokens);
    const outputTokens = usage.outputTokens ?? 0;

    let cost = (billableInput / 1_000_000) * pricing.inputPerMillion;
    if (pricing.cachedInputPerMillion !== undefined && cachedTokens > 0) {
      cost += (cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
    }
    if (pricing.outputPerMillion !== undefined) {
      cost += (outputTokens / 1_000_000) * pricing.outputPerMillion;
    }

    return { estimatedCost: cost, currency: pricing.currency };
  }

  recordUsage(providerId: string, modelId: string, usage: StoredUsage): void {
    const { estimatedCost, currency } = this.estimateCost(providerId, modelId, usage);
    const delta: StoredUsage = { ...usage, currency };
    if (estimatedCost !== undefined) delta.estimatedCost = estimatedCost;

    this.session.usage = addUsage(this.session.usage, delta);
    this.sessionManager.save(this.session);
  }

  /**
   * Track preflight input estimates for requests that actually passed the
   * budget gate (§29). Never presented as provider-reported usage.
   */
  recordEstimatedInput(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.session.usage.estimatedInputTokens =
      (this.session.usage.estimatedInputTokens ?? 0) + Math.round(tokens);
    this.sessionManager.save(this.session);
  }

  saveSession(): void {
    this.sessionManager.save(this.session);
  }

  /** Best-effort release of long-lived resources (MCP connections, children). */
  async shutdown(): Promise<void> {
    await this.mcp.closeAll();
  }

  switchSession(session: SessionData): void {
    this.session = session;
    this.permissions.setMode(session.mode);
  }

  /** Change the agent mode in one place so the session and policy stay in sync. */
  setMode(mode: AgentMode): void {
    this.session.mode = mode;
    this.permissions.setMode(mode);
    this.sessionManager.save(this.session);
  }

  // --------------------------------------------------------------------------
  // Concurrency guard
  // --------------------------------------------------------------------------

  /** Marks a request as in flight so a crash leaves an honest interrupted flag */
  markRequestStarted(): void {
    this.session.interrupted = true;
    this.sessionManager.save(this.session);
  }

  markRequestFinished(): void {
    if (this.session.interrupted) {
      this.session.interrupted = false;
      this.sessionManager.save(this.session);
    }
  }
}

/**
 * Build the default AppState from on-disk configuration.
 */
export function createDefaultAppState(
  options: { projectPath?: string; interactive?: boolean; autoApprove?: boolean } = {},
): AppState {
  const configManager = getConfigManager();
  const { config } = configManager.load();

  return new AppState({
    config,
    configManager,
    credentialStore: createDefaultCredentialStore(),
    projectPath: options.projectPath,
    interactive: options.interactive ?? false,
    autoApprove: options.autoApprove ?? false,
  });
}
