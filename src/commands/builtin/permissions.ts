/**
 * Permission and tool inspection commands: /permissions and /tools (§52).
 */

import type { AppState } from '../../app/state.js';
import { MODES } from '../../modes/index.js';
import { WorkspacePaths } from '../../tools/paths.js';
import { createDefaultToolRegistry } from '../../tools/registry.js';
import { USER_INSTRUCTIONS_PATH, discoverInstructions } from '../../context/instructions.js';
import { PROJECT_RULES_PATH, loadProjectRules } from '../../permissions/engine.js';
import type { PermissionRule } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';

const AUDIT_DISPLAY_LIMIT = 10;

function formatRule(rule: PermissionRule, showScope: boolean): string {
  const scope = showScope ? ` (${rule.scope})` : '';
  return `  ${rule.effect === 'allow' ? '✔ allow' : '✖ deny '} ${rule.id}: ${rule.action} / ${rule.pattern}${scope}`;
}

export function createPermissionCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'permissions',
      category: 'diagnostics',
      description: 'Show effective permission policy, scopes, and recent decisions',
      usage: '/permissions',
      availableDuringGeneration: true,
      handler: (): CommandResult => {
        const engine = app.permissions;
        const mode = MODES[app.session.mode];
        const lines: string[] = ['Permission policy:', ''];

        lines.push(`  mode policy: ${mode.label}${mode.readOnly ? ' (read-only)' : ''}`);
        lines.push(`    allowed classes: ${mode.allowedPermissionClasses.join(', ')}`);
        lines.push('');

        lines.push('  Precedence (highest first):');
        lines.push('    1. session scope   (approvals and rules from this session)');
        lines.push(`    2. project scope   (${PROJECT_RULES_PATH})`);
        lines.push('    3. global scope    (permissionRules in the user config)');
        lines.push('    4. mode policy     (read-only modes deny state-changing actions)');
        lines.push(
          '    5. safe defaults   (reads allowed; consequential actions confirmed interactively, denied non-interactively)',
        );
        lines.push('');

        lines.push(`  global rules (${engine.globalRules.length}):`);
        if (engine.globalRules.length === 0) lines.push('    (none)');
        for (const rule of engine.globalRules) lines.push(formatRule(rule, false));

        lines.push('');
        lines.push(`  project rules (${engine.projectRules.length}):`);
        if (engine.projectRules.length === 0) lines.push('    (none)');
        for (const rule of engine.projectRules) lines.push(formatRule(rule, false));
        if (engine.projectRulesError) {
          lines.push(`    !! ${engine.projectRulesError}`);
        }

        lines.push('');
        const approvals = engine.activeApprovalKeys();
        lines.push(`  session approvals (${approvals.length}):`);
        if (approvals.length === 0) lines.push('    (none)');
        for (const key of approvals) lines.push(`    ✔ ${key}`);

        lines.push('');
        const audit = engine.audit();
        lines.push(
          `  recent decisions (${audit.length} total, showing ${Math.min(audit.length, AUDIT_DISPLAY_LIMIT)}):`,
        );
        if (audit.length === 0) lines.push('    (none yet)');
        for (const entry of audit.slice(-AUDIT_DISPLAY_LIMIT)) {
          lines.push(
            `    ${entry.timestamp.slice(11, 19)}  ${entry.decision.padEnd(16)} ${entry.action} — ${entry.reason}`,
          );
        }

        lines.push('');
        const bundle = discoverInstructions(app.projectPath);
        lines.push('  instruction files (lower trust than system rules):');
        if (bundle.sources.length === 0) lines.push('    (none found)');
        for (const source of bundle.sources) {
          lines.push(`    ${source.displayPath} (${source.scope})`);
        }
        lines.push(`    user-global path: ${USER_INSTRUCTIONS_PATH}`);

        return { ok: true, output: lines.join('\n') };
      },
    },

    {
      name: 'tools',
      category: 'diagnostics',
      description: 'List native tools, permission classes, and mode availability',
      usage: '/tools',
      availableDuringGeneration: true,
      handler: (): CommandResult => {
        const registry = createDefaultToolRegistry({
          paths: new WorkspacePaths(app.projectPath),
          changeJournal: { add: () => {} },
        });
        const mode = MODES[app.session.mode];
        const available = new Set(
          registry.availableForMode(app.session.mode).map((tool) => tool.name),
        );

        const lines: string[] = [
          `Native tools (mode: ${mode.label}${mode.readOnly ? ', read-only' : ''}):`,
          '',
        ];
        for (const tool of registry.list()) {
          const flags: string[] = [tool.permissionClass];
          if (tool.mutating) flags.push('mutating');
          if (tool.destructive) flags.push('destructive');
          if (tool.dynamicPermissionClass) flags.push('per-call class');
          const modeMark = available.has(tool.name) ? ' ' : '×';
          lines.push(`  ${modeMark} ${tool.name.padEnd(14)} [${flags.join(', ')}]`);
        }
        lines.push('');
        lines.push('× = not offered in the current mode (read-only modes omit mutating tools).');
        lines.push('Tools are attached to requests only when the selected model supports tools.');
        lines.push(
          'Details: each tool validates its arguments and passes the permission engine first.',
        );
        return { ok: true, output: lines.join('\n') };
      },
    },
  ];
}

/** Exported for tests: project rule loading is the only file-based policy input. */
export { loadProjectRules };
