/**
 * Project detection tests (§46): package manager, test command, lint command.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectLintCommand,
  detectPackageManager,
  detectTestCommand,
  inspectProject,
  hasTestFiles,
  packageScripts,
} from './project.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-proj-'));
}

describe('detectPackageManager', () => {
  it('prefers the packageManager field', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0' }));
    expect(detectPackageManager(dir)).toEqual({ name: 'pnpm', source: 'packageManager-field' });
  });

  it('falls back to lockfiles in priority order', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'yarn.lock'), '');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(detectPackageManager(dir)).toEqual({ name: 'npm', source: 'lockfile' });

    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(dir)).toEqual({ name: 'pnpm', source: 'lockfile' });

    writeFileSync(join(dir, 'bun.lock'), '');
    expect(detectPackageManager(dir)).toEqual({ name: 'bun', source: 'lockfile' });
  });

  it('detects bun from test files', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/thing.test.ts'), '');
    expect(detectPackageManager(dir)).toEqual({ name: 'bun', source: 'test-files' });
    expect(hasTestFiles(dir)).toBe(true);
  });

  it('defaults to bun with no signals', () => {
    const dir = makeDir();
    expect(detectPackageManager(dir)).toEqual({ name: 'bun', source: 'default' });
  });
});

describe('detectTestCommand', () => {
  it('uses package.json scripts.test with the detected runner', () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.1.0', scripts: { test: 'bun test' } }),
    );
    expect(detectTestCommand(dir)).toEqual({
      program: 'bun',
      args: ['run', 'test'],
      source: 'package.json scripts.test (bun, packageManager-field)',
    });
  });

  it('falls back to bun test for bun-owned repositories', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'bun.lock'), '');
    expect(detectTestCommand(dir)).toEqual({
      program: 'bun',
      args: ['test'],
      source: 'bun test (lockfile)',
    });
  });

  it('returns null instead of guessing', () => {
    const dir = makeDir();
    expect(detectTestCommand(dir)).toBeNull();
  });
});

describe('detectLintCommand', () => {
  it('prefers scripts.lint, then scripts.typecheck, then tsc', () => {
    const lintDir = makeDir();
    writeFileSync(join(lintDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    expect(detectLintCommand(lintDir)?.source).toContain('scripts.lint');

    const typecheckDir = makeDir();
    writeFileSync(
      join(typecheckDir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    expect(detectLintCommand(typecheckDir)?.source).toContain('scripts.typecheck');

    const tsDir = makeDir();
    writeFileSync(
      join(tsDir, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.1.0', devDependencies: { typescript: '^5' } }),
    );
    writeFileSync(join(tsDir, 'tsconfig.json'), '{}');
    expect(detectLintCommand(tsDir)).toEqual({
      program: 'bun',
      args: ['x', 'tsc', '--noEmit'],
      source: 'tsconfig.json + local typescript',
    });
  });

  it('returns null when nothing is detectable', () => {
    expect(detectLintCommand(makeDir())).toBeNull();
  });
});

describe('inspectProject', () => {
  it('summarizes the workspace in one call', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'bun.lock'), '');
    writeFileSync(join(dir, 'README.md'), '# hi');
    const meta = inspectProject(dir);

    expect(meta.hasPackageJson).toBe(false);
    expect(meta.packageManager).toEqual({ name: 'bun', source: 'lockfile' });
    expect(meta.hasReadme).toBe(true);
    expect(meta.hasTsconfig).toBe(false);
    expect(meta.lockfiles).toEqual(['bun.lock']);
    expect(meta.scripts).toEqual({});
    expect(packageScripts(dir)).toEqual({});
  });
});
