/**
 * Phase E command tests: /context, /compact, /usage, /budget (°22–°31).
 *
 * Everything here runs against deterministic in-memory state; the only
 * network path exercised (/budget balance) uses the shared mock fetch.
 */

import { describe, expect, it } from 'bun:test';
import { CommandRegistry } from '../registry.js';
import { registerBuiltinCommands } from './index.js';
import { parseInput } from '../parser.js';
import type { CommandResult } from '../types.js';
import { createTestApp, seedModels, testProvider } from '../../app/test-utils.js';
import { defaultConfig } from '../../config/schema.js';
import type { AppConfigInput } from '../../config/schema.js';
import type { AppState } from '../../app/state.js';
import type { SessionData } from '../../session/types.js';
import { prepareContextRequest } from '../../context/pipeline.js';
import { mockFetch, jsonResponse } from '../../providers/test-utils.js';

function makeApp(
  options: {
    models?: boolean;
    select?: boolean;
    configOverrides?: Partial<AppConfigInput>;
    providers?: ReturnType<typeof testProvider>[];
  } = {},
) {
  return createTestApp({
    providers: options.providers ?? [testProvider()],
    ...(options.models !== false ? { catalog: { test: seedModels() } } : {}),
    ...(options.configOverrides ? { configOverrides: options.configOverrides } : {}),
  });
}

function registryFor(app: AppState): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);
  return registry;
}

async function run(app: AppState, input: string): Promise<CommandResult> {
  const result = await registryFor(app).dispatch(parseInput(input));
  if (!result) throw new Error(`Not a command: ${input}`);
  return result;
}

function fillMessages(session: SessionData, count: number): void {
  for (let i = 0; i < count; i++) {
    session.messages.push({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content:
        i === 0
          ? 'You must never break the public API.'
          : `message ${i} about the refactor plan ${'x'.repeat(40)}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
}

// ============================================================================
// /context
// ============================================================================

describe('/context', () => {
  it('shows profile, requested budget, model window, retrieval, and last request', async () => {
    const { app } = makeApp();
    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(app, '/context');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('profile        standard');
    expect(result.output).toContain('requested      128k tokens');
    expect(result.output).toContain('model window   128k tokens');
    expect(result.output).toContain('retrieval      off (session override: none');
    expect(result.output).toContain('last request   no request assembled yet');
  });

  it('shows a custom override and the missing-profile warning', async () => {
    const { app } = makeApp();
    app.session.requestedContext = 64_000;
    const custom = await run(app, '/context');
    expect(custom.output).toContain('requested      64k tokens (custom override)');

    app.session.requestedContext = undefined;
    app.session.contextProfile = 'nonsense';
    const unknown = await run(app, '/context');
    expect(unknown.output).toContain('NOT in the configured profiles!');
  });

  it('/context profile lists the configured profiles with the current marker', async () => {
    const { app } = makeApp();
    const result = await run(app, '/context profile');
    expect(result.output).toContain('standard');
    expect(result.output).toContain('[config default]');
    expect(result.output).toContain('auto (runtime-determined)');
    expect(result.output).toContain('* standard');
  });

  it('/context small selects a profile and clears a custom override', async () => {
    const { app } = makeApp();
    app.session.requestedContext = 64_000;
    const result = await run(app, '/context small');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Context profile: small');
    expect(app.session.contextProfile).toBe('small');
    expect(app.session.requestedContext).toBeUndefined();
  });

  it('/context 256k warns when the requested budget exceeds the model window', async () => {
    const { app } = makeApp();
    app.selectModel('test', 'vendor/alpha-model'); // 128k window
    const result = await run(app, '/context 256k');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Requested context budget: 256k tokens');
    expect(result.output).toContain('Warning:');
    expect(result.output).toContain('the requested 256k tokens is larger');
    expect(result.output).toContain('Profiles that fit:');
    expect(app.session.requestedContext).toBe(256_000);
    expect(app.session.contextProfile).toBe('custom');
  });

  it('/context rejects too-small and unknown targets', async () => {
    const { app } = makeApp();
    const small = await run(app, '/context 500');
    expect(small.ok).toBe(false);
    expect(small.error).toContain('minimum is 1000');

    const unknown = await run(app, '/context banana');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Unknown context target');
    expect(unknown.error).toContain('/context profile');
  });

  it('/context reset returns to the configured default', async () => {
    const { app } = makeApp();
    app.session.contextProfile = 'custom';
    app.session.requestedContext = 200_000;
    const result = await run(app, '/context reset');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('reset to the configured default: standard');
    expect(app.session.contextProfile).toBe('standard');
    expect(app.session.requestedContext).toBeUndefined();
  });

  it('/context budget reports all nine values plus the gate, and requires a model', async () => {
    const { app } = makeApp();
    const noModel = await run(app, '/context budget');
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toContain('No model selected');

    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(app, '/context budget');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('requested budget');
    expect(result.output).toContain('model context limit');
    expect(result.output).toContain('provider input limit');
    expect(result.output).toContain('reserved output capacity');
    expect(result.output).toContain('safety margin');
    expect(result.output).toContain('estimated input tokens');
    expect(result.output).toContain('effective request budget');
    expect(result.output).toContain('remaining headroom');
    expect(result.output).toContain('capability source');
    expect(result.output).toContain('Budget gate: ALLOW');
    expect(result.output).toContain('Token estimate:');
  });

  it('/context inspect explains nothing exists before the first request, then shows provenance', async () => {
    const { app } = makeApp();
    app.selectModel('test', 'vendor/alpha-model');
    const before = await run(app, '/context inspect');
    expect(before.output).toContain('No request has been assembled yet');

    app.session.messages.push({
      id: 'm1',
      role: 'user',
      content: 'please look at the code',
      timestamp: new Date().toISOString(),
    });
    await prepareContextRequest(app, app.session.messages);

    const after = await run(app, '/context inspect');
    expect(after.output).toContain('Last context assembly:');
    expect(after.output).toContain('Included items');
    expect(after.output).toContain('why:');
    expect(after.output).toContain('from:');
    expect(after.output).toContain('capability');
  });

  it('/context inspect surfaces omitted/compacted/retrieval lines from the report', async () => {
    const { app } = makeApp();
    app.selectModel('test', 'vendor/alpha-model');
    const report = {
      at: new Date().toISOString(),
      estimatedInputTokens: 100,
      estimateSource: 'local-heuristic',
      requestedTokens: 128_000,
      requestOrigin: 'profile' as const,
      reservedOutputTokens: 8000,
      safetyMargin: 4000,
      effectiveBudget: 116_000,
      remainingHeadroom: 115_900,
      capabilitySource: 'test [provider-api, unverified]',
      capabilityVerified: false,
      items: [],
      omittedMessages: 3,
      compactedMessages: 5,
      retrievalFiles: ['src/a.ts'],
      gateAction: 'allow' as const,
      notes: ['a note'],
    };
    app.session.lastContextReport = report;
    const result = await run(app, '/context inspect');
    expect(result.output).toContain('compacted        5 older message(s) summarized');
    expect(result.output).toContain('omitted          3 earlier message(s) dropped for budget');
    expect(result.output).toContain('retrieval        src/a.ts');
    expect(result.output).toContain('• a note');
  });

  it('/context retrieval toggles the session override and rejects bad values', async () => {
    const { app } = makeApp();
    const status = await run(app, '/context retrieval');
    expect(status.output).toContain('Automatic repository retrieval is OFF');
    expect(status.output).toContain('config default: off');

    const on = await run(app, '/context retrieval on');
    expect(on.ok).toBe(true);
    expect(app.session.retrievalEnabled).toBe(true);
    expect(on.output).toContain('enabled for this session');
    expect(on.output).toContain('always re-reads file contents');

    const off = await run(app, '/context retrieval off');
    expect(off.ok).toBe(true);
    expect(app.session.retrievalEnabled).toBe(false);

    const bad = await run(app, '/context retrieval maybe');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Usage: /context retrieval on|off');
  });
});

// ============================================================================
// /compact
// ============================================================================

describe('/compact', () => {
  it('preview reports the plan without changing the session', async () => {
    const { app } = makeApp();
    fillMessages(app.session, 20);
    const before = app.session.messages.length;

    const result = await run(app, '/compact preview --keep=4');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Compaction preview (nothing changed):');
    expect(result.output).toContain('messages to replace  16');
    expect(result.output).toContain('messages kept        4');
    expect(result.output).toContain('Preserved sections:');
    expect(result.output).toContain('Hard constraints');
    expect(app.session.messages.length).toBe(before);
    expect(app.session.summaries).toBeUndefined();
  });

  it('says so when nothing is outside the recent window', async () => {
    const { app } = makeApp();
    fillMessages(app.session, 5);
    const result = await run(app, '/compact');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Nothing to compact');
  });

  it('runs, lists summaries, and restores the original messages', async () => {
    const { app } = makeApp();
    fillMessages(app.session, 20);
    const originalIds = app.session.messages.map((m) => m.id);

    const runResult = await run(app, '/compact --keep=4');
    expect(runResult.ok).toBe(true);
    expect(runResult.output).toContain('Conversation compacted:');
    expect(runResult.output).toContain('messages replaced  16');
    expect(runResult.output).toContain('original history   retained');
    expect(app.session.messages.length).toBe(5);
    expect(app.session.messages[0]!.summaryMeta?.level).toBe(1);

    const summaries = await run(app, '/compact summaries');
    expect(summaries.output).toContain('level 1');
    expect(summaries.output).toContain('covers 16 message(s)');
    expect(summaries.output).toContain('original messages retained');

    const restore = await run(app, '/compact restore');
    expect(restore.ok).toBe(true);
    expect(app.session.messages.map((m) => m.id)).toEqual(originalIds);
    expect(app.session.summaries).toEqual([]);
  });

  it('restore without history explains why it cannot', async () => {
    const { app } = makeApp();
    fillMessages(app.session, 20);
    const result = await run(app, '/compact restore');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Nothing to restore');
  });

  it('rejects a bad --keep and unknown subcommands', async () => {
    const { app } = makeApp();
    fillMessages(app.session, 20);
    const badKeep = await run(app, '/compact ls --keep=1');
    expect(badKeep.ok).toBe(false);
    expect(badKeep.error).toContain('--keep expects');

    const unknown = await run(app, '/compact frobnicate');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Unknown subcommand: /compact frobnicate');
  });

  it('respects preserveOriginalHistory=false and does not promise restore', async () => {
    const { app } = makeApp({
      configOverrides: {
        contextEngine: {
          ...structuredClone(defaultConfig.contextEngine),
          preserveOriginalHistory: false,
        },
      },
    });
    fillMessages(app.session, 20);
    const result = await run(app, '/compact --keep=4');
    expect(result.output).toContain('NOT retained');
    const restore = await run(app, '/compact restore');
    expect(restore.ok).toBe(false);
    expect(restore.error).toContain('not retained');
  });
});

// ============================================================================
// /usage
// ============================================================================

describe('/usage', () => {
  it('separates reported and estimated input and labels the cost as a local estimate', async () => {
    const { app } = makeApp();
    app.selectModel('test', 'vendor/alpha-model');
    app.session.usage.inputTokens = 10_000;
    app.session.usage.outputTokens = 500;
    app.session.usage.estimatedInputTokens = 9_500;
    app.session.usage.estimatedCost = 0.03;
    app.session.usage.requests = 2;

    const result = await run(app, '/usage');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('input reported    10000 (10k)');
    expect(result.output).toContain(
      'input estimated   9500 (9.5k) — preflight estimates of sent requests',
    );
    expect(result.output).toContain('estimated cost    $0.0300 USD');
    expect(result.output).toContain('LOCAL ESTIMATE');
    expect(result.output).toContain('Pricing (snapshot used for local estimates):');
    expect(result.output).toContain('/budget balance');
  });

  it('says pricing is unknown when the catalog has none', async () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: [{ id: 'vendor/no-pricing', contextLength: 32_000, tools: true }] },
    });
    app.selectModel('test', 'vendor/no-pricing');
    const result = await run(app, '/usage');
    expect(result.output).toContain('Pricing: unknown');
    expect(result.output).toContain('check the provider dashboard');
  });
});

// ============================================================================
// /budget
// ============================================================================

describe('/budget', () => {
  it('shows the configured limits, local spend, and the unknown-balance statement', async () => {
    const { app } = makeApp({
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          maxPerRequest: 0.5,
          maxDaily: 5,
          maxMonthly: 100,
          largeContextConfirmationThreshold: 200_000,
        },
      },
    });
    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(app, '/budget');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('per request     $0.5000 USD');
    expect(result.output).toContain('daily           $5.0000 USD');
    expect(result.output).toContain('monthly         $100.0000 USD');
    expect(result.output).toContain('large-context confirmation threshold  200000 tokens');
    expect(result.output).toContain('Local spend (estimated):');
    expect(result.output).toContain('Provider balance: unknown from local state.');
    expect(result.output).toContain('never presented as the provider');
    expect(result.output).toContain('Remaining today (estimated):');
  });

  it('marks the unknown-balance policy as inactive without a minimum', async () => {
    const { app } = makeApp();
    const result = await run(app, '/budget');
    expect(result.output).toContain('minimum verified balance  not required');
    expect(result.output).toContain('(inactive until a minimum balance is configured)');
  });

  it('rejects unknown subcommands', async () => {
    const { app } = makeApp();
    const result = await run(app, '/budget topup');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown subcommand: /budget topup');
  });

  it('/budget balance requires a model and explains providers without an interface', async () => {
    const { app, credentials } = makeApp();
    const noModel = await run(app, '/budget balance');
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toContain('No model selected');

    await credentials.set('TEST_API_KEY', 'key');
    app.selectModel('test', 'vendor/alpha-model');
    const result = await run(app, '/budget balance');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('exposes no documented balance/usage interface');
    expect(result.output).toContain('never estimates official account balances');
  });

  it('/budget balance shows provider-reported values for xKiro', async () => {
    const mock = mockFetch([jsonResponse({ balance: 12.5, currency: 'USD' })]);
    const { app, credentials } = createTestApp({
      providers: [
        testProvider({
          id: 'xkiro',
          type: 'xkiro',
          baseUrl: 'https://api.xkiro.com',
          credentialRef: 'XKIRO_API_KEY',
        }),
      ],
      catalog: { xkiro: seedModels() },
      fetchImpl: mock.fetchImpl,
    });
    await credentials.set('XKIRO_API_KEY', 'key');
    app.selectModel('xkiro', 'vendor/alpha-model');

    const result = await run(app, '/budget balance');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Provider balance (xkiro)');
    expect(result.output).toContain('balance');
    expect(result.output).toContain('12.5000 USD');
    expect(result.output).toContain("returned by the provider's documented endpoint");
    expect(mock.calls[0]!.url).toBe('https://api.xkiro.com/v1/usage');
  });

  it('/budget balance does not invent values when the shape is unrecognized', async () => {
    const mock = mockFetch([jsonResponse({ weird_shape: { nested: true } })]);
    const { app, credentials } = createTestApp({
      providers: [
        testProvider({
          id: 'xkiro',
          type: 'xkiro',
          baseUrl: 'https://api.xkiro.com',
          credentialRef: 'XKIRO_API_KEY',
        }),
      ],
      catalog: { xkiro: seedModels() },
      fetchImpl: mock.fetchImpl,
    });
    await credentials.set('XKIRO_API_KEY', 'key');
    app.selectModel('xkiro', 'vendor/alpha-model');

    const result = await run(app, '/budget balance');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('balance NOT available');
    expect(result.output).toContain('no values are invented');
  });
});
