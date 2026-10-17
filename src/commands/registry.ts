/**
 * Central command registry.
 *
 * - deterministic lookup by canonical name or alias
 * - duplicate registration rejected at startup (fail fast in development)
 * - unknown commands produce suggestions, never silent execution
 * - handlers are isolated: a thrown error becomes a structured result
 */

import { formatError } from '../errors/index.js';
import { editDistance } from './parser.js';
import type {
  CommandCategory,
  CommandDefinition,
  CommandMatch,
  CommandResult,
  ParsedInput,
} from './types.js';

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  general: 'General',
  providers: 'Providers',
  models: 'Models',
  modes: 'Modes',
  reasoning: 'Reasoning & Response',
  sessions: 'Sessions',
  context: 'Context',
  workspace: 'Workspace & Tools',
  diagnostics: 'Diagnostics & Status',
};

const CATEGORY_ORDER: CommandCategory[] = [
  'general',
  'providers',
  'models',
  'modes',
  'reasoning',
  'context',
  'workspace',
  'sessions',
  'diagnostics',
];

export class CommandRegistry {
  private byName = new Map<string, CommandDefinition>();
  private byAlias = new Map<string, CommandDefinition>();

  register(definition: CommandDefinition): void {
    const existing = this.byName.get(definition.name) ?? this.byAlias.get(definition.name);
    if (existing) {
      throw new Error(
        `Duplicate command name: /${definition.name} (already used by /${existing.name})`,
      );
    }

    for (const alias of definition.aliases ?? []) {
      const aliasTaken = this.byName.get(alias) ?? this.byAlias.get(alias);
      if (aliasTaken) {
        throw new Error(`Duplicate command alias: /${alias} (already used by /${aliasTaken.name})`);
      }
    }

    this.byName.set(definition.name, definition);
    for (const alias of definition.aliases ?? []) {
      this.byAlias.set(alias, definition);
    }
  }

  registerAll(definitions: CommandDefinition[]): void {
    for (const def of definitions) this.register(def);
  }

  find(name: string): CommandMatch | null {
    const lower = name.toLowerCase();
    const byName = this.byName.get(lower);
    if (byName) return { definition: byName, matchType: 'name' };
    const byAlias = this.byAlias.get(lower);
    if (byAlias) return { definition: byAlias, matchType: 'alias' };
    return null;
  }

  has(name: string): boolean {
    return this.find(name) !== null;
  }

  list(): CommandDefinition[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  visible(): CommandDefinition[] {
    return this.list().filter((d) => !d.hidden);
  }

  // --------------------------------------------------------------------------
  // Suggestions and completions
  // --------------------------------------------------------------------------

  /** Closest command names for an unknown command. */
  suggest(name: string, max = 3): string[] {
    const candidates: Array<{ name: string; score: number }> = [];
    const lower = name.toLowerCase();

    for (const def of this.list()) {
      const names = [def.name, ...(def.aliases ?? [])];
      let best = Infinity;
      for (const candidate of names) {
        let score = editDistance(lower, candidate);
        // Prefix proximity bonus
        if (candidate.startsWith(lower) || lower.startsWith(candidate)) score -= 1;
        best = Math.min(best, score);
      }
      if (best <= Math.max(2, Math.ceil(lower.length / 3))) {
        candidates.push({ name: def.name, score: best });
      }
    }

    return candidates
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, max)
      .map((c) => c.name);
  }

  /** Command names matching a prefix for input autocomplete. */
  completions(prefix: string): string[] {
    const lower = prefix.toLowerCase().replace(/^\//, '');
    if (lower === '') return this.visible().map((d) => d.name);

    const startsWith: string[] = [];
    const contains: string[] = [];

    for (const def of this.visible()) {
      const names = [def.name, ...(def.aliases ?? [])];
      if (names.some((n) => n.startsWith(lower))) startsWith.push(def.name);
      else if (names.some((n) => n.includes(lower))) contains.push(def.name);
    }

    return [...startsWith.sort(), ...contains.sort()];
  }

  // --------------------------------------------------------------------------
  // Dispatch
  // --------------------------------------------------------------------------

  /**
   * Execute a parsed input.
   * Returns null when the input is a message (not a command attempt).
   */
  async dispatch(
    parsed: ParsedInput,
    options: { generationActive?: boolean } = {},
  ): Promise<CommandResult | null> {
    if (parsed.kind !== 'command' || !parsed.command) return null;

    const match = this.find(parsed.command);
    if (!match) {
      const suggestions = this.suggest(parsed.command);
      const hint =
        suggestions.length > 0
          ? ` Did you mean ${suggestions.map((s) => `/${s}`).join(', ')}?`
          : '';
      return {
        ok: false,
        error:
          `Unknown command: /${parsed.command}.${hint}\n` +
          `Use /help to list commands. To send text starting with "/" as a message, ` +
          `start it with "//" or a leading space.`,
      };
    }

    const definition = match.definition;

    if (options.generationActive && !definition.availableDuringGeneration) {
      return {
        ok: false,
        error: `/${definition.name} is not available while a response is generating. Press Esc to cancel first.`,
      };
    }

    try {
      const result = await definition.handler({
        args: parsed.args ?? [],
        flags: parsed.flags ?? {},
        raw: parsed.raw ?? '',
        invokedAs: parsed.command,
      });
      return result;
    } catch (err) {
      return {
        ok: false,
        error: `Command /${definition.name} failed: ${formatError(err)}`,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Help
  // --------------------------------------------------------------------------

  help(commandName?: string): string {
    if (commandName) {
      const match = this.find(commandName.replace(/^\//, ''));
      if (!match) {
        const suggestions = this.suggest(commandName.replace(/^\//, ''));
        return `Unknown command: /${commandName}${suggestions.length > 0 ? `\nDid you mean: ${suggestions.map((s) => `/${s}`).join(', ')}?` : ''}`;
      }
      return this.commandHelp(match.definition);
    }

    const lines: string[] = ['mediaXG commands', ''];
    for (const category of CATEGORY_ORDER) {
      const commands = this.visible().filter((d) => d.category === category);
      if (commands.length === 0) continue;
      lines.push(`${CATEGORY_LABELS[category]}:`);
      for (const def of commands) {
        lines.push(`  ${def.usage.padEnd(42)} ${def.description}`);
      }
      lines.push('');
    }
    lines.push('Tip: type "/" for autocomplete; Tab completes; Esc cancels a response.');
    return lines.join('\n');
  }

  private commandHelp(def: CommandDefinition): string {
    const lines: string[] = [];
    lines.push(
      `/${def.name}${def.aliases && def.aliases.length > 0 ? `  (aliases: ${def.aliases.map((a) => `/${a}`).join(', ')})` : ''}`,
    );
    lines.push(def.description);
    lines.push('');
    lines.push(`Usage: ${def.usage}`);

    if (def.subcommands && def.subcommands.length > 0) {
      lines.push('');
      lines.push('Subcommands:');
      for (const sub of def.subcommands) {
        lines.push(`  ${(sub.usage ?? sub.name).padEnd(40)} ${sub.description}`);
      }
    }

    if (def.examples && def.examples.length > 0) {
      lines.push('');
      lines.push('Examples:');
      for (const example of def.examples) {
        lines.push(`  ${example}`);
      }
    }

    if (def.availableDuringGeneration) {
      lines.push('');
      lines.push('Available while a response is generating: yes');
    }

    return lines.join('\n');
  }
}
