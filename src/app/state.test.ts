import { describe, expect, it } from 'bun:test';
import { createTestApp, seedModels, testProvider } from './test-utils.js';

describe('AppState model resolution', () => {
  it('resolves provider/model for a configured provider', () => {
    const { app } = createTestApp({ providers: [testProvider()] });
    const resolution = app.resolveModel('test/vendor/alpha-model');
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind === 'resolved') {
      expect(resolution.providerId).toBe('test');
      expect(resolution.modelId).toBe('vendor/alpha-model');
    }
  });

  it('resolves a unique suffix from the catalog', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    const resolution = app.resolveModel('beta-fast');
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind === 'resolved') {
      expect(resolution.modelId).toBe('vendor/beta-fast');
    }
  });

  it('reports ambiguity instead of guessing', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: {
        test: [
          { id: 'vendor-a/shared', displayName: 'A' },
          { id: 'vendor-b/shared', displayName: 'B' },
        ],
      },
    });
    const resolution = app.resolveModel('shared');
    expect(resolution.kind).toBe('ambiguous');
    if (resolution.kind === 'ambiguous') {
      expect(resolution.candidates).toHaveLength(2);
    }
  });

  it('does not find unrelated models', () => {
    const { app } = createTestApp({ providers: [testProvider()] });
    expect(app.resolveModel('nothing-like-this').kind).toBe('not-found');
  });

  it('accepts explicit provider/model for undiscovered models', () => {
    const { app } = createTestApp({ providers: [testProvider()] });
    const resolution = app.resolveModel('test/brand/new-model');
    expect(resolution.kind).toBe('resolved');
  });

  it('selects and persists the active model', () => {
    const { app, sessionManager } = createTestApp({ providers: [testProvider()] });
    app.selectModel('test', 'vendor/alpha-model');

    expect(app.activeModel()).toEqual({ providerId: 'test', modelId: 'vendor/alpha-model' });
    const reloaded = sessionManager.load(app.session.id);
    expect(reloaded?.providerId).toBe('test');
    expect(reloaded?.modelId).toBe('vendor/alpha-model');
  });
});

describe('AppState adapter resolution', () => {
  it('throws when the provider is not configured', async () => {
    const { app } = createTestApp();
    await expect(app.getAdapter('missing')).rejects.toThrow(/Provider not configured/);
  });

  it('throws when the provider is disabled', async () => {
    const { app } = createTestApp({ providers: [testProvider({ enabled: false })] });
    await expect(app.getAdapter('test')).rejects.toThrow(/disabled/);
  });

  it('throws a credential error when the key is missing', async () => {
    const { app } = createTestApp({ providers: [testProvider()] });
    try {
      await app.getAdapter('test');
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toContain('TEST_API_KEY');
    }
  });

  it('builds an adapter when credentials resolve, and caches it', async () => {
    const { app, credentials } = createTestApp({ providers: [testProvider()] });
    await credentials.set('TEST_API_KEY', 'secret-value');

    const first = await app.getAdapter('test');
    const second = await app.getAdapter('test');
    expect(first).toBe(second);
    expect(first.id).toBe('test');
  });

  it('rebuilds the adapter after invalidation', async () => {
    const { app, credentials } = createTestApp({ providers: [testProvider()] });
    await credentials.set('TEST_API_KEY', 'secret-value');

    const first = await app.getAdapter('test');
    app.invalidateAdapter('test');
    const second = await app.getAdapter('test');
    expect(first).not.toBe(second);
  });
});

describe('AppState cost estimation', () => {
  it('estimates cost from catalog pricing', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });

    // alpha-model: input 1.5/M, output 6/M, cache read 0.15/M
    const { estimatedCost } = app.estimateCost('test', 'vendor/alpha-model', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 0,
    });
    expect(estimatedCost).toBeCloseTo(1.5 + 3.0);
  });

  it('applies cached input pricing', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: modelsWithCache() },
    });
    const { estimatedCost } = app.estimateCost('test', 'vendor/alpha-model', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(estimatedCost).toBeCloseTo(0.15);
  });

  it('returns no cost when pricing is unknown', () => {
    const { app } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });
    const { estimatedCost } = app.estimateCost('test', 'vendor/beta-fast', {
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(estimatedCost).toBeUndefined();
  });

  it('records usage into the session aggregate and persists it', () => {
    const { app, sessionManager } = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
    });

    app.recordUsage('test', 'vendor/alpha-model', { inputTokens: 1000, outputTokens: 200 });
    expect(app.session.usage.requests).toBe(1);
    expect(app.session.usage.inputTokens).toBe(1000);
    expect(app.session.usage.outputTokens).toBe(200);
    expect(app.session.usage.estimatedCost).toBeGreaterThan(0);

    const reloaded = sessionManager.load(app.session.id);
    expect(reloaded?.usage.inputTokens).toBe(1000);
  });
});

describe('AppState interruption tracking', () => {
  it('marks and clears the interrupted flag with persistence', () => {
    const { app, sessionManager } = createTestApp();

    app.markRequestStarted();
    expect(sessionManager.load(app.session.id)?.interrupted).toBe(true);

    app.markRequestFinished();
    expect(sessionManager.load(app.session.id)?.interrupted).toBe(false);
  });
});

function modelsWithCache() {
  return [
    {
      id: 'vendor/alpha-model',
      displayName: 'Alpha Model',
      pricing: { input: 1.5, output: 6, cacheRead: 0.15, currency: 'USD' },
    },
  ];
}
