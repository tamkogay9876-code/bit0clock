/**
 * Minimal zod → JSON Schema conversion for tool input schemas (§40).
 *
 * Covers exactly the subset used by native tools: objects, strings, numbers,
 * booleans, enums, literals, arrays, optionals, defaults, and refinements.
 * Unknown constructs are represented permissively rather than guessed.
 */

import { z } from 'zod';

function descriptionOf(schema: z.ZodTypeAny): string | undefined {
  const withDescription = schema as { description?: string };
  return withDescription.description ?? schema._def.description;
}

function isOptionalLike(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return true;
  if (schema instanceof z.ZodEffects) return isOptionalLike(schema.innerType());
  return false;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  // Unwrap wrappers that must not appear in the emitted schema
  for (let i = 0; i < 10; i++) {
    if (current instanceof z.ZodOptional) current = current.unwrap();
    else if (current instanceof z.ZodDefault) current = current._def.innerType as z.ZodTypeAny;
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else break;
  }
  return current;
}

function numberChecks(schema: z.ZodNumber): Record<string, unknown> {
  const checks: Record<string, unknown> = {};
  for (const check of schema._def.checks) {
    if (check.kind === 'min') checks.minimum = check.value;
    if (check.kind === 'max') checks.maximum = check.value;
    if (check.kind === 'int') checks.type = 'integer';
  }
  return checks;
}

function stringChecks(schema: z.ZodString, base: Record<string, unknown>): void {
  for (const check of schema._def.checks) {
    if (check.kind === 'min') base.minLength = check.value;
    if (check.kind === 'max') base.maxLength = check.value;
    if (check.kind === 'regex') base.pattern = String(check.regex);
  }
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const target = unwrap(schema);
  const description = descriptionOf(schema) ?? descriptionOf(target);

  const finish = (json: Record<string, unknown>): Record<string, unknown> => {
    if (description) json.description = description;
    return json;
  };

  if (target instanceof z.ZodObject) {
    const shape = target.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!isOptionalLike(value)) required.push(key);
    }
    const json: Record<string, unknown> = { type: 'object', properties };
    // strict()/passthrough() models: reflect unknown-key policy
    const unknownKeys = target._def.unknownKeys;
    if (unknownKeys === 'strict') json.additionalProperties = false;
    if (required.length > 0) json.required = required;
    return finish(json);
  }

  if (target instanceof z.ZodString) {
    const json: Record<string, unknown> = { type: 'string' };
    stringChecks(target, json);
    return finish(json);
  }

  if (target instanceof z.ZodNumber) {
    const json: Record<string, unknown> = { type: 'number', ...numberChecks(target) };
    return finish(json);
  }

  if (target instanceof z.ZodBoolean) {
    return finish({ type: 'boolean' });
  }

  if (target instanceof z.ZodEnum) {
    return finish({ type: 'string', enum: [...target.options] });
  }

  if (target instanceof z.ZodLiteral) {
    const value = target.value;
    const json: Record<string, unknown> = { const: value };
    json.type =
      typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    return finish(json);
  }

  if (target instanceof z.ZodArray) {
    return finish({
      type: 'array',
      items: zodToJsonSchema(target.element as z.ZodTypeAny),
    });
  }

  if (target instanceof z.ZodUnion) {
    const options = target.options as z.ZodTypeAny[];
    return finish({ anyOf: options.map((option) => zodToJsonSchema(option)) });
  }

  // Unknown construct: permissive, never wrong
  return finish({});
}

/** Convert a registry of tools into provider tool schemas. */
export function toProviderToolSchema(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
