/**
 * Token estimation and calibration (§28).
 *
 * Priority order for input estimates:
 *   1. A provider token-count endpoint (exact, when documented and called).
 *   2. A locally calibrated heuristic (rough, learned from observed usage).
 *   3. The raw local heuristic (always labeled approximate).
 *
 * The local heuristic is `ceil(chars / 4)` plus explicit framing overheads.
 * It is NOT a tokenizer and is never presented as exact: bytes, words,
 * characters, and lines do not map directly to tokens. Image parts get a
 * conservative fixed allowance because their token cost cannot be derived
 * from the payload length.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { ChatRequest, InternalMessage, ToolSchema } from '../providers/types.js';

// ============================================================================
// Local heuristic
// ============================================================================

/** Approximate characters per token for mixed code/prose text. */
export const CHARS_PER_TOKEN = 4;
/** Per-message framing overhead (role, delimiters). */
export const MESSAGE_FRAMING_TOKENS = 4;
/** Per-tool-schema framing overhead. */
export const TOOL_FRAMING_TOKENS = 8;
/**
 * Conservative allowance per image part. Providers bill images by
 * resolution, not payload size; this is a rough upper-ish placeholder and
 * is labeled approximate everywhere it feeds an estimate.
 */
export const IMAGE_PART_TOKEN_ALLOWANCE = 1600;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateContentTokens(content: string | InternalMessage['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') total += estimateTextTokens(part.text);
    else total += IMAGE_PART_TOKEN_ALLOWANCE;
  }
  return total;
}

export function estimateMessageTokens(message: InternalMessage): number {
  let total = MESSAGE_FRAMING_TOKENS + estimateContentTokens(message.content);
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      total += MESSAGE_FRAMING_TOKENS;
      total += estimateTextTokens(call.name);
      total += estimateTextTokens(JSON.stringify(call.arguments ?? {}));
    }
  }
  if (message.toolResults) {
    for (const result of message.toolResults) {
      total += MESSAGE_FRAMING_TOKENS;
      total += estimateTextTokens(result.content);
    }
  }
  return total;
}

export function estimateToolSchemaTokens(tools: ToolSchema[]): number {
  let total = 0;
  for (const tool of tools) {
    total += TOOL_FRAMING_TOKENS;
    total += estimateTextTokens(tool.name);
    total += estimateTextTokens(tool.description);
    total += estimateTextTokens(JSON.stringify(tool.inputSchema ?? {}));
  }
  return total;
}

/** Estimate the input side of a chat request (system + messages + tools). */
export function estimateRequestInputTokens(
  request: Pick<ChatRequest, 'system' | 'messages' | 'tools'>,
): number {
  let total = 0;
  if (request.system) total += estimateTextTokens(request.system) + MESSAGE_FRAMING_TOKENS;
  for (const message of request.messages) total += estimateMessageTokens(message);
  if (request.tools && request.tools.length > 0) total += estimateToolSchemaTokens(request.tools);
  return total;
}

// ============================================================================
// Calibration
// ============================================================================

export interface CalibrationSample {
  at: string;
  estimated: number;
  actual: number;
  /** actual / estimated */
  ratio: number;
}

interface CalibrationEntry {
  samples: CalibrationSample[];
}

interface CalibrationFileShape {
  version: 1;
  models: Record<string, CalibrationEntry>;
}

export interface TokenEstimate {
  tokens: number;
  source: 'local-heuristic' | 'calibrated-local' | 'provider-endpoint';
  approximate: boolean;
  note?: string;
}

export interface CalibrationFactor {
  factor: number;
  samples: number;
  updatedAt: string;
  note: string;
}

export interface CalibrationStoreOptions {
  /** Defaults to ~/.config/mediaxg/token-calibration.json */
  path?: string;
  /** Samples kept per model (default 20) */
  maxSamplesPerModel?: number;
  now?: () => Date;
  /** Load/save from disk (disable in tests that stay in-memory) */
  persist?: boolean;
}

const FACTOR_MIN = 0.5;
const FACTOR_MAX = 3;

/**
 * Tracks observed (estimated, actual) pairs per provider/model and derives a
 * conservative correction factor. Calibration improves warnings; it is never
 * presented as a guarantee.
 */
export class CalibrationStore {
  private readonly filePath: string;
  private readonly maxSamples: number;
  private readonly now: () => Date;
  private readonly persist: boolean;
  private data: CalibrationFileShape;

  constructor(options: CalibrationStoreOptions = {}) {
    this.filePath = options.path ?? join(homedir(), '.config', 'mediaxg', 'token-calibration.json');
    this.maxSamples = options.maxSamplesPerModel ?? 20;
    this.now = options.now ?? (() => new Date());
    this.persist = options.persist ?? true;
    this.data = this.load();
  }

  private key(providerId: string, modelId: string): string {
    return `${providerId}/${modelId}`;
  }

  private load(): CalibrationFileShape {
    if (!this.persist || !existsSync(this.filePath)) return { version: 1, models: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as CalibrationFileShape;
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.models === 'object' &&
        parsed.models !== null
      ) {
        return parsed;
      }
    } catch {
      // corrupted calibration file: start fresh; a later save replaces it
    }
    return { version: 1, models: {} };
  }

  private save(): void {
    if (!this.persist) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      renameSync(tmp, this.filePath);
    } catch {
      // calibration is an optimization; never block a request on it
    }
  }

  /** Record one observed estimate/actual pair. Ignores invalid values. */
  record(providerId: string, modelId: string, estimated: number, actual: number): void {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return;
    if (estimated <= 0 || actual <= 0) return;

    const key = this.key(providerId, modelId);
    const entry = this.data.models[key] ?? { samples: [] };
    const ratio = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, actual / estimated));
    entry.samples.push({
      at: this.now().toISOString(),
      estimated: Math.round(estimated),
      actual: Math.round(actual),
      ratio,
    });
    if (entry.samples.length > this.maxSamples) {
      entry.samples = entry.samples.slice(entry.samples.length - this.maxSamples);
    }
    this.data.models[key] = entry;
    this.save();
  }

  /** Median-ratio correction factor for a provider/model, or null when unobserved. */
  factorFor(providerId: string, modelId: string): CalibrationFactor | null {
    const entry = this.data.models[this.key(providerId, modelId)];
    if (!entry || entry.samples.length === 0) return null;

    const ratios = entry.samples.map((s) => s.ratio).sort((a, b) => a - b);
    const middle = Math.floor(ratios.length / 2);
    const median =
      ratios.length % 2 === 0 ? (ratios[middle - 1]! + ratios[middle]!) / 2 : ratios[middle]!;
    const factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, median));
    const last = entry.samples[entry.samples.length - 1]!;
    return {
      factor,
      samples: entry.samples.length,
      updatedAt: last.at,
      note:
        `calibrated from ${entry.samples.length} observed response(s); ` +
        'a correction factor, not a guarantee',
    };
  }

  /** Apply calibration to a local estimate when observations exist. */
  apply(providerId: string, modelId: string, localEstimate: number): TokenEstimate {
    const calibration = this.factorFor(providerId, modelId);
    if (!calibration) {
      return {
        tokens: localEstimate,
        source: 'local-heuristic',
        approximate: true,
        note: 'local heuristic estimate (characters / 4 plus framing); approximate',
      };
    }
    return {
      tokens: Math.ceil(localEstimate * calibration.factor),
      source: 'calibrated-local',
      approximate: true,
      note: calibration.note,
    };
  }

  /** Observable state for diagnostics (no secrets involved). */
  describe(providerId: string, modelId: string): string {
    const calibration = this.factorFor(providerId, modelId);
    if (!calibration) return 'no calibration samples yet (local heuristic in use)';
    return (
      `factor ×${calibration.factor.toFixed(2)} from ${calibration.samples} sample(s), ` +
      `last ${calibration.updatedAt}`
    );
  }

  clear(providerId?: string, modelId?: string): void {
    if (providerId && modelId) {
      delete this.data.models[this.key(providerId, modelId)];
    } else {
      this.data = { version: 1, models: {} };
    }
    this.save();
  }
}

/**
 * Build the final estimate for a prepared request, preferring the provider
 * endpoint when it was called successfully.
 */
export function providerCountEstimate(tokens: number): TokenEstimate {
  return {
    tokens,
    source: 'provider-endpoint',
    approximate: false,
    note: 'counted by the provider token-count endpoint for this request',
  };
}
