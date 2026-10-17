/**
 * Usage accounting tests (§29).
 *
 * The account view separates local estimates from provider-reported values
 * and never invents a provider balance.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import { SessionManager } from '../session/manager.js';
import type { ModelPricing } from '../types/index.js';
import { buildUsageAccount, localSpend, usageDeltaWithCost } from './accounting.js';

const pricing: ModelPricing = {
  inputPerMillion: 2,
  outputPerMillion: 8,
  currency: 'USD',
  source: 'test snapshot',
  updatedAt: '2026-01-01T00:00:00.000Z',
  confidence: 'high',
};

describe('usageDeltaWithCost', () => {
  test('aggregates tokens and cost for one usage record', () => {
    const { aggregate, cost } = usageDeltaWithCost(
      { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 100 },
      pricing,
    );
    expect(aggregate.requests).toBe(1);
    expect(aggregate.inputTokens).toBe(1000);
    expect(aggregate.outputTokens).toBe(500);
    expect(aggregate.cachedInputTokens).toBe(100);
    expect(aggregate.estimatedInputTokens).toBe(0);
    // 900×2/M + 100×2/M (charged at input rate) + 500×8/M
    expect(cost.cost).toBeCloseTo(0.0018 + 0.0002 + 0.004, 10);
    expect(aggregate.estimatedCost).toBeCloseTo(cost.cost!, 10);
    expect(aggregate.currency).toBe('USD');
  });

  test('no pricing leaves cost at 0 but reports the unknown components', () => {
    const { aggregate, cost } = usageDeltaWithCost({ inputTokens: 1000 }, undefined);
    expect(cost.cost).toBeUndefined();
    expect(cost.unknownComponents.length).toBeGreaterThan(0);
    expect(aggregate.estimatedCost).toBe(0);
    expect(aggregate.inputTokens).toBe(1000);
  });
});

describe('buildUsageAccount', () => {
  test('reports session usage, last-request estimate, pricing, and unknown credits', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.usage.inputTokens = 10_000;
    app.session.usage.outputTokens = 2_000;
    app.session.usage.estimatedCost = 0.05;
    app.session.usage.estimatedInputTokens = 9_800;
    app.session.usage.requests = 3;
    app.session.lastContextReport = {
      at: new Date().toISOString(),
      estimatedInputTokens: 9_800,
      estimateSource: 'local-heuristic',
      requestedTokens: 128000,
      requestOrigin: 'profile',
      reservedOutputTokens: 8000,
      safetyMargin: 4000,
      effectiveBudget: 116_000,
      remainingHeadroom: 106_200,
      capabilitySource: 'test',
      capabilityVerified: true,
      items: [],
      omittedMessages: 0,
      compactedMessages: 0,
      retrievalFiles: [],
      gateAction: 'allow',
      notes: [],
    };

    const account = buildUsageAccount(app);
    expect(account.session.requests).toBe(3);
    expect(account.lastRequest).toEqual({
      at: app.session.lastContextReport!.at,
      estimatedInputTokens: 9_800,
      estimateSource: 'local-heuristic',
      effectiveBudget: 116_000,
    });
    expect(account.pricing).toBeDefined();
    expect(account.pricing!.currency).toBe('USD');
    expect(account.sessionCostEstimate?.cost).toBeCloseTo(
      (10_000 / 1e6) * 1.5 + (2_000 / 1e6) * 6,
      10,
    );
    expect(account.credits.status).toBe('unknown');
    expect(account.credits.note).toContain('not an official balance');
  });

  test('no selected model → no pricing and no session cost estimate', () => {
    const { app } = createTestApp({ providers: [testProvider()] });
    const account = buildUsageAccount(app);
    expect(account.pricing).toBeUndefined();
    expect(account.sessionCostEstimate).toBeUndefined();
    expect(account.lastRequest).toBeUndefined();
  });

  test('pricing exists for the active model even when no session report exists', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    const account = buildUsageAccount(app);
    expect(account.pricing).toBeDefined();
    expect(account.sessionCostEstimate?.cost).toBe(0);
  });
});

describe('localSpend', () => {
  test('sums session estimates updated today and this month', () => {
    const { app, sessionManager, dir } = createTestApp();

    app.session.usage.estimatedCost = 1.5;
    sessionManager.save(app.session);

    // A second session recorded two days ago (may or may not be this month)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const pastManager = new SessionManager({
      directory: join(dir, 'sessions'),
      projectPath: dir,
      now: () => twoDaysAgo,
    });
    const older = pastManager.create({ mode: 'build', contextProfile: 'standard' });
    older.usage.estimatedCost = 10;
    pastManager.save(older);

    const spend = localSpend(app);
    expect(spend.today.total).toBeCloseTo(1.5, 10);
    expect(spend.today.sessionCount).toBe(1);

    const sameMonth = twoDaysAgo.getMonth() === new Date().getMonth();
    expect(spend.month.total).toBeCloseTo(sameMonth ? 11.5 : 1.5, 10);
    expect(spend.today.since <= new Date().toISOString()).toBe(true);
    expect(spend.month.since <= spend.today.since).toBe(true);
  });

  test('empty history yields zero spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-acc-'));
    const { app } = createTestApp({ projectPath: dir });
    const spend = localSpend(app);
    expect(spend.today.total).toBe(0);
    expect(spend.month.total).toBe(0);
  });
});
