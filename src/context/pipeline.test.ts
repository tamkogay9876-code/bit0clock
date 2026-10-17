/**
 * Context pipeline tests (§23–§30).
 *
 * Covers the request path end to end with deterministic mocks:
 * budget computation, trimming, auto-compaction, retrieval, the budget gate
 * (block/confirm/fallback), the optional provider count endpoint, and report
 * persistence. No network traffic is used.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import { defaultConfig } from '../config/schema.js';
import type { AppConfigInput } from '../config/schema.js';
import type { SessionData } from '../session/types.js';
import type { ProviderConfig } from '../types/index.js';
import { mockFetch, jsonResponse, errorResponse } from '../providers/test-utils.js';
import {
  BudgetExceededError,
  BudgetGateError,
  fitConversationToBudget,
  loadPinnedFiles,
  PIN_MAX_BYTES,
  PIN_MAX_FILES,
  prepareContextRequest,
  previewContextBudget,
} from './pipeline.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-pipe-'));
}

function userMessage(content: string, id: string) {
  return { id, role: 'user' as const, content, timestamp: new Date().toISOString() };
}

function fillMessages(session: SessionData, count: number, contentChars: number): void {
  for (let i = 0; i < count; i++) {
    session.messages.push(userMessage(`message ${i} ${'x'.repeat(contentChars)}`, `m${i}`));
  }
}

describe('fitConversationToBudget', () => {
  test('keeps newest messages within the budget and drops leading tool results', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'first', timestamp: '' },
      {
        id: 'a1',
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'x' } }],
        timestamp: '',
      },
      {
        id: 't1',
        role: 'tool' as const,
        content: '',
        toolResults: [{ toolCallId: 'c1', content: 'result' }],
        timestamp: '',
      },
      { id: 'u2', role: 'user' as const, content: 'y'.repeat(400), timestamp: '' },
    ];
    const fitted = fitConversationToBudget(messages, 110);
    expect(fitted.included.map((m) => m.id)).toEqual(['u2']);
    expect(fitted.omitted).toBe(3);
  });

  test('the newest message is included even when it alone exceeds the budget', () => {
    const fitted = fitConversationToBudget(
      [{ id: 'u1', role: 'user' as const, content: 'z'.repeat(4000), timestamp: '' }],
      10,
    );
    expect(fitted.included.map((m) => m.id)).toEqual(['u1']);
    expect(fitted.omitted).toBe(0);
  });

  test('system-role stored messages never count toward or occupy the budget', () => {
    const fitted = fitConversationToBudget(
      [
        { id: 's1', role: 'system' as const, content: 'x'.repeat(4000), timestamp: '' },
        { id: 'u1', role: 'user' as const, content: 'short', timestamp: '' },
      ],
      100,
    );
    expect(fitted.included.map((m) => m.id)).toEqual(['u1']);
    expect(fitted.omitted).toBe(0);
  });
});

describe('prepareContextRequest — budget and trimming', () => {
  test('fits a small conversation and persists the report', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello there', 'u1'));
    app.session.messages.push(userMessage('second question', 'u2'));

    const prepared = await prepareContextRequest(app, app.session.messages);

    expect(prepared.omittedMessages).toBe(0);
    expect(prepared.compactedMessages).toBe(0);
    expect(prepared.request.messages).toHaveLength(2);
    expect(prepared.budget.effectiveBudget).toBe(128_000 - 8_000 - 4_000);
    expect(prepared.estimate.tokens).toBeLessThanOrEqual(prepared.budget.effectiveBudget);
    expect(prepared.gate.action).toBe('allow');
    expect(prepared.report.gateAction).toBe('allow');
    expect(prepared.report.requestOrigin).toBe('profile');
    expect(prepared.report.items.length).toBeGreaterThan(0);

    // Report persisted, preflight estimate counted, original history untouched
    expect(app.session.lastContextReport?.estimatedInputTokens).toBe(prepared.estimate.tokens);
    expect(app.session.usage.estimatedInputTokens).toBe(prepared.estimate.tokens);
    expect(app.session.usage.requests).toBe(0); // no provider response yet
    expect(app.session.messages).toHaveLength(2);
  });

  test('conversations above the strictest limit are trimmed oldest-first with an explicit note', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/beta-fast'); // 32k reported window
    fillMessages(app.session, 15, 10_000); // ~2.5k tokens per message

    const originalCount = app.session.messages.length;
    const prepared = await prepareContextRequest(app, app.session.messages);

    expect(prepared.omittedMessages).toBeGreaterThan(0);
    expect(prepared.request.messages.length).toBeLessThan(originalCount);
    expect(prepared.request.system).toContain('Earlier messages were omitted');
    expect(prepared.notes.join(' ')).toContain('omitted');
    expect(prepared.report.omittedMessages).toBe(prepared.omittedMessages);
    expect(prepared.estimate.tokens).toBeLessThanOrEqual(prepared.budget.effectiveBudget);

    // The full history remains in the session file
    expect(app.session.messages).toHaveLength(originalCount);
    // Oldest messages were dropped: the newest id must be present
    const lastKept = prepared.request.messages.at(-1)!;
    expect(lastKept.content).toContain('message 14');
  });

  test('auto-compaction runs once before trimming and is undoable', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/beta-fast');
    fillMessages(app.session, 40, 3_200); // ~32k tokens total, compaction should fit

    const prepared = await prepareContextRequest(app, app.session.messages);

    expect(prepared.compactedMessages).toBeGreaterThanOrEqual(4);
    expect(prepared.omittedMessages).toBe(0);
    expect(prepared.notes.join(' ')).toContain('auto-compaction');
    expect(app.session.summaries?.length).toBe(1);
    expect(app.session.messages[0]!.summaryMeta?.level).toBe(1);
    expect(app.session.compactedChunks?.[0]?.payloadRetained).toBe(true);
    expect(
      prepared.request.messages.some((m) => String(m.content).includes('compaction summary')),
    ).toBe(true);
    expect(prepared.report.compactedMessages).toBe(prepared.compactedMessages);
  });

  test('a message that alone cannot fit raises BudgetExceededError with actionable options', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/beta-fast');
    app.session.contextProfile = 'small'; // 32k profile − 4k reserve − 2k margin = 26k budget
    app.session.messages.push(userMessage('x'.repeat(160_000), 'huge'));

    await expect(prepareContextRequest(app, app.session.messages)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    try {
      await prepareContextRequest(app, app.session.messages);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('/context');
      expect(message).toContain('/output-limit');
    }
    // Nothing was counted or persisted
    expect(app.session.usage.estimatedInputTokens).toBe(0);
    expect(app.session.lastContextReport).toBeUndefined();
  });

  test('custom requested tokens override the profile', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.requestedContext = 40_000;
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.target.origin).toBe('custom');
    expect(prepared.report.requestedTokens).toBe(40_000);
    expect(prepared.budget.effectiveBudget).toBe(40_000 - 8_000 - 4_000);
  });

  test('auto profile resolves a concrete budget from the model window', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.contextProfile = 'auto';
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.target.auto).toBe(true);
    expect(prepared.target.maxTokens).toBeGreaterThan(0);
    expect(prepared.report.requestOrigin).toBe('auto');
    expect(prepared.budget.effectiveBudget).toBe(
      prepared.target.maxTokens -
        prepared.budget.reservedOutputTokens -
        prepared.budget.safetyMargin,
    );
  });

  test('confirm gate with no interactive confirmation blocks with an explanation', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          largeContextConfirmationThreshold: 1_000,
        },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    try {
      await prepareContextRequest(app, app.session.messages);
      throw new Error('expected BudgetGateError');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetGateError);
      const gateError = err as BudgetGateError;
      expect(gateError.decision.action).toBe('block');
      expect(gateError.message).toContain('no interactive confirmation is available');
      expect(gateError.message).toContain('--yes');
    }
    expect(app.session.usage.estimatedInputTokens).toBe(0);
  });

  test('confirm gate approval via callback is recorded as a note', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          largeContextConfirmationThreshold: 1_000,
        },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    let asked = false;
    const prepared = await prepareContextRequest(app, app.session.messages, {
      onBudgetConfirm: async (decision) => {
        asked = true;
        expect(decision.action).toBe('confirm');
        return true;
      },
    });
    expect(asked).toBe(true);
    expect(prepared.gate.action).toBe('confirm');
    expect(prepared.notes.join(' ')).toContain('confirmation granted');
    expect(app.session.usage.estimatedInputTokens).toBeGreaterThan(0);
  });

  test('denied confirmation blocks and nothing is counted', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          largeContextConfirmationThreshold: 1_000,
        },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    try {
      await prepareContextRequest(app, app.session.messages, {
        onBudgetConfirm: async () => false,
      });
      throw new Error('expected BudgetGateError');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetGateError);
      expect((err as Error).message).toContain('denied by the user');
    }
    expect(app.session.usage.estimatedInputTokens).toBe(0);
  });

  test('--yes (autoApprove) satisfies the confirm gate without a callback', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      autoApprove: true,
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          largeContextConfirmationThreshold: 1_000,
        },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.notes.join(' ')).toContain('confirmation granted');
  });

  test('a blocked gate raises before anything is counted or persisted', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      configOverrides: {
        spendingLimits: { ...defaultConfig.spendingLimits, maxPerRequest: 0.000001 },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    await expect(prepareContextRequest(app, app.session.messages)).rejects.toBeInstanceOf(
      BudgetGateError,
    );
    expect(app.session.lastContextReport).toBeUndefined();
    expect(app.session.usage.estimatedInputTokens).toBe(0);
  });

  test('skipGate bypasses the gate for preview paths only', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      configOverrides: {
        spendingLimits: { ...defaultConfig.spendingLimits, maxPerRequest: 0.000001 },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages, { skipGate: true });
    expect(prepared.gate.checks[0]!.name).toBe('budget gate');
    expect(prepared.gate.action).toBe('allow');
  });

  test('persistReport false keeps the session free of the report', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));
    const prepared = await prepareContextRequest(app, app.session.messages, {
      persistReport: false,
    });
    expect(prepared.report.estimatedInputTokens).toBeGreaterThan(0);
    expect(app.session.lastContextReport).toBeUndefined();
  });
});

describe('prepareContextRequest — retrieval (§26)', () => {
  function retrievalConfig(enabled: boolean): AppConfigInput['contextEngine'] {
    return {
      ...structuredClone(defaultConfig.contextEngine),
      retrieval: {
        ...structuredClone(defaultConfig.contextEngine.retrieval),
        enabled,
      },
    };
  }

  test('disabled by default: no snippets, no index work', async () => {
    const projectPath = workspace();
    mkdirSync(join(projectPath, 'src'), { recursive: true });
    writeFileSync(join(projectPath, 'src/alphaService.ts'), 'export const alphaService = 1;\n');

    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath,
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('fix src/alphaService.ts', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages, {
      retrievalText: 'fix src/alphaService.ts',
    });
    expect(prepared.retrievalFiles).toEqual([]);
    expect(prepared.notes.join(' ')).not.toContain('retrieval:');
  });

  test('enabled: a mentioned path is included with provenance and stays fresh', async () => {
    const projectPath = workspace();
    mkdirSync(join(projectPath, 'src'), { recursive: true });
    const filePath = join(projectPath, 'src/alphaService.ts');
    writeFileSync(filePath, 'export const alphaService = 1;\n');

    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath,
      configOverrides: { contextEngine: retrievalConfig(true) },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('fix src/alphaService.ts', 'u1'));

    // File changes after the index is built; retrieval must re-read from disk
    writeFileSync(filePath, 'export const alphaService = 2; // updated marker\n');

    const prepared = await prepareContextRequest(app, app.session.messages, {
      retrievalText: 'fix src/alphaService.ts',
    });
    expect(prepared.retrievalFiles).toContain('src/alphaService.ts');
    expect(prepared.notes.join(' ')).toContain('retrieval: included 1 snippet');
    expect(prepared.request.system).toContain('Automatically retrieved');
    expect(prepared.request.system).toContain('updated marker');
    expect(prepared.report.retrievalFiles).toContain('src/alphaService.ts');
    const sourceItem = prepared.report.items.find((item) => item.type === 'source');
    expect(sourceItem?.included).toBe(true);
    expect(sourceItem?.provenance).toContain('src/alphaService.ts');
  });

  test('session override turns retrieval on when the config is off (and vice versa)', async () => {
    const projectPath = workspace();
    mkdirSync(join(projectPath, 'src'), { recursive: true });
    writeFileSync(join(projectPath, 'src/alphaService.ts'), 'export const alphaService = 1;\n');

    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath,
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('fix src/alphaService.ts', 'u1'));

    app.session.retrievalEnabled = true;
    const on = await prepareContextRequest(app, app.session.messages, {
      retrievalText: 'fix src/alphaService.ts',
    });
    expect(on.retrievalFiles).toEqual(['src/alphaService.ts']);

    app.session.retrievalEnabled = false;
    const off = await prepareContextRequest(app, app.session.messages, {
      retrievalText: 'fix src/alphaService.ts',
    });
    expect(off.retrievalFiles).toEqual([]);
  });
});

describe('prepareContextRequest — provider count endpoint (§28)', () => {
  function anthropicProvider(): ProviderConfig {
    return testProvider({
      id: 'anth',
      type: 'anthropic-compatible',
      baseUrl: 'https://anthropic.test/v1',
      credentialRef: 'ANTH_API_KEY',
    });
  }

  function engineWith(
    countTokensEndpoint: 'off' | 'pressure' | 'always',
  ): AppConfigInput['contextEngine'] {
    return {
      ...structuredClone(defaultConfig.contextEngine),
      countTokensEndpoint,
    };
  }

  test('"always" uses the provider count and marks it authoritative', async () => {
    const mock = mockFetch([jsonResponse({ input_tokens: 12_345 })]);
    const { app, credentials } = createTestApp({
      providers: [anthropicProvider()],
      catalog: { anth: seedModels() },
      fetchImpl: mock.fetchImpl,
      configOverrides: { contextEngine: engineWith('always') },
    });
    await credentials.set('ANTH_API_KEY', 'key');
    app.selectModel('anth', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.estimate.tokens).toBe(12_345);
    expect(prepared.estimate.source).toBe('provider-endpoint');
    expect(prepared.estimate.approximate).toBe(false);
    expect(prepared.report.estimateSource).toBe('provider-endpoint');
    expect(mock.calls[0]!.url).toBe('https://anthropic.test/v1/messages/count_tokens');
  });

  test('"pressure" skips the count when the local estimate is far below the budget', async () => {
    const mock = mockFetch([]);
    const { app, credentials } = createTestApp({
      providers: [anthropicProvider()],
      catalog: { anth: seedModels() },
      fetchImpl: mock.fetchImpl,
      configOverrides: { contextEngine: engineWith('pressure') },
    });
    await credentials.set('ANTH_API_KEY', 'key');
    app.selectModel('anth', 'vendor/alpha-model');
    app.session.messages.push(userMessage('short message', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.estimate.source).toBe('local-heuristic');
    expect(mock.calls).toHaveLength(0);
  });

  test('a provider count above the effective budget raises BudgetExceededError', async () => {
    const mock = mockFetch([jsonResponse({ input_tokens: 200_000 })]);
    const { app, credentials } = createTestApp({
      providers: [anthropicProvider()],
      catalog: { anth: seedModels() },
      fetchImpl: mock.fetchImpl,
      configOverrides: { contextEngine: engineWith('always') },
    });
    await credentials.set('ANTH_API_KEY', 'key');
    app.selectModel('anth', 'vendor/beta-fast'); // 32k window → 20k budget
    app.session.messages.push(userMessage('hello', 'u1'));

    await expect(prepareContextRequest(app, app.session.messages)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(app.session.usage.estimatedInputTokens).toBe(0);
  });

  test('a failing count endpoint falls back to the local estimate with a note', async () => {
    const mock = mockFetch([errorResponse(500, { error: 'boom' })]);
    const { app, credentials } = createTestApp({
      providers: [anthropicProvider()],
      catalog: { anth: seedModels() },
      fetchImpl: mock.fetchImpl,
      configOverrides: { contextEngine: engineWith('always') },
    });
    await credentials.set('ANTH_API_KEY', 'key');
    app.selectModel('anth', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.estimate.source).toBe('local-heuristic');
    expect(prepared.notes.join(' ')).toContain('provider token count unavailable');
    expect(app.session.usage.estimatedInputTokens).toBeGreaterThan(0);
  });

  test('"off" never calls the endpoint even under pressure', async () => {
    const mock = mockFetch([]);
    const { app, credentials } = createTestApp({
      providers: [anthropicProvider()],
      catalog: { anth: seedModels() },
      fetchImpl: mock.fetchImpl,
      configOverrides: { contextEngine: engineWith('off') },
    });
    await credentials.set('ANTH_API_KEY', 'key');
    app.selectModel('anth', 'vendor/beta-fast');
    fillMessages(app.session, 6, 8_000);

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.estimate.source).toBe('local-heuristic');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('previewContextBudget', () => {
  test('computes the budget without side effects', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    const preview = previewContextBudget(app);
    expect(preview.budget.effectiveBudget).toBe(128_000 - 8_000 - 4_000);
    expect(preview.estimate.tokens).toBeGreaterThan(0);
    expect(preview.gate.action).toBe('allow');
    expect(app.session.lastContextReport).toBeUndefined();
    expect(app.session.usage.estimatedInputTokens).toBe(0);
  });

  test('uses calibration for the displayed estimate when samples exist', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));

    const before = previewContextBudget(app).estimate.tokens;
    app.calibration.record('test', 'vendor/alpha-model', before, before * 2);
    const after = previewContextBudget(app).estimate;
    expect(after.source).toBe('calibrated-local');
    expect(after.tokens).toBe(before * 2);
  });

  test('no active model → explicit error', () => {
    const { app } = createTestApp({ providers: [testProvider()] });
    expect(() => previewContextBudget(app)).toThrow('No model selected');
  });
});

describe('prepareContextRequest — pinned files and skills (§25, §32)', () => {
  test('loadPinnedFiles reads fresh from disk, caps count and bytes, and tolerates errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-pin-'));
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });
    app.selectModel('test', 'vendor/alpha-model');

    const pinned: string[] = [];
    for (let i = 0; i < 25; i++) {
      const rel = `file-${i}.txt`;
      writeFileSync(join(dir, rel), `content ${i}`);
      pinned.push(rel);
    }
    app.session.pinnedPaths = pinned;
    const files = loadPinnedFiles(app);
    expect(files).toHaveLength(PIN_MAX_FILES);

    app.session.pinnedPaths = ['does/not/exist.txt'];
    const missing = loadPinnedFiles(app);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.error).toBeTruthy();
    expect(missing[0]!.content).toBe('');

    const big = 'x'.repeat(PIN_MAX_BYTES + 5_000);
    writeFileSync(join(dir, 'big.txt'), big);
    app.session.pinnedPaths = ['big.txt'];
    const truncated = loadPinnedFiles(app)[0]!;
    expect(truncated.truncated).toBe(true);
    expect(truncated.bytes).toBeGreaterThan(PIN_MAX_BYTES);
    expect(truncated.content.length).toBeLessThanOrEqual(PIN_MAX_BYTES);
  });

  test('pins outside the workspace or that escape are refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-pin2-'));
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.pinnedPaths = ['../outside.txt'];
    const result = loadPinnedFiles(app);
    expect(result[0]!.error).toBeTruthy();
    expect(result[0]!.content).toBe('');
  });

  test('prepareContextRequest adds pinned files as a pinned candidate and to the system prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-pin3-'));
    writeFileSync(join(dir, 'notes.md'), 'Pinned note body');
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.session.messages.push(userMessage('hello', 'u1'));
    app.session.pinnedPaths = ['notes.md'];

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.assembly.items.some((c) => c.type === 'pinned')).toBe(true);
    expect(prepared.request.system).toContain('Pinned context');
    expect(prepared.request.system).toContain('Pinned note body');
    writeFileSync(join(dir, 'notes.md'), 'CHANGED PINNED BODY');
    const second = await prepareContextRequest(app, app.session.messages);
    expect(second.request.system).toContain('CHANGED PINNED BODY');
    expect(second.request.system).not.toContain('Pinned note body');
  });

  test('prepareContextRequest adds active skills as a skill candidate and to the system prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-skill-'));
    const skillDir = join(dir, '.agents/skills/team-style');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: team-style\ndescription: House style rules\n---\nAlways use two-space indentation.',
    );
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.skills.reload();
    app.skills.activate('team-style');
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    expect(prepared.assembly.items.some((c) => c.type === 'skill')).toBe(true);
    expect(prepared.request.system).toContain('Active skills');
    expect(prepared.request.system).toContain('Always use two-space indentation.');
    expect(prepared.request.system).toContain('never change permissions');
    app.skills.deactivate('team-style');
    const inactive = await prepareContextRequest(app, app.session.messages);
    expect(inactive.assembly.items.some((c) => c.type === 'skill')).toBe(false);
    expect(inactive.request.system).not.toContain('Active skills');
  });

  test('pinned and skill candidates are labeled untrusted in the assembly report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediaxg-untrust-'));
    writeFileSync(join(dir, 'pin.txt'), 'pinned body');
    const skillDir = join(dir, '.agents/skills/s1');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: s1\ndescription: d\n---\nbody');
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      projectPath: dir,
    });
    app.selectModel('test', 'vendor/alpha-model');
    app.skills.reload();
    app.skills.activate('s1');
    app.session.pinnedPaths = ['pin.txt'];
    app.session.messages.push(userMessage('hello', 'u1'));

    const prepared = await prepareContextRequest(app, app.session.messages);
    const skill = prepared.assembly.items.find((c) => c.type === 'skill');
    const pinned = prepared.assembly.items.find((c) => c.type === 'pinned');
    expect(skill?.trust).toBe('lower-trust');
    expect(pinned?.trust).toBe('user');
  });
});
