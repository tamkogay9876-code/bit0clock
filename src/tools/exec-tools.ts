/**
 * Controlled process execution (§42).
 *
 * Commands run through `spawn` with an argument array — there is no shell,
 * so pipes, redirects, and substitutions are impossible. Output is bounded
 * and secrets are redacted. Commands are classified read-only vs
 * consequential so the permission engine can treat them differently.
 */

import { spawn } from 'child_process';
import { basename } from 'path';
import { statSync } from 'fs';
import { z } from 'zod';
import type { PermissionClass } from '../types/index.js';
import { defineTool, ToolError, type RegisteredTool } from './types.js';
import type { WorkspacePaths } from './paths.js';
import { detectTestCommand } from './project.js';

// ============================================================================
// Process capture
// ============================================================================

export interface RunProcessOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Bytes captured per stream (output beyond this is dropped, not buffered) */
  outputLimit?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError?: string;
}

export async function runProcess(
  program: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  const cap = options.outputLimit ?? 32 * 1024;
  const started = Date.now();

  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: Omit<ProcessResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ ...result, durationMs: Date.now() - started });
    };

    let child;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - started,
        stdoutTruncated: false,
        stderrTruncated: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const collect = (
      chunk: Buffer,
      sink: Buffer[],
      currentBytes: number,
      truncated: boolean,
    ): { bytes: number; truncated: boolean } => {
      if (currentBytes >= cap) return { bytes: currentBytes, truncated: true };
      const room = cap - currentBytes;
      if (chunk.length <= room) {
        sink.push(chunk);
        return { bytes: currentBytes + chunk.length, truncated };
      }
      sink.push(chunk.subarray(0, room));
      return { bytes: cap, truncated: true };
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = collect(chunk, stdoutChunks, stdoutBytes, stdoutTruncated);
      stdoutBytes = next.bytes;
      stdoutTruncated = next.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = collect(chunk, stderrChunks, stderrBytes, stderrTruncated);
      stderrBytes = next.bytes;
      stderrTruncated = next.truncated;
    });

    const terminate = (reason: 'timeout' | 'cancel'): void => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2000);
    };

    const onAbort = (): void => terminate('cancel');
    const timeoutTimer =
      options.timeoutMs > 0 ? setTimeout(() => terminate('timeout'), options.timeoutMs) : null;

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      finish({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        cancelled,
        stdoutTruncated,
        stderrTruncated,
        spawnError: err.message,
      });
    });

    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        cancelled,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

// ============================================================================
// Command classification (§42, §52)
// ============================================================================

export type CommandKind = 'read-only' | 'git-mutation' | 'consequential';

export interface CommandClassification {
  kind: CommandKind;
  permissionClass: PermissionClass;
  mutating: boolean;
  reason: string;
}

const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'pwd',
  'du',
  'df',
  'rg',
  'grep',
  'which',
  'tree',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'jq',
]);

const DENIED_PROGRAMS = new Set([
  'sudo',
  'su',
  'doas',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'fdisk',
  'parted',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
  'ls-tree',
  'show-ref',
  'symbolic-ref',
  'reflog',
]);

const DANGEROUS_GIT_FLAGS = ['-c', '--config-env', '--exec-path'];

function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
      i++; // skip the value
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

/** Classify a command for the permission engine. Never throws. */
export function classifyCommand(program: string, args: string[]): CommandClassification {
  const base = basename(program);

  if (DENIED_PROGRAMS.has(base)) {
    return {
      kind: 'consequential',
      permissionClass: 'execute',
      mutating: true,
      reason: `${base} is on the never-run list`,
    };
  }

  if (base === 'git') {
    if (
      args.some((arg) =>
        DANGEROUS_GIT_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
      )
    ) {
      return {
        kind: 'consequential',
        permissionClass: 'git',
        mutating: true,
        reason: 'git with config/exec overrides can execute arbitrary programs',
      };
    }
    const sub = gitSubcommand(args);
    if (!sub) {
      return { kind: 'read-only', permissionClass: 'read', mutating: false, reason: 'git help' };
    }
    if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
      return { kind: 'read-only', permissionClass: 'read', mutating: false, reason: `git ${sub}` };
    }
    if (sub === 'config' || sub === 'remote' || sub === 'branch' || sub === 'tag') {
      const rest = args.slice(args.indexOf(sub) + 1);
      const readFlags = [
        '--get',
        '--get-all',
        '--get-regexp',
        '--list',
        '-l',
        '-v',
        '--verbose',
        '--show-current',
        '-a',
        '-r',
      ];
      const isRead =
        rest.length === 0 || rest.every((a) => readFlags.includes(a) || a.startsWith('--get'));
      return isRead
        ? {
            kind: 'read-only',
            permissionClass: 'read',
            mutating: false,
            reason: `git ${sub} (inspect)`,
          }
        : {
            kind: 'git-mutation',
            permissionClass: 'git',
            mutating: true,
            reason: `git ${sub} mutates repository config/refs`,
          };
    }
    if (sub === 'stash') {
      const rest = args.slice(args.indexOf(sub) + 1);
      const isRead = rest.length === 0 || rest[0] === 'list' || rest[0] === 'show';
      return isRead
        ? {
            kind: 'read-only',
            permissionClass: 'read',
            mutating: false,
            reason: 'git stash (inspect)',
          }
        : {
            kind: 'git-mutation',
            permissionClass: 'git',
            mutating: true,
            reason: 'git stash mutates the working tree',
          };
    }
    return {
      kind: 'git-mutation',
      permissionClass: 'git',
      mutating: true,
      reason: `git ${sub} mutates repository state`,
    };
  }

  if (READ_ONLY_PROGRAMS.has(base)) {
    if (base === 'rg' && args.some((arg) => arg.startsWith('--pre'))) {
      return {
        kind: 'consequential',
        permissionClass: 'execute',
        mutating: true,
        reason: 'rg --pre executes another program',
      };
    }
    return {
      kind: 'read-only',
      permissionClass: 'read',
      mutating: false,
      reason: `${base} is read-only`,
    };
  }

  return {
    kind: 'consequential',
    permissionClass: 'execute',
    mutating: true,
    reason: `${base} is not on the read-only list`,
  };
}

// ============================================================================
// Secret redaction
// ============================================================================

const SECRET_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /xai-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
];

/** Replace likely secrets in process output with [redacted]. */
export function redactOutput(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let output = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    output = output.split(value).join('[redacted]');
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  return output;
}

// ============================================================================
// Tools
// ============================================================================

const SHELL_METACHARACTERS = /[\s|&;<>()$`'"]/;

function formatProcessResult(
  commandLine: string,
  result: ProcessResult,
  env: Record<string, string | undefined>,
): string {
  const lines: string[] = [];
  lines.push(`$ ${commandLine}`);

  if (result.spawnError) {
    lines.push(`spawn error: ${result.spawnError}`);
    return lines.join('\n');
  }

  const status = result.timedOut
    ? `TIMED OUT after ${result.durationMs}ms (process killed)`
    : result.cancelled
      ? 'CANCELLED (process killed)'
      : `exit code: ${result.exitCode ?? '?'} · ${result.durationMs}ms`;
  lines.push(status);

  const stdout = redactOutput(result.stdout, env);
  const stderr = redactOutput(result.stderr, env);

  if (stdout.trim() !== '') {
    lines.push('--- stdout ---');
    lines.push(stdout.replace(/\n$/, ''));
    if (result.stdoutTruncated) lines.push('(stdout truncated)');
  }
  if (stderr.trim() !== '') {
    lines.push('--- stderr ---');
    lines.push(stderr.replace(/\n$/, ''));
    if (result.stderrTruncated) lines.push('(stderr truncated)');
  }
  return lines.join('\n');
}

export function createExecTools(paths: WorkspacePaths): RegisteredTool[] {
  const runCommand = defineTool({
    name: 'run_command',
    description:
      'Run a program with an argument array (no shell). Read-only commands run ' +
      'directly; consequential commands require permission approval. Output is ' +
      'bounded and secrets are redacted.',
    schema: z.object({
      command: z
        .string()
        .min(1)
        .describe('Executable name, e.g. "git" or "bun" (no spaces or shell characters)'),
      args: z
        .array(z.string())
        .optional()
        .describe('Arguments passed verbatim (no shell interpretation)'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory (workspace-relative; default workspace root)'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600_000)
        .optional()
        .describe('Override the tool timeout'),
    }),
    permissionClass: 'execute',
    mutating: true,
    timeoutMs: 60_000,
    outputBudget: 40_000,
    dynamicPermissionClass: (args) =>
      classifyCommand(args.command, args.args ?? []).permissionClass,
    summarize: (args) => {
      const classification = classifyCommand(args.command, args.args ?? []);
      const line = [args.command, ...(args.args ?? [])].join(' ');
      return `${classification.mutating ? 'run' : 'inspect'}: ${line}`;
    },
    execute: (args, ctx) => {
      if (SHELL_METACHARACTERS.test(args.command) || args.command.includes('\0')) {
        throw new ToolError(
          `Invalid command name: "${args.command}". The command must be a bare executable; ` +
            'pass arguments separately in args — there is no shell.',
          { code: 'invalid-input' },
        );
      }
      const classification = classifyCommand(args.command, args.args ?? []);
      if (DENIED_PROGRAMS.has(basename(args.command))) {
        throw new ToolError(`Command not permitted: ${basename(args.command)}`, {
          code: 'denied',
          hint: 'This program is blocked by policy.',
        });
      }

      let cwd = paths.realRoot;
      if (args.cwd) {
        const resolved = paths.resolve(args.cwd, { mustExist: true });
        if (!statSync(resolved.abs).isDirectory()) {
          throw new ToolError(`cwd is not a directory: ${resolved.rel}`, { code: 'invalid-input' });
        }
        cwd = resolved.abs;
      }

      const timeoutMs = Math.max(1000, Math.min(args.timeoutMs ?? ctx.timeoutMs, ctx.timeoutMs));
      const processArgs = args.args ?? [];

      return runProcess(args.command, processArgs, {
        cwd,
        timeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.env ? { env: ctx.env } : {}),
      }).then((result) => {
        const commandLine = [args.command, ...processArgs].join(' ');
        const content = formatProcessResult(commandLine, result, ctx.env ?? process.env);
        const meta: Record<string, unknown> = {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          command: commandLine,
          classification: classification.kind,
        };
        if (result.spawnError) meta['spawnError'] = result.spawnError;
        const isError =
          Boolean(result.spawnError) ||
          result.timedOut ||
          result.cancelled ||
          result.exitCode !== 0;
        return { content, isError, meta };
      });
    },
  });

  const runTests = defineTool({
    name: 'run_tests',
    description:
      "Run the project's test command, detected from package.json / Bun configuration. " +
      'Reports pass/fail counts and the captured output.',
    schema: z.object({
      filter: z.string().optional().describe('Test name or file filter'),
      args: z.array(z.string()).optional().describe('Extra arguments after the test command'),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    }),
    permissionClass: 'execute',
    mutating: true,
    timeoutMs: 300_000,
    outputBudget: 60_000,
    summarize: () => 'run project tests',
    execute: (args, ctx) => {
      const detected = detectTestCommand(paths.realRoot);
      if (!detected) {
        throw new ToolError('No test setup detected', {
          code: 'unsupported',
          hint: 'Expected package.json scripts.test, a Bun lockfile, bunfig.toml, or *.test.ts files.',
        });
      }

      const extra = args.args ?? [];
      const processArgs = [...detected.args];
      if (args.filter) processArgs.push(args.filter);
      processArgs.push(...extra);

      const timeoutMs = Math.max(1000, Math.min(args.timeoutMs ?? ctx.timeoutMs, ctx.timeoutMs));
      return runProcess(detected.program, processArgs, {
        cwd: paths.realRoot,
        timeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.env ? { env: ctx.env } : {}),
        outputLimit: 60 * 1024,
      }).then((result) => {
        const commandLine = [detected.program, ...processArgs].join(' ');
        const combined = `${result.stdout}\n${result.stderr}`;
        const passMatch = /(\d+)\s+pass(?:ed)?\b/i.exec(combined);
        const failMatch = /(\d+)\s+fail(?:ed)?\b/i.exec(combined);
        const summaryParts: string[] = [`tests: ${commandLine}`, `detected via ${detected.source}`];
        if (passMatch) summaryParts.push(`passed: ${passMatch[1]}`);
        if (failMatch) summaryParts.push(`failed: ${failMatch[1]}`);
        if (!passMatch && !failMatch) summaryParts.push('(no pass/fail counts found in output)');

        const body = formatProcessResult(commandLine, result, ctx.env ?? process.env);
        const content = `${summaryParts.join(' · ')}\n${body}`;
        const meta: Record<string, unknown> = {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          command: commandLine,
        };
        if (passMatch) meta['passed'] = Number(passMatch[1]);
        if (failMatch) meta['failed'] = Number(failMatch[1]);

        const failedCount = failMatch ? Number(failMatch[1]) : 0;
        const isError =
          Boolean(result.spawnError) ||
          result.timedOut ||
          result.cancelled ||
          result.exitCode !== 0 ||
          failedCount > 0;
        return { content, isError, meta };
      });
    },
  });

  return [runCommand, runTests];
}
