/**
 * Mode command: /mode — switch between plan / build / review.
 */

import type { AppState } from '../../app/state.js';
import { MODES, isMode } from '../../modes/index.js';
import type { AgentMode } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';

export function createModeCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'mode',
      category: 'modes',
      description: 'Switch the agent mode (plan, build, review)',
      usage: '/mode [plan|build|review]',
      examples: ['/mode', '/mode plan', '/mode build'],
      handler: ({ args }): CommandResult => {
        const requested = args[0];

        if (!requested) {
          const lines: string[] = ['Agent modes:', ''];
          for (const mode of Object.values(MODES)) {
            const marker = mode.id === app.session.mode ? '*' : ' ';
            const readOnly = mode.readOnly ? ' [read-only]' : '';
            lines.push(`${marker} ${mode.id.padEnd(8)}${readOnly}`);
            lines.push(`    ${mode.description}`);
          }
          lines.push('');
          lines.push('Switch with /mode <id>. The mode constrains what tool actions are allowed.');
          return { ok: true, output: lines.join('\n') };
        }

        if (!isMode(requested)) {
          return {
            ok: false,
            error: `Unknown mode: ${requested}. Available modes: plan, build, review.`,
          };
        }

        const previous = app.session.mode;
        app.setMode(requested as AgentMode);

        const descriptor = MODES[requested];
        const lines: string[] = [
          `Mode: ${descriptor.label} (was ${MODES[previous].label})`,
          descriptor.description,
        ];
        if (descriptor.readOnly) {
          lines.push('This mode is read-only: state-changing actions are refused.');
        }
        return { ok: true, output: lines.join('\n') };
      },
    },
  ];
}
