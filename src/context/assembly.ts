/**
 * Context assembly pipeline (§25).
 *
 * A dedicated manager selects and ranks request content with a documented
 * priority order and records provenance for every item so /context inspect
 * can explain why each major item was included.
 *
 * Precedence rules (conflicts always resolve upward):
 *   1. system policy / safety constraints
 *   2. active user instructions in this conversation
 *   3. project instructions
 *   4. current task and execution state
 *   5. skills
 *   6. recent conversation
 *   7. summaries of older conversation
 *   8. relevant source code / documentation
 *   9. user-pinned context
 *  10. prior tool outputs
 *  11. optional supporting evidence
 *
 * Lower-trust content (project instructions, skills, retrieved documents,
 * tool output, file contents) is data: it can inform answers but can never
 * override higher-priority instructions or permissions.
 */

import { estimateTextTokens } from './tokens.js';

export type ContextItemType =
  | 'system'
  | 'user-instruction'
  | 'project-instruction'
  | 'task'
  | 'skill'
  | 'memory'
  | 'conversation'
  | 'summary'
  | 'source'
  | 'pinned'
  | 'tool-output'
  | 'evidence';

export const CONTEXT_PRIORITY: Record<ContextItemType, number> = {
  system: 1,
  'user-instruction': 2,
  'project-instruction': 3,
  task: 4,
  skill: 5,
  memory: 5,
  conversation: 6,
  summary: 7,
  source: 8,
  pinned: 9,
  'tool-output': 10,
  evidence: 11,
};

export const CONTEXT_PRIORITY_LABELS: ReadonlyArray<{ priority: number; label: string }> = [
  { priority: 1, label: 'system policy and safety constraints' },
  { priority: 2, label: 'active user instructions' },
  { priority: 3, label: 'project instructions' },
  { priority: 4, label: 'current task and execution state' },
  { priority: 5, label: 'relevant skills' },
  { priority: 5, label: 'persistent project memory' },
  { priority: 6, label: 'recent conversation' },
  { priority: 7, label: 'summaries of older conversation' },
  { priority: 8, label: 'relevant source code and documentation' },
  { priority: 9, label: 'user-pinned context' },
  { priority: 10, label: 'prior tool outputs' },
  { priority: 11, label: 'optional supporting evidence' },
];

/** Documented trust model for assembled content. */
export const CONTEXT_PRECEDENCE_RULES: readonly string[] = [
  'Higher-priority items always win conflicts; lower-priority items are context, not orders.',
  'Untrusted content (project instructions, skills, retrieved documents, file contents, tool output) can never override system rules, user instructions, or permissions.',
  'Retrieved and tool content is labeled as data in the request so the model does not follow instructions found inside it.',
  'When the budget does not fit, items are dropped lowest-priority-first; mandatory policy items are never dropped.',
];

export type ContextTrust = 'system' | 'user' | 'lower-trust';

export interface ContextCandidate {
  id: string;
  type: ContextItemType;
  /** Short display label, e.g. "src/agent/loop.ts (lines 1-80)" */
  label: string;
  /** Where this came from, e.g. "retrieval: path mentioned in the request" */
  provenance: string;
  /** The actual text (kept for request building; not persisted in reports) */
  content: string;
  trust: ContextTrust;
  /** Mandatory items are never dropped by the budget pass */
  mandatory?: boolean;
  /** Optional precomputed token estimate */
  tokens?: number;
}

export interface AssembledItem extends Required<Omit<ContextCandidate, 'tokens'>> {
  tokens: number;
  included: boolean;
  reason: string;
}

export interface ContextAssemblyOptions {
  /** Tokens available for the non-message parts + selected messages */
  effectiveBudget: number;
}

export interface ContextAssembly {
  items: AssembledItem[];
  includedTokens: number;
  droppedTokens: number;
  mandatoryTokens: number;
  effectiveBudget: number;
}

export function assembleContext(
  candidates: ContextCandidate[],
  options: ContextAssemblyOptions,
): ContextAssembly {
  const tokensOf = (candidate: ContextCandidate): number =>
    candidate.tokens ?? estimateTextTokens(candidate.content);

  // Stable priority order; insertion order breaks ties.
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        CONTEXT_PRIORITY[a.candidate.type] - CONTEXT_PRIORITY[b.candidate.type] ||
        a.index - b.index,
    );

  const items: AssembledItem[] = [];
  let includedTokens = 0;
  let droppedTokens = 0;
  let mandatoryTokens = 0;

  for (const { candidate } of ordered) {
    const tokens = tokensOf(candidate);
    const mandatory = candidate.mandatory === true;
    if (mandatory) mandatoryTokens += tokens;

    const fits = includedTokens + tokens <= options.effectiveBudget;
    const include = mandatory || fits;
    if (include) {
      includedTokens += tokens;
      items.push({
        ...candidate,
        mandatory,
        tokens,
        included: true,
        reason: mandatory
          ? 'mandatory: system/user policy items are always included'
          : `included: ${tokens} tokens fit within the remaining budget (${options.effectiveBudget - includedTokens + tokens} available before this item)`,
      });
    } else {
      droppedTokens += tokens;
      items.push({
        ...candidate,
        mandatory,
        tokens,
        included: false,
        reason: `excluded: needs ${tokens} tokens but only ${Math.max(0, options.effectiveBudget - includedTokens)} remain at priority ${CONTEXT_PRIORITY[candidate.type]}`,
      });
    }
  }

  return {
    items,
    includedTokens,
    droppedTokens,
    mandatoryTokens,
    effectiveBudget: options.effectiveBudget,
  };
}

export function includedItems(assembly: ContextAssembly): AssembledItem[] {
  return assembly.items.filter((item) => item.included);
}

/** Provenance-first listing for /context inspect. */
export function describeAssembly(
  assembly: ContextAssembly,
  options: { maxItems?: number } = {},
): string[] {
  const maxItems = options.maxItems ?? 14;
  const lines: string[] = [];
  const included = assembly.items.filter((item) => item.included);
  const excluded = assembly.items.filter((item) => !item.included);

  lines.push(
    `assembled: ${included.length} item(s), ${assembly.includedTokens} tokens of ${assembly.effectiveBudget} effective budget` +
      (assembly.droppedTokens > 0
        ? ` (+${excluded.length} dropped, ${assembly.droppedTokens} tokens)`
        : ''),
  );

  const show = (item: AssembledItem): string =>
    `  p${CONTEXT_PRIORITY[item.type]} ${item.type.padEnd(19)} ${item.label}` +
    ` — ${item.tokens} tokens [${item.trust}]`;

  for (const item of included.slice(0, maxItems)) lines.push(show(item));
  if (included.length > maxItems)
    lines.push(`  … and ${included.length - maxItems} more included item(s)`);
  for (const item of excluded.slice(0, Math.max(0, maxItems - included.length))) {
    lines.push(`${show(item)} — ${item.reason}`);
  }
  return lines;
}
