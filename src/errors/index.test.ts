/**
 * Tests for error handling
 */

import { describe, it, expect } from 'bun:test';
import {
  MediaXGError,
  authError,
  invalidModelError,
  rateLimitError,
  normalizeError,
  formatError,
  isRetryable,
  getRetryAfter,
} from './index.js';

describe('Errors', () => {
  describe('MediaXGError', () => {
    it('should create error with all properties', () => {
      const error = new MediaXGError({
        category: 'authentication',
        message: 'Auth failed',
        provider: 'openai',
        model: 'gpt-4',
        retryable: false,
      });

      expect(error.category).toBe('authentication');
      expect(error.message).toBe('Auth failed');
      expect(error.provider).toBe('openai');
      expect(error.model).toBe('gpt-4');
      expect(error.retryable).toBe(false);
    });

    it('should serialize to JSON', () => {
      const error = authError('Invalid key', 'openai');
      const json = error.toJSON();
      expect(json.category).toBe('authentication');
      expect(json.message).toBe('Invalid key');
    });
  });

  describe('error factories', () => {
    it('should create auth error', () => {
      const error = authError('Invalid API key', 'anthropic');
      expect(error.category).toBe('authentication');
      expect(error.provider).toBe('anthropic');
      expect(error.retryable).toBe(false);
    });

    it('should create rate limit error with retry', () => {
      const error = rateLimitError('Too many requests', 'openai', 5000);
      expect(error.category).toBe('rate-limit');
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBe(5000);
    });

    it('should create invalid model error', () => {
      const error = invalidModelError('Model not found', 'openai', 'gpt-4');
      expect(error.category).toBe('invalid-model');
      expect(error.model).toBe('gpt-4');
    });
  });

  describe('normalizeError', () => {
    it('should pass through MediaXGError', () => {
      const original = authError('test');
      const normalized = normalizeError(original);
      expect(normalized).toBe(original);
    });

    it('should normalize auth errors', () => {
      const error = new Error('401 Unauthorized');
      const normalized = normalizeError(error, { provider: 'openai' });
      expect(normalized.category).toBe('authentication');
    });

    it('should normalize rate limit errors', () => {
      const error = new Error('429 Too Many Requests');
      const normalized = normalizeError(error, { provider: 'openai' });
      expect(normalized.category).toBe('rate-limit');
      expect(normalized.retryable).toBe(true);
    });

    it('should normalize network errors', () => {
      const error = new Error('ECONNREFUSED');
      const normalized = normalizeError(error);
      expect(normalized.category).toBe('network');
      expect(normalized.retryable).toBe(true);
    });

    it('should handle unknown errors', () => {
      const normalized = normalizeError('string error');
      expect(normalized.category).toBe('unknown');
    });
  });

  describe('formatError', () => {
    it('should format MediaXGError', () => {
      const error = authError('Invalid key', 'openai');
      const formatted = formatError(error);
      expect(formatted).toContain('authentication');
      expect(formatted).toContain('openai');
      expect(formatted).toContain('Invalid key');
    });

    it('should format regular Error', () => {
      const formatted = formatError(new Error('Something went wrong'));
      expect(formatted).toBe('Something went wrong');
    });

    it('should format string', () => {
      const formatted = formatError('error string');
      expect(formatted).toBe('error string');
    });
  });

  describe('retry utilities', () => {
    it('should identify retryable errors', () => {
      const error = rateLimitError('rate limited', 'openai', 1000);
      expect(isRetryable(error)).toBe(true);
    });

    it('should identify non-retryable errors', () => {
      const error = authError('invalid key', 'openai');
      expect(isRetryable(error)).toBe(false);
    });

    it('should get retry delay', () => {
      const error = rateLimitError('rate limited', 'openai', 5000);
      expect(getRetryAfter(error)).toBe(5000);
    });

    it('should return default retry delay', () => {
      const error = new MediaXGError({ category: 'unknown', message: 'test', retryable: true });
      expect(getRetryAfter(error)).toBe(1000);
    });
  });
});
