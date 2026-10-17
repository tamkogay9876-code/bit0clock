/**
 * Credential store tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  EnvCredentialStore,
  FileCredentialStore,
  ChainCredentialStore,
  maskSecret,
  describeCredential,
} from './index.js';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('credentials', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mediaxg-cred-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('EnvCredentialStore', () => {
    it('reads environment variables', async () => {
      process.env['MEDIAXG_TEST_KEY'] = 'env-secret-value';
      const store = new EnvCredentialStore();
      expect(await store.get('MEDIAXG_TEST_KEY')).toBe('env-secret-value');
      delete process.env['MEDIAXG_TEST_KEY'];
    });

    it('returns undefined for missing variables', async () => {
      const store = new EnvCredentialStore();
      expect(await store.get('DEFINITELY_NOT_SET_XYZ')).toBeUndefined();
    });

    it('ignores empty variables', async () => {
      process.env['MEDIAXG_EMPTY_KEY'] = '';
      const store = new EnvCredentialStore();
      expect(await store.get('MEDIAXG_EMPTY_KEY')).toBeUndefined();
      delete process.env['MEDIAXG_EMPTY_KEY'];
    });
  });

  describe('FileCredentialStore', () => {
    it('stores and retrieves credentials', async () => {
      const store = new FileCredentialStore(join(tempDir, 'creds.json'));
      await store.set('mykey', 'my-secret');
      expect(await store.get('mykey')).toBe('my-secret');
      expect(await store.list()).toEqual(['mykey']);
    });

    it('creates the file with restrictive permissions', async () => {
      const path = join(tempDir, 'creds.json');
      const store = new FileCredentialStore(path);
      await store.set('k', 'v');
      const mode = statSync(path).mode & 0o777;
      expect(mode & 0o077).toBe(0); // no group/other access
    });

    it('deletes credentials', async () => {
      const store = new FileCredentialStore(join(tempDir, 'creds.json'));
      await store.set('k', 'v');
      expect(await store.delete('k')).toBe(true);
      expect(await store.get('k')).toBeUndefined();
    });

    it('survives corrupted files without destroying them', async () => {
      const path = join(tempDir, 'creds.json');
      const { writeFileSync } = await import('fs');
      writeFileSync(path, 'NOT JSON AT ALL');
      const store = new FileCredentialStore(path);
      expect(await store.get('anything')).toBeUndefined();
    });
  });

  describe('ChainCredentialStore', () => {
    it('prefers env over file', async () => {
      process.env['MEDIAXG_CHAIN_KEY'] = 'from-env';
      const fileStore = new FileCredentialStore(join(tempDir, 'creds.json'));
      await fileStore.set('MEDIAXG_CHAIN_KEY', 'from-file');

      const chain = new ChainCredentialStore([new EnvCredentialStore(), fileStore]);
      expect(await chain.get('MEDIAXG_CHAIN_KEY')).toBe('from-env');

      delete process.env['MEDIAXG_CHAIN_KEY'];
      expect(await chain.get('MEDIAXG_CHAIN_KEY')).toBe('from-file');
    });

    it('writes to the writable store', async () => {
      const fileStore = new FileCredentialStore(join(tempDir, 'creds.json'));
      const chain = new ChainCredentialStore([new EnvCredentialStore(), fileStore]);
      await chain.set('newkey', 'newvalue');
      expect(await fileStore.get('newkey')).toBe('newvalue');
    });

    it('lists names from all stores', async () => {
      const fileStore = new FileCredentialStore(join(tempDir, 'creds.json'));
      await fileStore.set('file-key', 'v');
      const chain = new ChainCredentialStore([new EnvCredentialStore(), fileStore]);
      await chain.set('another', 'v');
      const names = await chain.list();
      expect(names).toContain('file-key');
      expect(names).toContain('another');
    });
  });

  describe('masking', () => {
    it('masks secrets keeping only the last 4 characters', () => {
      const masked = maskSecret('sk-1234567890abcdef');
      expect(masked.endsWith('cdef')).toBe(true);
      expect(masked).not.toContain('1234567890');
    });

    it('fully masks short secrets', () => {
      expect(maskSecret('abc')).toBe('****');
    });

    it('describes credential status without exposing values', () => {
      expect(describeCredential(undefined)).toBe('not set');
      const description = describeCredential('sk-secret-value-1234');
      expect(description).toContain('set');
      expect(description).not.toContain('secret-value');
    });
  });
});
