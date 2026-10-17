/**
 * Controlled execution tests (§42): process capture, classification,
 * redaction, and the run_command / run_tests tools.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { classifyCommand, createExecTools, redactOutput, runProcess } from './exec-tools.js';
import { WorkspacePaths } from './paths.js';
import type { ToolExecResult } from './types.js';

const CWD = tmpdir();

describe('runProcess', () => {
  it('captures stdout and the exit code without a shell', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("hello child")'],
      {
        cwd: CWD,
        timeoutMs: 15_000,
      },
    );
    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello child');
    expect(result.timedOut).toBe(false);
  });

  it('reports non-zero exit codes and stderr', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stderr.write("boom"); process.exit(3)'],
      { cwd: CWD, timeoutMs: 15_000 },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('kills processes that exceed the timeout', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: CWD,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(8000);
  });

  it('caps captured output instead of buffering it', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(5000))'],
      { cwd: CWD, timeoutMs: 15_000, outputLimit: 1000 },
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(1000);
  });

  it('surfaces spawn errors for missing programs', async () => {
    const result = await runProcess('definitely-not-a-real-program-mediaxg', [], {
      cwd: CWD,
      timeoutMs: 5000,
    });
    expect(result.spawnError).toBeDefined();
    expect(result.exitCode).toBeNull();
  });

  it('terminates the child when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: CWD,
      timeoutMs: 0,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
  });
});

describe('classifyCommand', () => {
  it('classifies read-only programs', () => {
    expect(classifyCommand('ls', ['-la']).kind).toBe('read-only');
    expect(classifyCommand('/usr/bin/ls', []).permissionClass).toBe('read');
    expect(classifyCommand('rg', ['pattern']).kind).toBe('read-only');
    expect(classifyCommand('rg', ['--pre', './hook.sh', 'pattern']).kind).toBe('consequential');
  });

  it('classifies git safely by subcommand and flags', () => {
    expect(classifyCommand('git', ['status']).kind).toBe('read-only');
    expect(classifyCommand('git', ['diff', '--stat']).kind).toBe('read-only');
    expect(classifyCommand('git', ['remote', '-v']).kind).toBe('read-only');
    expect(classifyCommand('git', ['config', '--list']).kind).toBe('read-only');
    expect(classifyCommand('git', ['-C', '/tmp', 'status']).kind).toBe('read-only');

    expect(classifyCommand('git', ['commit', '-m', 'x']).kind).toBe('git-mutation');
    expect(classifyCommand('git', ['config', 'user.email', 'a@b']).kind).toBe('git-mutation');
    expect(classifyCommand('git', ['-c', 'core.pager=cat', 'status']).kind).toBe('consequential');
  });

  it('treats everything else as consequential', () => {
    expect(classifyCommand('rm', ['-rf', 'build']).kind).toBe('consequential');
    expect(classifyCommand('bun', ['test']).kind).toBe('consequential');
    expect(classifyCommand('sudo', []).reason).toContain('never-run');
  });
});

describe('redactOutput', () => {
  it('redacts secret environment values and key formats', () => {
    const env = { MY_TOKEN: 'secretvalue123', PATH: '/usr/bin' };
    expect(redactOutput('token=secretvalue123', env)).toBe('token=[redacted]');
    expect(redactOutput('key sk-abcdefghijklmnopqrst', env)).toContain('[redacted]');
    expect(redactOutput('plain output', env)).toBe('plain output');
  });

  it('ignores short values and non-secret-looking names', () => {
    const env = { SHORT: 'abc', HOME: '/home/someone-long' };
    expect(redactOutput('abc /home/someone-long', env)).toBe('abc /home/someone-long');
  });
});

interface ExecWorkspace {
  root: string;
  exec(name: string, args: Record<string, unknown>): Promise<ToolExecResult>;
}

function makeWorkspace(): ExecWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'mediaxg-exec-'));
  const tools = createExecTools(new WorkspacePaths(root));
  return {
    root,
    exec(name, args) {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing tool: ${name}`);
      return tool.execute(args, { workspaceRoot: root, timeoutMs: 60_000 });
    },
  };
}

describe('run_command', () => {
  it('runs a program and reports output with classification metadata', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('run_command', {
      command: process.execPath,
      args: ['-e', 'console.log("hello")'],
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('exit code: 0');
    expect(result.content).toContain('hello');
    expect(result.meta?.classification).toBe('consequential');
  });

  it('rejects shell metacharacters in the command name', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('run_command', { command: 'git status' });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('invalid-input');
    expect(result.content).toContain('no shell');
  });

  it('refuses programs on the never-run list', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('run_command', { command: 'sudo', args: ['ls'] });
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('denied');
  });

  it('runs inside a workspace subdirectory when cwd is given', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.root, 'sub'));
    const result = await ws.exec('run_command', {
      command: process.execPath,
      args: ['-e', 'console.log(process.cwd())'],
      cwd: 'sub',
    });
    expect(result.content).toContain('/sub');
  });

  it('marks failing commands as errors', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('run_command', {
      command: process.execPath,
      args: ['-e', 'process.exit(2)'],
    });
    expect(result.isError).toBe(true);
    expect(result.meta?.exitCode).toBe(2);
  });
});

describe('run_tests', () => {
  it('detects and runs the project test command, parsing counts', async () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws.root, 'package.json'),
      JSON.stringify({
        packageManager: 'bun@1.1.0',
        scripts: { test: `bun -e "console.log('3 pass, 0 fail')"` },
      }),
    );

    const result = await ws.exec('run_tests', {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('scripts.test (bun, packageManager-field)');
    expect(result.meta?.passed).toBe(3);
    expect(result.meta?.failed).toBe(0);
  });

  it('fails when the tests fail', async () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws.root, 'package.json'),
      JSON.stringify({
        packageManager: 'bun@1.1.0',
        scripts: { test: `bun -e "console.log('1 pass, 2 fail'); process.exit(1)"` },
      }),
    );

    const result = await ws.exec('run_tests', {});
    expect(result.isError).toBe(true);
    expect(result.meta?.passed).toBe(1);
    expect(result.meta?.failed).toBe(2);
  });

  it('reports a clear error when no test setup exists', async () => {
    const ws = makeWorkspace();
    const result = await ws.exec('run_tests', {});
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('unsupported');
    expect(result.content).toContain('No test setup detected');
  });
});
