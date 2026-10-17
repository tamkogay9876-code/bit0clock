/**
 * Formatting helpers for command output.
 *
 * All output is plain text so it renders identically in the terminal,
 * in logs, and in tests.
 */

/** 12500 → "12.5k"; 1500000 → "1.5M" */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) {
    const value = tokens / 1000;
    return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}k`;
  }
  const value = tokens / 1_000_000;
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}M`;
}

/** 0.0123 → "$0.0123" — clearly a local estimate when labeled as such. */
export function formatMoney(value: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : '';
  if (value === 0) return `${symbol}0.0000 ${currency}`.trim();
  if (value < 0.0001) return `${symbol}<0.0001 ${currency}`.trim();
  return `${symbol}${value.toFixed(4)} ${currency}`;
}

const TOKEN_UNITS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
};

/**
 * Parse a token count the user typed: "128k", "1M", "8192".
 * Returns null for invalid input (caller shows usage).
 */
export function parseTokenCount(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit ? TOKEN_UNITS[unit]! : 1;
  const result = Math.round(value * multiplier);
  return Number.isFinite(result) && result > 0 ? result : null;
}

/** "2m ago", "3h ago", "5d ago" */
export function formatRelative(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = nowMs - then;
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/** Align a two-column description table. */
export function formatPairs(pairs: Array<[string, string]>, indent = '  '): string {
  const width = Math.max(...pairs.map(([label]) => label.length), 0);
  return pairs.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`).join('\n');
}

export function shortenId(id: string): string {
  return id.slice(0, 8);
}
