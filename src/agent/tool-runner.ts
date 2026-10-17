/**
 * Tool call execution: validate → permission → run → record (§40–§44, §52).
 *
 * This is the only path that executes native tools. Slash commands, natural
 * language, and (later) MCP results all funnel through the same validation
 * and policy evaluation.
 */

import type { PermissionEngine } from '../permissions/engine.js';
import type {
  PermissionAuditEntry,
  PermissionPromptResponse,
  PermissionRequest,
} from '../permissions/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecResult, RegisteredTool } from '../tools/types.js';
import { truncateToolOutput } from '../tools/types.js';
import type { WorkspacePaths } from '../tools/paths.js';
import type { InternalToolCall, InternalToolResult } from '../providers/types.js';
import type { ToolCallRecord } from '../types/index.js';

/** Records kept in the session for inspectability (content is truncated) */
export const TOOL_HISTORY_LIMIT = 300;
export const TOOL_HISTORY_RESULT_CHARS = 2000;
export const PERMISSION_AUDIT_LIMIT = 200;

/** Append a tool record to the session history (bounded). */
export function appendToolHistory(
  session: { toolHistory?: ToolCallRecord[] },
  record: ToolCallRecord,
): void {
  session.toolHistory = [...(session.toolHistory ?? []), record].slice(-TOOL_HISTORY_LIMIT);
}

/** Append a permission decision to the session audit trail (bounded). */
export function appendPermissionAudit(
  session: { permissionAudit?: PermissionAuditEntry[] },
  entry: PermissionAuditEntry,
): void {
  session.permissionAudit = [...(session.permissionAudit ?? []), entry].slice(
    -PERMISSION_AUDIT_LIMIT,
  );
}

export interface ToolRunnerOptions {
  registry: ToolRegistry;
  permissions: PermissionEngine;
  paths: WorkspacePaths;
  signal?: AbortSignal;
  /** Interactive approval callback; absent in non-interactive runs */
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionPromptResponse>;
}

export interface ToolExecutionOutcome {
  result: InternalToolResult;
  record: ToolCallRecord;
  /** Present when the decision was consequential (audit trail) */
  audit?: PermissionAuditEntry;
}

function errorOutcome(
  call: InternalToolCall,
  content: string,
  executedAt: string,
): ToolExecutionOutcome {
  return {
    result: { toolCallId: call.id, content, isError: true },
    record: {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      result: content,
      isError: true,
      durationMs: 0,
      executedAt,
    },
  };
}

function buildPermissionRequest(
  tool: RegisteredTool,
  args: Record<string, unknown>,
  permissionClass: PermissionRequest['permissionClass'],
  paths: WorkspacePaths,
): PermissionRequest {
  const invokedPaths: string[] = [];
  for (const field of ['path', 'from', 'to'] as const) {
    const value = args[field];
    if (typeof value === 'string' && value !== '') {
      try {
        invokedPaths.push(paths.resolve(value).rel);
      } catch {
        // outside/sensitive — the tool itself will report the concrete error
      }
    }
  }

  const command = typeof args['command'] === 'string' ? args['command'] : undefined;
  const commandArgs = Array.isArray(args['args']) ? (args['args'] as string[]) : [];

  const action = tool.name === 'run_command' && command ? `command:${command}` : tool.name;
  const approvalKey = action;
  const summary = tool.summarize(args);
  const detail =
    tool.name === 'run_command' && command
      ? `${summary} · argv: [${[command, ...commandArgs].map((a) => JSON.stringify(a)).join(', ')}] (no shell)`
      : summary;

  const request: PermissionRequest = {
    action,
    toolName: tool.name,
    permissionClass,
    summary,
    detail,
    approvalKey,
  };
  if (invokedPaths.length > 0) request.paths = invokedPaths;
  if (tool.destructive) request.destructive = true;
  return request;
}

export async function executeToolCall(
  call: InternalToolCall,
  options: ToolRunnerOptions,
): Promise<ToolExecutionOutcome> {
  const executedAt = new Date().toISOString();
  const tool = options.registry.get(call.name);

  if (!tool) {
    return errorOutcome(
      call,
      `Unknown tool: ${call.name}. Available tools: ${options.registry.names().join(', ')}`,
      executedAt,
    );
  }

  const validation = tool.validateArgs(call.arguments);
  if (!validation.ok) {
    return errorOutcome(
      call,
      `Invalid arguments for ${call.name}: ${validation.message}. The call was not executed.`,
      executedAt,
    );
  }
  const args = validation.data;

  const permissionClass = tool.dynamicPermissionClass?.(args) ?? tool.permissionClass;
  const request = buildPermissionRequest(tool, args, permissionClass, options.paths);
  const decision = options.permissions.evaluate(request);
  let audit: PermissionAuditEntry | undefined;

  if (decision.decision === 'deny') {
    audit = options.permissions.noteDecision(
      request,
      'deny',
      decision.reason,
      decision.rule?.scope,
    );
    const outcome = errorOutcome(call, `Permission denied: ${decision.reason}`, executedAt);
    outcome.audit = audit;
    return outcome;
  }

  if (decision.decision === 'confirm') {
    if (!options.onPermissionRequest) {
      const reason = 'this action requires confirmation, but no interactive approver is available';
      audit = options.permissions.noteDecision(request, 'deny', reason, decision.rule?.scope);
      const outcome = errorOutcome(call, `Permission denied: ${reason}.`, executedAt);
      outcome.audit = audit;
      return outcome;
    }

    let response: PermissionPromptResponse;
    try {
      response = await options.onPermissionRequest(request);
    } catch (err) {
      const reason = `approval prompt failed: ${err instanceof Error ? err.message : String(err)}`;
      audit = options.permissions.noteDecision(request, 'deny', reason);
      const outcome = errorOutcome(call, `Permission denied: ${reason}.`, executedAt);
      outcome.audit = audit;
      return outcome;
    }

    if (response.decision === 'deny') {
      audit = options.permissions.noteDecision(request, 'deny', 'denied by the user');
      const outcome = errorOutcome(call, 'Permission denied by the user.', executedAt);
      outcome.audit = audit;
      return outcome;
    }
    if (response.decision === 'allow-session') {
      options.permissions.approveForSession(request);
      audit = options.permissions.noteDecision(
        request,
        'approved-session',
        `approved by the user (session-wide for ${request.approvalKey})`,
      );
    } else {
      audit = options.permissions.noteDecision(
        request,
        'approved-once',
        'approved once by the user',
      );
    }
  }

  // --------------------------------------------------------------------------
  // Execute with a bounded time budget and cancellation propagation
  // --------------------------------------------------------------------------

  const timeoutMs = Math.max(1000, Math.min(tool.timeoutMs, 10 * 60 * 1000));
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const timeoutPromise = new Promise<ToolExecResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({
        isError: true,
        content: `Tool ${call.name} timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - started,
        meta: { code: 'timeout' },
      });
    }, timeoutMs);
  });

  let result: ToolExecResult;
  try {
    result = await Promise.race([
      tool.execute(args, {
        workspaceRoot: options.paths.realRoot,
        timeoutMs,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    result = {
      isError: true,
      content: `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }

  if (!timedOut && controller.signal.aborted && !result.isError) {
    result = {
      isError: true,
      content: `Tool ${call.name} was cancelled.`,
      durationMs: result.durationMs,
      meta: { code: 'cancelled' },
    };
  }

  // Audit consequential allow decisions (reads would flood the log)
  if (!audit && permissionClass !== 'read') {
    audit =
      decision.decision === 'allow'
        ? options.permissions.noteDecision(request, 'allow', decision.reason, decision.rule?.scope)
        : options.permissions.noteDecision(request, 'allow', 'approved');
  }

  const record: ToolCallRecord = {
    id: call.id,
    name: call.name,
    arguments: args,
    result: truncateToolOutput(result.content, TOOL_HISTORY_RESULT_CHARS),
    isError: result.isError,
    durationMs: result.durationMs,
    executedAt,
  };

  const outcome: ToolExecutionOutcome = {
    result: { toolCallId: call.id, content: result.content, isError: result.isError },
    record,
  };
  if (audit) outcome.audit = audit;
  return outcome;
}
