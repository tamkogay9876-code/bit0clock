/**
 * Built-in command tests — system, modes, reasoning, context.
 */

import { describe, expect, it } from 'bun:test';
import { CommandRegistry } from '../registry.js';
import { registerBuiltinCommands } from './index.js';
import { parseInput } from '../parser.js';
import type { CommandResult } from '../types.js';
import { createTestApp, seedModels, testProvider } from '../../app/test-utils.js';
import type { AppState } from '../../app/state.js';

function makeApp(seed = false) {
  return createTestApp({
    providers: [testProvider()],
    ...(seed ? { catalog: { test: seedModels() } } : {}),
  });
}

function makeRegistry(app: AppState): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);
  return registry;
}

async function run(registry: CommandRegistry, input: string): Promise<CommandResult> {
  const result = await registry.dispatch(parseInput(input));
  if (!result) throw new Error(`Not a command: ${input}`);
  return result;
}

describe('system commands', () => {
  it('/help lists the registered commands', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/help');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('/think');
    expect(result.output).toContain('/models');
    expect(result.output).toContain('/connect');
  });

  it('/help <command> shows detailed help', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/help think');
    expect(result.output).toContain('/think');
    expect(result.output).toContain('budget');
  });

  it('/status reports session, model, and usage state', async () => {
    const { app } = makeApp(true);
    const result = await run(makeRegistry(app), '/status');
    expect(result.output).toContain(app.session.id);
    expect(result.output).toContain('not selected');
    expect(result.output).toContain('local estimate');
  });

  it('/status reflects the selected model and its context window', async () => {
    const { app } = makeApp(true);
    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(makeRegistry(app), '/status');
    expect(result.output).toContain('vendor/alpha-model');
    expect(result.output).toContain('128k tokens');
  });

  it('/doctor runs diagnostics', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/doctor');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Overall:');
    expect(result.output).toContain('Runtime');
  });

  it('/clear empties the conversation and requests a view reset', async () => {
    const { app } = makeApp();
    app.session.messages.push({
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });

    const result = await run(makeRegistry(app), '/clear');
    expect(result.ok).toBe(true);
    expect(result.action?.type).toBe('clear-conversation');
    expect(app.session.messages).toEqual([]);
  });

  it('/cancel requests cancellation', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/cancel');
    expect(result.action?.type).toBe('cancel-generation');
  });

  it('/exit requests exit', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/exit');
    expect(result.action?.type).toBe('exit');
  });

  it('aliases work (/quit)', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/quit');
    expect(result.action?.type).toBe('exit');
  });

  it('unknown commands suggest alternatives', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/stat');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('/status');
  });
});

describe('mode commands', () => {
  it('/mode lists modes with the active one marked', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/mode');
    expect(result.output).toContain('build');
    expect(result.output).toContain('plan');
    expect(result.output).toContain('review');
  });

  it('/mode plan switches and explains read-only behavior', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/mode plan');
    expect(result.ok).toBe(true);
    expect(app.session.mode).toBe('plan');
    expect(result.output).toContain('read-only');
  });

  it('rejects unknown modes', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/mode turbo');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('plan, build, review');
  });
});

describe('reasoning commands', () => {
  it('/think sets the effort level', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/think high');
    expect(result.ok).toBe(true);
    expect(app.session.reasoning.effort).toBe('high');
  });

  it('/thinking and /thinks are aliases', async () => {
    const { app } = makeApp();
    const registry = makeRegistry(app);
    await run(registry, '/thinking low');
    expect(app.session.reasoning.effort).toBe('low');
    await run(registry, '/thinks max');
    expect(app.session.reasoning.effort).toBe('max');
  });

  it('rejects unknown levels', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/think turbo');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('off, low, medium, high, max, auto');
  });

  it('/think budget sets and clears the budget', async () => {
    const { app } = makeApp();
    const registry = makeRegistry(app);

    const set = await run(registry, '/think budget 4096');
    expect(set.ok).toBe(true);
    expect(app.session.reasoning.budgetTokens).toBe(4096);

    const cleared = await run(registry, '/think budget off');
    expect(cleared.ok).toBe(true);
    expect(app.session.reasoning.budgetTokens).toBeUndefined();
  });

  it('/think budget rejects invalid values', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/think budget abc');
    expect(result.ok).toBe(false);
  });

  it('warns when the model does not report the requested level', async () => {
    const { app } = makeApp(true);
    app.selectModel('test', 'vendor/alpha-model'); // levels: low, medium, high
    const result = await run(makeRegistry(app), '/think max');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('low, medium, high');
  });

  it('notes inactive reasoning for non-reasoning models', async () => {
    const { app } = makeApp(true);
    app.selectModel('test', 'vendor/beta-fast'); // reasoning: false
    const result = await run(makeRegistry(app), '/think high');
    expect(result.output).toContain('inactive');
  });

  it('/response sets the style', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/response concise');
    expect(result.ok).toBe(true);
    expect(app.session.responseStyle).toBe('concise');
  });

  it('/response rejects unknown styles', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/response verbose');
    expect(result.ok).toBe(false);
  });

  it('/temperature validates the range and supports default', async () => {
    const { app } = makeApp();
    const registry = makeRegistry(app);

    expect((await run(registry, '/temperature 0.3')).ok).toBe(true);
    expect(app.session.temperature).toBe(0.3);
    expect((await run(registry, '/temperature 3')).ok).toBe(false);
    expect((await run(registry, '/temperature default')).ok).toBe(true);
    expect(app.session.temperature).toBeUndefined();
  });

  it('/output-limit validates and warns beyond model maximum', async () => {
    const { app } = makeApp(true);
    app.selectModel('test', 'vendor/alpha-model'); // maxOutputTokens: 16000
    const registry = makeRegistry(app);

    const result = await run(registry, '/output-limit 32000');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('16000');
    expect((await run(registry, '/output-limit nonsense')).ok).toBe(false);
  });
});

describe('context commands', () => {
  it('/context shows the current profile', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/context');
    expect(result.output).toContain('standard');
  });

  it('/context profile lists all profiles', async () => {
    const { app } = makeApp();
    const result = await run(makeRegistry(app), '/context profile');
    expect(result.output).toContain('small');
    expect(result.output).toContain('5m');
    expect(result.output).toContain('auto');
  });

  it('/context <profile> sets the profile and clears an override', async () => {
    const { app } = makeApp();
    const registry = makeRegistry(app);
    await run(registry, '/context 256k');
    expect(app.session.requestedContext).toBe(256_000);

    const result = await run(registry, '/context small');
    expect(result.ok).toBe(true);
    expect(app.session.contextProfile).toBe('small');
    expect(app.session.requestedContext).toBeUndefined();
  });

  it('/context <tokens> warns when it exceeds the model window', async () => {
    const { app } = makeApp(true);
    app.selectModel('test', 'vendor/alpha-model'); // 128k window
    const result = await run(makeRegistry(app), '/context 256k');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Warning');
    expect(result.output).toContain('128k');
  });

  it('/context reset returns to the configured default', async () => {
    const { app } = makeApp();
    const registry = makeRegistry(app);
    await run(registry, '/context large');
    const result = await run(registry, '/context reset');
    expect(result.ok).toBe(true);
    expect(app.session.contextProfile).toBe('standard');
  });

  it('rejects unknown targets and tiny budgets', async () => {
    const { app } = makeApp();
    const registry = makeRegistry(app);
    expect((await run(registry, '/context mega')).ok).toBe(false);
    expect((await run(registry, '/context 200')).ok).toBe(false);
  });
});
