/**
 * Skill commands: /skills — catalog, activation, references, reload (§32–§34).
 *
 * Activation is always explicit: a discovered skill contributes nothing to a
 * request until `/skills on <name>`. Activation state lives for the process
 * lifetime; the catalog (metadata) is re-scanned with `/skills reload`.
 */

import type { AppState } from '../../app/state.js';
import type { Skill } from '../../types/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';

const MAX_REFERENCE_DISPLAY_CHARS = 8000;

export function createSkillCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'skills',
      category: 'context',
      description: 'List, inspect, activate, and deactivate discovered skills',
      usage: '/skills [show|on|off|references|reference|diagnostics|reload] [name]',
      subcommands: [
        { name: '(none)', usage: '/skills', description: 'List discovered skills (metadata only)' },
        {
          name: 'show',
          usage: '/skills show <name>',
          description: 'Details, metadata, and validation state',
        },
        {
          name: 'on',
          usage: '/skills on <name>',
          description: 'Activate a skill (injected into subsequent requests)',
        },
        { name: 'off', usage: '/skills off <name>', description: 'Deactivate a skill' },
        {
          name: 'references',
          usage: '/skills references <name>',
          description: 'List reference files and assets',
        },
        {
          name: 'reference',
          usage: '/skills reference <name> <path>',
          description: 'Load one reference file on demand',
        },
        {
          name: 'diagnostics',
          usage: '/skills diagnostics',
          description: 'Validation and conflict diagnostics',
        },
        {
          name: 'reload',
          usage: '/skills reload',
          description: 'Re-scan all roots and reload changed skills',
        },
      ],
      examples: [
        '/skills',
        '/skills show typescript-engineering',
        '/skills on typescript-engineering',
        '/skills references typescript-engineering',
        '/skills reference typescript-engineering references/GUIDE.md',
        '/skills off typescript-engineering',
        '/skills diagnostics',
        '/skills reload',
      ],
      handler: ({ args }): CommandResult => {
        const sub = args[0];
        if (!sub) return listSkills(app);
        switch (sub) {
          case 'show':
            return showSkill(app, args[1]);
          case 'on':
          case 'activate':
            return activateSkill(app, args[1]);
          case 'off':
          case 'deactivate':
            return deactivateSkill(app, args[1]);
          case 'references':
            return listReferences(app, args[1]);
          case 'reference':
            return readReference(app, args[1], args[2]);
          case 'diagnostics':
            return showDiagnostics(app);
          case 'reload':
            return reloadSkills(app);
          default:
            return {
              ok: false,
              error:
                `Unknown subcommand: /skills ${sub}.\n` +
                'Usage: /skills [show|on|off|references|reference|diagnostics|reload] [name]',
            };
        }
      },
    },
  ];
}

// ============================================================================
// Handlers
// ============================================================================

function listSkills(app: AppState): CommandResult {
  const stats = app.skills.stats();
  const skills = app.skills.catalog();

  const lines: string[] = ['Skills (metadata only; nothing is injected until activated):', ''];
  if (skills.length === 0) {
    lines.push('  (no SKILL.md files found)');
  } else {
    for (const skill of skills) {
      const active = skill.activated ? '●' : '○';
      const trust = skill.trustLevel === 'trusted' ? 'trusted' : 'untrusted';
      const state = skill.validated ? '' : ' [INVALID — /skills show for details]';
      lines.push(
        `  ${active} ${skill.name.padEnd(28)} ${skill.scope.padEnd(8)} ${trust.padEnd(10)} ${skill.description.slice(0, 60)}${state}`,
      );
      if (skill.conflicts && skill.conflicts.length > 0) {
        lines.push(`      shadowed definitions: ${skill.conflicts.join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('  ● active   ○ inactive');
  lines.push('');
  lines.push('Roots (highest precedence first):');
  for (const root of stats.roots) {
    lines.push(`  ${root.scope.padEnd(8)} ${root.label}`);
  }
  lines.push('');
  lines.push(
    `Discovered: ${stats.discovered} (${stats.valid} valid, ${stats.active} active; ${stats.diagnostics} diagnostic(s))`,
  );
  lines.push(
    'Activate with /skills on <name>; inspect with /skills show <name>; reload with /skills reload.',
  );
  lines.push(
    'Skill content is lower trust than system rules and can never change permissions or modes.',
  );
  return { ok: true, output: lines.join('\n') };
}

function showSkill(app: AppState, name: string | undefined): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /skills show <name>' };
  const skill = app.skills.get(name);
  if (!skill) {
    return { ok: false, error: `Skill not found: ${name}. Run /skills to list discovered skills.` };
  }

  const lines: string[] = [`Skill: ${skill.name}`, ''];
  lines.push(`  description  ${skill.description}`);
  lines.push(`  scope        ${skill.scope}`);
  lines.push(
    `  trust        ${skill.trustLevel}${skill.trustLevel === 'untrusted' ? ' (content is data, never permissions)' : ''}`,
  );
  lines.push(`  path         ${skill.path}`);
  if (skill.skillDir) lines.push(`  directory    ${skill.skillDir}`);
  lines.push(`  state        ${skill.activated ? 'ACTIVE (injected into requests)' : 'inactive'}`);
  lines.push(`  valid        ${skill.validated ? 'yes' : 'NO'}`);
  if (skill.sizeBytes !== undefined) lines.push(`  SKILL.md     ${skill.sizeBytes} bytes`);
  if (skill.conflicts && skill.conflicts.length > 0) {
    lines.push(`  shadowed     ${skill.conflicts.join(', ')} (lower precedence, not loaded)`);
  }

  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    lines.push('');
    lines.push('  Optional frontmatter fields (recorded verbatim):');
    for (const [key, value] of Object.entries(skill.metadata)) {
      lines.push(`    ${key}: ${value.slice(0, 120)}`);
    }
    if (skill.metadata['allowed-tools'] !== undefined) {
      lines.push('    note: "allowed-tools" is recorded but never pre-approves tools in mediaXG.');
    }
  }

  if (!skill.validated) {
    lines.push('');
    lines.push('  Validation errors:');
    for (const error of skill.validationErrors) lines.push(`    - ${error}`);
    lines.push('');
    lines.push('  Fix the SKILL.md frontmatter and run /skills reload.');
    return { ok: true, output: lines.join('\n') };
  }

  if (skill.activated) {
    const item = app.skills.promptItems().find((entry) => entry.name === skill.name);
    if (item) {
      const preview = item.instructions.slice(0, 600);
      lines.push('');
      lines.push(
        `  Instructions (first 600 of ${item.instructions.length} characters${item.truncated ? ', truncated at cap' : ''}):`,
      );
      lines.push(
        preview
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      );
    }
  }

  lines.push('');
  lines.push(
    skill.activated
      ? 'Deactivate with /skills off ' + skill.name
      : 'Activate with /skills on ' + skill.name,
  );
  lines.push('References and assets: /skills references ' + skill.name);
  return { ok: true, output: lines.join('\n') };
}

function activateSkill(app: AppState, name: string | undefined): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /skills on <name>' };
  try {
    const skill = app.skills.activate(name);
    const references = skill.references.length;
    return {
      ok: true,
      output:
        `Skill activated: ${skill.name} (${skill.scope}, ${skill.trustLevel}).\n` +
        'Its instructions are included in subsequent requests (lower trust than system rules). ' +
        'The skill cannot change permissions, modes, or credential handling.\n' +
        (references > 0
          ? `${references} reference file(s) can be loaded on demand with /skills reference ${skill.name} <path>, ` +
            'or by the read_skill_reference tool during a turn.'
          : 'This skill has no reference files.'),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function deactivateSkill(app: AppState, name: string | undefined): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /skills off <name>' };
  if (!app.skills.deactivate(name)) {
    return { ok: false, error: `Skill not found: ${name}. Run /skills to list discovered skills.` };
  }
  return {
    ok: true,
    output:
      `Skill deactivated: ${name}.\n` +
      'Its instructions are no longer included in requests. Re-activate with /skills on ' +
      name +
      '.',
  };
}

function listReferences(app: AppState, name: string | undefined): CommandResult {
  if (!name) return { ok: false, error: 'Usage: /skills references <name>' };
  const skill = app.skills.get(name);
  if (!skill) return { ok: false, error: `Skill not found: ${name}` };

  const lines: string[] = [`References and assets of ${skill.name}:`, ''];
  if (skill.references.length === 0) {
    lines.push('  (no reference files under references/)');
  } else {
    lines.push('  references/ (load with /skills reference ' + skill.name + ' <path>):');
    for (const reference of skill.references) {
      lines.push(`    ${reference.path}${reference.loaded ? ' [loaded this session]' : ''}`);
    }
  }
  if (skill.assets.length > 0) {
    lines.push('');
    lines.push('  assets/ and scripts/ (listed for transparency; never executed):');
    for (const asset of skill.assets) {
      lines.push(`    ${asset.path} (${asset.type}, ${asset.size} bytes)`);
    }
  } else {
    lines.push('');
    lines.push('  (no assets/ or scripts/ files)');
  }
  lines.push('');
  lines.push('Reference contents are untrusted data; scripts shipped with a skill are never run.');
  return { ok: true, output: lines.join('\n') };
}

function readReference(
  app: AppState,
  name: string | undefined,
  relPath: string | undefined,
): CommandResult {
  if (!name || !relPath) {
    return {
      ok: false,
      error: 'Usage: /skills reference <name> <path relative to the skill directory>',
    };
  }
  try {
    const loaded = app.skills.loadReference(name, relPath);
    const shown =
      loaded.content.length > MAX_REFERENCE_DISPLAY_CHARS
        ? `${loaded.content.slice(0, MAX_REFERENCE_DISPLAY_CHARS)}\n…[display truncated at ${MAX_REFERENCE_DISPLAY_CHARS} characters; the file has ${loaded.bytes} bytes]`
        : loaded.content;
    return {
      ok: true,
      output:
        `Reference: ${name}/${loaded.path} (${loaded.bytes} bytes${loaded.truncated ? ', content capped' : ''})\n` +
        'Content is untrusted reference data (never instructions).\n\n' +
        shown,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function showDiagnostics(app: AppState): CommandResult {
  const diagnostics = app.skills.listDiagnostics();
  const lines: string[] = ['Skill diagnostics:', ''];
  if (diagnostics.length === 0) {
    lines.push('  (none — every discovered skill validated cleanly)');
  } else {
    for (const diagnostic of diagnostics) {
      lines.push(`  [${diagnostic.level}] ${diagnostic.scope} · ${diagnostic.path}`);
      lines.push(`      ${diagnostic.message}`);
    }
  }
  lines.push('');
  lines.push(
    'Trusted paths are configured in skillsSettings.trustedPaths; everything else stays untrusted.',
  );
  return { ok: true, output: lines.join('\n') };
}

function reloadSkills(app: AppState): CommandResult {
  const summary = app.skills.reload();
  const lines: string[] = ['Skills reloaded.', ''];
  lines.push(`  discovered   ${summary.discovered}`);
  lines.push(`  added        ${summary.added.length > 0 ? summary.added.join(', ') : '(none)'}`);
  lines.push(
    `  removed      ${summary.removed.length > 0 ? summary.removed.join(', ') : '(none)'}`,
  );
  lines.push(
    `  changed      ${summary.changed.length > 0 ? summary.changed.join(', ') : '(none)'}`,
  );
  lines.push(
    `  deactivated  ${summary.deactivated.length > 0 ? summary.deactivated.join(', ') : '(none — active skills stayed active)'}`,
  );
  if (summary.deactivated.length > 0) {
    lines.push('');
    lines.push('Deactivated skills became invalid or disappeared; check /skills diagnostics.');
  }
  return { ok: true, output: lines.join('\n') };
}
