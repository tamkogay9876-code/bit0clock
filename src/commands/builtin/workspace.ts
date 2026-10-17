/**
 * Workspace commands: /diff and /undo (§43).
 */

import type { AppState } from '../../app/state.js';
import { collectGitDiff, formatLedgerDiff, isGitRepository } from '../../tools/git-tools.js';
import { pendingUndoRecords, type ChangeKind } from '../../tools/ledger.js';
import { undoChanges } from '../../tools/undo.js';
import { WorkspacePaths } from '../../tools/paths.js';
import { discoverInstructions, INSTRUCTION_PRECEDENCE } from '../../context/instructions.js';
import { formatBytes, truncate } from '../../utils/index.js';
import type { CommandDefinition, CommandResult } from '../types.js';

const DIFF_DISPLAY_LIMIT = 40_000;
const UNDO_PREVIEW_LIMIT = 10;

const KIND_LABEL: Record<ChangeKind, string> = {
  create: 'create',
  edit: 'edit',
  patch: 'patch',
  rename: 'rename',
  delete: 'delete',
};

export function createWorkspaceCommands(app: AppState): CommandDefinition[] {
  return [
    {
      name: 'diff',
      category: 'workspace',
      description: 'Show the working-tree diff (or agent changes outside git)',
      usage: '/diff [--staged] [--stat] [path]',
      examples: ['/diff', '/diff --staged', '/diff src/', '/diff --stat'],
      availableDuringGeneration: true,
      handler: async ({ args, flags }): Promise<CommandResult> => {
        const staged = flags['staged'] === true;
        const statOnly = flags['stat'] === true;
        const pathArg = args.find((arg) => !arg.startsWith('--'));

        const emptyMessage = `No ${staged ? 'staged' : 'working-tree'} changes.`;
        const repo = await isGitRepository(app.projectPath);
        if (!repo) {
          return { ok: true, output: formatLedgerDiff(app.session.changeLedger ?? []) };
        }

        let pathFilter: string | undefined;
        if (pathArg) {
          try {
            pathFilter = new WorkspacePaths(app.projectPath).resolve(pathArg).rel;
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        const options: Parameters<typeof collectGitDiff>[1] = {};
        if (staged) options.staged = true;
        if (pathFilter) options.path = pathFilter;
        const result = await collectGitDiff(app.projectPath, options);

        if (result.files.length === 0) {
          return { ok: true, output: emptyMessage };
        }

        const header = [
          `${staged ? 'Staged' : 'Working-tree'} changes: ${result.files.length} file(s), +${result.insertions}/-${result.deletions}`,
          ...result.files.map((file) => `  ${file}`),
        ].join('\n');

        if (statOnly) return { ok: true, output: header };

        const body = truncate(result.diff.trim(), DIFF_DISPLAY_LIMIT);
        const notes: string[] = [header, '', body];
        if (result.diff.trim().length > DIFF_DISPLAY_LIMIT || result.truncated) {
          notes.push('', '(diff truncated; see git for the full output)');
        }
        return { ok: true, output: notes.join('\n') };
      },
    },

    {
      name: 'undo',
      category: 'workspace',
      description: 'Revert agent-made file changes from the session change ledger',
      usage: '/undo [count] [--yes]',
      subcommands: [
        { name: 'count', usage: '/undo 2 --yes', description: 'Revert the last N agent changes' },
      ],
      examples: ['/undo', '/undo --yes', '/undo 3 --yes'],
      handler: ({ args, flags }): CommandResult => {
        const ledger = app.session.changeLedger ?? [];
        const pending = pendingUndoRecords(ledger);

        if (pending.length === 0) {
          return {
            ok: true,
            output:
              'Nothing to undo. Only file changes made by native tools are recorded, ' +
              'and already-reverted changes are excluded.',
          };
        }

        const countArg = args.find((arg) => /^\d+$/.test(arg));
        const requested = countArg ? Number(countArg) : 1;
        const count = Math.max(1, Math.min(requested, pending.length));

        if (flags['yes'] !== true) {
          const lines: string[] = [`Would revert ${count} change(s), most recent first:`, ''];
          for (const record of pending.slice(0, Math.min(count, UNDO_PREVIEW_LIMIT))) {
            const target = record.toPath ? `${record.path} → ${record.toPath}` : record.path;
            lines.push(`  ${KIND_LABEL[record.kind].padEnd(8)} ${target}`);
          }
          if (count > UNDO_PREVIEW_LIMIT) lines.push(`  … and ${count - UNDO_PREVIEW_LIMIT} more`);
          lines.push('');
          lines.push(`Re-run to confirm: /undo ${count} --yes`);
          lines.push('Files modified since the agent wrote them are refused, not overwritten.');
          return { ok: true, output: lines.join('\n') };
        }

        const paths = new WorkspacePaths(app.projectPath);
        const summary = undoChanges(ledger, paths, count);
        app.saveSession();

        const lines: string[] = [
          `Undo: ${summary.reverted}/${summary.attempted} change(s) reverted.`,
          '',
        ];
        for (const outcome of summary.outcomes) {
          lines.push(`  ${outcome.ok ? '✔' : '✖'} ${outcome.message}`);
        }
        const failed = summary.outcomes.filter((outcome) => !outcome.ok).length;
        if (failed > 0) {
          lines.push('');
          lines.push(`${failed} change(s) could not be reverted — see reasons above.`);
        }
        return { ok: failed === 0, output: lines.join('\n') };
      },
    },

    {
      name: 'instructions',
      category: 'workspace',
      description: 'List the instruction files loaded into the system prompt (§47)',
      usage: '/instructions',
      availableDuringGeneration: true,
      handler: (): CommandResult => {
        const bundle = discoverInstructions(app.projectPath);
        const lines: string[] = ['Instruction precedence (highest first):'];
        INSTRUCTION_PRECEDENCE.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
        lines.push('');
        if (bundle.sources.length === 0) {
          lines.push('No instruction files found in this workspace.');
          lines.push('');
          lines.push(
            'Supported files: .mediaxg/INSTRUCTIONS.md, MEDIAXG.md, AGENTS.md, CLAUDE.md,',
          );
          lines.push('and ~/.config/mediaxg/instructions.md (user-global).');
        } else {
          lines.push(
            `${bundle.sources.length} file(s) loaded (${formatBytes(bundle.totalBytes)} total):`,
          );
          for (const source of bundle.sources) {
            lines.push(
              `  ${source.displayPath} (${source.scope}, ${formatBytes(source.bytes)}${source.truncated ? ', truncated' : ''})`,
            );
          }
          lines.push('');
          lines.push('Instruction files are lower trust than system and safety rules.');
        }
        return { ok: true, output: lines.join('\n') };
      },
    },

    {
      name: 'commit-message',
      category: 'workspace',
      description: 'Propose a commit message for the current changes (never commits)',
      usage: '/commit-message [--staged]',
      examples: ['/commit-message', '/commit-message --staged'],
      handler: async ({ flags }): Promise<CommandResult> => {
        const staged = flags['staged'] === true;
        const active = app.activeModel();
        if (!active) {
          return {
            ok: false,
            error: 'No model selected. Run /models and /model <model> before /commit-message.',
          };
        }

        const repo = await isGitRepository(app.projectPath);
        if (!repo) {
          return { ok: true, output: 'Not a git repository — commit messages require git.' };
        }

        let result = await collectGitDiff(app.projectPath, { ...(staged ? { staged: true } : {}) });
        let scope = staged ? 'staged' : 'working-tree';
        if (result.files.length === 0 && !staged) {
          result = await collectGitDiff(app.projectPath, { staged: true });
          scope = 'staged';
        }
        if (result.files.length === 0) {
          return { ok: true, output: 'Nothing to commit: no working-tree or staged changes.' };
        }

        const header = [
          `${scope} changes: ${result.files.length} file(s), +${result.insertions}/-${result.deletions}`,
          ...result.files.map((file) => `  ${file}`),
        ].join('\n');
        const diffBody = result.diff.trim().slice(0, 40000);

        return {
          ok: true,
          output: `${header}\n\nProposing a commit message (read-only; nothing is committed).`,
          action: {
            type: 'start-agent-turn',
            prompt:
              'Propose a single conventional-commit-style message for the changes in the task context. ' +
              'Return only the commit message (subject line, then an optional body). Do not run git commit or modify files.',
            contextPreamble: `## Changes to summarize\n${header}\n\n${diffBody}`,
          },
        };
      },
    },
  ];
}
