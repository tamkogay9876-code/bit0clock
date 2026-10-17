/**
 * Pricing and cost-estimation tests (§29).
 *
 * Prices only ever come from the catalog snapshot; unknown components are
 * reported and never silently zero-costed.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelPricing } from '../types/index.js';
import { describePricing, estimateRequestCost, estimateUsageCost } from './pricing.js';

const pricing: ModelPricing = {
  inputPerMillion: 2,
  outputPerMillion: 8,
  cachedInputPerMillion: 0.5,
  currency: 'USD',
  source: 'test snapshot',
  updatedAt: '2026-01-01T00:00:00.000Z',
  confidence: 'high',
};

describe('estimateUsageCost', () => {
  test('prices input, cached input, and output separately', () => {
    const estimate = estimateUsageCost(pricing, {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
    });
    // 800k billable input × 2/M + 200k cached × 0.5/M + 100k output × 8/M
    expect(estimate.cost).toBeCloseTo(1.6 + 0.1 + 0.8, 10);
    expect(estimate.currency).toBe('USD');
    expect(estimate.unknownComponents).toEqual([]);
    expect(estimate.note).toContain('local estimate');
    expect(estimate.note).toContain('test snapshot');
  });

  test('missing pricing → no cost, both components unknown, message says so', () => {
    const estimate = estimateUsageCost(undefined, { inputTokens: 1000 });
    expect(estimate.cost).toBeUndefined();
    expect(estimate.unknownComponents).toEqual(['input price', 'output price']);
    expect(estimate.note).toContain('cannot be estimated');
  });

  test('cached tokens without a cache price are charged at the input rate, not zero', () => {
    const noCache: ModelPricing = { ...pricing, cachedInputPerMillion: undefined };
    const estimate = estimateUsageCost(noCache, {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
    });
    expect(estimate.cost).toBeCloseTo(1.0 + 0.5 * 2, 10);
    expect(estimate.unknownComponents.join(' ')).toContain('cached-input price');
  });

  test('output without an output price is flagged, not zero-costed silently', () => {
    const noOutput: ModelPricing = { ...pricing, outputPerMillion: undefined };
    const estimate = estimateUsageCost(noOutput, { inputTokens: 1_000_000, outputTokens: 1000 });
    expect(estimate.cost).toBeCloseTo(2, 10);
    expect(estimate.unknownComponents.join(' ')).toContain('output price');
    expect(estimate.note).toContain('unknown component');
  });

  test('reasoning tokens with no reasoning price are not double-charged when output price exists', () => {
    const estimate = estimateUsageCost(pricing, { outputTokens: 1000, reasoningTokens: 500 });
    expect(estimate.cost).toBeCloseTo((1000 / 1_000_000) * 8, 10);
    expect(estimate.unknownComponents).toEqual([]);
  });

  test('reasoning tokens with a reasoning price are charged at that price', () => {
    const withReasoning: ModelPricing = { ...pricing, reasoningPerMillion: 4 };
    const estimate = estimateUsageCost(withReasoning, {
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    expect(estimate.cost).toBeCloseTo(4, 10);
  });

  test('input price present but zero tokens still returns a defined zero cost', () => {
    const estimate = estimateUsageCost(pricing, {});
    expect(estimate.cost).toBe(0);
  });
});

describe('estimateRequestCost', () => {
  test('assumes the full output reserve is used (worst case)', () => {
    const estimate = estimateRequestCost(pricing, 1_000_000, 100_000);
    expect(estimate.cost).toBeCloseTo(2 + 0.8, 10);
    expect(estimate.note).toContain('worst case');
    expect(estimate.note).toContain('100000');
  });

  test('no output price but a reserve → the reserve is listed as unknown', () => {
    const noOutput: ModelPricing = { ...pricing, outputPerMillion: undefined };
    const estimate = estimateRequestCost(noOutput, 1_000_000, 8000);
    expect(estimate.unknownComponents.join(' ')).toContain('reserved output');
  });

  test('zero reserve does not add an output component', () => {
    const estimate = estimateRequestCost(pricing, 1_000_000, 0);
    expect(estimate.cost).toBeCloseTo(2, 10);
  });

  test('no pricing at all → unknown with explanation', () => {
    const estimate = estimateRequestCost(undefined, 1000, 8000);
    expect(estimate.cost).toBeUndefined();
    expect(estimate.note).toContain('cannot be estimated');
  });
});

describe('describePricing', () => {
  test('unknown pricing is stated plainly', () => {
    const lines = describePricing(undefined);
    expect(lines.join('\n')).toContain('Pricing: unknown');
    expect(lines.join('\n')).toContain('check the provider dashboard');
  });

  test('snapshot fields are rendered with their provenance', () => {
    const lines = describePricing(pricing).join('\n');
    expect(lines).toContain('2 USD/M tokens');
    expect(lines).toContain('8 USD/M tokens');
    expect(lines).toContain('0.5 USD/M tokens');
    expect(lines).toContain('test snapshot');
    expect(lines).toContain('confidence     high');
  });

  test('missing individual prices show unknown, not zero', () => {
    const partial: ModelPricing = { ...pricing, inputPerMillion: undefined };
    const lines = describePricing(partial).join('\n');
    expect(lines).toContain('input          unknown');
  });
});
