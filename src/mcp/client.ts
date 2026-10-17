/**
 * SDK-backed MCP client (§35, §36).
 *
 * This is the ONLY module that imports `@modelcontextprotocol/sdk`. Everything
 * else uses the `McpClientLike` interface, which keeps the dependency
 * replaceable and the tests independent of SDK internals.
 *
 * Transport rules enforced here:
 *  - HTTP: streamable HTTP with auth headers built from the credential store;
 *    URLs containing secret-looking query parameters are refused (§36).
 *  - stdio: explicit command/args/cwd with an environment allowlist (the
 *    SDK's safe default environment plus explicitly configured variables).
 *  - Every request carries the configured timeout; stdio stderr is consumed
 *    line-by-line (never left to block the child process).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '../types/index.js';
import type { FetchLike } from '../providers/types.js';
import type {
  McpAuthHeader,
  McpCallOptions,
  McpCallOutcome,
  McpClientLike,
  McpPromptInfo,
  McpResourceInfo,
  McpToolInfo,
} from './types.js';

const SECRET_QUERY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|apikey|auth|access[-_]?key|credential)/i;

/** Refuse URLs that embed secrets (§36: no secrets in URLs). */
export function assertNoSecretsInUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid MCP server URL: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error(
      'MCP server URL contains credentials in the URL itself. Use auth with a credential reference instead.',
    );
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_PATTERN.test(key)) {
      throw new Error(
        `MCP server URL contains a secret-looking query parameter "${key}". ` +
          'Secrets must come from the credential store (auth.credentialRef), never from the URL.',
      );
    }
  }
}

export interface CreateMcpClientOptions {
  authHeader?: McpAuthHeader;
  /** Injected fetch for HTTP transports (tests, proxies) */
  fetchImpl?: FetchLike;
  /** Bounded stderr lines from stdio servers (diagnostics) */
  onStderrLine?: (line: string) => void;
  clientName?: string;
  clientVersion?: string;
}

export async function createMcpClient(
  config: MCPServerConfig,
  options: CreateMcpClientOptions = {},
): Promise<McpClientLike> {
  const client = new Client(
    {
      name: options.clientName ?? 'mediaxg',
      version: options.clientVersion ?? '0.1.0',
    },
    { capabilities: {} },
  );

  let transport: StreamableHTTPClientTransport | StdioClientTransport;

  if (config.transport === 'http') {
    if (!config.url) throw new Error(`MCP server "${config.name}" is missing a URL`);
    assertNoSecretsInUrl(config.url);

    const headers: Record<string, string> = {};
    if (options.authHeader) headers[options.authHeader.name] = options.authHeader.value;

    const transportOptions: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
      requestInit: { headers },
    };
    if (options.fetchImpl) {
      transportOptions.fetch = options.fetchImpl as unknown as NonNullable<
        ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
      >['fetch'];
    }
    transport = new StreamableHTTPClientTransport(new URL(config.url), transportOptions);
  } else {
    if (!config.command) throw new Error(`MCP server "${config.name}" is missing a command`);
    const stderrLines = options.onStderrLine;
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // Environment allowlist: the SDK's safe default variables plus exactly
      // the variables configured for this server — never the full parent env.
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      stderr: 'pipe',
    });
    const stderr = transport.stderr as unknown as {
      on?: (event: 'data', listener: (chunk: unknown) => void) => void;
    } | null;
    if (stderrLines && stderr?.on) {
      let buffer = '';
      stderr.on('data', (chunk: unknown) => {
        buffer += Buffer.from(chunk as Uint8Array).toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) stderrLines(line.slice(0, 500));
        }
        if (buffer.length > 2000) buffer = buffer.slice(-1000);
      });
    }
  }

  await client.connect(transport, { timeout: config.timeoutMs });
  return new SdkMcpClient(client, config.timeoutMs);
}

// ============================================================================
// Wrapper
// ============================================================================

function renderContent(content: unknown): { text: string; types: string[] } {
  const parts: string[] = [];
  const types: string[] = [];
  if (!Array.isArray(content)) return { text: '', types };

  for (const item of content) {
    const record = (item ?? {}) as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? (record['type'] as string) : 'unknown';
    types.push(type);
    switch (type) {
      case 'text':
        parts.push(typeof record['text'] === 'string' ? record['text'] : '');
        break;
      case 'image':
        parts.push(`[image content omitted: ${String(record['mimeType'] ?? 'unknown type')}]`);
        break;
      case 'audio':
        parts.push(`[audio content omitted: ${String(record['mimeType'] ?? 'unknown type')}]`);
        break;
      case 'resource': {
        const resource = record['resource'] as Record<string, unknown> | undefined;
        if (resource && typeof resource['text'] === 'string') {
          parts.push(resource['text']);
        } else {
          parts.push(`[binary resource omitted: ${String(resource?.['uri'] ?? '')}]`);
        }
        break;
      }
      case 'resource_link':
        parts.push(`[resource link: ${String(record['uri'] ?? '')}]`);
        break;
      default:
        parts.push(`[unsupported MCP content type: ${type}]`);
    }
  }
  return { text: parts.join('\n'), types };
}

class SdkMcpClient implements McpClientLike {
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {}

  get serverName(): string | undefined {
    return this.client.getServerVersion()?.name;
  }

  get serverVersion(): string | undefined {
    return this.client.getServerVersion()?.version;
  }

  get instructions(): string | undefined {
    return this.client.getInstructions();
  }

  get capabilities(): { tools: boolean; resources: boolean; prompts: boolean } {
    const caps = this.client.getServerCapabilities();
    return {
      tools: caps?.tools !== undefined,
      resources: caps?.resources !== undefined,
      prompts: caps?.prompts !== undefined,
    };
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.client.listTools(undefined, { timeout: this.timeoutMs });
    return result.tools.map((tool) => {
      const info: McpToolInfo = {
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      };
      if (tool.title !== undefined) info.title = tool.title;
      if (tool.annotations?.readOnlyHint !== undefined)
        info.readOnlyHint = tool.annotations.readOnlyHint;
      if (tool.annotations?.destructiveHint !== undefined) {
        info.destructiveHint = tool.annotations.destructiveHint;
      }
      if (tool.annotations?.openWorldHint !== undefined) {
        info.openWorldHint = tool.annotations.openWorldHint;
      }
      return info;
    });
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const result = await this.client.listResources(undefined, { timeout: this.timeoutMs });
    return result.resources.map((resource) => {
      const info: McpResourceInfo = { uri: resource.uri, name: resource.name };
      if (resource.description !== undefined) info.description = resource.description;
      if (resource.mimeType !== undefined) info.mimeType = resource.mimeType;
      return info;
    });
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    const result = await this.client.listPrompts(undefined, { timeout: this.timeoutMs });
    return result.prompts.map((prompt) => {
      const info: McpPromptInfo = { name: prompt.name };
      if (prompt.description !== undefined) info.description = prompt.description;
      if (prompt.arguments !== undefined) {
        info.arguments = prompt.arguments.map((arg) => {
          const entry: { name: string; description?: string; required?: boolean } = {
            name: arg.name,
          };
          if (arg.description !== undefined) entry.description = arg.description;
          if (arg.required !== undefined) entry.required = arg.required;
          return entry;
        });
      }
      return info;
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallOutcome> {
    const requestOptions: { timeout: number; signal?: AbortSignal } = {
      timeout: options.timeoutMs,
    };
    if (options.signal) requestOptions.signal = options.signal;
    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions);
    const rendered = renderContent((result as { content?: unknown }).content);
    return {
      content: rendered.text,
      isError: (result as { isError?: boolean }).isError === true,
      contentTypes: rendered.types,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // Closing a broken session is best-effort; the child/connection is gone
    }
  }
}
