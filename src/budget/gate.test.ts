/**
 * Budget gate tests (§30).
 *
 * The gate only returns allow/confirm/block with explicit reasons. It never
 * fabricates a balance check and never silently changes the request.
 */

import { describe, expect, test } from 'bun:test';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import { defaultConfig } from '../config/schema.js';
import type { AppConfigInput } from '../config/schema.js';
import {
  evaluateBudgetGate,
  formatGateDecision,
  gateBlockedMessage,
  type BudgetGateInput,
} from './gate.js';

function gateApp(spendingLimits: Partial<AppConfigInput['spendingLimits']> = {}) {
  const { app } = createTestApp({
    providers: [testProvider()],
    catalog: { test: seedModels() },
    configOverrides: {
      spendingLimits: { ...defaultConfig.spendingLimits, ...spendingLimits },
    },
  });
  app.selectModel('test', 'vendor/alpha-model');
  return app;
}

const baseInput: BudgetGateInput = {
  estimatedInputTokens: 10_000,
  effectiveBudget: 116_000,
  reservedOutputTokens: 8_000,
  providerId: 'test',
  modelId: 'vendor/alpha-model',
  profileId: 'standard',
  requestedTokens: 128_000,
  modelContextLimit: 128_000,
};

describe('evaluateBudgetGate', () => {
  test('defaults allow a small request and report pricing as verified snapshot data', () => {
    const app = gateApp();
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('allow');
    expect(decision.reasons).toEqual([]);
    expect(decision.checks.find((c) => c.name === 'request size')!.status).toBe('ok');
    expect(decision.checks.find((c) => c.name === 'pricing snapshot')!.status).toBe('ok');
    expect(decision.estimate.estimatedCost).toBeCloseTo(
      (10_000 / 1e6) * 1.5 + (8_000 / 1e6) * 6,
      10,
    );
  });

  test('unknown pricing is stated, never invented', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: [{ id: 'vendor/no-pricing', contextLength: 32_000, tools: true }] },
    });
    app.selectModel('test', 'vendor/no-pricing');
    const decision = evaluateBudgetGate(app, { ...baseInput, modelId: 'vendor/no-pricing' });
    expect(decision.estimate.estimatedCost).toBeUndefined();
    expect(decision.checks.find((c) => c.name === 'pricing snapshot')!.status).toBe('unknown');
    expect(decision.action).toBe('allow');
  });

  test('estimated input above the effective budget blocks with no send', () => {
    const app = gateApp();
    const decision = evaluateBudgetGate(app, { ...baseInput, estimatedInputTokens: 200_000 });
    expect(decision.action).toBe('block');
    expect(decision.reasons.join(' ')).toContain('exceeds the effective budget');
    expect(decision.checks.find((c) => c.name === 'request size')!.status).toBe('blocked');
  });

  test('input above the model window blocks even when under the profile budget', () => {
    const app = gateApp();
    const decision = evaluateBudgetGate(app, {
      ...baseInput,
      estimatedInputTokens: 130_000,
      effectiveBudget: 500_000,
      modelContextLimit: 128_000,
    });
    expect(decision.action).toBe('block');
    expect(decision.reasons.join(' ')).toContain('model context window');
  });

  test('missing model window is unknown, not unlimited', () => {
    const app = gateApp();
    const decision = evaluateBudgetGate(app, {
      ...baseInput,
      modelContextLimit: undefined,
    });
    const check = decision.checks.find((c) => c.name === 'model context limit')!;
    expect(check.status).toBe('unknown');
    expect(check.detail).toContain('not unlimited');
  });

  test('provider input limit is applied when configured', () => {
    const app = gateApp();
    const blocked = evaluateBudgetGate(app, { ...baseInput, providerInputLimit: 5_000 });
    expect(blocked.action).toBe('block');
    expect(blocked.reasons.join(' ')).toContain('provider input limit');
    const ok = evaluateBudgetGate(app, { ...baseInput, providerInputLimit: 50_000 });
    expect(ok.action).toBe('allow');
  });

  test('large-context threshold raises confirm', () => {
    const app = gateApp({ largeContextConfirmationThreshold: 15_000 });
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('confirm');
    expect(decision.reasons.join(' ')).toContain('large-context confirmation threshold');
  });

  test('per-request cost limit blocks on the worst-case estimate', () => {
    const app = gateApp({ maxPerRequest: 0.01 });
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('block');
    expect(decision.reasons.join(' ')).toContain('maximum per request');
  });

  test('per-request limit with no pricing requires confirmation instead of guessing', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: [{ id: 'vendor/no-pricing', contextLength: 32_000, tools: true }] },
      configOverrides: {
        spendingLimits: { ...defaultConfig.spendingLimits, maxPerRequest: 1 },
      },
    });
    app.selectModel('test', 'vendor/no-pricing');
    const decision = evaluateBudgetGate(app, { ...baseInput, modelId: 'vendor/no-pricing' });
    expect(decision.action).toBe('confirm');
    expect(decision.reasons.join(' ')).toContain('no pricing snapshot');
  });

  test('daily limit considers local spend of other sessions', () => {
    const app = gateApp({ maxDaily: 5 });
    // Seed the previous-session spend directly (local estimate, as /usage shows)
    const other = app.sessionManager.create({ mode: 'build', contextProfile: 'standard' });
    other.usage.estimatedCost = 4;
    app.sessionManager.save(other);

    const decision = evaluateBudgetGate(app, {
      ...baseInput,
      estimatedInputTokens: 2_000_000, // ≈ $3.05 worst case with this pricing
    });
    expect(decision.action).toBe('block');
    expect(decision.reasons.join(' ')).toContain('daily limit');
    expect(decision.reasons.join(' ')).toContain('not provider billing');
  });

  test('monthly limit warns at 80%', () => {
    const app = gateApp({ maxMonthly: 2 });
    const other = app.sessionManager.create({ mode: 'build', contextProfile: 'standard' });
    other.usage.estimatedCost = 1.55; // + ~0.014 estimate → 78% … just below 80%
    app.sessionManager.save(other);

    const warning = evaluateBudgetGate(app, {
      ...baseInput,
      estimatedInputTokens: 50_000,
      reservedOutputTokens: 0,
    });
    const monthly = warning.checks.find((c) => c.name === 'monthly local spend')!;
    expect(monthly.status).toBe('warning');
    expect(warning.action).toBe('allow');
  });

  test('per-session limit blocks on projected session spend', () => {
    const app = gateApp({ maxPerSession: 0.5 });
    app.session.usage.estimatedCost = 0.49;
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('block');
    expect(decision.reasons.join(' ')).toContain('per-session limit');
  });

  test('minimumBalance + unknownBalancePolicy=block blocks with an explanation', () => {
    const app = gateApp({ minimumBalance: 10, unknownBalancePolicy: 'block' });
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('block');
    expect(decision.reasons.join(' ')).toContain('balance cannot be verified');
    expect(decision.reasons.join(' ')).toContain('/budget balance');
  });

  test('minimumBalance + unknownBalancePolicy=confirm requires confirmation', () => {
    const app = gateApp({ minimumBalance: 10, unknownBalancePolicy: 'confirm' });
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('confirm');
    expect(decision.checks.find((c) => c.name === 'minimum balance')!.status).toBe('unknown');
  });

  test('minimumBalance + unknownBalancePolicy=allow proceeds but notes the unknown', () => {
    const app = gateApp({ minimumBalance: 10, unknownBalancePolicy: 'allow' });
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('allow');
    expect(decision.checks.find((c) => c.name === 'minimum balance')!.detail).toContain(
      'Policy allows',
    );
  });

  test('no minimumBalance configured → balance check is skipped', () => {
    const app = gateApp();
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.checks.find((c) => c.name === 'minimum balance')!.status).toBe('skipped');
  });

  test('block wins over confirm when multiple checks fail', () => {
    const app = gateApp({ largeContextConfirmationThreshold: 1000, maxPerRequest: 0.001 });
    const decision = evaluateBudgetGate(app, baseInput);
    expect(decision.action).toBe('block');
  });
});

describe('formatGateDecision / gateBlockedMessage', () => {
  test('formats markers and cost lines', () => {
    const app = gateApp({ maxPerRequest: 0.01 });
    const decision = evaluateBudgetGate(app, baseInput);
    const text = formatGateDecision(decision).join('\n');
    expect(text).toContain('Budget gate: BLOCK');
    expect(text).toContain('✗');
    expect(text).toContain('estimated cost:');
  });

  test('shows unknown cost without inventing numbers', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: [{ id: 'vendor/no-pricing', contextLength: 32_000, tools: true }] },
    });
    app.selectModel('test', 'vendor/no-pricing');
    const decision = evaluateBudgetGate(app, { ...baseInput, modelId: 'vendor/no-pricing' });
    const text = formatGateDecision(decision).join('\n');
    expect(text).toContain('estimated cost: unknown');
  });

  test('blocked message says nothing was sent or charged and points at the tools to fix it', () => {
    const app = gateApp({ maxPerRequest: 0.01 });
    const decision = evaluateBudgetGate(app, baseInput);
    const message = gateBlockedMessage(decision);
    expect(message).toContain('No request was sent and nothing was charged');
    expect(message).toContain('/budget');
    expect(message).toContain('/context budget');
    expect(message).toContain('--yes');
  });
});
