/**
 * Phase D command tests: /diff, /undo, /instructions, /plan, /permissions,
 * /tools, /test, /lint, /review.
 *
 * Uses real git repositories and real subprocesses where the command itself
 * shells out, so the tests exercise the same paths users hit.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandRegistry } from '../registry.js';
import { registerBuiltinCommands } from './index.js';
import { parseInput } from '../parser.js';
import type { CommandResult } from '../types.js';
import { createTestApp, seedModels, testProvider } from '../../app/test-utils.js';
import { runProcess } from '../../tools/exec-tools.js';
import { createChangeRecord } from '../../tools/ledger.js';
import type { AppState } from '../../app/state.js';
import type { Plan } from '../../types/index.js';

function registryFor(app: AppState): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);
  return registry;
}

async function run(registry: CommandRegistry, input: string): Promise<CommandResult> {
  const result = await registry.dispatch(parseInput(input));
  if (!result) throw new Error(`Not a command: ${input}`);
  return result;
}

function makeApp() {
  return createTestApp({
    providers: [testProvider()],
    catalog: { test: seedModels() },
  });
}

function samplePlan(): Plan {
  return {
    id: 'plan-1',
    goal: 'Ship Phase D',
    constraints: ['no new dependencies'],
    relevantFiles: ['src/agent/loop.ts'],
    proposedSteps: [
      { id: 's1', description: 'Write tests', status: 'pending', toolCalls: [] },
      { id: 's2', description: 'Update docs', status: 'pending', toolCalls: [] },
    ],
    risks: ['flaky tests'],
    requiredPermissions: ['write', 'execute'],
    verificationPlan: 'bun test',
    currentStepIndex: 0,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('/tools', () => {
  it('lists native tools with permission metadata', async () => {
    const { app } = makeApp();
    const result = await run(registryFor(app), '/tools');

    expect(result.ok).toBe(true);
    expect(result.output).toContain('read_file');
    expect(result.output).toContain('delete_file');
    expect(result.output).toContain('[write, mutating, destructive]');
    expect(result.output).toContain('run_command');
    expect(result.output).toContain('[execute, mutating, per-call class]');
  });

  it('marks mutating tools as unavailable in read-only modes', async () => {
    const { app } = makeApp();
    app.setMode('plan');
    const result = await run(registryFor(app), '/tools');

    expect(result.output).toContain('read-only');
    expect(result.output).toContain('× delete_file');
    expect(result.output).toContain('  read_file');
  });
});

describe('/permissions', () => {
  it('shows the precedence chain, scopes, and mode policy', async () => {
    const { dir } = makeApp();
    mkdirSync(join(dir, '.mediaxg'), { recursive: true });
    writeFileSync(
      join(dir, '.mediaxg', 'permissions.json'),
      JSON.stringify([
        { id: 'allow-edits', action: 'edit_file', pattern: '*', effect: 'allow', scope: 'project' },
      ]),
    );

    const { app: appWithRules } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });
    appWithRules.permissions.approveForSession({
      action: 'run_command',
      permissionClass: 'execute',
      summary: 'run a command',
      approvalKey: 'run_command',
    });

    const result = await run(registryFor(appWithRules), '/permissions');

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Precedence (highest first):');
    expect(result.output).toContain('.mediaxg/permissions.json');
    expect(result.output).toContain('mode policy');
    expect(result.output).toContain('allow-edits');
    expect(result.output).toContain('session approvals (1):');
    expect(result.output).toContain('✔ run_command');
    expect(result.output).toContain('instruction files');
  });

  it('reports project rule load errors instead of hiding them', async () => {
    const { dir } = makeApp();
    mkdirSync(join(dir, '.mediaxg'), { recursive: true });
    writeFileSync(join(dir, '.mediaxg', 'permissions.json'), '{broken');

    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });

    const result = await run(registryFor(app), '/permissions');
    expect(result.output).toContain('!! .mediaxg/permissions.json');
  });
});

describe('/plan', () => {
  it('explains when no plan is recorded', async () => {
    const { app } = makeApp();
    const result = await run(registryFor(app), '/plan');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No plan recorded');
    expect(result.output).toContain('update_plan');
  });

  it('shows the recorded plan and manages its lifecycle', async () => {
    const { app } = makeApp();
    app.session.plan = samplePlan();
    const registry = registryFor(app);

    const shown = await run(registry, '/plan');
    expect(shown.output).toContain('Plan (active)');
    expect(shown.output).toContain('Goal: Ship Phase D');
    expect(shown.output).toContain('1. [pending] Write tests');
    expect(shown.output).toContain('Required permissions: write, execute');
    expect(shown.output).toContain('does not grant permissions');

    const cancelled = await run(registry, '/plan cancel');
    expect(cancelled.ok).toBe(true);
    expect(app.session.plan?.status).toBe('cancelled');

    const cleared = await run(registry, '/plan clear');
    expect(cleared.ok).toBe(true);
    expect(app.session.plan).toBeNull();
  });

  it('rejects unknown subcommands and missing plans', async () => {
    const { app } = makeApp();
    const registry = registryFor(app);

    const unknown = await run(registry, '/plan nonsense');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Unknown subcommand');

    const cancel = await run(registry, '/plan cancel');
    expect(cancel.ok).toBe(false);
    expect(cancel.error).toContain('No plan to cancel');
  });
});

describe('/undo', () => {
  it('reports nothing to undo on a clean session', async () => {
    const { app } = makeApp();
    const result = await run(registryFor(app), '/undo');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Nothing to undo');
  });

  it('previews without --yes and reverts with --yes', async () => {
    const { app, dir } = makeApp();
    writeFileSync(join(dir, 'agent-created.txt'), 'agent output\n');
    app.session.changeLedger = [
      createChangeRecord({
        kind: 'create',
        path: 'agent-created.txt',
        afterContent: 'agent output\n',
      }),
    ];
    const registry = registryFor(app);

    const preview = await run(registry, '/undo');
    expect(preview.ok).toBe(true);
    expect(preview.output).toContain('Would revert 1 change(s)');
    expect(preview.output).toContain('create   agent-created.txt');
    expect(preview.output).toContain('Re-run to confirm: /undo 1 --yes');
    expect(existsSync(join(dir, 'agent-created.txt'))).toBe(true);

    const applied = await run(registry, '/undo --yes');
    expect(applied.ok).toBe(true);
    expect(applied.output).toContain('Undo: 1/1 change(s) reverted');
    expect(existsSync(join(dir, 'agent-created.txt'))).toBe(false);
  });

  it('refuses files modified since the agent wrote them', async () => {
    const { app, dir } = makeApp();
    writeFileSync(join(dir, 'edited.txt'), 'user typed here');
    app.session.changeLedger = [
      createChangeRecord({
        kind: 'edit',
        path: 'edited.txt',
        beforeContent: 'original',
        afterContent: 'agent version',
      }),
    ];

    const result = await run(registryFor(app), '/undo --yes');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('refusing');
    expect(readFileSync(join(dir, 'edited.txt'), 'utf8')).toBe('user typed here');
  });
});

describe('/diff', () => {
  it('falls back to the change ledger outside git', async () => {
    const { app } = makeApp();
    app.session.changeLedger = [createChangeRecord({ kind: 'create', path: 'fresh.txt' })];

    const result = await run(registryFor(app), '/diff');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Not a git repository');
    expect(result.output).toContain('create fresh.txt');
  });

  it('reports the real git diff in a repository', async () => {
    const { app, dir } = makeApp();
    const init = await runProcess('git', ['init'], { cwd: dir, timeoutMs: 15_000 });
    expect(init.exitCode).toBe(0);

    writeFileSync(join(dir, 'staged.txt'), 'hello staged\n');
    await runProcess('git', ['add', 'staged.txt'], { cwd: dir, timeoutMs: 15_000 });

    const result = await run(registryFor(app), '/diff --staged');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Staged changes: 1 file(s)');
    expect(result.output).toContain('staged.txt');
    expect(result.output).toContain('+hello staged');
  });
});

describe('/instructions', () => {
  it('lists precedence and discovered files', async () => {
    const { app, dir } = makeApp();
    const registry = registryFor(app);

    const empty = await run(registry, '/instructions');
    expect(empty.output).toContain('Instruction precedence');
    expect(empty.output).toContain('No instruction files found');

    writeFileSync(join(dir, 'MEDIAXG.md'), 'project rules here');
    const withFile = await run(registry, '/instructions');
    expect(withFile.output).toContain('MEDIAXG.md');
    expect(withFile.output).toContain('lower trust');
  });
});

describe('/test and /lint', () => {
  it('runs the detected test command and audits the explicit invocation', async () => {
    const { app, dir } = makeApp();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        packageManager: 'bun@1.1.0',
        scripts: { test: `bun -e "console.log('2 pass, 0 fail')"` },
      }),
    );

    // Non-interactive app: the explicit slash command still satisfies confirmation
    const result = await run(registryFor(app), '/test');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('exit code: 0');
    expect(result.output).toContain('2 pass, 0 fail');
    expect(app.session.permissionAudit?.[0]?.decision).toBe('approved-once');
    expect(app.session.permissionAudit?.[0]?.reason).toContain('explicit slash command');
  });

  it('denies /test in read-only modes', async () => {
    const { app, dir } = makeApp();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.1.0', scripts: { test: 'bun test' } }),
    );
    app.setMode('plan');

    const result = await run(registryFor(app), '/test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('explains how to set up tests and lint when nothing is detected', async () => {
    const { app } = makeApp();
    const registry = registryFor(app);

    const test = await run(registry, '/test');
    expect(test.ok).toBe(false);
    expect(test.error).toContain('No test setup detected');

    const lint = await run(registry, '/lint');
    expect(lint.ok).toBe(false);
    expect(lint.error).toContain('No lint/typecheck setup detected');
  });

  it('runs the detected lint command', async () => {
    const { app, dir } = makeApp();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        packageManager: 'bun@1.1.0',
        scripts: { lint: `bun -e "console.log('lint clean')"` },
      }),
    );

    const result = await run(registryFor(app), '/lint');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('lint clean');
    expect(result.output).toContain('scripts.lint');
  });
});

describe('/review', () => {
  it('requires a selected model', async () => {
    const { app } = makeApp();
    const result = await run(registryFor(app), '/review');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No model selected');
  });

  it('reports nothing to review on an empty workspace', async () => {
    const { app } = makeApp();
    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(registryFor(app), '/review');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No changes recorded');
    expect(result.action).toBeUndefined();
  });

  it('switches to review mode and starts a read-only agent turn with the diff', async () => {
    const { app, dir } = makeApp();
    await runProcess('git', ['init'], { cwd: dir, timeoutMs: 15_000 });
    writeFileSync(join(dir, 'changed.txt'), 'new content\n');
    await runProcess('git', ['add', 'changed.txt'], { cwd: dir, timeoutMs: 15_000 });
    writeFileSync(join(dir, 'changed.txt'), 'new content\nplus a line\n');

    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(registryFor(app), '/review');

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Mode switched to REVIEW');
    expect(app.session.mode).toBe('review');
    expect(app.permissions.getMode()).toBe('review');

    expect(result.action?.type).toBe('start-agent-turn');
    if (result.action?.type !== 'start-agent-turn') throw new Error('unreachable');
    expect(result.action.contextPreamble).toContain('plus a line');
    expect(result.action.prompt).toContain('read-only');
  });
});
