/**
 * Project memory commands: /memory — inspectable, evidence-based memory (§48).
 *
 * Facts and inferences are stored separately (kind field). Memory never
 * overrides permissions, modes, or safety rules; it is injected as lower-trust
 * data in the system prompt and capped in size.
 */

import type { AppState } from '../../app/state.js';
import type { MemoryCategory, MemoryKind } from '../../memory/types.js';
import { MEMORY_CATEGORIES } from '../../memory/types.js';
import type { CommandDefinition, CommandResult } from '../types.js';

function ok(output: string): CommandResult {
  return { ok: true, output };
}

function fail(error: string): CommandResult {
  return { ok: false, error };
}

function isCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function createMemoryCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'memory',
      category: 'context',
      description: 'Inspect, add, search, and clear persistent project memory',
      usage: '/memory [list|add|inspect|search|remove|clear] ...',
      subcommands: [
        { name: '(none)', usage: '/memory', description: 'List memory entries' },
        {
          name: 'add',
          usage: '/memory add <category> <text> [--inferred] [--provenance=<source>]',
          description: 'Add a fact or inference',
        },
        {
          name: 'inspect',
          usage: '/memory inspect <id>',
          description: 'Show one entry with provenance',
        },
        {
          name: 'search',
          usage: '/memory search <query>',
          description: 'Search entries by content/category/provenance',
        },
        { name: 'remove', usage: '/memory remove <id>', description: 'Remove one entry' },
        {
          name: 'clear',
          usage: '/memory clear --yes',
          description: 'Remove all entries (requires --yes)',
        },
      ],
      examples: [
        '/memory',
        '/memory add convention "Use 2-space indentation"',
        '/memory add decision "Chose JSON sessions over SQLite" --inferred --provenance=adr.md',
        '/memory inspect mem_abc',
        '/memory search indentation',
        '/memory remove mem_abc',
        '/memory clear --yes',
      ],
      handler: ({ args, flags }): CommandResult => {
        const sub = args[0];
        if (!sub) return listMemory(app);
        switch (sub) {
          case 'list':
            return listMemory(app);
          case 'add':
            return addMemory(app, args.slice(1), flags);
          case 'inspect':
            return inspectMemory(app, args[1]);
          case 'search':
            return searchMemory(app, args.slice(1).join(' '));
          case 'remove':
          case 'delete':
            return removeMemory(app, args[1]);
          case 'clear':
            return clearMemory(app, flags);
          default:
            return fail(`Unknown subcommand: /memory ${sub}`);
        }
      },
    },
  ];
}

function listMemory(app: AppState): CommandResult {
  const entries = app.memory.list();
  const stats = app.memory.stats();
  if (entries.length === 0) {
    return ok(
      'Project memory:\n\n  (empty)\n\nAdd with /memory add <category> <text>. Categories: ' +
        MEMORY_CATEGORIES.join(', ') +
        '.\nFacts and inferences are kept distinct; provenance is recorded for every entry.',
    );
  }
  const lines: string[] = ['Project memory:', ''];
  for (const entry of entries) {
    lines.push(`  ${entry.id}  [${entry.kind}] ${entry.category}`);
    lines.push(`    ${entry.content}`);
    lines.push(`    provenance: ${entry.provenance}  updated: ${entry.updatedAt}`);
  }
  lines.push('');
  lines.push(
    `Totals: ${stats.entries} entries (${stats.facts} facts, ${stats.inferences} inferences), ${stats.bytes} bytes.`,
  );
  return ok(lines.join('\n'));
}

function addMemory(
  app: AppState,
  args: string[],
  flags: Record<string, string | true>,
): CommandResult {
  if (args.length < 2) {
    return fail('Usage: /memory add <category> <text> [--inferred] [--provenance=<source>]');
  }
  const categoryRaw = args[0]!;
  if (!isCategory(categoryRaw)) {
    return fail(`Unknown category "${categoryRaw}". Valid: ${MEMORY_CATEGORIES.join(', ')}`);
  }
  const kind: MemoryKind = flags['inferred'] === true ? 'inference' : 'fact';
  const provenance = typeof flags['provenance'] === 'string' ? flags['provenance'] : 'user';
  const content = args.slice(1).join(' ').trim();
  if (content === '') return fail('Memory content must not be empty.');

  try {
    const entry = app.memory.add({ category: categoryRaw, kind, content, provenance });
    return ok(
      `Added ${entry.kind}: ${entry.id}\n  category: ${entry.category}\n  provenance: ${entry.provenance}\n\nMemory is lower-trust data and can never change permissions, modes, or safety rules.`,
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function inspectMemory(app: AppState, id: string | undefined): CommandResult {
  if (!id) return fail('Usage: /memory inspect <id>');
  const entry = app.memory.get(id);
  if (!entry) return fail(`Memory entry not found: ${id}`);
  return ok(
    [
      `Memory entry ${entry.id}`,
      `  kind:        ${entry.kind}`,
      `  category:    ${entry.category}`,
      `  content:     ${entry.content}`,
      `  provenance:  ${entry.provenance}`,
      `  created:     ${entry.createdAt}`,
      `  updated:     ${entry.updatedAt}`,
    ].join('\n'),
  );
}

function searchMemory(app: AppState, query: string): CommandResult {
  const results = app.memory.search(query);
  if (results.length === 0) return ok(`No memory entries match "${query}".`);
  const lines = [`Memory search "${query}":`, ''];
  for (const entry of results) {
    lines.push(`  ${entry.id}  [${entry.kind}] ${entry.category}: ${entry.content}`);
  }
  return ok(lines.join('\n'));
}

function removeMemory(app: AppState, id: string | undefined): CommandResult {
  if (!id) return fail('Usage: /memory remove <id>');
  if (!app.memory.remove(id)) return fail(`Memory entry not found: ${id}`);
  return ok(`Removed memory entry ${id}.`);
}

function clearMemory(app: AppState, flags: Record<string, string | true>): CommandResult {
  if (flags['yes'] !== true) {
    return fail('Clearing all project memory requires --yes. Run /memory clear --yes to confirm.');
  }
  const removed = app.memory.clear();
  return ok(`Cleared ${removed} memory entr${removed === 1 ? 'y' : 'ies'}.`);
}
