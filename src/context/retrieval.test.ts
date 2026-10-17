/**
 * Repository indexing and retrieval tests (§26).
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_IGNORED_DIRS,
  isGeneratedFile,
  isIndexableName,
  isSensitiveFile,
  looksBinary,
  parseGitignore,
  RepoIndex,
  tokenizeQuery,
} from './retrieval.js';

let workspace: string;

function write(relative: string, content: string): string {
  const path = join(workspace, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mediaxg-repo-'));
});

describe('RepoIndex.build', () => {
  test('indexes source files and applies the extension allowlist', () => {
    write('src/a.ts', 'export const alpha = 1;\n');
    write('README.md', '# readme\n');
    write('image.png', 'binary-ish');
    write('data.sqlite', 'x');

    const index = new RepoIndex({ workspaceRoot: workspace });
    const stats = index.build();

    const paths = index
      .list()
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['README.md', 'src/a.ts']);
    expect(stats.files).toBe(2);
    expect(stats.skippedExtension).toBe(2);
  });

  test('skips ignored directories', () => {
    write('src/a.ts', 'alpha');
    write('node_modules/pkg/index.ts', 'module');
    write('dist/bundle.ts', 'bundle');
    write('.git/config', 'git');

    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    expect(index.list().map((entry) => entry.path)).toEqual(['src/a.ts']);
    expect(DEFAULT_IGNORED_DIRS).toContain('node_modules');
  });

  test('honors root and nested .gitignore files', () => {
    write('.gitignore', 'ignored.ts\nbuild-output/\n');
    write('ignored.ts', 'nope');
    write('kept.ts', 'yes');
    write('build-output/x.ts', 'nope');
    write('nested/.gitignore', '*.skip.ts\n');
    write('nested/keep.ts', 'yes');
    write('nested/drop.skip.ts', 'nope');

    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const paths = index
      .list()
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['kept.ts', 'nested/keep.ts']);
  });

  test('never indexes credential files', () => {
    write('.env', 'SECRET=1');
    write('.env.local', 'SECRET=2');
    write('server.key', 'key');
    write('id_rsa', 'key');
    write('credentials.json', '{}');
    write('app.ts', 'ok');

    const index = new RepoIndex({ workspaceRoot: workspace });
    const stats = index.build();
    expect(index.list().map((entry) => entry.path)).toEqual(['app.ts']);
    expect(stats.skippedSensitive).toBeGreaterThanOrEqual(4);
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('credentials.json')).toBe(true);
    expect(isSensitiveFile('normal.ts')).toBe(false);
  });

  test('skips oversized files', () => {
    write('big.ts', 'x'.repeat(2048));
    write('small.ts', 'ok');
    const index = new RepoIndex({ workspaceRoot: workspace, maxFileSizeBytes: 1024 });
    const stats = index.build();
    expect(index.list().map((entry) => entry.path)).toEqual(['small.ts']);
    expect(stats.skippedSize).toBe(1);
  });

  test('marks generated artifacts (still listable, excluded from search by default)', () => {
    write('bundle.min.js', 'var a=1;'.repeat(10));
    write('package-lock.json', '{"lockfileVersion":3}');
    write('main.js', 'console.log("hello world marker")');

    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const bundle = index.list().find((entry) => entry.path === 'bundle.min.js');
    expect(bundle?.generated).toBe(true);
    expect(isGeneratedFile('package-lock.json')).toBe(true);

    const results = index.search('bundle min');
    expect(results.every((result) => !result.entry.generated)).toBe(true);
    const withGenerated = index.search('bundle min', { includeGenerated: true });
    expect(withGenerated.some((result) => result.entry.path === 'bundle.min.js')).toBe(true);
  });

  test('truncates scans at maxFiles and flags it', () => {
    for (let i = 0; i < 10; i++) write(`f${i}.ts`, `content ${i}`);
    const index = new RepoIndex({ workspaceRoot: workspace, maxFiles: 4 });
    const stats = index.build();
    expect(stats.files).toBe(4);
    expect(stats.truncated).toBe(true);
  });
});

describe('RepoIndex freshness and change detection', () => {
  test('get() corrects stale metadata from disk', async () => {
    const path = write('src/a.ts', 'first');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const beforeSize = index.get('src/a.ts')!.size;

    await new Promise((resolve) => setTimeout(resolve, 10));
    appendFileSync(path, '\nsecond line appended');
    const afterSize = index.get('src/a.ts')!.size;
    expect(afterSize).toBeGreaterThan(beforeSize);
  });

  test('refresh() reports added, removed, and changed files', async () => {
    write('a.ts', 'a');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();

    await new Promise((resolve) => setTimeout(resolve, 10));
    write('b.ts', 'b');
    rmSync(join(workspace, 'a.ts'));
    write('c.ts', 'c');

    const delta = index.refresh();
    expect(delta.added).toBe(2);
    expect(delta.removed).toBe(1);
  });
});

describe('RepoIndex.search', () => {
  test('ranks filename matches above content matches', () => {
    write('src/paymentService.ts', 'export class PaymentService {}\n');
    write(
      'src/other.ts',
      'payment handling helper\nstatic payments processing\npayment payment payment\n',
    );

    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const results = index.search('payment service');
    expect(results[0]!.entry.path).toBe('src/paymentService.ts');
    expect(results[0]!.reasons.join(' ')).toContain('filename');
  });

  test('returns reasons for transparency', () => {
    write('src/loop.ts', 'const iteration = 1;\n');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const results = index.search('loop');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.reasons.length).toBeGreaterThan(0);
  });

  test('empty or stopword-only queries return nothing', () => {
    write('a.ts', 'const x = 1;');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    expect(index.search('')).toEqual([]);
    expect(index.search('the and for')).toEqual([]);
  });
});

describe('RepoIndex.textSearch', () => {
  test('finds matches with line numbers from current content', () => {
    write('src/a.ts', 'line one\nconst needleHere = 1;\nline three\n');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const result = index.textSearch('needleHere');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({
      path: 'src/a.ts',
      line: 2,
      text: 'const needleHere = 1;',
    });
  });

  test('respects per-file and overall caps', () => {
    write('a.ts', 'hit\nhit\nhit\nhit\n');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const result = index.textSearch('hit', { maxMatchesPerFile: 2, limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe('RepoIndex.extract', () => {
  test('extracts a line range with totals', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    write('src/big.ts', lines);
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();

    const extraction = index.extract('src/big.ts', { startLine: 10, endLine: 12 });
    expect('error' in extraction).toBe(false);
    if (!('error' in extraction)) {
      expect(extraction.totalLines).toBe(50);
      expect(extraction.content).toContain('line 10');
      expect(extraction.content).toContain('line 12');
      expect(extraction.truncated).toBe(false);
    }
  });

  test('caps the snippet at maxTokens and says so', () => {
    write(
      'src/big.ts',
      Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n'),
    );
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();

    const extraction = index.extract('src/big.ts', { maxTokens: 100 });
    expect('error' in extraction).toBe(false);
    if (!('error' in extraction)) {
      expect(extraction.truncated).toBe(true);
      expect(extraction.content).toContain('truncated at the snippet token cap');
      expect(extraction.tokens).toBeLessThanOrEqual(130);
    }
  });

  test('rejects paths outside the workspace', () => {
    write('a.ts', 'ok');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const result = index.extract('../../../etc/passwd');
    expect('error' in result).toBe(true);
  });

  test('rejects binary content even with a text extension', () => {
    const path = write('src/sneaky.ts', 'abc');
    writeFileSync(path, Buffer.from([0x61, 0x00, 0x62, 0x63]));
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const result = index.extract('src/sneaky.ts');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Binary');
  });

  test('line range beyond the file is an explicit error', () => {
    write('a.ts', 'one line\n');
    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const result = index.extract('a.ts', { startLine: 500 });
    expect('error' in result).toBe(true);
  });
});

describe('helpers', () => {
  test('isIndexableName handles special names and extensions', () => {
    expect(isIndexableName('Dockerfile')).toBe(true);
    expect(isIndexableName('Makefile')).toBe(true);
    expect(isIndexableName('main.ts')).toBe(true);
    expect(isIndexableName('archive.zip')).toBe(false);
    expect(isIndexableName('noext')).toBe(false);
  });

  test('looksBinary detects null bytes in the first 8 KiB', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(Buffer.from([1, 2, 0, 4]))).toBe(true);
    const big = Buffer.alloc(20_000, 1);
    big[19_000] = 0;
    expect(looksBinary(big)).toBe(false); // beyond the sniff window
  });

  test('parseGitignore supports negation and trailing slashes', () => {
    const rules = parseGitignore('*.log\n!important.log\nbuild/\n');
    expect(rules.length).toBe(3);
    expect(rules[0]!.negated).toBe(false);
    expect(rules[1]!.negated).toBe(true);
    expect(rules[2]!.dirOnly).toBe(true);
  });

  test('tokenizeQuery filters stopwords and de-duplicates', () => {
    expect(tokenizeQuery('Fix the PaymentService in the payment code')).toEqual([
      'paymentservice',
      'payment',
    ]);
  });
});

describe('RepoIndex .gitignore negation behavior', () => {
  test('a negated pattern re-includes a file', () => {
    write('.gitignore', '*.generated.ts\n!keep.generated.ts\n');
    write('noise.generated.ts', 'noise');
    write('keep.generated.ts', 'keep me');
    write('app.ts', 'code');

    const index = new RepoIndex({ workspaceRoot: workspace });
    index.build();
    const paths = index
      .list()
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['app.ts', 'keep.generated.ts']);
  });
});
