/**
 * Undo executor for ledger records (§43).
 *
 * Only reverses changes whose current on-disk state still matches what the
 * agent wrote. If the user (or another process) modified the file since,
 * the reversal is refused — user work is never overwritten silently.
 */

import { existsSync, readFileSync, renameSync, unlinkSync } from 'fs';
import type { WorkspacePaths } from './paths.js';
import { ToolError } from './types.js';
import { atomicWriteFile } from './file-utils.js';
import {
  hashContent,
  pendingUndoRecords,
  type ChangeRecord,
  type UndoOutcome,
  type UndoSummary,
} from './ledger.js';

export function undoChanges(
  records: ChangeRecord[],
  paths: WorkspacePaths,
  count = 1,
): UndoSummary {
  const targets = pendingUndoRecords(records).slice(0, Math.max(1, count));
  const outcomes: UndoOutcome[] = [];
  const updated = new Map<string, ChangeRecord>();

  for (const record of targets) {
    const outcome = undoOne(record, paths);
    outcomes.push(outcome);
    updated.set(record.id, outcome.record);
  }

  // Apply reversions immutably to the ledger
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const replacement = updated.get(record.id);
    if (replacement) records[i] = replacement;
  }

  return {
    attempted: outcomes.length,
    reverted: outcomes.filter((o) => o.ok).length,
    outcomes,
  };
}

function undoOne(record: ChangeRecord, paths: WorkspacePaths): UndoOutcome {
  try {
    switch (record.kind) {
      case 'create':
        return undoCreate(record, paths);
      case 'edit':
      case 'patch':
        return undoWrite(record, paths);
      case 'delete':
        return undoDelete(record, paths);
      case 'rename':
        return undoRename(record, paths);
    }
  } catch (err) {
    const message =
      err instanceof ToolError ? err.message : err instanceof Error ? err.message : String(err);
    return { record, ok: false, message };
  }
}

function markReverted(record: ChangeRecord, message: string): UndoOutcome {
  return { record: { ...record, reverted: true }, ok: true, message };
}

function fail(record: ChangeRecord, message: string): UndoOutcome {
  return { record, ok: false, message };
}

function currentHash(abs: string): string {
  const buffer = readFileSync(abs);
  if (buffer.includes(0)) {
    throw new ToolError('Current file is binary; refusing to touch it', { code: 'unsupported' });
  }
  return hashContent(buffer.toString('utf8'));
}

function undoCreate(record: ChangeRecord, paths: WorkspacePaths): UndoOutcome {
  const { abs, rel } = paths.absoluteFor(record.path);
  if (!existsSync(abs)) {
    return markReverted(record, `${rel}: already absent — nothing to revert`);
  }
  if (record.afterHash && currentHash(abs) !== record.afterHash) {
    return fail(
      record,
      `${rel}: changed since the agent created it; refusing to delete (user work is preserved)`,
    );
  }
  unlinkSync(abs);
  return markReverted(record, `${rel}: removed (undo of create_file)`);
}

function undoWrite(record: ChangeRecord, paths: WorkspacePaths): UndoOutcome {
  const { abs, rel } = paths.absoluteFor(record.path);
  if (record.undoUnavailableReason || record.beforeContent === undefined) {
    return fail(
      record,
      `${rel}: no content snapshot available (${record.undoUnavailableReason ?? 'not recorded'})`,
    );
  }
  if (!existsSync(abs)) {
    return fail(record, `${rel}: file no longer exists; refusing to recreate`);
  }
  if (record.afterHash && currentHash(abs) !== record.afterHash) {
    return fail(
      record,
      `${rel}: modified since this agent edit; refusing to overwrite (user work is preserved)`,
    );
  }
  atomicWriteFile(abs, record.beforeContent);
  return markReverted(record, `${rel}: restored previous content`);
}

function undoDelete(record: ChangeRecord, paths: WorkspacePaths): UndoOutcome {
  const { abs, rel } = paths.absoluteFor(record.path);
  if (existsSync(abs)) {
    if (record.beforeHash && currentHash(abs) === record.beforeHash) {
      return markReverted(record, `${rel}: already restored`);
    }
    return fail(record, `${rel}: a file exists again at this path; refusing to overwrite it`);
  }
  if (record.undoUnavailableReason || record.beforeContent === undefined) {
    return fail(
      record,
      `${rel}: no content snapshot available (${record.undoUnavailableReason ?? 'not recorded'})`,
    );
  }
  atomicWriteFile(abs, record.beforeContent);
  return markReverted(record, `${rel}: recreated (undo of delete_file)`);
}

function undoRename(record: ChangeRecord, paths: WorkspacePaths): UndoOutcome {
  if (!record.toPath) {
    return fail(record, `${record.path}: rename target missing from record`);
  }
  const from = paths.absoluteFor(record.path);
  const to = paths.absoluteFor(record.toPath);
  if (existsSync(from.abs)) {
    return fail(record, `${from.rel}: original path exists again; refusing to overwrite`);
  }
  if (!existsSync(to.abs)) {
    return fail(record, `${to.rel}: renamed file is missing; cannot move it back`);
  }
  if (record.afterHash && currentHash(to.abs) !== record.afterHash) {
    return fail(record, `${to.rel}: modified since the rename; refusing to move it back`);
  }
  renameSync(to.abs, from.abs);
  return markReverted(record, `${to.rel} → ${from.rel}: renamed back`);
}
