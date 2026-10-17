/**
 * Context pipeline: turns session messages into a ready-to-send request.
 *
 * Responsibilities (§23–§30):
 *  - resolve the context profile target (incl. the auto profile),
 *  - optionally retrieve relevant repository snippets (§26),
 *  - fit the conversation into the effective budget (auto-compaction first,
 *    then oldest-first omission with an explicit note),
 *  - estimate input tokens (local heuristic, calibration, optional provider
 *    count endpoint),
 *  - evaluate the preflight budget gate and request confirmation when the
 *    configured policy requires it,
 *  - persist a bounded assembly report for /context inspect.
 *
 * The pipeline never sends anything by itself and never silently changes the
 * model, provider, or requested context.
 */

import { buildChatRequest } from '../agent/chat.js';
import { buildSystemPrompt, storedMessageToInternal } from '../agent/request.js';
import { discoverInstructions, type InstructionBundle } from './instructions.js';
import { RepoIndex } from './retrieval.js';
import { readTextFile } from '../tools/file-utils.js';
import { WorkspacePaths } from '../tools/paths.js';
import type { SkillPromptItem } from '../skills/manager.js';
import {
  assembleContext,
  CONTEXT_PRIORITY,
  type ContextAssembly,
  type ContextCandidate,
} from './assembly.js';
import {
  computeEffectiveBudget,
  DEFAULT_AUTO_OUTPUT_RESERVE,
  type CapabilityInfo,
  type EffectiveBudget,
} from './budget.js';
import { resolveAutoBudget, resolveContextTarget, type ContextTarget } from './profiles.js';
import { estimateMessageTokens, estimateRequestInputTokens, type TokenEstimate } from './tokens.js';
import { applyCompaction, planCompaction, DEFAULT_KEEP_RECENT_MESSAGES } from './compaction.js';
import { evaluateBudgetGate, gateBlockedMessage, type BudgetGateDecision } from '../budget/gate.js';
import type { AppState } from '../app/state.js';
import type { ChatRequest, ToolSchema } from '../providers/types.js';
import type { ContextReportSummary, StoredMessage } from '../session/types.js';

const MIN_AUTO_COMPACT_MESSAGES = 4;
const MAX_FIT_PASSES = 6;

export class BudgetGateError extends Error {
  readonly decision: BudgetGateDecision;
  constructor(decision: BudgetGateDecision) {
    super(gateBlockedMessage(decision));
    this.name = 'BudgetGateError';
    this.decision = decision;
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface PrepareContextOptions {
  /** Tools to attach (already filtered for the active mode) */
  tools?: ToolSchema[];
  /** Instruction bundle override (defaults to workspace discovery) */
  instructions?: InstructionBundle;
  /** Request-only task context */
  contextPreamble?: string;
  /** Text used for automatic retrieval (usually the current user message) */
  retrievalText?: string;
  /** Interactive confirmation for gate 'confirm' decisions */
  onBudgetConfirm?: (decision: BudgetGateDecision) => Promise<boolean>;
  /** Skip the gate entirely (preview/test paths only) */
  skipGate?: boolean;
  /** Persist/save the context report (default true) */
  persistReport?: boolean;
  /** Names of MCP servers whose tools are attached (§38 security note) */
  mcpServers?: string[];
}

export interface PreparedContextRequest {
  request: ChatRequest;
  budget: EffectiveBudget;
  estimate: TokenEstimate;
  assembly: ContextAssembly;
  gate: BudgetGateDecision;
  target: ContextTarget;
  notes: string[];
  omittedMessages: number;
  compactedMessages: number;
  retrievalFiles: string[];
  report: ContextReportSummary;
}

// ============================================================================
// Conversation fitting
// ============================================================================

/**
 * Keep the newest messages that fit the budget. The newest message is always
 * kept (even alone over budget — the caller decides what to do). Leading
 * tool-result messages are dropped so the conversation stays protocol-valid:
 * a tool result must never reference an assistant call that is not present.
 */
export function fitConversationToBudget(
  messages: StoredMessage[],
  budgetTokens: number,
): { included: StoredMessage[]; omitted: number } {
  const included: StoredMessage[] = [];
  let tokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'system') continue; // never sent; no budget effect

    const messageTokens = estimateMessageTokens(storedMessageToInternal(message));
    if (included.length > 0 && tokens + messageTokens > budgetTokens) break;
    included.unshift(message);
    tokens += messageTokens;
    if (tokens > budgetTokens) break; // newest message alone exceeds the budget
  }

  while (included.length > 0 && included[0]!.role === 'tool') {
    included.shift();
  }

  const sentCount = messages.filter((m) => m.role !== 'system').length;
  const keptSent = included.filter((m) => m.role !== 'system').length;
  return { included, omitted: sentCount - keptSent };
}

// ============================================================================
// Retrieval snippets
// ============================================================================

interface Snippet {
  path: string;
  provenance: string;
  content: string;
}

/**
 * Candidate file references from the user's text: explicit path mentions win,
 * keyword search fills the remainder. Always bounded.
 */
export function buildRetrievalSnippets(
  index: RepoIndex,
  text: string,
  options: { maxFiles: number; maxSnippetTokens: number },
): Snippet[] {
  const snippets: Snippet[] = [];
  const chosen = new Set<string>();

  // 1. Explicit path mentions that exist in the index
  const pathPattern =
    /[\w./-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|md|json|yml|yaml|toml|css|scss|html|vue|svelte|sql|sh|cs|cpp|c|h|php|swift|ex|exs|tf|nix)/g;
  const entriesByLower = new Map(
    index.list().map((entry) => [entry.path.toLowerCase(), entry.path]),
  );
  const mentions = new Set<string>();
  for (const match of text.matchAll(pathPattern)) {
    const raw = match[0]!.replace(/^\.\//, '').replace(/[.,;:)]+$/, '');
    if (raw.length < 4) continue;
    mentions.add(raw);
  }
  for (const mention of mentions) {
    if (snippets.length >= options.maxFiles) break;
    const resolved = index.get(mention) ? mention : entriesByLower.get(mention.toLowerCase());
    if (!resolved) continue;
    const entry = index.get(resolved);
    if (!entry || chosen.has(entry.path)) continue;
    const extraction = index.extract(entry.path, { maxTokens: options.maxSnippetTokens });
    if ('error' in extraction) continue;
    chosen.add(entry.path);
    snippets.push({
      path: entry.path,
      provenance: `retrieval: ${entry.path} (path mentioned in the request; lines ${extraction.startLine}-${extraction.endLine} of ${extraction.totalLines})`,
      content: extraction.content,
    });
  }

  // 2. Keyword search
  if (snippets.length < options.maxFiles && text.trim() !== '') {
    const results = index.search(text, { limit: options.maxFiles * 2 });
    for (const result of results) {
      if (snippets.length >= options.maxFiles) break;
      if (chosen.has(result.entry.path)) continue;
      const extraction = index.extract(result.entry.path, { maxTokens: options.maxSnippetTokens });
      if ('error' in extraction) continue;
      chosen.add(result.entry.path);
      snippets.push({
        path: result.entry.path,
        provenance: `retrieval: ${result.entry.path} (matched search: ${result.reasons.slice(0, 2).join('; ') || 'keyword'})`,
        content: extraction.content,
      });
    }
  }

  return snippets;
}

function renderRetrievalBlock(snippets: Snippet[]): string {
  const parts: string[] = [];
  for (const snippet of snippets) {
    parts.push(`### ${snippet.path} — ${snippet.provenance}`);
    parts.push('```');
    parts.push(snippet.content);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n').trim();
}

// ============================================================================
// Skills and pinned files (§25 priorities 5 and 9)
// ============================================================================

/** Per-file cap for pinned context (keeps /context pin from flooding a request) */
export const PIN_MAX_BYTES = 16_000;
/** Maximum pinned files honored per request */
export const PIN_MAX_FILES = 20;

export interface PinnedFileContent {
  rel: string;
  content: string;
  truncated: boolean;
  bytes: number;
  /** Present when the file could not be read; the pin is skipped with a note */
  error?: string;
}

/** Read every pinned file fresh from disk (bounded); never throws. */
export function loadPinnedFiles(app: AppState): PinnedFileContent[] {
  const pinned = app.session.pinnedPaths ?? [];
  if (pinned.length === 0) return [];
  const paths = new WorkspacePaths(app.projectPath);
  const results: PinnedFileContent[] = [];
  for (const rel of pinned.slice(0, PIN_MAX_FILES)) {
    try {
      const resolved = paths.resolve(rel, { mustExist: true });
      const read = readTextFile(resolved.abs, resolved.rel, PIN_MAX_BYTES);
      results.push({
        rel: resolved.rel,
        content: read.text,
        truncated: read.truncated,
        bytes: read.bytes,
      });
    } catch (err) {
      results.push({
        rel,
        content: '',
        truncated: false,
        bytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function renderSkillsBlock(items: SkillPromptItem[]): string | undefined {
  if (items.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of items) {
    parts.push(`### ${item.name} (${item.scope} skill, ${item.trustLevel})`);
    parts.push(item.description);
    parts.push('');
    parts.push(item.instructions);
    if (item.truncated) parts.push('(skill instructions were truncated at the size cap)');
    if (item.references.length > 0) {
      parts.push('');
      parts.push(`Reference files (load on demand): ${item.references.slice(0, 12).join(', ')}`);
    }
    parts.push('');
  }
  return parts.join('\n').trim();
}

export function renderPinnedBlock(files: PinnedFileContent[]): string | undefined {
  const readable = files.filter((file) => file.error === undefined);
  if (readable.length === 0) return undefined;
  const parts: string[] = [];
  for (const file of readable) {
    parts.push(
      `### ${file.rel} (${file.bytes} bytes${file.truncated ? ', truncated at the size cap' : ''})`,
    );
    parts.push(file.content);
    parts.push('');
  }
  return parts.join('\n').trim();
}

// ============================================================================
// Budget/target computation (shared by prepare + preview)
// ============================================================================

interface ComputedTarget {
  target: ContextTarget;
  reservedOutputTokens: number;
  safetyMargin: number;
  notes: string[];
}

function computeTarget(app: AppState, conversationEstimate: number): ComputedTarget {
  const engine = app.config.contextEngine;
  const target = resolveContextTarget({
    session: app.session,
    profiles: app.config.contextProfiles,
    defaultProfileId: app.config.defaultContextProfile,
  });
  const notes = [...target.notes];

  const active = app.activeModel();
  const entry = active ? app.catalog.findModel(active.modelId, [active.providerId]) : undefined;

  const explicitReserve = Math.max(
    target.reservedOutputTokens,
    app.session.outputLimit ?? 0,
    app.session.reasoning.budgetTokens ?? 0,
  );
  let reservedOutputTokens = explicitReserve;
  if (target.auto && reservedOutputTokens === 0) {
    reservedOutputTokens = Math.min(
      entry?.maxOutputTokens ?? DEFAULT_AUTO_OUTPUT_RESERVE,
      DEFAULT_AUTO_OUTPUT_RESERVE,
    );
  }

  let maxTokens = target.maxTokens;
  if (target.auto) {
    const auto = resolveAutoBudget({
      conversationTokens: conversationEstimate,
      taskTokens: 0,
      reservedOutputTokens,
      safetyMargin: target.safetyMargin,
      ...(entry?.contextLength !== undefined ? { modelContextLimit: entry.contextLength } : {}),
      fallbackLimit: engine.fallbackLimit,
    });
    maxTokens = auto.maxTokens;
    notes.push(...auto.notes);
  }

  return {
    target: { ...target, maxTokens },
    reservedOutputTokens,
    safetyMargin: target.safetyMargin,
    notes,
  };
}

function buildCapability(app: AppState): CapabilityInfo | undefined {
  const active = app.activeModel();
  if (!active) return undefined;
  const entry = app.catalog.findModel(active.modelId, [active.providerId]);
  if (!entry || entry.contextLength === undefined) return undefined;
  return {
    label: `${entry.providerId}/${entry.id} reported context window`,
    source: entry.capabilitySource,
    verified: entry.verified,
    ...(entry.discoveredAt !== undefined ? { timestamp: entry.discoveredAt } : {}),
  };
}

/** Last-line-of-defence limit values used by both prepare and preview. */
function computeBudgetFor(
  app: AppState,
  estimate: TokenEstimate,
  computed: ComputedTarget,
): EffectiveBudget {
  const active = app.activeModel()!;
  const entry = app.catalog.findModel(active.modelId, [active.providerId]);
  const providerConfig = app.getProviderConfig(active.providerId);
  const capability = buildCapability(app);

  return computeEffectiveBudget({
    requestedTokens: computed.target.maxTokens,
    origin: computed.target.origin,
    ...(entry?.contextLength !== undefined ? { modelContextLimit: entry.contextLength } : {}),
    ...(capability ? { modelCapability: capability } : {}),
    ...(providerConfig?.inputLimit !== undefined
      ? { providerInputLimit: providerConfig.inputLimit }
      : {}),
    reservedOutputTokens: computed.reservedOutputTokens,
    safetyMargin: computed.safetyMargin,
    estimatedInputTokens: estimate.tokens,
    fallbackLimit: app.config.contextEngine.fallbackLimit,
  });
}

// ============================================================================
// Preview (no side effects)
// ============================================================================

export interface ContextPreview {
  target: ContextTarget;
  budget: EffectiveBudget;
  estimate: TokenEstimate;
  gate: BudgetGateDecision;
  notes: string[];
}

/** Compute the effective budget for the CURRENT conversation, read-only. */
export function previewContextBudget(
  app: AppState,
  options: { messages?: StoredMessage[] } = {},
): ContextPreview {
  const active = app.activeModel();
  if (!active) throw new Error('No model selected. Run /models to select one.');

  const messages = options.messages ?? app.session.messages;
  const instructions = discoverInstructions(app.projectPath);
  const skillsBlock = renderSkillsBlock(app.skills.promptItems());
  const pinnedBlock = renderPinnedBlock(loadPinnedFiles(app));
  const memoryBlock = app.memory.toPromptBlock();
  const system = buildSystemPrompt(app.session, {
    ...(instructions.sources.length > 0 ? { instructions } : {}),
    ...(app.session.plan?.goal ? { contextPreamble: `Active plan: ${app.session.plan.goal}` } : {}),
    ...(skillsBlock ? { skillsBlock } : {}),
    ...(pinnedBlock ? { pinnedBlock } : {}),
    ...(memoryBlock ? { memoryBlock } : {}),
  });
  const localEstimate = estimateRequestInputTokens({
    system,
    messages: messages.filter((m) => m.role !== 'system').map(storedMessageToInternal),
  });
  const estimate = app.calibration.apply(active.providerId, active.modelId, localEstimate);

  const computed = computeTarget(app, localEstimate);
  const budget = computeBudgetFor(app, estimate, computed);

  const entry = app.catalog.findModel(active.modelId, [active.providerId]);
  const providerConfig = app.getProviderConfig(active.providerId);
  const gate = evaluateBudgetGate(app, {
    estimatedInputTokens: estimate.tokens,
    effectiveBudget: budget.effectiveBudget,
    reservedOutputTokens: computed.reservedOutputTokens,
    providerId: active.providerId,
    modelId: active.modelId,
    profileId: computed.target.profileId,
    requestedTokens: computed.target.maxTokens,
    ...(entry?.contextLength !== undefined ? { modelContextLimit: entry.contextLength } : {}),
    ...(providerConfig?.inputLimit !== undefined
      ? { providerInputLimit: providerConfig.inputLimit }
      : {}),
  });

  return { target: computed.target, budget, estimate, gate, notes: computed.notes };
}

// ============================================================================
// Prepare (the real request path)
// ============================================================================

export async function prepareContextRequest(
  app: AppState,
  messages: StoredMessage[],
  options: PrepareContextOptions = {},
): Promise<PreparedContextRequest> {
  const active = app.activeModel();
  if (!active) {
    throw new Error(
      'No model selected. Run /models to browse models and /model <model> to select one.',
    );
  }

  const engine = app.config.contextEngine;
  const notes: string[] = [];
  const instructions = options.instructions ?? discoverInstructions(app.projectPath);

  // Activated skills (priority 5) and user-pinned files (priority 9).
  const skillItems = app.skills.promptItems();
  const skillsBlock = renderSkillsBlock(skillItems);
  const pinnedFiles = loadPinnedFiles(app);
  const pinnedBlock = renderPinnedBlock(pinnedFiles);
  const memoryBlock = app.memory.toPromptBlock();
  for (const pinned of pinnedFiles) {
    if (pinned.error) notes.push(`pinned file skipped: ${pinned.rel} — ${pinned.error}`);
  }

  // Retrieval (§26) — only when enabled, bounded, always fresh reads
  const retrievalEnabled = app.session.retrievalEnabled ?? engine.retrieval.enabled;
  let snippets: Snippet[] = [];
  if (retrievalEnabled && options.retrievalText && options.retrievalText.trim() !== '') {
    try {
      const index = app.getRepoIndex();
      index.ensureBuilt();
      snippets = buildRetrievalSnippets(index, options.retrievalText, {
        maxFiles: engine.retrieval.maxFiles,
        maxSnippetTokens: engine.retrieval.maxSnippetTokens,
      });
      if (snippets.length > 0) {
        notes.push(
          `retrieval: included ${snippets.length} snippet(s): ${snippets.map((s) => s.path).join(', ')}`,
        );
      }
    } catch (err) {
      notes.push(`retrieval failed and was skipped: ${(err as Error).message}`);
    }
  }

  let conversation = [...messages];
  let omittedMessages = 0;
  let compactedMessages = 0;
  let didCompact = false;
  let omissionNote: string | undefined;
  let estimate: TokenEstimate = { tokens: 0, source: 'local-heuristic', approximate: true };
  let computed: ComputedTarget | null = null;
  let budget: EffectiveBudget | null = null;
  let system = '';
  let autoNotesAdded = false;

  for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
    const retrievalBlock = snippets.length > 0 ? renderRetrievalBlock(snippets) : undefined;
    system = buildSystemPrompt(app.session, {
      ...(instructions.sources.length > 0 ? { instructions } : {}),
      ...(options.tools && options.tools.length > 0 ? { toolsEnabled: true } : {}),
      ...(options.contextPreamble ? { contextPreamble: options.contextPreamble } : {}),
      ...(retrievalBlock ? { retrievalBlock } : {}),
      ...(omissionNote ? { contextNote: omissionNote } : {}),
      ...(skillsBlock ? { skillsBlock } : {}),
      ...(pinnedBlock ? { pinnedBlock } : {}),
      ...(memoryBlock ? { memoryBlock } : {}),
      ...(options.mcpServers && options.mcpServers.length > 0
        ? { mcpServers: options.mcpServers }
        : {}),
    });

    const localEstimate = estimateRequestInputTokens({
      system,
      messages: conversation.filter((m) => m.role !== 'system').map(storedMessageToInternal),
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    });
    estimate = app.calibration.apply(active.providerId, active.modelId, localEstimate);

    const nextComputed = computeTarget(app, localEstimate);
    computed = nextComputed;
    if (!autoNotesAdded) {
      notes.push(...nextComputed.notes);
      autoNotesAdded = true;
    }
    budget = computeBudgetFor(app, estimate, nextComputed);

    if (estimate.tokens <= budget.effectiveBudget) break;

    // Overflow: compact once, then omit oldest messages
    if (
      !didCompact &&
      engine.autoCompact &&
      app.config.featureFlags.compaction !== false &&
      conversation.length > MIN_AUTO_COMPACT_MESSAGES + 1
    ) {
      const plan = planCompaction(app.session, {
        keepRecentMessages: DEFAULT_KEEP_RECENT_MESSAGES,
      });
      if (
        plan.compactable.length >= MIN_AUTO_COMPACT_MESSAGES &&
        plan.originalTokens > plan.summaryTokens
      ) {
        const applied = applyCompaction(app.session, plan, {
          preserveOriginal: engine.preserveOriginalHistory,
        });
        compactedMessages += applied.messagesReplaced;
        notes.push(
          `auto-compaction: replaced ${applied.messagesReplaced} older message(s) with a level-${applied.level} summary ` +
            `(${applied.tokensBefore} → ${applied.tokensAfter} estimated tokens; /compact restore can undo it while the payload is retained).`,
        );
        conversation = [...app.session.messages];
        didCompact = true;
        app.sessionManager.save(app.session);
        continue;
      }
    }

    const overhead = estimateRequestInputTokens({
      system,
      messages: [],
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    });
    const conversationBudget = Math.max(0, budget.effectiveBudget - overhead);
    const fitted = fitConversationToBudget(conversation, conversationBudget);
    if (fitted.omitted === 0 || fitted.included.length === 0) {
      throw new BudgetExceededError(
        `The request cannot fit the effective context budget (estimated ${estimate.tokens} tokens including system/tools; ` +
          `effective budget ${budget.effectiveBudget}).\n` +
          'The conversation itself cannot be reduced further. Options:\n' +
          '  • raise the context profile: /context <profile-id> or /context <tokens>\n' +
          '  • reduce the output reserve: /output-limit <tokens>\n' +
          '  • start a new session or /compact, or select a model with a larger window.',
      );
    }
    omittedMessages += fitted.omitted;
    conversation = fitted.included;
    omissionNote =
      `Earlier messages were omitted to fit the context budget: ${omittedMessages} message(s) were not sent (oldest first). ` +
      `Original history remains in the session file (/session export). Use /compact to summarize instead of dropping, ` +
      'or raise the budget with /context.';
    notes.push(omissionNote);
  }

  if (!budget || !computed) {
    // Defensive: the loop always runs at least once
    throw new BudgetExceededError('Context preparation failed internally.');
  }
  if (estimate.tokens > budget.effectiveBudget) {
    throw new BudgetExceededError(
      `The request still exceeds the effective budget after compaction/omission (estimated ${estimate.tokens} tokens, budget ${budget.effectiveBudget}). ` +
        'Use a larger context profile or model, or shorten the conversation.',
    );
  }

  // Build the request (system override includes retrieval/omission/note blocks)
  const request = buildChatRequest(app, conversation, {
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    systemOverride: system,
  });

  // Optional provider count endpoint (§28)
  if (engine.countTokensEndpoint !== 'off') {
    try {
      const adapter = await app.getAdapter(active.providerId);
      if (adapter.countTokens) {
        const underPressure =
          engine.countTokensEndpoint === 'always' ||
          estimate.tokens >= budget.effectiveBudget * 0.7;
        if (underPressure) {
          const counted = await adapter.countTokens(request);
          if (Number.isFinite(counted) && counted > 0) {
            estimate = {
              tokens: Math.round(counted),
              source: 'provider-endpoint',
              approximate: false,
              note: 'counted by the provider token-count endpoint for this exact request',
            };
            // Re-check against the budget with the authoritative number
            budget = computeBudgetFor(app, estimate, computed);
            if (estimate.tokens > budget.effectiveBudget) {
              throw new BudgetExceededError(
                `The provider counted ${estimate.tokens} input tokens for this request, above the effective budget of ${budget.effectiveBudget}. ` +
                  'Reduce the conversation (/compact, smaller profile inputs) or raise the budget with /context.',
              );
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      notes.push(
        `provider token count unavailable; using the local estimate: ${(err as Error).message}`,
      );
    }
  }

  // Budget gate (§30)
  const entry = app.catalog.findModel(active.modelId, [active.providerId]);
  const providerConfig = app.getProviderConfig(active.providerId);
  let gate: BudgetGateDecision;
  if (options.skipGate) {
    gate = {
      action: 'allow',
      reasons: [],
      checks: [{ name: 'budget gate', status: 'skipped', detail: 'gate skipped by the caller' }],
      estimate: {
        inputTokens: estimate.tokens,
        currency: entry?.pricing?.currency ?? 'USD',
        costNote: 'gate skipped',
      },
    };
  } else {
    gate = evaluateBudgetGate(app, {
      estimatedInputTokens: estimate.tokens,
      effectiveBudget: budget.effectiveBudget,
      reservedOutputTokens: computed.reservedOutputTokens,
      providerId: active.providerId,
      modelId: active.modelId,
      profileId: computed.target.profileId,
      requestedTokens: computed.target.maxTokens,
      ...(entry?.contextLength !== undefined ? { modelContextLimit: entry.contextLength } : {}),
      ...(providerConfig?.inputLimit !== undefined
        ? { providerInputLimit: providerConfig.inputLimit }
        : {}),
    });

    if (gate.action === 'block') {
      throw new BudgetGateError(gate);
    }
    if (gate.action === 'confirm') {
      const approved = options.onBudgetConfirm
        ? await options.onBudgetConfirm(gate)
        : app.autoApprove;
      if (!approved) {
        throw new BudgetGateError({
          ...gate,
          action: 'block',
          reasons: [
            ...gate.reasons,
            options.onBudgetConfirm
              ? 'confirmation was denied by the user'
              : 'the request requires confirmation, but no interactive confirmation is available (run interactively or pass --yes)',
          ],
        });
      }
      notes.push('budget gate confirmation granted for this request');
    }
  }

  // Count the input estimate for requests that pass the gate (§29)
  app.recordEstimatedInput(estimate.tokens);

  // Assembly report (§25/§31)
  const candidates: ContextCandidate[] = [];
  candidates.push({
    id: 'system',
    type: 'system',
    label: 'system policy and mode prompt',
    provenance: `mode: ${app.session.mode}; includes safety rules and response style`,
    content: system,
    trust: 'system',
    mandatory: true,
    tokens: estimateRequestInputTokens({ system, messages: [] }),
  });
  for (const source of instructions.sources) {
    candidates.push({
      id: `instructions:${source.displayPath}`,
      type: 'project-instruction',
      label: `${source.displayPath} (${source.bytes} bytes)`,
      provenance: `${source.scope} instructions file discovered in the workspace`,
      content: source.content,
      trust: 'lower-trust',
      mandatory: true,
    });
  }
  for (const item of skillItems) {
    candidates.push({
      id: `skill:${item.name}`,
      type: 'skill',
      label: `${item.name} (${item.scope}${item.trustLevel === 'untrusted' ? ', untrusted' : ''})`,
      provenance: 'activated by the user; instructions loaded from SKILL.md',
      content: item.instructions,
      trust: 'lower-trust',
    });
  }

  const memoryPromptBlock = app.memory.toPromptBlock();
  if (memoryPromptBlock) {
    candidates.push({
      id: 'memory:project',
      type: 'memory',
      label: `project memory (${app.memory.stats().entries} entries)`,
      provenance: 'persistent project memory (§48); facts and inferences with provenance',
      content: memoryPromptBlock,
      trust: 'lower-trust',
    });
  }
  for (const pinned of pinnedFiles) {
    if (pinned.error) continue;
    candidates.push({
      id: `pinned:${pinned.rel}`,
      type: 'pinned',
      label: `${pinned.rel} (${pinned.bytes} bytes${pinned.truncated ? ', truncated' : ''})`,
      provenance: 'pinned by the user (/context pin); re-read from disk for this request',
      content: pinned.content,
      trust: 'user',
    });
  }
  if (options.contextPreamble) {
    candidates.push({
      id: 'task-preamble',
      type: 'task',
      label: 'current task context',
      provenance: 'provided by the calling command for this request only',
      content: options.contextPreamble,
      trust: 'user',
      mandatory: true,
    });
  }
  if (options.tools && options.tools.length > 0) {
    candidates.push({
      id: 'tools',
      type: 'system',
      label: `${options.tools.length} native tool schema(s)`,
      provenance: 'tool registry filtered for the session mode',
      content: JSON.stringify(options.tools),
      trust: 'system',
      mandatory: true,
    });
  }
  for (const snippet of snippets) {
    candidates.push({
      id: `source:${snippet.path}`,
      type: 'source',
      label: snippet.path,
      provenance: snippet.provenance,
      content: snippet.content,
      trust: 'lower-trust',
    });
  }
  const conversationLabel =
    `conversation: ${conversation.length} message(s)` +
    (omittedMessages > 0 ? ` (${omittedMessages} omitted)` : '');
  candidates.push({
    id: 'conversation',
    type: 'conversation',
    label: conversationLabel,
    provenance:
      omittedMessages > 0
        ? 'session messages, oldest omitted to fit the budget'
        : 'session messages, newest first',
    content: '',
    trust: 'user',
    mandatory: true,
    tokens: conversation.reduce(
      (sum, m) => sum + estimateMessageTokens(storedMessageToInternal(m)),
      0,
    ),
  });
  for (const message of conversation.filter((m) => m.summaryMeta)) {
    candidates.push({
      id: `summary:${message.id}`,
      type: 'summary',
      label: `compaction summary (level ${message.summaryMeta!.level}, covers ${message.summaryMeta!.covers} messages)`,
      provenance: 'generated by /compact or automatic compaction',
      content: '',
      trust: 'system',
      tokens: estimateMessageTokens(storedMessageToInternal(message)),
    });
  }

  const assembly = assembleContext(candidates, { effectiveBudget: budget.effectiveBudget });

  const report: ContextReportSummary = {
    at: new Date().toISOString(),
    estimatedInputTokens: estimate.tokens,
    estimateSource: estimate.source,
    ...(estimate.note ? { estimateNote: estimate.note } : {}),
    requestedTokens: computed.target.maxTokens,
    requestOrigin: computed.target.origin,
    ...(budget.modelContextLimit !== undefined
      ? { modelContextLimit: budget.modelContextLimit }
      : {}),
    ...(budget.providerInputLimit !== undefined
      ? { providerInputLimit: budget.providerInputLimit }
      : {}),
    reservedOutputTokens: budget.reservedOutputTokens,
    safetyMargin: budget.safetyMargin,
    effectiveBudget: budget.effectiveBudget,
    remainingHeadroom: budget.remainingHeadroom,
    capabilitySource: `${budget.capability.label} [${budget.capability.source}${budget.capability.verified ? ', verified' : ', unverified'}]`,
    capabilityVerified: budget.capability.verified,
    items: assembly.items.map((item) => ({
      type: item.type,
      label: item.label,
      provenance: item.provenance,
      priority: CONTEXT_PRIORITY[item.type],
      tokens: item.tokens,
      included: item.included,
      reason: item.reason,
    })),
    omittedMessages,
    compactedMessages,
    retrievalFiles: snippets.map((s) => s.path),
    gateAction: gate.action,
    notes,
  };

  if (options.persistReport !== false) {
    app.session.lastContextReport = report;
    app.sessionManager.save(app.session);
  }

  return {
    request,
    budget,
    estimate,
    assembly,
    gate,
    target: computed.target,
    notes,
    omittedMessages,
    compactedMessages,
    retrievalFiles: snippets.map((s) => s.path),
    report,
  };
}
