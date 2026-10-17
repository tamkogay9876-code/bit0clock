/**
 * Non-interactive execution tests: command path, message path, exit codes.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runNonInteractive, type NonInteractiveIO } from './non-interactive.js';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import { defaultConfig } from '../config/schema.js';
import { mockFetch, openaiSSE, sseResponse } from '../providers/test-utils.js';

function captureIO(): { io: NonInteractiveIO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text) => outChunks.push(text),
      err: (text) => errChunks.push(text),
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

function chatSseResponse(text: string) {
  return sseResponse(
    openaiSSE([
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]),
  );
}

function toolCallSseResponse(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
) {
  return sseResponse(
    openaiSSE([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]),
  );
}

describe('runNonInteractive', () => {
  it('streams a chat response to the out sink and exits 0', async () => {
    const { fetchImpl } = mockFetch([chatSseResponse('Hello from the model')]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const { io, out, err } = captureIO();
    const code = await runNonInteractive(app, 'ping', io);

    expect(code).toBe(0);
    expect(out()).toContain('Hello from the model');
    expect(out().endsWith('\n')).toBe(true);
    expect(err()).toBe('');
  });

  it('runs a command and exits 0', async () => {
    const { app } = createTestApp();
    const { io, out } = captureIO();
    const code = await runNonInteractive(app, '/status', io);
    expect(code).toBe(0);
    expect(out()).toContain('Session');
  });

  it('fails an unknown command with a suggestion', async () => {
    const { app } = createTestApp();
    const { io, err } = captureIO();
    const code = await runNonInteractive(app, '/statsu', io);
    expect(code).toBe(1);
    expect(err()).toContain('Unknown command');
    expect(err()).toContain('/status');
  });

  it('fails an invalid command argument', async () => {
    const { app } = createTestApp();
    const { io, err } = captureIO();
    const code = await runNonInteractive(app, '/mode turbo', io);
    expect(code).toBe(1);
    expect(err()).toContain('plan, build, review');
  });

  it('explains that the connect wizard needs the TUI', async () => {
    const { app } = createTestApp();
    const { io, err } = captureIO();
    const code = await runNonInteractive(app, '/connect', io);
    expect(code).toBe(1);
    expect(err()).toContain('TUI');
    expect(err()).toContain('--key-env');
  });

  it('exits 0 for /exit', async () => {
    const { app } = createTestApp();
    const { io } = captureIO();
    expect(await runNonInteractive(app, '/exit', io)).toBe(0);
  });

  it('sends //escaped text as a message', async () => {
    const { fetchImpl } = mockFetch([chatSseResponse('noted')]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const { io, out } = captureIO();
    const code = await runNonInteractive(app, '//etc/passwd is fine', io);

    expect(code).toBe(0);
    expect(out()).toContain('noted');
    expect(app.session.messages[0]?.content).toBe('/etc/passwd is fine');
  });

  it('returns 1 with a clear error when no model is selected', async () => {
    const { app } = createTestApp();
    const { io, err } = captureIO();
    const code = await runNonInteractive(app, 'hello', io);
    expect(code).toBe(1);
    expect(err()).toContain('No model selected');
  });

  it('returns 1 when the provider request fails', async () => {
    const { fetchImpl } = mockFetch([
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const { io, err } = captureIO();
    const code = await runNonInteractive(app, 'ping', io);

    expect(code).toBe(1);
    expect(err()).toContain('Error');
  });
});

describe('runNonInteractive — agent tools', () => {
  it('reports tool activity on stderr and streams the final answer', async () => {
    const { fetchImpl } = mockFetch([
      toolCallSseResponse([{ id: 'c1', name: 'read_file', args: { path: 'hello.txt' } }]),
      chatSseResponse('The file says hi.'),
    ]);
    const { app, dir, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');
    writeFileSync(join(dir, 'hello.txt'), 'hi\n');

    const { io, out, err } = captureIO();
    const code = await runNonInteractive(app, 'check hello.txt', io);

    expect(code).toBe(0);
    expect(out()).toContain('The file says hi.');
    expect(err()).toContain('[tool] read_file — read hello.txt');
    expect(err()).toContain('[tool] read_file — ok');
    expect(app.session.toolHistory).toHaveLength(1);
  });

  it('denies consequential tools without --yes and leaves the file alone', async () => {
    const { fetchImpl } = mockFetch([
      toolCallSseResponse([{ id: 'c1', name: 'delete_file', args: { path: 'keep.txt' } }]),
      chatSseResponse('I cannot delete it without approval.'),
    ]);
    const { app, dir, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');
    writeFileSync(join(dir, 'keep.txt'), 'keep\n');

    const { io, err } = captureIO();
    const code = await runNonInteractive(app, 'delete keep.txt', io);

    expect(code).toBe(0);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(err()).toContain('[tool] delete_file — error');
    expect(app.session.permissionAudit?.[0]?.decision).toBe('deny');
    expect(app.session.toolHistory?.[0]?.result).toContain('Permission denied');
  });

  it('executes consequential tools when --yes was passed', async () => {
    const { fetchImpl } = mockFetch([
      toolCallSseResponse([{ id: 'c1', name: 'delete_file', args: { path: 'gone.txt' } }]),
      chatSseResponse('Deleted.'),
    ]);
    const { app, dir, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
      autoApprove: true,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');
    writeFileSync(join(dir, 'gone.txt'), 'bye\n');

    const { io, out, err } = captureIO();
    const code = await runNonInteractive(app, 'delete gone.txt', io);

    expect(code).toBe(0);
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
    expect(out()).toContain('Deleted.');
    expect(err()).toContain('[tool] delete_file — ok');
    expect(app.session.permissionAudit?.[0]?.decision).toBe('allow');
  });
});

describe('runNonInteractive — context events (§23–§31)', () => {
  it('stays quiet on stderr for a request inside the budget', async () => {
    const { fetchImpl } = mockFetch([chatSseResponse('plain answer')]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const { io, err } = captureIO();
    const code = await runNonInteractive(app, 'ping', io);
    expect(code).toBe(0);
    expect(err()).toBe('');
  });

  it('reports omitted messages to stderr when the budget trimmed the conversation', async () => {
    const { fetchImpl } = mockFetch([chatSseResponse('trimmed answer')]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/beta-fast'); // 32k window
    for (let i = 0; i < 15; i++) {
      app.session.messages.push({
        id: `m${i}`,
        role: 'user',
        content: `turn ${i} ${'x'.repeat(10_000)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const { io, out, err } = captureIO();
    const code = await runNonInteractive(app, 'continue', io);
    expect(code).toBe(0);
    expect(out()).toContain('trimmed answer');
    expect(err()).toContain('[context]');
    expect(err()).toContain('omitted');
  });

  it('reports an auto-approved confirmation in the context line', async () => {
    const { fetchImpl } = mockFetch([chatSseResponse('approved answer')]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
      autoApprove: true,
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          largeContextConfirmationThreshold: 1_000,
        },
      },
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const { io, err } = captureIO();
    const code = await runNonInteractive(app, 'ping', io);
    expect(code).toBe(0);
    expect(err()).toContain('[context]');
    expect(err()).toContain('gate confirm');
    expect(err()).toContain('confirmation granted');
  });

  it('a blocked gate exits 1 with the explanation and sends nothing', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
      configOverrides: {
        spendingLimits: { ...defaultConfig.spendingLimits, maxPerRequest: 0.000001 },
      },
    });
    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');

    const { io, err } = captureIO();
    const code = await runNonInteractive(app, 'ping', io);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err()).toContain('budget gate blocked');
  });
});
