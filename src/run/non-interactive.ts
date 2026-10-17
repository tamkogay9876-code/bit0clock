/**
 * Non-interactive execution.
 *
 * Supports both a single command (starting with `/`) and a single prompt.
 * Text output goes to the provided `out` sink (per streaming delta);
 * diagnostics (including tool activity) go to `err`. Exit codes: 0 success,
 * 1 failure, 130 cancelled.
 *
 * Tool execution follows the same permission engine as the TUI: reads run
 * freely, consequential actions are denied with an explanatory message
 * unless `--yes`/config rules allow them. There is no hidden auto-approval.
 */

import { CommandRegistry } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtin/index.js';
import { parseInput } from '../commands/parser.js';
import { runAgentTurn } from '../agent/loop.js';
import { formatError } from '../errors/index.js';
import type { AppState } from '../app/state.js';

export interface NonInteractiveIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const DEFAULT_IO: NonInteractiveIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(`${text.endsWith('\n') ? text : `${text}\n`}`),
};

export function createAppRegistry(app: AppState): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);
  return registry;
}

/** Run one conversational turn with tool activity summarized on stderr. */
async function runTurn(
  app: AppState,
  prompt: string,
  io: NonInteractiveIO,
  preamble?: string,
): Promise<number> {
  let wroteText = false;
  try {
    const result = await runAgentTurn(app, prompt, {
      ...(preamble ? { contextPreamble: preamble } : {}),
      onEvent: (event) => {
        switch (event.type) {
          case 'text-delta':
            wroteText = true;
            io.out(event.text);
            break;
          case 'context-prepared': {
            // Quiet by default: only notable context events are reported
            const notable =
              event.compactedMessages > 0 ||
              event.omittedMessages > 0 ||
              event.retrievalFiles.length > 0 ||
              event.gateAction !== 'allow';
            if (!notable) break;
            const parts: string[] = [
              `est. ${event.estimatedInputTokens} input tokens`,
              `budget ${event.effectiveBudget}`,
              `source ${event.estimateSource}`,
              `gate ${event.gateAction}`,
            ];
            if (event.compactedMessages > 0) parts.push(`compacted ${event.compactedMessages}`);
            if (event.omittedMessages > 0) parts.push(`omitted ${event.omittedMessages}`);
            if (event.retrievalFiles.length > 0)
              parts.push(`retrieved ${event.retrievalFiles.join(', ')}`);
            io.err(`[context] ${parts.join(' · ')}`);
            for (const note of event.notes) {
              if (note.includes('confirmation granted') || note.startsWith('auto-compaction')) {
                io.err(`[context] ${note}`);
              }
            }
            break;
          }
          case 'tool-started':
            io.err(`[tool] ${event.call.name} — ${event.summary}`);
            break;
          case 'tool-finished':
            io.err(
              `[tool] ${event.record.name} — ${event.record.isError ? 'error' : 'ok'} (${event.record.durationMs}ms)`,
            );
            break;
          default:
            break;
        }
      },
    });

    if (wroteText) io.out('\n');

    if (result.cancelled) {
      io.err('Cancelled.');
      return 130;
    }
    if (result.error) {
      io.err(`Error: ${result.error.message}`);
      return 1;
    }
    if (result.exhausted) {
      io.err('Stopped at the agent iteration limit; partial work was saved to the session.');
      return 1;
    }
    return 0;
  } catch (err) {
    io.err(`Error: ${formatError(err)}`);
    return 1;
  }
}

export async function runNonInteractive(
  app: AppState,
  input: string,
  io: NonInteractiveIO = DEFAULT_IO,
): Promise<number> {
  const registry = createAppRegistry(app);
  const parsed = parseInput(input);

  if (parsed.kind === 'command') {
    const result = await registry.dispatch(parsed);
    if (result) {
      if (result.action?.type === 'start-agent-turn') {
        if (result.output) {
          io.out(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
        }
        return runTurn(app, result.action.prompt, io, result.action.contextPreamble);
      }
      return handleCommandResult(result, io);
    }
  }

  // Conversational message
  const text = parsed.raw ?? input;
  return runTurn(app, text, io);
}

function handleCommandResult(
  result: NonNullable<Awaited<ReturnType<CommandRegistry['dispatch']>>>,
  io: NonInteractiveIO,
): number {
  // Interactive-only actions get a non-interactive alternative
  if (result.action?.type === 'open-connect-wizard') {
    io.err(
      'The connection wizard requires the interactive TUI (run `mediaxg`).\n' +
        'Non-interactive alternative:\n' +
        '  mediaxg "/connect xkiro --key-env XKIRO_API_KEY"\n' +
        '  mediaxg "/connect openai-compatible --id local --base-url http://localhost:8080/v1"',
    );
    return 1;
  }
  if (result.action?.type === 'exit') {
    return 0;
  }
  if (result.action?.type === 'cancel-generation') {
    io.err('Nothing to cancel in non-interactive mode.');
    return 0;
  }

  if (result.output) io.out(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
  if (result.error) io.err(result.error);
  return result.ok ? 0 : 1;
}
