/**
 * Tests for utility functions
 */

import { describe, it, expect } from 'bun:test';
import {
  generateId,
  normalizePath,
  isPathSafe,
  ensureWithinWorkspace,
  estimateTokens,
  truncate,
  formatBytes,
  formatDuration,
  parseModelIdentifier,
  parseContextValue,
  chunk,
  unique,
  isValidIdentifier,
} from './index.js';

describe('Utils', () => {
  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
      expect(id1.length).toBe(36);
    });
  });

  describe('path safety', () => {
    it('should allow paths within workspace', () => {
      expect(isPathSafe('/workspace', '/workspace/src/file.ts')).toBe(true);
    });

    it('should reject paths outside workspace', () => {
      expect(isPathSafe('/workspace', '/etc/passwd')).toBe(false);
    });

    it('should reject path traversal', () => {
      expect(isPathSafe('/workspace', '/workspace/../etc/passwd')).toBe(false);
    });

    it('should ensure path is within workspace', () => {
      const result = ensureWithinWorkspace('/workspace', '/workspace/src/file.ts');
      expect(result).toContain('src/file.ts');
    });

    it('should throw on path traversal', () => {
      expect(() => ensureWithinWorkspace('/workspace', '/etc/passwd')).toThrow();
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens for text', () => {
      const text = 'Hello, world! This is a test.';
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty text', () => {
      expect(estimateTokens('')).toBe(0);
    });
  });

  describe('string utilities', () => {
    it('should truncate long strings', () => {
      const result = truncate('Hello, world!', 8);
      expect(result).toBe('Hello...');
    });

    it('should not truncate short strings', () => {
      const result = truncate('Hello', 10);
      expect(result).toBe('Hello');
    });
  });

  describe('formatting', () => {
    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
      expect(formatBytes(2048)).toBe('2.0 KB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('should format duration', () => {
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(5000)).toBe('5.0s');
      expect(formatDuration(120000)).toBe('2m 0s');
    });
  });

  describe('parsing', () => {
    it('should parse model identifier with provider', () => {
      const result = parseModelIdentifier('openai/gpt-4');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4');
    });

    it('should parse model identifier without provider', () => {
      const result = parseModelIdentifier('gpt-4');
      expect(result.provider).toBeUndefined();
      expect(result.model).toBe('gpt-4');
    });

    it('should parse context value with k suffix', () => {
      expect(parseContextValue('128k')).toBe(128000);
    });

    it('should parse context value with m suffix', () => {
      expect(parseContextValue('5m')).toBe(5000000);
    });

    it('should parse plain number', () => {
      expect(parseContextValue('10000')).toBe(10000);
    });

    it('should throw on invalid context value', () => {
      expect(() => parseContextValue('invalid')).toThrow();
    });
  });

  describe('collections', () => {
    it('should chunk array', () => {
      const result = chunk([1, 2, 3, 4, 5], 2);
      expect(result).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('should get unique values', () => {
      expect(unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
    });
  });

  describe('validation', () => {
    it('should validate identifiers', () => {
      expect(isValidIdentifier('valid-id_123')).toBe(true);
      expect(isValidIdentifier('invalid id')).toBe(false);
      expect(isValidIdentifier('invalid.id')).toBe(false);
    });
  });
});
