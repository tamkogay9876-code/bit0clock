/**
 * Read-only filesystem tools: read_file, list_dir, glob_files, search_text,
 * read_doc (§40).
 *
 * All paths are validated by WorkspacePaths; sensitive files are refused;
 * binary and oversized files are handled explicitly rather than silently.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { z } from 'zod';
import { globSync } from 'glob';
import ignore from 'ignore';
import { defineTool, toolOk, ToolError, type RegisteredTool } from './types.js';
import { DEFAULT_IGNORED_DIRS, WorkspacePaths, sensitiveReason } from './paths.js';
import {
  MAX_SEARCH_FILE_BYTES,
  formatNumberedLines,
  looksBinary,
  readTextFile,
} from './file-utils.js';

const READ_DEFAULT_LINES = 500;
const READ_MAX_LINES = 2000;
const LIST_MAX_ENTRIES = 200;
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);

// ============================================================================
// Shared helpers
// ============================================================================

interface FileCollection {
  files: string[];
  skippedSensitive: number;
  ignoredCount: number;
}

/**
 * Walk the workspace with glob, respecting default ignores and `.gitignore`.
 * Returns workspace-relative paths.
 */
function collectWorkspaceFiles(
  paths: WorkspacePaths,
  pattern: string,
  options: { searchBase?: string } = {},
): FileCollection {
  if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
    throw new ToolError(`Pattern must be workspace-relative (no leading '/' or '..'): ${pattern}`, {
      code: 'invalid-input',
    });
  }

  const base = options.searchBase ?? paths.realRoot;
  const ignoreMatcher = ignore();
  const gitignorePath = join(paths.realRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      ignoreMatcher.add(readFileSync(gitignorePath, 'utf8'));
    } catch {
      // unreadable .gitignore is not fatal
    }
  }

  const globIgnore = DEFAULT_IGNORED_DIRS.map((dir) => `**/${dir}/**`);
  const matches = globSync(pattern, {
    cwd: base,
    dot: false,
    nodir: false,
    follow: false,
    ignore: globIgnore,
  });

  const files: string[] = [];
  let skippedSensitive = 0;
  let ignoredCount = 0;

  for (const match of matches) {
    const rel = relative(paths.realRoot, join(base, match)).split('\\').join('/');
    if (rel.startsWith('..')) continue;
    if (ignoreMatcher.ignores(rel)) {
      ignoredCount++;
      continue;
    }
    if (sensitiveReason(rel)) {
      skippedSensitive++;
      continue;
    }
    // Symlink-safe canonicalization happens here; unreadable entries are skipped
    try {
      paths.resolve(rel);
    } catch {
      skippedSensitive++;
      continue;
    }
    files.push(rel);
  }

  files.sort();
  return { files, skippedSensitive, ignoredCount };
}

// ============================================================================
// createFsTools
// ============================================================================

export function createFsTools(paths: WorkspacePaths): RegisteredTool[] {
  const readFile = defineTool({
    name: 'read_file',
    description:
      'Read a text file from the workspace with line numbers. Output is bounded; ' +
      'use offset/limit to page through large files. Binary and credential files are refused.',
    schema: z.object({
      path: z.string().min(1).describe('Workspace-relative file path'),
      offset: z.number().int().min(1).optional().describe('1-based first line to show'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(READ_MAX_LINES)
        .optional()
        .describe(`Max lines (default ${READ_DEFAULT_LINES}, cap ${READ_MAX_LINES})`),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 10_000,
    outputBudget: 60_000,
    summarize: (args) => `read ${args.path}${args.offset ? ` from line ${args.offset}` : ''}`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path, { mustExist: true });
      const stats = statSync(abs);
      if (stats.isDirectory()) {
        throw new ToolError(`${rel} is a directory — use list_dir instead`, {
          code: 'invalid-input',
        });
      }

      const { text, bytes, truncated } = readTextFile(abs, rel);
      const start = args.offset ?? 1;
      const numbered = formatNumberedLines(text, start, args.limit ?? READ_DEFAULT_LINES);

      if (numbered.totalLines > 0 && start > numbered.totalLines) {
        throw new ToolError(
          `${rel}: offset ${start} is beyond the end of the file (${numbered.totalLines} lines)`,
          { code: 'invalid-input' },
        );
      }

      const notes: string[] = [];
      if (numbered.hasMore) {
        notes.push(
          `… ${numbered.totalLines - (start + numbered.linesShown - 1)} more lines — continue with offset=${start + numbered.linesShown}`,
        );
      }
      if (truncated) {
        notes.push(`(file is ${bytes} bytes; content cut at the read cap)`);
      }

      const content =
        notes.length > 0 ? `${numbered.output}\n\n${notes.join('\n')}` : numbered.output;
      return toolOk(content || '(empty file)', {
        bytes,
        totalLines: numbered.totalLines,
        linesShown: numbered.linesShown,
        truncated,
      });
    },
  });

  const listDir = defineTool({
    name: 'list_dir',
    description:
      'List entries of a workspace directory. Directories are marked with a trailing slash; ' +
      'sensitive credential entries are hidden from the listing.',
    schema: z.object({
      path: z.string().optional().describe("Workspace-relative directory (default '.')"),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 10_000,
    outputBudget: 20_000,
    summarize: (args) => `list ${args.path ?? '.'}`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path ?? '.', { mustExist: true });
      const stats = statSync(abs);
      if (!stats.isDirectory()) {
        throw new ToolError(`${rel} is not a directory — use read_file instead`, {
          code: 'invalid-input',
        });
      }

      const entries = readdirSync(abs, { withFileTypes: true });
      const rows: Array<{ name: string; display: string }> = [];
      let hiddenSensitive = 0;

      for (const entry of entries) {
        const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (sensitiveReason(entryRel)) {
          hiddenSensitive++;
          continue;
        }
        if (entry.isDirectory()) {
          rows.push({ name: entry.name, display: `${entry.name}/` });
        } else if (entry.isSymbolicLink()) {
          rows.push({ name: entry.name, display: `${entry.name}@ (symlink)` });
        } else {
          let size = 0;
          try {
            size = statSync(join(abs, entry.name)).size;
          } catch {
            size = 0;
          }
          rows.push({ name: entry.name, display: `${entry.name}  (${size} bytes)` });
        }
      }

      rows.sort((a, b) => {
        const aDir = a.display.endsWith('/') ? 0 : 1;
        const bDir = b.display.endsWith('/') ? 0 : 1;
        return aDir - bDir || a.name.localeCompare(b.name);
      });

      const shown = rows.slice(0, LIST_MAX_ENTRIES);
      const lines = shown.map((row) => row.display);
      if (rows.length > shown.length) {
        lines.push(`… and ${rows.length - shown.length} more entries`);
      }
      if (hiddenSensitive > 0) {
        lines.push(
          `(${hiddenSensitive} sensitive entr${hiddenSensitive === 1 ? 'y' : 'ies'} hidden)`,
        );
      }
      return toolOk(lines.length > 0 ? lines.join('\n') : '(empty directory)', {
        entries: rows.length,
        shown: shown.length,
      });
    },
  });

  const globFiles = defineTool({
    name: 'glob_files',
    description:
      'Find files by glob pattern relative to the workspace (e.g. "src/**/*.ts"). ' +
      'Respects .gitignore and skips build directories and credential files.',
    schema: z.object({
      pattern: z.string().min(1).describe("Glob pattern like 'src/**/*.ts'"),
      maxResults: z.number().int().min(1).max(500).optional().describe('Max results (default 100)'),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 15_000,
    outputBudget: 20_000,
    summarize: (args) => `glob ${args.pattern}`,
    execute: (args) => {
      const max = args.maxResults ?? 100;
      const { files } = collectWorkspaceFiles(paths, args.pattern);
      const shown = files.slice(0, max);
      if (shown.length === 0) {
        return toolOk(`No files match "${args.pattern}".`, { count: 0 });
      }
      const lines = [...shown];
      if (files.length > shown.length) {
        lines.push(`… and ${files.length - shown.length} more files (raise maxResults)`);
      }
      return toolOk(lines.join('\n'), { count: files.length, shown: shown.length });
    },
  });

  const searchText = defineTool({
    name: 'search_text',
    description:
      'Search file contents in the workspace (like grep). Supports regular expressions ' +
      'or literal text. Returns "path:line: text" matches, bounded by maxResults.',
    schema: z.object({
      query: z.string().min(1).describe('Regular expression (or literal text when literal=true)'),
      path: z.string().optional().describe('Limit the search to this file or directory'),
      include: z.string().optional().describe("Glob filter for files, e.g. 'src/**/*.ts'"),
      maxResults: z.number().int().min(1).max(200).optional().describe('Max matches (default 100)'),
      caseSensitive: z.boolean().optional().describe('Case-sensitive matching (default false)'),
      literal: z.boolean().optional().describe('Treat query as literal text instead of a regex'),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 30_000,
    outputBudget: 40_000,
    summarize: (args) => `search "${args.query}"${args.path ? ` in ${args.path}` : ''}`,
    execute: (args) => {
      const max = args.maxResults ?? 100;
      let regex: RegExp;
      try {
        const source = args.literal
          ? args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : args.query;
        regex = new RegExp(source, args.caseSensitive ? '' : 'i');
      } catch (err) {
        throw new ToolError(
          `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
          { code: 'invalid-input', hint: 'Set literal=true to search for plain text.' },
        );
      }

      let files: string[];
      if (args.path) {
        const target = paths.resolve(args.path, { mustExist: true });
        if (statSync(target.abs).isDirectory()) {
          // collectWorkspaceFiles returns workspace-relative paths already
          files = collectWorkspaceFiles(paths, args.include ?? '**/*', {
            searchBase: target.abs,
          }).files;
        } else {
          files = [target.rel];
        }
      } else {
        files = collectWorkspaceFiles(paths, args.include ?? '**/*').files;
      }

      const matches: string[] = [];
      let filesScanned = 0;
      let filesSkipped = 0;

      outer: for (const rel of files) {
        let abs: string;
        try {
          abs = paths.resolve(rel).abs;
        } catch {
          filesSkipped++;
          continue;
        }
        let stats;
        try {
          stats = statSync(abs);
        } catch {
          filesSkipped++;
          continue;
        }
        if (!stats.isFile() || stats.size > MAX_SEARCH_FILE_BYTES) {
          filesSkipped++;
          continue;
        }
        let buffer: Buffer;
        try {
          buffer = readFileSync(abs);
        } catch {
          filesSkipped++;
          continue;
        }
        if (looksBinary(buffer)) {
          filesSkipped++;
          continue;
        }

        filesScanned++;
        const lines = buffer.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (regex.test(line)) {
            const trimmed = line.length > 200 ? `${line.slice(0, 200)}…` : line;
            matches.push(`${rel}:${i + 1}: ${trimmed.trim()}`);
            if (matches.length >= max) break outer;
          }
        }
      }

      if (matches.length === 0) {
        return toolOk(`No matches for "${args.query}" (${filesScanned} files scanned).`, {
          matches: 0,
          filesScanned,
        });
      }
      const lines = [`${matches.length} match${matches.length === 1 ? '' : 'es'}:`, '', ...matches];
      if (matches.length >= max) {
        lines.push('', `(limit reached — refine the query or raise maxResults)`);
      }
      return toolOk(lines.join('\n'), { matches: matches.length, filesScanned, filesSkipped });
    },
  });

  const readDoc = defineTool({
    name: 'read_doc',
    description:
      'Read workspace documentation (Markdown/text under docs/, README/CHANGELOG files). ' +
      'Use read_file for source code. Credential files are refused.',
    schema: z.object({
      path: z.string().min(1).describe('Documentation file path'),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(READ_MAX_LINES).optional(),
    }),
    permissionClass: 'read',
    mutating: false,
    timeoutMs: 10_000,
    outputBudget: 60_000,
    summarize: (args) => `read doc ${args.path}`,
    execute: (args) => {
      const { abs, rel } = paths.resolve(args.path, { mustExist: true });
      const lower = rel.toLowerCase();
      const base = lower.split('/').pop() ?? lower;
      const extension = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
      const isDoc =
        DOC_EXTENSIONS.has(extension) ||
        lower.startsWith('docs/') ||
        ['readme', 'changelog', 'contributing', 'license', 'architecture'].some((name) =>
          base.startsWith(name),
        );
      if (!isDoc) {
        throw new ToolError(
          `${rel} is not recognized as documentation (allowed: docs/**, *.md, *.txt, *rst, README/CHANGELOG/CONTRIBUTING/LICENCE files)`,
          { code: 'unsupported', hint: 'Use read_file for source code.' },
        );
      }

      const { text, truncated } = readTextFile(abs, rel);
      const numbered = formatNumberedLines(
        text,
        args.offset ?? 1,
        args.limit ?? READ_DEFAULT_LINES,
      );
      const notes: string[] = [];
      if (numbered.hasMore) {
        notes.push(
          `… ${numbered.totalLines - (numbered.startLine + numbered.linesShown - 1)} more lines`,
        );
      }
      if (truncated) notes.push('(content cut at the read cap)');
      const content =
        notes.length > 0 ? `${numbered.output}\n\n${notes.join('\n')}` : numbered.output;
      return toolOk(content || '(empty document)', { totalLines: numbered.totalLines });
    },
  });

  return [readFile, listDir, globFiles, searchText, readDoc];
}
