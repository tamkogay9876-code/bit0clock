/**
 * Deterministic MCP stdio server used by integration tests (§35, §36).
 *
 * It is a real MCP server built with the official SDK over stdio: the tests
 * spawn it exactly like a user-configured stdio server. It never touches the
 * network and never reads the environment beyond stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new (McpServer as any)({ name: 'mediaxg-test-server', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo the given text back, prefixed with "echo:"',
    inputSchema: { text: z.string() },
  },
  async ({ text }: { text: string }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }),
);

server.registerTool(
  'add',
  {
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }: { a: number; b: number }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
);

server.registerTool(
  'fail',
  {
    description: 'Always reports a server-side tool error',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: 'intentional tool failure' }],
    isError: true,
  }),
);

server.registerTool(
  'slow',
  {
    description: 'Waits 1.5 seconds before answering (timeout tests)',
    inputSchema: {},
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { content: [{ type: 'text', text: 'slow done' }] };
  },
);

server.registerResource(
  'readme',
  'test://readme',
  { description: 'A test resource', mimeType: 'text/plain' },
  async (uri: { href: string }) => ({
    contents: [{ uri: uri.href, text: 'resource body from the test server' }],
  }),
);

server.registerPrompt(
  'greet',
  {
    description: 'Greet a name',
    argsSchema: { name: z.string() },
  },
  async ({ name }: { name: string }) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: `Hello ${name}` },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
