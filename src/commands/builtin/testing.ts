/**
 * Test and lint commands: /test and /lint (§12, §46).
 *
 * These run the project's real scripts, detected from manifests. The
 * permission engine still applies (deny rules and read-only modes deny the
 * run); an explicit slash command by the user satisfies the interactive
 * confirmation step, and that is recorded in the audit trail.
 */

import type { AppState } from '../../app/state.js';
import { runProcess } from '../../tools/exec-tools.js';
import { detectLintCommand, detectTestCommand, type DetectedCommand } from '../../tools/project.js';
import { appendPermissionAudit } from '../../agent/tool-runner.js';
import type { PermissionRequest } from '../../permissions/types.js';
import type { CommandDefinition, CommandResult } from '../types.js';

const RUN_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT = 60 * 1024;
const DISPLAY_LIMIT = 30_000;

function formatRun(
  command: DetectedCommand,
  result: Awaited<ReturnType<typeof runProcess>>,
): string {
  const lines: string[] = [
    `$ ${command.program} ${command.args.join(' ')}`,
    `detected via ${command.source}`,
    '',
  ];

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

  const stdout = result.stdout;
  const stderr = result.stderr;
  if (stdout.trim() !== '') {
    lines.push('', '--- output ---');
    lines.push(
      stdout.length > DISPLAY_LIMIT
        ? `${stdout.slice(0, DISPLAY_LIMIT)}\n… (output truncated for display)`
        : stdout.replace(/\n$/, ''),
    );
    if (result.stdoutTruncated) lines.push('(stdout truncated at the capture cap)');
  }
  if (stderr.trim() !== '') {
    lines.push('', '--- stderr ---');
    lines.push(
      stderr.length > DISPLAY_LIMIT
        ? `${stderr.slice(0, DISPLAY_LIMIT)}\n… (stderr truncated for display)`
        : stderr.replace(/\n$/, ''),
    );
    if (result.stderrTruncated) lines.push('(stderr truncated at the capture cap)');
  }
  return lines.join('\n');
}

async function runChecked(
  app: AppState,
  command: DetectedCommand,
  request: PermissionRequest,
): Promise<CommandResult> {
  const decision = app.permissions.evaluate(request);
  if (decision.decision === 'deny') {
    return {
      ok: false,
      error:
        `Denied by policy: ${decision.reason}\n` +
        `Command: ${command.program} ${command.args.join(' ')}`,
    };
  }

  const audit = app.permissions.noteDecision(
    request,
    'approved-once',
    'explicit slash command invocation (user-initiated)',
    decision.rule?.scope,
  );
  appendPermissionAudit(app.session, audit);
  app.saveSession();

  const result = await runProcess(command.program, command.args, {
    cwd: app.projectPath,
    timeoutMs: RUN_TIMEOUT_MS,
    outputLimit: OUTPUT_LIMIT,
  });

  const output = formatRun(command, result);
  const isError =
    Boolean(result.spawnError) || result.timedOut || result.cancelled || result.exitCode !== 0;
  return isError ? { ok: false, error: output } : { ok: true, output };
}

export function createTestingCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'test',
      category: 'workspace',
      description: "Run the project's detected test command and report results",
      usage: '/test [extra args…]',
      examples: ['/test', '/test --filter auth', '/test src/session'],
      handler: async ({ args }): Promise<CommandResult> => {
        const detected = detectTestCommand(app.projectPath);
        if (!detected) {
          return {
            ok: false,
            error:
              'No test setup detected. Expected one of:\n' +
              '  - package.json with a "test" script\n' +
              '  - bun.lock / bun.lockb / bunfig.toml\n' +
              '  - *.test.ts files',
          };
        }
        const command: DetectedCommand = { ...detected, args: [...detected.args, ...args] };
        const request: PermissionRequest = {
          action: 'run_tests',
          toolName: 'run_tests',
          permissionClass: 'execute',
          summary: `run tests: ${command.program} ${command.args.join(' ')}`,
          approvalKey: 'run_tests',
          userInitiated: true,
        };
        return runChecked(app, command, request);
      },
    },

    {
      name: 'lint',
      category: 'workspace',
      description: "Run the project's detected lint/typecheck command",
      usage: '/lint [extra args…]',
      examples: ['/lint', '/lint --fix'],
      handler: async ({ args }): Promise<CommandResult> => {
        const detected = detectLintCommand(app.projectPath);
        if (!detected) {
          return {
            ok: false,
            error:
              'No lint/typecheck setup detected. Expected one of:\n' +
              '  - package.json with a "lint" or "typecheck" script\n' +
              '  - tsconfig.json with a local typescript dependency',
          };
        }
        const command: DetectedCommand = { ...detected, args: [...detected.args, ...args] };
        const request: PermissionRequest = {
          action: 'run_lint',
          toolName: 'run_lint',
          permissionClass: 'execute',
          summary: `run lint: ${command.program} ${command.args.join(' ')}`,
          approvalKey: 'run_lint',
          userInitiated: true,
        };
        return runChecked(app, command, request);
      },
    },
  ];
}
