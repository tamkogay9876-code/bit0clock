/**
 * Session manager: JSON persistence with an index for fast listing.
 *
 * Layout:
 *   <dir>/index.json        — lightweight summaries (rebuilt if corrupt)
 *   <dir>/<id>.json         — full session records (versioned)
 *
 * Writes are atomic (tmp file + rename). Corrupted session files are
 * skipped with a warning instead of crashing; the index is rebuilt from
 * the session files when it is missing or damaged.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { resolve, join } from 'path';
import { randomUUID } from 'crypto';
import type { AgentMode } from '../types/index.js';
import {
  SESSION_SCHEMA_VERSION,
  emptyUsage,
  summarize,
  type SessionData,
  type SessionSummary,
} from './types.js';

interface IndexFileShape {
  version: 1;
  sessions: SessionSummary[];
}

export interface SessionManagerOptions {
  directory: string;
  projectPath?: string;
  /** Injected clock for tests */
  now?: () => Date;
  idFactory?: () => string;
}

export class SessionManager {
  readonly directory: string;
  private projectPath: string;
  private now: () => Date;
  private idFactory: () => string;

  constructor(options: SessionManagerOptions) {
    this.directory = options.directory;
    this.projectPath = options.projectPath ?? process.cwd();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) {
      mkdirSync(this.directory, { recursive: true });
    }
  }

  private sessionPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private indexPath(): string {
    return join(this.directory, 'index.json');
  }

  // --------------------------------------------------------------------------
  // Create / load / save
  // --------------------------------------------------------------------------

  create(options: { name?: string; mode?: AgentMode; contextProfile?: string } = {}): SessionData {
    const timestamp = this.now().toISOString();
    const id = this.idFactory();
    const session: SessionData = {
      version: SESSION_SCHEMA_VERSION,
      id,
      name: options.name ?? `Session ${timestamp.slice(0, 16).replace('T', ' ')}`,
      messages: [],
      mode: options.mode ?? 'build',
      reasoning: { effort: 'medium' },
      responseStyle: 'balanced',
      contextProfile: options.contextProfile ?? 'standard',
      usage: emptyUsage(),
      projectPath: this.projectPath,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.save(session);
    return session;
  }

  save(session: SessionData): void {
    this.ensureDirectory();
    session.updatedAt = this.now().toISOString();

    const path = this.sessionPath(session.id);
    const tmpPath = `${path}.tmp`;
    const payload = JSON.stringify({ version: session.version, session }, null, 2);

    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, path); // atomic on POSIX

    this.updateIndexEntry(summarize(session));
  }

  load(id: string): SessionData | null {
    const path = this.sessionPath(id);
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: number; session?: SessionData };
      const session = parsed.session ?? (parsed as unknown as SessionData);

      if (!session || typeof session !== 'object' || !session.id) return null;

      return this.migrate(session);
    } catch {
      return null; // corrupted record: skip, do not crash
    }
  }

  /** Load by exact id, or by unique id prefix. */
  loadByPrefix(prefix: string): SessionData | null {
    const exact = this.load(prefix);
    if (exact) return exact;

    const matches = this.list().filter((s) => s.id.startsWith(prefix));
    if (matches.length === 1) return this.load(matches[0]!.id);
    return null;
  }

  delete(id: string): boolean {
    const path = this.sessionPath(id);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      this.removeIndexEntry(id);
      return true;
    } catch {
      return false;
    }
  }

  rename(id: string, name: string): SessionData | null {
    const session = this.load(id);
    if (!session) return null;
    session.name = name;
    this.save(session);
    return session;
  }

  export(id: string, destination: string): { ok: boolean; message: string; path?: string } {
    const session = this.load(id);
    if (!session) return { ok: false, message: `Session not found: ${id}` };

    try {
      // Exports contain the conversation and metadata only — never credentials.
      const exportPayload = {
        exportedBy: 'mediaXG',
        exportedAt: this.now().toISOString(),
        session,
      };
      writeFileSync(destination, JSON.stringify(exportPayload, null, 2), 'utf-8');
      return { ok: true, message: `Exported to ${destination}`, path: destination };
    } catch (err) {
      return { ok: false, message: `Export failed: ${(err as Error).message}` };
    }
  }

  // --------------------------------------------------------------------------
  // Listing / searching
  // --------------------------------------------------------------------------

  list(): SessionSummary[] {
    const index = this.readIndex();
    if (index) {
      return [...index.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    // Index missing or corrupted: rebuild by scanning session files
    const rebuilt = this.rebuildIndex();
    return [...rebuilt].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  search(query: string): Array<{ session: SessionSummary; matchContext: string }> {
    const q = query.toLowerCase();
    const results: Array<{ session: SessionSummary; matchContext: string }> = [];

    for (const summary of this.list()) {
      const session = this.load(summary.id);
      if (!session) continue;

      if (session.name.toLowerCase().includes(q)) {
        results.push({ session: summary, matchContext: `name: ${session.name}` });
        continue;
      }

      const messageMatch = session.messages.find((m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return text.toLowerCase().includes(q);
      });
      if (messageMatch) {
        const text =
          typeof messageMatch.content === 'string'
            ? messageMatch.content
            : JSON.stringify(messageMatch.content);
        const position = text.toLowerCase().indexOf(q);
        const start = Math.max(0, position - 30);
        results.push({
          session: summary,
          matchContext: `…${text.slice(start, start + 90)}…`,
        });
      }
    }

    return results;
  }

  /** Estimated local spend across sessions updated within a window. */
  spendSince(sinceIso: string): { total: number; currency: string; sessionCount: number } {
    let total = 0;
    let currency = 'USD';
    let count = 0;
    for (const summary of this.list()) {
      if (summary.updatedAt >= sinceIso) {
        total += summary.estimatedCost;
        currency = summary.currency;
        count++;
      }
    }
    return { total, currency, sessionCount: count };
  }

  // --------------------------------------------------------------------------
  // Index handling
  // --------------------------------------------------------------------------

  private readIndex(): IndexFileShape | null {
    const path = this.indexPath();
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as IndexFileShape;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) return parsed;
    } catch {
      // corruption handled by caller (rebuild)
    }
    return null;
  }

  private writeIndex(sessions: SessionSummary[]): void {
    const path = this.indexPath();
    const tmpPath = `${path}.tmp`;
    const payload: IndexFileShape = { version: 1, sessions };
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmpPath, path);
  }

  private updateIndexEntry(summary: SessionSummary): void {
    const index = this.readIndex() ?? { version: 1 as const, sessions: [] };
    const existing = index.sessions.findIndex((s) => s.id === summary.id);
    if (existing >= 0) {
      index.sessions[existing] = summary;
    } else {
      index.sessions.push(summary);
    }
    this.writeIndex(index.sessions);
  }

  private removeIndexEntry(id: string): void {
    const index = this.readIndex();
    if (!index) return;
    index.sessions = index.sessions.filter((s) => s.id !== id);
    this.writeIndex(index.sessions);
  }

  /** Scan session files and rebuild the index from scratch. */
  rebuildIndex(): SessionSummary[] {
    this.ensureDirectory();
    const summaries: SessionSummary[] = [];

    let entries: string[] = [];
    try {
      entries = readdirSync(this.directory);
    } catch {
      return summaries;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'index.json' || entry.endsWith('.tmp')) continue;
      const id = entry.slice(0, -'.json'.length);
      const session = this.load(id);
      if (session) summaries.push(summarize(session));
    }

    this.writeIndex(summaries);
    return summaries;
  }

  // --------------------------------------------------------------------------
  // Migration
  // --------------------------------------------------------------------------

  /**
   * Migrate older session records to the current schema version.
   * v1 → v2 is additive (plan, changeLedger, toolHistory, permissionAudit).
   */
  private migrate(session: SessionData): SessionData {
    const originalVersion = typeof session.version === 'number' ? session.version : 1;

    // Defensive defaults for records written by early versions
    session.usage ??= emptyUsage();
    session.usage.estimatedInputTokens ??= 0;
    session.reasoning ??= { effort: 'medium' };
    session.responseStyle ??= 'balanced';
    session.contextProfile ??= 'standard';
    session.messages ??= [];
    session.summaries ??= [];
    session.compactedChunks ??= [];
    session.pinnedPaths ??= [];

    if (originalVersion < SESSION_SCHEMA_VERSION) {
      session.changeLedger ??= [];
      session.toolHistory ??= [];
      session.permissionAudit ??= [];
      session.plan ??= null;
    }

    session.version = SESSION_SCHEMA_VERSION;
    return session;
  }
}
