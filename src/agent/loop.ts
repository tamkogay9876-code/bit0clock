/**
 * Bounded, observable agent loop (§44).
 *
 * Flow per turn:
 *   1. attach native tools (when the model supports them and the mode allows)
 *   2. stream a provider response, collecting text and completed tool calls
 *   3. persist the assistant message (even on error/cancellation)
 *   4. validate every tool call, apply the permission engine, execute approved
 *      calls in order, and persist their results
 *   5. repeat until the model stops asking for tools, the iteration limit is
 *      reached, or the user cancels
 *
 * Partially streamed or invalid tool-call arguments are never executed.
 * Tool results are summarized into the conversation and the full records go
 * to the session history (bounded) plus the change ledger for /undo.
 */

import { generateId } from '../utils/index.js';
import { normalizeError } from '../errors/index.js';
import { chatWithRetry } from '../providers/retry.js';
import { discoverInstructions } from '../context/instructions.js';
import { prepareContextRequest, type PreparedContextRequest } from '../context/pipeline.js';
import { WorkspacePaths } from '../tools/paths.js';
import { createDefaultToolRegistry } from '../tools/registry.js';
import { createSkillTools } from '../skills/tools.js';
import { appendChange, type ChangeRecord } from '../tools/ledger.js';
import type { PlanStore } from '../tools/plan-tools.js';
import type { ChangeJournal } from '../tools/write-tools.js';
import type {
  InternalToolCall,
  InternalToolResult,
  ProviderStreamEvent,
  UsageEvent,
} from '../providers/types.js';
import type { AppError, ToolCallRecord } from '../types/index.js';
import type { StoredMessage, StoredUsage } from '../session/types.js';
import type { PermissionPromptResponse, PermissionRequest } from '../permissions/types.js';
import type { BudgetGateDecision } from '../budget/gate.js';
import type { AppState } from '../app/state.js';
import { appendPermissionAudit, appendToolHistory, executeToolCall } from './tool-runner.js';

// ============================================================================
// Events
// ============================================================================

export type AgentEvent =
  | { type: 'iteration-started'; iteration: number; maxIterations: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-started'; call: InternalToolCall; summary: string }
  | { type: 'tool-finished'; call: InternalToolCall; record: ToolCallRecord }
  | {
      /** Context assembly result for this iteration (§25/§31) */
      type: 'context-prepared';
      estimatedInputTokens: number;
      estimateSource: string;
      effectiveBudget: number;
      omittedMessages: number;
      compactedMessages: number;
      retrievalFiles: string[];
      gateAction: 'allow' | 'confirm' | 'block';
      notes: string[];
    }
  | {
      type: 'completed';
      iterations: number;
      toolCalls: number;
      stopReason: string | null;
      exhausted: boolean;
    }
  | { type: 'cancelled'; reason: string }
  | { type: 'error'; error: AppError };

export interface AgentTurnOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionPromptResponse>;
  /** Interactive confirmation for budget gate 'confirm' decisions (§30) */
  onBudgetConfirm?: (decision: BudgetGateDecision) => Promise<boolean>;
  /** Request-only context added to the system prompt (not persisted) */
  contextPreamble?: string;
  /** Set false to disable tool attachment regardless of model metadata */
  toolsEnabled?: boolean;
  /** Override the configured iteration bound (tests, focused runs) */
  maxIterations?: number;
}

export interface AgentTurnResult {
  /** Final assistant text of the last iteration */
  text: string;
  iterations: number;
  toolCallRecords: ToolCallRecord[];
  cancelled: boolean;
  /** True when the iteration limit stopped the loop */
  exhausted: boolean;
  stopReason: string | null;
  error?: AppError;
}

function storedUsageFrom(usage: UsageEvent): StoredUsage | undefined {
  const stored: StoredUsage = {};
  if (usage.inputTokens !== undefined) stored.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) stored.outputTokens = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) stored.cachedInputTokens = usage.cachedInputTokens;
  if (usage.reasoningTokens !== undefined) stored.reasoningTokens = usage.reasoningTokens;
  return Object.keys(stored).length > 0 ? stored : undefined;
}

export async function runAgentTurn(
  app: AppState,
  userText: string,
  options: AgentTurnOptions = {},
): Promise<AgentTurnResult> {
  const active = app.activeModel();
  if (!active) {
    throw new Error(
      'No model selected. Run /models to browse models and /model <model> to select one.',
    );
  }

  const limits = app.config.agentLoopLimits;
  const maxIterations = Math.max(1, options.maxIterations ?? limits.maxIterations);

  const emit = async (event: AgentEvent): Promise<void> => {
    if (options.onEvent) await options.onEvent(event);
  };

  // --------------------------------------------------------------------------
  // Tool registry bound to this session
  // --------------------------------------------------------------------------

  const paths = new WorkspacePaths(app.projectPath);
  const changeJournal: ChangeJournal = {
    add(record: ChangeRecord): void {
      app.session.changeLedger = appendChange(app.session.changeLedger ?? [], record);
    },
  };
  const planStore: PlanStore = {
    get: () => app.session.plan ?? null,
    set: (plan) => {
      app.session.plan = plan;
    },
  };
  const registry = createDefaultToolRegistry({
    paths,
    changeJournal,
    planStore,
    ledgerRecords: () => app.session.changeLedger ?? [],
  });

  const modelEntry = app.catalog.findModel(active.modelId, [active.providerId]);
  const toolsSupported = options.toolsEnabled !== false && modelEntry?.tools !== false;

  // MCP tools (§37): only after a real connection discovered them; a failing
  // server is recorded and never stops the turn. They are mutating tools, so
  // read-only modes (plan/review) do not offer them at all.
  const mcpServersAttached: string[] = [];
  if (
    toolsSupported &&
    app.config.mcpServers.some((server) => server.enabled) &&
    app.config.featureFlags.mcp !== false
  ) {
    await app.mcp.ensureEnabledConnected();
    const mcpTools = app.mcp.registeredTools();
    if (mcpTools.length > 0) {
      registry.registerAll(mcpTools);
      const withTools = new Set(
        app.mcp
          .states()
          .filter((state) => state.enabled && state.status === 'ready' && state.tools.length > 0)
          .map((state) => state.name),
      );
      mcpServersAttached.push(...withTools);
    }
  }

  // Activated skills expose reference loading as a read-only tool (§33)
  if (toolsSupported) {
    const skillTools = createSkillTools(app);
    if (skillTools.length > 0) registry.registerAll(skillTools);
  }

  const tools = toolsSupported ? registry.providerToolsForMode(app.session.mode) : [];
  const instructions = discoverInstructions(app.projectPath);

  // --------------------------------------------------------------------------
  // Append the user message
  // --------------------------------------------------------------------------

  const userMessage: StoredMessage = {
    id: generateId(),
    role: 'user',
    content: userText,
    timestamp: new Date().toISOString(),
  };
  app.session.messages.push(userMessage);
  app.sessionManager.save(app.session);

  app.markRequestStarted();

  let iterations = 0;
  let cancelled = false;
  let exhausted = false;
  let error: AppError | undefined;
  let stopReason: string | null = null;
  let lastText = '';
  const toolCallRecords: ToolCallRecord[] = [];

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      iterations = iteration;
      await emit({ type: 'iteration-started', iteration, maxIterations });

      const requestOptions: Parameters<typeof prepareContextRequest>[2] = {};
      if (tools.length > 0) requestOptions.tools = tools;
      if (instructions.sources.length > 0) requestOptions.instructions = instructions;
      if (iteration === 1 && options.contextPreamble) {
        requestOptions.contextPreamble = options.contextPreamble;
      }
      if (iteration === 1 && userText.trim() !== '') {
        requestOptions.retrievalText = userText;
      }
      if (options.onBudgetConfirm) requestOptions.onBudgetConfirm = options.onBudgetConfirm;
      if (mcpServersAttached.length > 0) requestOptions.mcpServers = mcpServersAttached;

      let text = '';
      let usage: UsageEvent = {};
      let streamError: AppError | undefined;
      let iterationCancelled = false;
      let prepared: PreparedContextRequest | undefined;
      const completedCalls: InternalToolCall[] = [];
      const invalidCalls: Array<{ id: string; name: string; error: string }> = [];

      try {
        prepared = await prepareContextRequest(app, app.session.messages, requestOptions);
        await emit({
          type: 'context-prepared',
          estimatedInputTokens: prepared.estimate.tokens,
          estimateSource: prepared.estimate.source,
          effectiveBudget: prepared.budget.effectiveBudget,
          omittedMessages: prepared.omittedMessages,
          compactedMessages: prepared.compactedMessages,
          retrievalFiles: prepared.retrievalFiles,
          gateAction: prepared.gate.action,
          notes: prepared.notes,
        });

        const adapter = await app.getAdapter(active.providerId);
        for await (const event of chatWithRetry(adapter, prepared.request, options.signal)) {
          switch (event.type) {
            case 'text-delta':
              text += event.data.text;
              await emit({ type: 'text-delta', text: event.data.text });
              break;
            case 'reasoning-delta':
              await emit({ type: 'reasoning-delta', text: event.data.text });
              break;
            case 'usage-updated':
              usage = { ...usage, ...event.data };
              break;
            case 'tool-call-completed':
              completedCalls.push(event.data);
              break;
            case 'tool-call-invalid':
              invalidCalls.push({
                id: event.data.id,
                name: event.data.name,
                error: event.data.error,
              });
              break;
            case 'response-completed':
              stopReason = event.data.stopReason;
              break;
            case 'error':
              streamError = event.data;
              break;
            case 'cancelled':
              iterationCancelled = true;
              break;
            default:
              break;
          }
        }
      } catch (err) {
        streamError = normalizeError(err, { provider: active.providerId, model: active.modelId });
      }

      lastText = text;

      // Persist the assistant message (partial output is kept, never hidden)
      const assistantMessage: StoredMessage = {
        id: generateId(),
        role: 'assistant',
        content: text,
        providerId: active.providerId,
        modelId: active.modelId,
        timestamp: new Date().toISOString(),
      };
      if (completedCalls.length > 0 || invalidCalls.length > 0) {
        assistantMessage.toolCalls = [
          ...completedCalls,
          ...invalidCalls.map((invalid) => ({
            id: invalid.id,
            name: invalid.name,
            arguments: {},
          })),
        ];
      }
      const storedUsage = storedUsageFrom(usage);
      if (storedUsage) assistantMessage.usage = storedUsage;
      if (streamError) assistantMessage.error = streamError.message;
      if (iterationCancelled) assistantMessage.error ??= 'Cancelled by the user';
      app.session.messages.push(assistantMessage);

      if (storedUsage) {
        app.recordUsage(active.providerId, active.modelId, storedUsage);
        if (prepared && storedUsage.inputTokens !== undefined && storedUsage.inputTokens > 0) {
          // Calibration observation (§28): improves future estimates, never a guarantee
          app.calibration.record(
            active.providerId,
            active.modelId,
            prepared.estimate.tokens,
            storedUsage.inputTokens,
          );
        }
      } else {
        app.sessionManager.save(app.session);
      }

      if (iterationCancelled || streamError) {
        // Keep the conversation protocol-valid: every recorded tool call gets
        // a result, even though none of them were executed.
        const pendingCalls = [
          ...completedCalls,
          ...invalidCalls.map((invalid) => ({ id: invalid.id, name: invalid.name, arguments: {} })),
        ];
        if (pendingCalls.length > 0) {
          app.session.messages.push({
            id: generateId(),
            role: 'tool',
            content: '',
            toolResults: pendingCalls.map((call) => ({
              toolCallId: call.id,
              content: iterationCancelled
                ? 'Cancelled by the user before execution.'
                : 'The response failed before tool execution; this call was not run.',
              isError: true,
            })),
            timestamp: new Date().toISOString(),
          });
          app.sessionManager.save(app.session);
        }
        if (iterationCancelled) {
          cancelled = true;
          await emit({ type: 'cancelled', reason: 'user cancelled the response' });
        } else if (streamError) {
          error = streamError;
          await emit({ type: 'error', error: streamError });
        }
        break;
      }

      const hasToolWork = completedCalls.length > 0 || invalidCalls.length > 0;
      if (!hasToolWork) {
        break; // final response, loop complete
      }

      // ------------------------------------------------------------------
      // Bounded tool-call processing, in model order
      // ------------------------------------------------------------------

      const perIteration = Math.max(1, limits.maxToolCallsPerIteration);
      const valid = completedCalls.slice(0, perIteration);
      const validSkipped = completedCalls.slice(perIteration);
      const invalid = invalidCalls.slice(0, Math.max(0, perIteration - valid.length));
      const invalidSkipped = invalidCalls.slice(Math.max(0, perIteration - valid.length));

      const toolResults: InternalToolResult[] = [];

      for (const call of valid) {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }

        const tool = registry.get(call.name);
        await emit({
          type: 'tool-started',
          call,
          summary: tool?.summarize(call.arguments) ?? call.name,
        });

        const outcome = await executeToolCall(call, {
          registry,
          permissions: app.permissions,
          paths,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onPermissionRequest
            ? { onPermissionRequest: options.onPermissionRequest }
            : {}),
        });

        toolCallRecords.push(outcome.record);
        appendToolHistory(app.session, outcome.record);
        if (outcome.audit) {
          appendPermissionAudit(app.session, outcome.audit);
        }
        toolResults.push(outcome.result);
        app.sessionManager.save(app.session);
        await emit({ type: 'tool-finished', call, record: outcome.record });
      }

      if (cancelled) {
        // Append results for calls that were never executed so the stored
        // conversation remains protocol-valid when resumed.
        for (let i = toolResults.length; i < valid.length; i++) {
          const call = valid[i]!;
          toolResults.push({
            toolCallId: call.id,
            content: 'Cancelled by the user before execution.',
            isError: true,
          });
        }
        for (const call of invalid) {
          if (!toolResults.some((result) => result.toolCallId === call.id)) {
            toolResults.push({
              toolCallId: call.id,
              content: 'Cancelled by the user before execution.',
              isError: true,
            });
          }
        }
        app.session.messages.push({
          id: generateId(),
          role: 'tool',
          content: '',
          toolResults,
          timestamp: new Date().toISOString(),
        });
        app.sessionManager.save(app.session);
        await emit({ type: 'cancelled', reason: 'user cancelled during tool execution' });
        break;
      }

      for (const call of invalid) {
        const message = `Invalid tool call arguments: ${call.error}. The call was not executed.`;
        const record: ToolCallRecord = {
          id: call.id,
          name: call.name,
          arguments: {},
          result: message,
          isError: true,
          durationMs: 0,
          executedAt: new Date().toISOString(),
        };
        toolCallRecords.push(record);
        appendToolHistory(app.session, record);
        toolResults.push({ toolCallId: call.id, content: message, isError: true });
        await emit({
          type: 'tool-finished',
          call: { id: call.id, name: call.name, arguments: {} },
          record,
        });
      }

      for (const call of [...validSkipped, ...invalidSkipped]) {
        const message =
          `Skipped: the per-iteration tool call limit (${perIteration}) was reached. ` +
          'Re-request after reviewing the results above.';
        toolResults.push({ toolCallId: call.id, content: message, isError: true });
      }

      app.sessionManager.save(app.session);

      // Append tool results for the model
      const toolMessage: StoredMessage = {
        id: generateId(),
        role: 'tool',
        content: '',
        toolResults,
        timestamp: new Date().toISOString(),
      };
      app.session.messages.push(toolMessage);
      app.sessionManager.save(app.session);

      if (iteration === maxIterations) {
        exhausted = true;
      }
    }
  } finally {
    app.markRequestFinished();
  }

  if (exhausted) {
    // Persist an explicit stop note so a resumed session is honest about it
    const note: StoredMessage = {
      id: generateId(),
      role: 'system',
      content:
        `Stopped: the iteration limit (${maxIterations}) was reached. ` +
        'Continue with another message, or raise agentLoopLimits.maxIterations in the config.',
      timestamp: new Date().toISOString(),
    };
    app.session.messages.push(note);
    app.sessionManager.save(app.session);
  }

  await emit({
    type: 'completed',
    iterations,
    toolCalls: toolCallRecords.length,
    stopReason,
    exhausted,
  });

  const result: AgentTurnResult = {
    text: lastText,
    iterations,
    toolCallRecords,
    cancelled,
    exhausted,
    stopReason,
  };
  if (error) result.error = error;
  return result;
}
