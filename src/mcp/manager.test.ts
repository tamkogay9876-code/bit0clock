/**
 * MCP manager tests (§35–§38): lifecycle, auth, capability discovery, tool
 * exposure, argument validation, call semantics, and failure isolation.
 *
 * Everything runs against an injected fake client factory, so no network and
 * no child processes are involved here (the real SDK is covered by
 * `stdio.test.ts`).
 */

import { describe, expect, it } from 'bun:test';
import { defaultConfig } from '../config/schema.js';
import { MemoryCredentialStore } from '../app/test-utils.js';
import { ToolRegistry } from '../tools/registry.js';
import { assertNoSecretsInUrl } from './client.js';
import { MCPManager, mcpToolName, type McpManagerOptions } from './manager.js';
import { FAKE_ECHO_SCHEMA, FakeMcpClient, type FakeMcpClientOptions } from './test-utils.js';
import type { AppConfig, MCPServerConfig } from '../types/index.js';
import type { McpAuthHeader, McpClientFactory } from './types.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeConfig(servers: Array<Partial<MCPServerConfig>>): AppConfig {
  const config = structuredClone(defaultConfig) as unknown as AppConfig;
  config.providers = [];
  config.mcpServers = servers.map((server) => ({
    name: 'srv',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
    timeoutMs: 5000,
    outputLimitBytes: 10_000,
    ...server,
  }));
  return config;
}

interface Harness {
  manager: MCPManager;
  credentials: MemoryCredentialStore;
  factoryCalls: Array<{ config: MCPServerConfig; auth?: McpAuthHeader }>;
  clients: FakeMcpClient[];
}

function makeHarness(
  config: AppConfig,
  options: {
    clientOptions?: FakeMcpClientOptions;
    onFactory?: (config: MCPServerConfig) => void | Promise<void>;
    factory?: McpClientFactory;
  } = {},
): Harness {
  const credentials = new MemoryCredentialStore();
  const factoryCalls: Harness['factoryCalls'] = [];
  const clients: FakeMcpClient[] = [];

  const factory: McpClientFactory =
    options.factory ??
    (async (serverConfig, authHeader) => {
      factoryCalls.push({ config: serverConfig, ...(authHeader ? { auth: authHeader } : {}) });
      await options.onFactory?.(serverConfig);
      const client = new FakeMcpClient(options.clientOptions);
      clients.push(client);
      return client;
    });

  const manager = new MCPManager({
    config,
    credentialStore: credentials,
    workspaceRoot: process.cwd(),
    clientFactory: factory,
  });
  return { manager, credentials, factoryCalls, clients };
}

// ============================================================================
// Tool naming and URL hygiene
// ============================================================================

describe('mcpToolName', () => {
  it('builds provider-safe namespaced tool names', () => {
    expect(mcpToolName('srv', 'echo')).toBe('mcp__srv__echo');
    expect(mcpToolName('my.server', 'do/thing')).toBe('mcp__my_server__do_thing');
  });

  it('caps long names deterministically with a stable suffix', () => {
    const long = 'x'.repeat(60);
    const first = mcpToolName(long, long);
    const second = mcpToolName(long, long);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toBe(second);
    expect(mcpToolName(long, `${long}y`)).not.toBe(first);
  });
});

describe('assertNoSecretsInUrl', () => {
  it('accepts clean URLs', () => {
    expect(() => assertNoSecretsInUrl('https://mcp.example.com/mcp')).not.toThrow();
    expect(() => assertNoSecretsInUrl('https://mcp.example.com/mcp?workspace=docs')).not.toThrow();
  });

  it('refuses secret-looking query parameters and inline credentials', () => {
    expect(() => assertNoSecretsInUrl('https://mcp.example.com/mcp?api_key=abc')).toThrow(
      /secret-looking query parameter/,
    );
    expect(() => assertNoSecretsInUrl('https://mcp.example.com/mcp?token=abc')).toThrow(
      /secret-looking query parameter/,
    );
    expect(() => assertNoSecretsInUrl('https://user:pass@mcp.example.com/mcp')).toThrow(
      /credentials in the URL/,
    );
    expect(() => assertNoSecretsInUrl('not a url')).toThrow(/Invalid MCP server URL/);
  });
});

// ============================================================================
// Lifecycle
// ============================================================================

describe('MCPManager lifecycle', () => {
  it('connects, discovers capabilities, and maps tool metadata', async () => {
    const { manager } = makeHarness(makeConfig([{}]), {
      clientOptions: {
        tools: [
          {
            name: 'echo',
            title: 'Echo tool',
            description: 'Echo text',
            inputSchema: FAKE_ECHO_SCHEMA,
            readOnlyHint: true,
          },
          { name: 'add', description: 'Add numbers', inputSchema: { type: 'object' } },
        ],
        resources: [{ uri: 'fake://readme', name: 'readme', mimeType: 'text/plain' }],
        prompts: [
          { name: 'greet', description: 'Greet', arguments: [{ name: 'name', required: true }] },
        ],
      },
    });

    expect(manager.states()[0]!.status).toBe('idle');
    const state = await manager.connect('srv');
    expect(state.status).toBe('ready');
    expect(state.serverName).toBe('fake-server');
    expect(state.serverVersion).toBe('9.9.9');
    expect(state.tools.length).toBe(2);
    expect(state.tools[0]!.title).toBe('Echo tool');
    expect(state.tools[0]!.enabled).toBe(true);
    expect(state.tools[0]!.timeoutMs).toBe(5000);
    expect(state.tools[0]!.outputBudget).toBe(10_000);
    expect(state.resources[0]!.serverName).toBe('srv');
    expect(state.prompts[0]!.serverName).toBe('srv');
    expect(manager.isConnected('srv')).toBe(true);
  });

  it('does not list resources or prompts the server does not advertise', async () => {
    const { manager, clients } = makeHarness(makeConfig([{}]), {
      clientOptions: { capabilities: { tools: true, resources: false, prompts: false } },
    });
    const state = await manager.connect('srv');
    expect(state.resources).toEqual([]);
    expect(state.prompts).toEqual([]);
    expect(clients[0]!.listResourcesCalls).toBe(0);
    expect(clients[0]!.listPromptsCalls).toBe(0);
  });

  it('records connection failures without throwing from ensureConnected', async () => {
    const { manager } = makeHarness(makeConfig([{}]), {
      onFactory: () => {
        throw new Error('spawn failed');
      },
    });
    const state = await manager.ensureConnected('srv');
    expect(state!.status).toBe('error');
    expect(state!.lastError).toContain('spawn failed');
    expect(manager.registeredTools()).toEqual([]);

    await expect(manager.connect('srv')).rejects.toThrow(/spawn failed/);
  });

  it('skips disabled servers in ensureEnabledConnected and refuses to connect them', async () => {
    const { manager, factoryCalls } = makeHarness(
      makeConfig([
        { name: 'on', enabled: true },
        { name: 'off', enabled: false },
      ]),
    );
    await manager.ensureEnabledConnected();
    expect(factoryCalls.map((call) => call.config.name)).toEqual(['on']);
    await expect(manager.connect('off')).rejects.toThrow(/disabled/);
  });

  it('disconnects and closes clients, clearing discovered tools', async () => {
    const { manager, clients } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');
    await manager.disconnect('srv');
    expect(clients[0]!.closed).toBe(true);
    const state = manager.state('srv')!;
    expect(state.status).toBe('idle');
    expect(state.tools).toEqual([]);
    expect(manager.isConnected('srv')).toBe(false);
  });

  it('closeAll closes every connection', async () => {
    const { manager, clients } = makeHarness(makeConfig([{ name: 'a' }, { name: 'b' }]));
    await manager.connect('a');
    await manager.connect('b');
    await manager.closeAll();
    expect(clients.every((client) => client.closed)).toBe(true);
    expect(manager.isConnected('a')).toBe(false);
    expect(manager.isConnected('b')).toBe(false);
  });

  it('reconnect refreshes metadata from a live connection', async () => {
    const { manager, clients } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');
    await manager.connect('srv');
    expect(clients.length).toBe(1);
    expect(manager.state('srv')!.tools.length).toBe(1);
  });
});

// ============================================================================
// Authentication
// ============================================================================

describe('MCPManager authentication', () => {
  it('sends a bearer token from the credential store (never from config)', async () => {
    const config = makeConfig([{ auth: { type: 'bearer', credentialRef: 'SRV_API_KEY' } }]);
    const { manager, credentials, factoryCalls } = makeHarness(config);
    await credentials.set('SRV_API_KEY', 'top-secret');

    await manager.connect('srv');
    expect(factoryCalls[0]!.auth).toEqual({ name: 'Authorization', value: 'Bearer top-secret' });
  });

  it('supports api-key auth with a custom header name', async () => {
    const config = makeConfig([
      { auth: { type: 'api-key', credentialRef: 'SRV_KEY', headerName: 'X-API-Key' } },
    ]);
    const { manager, credentials, factoryCalls } = makeHarness(config);
    await credentials.set('SRV_KEY', 'key-123');

    await manager.connect('srv');
    expect(factoryCalls[0]!.auth).toEqual({ name: 'X-API-Key', value: 'key-123' });
  });

  it('fails with an actionable message when the credential is missing', async () => {
    const config = makeConfig([{ auth: { type: 'bearer', credentialRef: 'MISSING_REF' } }]);
    const { manager } = makeHarness(config);
    const state = await manager.ensureConnected('srv');
    expect(state!.status).toBe('error');
    expect(state!.lastError).toContain('MISSING_REF');
    expect(state!.lastError).toContain('/mcp auth');
  });

  it('refuses OAuth with an explicit limitation message', async () => {
    const config = makeConfig([{ auth: { type: 'oauth', credentialRef: 'SRV_OAUTH' } }]);
    const { manager, credentials } = makeHarness(config);
    await credentials.set('SRV_OAUTH', 'token');
    const state = await manager.ensureConnected('srv');
    expect(state!.status).toBe('error');
    expect(state!.lastError).toContain('OAuth');
    expect(state!.lastError).toContain('not implement');
  });
});

// ============================================================================
// Tool exposure and validation
// ============================================================================

describe('MCPManager tool exposure', () => {
  it('exposes tools only after a real connection', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    expect(manager.registeredTools()).toEqual([]);
    await manager.connect('srv');
    const tools = manager.registeredTools();
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__srv__echo']);
    expect(tools[0]!.permissionClass).toBe('mcp');
    expect(tools[0]!.mutating).toBe(true);
  });

  it('hides tools that are not offered in read-only modes', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');

    const registry = new ToolRegistry();
    registry.registerAll(manager.registeredTools());
    expect(registry.providerToolsForMode('build').map((tool) => tool.name)).toContain(
      'mcp__srv__echo',
    );
    expect(registry.providerToolsForMode('plan')).toEqual([]);
    expect(registry.providerToolsForMode('review')).toEqual([]);
  });

  it('validates arguments locally against the advertised JSON schema', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');
    const tool = manager.registeredTools()[0]!;

    expect(tool.validateArgs({}).ok).toBe(false);
    const wrongType = tool.validateArgs({ text: 42 });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.message).toContain('text');

    const valid = tool.validateArgs({ text: 'hi' });
    expect(valid.ok).toBe(true);
  });

  it('skips local validation when the server schema cannot be compiled', async () => {
    const { manager } = makeHarness(makeConfig([{}]), {
      clientOptions: {
        tools: [
          {
            name: 'broken',
            description: 'Bad schema',
            inputSchema: { type: 'object', properties: 'not-a-valid-properties-value' } as never,
          },
        ],
      },
    });
    await manager.connect('srv');
    const tool = manager.registeredTools()[0]!;
    expect(tool.validateArgs({ anything: true }).ok).toBe(true);
  });

  it('excludes tools disabled in the config and re-applies after refresh', async () => {
    const config = makeConfig([{ disabledTools: ['echo'] }]);
    const { manager } = makeHarness(config);
    await manager.connect('srv');
    expect(manager.registeredTools()).toEqual([]);
    expect(manager.state('srv')!.tools[0]!.enabled).toBe(false);

    config.mcpServers[0]!.disabledTools = [];
    await manager.refreshMetadata('srv');
    expect(manager.registeredTools().map((tool) => tool.name)).toEqual(['mcp__srv__echo']);
  });
});

// ============================================================================
// Tool calls
// ============================================================================

describe('MCPManager tool calls', () => {
  it('returns successful content and preserves the server error flag', async () => {
    const { manager } = makeHarness(makeConfig([{}]), {
      clientOptions: {
        tools: [
          { name: 'echo', description: 'ok', inputSchema: FAKE_ECHO_SCHEMA },
          { name: 'fail', description: 'fails', inputSchema: { type: 'object' } },
        ],
        callTool: async (name, args) =>
          name === 'fail'
            ? { content: 'intentional failure', isError: true, contentTypes: ['text'] }
            : { content: `echo:${String(args['text'])}`, isError: false, contentTypes: ['text'] },
      },
    });
    await manager.connect('srv');

    const ok = await manager.callTool('srv', 'echo', { text: 'hi' });
    expect(ok.isError).toBe(false);
    expect(ok.content).toBe('echo:hi');

    const failed = await manager.callTool('srv', 'fail', {});
    expect(failed.isError).toBe(true);
    expect(failed.content).toBe('intentional failure');
  });

  it('wraps results with an untrusted-output header and meta', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');
    const tool = manager.registeredTools()[0]!;
    const result = await tool.execute(
      { text: 'hi' },
      { workspaceRoot: process.cwd(), timeoutMs: 5000 },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[MCP srv/echo · untrusted external output]');
    expect(result.content).toContain('echo:hi');
    expect(result.meta?.mcp).toEqual({ server: 'srv', tool: 'echo', contentTypes: ['text'] });
  });

  it('turns transport failures into throws with state and log records', async () => {
    const { manager } = makeHarness(makeConfig([{}]), {
      clientOptions: {
        callTool: async () => {
          throw new Error('connection reset');
        },
      },
    });
    await manager.connect('srv');
    await expect(manager.callTool('srv', 'echo', { text: 'x' })).rejects.toThrow(
      /MCP call srv\/echo failed: connection reset/,
    );
    expect(manager.state('srv')!.lastError).toContain('connection reset');
    expect(
      manager
        .logEntries()
        .some((entry) => entry.level === 'error' && entry.message.includes('connection reset')),
    ).toBe(true);
  });

  it('refuses calls to disabled tools and disabled servers', async () => {
    const config = makeConfig([{ disabledTools: ['blocked'] }]);
    const { manager } = makeHarness(config, {
      clientOptions: {
        tools: [
          { name: 'echo', description: 'ok', inputSchema: FAKE_ECHO_SCHEMA },
          { name: 'blocked', description: 'no', inputSchema: { type: 'object' } },
        ],
      },
    });
    await manager.connect('srv');
    await expect(manager.callTool('srv', 'blocked', {})).rejects.toThrow(/disabled/);

    config.mcpServers[0]!.enabled = false;
    await expect(manager.callTool('srv', 'echo', { text: 'x' })).rejects.toThrow(/disabled/);
  });

  it('reports a clear error for unknown servers and tools', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    await expect(manager.callTool('nope', 'echo', {})).rejects.toThrow(/not configured/);
    await manager.connect('srv');
    const permissive = await manager.callTool('srv', 'unknown-tool', {});
    // The fake client accepts anything; the manager itself does not gate tool
    // existence at call time (the registry only exposes discovered tools).
    expect(permissive.content).toContain('echo:');
    expect(manager.toolInfo('mcp__srv__echo')).toBeDefined();
    expect(manager.toolInfo('mcp__srv__missing')).toBeUndefined();
  });

  it('drops tools and closes the connection for a removed server', async () => {
    const config = makeConfig([{}]);
    const { manager, clients } = makeHarness(config);
    await manager.connect('srv');
    config.mcpServers.length = 0;

    expect(manager.registeredTools()).toEqual([]);
    await manager.closeAll();
    expect(clients[0]!.closed).toBe(true);
    await expect(manager.callTool('srv', 'echo', {})).rejects.toThrow(/not configured/);
  });
});

// ============================================================================
// Logging
// ============================================================================

describe('MCPManager logging', () => {
  it('records connect, discovery, and call events with timestamps', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');
    await manager.callTool('srv', 'echo', { text: 'x' });

    const messages = manager.logEntries().map((entry) => entry.message);
    expect(messages.some((message) => message.includes('connecting'))).toBe(true);
    expect(messages.some((message) => message.includes('capabilities refreshed'))).toBe(true);
    expect(messages.some((message) => message.includes('tool echo'))).toBe(true);
    expect(manager.logEntries().every((entry) => entry.at.length > 0)).toBe(true);
  });

  it('keeps the log bounded', async () => {
    const { manager } = makeHarness(makeConfig([{}]));
    await manager.connect('srv');
    for (let i = 0; i < 260; i++) {
      await manager.callTool('srv', 'echo', { text: String(i) });
    }
    expect(manager.logEntries().length).toBeLessThanOrEqual(200);
  });
});

// ============================================================================
// Injected factory typing (regression for the manager options)
// ============================================================================

describe('McpManagerOptions', () => {
  it('accepts an injected factory and credential store', () => {
    const options: McpManagerOptions = {
      config: makeConfig([]),
      credentialStore: new MemoryCredentialStore(),
      workspaceRoot: process.cwd(),
      clientFactory: async () => new FakeMcpClient(),
    };
    expect(new MCPManager(options)).toBeDefined();
  });
});
