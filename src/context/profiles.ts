/**
 * Context profiles (§24).
 *
 * Profiles are configuration presets, not promises: the effective budget is
 * still clamped by the verified limits in budget.ts. The `auto` profile
 * chooses the SMALLEST tier that covers the estimated need — it never picks
 * the largest profile just because it exists.
 */

import type { ContextProfile } from '../types/index.js';
import type { BudgetOrigin } from './budget.js';
import { ARCHITECTURAL_MAX_CONTEXT } from './budget.js';

export interface ContextTarget {
  profileId: string;
  origin: BudgetOrigin;
  /** 0 when auto: determined at runtime from model + task */
  maxTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  auto: boolean;
  notes: string[];
}

export interface ResolveContextTargetInput {
  session: { contextProfile: string; requestedContext?: number };
  profiles: ContextProfile[];
  defaultProfileId: string;
}

/**
 * Resolve the session's context profile/override into a target.
 * An explicit `requestedContext` always wins (origin 'custom').
 */
export function resolveContextTarget(input: ResolveContextTargetInput): ContextTarget {
  const { session, profiles } = input;
  const notes: string[] = [];

  if (session.requestedContext !== undefined) {
    const profile = profiles.find((p) => p.id === session.contextProfile);
    return {
      profileId: session.contextProfile,
      origin: 'custom',
      maxTokens: session.requestedContext,
      reservedOutputTokens: profile?.reservedOutputTokens ?? 0,
      safetyMargin: profile?.safetyMargin ?? 0,
      auto: false,
      notes,
    };
  }

  const explicit = profiles.find((p) => p.id === session.contextProfile);
  const profile = explicit ?? profiles.find((p) => p.id === input.defaultProfileId);
  if (!explicit && session.contextProfile !== '' && profile) {
    notes.push(
      `Context profile "${session.contextProfile}" is not in the configured profiles; the default "${profile.id}" is used until /context reset fixes it.`,
    );
  }

  if (!profile) {
    // Unknown profile ids are surfaced by /context; falling back must be explicit.
    return {
      profileId: session.contextProfile,
      origin: 'profile',
      maxTokens: 0,
      reservedOutputTokens: 0,
      safetyMargin: 0,
      auto: true,
      notes: [
        `Context profile "${session.contextProfile}" is not in the configured profiles; the budget is determined at runtime until it is fixed with /context reset.`,
      ],
    };
  }

  if (profile.maxTokens === 0) {
    return {
      profileId: profile.id,
      origin: 'auto',
      maxTokens: 0,
      reservedOutputTokens: profile.reservedOutputTokens,
      safetyMargin: profile.safetyMargin,
      auto: true,
      notes,
    };
  }

  return {
    profileId: profile.id,
    origin: 'profile',
    maxTokens: profile.maxTokens,
    reservedOutputTokens: profile.reservedOutputTokens,
    safetyMargin: profile.safetyMargin,
    auto: false,
    notes,
  };
}

// ============================================================================
// Auto profile
// ============================================================================

/** Ascending context tiers used by the auto profile. */
export const AUTO_TIERS: readonly number[] = [
  32_000, 128_000, 500_000, 1_000_000, 2_000_000, 5_000_000,
];

/** The auto profile aims for this much headroom over the estimated need. */
export const AUTO_HEADROOM_FACTOR = 1.25;

export interface AutoBudgetInput {
  /** Estimated tokens of the conversation that would be sent */
  conversationTokens: number;
  /** Estimated tokens of the current task/instructions */
  taskTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  /** Provider-reported/reliable model window when known */
  modelContextLimit?: number;
  fallbackLimit: number;
}

export interface AutoBudgetResult {
  maxTokens: number;
  notes: string[];
}

/**
 * Pick the smallest tier that covers the estimated need plus headroom.
 * Considers model capacity, relevant volume (conversation + task), and
 * output requirements. It does not consider latency directly beyond
 * preferring smaller tiers; larger windows may increase latency and cost.
 */
export function resolveAutoBudget(input: AutoBudgetInput): AutoBudgetResult {
  const notes: string[] = [];

  const ceilingKnown = input.modelContextLimit !== undefined && input.modelContextLimit > 0;
  const ceiling = Math.min(
    ARCHITECTURAL_MAX_CONTEXT,
    ceilingKnown ? input.modelContextLimit! : input.fallbackLimit,
  );
  if (!ceilingKnown) {
    notes.push(
      `Auto: the model context window is unknown; the conservative fallback of ${input.fallbackLimit} tokens bounds the budget (unverified).`,
    );
  }

  const required =
    input.conversationTokens + input.taskTokens + input.reservedOutputTokens + input.safetyMargin;
  const target = Math.ceil(required * AUTO_HEADROOM_FACTOR);

  const fitting = AUTO_TIERS.find((tier) => tier >= target && tier <= ceiling);
  if (fitting !== undefined) {
    notes.push(
      `Auto: selected the smallest tier (${fitting} tokens) covering the estimated need (${required} tokens + output reserve; ×${AUTO_HEADROOM_FACTOR} headroom) within the model limit.`,
    );
    return { maxTokens: fitting, notes };
  }

  notes.push(
    `Auto: the estimated need (${required} tokens + headroom) does not fit an exact tier within the limit; using the ceiling of ${ceiling} tokens. Larger requests may be trimmed or compacted.`,
  );
  return { maxTokens: ceiling, notes };
}
