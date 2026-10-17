/**
 * Change ledger: an undo journal for agent-made file changes (§43).
 *
 * Records are small, inspectable, and persisted with the session. Only
 * changes made through native tools are recorded; user edits are never
 * captured, and undo refuses to touch files that changed since the agent
 * wrote them.
 */

import { createHash } from 'crypto';
import { generateId } from '../utils/index.js';

export const LEDGER_MAX_RECORDS = 100;
/** Content snapshots larger than this are recorded as hashes only. */
export const LEDGER_MAX_SNAPSHOT_BYTES = 256 * 1024;

export type ChangeKind = 'create' | 'edit' | 'patch' | 'rename' | 'delete';

export interface ChangeRecord {
  id: string;
  /** Tool call that produced this change (when known) */
  toolCallId?: string;
  kind: ChangeKind;
  /** Workspace-relative path */
  path: string;
  /** Rename target (workspace-relative) */
  toPath?: string;
  beforeContent?: string;
  afterContent?: string;
  beforeHash?: string;
  afterHash?: string;
  createdAt: string;
  reverted?: boolean;
  /** Set when a snapshot was too large to store for undo */
  undoUnavailableReason?: string;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export interface RecordChangeInput {
  kind: ChangeKind;
  path: string;
  toolCallId?: string;
  toPath?: string;
  beforeContent?: string | null;
  afterContent?: string | null;
}

export function createChangeRecord(input: RecordChangeInput): ChangeRecord {
  const record: ChangeRecord = {
    id: generateId(),
    kind: input.kind,
    path: input.path,
    createdAt: new Date().toISOString(),
  };
  if (input.toolCallId) record.toolCallId = input.toolCallId;
  if (input.toPath) record.toPath = input.toPath;

  let tooLarge = false;
  if (input.beforeContent !== null && input.beforeContent !== undefined) {
    record.beforeHash = hashContent(input.beforeContent);
    if (Buffer.byteLength(input.beforeContent, 'utf8') <= LEDGER_MAX_SNAPSHOT_BYTES) {
      record.beforeContent = input.beforeContent;
    } else {
      tooLarge = true;
    }
  }
  if (input.afterContent !== null && input.afterContent !== undefined) {
    record.afterHash = hashContent(input.afterContent);
    if (Buffer.byteLength(input.afterContent, 'utf8') <= LEDGER_MAX_SNAPSHOT_BYTES) {
      record.afterContent = input.afterContent;
    } else {
      tooLarge = true;
    }
  }
  if (tooLarge) {
    record.undoUnavailableReason = `content exceeded ${LEDGER_MAX_SNAPSHOT_BYTES} bytes; only hashes were recorded`;
  }
  return record;
}

export function appendChange(records: ChangeRecord[], record: ChangeRecord): ChangeRecord[] {
  const next = [...records, record];
  return next.length > LEDGER_MAX_RECORDS ? next.slice(next.length - LEDGER_MAX_RECORDS) : next;
}

/** Undoable records, most recent first. */
export function pendingUndoRecords(records: ChangeRecord[]): ChangeRecord[] {
  return records
    .filter((r) => !r.reverted)
    .slice()
    .reverse();
}

export interface UndoOutcome {
  record: ChangeRecord;
  ok: boolean;
  message: string;
}

export interface UndoSummary {
  attempted: number;
  reverted: number;
  outcomes: UndoOutcome[];
}
