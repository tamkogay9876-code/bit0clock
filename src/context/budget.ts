/**
 * Effective context budget calculation (§23).
 *
 * Nine values are maintained separately and never conflated:
 *   1. user-requested budget           (requestedTokens, origin)
 *   2. model context limit             (modelContextLimit, when reported)
 *   3. provider-specific input limit   (providerInputLimit, when documented)
 *   4. reserved output capacity        (reservedOutputTokens)
 *   5. safety margin                   (safetyMargin)
 *   6. estimated input tokens          (estimatedInputTokens)
 *   7. effective request budget        (effectiveBudget)
 *   8. remaining headroom              (remainingHeadroom)
 *   9. capability source + timestamp   (capability)
 *
 * The effective budget comes from the STRICTEST applicable limit. When no
 * reliable limit is known, a conservative configurable fallback is used and
 * labeled unverified. This module is pure: no I/O, no provider calls.
 */

export const ARCHITECTURAL_MAX_CONTEXT = 5_000_000;
export const DEFAULT_FALLBACK_LIMIT = 32_000;
export const DEFAULT_AUTO_OUTPUT_RESERVE = 8_192;

export type BudgetOrigin = 'profile' | 'custom' | 'auto';

export type CapabilitySourceKind =
  'provider-api' | 'manual' | 'documented' | 'cached' | 'inferred' | 'fallback';

export interface CapabilityInfo {
  /** Human label, e.g. "vendor/alpha-model reported context window" */
  label: string;
  source: CapabilitySourceKind;
  timestamp?: string;
  /** True only when a live call has succeeded for this model */
  verified: boolean;
}

export interface EffectiveBudgetInputs {
  /** 0 means "auto": no explicit user-requested budget */
  requestedTokens: number;
  origin: BudgetOrigin;
  modelContextLimit?: number;
  modelCapability?: CapabilityInfo;
  providerInputLimit?: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  estimatedInputTokens: number;
  fallbackLimit?: number;
}

export interface EffectiveBudget {
  requestedTokens: number;
  origin: BudgetOrigin;
  modelContextLimit?: number;
  providerInputLimit?: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  estimatedInputTokens: number;
  effectiveBudget: number;
  remainingHeadroom: number;
  capability: CapabilityInfo;
  notes: string[];
}

export function computeEffectiveBudget(inputs: EffectiveBudgetInputs): EffectiveBudget {
  const fallbackLimit = inputs.fallbackLimit ?? DEFAULT_FALLBACK_LIMIT;
  const notes: string[] = [];

  const candidateLimits: Array<{ name: string; value: number }> = [];
  if (inputs.modelContextLimit !== undefined && inputs.modelContextLimit > 0) {
    candidateLimits.push({ name: 'model context window', value: inputs.modelContextLimit });
  }
  if (inputs.providerInputLimit !== undefined && inputs.providerInputLimit > 0) {
    candidateLimits.push({ name: 'provider input limit', value: inputs.providerInputLimit });
  }
  if (inputs.requestedTokens > 0) {
    candidateLimits.push({ name: 'requested budget', value: inputs.requestedTokens });
  }
  candidateLimits.push({ name: 'architectural cap', value: ARCHITECTURAL_MAX_CONTEXT });

  const limitKnown =
    (inputs.modelContextLimit !== undefined && inputs.modelContextLimit > 0) ||
    (inputs.providerInputLimit !== undefined && inputs.providerInputLimit > 0);

  if (!limitKnown) {
    candidateLimits.push({ name: 'conservative fallback', value: fallbackLimit });
    notes.push(
      `No reliable model or provider context limit is known; using the conservative fallback of ${fallbackLimit} tokens (unverified). ` +
        'Configure the model or connect the provider to refine this.',
    );
  }

  const strictest = candidateLimits.reduce((min, entry) => Math.min(min, entry.value), Infinity);
  const strictestName = candidateLimits
    .filter((entry) => entry.value === strictest)
    .map((entry) => entry.name)
    .join(' / ');

  const effectiveBudget = Math.max(
    0,
    Math.min(
      ARCHITECTURAL_MAX_CONTEXT,
      strictest - inputs.reservedOutputTokens - inputs.safetyMargin,
    ),
  );

  if (inputs.modelContextLimit === undefined || inputs.modelContextLimit === 0) {
    notes.push('The model context window is not reported; it is shown as unknown, not unlimited.');
  }
  if (
    inputs.modelCapability &&
    !inputs.modelCapability.verified &&
    inputs.modelContextLimit !== undefined
  ) {
    notes.push(
      'The model context window is reported by the provider/catalog but this model has not completed a verified live call yet.',
    );
  }
  if (inputs.providerInputLimit === undefined) {
    notes.push('No provider-specific input limit is configured or documented.');
  }
  if (inputs.requestedTokens > 0 && inputs.requestedTokens > strictest) {
    notes.push(
      `The requested budget (${inputs.requestedTokens}) exceeds the strictest applicable limit (${strictestName} at ${strictest}); the effective budget is clamped to the limit.`,
    );
  }

  const capability: CapabilityInfo = inputs.modelCapability
    ? { ...inputs.modelCapability }
    : inputs.modelContextLimit !== undefined
      ? {
          label: 'model context window (source not recorded)',
          source: 'cached',
          verified: false,
        }
      : {
          label: 'conservative fallback (no capability information)',
          source: 'fallback',
          verified: false,
        };

  return {
    requestedTokens: inputs.requestedTokens,
    origin: inputs.origin,
    ...(inputs.modelContextLimit !== undefined
      ? { modelContextLimit: inputs.modelContextLimit }
      : {}),
    ...(inputs.providerInputLimit !== undefined
      ? { providerInputLimit: inputs.providerInputLimit }
      : {}),
    reservedOutputTokens: inputs.reservedOutputTokens,
    safetyMargin: inputs.safetyMargin,
    estimatedInputTokens: inputs.estimatedInputTokens,
    effectiveBudget,
    remainingHeadroom: effectiveBudget - inputs.estimatedInputTokens,
    capability,
    notes,
  };
}

/** Plain-text pairs for /context budget (commands add their own formatting). */
export function budgetReport(budget: EffectiveBudget): {
  pairs: Array<[string, string]>;
  notes: string[];
} {
  const fmt = (value: number): string => `${value} tokens`;
  const requested =
    budget.origin === 'auto'
      ? 'auto (runtime-determined)'
      : `${budget.requestedTokens} tokens (${budget.origin})`;

  const pairs: Array<[string, string]> = [
    ['requested budget', requested],
    [
      'model context limit',
      budget.modelContextLimit !== undefined
        ? fmt(budget.modelContextLimit)
        : 'unknown (not reported)',
    ],
    [
      'provider input limit',
      budget.providerInputLimit !== undefined
        ? fmt(budget.providerInputLimit)
        : 'unknown (not documented/configured)',
    ],
    ['reserved output capacity', fmt(budget.reservedOutputTokens)],
    ['safety margin', fmt(budget.safetyMargin)],
    ['estimated input tokens', fmt(budget.estimatedInputTokens)],
    ['effective request budget', fmt(budget.effectiveBudget)],
    [
      'remaining headroom',
      budget.remainingHeadroom >= 0
        ? fmt(budget.remainingHeadroom)
        : `OVER by ${-budget.remainingHeadroom} tokens`,
    ],
    [
      'capability source',
      `${budget.capability.label} [${budget.capability.source}${
        budget.capability.timestamp ? `, ${budget.capability.timestamp}` : ''
      }${budget.capability.verified ? ', verified' : ', unverified'}]`,
    ],
  ];

  return { pairs, notes: budget.notes };
}
