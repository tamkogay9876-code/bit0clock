/**
 * Effective context budget tests (§23).
 */

import { describe, expect, test } from 'bun:test';
import { ARCHITECTURAL_MAX_CONTEXT, budgetReport, computeEffectiveBudget } from './budget.js';

const base = {
  requestedTokens: 128000,
  origin: 'profile' as const,
  reservedOutputTokens: 8000,
  safetyMargin: 4000,
  estimatedInputTokens: 0,
};

describe('computeEffectiveBudget', () => {
  test('uses the strictest limit (model window)', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 500000,
      modelContextLimit: 128000,
      modelCapability: {
        label: 'p/m reported context window',
        source: 'provider-api',
        verified: true,
      },
    });
    expect(budget.effectiveBudget).toBe(128000 - 8000 - 4000);
    expect(budget.modelContextLimit).toBe(128000);
    expect(budget.capability.verified).toBe(true);
    expect(budget.notes.join(' ')).toContain('exceeds the strictest applicable limit');
  });

  test('provider input limit can be stricter than the model window', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 500000,
      modelContextLimit: 200000,
      providerInputLimit: 100000,
    });
    expect(budget.effectiveBudget).toBe(100000 - 12000);
    expect(budget.providerInputLimit).toBe(100000);
  });

  test('requested budget smaller than the model window wins', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 32000,
      modelContextLimit: 128000,
    });
    expect(budget.effectiveBudget).toBe(32000 - 12000);
  });

  test('no reliable limits → conservative fallback, labeled unverified', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 0,
      origin: 'auto',
    });
    expect(budget.effectiveBudget).toBe(32000 - 12000);
    expect(budget.capability.source).toBe('fallback');
    expect(budget.capability.verified).toBe(false);
    expect(budget.notes.join(' ')).toContain('conservative fallback');
    expect(budget.notes.join(' ')).toContain('unverified');
  });

  test('customizable fallback limit', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 0,
      origin: 'auto',
      fallbackLimit: 8000,
    });
    expect(budget.effectiveBudget).toBe(0); // clamps to 0, never negative
  });

  test('architectural cap of 5,000,000 tokens still applies', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 99_000_000,
      reservedOutputTokens: 0,
      safetyMargin: 0,
      modelContextLimit: 50_000_000,
    });
    expect(budget.effectiveBudget).toBe(ARCHITECTURAL_MAX_CONTEXT);
  });

  test('remaining headroom is negative when the estimate exceeds the budget', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 10000,
      reservedOutputTokens: 0,
      safetyMargin: 0,
      estimatedInputTokens: 20000,
    });
    expect(budget.effectiveBudget).toBe(10000);
    expect(budget.remainingHeadroom).toBe(-10000);
  });

  test('reported but unverified capability is labeled', () => {
    const budget = computeEffectiveBudget({
      ...base,
      modelContextLimit: 128000,
      modelCapability: { label: 'p/m reported context window', source: 'cached', verified: false },
    });
    expect(budget.capability.verified).toBe(false);
    expect(budget.notes.join(' ')).toContain('verified live call yet');
  });

  test('missing provider input limit is stated, not assumed', () => {
    const budget = computeEffectiveBudget({ ...base, modelContextLimit: 128000 });
    expect(budget.notes.join(' ')).toContain('No provider-specific input limit');
  });
});

describe('budgetReport', () => {
  test('exposes all nine values separately', () => {
    const budget = computeEffectiveBudget({
      ...base,
      modelContextLimit: 128000,
      estimatedInputTokens: 5000,
    });
    const { pairs } = budgetReport(budget);
    expect(pairs).toHaveLength(9);
    const labels = pairs.map(([label]) => label);
    expect(labels).toEqual([
      'requested budget',
      'model context limit',
      'provider input limit',
      'reserved output capacity',
      'safety margin',
      'estimated input tokens',
      'effective request budget',
      'remaining headroom',
      'capability source',
    ]);
    const byLabel = new Map(pairs);
    expect(byLabel.get('model context limit')).toBe('128000 tokens');
    expect(byLabel.get('provider input limit')).toBe('unknown (not documented/configured)');
    expect(byLabel.get('estimated input tokens')).toBe('5000 tokens');
  });

  test('auto origin is displayed as runtime-determined', () => {
    const budget = computeEffectiveBudget({ ...base, requestedTokens: 32000, origin: 'auto' });
    const { pairs } = budgetReport(budget);
    expect(new Map(pairs).get('requested budget')).toBe('auto (runtime-determined)');
  });

  test('over-budget headroom is explicit', () => {
    const budget = computeEffectiveBudget({
      ...base,
      requestedTokens: 10000,
      reservedOutputTokens: 0,
      safetyMargin: 0,
      estimatedInputTokens: 12000,
    });
    const { pairs } = budgetReport(budget);
    expect(new Map(pairs).get('remaining headroom')).toBe('OVER by 2000 tokens');
  });
});
