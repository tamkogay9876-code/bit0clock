/**
 * Pricing registry and conservative cost estimation (§29).
 *
 * Rules:
 *  - Prices come only from the model catalog snapshot (provider-reported or
 *    manually configured). Missing prices are reported as unknown and never
 *    invented.
 *  - Every cost produced here is a LOCAL ESTIMATE; it is never presented as
 *    the provider's invoice or account balance.
 *  - Request cost estimates are worst-case: the full output reserve is
 *    assumed to be used.
 */

import type { ModelPricing } from '../types/index.js';

export interface CostEstimate {
  /** Undefined when no usable pricing exists */
  cost?: number;
  currency: string;
  /** Components that could not be priced from the snapshot */
  unknownComponents: string[];
  note: string;
}

export interface UsageForCost {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/**
 * Estimate the cost of one usage record from a pricing snapshot.
 * Unknown components are listed, never zero-costed silently.
 */
export function estimateUsageCost(
  pricing: ModelPricing | undefined,
  usage: UsageForCost,
): CostEstimate {
  if (!pricing || pricing.inputPerMillion === undefined) {
    return {
      currency: pricing?.currency ?? 'USD',
      unknownComponents: ['input price', 'output price'],
      note: 'no pricing snapshot for this model; cost cannot be estimated',
    };
  }

  const currency = pricing.currency;
  const unknownComponents: string[] = [];
  const inputTokens = usage.inputTokens ?? 0;
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const billableInput = Math.max(0, inputTokens - cachedTokens);
  const outputTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;

  let cost = (billableInput / 1_000_000) * pricing.inputPerMillion;

  if (cachedTokens > 0) {
    if (pricing.cachedInputPerMillion !== undefined) {
      cost += (cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
    } else {
      // Conservative: charge cached tokens at the input rate rather than zero
      cost += (cachedTokens / 1_000_000) * pricing.inputPerMillion;
      unknownComponents.push('cached-input price (charged at the input rate)');
    }
  }

  if (outputTokens > 0) {
    if (pricing.outputPerMillion !== undefined) {
      cost += (outputTokens / 1_000_000) * pricing.outputPerMillion;
    } else {
      unknownComponents.push('output price (not included in this estimate)');
    }
  }

  if (reasoningTokens > 0) {
    if (pricing.reasoningPerMillion !== undefined) {
      cost += (reasoningTokens / 1_000_000) * pricing.reasoningPerMillion;
    } else if (pricing.outputPerMillion === undefined) {
      unknownComponents.push('reasoning price');
    }
    // When only the output price exists, providers typically count reasoning
    // inside the output tokens; not double-charging keeps the estimate honest.
  }

  return {
    cost,
    currency,
    unknownComponents,
    note:
      unknownComponents.length === 0
        ? `local estimate from the pricing snapshot (${pricing.source}, updated ${pricing.updatedAt}, confidence: ${pricing.confidence})`
        : `local estimate with unknown component(s): ${unknownComponents.join('; ')}`,
  };
}

/**
 * Worst-case cost of one request: the input estimate plus the FULL output
 * reserve at the output price. Deliberately conservative (§30 step 2).
 */
export function estimateRequestCost(
  pricing: ModelPricing | undefined,
  inputTokens: number,
  reservedOutputTokens: number,
): CostEstimate {
  const usage: UsageForCost = { inputTokens };
  const unknown: string[] = [];

  if (reservedOutputTokens > 0) {
    if (pricing?.outputPerMillion !== undefined) {
      usage.outputTokens = reservedOutputTokens;
    } else if (pricing) {
      unknown.push(`reserved output (${reservedOutputTokens} tokens) has no output price`);
    }
  }

  const estimate = estimateUsageCost(pricing, usage);
  return {
    ...estimate,
    unknownComponents: [...estimate.unknownComponents, ...unknown],
    note: `${estimate.note}; output side assumes the full ${reservedOutputTokens}-token reserve is used (worst case)`,
  };
}

/** Human description of the pricing snapshot for /usage and /budget. */
export function describePricing(pricing: ModelPricing | undefined): string[] {
  if (!pricing) {
    return [
      'Pricing: unknown — the catalog has no pricing snapshot for this model.',
      'Costs cannot be estimated; check the provider dashboard for official prices.',
    ];
  }
  const lines: string[] = ['Pricing (snapshot used for local estimates):'];
  lines.push(
    `  input          ${pricing.inputPerMillion !== undefined ? `${pricing.inputPerMillion} ${pricing.currency}/M tokens` : 'unknown'}`,
  );
  lines.push(
    `  output         ${pricing.outputPerMillion !== undefined ? `${pricing.outputPerMillion} ${pricing.currency}/M tokens` : 'unknown'}`,
  );
  lines.push(
    `  cached input   ${pricing.cachedInputPerMillion !== undefined ? `${pricing.cachedInputPerMillion} ${pricing.currency}/M tokens` : 'unknown'}`,
  );
  lines.push(`  source         ${pricing.source}`);
  lines.push(`  updated        ${pricing.updatedAt}`);
  lines.push(`  confidence     ${pricing.confidence}`);
  return lines;
}
