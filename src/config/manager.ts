/**
 * Configuration manager - handles loading, saving, and migrating config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import {
  validateConfig,
  validatePartialConfig,
  mergeConfigSources,
  mergeWithDefaults,
  defaultConfig,
  type AppConfigInput,
} from './schema.js';

const CONFIG_DIR = '.config/mediaxg';
const CONFIG_FILE = 'config.json';
const PROJECT_CONFIG_DIR = '.mediaxg';
const PROJECT_CONFIG_FILE = 'config.json';

export interface ConfigLoadResult {
  config: AppConfigInput;
  path: string;
  isDefault: boolean;
  warnings: string[];
}

export interface ConfigManagerOptions {
  /** Override for the user config file (defaults to ~/.config/mediaxg/config.json) */
  userConfigPath?: string;
  /** Override for the project config file (defaults to ./.mediaxg/config.json) */
  projectConfigPath?: string;
}

export class ConfigManager {
  private userConfigPath: string;
  private projectConfigPath: string;
  private cachedConfig: AppConfigInput | null = null;

  constructor(options: ConfigManagerOptions = {}) {
    this.userConfigPath = options.userConfigPath ?? resolve(homedir(), CONFIG_DIR, CONFIG_FILE);
    this.projectConfigPath =
      options.projectConfigPath ?? resolve(process.cwd(), PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
  }

  /**
   * Load configuration from user and project locations.
   *
   * Files may be complete or partial: they are validated loosely, merged
   * (project over user), filled from defaults, and the final result is
   * validated against the full schema before it is handed out. A malformed
   * file only loses its own values — it never takes down the defaults.
   */
  load(): ConfigLoadResult {
    const warnings: string[] = [];
    let isDefault = true;

    const readConfigFile = (path: string, label: string): Partial<AppConfigInput> => {
      if (!existsSync(path)) return {};
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        const validation = validatePartialConfig(parsed);
        if (validation.success) {
          isDefault = false;
          return validation.data;
        }
        warnings.push(`${label} config validation failed: ${validation.errors.join(', ')}`);
      } catch (err) {
        warnings.push(`Failed to read ${label.toLowerCase()} config: ${(err as Error).message}`);
      }
      return {};
    };

    const userConfig = readConfigFile(this.userConfigPath, 'User');
    const projectConfig = readConfigFile(this.projectConfigPath, 'Project');

    // Merge configs (project overrides user), then fill everything unset
    const merged = mergeWithDefaults(mergeConfigSources(userConfig, projectConfig));

    // The merged result must always be a complete, valid configuration
    const validation = validateConfig(merged);
    if (!validation.success) {
      warnings.push(
        `Merged configuration invalid, using defaults: ${validation.errors.join(', ')}`,
      );
      const fallback = mergeWithDefaults({});
      this.cachedConfig = fallback;
      return {
        config: fallback,
        path: existsSync(this.userConfigPath) ? this.userConfigPath : this.projectConfigPath,
        isDefault: true,
        warnings,
      };
    }

    this.cachedConfig = validation.data;

    return {
      config: validation.data,
      path: existsSync(this.userConfigPath) ? this.userConfigPath : this.projectConfigPath,
      isDefault,
      warnings,
    };
  }

  /**
   * Get cached config or load if not cached
   */
  getConfig(): AppConfigInput {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }
    return this.load().config;
  }

  /**
   * Save configuration to user config path
   */
  save(config: AppConfigInput): void {
    const validation = validateConfig(config);
    if (!validation.success) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }

    const dir = dirname(this.userConfigPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.userConfigPath, JSON.stringify(config, null, 2), 'utf-8');
    this.cachedConfig = config;
  }

  /**
   * Update a specific section of the config
   */
  update<K extends keyof AppConfigInput>(key: K, value: AppConfigInput[K]): void {
    const current = this.getConfig();
    const updated = { ...current, [key]: value };
    this.save(updated);
  }

  /**
   * Get the user config directory path
   */
  getUserConfigDir(): string {
    return resolve(homedir(), CONFIG_DIR);
  }

  /**
   * Get the project config directory path
   */
  getProjectConfigDir(): string {
    return resolve(process.cwd(), PROJECT_CONFIG_DIR);
  }

  /**
   * Get the sessions directory path
   */
  getSessionsDir(): string {
    const config = this.getConfig();
    return resolve(config.sessionStorage.path.replace(/^~/, homedir()));
  }

  /**
   * Get the logs directory path
   */
  getLogsDir(): string {
    return resolve(this.getUserConfigDir(), 'logs');
  }

  /**
   * Ensure all required directories exist
   */
  ensureDirectories(): void {
    const dirs = [this.getUserConfigDir(), this.getSessionsDir(), this.getLogsDir()];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Reset config to defaults
   */
  reset(): void {
    this.cachedConfig = { ...defaultConfig };
    this.save(this.cachedConfig);
  }

  /**
   * Migrate config from older version
   */
  migrate(fromVersion: number, toVersion: number, config: unknown): AppConfigInput {
    // Currently only version 1 exists
    if (fromVersion === toVersion) {
      return config as AppConfigInput;
    }

    // Future migrations go here
    const validation = validateConfig(config);
    if (validation.success) {
      return validation.data;
    }

    // If validation fails, return defaults
    return { ...defaultConfig };
  }
}

// Singleton instance
let configManager: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
  if (!configManager) {
    configManager = new ConfigManager();
  }
  return configManager;
}
