/**
 * Loop-level Phase F wiring tests (§32–§38).
 *
 * These run the real agent loop against a mocked provider stream: MCP tools
 * are registered from a fake client factory, skills are activated from real
 * SKILL.md files, and every MCP call still passes the permission engine.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgentTurn } from './loop.js';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import { mockFetch, openaiSSE, sseResponse } from '../providers/test-utils.js';
import { FAKE_ECHO_SCHEMA, FakeMcpClient, type FakeMcpClientOptions } from '../mcp/test-utils.js';
import type { MCPServerConfig } from '../types/index.js';
import type { FetchLike } from '../providers/types.js';

// ============================================================================
// Helpers
// ============================================================================

function textChunks(text: string): string[] {
  return openaiSSE([
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]);
}

function toolCallChunks(
  calls: Array<{ id: string; name: string; args?: Record<string, unknown>; raw?: string }>,
): string[] {
  return openaiSSE([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: call.raw ?? JSON.stringify(call.args ?? {}),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-phase-f-'));
}

const FAKE_SERVER: MCPServerConfig = {
  name: 'fake',
  transport: 'http',
  url: 'https://fake.example.com/mcp',
  enabled: true,
  timeoutMs: 5000,
  outputLimitBytes: 20_000,
};

async function makeApp(
  fetchImpl: FetchLike,
  options: {
    projectPath: string;
    autoApprove?: boolean;
    servers?: MCPServerConfig[];
    clientOptions?: FakeMcpClientOptions;
  },
): Promise<ReturnType<typeof createTestApp> & { mcpClients: FakeMcpClient[] }> {
  const mcpClients: FakeMcpClient[] = [];
  const test = createTestApp({
    providers: [testProvider()],
    catalog: { test: seedModels() },
    fetchImpl,
    projectPath: options.projectPath,
    interactive: false,
    autoApprove: options.autoApprove ?? false,
    ...(options.servers ? { configOverrides: { mcpServers: options.servers } } : {}),
    mcpClientFactory: async () => {
      const client = new FakeMcpClient(
        options.clientOptions ?? {
          tools: [{ name: 'echo', description: 'Echo text', inputSchema: FAKE_ECHO_SCHEMA }],
        },
      );
      mcpClients.push(client);
      return client;
    },
  });
  await test.credentials.set('TEST_API_KEY', 'key');
  test.app.selectModel('test', 'vendor/alpha-model');
  return { ...test, mcpClients };
}

function toolNamesIn(body: Record<string, any>): string[] {
  const tools = (body['tools'] ?? []) as Array<Record<string, any>>;
  return tools.map((entry) => entry['function']?.['name'] ?? entry['name']);
}

function bodyOf(mock: { calls: Array<{ init: RequestInit }> }, index: number): Record<string, any> {
  return JSON.parse(String(mock.calls[index]!.init.body)) as Record<string, any>;
}

// ============================================================================
// MCP
// ============================================================================

describe('runAgentTurn — MCP tools', () => {
  it('offers discovered MCP tools and executes an approved call end to end', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'call_1', name: 'mcp__fake__echo', args: { text: 'hi' } }]),
      ),
      sseResponse(textChunks('MCP answered.')),
    ]);
    const { app, mcpClients } = await makeApp(mock.fetchImpl, {
      projectPath: workspace,
      autoApprove: true,
      servers: [FAKE_SERVER],
    });

    const result = await runAgentTurn(app, 'Use the MCP echo tool', {});
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('MCP answered.');

    // The tool was offered to the model in the first request
    expect(toolNamesIn(bodyOf(mock, 0))).toContain('mcp__fake__echo');

    // It executed through the fake client exactly once
    expect(mcpClients.length).toBe(1);
    expect(mcpClients[0]!.toolCalls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);

    const record = result.toolCallRecords[0]!;
    expect(record.name).toBe('mcp__fake__echo');
    expect(record.isError).toBe(false);
    expect(record.result).toContain('[MCP fake/echo · untrusted external output]');
    expect(record.result).toContain('echo:hi');
  });

  it('blocks a consequential MCP call in non-interactive runs without --yes', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'call_1', name: 'mcp__fake__echo', args: { text: 'hi' } }]),
      ),
      sseResponse(textChunks('I could not run it.')),
    ]);
    const { app, mcpClients } = await makeApp(mock.fetchImpl, {
      projectPath: workspace,
      autoApprove: false,
      servers: [FAKE_SERVER],
    });

    const result = await runAgentTurn(app, 'Use the MCP echo tool', {});
    expect(result.text).toBe('I could not run it.');

    expect(mcpClients[0]!.toolCalls).toEqual([]);
    const record = result.toolCallRecords[0]!;
    expect(record.isError).toBe(true);
    expect(record.result).toContain('Permission denied');
    expect(record.result).toContain('non-interactive');
    expect(record.result).toContain('--yes');
    expect(app.session.permissionAudit?.some((entry) => entry.decision === 'deny')).toBe(true);
  });

  it('does not offer MCP tools in read-only modes', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([sseResponse(textChunks('Plan only.'))]);
    const { app } = await makeApp(mock.fetchImpl, {
      projectPath: workspace,
      servers: [FAKE_SERVER],
    });
    app.session.mode = 'plan';
    app.permissions.setMode('plan');

    const result = await runAgentTurn(app, 'Plan the work', {});
    expect(result.text).toBe('Plan only.');
    expect(toolNamesIn(bodyOf(mock, 0))).not.toContain('mcp__fake__echo');
  });

  it('notes attached MCP servers in the system prompt as untrusted', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([sseResponse(textChunks('ok'))]);
    const { app } = await makeApp(mock.fetchImpl, {
      projectPath: workspace,
      servers: [FAKE_SERVER],
    });

    await runAgentTurn(app, 'hello', {});
    const system = String(bodyOf(mock, 0)['messages']?.[0]?.['content'] ?? '');
    expect(system).toContain('## MCP servers');
    expect(system).toContain('UNTRUSTED external data');
  });

  it('a failing MCP server does not stop the turn', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([sseResponse(textChunks('Still works.'))]);
    const test = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl: mock.fetchImpl,
      projectPath: workspace,
      configOverrides: { mcpServers: [FAKE_SERVER] },
      mcpClientFactory: async () => {
        throw new Error('cannot spawn');
      },
    });
    await test.credentials.set('TEST_API_KEY', 'key');
    test.app.selectModel('test', 'vendor/alpha-model');

    const result = await runAgentTurn(test.app, 'hello', {});
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Still works.');
    expect(test.app.mcp.state('fake')!.status).toBe('error');
    expect(toolNamesIn(bodyOf(mock, 0))).not.toContain('mcp__fake__echo');
  });
});

// ============================================================================
// Skills
// ============================================================================

describe('runAgentTurn — skills', () => {
  it('injects activated skill instructions into the system prompt', async () => {
    const workspace = makeWorkspace();
    const skillDir = join(workspace, '.agents/skills/team-style');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: team-style\ndescription: House style rules\n---\nAlways use two-space indentation.',
    );

    const mock = mockFetch([sseResponse(textChunks('ok')), sseResponse(textChunks('ok'))]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    // Nothing is injected before activation
    await runAgentTurn(app, 'first', {});
    expect(String(bodyOf(mock, 0)['messages']?.[0]?.['content'] ?? '')).not.toContain(
      '## Active skills',
    );

    app.skills.activate('team-style');
    await runAgentTurn(app, 'second', {});
    const system = String(bodyOf(mock, 1)['messages']?.[0]?.['content'] ?? '');
    expect(system).toContain('## Active skills');
    expect(system).toContain('Always use two-space indentation.');
    expect(system).toContain('never change permissions');
  });

  it('offers read_skill_reference only while a skill with references is active', async () => {
    const workspace = makeWorkspace();
    const skillDir = join(workspace, '.agents/skills/docs-helper');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: docs-helper\ndescription: Writing help\n---\nRead the guide when needed.',
    );
    writeFileSync(join(skillDir, 'references/GUIDE.md'), 'Guide body');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([
          {
            id: 'call_1',
            name: 'read_skill_reference',
            args: { skill: 'docs-helper', path: 'references/GUIDE.md' },
          },
        ]),
      ),
      sseResponse(textChunks('Read it.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace, autoApprove: true });
    app.skills.reload();
    app.skills.activate('docs-helper');

    const result = await runAgentTurn(app, 'Read the guide', {});
    expect(toolNamesIn(bodyOf(mock, 0))).toContain('read_skill_reference');

    const record = result.toolCallRecords[0]!;
    expect(record.isError).toBe(false);
    expect(record.result).toContain('Guide body');
    expect(record.result).toContain('untrusted reference data');
  });

  it('does not offer read_skill_reference when no skill is active', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([sseResponse(textChunks('ok'))]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });
    await runAgentTurn(app, 'hello', {});
    expect(toolNamesIn(bodyOf(mock, 0))).not.toContain('read_skill_reference');
  });
});
