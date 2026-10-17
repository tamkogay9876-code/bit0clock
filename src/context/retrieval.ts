/**
 * Incremental repository indexing and retrieval (§26).
 *
 * Design rules:
 *  - The index is a discovery/ranking aid, never a source of truth: every
 *    extraction and text search re-reads the file from disk.
 *  - Bounded traversal: ignore rules, extension allowlist, size limits,
 *    depth limit, file-count limit, binary exclusion, generated-file
 *    exclusion, sensitive-file exclusion.
 *  - Change detection updates metadata lazily (stat on access) and via
 *    `refresh()`; stale entries are corrected, never trusted.
 *
 * There is no vector database here on purpose: accurate keyword retrieval
 * with fresh content beats premature semantic indexes. A semantic index can
 * be added behind this interface later.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import type { Dirent } from 'fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'path';
import { estimateTextTokens } from './tokens.js';

// ============================================================================
// Constants
// ============================================================================

/** Directories never traversed. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.idea',
  '.vscode',
  '.mediaxg',
  '.gradle',
  '.terraform',
];

/** Extension allowlist: text/source/config files only. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'json',
  'jsonc',
  'json5',
  'md',
  'markdown',
  'mdx',
  'txt',
  'rst',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro',
  'sql',
  'graphql',
  'gql',
  'proto',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'py',
  'pyi',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'hh',
  'cs',
  'php',
  'swift',
  'lua',
  'r',
  'pl',
  'pm',
  'ex',
  'exs',
  'erl',
  'clj',
  'cljs',
  'edn',
  'hs',
  'ml',
  'mli',
  'zig',
  'dart',
  'gradle',
  'groovy',
  'tf',
  'tfvars',
  'hcl',
  'nix',
  'dockerfile',
]);

/** Extensionless files with a known text format. */
export const SPECIAL_TEXT_FILES: ReadonlySet<string> = new Set([
  'Dockerfile',
  'Makefile',
  'GNUmakefile',
  'CMakeLists.txt',
  'README',
  'LICENSE',
  'NOTICE',
  'CHANGELOG',
  'Procfile',
  'Rakefile',
  'Gemfile',
  'Justfile',
]);

/** Files never indexed: credentials and secrets stay out of prompts. */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.netrc$/i,
  /^credentials?(\.|$)/i,
  /^secrets?(\.|$)/i,
  /\.keystore$/i,
];

/** Generated artifacts are indexed as metadata but excluded from search/default extraction. */
const GENERATED_FILE_PATTERNS: readonly RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^Cargo\.lock$/i,
  /^poetry\.lock$/i,
  /^composer\.lock$/i,
  /^Gemfile\.lock$/i,
  /^go\.sum$/i,
  /\.generated\./i,
];

// ============================================================================
// Types
// ============================================================================

export interface RepoFileEntry {
  /** Workspace-relative path with forward slashes */
  path: string;
  size: number;
  mtimeMs: number;
  ext: string;
  generated: boolean;
}

export interface RepoIndexStats {
  files: number;
  dirsScanned: number;
  skippedIgnored: number;
  skippedSize: number;
  skippedExtension: number;
  skippedSensitive: number;
  truncated: boolean;
  builtAt: string;
}

export interface RepoIndexOptions {
  workspaceRoot: string;
  /** Maximum files indexed per scan (default 20000) */
  maxFiles?: number;
  /** Maximum directory depth (default 12) */
  maxDepth?: number;
  /** Maximum indexed file size in bytes (default 512 KiB) */
  maxFileSizeBytes?: number;
  /** Extra directory names to ignore */
  extraIgnoredDirs?: string[];
  now?: () => Date;
}

export interface RepoSearchResult {
  entry: RepoFileEntry;
  score: number;
  reasons: string[];
}

export interface RepoTextMatch {
  path: string;
  /** 1-based line number */
  line: number;
  text: string;
}

export interface RepoTextSearchResult {
  matches: RepoTextMatch[];
  filesScanned: number;
  truncated: boolean;
}

export interface RepoExtraction {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  tokens: number;
  /** True when the content was cut at the token cap */
  truncated: boolean;
  mtimeMs: number;
  note?: string;
}

// ============================================================================
// Ignore rules (best-effort .gitignore subset)
// ============================================================================

interface IgnoreRule {
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
  /** Directory (workspace-relative) the rule file lives in; '' for root */
  baseDir: string;
}

function globToRegexSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Parse a .gitignore file (documented best-effort subset). */
export function parseGitignore(content: string, baseDir = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    line = line.replace(/^\//, '');
    if (line === '') continue;

    const anchored = rawLine.trim().replace(/^!/, '').startsWith('/') || line.includes('/');
    const source = globToRegexSource(line);
    // Unanchored single-segment patterns match at any depth.
    const prefix = anchored ? '^' : '(^|.*/)';
    rules.push({
      regex: new RegExp(`${prefix}${source}($|/)`),
      negated,
      dirOnly,
      baseDir,
    });
  }
  return rules;
}

function matchesRules(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const scoped =
      rule.baseDir === ''
        ? relPath
        : relPath.startsWith(`${rule.baseDir}/`)
          ? relPath.slice(rule.baseDir.length + 1)
          : null;
    if (scoped === null || scoped === '') continue;
    if (rule.regex.test(scoped)) ignored = !rule.negated;
  }
  return ignored;
}

// ============================================================================
// RepoIndex
// ============================================================================

export interface RepoSearchOptions {
  limit?: number;
  /** Include lockfiles/minified files (default false) */
  includeGenerated?: boolean;
  /** Maximum files whose content is scanned for scoring (default 400) */
  maxContentFiles?: number;
  /** Maximum bytes read while scoring (default 4 MiB) */
  maxContentBytes?: number;
}

export class RepoIndex {
  private readonly root: string;
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private readonly maxFileSizeBytes: number;
  private readonly extraIgnoredDirs: ReadonlySet<string>;
  private readonly now: () => Date;

  private entries = new Map<string, RepoFileEntry>();
  private lastStats: RepoIndexStats | null = null;

  constructor(options: RepoIndexOptions) {
    this.root = resolve(options.workspaceRoot);
    this.maxFiles = options.maxFiles ?? 20000;
    this.maxDepth = options.maxDepth ?? 12;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 512 * 1024;
    this.extraIgnoredDirs = new Set(options.extraIgnoredDirs ?? []);
    this.now = options.now ?? (() => new Date());
  }

  get workspaceRoot(): string {
    return this.root;
  }

  get isBuilt(): boolean {
    return this.lastStats !== null;
  }

  get stats(): RepoIndexStats | null {
    return this.lastStats;
  }

  private toDisplayPath(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }

  /** Full bounded traversal. Returns scan statistics. */
  build(): RepoIndexStats {
    const stats: RepoIndexStats = {
      files: 0,
      dirsScanned: 0,
      skippedIgnored: 0,
      skippedSize: 0,
      skippedExtension: 0,
      skippedSensitive: 0,
      truncated: false,
      builtAt: this.now().toISOString(),
    };
    const entries = new Map<string, RepoFileEntry>();

    const walk = (dir: string, depth: number, rules: IgnoreRule[]): void => {
      if (depth > this.maxDepth) return;
      if (entries.size >= this.maxFiles) {
        stats.truncated = true;
        return;
      }
      stats.dirsScanned++;

      // Nested .gitignore scopes additional rules to this directory
      let scopedRules = rules;
      const gitignorePath = join(dir, '.gitignore');
      if (existsSync(gitignorePath)) {
        try {
          const baseDir = dir === this.root ? '' : this.toDisplayPath(dir);
          scopedRules = [
            ...rules,
            ...parseGitignore(readFileSync(gitignorePath, 'utf-8'), baseDir),
          ];
        } catch {
          // unreadable .gitignore: proceed without its rules
        }
      }

      let dirents: Dirent[];
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable directory: skip
      }

      for (const dirent of dirents) {
        if (entries.size >= this.maxFiles) {
          stats.truncated = true;
          return;
        }
        const absolute = join(dir, dirent.name);
        const relPath = this.toDisplayPath(absolute);

        if (dirent.isDirectory()) {
          if (
            DEFAULT_IGNORED_DIRS.includes(dirent.name) ||
            this.extraIgnoredDirs.has(dirent.name)
          ) {
            stats.skippedIgnored++;
            continue;
          }
          if (matchesRules(relPath, true, scopedRules)) {
            stats.skippedIgnored++;
            continue;
          }
          walk(absolute, depth + 1, scopedRules);
          continue;
        }

        if (!dirent.isFile()) continue; // symlinks and specials are not followed

        if (isSensitiveFile(dirent.name)) {
          stats.skippedSensitive++;
          continue;
        }
        if (matchesRules(relPath, false, scopedRules)) {
          stats.skippedIgnored++;
          continue;
        }
        if (!isIndexableName(dirent.name)) {
          stats.skippedExtension++;
          continue;
        }

        let fileStats;
        try {
          fileStats = statSync(absolute);
        } catch {
          continue;
        }
        if (fileStats.size === 0) continue;
        if (fileStats.size > this.maxFileSizeBytes) {
          stats.skippedSize++;
          continue;
        }

        entries.set(relPath, {
          path: relPath,
          size: fileStats.size,
          mtimeMs: fileStats.mtimeMs,
          ext: extensionOf(dirent.name),
          generated: isGeneratedFile(dirent.name),
        });
        stats.files++;
      }
    };

    if (existsSync(this.root)) {
      walk(this.root, 0, []);
      if (entries.size >= this.maxFiles) stats.truncated = true;
    }

    this.entries = entries;
    this.lastStats = stats;
    return stats;
  }

  /** Ensure the index is built (lazy). */
  ensureBuilt(): RepoIndexStats {
    return this.lastStats ?? this.build();
  }

  /** Re-scan and report what changed (metadata-level change detection). */
  refresh(): { added: number; removed: number; changed: number } {
    const previous = new Map(this.entries);
    this.build();
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [path, entry] of this.entries) {
      const before = previous.get(path);
      if (!before) added++;
      else if (before.mtimeMs !== entry.mtimeMs || before.size !== entry.size) changed++;
    }
    for (const path of previous.keys()) {
      if (!this.entries.has(path)) removed++;
    }
    return { added, removed, changed };
  }

  list(): RepoFileEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Metadata lookup with lazy freshness: stale metadata is corrected from
   * disk. The returned entry never substitutes for reading the file.
   */
  get(path: string): RepoFileEntry | undefined {
    const key = normalizeRelative(path);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    try {
      const fileStats = statSync(join(this.root, key));
      if (fileStats.mtimeMs !== entry.mtimeMs || fileStats.size !== entry.size) {
        entry.mtimeMs = fileStats.mtimeMs;
        entry.size = fileStats.size;
      }
    } catch {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  invalidate(path: string): void {
    this.entries.delete(normalizeRelative(path));
  }

  readFile(path: string): { ok: true; content: string } | { ok: false; error: string } {
    const absolute = this.resolveInside(path);
    if (!absolute) return { ok: false, error: `Path escapes the workspace: ${path}` };

    let buffer: Buffer;
    try {
      const fileStats = statSync(absolute);
      if (!fileStats.isFile()) return { ok: false, error: `Not a file: ${path}` };
      if (fileStats.size > this.maxFileSizeBytes) {
        return {
          ok: false,
          error: `File exceeds the ${this.maxFileSizeBytes}-byte index limit: ${path}`,
        };
      }
      buffer = readFileSync(absolute);
    } catch (err) {
      return { ok: false, error: `Cannot read ${path}: ${(err as Error).message}` };
    }

    if (looksBinary(buffer))
      return { ok: false, error: `Binary file excluded from retrieval: ${path}` };
    return { ok: true, content: buffer.toString('utf-8') };
  }

  /**
   * Rank indexed files for a free-text query. Content scoring is bounded:
   * at most `maxContentFiles` reads and `maxContentBytes` bytes.
   */
  search(query: string, options: RepoSearchOptions = {}): RepoSearchResult[] {
    this.ensureBuilt();
    const limit = options.limit ?? 10;
    const includeGenerated = options.includeGenerated ?? false;
    const maxContentFiles = options.maxContentFiles ?? 400;
    const maxContentBytes = options.maxContentBytes ?? 4 * 1024 * 1024;

    const terms = tokenizeQuery(query);
    if (terms.length === 0) return [];

    const results: Array<{ entry: RepoFileEntry; score: number; reasons: string[] }> = [];
    const candidates = [...this.entries.values()].filter(
      (entry) => includeGenerated || !entry.generated,
    );

    let contentReads = 0;
    let contentBytes = 0;

    for (const entry of candidates) {
      const lowerPath = entry.path.toLowerCase();
      let score = 0;
      const reasons: string[] = [];

      for (const term of terms) {
        if (lowerPath.includes(term)) {
          const base = lowerPath.split('/').pop() ?? lowerPath;
          if (base.includes(term)) {
            score += 40;
            reasons.push(`filename contains "${term}"`);
          } else {
            score += 15;
            reasons.push(`path contains "${term}"`);
          }
        }
      }

      if (contentReads < maxContentFiles && contentBytes < maxContentBytes) {
        const read = this.readFile(entry.path);
        if (read.ok) {
          contentReads++;
          contentBytes += read.content.length;
          const lower = read.content.toLowerCase();
          let contentScore = 0;
          for (const term of terms) {
            let index = 0;
            let hits = 0;
            while (hits < 20) {
              const found = lower.indexOf(term, index);
              if (found === -1) break;
              hits++;
              index = found + term.length;
            }
            if (hits > 0) {
              contentScore += 3 + hits;
              if (reasons.length < 4) reasons.push(`content matches "${term}" (${hits})`);
            }
          }
          if (contentScore > 0 && score === 0) {
            // Files with relevant content but no name match still qualify
            score += contentScore;
          } else {
            score += contentScore;
          }
        }
      }

      if (score > 0) results.push({ entry, score, reasons });
    }

    results.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
    return results.slice(0, limit);
  }

  /** Plain text search across indexed files, always reading current content. */
  textSearch(
    query: string,
    options: { limit?: number; maxFiles?: number; maxMatchesPerFile?: number } = {},
  ): RepoTextSearchResult {
    this.ensureBuilt();
    const limit = options.limit ?? 40;
    const maxFiles = options.maxFiles ?? 500;
    const maxMatchesPerFile = options.maxMatchesPerFile ?? 3;
    const needle = query.toLowerCase();
    const matches: RepoTextMatch[] = [];
    let filesScanned = 0;
    let truncated = false;

    if (needle === '') return { matches, filesScanned, truncated };

    for (const entry of this.entries.values()) {
      if (filesScanned >= maxFiles || matches.length >= limit) {
        truncated = true;
        break;
      }
      const read = this.readFile(entry.path);
      if (!read.ok) continue;
      filesScanned++;

      const lines = read.content.split(/\r?\n/);
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        if (perFile >= maxMatchesPerFile || matches.length >= limit) {
          truncated = matches.length >= limit || i < lines.length - 1;
          break;
        }
        const line = lines[i]!;
        if (line.toLowerCase().includes(needle)) {
          matches.push({ path: entry.path, line: i + 1, text: line.trim().slice(0, 200) });
          perFile++;
        }
      }
    }

    return { matches, filesScanned, truncated };
  }

  /**
   * Extract a line range from the current file contents, capped by tokens.
   * The index contributes metadata only; content always comes from disk.
   */
  extract(
    path: string,
    options: { startLine?: number; endLine?: number; maxTokens?: number } = {},
  ): RepoExtraction | { error: string } {
    const read = this.readFile(path);
    if (!read.ok) return { error: read.error };

    const key = normalizeRelative(path);
    const lines = read.content.split(/\r?\n/);
    const totalLines = lines.length;
    const start = Math.max(1, options.startLine ?? 1);
    const end = Math.min(totalLines, options.endLine ?? Math.min(totalLines, start + 199));
    if (start > totalLines) {
      return { error: `Line ${start} is beyond the end of ${key} (${totalLines} lines)` };
    }

    const maxTokens = options.maxTokens ?? 1500;
    const maxChars = maxTokens * 4;
    let selected = lines.slice(start - 1, end).join('\n');
    let truncated = false;
    if (selected.length > maxChars) {
      selected = `${selected.slice(0, maxChars)}\n…[truncated at the snippet token cap]`;
      truncated = true;
    }

    return {
      path: key,
      startLine: start,
      endLine: end,
      totalLines,
      content: selected,
      tokens: estimateTextTokens(selected),
      truncated,
      mtimeMs: this.statMtime(key),
    };
  }

  private statMtime(path: string): number {
    try {
      return statSync(join(this.root, path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private resolveInside(path: string): string | null {
    const absolute = isAbsolute(path) ? normalize(path) : resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return absolute;
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function isSensitiveFile(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isGeneratedFile(name: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isIndexableName(name: string): boolean {
  if (SPECIAL_TEXT_FILES.has(name)) return true;
  const ext = extensionOf(name);
  return ext !== '' && TEXT_EXTENSIONS.has(ext);
}

/** Null-byte heuristic on the first 8 KiB. */
export function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'please',
  'file',
  'files',
  'code',
  'when',
  'what',
  'where',
  'which',
  'should',
  'could',
  'would',
  'have',
  'has',
  'was',
  'were',
  'are',
  'not',
  'but',
  'you',
  'your',
  'our',
  'its',
  'can',
  'will',
  'add',
  'fix',
  'update',
]);

export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    const term = raw.replace(/^[-./]+|[-./]+$/g, '');
    if (term.length < 3 || STOPWORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 12) break;
  }
  return terms;
}
