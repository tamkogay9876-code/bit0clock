/**
 * Permission engine tests (§52): precedence, mode gates, approvals, audit.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PROJECT_RULES_PATH,
  PermissionEngine,
  createPermissionEngine,
  describeDecision,
  loadProjectRules,
  type PermissionEngineOptions,
} from './engine.js';
import type { PermissionRequest } from './types.js';
import type { PermissionRule } from '../types/index.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-perm-'));
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    action: 'read_file',
    permissionClass: 'read',
    summary: 'read a file',
    approvalKey: 'read_file',
    ...overrides,
  };
}

function writeRequest(): PermissionRequest {
  return request({
    action: 'edit_file',
    toolName: 'edit_file',
    permissionClass: 'write',
    summary: 'edit a file',
    approvalKey: 'edit_file',
  });
}

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: 'test-rule',
    action: '*',
    pattern: '*',
    effect: 'allow',
    scope: 'global',
    ...overrides,
  };
}

function engine(options: Partial<PermissionEngineOptions> = {}): PermissionEngine {
  return new PermissionEngine({
    workspaceRoot: makeRoot(),
    mode: 'build',
    interactive: false,
    ...options,
  });
}

describe('safe defaults', () => {
  it('allows reads by default, even non-interactively', () => {
    const outcome = engine().evaluate(request());
    expect(outcome.decision).toBe('allow');
    expect(outcome.reason).toContain('read-only actions');
  });

  it('denies consequential actions in non-interactive runs and points at --yes', () => {
    const outcome = engine().evaluate(writeRequest());
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason).toContain('--yes');
  });

  it('asks interactively for consequential actions', () => {
    expect(engine({ interactive: true }).evaluate(writeRequest()).decision).toBe('confirm');
  });

  it('labels destructive confirmations explicitly', () => {
    const outcome = engine({ interactive: true }).evaluate(
      request({
        action: 'delete_file',
        permissionClass: 'write',
        destructive: true,
        approvalKey: 'delete_file',
      }),
    );
    expect(outcome.decision).toBe('confirm');
    expect(outcome.reason).toContain('destructive');
  });

  it('auto-approves consequential actions with --yes', () => {
    const outcome = engine({ autoApprove: true }).evaluate(writeRequest());
    expect(outcome.decision).toBe('allow');
    expect(outcome.reason).toContain('--yes');
  });

  it('lets explicit user invocations satisfy confirmation without bypassing policy', () => {
    const runRequest = request({
      action: 'run_tests',
      permissionClass: 'execute',
      approvalKey: 'run_tests',
      userInitiated: true,
    });

    // Non-interactive run: the explicit invocation stands in for approval
    const outcome = engine().evaluate(runRequest);
    expect(outcome.decision).toBe('allow');
    expect(outcome.reason).toContain('explicitly invoked');

    // Deny rules still win
    const denied = engine({
      globalRules: [rule({ id: 'no-tests', action: 'run_tests', effect: 'deny' })],
    });
    expect(denied.evaluate(runRequest).decision).toBe('deny');

    // Read-only modes still win
    expect(engine({ mode: 'plan' }).evaluate(runRequest).decision).toBe('deny');
  });
});

describe('mode policy', () => {
  it('keeps read-only modes read-only, even with --yes and allow rules', () => {
    const engineInstance = engine({
      mode: 'plan',
      autoApprove: true,
      globalRules: [rule({ action: 'edit_file', scope: 'global' })],
    });
    const outcome = engineInstance.evaluate(writeRequest());
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason).toContain('read-only');
  });

  it('lets read and network classes through the read-only mode gate', () => {
    const engineInstance = engine({ mode: 'review', interactive: true });
    expect(engineInstance.evaluate(request()).decision).toBe('allow');

    // Network actions pass the mode gate but still follow the normal
    // confirmation policy — read-only modes do not silently allow them.
    const network = engineInstance.evaluate(
      request({ action: 'web_search', permissionClass: 'network', approvalKey: 'web_search' }),
    );
    expect(network.decision).toBe('confirm');
    expect(network.reason).not.toContain('read-only');
  });

  it('follows mode switches at runtime', () => {
    const engineInstance = engine({ interactive: true });
    expect(engineInstance.evaluate(writeRequest()).decision).toBe('confirm');
    engineInstance.setMode('plan');
    expect(engineInstance.evaluate(writeRequest()).decision).toBe('deny');
    expect(engineInstance.getMode()).toBe('plan');
  });
});

describe('rule precedence', () => {
  it('applies session approvals above every rule scope', () => {
    const engineInstance = engine({
      interactive: true,
      globalRules: [rule({ id: 'allow-global' })],
      projectRules: [rule({ id: 'deny-project', effect: 'deny', scope: 'project' })],
    });

    expect(engineInstance.evaluate(writeRequest()).decision).toBe('deny');

    engineInstance.approveForSession(writeRequest());
    expect(engineInstance.approvalCount()).toBe(1);
    const outcome = engineInstance.evaluate(writeRequest());
    expect(outcome.decision).toBe('allow');
    expect(outcome.reason).toContain('approved earlier in this session');
  });

  it('ranks project rules above global rules', () => {
    const engineInstance = engine({
      interactive: true,
      globalRules: [rule({ id: 'allow-global' })],
      projectRules: [rule({ id: 'deny-project', effect: 'deny', scope: 'project' })],
    });
    const outcome = engineInstance.evaluate(writeRequest());
    expect(outcome.decision).toBe('deny');
    expect(outcome.rule).toEqual({ id: 'deny-project', scope: 'project' });
  });

  it('lets an exact rule beat a wildcard rule in the same scope', () => {
    const engineInstance = engine({
      interactive: true,
      globalRules: [
        rule({ id: 'allow-wild', action: 'edit_*' }),
        rule({ id: 'deny-exact', action: 'edit_file', effect: 'deny' }),
      ],
    });
    const outcome = engineInstance.evaluate(writeRequest());
    expect(outcome.decision).toBe('deny');
    expect(outcome.rule?.id).toBe('deny-exact');
  });

  it('lets deny beat allow at equal specificity', () => {
    const engineInstance = engine({
      interactive: true,
      globalRules: [rule({ id: 'allow' }), rule({ id: 'deny', effect: 'deny' })],
    });
    expect(engineInstance.evaluate(writeRequest()).decision).toBe('deny');
  });

  it('matches patterns against invoked paths', () => {
    const engineInstance = engine({
      interactive: true,
      globalRules: [rule({ id: 'allow-src', action: 'edit_file', pattern: 'src/**' })],
    });

    const inSrc = engineInstance.evaluate(
      request({
        action: 'edit_file',
        permissionClass: 'write',
        approvalKey: 'edit_file',
        paths: ['src/a.ts'],
      }),
    );
    expect(inSrc.decision).toBe('allow');
    expect(inSrc.rule?.id).toBe('allow-src');

    const outside = engineInstance.evaluate(
      request({
        action: 'edit_file',
        permissionClass: 'write',
        approvalKey: 'edit_file',
        paths: ['lib/a.ts'],
      }),
    );
    expect(outside.decision).toBe('confirm');
  });

  it('supports session-scope rule injection', () => {
    const engineInstance = engine({ interactive: true });
    engineInstance.addSessionRule(rule({ id: 'session-allow', action: 'edit_file' }));
    expect(engineInstance.sessionRuleCount()).toBe(1);
    expect(engineInstance.evaluate(writeRequest()).decision).toBe('allow');
  });
});

describe('audit', () => {
  it('records decisions and stays bounded', () => {
    const engineInstance = engine();
    for (let i = 0; i < 205; i++) {
      engineInstance.noteDecision(request(), 'allow', 'test');
    }
    const entries = engineInstance.audit();
    expect(entries).toHaveLength(200);
    expect(entries[0]?.action).toBe('read_file');
  });

  it('describeDecision renders every decision type', () => {
    expect(describeDecision({ decision: 'allow', reason: 'ok' })).toBe('ALLOW: ok');
    expect(describeDecision({ decision: 'deny', reason: 'no' })).toBe('DENY: no');
    expect(describeDecision({ decision: 'confirm', reason: 'ask' })).toBe('CONFIRM: ask');
  });
});

describe('project rules files', () => {
  it('returns no rules when the file is absent', () => {
    expect(loadProjectRules(makeRoot())).toEqual({ rules: [] });
  });

  it('loads valid rules and stamps them with project scope', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.mediaxg'));
    writeFileSync(
      join(root, PROJECT_RULES_PATH),
      JSON.stringify([
        {
          id: 'no-secrets',
          action: 'edit_file',
          pattern: '**/*.pem',
          effect: 'deny',
          scope: 'project',
        },
      ]),
    );

    const loaded = loadProjectRules(root);
    expect(loaded.error).toBeUndefined();
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]?.scope).toBe('project');
  });

  it('reports invalid JSON and schema errors instead of guessing', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.mediaxg'));
    writeFileSync(join(root, PROJECT_RULES_PATH), '{not json');

    const badJson = loadProjectRules(root);
    expect(badJson.rules).toEqual([]);
    expect(badJson.error).toContain(PROJECT_RULES_PATH);
    expect(badJson.error).toContain('invalid JSON');

    writeFileSync(join(root, PROJECT_RULES_PATH), JSON.stringify([{ id: '', action: 'x' }]));
    const badSchema = loadProjectRules(root);
    expect(badSchema.rules).toEqual([]);
    expect(badSchema.error).toContain('schema errors');
  });

  it('createPermissionEngine loads project rules and exposes load errors', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.mediaxg'));
    writeFileSync(join(root, PROJECT_RULES_PATH), 'not-json');

    const engineInstance = createPermissionEngine({
      workspaceRoot: root,
      mode: 'build',
      globalRules: [],
      interactive: false,
    });

    expect(engineInstance.projectRulesError).toContain(PROJECT_RULES_PATH);
    expect(engineInstance.projectRules).toEqual([]);
  });

  it('project rules actually influence decisions through createPermissionEngine', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.mediaxg'));
    writeFileSync(
      join(root, PROJECT_RULES_PATH),
      JSON.stringify([
        { id: 'allow-edits', action: 'edit_file', pattern: '*', effect: 'allow', scope: 'project' },
      ]),
    );

    const engineInstance = createPermissionEngine({
      workspaceRoot: root,
      mode: 'build',
      globalRules: [],
      interactive: false,
    });

    expect(engineInstance.evaluate(writeRequest()).decision).toBe('allow');
  });
});
