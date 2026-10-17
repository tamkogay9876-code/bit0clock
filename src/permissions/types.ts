/**
 * Permission engine types (§52).
 */

import type { PermissionClass, PermissionRule } from '../types/index.js';

export type PermissionDecision = 'allow' | 'deny' | 'confirm';

export interface PermissionRequest {
  /**
   * Action identifier matched by rules, e.g. `edit_file`,
   * `command:git status`, `read_file`. The same request shape is produced
   * regardless of whether the action came from natural language, a slash
   * command, a Skill, or (later) an MCP result.
   */
  action: string;
  toolName?: string;
  permissionClass: PermissionClass;
  /** One-line human summary shown in prompts and the audit log */
  summary: string;
  /** Extra detail (command line, target paths, diff summary) */
  detail?: string;
  destructive?: boolean;
  /** Workspace-relative paths involved (used for pattern matching) */
  paths?: string[];
  /** Stable key for "always allow in this session" */
  approvalKey: string;
  /**
   * True when the user explicitly invoked this action as a slash command
   * (`/test`, `/lint`). The invocation satisfies the interactive confirmation
   * step; deny rules and read-only mode policy still apply absolutely.
   */
  userInitiated?: boolean;
}

export interface PermissionOutcome {
  decision: PermissionDecision;
  reason: string;
  rule?: { id: string; scope: PermissionRule['scope'] };
}

export type PermissionAuditDecision = PermissionDecision | 'approved-once' | 'approved-session';

export interface PermissionAuditEntry {
  timestamp: string;
  action: string;
  permissionClass: PermissionClass;
  decision: PermissionAuditDecision;
  reason: string;
  scope?: PermissionRule['scope'];
  toolName?: string;
}

export interface PermissionPromptResponse {
  decision: 'allow' | 'allow-session' | 'deny';
}
