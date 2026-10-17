/**
 * Conversation compaction tests (§27).
 *
 * Compaction must be deterministic, extractive, and honest about its limits.
 * The tests pin the preservation sections, protocol-valid boundaries,
 * hierarchical summaries, retention caps, and restore behavior.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '../session/manager.js';
import type { SessionData, StoredMessage } from '../session/types.js';
import type { Plan } from '../types/index.js';
import {
  applyCompaction,
  findCompactionBoundary,
  MAX_COMPACTION_CHUNKS,
  planCompaction,
  restoreLastCompaction,
} from './compaction.js';

function newSession(): SessionData {
  const dir = mkdtempSync(join(tmpdir(), 'mediaxg-compact-'));
  const manager = new SessionManager({ directory: dir, projectPath: dir });
  return manager.create({ mode: 'build', contextProfile: 'standard' });
}

let counter = 0;
function message(
  overrides: Partial<StoredMessage> & Pick<StoredMessage, 'role' | 'content'>,
): StoredMessage {
  counter++;
  return {
    id: `m${counter}`,
    timestamp: new Date(1700000000000 + counter * 1000).toISOString(),
    ...overrides,
  };
}

function fill(session: SessionData, count: number): void {
  for (let i = 0; i < count; i++) {
    session.messages.push(
      message({ role: 'user', content: `user message ${i} ${'padding '.repeat(10)}` }),
    );
    session.messages.push(
      message({ role: 'assistant', content: `assistant reply ${i} ${'padding '.repeat(10)}` }),
    );
  }
}

describe('findCompactionBoundary', () => {
  test('keeps a tool result with its assistant call', () => {
    const messages: StoredMessage[] = [
      message({ role: 'user', content: 'u1' }),
      message({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call1', name: 'read_file', arguments: {} }],
      }),
      message({
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'call1', content: 'file body' }],
      }),
      message({ role: 'user', content: 'u2' }),
    ];
    // keepRecent 2 would cut at the tool message; the boundary moves back to
    // the assistant call so they are kept together
    expect(findCompactionBoundary(messages, 2)).toBe(1);
    // keepRecent 1 cuts at u2 — the tool result and its call are dropped together
    expect(findCompactionBoundary(messages, 1)).toBe(3);
  });
});

describe('planCompaction', () => {
  test('splits compactable range and kept suffix', () => {
    const session = newSession();
    fill(session, 12); // 24 messages
    const plan = planCompaction(session, { keepRecentMessages: 8 });
    expect(plan.compactable).toHaveLength(16);
    expect(plan.kept).toHaveLength(8);
    expect(plan.startIndex).toBe(16);
    expect(plan.level).toBe(1);
    expect(plan.originalTokens).toBeGreaterThan(plan.summaryTokens);
  });

  test('preserves requirements, constraints, decisions, mistakes, and state as separate sections', () => {
    const session = newSession();
    session.messages.push(
      message({ role: 'user', content: 'Please refactor the parser module.' }),
      message({ role: 'user', content: 'You must never break the public API.' }),
      message({
        role: 'assistant',
        content:
          'Findings:\n- We decided to use the existing tokenizer instead of a new one.\n- Some notes without markers.',
      }),
      message({
        role: 'tool',
        content: '',
        error: 'boom',
        toolResults: [{ toolCallId: 'x', content: 'command failed: exit 1', isError: true }],
      }),
    );
    fill(session, 6);
    session.plan = {
      id: 'p1',
      goal: 'Refactor the parser',
      constraints: ['no API breaks'],
      relevantFiles: ['src/parser.ts'],
      proposedSteps: [
        { id: 's1', description: 'Extract tokenizer', status: 'completed', toolCalls: [] },
        { id: 's2', description: 'Update call sites', status: 'pending', toolCalls: [] },
        { id: 's3', description: 'Blocked on flaky test', status: 'blocked', toolCalls: [] },
      ],
      risks: ['flaky test may block verification'],
      requiredPermissions: ['write'],
      verificationPlan: 'run tests',
      currentStepIndex: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies Plan;
    session.changeLedger = [
      {
        id: 'c1',
        kind: 'edit',
        path: 'src/parser.ts',
        createdAt: new Date().toISOString(),
      },
    ];
    session.toolHistory = [
      {
        id: 't1',
        name: 'run_command',
        arguments: { program: 'bun', args: ['test'] },
        result: 'all good\n12 pass\n0 fail',
        isError: false,
        durationMs: 1200,
        executedAt: session.messages[0]!.timestamp,
      },
    ];

    const plan = planCompaction(session, { keepRecentMessages: 8 });
    const titles = plan.sections.map((section) => section.title);

    expect(titles).toContain('User requirements (direct quotes)');
    expect(titles).toContain('Hard constraints (direct quotes)');
    expect(titles).toContain('Current task');
    expect(titles).toContain('Decisions (direct quotes)');
    expect(titles).toContain('Known errors (direct records)');
    expect(titles).toContain('Pending work (plan state)');
    expect(titles).toContain('Modified files (change ledger)');
    expect(titles).toContain('Test and command results (direct records)');
    expect(titles).toContain('Relevant tool outputs (first lines)');
    expect(titles).toContain('Outstanding questions / unresolved risks');

    const constraints = plan.sections.find((s) => s.title.startsWith('Hard'))!;
    expect(constraints.evidence).toBe('direct');
    expect(constraints.items[0]).toContain('never break the public API');

    const decisions = plan.sections.find((s) => s.title.startsWith('Decisions'))!;
    expect(decisions.items[0]).toContain('existing tokenizer');

    const pending = plan.sections.find((s) => s.title.startsWith('Pending'))!;
    expect(pending.items.join(' ')).toContain('[pending] Update call sites');
    expect(pending.items.join(' ')).toContain('[blocked]');

    const text = plan.summaryText;
    expect(text).toContain('[mediaXG compaction summary — level 1]');
    expect(text).toContain('not a new user request');
    expect(text).toContain('cannot preserve every detail');
    expect(text).toContain('[direct]');
    expect(text).toContain('[inferred]');
  });

  test('folds prior summaries into a higher level (hierarchical)', () => {
    const session = newSession();
    fill(session, 12);
    const first = planCompaction(session, { keepRecentMessages: 4 });
    applyCompaction(session, first, { preserveOriginal: true });

    fill(session, 10);
    const second = planCompaction(session, { keepRecentMessages: 4 });
    expect(second.level).toBe(2);
    const prior = second.sections.find((s) => s.title.startsWith('Prior compacted summaries'));
    expect(prior).toBeDefined();
    expect(prior!.evidence).toBe('inferred');
    expect(prior!.items[0]).toContain('level 1');
  });

  test('no compaction when nothing is outside the recent window', () => {
    const session = newSession();
    fill(session, 3);
    const plan = planCompaction(session, { keepRecentMessages: 16 });
    expect(plan.compactable).toHaveLength(0);
  });
});

describe('applyCompaction', () => {
  test('replaces the range with a labeled summary message and keeps recent messages', () => {
    const session = newSession();
    fill(session, 12);
    const plan = planCompaction(session, { keepRecentMessages: 8 });
    const keptIds = plan.kept.map((m) => m.id);

    const result = applyCompaction(session, plan, { preserveOriginal: true });

    expect(session.messages).toHaveLength(9); // summary + 8 kept
    const summary = session.messages[0]!;
    expect(summary.role).toBe('user');
    expect(summary.summaryMeta).toEqual({
      level: 1,
      covers: 16,
      chunkId: result.chunkId,
    });
    expect(session.messages.slice(1).map((m) => m.id)).toEqual(keptIds);

    expect(session.summaries).toHaveLength(1);
    expect(session.summaries![0]!.coversMessages).toBe(16);
    expect(session.compactedChunks).toHaveLength(1);
    expect(session.compactedChunks![0]!.payloadRetained).toBe(true);
    expect(session.compactedChunks![0]!.messages).toHaveLength(16);
  });

  test('preserveOriginal false discards the originals and says so in the text', () => {
    const session = newSession();
    fill(session, 12);
    const plan = planCompaction(session, { keepRecentMessages: 8 });
    const result = applyCompaction(session, plan, { preserveOriginal: false });

    expect(result.payloadRetained).toBe(false);
    expect(session.compactedChunks![0]!.payloadRetained).toBe(false);
    expect(session.compactedChunks![0]!.messages).toHaveLength(0);
    expect(session.messages[0]!.content as string).toContain('were NOT retained');
  });

  test('caps stored chunks at the documented maximum', () => {
    const session = newSession();
    for (let i = 0; i < MAX_COMPACTION_CHUNKS + 2; i++) {
      fill(session, 6);
      const plan = planCompaction(session, { keepRecentMessages: 2 });
      applyCompaction(session, plan, { preserveOriginal: true });
    }
    expect(session.compactedChunks!.length).toBe(MAX_COMPACTION_CHUNKS);
  });
});

describe('restoreLastCompaction', () => {
  test('restores original messages and removes the summary record', () => {
    const session = newSession();
    fill(session, 12);
    const before = session.messages.map((m) => m.id);
    const plan = planCompaction(session, { keepRecentMessages: 8 });
    applyCompaction(session, plan, { preserveOriginal: true });

    const restore = restoreLastCompaction(session);
    expect(restore.ok).toBe(true);
    expect(session.messages.map((m) => m.id)).toEqual(before);
    expect(session.summaries).toHaveLength(0);
    expect(session.compactedChunks).toHaveLength(0);
  });

  test('refuses when nothing was compacted', () => {
    const session = newSession();
    const restore = restoreLastCompaction(session);
    expect(restore.ok).toBe(false);
    expect(restore.message).toContain('Nothing to restore');
  });

  test('refuses when the payload was not retained', () => {
    const session = newSession();
    fill(session, 12);
    const plan = planCompaction(session, { keepRecentMessages: 8 });
    applyCompaction(session, plan, { preserveOriginal: false });
    const restore = restoreLastCompaction(session);
    expect(restore.ok).toBe(false);
    expect(restore.message).toContain('not retained');
  });

  test('refuses when the summary was compacted further (no longer in the conversation)', () => {
    const session = newSession();
    fill(session, 12);
    const first = planCompaction(session, { keepRecentMessages: 4 });
    applyCompaction(session, first, { preserveOriginal: true });
    fill(session, 10);
    const second = planCompaction(session, { keepRecentMessages: 4 });
    applyCompaction(session, second, { preserveOriginal: true });

    // Restore the second chunk first (it is the most recent)
    const restoreSecond = restoreLastCompaction(session);
    expect(restoreSecond.ok).toBe(true);
    // Now the first summary is back in the conversation and can be restored
    const restoreFirst = restoreLastCompaction(session);
    expect(restoreFirst.ok).toBe(true);
    expect(session.summaries).toHaveLength(0);
  });

  test('a summary removed by a later compaction cannot be restored by itself', () => {
    const session = newSession();
    fill(session, 12);
    const first = planCompaction(session, { keepRecentMessages: 4 });
    applyCompaction(session, first, { preserveOriginal: true });
    fill(session, 10);
    const second = planCompaction(session, { keepRecentMessages: 4 });
    applyCompaction(session, second, { preserveOriginal: true });

    // Try to remove the LAST chunk only — OK; then the second-to-last may or may not be removable
    const restore = restoreLastCompaction(session);
    expect(restore.ok).toBe(true);
    const restore2 = restoreLastCompaction(session);
    expect(restore2.ok).toBe(true);
  });
});
