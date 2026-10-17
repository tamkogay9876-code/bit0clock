/**
 * Review command: /review (§43, §45).
 *
 * Gathers the real working-tree (or staged) diff and starts a read-only
 * agent turn that inspects and reports — it never rewrites the changes
 * being reviewed. The diff is passed as request-only context and is not
 * persisted in the conversation; the model can re-request it via
 * show_diff when needed.
 */

import type { AppState } from '../../app/state.js';
import { collectGitDiff, formatLedgerDiff, isGitRepository } from '../../tools/git-tools.js';
import type { CommandDefinition, CommandResult } from '../types.js';

const PREAMBLE_LIMIT = 60_000;

const REVIEW_PROMPT = [
  'Review the working-tree changes included in the task context above.',
  'Identify bugs, risky patterns, and missing tests, ordered by severity, and',
  'reference specific files and lines. Do not modify files: inspect read-only and report.',
].join(' ');

export function createReviewCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'review',
      category: 'workspace',
      description: 'Review current changes (read-only) using the selected model',
      usage: '/review',
      examples: ['/review'],
      handler: async (): Promise<CommandResult> => {
        const active = app.activeModel();
        if (!active) {
          return {
            ok: false,
            error: 'No model selected. Run /models and /model <model> before /review.',
          };
        }

        // ------------------------------------------------------------------
        // Gather real change state
        // ------------------------------------------------------------------
        let diffBody = '';
        let header = '';

        const repo = await isGitRepository(app.projectPath);
        if (repo) {
          let result = await collectGitDiff(app.projectPath, {});
          let scope = 'working-tree';
          if (result.files.length === 0) {
            result = await collectGitDiff(app.projectPath, { staged: true });
            scope = 'staged';
          }
          if (result.files.length === 0) {
            return {
              ok: true,
              output: 'Nothing to review: no working-tree or staged git changes in this workspace.',
            };
          }
          header = [
            `${scope} changes: ${result.files.length} file(s), +${result.insertions}/-${result.deletions}`,
            ...result.files.map((file) => `  ${file}`),
          ].join('\n');
          diffBody = result.diff.trim();
          if (result.truncated) {
            header += '\n(diff truncated at the capture cap)';
          }
        } else {
          const fallback = formatLedgerDiff(app.session.changeLedger ?? []);
          if (fallback.startsWith('No changes recorded')) {
            return { ok: true, output: fallback };
          }
          header = 'Not a git repository — reviewing agent-recorded changes:';
          diffBody = fallback;
        }

        // ------------------------------------------------------------------
        // Review is read-only by construction
        // ------------------------------------------------------------------
        const notes: string[] = [header];
        if (app.session.mode !== 'review') {
          app.setMode('review');
          notes.push('');
          notes.push(
            'Mode switched to REVIEW (read-only) for this review. Use /mode build to change back.',
          );
        }

        const preamble = [`## Changes under review`, header, '', diffBody].join('\n');
        const boundedPreamble =
          preamble.length > PREAMBLE_LIMIT
            ? `${preamble.slice(0, PREAMBLE_LIMIT)}\n… (diff truncated for review context)`
            : preamble;

        return {
          ok: true,
          output: notes.join('\n'),
          action: {
            type: 'start-agent-turn',
            prompt: REVIEW_PROMPT,
            contextPreamble: boundedPreamble,
          },
        };
      },
    },
  ];
}
