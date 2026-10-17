/**
 * Security-focused regression tests (§53): traversal, symlink escape, sensitive
 * files, shell-injection resistance, output caps, and secret redaction.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkspacePaths } from './tools/paths.js';
import { runProcess } from './tools/exec-tools.js';
import { assertNoSecretsInUrl } from './mcp/client.js';

describe('security: workspace path containment', () => {
  it('refuses traversal outside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    const paths = new WorkspacePaths(dir);
    expect(() => paths.resolve('../outside.txt')).toThrow();
    expect(() => paths.resolve('a/../../outside.txt')).toThrow();
  });

  it('refuses absolute paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    const paths = new WorkspacePaths(dir);
    expect(() => paths.resolve('/etc/passwd')).toThrow();
  });

  it('refuses symlink escapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    const outside = mkdtempSync(join(tmpdir(), 'sec-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    } catch {
      return; // no symlink support
    }
    const paths = new WorkspacePaths(dir);
    expect(() => paths.resolve('link.txt', { mustExist: true })).toThrow();
  });

  it('refuses sensitive credential files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    writeFileSync(join(dir, '.env'), 'API_KEY=secret');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'config'), 'secret');
    const paths = new WorkspacePaths(dir);
    expect(() => paths.resolve('.env', { mustExist: true })).toThrow();
    expect(() => paths.resolve('.git/config', { mustExist: true })).toThrow();
  });
});

describe('security: shell execution uses argv, never a shell', () => {
  it('does not interpret shell metacharacters in arguments', async () => {
    const result = await runProcess('printf', ['%s', 'a;b | c && d'], {
      timeoutMs: 5000,
      outputLimit: 1024,
    });
    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('a;b | c && d');
  });

  it('caps output to the configured limit', async () => {
    const result = await runProcess('yes', [], { timeoutMs: 1000, outputLimit: 256 });
    expect(result.stdout.length).toBeLessThanOrEqual(256);
  });
});

describe('security: MCP URL hygiene', () => {
  it('rejects secret-looking query parameters', () => {
    expect(() => assertNoSecretsInUrl('https://mcp.example.com/mcp?token=abc')).toThrow();
    expect(() => assertNoSecretsInUrl('https://mcp.example.com/mcp?api_key=abc')).toThrow();
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => assertNoSecretsInUrl('https://user:pass@mcp.example.com/mcp')).toThrow();
  });
});

describe('security: redaction of secrets in memory entries', () => {
  it('redacts secret-like content on add', async () => {
    const { MemoryManager } = await import('./memory/store.js');
    const dir = mkdtempSync(join(tmpdir(), 'sec-mem-'));
    const manager = new MemoryManager({ projectPath: dir });
    const entry = manager.add({
      category: 'state',
      kind: 'fact',
      content: 'token is sk-abcdefghijklmnopqrstuvwxyz012345',
      provenance: 'test',
    });
    expect(entry.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(entry.content).toContain('[REDACTED]');
  });
});
