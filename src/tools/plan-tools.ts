/**
 * Plan-state tool: update_plan (§45).
 *
 * The model records a structured plan (goal, constraints, steps, risks,
 * required permissions, verification) into the session. Plan mode is
 * read-only for the workspace, but recording/updating a plan is session
 * bookkeeping — it touches no files and is always allowed.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { Plan, PlanStep } from '../types/index.js';
import { defineTool, toolOk, type RegisteredTool } from './types.js';

export interface PlanStore {
  get(): Plan | null;
  set(plan: Plan | null): void;
}

const stepSchema = z.object({
  description: z.string().min(1).describe('What this step does'),
  status: z
    .enum(['pending', 'in-progress', 'completed', 'blocked', 'skipped'])
    .optional()
    .describe('Step status (default pending)'),
});

export function createPlanTools(store: PlanStore): RegisteredTool[] {
  const updatePlan = defineTool({
    name: 'update_plan',
    description:
      'Record or update the structured task plan in the session (goal, constraints, ' +
      'steps, risks, required permissions, verification plan). Use for complex tasks; ' +
      'keeps the user able to inspect, edit, cancel, or restart the plan. Does not ' +
      'authorize any action — every step still needs normal permissions.',
    schema: z.object({
      goal: z.string().min(1).describe('The overall goal'),
      steps: z.array(stepSchema).min(1).describe('Proposed steps in order'),
      constraints: z.array(z.string()).optional(),
      relevantFiles: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      requiredPermissions: z
        .array(z.string())
        .optional()
        .describe('Permission classes the plan will need, e.g. ["write", "execute"]'),
      verificationPlan: z.string().optional().describe('How completion will be verified'),
      replace: z
        .boolean()
        .optional()
        .describe('Replace the current plan entirely (default: merge/update)'),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 5_000,
    outputBudget: 5_000,
    summarize: (args) => `update plan: ${args.goal.slice(0, 80)}`,
    execute: (args) => {
      const now = new Date().toISOString();
      const current = store.get();

      if (!current || args.replace) {
        const steps: PlanStep[] = args.steps.map((step) => ({
          id: randomUUID(),
          description: step.description,
          status: normalizeStepStatus(step.status),
          toolCalls: [],
        }));
        const plan: Plan = {
          id: randomUUID(),
          goal: args.goal,
          constraints: args.constraints ?? [],
          relevantFiles: args.relevantFiles ?? [],
          proposedSteps: steps,
          risks: args.risks ?? [],
          requiredPermissions: args.requiredPermissions ?? [],
          verificationPlan: args.verificationPlan ?? '',
          currentStepIndex: 0,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        store.set(plan);
        return toolOk(formatPlanResult(plan, args.replace && current ? 'replaced' : 'created'));
      }

      const existingDescriptions = new Set(current.proposedSteps.map((s) => s.description));
      const appended: PlanStep[] = args.steps
        .filter((step) => !existingDescriptions.has(step.description))
        .map((step) => ({
          id: randomUUID(),
          description: step.description,
          status: normalizeStepStatus(step.status),
          toolCalls: [],
        }));

      const updated: Plan = {
        ...current,
        goal: args.goal,
        constraints: args.constraints ?? current.constraints,
        relevantFiles: args.relevantFiles ?? current.relevantFiles,
        proposedSteps: [...current.proposedSteps, ...appended],
        risks: args.risks ?? current.risks,
        requiredPermissions: args.requiredPermissions ?? current.requiredPermissions,
        verificationPlan: args.verificationPlan ?? current.verificationPlan,
        updatedAt: now,
      };
      store.set(updated);
      return toolOk(
        formatPlanResult(
          updated,
          appended.length > 0 ? `updated (+${appended.length} step(s))` : 'updated',
        ),
      );
    },
  });

  return [updatePlan];
}

function normalizeStepStatus(status: string | undefined): PlanStep['status'] {
  switch (status) {
    case 'in-progress':
    case 'completed':
    case 'blocked':
    case 'skipped':
      return status;
    default:
      return 'pending';
  }
}

function formatPlanResult(plan: Plan, action: string): string {
  return `Plan ${action}:\n${describePlan(plan)}`;
}

/** Human-readable plan rendering shared by the tool and the /plan command. */
export function describePlan(plan: Plan): string {
  const lines = [`Goal: ${plan.goal}`, ''];
  plan.proposedSteps.forEach((step, index) => {
    lines.push(`  ${index + 1}. [${step.status}] ${step.description}`);
  });
  if (plan.constraints.length > 0) lines.push('', `Constraints: ${plan.constraints.join('; ')}`);
  if (plan.relevantFiles.length > 0) lines.push(`Files: ${plan.relevantFiles.join(', ')}`);
  if (plan.risks.length > 0) lines.push(`Risks: ${plan.risks.join('; ')}`);
  if (plan.requiredPermissions.length > 0) {
    lines.push(`Required permissions: ${plan.requiredPermissions.join(', ')}`);
  }
  if (plan.verificationPlan) lines.push(`Verification: ${plan.verificationPlan}`);
  lines.push('', 'The plan does not grant permissions by itself; every step is still gated.');
  return lines.join('\n');
}
