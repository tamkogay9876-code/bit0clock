/**
 * Model catalog with dynamic discovery, caching and expiry.
 *
 * Rules:
 *  - Context windows and limits are used only when provider-reported,
 *    manually configured, or documented. Never inferred from model names
 *    (a model named `*-5m-long` does NOT get a 5M window).
 *  - Manual models remain marked 'manual' until verified.
 *  - Discovery failures never turn into "provider has no models": cached
 *    data is surfaced with its timestamp and a clearly visible staleness flag.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import type { DiscoveredModel, ProviderAdapter } from '../providers/types.js';
import type { ModelPricing, ManualModelConfig } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

export type CapabilitySource = 'provider-api' | 'manual' | 'cached' | 'documented' | 'inferred';

export interface CatalogEntry {
  providerId: string;
  id: string;
  displayName: string;
  capabilitySource: CapabilitySource;
  /** Whether a live call has succeeded for this model */
  verified: boolean;
  /** As reported by the provider; undefined means unknown, not unlimited */
  contextLength?: number;
  maxOutputTokens?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  reasoningLevels?: string[];
  reasoningDefault?: string;
  accessTier?: string;
  pricing?: ModelPricing;
  discoveredAt?: string;
  raw?: Record<string, unknown>;
}

interface ProviderCacheEntry {
  fetchedAt: string;
  models: DiscoveredModel[];
}

interface CacheFileShape {
  version: 1;
  providers: Record<string, ProviderCacheEntry>;
}

export interface ListModelsResult {
  models: CatalogEntry[];
  /** True when served from cache because a refresh was not requested/allowed */
  fromCache: boolean;
  /** True when the shown data exceeded the cache TTL */
  stale: boolean;
  fetchedAt?: string;
  /** Set when a refresh attempt failed; cached data may still be present */
  refreshError?: string;
}

export interface ModelCatalogOptions {
  cachePath?: string;
  cacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours: catalogs change rarely

// ============================================================================
// Catalog
// ============================================================================

export class ModelCatalog {
  private cachePath: string;
  private cacheTtlMs: number;
  private now: () => number;
  private cache: CacheFileShape;

  constructor(options: ModelCatalogOptions = {}) {
    this.cachePath = options.cachePath ?? resolve(homedir(), '.config/mediaxg/models-cache.json');
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.cache = this.loadCacheFile();
  }

  // --------------------------------------------------------------------------
  // Cache persistence
  // --------------------------------------------------------------------------

  private loadCacheFile(): CacheFileShape {
    if (!existsSync(this.cachePath)) return { version: 1, providers: {} };
    try {
      const raw = readFileSync(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheFileShape;
      if (parsed && parsed.version === 1 && parsed.providers) return parsed;
    } catch {
      // corrupted cache: start fresh, do not destroy the file until next save
    }
    return { version: 1, providers: {} };
  }

  private saveCacheFile(): void {
    const dir = dirname(this.cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  /**
   * List models for a provider, refreshing from the API when needed.
   */
  async listModels(
    providerId: string,
    adapter: ProviderAdapter,
    options: {
      forceRefresh?: boolean;
      allowStale?: boolean;
      manualModels?: ManualModelConfig[];
    } = {},
  ): Promise<ListModelsResult> {
    const cached = this.cache.providers[providerId];
    const nowMs = this.now();
    const cacheAgeMs = cached ? nowMs - Date.parse(cached.fetchedAt) : Infinity;
    const isFresh = cached && cacheAgeMs < this.cacheTtlMs;

    // Serve fresh cache without a network call
    if (isFresh && !options.forceRefresh) {
      return {
        models: this.toCatalogEntries(
          providerId,
          cached!.models,
          'cached',
          cached!.fetchedAt,
          options.manualModels,
        ),
        fromCache: true,
        stale: false,
        fetchedAt: cached!.fetchedAt,
      };
    }

    // Refresh from the provider
    try {
      const models = await adapter.listModels();
      const fetchedAt = new Date(nowMs).toISOString();
      this.cache.providers[providerId] = { fetchedAt, models };
      this.saveCacheFile();
      return {
        models: this.toCatalogEntries(
          providerId,
          models,
          'provider-api',
          fetchedAt,
          options.manualModels,
        ),
        fromCache: false,
        stale: false,
        fetchedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Discovery failed: surface cached data clearly marked stale.
      // Never claim the provider has no models.
      if (cached) {
        return {
          models: this.toCatalogEntries(
            providerId,
            cached.models,
            'cached',
            cached.fetchedAt,
            options.manualModels,
          ),
          fromCache: true,
          stale: true,
          fetchedAt: cached.fetchedAt,
          refreshError: message,
        };
      }

      // No cache at all: return manual models only, and report the failure
      return {
        models: this.manualEntries(providerId, options.manualModels ?? []),
        fromCache: false,
        stale: false,
        refreshError: message,
      };
    }
  }

  /** Cached models without any network access. */
  getCached(providerId: string, manualModels?: ManualModelConfig[]): ListModelsResult | null {
    const cached = this.cache.providers[providerId];
    if (!cached) return null;
    const ageMs = this.now() - Date.parse(cached.fetchedAt);
    return {
      models: this.toCatalogEntries(
        providerId,
        cached.models,
        'cached',
        cached.fetchedAt,
        manualModels,
      ),
      fromCache: true,
      stale: ageMs >= this.cacheTtlMs,
      fetchedAt: cached.fetchedAt,
    };
  }

  /** Find a model across providers. Exact match wins; suffix match second. */
  findModel(
    modelId: string,
    providerIds?: string[],
    manualModelsByProvider?: Record<string, ManualModelConfig[]>,
  ): CatalogEntry | undefined {
    const ids = providerIds ?? Object.keys(this.cache.providers);

    const all: CatalogEntry[] = [];
    for (const pid of ids) {
      const cached = this.cache.providers[pid];
      if (cached) {
        all.push(
          ...this.toCatalogEntries(
            pid,
            cached.models,
            'cached',
            cached.fetchedAt,
            manualModelsByProvider?.[pid],
          ),
        );
      } else if (manualModelsByProvider?.[pid]) {
        all.push(...this.manualEntries(pid, manualModelsByProvider[pid]!));
      }
    }

    // Exact match
    const exact = all.find((m) => m.id === modelId);
    if (exact) return exact;

    // Suffix match: 'gpt-5.6-sol' → 'openai/gpt-5.6-sol'
    const suffixMatches = all.filter((m) => m.id.endsWith(`/${modelId}`));
    if (suffixMatches.length === 1) return suffixMatches[0];
    if (suffixMatches.length > 1) {
      // Ambiguous: caller should open a picker
      return undefined;
    }

    return undefined;
  }

  /** All models matching a suffix across providers (for disambiguation). */
  findModelsBySuffix(modelSuffix: string, providerIds?: string[]): CatalogEntry[] {
    const ids = providerIds ?? Object.keys(this.cache.providers);
    const all: CatalogEntry[] = [];
    for (const pid of ids) {
      const cached = this.cache.providers[pid];
      if (cached)
        all.push(...this.toCatalogEntries(pid, cached.models, 'cached', cached.fetchedAt));
    }
    return all.filter((m) => m.id === modelSuffix || m.id.endsWith(`/${modelSuffix}`));
  }

  clearProviderCache(providerId: string): void {
    delete this.cache.providers[providerId];
    this.saveCacheFile();
  }

  /**
   * Seed discovery data without a network call.
   * Used by tests and by tooling that imports catalog snapshots.
   */
  setCachedModels(providerId: string, models: DiscoveredModel[], fetchedAt?: string): void {
    this.cache.providers[providerId] = {
      fetchedAt: fetchedAt ?? new Date(this.now()).toISOString(),
      models,
    };
    this.saveCacheFile();
  }

  clearAll(): void {
    this.cache = { version: 1, providers: {} };
    this.saveCacheFile();
  }

  // --------------------------------------------------------------------------
  // Conversion
  // --------------------------------------------------------------------------

  private toCatalogEntries(
    providerId: string,
    models: DiscoveredModel[],
    source: CapabilitySource,
    fetchedAt: string,
    manualModels?: ManualModelConfig[],
  ): CatalogEntry[] {
    const entries: CatalogEntry[] = models.map((m) => {
      const entry: CatalogEntry = {
        providerId,
        id: m.id,
        displayName: m.displayName ?? m.id,
        capabilitySource: source,
        verified: false,
        discoveredAt: fetchedAt,
      };

      // Only provider-reported values are used — never inferred from names
      if (typeof m.contextLength === 'number') entry.contextLength = m.contextLength;
      if (typeof m.maxOutputTokens === 'number') entry.maxOutputTokens = m.maxOutputTokens;
      if (typeof m.tools === 'boolean') entry.tools = m.tools;
      if (typeof m.vision === 'boolean') entry.vision = m.vision;
      if (typeof m.reasoning === 'boolean') entry.reasoning = m.reasoning;
      if (m.reasoningLevels) entry.reasoningLevels = m.reasoningLevels;
      if (m.reasoningDefault) entry.reasoningDefault = m.reasoningDefault;
      if (m.accessTier) entry.accessTier = m.accessTier;
      if (m.raw) entry.raw = m.raw;

      if (m.pricing) {
        entry.pricing = {
          inputPerMillion: m.pricing.input,
          outputPerMillion: m.pricing.output,
          cachedInputPerMillion: m.pricing.cacheRead,
          currency: m.pricing.currency,
          source: `${providerId} catalog`,
          updatedAt: fetchedAt,
          confidence: 'high',
        };
      }

      return entry;
    });

    // Manual models are merged; they stay marked 'manual' until verified
    const manual = this.manualEntries(providerId, manualModels ?? []);
    for (const m of manual) {
      if (!entries.some((e) => e.id === m.id)) {
        entries.push(m);
      } else {
        // Provider data wins for capabilities, but the manual flag remains visible
        const existing = entries.find((e) => e.id === m.id)!;
        existing.capabilitySource = 'provider-api';
      }
    }

    return entries;
  }

  private manualEntries(providerId: string, manualModels: ManualModelConfig[]): CatalogEntry[] {
    return manualModels.map((m) => {
      const entry: CatalogEntry = {
        providerId,
        id: m.id,
        displayName: m.displayName,
        capabilitySource: 'manual',
        verified: false,
      };
      if (m.contextWindow !== undefined) entry.contextLength = m.contextWindow;
      if (m.maxOutputTokens !== undefined) entry.maxOutputTokens = m.maxOutputTokens;
      entry.tools = m.supportsToolCalls;
      entry.reasoning = m.supportsReasoning;
      return entry;
    });
  }
}
