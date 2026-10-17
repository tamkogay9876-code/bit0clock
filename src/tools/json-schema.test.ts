/**
 * zod → JSON Schema conversion tests (§40).
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { zodToJsonSchema, toProviderToolSchema } from './json-schema.js';

describe('zodToJsonSchema', () => {
  it('converts objects with required and optional fields', () => {
    const schema = z.object({
      path: z.string().min(1).describe('File path'),
      limit: z.number().int().min(1).max(200).optional(),
    });
    const json = zodToJsonSchema(schema) as Record<string, any>;

    expect(json.type).toBe('object');
    expect(json.required).toEqual(['path']);
    expect(json.properties.path).toEqual({
      type: 'string',
      minLength: 1,
      description: 'File path',
    });
    expect(json.properties.limit).toEqual({ type: 'integer', minimum: 1, maximum: 200 });
  });

  it('converts enums, literals, arrays, and unions', () => {
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(zodToJsonSchema(z.literal(7))).toEqual({ type: 'number', const: 7 });
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('unwraps defaults and refinements and excludes them from required', () => {
    const schema = z.object({
      mode: z.string().default('fast'),
      count: z.number().refine((n) => n > 0),
    });
    const json = zodToJsonSchema(schema) as Record<string, any>;

    expect(json.required).toEqual(['count']);
    expect(json.properties.mode).toEqual({ type: 'string' });
    expect(json.properties.count).toEqual({ type: 'number' });
  });

  it('marks strict objects with additionalProperties false', () => {
    const json = zodToJsonSchema(z.object({ a: z.string() }).strict()) as Record<string, any>;
    expect(json.additionalProperties).toBe(false);
  });

  it('degrades unknown constructs permissively', () => {
    expect(zodToJsonSchema(z.any())).toEqual({});
  });
});

describe('toProviderToolSchema', () => {
  it('passes name, description, and input schema through', () => {
    const result = toProviderToolSchema({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object' },
    });
    expect(result).toEqual({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object' },
    });
  });
});
