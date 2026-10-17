/**
 * High-context preflight budget gate (§30).
 *
 * Before a request is sent, the gate:
 *   1. checks the estimated request size against the effective budget and
 *      verified provider/model limits,
 *   2. calculates a conservative cost estimate when pricing exists,
 *   3. checks the configured local spend limits (request/session/day/month),
 *   4. applies the large-context confirmation threshold,
 *   5. applies the configured unknown-balance policy — the balance itself is
 *      only ever verified through documented provider interfaces, never
 *      guessed,
 *   6. returns allow / confirm / block with explicit reasons.
 *
 * The gate never silently switches models, reduces context, or changes
 * providers. It also does not fabricate a successful balance check.
 */

import type { AppState } from '../app/state.js';
import { estimateRequestCost } from './pricing.js';
import { localSpend } from './accounting.js';
import { formatMoney } from '../commands/format.js';

export type GateAction = 'allow' | 'confirm' | 'block';

export interface BudgetGateCheck {
  name: string;
  status: 'ok' | 'warning' | 'blocked' | 'unknown' | 'skipped';
  detail: string;
}

export interface BudgetGateDecision {
  action: GateAction;
  reasons: string[];
  checks: BudgetGateCheck[];
  estimate: {
    inputTokens: number;
    estimatedCost?: number;
    currency: string;
    costNote: string;
  };
}

export interface BudgetGateInput {
  estimatedInputTokens: number;
  effectiveBudget: number;
  reservedOutputTokens: number;
  providerId: string;
  modelId: string;
  profileId: string;
  /** 0 for auto */
  requestedTokens: number;
  modelContextLimit?: number;
  providerInputLimit?: number;
}

const WARN_FRACTION = 0.8;

export function evaluateBudgetGate(app: AppState, input: BudgetGateInput): BudgetGateDecision {
  const limits = app.config.spendingLimits;
  const checks: BudgetGateCheck[] = [];
  const reasons: string[] = [];

  let action: GateAction = 'allow';
  const raise = (level: GateAction, reason: string): void => {
    if (level === 'block' || (level === 'confirm' && action === 'allow')) action = level;
    reasons.push(reason);
  };

  const entry = app.catalog.findModel(input.modelId, [input.providerId]);
  const pricing = entry?.pricing;
  const costEstimate = estimateRequestCost(
    pricing,
    input.estimatedInputTokens,
    input.reservedOutputTokens,
  );

  // 1. Request size vs effective budget
  if (input.estimatedInputTokens > input.effectiveBudget) {
    checks.push({
      name: 'request size',
      status: 'blocked',
      detail: `estimated ${input.estimatedInputTokens} input tokens exceeds the effective budget of ${input.effectiveBudget}`,
    });
    raise(
      'block',
      `Estimated input (${input.estimatedInputTokens} tokens) exceeds the effective budget (${input.effectiveBudget}).`,
    );
  } else {
    checks.push({
      name: 'request size',
      status: 'ok',
      detail: `estimated ${input.estimatedInputTokens} input tokens within the effective budget of ${input.effectiveBudget}`,
    });
  }

  // 2. Verified provider/model limits
  if (
    input.modelContextLimit !== undefined &&
    input.estimatedInputTokens > input.modelContextLimit
  ) {
    checks.push({
      name: 'model context limit',
      status: 'blocked',
      detail: `estimated input exceeds the reported model window of ${input.modelContextLimit}`,
    });
    raise(
      'block',
      `Estimated input exceeds the reported model context window (${input.modelContextLimit} tokens).`,
    );
  } else if (input.modelContextLimit !== undefined) {
    checks.push({
      name: 'model context limit',
      status: 'ok',
      detail: `within the reported model window of ${input.modelContextLimit}`,
    });
  } else {
    checks.push({
      name: 'model context limit',
      status: 'unknown',
      detail: 'the model context window is not reported; it is unknown, not unlimited',
    });
  }

  if (input.providerInputLimit !== undefined) {
    if (input.estimatedInputTokens > input.providerInputLimit) {
      checks.push({
        name: 'provider input limit',
        status: 'blocked',
        detail: `estimated input exceeds the configured provider input limit of ${input.providerInputLimit}`,
      });
      raise(
        'block',
        `Estimated input exceeds the configured provider input limit (${input.providerInputLimit} tokens).`,
      );
    } else {
      checks.push({
        name: 'provider input limit',
        status: 'ok',
        detail: `within the configured provider input limit of ${input.providerInputLimit}`,
      });
    }
  } else {
    checks.push({
      name: 'provider input limit',
      status: 'skipped',
      detail: 'no provider-specific input limit is configured or documented',
    });
  }

  // 3. Large-context confirmation threshold
  if (limits.largeContextConfirmationThreshold !== undefined) {
    const total = input.estimatedInputTokens + input.reservedOutputTokens;
    if (total >= limits.largeContextConfirmationThreshold) {
      checks.push({
        name: 'large-context threshold',
        status: 'warning',
        detail: `request of ${total} tokens (input + output reserve) reaches the configured confirmation threshold of ${limits.largeContextConfirmationThreshold}`,
      });
      raise(
        'confirm',
        `This request is large (${total} tokens including the output reserve) and crosses the configured large-context confirmation threshold (${limits.largeContextConfirmationThreshold}).`,
      );
    } else {
      checks.push({
        name: 'large-context threshold',
        status: 'ok',
        detail: `${total} tokens below the confirmation threshold of ${limits.largeContextConfirmationThreshold}`,
      });
    }
  } else {
    checks.push({
      name: 'large-context threshold',
      status: 'skipped',
      detail: 'no large-context confirmation threshold is configured',
    });
  }

  // 4. Per-request cost limit
  if (limits.maxPerRequest !== undefined) {
    if (costEstimate.cost !== undefined) {
      if (costEstimate.cost > limits.maxPerRequest) {
        checks.push({
          name: 'max cost per request',
          status: 'blocked',
          detail: `estimated ${formatMoney(costEstimate.cost, costEstimate.currency)} exceeds the configured limit of ${formatMoney(limits.maxPerRequest, limits.currency)}`,
        });
        raise(
          'block',
          `The conservative cost estimate (${formatMoney(costEstimate.cost, costEstimate.currency)}) exceeds the configured maximum per request (${formatMoney(limits.maxPerRequest, limits.currency)}). ${costEstimate.note}.`,
        );
      } else {
        const fraction = costEstimate.cost / limits.maxPerRequest;
        checks.push({
          name: 'max cost per request',
          status: fraction >= WARN_FRACTION ? 'warning' : 'ok',
          detail: `estimated ${formatMoney(costEstimate.cost, costEstimate.currency)} of the ${formatMoney(limits.maxPerRequest, limits.currency)} per-request limit`,
        });
        if (fraction >= WARN_FRACTION) {
          reasons.push(
            `Estimated cost is at ${Math.round(fraction * 100)}% of the configured per-request limit.`,
          );
        }
      }
    } else {
      checks.push({
        name: 'max cost per request',
        status: 'unknown',
        detail:
          'a per-request cost limit is configured but no pricing snapshot exists, so the limit cannot be verified',
      });
      raise(
        'confirm',
        `A per-request cost limit (${formatMoney(limits.maxPerRequest, limits.currency)}) is configured, but the model has no pricing snapshot — the cost cannot be verified. ${costEstimate.note}.`,
      );
    }
  } else {
    checks.push({
      name: 'max cost per request',
      status: 'skipped',
      detail: 'no per-request cost limit is configured',
    });
  }

  // 5. Daily / monthly local spend limits
  const spend = localSpend(app);
  const projectedCost = costEstimate.cost ?? 0;

  if (limits.maxDaily !== undefined) {
    const projected = spend.today.total + projectedCost;
    if (projected > limits.maxDaily) {
      checks.push({
        name: 'daily local spend',
        status: 'blocked',
        detail: `estimated ${formatMoney(projected, spend.today.currency)} for today exceeds the configured daily limit of ${formatMoney(limits.maxDaily, limits.currency)}`,
      });
      raise(
        'block',
        `Today's local spend estimate (${formatMoney(projected, spend.today.currency)}) would exceed the configured daily limit (${formatMoney(limits.maxDaily, limits.currency)}). These are local estimates from session records, not provider billing.`,
      );
    } else if (projected >= limits.maxDaily * WARN_FRACTION) {
      checks.push({
        name: 'daily local spend',
        status: 'warning',
        detail: `${formatMoney(projected, spend.today.currency)} of the ${formatMoney(limits.maxDaily, limits.currency)} daily limit`,
      });
      reasons.push("Today's local spend estimate is close to the configured daily limit.");
    } else {
      checks.push({
        name: 'daily local spend',
        status: 'ok',
        detail: `${formatMoney(projected, spend.today.currency)} of the ${formatMoney(limits.maxDaily, limits.currency)} daily limit`,
      });
    }
  } else {
    checks.push({
      name: 'daily local spend',
      status: 'skipped',
      detail: 'no daily limit is configured',
    });
  }

  if (limits.maxMonthly !== undefined) {
    const projected = spend.month.total + projectedCost;
    if (projected > limits.maxMonthly) {
      checks.push({
        name: 'monthly local spend',
        status: 'blocked',
        detail: `estimated ${formatMoney(projected, spend.month.currency)} for this month exceeds the configured monthly limit of ${formatMoney(limits.maxMonthly, limits.currency)}`,
      });
      raise(
        'block',
        `This month's local spend estimate (${formatMoney(projected, spend.month.currency)}) would exceed the configured monthly limit (${formatMoney(limits.maxMonthly, limits.currency)}). These are local estimates from session records, not provider billing.`,
      );
    } else if (projected >= limits.maxMonthly * WARN_FRACTION) {
      checks.push({
        name: 'monthly local spend',
        status: 'warning',
        detail: `${formatMoney(projected, spend.month.currency)} of the ${formatMoney(limits.maxMonthly, limits.currency)} monthly limit`,
      });
      reasons.push("This month's local spend estimate is close to the configured monthly limit.");
    } else {
      checks.push({
        name: 'monthly local spend',
        status: 'ok',
        detail: `${formatMoney(projected, spend.month.currency)} of the ${formatMoney(limits.maxMonthly, limits.currency)} monthly limit`,
      });
    }
  } else {
    checks.push({
      name: 'monthly local spend',
      status: 'skipped',
      detail: 'no monthly limit is configured',
    });
  }

  // 6. Per-session limit
  if (limits.maxPerSession !== undefined) {
    const projected = app.session.usage.estimatedCost + projectedCost;
    if (projected > limits.maxPerSession) {
      checks.push({
        name: 'session local spend',
        status: 'blocked',
        detail: `estimated session spend ${formatMoney(projected, app.session.usage.currency)} exceeds the configured per-session limit of ${formatMoney(limits.maxPerSession, limits.currency)}`,
      });
      raise(
        'block',
        `The session's local spend estimate (${formatMoney(projected, app.session.usage.currency)}) would exceed the configured per-session limit (${formatMoney(limits.maxPerSession, limits.currency)}).`,
      );
    } else {
      checks.push({
        name: 'session local spend',
        status: 'ok',
        detail: `${formatMoney(projected, app.session.usage.currency)} of the ${formatMoney(limits.maxPerSession, limits.currency)} per-session limit`,
      });
    }
  } else {
    checks.push({
      name: 'session local spend',
      status: 'skipped',
      detail: 'no per-session limit is configured',
    });
  }

  // 7. Minimum verified balance policy (only when a minimum is required)
  if (limits.minimumBalance !== undefined) {
    const policy = limits.unknownBalancePolicy;
    const detail =
      `a minimum balance of ${formatMoney(limits.minimumBalance, limits.currency)} is configured, but the provider balance is not verified during preflight ` +
      '(no documented balance interface is called automatically). Unknown-balance policy: ' +
      policy +
      '.';
    if (policy === 'block') {
      checks.push({ name: 'minimum balance', status: 'blocked', detail });
      raise(
        'block',
        `The configured policy blocks requests when the provider balance cannot be verified. ${detail} Check /budget balance (documented interfaces only) or adjust spendingLimits.unknownBalancePolicy.`,
      );
    } else if (policy === 'confirm') {
      checks.push({ name: 'minimum balance', status: 'unknown', detail });
      raise(
        'confirm',
        `The provider balance is not verified and the minimum-balance policy requires confirmation. ${detail}`,
      );
    } else {
      checks.push({
        name: 'minimum balance',
        status: 'unknown',
        detail: `${detail} Policy allows proceeding.`,
      });
    }
  } else {
    checks.push({
      name: 'minimum balance',
      status: 'skipped',
      detail: 'no minimum verified balance is required by the configured policy',
    });
  }

  // 8. Pricing availability note (no action on its own)
  if (!pricing) {
    checks.push({
      name: 'pricing snapshot',
      status: 'unknown',
      detail:
        'no pricing snapshot for this model; estimated spend is shown as unknown, never invented',
    });
  } else {
    checks.push({
      name: 'pricing snapshot',
      status: 'ok',
      detail: `${pricing.source} (updated ${pricing.updatedAt}, confidence ${pricing.confidence})`,
    });
  }

  return {
    action,
    reasons,
    checks,
    estimate: {
      inputTokens: input.estimatedInputTokens,
      ...(costEstimate.cost !== undefined ? { estimatedCost: costEstimate.cost } : {}),
      currency: costEstimate.currency,
      costNote: costEstimate.note,
    },
  };
}

/** Plain-text gate summary for errors, prompts, and /context budget. */
export function formatGateDecision(decision: BudgetGateDecision): string[] {
  const lines: string[] = [`Budget gate: ${decision.action.toUpperCase()}`];
  for (const reason of decision.reasons) lines.push(`  ⚠ ${reason}`);
  for (const check of decision.checks) {
    const marker =
      check.status === 'blocked'
        ? '✗'
        : check.status === 'warning'
          ? '!'
          : check.status === 'unknown'
            ? '?'
            : check.status === 'skipped'
              ? '-'
              : '✓';
    lines.push(`  ${marker} ${check.name}: ${check.detail}`);
  }
  if (decision.estimate.estimatedCost !== undefined) {
    lines.push(
      `  estimated cost: ${formatMoney(decision.estimate.estimatedCost, decision.estimate.currency)} (${decision.estimate.costNote})`,
    );
  } else {
    lines.push(`  estimated cost: unknown (${decision.estimate.costNote})`);
  }
  return lines;
}

/** Error message used when the gate blocks a request. */
export function gateBlockedMessage(decision: BudgetGateDecision): string {
  const reasons = decision.reasons.map((r) => `• ${r}`).join('\n');
  return (
    `The budget gate blocked this request (${decision.action}).\n${reasons}\n` +
    'No request was sent and nothing was charged. Review /budget and /context budget, ' +
    'adjust the spending limits or the context profile, or use --yes where the policy allows confirmation.'
  );
}
