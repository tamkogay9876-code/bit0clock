/**
 * File helper primitives shared by native tools.
 *
 * Reads are bounded and validated (binary detection, UTF-8 roundtrip);
 * writes are atomic (tmp file + fsync + rename) and size-capped.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'fs';
import { dirname } from 'path';
import { ToolError } from './types.js';

/** Max bytes read_file will show to the model */
export const MAX_TEXT_READ_BYTES = 512 * 1024;
/** Hard cap for any single tool write */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/** Files larger than this are skipped by search */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

export function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Decode a buffer as UTF-8, refusing invalid text.
 * Used before edits so we never write back mojibake.
 */
export function decodeTextStrict(buffer: Buffer, relPath: string): string {
  if (looksBinary(buffer)) {
    throw new ToolError(`Binary file cannot be treated as text: ${relPath}`, {
      code: 'unsupported',
    });
  }
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new ToolError(`File is not valid UTF-8 text: ${relPath}`, { code: 'unsupported' });
  }
  return text;
}

export interface TextReadResult {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Read a text file with a byte cap; binary/oversized handling stays explicit. */
export function readTextFile(
  absPath: string,
  relPath: string,
  maxBytes = MAX_TEXT_READ_BYTES,
): TextReadResult {
  let buffer: Buffer;
  try {
    buffer = readFileSync(absPath);
  } catch (err) {
    throw new ToolError(
      `Cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: 'io-error',
      },
    );
  }

  if (looksBinary(buffer)) {
    throw new ToolError(`Binary file cannot be shown as text: ${relPath}`, {
      code: 'unsupported',
      hint: 'Use a dedicated tool or inspect it outside mediaXG.',
    });
  }

  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return { text: slice.toString('utf8'), bytes: buffer.length, truncated };
}

/** Full-file read for edit operations: refuses oversized files instead of truncating. */
export function readTextFileFull(absPath: string, relPath: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(absPath);
  } catch (err) {
    throw new ToolError(
      `Cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: 'io-error',
      },
    );
  }
  if (buffer.length > MAX_WRITE_BYTES) {
    throw new ToolError(
      `File too large to edit safely: ${relPath} (${buffer.length} bytes, cap ${MAX_WRITE_BYTES})`,
      { code: 'unsupported' },
    );
  }
  return decodeTextStrict(buffer, relPath);
}

/** Atomic write: tmp file in the same directory, fsync, rename. */
export function atomicWriteFile(absPath: string, content: string): void {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_WRITE_BYTES) {
    throw new ToolError(`Refusing to write ${byteLength} bytes (cap ${MAX_WRITE_BYTES})`, {
      code: 'unsupported',
    });
  }

  mkdirSync(dirname(absPath), { recursive: true });

  let mode = 0o644;
  if (existsSync(absPath)) {
    try {
      mode = statSync(absPath).mode & 0o777;
    } catch {
      // fall back to default mode
    }
  }

  const tmpPath = `${absPath}.mediaxg-tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    const fd = openSync(tmpPath, 'w', mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, absPath);
  } catch (err) {
    throw new ToolError(
      `Failed to write ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'io-error' },
    );
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface NumberedLines {
  output: string;
  startLine: number;
  linesShown: number;
  totalLines: number;
  hasMore: boolean;
}

/** Format text with 1-based line numbers, from startLine up to maxLines. */
export function formatNumberedLines(
  text: string,
  startLine: number,
  maxLines: number,
): NumberedLines {
  const allLines = text.split('\n');
  const totalLines = allLines.length;
  const start = Math.max(1, startLine);
  const end = Math.min(totalLines, start - 1 + maxLines);
  const out: string[] = [];
  for (let line = start; line <= end; line++) {
    out.push(`${String(line).padStart(6)}| ${allLines[line - 1] ?? ''}`);
  }
  return {
    output: out.join('\n'),
    startLine: start,
    linesShown: Math.max(0, end - start + 1),
    totalLines,
    hasMore: end < totalLines,
  };
}
