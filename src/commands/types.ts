/**
 * Command system types.
 *
 * A command definition carries everything the UI needs: canonical name,
 * aliases, description, usage, subcommands, availability during generation,
 * and a handler. Handlers return structured results the TUI interprets.
 */

export type CommandCategory =
  | 'general'
  | 'providers'
  | 'models'
  | 'modes'
  | 'reasoning'
  | 'sessions'
  | 'context'
  | 'workspace'
  | 'diagnostics';

/** Actions the TUI interprets (open a picker, exit, clear the view, …). */
export type CommandAction =
  | { type: 'exit' }
  | { type: 'clear-conversation' }
  | { type: 'open-model-picker'; filter?: string }
  | { type: 'open-session-picker' }
  | { type: 'open-connect-wizard'; providerType?: string }
  | { type: 'cancel-generation' }
  | {
      /** Start an agent turn (used by /review and similar command-driven work) */
      type: 'start-agent-turn';
      prompt: string;
      /** Request-only context (not persisted in the session) */
      contextPreamble?: string;
    };

export interface CommandResult {
  ok: boolean;
  /** Text shown in the conversation view */
  output?: string;
  /** Error text (shown distinctly) */
  error?: string;
  /** UI action requested by the command */
  action?: CommandAction;
}

export interface CommandContext {
  /** Parsed arguments (quoted strings preserved) */
  args: string[];
  /** --flag or --key=value */
  flags: Record<string, string | true>;
  /** The raw input after the command name */
  raw: string;
  /** Command name as typed (may be an alias) */
  invokedAs: string;
}

export interface CommandDefinition {
  /** Canonical name without the leading slash */
  name: string;
  aliases?: string[];
  category: CommandCategory;
  description: string;
  /** Usage line, e.g. "/think [off|low|medium|high|max|auto]" */
  usage: string;
  subcommands?: Array<{ name: string; description: string; usage?: string }>;
  examples?: string[];
  /** Whether the command may run while a generation is active (default false) */
  availableDuringGeneration?: boolean;
  /** Hidden commands do not appear in /help (still executable) */
  hidden?: boolean;
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult;
}

export interface ParsedInput {
  kind: 'command' | 'message';
  command?: string;
  args?: string[];
  flags?: Record<string, string | true>;
  raw?: string;
}

export interface CommandMatch {
  definition: CommandDefinition;
  matchType: 'name' | 'alias';
}
