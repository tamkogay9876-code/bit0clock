/**
 * Mutating filesystem tools: create_file, edit_file, apply_patch,
 * rename_file, delete_file (§40, §43).
 *
 * Every change is recorded in the session change ledger for `/undo`.
 * Expected-state checks and exact-text matching protect unrelated edits.
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import { applyPatch, diffLines, parsePatch } from 'diff';
import { defineTool, toolOk, ToolError, type RegisteredTool } from './types.js';
import type { WorkspacePaths } from './paths.js';
import {
  MAX_WRITE_BYTES,
  atomicWriteFile,
  countOccurrences,
  decodeTextStrict,
  readTextFileFull,
  looksBinary,
} from './file-utils.js';
import { createChangeRecord, type ChangeRecord } from './ledger.js';

/** Receives change records; implemented by the agent loop (session-backed). */
export interface ChangeJournal {
  add(record: ChangeRecord): void;
  /** Tool call currently executing (set by the loop before each execute) */
  toolCallId?: string;
}

function lineDelta(before: string, after: string): string {
  const changes = diffLines(before, after);
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const count = change.count ?? change.value.split('\n').length;
    if (change.added) added += count;
    else if (change.removed) removed += count;
  }
  return `+${added}/-${removed} lines`;
}

export function createWriteTools(paths: WorkspacePaths, journal: ChangeJournal): RegisteredTool[] {
  const record = (input: Parameters<typeof createChangeRecord>[0]): void => {
    const full = createChangeRecord(
      journal.toolCallId ? { ...input, toolCallId: journal.toolCallId } : input,
    );
    journal.add(full);
  };

  const createFile = defineTool({
    name: 'create_file',
    description:
      'Create a new text file (or overwrite an existing one with overwrite=true). ' +
      'Fails when the file already exists and overwrite is not set. Writes are atomic.',
    schema: z.object({
      path: z.string().min(1).describe('Workspace-relative file path'),
      content: z.string().describe('Full file content'),
      overwrite: z.boolean().optional().describe('Replace an existing file (default false)'),
    }),
    permissionClass: 'write',
    mutating: true,
    timeoutMs: 15_000,
    outputBudget: 10_000,
    summarize: (args) => `create ${args.path} (${Buffer.byteLength(args.content, 'utf8')} bytes)`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path);
      if (existsSync(abs)) {
        const stats = statSync(abs);
        if (stats.isDirectory()) {
          throw new ToolError(`${rel} is a directory`, { code: 'invalid-input' });
        }
        if (!args.overwrite) {
          throw new ToolError(`File already exists: ${rel}`, {
            code: 'conflict',
            hint: 'Use edit_file to modify it, or pass overwrite=true to replace it entirely.',
          });
        }
      }

      const existed = existsSync(abs);
      const before = existed ? readTextFileFull(abs, rel) : null;
      atomicWriteFile(abs, args.content);
      record({
        kind: existed ? 'edit' : 'create',
        path: rel,
        beforeContent: before,
        afterContent: args.content,
      });

      const bytes = Buffer.byteLength(args.content, 'utf8');
      const lines = args.content.split('\n').length;
      return toolOk(
        `${existed ? 'Overwrote' : 'Created'} ${rel} (${lines} lines, ${bytes} bytes)`,
        { bytes, lines, created: !existed },
      );
    },
  });

  const editFile = defineTool({
    name: 'edit_file',
    description:
      'Targeted edit: replace an exact text snippet in an existing file. Fails when the ' +
      'snippet is missing or ambiguous — read the file first and include enough context.',
    schema: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1).describe('Exact text to replace (include surrounding context)'),
      newText: z.string().describe('Replacement text'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence (default false)'),
    }),
    permissionClass: 'write',
    mutating: true,
    timeoutMs: 15_000,
    outputBudget: 10_000,
    summarize: (args) => `edit ${args.path}`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path, { mustExist: true });
      if (statSync(abs).isDirectory()) {
        throw new ToolError(`${rel} is a directory`, { code: 'invalid-input' });
      }
      if (args.oldText === args.newText) {
        throw new ToolError('oldText and newText are identical; nothing to change', {
          code: 'invalid-input',
        });
      }

      const before = readTextFileFull(abs, rel);
      const occurrences = countOccurrences(before, args.oldText);
      if (occurrences === 0) {
        const preview = args.oldText.length > 120 ? `${args.oldText.slice(0, 120)}…` : args.oldText;
        throw new ToolError(`Text not found in ${rel}: "${preview}"`, {
          code: 'not-found',
          hint: 'Read the file and copy the exact text, including whitespace.',
        });
      }
      if (occurrences > 1 && !args.replaceAll) {
        throw new ToolError(`Text appears ${occurrences} times in ${rel}`, {
          code: 'conflict',
          hint: 'Include more surrounding context to make the match unique, or pass replaceAll=true.',
        });
      }

      const after = args.replaceAll
        ? before.split(args.oldText).join(args.newText)
        : before.replace(args.oldText, args.newText);
      atomicWriteFile(abs, after);
      record({ kind: 'edit', path: rel, beforeContent: before, afterContent: after });

      const replacements = args.replaceAll ? occurrences : 1;
      return toolOk(
        `Edited ${rel}: ${replacements} replacement${replacements === 1 ? '' : 's'} (${lineDelta(before, after)})`,
        { replacements },
      );
    },
  });

  const applyPatchTool = defineTool({
    name: 'apply_patch',
    description:
      'Apply a unified diff patch to a single existing file. Context lines must match ' +
      'exactly; the patch is rejected when it does not apply cleanly.',
    schema: z.object({
      path: z.string().min(1).describe('File the patch applies to'),
      patch: z.string().min(1).describe('Unified diff hunks (with or without ---/+++ headers)'),
    }),
    permissionClass: 'write',
    mutating: true,
    timeoutMs: 15_000,
    outputBudget: 10_000,
    summarize: (args) => `apply patch to ${args.path}`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path, { mustExist: true });
      if (statSync(abs).isDirectory()) {
        throw new ToolError(`${rel} is a directory`, { code: 'invalid-input' });
      }

      let parsed;
      try {
        parsed = parsePatch(args.patch);
      } catch (err) {
        throw new ToolError(`Invalid patch: ${err instanceof Error ? err.message : String(err)}`, {
          code: 'invalid-input',
        });
      }
      if (parsed.length === 0) {
        throw new ToolError('Patch contains no hunks', {
          code: 'invalid-input',
          hint: 'Provide unified diff hunks beginning with @@.',
        });
      }
      if (parsed.length > 1) {
        throw new ToolError(`Patch touches ${parsed.length} files; apply one file per call`, {
          code: 'unsupported',
        });
      }

      const before = readTextFileFull(abs, rel);
      const result = applyPatch(before, parsed[0]!);
      if (result === false) {
        throw new ToolError(`Patch did not apply cleanly to ${rel}`, {
          code: 'conflict',
          hint: 'Context lines do not match. Re-read the file and regenerate the patch.',
        });
      }

      atomicWriteFile(abs, result);
      record({ kind: 'patch', path: rel, beforeContent: before, afterContent: result });

      const hunks = parsed[0]!.hunks.length;
      return toolOk(
        `Applied patch to ${rel}: ${hunks} hunk${hunks === 1 ? '' : 's'} (${lineDelta(before, result)})`,
        {
          hunks,
        },
      );
    },
  });

  const renameFile = defineTool({
    name: 'rename_file',
    description: 'Rename or move a file inside the workspace. Refuses to overwrite a target.',
    schema: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
    }),
    permissionClass: 'write',
    mutating: true,
    timeoutMs: 15_000,
    outputBudget: 10_000,
    summarize: (args) => `rename ${args.from} → ${args.to}`,
    execute: (args) => {
      const from = paths.resolve(args.from, { mustExist: true });
      const to = paths.resolve(args.to);
      if (statSync(from.abs).isDirectory()) {
        throw new ToolError(`${from.rel} is a directory; directory moves are not supported`, {
          code: 'unsupported',
        });
      }
      if (existsSync(to.abs)) {
        throw new ToolError(`Target already exists: ${to.rel}`, {
          code: 'conflict',
          hint: 'Delete or rename the target first; existing files are never overwritten.',
        });
      }

      const content = readTextFileFull(from.abs, from.rel);
      mkdirSync(dirname(to.abs), { recursive: true });
      try {
        renameSync(from.abs, to.abs);
      } catch (err) {
        throw new ToolError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`, {
          code: 'io-error',
        });
      }
      record({ kind: 'rename', path: from.rel, toPath: to.rel, afterContent: content });

      return toolOk(`Renamed ${from.rel} → ${to.rel}`);
    },
  });

  const deleteFile = defineTool({
    name: 'delete_file',
    description:
      'Delete a single file. Deletion requires confirmation under the permission policy. ' +
      'Directories are not supported; user work is snapshotted for /undo when possible.',
    schema: z.object({
      path: z.string().min(1),
    }),
    permissionClass: 'write',
    mutating: true,
    destructive: true,
    timeoutMs: 15_000,
    outputBudget: 10_000,
    summarize: (args) => `DELETE ${args.path}`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path, { mustExist: true });
      const stats = statSync(abs);
      if (stats.isDirectory()) {
        throw new ToolError(`${rel} is a directory; only files can be deleted`, {
          code: 'unsupported',
        });
      }
      if (stats.size > MAX_WRITE_BYTES) {
        throw new ToolError(`Refusing to delete ${rel}: ${stats.size} bytes exceeds the safe cap`, {
          code: 'unsupported',
        });
      }

      // Snapshot for undo when the content is text within the ledger cap
      let snapshot: string | null = null;
      try {
        const buffer = readFileSync(abs);
        if (!looksBinary(buffer)) snapshot = decodeTextStrict(buffer, rel);
      } catch {
        snapshot = null;
      }

      unlinkSync(abs);
      record({ kind: 'delete', path: rel, beforeContent: snapshot });

      return toolOk(`Deleted ${rel} (${stats.size} bytes)`, { bytes: stats.size });
    },
  });

  return [createFile, editFile, applyPatchTool, renameFile, deleteFile];
}
