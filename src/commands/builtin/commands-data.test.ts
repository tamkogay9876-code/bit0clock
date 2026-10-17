/**
 * Built-in command tests — models, providers, sessions.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CommandRegistry } from '../registry.js';
import { registerBuiltinCommands } from './index.js';
import { parseInput } from '../parser.js';
import type { CommandResult } from '../types.js';
import { createTestApp, seedModels, testProvider } from '../../app/test-utils.js';
import { jsonResponse, errorResponse, mockFetch } from '../../providers/test-utils.js';
import type { AppState } from '../../app/state.js';

function registryFor(app: AppState): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);
  return registry;
}

async function run(registry: CommandRegistry, input: string): Promise<CommandResult> {
  const result = await registry.dispatch(parseInput(input));
  if (!result) throw new Error(`Not a command: ${input}`);
  return result;
}

describe('model commands', () => {
  function makeModelApp(fetchImpl?: typeof fetch) {
    return createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      ...(fetchImpl ? { fetchImpl: fetchImpl as never } : {}),
    });
  }

  it('/models --list prints the catalog with details', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/models --list');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('vendor/alpha-model');
    expect(result.output).toContain('ctx 128k');
    expect(result.output).toContain('[tools, reason');
  });

  it('/models without --list requests the picker but still produces a list', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/models');
    expect(result.action?.type).toBe('open-model-picker');
    expect(result.output).toContain('vendor/alpha-model');
  });

  it('/model selects by unique suffix and reports limits', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/model beta-fast');
    expect(result.ok).toBe(true);
    expect(app.activeModel()).toEqual({ providerId: 'test', modelId: 'vendor/beta-fast' });
    expect(result.output).toContain('Context window');
  });

  it('/model rejects unknown models with guidance', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/model nothing-here');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('/models refresh');
  });

  it('/model reports ambiguity with candidates', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: {
        test: [
          { id: 'vendor-a/shared', displayName: 'A' },
          { id: 'vendor-b/shared', displayName: 'B' },
        ],
      },
    });
    const result = await run(registryFor(app), '/model shared');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Multiple models match');
    expect(result.error).toContain('vendor-a/shared');
  });

  it('/models info shows capabilities and pricing', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/models info vendor/alpha-model');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('128000 tokens');
    expect(result.output).toContain('$1.5/M');
    expect(result.output).toContain('reasoning');
  });

  it('/models info explains missing catalog entries', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/models info test/brand/new-model');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('capabilities unknown');
  });

  it('/models provider lists only that provider', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/models provider test');
    expect(result.output).toContain('vendor/alpha-model');
    expect(result.output).toContain('vendor/beta-fast');
  });

  it('/models refresh reports discovered models', async () => {
    const { fetchImpl } = mockFetch([
      jsonResponse({ data: [{ id: 'vendor/gamma', context_length: 64000 }] }),
    ]);
    const { app, credentials } = makeModelApp(fetchImpl);
    await credentials.set('TEST_API_KEY', 'key');
    const result = await run(registryFor(app), '/models refresh test');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('1 model(s) discovered');
  });

  it('/models refresh reports failures honestly', async () => {
    const { fetchImpl } = mockFetch([errorResponse(500, { error: { message: 'boom' } })]);
    const { app, credentials } = makeModelApp(fetchImpl);
    await credentials.set('TEST_API_KEY', 'key');
    const result = await run(registryFor(app), '/models refresh test');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('FAILED');
    expect(result.output).toContain('cached model(s)');
  });

  it('rejects unknown subcommands', async () => {
    const { app } = makeModelApp();
    const result = await run(registryFor(app), '/models wat');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Usage: /models');
  });
});

describe('provider commands', () => {
  it('/provider list shows configured providers', async () => {
    const { app, credentials } = createTestApp({ providers: [testProvider()] });
    await credentials.set('TEST_API_KEY', 'abcdef123456');

    const result = await run(registryFor(app), '/provider list');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('test');
    expect(result.output).toContain('https://test.example.com/v1');
  });

  it('/provider with no providers explains how to add one', async () => {
    const { app } = createTestApp();
    const result = await run(registryFor(app), '/provider');
    expect(result.output).toContain('/connect');
  });

  it('/auth reports credential status without revealing secrets', async () => {
    const { app, credentials } = createTestApp({ providers: [testProvider()] });
    await credentials.set('TEST_API_KEY', 'super-secret-key-1234');

    const result = await run(registryFor(app), '/auth');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('TEST_API_KEY');
    expect(result.output).not.toContain('super-secret-key-1234');
    expect(result.output).toContain('1234'); // last 4 chars are allowed
  });

  it('/provider status validates credentials and shows model cache state', async () => {
    const { fetchImpl } = mockFetch([jsonResponse({ data: [] })]);
    const { app, credentials } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');

    const result = await run(registryFor(app), '/provider status');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('healthy');
    expect(result.output).toContain('models: 2 known');
  });

  it('/provider status reports failures', async () => {
    const { fetchImpl } = mockFetch([errorResponse(401, { error: { message: 'nope' } })]);
    const { app, credentials } = createTestApp({ providers: [testProvider()], fetchImpl });
    await credentials.set('TEST_API_KEY', 'bad');

    const result = await run(registryFor(app), '/provider status');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('unavailable');
  });

  it('/connect via command flags validates and saves', async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ data: [] }), // validation
      jsonResponse({ data: [{ id: 'local/model' }] }), // refresh
    ]);
    const { app, credentials } = createTestApp({ fetchImpl });

    const result = await run(
      registryFor(app),
      '/connect openai-compatible --id local --base-url http://localhost:8080/v1 --api-key secret-1',
    );

    expect(result.ok).toBe(true);
    expect(app.getProviderConfig('local')?.baseUrl).toBe('http://localhost:8080/v1');
    expect(credentials.peek('LOCAL_API_KEY')).toBe('secret-1');
    expect(calls[0]?.url).toContain('/v1/models');
  });

  it('/connect without arguments requests the wizard in the TUI', async () => {
    const { app } = createTestApp();
    const result = await run(registryFor(app), '/connect');
    expect(result.action?.type).toBe('open-connect-wizard');
  });

  it('/connect rejects unknown targets', async () => {
    const { app } = createTestApp();
    const result = await run(registryFor(app), '/connect mystery');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Provider types');
  });

  it('/connect re-enables a disabled provider', async () => {
    const { fetchImpl } = mockFetch([
      jsonResponse({ data: [] }), // validation
      jsonResponse({ data: [{ id: 'vendor/x' }] }), // refresh
    ]);
    const { app, credentials } = createTestApp({
      providers: [testProvider({ enabled: false })],
      fetchImpl,
    });
    await credentials.set('TEST_API_KEY', 'key');

    const result = await run(registryFor(app), '/connect test');
    expect(result.ok).toBe(true);
    expect(app.getProviderConfig('test')?.enabled).toBe(true);
  });

  it('/disconnect disables and /disconnect --forget requires confirmation', async () => {
    const { app, credentials } = createTestApp({ providers: [testProvider()] });
    await credentials.set('TEST_API_KEY', 'key');
    const registry = registryFor(app);

    const disabled = await run(registry, '/disconnect test');
    expect(disabled.ok).toBe(true);
    expect(app.getProviderConfig('test')?.enabled).toBe(false);

    const needsConfirm = await run(registry, '/disconnect test --forget');
    expect(needsConfirm.ok).toBe(true);
    expect(needsConfirm.output).toContain('--forget --yes');
    expect(app.getProviderConfig('test')).toBeDefined(); // not removed yet

    const removed = await run(registry, '/disconnect test --forget --yes');
    expect(removed.ok).toBe(true);
    expect(app.getProviderConfig('test')).toBeUndefined();
    expect(credentials.peek('TEST_API_KEY')).toBeUndefined();
  });
});

describe('session commands', () => {
  it('/session shows the current session', async () => {
    const { app } = createTestApp();
    const result = await run(registryFor(app), '/session');
    expect(result.output).toContain(app.session.id);
    expect(result.output).toContain('Current session');
  });

  it('/session new starts a session and keeps the previous one', async () => {
    const { app } = createTestApp();
    const first = app.session.id;
    const result = await run(registryFor(app), '/session new Refactor work');

    expect(result.ok).toBe(true);
    expect(app.session.id).not.toBe(first);
    expect(app.session.name).toBe('Refactor work');
    expect(app.sessionManager.load(first)).not.toBeNull();
  });

  it('/session list shows saved sessions with the current one marked', async () => {
    const { app } = createTestApp();
    await run(registryFor(app), '/session new Second');
    const result = await run(registryFor(app), '/session list');
    expect(result.output).toContain('Second');
    expect(result.output).toContain('*');
  });

  it('/session rename renames the active session', async () => {
    const { app } = createTestApp();
    await run(registryFor(app), '/session rename My new name');
    expect(app.session.name).toBe('My new name');
    expect(app.sessionManager.load(app.session.id)?.name).toBe('My new name');
  });

  it('/session switch accepts a unique id prefix and resets the view', async () => {
    const { app } = createTestApp();
    const first = app.session;
    await run(registryFor(app), '/session new Later');

    const prefix = first.id.slice(0, 8);
    const result = await run(registryFor(app), `/session switch ${prefix}`);
    expect(result.ok).toBe(true);
    expect(app.session.id).toBe(first.id);
    expect(result.action?.type).toBe('clear-conversation');
  });

  it('/session switch reports missing sessions', async () => {
    const { app } = createTestApp();
    const result = await run(registryFor(app), '/session switch does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('/session export writes a JSON file without secrets', async () => {
    const { app, dir } = createTestApp();
    const target = join(dir, 'export.json');
    const result = await run(registryFor(app), `/session export ${target}`);

    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as { session: { id: string } };
    expect(parsed.session.id).toBe(app.session.id);
  });

  it('/session delete protects the active session and requires --yes for others', async () => {
    const { app } = createTestApp();
    const first = app.session;
    await run(registryFor(app), '/session new Other');
    const registry = registryFor(app);

    const active = await run(registry, `/session delete ${app.session.id}`);
    expect(active.ok).toBe(false);
    expect(active.error).toContain('Cannot delete the active session');

    const needsConfirm = await run(registry, `/session delete ${first.id.slice(0, 8)}`);
    expect(needsConfirm.ok).toBe(true);
    expect(needsConfirm.output).toContain('--yes');

    const deleted = await run(registry, `/session delete ${first.id.slice(0, 8)} --yes`);
    expect(deleted.ok).toBe(true);
    expect(app.sessionManager.load(first.id)).toBeNull();
  });

  it('/resume without arguments requests the session picker', async () => {
    const { app } = createTestApp();
    const result = await run(registryFor(app), '/resume');
    expect(result.action?.type).toBe('open-session-picker');
  });

  it('/search finds sessions by message content', async () => {
    const { app } = createTestApp();
    app.session.messages.push({
      id: 'm1',
      role: 'user',
      content: 'investigate the flaky integration test',
      timestamp: new Date().toISOString(),
    });
    app.saveSession();

    const result = await run(registryFor(app), '/search flaky');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('flaky');
  });

  it('/usage reports the local estimate', async () => {
    const { app } = createTestApp();
    app.recordUsage('n/a', 'n/a', { inputTokens: 100, outputTokens: 50 });
    const result = await run(registryFor(app), '/usage');
    expect(result.output).toContain('100');
    expect(result.output).toContain('LOCAL ESTIMATE');
  });

  it('/budget shows limits and estimated spend', async () => {
    const { app } = createTestApp({
      configOverrides: {
        spendingLimits: { maxDaily: 5, currency: 'USD', unknownBalancePolicy: 'confirm' },
      },
    });
    app.recordUsage('n/a', 'n/a', { inputTokens: 1000, outputTokens: 100 });
    app.saveSession();

    const result = await run(registryFor(app), '/budget');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('$5.0000');
    expect(result.output).toContain('Remaining today');
  });
});
