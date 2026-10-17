/**
 * Context profile resolution tests (§24).
 */

import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../config/schema.js';
import type { ContextProfile } from '../types/index.js';
import { AUTO_TIERS, resolveAutoBudget, resolveContextTarget } from './profiles.js';

const profiles = defaultConfig.contextProfiles as ContextProfile[];

describe('resolveContextTarget', () => {
  test('resolves a configured profile with its reserve and margin', () => {
    const target = resolveContextTarget({
      session: { contextProfile: 'small' },
      profiles,
      defaultProfileId: 'standard',
    });
    expect(target.profileId).toBe('small');
    expect(target.origin).toBe('profile');
    expect(target.maxTokens).toBe(32000);
    expect(target.reservedOutputTokens).toBe(4000);
    expect(target.safetyMargin).toBe(2000);
    expect(target.auto).toBe(false);
  });

  test('explicit requestedContext overrides the profile (custom origin)', () => {
    const target = resolveContextTarget({
      session: { contextProfile: 'small', requestedContext: 64000 },
      profiles,
      defaultProfileId: 'standard',
    });
    expect(target.origin).toBe('custom');
    expect(target.maxTokens).toBe(64000);
    // Reserve/margin still come from the underlying profile
    expect(target.reservedOutputTokens).toBe(4000);
  });

  test('auto profile reports maxTokens 0 and auto: true', () => {
    const target = resolveContextTarget({
      session: { contextProfile: 'auto' },
      profiles,
      defaultProfileId: 'standard',
    });
    expect(target.auto).toBe(true);
    expect(target.maxTokens).toBe(0);
    expect(target.origin).toBe('auto');
  });

  test('unknown profile id is surfaced, not silently replaced', () => {
    const target = resolveContextTarget({
      session: { contextProfile: 'nonexistent' },
      profiles,
      defaultProfileId: 'standard',
    });
    expect(target.profileId).toBe('standard');
    expect(target.notes.join(' ')).toContain('not in the configured profiles');
  });

  test('falls back to the default profile id when the session id is empty', () => {
    const target = resolveContextTarget({
      session: { contextProfile: '' },
      profiles,
      defaultProfileId: 'standard',
    });
    expect(target.profileId).toBe('standard');
    expect(target.maxTokens).toBe(128000);
  });
});

describe('resolveAutoBudget', () => {
  const base = {
    taskTokens: 0,
    reservedOutputTokens: 8000,
    safetyMargin: 4000,
    fallbackLimit: 32000,
  };

  test('picks the smallest tier that covers the need', () => {
    const result = resolveAutoBudget({ ...base, conversationTokens: 10000 });
    expect(result.maxTokens).toBe(32000);
    expect(result.notes.join(' ')).toContain('smallest tier');
  });

  test('scales up only when the estimate requires it', () => {
    const result = resolveAutoBudget({
      ...base,
      conversationTokens: 200000,
      modelContextLimit: 500000,
    });
    // required = 212000, ×1.25 = 265000 → 500k tier
    expect(result.maxTokens).toBe(500000);
  });

  test('never exceeds the model limit', () => {
    const result = resolveAutoBudget({
      ...base,
      conversationTokens: 200000,
      modelContextLimit: 128000,
    });
    expect(result.maxTokens).toBe(128000);
    expect(result.notes.join(' ')).toContain('ceiling');
  });

  test('no model limit → conservative fallback bounds the result', () => {
    const result = resolveAutoBudget({ ...base, conversationTokens: 1000 });
    expect(result.maxTokens).toBe(32000);
    expect(result.notes.join(' ')).toContain('conservative fallback');
  });

  test('need above the fallback uses the fallback ceiling with a warning', () => {
    const result = resolveAutoBudget({ ...base, conversationTokens: 100000 });
    expect(result.maxTokens).toBe(32000);
    expect(result.notes.join(' ')).toContain('does not fit');
  });

  test('tiers are strictly ascending', () => {
    for (let i = 1; i < AUTO_TIERS.length; i++) {
      expect(AUTO_TIERS[i]!).toBeGreaterThan(AUTO_TIERS[i - 1]!);
    }
  });
});
