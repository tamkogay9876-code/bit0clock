import { describe, expect, it } from 'bun:test';
import {
  buildProviderConfig,
  connectProvider,
  credentialRefFor,
  defaultBaseUrl,
  defaultProviderId,
  disconnectProvider,
} from './connect.js';
import { createTestApp } from './test-utils.js';
import { mockFetch, jsonResponse, errorResponse } from '../providers/test-utils.js';
import { XKIRO_DEFAULT_BASE_URL } from '../providers/xkiro.js';

describe('connect helpers', () => {
  it('derives credential refs from provider ids', () => {
    expect(credentialRefFor('xkiro')).toBe('XKIRO_API_KEY');
    expect(credentialRefFor('my-provider.v2')).toBe('MY_PROVIDER_V2_API_KEY');
  });

  it('exposes per-type defaults', () => {
    expect(defaultProviderId('xkiro')).toBe('xkiro');
    expect(defaultProviderId('openai-compatible')).toBe('openai');
    expect(defaultBaseUrl('xkiro')).toBe(XKIRO_DEFAULT_BASE_URL);
  });

  it('builds an xKiro config with documented defaults', () => {
    const { config } = buildProviderConfig({ providerType: 'xkiro', apiKey: 'k-123' });
    expect(config.id).toBe('xkiro');
    expect(config.baseUrl).toBe(XKIRO_DEFAULT_BASE_URL);
    expect(config.credentialRef).toBe('XKIRO_API_KEY');
    expect(config.protocol).toBe('anthropic-messages');
    expect(config.enabled).toBe(true);
  });

  it('uses the environment variable name as the credential ref', () => {
    const { config } = buildProviderConfig({
      providerType: 'xkiro',
      apiKeyEnv: 'XKIRO_MAIN_KEY',
    });
    expect(config.credentialRef).toBe('XKIRO_MAIN_KEY');
  });

  it('warns when no key is provided', () => {
    const { config, warnings } = buildProviderConfig({ providerType: 'xkiro' });
    expect(config.credentialRef).toBeUndefined();
    expect(warnings.join(' ')).toContain('No API key');
  });

  it('requires a base URL for openai-compatible providers', () => {
    expect(() => buildProviderConfig({ providerType: 'openai-compatible' })).toThrow(/base URL/);
  });
});

describe('connectProvider', () => {
  it('validates xKiro credentials via /v1/usage, then saves and discovers models', async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ spend: {} }), // GET /v1/usage
      jsonResponse({
        data: [{ id: 'vendor/model-a', context_length: 128000 }],
      }), // GET /v1/models
    ]);

    const { app, credentials, catalog } = createTestApp({ fetchImpl });

    const result = await connectProvider(app, {
      providerType: 'xkiro',
      protocol: 'openai-chat',
      apiKey: 'key-123',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(calls[0]?.url).toBe(`${XKIRO_DEFAULT_BASE_URL}/v1/usage`);

    // Config saved
    const provider = app.getProviderConfig('xkiro');
    expect(provider?.enabled).toBe(true);
    expect(provider?.protocol).toBe('openai-chat');

    // Credential stored under the convention ref
    expect(credentials.peek('XKIRO_API_KEY')).toBe('key-123');

    // Catalog populated
    expect(catalog.findModel('vendor/model-a', ['xkiro'])?.contextLength).toBe(128000);
  });

  it('does not save anything when credential validation fails', async () => {
    const { fetchImpl } = mockFetch([
      errorResponse(401, { error: { message: 'Invalid API key' } }),
    ]);

    const { app, credentials } = createTestApp({ fetchImpl });

    const result = await connectProvider(app, {
      providerType: 'xkiro',
      protocol: 'openai-chat',
      apiKey: 'bad-key',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid API key');
    expect(app.getProviderConfig('xkiro')).toBeUndefined();
    expect(credentials.peek('XKIRO_API_KEY')).toBeUndefined();
  });

  it('connects an openai-compatible provider and validates through /v1/models', async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ data: [] }), // validation GET /v1/models
      jsonResponse({ data: [{ id: 'local/model', context_length: 8000 }] }), // refresh
    ]);

    const { app } = createTestApp({ fetchImpl });

    const result = await connectProvider(app, {
      providerType: 'openai-compatible',
      id: 'local',
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'local-key',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://localhost:8080/v1/models');
    expect(app.getProviderConfig('local')?.baseUrl).toBe('http://localhost:8080/v1');
  });

  it('saves unverified when validation is skipped', async () => {
    const { fetchImpl } = mockFetch([jsonResponse({ data: [] })]); // refresh only

    const { app } = createTestApp({ fetchImpl });

    const result = await connectProvider(app, {
      providerType: 'openai-compatible',
      id: 'local',
      baseUrl: 'http://localhost:8080/v1',
      skipValidation: true,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(app.getProviderConfig('local')).toBeDefined();
  });

  it('reports discovery failure honestly while keeping the connection', async () => {
    const { fetchImpl } = mockFetch([
      jsonResponse({ data: [] }), // validation ok
      errorResponse(500, { error: { message: 'models endpoint down' } }), // refresh fails
    ]);

    const { app } = createTestApp({ fetchImpl });

    const result = await connectProvider(app, {
      providerType: 'openai-compatible',
      id: 'local',
      baseUrl: 'http://localhost:8080/v1',
      skipValidation: false,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('Model discovery failed');
  });
});

describe('disconnectProvider', () => {
  it('disables a provider but keeps config and credential', async () => {
    const { fetchImpl } = mockFetch([jsonResponse({ data: [] }), jsonResponse({ data: [] })]);
    const { app, credentials } = createTestApp({ fetchImpl });

    await connectProvider(app, {
      providerType: 'xkiro',
      protocol: 'openai-chat',
      apiKey: 'key-123',
      fetchImpl,
    });

    const result = await disconnectProvider(app, 'xkiro');
    expect(result.ok).toBe(true);
    expect(app.getProviderConfig('xkiro')?.enabled).toBe(false);
    expect(credentials.peek('XKIRO_API_KEY')).toBe('key-123');
  });

  it('forgets the provider, credential, and active model', async () => {
    const { fetchImpl } = mockFetch([
      jsonResponse({ data: [] }),
      jsonResponse({ data: [{ id: 'vendor/x' }] }),
    ]);
    const { app, credentials, catalog } = createTestApp({ fetchImpl });

    await connectProvider(app, {
      providerType: 'xkiro',
      protocol: 'openai-chat',
      apiKey: 'key-123',
      fetchImpl,
    });
    app.selectModel('xkiro', 'vendor/x');

    const result = await disconnectProvider(app, 'xkiro', { forget: true });
    expect(result.ok).toBe(true);
    expect(app.getProviderConfig('xkiro')).toBeUndefined();
    expect(credentials.peek('XKIRO_API_KEY')).toBeUndefined();
    expect(app.activeModel()).toBeNull();
    expect(catalog.getCached('xkiro')).toBeNull();
  });

  it('fails for unknown providers', async () => {
    const { app } = createTestApp();
    const result = await disconnectProvider(app, 'ghost');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not configured');
  });
});
