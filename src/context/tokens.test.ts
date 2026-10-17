/**
 * Token estimation and calibration tests (§28).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CalibrationStore,
  estimateMessageTokens,
  estimateRequestInputTokens,
  estimateTextTokens,
  estimateToolSchemaTokens,
} from './tokens.js';
import type { InternalMessage, ToolSchema } from '../providers/types.js';

describe('estimateTextTokens', () => {
  test('empty text is 0', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  test('uses a documented characters/4 heuristic', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('x'.repeat(400))).toBe(100);
    expect(estimateTextTokens('abcde')).toBe(2); // ceil(5/4)
  });
});

describe('estimateMessageTokens', () => {
  test('adds framing overhead to content', () => {
    const message: InternalMessage = { role: 'user', content: 'x'.repeat(40) };
    expect(estimateMessageTokens(message)).toBe(4 + 10);
  });

  test('counts tool call names and arguments', () => {
    const withCall: InternalMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts', startLine: 1 } }],
    };
    const withoutCall: InternalMessage = { role: 'assistant', content: '' };
    expect(estimateMessageTokens(withCall)).toBeGreaterThan(estimateMessageTokens(withoutCall));
  });

  test('counts tool results', () => {
    const withResult: InternalMessage = {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: 'c1', content: 'y'.repeat(80) }],
    };
    expect(estimateMessageTokens(withResult)).toBe(4 + 4 + 20);
  });

  test('images get a conservative fixed allowance', () => {
    const message: InternalMessage = {
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', base64: 'short' }],
    };
    expect(estimateMessageTokens(message)).toBe(4 + 1600);
  });
});

describe('estimateToolSchemaTokens', () => {
  test('grows with schema size', () => {
    const small: ToolSchema[] = [
      { name: 'a', description: 'does a', inputSchema: { type: 'object' } },
    ];
    const large: ToolSchema[] = [
      {
        name: 'a',
        description: 'does a',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'string', description: 'z'.repeat(400) } },
        },
      },
    ];
    expect(estimateToolSchemaTokens(small)).toBeGreaterThan(0);
    expect(estimateToolSchemaTokens(large)).toBeGreaterThan(estimateToolSchemaTokens(small));
  });
});

describe('estimateRequestInputTokens', () => {
  test('sums system, messages, and tools', () => {
    const request = {
      system: 'x'.repeat(40),
      messages: [{ role: 'user' as const, content: 'y'.repeat(40) }],
      tools: [{ name: 'a', description: 'b', inputSchema: {} }],
    };
    const withoutTools = estimateRequestInputTokens({
      system: request.system,
      messages: request.messages,
    });
    const withTools = estimateRequestInputTokens(request);
    expect(withTools).toBeGreaterThan(withoutTools);
    expect(withoutTools).toBe(4 + 10 + 4 + 10);
  });

  test('empty request is 0', () => {
    expect(estimateRequestInputTokens({ messages: [] })).toBe(0);
  });
});

describe('CalibrationStore', () => {
  test('no samples → local heuristic estimate labeled approximate', () => {
    const store = new CalibrationStore({ persist: false });
    const estimate = store.apply('p', 'm', 100);
    expect(estimate.tokens).toBe(100);
    expect(estimate.source).toBe('local-heuristic');
    expect(estimate.approximate).toBe(true);
    expect(estimate.note).toContain('approximate');
  });

  test('records samples and applies the median ratio', () => {
    const store = new CalibrationStore({ persist: false });
    store.record('p', 'm', 100, 150);
    store.record('p', 'm', 100, 200);
    store.record('p', 'm', 100, 250);
    const factor = store.factorFor('p', 'm');
    expect(factor).not.toBeNull();
    expect(factor!.factor).toBeCloseTo(2, 5);
    expect(factor!.samples).toBe(3);

    const estimate = store.apply('p', 'm', 100);
    expect(estimate.tokens).toBe(200);
    expect(estimate.source).toBe('calibrated-local');
    expect(estimate.approximate).toBe(true);
    expect(estimate.note).toContain('not a guarantee');
  });

  test('clamps extreme ratios', () => {
    const store = new CalibrationStore({ persist: false });
    store.record('p', 'm', 1, 1000); // ratio 1000 → clamped to 3
    expect(store.factorFor('p', 'm')!.factor).toBe(3);
    expect(store.apply('p', 'm', 10).tokens).toBe(30);
  });

  test('ignores invalid values', () => {
    const store = new CalibrationStore({ persist: false });
    store.record('p', 'm', 0, 5);
    store.record('p', 'm', 5, 0);
    store.record('p', 'm', Number.NaN, 5);
    expect(store.factorFor('p', 'm')).toBeNull();
  });

  test('keeps only the last N samples', () => {
    const store = new CalibrationStore({ persist: false, maxSamplesPerModel: 3 });
    for (let i = 0; i < 6; i++) store.record('p', 'm', 100, 100 + i * 10);
    expect(store.factorFor('p', 'm')!.samples).toBe(3);
  });

  test('describe explains the state without claiming precision', () => {
    const store = new CalibrationStore({ persist: false });
    expect(store.describe('p', 'm')).toContain('no calibration samples');
    store.record('p', 'm', 100, 120);
    const description = store.describe('p', 'm');
    expect(description).toContain('factor');
    expect(description).toContain('1 sample');
  });

  test('clear removes samples', () => {
    const store = new CalibrationStore({ persist: false });
    store.record('p', 'm', 100, 120);
    store.clear('p', 'm');
    expect(store.factorFor('p', 'm')).toBeNull();
  });

  test('persists atomically and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-cal-'));
    const path = join(dir, 'calibration.json');
    const first = new CalibrationStore({ path });
    first.record('p', 'm', 100, 140);

    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version: number };
    expect(parsed.version).toBe(1);

    const second = new CalibrationStore({ path });
    expect(second.factorFor('p', 'm')!.factor).toBeCloseTo(1.4, 5);
  });

  test('corrupted calibration file starts fresh instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-cal-'));
    const path = join(dir, 'calibration.json');
    writeFileSync(path, 'not json');
    const store = new CalibrationStore({ path });
    expect(store.factorFor('p', 'm')).toBeNull();
  });
});
