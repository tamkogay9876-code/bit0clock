/**
 * Workspace boundaries and file safety (§41).
 *
 * Every tool path goes through `WorkspacePaths.resolve`:
 *  - traversal outside the workspace root is refused (including `..` escapes)
 *  - symbolic links are canonicalized; a link pointing outside is refused
 *  - sensitive credential files are never readable or writable by tools
 *  - git internals (`.git/**`) are not exposed to file tools
 */

import { existsSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { ToolError } from './types.js';

// ============================================================================
// Sensitive path patterns
// ============================================================================

const SENSITIVE_BASENAME_EXACT = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.htpasswd',
  '.pgpass',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'];

/** Explicitly safe examples/samples of sensitive file types. */
const BASENAME_ALLOWLIST = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  'example.env',
  'sample.env',
]);

const SENSITIVE_DIR_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube']);

function looksLikeCredentialJson(base: string): boolean {
  const lower = base.toLowerCase();
  return (
    lower.endsWith('credentials.json') ||
    lower.endsWith('credentials.yml') ||
    lower.endsWith('credentials.yaml') ||
    lower.includes('service-account') ||
    lower.includes('service_account')
  );
}

/**
 * Reason a workspace-relative path is sensitive, or undefined when it is safe.
 * Exported for tests and diagnostics.
 */
export function sensitiveReason(relPath: string): string | undefined {
  const normalized = relPath.split(sep).join('/').replace(/^\.\//, '');
  if (normalized === '' || normalized === '.') return undefined;

  const segments = normalized.split('/').filter((s) => s !== '');
  const base = segments[segments.length - 1] ?? '';

  if (segments[0] === '.git') {
    return 'git internals (.git/**) are not exposed to tools';
  }

  if (BASENAME_ALLOWLIST.has(base)) return undefined;

  if (base === '.env' || base.startsWith('.env.')) {
    return `${base} may contain credentials`;
  }
  if (SENSITIVE_BASENAME_EXACT.has(base)) {
    return `${base} may contain credentials`;
  }
  const lowerBase = base.toLowerCase();
  if (SENSITIVE_EXTENSIONS.some((ext) => lowerBase.endsWith(ext))) {
    return `files with extension ${lowerBase.slice(lowerBase.lastIndexOf('.'))} may contain private keys`;
  }
  if (looksLikeCredentialJson(base)) {
    return `${base} looks like a credential file`;
  }
  if (segments.some((segment) => SENSITIVE_DIR_SEGMENTS.has(segment))) {
    return 'the path is inside a credential/key directory';
  }
  return undefined;
}

// ============================================================================
// Path resolution
// ============================================================================

export interface ResolvedToolPath {
  /** Canonical absolute path (symlinks resolved) */
  abs: string;
  /** Workspace-relative path with `/` separators */
  rel: string;
}

export interface ResolveOptions {
  mustExist?: boolean;
  /** Write targets must not exist unless the caller handles overwrite */
  forWrite?: boolean;
}

/**
 * Normalizes and validates paths for a single workspace root.
 * One instance per session/agent loop; cheap to construct.
 */
export class WorkspacePaths {
  /** Workspace root as given (resolved, symlinks kept) */
  readonly root: string;
  /** Canonical root used for all containment checks */
  readonly realRoot: string;

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot);
    this.realRoot = existsSync(this.root) ? realpathSync(this.root) : this.root;
  }

  /**
   * Resolve a model-supplied path.
   * @throws ToolError with code 'outside-workspace' | 'sensitive-path' | 'not-found' | 'invalid-input'
   */
  resolve(input: string, options: ResolveOptions = {}): ResolvedToolPath {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new ToolError('A path is required', { code: 'invalid-input' });
    }
    if (input.includes('\0')) {
      throw new ToolError('Path contains a NUL byte', { code: 'invalid-input' });
    }
    if (!existsSync(this.root)) {
      throw new ToolError(`Workspace root does not exist: ${this.root}`, { code: 'io-error' });
    }

    // Models on any platform often emit backslashes; treat them as separators.
    const inputPath = input.replace(/\\/g, '/');
    const rawAbs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(this.realRoot, inputPath);

    if (options.mustExist && !existsSync(rawAbs)) {
      const rel = this.safeRelative(rawAbs);
      throw new ToolError(`File not found: ${rel ?? input}`, { code: 'not-found' });
    }

    const abs = this.canonicalize(rawAbs);

    if (!this.isInside(abs)) {
      throw new ToolError(
        `Path is outside the workspace: ${input}\nOnly paths inside ${this.realRoot} are allowed.`,
        { code: 'outside-workspace' },
      );
    }

    const rel = relative(this.realRoot, abs).split(sep).join('/');
    const reason = sensitiveReason(rel);
    if (reason) {
      throw new ToolError(`Refusing to access ${rel === '' ? input : rel}: ${reason}`, {
        code: 'sensitive-path',
        hint: 'Tools never read or write credential files. Edit them manually if needed.',
      });
    }

    return { abs, rel };
  }

  /** Resolve a workspace-relative path (used for undo/ledger records). */
  absoluteFor(relOrAbs: string): ResolvedToolPath {
    return this.resolve(relOrAbs);
  }

  /** Workspace-relative path for an absolute path, or null when outside. */
  safeRelative(absPath: string): string | null {
    const abs = this.canonicalize(resolve(absPath));
    if (!this.isInside(abs)) return null;
    return relative(this.realRoot, abs).split(sep).join('/');
  }

  isSensitive(relOrAbs: string): boolean {
    const rel = isAbsolute(relOrAbs) ? this.safeRelative(relOrAbs) : relOrAbs;
    if (rel === null) return true; // outside the workspace is never accessible
    return sensitiveReason(rel) !== undefined;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private isInside(abs: string): boolean {
    const rel = relative(this.realRoot, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  /**
   * Canonicalize a path by realpath-ing the longest existing prefix.
   * This defeats symlinks that point outside the workspace without
   * requiring the final file to exist (creates and renames).
   */
  private canonicalize(abs: string): string {
    let current = abs;
    const parts: string[] = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return abs;
      parts.unshift(basename(current));
      current = parent;
    }
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return abs;
    }
    if (parts.length === 0) return real;
    return join(real, ...parts);
  }
}

/** Directories skipped by search/glob tools unless a pattern targets them. */
export const DEFAULT_IGNORED_DIRS = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache'];
