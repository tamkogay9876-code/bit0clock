import { describe, expect, it } from 'bun:test';
import { CommandRegistry } from './registry.js';
import { parseInput } from './parser.js';
import type { CommandDefinition } from './types.js';

function makeDefinition(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name: 'test',
    category: 'general',
    description: 'A test command',
    usage: '/test',
    handler: () => ({ ok: true, output: 'ran' }),
    ...overrides,
  };
}

describe('CommandRegistry registration', () => {
  it('registers and finds commands by name', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition());
    expect(registry.find('test')?.definition.name).toBe('test');
  });

  it('finds commands case-insensitively', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition());
    expect(registry.find('TEST')?.definition.name).toBe('test');
  });

  it('finds commands by alias', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ aliases: ['t', 'tst'] }));
    expect(registry.find('t')?.matchType).toBe('alias');
    expect(registry.find('t')?.definition.name).toBe('test');
  });

  it('rejects duplicate names', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition());
    expect(() => registry.register(makeDefinition())).toThrow(/Duplicate command name/);
  });

  it('rejects an alias that collides with an existing name', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'alpha' }));
    expect(() => registry.register(makeDefinition({ name: 'beta', aliases: ['alpha'] }))).toThrow(
      /Duplicate command alias/,
    );
  });

  it('rejects an alias that collides with an existing alias', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'alpha', aliases: ['a'] }));
    expect(() => registry.register(makeDefinition({ name: 'beta', aliases: ['a'] }))).toThrow(
      /Duplicate command alias/,
    );
  });

  it('hides hidden commands from visible() but still dispatches them', async () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'secret', hidden: true }));
    expect(registry.visible().some((d) => d.name === 'secret')).toBe(false);
    expect(registry.has('secret')).toBe(true);
  });
});

describe('CommandRegistry suggestions and completions', () => {
  it('suggests the closest command for a typo', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'models' }));
    const suggestions = registry.suggest('moels');
    expect(suggestions).toContain('models');
  });

  it('returns no suggestions for unrelated input', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'models' }));
    expect(registry.suggest('zzzzzzzz')).toEqual([]);
  });

  it('completes command names by prefix', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'think', aliases: ['thinking'] }));
    registry.register(makeDefinition({ name: 'temperature' }));
    registry.register(makeDefinition({ name: 'status' }));

    const completions = registry.completions('th');
    expect(completions).toEqual(['think']);
  });

  it('completes from aliases too but returns canonical names', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'think', aliases: ['thinking'] }));
    expect(registry.completions('thinking')).toEqual(['think']);
  });

  it('lists all visible commands for an empty prefix', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'alpha' }));
    registry.register(makeDefinition({ name: 'beta', hidden: true }));
    expect(registry.completions('')).toEqual(['alpha']);
  });
});

describe('CommandRegistry dispatch', () => {
  it('returns null for conversational input', async () => {
    const registry = new CommandRegistry();
    expect(await registry.dispatch(parseInput('hello'))).toBeNull();
  });

  it('executes a command and returns its result', async () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition());
    const result = await registry.dispatch(parseInput('/test'));
    expect(result).toEqual({ ok: true, output: 'ran' });
  });

  it('passes parsed arguments and flags to the handler', async () => {
    const registry = new CommandRegistry();
    let captured: { args: string[]; flags: Record<string, string | true> } | null = null;
    registry.register(
      makeDefinition({
        handler: (ctx) => {
          captured = { args: ctx.args, flags: ctx.flags };
          return { ok: true };
        },
      }),
    );
    await registry.dispatch(parseInput('/test one two --flag --k=v'));
    expect(captured).toEqual({ args: ['one', 'two'], flags: { flag: true, k: 'v' } });
  });

  it('suggests alternatives for unknown commands and never executes them', async () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'models' }));
    const result = await registry.dispatch(parseInput('/moels'));
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('Unknown command: /moels');
    expect(result?.error).toContain('/models');
    expect(result?.error).toContain('//');
  });

  it('captures handler errors as structured results', async () => {
    const registry = new CommandRegistry();
    registry.register(
      makeDefinition({
        handler: () => {
          throw new Error('boom');
        },
      }),
    );
    const result = await registry.dispatch(parseInput('/test'));
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('Command /test failed');
    expect(result?.error).toContain('boom');
  });

  it('blocks commands unavailable during generation', async () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition());
    const result = await registry.dispatch(parseInput('/test'), { generationActive: true });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('not available while a response is generating');
  });

  it('allows explicitly available commands during generation', async () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ availableDuringGeneration: true }));
    const result = await registry.dispatch(parseInput('/test'), { generationActive: true });
    expect(result?.ok).toBe(true);
  });
});

describe('CommandRegistry help', () => {
  it('lists commands grouped by category', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'models', category: 'models', usage: '/models' }));
    registry.register(makeDefinition({ name: 'help', category: 'general', usage: '/help' }));

    const help = registry.help();
    expect(help).toContain('General:');
    expect(help).toContain('Models:');
    expect(help).toContain('/models');
  });

  it('shows detailed help with usage, subcommands, and examples', () => {
    const registry = new CommandRegistry();
    registry.register(
      makeDefinition({
        name: 'think',
        aliases: ['thinking'],
        usage: '/think [level]',
        subcommands: [{ name: 'budget', description: 'Set the budget' }],
        examples: ['/think high'],
      }),
    );

    const help = registry.help('think');
    expect(help).toContain('/think [level]');
    expect(help).toContain('aliases: /thinking');
    expect(help).toContain('budget');
    expect(help).toContain('/think high');
  });

  it('suggests alternatives for unknown help topics', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'models' }));
    const help = registry.help('moels');
    expect(help).toContain('Unknown command');
    expect(help).toContain('/models');
  });

  it('does not include hidden commands', () => {
    const registry = new CommandRegistry();
    registry.register(makeDefinition({ name: 'visible', usage: '/visible' }));
    registry.register(makeDefinition({ name: 'ghost', usage: '/ghost', hidden: true }));
    const help = registry.help();
    expect(help).toContain('/visible');
    expect(help).not.toContain('/ghost');
  });
});
