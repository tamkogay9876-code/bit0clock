import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_ENTRY_BYTES,
  MAX_MEMORY_TOTAL_BYTES,
  MEMORY_CATEGORIES,
  MEMORY_PROMPT_CAP_BYTES,
  MEMORY_STORE_VERSION,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStore,
} from './types.js';

const SECRET_REDACTION = [
  /(api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|bearer|password|secret|credential)['":\s]+['"]?([a-zA-Z0-9_\-]{16,})['"]?/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_REDACTION) {
    out = out.replace(pattern, (match) => {
      const parts = match.match(/^([^'":\s]+)['":\s]+/);
      if (parts) return `${parts[1]}=[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

function isCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export interface AddMemoryInput {
  category: MemoryCategory;
  kind: MemoryKind;
  content: string;
  provenance?: string;
}

export class MemoryManager {
  private readonly path: string;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(options: { projectPath: string; global?: boolean }) {
    const base = options.global
      ? join(process.env['HOME'] ?? '', '.config/mediaxg')
      : join(options.projectPath, '.mediaxg');
    this.path = join(base, 'memory.json');
  }

  /** Path on disk (exposed for tests/diagnostics). */
  get filePath(): string {
    return this.path;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) {
      this.entries = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<MemoryStore>;
      if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries
          .filter(
            (entry) => entry && typeof entry.id === 'string' && typeof entry.content === 'string',
          )
          .map((entry) => ({
            id: String(entry.id),
            category: isCategory(String(entry.category))
              ? (entry.category as MemoryCategory)
              : 'state',
            kind: entry.kind === 'inference' ? 'inference' : 'fact',
            content: redact(String(entry.content)),
            provenance: typeof entry.provenance === 'string' ? entry.provenance : 'unknown',
            createdAt:
              typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
            updatedAt:
              typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
          }));
      }
    } catch {
      // Corrupt file: start empty, never crash the app
      this.entries = [];
    }
  }

  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    const payload: MemoryStore = { version: MEMORY_STORE_VERSION, entries: this.entries };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmp, this.path);
  }

  list(): MemoryEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  get(id: string): MemoryEntry | undefined {
    this.ensureLoaded();
    return this.entries.find((entry) => entry.id === id);
  }

  search(query: string): MemoryEntry[] {
    this.ensureLoaded();
    const needle = query.trim().toLowerCase();
    if (needle === '') return [...this.entries];
    return this.entries.filter(
      (entry) =>
        entry.content.toLowerCase().includes(needle) ||
        entry.category.toLowerCase().includes(needle) ||
        entry.provenance.toLowerCase().includes(needle),
    );
  }

  add(input: AddMemoryInput): MemoryEntry {
    this.ensureLoaded();
    const content = redact(input.content.trim());
    if (content === '') throw new Error('Memory content must not be empty.');
    if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_ENTRY_BYTES) {
      throw new Error(`Memory entry exceeds ${MAX_MEMORY_ENTRY_BYTES} bytes.`);
    }
    if (this.entries.length >= MAX_MEMORY_ENTRIES) {
      throw new Error(
        `Memory store is full (${MAX_MEMORY_ENTRIES} entries). Remove entries first.`,
      );
    }
    const total = this.entries.reduce(
      (sum, entry) => sum + Buffer.byteLength(entry.content, 'utf8'),
      0,
    );
    if (total + Buffer.byteLength(content, 'utf8') > MAX_MEMORY_TOTAL_BYTES) {
      throw new Error('Memory store exceeds its total size cap. Remove entries first.');
    }

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      category: input.category,
      kind: input.kind,
      content,
      provenance: (input.provenance ?? 'user').trim() || 'user',
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.persist();
    return true;
  }

  clear(): number {
    this.ensureLoaded();
    const count = this.entries.length;
    this.entries = [];
    this.persist();
    return count;
  }

  /** Bounded text block for system-prompt injection (facts first, then inferences). */
  toPromptBlock(maxBytes = MEMORY_PROMPT_CAP_BYTES): string | undefined {
    this.ensureLoaded();
    if (this.entries.length === 0) return undefined;
    const ordered = [...this.entries].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'fact' ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const lines: string[] = [];
    let used = 0;
    for (const entry of ordered) {
      const line = `- [${entry.kind}] (${entry.category}) ${entry.content} — provenance: ${entry.provenance}`;
      const cost = Buffer.byteLength(line, 'utf8') + 1;
      if (used + cost > maxBytes) break;
      lines.push(line);
      used += cost;
    }
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  }

  stats(): { entries: number; facts: number; inferences: number; bytes: number } {
    this.ensureLoaded();
    return {
      entries: this.entries.length,
      facts: this.entries.filter((entry) => entry.kind === 'fact').length,
      inferences: this.entries.filter((entry) => entry.kind === 'inference').length,
      bytes: this.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.content, 'utf8'), 0),
    };
  }
}
