/**
 * Usage accounting (§29).
 *
 * Separates estimated vs provider-reported values and local vs
 * provider-reported totals. The provider's official balance is only shown
 * when a documented interface returned it; otherwise it is "unknown".
 */

import { addUsage, type SessionUsageAggregate } from '../session/types.js';
import type { AppState } from '../app/state.js';
import type { ModelPricing } from '../types/index.js';
import { estimateUsageCost, type CostEstimate } from './pricing.js';

export interface LocalSpendWindow {
  total: number;
  currency: string;
  sessionCount: number;
  since: string;
}

export interface UsageAccount {
  session: SessionUsageAggregate;
  /** Preflight estimate of the most recent prepared request, when available */
  lastRequest?: {
    at: string;
    estimatedInputTokens: number;
    estimateSource: string;
    effectiveBudget: number;
  };
  pricing?: ModelPricing;
  /** Local estimate of the session usage recomputed from the pricing snapshot */
  sessionCostEstimate?: CostEstimate;
  today: LocalSpendWindow;
  month: LocalSpendWindow;
  credits: { status: 'unknown'; note: string };
}

function startOfDayIso(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function startOfMonthIso(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  return start.toISOString();
}

/** Local estimated spend for today and the current month. */
export function localSpend(app: AppState): { today: LocalSpendWindow; month: LocalSpendWindow } {
  const dayIso = startOfDayIso();
  const monthIso = startOfMonthIso();
  const today = app.sessionManager.spendSince(dayIso);
  const month = app.sessionManager.spendSince(monthIso);
  return {
    today: { ...today, since: dayIso },
    month: { ...month, since: monthIso },
  };
}

/** Build the full usage account shown by /usage and /budget. */
export function buildUsageAccount(app: AppState): UsageAccount {
  const spend = localSpend(app);
  const active = app.activeModel();
  const pricing = active
    ? app.catalog.findModel(active.modelId, [active.providerId])?.pricing
    : undefined;

  const account: UsageAccount = {
    session: app.session.usage,
    today: spend.today,
    month: spend.month,
    credits: {
      status: 'unknown',
      note:
        'The local account cannot read provider credits. Use /budget balance to query a ' +
        'documented provider endpoint (xKiro only) or check the provider dashboard. ' +
        'Local estimates are not an official balance.',
    },
  };

  if (pricing) account.pricing = pricing;
  if (active && pricing) {
    account.sessionCostEstimate = estimateUsageCost(pricing, {
      inputTokens: app.session.usage.inputTokens,
      cachedInputTokens: app.session.usage.cachedInputTokens,
      outputTokens: app.session.usage.outputTokens,
      reasoningTokens: app.session.usage.reasoningTokens,
    });
  }

  const report = app.session.lastContextReport;
  if (report) {
    account.lastRequest = {
      at: report.at,
      estimatedInputTokens: report.estimatedInputTokens,
      estimateSource: report.estimateSource,
      effectiveBudget: report.effectiveBudget,
    };
  }

  return account;
}

/**
 * Merge one reported usage record into an aggregate plus its cost estimate.
 * Exposed for tests and for callers that need the delta without AppState.
 */
export function usageDeltaWithCost(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  },
  pricing: ModelPricing | undefined,
): { aggregate: SessionUsageAggregate; cost: CostEstimate } {
  const base: SessionUsageAggregate = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    estimatedCost: 0,
    estimatedInputTokens: 0,
    currency: pricing?.currency ?? 'USD',
    requests: 0,
  };
  const cost = estimateUsageCost(pricing, usage);
  const delta = { ...usage };
  const aggregate = addUsage(
    base,
    cost.cost !== undefined ? { ...delta, estimatedCost: cost.cost } : delta,
  );
  return { aggregate, cost };
}
