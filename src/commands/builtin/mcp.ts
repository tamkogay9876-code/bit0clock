/**
 * MCP management commands (§39).
 *
 * Configuration is stored with credential *references*, never secrets:
 * `/mcp auth <name> --key-env=<ENV_VAR>` writes to the credential store, the
 * config file only keeps `auth.credentialRef`. New servers are added disabled — nothing
 * connects or exposes tools until the user enables and tests them.
 */

import type { AppState } from '../../app/state.js';
import type { MCPServerConfig } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';
import { assertNoSecretsInUrl, validateStdioEnvConfig } from '../../mcp/client.js';
import { mcpToolName } from '../../mcp/manager.js';
import { defaultCredentialRef, storeMcpAuth } from './mcp-auth.js';
import { inspectMcpPermissions, showMcpLogs } from './mcp-inspection.js';

export { defaultCredentialRef } from './mcp-auth.js';

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_OUTPUT_BYTES = 50_000;

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function createMcpCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'mcp',
      category: 'general',
      description: 'Manage MCP servers: list, add, test, tools, permissions, logs',
      usage:
        '/mcp [list|add|show|test|enable|disable|remove|tools|resources|prompts|permissions|auth|logs] ...',
      subcommands: [
        { name: 'list', usage: '/mcp list', description: 'Configured servers with live status' },
        {
          name: 'add',
          usage:
            '/mcp add <name> <url> [--auth=bearer|api-key] [--credential=<ref>] [--header=<name>]',
          description: 'Add an HTTP server (disabled until enabled)',
        },
        {
          name: 'add (stdio)',
          usage:
            '/mcp add <name> --command=<path> [--args=\'["…"]\'] [--cwd=<dir>] [--env=\'{"K":"v"}\']',
          description: 'Add a stdio server',
        },
        {
          name: 'show',
          usage: '/mcp show <name>',
          description: 'Stored configuration (credential reference only, never the secret)',
        },
        {
          name: 'test',
          usage: '/mcp test <name>',
          description: 'Connect, run the initialize handshake, and list capabilities',
        },
        {
          name: 'enable',
          usage: '/mcp enable <name>',
          description: 'Enable a server (does not auto-approve its tools)',
        },
        {
          name: 'disable',
          usage: '/mcp disable <name>',
          description: 'Disable and disconnect a server',
        },
        {
          name: 'remove',
          usage: '/mcp remove <name> --yes',
          description: 'Remove the configuration (two-step confirm)',
        },
        {
          name: 'tools',
          usage: '/mcp tools [server]',
          description: 'Discovered tools with exposure state',
        },
        {
          name: 'resources',
          usage: '/mcp resources [server]',
          description: 'Advertised resources',
        },
        { name: 'prompts', usage: '/mcp prompts [server]', description: 'Advertised prompts' },
        {
          name: 'permissions',
          usage: '/mcp permissions <server> [tool on|off]',
          description: 'Policy state and per-tool exposure toggles',
        },
        {
          name: 'auth',
          usage: '/mcp auth <name> --key-env=<ENV_VAR>',
          description: 'Store/rotate a credential from an environment variable',
        },
        {
          name: 'logs',
          usage: '/mcp logs [--server=<name>]',
          description: 'Recent MCP activity and permission decisions',
        },
      ],
      examples: [
        '/mcp',
        '/mcp add context7 https://mcp.context7.com/mcp',
        '/mcp add xkiro-web https://api.xkiro.com/mcp/web --auth=bearer --credential=XKIRO_API_KEY',
        '/mcp add files --command=npx --args=\'["-y","@modelcontextprotocol/server-filesystem","."]\'',
        '/mcp test files',
        '/mcp tools files',
        '/mcp permissions files',
        '/mcp logs',
      ],
      handler: async ({ args, flags }): Promise<CommandResult> => {
        const sub = args[0];
        try {
          switch (sub) {
            case undefined:
            case 'list':
              return listServers(app);
            case 'add':
              return addServer(app, args[1], args[2], flags);
            case 'show':
              return showServer(app, args[1]);
            case 'test':
              return await testServer(app, args[1]);
            case 'enable':
              return enableServer(app, args[1], true);
            case 'disable':
              return await enableServerAsync(app, args[1], false);
            case 'remove':
              return await removeServer(app, args[1], flags['yes'] === true);
            case 'tools':
              return await listTools(app, args[1]);
            case 'resources':
              return await listResources(app, args[1]);
            case 'prompts':
              return await listPrompts(app, args[1]);
            case 'permissions':
              return await inspectMcpPermissions(
                app,
                args[1],
                args[2],
                args[3] as 'on' | 'off' | undefined,
                { saveConfig, statusLabel },
              );
            case 'auth':
              return await storeMcpAuth(app, args[1], args[2], flags);
            case 'logs':
              return showMcpLogs(
                app,
                typeof flags['server'] === 'string' ? flags['server'] : undefined,
              );
            default:
              return {
                ok: false,
                error:
                  `Unknown subcommand: /mcp ${sub}.\n` +
                  'Usage: /mcp [list|add|show|test|enable|disable|remove|tools|resources|prompts|permissions|auth|logs]',
              };
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}

// ============================================================================
// Helpers
// ============================================================================

function saveConfig(app: AppState): boolean {
  if (!app.configManager) return false;
  app.configManager.save(app.config);
  return true;
}

function statusLabel(config: MCPServerConfig, app: AppState): string {
  const state = app.mcp.state(config.name);
  if (!config.enabled) return 'disabled';
  if (!state) return 'idle';
  if (state.status === 'ready') {
    return `ready (${state.tools.length} tool(s))`;
  }
  if (state.status === 'connecting') return 'connecting';
  if (state.status === 'error') return `error: ${state.lastError ?? 'unknown'}`;
  return 'idle (not connected — /mcp test ' + config.name + ')';
}

function listServers(app: AppState): CommandResult {
  const servers = app.mcp.servers();
  const lines: string[] = ['MCP servers:', ''];

  if (servers.length === 0) {
    lines.push('  (none configured)');
    lines.push('');
    lines.push(
      'Examples (official endpoints; authentication is account-dependent — verify with your provider):',
    );
    lines.push('  /mcp add context7 https://mcp.context7.com/mcp');
    lines.push(
      '  /mcp add xkiro-web https://api.xkiro.com/mcp/web --auth=bearer --credential=XKIRO_API_KEY',
    );
    lines.push('');
    lines.push(
      'Servers are added disabled. Store credentials with /mcp auth, then /mcp enable and /mcp test.',
    );
    lines.push('Secrets never live in the config file: only credential references.');
    return { ok: true, output: lines.join('\n') };
  }

  for (const config of servers) {
    lines.push(
      `  ${config.name.padEnd(16)} ${config.transport.padEnd(6)} ${statusLabel(config, app)}`,
    );
    const target =
      config.transport === 'http'
        ? (config.url ?? '(no url)')
        : `${config.command ?? '(no command)'} ${(config.args ?? []).join(' ')}`.trim();
    lines.push(`      ${target}`);
    if (config.auth) {
      lines.push(
        `      auth: ${config.auth.type} via credential ref "${config.auth.credentialRef}" (never shown)`,
      );
    }
    const disabled = config.disabledTools ?? [];
    if (disabled.length > 0) lines.push(`      disabled tools: ${disabled.join(', ')}`);
  }
  lines.push('');
  lines.push(
    'Connect and discover capabilities with /mcp test <name>; inspect tools with /mcp tools.',
  );
  lines.push(
    'Tool calls always go through the permission engine (class "mcp"); plan/review modes do not offer MCP tools.',
  );
  return { ok: true, output: lines.join('\n') };
}

function parseJsonFlag<T>(flag: string | true | undefined, what: string): T | undefined | Error {
  if (flag === undefined) return undefined;
  if (flag === true) return new Error(`--${what} expects a JSON value`);
  try {
    return JSON.parse(flag) as T;
  } catch (err) {
    return new Error(
      `--${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function addServer(
  app: AppState,
  name: string | undefined,
  url: string | undefined,
  flags: Record<string, string | true>,
): CommandResult {
  if (!name) {
    return {
      ok: false,
      error:
        'Usage:\n' +
        '  /mcp add <name> <url> [--auth=bearer|api-key] [--credential=<ref>] [--header=<name>]\n' +
        '  /mcp add <name> --command=<path> [--args=\'["…"]\'] [--cwd=<dir>] [--env=\'{"K":"v"}\']',
    };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `Invalid server name "${name}": use letters, digits, dot, dash, underscore (must not start with punctuation).`,
    };
  }
  if (app.mcp.getConfig(name)) {
    return {
      ok: false,
      error: `MCP server already configured: ${name}. Use /mcp show ${name} or /mcp remove ${name} --yes.`,
    };
  }

  const command = typeof flags['command'] === 'string' ? flags['command'] : undefined;
  const isStdio = flags['stdio'] === true || command !== undefined;

  const config: MCPServerConfig = {
    name,
    transport: isStdio ? 'stdio' : 'http',
    enabled: false,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    outputLimitBytes: DEFAULT_MCP_OUTPUT_BYTES,
  };

  if (isStdio) {
    if (!command) {
      return {
        ok: false,
        error: 'stdio servers need --command=<executable path> (no shell is used).',
      };
    }
    config.command = command;

    const argsValue = parseJsonFlag<string[]>(flags['args'], 'args');
    if (argsValue instanceof Error) return { ok: false, error: argsValue.message };
    if (argsValue !== undefined) {
      if (!Array.isArray(argsValue) || argsValue.some((a) => typeof a !== 'string')) {
        return { ok: false, error: '--args must be a JSON array of strings.' };
      }
      config.args = argsValue;
    }

    const envValue = parseJsonFlag<Record<string, string>>(flags['env'], 'env');
    if (envValue instanceof Error) return { ok: false, error: envValue.message };
    if (envValue !== undefined) {
      if (typeof envValue !== 'object' || envValue === null || Array.isArray(envValue)) {
        return { ok: false, error: '--env must be a JSON object of string values.' };
      }
      for (const [key, value] of Object.entries(envValue)) {
        if (typeof value !== 'string')
          return { ok: false, error: `--env value for ${key} must be a string.` };
      }
      const envError = validateStdioEnvConfig(envValue);
      if (envError) return { ok: false, error: envError };
      config.env = envValue;
    }

    if (typeof flags['cwd'] === 'string') config.cwd = flags['cwd'];
  } else {
    if (!url) {
      return { ok: false, error: 'HTTP servers need a URL: /mcp add <name> <url>' };
    }
    try {
      assertNoSecretsInUrl(url);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    config.url = url;

    const authType = typeof flags['auth'] === 'string' ? flags['auth'] : undefined;
    if (authType !== undefined || flags['credential'] !== undefined) {
      const type = authType ?? 'bearer';
      if (type !== 'bearer' && type !== 'api-key') {
        return {
          ok: false,
          error: `Unsupported auth type "${type}" (use bearer or api-key; interactive OAuth is not implemented).`,
        };
      }
      const credentialRef =
        typeof flags['credential'] === 'string' && flags['credential'] !== ''
          ? flags['credential']
          : defaultCredentialRef(name);
      config.auth = { type, credentialRef };
      if (typeof flags['header'] === 'string') config.auth.headerName = flags['header'];
    }
  }

  app.config.mcpServers.push(config);
  const saved = saveConfig(app);

  const lines: string[] = [
    `MCP server added: ${name} (${config.transport}) — added DISABLED on purpose.`,
    `  ${config.transport === 'http' ? config.url : `${config.command} ${(config.args ?? []).join(' ')}`}`,
    `  timeout ${config.timeoutMs}ms · output cap ${config.outputLimitBytes} bytes`,
  ];
  if (config.auth) {
    lines.push(`  auth: ${config.auth.type} via credential ref "${config.auth.credentialRef}"`);
    lines.push(`Store a secret from an environment variable: /mcp auth ${name} --key-env=ENV_VAR`);
  }
  lines.push(`Enable and test: /mcp enable ${name} && /mcp test ${name}`);
  if (!saved) {
    lines.push('');
    lines.push(
      'Warning: no config manager is available in this run; the server exists only for this process.',
    );
  }
  return { ok: true, output: lines.join('\n') };
}

function showServer(app: AppState, name: string | undefined): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /mcp show <name>' };
  const config = app.mcp.getConfig(name);
  if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };
  const state = app.mcp.state(name);

  const lines: string[] = [`MCP server: ${config.name}`, ''];
  lines.push(`  transport    ${config.transport}`);
  if (config.transport === 'http') lines.push(`  url          ${config.url}`);
  else {
    lines.push(`  command      ${config.command}`);
    lines.push(`  args         ${JSON.stringify(config.args ?? [])}`);
    if (config.cwd) lines.push(`  cwd          ${config.cwd}`);
    if (config.env)
      lines.push(`  env keys     ${Object.keys(config.env).join(', ')} (values hidden)`);
  }
  lines.push(`  enabled      ${config.enabled ? 'yes' : 'no'}`);
  if (config.auth) {
    lines.push(
      `  auth         ${config.auth.type}, credential ref "${config.auth.credentialRef}", header ${config.auth.headerName ?? (config.auth.type === 'bearer' ? 'Authorization' : 'X-API-Key')}`,
    );
    lines.push('  secret       stored in the credential store; never written to the config file');
  } else {
    lines.push('  auth         none');
  }
  lines.push(`  timeout      ${config.timeoutMs}ms`);
  lines.push(`  output cap   ${config.outputLimitBytes} bytes`);
  if ((config.disabledTools ?? []).length > 0) {
    lines.push(`  disabled     ${(config.disabledTools ?? []).join(', ')}`);
  }
  if (state) {
    lines.push('');
    lines.push(`  status       ${state.status}`);
    if (state.serverName)
      lines.push(`  server       ${state.serverName} ${state.serverVersion ?? ''}`.trim());
    if (state.lastConnectedAt) lines.push(`  last ok      ${state.lastConnectedAt}`);
    if (state.lastError) lines.push(`  last error   ${state.lastError}`);
    if (state.status === 'ready') {
      lines.push(
        `  tools        ${state.tools.length} (${state.tools.filter((t) => t.enabled).length} enabled)`,
      );
      lines.push(
        `  resources    ${state.resources.length}${state.capabilities?.resources === false ? ' (not advertised)' : ''}`,
      );
      lines.push(
        `  prompts      ${state.prompts.length}${state.capabilities?.prompts === false ? ' (not advertised)' : ''}`,
      );
    }
  }
  return { ok: true, output: lines.join('\n') };
}

async function testServer(app: AppState, name: string | undefined): Promise<CommandResult> {
  if (!name) return { ok: false, error: 'Usage: /mcp test <name>' };
  const config = app.mcp.getConfig(name);
  if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };
  if (!config.enabled) {
    return {
      ok: false,
      error: `MCP server "${name}" is disabled. Enable it first: /mcp enable ${name}`,
    };
  }

  const state = await app.mcp.connect(name);
  const lines: string[] = [`MCP server "${name}" connected successfully.`, ''];
  lines.push(`  server     ${state.serverName ?? '(unknown)'} ${state.serverVersion ?? ''}`.trim());
  lines.push(`  transport  ${config.transport}`);
  lines.push(`  tools      ${state.tools.length}`);
  lines.push(
    `  resources  ${state.resources.length}${state.capabilities?.resources === false ? ' (not advertised)' : ''}`,
  );
  lines.push(
    `  prompts    ${state.prompts.length}${state.capabilities?.prompts === false ? ' (not advertised)' : ''}`,
  );
  if (state.instructions) {
    lines.push(`  note       server instructions present (treated as untrusted data)`);
  }
  lines.push('');
  lines.push(`Inspect with /mcp tools ${name}; policy with /mcp permissions ${name}.`);
  lines.push(
    'Tools are exposed to the model only in modes that allow the "mcp" permission class (build),',
  );
  lines.push('and every call still passes the permission engine.');
  return { ok: true, output: lines.join('\n') };
}

function enableServer(app: AppState, name: string | undefined, enabled: boolean): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /mcp enable <name>' };
  const config = app.mcp.getConfig(name);
  if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };
  config.enabled = enabled;
  saveConfig(app);
  return {
    ok: true,
    output:
      `MCP server "${name}" ${enabled ? 'enabled' : 'disabled'}.\n` +
      (enabled
        ? `It connects on demand (agent turns) or explicitly with /mcp test ${name}. Tools are not auto-approved.`
        : 'Its tools are no longer listed or callable; existing connections are closed.'),
  };
}

async function enableServerAsync(
  app: AppState,
  name: string | undefined,
  enabled: boolean,
): Promise<CommandResult> {
  const result = enableServer(app, name, enabled);
  if (result.ok && !enabled && name) await app.mcp.disconnect(name);
  return result;
}

async function removeServer(
  app: AppState,
  name: string | undefined,
  confirmed: boolean,
): Promise<CommandResult> {
  if (!name) return { ok: false, error: 'Usage: /mcp remove <name> --yes' };
  const config = app.mcp.getConfig(name);
  if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };

  if (!confirmed) {
    return {
      ok: false,
      error:
        `This removes the MCP server configuration "${name}" (${config.transport}).\n` +
        `Tool exposure state and the credential reference are removed with it; the stored secret in the\n` +
        `credential store is NOT deleted (delete it separately if needed).\n` +
        `Re-run to confirm: /mcp remove ${name} --yes`,
    };
  }

  await app.mcp.disconnect(name);
  const index = app.config.mcpServers.findIndex((server) => server.name === name);
  if (index >= 0) app.config.mcpServers.splice(index, 1);
  saveConfig(app);
  return { ok: true, output: `MCP server removed: ${name}.` };
}

function targetServers(app: AppState, name: string | undefined): MCPServerConfig[] | CommandResult {
  if (name) {
    const config = app.mcp.getConfig(name);
    if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };
    return [config];
  }
  const enabled = app.mcp.servers().filter((server) => server.enabled);
  if (enabled.length === 0) {
    return {
      ok: true,
      output:
        'No MCP servers are enabled.\n' +
        'Add one with /mcp add (see /mcp list for examples), store credentials with /mcp auth, then /mcp enable.',
    };
  }
  return enabled;
}

async function listTools(app: AppState, name: string | undefined): Promise<CommandResult> {
  const targets = targetServers(app, name);
  if (!Array.isArray(targets)) return targets;

  const lines: string[] = [];
  for (const config of targets) {
    if (!config.enabled) {
      lines.push(`${config.name}: disabled`);
      continue;
    }
    await app.mcp.ensureConnected(config.name);
    const state = app.mcp.state(config.name);
    lines.push(`${config.name}:`);
    if (!state || state.status !== 'ready') {
      lines.push(`  not connected${state?.lastError ? ` — ${state.lastError}` : ''}`);
      lines.push(`  Try /mcp test ${config.name}`);
      continue;
    }
    if (state.tools.length === 0) {
      lines.push('  (no tools advertised)');
      continue;
    }
    for (const tool of state.tools) {
      const flags: string[] = [];
      if (!tool.enabled) flags.push('DISABLED');
      flags.push(`timeout ${tool.timeoutMs ?? config.timeoutMs}ms`);
      flags.push(`cap ${tool.outputBudget ?? config.outputLimitBytes} chars`);
      lines.push(`  ${mcpToolName(config.name, tool.name)}`);
      lines.push(`      ${tool.description.split('\n')[0]?.slice(0, 140) ?? ''}`);
      lines.push(`      ${flags.join(' · ')}`);
    }
    lines.push(
      `  ${state.tools.length} tool(s); enable/disable with /mcp permissions ${config.name} <tool> on|off`,
    );
  }
  return { ok: true, output: lines.join('\n') };
}

async function listResources(app: AppState, name: string | undefined): Promise<CommandResult> {
  const targets = targetServers(app, name);
  if (!Array.isArray(targets)) return targets;

  const lines: string[] = [];
  for (const config of targets) {
    if (!config.enabled) {
      lines.push(`${config.name}: disabled`);
      continue;
    }
    await app.mcp.ensureConnected(config.name);
    const state = app.mcp.state(config.name);
    lines.push(`${config.name}:`);
    if (!state || state.status !== 'ready') {
      lines.push(`  not connected${state?.lastError ? ` — ${state.lastError}` : ''}`);
      continue;
    }
    if (state.capabilities?.resources === false) {
      lines.push('  (server does not advertise resources)');
    } else if (state.resources.length === 0) {
      lines.push('  (no resources advertised)');
    } else {
      for (const resource of state.resources) {
        lines.push(`  ${resource.uri}`);
        lines.push(
          `      ${resource.name}${resource.mimeType ? ` (${resource.mimeType})` : ''}${resource.description ? ` — ${resource.description.slice(0, 120)}` : ''}`,
        );
      }
    }
  }
  return { ok: true, output: lines.join('\n') };
}

async function listPrompts(app: AppState, name: string | undefined): Promise<CommandResult> {
  const targets = targetServers(app, name);
  if (!Array.isArray(targets)) return targets;

  const lines: string[] = [];
  for (const config of targets) {
    if (!config.enabled) {
      lines.push(`${config.name}: disabled`);
      continue;
    }
    await app.mcp.ensureConnected(config.name);
    const state = app.mcp.state(config.name);
    lines.push(`${config.name}:`);
    if (!state || state.status !== 'ready') {
      lines.push(`  not connected${state?.lastError ? ` — ${state.lastError}` : ''}`);
      continue;
    }
    if (state.capabilities?.prompts === false) {
      lines.push('  (server does not advertise prompts)');
    } else if (state.prompts.length === 0) {
      lines.push('  (no prompts advertised)');
    } else {
      for (const prompt of state.prompts) {
        lines.push(
          `  ${prompt.name}${prompt.description ? ` — ${prompt.description.slice(0, 140)}` : ''}`,
        );
        for (const arg of prompt.arguments ?? []) {
          lines.push(
            `      ${arg.name}${arg.required ? ' (required)' : ''}${arg.description ? ` — ${arg.description.slice(0, 100)}` : ''}`,
          );
        }
      }
    }
  }
  return { ok: true, output: lines.join('\n') };
}
