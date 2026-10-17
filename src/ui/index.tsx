/**
 * Terminal User Interface (Ink + React).
 *
 * The TUI is a thin layer over AppState and the command registry:
 *  - chat input with slash-command autocomplete
 *  - streaming transcript with batching so large outputs stay responsive
 *  - model / session pickers
 *  - connection wizard
 *  - Esc cancels a generation; Ctrl+C aborts or exits
 */

import React from 'react';
import { render, Box, useApp, useInput } from 'ink';
import type { AppState } from '../app/state.js';
import { CommandRegistry } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtin/index.js';
import { parseInput } from '../commands/parser.js';
import { runAgentTurn } from '../agent/loop.js';
import { getLogger } from '../logger/index.js';
import { formatError } from '../errors/index.js';
import {
  connectProvider,
  defaultBaseUrl,
  defaultProviderId,
  type ConnectRequest,
} from '../app/connect.js';
import type { PermissionPromptResponse, PermissionRequest } from '../permissions/types.js';
import type { BudgetGateDecision } from '../budget/gate.js';
import { formatGateDecision } from '../budget/gate.js';
import type { ProviderType } from '../types/index.js';
import {
  appendDelta,
  applySuggestion,
  buildModelPickerItems,
  buildSessionPickerItems,
  computeSuggestions,
  finalizeEntry,
  hydrateTranscript,
  nextEntryId,
  permissionKeyDecision,
  pushEntry,
  statusParts,
  updateToolEntry,
  type TranscriptEntry,
} from './model.js';
import {
  BudgetGateView,
  ConnectWizardView,
  InputBar,
  PermissionView,
  PickerView,
  PROVIDER_TYPE_OPTIONS,
  StatusBar,
  Transcript,
  type WizardState,
} from './components.js';

export interface TUIOptions {
  initialPrompt?: string;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FLUSH_INTERVAL_MS = 40;
const HISTORY_LIMIT = 100;

type Overlay = 'chat' | 'model-picker' | 'session-picker' | 'connect' | 'permission' | 'budget';

function emptyWizard(): WizardState {
  return {
    step: 'type',
    typeIndex: 0,
    type: null,
    baseUrl: '',
    keyBuffer: '',
    description: '',
    resultOk: false,
    resultMessage: '',
    resultWarnings: [],
  };
}

// ============================================================================
// App root
// ============================================================================

function AppRoot({
  app,
  registry,
  options,
}: {
  app: AppState;
  registry: CommandRegistry;
  options: TUIOptions;
}) {
  const { exit } = useApp();
  const logger = getLogger();

  const [transcript, setTranscript] = React.useState<TranscriptEntry[]>(() =>
    hydrateTranscript(app.session),
  );
  const [inputValue, setInputValue] = React.useState('');
  const [suggestionIndex, setSuggestionIndex] = React.useState(0);
  const [overlay, setOverlay] = React.useState<Overlay>('chat');
  const [modelPicker, setModelPicker] = React.useState({ filter: '', index: 0 });
  const [sessionIndex, setSessionIndex] = React.useState(0);
  const [wizard, setWizard] = React.useState<WizardState>(emptyWizard);
  const [permissionState, setPermissionState] = React.useState<{
    request: PermissionRequest;
    resolve: (response: PermissionPromptResponse) => void;
  } | null>(null);
  const [budgetState, setBudgetState] = React.useState<{
    decision: BudgetGateDecision;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [generationState, setGenerationState] = React.useState<{
    active: boolean;
    label: string | null;
  }>({
    active: false,
    label: null,
  });
  const [spinnerIndex, setSpinnerIndex] = React.useState(0);

  const generationRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const pendingRef = React.useRef<{ text: string; reasoning: string }>({ text: '', reasoning: '' });
  const flushTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const activeAssistantIdRef = React.useRef<string | null>(null);
  const toolEntryIdsRef = React.useRef<Map<string, string>>(new Map());
  const historyRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef(-1);
  const initialSentRef = React.useRef(false);

  // --------------------------------------------------------------------------
  // Streaming flush (batched state updates)
  // --------------------------------------------------------------------------

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    const id = activeAssistantIdRef.current;
    if (!id || (pending.text === '' && pending.reasoning === '')) return;

    const text = pending.text;
    const reasoning = pending.reasoning;
    pending.text = '';
    pending.reasoning = '';

    setTranscript((prev) => {
      let next = prev;
      if (text !== '') next = appendDelta(next, id, 'text', text);
      if (reasoning !== '') next = appendDelta(next, id, 'reasoning', reasoning);
      return next;
    });
  }, []);

  const queueDelta = React.useCallback(
    (kind: 'text' | 'reasoning', chunk: string) => {
      if (kind === 'text') pendingRef.current.text += chunk;
      else pendingRef.current.reasoning += chunk;

      if (flushTimerRef.current === null) {
        flushTimerRef.current = setInterval(flush, FLUSH_INTERVAL_MS);
      }
    },
    [flush],
  );

  const stopFlush = React.useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flush();
  }, [flush]);

  // Spinner while generating
  React.useEffect(() => {
    if (!generationState.active) return;
    const timer = setInterval(() => setSpinnerIndex((i) => (i + 1) % SPINNER.length), 100);
    return () => clearInterval(timer);
  }, [generationState.active]);

  // Save the session when the TUI exits
  React.useEffect(() => {
    return () => {
      try {
        app.saveSession();
      } catch {
        // best effort on shutdown
      }
    };
  }, [app]);

  // Resume notice
  React.useEffect(() => {
    if (app.session.messages.length > 0) {
      setTranscript((prev) =>
        pushEntry(prev, {
          role: 'system',
          content:
            `Resumed session "${app.session.name}" (${app.session.messages.length} messages). ` +
            `/clear empties the view, /session new starts fresh.`,
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Sending messages
  // --------------------------------------------------------------------------

  const send = React.useCallback(
    async (text: string, sendOptions: { contextPreamble?: string } = {}) => {
      if (generationRef.current) return;

      setTranscript((prev) => pushEntry(prev, { role: 'user', content: text }));

      const assistantId = nextEntryId('a');
      activeAssistantIdRef.current = assistantId;
      toolEntryIdsRef.current = new Map();
      setTranscript((prev) =>
        pushEntry(prev, { id: assistantId, role: 'assistant', content: '', streaming: true }),
      );

      generationRef.current = true;
      setGenerationState({ active: true, label: 'connecting…' });
      const controller = new AbortController();
      abortRef.current = controller;

      const startAssistantEntry = () => {
        stopFlush();
        const previousId = activeAssistantIdRef.current;
        if (previousId) {
          setTranscript((prev) => finalizeEntry(prev, previousId, {}));
        }
        const nextId = nextEntryId('a');
        activeAssistantIdRef.current = nextId;
        setTranscript((prev) =>
          pushEntry(prev, { id: nextId, role: 'assistant', content: '', streaming: true }),
        );
      };

      try {
        const result = await runAgentTurn(app, text, {
          signal: controller.signal,
          ...(sendOptions.contextPreamble ? { contextPreamble: sendOptions.contextPreamble } : {}),
          onPermissionRequest: (request) =>
            new Promise<PermissionPromptResponse>((resolve) => {
              setPermissionState({ request, resolve });
              setOverlay('permission');
              setGenerationState((state) => ({ ...state, label: 'waiting for approval…' }));
            }),
          onBudgetConfirm: (decision) =>
            new Promise<boolean>((resolve) => {
              setBudgetState({ decision, resolve });
              setOverlay('budget');
              setGenerationState((state) => ({
                ...state,
                label: 'waiting for budget confirmation…',
              }));
            }),
          onEvent: (event) => {
            switch (event.type) {
              case 'text-delta':
                queueDelta('text', event.text);
                break;
              case 'reasoning-delta':
                queueDelta('reasoning', event.text);
                break;
              case 'context-prepared': {
                const notable =
                  event.compactedMessages > 0 ||
                  event.omittedMessages > 0 ||
                  event.retrievalFiles.length > 0 ||
                  event.gateAction !== 'allow';
                if (notable) {
                  const parts: string[] = [];
                  if (event.compactedMessages > 0) {
                    parts.push(
                      `compacted ${event.compactedMessages} older message(s) into a summary (/compact restore can undo)`,
                    );
                  }
                  if (event.omittedMessages > 0) {
                    parts.push(
                      `omitted ${event.omittedMessages} earlier message(s) to fit the budget (/compact summarizes; /context budget explains)`,
                    );
                  }
                  if (event.retrievalFiles.length > 0) {
                    parts.push(`retrieved ${event.retrievalFiles.join(', ')}`);
                  }
                  if (event.gateAction === 'confirm') {
                    parts.push('budget confirmation was granted for this request');
                  }
                  setTranscript((prev) =>
                    pushEntry(prev, {
                      role: 'system',
                      content: `context: ${parts.join(' · ')} — est. ${event.estimatedInputTokens}/${event.effectiveBudget} tokens`,
                    }),
                  );
                }
                break;
              }
              case 'iteration-started':
                if (event.iteration > 1) startAssistantEntry();
                setGenerationState((state) => ({ ...state, label: 'streaming…' }));
                break;
              case 'tool-started': {
                const entryId = nextEntryId('t');
                toolEntryIdsRef.current.set(event.call.id, entryId);
                setTranscript((prev) =>
                  pushEntry(prev, {
                    id: entryId,
                    role: 'tool',
                    content: event.summary,
                    tool: { name: event.call.name, status: 'running' },
                  }),
                );
                setGenerationState((state) => ({ ...state, label: `tool: ${event.call.name}…` }));
                break;
              }
              case 'tool-finished': {
                const entryId = toolEntryIdsRef.current.get(event.call.id);
                if (entryId) {
                  setTranscript((prev) =>
                    updateToolEntry(prev, entryId, {
                      content: event.record.result ?? '',
                      tool: {
                        name: event.record.name,
                        status: event.record.isError ? 'error' : 'ok',
                        durationMs: event.record.durationMs,
                      },
                    }),
                  );
                }
                setGenerationState((state) => ({ ...state, label: 'streaming…' }));
                break;
              }
              case 'completed':
                if (event.toolCalls === 0 && event.iterations === 1) {
                  // plain chat turn — nothing extra to show
                }
                setGenerationState((state) => ({ ...state, label: 'finalizing…' }));
                break;
              case 'cancelled':
              case 'error':
                break;
              default:
                break;
            }
          },
        });

        stopFlush();
        const finalId = activeAssistantIdRef.current;
        if (finalId) {
          setTranscript((prev) => finalizeEntry(prev, finalId, {}));
        }

        if (result.error) {
          setTranscript((prev) =>
            pushEntry(prev, { role: 'error', content: result.error!.message }),
          );
        } else if (result.cancelled) {
          setTranscript((prev) =>
            pushEntry(prev, {
              role: 'system',
              content: 'Cancelled — partial output is kept in the session.',
            }),
          );
        } else if (result.exhausted) {
          setTranscript((prev) =>
            pushEntry(prev, {
              role: 'system',
              content: 'Stopped at the agent iteration limit — see the session note for details.',
            }),
          );
        }
      } catch (err) {
        stopFlush();
        const finalId = activeAssistantIdRef.current;
        if (finalId) {
          setTranscript((prev) => finalizeEntry(prev, finalId, {}));
        }
        setTranscript((prev) => pushEntry(prev, { role: 'error', content: formatError(err) }));
        logger.error('Chat request failed', { error: formatError(err) });
      } finally {
        activeAssistantIdRef.current = null;
        generationRef.current = false;
        abortRef.current = null;
        setPermissionState(null);
        setBudgetState(null);
        setGenerationState({ active: false, label: null });
      }
    },
    [app, logger, queueDelta, stopFlush],
  );

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  const runCommand = React.useCallback(
    async (value: string): Promise<boolean> => {
      const parsed = parseInput(value);
      if (parsed.kind !== 'command') return false;

      const result = await registry.dispatch(parsed, {
        generationActive: generationRef.current,
      });
      if (!result) return false;

      if (result.action) {
        switch (result.action.type) {
          case 'exit':
            exit();
            return true;
          case 'cancel-generation':
            abortRef.current?.abort();
            return true;
          case 'clear-conversation':
            setTranscript(hydrateTranscript(app.session));
            return true;
          case 'start-agent-turn': {
            if (result.output) {
              setTranscript((prev) => pushEntry(prev, { role: 'system', content: result.output! }));
            }
            const action = result.action;
            void send(action.prompt, {
              ...(action.contextPreamble ? { contextPreamble: action.contextPreamble } : {}),
            });
            return true;
          }
          case 'open-model-picker':
            setModelPicker({ filter: '', index: 0 });
            setOverlay('model-picker');
            return true;
          case 'open-session-picker':
            setSessionIndex(0);
            setOverlay('session-picker');
            return true;
          case 'open-connect-wizard':
            setWizard(emptyWizard());
            setOverlay('connect');
            return true;
        }
      }

      if (result.output) {
        setTranscript((prev) => pushEntry(prev, { role: 'system', content: result.output! }));
      }
      if (!result.ok && result.error) {
        const errorText = result.error;
        setTranscript((prev) => pushEntry(prev, { role: 'error', content: errorText }));
      }
      return true;
    },
    [app, exit, registry, send],
  );

  const submit = React.useCallback(
    async (explicit?: string) => {
      const value = explicit ?? inputValue;
      setInputValue('');
      setSuggestionIndex(0);
      if (value.trim() === '') return;

      historyRef.current = [value, ...historyRef.current].slice(0, HISTORY_LIMIT);
      historyIndexRef.current = -1;

      if (parseInput(value).kind === 'command') {
        const handled = await runCommand(value);
        if (handled) return;
      }

      if (generationRef.current) {
        setTranscript((prev) =>
          pushEntry(prev, {
            role: 'system',
            content:
              'A response is generating — press Esc to cancel before sending another message.',
          }),
        );
        return;
      }

      await send(value);
    },
    [inputValue, runCommand, send],
  );

  // --------------------------------------------------------------------------
  // Initial prompt
  // --------------------------------------------------------------------------

  React.useEffect(() => {
    if (initialSentRef.current) return;
    initialSentRef.current = true;
    const prompt = options.initialPrompt;
    if (!prompt) return;

    void (async () => {
      const parsed = parseInput(prompt);
      if (parsed.kind === 'command') {
        const handled = await runCommand(prompt);
        if (handled) return;
      }
      await send(prompt);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Keyboard
  // --------------------------------------------------------------------------

  const closeOverlay = () => {
    setOverlay('chat');
    setWizard(emptyWizard());
    setInputValue('');
  };

  const selectModel = (key: string) => {
    const slash = key.indexOf('/');
    if (slash <= 0) return;
    const providerId = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    app.selectModel(providerId, modelId);
    closeOverlay();
    setTranscript((prev) =>
      pushEntry(prev, { role: 'system', content: `Active model: ${providerId}/${modelId}` }),
    );
  };

  const selectSession = (id: string) => {
    const session = app.sessionManager.load(id);
    if (!session) {
      closeOverlay();
      setTranscript((prev) =>
        pushEntry(prev, { role: 'error', content: `Session not found: ${id}` }),
      );
      return;
    }
    app.switchSession(session);
    setTranscript(hydrateTranscript(session));
    closeOverlay();
    setTranscript((prev) =>
      pushEntry(prev, {
        role: 'system',
        content:
          `Resumed session "${session.name}" (${session.messages.length} messages).` +
          (session.interrupted ? ' Note: the previous run ended mid-request.' : ''),
      }),
    );
  };

  const runWizardConnect = React.useCallback(
    async (state: WizardState) => {
      const request: ConnectRequest = {
        providerType: state.type ?? 'xkiro',
        id: defaultProviderId(state.type ?? 'xkiro'),
      };
      if (state.baseUrl.trim() !== '') request.baseUrl = state.baseUrl.trim();
      if (state.keyBuffer.startsWith('env:')) {
        request.apiKeyEnv = state.keyBuffer.slice(4);
      } else if (state.keyBuffer !== '') {
        request.apiKey = state.keyBuffer;
      }

      try {
        const result = await connectProvider(app, request);
        setWizard((w) => ({
          ...w,
          step: 'done',
          resultOk: result.ok,
          resultMessage: result.message,
          resultWarnings: result.warnings,
        }));
        setTranscript((prev) =>
          pushEntry(prev, { role: result.ok ? 'system' : 'error', content: result.message }),
        );
      } catch (err) {
        const message = formatError(err);
        setWizard((w) => ({
          ...w,
          step: 'done',
          resultOk: false,
          resultMessage: message,
          resultWarnings: [],
        }));
        setTranscript((prev) => pushEntry(prev, { role: 'error', content: message }));
      }
    },
    [app],
  );

  const handleWizardInput = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    const state = wizard;

    if (state.step === 'running') return;

    if (state.step === 'done') {
      if (key.return || key.escape) closeOverlay();
      return;
    }

    if (key.escape) {
      closeOverlay();
      return;
    }

    if (state.step === 'type') {
      if (key.upArrow) {
        setWizard((w) => ({
          ...w,
          typeIndex:
            (w.typeIndex - 1 + PROVIDER_TYPE_OPTIONS.length) % PROVIDER_TYPE_OPTIONS.length,
        }));
      } else if (key.downArrow) {
        setWizard((w) => ({ ...w, typeIndex: (w.typeIndex + 1) % PROVIDER_TYPE_OPTIONS.length }));
      } else if (key.return) {
        const option = PROVIDER_TYPE_OPTIONS[state.typeIndex]!;
        setWizard((w) => ({
          ...w,
          type: option.type,
          baseUrl: defaultBaseUrl(option.type) ?? '',
          step: 'base-url',
        }));
      }
      return;
    }

    if (state.step === 'base-url') {
      if (key.return) {
        setWizard((w) => ({ ...w, step: 'api-key' }));
      } else if (key.backspace || key.delete) {
        setWizard((w) => ({ ...w, baseUrl: w.baseUrl.slice(0, -1) }));
      } else if (input) {
        setWizard((w) => ({ ...w, baseUrl: w.baseUrl + input }));
      }
      return;
    }

    if (state.step === 'api-key') {
      if (key.return) {
        setWizard((w) => ({ ...w, step: 'confirm' }));
      } else if (key.backspace || key.delete) {
        setWizard((w) => ({ ...w, keyBuffer: w.keyBuffer.slice(0, -1) }));
      } else if (input) {
        setWizard((w) => ({ ...w, keyBuffer: w.keyBuffer + input }));
      }
      return;
    }

    if (state.step === 'confirm') {
      if (key.return) {
        setWizard((w) => ({ ...w, step: 'running' }));
        void runWizardConnect(state);
      }
      return;
    }
  };

  const modelPickerItems = React.useMemo(
    () => (overlay === 'model-picker' ? buildModelPickerItems(app, modelPicker.filter) : []),
    [app, overlay, modelPicker.filter],
  );
  const sessionPickerItems = React.useMemo(
    () => (overlay === 'session-picker' ? buildSessionPickerItems(app) : []),
    [app, overlay],
  );

  useInput((input, key) => {
    if (overlay === 'budget') {
      if (key.ctrl && input === 'c') {
        const pending = budgetState;
        setBudgetState(null);
        setOverlay('chat');
        abortRef.current?.abort();
        pending?.resolve(false);
        return;
      }
      const answer = input.trim().toLowerCase();
      if (answer === 'y') {
        const resolve = budgetState?.resolve;
        setBudgetState(null);
        setOverlay('chat');
        setGenerationState((state) => ({ ...state, label: 'streaming…' }));
        resolve?.(true);
        return;
      }
      if (answer === 'n' || key.escape) {
        const resolve = budgetState?.resolve;
        setBudgetState(null);
        setOverlay('chat');
        setGenerationState((state) => ({ ...state, label: 'streaming…' }));
        resolve?.(false);
        return;
      }
      return;
    }

    if (overlay === 'permission') {
      if (key.ctrl && input === 'c') {
        const pending = permissionState;
        setPermissionState(null);
        setOverlay('chat');
        abortRef.current?.abort();
        pending?.resolve({ decision: 'deny' });
        return;
      }
      const decision = permissionKeyDecision(input, key);
      if (decision && permissionState) {
        const resolve = permissionState.resolve;
        setPermissionState(null);
        setOverlay('chat');
        setGenerationState((state) => ({ ...state, label: 'streaming…' }));
        resolve({ decision });
      }
      return;
    }

    if (overlay === 'connect') {
      handleWizardInput(input, key);
      return;
    }

    if (overlay === 'model-picker') {
      if (key.escape) {
        closeOverlay();
      } else if (key.upArrow) {
        setModelPicker((p) => ({ ...p, index: Math.max(0, p.index - 1) }));
      } else if (key.downArrow) {
        setModelPicker((p) => ({
          ...p,
          index: Math.min(modelPickerItems.length - 1, p.index + 1),
        }));
      } else if (key.return) {
        const item = modelPickerItems[modelPicker.index];
        if (item) selectModel(item.key);
      } else if (key.backspace || key.delete) {
        setModelPicker((p) => ({ filter: p.filter.slice(0, -1), index: 0 }));
      } else if (input && !key.ctrl && !key.meta) {
        setModelPicker((p) => ({ filter: p.filter + input, index: 0 }));
      }
      return;
    }

    if (overlay === 'session-picker') {
      if (key.escape) {
        closeOverlay();
      } else if (key.upArrow) {
        setSessionIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSessionIndex((i) => Math.min(sessionPickerItems.length - 1, i + 1));
      } else if (key.return) {
        const item = sessionPickerItems[sessionIndex];
        if (item) selectSession(item.key);
      }
      return;
    }

    // Chat
    if (key.ctrl && input === 'c') {
      if (generationRef.current) {
        abortRef.current?.abort();
      } else {
        logger.info('User requested exit');
        exit();
      }
      return;
    }

    if (key.escape) {
      if (generationRef.current) {
        abortRef.current?.abort();
      } else if (inputValue !== '') {
        setInputValue('');
      }
      return;
    }

    if (key.return) {
      if (key.shift) {
        setInputValue((v) => `${v}\n`);
        return;
      }
      void submit();
      return;
    }

    const suggestions = computeSuggestions(registry, inputValue);
    if (key.tab && suggestions.length > 0) {
      setInputValue(applySuggestion(inputValue, suggestions[suggestionIndex] ?? suggestions[0]!));
      setSuggestionIndex(0);
      return;
    }

    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSuggestionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (historyRef.current.length > 0) {
        historyIndexRef.current = Math.min(
          historyIndexRef.current + 1,
          historyRef.current.length - 1,
        );
        setInputValue(historyRef.current[historyIndexRef.current]!);
      }
      return;
    }

    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSuggestionIndex((i) => (i + 1) % suggestions.length);
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
        setInputValue(historyRef.current[historyIndexRef.current]!);
      } else if (historyIndexRef.current === 0) {
        historyIndexRef.current = -1;
        setInputValue('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((v) => v.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      // A chunk of input can carry multiple characters (paste, fast typing,
      // or scripted stdin through a pty). A chunk that is a single line with
      // a trailing newline counts as Enter; multi-line chunks stay as text
      // (pastes must not auto-submit).
      const cleaned = input.replace(/\r\n?/g, '\n');
      const hasTrailingNewline = /[\r\n]$/.test(input);
      const lines = cleaned.split('\n');
      const isSingleLine = lines.length - 1 <= 1;

      if (hasTrailingNewline && isSingleLine) {
        void submit(`${inputValue}${lines[0] ?? ''}`);
      } else {
        setInputValue((v) => v + cleaned);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const suggestions = overlay === 'chat' ? computeSuggestions(registry, inputValue) : [];
  const status = statusParts(app);

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar
        status={status}
        generation={generationState.active ? generationState.label : null}
        spinner={SPINNER[spinnerIndex]!}
      />
      <Transcript entries={transcript} />

      {overlay === 'model-picker' && (
        <PickerView
          title="Models"
          items={modelPickerItems}
          selectedIndex={modelPicker.index}
          filter={modelPicker.filter}
          emptyMessage="No models discovered. Close with Esc, then run /models refresh or /connect."
          hint="↑/↓ select · Enter choose · type to filter · Esc close"
        />
      )}

      {overlay === 'session-picker' && (
        <PickerView
          title="Sessions"
          items={sessionPickerItems}
          selectedIndex={sessionIndex}
          emptyMessage="No saved sessions."
          hint="↑/↓ select · Enter resume · Esc close"
        />
      )}

      {overlay === 'connect' && <ConnectWizardView state={wizard} />}

      {overlay === 'permission' && permissionState && (
        <PermissionView
          summary={permissionState.request.summary}
          {...(permissionState.request.detail !== undefined
            ? { detail: permissionState.request.detail }
            : {})}
          permissionClass={permissionState.request.permissionClass}
          destructive={permissionState.request.destructive === true}
        />
      )}

      {overlay === 'budget' && budgetState && <BudgetGateView decision={budgetState.decision} />}

      {overlay === 'chat' && (
        <InputBar
          value={inputValue}
          suggestions={suggestions}
          selectedIndex={suggestionIndex}
          busy={generationState.active}
        />
      )}
    </Box>
  );
}

// ============================================================================
// Entry point
// ============================================================================

export async function startTUI(app: AppState, options: TUIOptions = {}): Promise<void> {
  const logger = getLogger();
  logger.info('Starting mediaXG TUI');

  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);

  const instance = render(<AppRoot app={app} registry={registry} options={options} />);
  await instance.waitUntilExit();
}
