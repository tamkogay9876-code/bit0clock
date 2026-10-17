/**
 * Internal MCP client interface (§35).
 *
 * The official `@modelcontextprotocol/sdk` is used for the protocol, but it
 * stays behind this interface: only `src/mcp/client.ts` imports the SDK, and
 * everything else (manager, tools, commands, tests) talks to `McpClientLike`.
 */

import type { MCPServerConfig } from '../types/index.js';

export interface McpToolInfo {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Server annotation, shown to the user; never trusted for policy */
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpCallOutcome {
  /** Rendered tool content (non-text parts are represented, never inlined) */
  content: string;
  /** Protocol-level tool error reported by the server (`isError: true`) */
  isError: boolean;
  /** Content types seen in the response (text, image, resource, …) */
  contentTypes: string[];
}

export interface McpCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * One live MCP session. Implementations must be safe to `close()` more than
 * once and must not throw from accessors.
 */
export interface McpClientLike {
  readonly serverName: string | undefined;
  readonly serverVersion: string | undefined;
  readonly instructions: string | undefined;
  /** Capabilities advertised during initialize (what the server actually offers) */
  readonly capabilities: { tools: boolean; resources: boolean; prompts: boolean };
  listTools(): Promise<McpToolInfo[]>;
  listResources(): Promise<McpResourceInfo[]>;
  listPrompts(): Promise<McpPromptInfo[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallOutcome>;
  close(): Promise<void>;
}

export interface McpAuthHeader {
  name: string;
  value: string;
}

/** Factory used by the manager; injectable so tests can fake servers. */
export type McpClientFactory = (
  config: MCPServerConfig,
  authHeader: McpAuthHeader | undefined,
) => Promise<McpClientLike>;
