/**
 * Skill manager (§32–§34): discovery, validation, activation, lazy loading.
 *
 * Trust model:
 *  - Every skill is instruction text, never code and never a permission grant.
 *    Scripts shipped by a skill are listed but never executed.
 *  - Skills are untrusted by default; `skillsSettings.trustedPaths` may mark
 *    specific directory prefixes as trusted, and even then they only raise the
 *    label — they cannot weaken the permission engine or mode policy.
 *
 * Discovery locations (highest precedence first):
 *  - `~/.config/mediaxg/skills/`   user    (explicit user configuration)
 *  - `<workspace>/.agents/skills/` project (Agent Skills convention)
 *  - `~/.agents/skills/`           global  (shared user-level convention)
 *  - every path in `skillsPaths` config (inside the workspace → project,
 *    otherwise user); a path may also be a single skill directory.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import type { Skill } from '../types/index.js';
import { looksBinary } from '../tools/file-utils.js';
import { parseSkillFrontmatter } from './frontmatter.js';

// ============================================================================
// Limits and constants (§34)
// ============================================================================

/** Hard cap for reading a SKILL.md file before parsing */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** Characters of instructions injected into a request after activation */
export const MAX_INSTRUCTION_CHARS = 32_000;
/** Byte cap when loading a reference file on demand */
export const MAX_REFERENCE_BYTES = 256 * 1024;
/** Maximum files listed per skill (references + assets) */
export const MAX_LISTED_FILES = 200;
/** Directory depth scanned inside references/, assets/, scripts/ */
export const MAX_SCAN_DEPTH = 3;

const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_COMPATIBILITY_CHARS = 500;

// ============================================================================
// Types
// ============================================================================

export type SkillScope = 'global' | 'project' | 'user';

const SCOPE_RANK: Record<SkillScope, number> = { user: 3, project: 2, global: 1 };

export interface SkillRoot {
  dir: string;
  scope: SkillScope;
  /** Display label used in diagnostics (e.g. `.agents/skills`, `~/.agents/skills`) */
  label: string;
}

export interface SkillDiagnostic {
  level: 'error' | 'warning';
  scope: SkillScope;
  path: string;
  message: string;
}

/** One activated skill, ready to be rendered into the system prompt. */
export interface SkillPromptItem {
  name: string;
  description: string;
  scope: SkillScope;
  trustLevel: 'trusted' | 'untrusted';
  instructions: string;
  truncated: boolean;
  references: string[];
  skillDir: string;
}

export interface LoadedReference {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface SkillReloadSummary {
  at: string;
  discovered: number;
  added: string[];
  removed: string[];
  changed: string[];
  deactivated: string[];
}

export interface SkillManagerStats {
  roots: SkillRoot[];
  discovered: number;
  valid: number;
  active: number;
  diagnostics: number;
  lastScanAt: string | null;
}

export interface SkillManagerOptions {
  workspaceRoot: string;
  /** Override the home directory (tests) */
  homeDir?: string;
  /** Additional configured roots (`skillsPaths`) */
  extraPaths?: string[];
  /** Path prefixes whose skills are classified as trusted (config) */
  trustedPaths?: string[];
  /** Whether discovery runs at all (config toggle) */
  enabled?: boolean;
  /** Maximum SKILL.md files scanned per discovery */
  maxFiles?: number;
  /** Override the computed roots entirely (tests) */
  roots?: SkillRoot[];
}

interface SkillRecord {
  skill: Skill;
  root: SkillRoot;
  dir: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Instructions have been read and are present in skill.instructions */
  bodyLoaded: boolean;
}

// ============================================================================
// Path helpers
// ============================================================================

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function displayDir(dir: string, workspaceRoot: string, home: string): string {
  if (isInside(workspaceRoot, dir)) return relative(workspaceRoot, dir).split(sep).join('/') || '.';
  if (isInside(home, dir)) return `~/${relative(home, dir).split(sep).join('/')}`;
  return dir;
}

function defaultRoots(workspaceRoot: string, home: string): SkillRoot[] {
  return [
    { dir: join(home, '.config/mediaxg/skills'), scope: 'user', label: '~/.config/mediaxg/skills' },
    { dir: join(workspaceRoot, '.agents/skills'), scope: 'project', label: '.agents/skills' },
    { dir: join(home, '.agents/skills'), scope: 'global', label: '~/.agents/skills' },
  ];
}

// ============================================================================
// Manager
// ============================================================================

export class SkillManager {
  private readonly options: Required<
    Pick<
      SkillManagerOptions,
      'workspaceRoot' | 'extraPaths' | 'trustedPaths' | 'enabled' | 'maxFiles'
    >
  > &
    Pick<SkillManagerOptions, 'roots' | 'homeDir'>;
  private readonly home: string;
  private records = new Map<string, SkillRecord>();
  private diagnostics: SkillDiagnostic[] = [];
  private lastScanAt: string | null = null;

  constructor(options: SkillManagerOptions) {
    this.options = {
      workspaceRoot: resolve(options.workspaceRoot),
      extraPaths: options.extraPaths ?? [],
      trustedPaths: options.trustedPaths ?? [],
      enabled: options.enabled ?? true,
      maxFiles: options.maxFiles ?? 500,
      ...(options.roots ? { roots: options.roots } : {}),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    };
    this.home = resolve(options.homeDir ?? homedir());
  }

  // --------------------------------------------------------------------------
  // Roots and discovery
  // --------------------------------------------------------------------------

  roots(): SkillRoot[] {
    if (this.options.roots) return this.options.roots;
    const roots = defaultRoots(this.options.workspaceRoot, this.home);
    for (const extra of this.options.extraPaths) {
      const dir = resolve(extra.replace(/^~/, this.home));
      const scope: SkillScope = isInside(this.options.workspaceRoot, dir) ? 'project' : 'user';
      roots.push({ dir, scope, label: displayDir(dir, this.options.workspaceRoot, this.home) });
    }
    return roots;
  }

  /**
   * Scan every root. Safe to call repeatedly: unchanged skills keep their
   * activation; changed skills drop cached instructions and reload lazily.
   */
  scan(): SkillReloadSummary {
    const previous = this.records;
    const previousRecords = new Map(previous);
    this.records = new Map();
    this.diagnostics = [];
    const at = new Date().toISOString();

    if (!this.options.enabled) {
      this.diagnostics.push({
        level: 'warning',
        scope: 'user',
        path: '(config)',
        message: 'skill discovery is disabled by configuration (skillsSettings.enabled = false)',
      });
      this.lastScanAt = at;
      return {
        at,
        discovered: 0,
        added: [],
        removed: [...previous.keys()],
        changed: [],
        deactivated: [],
      };
    }

    const candidates: SkillRecord[] = [];
    let scanned = 0;
    outer: for (const root of this.roots()) {
      let entries: string[];
      try {
        if (!existsSync(root.dir) || !statSync(root.dir).isDirectory()) continue;
        entries = this.listSkillDirs(root.dir);
      } catch (err) {
        this.diagnostics.push({
          level: 'warning',
          scope: root.scope,
          path: root.label,
          message: `cannot scan skill root: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      for (const dir of entries) {
        if (scanned >= this.options.maxFiles) {
          this.diagnostics.push({
            level: 'warning',
            scope: root.scope,
            path: root.label,
            message: `skill scan cap reached (${this.options.maxFiles} files); remaining skills were not scanned`,
          });
          break outer;
        }
        scanned++;
        const record = this.readSkill(root, dir);
        if (record) candidates.push(record);
      }
    }

    // Conflict resolution: same name from several scopes keeps the highest
    // precedence; every shadowed source is reported, never silently dropped.
    const byName = new Map<string, SkillRecord[]>();
    for (const record of candidates) {
      const list = byName.get(record.skill.name) ?? [];
      list.push(record);
      byName.set(record.skill.name, list);
    }

    const winners = new Map<string, SkillRecord>();
    for (const [name, group] of byName) {
      group.sort(
        (a, b) => SCOPE_RANK[b.root.scope] - SCOPE_RANK[a.root.scope] || a.dir.localeCompare(b.dir),
      );
      const winner = group[0]!;
      const shadowed = group.slice(1);
      if (shadowed.length > 0) {
        winner.skill.conflicts = shadowed.map(
          (shadow) => `${shadow.root.label} (${shadow.root.scope})`,
        );
        for (const shadow of shadowed) {
          this.diagnostics.push({
            level: 'warning',
            scope: shadow.root.scope,
            path: shadow.dir,
            message: `skill "${name}" is shadowed by the ${winner.root.scope} definition at ${winner.root.label}`,
          });
        }
      }

      // Carry activation across scans; keep loaded instructions only when the
      // file is unchanged (otherwise the body reloads lazily on next use).
      const old = previousRecords.get(name);
      if (old && winner.skill.validated) {
        if (old.skill.activated) winner.skill.activated = true;
        if (
          old.bodyLoaded &&
          old.mtimeMs === winner.mtimeMs &&
          old.sizeBytes === winner.sizeBytes
        ) {
          winner.skill.instructions = old.skill.instructions;
          winner.bodyLoaded = true;
        }
      }
      winners.set(name, winner);
    }

    const removed: string[] = [];
    const changed: string[] = [];
    const deactivated: string[] = [];
    for (const [name, old] of previousRecords) {
      const next = winners.get(name);
      if (!next) {
        removed.push(name);
        if (old.skill.activated) {
          deactivated.push(name);
          this.diagnostics.push({
            level: 'warning',
            scope: old.root.scope,
            path: old.dir,
            message: `skill "${name}" was removed or renamed while active; it was deactivated`,
          });
        }
        continue;
      }
      if (next.mtimeMs !== old.mtimeMs || next.sizeBytes !== old.sizeBytes) changed.push(name);
      if (old.skill.activated && !next.skill.validated) {
        next.skill.activated = false;
        deactivated.push(name);
        this.diagnostics.push({
          level: 'error',
          scope: next.root.scope,
          path: next.dir,
          message: `skill "${name}" became invalid on reload and was deactivated: ${next.skill.validationErrors[0] ?? 'unknown error'}`,
        });
      }
    }

    const added = [...winners.keys()].filter((name) => !previousRecords.has(name));
    // Deterministic ordering for listings
    this.records = new Map([...winners.entries()].sort(([a], [b]) => a.localeCompare(b)));
    this.lastScanAt = at;
    return { at, discovered: this.records.size, added, removed, changed, deactivated };
  }

  /** Scan when needed and return the winning catalog (metadata only). */
  catalog(): Skill[] {
    if (this.lastScanAt === null) this.scan();
    return [...this.records.values()].map((record) => record.skill);
  }

  /** Explicit re-scan (used by /skills reload); returns what changed. */
  reload(): SkillReloadSummary {
    return this.scan();
  }

  get(name: string): Skill | undefined {
    if (this.lastScanAt === null) this.scan();
    return this.refresh(name)?.skill;
  }

  /** Validation and conflict diagnostics from the last scan. */
  listDiagnostics(): SkillDiagnostic[] {
    if (this.lastScanAt === null) this.scan();
    return this.diagnostics;
  }

  stats(): SkillManagerStats {
    const skills = this.catalog();
    return {
      roots: this.roots(),
      discovered: skills.length,
      valid: skills.filter((s) => s.validated).length,
      active: skills.filter((s) => s.activated).length,
      diagnostics: this.diagnostics.length,
      lastScanAt: this.lastScanAt,
    };
  }

  // --------------------------------------------------------------------------
  // Activation and lazy loading (§33)
  // --------------------------------------------------------------------------

  activate(name: string): Skill {
    const record = this.refresh(name);
    if (!record)
      throw new Error(`Skill not found: ${name}. Run /skills to list discovered skills.`);
    if (!record.skill.validated) {
      throw new Error(
        `Skill "${name}" is invalid and cannot be activated:\n  - ${record.skill.validationErrors.join('\n  - ')}`,
      );
    }
    record.skill.activated = true;
    return record.skill;
  }

  deactivate(name: string): boolean {
    const record = this.refresh(name);
    if (!record) return false;
    record.skill.activated = false;
    return true;
  }

  activeNames(): string[] {
    this.ensureScanned();
    return [...this.records.values()].filter((r) => r.skill.activated).map((r) => r.skill.name);
  }

  /**
   * Instructions of every activated skill, loaded lazily and capped.
   * A skill that changed on disk invalidates its cached body first.
   */
  promptItems(): SkillPromptItem[] {
    const items: SkillPromptItem[] = [];
    for (const name of this.activeNames()) {
      const record = this.refresh(name);
      if (!record || !record.skill.activated) continue;
      this.ensureBody(record);
      items.push({
        name: record.skill.name,
        description: record.skill.description,
        scope: record.skill.scope,
        trustLevel: record.skill.trustLevel,
        instructions: record.skill.instructions,
        truncated: record.skill.truncated === true,
        references: record.skill.references.map((r) => r.path),
        skillDir: record.dir,
      });
    }
    return items;
  }

  /** Load one referenced file from a skill directory (§33, §34). */
  loadReference(name: string, relPath: string): LoadedReference {
    const record = this.refresh(name);
    if (!record) throw new Error(`Skill not found: ${name}`);
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new Error('A reference path is required');
    }
    if (relPath.includes('\0')) throw new Error('Reference path contains a NUL byte');
    if (isAbsolute(relPath))
      throw new Error('Reference paths must be relative to the skill directory');

    const resolved = resolve(record.dir, relPath);
    if (!isInside(record.dir, resolved)) {
      throw new Error(`Reference path escapes the skill directory: ${relPath}`);
    }

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new Error(`Reference not found: ${relPath}`);
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);

    // Canonical containment: a symlink inside the skill directory must not
    // reach files outside it.
    try {
      const realDir = realpathSync(record.dir);
      const realFile = realpathSync(resolved);
      if (!isInside(realDir, realFile)) {
        throw new Error(`Reference path escapes the skill directory via a symlink: ${relPath}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('escapes the skill directory')) throw err;
      // realpath failures fall through to the bounded read below
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(resolved);
    } catch (err) {
      throw new Error(
        `Cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (looksBinary(buffer)) {
      throw new Error(`Reference is a binary file and cannot be loaded as text: ${relPath}`);
    }

    const truncated = buffer.length > MAX_REFERENCE_BYTES;
    const slice = truncated ? buffer.subarray(0, MAX_REFERENCE_BYTES) : buffer;
    const content = slice.toString('utf8');

    const entry = record.skill.references.find((r) => r.path === relPath.replace(/\\/g, '/'));
    if (entry) {
      entry.loaded = true;
      entry.content = content;
    }

    return { path: relPath.replace(/\\/g, '/'), content, bytes: buffer.length, truncated };
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private ensureScanned(): void {
    if (this.lastScanAt === null) this.scan();
  }

  /** Re-stat a skill and reload its metadata/body when the file changed. */
  private refresh(name: string): SkillRecord | null {
    this.ensureScanned();
    const record = this.records.get(name);
    if (!record) return null;

    let stat;
    try {
      stat = statSync(record.filePath);
    } catch {
      this.drop(name, 'SKILL.md no longer exists');
      return null;
    }
    if (stat.mtimeMs === record.mtimeMs && stat.size === record.sizeBytes) return record;

    const fresh = this.readSkill(record.root, record.dir);
    if (!fresh) {
      this.drop(name, 'SKILL.md could not be re-read');
      return null;
    }
    if (fresh.skill.name !== name) {
      this.drop(name, `SKILL.md now declares the name "${fresh.skill.name}"`);
      return null;
    }
    fresh.skill.activated = record.skill.activated && fresh.skill.validated;
    if (record.skill.activated && !fresh.skill.validated) {
      this.diagnostics.push({
        level: 'error',
        scope: fresh.root.scope,
        path: fresh.dir,
        message: `skill "${name}" changed on disk and became invalid; it was deactivated`,
      });
    }
    this.records.set(name, fresh);
    return fresh;
  }

  private drop(name: string, reason: string): void {
    const record = this.records.get(name);
    this.records.delete(name);
    if (record) {
      this.diagnostics.push({
        level: 'error',
        scope: record.root.scope,
        path: record.dir,
        message: `skill "${name}" was removed from the catalog: ${reason}`,
      });
    }
  }

  private ensureBody(record: SkillRecord): void {
    if (record.bodyLoaded) return;
    const { text } = this.readSkillFile(record.dir);
    const truncated = text.length > MAX_INSTRUCTION_CHARS;
    record.skill.instructions = truncated
      ? `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n\n…[instructions truncated at ${MAX_INSTRUCTION_CHARS} characters]`
      : text;
    record.skill.truncated = truncated;
    record.bodyLoaded = true;
  }

  /** Direct child directories of a root that contain SKILL.md. */
  private listSkillDirs(rootDir: string): string[] {
    if (existsSync(join(rootDir, 'SKILL.md'))) return [rootDir];
    const entries = readdirSync(rootDir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      const dir = join(rootDir, entry.name);
      if (existsSync(join(dir, 'SKILL.md'))) dirs.push(dir);
    }
    return dirs.sort();
  }

  private readSkillFile(dir: string): { text: string; mtimeMs: number; sizeBytes: number } {
    const filePath = join(dir, 'SKILL.md');
    const stats = statSync(filePath);
    const buffer = readFileSync(filePath);
    return {
      text: buffer.toString('utf8'),
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  }

  private readSkill(root: SkillRoot, dir: string): SkillRecord | null {
    const filePath = join(dir, 'SKILL.md');
    let stats;
    let text: string;
    try {
      stats = statSync(filePath);
      if (stats.size > MAX_SKILL_FILE_BYTES) {
        const skill = this.baseSkill(root, dir, basename(dir), '');
        skill.validated = false;
        skill.validationErrors = [
          `SKILL.md is too large: ${stats.size} bytes (cap ${MAX_SKILL_FILE_BYTES})`,
        ];
        this.diagnostics.push({
          level: 'error',
          scope: root.scope,
          path: dir,
          message: skill.validationErrors[0]!,
        });
        return {
          skill,
          root,
          dir,
          filePath,
          mtimeMs: stats.mtimeMs,
          sizeBytes: stats.size,
          bodyLoaded: false,
        };
      }
      text = readFileSync(filePath, 'utf8');
    } catch (err) {
      this.diagnostics.push({
        level: 'error',
        scope: root.scope,
        path: dir,
        message: `cannot read SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }

    const parsed = parseSkillFrontmatter(text);
    const errors = [...parsed.errors];
    const declaredName = parsed.data['name']?.trim() ?? '';
    const dirName = basename(dir);
    const name = declaredName !== '' ? declaredName : dirName;

    if (declaredName === '') {
      errors.push('name is required in the frontmatter');
    } else {
      if (declaredName.length > MAX_NAME_CHARS) {
        errors.push(`name exceeds ${MAX_NAME_CHARS} characters`);
      }
      if (!/^[a-z0-9-]+$/.test(declaredName)) {
        errors.push('name must use lowercase letters, digits, and hyphens only');
      } else {
        if (declaredName.startsWith('-') || declaredName.endsWith('-')) {
          errors.push('name must not start or end with a hyphen');
        }
        if (declaredName.includes('--')) {
          errors.push('name must not contain consecutive hyphens');
        }
      }
      if (declaredName !== dirName) {
        errors.push(`name "${declaredName}" must match the parent directory name "${dirName}"`);
      }
    }

    const description = parsed.data['description'] ?? '';
    if (description.trim() === '') {
      errors.push('description is required in the frontmatter (non-empty)');
    } else if (description.length > MAX_DESCRIPTION_CHARS) {
      errors.push(`description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
    }

    const compatibility = parsed.data['compatibility'];
    if (compatibility !== undefined && compatibility.length > MAX_COMPATIBILITY_CHARS) {
      errors.push(`compatibility exceeds ${MAX_COMPATIBILITY_CHARS} characters`);
    }

    const skill = this.baseSkill(root, dir, name, description);
    const metadata: Record<string, string> = { ...parsed.metadata };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === 'name' || key === 'description') continue;
      metadata[key] = value;
    }
    if (Object.keys(metadata).length > 0) skill.metadata = metadata;

    if (metadata['allowed-tools'] !== undefined) {
      this.diagnostics.push({
        level: 'warning',
        scope: root.scope,
        path: dir,
        message: `skill "${name}" declares "allowed-tools"; the field is recorded but never pre-approves tools in mediaXG`,
      });
    }

    skill.validationErrors = errors;
    skill.validated = errors.length === 0;

    if (skill.validated) {
      skill.references = this.listFiles(join(dir, 'references'), dir).map((path) => ({
        path,
        loaded: false,
      }));
      skill.assets = this.listAssets(dir);
      if (skill.references.length + skill.assets.length >= MAX_LISTED_FILES) {
        this.diagnostics.push({
          level: 'warning',
          scope: root.scope,
          path: dir,
          message: `skill "${name}" lists ${MAX_LISTED_FILES} or more files; the listing was capped`,
        });
      }
    } else {
      this.diagnostics.push({
        level: 'error',
        scope: root.scope,
        path: dir,
        message: `skill "${name}" is invalid: ${errors[0]}`,
      });
    }

    return {
      skill,
      root,
      dir,
      filePath,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      bodyLoaded: false,
    };
  }

  private baseSkill(root: SkillRoot, dir: string, name: string, description: string): Skill {
    return {
      name,
      description,
      path: displayDir(dir, this.options.workspaceRoot, this.home),
      instructions: '',
      references: [],
      assets: [],
      activated: false,
      scope: root.scope,
      trustLevel: this.isTrusted(dir) ? 'trusted' : 'untrusted',
      validated: false,
      validationErrors: [],
      skillDir: dir,
      filePath: join(dir, 'SKILL.md'),
    };
  }

  private isTrusted(dir: string): boolean {
    if (this.options.trustedPaths.length === 0) return false;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      realDir = resolve(dir);
    }
    for (const raw of this.options.trustedPaths) {
      const trusted = resolve(raw.replace(/^~/, this.home));
      let realTrusted: string;
      try {
        realTrusted = existsSync(trusted) ? realpathSync(trusted) : trusted;
      } catch {
        realTrusted = trusted;
      }
      if (isInside(realTrusted, realDir)) return true;
    }
    return false;
  }

  /** Files under `base` (bounded depth), relative POSIX paths, sorted. */
  private listFiles(base: string, skillDir: string, depth = 0): string[] {
    if (depth > MAX_SCAN_DEPTH || !existsSync(base)) return [];
    const out: string[] = [];
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_LISTED_FILES) break;
      const abs = join(base, entry.name);
      if (entry.isDirectory()) {
        out.push(...this.listFiles(abs, skillDir, depth + 1));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!isInside(skillDir, resolve(abs))) continue;
        out.push(relative(skillDir, abs).split(sep).join('/'));
      }
    }
    return out.slice(0, MAX_LISTED_FILES);
  }

  private listAssets(skillDir: string): Skill['assets'] {
    const dirs: Array<{ sub: string; kind: string }> = [
      { sub: 'assets', kind: '' },
      { sub: 'scripts', kind: 'script' },
    ];
    const assets: Skill['assets'] = [];
    for (const { sub, kind } of dirs) {
      for (const rel of this.listFiles(join(skillDir, sub), skillDir)) {
        const abs = join(skillDir, rel);
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          // unreadable entries are listed with size 0
        }
        const ext = rel.includes('.')
          ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
          : 'binary';
        assets.push({ path: rel, type: kind === 'script' ? 'script' : ext, size });
        if (assets.length >= MAX_LISTED_FILES) return assets;
      }
    }
    return assets;
  }
}
