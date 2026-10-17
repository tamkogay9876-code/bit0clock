/**
 * Deterministic command parsing.
 *
 * Rules:
 *  - Input starting with exactly one `/` is a command attempt.
 *  - `//anything` escapes: the message is sent as literal text starting
 *    with a single `/` (so `/etc/passwd is broken` can be a message).
 *  - A single leading space also forces conversational input.
 *  - Quoted arguments ('single' or "double") keep their spaces.
 *  - `--flag` and `--key=value` become flags; everything else positional.
 */

import type { ParsedInput } from './types.js';

/** Tokenize a command tail into positional args and flags. */
export function parseCommandTail(tail: string): {
  args: string[];
  flags: Record<string, string | true>;
  raw: string;
} {
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  const raw = tail;

  let current = '';
  let quote: '"' | "'" | null = null;

  const push = () => {
    if (current === '') return;
    if (current.startsWith('--') && current.length > 2) {
      const body = current.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        flags[body] = true;
      }
    } else {
      args.push(current);
    }
    current = '';
  };

  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      push();
      continue;
    }

    current += ch;
  }

  push();
  return { args, flags, raw };
}

/**
 * Parse raw input into either a command attempt or a message.
 * Does NOT check whether the command exists (the registry does that).
 */
export function parseInput(input: string): ParsedInput {
  const trimmed = input.trim();

  if (trimmed === '') return { kind: 'message' };

  // Escapes: leading space or double slash force conversational input
  if (input.startsWith(' ') || trimmed.startsWith('//')) {
    const text = trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
    return { kind: 'message', raw: text };
  }

  if (!trimmed.startsWith('/')) {
    return { kind: 'message', raw: trimmed };
  }

  // Command: "/name rest" — name is the first whitespace-delimited token
  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.search(/[\s]/);
  const name = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
  const tail = spaceIndex === -1 ? '' : withoutSlash.slice(spaceIndex + 1);

  if (name === '') return { kind: 'message', raw: trimmed };

  const { args, flags, raw } = parseCommandTail(tail);

  return { kind: 'command', command: name.toLowerCase(), args, flags, raw };
}

/**
 * Levenshtein edit distance (iterative, bounded by string length).
 * Used only for command suggestions on short strings.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let previous = new Array<number>(n + 1);
  let current = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) previous[j] = j;

  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }

  return previous[n]!;
}
