/**
 * Real MCP stdio integration (§35–§38): a genuine MCP server process is
 * spawned over stdio using the official SDK, exactly like a user-configured
 * server. No network, no mocks — the fixture server is part of this repo.
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { defaultConfig } from '../config/schema.js';
import { MemoryCredentialStore } from '../app/test-utils.js';
import { MCPManager } from './manager.js';
import type { AppConfig, MCPServerConfig } from '../types/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureServer = join(here, 'fixtures', 'stdio-test-server.ts');
const workspaceRoot = resolve(here, '../..');

const TEST_TIMEOUT = 30_000;

function stdioConfig(name: string, overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureServer],
    cwd: workspaceRoot,
    enabled: true,
    timeoutMs: 20_000,
    outputLimitBytes: 20_000,
    ...overrides,
  };
}

function makeManager(servers: MCPServerConfig[]): MCPManager {
  const config = structuredClone(defaultConfig) as unknown as AppConfig;
  config.providers = [];
  config.mcpServers = servers;
  return new MCPManager({
    config,
    credentialStore: new MemoryCredentialStore(),
    workspaceRoot,
  });
}

describe('MCP stdio integration', () => {
  it(
    'connects to a real stdio server and discovers tools, resources, and prompts',
    async () => {
      const manager = makeManager([stdioConfig('fixture')]);
      try {
        const state = await manager.connect('fixture');
        expect(state.status).toBe('ready');
        expect(state.serverName).toBe('mediaxg-test-server');
        expect(state.serverVersion).toBe('1.0.0');

        const toolNames = state.tools.map((tool) => tool.name).sort();
        expect(toolNames).toEqual(['add', 'echo', 'fail', 'slow']);

        const echo = state.tools.find((tool) => tool.name === 'echo')!;
        expect(echo.description).toContain('Echo');
        expect(echo.inputSchema).toMatchObject({ type: 'object' });

        expect(state.resources.map((resource) => resource.uri)).toContain('test://readme');
        expect(state.prompts.map((prompt) => prompt.name)).toContain('greet');
        expect(state.capabilities).toEqual({ tools: true, resources: true, prompts: true });
      } finally {
        await manager.closeAll();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'calls tools end to end and preserves server-reported errors',
    async () => {
      const manager = makeManager([stdioConfig('fixture')]);
      try {
        await manager.connect('fixture');

        const echoed = await manager.callTool('fixture', 'echo', { text: 'hello' });
        expect(echoed.isError).toBe(false);
        expect(echoed.content).toBe('echo:hello');

        const sum = await manager.callTool('fixture', 'add', { a: 2, b: 3 });
        expect(sum.content).toBe('5');

        const failure = await manager.callTool('fixture', 'fail', {});
        expect(failure.isError).toBe(true);
        expect(failure.content).toContain('intentional tool failure');
      } finally {
        await manager.closeAll();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'exposes wrapped tools that validate arguments and surface provenance',
    async () => {
      const manager = makeManager([stdioConfig('fixture')]);
      try {
        await manager.connect('fixture');
        const tool = manager.registeredTools().find((entry) => entry.name === 'mcp__fixture__add')!;
        expect(tool).toBeDefined();

        const invalid = tool.validateArgs({ a: 'two', b: 3 });
        expect(invalid.ok).toBe(false);

        const valid = tool.validateArgs({ a: 2, b: 3 });
        expect(valid.ok).toBe(true);

        const result = await tool.execute({ a: 2, b: 3 }, { workspaceRoot, timeoutMs: 10_000 });
        expect(result.isError).toBe(false);
        expect(result.content).toContain('[MCP fixture/add · untrusted external output]');
        expect(result.content).toContain('5');
      } finally {
        await manager.closeAll();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'times out a slow tool without hanging the manager',
    async () => {
      const manager = makeManager([stdioConfig('fixture')]);
      try {
        await manager.connect('fixture');
        await expect(manager.callTool('fixture', 'slow', {}, { timeoutMs: 300 })).rejects.toThrow(
          /MCP call fixture\/slow failed/,
        );
        expect(manager.state('fixture')!.lastError).toContain('slow');
      } finally {
        await manager.closeAll();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'closes the child process cleanly and supports repeated shutdown',
    async () => {
      const manager = makeManager([stdioConfig('fixture')]);
      await manager.connect('fixture');
      expect(manager.isConnected('fixture')).toBe(true);

      await manager.closeAll();
      expect(manager.isConnected('fixture')).toBe(false);

      // A second shutdown is a no-op, not an error
      await manager.closeAll();
      expect(manager.logEntries().some((entry) => entry.message === 'disconnected')).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
