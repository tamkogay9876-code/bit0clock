/**
 * Mutating filesystem tool tests (§40, §43): create/edit/patch/rename/delete,
 * ledger recording, and safety refusals.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPatch } from 'diff';
import { WorkspacePaths } from './paths.js';
import { createWriteTools, type ChangeJournal } from './write-tools.js';
import type { ChangeRecord } from './ledger.js';
import type { RegisteredTool, ToolExecResult } from './types.js';

interface Workspace {
  root: string;
  records: ChangeRecord[];
  tool(name: string): RegisteredTool;
  exec(name: string, args: Record<string, unknown>): Promise<ToolExecResult>;
}

function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'mediaxg-wt-'));
  const records: ChangeRecord[] = [];
  const journal: ChangeJournal = { add: (record) => records.push(record) };
  const tools = createWriteTools(new WorkspacePaths(root), journal);

  return {
    root,
    records,
    tool(name) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`missing tool: ${name}`);
      return found;
    },
    exec(name, args) {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing tool: ${name}`);
      return tool.execute(args, { workspaceRoot: root, timeoutMs: 15_000 });
    },
  };
}

describe('create_file', () => {
  it('creates a file (with parents) and records a create change', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('create_file', { path: 'src/hello.txt', content: 'hi\n' });

    expect(result.isError).toBe(false);
    expect(readFileSync(join(ws.root, 'src/hello.txt'), 'utf8')).toBe('hi\n');
    expect(result.meta?.created).toBe(true);

    expect(ws.records).toHaveLength(1);
    expect(ws.records[0]?.kind).toBe('create');
    expect(ws.records[0]?.path).toBe('src/hello.txt');
    expect(ws.records[0]?.afterContent).toBe('hi\n');
  });

  it('refuses to overwrite without overwrite=true', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'keep.txt'), 'original\n');

    const result = await ws.exec('create_file', { path: 'keep.txt', content: 'clobbered\n' });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('conflict');
    expect(readFileSync(join(ws.root, 'keep.txt'), 'utf8')).toBe('original\n');
    expect(ws.records).toHaveLength(0);
  });

  it('records an edit when overwriting an existing file', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'keep.txt'), 'original\n');

    const result = await ws.exec('create_file', {
      path: 'keep.txt',
      content: 'replaced\n',
      overwrite: true,
    });
    expect(result.isError).toBe(false);
    expect(ws.records[0]?.kind).toBe('edit');
    expect(ws.records[0]?.beforeContent).toBe('original\n');
    expect(ws.records[0]?.afterContent).toBe('replaced\n');
  });

  it('refuses sensitive paths before touching disk', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('create_file', { path: '.env', content: 'SECRET=1' });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('sensitive-path');
    expect(existsSync(join(ws.root, '.env'))).toBe(false);
  });
});

describe('edit_file', () => {
  it('replaces a unique snippet and records before/after', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'code.ts'), 'const a = 1;\nconst b = 2;\n');

    const result = await ws.exec('edit_file', {
      path: 'code.ts',
      oldText: 'const b = 2;',
      newText: 'const b = 20;',
    });

    expect(result.isError).toBe(false);
    expect(readFileSync(join(ws.root, 'code.ts'), 'utf8')).toBe('const a = 1;\nconst b = 20;\n');
    expect(ws.records[0]?.kind).toBe('edit');
    expect(ws.records[0]?.beforeContent).toContain('const b = 2;');
    expect(ws.records[0]?.afterContent).toContain('const b = 20;');
  });

  it('fails on missing text with an actionable hint', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'code.ts'), 'const a = 1;\n');

    const result = await ws.exec('edit_file', {
      path: 'code.ts',
      oldText: 'nope',
      newText: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('not-found');
    expect(result.content).toContain('Read the file and copy the exact text');
  });

  it('fails on ambiguous matches unless replaceAll is set', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'same.txt'), 'same same\n');

    const ambiguous = await ws.exec('edit_file', {
      path: 'same.txt',
      oldText: 'same',
      newText: 'other',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.meta?.code).toBe('conflict');
    expect(readFileSync(join(ws.root, 'same.txt'), 'utf8')).toBe('same same\n');

    const replaced = await ws.exec('edit_file', {
      path: 'same.txt',
      oldText: 'same',
      newText: 'other',
      replaceAll: true,
    });
    expect(replaced.isError).toBe(false);
    expect(readFileSync(join(ws.root, 'same.txt'), 'utf8')).toBe('other other\n');
  });

  it('rejects no-op edits', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'code.ts'), 'text\n');
    const result = await ws.exec('edit_file', {
      path: 'code.ts',
      oldText: 'text',
      newText: 'text',
    });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('invalid-input');
  });
});

describe('apply_patch', () => {
  it('applies a unified diff cleanly', async () => {
    const ws = makeWorkspace();
    const before = 'line1\nline2\nline3\n';
    writeFileSync(join(ws.root, 'patch.txt'), before);
    const patch = createPatch('patch.txt', before, 'line1\nline2 edited\nline3\n');

    const result = await ws.exec('apply_patch', { path: 'patch.txt', patch });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(ws.root, 'patch.txt'), 'utf8')).toBe('line1\nline2 edited\nline3\n');
    expect(ws.records[0]?.kind).toBe('patch');
  });

  it('rejects patches whose context does not match', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'patch.txt'), 'actual content\n');
    const patch = ['@@ -1,1 +1,1 @@', '-imagined content', '+replacement', ''].join('\n');

    const result = await ws.exec('apply_patch', { path: 'patch.txt', patch });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('conflict');
    expect(readFileSync(join(ws.root, 'patch.txt'), 'utf8')).toBe('actual content\n');
  });

  it('refuses multi-file patches', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'a.txt'), 'a\n');
    writeFileSync(join(ws.root, 'b.txt'), 'b\n');
    const patch = createPatch('a.txt', 'a\n', 'a2\n') + createPatch('b.txt', 'b\n', 'b2\n');

    const result = await ws.exec('apply_patch', { path: 'a.txt', patch });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('unsupported');
    expect(result.content).toContain('one file per call');
  });
});

describe('rename_file', () => {
  it('renames inside the workspace and records the move', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'old.txt'), 'payload\n');

    const result = await ws.exec('rename_file', { from: 'old.txt', to: 'sub/new.txt' });
    expect(result.isError).toBe(false);
    expect(existsSync(join(ws.root, 'old.txt'))).toBe(false);
    expect(readFileSync(join(ws.root, 'sub/new.txt'), 'utf8')).toBe('payload\n');

    expect(ws.records[0]?.kind).toBe('rename');
    expect(ws.records[0]?.path).toBe('old.txt');
    expect(ws.records[0]?.toPath).toBe('sub/new.txt');
    expect(ws.records[0]?.afterContent).toBe('payload\n');
  });

  it('refuses an existing target', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'a.txt'), 'a\n');
    writeFileSync(join(ws.root, 'b.txt'), 'b\n');

    const result = await ws.exec('rename_file', { from: 'a.txt', to: 'b.txt' });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('conflict');
    expect(readFileSync(join(ws.root, 'b.txt'), 'utf8')).toBe('b\n');
  });
});

describe('delete_file', () => {
  it('deletes a file with a snapshot for undo and is marked destructive', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'bye.txt'), 'bye\n');

    const result = await ws.exec('delete_file', { path: 'bye.txt' });
    expect(result.isError).toBe(false);
    expect(existsSync(join(ws.root, 'bye.txt'))).toBe(false);

    expect(ws.records[0]?.kind).toBe('delete');
    expect(ws.records[0]?.beforeContent).toBe('bye\n');
    expect(ws.tool('delete_file').destructive).toBe(true);
  });

  it('refuses directories and missing files', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.root, 'dir'));

    const dir = await ws.exec('delete_file', { path: 'dir' });
    expect(dir.isError).toBe(true);
    expect(dir.meta?.code).toBe('unsupported');

    const missing = await ws.exec('delete_file', { path: 'gone.txt' });
    expect(missing.isError).toBe(true);
    expect(missing.meta?.code).toBe('not-found');
  });
});

describe('tool metadata', () => {
  it('declares write tools as mutating and delete as destructive', () => {
    const ws = makeWorkspace();
    for (const name of ['create_file', 'edit_file', 'apply_patch', 'rename_file', 'delete_file']) {
      expect(ws.tool(name).mutating).toBe(true);
      expect(ws.tool(name).permissionClass).toBe('write');
    }
    expect(ws.tool('delete_file').destructive).toBe(true);
    expect(ws.tool('create_file').destructive).toBe(false);
  });
});
