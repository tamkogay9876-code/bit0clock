/**
 * Native tool registry types (§40).
 *
 * Every tool declares its input schema (zod), permission class, timeout,
 * output budget, and error semantics. The LLM never gets direct filesystem
 * or shell access: it can only ask for a named tool with validated arguments,
 * and every execution passes the workspace guard, validation, and the
 * permission engine before it runs.
 */

import type { z } from 'zod';
import type { PermissionClass } from '../types/index.js';
import { zodToJsonSchema } from './json-schema.js';

// ============================================================================
// Errors and results
// ============================================================================

export type ToolErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'outside-workspace'
  | 'sensitive-path'
  | 'conflict'
  | 'unsupported'
  | 'io-error'
  | 'timeout'
  | 'denied'
  | 'tool-error';

/** A clean, model-facing tool failure. Never leaks stack traces. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint?: string;

  constructor(message: string, options: { code?: ToolErrorCode; hint?: string } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = options.code ?? 'tool-error';
    if (options.hint) this.hint = options.hint;
  }

  /** Message plus optional actionable hint, as shown to the model. */
  toDisplayMessage(): string {
    return this.hint ? `${this.message}\nHint: ${this.hint}` : this.message;
  }
}

/** What a tool implementation returns (duration is added by the wrapper). */
export interface ToolOutput {
  content: string;
  isError: boolean;
  meta?: Record<string, unknown>;
}

export function toolOk(content: string, meta?: Record<string, unknown>): ToolOutput {
  const output: ToolOutput = { content, isError: false };
  if (meta) output.meta = meta;
  return output;
}

export function toolFail(content: string, meta?: Record<string, unknown>): ToolOutput {
  const output: ToolOutput = { content, isError: true };
  if (meta) output.meta = meta;
  return output;
}

/** The final result handed back to the agent loop and persisted. */
export interface ToolExecResult {
  isError: boolean;
  content: string;
  durationMs: number;
  meta?: Record<string, unknown>;
}

// ============================================================================
// Execution context
// ============================================================================

export interface ToolExecContext {
  /** Canonical workspace root (all paths must resolve inside it) */
  workspaceRoot: string;
  /** Cancellation from Esc / Ctrl+C; process tools kill their children */
  signal?: AbortSignal;
  /** Time budget for this execution (clamped by the loop from config) */
  timeoutMs: number;
  /** Extra environment for process tools (defaults to process.env) */
  env?: Record<string, string>;
}

// ============================================================================
// Tool definition
// ============================================================================

export interface ToolSpec<TArgs> {
  /** Unique tool name as exposed to the model */
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  permissionClass: PermissionClass;
  /** True when the tool can change workspace or repository state */
  mutating: boolean;
  /** True when the effect cannot be automatically reversed */
  destructive?: boolean;
  timeoutMs: number;
  /** Max characters of result content returned to the model */
  outputBudget: number;
  /**
   * Optional per-call permission class override. Used by run_command to
   * classify read-only commands (`git status`) differently from consequential
   * ones; defaults to `permissionClass`.
   */
  dynamicPermissionClass?(args: TArgs): PermissionClass;
  /** One-line description of what this specific call will do (permission prompts) */
  summarize(args: TArgs): string;
  execute(args: TArgs, ctx: ToolExecContext): Promise<ToolOutput> | ToolOutput;
}

/** Registry-facing tool: schema converted, arguments pre-validated. */
export interface RegisteredTool {
  name: string;
  description: string;
  permissionClass: PermissionClass;
  mutating: boolean;
  destructive: boolean;
  timeoutMs: number;
  outputBudget: number;
  /** JSON Schema sent to providers */
  inputSchema: Record<string, unknown>;
  /**
   * Validate raw model-supplied arguments before anything else happens.
   * Native tools validate against their zod schema; external tools (MCP, §38)
   * validate against the schema the server advertised.
   */
  validateArgs(raw: Record<string, unknown>): ToolArgValidation;
  /** Best-effort human summary for prompts and logs (never throws) */
  summarize(args: Record<string, unknown>): string;
  /** Per-call permission class (falls back to permissionClass when absent) */
  dynamicPermissionClass?(rawArgs: Record<string, unknown>): PermissionClass | undefined;
  /** Validate + execute. Validation failures and thrown ToolErrors become error results. */
  execute(rawArgs: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult>;
}

export type ToolArgValidation =
  { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

/** Truncate output to the budget, keeping the head and the tail. */
export function truncateToolOutput(content: string, budget: number): string {
  if (content.length <= budget) return content;
  if (budget < 200) return content.slice(0, budget);
  const headSize = Math.floor(budget * 0.7);
  const tailSize = budget - headSize - 60;
  const omitted = content.length - headSize - tailSize;
  return (
    content.slice(0, headSize) +
    `\n…[output truncated: ${omitted} characters omitted]…\n` +
    content.slice(content.length - tailSize)
  );
}

export function defineTool<T>(spec: ToolSpec<T>): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    permissionClass: spec.permissionClass,
    mutating: spec.mutating,
    destructive: spec.destructive ?? false,
    timeoutMs: spec.timeoutMs,
    outputBudget: spec.outputBudget,
    inputSchema: zodToJsonSchema(spec.schema),
    validateArgs(raw: Record<string, unknown>): ToolArgValidation {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return { ok: false, message: issues };
      }
      return { ok: true, data: parsed.data as Record<string, unknown> };
    },
    summarize(args: Record<string, unknown>): string {
      try {
        const parsed = spec.schema.safeParse(args);
        if (!parsed.success) return '(invalid arguments)';
        return spec.summarize(parsed.data);
      } catch {
        return '(unavailable)';
      }
    },
    dynamicPermissionClass: spec.dynamicPermissionClass
      ? (rawArgs: Record<string, unknown>): PermissionClass | undefined => {
          const parsed = spec.schema.safeParse(rawArgs);
          if (!parsed.success) return undefined;
          return spec.dynamicPermissionClass!(parsed.data);
        }
      : undefined,
    async execute(rawArgs: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
      const started = Date.now();
      const parsed = spec.schema.safeParse(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return {
          isError: true,
          content: `Invalid arguments for ${spec.name}: ${issues}`,
          durationMs: Date.now() - started,
          meta: { code: 'invalid-input' },
        };
      }

      try {
        const output = await spec.execute(parsed.data, ctx);
        const result: ToolExecResult = {
          isError: output.isError,
          content: truncateToolOutput(output.content, spec.outputBudget),
          durationMs: Date.now() - started,
        };
        if (output.meta) result.meta = output.meta;
        return result;
      } catch (err) {
        const toolError =
          err instanceof ToolError
            ? err
            : new ToolError(err instanceof Error ? err.message : String(err), { code: 'io-error' });
        return {
          isError: true,
          content: truncateToolOutput(toolError.toDisplayMessage(), spec.outputBudget),
          durationMs: Date.now() - started,
          meta: { code: toolError.code },
        };
      }
    },
  };
}

// ============================================================================
// External tools (MCP servers and similar, §38)
// ============================================================================

/**
 * A tool whose schema comes from outside the process. The JSON Schema is sent
 * to the provider as-is (the server validates too), while `validate` performs
 * a local structural check of the arguments before anything is executed.
 */
export interface ExternalToolSpec {
  name: string;
  description: string;
  /** JSON Schema advertised by the external server */
  inputSchema: Record<string, unknown>;
  /** Local validation; return an issue string, or null to accept */
  validate?(raw: Record<string, unknown>): string | null;
  permissionClass: PermissionClass;
  mutating: boolean;
  destructive?: boolean;
  timeoutMs: number;
  outputBudget: number;
  summarize(raw: Record<string, unknown>): string;
  execute(raw: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolOutput> | ToolOutput;
}

export function defineExternalTool(spec: ExternalToolSpec): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    permissionClass: spec.permissionClass,
    mutating: spec.mutating,
    destructive: spec.destructive ?? false,
    timeoutMs: spec.timeoutMs,
    outputBudget: spec.outputBudget,
    inputSchema: spec.inputSchema,
    validateArgs(raw: Record<string, unknown>): ToolArgValidation {
      if (spec.validate) {
        let issue: string | null;
        try {
          issue = spec.validate(raw);
        } catch (err) {
          return {
            ok: false,
            message: `schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (issue) return { ok: false, message: issue };
      }
      return { ok: true, data: raw };
    },
    summarize(args: Record<string, unknown>): string {
      try {
        return spec.summarize(args);
      } catch {
        return '(unavailable)';
      }
    },
    async execute(rawArgs: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
      const started = Date.now();
      if (spec.validate) {
        const issue = spec.validate(rawArgs);
        if (issue) {
          return {
            isError: true,
            content: `Invalid arguments for ${spec.name}: ${issue}`,
            durationMs: Date.now() - started,
            meta: { code: 'invalid-input' },
          };
        }
      }

      try {
        const output = await spec.execute(rawArgs, ctx);
        const result: ToolExecResult = {
          isError: output.isError,
          content: truncateToolOutput(output.content, spec.outputBudget),
          durationMs: Date.now() - started,
        };
        if (output.meta) result.meta = output.meta;
        return result;
      } catch (err) {
        const toolError =
          err instanceof ToolError
            ? err
            : new ToolError(err instanceof Error ? err.message : String(err), {
                code: 'tool-error',
              });
        return {
          isError: true,
          content: truncateToolOutput(toolError.toDisplayMessage(), spec.outputBudget),
          durationMs: Date.now() - started,
          meta: { code: toolError.code },
        };
      }
    },
  };
}
