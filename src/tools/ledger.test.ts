/**
 * Change ledger and undo tests (§43): record shape, bounds, and the rule that
 * undo never overwrites user changes.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LEDGER_MAX_RECORDS,
  appendChange,
  createChangeRecord,
  hashContent,
  pendingUndoRecords,
  type ChangeRecord,
} from './ledger.js';
import { undoChanges } from './undo.js';
import { WorkspacePaths } from './paths.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-ledger-'));
}

describe('createChangeRecord', () => {
  it('records snapshots and hashes for undo', () => {
    const record = createChangeRecord({
      kind: 'edit',
      path: 'a.txt',
      beforeContent: 'old',
      afterContent: 'new',
    });

    expect(record.beforeContent).toBe('old');
    expect(record.afterContent).toBe('new');
    expect(record.beforeHash).toBe(hashContent('old'));
    expect(record.afterHash).toBe(hashContent('new'));
    expect(record.reverted).toBeUndefined();
    expect(record.undoUnavailableReason).toBeUndefined();
  });

  it('records hashes only for oversized snapshots', () => {
    const huge = 'x'.repeat(300_000);
    const record = createChangeRecord({ kind: 'edit', path: 'big.txt', afterContent: huge });

    expect(record.afterContent).toBeUndefined();
    expect(record.afterHash).toBeDefined();
    expect(record.undoUnavailableReason).toContain('exceeded');
  });
});

describe('appendChange / pendingUndoRecords', () => {
  it('caps the ledger at the record limit', () => {
    let records: ChangeRecord[] = [];
    for (let i = 0; i < LEDGER_MAX_RECORDS + 5; i++) {
      records = appendChange(records, createChangeRecord({ kind: 'create', path: `f${i}.txt` }));
    }
    expect(records).toHaveLength(LEDGER_MAX_RECORDS);
    expect(records[0]?.path).toBe('f5.txt');
  });

  it('returns pending records most recent first and skips reverted ones', () => {
    const first = createChangeRecord({ kind: 'create', path: 'a.txt' });
    const second = createChangeRecord({ kind: 'create', path: 'b.txt' });
    const reverted = { ...createChangeRecord({ kind: 'create', path: 'c.txt' }), reverted: true };

    expect(pendingUndoRecords([first, second, reverted]).map((record) => record.path)).toEqual([
      'b.txt',
      'a.txt',
    ]);
  });
});

describe('undoChanges', () => {
  it('removes files created by the agent when they are unchanged', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    writeFileSync(join(root, 'created.txt'), 'agent wrote this');

    const records = [
      createChangeRecord({ kind: 'create', path: 'created.txt', afterContent: 'agent wrote this' }),
    ];
    const summary = undoChanges(records, paths, 1);

    expect(summary.reverted).toBe(1);
    expect(existsSync(join(root, 'created.txt'))).toBe(false);
    expect(records[0]?.reverted).toBe(true);
  });

  it('refuses to delete a file the user changed after the agent created it', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    writeFileSync(join(root, 'created.txt'), 'user changed it');

    const records = [
      createChangeRecord({ kind: 'create', path: 'created.txt', afterContent: 'agent wrote this' }),
    ];
    const summary = undoChanges(records, paths, 1);

    expect(summary.reverted).toBe(0);
    expect(summary.outcomes[0]?.message).toContain('changed since');
    expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('user changed it');
  });

  it('restores previous content for edits', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    writeFileSync(join(root, 'code.txt'), 'new content');

    const records = [
      createChangeRecord({
        kind: 'edit',
        path: 'code.txt',
        beforeContent: 'old content',
        afterContent: 'new content',
      }),
    ];
    const summary = undoChanges(records, paths, 1);

    expect(summary.reverted).toBe(1);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('old content');
  });

  it('refuses to overwrite files modified since the agent edit', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    writeFileSync(join(root, 'code.txt'), 'user typed here');

    const records = [
      createChangeRecord({
        kind: 'edit',
        path: 'code.txt',
        beforeContent: 'old content',
        afterContent: 'agent content',
      }),
    ];
    const summary = undoChanges(records, paths, 1);

    expect(summary.reverted).toBe(0);
    expect(summary.outcomes[0]?.message).toContain('modified since');
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('user typed here');
  });

  it('recreates deleted files from the snapshot', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);

    const records = [
      createChangeRecord({ kind: 'delete', path: 'gone.txt', beforeContent: 'precious data' }),
    ];
    const summary = undoChanges(records, paths, 1);

    expect(summary.reverted).toBe(1);
    expect(readFileSync(join(root, 'gone.txt'), 'utf8')).toBe('precious data');
  });

  it('refuses to recreate when no snapshot was recorded', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    const record = createChangeRecord({ kind: 'delete', path: 'gone.txt' });

    const summary = undoChanges([record], paths, 1);
    expect(summary.reverted).toBe(0);
    expect(summary.outcomes[0]?.message).toContain('no content snapshot');
  });

  it('renames files back and refuses when the target changed', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    writeFileSync(join(root, 'moved.txt'), 'agent payload');

    const records = [
      createChangeRecord({
        kind: 'rename',
        path: 'original.txt',
        toPath: 'moved.txt',
        afterContent: 'agent payload',
      }),
    ];
    let summary = undoChanges(records, paths, 1);
    expect(summary.reverted).toBe(1);
    expect(readFileSync(join(root, 'original.txt'), 'utf8')).toBe('agent payload');
    expect(existsSync(join(root, 'moved.txt'))).toBe(false);

    // Second scenario: user edited the renamed file; undo must refuse.
    const root2 = makeRoot();
    const paths2 = new WorkspacePaths(root2);
    writeFileSync(join(root2, 'moved.txt'), 'user edited');
    const records2 = [
      createChangeRecord({
        kind: 'rename',
        path: 'original.txt',
        toPath: 'moved.txt',
        afterContent: 'agent payload',
      }),
    ];
    summary = undoChanges(records2, paths2, 1);
    expect(summary.reverted).toBe(0);
    expect(summary.outcomes[0]?.message).toContain('modified since');
    expect(existsSync(join(root2, 'moved.txt'))).toBe(true);
  });

  it('reverts the last N changes, most recent first', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    writeFileSync(join(root, 'one.txt'), 'first');
    writeFileSync(join(root, 'two.txt'), 'second');

    const records = [
      createChangeRecord({ kind: 'create', path: 'one.txt', afterContent: 'first' }),
      createChangeRecord({ kind: 'create', path: 'two.txt', afterContent: 'second' }),
    ];
    const summary = undoChanges(records, paths, 2);

    expect(summary.attempted).toBe(2);
    expect(summary.reverted).toBe(2);
    expect(existsSync(join(root, 'one.txt'))).toBe(false);
    expect(existsSync(join(root, 'two.txt'))).toBe(false);
  });
});
