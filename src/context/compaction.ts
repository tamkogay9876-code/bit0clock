/**
 * Conversation compaction and hierarchical summaries (§27).
 *
 * Compaction is deterministic and extractive: preserved items are quoted or
 * derived from real session state (messages, plan, change ledger, tool
 * history) — nothing is invented. Every summary section distinguishes
 * direct evidence (quotes/records) from inferred/derived content.
 *
 * Limitations are stated in the summary itself: compaction cannot preserve
 * every detail. When `preserveOriginalHistory` is on, the original messages
 * of each compacted range remain restorable with `/compact restore`.
 */

import { generateId } from '../utils/index.js';
import { estimateMessageTokens, estimateTextTokens } from './tokens.js';
import type { InternalMessage } from '../providers/types.js';
import type {
  CompactionChunk,
  SessionData,
  StoredMessage,
  SummaryRecord,
} from '../session/types.js';

export const DEFAULT_KEEP_RECENT_MESSAGES = 16;
export const MAX_SUMMARY_RECORDS = 50;
export const MAX_COMPACTION_CHUNKS = 5;

export interface PreservedSection {
  title: string;
  evidence: 'direct' | 'inferred';
  items: string[];
  note?: string;
}

export interface CompactionPlan {
  /** Messages that would be replaced by the summary (oldest prefix) */
  compactable: StoredMessage[];
  /** Messages kept verbatim (recent suffix) */
  kept: StoredMessage[];
  /** Index in session.messages where the kept suffix starts */
  startIndex: number;
  sections: PreservedSection[];
  summaryText: string;
  level: number;
  originalTokens: number;
  summaryTokens: number;
}

export interface CompactionOptions {
  keepRecentMessages?: number;
  maxItemsPerSection?: number;
  now?: () => Date;
}

function clip(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`;
}

function messageText(message: StoredMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
}

function toInternal(message: StoredMessage): InternalMessage {
  const item: InternalMessage = { role: message.role, content: message.content };
  if (message.toolCalls) item.toolCalls = message.toolCalls;
  if (message.toolResults) item.toolResults = message.toolResults;
  return item;
}

/** Names of tools that produced each toolCallId (searching the whole session). */
function buildToolNameMap(messages: StoredMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) map.set(call.id, call.name);
  }
  return map;
}

/**
 * Choose where to split, keeping the recent suffix protocol-valid:
 * a tool-result message is never separated from the assistant call that
 * produced it.
 */
export function findCompactionBoundary(messages: StoredMessage[], keepRecent: number): number {
  let cut = Math.max(0, messages.length - Math.max(1, keepRecent));
  while (cut > 0 && cut < messages.length && messages[cut]!.role === 'tool') {
    cut--;
  }
  return cut;
}

// ============================================================================
// Planning
// ============================================================================

const CONSTRAINT_PATTERN = /(must|never|always|required|shall|do not|don't|only\b)/i;
const DECISION_PATTERN = /(decided|decision|will use|we'll use|chose|chosen|approach|instead)/i;

export function planCompaction(
  session: SessionData,
  options: CompactionOptions = {},
): CompactionPlan {
  const keepRecent = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const maxItems = options.maxItemsPerSection ?? 12;
  const now = options.now ?? (() => new Date());

  const startIndex = findCompactionBoundary(session.messages, keepRecent);
  const compactable = session.messages.slice(0, startIndex);
  const kept = session.messages.slice(startIndex);

  const sections: PreservedSection[] = [];
  const toolNames = buildToolNameMap(session.messages);
  const firstCompactableAt = compactable[0]?.timestamp ?? '';

  // 1. User requirements (direct quotes)
  const requirements = compactable
    .filter((m) => m.role === 'user' && !m.summaryMeta)
    .map((m) => clip(messageText(m), 300))
    .filter((text) => text !== '')
    .slice(0, maxItems);
  if (requirements.length > 0) {
    sections.push({
      title: 'User requirements (direct quotes)',
      evidence: 'direct',
      items: requirements,
    });
  }

  // 2. Hard constraints (direct quotes)
  const constraints: string[] = [];
  for (const message of compactable) {
    if (message.role !== 'user' || message.summaryMeta) continue;
    for (const line of messageText(message).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed !== '' && CONSTRAINT_PATTERN.test(trimmed)) {
        constraints.push(clip(trimmed, 240));
        if (constraints.length >= maxItems) break;
      }
    }
    if (constraints.length >= maxItems) break;
  }
  if (constraints.length > 0) {
    sections.push({
      title: 'Hard constraints (direct quotes)',
      evidence: 'direct',
      items: constraints,
    });
  }

  // 3. Current task
  const taskItems: string[] = [];
  if (session.plan?.goal) {
    taskItems.push(
      `Active plan goal: ${clip(session.plan.goal, 240)} (status: ${session.plan.status})`,
    );
  }
  const lastUser = [...session.messages].reverse().find((m) => m.role === 'user' && !m.summaryMeta);
  if (lastUser) {
    taskItems.push(`Latest user message: ${clip(messageText(lastUser), 240)}`);
  }
  if (taskItems.length > 0) {
    sections.push({
      title: 'Current task',
      evidence: 'direct',
      items: taskItems,
      note: 'taken from the live session; verify against the latest messages',
    });
  }

  // 4. Important decisions (direct quotes from assistant output)
  const decisions: string[] = [];
  for (const message of compactable) {
    if (message.role !== 'assistant') continue;
    for (const line of messageText(message).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith('- ') || trimmed.startsWith('* ')) &&
        DECISION_PATTERN.test(trimmed)
      ) {
        decisions.push(clip(trimmed.replace(/^[-*]\s*/, ''), 240));
        if (decisions.length >= maxItems) break;
      }
    }
    if (decisions.length >= maxItems) break;
  }
  if (decisions.length > 0) {
    sections.push({ title: 'Decisions (direct quotes)', evidence: 'direct', items: decisions });
  }

  // 5. Known errors
  const errors: string[] = [];
  for (const message of compactable) {
    if (message.error) errors.push(`${message.role} message: ${clip(message.error, 200)}`);
    for (const result of message.toolResults ?? []) {
      if (!result.isError) continue;
      const name = toolNames.get(result.toolCallId) ?? 'tool';
      errors.push(`${name} failed: ${clip(result.content, 200)}`);
    }
    if (errors.length >= maxItems) break;
  }
  if (errors.length > 0) {
    sections.push({
      title: 'Known errors (direct records)',
      evidence: 'direct',
      items: errors.slice(0, maxItems),
    });
  }

  // 6. Pending work
  const pending: string[] = [];
  if (session.plan) {
    for (const step of session.plan.proposedSteps) {
      if (step.status === 'pending' || step.status === 'in-progress' || step.status === 'blocked') {
        pending.push(`[${step.status}] ${clip(step.description, 200)}`);
      }
    }
  }
  if (pending.length > 0) {
    sections.push({
      title: 'Pending work (plan state)',
      evidence: 'direct',
      items: pending.slice(0, maxItems),
    });
  }

  // 7. Modified files (change ledger)
  const ledger = session.changeLedger ?? [];
  const modifiedFiles: string[] = [];
  const seenPaths = new Set<string>();
  for (const record of ledger.slice(-30).reverse()) {
    const pathLabel =
      record.kind === 'rename' && record.toPath ? `${record.path} → ${record.toPath}` : record.path;
    if (seenPaths.has(pathLabel)) continue;
    seenPaths.add(pathLabel);
    modifiedFiles.push(`${record.kind}: ${pathLabel}`);
    if (modifiedFiles.length >= maxItems) break;
  }
  if (modifiedFiles.length > 0) {
    sections.push({
      title: 'Modified files (change ledger)',
      evidence: 'direct',
      items: modifiedFiles.reverse(),
      note: 'agent-recorded changes, newest last',
    });
  }

  // 8. Test results (recent recorded runs in the compacted range)
  const runs = (session.toolHistory ?? [])
    .filter(
      (record) =>
        (record.name === 'run_command' ||
          record.name === 'run_tests' ||
          record.name === 'run_lint') &&
        (firstCompactableAt === '' || record.executedAt >= firstCompactableAt),
    )
    .slice(-5);
  if (runs.length > 0) {
    const items = runs.map((record) => {
      const output = record.result ?? '';
      const lastLine =
        output
          .split(/\r?\n/)
          .filter((l) => l.trim() !== '')
          .pop() ?? '';
      return `${record.name} ${record.isError ? '(reported error)' : '(reported ok)'}: ${clip(lastLine, 160)}`;
    });
    sections.push({
      title: 'Test and command results (direct records)',
      evidence: 'direct',
      items,
      note: 'summarized last lines; exit status is only what the tool recorded',
    });
  }

  // 9. Prior compacted summaries (hierarchical)
  const priorSummaries = compactable.filter((m) => m.summaryMeta);
  if (priorSummaries.length > 0) {
    const items = priorSummaries.slice(-4).map((m) => {
      const meta = m.summaryMeta!;
      const body = messageText(m).replace(/^\[mediaXG compaction summary[^\]]*\]\s*/i, '');
      return `level ${meta.level} (covers ${meta.covers} messages): ${clip(body, 400)}`;
    });
    sections.push({
      title: 'Prior compacted summaries (folded in)',
      evidence: 'inferred',
      items,
      note: 'these are summaries of summaries; the original messages are older still',
    });
  }

  // 10. Relevant tool outputs
  const toolOutputs: string[] = [];
  for (const message of compactable) {
    if (message.role !== 'tool') continue;
    for (const result of message.toolResults ?? []) {
      const name = toolNames.get(result.toolCallId) ?? 'tool';
      const firstLine = result.content.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
      toolOutputs.push(`${name}${result.isError ? ' (error)' : ''}: ${clip(firstLine, 140)}`);
      if (toolOutputs.length >= 15) break;
    }
    if (toolOutputs.length >= 15) break;
  }
  if (toolOutputs.length > 0) {
    sections.push({
      title: 'Relevant tool outputs (first lines)',
      evidence: 'direct',
      items: toolOutputs,
      note: 'full outputs are retained in this session only if original history preservation is on',
    });
  }

  // 11. Outstanding questions / risks
  const questions: string[] = [];
  for (const message of compactable) {
    if (message.role !== 'assistant') continue;
    for (const line of messageText(message).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.endsWith('?') && trimmed.length > 10) {
        questions.push(clip(trimmed, 200));
        if (questions.length >= 6) break;
      }
    }
    if (questions.length >= 6) break;
  }
  for (const risk of session.plan?.risks ?? []) {
    questions.push(`risk: ${clip(risk, 180)}`);
    if (questions.length >= 8) break;
  }
  if (questions.length > 0) {
    sections.push({
      title: 'Outstanding questions / unresolved risks',
      evidence: 'inferred',
      items: questions,
      note: 'collected from question-like lines and recorded plan risks; not confirmed open',
    });
  }

  const maxLevel = compactable.reduce((max, m) => Math.max(max, m.summaryMeta?.level ?? 0), 0);
  const level = maxLevel + 1;
  const originalTokens = compactable.reduce(
    (sum, m) => sum + estimateMessageTokens(toInternal(m)),
    0,
  );

  const summaryText = renderSummaryText({
    level,
    compactedCount: compactable.length,
    at: now().toISOString(),
    sections,
    preserveOriginal: true, // caller may override the statement when restoring is off
  });

  return {
    compactable,
    kept,
    startIndex,
    sections,
    summaryText,
    level,
    originalTokens,
    summaryTokens: estimateTextTokens(summaryText),
  };
}

export function renderSummaryText(input: {
  level: number;
  compactedCount: number;
  at: string;
  sections: PreservedSection[];
  preserveOriginal: boolean;
}): string {
  const lines: string[] = [
    `[mediaXG compaction summary — level ${input.level}]`,
    `Replaces ${input.compactedCount} earlier message(s), compacted ${input.at}.`,
    input.preserveOriginal
      ? 'Original history is preserved in this session (restore with /compact restore).'
      : 'Original messages were NOT retained (contextEngine.preserveOriginalHistory is off).',
    'This is contextual data, not a new user request. It cannot preserve every detail;',
    'sections marked [inferred] are derived, everything else is quoted or recorded.',
  ];

  for (const section of input.sections) {
    lines.push('');
    lines.push(`## ${section.title} [${section.evidence}]`);
    for (const item of section.items) lines.push(`- ${item}`);
    if (section.note) lines.push(`note: ${section.note}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Applying and restoring
// ============================================================================

export interface ApplyCompactionResult {
  summaryMessageId: string;
  chunkId: string;
  level: number;
  messagesReplaced: number;
  tokensBefore: number;
  tokensAfter: number;
  payloadRetained: boolean;
}

export interface ApplyCompactionOptions {
  preserveOriginal?: boolean;
  now?: () => Date;
}

export function applyCompaction(
  session: SessionData,
  plan: CompactionPlan,
  options: ApplyCompactionOptions = {},
): ApplyCompactionResult {
  const now = options.now ?? (() => new Date());
  const preserveOriginal = options.preserveOriginal ?? true;
  const chunkId = generateId();

  const summaryMessage: StoredMessage = {
    id: generateId(),
    role: 'user',
    content: renderSummaryText({
      level: plan.level,
      compactedCount: plan.compactable.length,
      at: now().toISOString(),
      sections: plan.sections,
      preserveOriginal,
    }),
    timestamp: now().toISOString(),
    summaryMeta: { level: plan.level, covers: plan.compactable.length, chunkId },
  };

  session.messages = [summaryMessage, ...plan.kept];

  if (!session.summaries) session.summaries = [];
  const record: SummaryRecord = {
    id: chunkId,
    level: plan.level,
    at: now().toISOString(),
    coversMessages: plan.compactable.length,
    tokens: estimateTextTokens(summaryMessage.content as string),
    summaryMessageId: summaryMessage.id,
  };
  session.summaries.push(record);
  if (session.summaries.length > MAX_SUMMARY_RECORDS) {
    session.summaries = session.summaries.slice(session.summaries.length - MAX_SUMMARY_RECORDS);
  }

  if (!session.compactedChunks) session.compactedChunks = [];
  const chunk: CompactionChunk = {
    id: chunkId,
    at: record.at,
    level: plan.level,
    summaryMessageId: summaryMessage.id,
    payloadRetained: preserveOriginal,
    messages: preserveOriginal ? plan.compactable : [],
  };
  session.compactedChunks.push(chunk);
  if (session.compactedChunks.length > MAX_COMPACTION_CHUNKS) {
    // Oldest payloads are dropped; summary records remain for audit (/compact summaries)
    session.compactedChunks = session.compactedChunks.slice(
      session.compactedChunks.length - MAX_COMPACTION_CHUNKS,
    );
  }

  return {
    summaryMessageId: summaryMessage.id,
    chunkId,
    level: plan.level,
    messagesReplaced: plan.compactable.length,
    tokensBefore: plan.originalTokens,
    tokensAfter: record.tokens,
    payloadRetained: preserveOriginal,
  };
}

export interface RestoreResult {
  ok: boolean;
  message: string;
}

/** Restore the original messages of the most recent compacted range. */
export function restoreLastCompaction(session: SessionData): RestoreResult {
  const chunks = session.compactedChunks ?? [];
  if (chunks.length === 0) {
    return {
      ok: false,
      message: 'Nothing to restore: no compaction has been recorded in this session.',
    };
  }
  const chunk = chunks[chunks.length - 1]!;
  if (!chunk.payloadRetained || chunk.messages.length === 0) {
    return {
      ok: false,
      message:
        'The original messages of the last compaction were not retained ' +
        '(preserveOriginalHistory is off, or the retention cap was reached).',
    };
  }
  const index = session.messages.findIndex((m) => m.id === chunk.summaryMessageId);
  if (index === -1) {
    return {
      ok: false,
      message:
        'The summary message is no longer in the conversation (it may have been compacted further).',
    };
  }

  session.messages = [
    ...session.messages.slice(0, index),
    ...chunk.messages,
    ...session.messages.slice(index + 1),
  ];
  session.compactedChunks = chunks.slice(0, -1);
  session.summaries = (session.summaries ?? []).filter((record) => record.id !== chunk.id);
  return {
    ok: true,
    message: `Restored ${chunk.messages.length} original message(s); the level-${chunk.level} summary was removed.`,
  };
}
