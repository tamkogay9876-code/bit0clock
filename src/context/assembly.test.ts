/**
 * Context assembly pipeline tests (§25).
 */

import { describe, expect, test } from 'bun:test';
import {
  assembleContext,
  CONTEXT_PRECEDENCE_RULES,
  CONTEXT_PRIORITY,
  describeAssembly,
  includedItems,
  type ContextCandidate,
} from './assembly.js';

function candidate(
  overrides: Partial<ContextCandidate> & Pick<ContextCandidate, 'id' | 'type'>,
): ContextCandidate {
  return {
    label: overrides.id,
    provenance: 'test fixture',
    content: 'x'.repeat(40), // 10 tokens
    trust: 'lower-trust',
    ...overrides,
  };
}

describe('assembleContext', () => {
  test('orders items by documented priority', () => {
    const assembly = assembleContext(
      [
        candidate({ id: 'conv', type: 'conversation', trust: 'user' }),
        candidate({ id: 'sys', type: 'system', trust: 'system', mandatory: true }),
        candidate({ id: 'src', type: 'source' }),
        candidate({ id: 'proj', type: 'project-instruction', mandatory: true }),
      ],
      { effectiveBudget: 1000 },
    );
    expect(assembly.items.map((item) => item.id)).toEqual(['sys', 'proj', 'conv', 'src']);
  });

  test('mandatory items are included even when over budget', () => {
    const assembly = assembleContext(
      [
        candidate({
          id: 'sys',
          type: 'system',
          trust: 'system',
          mandatory: true,
          content: 'x'.repeat(400),
        }),
        candidate({ id: 'src', type: 'source' }),
      ],
      { effectiveBudget: 10 },
    );
    const sys = assembly.items.find((item) => item.id === 'sys')!;
    const src = assembly.items.find((item) => item.id === 'src')!;
    expect(sys.included).toBe(true);
    expect(src.included).toBe(false);
    expect(src.reason).toContain('excluded');
    expect(assembly.mandatoryTokens).toBe(100);
  });

  test('lower-priority items are dropped before higher-priority ones', () => {
    const assembly = assembleContext(
      [
        candidate({ id: 'conv', type: 'conversation', trust: 'user', content: 'x'.repeat(80) }), // 20 tokens
        candidate({ id: 'src', type: 'source', content: 'x'.repeat(80) }), // 20 tokens
      ],
      { effectiveBudget: 25 },
    );
    expect(assembly.items.find((item) => item.id === 'conv')!.included).toBe(true);
    expect(assembly.items.find((item) => item.id === 'src')!.included).toBe(false);
  });

  test('tracks included/dropped totals', () => {
    const assembly = assembleContext(
      [candidate({ id: 'a', type: 'conversation' }), candidate({ id: 'b', type: 'evidence' })],
      { effectiveBudget: 15 },
    );
    expect(assembly.includedTokens).toBe(10);
    expect(assembly.droppedTokens).toBe(10);
    expect(assembly.effectiveBudget).toBe(15);
  });

  test('precomputed token estimates are honored', () => {
    const assembly = assembleContext(
      [candidate({ id: 'a', type: 'conversation', tokens: 999, content: 'tiny' })],
      { effectiveBudget: 100 },
    );
    expect(assembly.items[0]!.tokens).toBe(999);
    expect(assembly.items[0]!.included).toBe(false);
  });

  test('priority table covers all documented levels in order', () => {
    const values = Object.values(CONTEXT_PRIORITY);
    expect(values).toEqual([1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('precedence rules state that untrusted content cannot override policy', () => {
    expect(CONTEXT_PRECEDENCE_RULES.join(' ')).toContain('never override system rules');
  });

  test('includedItems filters the assembly', () => {
    const assembly = assembleContext(
      [
        candidate({ id: 'a', type: 'conversation' }),
        candidate({ id: 'b', type: 'evidence', content: 'x'.repeat(400) }),
      ],
      { effectiveBudget: 15 },
    );
    expect(includedItems(assembly).map((item) => item.id)).toEqual(['a']);
  });

  test('describeAssembly renders provenance-first lines', () => {
    const assembly = assembleContext(
      [
        candidate({
          id: 'conv',
          type: 'conversation',
          trust: 'user',
          label: 'conversation: 3 messages',
        }),
      ],
      { effectiveBudget: 100 },
    );
    const lines = describeAssembly(assembly);
    expect(lines[0]).toContain('assembled: 1 item(s)');
    expect(lines[1]).toContain('p6');
    expect(lines[1]).toContain('conversation: 3 messages');
    expect(lines[1]).toContain('tokens');
  });

  test('describeAssembly truncates long item lists', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: `m${i}`, type: 'conversation' }),
    );
    const assembly = assembleContext(items, { effectiveBudget: 1000 });
    const lines = describeAssembly(assembly, { maxItems: 5 });
    expect(lines.some((line) => line.includes('and 15 more included'))).toBe(true);
  });
});
