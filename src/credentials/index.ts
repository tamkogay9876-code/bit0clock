/**
 * Credential abstraction.
 *
 * Resolution order for a credential reference:
 *  1. Environment variable with the same name (recommended for CI/servers)
 *  2. File store (~/.config/mediaxg/credentials.json, chmod 600)
 *
 * OS keychain integration (macOS `security`, Linux `secret-tool`) is added in
 * Phase F. The file store is a documented fallback — it is NOT presented as
 * secure storage; its permissions and limitations are documented in README.
 *
 * Secrets are never logged, never placed in URLs, and never exported in
 * session files. `maskSecret()` produces safe display strings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ============================================================================
// Store interface
// ============================================================================

export interface CredentialStore {
  readonly name: string;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<boolean>;
  /** Names only — never values */
  list(): Promise<string[]>;
}

// ============================================================================
// Environment store
// ============================================================================

export class EnvCredentialStore implements CredentialStore {
  readonly name = 'env';

  async get(ref: string): Promise<string | undefined> {
    const value = process.env[ref];
    return value && value.length > 0 ? value : undefined;
  }

  async set(): Promise<void> {
    throw new Error('Environment variables cannot be modified by mediaXG');
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async list(): Promise<string[]> {
    return [];
  }
}

// ============================================================================
// File store (documented fallback)
// ============================================================================

interface FileStoreShape {
  version: 1;
  credentials: Record<string, string>;
}

export class FileCredentialStore implements CredentialStore {
  readonly name = 'file';
  private readonly path: string;
  private cache: FileStoreShape | null = null;

  constructor(path?: string) {
    this.path = path ?? resolve(homedir(), '.config/mediaxg/credentials.json');
  }

  private load(): FileStoreShape {
    if (this.cache) return this.cache;

    if (!existsSync(this.path)) {
      this.cache = { version: 1, credentials: {} };
      return this.cache;
    }

    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as FileStoreShape;
      if (parsed && typeof parsed === 'object' && parsed.credentials) {
        this.cache = parsed;
      } else {
        this.cache = { version: 1, credentials: {} };
      }
    } catch {
      // Corrupted file: treat as empty rather than destroying it
      this.cache = { version: 1, credentials: {} };
    }
    return this.cache;
  }

  private persist(): void {
    if (!this.cache) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.path, JSON.stringify(this.cache, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best effort (e.g. filesystems without POSIX permissions)
    }
  }

  /** True when file permissions are known to be restrictive */
  hasRestrictivePermissions(): boolean {
    try {
      const mode = statSync(this.path).mode & 0o777;
      return (mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  async get(ref: string): Promise<string | undefined> {
    const store = this.load();
    return store.credentials[ref];
  }

  async set(ref: string, value: string): Promise<void> {
    const store = this.load();
    store.credentials[ref] = value;
    this.persist();
  }

  async delete(ref: string): Promise<boolean> {
    const store = this.load();
    if (!(ref in store.credentials)) return false;
    delete store.credentials[ref];
    this.persist();
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(this.load().credentials);
  }
}

// ============================================================================
// Chain store
// ============================================================================

export class ChainCredentialStore implements CredentialStore {
  readonly name = 'chain';
  private stores: CredentialStore[];

  constructor(stores: CredentialStore[]) {
    this.stores = stores;
  }

  async get(ref: string): Promise<string | undefined> {
    for (const store of this.stores) {
      const value = await store.get(ref);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async set(ref: string, value: string): Promise<void> {
    // Write to the last store that supports writes (file fallback)
    for (const store of this.stores) {
      try {
        await store.set(ref, value);
        return;
      } catch {
        continue;
      }
    }
    throw new Error('No writable credential store available');
  }

  async delete(ref: string): Promise<boolean> {
    let deleted = false;
    for (const store of this.stores) {
      try {
        if (await store.delete(ref)) deleted = true;
      } catch {
        continue;
      }
    }
    return deleted;
  }

  async list(): Promise<string[]> {
    const names = new Set<string>();
    for (const store of this.stores) {
      for (const name of await store.list()) names.add(name);
    }
    return [...names];
  }
}

// ============================================================================
// Default store factory
// ============================================================================

let defaultStore: CredentialStore | null = null;

export function createDefaultCredentialStore(filePath?: string): CredentialStore {
  return new ChainCredentialStore([new EnvCredentialStore(), new FileCredentialStore(filePath)]);
}

export function getCredentialStore(): CredentialStore {
  if (!defaultStore) {
    defaultStore = createDefaultCredentialStore();
  }
  return defaultStore;
}

/** For tests: replace the process-wide default store */
export function setCredentialStoreForTesting(store: CredentialStore | null): void {
  defaultStore = store;
}

// ============================================================================
// Helpers
// ============================================================================

/** Mask a secret for display: never reveals more than the last 4 chars. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

/** Describe credential status without exposing the value. */
export function describeCredential(value: string | undefined): string {
  if (value === undefined) return 'not set';
  return `set (${maskSecret(value)})`;
}
