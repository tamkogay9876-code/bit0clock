/**
 * URL composition tests - /v1 duplication avoidance
 */

import { describe, it, expect } from 'bun:test';
import { composeEndpoint, withQuery } from './url.js';

describe('composeEndpoint', () => {
  it('appends path to bare host', () => {
    expect(composeEndpoint('https://api.xkiro.com', '/v1/chat/completions')).toBe(
      'https://api.xkiro.com/v1/chat/completions',
    );
  });

  it('avoids duplicating /v1 when base URL already has it', () => {
    expect(composeEndpoint('https://api.xkiro.com/v1', '/v1/chat/completions')).toBe(
      'https://api.xkiro.com/v1/chat/completions',
    );
  });

  it('avoids duplicating /v1 for nested gateway paths', () => {
    expect(composeEndpoint('https://gateway.example.com/openai/v1', '/v1/models')).toBe(
      'https://gateway.example.com/openai/v1/models',
    );
  });

  it('handles trailing slashes in base URL', () => {
    expect(composeEndpoint('https://api.example.com/v1/', '/v1/models')).toBe(
      'https://api.example.com/v1/models',
    );
  });

  it('adds missing leading slash to path', () => {
    expect(composeEndpoint('https://api.example.com', 'v1/models')).toBe(
      'https://api.example.com/v1/models',
    );
  });

  it('does not touch non-version paths', () => {
    expect(composeEndpoint('https://api.anthropic.com', '/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
  });

  it('does not strip /v1 from the middle of base path', () => {
    expect(composeEndpoint('https://example.com/v1/proxy', '/v1/models')).toBe(
      'https://example.com/v1/proxy/v1/models',
    );
  });
});

describe('withQuery', () => {
  it('appends query parameters', () => {
    expect(withQuery('https://api.example.com/models', { limit: 100 })).toBe(
      'https://api.example.com/models?limit=100',
    );
  });

  it('skips undefined values', () => {
    expect(withQuery('https://api.example.com/models', { limit: 100, after_id: undefined })).toBe(
      'https://api.example.com/models?limit=100',
    );
  });

  it('merges with existing query string', () => {
    expect(withQuery('https://api.example.com/models?x=1', { y: 2 })).toBe(
      'https://api.example.com/models?x=1&y=2',
    );
  });

  it('returns url unchanged with empty params', () => {
    expect(withQuery('https://api.example.com/models', {})).toBe('https://api.example.com/models');
  });
});
