/**
 * Agent mode registry.
 *
 * Modes are capability profiles: they constrain what tools are allowed to do.
 * The permission engine (Phase D) enforces these; this registry is the single
 * source of truth for mode metadata so no code re-defines mode behavior.
 */

import type { AgentMode, PermissionClass } from '../types/index.js';

export interface ModeDescriptor {
  id: AgentMode;
  label: string;
  description: string;
  /**
   * Read-only modes must not perform file mutations, destructive commands,
   * commits, or other state-changing actions — enforced by the permission
   * engine, not by prompt text alone.
   */
  readOnly: boolean;
  /** Baseline permission classes the mode may ever use (subject to policy) */
  allowedPermissionClasses: PermissionClass[];
  /** Mode-specific system prompt fragment */
  systemPromptFragment: string;
}

export const MODES: Record<AgentMode, ModeDescriptor> = {
  plan: {
    id: 'plan',
    label: 'PLAN',
    description: 'Inspect and plan without modifying anything (read-only)',
    readOnly: true,
    allowedPermissionClasses: ['read', 'network'],
    systemPromptFragment:
      'You are in PLAN mode. Inspect, search, and analyze only. Do not modify files, ' +
      'run state-changing commands, or claim that changes were made. Produce clear plans ' +
      'with goals, steps, risks, and a verification approach.',
  },
  build: {
    id: 'build',
    label: 'BUILD',
    description: 'Implement changes under the permission policy',
    readOnly: false,
    allowedPermissionClasses: ['read', 'write', 'execute', 'network', 'git', 'config', 'mcp'],
    systemPromptFragment:
      'You are in BUILD mode. Implement the task incrementally, verify your changes, ' +
      'and report exactly what succeeded and what remains. Never claim a command ' +
      'succeeded if it failed, timed out, or was not executed.',
  },
  review: {
    id: 'review',
    label: 'REVIEW',
    description: 'Inspect diffs and report risks without rewriting',
    readOnly: true,
    allowedPermissionClasses: ['read', 'network'],
    systemPromptFragment:
      'You are in REVIEW mode. Inspect diffs and related sources, identify bugs and risks, ' +
      'and report them. Do not silently rewrite the changes under review.',
  },
};

export function isMode(value: string): value is AgentMode {
  return value === 'plan' || value === 'build' || value === 'review';
}

export function modeLabel(mode: AgentMode): string {
  return MODES[mode].label;
}
