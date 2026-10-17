/**
 * Plan command: inspect, cancel, or clear the structured task plan (§45).
 */

import type { AppState } from '../../app/state.js';
import { describePlan } from '../../tools/plan-tools.js';
import type { CommandDefinition, CommandResult } from '../types.js';

export function createPlanCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'plan',
      category: 'modes',
      description: 'Show, cancel, or clear the recorded task plan',
      usage: '/plan [show|cancel|clear]',
      subcommands: [
        { name: 'show', usage: '/plan', description: 'Show the current plan' },
        { name: 'cancel', usage: '/plan cancel', description: 'Mark the plan as cancelled' },
        { name: 'clear', usage: '/plan clear', description: 'Remove the plan from the session' },
      ],
      examples: ['/plan', '/plan cancel', '/plan clear'],
      availableDuringGeneration: true,
      handler: ({ args }): CommandResult => {
        const sub = args[0] ?? 'show';
        const plan = app.session.plan ?? null;

        switch (sub) {
          case 'show':
            if (!plan) {
              return {
                ok: true,
                output:
                  'No plan recorded in this session.\n' +
                  'Use /mode plan and ask the model to plan a complex task — it records a\n' +
                  'structured plan via the update_plan tool (goal, steps, risks, verification).',
              };
            }
            return {
              ok: true,
              output: [
                `Plan (${plan.status}) · created ${plan.createdAt.slice(0, 16).replace('T', ' ')} · updated ${plan.updatedAt.slice(0, 16).replace('T', ' ')}`,
                '',
                describePlan(plan),
              ].join('\n'),
            };

          case 'cancel':
            if (!plan) return { ok: false, error: 'No plan to cancel.' };
            plan.status = 'cancelled';
            plan.updatedAt = new Date().toISOString();
            app.saveSession();
            return {
              ok: true,
              output: 'Plan marked as cancelled. Step statuses are preserved for inspection.',
            };

          case 'clear':
            if (!plan) return { ok: false, error: 'No plan to clear.' };
            app.session.plan = null;
            app.saveSession();
            return { ok: true, output: 'Plan cleared from the session.' };

          default:
            return {
              ok: false,
              error: `Unknown subcommand: /plan ${sub}. Usage: /plan [show|cancel|clear]`,
            };
        }
      },
    },
  ];
}
