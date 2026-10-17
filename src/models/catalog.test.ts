/**
 * Model catalog tests: caching, expiry, discovery failure behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ModelCatalog } from './catalog.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ProviderAdapter, DiscoveredModel } from '../providers/types.js';
import type { ProviderMetadata } from '../types/index.js';

function makeFakeAdapter(modelScript: Array<DiscoveredModel[] | Error>): {
  adapter: ProviderAdapter;
  calls: () => number;
} {
  let callCount = 0;
  const adapter: ProviderAdapter = {
    id: 'fake',
    metadata: {
      id: 'fake',
      type: 'openai-compatible',
      displayName: 'Fake',
      baseUrl: 'https://x',
      protocol: 'openai-chat',
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsReasoning: false,
      supportsImageInput: false,
      supportsTokenCounting: false,
      enabled: true,
      verified: false,
    } as ProviderMetadata,
    async *chat() {
      // unused
    },
    async listModels(): Promise<DiscoveredModel[]> {
      const script = modelScript[Math.min(callCount, modelScript.length - 1)]!;
      callCount++;
      if (script instanceof Error) throw script;
      return script;
    },
  };
  return { adapter, calls: () => callCount };
}

describe('ModelCatalog', () => {
  let tempDir: string;
  let cachePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mediaxg-catalog-'));
    cachePath = join(tempDir, 'models-cache.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers models and persists the cache', async () => {
    const { adapter, calls } = makeFakeAdapter([
      [{ id: 'vendor/model-a', contextLength: 128000, tools: true }, { id: 'vendor/model-b' }],
    ]);
    const catalog = new ModelCatalog({ cachePath });

    const result = await catalog.listModels('prov', adapter);
    expect(result.models.length).toBe(2);
    expect(result.fromCache).toBe(false);
    expect(calls()).toBe(1);
    expect(existsSync(cachePath)).toBe(true);

    const saved = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(saved.providers.prov.fetchedAt).toBeDefined();
  });

  it('serves fresh cache without a network call', async () => {
    const { adapter, calls } = makeFakeAdapter([[{ id: 'm1' }]]);
    const catalog = new ModelCatalog({ cachePath });

    await catalog.listModels('prov', adapter);
    const second = await catalog.listModels('prov', adapter);

    expect(calls()).toBe(1); // no second network call
    expect(second.fromCache).toBe(true);
    expect(second.stale).toBe(false);
  });

  it('refreshes when forceRefresh is set', async () => {
    const { adapter, calls } = makeFakeAdapter([[{ id: 'm1' }], [{ id: 'm1' }, { id: 'm2' }]]);
    const catalog = new ModelCatalog({ cachePath });

    await catalog.listModels('prov', adapter);
    const refreshed = await catalog.listModels('prov', adapter, { forceRefresh: true });

    expect(calls()).toBe(2);
    expect(refreshed.models.length).toBe(2);
    expect(refreshed.fromCache).toBe(false);
  });

  it('marks data stale after TTL expiry', async () => {
    let nowMs = 1000000;
    const { adapter } = makeFakeAdapter([[{ id: 'm1' }]]);
    const catalog = new ModelCatalog({
      cachePath,
      cacheTtlMs: 1000,
      now: () => nowMs,
    });

    await catalog.listModels('prov', adapter);
    nowMs += 5000; // advance past TTL

    const cached = catalog.getCached('prov');
    expect(cached).not.toBeNull();
    expect(cached!.stale).toBe(true);
  });

  it('returns clearly-marked stale cache when refresh fails (never claims zero models)', async () => {
    const { adapter } = makeFakeAdapter([[{ id: 'm1' }, { id: 'm2' }], new Error('network down')]);
    const catalog = new ModelCatalog({ cachePath });

    await catalog.listModels('prov', adapter);
    const result = await catalog.listModels('prov', adapter, { forceRefresh: true });

    expect(result.models.length).toBe(2); // cached models still shown
    expect(result.fromCache).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.refreshError).toContain('network down');
  });

  it('reports refresh error with no cache instead of empty success', async () => {
    const { adapter } = makeFakeAdapter([new Error('connection refused')]);
    const catalog = new ModelCatalog({ cachePath });

    const result = await catalog.listModels('prov', adapter);
    expect(result.models.length).toBe(0);
    expect(result.refreshError).toContain('connection refused');
  });

  it('merges manual models and marks them as manual', async () => {
    const { adapter } = makeFakeAdapter([[{ id: 'discovered/model' }]]);
    const catalog = new ModelCatalog({ cachePath });

    const result = await catalog.listModels('prov', adapter, {
      manualModels: [
        {
          id: 'manual/model',
          displayName: 'Manual Model',
          contextWindow: 64000,
          supportsToolCalls: true,
          supportsStreaming: true,
          supportsReasoning: false,
        },
      ],
    });

    const manual = result.models.find((m) => m.id === 'manual/model');
    expect(manual).toBeDefined();
    expect(manual!.capabilitySource).toBe('manual');
    expect(manual!.contextLength).toBe(64000);
    expect(manual!.verified).toBe(false);
  });

  it('never infers capabilities from model names', async () => {
    const { adapter } = makeFakeAdapter([[{ id: 'someone/model-5m-long-pro' }]]);
    const catalog = new ModelCatalog({ cachePath });

    const result = await catalog.listModels('prov', adapter);
    const model = result.models[0]!;
    // No context_length was reported → stays unknown, regardless of the name
    expect(model.contextLength).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
  });

  it('finds models by exact id and unique suffix', async () => {
    const { adapter } = makeFakeAdapter([[{ id: 'openai/gpt-5.6-sol' }]]);
    const catalog = new ModelCatalog({ cachePath });
    await catalog.listModels('prov', adapter);

    expect(catalog.findModel('openai/gpt-5.6-sol', ['prov'])?.id).toBe('openai/gpt-5.6-sol');
    expect(catalog.findModel('gpt-5.6-sol', ['prov'])?.id).toBe('openai/gpt-5.6-sol');
    expect(catalog.findModel('nonexistent', ['prov'])).toBeUndefined();
  });

  it('returns undefined for ambiguous suffix matches (caller opens a picker)', async () => {
    const { adapter } = makeFakeAdapter([
      [{ id: 'vendor-a/shared-name' }, { id: 'vendor-b/shared-name' }],
    ]);
    const catalog = new ModelCatalog({ cachePath });
    await catalog.listModels('prov', adapter);

    expect(catalog.findModel('shared-name', ['prov'])).toBeUndefined();
    expect(catalog.findModelsBySuffix('shared-name', ['prov']).length).toBe(2);
  });

  it('carries provider-reported pricing with source and confidence', async () => {
    const { adapter } = makeFakeAdapter([
      [
        {
          id: 'z-ai/glm-5.3',
          pricing: { input: 0.44, output: 1.86, currency: 'USD' },
        },
      ],
    ]);
    const catalog = new ModelCatalog({ cachePath });
    const result = await catalog.listModels('prov', adapter);

    const pricing = result.models[0]!.pricing!;
    expect(pricing.inputPerMillion).toBe(0.44);
    expect(pricing.currency).toBe('USD');
    expect(pricing.confidence).toBe('high');
    expect(pricing.source).toContain('prov');
  });

  it('survives a corrupted cache file', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(cachePath, '{corrupted json!!!');

    const { adapter } = makeFakeAdapter([[{ id: 'm1' }]]);
    const catalog = new ModelCatalog({ cachePath });
    const result = await catalog.listModels('prov', adapter);
    expect(result.models.length).toBe(1);
  });

  it('clears provider cache', async () => {
    const { adapter } = makeFakeAdapter([[{ id: 'm1' }], [{ id: 'm2' }]]);
    const catalog = new ModelCatalog({ cachePath });

    await catalog.listModels('prov', adapter);
    catalog.clearProviderCache('prov');
    const result = await catalog.listModels('prov', adapter);

    expect(result.models[0]!.id).toBe('m2');
  });
});
