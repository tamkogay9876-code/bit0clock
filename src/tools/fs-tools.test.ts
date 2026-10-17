/**
 * Read-only filesystem tool tests (§40): read_file, list_dir, glob_files,
 * search_text, read_doc — boundaries, ignores, and error paths.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFsTools } from './fs-tools.js';
import { WorkspacePaths } from './paths.js';
import type { RegisteredTool, ToolExecResult } from './types.js';

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'mediaxg-fs-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  writeFileSync(
    join(root, 'src/app.ts'),
    'export const x = 1;\nexport function todo() {}\n// TODO: fix me\n',
  );
  writeFileSync(join(root, 'src/util.ts'), 'export function helper() {\n  return 42;\n}\n');
  writeFileSync(join(root, 'docs/guide.md'), '# Guide\n\nHello docs\n');
  writeFileSync(join(root, 'README.md'), '# Project\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'server.pem'), 'PRIVATE KEY\n');
  writeFileSync(join(root, 'ignored.txt'), 'should not appear\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'module.exports = {};\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  return root;
}

function registryFor(root: string): RegisteredTool[] {
  return createFsTools(new WorkspacePaths(root));
}

function toolOf(root: string, name: string): RegisteredTool {
  const tool = registryFor(root).find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

function exec(root: string, name: string, args: Record<string, unknown>): Promise<ToolExecResult> {
  return toolOf(root, name).execute(args, { workspaceRoot: root, timeoutMs: 10_000 });
}

describe('read_file', () => {
  it('reads with line numbers', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'read_file', { path: 'src/app.ts' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('     1| export const x = 1;');
    expect(result.content).toContain('     3| // TODO: fix me');
    expect(result.meta?.totalLines).toBe(4);
  });

  it('supports offset/limit paging with a continuation note', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'read_file', { path: 'src/app.ts', offset: 2, limit: 1 });
    expect(result.content).toContain('     2| export function todo() {}');
    expect(result.content).toContain('more lines — continue with offset=3');
  });

  it('refuses missing files, directories, binaries, and sensitive files', async () => {
    const root = makeWorkspace();

    const missing = await exec(root, 'read_file', { path: 'missing.txt' });
    expect(missing.isError).toBe(true);
    expect(missing.meta?.code).toBe('not-found');
    expect(missing.content).toContain('File not found');

    const dir = await exec(root, 'read_file', { path: 'src' });
    expect(dir.isError).toBe(true);
    expect(dir.meta?.code).toBe('invalid-input');

    const binary = await exec(root, 'read_file', { path: 'binary.bin' });
    expect(binary.isError).toBe(true);
    expect(binary.meta?.code).toBe('unsupported');

    const sensitive = await exec(root, 'read_file', { path: '.env' });
    expect(sensitive.isError).toBe(true);
    expect(sensitive.meta?.code).toBe('sensitive-path');
  });

  it('reports an offset beyond the end of the file', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'read_file', { path: 'src/util.ts', offset: 500 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('beyond the end');
  });
});

describe('list_dir', () => {
  it('lists entries directories-first and hides sensitive files', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'list_dir', {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('src/');
    expect(result.content).toContain('docs/');
    expect(result.content).toContain('(2 sensitive entries hidden)');

    const docsIndex = result.content.indexOf('docs/');
    const readmeIndex = result.content.indexOf('README.md');
    expect(docsIndex).toBeGreaterThan(-1);
    expect(readmeIndex).toBeGreaterThan(docsIndex);
  });

  it('rejects files and missing paths', async () => {
    const root = makeWorkspace();
    const file = await exec(root, 'list_dir', { path: 'README.md' });
    expect(file.isError).toBe(true);
    expect(file.meta?.code).toBe('invalid-input');

    const missing = await exec(root, 'list_dir', { path: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.meta?.code).toBe('not-found');
  });
});

describe('glob_files', () => {
  it('finds files by pattern', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'glob_files', { pattern: 'src/**/*.ts' });
    expect(result.isError).toBe(false);
    expect(result.content.split('\n').sort()).toEqual(['src/app.ts', 'src/util.ts']);
    expect(result.meta?.count).toBe(2);
  });

  it('respects ignores, gitignore, and sensitive filtering', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'glob_files', { pattern: '**/*' });
    expect(result.content).not.toContain('.env');
    expect(result.content).not.toContain('server.pem');
    expect(result.content).not.toContain('ignored.txt');
    expect(result.content).not.toContain('node_modules');
  });

  it('rejects traversal patterns', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'glob_files', { pattern: '../*' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('workspace-relative');
  });

  it('notes when maxResults cuts the list', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'glob_files', { pattern: '**/*.ts', maxResults: 1 });
    expect(result.content).toContain('more files');
  });
});

describe('search_text', () => {
  it('finds matches with path:line coordinates', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'search_text', { query: 'TODO:' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('src/app.ts:3: // TODO: fix me');
    expect(result.meta?.matches).toBe(1);
  });

  it('supports literal mode and regex mode distinctly', async () => {
    const root = makeWorkspace();
    const regex = await exec(root, 'search_text', { query: '[TODO]' });
    expect(regex.meta?.matches).toBeGreaterThan(0);

    const literal = await exec(root, 'search_text', { query: '[TODO]', literal: true });
    expect(literal.meta?.matches).toBe(0);
    expect(literal.content).toContain('No matches');
  });

  it('reports invalid regular expressions with a hint', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'search_text', { query: '[' });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('invalid-input');
    expect(result.content).toContain('Invalid regular expression');
    expect(result.content).toContain('literal=true');
  });

  it('honours case-sensitivity and path/include filters', async () => {
    const root = makeWorkspace();
    // Case-insensitive matches both `todo()` and `// TODO:`; case-sensitive
    // only the lowercase function name.
    const insensitive = await exec(root, 'search_text', { query: 'todo' });
    expect(insensitive.meta?.matches).toBe(2);

    const sensitive = await exec(root, 'search_text', { query: 'todo', caseSensitive: true });
    expect(sensitive.meta?.matches).toBe(1);

    const scoped = await exec(root, 'search_text', { query: 'Hello', path: 'docs' });
    expect(scoped.content).toContain('docs/guide.md');
    expect(scoped.content).not.toContain('README.md');

    const included = await exec(root, 'search_text', { query: 'export', include: '**/*.ts' });
    expect(included.content).toContain('src/app.ts');
    expect(included.content).not.toContain('docs/');
  });

  it('never scans sensitive files', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'search_text', { query: 'SECRET' });
    expect(result.meta?.matches).toBe(0);
    expect(result.content).toContain('No matches');
  });
});

describe('read_doc', () => {
  it('reads docs and README files', async () => {
    const root = makeWorkspace();
    const guide = await exec(root, 'read_doc', { path: 'docs/guide.md' });
    expect(guide.isError).toBe(false);
    expect(guide.content).toContain('# Guide');

    const readme = await exec(root, 'read_doc', { path: 'README.md' });
    expect(readme.isError).toBe(false);
    expect(readme.content).toContain('# Project');
  });

  it('refuses source files with an actionable hint', async () => {
    const root = makeWorkspace();
    const result = await exec(root, 'read_doc', { path: 'src/app.ts' });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('unsupported');
    expect(result.content).toContain('Use read_file');
  });
});
