/**
 * File helper primitive tests: binary detection, UTF-8 strictness, atomic
 * writes, line formatting, and output truncation.
 */

import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'bun:test';
import {
  MAX_WRITE_BYTES,
  atomicWriteFile,
  countOccurrences,
  decodeTextStrict,
  formatNumberedLines,
  looksBinary,
  readTextFile,
} from './file-utils.js';
import { ToolError, truncateToolOutput } from './types.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-fu-'));
}

describe('file-utils', () => {
  it('detects binary content via NUL bytes', () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
  });

  it('decodeTextStrict refuses invalid UTF-8 and NUL bytes', () => {
    expect(() => decodeTextStrict(Buffer.from([0xff, 0xfe, 0x41]), 'x')).toThrow(ToolError);
    expect(() => decodeTextStrict(Buffer.from([0x00]), 'x')).toThrow(ToolError);
    expect(decodeTextStrict(Buffer.from('ok ✓', 'utf8'), 'x')).toBe('ok ✓');
  });

  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('abcabc', 'abc')).toBe(2);
    expect(countOccurrences('abc', '')).toBe(0);
    expect(countOccurrences('abc', 'z')).toBe(0);
  });

  it('formats numbered lines with pagination info', () => {
    const result = formatNumberedLines('a\nb\nc\nd', 2, 2);
    expect(result.startLine).toBe(2);
    expect(result.linesShown).toBe(2);
    expect(result.totalLines).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(result.output).toBe('     2| b\n     3| c');
  });

  it('reads text with an explicit byte cap', () => {
    const dir = makeDir();
    const target = join(dir, 'f.txt');
    writeFileSync(target, '0123456789ABCDEF');
    const result = readTextFile(target, 'f.txt', 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('0123456789');
    expect(result.bytes).toBe(16);
  });

  it('atomicWriteFile creates parents and preserves the existing file mode', () => {
    const dir = makeDir();
    const target = join(dir, 'nested', 'deep', 'file.txt');
    atomicWriteFile(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');

    chmodSync(target, 0o600);
    atomicWriteFile(target, 'replaced');
    expect(readFileSync(target, 'utf8')).toBe('replaced');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('refuses writes beyond the byte cap', () => {
    const dir = makeDir();
    const huge = 'x'.repeat(MAX_WRITE_BYTES + 1);
    expect(() => atomicWriteFile(join(dir, 'big.txt'), huge)).toThrow(ToolError);
  });
});

describe('truncateToolOutput', () => {
  it('keeps head and tail with an explicit marker', () => {
    const body = 'H'.repeat(300) + 'M'.repeat(300) + 'T'.repeat(300);
    const out = truncateToolOutput(body, 400);
    expect(out.length).toBeLessThan(body.length);
    expect(out).toContain('output truncated');
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
  });

  it('leaves short content untouched', () => {
    expect(truncateToolOutput('short', 400)).toBe('short');
  });

  it('hard-cuts when the budget is tiny', () => {
    expect(truncateToolOutput('abcdef', 3)).toBe('abc');
  });
});
