/**
 * Deterministic MCP fakes for tests.
 *
 * Not part of the runtime surface: imported only from `*.test.ts` files.
 * The real SDK path is exercised by `stdio.test.ts` with a spawned server.
 */

import type {
  McpCallOptions,
  McpCallOutcome,
  McpClientLike,
  McpPromptInfo,
  McpResourceInfo,
  McpToolInfo,
} from './types.js';

export const FAKE_ECHO_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

export interface FakeMcpClientOptions {
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  tools?: McpToolInfo[];
  resources?: McpResourceInfo[];
  prompts?: McpPromptInfo[];
  capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
  callTool?: (name: string, args: Record<string, unknown>) => Promise<McpCallOutcome>;
  onClose?: () => void;
}

/** In-memory MCP client: records calls, never touches the network. */
export class FakeMcpClient implements McpClientLike {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly instructions: string;
  readonly capabilities: { tools: boolean; resources: boolean; prompts: boolean };
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  listResourcesCalls = 0;
  listPromptsCalls = 0;
  closed = false;

  constructor(private readonly options: FakeMcpClientOptions = {}) {
    this.serverName = options.serverName ?? 'fake-server';
    this.serverVersion = options.serverVersion ?? '9.9.9';
    this.instructions = options.instructions ?? 'Fake server instructions';
    this.capabilities = options.capabilities ?? { tools: true, resources: true, prompts: true };
  }

  async listTools(): Promise<McpToolInfo[]> {
    return (
      this.options.tools ?? [{ name: 'echo', description: 'Echo', inputSchema: FAKE_ECHO_SCHEMA }]
    );
  }

  async listResources(): Promise<McpResourceInfo[]> {
    this.listResourcesCalls++;
    return this.options.resources ?? [{ uri: 'fake://readme', name: 'readme' }];
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    this.listPromptsCalls++;
    return this.options.prompts ?? [{ name: 'greet', description: 'Greet' }];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _options: McpCallOptions,
  ): Promise<McpCallOutcome> {
    this.toolCalls.push({ name, args });
    if (this.options.callTool) return this.options.callTool(name, args);
    return {
      content: `echo:${String(args['text'] ?? '')}`,
      isError: false,
      contentTypes: ['text'],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.options.onClose?.();
  }
}
