/**
 * Deterministic test helpers for application-level tests.
 * Not part of the runtime surface (imported only from tests).
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppState } from './state.js';
import { SessionManager } from '../session/manager.js';
import { ModelCatalog } from '../models/catalog.js';
import { CalibrationStore } from '../context/tokens.js';
import { defaultConfig, type AppConfigInput } from '../config/schema.js';
import { SkillManager } from '../skills/manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { CredentialStore } from '../credentials/index.js';
import type { AppConfig, ProviderConfig } from '../types/index.js';
import type { DiscoveredModel, FetchLike } from '../providers/types.js';
import type { PermissionEngine } from '../permissions/engine.js';
import type { RepoIndex } from '../context/retrieval.js';
import { MCPManager } from '../mcp/manager.js';
import { MemoryManager } from '../memory/store.js';
import type { McpClientFactory } from '../mcp/types.js';

/** In-memory credential store for tests (never touches disk/env). */
export class MemoryCredentialStore implements CredentialStore {
  readonly name = 'memory';
  private values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }

  async list(): Promise<string[]> {
    return [...this.values.keys()];
  }

  /** Test helper: read a value synchronously */
  peek(ref: string): string | undefined {
    return this.values.get(ref);
  }
}

export interface TestApp {
  app: AppState;
  dir: string;
  catalog: ModelCatalog;
  sessionManager: SessionManager;
  credentials: MemoryCredentialStore;
}

export interface CreateTestAppOptions {
  providers?: ProviderConfig[];
  configOverrides?: Partial<AppConfigInput>;
  fetchImpl?: FetchLike;
  projectPath?: string;
  /** Seed catalog models per provider (avoids network) */
  catalog?: Record<string, DiscoveredModel[]>;
  /** Permission behavior (default: interactive=false, autoApprove=false) */
  interactive?: boolean;
  autoApprove?: boolean;
  /** Injected permission engine overrides interactive/autoApprove */
  permissionEngine?: PermissionEngine;
  /** Injected repository index (retrieval tests) */
  repoIndex?: RepoIndex;
  /** Injected config manager (tests that persist config, e.g. /mcp add) */
  configManager?: ConfigManager;
  /** Injected skill manager; by default a hermetic one rooted in the tmp dir */
  skillManager?: SkillManager;
  /** Injected MCP manager */
  mcpManager?: MCPManager;
  /** Injected project memory manager */
  memoryManager?: MemoryManager;
  /** Injected MCP client factory (tests that exercise MCP without spawning) */
  mcpClientFactory?: McpClientFactory;
  /** Fake home directory for default skill discovery (defaults to <tmp>/home) */
  homeDir?: string;
}

export function createTestApp(options: CreateTestAppOptions = {}): TestApp {
  const dir = mkdtempSync(join(tmpdir(), 'mediaxg-test-'));
  const projectPath = options.projectPath ?? dir;

  const base = structuredClone(defaultConfig);
  const config: AppConfigInput = {
    ...base,
    ...options.configOverrides,
    providers: options.providers ?? base.providers,
  };

  const sessionManager = new SessionManager({
    directory: join(dir, 'sessions'),
    projectPath,
  });
  const catalog = new ModelCatalog({ cachePath: join(dir, 'models-cache.json') });

  if (options.catalog) {
    for (const [providerId, models] of Object.entries(options.catalog)) {
      catalog.setCachedModels(providerId, models);
    }
  }

  const credentials = new MemoryCredentialStore();

  // Tests never touch the real user config dir: calibration stays in the tmp dir
  const calibrationStore = new CalibrationStore({
    path: join(dir, 'token-calibration.json'),
    persist: false,
  });

  // Skill discovery is always rooted in the tmp dir so tests are hermetic and
  // never read the developer's real ~/.config/mediaxg/skills or ~/.agents/skills.
  const skillManager =
    options.skillManager ??
    new SkillManager({
      workspaceRoot: projectPath,
      homeDir: options.homeDir ?? join(dir, 'home'),
      extraPaths: config.skillsPaths,
      trustedPaths: config.skillsSettings.trustedPaths,
      enabled: config.skillsSettings.enabled,
      maxFiles: config.skillsSettings.maxFiles,
    });

  // MCP tool exposure is built here when tests inject a fake client factory
  // (the real SDK path spawns/connects only when a test enables a server).
  const mcpManager =
    options.mcpManager ??
    new MCPManager({
      config: config as AppConfig,
      credentialStore: credentials,
      workspaceRoot: projectPath,
      ...(options.mcpClientFactory ? { clientFactory: options.mcpClientFactory } : {}),
    });

  const app = new AppState({
    config: config as AppConfig,
    credentialStore: credentials,
    catalog,
    sessionManager,
    projectPath,
    calibrationStore,
    skillManager,
    mcpManager,
    ...(options.memoryManager ? { memoryManager: options.memoryManager } : {}),
    ...(options.configManager ? { configManager: options.configManager } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.permissionEngine ? { permissionEngine: options.permissionEngine } : {}),
    ...(options.repoIndex ? { repoIndex: options.repoIndex } : {}),
    interactive: options.interactive ?? false,
    autoApprove: options.autoApprove ?? false,
  });

  return { app, dir, catalog, sessionManager, credentials };
}

/** A minimal OpenAI-compatible provider config for tests. */
export function testProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test',
    type: 'openai-compatible',
    baseUrl: 'https://test.example.com/v1',
    credentialRef: 'TEST_API_KEY',
    enabled: true,
    ...overrides,
  };
}

/** Seed a couple of well-known models into a catalog. */
export function seedModels(count = 3): DiscoveredModel[] {
  const models: DiscoveredModel[] = [
    {
      id: 'vendor/alpha-model',
      displayName: 'Alpha Model',
      contextLength: 128000,
      maxOutputTokens: 16000,
      tools: true,
      vision: false,
      reasoning: true,
      reasoningLevels: ['low', 'medium', 'high'],
      pricing: { input: 1.5, output: 6, cacheRead: 0.15, currency: 'USD' },
    },
    {
      id: 'vendor/beta-fast',
      displayName: 'Beta Fast',
      contextLength: 32000,
      tools: true,
      reasoning: false,
    },
  ];
  return models.slice(0, count);
}
