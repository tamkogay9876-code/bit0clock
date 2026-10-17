/**
 * Diagnostics and health checks
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type {
  AppConfig,
  DoctorReport,
  DiagnosticResult,
  DiagnosticStatus,
} from '../types/index.js';
import { getConfigManager } from '../config/manager.js';

function checkStatus(
  passed: boolean,
  message: string,
  details?: Record<string, unknown>,
): DiagnosticResult {
  return {
    name: 'unknown',
    status: passed ? 'healthy' : 'unavailable',
    message,
    details,
    timestamp: new Date().toISOString(),
  };
}

async function checkRuntime(): Promise<DiagnosticResult> {
  const bunVersion = process.version;
  const nodeVersion = process.versions.node || 'unknown';

  return {
    name: 'Runtime',
    status: 'healthy',
    message: `Bun ${bunVersion}, Node ${nodeVersion}`,
    details: { bunVersion, nodeVersion, platform: process.platform, arch: process.arch },
    timestamp: new Date().toISOString(),
  };
}

async function checkConfig(config: AppConfig): Promise<DiagnosticResult> {
  const configManager = getConfigManager();
  const result = configManager.load();

  const issues: string[] = [];
  if (result.isDefault) issues.push('Using default configuration');
  if (result.warnings.length > 0) issues.push(...result.warnings);

  return {
    name: 'Configuration',
    status: issues.length === 0 ? 'healthy' : 'degraded',
    message: issues.length === 0 ? 'Configuration valid' : `Issues: ${issues.join(', ')}`,
    details: {
      path: result.path,
      isDefault: result.isDefault,
      version: config.version,
      warnings: result.warnings,
    },
    timestamp: new Date().toISOString(),
  };
}

async function checkProviders(config: AppConfig): Promise<DiagnosticResult> {
  const enabledProviders = config.providers.filter((p) => p.enabled);

  if (enabledProviders.length === 0) {
    return {
      name: 'Providers',
      status: 'not-configured',
      message: 'No providers configured. Use /connect to set up a provider.',
      details: { providers: [] },
      timestamp: new Date().toISOString(),
    };
  }

  const providerStatuses = enabledProviders.map((p) => ({
    id: p.id,
    type: p.type,
    hasCredential: !!p.credentialRef,
    enabled: p.enabled,
  }));

  const missingCreds = enabledProviders.filter((p) => !p.credentialRef);

  return {
    name: 'Providers',
    status: missingCreds.length > 0 ? 'degraded' : 'healthy',
    message: `${enabledProviders.length} provider(s) configured${missingCreds.length > 0 ? `, ${missingCreds.length} missing credentials` : ''}`,
    details: { providers: providerStatuses },
    timestamp: new Date().toISOString(),
  };
}

async function checkStorage(config: AppConfig): Promise<DiagnosticResult> {
  const sessionsDir = resolve(config.sessionStorage.path.replace(/^~/, homedir()));
  const logsDir = resolve(homedir(), '.config/mediaxg/logs');

  const sessionsExists = existsSync(sessionsDir);
  const logsExists = existsSync(logsDir);

  return {
    name: 'Storage',
    status: sessionsExists && logsExists ? 'healthy' : 'degraded',
    message: `Sessions: ${sessionsExists ? 'OK' : 'Missing'}, Logs: ${logsExists ? 'OK' : 'Missing'}`,
    details: { sessionsDir, logsDir, sessionsExists, logsExists },
    timestamp: new Date().toISOString(),
  };
}

async function checkMCP(config: AppConfig): Promise<DiagnosticResult> {
  const mcpServers = config.mcpServers.filter((s) => s.enabled);

  if (mcpServers.length === 0) {
    return {
      name: 'MCP',
      status: 'not-configured',
      message: 'No MCP servers configured',
      details: { servers: [] },
      timestamp: new Date().toISOString(),
    };
  }

  return {
    name: 'MCP',
    status: 'healthy',
    message: `${mcpServers.length} MCP server(s) configured`,
    details: {
      servers: mcpServers.map((s) => ({
        name: s.name,
        transport: s.transport,
        enabled: s.enabled,
      })),
    },
    timestamp: new Date().toISOString(),
  };
}

async function checkSkills(config: AppConfig): Promise<DiagnosticResult> {
  const skillsPaths = config.skillsPaths;

  if (skillsPaths.length === 0) {
    return {
      name: 'Skills',
      status: 'not-configured',
      message: 'No skills paths configured',
      details: { paths: [] },
      timestamp: new Date().toISOString(),
    };
  }

  const existingPaths = skillsPaths.filter((p) => existsSync(resolve(p.replace(/^~/, homedir()))));

  return {
    name: 'Skills',
    status: existingPaths.length === skillsPaths.length ? 'healthy' : 'degraded',
    message: `${existingPaths.length}/${skillsPaths.length} skills paths exist`,
    details: { paths: skillsPaths, existingPaths },
    timestamp: new Date().toISOString(),
  };
}

function determineOverallStatus(checks: DiagnosticResult[]): DiagnosticStatus {
  const statuses = checks.map((c) => c.status);

  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.every((s) => s === 'healthy')) return 'healthy';
  if (statuses.every((s) => s === 'not-configured')) return 'not-configured';

  return 'degraded';
}

export async function runDoctor(config: AppConfig): Promise<DoctorReport> {
  const checks: DiagnosticResult[] = await Promise.all([
    checkRuntime(),
    checkConfig(config),
    checkProviders(config),
    checkStorage(config),
    checkMCP(config),
    checkSkills(config),
  ]);

  // Set names properly
  checks[0]!.name = 'Runtime';
  checks[1]!.name = 'Configuration';
  checks[2]!.name = 'Providers';
  checks[3]!.name = 'Storage';
  checks[4]!.name = 'MCP';
  checks[5]!.name = 'Skills';

  const overall = determineOverallStatus(checks);

  return {
    overall,
    checks,
    timestamp: new Date().toISOString(),
  };
}
