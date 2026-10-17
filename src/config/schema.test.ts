/**
 * Tests for configuration schema
 */

import { describe, it, expect } from 'bun:test';
import {
  validateConfig,
  validatePartialConfig,
  mergeWithDefaults,
  mergeConfigSources,
  defaultConfig,
  appConfigSchema,
} from './schema.js';

describe('Config Schema', () => {
  it('should validate default config', () => {
    const result = validateConfig(defaultConfig);
    expect(result.success).toBe(true);
  });

  it('should reject invalid config', () => {
    const result = validateConfig({ version: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should merge with defaults', () => {
    const partial = { version: 1, providers: [] };
    const merged = mergeWithDefaults(partial);
    expect(merged.version).toBe(1);
    expect(merged.providers).toEqual([]);
    expect(merged.contextProfiles.length).toBeGreaterThan(0);
    expect(merged.agentLoopLimits.maxIterations).toBe(50);
  });

  it('should validate provider config', () => {
    const config = {
      ...defaultConfig,
      providers: [
        {
          id: 'test-provider',
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com',
          enabled: true,
        },
      ],
    };
    const result = validateConfig(config);
    expect(result.success).toBe(true);
  });

  it('should reject invalid provider type', () => {
    const config = {
      ...defaultConfig,
      providers: [
        {
          id: 'test',
          type: 'invalid-type',
          baseUrl: 'https://api.example.com',
          enabled: true,
        },
      ],
    };
    const result = validateConfig(config);
    expect(result.success).toBe(false);
  });

  it('should validate context profiles', () => {
    const config = {
      ...defaultConfig,
      contextProfiles: [
        {
          id: 'custom',
          name: 'Custom',
          description: 'Custom profile',
          maxTokens: 100000,
          reservedOutputTokens: 4000,
          safetyMargin: 2000,
          isDefault: false,
        },
      ],
    };
    const result = validateConfig(config);
    expect(result.success).toBe(true);
  });

  it('should validate MCP server config', () => {
    const config = {
      ...defaultConfig,
      mcpServers: [
        {
          name: 'test-server',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          timeoutMs: 30000,
          outputLimitBytes: 100000,
        },
      ],
    };
    const result = validateConfig(config);
    expect(result.success).toBe(true);
  });

  it('should validate spending limits', () => {
    const config = {
      ...defaultConfig,
      spendingLimits: {
        maxPerRequest: 1.0,
        maxDaily: 10.0,
        maxMonthly: 100.0,
        unknownBalancePolicy: 'confirm',
        currency: 'USD',
      },
    };
    const result = validateConfig(config);
    expect(result.success).toBe(true);
  });

  it('should default skills settings and accept a partial section (Phase F)', () => {
    expect(defaultConfig.skillsSettings).toEqual({
      enabled: true,
      trustedPaths: [],
      maxFiles: 500,
    });

    // A hand-written partial section passes deep-partial validation…
    const partial = validatePartialConfig({ skillsSettings: { enabled: false } });
    expect(partial.success).toBe(true);

    // …and mergeWithDefaults fills the rest without dropping what was set
    const merged = mergeWithDefaults({ skillsSettings: { enabled: false } });
    expect(merged.skillsSettings).toEqual({
      enabled: false,
      trustedPaths: [],
      maxFiles: 500,
    });

    const invalid = validateConfig({
      ...defaultConfig,
      skillsSettings: { enabled: 'yes', trustedPaths: [], maxFiles: 10 },
    });
    expect(invalid.success).toBe(false);
  });

  it('should deep-merge skills settings across user and project sources (Phase F)', () => {
    const merged = mergeConfigSources(
      { skillsSettings: { trustedPaths: ['/home/u/skills'], maxFiles: 100 } },
      { skillsSettings: { enabled: false } },
    );
    expect(merged.skillsSettings).toEqual({
      trustedPaths: ['/home/u/skills'],
      maxFiles: 100,
      enabled: false,
    });

    const full = mergeWithDefaults(merged);
    expect(full.skillsSettings.enabled).toBe(false);
    expect(full.skillsSettings.trustedPaths).toEqual(['/home/u/skills']);
    expect(validateConfig(full).success).toBe(true);
  });

  it('should migrate a minimal v1 config through mergeWithDefaults (Phase G)', () => {
    const minimal = { version: 1, providers: [] };
    const partial = validatePartialConfig(minimal);
    expect(partial.success).toBe(true);
    const merged = mergeWithDefaults(partial.success ? partial.data : {});
    const validated = validateConfig(merged);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.version).toBe(1);
      expect(validated.data.contextProfiles.length).toBeGreaterThan(0);
      expect(validated.data.skillsSettings.enabled).toBe(true);
      expect(validated.data.mcpServers).toEqual([]);
    }
  });

  it('should validate MCP disabled tools and reject unsafe server names (Phase F)', () => {
    const withDisabled = {
      ...defaultConfig,
      mcpServers: [
        {
          name: 'docs.server-1',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          timeoutMs: 30000,
          outputLimitBytes: 100000,
          disabledTools: ['dangerous-write'],
        },
      ],
    };
    const ok = validateConfig(withDisabled);
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.mcpServers[0]!.disabledTools).toEqual(['dangerous-write']);
    }

    for (const name of ['-leading-dash', 'has space', 'has/slash', '']) {
      const result = validateConfig({
        ...defaultConfig,
        mcpServers: [
          {
            name,
            transport: 'http',
            url: 'https://mcp.example.com',
            enabled: true,
            timeoutMs: 30000,
            outputLimitBytes: 100000,
          },
        ],
      });
      expect(result.success).toBe(false);
    }
  });
});
