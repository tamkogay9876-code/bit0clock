/**
 * Repository tools: repo_status and show_diff (§40, §43, §46).
 *
 * Uses real git state. When the workspace is not a git repository,
 * show_diff falls back to the agent's own change ledger rather than
 * pretending a repository exists.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { z } from 'zod';
import { diffLines } from 'diff';
import { defineTool, toolOk, type RegisteredTool } from './types.js';
import type { WorkspacePaths } from './paths.js';
import { runProcess } from './exec-tools.js';
import { inspectProject } from './project.js';
import type { ChangeRecord } from './ledger.js';

const MAX_DIFF_BYTES = 64 * 1024;

export interface GitRepoState {
  isRepo: boolean;
}

/** Accurate check that works from subdirectories of a repository. */
export async function isGitRepository(root: string): Promise<boolean> {
  if (existsSync(join(root, '.git'))) return true;
  const result = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    timeoutMs: 10_000,
    outputLimit: 1024,
  });
  return !result.spawnError && result.exitCode === 0 && result.stdout.trim() === 'true';
}

export interface GitDiffOptions {
  staged?: boolean;
  path?: string;
  contextLines?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  diff: string;
  files: string[];
  insertions: number;
  deletions: number;
  truncated: boolean;
}

/** Collect the working-tree (or staged) diff with numstat totals. */
export async function collectGitDiff(
  root: string,
  options: GitDiffOptions = {},
): Promise<GitDiffResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseArgs = ['diff', '--no-color'];
  const stagedArgs = options.staged ? ['--staged'] : [];
  const pathArgs = options.path ? ['--', options.path] : [];

  const diff = await runProcess(
    'git',
    [...baseArgs, `-U${options.contextLines ?? 3}`, ...stagedArgs, ...pathArgs],
    {
      cwd: root,
      timeoutMs,
      outputLimit: MAX_DIFF_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (diff.spawnError || diff.exitCode !== 0) {
    return { isRepo: false, diff: '', files: [], insertions: 0, deletions: 0, truncated: false };
  }

  const numstat = await runProcess('git', ['diff', '--numstat', ...stagedArgs, ...pathArgs], {
    cwd: root,
    timeoutMs,
    outputLimit: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  if (!numstat.spawnError && numstat.exitCode === 0) {
    for (const line of numstat.stdout.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const added = parts[0] === '-' ? 0 : Number(parts[0]);
      const removed = parts[1] === '-' ? 0 : Number(parts[1]);
      insertions += Number.isFinite(added) ? added : 0;
      deletions += Number.isFinite(removed) ? removed : 0;
      files.push(parts[2]!);
    }
  }

  return {
    isRepo: true,
    diff: diff.stdout,
    files,
    insertions,
    deletions,
    truncated: diff.stdoutTruncated,
  };
}

/** Diff fallback when the workspace is not a git repository. */
export function formatLedgerDiff(records: ChangeRecord[]): string {
  const pending = records.filter((record) => !record.reverted);
  if (pending.length === 0) {
    return 'No changes recorded in this session and the workspace is not a git repository.';
  }
  const lines: string[] = [
    'Not a git repository — showing agent changes recorded this session:',
    '',
  ];
  for (const record of pending) {
    if (record.kind === 'rename' && record.toPath) {
      lines.push(`rename ${record.path} → ${record.toPath}`);
      continue;
    }
    if (record.beforeContent !== undefined && record.afterContent !== undefined) {
      let added = 0;
      let removed = 0;
      for (const change of diffLines(record.beforeContent, record.afterContent)) {
        const count = change.count ?? change.value.split('\n').length;
        if (change.added) added += count;
        else if (change.removed) removed += count;
      }
      lines.push(`${record.kind} ${record.path} (+${added}/-${removed})`);
    } else if (record.kind === 'delete') {
      lines.push(
        `delete ${record.path} (snapshot ${record.beforeContent !== undefined ? 'available' : 'unavailable'})`,
      );
    } else {
      lines.push(`${record.kind} ${record.path}`);
    }
  }
  lines.push('');
  lines.push('Use /diff after initializing git for full repository diffs.');
  return lines.join('\n');
}

export function createGitTools(
  paths: WorkspacePaths,
  ledgerRecords: () => ChangeRecord[],
): RegisteredTool[] {
  const repoStatus = defineTool({
    name: 'repo_status',
    description:
      'Report repository status: git branch, staged/unstaged/untracked files, and ' +
      'detected project metadata (package manager, test and lint commands).',
    schema: z.object({}),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 20_000,
    outputBudget: 20_000,
    summarize: () => 'inspect repository status',
    execute: async () => {
      const project = inspectProject(paths.realRoot);
      const lines: string[] = [];

      const repo = await isGitRepository(paths.realRoot);
      if (repo) {
        const status = await runProcess('git', ['status', '--porcelain=v1', '-b'], {
          cwd: paths.realRoot,
          timeoutMs: 20_000,
          outputLimit: 32 * 1024,
        });
        const statusLines = status.stdout.split('\n').filter((l) => l.trim() !== '');
        const header = statusLines.find((l) => l.startsWith('##')) ?? '';
        const entries = statusLines.filter((l) => !l.startsWith('##'));

        lines.push('Git status:');
        lines.push(`  ${header.replace(/^## /, 'branch: ') || 'branch: (unknown)'}`);
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        for (const entry of entries.slice(0, 100)) {
          const code = entry.slice(0, 2);
          if (code === '??') untracked++;
          else {
            if (code[0] !== ' ' && code[0] !== '?') staged++;
            if (code[1] !== ' ' && code[1] !== '?') unstaged++;
          }
          lines.push(`  ${entry}`);
        }
        if (entries.length > 100) lines.push(`  … and ${entries.length - 100} more entries`);
        lines.push(`  totals: ${staged} staged, ${unstaged} unstaged, ${untracked} untracked`);

        const meta: Record<string, unknown> = { branch: header, staged, unstaged, untracked };
        lines.push('');
        lines.push('Project:');
        lines.push(
          `  package manager  ${project.packageManager.name} (${project.packageManager.source})`,
        );
        lines.push(
          `  test command     ${project.testCommand ? `${project.testCommand.program} ${project.testCommand.args.join(' ')}` : 'not detected'}`,
        );
        lines.push(
          `  lint command     ${project.lintCommand ? `${project.lintCommand.program} ${project.lintCommand.args.join(' ')}` : 'not detected'}`,
        );
        return toolOk(lines.join('\n'), meta);
      }

      lines.push('Not a git repository.');
      lines.push('');
      lines.push('Workspace metadata:');
      lines.push(`  workspace        ${paths.realRoot}`);
      lines.push(`  package.json     ${project.hasPackageJson ? 'present' : 'missing'}`);
      lines.push(
        `  package manager  ${project.packageManager.name} (${project.packageManager.source})`,
      );
      lines.push(`  tsconfig.json    ${project.hasTsconfig ? 'present' : 'missing'}`);
      lines.push(`  README           ${project.hasReadme ? 'present' : 'missing'}`);
      lines.push(
        `  test command     ${project.testCommand ? `${project.testCommand.program} ${project.testCommand.args.join(' ')}` : 'not detected'}`,
      );
      lines.push(
        `  scripts          ${Object.keys(project.scripts).length > 0 ? Object.keys(project.scripts).join(', ') : 'none'}`,
      );
      return toolOk(lines.join('\n'), { isRepo: false });
    },
  });

  const showDiff = defineTool({
    name: 'show_diff',
    description:
      'Show the working-tree diff (or staged diff with staged=true). In a non-git ' +
      'workspace, shows file changes recorded by the agent this session.',
    schema: z.object({
      staged: z.boolean().optional().describe('Show staged changes (git diff --staged)'),
      path: z.string().optional().describe('Limit the diff to one path'),
      statOnly: z.boolean().optional().describe('Show only the file list and totals'),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 30_000,
    outputBudget: 70_000,
    summarize: (args) =>
      `show ${args.staged ? 'staged' : 'working-tree'} diff${args.path ? ` for ${args.path}` : ''}`,
    execute: async (args) => {
      let pathFilter: string | undefined;
      if (args.path) {
        pathFilter = paths.resolve(args.path).rel;
      }

      const repo = await isGitRepository(paths.realRoot);
      if (!repo) {
        return toolOk(formatLedgerDiff(ledgerRecords()), { isRepo: false });
      }

      const result = await collectGitDiff(paths.realRoot, {
        ...(args.staged ? { staged: true } : {}),
        ...(pathFilter ? { path: pathFilter } : {}),
      });

      if (result.files.length === 0) {
        return toolOk(`No ${args.staged ? 'staged' : 'working-tree'} changes.`, {
          files: 0,
          insertions: 0,
          deletions: 0,
        });
      }

      const header = [
        `${args.staged ? 'Staged' : 'Working-tree'} changes: ${result.files.length} file(s), +${result.insertions}/-${result.deletions}`,
        ...result.files.map((file) => `  ${file}`),
      ].join('\n');

      if (args.statOnly) {
        return toolOk(header, {
          files: result.files.length,
          insertions: result.insertions,
          deletions: result.deletions,
        });
      }

      const body =
        result.diff.trim() === '' ? '(diff content empty; possibly binary changes)' : result.diff;
      const truncationNote = result.truncated ? '\n(diff truncated at the output cap)' : '';
      return toolOk(`${header}\n\n${body}${truncationNote}`, {
        files: result.files.length,
        insertions: result.insertions,
        deletions: result.deletions,
        truncated: result.truncated,
      });
    },
  });

  return [repoStatus, showDiff];
}
