/** Persistent project memory types (§48). */

export type MemoryCategory =
  | 'architecture'
  | 'module'
  | 'convention'
  | 'decision'
  | 'build'
  | 'defect'
  | 'preference'
  | 'state';

export type MemoryKind = 'fact' | 'inference';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  kind: MemoryKind;
  content: string;
  provenance: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStore {
  version: number;
  entries: MemoryEntry[];
}

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'architecture',
  'module',
  'convention',
  'decision',
  'build',
  'defect',
  'preference',
  'state',
];

export const MEMORY_STORE_VERSION = 1;
export const MAX_MEMORY_ENTRIES = 200;
export const MAX_MEMORY_TOTAL_BYTES = 64 * 1024;
export const MAX_MEMORY_ENTRY_BYTES = 4 * 1024;
export const MEMORY_PROMPT_CAP_BYTES = 4 * 1024;
