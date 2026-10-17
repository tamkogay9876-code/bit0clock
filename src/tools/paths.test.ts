/**
 * Workspace path guard tests (§41): traversal, symlinks, sensitive files.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkspacePaths, sensitiveReason } from './paths.js';
import { ToolError } from './types.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-paths-'));
}

function expectToolError(fn: () => unknown, code: string): ToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    const toolError = err as ToolError;
    expect(toolError.code).toBe(code);
    return toolError;
  }
  throw new Error(`Expected ToolError(${code}) but nothing was thrown`);
}

describe('WorkspacePaths.resolve', () => {
  it('resolves relative and in-workspace absolute paths', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    expect(paths.resolve('src/file.ts').rel).toBe('src/file.ts');
    expect(paths.resolve(join(root, 'src/file.ts')).rel).toBe('src/file.ts');
    expect(paths.resolve('.').rel).toBe('');
  });

  it('normalizes backslashes from model output', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    expect(paths.resolve('src\\nested\\file.ts').rel).toBe('src/nested/file.ts');
  });

  it('rejects traversal outside the workspace', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve('../outside.txt'), 'outside-workspace');
    expectToolError(() => paths.resolve('a/../../outside.txt'), 'outside-workspace');
    expectToolError(() => paths.resolve('/etc/passwd'), 'outside-workspace');
  });

  it('rejects paths that escape through a symlinked directory', () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, 'secret.txt'), 'outside data');
    mkdirSync(join(outside, 'dir'));
    symlinkSync(outside, join(root, 'outdir'), 'dir');
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve('outdir/secret.txt'), 'outside-workspace');
  });

  it('rejects a file symlink pointing outside the workspace', () => {
    const root = makeRoot();
    const outside = makeRoot();
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'outside data');
    symlinkSync(target, join(root, 'link.txt'), 'file');
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve('link.txt'), 'outside-workspace');
  });

  it('allows symlinks that stay inside the workspace', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'real.txt'), 'data');
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'), 'file');
    const paths = new WorkspacePaths(root);
    expect(paths.resolve('alias.txt').rel).toBe('real.txt');
  });

  it('reports missing files when mustExist is set', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    const error = expectToolError(
      () => paths.resolve('missing.txt', { mustExist: true }),
      'not-found',
    );
    expect(error.message).toContain('missing.txt');
  });

  it('rejects empty paths and NUL bytes', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve(''), 'invalid-input');
    expectToolError(() => paths.resolve('   '), 'invalid-input');
    expectToolError(() => paths.resolve('a\0b'), 'invalid-input');
  });

  it('fails cleanly when the workspace root does not exist', () => {
    const paths = new WorkspacePaths('/definitely/not/a/real/root-mediaxg-xyz');
    expectToolError(() => paths.resolve('a.txt'), 'io-error');
  });
});

describe('sensitive paths', () => {
  it('refuses credential and key files', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.env'), 'SECRET=1');
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve('.env'), 'sensitive-path');
  });

  it('refuses sensitive files regardless of directory prefix', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve('config/.env'), 'sensitive-path');
    expectToolError(() => paths.resolve('certs/server.pem'), 'sensitive-path');
    expectToolError(() => paths.resolve('home/.ssh/id_rsa'), 'sensitive-path');
    expectToolError(() => paths.resolve('gcp/service-account.json'), 'sensitive-path');
    expectToolError(() => paths.resolve('aws/credentials.json'), 'sensitive-path');
  });

  it('allows documented safe examples', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.env.example'), 'KEY=');
    const paths = new WorkspacePaths(root);
    expect(paths.resolve('.env.example').rel).toBe('.env.example');
  });

  it('blocks git internals', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[core]');
    const paths = new WorkspacePaths(root);
    expectToolError(() => paths.resolve('.git/config'), 'sensitive-path');
  });

  it('exposes reasons for diagnostics', () => {
    expect(sensitiveReason('.env')).toContain('credentials');
    expect(sensitiveReason('.env.example')).toBeUndefined();
    expect(sensitiveReason('.git/config')).toContain('.git');
    expect(sensitiveReason('src/index.ts')).toBeUndefined();
  });

  it('treats outside paths as inaccessible', () => {
    const root = makeRoot();
    const paths = new WorkspacePaths(root);
    expect(paths.safeRelative(join(root, 'a.txt'))).toBe('a.txt');
    expect(paths.safeRelative('/etc/passwd')).toBeNull();
    expect(paths.isSensitive('/etc/passwd')).toBe(true);
    expect(paths.isSensitive('src/index.ts')).toBe(false);
  });

  it('canonicalizes workspace-root aliases before computing safe relative paths', () => {
    const root = makeRoot();
    const alias = `${root}-alias`;
    symlinkSync(root, alias, 'dir');
    const paths = new WorkspacePaths(root);
    expect(paths.safeRelative(join(alias, 'a.txt'))).toBe('a.txt');
  });
});
