/**
 * Central permission engine (§52).
 *
 * Policy sources and documented precedence (highest first):
 *   1. Session scope   — approvals and rules created during this session
 *   2. Project scope   — `.mediaxg/permissions.json` in the workspace
 *   3. Global scope    — `permissionRules` in the user configuration
 *   4. Mode policy     — read-only modes deny write/execute/git/content actions
 *   5. Safe defaults   — reads allowed; everything consequential is confirmed
 *                        interactively, denied in non-interactive runs (unless
 *                        --yes auto-approves), and never silently allowed.
 *
 * Within a scope, an exact rule beats a wildcard rule, and deny beats allow
 * at equal specificity. Mode policy cannot be overridden by rules: read-only
 * modes stay read-only regardless of allow rules.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import { MODES } from '../modes/index.js';
import type { AgentMode, PermissionClass, PermissionRule } from '../types/index.js';
import { permissionRuleSchema } from '../config/schema.js';
import { getLogger } from '../logger/index.js';
import type {
  PermissionAuditEntry,
  PermissionDecision,
  PermissionOutcome,
  PermissionRequest,
} from './types.js';

export const PROJECT_RULES_PATH = '.mediaxg/permissions.json';
const MAX_AUDIT_ENTRIES = 200;

export interface ProjectRulesLoad {
  rules: PermissionRule[];
  error?: string;
}

/** Load project-scope rules; invalid files are reported, never guessed at. */
export function loadProjectRules(workspaceRoot: string): ProjectRulesLoad {
  const path = join(workspaceRoot, PROJECT_RULES_PATH);
  if (!existsSync(path)) return { rules: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      rules: [],
      error: `${PROJECT_RULES_PATH}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const result = z.array(permissionRuleSchema).safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { rules: [], error: `${PROJECT_RULES_PATH}: schema errors (${issues})` };
  }

  return {
    rules: result.data.map((rule) => ({ ...rule, scope: 'project' as const })),
  };
}

export interface PermissionEngineOptions {
  workspaceRoot: string;
  mode: AgentMode;
  globalRules?: PermissionRule[];
  projectRules?: PermissionRule[];
  projectRulesError?: string;
  /** Interactive runs may ask the user; non-interactive runs deny by default */
  interactive: boolean;
  /** --yes: auto-approve actions that would otherwise require confirmation */
  autoApprove?: boolean;
}

interface RuleMatch {
  rule: PermissionRule;
  scopeRank: number;
  specificity: number;
}

export class PermissionEngine {
  readonly workspaceRoot: string;
  readonly globalRules: PermissionRule[];
  readonly projectRules: PermissionRule[];
  readonly projectRulesError?: string;
  /** False for --yes and for policy-only runs */
  readonly interactive: boolean;
  readonly autoApprove: boolean;

  private mode: AgentMode;
  private sessionRules: PermissionRule[] = [];
  private sessionApprovals = new Map<string, string>();
  private auditEntries: PermissionAuditEntry[] = [];
  private logger = getLogger();

  constructor(options: PermissionEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.mode = options.mode;
    this.globalRules = options.globalRules ?? [];
    this.projectRules = options.projectRules ?? [];
    if (options.projectRulesError) this.projectRulesError = options.projectRulesError;
    this.interactive = options.interactive;
    this.autoApprove = options.autoApprove ?? false;
  }

  getMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
  }

  // --------------------------------------------------------------------------
  // Evaluation
  // --------------------------------------------------------------------------

  evaluate(request: PermissionRequest): PermissionOutcome {
    const descriptor = MODES[this.mode];

    // 1. Mode policy gate — absolute for read-only modes
    if (
      descriptor.readOnly &&
      request.permissionClass !== 'read' &&
      request.permissionClass !== 'network'
    ) {
      return {
        decision: 'deny',
        reason:
          `${descriptor.label} mode is read-only and cannot perform ${request.permissionClass} actions. ` +
          'Switch with /mode build to allow them.',
      };
    }
    if (!descriptor.allowedPermissionClasses.includes(request.permissionClass)) {
      return {
        decision: 'deny',
        reason: `${descriptor.label} mode does not permit ${request.permissionClass} actions.`,
      };
    }

    // 2. Session approvals (from "always allow" in this session)
    const approvalReason = this.sessionApprovals.get(request.approvalKey);
    if (approvalReason) {
      return {
        decision: 'allow',
        reason: `approved earlier in this session (${request.approvalKey})`,
        rule: { id: `session-approval:${request.approvalKey}`, scope: 'session' },
      };
    }

    // 3. Policy rules: session > project > global
    const matched = this.matchRules(request);
    if (matched.length > 0) {
      const best = matched[0]!;
      const sameTier = matched.filter(
        (m) => m.scopeRank === best.scopeRank && m.specificity === best.specificity,
      );
      const deny = sameTier.find((m) => m.rule.effect === 'deny');
      const chosen = deny ?? best;
      return {
        decision: chosen.rule.effect === 'allow' ? 'allow' : 'deny',
        reason: `matched ${chosen.rule.scope}-scope rule ${chosen.rule.id} (${chosen.rule.action} / ${chosen.rule.pattern})`,
        rule: { id: chosen.rule.id, scope: chosen.rule.scope },
      };
    }

    // 4. Safe defaults
    if (request.permissionClass === 'read') {
      return { decision: 'allow', reason: 'read-only actions are allowed by default' };
    }
    if (this.autoApprove || request.userInitiated) {
      return {
        decision: 'allow',
        reason: request.userInitiated
          ? 'explicitly invoked by the user (the invocation satisfies confirmation)'
          : 'auto-approved: --yes was passed (consequential actions are not confirmed)',
      };
    }
    if (!this.interactive) {
      return {
        decision: 'deny',
        reason:
          'requires confirmation, but this run is non-interactive. ' +
          'Re-run with --yes to auto-approve, or add an allow rule (global config or ' +
          `${PROJECT_RULES_PATH}).`,
      };
    }
    return {
      decision: 'confirm',
      reason: request.destructive
        ? 'destructive action — explicit confirmation required'
        : 'consequential action — confirmation required',
    };
  }

  /** Record an interactive approval for the rest of the session. */
  approveForSession(request: PermissionRequest): void {
    this.sessionApprovals.set(request.approvalKey, new Date().toISOString());
  }

  /** Session-scope rules (kept for rule injection from commands/tests). */
  addSessionRule(rule: PermissionRule): void {
    this.sessionRules.push({ ...rule, scope: 'session' });
  }

  sessionRuleCount(): number {
    return this.sessionRules.length;
  }

  approvalCount(): number {
    return this.sessionApprovals.size;
  }

  activeApprovalKeys(): string[] {
    return [...this.sessionApprovals.keys()].sort();
  }

  // --------------------------------------------------------------------------
  // Audit
  // --------------------------------------------------------------------------

  noteDecision(
    request: PermissionRequest,
    decision: PermissionAuditEntry['decision'],
    reason: string,
    scope?: PermissionRule['scope'],
  ): PermissionAuditEntry {
    const entry: PermissionAuditEntry = {
      timestamp: new Date().toISOString(),
      action: request.action,
      permissionClass: request.permissionClass,
      decision,
      reason,
    };
    if (request.toolName) entry.toolName = request.toolName;
    if (scope) entry.scope = scope;
    this.auditEntries.push(entry);
    if (this.auditEntries.length > MAX_AUDIT_ENTRIES) {
      this.auditEntries.splice(0, this.auditEntries.length - MAX_AUDIT_ENTRIES);
    }
    this.logger.debug('permission decision', {
      action: request.action,
      decision,
      reason,
    });
    return entry;
  }

  audit(): PermissionAuditEntry[] {
    return [...this.auditEntries];
  }

  // --------------------------------------------------------------------------
  // Rule matching
  // --------------------------------------------------------------------------

  private matchRules(request: PermissionRequest): RuleMatch[] {
    const sources: Array<{ rules: PermissionRule[]; scopeRank: number }> = [
      { rules: this.sessionRules, scopeRank: 3 },
      { rules: this.projectRules, scopeRank: 2 },
      { rules: this.globalRules, scopeRank: 1 },
    ];

    const matches: RuleMatch[] = [];
    for (const source of sources) {
      for (const rule of source.rules) {
        if (!this.ruleMatchesRequest(rule, request)) continue;
        matches.push({
          rule,
          scopeRank: source.scopeRank,
          specificity: rule.action.includes('*') ? 1 : 2,
        });
      }
    }

    matches.sort(
      (a, b) =>
        b.scopeRank - a.scopeRank ||
        b.specificity - a.specificity ||
        (a.rule.effect === 'deny' ? -1 : 1) - (b.rule.effect === 'deny' ? -1 : 1),
    );
    return matches;
  }

  private ruleMatchesRequest(rule: PermissionRule, request: PermissionRequest): boolean {
    const actionMatches =
      rule.action === request.action ||
      rule.action === '*' ||
      minimatch(request.action, rule.action, { nocase: false });
    if (!actionMatches) return false;

    if (rule.pattern === '*') return true;
    const candidates = [...(request.paths ?? [])];
    if (request.detail) candidates.push(request.detail);
    return candidates.some((candidate) => minimatch(candidate, rule.pattern, { nocase: false }));
  }
}

/** Build an engine from global config + project files, logging load issues. */
export function createPermissionEngine(options: {
  workspaceRoot: string;
  mode: AgentMode;
  globalRules: PermissionRule[];
  interactive: boolean;
  autoApprove?: boolean;
}): PermissionEngine {
  const project = loadProjectRules(options.workspaceRoot);
  if (project.error) {
    getLogger().warn('Project permission rules not loaded', { error: project.error });
  }
  const engineOptions: PermissionEngineOptions = {
    workspaceRoot: options.workspaceRoot,
    mode: options.mode,
    globalRules: options.globalRules,
    projectRules: project.rules,
    interactive: options.interactive,
    autoApprove: options.autoApprove ?? false,
  };
  if (project.error) engineOptions.projectRulesError = project.error;
  return new PermissionEngine(engineOptions);
}

/** Human-readable description of one decision, used by prompts and logs. */
export function describeDecision(outcome: PermissionOutcome): string {
  const label: Record<PermissionDecision, string> = {
    allow: 'ALLOW',
    deny: 'DENY',
    confirm: 'CONFIRM',
  };
  return `${label[outcome.decision]}: ${outcome.reason}`;
}
