/**
 * ConfigManager tests: partial hand-written configs, malformed files, and
 * section merging. All paths point into a temp dir — the real user config is
 * never read or written.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigManager } from './manager.js';
import { defaultConfig } from './schema.js';

interface TempConfig {
  userConfigPath: string;
  projectConfigPath: string;
  writeUserConfig: (value: unknown) => void;
  writeProjectConfig: (value: unknown) => void;
}

function withTempConfig<T>(fn: (ctx: TempConfig) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'mediaxg-config-'));
  const userConfigPath = join(root, 'user/config.json');
  const projectConfigPath = join(root, 'project/.mediaxg/config.json');
  mkdirSync(join(root, 'user'), { recursive: true });
  mkdirSync(join(root, 'project/.mediaxg'), { recursive: true });

  const ctx: TempConfig = {
    userConfigPath,
    projectConfigPath,
    writeUserConfig: (value: unknown) => {
      writeFileSync(userConfigPath, JSON.stringify(value), 'utf-8');
    },
    writeProjectConfig: (value: unknown) => {
      writeFileSync(projectConfigPath, JSON.stringify(value), 'utf-8');
    },
  };

  try {
    return fn(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function load(ctx: TempConfig) {
  return new ConfigManager({
    userConfigPath: ctx.userConfigPath,
    projectConfigPath: ctx.projectConfigPath,
  }).load();
}

describe('ConfigManager partial configuration', () => {
  it('loads a hand-written partial config and fills the rest from defaults', () => {
    withTempConfig((ctx) => {
      ctx.writeUserConfig({
        spendingLimits: { maxDaily: 5 },
        providers: [
          {
            id: 'local',
            type: 'openai-compatible',
            baseUrl: 'http://localhost:1/v1',
            enabled: true,
          },
        ],
      });

      const result = load(ctx);
      expect(result.warnings).toEqual([]);
      expect(result.isDefault).toBe(false);
      expect(result.config.providers).toHaveLength(1);
      expect(result.config.providers[0]!.id).toBe('local');
      // Partially provided section: the missing keys come from defaults
      expect(result.config.spendingLimits.maxDaily).toBe(5);
      expect(result.config.spendingLimits.currency).toBe(defaultConfig.spendingLimits.currency);
      expect(result.config.spendingLimits.unknownBalancePolicy).toBe('confirm');
      // Untouched sections are complete defaults
      expect(result.config.defaultContextProfile).toBe(defaultConfig.defaultContextProfile);
      expect(result.config.contextEngine.retrieval.enabled).toBe(false);
    });
  });

  it('rejects a file with an invalid section as a whole, with a warning', () => {
    withTempConfig((ctx) => {
      ctx.writeUserConfig({
        providers: [{ id: 'x', type: 'not-a-provider', baseUrl: 'http://x', enabled: true }],
        spendingLimits: { maxDaily: 7 },
      });

      const result = load(ctx);
      expect(result.warnings.join(' ')).toContain('User config');
      expect(result.config.providers).toEqual([]);
      // Every key in a rejected file is suspect, so none of them are applied
      expect(result.config.spendingLimits.maxDaily).toBeUndefined();
    });
  });

  it('falls back to defaults when the file is not JSON at all', () => {
    withTempConfig((ctx) => {
      writeFileSync(ctx.userConfigPath, '{ not json', 'utf-8');
      const result = load(ctx);
      expect(result.warnings.join(' ')).toContain('Failed to read user config');
      expect(result.config).toEqual(defaultConfig);
      expect(result.isDefault).toBe(true);
    });
  });

  it('project config overrides user config section by section', () => {
    withTempConfig((ctx) => {
      ctx.writeUserConfig({
        spendingLimits: { maxDaily: 5, currency: 'EUR' },
        logging: { level: 'debug' },
      });
      ctx.writeProjectConfig({
        spendingLimits: { maxDaily: 9 },
      });

      const result = load(ctx);
      expect(result.warnings).toEqual([]);
      expect(result.config.spendingLimits.maxDaily).toBe(9);
      // User values not overridden by the project file survive
      expect(result.config.spendingLimits.currency).toBe('EUR');
      expect(result.config.spendingLimits.unknownBalancePolicy).toBe('confirm');
      expect(result.config.logging.level).toBe('debug');
    });
  });

  it('a complete config file still round-trips unchanged', () => {
    withTempConfig((ctx) => {
      ctx.writeUserConfig(defaultConfig);
      const result = load(ctx);
      expect(result.warnings).toEqual([]);
      expect(result.config).toEqual(defaultConfig);
    });
  });

  it('no files → defaults with isDefault true', () => {
    withTempConfig((ctx) => {
      const result = load(ctx);
      expect(result.warnings).toEqual([]);
      expect(result.isDefault).toBe(true);
      expect(result.config).toEqual(defaultConfig);
    });
  });
});
